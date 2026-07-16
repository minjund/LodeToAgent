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
    graphPath,
    connectedGraphSessions,
    sortGraphNodes,
    runtimeAgentSummary,
    runtimeSeparatedOverview,
    focusedGraph,
    scheduleAgentWorkflowConnections,
  } = context;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);

  function renderAgentMap(sessions, motionKind = "refresh") {
    const model = connectedGraphSessions(sessions);
    const focus =
      state.graphFocusId && model.byId.get(state.graphFocusId) && model.included.has(state.graphFocusId) ? model.byId.get(state.graphFocusId) : null;
    if (state.graphFocusId && !focus) state.graphFocusId = null;
    const roots = sortGraphNodes(model.nodes.filter((session) => !session.parentId || !model.included.has(session.parentId)));
    if (!model.nodes.length) {
      $("#liveSessionGrid").innerHTML = "";
      $("#graphBreadcrumbs").innerHTML = "";
      $("#graphResetBtn").classList.add("hidden");
      return 0;
    }

    if (focus) {
      $("#liveSessionGrid").innerHTML = focusedGraph(focus, model, motionKind);
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
    } else {
      const runtime = runtimeAgentSummary(model);
      $("#liveSessionGrid").innerHTML = `<details class="runtime-disclosure" open>
        <summary>
        <span>
        <b>${esc(t("graph.ai_working_count", { count: runtime.activeCount }))}</b>
        <small>${esc(t("graph.runtime_count_explanation", { sessions: runtime.activeCount, helpers: runtime.activeHelperCount }))}</small>
        </span>
        <em>${esc(t("graph.view_detailed_flow"))} <i aria-hidden="true">↓</i>
        </em>
        </summary>${runtimeSeparatedOverview(roots, model)}</details>`;
      $("#graphBreadcrumbs").innerHTML =
        `<span class="map-hint">
          ${esc(t("graph.main_sessions"))} <b>${runtime.rootCount}</b> ·
          ${esc(t("graph.active_helper_ai"))} <b>${runtime.activeHelperCount}</b> ·
          ${esc(t("graph.helper_ai_history"))} <b>${runtime.helperRecordCount}</b>
        </span>`;
      $("#graphResetBtn").classList.add("hidden");
      return runtime.activeCount;
    }
    return model.nodes.filter(isLiveSession).length;
  }

  return { renderAgentMap };
};
