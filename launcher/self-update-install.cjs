"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const helper = require("./self-update-helper.cjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function updateRoot(userDataDir) {
  return path.join(helper.assertPlainPath(userDataDir), "self-update", "transactions");
}
function acquireTransactionLock(root, transactionId) {
  const lockFile = path.join(root, "active.lock");
  let fd;
  try { fd = fs.openSync(lockFile, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error("已有更新事务或未完成的恢复，请先检查更新状态"); throw error; }
  try { fs.writeFileSync(fd, JSON.stringify({ transactionId })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return lockFile;
}
function activeJournal(options) {
  const root = updateRoot(options.userDataDir);
  const active = helper.readJson(path.join(root, "latest.json"));
  if (!/^[a-f0-9]{32}$/.test(active.transactionId)) throw new Error("更新事务标识无效");
  const dir = path.join(root, active.transactionId);
  const journal = helper.readJson(path.join(dir, "journal.json"));
  helper.validateJournal(journal, dir);
  if (journal.transactionId !== active.transactionId || !helper.samePath(journal.exePath, options.exePath)) throw new Error("更新事务不属于当前安装");
  return { dir, journal };
}
function readWindowsUpdateState(options) {
  try {
    const { journal } = activeJournal(options);
    // 轮询只读取小型日志；存活与备份校验由安装助手负责，不在 UI 渲染中哈希整个应用。
    let interrupted = false;
    if (!helper.TERMINAL.has(journal.status) && journal.status !== "recovery-needed") {
      const owner = journal.helper || journal.parent;
      try { process.kill(owner.pid, 0); } catch { interrupted = true; }
    }
    return { status: interrupted ? "recovery-needed" : journal.status, error: interrupted ? "更新助手已退出，保留备份等待恢复" : journal.error || "", targetVersion: journal.targetVersion, backupDir: journal.backupDir };
  } catch (error) {
    const hasLock = options.userDataDir && fs.existsSync(path.join(updateRoot(options.userDataDir), "active.lock"));
    return error.code === "ENOENT" && !hasLock ? { status: "idle" } : { status: "recovery-needed", error: hasLock ? "发现未完成的更新事务，请保留备份等待恢复" : error.message, canRecover: false };
  }
}
function validatePackagedMetadata(metadata) {
  // electron-builder 会移除 build 字段；保留字段与下方精确的注册表、EXE 身份共同校验。
  if (metadata?.name !== "opencodex" || metadata.productName !== "OpenCodex" || metadata.main !== "launcher/main.cjs" || (metadata.build?.appId && metadata.build.appId !== "dev.opencodex.launcher")) throw new Error("当前安装的应用身份不匹配");
  return true;
}

async function installationIdentity(exePath) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("当前平台请通过发布页安装更新");
  const exe = helper.assertPlainPath(exePath);
  const installDir = path.dirname(exe);
  if (path.basename(exe).toLowerCase() !== "opencodex.exe" || path.basename(installDir).toLowerCase() !== "opencodex") throw new Error("无法识别 OpenCodex 安装目录");
  const key = helper.REGISTRY_KEYS[0].replace("HKCU\\", "HKCU:\\");
  const uninstall = helper.REGISTRY_KEYS[1].replace("HKCU\\", "HKCU:\\");
  const hklm = key.replace("HKCU:", "HKLM:");
  const registered = await helper.powershell(`$i = Get-ItemProperty -LiteralPath '${key}' -ErrorAction Stop; $u = Get-ItemProperty -LiteralPath '${uninstall}' -ErrorAction Stop; $m = Get-ItemProperty -LiteralPath '${hklm}' -ErrorAction SilentlyContinue; @{ location = $i.InstallLocation; uninstall = $u.UninstallString; machine = $m.InstallLocation } | ConvertTo-Json -Compress`);
  if (!registered?.location || !helper.samePath(registered.location, installDir) || registered.machine) throw new Error("仅支持已登记的当前用户安装，请通过发布页更新");
  const expectedUninstaller = path.join(installDir, "Uninstall OpenCodex.exe");
  if (registered.uninstall !== `"${expectedUninstaller}" /currentuser`) throw new Error("卸载登记信息与当前安装不匹配");
  const metadata = helper.readJson(path.join(installDir, "resources", "app", "package.json"));
  validatePackagedMetadata(metadata);
  return { exe, installDir, metadata };
}

async function prepareWindowsUpdate(options) {
  const { installerPath, size, sha256, targetVersion, currentVersion, exePath, userDataDir, onProgress = () => {} } = options;
  if (!helper.newerVersion(targetVersion, currentVersion)) throw new Error("更新版本必须高于当前稳定版本");
  const identity = await installationIdentity(exePath);
  if (identity.metadata.version !== currentVersion) throw new Error("当前安装版本已改变，请重新检查更新");
  const root = updateRoot(userDataDir);
  if (helper.within(root, identity.installDir) || helper.within(identity.installDir, userDataDir) || helper.samePath(identity.installDir, userDataDir)) throw new Error("更新备份必须位于应用目录之外");
  helper.assertPlainPath(installerPath);
  await helper.verifyInstaller(installerPath, size, sha256);
  await fsp.mkdir(root, { recursive: true });
  helper.assertPlainPath(root);
  const transactionId = crypto.randomBytes(16).toString("hex");
  const token = crypto.randomBytes(32).toString("hex");
  const dir = path.join(root, transactionId);
  const lockFile = acquireTransactionLock(root, transactionId);
  let host;
  let journal;
  const journalFile = path.join(dir, "journal.json");
  try {
    await fsp.mkdir(dir);
    const stagedInstaller = path.join(dir, "installer.exe");
    await fsp.copyFile(installerPath, stagedInstaller, fs.constants.COPYFILE_EXCL);
    await helper.verifyInstaller(stagedInstaller, size, sha256);
    onProgress({ status: "backing-up" });
    const parent = await helper.processInfo(process.pid);
    if (!parent || !helper.samePath(parent.exePath, exePath)) throw new Error("当前 Launcher 进程身份不匹配");
    const backupDir = path.join(dir, "application-backup");
    const inventory = await helper.inventory(identity.installDir);
    const inventoryFile = path.join(dir, "inventory.json");
    helper.atomicJson(inventoryFile, inventory);
    await fsp.cp(identity.installDir, backupDir, { recursive: true, force: false, errorOnExist: true });
    const registry = [];
    for (const [index, key] of helper.REGISTRY_KEYS.entries()) {
      const file = path.join(dir, `registry-${index}.reg`);
      await exec("reg.exe", ["export", key, file, "/y", "/reg:64"], { windowsHide: true, timeout: 30000 });
      registry.push({ key, file, size: fs.statSync(file).size, sha256: await helper.digest(file) });
    }
    // 助手宿主只复制 Electron 根级运行库，不使用随后会被 NSIS 删除的应用文件。
    const hostDir = path.join(dir, "host");
    await fsp.mkdir(hostDir);
    for (const item of await fsp.readdir(identity.installDir, { withFileTypes: true })) {
      if (item.isFile() && (!item.name.toLowerCase().endsWith(".exe") || item.name.toLowerCase() === "opencodex.exe")) {
        await fsp.copyFile(path.join(identity.installDir, item.name), path.join(hostDir, item.name.toLowerCase() === "opencodex.exe" ? "OpenCodexUpdateHost.exe" : item.name));
      }
    }
    const helperPath = path.join(hostDir, "self-update-helper.cjs");
    await fsp.copyFile(path.join(__dirname, "self-update-helper.cjs"), helperPath);
    journal = { schemaVersion: 1, transactionId, token, status: "preparing", targetVersion, currentVersion, userDataDir: path.resolve(userDataDir), exePath: identity.exe, installDir: identity.installDir, installerPath: stagedInstaller, size, sha256, parent, backupDir, registry, inventoryFile, inventorySize: fs.statSync(inventoryFile).size, inventorySha256: await helper.digest(inventoryFile), createdAt: new Date().toISOString() };
    helper.validateJournal(journal, dir);
    await helper.verifyBackup(journal);
    helper.atomicJson(journalFile, journal);
    await fsp.writeFile(path.join(dir, "recovery-notes.txt"), [
      "OpenCodex 更新事务恢复记录", `事务：${transactionId}`, `原版本：${currentVersion}`, `目标版本：${targetVersion}`,
      `安装目录：${identity.installDir}`, `应用备份：${backupDir}`, `校验清单：${inventoryFile}`,
      ...registry.map(entry => `注册表备份：${entry.file} -> ${entry.key}`),
      "若状态为 recovery-needed：先保留整个事务目录，不要再次运行安装器。",
      "恢复前必须核验 journal.json、inventory.json、所有应用文件和注册表备份摘要，并确认旧 Launcher、安装器、新 Launcher、Gateway 及其子进程均已退出。",
      "确认安全后保留失败安装目录，再恢复完整应用备份与上述两个 HKCU 登记键；不覆盖账号、配置、会话、官方客户端或运行时快照。",
      "此记录用于人工诊断，不是可直接执行的恢复脚本；自动化无法证明进程退出或备份完整时需要人工处理。",
    ].join("\r\n"), { flag: "wx" });
    helper.atomicJson(path.join(root, "latest.json"), { transactionId });
    host = await helper.launch(path.join(hostDir, "OpenCodexUpdateHost.exe"), [helperPath, dir], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true });
    // 实际执行复制的宿主并等待 READY，不能仅凭文件复制成功就停止旧服务。
    const deadline = Date.now() + 180000;
    while (helper.readJson(journalFile).status !== "ready") {
      if (!await helper.alive(host.identity) || Date.now() > deadline) throw new Error("更新助手未能就绪");
      await delay(200);
    }
    host.child.unref();
    onProgress({ status: "ready" });
    let committed = false;
    let cancelled = false;
    return {
      transactionId,
      async commit() {
        if (cancelled) throw new Error("更新事务已取消");
        if (committed) return;
        if (!await helper.alive(host.identity)) throw new Error("更新助手已退出");
        await helper.verifyInstaller(journal.installerPath, size, sha256);
        helper.atomicJson(path.join(dir, "commit.json"), { token });
        committed = true;
      },
      async cancel() {
        if (committed) throw new Error("安装事务已提交，无法取消");
        if (cancelled) return;
        cancelled = true;
        helper.atomicJson(path.join(dir, "cancel.json"), { token });
        if (!await helper.waitExit(host.identity, 15000) && !await helper.stopOwned(host.identity)) throw new Error("无法停止更新助手");
        const state = helper.readJson(journalFile);
        helper.atomicJson(journalFile, { ...state, status: "cancelled" });
        if (fs.existsSync(lockFile) && helper.readJson(lockFile).transactionId === transactionId) fs.unlinkSync(lockFile);
      },
    };
  } catch (error) {
    if (error.recoveryUnsafe && !host) {
      if (journal) helper.atomicJson(journalFile, { ...journal, status: "recovery-needed", error: error.message });
      throw error;
    }
    if (host && !await helper.stopOwned(host.identity)) throw new Error(`${error.message}；更新助手仍在运行`);
    if (journal) helper.atomicJson(journalFile, { ...journal, status: "cancelled", error: error.message });
    if (fs.existsSync(lockFile) && helper.readJson(lockFile).transactionId === transactionId) fs.unlinkSync(lockFile);
    throw error;
  }
}

function startupContext(options) {
  const transactionDir = process.env.OPENCODEX_UPDATE_TRANSACTION;
  const token = process.env.OPENCODEX_UPDATE_TOKEN;
  if (!transactionDir || !token) return null;
  const { dir, journal } = activeJournal(options);
  if (!helper.samePath(dir, transactionDir) || journal.token !== token || journal.targetVersion !== options.currentVersion || !helper.samePath(journal.exePath, options.exePath) || !["starting", "awaiting-confirmation"].includes(journal.status)) return null;
  return { dir, journal };
}
function recordUpdateStartup(options) {
  const context = startupContext(options);
  if (!context) return false;
  helper.atomicJson(path.join(context.dir, "startup.json"), { token: context.journal.token, pid: process.pid, exePath: options.exePath, version: options.currentVersion, gatewayPid: options.gatewayPid || null });
  return true;
}
function confirmWindowsUpdate(options) {
  const context = startupContext(options);
  if (!context || !Number.isSafeInteger(options.gatewayPid) || options.gatewayPid <= 0) return false;
  helper.atomicJson(path.join(context.dir, "ack.json"), { token: context.journal.token, pid: process.pid, exePath: options.exePath, version: options.currentVersion, gatewayPid: options.gatewayPid });
  return true;
}
async function recoverWindowsUpdate(options) {
  const state = readWindowsUpdateState(options);
  if (["idle", ...helper.TERMINAL].includes(state.status)) return state;
  // 中断事务可能仍有安装器或新版进程存活；没有可靠所有权证据时绝不覆盖当前目录。
  return { ...state, status: "recovery-needed", canRecover: false, error: state.error || "更新事务未完成，请保留备份并检查恢复；不会自动再次运行安装器" };
}

module.exports = { prepareWindowsUpdate, readWindowsUpdateState, recordUpdateStartup, confirmWindowsUpdate, recoverWindowsUpdate, __test: { activeJournal, startupContext, installationIdentity, acquireTransactionLock, validatePackagedMetadata } };
