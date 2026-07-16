"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createGraphModel = function createGraphModel(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $,
    esc,
    state,
    compact,
    isLiveSession,
  } = context;

  function graphPath(session, byId) {
    const path = [];
    const seen = new Set();
    let current = session;
    while (current && !seen.has(current.id)) {
      path.unshift(current);
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : null;
    }
    return path;
  }

  function connectedGraphSessions(sessions, focusId = state.graphFocusId) {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const included = new Set(sessions.filter(isLiveSession).map((session) => session.id));
    const includeAncestors = (session) => {
      let current = session;
      const seen = new Set();
      while (current && !seen.has(current.id)) {
        included.add(current.id);
        seen.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : null;
      }
    };
    sessions.filter(isLiveSession).forEach(includeAncestors);
    const includeDescendants = (session) => {
      const queue = [...((session && session.childIds) || [])];
      const seen = new Set();
      while (queue.length) {
        const id = queue.shift();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        included.add(id);
        const child = byId.get(id);
        if (child) queue.push(...(child.childIds || []));
      }
    };
    const requestedFocus = focusId && byId.get(focusId);
    if (requestedFocus) {
      includeAncestors(requestedFocus);
      includeDescendants(requestedFocus);
    }
    for (const id of [...included]) {
      const session = byId.get(id);
      for (const childId of (session && session.childIds) || []) included.add(childId);
    }
    return { byId, included, nodes: sessions.filter((session) => included.has(session.id)) };
  }

  function sortGraphNodes(sessions) {
    return [...sessions].sort((a, b) => {
      const statusA = isLiveSession(a) ? 3 : a.status === "waiting" ? 2 : a.status === "failed" ? 1 : 0;
      const statusB = isLiveSession(b) ? 3 : b.status === "waiting" ? 2 : b.status === "failed" ? 1 : 0;
      return statusB - statusA || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
    });
  }

  function graphChildren(session, model) {
    return sortGraphNodes((session.childIds || []).map((id) => model.byId.get(id)).filter(Boolean));
  }

  function agentExecutionMode(session) {
    const presence = Array.isArray(session && session.runtimePresence) ? session.runtimePresence : [];
    const tmux = presence.find((item) => item.kind === "tmux");
    if (tmux)
      return {
        kind: "tmux",
        label: t("graph.tmux_used"),
        detail: [tmux.distro, tmux.sessionName, tmux.paneNativeId || tmux.paneId].filter(Boolean).join(" · ") || t("graph.running_in_split_terminal"),
      };
    return { kind: "standard", label: t("graph.standard_run"), detail: t("graph.tmux_not_used") };
  }

  function executionModeBadge(session, compact = false) {
    const mode = agentExecutionMode(session);
    return `<span class="execution-mode-badge ${mode.kind}" title="${esc(mode.detail)}">
      <i>${mode.kind === "tmux" ? "▦" : "›_"}</i>
      <b>${esc(mode.label)}</b>${compact ? "" : `<small>${esc(mode.detail)}</small>`}</span>`;
  }

  function graphDescendantCount(session, model) {
    const queue = [...(session.childIds || [])];
    const seen = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (!id || seen.has(id) || !model.byId.has(id)) continue;
      seen.add(id);
      queue.push(...(model.byId.get(id).childIds || []));
    }
    return seen.size;
  }

  function runtimeAgentSummary(model) {
    const liveNodes = model.nodes.filter(isLiveSession);
    return {
      activeCount: liveNodes.length,
      rootCount: liveNodes.filter((session) => !session.parentId).length,
      activeHelperCount: liveNodes.filter((session) => session.parentId).length,
      helperRecordCount: model.nodes.filter((session) => session.parentId).length,
    };
  }

  return { graphPath, connectedGraphSessions, sortGraphNodes, graphChildren, agentExecutionMode, executionModeBadge, graphDescendantCount, runtimeAgentSummary };
};
