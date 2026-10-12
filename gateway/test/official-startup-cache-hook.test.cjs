const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const { __test: { createOfficialStartupCacheHook, CONTEXT_ANCHOR, FETCH_ANCHOR, BINDING, MAIN_FILE, SOURCES, PREAUTH_ANCHOR } } = require("../runtime/electron/official-startup-cache-hook.cjs");

const principal = { accountId: "synthetic-account", userId: "synthetic-user" };
const fixture = `"use strict";exports.fetch=async function(context){const {o,a,r,E,S,s,p,h,u,k,l}=context;${CONTEXT_ANCHOR}(u);return e;};`;
const digest = (source) => crypto.createHash("sha256").update(source).digest("hex");
const hit = () => new Response('{"saved":true}', { headers: { "content-type": "application/json", "x-opencodex-startup-cache": "hit" } });

function harness(options = {}) {
  const bundle = { bundleDir: path.resolve("synthetic-official-bundle"), version: "test-version", build: "test-build" };
  const target = path.join(bundle.bundleDir, ".vite", "build", options.sourceFile || MAIN_FILE);
  const delegated = [];
  const compiled = [];
  const source = options.source ?? fixture;
  const original = options.original || function (module, filename) { delegated.push({ receiver: this, module, filename }); return "delegated"; };
  const loader = { _extensions: { ".js": original }, _cache: {} };
  let sourceReads = 0;
  let cacheCreations = 0;
  const settings = options.settings || { enabled: true, reason: "enabled", directory: path.resolve("synthetic-private-cache") };
  const engine = options.engine || { async fetch(descriptor) { descriptor.validateContext(); return hit(); }, status: () => ({ hits: 0 }) };
  const hook = createOfficialStartupCacheHook({
    moduleLoader: loader,
    sources: options.sources,
    readSource: options.readSource || (() => { sourceReads += 1; return Buffer.from(source); }),
    expectedHash: options.expectedHash || digest(source),
    adapterPath: path.resolve('synthetic " quoted adapter.cjs'),
    readSettings: options.readSettings || (() => settings),
    createCache: (args) => { cacheCreations += 1; options.onCreateCache?.(args); return engine; },
    classifyStartupRequest: options.classify || (() => ({ kind: "accounts", keyParts: { synthetic: true } })),
  });
  const load = (filename = target, module = { _compile(code, file) { compiled.push({ code, file }); return "compiled"; } }) => loader._extensions[".js"].call(loader, module, filename);
  const install = (extra = {}) => hook.install({ bundle, runtimeDir: path.resolve("synthetic-runtime"), ...extra });
  const activate = (extra = {}) => { install(extra); load(); };
  return { hook, loader, original, bundle, target, source, delegated, compiled, install, load, activate, counts: () => ({ sourceReads, cacheCreations }) };
}

function transport() {
  const calls = [];
  const checks = [];
  const network = {
    fetch(input, init) { calls.push({ receiver: this, input, init }); return Promise.resolve(new Response("upstream")); },
    assertAllowed(input) { checks.push({ receiver: this, input }); },
  };
  return { network, calls, checks };
}

test("only exact path with unique full source fingerprint gets a local lexical adapter", () => {
  const h = harness();
  h.install();
  assert.equal(h.hook.status().reason, "awaiting-source");
  assert.equal(h.load(path.join(h.bundle.bundleDir, MAIN_FILE)), "delegated");
  assert.deepEqual(h.counts(), { sourceReads: 0, cacheCreations: 0 });
  assert.equal(h.load(), "compiled");
  const { code, file } = h.compiled[0];
  assert.equal(file, h.target);
  assert.equal(code.startsWith('"use strict";'), true);
  assert.equal(code.includes(FETCH_ANCHOR), false);
  assert.equal(code.includes(`const ${BINDING}=require(${JSON.stringify(path.resolve('synthetic " quoted adapter.cjs'))});`), true);
  assert.equal(code.includes(".fetchDesktop(this.options.applicationNetwork,u,t,k,()=>this.getAppServerConnection(l.h).getCachedAuthenticatedPrincipal(),!h)"), true);
  assert.equal(h.hook.status().patchCount, 1);
  assert.deepEqual(h.hook.status().coverage, { desktop: true, preauth: false });
  assert.equal(h.delegated[0].receiver, h.loader);
});

test("disabled, unreadable settings, and already loaded modules never install or create a cache", () => {
  for (const options of [
    { settings: { enabled: false, reason: "disabled" } },
    { readSettings() { throw new Error("private path secret"); } },
  ]) {
    const h = harness(options);
    h.install();
    assert.equal(h.loader._extensions[".js"], h.original);
    assert.equal(h.hook.status().enabled, false);
    assert.deepEqual(h.counts(), { sourceReads: 0, cacheCreations: 0 });
    assert.equal(JSON.stringify(h.hook.status()).includes("secret"), false);
  }
  const h = harness();
  h.loader._cache[h.target] = {};
  assert.equal(h.install().reason, "already-loaded");
  assert.equal(h.loader._extensions[".js"], h.original);
});

test("wrong hash, missing or duplicate anchor and binding collisions delegate unmodified", () => {
  for (const options of [
    { expectedHash: "0".repeat(64), reason: "unsupported-source-hash" },
    { source: "module.exports = {};", reason: "unsupported-source-anchor" },
    { source: fixture + fixture, reason: "unsupported-source-anchor" },
    { source: fixture.replace("let e;", "let e = null;"), reason: "unsupported-source-anchor" },
    { source: `${fixture}\n// ${BINDING}`, reason: "unsupported-source-anchor" },
  ]) {
    const h = harness(options);
    h.install();
    assert.equal(h.load(), "delegated");
    assert.equal(h.hook.status().reason, options.reason);
    assert.equal(h.hook.status().supported, false);
    assert.equal(h.compiled.length, 0);
    assert.equal(h.counts().cacheCreations, 0);
  }
});

test("source read errors sanitize status; original loader and compile errors propagate once", () => {
  const unreadable = harness({ readSource() { throw new Error("private pathname body token"); } });
  unreadable.install();
  assert.equal(unreadable.load(), "delegated");
  assert.equal(unreadable.hook.status().reason, "source-unavailable");
  assert.equal(JSON.stringify(unreadable.hook.status()).includes("token"), false);
  const failure = new Error("synthetic original failure");
  let calls = 0;
  const original = harness({ expectedHash: "0".repeat(64), original() { calls += 1; throw failure; } });
  original.install();
  assert.throws(() => original.load(), (error) => error === failure);
  assert.equal(calls, 1);
  const compilation = harness();
  compilation.install();
  assert.throws(() => compilation.load(compilation.target, { _compile() { throw failure; } }), (error) => error === failure);
  assert.equal(compilation.delegated.length, 0);
  assert.equal(compilation.hook.status().reason, "compile-failed");
});

test("installation is idempotent and dispose does not clobber another extension wrapper", () => {
  const h = harness();
  h.install();
  const first = h.loader._extensions[".js"];
  h.install();
  assert.equal(h.loader._extensions[".js"], first);
  h.hook.dispose();
  assert.equal(h.loader._extensions[".js"], h.original);
  h.install();
  const second = h.loader._extensions[".js"];
  const outer = function () { return second.apply(this, arguments); };
  h.loader._extensions[".js"] = outer;
  h.hook.dispose();
  assert.equal(h.loader._extensions[".js"], outer);
  assert.equal(h.load(), "delegated");
  h.install();
  assert.equal(h.load(), "compiled");
  assert.equal(h.load(path.resolve("other.js")), "delegated");
});

test("synthetic compiled source uses the original network receiver and exact request options", async () => {
  let observed;
  const h = harness({ engine: { status: () => ({}), async fetch(descriptor, input, init, upstream) { observed = { descriptor, input, init }; descriptor.validateContext(); return upstream(input, init); } } });
  h.install();
  const exports = {};
  h.load(h.target, { _compile(code) {
    // 只执行自制小夹具，绝不执行真实官方 bundle。
    vm.runInNewContext(code, { exports, require: () => ({ fetchDesktop: h.hook.fetchDesktop }) });
  } });
  const { network, calls, checks } = transport();
  const signal = new AbortController().signal;
  const headers = { authorization: "synthetic-request-secret" };
  const context = { o: null, a: "GET", r: headers, E: () => undefined, S: null, s: "follow", p: signal, h: false, u: "https://example.invalid/account", k: principal, l: { h: "host" } };
  const response = await exports.fetch.call({ options: { applicationNetwork: network }, getAppServerConnection(host) { assert.equal(host, "host"); return { getCachedAuthenticatedPrincipal: () => principal }; } }, context);
  assert.equal(await response.text(), "upstream");
  assert.equal(calls[0].receiver, network);
  assert.equal(calls[0].input, context.u);
  assert.equal(calls[0].init, observed.init);
  assert.equal(observed.init.headers, headers);
  assert.equal(observed.init.signal, signal);
  assert.equal(observed.init.credentials, "same-origin");
  assert.equal(observed.init.redirect, "follow");
  assert.equal(checks.every((entry) => entry.receiver === network && entry.input === context.u), true);
  assert.equal(h.hook.status().hitCount, 0);
  assert.equal(JSON.stringify(h.hook.status()).includes("synthetic-request-secret"), false);
});

test("a genuine cache hit revalidates native policy and current principal, emits only kind", async () => {
  const events = [];
  let getterCalls = 0;
  const h = harness();
  h.activate({ onHit(event) { events.push(event); throw new Error("ignored observer failure"); } });
  const { network, calls, checks } = transport();
  const response = await h.hook.fetchDesktop(network, "https://example.invalid/account", {}, principal, () => { getterCalls += 1; return principal; }, true);
  assert.equal(await response.text(), '{"saved":true}');
  assert.equal(calls.length, 0);
  assert.equal(checks.length >= 3, true);
  assert.equal(getterCalls, checks.length);
  assert.deepEqual(events, [{ kind: "accounts" }]);
  assert.equal(h.hook.status().hitCount, 1);
  assert.equal(JSON.stringify(h.hook.status()).includes(principal.accountId), false);
});

test("unknown or changed current identity aborts candidates without upstream fallback", async () => {
  for (const current of [null, undefined, {}, { ...principal, userId: "other" }, { ...principal, accountId: "other" }]) {
    const h = harness();
    h.activate();
    const { network, calls } = transport();
    await assert.rejects(h.hook.fetchDesktop(network, "https://example.invalid/account", {}, principal, () => current, true), { name: "AbortError" });
    assert.equal(calls.length, 0);
  }
});

test("identity mutations while an async cache lookup is pending cannot return the old response", async () => {
  let current = { ...principal };
  const expected = { ...principal };
  const h = harness({ engine: { status: () => ({}), async fetch(descriptor) {
    descriptor.validateContext();
    await Promise.resolve();
    current.userId = "new-user";
    expected.userId = "new-user";
    descriptor.validateContext();
    return hit();
  } } });
  h.activate();
  const { network, calls } = transport();
  await assert.rejects(h.hook.fetchDesktop(network, "https://example.invalid/account", {}, expected, () => current, true), { name: "AbortError" });
  assert.equal(calls.length, 0);
  assert.equal(h.hook.status().hitCount, 0);
});

test("network policy denial and already aborted signal propagate before cache access", async () => {
  let engineCalls = 0;
  const h = harness({ engine: { status: () => ({}), async fetch() { engineCalls += 1; return hit(); } } });
  h.activate();
  const { network, calls } = transport();
  const denied = new Error("synthetic policy denial");
  network.assertAllowed = () => { throw denied; };
  await assert.rejects(h.hook.fetchDesktop(network, "https://example.invalid/account", {}, principal, () => principal, true), (error) => error === denied);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.hook.fetchDesktop(network, "https://example.invalid/account", { signal: controller.signal }, principal, () => principal, true), { name: "AbortError" });
  assert.equal(engineCalls, 0);
  assert.equal(calls.length, 0);
});

test("policy change during lookup propagates instead of a cached success or network fallback", async () => {
  let denied = false;
  const failure = new Error("changed policy");
  const h = harness({ engine: { status: () => ({}), async fetch(descriptor) { await Promise.resolve(); denied = true; descriptor.validateContext(); return hit(); } } });
  h.activate();
  const { network, calls } = transport();
  network.assertAllowed = () => { if (denied) throw failure; };
  await assert.rejects(h.hook.fetchDesktop(network, "https://example.invalid/account", {}, principal, () => principal, true), (error) => error === failure);
  assert.equal(calls.length, 0);
});

test("disabled, unsupported, forbidden surface and noncandidate requests keep original behavior", async () => {
  for (const variant of ["disabled", "unsupported", "forbidden", "noncandidate", "classifier-error", "disposed"]) {
    let classified = 0;
    const h = harness({
      settings: { enabled: variant !== "disabled", reason: variant === "disabled" ? "disabled" : "enabled" },
      expectedHash: variant === "unsupported" ? "0".repeat(64) : undefined,
      classify() { classified += 1; if (variant === "classifier-error") throw new Error("private classifier detail"); return null; },
    });
    h.activate();
    if (variant === "disposed") h.hook.dispose();
    const { network, calls, checks } = transport();
    const controller = new AbortController();
    controller.abort();
    const init = { signal: controller.signal, body: "private body" };
    const response = await h.hook.fetchDesktop(network, "https://example.invalid/model", init, null, () => { throw new Error("must not inspect"); }, variant !== "forbidden");
    assert.equal(await response.text(), "upstream");
    assert.equal(calls[0].init, init);
    assert.equal(checks.length, 0);
    assert.equal(classified, ["noncandidate", "classifier-error"].includes(variant) ? 1 : 0);
  }
});

test("only classified public SDK initialization permits null native principal", async () => {
  const sdk = harness({ classify: () => ({ kind: "statsig-initialize", keyParts: { user: { customIDs: { stableID: "synthetic-device" } } } }) });
  sdk.activate();
  const { network, checks } = transport();
  await sdk.hook.fetchDesktop(network, "https://ab.chatgpt.com/v1/initialize", {}, null, () => { throw new Error("not used for public SDK device key"); }, true);
  assert.equal(checks.length >= 2, true);
  const account = harness();
  account.activate();
  await assert.rejects(account.hook.fetchDesktop(network, "https://example.invalid/account", {}, null, () => null, true), { name: "AbortError" });
  await assert.rejects(sdk.hook.fetchDesktop(network, "https://ab.chatgpt.com/v1/initialize", {}, {}, () => null, true), { name: "AbortError" });
});

test("a network-supplied cache marker is not counted as a local hit", async () => {
  const events = [];
  const h = harness({ engine: { status: () => ({}), fetch: (descriptor, input, init, upstream) => upstream(input, init) } });
  h.activate({ onHit: (event) => events.push(event) });
  const network = { assertAllowed() {}, fetch: async () => hit() };
  await h.hook.fetchDesktop(network, "https://example.invalid/account", {}, principal, () => principal, true);
  assert.equal(h.hook.status().hitCount, 0);
  assert.deepEqual(events, []);
});

test("cache build key contains official version, build, adapter schema and source fingerprint", () => {
  let settings;
  const h = harness({ onCreateCache(args) { settings = args; } });
  h.activate();
  assert.equal(settings.enabled, true);
  assert.equal(settings.buildId, `native-startup-v1:test-version:test-build:${digest(fixture)}`);
});

test("state observers report delayed acceptance and rejections without affecting native loading", () => {
  const states = [];
  const onState = (state) => { states.push(state); throw new Error("ignored diagnostic failure"); };
  const supported = harness();
  supported.install({ onState });
  assert.equal(supported.load(), "compiled");
  assert.deepEqual(states.map((state) => state.reason), ["awaiting-source", "patched"]);
  const unknown = harness({ expectedHash: "0".repeat(64) });
  unknown.install({ onState });
  assert.equal(unknown.load(), "delegated");
  assert.equal(states.at(-1).reason, "unsupported-source-hash");
  const failed = harness();
  failed.install({ onState });
  const failure = new Error("synthetic compile error");
  assert.throws(() => failed.load(failed.target, { _compile() { throw failure; } }), (error) => error === failure);
  assert.equal(states.at(-1).reason, "compile-failed");
  const disabled = harness({ settings: { enabled: false, reason: "disabled" } });
  disabled.install({ onState });
  assert.equal(states.at(-1).reason, "disabled");
  assert.equal(JSON.stringify(states).includes("synthetic compile error"), false);
  assert.equal(JSON.stringify(states).includes(supported.target), false);
});

const preauthFixture = `"use strict";exports.Network=class {${PREAUTH_ANCHOR}};`;
function preauthHarness(options = {}) {
  const source = options.source || preauthFixture;
  const sourceFile = "synthetic-preauth.js";
  return harness({ ...options, source, sourceFile,
    sources: [{ file: sourceFile, hash: options.expectedHash || digest(source), surface: "preauth" }],
    classify: options.classify || (() => ({ kind: "statsig-initialize", keyParts: { namespace: "preauth" } })),
  });
}

function preauthTransport() {
  const calls = [];
  const network = { disposed: false, allowsPreauthStatsigRequest: () => true };
  const session = { fetch(input, init) { calls.push({ receiver: this, input, init }); return Promise.resolve(new Response("upstream")); } };
  return { network, session, calls };
}

test("preauth synthetic patch preserves native session, request options and combined cancellation", async () => {
  const { session, calls } = preauthTransport();
  const h = preauthHarness({ engine: { status: () => ({}), fetch: (descriptor, input, init, upstream) => upstream(input, init) } });
  h.install();
  const exports = {};
  const partitions = [];
  h.load(h.target, { _compile(code) {
    // 只执行合成类及假 session；真实官方源码只在下方做语法检查。
    vm.runInNewContext(code, { exports, require: () => h.hook, Headers, AbortController, AbortSignal,
      f: { session: { fromPartition(...args) { partitions.push(args); return session; } } },
      C: { randomUUID: () => "synthetic-session" }, $n() {},
    });
  } });
  const network = new exports.Network();
  network.disposed = false;
  network.preauthStatsigSessions = new Map();
  network.allowsPreauthStatsigRequest = () => true;
  network.applyToSession = (value) => assert.equal(value, session);
  const native = network.createPreauthStatsigTransport();
  const caller = new AbortController();
  const init = { method: "POST", signal: caller.signal, body: "synthetic body", credentials: "include" };
  await native.fetch("https://ab.chatgpt.com/v1/initialize", init);
  assert.equal(partitions.length, 1);
  assert.equal(calls[0].receiver, session);
  assert.equal(calls[0].init.body, init.body);
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.referrerPolicy, "no-referrer");
  assert.notEqual(calls[0].init.signal, caller.signal);
  native.dispose();
  assert.equal(calls[0].init.signal.aborted, true);
  await assert.rejects(native.fetch("https://ab.chatgpt.com/v1/initialize", init), { name: "AbortError" });
  assert.equal(calls.length, 1);
  assert.deepEqual(h.hook.status().coverage, { desktop: false, preauth: true });
  assert.equal(h.hook.status().cache, null);
  assert.notEqual(h.hook.status().preauthCache, null);
});

test("preauth revalidates disposal, native policy, secrets and combined abort during cache lookup", async () => {
  for (const change of ["disposed", "policy", "authorization", "proxy-authorization", "cookie", "caller-abort", "scope-abort"]) {
    const { network, session, calls } = preauthTransport();
    const caller = new AbortController();
    const scope = new AbortController();
    const init = { method: "POST", headers: new Headers(), signal: AbortSignal.any([caller.signal, scope.signal]) };
    const h = preauthHarness({ engine: { status: () => ({}), async fetch(descriptor) {
      descriptor.validateContext();
      await Promise.resolve();
      if (change === "disposed") network.disposed = true;
      else if (change === "policy") network.allowsPreauthStatsigRequest = () => false;
      else if (change === "caller-abort") caller.abort();
      else if (change === "scope-abort") scope.abort();
      else init.headers.set(change, "synthetic");
      descriptor.validateContext();
      return hit();
    } } });
    h.activate();
    await assert.rejects(h.hook.fetchPreauth(network, session, "https://ab.chatgpt.com/v1/initialize", init));
    assert.equal(calls.length, 0);
    assert.equal(h.hook.status().hitCount, 0);
  }
});

test("preauth cache hits use an isolated source namespace and report only aggregate events", async () => {
  let settings;
  const events = [];
  const h = preauthHarness({ onCreateCache: (value) => { settings = value; } });
  h.activate({ onHit: (value) => events.push(value) });
  const { network, session, calls } = preauthTransport();
  await h.hook.fetchPreauth(network, session, "https://ab.chatgpt.com/v1/initialize", { method: "POST" });
  assert.equal(settings.buildId, `native-preauth-startup-v1:test-version:test-build:${digest(preauthFixture)}`);
  assert.equal(settings.directory, path.resolve("synthetic-private-cache", "preauth"));
  assert.equal(calls.length, 0);
  assert.equal(h.hook.status().hitCount, 1);
  assert.deepEqual(events, [{ kind: "statsig-initialize" }]);
  h.hook.dispose();
  assert.deepEqual(h.hook.status().coverage, { desktop: false, preauth: false });
});

test("a rejected second surface cannot disable an already verified desktop adapter", async () => {
  const bundle = { bundleDir: path.resolve("synthetic-multi-bundle"), version: "test", build: "test" };
  const loader = { _extensions: { ".js"() { return "native"; } }, _cache: {} };
  const desktopFile = path.join(bundle.bundleDir, ".vite", "build", MAIN_FILE);
  const preauthFile = path.join(bundle.bundleDir, ".vite", "build", "synthetic-preauth.js");
  const hook = createOfficialStartupCacheHook({
    moduleLoader: loader,
    sources: [{ file: MAIN_FILE, hash: digest(fixture), surface: "desktop" }, { file: "synthetic-preauth.js", hash: "0".repeat(64), surface: "preauth" }],
    readSource: (file) => file === desktopFile ? fixture : preauthFixture,
    readSettings: () => ({ enabled: true, reason: "enabled", directory: "synthetic" }),
    createCache: () => ({ status: () => ({}), fetch: async () => hit() }),
    classifyStartupRequest: () => ({ kind: "accounts" }),
  });
  hook.install({ bundle });
  loader._extensions[".js"]({ _compile() {} }, desktopFile);
  assert.equal(loader._extensions[".js"]({ _compile() { assert.fail("unknown source compiled"); } }, preauthFile), "native");
  assert.deepEqual(hook.status().coverage, { desktop: true, preauth: false });
  assert.equal(hook.status().reason, "unsupported-source-hash");
  const { network, calls } = transport();
  await hook.fetchDesktop(network, "https://example.invalid/account", {}, principal, () => principal, true);
  assert.equal(calls.length, 0);
});

test("preauth unknown source and noncandidate requests retain untouched native fetch", async () => {
  for (const variant of ["hash", "anchor", "account", "unknown", "disabled"]) {
    const h = preauthHarness({
      expectedHash: variant === "hash" ? "0".repeat(64) : undefined,
      source: variant === "anchor" ? "exports.value=1" : undefined,
      settings: variant === "disabled" ? { enabled: false, reason: "disabled" } : undefined,
      classify: () => variant === "unknown" ? null : { kind: "accounts" },
    });
    h.activate();
    const { network, session, calls } = preauthTransport();
    const init = { method: "POST", body: "unchanged" };
    const response = await h.hook.fetchPreauth(network, session, "https://example.invalid", init);
    assert.equal(await response.text(), "upstream");
    assert.equal(calls[0].receiver, session);
    assert.equal(calls[0].init, init);
    assert.equal(h.hook.status().hitCount, 0);
  }
});

test("missing production source reports unsupported immediately", () => {
  const hook = createOfficialStartupCacheHook({
    readSettings: () => ({ enabled: true, reason: "enabled" }),
    moduleLoader: { _extensions: { ".js"() {} }, _cache: {} },
  });
  assert.equal(hook.install({ bundle: { bundleDir: path.resolve("nonexistent-synthetic-runtime") } }).reason, "unsupported-source-file");
});

test("verified Linux official files transform and compile without executing vendor code", {
  skip: !process.env.OPENCODEX_LINUX_CACHE_FIXTURE_DIR,
}, () => {
  for (const descriptor of SOURCES.filter((source) => source.file !== MAIN_FILE)) {
    const source = fs.readFileSync(path.join(process.env.OPENCODEX_LINUX_CACHE_FIXTURE_DIR, descriptor.file));
    assert.equal(digest(source), descriptor.hash);
    const variants = [source];
    if (descriptor.optimizedHash) {
      const { OfficialRuntimeOptimizer } = require("../dist/official/OfficialRuntimeOptimizer.js");
      let optimized = source.toString("utf8");
      // 使用项目自己的静态变换，不运行官方模块，也不修改原始样本。
      const optimizer = new OfficialRuntimeOptimizer({ fileSystem: {
        readDir: () => [{ name: descriptor.file, isFile: () => true }],
        readText: () => optimized,
        writeFile: (_, value) => { optimized = value; },
      } });
      optimizer.optimize("synthetic-official-bundle");
      assert.equal(digest(optimized), descriptor.optimizedHash);
      variants.push(optimized);
    }
    for (const variant of variants) {
      const h = harness({ source: variant, sourceFile: descriptor.file, sources: [descriptor] });
      h.install();
      h.load(h.target, { _compile(code) { new vm.Script(code, { filename: descriptor.file }); } });
      assert.equal(h.hook.status().coverage[descriptor.surface], true);
      assert.equal(h.hook.status().patchCount, 1);
    }
  }
});
