const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../../web-shell/internal/providers/codex-bridge-polyfill.js"), "utf8");

function harness({ online = true, hidden = false } = {}) {
  const timers = new Map(), events = new Map(), disposers = new Set(), sockets = [], rejected = [];
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
    ack(heartbeat = true) { this.emit("message", { data: JSON.stringify({ type: "hello-ack", clientId: "test", heartbeat }) }); }
  }
  const w = { WebSocket: Socket, dispatchEvent() {} };
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
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } }, console,
  };
  // 执行完整的生产连接/事件注册段，而不是另写一个测试用状态机。
  vm.runInNewContext(source.slice(source.indexOf("  let stopSocketMonitoring"), source.lastIndexOf("})();")), context);
  return {
    context, sockets, rejected, timers, events,
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
