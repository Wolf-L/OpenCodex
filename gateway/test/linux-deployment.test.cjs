const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { deploymentEnvironment, inspectAuthConfig, displayPlan, buildLaunchPlan, writableAncestor, executableOnPath } = require("../../scripts/linux-common.cjs");
const { createConfig } = require("../../scripts/linux-init.cjs");
const { collectDiagnostics, inspectNativeAddons, nodeSupported } = require("../../scripts/linux-doctor.cjs");
const { supervise } = require("../../scripts/linux-start.cjs");
const { findAuthPasswordScalar } = require("../../shared/auth-config.cjs");

function fixture(t) {
  // 仅删除本测试刚创建的专用临时目录，不触碰 HOME、真实配置或账号。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-linux-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("deployment defaults allow LAN and retain private XDG state without changing account paths", () => {
  const home = path.resolve("test-home");
  const env = deploymentEnvironment({ CODEX_HOME: "/existing/account" }, home);
  assert.equal(env.HOST, "0.0.0.0");
  assert.equal(env.PORT, "3737");
  assert.equal(env.CODEX_HOME, "/existing/account");
  assert.equal(env.CODEX_WEB_CONFIG_PATH, path.join(home, ".local/state/opencodex/config.yaml"));
  assert.equal(env.OPENCODEX_LINUX_NO_SANDBOX, undefined);
});

test("persistent password-store configuration reaches the runner and has a distinct diagnostic", (t) => {
  // 模拟外置服务配置经过部署环境与启动计划，不启动桌面、不读取真实钥匙环。
  const env = deploymentEnvironment({ OPENCODEX_LINUX_PASSWORD_STORE: "basic", DISPLAY: ":1" }, fixture(t));
  assert.equal(buildLaunchPlan(env).env.OPENCODEX_LINUX_PASSWORD_STORE, "basic");
  const report = collectDiagnostics({ env, platform: "linux", arch: "arm64", uid: 1000, glibc: "2.41", appRoot: fixture(t), lookup: () => "" });
  assert.equal(report.checks.find((entry) => entry.id === "password-store-opt-out").status, "warn");
  assert.equal(report.checks.some((entry) => entry.id === "sandbox-opt-out"), false);
  env.OPENCODEX_LINUX_PASSWORD_STORE = "invalid-private-value";
  const invalid = collectDiagnostics({ env, platform: "linux", arch: "arm64", uid: 1000, glibc: "2.41", appRoot: fixture(t), lookup: () => "" });
  assert.equal(invalid.checks.find((entry) => entry.id === "password-store").status, "error");
  assert.equal(JSON.stringify(invalid).includes("invalid-private-value"), false);
});

test("LAN binding is passed to the child and explicit loopback remains available", () => {
  // 验证传入子进程的配置，不启动服务或在测试机开放网络端口。
  for (const host of [undefined, "127.0.0.1", "192.168.1.10"]) {
    const env = deploymentEnvironment({ ...(host ? { HOST: host } : {}), DISPLAY: ":1", DBUS_SESSION_BUS_ADDRESS: "fixture-session" });
    assert.equal(buildLaunchPlan(env).env.HOST, host || "0.0.0.0");
  }
});

test("LAN default warns about interfaces and still blocks absent or placeholder authentication", (t) => {
  const home = fixture(t);
  const env = deploymentEnvironment({ DISPLAY: ":1" }, home);
  const collect = () => collectDiagnostics({ env, platform: "linux", arch: "arm64", uid: 1000, glibc: "2.41", appRoot: home, lookup: () => "" });
  let report = collect();
  assert.equal(report.checks.find((x) => x.id === "remote-listen").status, "warn");
  assert.equal(report.checks.find((x) => x.id === "auth").status, "error");
  assert.equal(report.ok, false);
  fs.mkdirSync(path.dirname(env.CODEX_WEB_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(env.CODEX_WEB_CONFIG_PATH, 'auth:\n  password: "your-password"\n', { mode: 0o600 });
  report = collect();
  assert.equal(report.checks.find((x) => x.id === "auth").status, "error");
  assert.equal(report.ok, false);
  env.HOST = "127.0.0.1";
  assert.equal(collect().checks.some((x) => x.id === "remote-listen"), false);
});

test("deployment honors explicitly chosen paths and listen address", () => {
  const root = path.resolve("custom-state");
  const config = path.resolve("custom-config.yaml");
  const env = deploymentEnvironment({ XDG_STATE_HOME: root, CODEX_WEB_CONFIG_PATH: config, HOST: "::1", PORT: "4444" });
  assert.equal(env.CODEX_WEB_CONFIG_PATH, config);
  assert.equal(env.CODEX_WEB_RUNTIME_DIR, path.join(root, "opencodex/runtime"));
  assert.equal(env.HOST, "::1");
  assert.equal(env.PORT, "4444");
});

test("private init hashes password and refuses to overwrite", (t) => {
  const config = path.join(fixture(t), "new", "config.yaml");
  const password = "fixture-only-password-123";
  createConfig(config, password);
  const text = fs.readFileSync(config, "utf8");
  assert.ok(!text.includes(password));
  assert.equal(findAuthPasswordScalar(text).value, `sha256-v1:${crypto.createHash("sha256").update(password).digest("hex")}`);
  assert.equal(inspectAuthConfig(config).ok, true);
  if (process.platform === "linux") assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.throws(() => createConfig(config, "a-different-password"), /EEXIST/);
  assert.equal(fs.readFileSync(config, "utf8"), text);
});

test("init rejects short, multiline and nul passwords before creating a file", (t) => {
  const config = path.join(fixture(t), "config.yaml");
  for (const value of ["short", "  12345678901  ", "longpassword\n123", "longpassword\0abc"]) assert.throws(() => createConfig(config, value));
  assert.equal(fs.existsSync(config), false);
});

test("auth check matches gateway scalar handling and never returns credentials", (t) => {
  const config = path.join(fixture(t), "config.yaml");
  const secret = "long#secret with spaces";
  fs.writeFileSync(config, `auth:\n  password: ${JSON.stringify(secret)} # comment\n`, { mode: 0o600 });
  const result = inspectAuthConfig(config);
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes(secret));
  fs.writeFileSync(config, 'auth: {password: "fake-password"}\n');
  assert.equal(inspectAuthConfig(config).ok, false);
});

test("missing, blank, placeholder and invalid hash auth all fail closed", (t) => {
  const config = path.join(fixture(t), "config.yaml");
  assert.equal(inspectAuthConfig(config).ok, false);
  for (const value of ["", "your-password", "sha256-v1:bad", `sha256-v1:${crypto.createHash("sha256").update("your-password").digest("hex")}`]) {
    fs.writeFileSync(config, `auth:\n  password: ${JSON.stringify(value)}\n`, { mode: 0o600 });
    assert.equal(inspectAuthConfig(config).ok, false);
  }
});

test("Linux deployment rejects world-readable secret config", { skip: process.platform !== "linux" }, (t) => {
  const config = path.join(fixture(t), "config.yaml");
  createConfig(config, "only-a-fixture-password");
  fs.chmodSync(config, 0o644);
  assert.match(inspectAuthConfig(config).message, /chmod 600/);
});

test("existing X11 display is reused without Xvfb", () => {
  assert.deepEqual(displayPlan({ DISPLAY: ":1" }, () => ""), { mode: "existing", wrappers: [] });
});

test("headless plan uses authenticated auto-numbered Xvfb and optional session D-Bus", () => {
  const env = { OPENCODEX_LINUX_HEADLESS: "1", DISPLAY: ":2" };
  const lookup = (name) => `/fixture/bin/${name}`;
  const plan = buildLaunchPlan(env, { node: "/node with spaces/node", appRoot: "/app with spaces", lookup });
  assert.equal(plan.command, "/fixture/bin/xvfb-run");
  assert.deepEqual(plan.args.slice(0, 4), ["--auto-servernum", "--server-args=-screen 0 1280x720x24 -nolisten tcp", "/fixture/bin/dbus-run-session", "--"]);
  assert.ok(plan.args.includes("/node with spaces/node"));
  assert.ok(!plan.args.includes("-ac"));
  assert.ok(!plan.args.includes("--no-sandbox"));
});

test("existing D-Bus address is not replaced or printed in argv", () => {
  const env = { DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "test-private-bus" };
  const plan = buildLaunchPlan(env, { lookup: () => "/bin/dbus-run-session" });
  assert.equal(plan.command, process.execPath);
  assert.ok(!JSON.stringify(plan.args).includes("test-private-bus"));
});

test("missing display dependencies and invalid headless setting fail before spawning", () => {
  assert.throws(() => displayPlan({}, () => ""), /xvfb-run/);
  assert.throws(() => displayPlan({ OPENCODEX_LINUX_HEADLESS: "0" }, () => ""), /DISPLAY/);
  assert.throws(() => displayPlan({ OPENCODEX_LINUX_HEADLESS: "typo" }), /auto/);
});

test("Node version floor follows locked asar engine", () => {
  for (const version of ["20.19.0", "22.11.0"]) assert.equal(nodeSupported(version), false);
  for (const version of ["22.12.0", "24.0.0", "v24.19.0"]) assert.equal(nodeSupported(version), true);
});

test("doctor is read-only and emits no environment secrets", (t) => {
  const home = fixture(t);
  const env = deploymentEnvironment({ PRIVATE_FAKE_KEY: "never-output-me", DISPLAY: ":99" }, home);
  const report = collectDiagnostics({ env, platform: "linux", arch: "arm64", kernel: "6.1.138-android14", uid: 1000, version: "24.0.0", appRoot: home, glibc: "2.41", lookup: () => "" });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((x) => x.id === "build").status, "error");
  assert.equal(report.checks.find((x) => x.id === "auth").status, "error");
  assert.equal(report.checks.find((x) => x.id === "android").status, "warn");
  assert.equal(fs.existsSync(env.OPENCODEX_LINUX_DATA_DIR), false);
  assert.ok(!JSON.stringify(report).includes("never-output-me"));
});

test("doctor distinguishes root restrictions from display readiness", (t) => {
  const home = fixture(t);
  const env = deploymentEnvironment({ DISPLAY: ":2" }, home);
  const report = collectDiagnostics({ env, platform: "linux", uid: 0, arch: "arm64", glibc: "2.41", appRoot: home, lookup: () => "" });
  assert.equal(report.checks.find((x) => x.id === "sandbox").status, "error");
  assert.equal(report.checks.find((x) => x.id === "display").status, "ok");
});

test("native addon inspection rejects another architecture without executing it", (t) => {
  const dir = fixture(t);
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  header.writeUInt16LE(62, 18);
  fs.writeFileSync(path.join(dir, "addon.node"), header);
  const result = inspectNativeAddons(dir, "arm64");
  assert.equal(result.count, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /mismatch/);
});

test("writable ancestor checks do not create directories or accept regular files", (t) => {
  const dir = fixture(t);
  const file = path.join(dir, "file");
  fs.writeFileSync(file, "x");
  assert.equal(writableAncestor(path.join(dir, "new", "child")), true);
  assert.equal(writableAncestor(file), false);
  assert.equal(fs.existsSync(path.join(dir, "new")), false);
});

test("PATH probing ignores relative/current-directory injection", () => {
  assert.equal(executableOnPath("arbitrary-command", { PATH: `.${path.delimiter}relative${path.delimiter}` }), "");
});

test("Linux process supervisor forwards shutdown to an isolated fixture", { skip: process.platform !== "linux", timeout: 5000 }, async (t) => {
  const dir = fixture(t);
  const ready = path.join(dir, "ready");
  const stopped = path.join(dir, "stopped");
  const script = `const fs=require('fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'yes');process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},'yes');setInterval(()=>{},1000)`;
  const { child, stop } = supervise({ command: process.execPath, args: ["-e", script], cwd: dir, env: { PATH: process.env.PATH } }, { graceMs: 500 });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  const exited = once(child, "exit");
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(ready), true);
  stop("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(stopped, "utf8"), "yes");
});

test("Linux headless wrappers start and clean up a fake gateway without Electron", {
  skip: process.platform !== "linux" || !["xvfb-run", "Xvfb", "xauth", "dbus-run-session"].every((name) => executableOnPath(name)),
  timeout: 15000,
}, async (t) => {
  const dir = fixture(t);
  const ready = path.join(dir, "ready.json");
  const entry = path.join(dir, "gateway", "dev", "run-gateway.cjs");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  // 用隔离的 Node 夹具替代整个官方 runtime，只验证显示/会话/进程组的真实 Linux 接线。
  fs.writeFileSync(entry, `const fs=require('fs');
    process.on('SIGTERM',()=>process.exit(0));
    const display=process.env.DISPLAY.replace(/^:/,'').split('.')[0];
    const xpid=Number(fs.readFileSync('/tmp/.X'+display+'-lock','utf8').trim());
    fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({display:!!process.env.DISPLAY,bus:!!process.env.DBUS_SESSION_BUS_ADDRESS,auth:process.env.XAUTHORITY,xpid}));
    setInterval(()=>{},1000);`);
  const env = deploymentEnvironment({ PATH: process.env.PATH, HOME: dir, OPENCODEX_LINUX_HEADLESS: "1" }, dir);
  const plan = buildLaunchPlan(env, { appRoot: dir });
  const { child, stop } = supervise(plan, { graceMs: 800 });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  const exited = once(child, "exit");
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(ready), "fake gateway must start behind Xvfb and D-Bus");
  const state = JSON.parse(fs.readFileSync(ready, "utf8"));
  assert.equal(state.display, true);
  assert.equal(state.bus, true);
  assert.ok(fs.existsSync(state.auth));
  stop("SIGTERM");
  await exited;
  for (let i = 0; i < 80 && fs.existsSync(state.auth); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fs.existsSync(state.auth), false, "xvfb-run removes its temporary authority file");
  // 部分 init 会延迟回收僵尸；僵尸不再持有 X display，不把它误认为仍在运行的服务。
  let live = true;
  for (let i = 0; i < 80; i++) {
    try { live = !/\) Z /.test(fs.readFileSync(`/proc/${state.xpid}/stat`, "utf8")); }
    catch { live = false; }
    if (!live) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(live, false, "Xvfb must not survive supervisor shutdown");
});

test("Linux repeated Ctrl-C preserves cleanup of stubborn descendants after wrapper exit", { skip: process.platform !== "linux", timeout: 10000 }, async (t) => {
  const dir = fixture(t);
  const ready = path.join(dir, "ready");
  const closed = path.join(dir, "closed");
  const pidFile = path.join(dir, "group-pid");
  const stubborn = `const fs=require('fs');process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
  const wrapper = `const fs=require('fs');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(stubborn)}],{stdio:'ignore'}).unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.exit(0)}},10)`;
  const parent = `const fs=require('fs');const {supervise,bindStopSignals}=require(${JSON.stringify(require.resolve("../../scripts/linux-start.cjs"))});const {child,stop}=supervise({command:process.execPath,args:['-e',${JSON.stringify(wrapper)}],cwd:${JSON.stringify(dir)},env:{PATH:'/usr/bin:/bin'}},{graceMs:700});bindStopSignals(stop);fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.on('close',()=>fs.writeFileSync(${JSON.stringify(closed)},'yes'));`;
  const controller = spawn(process.execPath, ["-e", parent], { stdio: "ignore", env: { PATH: process.env.PATH } });
  t.after(() => {
    try { controller.kill("SIGKILL"); } catch {}
    try { process.kill(-Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
  });
  const exited = once(controller, "exit");
  for (let i = 0; i < 150 && !fs.existsSync(closed); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(closed), "direct wrapper must already have exited");
  controller.kill("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.kill("SIGINT");
  const [, signal] = await exited;
  assert.equal(signal, null, "second Ctrl-C must not bypass the force-cleanup timer");
  const pid = Number(fs.readFileSync(ready, "utf8"));
  let live = true;
  for (let i = 0; i < 50; i++) {
    try { live = !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { live = false; }
    if (!live) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(live, false, "stubborn grandchild must be killed");
});
