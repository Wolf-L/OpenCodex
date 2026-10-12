const { setMaxListeners } = require("node:events");
const { AppServerTransportError } = require("./transport.cjs");

function createAppServerClient(transport) {
  const controller = new AbortController();
  const observers = new Set();
  // 一个消费者可合法持有多个并发请求；每个完成路径会主动移除自己的监听。
  setMaxListeners(0, controller.signal);
  const closedError = () => new AppServerTransportError("App Server consumer is disposed", "closed");
  function optionsWithSignal(options = {}) {
    return { ...options, signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal };
  }
  const client = Object.freeze({
    isAttached: () => !controller.signal.aborted && transport.isAttached(),
    request: (method, params, options) => transport.request(method, params, optionsWithSignal(options)),
    waitForNotification: (predicate, options) => transport.waitForNotification(predicate, optionsWithSignal(options)),
    writeMessage(message) {
      if (controller.signal.aborted) return Promise.reject(closedError());
      return transport.writeMessage(message);
    },
    observeNotifications(observer) {
      if (controller.signal.aborted || typeof observer !== "function") return () => {};
      const unsubscribe = transport.observeNotifications((message) => {
        if (!controller.signal.aborted) observer(message);
      });
      const stop = () => { observers.delete(stop); unsubscribe(); };
      observers.add(stop);
      return stop;
    },
  });
  return {
    client,
    dispose(error = closedError()) {
      if (controller.signal.aborted) return;
      // 只取消本消费者，不能调用 transport.dispose/rejectPending 影响其他消费者。
      controller.abort(error);
      for (const stop of Array.from(observers)) {
        try { stop(); } catch { /* 一个订阅清理异常不能阻止其余订阅释放。 */ }
      }
    },
  };
}

module.exports = { createAppServerClient };
