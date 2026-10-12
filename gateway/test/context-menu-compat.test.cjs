const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { patchContextMenuCompatibility, PAGE_MENU_MARKER, SIDEBAR_TOUCH_DRAG_FLAG, ASYNC_MENU_MARKER, DOM_TRIGGER_MARKER } = require("../runtime/http/context-menu-compat.cjs");
const { pageMenu, pointerSensor, asyncMenu, menuContextHandler, menuKeyboardHandler, menuTrigger, radixTrigger } = require("./fixtures/context-menu-source.cjs");
const sharedMenu = [asyncMenu, menuContextHandler, menuKeyboardHandler, menuTrigger].join(";");

function pageHarness({ patched = true, native = false, defaultBrowser = false } = {}) {
  const calls = [];
  const page = { id: "page-fixture" };
  const owner = { get(atom) { return atom === "page" ? page : defaultBrowser; } };
  const child = { tag: "page-pill" };
  // 只执行审计过的菜单片段，不加载官方应用或调用真实剪贴板与浏览器。
  const context = { window: { electronBridge: native ? { showContextMenu() {} } : {} }, yQ: "page", uSe: "setting", Td: x => x, c5a: (...args) => calls.push(["open", ...args]), s5a: (...args) => calls.push(["copy", ...args]), jc: "official-menu", X5c: { jsx: (type, props) => ({ type, ...props }) } };
  vm.runInNewContext(`this.render=function(v,t,l,a){${patched ? patchContextMenuCompatibility(pageMenu) : pageMenu}}`, context);
  return { result: context.render(child, [], { id: page.id, blockId: "block-fixture" }, owner), calls, child, owner, page };
}

test("Page reference keeps the original DOM menu, items and callbacks without native bridge", () => {
  const before = pageHarness({ patched: false });
  assert.equal(before.result, before.child);
  const h = pageHarness();
  assert.equal(h.result.type, "official-menu");
  assert.equal(h.result.children, h.child);
  const items = h.result.getItems();
  assert.deepEqual(Array.from(items, item => item.id), ["open-in-external-browser", "copy-page-link"]);
  items.forEach(item => item.onSelect());
  assert.deepEqual(h.calls, [["open", h.owner, h.page, "block-fixture"], ["copy", h.owner, h.page, "block-fixture"]]);
});

test("Page menu retains default-browser filtering and native-host items", () => {
  assert.deepEqual(Array.from(pageHarness({ defaultBrowser: true }).result.getItems(), x => x.id), ["copy-page-link"]);
  for (const defaultBrowser of [false, true]) {
    const before = pageHarness({ patched: false, native: true, defaultBrowser }).result.getItems();
    const after = pageHarness({ native: true, defaultBrowser }).result.getItems();
    assert.equal(JSON.stringify(after), JSON.stringify(before));
  }
});

test("only the explicitly marked sidebar touch event skips the drag sensor", () => {
  const sandbox = { dP: {} };
  vm.runInNewContext(patchContextMenuCompatibility(pointerSensor), sandbox);
  const handler = sandbox.dP.activators[0].handler;
  for (const marked of [false, true]) for (const isPrimary of [false, true]) for (const button of [0, 2]) {
    let activated = 0;
    const nativeEvent = { isPrimary, button, [SIDEBAR_TOUCH_DRAG_FLAG]: marked };
    assert.equal(handler({ nativeEvent }, { onActivation: () => activated++ }), !marked && isPrimary && button === 0);
    assert.equal(activated, Number(!marked && isPrimary && button === 0));
  }
});

test("context patches are idempotent and reject partial, duplicate and changed contracts", () => {
  const input = pageMenu + ";" + pointerSensor + ";" + sharedMenu;
  const patched = patchContextMenuCompatibility(input);
  assert.ok(patched.includes(PAGE_MENU_MARKER));
  assert.equal(patchContextMenuCompatibility(patched), patched);
  for (const source of [pageMenu + pageMenu, pageMenu.replace("getItems:b", "getItems:other"), pointerSensor + pointerSensor, pointerSensor.replace("n.button!==0", "n.button!==1")]) {
    assert.equal(patchContextMenuCompatibility(source), source);
  }
  assert.equal(patchContextMenuCompatibility("function unrelated(){}"), "function unrelated(){}");
  const dom = [menuContextHandler, menuKeyboardHandler, menuTrigger].join(";");
  for (const changed of [dom + menuTrigger, dom.replace("Oe?.(e)", "other?.(e)"), menuTrigger]) {
    assert.equal(patchContextMenuCompatibility(changed), changed);
  }
});

test("async menu ignores descendant blur while preserving cancellation and signal cleanup", () => {
  function harness(patched) {
    let cancelled = 0;
    const listeners = [];
    const context = {
      T: false, b: "contextmenu", u: null, t: null,
      e: new AbortController(), r: new AbortController(),
      o() {}, M() { cancelled++; }, d() {},
      document: { addEventListener(type, fn, options) { listeners.push({ target: "document", type, fn, options }); } },
      window: { addEventListener(type, fn, options) { listeners.push({ target: "window", type, fn, options }); } },
    };
    vm.runInNewContext(patched ? patchContextMenuCompatibility(asyncMenu) : asyncMenu, context);
    return {
      context, get cancelled() { return cancelled; },
      emit(target, type, event = {}, descendant = false) {
        for (const listener of listeners) {
          if (listener.target === target && listener.type === type && !listener.options.signal.aborted && (!descendant || listener.options.capture)) listener.fn(event);
        }
      },
    };
  }
  const before = harness(false);
  before.emit("window", "blur", {}, true);
  assert.equal(before.cancelled, 1);
  const after = harness(true);
  after.emit("window", "blur", {}, true);
  assert.equal(after.cancelled, 0);
  for (const [target, type, event] of [["window", "blur", {}], ["document", "pointerdown", {}], ["document", "contextmenu", {}], ["document", "keydown", { key: "Escape" }]]) {
    const h = harness(true);
    h.emit(target, type, event);
    assert.equal(h.cancelled, 1);
    assert.equal(h.context.e.signal.aborted, true);
  }
  after.context.r.abort();
  after.emit("window", "blur");
  assert.equal(after.cancelled, 0);
});

test("DOM trigger owns pointer events and preserves official handlers and keyboard position", () => {
  const patched = patchContextMenuCompatibility([menuContextHandler, menuKeyboardHandler, menuTrigger].join(";"));
  const calls = [];
  const ctx = { t: [], E: false, T: false, b: "contextmenu", j: null, Pe: { type: "composite-row" },
    De: { props: {} }, Oe: () => calls.push("original"), Ee: () => calls.push("native"), Ce: () => calls.push("open"),
    T7: { jsx: (type, props) => ({ type, props }) }, NMe: "official-radix-trigger", MouseEvent: class { constructor(type, props) { Object.assign(this, { type }, props); } } };
  // 先定义两个原处理器，再让容器通过稳定 Ae 调用键盘处理器。
  const harnessSource = patched.replace(";let r;", ";this.Ae=ke;var r;");
  vm.runInNewContext(harnessSource, ctx);
  assert.equal(ctx.r.type, "official-radix-trigger");
  assert.equal(ctx.r.props.asChild, false);
  assert.equal(ctx.r.props.className, "contents");
  assert.equal(ctx.r.props.children, ctx.Pe);
  assert.ok(Object.hasOwn(ctx.r.props, DOM_TRIGGER_MARKER));
  let stopped = 0;
  const event = { stopPropagation() { stopped++; }, preventDefault() { this.defaultPrevented = true; } };
  ctx.je(event);
  assert.deepEqual(calls, ["original"]);
  assert.equal(stopped, 0);
  ctx.r.props.onContextMenu(event);
  assert.equal(stopped, 1);
  ctx.T = true;
  ctx.je(event);
  assert.deepEqual(calls, ["original", "original", "native"]);
  ctx.T = false;
  const dispatched = [];
  const target = { matches: () => true, getBoundingClientRect: () => ({ left: 12, bottom: 34 }) };
  const currentTarget = { hasAttribute: () => true, dispatchEvent: e => dispatched.push(e) };
  ctx.r.props.onKeyDown({ ...event, key: "F10", shiftKey: true, target, currentTarget });
  assert.equal(dispatched.length, 1);
  assert.deepEqual([dispatched[0].type, dispatched[0].clientX, dispatched[0].clientY], ["contextmenu", 12, 34]);
  ctx.r.props.onKeyDown({ ...event, key: "Enter", target, currentTarget });
  ctx.r.props.onKeyDown({ ...event, key: "F10", shiftKey: true, target: { matches: () => false }, currentTarget });
  assert.equal(dispatched.length, 1);
});

test("original Radix touch handling opens after 700ms and cancels on scroll, release or cancel", () => {
  function harness() {
    const timers = new Map(), opened = [], positions = [];
    let nextId = 0;
    const owner = { open: false, hasInteractedRef: {}, onOpenChange: open => opened.push(open) };
    const context = {
      nb: { useState: initial => [initial, position => positions.push(position)], useMemo: fn => fn(), useRef: current => ({ current }), useCallback: fn => fn, useEffect() {} },
      rb: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" },
      vMe: () => owner, ob: () => ({}), bMe: "ContextMenuTrigger", ib: fn => fn, Gy: "anchor", Kg: { span: "span" },
      window: { clearTimeout: id => timers.delete(id), setTimeout: (fn, delay) => { timers.set(++nextId, { fn, delay }); return nextId; } },
      s_: (first, second) => event => { first?.(event); if (!event.defaultPrevented) second(event); },
      tb: fn => event => event.pointerType === "mouse" ? undefined : fn(event),
    };
    const render = vm.runInNewContext("(" + radixTrigger + ")", context);
    const trigger = render({ asChild: false, className: "contents", children: { type: "composite-row" } }, null).props.children[1];
    return { trigger: trigger.props, timers, opened, positions, fire() { for (const timer of [...timers.values()]) timer.fn(); } };
  }
  const event = { pointerType: "touch", clientX: 20, clientY: 40 };
  const h = harness();
  h.trigger.onPointerDown(event);
  assert.equal([...h.timers.values()][0].delay, 700);
  assert.deepEqual(h.opened, []);
  h.fire();
  assert.deepEqual(h.opened, [true]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.positions)), [{ x: 20, y: 40 }]);
  for (const cancel of ["onPointerMove", "onPointerUp", "onPointerCancel"]) {
    const h = harness();
    h.trigger.onPointerDown(event);
    h.trigger[cancel](event);
    h.fire();
    assert.deepEqual(h.opened, []);
  }
  const mouse = harness();
  mouse.trigger.onPointerDown({ ...event, pointerType: "mouse" });
  assert.equal(mouse.timers.size, 0);
});

test("audited contracts tolerate renamed top-level bindings but not inconsistent references", () => {
  // 不依赖某次压缩的顶层符号；多次使用的 formatter 仍须绑定到同一个函数。
  const renamed = pageMenu.replaceAll("Td", "otherMessage").replaceAll("X5c", "otherJsx").replaceAll("jc", "otherMenu");
  assert.ok(patchContextMenuCompatibility(renamed).includes(PAGE_MENU_MARKER));
  const inconsistent = pageMenu.replace("message:Td", "message:otherMessage");
  assert.equal(patchContextMenuCompatibility(inconsistent), inconsistent);
  const sensor = pointerSensor.replaceAll("dP", "otherSensor");
  assert.ok(patchContextMenuCompatibility(sensor).includes(SIDEBAR_TOUCH_DRAG_FLAG));
});

test("static asset pipeline includes context menu repairs on all hosts", () => {
  const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");
  const { PATCHED_OFFICIAL_PREFIX } = require("../runtime/core/config.cjs");
  const service = createStaticAssetService({ officialWebRoot: __dirname });
  for (const host of ["127.0.0.1:3737", "device.example:3737"]) {
    const result = service.patchOfficialAssetData(`${PATCHED_OFFICIAL_PREFIX}assets/app-initial-test.js`, Buffer.from(pageMenu + ";" + pointerSensor + ";" + sharedMenu), { headers: { host } }).toString();
    assert.ok(result.includes(PAGE_MENU_MARKER));
    assert.ok(result.includes(SIDEBAR_TOUCH_DRAG_FLAG));
    assert.ok(result.includes(ASYNC_MENU_MARKER));
    assert.ok(result.includes(DOM_TRIGGER_MARKER));
  }
});

test("real shared renderer changes only audited menu fragments and parses", { skip: !process.env.OPENCODEX_CONTEXT_MENU_SHARED_FIXTURE }, async () => {
  const source = fs.readFileSync(process.env.OPENCODEX_CONTEXT_MENU_SHARED_FIXTURE, "utf8");
  const patched = patchContextMenuCompatibility(source);
  assert.ok(patched.includes(ASYNC_MENU_MARKER));
  assert.ok(patched.includes(DOM_TRIGGER_MARKER));
  const parts = patchContextMenuCompatibility([menuContextHandler, menuKeyboardHandler, menuTrigger].join("\n")).split("\n");
  let restored = patched.replace(patchContextMenuCompatibility(asyncMenu), asyncMenu);
  [menuContextHandler, menuKeyboardHandler, menuTrigger].forEach((fragment, index) => { restored = restored.replace(parts[index], fragment); });
  assert.equal(restored, source);
  await require("esbuild").transform(patched, { loader: "js", format: "esm", target: "es2022" });
});

test("real renderer changes only the two audited fragments and parses", { skip: !process.env.OPENCODEX_CONTEXT_MENU_FIXTURE }, async () => {
  const source = fs.readFileSync(process.env.OPENCODEX_CONTEXT_MENU_FIXTURE, "utf8");
  const patched = patchContextMenuCompatibility(source);
  assert.notEqual(patched, source);
  assert.equal(patched.replace(patchContextMenuCompatibility(pageMenu), pageMenu).replace(patchContextMenuCompatibility(pointerSensor), pointerSensor), source);
  await require("esbuild").transform(patched, { loader: "js", format: "esm", target: "es2022" });
});
