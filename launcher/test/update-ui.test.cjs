const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(locale = "zh-CN") {
  const source = fs.readFileSync(path.join(__dirname, "../renderer.js"), "utf8");
  const nodes = new Map();
  const context = vm.createContext({
    $: id => {
      if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, textContent: "", removeAttribute() {}, setAttribute() {} });
      return nodes.get(id);
    },
    currentMessages: require(`../../shared/i18n/locales/${locale}.json`), document: { querySelectorAll: () => [] },
  });
  // 使用真实渲染函数验证用户可见状态，DOM 夹具只提供这些函数用到的属性。
  vm.runInContext(source.slice(source.indexOf("function t("), source.indexOf("function applyI18n(")) +
    source.slice(source.indexOf("function renderLatestRelease("), source.indexOf("function formatDateTime(")), context);
  context.text = (id, value) => { context.$(id).textContent = value; };
  return { context, node: context.$ };
}

test("release status distinguishes network failure, missing installer and up-to-date in both languages", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const { context, node } = fixture(locale);
    const visible = new Set();
    for (const status of ["idle", "checking", "no-compatible-release", "up-to-date", "error"]) {
      context.renderLatestRelease({ status, checking: status === "checking", platform: "win32", arch: "x64", error: "HTTP 429" });
      const text = node("latestReleaseStatus").textContent;
      assert.ok(text && !text.startsWith("launcher.")); visible.add(text);
      assert.equal(node("openLatestRelease").hidden, true);
      assert.equal(node("checkLatestRelease").disabled, status === "checking");
    }
    assert.equal(visible.size, 5);
    context.renderLatestRelease({ status: "available", available: true, tagName: "v2.2.0", platform: "win32", arch: "x64" });
    assert.equal(node("openLatestRelease").hidden, false);
    assert.equal(node("latestReleaseButton").hidden, false);
    assert.match(node("latestReleaseStatus").textContent, /v2.2.0.*win32\/x64/);
  }
});

test("runtime actions remain disabled throughout revalidation and restart", () => {
  const { context, node } = fixture();
  const report = { ok: true, changed: true, version: "26.1", platform: "win32", arch: "x64", estimatedAdditionalBytes: 100, availableBytes: 1000 };
  for (const phase of ["validating", "restarting"]) {
    context.renderRuntimeUpdate({ runtimePreflight: report, runtimeUpdatePhase: phase });
    assert.equal(node("checkRuntimeUpdate").disabled, true);
    assert.equal(node("applyRuntimeUpdate").disabled, true);
    assert.equal(node("runtimePreflightStatus").hidden, false);
    assert.match(node("runtimePreflightStatus").textContent, phase === "validating" ? /继续运行/ : /暂时中断/);
  }
  context.renderRuntimeUpdate({ runtimePreflight: report, runtimeUpdateBusy: true });
  assert.equal(node("applyRuntimeUpdate").disabled, true);
  context.renderRuntimeUpdate({ runtimePreflight: report });
  assert.equal(node("applyRuntimeUpdate").disabled, false);
  context.renderRuntimeUpdate({ runtimePreflight: { ok: false, error: "source changed" } });
  assert.equal(node("applyRuntimeUpdate").hidden, true);
  assert.equal(node("runtimePreflightStatus").textContent, "source changed");
});

test("foreground and manual release checks share one request and expose a finished state", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8");
  let finish, requests = 0;
  const context = vm.createContext({ selfUpdateController: null, gatewayState: { latestRelease: {} }, latestReleaseCheckPromise: null,
    OPENCODEX_VERSION_LABEL: "2.1.0", broadcastState() {}, markLatestReleaseChecking: () => ({ checking: true }),
    fetchLatestReleaseState: () => { requests++; return new Promise(resolve => { finish = resolve; }); } });
  vm.runInContext(source.slice(source.indexOf("async function checkLatestRelease()"), source.indexOf("function checkLatestReleaseForForeground()")), context);
  const first = context.checkLatestRelease(), second = context.checkLatestRelease();
  await Promise.resolve();
  assert.equal(context.gatewayState.latestRelease.checking, true);
  finish({ checking: false, status: "up-to-date" });
  await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.equal(context.latestReleaseCheckPromise, null);
  assert.equal(context.gatewayState.latestRelease.status, "up-to-date");
});

test("Windows download, cancel and install are separate actions, with controls locked during install", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const { context, node } = fixture(locale);
    const state = { latestRelease: { available: true, downloadable: true }, selfUpdate: { supported: true, status: "downloading", percent: 43, targetVersion: "2.2.0" } };
    context.renderSelfUpdate(state);
    assert.equal(node("cancelUpdate").hidden, false); assert.equal(node("installUpdate").hidden, true);
    assert.match(node("selfUpdateStatus").textContent, /43/);
    state.selfUpdate.status = "ready"; context.renderSelfUpdate(state);
    assert.equal(node("installUpdate").hidden, false); assert.equal(node("downloadUpdate").hidden, true);
    state.selfUpdate.status = "preparing"; state.selfUpdate.installing = true; context.renderSelfUpdate(state);
    assert.equal(node("restart").disabled, true); assert.equal(node("cancelUpdate").hidden, true);
    assert.equal(node("savePassword").disabled, true);
    state.selfUpdate.status = "error"; state.selfUpdate.installing = false; state.selfUpdate.error = "test failure"; context.renderSelfUpdate(state);
    assert.equal(node("restart").disabled, false); assert.equal(node("preventSleepInput").disabled, false);
    assert.match(node("selfUpdateStatus").textContent, /test failure/);
    state.latestRelease.downloadable = false; state.selfUpdate.status = "idle"; context.renderSelfUpdate(state);
    assert.equal(node("downloadUpdate").hidden, true); assert.equal(node("selfUpdateStatus").hidden, false);
  }
});
