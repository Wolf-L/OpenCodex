const assert = require("node:assert/strict");
const test = require("node:test");
const { createAppHostRecovery } = require("../runtime/ipc/app-host-recovery.cjs");

function harness(options = {}) {
  const sent = [], closed = [], timers = new Map(); let nextTimer = 0, nextToken = 0;
  const manager = createAppHostRecovery({
    send(ws, frame) { sent.push({ ws, frame }); return !ws.failSend; },
    closeSession(session, reason) { closed.push({ session, reason }); session.ports.clear(); },
    randomToken: () => `token-${++nextToken}`,
    setTimer(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); }, ...options,
  });
  const socket = () => ({ readyState: 1, OPEN: 1 });
  const first = socket(); const hello = manager.negotiate(first, "page", "auth", { version: 1 });
  const resume = (ws, changes = {}) => manager.negotiate(ws, "page", "auth", {
    version: 1, token: hello.token, sent: 0, received: 0, ...changes,
  });
  return { manager, first, hello, resume, socket, sent, closed, timers };
}

test("resumes the same RPC object table and never retransmits already-sent frames", () => {
  const h = harness(), table = new Map([[7, { value: "original" }]]);
  h.manager.session(h.first).ports.set("rpc", table);
  assert.equal(h.manager.accept(h.first, 1), true);
  h.manager.send(h.first, { type: "app-host-port-message", data: "result" });
  h.manager.detach(h.first);
  const next = h.socket(); const ack = h.resume(next, { sent: 1, received: 1 });
  assert.equal(ack.status, "resumed"); assert.equal(h.manager.session(next).ports.get("rpc"), table);
  h.manager.flush(next); assert.equal(h.sent.length, 1);
  assert.equal(h.manager.accept(h.first, 2), false);
  h.manager.detach(h.first); assert.equal(h.manager.session(next).ws, next);
  assert.equal(h.manager.accept(next, 2), true);
  assert.equal(h.timers.size, 0);
});

test("only unsent offline downlink is buffered and flushed in sequence after handshake", () => {
  const h = harness(); h.manager.detach(h.first);
  h.manager.send(h.first, { data: "one" }); h.manager.send(h.first, { data: "two" });
  assert.equal(h.sent.length, 0);
  const next = h.socket(); assert.equal(h.resume(next).status, "resumed");
  assert.equal(h.sent.length, 0); h.manager.flush(next);
  assert.deepEqual(h.sent.map(x => [x.frame.sequence, x.frame.payload.data]), [[1, "one"], [2, "two"]]);
});

for (const direction of ["sent", "received"]) {
  test(`a ${direction} gap ends recovery without creating a replacement RPC`, () => {
    const h = harness(); h.manager.detach(h.first);
    assert.equal(h.resume(h.socket(), { [direction]: 1 }).status, "reset");
    assert.equal(h.closed.length, 1); assert.equal(h.timers.size, 0);
  });
}

test("wrong page or authentication cannot take over a retained session", () => {
  const h = harness(); h.manager.detach(h.first);
  const request = { version: 1, token: h.hello.token, sent: 0, received: 0 };
  assert.equal(h.manager.negotiate(h.socket(), "other", "auth", request).status, "reset");
  assert.equal(h.manager.negotiate(h.socket(), "page", "other", request).status, "reset");
  assert.equal(h.closed.length, 0); assert.equal(h.resume(h.socket()).status, "resumed");
});

test("expiry, queue limits and shutdown release retained ports and timers", () => {
  const h = harness({ maxFrames: 1 }); h.manager.detach(h.first);
  h.manager.send(h.first, { data: "one" }); h.manager.send(h.first, { data: "two" });
  assert.equal(h.closed[0].reason, "capacity"); assert.equal(h.resume(h.socket()).status, "reset");
  const expired = harness(); expired.manager.detach(expired.first);
  [...expired.timers.values()][0](); assert.equal(expired.closed[0].reason, "expired");
  const alive = harness(); alive.manager.detach(alive.first); alive.manager.dispose(); alive.manager.dispose();
  assert.equal(alive.closed.length, 1); assert.equal(alive.timers.size, 0);
});

test("duplicate or skipped inbound frame cannot execute twice", () => {
  const h = harness(); assert.equal(h.manager.accept(h.first, 1), true);
  assert.equal(h.manager.accept(h.first, 1), false); assert.equal(h.closed.length, 1);
  assert.equal(h.sent.at(-1).frame.type, "opencodex:app-host-reset");
  assert.equal(h.manager.accept(h.first, 2), false);
});

test("active replacement fences old frames and duplicate hello is idempotent", () => {
  const h = harness(), next = h.socket(); const session = h.manager.session(h.first);
  assert.equal(h.resume(next).status, "resumed");
  assert.equal(h.manager.negotiate(next, "page", "auth", { version: 1 }).token, h.hello.token);
  assert.equal(h.manager.session(next), session); assert.equal(h.manager.accept(h.first, 1), false);
  assert.equal(h.manager.accept(next, 1), true);
});

test("legacy peers do not allocate sessions and unknown resume cannot become a new session", () => {
  const h = harness(), old = h.socket(); assert.equal(h.manager.negotiate(old, "old", "auth", null), null);
  assert.equal(h.manager.session(old), null);
  const next = h.socket(); assert.equal(h.resume(next, { token: "missing" }).status, "reset");
  assert.equal(h.manager.session(next), null);
});

test("offline session count and byte budgets evict oldest sessions without limiting active frames", () => {
  const h = harness({ maxOffline: 1, maxBytes: 40, maxTotalBytes: 50 });
  assert.equal(h.manager.send(h.first, { data: "x".repeat(100) }), true);
  h.manager.detach(h.first);
  const second = h.socket(); h.manager.negotiate(second, "second", "auth", { version: 1 });
  h.manager.detach(second); assert.equal(h.closed.length, 1);
  assert.equal(h.closed[0].session.clientId, "page");
  assert.equal(h.manager.send(second, { data: "x".repeat(100) }), false);
  assert.equal(h.closed.length, 2); assert.equal(h.timers.size, 0);
  const total = harness({ maxTotalBytes: 30 }); total.manager.detach(total.first);
  total.manager.send(total.first, { data: "1234567890" });
  const other = total.socket(); total.manager.negotiate(other, "other", "auth", { version: 1 }); total.manager.detach(other);
  total.manager.send(other, { data: "1234567890" });
  assert.equal(total.closed[0].session.clientId, "page");
  assert.equal(total.manager.session(other).closed, false);
});

test("ambiguous send fails closed and stale socket protocol errors cannot retire replacement", () => {
  const h = harness(), next = h.socket(); h.resume(next);
  h.manager.fail(h.first); assert.equal(h.closed.length, 0);
  next.failSend = true;
  assert.equal(h.manager.send(next, { data: "uncertain" }), false);
  assert.equal(h.closed.length, 1); assert.equal(h.resume(h.socket(), { received: 1 }).status, "reset");
});

test("shutdown continues after a resource cleanup failure", () => {
  let calls = 0;
  const h = harness({ closeSession() { calls++; throw Error("cleanup"); } });
  h.manager.negotiate(h.socket(), "other", "auth", { version: 1 });
  assert.doesNotThrow(() => h.manager.dispose()); assert.equal(calls, 2);
});

test("identity changes on the owning socket retire its original session", () => {
  for (const change of ["auth", "page", "token"]) {
    const h = harness();
    const ack = h.manager.negotiate(h.first, change === "page" ? "other" : "page",
      change === "auth" ? "other" : "auth", { version: 1, token: change === "token" ? "other" : h.hello.token });
    assert.equal(ack.status, "reset"); assert.equal(h.closed.length, 1);
    assert.equal(h.manager.accept(h.first, 1), false);
  }
});
