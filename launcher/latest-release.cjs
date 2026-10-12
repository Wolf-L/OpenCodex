"use strict";

const metadata = require("../package.json");
const repository = new URL(metadata.homepage).pathname.replace(/^\/|\/$/g, "");
const DEFAULT_RELEASE_API_URL = `https://api.github.com/repos/${repository}/releases/latest`;
const RELEASE_TIMEOUT_MS = 10000;

function createInitialLatestReleaseState() {
  return {
    checking: false,
    tagName: "",
    htmlUrl: "",
    available: false,
    lastCheckedAt: null,
    error: "",
  };
}

function markLatestReleaseChecking(previousState) {
  return {
    ...createInitialLatestReleaseState(),
    ...(previousState || {}),
    checking: true,
    error: "",
  };
}

function parseVersion(value) {
  // 稳定更新通道只接受完整 semver；旧版本、预发布和任意标签不显示升级按钮。
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || "").trim());
  if (!match) return null;
  const result = match.slice(1).map(Number);
  return result.every(Number.isSafeInteger) ? result : null;
}

function releaseVersionChanged(tagName, currentVersionLabel) {
  const remote = parseVersion(tagName), local = parseVersion(currentVersionLabel);
  if (!remote || !local) return false;
  for (let i = 0; i < 3; i++) { if (remote[i] !== local[i]) return remote[i] > local[i]; }
  return false;
}

function trustedReleaseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    // 更新入口只允许 GitHub 上当前仓库的 release 页面，避免异常接口响应扩大外链范围。
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port) return "";
    if (url.username || url.password || !url.pathname.startsWith(`/${repository}/releases/tag/`)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function latestReleaseStateFromPayload(payload, currentVersionLabel) {
  const tagName = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
  let htmlUrl = trustedReleaseUrl(payload.html_url);
  try { if (htmlUrl && decodeURIComponent(new URL(htmlUrl).pathname.split("/releases/tag/")[1]) !== tagName) htmlUrl = ""; }
  catch { htmlUrl = ""; }
  const available = !payload.draft && !payload.prerelease && releaseVersionChanged(tagName, currentVersionLabel) && !!htmlUrl;

  return {
    checking: false,
    tagName,
    // 只有确认有差异版本时才保存可打开链接，按钮隐藏时不会留下可点击目标。
    htmlUrl: available ? htmlUrl : "",
    available,
    lastCheckedAt: new Date().toISOString(),
    error: "",
  };
}

function latestReleaseErrorState(previousState, error) {
  return {
    ...createInitialLatestReleaseState(),
    ...(previousState || {}),
    checking: false,
    available: false,
    htmlUrl: "",
    lastCheckedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
}

async function fetchLatestReleaseState(options) {
  const currentVersionLabel = options && options.currentVersionLabel;
  const releaseApiUrl = (options && options.releaseApiUrl) || DEFAULT_RELEASE_API_URL;
  const fetchImpl = (options && options.fetchImpl) || globalThis.fetch;
  const previousState = options && options.previousState;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs || RELEASE_TIMEOUT_MS);
  try {
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    const response = await fetchImpl(releaseApiUrl, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `OpenCodex Launcher ${currentVersionLabel || ""}`.trim(),
      },
    });
    if (!response.ok) throw new Error(`latest release failed: HTTP ${response.status}`);
    return latestReleaseStateFromPayload(await response.json(), currentVersionLabel);
  } catch (error) {
    return latestReleaseErrorState(previousState, error);
  } finally { clearTimeout(timer); }
}

module.exports = {
  createInitialLatestReleaseState,
  fetchLatestReleaseState,
  markLatestReleaseChecking,
  __test: { parseVersion, releaseVersionChanged, latestReleaseStateFromPayload, trustedReleaseUrl },
};
