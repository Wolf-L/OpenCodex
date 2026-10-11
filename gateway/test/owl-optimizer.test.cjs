const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { OfficialBundleFileSystem } = require("../dist/official/OfficialBundleFileSystem.js");
const { OfficialRuntimeOptimizer } = require("../dist/official/OfficialRuntimeOptimizer.js");
const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");

const ENV = "OPENCODEX_GATEWAY_HIDDEN_RUNTIME";
const RESTORE_POINT = "static.cache.main.native-pet.restore";
const PUSH_POINT = "static.cache.main.macos-push-registration";
const WORKTREE_POINT = "static.cache.main.worktree-shell-environment";
const RESTORE = "async restoreOpenState(e){(this.isNotchEnabled||this.visibilityMode!==`on-demand`&&this.globalState.get(`electron-avatar-overlay-open`)===!0)&&await this.open(e)}";
const DELEGATE = '"worktree-shell-environment-config":({cwd:e,hostId:t,signal:n})=>this.readWorktreeShellEnvironment(e,t??`local`,n)';

function fixture(t, source) {
  // 所有输入都由本文件构造；临时目录边界校验后才清理，不执行官方 bundle 或读取用户配置。
  const tempRoot = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, "opencodex-owl-optimizer-"));
  const mainPath = path.join(dir, ".vite", "build", "main-owl.js");
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.writeFileSync(mainPath, source);
  const service = createCompatibilityService();
  const optimizer = new OfficialRuntimeOptimizer({ fileSystem: new OfficialBundleFileSystem(), compatibilityService: service });
  t.after(() => {
    service.dispose();
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(tempRoot + path.sep));
    assert.ok(path.basename(resolved).startsWith("opencodex-owl-optimizer-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return {
    optimize: () => optimizer.optimize(dir),
    read: () => fs.readFileSync(mainPath, "utf8"),
    point: (id) => service.registry.point(id),
  };
}

function avatarSource(restore = RESTORE) {
  return "var Overlay=class{logger=log(`avatar-overlay`);supportsInputShape=BrowserWindow.isInputShapeSupported();" + restore +
    "async prewarm(e){if(this.window!=null||this.openingWindowPromise!=null||this.isAppQuitting)return;await this.ensureWindow(e)}" +
    "async ensureWindow(e){if(this.isAppQuitting)return null;return this.createWindow(e)}};";
}

function assertIdempotent(f, expectedField, expectedValue) {
  const before = f.read();
  const again = f.optimize();
  assert.equal(again[expectedField], expectedValue);
  assert.equal(again.patchedFileCount, 0);
  assert.equal(f.read(), before);
}

function assertInactive(f, id) {
  const point = f.point(id);
  assert.notEqual(point.status, "healthy");
  assert.equal(point.activation.status, "inactive");
  assert.equal(point.fallback.active, true);
}

test("OWL avatar restore guards notch and persisted state only in hidden mode", async (t) => {
  const f = fixture(t, avatarSource());
  const result = f.optimize();
  assert.equal(result.nativePetComposition, "gateway-css-fallback");
  assert.equal(result.nativePetPrewarm, "gateway-lazy");
  assert.equal(result.patchedFileCount, 1);
  assert.deepEqual(result.unsupportedFiles, []);
  assert.equal(f.point(RESTORE_POINT).status, "healthy");
  const createOverlay = new Function("process", "log", "BrowserWindow", f.read() + "return Overlay;");
  // 穷举短路组合：notch 优先时不能读取状态，隐藏模式甚至不能读取实例条件。
  for (const hidden of [undefined, "0", "1"]) {
    const Overlay = createOverlay({ env: { [ENV]: hidden } }, () => ({}), { isInputShapeSupported: () => true });
    for (const notch of [false, true]) for (const visibility of ["on-demand", "always"]) for (const persisted of [false, true]) {
      const overlay = new Overlay();
      const argument = { hidden, notch, visibility, persisted };
      let stateReads = 0;
      let openCalls = 0;
      overlay.isNotchEnabled = notch;
      overlay.visibilityMode = visibility;
      overlay.globalState = { get(key) { stateReads++; assert.equal(key, "electron-avatar-overlay-open"); return persisted; } };
      overlay.open = async function (received) { assert.equal(this, overlay); assert.equal(received, argument); openCalls++; };
      const returned = overlay.restoreOpenState(argument);
      assert.ok(returned instanceof Promise);
      assert.equal(await returned, undefined);
      assert.equal(openCalls, Number(hidden !== "1" && (notch || visibility !== "on-demand" && persisted)), JSON.stringify(argument));
      assert.equal(stateReads, Number(hidden !== "1" && !notch && visibility !== "on-demand"), JSON.stringify(argument));
    }
    if (hidden === "1") {
      const overlay = new Overlay();
      for (const key of ["isNotchEnabled", "visibilityMode", "globalState", "open"]) {
        Object.defineProperty(overlay, key, { get() { throw new Error("hidden restore must return before reading " + key); } });
      }
      await overlay.restoreOpenState({});
    }
  }
  assertIdempotent(f, "nativePetPrewarm", "gateway-lazy");
});

for (const [label, restore] of [
  ["changed persisted key", RESTORE.replace("electron-avatar-overlay-open", "changed-overlay-open") + "/*electron-avatar-overlay-open*/"],
  ["different open argument", RESTORE.replace("this.open(e)", "this.open(other)")],
  ["changed visibility condition", RESTORE.replace("`on-demand`", "`always`")],
  ["additional condition", RESTORE.replace("this.isNotchEnabled||", "this.extra||this.isNotchEnabled||")],
]) {
  test(`OWL avatar restore rejects ${label} rather than declaring it healthy`, (t) => {
    const f = fixture(t, avatarSource(restore));
    for (let pass = 0; pass < 2; pass++) {
      assert.ok(f.optimize().unsupportedFiles.some((entry) => entry.includes("prewarm")));
      assertInactive(f, RESTORE_POINT);
      assert.ok(f.read().includes(restore));
    }
  });
}

test("OWL avatar restore does not hide an unrecognized second candidate", (t) => {
  const unknown = RESTORE.replace("restoreOpenState", "restoreOtherState");
  const f = fixture(t, avatarSource(RESTORE + unknown));
  for (let pass = 0; pass < 2; pass++) {
    assert.ok(f.optimize().unsupportedFiles.length > 0);
    assertInactive(f, RESTORE_POINT);
    assert.ok(f.read().includes(unknown));
  }
});

function pushSource(exportName = "t", flavorName = "C", registerName = "nue") {
  return `process.platform===\`darwin\`&&${flavorName}===p.${exportName}.Prod&&${registerName}({appServerClient:client,desktopApiOptions:options}).then(()=>{}).catch(e=>logger.warning(\`Failed to register macOS push notifications\`,e));`;
}

for (const exportName of ["t", "i", "$flavor"]) {
  test(`OWL AND push registration preserves platform/flavor semantics with export ${exportName}`, (t) => {
    const f = fixture(t, pushSource(exportName, "$flavor", "registerPush"));
    const result = f.optimize();
    assert.equal(result.macPushRegistration, "gateway-disabled");
    assert.equal(result.patchedFileCount, 1);
    assert.deepEqual(result.unsupportedFiles, []);
    assert.equal(f.point(PUSH_POINT).status, "healthy");
    const run = new Function("process", "$flavor", "p", "registerPush", "client", "options", "logger", f.read());
    for (const platform of ["darwin", "win32", "linux"]) for (const hidden of [undefined, "0", "1"]) for (const flavor of ["prod", "dev"]) {
      const client = {};
      const options = {};
      let calls = 0;
      run({ platform, env: { [ENV]: hidden } }, flavor, { [exportName]: { Prod: "prod" } }, (args) => {
        calls++;
        assert.equal(args.appServerClient, client);
        assert.equal(args.desktopApiOptions, options);
        return Promise.resolve();
      }, client, options, { warning() { assert.fail("registration unexpectedly failed"); } });
      assert.equal(calls, Number(platform === "darwin" && hidden !== "1" && flavor === "prod"));
    }
    assertIdempotent(f, "macPushRegistration", "gateway-disabled");
  });
}

for (const [label, source] of [
  ["non-Prod enum", pushSource().replace(".Prod", ".Dev")],
  ["missing client field", pushSource().replace("appServerClient:", "differentClient:")],
  ["ambiguous extra candidate", "process.platform===`darwin`&&C===p.t.Prod&&nue({appServerClient:client});" + pushSource()],
]) {
  test(`OWL AND push rejects ${label} without rewriting it`, (t) => {
    const f = fixture(t, source);
    for (let pass = 0; pass < 2; pass++) {
      assert.equal(f.optimize().macPushRegistration, "unsupported-layout");
      assert.equal(f.read(), source);
      assertInactive(f, PUSH_POINT);
    }
  });
}

function delegateSource(handler = DELEGATE) {
  return `var services={${handler},other:()=>null};`;
}

function optimizedDelegate(t) {
  const f = fixture(t, delegateSource());
  const result = f.optimize();
  assert.equal(result.worktreeShellEnvironment, "gateway-coalesced");
  assert.equal(result.patchedFileCount, 1);
  assert.deepEqual(result.unsupportedFiles, []);
  assert.equal(f.point(WORKTREE_POINT).status, "healthy");
  assertIdempotent(f, "worktreeShellEnvironment", "gateway-coalesced");
  return f.read();
}

function timerHarness() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, delay) { const timer = { callback, delay, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  };
}

function createDelegate(source, owner, hidden, timers = timerHarness()) {
  // Function 只解释此处构造的最小 fixture；显式注入环境和时钟，不加载官方代码。
  return new Function("process", "setTimeout", "clearTimeout", source + 'return services["worktree-shell-environment-config"];')
    .call(owner, { env: { [ENV]: hidden } }, timers.setTimeout, timers.clearTimeout);
}

test("OWL delegated worktree reads preserve lexical this, arguments and local default", async (t) => {
  const source = optimizedDelegate(t);
  for (const hidden of [undefined, "0", "1"]) {
    const calls = [];
    const value = { shellEnvironment: { PATH: "fixture" } };
    const owner = { readWorktreeShellEnvironment(cwd, host, signal) { assert.equal(this, owner); calls.push({ cwd, host, signal }); return value; } };
    const handler = createDelegate(source, owner, hidden);
    const cwd = { identity: true };
    const signal = new AbortController().signal;
    for (const hostId of [undefined, null, "remote", ""]) {
      assert.equal(await handler({ cwd, hostId, signal }), value);
      assert.deepEqual(calls.at(-1), { cwd, host: hostId ?? "local", signal });
      assert.equal(calls.at(-1).cwd, cwd);
      assert.equal(calls.at(-1).signal, signal);
    }
    assert.equal(calls.length, 4);
    if (hidden !== "1") {
      await handler({ cwd: "/same", hostId: "local" });
      await handler({ cwd: "/same", hostId: "local" });
      assert.equal(calls.length, 6, "desktop calls must never coalesce");
    }
  }
});

test("OWL signal-free hidden worktree calls coalesce only matching host and cwd", async (t) => {
  const source = optimizedDelegate(t);
  const pending = [];
  const owner = { readWorktreeShellEnvironment(cwd, host, signal) { assert.equal(signal, undefined); return new Promise((resolve) => pending.push({ cwd, host, resolve })); } };
  const handler = createDelegate(source, owner, "1");
  const first = handler({ cwd: "/same", hostId: "local" });
  const same = handler({ cwd: "/same", hostId: "local" });
  const remote = handler({ cwd: "/same", hostId: "remote" });
  const other = handler({ cwd: "/different", hostId: "local" });
  await Promise.resolve();
  assert.equal(pending.length, 3);
  for (const call of pending) call.resolve({ shellEnvironment: { cwd: call.cwd, host: call.host } });
  assert.deepEqual(await first, await same);
  assert.deepEqual(await remote, { shellEnvironment: { cwd: "/same", host: "remote" } });
  assert.deepEqual(await other, { shellEnvironment: { cwd: "/different", host: "local" } });
  assert.deepEqual(await handler({ cwd: "/same", hostId: "local" }), await first);
  assert.equal(pending.length, 3);
});

test("OWL worktree timeout keeps null fallback and accepts late successful refresh", async (t) => {
  const source = optimizedDelegate(t);
  const timers = timerHarness();
  let calls = 0;
  let complete;
  const handler = createDelegate(source, { readWorktreeShellEnvironment() { calls++; return new Promise((resolve) => { complete = resolve; }); } }, "1", timers);
  const first = handler({ cwd: "/slow", hostId: "local" });
  await Promise.resolve();
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].delay, 2000);
  timers.timers[0].callback();
  assert.deepEqual(await first, { shellEnvironment: null });
  assert.deepEqual(await handler({ cwd: "/slow", hostId: "local" }), { shellEnvironment: null });
  assert.equal(calls, 1);
  const value = { shellEnvironment: { PATH: "late" } };
  complete(value);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await handler({ cwd: "/slow", hostId: "local" }), value);
  assert.equal(calls, 1);
  assert.equal(timers.timers[0].cleared, true);
});

test("OWL signal-bearing worktree calls retain independent cancellation and bypass cached success", async (t) => {
  const source = optimizedDelegate(t);
  const timers = timerHarness();
  const calls = [];
  const owner = { readWorktreeShellEnvironment(cwd, host, signal) {
    return new Promise((resolve, reject) => {
      calls.push({ cwd, host, signal, resolve, reject });
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } };
  const handler = createDelegate(source, owner, "1", timers);
  // 先缓存无 signal 的成功，再证明携带 signal 的请求不会误拿此缓存。
  const cached = handler({ cwd: "/same", hostId: "local" });
  await Promise.resolve();
  calls[0].resolve({ shellEnvironment: { PATH: "cached" } });
  await cached;
  const first = new AbortController();
  const second = new AbortController();
  const one = handler({ cwd: "/same", hostId: "local", signal: first.signal });
  const two = handler({ cwd: "/same", hostId: "local", signal: second.signal });
  await Promise.resolve();
  assert.equal(calls.length, 3);
  assert.equal(calls[1].signal, first.signal);
  assert.equal(calls[2].signal, second.signal);
  const aborted = assert.rejects(one, /first aborted/);
  first.abort(new Error("first aborted"));
  await aborted;
  assert.equal(second.signal.aborted, false);
  const secondValue = { shellEnvironment: { PATH: "independent" } };
  calls[2].resolve(secondValue);
  assert.equal(await two, secondValue);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error("already aborted"));
  await assert.rejects(handler({ cwd: "/same", hostId: "local", signal: alreadyAborted.signal }), /already aborted/);
  assert.equal(calls.length, 4);
  assert.equal(timers.timers.length, 1, "signal-bearing calls must not create coalescing timeouts");
});

for (const [label, handler] of [
  ["changed delegate name", DELEGATE.replace("this.readWorktreeShellEnvironment", "this.readOtherEnvironment")],
  ["swapped cwd and host", DELEGATE.replace("(e,t??`local`,n)", "(t,e??`local`,n)")],
  ["wrong signal binding", DELEGATE.replace("`local`,n)", "`local`,other)")],
  ["extra trailing operation", DELEGATE + ".then(changeResult)"],
]) {
  test(`OWL worktree delegate rejects ${label} without rewriting it`, (t) => {
    const source = delegateSource(handler);
    const f = fixture(t, source);
    for (let pass = 0; pass < 2; pass++) {
      assert.equal(f.optimize().worktreeShellEnvironment, "unsupported-layout");
      assert.equal(f.read(), source);
      assertInactive(f, WORKTREE_POINT);
    }
  });
}

test("OWL mixed worktree layout remains unsupported after a partial cache rewrite", (t) => {
  const unknown = DELEGATE.replace("this.readWorktreeShellEnvironment", "this.readOtherEnvironment");
  const f = fixture(t, delegateSource() + "var secondServices={" + unknown + ",other:()=>null};");
  for (let pass = 0; pass < 2; pass++) {
    assert.equal(f.optimize().worktreeShellEnvironment, "unsupported-layout");
    assertInactive(f, WORKTREE_POINT);
    assert.ok(f.read().includes(unknown));
  }
});
