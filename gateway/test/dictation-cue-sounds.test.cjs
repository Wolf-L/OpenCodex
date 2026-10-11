const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = require("./fixtures/dictation-cue-source.cjs");
const { patchDictationCueSounds, CUE_SOUNDS_MARKER } = require("../runtime/http/dictation-cue-sounds.cjs");

function cueHarness({ constructThrows = false, fixture = source, acceptedStart = "Xpl", play = "Zpl", init = "rml" } = {}) {
  const calls = { contexts: 0, fetches: 0, timers: 0, clears: 0, imports: 0, marks: [] };
  // 所有副作用均为本地计数桩，既不联网也不创建真实音频/录音设备。
  const window = {
    setTimeout() { calls.timers += 1; return calls.timers; },
    clearTimeout() { calls.clears += 1; },
  };
  class AudioContext {
    constructor() {
      calls.contexts += 1;
      if (constructThrows) throw Error("unsupported audio");
      this.state = "running";
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({}); }
  }
  const sandbox = {
    window, AudioContext,
    fetch() { calls.fetches += 1; return Promise.resolve({ ok: true, arrayBuffer: async () => "buffer" }); },
    e: (callback) => { let initialized = false; return () => { if (!initialized) { initialized = true; callback(); } }; },
    Gpl() { calls.imports += 1; }, qpl() { calls.imports += 1; }, Ypl() { calls.imports += 1; },
    Kpl: "cue-start", Jpl: "cue-stop", Wpl: "cue-error",
  };
  // 初始化器会把自身绑定替换为缓存函数；每次调用读取最新绑定，与官方调用点一致。
  vm.runInNewContext(`${patchDictationCueSounds(fixture)};this.api={init:()=>${init}(),acceptedStart:${acceptedStart},play:${play}};`, sandbox);
  return { api: sandbox.api, calls, window, sandbox, AudioContext };
}

function assertSilent(calls) {
  assert.equal(calls.contexts, 0);
  assert.equal(calls.fetches, 0);
  assert.equal(calls.timers, 0);
  assert.equal(calls.clears, 0);
  assert.deepEqual(calls.marks, []);
}

test("cue module setup keeps URL imports but schedules no prewarm or AudioContext", () => {
  const h = cueHarness();
  assert.equal(h.api.init(), undefined);
  assert.equal(h.api.init(), undefined);
  assert.equal(h.calls.imports, 3);
  assertSilent(h.calls);
  assert.equal(h.sandbox.AudioContext, h.AudioContext);
  assert.equal(h.sandbox.window, h.window);
});

test("accepted-start callback returns normally without initializing output audio", () => {
  const h = cueHarness(); h.api.init();
  const dictationOptions = { onStartAccepted: h.api.acceptedStart };
  assert.equal(dictationOptions.onStartAccepted(), undefined);
  assert.equal(dictationOptions.onStartAccepted(), undefined);
  assert.equal(h.api.acceptedStart.length, 0);
  assertSilent(h.calls);
});

test("start, stop and error cues return reusable inert cancellations without fake telemetry", () => {
  const h = cueHarness(); h.api.init();
  const timings = { mark: (name) => h.calls.marks.push(name) };
  let previous;
  for (const kind of ["start", "stop", "error", "start"]) {
    previous?.();
    const cancel = h.api.play(kind, timings);
    assert.equal(typeof cancel, "function");
    assert.equal(cancel(), undefined);
    assert.equal(cancel(), undefined);
    previous = cancel;
  }
  assert.equal(h.api.play.length, 2);
  assertSilent(h.calls);
});

test("missing or throwing timing objects and unsupported audio remain harmless", () => {
  const h = cueHarness({ constructThrows: true }); h.api.init();
  for (const timings of [undefined, null, { mark() { throw Error("must not manufacture cue events"); } }]) {
    assert.doesNotThrow(() => h.api.acceptedStart());
    assert.doesNotThrow(() => h.api.play("error", timings)());
  }
  assertSilent(h.calls);
});

test("cue entrypoints are safe before module init and do not depend on DOM or idle scheduling", () => {
  const h = cueHarness();
  h.api.acceptedStart(); h.api.play("start")();
  assertSilent(h.calls);
  assert.equal(h.calls.imports, 0);
  const patched = patchDictationCueSounds(source);
  for (const token of ["MutationObserver", "requestIdleCallback", "requestAnimationFrame", "opencodexCueIdleWarmup"]) {
    assert.equal(patched.includes(token), false, token);
  }
});

test("only cue entry bodies and eager timer change; recording, unrelated media and URL setup stay byte-identical", () => {
  const recording = "typeof window<`u`&&window.setTimeout(()=>{e8r.prepareAudio().catch(()=>{})},0);";
  const otherMedia = "function playOtherMedia(){return new AudioContext()}";
  const callSites = ";const cueCallbacks={onStartAccepted:Xpl,onCue:Zpl};";
  const complete = recording + source + otherMedia + callSites;
  const initializerStart = source.indexOf("function Qpl(");
  const warmup = ",typeof window<`u`&&window.setTimeout(()=>{try{Qpl()}catch{}},0)";
  const expected = recording + `function Xpl(){/*${CUE_SOUNDS_MARKER}*/}function Zpl(e,t){return()=>{}}` +
    source.slice(initializerStart).replace(warmup, "") + otherMedia + callSites;
  const patched = patchDictationCueSounds(complete);
  assert.equal(patched, expected);
  // 保留官方懒解码实现，但除函数声明外再无 Qpl 调用，避免实际录音时才重新下载提示音。
  assert.equal(patched.split("Qpl()").length, 2);
  assert.equal(patched.split(CUE_SOUNDS_MARKER).length, 2);
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("cue silence patch is idempotent and supports renamed top-level minified bindings", () => {
  const renamed = source.replaceAll("Qpl", "cueInit$").replaceAll("P9", "state$_")
    .replaceAll("Xpl", "accepted_").replaceAll("Zpl", "play_").replaceAll("rml", "module_");
  const patched = patchDictationCueSounds(renamed);
  assert.equal(patchDictationCueSounds(patched), patched);
  const h = cueHarness({ fixture: renamed, acceptedStart: "accepted_", play: "play_", init: "module_" });
  h.api.init(); h.api.acceptedStart(); h.api.play("stop")();
  assertSilent(h.calls);
});

test("unknown, changed and duplicate cue lifecycle layouts pass through with diagnostics", () => {
  for (const unknown of [
    source.replace("let{context:e}=Qpl();", "let{context:e}=Other();"),
    source.replace("5e3", "7e3"),
    source.replace("new AudioContext", "new DifferentContext"),
    source.replace("},0)", "},1)"),
    source.replace("return s}function Qpl", "return null}function Qpl"),
    source + source,
  ]) {
    let failed = 0;
    assert.equal(patchDictationCueSounds(unknown, () => failed += 1), unknown);
    assert.equal(failed, 1);
  }
  let unrelatedFailures = 0;
  const unrelated = "function realVoice(){return new AudioContext()}";
  assert.equal(patchDictationCueSounds(unrelated, () => unrelatedFailures += 1), unrelated);
  assert.equal(unrelatedFailures, 0);
});

test("static cue response uses private 304 revalidation and leaves raw WAVs untouched", (t) => {
  const { PATCHED_OFFICIAL_PREFIX } = require("../runtime/core/config.cjs");
  const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");
  const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-cue-test-"));
  t.after(() => {
    // 只递归清理本测试创建且仍处于明确临时根下的目录。
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
  const serve = (assetPath, headers = {}) => {
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    service.serveFile({ headers: { host: "127.0.0.1:3737", ...headers } }, response, service.staticFile(assetPath), 200, assetPath);
    return response;
  };
  const first = serve(reqPath);
  assert.equal(first.status, 200);
  assert.equal(first.headers["cache-control"], "private, no-cache, must-revalidate");
  assert.ok(first.body.toString().includes(CUE_SOUNDS_MARKER));
  assert.equal(serve(reqPath, { "if-none-match": first.headers.etag }).status, 304);
  for (const wav of ["dictation-start-3d0290130f06.wav", "dictation-stop-508377056bdb.wav", "error-878d0efcada6.wav"]) {
    const bytes = Buffer.from(`RIFF:${wav}`);
    fs.writeFileSync(path.join(dir, "assets", wav), bytes);
    const response = serve(`${PATCHED_OFFICIAL_PREFIX}assets/${wav}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, bytes);
    assert.deepEqual(fs.readFileSync(path.join(dir, "assets", wav)), bytes);
  }
  const unsafe = Buffer.from(source.replace("5e3", "7e3"));
  assert.equal(service.patchOfficialAssetData(reqPath, unsafe, { headers: {} }), unsafe);
  const point = compatibilityService.registry.point("static.cache.renderer.dictation-cue-sounds");
  assert.match(JSON.stringify(point), /Official dictation cue lifecycle did not match/);
  assert.match(JSON.stringify(point), /Official renderer behavior/);
});
