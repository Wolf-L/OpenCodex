#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { deploymentEnvironment, buildLaunchPlan } = require("./linux-common.cjs");
const { collectDiagnostics, printDiagnostics } = require("./linux-doctor.cjs");

function supervise(plan, { graceMs = 8000 } = {}) {
  let authorityDir;
  let args = plan.args;
  if (plan.display === "xvfb") {
    // 向整个组发信号时，shell 的 EXIT trap 不一定运行；认证文件由最外层明确拥有和清理。
    authorityDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-xauth-"));
    const authorityFile = path.join(authorityDir, "Xauthority");
    fs.closeSync(fs.openSync(authorityFile, "wx", 0o600));
    args = [`--auth-file=${authorityFile}`, ...args];
  }
  const cleanAuthority = () => {
    if (!authorityDir) return;
    // 仅删除本函数 mkdtemp 创建的私有目录，绝不使用外部传入的 XAUTHORITY 作为删除目标。
    fs.rmSync(authorityDir, { recursive: true, force: true });
    authorityDir = null;
  };
  // 独立进程组涵盖 xvfb-run / D-Bus / supervisor / Electron，停止时不残留显示服务。
  let child;
  try { child = spawn(plan.command, args, { cwd: plan.cwd, env: plan.env, detached: true, stdio: "inherit" }); }
  catch (error) { cleanAuthority(); throw error; }
  let timer;
  let stopping = false;
  const signalGroup = (signal) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const stop = (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    signalGroup(signal);
    // 退出后仍保留短暂兜底，处理拒绝响应退出信号的孙进程；正常清理后立即取消。
    if (!timer) timer = setTimeout(() => { signalGroup("SIGKILL"); }, graceMs);
  };
  child.once("exit", () => {
    signalGroup("SIGTERM");
    cleanAuthority();
    try { process.kill(-child.pid, 0); }
    catch (error) { if (error.code === "ESRCH") { clearTimeout(timer); return; } }
    // 正常退出路径也清理可能遗留的子进程，未存活时 kill 会安全返回 ESRCH。
    if (!timer) timer = setTimeout(() => signalGroup("SIGKILL"), graceMs);
  });
  child.once("error", () => { clearTimeout(timer); cleanAuthority(); });
  return { child, stop };
}

function bindStopSignals(stop, target = process) {
  // 一次性 CLI 必须在整组清理结束前持续接收信号；once/子进程 close 时解绑会让第二次 Ctrl-C 中断兜底清理。
  target.on("SIGINT", () => stop("SIGINT"));
  target.on("SIGTERM", () => stop("SIGTERM"));
}

function main(args = process.argv.slice(2)) {
  if (process.platform !== "linux") throw new Error("linux:start 必须在 Kali/Linux 内运行，不能在 Windows 或 Termux/Android Node.js 内运行");
  if (args.some((arg) => arg !== "--dry-run")) throw new Error("用法：pnpm run linux:start [--dry-run]");
  const env = deploymentEnvironment();
  const report = collectDiagnostics({ env });
  printDiagnostics(report);
  if (!report.ok) { process.exitCode = 1; return; }
  const plan = buildLaunchPlan(env);
  // 预演只打印已选入口，不输出继承环境中的密钥、D-Bus 地址或认证配置。
  if (args.includes("--dry-run")) { console.log(JSON.stringify({ command: plan.command, args: plan.args, cwd: plan.cwd, display: plan.display }, null, 2)); return; }
  process.umask(0o077);
  for (const key of ["CODEX_WEB_RUNTIME_DIR", "CODEX_WEB_REPORTS_DIR", "CODEX_WEB_OFFICIAL_BUNDLE_DIR", "CODEX_WEB_OFFICIAL_USER_DATA_DIR"]) fs.mkdirSync(env[key], { recursive: true, mode: 0o700 });
  console.log(`[linux:start] 启动 ${env.HOST}:${env.PORT}，显示模式 ${plan.display}；Ctrl-C 停止整组进程。`);
  const { child, stop } = supervise(plan);
  bindStopSignals(stop);
  child.once("error", (error) => { console.error(`[linux:start] 无法启动：${error.message}`); process.exitCode = 1; });
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1); });
}

if (require.main === module) { try { main(); } catch (error) { console.error(`[linux:start] ${error.message}`); process.exitCode = 1; } }
module.exports = { supervise, bindStopSignals };
