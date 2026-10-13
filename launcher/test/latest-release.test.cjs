const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fetchLatestReleaseState,
  markLatestReleaseChecking,
  __test: { releaseVersionChanged, latestReleaseStateFromPayload, trustedReleaseUrl },
} = require("../latest-release.cjs");

const repositoryUrl = "https://github.com/Wolf-L/OpenCodex";
const windows = { platform: "win32", arch: "x64" };
function release(tag = "v2.2.0", names = [`OpenCodex Setup ${tag.replace(/^v/, "")}.exe`]) {
  // 夹具保留 GitHub 的上传状态、大小和独立下载 URL，覆盖发布页正确但附件错误的情况。
  return {
    tag_name: tag, html_url: `${repositoryUrl}/releases/tag/${tag}`, draft: false, prerelease: false,
    assets: names.map((name) => ({
      name, state: "uploaded", size: 1024,
      browser_download_url: `${repositoryUrl}/releases/download/${tag}/${encodeURIComponent(name)}`,
    })),
  };
}
function select(releases, options = windows, version = "2.1.0") {
  return latestReleaseStateFromPayload(releases, version, options);
}

test("stable update comparison never advertises a downgrade or arbitrary tag", () => {
  for (const remote of ["v2.1.0", "v2.0.9", "v2.2.0-beta.1", "latest", "v02.2.0", "v2.2.0+.", "v2.2.0+foo..bar"]) assert.equal(releaseVersionChanged(remote, "v2.1.0"), false);
  for (const remote of ["v2.1.1", "2.10.0", "3.0.0", "v2.2.0+build.1"]) assert.equal(releaseVersionChanged(remote, "2.1.0"), true);
  assert.equal(releaseVersionChanged("2.1.0+new", "2.1.0+old"), false);
});

test("release selection skips Linux-only latest tags and sorts compatible stable versions numerically", () => {
  const state = select([
    release("linux-2.9.0-only", ["OpenCodex-2.9.0-linux-arm64.deb"]),
    release("v2.10.0", ["OpenCodex-2.10.0-linux-arm64.deb"]),
    release("v2.3.0"), release("v2.2.0"), release("v2.9.0"),
  ]);
  assert.equal(state.status, "available");
  assert.equal(state.tagName, "v2.9.0");
  assert.equal(state.assetName, "OpenCodex Setup 2.9.0.exe");
  assert.equal(state.htmlUrl, repositoryUrl + "/releases/tag/v2.9.0");
});

test("five supported native targets require their own installer or graphical archive", () => {
  const cases = [
    [windows, "OpenCodex Setup 2.2.0.exe"],
    [{ platform: "darwin", arch: "x64" }, "OpenCodex-2.2.0-x64.dmg"],
    [{ platform: "darwin", arch: "arm64" }, "OpenCodex-2.2.0-arm64.dmg"],
    [{ platform: "linux", arch: "x64" }, "OpenCodex-2.2.0-linux-amd64.deb"],
    [{ platform: "linux", arch: "arm64" }, "OpenCodex-2.2.0-linux-arm64.deb"],
  ];
  for (const [options, name] of cases) {
    assert.equal(select([release("v2.2.0", [name])], options).available, true, name);
    for (const [otherOptions] of cases) {
      if (otherOptions.platform === options.platform && otherOptions.arch === options.arch) continue;
      assert.equal(select([release("v2.2.0", [name])], otherOptions).available, false, JSON.stringify(otherOptions) + name);
    }
  }
  for (const arch of ["x64", "arm64"]) {
    assert.equal(select([release("v2.2.0", [`OpenCodex-2.2.0-linux-${arch}.tar.gz`])], { platform: "linux", arch }).available, true);
    assert.equal(select([release("v2.2.0", [`OpenCodex-2.2.0-linux-headless-${arch}.tar.gz`])], { platform: "linux", arch }).available, false);
  }
  assert.equal(select([release()], { platform: "win32", arch: "arm64" }).status, "no-compatible-release");
});

test("draft, prerelease, malformed tags and foreign or mismatched release pages cannot advertise updates", () => {
  for (const field of ["draft", "prerelease"]) assert.equal(select([{ ...release(), [field]: true }]).available, false);
  for (const url of [
    "https://github.com/RyensX/OpenCodex/releases/tag/v2.2.0",
    "https://evil.test/Wolf-L/OpenCodex/releases/tag/v2.2.0",
    "https://user@github.com/Wolf-L/OpenCodex/releases/tag/v2.2.0",
    repositoryUrl + "/releases/tag/v2.3.0",
    repositoryUrl + "/releases/tag/v2.2.0?redirect=elsewhere",
    repositoryUrl + "/releases/tag/v2.2.0#assets",
  ]) {
    assert.equal(select([{ ...release(), html_url: url }]).available, false, url);
  }
  assert.equal(trustedReleaseUrl("https://github.com/other/OpenCodex/releases/tag/v2.2.0"), "");
});

test("asset names, uploaded state, nonempty size and exact repository/tag URLs must all match", () => {
  const good = release();
  for (const patch of [
    { state: "starter" }, { size: 0 }, { size: -1 }, { size: "1024" }, { name: "OpenCodex Setup 2.3.0.exe" },
    { browser_download_url: good.assets[0].browser_download_url.replace("Wolf-L", "attacker") },
    { browser_download_url: good.assets[0].browser_download_url.replace("/v2.2.0/", "/v2.3.0/") },
    { browser_download_url: good.assets[0].browser_download_url.replace("https:", "http:") },
    { browser_download_url: good.assets[0].browser_download_url + "?redirect=elsewhere" },
    { browser_download_url: "https://github.com/Wolf-L/OpenCodex/releases/download/v2.2.0/%ZZ" },
  ]) {
    const state = select([{ ...good, assets: [{ ...good.assets[0], ...patch }] }]);
    assert.equal(state.status, "no-compatible-release", JSON.stringify(patch));
    assert.equal(state.available, false);
    assert.equal(state.htmlUrl, "");
  }
});

test("no compatible package is distinct from no newer version and never exposes an open target", () => {
  const current = release("v2.1.0");
  for (const releases of [[], [release("v2.2.0", [])]]) {
    const state = select(releases);
    assert.equal(state.status, "no-compatible-release");
    assert.equal(state.htmlUrl, "");
    assert.equal(state.assetName, "");
  }
  for (const releases of [[current], [release("v2.0.0")], [current, release("v2.2.0", [])]]) {
    const state = select(releases);
    assert.equal(state.status, "up-to-date");
    assert.equal(state.available, false);
  }
  assert.throws(() => select({ message: "not an array" }), /invalid release list/);
  assert.throws(() => select([current], windows, "local-dev"), /invalid current/);
});

test("checking and errors clear a formerly available target", async () => {
  const previousState = select([release()]);
  const checking = markLatestReleaseChecking(previousState);
  assert.equal(checking.status, "checking");
  assert.equal(checking.available, false);
  assert.equal(checking.htmlUrl, "");
  const state = await fetchLatestReleaseState({
    currentVersionLabel: "2.1.0", previousState,
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  assert.equal(state.status, "error");
  assert.equal(state.available, false);
  assert.equal(state.htmlUrl, "");
  assert.equal(state.assetName, "");
  assert.match(state.error, /429/);
});

test("release check uses bounded read-only listing fetch with no redirects", async () => {
  let requested;
  const state = await fetchLatestReleaseState({ currentVersionLabel: "2.1.0", timeoutMs: 10,
    fetchImpl: (url, options) => { requested = [url, options]; return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("timeout")))); },
  });
  assert.equal(requested[0], "https://api.github.com/repos/Wolf-L/OpenCodex/releases?per_page=30&page=1");
  assert.equal(requested[1].redirect, "error");
  assert.equal(state.status, "error"); assert.equal(state.available, false); assert.match(state.error, /timeout/);
});

test("successful fetch applies caller platform and invalid JSON is a check failure", async () => {
  const state = await fetchLatestReleaseState({
    currentVersionLabel: "2.1.0", platform: "linux", arch: "arm64",
    fetchImpl: async () => Response.json([release("v2.2.0", ["OpenCodex-2.2.0-linux-arm64.deb"])]),
  });
  assert.equal(state.status, "available");
  assert.equal(state.assetName, "OpenCodex-2.2.0-linux-arm64.deb");
  const invalid = await fetchLatestReleaseState({
    currentVersionLabel: "2.1.0",
    fetchImpl: async () => Response.json({ message: "bad response" }),
  });
  assert.equal(invalid.status, "error");
});

test("bounded pagination finds older compatible releases without following Link headers", async () => {
  const urls = [], signals = [];
  const state = await fetchLatestReleaseState({ currentVersionLabel: "2.1.0", ...windows,
    fetchImpl: async (url, options) => {
      urls.push(url); signals.push(options.signal);
      return Response.json(urls.length === 1 ? Array.from({ length: 30 }, () => release("linux-9.0.0", [])) : [release()],
        { headers: { link: '<https://untrusted.test/next>; rel="next"' } });
    },
  });
  assert.equal(state.status, "available");
  assert.equal(urls.length, 2);
  assert.equal(urls[1], "https://api.github.com/repos/Wolf-L/OpenCodex/releases?per_page=30&page=2");
  assert.equal(signals[0], signals[1]);
});

test("truncated listing and oversized streamed bodies fail without an actionable release", async () => {
  let pages = 0;
  const truncated = await fetchLatestReleaseState({ currentVersionLabel: "2.1.0", ...windows,
    fetchImpl: async () => { pages++; return Response.json(Array.from({ length: 30 }, () => release())); },
  });
  assert.equal(pages, 3); assert.equal(truncated.status, "error"); assert.equal(truncated.htmlUrl, "");
  // 不提供 Content-Length，验证实际读取上限而非仅相信服务端声明。
  const oversized = await fetchLatestReleaseState({ currentVersionLabel: "2.1.0",
    fetchImpl: async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
  });
  assert.equal(oversized.status, "error"); assert.match(oversized.error, /size limit/);
});

test("one deadline covers stalled response bodies and clears the previous target", async () => {
  const state = await fetchLatestReleaseState({ currentVersionLabel: "2.1.0", timeoutMs: 10,
    previousState: select([release()]), platform: "linux", arch: "arm64",
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) { signal.addEventListener("abort", () => controller.error(new Error("body timeout")), { once: true }); },
    })),
  });
  assert.equal(state.status, "error"); assert.match(state.error, /body timeout/);
  assert.equal(state.htmlUrl, ""); assert.equal(state.platform, "linux"); assert.equal(state.arch, "arm64");
});
