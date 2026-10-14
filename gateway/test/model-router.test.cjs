const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parseClassificationText, validateClassification } = require("../runtime/model-router/classifier.cjs");
const {
  ASSISTANT_FINAL_TEXT_LIMIT,
  assistantFinalFromItems,
  assistantFinalFromTurn,
  buildClassifierPrompt,
  createRoutingContext,
  recentTurnsFromTurns,
  summarizeUserInput,
} = require("../runtime/model-router/context.cjs");
const {
  nearestEffort,
  resolveClassifierRoute,
  resolveTierRoute,
} = require("../runtime/model-router/resolver.cjs");
const { defaultTierDefinitions } = require("../runtime/model-router/tiers.cjs");
const { createAutoStateStore } = require("../runtime/model-router/state-store.cjs");
const { ROUTE_METADATA_KEY, createTurnRouteStatus } = require("../runtime/model-router/turn-route-status.cjs");
const { createSmartModelRouterService, __test: serviceTest } = require("../runtime/model-router/service.cjs");

function tempFile(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-router-test-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return path.join(dir, name);
}

function model(id, efforts = ["low", "medium", "high", "xhigh"], isDefault = false) {
  return {
    id,
    model: id,
    displayName: id,
    hidden: false,
    isDefault,
    defaultReasoningEffort: efforts[0],
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
  };
}

function tiersWithCustom(patch) {
  const tiers = defaultTierDefinitions();
  tiers.splice(1, 0, {
    id: "routine-plus",
    builtin: false,
    enabled: true,
    name: "Routine plus",
    prompt: "Use for routine work with a wider change surface.",
    model: "custom",
    effort: "auto",
    ...patch,
  });
  return tiers;
}

function catalogFixture(t) {
  const requests = [];
  const service = createSmartModelRouterService({
    configStore: { plugin: () => ({ enabled: true, values: {} }), onChanged: () => () => {} },
    stateFilePath: tempFile(t, "catalog-state.json"),
    transport: {
      isAttached: () => true,
      request(method, params) {
        assert.equal(method, "model/list");
        return new Promise((resolve, reject) => requests.push({ params, resolve, reject }));
      },
    },
  });
  t.after(() => service.dispose());
  return { service, requests };
}

const catalogTick = () => new Promise((resolve) => setImmediate(resolve));
const catalogIds = (service) => service.modelCatalog.models().map((entry) => entry.id);

test("model catalog refresh keeps the complete snapshot when a later page fails", async (t) => {
  const { service, requests } = catalogFixture(t);
  service.modelCatalog.replaceModels([model("previous-good")]);
  const previous = service.modelCatalog.snapshot();
  const refresh = service.refreshCatalog();
  requests[0].resolve({ data: [model("partial")], nextCursor: "second" });
  await catalogTick();
  assert.deepEqual(service.modelCatalog.snapshot(), previous);
  assert.deepEqual(await service.listModels(), previous.models);
  requests[1].reject(new Error("second page failed"));
  assert.deepEqual(await refresh, previous.models);
  assert.deepEqual(service.modelCatalog.snapshot(), previous);
});

test("model catalog refresh shares one request chain and atomically replaces all old models", async (t) => {
  const { service, requests } = catalogFixture(t);
  service.modelCatalog.replaceModels([model("previous-good")]);
  const first = service.refreshCatalog();
  const second = service.refreshCatalog();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, { cursor: null, limit: 100, includeHidden: false });
  requests[0].resolve({ data: [model("new-first")], nextCursor: "second" });
  await catalogTick();
  const third = service.refreshCatalog();
  assert.equal(requests.length, 2);
  assert.deepEqual(catalogIds(service), ["previous-good"]);
  requests[1].resolve({ data: [model("new-second"), model("auto")], nextCursor: null });
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(catalogIds(service), ["new-first", "new-second"]);
  assert.equal(service.modelCatalog.isComplete(), true);
  for (const result of results) assert.deepEqual(result, service.modelCatalog.models());
});

for (const [name, result] of [
  ["missing result", undefined],
  ["missing data", {}],
  ["non-array data", { data: {} }],
  ["invalid model", { data: [null] }],
  ["invalid identifier", { data: [{ id: 7 }] }],
  ["empty identifier", { data: [{ id: " " }] }],
  ["invalid cursor", { data: [model("partial")], nextCursor: 5 }],
]) {
  test(`model catalog rejects ${name} without replacing a complete snapshot`, async (t) => {
    const { service, requests } = catalogFixture(t);
    service.modelCatalog.replaceModels([model("previous-good")]);
    const previous = service.modelCatalog.snapshot();
    const refresh = service.refreshCatalog();
    requests[0].resolve(result);
    await refresh;
    assert.deepEqual(service.modelCatalog.snapshot(), previous);
    assert.equal(requests.length, 1);
  });
}

for (const cursors of [["second", "second"], ["second", "third", "second"]]) {
  test(`model catalog rejects a ${cursors.length === 2 ? "non-progressing" : "cyclic"} cursor before another request`, async (t) => {
    const { service, requests } = catalogFixture(t);
    service.modelCatalog.replaceModels([model("previous-good")]);
    const refresh = service.refreshCatalog();
    for (const [index, nextCursor] of cursors.entries()) {
      requests[index].resolve({ data: [model(`partial-${index}`)], nextCursor });
      await catalogTick();
    }
    await refresh;
    assert.equal(requests.length, cursors.length);
    assert.deepEqual(catalogIds(service), ["previous-good"]);
  });
}

for (const completeAtLimit of [false, true]) {
  test(`model catalog ${completeAtLimit ? "accepts completion" : "rejects an unfinished chain"} at page 20`, async (t) => {
    const { service, requests } = catalogFixture(t);
    service.modelCatalog.replaceModels([model("previous-good")]);
    const refresh = service.refreshCatalog();
    for (let index = 0; index < 20; index += 1) {
      requests[index].resolve({
        data: [model(`page-${index}`)],
        nextCursor: completeAtLimit && index === 19 ? null : `cursor-${index + 1}`,
      });
      await catalogTick();
    }
    await refresh;
    assert.equal(requests.length, 20);
    assert.deepEqual(catalogIds(service), completeAtLimit ? Array.from({ length: 20 }, (_, i) => `page-${i}`) : ["previous-good"]);
  });
}

test("an empty complete model catalog is not confused with a failed cold refresh", async (t) => {
  const { service, requests } = catalogFixture(t);
  const failed = service.listModels();
  requests[0].reject(new Error("cold start unavailable"));
  assert.deepEqual(await failed, []);
  assert.equal(service.modelCatalog.isComplete(), false);
  const retry = service.listModels();
  requests[1].resolve({ data: [], nextCursor: null });
  assert.deepEqual(await retry, []);
  assert.equal(service.modelCatalog.isComplete(), true);
  assert.deepEqual(await service.listModels(), []);
  assert.equal(requests.length, 2);
});

for (const lifecycle of ["closed", "attached", "disposed"]) {
  test(`a ${lifecycle} lifecycle rejects old catalog pages and preserves the new single-flight owner`, async (t) => {
    const { service, requests } = catalogFixture(t);
    service.modelCatalog.replaceModels([model("previous-good")]);
    const oldRefresh = service.refreshCatalog();
    requests[0].resolve({ data: [model("old-first")], nextCursor: "second" });
    await catalogTick();
    if (lifecycle === "closed") service.onAppServerClosed();
    else if (lifecycle === "attached") service.onAppServerAttached();
    else service.dispose();
    const currentRefresh = service.refreshCatalog();
    requests[1].resolve({ data: [model("old-second")], nextCursor: null });
    await oldRefresh;
    assert.deepEqual(catalogIds(service), []);
    const concurrentRefresh = service.refreshCatalog();
    assert.equal(requests.length, lifecycle === "disposed" ? 2 : 3);
    if (lifecycle !== "disposed") requests[2].resolve({ data: [model("new-lifecycle")], nextCursor: null });
    await Promise.all([currentRefresh, concurrentRefresh]);
    assert.deepEqual(catalogIds(service), lifecycle === "disposed" ? [] : ["new-lifecycle"]);
  });
}

async function observeModelPage(service, id, cursor, result) {
  await service.processClientMessage({ id, method: "model/list", params: { cursor } });
  return service.processServerMessage({ id, result });
}

test("passive model pages cannot overwrite or interleave with the controlled catalog refresh", async (t) => {
  const { service, requests } = catalogFixture(t);
  service.modelCatalog.replaceModels([model("previous-good")]);
  const refresh = service.refreshCatalog();
  const first = await observeModelPage(service, "external-first", null, { data: [model("external-partial")], nextCursor: "tail" });
  assert.deepEqual(first.result.data.map((entry) => entry.id), ["auto", "external-partial"]);
  await observeModelPage(service, "external-tail", "tail", { data: [model("external-tail")], nextCursor: null });
  assert.equal(requests.length, 1);
  requests[0].resolve({ data: [model("internal-first")], nextCursor: "second" });
  await catalogTick();
  await observeModelPage(service, "external-other", null, { data: [model("external-other")], nextCursor: null });
  assert.equal(requests.length, 2);
  assert.deepEqual(catalogIds(service), ["previous-good"]);
  requests[1].reject(new Error("controlled page failed"));
  await refresh;
  assert.deepEqual(catalogIds(service), ["previous-good"]);
  await observeModelPage(service, "external-refresh", null, { data: [model("external-new")], nextCursor: null });
  assert.equal(requests.length, 3);
  const controlled = service.refreshCatalog();
  requests[2].resolve({ data: [model("controlled-complete")], nextCursor: null });
  await controlled;
  await observeModelPage(service, "external-late-tail", "old-tail", { data: [model("late")], nextCursor: null });
  assert.deepEqual(catalogIds(service), ["controlled-complete"]);
  assert.equal(requests.length, 3);
});

test("passive first model page warms a cold catalog without publishing partial data", async (t) => {
  const { service, requests } = catalogFixture(t);
  await observeModelPage(service, "first", null, { data: [model("external-first")], nextCursor: "next" });
  assert.equal(requests.length, 1);
  assert.deepEqual(catalogIds(service), []);
  assert.equal(service.modelCatalog.isComplete(), false);
  const models = service.listModels();
  requests[0].resolve({ data: [model("internal-complete")], nextCursor: null });
  assert.deepEqual((await models).map((entry) => entry.id), ["internal-complete"]);
  assert.equal(requests.length, 1);
});

test("a passive response from the previous connection cannot trigger a new refresh", async (t) => {
  const { service, requests } = catalogFixture(t);
  await service.processClientMessage({ id: "old-page", method: "model/list", params: { cursor: null } });
  service.onAppServerAttached();
  const late = { id: "old-page", result: { data: [model("old")], nextCursor: null } };
  assert.equal(service.processServerMessage(late), late);
  assert.equal(requests.length, 0);
  assert.deepEqual(catalogIds(service), []);
});

test("model router metadata caches are bounded and refresh LRU order", () => {
  const cache = new Map();
  serviceTest.setBoundedMapEntry(cache, "thread-1", { revision: 1 }, 2);
  serviceTest.setBoundedMapEntry(cache, "thread-2", { revision: 2 }, 2);
  serviceTest.setBoundedMapEntry(cache, "thread-1", { revision: 3 }, 2);
  serviceTest.setBoundedMapEntry(cache, "thread-3", { revision: 4 }, 2);

  assert.deepEqual(Array.from(cache.entries()), [
    ["thread-1", { revision: 3 }],
    ["thread-3", { revision: 4 }],
  ]);
});

test("default tier criteria preserve the intended scene boundaries", () => {
  const criteria = Object.fromEntries(defaultTierDefinitions().map((tier) => [tier.id, tier.prompt]));
  assert.match(criteria.economy, /extracting explicit information from files, logs, or command output/);
  assert.match(criteria.balanced, /routine, clearly scoped engineering work/);
  assert.match(criteria.balanced, /Do not use this tier when the task requires deep diagnosis/);
  assert.match(criteria.complex, /correlating logs, tests, and source code to establish root cause/);
  assert.match(criteria.complex, /high-confidence reviews covering edge cases and failure modes/);
  assert.match(criteria.frontier, /security, data-loss, concurrency, or distributed-consistency decisions/);
  assert.match(criteria.frontier, /Do not select this tier merely because the input is long/);
});

test("resolver honors configured, tier, catalog default and nearest effort order", () => {
  const configured = resolveTierRoute({
    tier: "routine-plus",
    tiers: tiersWithCustom({ model: "custom", effort: "medium" }),
    configValues: { fallbackModel: "fallback" },
    models: [model("custom", ["low", "high"]), model("fallback"), model("catalog-default", ["medium"], true)],
  });
  assert.equal(configured.model, "custom");
  // medium 与 low/high 等距时向上选择 high。
  assert.equal(configured.effort, "high");

  const tierBuiltin = resolveTierRoute({
    tier: "balanced",
    tiers: defaultTierDefinitions(),
    configValues: { fallbackModel: "fallback" },
    models: [model("gpt-5.6-luna"), model("catalog-default", ["medium"], true), model("fallback")],
  });
  assert.equal(tierBuiltin.model, "gpt-5.6-luna");

  const customizedBuiltins = defaultTierDefinitions();
  Object.assign(customizedBuiltins[1], { model: "custom-balanced", effort: "high" });
  const configuredBuiltin = resolveTierRoute({
    tier: "balanced",
    tiers: customizedBuiltins,
    configValues: { fallbackModel: "fallback" },
    models: [model("custom-balanced", ["medium", "high"]), model("fallback")],
  });
  // 内置档位进入运行时归一化后仍须保留用户设置的模型和强度。
  assert.equal(configuredBuiltin.model, "custom-balanced");
  assert.equal(configuredBuiltin.effort, "high");

  const catalogDefault = resolveTierRoute({
    tier: "balanced",
    tiers: defaultTierDefinitions(),
    configValues: { fallbackModel: "fallback" },
    models: [model("catalog-default", ["medium"], true), model("fallback")],
  });
  assert.equal(catalogDefault.model, "catalog-default");
  assert.equal(nearestEffort("medium", model("x", ["low", "high"])), "high");

  const automatic = resolveTierRoute({
    tier: "routine-plus",
    classificationEffort: "xhigh",
    tiers: tiersWithCustom({ model: "custom", effort: "auto" }),
    configValues: { fallbackModel: "fallback" },
    models: [model("custom", ["high", "max"]), model("fallback")],
  });
  // 分类建议 xhigh 与 high/max 等距时，仍沿用既有规则向上选择 max。
  assert.equal(automatic.effort, "max");

  const automaticClassifier = resolveClassifierRoute({
    configValues: { classifierModel: "custom", classifierEffort: "auto", fallbackModel: "fallback" },
    models: [model("custom", ["high", "xhigh"]), model("fallback")],
  });
  assert.equal(automaticClassifier.effort, "high");
});

test("routing context keeps configured recent turns and excludes prior route state", () => {
  const turns = Array.from({ length: 8 }, (_value, index) => ({
    status: "completed",
    items: [
      {
        type: "userMessage",
        content: [
          { type: "text", text: `message-${index}` },
          ...(index === 7 ? [{ type: "localImage", path: "/tmp/image.png" }] : []),
        ],
      },
      { type: "agentMessage", phase: "commentary", text: `working-${index}` },
      { type: "agentMessage", phase: "final_answer", text: `done-${index}` },
    ],
  }));
  const history = recentTurnsFromTurns(turns);
  assert.deepEqual(history.map((entry) => entry.user.text), ["message-5", "message-6", "message-7"]);
  assert.deepEqual(history.map((entry) => entry.assistantFinal), ["done-5", "done-6", "done-7"]);
  assert.equal(history[2].user.hasImages, true);
  const expandedHistory = recentTurnsFromTurns(turns, 5);
  assert.deepEqual(expandedHistory.map((entry) => entry.user.text), [
    "message-3",
    "message-4",
    "message-5",
    "message-6",
    "message-7",
  ]);

  const context = createRoutingContext({
    input: [{ type: "text", text: "current" }, { type: "image", url: "data:image/png" }],
    history: expandedHistory,
    historyLimit: 3,
    // 旧调用方即使仍传这些字段，也不能让它们进入分类上下文。
    lastRoute: { tier: "balanced", model: "luna", effort: "medium" },
    previousStatus: "failed",
    usage: { total: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } },
  });
  assert.equal(context.current.imageCount, 1);
  assert.equal(context.current.text, "current");
  assert.deepEqual(context.recentTurns.map((entry) => entry.user.text), ["message-5", "message-6", "message-7"]);
  assert.deepEqual(Object.keys(context), ["current", "recentTurns"]);
  assert.equal(summarizeUserInput([{ type: "skill", name: "x" }]).skillCount, 1);
});

test("assistant final extraction excludes intermediate items and supports legacy completed turns", () => {
  const items = [
    { type: "reasoning", text: "private reasoning" },
    { type: "agentMessage", phase: "commentary", text: "progress" },
    { type: "commandExecution", command: "git status" },
    { type: "agentMessage", phase: "final_answer", text: "first final" },
    { type: "agentMessage", phase: "final_answer", text: "second final" },
  ];
  assert.equal(assistantFinalFromItems(items), "first final\n\nsecond final");
  assert.equal(
    assistantFinalFromTurn({
      status: "completed",
      items: [
        { type: "agentMessage", phase: null, text: "legacy commentary" },
        { type: "agentMessage", text: "legacy final" },
      ],
    }),
    "legacy final"
  );
  assert.equal(
    assistantFinalFromTurn({ status: "inProgress", items: [{ type: "agentMessage", text: "not confirmed" }] }),
    ""
  );

  const longFinal = `${"H".repeat(1_000)}${"T".repeat(1_000)}`;
  const truncated = assistantFinalFromItems([{ type: "agentMessage", phase: "final_answer", text: longFinal }]);
  assert.equal(truncated.length, ASSISTANT_FINAL_TEXT_LIMIT);
  assert.equal(truncated.startsWith("H"), true);
  assert.equal(truncated.endsWith("T"), true);
  assert.match(truncated, /\n…\n/);
});

test("classifier prompt composes only enabled tier names and custom criteria", () => {
  const tiers = defaultTierDefinitions();
  tiers[0].enabled = false;
  tiers.splice(1, 0, {
    id: "routine-plus",
    builtin: false,
    enabled: true,
    name: "Routine plus",
    prompt: "Prefer this tier for a bounded two-file implementation.",
    model: "custom",
    effort: "auto",
  });
  const prompt = buildClassifierPrompt(
    { current: { text: "change two files" }, recentTurns: [] },
    { tiers, automaticEffortTiers: ["routine-plus"] }
  );
  const payload = JSON.parse(prompt.split("\n\n").at(-1));
  assert.deepEqual(payload.tiers.map((tier) => tier.id), ["routine-plus", "balanced", "complex", "frontier"]);
  assert.equal(payload.tiers[0].name, "Routine plus");
  assert.match(payload.tiers[0].criteria, /bounded two-file implementation/);
  assert.deepEqual(payload.automaticEffortTiers, ["routine-plus"]);
  assert.match(prompt, /"current" is authoritative/);
  assert.match(prompt, /Do not assume that any particular tier id/);
  assert.doesNotMatch(prompt, /previousStatus|previousRoute|tokenUsage/);
});

test("classifier JSON parser enforces the stable route envelope and conditional effort", () => {
  const value = parseClassificationText('```json\n{"route":{"tier":"complex","rationale":"multi-file failure"}}\n```');
  assert.equal(value.tier, "complex");
  assert.equal("effort" in value, false);
  const automatic = parseClassificationText(
    '{"route":{"tier":"economy","effort":"medium","rationale":"bounded analysis"}}'
  );
  assert.equal(automatic.effort, "medium");
  assert.throws(
    () =>
      validateClassification({
        route: { tier: "complex", confidence: 0.9, rationale: "x" },
      }),
    /unsupported fields/
  );
  assert.throws(
    () =>
      validateClassification({
        route: { tier: "complex", effort: "high", rationale: "x" },
      }),
    /unsupported fields|forbidden/
  );
  assert.throws(() => validateClassification({ route: { tier: "economy", rationale: "x" } }), /required/);
  assert.throws(() => parseClassificationText('{"tier":"complex","rationale":"x"}'), /only route/);
  assert.throws(() => parseClassificationText("not-json"), /invalid JSON/);
});

test("auto state survives restart and clear keeps the last concrete route", (t) => {
  const filePath = tempFile(t, "state.json");
  const first = createAutoStateStore({ filePath });
  first.setDefaultAuto(true, { model: "spark", effort: "low" });
  first.setThreadAuto("thread-1", true, { model: "terra", effort: "high" });
  first.recordRoute("thread-1", { tier: "complex", model: "terra", effort: "high", fallback: true });

  // 旧状态文件即使含 lastStatus，也应在读取时直接忽略而无需迁移。
  const legacyState = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  legacyState.threads["thread-1"].lastStatus = "failed";
  fs.writeFileSync(filePath, JSON.stringify(legacyState));

  const second = createAutoStateStore({ filePath });
  assert.equal(second.isDefaultAuto(), true);
  assert.equal(second.isThreadAuto("thread-1"), true);
  assert.equal(second.threadState("thread-1").lastTier, "complex");
  assert.equal(second.threadState("thread-1").lastFallback, true);
  assert.equal("lastStatus" in second.threadState("thread-1"), false);
  second.clearAllAuto();
  assert.equal(second.isDefaultAuto(), false);
  assert.equal(second.isThreadAuto("thread-1"), false);
  assert.equal(second.threadState("thread-1").lastModel, "terra");
});

test("auto state store bounds persisted threads and prioritizes active Auto state", (t) => {
  const filePath = tempFile(t, "bounded-state.json");
  const store = createAutoStateStore({ filePath, maxThreads: 2 });
  store.setThreadAuto("auto-thread", true, { model: "luna", effort: "high" });
  store.setThreadAuto("manual-old", false, { model: "spark", effort: "low" });
  store.setThreadAuto("manual-new", false, { model: "terra", effort: "medium" });

  assert.equal(store.threadState("auto-thread")?.auto, true);
  assert.equal(store.threadState("manual-old"), null);
  assert.equal(store.threadState("manual-new")?.lastModel, "terra");
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  assert.deepEqual(Object.keys(persisted.threads).sort(), ["auto-thread", "manual-new"]);
});

test("turn route status is visible only between real turn start and termination", () => {
  const status = createTurnRouteStatus();
  status.select({
    requestKey: "string:user-turn",
    threadId: "thread-1",
    route: { tier: "balanced", model: "luna", effort: "high", fallback: false, rationale: "private" },
  });

  const started = status.processServerMessage({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
  });
  const metadata = started.params._meta[ROUTE_METADATA_KEY];
  assert.deepEqual(metadata, { tier: "balanced", model: "luna", effort: "high", fallback: false });
  assert.equal(JSON.stringify(metadata).includes("private"), false);
  assert.equal(status.activeRoute("thread-1").turnId, "turn-1");

  status.processServerMessage({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  });
  assert.equal(status.activeRoute("thread-1"), null);

  // 手动模型回合没有调度元数据，也不能沿用已结束的展示状态。
  const manual = status.processServerMessage({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } },
  });
  assert.equal(manual.params._meta, undefined);
  assert.equal(status.activeRoute("thread-1"), null);
});

test("failed external turn start cancels its pending route", () => {
  const status = createTurnRouteStatus();
  status.select({
    requestKey: "string:user-turn",
    threadId: "thread-1",
    route: { tier: "economy", model: "spark", effort: "low" },
  });
  status.processServerMessage(
    { id: "user-turn", error: { message: "rejected" } },
    { method: "turn/start", requestKey: "string:user-turn", threadId: "thread-1" }
  );
  assert.equal(status.snapshot().pendingCount, 0);
});

test("turn route status bounds pending routes and tracked threads", () => {
  const status = createTurnRouteStatus({ maxPendingRoutesPerThread: 2, maxTrackedThreads: 2 });
  for (let thread = 0; thread < 3; thread += 1) {
    for (let request = 0; request < 3; request += 1) {
      status.select({
        requestKey: `${thread}-${request}`,
        threadId: `thread-${thread}`,
        route: { tier: "balanced", model: "luna", effort: "high" },
      });
    }
  }
  assert.equal(status.snapshot().pendingThreadCount, 2);
  assert.equal(status.snapshot().pendingCount, 4);
});
