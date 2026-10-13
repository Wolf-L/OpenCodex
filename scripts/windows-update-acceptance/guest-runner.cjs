"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const helper = require("./self-update-helper.cjs");
const { ROOT, assertIsolated, assertChild, assertScenario } = require("./safety.cjs");
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const data = path.join(ROOT, "user-data");
const install = path.join(ROOT, "OpenCodex");
const exe = path.join(install, "OpenCodex.exe");
const resultDir = path.join(ROOT, "results");
const results = { startedAt: new Date().toISOString(), scenarios: [], limitations: ["Network downloader is bypassed", "Gateway is a real lightweight fixture child; official Gateway, CLI and accounts are not exercised", "Unsigned local packages, not a public release"] };
let active;
const event = value => { fs.appendFileSync(path.join(resultDir, "runner.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n"); };
async function waitFor(check, timeout = 900000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(400); }
  throw new Error("Guest acceptance bounded wait timed out");
}
function events() {
  try { return fs.readFileSync(path.join(data, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function ready(version, afterPid = null) {
  return waitFor(async () => {
    const record = events().filter(entry => entry.type === "ready" && entry.version === version && entry.pid !== afterPid).at(-1);
    if (!record) return false;
    const identity = await helper.processInfo(record.pid);
    return identity && helper.samePath(identity.exePath, exe) && await helper.alive(identity) ? identity : false;
  }, 120000);
}
async function registry() {
  const values = [];
  for (const key of helper.REGISTRY_KEYS) {
    const entry = await helper.powershell(`$k = Get-Item -LiteralPath '${key.replace("HKCU\\", "HKCU:\\")}' -ErrorAction Stop; $v = @{}; foreach ($n in $k.GetValueNames()) { $v[$n] = @{ value = $k.GetValue($n); kind = $k.GetValueKind($n).ToString() } }; $v | ConvertTo-Json -Depth 8 -Compress`);
    values.push(Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))));
  }
  return values;
}
const sentinelNames = ["synthetic-config.json", "synthetic-accounts.json", "synthetic-chat.json"];
const sentinelDigests = () => Object.fromEntries(sentinelNames.map(name => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(data, name))).digest("hex")]));
// 注册表 JSON 的对象键顺序由 PowerShell 决定，递归排序后再比较实际值和类型。
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
async function silentInstall(installer) {
  await helper.verifyInstaller(installer.path, installer.size, installer.sha256);
  event({ type: "initial-install", path: installer.path });
  await new Promise((resolve, reject) => {
    // 仅初次安装由编排器运行；后续升级和回退全部经未修改的产品助手执行。
    const child = spawn(installer.path, ["/S", "/currentuser", `/D=${install}`], { shell: false, windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore", timeout: 300000 });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`initial installer exited ${code}`)));
  });
}
function writeCommand(identity, prepared) {
  helper.atomicJson(path.join(data, `command-${identity.pid}.json`), { prepared });
}
async function scenario(name, pkg, expected, sentinels) {
  const original = active;
  const beforeRegistry = await registry();
  const beforeInventory = await helper.inventory(install);
  const previousLatest = fs.existsSync(path.join(data, "self-update/transactions/latest.json")) ? helper.readJson(path.join(data, "self-update/transactions/latest.json")).transactionId : null;
  writeCommand(original, { installerPath: pkg.path, size: pkg.size, sha256: pkg.sha256, targetVersion: pkg.version });
  const terminal = await waitFor(() => {
    try {
      const pointer = helper.readJson(path.join(data, "self-update/transactions/latest.json"));
      if (pointer.transactionId === previousLatest) return false;
      const journal = helper.readJson(path.join(data, "self-update/transactions", pointer.transactionId, "journal.json"));
      return ["completed", "rolled-back", "cancelled", "recovery-needed"].includes(journal.status) ? journal : false;
    } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
  // 先保存原始终态；即使后续验证失败，也保留安装器和助手的原生结果。
  fs.writeFileSync(path.join(resultDir, `${name}-journal.json`), JSON.stringify(terminal, null, 2));
  if (terminal.status !== expected.status) throw new Error(`${name}: expected ${expected.status}, got ${terminal.status}: ${terminal.error}`);
  active = await ready(expected.version, original.pid);
  const afterRegistry = await registry();
  const version = helper.readJson(path.join(install, "resources/app/package.json")).version;
  const record = { name, status: terminal.status, version, error: terminal.error, transactionId: terminal.transactionId,
    originalExited: !await helper.alive(original), runningVersionMatches: events().some(entry => entry.type === "ready" && entry.pid === active.pid && entry.version === version),
    sentinelsUnchanged: equal(sentinels, sentinelDigests()), registryMatches: expected.restored ? equal(beforeRegistry, afterRegistry) : afterRegistry[1].DisplayVersion.value === version,
    applicationMatches: expected.restored ? equal(beforeInventory, await helper.inventory(install)) : true,
    lockReleased: !fs.existsSync(path.join(data, "self-update/transactions/active.lock")),
    failedInstallPreserved: expected.restored ? fs.existsSync(`${install}.failed-update-${terminal.transactionId}`) : true,
  };
  results.scenarios.push(record); event(record); assertScenario(record, expected);
}
async function run() {
  assertIsolated({ username: process.env.USERNAME, root: ROOT, args: process.argv.slice(2), marker: helper.readJson(path.join(ROOT, "ISOLATED-SANDBOX.json")), platform: process.platform, githubActions: process.env.GITHUB_ACTIONS, runnerEnvironment: process.env.RUNNER_ENVIRONMENT });
  for (const target of [data, install, resultDir, __dirname]) assertChild(target);
  fs.mkdirSync(resultDir, { recursive: true });
  for (const key of helper.REGISTRY_KEYS) {
    const exists = await helper.powershell(`@{ user = Test-Path -LiteralPath '${key.replace("HKCU\\", "HKCU:\\")}'; machine = Test-Path -LiteralPath '${key.replace("HKCU\\", "HKLM:\\")}' } | ConvertTo-Json -Compress`);
    if (exists.user || exists.machine) throw new Error("Guest already has registered OpenCodex; refusing to overwrite");
  }
  if (fs.existsSync(install)) throw new Error("Guest installation directory already exists");
  const manifest = helper.readJson(path.join(__dirname, "manifest.json"));
  results.manifest = manifest;
  const packages = manifest.packages.map(pkg => ({ ...pkg, path: assertChild(path.join(__dirname, pkg.filename)) }));
  for (const pkg of packages) await helper.verifyInstaller(pkg.path, pkg.size, pkg.sha256);
  fs.mkdirSync(data, { recursive: true });
  for (const name of sentinelNames) fs.writeFileSync(path.join(data, name), JSON.stringify({ synthetic: true, sentinel: crypto.randomUUID() }), { flag: "wx" });
  const sentinels = sentinelDigests();
  await silentInstall(packages[0]);
  const env = { ...process.env, OPENCODEX_ACCEPTANCE_FLAG: process.argv.includes("--run-github-hosted") ? "--run-github-hosted" : "--run-isolated" };
  delete env.ELECTRON_RUN_AS_NODE;
  const launched = await helper.launch(exe, [], { env, detached: true }); launched.child.unref();
  active = await ready("1.0.0");
  const gatewayBefore = events().filter(entry => entry.type === "gateway-ready" && entry.pid === active.pid).at(-1).gatewayPid;
  const gatewayIdentity = await helper.processInfo(gatewayBefore);
  writeCommand(active, { installerPath: packages[1].path, size: packages[1].size, sha256: "0".repeat(64), targetVersion: "1.0.1" });
  const rejection = await waitFor(() => events().find(entry => entry.type === "install-rejected" && entry.pid === active.pid), 60000);
  const corrupt = { name: "corrupt-pre-stop", rejected: true, error: rejection.error, originalAlive: await helper.alive(active), gatewayAlive: await helper.alive(gatewayIdentity), sentinelsUnchanged: equal(sentinels, sentinelDigests()) };
  results.scenarios.push(corrupt);
  if (!corrupt.originalAlive || !corrupt.gatewayAlive || !corrupt.sentinelsUnchanged) throw new Error("Corruption stopped the original service");
  await scenario("healthy-upgrade", packages[1], { status: "completed", version: "1.0.1" }, sentinels);
  await scenario("startup-failure", packages[2], { status: "rolled-back", version: "1.0.1", restored: true }, sentinels);
  await scenario("installer-failure", packages[3], { status: "rolled-back", version: "1.0.1", restored: true }, sentinels);
  results.passed = true;
}
run().catch(error => { results.passed = false; results.error = error.stack; }).finally(async () => {
  // 仅回收带本次路径和创建时间证据的夹具进程；失败现场、注册表和备份全部保留。
  if (active) try { results.finalProcessStopped = await helper.nativeAdapter("").stopOwned(active); } catch (error) { results.cleanupError = error.message; }
  results.finishedAt = new Date().toISOString();
  if (fs.existsSync(resultDir)) {
    fs.writeFileSync(path.join(resultDir, "result.json"), JSON.stringify(results, null, 2));
    if (fs.existsSync(path.join(data, "events.jsonl"))) fs.copyFileSync(path.join(data, "events.jsonl"), path.join(resultDir, "events.jsonl"));
    // 只复制小型证据文件到专门的映射输出，不把来宾账户或整个用户目录导出。
    if (fs.existsSync("C:\\AcceptanceOutput")) for (const file of fs.readdirSync(resultDir)) fs.copyFileSync(path.join(resultDir, file), path.join("C:\\AcceptanceOutput", file));
  }
  console.log(JSON.stringify(results));
  process.exitCode = results.passed ? 0 : 1;
});
