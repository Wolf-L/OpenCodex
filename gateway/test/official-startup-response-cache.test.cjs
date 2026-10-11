const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createOfficialStartupResponseCache, STARTUP_RESPONSE_CACHE_KINDS } = require("../runtime/electron/official-startup-response-cache.cjs");

const endpoint = "https://chatgpt.com/backend-api/wham/accounts/check";
const descriptor = (overrides = {}) => ({ kind: "accounts", keyParts: { method: "GET", url: endpoint, principal: "synthetic-account-a" }, ...overrides });
const jsonResponse = (body = { accounts: ["synthetic"] }, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

async function fixture(t, options = {}) {
  // 每个测试使用独立临时目录及合成响应，不读取真实账号、不访问网络。
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-startup-cache-"));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const directory = path.join(temporaryRoot, "cache");
  const config = { directory, enabled: true, buildId: "synthetic-official-build", ...options };
  return { directory, temporaryRoot, config, cache: createOfficialStartupResponseCache(config) };
}

async function recordFiles(directory) {
  return (await fs.readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
}

test("Windows logical directory validation is not confused by MSIX native realpath remapping", { skip: process.platform !== "win32" }, async (t) => {
  const { cache } = await fixture(t);
  let nativeCalls = 0;
  t.mock.method(fs, "realpath", async () => { nativeCalls += 1; return "C:\\virtualized-package-cache"; });
  await cache.fetch(descriptor(), endpoint, {}, async () => jsonResponse());
  const response = await cache.fetch(descriptor(), endpoint, {}, async () => { throw Error("Expected saved response"); });
  assert.equal(response.headers.get("x-opencodex-startup-cache"), "hit");
  assert.equal(cache.status().writes, 1);
  assert.equal(nativeCalls, 0);
});

test("permanent cache survives engine recreation and marks old server data without changing the first response", async (t) => {
  const { cache, config, directory } = await fixture(t);
  let calls = 0;
  const original = jsonResponse({ accounts: ["synthetic"], established: true }, {
    "cache-control": "no-store",
    etag: '"synthetic-etag"',
    "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
    "content-encoding": "gzip",
    "content-length": "900",
    "set-cookie": "session=synthetic-response-secret",
    authorization: "Bearer synthetic-response-secret",
    "x-oai-is-update": "synthetic-integrity-secret",
  });
  const initial = await cache.fetch(descriptor(), endpoint, {}, async () => { calls += 1; return original; });
  assert.equal(initial, original);
  assert.equal(initial.headers.get("x-opencodex-startup-cache"), null);
  assert.deepEqual(await initial.json(), { accounts: ["synthetic"], established: true });
  const recreated = createOfficialStartupResponseCache(config);
  const cached = await recreated.fetch(descriptor(), endpoint, {}, async () => { calls += 1; throw new Error("Network must not be used"); });
  assert.equal(calls, 1);
  assert.equal(cached.headers.get("x-opencodex-startup-cache"), "hit");
  assert.match(cached.headers.get("x-opencodex-startup-cache-saved-at"), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(cached.headers.get("cache-control"), "no-store");
  assert.equal(cached.headers.get("etag"), '"synthetic-etag"');
  for (const name of ["content-encoding", "content-length", "set-cookie", "authorization", "x-oai-is-update"]) assert.equal(cached.headers.get(name), null);
  assert.deepEqual(await cached.json(), { accounts: ["synthetic"], established: true });
  assert.equal(recreated.status().entryCount, 1);
  assert.equal(recreated.status().hits, 1);
  const disk = await fs.readFile(path.join(directory, (await recordFiles(directory))[0]), "utf8");
  assert.doesNotMatch(disk, /synthetic-response-secret|synthetic-integrity-secret|set-cookie|authorization|content-encoding|content-length|x-oai-is-update/);
});

test("build, principal, method, URL and family keys segregate real responses without deleting old builds", async (t) => {
  const { config, directory, cache } = await fixture(t);
  let calls = 0;
  const upstream = async () => jsonResponse({ ordinal: ++calls });
  const variants = [
    descriptor(),
    descriptor({ keyParts: { ...descriptor().keyParts, principal: "synthetic-account-b" } }),
    descriptor({ keyParts: { ...descriptor().keyParts, method: "POST" } }),
    descriptor({ keyParts: { ...descriptor().keyParts, url: `${endpoint}?version=2` } }),
    descriptor({ kind: "workspace-settings" }),
  ];
  for (const item of variants) await cache.fetch(item, endpoint, {}, upstream);
  const newBuild = createOfficialStartupResponseCache({ ...config, buildId: "synthetic-next-build" });
  await newBuild.fetch(descriptor(), endpoint, {}, upstream);
  assert.equal(calls, 6);
  assert.equal((await recordFiles(directory)).length, 6);
  for (const item of variants) await cache.fetch(item, endpoint, {}, upstream);
  assert.equal(calls, 6);
});

test("canonical object order is stable but array order remains meaningful", async (t) => {
  const { cache } = await fixture(t);
  let calls = 0;
  const upstream = async () => jsonResponse({ ordinal: ++calls });
  await cache.fetch(descriptor({ keyParts: { b: { z: 2, a: 1 }, a: [1, 2] } }), endpoint, {}, upstream);
  await cache.fetch(descriptor({ keyParts: { a: [1, 2], b: { a: 1, z: 2 } } }), endpoint, {}, upstream);
  assert.equal(calls, 1);
  await cache.fetch(descriptor({ keyParts: { a: [2, 1], b: { a: 1, z: 2 } } }), endpoint, {}, upstream);
  assert.equal(calls, 2);
});

test("disabled, null and unknown-family descriptors transparently preserve transport arguments and create no directory", async (t) => {
  const { directory, config } = await fixture(t);
  const input = new Request(endpoint);
  const init = { headers: { authorization: "Bearer synthetic-request-secret" } };
  const expected = jsonResponse();
  let calls = 0;
  const upstream = async (actualInput, actualInit) => {
    calls += 1;
    assert.equal(actualInput, input);
    assert.equal(actualInit, init);
    return expected;
  };
  const disabled = createOfficialStartupResponseCache({ ...config, enabled: false });
  assert.equal(await disabled.fetch(descriptor(), input, init, upstream), expected);
  const enabled = createOfficialStartupResponseCache(config);
  assert.equal(await enabled.fetch(null, input, init, upstream), expected);
  assert.equal(await enabled.fetch(descriptor({ kind: "synthetic-private-identifier" }), input, init, upstream), expected);
  assert.equal(calls, 3);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  assert.doesNotMatch(JSON.stringify(enabled.status()), /synthetic-private-identifier|synthetic-request-secret/);
  assert.deepEqual(Object.keys(enabled.status().families), STARTUP_RESPONSE_CACHE_KINDS);
});

test("failed, redirected, non-JSON, empty, invalid and oversize responses never prime the cache", async (t) => {
  const { cache, directory } = await fixture(t, { maxBodyBytes: 48 });
  const factories = [
    () => new Response('{"error":true}', { status: 401, headers: { "content-type": "application/json" } }),
    () => new Response('{"error":true}', { status: 500, headers: { "content-type": "application/json" } }),
    () => new Response(null, { status: 204 }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => new Response("", { headers: { "content-type": "application/json" } }),
    () => new Response("invalid-json", { headers: { "content-type": "application/json" } }),
    () => jsonResponse({ data: "x".repeat(80) }),
    () => {
      const response = jsonResponse();
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    },
  ];
  let calls = 0;
  for (const factory of factories) {
    const item = descriptor({ keyParts: { test: calls } });
    for (let index = 0; index < 2; index += 1) {
      const response = factory();
      const actual = await cache.fetch(item, endpoint, {}, async () => { calls += 1; return response; });
      assert.equal(actual, response);
      await actual.text();
    }
  }
  assert.equal(calls, factories.length * 2);
  assert.equal(cache.status().writes, 0);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("obvious nested token and cookie property names are rejected case-insensitively", async (t) => {
  const { cache, directory } = await fixture(t);
  for (const key of ["access_token", "REFRESH_TOKEN", "id_token", "accessToken", "Authorization", "Proxy-Authorization", "Cookie", "Set-Cookie"]) {
    const response = jsonResponse({ nested: [{ [key]: "synthetic-only-secret" }] });
    assert.equal(await cache.fetch(descriptor(), endpoint, {}, async () => response), response);
  }
  assert.equal(cache.status().writes, 0);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("request identities, headers, raw bodies and keys are hashed rather than persisted or reported", async (t) => {
  const { cache, directory } = await fixture(t);
  const privateDescriptor = descriptor({ keyParts: { url: `${endpoint}?private=synthetic-url-secret`, principal: "synthetic-principal-secret", body: "synthetic-key-secret" } });
  await cache.fetch(privateDescriptor, `${endpoint}?private=synthetic-url-secret`, {
    headers: { authorization: "Bearer synthetic-request-secret", cookie: "synthetic-cookie-secret" },
    body: "synthetic-body-secret",
  }, async () => jsonResponse({ success: true }));
  const names = await recordFiles(directory);
  const disk = await fs.readFile(path.join(directory, names[0]), "utf8");
  for (const value of ["synthetic-url-secret", "synthetic-principal-secret", "synthetic-key-secret", "synthetic-request-secret", "synthetic-cookie-secret", "synthetic-body-secret", "chatgpt.com"]) {
    assert.equal(disk.includes(value), false);
    assert.equal(JSON.stringify(cache.status()).includes(value), false);
  }
  const snapshot = cache.status();
  snapshot.families.accounts.hits = 999;
  assert.equal(cache.status().families.accounts.hits, 0);
});

test("validator is enforced for both writes and replay; exceptions fall back to the genuine upstream response", async (t) => {
  const { cache } = await fixture(t);
  let calls = 0;
  const upstream = async () => { calls += 1; return jsonResponse({ has_updates: false }); };
  await cache.fetch(descriptor({ validateBody: (body) => body.has_updates === true }), endpoint, {}, upstream);
  await cache.fetch(descriptor({ validateBody: () => { throw new Error("synthetic-private-error"); } }), endpoint, {}, upstream);
  assert.equal(cache.status().writes, 0);
  await cache.fetch(descriptor(), endpoint, {}, upstream);
  assert.equal(cache.status().writes, 1);
  await cache.fetch(descriptor({ validateBody: (body) => body.has_updates === true }), endpoint, {}, upstream);
  assert.equal(calls, 4);
  assert.equal(cache.status().corrupt, 1);
  assert.doesNotMatch(JSON.stringify(cache.status()), /synthetic-private-error/);
});

test("corrupt JSON, checksums and schema versions trigger a single upstream fallback and atomic repair", async (t) => {
  const { cache, directory } = await fixture(t);
  let calls = 0;
  const upstream = async () => jsonResponse({ ordinal: ++calls });
  await cache.fetch(descriptor(), endpoint, {}, upstream);
  const filename = path.join(directory, (await recordFiles(directory))[0]);
  const corruptions = [
    () => "{broken",
    (record) => JSON.stringify({ ...record, body: '{"ordinal":900}' }),
    (record) => JSON.stringify({ ...record, version: 999 }),
    (record) => JSON.stringify({ ...record, headers: { ...record.headers, "set-cookie": "synthetic-secret" } }),
  ];
  for (const corrupt of corruptions) {
    const record = JSON.parse(await fs.readFile(filename, "utf8"));
    await fs.writeFile(filename, corrupt(record));
    const before = calls;
    const response = await cache.fetch(descriptor(), endpoint, {}, upstream);
    assert.equal(calls, before + 1);
    assert.deepEqual(await response.json(), { ordinal: calls });
    assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")).length, 0);
  }
  assert.equal(cache.status().corrupt, corruptions.length);
});

test("disk failures never discard the original response or leak exception text", async (t) => {
  const { cache, directory } = await fixture(t);
  await fs.writeFile(directory, "synthetic-private-filename-conflict");
  const response = jsonResponse({ success: true });
  assert.equal(await cache.fetch(descriptor(), endpoint, {}, async () => response), response);
  assert.deepEqual(await response.json(), { success: true });
  assert.equal(cache.status().writes, 0);
  assert.ok(cache.status().errors >= 1);
  assert.doesNotMatch(JSON.stringify(cache.status()), /synthetic-private-filename-conflict|Unsafe cache|Error:/);
});

test("upstream failures are preserved and neither cached nor retried", async (t) => {
  const { cache } = await fixture(t);
  const reason = new Error("synthetic-upstream-error");
  let calls = 0;
  await assert.rejects(cache.fetch(descriptor(), endpoint, {}, async () => { calls += 1; throw reason; }), (error) => error === reason);
  assert.equal(calls, 1);
  assert.equal(cache.status().writes, 0);
  assert.doesNotMatch(JSON.stringify(cache.status()), /synthetic-upstream-error/);
});

test("already-aborted init and Request signals reject before both bypass and cache hits", async (t) => {
  const { cache, config } = await fixture(t);
  await cache.fetch(descriptor(), endpoint, {}, async () => jsonResponse());
  const controller = new AbortController();
  const reason = new Error("synthetic-abort");
  controller.abort(reason);
  let calls = 0;
  const upstream = async () => { calls += 1; return jsonResponse(); };
  await assert.rejects(cache.fetch(descriptor(), endpoint, { signal: controller.signal }, upstream), (error) => error === reason);
  await assert.rejects(cache.fetch(descriptor(), new Request(endpoint, { signal: controller.signal }), undefined, upstream), (error) => error === reason);
  const disabled = createOfficialStartupResponseCache({ ...config, enabled: false });
  await assert.rejects(disabled.fetch(null, endpoint, { signal: controller.signal }, upstream), (error) => error === reason);
  assert.equal(calls, 0);
  assert.equal(cache.status().hits, 0);
});

test("aborting during cache validation prevents replay and does not call upstream", async (t) => {
  const { cache } = await fixture(t);
  await cache.fetch(descriptor(), endpoint, {}, async () => jsonResponse());
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(cache.fetch(descriptor({ validateBody: () => { controller.abort(); return true; } }), endpoint, { signal: controller.signal }, async () => { calls += 1; return jsonResponse(); }), { name: "AbortError" });
  assert.equal(calls, 0);
  assert.equal(cache.status().hits, 0);
});

test("a canceled response capture cannot cancel a concurrent request or prime its own key", async (t) => {
  const { cache } = await fixture(t);
  const firstController = new AbortController();
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const firstBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"pending":'));
      releaseFirst = () => { controller.enqueue(new TextEncoder().encode("true}")); controller.close(); };
    },
  });
  const first = cache.fetch(descriptor({ keyParts: { request: "first" } }), endpoint, { signal: firstController.signal }, async () => {
    firstStarted();
    return new Response(firstBody, { headers: { "content-type": "application/json" } });
  });
  await started;
  const rejected = assert.rejects(first, { name: "AbortError" });
  firstController.abort();
  const second = await cache.fetch(descriptor({ keyParts: { request: "second" } }), endpoint, {}, async () => jsonResponse({ independent: true }));
  assert.deepEqual(await second.json(), { independent: true });
  await rejected;
  releaseFirst();
  let firstCalls = 0;
  await cache.fetch(descriptor({ keyParts: { request: "first" } }), endpoint, {}, async () => { firstCalls += 1; return jsonResponse(); });
  assert.equal(firstCalls, 1);
  assert.equal(cache.status().writes, 2);
});

test("same-key concurrent requests keep independent cancellation signals", async (t) => {
  const { cache } = await fixture(t);
  const firstController = new AbortController();
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const beginning = new Promise((resolve) => { started = resolve; });
  const first = cache.fetch(descriptor(), endpoint, { signal: firstController.signal }, async () => { started(); await gate; return jsonResponse({ canceled: true }); });
  await beginning;
  const rejected = assert.rejects(first, { name: "AbortError" });
  firstController.abort();
  const second = await cache.fetch(descriptor(), endpoint, {}, async () => jsonResponse({ independent: true }));
  release();
  await rejected;
  assert.deepEqual(await second.json(), { independent: true });
  const cached = await cache.fetch(descriptor(), endpoint, {}, async () => { throw new Error("must hit"); });
  assert.deepEqual(await cached.json(), { independent: true });
  assert.equal(cache.status().writes, 1);
});

test("symlinked directory and entries never read or overwrite external targets", async (t) => {
  const { cache, directory, temporaryRoot, config } = await fixture(t);
  const outside = path.join(temporaryRoot, "outside");
  await fs.mkdir(outside);
  try {
    await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return t.skip("Symlink creation is unavailable on this host");
    throw error;
  }
  await cache.fetch(descriptor(), endpoint, {}, async () => jsonResponse());
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(directory);
  const ordinary = createOfficialStartupResponseCache(config);
  await ordinary.fetch(descriptor(), endpoint, {}, async () => jsonResponse());
  const filename = path.join(directory, (await recordFiles(directory))[0]);
  const externalFile = path.join(outside, "untouched.json");
  const original = await fs.readFile(filename, "utf8");
  await fs.writeFile(externalFile, original);
  await fs.unlink(filename);
  try { await fs.symlink(externalFile, filename, "file"); } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return t.skip("File symlink creation is unavailable on this host");
    throw error;
  }
  let calls = 0;
  await ordinary.fetch(descriptor(), endpoint, {}, async () => { calls += 1; return jsonResponse({ replacement: true }); });
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(externalFile, "utf8"), original);
  assert.equal((await fs.lstat(filename)).isSymbolicLink(), true);
});

test("POSIX cache directories and records are private", { skip: process.platform === "win32" }, async (t) => {
  const { cache, directory } = await fixture(t);
  await cache.fetch(descriptor(), endpoint, {}, async () => jsonResponse());
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, (await recordFiles(directory))[0]))).mode & 0o777, 0o600);
});

test("malformed key data bypasses safely instead of persisting ambiguous keys", async (t) => {
  const { cache, directory } = await fixture(t);
  const cyclic = {};
  cyclic.self = cyclic;
  let calls = 0;
  for (const keyParts of [cyclic, undefined, { x: NaN }, { x: () => true }, new Date(), Array(2)]) {
    await cache.fetch(descriptor({ keyParts }), endpoint, {}, async () => { calls += 1; return jsonResponse(); });
  }
  assert.equal(calls, 6);
  assert.equal(cache.status().errors, 6);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("native context denials before lookup and immediately before replay never fall back to upstream", async (t) => {
  const { cache } = await fixture(t);
  await cache.fetch(descriptor(), endpoint, {}, async () => jsonResponse());
  for (const denyAt of [1, 2]) {
    let checks = 0;
    let calls = 0;
    const denial = new Error("synthetic-native-network-policy-denial");
    const guarded = descriptor({ validateContext() { if (++checks === denyAt) throw denial; } });
    await assert.rejects(cache.fetch(guarded, endpoint, {}, async () => { calls += 1; return jsonResponse(); }), (error) => error === denial);
    assert.equal(checks, denyAt);
    assert.equal(calls, 0);
    assert.equal(cache.status().hits, 0);
    assert.equal(cache.status().errors, 0);
    assert.doesNotMatch(JSON.stringify(cache.status()), /synthetic-native-network-policy-denial/);
  }
});

test("native context denial after network or during atomic write is rethrown and cleans only its temporary file", async (t) => {
  for (const denyAt of [3, 6, 7]) {
    const { cache, directory } = await fixture(t);
    let checks = 0;
    let calls = 0;
    const denial = new DOMException("Synthetic identity changed", "AbortError");
    const guarded = descriptor({ validateContext() { if (++checks === denyAt) throw denial; } });
    await assert.rejects(cache.fetch(guarded, endpoint, {}, async () => { calls += 1; return jsonResponse(); }), (error) => error === denial);
    assert.equal(calls, 1);
    assert.equal(cache.status().writes, 0);
    assert.equal(cache.status().errors, 0);
    assert.deepEqual(await fs.readdir(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)), []);
  }
});
