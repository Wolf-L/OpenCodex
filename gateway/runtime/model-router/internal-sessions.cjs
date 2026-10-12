const MAX_INTERNAL_THREAD_TOMBSTONES = 512;
const INTERNAL_TURN_TERMINAL_METHODS = new Set(["turn/completed", "turn/failed", "turn/interrupted"]);
const THREAD_LIST_METHODS = new Set(["thread/list", "thread/search", "thread/loaded/list"]);

function threadIdFromMessage(message) {
  return String(message?.params?.threadId || message?.params?.thread?.id || message?.result?.thread?.id || message?.result?.threadId || "");
}

function turnIdFromMessage(message) {
  return String(message?.params?.turnId || message?.params?.turn?.id || message?.result?.turn?.id || "");
}

function createInternalSessions(connection) {
  const threads = new Set();
  const tombstones = new Map();
  const turns = new Set();
  let disposed = false;
  const active = () => !disposed && connection.isActive();

  function prune() {
    const now = Date.now();
    for (const [id, expiresAt] of tombstones) if (expiresAt <= now) tombstones.delete(id);
  }

  function registerInternalThread(threadId) {
    if (!active() || !threadId) return;
    tombstones.delete(String(threadId));
    threads.add(String(threadId));
  }

  function unregisterInternalThread(threadId) {
    const id = String(threadId || "");
    if (!active() || !id) return;
    threads.delete(id);
    // 删除确认后的尾部通知仍可能迟到；保留原有五分钟、512 条的隔离窗口。
    tombstones.set(id, Date.now() + 5 * 60 * 1_000);
    prune();
    while (tombstones.size > MAX_INTERNAL_THREAD_TOMBSTONES) tombstones.delete(tombstones.keys().next().value);
  }

  function isInternalThreadId(threadId) {
    prune();
    const id = String(threadId || "");
    return threads.has(id) || tombstones.has(id);
  }

  return {
    isInternalThreadId,
    internalThreadIds: () => new Set(threads),
    internalTurnIds: () => new Set(turns),
    registerInternalThread,
    unregisterInternalThread,
    unregisterInternalTurn(turnId) { if (active() && turnId) turns.delete(String(turnId)); },
    onResponse(message, pending) {
      if (THREAD_LIST_METHODS.has(pending.method) && Array.isArray(message.result?.data)) {
        // 在 request 完成前过滤；否则 Promise 续体运行前换进程会丢失旧代际的私有标识。
        message.result = { ...message.result, data: message.result.data.filter((thread) => !isInternalThreadId(thread?.id)) };
      }
      // 必须在 request Promise 完成前登记，保证同一 stdout chunk 的后续通知也被隐藏。
      if (pending.method === "thread/start") registerInternalThread(threadIdFromMessage(message));
      if (pending.method === "turn/start" && active()) {
        const id = turnIdFromMessage(message);
        if (id) turns.add(id);
      }
      if (pending.method === "thread/delete") unregisterInternalThread(pending.params?.threadId);
    },
    onLateResponse(message) {
      const id = threadIdFromMessage(message);
      if (!active() || !id || message?.result?.thread?.ephemeral !== true) return;
      registerInternalThread(id);
      // 连接上下文绑定原代际；迟到回收和 finally 都不能触及下一进程。
      void connection.request("thread/delete", { threadId: id }, { timeoutMs: 1_500 })
        .catch(() => {})
        .finally(() => unregisterInternalThread(id));
    },
    filterMessage(message) {
      const turnId = turnIdFromMessage(message);
      if (!isInternalThreadId(threadIdFromMessage(message)) && !(turnId && turns.has(turnId))) return true;
      if (message.id != null) {
        // 私有分类线程不允许审批或动态工具交互，拒绝响应只写回原连接。
        void connection.writeMessage({
          id: message.id,
          error: { code: -32001, message: "Internal router sessions do not allow host interactions" },
        }).catch(() => {});
      }
      if (INTERNAL_TURN_TERMINAL_METHODS.has(message.method)) turns.delete(turnId);
      return false;
    },
    dispose() {
      disposed = true;
      threads.clear();
      tombstones.clear();
      turns.clear();
    },
  };
}

module.exports = { createInternalSessions, threadIdFromMessage, turnIdFromMessage };
