"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { patchThirdPartyInputCompat, THIRD_PARTY_INPUT_MARKER, runtimeSource } = require("../runtime/http/third-party-input-compat.cjs");
const fixture = platform => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/third-party-input", platform + ".json"), "utf8"));
// 夹具仅保留已审计的组件、额度 atom 与导入声明；完整厂商资源仍来自用户的本机安装。
const sourceFor = f => f.imports.join("\n") + "\n" + f.atom + "\n" + f.component + f.next;
const config = { model_provider: "custom", model_providers: { custom: { base_url: "https://provider.example/v1", wire_api: "responses" } } };
const platforms = {
  windows: { quota: "un", next: ",dn=", gate: "q", host: "ht", thread: "ft", read: "Q", provider: "xu", atom: "FN", scope: "Re", state: "rn", react: "tZ", remote: "fe", remoteHome: "le", direct: "ye", native: "Yt", disabled: "Wn" },
  linux: { quota: "cn", next: ",Y=", gate: "Z", host: "pt", thread: "ut", read: "X", provider: "_u", atom: "IN", scope: "Le", state: "tn", react: "nZ", remote: "de", remoteHome: "ce", direct: "ve", native: "qt", disabled: "Wn" },
};

for (const [platform, c] of Object.entries(platforms)) {
  test(`${platform} audited composer patch is idempotent and leaves atom/submit/auth logic intact`, () => {
    const f = fixture(platform), source = sourceFor(f);
    let missed = 0;
    const patched = patchThirdPartyInputCompat(source, () => missed++);
    assert.notEqual(patched, source);
    assert.equal(missed, 0);
    assert.equal(patchThirdPartyInputCompat(patched), patched);
    assert.ok(patched.includes(f.atom), "official quota/auth data are not rewritten");
    const original = new RegExp(`${c.quota}=${c.gate}\\(${c.atom}\\)&&${c.host}===\x60local\x60`).exec(f.component)[0];
    const start = patched.indexOf("opencodexCurrentThreadProvider="), end = patched.indexOf(c.next, start);
    const restored = patched.slice(0, start) + original + patched.slice(end);
    assert.equal(restored.replace(runtimeSource() + "\n", ""), source, "only the local quota assignment changes");
  });

  test(`${platform} rejects altered, partial, ambiguous and different provider contracts`, () => {
    const f = fixture(platform), source = sourceFor(f);
    const cases = [source.replace("isConfigDataPending", "isConfigUnknown"), source.replace(".rate_limit?.allowed", ".other_limit?.allowed"), source.replace("VP as ", "WRONG as "), source.replace("app-shared-", "unknown-shared-"), source + f.component + f.next, source.replace(f.atom, ""), source.replace(f.component, f.component.slice(0, -20))];
    for (const input of cases) {
      let failed = 0;
      assert.equal(patchThirdPartyInputCompat(input, () => failed++), input);
      assert.equal(failed, 1);
    }
    assert.equal(patchThirdPartyInputCompat("unrelated bundle", () => assert.fail()), "unrelated bundle");
  });

  test(`${platform} executes the patched assignment with live session, preference and configuration changes`, () => {
    const f = fixture(platform), patched = patchThirdPartyInputCompat(sourceFor(f));
    const start = patched.indexOf("opencodexCurrentThreadProvider="), end = patched.indexOf(c.next, start);
    const expression = patched.slice(start, end);
    let enabled = true, threadProvider = "custom", quota = true, hookCalls = 0;
    const sandbox = { URL, window: { OpenCodexPluginSystem: { plugins: { isEnabled: () => enabled }, preferences: { get: () => enabled } } } };
    sandbox[c.host] = "local"; sandbox[c.thread] = "thread-1";
    sandbox[c.provider] = {}; sandbox[c.atom] = {};
    sandbox[c.scope] = { value: { kind: "local", cloudThreadPrototype: null } };
    sandbox[c.state] = { isConfigDataPending: false, resolvedConfig: config };
    sandbox[c.react] = { useSyncExternalStore: (_subscribe, read) => { hookCalls++; return read(); } };
    sandbox[c.read] = (atom, thread) => { assert.equal(atom, sandbox[c.provider]); assert.equal(thread, sandbox[c.thread]); return threadProvider; };
    sandbox[c.gate] = atom => { assert.equal(atom, sandbox[c.atom]); return quota; };
    sandbox[c.remote] = null; sandbox[c.remoteHome] = null; sandbox[c.direct] = false; sandbox[c.native] = null;
    vm.createContext(sandbox);
    vm.runInContext(runtimeSource(), sandbox);
    const render = () => vm.runInContext(`(()=>{let ${expression};return ${c.quota}})()`, sandbox);
    assert.equal(render(), false, "third-party route is usable when official quota is exhausted");
    enabled = false; assert.equal(render(), true);
    enabled = true; threadProvider = "openai"; assert.equal(render(), true, "official route remains blocked");
    threadProvider = null; assert.equal(render(), true, "unknown existing thread never uses default provider");
    threadProvider = "custom"; sandbox[c.state].isConfigDataPending = true; assert.equal(render(), true);
    sandbox[c.state].isConfigDataPending = false; assert.equal(render(), false);
    sandbox[c.host] = "remote"; assert.equal(render(), false, "original local quota branch is false for remote host");
    sandbox[c.host] = "local"; sandbox[c.direct] = true; assert.equal(render(), true);
    sandbox[c.direct] = false; sandbox[c.scope].value.kind = "cloud"; assert.equal(render(), true);
    sandbox[c.scope].value.kind = "new"; sandbox[c.thread] = null; threadProvider = null; assert.equal(render(), false);
    sandbox[c.state].resolvedConfig = { ...config, model_provider: "openai" }; assert.equal(render(), true);
    quota = false; assert.equal(render(), false, "does not introduce a new block");
    assert.equal(hookCalls, 12, "hook order stays unconditional across all cases");

    // 真实组件仍保留每个非额度发送禁用项；不通过 DOM 强行开启按钮。
    const submit = new RegExp(`let ([\\w$]+)=([^;]{1,180}\\|\\|${c.quota}),[\\w$]+;`).exec(f.component);
    assert.ok(submit);
    const terms = submit[2].split("||");
    for (let active = 0; active < terms.length - 1; active++) {
      const values = {};
      for (const term of terms) for (const name of term.match(/[A-Za-z_$][\w$]*/g) || []) if (!['isLoading'].includes(name)) values[name] = false;
      const target = terms[active];
      if (target.includes("?.")) values[target.split("?.")[0]] = { isLoading: true };
      else for (const name of target.split("&&")) values[name] = true;
      values[c.quota] = false;
      assert.equal(vm.runInNewContext(submit[2], values), true, target + " still blocks");
    }
  });
}

test("preference subscription responds to local and cross-tab changes and removes listeners", () => {
  let notify = 0, removed = 0, handler, storage;
  const window = {
    OpenCodexPluginSystem: { plugins: { isEnabled: () => true }, events: { on: (event, callback) => { assert.equal(event, "plugin:enabled-changed"); handler = callback; return () => removed++; } } },
    addEventListener: (event, callback) => { assert.equal(event, "storage"); storage = callback; },
    removeEventListener: (event, callback) => { assert.equal(event, "storage"); assert.equal(callback, storage); removed++; },
  };
  const sandbox = { window, URL };
  vm.runInNewContext(runtimeSource(), sandbox);
  const dispose = sandbox.opencodexSubscribeThirdPartyInput(() => notify++);
  handler({ id: "unrelated" }); storage({ key: "unrelated" }); assert.equal(notify, 0);
  handler({ id: "opencodex.third-party-input-compat" }); storage({ key: "opencodex_web_settings_v1" }); storage({ key: null }); assert.equal(notify, 3);
  dispose(); assert.equal(removed, 2);
  window.OpenCodexPluginSystem = null; assert.equal(sandbox.opencodexThirdPartyInputEnabled(), false);
});
