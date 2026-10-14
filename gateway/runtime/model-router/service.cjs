const { diagnosticLog, diagnosticWarn } = require("../core/diagnostics.cjs");
const { createClassifier } = require("./classifier.cjs");
const { createModelCatalog } = require("./catalog.cjs");
const {
  ASSISTANT_FINAL_TEXT_LIMIT,
  assistantFinalFromItems,
  assistantFinalFromTurn,
  createRoutingContext,
  normalizeHistoryUserInputLimit,
  recentTurnsFromTurns,
  summarizeUserInput,
  trimMiddleText,
} = require("./context.cjs");
const {
  AUTO_REASONING_EFFORT,
  CLASSIFICATION_TIMEOUT_MS,
  EFFORT_ORDER,
  SMART_ROUTER_PLUGIN_ID,
} = require("./constants.cjs");
const {
  resolveClassifierRoute,
  resolveFallbackRoute,
  resolveTierRoute,
} = require("./resolver.cjs");
const { createAutoStateStore } = require("./state-store.cjs");
const { createAppServerTransport } = require("./transport.cjs");
const { createTurnRouteStatus } = require("./turn-route-status.cjs");
const { enabledTierDefinitions } = require("./tiers.cjs");
const { createVirtualModelController, isAuto, requestKey } = require("./virtual-model.cjs");

const MAX_HISTORY_THREADS = 128;
const MAX_HISTORY_REVISIONS = 512;
const MAX_EXTERNAL_REQUESTS = 4096;
const MAX_CATALOG_PAGES = 20;

function setBoundedMapEntry(map, key, value, maxEntries) {
  map.delete(key);
  map.set(key, value);
  const effectiveMaxEntries = Math.max(1, Number(maxEntries) || 1);
  while (map.size > effectiveMaxEntries) map.delete(map.keys().next().value);
  return value;
}

function createSmartModelRouterService({
  configStore,
  stateFilePath,
  classifierOptions = {},
  injectionHealth = null,
  compatibilityService = null,
  transport: injectedTransport = null,
  releaseTransport = () => {},
}) {
  let disposed = false;
  let lifecycleRevision = 0;
  const stateStore = createAutoStateStore({ filePath: stateFilePath });
  const catalog = createModelCatalog();
  const historyByThread = new Map();
  const historyRevisionByThread = new Map();
  const openHistoryTurnsByThread = new Map();
  const externalRequests = new Map();
  const threadRoutingChains = new Map();
  const turnRouteStatus = createTurnRouteStatus();
  const routeStatusListeners = new Set();
  let catalogRefreshPromise = null;
  let historyCacheGeneration = 0;
  let nextHistoryRevision = 0;
  const gatewayPoints = compatibilityService?.modificationPoints?.gateway;

  function emitModification(point) {
    try {
      compatibilityService?.modifications?.effect(point).emit();
    } catch {
      // 命中诊断不能改变 App Server 消息处理结果。
    }
  }

  function emitRouteStatus(event) {
    if (disposed) return;
    for (const listener of Array.from(routeStatusListeners)) {
      try {
        // 展示事件只携带状态和安全路由摘要，不能把分类 rationale 或用户输入带出核心。
        listener(event);
      } catch {}
    }
  }

  function pluginConfig() {
    return configStore.plugin(SMART_ROUTER_PLUGIN_ID) || { enabled: false, values: {} };
  }

  function classificationHistoryLimit(config = pluginConfig()) {
    return normalizeHistoryUserInputLimit(config?.values?.classifierHistoryCount);
  }

  function historyRevision(threadId) {
    return historyRevisionByThread.get(threadId) || 0;
  }

  function markHistoryChanged(threadId) {
    if (!threadId) return;
    // 全局单调修订号配合有界 LRU，key 被淘汰后也不会接受淘汰前的迟到历史响应。
    setBoundedMapEntry(historyRevisionByThread, threadId, ++nextHistoryRevision, MAX_HISTORY_REVISIONS);
  }

  function beginHistoryTurn(threadId) {
    setBoundedMapEntry(
      openHistoryTurnsByThread,
      threadId,
      (openHistoryTurnsByThread.get(threadId) || 0) + 1,
      MAX_HISTORY_REVISIONS
    );
  }

  function endHistoryTurn(threadId) {
    const remaining = (openHistoryTurnsByThread.get(threadId) || 0) - 1;
    if (remaining > 0) {
      setBoundedMapEntry(openHistoryTurnsByThread, threadId, remaining, MAX_HISTORY_REVISIONS);
    } else openHistoryTurnsByThread.delete(threadId);
  }

  function hasOpenHistoryTurn(threadId) {
    return (openHistoryTurnsByThread.get(threadId) || 0) > 0;
  }

  function isEnabled() {
    return !disposed && pluginConfig().enabled === true;
  }

  function fallbackRoute() {
    const config = pluginConfig();
    return resolveFallbackRoute({ configValues: config.values, tiers: config.tiers, models: catalog.models() });
  }

  function modelDisplayName(modelId) {
    const normalizedModelId = String(modelId || "");
    if (!normalizedModelId) return "";
    const model = catalog
      .models()
      .find((candidate) => String(candidate?.model || candidate?.id || "") === normalizedModelId);
    // 展示名称来自当前账号的真实模型目录；目录尚未就绪时保守回退到协议 ID。
    return String(model?.displayName || normalizedModelId).trim() || normalizedModelId;
  }

  function currentAutoRoute(threadId) {
    const normalizedThreadId = String(threadId || "");
    if (!normalizedThreadId || !isEnabled() || !stateStore.isThreadAuto(normalizedThreadId)) return null;
    const active = turnRouteStatus.activeRoute(normalizedThreadId);
    if (active) return active;
    const previous = stateStore.threadState(normalizedThreadId);
    if (!previous?.lastModel || !previous.lastEffort) return null;
    // 空闲时继续返回最近一次具体调度；turnId 留空，避免被调用方误判为仍在执行。
    return {
      threadId: normalizedThreadId,
      turnId: "",
      tier: previous.lastTier,
      model: previous.lastModel,
      effort: previous.lastEffort,
      fallback: previous.lastFallback === true,
    };
  }

  function emitCurrentAutoRoute(threadId) {
    const route = currentAutoRoute(threadId);
    if (route) emitRouteStatus({ status: "idle", threadId: String(threadId || ""), route });
    else emitRouteStatus({ status: "cleared", threadId: String(threadId || "") });
  }

  let virtualModel;
  let classifier;
  function resetConnectionState() {
    lifecycleRevision += 1;
    historyCacheGeneration += 1;
    catalog.clear();
    catalogRefreshPromise = null;
    historyByThread.clear();
    historyRevisionByThread.clear();
    openHistoryTurnsByThread.clear();
    externalRequests.clear();
    threadRoutingChains.clear();
    virtualModel?.clearPending?.();
    // 连接关闭/替换后，旧异步工作不能继续填充缓存或发布路由状态。
    turnRouteStatus.clearAll();
  }
  function onAppServerClosed() {
    resetConnectionState();
  }
  function onAppServerAttached() {
    if (disposed) return;
    resetConnectionState();
    injectionHealth?.reportGateway("app-server-router");
    emitModification(gatewayPoints?.appServerTransport);
  }
  const transport = injectedTransport || createAppServerTransport({
    processClientMessage: (message) => processClientMessage(message),
    processServerMessage: (message) => processServerMessage(message),
    onClosed: onAppServerClosed,
    onAttached: onAppServerAttached,
  });
  virtualModel = createVirtualModelController({
    stateStore,
    isEnabled,
    fallbackRoute,
    onModelListFirstPage() {
      // 被动分页没有统一事务身份，只触发受控完整读取；内部回复不经过虚拟层，避免递归刷新。
      void refreshCatalog();
    },
    onAutoModelInjected() {
      injectionHealth?.reportGateway("auto-model-catalog");
      emitModification(gatewayPoints?.virtualModel);
    },
  });
  classifier = createClassifier({ transport, ...classifierOptions });

  if (!isEnabled()) stateStore.clearAllAuto();
  const stopConfigListener = configStore.onChanged((event) => {
    if (event.id !== SMART_ROUTER_PLUGIN_ID) return;
    if (!event.current.enabled) stateStore.clearAllAuto();
    if (classificationHistoryLimit(event.previous) !== classificationHistoryLimit(event.current)) {
      // 全局数量变化后丢弃所有旧尺寸缓存，下一轮按新配置重新读取完整历史。
      historyCacheGeneration += 1;
      historyByThread.clear();
    }
  });

  function remainingRouteMs(deadlineAt, cap) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      const error = new Error("Smart scheduling deadline exceeded");
      error.category = "timeout";
      throw error;
    }
    return Math.max(1, Math.min(remaining, cap || remaining));
  }

  async function refreshCatalog(deadlineAt = 0) {
    if (disposed || !transport.isAttached()) return catalog.models();
    if (catalogRefreshPromise) return catalogRefreshPromise;
    const revision = lifecycleRevision;
    const refresh = (async () => {
      let cursor = null;
      const seenCursors = new Set();
      const candidate = [];
      for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
        const result = await transport.request(
          "model/list",
          { cursor, limit: 100, includeHidden: false },
          { timeoutMs: deadlineAt ? remainingRouteMs(deadlineAt, 5_000) : 5_000 }
        );
        if (disposed || revision !== lifecycleRevision) return catalog.models();
        if (!Array.isArray(result?.data) || result.data.some((model) => {
          const id = model?.model || model?.id;
          return !model || typeof model !== "object" || Array.isArray(model) || typeof id !== "string" || !id.trim();
        })) throw new Error("Invalid model catalog page");
        const nextCursor = result.nextCursor;
        if (nextCursor != null && typeof nextCursor !== "string") throw new Error("Invalid model catalog cursor");
        for (const model of result.data) candidate.push(model);
        if (nextCursor == null || nextCursor === "") {
          // 所有页校验通过才替换 live；等待中的读取者仍可使用上一份完整目录。
          catalog.replaceModels(candidate);
          return catalog.models();
        }
        if (seenCursors.has(nextCursor)) throw new Error("Repeated model catalog cursor");
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      throw new Error("Model catalog pagination limit exceeded");
    })()
      .catch((error) => {
        if (disposed || revision !== lifecycleRevision) return catalog.models();
        diagnosticWarn("model-router", "catalog_refresh_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return catalog.models();
      })
      .finally(() => {
        if (catalogRefreshPromise === refresh) catalogRefreshPromise = null;
      });
    catalogRefreshPromise = refresh;
    return refresh;
  }

  async function recentHistory(threadId, historyLimit, deadlineAt = 0) {
    const cached = historyByThread.get(threadId);
    if (
      cached?.generation === historyCacheGeneration &&
      cached.limit === historyLimit &&
      Array.isArray(cached.turns)
    ) {
      setBoundedMapEntry(historyByThread, threadId, cached, MAX_HISTORY_THREADS);
      return cached.turns;
    }
    if (cached) historyByThread.delete(threadId);
    const requestGeneration = historyCacheGeneration;
    const requestRevision = historyRevision(threadId);
    try {
      const result = await transport.request(
        "thread/turns/list",
        { threadId, cursor: null, limit: historyLimit, sortDirection: "desc", itemsView: "full" },
        { timeoutMs: deadlineAt ? remainingRouteMs(deadlineAt, 4_000) : 4_000 }
      );
      // desc 页先倒序为时间正序，再抽取配置数量的最近完整回合。
      const history = recentTurnsFromTurns(
        [...(Array.isArray(result?.data) ? result.data : [])].reverse(),
        historyLimit
      );
      // 配置可能在请求期间变化；旧请求结果只能服务当前回合，不能污染新尺寸缓存。
      if (
        !disposed &&
        requestGeneration === historyCacheGeneration &&
        requestRevision === historyRevision(threadId) &&
        !hasOpenHistoryTurn(threadId) &&
        classificationHistoryLimit() === historyLimit
      ) {
        setBoundedMapEntry(
          historyByThread,
          threadId,
          { generation: requestGeneration, limit: historyLimit, turns: history },
          MAX_HISTORY_THREADS
        );
      }
      return history;
    } catch {
      // 读取失败时不落空缓存；同时保留同一期间由其他完整历史响应成功填充的缓存。
      return [];
    }
  }

  function appendUserTurn(threadId, input) {
    if (!threadId) return;
    // 即使当前没有可追加的完整缓存，回合开始也会让更早发出的历史响应失去权威性。
    markHistoryChanged(threadId);
    beginHistoryTurn(threadId);
    const historyLimit = classificationHistoryLimit();
    const cached = historyByThread.get(threadId);
    // 未完成服务端历史读取时不创建局部缓存，避免手动回合让后续 Auto 误判缓存已完整。
    if (
      cached?.generation !== historyCacheGeneration ||
      cached.limit !== historyLimit ||
      !Array.isArray(cached.turns)
    ) {
      return;
    }
    cached.turns.push({
      user: summarizeUserInput(input),
      // 这些字段只服务缓存关联，createRoutingContext 会在送入分类器前剥离。
      pending: true,
      turnId: "",
      finalConfirmed: false,
    });
    while (cached.turns.length > historyLimit) cached.turns.shift();
  }

  function cachedPendingTurn(threadId, turnId = "") {
    const cached = historyByThread.get(threadId);
    if (!Array.isArray(cached?.turns)) return null;
    const pending = cached.turns.filter((turn) => turn?.pending === true);
    if (turnId) {
      const matched = pending.findLast((turn) => turn.turnId === turnId);
      if (matched) return matched;
    }
    return pending.findLast((turn) => !turn.turnId) || pending.at(-1) || null;
  }

  function associateCachedTurn(threadId, turnId) {
    if (!threadId || !turnId) return;
    const pending = cachedPendingTurn(threadId, turnId);
    if (pending && !pending.turnId) pending.turnId = turnId;
  }

  function appendCachedAssistantFinal(threadId, turnId, item) {
    if (item?.type !== "agentMessage" || item.phase !== "final_answer") return;
    markHistoryChanged(threadId);
    const assistantFinal = assistantFinalFromItems([item]);
    const pending = cachedPendingTurn(threadId, turnId);
    if (!assistantFinal) return;
    if (!pending) {
      // 收到未被本地回合结构覆盖的最终回答时，现有缓存已无法证明完整。
      historyByThread.delete(threadId);
      return;
    }
    pending.assistantFinal = trimMiddleText(
      [pending.assistantFinal, assistantFinal].filter(Boolean).join("\n\n"),
      ASSISTANT_FINAL_TEXT_LIMIT
    );
    pending.finalConfirmed = true;
  }

  function completeCachedTurn(threadId, turn) {
    markHistoryChanged(threadId);
    endHistoryTurn(threadId);
    const turnId = String(turn?.id || "");
    const pending = cachedPendingTurn(threadId, turnId);
    if (!pending) {
      historyByThread.delete(threadId);
      return;
    }
    const inlineFinal = assistantFinalFromTurn(turn);
    if (inlineFinal) {
      // 完整 turn 是权威来源，可消除 item/completed 重放造成的重复拼接。
      pending.assistantFinal = inlineFinal;
      pending.finalConfirmed = true;
    }
    if (!pending.finalConfirmed) {
      // 无法确认用户可见最终回答时丢弃局部缓存，下一轮强制从 full history 补齐。
      historyByThread.delete(threadId);
      return;
    }
    delete pending.pending;
    delete pending.turnId;
    delete pending.finalConfirmed;
  }

  function discardUnstartedCachedTurn(threadId) {
    markHistoryChanged(threadId);
    endHistoryTurn(threadId);
    const cached = historyByThread.get(threadId);
    if (!Array.isArray(cached?.turns)) return;
    const index = cached.turns.findLastIndex((turn) => turn?.pending === true && !turn.turnId);
    if (index >= 0) cached.turns.splice(index, 1);
  }

  function rewriteTurn(message, route) {
    const params = message.params || (message.params = {});
    params.model = route.model;
    params.effort = route.effort;
    if (params.collaborationMode?.settings) {
      // collaborationMode 在 App Server 中优先于顶层 model/effort，两组字段必须同步改写。
      params.collaborationMode.settings.model = route.model;
      params.collaborationMode.settings.reasoning_effort = route.effort;
    }
    return message;
  }

  function concreteGuard(message, route) {
    const params = message?.params;
    if (!params || typeof params !== "object") return message;
    const concrete = route || fallbackRoute();
    if (isAuto(params.model)) params.model = concrete.model;
    if (isAuto(params.config?.model)) params.config.model = concrete.model;
    if (isAuto(params.collaborationMode?.settings?.model)) {
      params.collaborationMode.settings.model = concrete.model;
      params.collaborationMode.settings.reasoning_effort = concrete.effort;
    }
    if (message.method === "config/value/write" && message.params?.keyPath === "model" && isAuto(message.params.value)) {
      message.params.value = concrete.model;
    }
    if (message.method === "config/batchWrite") {
      for (const edit of Array.isArray(message.params?.edits) ? message.params.edits : []) {
        if (edit?.keyPath === "model" && isAuto(edit.value)) edit.value = concrete.model;
      }
    }
    return message;
  }

  async function routeAutoTurn(message, threadId) {
    const revision = lifecycleRevision;
    if (disposed) return message;
    const startedAt = Date.now();
    const deadlineAt = startedAt + CLASSIFICATION_TIMEOUT_MS;
    let route;
    let errorCategory = "";
    try {
      const config = pluginConfig();
      const historyLimit = classificationHistoryLimit(config);
      if (!catalog.isComplete() && catalog.models().length === 0) await refreshCatalog(deadlineAt);
      if (disposed || revision !== lifecycleRevision) return message;
      const history = await recentHistory(threadId, historyLimit, deadlineAt);
      if (disposed || revision !== lifecycleRevision) return message;
      const context = createRoutingContext({
        input: message.params?.input,
        history,
        historyLimit,
      });
      const configValues = config.values;
      const tiers = config.tiers;
      const enabledTiers = enabledTierDefinitions(tiers);
      if (enabledTiers.length === 0) {
        const error = new Error("Smart scheduling has no enabled tiers");
        error.category = "no_enabled_tiers";
        throw error;
      }
      const automaticEffortTiers = enabledTiers
        .filter((tier) => tier.effort === AUTO_REASONING_EFFORT)
        .map((tier) => tier.id);
      const classifierRoute = resolveClassifierRoute({
        configValues,
        models: catalog.models(),
      });
      const result = await classifier.classify({
        context,
        model: classifierRoute.model,
        effort: classifierRoute.effort,
        tiers,
        automaticEffortTiers,
        deadlineAt,
      });
      const classification = result.classification;
      if (automaticEffortTiers.includes(classification.tier) && !EFFORT_ORDER.includes(classification.effort)) {
        const error = new Error("Classifier omitted effort for an automatic-effort tier");
        error.category = "invalid_schema";
        throw error;
      }
      route = resolveTierRoute({
        tier: classification.tier,
        classificationEffort: classification.effort,
        tiers,
        configValues,
        models: catalog.models(),
      });
    } catch (error) {
      errorCategory = String(error?.category || "classification");
      route = fallbackRoute();
    }
    if (disposed || revision !== lifecycleRevision) return message;
    rewriteTurn(message, route);
    emitModification(gatewayPoints?.turnRouter);
    turnRouteStatus.select({
      requestKey: requestKey(message.id),
      threadId,
      route,
    });
    const routeStillVisible = isEnabled() && stateStore.isThreadAuto(threadId);
    if (routeStillVisible) {
      stateStore.recordRoute(threadId, route);
      emitRouteStatus({ status: "selected", threadId, route });
    } else {
      /**
       * 分类期间用户可能已经切回手动模型。当前回合仍沿用已经算出的真实路由，
       * 但展示层只能收到 cleared，不能让延迟 selected 覆盖新的手动状态。
       */
      emitRouteStatus({ status: "cleared", threadId });
    }
    diagnosticLog("model-router", "route_selected", {
      tier: route.tier,
      model: route.model,
      effort: route.effort,
      elapsedMs: Date.now() - startedAt,
      fallback: route.fallback === true,
      ...(errorCategory ? { error: errorCategory } : {}),
    });
    return message;
  }

  async function routeAutoTurnInThreadOrder(message, threadId) {
    const revision = lifecycleRevision;
    const previous = threadRoutingChains.get(threadId) || Promise.resolve();
    // 排队时就绑定生命周期；不能等前一项结束后把旧任务误认作新连接的工作。
    const current = previous.catch(() => {}).then(() =>
      disposed || revision !== lifecycleRevision ? message : routeAutoTurn(message, threadId)
    );
    threadRoutingChains.set(threadId, current);
    try {
      return await current;
    } finally {
      if (threadRoutingChains.get(threadId) === current) threadRoutingChains.delete(threadId);
    }
  }

  async function processClientMessage(original) {
    // dispose 是停止边界，不是插件热卸载；不能继续发送半处理的 Auto 帧。
    if (disposed) return null;
    const revision = lifecycleRevision;
    if (original?.id != null && typeof original.method === "string") {
      const historyRequest =
        original.method === "thread/turns/list"
          ? {
              cursor: original.params?.cursor ?? null,
              itemsView: String(original.params?.itemsView || ""),
              limit: Number(original.params?.limit),
              sortDirection: String(original.params?.sortDirection || ""),
            }
          : null;
      setBoundedMapEntry(externalRequests, requestKey(original.id), {
        method: original.method,
        requestKey: requestKey(original.id),
        threadId: String(original.params?.threadId || ""),
        historyCacheGeneration,
        historyRevision: historyRevision(String(original.params?.threadId || "")),
        historyRequest,
      }, MAX_EXTERNAL_REQUESTS);
    }
    const prepared = virtualModel.prepareClientMessage(original);
    const message = prepared.message;
    if (message?.method === "thread/settings/update" && prepared.meta?.threadId) {
      // 模型选择一提交就同步摘要状态；若官方拒绝，响应处理会按回滚后的状态再次校正。
      emitCurrentAutoRoute(prepared.meta.threadId);
    } else if (message?.method === "turn/start") {
      const threadId = String(message.params?.threadId || "");
      // 同一线程严格按 turn 顺序路由，不同线程仍可并发占用两个分类 permit。
      if (prepared.autoTurn) {
        emitRouteStatus({ status: "classifying", threadId });
        await routeAutoTurnInThreadOrder(message, threadId);
        if (disposed || revision !== lifecycleRevision) return null;
      } else {
        emitRouteStatus({ status: "cleared", threadId });
      }
      appendUserTurn(threadId, message.params?.input);
    }
    return concreteGuard(message);
  }

  function filterInternalThreads(message, meta) {
    if (!meta || !["thread/list", "thread/search", "thread/loaded/list"].includes(meta.method)) return message;
    const data = message?.result?.data;
    if (!Array.isArray(data)) return message;
    const filteredData = data.filter((thread) => !transport.isInternalThreadId(thread?.id));
    if (filteredData.length !== data.length) {
      emitModification(gatewayPoints?.internalSession);
    }
    return {
      ...message,
      result: {
        ...message.result,
        data: filteredData,
      },
    };
  }

  function observeServerNotification(message) {
    if (!message?.method || !message.params) return;
    const threadId = String(message.params.threadId || message.params.thread?.id || "");
    if (!threadId || transport.isInternalThreadId(threadId)) return;
    emitModification(gatewayPoints?.historyContext);
    if (message.method === "turn/started") {
      associateCachedTurn(threadId, String(message.params.turn?.id || message.params.turnId || ""));
    } else if (message.method === "item/completed") {
      appendCachedAssistantFinal(threadId, String(message.params.turnId || ""), message.params.item);
    } else if (["turn/completed", "turn/failed", "turn/interrupted"].includes(message.method)) {
      completeCachedTurn(threadId, message.params.turn);
    }
    if (message.method === "thread/deleted" && threadId) {
      historyByThread.delete(threadId);
      openHistoryTurnsByThread.delete(threadId);
      // 保留递增后的修订号，使删除前发出的迟到历史响应无法重新创建缓存。
      markHistoryChanged(threadId);
    }
  }

  function processServerMessage(original) {
    if (disposed) return null;
    observeServerNotification(original);
    const key = original?.id != null ? requestKey(original.id) : "";
    const meta = key ? externalRequests.get(key) : null;
    if (key) externalRequests.delete(key);
    const filtered = filterInternalThreads(original, meta);
    if (meta?.method === "thread/turns/list" && meta.threadId && Array.isArray(filtered?.result?.data)) {
      const historyLimit = classificationHistoryLimit();
      const request = meta.historyRequest;
      const canHydrateCurrentCache =
        meta.historyCacheGeneration === historyCacheGeneration &&
        meta.historyRevision === historyRevision(meta.threadId) &&
        !hasOpenHistoryTurn(meta.threadId) &&
        request?.cursor == null &&
        request.limit >= historyLimit &&
        request.sortDirection === "desc" &&
        request.itemsView === "full";
      if (canHydrateCurrentCache) {
        // 仅用完整的最新页填充缓存，分页或旧配置响应不能让后续分类误判缓存已经完备。
        const history = recentTurnsFromTurns([...filtered.result.data].reverse(), historyLimit);
        setBoundedMapEntry(
          historyByThread,
          meta.threadId,
          {
            generation: historyCacheGeneration,
            limit: historyLimit,
            turns: history,
          },
          MAX_HISTORY_THREADS
        );
      }
    }
    if (meta?.method === "turn/start" && meta.threadId) {
      if (filtered?.error) discardUnstartedCachedTurn(meta.threadId);
      else associateCachedTurn(meta.threadId, String(filtered?.result?.turn?.id || filtered?.result?.turnId || ""));
    }
    const withRouteStatus = turnRouteStatus.processServerMessage(filtered, meta);
    const threadId = String(withRouteStatus?.params?.threadId || withRouteStatus?.params?.thread?.id || meta?.threadId || "");
    const processed = virtualModel.processServerMessage(withRouteStatus);
    if (withRouteStatus?.method === "turn/started" && threadId) {
      const route = turnRouteStatus.activeRoute(threadId);
      if (route && isEnabled() && stateStore.isThreadAuto(threadId)) {
        emitRouteStatus({ status: "started", threadId, route });
      } else if (route) {
        // 手动状态下只保留本轮执行映射，不再把 started 暴露为可展示的 Auto 路由。
        emitRouteStatus({ status: "cleared", threadId });
      }
    } else if (["turn/completed", "turn/failed", "turn/interrupted"].includes(withRouteStatus?.method) && threadId) {
      // 回合结束只退出运行态；Auto 未关闭时，摘要继续展示刚完成的分类结果。
      emitCurrentAutoRoute(threadId);
    } else if (withRouteStatus?.id != null && meta?.method === "turn/start" && withRouteStatus.error && threadId) {
      emitCurrentAutoRoute(threadId);
    } else if (withRouteStatus?.id != null && meta?.method === "thread/settings/update" && withRouteStatus.error && threadId) {
      // virtual model 已在失败响应中恢复旧选择，此处把回滚后的 Auto 状态同步给展示层。
      emitCurrentAutoRoute(threadId);
    } else if (["thread/deleted", "thread/unsubscribed"].includes(withRouteStatus?.method) && threadId) {
      emitRouteStatus({ status: withRouteStatus.method === "thread/deleted" ? "deleted" : "unsubscribed", threadId });
    }
    return processed;
  }

  return {
    decorateAppServerChild: transport.decorateChild,
    onAppServerAttached,
    onAppServerClosed,
    diagnostics() {
      const catalogSnapshot = catalog.snapshot();
      const state = stateStore.snapshot();
      return {
        enabled: isEnabled(),
        attached: transport.isAttached(),
        catalogComplete: catalogSnapshot.complete,
        modelCount: catalogSnapshot.models.length,
        classifier: classifier.status(),
        defaultAuto: state.default.auto === true,
        autoThreadCount: Object.values(state.threads).filter((thread) => thread.auto).length,
        activeRouteCount: Object.keys(turnRouteStatus.snapshot().active).length,
      };
    },
    dispose(error = new Error("smart model router disposed")) {
      if (disposed) return;
      disposed = true;
      try {
        stopConfigListener();
      } finally {
        routeStatusListeners.clear();
        resetConnectionState();
        // 注入模式只释放自己的请求作用域；旧独立入口继续负责其自建连接。
        if (injectedTransport) releaseTransport(error);
        else transport.dispose(error);
      }
    },
    isEnabled,
    onRouteStatus(listener) {
      if (disposed || typeof listener !== "function") return () => {};
      routeStatusListeners.add(listener);
      return () => routeStatusListeners.delete(listener);
    },
    activeRoute(threadId) {
      const config = pluginConfig();
      if (!config.enabled || config.values?.showRouteInSummary === false) return null;
      const route = currentAutoRoute(threadId);
      return route ? { ...route, displayName: modelDisplayName(route.model) } : null;
    },
    async listModels() {
      if (!catalog.isComplete() && catalog.models().length === 0) await refreshCatalog();
      return catalog.models();
    },
    modelCatalog: catalog,
    modelDisplayName,
    processClientMessage,
    processServerMessage,
    refreshCatalog,
    stateStore,
    transport,
    turnRouteStatus,
    virtualModel,
  };
}

module.exports = {
  createSmartModelRouterService,
  __test: { setBoundedMapEntry },
};
