const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../../web-shell/internal/providers/codex-bridge-polyfill.js"), "utf8");

function harness({ online = true, hidden = false, realAppHost = false, authFetch = false } = {}) {
  const timers = new Map(), events = new Map(), disposers = new Set(), sockets = [], rejected = [], authRequests = [];
  let now = 0, timerId = 0, active = true;
  const scheduler = {
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() { this.readyState = 0; this.listeners = new Map(); this.sent = []; sockets.push(this); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    send(raw) { if (this.sendError) throw Error("send failed"); this.sent.push(JSON.parse(raw)); }
    // 不自动触发 close，覆盖浏览器半开连接迟迟不返回 close 的路径。
    close() { this.readyState = 3; }
    emit(type, event = {}) { if (type === "open") this.readyState = 1; this.listeners.get(type)?.(event); }
    ack(heartbeat = true, appHostRecovery) { this.emit("message", { data: JSON.stringify({ type: "hello-ack", clientId: "test", heartbeat, appHostRecovery }) }); }
  }
  const w = { WebSocket: Socket, AbortController, dispatchEvent() {} };
  // 让测试按需控制 HTTP 与响应体的完成顺序，覆盖真实浏览器会出现的迟到和挂起响应。
  if (authFetch) w.fetch = (url, options) => new Promise((resolve, reject) => authRequests.push({ url, options, resolve, reject }));
  const context = {
    w, WebSocket: Socket, ws: null, wsReady: false, scheduler,
    appHostRecovery: { enabled: true, failed: false }, appHostRecoveryHello: () => ({ version: 1 }),
    acceptAppHostRecoveryHello() {}, handleAppHostRecoveryMessage: () => false, failAppHostRecovery() {},
    navigator: { onLine: online }, document: { visibilityState: hidden ? "hidden" : "visible" },
    cfg: { gatewayWsUrl: "ws://fixture" }, clientId: "test",
    reconnectTimer: null, reconnectDelay: 500, reconnectDeferredUntilVisible: false,
    gatewayWebSocketUrl: () => "ws://fixture", clientDiagnostic() {}, websocketStateName: () => "fixture",
    appHostPortRelays: new Map([["relay", { connected: true }]]),
    rejectPendingGatewayIpc(error, socket) { rejected.push(socket); }, settleWsReadyWaiters() {},
    markGatewayWsReady() { context.wsReady = true; },
    emitSharedObjectSnapshotValue() {}, STATSIG_DEFAULT_FEATURES_CONFIG: "fixture", WS_DEBUG_ENABLED: false,
    modificationScope: {
      active: () => active,
      own(fn) { const dispose = () => { if (disposers.delete(dispose)) fn(); }; disposers.add(dispose); return dispose; },
    },
    adapterHost: { events: { observe({ type, callback }) { events.set(type, callback); } } },
    activeBrowserFilePickerCancel: null, closeAppHostRelay() {}, activeBrowserNotifications: new Map(),
    listeners: new Map(), authStatusCallbacks: new Set(), terminalMessageQueues: new Map(),
    terminalMessageQueueDepths: new Map(), terminalMessagePendingCount: 0,
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } }, console, Headers,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("  function gatewayAuthToken()"), source.indexOf("  function gatewayWebSocketUrl()")), context);
  let port = null;
  if (realAppHost) {
    // 组合生产恢复逻辑与连接状态机，避免预设 enabled=true 掩盖首次握手失败。
    for (const name of ["appHostRecovery", "appHostRecoveryHello", "acceptAppHostRecoveryHello", "handleAppHostRecoveryMessage", "failAppHostRecovery", "markGatewayWsReady", "closeAppHostRelay"]) delete context[name];
    context.appHostPortRelays.clear();
    Object.assign(context, {
      APP_HOST_PENDING_MESSAGE_LIMIT: 64, APP_HOST_PENDING_MESSAGE_CHARS_LIMIT: 10000,
      appHostWsPayload: (state, payload) => ({ clientId: "test", portId: state.portId, ...payload }),
      decodeAppHostMessageData: message => message.data, publishAppHostData: data => data,
    });
    const fragments = [
      ["  const appHostRecovery =", "  function waitForGatewayWsReady"],
      ["  function sendAppHostWsPayload", "  function sendGatewayControlPayload"],
      ["  function flushAppHostRelayMessages", "  function installAppHostMessagePortBridge"],
    ].map(([start, end]) => source.slice(source.indexOf(start), source.indexOf(end)));
    vm.runInContext(fragments.join("\n"), context);
    port = { portId: "rpc", connected: false, pending: [], pendingChars: 0,
      port: { postMessage() {}, close() { port.closedPort = true; } } };
    context.appHostPortRelays.set("rpc", port);
  }
  // 执行完整的生产连接/事件注册段，而不是另写一个测试用状态机。
  vm.runInContext(source.slice(source.indexOf("  let stopSocketMonitoring"), source.lastIndexOf("})();")), context);
  return {
    context, sockets, rejected, timers, events, port, authRequests,
    get recovery() { return realAppHost ? vm.runInContext("appHostRecovery", context) : context.appHostRecovery; },
    get state() { return w.__OpenCodexConnectionState.state; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = end;
    },
    event(type) { events.get(type)?.(); },
    dispose() { active = false; for (const fn of [...disposers].reverse()) fn(); },
  };
}

test("TCP open is not readiness; missing hello ack times out and backs off", () => {
  const h = harness(), first = h.sockets[0];
  first.emit("open");
  assert.equal(h.state, "connecting");
  h.advance(12_000);
  assert.equal(first.readyState, 3);
  assert.equal(h.state, "reconnecting");
  assert.equal(h.context.appHostPortRelays.get("relay").connected, false);
  h.advance(375);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.context.reconnectDelay, 1000);
});

test("stale ack, close and error cannot modify a replacement connection", () => {
  const h = harness(), old = h.sockets[0];
  h.advance(12_375);
  const current = h.sockets[1]; current.emit("open"); current.ack();
  old.ack(); old.emit("close"); old.emit("error");
  assert.equal(h.context.ws, current);
  assert.equal(h.state, "connected");
  assert.equal(h.rejected.length, 1);
});

test("short ready cycles retain backoff; only stable readiness resets it", () => {
  const h = harness();
  h.sockets[0].emit("close"); h.advance(375);
  const socket = h.sockets[1]; socket.emit("open"); socket.ack();
  assert.equal(h.context.reconnectDelay, 1000);
  h.advance(9999); assert.equal(h.context.reconnectDelay, 1000);
  h.advance(1); assert.equal(h.context.reconnectDelay, 500);
});

test("heartbeat detects a silent half-open connection without replaying business writes", () => {
  const h = harness(), socket = h.sockets[0]; socket.emit("open"); socket.ack();
  h.advance(20_000);
  assert.equal(socket.sent.at(-1).type, "opencodex-ping");
  socket.emit("message", { data: JSON.stringify({ type: "opencodex-pong", sequence: 999 }) });
  h.advance(10_000);
  assert.equal(h.state, "reconnecting");
  assert.deepEqual(socket.sent.map((item) => item.type), ["hello", "opencodex-ping"]);
});

test("matching pong keeps connection alive and schedules the next probe", () => {
  const h = harness(), socket = h.sockets[0]; socket.emit("open"); socket.ack(); h.advance(20_000);
  socket.emit("message", { data: JSON.stringify({ type: "opencodex-pong", sequence: 1 }) });
  h.advance(19_999); assert.equal(h.state, "connected");
  h.advance(1); assert.equal(socket.sent.at(-1).sequence, 2);
});

test("older gateway without heartbeat capability is not disconnected for missing pong", () => {
  const h = harness(), socket = h.sockets[0]; socket.emit("open"); socket.ack(false);
  h.advance(120_000); assert.equal(h.state, "connected"); assert.equal(socket.sent.length, 1);
});

test("background suspends heartbeat deadlines and foreground probes anew", () => {
  const h = harness(), socket = h.sockets[0]; socket.emit("open"); socket.ack(); h.advance(20_000);
  h.context.document.visibilityState = "hidden"; h.event("visibilitychange"); h.advance(120_000);
  assert.equal(h.state, "connected");
  h.context.document.visibilityState = "visible"; h.event("visibilitychange");
  assert.equal(socket.sent.at(-1).sequence, 2);
  h.advance(10_000); assert.equal(h.state, "reconnecting");
});

test("offline pauses retry but explicit retry still allows LAN; online wakes a retry", () => {
  const h = harness();
  h.context.navigator.onLine = false; h.event("offline"); h.sockets[0].emit("close");
  assert.equal(h.state, "offline"); h.advance(60_000); assert.equal(h.sockets.length, 1);
  h.event("opencodex:retry-connection"); assert.equal(h.sockets.length, 2);
  h.sockets[1].emit("close"); h.context.navigator.onLine = true; h.event("online");
  assert.equal(h.sockets.length, 3);
});

test("hidden retry resumes once; disposal cancels every timer and ignores late events", () => {
  const h = harness({ hidden: true }); h.sockets[0].emit("close");
  assert.equal(h.state, "paused"); h.advance(60_000); assert.equal(h.sockets.length, 1);
  h.context.document.visibilityState = "visible"; h.event("visibilitychange"); h.event("visibilitychange");
  h.advance(375); assert.equal(h.sockets.length, 2);
  h.dispose(); assert.equal(h.timers.size, 0);
  h.sockets[1].emit("close"); h.event("online"); h.advance(60_000);
  assert.equal(h.sockets.length, 2);
});

test("send failure retires a socket even without a browser close event", () => {
  const h = harness(); h.sockets[0].sendError = true; h.sockets[0].emit("open");
  assert.equal(h.state, "reconnecting"); assert.equal(h.context.ws, null);
});

test("jittered retry is bounded and never schedules a second timer for an active socket", () => {
  const h = harness();
  for (let i = 0; i < 12; i++) {
    h.sockets.at(-1).emit("close");
    const delay = h.context.w.__OpenCodexConnectionState.retryInMs;
    assert.ok(delay >= 250 && delay <= 30_000);
    h.advance(delay);
  }
  assert.equal(h.context.reconnectDelay, 30_000);
  h.sockets.at(-1).emit("open"); h.sockets.at(-1).ack();
  h.context.reconnectDeferredUntilVisible = true; h.event("visibilitychange");
  assert.equal(h.state, "connected");
});

test("foreground re-arms a handshake whose deadline elapsed in background", () => {
  const h = harness({ hidden: true }); h.advance(60_000);
  assert.equal(h.sockets.length, 1);
  h.context.document.visibilityState = "visible"; h.event("visibilitychange"); h.advance(12_000);
  assert.equal(h.state, "reconnecting");
});

test("hiding a scheduled retry publishes paused and resumes only one attempt", () => {
  const h = harness(); h.sockets[0].emit("close");
  h.context.document.visibilityState = "hidden"; h.event("visibilitychange");
  assert.equal(h.state, "paused"); assert.equal(h.context.reconnectTimer, null);
  h.advance(60_000); assert.equal(h.sockets.length, 1);
  h.context.document.visibilityState = "visible"; h.event("visibilitychange"); h.event("pageshow"); h.event("resume");
  h.advance(375); assert.equal(h.sockets.length, 2);
});

test("repeated manual retries cannot extend an outstanding hello deadline", () => {
  const h = harness();
  h.advance(11_000); h.event("opencodex:retry-connection");
  h.advance(999); h.event("opencodex:retry-connection");
  h.advance(1); assert.equal(h.state, "reconnecting");
  h.advance(375); assert.equal(h.sockets.length, 2);
});

test("duplicate wake events do not replace a pending heartbeat or extend its deadline", () => {
  const h = harness(), socket = h.sockets[0]; socket.emit("open"); socket.ack(); h.advance(20_000);
  h.advance(9_000);
  for (const type of ["focus", "pageshow", "resume", "visibilitychange", "opencodex:retry-connection"]) h.event(type);
  assert.equal(socket.sent.filter((frame) => frame.type === "opencodex-ping").length, 1);
  h.advance(1000); assert.equal(h.state, "reconnecting");
});

for (const wake of ["pageshow", "resume", "focus"]) {
  test(`${wake} probes a silently dead socket without requiring visibilitychange`, () => {
    const h = harness(), socket = h.sockets[0]; socket.emit("open"); socket.ack();
    h.event(wake);
    assert.equal(socket.sent.at(-1).type, "opencodex-ping");
    h.advance(10_000); assert.equal(h.state, "reconnecting");
    h.advance(375); const current = h.sockets[1]; current.emit("open"); current.ack();
    socket.ack(); socket.emit("close");
    assert.equal(h.state, "connected"); assert.equal(h.context.ws, current);
    assert.deepEqual(current.sent.map((frame) => frame.type), ["hello"]);
  });
}

test("pagehide suspends deadlines until pageshow and preserves the socket", () => {
  const h = harness(), socket = h.sockets[0]; socket.emit("open"); socket.ack(); h.advance(20_000);
  h.event("pagehide"); h.advance(120_000);
  assert.equal(h.state, "connected"); assert.equal(h.context.ws, socket);
  h.event("pageshow"); assert.equal(socket.sent.at(-1).sequence, 2);
  h.advance(10_000); assert.equal(h.state, "reconnecting");
});

test("online during page suspension waits for pageshow before retrying", () => {
  const h = harness(); h.event("pagehide"); h.sockets[0].emit("close"); h.event("online");
  h.advance(60_000); assert.equal(h.sockets.length, 1); assert.equal(h.state, "paused");
  h.event("pageshow"); h.advance(375); assert.equal(h.sockets.length, 2);
});

test("wake retires CLOSING sockets even if close never arrives", () => {
  const h = harness(), socket = h.sockets[0]; socket.emit("open"); socket.ack();
  socket.readyState = 2; h.event("focus");
  assert.equal(h.state, "reconnecting"); h.advance(375); assert.equal(h.sockets.length, 2);
});

test("hidden/offline wake does not connect and disposed wake does not leave timers", () => {
  const h = harness({ hidden: true }); h.sockets[0].emit("close");
  for (const type of ["pageshow", "resume", "focus"]) h.event(type);
  h.advance(60_000); assert.equal(h.sockets.length, 1);
  h.context.document.visibilityState = "visible"; h.context.navigator.onLine = false;
  h.event("pageshow"); assert.equal(h.state, "offline");
  h.dispose();
  for (const type of ["pageshow", "resume", "focus", "visibilitychange", "opencodex:retry-connection"]) h.event(type);
  assert.equal(h.timers.size, 0);
});

for (const failure of ["connect-timeout", "hello-timeout", "hello-send-error", "early-close"]) {
  test(`initial ${failure} preserves unsent RPC for the next successful handshake`, () => {
    const h = harness({ realAppHost: true }), first = h.sockets[0];
    h.context.queueAppHostRelayPayload(h.port, { type: "app-host-connect" });
    h.context.queueAppHostRelayPayload(h.port, { type: "app-host-port-message", data: "first-request" });
    if (failure === "hello-send-error") { first.sendError = true; first.emit("open"); }
    else if (failure === "early-close") first.emit("close");
    else {
      if (failure === "hello-timeout") first.emit("open");
      h.advance(12_000);
    }
    assert.equal(h.recovery.failed, false);
    assert.equal(h.port.closedPort, undefined);
    assert.equal(h.port.pending.length, 2);
    h.advance(375);
    const next = h.sockets[1]; next.emit("open"); next.ack(true, { version: 1, status: "new", token: "new-session" });
    assert.equal(h.state, "connected");
    assert.equal(h.context.w.__OpenCodexConnectionState.appHostState, "ready");
    assert.deepEqual(next.sent.map(frame => frame.type), ["hello", "opencodex:app-host-frame", "opencodex:app-host-frame"]);
    assert.deepEqual(next.sent.slice(1).map(frame => frame.sequence), [1, 2]);
    assert.equal(next.sent[2].payload.data, "first-request");
    assert.equal(h.port.pending.length, 0);
    first.ack(true, { version: 1, status: "new", token: "stale-session" }); first.emit("close");
    assert.equal(h.recovery.token, "new-session");
    h.dispose();
  });
}

test("disconnect after a successful legacy handshake still requires reload without replay", () => {
  const h = harness({ realAppHost: true }), first = h.sockets[0];
  h.context.queueAppHostRelayPayload(h.port, { type: "app-host-connect" });
  h.context.queueAppHostRelayPayload(h.port, { type: "app-host-port-message", data: "already-sent" });
  first.emit("open"); first.ack();
  assert.deepEqual(first.sent.map(frame => frame.type), ["hello", "app-host-connect", "app-host-port-message"]);
  first.emit("close");
  assert.equal(h.recovery.failed, true); assert.equal(h.port.closedPort, true);
  h.advance(375); const next = h.sockets[1]; next.emit("open"); next.ack(true, { version: 1, status: "new", token: "replacement" });
  assert.equal(h.context.w.__OpenCodexConnectionState.appHostState, "reload-required");
  assert.deepEqual(next.sent.map(frame => frame.type), ["hello"]);
  h.dispose();
});

test("a later successful WebSocket handshake cannot clear an explicit application RPC failure", () => {
  const h = harness({ realAppHost: true }), first = h.sockets[0];
  first.emit("open"); first.ack(true, { version: 1, status: "new", token: "same-session" });
  // 通过真实 WS 消息分发触发故障，避免只测状态发布函数而漏掉握手覆盖。
  first.emit("message", { data: JSON.stringify({ type: "opencodex:app-host-frame", sequence: 1,
    payload: { type: "app-host-port-error", portId: "rpc", error: "official relay failed" } }) });
  assert.equal(h.context.wsReady, true);
  assert.equal(h.context.w.__OpenCodexConnectionState.appHostState, "reload-required");
  assert.equal(h.port.closedPort, true); assert.equal(h.context.appHostPortRelays.size, 0);

  first.emit("close"); h.advance(375);
  const next = h.sockets[1]; next.emit("open");
  next.ack(true, { version: 1, status: "resumed", token: "same-session" });
  assert.equal(h.state, "connected");
  assert.equal(h.context.w.__OpenCodexConnectionState.appHostState, "reload-required");
  assert.deepEqual(next.sent.map(frame => frame.type), ["hello"]);
  h.dispose(); assert.equal(h.timers.size, 0);
});

const expiredAuth = { ok: true, authRequired: true, authenticated: false };
const loggedInAuth = { ok: true, authRequired: true, authenticated: true };
// VM 与宿主 Promise 的跨上下文接续全部完成后再断言，不推进虚拟连接时钟。
const flushAuth = () => new Promise(resolve => setImmediate(resolve));
function answerAuth(request, body, ok = true) { request.resolve({ ok, json: async () => body }); }

test("confirmed expired login stops blind retries without replaying business messages", async () => {
  const h = harness({ authFetch: true }), socket = h.sockets[0];
  h.context.w.__OPEN_CODEX_RUNTIME_AUTH_TOKEN__ = "fixture-token";
  socket.emit("open"); socket.ack(); socket.emit("error"); socket.emit("close"); socket.emit("error");
  assert.equal(h.authRequests.length, 1);
  const request = h.authRequests[0];
  assert.equal(request.url, "/api/auth/status"); assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "same-origin"); assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.get("authorization"), "Bearer fixture-token");
  assert.equal(request.options.headers.get("x-codex-web-token"), "fixture-token");
  answerAuth(request, expiredAuth); await flushAuth();
  assert.equal(h.state, "auth-required"); assert.equal(h.timers.size, 0);
  for (const type of ["online", "offline", "focus", "pageshow", "resume", "visibilitychange"]) h.event(type);
  h.advance(120_000);
  assert.equal(h.state, "auth-required"); assert.equal(h.sockets.length, 1); assert.equal(h.authRequests.length, 1);
  assert.deepEqual(socket.sent.map(frame => frame.type), ["hello"]);
  h.dispose();
});

test("unexpected HTTP, body and network errors remain ordinary backoff failures", async () => {
  // 必须三个布尔字段都严格匹配；不能把 401、代理 HTML 或超时本身当作登录失效证据。
  const cases = [
    request => answerAuth(request, expiredAuth, false),
    request => answerAuth(request, null),
    request => answerAuth(request, "unauthorized"),
    request => answerAuth(request, { ...expiredAuth, ok: "true" }),
    request => answerAuth(request, { ...expiredAuth, authRequired: "true" }),
    request => answerAuth(request, { ok: true, authRequired: true }),
    request => answerAuth(request, loggedInAuth),
    request => answerAuth(request, { ...expiredAuth, authRequired: false }),
    request => request.resolve({ ok: true, json: async () => { throw Error("not JSON"); } }),
    request => request.reject(Error("network down")),
  ];
  for (const complete of cases) {
    const h = harness({ authFetch: true }); h.sockets[0].emit("close");
    complete(h.authRequests[0]); await flushAuth();
    assert.equal(h.state, "reconnecting"); assert.equal(h.context.w.__OpenCodexConnectionState.retryInMs, 375);
    h.advance(375); assert.equal(h.sockets.length, 2); h.dispose();
  }
});

test("stale auth success and failure cannot override a new connecting or ready socket", async () => {
  for (const ready of [false, true]) for (const reject of [false, true]) {
    const h = harness({ authFetch: true }), old = h.sockets[0]; old.emit("close");
    const request = h.authRequests[0];
    h.advance(375); const current = h.sockets[1];
    assert.equal(request.options.signal.aborted, true);
    if (ready) { current.emit("open"); current.ack(); }
    if (reject) request.reject(Error("late failure")); else answerAuth(request, expiredAuth);
    await flushAuth(); old.emit("close"); old.emit("error");
    assert.equal(h.context.ws, current); assert.equal(h.state, ready ? "connected" : "connecting");
    assert.equal(h.authRequests.length, 1); h.dispose();
  }
});

test("auth probe disposal aborts its deadline and ignores late response body completion", async () => {
  const h = harness({ authFetch: true }); h.sockets[0].emit("close");
  let resolveBody;
  h.authRequests[0].resolve({ ok: true, json: () => new Promise(resolve => { resolveBody = resolve; }) });
  await flushAuth(); h.dispose();
  assert.equal(h.timers.size, 0); assert.equal(h.authRequests[0].options.signal.aborted, true);
  resolveBody(expiredAuth); await flushAuth();
  assert.equal(h.state, "reconnecting"); assert.equal(h.sockets.length, 1); assert.equal(h.timers.size, 0);
});

test("auth probe deadline includes a stalled response body and never infers expiry from timeout", async () => {
  const h = harness({ online: false, authFetch: true }); h.sockets[0].emit("close");
  let resolveBody;
  h.authRequests[0].resolve({ ok: true, json: () => new Promise(resolve => { resolveBody = resolve; }) });
  await flushAuth(); h.advance(4_999); assert.equal(h.authRequests[0].options.signal.aborted, false);
  h.advance(1); assert.equal(h.authRequests[0].options.signal.aborted, true); assert.equal(h.timers.size, 0);
  resolveBody(expiredAuth); await flushAuth(); assert.equal(h.state, "offline");
  h.dispose();
});

test("manual retry deduplicates auth rechecks and accepts a newly logged-in status without replay", async () => {
  const h = harness({ authFetch: true }); h.sockets[0].emit("close");
  answerAuth(h.authRequests[0], expiredAuth); await flushAuth();
  for (let i = 0; i < 4; i++) h.event("opencodex:retry-connection");
  assert.equal(h.authRequests.length, 2); assert.equal(h.sockets.length, 1);
  answerAuth(h.authRequests[1], expiredAuth); await flushAuth();
  assert.equal(h.state, "auth-required"); assert.equal(h.timers.size, 0);
  h.event("opencodex:retry-connection"); answerAuth(h.authRequests[2], loggedInAuth); await flushAuth();
  assert.equal(h.sockets.length, 2); const current = h.sockets[1]; current.emit("open"); current.ack();
  assert.equal(h.state, "connected"); assert.deepEqual(current.sent.map(frame => frame.type), ["hello"]);
  h.dispose();
});

test("manual auth recheck timeout allows a LAN attempt but late expiry cannot replace it", async () => {
  const h = harness({ online: false, authFetch: true }); h.sockets[0].emit("close");
  answerAuth(h.authRequests[0], expiredAuth); await flushAuth(); h.event("opencodex:retry-connection");
  const request = h.authRequests[1]; h.advance(5_000);
  assert.equal(request.options.signal.aborted, true); assert.equal(h.sockets.length, 2);
  request.reject(Error("late abort")); await flushAuth(); assert.equal(h.state, "connecting"); h.dispose();
});
