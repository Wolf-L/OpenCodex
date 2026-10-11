const MAX_REQUEST_BYTES = 256 * 1024;
const ACCOUNT_ORIGINS = new Set(["https://chatgpt.com", "https://gov.chatgpt.com"]);
const SDK_QUERY = new Set(["k", "st", "sv", "t", "sid", "se", "gz"]);
const SDK_CURSORS = ["sinceTime", "previousDerivedFields", "deltasResponseRequested", "full_checksum", "partialUserMatchSinceTime"];
const SDK_RECOVERY = ["hadBadDeltaChecksum", "badChecksum", "badMergedConfigs", "badFullResponse"];
const SECRET_PROPERTY = /^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|authorization|proxy-authorization|cookie|set-cookie)$/i;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
}

function stablePrincipal(value) {
  return object(value) && nonempty(value.accountId) && nonempty(value.userId)
    ? { accountId: value.accountId, userId: value.userId } : null;
}

function containsSecret(value) {
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

function requestText(body) {
  // 只读已在内存中的 BodyInit；不消费 Request/ReadableStream，确保未命中仍原样交给官方 transport。
  if (typeof body === "string") return Buffer.byteLength(body, "utf8") <= MAX_REQUEST_BYTES ? body : null;
  if (body instanceof ArrayBuffer) return body.byteLength <= MAX_REQUEST_BYTES ? Buffer.from(body).toString("utf8") : null;
  if (ArrayBuffer.isView(body)) return body.byteLength <= MAX_REQUEST_BYTES
    ? Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8") : null;
  return null;
}

function fullEvaluation(body, hash) {
  if (!object(body) || body.has_updates !== true || (body.is_delta !== undefined && body.is_delta !== false)
    || body.response_mode !== undefined || !Number.isFinite(body.time) || body.time < 0) return false;
  if (!["feature_gates", "dynamic_configs", "layer_configs"].every((key) => object(body[key]))) return false;
  if (["deleted_gates", "deleted_configs", "deleted_layers", ...SDK_RECOVERY].some((key) => Object.hasOwn(body, key))) return false;
  return (body.hash_used === undefined || hash === undefined || body.hash_used === hash) && !containsSecret(body);
}

function bootstrapBody(body) {
  if (!object(body) || typeof body.statsigPayload !== "string") return false;
  try {
    const payload = JSON.parse(body.statsigPayload);
    return object(payload.user) && fullEvaluation(payload);
  } catch { return false; }
}

function accountBody(body) {
  return object(body) && !Object.hasOwn(body, "error") && !Object.hasOwn(body, "errors");
}

function variantHeaders(headers) {
  const result = {};
  // 语言/应用变体可以改变启动数据；认证、Cookie、追踪及完整性令牌不进入缓存键或持久化元数据。
  for (const name of ["accept-language", "oai-language", "originator", "openai-beta", "x-openai-client-version"]) {
    if (headers.has(name)) result[name] = headers.get(name);
  }
  return result;
}

function classifyStartupRequest(input, init = {}, context = {}) {
  try {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    if (typeof rawUrl !== "string" || rawUrl.length > 16384 || /[\u0000-\u0020\\]/.test(rawUrl)) return null;
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) return null;
    // URL 会自动折叠点段，先排除其原始写法，不能把旁路地址归并成白名单接口。
    if (/(?:\/|%2f|%5c)(?:\.|%2e){1,2}(?:\/|%2f|%5c|\?|$)/i.test(rawUrl)) return null;
    const method = String(init.method ?? input?.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? input?.headers);
    const principal = stablePrincipal(context.principal);
    const namespace = context.namespace === "desktop" ? "desktop" : null;
    if (!namespace) return null;
    const base = { namespace, principal, method, url: url.href, variants: variantHeaders(headers) };

    if (ACCOUNT_ORIGINS.has(url.origin)) {
      // 只有原生层确认了账户和用户两个维度，才允许复用账户/工作区响应；不从 bearer 自行推导身份。
      if (!principal) return null;
      let kind = null;
      if (method === "GET" && ["/backend-api/wham/accounts/check", "/backend-api/accounts/check/v4-2023-04-27"].includes(url.pathname)) kind = "accounts";
      if (method === "GET") {
        const match = /^\/backend-api\/accounts\/([^/]+)\/(settings|workspace_policy(?:\/acknowledge)?)$/.exec(url.pathname);
        if (match) {
          const segment = decodeURIComponent(match[1]);
          if (!segment || segment === "." || segment === ".." || /[/\\\u0000-\u0020]/.test(segment)) return null;
          kind = { settings: "workspace-settings", workspace_policy: "workspace-policy", "workspace_policy/acknowledge": "workspace-policy-acknowledge" }[match[2]];
        }
      }
      if (kind) {
        if (init.body != null || (typeof input === "object" && input?.body != null)) return null;
        return { kind, keyParts: base, validateBody: accountBody };
      }
      if (method !== "POST" || url.pathname !== "/backend-api/wham/statsig/bootstrap") return null;
      const text = requestText(init.body);
      if (text === null) return null;
      const body = JSON.parse(text);
      if (!object(body) || !nonempty(body.stable_id) || !nonempty(body.app_version) || containsSecret(body)) return null;
      // 用户选择的是固定快照：只去掉每次启动变化的会话 ID，保留设备、系统、语言及未知 targeting 字段。
      delete body.app_session_id;
      return { kind: "statsig-bootstrap", keyParts: { ...base, body }, validateBody: bootstrapBody };
    }

    if (url.origin !== "https://ab.chatgpt.com" || url.pathname !== "/v1/initialize" || method !== "POST") return null;
    if (headers.has("authorization") || headers.has("proxy-authorization") || headers.has("cookie") || headers.has("content-encoding")) return null;
    const query = {};
    for (const [key, value] of url.searchParams) {
      if (!SDK_QUERY.has(key) || Object.hasOwn(query, key)) return null;
      query[key] = value;
    }
    if (!nonempty(query.k) || !nonempty(query.st) || !nonempty(query.sv) || query.gz !== undefined) return null;
    let text = requestText(init.body);
    if (text === null) return null;
    if (query.se !== undefined) {
      if (query.se !== "1") return null;
      // 当前官方 SDK 使用反转 Base64 而非 gzip；严格校验编码，未知压缩不猜测、不改写原始请求。
      const encoded = text.split("").reverse().join("");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.toString("base64") !== encoded) return null;
      text = decoded.toString("latin1");
    }
    const body = JSON.parse(text);
    if (!object(body) || !object(body.user) || containsSecret(body) || body.responseMode !== undefined
      || SDK_RECOVERY.some((key) => Object.hasOwn(body, key))) return null;
    if (!nonempty(body.user.userID) && !nonempty(body.user.customIDs?.stableID)) return null;
    if (body.hash !== undefined && !nonempty(body.hash)) return null;
    const hash = body.hash ?? "djb2";
    if (body.statsigMetadata !== undefined && !object(body.statsigMetadata)) return null;
    if (object(body.user.custom)) delete body.user.custom.codex_app_session_id;
    if (object(body.statsigMetadata)) delete body.statsigMetadata.sessionID;
    // 仅保存完整 evaluations 后，旧完整响应可满足 SDK 的后续增量请求；绝不保存/拼接原始 delta。
    for (const key of SDK_CURSORS) delete body[key];
    return {
      kind: "statsig-initialize",
      keyParts: { ...base, url: `${url.origin}${url.pathname}`, sdk: { k: query.k, st: query.st, sv: query.sv }, body },
      validateBody: (payload) => fullEvaluation(payload, hash),
    };
  } catch {
    // 未知请求形态只退出缓存，不改变官方调用、认证或原始错误处理。
    return null;
  }
}

module.exports = { classifyStartupRequest, __test: { fullEvaluation, bootstrapBody, stablePrincipal } };
