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
  assert.equal(heads.length, 3);
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

test("phone keyboard layout reuses shared viewport metrics and distinguishes coarse-pointer focus", () => {
  assert.match(css, /height: var\(--opencodex-ios-visual-viewport-height, var\(--codex-visual-viewport-height, 100dvh\)\)/);
  assert.match(css, /html\[data-opencodex-ios-keyboard-visible="true"\]\s*\{[^}]*--opencodex-phone-nav-space: 0px/s);
  assert.match(css, /@media[^\{]*\(pointer: coarse\)/);
  assert.match(css, /html\[data-opencodex-mobile-keyboard-visible="true"\] \[data-app-navigation-rail\]/);
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
