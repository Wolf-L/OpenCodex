const launcher = window.openCodexLauncher;
let currentState = null;
let pendingHostMode = "";

function $(id) {
  return document.getElementById(id);
}

function text(id, value) {
  const node = $(id);
  if (node) node.textContent = value || "未知";
}

function pathButton(id, value) {
  const node = $(id);
  if (!node) return;
  node.textContent = value || "未找到";
  node.title = value || "";
  node.dataset.path = value || "";
  node.disabled = !value;
}

function formatDateTime(value) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function selectedHostMode() {
  const checked = document.querySelector('input[name="hostMode"]:checked');
  return checked ? checked.value : "local";
}

function renderHostMode(hostMode) {
  const value = pendingHostMode || (hostMode === "lan" ? "lan" : "local");
  for (const input of document.querySelectorAll('input[name="hostMode"]')) {
    input.checked = input.value === value;
    input.disabled = !!pendingHostMode;
  }
}

function renderPort(port) {
  const input = $("portInput");
  if (!input || document.activeElement === input) return;
  input.value = port ? String(port) : "";
}

function renderUrls(state) {
  const urls = state.urls || {};
  const primary = urls.primary || state.url || "";

  const list = $("lanUrls");
  list.innerHTML = "";
  if (!primary) {
    list.hidden = true;
    return;
  }
  list.hidden = false;
  const button = document.createElement("button");
  button.className = "url-chip";
  button.type = "button";
  button.textContent = primary;
  button.title = primary;
  button.dataset.copyUrl = primary;
  list.appendChild(button);
}

function renderStatus(state) {
  const pill = $("statusPill");
  const running = !!state.running;
  const connected = !!(state.status && state.status.ok);
  const appServerMode = state.status && state.status.appServer ? state.status.appServer.mode : "";

  if (connected) {
    pill.textContent = appServerMode === "connected" ? "已就绪" : "Gateway 已启动";
    pill.classList.remove("offline");
  } else if (running) {
    pill.textContent = "启动中";
    pill.classList.remove("offline");
  } else {
    pill.textContent = "未运行";
    pill.classList.add("offline");
  }
}

function render(state) {
  currentState = state;
  const status = state.status || {};
  const gateway = status.gateway || {};
  const runtime = status.runtime || {};
  const official = status.officialBundle || {};
  const appServer = status.appServer || {};
  const paths = state.paths || {};
  const settings = state.settings || {};

  renderStatus(state);
  renderUrls(state);
  if (pendingHostMode && settings.hostMode === pendingHostMode) pendingHostMode = "";
  renderHostMode(settings.hostMode);
  renderPort(settings.port || state.port);
  text("serviceTitle", settings.hostMode === "lan" ? "局域网服务" : "本机服务");

  text("codexVersion", official.version || "未知");
  text("codexBuild", official.build || "未知");
  text("cacheUpdatedAt", formatDateTime(official.cacheProcessedAt));
  pathButton("codexAppPath", official.sourceAppPath);
  pathButton("sourceAsarPath", official.sourceAsarPath);
  pathButton("codexBinaryPath", official.codexBinaryPath);

  text("gatewayPid", state.pid ? String(state.pid) : "未运行");
  text("gatewayStartedAt", formatDateTime(state.startedAt));
  text("gatewayListen", gateway.host && gateway.port ? `${gateway.host}:${gateway.port}` : `${state.host}:${state.port}`);
  text("appServerMode", appServer.mode || "未知");
  text("nodeVersion", gateway.nodeVersion || "未知");
  text("electronVersion", gateway.electronVersion || "未知");

  pathButton("configPath", runtime.configPath || paths.configPath);
  pathButton("logPath", paths.logPath);
  pathButton("reportsDir", runtime.reportsDir || paths.reportsDir);
  pathButton("officialBundleDir", official.bundleDir || paths.officialBundleDir);
  text("authStatus", state.auth && state.auth.enabled ? "已启用" : "未启用");

  const error = $("lastError");
  const message = state.lastError || (appServer.lastError ? `app-server: ${appServer.lastError}` : "");
  if (message) {
    error.hidden = false;
    error.textContent = message;
  } else {
    error.hidden = true;
    error.textContent = "";
  }
}

async function refresh() {
  render(await launcher.getState());
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!target) return;

  if (target.id === "openCodex") {
    await launcher.openUrl();
    return;
  }
  if (target.id === "copyUrl") {
    const urls = currentState && currentState.urls ? currentState.urls : {};
    await launcher.copy(urls.primary || (currentState && currentState.url) || "");
    return;
  }
  if (target.dataset && target.dataset.copyUrl) {
    await launcher.copy(target.dataset.copyUrl);
    return;
  }
  if (target.id === "restart") {
    render(await launcher.restart());
    return;
  }
  if (target.id === "savePort") {
    const input = $("portInput");
    render(await launcher.updatePort(input ? input.value : ""));
    return;
  }
  if (target.id === "savePassword") {
    const input = $("passwordInput");
    render(await launcher.updatePassword(input ? input.value : ""));
    if (input) input.value = "";
    return;
  }
  if (target.id === "clearPassword") {
    const input = $("passwordInput");
    if (input) input.value = "";
    render(await launcher.updatePassword(""));
    return;
  }
  if (target.id === "openLogs") {
    await launcher.openLogs();
    return;
  }
  if (target.classList && target.classList.contains("path")) {
    const targetPath = target.dataset.path;
    if (targetPath) await launcher.revealPath(targetPath);
  }
});

document.addEventListener("keydown", async (event) => {
  const target = event.target;
  if (!target || target.id !== "portInput" || event.key !== "Enter") return;
  event.preventDefault();
  render(await launcher.updatePort(target.value));
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  if (!target || target.name !== "hostMode") return;
  const hostMode = selectedHostMode();
  pendingHostMode = hostMode;
  renderHostMode(hostMode);
  render(await launcher.updateHostMode(hostMode));
});

launcher.onState(render);
refresh().catch((error) => {
  render({
    running: false,
    url: "",
    paths: {},
    status: null,
    lastError: error instanceof Error ? error.message : String(error),
  });
});
