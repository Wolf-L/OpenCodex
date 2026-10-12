const { AsyncLocalStorage } = require("node:async_hooks");
const { PassThrough, Writable } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");
const { clientFrameDescriptor, clientFramesConflict } = require("./request-order.cjs");

// 兼容入口直接重导出同一个标记和错误类，不能因拆模块出现两份身份。
const DECORATED_CHILD = Symbol("opencodexModelRouterDecoratedChild");
const MAX_PENDING_CLIENT_FRAMES = 64;

class AppServerTransportError extends Error {
  constructor(message, category = "transport") {
    super(message);
    this.name = "AppServerTransportError";
    this.category = category;
  }
}

function transportError(error, category) {
  if (error instanceof AppServerTransportError) return error;
  const wrapped = new AppServerTransportError(error?.message || String(error), category);
  wrapped.cause = error;
  return wrapped;
}

// 同步事务先检查所有属性，再写入；失败时按原 descriptor 撤销，保留原有连接。
function replaceStreams(child, stdin, stdout) {
  const edits = [[child, "stdin", stdin], [child, "stdout", stdout]];
  const stdio = Array.isArray(child.stdio) ? child.stdio : null;
  const stdioLength = stdio?.length;
  if (stdio) edits.push([stdio, "0", stdin], [stdio, "1", stdout]);
  edits.push([child, DECORATED_CHILD, true]);
  const applied = [];
  try {
    for (const edit of edits) {
      const [target, key] = edit;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor && !descriptor.configurable && (!descriptor.writable || !("value" in descriptor))) return false;
      if (!descriptor && !Object.isExtensible(target)) return false;
      edit.push(descriptor);
    }
    for (const [target, key, value, descriptor] of edits) {
      Object.defineProperty(target, key, descriptor && !descriptor.configurable
        ? { ...descriptor, value }
        : { configurable: true, enumerable: key !== DECORATED_CHILD, writable: true, value });
      applied.push([target, key, descriptor]);
    }
    return true;
  } catch {
    for (const [target, key, descriptor] of applied.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
    if (stdio && stdio.length !== stdioLength) stdio.length = stdioLength;
    return false;
  }
}

function createAppServerTransport({
  requestIdPrefix = "opencodex.app-server:",
  processClientMessage,
  processServerMessage,
  createConnectionPolicy,
  onAttached,
  onClosed,
} = {}) {
  if (typeof requestIdPrefix !== "string" || !requestIdPrefix) throw new TypeError("A request ID prefix is required");
  let current = null;
  let requestCounter = 0;
  let generation = 0;
  let disposed = false;
  const context = new AsyncLocalStorage();
  const pendingRequests = new Map();
  const notificationWaiters = new Set();
  const notificationObservers = new Map();
  const selectedConnection = () => context.getStore() || current;
  const closedError = () => new AppServerTransportError("App Server connection is closed", "closed");
  const isActive = (connection) => !!connection && !disposed && current === connection && !connection.retired;

  function completion(resolve, reject) {
    const pending = { timer: null, stopAbort: () => {}, settled: false };
    function finish(callback, value) {
      if (pending.settled) return;
      pending.settled = true;
      clearTimeout(pending.timer);
      pending.stopAbort();
      callback(value);
    }
    pending.resolve = (value) => finish(resolve, value);
    pending.reject = (error) => finish(reject, error);
    return pending;
  }

  function watchCancellation(pending, signal, cancel) {
    if (!signal) return;
    const abort = () => cancel(transportError(signal.reason || closedError(), "closed"));
    pending.stopAbort = () => signal.removeEventListener("abort", abort);
    try {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    } catch (error) {
      pending.stopAbort = () => {};
      cancel(transportError(error, "closed"));
    }
  }

  function rejectPending(error, connection) {
    for (const [id, pending] of pendingRequests) {
      if (connection && pending.connection !== connection) continue;
      pendingRequests.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const waiter of notificationWaiters) {
      if (connection && waiter.connection !== connection && (waiter.connection || current !== connection)) continue;
      notificationWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  function writeBuffer(connection, buffer) {
    return new Promise((resolve, reject) => {
      const stdin = connection?.realStdin;
      if (!isActive(connection) || !stdin || stdin.destroyed || stdin.writableEnded) return reject(closedError());
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        connection.writes.delete(finish);
        if (error) reject(transportError(error, "write"));
        else resolve();
      };
      connection.writes.add(finish);
      connection.beginNativeWrite();
      let nativeFinished = false;
      const complete = (error) => {
        if (nativeFinished) return;
        nativeFinished = true;
        connection.endNativeWrite();
        finish(error);
      };
      try {
        // 每次只提交一个完整帧；闭包始终持有原 stdin，而不是读取可变的 current。
        stdin.write(buffer, complete);
      } catch (error) {
        complete(error);
      }
    });
  }

  function writeMessageOn(connection, message) {
    try {
      return writeBuffer(connection, Buffer.from(`${JSON.stringify(message)}\n`, "utf-8"));
    } catch (error) {
      return Promise.reject(transportError(error, "write"));
    }
  }

  function requestOn(connection, method, params, options = {}) {
    if (!isActive(connection)) return Promise.reject(closedError());
    if (options.signal?.aborted) return Promise.reject(transportError(options.signal.reason || closedError(), "closed"));
    const id = `${requestIdPrefix}${++requestCounter}`;
    const timeoutMs = Math.max(1, Number(options.timeoutMs || 10_000));
    return new Promise((resolve, reject) => {
      const pending = Object.assign(completion(resolve, reject), { connection, method, params });
      pending.timer = setTimeout(() => {
        pendingRequests.delete(id);
        pending.reject(new AppServerTransportError(`Internal App Server request timed out: ${method}`, "timeout"));
      }, timeoutMs);
      pendingRequests.set(id, pending);
      // 消费者取消只移除自己的关联；已写出的帧不撤回，迟到响应仍由私有策略消费。
      watchCancellation(pending, options.signal, (error) => {
        pendingRequests.delete(id);
        pending.reject(error);
      });
      if (pending.settled) return;
      writeMessageOn(connection, { id, method, params }).catch((error) => {
        const pending = pendingRequests.get(id);
        if (!pending) return;
        pendingRequests.delete(id);
        pending.reject(error);
      });
    });
  }

  function waitForNotification(predicate, options = {}) {
    const connection = selectedConnection();
    if (disposed || (connection && !isActive(connection))) return Promise.reject(closedError());
    if (options.signal?.aborted) return Promise.reject(transportError(options.signal.reason || closedError(), "closed"));
    const timeoutMs = Math.max(1, Number(options.timeoutMs || 10_000));
    return new Promise((resolve, reject) => {
      const waiter = Object.assign(completion(resolve, reject), { connection, predicate });
      waiter.timer = setTimeout(() => {
        notificationWaiters.delete(waiter);
        waiter.reject(new AppServerTransportError("Internal App Server notification timed out", "timeout"));
      }, timeoutMs);
      notificationWaiters.add(waiter);
      watchCancellation(waiter, options.signal, (error) => {
        notificationWaiters.delete(waiter);
        waiter.reject(error);
      });
    });
  }

  function publishNotification(connection, message) {
    for (const [observer, owner] of Array.from(notificationObservers)) {
      if (!isActive(connection)) return;
      if (owner && owner !== connection) continue;
      try { observer(message); } catch { /* 观察器异常不阻断其他订阅者或官方流。 */ }
    }
    for (const waiter of Array.from(notificationWaiters)) {
      if (!isActive(connection)) return;
      if (waiter.connection && waiter.connection !== connection) continue;
      try {
        if (typeof waiter.predicate !== "function" || !waiter.predicate(message)) continue;
        notificationWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } catch (error) {
        notificationWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
  }

  function consumeOwnedResponse(connection, message) {
    const id = typeof message?.id === "string" ? message.id : "";
    if (!id.startsWith(requestIdPrefix)) return false;
    const pending = pendingRequests.get(id);
    if (!pending || pending.connection !== connection) {
      connection.policy.onLateResponse?.(message);
      return true;
    }
    pendingRequests.delete(id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new AppServerTransportError(String(message.error.message || `Internal App Server request failed: ${pending.method}`), "response");
      error.response = message.error;
      pending.reject(error);
    } else {
      try {
        connection.policy.onResponse?.(message, { method: pending.method, params: pending.params });
        if (isActive(connection)) pending.resolve(message.result);
        else pending.reject(closedError());
      } catch (error) {
        pending.reject(transportError(error, "response"));
        throw error;
      }
    }
    return true;
  }

  async function prepareClientLine(rawLine) {
    try {
      const message = JSON.parse(rawLine);
      const next = typeof processClientMessage === "function" ? await processClientMessage(message) : message;
      return next == null ? null : Buffer.from(`${JSON.stringify(next)}\n`, "utf-8");
    } catch {
      // 公共帧无法解析或公共 middleware 异常时，保留原行内容及既有换行规范。
      return Buffer.from(`${rawLine}\n`, "utf-8");
    }
  }

  function buildConnection(child, realStdin, realStdout) {
    const connection = { child, realStdin, realStdout, generation: generation + 1, retired: false, writes: new Set(), policy: {} };
    const listeners = [];
    const clientDecoder = new StringDecoder("utf-8");
    const serverDecoder = new StringDecoder("utf-8");
    let clientBuffer = "";
    let serverBuffer = "";
    let nextFrame = 0;
    let flushing = false;
    let clientFailure = null;
    const frames = new Map();
    const capacityCallbacks = [];
    const idleWaiters = [];
    let publicQueue = [];
    let waitingForDrain = false;
    let sourceEnded = false;
    let physicalClosed = false;
    let nativeWrites = 0;
    let guardingNativeWrite = false;
    const ignoreLateWriteError = () => {};
    function releaseNativeGuard() {
      if (!guardingNativeWrite) return;
      guardingNativeWrite = false;
      realStdin.removeListener("error", ignoreLateWriteError);
      realStdin.removeListener("close", releaseNativeGuard);
    }
    connection.beginNativeWrite = () => { nativeWrites += 1; };
    connection.endNativeWrite = () => {
      nativeWrites -= 1;
      // Node 可能在 write callback 之后才 emit error；保留到该事件轮次结束再释放。
      if (connection.retired && nativeWrites === 0) setImmediate(releaseNativeGuard);
    };

    function listen(target, event, callback, lifetime = "source") {
      target.on(event, callback);
      listeners.push({ target, event, callback, lifetime });
    }

    function removeListeners(keepClose) {
      for (let index = listeners.length - 1; index >= 0; index -= 1) {
        const item = listeners[index];
        if (keepClose && item.lifetime === "physical-close") continue;
        item.target.removeListener(item.event, item.callback);
        listeners.splice(index, 1);
      }
    }

    function settleClientWaiters() {
      if (clientFailure || frames.size < MAX_PENDING_CLIENT_FRAMES) {
        for (const callback of capacityCallbacks.splice(0)) callback(clientFailure);
      }
      if (clientFailure || frames.size === 0) {
        for (const waiter of idleWaiters.splice(0)) {
          if (clientFailure) waiter.reject(clientFailure);
          else waiter.resolve();
        }
      }
    }

    function findDispatchable() {
      for (const candidate of frames.values()) {
        if (candidate.state !== "ready") continue;
        let blocked = false;
        for (const earlier of frames.values()) {
          if (earlier.index === candidate.index) break;
          if (clientFramesConflict(earlier.descriptor, candidate.descriptor)) { blocked = true; break; }
        }
        if (!blocked) return candidate;
      }
      return null;
    }

    async function flushClientFrames() {
      if (flushing || !isActive(connection)) return;
      flushing = true;
      try {
        let record;
        while (isActive(connection) && (record = findDispatchable())) {
          if (record.frame) await writeBuffer(connection, record.frame);
          if (!isActive(connection)) break;
          frames.delete(record.index);
          settleClientWaiters();
        }
      } catch (error) {
        retire(error, { keepClose: true });
      } finally {
        flushing = false;
        if (isActive(connection) && findDispatchable()) void flushClientFrames();
      }
    }

    function enqueueClientLine(rawLine) {
      if (!isActive(connection)) return;
      const record = { descriptor: clientFrameDescriptor(rawLine), index: nextFrame++, state: "pending", frame: null };
      frames.set(record.index, record);
      // AsyncLocalStorage 也绑定 middleware 中的后续内部 request，防止 await 后借用新进程。
      void context.run(connection, () => prepareClientLine(rawLine)).then((frame) => {
        if (!isActive(connection)) return;
        record.frame = frame;
        record.state = "ready";
        void flushClientFrames();
      });
    }

    function enqueueClientText(text) {
      clientBuffer += text;
      const lines = clientBuffer.split("\n");
      clientBuffer = lines.pop() || "";
      for (const line of lines) {
        const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (normalized) enqueueClientLine(normalized);
      }
    }

    const clientStdin = new Writable({
      write(chunk, encoding, callback) {
        if (!isActive(connection)) return callback(clientFailure || closedError());
        enqueueClientText(clientDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)));
        // 保持原来的 64 帧压力阈值；这是帧队列阈值，不是总字节内存上限。
        if (frames.size >= MAX_PENDING_CLIENT_FRAMES) capacityCallbacks.push(callback);
        else callback();
      },
      final(callback) {
        if (!isActive(connection)) return callback(clientFailure || closedError());
        enqueueClientText(clientDecoder.end());
        if (clientBuffer) enqueueClientLine(clientBuffer);
        clientBuffer = "";
        const idle = frames.size === 0 ? Promise.resolve() : new Promise((resolve, reject) => idleWaiters.push({ resolve, reject }));
        idle.then(() => {
          if (!isActive(connection)) return callback(clientFailure || closedError());
          try { realStdin.end(callback); } catch (error) { callback(transportError(error, "write")); }
        }, callback);
      },
    });
    const publicStdout = new PassThrough();
    // 无外部消费者时也安全销毁代理；close 后去掉本层的兜底监听，不触碰调用方监听。
    for (const stream of [clientStdin, publicStdout]) {
      const ignoreError = () => {};
      stream.on("error", ignoreError);
      stream.once("close", () => stream.removeListener("error", ignoreError));
    }

    function finishOutput() {
      if (sourceEnded && publicQueue.length === 0 && !waitingForDrain && !publicStdout.writableEnded) publicStdout.end();
    }

    function onDrain() {
      waitingForDrain = false;
      // EOF 只排空已有公开帧；退役连接不能重新启动真实输出源。
      if (!connection.retired) realStdout.resume();
      flushPublicQueue();
    }

    function flushPublicQueue() {
      if (waitingForDrain || publicStdout.destroyed) return;
      while (publicQueue.length > 0) {
        if (!publicStdout.write(publicQueue.shift())) {
          waitingForDrain = true;
          realStdout.pause();
          publicStdout.once("drain", onDrain);
          return;
        }
      }
      finishOutput();
    }

    function routeServerLine(rawLine) {
      if (!isActive(connection)) return;
      let message;
      try { message = JSON.parse(rawLine); } catch {
        publicQueue.push(Buffer.from(`${rawLine}\n`, "utf-8"));
        return;
      }
      try {
        if (consumeOwnedResponse(connection, message)) return;
        if (message?.method) publishNotification(connection, message);
        if (!isActive(connection)) return;
        if (connection.policy.filterMessage?.(message) === false) return;
      } catch (error) {
        // 私有/本地策略异常不能回退为公开帧；关闭本代际，明确使未决请求失败。
        retire(transportError(error, "response"), { keepClose: true });
        return;
      }
      if (!isActive(connection)) return;
      try {
        const next = typeof processServerMessage === "function" ? processServerMessage(message) : message;
        if (next != null) publicQueue.push(Buffer.from(`${JSON.stringify(next)}\n`, "utf-8"));
      } catch {
        publicQueue.push(Buffer.from(`${rawLine}\n`, "utf-8"));
      }
    }

    function retire(error, { preserveOutput = false, keepClose = false } = {}) {
      if (!connection.retired) {
        connection.retired = true;
        if (nativeWrites > 0) {
          // 不接管/销毁官方 stdin。已被系统接受的写入只保留无副作用错误兜底，
          // 原生 callback 或流 close 后释放；业务等待者立即失败，绝不重放。
          guardingNativeWrite = true;
          realStdin.on("error", ignoreLateWriteError);
          realStdin.once("close", releaseNativeGuard);
        }
        clientFailure = error;
        rejectPending(error, connection);
        for (const [observer, owner] of notificationObservers) {
          if (owner === connection) notificationObservers.delete(observer);
        }
        for (const finish of Array.from(connection.writes)) finish(error);
        frames.clear();
        clientBuffer = "";
        serverBuffer = "";
        settleClientWaiters();
        try { connection.policy.dispose?.(); } catch { /* 退役继续释放资源，不重新开放帧。 */ }
        clientStdin.destroy();
      }
      removeListeners(keepClose);
      if (!preserveOutput) {
        publicQueue = [];
        publicStdout.removeListener("drain", onDrain);
        waitingForDrain = false;
        publicStdout.destroy();
      }
    }

    connection.clientStdin = clientStdin;
    connection.publicStdout = publicStdout;
    connection.retire = retire;
    connection.install = () => {
      listen(realStdout, "data", (chunk) => context.run(connection, () => {
        if (!isActive(connection)) return;
        serverBuffer += serverDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const lines = serverBuffer.split("\n");
        serverBuffer = lines.pop() || "";
        for (const line of lines) {
          const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (normalized) routeServerLine(normalized);
        }
        flushPublicQueue();
      }));
      listen(realStdout, "end", () => context.run(connection, () => {
        if (!isActive(connection)) return;
        serverBuffer += serverDecoder.end();
        if (serverBuffer) routeServerLine(serverBuffer);
        serverBuffer = "";
        sourceEnded = true;
        // EOF 已不可能完成新请求，但已经接受的输出仍须经过 drain 完整交付。
        retire(closedError(), { preserveOutput: true, keepClose: true });
        flushPublicQueue();
      }));
      listen(realStdout, "error", (error) => retire(transportError(error, "closed"), { keepClose: true }), "physical-close");
      listen(realStdin, "error", (error) => retire(transportError(error, "write"), { keepClose: true }), "physical-close");
      listen(child, "error", (error) => retire(transportError(error, "closed"), { keepClose: true }), "physical-close");
      listen(child, "close", () => {
        if (current !== connection || physicalClosed) return;
        physicalClosed = true;
        retire(closedError(), { preserveOutput: sourceEnded });
        current = null;
        if (typeof onClosed === "function") onClosed();
      }, "physical-close");
    };
    connection.policy = createConnectionPolicy?.({
      generation: connection.generation,
      isActive: () => isActive(connection),
      request: (method, params, options) => requestOn(connection, method, params, options),
      writeMessage: (message) => writeMessageOn(connection, message),
    }) || {};
    return connection;
  }

  function decorateChild(child) {
    if (disposed || !child || child[DECORATED_CHILD]) return child;
    const stdin = child.stdin;
    const stdout = child.stdout;
    if (!stdin || !stdout || stdin.destroyed || stdin.writableEnded || stdout.destroyed || stdout.readableEnded) return child;
    if (typeof stdin.write !== "function" || typeof stdin.end !== "function" || typeof stdout.pause !== "function" || typeof stdout.resume !== "function") return child;
    if ([child, stdin, stdout].some((target) => typeof target.on !== "function" || typeof target.removeListener !== "function")) return child;
    const connection = buildConnection(child, stdin, stdout);
    if (!replaceStreams(child, connection.clientStdin, connection.publicStdout)) {
      connection.retire(closedError());
      return child;
    }
    if (current) current.retire(new AppServerTransportError("App Server process was replaced", "closed"));
    generation = connection.generation;
    current = connection;
    connection.install();
    if (typeof onAttached === "function") context.run(connection, () => onAttached(child));
    return child;
  }

  return {
    decorateChild,
    isAttached() {
      return isActive(current) && !current.realStdin.destroyed && !current.realStdin.writableEnded;
    },
    // 仅供兼容策略选择上下文；旧 async 链得到旧策略，不能意外登记到新代际。
    getConnectionPolicy: () => selectedConnection()?.policy,
    request: (method, params, options) => requestOn(selectedConnection(), method, params, options),
    writeMessage: (message) => writeMessageOn(selectedConnection(), message),
    waitForNotification,
    observeNotifications(observer) {
      if (disposed || typeof observer !== "function") return () => {};
      const owner = context.getStore();
      if (owner && !isActive(owner)) return () => {};
      notificationObservers.set(observer, owner);
      return () => notificationObservers.delete(observer);
    },
    rejectPending: (error) => rejectPending(error),
    dispose(error = closedError()) {
      if (disposed) return;
      disposed = true;
      if (current) current.retire(error);
      current = null;
      rejectPending(error);
      notificationObservers.clear();
      context.disable();
    },
  };
}

module.exports = { AppServerTransportError, DECORATED_CHILD, createAppServerTransport };
