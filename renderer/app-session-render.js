"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createSessionRenderer = function createSessionRenderer(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $,
    esc,
    state,
    STATUS,
    VIEW_TITLES,
    captureMotionLayout,
    playMotionLayout,
    animateVisibleSections,
    renderGuide,
    syncViewChrome,
    readablePreview,
    compact,
    fullNumber,
    timeAgo,
    providerInfo,
    providerStyle,
    statusClass,
    currentActivity,
    isLiveSession,
    isControlRoomSession = isLiveSession,
    latestWorkCopy,
    statusIcon,
    renderProviderRail,
    isProjectlessSession,
    sessionOriginPath,
    sessionWorkspaceLabel,
    renderWorkspaces,
    renderGlobalStats,
    renderUpdateSettings,
    renderProviderOverview,
    renderProviderFilter,
    renderRuntimeOverview,
    renderProviderVisibilitySettings = () => {},
    visibleSnapshot = () => state.snapshot,
    filteredSessions,
    graphFilteredSessions,
    executionModeBadge,
    renderAgentMap,
    renderTmuxMap,
    renderAttentionInbox,
    renderOperationsOverview,
    progressHtml,
    healthHtml,
  } = context;

  function recentConversation(session) {
    const messages = (session.messages || []).filter((message) => message && message.text && message.role !== "system");
    const user = [...messages].reverse().find((message) => message.role === "user");
    const assistant = [...messages].reverse().find((message) => message.role === "assistant");
    const tool = [...messages].reverse().find((message) => message.role === "tool");
    const rows = [];
    if (user) rows.push({ label: t("session.me"), text: readablePreview(user.text, 140).text, tone: "user" });
    if (assistant) rows.push({ label: providerInfo(session.provider).label, text: readablePreview(assistant.text, 140).text, tone: "assistant" });
    else if (tool) rows.push({ label: tool.title || t("session.tool"), text: readablePreview(tool.text, 140).text, tone: "tool" });
    if (!rows.length) rows.push({ label: t("session.status"), text: window.LoadToAgentI18n.observedText(session.statusDetail || t("session.waiting_for_event")), tone: "system" });
    return rows.slice(-2);
  }

  function sessionCard(session, opts = {}) {
    const provider = providerInfo(session.provider);
    const activity = currentActivity(session);
    const conversation = recentConversation(session);
    const titlePreview = readablePreview(session.title, 96);
    const latest = conversation[conversation.length - 1];
    const activityCopy = latest?.text || latestWorkCopy(session) || window.LoadToAgentI18n.observedText(session.statusDetail) || t("session.waiting_for_new_event");
    const activityPreview = readablePreview(activityCopy, 138);
    const accessibleId = `session-${String(session.id || "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const originPath = sessionOriginPath(session);
    const originLabel = sessionWorkspaceLabel(session);
    return `<article class="session-card session-record ${opts.live ? "live-card" : ""} ${statusClass(session.status)} ${session.parentId ? "subagent" : ""}"
      data-session-id="${esc(session.id)}"
      data-session-sortable="${esc(session.id)}"
      data-motion-key="session:${esc(session.id)}"
      data-motion-value="${esc(session.updatedAt || "")}:${esc(session.status || "")}"
      style="${providerStyle(session.provider)}"
      role="button" tabindex="0" draggable="true" aria-grabbed="false"
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      aria-labelledby="${accessibleId}-title" aria-describedby="${accessibleId}-summary sessionReorderHelp">
      <div class="card-head">
        <span class="provider-mark">${esc(provider.mark)}</span>
        <div class="card-head-main"><div class="card-provider-line"><b>${esc(provider.label)}</b><span>${esc(session.model || t("session.model_unknown"))}</span></div></div>
        <span class="status-pill ${statusClass(session.status)}">${esc(STATUS[session.status] || session.status)}</span>
      </div>
      <h3 id="${accessibleId}-title" class="card-title" title="${esc(titlePreview.full)}">${esc(titlePreview.text)}</h3>
      <div class="card-subtitle"><span class="origin-project" title="${esc(isProjectlessSession(session) ? window.LoadToAgentI18n.t("ui.session_not_linked_to_a_specific_project") : originPath)}"
          aria-label="${esc(t("project.origin_named", { name: originLabel }))}">
          <small>${esc(t("project.origin"))}</small><b>${esc(originLabel)}</b></span></div>
      <div id="${accessibleId}-summary" class="now-strip">
        <span class="now-strip-icon">${statusIcon(activity.type)}</span>
        <div><b>${esc(latest?.label || activity.title)}</b><span title="${esc(activityPreview.full)}">${esc(activityPreview.text)}</span></div>
      </div>
      <footer class="card-footer">
        <span>${esc(timeAgo(session.updatedAt))}</span>
        <span class="session-drag-handle" aria-hidden="true" title="${esc(t("session.reorder_hint"))}"></span>
        <strong>${esc(t("graph.view_conversation"))}<i aria-hidden="true">→</i></strong>
      </footer>
    </article>`;
  }

  function renderSessionsContent(motionKind = "refresh", deferMotion = false) {
    const previousLayout = deferMotion ? null : captureMotionLayout();
    syncViewChrome();
    renderGuide();
    const tmuxView = state.view === "tmux";
    const terminalView = state.view === "terminal";
    const settingsView = state.view === "settings";
    const runtimeView = state.view === "runtime";
    const attentionView = state.view === "waiting";
    const homeView = state.view === "all";
    const operationsView = homeView;
    const focusedToolView = tmuxView || terminalView || settingsView || runtimeView;
    $("#terminalSection").classList.toggle("hidden", !terminalView);
    $("#tmuxSection").classList.toggle("hidden", !tmuxView);
    $("#settingsSection").classList.toggle("hidden", !settingsView);
    $("#globalStats").classList.toggle("hidden", focusedToolView || homeView || state.view === "active" || attentionView);
    $("#providerOverview").classList.add("hidden");
    $("#sessionSection").classList.toggle("hidden", focusedToolView || state.view === "active" || attentionView);
    $("#operationsOverview").classList.toggle("hidden", !operationsView);
    $("#attentionInbox").classList.toggle("hidden", !attentionView);
    if (runtimeView) renderRuntimeOverview();
    $("#automationOverview").classList.toggle("hidden", !runtimeView);
    const guideVisible = state.view === "all" && state.guideExpanded && !state.graphFocusId;
    $("#beginnerGuide").classList.toggle("hidden", !guideVisible);
    $("#guideBtn").setAttribute("aria-expanded", guideVisible ? "true" : "false");
    renderUpdateSettings();
    if (runtimeView) {
      $("#liveSection").classList.add("hidden");
      if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.deactivate();
      if (!deferMotion) playMotionLayout(previousLayout, motionKind);
      if (motionKind === "view") animateVisibleSections();
      return;
    }
    if (settingsView) {
      $("#liveSection").classList.add("hidden");
      renderProviderVisibilitySettings();
      if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.deactivate();
      if (!deferMotion) playMotionLayout(previousLayout, motionKind);
      if (motionKind === "view") animateVisibleSections();
      return;
    }
    if (terminalView) {
      $("#liveSection").classList.add("hidden");
      if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.activate(visibleSnapshot(), state.workspaces, "general");
      if (!deferMotion) playMotionLayout(previousLayout, motionKind);
      if (motionKind === "view") animateVisibleSections();
      return;
    }
    if (tmuxView) {
      $("#liveSection").classList.add("hidden");
      renderTmuxMap();
      if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.activate(visibleSnapshot(), state.workspaces, "tmux");
      if (!deferMotion) playMotionLayout(previousLayout, motionKind);
      if (motionKind === "view") animateVisibleSections();
      return;
    }
    if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.deactivate();
    const sessions = filteredSessions();
    if (operationsView) renderOperationsOverview();
    const attentionCount = attentionView ? renderAttentionInbox() : 0;
    const showMap = ["all", "active"].includes(state.view);
    const graphLiveCount = showMap ? renderAgentMap(graphFilteredSessions(), motionKind) : 0;
    const regular = state.view === "all" ? sessions.filter((session) => !isControlRoomSession(session)) : state.view === "active" ? [] : sessions;
    const visible = regular.slice(0, state.visibleLimit);
    const resultCount = attentionView
      ? attentionCount
      : state.view === "active"
        ? graphLiveCount
        : regular.length;
    $("#sessionResultSummary").textContent = window.LoadToAgentI18n.t("quality.results_summary", { count: resultCount });
    const activeEmpty = state.view === "active" && graphLiveCount === 0;
    $("#activeEmptyState").classList.toggle("hidden", !activeEmpty);
    $("#liveSection").classList.toggle("hidden", attentionView || (graphLiveCount === 0 && state.view !== "active"));
    $("#viewTitle").textContent = homeView ? t("control.other_sessions") : VIEW_TITLES[state.view] || window.LoadToAgentI18n.t("ui.recent_conversations_and_tasks");
    $("#sessionGrid").innerHTML = visible.map((session) => sessionCard(session)).join("");
    $("#sessionGrid").classList.toggle("hidden", visible.length === 0);
    $("#loadMoreBtn").classList.toggle("hidden", regular.length <= state.visibleLimit);
    $("#loadMoreBtn").textContent = window.LoadToAgentI18n.t("common.remaining", { count: regular.length - state.visibleLimit });
    $("#emptyState").classList.toggle("hidden", attentionView || graphLiveCount + regular.length !== 0);
    const hasConditions = Boolean(state.search || state.providerFilters.size || state.workspace !== "all" || state.sort !== "recent");
    $("#emptyClearFiltersBtn").classList.toggle("hidden", resultCount !== 0 || !hasConditions);
    if (graphLiveCount + regular.length === 0) {
      const emptyCopy = state.search
        ? [window.LoadToAgentI18n.t("ui.no_search_results"), window.LoadToAgentI18n.t("ui.clear_the_search_or_change_the_ai_and_workspace_filters")]
        : state.view === "active"
          ? [window.LoadToAgentI18n.t("ui.no_tasks_are_currently_active"), window.LoadToAgentI18n.t("ui.new_tasks_will_show_their_progress_here_immediately")]
          : state.view === "waiting"
            ? [window.LoadToAgentI18n.t("ui.all_caught_up"), window.LoadToAgentI18n.t("ui.no_tasks_are_waiting_for_your_response_or_choice")]
            : [window.LoadToAgentI18n.t("ui.no_tasks_to_show_yet"), window.LoadToAgentI18n.t("ui.check_ai_readiness_then_start_your_first_task")];
      $("#emptyState h3").textContent = emptyCopy[0];
      $("#emptyState p").textContent = emptyCopy[1];
    }
    if (!deferMotion) playMotionLayout(previousLayout, motionKind);
    if (motionKind === "view") animateVisibleSections();
  }

  function renderSessions(motionKind = "refresh", deferMotion = false) {
    const restoreScroll = window.LoadToAgentRendererUtils.preserveScrollPositions([".main-stage", ".sidebar"]);
    context.rememberDisclosureStates?.(document);
    try {
      return renderSessionsContent(motionKind, deferMotion);
    } finally {
      context.restoreDisclosureStates?.(document);
      restoreScroll();
    }
  }

  function render(motionKind = "refresh") {
    const restoreScroll = window.LoadToAgentRendererUtils.preserveScrollPositions([".main-stage", ".sidebar"]);
    context.rememberDisclosureStates?.(document);
    try {
      const previousLayout = captureMotionLayout();
      renderProviderRail();
      renderWorkspaces();
      renderGlobalStats();
      renderProviderOverview();
      renderProviderFilter();
      renderProviderVisibilitySettings();
      renderSessions(motionKind, true);
      if (state.selectedId && $("#detailDrawer").classList.contains("open")) context.renderDrawer();
      playMotionLayout(previousLayout, motionKind);
      if (motionKind === "view") animateVisibleSections();
    } finally {
      context.restoreDisclosureStates?.(document);
      restoreScroll();
    }
  }

  return {
    recentConversation,
    sessionCard,
    renderSessions,
    render,
  };
};
