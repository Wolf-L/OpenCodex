const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { launchAndConfirmRuntime, matchesReadyRuntime } = require("../../shared/runtime-startup.cjs");

function fixture() {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, killed: false });
  const runtime = { runtimeBinding: { bundleDir: path.resolve("fixture-bundle"), codexBinaryPath: "fixture-cli" } };
  const status = { ok: true, gateway: { pid: 123 }, officialIpc: { ready: true }, officialAppServer: { ready: true, lastError: null }, officialBundle: { ...runtime.runtimeBinding } };
  const events = [];
  const options = { runtime, spawn: () => child, confirm: check => { check(); events.push("confirmed"); },
    fetchStatus: async () => status, stop: async () => { events.push("stopped"); return true; }, isProcessAlive: () => true, stableMs: 0, intervalMs: 1, timeoutMs: 200 };
  return { child, runtime, status, events, options };
}

test("only this child, bound bundle and responding CLI confirm startup", async () => {
  const f = fixture();
  await launchAndConfirmRuntime(f.options);
  assert.deepEqual(f.events, ["confirmed"]);
  for (const change of [s => s.gateway.pid++, s => s.officialIpc.ready = false, s => s.officialAppServer.ready = false,
    s => s.officialBundle.bundleDir = "wrong", s => s.officialBundle.codexBinaryPath = "wrong"]) {
    const status = structuredClone(f.status); change(status);
    assert.equal(matchesReadyRuntime(status, f.child, f.runtime.runtimeBinding), false);
  }
});
test("timeout stops candidate without confirming", async () => {
  const f = fixture(); f.status.officialAppServer.ready = false;
  await assert.rejects(launchAndConfirmRuntime(f.options), /启动确认/);
  assert.deepEqual(f.events, ["stopped"]);
});
test("hung health request is aborted and stopped", async () => {
  const f = fixture(); f.options.fetchStatus = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  await assert.rejects(launchAndConfirmRuntime(f.options), /aborted/);
  assert.deepEqual(f.events, ["stopped"]);
});
test("sync spawn failure and asynchronous spawn error cannot confirm", async () => {
  const f = fixture(); f.options.spawn = () => { throw new Error("spawn failed"); };
  await assert.rejects(launchAndConfirmRuntime(f.options), /spawn failed/);
  f.options.spawn = () => { queueMicrotask(() => f.child.emit("error", new Error("async spawn"))); return f.child; };
  f.status.officialAppServer.ready = false;
  await assert.rejects(launchAndConfirmRuntime(f.options), /async spawn/);
  assert.equal(f.events.includes("confirmed"), false);
});
test("pointer publication failure stops child before recovery", async () => {
  const f = fixture(); f.options.confirm = () => { throw new Error("rename failed"); };
  await assert.rejects(launchAndConfirmRuntime(f.options), /rename failed/);
  assert.deepEqual(f.events, ["stopped"]);
});
test("failed termination prevents a second runtime from starting", async () => {
  const f = fixture(); f.options.confirm = () => { throw new Error("bad"); }; f.options.stop = async () => false;
  await assert.rejects(launchAndConfirmRuntime(f.options), error => error.runtimeStopFailed === true);
});
test("readiness must be stable, and exit during confirm is rejected", async () => {
  const f = fixture(); let reads = 0;
  f.options.stableMs = 5;
  f.options.fetchStatus = async () => { reads++; return reads === 2 ? null : f.status; };
  await launchAndConfirmRuntime(f.options); assert.ok(reads >= 3);
  f.options.confirm = check => { f.child.exitCode = 1; check(); };
  await assert.rejects(launchAndConfirmRuntime(f.options), /发布前退出/);
});

test("real supervised process exits before startup failure is returned", async t => {
  const { spawn } = require("node:child_process");
  const f = fixture(); let child;
  // 使用本机 Node 夹具验证真实 OS 退出，不启动 Electron 或改动用户数据。
  t.after(() => { if (child?.exitCode == null && child?.signalCode == null) child?.kill("SIGKILL"); });
  await assert.rejects(launchAndConfirmRuntime({ runtime: f.runtime, confirm: () => assert.fail("must not confirm"),
    spawn: () => (child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true })),
    fetchStatus: async () => null, timeoutMs: 200, intervalMs: 10,
  }), /启动确认/);
  assert.ok(child.exitCode != null || child.signalCode != null);
});

function updateFixture() {
  const vm = require("node:vm"), fs = require("node:fs");
  const source = fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8");
  const code = source.slice(source.indexOf("async function checkRuntimeUpdate()"), source.indexOf("async function restoreBundleBackup()"));
  const report = { ok: true, changed: true, checkedAt: new Date().toISOString(), originIdentity: "a".repeat(64) };
  const events = [];
  // 执行真实主进程函数，以可控 worker 和重启边界验证停服顺序，不启动用户应用。
  const context = vm.createContext({ selfUpdateController: null, gatewayRestartPromise: null, gatewayStartPromise: null, runtimePreflightPromise: null,
    runtimePreflight: { ...report }, runtimeUpdatePhase: "", isQuitting: false, expectedRuntimeIdentity: null, retryFailedRuntime: false,
    require: () => ({ preflightRuntimeUpdate: async () => { events.push("checked"); return { ...report }; } }),
    runtimePaths: () => ({ officialBundleDir: "fixture" }), broadcastState() {}, buildState: () => "state",
    restartGatewayOnce: async callback => { events.push("stopped"); callback(); return "restarted"; } });
  vm.runInContext(code, context);
  return { context, report, events };
}

test("apply rejects missing, stale, invalid and future approvals before stopping", async () => {
  const { context, report, events } = updateFixture();
  for (const value of [null, { ...report, checkedAt: new Date(0).toISOString() }, { ...report, checkedAt: "invalid" },
    { ...report, checkedAt: new Date(Date.now() + 60000).toISOString() }, { ...report, originIdentity: "invalid" }]) {
    context.runtimePreflight = value;
    await assert.rejects(context.applyRuntimeUpdate(), /预检/);
  }
  assert.deepEqual(events, []);
});

test("apply rechecks source before stop and forwards only the approved identity", async () => {
  const { context, report, events } = updateFixture();
  assert.equal(await context.applyRuntimeUpdate(), "restarted");
  assert.deepEqual(events, ["checked", "stopped"]);
  assert.equal(context.expectedRuntimeIdentity, report.originIdentity);
  assert.equal(context.retryFailedRuntime, true); assert.equal(context.runtimePreflight, null);
  assert.equal(context.runtimeUpdatePhase, "");
});

test("failed or changed fresh preflight keeps the running service untouched", async () => {
  for (const failure of [new Error("source unavailable"), { ok: false }, { originIdentity: "b".repeat(64) }]) {
    const { context, report, events } = updateFixture();
    context.require = () => ({ preflightRuntimeUpdate: async () => {
      if (failure instanceof Error) throw failure;
      return { ...report, ...failure };
    } });
    await assert.rejects(context.applyRuntimeUpdate());
    assert.deepEqual(events, []);
    assert.equal(context.runtimePreflight.ok, false);
    assert.equal(context.gatewayRestartPromise, null);
  }
});

test("new check invalidates old approval and prevents apply until it finishes", async () => {
  const { context, report, events } = updateFixture(); let finish;
  context.require = () => ({ preflightRuntimeUpdate: () => new Promise(resolve => { finish = resolve; }) });
  const pending = context.checkRuntimeUpdate();
  await Promise.resolve();
  assert.equal(context.runtimePreflight, null);
  await assert.rejects(context.applyRuntimeUpdate(), /预检/);
  finish(report); await pending;
  assert.deepEqual(events, []);
});

test("concurrent applies share one recheck and stop; check cannot replace an applying plan", async () => {
  const { context, report, events } = updateFixture(); let finish; let checks = 0;
  context.require = () => ({ preflightRuntimeUpdate: () => { checks++; return new Promise(resolve => { finish = resolve; }); } });
  const first = context.applyRuntimeUpdate(), second = context.applyRuntimeUpdate();
  await Promise.resolve();
  assert.equal(context.runtimeUpdatePhase, "validating");
  await assert.rejects(context.checkRuntimeUpdate(), /进行中/);
  finish(report); await Promise.all([first, second]);
  assert.equal(checks, 1); assert.deepEqual(events, ["stopped"]);
});

test("startup, shutdown and unchanged plans cannot start an update restart", async () => {
  for (const busy of ["gatewayStartPromise", "isQuitting"]) {
    const { context, events } = updateFixture(); context[busy] = true;
    await assert.rejects(context.applyRuntimeUpdate()); assert.deepEqual(events, []);
  }
  const { context, report, events } = updateFixture();
  context.runtimePreflight = { ...report, changed: false };
  assert.equal(await context.applyRuntimeUpdate(), "state"); assert.deepEqual(events, []);
  context.runtimePreflight = report;
  context.require = () => ({ preflightRuntimeUpdate: async () => { context.isQuitting = true; return report; } });
  await assert.rejects(context.applyRuntimeUpdate()); assert.deepEqual(events, []);
});
