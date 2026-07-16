"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createFilterEventBindings = function createFilterEventBindings(context = {}) {
  const { $, state, renderSessions, render, renderWorkspaces, renderProviderOverview, renderProviderFilter, toggleProviderFilter, announceProviderFilter, performUiAction, toast } = context;

  function bindFilterAndWorkspaceEvents() {
    $("#loadMoreBtn").addEventListener("click", () => {
      state.visibleLimit += 30;
      renderSessions("load-more");
    });
    $("#workspaceList").addEventListener("click", async (event) => {
      const remove = event.target.closest("[data-remove-workspace]");
      if (remove) {
        event.stopPropagation();
        const workspaces = await performUiAction(() => window.loadtoagent.removeWorkspace(remove.dataset.removeWorkspace), "작업 폴더를 제거하지 못했습니다.");
        if (!workspaces) return;
        state.workspaces = workspaces;
        if (state.workspace === remove.dataset.removeWorkspace) state.workspace = "all";
        render();
        return;
      }
      const item = event.target.closest("[data-workspace]");
      if (item) {
        state.workspace = item.dataset.workspace;
        state.visibleLimit = 30;
        renderWorkspaces();
        renderSessions("filter");
      }
    });
    let searchTimer = null;
    $("#searchInput").addEventListener("input", (event) => {
      clearTimeout(searchTimer);
      const value = event.target.value;
      searchTimer = setTimeout(() => {
        state.search = value;
        state.visibleLimit = 30;
        renderSessions("filter");
      }, 120);
    });
    $("#providerFilter").addEventListener("click", (event) => {
      const chip = event.target.closest("[data-provider-filter]");
      if (!chip) return;
      toggleProviderFilter(chip.dataset.providerFilter);
      state.visibleLimit = 30;
      renderProviderFilter();
      renderProviderOverview();
      renderSessions("filter");
      announceProviderFilter();
      requestAnimationFrame(() => $("#providerFilter").querySelector(`[data-provider-filter="${CSS.escape(chip.dataset.providerFilter)}"]`)?.focus());
    });
    $("#sortSelect").addEventListener("change", (event) => {
      state.sort = event.target.value;
      state.visibleLimit = 30;
      renderSessions("filter");
    });
    $("#addWorkspaceBtn").addEventListener("click", async () => {
      const workspaces = await performUiAction(() => window.loadtoagent.addWorkspaces(), "작업 폴더를 추가하지 못했습니다.");
      if (!workspaces) return;
      state.workspaces = workspaces;
      renderWorkspaces();
    });
    $("#probeBtn").addEventListener("click", async () => {
      const nextAvailability = await performUiAction(() => window.loadtoagent.probeProviders(), "AI CLI 연결 상태를 확인하지 못했습니다.");
      if (!nextAvailability) return;
      state.availability = nextAvailability;
      render();
      toast(window.LoadToAgentI18n.t("ui.ai_cli_connections_were_checked_again"));
    });
  }

  return { bindFilterAndWorkspaceEvents };
};
