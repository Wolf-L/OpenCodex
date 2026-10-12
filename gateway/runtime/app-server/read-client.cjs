const { createAppServerClient } = require("./client.cjs");

function fields(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Reflect.ownKeys(value).some(key => !allowed.includes(key))) {
    throw new TypeError(`Invalid ${name} fields`);
  }
  return value;
}

function pagination(value, defaultLimit) {
  const { cursor = null, limit = defaultLimit } = fields(value, ["cursor", "limit"], "pagination");
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 4096)) throw new TypeError("Invalid cursor");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Invalid limit");
  return { cursor, limit };
}

function controls(value) {
  const { timeoutMs = 5000, signal } = fields(value, ["timeoutMs", "signal"], "request options");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new TypeError("Invalid timeoutMs");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Invalid AbortSignal");
  return { timeoutMs, ...(signal === undefined ? {} : { signal }) };
}

function createAppServerReadClient(transport) {
  const scope = createAppServerClient(transport);
  // 业务方只获得固定读取能力；任意协议请求、写入和释放连接的权限留在装配层。
  const client = Object.freeze({
    isAttached: scope.client.isAttached,
    async listModels(params = {}, options = {}) {
      const page = pagination(params, 100), requestOptions = controls(options);
      // 显式构造协议参数，不展开调用方对象，也不把排序分类表当成授权名单。
      return scope.client.request("model/list", { ...page, includeHidden: false }, requestOptions);
    },
    async listRecentThreads(params = {}, options = {}) {
      const page = pagination(params, 12), requestOptions = controls(options);
      return scope.client.request("thread/list", {
        archived: false, ...page, modelProviders: null, sortKey: "updated_at", useStateDbOnly: true,
      }, requestOptions);
    },
  });
  // 保留上游单页响应与错误分类；不缓存、不自动翻页、不重试已经写出的请求。
  return { client, dispose: scope.dispose };
}

module.exports = { createAppServerReadClient };
