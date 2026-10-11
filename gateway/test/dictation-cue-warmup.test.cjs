const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = require("./fixtures/dictation-cue-source.cjs");
const { patchDictationCueWarmup, CUE_WARMUP_MARKER } = require("../runtime/http/dictation-cue-warmup.cjs");

function browser({ idleSupported = true, framesSupported = true, constructThrows = false } = {}) {
  let now = 0;
  let sequence = 0;
  let shown = false;
  let disabled = false;
  let cssVisibility = "visible";
  const jobs = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const observers = new Set();
  const contexts = [];
  const fetches = [];
  const idleOptions = [];
  const addJob = (callback, delay, kind = "timer") => {
    const id = ++sequence;
    jobs.set(id, { callback, due: now + delay, kind });
    return id;
  };
  const element = {
    getBoundingClientRect: () => ({ width: shown ? 100 : 0, height: shown ? 40 : 0 }),
    getAttribute: () => disabled ? "true" : null,
  };
  const document = {
    visibilityState: "visible", documentElement: {},
    querySelectorAll: () => [element],
    addEventListener: (name, callback) => documentListeners.set(name, callback),
    removeEventListener: (name) => documentListeners.delete(name),
  };
  const window = {
    document,
    setTimeout: (callback, delay) => addJob(callback, delay),
    clearTimeout: (id) => jobs.delete(id),
    addEventListener: (name, callback) => windowListeners.set(name, callback),
    removeEventListener: (name) => windowListeners.delete(name),
    getComputedStyle: () => ({ visibility: cssVisibility }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
  };
  if (framesSupported) {
    window.requestAnimationFrame = (callback) => addJob(callback, 16, "frame");
    window.cancelAnimationFrame = (id) => jobs.delete(id);
  }
  if (idleSupported) {
    window.requestIdleCallback = (callback, options) => {
      idleOptions.push(options);
      return addJob(callback, options.timeout, "idle");
    };
    window.cancelIdleCallback = (id) => jobs.delete(id);
  }
  // 全部音频行为都是内存桩；不触发真实 AudioContext、fetch 或麦克风权限。
  class AudioContext {
    constructor() {
      if (constructThrows) throw Error("audio unsupported");
      this.state = "running";
      this.sources = [];
      this.resumeCount = 0;
      contexts.push(this);
    }
    resume() { this.resumeCount += 1; this.state = "running"; return Promise.resolve(); }
    suspend() { this.state = "suspended"; return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
    decodeAudioData(data) { return Promise.resolve({ data }); }
    createBufferSource() {
      const node = {
        started: false, stopped: false, disconnected: false,
        connect() {}, start() { this.started = true; },
        stop() { this.stopped = true; }, disconnect() { this.disconnected = true; },
      };
      this.sources.push(node);
      return node;
    }
  }
  let fetchImplementation = async (url) => ({ ok: true, arrayBuffer: async () => url });
  const sandbox = {
    window, AudioContext,
    fetch: (url) => { fetches.push(url); return fetchImplementation(url); },
    e: (callback) => callback,
    Gpl() {}, qpl() {}, Ypl() {}, Kpl: "cue-start", Jpl: "cue-stop", Wpl: "cue-error",
  };
  vm.runInNewContext(`${patchDictationCueWarmup(source)};this.api={init:rml,prepare:Xpl,play:Zpl,state:()=>P9};`, sandbox);
  const mutate = () => { for (const observer of observers) observer.callback([]); };
  return {
    api: sandbox.api, contexts, fetches, idleOptions, jobs, observers, windowListeners, documentListeners,
    setFetch: (fn) => { fetchImplementation = fn; },
    show(value = true) { shown = value; mutate(); },
    disable(value) { disabled = value; mutate(); },
    css(value) { cssVisibility = value; mutate(); },
    hide(value = true) {
      document.visibilityState = value ? "hidden" : "visible";
      documentListeners.get("visibilitychange")?.();
    },
    unload() { windowListeners.get("pagehide")?.(); },
    idle() {
      for (const [id, job] of Array.from(jobs)) if (job.kind === "idle") { jobs.delete(id); job.callback(); }
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const first = Array.from(jobs).filter(([, job]) => job.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!first) break;
        jobs.delete(first[0]); now = first[1].due; first[1].callback();
      }
      now = end;
    },
  };
}

async function flushPromises() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }

test("cue prewarm waits for usable composer, two paints, settle, then idle exactly once", () => {
  const b = browser();
  b.api.init(); b.advance(5000);
  assert.equal(b.contexts.length, 0);
  b.disable(true); b.show(); b.advance(2000);
  assert.equal(b.contexts.length, 0);
  b.disable(false); b.advance(31);
  assert.equal(b.idleOptions.length, 0);
  b.advance(1000);
  assert.equal(b.idleOptions.length, 0);
  b.advance(1);
  assert.equal(b.idleOptions[0].timeout, 2000);
  assert.equal(b.contexts.length, 0);
  b.idle(); b.idle(); b.show();
  assert.equal(b.contexts.length, 1);
  assert.equal(b.fetches.length, 3);
  assert.equal(b.observers.size, 0);
  assert.equal(b.documentListeners.size, 0);
});

test("hidden composer and CSS-invisible inputs never trigger optional warmup", () => {
  const b = browser();
  b.api.init(); b.css("hidden"); b.show(); b.advance(5000);
  assert.equal(b.contexts.length, 0);
  b.css("visible"); b.advance(1032); b.hide(); b.idle(); b.advance(5000);
  assert.equal(b.contexts.length, 0);
  b.hide(false); b.advance(1032); b.idle();
  assert.equal(b.contexts.length, 1);
});

test("pagehide cancels frame, settle and idle phases without affecting real first use", () => {
  for (const elapsed of [0, 32, 1032]) {
    const b = browser(); b.api.init(); b.show(); b.advance(elapsed); b.unload();
    b.advance(40000); b.idle();
    assert.equal(b.contexts.length, 0);
    assert.equal(b.jobs.size, 0);
    assert.equal(b.observers.size, 0);
    assert.equal(b.windowListeners.size, 0);
    b.api.prepare();
    assert.equal(b.contexts.length, 1);
  }
});

test("composer disappearing during each pending phase rechecks readiness before warming", () => {
  for (const elapsed of [0, 32, 1032]) {
    const b = browser(); b.api.init(); b.show(); b.advance(elapsed); b.show(false);
    b.advance(4000); b.idle();
    assert.equal(b.contexts.length, 0);
    b.show(); b.advance(1032); b.idle();
    assert.equal(b.contexts.length, 1);
  }
});

test("no-composer and permanently hidden pages clean up at the absolute 30 second bound", () => {
  for (const hidden of [false, true]) {
    const b = browser(); b.api.init(); if (hidden) { b.hide(); b.show(); }
    b.advance(30000);
    assert.equal(b.contexts.length, 0);
    assert.equal(b.jobs.size, 0);
    assert.equal(b.observers.size, 0);
    assert.equal(b.documentListeners.size, 0);
    b.hide(false); b.show(); b.advance(5000);
    assert.equal(b.contexts.length, 0);
  }
});

test("timer fallback and idle deadline preserve once-only bounded execution", () => {
  for (const options of [{ idleSupported: false }, { idleSupported: false, framesSupported: false }, {}]) {
    const b = browser(options); b.api.init(); b.show(); b.advance(3032);
    assert.equal(b.contexts.length, 1);
    b.advance(1000); b.idle();
    assert.equal(b.contexts.length, 1);
  }
});

test("early actual cue playback initializes immediately and delayed warmup reuses the live singleton", async () => {
  const b = browser(); const marks = [];
  b.api.init();
  const cancel = b.api.play("start", { mark: (name) => marks.push(name) });
  const state = b.api.state();
  assert.equal(b.contexts.length, 1);
  assert.equal(state.context.sources.length, 0);
  await flushPromises();
  assert.equal(state.context.sources[0].started, true);
  assert.deepEqual(marks, ["cue_requested", "cue_scheduled"]);
  b.show(); b.advance(1032); b.idle();
  assert.equal(b.contexts.length, 1);
  assert.equal(b.api.state(), state);
  assert.equal(b.fetches.length, 3);
  cancel();
  assert.equal(state.context.sources[0].stopped, true);
  assert.equal(state.context.sources[0].disconnected, true);
  assert.equal(marks.at(-1), "cue_cancelled");
});

test("decoded fast path, resume, ended cleanup, closed retry and inactivity suspend remain unchanged", async () => {
  const b = browser(); b.api.init(); b.api.prepare(); await flushPromises();
  const context = b.contexts[0];
  context.state = "suspended"; const resumes = context.resumeCount;
  b.api.prepare(); assert.equal(context.resumeCount, resumes + 1);
  b.api.play("stop");
  assert.equal(context.sources[0].started, true);
  context.sources[0].onended();
  assert.equal(context.sources[0].disconnected, true);
  b.advance(60000); assert.equal(context.state, "suspended");
  context.state = "closed"; b.api.prepare();
  assert.equal(b.contexts.length, 2);
});

test("unresolved decode still times out after 5 seconds and failed decode closes before retry", async () => {
  const b = browser(); b.setFetch(() => new Promise(() => {})); b.api.init();
  const marks = []; b.api.play("start", { mark: (name) => marks.push(name) });
  b.advance(4999); assert.deepEqual(marks, ["cue_requested"]);
  b.advance(1); assert.deepEqual(marks, ["cue_requested", "cue_failed"]);
  const failed = browser(); failed.setFetch(async () => ({ ok: false }));
  failed.api.init(); failed.api.prepare(); await flushPromises();
  assert.equal(failed.contexts[0].state, "closed");
  assert.equal(failed.api.state(), null);
  failed.setFetch(async () => ({ ok: true, arrayBuffer: async () => "buffer" }));
  failed.api.prepare(); await flushPromises();
  assert.equal(failed.contexts.length, 2);
  assert.ok(failed.api.state().decoded.start);
});

test("optional unsupported audio errors stay caught and resources are cleaned", () => {
  const b = browser({ constructThrows: true }); b.api.init(); b.show(); b.advance(1032);
  assert.doesNotThrow(() => b.idle());
  assert.equal(b.contexts.length, 0);
  assert.equal(b.observers.size, 0);
  assert.equal(b.jobs.size, 0);
});

test("source patch is idempotent, preserves all non-warmup bytes and supports top-level minified renaming", () => {
  const streaming = "typeof window<`u`&&window.setTimeout(()=>{e8r.prepareAudio().catch(()=>{})},0);";
  const complete = streaming + source;
  const patched = patchDictationCueWarmup(complete);
  const originalWarmup = "window.setTimeout(()=>{try{Qpl()}catch{}},0)";
  const offset = complete.indexOf(originalWarmup);
  const prefix = complete.slice(0, offset);
  assert.ok(patched.startsWith(prefix));
  assert.ok(patched.endsWith(`)(()=>{try{Qpl()}catch{}})${complete.slice(offset + originalWarmup.length)}`));
  assert.equal(patchDictationCueWarmup(patched), patched);
  assert.equal(patched.split(CUE_WARMUP_MARKER).length, 2);
  const renamed = source.replaceAll("Qpl", "cueInit$").replaceAll("P9", "state$_").replaceAll("Xpl", "resume_");
  const renamedPatched = patchDictationCueWarmup(renamed);
  assert.ok(renamedPatched.includes(CUE_WARMUP_MARKER));
  assert.ok(renamedPatched.includes("try{cueInit$()}catch{}"));
  assert.doesNotThrow(() => new vm.Script(renamedPatched));
});

test("partial, modified lazy fallback and ambiguous source pass through with mismatch diagnostics", () => {
  for (const unknown of [
    source.replace("let{context:e}=Qpl();", "let{context:e}=Other();"),
    source.replace("5e3", "7e3"),
    source.replace("new AudioContext", "new DifferentContext"),
    source.replace("},0)", "},1)"),
    source + source,
  ]) {
    let failed = 0;
    assert.equal(patchDictationCueWarmup(unknown, () => failed += 1), unknown);
    assert.equal(failed, 1);
  }
});

test("static cue response is private-revalidated with stable 304 and reports unsafe source layouts", (t) => {
  const { PATCHED_OFFICIAL_PREFIX } = require("../runtime/core/config.cjs");
  const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");
  const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-cue-test-"));
  t.after(() => {
    // 递归清理只接受本测试刚创建、且仍位于临时根下的明确目录。
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("opencodex-cue-test-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, "assets"));
  const name = "app-initial-abcdef123456.js";
  fs.writeFileSync(path.join(dir, "assets", name), source);
  const compatibilityService = createCompatibilityService();
  t.after(() => compatibilityService.dispose());
  const service = createStaticAssetService({ getOfficialBundle: () => ({ webviewDir: dir }), compatibilityService });
  const reqPath = `${PATCHED_OFFICIAL_PREFIX}assets/${name}`;
  const serve = (headers = {}) => {
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    service.serveFile({ headers: { host: "127.0.0.1:3737", ...headers } }, response, service.staticFile(reqPath), 200, reqPath);
    return response;
  };
  const first = serve();
  assert.equal(first.status, 200);
  assert.equal(first.headers["cache-control"], "private, no-cache, must-revalidate");
  assert.ok(first.body.toString().includes(CUE_WARMUP_MARKER));
  assert.equal(serve({ "if-none-match": first.headers.etag }).status, 304);
  const unsafe = Buffer.from(source.replace("5e3", "7e3"));
  assert.equal(service.patchOfficialAssetData(reqPath, unsafe, { headers: {} }), unsafe);
  const point = compatibilityService.registry.point("static.cache.renderer.dictation-cue-warmup");
  assert.match(JSON.stringify(point), /Official dictation cue lifecycle did not match/);
  assert.match(JSON.stringify(point), /Official renderer behavior/);
});
