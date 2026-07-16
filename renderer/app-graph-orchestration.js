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
    liveTmuxEntries,
    runtimeAgentSummary,
    runtimeSeparatedOverview,
    focusedGraph,
    scheduleAgentWorkflowConnections,
  } = context;

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
      $("#graphBreadcrumbs").innerHTML = `<button type="button" data-graph-reset>작업 목록</button>${path
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
      const tmuxEntries = liveTmuxEntries();
      const runtime = runtimeAgentSummary(model, tmuxEntries);
      $("#liveSessionGrid").innerHTML = `<details class="runtime-disclosure" open>
        <summary>
        <span>
        <b>${runtime.activeCount}개 AI가 작업 중입니다</b>
        <small>일반 실행 AI ${runtime.standardCount}개와 TMUX AI ${runtime.tmuxCount}개를 합산했습니다. 작업 중 도움 AI ${runtime.activeHelperCount}개는 이 수에 포함됩니다.</small>
        </span>
        <em>상세 흐름 보기 <i aria-hidden="true">↓</i>
        </em>
        </summary>${runtimeSeparatedOverview(roots, model)}</details>`;
      $("#graphBreadcrumbs").innerHTML =
        `<span class="map-hint">
          일반 실행 AI <b>${runtime.standardCount}</b>개 ·
          TMUX AI <b>${runtime.tmuxCount}</b>개 ·
          작업 중 도움 AI <b>${runtime.activeHelperCount}</b>개 ·
          도움 AI 기록 <b>${runtime.helperRecordCount}</b>개
        </span>`;
      $("#graphResetBtn").classList.add("hidden");
      return runtime.activeCount;
    }
    return model.nodes.filter(isLiveSession).length + liveTmuxEntries().filter((entry) => !entry.agent.linkedSessionId).length;
  }

  return { renderAgentMap };
};
