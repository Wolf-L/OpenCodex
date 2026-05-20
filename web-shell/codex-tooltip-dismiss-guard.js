(function () {
  const w = window;
  if (w.__codexTooltipDismissGuardInstalled) return;
  w.__codexTooltipDismissGuardInstalled = true;

  const TOOLTIP_SELECTOR = '[role="tooltip"]';
  const TOOLTIP_DISMISS_EVENT = "codex:dismiss-tooltips";

  let lastPointer = null;
  let pendingFrame = 0;

  function visibleTooltips() {
    return Array.from(document.querySelectorAll(TOOLTIP_SELECTOR));
  }

  function dispatchOfficialTooltipDismiss() {
    if (!document.querySelector(TOOLTIP_SELECTOR)) return;

    if (typeof w.Event === "function") {
      w.dispatchEvent(new w.Event(TOOLTIP_DISMISS_EVENT));
      return;
    }

    const event = document.createEvent("Event");
    event.initEvent(TOOLTIP_DISMISS_EVENT, false, false);
    w.dispatchEvent(event);
  }

  function containsElement(parent, child) {
    return !!(parent && child && (parent === child || parent.contains(child)));
  }

  function tooltipTriggerElements(tooltipId) {
    if (!tooltipId) return [];
    return Array.from(document.querySelectorAll("[aria-describedby]")).filter((element) => {
      const describedBy = String(element.getAttribute("aria-describedby") || "");
      return describedBy.split(/\s+/).includes(tooltipId);
    });
  }

  function targetBelongsToOpenTooltip(target, tooltips) {
    if (!target) return false;

    for (const tooltip of tooltips) {
      if (containsElement(tooltip, target)) return true;

      for (const trigger of tooltipTriggerElements(tooltip.id)) {
        if (containsElement(trigger, target)) return true;
      }
    }

    return false;
  }

  function currentPointerTarget() {
    if (!lastPointer) return null;
    if (typeof document.elementFromPoint !== "function") return lastPointer.target;
    return document.elementFromPoint(lastPointer.x, lastPointer.y) || lastPointer.target;
  }

  function dismissIfPointerLeftTooltips() {
    pendingFrame = 0;

    const tooltips = visibleTooltips();
    if (!tooltips.length) return;
    if (!lastPointer) return;

    if (
      targetBelongsToOpenTooltip(currentPointerTarget(), tooltips) ||
      targetBelongsToOpenTooltip(document.activeElement, tooltips)
    ) {
      return;
    }
    dispatchOfficialTooltipDismiss();
  }

  function scheduleDismissCheck() {
    if (pendingFrame) return;
    pendingFrame = w.setTimeout(dismissIfPointerLeftTooltips, 16);
  }

  function rememberPointer(event) {
    lastPointer = {
      x: event.clientX,
      y: event.clientY,
      target: event.target && event.target.nodeType === 1 ? event.target : null,
    };
    scheduleDismissCheck();
  }

  function dismissOnDocumentExit(event) {
    if (!event.relatedTarget) dispatchOfficialTooltipDismiss();
  }

  function nodeHasTooltip(node) {
    if (!node || node.nodeType !== 1) return false;
    if (typeof node.matches === "function" && node.matches(TOOLTIP_SELECTOR)) return true;
    return typeof node.querySelector === "function" && !!node.querySelector(TOOLTIP_SELECTOR);
  }

  function handleTooltipMutations(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (nodeHasTooltip(node)) {
          scheduleDismissCheck();
          return;
        }
      }
    }
  }

  document.addEventListener("pointermove", rememberPointer, true);
  document.addEventListener("mousemove", rememberPointer, true);
  document.addEventListener("pointerout", dismissOnDocumentExit, true);
  document.addEventListener("mouseout", dismissOnDocumentExit, true);
  document.addEventListener("scroll", dispatchOfficialTooltipDismiss, true);
  w.addEventListener("blur", dispatchOfficialTooltipDismiss);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") dispatchOfficialTooltipDismiss();
  });

  if (typeof w.MutationObserver === "function") {
    const observer = new w.MutationObserver(handleTooltipMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
