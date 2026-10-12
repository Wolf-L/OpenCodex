"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { RuntimeVersionStore } = require("./runtime-version-store.cjs");
const { withPhysicalAsarAccess } = require("./runtime-source-binding.cjs");

function inspectRuntimeUpdate({ officialBundleDir, env = process.env }) {
  const { LocalCodexBundleProvider } = require("../dist/official/LocalCodexBundleProvider.js");
  const { findOfficialRuntimeLayout } = require("../runner/official-layout.cjs");
  const { assertLinuxRuntimeLayout } = require("../runner/linux-runtime.cjs");
  const store = new RuntimeVersionStore(officialBundleDir);
  const pointer = store.pointer();
  const current = pointer ? store.read(pointer.current, { verify: false }) : null;
  // 只调用扫描/读取接口，不使用 ensure()；预演不提取、不生成 runner、不切换版本。
  const provider = new LocalCodexBundleProvider({ bundleDirEnv: officialBundleDir, env });
  const info = withPhysicalAsarAccess(() => provider.sourceInfoReader.read(provider.scanner.find({ cachedAsarPath: current?.origin?.asarPath })));
  const layout = findOfficialRuntimeLayout({ officialBundleDir, bundle: {
    sourceAppPath: info.installRoot, sourceResourcesPath: info.resourcesDir, sourceAsarPath: info.asarPath,
    codexBinaryPath: info.codexBinaryPath, manifest: { sourceLayoutKind: info.layoutKind, sourcePlatformHint: info.platformHint },
  } });
  assertLinuxRuntimeLayout(layout);
  const plan = store.sourcePlan(layout, info);
  const sourceBytes = plan.roots.reduce((sum, root) => sum + root.entries.reduce((n, entry) => n + (entry[1] === "file" ? entry[2] : 0), 0), 0);
  let ancestor = path.dirname(store.root);
  while (!fs.existsSync(ancestor)) { const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error("找不到快照目录父级"); ancestor = parent; }
  let writable = true;
  try { fs.accessSync(ancestor, fs.constants.W_OK); } catch { writable = false; }
  const space = fs.statfsSync(ancestor);
  const availableBytes = Number(space.bavail) * Number(space.bsize);
  const changed = current?.originIdentity !== plan.identity;
  // 提取体积与 staging 峰值依包内容变化；展示保守预算，不声称精确安装大小。
  const estimatedAdditionalBytes = changed ? sourceBytes * 3 + 256 * 1024 * 1024 : (current?.sizes.runner || 0) * 2 + 64 * 1024 * 1024;
  const previousFailure = store.startupState();
  return { checkedAt: new Date().toISOString(), version: info.version, build: info.build, platform: process.platform, arch: process.arch,
    changed, sourceBytes, estimatedAdditionalBytes, availableBytes, writable,
    ok: writable && availableBytes >= estimatedAdditionalBytes, originIdentity: plan.identity,
    retryRequired: !!previousFailure && previousFailure.originIdentity === plan.identity && previousFailure.state !== "confirmed" && previousFailure.id !== current?.id,
    currentVersion: current?.version || null, sourcePath: info.installRoot, targetPath: store.root };
}

function preflightRuntimeUpdate(options, { timeoutMs = 180000 } = {}) {
  // 大目录内容校验放入一次性 worker，Launcher 窗口保持响应，结束后释放线程。
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { opencodexPreflight: true, options } });
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error("运行时预检超时，当前服务未改动")), timeoutMs);
    worker.once("message", value => value.error ? finish(new Error(value.error)) : finish(null, value.result));
    worker.once("error", error => finish(error));
    worker.once("exit", code => { if (!settled) finish(new Error(`运行时预检线程提前退出：${code}`)); });
  });
}

if (!isMainThread && workerData?.opencodexPreflight) {
  try { parentPort.postMessage({ result: inspectRuntimeUpdate(workerData.options) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
}

module.exports = { inspectRuntimeUpdate, preflightRuntimeUpdate };
