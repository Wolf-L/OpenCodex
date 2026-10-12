const { AppServerTransportError, DECORATED_CHILD, createAppServerTransport: createTransport } = require("../app-server/transport.cjs");
const { ROUTER_REQUEST_PREFIX } = require("./constants.cjs");
const { createInternalSessions, threadIdFromMessage, turnIdFromMessage } = require("./internal-sessions.cjs");

function createRouterTransportClient(transport, client = transport) {
  const emptySessions = createInternalSessions({ isActive: () => false });
  const result = { ...client };
  for (const name of ["isInternalThreadId", "internalThreadIds", "internalTurnIds", "registerInternalThread", "unregisterInternalThread", "unregisterInternalTurn"]) {
    result[name] = (...args) => (transport.getConnectionPolicy() || emptySessions)[name](...args);
  }
  return result;
}

function createAppServerTransport(options = {}) {
  // 独立调用的兼容入口仍自持有连接；生产装配复用上面的能力适配器，不再由路由创建连接。
  const transport = createTransport({
    ...options,
    requestIdPrefix: ROUTER_REQUEST_PREFIX,
    createConnectionPolicy: createInternalSessions,
  });
  return createRouterTransportClient(transport);
}

module.exports = { AppServerTransportError, DECORATED_CHILD, createAppServerTransport, createRouterTransportClient, threadIdFromMessage, turnIdFromMessage };
