const { findOfficialRuntimeLayout } = require("./official-layout.cjs");
const { assertLinuxRuntimeLayout } = require("./linux-runtime.cjs");
const { createMacRunner } = require("./platform/macos.cjs");
const { createPortableRunner } = require("./platform/portable.cjs");
const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");
const { createHostModificationRuntime } = require("../runtime/modification/production-runtime.cjs");
const path = require("path");
const fs = require("fs");
const { RuntimeVersionStore, inventory, hash } = require("../runtime/runtime-version-store.cjs");
const { RUNTIME_BINDING_ENV, ROLLBACK_PIN_ENV, sourceIdentity, createRuntimeBinding, digestFile } = require("../runtime/runtime-source-binding.cjs");

async function prepareOfficialElectronRuntime({ runtimeDir, officialBundleDir, logger, autoScanUpgrade = process.env.CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE !== "0", rollbackPinned = false }) {
  const { LocalCodexBundleProvider } = require("../dist/official/LocalCodexBundleProvider.js");
  const env = { ...process.env, CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE: autoScanUpgrade ? "1" : "0", [ROLLBACK_PIN_ENV]: rollbackPinned ? "1" : "0" };
  delete env[RUNTIME_BINDING_ENV];
  const bundleLogger = typeof logger === "function" ? { info: (message) => logger(`[official-bundle] ${message}\n`), warn: (message, error) => logger(`[official-bundle] ${message}${error ? `: ${error.message || error}` : ""}\n`) } : undefined;
  const projectRoot = path.resolve(__dirname, "../..");
  const store = new RuntimeVersionStore(officialBundleDir);
  return store.locked(async () => {
    const pointer = store.pointer();
    const current = pointer ? store.read(pointer.current, { verify: false }) : null;
    const provider = new LocalCodexBundleProvider({ bundleDirEnv: officialBundleDir, env, logger: bundleLogger });
    const useCurrent = async () => {
      // 每次启动按内容校验完整来源和提取后的 bundle；损坏 runner 可由已验证来源重建。
      store.read(current.id, { verify: true, verifyRunner: false });
      const pinned = new LocalCodexBundleProvider({ bundleDirEnv: current.bundleDir,
        env: { ...env, [ROLLBACK_PIN_ENV]: "1" }, logger: bundleLogger });
      const bundle = pinned.ensure({ projectRoot });
      let forceRebuild = false;
      try { forceRebuild = hash(inventory(path.join(current.dir, "runner"))) !== current.components.runner; }
      catch { forceRebuild = true; }
      if (forceRebuild && process.platform === "darwin") throw new Error("macOS runner 快照已损坏，请重新准备完整版本");
      const runtime = await prepareSelectedRuntime({ bundle, layout: current.layout, runtimeDir: path.join(current.dir, "runner"), logger, forceRebuild });
      store.seal(current, bundle, runtime);
      return runtime;
    };
    if (current && (rollbackPinned || !autoScanUpgrade)) return useCurrent();
    let sourceInfo;
    let layout;
    if (!current && (!autoScanUpgrade || rollbackPinned) && fs.existsSync(path.join(officialBundleDir, "manifest.json"))) {
      // 旧格式迁移先验证原有缓存的来源，不能借迁移偷偷升级用户已固定的版本。
      const legacy = provider.ensure({ projectRoot });
      layout = findOfficialRuntimeLayout({ officialBundleDir, logger, bundle: legacy, rollbackPinned });
      sourceInfo = provider.sourceInfoReader.read({ installRoot: legacy.sourceAppPath, resourcesDir: legacy.sourceResourcesPath,
        asarPath: legacy.sourceAsarPath, codexBinaryPath: legacy.codexBinaryPath, layoutKind: legacy.manifest.sourceLayoutKind,
        platformHint: legacy.manifest.sourcePlatformHint });
    } else {
      let scanned;
      try { scanned = provider.scanner.find({ cachedAsarPath: current?.origin?.asarPath }); }
      catch (error) {
        const override = env.CODEX_DESKTOP_APP_PATH;
        if (!current || (override && ![current.origin.asarPath, current.origin.installRoot, current.origin.resourcesDir].includes(override))) throw error;
        // 只在没有新的显式路径要求时回用完整快照；官方安装被卸载不应破坏已固定版本。
        logger?.("[official-bundle] 更新扫描不可用，校验并复用完整离线快照\n");
        return useCurrent();
      }
      sourceInfo = provider.sourceInfoReader.read(scanned);
      layout = findOfficialRuntimeLayout({ officialBundleDir, logger, bundle: {
        sourceAppPath: sourceInfo.installRoot, sourceResourcesPath: sourceInfo.resourcesDir,
        sourceAsarPath: sourceInfo.asarPath, codexBinaryPath: sourceInfo.codexBinaryPath,
        manifest: { sourceLayoutKind: sourceInfo.layoutKind, sourcePlatformHint: sourceInfo.platformHint },
      }, rollbackPinned });
    }
    assertLinuxRuntimeLayout(layout);
    const plan = store.sourcePlan(layout, sourceInfo);
    if (current && current.originIdentity === plan.identity) return useCurrent();
    const candidate = store.snapshot(layout, sourceInfo, plan);
    try {
      // 提取和 runner 均准备到同一独立版本目录；失败不会移动当前缓存或旧版本。
      const snapshotEnv = { ...env, [ROLLBACK_PIN_ENV]: "0", CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE: "1",
        CODEX_DESKTOP_APP_PATH: candidate.sourceInfo.asarPath,
        CODEX_APP_SERVER_BINARY_PATH: candidate.sourceInfo.codexBinaryPath || "", CODEX_CLI_PATH: candidate.sourceInfo.codexBinaryPath || "" };
      const prepared = new LocalCodexBundleProvider({ bundleDirEnv: path.join(candidate.dir, "bundle"), env: snapshotEnv, logger: bundleLogger });
      // 显式传入已验证布局，避免 Windows CLI 定位器再次回落到用户目录。
      prepared.scanner.find = () => ({ ...candidate.sourceInfo, platformHint: sourceInfo.platformHint });
      prepared.sourceInfoReader.read = () => ({ ...candidate.sourceInfo,
        sourceAsarMtimeMs: Math.trunc(fs.statSync(candidate.sourceInfo.asarPath).mtimeMs) });
      const bundle = prepared.ensure({ projectRoot });
      const runtime = await prepareSelectedRuntime({ bundle, layout: candidate.layout, runtimeDir: path.join(candidate.dir, "runner"), logger });
      store.seal(candidate, bundle, runtime);
      store.activate(candidate.id, pointer);
      logger?.(`[official-bundle] 已验证并切换完整运行时版本 ${bundle.version} (${candidate.id})\n`);
      return runtime;
    } catch (error) {
      // 只清理本轮未发布版本；已发布版本和任何旧备份均保留。
      if (store.pointer()?.current !== candidate.id) fs.rmSync(candidate.dir, { recursive: true, force: true });
      throw error;
    }
  });
}

async function prepareSelectedRuntime({ bundle, layout, runtimeDir, logger, forceRebuild = false }) {
  const sourceExecutableHash = digestFile(layout.executablePath);
  const selectedSource = bundle.manifest.sourceIdentity || sourceIdentity(bundle.manifest);
  const manifestHash = digestFile(path.join(bundle.bundleDir, "manifest.json"));
  // 先检查源 ELF 架构与权限，再复制运行时；其它平台不受 Linux 预检影响。
  assertLinuxRuntimeLayout(layout);
  let compatibilityService = null;
  try {
    compatibilityService = createCompatibilityService();
  } catch {
    // 兼容骨架属于诊断旁路，初始化失败时 Runner 仍按原流程构建。
  }
  const modificationSnapshots = new Map();
  const modificationRuntime = createHostModificationRuntime({
    host: "runner",
    compatibilityService,
    publish(point) {
      modificationSnapshots.set(point.id, point);
    },
  });
  const runCompatibility = (point, operation) => {
    let capability = operation;
    try {
      capability = modificationRuntime.coordinator.bind(point, operation);
    } catch {}
    return capability();
  };
  try {
    let result;
    if (process.platform === "darwin") {
      result = await createMacRunner({ layout, runtimeDir, logger, runCompatibility });
    } else if (process.platform === "win32" || process.platform === "linux") {
      result = await createPortableRunner({ layout, runtimeDir, logger, runCompatibility, forceRebuild });
    } else {
      throw new Error(`当前 official Electron runner 不支持平台：${process.platform}`);
    }

    const applicablePointIds = new Set(result.compatibilityPoints || []);
    for (const point of Object.values(modificationRuntime.points.runner)) {
      if (applicablePointIds.has(point.id)) continue;
      try {
        modificationRuntime.coordinator.execute(point, () => undefined, { verify: () => true });
        modificationRuntime.coordinator.setEnabled(point, false, "Not applicable on the current platform");
      } catch {}
    }
    if (JSON.stringify(sourceIdentity(bundle.manifest)) !== JSON.stringify(selectedSource)
      || digestFile(path.join(bundle.bundleDir, "manifest.json")) !== manifestHash
      || digestFile(layout.executablePath) !== sourceExecutableHash) throw new Error("官方运行时在准备过程中发生变化，请重试");
    const runtimeBinding = createRuntimeBinding(bundle, layout, result.executablePath, { source: selectedSource, manifestHash, sourceExecutableHash });
    return { ...result, runtimeBinding, modificationPoints: [...modificationSnapshots.values()] };
  } finally {
    // 先持久化最后一个可运行快照，再释放只服务于本次 Runner 构建的 Provider 状态。
    compatibilityService?.dispose();
    try {
      await modificationRuntime.coordinator.dispose();
    } catch {
      // Runner 已完成或已失败的业务结果优先；退出清理异常不能改变原构建返回值。
    }
  }
}

module.exports = {
  prepareOfficialElectronRuntime,
  __test: { prepareSelectedRuntime },
};
