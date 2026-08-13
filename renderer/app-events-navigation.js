"use strict";

window.WhiteboxAppFactories = window.WhiteboxAppFactories || {};

window.WhiteboxAppFactories.createNavigationEventBindings = function createNavigationEventBindings(context = {}) {
  const t = (key, params) => window.WhiteboxI18n.t(key, params);
  const {
    $, state, motionPreference, saveGuideState, selectView, renderUpdateSettings,
    filteredSessions, renderSessions, openRunModal, openDrawer, toast, performUiAction,
    rememberDialogTrigger, restoreDialogTrigger, discardDialogTrigger, setDialogOpenState, trapDialogFocus,
  } = context;
  let mobileToolsFocusToken = null;

  function bindNavigationAndUpdateEvents() {
    const closeMobileTools = (restoreFocus = true) => {
      const menu = $("#mobileToolsMenu");
      setDialogOpenState(menu, false);
      menu.classList.add("hidden");
      $("#mobileMoreBtn").setAttribute("aria-expanded", "false");
      const focusToken = mobileToolsFocusToken;
      mobileToolsFocusToken = null;
      if (!focusToken) return;
      if (restoreFocus) restoreDialogTrigger(focusToken);
      else discardDialogTrigger(focusToken);
    };
    $(".view-nav").addEventListener("click", (event) => {
      const button = event.target.closest(".nav-item");
      if (!button || !button.dataset.view) return;
      const advancedTools = $("#advancedToolsNav");
      const selectedFromAdvancedTools = Boolean(advancedTools?.contains(button));
      selectView(button.dataset.view);
      advancedTools?.removeAttribute("open");
      if (selectedFromAdvancedTools) advancedTools?.querySelector(":scope > summary")?.focus({ preventScroll: true });
    });
    $("#sidebarSettingsBtn")?.addEventListener("click", () => {
      selectView("settings");
    });
    $("#backToProjectsBtn")?.addEventListener("click", () => {
      selectView("all", { focusMain: true });
    });
    $(".view-nav").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(document.querySelectorAll(".view-nav .nav-item[data-view]"))
        .filter((button) => !button.hidden && button.getClientRects().length > 0 && getComputedStyle(button).visibility !== "hidden");
      const current = Math.max(0, buttons.indexOf(event.target.closest(".nav-item[data-view]")));
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault();
      buttons[next]?.focus();
    });
    document.addEventListener("pointerdown", (event) => {
      const menu = $("#advancedToolsNav");
      if (menu?.open && !menu.contains(event.target)) menu.removeAttribute("open");
    });
    $("#advancedToolsNav")?.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.currentTarget.removeAttribute("open");
      event.currentTarget.querySelector("summary")?.focus();
    });
    $("#updateNoticeBtn").addEventListener("click", () => {
      selectView("settings");
    });
    $("#guideBtn").addEventListener("click", () => {
      state.guideExpanded = !state.guideExpanded || state.view !== "all";
      saveGuideState();
      if (state.view !== "all") selectView("all");
      else renderSessions("guide");
      if (state.guideExpanded) {
        setTimeout(
          () => $("#beginnerGuide").scrollIntoView({ behavior: motionPreference.matches ? "auto" : "smooth", block: "start" }),
          0,
        );
      }
    });
    $("#dismissGuideBtn").addEventListener("click", () => {
      state.guideExpanded = false;
      saveGuideState();
      renderSessions("guide");
      $("#mainContent").focus({ preventScroll: true });
    });
    $("#beginnerGuide").addEventListener("click", (event) => {
      const action = event.target.closest("[data-guide-action]")?.dataset.guideAction;
      if (!action) return;
      if (action === "create") return openRunModal();
      if (action === "active" || action === "waiting") return selectView(action, { focusMain: true });
      if (action === "detail") {
        const first = filteredSessions()[0] || ((state.snapshot && state.snapshot.sessions) || [])[0];
        if (first) openDrawer(first.id);
        else {
          toast(t("guide.no_task_to_open"));
          openRunModal();
        }
      }
    });
    $("#mobileMoreBtn").addEventListener("click", () => {
      const menu = $("#mobileToolsMenu");
      const opening = menu.classList.contains("hidden");
      if (!opening) return closeMobileTools(true);
      $("#mobileMoreBtn").focus({ preventScroll: true });
      mobileToolsFocusToken = rememberDialogTrigger("mobileToolsMenu");
      menu.classList.remove("hidden");
      setDialogOpenState(menu, true);
      $("#mobileMoreBtn").setAttribute("aria-expanded", "true");
      menu.querySelector("button")?.focus({ preventScroll: true });
    });
    $("#mobileToolsCloseBtn").addEventListener("click", () => closeMobileTools(true));
    $("#mobileToolsMenu").addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobileTools(true);
        return;
      }
      if (event.key === "Tab") {
        trapDialogFocus(event);
        return;
      }
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll("button:not([disabled])"));
      const current = Math.max(0, buttons.indexOf(event.target.closest("button")));
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault();
      buttons[next]?.focus();
    });
    $("#mobileToolsMenu").addEventListener("click", (event) => {
      const guide = event.target.closest("[data-mobile-guide]");
      if (guide) {
        closeMobileTools(false);
        $("#guideBtn")?.click();
        requestAnimationFrame(() => $("#beginnerGuide")?.scrollIntoView({ behavior: "smooth", block: "start" }));
        return;
      }
      const button = event.target.closest("[data-mobile-view]");
      if (button) {
        closeMobileTools(false);
        selectView(button.dataset.mobileView, { focusMain: true });
      }
    });
    document.addEventListener("pointerdown", (event) => {
      const menu = $("#mobileToolsMenu");
      if (menu.classList.contains("hidden") || menu.contains(event.target) || $("#mobileMoreBtn").contains(event.target)) return;
      const focusWasInside = menu.contains(document.activeElement);
      closeMobileTools(focusWasInside);
    });
    $("#checkUpdateBtn").addEventListener("click", async () => {
      state.update = { ...(state.update || {}), status: "checking", error: "" };
      renderUpdateSettings();
      const update = await performUiAction(() => window.whitebox.checkForUpdate(), "ui.could_not_check_for_updates", $("#checkUpdateBtn"));
      if (update) state.update = update;
      else state.update = { ...(state.update || {}), status: "error" };
      renderUpdateSettings();
    });
    $("#installUpdateBtn").addEventListener("click", async () => {
      state.update = { ...(state.update || {}), status: "downloading", error: "" };
      renderUpdateSettings();
      const update = await performUiAction(() => window.whitebox.installDownloadedUpdate(), "ui.could_not_prepare_the_update_file", $("#installUpdateBtn"));
      if (update) state.update = update;
      else if (state.update && state.update.asset) state.update.status = "available";
      renderUpdateSettings();
      if (state.update && state.update.installMode === "manual") toast(t("ui.open_installer"));
    });
    $("#openReleaseBtn").addEventListener("click", async () => {
      await performUiAction(() => window.whitebox.openUpdateRelease(), "ui.could_not_open_the_github_release_page", $("#openReleaseBtn"));
    });
  }

  return { bindNavigationAndUpdateEvents };
};
