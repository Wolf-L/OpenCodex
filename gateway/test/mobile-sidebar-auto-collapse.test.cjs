const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PLUGIN_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "internal", "providers", "mobile-sidebar-auto-collapse.js"),
  "utf-8"
);

// 只模拟插件实际读取的 DOM 能力，让回归测试聚焦侧栏触摸滚动和收起链路。
function createElement(tagName, initialAttributes = {}) {
  const attributes = new Map(Object.entries(initialAttributes));
  const children = [];
  const element = {
    nodeType: 1,
    parentElement: null,
    disabled: false,
    isConnected: true,
    style: {},
    appendChild(child) {
      child.parentElement = element;
      children.push(child);
      return child;
    },
    contains(candidate) {
      return candidate === element || children.some((child) => child.contains(candidate));
    },
    closest(selector) {
      for (let node = element; node; node = node.parentElement) {
        if (node.matches(selector)) return node;
      }
      return null;
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    matches(selector) {
      if (selector === tagName) return true;
      if (selector === "button") return tagName === "button";
      if (selector === "nav") return tagName === "nav";
      const attributeMatch = /^\[([^=\]]+)\]$/.exec(selector);
      return !!attributeMatch && attributes.has(attributeMatch[1]);
    },
    querySelector(selector) {
      return element.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const matches = [];
      for (const child of children) {
        if (selector === "svg path") {
          if (child.tagName === "path") matches.push(child);
        } else if (child.matches(selector)) {
          matches.push(child);
        }
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    tagName,
  };
  return element;
}

function createHarness(iconPath, promotions = []) {
  const listeners = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  let toggleClickCount = 0;
  let fallbackMessageCount = 0;
  let registeredPlugin = null;
  let promotionObserver = null;

  const panel = createElement("div");
  const scroll = createElement("div", { "data-app-action-sidebar-scroll": "" });
  const newTaskButton = createElement("button");
  const svg = createElement("svg");
  const icon = createElement("path", { d: iconPath });
  const toggleButton = createElement("button", { "data-app-shell-sidebar-trigger": "true" });
  toggleButton.click = () => {
    toggleClickCount += 1;
  };
  panel.appendChild(scroll);
  panel.appendChild(newTaskButton);
  newTaskButton.appendChild(svg);
  svg.appendChild(icon);

  const document = {
    addEventListener(type, handler, capture = false) {
      listeners.set(type, { capture, handler });
    },
    querySelector(selector) {
      if (selector === ".app-shell-left-panel") return panel;
      if (selector === "[data-app-shell-sidebar-trigger]") return toggleButton;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.startsWith("header[data-app-shell-titlebar]")) return promotions;
      return selector === "button" ? [newTaskButton, toggleButton] : [];
    },
    removeEventListener(type, handler) {
      if (listeners.get(type)?.handler === handler) listeners.delete(type);
    },
  };
  const window = {
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    getComputedStyle() {
      return { display: "block", visibility: "visible" };
    },
    location: { origin: "http://localhost" },
    postMessage() {
      fallbackMessageCount += 1;
    },
    setTimeout(callback) {
      const timerId = nextTimerId++;
      timers.set(timerId, callback);
      return timerId;
    },
  };
  window.OpenCodexPluginSystem = {
    registerPlugin(plugin) {
      registeredPlugin = plugin;
    },
  };
  window.__OpenCodexAdapterHost = {
    dom: {
      observe({ callback }) {
        promotionObserver = callback;
        return () => { promotionObserver = null; };
      },
    },
    events: {
      observe({ type, capture = false, callback }) {
        listeners.set(type, { capture, handler: callback });
        return () => {
          if (listeners.get(type)?.handler === callback) listeners.delete(type);
        };
      },
    },
  };
  window.window = window;

  vm.runInNewContext(PLUGIN_SOURCE, { console, document, window });
  const dispose = registeredPlugin.activate({
    events: { on: () => () => {} },
    platform: { isMobile: () => true },
    plugin: { isEnabled: () => true },
    scope: "renderer",
  });

  return {
    notifyMutation() {
      promotionObserver?.();
    },
    clickDestination(target) {
      listeners.get("click").handler({ button: 0, target });
    },
    appendSidebarChild(element) {
      scroll.appendChild(element);
    },
    clickNewTask() {
      listeners.get("click").handler({
        altKey: false,
        button: 0,
        ctrlKey: false,
        defaultPrevented: false,
        metaKey: false,
        shiftKey: false,
        target: icon,
      });
    },
    pointerDown(target, pointerType) {
      let stopped = 0;
      listeners.get("pointerdown").handler({
        pointerType,
        stopPropagation() {
          stopped += 1;
        },
        target,
      });
      return stopped;
    },
    listenerCapture(type) {
      return listeners.get(type)?.capture;
    },
    dispose,
    fallbackMessageCount: () => fallbackMessageCount,
    flushTimers() {
      for (const [timerId, callback] of Array.from(timers)) {
        timers.delete(timerId);
        callback();
      }
    },
    pendingTimerCount: () => timers.size,
    toggleClickCount: () => toggleClickCount,
  };
}

test("mobile sidebar delegates touch styles to the v2 RuntimeView point", () => {
  // 触摸样式属于独立修改点，功能 Provider 只保留会话识别和自动收起行为。
  assert.doesNotMatch(PLUGIN_SOURCE, /createElement\(["']style["']\)|touch-action\s*:/);
});

test("mobile sidebar collapses after clicking new task icons from supported renderer versions", () => {
  // 旧版和当前版图标都必须触发收起，升级官方 renderer 时不能破坏移动端行为。
  for (const iconPath of ["M2.6687 11.333 legacy", "M6.33325 1.88379 current"]) {
    const harness = createHarness(iconPath);
    harness.clickNewTask();
    assert.equal(harness.pendingTimerCount(), 1);
    harness.flushTimers();
    assert.equal(harness.toggleClickCount(), 1);
    assert.equal(harness.fallbackMessageCount(), 0);
    harness.dispose();
  }
});

test("mobile sidebar ignores unrelated sidebar icon buttons", () => {
  const harness = createHarness("M0 0 unrelated");
  harness.clickNewTask();
  assert.equal(harness.pendingTimerCount(), 0);
  assert.equal(harness.toggleClickCount(), 0);
  harness.dispose();
});

test("mobile sidebar keeps touch scrolling out of the official thread drag sensor", () => {
  const harness = createHarness("M0 0 unrelated");
  const threadRow = createElement("div", {
    "data-app-action-sidebar-thread-id": "thread-1",
    "data-app-action-sidebar-thread-kind": "local",
    "data-app-action-sidebar-thread-row": "",
  });
  const unrelated = createElement("div");

  harness.appendSidebarChild(threadRow);
  assert.equal(harness.listenerCapture("pointerdown"), true);
  assert.equal(harness.pointerDown(threadRow, "touch"), 1);
  assert.equal(harness.pointerDown(threadRow, "mouse"), 0);
  assert.equal(harness.pointerDown(unrelated, "touch"), 0);
  harness.dispose();
});

test("mobile promotion markers target only Plus and quota cards and recover when the card becomes an error", () => {
  const plus = createElement("button");
  plus.textContent = "获取 Plus";
  const ordinary = createElement("button");
  ordinary.textContent = "重新登录";
  const quota = createElement("aside");
  const title = createElement("h3");
  title.textContent = "Codex 和工作使用额度已用完";
  quota.appendChild(title);
  const error = createElement("aside");
  const errorTitle = createElement("h3");
  errorTitle.textContent = "无法连接服务";
  error.appendChild(errorTitle);
  const harness = createHarness("M0 unrelated", [plus, ordinary, quota, error]);
  const marker = "data-opencodex-mobile-promotion";
  assert.equal(plus.getAttribute(marker), "true");
  assert.equal(quota.getAttribute(marker), "true");
  assert.equal(ordinary.getAttribute(marker), null);
  assert.equal(error.getAttribute(marker), null);
  // React 可能复用同一 aside：文案变为实际故障后必须立即解除隐藏。
  title.textContent = "认证已过期";
  harness.notifyMutation();
  harness.flushTimers();
  assert.equal(quota.getAttribute(marker), null);
  harness.dispose();
  assert.equal(plus.getAttribute(marker), null);
});

test("mobile destination selection collapses drawer but leaves account and Explore menus open", () => {
  for (const menu of [false, true]) {
    const harness = createHarness("M0 unrelated");
    const button = createElement("button", menu ? { "aria-haspopup": "menu" } : {});
    const target = { closest: (selector) => selector === "[data-app-navigation-rail] button" ? button : null };
    harness.clickDestination(target);
    harness.flushTimers();
    assert.equal(harness.toggleClickCount(), menu ? 0 : 1);
    harness.dispose();
  }
});
