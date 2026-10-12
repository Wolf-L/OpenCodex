// 这些是当前协议中明确的只读请求；官方本身会并发发起它们，调用方不能依赖它们排在未完成的 turn/start 之后。
const INDEPENDENT_CLIENT_READ_METHODS = new Set([
  "account/rateLimits/read",
  "account/read",
  "account/usage/read",
  "account/workspaceMessages/read",
  "app/installed",
  "app/list",
  "app/read",
  "collaborationMode/list",
  "config/read",
  "configRequirements/read",
  "environment/info",
  "environment/status",
  "experimentalFeature/list",
  "externalAgentConfig/detect",
  "externalAgentConfig/import/readHistories",
  "fs/getMetadata",
  "fs/readDirectory",
  "fs/readFile",
  "getAuthStatus",
  "gitDiffToRemote",
  "hooks/list",
  "mcpServer/resource/read",
  "mcpServerStatus/list",
  "model/list",
  "modelProvider/capabilities/read",
  "permissionProfile/list",
  "plugin/installed",
  "plugin/list",
  "plugin/read",
  "plugin/share/list",
  "plugin/skill/read",
  "remoteControl/client/list",
  "remoteControl/pairing/status",
  "remoteControl/status/read",
  "skills/list",
  "windowsSandbox/readiness",
]);

// 历史任务列表是全局索引读取；允许它越过未发送的 turn/start，但不能越过删除、重命名等索引写入。
const THREAD_INDEX_READ_METHODS = new Set(["thread/list", "thread/search"]);

// 只把当前协议中明确以 threadId 隔离的请求放入任务作用域；未知新方法一律回退为全局屏障。
const THREAD_SCOPED_CLIENT_METHODS = new Set([
  "mcpServer/tool/call",
  "review/start",
  "thread/approveGuardianDeniedAction",
  "thread/archive",
  "thread/backgroundTerminals/clean",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "thread/compact/start",
  "thread/decrement_elicitation",
  "thread/delete",
  "thread/fork",
  "thread/goal/clear",
  "thread/goal/get",
  "thread/goal/set",
  "thread/increment_elicitation",
  "thread/inject_items",
  "thread/items/list",
  "thread/memoryMode/set",
  "thread/metadata/update",
  "thread/name/set",
  "thread/read",
  "thread/realtime/appendAudio",
  "thread/realtime/appendSpeech",
  "thread/realtime/appendText",
  "thread/realtime/start",
  "thread/realtime/stop",
  "thread/resume",
  "thread/rollback",
  "thread/searchOccurrences",
  "thread/settings/update",
  "thread/shellCommand",
  "thread/turns/list",
  "thread/unarchive",
  "thread/unsubscribe",
  "turn/interrupt",
  "turn/start",
  "turn/steer",
]);

const THREAD_SCOPED_READ_METHODS = new Set([
  "getConversationSummary",
  "thread/backgroundTerminals/list",
  "thread/goal/get",
  "thread/items/list",
  "thread/read",
  "thread/searchOccurrences",
  "thread/turns/list",
]);

// 部分目录请求可选携带 threadId；有任务上下文时必须跟随该任务的顺序，没有时才视为全局只读。
const OPTIONAL_THREAD_CONTEXT_READ_METHODS = new Set([
  "app/installed",
  "app/list",
  "experimentalFeature/list",
  "mcpServer/resource/read",
  "mcpServerStatus/list",
]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function clientThreadIdFromMessage(message) {
  if (message?.method === "getConversationSummary") return String(message?.params?.conversationId || "");
  return String(message?.params?.threadId || message?.params?.thread?.id || "");
}

function clientFrameDescriptor(rawLine) {
  let message;
  try {
    message = JSON.parse(rawLine);
  } catch {
    return { kind: "barrier", method: "" };
  }
  if (!message || typeof message !== "object") return { kind: "barrier", method: "" };
  if (typeof message.method !== "string") {
    // 无 method 且带 result/error 的帧是对 App Server 主动请求的回包；服务端已经知道该 ID，无需等待后续请求。
    if (message.id != null && (hasOwn(message, "result") || hasOwn(message, "error"))) {
      return { kind: "server-response", method: "" };
    }
    return { kind: "barrier", method: "" };
  }

  const method = message.method;
  const threadId = clientThreadIdFromMessage(message);
  const isThreadScoped = THREAD_SCOPED_CLIENT_METHODS.has(method) || method === "getConversationSummary";
  const hasOptionalThreadContext = OPTIONAL_THREAD_CONTEXT_READ_METHODS.has(method) && threadId;
  if (isThreadScoped || hasOptionalThreadContext) {
    if (!threadId) return { kind: "barrier", method };
    if (
      method === "thread/resume" &&
      (message.params?.history != null || String(message.params?.path || ""))
    ) {
      // history/path 模式可能忽略 threadId，不能错误地把它当成单任务请求。
      return { kind: "barrier", method };
    }
    return {
      kind: "thread",
      method,
      operation:
        method === "turn/start"
          ? "turn-start"
          : THREAD_SCOPED_READ_METHODS.has(method) || OPTIONAL_THREAD_CONTEXT_READ_METHODS.has(method)
            ? "read"
            : "write",
      threadId,
    };
  }
  if (THREAD_INDEX_READ_METHODS.has(method)) return { kind: "thread-index-read", method };
  if (INDEPENDENT_CLIENT_READ_METHODS.has(method)) return { kind: "independent-read", method };
  return { kind: "barrier", method };
}

function clientFramesConflict(earlier, candidate) {
  // 主进程对服务端请求的回包必须及时返回，不能被任何正在分类的用户请求拖住。
  if (candidate.kind === "server-response") return false;
  if (earlier.kind === "server-response") return true;
  if (earlier.kind === "barrier" || candidate.kind === "barrier") return true;
  if (earlier.kind === "thread" && candidate.kind === "thread") {
    return earlier.threadId === candidate.threadId;
  }
  if (candidate.kind === "thread-index-read" && earlier.kind === "thread") {
    // 列表可以接受尚未开始的新回合，但不能越过会改变列表内容的任务写操作。
    return earlier.operation === "write";
  }
  if (earlier.kind === "thread-index-read" && candidate.kind === "thread") {
    return candidate.operation === "write";
  }
  return false;
}

module.exports = { clientFrameDescriptor, clientFramesConflict };
