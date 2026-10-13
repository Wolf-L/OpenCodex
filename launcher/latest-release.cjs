"use strict";

const metadata = require("../package.json");
const repository = new URL(metadata.homepage).pathname.replace(/^\/|\/$/g, "");
// 独立 Linux 发布会覆盖 GitHub 的 latest 标记；从有界发布列表中按平台和版本选择。
const DEFAULT_RELEASE_API_URL = `https://api.github.com/repos/${repository}/releases`;
const RELEASE_TIMEOUT_MS = 10000;
const RELEASE_PAGE_SIZE = 30;
const RELEASE_MAX_PAGES = 3;
const RELEASE_MAX_BYTES = 4 * 1024 * 1024;

function createInitialLatestReleaseState() {
  return {
    checking: false,
    status: "idle",
    platform: process.platform,
    arch: process.arch,
    tagName: "",
    htmlUrl: "",
    assetName: "",
    available: false,
    lastCheckedAt: null,
    error: "",
  };
}

function markLatestReleaseChecking(previousState) {
  // 检查期间撤销上次可点击目标，失败后也不会继续打开过期链接。
  return {
    ...createInitialLatestReleaseState(),
    platform: previousState?.platform || process.platform,
    arch: previousState?.arch || process.arch,
    lastCheckedAt: previousState?.lastCheckedAt || null,
    checking: true,
    status: "checking",
  };
}

function parseVersion(value) {
  // 稳定更新通道只接受完整 semver；构建元数据不参与版本先后比较。
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(String(value || "").trim());
  if (!match) return null;
  const result = match.slice(1).map(Number);
  return result.every(Number.isSafeInteger) ? result : null;
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

function releaseVersionChanged(tagName, currentVersionLabel) {
  const remote = parseVersion(tagName), local = parseVersion(currentVersionLabel);
  return !!remote && !!local && compareVersions(remote, local) > 0;
}

function trustedGithubUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

function trustedReleaseUrl(value, tagName) {
  const url = trustedGithubUrl(value);
  if (!url) return "";
  const prefix = `/${repository}/releases/tag/`;
  if (!url.pathname.startsWith(prefix)) return "";
  try {
    const tag = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!tag || tag.includes("/") || (tagName !== undefined && tag !== tagName)) return "";
    return url.toString();
  } catch { return ""; }
}

function platformAssetNames(tagName, platform, arch) {
  const version = tagName.replace(/^v/, "");
  // 文件名匹配当前发布流水线的产物；不把未知架构或 headless 压缩包当作 Launcher 安装包。
  if (platform === "win32" && arch === "x64") return [`OpenCodex Setup ${version}.exe`];
  if (platform === "darwin" && ["x64", "arm64"].includes(arch)) return [`OpenCodex-${version}-${arch}.dmg`];
  if (platform === "linux" && ["x64", "arm64"].includes(arch)) return [
    `OpenCodex-${version}-linux-${arch === "x64" ? "amd64" : arch}.deb`,
    `OpenCodex-${version}-linux-${arch}.tar.gz`,
  ];
  return [];
}

function matchingAsset(payload, tagName, platform, arch) {
  if (!Array.isArray(payload.assets)) return null;
  for (const name of platformAssetNames(tagName, platform, arch)) {
    const asset = payload.assets.find((item) => {
      if (!item || item.name !== name || item.state !== "uploaded" || !Number.isSafeInteger(item.size) || item.size <= 0) return false;
      const url = trustedGithubUrl(item.browser_download_url);
      if (!url) return false;
      try { return decodeURIComponent(url.pathname) === `/${repository}/releases/download/${tagName}/${name}`; }
      catch { return false; }
    });
    if (asset) return asset;
  }
  return null;
}

function latestReleaseStateFromPayload(payload, currentVersionLabel, options = {}) {
  const localVersion = parseVersion(currentVersionLabel);
  if (!localVersion) throw new Error("invalid current application version");
  if (!Array.isArray(payload)) throw new Error("invalid release list response");
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const releases = payload.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || entry.draft || entry.prerelease) return [];
    const tagName = typeof entry.tag_name === "string" ? entry.tag_name.trim() : "";
    const version = parseVersion(tagName);
    const htmlUrl = trustedReleaseUrl(entry.html_url, tagName);
    if (!version || !htmlUrl) return [];
    return [{ tagName, version, htmlUrl, asset: matchingAsset(entry, tagName, platform, arch) }];
  }).sort((left, right) => compareVersions(right.version, left.version));

  const newer = releases.filter((release) => compareVersions(release.version, localVersion) > 0);
  const candidate = newer.find((release) => release.asset);
  // 没有本机产物和没有更新分开呈现；发布列表为空时也不能声称本机已是最新版。
  const status = candidate ? "available" : !releases.some((release) => release.asset) ? "no-compatible-release" : "up-to-date";
  return {
    ...createInitialLatestReleaseState(),
    status,
    platform,
    arch,
    tagName: candidate?.tagName || newer[0]?.tagName || releases[0]?.tagName || "",
    htmlUrl: candidate?.htmlUrl || "",
    assetName: candidate?.asset.name || "",
    available: !!candidate,
    lastCheckedAt: new Date().toISOString(),
  };
}

function latestReleaseErrorState(error, options) {
  return {
    ...createInitialLatestReleaseState(),
    status: "error",
    platform: options.platform || process.platform,
    arch: options.arch || process.arch,
    lastCheckedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
}

async function readReleasePage(response) {
  const declaredSize = Number(response.headers?.get("content-length"));
  if (declaredSize > RELEASE_MAX_BYTES) throw new Error("release response exceeds size limit");
  // 在读取时限制响应大小，不能先无界 JSON 解码再截断发布列表。
  const reader = response.body?.getReader();
  if (!reader) throw new Error("release response body unavailable");
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RELEASE_MAX_BYTES) throw new Error("release response exceeds size limit");
      chunks.push(Buffer.from(value));
    }
    const payload = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!Array.isArray(payload) || payload.length > RELEASE_PAGE_SIZE) throw new Error("invalid release list response");
    return payload;
  } finally { void reader.cancel().catch(() => {}); }
}

async function fetchLatestReleaseState(options = {}) {
  const { currentVersionLabel, releaseApiUrl = DEFAULT_RELEASE_API_URL, fetchImpl = globalThis.fetch } = options;
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, RELEASE_TIMEOUT_MS) : RELEASE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    const releases = [];
    for (let page = 1; page <= RELEASE_MAX_PAGES; page++) {
      // 分页地址由固定端点构造，不追随响应中的任意 Link；整次检查共用十秒上限。
      const url = new URL(releaseApiUrl);
      url.searchParams.set("per_page", String(RELEASE_PAGE_SIZE));
      url.searchParams.set("page", String(page));
      const response = await fetchImpl(url.toString(), {
        signal: controller.signal, redirect: "error",
        headers: { accept: "application/vnd.github+json", "user-agent": `OpenCodex Launcher ${currentVersionLabel || ""}`.trim() },
      });
      if (!response.ok) throw new Error(`release check failed: HTTP ${response.status}`);
      const entries = await readReleasePage(response);
      releases.push(...entries);
      if (entries.length < RELEASE_PAGE_SIZE) return latestReleaseStateFromPayload(releases, currentVersionLabel, options);
    }
    // 列表仍可能有遗漏时给出失败，避免把截断结果误称为最新或没有可用包。
    throw new Error("release list exceeds the bounded check limit");
  } catch (error) {
    return latestReleaseErrorState(error, options);
  } finally { clearTimeout(timer); }
}

module.exports = {
  createInitialLatestReleaseState,
  fetchLatestReleaseState,
  markLatestReleaseChecking,
  __test: { parseVersion, releaseVersionChanged, latestReleaseStateFromPayload, trustedReleaseUrl, platformAssetNames },
};
