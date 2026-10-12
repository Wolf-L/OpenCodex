const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const test = require("node:test");
const core = require("../runtime/app-server/transport.cjs");
const facade = require("../runtime/model-router/transport.cjs");
const { createAppServerHealth } = require("../runtime/ipc/app-server-health.cjs");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = (message) => `${JSON.stringify(message)}\n`;
function fakeChild(input = new PassThrough()) {
  const output = new PassThrough();
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    stdin: input, stdout: output, stdio: [input, output], pid: 123, exitCode: null,
    kill() { kills += 1; },
  });
  const sent = [];
  input.on("data", (chunk) => sent.push(...chunk.toString().trim().split("\n").filter(Boolean).map(JSON.parse)));
  return { child, input, output, sent, kills: () => kills };
}
function fixture(t, options, factory = core.createAppServerTransport, fake = fakeChild()) {
  const transport = factory(options);
  transport.decorateChild(fake.child);
  t.after(() => transport.dispose());
  return { ...fake, transport };
}
const category = (expected) => (error) => error instanceof core.AppServerTransportError && error.category === expected;

test("generic transport loads in isolation without router, Electron or configuration modules", () => {
  const path = require.resolve("../runtime/app-server/transport.cjs");
  const check = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const core = require(${JSON.stringify(path)});
    const transport = core.createAppServerTransport();
    assert.equal(transport.isAttached(), false);
    assert.equal(Object.keys(require.cache).some(p => /model-router|plugins[\\\\/]|electron|config-store/.test(p)), false);
    transport.dispose();
  `], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("generic requests, notifications and public thread messages do not require private-session policy", async (t) => {
  const f = fixture(t, { requestIdPrefix: "isolated:" });
  const visible = []; const notifications = [];
  f.child.stdout.on("data", (data) => visible.push(data.toString()));
  const stop = f.transport.observeNotifications((message) => notifications.push(message));
  const waiting = f.transport.waitForNotification((message) => message.method === "thread/started");
  const result = f.transport.request("thread/start", {});
  const id = f.sent[0].id;
  assert.equal(id, "isolated:1");
  f.output.write(frame({ id, result: { thread: { id: "generic-thread" } } }) + frame({ method: "thread/started", params: { threadId: "generic-thread" } }));
  assert.equal((await result).thread.id, "generic-thread");
  assert.equal((await waiting).method, "thread/started");
  assert.equal(notifications.length, 1);
  assert.equal(visible.join("").includes("isolated:1"), false);
  assert.equal(visible.join("").includes("thread/started"), true);
  stop();
});

test("facade reexports identities and registers private responses before subsequent frames", async (t) => {
  assert.equal(facade.AppServerTransportError, core.AppServerTransportError);
  assert.equal(facade.DECORATED_CHILD, core.DECORATED_CHILD);
  const f = fixture(t, {}, facade.createAppServerTransport);
  const visible = []; const notifications = [];
  f.child.stdout.on("data", (data) => visible.push(data.toString()));
  f.transport.observeNotifications((message) => notifications.push(message));
  const result = f.transport.request("thread/start", {});
  assert.equal(f.sent[0].id, "opencodex.router:1");
  f.output.write(frame({ id: f.sent[0].id, result: { thread: { id: "private" } } }) + frame({ id: "approval", method: "approval/request", params: { threadId: "private" } }));
  await result;
  assert.equal(f.transport.isInternalThreadId("private"), true);
  assert.equal(notifications.length, 1);
  assert.deepEqual(visible, []);
  assert.equal(f.sent[1].id, "approval");
  assert.equal(f.sent[1].error.code, -32001);
});

test("invalid, immutable and duplicate attachments leave streams and listeners consistent", async (t) => {
  let attaches = 0;
  const f = fixture(t, { onAttached() { attaches += 1; } });
  const wrapped = f.child.stdin;
  const dataCount = f.output.listenerCount("data");
  f.transport.decorateChild(f.child);
  assert.equal(f.child.stdin, wrapped);
  assert.equal(f.child.stdio[0], wrapped);
  assert.equal(f.child.stdio[1], f.child.stdout);
  assert.equal(f.output.listenerCount("data"), dataCount);
  assert.equal(attaches, 1);
  for (const invalid of [null, {}, { stdin: {}, stdout: {} }]) assert.equal(f.transport.decorateChild(invalid), invalid);
  for (const mutate of [
    (child) => Object.preventExtensions(child),
    (child) => Object.freeze(child.stdio),
    (child) => Object.defineProperty(child, "stdin", { configurable: false, writable: false }),
  ]) {
    const invalid = fakeChild(); mutate(invalid.child);
    f.transport.decorateChild(invalid.child);
    assert.equal(invalid.child.stdin, invalid.input);
    assert.equal(invalid.child.stdout, invalid.output);
    assert.equal(invalid.child[core.DECORATED_CHILD], undefined);
    assert.equal(invalid.output.listenerCount("data"), 0);
  }
  // 即使预检查后发生 defineProperty 失败，也必须撤销已经替换的 stdin。
  const rollback = fakeChild();
  const descriptor = Object.getOwnPropertyDescriptor(rollback.child, "stdin");
  const proxy = new Proxy(rollback.child, { defineProperty(target, key, value) {
    if (key === "stdout") throw new Error("cannot replace stdout");
    return Reflect.defineProperty(target, key, value);
  } });
  f.transport.decorateChild(proxy);
  assert.deepEqual(Object.getOwnPropertyDescriptor(rollback.child, "stdin"), descriptor);
  assert.equal(rollback.child[core.DECORATED_CHILD], undefined);
  assert.equal(f.transport.isAttached(), true);
  const pending = f.transport.request("read", {});
  f.output.write(frame({ id: f.sent[0].id, result: true }));
  assert.equal(await pending, true);
});

test("timeouts and response errors retain categories and response payload", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  const timeout = assert.rejects(f.transport.request("slow", {}, { timeoutMs: 50 }), category("timeout"));
  const notification = assert.rejects(f.transport.waitForNotification(() => true, { timeoutMs: 50 }), category("timeout"));
  t.mock.timers.tick(50);
  await Promise.all([timeout, notification]);
  const error = { code: -1, message: "denied", data: { reason: "fixture" } };
  const rejected = assert.rejects(f.transport.request("failure", {}), (value) => {
    assert.equal(value.category, "response"); assert.deepEqual(value.response, error); return true;
  });
  f.output.write(frame({ id: f.sent[1].id, error }));
  await rejected;
});

for (const mode of ["sync-throw", "async-callback"]) {
  test(`write failure is categorized for ${mode}`, async (t) => {
    const fake = fakeChild();
    fake.input.write = (_buffer, callback) => {
      if (mode === "sync-throw") throw new Error("write fixture");
      setImmediate(() => callback(new Error("write fixture")));
      return false;
    };
    const f = fixture(t, {}, core.createAppServerTransport, fake);
    await assert.rejects(f.transport.request("test", {}), category("write"));
  });
}

for (const mode of ["eof", "error", "close"]) {
  test(`${mode} rejects pending requests and waiters once; only physical close calls onClosed`, async (t) => {
    let closes = 0;
    const f = fixture(t, { onClosed() { closes += 1; } });
    const pending = assert.rejects(f.transport.request("pending", {}), category("closed"));
    const waiting = assert.rejects(f.transport.waitForNotification(() => true), category("closed"));
    if (mode === "eof") f.output.emit("end");
    if (mode === "error") f.child.emit("error", new Error("process fixture"));
    if (mode === "close") f.child.emit("close");
    await Promise.all([pending, waiting]);
    assert.equal(f.transport.isAttached(), false);
    assert.equal(closes, mode === "close" ? 1 : 0);
    f.child.emit("close"); f.child.emit("close");
    assert.equal(closes, 1);
    await assert.rejects(f.transport.request("new", {}), category("closed"));
    assert.equal(f.output.listenerCount("data"), 0);
    assert.equal(f.child.listenerCount("close"), 0);
  });
}

test("dispose is idempotent, preserves health listeners, rejects new work and never kills", async (t) => {
  const fake = fakeChild(); const health = createAppServerHealth();
  health.track(fake.child);
  const baseline = fake.output.listeners("data");
  const f = fixture(t, {}, core.createAppServerTransport, fake);
  const pending = assert.rejects(f.transport.request("pending", {}), category("closed"));
  const waiting = assert.rejects(f.transport.waitForNotification(() => true), category("closed"));
  let seen = 0; f.transport.observeNotifications(() => { seen += 1; });
  f.transport.dispose(); f.transport.dispose();
  await Promise.all([pending, waiting]);
  assert.deepEqual(fake.output.listeners("data"), baseline);
  fake.output.write(frame({ id: "public", result: {} }) + frame({ method: "event" }));
  assert.equal(health.status().ready, true);
  assert.equal(seen, 0);
  assert.equal(f.kills(), 0);
  await assert.rejects(f.transport.request("new", {}), category("closed"));
  await assert.rejects(f.transport.waitForNotification(() => true), category("closed"));
  const next = fakeChild(); f.transport.decorateChild(next.child);
  assert.equal(next.child.stdin, next.input);
  fake.child.emit("exit", 0);
});

test("normal EOF and physical close preserve queued output until the consumer drains", async (t) => {
  const f = fixture(t);
  const payload = Array.from({ length: 80 }, (_, index) => frame({ method: "event", params: { index, text: "文".repeat(4096) } })).join("");
  // 一次源事件提供多帧，强制公开队列先积压，再模拟 EOF/close，最后才读取。
  f.output.emit("data", Buffer.from(payload));
  assert.equal(f.output.isPaused(), true);
  f.output.emit("end"); f.child.emit("close");
  const result = []; const ended = once(f.child.stdout, "end");
  f.child.stdout.on("data", (data) => result.push(data));
  await ended;
  assert.equal(Buffer.concat(result).toString(), payload);
  assert.equal(f.child.stdout.listenerCount("drain"), 0);
});

test("public middleware failures preserve original lines; owned policy failures never leak", async (t) => {
  const f = fixture(t, {
    processClientMessage() { throw new Error("public input"); },
    processServerMessage() { throw new Error("public output"); },
  });
  const visible = []; f.child.stdout.on("data", (data) => visible.push(data.toString()));
  const raw = '{ "id": "public", "result": true }';
  f.child.stdin.write(frame({ id: "request", method: "read" }));
  f.output.write(`${raw}\r\nnot-json\r\n`);
  await tick();
  assert.equal(f.sent[0].id, "request");
  assert.equal(visible.join(""), `${raw}\nnot-json\n`);
  for (const hook of ["onResponse", "onLateResponse", "filterMessage"]) {
    const guarded = fixture(t, { createConnectionPolicy: () => ({ [hook]() { throw new Error("private fixture"); } }) });
    const leaked = []; guarded.child.stdout.on("data", (data) => leaked.push(data));
    const rejected = assert.rejects(guarded.transport.request("private", {}), category("response"));
    const id = hook === "onLateResponse" ? "opencodex.app-server:expired" : guarded.sent[0].id;
    guarded.output.write(hook === "filterMessage" ? frame({ method: "private/event" }) : frame({ id, result: { sensitive: true } }));
    await rejected;
    assert.deepEqual(leaked, []);
    assert.equal(guarded.transport.isAttached(), false);
  }
});

test("retired real write errors cannot become unhandled errors or reach the new connection", async (t) => {
  let complete;
  const input = new Writable({ write(_chunk, _encoding, callback) { complete = callback; } });
  const f = fixture(t, {}, core.createAppServerTransport, fakeChild(input));
  const rejected = assert.rejects(f.transport.request("pending", {}), category("closed"));
  const next = fakeChild(); f.transport.decorateChild(next.child);
  await rejected;
  complete(new Error("late native write failure"));
  await tick();
  await tick();
  assert.deepEqual(next.sent, []);
  assert.equal(f.transport.isAttached(), true);
  assert.equal(input.listenerCount("error"), 0);
});
