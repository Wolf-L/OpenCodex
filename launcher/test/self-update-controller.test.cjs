const test = require("node:test");
const assert = require("node:assert/strict");
const { createSelfUpdateController } = require("../self-update-controller.cjs");

function fixture(overrides = {}) {
  const events = [], calls = { count: 0 };
  const options = { userDataDir: "fixture-user", exePath: "fixture-exe", currentVersion: "2.1.0", platform: "win32", arch: "x64", packaged: true,
    getCandidate: () => ({ version: "2.2.0" }), canInstall: () => true,
    stopGateway: async () => { events.push("stop"); return true; }, startGateway: async () => { events.push("restart-old"); }, quit: () => events.push("quit"),
    createDownloader: () => ({ state: () => ({ status: "ready" }), download: async () => events.push("download"), cancel: () => events.push("cancel-download"),
      verifyPrepared: async () => { events.push("verify"); return { targetVersion: "2.2.0" }; } }),
    installApi: { readWindowsUpdateState: () => ({ status: "idle" }),
      prepareWindowsUpdate: async () => { calls.count++; events.push("prepare"); return { commit: async () => events.push("commit"), cancel: async () => events.push("cancel-helper") }; },
    }, ...overrides };
  return { events, options, calls, controller: createSelfUpdateController(options) };
}

test("download never stops service; installation verifies and prepares helper before stop", async () => {
  const f = fixture(); await f.controller.download();
  assert.deepEqual(f.events, ["download"]); f.events.length = 0;
  await f.controller.install();
  assert.deepEqual(f.events, ["verify", "prepare", "stop", "commit", "quit"]);
  assert.equal(f.controller.state().handedOff, true);
});

test("concurrent install uses one transaction and cancellation cannot interrupt backup", async () => {
  const f = fixture();
  const first = f.controller.install(), second = f.controller.install();
  assert.equal(f.controller.isInstalling(), true); assert.equal(f.controller.canQuit(), false);
  f.controller.cancel();
  await Promise.all([first, second]);
  assert.equal(f.calls.count, 1); assert.equal(f.events.includes("cancel-download"), false);
});

test("failed service stop cancels prepared helper without authorizing install", async () => {
  const f = fixture({ stopGateway: async () => false });
  await assert.rejects(f.controller.install(), /未能退出/);
  assert.deepEqual(f.events, ["verify", "prepare", "cancel-helper"]);
  assert.equal(f.controller.isInstalling(), false);
});

test("preparation failure leaves service untouched; failed handoff restores stopped service", async () => {
  for (const stage of ["prepare", "commit"]) {
    const f = fixture();
    f.options.installApi.prepareWindowsUpdate = async () => {
      if (stage === "prepare") throw new Error("fixture failure");
      return { commit: async () => { throw new Error("fixture failure"); }, cancel: async () => {} };
    };
    await assert.rejects(f.controller.install(), /fixture failure/);
    assert.equal(f.events.includes("stop"), stage === "commit");
    assert.equal(f.events.includes("restart-old"), stage === "commit");
    assert.equal(f.events.includes("quit"), false);
  }
});

test("unsupported platform, busy lifecycle and missing manifest cannot update", async () => {
  for (const patch of [{ platform: "linux" }, { packaged: false }, { canInstall: () => false }]) {
    const f = fixture(patch); await assert.rejects(f.controller.install()); assert.deepEqual(f.events, []);
  }
  const f = fixture({ getCandidate: () => null }); await assert.rejects(f.controller.download()); assert.deepEqual(f.events, []);
});
