const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  RUNNER_LINUX_EXECUTABLE_NAME,
  RUNNER_WINDOWS_EXECUTABLE_NAME,
} = require("../shared/constants.cjs");
const {
  fileFingerprint,
  isDirectory,
  isFile,
  realpathSafe,
  readJsonIfPresent,
  withPhysicalAsarAccess,
} = require("../shared/fs-utils.cjs");
const { logLine } = require("../shared/logging.cjs");
const { writeGatewayAsar } = require("../shared/runner-asar.cjs");
const { patchWindowsRunnerAsarIntegrity } = require("./windows-integrity.cjs");
const { runner: runnerPoints } = require("../../runtime/modification/point-refs.cjs");

const WINDOWS_READ_WRITE_COPY_BUFFER_SIZE = 8 * 1024 * 1024;

function runnerExecutableNameForPlatform() {
  if (process.platform === "win32") return RUNNER_WINDOWS_EXECUTABLE_NAME;
  if (process.platform === "linux") return RUNNER_LINUX_EXECUTABLE_NAME;
  throw new Error(`portable runner 不支持平台：${process.platform}`);
}

function shouldSkipPortableRuntimeEntry(entry, sourcePath, layout) {
  const name = entry.name.toLowerCase();
  const sourceRealPath = realpathSafe(sourcePath);
  const runtimeRootRealPath = realpathSafe(layout.runtimeRoot);
  const appRootRealPath = realpathSafe(layout.appRoot);
  const asarRealPath = realpathSafe(layout.asarPath);
  // runner 自己生成 resources/app.asar；不能把官方 app.asar 或 app.asar.unpacked 复制进 OpenCodex runtime。
  if (entry.isDirectory() && name === "resources") return true;
  if (sourceRealPath === asarRealPath || sourcePath === `${layout.asarPath}.unpacked`) return true;
  if (sourceRealPath === realpathSafe(`${layout.asarPath}.unpacked`)) return true;
  // MSIX 可能是“包根目录放 exe，app/resources 放官方 bundle”；复制运行时时要避开这个 app 子目录。
  if (entry.isDirectory() && runtimeRootRealPath !== appRootRealPath && sourceRealPath === appRootRealPath) return true;
  if (sourceRealPath === realpathSafe(layout.executablePath)) return true;
  return false;
}

function portableRuntimeFingerprint(layout, platform = process.platform) {
  const entries = [];
  // 目录 mtime 不反映子文件原位修改，递归记录资源文件，且不沿符号链接递归。
  function visit(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const sourcePath = path.join(directory, entry.name);
      if (!relative && shouldSkipPortableRuntimeEntry(entry, sourcePath, layout)) continue;
      const name = path.join(relative, entry.name);
      entries.push({
        name,
        kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        stat: fileFingerprint(sourcePath),
      });
      if (entry.isDirectory()) visit(sourcePath, name);
    }
  }
  visit(layout.runtimeRoot);
  return {
    platform,
    arch: process.arch,
    source: realpathSafe(layout.runtimeRoot),
    appRoot: realpathSafe(layout.appRoot),
    executable: fileFingerprint(layout.executablePath),
    asar: fileFingerprint(layout.asarPath),
    entries,
  };
}

function samePortableRuntimeFingerprint(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function copyFileByReadWriteSync(sourcePath, targetPath, { preserveTimestamps = true } = {}) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const buffer = Buffer.allocUnsafe(WINDOWS_READ_WRITE_COPY_BUFFER_SIZE);
  let sourceFd = null;
  let targetFd = null;

  try {
    sourceFd = fs.openSync(sourcePath, "r");
    targetFd = fs.openSync(targetPath, "w");

    for (;;) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      let offset = 0;
      while (offset < bytesRead) {
        offset += fs.writeSync(targetFd, buffer, offset, bytesRead - offset);
      }
    }
  } finally {
    if (targetFd !== null) fs.closeSync(targetFd);
    if (sourceFd !== null) fs.closeSync(sourceFd);
  }

  try {
    const stat = fs.statSync(sourcePath);
    fs.chmodSync(targetPath, stat.mode);
    if (preserveTimestamps) fs.utimesSync(targetPath, stat.atime, stat.mtime);
  } catch {}
}

function tryCopyWindowsFileByReadWrite({
  sourcePath,
  targetPath,
  name,
  logger,
  error,
  platform = process.platform,
  logFallback = true,
}) {
  if (platform !== "win32") return false;

  try {
    if (!fs.statSync(sourcePath).isFile()) return false;
  } catch {
    return false;
  }

  /**
   * WindowsApps/MSIX 文件可能可读却无法通过 CopyFile 复制；分块读写避免一次性加载大型 DLL。
   * 该兜底只处理 runner 工作副本，不改变官方 resources 仍是唯一数据源的语义。
   */
  copyFileByReadWriteSync(sourcePath, targetPath);
  if (logFallback) {
    const reason = error && error.code ? error.code : error instanceof Error ? error.message : String(error || "");
    logLine(logger, `official Electron runtime copied Windows file via read/write fallback: ${name || path.basename(sourcePath)} (${reason})`);
  }
  return true;
}

function recoverPortableRuntimeFileCopy({
  entry,
  sourcePath,
  targetPath,
  logger,
  error,
  platform = process.platform,
  logFallback = true,
}) {
  if (tryCopyWindowsFileByReadWrite({ sourcePath, targetPath, name: entry.name, logger, error, platform, logFallback })) {
    return { copied: true, synthesized: false };
  }
  return null;
}

function copyPortableRuntimeFile({ entry, sourcePath, targetPath, logger, platform = process.platform, logFallback = true }) {
  try {
    fs.copyFileSync(sourcePath, targetPath);
    return { copied: true, synthesized: false };
  } catch (error) {
    const recovered = recoverPortableRuntimeFileCopy({ entry, sourcePath, targetPath, logger, error, platform, logFallback });
    if (recovered) return recovered;
    throw error;
  }
}

function copyPortableRuntimeDirectoryByReadWrite({
  sourcePath,
  targetPath,
  logger,
  error,
  platform = process.platform,
  logDirectory = true,
}) {
  if (platform !== "win32") return false;

  try {
    if (!fs.statSync(sourcePath).isDirectory()) return false;
  } catch {
    return false;
  }

  // 目标目录可能已被原生复制部分写入；逐项覆盖并保留来源中不存在的已有文件。
  fs.mkdirSync(targetPath, { recursive: true });
  for (const child of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const childSourcePath = path.join(sourcePath, child.name);
    const childTargetPath = path.join(targetPath, child.name);

    if (child.isDirectory()) {
      copyPortableRuntimeDirectoryByReadWrite({
        sourcePath: childSourcePath,
        targetPath: childTargetPath,
        logger,
        error,
        platform,
        logDirectory: false,
      });
    } else if (child.isFile()) {
      copyPortableRuntimeFile({
        entry: child,
        sourcePath: childSourcePath,
        targetPath: childTargetPath,
        logger,
        platform,
        logFallback: false,
      });
    } else {
      fs.cpSync(childSourcePath, childTargetPath, {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
      });
    }
  }

  if (logDirectory) {
    const reason = error && error.code ? error.code : error instanceof Error ? error.message : String(error || "");
    logLine(logger, `official Electron runtime copied Windows directory via read/write fallback: ${path.basename(sourcePath)} (${reason})`);
  }
  return true;
}

function copyPortableRuntimeEntry({ entry, sourcePath, targetPath, logger, platform = process.platform }) {
  try {
    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
    return { copied: true, synthesized: false };
  } catch (error) {
    if (entry.isFile()) {
      const recovered = recoverPortableRuntimeFileCopy({ entry, sourcePath, targetPath, logger, error, platform });
      if (recovered) return recovered;
    }
    if (
      typeof entry.isDirectory === "function" &&
      entry.isDirectory() &&
      copyPortableRuntimeDirectoryByReadWrite({ sourcePath, targetPath, logger, error, platform })
    ) {
      return { copied: true, synthesized: false };
    }
    throw error;
  }
}

function copyPortableRuntimeExecutable({ sourcePath, targetPath, logger, platform = process.platform }) {
  copyPortableRuntimeFile({
    entry: {
      name: path.basename(sourcePath),
      isFile: () => true,
    },
    sourcePath,
    targetPath,
    logger,
    platform,
  });
}

function refreshWindowsRuntimeManifests({ layout, runnerRootDir, logger, platform = process.platform }) {
  if (platform !== "win32") return;

  for (const entry of fs.readdirSync(layout.runtimeRoot, { withFileTypes: true })) {
    // 仅重写运行时根目录的外部程序集清单；不改官方源文件，也不接触 PE 内嵌清单或安全标志。
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".manifest")) continue;
    const sourcePath = path.join(layout.runtimeRoot, entry.name);
    if (shouldSkipPortableRuntimeEntry(entry, sourcePath, layout)) continue;
    const targetPath = path.join(runnerRootDir, entry.name);
    /**
     * 曾观察到复制成功的 OWL 清单仍导致 SideBySide 14001，而相同字节普通读写后可正常解析。
     * 具体机制尚未确定；缓存命中也重新落盘，并保留本次写入时间，避免复用旧副本状态。
     */
    copyFileByReadWriteSync(sourcePath, targetPath, { preserveTimestamps: false });
    logLine(logger, `official Electron runtime refreshed Windows manifest via read/write: ${entry.name}`);
  }
}

function executableSha256(filePath) {
  // Electron 默认把 .asar 当成虚拟目录；摘要必须读取物理归档，并在结束后恢复开关。
  return withPhysicalAsarAccess(() => {
    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let count;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
      return hash.digest("hex");
    } finally {
      fs.closeSync(fd);
    }
  });
}

function assertSeparateRuntime(layout, runnerRootDir) {
  const source = realpathSafe(layout.runtimeRoot);
  const target = realpathSafe(runnerRootDir);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (contains(source, target) || contains(target, source)) throw new Error("runner 工作目录不能与官方运行时目录重叠");
}

function hasCompletePortableCopy({ previous, fingerprint, runnerRootDir, runnerExecutablePath, platform }) {
  if (!previous || previous.version !== 2 || !samePortableRuntimeFingerprint(previous.fingerprint, fingerprint)) return false;
  try {
    if (!isDirectory(runnerRootDir) || executableSha256(runnerExecutablePath) !== previous.executableSha256) return false;
    for (const entry of fingerprint.entries) {
      // 外部程序集清单沿用专门的普通读写修复路径，缺失也可在缓存命中时补回。
      if (platform === "win32" && entry.kind === "file" && path.dirname(entry.name) === "." && entry.name.toLowerCase().endsWith(".manifest")) continue;
      const target = path.join(runnerRootDir, entry.name);
      if (entry.kind === "dir" && !isDirectory(target)) return false;
      if (entry.kind === "file" && !isFile(target)) return false;
      if (entry.kind === "file" && fs.statSync(target).size !== entry.stat?.size) return false;
      if (entry.kind === "symlink" && !isFile(target) && !isDirectory(target)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function copyPortableRuntimeFiles({ layout, runnerRootDir, runnerExecutablePath, logger, platform }) {
  fs.mkdirSync(runnerRootDir, { recursive: true });
  for (const entry of fs.readdirSync(layout.runtimeRoot, { withFileTypes: true })) {
    const sourcePath = path.join(layout.runtimeRoot, entry.name);
    if (shouldSkipPortableRuntimeEntry(entry, sourcePath, layout)) continue;
    copyPortableRuntimeEntry({ entry, sourcePath, targetPath: path.join(runnerRootDir, entry.name), logger, platform });
  }
  copyPortableRuntimeExecutable({ sourcePath: layout.executablePath, targetPath: runnerExecutablePath, logger, platform });
  refreshWindowsRuntimeManifests({ layout, runnerRootDir, logger, platform });
  if (platform !== "win32") fs.chmodSync(runnerExecutablePath, 0o755);
}

function removePreparedDirectory(directory) {
  // 这里只清理本次创建的 staging/backup；锁定文件留待后续人工检查，不掩盖原始失败。
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
}

function publishPortableRuntime({ stagingDir, runnerRootDir, markerPath, marker }) {
  const backupDir = `${runnerRootDir}.previous-${crypto.randomUUID()}`;
  const markerTemp = `${markerPath}.${crypto.randomUUID()}.tmp`;
  let movedPrevious = false;
  let published = false;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerTemp, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
    // 旧目录只在完整准备成功后移动；Windows 文件锁导致 rename 失败时仍保留旧版。
    if (fs.existsSync(runnerRootDir)) {
      fs.renameSync(runnerRootDir, backupDir);
      movedPrevious = true;
    }
    fs.renameSync(stagingDir, runnerRootDir);
    published = true;
    fs.renameSync(markerTemp, markerPath);
  } catch (error) {
    // marker 发布失败也回滚目录，防止上次成功的 marker 指向半成品。
    if (published) fs.renameSync(runnerRootDir, stagingDir);
    if (movedPrevious) fs.renameSync(backupDir, runnerRootDir);
    throw error;
  } finally {
    try { fs.unlinkSync(markerTemp); } catch {}
  }
  removePreparedDirectory(backupDir);
}

function ensurePortableRuntimeCopy({ layout, runnerRootDir, runnerExecutablePath, markerPath, logger, platform = process.platform }) {
  assertSeparateRuntime(layout, runnerRootDir);
  const fingerprint = portableRuntimeFingerprint(layout, platform);
  const previous = readJsonIfPresent(markerPath);
  if (hasCompletePortableCopy({ previous, fingerprint, runnerRootDir, runnerExecutablePath, platform })) {
    refreshWindowsRuntimeManifests({ layout, runnerRootDir, logger, platform });
    logLine(logger, `official Electron runtime cache hit: ${runnerRootDir}`);
    return { copied: false };
  }
  const stagingDir = `${runnerRootDir}.staging-${crypto.randomUUID()}`;
  const stagedExecutable = path.join(stagingDir, path.basename(runnerExecutablePath));
  try {
    copyPortableRuntimeFiles({ layout, runnerRootDir: stagingDir, runnerExecutablePath: stagedExecutable, logger, platform });
    publishPortableRuntime({ stagingDir, runnerRootDir, markerPath, marker: {
      version: 2, fingerprint, executableSha256: executableSha256(stagedExecutable), copiedAt: new Date().toISOString(),
    } });
  } finally {
    removePreparedDirectory(stagingDir);
  }
  logLine(logger, `official Electron runtime copied: ${layout.runtimeRoot} -> ${runnerRootDir}`);
  return { copied: true };
}

async function createPortableRunner({ layout, runtimeDir, logger, forceRebuild = false, runCompatibility = (_point, operation) => operation() }) {
  const workDir = path.join(runtimeDir, "official-electron-runner");
  const runnerRootDir = path.join(workDir, `${process.platform}-${process.arch}`);
  const runnerExecutablePath = path.join(runnerRootDir, runnerExecutableNameForPlatform());
  const markerPath = path.join(workDir, `runtime-manifest-${process.platform}-${process.arch}.json`);
  assertSeparateRuntime(layout, runnerRootDir);
  fs.mkdirSync(workDir, { recursive: true });
  const stagingDir = fs.mkdtempSync(`${runnerRootDir}.staging-`);
  const generationDir = fs.mkdtempSync(path.join(workDir, "gateway-source-"));
  try {
    const runnerResourcesDir = path.join(stagingDir, "resources");
    fs.mkdirSync(runnerResourcesDir);
    // 先在隔离目录生成 gateway 壳；内容一致的缓存不再重写正在运行的 EXE/ASAR。
    const runnerAsarPath = await runCompatibility(runnerPoints.gatewayAsar,
      () => writeGatewayAsar({ runnerResourcesDir, workDir: generationDir }));
    const gatewaySha256 = executableSha256(runnerAsarPath);
    const fingerprint = portableRuntimeFingerprint(layout);
    const previous = readJsonIfPresent(markerPath);
    let cacheHit = !forceRebuild && hasCompletePortableCopy({ previous, fingerprint, runnerRootDir, runnerExecutablePath, platform: process.platform });
    try {
      cacheHit = cacheHit && previous.prepared === true && previous.gatewaySha256 === gatewaySha256 &&
        executableSha256(path.join(runnerRootDir, "resources", "app.asar")) === gatewaySha256;
    } catch { cacheHit = false; }
    if (cacheHit) {
      runCompatibility(runnerPoints.portableLayout, () => refreshWindowsRuntimeManifests({ layout, runnerRootDir, logger }));
      // 摘要已验证该 EXE 对应当前 ASAR；记录适用点，但不再改写正在运行的副本。
      if (process.platform === "win32") runCompatibility(runnerPoints.windowsAsarIntegrity, () => undefined);
      logLine(logger, `official Electron runtime cache hit: ${runnerRootDir}`);
    } else {
      const stagedExecutable = path.join(stagingDir, path.basename(runnerExecutablePath));
      // 缓存损坏只执行一次重建；源损坏或准备失败直接报告，保留上次可用目录与 marker。
      runCompatibility(runnerPoints.portableLayout, () => copyPortableRuntimeFiles({
        layout, runnerRootDir: stagingDir, runnerExecutablePath: stagedExecutable, logger, platform: process.platform,
      }));
      if (process.platform === "win32") {
        runCompatibility(runnerPoints.windowsAsarIntegrity, () => patchWindowsRunnerAsarIntegrity({
          runnerRootDir: stagingDir, runnerExecutablePath: stagedExecutable,
          sourceExecutablePath: layout.executablePath, runnerAsarPath, logger,
        }));
      }
      // 官方源在复制过程中更新时不能把混合内容标记为成功，下次启动重新准备。
      if (!samePortableRuntimeFingerprint(fingerprint, portableRuntimeFingerprint(layout))) {
        throw new Error("官方 Electron 运行时在准备期间发生变化，请重试启动");
      }
      publishPortableRuntime({ stagingDir, runnerRootDir, markerPath, marker: {
        version: 2, prepared: true, fingerprint, gatewaySha256,
        executableSha256: executableSha256(stagedExecutable), copiedAt: new Date().toISOString(),
      } });
      // Windows SxS 以最终路径加载程序集；目录切换后仍需执行已知的清单普通读写修复。
      refreshWindowsRuntimeManifests({ layout, runnerRootDir, logger });
    }
  } finally {
    removePreparedDirectory(stagingDir);
    removePreparedDirectory(generationDir);
  }

  logLine(logger, `prepared official Electron runner: root=${runnerRootDir}`);
  logLine(logger, `official Electron source: app=${layout.appRoot} asar=${layout.asarPath}`);

  return {
    compatibilityPoints: [
      runnerPoints.portableLayout.id,
      runnerPoints.gatewayAsar.id,
      ...(process.platform === "win32" ? [runnerPoints.windowsAsarIntegrity.id] : []),
    ],
    executablePath: runnerExecutablePath,
    runnerAppPath: runnerRootDir,
    officialAppPath: layout.appRoot,
    officialAsarPath: layout.asarPath,
  };
}

module.exports = {
  createPortableRunner,
  __test: {
    copyPortableRuntimeEntry,
    copyPortableRuntimeExecutable,
    ensurePortableRuntimeCopy,
  },
};
