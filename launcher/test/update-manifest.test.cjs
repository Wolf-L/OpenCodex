"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createWindowsUpdateManifest, checkWindowsUpdateManifest, MANIFEST_NAME } = require("../../scripts/create-windows-update-manifest.cjs");

const commit = "a".repeat(40), version = "2.3.4";
test("rebuilding an unpublished release also updates its target commit", async () => {
  const workflow = await fs.readFile(path.join(__dirname, "../../.github/workflows/build-release.yml"), "utf8");
  assert.match(workflow, /gh release edit "\$RELEASE_VERSION"[^\n]*--draft=true --target "\$GITHUB_SHA"/);
  assert.match(workflow, /is_draft.*!= "true"/);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-manifest-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.concat([Buffer.from("MZ"), crypto.randomBytes(9000)]);
  const installer = path.join(directory, `OpenCodex Setup ${version}.exe`);
  await fs.writeFile(installer, bytes);
  return { directory, bytes, installer, options: { directory, commit, version } };
}

test("manifest records actual installer bytes deterministically and check detects tampering", async t => {
  const f = await fixture(t);
  const manifest = await createWindowsUpdateManifest(f.options);
  assert.deepEqual(manifest, { schemaVersion: 1, appId: "dev.opencodex.launcher", version,
    platform: "win32", arch: "x64", installer: { name: path.basename(f.installer), size: f.bytes.length,
      sha256: crypto.createHash("sha256").update(f.bytes).digest("hex") }, commit });
  const initial = await fs.readFile(path.join(f.directory, MANIFEST_NAME), "utf8");
  await createWindowsUpdateManifest(f.options);
  assert.equal(await fs.readFile(path.join(f.directory, MANIFEST_NAME), "utf8"), initial);
  await checkWindowsUpdateManifest(f.options);
  const changed = Buffer.from(f.bytes); changed[100] ^= 1;
  await fs.writeFile(f.installer, changed);
  await assert.rejects(checkWindowsUpdateManifest(f.options), /does not match/);
});

test("check rejects changed identity, version, commit, size, hash and traversal name", async t => {
  const f = await fixture(t);
  const original = await createWindowsUpdateManifest(f.options);
  const variants = [
    { ...original, schemaVersion: 2 }, { ...original, appId: "other.app" },
    { ...original, version: "2.3.5" }, { ...original, platform: "linux" },
    { ...original, arch: "arm64" }, { ...original, commit: "b".repeat(40) },
    ...[{ name: "../installer.exe" }, { size: original.installer.size + 1 }, { sha256: "0".repeat(64) }]
      .map(change => ({ ...original, installer: { ...original.installer, ...change } })),
  ];
  for (const manifest of variants) {
    await fs.writeFile(path.join(f.directory, MANIFEST_NAME), JSON.stringify(manifest));
    await assert.rejects(checkWindowsUpdateManifest(f.options), /does not match/);
  }
  await fs.writeFile(path.join(f.directory, MANIFEST_NAME), "invalid JSON");
  await assert.rejects(checkWindowsUpdateManifest(f.options), /JSON/);
});

test("generator rejects invalid version/commit and missing, empty or non-PE artifacts", async t => {
  const f = await fixture(t);
  for (const invalid of ["../2.3.4", "2.3.4-beta", "02.3.4", "2.3", "9007199254740992.0.0"]) {
    await assert.rejects(createWindowsUpdateManifest({ ...f.options, version: invalid }), /version/);
  }
  await assert.rejects(createWindowsUpdateManifest({ ...f.options, commit: "HEAD" }), /commit/);
  await fs.rename(f.installer, `${f.installer}.other`);
  await assert.rejects(createWindowsUpdateManifest(f.options), /ENOENT/);
  await fs.writeFile(f.installer, "");
  await assert.rejects(createWindowsUpdateManifest(f.options), /size/);
  await fs.writeFile(f.installer, "not an installer");
  await assert.rejects(createWindowsUpdateManifest(f.options), /MZ/);
});

test("generator rejects symlinked installer or output instead of following them", async t => {
  const f = await fixture(t);
  const target = `${f.installer}.target`;
  await fs.rename(f.installer, target);
  try { await fs.symlink(target, f.installer); }
  catch (error) { if (error.code === "EPERM") return t.skip("Windows symlink permission unavailable"); throw error; }
  await assert.rejects(createWindowsUpdateManifest(f.options), /regular file/);
  await fs.unlink(f.installer); await fs.rename(target, f.installer);
  await fs.writeFile(target, "preserved");
  await fs.symlink(target, path.join(f.directory, MANIFEST_NAME));
  await assert.rejects(createWindowsUpdateManifest(f.options), /regular file/);
  assert.equal(await fs.readFile(target, "utf8"), "preserved");
});

test("check bounds manifest size and CLI rejects unknown options", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, MANIFEST_NAME), " ".repeat(65537));
  await assert.rejects(checkWindowsUpdateManifest(f.options), /size/);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/create-windows-update-manifest.cjs"), "--directory", f.directory, "--commit", commit, "--unknown"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option/);
});

test("generator rejects oversized sparse artifact before hashing", async t => {
  const f = await fixture(t);
  // 使用稀疏长度验证边界，不为测试生成或读取一 GiB 安装数据。
  await fs.truncate(f.installer, 1024 ** 3 + 1);
  await assert.rejects(createWindowsUpdateManifest(f.options), /size/);
});

test("CLI generates and checks the packaged version using the release workflow arguments", async t => {
  const f = await fixture(t);
  const packageVersion = require("../../package.json").version;
  await fs.rename(f.installer, path.join(f.directory, `OpenCodex Setup ${packageVersion}.exe`));
  const script = path.resolve(__dirname, "../../scripts/create-windows-update-manifest.cjs");
  const args = [script, "--directory", f.directory, "--commit", commit];
  for (const flags of [[], ["--check"]]) {
    const result = spawnSync(process.execPath, [...args, ...flags], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, MANIFEST_NAME), "utf8")).version, packageVersion);
});
