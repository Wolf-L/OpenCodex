"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const helper = require("../self-update-helper.cjs");
const installer = require("../self-update-install.cjs");
const { EventEmitter } = require("node:events");

test("missing or reused parent never adopts an unrelated orphan from parentPid", () => {
  const parent = { pid: 100, exePath: path.resolve("OpenCodex.exe"), born: "2026-01-01T00:00:00Z" };
  const child = { pid: 200, parentPid: 100, exePath: path.resolve("gateway.exe"), born: "2026-01-01T00:00:01Z" };
  const grandchild = { pid: 300, parentPid: 200, exePath: path.resolve("cli.exe"), born: "2026-01-01T00:00:02Z" };
  assert.deepEqual(helper.ownedFromSnapshot(parent, [child, grandchild]), []);
  assert.throws(() => helper.ownedFromSnapshot(parent, [{ ...parent, born: child.born }, child]), /复用/);
  assert.deepEqual(helper.ownedFromSnapshot(parent, [parent, child, grandchild]), [parent, child, grandchild]);
});

test("launch never adopts a mismatched or recycled process identity", async () => {
  const now = Date.now();
  const exe = path.resolve("OpenCodex.exe");
  const valid = { pid: 123, exePath: exe, born: new Date(now).toISOString() };
  for (const changed of [{ pid: 456 }, { exePath: path.resolve("Unrelated.exe") }, { born: new Date(now - 60000).toISOString() }, { born: new Date(now + 60000).toISOString() }, { born: "invalid" }]) {
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
    await assert.rejects(helper.launch(exe, [], {}, {
      spawn: () => child, now: () => now, processInfo: async () => ({ ...valid, ...changed }),
    }), error => error.recoveryUnsafe === true && /身份/.test(error.message));
  }
});

test("launch rejects a child that exits while ownership is being queried", async () => {
  const now = Date.now(), exe = path.resolve("OpenCodex.exe");
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  await assert.rejects(helper.launch(exe, [], {}, {
    spawn: () => child, now: () => now, processInfo: async () => {
      child.emit("exit", 0);
      return { pid: 123, exePath: exe, born: new Date(now).toISOString() };
    },
  }), error => error.recoveryUnsafe === true && /身份确认前退出/.test(error.message));
});

test("launch adopts only the live process matching this spawn", async () => {
  const now = Date.now(), exe = path.resolve("OpenCodex.exe");
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  const identity = { pid: 123, exePath: exe, born: new Date(now).toISOString() };
  const launched = await helper.launch(exe, [], {}, { spawn: () => child, now: () => now, processInfo: async () => identity });
  assert.deepEqual(launched.identity, identity);
  assert.equal(launched.exited(), false);
  child.emit("exit", 0);
  assert.equal(launched.exited(), true);
  assert.equal(launched.code(), 0);
});

test("packaged metadata without builder-stripped build field is accepted with retained identity", () => {
  const metadata = { name: "opencodex", productName: "OpenCodex", main: "launcher/main.cjs", version: "2.1.0" };
  assert.equal(installer.__test.validatePackagedMetadata(metadata), true);
  assert.equal(installer.__test.validatePackagedMetadata({ ...metadata, build: { appId: "dev.opencodex.launcher" } }), true);
  for (const changed of [{ name: "other" }, { productName: "Other" }, { main: "other.cjs" }, { build: { appId: "dev.other" } }]) {
    assert.throws(() => installer.__test.validatePackagedMetadata({ ...metadata, ...changed }), /身份/);
  }
});

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "opencodex-update-transaction-"));
  const userData = path.join(root, "user-data");
  const dir = path.join(userData, "self-update", "transactions", "a".repeat(32));
  const installDir = path.join(root, "OpenCodex");
  const backupDir = path.join(dir, "application-backup");
  await fsp.mkdir(installDir, { recursive: true });
  await fsp.mkdir(backupDir, { recursive: true });
  await fsp.writeFile(path.join(installDir, "old.txt"), "previous application");
  await fsp.writeFile(path.join(backupDir, "old.txt"), "previous application");
  await fsp.writeFile(path.join(userData, "session.json"), "keep my account and conversation");
  const installerPath = path.join(dir, "installer.exe");
  await fsp.writeFile(installerPath, "verified installer fixture");
  const inventoryFile = path.join(dir, "inventory.json");
  helper.atomicJson(inventoryFile, await helper.inventory(backupDir));
  const registry = [];
  for (const [index, key] of helper.REGISTRY_KEYS.entries()) {
    const file = path.join(dir, `registry-${index}.reg`);
    await fsp.writeFile(file, `Windows Registry Editor Version 5.00\r\n\r\n[${key.replace("HKCU", "HKEY_CURRENT_USER")}]\r\n\"InstallLocation\"=\"fixture\"\r\n`);
    registry.push({ key, file, size: fs.statSync(file).size, sha256: await helper.digest(file) });
  }
  const journal = { schemaVersion: 1, transactionId: "a".repeat(32), token: "b".repeat(64), status: "preparing", targetVersion: "2.2.0", currentVersion: "2.1.0", userDataDir: userData, exePath: path.join(installDir, "OpenCodex.exe"), installDir, installerPath, size: fs.statSync(installerPath).size, sha256: await helper.digest(installerPath), parent: { pid: 100, born: "parent", exePath: path.join(installDir, "OpenCodex.exe") }, backupDir, inventoryFile, inventorySize: fs.statSync(inventoryFile).size, inventorySha256: await helper.digest(inventoryFile), registry };
  helper.atomicJson(path.join(dir, "journal.json"), journal);
  helper.atomicJson(path.join(dir, "commit.json"), { token: journal.token });
  helper.atomicJson(path.join(path.dirname(dir), "active.lock"), { transactionId: journal.transactionId });
  const events = [];
  const candidate = { pid: 200, born: "candidate", exePath: journal.exePath };
  const gateway = { pid: 300, parentPid: 200, born: "gateway", exePath: path.join(root, "official.exe") };
  const adapter = {
    alive: async () => true,
    waitExit: async () => { events.push("parent-exited"); return true; },
    async install() { events.push("installed"); await fsp.writeFile(path.join(installDir, "new.txt"), "new application"); },
    async candidate() {
      events.push("started");
      helper.atomicJson(path.join(dir, "startup.json"), { token: journal.token, pid: candidate.pid, gatewayPid: gateway.pid });
      helper.atomicJson(path.join(dir, "ack.json"), { token: journal.token, version: journal.targetVersion, pid: candidate.pid, exePath: journal.exePath, gatewayPid: gateway.pid });
      return candidate;
    },
    processInfo: async pid => pid === gateway.pid ? gateway : null,
    stopOwned: async identity => { events.push(`stopped-${identity.pid}`); return true; },
    async restore() {
      events.push("restored");
      await fsp.rename(installDir, `${installDir}.failed`);
      await fsp.cp(backupDir, installDir, { recursive: true });
    },
  };
  const run = () => helper.runTransaction(dir, adapter, { pollMs: 1, ackTimeoutMs: 15, parentExitTimeoutMs: 15 });
  const state = () => helper.readJson(path.join(dir, "journal.json"));
  t.after(async () => {
    try { assert.equal(fs.readFileSync(path.join(userData, "session.json"), "utf8"), "keep my account and conversation"); }
    finally { await fsp.rm(root, { recursive: true, force: true }); }
  });
  return { root, dir, journal, adapter, events, run, state, candidate, gateway };
}

test("Windows update commits only after parent exits and matching Gateway ACK", async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.state().status, "completed");
  assert.deepEqual(f.events, ["parent-exited", "installed", "started"]);
  assert.equal(fs.existsSync(path.join(f.journal.backupDir, "old.txt")), true);
});

test("corrupted installer never starts installer or replaces app", async t => {
  const f = await fixture(t);
  await fsp.writeFile(f.journal.installerPath, "corrupt");
  await f.run();
  assert.equal(f.state().status, "cancelled");
  assert.deepEqual(f.events, ["parent-exited"]);
});

test("parent still running prevents installer launch", async t => {
  const f = await fixture(t);
  f.adapter.waitExit = async () => false;
  await f.run();
  assert.equal(f.state().status, "cancelled");
  assert.deepEqual(f.events, []);
});

test("nonzero partial installation restores validated files", async t => {
  const f = await fixture(t);
  f.adapter.install = async () => { fs.writeFileSync(path.join(f.journal.installDir, "partial.txt"), "partial"); throw new Error("installer exit 2"); };
  await f.run();
  assert.equal(f.state().status, "rolled-back");
  assert.equal(fs.existsSync(path.join(f.journal.installDir, "partial.txt")), false);
  assert.equal(fs.existsSync(path.join(`${f.journal.installDir}.failed`, "partial.txt")), true);
});

for (const field of ["token", "version", "pid", "exePath"]) {
  test(`incorrect ACK ${field} rolls back rather than committing`, async t => {
    const f = await fixture(t);
    const start = f.adapter.candidate;
    f.adapter.candidate = async () => {
      const candidate = await start();
      const file = path.join(f.dir, "ack.json");
      helper.atomicJson(file, { ...helper.readJson(file), [field]: field === "pid" ? 999 : "incorrect" });
      return candidate;
    };
    await f.run();
    assert.equal(f.state().status, "rolled-back");
    assert.deepEqual(f.events.slice(-3), ["stopped-200", "stopped-300", "restored"]);
  });
}

test("missing ACK and early candidate exit both recover", async t => {
  for (const exited of [false, true]) {
    const f = await fixture(t);
    f.adapter.candidate = async () => f.candidate;
    f.adapter.alive = async identity => !(exited && identity.pid === f.candidate.pid);
    await f.run();
    assert.equal(f.state().status, "rolled-back");
  }
});

test("candidate that cannot stop leaves complete backup and no overwrite", async t => {
  const f = await fixture(t);
  f.adapter.candidate = async () => f.candidate;
  f.adapter.stopOwned = async () => false;
  await f.run();
  assert.equal(f.state().status, "recovery-needed");
  assert.equal(f.events.includes("restored"), false);
});

test("unconfirmed installer exit never restores over possibly running installer", async t => {
  const f = await fixture(t);
  f.adapter.install = async () => { throw Object.assign(new Error("still running"), { recoveryUnsafe: true }); };
  await f.run();
  assert.equal(f.state().status, "recovery-needed");
  assert.equal(f.events.includes("restored"), false);
});

test("backup corrupted after installation prevents rollback mutation", async t => {
  const f = await fixture(t);
  f.adapter.install = async () => { fs.writeFileSync(path.join(f.journal.backupDir, "old.txt"), "damaged"); throw new Error("partial install"); };
  await f.run();
  assert.equal(f.state().status, "recovery-needed");
  assert.equal(f.events.includes("restored"), false);
});

test("foreign Gateway is not killed and prevents unsafe rollback", async t => {
  const f = await fixture(t);
  f.gateway.parentPid = 999;
  await f.run();
  assert.equal(f.state().status, "recovery-needed");
  assert.equal(f.events.some(event => event.startsWith("stopped-")), false);
});

test("uncaptured orphan Gateway is not adopted after candidate exit", async t => {
  const f = await fixture(t);
  f.adapter.alive = async identity => identity.pid !== f.candidate.pid;
  await f.run();
  assert.equal(f.state().status, "recovery-needed");
  assert.match(f.state().error, /未捕获 Gateway/);
  assert.equal(f.events.some(event => event.startsWith("stopped-")), false);
  assert.equal(f.events.includes("restored"), false);
});

test("Gateway captured while parent is alive retains identity for rollback", async t => {
  const f = await fixture(t);
  const start = f.adapter.candidate;
  f.adapter.candidate = async () => { const candidate = await start(); fs.unlinkSync(path.join(f.dir, "ack.json")); return candidate; };
  let observations = 0;
  f.adapter.alive = async identity => identity.pid !== f.candidate.pid || ++observations <= 2;
  await f.run();
  assert.equal(f.state().status, "rolled-back");
  assert.deepEqual(f.events.slice(-3), ["stopped-200", "stopped-300", "restored"]);
});

test("plain path validation rejects shared roots, malformed paths and symlinks", async t => {
  const f = await fixture(t);
  for (const invalid of [path.parse(f.root).root, "relative", `${f.root}\nmalformed`, `\\\\server\\share\\OpenCodex`]) assert.throws(() => helper.assertPlainPath(invalid));
  const junction = path.join(f.root, "junction");
  await fsp.symlink(f.journal.installDir, junction, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => helper.assertPlainPath(junction), /链接|重解析/);
  await assert.rejects(helper.inventory(f.root), /链接|特殊/);
});

test("ordinary startup never writes update ACK", () => {
  assert.equal(installer.recordUpdateStartup({}), false);
  assert.equal(installer.confirmWindowsUpdate({ gatewayPid: 3 }), false);
});

test("pre-mutation validation failure relaunches verified old app after parent exit", async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.journal.installerPath, "bad bytes");
  f.adapter.alive = async () => false;
  f.adapter.relaunchOriginal = async () => f.events.push("relaunch-original");
  await f.run();
  assert.equal(f.state().status, "cancelled");
  assert.deepEqual(f.events, ["parent-exited", "relaunch-original"]);
});

test("changed original app is not blindly relaunched after parent exit", async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.journal.installerPath, "bad bytes");
  f.adapter.alive = async () => false;
  f.adapter.relaunchOriginal = async () => { throw new Error("original changed"); };
  await f.run();
  assert.equal(f.state().status, "recovery-needed");
});

test("journal rejects foreign registry, install paths, backup escape and downgrade", async t => {
  const f = await fixture(t);
  for (const mutate of [
    value => { value.registry[0].key = "HKCU\\Software\\AnotherApplication"; },
    value => { value.registry[0].file = path.join(f.root, "foreign.reg"); },
    value => { value.backupDir = f.root; },
    value => { value.installDir = path.parse(f.root).root; },
    value => { value.installerPath = path.join(f.root, "foreign.exe"); },
    value => { value.targetVersion = "2.0.0"; },
  ]) {
    const journal = structuredClone(f.journal); mutate(journal);
    assert.throws(() => helper.validateJournal(journal, f.dir));
  }
});

test("registry content scope rejects imported foreign software key", async t => {
  const f = await fixture(t);
  const entry = f.journal.registry[0];
  assert.doesNotThrow(() => helper.validateRegistryExport(entry));
  fs.appendFileSync(entry.file, "\r\n[HKEY_CURRENT_USER\\Software\\AnotherApplication]\r\n\"x\"=\"changed\"\r\n");
  assert.throws(() => helper.validateRegistryExport(entry), /不属于/);
});

test("orphan lock is recovery-needed and cannot appear as idle", async t => {
  const f = await fixture(t);
  const options = { userDataDir: f.journal.userDataDir, exePath: f.journal.exePath, currentVersion: f.journal.currentVersion };
  assert.equal(installer.readWindowsUpdateState(options).status, "recovery-needed");
  const state = await installer.recoverWindowsUpdate(options);
  assert.equal(state.canRecover, false);
});

test("prepare rejects non-newer versions before any application mutation", async () => {
  for (const targetVersion of ["2.1.0", "2.0.9", "2.2.0-rc1", "bad"]) {
    await assert.rejects(installer.prepareWindowsUpdate({ targetVersion, currentVersion: "2.1.0" }), /高于/);
  }
});

test("atomic transaction lock blocks a concurrent updater and preserves original owner", async t => {
  const f = await fixture(t);
  const lockRoot = path.join(f.root, "lock-test");
  fs.mkdirSync(lockRoot);
  const lock = installer.__test.acquireTransactionLock(lockRoot, "first-transaction");
  assert.throws(() => installer.__test.acquireTransactionLock(lockRoot, "second-transaction"), /已有更新事务/);
  assert.equal(helper.readJson(lock).transactionId, "first-transaction");
});

test("process ownership uses a real isolated Node fixture and rejects changed birth identity", { skip: process.platform !== "win32" }, async () => {
  const child = await helper.launch(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    assert.equal(await helper.alive(child.identity), true);
    assert.equal(await helper.alive({ ...child.identity, born: "wrong" }), false);
    assert.equal(await helper.stopOwned({ ...child.identity, born: "wrong" }), true);
    assert.equal(await helper.alive(child.identity), true);
  } finally { assert.equal(await helper.stopOwned(child.identity), true); }
});
