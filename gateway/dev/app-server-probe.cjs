const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { createAppServerTransport } = require("../runtime/app-server/transport.cjs");
const { createAppServerReadClient } = require("../runtime/app-server/read-client.cjs");

class ProbeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function cancelled(signal) {
  if (signal?.aborted) throw new ProbeError("cancelled");
}

// 不把协议错误或子进程错误的 message 写进报告，避免泄露账号、路径和诊断正文。
function failureCode(error, signal) {
  if (signal?.aborted) return "cancelled";
  if (error instanceof ProbeError) return error.code;
  if (["timeout", "closed", "write", "response"].includes(error?.category)) return error.category;
  return "operation_failed";
}

function bounded(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new ProbeError("cancelled"));
    const timer = setTimeout(() => finish(new ProbeError("timeout")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(value => finish(null, value), finish);
    if (signal?.aborted) abort();
  });
}

function timeoutValue(value, fallback) {
  const timeout = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 5000) throw new ProbeError("invalid_timeout");
  return timeout;
}

function isolatedEnvironment(root, source = process.env) {
  const env = {};
  // 只允许系统加载器所需变量；PATH、代理、密钥、NODE_OPTIONS 和用户配置均不继承。
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "SYSTEMDRIVE"]) {
    const key = Object.keys(source).find(item => item.toUpperCase() === name.toUpperCase());
    if (key && typeof source[key] === "string") env[name] = source[key];
  }
  Object.assign(env, {
    CODEX_HOME: path.join(root, "codex"),
    HOME: path.join(root, "profile"), USERPROFILE: path.join(root, "profile"),
    APPDATA: path.join(root, "appdata", "roaming"), LOCALAPPDATA: path.join(root, "appdata", "local"),
    XDG_CONFIG_HOME: path.join(root, "xdg", "config"), XDG_DATA_HOME: path.join(root, "xdg", "data"),
    XDG_CACHE_HOME: path.join(root, "xdg", "cache"), XDG_STATE_HOME: path.join(root, "xdg", "state"),
    TMPDIR: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NO_COLOR: "1",
  });
  if (process.platform === "win32") {
    const drive = path.parse(env.USERPROFILE).root;
    env.HOMEDRIVE = drive.replace(/[\\/]$/, "");
    env.HOMEPATH = env.USERPROFILE.slice(env.HOMEDRIVE.length);
  }
  return env;
}

async function hashFile(filename, timeoutMs, signal) {
  const input = fs.createReadStream(filename), hash = createHash("sha256");
  try {
    return await bounded(new Promise((resolve, reject) => {
      input.on("data", chunk => hash.update(chunk));
      input.once("error", reject);
      input.once("end", () => resolve(hash.digest("hex")));
    }), timeoutMs, signal);
  } finally { input.destroy(); }
}

function watchChild(child) {
  let resolveClose, resolveSpawn;
  const record = {
    child, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
    spawned: false, closed: false, exited: false, spawnError: false,
    exitCode: null, signal: null, stderrBytes: 0, exitMethod: null,
    close: new Promise(resolve => { resolveClose = resolve; }),
    ready: new Promise(resolve => { resolveSpawn = resolve; }),
  };
  child.once("spawn", () => { record.spawned = true; resolveSpawn(true); });
  child.on("error", () => { record.spawnError = true; resolveSpawn(false); });
  child.once("exit", () => { record.exited = true; });
  child.once("close", (code, signal) => {
    record.closed = true; record.exitCode = code; record.signal = signal; resolveClose(); resolveSpawn(false);
  });
  // stderr 只计数并持续排空，不能堵住进程，也不能把内容带到 JSON 报告中。
  record.stderr?.on("data", chunk => { record.stderrBytes += chunk.length; });
  for (const stream of [record.stdin, record.stdout, record.stderr]) stream?.on("error", () => {});
  return record;
}

async function waitClosed(record, timeoutMs) {
  if (record.closed) return true;
  try { await bounded(record.close, timeoutMs); } catch { /* 只有 close 事件能确认退出。 */ }
  return record.closed;
}

async function stopChild(record, timeoutMs) {
  if (record.closed) { record.exitMethod ??= "already_closed"; return true; }
  // transport 装饰后 child.stdin 是代理；始终关闭创建时保存的真实管道。
  record.stdout?.resume();
  try { record.stdin?.end(); } catch { /* 继续执行有界退出兜底。 */ }
  if (await waitClosed(record, timeoutMs)) { record.exitMethod = "stdin_eof"; return true; }
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (!record.exited && Number.isSafeInteger(record.child.pid) && record.child.pid > 0) {
      try { record.child.kill(signal); } catch { /* kill 成功与否均要等待 close。 */ }
    }
    if (await waitClosed(record, timeoutMs)) { record.exitMethod = signal; return true; }
  }
  record.exitMethod = "unconfirmed";
  return false;
}

function childSummary(record) {
  return {
    spawned: record.spawned, closeConfirmed: record.closed, exitCode: record.exitCode,
    signal: record.signal, exitMethod: record.exitMethod, stderrBytes: record.stderrBytes,
    ...(!record.closed && record.child.pid ? { retainedPid: record.child.pid } : {}),
  };
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function removeOwnedRoot(root, parent) {
  // 清理对象只来自本次 mkdtemp；再次确认真实绝对路径未被替换成外部目录或链接。
  const current = await fsp.lstat(root);
  if (!current.isDirectory() || current.isSymbolicLink() || !inside(parent, root) ||
      path.dirname(root) !== parent || !path.basename(root).startsWith("opencodex-app-server-probe-") ||
      await fsp.realpath(root) !== root) throw new ProbeError("cleanup_containment_failed");
  await fsp.rm(root, { recursive: true, force: false });
}

function pageSummary(result) {
  if (!result || !Array.isArray(result.data) ||
      !(result.nextCursor == null || typeof result.nextCursor === "string")) throw new ProbeError("invalid_page");
  return { count: result.data.length, hasNextCursor: result.nextCursor != null };
}

async function runProbe(options = {}, dependencies = {}) {
  const report = {
    schemaVersion: 1, ok: false, cli: {}, isolation: { homeVerified: false, accountNull: false },
    timingsMs: {}, reads: {}, processes: {}, cleanup: { removed: false },
  };
  const records = [];
  let phase = "options", root, tempParent, transport, readScope, timeoutMs = 5000, cleanupTimeoutMs = 1000;
  const signal = options.signal;
  const spawnChild = dependencies.spawn || spawn;
  const started = performance.now();
  async function step(name, operation) {
    phase = name; cancelled(signal);
    const start = performance.now();
    try { return await operation(); }
    finally { report.timingsMs[name] = Math.round((performance.now() - start) * 100) / 100; }
  }
  function startChild(name, args, env) {
    cancelled(signal);
    const record = watchChild(spawnChild(options.cliPath, args, {
      cwd: path.join(root, "work"), env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
    }));
    records.push([name, record]);
    return record;
  }
  try {
    if (typeof options.cliPath !== "string" || !path.isAbsolute(options.cliPath) ||
        typeof options.expectedSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(options.expectedSha256)) {
      throw new ProbeError("invalid_cli_identity");
    }
    timeoutMs = timeoutValue(options.timeoutMs, 5000);
    cleanupTimeoutMs = timeoutValue(options.cleanupTimeoutMs, 1000);
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new ProbeError("invalid_signal");
    await step("hash", async () => {
      if (!(await fsp.stat(options.cliPath)).isFile()) throw new ProbeError("cli_not_file");
      const hash = await hashFile(options.cliPath, timeoutMs, signal);
      if (hash !== options.expectedSha256.toLowerCase()) throw new ProbeError("hash_mismatch");
      report.cli.sha256 = hash;
    });
    const env = await step("isolation", async () => {
      tempParent = await fsp.realpath(os.tmpdir());
      root = await fsp.mkdtemp(path.join(tempParent, "opencodex-app-server-probe-"));
      const env = isolatedEnvironment(root);
      const directories = ["codex", "profile", "appdata/roaming", "appdata/local", "xdg/config", "xdg/data", "xdg/cache", "xdg/state", "tmp", "work"];
      await Promise.all(directories.map(directory => fsp.mkdir(path.join(root, directory), { recursive: true })));
      await fsp.writeFile(path.join(env.CODEX_HOME, "config.toml"),
        'cli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n', { mode: 0o600 });
      return env;
    });
    await step("version", async () => {
      const record = startChild("version", ["--version"], env);
      let output = "", bytes = 0;
      record.stdout?.on("data", chunk => {
        bytes += chunk.length;
        if (bytes <= 4096) output += chunk.toString("utf8");
      });
      if (!await bounded(record.ready, timeoutMs, signal)) throw new ProbeError("spawn_failed");
      record.stdin.end();
      await bounded(record.close, timeoutMs, signal);
      record.exitMethod = "natural";
      if (record.spawnError || record.exitCode !== 0 || record.signal) throw new ProbeError("version_failed");
      const match = bytes <= 4096 && /^(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(output.trim());
      if (!match) throw new ProbeError("invalid_version");
      report.cli.version = match[1];
    });
    const app = await step("spawn", async () => {
      // 临时隔离配置必须被固定 CLI 明确认可，不能静默忽略凭据存储等关键字段。
      const record = startChild("appServer", ["app-server", "--strict-config", "--listen", "stdio://"], env);
      if (!await bounded(record.ready, timeoutMs, signal)) throw new ProbeError("spawn_failed");
      transport = createAppServerTransport({ requestIdPrefix: "opencodex.isolated-probe:" });
      transport.decorateChild(record.child);
      record.child.stdout.resume();
      if (!transport.isAttached()) throw new ProbeError("transport_unavailable");
      readScope = createAppServerReadClient(transport);
      return record;
    });
    const controls = { timeoutMs, ...(signal ? { signal } : {}) };
    await step("initialize", async () => {
      const result = await transport.request("initialize", {
        clientInfo: { name: "opencodex_isolated_probe", version: "1.0.0" },
        capabilities: { experimentalApi: false, explicitGatewayOauth: true },
      }, controls);
      if (typeof result?.codexHome !== "string" || !path.isAbsolute(result.codexHome) ||
          path.resolve(result.codexHome) !== path.resolve(env.CODEX_HOME)) throw new ProbeError("unexpected_codex_home");
      report.isolation.homeVerified = true;
    });
    await step("initialized", () => bounded(transport.writeMessage({ method: "initialized" }), timeoutMs, signal));
    await step("account", async () => {
      const result = await transport.request("account/read", { refreshToken: false }, controls);
      if (!result || result.account !== null) throw new ProbeError("unexpected_account");
      report.isolation.accountNull = true;
    });
    await step("models", async () => {
      report.reads.models = pageSummary(await readScope.client.listModels({}, controls));
    });
    await step("threads", async () => {
      report.reads.threads = pageSummary(await readScope.client.listRecentThreads({}, controls));
      if (report.reads.threads.count !== 0 || report.reads.threads.hasNextCursor) throw new ProbeError("unexpected_history");
    });
    if (app.closed || app.exited) throw new ProbeError("premature_exit");
    report.ok = true;
  } catch (error) {
    report.failure = { phase, code: failureCode(error, signal) };
  } finally {
    readScope?.dispose(); transport?.dispose();
    let closed = true;
    for (const [name, record] of records) {
      const confirmed = await stopChild(record, cleanupTimeoutMs);
      closed = confirmed && closed;
      report.processes[name] = childSummary(record);
      if (name === "appServer" && confirmed && !["SIGTERM", "SIGKILL"].includes(record.exitMethod) &&
          (record.exitCode !== 0 || record.signal)) {
        report.ok = false;
        report.failure ??= { phase: "cleanup", code: "unexpected_exit" };
      }
    }
    if (signal?.aborted) { report.ok = false; report.failure ??= { phase: "cleanup", code: "cancelled" }; }
    if (!closed) {
      report.ok = false;
      report.cleanup.failure = "child_close_unconfirmed";
      report.failure ??= { phase: "cleanup", code: "child_close_unconfirmed" };
    }
    if (root && closed) {
      try { await removeOwnedRoot(root, tempParent); report.cleanup.removed = true; }
      catch {
        report.ok = false; report.cleanup.failure = "directory_cleanup_failed";
        report.failure ??= { phase: "cleanup", code: "directory_cleanup_failed" };
      }
    }
    if (root && !report.cleanup.removed) report.cleanup.retainedRoot = root;
    report.timingsMs.total = Math.round((performance.now() - started) * 100) / 100;
  }
  return report;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!["--cli", "--sha256"].includes(key) || values[key] !== undefined || !argv[index + 1]) throw new ProbeError("invalid_arguments");
    values[key] = argv[index + 1];
  }
  return { cliPath: values["--cli"], expectedSha256: values["--sha256"] };
}

async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort); process.on("SIGTERM", abort);
  try {
    let report;
    try { report = await runProbe({ ...parseArgs(process.argv.slice(2)), signal: controller.signal }); }
    catch { report = { schemaVersion: 1, ok: false, failure: { phase: "arguments", code: "invalid_arguments" } }; }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
    // 失联子进程的管道仍可能保持父进程存活；失败报告落盘后退出，不冒充清理完成。
    if (report.cleanup?.failure === "child_close_unconfirmed") process.stdout.write("", () => process.exit(1));
  } finally {
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  }
}

if (require.main === module) void main();
module.exports = { runProbe, isolatedEnvironment, parseArgs };
