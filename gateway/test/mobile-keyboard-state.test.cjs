const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../../web-shell/internal/providers/mobile-keyboard-optimization.js"), "utf8");

function createHarness({ ios = false } = {}) {
  const listeners = new Map();
  const events = new Map();
  const properties = new Map();
  const styles = [];
  let plugin;
  let callback;
  let hook;
  let enabled = true;
  let unsubscriptions = 0;
  let hookDisposals = 0;
  let snapshot = { visualHeight: 800, visualBottom: 800, layoutHeight: 800, innerHeight: 800, layoutWidth: 390, offsetTop: 0, scale: 1 };
  const root = {
    clientWidth: 390,
    dataset: {},
    style: {
      getPropertyValue: (name) => properties.get(name) || "",
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
    },
    removeAttribute(name) {
      delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
    },
  };
  const document = {
    documentElement: root,
    body: {},
    activeElement: null,
    createElement: () => ({}),
    head: {
      appendChild(style) { styles.push(style); style.parentNode = this; },
      removeChild(style) { styles.splice(styles.indexOf(style), 1); style.parentNode = null; },
    },
  };
  const input = {
    nodeType: 1,
    tagName: "INPUT",
    type: "text",
    matches: () => true,
    closest() { return this; },
    getBoundingClientRect: () => ({ top: 20, bottom: 60 }),
  };
  // 注入既有共享协调器，执行生产插件的订阅逻辑，不创建真实 DOM、定时器或 IPC。
  const coordinator = {
    snapshot: () => snapshot,
    request(reason) { callback?.(snapshot, reason); },
    subscribe(subscriber) { callback = subscriber; subscriber(snapshot, "subscribe"); return () => { callback = null; unsubscriptions += 1; }; },
  };
  const window = {
    __OpenCodexViewportCoordinator: coordinator,
    __OpenCodexViewportCoordinatorGeneration: document,
    OpenCodexPluginSystem: { registerPlugin(value) { plugin = value; } },
    navigator: ios ? { userAgent: "iPhone AppleWebKit", platform: "iPhone", maxTouchPoints: 5 } : { userAgent: "Android", maxTouchPoints: 5 },
    innerWidth: 390,
    HTMLElement: { prototype: { focus() {} } },
    scrollBy() {},
    __OpenCodexAdapterHost: {
      events: { observe({ type, callback: handler }) { listeners.set(type, handler); return () => listeners.delete(type); } },
      hooks: { around(value) { hook = value; return () => { hookDisposals += 1; }; } },
    },
  };
  vm.runInNewContext(source, { window, document, console });
  const dispose = plugin.activate({
    scope: "renderer",
    platform: { isMobile: () => true },
    plugin: { id: plugin.id, isEnabled: () => enabled },
    events: { on(type, handler) { events.set(type, handler); return () => events.delete(type); } },
  });
  return {
    document, root, input, styles, listeners, events, dispose,
    get hook() { return hook; },
    get cleanup() { return { unsubscriptions, hookDisposals }; },
    get visible() { return root.dataset.opencodexMobileKeyboardVisible; },
    focus() { document.activeElement = input; },
    emit(update = {}, reason = "viewport") { snapshot = { ...snapshot, ...update }; callback?.(snapshot, reason); },
    enabled(value) { enabled = value; events.get("plugin:enabled-changed")?.({ id: plugin.id }); },
  };
}

function resizedHeight(height) {
  return { visualHeight: height, visualBottom: height, layoutHeight: height, innerHeight: height };
}

test("touch or hardware-keyboard focus alone and browser toolbar changes do not imply a software keyboard", () => {
  const h = createHarness();
  assert.equal(h.visible, "false");
  h.focus();
  h.emit({}, "focusin");
  assert.equal(h.visible, "false");
  h.emit(resizedHeight(730));
  assert.equal(h.visible, "false");
  h.emit(resizedHeight(680));
  assert.equal(h.visible, "false", "the 120px boundary remains below the keyboard threshold");
  h.dispose();
});

test("focused editable with a keyboard inset reports visible and blur clears it immediately", () => {
  const h = createHarness();
  h.focus();
  h.emit({ visualHeight: 500, visualBottom: 500 });
  assert.equal(h.visible, "true");
  // focusout 同步回调时浏览器的 activeElement 可能尚未切换，也必须先清除可见状态。
  h.emit({}, "focusout");
  assert.equal(h.visible, "false");
  h.document.activeElement = h.document.body;
  h.emit({}, "focusout:settle");
  assert.equal(h.visible, "false");
  h.dispose();
});

test("Android resizes-content compares against the prior height even when all viewport heights shrink", () => {
  const h = createHarness();
  h.focus();
  h.emit(resizedHeight(500));
  assert.equal(h.visible, "true");
  assert.equal(h.root.style.getPropertyValue("--codex-keyboard-inset-bottom"), "0px");
  h.emit(resizedHeight(800));
  assert.equal(h.visible, "false");
  h.dispose();
});

test("width changes and orientation changes discard the old direction's height baseline", () => {
  for (const reason of ["viewport", "orientationchange"]) {
    const h = createHarness();
    h.focus();
    h.emit(resizedHeight(500));
    assert.equal(h.visible, "true");
    // 旋转首帧根节点可能还保留旧 CSS 高度；下一帧才会完成根节点布局更新。
    h.emit({ ...resizedHeight(390), layoutHeight: 800, ...(reason === "viewport" ? { layoutWidth: 800 } : {}) }, reason);
    assert.equal(h.visible, "false");
    h.emit(resizedHeight(390), `${reason}:settle`);
    assert.equal(h.visible, "false");
    h.dispose();
  }
});

test("pinch zoom changes are not keyboard visibility and do not corrupt the unzoomed height baseline", () => {
  const h = createHarness();
  h.focus();
  h.emit({ visualHeight: 400, visualBottom: 400, scale: 2 });
  assert.equal(h.visible, "false");
  h.emit({ ...resizedHeight(800), scale: 1 });
  assert.equal(h.visible, "false");
  h.emit(resizedHeight(500));
  assert.equal(h.visible, "true");
  h.dispose();
});

test("non-editable controls and iOS do not claim the generic mobile keyboard flag", () => {
  for (const attributes of [{ readOnly: true }, { disabled: true }, { type: "checkbox" }, { inputMode: "none" }]) {
    const h = createHarness();
    Object.assign(h.input, attributes);
    h.focus();
    h.emit(resizedHeight(500));
    assert.equal(h.visible, "false");
    h.dispose();
  }
  const ios = createHarness({ ios: true });
  ios.focus();
  ios.emit({ visualHeight: 400, visualBottom: 400 });
  assert.equal(ios.visible, "false");
  assert.equal(ios.root.dataset.opencodexIosKeyboardOptimization, "true");
  ios.dispose();
});

test("disabling or disposing clears visibility and height baselines with no leaked listeners", () => {
  const h = createHarness();
  h.focus();
  h.emit(resizedHeight(500));
  assert.equal(h.visible, "true");
  h.enabled(false);
  assert.equal(h.visible, "false");
  assert.equal(h.root.style.getPropertyValue("--codex-visual-viewport-height"), "");
  h.enabled(true);
  assert.equal(h.visible, "false", "re-enabled plugin starts with a fresh baseline");
  h.emit(resizedHeight(800));
  h.emit(resizedHeight(500));
  assert.equal(h.visible, "true");
  h.dispose();
  assert.equal(h.visible, undefined);
  assert.deepEqual(h.root.dataset, {});
  assert.equal(h.root.style.getPropertyValue("--codex-visual-viewport-height"), "");
  assert.equal(h.styles.length, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.events.size, 0);
  assert.deepEqual(h.cleanup, { unsubscriptions: 1, hookDisposals: 1 });
});

test("pinch suppression listeners are absent while manual focus and post-send focus hooks remain", () => {
  const h = createHarness();
  assert.deepEqual([...h.listeners.keys()], ["pointerdown", "touchstart"]);
  assert.match(h.styles[0].textContent, /touch-action:\s*pan-x pan-y pinch-zoom/);
  assert.doesNotMatch(source, /preventZoomGesture|type:\s*"(?:gesturestart|gesturechange|touchmove)"/);
  let proceeded = 0;
  h.events.get("ipc:invoke")({ channel: "turn:start" });
  h.hook.handle(h.input, [], () => { proceeded += 1; });
  assert.equal(proceeded, 0);
  h.listeners.get("pointerdown")({ target: h.input });
  h.hook.handle(h.input, [], () => { proceeded += 1; });
  assert.equal(proceeded, 1);
  h.dispose();
});
