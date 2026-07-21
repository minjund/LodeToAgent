"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createSessionEventBindings = function createSessionEventBindings(context = {}) {
  const {
    $, state, selectView, renderProviderOverview, renderProviderFilter, toggleProviderFilter, announceProviderFilter, renderSessions, renderTmuxMap, openDrawer, openSubagentConversation,
    dispatchAgentCommand, openAgentTerminal, copyBridgeCommand, openSessionOrigin, saveDashboardPreferences = () => {},
    controlManagedRun, quickRespond, prepareReassignment,
    copyText = async () => false,
    announce = () => {},
  } = context;

  const managementFilterLabel = value => value === "all" ? window.LoadToAgentI18n.t("management.filter_all") : window.LoadToAgentI18n.t(`management.health.${value}`);
  const announceManagementFilter = value => announce(window.LoadToAgentI18n.t("management.filter_results", {
    filter: managementFilterLabel(value),
    count: $("#attentionInbox")?.querySelectorAll("[data-management-session]").length || 0,
  }));

  function bindManagementEvents() {
    $("#operationsOverview").addEventListener("click", (event) => {
      const open = event.target.closest("[data-open-session]");
      if (open) return openDrawer(open.dataset.openSession);
      const filter = event.target.closest("[data-management-filter]");
      if (!filter) return;
      selectView("waiting", { focusMain: true, managementFilter: filter.dataset.managementFilter });
      announceManagementFilter(filter.dataset.managementFilter);
    });
    $("#attentionInbox").addEventListener("click", async (event) => {
      const filter = event.target.closest("[data-management-inbox-filter]");
      if (filter) {
        state.managementFilter = filter.dataset.managementInboxFilter;
        renderSessions("filter");
        announceManagementFilter(state.managementFilter);
        requestAnimationFrame(() => $("#attentionInbox")?.querySelector(`[data-management-inbox-filter="${CSS.escape(state.managementFilter)}"]`)?.focus({ preventScroll: true }));
        return;
      }
      const open = event.target.closest("[data-open-session]");
      if (open) return openDrawer(open.dataset.openSession);
      const quick = event.target.closest("[data-attention-quick]");
      if (quick) return quickRespond(quick.dataset.attentionSessionId, quick.dataset.attentionQuick, $("#attentionInbox"));
      const managed = event.target.closest("[data-managed-run-action]");
      if (managed) return controlManagedRun(managed.dataset.managementSessionId, managed.dataset.managedRunAction);
      const reassign = event.target.closest("[data-reassign-session]");
      if (reassign) prepareReassignment(reassign.dataset.reassignSession);
    });
    $("#attentionInbox").addEventListener("input", (event) => {
      const input = event.target.closest("[data-agent-command-draft]");
      if (input) state.agentCommandDrafts.set(input.dataset.agentCommandDraft, input.value);
    });
    $("#attentionInbox").addEventListener("change", (event) => {
      const picker = event.target.closest("[data-agent-command-target]");
      if (!picker) return;
      if (picker.value) state.agentCommandTargets.set(picker.dataset.agentCommandTarget, picker.value);
      else state.agentCommandTargets.delete(picker.dataset.agentCommandTarget);
      picker.closest("form")?.querySelectorAll("button").forEach(button => { button.disabled = !picker.value; });
    });
    $("#attentionInbox").addEventListener("keydown", (event) => {
      const input = event.target.closest("[data-agent-command-draft]");
      if (!input || event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      input.closest("form")?.requestSubmit();
    });
    $("#attentionInbox").addEventListener("submit", (event) => {
      const form = event.target.closest("[data-agent-command-form]");
      if (!form) return;
      event.preventDefault();
      dispatchAgentCommand(form.dataset.agentCommandForm, form);
    });
  }

  function bindSessionListEvents() {
    $("#automationOverview").addEventListener("click", (event) => {
      const loopSelect = event.target.closest("[data-loop-select]");
      if (loopSelect) {
        state.selectedRuntimeLoopId = loopSelect.dataset.loopSelect;
        renderSessions("focus");
        requestAnimationFrame(() => $("#automationOverview").querySelector(`[data-loop-select="${CSS.escape(state.selectedRuntimeLoopId)}"]`)?.focus({ preventScroll: true }));
        return;
      }
      const sessionTarget = event.target.closest("[data-loop-open], [data-automation-session]");
      if (sessionTarget) openDrawer(sessionTarget.dataset.loopOpen || sessionTarget.dataset.automationSession);
    });
    $("#automationOverview").addEventListener("keydown", (event) => {
      const loop = event.target.closest("[data-loop-select]");
      if (loop && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        const tabs = Array.from(event.currentTarget.querySelectorAll("[data-loop-select]"));
        const current = Math.max(0, tabs.indexOf(loop));
        const next = event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault();
        state.selectedRuntimeLoopId = tabs[next].dataset.loopSelect;
        renderSessions("focus");
        requestAnimationFrame(() => $("#automationOverview")?.querySelector(`[data-loop-select="${CSS.escape(state.selectedRuntimeLoopId)}"]`)?.focus({ preventScroll: true }));
        return;
      }
    });
    $("#providerOverview").addEventListener("click", (event) => {
      const card = event.target.closest("[data-provider-card]");
      if (!card) return;
      toggleProviderFilter(card.dataset.providerCard);
      state.visibleLimit = 30;
      renderProviderFilter();
      renderProviderOverview();
      renderSessions("filter");
      announceProviderFilter();
      saveDashboardPreferences();
      const next = $("#providerOverview").querySelector(`[data-provider-card="${CSS.escape(card.dataset.providerCard)}"]`);
      next?.classList.add("filter-clicked");
      next?.focus();
    });
    $("#providerOverview").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const cards = Array.from(event.currentTarget.querySelectorAll("[data-provider-card]"));
      if (!cards.length) return;
      const current = Math.max(0, cards.indexOf(event.target.closest("[data-provider-card]")));
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? cards.length - 1
          : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + cards.length) % cards.length;
      event.preventDefault();
      cards[next].focus();
    });
    $("#sessionGrid").addEventListener("click", (event) => {
      const card = event.target.closest("[data-session-id]");
      if (card) openDrawer(card.dataset.sessionId);
    });
    $("#sessionGrid").addEventListener("keydown", (event) => {
      const card = event.target.closest("[data-session-id]");
      if (card && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        openDrawer(card.dataset.sessionId);
      }
    });
  }

  function bindLiveAgentEvents() {
    $("#liveSessionGrid").addEventListener("click", async (event) => {
      const copy = event.target.closest("[data-copy-text]");
      if (copy) {
        event.stopPropagation();
        await copyText(copy.dataset.copyText);
        return;
      }
      const executionHistory = event.target.closest("[data-execution-history-toggle]");
      if (executionHistory) {
        event.stopPropagation();
        const ownerId = executionHistory.dataset.executionHistoryToggle;
        if (state.expandedExecutionSessions.has(ownerId)) state.expandedExecutionSessions.delete(ownerId);
        else state.expandedExecutionSessions.add(ownerId);
        renderSessions("expand");
        requestAnimationFrame(() => $("#liveSessionGrid")?.querySelector(`[data-execution-history-toggle="${CSS.escape(ownerId)}"]`)?.focus({ preventScroll: true }));
        return;
      }
      const tmuxPane = event.target.closest('.live-tmux-pane[data-tmux-type="pane"][data-tmux-id]');
      const tmuxOverview = event.target.closest(".live-tmux-overview-open");
      if (tmuxPane || tmuxOverview) {
        event.stopPropagation();
        if (tmuxPane) state.tmuxFocus = { type: "pane", id: tmuxPane.dataset.tmuxId };
        selectView("tmux");
        if (tmuxPane) window.LoadToAgentTerminal?.selectTmuxById(tmuxPane.dataset.tmuxId);
        return;
      }
      const bridge = event.target.closest("[data-agent-bridge-copy]");
      if (bridge) {
        event.stopPropagation();
        copyBridgeCommand(bridge.dataset.agentBridgeCopy);
        return;
      }
      const origin = event.target.closest("[data-agent-open-origin]");
      if (origin) {
        event.stopPropagation();
        openSessionOrigin(origin.dataset.agentOpenOrigin);
        return;
      }
      const terminal = event.target.closest("[data-agent-terminal-open]");
      if (terminal) {
        event.stopPropagation();
        openAgentTerminal(terminal.dataset.agentTerminalOpen);
        return;
      }
      const completedToggle = event.target.closest("[data-subagent-completed-toggle]");
      if (completedToggle) {
        const ownerId = completedToggle.dataset.subagentCompletedToggle;
        if (state.expandedCompletedSubagents.has(ownerId)) state.expandedCompletedSubagents.delete(ownerId);
        else state.expandedCompletedSubagents.add(ownerId);
        renderSessions("expand");
        return;
      }
      const more = event.target.closest("[data-graph-provider-more]");
      if (more) {
        state.graphExpandedProviders.add(more.dataset.graphProviderMore);
        renderSessions("expand");
        return;
      }
      const less = event.target.closest("[data-graph-provider-less]");
      if (less) {
        state.graphExpandedProviders.delete(less.dataset.graphProviderLess);
        renderSessions("expand");
        return;
      }
      const open = event.target.closest("[data-open-session]");
      if (open) {
        event.stopPropagation();
        openDrawer(open.dataset.openSession);
        return;
      }
      const subagentChat = event.target.closest("[data-open-subagent-chat]");
      if (subagentChat) {
        event.stopPropagation();
        openSubagentConversation(subagentChat.dataset.openSubagentChat);
        return;
      }
      const node = event.target.closest("[data-graph-focus]");
      if (!node) return;
      if (state.graphFocusId === node.dataset.graphFocus) openDrawer(node.dataset.graphFocus);
      else {
        state.graphFocusId = node.dataset.graphFocus;
        renderSessions("focus");
      }
    });
    $("#liveSessionGrid").addEventListener("input", (event) => {
      const input = event.target.closest("[data-agent-command-draft]");
      if (input) state.agentCommandDrafts.set(input.dataset.agentCommandDraft, input.value);
    });
    $("#liveSessionGrid").addEventListener("change", (event) => {
      const picker = event.target.closest("[data-agent-command-target]");
      if (!picker) return;
      if (picker.value) state.agentCommandTargets.set(picker.dataset.agentCommandTarget, picker.value);
      else state.agentCommandTargets.delete(picker.dataset.agentCommandTarget);
      const form = picker.closest("[data-agent-command-form]");
      const enabled = Boolean(picker.value);
      form &&
        form.querySelectorAll("button").forEach((button) => {
          button.disabled = !enabled;
        });
    });
    $("#liveSessionGrid").addEventListener("keydown", (event) => {
      const input = event.target.closest("[data-agent-command-draft]");
      if (!input || event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      input.closest("form")?.requestSubmit();
    });
    $("#liveSessionGrid").addEventListener("submit", (event) => {
      const form = event.target.closest("[data-agent-command-form]");
      if (!form) return;
      event.preventDefault();
      dispatchAgentCommand(form.dataset.agentCommandForm, form);
    });
  }

  function bindGraphNavigationEvents() {
    $("#openTmuxFromAgentWork").addEventListener("click", () => selectView("tmux", { focusMain: true }));
    $("#graphBreadcrumbs").addEventListener("click", (event) => {
      if (event.target.closest("[data-graph-reset]")) state.graphFocusId = null;
      else {
        const node = event.target.closest("[data-graph-focus]");
        if (!node) return;
        state.graphFocusId = node.dataset.graphFocus;
      }
      renderSessions("focus-back");
    });
    $("#graphResetBtn").addEventListener("click", () => {
      state.graphFocusId = null;
      renderSessions("focus-back");
    });
  }

  function bindTmuxMapEvents() {
    $("#tmuxMap").addEventListener("click", (event) => {
      const subagentToggle = event.target.closest("[data-tmux-subagents-toggle]");
      if (subagentToggle) {
        event.stopPropagation();
        const paneId = subagentToggle.dataset.tmuxSubagentsToggle;
        if (state.expandedTmuxSubagents.has(paneId)) state.expandedTmuxSubagents.delete(paneId);
        else state.expandedTmuxSubagents.add(paneId);
        renderTmuxMap();
        requestAnimationFrame(() => $("#tmuxMap").querySelector(`[data-tmux-subagents-toggle="${CSS.escape(paneId)}"]`)?.focus({ preventScroll: true }));
        return;
      }
      const subagentChat = event.target.closest("[data-open-subagent-chat]");
      if (subagentChat) {
        event.stopPropagation();
        openSubagentConversation(subagentChat.dataset.openSubagentChat);
        return;
      }
      const control = event.target.closest("[data-control-tmux]");
      if (control) {
        event.stopPropagation();
        window.LoadToAgentTerminal?.selectTmuxById(control.dataset.controlTmux);
        $("#tmuxControlSection").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const open = event.target.closest("[data-open-session]");
      if (open) {
        event.stopPropagation();
        openDrawer(open.dataset.openSession);
        return;
      }
      const node = event.target.closest("[data-tmux-type][data-tmux-id]");
      if (!node) return;
      const nextFocus = { type: node.dataset.tmuxType, id: node.dataset.tmuxId };
      state.tmuxFocus = nextFocus;
      renderTmuxMap();
      requestAnimationFrame(() => $("#tmuxMap")?.querySelector(`[data-tmux-type="${CSS.escape(nextFocus.type)}"][data-tmux-id="${CSS.escape(nextFocus.id)}"]`)?.focus({ preventScroll: true }));
      if (node.dataset.tmuxType === "pane") window.LoadToAgentTerminal?.selectTmuxById(node.dataset.tmuxId);
    });
    $("#tmuxMap").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const nodes = Array.from(event.currentTarget.querySelectorAll("[data-tmux-type][data-tmux-id]"));
      const current = Math.max(0, nodes.indexOf(event.target.closest("[data-tmux-type][data-tmux-id]")));
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? nodes.length - 1
          : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + nodes.length) % nodes.length;
      event.preventDefault();
      nodes.forEach((candidate, index) => { candidate.tabIndex = index === next ? 0 : -1; });
      nodes[next]?.focus();
    });
    $("#tmuxBreadcrumbs").addEventListener("click", (event) => {
      if (event.target.closest("[data-tmux-reset]")) state.tmuxFocus = null;
      else {
        const node = event.target.closest("[data-tmux-type][data-tmux-id]");
        if (!node) return;
        state.tmuxFocus = { type: node.dataset.tmuxType, id: node.dataset.tmuxId };
      }
      renderTmuxMap();
    });
    $("#tmuxBreadcrumbs").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const items = Array.from(event.currentTarget.querySelectorAll("button"));
      const current = Math.max(0, items.indexOf(event.target.closest("button")));
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
      event.preventDefault();
      items.forEach((candidate, index) => { candidate.tabIndex = index === next ? 0 : -1; });
      items[next]?.focus();
    });
    $("#tmuxResetBtn").addEventListener("click", () => {
      state.tmuxFocus = null;
      renderTmuxMap();
    });
  }

  function bindSessionAndAgentEvents() {
    bindManagementEvents();
    bindSessionListEvents();
    bindLiveAgentEvents();
    bindGraphNavigationEvents();
    bindTmuxMapEvents();
  }

  return { bindSessionAndAgentEvents };
};
