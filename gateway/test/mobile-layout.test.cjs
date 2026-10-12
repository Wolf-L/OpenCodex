const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { transformSync } = require("esbuild");

const css = fs.readFileSync(path.resolve(__dirname, "../../web-shell/codex-mobile-layout.css"), "utf8");

test("phone stylesheet parses for Chromium and Safari and has no unconditional layout rules", () => {
  const result = transformSync(css, { loader: "css", target: ["chrome120", "safari16.4"], minifyWhitespace: true });
  assert.equal(result.warnings.length, 0);
  // 编译器去掉注释后检查顶层规则；字符串中的括号不能改变层级判断。
  let depth = 0;
  let start = 0;
  let quote = "";
  const heads = [];
  for (let i = 0; i < result.code.length; i += 1) {
    const char = result.code[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{") {
      if (depth === 0) heads.push(result.code.slice(start, i).trim());
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) start = i + 1;
    }
  }
  assert.equal(depth, 0);
  assert.equal(heads.length, 2);
  for (const head of heads) {
    assert.match(head, /^@media(?:\s|\()/);
    assert.match(head, /max-width:(767|960)px/);
    assert.match(head, /max-height:500px/);
  }
});

test("closed phone drawer cannot intercept content clicks while native navigation remains interactive", () => {
  assert.match(css, /\[data-app-shell-sidebar-open="false"\] \.app-shell-left-panel\s*\{[^}]*pointer-events: none !important/s);
  assert.match(css, /\[data-app-navigation-rail\]\s*\{[^}]*pointer-events: auto !important/s);
  assert.match(css, /\[data-slate-sidebar-content\]\s*\{[^}]*visibility: hidden !important;[^}]*pointer-events: none !important/s);
  assert.match(css, /\[data-app-shell-sidebar-open="true"\]\[data-app-shell-feature-navigation="true"\] \.app-shell-left-panel\s*\{[^}]*width: 100% !important/s);
  assert.doesNotMatch(css, /_[A-Z][A-Za-z]+_[a-z0-9]{5}_/);
});

test("phone controls keep touch targets, native localized labels and readable editor text", () => {
  assert.match(css, /\[data-app-navigation-rail\] button\s*\{[^}]*min-width: 44px[^}]*min-height: 44px/s);
  assert.match(css, /\[data-codex-composer-root\] button\s*\{[^}]*min-height: 44px/s);
  assert.match(css, /\[data-codex-composer-root\] textarea\s*\{[^}]*font-size: 16px/s);
  assert.match(css, /\[data-app-navigation-rail\] button \.sr-only\s*\{[^}]*position: static/s);
  assert.match(css, /\[data-radix-popper-content-wrapper\]\s*\{[^}]*max-width: calc\(100vw - 16px\)/s);
  assert.match(css, /\.codex-dialog\[aria-modal="true"\] button\s*\{[^}]*min-height: 44px/s);
});

test("phone keyboard layout keeps viewport metrics and does not hide drawer navigation", () => {
  assert.match(css, /height: var\(--opencodex-ios-visual-viewport-height, var\(--codex-visual-viewport-height, 100dvh\)\)/);
  assert.match(css, /html\[data-opencodex-ios-keyboard-visible="true"\]\s*\{[^}]*--opencodex-phone-nav-space: 0px/s);
  assert.doesNotMatch(css, /html\[data-opencodex-mobile-keyboard-visible="true"\] \[data-app-navigation-rail\]/);
  assert.doesNotMatch(css, /:has\([^\n]*:focus\) \[data-app-navigation-rail\]/);
  assert.match(css, /env\(safe-area-inset-bottom, 0px\)/);
  assert.doesNotMatch(css, /touch-action:\s*none|user-scalable|maximum-scale/);
});

test("short phone screens prioritize the composer and keep new-tab space in the header", () => {
  assert.match(css, /width: min\(240px, calc\(100vw - 200px\)\) !important/);
  assert.match(css, /\[class~="group\/home-composer-layout"\] > \.contents > \.pb-24\s*\{[^}]*display: none !important/s);
  // 只收起首页装饰，不通过 display:none 隐藏真实输入框或发送按钮。
  assert.doesNotMatch(css, /(?:^|\n)\s*\[data-codex-composer-root\](?:\s+button)?\s*\{[^}]*display: none/s);
});

test("page sidebars never apply the chat drawer content-hiding rule", () => {
  // 设置侧栏常驻且没有聊天开关；page-sidebar 也被聊天历史复用，必须按设置搜索标记区分。
  const hiddenRules = [...css.matchAll(/([^{}]+)\{([^{}]*visibility:\s*hidden[^{}]*)\}/g)]
    .filter((match) => match[1].includes("[data-app-shell-main-surface]"));
  assert.equal(hiddenRules.length, 1);
  assert.match(hiddenRules[0][1], /:not\(:has\(#settings-search\)\)/);
  assert.match(css, /\[data-app-shell-frame\]:has\(#settings-search\) \[data-app-shell-main-surface\]\s*\{[^}]*visibility: visible;[^}]*margin-top: calc\(var\(--app-shell-titlebar-height\) \+ var\(--opencodex-phone-page-navigation-height\)\)/s);
  assert.doesNotMatch(css, /\[data-app-shell-page-sidebar="true"\]/);
});

test("phone sidebar resizers cannot intercept native navigation or search clicks", () => {
  assert.match(css, /\.app-shell-left-panel \[class~="group\/panel-resizer"\]\s*\{[^}]*display: none !important/s);
  assert.doesNotMatch(css, /\.app-shell-left-panel > div\s*[,\{]/);
  assert.match(css, /\.app-shell-left-panel > div:has\(\[data-app-navigation-rail\]\)/);
});

test("settings keep native horizontally scrollable categories and readable wrapped controls", () => {
  assert.match(css, /--opencodex-phone-page-navigation-height: 112px/);
  assert.match(css, /nav:has\(#settings-search\) > div > div:not\(:has\(#settings-search\)\)\s*\{[^}]*overflow-x: auto;[^}]*overflow-y: hidden/s);
  assert.match(css, /nav:has\(#settings-search\) button\s*\{[^}]*min-height: 44px/s);
  assert.match(css, /> div:has\(> \[class~="group\/nav-list"\]\)\s*\{[^}]*display: contents/s);
  assert.match(css, /#settings-search\s*\{[^}]*font-size: 16px/s);
  assert.match(css, /\[class~="@container\/settings-row"\] > :first-child\s*\{[^}]*flex: 1 1 100%;[^}]*overflow-wrap: anywhere/s);
});

test("compact chat retains the native new-tab or show-tabs control after exiting full view", () => {
  // 同一 main 标记有不同原生动作，不能再全局当成分屏开关隐藏。
  assert.doesNotMatch(css, /\[data-app-shell-workspace-layout-toggle="main"\]\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\[data-app-shell-frame\]:not\(:has\(\[data-app-shell-tab-row\]\)\) \[data-app-shell-workspace-layout-toggle="main"\]::after\s*\{[^}]*content: attr\(aria-label\)/s);
});

test("phone split view uses a full-width native content pane without changing workspace state", () => {
  assert.match(css, /:has\(header \[data-app-shell-tab-row\]\) aside\[data-app-shell-focus-area="right-panel"\]/);
  assert.match(css, /\[data-app-shell-pane-frame\]\s*\{[^}]*width: 100% !important;[^}]*min-width: 0 !important/s);
  assert.match(css, /\[data-app-shell-titlebar-slot="content"\]\s*\{[^}]*inset-inline: 64px 108px !important/s);
  assert.match(css, /calc\(100vw - 244px\)/);
});

// 导航必须留在原生侧栏内，关闭侧栏后不再占用手机底部的聊天空间。
test("phone destinations use vertical drawer rows instead of a fixed bottom bar", () => {
  assert.match(css, /#app-shell-sidebar > div:has\(> \[data-app-navigation-rail\]\)\s*\{[^}]*flex-direction: column !important/s);
  assert.match(css, /button\[aria-haspopup="menu"\]:not\(:has\(\.sr-only\)\) > span:first-child::after/);
  assert.match(css, /\[data-app-navigation-rail\]\s*\{[^}]*position: relative !important;[^}]*flex-direction: column !important/s);
  assert.match(css, /\[data-app-shell-sidebar-open="false"\] \[data-app-navigation-rail\]\s*\{[^}]*display: none !important/s);
  assert.match(css, /--opencodex-phone-nav-space: 0px/);
  assert.doesNotMatch(css, /\[data-app-navigation-rail\]\s*\{[^}]*position: fixed/s);
  assert.match(css, /\[data-opencodex-mobile-promotion="true"\]\s*\{[^}]*display: none !important/s);
  assert.doesNotMatch(css, /aside\[role="status"\]\s*\{[^}]*display: none/s);
});
