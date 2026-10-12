const assert = require("node:assert/strict");
const { EventEmitter, getEventListeners } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createAppServerTransport } = require("../runtime/app-server/transport.cjs");
const { createSmartModelRouterService } = require("../runtime/model-router/service.cjs");
const { createAppServerClient } = require("../runtime/app-server/client.cjs");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = (value) => `${JSON.stringify(value)}\n`;
function fixture(t, factory = createAppServerTransport) {
  const input = new PassThrough(); const output = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: input, stdout: output, stdio: [input, output] });
  const sent = [];
  input.on("data", (data) => sent.push(...data.toString().trim().split("\n").filter(Boolean).map(JSON.parse)));
  const transport = factory(); transport.decorateChild(child);
  t.after(() => transport.dispose());
  return { input, output, child, sent, transport };
}

test("an already aborted request does not write a frame", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t); const abort = new AbortController(); abort.abort();
  const result = assert.rejects(f.transport.request("read", {}, { signal: abort.signal, timeoutMs: 10 }), { category: "closed" });
  t.mock.timers.tick(10); await result;
  assert.deepEqual(f.sent, []);
});

test("cancelling a request or notification leaves the shared transport usable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t); const abort = new AbortController();
  const request = assert.rejects(f.transport.request("cancel", {}, { signal: abort.signal, timeoutMs: 10 }), { category: "closed" });
  const waiting = assert.rejects(f.transport.waitForNotification(() => true, { signal: abort.signal, timeoutMs: 10 }), { category: "closed" });
  abort.abort(); t.mock.timers.tick(10); await Promise.all([request, waiting]);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  const next = f.transport.request("next", {});
  f.output.write(frame({ id: f.sent.at(-1).id, result: "alive" }));
  assert.equal(await next, "alive");
  assert.equal(f.transport.isAttached(), true);
});

test("router uses the injected transport and releases only its consumer scope", (t) => {
  let sharedDisposals = 0; let releases = 0;
  const injected = { isAttached: () => true, dispose: () => { sharedDisposals += 1; } };
  const service = createSmartModelRouterService({
    configStore: { plugin: () => ({ enabled: true, values: {} }), onChanged: () => () => {} },
    transport: injected,
    releaseTransport: () => { releases += 1; },
  });
  t.after(() => service.dispose());
  assert.equal(service.diagnostics().attached, true);
  assert.equal(service.transport, injected);
  service.dispose(); service.dispose();
  assert.equal(sharedDisposals, 0);
  assert.equal(releases, 1);
});

for (const outcome of ["success", "response", "timeout", "write", "close"]) {
  test(`request abort listener is released after ${outcome}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(t); const abort = new AbortController();
    if (outcome === "write") f.input.write = (_data, callback) => { callback(new Error("write failed")); return true; };
    const result = f.transport.request("read", {}, { signal: abort.signal, timeoutMs: 10 });
    const checked = outcome === "success" ? result : assert.rejects(result);
    assert.equal(getEventListeners(abort.signal, "abort").length, 1);
    if (outcome === "success") f.output.write(frame({ id: f.sent[0].id, result: true }));
    if (outcome === "response") f.output.write(frame({ id: f.sent[0].id, error: { message: "denied" } }));
    if (outcome === "timeout") t.mock.timers.tick(10);
    if (outcome === "close") f.child.emit("close");
    await checked;
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    abort.abort();
  });
}

test("notification completion, predicate failure and disposal remove abort listeners", async (t) => {
  const f = fixture(t); const abort = new AbortController();
  const success = f.transport.waitForNotification(() => true, { signal: abort.signal });
  const failed = assert.rejects(f.transport.waitForNotification(() => { throw new Error("predicate"); }, { signal: abort.signal }), /predicate/);
  f.output.write(frame({ method: "event" }));
  await Promise.all([success, failed]);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  const disposed = assert.rejects(f.transport.waitForNotification(() => true, { signal: abort.signal }), { category: "closed" });
  f.transport.dispose(); await disposed;
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("client disposal cancels only its requests, waiters and observers", async (t) => {
  const f = fixture(t);
  const left = createAppServerClient(f.transport); const right = createAppServerClient(f.transport);
  t.after(() => { left.dispose(); right.dispose(); });
  for (const key of ["dispose", "rejectPending", "decorateChild", "getConnectionPolicy"]) assert.equal(left.client[key], undefined);
  let leftSeen = 0; let rightSeen = 0;
  left.client.observeNotifications(() => { leftSeen += 1; });
  right.client.observeNotifications(() => { rightSeen += 1; });
  const cancelled = assert.rejects(left.client.request("left", {}), { category: "closed" });
  const waiting = assert.rejects(left.client.waitForNotification(() => true), { category: "closed" });
  const survivor = right.client.request("right", {});
  const notification = right.client.waitForNotification(() => true);
  left.dispose(); left.dispose(); await Promise.all([cancelled, waiting]);
  assert.equal(f.transport.isAttached(), true);
  assert.equal(left.client.isAttached(), false);
  f.output.write(frame({ id: f.sent[1].id, result: true }) + frame({ method: "event" }));
  assert.equal(await survivor, true); await notification;
  assert.equal(leftSeen, 0); assert.equal(rightSeen, 1);
  await assert.rejects(left.client.request("after-dispose", {}), { category: "closed" });
  await assert.rejects(left.client.writeMessage({ method: "after-dispose" }), { category: "closed" });
  assert.equal(f.sent.length, 2);
});

test("per-request cancellation is combined with the client lifetime", async (t) => {
  const f = fixture(t); const scope = createAppServerClient(f.transport); t.after(() => scope.dispose());
  const abort = new AbortController();
  const cancelled = assert.rejects(scope.client.request("first", {}, { signal: abort.signal }), { category: "closed" });
  abort.abort(); await cancelled;
  const next = scope.client.request("second", {});
  f.output.write(frame({ id: f.sent[1].id, result: "alive" }));
  assert.equal(await next, "alive");
  const other = new AbortController();
  const scopeCancelled = assert.rejects(scope.client.request("third", {}, { signal: other.signal }), { category: "closed" });
  scope.dispose(); await scopeCancelled;
  assert.equal(other.signal.aborted, false);
});

test("cancelling a private start keeps late cleanup and notifications isolated", async (t) => {
  const f = fixture(t, require("../runtime/model-router/transport.cjs").createAppServerTransport);
  const scope = createAppServerClient(f.transport);
  const publicFrames = []; f.child.stdout.on("data", (data) => publicFrames.push(data));
  const cancelled = assert.rejects(scope.client.request("thread/start", {}), { category: "closed" });
  const id = f.sent[0].id; scope.dispose(); await cancelled;
  f.output.write(frame({ id, result: { thread: { id: "private-late", ephemeral: true } } }) + frame({ method: "item/completed", params: { threadId: "private-late" } }));
  assert.equal(f.sent[1].method, "thread/delete");
  assert.equal(f.transport.isInternalThreadId("private-late"), true);
  assert.deepEqual(publicFrames, []);
  f.output.write(frame({ id: f.sent[1].id, result: {} })); await tick();
  assert.equal(f.transport.isAttached(), true);
});

test("router disposal prevents an already resolving catalog from reviving state", async () => {
  let resolve;
  const router = createSmartModelRouterService({
    configStore: { plugin: () => ({ enabled: true, values: {} }), onChanged: () => () => {} },
    transport: { isAttached: () => true, request: () => new Promise((done) => { resolve = done; }) },
  });
  const refresh = router.refreshCatalog();
  router.dispose(); resolve({ data: [{ id: "stale", model: "stale" }] });
  await refresh;
  assert.deepEqual(router.modelCatalog.models(), []);
  assert.equal(router.isEnabled(), false);
  assert.equal(await router.processClientMessage({ id: 1, method: "turn/start", params: { model: "auto" } }), null);
});
