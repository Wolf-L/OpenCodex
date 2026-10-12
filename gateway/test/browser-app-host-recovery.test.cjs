const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../../web-shell/internal/providers/codex-bridge-polyfill.js"), "utf8");

function harness() {
  const sent = [], delivered = [];
  const socket = () => ({ OPEN: 1, readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } });
  const context = {
    w: { WebSocket: { OPEN: 1 }, __OpenCodexConnectionState: { state: "connected" } },
    ws: socket(), wsReady: false, appHostPortRelays: new Map(), clientId: "page",
    clientDiagnostic() {}, websocketStateName: () => "open", settleWsReadyWaiters() {},
    publishConnectionState(state) { context.w.__OpenCodexConnectionState = { state }; },
    appHostWsPayload: (state, payload) => ({ clientId: "page", portId: state.portId, ...payload }),
    APP_HOST_PENDING_MESSAGE_LIMIT: 64, APP_HOST_PENDING_MESSAGE_CHARS_LIMIT: 10000,
    decodeAppHostMessageData: m => m.data, publishAppHostData: data => data,
  };
  // 使用生产函数片段，覆盖真正的入队、握手、帧校验、MessagePort 释放和发送逻辑。
  const fragments = [
    ["  const appHostRecovery =", "  function waitForGatewayWsReady"],
    ["  function sendAppHostWsPayload", "  function sendGatewayControlPayload"],
    ["  function flushAppHostRelayMessages", "  function installAppHostMessagePortBridge"],
  ].map(([a, b]) => source.slice(source.indexOf(a), source.indexOf(b)));
  vm.createContext(context); vm.runInContext(fragments.join("\n"), context);
  const state = { portId: "rpc", pending: [], pendingChars: 0, connected: false,
    port: { postMessage(data) { delivered.push(data); }, close() { state.closedPort = true; } } };
  context.appHostPortRelays.set(state.portId, state);
  return { context, state, sent, delivered, socket, get recovery() { return vm.runInContext("appHostRecovery", context); } };
}

test("first handshake flushes one connect; resume flushes unsent RPC without reconnecting the port", () => {
  const h = harness(), c = h.context;
  c.queueAppHostRelayPayload(h.state, { type: "app-host-connect" }); assert.equal(h.sent.length, 0);
  c.acceptAppHostRecoveryHello({ version: 1, status: "new", token: "token" }); c.markGatewayWsReady();
  assert.equal(h.sent[0].sequence, 1); assert.equal(h.sent[0].payload.type, "app-host-connect");
  c.handleAppHostRecoveryMessage({ type: "opencodex:app-host-frame", sequence: 1, payload: { type: "app-host-port-connected", portId: "rpc" } });
  c.wsReady = false; h.state.connected = false;
  c.queueAppHostRelayPayload(h.state, { type: "app-host-port-message", data: "unsent" });
  c.ws = h.socket();
  assert.deepEqual(JSON.parse(JSON.stringify(c.appHostRecoveryHello())), { version: 1, token: "token", sent: 1, received: 1 });
  c.acceptAppHostRecoveryHello({ version: 1, status: "resumed", token: "token" }); c.markGatewayWsReady();
  assert.equal(h.sent.length, 2); assert.equal(h.sent[1].sequence, 2); assert.equal(h.sent[1].payload.data, "unsent");
});

test("missing session and Gateway restart stop old queue without automatic reload or resend", () => {
  const h = harness(), c = h.context;
  c.acceptAppHostRecoveryHello({ version: 1, status: "new", token: "old" });
  c.queueAppHostRelayPayload(h.state, { type: "app-host-port-message", data: "uncertain" });
  c.acceptAppHostRecoveryHello({ version: 1, status: "reset" }); c.markGatewayWsReady();
  assert.equal(h.recovery.failed, true); assert.equal(h.state.closedPort, true);
  assert.equal(h.sent.length, 0); assert.equal(h.state.pending.length, 0);
  assert.equal(c.appHostPortRelays.size, 0);
});

test("a gap or duplicate downlink is never delivered to the old RPC twice", () => {
  const h = harness(), c = h.context;
  c.acceptAppHostRecoveryHello({ version: 1, status: "new", token: "token" });
  const frame = { type: "opencodex:app-host-frame", sequence: 1, payload: { type: "app-host-port-message", portId: "rpc", data: "result" } };
  c.handleAppHostRecoveryMessage(frame); c.handleAppHostRecoveryMessage(frame);
  assert.deepEqual(h.delivered, ["result"]); assert.equal(h.recovery.failed, true);
});

test("a replacement token or protocol downgrade cannot create a new RPC for old references", () => {
  for (const reply of [undefined, { version: 1, status: "new", token: "new" }, { version: 1, status: "resumed", token: "wrong" }]) {
    const h = harness(); h.context.acceptAppHostRecoveryHello({ version: 1, status: "new", token: "old" });
    h.context.acceptAppHostRecoveryHello(reply); assert.equal(h.recovery.failed, true);
  }
});

test("send failure stops uncertain RPC instead of queueing it for another socket", () => {
  const h = harness(); h.context.acceptAppHostRecoveryHello({ version: 1, status: "new", token: "token" });
  h.context.markGatewayWsReady(); h.sent.length = 0;
  h.context.ws.send = () => { throw Error("uncertain send"); };
  h.context.queueAppHostRelayPayload(h.state, { type: "app-host-port-message", data: "mutation" });
  assert.equal(h.recovery.failed, true); assert.equal(h.state.pending.length, 0); assert.equal(h.sent.length, 0);
});

test("recovery failure releases a port already waiting to send its terminal frame", () => {
  const h = harness();
  h.context.closeAppHostRelay(h.state, "queue_overflow", true);
  assert.equal(h.state.closing, true); assert.equal(h.state.pending.length, 1);
  h.context.failAppHostRecovery();
  assert.equal(h.state.closed, true); assert.equal(h.state.pending.length, 0);
  assert.equal(h.context.appHostPortRelays.size, 0); assert.equal(h.sent.length, 0);
});
