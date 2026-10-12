const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { createAppServerTransport } = require("../runtime/app-server/transport.cjs");
const { createAppServerClient } = require("../runtime/app-server/client.cjs");
const { createAppServerReadClient } = require("../runtime/app-server/read-client.cjs");

const frame = value => `${JSON.stringify(value)}\n`;
function child() {
  const input = new PassThrough(), output = new PassThrough(), sent = [];
  input.on("data", chunk => sent.push(...chunk.toString().trim().split("\n").filter(Boolean).map(JSON.parse)));
  return { child: Object.assign(new EventEmitter(), { stdin: input, stdout: output }), input, output, sent };
}
function fixture(t) {
  const f = child(), transport = createAppServerTransport(); transport.decorateChild(f.child);
  const scope = createAppServerReadClient(transport);
  t.after(() => { scope.dispose(); transport.dispose(); });
  return { ...f, transport, scope, client: scope.client };
}

test("read client loads without Electron, router or plugin configuration", () => {
  const modulePath = require.resolve("../runtime/app-server/read-client.cjs");
  // 新进程只加载被测模块，避免其他套件的 require 缓存掩盖反向依赖。
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    require(${JSON.stringify(modulePath)});
    assert.equal(Object.keys(require.cache).some(p => /model-router|plugins[\\\\/]|electron|config-store/.test(p)), false);
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("read capability exposes only fixed single-page operations and preserves responses", async t => {
  const f = fixture(t);
  assert.equal(Object.isFrozen(f.client), true);
  assert.deepEqual(Object.keys(f.client).sort(), ["isAttached", "listModels", "listRecentThreads"]);
  assert.equal(f.client.isAttached(), true);
  const models = f.client.listModels();
  assert.deepEqual(f.sent[0].params, { cursor: null, limit: 100, includeHidden: false });
  assert.equal(f.sent[0].method, "model/list");
  const response = { data: [{ id: "model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: "more", future: true };
  f.output.write(frame({ id: f.sent[0].id, result: response }));
  assert.deepEqual(await models, response); assert.equal(f.sent.length, 1);
  const history = f.client.listRecentThreads({ cursor: "page-2", limit: 5 });
  assert.deepEqual(f.sent[1].params, { archived: false, cursor: "page-2", limit: 5, modelProviders: null, sortKey: "updated_at", useStateDbOnly: true });
  assert.equal(f.sent[1].method, "thread/list");
  f.output.write(frame({ id: f.sent[1].id, result: { data: [], nextCursor: "page-3" } }));
  assert.deepEqual(await history, { data: [], nextCursor: "page-3" }); assert.equal(f.sent.length, 2);
});

test("invalid pagination, extra protocol fields and controls are rejected before writing", async t => {
  const f = fixture(t);
  for (const operation of ["listModels", "listRecentThreads"]) {
    for (const params of [null, [], "bad", { method: "turn/start" }, { includeHidden: true }, { archived: true },
      { cursor: 1 }, { cursor: "x".repeat(4097) }, { limit: 0 }, { limit: 101 }, { limit: 1.1 }, { limit: "12" },
      { limit: NaN }, { limit: Infinity }, { [Symbol("unknown")]: true }]) {
      await assert.rejects(f.client[operation](params), TypeError);
    }
    for (const options of [null, [], { retry: true }, { timeoutMs: 0 }, { timeoutMs: 10001 },
      { timeoutMs: 1.5 }, { timeoutMs: "500" }, { timeoutMs: Infinity }, { signal: {} }]) {
      await assert.rejects(f.client[operation]({}, options), TypeError);
    }
  }
  assert.deepEqual(f.sent, []);
});

test("read boundaries accept full cursor and limits without forwarding unlisted fields", async t => {
  const f = fixture(t);
  const request = f.client.listModels({ cursor: "x".repeat(4096), limit: 1 }, { timeoutMs: 10000 });
  assert.equal(f.sent[0].params.cursor.length, 4096); assert.equal(f.sent[0].params.limit, 1);
  f.output.write(frame({ id: f.sent[0].id, result: { data: [] } })); await request;
  const next = f.client.listRecentThreads({ limit: 100 }, { timeoutMs: 1 });
  assert.equal(f.sent[1].params.limit, 100);
  f.output.write(frame({ id: f.sent[1].id, result: { data: [] } })); await next;
});

test("read cancellation and disposal leave the sibling consumer and shared connection alive", async t => {
  const f = fixture(t), other = createAppServerClient(f.transport), abort = new AbortController();
  t.after(() => other.dispose());
  const cancelled = assert.rejects(f.client.listModels({}, { signal: abort.signal }), { category: "closed" });
  const sibling = other.client.request("model/list", {});
  abort.abort(); await cancelled;
  const disposed = assert.rejects(f.client.listRecentThreads(), { category: "closed" });
  f.scope.dispose(); f.scope.dispose(); await disposed;
  assert.equal(f.client.isAttached(), false); assert.equal(f.transport.isAttached(), true);
  f.output.write(frame({ id: f.sent[1].id, result: "sibling-alive" })); assert.equal(await sibling, "sibling-alive");
  await assert.rejects(f.client.listModels(), { category: "closed" }); assert.equal(f.sent.length, 3);
});

test("an already cancelled read never writes and another read still works", async t => {
  const f = fixture(t), abort = new AbortController(); abort.abort();
  await assert.rejects(f.client.listModels({}, { signal: abort.signal }), { category: "closed" });
  assert.deepEqual(f.sent, []);
  const result = f.client.listRecentThreads();
  assert.equal(f.sent[0].params.limit, 12);
  f.output.write(frame({ id: f.sent[0].id, result: { data: [] } })); await result;
});

test("timeouts and server errors preserve categories and never retry or paginate", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  const timeout = assert.rejects(f.client.listModels(), { category: "timeout" });
  t.mock.timers.tick(4999); assert.equal(f.sent.length, 1);
  t.mock.timers.tick(1); await timeout;
  const response = assert.rejects(f.client.listRecentThreads(), error => error.category === "response" && error.response.code === 123);
  f.output.write(frame({ id: f.sent[1].id, error: { code: 123, message: "unavailable" } })); await response;
  t.mock.timers.tick(10000); assert.equal(f.sent.length, 2);
});

test("replacement rejects old reads without replay and subsequent reads bind to the new child", async t => {
  const f = fixture(t), next = child();
  const old = assert.rejects(f.client.listModels(), { category: "closed" });
  f.transport.decorateChild(next.child); await old;
  assert.deepEqual(next.sent, []);
  const request = f.client.listRecentThreads();
  assert.equal(next.sent.length, 1); assert.notEqual(next.sent[0].id, f.sent[0].id);
  next.output.write(frame({ id: next.sent[0].id, result: { data: [] } })); await request;
  assert.equal(f.client.isAttached(), true);
});

test("failed writes retain their category and do not retry", async t => {
  const f = fixture(t);
  f.input.write = (_chunk, done) => { done(new Error("fixture write failure")); return false; };
  await assert.rejects(f.client.listModels(), { category: "write" });
  assert.deepEqual(f.sent, []);
});
