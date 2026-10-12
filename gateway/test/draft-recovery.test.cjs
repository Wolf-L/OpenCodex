const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../../web-shell/internal/providers/codex-draft-recovery.js"), "utf8");
const KEY = "opencodex.text-drafts.v1";

function harness({ storage = new Map(), blocked = false, now = 1_800_000_000_000 } = {}) {
  const events = [], owned = [], timers = new Map(), nodes = [];
  let id = 0, clock = now, writes = 0, hits = 0, observation = null;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.value = ""; nodes.push(this); }
    appendChild(node) { this.children.push(node); }
    replaceChildren() { this.children = []; }
    setAttribute(key, value) { this.attrs[key] = value; }
    remove() { this.removed = true; }
    focus() { this.focused = true; }
    select() { this.selected = true; }
  }
  const document = { body: new Element("body"), head: new Element("head"), visibilityState: "visible", createElement: (tag) => new Element(tag) };
  const w = {
    location: { pathname: "/", search: "?token=secret", hash: "#secret" }, navigator: {},
    __OpenCodexCurrentProviderScope: { own(fn) { owned.push(fn); }, effects: { primary: { emit() { hits += 1; } } } },
    __CODEX_WEB_CONFIG__: { locale: "zh-CN" }, __OpenCodexConnectionState: { state: "connected" },
    sessionStorage: {
      getItem(key) { if (blocked) throw Error("blocked"); return storage.get(key) || null; },
      setItem(key, value) { if (blocked) throw Error("quota"); writes += 1; storage.set(key, value); },
      removeItem(key) { if (blocked) throw Error("blocked"); storage.delete(key); },
    },
    __OpenCodexAdapterHost: {
      dom: { observe(value) { observation = value; return () => { observation = null; }; } },
      events: { observe(value) { events.push(value); } },
      scheduler: { capture: () => ({ setTimeout(fn) { const key = ++id; timers.set(key, fn); return key; }, clearTimeout(key) { timers.delete(key); } }) },
    },
    dispatchEvent(event) { emit(w, event.type, event); },
  };
  function emit(target, type, event = {}) { for (const entry of events) if (entry.target === target && entry.type === type) entry.callback(event); }
  class Clock extends Date { static now() { return clock; } }
  vm.runInNewContext(source, { window: w, document, Date: Clock, CustomEvent: class { constructor(type) { this.type = type; } } });
  const node = (tag) => nodes.find((item) => item.tagName === tag);
  return {
    w, document, storage, timers, nodes, node,
    get writes() { return writes; }, get hits() { return hits; },
    get observation() { return observation; },
    records() { return JSON.parse(storage.get(KEY) || '{"entries":[]}').entries; },
    editor(text = "") { return { innerText: text, closest(selector) { assert.equal(selector, '[data-codex-composer="true"][contenteditable="true"]'); return this; } }; },
    input(editor, isComposing = false) { emit(document, "input", { target: editor, isComposing }); },
    emit, flush() { for (const [key, fn] of [...timers]) { timers.delete(key); fn(); } },
    tick(ms = 1) { clock += ms; },
    open() { node("details").open = true; emit(node("details"), "toggle"); },
    dispose() { for (const fn of owned.reverse()) fn(); },
  };
}

test("trusted composer text survives refresh; no automatic editor restore or network transmission", () => {
  const h = harness(), editor = h.editor("第一行\n第二行"); h.input(editor); h.flush();
  assert.equal(h.records()[0].text, editor.innerText); assert.equal(h.hits, 1);
  const reloaded = harness({ storage: h.storage }); reloaded.open();
  assert.equal(reloaded.node("textarea").value, editor.innerText);
  assert.equal(reloaded.node("textarea").readOnly, true);
  assert.equal(reloaded.hits, 0);
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|localStorage|execCommand|innerHTML\s*=/);
});

test("password/settings/search inputs are never captured", () => {
  const h = harness(); h.input({ innerText: "password", closest() { return null; } }); h.flush();
  assert.equal(h.writes, 0); assert.equal(h.records().length, 0);
});

test("rapid input has one pending write, while pagehide synchronously saves latest memory copy", () => {
  const h = harness(), editor = h.editor();
  for (let i = 0; i < 100; i++) { editor.innerText = `draft ${i}`; h.input(editor); }
  assert.equal(h.timers.size, 1); assert.equal(h.writes, 0);
  h.emit(h.w, "pagehide"); assert.equal(h.records()[0].text, "draft 99"); assert.equal(h.timers.size, 0);
});

test("IME intermediate text is ignored and committed text is captured once", () => {
  const h = harness(), editor = h.editor("ni");
  h.emit(h.document, "compositionstart", { target: editor }); h.input(editor); h.flush();
  assert.equal(h.writes, 0);
  editor.innerText = "你好"; h.emit(h.document, "compositionend", { target: editor }); h.input(editor); h.flush();
  assert.equal(h.records()[0].text, "你好"); assert.equal(h.hits, 1);
});

test("route changes and multiple composers do not overwrite one another; no query/hash saved", () => {
  const h = harness(), editor = h.editor("first"); h.input(editor); h.tick();
  h.w.location.pathname = "/thread/second"; editor.innerText = "second"; h.input(editor); h.tick();
  h.input(h.editor("other pane")); h.flush();
  assert.equal(h.records().length, 3);
  assert.doesNotMatch(h.storage.get(KEY), /secret|token/);
});

test("clearing composer keeps uncertain-send backup; explicit clearing cancels pending writes", () => {
  const h = harness(), editor = h.editor("possibly sent"); h.input(editor);
  editor.innerText = ""; h.input(editor); h.flush(); assert.equal(h.records().length, 1);
  editor.innerText = "new draft"; h.tick(); h.input(editor); h.flush(); assert.equal(h.records().length, 2);
  h.emit(h.w, "opencodex:clear-drafts"); h.flush(); h.dispose();
  assert.equal(h.records().length, 0); assert.equal(h.storage.has(KEY), false);
});

test("maximum copies, TTL, oversize and corrupt storage are bounded", () => {
  const h = harness();
  for (let i = 0; i < 20; i++) { h.input(h.editor(`draft ${i}`)); h.tick(); }
  h.flush(); assert.equal(h.records().length, 8); assert.equal(h.records()[0].text, "draft 19");
  h.input(h.editor("x".repeat(32769))); h.flush(); assert.equal(h.records().length, 8);
  assert.equal(h.nodes.some((n) => n.textContent?.includes("超过 32K")), true);
  const expired = harness({ storage: h.storage, now: 1_800_000_000_000 + 86_400_100 }); expired.open();
  assert.equal(expired.node("textarea").value, "");
  assert.doesNotThrow(() => harness({ storage: new Map([[KEY, "{broken"]]) }));
});

test("blocked storage reports failure rather than claiming refresh protection", () => {
  const h = harness({ blocked: true }); h.input(h.editor("memory only")); h.flush(); h.open();
  assert.equal(h.records().length, 0); assert.equal(h.node("textarea").value, "memory only");
  assert.ok(h.nodes.some((n) => n.textContent?.includes("刷新可能丢失")));
});

test("hidden lifecycle flushes pending draft and disposal removes UI/timers", () => {
  const h = harness(); h.input(h.editor("background")); h.document.visibilityState = "hidden";
  h.emit(h.document, "visibilitychange"); assert.equal(h.records()[0].text, "background");
  h.dispose(); assert.equal(h.timers.size, 0); assert.equal(h.node("aside").removed, true);
});

test("plain-text preview never interprets stored HTML and unsupported schema is ignored", () => {
  const h = harness(); const text = '<img src=x onerror="alert(1)">'; h.input(h.editor(text)); h.flush(); h.open();
  assert.equal(h.node("textarea").value, text);
  const invalid = harness({ storage: new Map([[KEY, JSON.stringify({ schemaVersion: 2, entries: h.records() })]]) }); invalid.open();
  assert.equal(invalid.node("textarea").value, "");
});

test("focused-editor observation captures rich-text paste/undo without an input event", () => {
  const h = harness(), editor = h.editor(); h.emit(h.document, "focusin", { target: editor });
  assert.equal(h.observation.root, editor);
  editor.innerText = "pasted without input";
  h.observation.callback([]); h.observation.callback([]);
  assert.equal(h.timers.size, 1);
  h.flush(); h.flush(); assert.equal(h.records()[0].text, editor.innerText);
  editor.innerText = "undo transaction"; h.observation.callback([]);
  h.emit(h.w, "pagehide"); assert.equal(h.records()[0].text, "undo transaction");
  h.emit(h.document, "focusout", { target: editor }); assert.equal(h.observation, null);
});

test("explicit clear and logout cannot resurrect the still-visible focused composer", () => {
  const h = harness(), editor = h.editor("keep visible"); h.emit(h.document, "focusin", { target: editor });
  h.input(editor); h.observation.callback([]); h.emit(h.w, "opencodex:clear-drafts");
  h.flush(); h.emit(h.w, "pagehide"); h.dispose(); assert.equal(h.records().length, 0);
});

test("lost RPC continuity is not presented as recovered and reload requires an explicit click", () => {
  const h = harness(); let reloads = 0;
  h.w.location.reload = () => { reloads++; };
  h.input(h.editor("unsent draft"));
  h.w.__OpenCodexConnectionState = { state: "connected", appHostState: "reload-required" };
  h.emit(h.w, "opencodex:connection-state");
  const reload = h.nodes.find(n => n.textContent === "重新加载页面（先保存附件）");
  assert.equal(reloads, 0); assert.equal(reload.hidden, false);
  assert.match(h.node("summary").textContent, /应用需重载/);
  assert.equal(h.node("aside").dataset.connection, "reload-required");
  h.emit(reload, "click"); assert.equal(reloads, 1);
  assert.equal(h.records()[0].text, "unsent draft");
});
