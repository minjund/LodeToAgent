"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createSessionEventBindings = function createSessionEventBindings(context = {}) {
  const {
    $, state, selectView, renderProviderOverview, renderProviderFilter, toggleProviderFilter, announceProviderFilter, renderSessions, renderTmuxMap, openDrawer, openSubagentConversation, openExecutionActivity,
    dispatchAgentCommand, openAgentTerminal, copyBridgeCommand, saveDashboardPreferences = () => {},
    controlManagedRun, quickRespond, prepareReassignment,
    copyText = async () => false,
    announce = () => {},
    moveSessionOrder = () => false,
    moveProjectOrder = () => false,
    archiveSession = () => false,
  } = context;

  let sessionDragJustEnded = false;
  let projectDragEndedAt = 0;

  const sortableSessionId = node => String(node?.dataset.sessionSortable || "");
  const clearSessionDropState = container => {
    container.querySelectorAll("[data-session-sortable]").forEach(node => {
      node.classList.remove("session-sort-dragging");
      node.removeAttribute("data-session-drop-edge");
      node.setAttribute("aria-grabbed", "false");
    });
  };
  const sessionDropPlacement = (target, event) => {
    const bounds = target.getBoundingClientRect();
    const layout = window.getComputedStyle(target.parentElement || target);
    const columns = String(layout.gridTemplateColumns || "none").trim().split(/\s+/).filter(value => value && value !== "none");
    const horizontal = columns.length > 1;
    const placeAfter = horizontal
      ? event.clientX > bounds.left + bounds.width / 2
      : event.clientY > bounds.top + bounds.height / 2;
    return {
      placeAfter,
      edge: horizontal ? (placeAfter ? "right" : "left") : (placeAfter ? "bottom" : "top"),
    };
  };
  const commitSessionPosition = (container, sourceId, targetId, placeAfter, focusSource = false) => {
    if (!moveSessionOrder(sourceId, targetId, placeAfter)) return false;
    state.sort = "recent";
    state.controlRoomSort = "recent";
    if ($("#sortSelect")) $("#sortSelect").value = "recent";
    if ($("#controlRoomSortSelect")) $("#controlRoomSortSelect").value = "recent";
    saveDashboardPreferences();
    renderSessions("reorder");
    announce(window.LoadToAgentI18n.t("session.position_changed"));
    if (focusSource) requestAnimationFrame(() => container.querySelector(`[data-session-sortable="${CSS.escape(sourceId)}"]`)?.focus({ preventScroll: true }));
    return true;
  };
  const bindSortableSessionList = (container, selector) => {
    let draggedSessionId = "";
    const finishDrag = () => {
      clearSessionDropState(container);
      draggedSessionId = "";
      sessionDragJustEnded = true;
      setTimeout(() => { sessionDragJustEnded = false; }, 0);
    };
    container.addEventListener("dragstart", (event) => {
      const item = event.target.closest(selector);
      if (!item) return;
      if (event.target !== item && event.target.closest("button, a, input, select, textarea, summary, [contenteditable='true']")) {
        event.preventDefault();
        return;
      }
      draggedSessionId = sortableSessionId(item);
      if (!draggedSessionId) {
        event.preventDefault();
        return;
      }
      item.classList.add("session-sort-dragging");
      item.setAttribute("aria-grabbed", "true");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedSessionId);
        event.dataTransfer.setData("application/x-loadtoagent-session-list", container.id);
        const dragImage = item.querySelector(":scope > header, .card-head") || item;
        event.dataTransfer.setDragImage(dragImage, 20, 20);
      }
    });
    container.addEventListener("dragover", (event) => {
      const target = event.target.closest(selector);
      const sourceId = draggedSessionId || event.dataTransfer?.getData("text/plain");
      const sourceList = event.dataTransfer?.getData("application/x-loadtoagent-session-list");
      if (!target || !sourceId || (!draggedSessionId && sourceList !== container.id) || sortableSessionId(target) === sourceId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      container.querySelectorAll("[data-session-drop-edge]").forEach(node => node.removeAttribute("data-session-drop-edge"));
      target.dataset.sessionDropEdge = sessionDropPlacement(target, event).edge;
    });
    container.addEventListener("drop", (event) => {
      const target = event.target.closest(selector);
      const sourceId = draggedSessionId || event.dataTransfer?.getData("text/plain");
      const sourceList = event.dataTransfer?.getData("application/x-loadtoagent-session-list");
      if (!target || !sourceId || (!draggedSessionId && sourceList !== container.id) || sortableSessionId(target) === sourceId) return;
      event.preventDefault();
      event.stopPropagation();
      const placement = sessionDropPlacement(target, event);
      const changed = commitSessionPosition(container, sourceId, sortableSessionId(target), placement.placeAfter);
      finishDrag();
      if (!changed) clearSessionDropState(container);
    });
    container.addEventListener("dragend", finishDrag);
    container.addEventListener("dragleave", (event) => {
      if (!container.contains(event.relatedTarget)) clearSessionDropState(container);
    });
    container.addEventListener("keydown", (event) => {
      const item = event.target.closest(selector);
      if (!item || event.target !== item || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      const nodes = Array.from(container.querySelectorAll(selector));
      const current = nodes.indexOf(item);
      const offset = event.key === "ArrowUp" ? -1 : 1;
      const target = nodes[current + offset];
      if (current < 0 || !target) return;
      event.preventDefault();
      event.stopPropagation();
      commitSessionPosition(container, sortableSessionId(item), sortableSessionId(target), offset > 0, true);
    });
  };

  const bindSortableProjectGroups = (container) => {
    const selector = ".control-room-project-group[data-project-sortable]";
    let draggedProjectId = "";
    const projectId = node => String(node?.dataset.projectSortable || "");
    const clearProjectDropState = () => {
      container.querySelectorAll(selector).forEach(group => {
        group.classList.remove("project-sort-dragging");
        group.removeAttribute("data-project-drop-edge");
        group.querySelector(":scope > .control-project-header")?.setAttribute("aria-grabbed", "false");
      });
    };
    const finishProjectDrag = () => {
      clearProjectDropState();
      draggedProjectId = "";
      projectDragEndedAt = Date.now();
    };
    const commitProjectPosition = (sourceId, targetId, placeAfter, focusSource = false) => {
      if (!moveProjectOrder(sourceId, targetId, placeAfter)) return false;
      saveDashboardPreferences();
      renderSessions("reorder");
      announce(window.LoadToAgentI18n.t("project.position_changed"));
      if (focusSource) {
        requestAnimationFrame(() => container
          .querySelector(`${selector}[data-project-sortable="${CSS.escape(sourceId)}"] > .control-project-header`)
          ?.focus({ preventScroll: true }));
      }
      return true;
    };
    container.addEventListener("dragstart", (event) => {
      const header = event.target.closest(".control-project-header[draggable='true']");
      const group = header?.closest(selector);
      if (!group) return;
      draggedProjectId = projectId(group);
      if (!draggedProjectId) {
        event.preventDefault();
        return;
      }
      group.classList.add("project-sort-dragging");
      header.setAttribute("aria-grabbed", "true");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedProjectId);
        event.dataTransfer.setData("application/x-loadtoagent-project-list", container.id);
        event.dataTransfer.setDragImage(header, 20, 20);
      }
    });
    container.addEventListener("dragover", (event) => {
      if (!draggedProjectId) return;
      const target = event.target.closest(selector);
      if (!target || projectId(target) === draggedProjectId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      container.querySelectorAll(`${selector}[data-project-drop-edge]`).forEach(group => group.removeAttribute("data-project-drop-edge"));
      const bounds = target.getBoundingClientRect();
      target.dataset.projectDropEdge = event.clientY > bounds.top + bounds.height / 2 ? "bottom" : "top";
    });
    container.addEventListener("drop", (event) => {
      if (!draggedProjectId) return;
      const target = event.target.closest(selector);
      if (!target || projectId(target) === draggedProjectId) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = target.getBoundingClientRect();
      const changed = commitProjectPosition(
        draggedProjectId,
        projectId(target),
        event.clientY > bounds.top + bounds.height / 2,
      );
      finishProjectDrag();
      if (!changed) clearProjectDropState();
    });
    container.addEventListener("dragend", finishProjectDrag);
    container.addEventListener("dragleave", (event) => {
      if (!container.contains(event.relatedTarget)) clearProjectDropState();
    });
    container.addEventListener("keydown", (event) => {
      const header = event.target.closest(".control-project-header[draggable='true']");
      if (!header || event.target !== header || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      const group = header.closest(selector);
      const groups = Array.from(container.querySelectorAll(selector));
      const current = groups.indexOf(group);
      const offset = event.key === "ArrowUp" ? -1 : 1;
      const target = groups[current + offset];
      if (current < 0 || !target) return;
      event.preventDefault();
      event.stopPropagation();
      commitProjectPosition(projectId(group), projectId(target), offset > 0, true);
    });
  };

  const managementFilterLabel = value => value === "all" ? window.LoadToAgentI18n.t("management.filter_all") : window.LoadToAgentI18n.t(`management.health.${value}`);
  const announceManagementFilter = value => announce(window.LoadToAgentI18n.t("management.filter_results", {
    filter: managementFilterLabel(value),
    count: $("#attentionInbox")?.querySelectorAll("[data-management-session]").length || 0,
  }));

  function bindManagementEvents() {
    $("#operationsOverview").addEventListener("click", async (event) => {
      const route = event.target.closest("[data-agent-command-route]");
      if (route) {
        state.agentCommandRoutes.set(route.dataset.agentCommandSession, route.dataset.agentCommandRoute);
        renderSessions("route");
        return;
      }
      const intervention = event.target.closest("[data-supervision-intervention-open]");
      if (intervention) {
        const details = $("#operationsOverview")?.querySelector(`.supervision-intervention[data-disclosure-key="supervision:command:${CSS.escape(intervention.dataset.supervisionInterventionOpen)}"]`);
        if (details) {
          details.open = true;
          details.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }
      const supervision = event.target.closest("[data-supervision-focus]");
      if (supervision) {
        state.supervisionFocusId = supervision.dataset.supervisionFocus;
        renderSessions("focus");
        requestAnimationFrame(() => $("#operationsOverview")?.querySelector(`[data-supervision-focus="${CSS.escape(state.supervisionFocusId)}"]`)?.focus({ preventScroll: true }));
        return;
      }
      const graph = event.target.closest("[data-graph-focus]");
      if (graph) {
        state.graphFocusId = graph.dataset.graphFocus;
        renderSessions("focus");
        requestAnimationFrame(() => $("#liveSection")?.scrollIntoView({ behavior: "smooth", block: "start" }));
        return;
      }
      const open = event.target.closest("[data-open-session]");
      if (open) {
        const session = (state.snapshot?.sessions || []).find(item => item.id === open.dataset.openSession);
        return session?.parentId ? openSubagentConversation(session.id) : openDrawer(open.dataset.openSession);
      }
      const bridge = event.target.closest("[data-agent-bridge-copy]");
      if (bridge) return copyBridgeCommand(bridge.dataset.agentBridgeCopy);
      const terminal = event.target.closest("[data-agent-terminal-open]");
      if (terminal) return openAgentTerminal(terminal.dataset.agentTerminalOpen);
      const managed = event.target.closest("[data-managed-run-action]");
      if (managed) return controlManagedRun(managed.dataset.managementSessionId, managed.dataset.managedRunAction);
      const reassign = event.target.closest("[data-reassign-session]");
      if (reassign) return prepareReassignment(reassign.dataset.reassignSession);
      const filter = event.target.closest("[data-management-filter]");
      if (!filter) return;
      selectView("waiting", { focusMain: true, managementFilter: filter.dataset.managementFilter });
      announceManagementFilter(filter.dataset.managementFilter);
    });
    $("#operationsOverview").addEventListener("input", (event) => {
      const input = event.target.closest("[data-agent-command-draft]");
      if (input) state.agentCommandDrafts.set(input.dataset.agentCommandDraft, input.value);
    });
    $("#operationsOverview").addEventListener("change", (event) => {
      const picker = event.target.closest("[data-agent-command-target]");
      if (!picker) return;
      if (picker.value) state.agentCommandTargets.set(picker.dataset.agentCommandTarget, picker.value);
      else state.agentCommandTargets.delete(picker.dataset.agentCommandTarget);
      const enabled = Boolean(picker.value);
      picker.closest("form")?.querySelectorAll("[data-agent-terminal-open], button[type='submit']").forEach(button => { button.disabled = !enabled; });
    });
    $("#operationsOverview").addEventListener("keydown", (event) => {
      const input = event.target.closest("[data-agent-command-draft]");
      if (!input || event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      input.closest("form")?.requestSubmit();
    });
    $("#operationsOverview").addEventListener("submit", (event) => {
      const form = event.target.closest("[data-agent-command-form]");
      if (!form) return;
      event.preventDefault();
      dispatchAgentCommand(form.dataset.agentCommandForm, form);
    });
    $("#attentionInbox").addEventListener("click", async (event) => {
      const route = event.target.closest("[data-agent-command-route]");
      if (route) {
        state.agentCommandRoutes.set(route.dataset.agentCommandSession, route.dataset.agentCommandRoute);
        renderSessions("route");
        return;
      }
      const filter = event.target.closest("[data-management-inbox-filter]");
      if (filter) {
        state.managementFilter = filter.dataset.managementInboxFilter;
        renderSessions("filter");
        announceManagementFilter(state.managementFilter);
        requestAnimationFrame(() => $("#attentionInbox")?.querySelector(`[data-management-inbox-filter="${CSS.escape(state.managementFilter)}"]`)?.focus({ preventScroll: true }));
        return;
      }
      const draft = event.target.closest("[data-attention-draft]");
      if (draft) {
        const sessionId = draft.dataset.attentionSessionId;
        const value = draft.dataset.attentionDraft || "";
        state.agentCommandDrafts.set(sessionId, value);
        const input = $("#attentionInbox")?.querySelector(`[data-agent-command-draft="${CSS.escape(sessionId)}"]`);
        if (input) {
          input.value = value;
          input.focus({ preventScroll: true });
          input.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }
      const open = event.target.closest("[data-open-session]");
      if (open) {
        const session = (state.snapshot?.sessions || []).find(item => item.id === open.dataset.openSession);
        return session?.parentId ? openSubagentConversation(session.id) : openDrawer(open.dataset.openSession);
      }
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
      picker.closest("form")?.querySelectorAll("[data-agent-terminal-open], button[type='submit']").forEach(button => { button.disabled = !picker.value; });
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
    bindSortableSessionList($("#sessionGrid"), "[data-session-id][data-session-sortable]");
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
      if (sessionDragJustEnded) return;
      const card = event.target.closest("[data-session-id]");
      if (card) openDrawer(card.dataset.sessionId);
    });
    $("#sessionGrid").addEventListener("keydown", (event) => {
      if (event.target.closest("button, input, select, textarea, [contenteditable='true']")) return;
      const card = event.target.closest("[data-session-id]");
      if (card && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        openDrawer(card.dataset.sessionId);
      }
    });
  }

  function bindLiveAgentEvents() {
    bindSortableSessionList($("#liveSessionGrid"), "[data-control-session][data-session-sortable]");
    bindSortableProjectGroups($("#liveSessionGrid"));
    $("#liveSessionGrid").addEventListener("click", async (event) => {
      if (Date.now() - projectDragEndedAt < 250 && event.target.closest(".control-project-header")) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (sessionDragJustEnded) return;
      const archive = event.target.closest("[data-session-archive]");
      if (archive) {
        event.stopPropagation();
        if (archiveSession(archive.dataset.sessionArchive)) {
          if (state.graphFocusId === archive.dataset.sessionArchive) state.graphFocusId = null;
          renderSessions("archive");
          announce(window.LoadToAgentI18n.t("control.moved_to_history"));
        }
        return;
      }
      const route = event.target.closest("[data-agent-command-route]");
      if (route) {
        event.stopPropagation();
        state.agentCommandRoutes.set(route.dataset.agentCommandSession, route.dataset.agentCommandRoute);
        renderSessions("route");
        requestAnimationFrame(() => $("#liveSessionGrid")?.querySelector(`[data-agent-command-session="${CSS.escape(route.dataset.agentCommandSession)}"][data-agent-command-route="${CSS.escape(route.dataset.agentCommandRoute)}"]`)?.focus({ preventScroll: true }));
        return;
      }
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
      const execution = event.target.closest("[data-open-execution-id]");
      if (execution) {
        event.stopPropagation();
        openExecutionActivity(execution.dataset.openExecutionOwner, execution.dataset.openExecutionId);
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
        form.querySelectorAll("[data-agent-terminal-open], button[type='submit']").forEach((button) => {
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
