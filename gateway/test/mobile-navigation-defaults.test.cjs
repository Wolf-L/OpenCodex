const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const fixtures = require("./fixtures/mobile-navigation-source.cjs");
const { MOBILE_NAVIGATION_MARKER, MOBILE_NAVIGATION_QUERY, patchMobileNavigationDefaults } = require("../runtime/http/mobile-navigation-defaults.cjs");
const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");
const { PATCHED_OFFICIAL_PREFIX } = require("../runtime/core/config.cjs");
const ids = ["images", "automations", "library", "skills"];
function sourceFor(fixture) { return fixture.grouping + ';function rail(){return{' + fixture.rail + '}}'; }
function harness(platform, mobile, { media = true, patched = true } = {}) {
  const source = sourceFor(fixtures[platform]);
  const calls = [];
  const items = ids.map(id => ({ id: `builtin:${id}`, visibleByDefault: true, onSelect() { calls.push(id); }, contextMenuItems: [{ id: "native-menu" }] }));
  items.push({ id: "builtin:other", visibleByDefault: false, onSelect() {} });
  const groupName = platform === "windows" ? "yjo" : "EMo";
  const areas = { scheduled: { rail: "primary", destinationId: "builtin:automations", sidebar: "scheduled" } };
  const symbols = Object.fromEntries(ids.map(id => [id, `builtin:${id}`]));
  // 纯函数夹具仅使用内存桩：不启动完整官方模块，不访问账号或持久化存储。
  const eligible = e => !["builtin:automations", "builtin:skills"].includes(e.id);
  const sandbox = { YA: areas, oj: areas, ej: symbols, dj: symbols, fFn: eligible, tFn: eligible, window: media ? { matchMedia(query) { assert.equal(query, MOBILE_NAVIGATION_QUERY); return { matches: mobile }; } } : {}, P: [], Hts() {}, Qts() {}, U: { id: "fixed-plugins" }, te: { id: "fixed-plugins" }, ne: true, re: true, o: false };
  vm.runInNewContext((patched ? patchMobileNavigationDefaults(source) : source) + ';this.group=' + groupName + ';this.rail=rail;', sandbox);
  return { items, calls, group: (free = true) => sandbox.group(items, free, free ? "free" : "plus"), rail: sandbox.rail };
}
// 与原生 zFn 同样先取显式覆盖，再补默认项；不会将默认项转为写入的 true。
function pins(items, overrides) {
  const eligible = new Set(items.map(e => e.id));
  const selected = Object.keys(overrides).filter(id => overrides[id] && eligible.has(id));
  for (const item of items) if (selected.length < 8 && item.visibleByDefault && overrides[item.id] == null) selected.push(item.id);
  return selected;
}
for (const platform of Object.keys(fixtures)) {
  test(`${platform}: mobile moves four fixed/primary destinations into native Explore without default pins`, () => {
    const h = harness(platform, true);
    for (const free of [true, false]) {
      const result = h.group(free);
      assert.equal(result.primaryDestinations.length, 0);
      assert.equal(result.standalonePrimaryDestinations.length, 0);
      assert.deepEqual(Array.from(result.exploreDestinations, e => e.id), [...ids.map(id => `builtin:${id}`), "builtin:other"]);
      assert.deepEqual(pins(result.exploreDestinations, {}), []);
      assert.equal(h.rail().customize, null);
      for (const [i, item] of result.exploreDestinations.entries()) {
        assert.equal(item.onSelect, h.items[i].onSelect);
        assert.equal(item.contextMenuItems, h.items[i].contextMenuItems);
      }
      result.exploreDestinations[1].onSelect();
    }
    assert.deepEqual(h.calls, ["automations", "automations"]);
    assert.ok(h.items.slice(0, 4).every(item => item.visibleByDefault));
  });
  test(`${platform}: native explicit pin/unpin state wins and input state is unchanged`, () => {
    const h = harness(platform, true), items = h.group().exploreDestinations;
    const overrides = Object.freeze({ "builtin:images": true, "builtin:library": false });
    assert.deepEqual(pins(items, overrides), ["builtin:images"]);
    assert.deepEqual(pins(items, { ...overrides, "builtin:images": false, "builtin:skills": true }), ["builtin:skills"]);
    assert.deepEqual(overrides, { "builtin:images": true, "builtin:library": false });
  });
  test(`${platform}: desktop and unavailable matchMedia preserve original grouping and fixed Plugins`, () => {
    for (const options of [{}, { media: false }]) {
      for (const free of [true, false]) {
        const before = harness(platform, false, { ...options, patched: false });
        const after = harness(platform, false, options);
        // 比较分类及默认值，不比较两个夹具各自创建的回调函数身份。
        assert.equal(JSON.stringify(after.group(free)), JSON.stringify(before.group(free)));
        assert.equal(after.rail().customize.id, "fixed-plugins");
      }
    }
  });
  test(`${platform}: unrelated native menu and pin code remains verbatim; patch is idempotent`, () => {
    const sentinel = ';function nativePin(){return "pinOverrides"}function nativeExplore(){return "Explore"}';
    const source = sourceFor(fixtures[platform]) + sentinel;
    const patched = patchMobileNavigationDefaults(source);
    assert.ok(patched.endsWith(sentinel));
    assert.equal(patchMobileNavigationDefaults(patched), patched);
    assert.doesNotThrow(() => new vm.Script(patched));
  });
}
test("partial, mixed, duplicated and changed source contracts fail unchanged", () => {
  const w = fixtures.windows, l = fixtures.linux, valid = sourceFor(w);
  for (const source of [w.grouping, w.grouping + ';({' + l.rail + '})', valid + w.grouping, valid + w.rail, valid.replace('t.rail!==`primary`', 't.rail!==`other`'), valid + sourceFor(l)]) {
    let mismatches = 0;
    assert.equal(patchMobileNavigationDefaults(source, () => mismatches++), source);
    assert.equal(mismatches, 1);
  }
  assert.equal(patchMobileNavigationDefaults("function unrelated(){}"), "function unrelated(){}");
});
test("static pipeline patches Windows/Linux navigation for localhost and remote hosts", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-navigation-"));
  try {
    const service = createStaticAssetService({ officialWebRoot: temp });
    for (const fixture of Object.values(fixtures)) for (const host of ["127.0.0.1:3737", "device.example:3737"]) {
      const result = service.patchOfficialAssetData(`${PATCHED_OFFICIAL_PREFIX}assets/app-initial-test.js`, Buffer.from(sourceFor(fixture)), { headers: { host } });
      assert.ok(result.toString().includes(MOBILE_NAVIGATION_MARKER));
    }
  } finally {
    // 仅清理由本测试创建且仍位于临时根下的目录。
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith("opencodex-navigation-"));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
for (const [platform, env] of [["Windows", "OPENCODEX_NAVIGATION_FIXTURE"], ["Linux", "OPENCODEX_LINUX_NAVIGATION_FIXTURE"]]) {
  test(`${platform} real renderer patch parses and changes only classification plus fixed Plugins prop`, { skip: !process.env[env] }, async () => {
    const source = fs.readFileSync(process.env[env], "utf8");
    let mismatch = false;
    const patched = patchMobileNavigationDefaults(source, () => { mismatch = true; });
    assert.equal(mismatch, false);
    assert.notEqual(patched, source);
    const fixture = fixtures[platform.toLowerCase()];
    const changedFixture = patchMobileNavigationDefaults(sourceFor(fixture));
    const split = changedFixture.indexOf(';function rail(){return{');
    const newGroup = changedFixture.slice(0, split);
    const newRail = changedFixture.slice(split + ';function rail(){return{'.length, -2);
    assert.equal(patched.replace(newGroup, fixture.grouping).replace(newRail, fixture.rail), source);
    // esbuild 仅解析整个真实模块，不解析 import 依赖、不执行 vendor 代码。
    await require("esbuild").transform(patched, { loader: "js", target: "es2022", format: "esm" });
  });
}
