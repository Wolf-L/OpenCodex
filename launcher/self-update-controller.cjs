"use strict";
const path = require("node:path");

function createSelfUpdateController(options) {
  const { userDataDir, exePath, currentVersion, platform = process.platform, arch = process.arch, packaged,
    getCandidate, canInstall, stopGateway, startGateway, quit, onState = () => {} } = options;
  const installApi = options.installApi || require("./self-update-install.cjs");
  const createDownloader = options.createDownloader || require("./self-update-download.cjs").createSelfUpdateDownloader;
  const supported = platform === "win32" && arch === "x64" && !!packaged;
  const identity = { userDataDir, exePath, currentVersion };
  const downloader = createDownloader({ root: path.join(userDataDir, "self-update", "downloads"), currentVersion, onState });
  let operation = null, phase = "", error = "", handedOff = false;
  let recovery = supported ? installApi.readWindowsUpdateState(identity) : null;
  function state() {
    if (supported) recovery = installApi.readWindowsUpdateState(identity);
    return { ...downloader.state(), supported, ...(phase ? { status: phase } : {}),
      ...(error ? { error } : {}), installing: !!operation, handedOff, recovery };
  }
  function fail(message) { error = message; phase = "error"; onState(); }
  async function download() {
    if (!supported || operation) throw new Error("当前安装方式不支持此更新操作");
    const candidate = getCandidate();
    if (!candidate) throw new Error("请先检查具有完整校验清单的 Windows 更新");
    phase = ""; error = "";
    await downloader.download(candidate);
    return state();
  }
  function cancel() {
    // 下载可随时取消；开始备份安装后由持久事务负责恢复，不提供半途强杀按钮。
    if (!operation) downloader.cancel();
    return state();
  }
  async function install({ recover = false } = {}) {
    if (handedOff) return state();
    if (operation) return operation;
    if (!supported || !canInstall()) throw new Error("服务操作进行中或当前安装方式不支持更新，请稍后重试");
    if (recover && installApi.readWindowsUpdateState(identity).canRecover !== true)
      throw new Error("尚不能确认自动恢复安全；已保留完整备份，请检查更新日志");
    error = ""; phase = recover ? "recovering" : "preparing";
    operation = Promise.resolve().then(async () => {
      let handle, stopped = false;
      try {
        if (recover) handle = await installApi.recoverWindowsUpdate(identity);
        else {
          const verified = await downloader.verifyPrepared();
          handle = await installApi.prepareWindowsUpdate({ ...identity, ...verified,
            onProgress: () => onState() });
        }
        if (!handle || typeof handle.commit !== "function") throw new Error("更新助手尚未就绪，未停止当前服务");
        // 备份与助手就绪之后才停服；退出不成功绝不能交给 NSIS 覆盖当前应用。
        stopped = await stopGateway();
        if (!stopped) throw new Error("当前服务未能退出，已取消安装");
        await handle.commit();
        phase = "installing"; handedOff = true; onState();
        quit();
      } catch (failure) {
        try { await handle?.cancel(); } catch (cancelError) {
          fail(`${failure.message}; ${cancelError.message}`);
          throw failure;
        }
        operation = null;
        fail(failure.message);
        // 尚未移交助手时失败，恢复刚停止的原服务；安装目录未由此控制器改写。
        if (stopped && !handedOff) await startGateway();
        throw failure;
      } finally {
        operation = null;
        recovery = supported ? installApi.readWindowsUpdateState(identity) : null;
        onState();
      }
      return state();
    });
    onState();
    return operation;
  }
  return { state, download, cancel, install, recover: () => install({ recover: true }),
    isInstalling: () => !!operation || handedOff, canQuit: () => !operation || handedOff };
}

module.exports = { createSelfUpdateController };
