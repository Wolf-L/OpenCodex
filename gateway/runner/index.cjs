const { findOfficialRuntimeLayout } = require("./official-layout.cjs");
const { assertLinuxRuntimeLayout } = require("./linux-runtime.cjs");
const { createMacRunner } = require("./platform/macos.cjs");
const { createPortableRunner } = require("./platform/portable.cjs");
const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");
const { createHostModificationRuntime } = require("../runtime/modification/production-runtime.cjs");
const path = require("path");
const { RUNTIME_BINDING_ENV, ROLLBACK_PIN_ENV, sourceIdentity, createRuntimeBinding, digestFile } = require("../runtime/runtime-source-binding.cjs");

async function prepareOfficialElectronRuntime({ runtimeDir, officialBundleDir, logger, autoScanUpgrade = process.env.CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE !== "0", rollbackPinned = false }) {
  const { LocalCodexBundleProvider } = require("../dist/official/LocalCodexBundleProvider.js");
  const env = { ...process.env, CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE: autoScanUpgrade ? "1" : "0", [ROLLBACK_PIN_ENV]: rollbackPinned ? "1" : "0" };
  delete env[RUNTIME_BINDING_ENV];
  // 在父进程统一确定资源包，再选择与它同源的 Electron；子进程只验证此选择。
  const bundleLogger = typeof logger === "function" ? { info: (message) => logger(`[official-bundle] ${message}\n`), warn: (message, error) => logger(`[official-bundle] ${message}${error ? `: ${error.message || error}` : ""}\n`) } : undefined;
  const bundle = new LocalCodexBundleProvider({ bundleDirEnv: officialBundleDir, env, logger: bundleLogger }).ensure({ projectRoot: path.resolve(__dirname, "../..") });
  const layout = findOfficialRuntimeLayout({ officialBundleDir, logger, bundle, rollbackPinned });
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
      result = await createPortableRunner({ layout, runtimeDir, logger, runCompatibility });
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
};
