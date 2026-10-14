"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const afterPack = require("../../scripts/check-package-privacy.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-package-privacy-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

function write(root, name, content = "fixture") {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test("package privacy accepts production files and leaves dependency resources alone", (t) => {
  const root = fixture(t);
  for (const file of ["package.json", "launcher/main.cjs", "gateway/runtime/server.cjs", "web-shell/plugins/ios-fix/plugin.json",
    "node_modules/vendor/test/fixture.cjs"]) write(root, file);
  assert.deepEqual(afterPack.validatePackagedApp(root), { files: 4 });
});

test("package privacy rejects copied test fixtures and local state without exposing contents", (t) => {
  for (const file of ["launcher/test/example.test.cjs", "launcher/helper.spec.js", "shared/fixtures/data.json",
    ".codex/auth.json", ".ssh/id_ed25519", ".data/config.yaml", "launcher/server.env", "web-shell/auth.json",
    "gateway/runtime/local.sqlite", "repair-backups/application/file.cjs", "launcher/.env.local"]) {
    const root = fixture(t);
    write(root, file, "private-fixture-value");
    assert.throws(() => afterPack.validatePackagedApp(root), (error) => {
      assert.match(error.message, /private or test files/);
      assert.ok(!error.message.includes("private-fixture-value"));
      return true;
    });
  }
});

test("afterPack validates the actual application under the platform resources directory", async (t) => {
  const root = fixture(t);
  // 使用带空格的 macOS 目录夹具，验证没有硬编码 Windows/Linux 目录。
  const resources = path.join(root, "OpenCodex.app", "Contents", "Resources");
  write(path.join(resources, "app"), "launcher/main.cjs");
  await afterPack({ appOutDir: root, packager: { getResourcesDir: (appOutDir) => {
    assert.equal(appOutDir, root);
    return resources;
  } } });
  write(path.join(resources, "app"), "launcher/test/regression.cjs");
  await assert.rejects(afterPack({ appOutDir: root, packager: { getResourcesDir: () => resources } }), /launcher\/test/);
});
