"use strict";
const path = require("node:path");

function childAlive(child) {
  return !!child?.pid && child.exitCode == null && child.signalCode == null && !child.killed;
}
function processAlive(pid) {
  // 同步文件校验可能阻塞 exit 回调；发布前再向 OS 查询，避免确认已退出但事件尚未投递的进程。
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function matchesReadyRuntime(status, child, binding) {
  // 端口上其他进程或上轮残留状态不能确认本轮候选版本。
  return status?.ok === true && status.gateway?.pid === child.pid && status.officialIpc?.ready === true
    && status.officialAppServer?.ready === true && !status.officialAppServer.lastError
    && path.resolve(status.officialBundle?.bundleDir || ".") === binding.bundleDir
    && status.officialBundle?.codexBinaryPath === binding.codexBinaryPath;
}

async function stopStartupChild(child, { timeoutMs = 5000 } = {}) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return true;
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); child.off("exit", exited); resolve(value); };
    const exited = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", exited);
    // 必须等到真实 exit；kill() 返回成功不等于文件锁已释放。
    try { child.kill("SIGKILL"); } catch { finish(false); }
  });
}

async function launchAndConfirmRuntime({ runtime, spawn, confirm, fetchStatus,
  timeoutMs = 120000, intervalMs = 250, stableMs = 1000, stop = stopStartupChild, isProcessAlive = processAlive }) {
  let child, spawnError, status, readySince = null;
  const controller = new AbortController();
  const expired = setTimeout(() => controller.abort(), timeoutMs);
  const onError = error => { spawnError = error; controller.abort(); };
  const onExit = () => onError(new Error("候选 Gateway 在启动确认期间退出"));
  const alive = () => childAlive(child) && isProcessAlive(child.pid);
  try {
    child = spawn();
    child.on("error", onError);
    child.on("exit", onExit);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !controller.signal.aborted) {
      if (spawnError) throw spawnError;
      if (!alive()) throw new Error("候选 Gateway 已退出或未能创建进程");
      try { status = await fetchStatus({ signal: controller.signal }); }
      catch (error) { if (controller.signal.aborted) throw spawnError || error; status = null; }
      if (matchesReadyRuntime(status, child, runtime.runtimeBinding)) {
        readySince ??= Date.now();
        if (Date.now() - readySince >= stableMs) {
          if (!alive()) throw new Error("候选 Gateway 在确认前退出");
          // confirm 由版本存储提供，最后一步才写指针；失败仍先停止本子进程。
          await confirm(() => { if (!alive()) throw new Error("候选 Gateway 在发布前退出"); });
          return { child, status };
        }
      } else readySince = null;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw spawnError || new Error(`候选 Gateway 在 ${timeoutMs}ms 内未通过 IPC/CLI 启动确认`);
  } catch (error) {
    if (!await stop(child)) {
      const failure = new Error("候选 Gateway 未退出，停止自动回退以避免同时运行两个版本", { cause: error });
      failure.runtimeStopFailed = true; throw failure;
    }
    throw error;
  } finally {
    clearTimeout(expired); controller.abort(); child?.off("error", onError); child?.off("exit", onExit);
  }
}

module.exports = { childAlive, matchesReadyRuntime, stopStartupChild, launchAndConfirmRuntime };
