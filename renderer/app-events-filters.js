"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createFilterEventBindings = function createFilterEventBindings(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const { $, state, setProviderVisible = () => {}, visibleSnapshot = () => state.snapshot, closeDrawer = () => {}, renderSessions, render, renderWorkspaces, renderProviderOverview, renderProviderFilter, toggleProviderFilter, announceProviderFilter, performUiAction, toast } = context;

  function bindFilterAndWorkspaceEvents() {
    $("#loadMoreBtn").addEventListener("click", () => {
      state.visibleLimit += 30;
      renderSessions("load-more");
    });
    $("#workspaceList").addEventListener("click", async (event) => {
      const remove = event.target.closest("[data-remove-workspace]");
      if (remove) {
        event.stopPropagation();
        const workspaces = await performUiAction(() => window.loadtoagent.removeWorkspace(remove.dataset.removeWorkspace), t("workspace.remove_failed"));
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
      requestAnimationFrame(() => {
        const next = $("#providerFilter").querySelector(`[data-provider-filter="${CSS.escape(chip.dataset.providerFilter)}"]`);
        next?.classList.add("filter-clicked");
        next?.focus();
      });
    });
    $("#sortSelect").addEventListener("change", (event) => {
      state.sort = event.target.value;
      state.visibleLimit = 30;
      renderSessions("filter");
    });
    $("#providerVisibilityList").addEventListener("change", (event) => {
      const input = event.target.closest("[data-provider-visibility]");
      if (!input) return;
      const selectedBeforeChange = (state.rawSnapshot?.sessions || []).find((session) => session.id === state.selectedId)
        || state.details.get(state.selectedId);
      setProviderVisible(input.dataset.providerVisibility, input.checked);
      Promise.resolve(window.loadtoagent.setProviderVisibility?.({ hidden: [...state.hiddenProviders] })).catch((error) => {
        window.LoadToAgentRendererUtils.reportRecoverableError("provider-visibility-persistence", error);
        toast(t("settings.providers.save_failed"));
      });
      state.visibleLimit = 30;
      if (state.selectedId) {
        if (selectedBeforeChange && state.hiddenProviders.has(selectedBeforeChange.provider)) {
          closeDrawer();
        }
      }
      if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.updateSnapshot(visibleSnapshot(), state.workspaces);
      render("filter");
      toast(t(input.checked ? "settings.providers.shown_toast" : "settings.providers.hidden_toast"));
    });
    $("#addWorkspaceBtn").addEventListener("click", async () => {
      const workspaces = await performUiAction(() => window.loadtoagent.addWorkspaces(), t("workspace.add_failed"));
      if (!workspaces) return;
      state.workspaces = workspaces;
      renderWorkspaces();
    });
    $("#probeBtn").addEventListener("click", async () => {
      const nextAvailability = await performUiAction(() => window.loadtoagent.probeProviders(), t("run.cli_check_failed"));
      if (!nextAvailability) return;
      state.availability = nextAvailability;
      render();
      toast(window.LoadToAgentI18n.t("ui.ai_cli_connections_were_checked_again"));
    });
  }

  return { bindFilterAndWorkspaceEvents };
};
