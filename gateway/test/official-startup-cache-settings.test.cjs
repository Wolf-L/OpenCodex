const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  readOfficialStartupCacheSettings,
} = require("../runtime/electron/official-startup-cache-settings.cjs");

function temporaryRuntime(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-startup-settings-"));
  // 用例只清理自己创建的临时目录，不访问真实账号或运行时 profile。
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function settingsPath(directory) {
  return path.join(directory, "official-startup-cache.json");
}

test("missing startup cache opt-in stays disabled without creating directories", (t) => {
  const root = temporaryRuntime(t);
  const runtime = path.join(root, "not-created");
  assert.deepEqual(readOfficialStartupCacheSettings(runtime), {
    enabled: false,
    reason: "missing",
    settingsPath: settingsPath(runtime),
    directory: path.join(runtime, "cache", "official-startup-responses"),
  });
  assert.deepEqual(fs.readdirSync(root), []);
});

test("only an explicit boolean setting with the supported schema enables caching", (t) => {
  const runtime = temporaryRuntime(t);
  for (const enabled of [true, false]) {
    fs.writeFileSync(settingsPath(runtime), JSON.stringify({ schemaVersion: 1, enabled }));
    const result = readOfficialStartupCacheSettings(runtime);
    assert.equal(result.enabled, enabled);
    assert.equal(result.reason, enabled ? "enabled" : "disabled");
    assert.deepEqual(fs.readdirSync(runtime), ["official-startup-cache.json"]);
  }
});

test("invalid JSON, schema, types, and unknown fields fail closed", (t) => {
  const runtime = temporaryRuntime(t);
  const invalid = [
    "", "{", "null", "[]", "true", "1",
    JSON.stringify({ enabled: true }),
    JSON.stringify({ schemaVersion: 2, enabled: true }),
    JSON.stringify({ schemaVersion: "1", enabled: true }),
    JSON.stringify({ schemaVersion: 1, enabled: "true" }),
    JSON.stringify({ schemaVersion: 1, enabled: 1 }),
    JSON.stringify({ schemaVersion: 1, enabled: true, directory: "/untrusted" }),
  ];
  for (const value of invalid) {
    fs.writeFileSync(settingsPath(runtime), value);
    const result = readOfficialStartupCacheSettings(runtime);
    assert.equal(result.enabled, false);
    assert.equal(result.reason, "invalid");
  }
});

test("oversized settings are rejected instead of being read without a bound", (t) => {
  const runtime = temporaryRuntime(t);
  const valid = JSON.stringify({ schemaVersion: 1, enabled: true });
  fs.writeFileSync(settingsPath(runtime), valid.padEnd(8193, " "));
  const result = readOfficialStartupCacheSettings(runtime);
  assert.equal(result.enabled, false);
  assert.equal(result.reason, "oversize");
  fs.writeFileSync(settingsPath(runtime), valid.padEnd(8192, " "));
  assert.equal(readOfficialStartupCacheSettings(runtime).enabled, true);
});

test("a directory in place of the settings file is rejected", (t) => {
  const runtime = temporaryRuntime(t);
  fs.mkdirSync(settingsPath(runtime));
  const result = readOfficialStartupCacheSettings(runtime);
  assert.equal(result.enabled, false);
  assert.equal(result.reason, "non-regular");
});

test("a symlink in place of the settings file is rejected", (t) => {
  const runtime = temporaryRuntime(t);
  const target = path.join(runtime, "target.json");
  fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, enabled: true }));
  try {
    fs.symlinkSync(target, settingsPath(runtime), "file");
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    // 未启用 Windows 开发者模式时，用免提权的目录 junction 验证同一拒绝分支。
    const junctionTarget = path.join(runtime, "junction-target");
    fs.mkdirSync(junctionTarget);
    fs.symlinkSync(junctionTarget, settingsPath(runtime), "junction");
  }
  const result = readOfficialStartupCacheSettings(runtime);
  assert.equal(result.enabled, false);
  assert.equal(result.reason, "symlink");
});

test("unreadable settings fail closed without exposing filesystem error details", (t) => {
  const runtime = temporaryRuntime(t);
  fs.writeFileSync(settingsPath(runtime), JSON.stringify({ schemaVersion: 1, enabled: true }));
  t.mock.method(fs, "openSync", () => {
    throw Object.assign(new Error("sensitive filesystem detail"), { code: "EACCES" });
  });
  const result = readOfficialStartupCacheSettings(runtime);
  assert.equal(result.enabled, false);
  assert.equal(result.reason, "unreadable");
  assert.equal(JSON.stringify(result).includes("sensitive filesystem detail"), false);
});

test("settings changing between stat and open are rejected", (t) => {
  const runtime = temporaryRuntime(t);
  fs.writeFileSync(settingsPath(runtime), JSON.stringify({ schemaVersion: 1, enabled: true }));
  const originalFstat = fs.fstatSync;
  t.mock.method(fs, "fstatSync", (...args) => {
    const stat = originalFstat(...args);
    // Windows 的 inode 数值可能超过安全整数，+1 会被浮点舍入；明确换成不同值才能稳定模拟替换。
    stat.ino = stat.ino === 0 ? 1 : 0;
    return stat;
  });
  assert.equal(readOfficialStartupCacheSettings(runtime).reason, "changed");
});
