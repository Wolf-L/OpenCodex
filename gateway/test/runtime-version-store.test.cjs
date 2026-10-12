const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RuntimeVersionStore, resolveBundleDirectory, inventory, hash } = require("../runtime/runtime-version-store.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-versions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, body = 'fixture') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
  const source = path.join(root, 'official');
  const asarPath = write(path.join(source, 'resources', 'app.asar'), 'asar-v1');
  const executablePath = write(path.join(source, 'electron'), 'exe-v1');
  const cli = write(path.join(root, 'external-cli', 'codex'), 'cli-v1');
  write(path.join(source, 'resources', 'app.asar.unpacked', 'native.node'), 'native-v1');
  write(path.join(source, 'locales', 'zh.pak'), 'locale-v1');
  const layout = { platform: process.platform, appRoot: source, runtimeRoot: source, resourcesDir: path.dirname(asarPath), asarPath, executablePath };
  const info = { installRoot: source, resourcesDir: path.dirname(asarPath), asarPath, unpackedAsarDir: `${asarPath}.unpacked`, codexBinaryPath: cli, version: '1', build: '1' };
  const store = new RuntimeVersionStore(path.join(root, 'cache', 'bundle'));
  const prepare = () => {
    const candidate = store.snapshot(layout, info, store.sourcePlan(layout, info));
    write(path.join(candidate.dir, 'bundle', 'manifest.json'), JSON.stringify({ version: info.version }));
    const exe = write(path.join(candidate.dir, 'runner', 'electron'), 'runner');
    store.seal(candidate, info, { executablePath: exe });
    return candidate;
  };
  return { root, source, write, layout, info, store, prepare, cli };
}

test('snapshot binds source, native resources, external CLI, bundle and runner after original removal', t => {
  const f = fixture(t), v = f.prepare();
  f.store.activate(v.id, null);
  fs.rmSync(f.source, { recursive: true });
  fs.rmSync(path.dirname(f.cli), { recursive: true });
  const record = f.store.read(v.id);
  assert.equal(record.version, '1');
  assert.equal(fs.readFileSync(v.sourceInfo.codexBinaryPath, 'utf8'), 'cli-v1');
  assert.equal(resolveBundleDirectory(f.store.bundleDir), path.join(v.dir, 'bundle'));
});
test('previous version restores all components without accessing original installation', t => {
  const f = fixture(t), old = f.prepare();
  f.store.activate(old.id, null);
  f.info.version = '2'; f.write(f.layout.asarPath, 'asar-v2');
  const next = f.prepare(); f.store.activate(next.id, f.store.pointer());
  fs.rmSync(f.source, { recursive: true }); fs.rmSync(path.dirname(f.cli), { recursive: true });
  f.store.restore();
  assert.equal(f.store.pointer().current, old.id);
  assert.equal(f.store.pointer().previous, next.id);
  assert.equal(f.store.read(old.id).version, '1');
});
for (const component of ['source/runtime/locales/zh.pak', 'source/cli/codex', 'bundle/manifest.json', 'runner/electron']) {
  test(`same-size corruption prevents activation: ${component}`, t => {
    const f = fixture(t), v = f.prepare();
    const file = path.join(v.dir, component); const data = fs.readFileSync(file); data[0] ^= 1; fs.writeFileSync(file, data);
    assert.throws(() => f.store.activate(v.id, null), /校验失败/);
    assert.equal(f.store.pointer(), null);
  });
}
test('new pointer write failure leaves previous version selected', t => {
  const f = fixture(t), old = f.prepare(); f.store.activate(old.id, null);
  const next = f.prepare(); const before = fs.readFileSync(f.store.pointerPath, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === f.store.pointerPath) throw new Error('injected publication failure'); return rename(from, to); };
  try { assert.throws(() => f.store.activate(next.id, f.store.pointer()), /injected/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.store.pointerPath, 'utf8'), before);
  assert.equal(f.store.read(old.id).version, '1');
});
test('source changes between planning and copying do not publish mixed snapshot', t => {
  const f = fixture(t), plan = f.store.sourcePlan(f.layout, f.info);
  f.write(f.layout.asarPath, 'changed');
  assert.throws(() => f.store.snapshot(f.layout, f.info, plan), /复制期间变化/);
  assert.equal(f.store.pointer(), null);
  assert.deepEqual(fs.readdirSync(f.store.root), []);
});
test('concurrent preparation and stale pointer overwrite are rejected', async t => {
  const f = fixture(t), v = f.prepare();
  await f.store.locked(async () => {
    await assert.rejects(() => f.store.locked(async () => {}), /已有运行时准备任务/);
    assert.throws(() => f.store.restore(), /EEXIST/);
  });
  f.store.activate(v.id, null);
  assert.throws(() => f.store.activate(f.prepare().id, null), /另一任务修改/);
  assert.equal(fs.existsSync(path.join(f.store.root, 'prepare.lock')), false);
});
test('malformed pointer and mismatched platform fail closed', t => {
  const f = fixture(t), v = f.prepare();
  f.write(f.store.pointerPath, JSON.stringify({ schemaVersion: 1, current: '../escape', previous: null }));
  assert.throws(() => f.store.pointer(), /指针无效/);
  const recordPath = path.join(v.dir, 'version.json'); const record = JSON.parse(fs.readFileSync(recordPath)); record.arch = 'invalid';
  f.write(recordPath, JSON.stringify(record)); assert.throws(() => f.store.read(v.id), /架构不匹配/);
});
test('snapshot refuses source/store overlap', t => {
  const f = fixture(t), nested = new RuntimeVersionStore(path.join(f.source, 'cache'));
  assert.throws(() => nested.sourcePlan(f.layout, f.info), /重叠/);
});
test('inventory hashes file content rather than mtime', t => {
  const f = fixture(t), before = hash(inventory(f.source));
  fs.utimesSync(f.layout.asarPath, new Date(), new Date(Date.now() + 5000));
  assert.equal(hash(inventory(f.source)), before);
  f.write(f.layout.asarPath, 'asar-v2'); assert.notEqual(hash(inventory(f.source)), before);
});
test('external symlinks are refused and internal directory links stay inside snapshots', t => {
  const f = fixture(t);
  const outside = path.join(f.source, 'outside');
  fs.symlinkSync(path.dirname(f.cli), outside, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inventory(f.source), /越界/); fs.unlinkSync(outside);
  const link = path.join(f.source, 'locales-link');
  fs.symlinkSync(path.join(f.source, 'locales'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const v = f.prepare();
  assert.equal(fs.readFileSync(path.join(v.dir, 'source/runtime/locales-link/zh.pak'), 'utf8'), 'locale-v1');
  assert.ok(fs.realpathSync(path.join(v.dir, 'source/runtime/locales-link')).startsWith(v.dir));
});
