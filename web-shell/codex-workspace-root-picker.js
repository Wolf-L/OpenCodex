(function () {
  const w = window;
  if (w.__codexWorkspaceRootPickerInstalled) return;
  w.__codexWorkspaceRootPickerInstalled = true;

  // 这个模块只负责“远端浏览器输入路径”的交互，真正的 Electron/官方 IPC 仍由 bridge 转发。
  const WORKSPACE_ROOT_VALIDATE_CHANNEL = "opencodex:validate-workspace-root";
  const dialogState = {
    focusInput: null,
    promise: null,
  };

  function bridgeHelpers() {
    // polyfill 先暴露最小 helper 面，picker 不直接复制 IPC、toast 和 i18n 的底层实现。
    return w.__codexWebBridgeHelpers && typeof w.__codexWebBridgeHelpers === "object"
      ? w.__codexWebBridgeHelpers
      : {};
  }

  function runtimeMessages() {
    // bridge 尚未准备好时仍可从公开运行时配置读取文案，保证弹窗不会裸露 key。
    const cfg = w.__CODEX_WEB_CONFIG__ || {};
    return cfg.messages && typeof cfg.messages === "object" ? cfg.messages : {};
  }

  function t(key, values) {
    const helper = bridgeHelpers().t;
    if (typeof helper === "function") return helper(key, values);
    const template = runtimeMessages()[key] || key;
    if (!values || typeof values !== "object") return template;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    );
  }

  function invoke(channel, ...args) {
    const helper = bridgeHelpers().invoke;
    if (typeof helper === "function") return helper(channel, ...args);
    return Promise.reject(new Error("OpenCodex bridge is not ready."));
  }

  function normalizeErrorMessage(error) {
    const helper = bridgeHelpers().normalizeErrorMessage;
    if (typeof helper === "function") return helper(error);
    if (!error) return "";
    if (typeof error === "string") return error;
    if (error instanceof Error && error.message) return error.message;
    if (error && typeof error === "object" && typeof error.error === "string") return error.error;
    return String(error);
  }

  function showToast(payload) {
    // 正常走 bridge 的官方 toast 兼容层；兜底只发 window message，避免这里再造 toast DOM。
    const helper = bridgeHelpers().showToast;
    if (typeof helper === "function") {
      helper(payload);
      return;
    }
    try {
      w.dispatchEvent(new MessageEvent("message", { data: { type: "codex-web:toast", ...payload } }));
    } catch {}
  }

  function loopbackHostname(hostname) {
    // localhost 场景应该继续走官方 Electron 目录选择器，只有远端访问才接管为路径输入。
    const normalized = String(hostname || "").trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
    if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return true;
    return normalized === "::ffff:127.0.0.1" || normalized === "[::ffff:127.0.0.1]";
  }

  function shouldUseNativeWorkspaceRootPicker() {
    try {
      return loopbackHostname(w.location && w.location.hostname);
    } catch {
      return false;
    }
  }

  function hasWorkspaceRootPayload(payload) {
    return !!payload && typeof payload === "object" && typeof payload.root === "string" && payload.root.trim();
  }

  function shouldHandleMessage(payload) {
    // 只有“使用现有文件夹”且 payload 没有 root 时才接管；带 root 的消息交还官方逻辑。
    return (
      payload &&
      typeof payload === "object" &&
      payload.type === "electron-add-new-workspace-root-option" &&
      !hasWorkspaceRootPayload(payload) &&
      !shouldUseNativeWorkspaceRootPicker()
    );
  }

  function localizedError(error) {
    // gateway 优先返回 errorKey；未知错误才降级到原始 message，便于排查异常链路。
    const response = error && error.response && typeof error.response === "object" ? error.response : null;
    const responseKey = response && typeof response.errorKey === "string" ? response.errorKey : "";
    const fallbackKey =
      error && typeof error.workspaceRootErrorKey === "string"
        ? error.workspaceRootErrorKey
        : "web.workspaceRoot.error.unavailable";
    const fallbackMessage = normalizeErrorMessage((response && response.error) || error);
    const key = responseKey || fallbackKey;
    const message = t(key, { error: fallbackMessage });
    if (message && message !== key) return message;
    return fallbackMessage || t("web.workspaceRoot.error.unavailable");
  }

  function showErrorToast(error) {
    showToast({
      level: "danger",
      source: "codex-web-workspace-root",
      description: localizedError(error),
    });
  }

  function showDialog(onSubmit) {
    if (dialogState.promise) {
      // 同一时刻只允许一个路径弹窗，重复点击只把焦点拉回输入框。
      if (typeof dialogState.focusInput === "function") dialogState.focusInput();
      return dialogState.promise;
    }

    dialogState.promise = new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "codex-web-workspace-root-backdrop";
      backdrop.setAttribute("role", "presentation");

      const panel = document.createElement("form");
      panel.className = "codex-web-workspace-root-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "codex-web-workspace-root-title");

      // DOM 结构刻意贴近官方 compact dialog：标题、说明、单行输入、底部操作按钮。
      const header = document.createElement("div");
      header.className = "codex-web-workspace-root-header";

      const title = document.createElement("h2");
      title.id = "codex-web-workspace-root-title";
      title.className = "codex-web-workspace-root-title";
      title.textContent = t("web.workspaceRoot.dialog.title");
      header.appendChild(title);

      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "codex-web-workspace-root-close";
      closeButton.setAttribute("aria-label", t("web.workspaceRoot.dialog.close"));
      closeButton.textContent = "x";
      header.appendChild(closeButton);
      panel.appendChild(header);

      const description = document.createElement("p");
      description.className = "codex-web-workspace-root-description";
      description.textContent = t("web.workspaceRoot.dialog.description");
      panel.appendChild(description);

      const input = document.createElement("input");
      input.className = "codex-web-workspace-root-input";
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = t("web.workspaceRoot.dialog.placeholder");
      input.setAttribute("aria-label", t("web.workspaceRoot.dialog.pathLabel"));
      panel.appendChild(input);

      const actions = document.createElement("div");
      actions.className = "codex-web-workspace-root-actions";

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "codex-web-workspace-root-button";
      cancelButton.textContent = t("common.cancel");
      actions.appendChild(cancelButton);

      const submitButton = document.createElement("button");
      submitButton.type = "submit";
      submitButton.className = "codex-web-workspace-root-button codex-web-workspace-root-button-primary";
      submitButton.textContent = t("web.workspaceRoot.dialog.confirm");
      actions.appendChild(submitButton);
      panel.appendChild(actions);

      function setBusy(busy) {
        // 提交期间锁住控件，避免重复发起校验或重复添加同一个项目。
        input.disabled = busy;
        cancelButton.disabled = busy;
        closeButton.disabled = busy;
        submitButton.disabled = busy;
        submitButton.textContent = busy
          ? t("web.workspaceRoot.dialog.confirming")
          : t("web.workspaceRoot.dialog.confirm");
      }

      function close(result) {
        // 弹窗关闭时必须清理全局 keydown 监听和单例状态，避免下次打开失焦。
        dialogState.focusInput = null;
        dialogState.promise = null;
        w.removeEventListener("keydown", onKeyDown, true);
        try {
          backdrop.remove();
        } catch {}
        resolve(result);
      }

      function cancel() {
        close(true);
      }

      function onKeyDown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }

      panel.addEventListener("submit", async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          // 成功完成官方添加项目 IPC 后才关闭弹窗；失败只吐司并保留输入内容。
          await onSubmit(input.value);
          close(true);
        } catch (error) {
          showErrorToast(error);
          setBusy(false);
          w.requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
        }
      });
      closeButton.addEventListener("click", cancel);
      cancelButton.addEventListener("click", cancel);
      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);
      dialogState.focusInput = () => input.focus();
      w.addEventListener("keydown", onKeyDown, true);
      w.requestAnimationFrame(() => input.focus());
    });

    return dialogState.promise;
  }

  async function submitRemoteWorkspaceRoot(payload, rawPath) {
    // 先让 gateway 在运行 OpenCodex 的机器上校验路径，再把规范化 root 交给官方项目逻辑。
    const validation = await invoke(WORKSPACE_ROOT_VALIDATE_CHANNEL, { path: rawPath });
    const root = validation && typeof validation.root === "string" ? validation.root : "";
    if (!root) {
      const error = new Error("Workspace root validation returned no path.");
      error.workspaceRootErrorKey = "web.workspaceRoot.error.unavailable";
      throw error;
    }
    try {
      // 官方 handler 负责持久化、刷新项目列表和切换选中状态；Web 侧不复刻这部分状态机。
      await invoke("codex_desktop:message-from-view", { ...payload, root });
    } catch (error) {
      error.workspaceRootErrorKey = "web.workspaceRoot.error.addFailed";
      throw error;
    }
  }

  function handleMessage(payload) {
    if (!shouldHandleMessage(payload)) return null;
    return showDialog((rawPath) => submitRemoteWorkspaceRoot(payload, rawPath));
  }

  w.OpenCodexWorkspaceRootPicker = {
    // polyfill 只调用这个公开入口，降低后续拆迁或替换 UI 实现的耦合。
    handleMessage,
    shouldHandleMessage,
  };
})();
