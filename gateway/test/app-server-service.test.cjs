const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createGatewayAppServerService } = require("../runtime/app-server-service.cjs");
const { createAppServerTransport } = require("../runtime/app-server/transport.cjs");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = (message) => `${JSON.stringify(message)}\n`;
function fixture(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-owner-"));
  let creations = 0; let kills = 0;
  const owner = createGatewayAppServerService({ runtimeDir }, { createTransport(options) {
    creations += 1; return createAppServerTransport(options);
  } });
  t.after(() => {
    owner.dispose();
    // 仅清理本测试创建且已核对位于系统临时目录内的隔离配置目录。
    assert.equal(path.dirname(path.resolve(runtimeDir)), path.resolve(os.tmpdir()));
    assert.equal(path.basename(runtimeDir).startsWith("opencodex-owner-"), true);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const input = new PassThrough(); const output = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: input, stdout: output, stdio: [input, output], kill() { kills += 1; } });
  const sent = [];
  input.on("data", (chunk) => sent.push(...chunk.toString().trim().split("\n").filter(Boolean).map(JSON.parse)));
  owner.decorateAppServerChild(child);
  return { owner, child, input, output, sent, creations: () => creations, kills: () => kills };
}

test("Gateway creates one connection; Auto-off preview uses it and excludes private threads", async (t) => {
  const f = fixture(t); const router = f.owner.pluginService.modelRouter;
  const config = f.owner.pluginService.configStore;
  config.update("opencodex.smart-model-router", { enabled: false, expectedRevision: config.snapshot().revision });
  assert.equal(f.creations(), 1);
  assert.equal(router.isEnabled(), false);
  assert.equal(router.diagnostics().attached, true);
  assert.equal(router.decorateAppServerChild, undefined);
  for (const name of ["dispose", "rejectPending", "decorateChild"]) assert.equal(router.transport[name], undefined);
  router.transport.registerInternalThread("private");
  const preview = f.owner.historyPreview.snapshot({ maxWaitMs: 200 }); await tick();
  assert.equal(f.sent[0].method, "thread/list");
  f.output.write(frame({ id: f.sent[0].id, result: { data: [{ id: "public", name: "history" }, { id: "private", name: "hidden" }] } }));
  assert.deepEqual((await preview).threads.map((item) => item.id), ["public"]);
  const visible = []; f.child.stdout.on("data", (chunk) => visible.push(chunk));
  f.output.write(frame({ id: "approval", method: "approval/request", params: { threadId: "private" } }));
  assert.deepEqual(visible, []);
  assert.equal(f.sent.at(-1).error.code, -32001);
  assert.equal(f.owner.transport.isAttached(), true);
});

test("preview disposal does not reject a router request or close the shared connection", async (t) => {
  const f = fixture(t);
  const request = f.owner.pluginService.modelRouter.transport.request("model/list", {});
  f.owner.historyPreview.dispose();
  f.output.write(frame({ id: f.sent[0].id, result: { data: [] } }));
  assert.deepEqual(await request, { data: [] });
  assert.equal(f.owner.transport.isAttached(), true);
  f.owner.dispose(); f.owner.dispose(); await tick();
  assert.equal(f.owner.transport.isAttached(), false);
  assert.equal(f.kills(), 0);
  assert.equal(f.output.listenerCount("data"), 0);
});

test("router disposal preserves preview requests and connection-private filtering", async (t) => {
  const f = fixture(t); const router = f.owner.pluginService.modelRouter;
  router.transport.registerInternalThread("private");
  const cancelled = assert.rejects(router.transport.request("model/list", {}), { category: "closed" });
  const preview = f.owner.historyPreview.snapshot({ maxWaitMs: 200 }); await tick();
  router.dispose(); await cancelled;
  assert.equal(f.owner.transport.isAttached(), true);
  assert.equal(router.transport.isInternalThreadId("private"), true);
  f.output.write(frame({ id: f.sent[1].id, result: { data: [{ id: "private" }, { id: "public" }] } }));
  assert.deepEqual((await preview).threads.map((item) => item.id), ["public"]);
});

test("a completed preview response cannot expose private IDs when replacement precedes its continuation", async (t) => {
  const f = fixture(t);
  f.owner.pluginService.modelRouter.transport.registerInternalThread("private-old");
  const preview = f.owner.historyPreview.snapshot({ maxWaitMs: 200 }); await tick();
  f.output.write(frame({ id: f.sent[0].id, result: { data: [{ id: "private-old" }, { id: "public" }] } }));
  // Promise 已完成但预览还没运行 then；替换会清空旧代际登记，过滤必须已完成。
  f.owner.decorateAppServerChild(Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() }));
  assert.deepEqual((await preview).threads.map((item) => item.id), ["public"]);
});

test("queued routing work keeps its admission generation after a connection replacement", async (t) => {
  const f = fixture(t); const router = f.owner.pluginService.modelRouter;
  const events = []; router.onRouteStatus((event) => events.push(event.status));
  for (const id of ["first", "queued"]) f.child.stdin.write(frame({ id, method: "turn/start", params: { threadId: "same", model: "auto", input: [] } }));
  await tick(); assert.equal(f.sent[0].method, "model/list");
  const nextInput = new PassThrough(); const nextSent = [];
  nextInput.on("data", (chunk) => nextSent.push(chunk));
  f.owner.decorateAppServerChild(Object.assign(new EventEmitter(), { stdin: nextInput, stdout: new PassThrough() }));
  await tick();
  assert.deepEqual(nextSent, []);
  assert.equal(events.includes("selected"), false);
  assert.equal(router.diagnostics().activeRouteCount, 0);
});

test("disposing during classification cannot forward the queued turn or publish a late route", async (t) => {
  const f = fixture(t); const router = f.owner.pluginService.modelRouter;
  const events = []; router.onRouteStatus((event) => events.push(event.status));
  const classifierStarted = new Promise((resolve) => {
    f.input.on("data", (chunk) => {
      for (const raw of chunk.toString().trim().split("\n")) {
        const message = JSON.parse(raw);
        if (message.method === "model/list") f.output.write(frame({ id: message.id, result: { data: [{ id: "gpt-5.3-codex-spark", model: "gpt-5.3-codex-spark", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] } }));
        if (message.method === "thread/turns/list") f.output.write(frame({ id: message.id, result: { data: [] } }));
        if (message.method === "thread/start") resolve(message);
      }
    });
  });
  f.child.stdin.write(frame({ id: "user-turn", method: "turn/start", params: { threadId: "user-thread", model: "auto", input: [] } }));
  const privateStart = await classifierStarted;
  router.dispose();
  f.output.write(frame({ id: privateStart.id, result: { thread: { id: "late-private", ephemeral: true } } }));
  await tick();
  assert.equal(events.includes("classifying"), true);
  assert.equal(events.includes("selected"), false);
  assert.equal(f.sent.some((message) => message.id === "user-turn"), false);
  assert.equal(f.sent.some((message) => message.method === "thread/delete" && message.params.threadId === "late-private"), true);
  assert.equal(router.diagnostics().activeRouteCount, 0);
});

test("Gateway-owned connection supports normal Auto routing, private cleanup and manual models", { timeout: 3_000 }, async (t) => {
  const f = fixture(t); const visible = [];
  const responses = new Map();
  f.child.stdout.on("data", (chunk) => {
    for (const raw of chunk.toString().trim().split("\n")) {
      const message = JSON.parse(raw); visible.push(message); responses.get(message.id)?.(message);
    }
  });
  const models = ["gpt-5.3-codex-spark", "gpt-5.6-luna"].map((model, index) => ({
    id: model, model, isDefault: index === 0, defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "high", "max"].map((reasoningEffort) => ({ reasoningEffort })),
  }));
  f.input.on("data", (chunk) => {
    for (const raw of chunk.toString().trim().split("\n")) {
      const message = JSON.parse(raw); const internal = String(message.id).startsWith("opencodex.router:");
      let result = {};
      if (message.method === "model/list") result = { data: models, nextCursor: null };
      if (message.method === "thread/turns/list") result = { data: [] };
      if (internal && message.method === "thread/start") result = { thread: { id: "private-routing", ephemeral: true } };
      if (message.method === "turn/start") result = { turn: { id: internal ? "private-turn" : "public-turn" } };
      f.output.write(frame({ id: message.id, result }));
      if (internal && message.method === "turn/start") f.output.write(frame({ method: "turn/completed", params: {
        threadId: "private-routing", turn: { id: "private-turn", status: "completed", items: [
          { type: "agentMessage", text: JSON.stringify({ route: { tier: "balanced", rationale: "fixture" } }) },
        ] },
      } }));
    }
  });
  async function send(message) {
    const received = new Promise((resolve) => responses.set(message.id, resolve));
    f.child.stdin.write(frame(message));
    return received;
  }
  const catalog = await send({ id: "models", method: "model/list", params: {} });
  assert.equal(catalog.result.data[0].model, "auto");
  await send({ id: "auto-turn", method: "turn/start", params: { threadId: "public", model: "auto", input: [] } });
  const routed = f.sent.find((message) => message.id === "auto-turn");
  assert.equal(routed.params.model, "gpt-5.6-luna");
  assert.equal(routed.params.effort, "max");
  await tick();
  assert.equal(f.sent.some((message) => message.method === "thread/delete"), true);
  const starts = f.sent.filter((message) => message.method === "thread/start").length;
  await send({ id: "manual-turn", method: "turn/start", params: { threadId: "manual", model: "gpt-5.3-codex-spark", effort: "low", input: [] } });
  assert.equal(f.sent.filter((message) => message.method === "thread/start").length, starts);
  assert.equal(visible.some((message) => String(message.id).startsWith("opencodex.router:")), false);
  assert.equal(JSON.stringify(visible).includes("private-routing"), false);
  assert.equal(f.creations(), 1);
});

function fakeRouter() {
  return { processClientMessage: (value) => value, processServerMessage: (value) => value, onAppServerAttached() {}, onAppServerClosed() {} };
}

test("owner cleanup is ordered, idempotent and continues past consumer errors", () => {
  const events = []; let routerClient; let previewClient;
  const owner = createGatewayAppServerService({}, {
    createTransport(options) {
      const transport = createAppServerTransport(options); const dispose = transport.dispose;
      return { ...transport, dispose(error) { events.push("transport"); dispose(error); } };
    },
    createPlugins(options) {
      routerClient = options.transport;
      return { modelRouter: fakeRouter(), dispose() { events.push("plugins"); throw new Error("fixture cleanup"); } };
    },
    createPreview(options) {
      previewClient = options.transport;
      assert.deepEqual(Object.keys(previewClient).sort(), ["isAttached", "request"]);
      return { dispose() { events.push("preview"); throw new Error("fixture cleanup"); } };
    },
  });
  owner.dispose(); owner.dispose();
  assert.deepEqual(events, ["preview", "plugins", "transport"]);
  assert.equal(routerClient.isAttached(), false);
  assert.equal(previewClient.isAttached(), false);
});

for (const stage of ["plugins", "preview"]) {
  test(`construction failure at ${stage} retires prior resources and retains the original error`, () => {
    const events = []; const failure = new Error("construction failed");
    assert.throws(() => createGatewayAppServerService({}, {
      createTransport(options) {
        const transport = createAppServerTransport(options); const dispose = transport.dispose;
        return { ...transport, dispose(error) { events.push("transport"); dispose(error); } };
      },
      createPlugins() {
        if (stage === "plugins") throw failure;
        return { modelRouter: fakeRouter(), dispose() { events.push("plugins"); } };
      },
      createPreview() { throw failure; },
    }), (error) => error === failure);
    assert.deepEqual(events, stage === "plugins" ? ["transport"] : ["plugins", "transport"]);
  });
}

const serverSource = fs.readFileSync(path.join(__dirname, "../runtime/server.cjs"), "utf8");
function gatewayHarness(failureStage) {
  const events = []; const failure = new Error(`startup ${failureStage}`);
  const owner = {
    historyPreview: { warm() { events.push("warm"); } },
    pluginService: { bindSmartSchedulingPresentation() {} },
    decorateAppServerChild() {}, dispose() { events.push("owner-dispose"); },
  };
  const server = { close() { events.push("server-close"); } };
  const context = {
    path, REPORTS_DIR: "/reports", PROJECT_ROOT: "/root", UNKNOWN_IPC_PATH: "/root/ipc", HOST: "127.0.0.1", PORT: 3737,
    ensureDir() {}, diagnosticWarn() {}, diagnosticLog() {},
    createGatewayCompatibilityService: () => ({ persistNow() { events.push("persist"); }, dispose() { events.push("compat-dispose"); } }),
    createGatewayAppServerService() { events.push("owner-created"); return owner; },
    async startOfficialRuntime(options) {
      assert.equal(options.decorateAppServerChild, owner.decorateAppServerChild);
      events.push("runtime"); if (failureStage === "runtime") throw failure;
    },
    getOfficialBundle() {}, getI18nSnapshot() {}, createWorkspaceRootsService: () => ({ workspaceRoots() {} }),
    createLocalFileService() { if (failureStage === "files") throw failure; return { dispose() { events.push("local-dispose"); } }; },
    createPickedFilesService: () => ({ dispose() { events.push("picked-dispose"); } }),
    createStaticAssetService: () => ({ async prewarmRendererAssets() {} }),
    createRequestHandler: () => () => {}, http: { createServer: () => server },
    createWsHub: () => ({}), createOfficialAppHostRelay() {}, handleOfficialNotificationEvent() {}, isAuthed() {}, setWsHub() {},
    installShutdownHandlers(...args) {
      assert.equal(args[3], owner);
      return { requestRestart() {}, removeHandlers() { events.push("remove-handlers"); } };
    },
    async listen() { if (failureStage === "listen") throw failure; },
  };
  const start = serverSource.indexOf("async function createGateway()");
  const end = serverSource.indexOf("\nmodule.exports =", start);
  vm.runInNewContext(serverSource.slice(start, end), context);
  return { context, events, failure, owner };
}

for (const stage of ["runtime", "files", "listen"]) {
  test(`production Gateway ${stage} failure releases the owner and persists diagnostics`, async () => {
    const f = gatewayHarness(stage);
    await assert.rejects(f.context.createGateway(), (error) => error === f.failure);
    assert.equal(f.events.filter((event) => event === "owner-dispose").length, 1);
    assert.ok(f.events.indexOf("owner-created") < f.events.indexOf("runtime"));
    assert.ok(f.events.indexOf("owner-dispose") < f.events.indexOf("persist"));
    if (stage === "listen") assert.ok(f.events.includes("remove-handlers"));
  });
}

test("successful Gateway exposes the same owner and preview used by bootstrap", async () => {
  const f = gatewayHarness(); const gateway = await f.context.createGateway();
  assert.equal(gateway.appServerService, f.owner);
  assert.equal(gateway.historyPreview, f.owner.historyPreview);
  assert.equal(f.events.includes("owner-dispose"), false);
  assert.equal(serverSource.includes("pluginService.modelRouter.transport"), false);
});

test("shutdown delegates once to owner and removes only its signal listeners", () => {
  const events = []; const process = new EventEmitter(); const app = new EventEmitter();
  const external = () => {}; process.on("SIGINT", external); app.on("before-quit", external);
  const start = serverSource.indexOf("function installShutdownHandlers(");
  const end = serverSource.indexOf("\nasync function listen(", start);
  const context = { process, app, setImmediate, setTimeout, GATEWAY_RESTART_EXIT_CODE: 77,
    rejectPendingInternalResponses() { events.push("ipc"); }, markGatewaySilentQuit() {} };
  vm.runInNewContext(serverSource.slice(start, end), context);
  const controller = context.installShutdownHandlers(
    { close(callback) { events.push("server"); callback(); } },
    { dispose() { events.push("local"); } }, { dispose() { events.push("picked"); } },
    { dispose() { events.push("owner"); } }, { dispose() { events.push("compat"); } }, new Set()
  );
  app.emit("before-quit"); app.emit("before-quit"); controller.removeHandlers();
  assert.deepEqual(events, ["local", "picked", "owner", "compat", "ipc", "server"]);
  assert.deepEqual(process.listeners("SIGINT"), [external]);
  assert.deepEqual(app.listeners("before-quit"), [external]);
  assert.equal(process.listenerCount("SIGTERM"), 0);
  assert.equal(controller.requestRestart(), false);
});
