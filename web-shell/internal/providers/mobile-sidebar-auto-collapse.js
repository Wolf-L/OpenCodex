(function () {
  const w = window;
  const modificationEffects = w.__OpenCodexCurrentProviderScope?.effects;
  const adapterHost = w.__OpenCodexAdapterHost;
  const scheduler = adapterHost?.scheduler?.capture?.() || w;
  const pluginSystem = w.OpenCodexPluginSystem || w.__OpenCodexPluginSystem;
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") return;
  const registerPlugin = adapterHost?.plugins?.register
    ? (plugin) => adapterHost.plugins.register(pluginSystem, plugin)
    : pluginSystem.registerPlugin.bind(pluginSystem);

  const AUTO_COLLAPSE_DELAY_MS = 80;
  const PHONE_LAYOUT_QUERY = "(max-width: 767px), (max-width: 960px) and (max-height: 500px)";
  // 与响应期 PointerSensor 补丁使用同一事件标记，不拦截 React 的长按/右键事件。
  const SIDEBAR_TOUCH_DRAG_FLAG = "__opencodexSkipSidebarTouchDrag";
  const SIDEBAR_THREAD_ROW_SELECTOR = "[data-app-action-sidebar-thread-row]";
  const SIDEBAR_SCROLL_SELECTOR = "[data-app-action-sidebar-scroll]";
  const SIDEBAR_NON_THREAD_ROW_SELECTOR = "[data-app-action-sidebar-project-row],[data-app-action-sidebar-section]";
  const SIDEBAR_TOGGLE_SELECTOR = "[data-app-shell-sidebar-trigger]";
  const SIDEBAR_TOGGLE_VIEW_TRANSITION_NAME = "sidebar-trigger";
  // 官方不同版本使用过两套“新建任务”图标，需同时兼容，避免上游换图标后点击失效。
  const SIDEBAR_NEW_CONVERSATION_ICON_PATH_PREFIXES = ["M2.6687 11.333", "M6.33325 1.88379"];
  const NEW_CONVERSATION_MESSAGE_TYPES = new Set(["new-chat", "new-quick-chat"]);
  const PROMOTION_ATTRIBUTE = "data-opencodex-mobile-promotion";
  const PROMOTION_SELECTOR = "header[data-app-shell-titlebar] button, [class~='group/home-composer-layout'] aside[role='status']";

  function isMobilePromotion(element) {
    // 只检查官方顶栏与首页额度卡片，避免把聊天正文或其他故障提示误当作推广。
    const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
    if (element.matches("button")) return /^(?:获取\s*Plus|Get Plus)$/i.test(text);
    // 官方英文文案使用弯引号，与直引号视为同一标题；仍只精确匹配指定额度卡片。
    const title = String(element.querySelector("h3")?.textContent || "").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
    return /^(?:Codex\s*和工作使用额度已用完|You've (?:hit|reached) (?:your )?Codex and Work (?:usage )?limit|You're out of Codex and Work usage)[.!。]?$/i.test(title);
  }

  function visibleElement(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = w.getComputedStyle ? w.getComputedStyle(element) : null;
    return !style || (style.display !== "none" && style.visibility !== "hidden");
  }

  function sidebarPanelElement() {
    return document.querySelector(".app-shell-left-panel");
  }

  function sidebarNavigationElement() {
    const panel = sidebarPanelElement();
    if (panel) return panel.querySelector(SIDEBAR_SCROLL_SELECTOR) || panel.querySelector("nav") || panel;
    return document.querySelector(SIDEBAR_SCROLL_SELECTOR) || document.querySelector("nav");
  }

  function isNestedSidebarInteractiveElement(element) {
    if (!element || typeof element.matches !== "function") return false;
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    return (
      element.matches("button,a[href],input,select,textarea,summary,[contenteditable='true']") ||
      role === "button" ||
      role === "menuitem" ||
      role === "menuitemcheckbox" ||
      role === "menuitemradio" ||
      role === "checkbox" ||
      role === "switch" ||
      role === "tab"
    );
  }

  function nestedSidebarInteractiveFromTarget(target, row) {
    for (let node = target; node && node !== row; node = node.parentElement) {
      if (isNestedSidebarInteractiveElement(node)) return node;
    }
    return null;
  }

  function isSidebarConversationRow(element) {
    if (!element || typeof element.matches !== "function") return false;
    const officialThreadRow = element.matches(SIDEBAR_THREAD_ROW_SELECTOR);
    const legacyThreadRow =
      element.matches("[role='button'].h-token-nav-row") &&
      !element.matches(SIDEBAR_NON_THREAD_ROW_SELECTOR) &&
      !!element.querySelector("[data-thread-title]");
    if (!officialThreadRow && !legacyThreadRow) return false;
    if (!visibleElement(element)) return false;
    if (officialThreadRow) {
      const id = element.getAttribute("data-app-action-sidebar-thread-id");
      const kind = element.getAttribute("data-app-action-sidebar-thread-kind");
      if (!id || !/^(local|remote|pending-worktree)$/.test(kind || "")) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width >= 80 && rect.height >= 20 && rect.height <= 64;
  }

  function sidebarConversationRowFromTarget(target) {
    const element = target && target.nodeType === 1 ? target : target?.parentElement;
    if (!element || typeof element.closest !== "function") return null;
    const nav = sidebarNavigationElement();
    if (!nav || !nav.contains(element)) return null;
    const officialRow = element.closest(SIDEBAR_THREAD_ROW_SELECTOR);
    if (officialRow && nav.contains(officialRow) && isSidebarConversationRow(officialRow)) {
      return nestedSidebarInteractiveFromTarget(element, officialRow) ? null : officialRow;
    }
    const tokenRow = element.closest("[role='button'].h-token-nav-row");
    if (tokenRow && nav.contains(tokenRow) && isSidebarConversationRow(tokenRow)) {
      return nestedSidebarInteractiveFromTarget(element, tokenRow) ? null : tokenRow;
    }
    for (let node = element; node && node !== nav; node = node.parentElement) {
      if (isSidebarConversationRow(node)) {
        return nestedSidebarInteractiveFromTarget(element, node) ? null : node;
      }
    }
    return null;
  }

  function sidebarToggleViewTransitionName(button) {
    const inlineName =
      button.style?.viewTransitionName || button.style?.getPropertyValue?.("view-transition-name") || "";
    if (inlineName) return String(inlineName).trim();
    try {
      const style = w.getComputedStyle ? w.getComputedStyle(button) : null;
      return String(style?.viewTransitionName || style?.getPropertyValue?.("view-transition-name") || "").trim();
    } catch {
      return "";
    }
  }

  function findSidebarToggleButton() {
    // 新版官方界面提供稳定标记；保留 view-transition 识别以兼容旧版。
    const markedButton = document.querySelector(SIDEBAR_TOGGLE_SELECTOR);
    if (markedButton?.matches?.("button") && visibleElement(markedButton)) return markedButton;
    return Array.from(document.querySelectorAll("button")).find((button) => {
      if (!visibleElement(button)) return false;
      return sidebarToggleViewTransitionName(button) === SIDEBAR_TOGGLE_VIEW_TRANSITION_NAME;
    });
  }

  function postSidebarToggleMessage() {
    try {
      w.postMessage({ type: "toggle-sidebar" }, w.location.origin || "*");
    } catch {}
  }

  function isNewConversationMessage(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (NEW_CONVERSATION_MESSAGE_TYPES.has(payload.type)) return true;
    if (payload.type !== "navigate-to-route" || payload.path !== "/") return false;
    const state = payload.state && typeof payload.state === "object" ? payload.state : null;
    return !!state && Object.prototype.hasOwnProperty.call(state, "focusComposerNonce");
  }

  function isSidebarNewConversationButton(button) {
    if (!button || typeof button.matches !== "function" || !button.matches("button")) return false;
    const panel = sidebarPanelElement();
    if (!panel || !panel.contains(button)) return false;
    if (!visibleElement(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    return Array.from(button.querySelectorAll("svg path")).some((path) =>
      SIDEBAR_NEW_CONVERSATION_ICON_PATH_PREFIXES.some((prefix) =>
        String(path.getAttribute("d") || "").startsWith(prefix)
      )
    );
  }

  function sidebarNewConversationButtonFromTarget(target) {
    const element = target && target.nodeType === 1 ? target : target?.parentElement;
    if (!element || typeof element.closest !== "function") return null;
    const button = element.closest("button");
    return isSidebarNewConversationButton(button) ? button : null;
  }

  registerPlugin({
    id: "opencodex.mobile-sidebar-auto-collapse",
    name: "Mobile sidebar auto collapse",
    labelKey: "plugin.mobileSidebarAutoCollapse.label",
    label: "移动端侧栏优化",
    descKey: "plugin.mobileSidebarAutoCollapse.desc",
    desc: "在移动端打开会话或新建会话后自动收起侧栏。",
    enableStorageKey: "mobileSidebarAutoCollapse",
    defaultEnabled: true,
    builtin: true,
    order: 20,
    activate(context) {
      if (
        context.scope !== "renderer" ||
        !document ||
        document.__opencodexMobileSidebarPluginInstalled ||
        !adapterHost?.events?.observe
      ) return null;
      document.__opencodexMobileSidebarPluginInstalled = true;

      let collapseTimer = null;
      let promotionTimer = null;
      const markedPromotions = new Set();
      const isEnabled = () => context.plugin.isEnabled();
      // 窄窗口同样呈现手机抽屉，不能只按 UA/触屏判断，否则选中功能后正文仍被抽屉遮住。
      const isMobile = () => !!context.platform.isMobile() || !!w.matchMedia?.(PHONE_LAYOUT_QUERY).matches;

      const updatePromotions = () => {
        promotionTimer = null;
        for (const element of markedPromotions) {
          if (!isEnabled() || !element.isConnected || !isMobilePromotion(element)) {
            element.removeAttribute(PROMOTION_ATTRIBUTE);
            markedPromotions.delete(element);
          }
        }
        if (!isEnabled()) return;
        for (const element of document.querySelectorAll(PROMOTION_SELECTOR)) {
          if (!isMobilePromotion(element) || markedPromotions.has(element)) continue;
          element.setAttribute(PROMOTION_ATTRIBUTE, "true");
          markedPromotions.add(element);
        }
      };
      const schedulePromotions = () => {
        // DOM 更新合并为一轮检查；不读取账户数据，也不拦截请求或更改额度限制。
        if (promotionTimer !== null) return;
        promotionTimer = scheduler.setTimeout(updatePromotions, 80);
      };
      const disposePromotionObservation = adapterHost.dom?.observe?.({
        key: {},
        root: document.documentElement,
        options: { childList: true, subtree: true, characterData: true },
        callback: schedulePromotions,
      });
      updatePromotions();

      const collapseAfterSelection = () => {
        if (collapseTimer) scheduler.clearTimeout(collapseTimer);
        collapseTimer = scheduler.setTimeout(() => {
          collapseTimer = null;
          const panel = sidebarPanelElement();
          if (!panel || !visibleElement(panel)) return;
          const toggleButton = findSidebarToggleButton();
          if (toggleButton && typeof toggleButton.click === "function") {
            toggleButton.click();
            modificationEffects?.primary?.emit();
            return;
          }
          postSidebarToggleMessage();
          modificationEffects?.primary?.emit();
        }, AUTO_COLLAPSE_DELAY_MS);
      };

      const handleClick = (event) => {
        if (!isEnabled() || !isMobile()) return;
        if (event.defaultPrevented || event.button > 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const destination = event.target?.closest?.("[data-app-navigation-rail] button");
        // Explore 的首个直属按钮才是跳转；旁边 span 内的固定按钮不能触发收起。
        const exploreDestination = event.target?.closest?.("[data-explore-row] > button");
        // 功能入口选中后回到正文；账户和“更多”原生菜单保持展开供用户继续操作。
        const selectedDestination = (destination && !destination.disabled && !destination.hasAttribute("aria-haspopup")) ||
          (exploreDestination && !exploreDestination.disabled && exploreDestination.getAttribute("aria-disabled") !== "true");
        if (!selectedDestination && !sidebarConversationRowFromTarget(event.target) && !sidebarNewConversationButtonFromTarget(event.target)) {
          return;
        }
        collapseAfterSelection();
      };

      const handlePointerDown = (event) => {
        if (!isEnabled() || !isMobile() || event.pointerType !== "touch") return;
        if (!sidebarConversationRowFromTarget(event.target)) return;
        // 只退出官方拖拽传感器，不能 stopPropagation，否则 Radix 收不到长按起点。
        event[SIDEBAR_TOUCH_DRAG_FLAG] = true;
      };

      const disposeViewMessage = context.events.on("view:message", (payload) => {
        if (isEnabled() && isMobile() && isNewConversationMessage(payload)) collapseAfterSelection();
      });

      const disposeClick = adapterHost.events.observe({
        key: {},
        target: document,
        type: "click",
        capture: true,
        callback: handleClick,
      });
      const disposePointerDown = adapterHost.events.observe({
        key: {},
        target: document,
        type: "pointerdown",
        capture: true,
        callback: handlePointerDown,
      });

      return () => {
        if (collapseTimer) scheduler.clearTimeout(collapseTimer);
        if (promotionTimer !== null) scheduler.clearTimeout(promotionTimer);
        disposePromotionObservation?.();
        for (const element of markedPromotions) element.removeAttribute(PROMOTION_ATTRIBUTE);
        markedPromotions.clear();
        disposeViewMessage();
        disposeClick();
        disposePointerDown();
        document.__opencodexMobileSidebarPluginInstalled = false;
      };
    },
  });
})();
