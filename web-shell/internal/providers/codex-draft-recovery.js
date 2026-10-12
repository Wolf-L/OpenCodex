(function () {
  const w = window;
  const scope = w.__OpenCodexCurrentProviderScope;
  const host = w.__OpenCodexAdapterHost;
  if (!host?.events?.observe || !host?.dom?.observe || !scope?.own) return;
  const scheduler = host.scheduler?.capture?.() || w;
  const STORAGE_KEY = "opencodex.text-drafts.v1";
  const MAX_TEXT = 32_768;
  const MAX_ENTRIES = 8;
  const TTL = 24 * 60 * 60 * 1000;
  // 只认官方主输入框，不采集密码、设置、搜索栏或任意 contenteditable。
  const COMPOSER = '[data-codex-composer="true"][contenteditable="true"]';
  const en = String(w.__CODEX_WEB_CONFIG__?.locale || "zh-CN").startsWith("en");
  const label = (zh, english) => en ? english : zh;
  let entries = [];
  let groups = new WeakMap();
  let sequence = 0;
  let saveTimer = null;
  let saveState = "";
  let captureWarning = "";
  let panel = null;
  let selection = "";
  let disposed = false;
  let composition = new WeakSet();
  let focusedEditor = null;
  let disposeEditorObservation = null;
  let readTimer = null;
  let details, summary, status, notice, select, preview, copy, retry, clear;

  function prune(value) {
    const now = Date.now();
    if (!Array.isArray(value)) return [];
    return value.filter((item) => item && typeof item.id === "string" && item.id.length <= 100 &&
      typeof item.route === "string" && item.route.length <= 256 &&
      typeof item.text === "string" && item.text.trim() && item.text.length <= MAX_TEXT &&
      Number.isFinite(item.updatedAt) && item.updatedAt <= now && now - item.updatedAt < TTL)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES);
  }

  function persist() {
    // 富文本粘贴/撤销可绕过 input；退出前读取当前聚焦编辑器，避免丢失尚未处理的 mutation。
    if (focusedEditor) capture({ target: focusedEditor });
    if (readTimer !== null) scheduler.clearTimeout(readTimer);
    readTimer = null;
    if (saveTimer !== null) scheduler.clearTimeout(saveTimer);
    saveTimer = null;
    entries = prune(entries);
    try {
      // sessionStorage 按来源和标签页隔离，刷新可读；不上传 Gateway，不持久保存到磁盘配置。
      if (entries.length) w.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, entries }));
      else w.sessionStorage.removeItem(STORAGE_KEY);
      saveState = "";
    } catch {
      // 配额/隐私模式失败不能伪称已备份；内存副本仍可手动取回。
      saveState = entries.length
        ? label("浏览器未保存：刷新可能丢失，请先复制。", "Browser storage failed: copy before reloading.")
        : label("无法清除浏览器存储，请在浏览器设置中清理本站点数据。", "Cannot clear browser storage; remove this site's data in browser settings.");
    }
    render();
  }

  try {
    const raw = w.sessionStorage.getItem(STORAGE_KEY);
    if (raw && raw.length <= MAX_ENTRIES * (MAX_TEXT * 6 + 2048)) {
      const saved = JSON.parse(raw);
      if (saved?.schemaVersion === 1) entries = prune(saved.entries);
    }
  } catch {
    saveState = label("无法读取浏览器草稿存储。", "Browser draft storage is unavailable.");
  }

  function routeLabel() {
    // 不保存 query/hash，避免认证令牌或临时参数进入草稿索引；路由仅作提示，绝不据此自动恢复。
    return String(w.location.pathname || "/").slice(0, 256);
  }

  function editorFrom(event) {
    return event?.target?.closest?.(COMPOSER) || null;
  }

  function capture(event) {
    const editor = editorFrom(event);
    if (!editor || editor.isConnected === false || disposed || composition.has(editor) || event.isComposing) return;
    const text = String(editor.innerText || "").replace(/\r\n/g, "\n");
    const route = routeLabel();
    if (!text.trim()) {
      // 清空可能是发送、手动删除或卸载；不能推断发送成功，保留旧副本供用户核对。
      groups.delete(editor);
      return;
    }
    if (text.length > MAX_TEXT) {
      captureWarning = label("文字超过 32K，本次未备份；旧副本仍保留。", "Over 32K characters: not backed up; previous copy kept.");
      render();
      return;
    }
    let group = groups.get(editor);
    if (!group || group.route !== route) {
      group = { id: `${Date.now()}-${++sequence}`, route };
      groups.set(editor, group);
    }
    const previous = entries.find((item) => item.id === group.id);
    captureWarning = "";
    if (previous?.text === text) { render(); return; }
    entries = prune([{ ...group, text, updatedAt: Date.now() }, ...entries.filter((item) => item.id !== group.id)]);
    scope.effects?.primary?.emit();
    saveState = label("正在保存文字副本…", "Saving text copy…");
    // 短节流而非尾沿防抖，持续输入最多每 250ms 保存一次；输入事件已同步更新内存副本。
    if (saveTimer === null) saveTimer = scheduler.setTimeout(persist, 250);
    render();
  }

  function render() {
    if (!panel || disposed) return;
    const state = w.__OpenCodexConnectionState?.state || "connecting";
    const connected = state === "connected";
    summary.textContent = `${connected ? "●" : label("○ 未连接 ·", "○ Disconnected ·")} ${label("文字草稿", "Text drafts")} (${entries.length})`;
    panel.dataset.connection = state;
    const messages = {
      connected: label("Gateway 已连接", "Gateway connected"),
      connecting: label("正在连接 Gateway…", "Connecting to Gateway…"),
      reconnecting: label("连接中断，正在退避重试。请勿重复发送。", "Disconnected; retrying with backoff. Do not resend blindly."),
      offline: label("浏览器报告离线，自动重试已暂停；局域网可手动重试。", "Browser reports offline; auto-retry paused. LAN may still work."),
      paused: label("后台重试已暂停，回到页面后恢复。", "Retries paused in background; resume on return."),
    };
    status.textContent = messages[state] || messages.connecting;
    retry.hidden = connected;
    notice.textContent = captureWarning || saveState || label("本标签页文字副本，最多 8 份 / 24 小时；不含附件、格式和项目设置。可能已发送，请核对后手动粘贴，不会自动恢复或重发。共用设备请清空副本。", "This tab only: up to 8 text copies / 24 hours. No attachments, formatting or project settings. Copies may already be sent; verify and paste manually. Never restored or resent automatically. Clear on shared devices.");
    if (!details.open) return;
    // 只在展开时建立小型列表；不扫描全页，不干预官方编辑器/焦点/IME。
    if (!entries.some((item) => item.id === selection)) selection = entries[0]?.id || "";
    select.replaceChildren();
    for (const item of entries) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${new Date(item.updatedAt).toLocaleTimeString()} · ${item.route}`;
      select.appendChild(option);
    }
    select.value = selection;
    preview.value = entries.find((item) => item.id === selection)?.text || "";
    copy.disabled = !preview.value;
    clear.disabled = !entries.length;
  }

  function observe(target, type, callback) {
    host.events.observe({ key: {}, target, type, callback });
  }

  function watchEditor(event) {
    const editor = editorFrom(event);
    if (!editor || editor === focusedEditor) return;
    if (focusedEditor) capture({ target: focusedEditor });
    disposeEditorObservation?.();
    focusedEditor = editor;
    // 只观察当前聚焦的官方输入框，捕获 ProseMirror 自行处理的粘贴、撤销和格式事务。
    // 不观察 document/body，更不在流式正文变化时扫描整页。
    disposeEditorObservation = host.dom.observe({
      key: {}, root: editor, options: { childList: true, subtree: true, characterData: true },
      callback() {
        if (readTimer !== null) return;
        readTimer = scheduler.setTimeout(() => {
          readTimer = null;
          if (focusedEditor) capture({ target: focusedEditor });
        }, 0);
      },
    });
  }

  function unwatchEditor(event) {
    if (editorFrom(event) !== focusedEditor) return;
    capture(event);
    disposeEditorObservation?.();
    disposeEditorObservation = null;
    focusedEditor = null;
    if (readTimer !== null) scheduler.clearTimeout(readTimer);
    readTimer = null;
  }

  function clearDrafts() {
    // 清空是用户明确意图；先解除聚焦观察，不能在 persist/pagehide 时从仍显示的输入框复活副本。
    disposeEditorObservation?.();
    disposeEditorObservation = null;
    focusedEditor = null;
    entries = [];
    groups = new WeakMap();
    selection = "";
    captureWarning = "";
    persist();
  }

  function mount() {
    if (panel || !document.body || disposed) return;
    const style = document.createElement("style");
    style.textContent = `
      #opencodex-draft-recovery { position:fixed; right:12px; top:52px; z-index:1000; font:12px/1.5 system-ui; color:CanvasText; color-scheme:light dark; }
      #opencodex-draft-recovery details { background:Canvas; border:1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius:12px; box-shadow:0 3px 16px #0002; }
      #opencodex-draft-recovery summary { cursor:pointer; padding:6px 10px; min-height:32px; display:flex; align-items:center; }
      #opencodex-draft-recovery[data-connection=connected] summary { color:#23814a; }
      #opencodex-draft-recovery .draft-body { padding:0 12px 12px; width:min(340px,calc(100vw - 48px)); max-height:65dvh; overflow:auto; }
      #opencodex-draft-recovery select, #opencodex-draft-recovery textarea { box-sizing:border-box; width:100%; background:Canvas; color:CanvasText; border:1px solid #8888; border-radius:6px; padding:6px; margin:4px 0; font:inherit; }
      #opencodex-draft-recovery textarea { height:140px; font-size:16px; }
      #opencodex-draft-recovery button { min-height:36px; padding:4px 10px; margin:6px 6px 0 0; border:1px solid #8888; border-radius:8px; cursor:pointer; }
      #opencodex-draft-recovery p { margin:8px 0; }
      @media (max-width:820px) { #opencodex-draft-recovery { right:8px; top:48px; } }
    `;
    panel = document.createElement("aside");
    panel.id = "opencodex-draft-recovery";
    panel.setAttribute("aria-label", label("连接与文字草稿", "Connection and text drafts"));
    const create = (tag, parent, text) => {
      const node = document.createElement(tag);
      if (text) node.textContent = text;
      parent.appendChild(node);
      return node;
    };
    details = create("details", panel);
    summary = create("summary", details);
    const body = create("div", details); body.className = "draft-body";
    status = create("p", body); status.setAttribute("role", "status");
    retry = create("button", body, label("立即重试", "Retry now")); retry.type = "button";
    notice = create("p", body);
    select = create("select", body); select.setAttribute("aria-label", label("文字副本", "Text copies"));
    preview = create("textarea", body); preview.readOnly = true;
    preview.setAttribute("aria-label", label("草稿文字（只读）", "Draft text (read only)"));
    copy = create("button", body, label("复制文字", "Copy text")); copy.type = "button";
    clear = create("button", body, label("清空副本", "Clear copies")); clear.type = "button";
    observe(details, "toggle", () => { entries = prune(entries); render(); });
    observe(select, "change", () => { selection = select.value; render(); });
    observe(retry, "click", () => w.dispatchEvent(new CustomEvent("opencodex:retry-connection")));
    observe(clear, "click", clearDrafts);
    observe(copy, "click", async () => {
      try {
        await w.navigator.clipboard.writeText(preview.value);
        notice.textContent = label("已复制。请核对会话和发送状态，再手动粘贴。", "Copied. Verify conversation and send status, then paste manually.");
      } catch {
        // HTTP 局域网可能不允许 Clipboard API，保留可选择的只读文本，不降级安全设置。
        preview.focus(); preview.select();
        notice.textContent = label("请使用系统复制菜单复制选中文字。", "Use your system Copy action for the selected text.");
      }
    });
    document.head.appendChild(style);
    document.body.appendChild(panel);
    scope.own(() => { panel.remove(); style.remove(); });
    render();
  }

  observe(document, "input", capture);
  observe(document, "focusin", watchEditor);
  observe(document, "focusout", unwatchEditor);
  observe(document, "compositionstart", (event) => { const editor = editorFrom(event); if (editor) composition.add(editor); });
  observe(document, "compositionend", (event) => { const editor = editorFrom(event); if (editor) composition.delete(editor); capture({ target: editor }); });
  observe(document, "visibilitychange", () => { if (document.visibilityState === "hidden") persist(); });
  observe(w, "pagehide", persist);
  observe(w, "opencodex:connection-state", render);
  observe(w, "opencodex:clear-drafts", clearDrafts);
  if (document.body) mount();
  else observe(document, "DOMContentLoaded", mount);
  scope.own(() => { persist(); disposed = true; disposeEditorObservation?.(); focusedEditor = null; composition = new WeakSet(); });
})();
