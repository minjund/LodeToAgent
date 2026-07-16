"use strict";

(() => {
  const factories = window.LoadToAgentAppFactories || {};
  const app = {};
  const install = (name) => {
    if (typeof factories[name] !== "function") throw new Error(`앱 모듈을 찾지 못했습니다: ${name}`);
    Object.assign(app, factories[name](app));
  };

  [
    "createCore",
    "createDashboard",
    "createGraphModel",
    "createGraphView",
    "createGraphLayout",
    "createGraphOrchestration",
    "createTmuxRenderer",
    "createSessionRenderer",
    "createAgentActions",
    "createDrawerData",
    "createDrawerContent",
    "createDrawer",
    "createRunModal",
    "createNavigationEventBindings",
    "createSessionEventBindings",
    "createFilterEventBindings",
    "createDialogEventBindings",
    "createEventBindings",
  ].forEach(install);
  window.LoadToAgentApp = app;

  const { $, esc, state, loadGuideState, bindEvents, render, timeOnly, loadSessionDetail, renderUpdateSettings, syncViewChrome, toast } = app;

  async function init() {
    loadGuideState();
    if (!window.loadtoagent) {
      $("#emptyState").classList.remove("hidden");
      $("#emptyState p").textContent = "LoadToAgent 프로그램에서 열면 이 컴퓨터의 AI 작업 기록을 불러옵니다.";
      return;
    }
    const bootstrap = await window.loadtoagent.bootstrap();
    if (window.loadtoagent.setLocale) await window.loadtoagent.setLocale(window.LoadToAgentI18n?.getLocale() || "ko");
    state.providers = bootstrap.providers || [];
    state.providerMap = new Map(state.providers.map((provider) => [provider.id, provider]));
    state.availability = bootstrap.availability || {};
    state.workspaces = bootstrap.workspaces || [];
    state.snapshot = bootstrap.snapshot;
    state.activeRuns = bootstrap.activeRuns || [];
    state.platform = bootstrap.platform || state.platform;
    state.versions = bootstrap.versions || {};
    state.update = bootstrap.update || { status: "idle", currentVersion: state.versions.app || "" };
    bindEvents();
    render();
    $("#lastSync").textContent = timeOnly(state.snapshot && state.snapshot.generatedAt);
    window.loadtoagent.onSnapshot((snapshot) => {
      state.snapshot = snapshot;
      if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.updateSnapshot(snapshot, state.workspaces);
      $("#lastSync").textContent = timeOnly(snapshot.generatedAt);
      render();
      if (state.selectedId && $("#detailDrawer").classList.contains("open") && !state.detailLoadingIds.has(state.selectedId)) {
        const card = (snapshot.sessions || []).find((session) => session.id === state.selectedId);
        const detail = state.details.get(state.selectedId);
        if (card && detail && card.updatedAt !== detail.updatedAt) loadSessionDetail(state.selectedId, true);
      }
    });
    if (window.loadtoagent.onUpdateState)
      window.loadtoagent.onUpdateState((update) => {
        state.update = update;
        renderUpdateSettings();
      });
  }

  app.init = init;

  window.addEventListener("loadtoagent:locale-changed", (event) => {
    if (window.loadtoagent?.setLocale) {
      Promise.resolve(window.loadtoagent.setLocale(event.detail.locale)).catch((error) => {
        window.LoadToAgentRendererUtils.reportRecoverableError("locale-persistence", error);
      });
    }
    if (!state.snapshot) {
      syncViewChrome();
      return;
    }
    render("locale");
    $("#lastSync").textContent = timeOnly(state.snapshot.generatedAt);
  });

  init().catch((error) => {
    console.error(error);
    $("#lastSync").textContent = window.LoadToAgentI18n.t("ui.connection_failed");
    toast(`초기화 실패: ${error.message}`);
  });
})();
