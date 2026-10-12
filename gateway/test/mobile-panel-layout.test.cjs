const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../../web-shell/internal/providers/mobile-sidebar-auto-collapse.js"), "utf8");
const start = source.indexOf("  function createMobilePanelLayout()");
const end = source.indexOf("\n  registerPlugin({", start);
assert.ok(start >= 0 && end > start, "mobile panel helper is available");
const helperSource = source.slice(start, end);

function createHarness() {
  let root;
  let focused = null;

  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.attributes = new Map();
      this.children = [];
      this.parentElement = null;
      this.isConnected = true;
      this.textContent = "";
      this.value = "";
      this.dispatched = [];
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    prepend(child) {
      child.parentElement = this;
      this.children.unshift(child);
      return child;
    }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
      this.isConnected = false;
    }
    contains(candidate) {
      for (let node = candidate; node; node = node.parentElement) if (node === this) return true;
      return false;
    }
    matches(selector) {
      if (selector === "nav:has(#settings-search)") return this.tagName === "nav" && !!this.querySelector("#settings-search");
      if (selector === '[data-radix-popper-content-wrapper] > [role="menu"][style*="--radix-context-menu-content-"]') {
        return this.getAttribute("role") === "menu" && this.parentElement?.getAttribute("data-radix-popper-content-wrapper") !== null && (this.getAttribute("style") || "").includes("--radix-context-menu-content-");
      }
      if (selector === '[data-radix-popper-content-wrapper] > [role="menu"][style*="--radix-dropdown-menu-content-"]') {
        return this.getAttribute("role") === "menu" && this.parentElement?.getAttribute("data-radix-popper-content-wrapper") !== null && (this.getAttribute("style") || "").includes("--radix-dropdown-menu-content-");
      }
      if (selector === '[data-settings-panel-slug], [class~=\'group/nav-list\'] button') {
        return this.getAttribute("data-settings-panel-slug") !== null || (this.tagName === "button" && this.parentElement?.getAttribute("class")?.split(" ").includes("group/nav-list"));
      }
      if (selector === 'button[aria-current="page"]') return this.tagName === "button" && this.getAttribute("aria-current") === "page";
      if (selector === "[data-app-navigation-rail]") return this.getAttribute("data-app-navigation-rail") !== null;
      if (selector === "nav" || selector === "button") return this.tagName === selector;
      if (selector === '[role="menu"]') return this.getAttribute("role") === "menu";
      if (selector === '[role="menuitem"][aria-haspopup="menu"]') return this.getAttribute("role") === "menuitem" && this.getAttribute("aria-haspopup") === "menu";
      if (selector.startsWith("#")) return this.getAttribute("id") === selector.slice(1);
      const attribute = /^\[([^\]]+)\]$/.exec(selector);
      return !!attribute && this.getAttribute(attribute[1]) !== null;
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    querySelectorAll(selector) {
      const found = [];
      for (const child of this.children) {
        if (!child.isConnected) continue;
        if (child.matches(selector)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { focused = this; }
    dispatchEvent(event) { this.dispatched.push(event); return true; }
  }

  root = new Element("html");
  root.lang = "zh-CN";
  const document = {
    documentElement: root,
    createElement: tagName => new Element(tagName),
    querySelector: selector => root.querySelector(selector),
    querySelectorAll: selector => root.querySelectorAll(selector),
    getElementById: id => root.querySelector(`#${id}`),
  };
  class KeyboardEvent {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  }
  const window = { getComputedStyle: () => ({ direction: "ltr" }) };
  const panels = vm.runInNewContext(`const w = window;\n${helperSource}\ncreateMobilePanelLayout()`, { document, KeyboardEvent, window });
  const node = (tag, attrs = {}, parent = root) => {
    const element = new Element(tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    parent.appendChild(element);
    return element;
  };
  const click = target => {
    const event = {
      target,
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    return { handled: panels.click(event), event };
  };
  const keydown = (target, key) => {
    const event = {
      target, key, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    panels.keydown(event);
    return event;
  };
  return { node, root, panels, click, keydown, window, focused: () => focused };
}

function addContextMenu(harness, labelId = null) {
  const wrapper = harness.node("div", { "data-radix-popper-content-wrapper": "" });
  const attrs = { role: "menu", style: "--radix-context-menu-content-transform-origin: center;" };
  if (labelId) attrs["aria-labelledby"] = labelId;
  const menu = harness.node("div", attrs, wrapper);
  const action = harness.node("div", { role: "menuitem" }, menu);
  action.textContent = "Native action";
  return { wrapper, menu, action };
}

test("context submenus keep native actions and delegate Back and Close to Radix keys", () => {
  const harness = createHarness();
  const rootMenu = addContextMenu(harness);
  const project = harness.node("div", { id: "project-trigger", "aria-label": "项目" }, rootMenu.menu);
  const childMenu = addContextMenu(harness, "project-trigger");
  harness.panels.refresh(true);

  assert.equal(rootMenu.menu.children[1], rootMenu.action);
  assert.equal(childMenu.menu.children[1], childMenu.action);
  assert.equal(rootMenu.wrapper.getAttribute("data-opencodex-menu-covered"), "true");
  assert.equal(childMenu.wrapper.getAttribute("data-opencodex-menu-covered"), "false");
  const childBack = childMenu.menu.children[0].children[0];
  const back = harness.click(childBack);
  assert.equal(back.handled, true);
  assert.equal(back.event.prevented, true);
  assert.equal(back.event.stopped, true);
  assert.equal(harness.focused(), childMenu.menu);
  assert.equal(childMenu.menu.dispatched.at(-1).key, "ArrowLeft");
  // 原生返回处理器运行前父菜单已可见，浏览器才能恢复项目触发器焦点。
  assert.equal(rootMenu.wrapper.getAttribute("data-opencodex-menu-covered"), "false");
  harness.panels.refresh(true);
  harness.keydown(childMenu.action, "ArrowLeft");
  assert.equal(rootMenu.wrapper.getAttribute("data-opencodex-menu-covered"), "false");
  harness.panels.refresh(true);
  harness.window.getComputedStyle = () => ({ direction: "rtl" });
  harness.keydown(childMenu.action, "ArrowRight");
  assert.equal(rootMenu.wrapper.getAttribute("data-opencodex-menu-covered"), "false");

  const rootClose = rootMenu.menu.children[0].children[0];
  harness.click(rootClose);
  assert.equal(rootMenu.menu.dispatched.at(-1).key, "Escape");
  harness.panels.dispose();
  assert.equal(rootMenu.menu.children[0], rootMenu.action);
  assert.equal(childMenu.menu.children[0], childMenu.action);
});

test("phone submenu hover cannot replace the click target, while touch and other menus keep their events", () => {
  const harness = createHarness();
  const context = addContextMenu(harness);
  const trigger = harness.node("div", { role: "menuitem", "aria-haspopup": "menu" }, context.menu);
  const unrelated = harness.node("div", { role: "menuitem", "aria-haspopup": "menu" });
  harness.panels.refresh(true);
  const move = (target, pointerType) => {
    const event = { target, pointerType, stopped: false, stopPropagation() { this.stopped = true; } };
    harness.panels.pointermove(event);
    return event.stopped;
  };
  assert.equal(move(trigger, "mouse"), true);
  assert.equal(move(trigger, "touch"), false);
  assert.equal(move(context.action, "mouse"), false);
  assert.equal(move(unrelated, "mouse"), false);
  harness.panels.refresh(false);
  assert.equal(move(trigger, "mouse"), false);
});

test("account dropdown stays separate from context panels and ordinary dropdown is untouched", () => {
  const harness = createHarness();
  const rail = harness.node("div", { "data-app-navigation-rail": "" });
  harness.node("button", { id: "account-button" }, rail);
  harness.node("button", { id: "model-button" });
  const accountWrapper = harness.node("div", { "data-radix-popper-content-wrapper": "" });
  const account = harness.node("div", { role: "menu", style: "--radix-dropdown-menu-content-transform-origin: center;", "aria-labelledby": "account-button" }, accountWrapper);
  const signOut = harness.node("div", { role: "menuitem" }, account);
  const modelWrapper = harness.node("div", { "data-radix-popper-content-wrapper": "" });
  const model = harness.node("div", { role: "menu", style: "--radix-dropdown-menu-content-transform-origin: center;", "aria-labelledby": "model-button" }, modelWrapper);
  const modelItem = harness.node("div", { role: "menuitem" }, model);
  harness.panels.refresh(true);

  assert.equal(accountWrapper.getAttribute("data-opencodex-phone-account-menu"), "true");
  assert.equal(accountWrapper.getAttribute("data-opencodex-phone-menu"), null);
  assert.equal(account.children[0], signOut);
  assert.equal(modelWrapper.getAttribute("data-opencodex-phone-account-menu"), null);
  assert.equal(modelWrapper.getAttribute("data-opencodex-phone-menu"), null);
  assert.equal(model.children[0], modelItem);
  account.setAttribute("data-state", "closed");
  harness.panels.refresh(true);
  assert.equal(accountWrapper.getAttribute("data-opencodex-phone-account-menu"), null);
  harness.panels.dispose();
  assert.equal(account.children[0], signOut);
});

test("settings search reveals native categories, selection and Escape close them", () => {
  const harness = createHarness();
  const nav = harness.node("nav");
  const header = harness.node("div", {}, nav);
  const headerInner = harness.node("div", {}, header);
  const searchRow = harness.node("div", { "data-sidebar-header-search": "" }, headerInner);
  const search = harness.node("input", { id: "settings-search" }, searchRow);
  const categoryGroup = harness.node("div", { class: "group/nav-list" }, nav);
  const category = harness.node("button", { "aria-current": "page", "aria-label": "常规", "data-settings-panel-slug": "general" }, categoryGroup);
  harness.panels.refresh(true);
  const toggle = header.children.at(-1);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(nav.getAttribute("data-opencodex-settings-expanded"), "false");
  assert.match(toggle.textContent, /常规/);

  search.value = "theme";
  harness.panels.refresh(true);
  assert.equal(nav.getAttribute("data-opencodex-settings-expanded"), "true");
  harness.click(category);
  assert.equal(nav.getAttribute("data-opencodex-settings-expanded"), "false");
  harness.click(toggle);
  const outside = harness.node("button");
  assert.equal(harness.keydown(outside, "Escape").prevented, false);
  assert.equal(nav.getAttribute("data-opencodex-settings-expanded"), "true");
  const escape = harness.keydown(category, "Escape");
  assert.equal(escape.prevented, true);
  assert.equal(escape.stopped, true);
  assert.equal(nav.getAttribute("data-opencodex-settings-expanded"), "false");
  assert.equal(harness.focused(), toggle);
  harness.panels.dispose();
  assert.equal(header.children.includes(toggle), false);
  assert.equal(nav.getAttribute("data-opencodex-phone-settings"), null);
});

test("closed, disconnected, and disabled panels release their own markers", () => {
  const harness = createHarness();
  const menu = addContextMenu(harness);
  harness.panels.refresh(true);
  assert.equal(menu.wrapper.getAttribute("data-opencodex-phone-menu"), "true");
  menu.menu.setAttribute("data-state", "closed");
  harness.panels.refresh(true);
  assert.equal(menu.wrapper.getAttribute("data-opencodex-phone-menu"), null);
  assert.equal(menu.menu.children[0], menu.action);

  menu.menu.setAttribute("data-state", "open");
  harness.panels.refresh(true);
  menu.menu.isConnected = false;
  harness.panels.refresh(true);
  assert.equal(menu.wrapper.getAttribute("data-opencodex-phone-menu"), null);

  const second = addContextMenu(harness);
  harness.panels.refresh(true);
  harness.panels.refresh(false);
  assert.equal(second.wrapper.getAttribute("data-opencodex-phone-menu"), null);
  assert.equal(second.menu.children[0], second.action);
});
