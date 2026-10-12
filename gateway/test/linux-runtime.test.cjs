const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { inspectLinuxExecutable, assertLinuxRuntimeLayout, linuxRuntimeArgs } = require("../runner/linux-runtime.cjs");
const { __test: layoutTest } = require("../runner/official-layout.cjs");
const { CodexAsarScanner, CodexAsarCandidateProvider, CodexBinaryLocator } = require("../dist/official/CodexAsarScanner.js");
const { OfficialBundleFileSystem } = require("../dist/official/OfficialBundleFileSystem.js");
const { LocalCodexBundleProvider } = require("../dist/official/LocalCodexBundleProvider.js");

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-linux-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(filePath, content = "fixture") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeElf(filePath, machine = 183, mutate = () => {}) {
  // 使用不可执行的最小 ELF 头夹具；测试只做格式/权限检查，绝不运行这些文件。
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(header);
  header.writeUInt16LE(machine, 18);
  mutate(header);
  writeFile(filePath, header);
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

test("Linux ELF inspection accepts matching ARM64 and x64 headers without running binaries", (t) => {
  const root = temporaryDirectory(t);
  for (const [arch, machine] of [["arm64", 183], ["x64", 62]]) {
    const file = writeElf(path.join(root, arch), machine);
    const result = inspectLinuxExecutable(file, { arch, checkExecutable: false });
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(result.machine, machine);
    assert.equal(result.detectedArch, arch);
    assert.equal(result.filePath, file);
  }
});

test("Linux ELF inspection rejects wrong CPU, unsupported CPU and foreign file formats", (t) => {
  const root = temporaryDirectory(t);
  const x64 = writeElf(path.join(root, "x64"), 62);
  assert.match(inspectLinuxExecutable(x64, { arch: "arm64" }).error, /architecture mismatch.*arm64.*x64/);
  assert.match(inspectLinuxExecutable(x64, { arch: "riscv64" }).error, /Unsupported Linux architecture/);
  for (const [name, content] of [["pe", "MZ"], ["mach", Buffer.from([0xcf, 0xfa, 0xed, 0xfe])], ["shell", "#!/bin/sh\nexit 0"]]) {
    const result = inspectLinuxExecutable(writeFile(path.join(root, name), content), { arch: "arm64" });
    assert.equal(result.ok, false);
    assert.match(result.error, /ELF64/);
  }
});

test("Linux ELF inspection rejects ELF32, big-endian, unknown version and truncated headers", (t) => {
  const root = temporaryDirectory(t);
  for (const [byte, value] of [[4, 1], [5, 2], [6, 0]]) {
    const file = writeElf(path.join(root, `bad-${byte}`), 183, (header) => { header[byte] = value; });
    assert.equal(inspectLinuxExecutable(file, { arch: "arm64" }).ok, false);
  }
  const truncated = writeElf(path.join(root, "truncated"));
  fs.truncateSync(truncated, 24);
  assert.match(inspectLinuxExecutable(truncated, { arch: "arm64" }).error, /truncated/);
});

test("Linux ELF inspection reports missing files and directories without throwing", (t) => {
  const root = temporaryDirectory(t);
  assert.match(inspectLinuxExecutable("", { arch: "arm64" }).error, /Missing Linux executable/);
  assert.match(inspectLinuxExecutable(path.join(root, "absent"), { arch: "arm64" }).error, /ENOENT/);
  assert.equal(inspectLinuxExecutable(root, { arch: "arm64" }).ok, false);
});

test("Linux ELF inspection checks executable access on a real Linux filesystem", { skip: process.platform !== "linux" }, (t) => {
  const file = writeElf(path.join(temporaryDirectory(t), "no-execute"));
  fs.chmodSync(file, 0o600);
  assert.match(inspectLinuxExecutable(file, { arch: "arm64", checkExecutable: true }).error, /EACCES|EPERM/);
  assert.equal(inspectLinuxExecutable(file, { arch: "arm64", checkExecutable: false }).ok, true);
});

test("Linux layout validates both desktop and CLI and rejects a shared executable", (t) => {
  const root = temporaryDirectory(t);
  const desktop = writeElf(path.join(root, "chatgpt"));
  const cli = writeElf(path.join(root, "resources", "codex"));
  const options = { platform: "linux", arch: "arm64", checkExecutable: false };
  const layout = { executablePath: desktop, codexBinaryPath: cli };
  assert.equal(assertLinuxRuntimeLayout(layout, options), layout);
  assert.throws(() => assertLinuxRuntimeLayout({ ...layout, codexBinaryPath: desktop }, options), /must not be the desktop/);
  assert.throws(() => assertLinuxRuntimeLayout({ ...layout, codexBinaryPath: null }, options), /Codex CLI.*Missing/);
  writeElf(cli, 62);
  assert.throws(() => assertLinuxRuntimeLayout(layout, options), /Codex CLI.*architecture mismatch/);
});

test("Linux layout rejects hard-linked desktop and CLI executables", (t) => {
  const root = temporaryDirectory(t);
  const desktop = writeElf(path.join(root, "chatgpt"));
  const cli = path.join(root, "codex-cli");
  fs.linkSync(desktop, cli);
  assert.throws(
    () => assertLinuxRuntimeLayout({ executablePath: desktop, codexBinaryPath: cli }, { platform: "linux", arch: "arm64", checkExecutable: false }),
    /must not be the desktop/
  );
});

test("Linux layout validation leaves macOS and Windows fixtures untouched", () => {
  for (const platform of ["darwin", "win32"]) {
    const layout = { executablePath: "/not/a/linux/file" };
    assert.equal(assertLinuxRuntimeLayout(layout, { platform }), layout);
  }
});

test("Linux runtime keeps sandboxing enabled by default and flags are explicit only", () => {
  const options = { platform: "linux", env: {}, getuid: () => 1000, warn: () => assert.fail("Unexpected security warning") };
  assert.deepEqual(linuxRuntimeArgs(options), []);
  assert.deepEqual(linuxRuntimeArgs({ ...options, env: { OPENCODEX_LINUX_NO_SANDBOX: "true", OPENCODEX_LINUX_DISABLE_GPU: "0" } }), []);
  assert.deepEqual(linuxRuntimeArgs({ ...options, env: { OPENCODEX_LINUX_DISABLE_GPU: "1", OPENCODEX_LINUX_DISABLE_DEV_SHM: "1" } }), ["--disable-gpu", "--disable-dev-shm-usage"]);
});

test("Linux runtime rejects root instead of silently weakening Chromium sandboxing", () => {
  assert.throws(() => linuxRuntimeArgs({ platform: "linux", env: {}, getuid: () => 0 }), /non-root.*OPENCODEX_LINUX_NO_SANDBOX=1/);
});

test("Linux runtime warns for an explicit no-sandbox opt-in for any UID", () => {
  for (const uid of [0, 1000]) {
    const warnings = [];
    const args = linuxRuntimeArgs({ platform: "linux", env: { OPENCODEX_LINUX_NO_SANDBOX: "1" }, getuid: () => uid, warn: (message) => warnings.push(message) });
    assert.deepEqual(args, ["--no-sandbox"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /disables the Chromium process sandbox/);
    assert.match(warnings[0], /does not change Codex command approvals/);
  }
});

test("Linux runtime switches and root checks do not affect other platforms", () => {
  for (const platform of ["win32", "darwin"]) {
    assert.deepEqual(linuxRuntimeArgs({ platform, env: { OPENCODEX_LINUX_NO_SANDBOX: "1", OPENCODEX_LINUX_DISABLE_GPU: "1" }, getuid: () => assert.fail("Unexpected UID check"), warn: () => assert.fail("Unexpected warning") }), []);
  }
});

test("Linux desktop discovery prefers ChatGPT and Electron over ambiguous codex names", (t) => {
  const root = temporaryDirectory(t);
  const asarPath = writeFile(path.join(root, "resources", "app.asar"));
  const desktop = writeElf(path.join(root, "chatgpt"));
  writeElf(path.join(root, "codex"));
  writeElf(path.join(root, "electron"));
  const cli = writeElf(path.join(root, "resources", "codex"));
  const layout = layoutTest.portableRuntimeLayoutFromInstallLayout({ installRoot: root, asarPath, codexBinaryPath: cli }, null, { platform: "linux", env: {} });
  assert.equal(layout.executablePath, desktop);
  assert.equal(layout.codexBinaryPath, cli);
  const candidates = layoutTest.linuxElectronExecutableCandidates(root, {});
  assert.ok(candidates.indexOf(path.join(root, "electron")) < candidates.indexOf(path.join(root, "codex")));
  assert.ok(candidates.includes(path.join(root, "codex-desktop")));
});

test("Linux desktop override is authoritative and invalid paths never fall back", (t) => {
  const root = temporaryDirectory(t);
  const asarPath = writeFile(path.join(root, "resources", "app.asar"));
  writeElf(path.join(root, "chatgpt"));
  const override = writeElf(path.join(root, "custom-electron"));
  const env = { CODEX_DESKTOP_EXECUTABLE_PATH: override };
  const scanned = { installRoot: root, asarPath };
  assert.equal(layoutTest.portableRuntimeLayoutFromInstallLayout(scanned, null, { platform: "linux", env }).executablePath, override);
  fs.unlinkSync(override);
  assert.throws(() => layoutTest.portableRuntimeLayoutFromInstallLayout(scanned, null, { platform: "linux", env }), /CODEX_DESKTOP_EXECUTABLE_PATH.*fallback is disabled/);
});

test("Linux default install candidates include signed ChatGPT and community layouts", () => {
  const provider = new CodexAsarCandidateProvider({ fileSystem: { normalizePath: (value) => value }, platform: "linux", env: {}, homeDir: "/home/example" });
  assert.ok(provider.toList().includes("/opt/chatgpt"));
  assert.ok(provider.toList().includes("/opt/codex-desktop"));
  assert.ok(provider.toList().includes("/opt/codex"));
});

test("Linux CLI locator honors app-server then CLI overrides and fails closed", (t) => {
  const root = temporaryDirectory(t);
  const resourcesDir = path.join(root, "resources");
  writeFile(path.join(resourcesDir, "codex"));
  const env = { CODEX_APP_SERVER_BINARY_PATH: writeFile(path.join(root, "server")), CODEX_CLI_PATH: writeFile(path.join(root, "cli")) };
  const locator = new CodexBinaryLocator({ fileSystem: new OfficialBundleFileSystem(), platform: "linux", env, homeDir: root });
  const find = () => locator.find({ installRoot: root, resourcesDir });
  assert.equal(find(), env.CODEX_APP_SERVER_BINARY_PATH);
  fs.unlinkSync(env.CODEX_APP_SERVER_BINARY_PATH);
  assert.throws(find, /CODEX_APP_SERVER_BINARY_PATH.*fallback is disabled/);
  delete env.CODEX_APP_SERVER_BINARY_PATH;
  assert.equal(find(), env.CODEX_CLI_PATH);
  fs.unlinkSync(env.CODEX_CLI_PATH);
  assert.throws(find, /CODEX_CLI_PATH.*fallback is disabled/);
});

test("Linux CLI locator uses resources/bin but never mistakes install-root codex for CLI", (t) => {
  const root = temporaryDirectory(t);
  const resourcesDir = path.join(root, "resources");
  writeFile(path.join(root, "codex"));
  const locator = new CodexBinaryLocator({ fileSystem: new OfficialBundleFileSystem(), platform: "linux", env: {}, homeDir: root });
  assert.equal(locator.find({ installRoot: root, resourcesDir }), null);
  assert.equal(locator.find({ installRoot: root, resourcesDir: root }), null);
  const cli = writeFile(path.join(resourcesDir, "bin", "codex"));
  assert.equal(locator.find({ installRoot: root, resourcesDir }), cli);
});

test("Linux scanner gives an explicit app path precedence over a still-valid old cache", (t) => {
  const root = temporaryDirectory(t);
  const oldAsar = writeFile(path.join(root, "old", "resources", "app.asar"));
  const currentAsar = writeFile(path.join(root, "current", "resources", "app.asar"));
  const cli = writeFile(path.join(root, "explicit-cli"));
  const scanner = new CodexAsarScanner({ platform: "linux", env: { CODEX_DESKTOP_APP_PATH: path.join(root, "current"), CODEX_CLI_PATH: cli } });
  const result = scanner.find({ cachedAsarPath: oldAsar });
  assert.equal(result.asarPath, fs.realpathSync.native(currentAsar));
  assert.equal(result.codexBinaryPath, cli);
});

test("Linux scanner fails closed for an invalid explicit app despite cache and fallback installs", (t) => {
  const root = temporaryDirectory(t);
  const oldAsar = writeFile(path.join(root, "old", "resources", "app.asar"));
  const scanner = new CodexAsarScanner({ platform: "linux", configuredPath: path.join(root, "missing"), defaultCandidates: [path.join(root, "old")], env: {} });
  assert.throws(() => scanner.find({ cachedAsarPath: oldAsar }), /CODEX_DESKTOP_APP_PATH.*fallback is disabled/);
});

test("Linux scanner precedence does not change Windows and macOS cached-source semantics", (t) => {
  const root = temporaryDirectory(t);
  const oldAsar = writeFile(path.join(root, "old", "resources", "app.asar"));
  writeFile(path.join(root, "current", "resources", "app.asar"));
  for (const platform of ["win32", "darwin"]) {
    const scanner = new CodexAsarScanner({ platform, configuredPath: path.join(root, "current"), env: {}, homeDir: path.join(root, "home") });
    assert.equal(scanner.find({ cachedAsarPath: oldAsar }).asarPath, fs.realpathSync.native(oldAsar));
  }
});

function providerCacheFixture(t, platform, overrides = {}) {
  const root = temporaryDirectory(t);
  const oldAsar = writeFile(path.join(root, "old", "resources", "app.asar"));
  const oldCli = writeFile(path.join(root, "old", "resources", "codex"));
  const manifest = { sourceAsarPath: oldAsar, sourceAppPath: path.join(root, "old"), sourceResourcesPath: path.dirname(oldAsar), sourceCodexBinaryPath: oldCli, version: "old", build: "old", runtimeOptimizations: {} };
  const env = { CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE: "0", ...overrides };
  const provider = new LocalCodexBundleProvider({ platform, env, logger: { info() {}, warn() {} } });
  // 只替换解包/诊断旁路，保留真实 scanner 和 provider 的缓存分支，不接触任何真实资料目录。
  const cache = { readManifest: () => manifest, reuseWithoutSourceScanBlockReason: () => "", refreshReason: () => "", bundleDir: path.join(root, "cache"), webviewDir: path.join(root, "cache", "webview"), bootstrapPath: path.join(root, "cache", "bootstrap.js") };
  provider.createCache = () => cache;
  provider.sourceInfoReader.read = (layout) => ({ ...layout, version: "current", build: "current" });
  provider.synchronizeCompatibilityRuntime = () => {};
  provider.reportCachedOptimizationCompatibility = () => {};
  provider.logSourceInfo = () => {};
  provider.logCacheHit = () => {};
  return { provider, root, env, oldCli, oldAsar };
}

test("Linux provider disabled auto-scan still honors a new explicit CLI instead of stale manifest CLI", (t) => {
  const fixture = providerCacheFixture(t, "linux");
  const cli = writeFile(path.join(fixture.root, "current-cli"));
  // 同一个注入环境在启动前改变时，也必须重新解析 CLI，而不是使用初始化时的全局环境。
  fixture.env.CODEX_CLI_PATH = cli;
  assert.equal(fixture.provider.ensure({ projectRoot: fixture.root }).codexBinaryPath, cli);
  fs.unlinkSync(cli);
  assert.throws(() => fixture.provider.ensure({ projectRoot: fixture.root }), /CODEX_CLI_PATH.*fallback is disabled/);
});

test("Linux provider disabled auto-scan honors a new explicit desktop source", (t) => {
  const fixture = providerCacheFixture(t, "linux");
  const currentAsar = writeFile(path.join(fixture.root, "current", "resources", "app.asar"));
  const currentCli = writeFile(path.join(fixture.root, "current", "resources", "codex"));
  // 安装路径是在 provider 构造时固定的配置；使用新的 provider 表示一次新的启动。
  const replacement = new LocalCodexBundleProvider({ platform: "linux", env: { CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE: "0", CODEX_DESKTOP_APP_PATH: path.join(fixture.root, "current") }, logger: { info() {}, warn() {} } });
  for (const key of ["createCache", "synchronizeCompatibilityRuntime", "reportCachedOptimizationCompatibility", "logSourceInfo", "logCacheHit"]) replacement[key] = fixture.provider[key];
  replacement.sourceInfoReader.read = fixture.provider.sourceInfoReader.read;
  const result = replacement.ensure({ projectRoot: fixture.root });
  assert.equal(result.sourceAsarPath, fs.realpathSync.native(currentAsar));
  // 默认 CLI 来自已规范化的安装布局；CI 的 Windows TEMP 可能含 8.3 短路径。
  assert.equal(result.codexBinaryPath, fs.realpathSync.native(currentCli));
  fs.unlinkSync(currentAsar);
  assert.throws(() => replacement.ensure({ projectRoot: fixture.root }), /CODEX_DESKTOP_APP_PATH.*fallback is disabled/);
});

test("Linux provider retains no-scan cache reuse when no paths are explicitly overridden", (t) => {
  const fixture = providerCacheFixture(t, "linux");
  fixture.provider.scanner.find = () => assert.fail("Unexpected source scan");
  assert.equal(fixture.provider.ensure({ projectRoot: fixture.root }).codexBinaryPath, fixture.oldCli);
});

test("Linux explicit-path cache rule does not change Windows and macOS no-scan semantics", (t) => {
  for (const platform of ["win32", "darwin"]) {
    const fixture = providerCacheFixture(t, platform, { CODEX_CLI_PATH: "/not/a/real/override", CODEX_DESKTOP_APP_PATH: "/not/a/real/app" });
    fixture.provider.scanner.find = () => assert.fail("Unexpected source scan");
    assert.equal(fixture.provider.ensure({ projectRoot: fixture.root }).codexBinaryPath, fixture.oldCli);
  }
});

test("Linux safeguards are wired into both launch sites and before runner copy", () => {
  // 验证启动接线，测试无需启动 Electron，也不读取真实用户资料目录。
  for (const relative of ["../dev/run-gateway.cjs", "../../launcher/main.cjs"]) {
    const source = fs.readFileSync(path.join(__dirname, relative), "utf8");
    assert.match(source, /linuxRuntimeArgs\(/);
    assert.match(source, /\.\.\.linuxArgs/);
  }
  const runner = fs.readFileSync(path.join(__dirname, "../runner/index.cjs"), "utf8");
  assert.ok(runner.indexOf("assertLinuxRuntimeLayout(layout)") < runner.indexOf("await createPortableRunner("));
});
