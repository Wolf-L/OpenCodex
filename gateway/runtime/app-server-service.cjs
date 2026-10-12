const { createAppServerTransport } = require("./app-server/transport.cjs");
const { createAppServerClient } = require("./app-server/client.cjs");
const { createInternalSessions } = require("./model-router/internal-sessions.cjs");
const { createRouterTransportClient } = require("./model-router/transport.cjs");
const { ROUTER_REQUEST_PREFIX } = require("./model-router/constants.cjs");
const { createGatewayPluginService } = require("./plugins/service.cjs");
const { createHistoryPreviewService } = require("./history-preview.cjs");
const { diagnosticWarn } = require("./core/diagnostics.cjs");

function createGatewayAppServerService(options = {}, factories = {}) {
  const createTransport = factories.createTransport || createAppServerTransport;
  const createPlugins = factories.createPlugins || createGatewayPluginService;
  const createPreview = factories.createPreview || createHistoryPreviewService;
  let transport;
  let routerScope;
  let previewScope;
  let pluginService;
  let historyPreview;
  let disposed = false;

  function dispose(error = new Error("Gateway App Server services disposed")) {
    if (disposed) return;
    disposed = true;
    const cleanup = (component, action) => {
      try { action(); } catch {
        // 清理失败不能阻止剩余资源退役；只记录组件名，不记录协议或用户内容。
        try { diagnosticWarn("gateway", "app_server_cleanup_failed", { component }); } catch {}
      }
    };
    cleanup("history-preview", () => historyPreview?.dispose(error));
    cleanup("history-client", () => previewScope?.dispose(error));
    cleanup("plugins", () => pluginService?.dispose(error));
    cleanup("router-client", () => routerScope?.dispose(error));
    cleanup("transport", () => transport?.dispose(error));
  }

  try {
    // 只有 Gateway 装配层拥有真实连接；通用目录不需要反向认识路由或插件。
    transport = createTransport({
      requestIdPrefix: ROUTER_REQUEST_PREFIX,
      createConnectionPolicy: createInternalSessions,
      processClientMessage: (message) => pluginService.modelRouter.processClientMessage(message),
      processServerMessage: (message) => pluginService.modelRouter.processServerMessage(message),
      onAttached: () => pluginService.modelRouter.onAppServerAttached(),
      onClosed: () => pluginService.modelRouter.onAppServerClosed(),
    });
    routerScope = createAppServerClient(transport);
    const routerClient = createRouterTransportClient(transport, routerScope.client);
    pluginService = createPlugins({ ...options, transport: routerClient, releaseTransport: routerScope.dispose });
    previewScope = createAppServerClient(transport);
    historyPreview = createPreview({
      // 历史预览只拿到只读所需能力，不能装饰/销毁连接，也不能登记私有会话。
      transport: Object.freeze({ isAttached: previewScope.client.isAttached, request: previewScope.client.request }),
      isInternalThreadId: routerClient.isInternalThreadId,
      releaseTransport: previewScope.dispose,
    });
  } catch (error) {
    dispose(error);
    throw error;
  }

  return {
    transport,
    pluginService,
    historyPreview,
    decorateAppServerChild: transport.decorateChild,
    dispose,
  };
}

module.exports = { createGatewayAppServerService };
