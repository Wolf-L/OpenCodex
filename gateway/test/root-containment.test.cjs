const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isWithinRoot } = require("../runtime/core/config.cjs");

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-root-containment-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "webview");
  const outside = path.join(base, "webview-other");
  for (const directory of [path.join(root, "assets"), outside]) fs.mkdirSync(directory, { recursive: true });
  const asset = path.join(root, "assets", "index.js");
  const external = path.join(outside, "private.js");
  fs.writeFileSync(asset, "fixture");
  fs.writeFileSync(external, "outside");
  return { root, outside, asset, external };
}

test("root containment accepts contained files and rejects missing, sibling, and traversal paths", (t) => {
  const { root, asset, external } = fixture(t);
  assert.equal(isWithinRoot(root, root), true);
  assert.equal(isWithinRoot(asset, root), true);
  assert.equal(isWithinRoot(external, root), false);
  assert.equal(isWithinRoot(path.join(root, "..", "webview-other", "private.js"), root), false);
  assert.equal(isWithinRoot(path.join(root, "missing.js"), root), false);
  assert.equal(isWithinRoot(asset, path.join(root, "missing")), false);
});

test("root containment still resolves junctions and rejects links escaping the root", (t) => {
  const { root, outside } = fixture(t);
  // Windows 目录联接无需创建文件符号链接的额外权限；其它平台使用目录符号链接。
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(path.join(root, "assets"), path.join(root, "inside-link"), linkType);
  fs.symlinkSync(outside, path.join(root, "outside-link"), linkType);
  assert.equal(isWithinRoot(path.join(root, "inside-link", "index.js"), root), true);
  assert.equal(isWithinRoot(path.join(root, "outside-link", "private.js"), root), false);
});

test("Windows root containment does not mix native MSIX file aliases with logical directories", {
  skip: process.platform !== "win32" && "Windows MSIX namespace regression",
}, (t) => {
  const { root, asset, external } = fixture(t);
  let nativeCalls = 0;
  // 模拟 native realpath 对单个文件返回包缓存别名，普通 realpath 仍解析真实的目录联接。
  t.mock.method(fs.realpathSync, "native", (file) => {
    nativeCalls += 1;
    return file === asset ? external : fs.realpathSync(file);
  });
  assert.equal(isWithinRoot(asset, root), true);
  assert.equal(isWithinRoot(external, root), false);
  assert.equal(nativeCalls, 0);
});
