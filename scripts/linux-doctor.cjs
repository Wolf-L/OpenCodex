#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { APP_ROOT, deploymentEnvironment, executableOnPath, inspectAuthConfig, displayPlan, writableAncestor } = require("./linux-common.cjs");
const { linuxRuntimeArgs, assertLinuxRuntimeLayout, inspectLinuxExecutable } = require("../gateway/runner/linux-runtime.cjs");

function nodeSupported(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

function inspectNativeAddons(root, arch) {
  let count = 0;
  let visited = 0;
  let skippedLinks = 0;
  const errors = [];
  if (!fs.existsSync(root)) return { count, errors, skippedLinks };
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 20000) throw new Error("原生模块目录超过诊断上限，请人工检查完整性");
      const target = path.join(dir, entry.name);
      // 不递归跟随目录链接，防止循环或越界扫描整台设备。
      if (entry.isSymbolicLink()) { skippedLinks++; continue; }
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".node")) {
        count++;
        const result = inspectLinuxExecutable(target, { arch, checkExecutable: false });
        if (!result.ok) errors.push(result.error);
      }
    }
  }
  return { count, errors, skippedLinks };
}

function collectDiagnostics({
  env = deploymentEnvironment(), platform = process.platform, arch = process.arch,
  version = process.versions.node, kernel = os.release(), uid = typeof process.getuid === "function" ? process.getuid() : null,
  appRoot = APP_ROOT, lookup = (name) => executableOnPath(name, env),
  resolveLayout = () => require("../gateway/runner/official-layout.cjs").findOfficialRuntimeLayout({ officialBundleDir: env.CODEX_WEB_OFFICIAL_BUNDLE_DIR }),
  glibc = process.report?.getReport().header.glibcVersionRuntime,
} = {}) {
  const checks = [];
  const add = (id, status, message) => checks.push({ id, status, message });
  add("platform", platform === "linux" && ["arm64", "x64"].includes(arch) ? "ok" : "error", `${platform}/${arch}; 需要 Linux arm64 或 x64 用户空间与 Node.js`);
  add("node", nodeSupported(version) ? "ok" : "error", `Node.js ${version}; 最低 22.12.0，推荐 24 LTS`);
  add("libc", glibc ? "ok" : "error", glibc ? `glibc ${glibc}（不代表所有动态库/ABI 已验证）` : "未检测到 glibc；请在 Kali 内运行，不要使用 Termux/Android 的 Node.js");
  add("kernel", "info", `${kernel}; Android 内核名称不能单独判断 chroot 或 PRoot`);
  if (/android/i.test(kernel)) add("android", "warn", "Android 内核上的 namespace、seccomp、图形及 Codex 执行沙箱仍须实机验证；静态诊断不能保证可运行");
  let traced = false;
  if (platform === "linux") {
    try { traced = /^TracerPid:\s*[1-9]/m.test(fs.readFileSync("/proc/self/status", "utf8")); } catch {}
  }
  if (traced || env.PROOT_TMP_DIR || env.PROOT_LOADER) add("proot", "warn", "存在 ptrace/PRoot 线索（也可能是调试器），不是已确认的原生隔离环境；不依赖 systemd/FUSE");
  try {
    const args = linuxRuntimeArgs({ platform, env, getuid: () => uid, warn: (message) => add("sandbox-opt-out", "warn", message) });
    add("sandbox", "ok", env.OPENCODEX_LINUX_NO_SANDBOX === "1" ? "已显式选择 Chromium 无沙箱模式；非生产建议" : "未关闭 Chromium 沙箱；内核是否允许启动仍须实测");
    if (args.includes("--disable-dev-shm-usage")) add("shared-memory", "info", "已选择 Chromium 临时文件替代 /dev/shm，需要可写且有空间的临时目录");
  } catch (error) { add("sandbox", "error", error.message); }
  try { add("display", "ok", `显示模式：${displayPlan(env, lookup).mode}（不在诊断阶段连接或启动显示服务）`); }
  catch (error) { add("display", "error", error.message); }
  add("dbus", env.DBUS_SESSION_BUS_ADDRESS || lookup("dbus-run-session") ? "ok" : "warn", env.DBUS_SESSION_BUS_ADDRESS ? "使用现有 D-Bus 会话" : lookup("dbus-run-session") ? "启动时创建临时 D-Bus 会话，无需 systemd" : "缺少 dbus-run-session；建议安装 dbus 包");
  const port = Number(env.PORT);
  add("listen", Number.isInteger(port) && port >= 1 && port <= 65535 ? "ok" : "error", `监听 ${env.HOST}:${env.PORT}`);
  if (!["127.0.0.1", "::1", "localhost"].includes(env.HOST)) add("remote-listen", "warn", "已允许网络访问；0.0.0.0 会监听所有 IPv4 网卡，不只局域网。必须保留访问密码，并用防火墙限制可信网段；不要直接暴露公网，需要时使用 HTTPS/VPN 或 SSH 隧道");
  const auth = inspectAuthConfig(env.CODEX_WEB_CONFIG_PATH, { checkMode: platform === "linux" });
  add("auth", auth.ok ? "ok" : "error", auth.message);
  for (const key of ["CODEX_WEB_RUNTIME_DIR", "CODEX_WEB_REPORTS_DIR", "CODEX_WEB_OFFICIAL_BUNDLE_DIR", "CODEX_WEB_OFFICIAL_USER_DATA_DIR"]) {
    add(key, writableAncestor(env[key]) ? "ok" : "error", `${key}：${env[key]}`);
    if (/^\/(sdcard|storage|mnt\/media_rw)(\/|$)/.test(env[key])) add(`${key}-storage`, "warn", "不要使用 Android 共享存储：可能 noexec、不支持所需权限或符号链接");
  }
  const built = fs.existsSync(path.join(appRoot, "gateway", "dist", "official", "CodexAsarScanner.js"));
  add("build", built ? "ok" : "error", built ? "gateway 编译文件存在（更新源码后仍应重新构建）" : "请先 pnpm install --frozen-lockfile && pnpm run build");
  if (built && platform === "linux") {
    try {
      const layout = resolveLayout();
      assertLinuxRuntimeLayout(layout, { platform, arch });
      add("runtime", "ok", `Electron 与 CLI ELF 架构匹配 ${arch}：${layout.executablePath}`);
      const native = inspectNativeAddons(`${layout.asarPath}.unpacked`, arch);
      // 包可能同时携带未被加载的多架构 prebuild；不把任意外国架构文件误判为必然启动失败。
      if (native.errors.length) add("native-addons", "warn", `发现 ${native.errors.length} 个不匹配的原生模块；可能是未使用的多架构 prebuild，也可能导致实际加载失败，需核对被加载的模块和 Electron ABI。\n${native.errors.join("\n")}`);
      else add("native-addons", "info", `检查 ${native.count} 个 .node ELF；跳过 ${native.skippedLinks} 个符号链接。尚未验证 Electron ABI、依赖库、GPU 或 OWL 功能`);
    } catch (error) { add("runtime", "error", error.message); }
  }
  return { schemaVersion: 1, ok: !checks.some((check) => check.status === "error"), platform, arch, kernel, node: version, checks };
}

function printDiagnostics(report, json = false) {
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const check of report.checks) console.log(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
    console.log(report.ok ? "预检通过；这不是目标硬件运行成功的证明。" : "预检未通过；请修复 ERROR 后重试。详见 docs/LINUX_GUIDE.md。");
  }
}

if (require.main === module) {
  if (process.argv.slice(2).some((arg) => arg !== "--json")) { console.error("用法：node scripts/linux-doctor.cjs [--json]"); process.exitCode = 1; }
  else {
    const report = collectDiagnostics();
    printDiagnostics(report, process.argv.includes("--json"));
    process.exitCode = report.ok ? 0 : 1;
  }
}
module.exports = { collectDiagnostics, printDiagnostics, inspectNativeAddons, nodeSupported };
