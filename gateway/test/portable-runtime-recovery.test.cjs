const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const { NtExecutable } = require("resedit");
const { createPortableRunner, __test: { ensurePortableRuntimeCopy } } = require("../runner/platform/portable.cjs");
const { patchWindowsRunnerAsarIntegrity } = require("../runner/platform/windows-integrity.cjs");

const hash = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-recovery-"));
  // 所有损坏与故障注入只操作本测试生成的临时文件，绝不执行 PE 或读取真实安装。
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "resources"), { recursive: true });
  fs.mkdirSync(path.join(source, "locales"));
  const executablePath = path.join(source, "ChatGPT.exe");
  const asarPath = path.join(source, "resources", "app.asar");
  fs.writeFileSync(executablePath, Buffer.from(NtExecutable.createEmpty(false).generate()));
  fs.writeFileSync(asarPath, "official archive fixture");
  fs.writeFileSync(path.join(source, "chrome.dll"), "required dll fixture");
  fs.writeFileSync(path.join(source, "locales", "en-US.pak"), "old-pack");
  const runnerRootDir = path.join(root, "runner");
  return {
    root, layout: { runtimeRoot: source, appRoot: source, executablePath, asarPath },
    runnerRootDir, runnerExecutablePath: path.join(runnerRootDir, "OpenCodex Gateway.exe"),
    markerPath: path.join(root, "marker.json"), runtimeDir: path.join(root, "runtime"), platform: "win32",
  };
}

for (const damaged of ["exe", "dll", "directory", "truncated DLL", "truncated locale"]) {
  test(`rebuilds once when cached ${damaged} is damaged or missing`, (t) => {
    const f = fixture(t);
    ensurePortableRuntimeCopy(f);
    const sourceHash = hash(f.layout.executablePath);
    if (damaged === "exe") fs.writeFileSync(f.runnerExecutablePath, "broken PE");
    if (damaged === "dll") fs.unlinkSync(path.join(f.runnerRootDir, "chrome.dll"));
    if (damaged === "directory") fs.rmSync(path.join(f.runnerRootDir, "locales"), { recursive: true });
    if (damaged === "truncated DLL") fs.writeFileSync(path.join(f.runnerRootDir, "chrome.dll"), "short");
    if (damaged === "truncated locale") fs.writeFileSync(path.join(f.runnerRootDir, "locales", "en-US.pak"), "short");
    assert.deepEqual(ensurePortableRuntimeCopy(f), { copied: true });
    assert.equal(hash(f.runnerExecutablePath), sourceHash);
    assert.ok(fs.existsSync(path.join(f.runnerRootDir, "chrome.dll")));
    assert.equal(fs.readFileSync(path.join(f.runnerRootDir, "locales", "en-US.pak"), "utf8"), "old-pack");
    assert.deepEqual(ensurePortableRuntimeCopy(f), { copied: false });
    assert.equal(hash(f.layout.executablePath), sourceHash);
  });
}

test("detects nested source updates even when directory timestamps stay unchanged", (t) => {
  const f = fixture(t);
  ensurePortableRuntimeCopy(f);
  const directory = path.join(f.layout.runtimeRoot, "locales");
  const previousStat = fs.statSync(directory);
  const pack = path.join(directory, "en-US.pak");
  fs.writeFileSync(pack, "updated source package");
  fs.utimesSync(directory, previousStat.atime, previousStat.mtime);
  assert.deepEqual(ensurePortableRuntimeCopy(f), { copied: true });
  assert.equal(fs.readFileSync(path.join(f.runnerRootDir, "locales", "en-US.pak"), "utf8"), "updated source package");
});

test("failed marker publication restores the old runtime and marker", (t) => {
  const f = fixture(t);
  ensurePortableRuntimeCopy(f);
  const oldMarker = fs.readFileSync(f.markerPath);
  const oldExe = fs.readFileSync(f.runnerExecutablePath);
  fs.writeFileSync(f.layout.executablePath, "changed source fixture");
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === f.markerPath) throw Object.assign(new Error("injected marker publication failure"), { code: "ENOSPC" });
    return rename(from, to);
  });
  assert.throws(() => ensurePortableRuntimeCopy(f), /injected marker/);
  assert.deepEqual(fs.readFileSync(f.markerPath), oldMarker);
  assert.deepEqual(fs.readFileSync(f.runnerExecutablePath), oldExe);
  mock.mock.restore();
  assert.deepEqual(ensurePortableRuntimeCopy(f), { copied: true });
});

test("rejects source/runtime overlap before any removal", (t) => {
  const f = fixture(t);
  assert.throws(() => ensurePortableRuntimeCopy({ ...f, runnerRootDir: f.layout.runtimeRoot }), /不能.*重叠/);
  assert.ok(fs.existsSync(f.layout.executablePath));
});

const windows = { skip: process.platform !== "win32" };
test("prepared cache reuse never writes or patches the working EXE", windows, async (t) => {
  const f = fixture(t);
  const runner = await createPortableRunner(f);
  const before = fs.readFileSync(runner.executablePath);
  const write = fs.writeFileSync;
  const rename = fs.renameSync;
  t.mock.method(fs, "writeFileSync", (target, ...args) => {
    assert.notEqual(target, runner.executablePath);
    return write(target, ...args);
  });
  t.mock.method(fs, "renameSync", (from, to) => {
    assert.notEqual(to, runner.executablePath);
    assert.notEqual(from, runner.runnerAppPath);
    return rename(from, to);
  });
  const compatibilityPoints = [];
  const result = await createPortableRunner({ ...f, runCompatibility(point, operation) {
    compatibilityPoints.push(point.id);
    return operation();
  } });
  assert.equal(result.executablePath, runner.executablePath);
  assert.ok(compatibilityPoints.includes(require("../runtime/modification/point-refs.cjs").runner.windowsAsarIntegrity.id));
  assert.deepEqual(fs.readFileSync(runner.executablePath), before);
});

test("runner ASAR hashes use physical file access and restore the Electron switch", windows, async (t) => {
  const f = fixture(t);
  const originalSwitch = process.noAsar;
  process.noAsar = false;
  t.after(() => { process.noAsar = originalSwitch; });
  const open = fs.openSync;
  let physicalReads = 0;
  t.mock.method(fs, "openSync", (file, flags, ...args) => {
    if (String(file).endsWith(".asar") && flags === "r") {
      // 模拟 Electron 的虚拟归档限制，确认新增加的摘要读取没有走虚拟目录。
      assert.equal(process.noAsar, true);
      physicalReads++;
    }
    return open(file, flags, ...args);
  });
  await createPortableRunner(f);
  await createPortableRunner(f);
  assert.ok(physicalReads >= 3);
  assert.equal(process.noAsar, false);
});

test("interrupted staging PE write leaves prior runner and marker usable, then retry recovers", windows, async (t) => {
  const f = fixture(t);
  const runner = await createPortableRunner(f);
  const before = fs.readFileSync(runner.executablePath);
  const marker = path.join(f.runtimeDir, "official-electron-runner", `runtime-manifest-${process.platform}-${process.arch}.json`);
  const markerBefore = fs.readFileSync(marker);
  const sourceBefore = hash(f.layout.executablePath);
  fs.writeFileSync(path.join(f.layout.runtimeRoot, "locales", "en-US.pak"), "updated resource to force staging");
  const write = fs.writeFileSync;
  const mock = t.mock.method(fs, "writeFileSync", (target, content, ...args) => {
    if (String(target).includes(".exe.") && String(target).endsWith(".tmp")) {
      write(target, Buffer.from(content).subarray(0, 64));
      throw Object.assign(new Error("injected interrupted PE write"), { code: "ENOSPC" });
    }
    return write(target, content, ...args);
  });
  await assert.rejects(createPortableRunner(f), /interrupted PE write/);
  assert.deepEqual(fs.readFileSync(runner.executablePath), before);
  assert.deepEqual(fs.readFileSync(marker), markerBefore);
  assert.equal(hash(f.layout.executablePath), sourceBefore);
  mock.mock.restore();
  await createPortableRunner(f);
  assert.equal(fs.readFileSync(path.join(runner.runnerAppPath, "locales", "en-US.pak"), "utf8"), "updated resource to force staging");
});

test("corrupted prepared PE is rebuilt and invalid source PE fails without a successful marker", windows, async (t) => {
  const f = fixture(t);
  const runner = await createPortableRunner(f);
  fs.writeFileSync(runner.executablePath, "truncated");
  await createPortableRunner(f);
  assert.doesNotThrow(() => NtExecutable.from(fs.readFileSync(runner.executablePath), { ignoreCert: true }));
  const before = fs.readFileSync(runner.executablePath);
  fs.writeFileSync(f.layout.executablePath, "invalid official PE fixture");
  await assert.rejects(createPortableRunner(f), /Windows runner EXE 无效/);
  assert.deepEqual(fs.readFileSync(runner.executablePath), before);
});

test("atomic patch rejects a hard link to the source executable", windows, async (t) => {
  const f = fixture(t);
  const runner = await createPortableRunner(f);
  const before = hash(f.layout.executablePath);
  fs.unlinkSync(runner.executablePath);
  fs.linkSync(f.layout.executablePath, runner.executablePath);
  assert.throws(() => patchWindowsRunnerAsarIntegrity({
    runnerRootDir: runner.runnerAppPath, runnerExecutablePath: runner.executablePath,
    sourceExecutablePath: f.layout.executablePath,
    runnerAsarPath: path.join(runner.runnerAppPath, "resources", "app.asar"),
  }), /硬链接/);
  assert.equal(hash(f.layout.executablePath), before);
});
