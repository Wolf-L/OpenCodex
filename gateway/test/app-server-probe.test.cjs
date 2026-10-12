const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const test = require("node:test");
const { runProbe, isolatedEnvironment, parseArgs } = require("../dev/app-server-probe.cjs");

const fixture = path.join(__dirname, "fixtures", "app-server-probe-child.cjs");
const sha256 = createHash("sha256").update(fs.readFileSync(fixture)).digest("hex");

function setup(mode = "normal", additions = {}) {
  const spawned = [], traces = [], roots = [];
  const dependencies = { spawn(cli, args, options) {
    assert.equal(cli, fixture);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    const root = path.dirname(options.env.CODEX_HOME);
    roots.push(root);
    const config = fs.readFileSync(path.join(options.env.CODEX_HOME, "config.toml"), "utf8");
    assert.match(config, /cli_auth_credentials_store = "file"/);
    assert.match(config, /mcp_oauth_credentials_store = "file"/);
    assert.match(config, /\[analytics\]\nenabled = false/);
    assert.match(config, /\[feedback\]\nenabled = false/);
    assert.equal(path.relative(root, options.cwd), "work");
    const child = spawn(process.execPath, [fixture, mode, ...args], options);
    spawned.push({ child, args, options });
    child.once("close", () => {
      const trace = path.join(options.env.CODEX_HOME, "trace.jsonl");
      if (fs.existsSync(trace)) traces.push(...fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
    });
    additions.onSpawn?.(child, args, options);
    return child;
  } };
  return {
    spawned, traces, roots,
    async run(options = {}) {
      const report = await runProbe({ cliPath: fixture, expectedSha256: sha256, timeoutMs: 2000, cleanupTimeoutMs: 150, ...options }, dependencies);
      if (!report.cleanup.retainedRoot) for (const root of roots) assert.equal(fs.existsSync(root), false);
      return report;
    },
  };
}

test("isolated environment does not inherit credentials, proxy, loader hooks or user directories", () => {
  const root = path.resolve("isolated-fixture");
  const env = isolatedEnvironment(root, {
    OPENAI_API_KEY: "private", HTTP_PROXY: "private", HTTPS_PROXY: "private", ALL_PROXY: "private",
    CODEX_HOME: "private", HOME: "private", APPDATA: "private", NODE_OPTIONS: "private", PATH: "private",
    SystemRoot: "system-runtime", WINDIR: "system-runtime", random: "private",
  });
  for (const key of ["OPENAI_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NODE_OPTIONS", "PATH", "random"]) assert.equal(env[key], undefined);
  for (const key of ["CODEX_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR", "TEMP", "TMP"]) {
    assert.equal(path.relative(root, env[key]).startsWith(".."), false);
  }
  assert.equal(env.SystemRoot, "system-runtime");
  assert.equal(Object.values(env).includes("private"), false);
});

test("hash mismatch, invalid identity and pre-cancellation never spawn", async () => {
  const f = setup();
  assert.equal((await f.run({ expectedSha256: "0".repeat(64) })).failure.code, "hash_mismatch");
  assert.equal((await f.run({ cliPath: "relative-cli" })).failure.code, "invalid_cli_identity");
  assert.equal((await f.run({ timeoutMs: Infinity })).failure.code, "invalid_timeout");
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.run({ signal: controller.signal })).failure.code, "cancelled");
  assert.equal(f.spawned.length, 0);
});

test("real pipes preserve handshake order and fixed D1 reads, and clean up after EOF", async () => {
  const f = setup(), report = await f.run();
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.cli.version, "1.2.3-test"); assert.equal(report.cli.sha256, sha256);
  assert.deepEqual(report.isolation, { homeVerified: true, accountNull: true });
  assert.deepEqual(report.reads, { models: { count: 1, hasNextCursor: true }, threads: { count: 0, hasNextCursor: false } });
  assert.equal(report.processes.appServer.closeConfirmed, true);
  assert.equal(report.processes.appServer.exitMethod, "stdin_eof");
  assert.equal(report.cleanup.removed, true);
  assert.deepEqual(f.spawned.map(item => item.args), [["--version"], ["app-server", "--strict-config", "--listen", "stdio://"]]);
  assert.deepEqual(f.traces.map(frame => frame.method), ["initialize", "initialized", "account/read", "model/list", "thread/list"]);
  assert.deepEqual(f.traces[0].params, { clientInfo: { name: "opencodex_isolated_probe", version: "1.0.0" }, capabilities: { experimentalApi: false, explicitGatewayOauth: true } });
  assert.deepEqual(f.traces[2].params, { refreshToken: false });
  assert.deepEqual(f.traces[3].params, { cursor: null, limit: 100, includeHidden: false });
  assert.equal(f.traces[4].params.useStateDbOnly, true);
  assert.equal(new Set(f.traces.filter(frame => frame.id).map(frame => frame.id)).size, 4);
  assert.doesNotMatch(JSON.stringify(report), /private|nextCursor|codexHome|retainedRoot/);
});

for (const [mode, code, methods] of [
  ["wrong-home", "unexpected_codex_home", ["initialize"]],
  ["account", "unexpected_account", ["initialize", "initialized", "account/read"]],
  ["history", "unexpected_history", ["initialize", "initialized", "account/read", "model/list", "thread/list"]],
  ["response-error", "response", ["initialize", "initialized", "account/read", "model/list"]],
]) {
  test(`${mode} is rejected without continuing, replaying or exposing payloads`, async () => {
    const f = setup(mode), report = await f.run();
    assert.equal(report.ok, false); assert.equal(report.failure.code, code);
    assert.deepEqual(f.traces.map(frame => frame.method), methods);
    assert.equal(report.cleanup.removed, true);
    assert.doesNotMatch(JSON.stringify(report), /private/);
  });
}

test("stdout notifications and large stderr are drained but not reported verbatim", async () => {
  const f = setup("stderr-flood"), report = await f.run();
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.ok(report.processes.appServer.stderrBytes > 1_000_000);
  assert.doesNotMatch(JSON.stringify(report), /sentinel|notification|xxxx/);
});

test("initialization timeout and early child exit are bounded and never retried", async () => {
  for (const [mode, code] of [["timeout", "timeout"], ["exit", "closed"]]) {
    const f = setup(mode), report = await f.run({ timeoutMs: 1000 });
    assert.equal(report.ok, false); assert.equal(report.failure.code, code, JSON.stringify(report));
    assert.equal(report.failure.phase, "initialize");
    assert.deepEqual(f.traces.map(frame => frame.method), ["initialize"]);
    assert.equal(report.processes.appServer.closeConfirmed, true);
    assert.equal(f.spawned.length, 2);
  }
});

test("AbortSignal during a pending real request still confirms close and removes its home", async () => {
  const controller = new AbortController();
  const f = setup("cancel", { onSpawn(child, args) {
    if (args[0] !== "app-server") return;
    // 全量并发测试时 Node 启动可能超过 100ms；在请求确实进入子进程后再取消。
    let received = "";
    child.stderr.on("data", chunk => {
      received += chunk.toString("utf8");
      if (received.includes("probe-fixture-initialize-received\n")) controller.abort();
    });
  } });
  const report = await f.run({ signal: controller.signal });
  assert.equal(report.ok, false); assert.equal(report.failure.code, "cancelled");
  assert.equal(report.processes.appServer.closeConfirmed, true); assert.equal(report.cleanup.removed, true);
  assert.deepEqual(f.traces.map(frame => frame.method), ["initialize"]);
});

test("version timeout or invalid version closes its owned child before any app-server spawn", async () => {
  for (const mode of ["version-timeout", "version-invalid"]) {
    const f = setup(mode), report = await f.run({ timeoutMs: 1000 });
    assert.equal(report.ok, false); assert.equal(report.failure.phase, "version");
    assert.equal(f.spawned.length, 1);
    assert.equal(report.processes.version.closeConfirmed, true); assert.equal(report.cleanup.removed, true);
    assert.doesNotMatch(JSON.stringify(report), /private diagnostic/);
  }
});

test("a child keeping the event loop alive after EOF is terminated with confirmed close", async () => {
  const f = setup("force-term"), report = await f.run();
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.processes.appServer.exitMethod, "SIGTERM");
  assert.equal(report.processes.appServer.closeConfirmed, true); assert.equal(report.cleanup.removed, true);
});

test("nonzero exit after the final read is reported as failure despite successful cleanup", async () => {
  const report = await setup("bad-eof").run();
  assert.equal(report.ok, false); assert.equal(report.failure.code, "unexpected_exit");
  assert.equal(report.processes.appServer.exitCode, 9); assert.equal(report.cleanup.removed, true);
});

test("spawn failure returns bounded summary and cleans only its temporary home", async () => {
  const report = await runProbe({ cliPath: fixture, expectedSha256: sha256 }, {
    spawn(_cli, _args, options) { return spawn(path.join(options.cwd, "missing-executable"), [], options); },
  });
  assert.equal(report.ok, false); assert.equal(report.failure.code, "spawn_failed");
  assert.equal(report.processes.version.closeConfirmed, true); assert.equal(report.cleanup.removed, true);
});

test("initialized notification write has its own deadline and cannot continue to account reads", async () => {
  const methods = [];
  let owned;
  const report = await runProbe({ cliPath: fixture, expectedSha256: sha256, timeoutMs: 1000, cleanupTimeoutMs: 20 }, {
    spawn(_cli, args, options) {
      if (args[0] === "--version") return spawn(process.execPath, [fixture, "normal", ...args], options);
      owned = new EventEmitter();
      const output = new PassThrough();
      // 真正阻塞 write callback，覆盖 request 超时之外的通知写入路径。
      const input = new Writable({ write(chunk, _encoding, done) {
        const frame = JSON.parse(chunk.toString()); methods.push(frame.method);
        if (frame.method === "initialize") {
          done(); setImmediate(() => output.write(`${JSON.stringify({ id: frame.id, result: { codexHome: options.env.CODEX_HOME } })}\n`));
        }
      } });
      Object.assign(owned, { pid: 7654322, stdin: input, stdout: output, stderr: new PassThrough(), kill(signal) {
        input.destroy(); output.end(); owned.stderr.end(); owned.emit("exit", null, signal); owned.emit("close", null, signal); return true;
      } });
      setImmediate(() => owned.emit("spawn"));
      return owned;
    },
  });
  assert.equal(report.ok, false); assert.deepEqual(report.failure, { phase: "initialized", code: "timeout" });
  assert.deepEqual(methods, ["initialize", "initialized"]);
  assert.equal(report.processes.appServer.closeConfirmed, true); assert.equal(report.cleanup.removed, true);
});

test("SIGKILL fallback waits for close when SIGTERM is ignored", { skip: process.platform === "win32" ? "Windows terminates immediately for SIGTERM; covered by lifecycle fake below" : false }, async () => {
  const report = await setup("force-kill").run();
  assert.equal(report.ok, true); assert.equal(report.processes.appServer.exitMethod, "SIGKILL");
  assert.equal(report.processes.appServer.closeConfirmed, true);
});

function fakeHungChild({ closeOnKill = false } = {}) {
  const child = new EventEmitter(), signals = [];
  const input = new Writable({ write(_chunk, _encoding, done) { done(); } });
  Object.assign(child, { pid: 7654321, stdin: input, stdout: new PassThrough(), stderr: new PassThrough(), kill(signal) {
    signals.push(signal);
    if (closeOnKill && signal === "SIGKILL") {
      child.stdout.end(); child.stderr.end(); child.emit("exit", null, signal); child.emit("close", null, signal);
    }
    return true;
  } });
  setImmediate(() => child.emit("spawn"));
  return { child, signals };
}

test("kill return value cannot confirm exit; an unclosed child retains only its owned root and PID", async t => {
  const fake = fakeHungChild();
  const report = await runProbe({ cliPath: fixture, expectedSha256: sha256, timeoutMs: 30, cleanupTimeoutMs: 10 }, { spawn: () => fake.child });
  t.after(() => {
    fake.child.emit("close", null, "SIGKILL");
    fake.child.stdin.destroy(); fake.child.stdout.destroy(); fake.child.stderr.destroy();
    const root = report.cleanup.retainedRoot;
    // 测试只删除报告中本次生成、前缀与父目录均已核验的隔离根目录。
    assert.equal(path.basename(root).startsWith("opencodex-app-server-probe-"), true);
    // 与 fs.promises.realpath 一样使用原生解析，兼容 Windows CI 的 RUNNER~1 短路径别名。
    assert.equal(fs.realpathSync.native(path.dirname(root)), fs.realpathSync.native(require("node:os").tmpdir()));
    fs.rmSync(root, { recursive: true });
  });
  assert.equal(report.ok, false); assert.equal(report.cleanup.removed, false);
  assert.equal(report.cleanup.failure, "child_close_unconfirmed");
  assert.equal(report.processes.version.retainedPid, fake.child.pid);
  assert.equal(fs.existsSync(report.cleanup.retainedRoot), true);
  assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]);
});

test("forced close acknowledgement permits cleanup on all platforms", async () => {
  const fake = fakeHungChild({ closeOnKill: true });
  const report = await runProbe({ cliPath: fixture, expectedSha256: sha256, timeoutMs: 30, cleanupTimeoutMs: 10 }, { spawn: () => fake.child });
  assert.equal(report.ok, false); assert.equal(report.failure.code, "timeout");
  assert.equal(report.processes.version.exitMethod, "SIGKILL");
  assert.equal(report.processes.version.closeConfirmed, true); assert.equal(report.cleanup.removed, true);
  assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]);
});

test("CLI rejects ambiguous arguments and prints a single failure JSON with nonzero exit", () => {
  assert.deepEqual(parseArgs(["--cli", fixture, "--sha256", sha256]), { cliPath: fixture, expectedSha256: sha256 });
  for (const args of [["--cli"], ["--other", "x"], ["--cli", "x", "--cli", "y"]]) assert.throws(() => parseArgs(args));
  const result = spawnSync(process.execPath, [require.resolve("../dev/app-server-probe.cjs"), "--other", "private"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(result.stdout).failure.code, "invalid_arguments");
  assert.doesNotMatch(result.stdout, /private/);
});
