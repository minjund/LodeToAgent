"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createFilterEventBindings = function createFilterEventBindings(context = {}) {
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
        toast("AI 표시 설정을 저장하지 못했습니다.");
      });
      state.visibleLimit = 30;
      if (state.selectedId) {
        if (selectedBeforeChange && state.hiddenProviders.has(selectedBeforeChange.provider)) {
          closeDrawer();
        }
      }
      if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.updateSnapshot(visibleSnapshot(), state.workspaces);
      render("filter");
      toast(input.checked ? "선택한 AI를 다시 표시합니다." : "선택한 AI를 앱에서 숨겼습니다.");
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
