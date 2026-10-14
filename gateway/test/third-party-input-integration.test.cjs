"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");
const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");
const { PATCHED_OFFICIAL_PREFIX } = require("../runtime/core/config.cjs");
const { normalizePluginManifest } = require("../runtime/plugins/manifest.cjs");
const { THIRD_PARTY_INPUT_MARKER } = require("../runtime/http/third-party-input-compat.cjs");

const pointId = "static.cache.renderer.third-party-input-compat";
const assetName = "app-primary-abcdef123456.js";
const fixtureSource = platform => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/third-party-input", platform + ".json"), "utf8"));
  return fixture.imports.join("\n") + "\n" + fixture.atom + "\n" + fixture.component + fixture.next;
};
function harness(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-input-integration-"));
  t.after(() => {
    // 只清理本测试创建的临时目录，并在递归删除前核验边界。
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("opencodex-input-integration-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "assets"));
  const file = path.join(root, "assets", assetName);
  fs.writeFileSync(file, source);
  const compatibility = createCompatibilityService();
  t.after(() => compatibility.dispose());
  const mainReports = [];
  const service = createStaticAssetService({
    compatibilityService: compatibility,
    publishStaticPoint: point => mainReports.push(point),
    getOfficialBundle: () => ({ webviewDir: root }),
    getI18nSnapshot: () => ({ locale: "en-US", messages: {} }),
  });
  mainReports.length = 0;
  const serve = async (reqPath, headers = {}) => {
    const response = {
      status: 0,
      writeHead(status, values) { this.status = status; this.headers = values; },
      end(body) { this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body || "")); },
    };
    const pending = service.serveFile({ headers: { host: "localhost:3737", ...headers } }, response, service.staticFile(reqPath), 200, reqPath);
    const asynchronous = typeof pending?.then === "function";
    if (asynchronous) assert.equal(response.status, 0, "large resource has not been synchronously sent");
    await pending;
    return { ...response, asynchronous };
  };
  return { compatibility, file, mainReports, service, serve };
}

for (const platform of ["windows", "linux"]) {
  test(`${platform} input compatibility is confined to patched responses and revalidates cached output`, async t => {
    const source = fixtureSource(platform);
    const { compatibility, file, serve } = harness(t, source);
    const raw = await serve(`/official/assets/${assetName}`);
    assert.equal(raw.body.toString(), source);
    const url = `${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`;
    const patched = await serve(url);
    assert.equal(patched.status, 200);
    assert.ok(patched.body.toString().includes(THIRD_PARTY_INPUT_MARKER));
    assert.equal(patched.headers["cache-control"], "private, no-cache, must-revalidate");
    const revalidated = await serve(url, { "if-none-match": patched.headers.etag });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body.length, 0);
    assert.equal(fs.readFileSync(file, "utf8"), source, "vendor file is never rewritten");
    assert.ok(compatibility.registry.point(pointId).exercise.hitCount > 0);
  });
}

test("large audited input chunk uses the worker and publishes its successful compatibility result", async t => {
  // 注释填充只用于走真实的大资源分支，不改变已审计的组件字节。
  const source = fixtureSource("windows") + "\n/*" + "x".repeat(520 * 1024) + "*/";
  const { compatibility, file, mainReports, service, serve } = harness(t, source);
  const result = await serve(`${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`);
  assert.equal(result.asynchronous, true);
  assert.ok(result.body.toString().includes(THIRD_PARTY_INPUT_MARKER));
  assert.equal(service.assetCacheDiagnostics().patchRuns, 1);
  const point = compatibility.registry.point(pointId);
  assert.ok(point.exercise.hitCount > 0, "worker hit is visible in the main compatibility registry");
  assert.equal(point.fallback.active, false);
  assert.equal(mainReports.some(point => point.id === pointId), false, "main-thread fallback did not perform the patch");
  assert.equal(fs.readFileSync(file, "utf8"), source);
});

test("large unknown input contract keeps the quota gate and publishes worker fallback diagnostics", async t => {
  const source = fixtureSource("linux").replace("isConfigDataPending", "isConfigUnknown") + "\n/*" + "x".repeat(520 * 1024) + "*/";
  const { compatibility, file, mainReports, serve } = harness(t, source);
  const result = await serve(`${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`);
  assert.equal(result.asynchronous, true);
  assert.equal(result.body.toString(), source);
  const point = compatibility.registry.point(pointId);
  assert.equal(point.fallback.active, true);
  assert.equal(point.fallback.reason, "Official renderer behavior");
  assert.equal(point.location.status, "failed");
  assert.match(JSON.stringify(point), /original quota gate retained/);
  assert.equal(mainReports.some(point => point.id === pointId), false, "failure diagnostics came from the worker");
  assert.equal(fs.readFileSync(file, "utf8"), source);
});

test("a second compatibility registry receives an already-observed worker mismatch", async t => {
  // Worker 会跨静态服务复用，曾报告过的失败也必须传递到新的诊断接收方。
  const source = fixtureSource("linux").replace("isConfigDataPending", "isConfigUnknown") + "\n/*" + "x".repeat(520 * 1024) + "*/";
  for (let index = 0; index < 2; index++) {
    const { compatibility, serve } = harness(t, source);
    const result = await serve(`${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`);
    assert.equal(result.body.toString(), source);
    assert.equal(compatibility.registry.point(pointId).fallback.active, true, `registry ${index + 1} receives fallback state`);
  }
});

test("one worker reports unsupported, supported and unsupported resources independently", async t => {
  const supported = fixtureSource("windows") + "\n/*" + "x".repeat(520 * 1024) + "*/";
  const unsupported = supported.replace("isConfigDataPending", "isConfigUnknown");
  for (const [source, expected] of [[unsupported, false], [supported, true], [unsupported, false]]) {
    const { compatibility, serve } = harness(t, source);
    const result = await serve(`${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`);
    const point = compatibility.registry.point(pointId);
    assert.equal(result.body.includes(THIRD_PARTY_INPUT_MARKER), expected);
    assert.equal(point.fallback.active, !expected);
    assert.equal(point.exercise.hitCount > 0, expected);
    assert.equal(point.location.status, expected ? "resolved" : "failed");
  }
});

test("compatibility page exposes only the normalized default-off input manifest at both entry paths", async t => {
  const { serve } = harness(t, "export const untouched = true;");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../web-shell/plugins/third-party-input-compat/plugin.json"), "utf8"));
  const expected = normalizePluginManifest({ sourceId: "builtin" }, manifest);
  for (const url of ["/opencodex/runtime-compatibility", "/settings/developer/runtime-compatibility"]) {
    const response = await serve(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const html = response.body.toString();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    const bootstrap = scripts.filter(script => script.includes("window.__CODEX_WEB_CONFIG__="));
    assert.equal(bootstrap.length, 1);
    const context = { window: {} };
    vm.runInNewContext(bootstrap[0], context);
    const config = JSON.parse(JSON.stringify(context.window.__CODEX_WEB_CONFIG__));
    assert.deepEqual(config.thirdPartyInputCompatManifest, expected);
    assert.equal(config.thirdPartyInputCompatManifest.defaultEnabled, false);
    assert.equal(config.thirdPartyInputCompatManifest.entry, "");
    assert.equal(config.thirdPartyInputCompatManifest.feature, "");
    assert.deepEqual(Object.keys(config).sort(), ["locale", "localeMode", "localeSource", "messages", "thirdPartyInputCompatManifest"]);
    // 页面使用已有偏好 API，仅加载这一声明；不执行全量插件加载器。
    assert.equal((html.match(/src="\/opencodex-plugin-system\.js"/g) || []).length, 1);
    assert.doesNotMatch(html, /src="[^\"]*plugin-loader/);
    assert.ok(html.indexOf("window.__CODEX_WEB_CONFIG__=") < html.indexOf('src="/opencodex-plugin-system.js"'));
  }
});
