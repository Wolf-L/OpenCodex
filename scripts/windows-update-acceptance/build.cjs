"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const repo = path.resolve(__dirname, "../..");
const output = path.resolve(process.argv[2] || path.join(repo, "../../work/windows-update-acceptance"));
const inputs = path.join(output, "inputs");
const appDir = path.join(output, "app");
const electronDist = path.dirname(require(require.resolve("electron", { paths: [repo] })));
const builder = require.resolve("electron-builder/cli.js", { paths: [repo] });
const cache = path.resolve(process.env.ELECTRON_BUILDER_CACHE || path.join(repo, "../../work/windows-nsis-smoke/builder-cache"));
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const originalModules = ["self-update-controller.cjs", "self-update-install.cjs", "self-update-helper.cjs"];
async function run(file, args, logName) {
  const fd = fs.openSync(path.join(output, logName), "w");
  const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ["ignore", fd, fd], env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", ELECTRON_BUILDER_CACHE: cache }, timeout: 300000 });
  try { await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${logName} exited ${code}`))); }); }
  finally { fs.closeSync(fd); }
}
async function build() {
  if (process.platform !== "win32") throw new Error("Build this acceptance fixture on Windows");
  if (fs.existsSync(path.join(inputs, "manifest.json"))) throw new Error("Choose a new output directory; existing evidence is retained");
  fs.mkdirSync(path.join(appDir, "launcher"), { recursive: true });
  fs.mkdirSync(inputs, { recursive: true });
  // 构建不执行任何生成的安装包；带生产身份的夹具只能在独立 OS 中启动。
  for (const file of originalModules) fs.copyFileSync(path.join(repo, "launcher", file), path.join(appDir, "launcher", file));
  for (const file of ["fixture-gateway.cjs", "safety.cjs"]) fs.copyFileSync(path.join(__dirname, file), path.join(appDir, "launcher", file));
  fs.copyFileSync(path.join(__dirname, "fixture-main.cjs"), path.join(appDir, "launcher/main.cjs"));
  const manifest = { schemaVersion: 1, downloaderBypassed: true, originals: Object.fromEntries(originalModules.map(file => [file, digest(path.join(repo, "launcher", file))])), packages: [] };
  for (const version of ["1.0.0", "1.0.1", "1.0.2"]) {
    const directory = path.join(output, `release-${version}`);
    const pkg = { name: "opencodex", productName: "OpenCodex", version, main: "launcher/main.cjs", private: true, author: "OpenCodex local acceptance", description: "Windows Sandbox native update acceptance fixture", build: {
      appId: "dev.opencodex.launcher", productName: "OpenCodex", executableName: "OpenCodex", asar: false, npmRebuild: false, electronVersion: "42.0.1", electronDist, compression: "store", files: ["package.json", "launcher/**"], directories: { output: directory },
      win: { target: [{ target: "nsis", arch: ["x64"] }], signAndEditExecutable: false },
      nsis: { guid: "ce0e88bf-c4e1-5d5f-bd8c-44770c64a07a", oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: false, createStartMenuShortcut: false, artifactName: `OpenCodex-Acceptance-${version}.exe` },
    } };
    fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify(pkg, null, 2));
    await run(process.execPath, [builder, "--projectDir", appDir, "--win", "nsis", "--x64", "--publish", "never"], `build-${version}.log`);
    const filename = `OpenCodex-Acceptance-${version}.exe`;
    fs.copyFileSync(path.join(directory, filename), path.join(inputs, filename));
    manifest.packages.push({ version, filename, size: fs.statSync(path.join(inputs, filename)).size, sha256: digest(path.join(inputs, filename)) });
    console.log(`Built ${version}`);
  }
  const nsisRoot = path.join(cache, "nsis");
  const nsisDir = fs.readdirSync(nsisRoot).find(name => fs.existsSync(path.join(nsisRoot, name, "Bin", "makensis.exe")));
  if (!nsisDir) throw new Error("Existing NSIS compiler was not found");
  const failure = path.join(inputs, "OpenCodex-Acceptance-Failure.exe");
  const nsi = path.join(output, "intentional-failure.nsi");
  fs.writeFileSync(nsi, `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${failure}"\nSection\n  Sleep 4000\n  SetErrorLevel 13\n  Quit\nSectionEnd\n`);
  await run(path.join(nsisRoot, nsisDir, "Bin/makensis.exe"), [nsi], "build-failure.log");
  manifest.packages.push({ version: "1.0.2", filename: path.basename(failure), size: fs.statSync(failure).size, sha256: digest(failure), expectedExit: 13 });
  const host = path.join(inputs, "node-host");
  fs.mkdirSync(host, { recursive: true });
  // 外置 Electron Node 宿主使编排器不依赖来宾 Node 安装，也不会锁住待替换应用。
  for (const item of fs.readdirSync(electronDist, { withFileTypes: true })) if (item.isFile()) fs.copyFileSync(path.join(electronDist, item.name), path.join(host, item.name === "electron.exe" ? "OpenCodexAcceptanceHost.exe" : item.name));
  for (const file of ["guest-runner.cjs", "safety.cjs", "evidence.cjs"]) fs.copyFileSync(path.join(__dirname, file), path.join(inputs, file));
  fs.copyFileSync(path.join(repo, "launcher/self-update-helper.cjs"), path.join(inputs, "self-update-helper.cjs"));
  fs.writeFileSync(path.join(inputs, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ inputs, manifest: path.join(inputs, "manifest.json") }));
}
build().catch(error => { console.error(error.stack); process.exitCode = 1; });
