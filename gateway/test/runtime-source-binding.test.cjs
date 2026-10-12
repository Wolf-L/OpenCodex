const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const binding = require("../runtime/runtime-source-binding.cjs");
const { LocalCodexBundleProvider } = require("../dist/official/LocalCodexBundleProvider.js");
const { OfficialBundleCache } = require("../dist/official/OfficialBundleCache.js");
const { OfficialBundleFileSystem } = require("../dist/official/OfficialBundleFileSystem.js");
const { MANIFEST_SCHEMA_VERSION } = require("../dist/official/constants.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value = "fixture") => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    return file;
  };
  const sourceAsarPath = write("old/resources/app.asar", "old-asar");
  const sourceCodexBinaryPath = write("old/resources/codex", "old-cli");
  write("old/resources/app.asar.unpacked/native.node", "old-native");
  const sourceExecutable = write("old/electron", "old-electron");
  const executablePath = write("runner/electron", "copied-electron");
  const bundleDir = path.join(root, "bundle");
  write("bundle/package.json", JSON.stringify({ main: ".vite/build/bootstrap.js" }));
  write("bundle/.vite/build/bootstrap.js");
  write("bundle/node_modules/fixture/index.js");
  write("bundle/webview/index.html");
  write("bundle/webview/assets/main.js");
  const stat = fs.statSync(sourceAsarPath);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sourceAsarPath, sourceCodexBinaryPath,
    sourceAppPath: path.join(root, "old"), sourceResourcesPath: path.dirname(sourceAsarPath),
    sourceAsarSize: stat.size, sourceAsarMtimeMs: Math.trunc(stat.mtimeMs),
    runtimeOptimizations: {}, version: "old", build: "1",
  };
  manifest.sourceIdentity = binding.sourceIdentity(manifest);
  const save = () => write("bundle/manifest.json", JSON.stringify(manifest));
  save();
  const provider = (env = {}) => new LocalCodexBundleProvider({ platform: "linux", bundleDirEnv: bundleDir, env: { CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE: "0", ...env }, logger: { info() {}, warn() {} } });
  const selected = { bundleDir, manifest };
  const prepareBinding = () => binding.createRuntimeBinding(selected, { executablePath: sourceExecutable }, executablePath);
  return { root, write, manifest, save, bundleDir, sourceAsarPath, sourceExecutable, executablePath, provider, prepareBinding };
}

test("disabled scan refuses an in-place official update without refreshing the cached bundle", (t) => {
  const f = fixture(t);
  const provider = f.provider();
  provider.scanner.find = () => assert.fail("must not scan after a source mismatch");
  fs.writeFileSync(f.sourceAsarPath, "new-asar");
  assert.throws(() => provider.ensure({ projectRoot: f.root }), /内容已变化.*启用/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.bundleDir, "manifest.json"))).version, "old");
});

test("rollback pin overrides Linux desktop and CLI overrides without scanning", (t) => {
  const f = fixture(t);
  const provider = f.provider({ [binding.ROLLBACK_PIN_ENV]: "1", CODEX_DESKTOP_APP_PATH: "/new/missing", CODEX_CLI_PATH: "/new/cli", CODEX_APP_SERVER_BINARY_PATH: "/new/server" });
  provider.scanner.find = () => assert.fail("rollback must retain its selected source");
  const result = provider.ensure({ projectRoot: f.root });
  assert.equal(result.sourceAsarPath, f.sourceAsarPath);
  assert.equal(result.codexBinaryPath, f.manifest.sourceCodexBinaryPath);
  // 父进程选定旧版之后，官方 bootstrap 的直接 env 读取也不能拿到新版 CLI。
  const childEnv = { CODEX_CLI_PATH: "/new/cli", CODEX_APP_SERVER_BINARY_PATH: "/new/server", ...binding.runtimeBindingEnvironment(f.prepareBinding()) };
  assert.equal(childEnv.CODEX_CLI_PATH, result.codexBinaryPath);
  assert.equal(childEnv.CODEX_APP_SERVER_BINARY_PATH, result.codexBinaryPath);
  assert.equal(childEnv.CODEX_DESKTOP_APP_PATH, result.sourceAsarPath);
});

test("rollback rejects a changed native module even if app.asar remains unchanged", (t) => {
  const f = fixture(t);
  f.write("old/resources/app.asar.unpacked/native.node", "new-native");
  assert.throws(() => f.provider({ [binding.ROLLBACK_PIN_ENV]: "1" }).ensure({ projectRoot: f.root }), /无法启动已固定.*内容已变化/);
});

test("child consumes the prepared binding without rescanning explicit Linux sources", (t) => {
  const f = fixture(t);
  const provider = f.provider({ [binding.RUNTIME_BINDING_ENV]: JSON.stringify(f.prepareBinding()), CODEX_DESKTOP_APP_PATH: "/other/install" });
  provider.scanner.find = () => assert.fail("child must not rescan");
  assert.equal(provider.ensure({ projectRoot: f.root }).version, "old");
});

test("content-bound startup accepts a timestamp-only ASAR change in both parent and child", (t) => {
  const f = fixture(t);
  // 安装器触碰时间戳但未改字节时，父子两端应一致地使用内容身份。
  const changedTime = new Date(Date.now() + 60_000);
  fs.utimesSync(f.sourceAsarPath, changedTime, changedTime);
  assert.equal(f.provider().ensure({ projectRoot: f.root }).version, "old");
  const child = f.provider({ [binding.RUNTIME_BINDING_ENV]: JSON.stringify(f.prepareBinding()) });
  child.scanner.find = () => assert.fail("bound child must not rescan");
  assert.equal(child.ensure({ projectRoot: f.root }).version, "old");
  fs.writeFileSync(f.sourceAsarPath, "new-asar");
  assert.throws(() => child.ensure({ projectRoot: f.root }), /准备后发生变化/);
});

for (const changed of ["asar", "cli", "source-electron", "runner-electron", "manifest"]) {
  test(`launch binding rejects ${changed} changes after preparation`, (t) => {
    const f = fixture(t);
    const prepared = f.prepareBinding();
    if (changed === "asar") fs.writeFileSync(f.sourceAsarPath, "new-asar");
    if (changed === "cli") fs.writeFileSync(f.manifest.sourceCodexBinaryPath, "new-cli");
    if (changed === "source-electron") fs.writeFileSync(f.sourceExecutable, "new-electron");
    if (changed === "runner-electron") fs.writeFileSync(f.executablePath, "new-runner");
    if (changed === "manifest") { f.manifest.version = "different"; f.save(); }
    assert.throws(() => binding.assertRuntimeBinding(prepared, f.bundleDir, f.manifest), /准备后发生变化/);
  });
}

test("legacy backup with a changed source is unavailable instead of offering a false rollback", (t) => {
  const f = fixture(t);
  delete f.manifest.sourceIdentity;
  f.save();
  fs.renameSync(f.bundleDir, `${f.bundleDir}-bak`);
  fs.writeFileSync(f.sourceAsarPath, "updated-with-a-different-size");
  const cache = new OfficialBundleCache({ projectRoot: f.root, configuredBundleDir: f.bundleDir, logger: { warn() {} }, fileSystem: new OfficialBundleFileSystem() });
  assert.equal(cache.backupState().available, false);
  assert.match(cache.backupState().reason, /身份已变化/);
});

test("backup status avoids content reads but actual restore rejects changed native contents", (t) => {
  const f = fixture(t);
  fs.renameSync(f.bundleDir, `${f.bundleDir}-bak`);
  f.write("old/resources/app.asar.unpacked/native.node", "new-native");
  const cache = new OfficialBundleCache({ projectRoot: f.root, configuredBundleDir: f.bundleDir, logger: { warn() {} }, fileSystem: new OfficialBundleFileSystem() });
  const originalOpen = fs.openSync;
  fs.openSync = (file, ...args) => {
    assert.notEqual(file, f.sourceAsarPath, "display status must not hash app.asar");
    return originalOpen(file, ...args);
  };
  try { assert.equal(cache.backupState().available, true); }
  finally { fs.openSync = originalOpen; }
  assert.throws(() => cache.restoreBackup(), /内容已变化/);
  assert.ok(fs.existsSync(`${f.bundleDir}-bak`));
});

test("a source change during extraction never publishes a mixed bundle", (t) => {
  const f = fixture(t);
  const provider = f.provider({ CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE: "1" });
  provider.scanner.find = () => ({});
  provider.sourceInfoReader.read = () => ({
    installRoot: f.manifest.sourceAppPath, resourcesDir: f.manifest.sourceResourcesPath,
    asarPath: f.sourceAsarPath, codexBinaryPath: f.manifest.sourceCodexBinaryPath,
    sourceAsarSize: f.manifest.sourceAsarSize, sourceAsarMtimeMs: f.manifest.sourceAsarMtimeMs,
  });
  // 清除旧摘要触发升级；测试只替换解包动作，保留发布前的真实来源复核。
  delete f.manifest.sourceIdentity;
  f.save();
  provider.extractor.extract = () => { fs.writeFileSync(f.manifest.sourceCodexBinaryPath, "updated-cli"); return { fileCount: 1, byteCount: 1 }; };
  provider.runtimeOptimizer.optimize = () => ({});
  assert.throws(() => provider.ensure({ projectRoot: f.root }), /解包过程中发生变化/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.bundleDir, "manifest.json"))).version, "old");
  assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith("bundle.tmp-")), false);
});

test("physical ASAR reads restore the previous Electron setting on failure", () => {
  const previous = process.noAsar;
  process.noAsar = false;
  try {
    assert.throws(() => binding.withPhysicalAsarAccess(() => { assert.equal(process.noAsar, true); throw new Error("fixture"); }), /fixture/);
    assert.equal(process.noAsar, false);
  } finally { process.noAsar = previous; }
});

test("runner selects a bundle before choosing layout and rejects changes while copying", async (t) => {
  const f = fixture(t);
  const events = [];
  const selected = { bundleDir: f.bundleDir, manifest: f.manifest };
  const fakeRequire = (id) => {
    if (id === "../dist/official/LocalCodexBundleProvider.js") return { LocalCodexBundleProvider: class { ensure() { events.push("bundle"); return selected; } } };
    if (id === "./official-layout.cjs") return { findOfficialRuntimeLayout(options) { events.push("layout"); assert.equal(options.bundle, selected); assert.equal(options.rollbackPinned, true); return { executablePath: f.sourceExecutable }; } };
    if (id === "./linux-runtime.cjs") return { assertLinuxRuntimeLayout() {} };
    if (id === "./platform/portable.cjs" || id === "./platform/macos.cjs") return { createPortableRunner: copy, createMacRunner: copy };
    if (id === "../runtime/compatibility/service.cjs") return { createCompatibilityService: () => ({ dispose() {} }) };
    if (id === "../runtime/modification/production-runtime.cjs") return { createHostModificationRuntime: () => ({ points: { runner: {} }, coordinator: { async dispose() {} } }) };
    if (id === "../runtime/runtime-source-binding.cjs") return binding;
    return require(id);
  };
  async function copy() { events.push("copy"); fs.writeFileSync(f.sourceExecutable, "updated-during-copy"); return { executablePath: f.executablePath }; }
  const source = fs.readFileSync(path.join(__dirname, "../runner/index.cjs"), "utf8");
  const sandbox = { require: fakeRequire, module: { exports: {} }, process, __dirname: path.join(__dirname, "../runner") };
  vm.runInNewContext(source, sandbox);
  await assert.rejects(sandbox.module.exports.prepareOfficialElectronRuntime({ runtimeDir: f.root, officialBundleDir: f.bundleDir, rollbackPinned: true }), /准备过程中发生变化/);
  assert.deepEqual(events, ["bundle", "layout", "copy"]);
});
