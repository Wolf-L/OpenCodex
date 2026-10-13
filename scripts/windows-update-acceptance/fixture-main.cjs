"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app } = require("electron");
const { ROOT, assertIsolated } = require("./safety.cjs");
const helper = require("./self-update-helper.cjs");
const api = require("./self-update-install.cjs");
const { createSelfUpdateController } = require("./self-update-controller.cjs");
assertIsolated({ username: process.env.USERNAME, root: ROOT, args: [process.env.OPENCODEX_ACCEPTANCE_FLAG], marker: JSON.parse(fs.readFileSync(path.join(ROOT, "ISOLATED-SANDBOX.json"))), platform: process.platform, githubActions: process.env.GITHUB_ACTIONS, runnerEnvironment: process.env.RUNNER_ENVIRONMENT });
const data = path.join(ROOT, "user-data");
fs.mkdirSync(data, { recursive: true });
// 夹具日志与缓存均写入隔离用户目录，不修改应用备份清单。
for (const [name, location] of [["userData", data], ["sessionData", path.join(data, "session")], ["logs", path.join(data, "logs")], ["crashDumps", path.join(data, "crashes")]]) app.setPath(name, location);
const version = require("../package.json").version;
const identity = { userDataDir: data, exePath: process.execPath, currentVersion: version };
const log = entry => fs.appendFileSync(path.join(data, "events.jsonl"), JSON.stringify({ ...entry, at: new Date().toISOString(), pid: process.pid, version }) + "\n");
let gateway;
async function startGateway() {
  gateway = spawn(process.execPath, [path.join(__dirname, "fixture-gateway.cjs")], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture gateway readiness timeout")), 15000);
    gateway.once("message", message => { clearTimeout(timer); message.ready === true ? resolve() : reject(new Error("invalid gateway readiness")); });
    gateway.once("error", reject);
  });
  log({ type: "gateway-ready", gatewayPid: gateway.pid });
}
async function stopGateway() {
  if (!gateway || gateway.exitCode != null) return true;
  const processIdentity = await helper.processInfo(gateway.pid);
  if (processIdentity?.parentPid !== process.pid) throw new Error("fixture gateway ownership mismatch");
  const stopped = await helper.stopOwned(processIdentity);
  log({ type: "gateway-stopped", gatewayPid: gateway.pid, stopped });
  return stopped;
}
let prepared;
const controller = createSelfUpdateController({ ...identity, packaged: app.isPackaged, getCandidate: () => null, canInstall: () => true, startGateway, stopGateway, quit: () => app.quit(),
  // 仅绕过网络下载；真实安装 API 会再次验证字节数和摘要，安装/恢复均使用原生实现。
  createDownloader: () => ({ state: () => ({ status: "ready" }), cancel() {}, async verifyPrepared() { return prepared; } }),
  onState: () => log({ type: "controller-state" }),
});
api.recordUpdateStartup(identity);
app.whenReady().then(async () => {
  await startGateway();
  api.recordUpdateStartup({ ...identity, gatewayPid: gateway.pid });
  log({ type: "ready", transaction: process.env.OPENCODEX_UPDATE_TRANSACTION || null });
  if (process.env.OPENCODEX_UPDATE_TRANSACTION && version === "1.0.2") {
    // 留出原生进程身份采集时间，再真实退出，让助手执行启动失败恢复。
    setTimeout(async () => { await stopGateway(); app.exit(42); }, 8000);
  } else api.confirmWindowsUpdate({ ...identity, gatewayPid: gateway.pid });
  let processing = false;
  setInterval(async () => {
    const commandFile = path.join(data, `command-${process.pid}.json`);
    if (processing || !fs.existsSync(commandFile)) return;
    processing = true;
    try {
      const command = JSON.parse(fs.readFileSync(commandFile));
      fs.renameSync(commandFile, `${commandFile}.consumed`);
      prepared = command.prepared;
      await controller.install();
    } catch (error) { log({ type: "install-rejected", error: error.message }); }
    finally { processing = false; }
  }, 250);
}).catch(error => { log({ type: "fixture-error", error: error.stack }); app.exit(43); });
