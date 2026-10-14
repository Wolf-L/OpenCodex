const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { normalizePluginManifest } = require("../runtime/plugins/manifest.cjs");
const { runtimeSource } = require("../runtime/http/third-party-input-compat.cjs");

const WEB_ROOT = path.resolve(__dirname, "../../web-shell");
const PAGE_SCRIPT = fs.readFileSync(path.join(WEB_ROOT, "runtime-compatibility.js"), "utf8");
const PLUGIN_SCRIPT = fs.readFileSync(path.join(WEB_ROOT, "opencodex-plugin-system.js"), "utf8");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "plugins/third-party-input-compat/plugin.json"), "utf8"));
const PLUGIN_ID = "opencodex.third-party-input-compat";
const ENABLE_KEY = `plugin.${PLUGIN_ID}.enabled`;
const SETTINGS_KEY = "opencodex_web_settings_v1";

class FakeElement {
  constructor() {
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.checked = false;
    this.disabled = false;
    this.textContent = "";
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  dispatch(type) { this.listeners.get(type)?.({ currentTarget: this, target: this }); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || ""; }
  removeAttribute(name) { this.attributes.delete(name); }
  replaceChildren() {}
  append() {}
}

function createHarness(options = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const storage = new Map([["opencodex_runtime_compatibility_auto_refresh", "disabled"]]);
  if (options.preferences) storage.set(SETTINGS_KEY, JSON.stringify(options.preferences));
  const writes = [];
  const requests = [];
  const registered = [];
  const windowListeners = new Map();
  const document = {
    documentElement: {},
    visibilityState: "visible",
    getElementById: element,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => new FakeElement(),
  };
  const manifest = Object.hasOwn(options, "manifest") ? options.manifest : normalizePluginManifest({ sourceId: "builtin" }, MANIFEST);
  const window = {
    __CODEX_WEB_CONFIG__: {
      locale: "zh-CN",
      messages: options.messages || {},
      thirdPartyInputCompatManifest: manifest,
      plugins: [{ id: "unrelated", activate() { throw new Error("must not execute"); } }],
    },
    addEventListener(type, callback) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { windowListeners.get(type)?.delete(callback); },
  };
  const context = vm.createContext({
    console, document, window,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem(key, value) {
        if (options.storageUnavailable) throw new Error("storage denied");
        writes.push([key, value]);
        storage.set(key, String(value));
      },
    },
    fetch: async (url, init) => {
      requests.push({ url, init });
      throw new Error("diagnostics offline");
    },
    history: { length: 1, back() {} },
    location: { assign() {} },
    setTimeout: () => 1,
    clearTimeout() {},
  });
  if (!options.missingSystem) {
    // 使用真实插件持久化代码，避免只验证一个行为过于宽松的测试替身。
    vm.runInContext(PLUGIN_SCRIPT, context, { filename: "opencodex-plugin-system.js" });
    const original = window.OpenCodexPluginSystem;
    window.OpenCodexPluginSystem = {
      ...original,
      registerPlugin(value) {
        registered.push(value);
        return original.registerPlugin(value);
      },
    };
    if (options.configureSystem) options.configureSystem(window.OpenCodexPluginSystem);
  }
  vm.runInContext(PAGE_SCRIPT, context, { filename: "runtime-compatibility.js" });
  return {
    element, storage, writes, requests, registered, window, context,
    toggle: element("thirdPartyInputToggle"),
    status: element("thirdPartyInputStatus"),
    emit(type, event = {}) {
      for (const handler of windowListeners.get(type) || []) handler(event);
    },
    listenerCount: (type) => windowListeners.get(type)?.size || 0,
  };
}

test("third-party input manifest is declarative, browser-scoped and default-off", () => {
  assert.equal(MANIFEST.id, PLUGIN_ID);
  assert.equal(MANIFEST.defaultEnabled, false);
  assert.equal(MANIFEST.persistence, "browser");
  assert.equal(MANIFEST.surface, "renderer");
  assert.equal(MANIFEST.entry, undefined);
  assert.equal(MANIFEST.feature, undefined);
  assert.equal(MANIFEST.enableStorageKey, undefined);
  assert.equal(MANIFEST.labelKey, "plugin.thirdPartyInputCompat.label");
  assert.equal(MANIFEST.descKey, "plugin.thirdPartyInputCompat.desc");
});

test("visiting diagnostics registers only the supplied plugin without enabling or writing settings", () => {
  const page = createHarness();
  assert.equal(page.toggle.checked, false);
  assert.equal(page.toggle.disabled, false);
  assert.equal(page.status.textContent, "已关闭");
  assert.equal(page.registered.length, 1);
  assert.equal(page.registered[0].id, PLUGIN_ID);
  assert.equal(page.registered[0].activate, undefined);
  assert.equal(page.registered[0].settings, undefined);
  assert.equal(page.writes.length, 0);
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, "/api/opencodex/runtime-compatibility");
});

test("explicit switch changes persist through the plugin API and retain unrelated preferences", () => {
  const unrelated = { theme: "dark", otherPlugin: false, nested: { keep: "unchanged" } };
  const page = createHarness({ preferences: unrelated });
  page.toggle.checked = true;
  page.toggle.dispatch("change");
  assert.equal(page.status.textContent, "已开启");
  assert.deepEqual(JSON.parse(page.storage.get(SETTINGS_KEY)), { ...unrelated, [ENABLE_KEY]: true });
  assert.equal(page.writes.length, 1);
  assert.equal(page.writes[0][0], SETTINGS_KEY);
  assert.equal(page.requests.length, 1, "switch must not send a configuration or rate-limit request");

  const restored = createHarness({ preferences: JSON.parse(page.storage.get(SETTINGS_KEY)) });
  assert.equal(restored.toggle.checked, true);
  assert.equal(restored.writes.length, 0);
  page.toggle.checked = false;
  page.toggle.dispatch("change");
  assert.equal(page.status.textContent, "已关闭");
  assert.deepEqual(JSON.parse(page.storage.get(SETTINGS_KEY)), { ...unrelated, [ENABLE_KEY]: false });
});

test("UI and injected runtime require literal true through the actual plugin preference store", () => {
  for (const value of [null, 0, 1, "false", "true", {}, [], false, true]) {
    const page = createHarness({ preferences: { [ENABLE_KEY]: value } });
    vm.runInContext(runtimeSource(), page.context);
    assert.equal(page.toggle.checked, value === true);
    assert.equal(page.context.opencodexThirdPartyInputEnabled(), value === true);
    assert.equal(page.writes.length, 0, "malformed stored values are not silently repaired or enabled");
  }
});

const malformedManifests = [
  ["missing", null],
  ["array", []],
  ["wrong identity", { ...MANIFEST, id: "another.plugin" }],
  ["default on", { ...MANIFEST, defaultEnabled: true }],
  ["missing default", { ...MANIFEST, defaultEnabled: undefined }],
  ["platform default", { ...MANIFEST, defaultEnabledPolicy: "ios-webkit" }],
  ["gateway persistence", { ...MANIFEST, persistence: "gateway" }],
  ["wrong surface", { ...MANIFEST, surface: "gateway" }],
  ["unrelated storage", { ...MANIFEST, enableStorageKey: "theme" }],
  ["executable entry", { ...MANIFEST, entry: "other.js" }],
  ["core feature", { ...MANIFEST, feature: "smart-model-router" }],
  ["executable hook", { ...MANIFEST, activate() {} }],
  ["extra settings", { ...MANIFEST, settings: [{ id: "theme", defaultValue: "bad" }] }],
];
for (const [label, manifest] of malformedManifests) {
  test(`malformed third-party manifest fails closed: ${label}`, () => {
    const page = createHarness({ manifest, preferences: { [ENABLE_KEY]: true } });
    assert.equal(page.toggle.disabled, true);
    assert.equal(page.toggle.checked, false);
    assert.equal(page.status.textContent, "当前版本不可用");
    assert.equal(page.registered.length, 0);
    page.toggle.checked = true;
    page.toggle.dispatch("change");
    assert.equal(page.toggle.checked, false);
    assert.equal(page.writes.length, 0);
  });
}

test("missing or incomplete plugin system leaves control unavailable", () => {
  for (const options of [
    { missingSystem: true },
    { configureSystem(system) { system.plugins = {}; } },
    { configureSystem(system) { system.events = {}; } },
    { configureSystem(system) { system.preferences = {}; } },
    { configureSystem(system) { system.registerPlugin = () => { throw new Error("broken system"); }; } },
  ]) {
    const page = createHarness(options);
    assert.equal(page.toggle.disabled, true);
    assert.equal(page.toggle.checked, false);
    assert.equal(page.status.textContent, "当前版本不可用");
    assert.equal(page.writes.length, 0);
  }
});

test("plugin events and cross-tab storage changes resynchronize the switch", () => {
  const page = createHarness();
  page.window.OpenCodexPluginSystem.plugins.setEnabled(PLUGIN_ID, true);
  assert.equal(page.toggle.checked, true);
  page.storage.set(SETTINGS_KEY, JSON.stringify({ [ENABLE_KEY]: false }));
  page.emit("storage", { key: SETTINGS_KEY });
  assert.equal(page.toggle.checked, false);
  page.storage.set(SETTINGS_KEY, JSON.stringify({ [ENABLE_KEY]: true }));
  page.emit("storage", { key: "unrelated" });
  assert.equal(page.toggle.checked, false);
  page.emit("storage", { key: null });
  assert.equal(page.toggle.checked, true);
  assert.equal(page.writes.length, 1, "resync only reads preferences");
});

test("failed persistence never displays a false saved-enabled state", () => {
  const page = createHarness({ storageUnavailable: true });
  page.toggle.checked = true;
  page.toggle.dispatch("change");
  assert.equal(page.toggle.checked, false);
  assert.equal(page.status.textContent, "已关闭");
  assert.equal(page.writes.length, 0);
});

test("control status uses supplied translations", () => {
  const page = createHarness({ messages: {
    "web.runtimeCompatibility.thirdPartyInput.disabled": "Off",
    "web.runtimeCompatibility.thirdPartyInput.enabled": "On",
  } });
  assert.equal(page.status.textContent, "Off");
  page.toggle.checked = true;
  page.toggle.dispatch("change");
  assert.equal(page.status.textContent, "On");
});

test("pagehide cleanup preserves back-forward cache listeners and releases ordinary navigation listeners", () => {
  const page = createHarness();
  page.emit("pagehide", { persisted: true });
  assert.equal(page.listenerCount("storage"), 1);
  page.emit("pagehide", { persisted: false });
  assert.equal(page.listenerCount("storage"), 0);
  page.window.OpenCodexPluginSystem.plugins.setEnabled(PLUGIN_ID, true);
  assert.equal(page.toggle.checked, false, "plugin listener is removed after leaving the page");
});

test("markup supplies accessible default-disabled switch and loads only plugin system before page script", () => {
  const html = fs.readFileSync(path.join(WEB_ROOT, "runtime-compatibility.html"), "utf8");
  const input = html.match(/<input id="thirdPartyInputToggle"[^>]+>/)?.[0];
  assert.ok(input);
  assert.match(input, /role="switch"/);
  assert.match(input, /\sdisabled\s/);
  assert.match(input, /aria-labelledby="thirdPartyInputTitle"/);
  assert.match(input, /aria-describedby="thirdPartyInputDescription thirdPartyInputScope thirdPartyInputStatus"/);
  assert.doesNotMatch(input, /\schecked(?:\s|=|\/|>)/);
  assert.equal(html.match(/src="\/opencodex-plugin-system\.js"/g)?.length, 1);
  assert.ok(html.indexOf("/opencodex-plugin-system.js") < html.indexOf("/opencodex/runtime-compatibility.js"));
  assert.doesNotMatch(html, /src="[^"]*plugin-loader/);
});
