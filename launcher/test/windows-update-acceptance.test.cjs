"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ROOT, assertIsolated, assertChild, assertScenario } = require("../../scripts/windows-update-acceptance/safety.cjs");
const good = { username: "WDAGUtilityAccount", root: ROOT, platform: "win32", args: ["--run-isolated"], marker: { purpose: "opencodex-native-update-acceptance", isolated: true } };
test("native acceptance requires every independent Sandbox boundary", () => {
  assert.equal(assertIsolated(good), ROOT);
  // 使用虚构用户目录验证普通安装位置会被拒绝，不记录开发者本机路径。
  for (const override of [{ username: "TestUser" }, { root: "C:\\Users\\TestUser\\AppData\\Local\\Programs\\OpenCodex" }, { platform: "linux" }, { args: [] }, { marker: {} }]) assert.throws(() => assertIsolated({ ...good, ...override }));
});
test("hosted acceptance rejects local and self-hosted runners", () => {
  const hosted = { ...good, username: "runneradmin", args: ["--run-github-hosted"], githubActions: "true", runnerEnvironment: "github-hosted" };
  assert.equal(assertIsolated(hosted), ROOT);
  for (const override of [{ githubActions: undefined }, { githubActions: "false" }, { runnerEnvironment: "self-hosted" }, { runnerEnvironment: undefined }, { args: [] }, { platform: "linux" }, { marker: {} }]) assert.throws(() => assertIsolated({ ...hosted, ...override }));
});
test("guest file operations reject traversal and sibling prefixes", () => {
  assert.equal(assertChild(`${ROOT}\\OpenCodex`), `${ROOT}\\OpenCodex`);
  for (const value of [ROOT, `${ROOT}\\..\\Windows`, `${ROOT}Other\\file`, "C:\\Windows"]) assert.throws(() => assertChild(value));
});
test("rollback acceptance requires full file, registry, process and synthetic-data proof", () => {
  const expected = { status: "rolled-back", version: "1.0.1", restored: true };
  const result = { ...expected, originalExited: true, runningVersionMatches: true, sentinelsUnchanged: true, registryMatches: true, applicationMatches: true, lockReleased: true, failedInstallPreserved: true, gatewayAlive: true, gatewayResponsive: true };
  assert.equal(assertScenario(result, expected), result);
  for (const field of ["originalExited", "runningVersionMatches", "sentinelsUnchanged", "registryMatches", "applicationMatches", "lockReleased", "failedInstallPreserved", "gatewayAlive", "gatewayResponsive"]) assert.throws(() => assertScenario({ ...result, [field]: false }, expected));
  assert.throws(() => assertScenario({ ...result, status: "recovery-needed" }, expected));
  const startup = { ...result, error: "新版启动后退出", targetStarted: true, intentionalExit: true, hasCandidate: true };
  assert.equal(assertScenario(startup, { ...expected, cause: "startup" }), startup);
  for (const changed of [{ error: "spawn failed" }, { targetStarted: false }, { intentionalExit: false }, { hasCandidate: false }]) assert.throws(() => assertScenario({ ...startup, ...changed }, { ...expected, cause: "startup" }));
  const nativeFailure = { ...result, error: "安装器退出失败：13", hasCandidate: false };
  assert.equal(assertScenario(nativeFailure, { ...expected, cause: "installer" }), nativeFailure);
  assert.throws(() => assertScenario({ ...nativeFailure, error: "spawn failed" }, { ...expected, cause: "installer" }));
});
