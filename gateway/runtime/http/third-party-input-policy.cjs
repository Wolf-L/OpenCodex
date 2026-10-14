"use strict";

function canUseThirdPartyInput(options) {
  // 函数会被序列化到官方页面，所有判断必须独立完成，不能依赖模块变量。
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  if (!isRecord(options) || options.enabled !== true || options.hostId !== "local") return false;
  if (options.cloudThreadPrototype || options.remoteProject || options.nativeWork) return false;
  const state = options.configState;
  if (!isRecord(state) || state.isConfigDataPending !== false || !isRecord(state.resolvedConfig)) return false;
  const config = state.resolvedConfig;

  // 现有会话只能使用自身明确的路由；未知路由绝不借用当前默认 Provider。
  let providerId;
  if (options.scopeKind === "new") {
    if (options.threadId != null || (options.threadProvider != null && options.threadProvider !== "")) return false;
    if (!owns(config, "model_provider")) return false;
    providerId = config.model_provider;
  } else if (options.scopeKind === "local") {
    if (typeof options.threadId !== "string" || !options.threadId.trim()) return false;
    providerId = options.threadProvider;
  } else {
    return false;
  }
  if (typeof providerId !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(providerId)) return false;
  if (["__proto__", "constructor", "prototype", "openai", "codex_vscode_copilot"].includes(providerId.toLowerCase())) return false;
  if (!owns(config, "model_providers") || !isRecord(config.model_providers) || !owns(config.model_providers, providerId)) return false;
  const provider = config.model_providers[providerId];
  if (!isRecord(provider) || !owns(provider, "base_url") || typeof provider.base_url !== "string") return false;
  if (!owns(provider, "wire_api") || !["responses", "chat"].includes(provider.wire_api)) return false;

  // 只识别显式配置的第三方端点，URL 规范化后再次排除官方域名及其子域名。
  const endpoint = provider.base_url;
  if (!/^https?:\/\/[^/]/i.test(endpoint) || /[\s\\?#]/.test(endpoint)) return false;
  if (endpoint.slice(endpoint.indexOf("://") + 3).split("/")[0].includes("@")) return false;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname || parsed.search || parsed.hash) return false;
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!hostname) return false;
  if (["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return false;
  return true;
}

module.exports = { canUseThirdPartyInput };
