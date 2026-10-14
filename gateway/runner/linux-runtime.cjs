const fs = require("node:fs");

const LINUX_ELF_MACHINES = Object.freeze({ x64: 62, arm64: 183 });

/** 只读取 ELF 头，不运行被检查的文件或 ldd，避免预检阶段执行不可信程序。 */
function inspectLinuxExecutable(filePath, { arch = process.arch, checkExecutable = process.platform === "linux" } = {}) {
  const result = { ok: false, filePath: String(filePath || ""), arch, machine: null, detectedArch: null, error: null };
  const fail = (message) => ({ ...result, error: message });
  if (!Object.hasOwn(LINUX_ELF_MACHINES, arch)) {
    return fail(`Unsupported Linux architecture ${arch}; use an arm64 or x64 Node.js and matching desktop runtime.`);
  }
  if (!result.filePath) return fail("Missing Linux executable path; configure the matching desktop or CLI binary.");
  let fd;
  try {
    // 先排除目录、FIFO 等特殊文件，预检不能因为 open 管道等待写端而挂起。
    if (!fs.statSync(result.filePath).isFile()) return fail(`Not a regular Linux executable: ${result.filePath}`);
    fd = fs.openSync(result.filePath, "r");
    if (!fs.fstatSync(fd).isFile()) return fail(`Not a regular Linux executable: ${result.filePath}`);
    const header = Buffer.alloc(64);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    if (bytesRead < header.length || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      return fail(`Expected a Linux ELF64 executable, not a script, Windows/macOS binary or truncated file: ${result.filePath}`);
    }
    if (header[4] !== 2 || header[5] !== 1 || header[6] !== 1) {
      return fail(`Expected a little-endian ELF64 executable (ELF version 1): ${result.filePath}`);
    }
    result.machine = header.readUInt16LE(18);
    result.detectedArch = Object.keys(LINUX_ELF_MACHINES).find((name) => LINUX_ELF_MACHINES[name] === result.machine) || "unknown";
    if (result.machine !== LINUX_ELF_MACHINES[arch]) {
      return fail(`Linux architecture mismatch: Node.js is ${arch}, but ${result.filePath} is ${result.detectedArch} (ELF e_machine=${result.machine}). Install the matching Linux ${arch} package; do not reuse Windows/macOS or another CPU's runtime.`);
    }
    // X_OK 仅用于真实 POSIX 主机；Windows 上的格式夹具可关闭权限检查。
    if (checkExecutable) fs.accessSync(result.filePath, fs.constants.X_OK);
    return { ...result, ok: true };
  } catch (error) {
    const code = error && error.code ? error.code : "UNKNOWN";
    const remedy = code === "EACCES" || code === "EPERM"
      ? "Check execute permissions and a filesystem mounted with execution enabled; keep runtime files inside the Linux filesystem, not Android shared storage."
      : "Check the configured path and install/extract the matching Linux desktop and CLI package.";
    return fail(`Cannot inspect or execute ${result.filePath} (${code}). ${remedy}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** 在任何运行时复制和启动之前同时校验 Electron 与 CLI，防止桌面入口被误当作 app-server。 */
function assertLinuxRuntimeLayout(layout, { platform = process.platform, arch = process.arch, checkExecutable = process.platform === "linux" } = {}) {
  if (platform !== "linux") return layout;
  for (const [label, filePath] of [["Desktop Electron", layout.executablePath], ["Codex CLI", layout.codexBinaryPath]]) {
    const inspection = inspectLinuxExecutable(filePath, { arch, checkExecutable });
    if (!inspection.ok) throw new Error(`${label}: ${inspection.error}`);
  }
  const desktopRealPath = fs.realpathSync(layout.executablePath);
  const cliRealPath = fs.realpathSync(layout.codexBinaryPath);
  const desktopStat = fs.statSync(desktopRealPath);
  const cliStat = fs.statSync(cliRealPath);
  if (desktopRealPath === cliRealPath || (desktopStat.ino !== 0 && desktopStat.ino === cliStat.ino && desktopStat.dev === cliStat.dev)) {
    throw new Error("Codex CLI must not be the desktop Electron executable. Set CODEX_CLI_PATH to the matching bundled resources/codex or resources/bin/codex binary.");
  }
  return layout;
}

/** Linux 降级选项必须由操作者显式选择，不能根据 root、容器或 Android 内核自动关闭沙箱。 */
function linuxRuntimeArgs({ platform = process.platform, env = process.env, getuid = process.getuid, warn = console.warn } = {}) {
  if (platform !== "linux") return [];
  const noSandbox = env.OPENCODEX_LINUX_NO_SANDBOX === "1";
  if (typeof getuid === "function" && getuid() === 0 && !noSandbox) {
    throw new Error("Refusing to launch Electron as root without its Chromium sandbox. Prefer a non-root user on a supported Linux kernel. PRoot/Android may not support Chromium sandboxing. Only after accepting the security risk, explicitly set OPENCODEX_LINUX_NO_SANDBOX=1; this is not recommended for production.");
  }
  const args = [];
  // 无钥匙环的既有部署可显式保留 basic；不能按无头、root 或 Android 自动降级。
  // 使用固定枚举而非透传命令行，拼写错误必须在启动前报错。
  const passwordStore = env.OPENCODEX_LINUX_PASSWORD_STORE ?? "auto";
  if (!["auto", "basic"].includes(passwordStore)) {
    const error = new Error("OPENCODEX_LINUX_PASSWORD_STORE must be auto or basic. Keep auto for the system keyring; basic is an explicit opt-in for deployments without a desktop keyring.");
    error.code = "INVALID_LINUX_PASSWORD_STORE";
    throw error;
  }
  if (passwordStore === "basic") {
    warn("[launcher] WARNING: OPENCODEX_LINUX_PASSWORD_STORE=basic disables desktop keyring protection for Electron's password store. Use only when intentionally preserving a deployment without a keyring; protect its private data directory. This does not change account credentials or Codex command approvals.", "password-store-opt-out");
    args.push("--password-store=basic");
  }
  if (env.OPENCODEX_LINUX_DISABLE_GPU === "1") args.push("--disable-gpu");
  if (env.OPENCODEX_LINUX_DISABLE_DEV_SHM === "1") args.push("--disable-dev-shm-usage");
  if (noSandbox) {
    warn("[launcher] WARNING: OPENCODEX_LINUX_NO_SANDBOX=1 disables the Chromium process sandbox, reducing protection against untrusted content. Not recommended for production; prefer a non-root user and a supported kernel. This does not change Codex command approvals or its execution sandbox.");
    args.push("--no-sandbox");
  }
  return args;
}

module.exports = { inspectLinuxExecutable, assertLinuxRuntimeLayout, linuxRuntimeArgs };
