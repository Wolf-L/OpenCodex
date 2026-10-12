const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const asar = require('@electron/asar');
const { RuntimeVersionStore, inventory } = require('../runtime/runtime-version-store.cjs');
const { assertRuntimeBinding } = require('../runtime/runtime-source-binding.cjs');
const { OfficialBundleCache } = require('../dist/official/OfficialBundleCache.js');
const { OfficialBundleFileSystem } = require('../dist/official/OfficialBundleFileSystem.js');

test('parent prepares a complete version before switching; offline restart and restore retain all sources', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencodex-version-integration-'));
  t.after(() => { asar.uncacheAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (p, value = 'fixture') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value); return p; };
  const app = path.join(root, 'official');
  const resources = path.join(app, 'resources');
  const asarPath = path.join(resources, 'app.asar');
  const exe = write(path.join(app, 'electron'), 'electron-v1');
  const cli = write(path.join(root, 'cli', 'codex'), 'cli-v1');
  const unpacked = write(`${asarPath}.unpacked/native.node`, 'native-v1');
  const input = path.join(root, 'input');
  write(path.join(input, '.vite/build/bootstrap.js'), 'module.exports = {};');
  write(path.join(input, 'webview/index.html'), '<html>fixture</html>');
  write(path.join(input, 'webview/assets/app.js'), 'fixture');
  write(path.join(input, 'node_modules/fixture/index.js'), 'fixture');
  async function archive(version) {
    write(path.join(input, 'package.json'), JSON.stringify({ name: 'codex-fixture', version, buildNumber: version, main: '.vite/build/bootstrap.js' }));
    await asar.createPackage(input, asarPath); asar.uncacheAll();
  }
  await archive('1.0.0');
  const modulePath = path.join(__dirname, '../runner/index.cjs');
  const realRequire = createRequire(modulePath);
  const { LocalCodexBundleProvider: RealProvider } = realRequire('../dist/official/LocalCodexBundleProvider.js');
  let scans = 0, failRunner = false, runnerCalls = 0, damageWorkingCopy = false;
  const forcedRebuilds = [];
  class Provider extends RealProvider {
    constructor(options) {
      super(options);
      const read = this.sourceInfoReader.read.bind(this.sourceInfoReader);
      this.sourceInfoReader.read = (...args) => { assert.equal(process.noAsar, true, 'parent metadata must use physical ASAR access'); return read(...args); };
      this.scanner.find = () => { scans++; return { installRoot: app, resourcesDir: resources, asarPath, codexBinaryPath: cli, layoutKind: 'electron-resources', platformHint: process.platform }; };
    }
  }
  async function createRunner({ runtimeDir, layout, forceRebuild }) {
    runnerCalls++;
    if (forceRebuild) forcedRebuilds.push(runtimeDir);
    if (failRunner) throw new Error('injected runner preparation failure');
    // 只模拟执行文件生成，不运行 fixture；其余快照、ASAR 解包和指针均使用生产实现。
    const runnerRoot = process.platform === 'win32' ? path.join(runtimeDir, 'official-electron-runner', `win32-${process.arch}`) : runtimeDir;
    const executablePath = write(path.join(runnerRoot, 'electron'), fs.readFileSync(layout.executablePath));
    if (damageWorkingCopy && runtimeDir === path.join(root, 'runtime')) write(executablePath, 'electrox-v1');
    return { executablePath, compatibilityPoints: [] };
  }
  const fakeRequire = id => {
    if (id === '../dist/official/LocalCodexBundleProvider.js') return { LocalCodexBundleProvider: Provider };
    if (id === './official-layout.cjs' || id === '../runner/official-layout.cjs') return { findOfficialRuntimeLayout: ({ bundle }) => ({ platform: process.platform, appRoot: bundle.sourceAppPath, runtimeRoot: bundle.sourceAppPath, resourcesDir: bundle.sourceResourcesPath, asarPath: bundle.sourceAsarPath, executablePath: exe }) };
    if (id === './linux-runtime.cjs' || id === '../runner/linux-runtime.cjs') return { assertLinuxRuntimeLayout() {} };
    if (id === './platform/portable.cjs' || id === './platform/macos.cjs') return { createPortableRunner: createRunner, createMacRunner: createRunner };
    return realRequire(id);
  };
  const sandbox = { require: fakeRequire, module: { exports: {} }, process: { ...process, env: {} }, __dirname: path.dirname(modulePath) };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), sandbox);
  const prepare = sandbox.module.exports.prepareOfficialElectronRuntime;
  const base = path.join(root, 'cache/bundle'), store = new RuntimeVersionStore(base);
  const opts = { runtimeDir: path.join(root, 'runtime'), officialBundleDir: base, autoScanUpgrade: true, startRuntime: async (_runtime, confirm) => confirm(() => {}) };
  const first = await prepare(opts);
  const firstId = store.pointer().current;
  assert.equal(scans, 1, 'child snapshot provider must not rescan original install');
  assert.ok(first.runtimeBinding.bundleDir.startsWith(store.root));
  assert.notEqual(first.runtimeBinding.codexBinaryPath, cli);
  const preflightPath = path.join(__dirname, '../runtime/runtime-preflight.cjs');
  const preflightRequire = createRequire(preflightPath);
  const preflightSandbox = { require: id => ['../dist/official/LocalCodexBundleProvider.js', '../runner/official-layout.cjs', '../runner/linux-runtime.cjs'].includes(id) ? fakeRequire(id) : preflightRequire(id),
    module: { exports: {} }, process, __filename: preflightPath, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(preflightPath, 'utf8'), preflightSandbox);
  const beforePreview = inventory(root);
  const preview = preflightSandbox.module.exports.inspectRuntimeUpdate({ officialBundleDir: base, env: {} });
  assert.equal(preview.changed, false);
  assert.equal(preview.retryRequired, false);
  assert.ok(preview.sourceBytes > 0);
  assert.deepEqual(inventory(root), beforePreview, 'preflight must not create or modify files');
  if (process.platform === 'win32') assert.ok(first.executablePath.startsWith(opts.runtimeDir), 'Windows executes a content-verified stable working copy');
  const beforeWarm = runnerCalls;
  await prepare({ ...opts, autoScanUpgrade: false });
  assert.equal(runnerCalls - beforeWarm, 1, 'identical Windows execution copy is not republished');
  if (process.platform === 'win32') {
    // 同大小破坏必须触发强制重建；重建结果仍不一致时拒绝启动且不切换版本指针。
    write(first.executablePath, 'electrox-v1');
    const beforeRepair = forcedRebuilds.length;
    await prepare({ ...opts, autoScanUpgrade: false });
    assert.deepEqual(forcedRebuilds.slice(beforeRepair), [opts.runtimeDir]);
    assert.equal(fs.readFileSync(first.executablePath, 'utf8'), 'electron-v1');
    damageWorkingCopy = true; write(first.executablePath, 'electrox-v1');
    await assert.rejects(prepare({ ...opts, autoScanUpgrade: false }), /Windows 执行副本/);
    assert.equal(store.pointer().current, firstId);
    damageWorkingCopy = false;
    await prepare({ ...opts, autoScanUpgrade: false });
  }
  // 模拟首版虚拟 ASAR 元信息，修复必须在完整内容校验之后执行并重新封存摘要。
  const firstRecord = store.read(firstId);
  const firstManifestPath = path.join(firstRecord.bundleDir, 'manifest.json');
  const firstManifest = JSON.parse(fs.readFileSync(firstManifestPath));
  firstManifest.sourceAsarSize = 0; firstManifest.build = '0-123'; write(firstManifestPath, JSON.stringify(firstManifest));
  store.seal(firstRecord, firstManifest, { executablePath: path.join(firstRecord.dir, firstRecord.runnerExecutable) });
  await prepare({ ...opts, autoScanUpgrade: false });
  assert.ok(JSON.parse(fs.readFileSync(firstManifestPath)).sourceAsarSize > 0);
  store.read(firstId);
  await archive('2.0.0'); write(cli, 'cli-v2'); write(unpacked, 'native-v2');
  failRunner = true;
  // 模拟候选生成失败，但原版本必须仍能准备，以验证只回退一次。
  failRunner = false;
  const failedStarts = [];
  const rolledBack = await prepare({ ...opts, startRuntime: async (runtime, confirm) => {
    const id = path.basename(path.dirname(runtime.runtimeBinding.bundleDir));
    failedStarts.push(id);
    assert.equal(store.pointer().current, firstId, 'pointer remains old until actual confirmation');
    if (id !== firstId) throw new Error('injected candidate boot failure');
    await confirm(() => {});
  } });
  assert.equal(rolledBack.recovery.reason, 'injected candidate boot failure');
  assert.equal(failedStarts.length, 2);
  assert.equal(store.startupState().state, 'failed');
  const skipStarts = [];
  await prepare({ ...opts, startRuntime: async (runtime, confirm) => {
    skipStarts.push(path.basename(path.dirname(runtime.runtimeBinding.bundleDir))); await confirm(() => {});
  } });
  assert.deepEqual(skipStarts, [firstId], 'failed source is not retried by automatic scan');
  let attempts = 0;
  await assert.rejects(prepare({ ...opts, retryFailed: true, startRuntime: async () => { attempts++; throw new Error('both versions fail'); } }), error => error.runtimeFallbackAttempted === true);
  assert.equal(attempts, 2, 'fallback is attempted once, never in an infinite loop');
  assert.equal(store.pointer().current, firstId);
  attempts = 0;
  await assert.rejects(prepare({ ...opts, retryFailed: true, startRuntime: async () => {
    attempts++; const error = new Error('child remains alive'); error.runtimeStopFailed = true; throw error;
  } }), /child remains alive/);
  assert.equal(attempts, 1, 'do not overwrite the working copy while a failed child is still running');
  const retainedCandidate = store.startupState().id;
  assert.ok(fs.existsSync(store.directory(retainedCandidate)), 'never delete a live candidate');
  assert.equal(store.pointer().current, firstId);
  failRunner = false;
  await prepare({ ...opts, retryFailed: true, startRuntime: async (_runtime, confirm) => {
    assert.equal(store.pointer().current, firstId); await confirm(() => {});
  } });
  assert.equal(store.startupState().state, 'confirmed');
  assert.equal(store.pointer().current, retainedCandidate, 'explicit retry reuses the same verified candidate');
  assert.equal(store.pointer().previous, firstId);
  const cache = new OfficialBundleCache({ projectRoot: root, configuredBundleDir: base, logger: { warn() {} }, fileSystem: new OfficialBundleFileSystem() });
  assert.equal(cache.backupState().version, '1.0.0');
  fs.rmSync(app, { recursive: true }); fs.rmSync(path.dirname(cli), { recursive: true });
  const beforeScans = scans;
  const offline = await prepare({ ...opts, autoScanUpgrade: false });
  assert.equal(scans, beforeScans);
  assert.equal(JSON.parse(fs.readFileSync(path.join(offline.runtimeBinding.bundleDir, 'manifest.json'))).version, '2.0.0');
  const restored = await prepare({ ...opts, rollbackPinned: true, selectedVersionId: firstId });
  const manifest = JSON.parse(fs.readFileSync(path.join(restored.runtimeBinding.bundleDir, 'manifest.json')));
  assertRuntimeBinding(restored.runtimeBinding, restored.runtimeBinding.bundleDir, manifest);
  assert.equal(manifest.version, '1.0.0');
  assert.equal(fs.readFileSync(restored.runtimeBinding.codexBinaryPath, 'utf8'), 'cli-v1');
  assert.equal(scans, beforeScans);
});
