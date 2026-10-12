const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchLatestReleaseState, __test: { releaseVersionChanged, latestReleaseStateFromPayload, trustedReleaseUrl } } = require("../latest-release.cjs");

test("stable update comparison never advertises a downgrade or arbitrary tag", () => {
  for (const remote of ["v2.1.0", "v2.0.9", "v2.2.0-beta.1", "latest", "v02.2.0"]) assert.equal(releaseVersionChanged(remote, "v2.1.0"), false);
  for (const remote of ["v2.1.1", "2.10.0", "3.0.0"]) assert.equal(releaseVersionChanged(remote, "2.1.0"), true);
});
test("updates stay in the packaged repository and exclude draft/prerelease", () => {
  const payload = { tag_name: "v2.2.0", html_url: "https://github.com/Wolf-L/OpenCodex/releases/tag/v2.2.0" };
  assert.equal(latestReleaseStateFromPayload(payload, "2.1.0").available, true);
  for (const key of ["draft", "prerelease"]) assert.equal(latestReleaseStateFromPayload({ ...payload, [key]: true }, "2.1.0").available, false);
  for (const url of ["https://github.com/RyensX/OpenCodex/releases/tag/v2.2.0", "https://evil.test/Wolf-L/OpenCodex/releases/tag/v2.2.0", "https://user@github.com/Wolf-L/OpenCodex/releases/tag/v2.2.0"]) assert.equal(trustedReleaseUrl(url), "");
});
test("release check uses bounded read-only fetch with no redirects", async () => {
  let requested;
  const state = await fetchLatestReleaseState({ currentVersionLabel: "2.1.0", timeoutMs: 10,
    fetchImpl: (url, options) => { requested = [url, options]; return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("timeout")))); },
  });
  assert.equal(requested[0], "https://api.github.com/repos/Wolf-L/OpenCodex/releases/latest");
  assert.equal(requested[1].redirect, "error"); assert.equal(state.available, false); assert.match(state.error, /timeout/);
});
