"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

test("Electron normal-mode ASAR backup is byte-identical and verifies in external Node mode", { skip: process.platform !== "win32", timeout: 150000 }, async () => {
  const electron = require("electron");
  const originalAsar = path.join(path.dirname(electron), "resources/default_app.asar");
  assert.ok(fs.statSync(originalAsar).isFile(), "real vendor ASAR fixture must exist");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-asar-backup-"));
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  let exited = false;
  try {
    const appDir = path.join(root, "probe-app");
    fs.mkdirSync(appDir);
    fs.mkdirSync(path.join(root, "source/resources"), { recursive: true });
    fs.copyFileSync(originalAsar, path.join(root, "source/resources/default_app.asar"));
    fs.writeFileSync(path.join(root, "source/plain.txt"), "原始应用文件\n");
    // 覆盖真实分发中的混合大小写、标点与 Unicode，跨模式排序不得依赖默认区域设置。
    for (const name of ["LICENSE.electron.txt", "chrome_100_percent.pak", "vulkan-1.dll", ".hidden", "_runtime", "-runtime", "A-file", "b_file", "Zeta", "äther", "éclair", "中文", "张", "王", "李"])
      fs.writeFileSync(path.join(root, "source", name), name);
    for (const file of ["self-update-helper.cjs", "self-update-install.cjs"])
      fs.copyFileSync(path.join(__dirname, "..", file), path.join(appDir, file));
    fs.copyFileSync(path.join(__dirname, "fixtures/self-update-asar-probe.cjs"), path.join(appDir, "main.cjs"));
    fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "opencodex-asar-probe", version: "1.0.0", main: "main.cjs" }));
    const env = { ...process.env, OPENCODEX_ASAR_PROBE_ROOT: root };
    // 必须启动正常 Electron 主进程；Node 模式不会重现 ASAR 虚拟文件系统问题。
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    delete env.OPENCODEX_UPDATE_TRANSACTION;
    delete env.OPENCODEX_UPDATE_TOKEN;
    const child = spawn(electron, [appDir], { windowsHide: true, shell: false, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const capture = chunk => { output = (output + chunk.toString()).slice(-32768); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const code = await new Promise((resolve, reject) => {
      // 只终止本次直接创建的 ChildProcess，不按名称查杀或接管外部进程。
      const timer = setTimeout(() => { child.kill(); reject(new Error("isolated Electron ASAR probe timed out")); }, 60000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", result => { exited = true; clearTimeout(timer); resolve(result); });
    });
    assert.equal(code, 0, output);
    const result = JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8"));
    assert.equal(result.electronNormalMode, true);
    assert.equal(result.physicalFile, true);
    assert.equal(result.identicalDigest, true);
    assert.equal(result.identicalInventory, true);
    assert.equal(result.physicalInventoryEntry, true);
    assert.equal(result.backupVerified, true);
    assert.ok(result.archiveBytes > 0);
    // 使用同一 Electron EXE 的独立 Node 模式进程，复现安装目录外助手的校验边界。
    exited = false;
    const external = spawn(electron, [path.join(appDir, "main.cjs")], { windowsHide: true, shell: false, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let externalOutput = "";
    const captureExternal = chunk => { externalOutput = (externalOutput + chunk.toString()).slice(-32768); };
    external.stdout.on("data", captureExternal); external.stderr.on("data", captureExternal);
    const externalCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { external.kill(); reject(new Error("external Electron Node verification timed out")); }, 60000);
      external.once("error", error => { clearTimeout(timer); reject(error); });
      external.once("exit", code => { exited = true; clearTimeout(timer); resolve(code); });
    });
    assert.equal(externalCode, 0, JSON.stringify({ normal: result, externalOutput }));
    const verification = JSON.parse(fs.readFileSync(path.join(root, "external-result.json"), "utf8"));
    assert.equal(verification.nodeMode, true);
    assert.equal(verification.identicalInventory, true);
    assert.equal(verification.verified, true);
  } finally {
    // 退出已确认后才清理专用临时目录；无法证明退出时保留现场。
    if (exited && path.resolve(root).startsWith(tempRoot) && path.basename(root).startsWith("opencodex-asar-backup-")) fs.rmSync(root, { recursive: true, force: true });
  }
});
