"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createNavigationEventBindings = function createNavigationEventBindings(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const errorText = (error, key) => window.LoadToAgentI18n.errorText(error, key);
  const {
    $, state, motionPreference, saveGuideState, selectView, renderUpdateSettings,
    filteredSessions, renderSessions, openRunModal, openDrawer, toast,
  } = context;

  function bindNavigationAndUpdateEvents() {
    $(".view-nav").addEventListener("click", (event) => {
      const button = event.target.closest(".nav-item");
      if (!button || !button.dataset.view) return;
      selectView(button.dataset.view);
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
      $("#guideBtn").focus({ preventScroll: true });
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
      menu.classList.toggle("hidden", !opening);
      $("#mobileMoreBtn").setAttribute("aria-expanded", opening ? "true" : "false");
      if (opening) setTimeout(() => menu.querySelector("button")?.focus(), 0);
    });
    $("#mobileToolsMenu").addEventListener("click", (event) => {
      const button = event.target.closest("[data-mobile-view]");
      if (button) selectView(button.dataset.mobileView, { focusMain: true });
    });
    $("#checkUpdateBtn").addEventListener("click", async () => {
      try {
        state.update = { ...(state.update || {}), status: "checking", error: "" };
        renderUpdateSettings();
        state.update = await window.loadtoagent.checkForUpdate();
        renderUpdateSettings();
      } catch (error) {
        toast(errorText(error, "ui.could_not_check_for_updates"));
      }
    });
    $("#installUpdateBtn").addEventListener("click", async () => {
      try {
        state.update = { ...(state.update || {}), status: "downloading", error: "" };
        renderUpdateSettings();
        state.update = await window.loadtoagent.installDownloadedUpdate();
        renderUpdateSettings();
        if (state.update && state.update.installMode === "manual") toast(t("ui.open_installer"));
      } catch (error) {
        if (state.update && state.update.asset) state.update.status = "available";
        renderUpdateSettings();
        toast(errorText(error, "ui.could_not_prepare_the_update_file"));
      }
    });
    $("#openReleaseBtn").addEventListener("click", async () => {
      try {
        await window.loadtoagent.openUpdateRelease();
      } catch (error) {
        toast(errorText(error, "ui.could_not_open_the_github_release_page"));
      }
    });
  }

  return { bindNavigationAndUpdateEvents };
};
