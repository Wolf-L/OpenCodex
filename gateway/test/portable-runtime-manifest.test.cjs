const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { __test: { ensurePortableRuntimeCopy } } = require("../runner/platform/portable.cjs");

function createRuntimeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-manifest-copy-"));
  // 所有复制与清理都限定在本测试创建的临时目录，不读取或执行真实的官方安装文件。
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "source");
  const resources = path.join(runtimeRoot, "resources");
  const runnerRootDir = path.join(root, "runner");
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "nested"));
  const executablePath = path.join(runtimeRoot, "ChatGPT.exe");
  const asarPath = path.join(resources, "app.asar");
  fs.writeFileSync(executablePath, "fixture executable, never executed");
  fs.writeFileSync(asarPath, "fixture app archive");
  fs.writeFileSync(path.join(runtimeRoot, "chrome_elf.dll"), "fixture DLL");
  fs.writeFileSync(path.join(runtimeRoot, "nested", "nested.manifest"), "nested fixture");
  fs.writeFileSync(path.join(resources, "app.manifest"), "excluded fixture");
  const manifestNames = ["155.0.8059.40.manifest", "Other.MANIFEST"];
  const sourceSnapshots = new Map();
  for (const name of manifestNames) {
    const sourcePath = path.join(runtimeRoot, name);
    fs.writeFileSync(sourcePath, Buffer.from(`\uFEFF<assembly name="${name}" />\r\n`));
    // 固定旧时间便于验证修复没有把源 mtime 恢复到重新写入的目标上。
    fs.utimesSync(sourcePath, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    sourceSnapshots.set(name, { bytes: fs.readFileSync(sourcePath), mtimeMs: fs.statSync(sourcePath).mtimeMs });
  }
  return {
    layout: { runtimeRoot, appRoot: runtimeRoot, executablePath, asarPath },
    runnerRootDir,
    runnerExecutablePath: path.join(runnerRootDir, "OpenCodex Gateway.exe"),
    markerPath: path.join(root, "runtime-marker.json"),
    manifestNames,
    sourceSnapshots,
  };
}

function trackOrdinaryWrites(t) {
  const writes = [];
  const originalOpenSync = fs.openSync;
  t.mock.method(fs, "openSync", (filePath, flags, ...args) => {
    if (flags === "w") writes.push(filePath);
    return originalOpenSync(filePath, flags, ...args);
  });
  return writes;
}

function assertManifestsRefreshed(fixture) {
  for (const [name, snapshot] of fixture.sourceSnapshots) {
    const sourcePath = path.join(fixture.layout.runtimeRoot, name);
    const targetPath = path.join(fixture.runnerRootDir, name);
    assert.deepEqual(fs.readFileSync(targetPath), snapshot.bytes);
    assert.ok(fs.statSync(targetPath).mtimeMs > snapshot.mtimeMs);
    assert.deepEqual(fs.readFileSync(sourcePath), snapshot.bytes);
    assert.equal(fs.statSync(sourcePath).mtimeMs, snapshot.mtimeMs);
  }
}

test("materializes root Windows assembly manifests through ordinary writes after a fresh runtime copy", (t) => {
  const fixture = createRuntimeFixture(t);
  const writes = trackOrdinaryWrites(t);
  assert.deepEqual(ensurePortableRuntimeCopy({ ...fixture, platform: "win32" }), { copied: true });

  assertManifestsRefreshed(fixture);
  const manifestWrites = writes.filter((filePath) => filePath.toLowerCase().endsWith(".manifest"));
  // 首次复制在隔离目录普通写入清单，验证完成后才整体发布到运行目录。
  assert.deepEqual(manifestWrites.map((filePath) => path.basename(filePath)).sort(), [...fixture.manifestNames].sort());
  assert.equal(manifestWrites.every((filePath) => path.dirname(filePath).startsWith(`${fixture.runnerRootDir}.staging-`)), true);
  assert.equal(fs.readFileSync(path.join(fixture.runnerRootDir, "nested", "nested.manifest"), "utf8"), "nested fixture");
  assert.equal(fs.existsSync(path.join(fixture.runnerRootDir, "resources")), false);
});

test("repairs stale and missing Windows manifests on cache hits without recopying the runtime", (t) => {
  const fixture = createRuntimeFixture(t);
  ensurePortableRuntimeCopy({ ...fixture, platform: "win32" });
  const markerBefore = fs.readFileSync(fixture.markerPath);
  const stalePath = path.join(fixture.runnerRootDir, fixture.manifestNames[0]);
  fs.writeFileSync(stalePath, "stale cached manifest");
  fs.utimesSync(stalePath, new Date("1999-01-01T00:00:00Z"), new Date("1999-01-01T00:00:00Z"));
  fs.unlinkSync(path.join(fixture.runnerRootDir, fixture.manifestNames[1]));
  const unrelatedPath = path.join(fixture.runnerRootDir, "extra-fixture.txt");
  // 缓存命中应保留无关文件；损坏 DLL 现在会正确触发重建，不再用它模拟无关内容。
  fs.writeFileSync(unrelatedPath, "keep unrelated cached files");
  const writes = trackOrdinaryWrites(t);

  assert.deepEqual(ensurePortableRuntimeCopy({ ...fixture, platform: "win32" }), { copied: false });

  assertManifestsRefreshed(fixture);
  assert.deepEqual(writes.sort(), fixture.manifestNames.map((name) => path.join(fixture.runnerRootDir, name)).sort());
  assert.deepEqual(fs.readFileSync(fixture.markerPath), markerBefore);
  assert.equal(fs.readFileSync(unrelatedPath, "utf8"), "keep unrelated cached files");
});

test("leaves non-Windows manifest copying and cache reuse unchanged", (t) => {
  const fixture = createRuntimeFixture(t);
  const writes = trackOrdinaryWrites(t);
  assert.deepEqual(ensurePortableRuntimeCopy({ ...fixture, platform: "linux" }), { copied: true });
  assert.deepEqual(writes.filter((filePath) => filePath.toLowerCase().endsWith(".manifest")), []);
  const cachedPath = path.join(fixture.runnerRootDir, fixture.manifestNames[0]);
  const cachedBytes = fs.readFileSync(cachedPath);
  writes.length = 0;

  assert.deepEqual(ensurePortableRuntimeCopy({ ...fixture, platform: "linux" }), { copied: false });
  assert.deepEqual(writes, []);
  assert.deepEqual(fs.readFileSync(cachedPath), cachedBytes);
  for (const [name, snapshot] of fixture.sourceSnapshots) {
    assert.deepEqual(fs.readFileSync(path.join(fixture.layout.runtimeRoot, name)), snapshot.bytes);
  }
});
