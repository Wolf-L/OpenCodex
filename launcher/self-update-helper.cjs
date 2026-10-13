"use strict";

// 目录外助手以 Node 模式运行，只依赖内置模块；主进程分支使用 Electron 内置原始 fs。
// Electron 主进程的 fs 会把 .asar 当虚拟目录；备份必须读写真实文件字节。
const fs = process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE ? require("original-fs") : require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const GUID = "ce0e88bf-c4e1-5d5f-bd8c-44770c64a07a";
const REGISTRY_KEYS = [`HKCU\\Software\\${GUID}`, `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}`];
const TERMINAL = new Set(["completed", "rolled-back", "cancelled"]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const within = (child, root) => path.resolve(child).toLowerCase().startsWith(`${path.resolve(root).toLowerCase()}${path.sep}`);
const versionParts = value => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.test(value || "") ? value.split(/[.+]/).slice(0, 3).map(Number) : null;
function newerVersion(target, current) {
  const a = versionParts(target), b = versionParts(current);
  if (!a || !b || ![...a, ...b].every(Number.isSafeInteger)) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function readJson(file) {
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error("更新状态文件过大");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function atomicJson(file, data) {
  const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function verifyInstaller(file, size, sha256) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(size) || size <= 0 || stat.size !== size || !/^[a-f0-9]{64}$/.test(sha256) || await digest(file) !== sha256) throw new Error("安装包完整性校验失败");
}
function assertPlainPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /["\r\n\0]/.test(value) || value.startsWith("\\\\")) throw new Error("更新路径无效");
  const normalized = path.resolve(value);
  if (normalized === path.parse(normalized).root) throw new Error("不能使用磁盘根目录");
  let cursor = normalized;
  while (true) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("更新路径包含链接或重解析点");
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return normalized;
}
async function inventory(root) {
  assertPlainPath(root);
  const entries = [];
  async function walk(dir) {
    for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      const stat = await fsp.lstat(full);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("应用目录包含不支持的链接或特殊文件");
      if (stat.isDirectory()) { entries.push({ name: path.relative(root, full), directory: true }); await walk(full); }
      else entries.push({ name: path.relative(root, full), size: stat.size, sha256: await digest(full) });
    }
  }
  await walk(root);
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
async function verifyBackup(journal) {
  const actual = await inventory(journal.backupDir);
  await verifyInstaller(journal.inventoryFile, journal.inventorySize, journal.inventorySha256);
  if (JSON.stringify(actual) !== fs.readFileSync(journal.inventoryFile, "utf8")) throw new Error("应用备份校验失败，已保留现场");
  for (const entry of journal.registry) await verifyInstaller(entry.file, entry.size, entry.sha256);
}
function validateJournal(journal, transactionDir) {
  const dir = assertPlainPath(transactionDir);
  if (journal.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(journal.transactionId) || path.basename(dir) !== journal.transactionId || !/^[a-f0-9]{64}$/.test(journal.token) || !newerVersion(journal.targetVersion, journal.currentVersion)) throw new Error("更新事务结构或版本无效");
  const userData = assertPlainPath(journal.userDataDir);
  if (!samePath(dir, path.join(userData, "self-update", "transactions", journal.transactionId))) throw new Error("更新事务不在当前用户专用目录");
  const installDir = assertPlainPath(journal.installDir);
  if (path.basename(installDir).toLowerCase() !== "opencodex" || samePath(installDir, userData) || within(installDir, userData) || within(userData, installDir)) throw new Error("应用目录与用户数据目录不安全");
  for (const [actual, expected] of [[journal.exePath, path.join(installDir, "OpenCodex.exe")], [journal.backupDir, path.join(dir, "application-backup")], [journal.inventoryFile, path.join(dir, "inventory.json")], [journal.installerPath, path.join(dir, "installer.exe")]]) {
    if (!samePath(assertPlainPath(actual), expected)) throw new Error("更新事务文件路径不匹配");
  }
  if (!journal.parent || !Number.isSafeInteger(journal.parent.pid) || journal.parent.pid <= 0 || !samePath(journal.parent.exePath, journal.exePath)) throw new Error("更新父进程身份无效");
  if (!Array.isArray(journal.registry) || journal.registry.length !== REGISTRY_KEYS.length) throw new Error("更新注册表备份不完整");
  journal.registry.forEach((entry, index) => {
    if (entry.key !== REGISTRY_KEYS[index] || !samePath(assertPlainPath(entry.file), path.join(dir, `registry-${index}.reg`))) throw new Error("更新注册表范围不匹配");
  });
  return journal;
}
function validateRegistryExport(entry) {
  const bytes = fs.readFileSync(entry.file);
  const content = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8").replace(/^\uFEFF/, "");
  if (!content.startsWith("Windows Registry Editor Version 5.00")) throw new Error("注册表备份格式无效");
  const allowed = entry.key.replace(/^HKCU\\/, "HKEY_CURRENT_USER\\").toLowerCase();
  const keys = [...content.matchAll(/^\[([^\]\r\n]+)\]\s*$/gm)].map(match => match[1].toLowerCase());
  if (!keys.length || keys.some(key => key !== allowed && !key.startsWith(`${allowed}\\`))) throw new Error("注册表备份包含不属于本应用的键");
}
async function powershell(script) {
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}
async function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return powershell(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ pid = [int]$p.ProcessId; parentPid = [int]$p.ParentProcessId; exePath = $p.ExecutablePath; born = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`);
}
async function processList() {
  const result = await powershell("@(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; exePath = $_.ExecutablePath; born = $_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress");
  return Array.isArray(result) ? result : result ? [result] : [];
}
function ownedFromSnapshot(identity, all) {
  const root = all.find(item => item.pid === identity.pid);
  if (root && (root.born !== identity.born || !samePath(root.exePath || "", identity.exePath))) throw new Error("进程标识已复用，无法确认子进程归属");
  // 已消失的父 PID 可能被短命无关进程复用；不能据其遗留 parentPid 认领孤儿。
  if (!root) return [];
  const owned = [identity];
  for (let i = 0; i < owned.length; i++) {
    owned.push(...all.filter(item => item.parentPid === owned[i].pid && item.pid !== owned[i].pid && Date.parse(item.born) >= Date.parse(owned[i].born) && !owned.some(known => known.pid === item.pid)));
  }
  return owned;
}
async function descendants(identity) { return ownedFromSnapshot(identity, await processList()); }
async function noInstalledProcesses(installDir) {
  if ((await processList()).some(item => item.exePath && within(item.exePath, installDir))) throw new Error("应用目录仍有运行进程，保留备份等待恢复");
}
async function alive(identity) {
  const current = await processInfo(identity?.pid);
  return !!current && current.born === identity.born && samePath(current.exePath || "", identity.exePath);
}
async function waitExit(identity, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (await alive(identity)) {
    if (Date.now() > deadline) return false;
    await delay(250);
  }
  return true;
}
async function stopOwned(identity) {
  // 先验证创建时间和可执行路径，再仅终止本事务拥有的进程；不按进程名称清理。
  if (!identity || !await alive(identity)) return true;
  const escaped = identity.exePath.replace(/'/g, "''");
  const born = identity.born.replace(/'/g, "''");
  await powershell(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${identity.pid}'; if ($p -and $p.ExecutablePath -eq '${escaped}' -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '${born}') { Stop-Process -Id ${identity.pid} -Force -ErrorAction Stop }`);
  return waitExit(identity, 15000);
}
async function stopOwnedTree(identity) {
  const owned = await descendants(identity);
  if (!await stopOwned(identity)) return false;
  for (const child of owned.slice(1).reverse()) if (!child.exePath || !await stopOwned(child)) return false;
  return true;
}
async function launch(exePath, args, options = {}, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const startedAt = now();
  const child = (dependencies.spawn || spawn)(exePath, args, { stdio: "ignore", windowsHide: true, ...options });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  let exitCode;
  child.on("exit", code => { exitCode = code; });
  for (let i = 0; i < 40; i++) {
    if (spawnError) throw spawnError;
    let identity;
    try { identity = await (dependencies.processInfo || processInfo)(child.pid); }
    catch (error) { throw Object.assign(error, { recoveryUnsafe: true }); }
    // CIM 查询期间子进程可能已退出并复用 PID；不能把查询结果直接认作本事务所有物。
    if (spawnError) throw spawnError;
    if (exitCode !== undefined || child.exitCode != null || child.signalCode != null)
      throw Object.assign(new Error(`启动进程在身份确认前退出：${exitCode ?? child.exitCode}`), { recoveryUnsafe: true });
    if (identity) {
      const born = Date.parse(identity.born);
      // 允许 Windows 创建时间的秒级舍入；路径、PID 和本次启动时间窗必须同时匹配。
      if (identity.pid !== child.pid || !samePath(identity.exePath || "", exePath) || !Number.isFinite(born) || born < startedAt - 1000 || born > now() + 1000)
        throw Object.assign(new Error("启动进程身份与请求不匹配，无法安全接管"), { recoveryUnsafe: true });
      return { child, identity, exited: () => exitCode !== undefined, code: () => exitCode };
    }
    await delay(50);
  }
  throw Object.assign(new Error("无法确认更新进程身份"), { recoveryUnsafe: true });
}
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENCODEX_UPDATE_TRANSACTION;
  delete env.OPENCODEX_UPDATE_TOKEN;
  return env;
}
function nativeAdapter(transactionDir) {
  return {
    alive, waitExit, stopOwned: stopOwnedTree,
    async install(journal) {
      // /D 必须放在最后，NSIS 自行读取带空格的剩余文本，不向 shell 传入命令。
      const process = await launch(journal.installerPath, ["/S", "--updated", "/currentuser", `/D=${journal.installDir}`], { windowsVerbatimArguments: true, env: cleanEnv() });
      const owned = new Map([[process.identity.pid, process.identity]]);
      const deadline = Date.now() + 10 * 60 * 1000;
      try {
        for (;;) {
          for (const entry of await descendants(process.identity)) owned.set(entry.pid, entry);
          const running = [];
          for (const entry of owned.values()) if (await alive(entry)) running.push(entry);
          if (!running.length) break;
          if (Date.now() > deadline) {
            // NSIS 可能还有卸载子进程，超时后不能把父进程终止误当成全部退出。
            throw new Error("安装器运行超时，无法确认其所有进程已退出");
          }
          await delay(250);
        }
      } catch (error) { throw Object.assign(error, { recoveryUnsafe: true }); }
      // exit 回调可能稍晚于系统进程消失。
      for (let i = 0; i < 20 && !process.exited(); i++) await delay(25);
      if (process.code() === undefined) throw Object.assign(new Error("无法确认安装器退出码"), { recoveryUnsafe: true });
      if (process.code() !== 0) throw new Error(`安装器退出失败：${process.code()}`);
    },
    async candidate(journal) {
      const launched = await launch(journal.exePath, [], { env: { ...cleanEnv(), OPENCODEX_UPDATE_TRANSACTION: transactionDir, OPENCODEX_UPDATE_TOKEN: journal.token }, detached: true });
      launched.child.unref();
      return launched.identity;
    },
    processInfo,
    async relaunchOriginal(journal) {
      await verifyBackup(journal);
      if (JSON.stringify(await inventory(journal.installDir)) !== fs.readFileSync(journal.inventoryFile, "utf8")) throw new Error("原安装目录已变化，无法自动重启");
      await noInstalledProcesses(journal.installDir);
      const launched = await launch(journal.exePath, [], { env: cleanEnv(), detached: true });
      launched.child.unref();
    },
    async restore(journal) {
      assertPlainPath(journal.installDir);
      await noInstalledProcesses(journal.installDir);
      journal.registry.forEach(validateRegistryExport);
      // 不删除新版现场；同卷改名成功后才将已核验的旧版恢复到原位置。
      if (fs.existsSync(journal.installDir)) await fsp.rename(journal.installDir, `${journal.installDir}.failed-update-${journal.transactionId}`);
      await fsp.cp(journal.backupDir, journal.installDir, { recursive: true, errorOnExist: true, force: false });
      for (const entry of journal.registry) {
        await exec("reg.exe", ["delete", entry.key, "/f", "/reg:64"], { windowsHide: true }).catch(error => { if (error.code !== 1) throw error; });
        await exec("reg.exe", ["import", entry.file, "/reg:64"], { windowsHide: true });
      }
      const launched = await launch(journal.exePath, [], { env: cleanEnv(), detached: true });
      launched.child.unref();
    },
  };
}

async function runTransaction(transactionDir, adapter = nativeAdapter(transactionDir), options = {}) {
  const journalPath = path.join(transactionDir, "journal.json");
  let journal = validateJournal(readJson(journalPath), transactionDir);
  if (options.helperIdentity) journal.helper = options.helperIdentity;
  const update = (status, error = "") => { journal = { ...journal, status, error, updatedAt: new Date().toISOString() }; atomicJson(journalPath, journal); };
  const releaseLock = () => {
    const lock = path.join(path.dirname(transactionDir), "active.lock");
    try { if (readJson(lock).transactionId === journal.transactionId) fs.unlinkSync(lock); } catch {}
  };
  let candidate;
  let gateway;
  let mutationStarted = false;
  try {
    await verifyBackup(journal);
    update("ready");
    const deadline = Date.now() + (options.commitTimeoutMs || 10 * 60 * 1000);
    while (!fs.existsSync(path.join(transactionDir, "commit.json"))) {
      if (fs.existsSync(path.join(transactionDir, "cancel.json"))) { update("cancelled"); releaseLock(); return; }
      if (!await adapter.alive(journal.parent)) throw new Error("原 Launcher 在确认安装前退出");
      if (Date.now() > deadline) throw new Error("安装确认超时");
      await delay(options.pollMs || 200);
    }
    if (readJson(path.join(transactionDir, "commit.json")).token !== journal.token) throw new Error("安装事务许可无效");
    if (!await adapter.waitExit(journal.parent, options.parentExitTimeoutMs || 60000)) throw new Error("旧版进程尚未退出，安装已取消");
    await verifyInstaller(journal.installerPath, journal.size, journal.sha256);
    await verifyBackup(journal);
    update("installing");
    mutationStarted = true;
    await adapter.install(journal);
    update("starting");
    candidate = await adapter.candidate(journal);
    journal.candidate = candidate;
    update("awaiting-confirmation");
    const ackDeadline = Date.now() + (options.ackTimeoutMs || 180000);
    while (Date.now() < ackDeadline) {
      if (!await adapter.alive(candidate)) throw new Error("新版启动后退出");
      const startupPath = path.join(transactionDir, "startup.json");
      if (fs.existsSync(startupPath)) {
        const record = readJson(startupPath);
        if (record.token === journal.token && record.pid === candidate.pid && Number.isSafeInteger(record.gatewayPid)) {
          const observed = await adapter.processInfo(record.gatewayPid);
          if (observed && observed.parentPid !== candidate.pid) throw new Error("无法确认 Gateway 归属");
          // 只在候选父进程仍可确认存活时记录完整身份，失败恢复不重新认领孤儿 PID。
          if (!await adapter.alive(candidate)) throw new Error("新版启动后退出");
          if (observed) gateway = observed;
        }
      }
      const ackPath = path.join(transactionDir, "ack.json");
      if (fs.existsSync(ackPath)) {
        const ack = readJson(ackPath);
        if (ack.token !== journal.token || ack.version !== journal.targetVersion || ack.pid !== candidate.pid || !samePath(ack.exePath, journal.exePath)) throw new Error("新版启动确认不匹配");
        const confirmedGateway = await adapter.processInfo(ack.gatewayPid);
        if (!confirmedGateway || confirmedGateway.parentPid !== candidate.pid || !await adapter.alive(confirmedGateway) || !await adapter.alive(candidate)) throw new Error("新版 Gateway 身份校验失败");
        update("completed"); releaseLock(); return;
      }
      await delay(options.pollMs || 250);
    }
    throw new Error("新版启动确认超时");
  } catch (error) {
    if (!mutationStarted) {
      try {
        if (!await adapter.alive(journal.parent)) await adapter.relaunchOriginal(journal);
        update("cancelled", error.message); releaseLock();
      } catch (restartError) { update("recovery-needed", `${error.message}；${restartError.message}`); }
      return;
    }
    if (error.recoveryUnsafe) { update("recovery-needed", error.message); return; }
    try {
      // 未在父进程存活时捕获的 Gateway 只检查是否仍存在，绝不据孤儿 parentPid 接管。
      const startupPath = path.join(transactionDir, "startup.json");
      if (candidate && !gateway && fs.existsSync(startupPath)) {
        const record = readJson(startupPath);
        if (record.token === journal.token && record.pid === candidate.pid && Number.isSafeInteger(record.gatewayPid)) {
          if (await adapter.processInfo(record.gatewayPid)) throw new Error("未捕获 Gateway 完整身份，保留备份等待恢复");
        }
      }
      if (candidate && !await adapter.stopOwned(candidate)) throw new Error("新版进程无法停止");
      if (gateway && !await adapter.stopOwned(gateway)) throw new Error("新版 Gateway 无法停止");
      await verifyBackup(journal);
      update("restoring", error.message);
      await adapter.restore(journal);
      update("rolled-back", error.message); releaseLock();
    } catch (recoveryError) { update("recovery-needed", `${error.message}；${recoveryError.message}`); }
  }
}

module.exports = { GUID, REGISTRY_KEYS, TERMINAL, readJson, atomicJson, digest, verifyInstaller, assertPlainPath, inventory, verifyBackup, validateJournal, validateRegistryExport, powershell, processInfo, alive, waitExit, stopOwned, launch, nativeAdapter, runTransaction, samePath, within, newerVersion, ownedFromSnapshot };
if (require.main === module) processInfo(process.pid).then(helperIdentity => runTransaction(process.argv[2], undefined, { helperIdentity })).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
