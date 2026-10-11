const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const workflow = fs.readFileSync(path.join(root, ".github/workflows/build-release.yml"), "utf8");
const linuxTests = ["linux-runtime", "linux-deployment", "linux-packaging"];

function workflowJob(name) {
  // 按顶层 job 边界读取片段，不依赖打包器间接安装的 YAML 库。
  const match = workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "m"));
  assert.ok(match, `Missing workflow job: ${name}`);
  return match[1];
}

test("Linux source commands declare the supported Node floor and dedicated entrypoints", () => {
  assert.equal(pkg.engines.node, ">=22.12.0");
  for (const command of ["doctor", "init", "start"]) {
    assert.equal(pkg.scripts[`linux:${command}`], `node scripts/linux-${command}.cjs`);
  }
  const testFiles = pkg.scripts.test.split(/\s+/);
  for (const name of linuxTests) {
    assert.equal(testFiles.filter((file) => file === `gateway/test/${name}.test.cjs`).length, 1);
  }
});

test("Linux packaging keeps the x64 default and selects ARM64 explicitly", () => {
  for (const kind of ["pack", "dist"]) {
    assert.equal(pkg.scripts[`launcher:${kind}:linux`], pkg.scripts[`launcher:${kind}:linux:x64`]);
    for (const arch of ["x64", "arm64"]) {
      const command = pkg.scripts[`launcher:${kind}:linux:${arch}`];
      assert.match(command, /--linux\b/);
      assert.ok(command.split(/\s+/).includes(`--${arch}`));
      assert.ok(!command.split(/\s+/).includes(`--${arch === "x64" ? "arm64" : "x64"}`));
      if (kind === "pack") assert.match(command, /--dir\b/);
    }
  }
  const arm64Dist = pkg.scripts["launcher:dist:linux:arm64"].split(/\s+/);
  assert.ok(arm64Dist.includes("deb"));
  assert.ok(arm64Dist.includes("tar.gz"));
  assert.ok(!arm64Dist.includes("AppImage"), "ARM64 deployment must not require FUSE");
});

test("Both Linux architectures have uniquely named no-FUSE artifacts and DEB metadata", () => {
  for (const name of ["deb", "tar.gz"]) {
    const target = pkg.build.linux.target.find((item) => item.target === name);
    assert.ok(target, `Missing Linux target: ${name}`);
    assert.deepEqual(new Set(target.arch), new Set(["x64", "arm64"]));
  }
  assert.equal(pkg.build.linux.artifactName, "${productName}-${version}-linux-${arch}.${ext}");
  assert.match(pkg.homepage, /^https:\/\//);
  assert.ok(pkg.build.linux.maintainer, "DEB builder requires explicit maintainer metadata");
});

test("Source packaging never implicitly publishes artifacts from CI", () => {
  for (const [name, command] of Object.entries(pkg.scripts)) {
    // 本地命令也可能在带有 CI/凭证环境变量的终端执行，因此发布必须显式禁止。
    if (command.includes("electron-builder")) {
      assert.match(command, /--publish\s+never\b/, `${name} may publish implicitly`);
    }
  }
});

test("Linux CI builds and tests natively on x64 and ARM64 before artifact upload", () => {
  const linux = workflowJob("build-linux");
  assert.match(linux, /arch:\s*x64\s+runner:\s*ubuntu-24\.04(?:\s|$)/);
  assert.match(linux, /arch:\s*arm64\s+runner:\s*ubuntu-24\.04-arm(?:\s|$)/);
  assert.match(linux, /runs-on:\s*\$\{\{\s*matrix\.runner\s*\}\}/);
  assert.match(linux, /process\.arch !== process\.env\.EXPECTED_ARCH/);
  assert.ok(linux.indexOf("pnpm run build") < linux.indexOf("node --test"));
  for (const name of linuxTests) assert.ok(linux.includes(`gateway/test/${name}.test.cjs`));
  assert.doesNotMatch(linux, /pnpm\s+(?:run\s+)?test\b/);
  assert.match(linux, /electron-builder --linux deb tar\.gz --\$\{\{ matrix\.arch \}\} --publish never/);
  assert.ok(linux.includes("release/*-linux-${{ matrix.deb_arch }}.deb"));
  assert.ok(linux.includes("release/*-linux-${{ matrix.arch }}.tar.gz"));
  assert.match(linux, /name:\s*opencodex-linux-\$\{\{ matrix\.arch \}\}-\$\{\{ github\.sha \}\}/);
});

test("Draft release waits for Linux and checks both architectures and formats", () => {
  const release = workflowJob("release");
  assert.match(release, /if:\s*needs\.metadata\.outputs\.is_release == 'true'/);
  assert.match(release, /- build-linux(?:\s|$)/);
  assert.ok(release.includes("${#deb_files[@]} != 2"));
  assert.ok(release.includes("${#tar_files[@]} != 2"));
  assert.match(release, /for arch in x64 arm64/);
  assert.match(release, /for ext in deb tar\.gz/);
  assert.ok(release.includes('if [[ "$ext" == "deb" && "$arch" == "x64" ]]; then asset_arch=amd64; fi'));
  assert.ok(release.includes("OpenCodex-${RELEASE_VERSION}-linux-${asset_arch}.${ext}"));
  const assets = release.match(/^\s*assets=\(([^\r\n]*)\)/m)?.[1];
  assert.ok(assets?.includes("release-assets/*-linux-*.deb"));
  assert.ok(assets?.includes("release-assets/*-linux-*.tar.gz"));
});

test("Linux uploads include the real Debian filename and verify both package formats", () => {
  const linux = workflowJob("build-linux");
  // 用打包器实际生成的文件名检验上传路径，防止仅成功上传 tar.gz 却遗漏 DEB。
  const matrix = [...linux.matchAll(/- arch: (\w+)\s+runner: [\w.-]+\s+deb_arch: (\w+)/g)];
  assert.equal(matrix.length, 2);
  const uploadPaths = linux.match(/path: \|\r?\n((?: +release\/[^\r\n]+\r?\n)+)/)?.[1].trim().split(/\r?\n/).map((line) => line.trim());
  assert.ok(uploadPaths);
  for (const [, arch, debArch] of matrix) {
    const patterns = uploadPaths.map((item) => item.replace("${{ matrix.arch }}", arch).replace("${{ matrix.deb_arch }}", debArch));
    const debName = arch === "x64" ? "amd64" : "arm64";
    for (const filename of [`release/OpenCodex-2.1.0-linux-${debName}.deb`, `release/OpenCodex-2.1.0-linux-${arch}.tar.gz`]) {
      assert.ok(patterns.some((pattern) => path.matchesGlob(filename, pattern)), `Missing artifact: ${filename}`);
    }
  }
  assert.ok(linux.indexOf("Verify both Linux package formats") < linux.indexOf("Upload Linux artifacts"));
  assert.ok(linux.includes('test -s "release/OpenCodex-${version}-linux-${DEB_ARCH}.deb"'));
  assert.ok(linux.includes('test -s "release/OpenCodex-${version}-linux-${BUILD_ARCH}.tar.gz"'));
  assert.match(linux, /dpkg-deb --field.*Architecture/);
});
