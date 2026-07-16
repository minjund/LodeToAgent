"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createSessionEventBindings = function createSessionEventBindings(context = {}) {
  const {
    $, state, selectView, renderProviderOverview, renderProviderFilter, toggleProviderFilter, announceProviderFilter, renderSessions, renderTmuxMap, openDrawer, openSubagentConversation,
    dispatchAgentCommand, openAgentTerminal, copyBridgeCommand, openSessionOrigin,
  } = context;

  function bindSessionListEvents() {
    $("#automationOverview").addEventListener("click", (event) => {
      const loopSelect = event.target.closest("[data-loop-select]");
      if (loopSelect) {
        state.selectedRuntimeLoopId = loopSelect.dataset.loopSelect;
        renderSessions("focus");
        requestAnimationFrame(() => $("#automationOverview").querySelector(`[data-loop-select="${CSS.escape(state.selectedRuntimeLoopId)}"]`)?.focus());
        return;
      }
      const sessionTarget = event.target.closest("[data-loop-open], [data-automation-session]");
      if (sessionTarget) openDrawer(sessionTarget.dataset.loopOpen || sessionTarget.dataset.automationSession);
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
      requestAnimationFrame(() => {
        const next = $("#providerOverview").querySelector(`[data-provider-card="${CSS.escape(card.dataset.providerCard)}"]`);
        next?.classList.add("filter-clicked");
        next?.focus();
      });
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
    $("#liveSessionGrid").addEventListener("click", (event) => {
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
        requestAnimationFrame(() => $("#tmuxMap").querySelector(`[data-tmux-subagents-toggle="${CSS.escape(paneId)}"]`)?.focus());
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
      state.tmuxFocus = { type: node.dataset.tmuxType, id: node.dataset.tmuxId };
      renderTmuxMap();
      if (node.dataset.tmuxType === "pane") window.LoadToAgentTerminal?.selectTmuxById(node.dataset.tmuxId);
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
    $("#tmuxResetBtn").addEventListener("click", () => {
      state.tmuxFocus = null;
      renderTmuxMap();
    });
  }

  function bindSessionAndAgentEvents() {
    bindSessionListEvents();
    bindLiveAgentEvents();
    bindGraphNavigationEvents();
    bindTmuxMapEvents();
  }

  return { bindSessionAndAgentEvents };
};
