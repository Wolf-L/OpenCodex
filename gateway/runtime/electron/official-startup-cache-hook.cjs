const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const MAIN_FILE = "main-BklS_2Y2.js";
const SOURCE_HASH = "52fdac56c2983fcf8daec34fb6f522f8ea9b60963e6154c044786c35979c69b3";
const FETCH_ANCHOR = "e=await this.options.applicationNetwork.fetch(u,t)";
const CONTEXT_ANCHOR = "let e;if(o==null){let t={method:a,headers:r,body:E(),redirect:S==null?s:`error`,signal:p,credentials:h?`include`:`same-origin`};e=await this.options.applicationNetwork.fetch(u,t)}else e=await this.performProgressRequest";
const BINDING = "__opencodexOfficialStartupCacheAdapterV1";
const SETTINGS_REASONS = new Set(["enabled", "disabled", "missing", "invalid", "unreadable", "symlink", "non-regular", "oversize", "changed"]);

function sourceHash(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function principalSnapshot(principal) {
  return principal && typeof principal.accountId === "string" && principal.accountId.length > 0 &&
    typeof principal.userId === "string" && principal.userId.length > 0
    ? { accountId: principal.accountId, userId: principal.userId } : null;
}

function abortForPrincipal() {
  // 只返回固定错误，不把原生账号标识或鉴权状态放进日志。
  return new DOMException("The native account changed during startup cache access", "AbortError");
}

function checkAbort(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  throw signal.reason === undefined ? new DOMException("The operation was aborted", "AbortError") : signal.reason;
}

function identityPart(value) {
  const text = String(value || "unknown");
  return /^[a-zA-Z0-9._-]{1,160}$/.test(text) ? text : "unknown";
}

function createOfficialStartupCacheHook(options = {}) {
  const loader = options.moduleLoader || Module;
  const readSource = options.readSource || ((filename) => fs.readFileSync(filename));
  const expectedHash = options.expectedHash || SOURCE_HASH;
  const readSettings = options.readSettings || ((runtimeDir) => require("./official-startup-cache-settings.cjs").readOfficialStartupCacheSettings(runtimeDir));
  const createCache = options.createCache || ((settings) => require("./official-startup-response-cache.cjs").createOfficialStartupResponseCache(settings));
  const classify = options.classifyStartupRequest || ((...args) => require("./official-startup-cache-policy.cjs").classifyStartupRequest(...args));
  const adapterPath = path.resolve(options.adapterPath || __filename);
  let engine = null;
  let target = null;
  let originalExtension = null;
  let extension = null;
  let onHit = null;
  let onState = null;
  const state = { enabled: false, installed: false, supported: false, reason: "not-installed", settingsReason: "missing", patchCount: 0, hitCount: 0, lastHitAt: null };

  function status() {
    return {
      ...state,
      // 本版本只适配桌面 Ude 路径；不能声称覆盖独立 session 的 preauth 或全部官方流量。
      coverage: { desktop: state.supported, preauth: false },
      cache: engine ? engine.status() : null,
    };
  }

  function emitState() {
    // 主模块可能延后加载；通过只含固定状态/汇总数的通知更新兼容诊断，不需要轮询。
    try { onState?.(status()); } catch { /* 诊断回调不能改变官方模块加载结果。 */ }
  }

  function installationResult() {
    emitState();
    return status();
  }

  function install({ bundle, runtimeDir, onHit: callback, onState: stateCallback } = {}) {
    if (typeof stateCallback === "function") onState = stateCallback;
    if (state.installed) return installationResult();
    let settings;
    try { settings = readSettings(runtimeDir); } catch { settings = { enabled: false, reason: "unreadable" }; }
    state.settingsReason = SETTINGS_REASONS.has(settings?.reason) ? settings.reason : "invalid";
    state.enabled = settings?.enabled === true;
    if (!state.enabled) { state.reason = "disabled"; return installationResult(); }
    if (typeof bundle?.bundleDir !== "string" || !bundle.bundleDir || !loader?._extensions || typeof loader._extensions[".js"] !== "function") {
      state.reason = "unsupported-loader";
      return installationResult();
    }
    target = path.resolve(bundle.bundleDir, ".vite", "build", MAIN_FILE);
    if (loader._cache?.[target]) { state.reason = "already-loaded"; return installationResult(); }
    const buildId = `native-startup-v1:${identityPart(bundle.version)}:${identityPart(bundle.build)}:${expectedHash}`;
    originalExtension = loader._extensions[".js"];
    const previousExtension = originalExtension;
    const targetPath = target;
    onHit = typeof callback === "function" ? callback : null;
    const hook = function opencodexOfficialStartupCacheExtension(module, filename) {
      if (!state.installed || extension !== hook || path.resolve(filename) !== targetPath) return previousExtension.apply(this, arguments);
      let patched;
      let candidateEngine;
      state.supported = false;
      try {
        // 磁盘源文件保持原样；完整指纹与唯一上下文必须同时匹配，未知版本直接交回 Node。
        const bytes = readSource(filename);
        const source = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
        if (sourceHash(bytes) !== expectedHash) {
          state.reason = "unsupported-source-hash";
        } else if (source.split(CONTEXT_ANCHOR).length !== 2 || source.includes(BINDING)) {
          state.reason = "unsupported-source-anchor";
        } else {
          const call = `e=await ${BINDING}.fetchDesktop(this.options.applicationNetwork,u,t,k,()=>this.getAppServerConnection(l.h).getCachedAuthenticatedPrincipal(),!h)`;
          // 局部词法绑定不会改变文件的严格模式/顶层初始化顺序，也不改全局 fetch 或 Electron 导出。
          const replacement = `const ${BINDING}=require(${JSON.stringify(adapterPath)});${CONTEXT_ANCHOR.replace(FETCH_ANCHOR, call)}`;
          patched = source.replace(CONTEXT_ANCHOR, replacement);
          candidateEngine = engine || createCache({ directory: settings.directory, buildId, enabled: true });
          if (!candidateEngine || typeof candidateEngine.fetch !== "function" || typeof candidateEngine.status !== "function") throw new Error("Unsupported cache engine");
        }
      } catch {
        state.reason = "source-unavailable";
        patched = null;
      }
      // 委托必须在捕获区外：原扩展抛错时不能被误判为适配失败后再次执行。
      if (!patched) {
        emitState();
        return previousExtension.apply(this, arguments);
      }
      engine = candidateEngine;
      state.supported = true;
      state.reason = "patched";
      state.patchCount += 1;
      // 编译或官方初始化报错必须原样传播，不能再执行一次原模块造成重复副作用。
      try {
        const result = module._compile(patched, filename);
        emitState();
        return result;
      } catch (error) {
        state.supported = false;
        state.reason = "compile-failed";
        emitState();
        throw error;
      }
    };
    extension = hook;
    try {
      loader._extensions[".js"] = hook;
      if (loader._extensions[".js"] !== hook) throw new Error("Unsupported loader");
      state.installed = true;
      state.reason = "awaiting-source";
    } catch {
      state.reason = "unsupported-loader";
    }
    return installationResult();
  }

  async function fetchDesktop(network, input, init, principal, getCurrentPrincipal, allowCache) {
    const upstream = (originalInput, originalInit) => network.fetch(originalInput, originalInit);
    if (!state.installed || !state.supported || !state.enabled || !engine || !allowCache) return upstream(input, init);
    const expected = principalSnapshot(principal);
    let descriptor;
    try { descriptor = await classify(input, init, { namespace: "desktop", principal: expected }); } catch { return upstream(input, init); }
    // 未命中有限端点表时不附加任何验证/异常，完全保留模型调用等无关请求行为。
    if (!descriptor || typeof network.assertAllowed !== "function") return upstream(input, init);
    const publicInitialize = principal == null && descriptor.kind === "statsig-initialize";
    const inputUrl = typeof input === "string" || input instanceof URL ? input : input?.url;
    const originalValidation = descriptor.validateContext;
    const validateContext = () => {
      checkAbort(init?.signal || input?.signal);
      network.assertAllowed(inputUrl);
      if (expected) {
        const current = typeof getCurrentPrincipal === "function" ? principalSnapshot(getCurrentPrincipal()) : null;
        if (!current || current.accountId !== expected.accountId || current.userId !== expected.userId) throw abortForPrincipal();
      } else if (!publicInitialize) throw abortForPrincipal();
      if (typeof originalValidation === "function") originalValidation();
    };
    // 验证回调也交给引擎：异步磁盘读取、网络返回与写盘期间账号/网络策略仍可能改变。
    validateContext();
    let calledUpstream = false;
    const response = await engine.fetch({ ...descriptor, validateContext }, input, init, (originalInput, originalInit) => {
      calledUpstream = true;
      return upstream(originalInput, originalInit);
    });
    validateContext();
    if (!calledUpstream && response?.headers?.get("x-opencodex-startup-cache") === "hit") {
      state.hitCount += 1;
      state.lastHitAt = new Date().toISOString();
      // 兼容性诊断失败不能破坏已验证响应；仅发送固定家族名，不发送请求/账号或正文。
      try { onHit?.({ kind: descriptor.kind }); } catch { /* 诊断只旁观，不影响启动。 */ }
    }
    return response;
  }

  function dispose() {
    state.installed = false;
    state.supported = false;
    state.reason = "disposed";
    if (extension && loader._extensions[".js"] === extension) loader._extensions[".js"] = originalExtension;
    return installationResult();
  }

  return { install, status, fetchDesktop, dispose };
}

const officialStartupCacheHook = createOfficialStartupCacheHook();

module.exports = {
  installOfficialStartupCacheHook: (options) => officialStartupCacheHook.install(options),
  officialStartupCacheStatus: () => officialStartupCacheHook.status(),
  fetchDesktop: (...args) => officialStartupCacheHook.fetchDesktop(...args),
  __test: { createOfficialStartupCacheHook, CONTEXT_ANCHOR, FETCH_ANCHOR, BINDING, MAIN_FILE, SOURCE_HASH },
};
