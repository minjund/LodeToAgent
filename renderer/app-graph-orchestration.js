"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createGraphOrchestration = function createGraphOrchestration(context = {}) {
  const {
    $,
    esc,
    state,
    readablePreview,
    agentRoleLabel,
    isLiveSession,
    isControlRoomSession = isLiveSession,
    graphPath,
    connectedGraphSessions,
    sortGraphNodes,
    stableSessionSort = sessions => [...sessions],
    runtimeAgentSummary,
    liveTmuxEntries,
    filteredLiveTmuxEntries,
    runtimeSeparatedOverview,
    focusedGraph,
    scheduleAgentWorkflowConnections,
    rememberDisclosureStates = () => {},
    restoreDisclosureStates = () => {},
  } = context;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);

  function syncControlRoomDisclosureButtons() {
    const groups = Array.from(document.querySelectorAll("#liveSessionGrid .control-room-project-group"));
    const canExpand = groups.some(group => !group.open);
    const canCollapse = groups.some(group => group.open);
    if ($("#controlRoomExpandAll")) $("#controlRoomExpandAll").disabled = !canExpand;
    if ($("#controlRoomCollapseAll")) $("#controlRoomCollapseAll").disabled = !canCollapse;
  }

  function syncElementAttributes(current, next) {
    const preserveRuntimeConnection = current.hasAttribute("data-inline-agent-terminal");
    for (const name of current.getAttributeNames()) {
      if (preserveRuntimeConnection && name === "data-connection") continue;
      if (!next.hasAttribute(name)) current.removeAttribute(name);
    }
    for (const name of next.getAttributeNames()) {
      const value = next.getAttribute(name);
      if (current.getAttribute(name) !== value) current.setAttribute(name, value);
    }
  }

  function elementPath(node, root) {
    const path = [];
    for (let current = node; current && current !== root; current = current.parentElement) {
      path.unshift(current);
    }
    return path;
  }

  function replaceSiblingsPreserving(parent, preserved, nextParent, nextPreserved) {
    const nextChildren = [...nextParent.childNodes];
    const preservedIndex = nextChildren.indexOf(nextPreserved);
    if (preservedIndex < 0) return false;
    for (const child of [...parent.childNodes]) {
      if (child !== preserved) child.remove();
    }
    for (const child of nextChildren.slice(0, preservedIndex)) {
      parent.insertBefore(child.cloneNode(true), preserved);
    }
    for (const child of nextChildren.slice(preservedIndex + 1)) {
      parent.appendChild(child.cloneNode(true));
    }
    return true;
  }

  function reconcileGraphPreservingInline(liveSessionGrid, nextHtml, inlineShell) {
    if (!inlineShell?.isConnected || !liveSessionGrid.contains(inlineShell)) return false;
    const staging = document.createElement("div");
    staging.innerHTML = nextHtml;
    const nextShell = [...staging.querySelectorAll("[data-inline-agent-terminal]")]
      .find(node => node.dataset.inlineAgentTerminal === inlineShell.dataset.inlineAgentTerminal);
    if (!nextShell) return false;
    const currentPath = elementPath(inlineShell, liveSessionGrid);
    const nextPath = elementPath(nextShell, staging);
    if (!currentPath.length || currentPath.length !== nextPath.length) return false;
    for (let index = 0; index < currentPath.length; index += 1) {
      const expectedCurrentParent = index === 0 ? liveSessionGrid : currentPath[index - 1];
      const expectedNextParent = index === 0 ? staging : nextPath[index - 1];
      if (currentPath[index].parentElement !== expectedCurrentParent
        || nextPath[index].parentElement !== expectedNextParent
        || currentPath[index].localName !== nextPath[index].localName) return false;
    }
    let currentParent = liveSessionGrid;
    let nextParent = staging;
    for (let index = 0; index < currentPath.length; index += 1) {
      const current = currentPath[index];
      const next = nextPath[index];
      if (!replaceSiblingsPreserving(currentParent, current, nextParent, next)) return false;
      syncElementAttributes(current, next);
      currentParent = current;
      nextParent = next;
    }
    return inlineShell.isConnected && liveSessionGrid.contains(inlineShell);
  }

  function applyGraphHtml(liveSessionGrid, nextHtml, options = {}) {
    if (options.preserveFocusedComposer) return false;
    if (!options.preserveInlineTerminal) {
      liveSessionGrid.innerHTML = nextHtml;
      return true;
    }
    if (reconcileGraphPreservingInline(liveSessionGrid, nextHtml, options.inlineShell)) return true;

    // A topology change can move the selected task to a structurally different
    // branch (for example, top-level -> parent-controlled). A failed keyed
    // reconcile must not leave the old task card and writable PTY on screen.
    liveSessionGrid.innerHTML = nextHtml;
    const replacement = [...liveSessionGrid.querySelectorAll("[data-inline-agent-terminal]")]
      .find(node => node.dataset.inlineAgentTerminal === state.inlineTerminalSessionId);
    if (!replacement) {
      state.inlineTerminalSessionId = null;
      window.LoadToAgentTerminal?.unmountEmbedded?.();
    }
    return false;
  }

  function renderAgentMap(sessions, motionKind = "refresh") {
    const liveSessionGrid = $("#liveSessionGrid");
    const preserveFocusedComposer = document.activeElement?.matches?.("[data-agent-command-draft]")
      && liveSessionGrid.contains(document.activeElement);
    rememberDisclosureStates(liveSessionGrid);
    const model = connectedGraphSessions(sessions);
    const tmuxEntries = filteredLiveTmuxEntries(model, liveTmuxEntries(state.snapshot && state.snapshot.tmux));
    const focus =
      state.graphFocusId && model.byId.get(state.graphFocusId) && model.included.has(state.graphFocusId) ? model.byId.get(state.graphFocusId) : null;
    if (state.graphFocusId && !focus) state.graphFocusId = null;
    const inlineSession = state.inlineTerminalSessionId && model.byId.get(state.inlineTerminalSessionId) && model.included.has(state.inlineTerminalSessionId)
      ? model.byId.get(state.inlineTerminalSessionId)
      : null;
    const mountedInlineShell = liveSessionGrid.querySelector("[data-inline-agent-terminal]");
    // Monitor snapshots arrive while users are typing directly into xterm.
    // Replacing the graph subtree would detach xterm's helper textarea, abort
    // an active IME composition, drop the current keystroke and force a
    // hide/reparent/fit cycle. Keep the complete inline PTY subtree alive for
    // passive refreshes; explicit focus/filter/view actions still render the
    // requested graph immediately.
    const preserveInlineTerminal = motionKind === "refresh"
      && inlineSession
      && (!focus || focus.id === inlineSession.id)
      && mountedInlineShell?.dataset.inlineAgentTerminal === inlineSession.id;
    if (state.inlineTerminalSessionId && (!inlineSession || (focus && state.inlineTerminalSessionId !== focus.id))) {
      state.inlineTerminalSessionId = null;
      window.LoadToAgentTerminal?.unmountEmbedded?.();
    }
    const rootSessions = model.nodes.filter((session) => !session.parentId || !model.included.has(session.parentId));
    const roots = state.controlRoomSort === "tokens"
      ? [...rootSessions].sort((a, b) => Number((b.usage && b.usage.total) || 0) - Number((a.usage && a.usage.total) || 0))
      : state.controlRoomSort === "context"
        ? [...rootSessions].sort((a, b) => Number((b.context && b.context.percent) || 0) - Number((a.context && a.context.percent) || 0))
        : stableSessionSort(rootSessions);
    if (!model.nodes.length && !tmuxEntries.length) {
      if (!preserveFocusedComposer) liveSessionGrid.innerHTML = "";
      $("#graphBreadcrumbs").innerHTML = "";
      $("#graphResetBtn").classList.add("hidden");
      $("#agentMapToolbar")?.classList.add("hidden");
      $("#controlRoomProjectToolbar")?.classList.remove("hidden");
      $("#controlRoomListToolbar")?.classList.remove("hidden");
      syncControlRoomDisclosureButtons();
      return 0;
    }

    if (focus) {
      $("#agentMapToolbar")?.classList.remove("hidden");
      $("#controlRoomProjectToolbar")?.classList.add("hidden");
      $("#controlRoomListToolbar")?.classList.add("hidden");
      const nextGraphHtml = focusedGraph(focus, model, motionKind);
      applyGraphHtml(liveSessionGrid, nextGraphHtml, {
        preserveFocusedComposer,
        preserveInlineTerminal,
        inlineShell: mountedInlineShell,
      });
      const path = graphPath(focus, model.byId);
      $("#graphBreadcrumbs").innerHTML = `<button type="button" data-graph-reset>${esc(t("graph.task_list"))}</button>${path
        .map((item) => {
          const label = item.parentId ? item.agentName || agentRoleLabel(item.agentRole) : item.title;
          const preview = readablePreview(label, item.parentId ? 42 : 72);
          return `<i>›</i>
          <button type="button" data-graph-focus="${esc(item.id)}"
            class="${item.id === focus.id ? "current" : ""}"
            title="${esc(preview.full)}">${esc(preview.text)}</button>`;
        })
        .join("")}`;
      $("#graphResetBtn").classList.remove("hidden");
      scheduleAgentWorkflowConnections();
      requestAnimationFrame(() => window.LoadToAgentInlineTerminal?.sync?.());
    } else {
      const runtime = runtimeAgentSummary(model, tmuxEntries);
      const nextGraphHtml = runtimeSeparatedOverview(roots, model, roots, tmuxEntries);
      applyGraphHtml(liveSessionGrid, nextGraphHtml, {
        preserveFocusedComposer,
        preserveInlineTerminal,
        inlineShell: mountedInlineShell,
      });
      restoreDisclosureStates(liveSessionGrid);
      $("#graphBreadcrumbs").innerHTML = "";
      $("#agentMapToolbar")?.classList.add("hidden");
      $("#controlRoomProjectToolbar")?.classList.remove("hidden");
      $("#controlRoomListToolbar")?.classList.remove("hidden");
      syncControlRoomDisclosureButtons();
      $("#graphResetBtn").classList.add("hidden");
      requestAnimationFrame(() => window.LoadToAgentInlineTerminal?.sync?.());
      return runtime.activeCount + tmuxEntries.length;
    }
    return model.nodes.filter(isControlRoomSession).length;
  }

  return { renderAgentMap, syncControlRoomDisclosureButtons };
};
