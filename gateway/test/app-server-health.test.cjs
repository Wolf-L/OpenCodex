const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createAppServerHealth } = require("../runtime/ipc/app-server-health.cjs");

test("CLI health observes protocol response without consuming or changing stdout", () => {
  const health = createAppServerHealth();
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new EventEmitter(), exitCode: null });
  health.track(child); const observed = []; child.stdout.on("data", b => observed.push(b));
  assert.deepEqual(health.status(), { activeCount: 1, ready: false });
  for (const line of ['log\n', '{"method":"notice"}\n', '{"id":1,"error":{}}\n']) child.stdout.emit("data", Buffer.from(line));
  assert.equal(health.status().ready, false);
  child.stdout.emit("data", Buffer.from('{"id":1,"res'));
  child.stdout.emit("data", Buffer.from('ult":{}}\n'));
  assert.equal(health.status().ready, true); assert.equal(observed.length, 5);
  child.emit("exit", 1); assert.deepEqual(health.status(), { activeCount: 0, ready: false });
  assert.equal(child.stdout.listenerCount("data"), 1);
});
test("huge or invalid output cannot manufacture CLI readiness", () => {
  const health = createAppServerHealth();
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new EventEmitter() }); health.track(child);
  child.stdout.emit("data", Buffer.from("x".repeat(1024 * 1024 + 1)));
  child.stdout.emit("data", Buffer.from('{"id":1,"result":{}}\n'));
  assert.equal(health.status().ready, false);
  child.emit("error", new Error("spawn")); assert.equal(health.status().activeCount, 0);
});
