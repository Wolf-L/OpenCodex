"use strict";
const crypto = require("node:crypto");
const { canUseThirdPartyInput } = require("./third-party-input-policy.cjs");

const THIRD_PARTY_INPUT_TOKEN = "codexComposerAdapter.CodexComposerAdapter.interruptThreadError";
const THIRD_PARTY_INPUT_MARKER = "opencodexUseThirdPartyInputPreference";
const THIRD_PARTY_INPUT_PLUGIN = "opencodex.third-party-input-compat";
// 两个平台的 26.1007.21434：完整组件与额度 atom 都须匹配摘要，不能仅凭压缩变量名改写。
const CONTRACTS = Object.freeze([
  { start: "function rpt(e){let t=(0,eZ.c)(253)", end: "function ipt(",
    componentHash: "e102992306a31fe7bf34d4c3a4c826ac0e2295848daff092bd7a9f67d1a971e1",
    atom: "FN", atomHash: "d130184b1423b92ae5982c55dadd65be66c023dfacb3259f41462458df7d4556",
    imports: [["./app-shared-737655e1fb23.js", "Ran as Q", "VP as xu"], ["./app-initial-b8e1c8014bb4.js", "jkt as fAe"]],
    original: "un=q(FN)&&ht===`local`", quota: "un", read: "Q", provider: "xu", thread: "ft", react: "tZ",
    host: "ht", scope: "Re", config: "rn", remote: "fe?.type===`remote`||le!=null", native: "ye||Yt!=null" },
  { start: "function npt(e){let t=(0,tZ.c)(253)", end: "function rpt(",
    componentHash: "f6ee817b6095b0bd3e75a984aef23a660eb54c11b41e9b6ba751fd011b007f32",
    atom: "IN", atomHash: "e0ead43f6260c335d35e2f5844505736f269598976f9e414f7259c1cc296232c",
    imports: [["./app-shared-2d77298f0100.js", "Fan as X", "VP as _u"], ["./app-initial-ed5807835d97.js", "Ekt as efe"]],
    original: "cn=Z(IN)&&pt===`local`", quota: "cn", read: "X", provider: "_u", thread: "ut", react: "nZ",
    host: "pt", scope: "Le", config: "tn", remote: "de?.type===`remote`||ce!=null", native: "ve||qt!=null" },
]);
const hash = (source) => crypto.createHash("sha256").update(source).digest("hex");

function opencodexThirdPartyInputEnabled() {
  try {
    const system = window.OpenCodexPluginSystem;
    // 通用插件 API 兼容旧的非布尔偏好；这项例外必须由字面量 true 明确启用。
    return system?.plugins?.isEnabled("opencodex.third-party-input-compat") === true
      && system.preferences?.get("plugin.opencodex.third-party-input-compat.enabled") === true;
  }
  catch { return false; }
}
function opencodexSubscribeThirdPartyInput(notify) {
  // 同页插件事件与跨标签页 storage 都触发 React 重算，不缓存任一会话的 Provider 结论。
  const handler = (event) => {
    if (event?.id === "opencodex.third-party-input-compat") notify();
  };
  const storage = (event) => {
    if (event.key == null || event.key === "opencodex_web_settings_v1") notify();
  };
  let dispose;
  try { dispose = window.OpenCodexPluginSystem?.events?.on("plugin:enabled-changed", handler); } catch {}
  window.addEventListener("storage", storage);
  return () => { if (typeof dispose === "function") dispose(); window.removeEventListener("storage", storage); };
}
function opencodexUseThirdPartyInputPreference(react) {
  return react.useSyncExternalStore(opencodexSubscribeThirdPartyInput, opencodexThirdPartyInputEnabled, opencodexThirdPartyInputEnabled);
}
function runtimeSource() {
  return [canUseThirdPartyInput.toString(), opencodexThirdPartyInputEnabled.toString(), opencodexSubscribeThirdPartyInput.toString(), opencodexUseThirdPartyInputPreference.toString()].join("\n");
}
function importBindingsMatch(source, declarations) {
  const imports = [...source.matchAll(/import\{([^}]+)\}from["']([^"']+)["']/g)];
  return declarations.every(([file, ...bindings]) => bindings.every(binding => imports.filter(match => match[2] === file && match[1].split(",").includes(binding)).length === 1));
}
function patchThirdPartyInputCompat(source, onMismatch = () => {}) {
  if (!source.includes(THIRD_PARTY_INPUT_TOKEN) || source.includes(THIRD_PARTY_INPUT_MARKER)) return source;
  const supported = [];
  for (const contract of CONTRACTS) {
    const start = source.indexOf(contract.start);
    if (start < 0 || source.indexOf(contract.start, start + 1) >= 0) continue;
    const end = source.indexOf(contract.end, start + contract.start.length);
    if (end < 0) continue;
    const component = source.slice(start, end);
    const atomStart = source.indexOf(`${contract.atom}=`);
    const atomEnd = atomStart < 0 ? -1 : source.indexOf("})})))()}", atomStart);
    if (atomEnd < 0 || hash(component) !== contract.componentHash || hash(source.slice(atomStart, atomEnd + 9)) !== contract.atomHash) continue;
    if (!importBindingsMatch(source, contract.imports) || component.split(contract.original).length !== 2) continue;
    supported.push({ contract, start, end, component });
  }
  // 摘要、模块导入、上下文与唯一性一起失败关闭；不更改全局余额、提交函数或服务端返回。
  if (supported.length !== 1) { onMismatch(); return source; }
  const { contract: c, start, end, component } = supported[0];
  const provider = "opencodexCurrentThreadProvider", enabled = "opencodexInputCompatEnabled";
  if (source.includes(provider) || source.includes(enabled) || source.includes("function canUseThirdPartyInput(")) { onMismatch(); return source; }
  // 两个新 Hook 每次渲染都调用；会话原生 atom 负责订阅 Provider 变化，配置仍来自既有已合并 profile 的 Hook。
  const replacement = `${provider}=${c.read}(${c.provider},${c.thread}),${enabled}=opencodexUseThirdPartyInputPreference(${c.react}),${c.original}&&!canUseThirdPartyInput({enabled:${enabled},hostId:${c.host},scopeKind:${c.scope}.value.kind,cloudThreadPrototype:${c.scope}.value.cloudThreadPrototype,remoteProject:${c.remote},nativeWork:${c.native},threadId:${c.thread},threadProvider:${provider},configState:${c.config}})`;
  return source.slice(0, start) + runtimeSource() + "\n" + component.replace(c.original, replacement) + source.slice(end);
}

module.exports = { THIRD_PARTY_INPUT_TOKEN, THIRD_PARTY_INPUT_MARKER, THIRD_PARTY_INPUT_PLUGIN, patchThirdPartyInputCompat, runtimeSource };
