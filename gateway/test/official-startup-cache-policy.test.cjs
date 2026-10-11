const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { classifyStartupRequest, __test } = require("../runtime/electron/official-startup-cache-policy.cjs");
const { createOfficialStartupResponseCache } = require("../runtime/electron/official-startup-response-cache.cjs");

const principal = { accountId: "test-workspace", userId: "test-user" };
const context = { namespace: "desktop", principal };
const bootstrapUrl = "https://chatgpt.com/backend-api/wham/statsig/bootstrap";
const sdkUrl = "https://ab.chatgpt.com/v1/initialize?k=client-public-test&st=js-client&sv=3.34.0&t=1&sid=one";
const evaluation = { has_updates: true, time: 1234, feature_gates: {}, dynamic_configs: {}, layer_configs: {}, hash_used: "djb2" };
const bootstrap = { app_session_id: "one", app_version: "1", stable_id: "device-one", locale: "zh-CN", system_name: "Windows", system_version: "1", brand_name: "codex", window_type: "main", build_flavor: "prod" };
const sdk = { user: { userID: "sdk-user", customIDs: { stableID: "device-one" }, custom: { account_id: "workspace-one", plan: "test", codex_app_session_id: "one" } }, hash: "djb2", deltasResponseRequested: false, full_checksum: null, statsigMetadata: { sessionID: "one", stableID: "device-one", appVersion: "1", locale: "zh-CN" } };
const post = (body) => ({ method: "POST", body: JSON.stringify(body) });
const classify = (url, init = {}, ctx = context) => classifyStartupRequest(url, init, ctx);
const copy = (value) => JSON.parse(JSON.stringify(value));

test("only reviewed startup GETs and read-only bootstrap POSTs are candidates", () => {
  for (const [pathname, kind] of [
    ["/wham/accounts/check", "accounts"], ["/accounts/check/v4-2023-04-27", "accounts"],
    ["/accounts/id/settings", "workspace-settings"], ["/accounts/id/workspace_policy", "workspace-policy"],
    ["/accounts/id/workspace_policy/acknowledge", "workspace-policy-acknowledge"],
  ]) {
    const url = `https://chatgpt.com/backend-api${pathname}`;
    assert.equal(classify(url).kind, kind);
    assert.equal(classify(url, { method: "POST" }), null);
  }
  assert.equal(classify(bootstrapUrl, post(bootstrap)).kind, "statsig-bootstrap");
  for (const url of [
    "https://api.openai.com/v1/responses", "https://auth.openai.com/oauth/token", "https://chatgpt.com/backend-api/conversation",
    "https://chatgpt.com/backend-api/accounts/id/settings/extra", "https://chatgpt.com/backend-api/devicecheck",
    "https://ab.chatgpt.com/ces/v1/rgstr", "https://ab.chatgpt.com/v1/log_event", "https://relay.test/backend-api/wham/accounts/check",
  ]) assert.equal(classify(url, post(sdk)), null);
});

test("account keys require real account and user and retain final origin, URL and variants", () => {
  const url = "https://chatgpt.com/backend-api/wham/accounts/check";
  const normal = classify(url);
  for (const value of [null, {}, { accountId: "workspace" }, { userId: "user" }, { accountId: " ", userId: "user" }]) {
    assert.equal(classify(url, { headers: { "ChatGPT-Account-Id": "not-an-identity" } }, { namespace: "desktop", principal: value }), null);
  }
  for (const alternative of [
    classify(url, {}, { namespace: "desktop", principal: { ...principal, userId: "other" } }),
    classify(url, {}, { namespace: "desktop", principal: { ...principal, accountId: "other" } }),
    classify(url.replace("chatgpt.com", "gov.chatgpt.com")), classify(`${url}?timezone_offset_min=60`),
    classify(url, { headers: { "oai-language": "en" } }),
  ]) assert.notDeepEqual(alternative.keyParts, normal.keyParts);
  assert.deepEqual(classify(url, { headers: { authorization: "Bearer synthetic", cookie: "synthetic", "x-oai-is-update": "synthetic" } }).keyParts, normal.keyParts);
  assert.equal(classify(url, {}, { ...context, namespace: "preauth" }), null);
});

test("ambiguous URLs, methods, bodies and malformed account segments bypass", () => {
  for (const url of [
    "http://chatgpt.com/backend-api/wham/accounts/check", "https://chatgpt.com:444/backend-api/wham/accounts/check",
    "https://user@chatgpt.com/backend-api/wham/accounts/check", "https://chatgpt.com/backend-api/wham/accounts/check#fragment",
    "https://chatgpt.com/other/../backend-api/wham/accounts/check", "https://chatgpt.com/other/%2e%2e/backend-api/wham/accounts/check",
    "https://chatgpt.com/backend-api/accounts/a%2Fb/settings", "https://chatgpt.com/backend-api/accounts/a%5Cb/settings",
    "https://chatgpt.com/backend-api/accounts/%00/settings", "https://chatgpt.com/backend-api/accounts/%xx/settings",
  ]) assert.equal(classify(url), null, url);
  const url = "https://chatgpt.com/backend-api/wham/accounts/check";
  assert.equal(classify(url, { method: "HEAD" }), null);
  assert.equal(classify(url, { body: "unexpected" }), null);
  assert.equal(classify(url).validateBody({ error: "failed" }), false);
});

test("bootstrap pins the real snapshot and ignores only app_session_id in request key", () => {
  const original = classify(bootstrapUrl, post(bootstrap));
  assert.deepEqual(classify(bootstrapUrl, post({ ...bootstrap, app_session_id: "two" })).keyParts, original.keyParts);
  for (const field of ["stable_id", "locale", "app_version", "build_flavor", "system_version", "brand_name", "window_type", "unknown_targeting"]) {
    assert.notDeepEqual(classify(bootstrapUrl, post({ ...bootstrap, [field]: "changed" })).keyParts, original.keyParts);
  }
  assert.notDeepEqual(classify(bootstrapUrl, post({ ...bootstrap, desktop_app_beta_enabled: true })).keyParts, original.keyParts);
  const full = { statsigPayload: JSON.stringify({ ...evaluation, user: sdk.user }) };
  assert.equal(original.validateBody(full), true);
  for (const body of [{}, { statsigPayload: "invalid" }, { statsigPayload: JSON.stringify(evaluation) }, { statsigPayload: JSON.stringify({ ...evaluation, user: sdk.user, has_updates: false }) }]) assert.equal(original.validateBody(body), false);
  assert.equal(classify(bootstrapUrl, post({ ...bootstrap, stable_id: undefined })), null);
  assert.equal(classify(bootstrapUrl, post({ ...bootstrap, access_token: "synthetic" })), null);
});

test("SDK normalizes timestamp/session/encoding and delta cursors but retains targeting", () => {
  const first = classify(sdkUrl, post(sdk));
  const next = copy(sdk);
  next.user.custom.codex_app_session_id = "two";
  next.statsigMetadata.sessionID = "two";
  Object.assign(next, { sinceTime: 999, previousDerivedFields: {}, deltasResponseRequested: true, full_checksum: "test-checksum", partialUserMatchSinceTime: 998 });
  const secondUrl = sdkUrl.replace("t=1&sid=one", "t=2&sid=two");
  assert.deepEqual(classify(secondUrl, post(next)).keyParts, first.keyParts);
  const encoded = Buffer.from(JSON.stringify(next), "latin1").toString("base64").split("").reverse().join("");
  assert.deepEqual(classify(`${secondUrl}&se=1`, { method: "POST", body: encoded }).keyParts, first.keyParts);
  assert.deepEqual(classify(sdkUrl, { method: "POST", body: new Uint8Array(Buffer.from(JSON.stringify(sdk))) }).keyParts, first.keyParts);
  assert.deepEqual(classify(sdkUrl, { method: "POST", body: new TextEncoder().encode(JSON.stringify(sdk)).buffer }).keyParts, first.keyParts);
  for (const mutate of [
    (body) => { body.user.userID = "another"; }, (body) => { body.user.custom.account_id = "another"; },
    (body) => { body.user.custom.plan = "another"; }, (body) => { body.user.customIDs.stableID = "another"; },
    (body) => { body.hash = "none"; }, (body) => { body.statsigMetadata.locale = "en"; },
    (body) => { body.statsigMetadata.unknown = "another"; }, (body) => { body.unknown = "another"; },
  ]) {
    const body = copy(sdk); mutate(body);
    assert.notDeepEqual(classify(sdkUrl, post(body)).keyParts, first.keyParts);
  }
  assert.notDeepEqual(classify(sdkUrl.replace("3.34.0", "3.35.0"), post(sdk)).keyParts, first.keyParts);
});

test("SDK bypasses live overlays, recovery, secrets, unknown compression and missing identity", () => {
  for (const extra of [{ responseMode: "live_overlay" }, { hadBadDeltaChecksum: true }, { badChecksum: "x" }, { badMergedConfigs: {} }, { badFullResponse: {} }, { authorization: "synthetic" }]) {
    assert.equal(classify(sdkUrl, post({ ...sdk, ...extra })), null);
  }
  for (const suffix of ["&gz=1", "&gz=0", "&se=2", "&se=1", "&extra=1", "&k=duplicate"]) assert.equal(classify(sdkUrl + suffix, post(sdk)), null);
  for (const name of ["authorization", "cookie", "proxy-authorization", "content-encoding"]) assert.equal(classify(sdkUrl, { ...post(sdk), headers: { [name]: "synthetic" } }), null);
  assert.equal(classify(sdkUrl, post({ ...sdk, user: {} })), null);
  assert.equal(classify(sdkUrl, { method: "POST", body: new ReadableStream() }), null);
  assert.equal(classify(sdkUrl, { method: "POST", body: "x".repeat(256 * 1024 + 1) }), null);
  assert.equal(classify(sdkUrl, { method: "POST", body: "{" }), null);
  const anon = { ...sdk, user: { customIDs: { stableID: "device-only" } } };
  assert.equal(classify(sdkUrl, post(anon), { namespace: "desktop", principal: null }).kind, "statsig-initialize");
});

test("full response predicate never stores no-update, delta, malformed or auth data", () => {
  assert.equal(__test.fullEvaluation(evaluation, "djb2"), true);
  for (const extra of [
    { has_updates: false }, { is_delta: true }, { is_delta: "false" }, { response_mode: "live_overlay" },
    { feature_gates: [] }, { dynamic_configs: null }, { layer_configs: "bad" }, { time: -1 }, { time: Infinity },
    { hash_used: "wrong" }, { deleted_gates: [] }, { deleted_configs: [] }, { deleted_layers: [] },
    { user: { privateAttributes: { access_token: "synthetic" } } },
  ]) assert.equal(__test.fullEvaluation({ ...evaluation, ...extra }, "djb2"), false);
});

test("end-to-end saved full SDK bytes satisfy future delta requests without upstream", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "startup-policy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = createOfficialStartupResponseCache({ directory, enabled: true, buildId: "synthetic" });
  const saved = JSON.stringify({ ...evaluation, user: sdk.user });
  const descriptor = classify(sdkUrl, post(sdk));
  await first.fetch(descriptor, sdkUrl, post(sdk), async () => new Response(saved, { headers: { "content-type": "application/json" } }));
  const restarted = createOfficialStartupResponseCache({ directory, enabled: true, buildId: "synthetic" });
  const next = { ...sdk, sinceTime: 99999, deltasResponseRequested: true, full_checksum: "newer" };
  const response = await restarted.fetch(classify(sdkUrl, post(next)), sdkUrl, post(next), async () => { throw new Error("must not contact upstream"); });
  assert.equal(await response.text(), saved);
  assert.equal(response.headers.get("x-opencodex-startup-cache"), "hit");
  assert.equal(restarted.status().hits, 1);
});
