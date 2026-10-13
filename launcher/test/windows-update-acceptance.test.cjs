"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ROOT, assertIsolated, assertChild, assertScenario } = require("../../scripts/windows-update-acceptance/safety.cjs");
const good = { username: "WDAGUtilityAccount", root: ROOT, platform: "win32", args: ["--run-isolated"], marker: { purpose: "opencodex-native-update-acceptance", isolated: true } };
test("native acceptance requires every independent Sandbox boundary", () => {
  assert.equal(assertIsolated(good), ROOT);
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
  const result = { ...expected, originalExited: true, runningVersionMatches: true, sentinelsUnchanged: true, registryMatches: true, applicationMatches: true, lockReleased: true, failedInstallPreserved: true };
  assert.equal(assertScenario(result, expected), result);
  for (const field of ["originalExited", "runningVersionMatches", "sentinelsUnchanged", "registryMatches", "applicationMatches", "lockReleased", "failedInstallPreserved"]) assert.throws(() => assertScenario({ ...result, [field]: false }, expected));
  assert.throws(() => assertScenario({ ...result, status: "recovery-needed" }, expected));
});
