const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { configureStartupCache } = require("../../scripts/linux-cache.cjs");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-linux-cache-"));
  // 只清理本测试创建的隔离目录，绝不访问真实账号或用户缓存。
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, runtime: path.join(root, "runtime") };
}
test("deployment opt-in creates private settings without changing account/config files", t => {
  const { root, runtime } = fixture(t);
  fs.writeFileSync(path.join(root, "config.yaml"), "existing-private-config");
  const state = configureStartupCache(runtime, true, { ifMissing: true });
  assert.equal(state.enabled, true);
  assert.equal(state.changed, true);
  assert.equal(fs.readFileSync(path.join(root, "config.yaml"), "utf8"), "existing-private-config");
  assert.deepEqual(fs.readdirSync(runtime), ["official-startup-cache.json"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(state.settingsPath).mode & 0o777, 0o600);
});
test("upgrades preserve explicit disabled, invalid and symlink settings", t => {
  const { runtime } = fixture(t);
  const state = configureStartupCache(runtime, false);
  assert.equal(configureStartupCache(runtime, true, { ifMissing: true }).enabled, false);
  fs.writeFileSync(state.settingsPath, "invalid-json");
  assert.equal(configureStartupCache(runtime, true, { ifMissing: true }).changed, false);
  assert.throws(() => configureStartupCache(runtime, true), /invalid/);
  fs.unlinkSync(state.settingsPath);
  const target = path.join(runtime, "target");
  fs.mkdirSync(target);
  fs.symlinkSync(target, state.settingsPath, process.platform === "win32" ? "junction" : "dir");
  assert.equal(configureStartupCache(runtime, true, { ifMissing: true }).reason, "symlink");
  assert.throws(() => configureStartupCache(runtime, true), /symlink/);
});
test("explicit enable/disable preserves existing snapshot bytes", t => {
  const { runtime } = fixture(t);
  configureStartupCache(runtime, true);
  const cache = path.join(runtime, "cache");
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, "saved-response"), "synthetic-private-response");
  assert.equal(configureStartupCache(runtime, false).enabled, false);
  assert.equal(configureStartupCache(runtime, true).enabled, true);
  assert.equal(fs.readFileSync(path.join(cache, "saved-response"), "utf8"), "synthetic-private-response");
  assert.deepEqual(fs.readdirSync(runtime).sort(), ["cache", "official-startup-cache.json"]);
});
