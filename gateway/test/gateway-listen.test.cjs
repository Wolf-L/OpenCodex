const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { DEFAULT_GATEWAY_HOST, normalizeLauncherHostMode } = require("../../shared/gateway-listen.cjs");

test("all platforms default to LAN without overriding an explicit Launcher mode", () => {
  assert.equal(DEFAULT_GATEWAY_HOST, "0.0.0.0");
  for (const mode of [undefined, null, "", "unknown"]) assert.equal(normalizeLauncherHostMode(mode), "lan");
  assert.equal(normalizeLauncherHostMode("local"), "local");
  assert.equal(normalizeLauncherHostMode("lan"), "lan");
  assert.equal(normalizeLauncherHostMode(undefined, "127.0.0.1"), "local");
  assert.equal(normalizeLauncherHostMode("lan", "127.0.0.1"), "lan");
});

test("Launcher, generic gateway and Linux entry consume the same host default", () => {
  // 只验证各入口接线，不导入 Electron、读取真实用户配置或开放网络端口。
  const root = path.resolve(__dirname, "../..");
  for (const file of ["launcher/main.cjs", "gateway/runtime/core/config.cjs", "scripts/linux-common.cjs"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /require\(["'][^"']*shared\/gateway-listen\.cjs["']\)/);
    assert.match(source, /(?:OPENCODEX_HOST|HOST)\s*\|\|\s*DEFAULT_GATEWAY_HOST/);
  }
  const launcher = fs.readFileSync(path.join(root, "launcher/main.cjs"), "utf8");
  assert.match(launcher, /hostMode: normalizeHostMode\(\)/);
  assert.match(launcher, /hostMode: normalizeHostMode\(parsed\.hostMode\)/);
  // 本机健康检查和 PWA URL 仍保持回环，不误把监听范围和本地客户端地址混为一谈。
  assert.match(launcher, /gatewayState\.localUrl = .*127\.0\.0\.1/);
});

test("Launcher renderer starts in LAN mode but preserves local selection", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../launcher/renderer.js"), "utf8");
  const start = source.indexOf("function selectedHostMode()");
  const end = source.indexOf("function renderPort(", start);
  assert.ok(start >= 0 && end > start);
  const inputs = [{ value: "local" }, { value: "lan" }];
  let checked = null;
  const context = vm.createContext({ pendingHostMode: "", document: { querySelector: () => checked, querySelectorAll: () => inputs } });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.selectedHostMode(), "lan");
  context.renderHostMode(undefined);
  assert.equal(inputs[1].checked, true);
  context.renderHostMode("local");
  assert.equal(inputs[0].checked, true);
  checked = inputs[0];
  assert.equal(context.selectedHostMode(), "local");
});

test("gateway config defaults to LAN on Windows, macOS and Linux while honoring HOST", () => {
  const configPath = path.resolve(__dirname, "../runtime/core/config.cjs");
  const source = fs.readFileSync(configPath, "utf8");
  // 独立模块上下文隔离环境变量；只求值配置常量，不启动 HTTP/Electron。
  for (const platform of ["win32", "darwin", "linux"]) {
    for (const host of [undefined, "127.0.0.1", "192.168.1.10"]) {
      const context = { require: createRequire(configPath), module: { exports: {} }, __dirname: path.dirname(configPath), process: { platform, env: host ? { HOST: host } : {}, cwd: () => path.dirname(configPath) } };
      vm.runInNewContext(source, context);
      assert.equal(context.module.exports.HOST, host || "0.0.0.0");
    }
  }
});
