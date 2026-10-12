const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const MAIN_FILE = "main-BklS_2Y2.js";
const SOURCE_HASH = "52fdac56c2983fcf8daec34fb6f522f8ea9b60963e6154c044786c35979c69b3";
const FETCH_ANCHOR = "e=await this.options.applicationNetwork.fetch(u,t)";
const CONTEXT_ANCHOR = "let e;if(o==null){let t={method:a,headers:r,body:E(),redirect:S==null?s:`error`,signal:p,credentials:h?`include`:`same-origin`};e=await this.options.applicationNetwork.fetch(u,t)}else e=await this.performProgressRequest";
const BINDING = "__opencodexOfficialStartupCacheAdapterV1";
const PREAUTH_ANCHOR = "createPreauthStatsigTransport(){let e=new AbortController,t,n=()=>{e.signal.aborted||e.abort()};return{fetch:async(r,i)=>{e.signal.throwIfAborted(),i?.signal?.throwIfAborted();let a=new Headers(i?.headers);if(this.disposed||!this.allowsPreauthStatsigRequest(r,i?.method??`GET`)||a.has(`authorization`)||a.has(`proxy-authorization`)||a.has(`cookie`))throw Error(`Pre-auth Statsig request is not allowed`);return t??(t=f.session.fromPartition(`codex-preauth-statsig-${(0,C.randomUUID)()}`,{cache:!1}),$n(t),this.preauthStatsigSessions.set(t,{signal:e.signal,dispose:n}),this.applyToSession(t)),t.fetch(r,{...i,credentials:`omit`,redirect:`error`,cache:`no-store`,referrerPolicy:`no-referrer`,signal:i?.signal==null?e.signal:AbortSignal.any([e.signal,i.signal])})},dispose:n}}";
const PREAUTH_FETCH = "t.fetch(r,{...i,credentials:`omit`,redirect:`error`,cache:`no-store`,referrerPolicy:`no-referrer`,signal:i?.signal==null?e.signal:AbortSignal.any([e.signal,i.signal])})";
// 每个入口只接受逐字核验过的官方文件；平台或版本号本身不能代替源码指纹。
const SOURCES = Object.freeze([
  { file: MAIN_FILE, hash: SOURCE_HASH, surface: "desktop" },
  { file: "main-39FdJ_vp.js", hash: "78ffc19681d7605d0b48c8cbfdc185211a58d218c4512647de567519dd5ca3bc",
    // 同一原厂文件经当前项目优化器处理后的完整指纹；不是放宽为只匹配局部锚点。
    optimizedHash: "3f4f022ecb9fd0ee2f6fa7aa48c1411b627e20c97f8e4509654f7fce1102bf33", surface: "desktop" },
  { file: "bootstrap-Du6FqCuH.js", hash: "7c8665efb642d0683d42bb0c2b4ac6c80bfd3c19eecd0fa0ee5a8a9934fa17c4", surface: "preauth" },
]);
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
  const sources = options.sources || (options.expectedHash ? [{ file: MAIN_FILE, hash: options.expectedHash, surface: "desktop" }] : SOURCES);
  const readSettings = options.readSettings || ((runtimeDir) => require("./official-startup-cache-settings.cjs").readOfficialStartupCacheSettings(runtimeDir));
  const createCache = options.createCache || ((settings) => require("./official-startup-response-cache.cjs").createOfficialStartupResponseCache(settings));
  const classify = options.classifyStartupRequest || ((...args) => require("./official-startup-cache-policy.cjs").classifyStartupRequest(...args));
  const adapterPath = path.resolve(options.adapterPath || __filename);
  const engines = { desktop: null, preauth: null };
  const coverage = { desktop: false, preauth: false };
  let targets = [];
  let originalExtension = null;
  let extension = null;
  let onHit = null;
  let onState = null;
  const state = { enabled: false, installed: false, supported: false, reason: "not-installed", settingsReason: "missing", patchCount: 0, hitCount: 0, lastHitAt: null };

  function status() {
    return {
      ...state,
      // 两条原生网络通道分别报告覆盖和统计，桌面 cache 字段保持旧接口。
      coverage: { ...coverage },
      cache: engines.desktop ? engines.desktop.status() : null,
      preauthCache: engines.preauth ? engines.preauth.status() : null,
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
    targets = sources.map((source) => ({ ...source, target: path.resolve(bundle.bundleDir, ".vite", "build", source.file) }));
    // 测试源由调用方提供；生产入口先检查候选文件，未知官方布局不再永久显示 awaiting-source。
    if (!options.readSource) targets = targets.filter((source) => fs.existsSync(source.target));
    if (!targets.length) { state.reason = "unsupported-source-file"; return installationResult(); }
    if (targets.some((source) => loader._cache?.[source.target])) { state.reason = "already-loaded"; return installationResult(); }
    originalExtension = loader._extensions[".js"];
    const previousExtension = originalExtension;
    onHit = typeof callback === "function" ? callback : null;
    const hook = function opencodexOfficialStartupCacheExtension(module, filename) {
      const sourceInfo = targets.find((source) => path.resolve(filename) === source.target);
      if (!state.installed || extension !== hook || !sourceInfo) return previousExtension.apply(this, arguments);
      const surface = sourceInfo.surface;
      let patched;
      let candidateEngine;
      coverage[surface] = false;
      try {
        const bytes = readSource(filename);
        const source = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
        const actualHash = sourceHash(bytes);
        const anchor = surface === "preauth" ? PREAUTH_ANCHOR : CONTEXT_ANCHOR;
        // 磁盘源码不变；完整指纹与唯一词法上下文必须同时通过。
        if (actualHash !== sourceInfo.hash && actualHash !== sourceInfo.optimizedHash) state.reason = "unsupported-source-hash";
        else if (source.split(anchor).length !== 2 || source.includes(BINDING)) state.reason = "unsupported-source-anchor";
        else {
          const binding = `const ${BINDING}=require(${JSON.stringify(adapterPath)});`;
          let replacement;
          if (surface === "preauth") {
            // 原生授权检查、临时 session 和组合取消信号保持原顺序，只替换最终 fetch。
            replacement = anchor.replace("createPreauthStatsigTransport(){", `createPreauthStatsigTransport(){${binding}`)
              .replace(PREAUTH_FETCH, `${BINDING}.fetchPreauth(this,t,r,${PREAUTH_FETCH.slice("t.fetch(r,".length, -1)})`);
          } else {
            const call = `e=await ${BINDING}.fetchDesktop(this.options.applicationNetwork,u,t,k,()=>this.getAppServerConnection(l.h).getCachedAuthenticatedPrincipal(),!h)`;
            replacement = binding + anchor.replace(FETCH_ANCHOR, call);
          }
          patched = source.replace(anchor, replacement);
          // Windows 原有 buildId 完全保留；preauth 使用独立指纹命名空间，绝不读取桌面账号快照。
          const prefix = surface === "preauth" ? "native-preauth-startup-v1" : "native-startup-v1";
          const buildId = `${prefix}:${identityPart(bundle.version)}:${identityPart(bundle.build)}:${actualHash}`;
          const directory = surface === "preauth" ? path.join(settings.directory, "preauth") : settings.directory;
          candidateEngine = engines[surface] || createCache({ directory, buildId, enabled: true });
          if (!candidateEngine || typeof candidateEngine.fetch !== "function" || typeof candidateEngine.status !== "function") throw new Error("Unsupported cache engine");
        }
      } catch { state.reason = "source-unavailable"; patched = null; }
      if (!patched) {
        state.supported = coverage.desktop || coverage.preauth;
        emitState();
        return previousExtension.apply(this, arguments);
      }
      engines[surface] = candidateEngine;
      coverage[surface] = true;
      state.supported = true;
      state.reason = "patched";
      state.patchCount += 1;
      try {
        const result = module._compile(patched, filename);
        emitState();
        return result;
      } catch (error) {
        coverage[surface] = false;
        state.supported = coverage.desktop || coverage.preauth;
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
    const engine = engines.desktop;
    if (!state.installed || !coverage.desktop || !state.enabled || !engine || !allowCache) return upstream(input, init);
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

  async function fetchPreauth(network, session, input, init) {
    const upstream = (originalInput, originalInit) => session.fetch(originalInput, originalInit);
    const engine = engines.preauth;
    if (!state.installed || !coverage.preauth || !state.enabled || !engine) return upstream(input, init);
    let descriptor;
    try { descriptor = await classify(input, init, { namespace: "preauth", principal: null }); } catch { return upstream(input, init); }
    if (!descriptor || descriptor.kind !== "statsig-initialize" || typeof network.allowsPreauthStatsigRequest !== "function") return upstream(input, init);
    const validateContext = () => {
      // init.signal 是原生 scope 与调用者信号的组合；销毁 session 后缓存也必须停止。
      checkAbort(init?.signal);
      const headers = new Headers(init?.headers);
      if (network.disposed || !network.allowsPreauthStatsigRequest(input, init?.method ?? "GET") ||
          headers.has("authorization") || headers.has("proxy-authorization") || headers.has("cookie")) {
        throw new Error("Pre-auth Statsig request is not allowed");
      }
      descriptor.validateContext?.();
    };
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
      try { onHit?.({ kind: descriptor.kind }); } catch { /* 诊断不干预原生 transport。 */ }
    }
    return response;
  }

  function dispose() {
    state.installed = false;
    state.supported = false;
    coverage.desktop = false;
    coverage.preauth = false;
    state.reason = "disposed";
    if (extension && loader._extensions[".js"] === extension) loader._extensions[".js"] = originalExtension;
    return installationResult();
  }

  return { install, status, fetchDesktop, fetchPreauth, dispose };
}

const officialStartupCacheHook = createOfficialStartupCacheHook();

module.exports = {
  installOfficialStartupCacheHook: (options) => officialStartupCacheHook.install(options),
  officialStartupCacheStatus: () => officialStartupCacheHook.status(),
  fetchDesktop: (...args) => officialStartupCacheHook.fetchDesktop(...args),
  fetchPreauth: (...args) => officialStartupCacheHook.fetchPreauth(...args),
  __test: { SOURCES, PREAUTH_ANCHOR, PREAUTH_FETCH, createOfficialStartupCacheHook, CONTEXT_ANCHOR, FETCH_ANCHOR, BINDING, MAIN_FILE, SOURCE_HASH },
};
