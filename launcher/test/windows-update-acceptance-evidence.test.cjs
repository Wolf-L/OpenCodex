"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { journalEvidence, sanitizeEvidence } = require("../../scripts/windows-update-acceptance/evidence.cjs");

test("exported terminal journals retain diagnostic proof without transaction credentials", () => {
  // 合成令牌与未知字段验证导出边界，不使用本机账户或任何真实更新事务。
  const token = "synthetic-transaction-token";
  for (const status of ["completed", "rolled-back", "cancelled", "recovery-needed"]) {
    const source = { schemaVersion: 1, transactionId: "fixture-id", token, status, targetVersion: "1.0.2", currentVersion: "1.0.1", sha256: "a".repeat(64), error: `failure ${token}`, futureCredential: "private", futureField: { value: "private" }, parent: { pid: 101, parentPid: 100, born: "2026-01-01T00:00:00Z", exePath: "C:\\OpenCodexAcceptance\\OpenCodex.exe", token, futureField: "private" }, registry: [{ key: "fixture-key", file: "fixture.reg", size: 12, sha256: "b".repeat(64), secret: token }] };
    const before = structuredClone(source);
    const result = journalEvidence(source);
    assert.deepEqual(result, { schemaVersion: 1, transactionId: "fixture-id", status, targetVersion: "1.0.2", currentVersion: "1.0.1", sha256: "a".repeat(64), error: "failure [REDACTED]", parent: { pid: 101, parentPid: 100, exePath: source.parent.exePath, born: source.parent.born }, registry: [{ key: "fixture-key", file: "fixture.reg", size: 12, sha256: "b".repeat(64) }] });
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.deepEqual(source, before);
  }
});

test("structured event and result evidence removes nested credential fields", () => {
  const input = { passed: false, scenarios: [{ status: "rolled-back", OPENCODEX_UPDATE_TOKEN: "synthetic-token", metadata: { api_key: "synthetic-key", authorization: "synthetic-auth", password: "synthetic-password", value: "diagnostic" } }], error: "synthetic-token", count: 3, missing: null };
  const before = structuredClone(input);
  assert.deepEqual(sanitizeEvidence(input, ["synthetic-token"]), { passed: false, scenarios: [{ status: "rolled-back", metadata: { value: "diagnostic" } }], error: "[REDACTED]", count: 3, missing: null });
  assert.deepEqual(input, before);
});
