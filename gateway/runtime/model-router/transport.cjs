const { AppServerTransportError, DECORATED_CHILD, createAppServerTransport: createTransport } = require("../app-server/transport.cjs");
const { ROUTER_REQUEST_PREFIX } = require("./constants.cjs");
const { createInternalSessions, threadIdFromMessage, turnIdFromMessage } = require("./internal-sessions.cjs");

function createAppServerTransport(options = {}) {
  // 通用连接独立管理协议与资源；此入口只装配路由私有会话策略，保持原调用点不变。
  const emptySessions = createInternalSessions({ isActive: () => false });
  const transport = createTransport({
    ...options,
    requestIdPrefix: ROUTER_REQUEST_PREFIX,
    createConnectionPolicy: createInternalSessions,
  });
  const result = { ...transport };
  for (const name of ["isInternalThreadId", "internalThreadIds", "internalTurnIds", "registerInternalThread", "unregisterInternalThread", "unregisterInternalTurn"]) {
    result[name] = (...args) => (transport.getConnectionPolicy() || emptySessions)[name](...args);
  }
  return result;
}

module.exports = { AppServerTransportError, DECORATED_CHILD, createAppServerTransport, threadIdFromMessage, turnIdFromMessage };
