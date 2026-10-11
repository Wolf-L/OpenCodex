const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../../web-shell/internal/providers/codex-smart-model-router-settings.js"), "utf8");

test("settings stylesheet falls back to OWL theme colors and keeps phone input sizes", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../../web-shell/codex-smart-model-router-settings.css"), "utf8");
  const { transformSync } = require("esbuild");
  assert.equal(transformSync(css, { loader: "css", target: ["chrome120", "safari16.4"] }).warnings.length, 0);
  // 旧 token 缺失时不落到白底浅字；同时保留旧版主题提供的 token 优先级。
  assert.match(css, /var\(--color-token-main-surface-secondary, var\(--color-background-panel,/);
  assert.match(css, /var\(--color-token-input-background, var\(--color-background-panel,/);
  assert.match(css, /var\(--color-token-input-foreground, var\(--color-text-primary,/);
  assert.match(css, /@media \(max-width: 680px\), \(max-width: 960px\) and \(max-height: 500px\)/);
  assert.match(css, /\.opencodex-router-settings-page button:not\(\[role="switch"\]\)[^{]*\{[^}]*min-height: 44px/s);
  assert.match(css, /\.opencodex-router-tier-prompt\s*\{\s*font-size: 16px/);
});

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, "production helper markers must remain available");
  return source.slice(from, to);
}

function element(rect = {}, selectors = []) {
  const node = {
    nodeType: 1,
    children: [],
    parentElement: null,
    rect: { left: 0, top: 0, width: 0, height: 0, ...rect },
    matches(selector) { return selectors.includes(selector); },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; },
    contains(other) { return other === this || this.children.some((child) => child.contains(other)); },
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]);
    },
    getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; },
    append(...children) { children.forEach((child) => { child.parentElement = this; this.children.push(child); }); return this; },
    get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; },
  };
  return node;
}

function harness({ width = 390, height = 844, mainRect, owl = true } = {}) {
  const root = element();
  const body = element();
  root.append(body);
  const document = { body, documentElement: root };
  const window = { innerWidth: width, innerHeight: height };
  const frame = element({}, owl ? ["[data-app-shell-frame]"] : []);
  const sidebar = element({}, [".app-shell-left-panel"]);
  const nav = element({ left: 0, top: 52, width, height: 112 }, ["nav"]);
  const navigationItem = element();
  const workspace = element();
  const main = element(mainRect || { left: 0, top: 164, width, height: height - 228 }, ["[data-app-shell-main-surface]"]);
  nav.append(navigationItem);
  sidebar.append(nav);
  workspace.append(main);
  frame.append(sidebar, workspace);
  body.append(frame);
  const page = { isConnected: true, style: {}, parentElement: body };
  // 从生产文件取真实辅助函数，在最小 DOM 中验证几何计算，不复制实现或调用远端配置接口。
  const api = vm.runInNewContext(`(() => {
    let active = true;
    ${section("  function clippedContentBounds", "  function suppressOfficialNavigationSelection")}
    ${section("  function nodeTouchesSettings", "  function install()")}
    return { contentBounds, positionPage, mutationsTouchSettings, setActive(value) { active = value; } };
  })()`, { window, document, navigationItem, page });
  return { api, window, document, body, frame, sidebar, nav, workspace, main, page };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("OWL display:contents sibling uses the real main surface within its own frame", () => {
  const h = harness();
  assert.equal(h.workspace.getBoundingClientRect().width, 0);
  assert.deepEqual(plain(h.api.contentBounds(h.nav)), { left: 0, top: 164, width: 390, height: 616 });
});

test("main-surface lookup ignores other and nested app frames", () => {
  const h = harness();
  const other = element({}, ["[data-app-shell-frame]"]).append(element({ left: 50, top: 0, width: 200, height: 800 }, ["[data-app-shell-main-surface]"]));
  h.body.children.unshift(other);
  other.parentElement = h.body;
  const nested = element({}, ["[data-app-shell-frame]"]).append(element({ left: 80, top: 0, width: 200, height: 800 }, ["[data-app-shell-main-surface]"]));
  h.frame.children.unshift(nested);
  nested.parentElement = h.frame;
  assert.deepEqual(plain(h.api.contentBounds(h.nav)), { left: 0, top: 164, width: 390, height: 616 });
  h.main.rect = { left: 0, top: 0, width: 0, height: 0 };
  nested.rect = { left: 80, top: 0, width: 200, height: 800 };
  assert.deepEqual(plain(h.api.contentBounds(h.nav)), { left: 0, top: 164, width: 390, height: 680 });
});

test("320px, 390px and short landscape layouts preserve actual content bounds without 320px minimum", () => {
  for (const [width, height] of [[320, 740], [390, 844], [844, 390]]) {
    const h = harness({ width, height });
    h.api.positionPage();
    assert.deepEqual(h.page.style, { left: "0px", top: "164px", width: `${width}px`, height: `${height - 228}px` });
    assert.ok(parseFloat(h.page.style.top) + parseFloat(h.page.style.height) <= height - 64);
  }
});

test("main bounds are clipped to the viewport rather than overflowing at negative offsets", () => {
  const h = harness({ mainRect: { left: -30, top: -20, width: 500, height: 1000 } });
  h.api.positionPage();
  assert.deepEqual(h.page.style, { left: "0px", top: "0px", width: "390px", height: "844px" });
  h.main.rect = { left: 300, top: 700, width: 300, height: 300 };
  h.api.positionPage();
  assert.deepEqual(h.page.style, { left: "300px", top: "700px", width: "90px", height: "144px" });
});

test("legacy sidebar sibling is retained when it has a real visible box", () => {
  const h = harness({ owl: false, width: 1280, height: 800 });
  h.workspace.rect = { left: 240, top: 52, width: 1040, height: 748 };
  assert.deepEqual(plain(h.api.contentBounds(h.nav)), h.workspace.rect);
});

test("legacy split panels remain discoverable when no main marker or legacy sibling is available", () => {
  const h = harness({ owl: false, width: 1280, height: 800 });
  h.frame.children = [h.sidebar];
  const split = element({ left: 250, top: 40, width: 1030, height: 760 });
  h.frame.append(element(), split);
  assert.deepEqual(plain(h.api.contentBounds(h.nav)), split.rect);
});

test("zero or offscreen content safely falls back below full-width mobile navigation", () => {
  for (const rect of [{ left: 0, top: 0, width: 0, height: 0 }, { left: 500, top: 0, width: 200, height: 800 }]) {
    const h = harness({ mainRect: rect });
    assert.deepEqual(plain(h.api.contentBounds(h.nav)), { left: 0, top: 164, width: 390, height: 680 });
    h.nav.rect.height = 900;
    h.api.positionPage();
    assert.deepEqual(h.page.style, { left: "0px", top: "844px", width: "390px", height: "0px" });
  }
});

test("zero legacy content preserves the desktop navigation-right fallback", () => {
  const h = harness({ owl: false, width: 1280, height: 800 });
  h.nav.rect = { left: 0, top: 0, width: 240, height: 800 };
  assert.deepEqual(plain(h.api.contentBounds(h.nav)), { left: 240, top: 0, width: 1040, height: 800 });
});

test("layout mutation filtering handles same-frame geometry and keyboard state without watching unrelated content", () => {
  const h = harness();
  const change = (target, attributeName = "style") => h.api.mutationsTouchSettings([{ type: "attributes", target, attributeName }]);
  assert.equal(change(h.frame), true);
  assert.equal(change(h.sidebar, "class"), true);
  assert.equal(change(h.nav), true);
  assert.equal(change(h.main), true);
  assert.equal(change(h.document.documentElement, "data-opencodex-mobile-keyboard-visible"), true);
  assert.equal(change(h.document.documentElement, "data-opencodex-ios-keyboard-visible"), true);
  assert.equal(change(h.document.documentElement), false);
  const content = element();
  h.main.append(content);
  assert.equal(change(content), false);
  assert.equal(change(element()), false);
  h.api.setActive(false);
  assert.equal(change(h.frame), false);
});

test("viewport and layout updates reuse the managed observer and animation-frame scheduler", () => {
  assert.match(source, /type: "resize", callback: \(\) => \{\s*if \(active\) scheduleSync\(\)/);
  assert.match(source, /target: window\.visualViewport, type: "resize"/);
  assert.match(source, /attributeFilter: \["class", "style", "data-app-shell-sidebar-open", "data-app-shell-page-sidebar"/);
  assert.doesNotMatch(source, /new (?:MutationObserver|ResizeObserver)/);
});
