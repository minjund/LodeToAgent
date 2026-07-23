"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createFilterEventBindings = function createFilterEventBindings(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const { $, state, setProviderVisible = () => {}, visibleSnapshot = () => state.snapshot, closeDrawer = () => {}, openDrawer = () => {}, renderSessions, render, renderWorkspaces, renderProviderOverview, renderProviderFilter, toggleProviderFilter, announceProviderFilter, filteredSessions, performUiAction, toast, announce, normalizedSearch = (value) => String(value || "").trim(), saveDashboardPreferences = () => {}, restoreDialogTrigger = () => {}, setDialogOpenState = () => {}, syncControlRoomDisclosureButtons = () => {} } = context;

  function bindFilterAndWorkspaceEvents() {
    const syncFilterResetButton = () => {
      const hasFilters = Boolean(
        $("#searchInput").value || state.search || state.providerFilters.size || state.workspace !== "all" || state.sort !== "recent" || state.controlRoomSort !== "recent",
      );
      $("#resetFiltersBtn").classList.toggle("hidden", !hasFilters);
    };
    const moveFocus = (event, container, selector, previousKeys, nextKeys) => {
      if (![...previousKeys, ...nextKeys, "Home", "End"].includes(event.key)) return false;
      const items = Array.from(container.querySelectorAll(selector)).filter((item) => !item.disabled && !item.hidden);
      if (!items.length) return false;
      const current = Math.max(0, items.indexOf(event.target.closest(selector)));
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (nextKeys.includes(event.key) ? 1 : -1) + items.length) % items.length;
      event.preventDefault();
      items[next].focus();
      return true;
    };
    $("#loadMoreBtn").addEventListener("click", () => {
      const previousCount = document.querySelectorAll("#sessionGrid [data-session-id]").length;
      state.visibleLimit += 30;
      renderSessions("load-more");
      const cards = document.querySelectorAll("#sessionGrid [data-session-id]");
      cards[Math.min(previousCount, cards.length - 1)]?.focus({ preventScroll: true });
      announce(window.LoadToAgentI18n.t("filter.more_loaded", { count: Math.max(0, cards.length - previousCount) }));
    });
    const workspaceLists = [$("#workspaceList"), $("#mobileWorkspaceList")].filter(Boolean);
    const handleWorkspaceClick = async (event) => {
      const activeList = event.currentTarget;
      const remove = event.target.closest("[data-remove-workspace]");
      if (remove) {
        event.stopPropagation();
        const path = remove.dataset.removeWorkspace;
        const workspaceItems = Array.from(activeList.querySelectorAll("[data-workspace]"));
        const workspaceIndex = Math.max(0, workspaceItems.indexOf(remove.closest(".workspace-row")?.querySelector("[data-workspace]")));
        const workspaces = await performUiAction(() => window.loadtoagent.removeWorkspace(remove.dataset.removeWorkspace), t("workspace.remove_failed"), remove);
        if (!workspaces) return;
        state.workspaces = workspaces;
        if (state.workspace === remove.dataset.removeWorkspace) state.workspace = "all";
        render();
        syncFilterResetButton();
        saveDashboardPreferences();
        requestAnimationFrame(() => {
          const nextItems = Array.from(activeList.querySelectorAll("[data-workspace]"));
          nextItems[Math.min(workspaceIndex, nextItems.length - 1)]?.focus();
        });
        announce(window.LoadToAgentI18n.t("quality.workspace_removed", { name: path.split(/[\\/]/).filter(Boolean).pop() || path }));
        return;
      }
      const item = event.target.closest("[data-workspace]");
      if (item) {
        const label = item.querySelector("strong")?.textContent.trim() || t("project.all");
        state.workspace = item.dataset.workspace;
        state.visibleLimit = 30;
        renderWorkspaces();
        renderSessions("filter");
        syncFilterResetButton();
        saveDashboardPreferences();
        announce(t("filter.workspace_results", { project: label, count: filteredSessions().length }));
        if (activeList.id === "mobileWorkspaceList") {
          const menu = $("#mobileToolsMenu");
          setDialogOpenState(menu, false);
          menu?.classList.add("hidden");
          $("#mobileMoreBtn")?.setAttribute("aria-expanded", "false");
          const focusResults = () => {
            const result = $("#liveSessionGrid")?.querySelector("[data-graph-focus], [data-open-session]")
              || $("#sessionGrid")?.querySelector("[data-session-id]");
            result?.focus({ preventScroll: true });
            if (document.activeElement !== result) $("#mainContent")?.focus({ preventScroll: true });
          };
          restoreDialogTrigger();
          focusResults();
          requestAnimationFrame(focusResults);
        }
      }
    };
    workspaceLists.forEach((list) => {
      list.addEventListener("click", handleWorkspaceClick);
      list.addEventListener("keydown", (event) => {
        const horizontal = event.currentTarget.id === "workspaceList";
        moveFocus(event, event.currentTarget, "[data-workspace]", horizontal ? ["ArrowLeft", "ArrowUp"] : ["ArrowUp"], horizontal ? ["ArrowRight", "ArrowDown"] : ["ArrowDown"]);
      });
    });
    const controlProjectSelect = $("#controlRoomProjectSelect");
    controlProjectSelect?.addEventListener("change", (event) => {
      state.workspace = event.target.value;
      state.visibleLimit = 30;
      renderWorkspaces();
      renderSessions("filter");
      syncFilterResetButton();
      saveDashboardPreferences();
      announce(t("filter.workspace_results", { project: event.target.selectedOptions[0]?.textContent || t("control.all_projects"), count: filteredSessions().length }));
    });
    const controlSortSelect = $("#controlRoomSortSelect");
    controlSortSelect?.addEventListener("change", (event) => {
      state.controlRoomSort = event.target.value;
      state.visibleLimit = 30;
      renderSessions("filter");
      syncFilterResetButton();
      saveDashboardPreferences();
      announce(t("filter.sort_changed", { sort: event.target.selectedOptions[0]?.textContent || event.target.value, count: filteredSessions().length }));
    });
    const controlSearch = $("#controlRoomSearch");
    const controlSearchInput = $("#controlRoomSearchInput");
    const controlSearchButton = $("#controlRoomSearchBtn");
    let controlSearchTimer = null;
    const setControlSearchOpen = (open) => {
      controlSearch?.classList.toggle("is-open", open);
      controlSearchButton?.setAttribute("aria-expanded", open ? "true" : "false");
      if (controlSearchInput) {
        controlSearchInput.tabIndex = open ? 0 : -1;
        controlSearchInput.setAttribute("aria-hidden", open ? "false" : "true");
      }
      if (open) requestAnimationFrame(() => controlSearchInput?.focus());
    };
    controlSearchButton?.addEventListener("click", () => setControlSearchOpen(!controlSearch?.classList.contains("is-open")));
    controlSearchInput?.addEventListener("input", (event) => {
      clearTimeout(controlSearchTimer);
      const value = event.target.value;
      if ($("#searchInput")) $("#searchInput").value = value;
      controlSearchTimer = setTimeout(() => {
        state.search = normalizedSearch(value);
        state.visibleLimit = 30;
        renderSessions("filter");
        syncFilterResetButton();
        saveDashboardPreferences();
        announce(t("filter.search_results", { count: filteredSessions().length }));
      }, 120);
    });
    controlSearchInput?.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (event.currentTarget.value) {
        event.currentTarget.value = "";
        event.currentTarget.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        setControlSearchOpen(false);
        controlSearchButton?.focus();
      }
    });
    const setAllControlRoomGroups = (open) => {
      document.querySelectorAll("#liveSessionGrid .control-room-project-group").forEach(group => {
        group.open = open;
      });
      syncControlRoomDisclosureButtons();
      announce(t(open ? "control.all_projects_expanded" : "control.all_projects_collapsed"));
    };
    $("#controlRoomExpandAll")?.addEventListener("click", () => setAllControlRoomGroups(true));
    $("#controlRoomCollapseAll")?.addEventListener("click", () => setAllControlRoomGroups(false));
    $("#liveSessionGrid")?.addEventListener("toggle", (event) => {
      if (event.target.matches?.(".control-room-project-group")) syncControlRoomDisclosureButtons();
    }, true);
    let searchTimer = null;
    $("#searchInput").addEventListener("input", (event) => {
      clearTimeout(searchTimer);
      const value = event.target.value;
      $("#searchClearBtn").classList.toggle("hidden", !value);
      syncFilterResetButton();
      searchTimer = setTimeout(() => {
        state.search = normalizedSearch(value);
        state.visibleLimit = 30;
        renderSessions("filter");
        announce(window.LoadToAgentI18n.t("filter.search_results", { count: filteredSessions().length }));
        syncFilterResetButton();
        saveDashboardPreferences();
      }, 120);
    });
    $("#searchClearBtn").addEventListener("click", () => {
      clearTimeout(searchTimer);
      $("#searchInput").value = "";
      $("#searchClearBtn").classList.add("hidden");
      state.search = "";
      state.visibleLimit = 30;
      renderSessions("filter");
      announce(window.LoadToAgentI18n.t("filter.search_cleared"));
      $("#searchInput").focus();
      syncFilterResetButton();
      saveDashboardPreferences();
    });
    $("#searchInput").addEventListener("keydown", (event) => {
      if (event.key === "Escape" && event.currentTarget.value) {
        event.preventDefault();
        $("#searchClearBtn").click();
        return;
      }
      if (event.key === "ArrowDown") {
        const first = $("#sessionGrid [data-session-id]") || $("#liveSessionGrid button, #liveSessionGrid [tabindex='0']");
        if (first) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === "Enter" && filteredSessions().length === 1) {
        event.preventDefault();
        openDrawer(filteredSessions()[0].id);
      }
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
      const next = $("#providerFilter").querySelector(`[data-provider-filter="${CSS.escape(chip.dataset.providerFilter)}"]`);
      next?.classList.add("filter-clicked");
      next?.focus();
      syncFilterResetButton();
      saveDashboardPreferences();
    });
    $("#providerFilter").addEventListener("keydown", (event) => {
      moveFocus(event, event.currentTarget, "[data-provider-filter]", ["ArrowLeft", "ArrowUp"], ["ArrowRight", "ArrowDown"]);
    });
    $("#sortSelect").addEventListener("change", (event) => {
      state.sort = event.target.value;
      state.visibleLimit = 30;
      renderSessions("filter");
      const label = event.target.selectedOptions[0]?.textContent || event.target.value;
      announce(window.LoadToAgentI18n.t("filter.sort_changed", { sort: label, count: filteredSessions().length }));
      syncFilterResetButton();
      saveDashboardPreferences();
    });
    $("#resetFiltersBtn").addEventListener("click", () => {
      clearTimeout(searchTimer);
      state.search = "";
      state.providerFilters.clear();
      state.workspace = "all";
      state.sort = "recent";
      state.controlRoomSort = "recent";
      state.visibleLimit = 30;
      $("#searchInput").value = "";
      $("#searchClearBtn").classList.add("hidden");
      $("#sortSelect").value = "recent";
      renderWorkspaces();
      renderProviderFilter();
      renderProviderOverview();
      renderSessions("filter");
      syncFilterResetButton();
      saveDashboardPreferences();
      announce(window.LoadToAgentI18n.t("filter.reset_done", { count: filteredSessions().length }));
      $("#searchInput").focus();
    });
    $("#providerVisibilityList").addEventListener("change", async (event) => {
      const input = event.target.closest("[data-provider-visibility]");
      if (!input) return;
      const providerId = input.dataset.providerVisibility;
      const previousVisible = !input.checked;
      const selectedBeforeChange = (state.rawSnapshot?.sessions || []).find((session) => session.id === state.selectedId)
        || state.details.get(state.selectedId);
      setProviderVisible(providerId, input.checked);
      state.visibleLimit = 30;
      if (state.selectedId && selectedBeforeChange && state.hiddenProviders.has(selectedBeforeChange.provider)) closeDrawer();
      if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.updateSnapshot(visibleSnapshot(), state.workspaces);
      render("filter");
      try {
        await Promise.resolve(window.loadtoagent.setProviderVisibility?.({ hidden: [...state.hiddenProviders] }));
      } catch (error) {
        window.LoadToAgentRendererUtils.reportRecoverableError("provider-visibility-persistence", error);
        setProviderVisible(providerId, previousVisible);
        if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.updateSnapshot(visibleSnapshot(), state.workspaces);
        render("filter");
        toast(t("settings.providers.save_failed"));
        return;
      }
      toast(t(input.checked ? "settings.providers.shown_toast" : "settings.providers.hidden_toast"));
    });
    const addWorkspaceButtons = [$("#addWorkspaceBtn"), $("#mobileAddWorkspaceBtn")].filter(Boolean);
    const addWorkspace = async (event) => {
      const trigger = event.currentTarget;
      const previousPaths = new Set(state.workspaces.map((workspace) => workspace.path));
      const workspaces = await performUiAction(() => window.loadtoagent.addWorkspaces(), t("workspace.add_failed"), trigger);
      if (!workspaces) return;
      state.workspaces = workspaces;
      renderWorkspaces();
      syncFilterResetButton();
      const added = state.workspaces.find((workspace) => !previousPaths.has(workspace.path));
      requestAnimationFrame(() => {
        const targetList = trigger.id === "mobileAddWorkspaceBtn" ? $("#mobileWorkspaceList") : $("#workspaceList");
        if (added) targetList?.querySelector(`[data-workspace="${CSS.escape(added.path)}"]`)?.focus();
        else trigger.focus();
      });
      announce(window.LoadToAgentI18n.t("quality.workspace_added", { count: state.workspaces.length }));
    };
    addWorkspaceButtons.forEach((button) => button.addEventListener("click", addWorkspace));
    $("#probeBtn").addEventListener("click", async () => {
      const nextAvailability = await performUiAction(() => window.loadtoagent.probeProviders(), t("run.cli_check_failed"), $("#probeBtn"));
      if (!nextAvailability) return;
      state.availability = nextAvailability;
      render();
      toast(window.LoadToAgentI18n.t("ui.ai_cli_connections_were_checked_again"));
    });
    $("#searchClearBtn").classList.toggle("hidden", !$("#searchInput").value);
    syncFilterResetButton();
  }

  return { bindFilterAndWorkspaceEvents };
};
