const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const STARTUP_RESPONSE_CACHE_KINDS = Object.freeze([
  "accounts",
  "workspace-settings",
  "workspace-policy",
  "workspace-policy-acknowledge",
  "statsig-bootstrap",
  "statsig-initialize",
]);
const KIND_SET = new Set(STARTUP_RESPONSE_CACHE_KINDS);
const SAFE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"];
const SECRET_PROPERTY = /^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|authorization|proxy-authorization|cookie|set-cookie)$/i;
const ENTRY_NAME = /^[a-f0-9]{64}\.json$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// 键只接受 JSON 数据；排序对象字段，避免请求对象的字段顺序造成无意义的缓存失配。
function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("Invalid cache key");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid cache key");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // 稀疏数组不是完整 JSON 数据，不能与空数组或省略字段共享哈希键。
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError("Invalid cache key");
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function containsSecretProperty(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    for (const key of Object.keys(item)) {
      if (SECRET_PROPERTY.test(key)) return true;
      if (item[key] && typeof item[key] === "object") pending.push(item[key]);
    }
  }
  return false;
}

function isJsonContentType(value) {
  return typeof value === "string" && /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json\s*(?:;|$)/i.test(value);
}

function checkAbort(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  throw signal.reason === undefined ? new DOMException("The operation was aborted", "AbortError") : signal.reason;
}

function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      try { checkAbort(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function blankCounters() {
  return { hits: 0, misses: 0, writes: 0, corrupt: 0, errors: 0, skipped: 0, lastHitAt: null, lastWriteAt: null };
}

function createOfficialStartupResponseCache({ directory, buildId, enabled = false, maxBodyBytes = 16 * 1024 * 1024 } = {}) {
  const active = enabled === true && typeof directory === "string" && directory.length > 0 && typeof buildId === "string" && buildId.length > 0;
  const root = typeof directory === "string" && directory.length ? path.resolve(directory) : null;
  const bodyLimit = Number.isSafeInteger(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : 16 * 1024 * 1024;
  const recordLimit = bodyLimit * 6 + 65536;
  const counters = blankCounters();
  const families = Object.fromEntries(STARTUP_RESPONSE_CACHE_KINDS.map((kind) => [kind, blankCounters()]));
  const knownEntries = new Set();
  const familyEntries = Object.fromEntries(STARTUP_RESPONSE_CACHE_KINDS.map((kind) => [kind, new Set()]));
  let scanned = false;
  let bypasses = 0;

  function increment(kind, field) {
    counters[field] += 1;
    families[kind][field] += 1;
  }

  function timestamp(kind, field, value = new Date().toISOString()) {
    counters[field] = value;
    families[kind][field] = value;
  }

  // 不跟随目录链中的符号链接或 Windows junction，防止缓存路径被重定向到用户目录外。
  async function safeDirectory(create) {
    const parsed = path.parse(root);
    const segments = root.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let current = parsed.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      let stat;
      try {
        stat = await fsp.lstat(current);
      } catch (error) {
        if (error.code !== "ENOENT" || !create) throw error;
        try { await fsp.mkdir(current, { mode: 0o700 }); } catch (mkdirError) {
          if (mkdirError.code !== "EEXIST") throw mkdirError;
        }
        stat = await fsp.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe cache directory");
    }
    const realRoot = await fsp.realpath(root);
    const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    if (normalize(realRoot) !== normalize(root)) throw new Error("Unsafe cache directory");
    if (!scanned) {
      const entries = await fsp.readdir(root, { withFileTypes: true });
      for (const entry of entries) if (ENTRY_NAME.test(entry.name) && entry.isFile()) knownEntries.add(entry.name);
      scanned = true;
    }
  }

  function entryPath(key) {
    const result = path.join(root, `${key}.json`);
    if (path.dirname(result) !== root || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Unsafe cache entry");
    return result;
  }

  function validateBody(text, descriptor) {
    if (typeof text !== "string" || !text.length || Buffer.byteLength(text, "utf8") > bodyLimit) return false;
    const parsed = JSON.parse(text);
    if (containsSecretProperty(parsed)) return false;
    return typeof descriptor.validateBody !== "function" || descriptor.validateBody(parsed) === true;
  }

  function checksum(record) {
    return sha256(canonicalJson({ version: record.version, key: record.key, kind: record.kind, savedAt: record.savedAt, status: record.status, headers: record.headers, body: record.body }));
  }

  async function readEntry(key, descriptor, signal) {
    let handle;
    try {
      await safeDirectory(false);
      const filename = entryPath(key);
      const before = await fsp.lstat(filename);
      if (before.isSymbolicLink() || !before.isFile()) throw new Error("Unsafe cache entry");
      handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size <= 0 || stat.size > recordLimit) {
        increment(descriptor.kind, "corrupt");
        return null;
      }
      // 限长读取避免损坏或被替换的本地文件触发不受控的内存分配。
      const buffer = Buffer.alloc(stat.size);
      let position = 0;
      while (position < buffer.length) {
        checkAbort(signal);
        const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
        if (!bytesRead) break;
        position += bytesRead;
      }
      const after = await handle.stat();
      if (position !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        increment(descriptor.kind, "corrupt");
        return null;
      }
      checkAbort(signal);
      let record;
      try {
        record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, position)));
        if (!record || record.version !== SCHEMA_VERSION || record.key !== key || record.kind !== descriptor.kind || record.status !== 200 ||
          typeof record.savedAt !== "string" || !Number.isFinite(Date.parse(record.savedAt)) || new Date(record.savedAt).toISOString() !== record.savedAt ||
          !record.headers || Array.isArray(record.headers) || typeof record.headers !== "object" ||
          Object.keys(record.headers).some((name) => !SAFE_HEADERS.includes(name) || typeof record.headers[name] !== "string" || record.headers[name].length > 8192) ||
          !isJsonContentType(record.headers["content-type"]) || record.checksum !== checksum(record) || !validateBody(record.body, descriptor)) {
          throw new Error("Invalid cache record");
        }
      } catch {
        increment(descriptor.kind, "corrupt");
        return null;
      }
      checkAbort(signal);
      const headers = new Headers(record.headers);
      headers.set("X-OpenCodex-Startup-Cache", "hit");
      headers.set("X-OpenCodex-Startup-Cache-Saved-At", record.savedAt);
      const response = new Response(record.body, { status: record.status, headers });
      familyEntries[descriptor.kind].add(key);
      return response;
    } catch (error) {
      checkAbort(signal);
      if (error.code !== "ENOENT") increment(descriptor.kind, "errors");
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function readResponseBody(response, signal) {
    const clone = response.clone();
    if (!clone.body) return null;
    const reader = clone.body.getReader();
    const chunks = [];
    let total = 0;
    let complete = false;
    try {
      for (;;) {
        checkAbort(signal);
        const { value, done } = await awaitWithAbort(reader.read(), signal);
        if (done) { complete = true; break; }
        total += value.byteLength;
        if (total > bodyLimit) return null;
        chunks.push(Buffer.from(value));
      }
      checkAbort(signal);
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } finally {
      // tee 的 cancel promise 可能要等原始响应被消费；这里不能等待它而阻塞调用者。
      if (!complete) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function writeEntry(key, descriptor, response, body, validateContext) {
    const headers = {};
    for (const name of SAFE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null && value.length <= 8192) headers[name] = value;
    }
    if (!isJsonContentType(headers["content-type"])) return;
    const savedAt = new Date().toISOString();
    const record = { version: SCHEMA_VERSION, key, kind: descriptor.kind, savedAt, status: 200, headers, body };
    record.checksum = checksum(record);
    await safeDirectory(true);
    validateContext();
    const filename = entryPath(key);
    try {
      const existing = await fsp.lstat(filename);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Unsafe cache entry");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = path.join(root, `.${key}.${crypto.randomUUID()}.tmp`);
    let handle;
    let created = false;
    try {
      handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      created = true;
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      validateContext();
      // 同目录 rename 保证读者只能见到旧的完整记录或新的完整记录；永不缓存请求头或请求正文。
      await safeDirectory(false);
      validateContext();
      await fsp.rename(temporary, filename);
      created = false;
      knownEntries.add(`${key}.json`);
      familyEntries[descriptor.kind].add(key);
      increment(descriptor.kind, "writes");
      timestamp(descriptor.kind, "lastWriteAt", savedAt);
    } finally {
      if (handle) await handle.close().catch(() => {});
      // 只清理本次通过 O_EXCL 创建的临时文件，不删除既有缓存或其他进程的文件。
      if (created) await fsp.unlink(temporary).catch(() => {});
    }
  }

  async function cachedFetch(descriptor, input, init, upstream) {
    const signal = init?.signal ?? (input && typeof input === "object" ? input.signal : undefined);
    checkAbort(signal);
    if (!active || !descriptor || !KIND_SET.has(descriptor.kind)) {
      bypasses += 1;
      return upstream(input, init);
    }
    let contextDenied = false;
    let contextDenial;
    function validateContext() {
      checkAbort(signal);
      if (typeof descriptor.validateContext === "function") {
        try {
          const result = descriptor.validateContext();
          if (result && typeof result.then === "function") {
            void Promise.resolve(result).catch(() => {});
            throw new TypeError("Cache context validation must be synchronous");
          }
        } catch (error) {
          // 原生账号/网络策略拒绝不是磁盘故障，不能吞掉后转而发起上游请求。
          contextDenied = true;
          contextDenial = error;
          throw error;
        }
      }
      checkAbort(signal);
    }
    validateContext();
    let key;
    try {
      key = sha256(canonicalJson({ version: SCHEMA_VERSION, buildId, kind: descriptor.kind, keyParts: descriptor.keyParts }));
    } catch {
      increment(descriptor.kind, "errors");
      return upstream(input, init);
    }
    const cached = await readEntry(key, descriptor, signal);
    validateContext();
    if (cached) {
      increment(descriptor.kind, "hits");
      timestamp(descriptor.kind, "lastHitAt");
      return cached;
    }
    increment(descriptor.kind, "misses");
    // 不合并网络请求；每个调用独享上游的 AbortSignal，不会取消另一窗口的请求。
    const response = await upstream(input, init);
    validateContext();
    if (response?.status !== 200 || response.redirected || !isJsonContentType(response.headers?.get("content-type"))) {
      increment(descriptor.kind, "skipped");
      return response;
    }
    try {
      const body = await readResponseBody(response, signal);
      validateContext();
      if (body === null || !validateBody(body, descriptor)) {
        increment(descriptor.kind, "skipped");
        return response;
      }
      await writeEntry(key, descriptor, response, body, validateContext);
      validateContext();
    } catch {
      if (contextDenied) throw contextDenial;
      checkAbort(signal);
      increment(descriptor.kind, "errors");
    }
    validateContext();
    return response;
  }

  function status() {
    // 状态只包含固定家族名和汇总数；账号、URL、键内容、异常文字都不进入诊断输出。
    return {
      enabled: active,
      buildId: typeof buildId === "string" ? buildId : null,
      entryCount: knownEntries.size,
      entryCountScanned: scanned,
      bypasses,
      ...counters,
      families: Object.fromEntries(STARTUP_RESPONSE_CACHE_KINDS.map((kind) => [kind, { ...families[kind], observedEntryCount: familyEntries[kind].size }])),
    };
  }

  return { fetch: cachedFetch, status };
}

module.exports = { createOfficialStartupResponseCache, STARTUP_RESPONSE_CACHE_KINDS };
