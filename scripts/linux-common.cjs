"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { findAuthPasswordScalar } = require("../shared/auth-config.cjs");

const APP_ROOT = path.resolve(__dirname, "..");
const PLACEHOLDERS = ["your-password", "your_password", "password", "changeme", "change-me"];
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function deploymentEnvironment(env = process.env, home = os.homedir()) {
  // 独立部署数据放在 Linux 私有目录；不修改 CODEX_HOME 或已有账号登录态。
  const root = path.resolve(env.OPENCODEX_LINUX_DATA_DIR || path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "opencodex"));
  return {
    ...env,
    HOST: env.HOST || "127.0.0.1",
    PORT: env.PORT || "3737",
    OPENCODEX_LINUX_DATA_DIR: root,
    CODEX_WEB_RUNTIME_DIR: path.resolve(env.CODEX_WEB_RUNTIME_DIR || path.join(root, "runtime")),
    CODEX_WEB_CONFIG_PATH: path.resolve(env.CODEX_WEB_CONFIG_PATH || path.join(root, "config.yaml")),
    CODEX_WEB_REPORTS_DIR: path.resolve(env.CODEX_WEB_REPORTS_DIR || path.join(root, "reports")),
    CODEX_WEB_OFFICIAL_BUNDLE_DIR: path.resolve(env.CODEX_WEB_OFFICIAL_BUNDLE_DIR || path.join(root, "cache", "official-bundle")),
    CODEX_WEB_OFFICIAL_USER_DATA_DIR: path.resolve(env.CODEX_WEB_OFFICIAL_USER_DATA_DIR || path.join(root, "official-user-data")),
  };
}

function executableOnPath(name, env = process.env) {
  // 只检查 PATH 中的文件权限，不执行探测到的第三方二进制。
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return "";
}

function inspectAuthConfig(configPath, { checkMode = process.platform === "linux" } = {}) {
  // 复用 gateway 的 YAML 子集解析，避免诊断认为已设密码而运行时实际未启用认证。
  try {
    const st = fs.statSync(configPath);
    if (!st.isFile() || st.size > 1024 * 1024) throw new Error("配置不是普通文件或超过 1 MiB");
    if (checkMode && (st.mode & 0o077)) throw new Error("配置可被其他用户读取；请对该文件执行 chmod 600");
    const value = String(findAuthPasswordScalar(fs.readFileSync(configPath, "utf8"))?.value || "");
    if (!value.trim()) throw new Error("缺少 auth.password；先运行 pnpm run linux:init");
    if (PLACEHOLDERS.includes(value.trim().toLowerCase()) || PLACEHOLDERS.some((word) => `sha256-v1:${hash(word)}` === value.trim().toLowerCase())) {
      throw new Error("不能使用示例占位密码，请设置自己的访问密码");
    }
    if (/^sha256-v1:/i.test(value.trim()) && !/^sha256-v1:[a-f0-9]{64}$/i.test(value.trim())) throw new Error("auth.password 的哈希格式无效");
    return { ok: true, message: "已配置访问密码（不输出密码或哈希）" };
  } catch (error) {
    // 不回显配置正文或解析异常中的输入，诊断可安全分享但路径仍需人工脱敏。
    return { ok: false, message: error.code === "ENOENT" ? "配置不存在；先运行 pnpm run linux:init" : error.message };
  }
}

function displayPlan(env, lookup = (name) => executableOnPath(name, env)) {
  const mode = env.OPENCODEX_LINUX_HEADLESS || "auto";
  if (!["auto", "0", "1"].includes(mode)) throw new Error("OPENCODEX_LINUX_HEADLESS 只能是 auto、0 或 1");
  if (mode !== "1" && env.DISPLAY) return { mode: "existing", wrappers: [] };
  if (mode === "0") throw new Error("未设置 DISPLAY；请进入 KeX/X11 会话或启用无头模式");
  for (const name of ["xvfb-run", "Xvfb", "xauth"]) {
    if (!lookup(name)) throw new Error(`缺少 ${name}；请安装 xvfb 和 xauth`);
  }
  // xvfb-run 自动分配 display 并使用 xauth；禁止 -ac，也不开放 X11 TCP 端口。
  return { mode: "xvfb", wrappers: [lookup("xvfb-run"), "--auto-servernum", "--server-args=-screen 0 1280x720x24 -nolisten tcp"] };
}

function buildLaunchPlan(env, { node = process.execPath, appRoot = APP_ROOT, lookup = (name) => executableOnPath(name, env) } = {}) {
  const display = displayPlan(env, lookup);
  const command = [...display.wrappers];
  if (!env.DBUS_SESSION_BUS_ADDRESS && lookup("dbus-run-session")) command.push(lookup("dbus-run-session"), "--");
  command.push(node, path.join(appRoot, "gateway", "dev", "run-gateway.cjs"));
  return { command: command[0], args: command.slice(1), env, cwd: appRoot, display: display.mode };
}

function writableAncestor(target) {
  let ancestor = path.resolve(target);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
  try {
    if (!fs.statSync(ancestor).isDirectory()) return false;
    fs.accessSync(ancestor, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch { return false; }
}

module.exports = { APP_ROOT, deploymentEnvironment, executableOnPath, inspectAuthConfig, displayPlan, buildLaunchPlan, writableAncestor };
