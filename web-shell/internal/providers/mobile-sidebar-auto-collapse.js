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
  // 仅兼容已验证的“新建任务”图标，包括手机当前 renderer 变体，避免上游换图标后点击失效。
  const SIDEBAR_NEW_CONVERSATION_ICON_PATH_PREFIXES = ["M2.6687 11.333", "M6.33325 1.88379", "M8.16675 2.50127"];
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

  // 只增加触屏导航控件；菜单项和设置分类仍由官方 React 节点执行，避免复制操作回调。
  function createMobilePanelLayout() {
    const settings = new Map();
    const menus = new Map();
    const accountMenus = new Map();
    // 下拉选择器按下时就会打开，移动其位置可能误触；仅调整长按/右键上下文菜单。
    const contextMenuSelector = '[data-radix-popper-content-wrapper] > [role="menu"][style*="--radix-context-menu-content-"]';
    const chinese = () => !/^en\b/i.test(document.documentElement.lang || "zh");
    const set = (element, name, value) => {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    };
    const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
    const closeSettings = (nav, restoreFocus = false) => {
      const state = settings.get(nav);
      if (!state) return;
      set(nav, "data-opencodex-settings-expanded", "false");
      set(state.button, "aria-expanded", "false");
      if (restoreFocus) state.button.focus();
    };
    const clearSettings = (nav, state) => {
      state.button.remove();
      nav.removeAttribute("data-opencodex-phone-settings");
      nav.removeAttribute("data-opencodex-settings-expanded");
      settings.delete(nav);
    };
    const clearMenu = (menu, state) => {
      state.bar.remove();
      state.wrapper.removeAttribute("data-opencodex-phone-menu");
      state.wrapper.removeAttribute("data-opencodex-menu-covered");
      menu.removeAttribute("data-opencodex-menu-panel");
      menus.delete(menu);
    };
    const clearAccountMenu = (menu, wrapper) => {
      wrapper.removeAttribute("data-opencodex-phone-account-menu");
      accountMenus.delete(menu);
    };
    return {
      refresh(enabled) {
        for (const [nav, state] of settings) if (!enabled || !nav.isConnected) clearSettings(nav, state);
        for (const [menu, state] of menus) if (!enabled || !menu.isConnected || !menu.matches(contextMenuSelector) || menu.getAttribute("data-state") === "closed") clearMenu(menu, state);
        for (const [menu, wrapper] of accountMenus) if (!enabled || !menu.isConnected || menu.getAttribute("data-state") === "closed") clearAccountMenu(menu, wrapper);
        if (!enabled) return;
        // 账号入口已移至抽屉底部，弹层也必须留在屏内，并避开打开它的手指位置。
        for (const menu of document.querySelectorAll('[data-radix-popper-content-wrapper] > [role="menu"][style*="--radix-dropdown-menu-content-"]')) {
          const trigger = document.getElementById(menu.getAttribute("aria-labelledby"));
          if (menu.getAttribute("data-state") !== "closed" && trigger?.closest("[data-app-navigation-rail]")) {
            accountMenus.set(menu, menu.parentElement);
            set(menu.parentElement, "data-opencodex-phone-account-menu", "true");
          }
        }
        const nav = document.querySelector("nav:has(#settings-search)");
        const search = nav?.querySelector("#settings-search");
        const header = search?.closest("[data-sidebar-header-search]")?.parentElement?.parentElement;
        if (nav && header) {
          let state = settings.get(nav);
          if (!state) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "opencodex-settings-sections";
            button.setAttribute("data-opencodex-settings-toggle", "");
            header.appendChild(button);
            state = { button };
            settings.set(nav, state);
            set(nav, "data-opencodex-phone-settings", "true");
            closeSettings(nav);
          }
          const selected = nav.querySelector('button[aria-current="page"]');
          const label = selected?.getAttribute("aria-label") || selected?.textContent || (chinese() ? "设置" : "Settings");
          text(state.button, `${chinese() ? "设置分类" : "Categories"} · ${label.trim()}`);
          if (search.value?.trim() && state.lastSearch !== search.value) {
            set(nav, "data-opencodex-settings-expanded", "true");
            set(state.button, "aria-expanded", "true");
          }
          state.lastSearch = search.value;
        }
        for (const menu of document.querySelectorAll(contextMenuSelector)) {
          if (menu.getAttribute("data-state") === "closed") continue;
          let state = menus.get(menu);
          if (!state) {
            const wrapper = menu.parentElement;
            const bar = document.createElement("div");
            bar.className = "opencodex-menu-bar";
            bar.setAttribute("role", "presentation");
            const button = document.createElement("button");
            button.type = "button";
            button.tabIndex = -1;
            button.setAttribute("data-opencodex-menu-back", "");
            bar.appendChild(button);
            const title = document.createElement("span");
            title.className = "opencodex-menu-title";
            bar.appendChild(title);
            // 新增控件放在 React 未持有引用的独立节点中，官方菜单子树保持原位置。
            menu.prepend(bar);
            state = { wrapper, bar, button, title };
            menus.set(menu, state);
            set(wrapper, "data-opencodex-phone-menu", "true");
            set(menu, "data-opencodex-menu-panel", "true");
          }
          const labelledBy = menu.getAttribute("aria-labelledby");
          const trigger = labelledBy ? document.getElementById(labelledBy) : null;
          const parent = trigger?.closest('[role="menu"]');
          state.parent = parent && parent !== menu ? parent : null;
          const label = trigger?.getAttribute("aria-label") || trigger?.textContent || "";
          text(state.title, state.parent ? label.trim() : (chinese() ? "操作" : "Actions"));
          text(state.button, state.parent ? (chinese() ? "‹ 返回" : "‹ Back") : (chinese() ? "关闭" : "Close"));
          set(state.button, "aria-label", state.parent ? (chinese() ? "返回上一级菜单" : "Back to previous menu") : (chinese() ? "关闭菜单" : "Close menu"));
        }
        const parents = new Set([...menus.values()].map(state => state.parent).filter(Boolean));
        for (const [menu, state] of menus) set(state.wrapper, "data-opencodex-menu-covered", parents.has(menu) ? "true" : "false");
      },
      click(event) {
        const toggle = event.target?.closest?.("[data-opencodex-settings-toggle]");
        if (toggle) {
          const nav = toggle.closest("nav");
          const expanded = toggle.getAttribute("aria-expanded") !== "true";
          set(nav, "data-opencodex-settings-expanded", String(expanded));
          set(toggle, "aria-expanded", String(expanded));
          return true;
        }
        const back = event.target?.closest?.("[data-opencodex-menu-back]");
        if (back) {
          const menu = back.closest('[role="menu"]');
          const state = menus.get(menu);
          if (!state) return false;
          // 委托原生菜单的返回/关闭键，保持焦点恢复、子菜单状态和动作清理一致。
          event.preventDefault();
          event.stopPropagation();
          const parentState = menus.get(state.parent);
          if (parentState) set(parentState.wrapper, "data-opencodex-menu-covered", "false");
          menu.focus();
          const key = state.parent ? (w.getComputedStyle(menu).direction === "rtl" ? "ArrowRight" : "ArrowLeft") : "Escape";
          menu.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
          return true;
        }
        for (const [nav] of settings) {
          if (!nav.contains(event.target) || event.target?.closest?.("[data-settings-panel-slug], [class~='group/nav-list'] button")) closeSettings(nav);
        }
        return false;
      },
      pointermove(event) {
        const trigger = event.target?.closest?.('[role="menuitem"][aria-haspopup="menu"]');
        // 单面板不使用桌面悬停展开，否则点击前新面板会移到鼠标下导致选中别的项目。
        if (event.pointerType === "mouse" && trigger && menus.has(trigger.closest('[role="menu"]'))) event.stopPropagation();
      },
      keydown(event) {
        const menu = event.target?.closest?.('[role="menu"]');
        const state = menus.get(menu);
        const parentState = state && menus.get(state.parent);
        // 原生返回会立即聚焦父菜单项，必须先解除隐藏，不能等下一轮 DOM 观察。
        if (parentState && event.key === (w.getComputedStyle(menu).direction === "rtl" ? "ArrowRight" : "ArrowLeft")) {
          set(parentState.wrapper, "data-opencodex-menu-covered", "false");
        }
        if (event.key !== "Escape") return;
        for (const [nav] of settings) if (nav.contains(event.target) && nav.getAttribute("data-opencodex-settings-expanded") === "true") {
          closeSettings(nav, true);
          event.preventDefault();
          event.stopPropagation();
        }
      },
      dispose() {
        for (const [nav, state] of settings) clearSettings(nav, state);
        for (const [menu, state] of menus) clearMenu(menu, state);
        for (const [menu, wrapper] of accountMenus) clearAccountMenu(menu, wrapper);
      },
    };
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
      const mobilePanels = createMobilePanelLayout();

      const updatePromotions = () => {
        promotionTimer = null;
        // 面板增强必须与 CSS 断点一致；平板/宽窗口不留下无样式的辅助按钮。
        mobilePanels.refresh(isEnabled() && !!w.matchMedia?.(PHONE_LAYOUT_QUERY).matches);
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
        options: { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-current", "aria-expanded", "data-state"] },
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
        if (mobilePanels.click(event)) return;
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
      const disposePanelKeys = adapterHost.events.observe({ key: {}, target: document, type: "keydown", capture: true, callback: event => mobilePanels.keydown(event) });
      const disposePanelMove = adapterHost.events.observe({ key: {}, target: document, type: "pointermove", capture: true, callback: event => mobilePanels.pointermove(event) });
      const disposePanelInput = adapterHost.events.observe({ key: {}, target: document, type: "input", callback: event => { if (event.target?.id === "settings-search") schedulePromotions(); } });
      const disposePanelResize = adapterHost.events.observe({ key: {}, target: w, type: "resize", callback: schedulePromotions });

      return () => {
        if (collapseTimer) scheduler.clearTimeout(collapseTimer);
        if (promotionTimer !== null) scheduler.clearTimeout(promotionTimer);
        disposePromotionObservation?.();
        for (const element of markedPromotions) element.removeAttribute(PROMOTION_ATTRIBUTE);
        markedPromotions.clear();
        disposeViewMessage();
        disposeClick();
        disposePointerDown();
        disposePanelKeys();
        disposePanelMove();
        disposePanelInput();
        disposePanelResize();
        mobilePanels.dispose();
        document.__opencodexMobileSidebarPluginInstalled = false;
      };
    },
  });
})();
