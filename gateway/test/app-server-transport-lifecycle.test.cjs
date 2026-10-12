const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createAppServerTransport, DECORATED_CHILD } = require("../runtime/model-router/transport.cjs");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = (value) => `${JSON.stringify(value)}\n`;
function fakeChild() {
  const input = new PassThrough();
  const output = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: input, stdout: output, stdio: [input, output] });
  const sent = [];
  input.on("data", (chunk) => sent.push(...chunk.toString().trim().split("\n").filter(Boolean).map(JSON.parse)));
  return { child, input, output, sent };
}
function attach(transport, fake) {
  transport.decorateChild(fake.child);
  // 代理流错误由本测试消费，避免它遮住真正的代际隔离断言。
  fake.child.stdin.on("error", () => {});
  fake.child.stdout.on("error", () => {});
}

test("replacement retires deferred client middleware instead of writing into the next child", async (t) => {
  let release;
  const transport = createAppServerTransport({
    async processClientMessage(message) {
      await new Promise((resolve) => { release = resolve; });
      return message;
    },
  });
  const old = fakeChild(); const next = fakeChild();
  t.after(() => { old.child.emit("close"); next.child.emit("close"); transport.dispose?.(); });
  attach(transport, old);
  old.child.stdin.write(frame({ id: "old-frame", method: "turn/start", params: { threadId: "a" } }));
  await tick();
  attach(transport, next);
  release();
  await tick();
  assert.deepEqual(next.sent, []);
  assert.deepEqual(old.sent, []);
});

test("replacement retires queued frames even when an old real write callback completes later", async (t) => {
  let completeWrite;
  const transport = createAppServerTransport();
  const old = fakeChild(); const next = fakeChild();
  old.input.write = (_chunk, callback) => { completeWrite = callback; return true; };
  t.after(() => { old.child.emit("close"); next.child.emit("close"); transport.dispose?.(); });
  attach(transport, old);
  old.child.stdin.write(frame({ id: "first", method: "unknown" }) + frame({ id: "queued", method: "unknown" }));
  await tick();
  assert.equal(typeof completeWrite, "function");
  attach(transport, next);
  completeWrite();
  await tick();
  assert.deepEqual(next.sent, []);
});

test("immutable child attachment does not partially decorate or replace the healthy connection", (t) => {
  const transport = createAppServerTransport();
  const good = fakeChild(); const invalid = fakeChild();
  t.after(() => { good.child.emit("close"); invalid.child.emit("close"); transport.dispose?.(); });
  attach(transport, good);
  Object.defineProperty(invalid.child, "stdout", { configurable: false, writable: false, value: invalid.output });
  transport.decorateChild(invalid.child);
  assert.equal(invalid.child.stdin, invalid.input);
  assert.equal(invalid.child.stdout, invalid.output);
  assert.equal(invalid.child[DECORATED_CHILD], undefined);
  assert.equal(transport.isAttached(), true);
});

test("middleware async continuations retain their generation for nested requests and private registrations", async (t) => {
  let release; let continued; let nestedError;
  const continuation = new Promise((resolve) => { continued = resolve; });
  let observerCalls = 0;
  const transport = createAppServerTransport({
    async processClientMessage(message) {
      transport.observeNotifications(() => { observerCalls += 1; });
      await new Promise((resolve) => { release = resolve; });
      try { await transport.request("thread/delete", { threadId: "old-private" }); } catch (error) { nestedError = error; }
      transport.registerInternalThread("old-private");
      transport.observeNotifications(() => { observerCalls += 100; });
      continued();
      return message;
    },
  });
  t.after(() => transport.dispose());
  const old = fakeChild(); const next = fakeChild();
  attach(transport, old);
  old.child.stdin.write(frame({ id: "old-turn", method: "turn/start", params: { threadId: "a" } }));
  await tick();
  attach(transport, next);
  release(); await continuation; await tick();
  assert.equal(nestedError.category, "closed");
  assert.deepEqual(next.sent, []);
  assert.equal(transport.isInternalThreadId("old-private"), false);
  next.output.write(frame({ method: "event" }));
  assert.equal(observerCalls, 0);
});

test("old stdout, response IDs, notification waiters and close cannot affect a replacement", async (t) => {
  let closes = 0; let notifications = 0;
  const transport = createAppServerTransport({ onClosed() { closes += 1; } });
  t.after(() => transport.dispose());
  const old = fakeChild(); const next = fakeChild();
  const oldVisible = []; const nextVisible = [];
  attach(transport, old);
  old.child.stdout.on("data", (data) => oldVisible.push(data));
  transport.registerInternalThread("old-private");
  const rejected = assert.rejects(transport.request("old-read", {}), { category: "closed" });
  const oldId = old.sent[0].id;
  const waiting = assert.rejects(transport.waitForNotification(() => true), { category: "closed" });
  transport.observeNotifications(() => { notifications += 1; });
  attach(transport, next);
  next.child.stdout.on("data", (data) => nextVisible.push(data));
  await Promise.all([rejected, waiting]);
  assert.equal(transport.isInternalThreadId("old-private"), false);
  let newSettled = false;
  const pending = transport.request("new-read", {}).then((result) => { newSettled = true; return result; });
  const newId = next.sent[0].id;
  assert.notEqual(newId, oldId);
  assert.equal(Number(newId.split(":").pop()), Number(oldId.split(":").pop()) + 1);
  old.output.write(frame({ id: newId, result: "wrong" }) + frame({ method: "old/event" }));
  old.child.emit("close");
  await tick();
  assert.equal(newSettled, false);
  assert.equal(closes, 0);
  assert.equal(notifications, 0);
  assert.deepEqual(oldVisible, []);
  assert.deepEqual(nextVisible, []);
  assert.equal(old.output.listenerCount("data"), 0);
  assert.equal(old.child.listenerCount("close"), 0);
  assert.equal(transport.isAttached(), true);
  next.output.write(frame({ id: newId, result: "correct" }));
  assert.equal(await pending, "correct");
  next.child.emit("close"); next.child.emit("close");
  assert.equal(closes, 1);
});

test("late ephemeral cleanup stays on its originating generation and its finally cannot tombstone the next", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const transport = createAppServerTransport();
  t.after(() => transport.dispose());
  const old = fakeChild(); const next = fakeChild();
  attach(transport, old);
  const timedOut = assert.rejects(transport.request("thread/start", {}, { timeoutMs: 50 }), { category: "timeout" });
  t.mock.timers.tick(50); await timedOut;
  old.output.write(frame({ id: old.sent[0].id, result: { thread: { id: "same-id", ephemeral: true } } }));
  assert.equal(old.sent[1].method, "thread/delete");
  attach(transport, next);
  transport.registerInternalThread("same-id");
  old.output.write(frame({ id: old.sent[0].id, result: { thread: { id: "another-late", ephemeral: true } } }));
  await tick();
  assert.deepEqual(next.sent, []);
  assert.equal(transport.internalThreadIds().has("same-id"), true);
  assert.equal(transport.isInternalThreadId("another-late"), false);
});

test("retiring a pressured input settles its callback and final without releasing frames to a successor", async (t) => {
  const releases = [];
  const transport = createAppServerTransport({
    async processClientMessage(message) {
      await new Promise((resolve) => releases.push(resolve));
      return message;
    },
  });
  t.after(() => transport.dispose());
  const old = fakeChild(); const next = fakeChild();
  attach(transport, old);
  const frames = Array.from({ length: 64 }, (_, id) => frame({ id, method: "unknown" })).join("");
  const write = new Promise((resolve) => old.child.stdin.write(frames, resolve));
  const final = new Promise((resolve) => old.child.stdin.end(resolve));
  await tick();
  assert.equal(releases.length, 64);
  attach(transport, next);
  assert.equal((await write).category, "closed");
  assert.ok(await final);
  for (const release of releases) release();
  await tick();
  assert.deepEqual(old.sent, []);
  assert.deepEqual(next.sent, []);
});
