const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { canUseThirdPartyInput } = require("../runtime/http/third-party-input-policy.cjs");

function fixture(overrides = {}) {
  // 所有配置均为合成数据，不读取用户配置，也不需要密钥。
  return {
    enabled: true,
    hostId: "local",
    scopeKind: "new",
    cloudThreadPrototype: false,
    remoteProject: false,
    nativeWork: false,
    threadId: null,
    threadProvider: null,
    configState: {
      isConfigDataPending: false,
      resolvedConfig: {
        model_provider: "third_party-1.dev",
        model_providers: {
          "third_party-1.dev": { base_url: "https://provider.example/v1", wire_api: "responses" },
          alternate: { base_url: "http://127.0.0.1:8080/v1", wire_api: "chat" },
        },
      },
    },
    ...overrides,
  };
}

test("explicit local new-thread configuration permits supported third-party transports without secrets", () => {
  const options = fixture();
  assert.equal(canUseThirdPartyInput(options), true);
  options.configState.resolvedConfig.model_provider = "alternate";
  assert.equal(canUseThirdPartyInput(options), true);
});

test("only explicit enablement and local scope are accepted", () => {
  for (const enabled of [false, undefined, null, 0, 1, "true", {}]) assert.equal(canUseThirdPartyInput(fixture({ enabled })), false);
  for (const hostId of [undefined, null, "", "remote", "LOCAL", 1]) assert.equal(canUseThirdPartyInput(fixture({ hostId })), false);
  for (const scopeKind of [undefined, null, "", "cloud", "remote", "native"]) assert.equal(canUseThirdPartyInput(fixture({ scopeKind })), false);
  for (const value of [undefined, null, [], true, "options"]) assert.equal(canUseThirdPartyInput(value), false);
});

test("cloud, remote-project and native-work contexts remain unchanged", () => {
  for (const flag of ["cloudThreadPrototype", "remoteProject", "nativeWork"]) {
    for (const value of [true, {}, "remote"]) assert.equal(canUseThirdPartyInput(fixture({ [flag]: value })), false);
    assert.equal(canUseThirdPartyInput(fixture({ [flag]: undefined })), true);
  }
});

test("new-thread routing rejects an existing or ambiguous thread context", () => {
  for (const threadId of ["thread", "", 0, false, {}]) assert.equal(canUseThirdPartyInput(fixture({ threadId })), false);
  for (const threadProvider of ["alternate", " ", false, 0, {}]) assert.equal(canUseThirdPartyInput(fixture({ threadProvider })), false);
  assert.equal(canUseThirdPartyInput(fixture({ threadId: undefined, threadProvider: "" })), true);
});

test("existing thread's provider wins over the default and never falls back", () => {
  const options = fixture({ scopeKind: "local", threadId: "thread-1", threadProvider: "alternate" });
  options.configState.resolvedConfig.model_provider = "openai";
  assert.equal(canUseThirdPartyInput(options), true);
  options.configState.resolvedConfig.model_provider = "third_party-1.dev";
  options.threadProvider = "openai";
  assert.equal(canUseThirdPartyInput(options), false);
  for (const threadProvider of [undefined, null, "", " ", 0, {}, "missing"]) assert.equal(canUseThirdPartyInput({ ...options, threadProvider }), false);
  for (const threadId of [undefined, null, "", "  ", 1, {}]) assert.equal(canUseThirdPartyInput({ ...options, threadProvider: "alternate", threadId }), false);
});

test("pending, absent and malformed configuration fails closed", () => {
  for (const configState of [undefined, null, [], {}, { resolvedConfig: {} }, { isConfigDataPending: false }]) assert.equal(canUseThirdPartyInput(fixture({ configState })), false);
  for (const pending of [true, undefined, null, 0, "false"]) {
    const options = fixture();
    options.configState.isConfigDataPending = pending;
    assert.equal(canUseThirdPartyInput(options), false);
  }
  for (const resolvedConfig of [null, [], {}, { model_provider: "alternate" }]) {
    assert.equal(canUseThirdPartyInput(fixture({ configState: { isConfigDataPending: false, resolvedConfig } })), false);
  }
});

test("provider switches and pending transitions do not reuse an earlier decision", () => {
  const options = fixture();
  assert.equal(canUseThirdPartyInput(options), true);
  options.configState.isConfigDataPending = true;
  assert.equal(canUseThirdPartyInput(options), false);
  options.configState.isConfigDataPending = false;
  options.configState.resolvedConfig.model_provider = "openai";
  assert.equal(canUseThirdPartyInput(options), false);
  options.configState.resolvedConfig.model_provider = "alternate";
  assert.equal(canUseThirdPartyInput(options), true);
  options.enabled = false;
  assert.equal(canUseThirdPartyInput(options), false);
});

test("reserved, unsafe and inherited provider entries are never trusted", () => {
  for (const id of ["openai", "OpenAI", "codex_vscode_copilot", "CODEX_VSCODE_COPILOT", "__proto__", "constructor", "prototype", "a/b", "a b", "", null, 42]) {
    const options = fixture();
    options.configState.resolvedConfig.model_provider = id;
    options.configState.resolvedConfig.model_providers = Object.fromEntries([[id, { base_url: "https://provider.example", wire_api: "responses" }]]);
    assert.equal(canUseThirdPartyInput(options), false, String(id));
  }
  const options = fixture();
  const config = options.configState.resolvedConfig;
  config.model_providers = Object.create(config.model_providers);
  assert.equal(canUseThirdPartyInput(options), false);
  options.configState.resolvedConfig = Object.create(fixture().configState.resolvedConfig);
  assert.equal(canUseThirdPartyInput(options), false);
});

test("official domains, subdomains, URL normalization and trailing dots cannot opt in", () => {
  for (const domain of ["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com"]) {
    for (const hostname of [domain, `api.${domain}`, `${domain.toUpperCase()}.`, `api.${domain}..`, domain.replace(".", "%2e")]) {
      const options = fixture();
      options.configState.resolvedConfig.model_providers["third_party-1.dev"].base_url = `https://${hostname}/v1`;
      assert.equal(canUseThirdPartyInput(options), false, hostname);
    }
  }
});

test("provider metadata must be explicit own values on an object", () => {
  for (const provider of [null, [], "provider", {}, { base_url: "https://provider.example" }, { wire_api: "responses" }, Object.create({ base_url: "https://provider.example", wire_api: "responses" })]) {
    const options = fixture();
    options.configState.resolvedConfig.model_providers["third_party-1.dev"] = provider;
    assert.equal(canUseThirdPartyInput(options), false);
  }
  const options = fixture();
  const config = options.configState.resolvedConfig;
  config.model_providers = Object.assign(Object.create(null), config.model_providers);
  assert.equal(canUseThirdPartyInput(options), true);
});

test("malformed endpoints, credentials, query strings, fragments and unsupported transports fail closed", () => {
  const endpoints = [undefined, null, 1, "", "/v1", "provider.example", "//provider.example", "ftp://provider.example", "https:provider.example", "https:///provider.example", "https://", "https://user:pass@provider.example", "https://@provider.example", "https://provider.example?", "https://provider.example?a=b", "https://provider.example#", "https://provider.example/#fragment", " https://provider.example", "https://provider.example\n", "https://provider.example\\path", "https://provider.example:99999"];
  for (const endpoint of endpoints) {
    const options = fixture();
    options.configState.resolvedConfig.model_providers["third_party-1.dev"].base_url = endpoint;
    assert.equal(canUseThirdPartyInput(options), false, String(endpoint));
  }
  for (const wireApi of [undefined, null, "", "Responses", "other", 1]) {
    const options = fixture();
    options.configState.resolvedConfig.model_providers["third_party-1.dev"].wire_api = wireApi;
    assert.equal(canUseThirdPartyInput(options), false);
  }
});

test("explicit third-party HTTPS and local development HTTP endpoints are accepted", () => {
  for (const endpoint of ["https://provider.example/v1", "HTTPS://PROVIDER.EXAMPLE:443/v1", "http://localhost:8080/v1", "http://[::1]:8080/v1", "https://openai.com.provider.example/v1", "https://notopenai.com/v1"]) {
    const options = fixture();
    options.configState.resolvedConfig.model_providers["third_party-1.dev"].base_url = endpoint;
    assert.equal(canUseThirdPartyInput(options), true, endpoint);
  }
});

test("decisions leave deeply frozen inputs unchanged", () => {
  const options = fixture();
  const before = JSON.stringify(options);
  function freeze(value) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  assert.equal(canUseThirdPartyInput(freeze(options)), true);
  assert.equal(JSON.stringify(options), before);
});

test("serialized browser policy runs without module globals, secrets or IO", () => {
  // VM 只注入浏览器原生 URL 与测试值，确保响应期注入不依赖 Node 环境。
  const context = vm.createContext({ URL, options: fixture() });
  const source = `(${canUseThirdPartyInput.toString()})(options)`;
  assert.equal(vm.runInContext(source, context), true);
  context.options = fixture({ enabled: false });
  assert.equal(vm.runInContext(source, context), false);
});
