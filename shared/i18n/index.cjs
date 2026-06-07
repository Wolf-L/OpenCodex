const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_LOCALE = "en-US";
const ZH_CN = "zh-CN";
const EN_US = "en-US";

const MESSAGES = {
  // 文案表是资源数据，不放在逻辑源码里；这里仅按 locale 装载对应 JSON。
  [ZH_CN]: require("./locales/zh-CN.json"),
  [EN_US]: require("./locales/en-US.json"),
};

const localeOverrideCache = new Map();

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function normalizeLocale(value, fallback = DEFAULT_LOCALE) {
  const raw = String(value || "").trim().replace(/_/g, "-").toLowerCase();
  if (!raw) return fallback;
  if (raw === "zh" || raw.startsWith("zh-")) return ZH_CN;
  if (raw === "en" || raw.startsWith("en-")) return EN_US;
  return fallback;
}

function messagesForLocale(locale) {
  return MESSAGES[normalizeLocale(locale)] || MESSAGES[DEFAULT_LOCALE];
}

function formatMessage(messages, key, values) {
  const template = (messages && messages[key]) || MESSAGES[DEFAULT_LOCALE][key] || key;
  if (!values || typeof values !== "object") return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  );
}

function t(locale, key, values) {
  return formatMessage(messagesForLocale(locale), key, values);
}

function stripTomlComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === "\"") {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === "\"") quote = "";
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return value.slice(0, i);
  }
  return value;
}

function parseTomlStringScalar(rawValue) {
  const value = stripTomlComment(String(rawValue || "")).trim();
  if (!value || value === "null" || value === "~") return null;
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function readCodexLocaleOverride(codexHome = defaultCodexHome()) {
  const configPath = path.join(codexHome, "config.toml");
  try {
    const stat = fs.statSync(configPath);
    const cached = localeOverrideCache.get(configPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;

    // 官方 Codex 把界面语言写在 config.toml 的 localeOverride；这里只读这一项，避免碰触其它配置。
    const raw = fs.readFileSync(configPath, "utf8");
    const match = raw.match(/^\s*localeOverride\s*=\s*(.*)$/m);
    const value = match ? parseTomlStringScalar(match[1]) : null;
    const normalized = value ? normalizeLocale(value) : null;
    localeOverrideCache.set(configPath, { mtimeMs: stat.mtimeMs, size: stat.size, value: normalized });
    return normalized;
  } catch {
    return null;
  }
}

function systemLocaleCandidates(extraCandidates) {
  const candidates = [];
  if (Array.isArray(extraCandidates)) candidates.push(...extraCandidates);
  try {
    candidates.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {}
  candidates.push(process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG);
  return candidates.filter(Boolean);
}

function resolveOpenCodexLocale(options = {}) {
  const explicitLocale = options.envLocale || process.env.OPENCODEX_LOCALE || process.env.CODEX_WEB_LOCALE;
  if (explicitLocale) {
    return { locale: normalizeLocale(explicitLocale), source: "env" };
  }

  const codexHome = options.codexHome || defaultCodexHome();
  const codexLocale = readCodexLocaleOverride(codexHome);
  if (codexLocale) {
    return { locale: codexLocale, source: "codex-config" };
  }

  /**
   * localeOverride 为空代表官方的 Auto Detect。
   * OpenCodex 只维护中英文文案，所以系统语言不是中文时统一落到英文。
   */
  const candidates = systemLocaleCandidates(options.systemLocales);
  const zhCandidate = candidates.find((candidate) => normalizeLocale(candidate, "") === ZH_CN);
  return { locale: zhCandidate ? ZH_CN : EN_US, source: zhCandidate ? "system" : "default" };
}

function resolveOpenCodexI18n(options = {}) {
  const resolved = resolveOpenCodexLocale(options);
  return {
    ...resolved,
    messages: messagesForLocale(resolved.locale),
  };
}

module.exports = {
  DEFAULT_LOCALE,
  EN_US,
  MESSAGES,
  ZH_CN,
  formatMessage,
  messagesForLocale,
  normalizeLocale,
  readCodexLocaleOverride,
  resolveOpenCodexI18n,
  resolveOpenCodexLocale,
  t,
};
