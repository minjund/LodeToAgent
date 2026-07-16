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
    latestWorkCopy,
    statusIcon,
    renderProviderRail,
    isProjectlessSession,
    sessionWorkspaceLabel,
    renderWorkspaces,
    renderGlobalStats,
    renderUpdateSettings,
    renderProviderOverview,
    renderProviderFilter,
    renderProviderVisibilitySettings = () => {},
    visibleSnapshot = () => state.snapshot,
    filteredSessions,
    graphFilteredSessions,
    executionModeBadge,
    renderAgentMap,
    renderTmuxMap,
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
    const usage = session.usage || {};
    const context = session.context || {};
    const activity = currentActivity(session);
    const running = session.status === "running" || session.status === "starting";
    const children = session.childIds || [];
    const model = session.model || t("session.model_unknown");
    const contextPercent = Math.max(0, Math.min(100, Number(context.percent || 0)));
    const remaining = context.window ? Math.max(0, Number(context.window) - Number(context.used || 0)) : 0;
    const gaugeTone = contextPercent >= 90 ? "critical" : contextPercent >= 75 ? "warning" : "safe";
    const conversation = recentConversation(session);
    const runtime = session.runtimePresence || [];
    const titlePreview = readablePreview(session.title, 96);
    const activityCopy = latestWorkCopy(session) || window.LoadToAgentI18n.observedText(session.statusDetail) || t("session.waiting_for_new_event");
    const activityPreview = readablePreview(activityCopy, 116);
    const accessibleId = `session-${String(session.id || "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    return `<article class="session-card ${opts.live ? "live-card" : ""} ${statusClass(session.status)} ${session.parentId ? "subagent" : ""}"
      data-session-id="${esc(session.id)}"
      data-motion-key="session:${esc(session.id)}"
      data-motion-value="${esc(session.updatedAt || "")}:${usage.total || 0}:${esc(session.status || "")}"
      style="${providerStyle(session.provider)}"
      role="button" tabindex="0"
      aria-labelledby="${accessibleId}-title" aria-describedby="${accessibleId}-summary">
      <div class="card-head">
        <span class="provider-mark">${esc(provider.mark)}</span>
        <div class="card-head-main"><div class="card-provider-line"><b>${esc(provider.label)}</b><span>${esc(provider.company)}</span></div></div>
        ${executionModeBadge(session, true)}
        <span class="status-pill ${statusClass(session.status)}">${esc(STATUS[session.status] || session.status)}</span>
      </div>
      <h3 id="${accessibleId}-title" class="card-title" title="${esc(titlePreview.full)}">${esc(titlePreview.text)}</h3>
      <div class="card-subtitle">
        <span>${esc(model)}</span>
        <i>
        </i>
        <span title="${esc(isProjectlessSession(session) ? window.LoadToAgentI18n.t("ui.session_not_linked_to_a_specific_project") : session.cwd)}">
          ${esc(sessionWorkspaceLabel(session))}
        </span>${
          session.agentName
            ? `<i>
        </i>
        <span>${esc(session.agentName)}</span>`
            : ""
        }</div>
      <div id="${accessibleId}-summary" class="now-strip ${running ? "is-live" : ""}">
        <span class="now-strip-icon">${statusIcon(activity.type)}</span>
        <div><b>${running ? `${esc(t("session.now"))}: ` : ""}${esc(activity.title)}</b><span title="${esc(activityPreview.full)}">${esc(activityPreview.text)}</span></div>
        ${running ? '<span class="activity-wave"><i></i><i></i><i></i><i></i><i></i></span>' : ""}
      </div>
      ${
        runtime.length
          ? `<div class="runtime-strip">
        <span class="runtime-pulse">
        </span>
        <b>${esc(t("session.running_programs", { count: runtime.length }))}</b>
        <span>${esc(runtime.map((item) => item.label || t("session.program_pid", { pid: item.pid })).join(" · "))}</span>
        </div>`
          : ""
      }
      <div class="conversation-preview">
        ${conversation.map((row) => `<div class="preview-line ${row.tone}"><b>${esc(row.label)}</b><span>${esc(row.text)}</span></div>`).join("")}
      </div>
      <div class="context-meter ${gaugeTone}">
        <div class="context-meter-head">
          <div>
          <span>${esc(t("session.context_usage"))}</span>
          <strong>${context.window ? `${fullNumber(context.used)} / ${fullNumber(context.window)}` : `${fullNumber(context.used)} / --`}</strong>
          </div>
          <b>${context.window ? `${contextPercent.toFixed(1)}%` : "--"}</b>
          </div>
        <div class="context-meter-track"><span style="width:${contextPercent}%"></span><i style="left:75%"></i><i style="left:90%"></i></div>
        <div class="context-meter-foot">
          <span>${esc(context.window ? t("session.context_remaining", { count: compact(remaining) }) : t("session.context_size_unknown"))}</span>
          <span>${esc(t("session.tokens_used_so_far", { count: compact(usage.total) }))}</span>
          </div>
      </div>
      <div class="token-row">
        <div><span>${esc(t("session.input_tokens"))}</span><b>${compact(usage.input)}</b></div>
        <div><span>${esc(t("session.output_tokens"))}</span><b>${compact(usage.output)}</b></div>
        <div><span>${esc(t("session.cached_tokens"))}</span><b>${compact(usage.cachedInput)}</b></div>
        <div class="total"><span>${esc(t("session.total_tokens"))}</span><b>${compact(usage.total)}</b></div>
      </div>
      ${
        children.length
          ? `<div class="child-row">
        <b>⑂</b>
        <span>${esc(t("session.subagents_created", { count: children.length }))}</span>
        <span class="child-dots">${children
          .slice(0, 4)
          .map(() => "<i></i>")
          .join("")}</span>
        </div>`
          : ""
      }
      <footer class="card-footer">
        <span class="source-tag">${esc(window.LoadToAgentI18n.observedText(session.sourceLabel || t("session.local_history")))}</span>
        <span>${esc(timeAgo(session.updatedAt))}</span>
      </footer>
    </article>`;
  }

  function renderSessions(motionKind = "refresh", deferMotion = false) {
    const previousLayout = deferMotion ? null : captureMotionLayout();
    syncViewChrome();
    renderGuide();
    const tmuxView = state.view === "tmux";
    const terminalView = state.view === "terminal";
    const settingsView = state.view === "settings";
    $("#terminalSection").classList.toggle("hidden", !terminalView);
    $("#tmuxSection").classList.toggle("hidden", !tmuxView);
    $("#settingsSection").classList.toggle("hidden", !settingsView);
    $("#globalStats").classList.toggle("hidden", tmuxView || terminalView || settingsView);
    $("#providerOverview").classList.toggle("hidden", tmuxView || terminalView || settingsView);
    $("#sessionSection").classList.toggle("hidden", tmuxView || terminalView || settingsView);
    const guideVisible = state.view === "all" && state.guideExpanded && !state.graphFocusId;
    $("#beginnerGuide").classList.toggle("hidden", !guideVisible);
    $("#guideBtn").setAttribute("aria-expanded", guideVisible ? "true" : "false");
    renderUpdateSettings();
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
    const showMap = ["all", "active"].includes(state.view);
    const graphLiveCount = showMap ? renderAgentMap(graphFilteredSessions(), motionKind) : 0;
    const regular = state.view === "all" ? sessions.filter((session) => !isLiveSession(session)) : state.view === "active" ? [] : sessions;
    const visible = regular.slice(0, state.visibleLimit);
    $("#liveSection").classList.toggle("hidden", graphLiveCount === 0);
    $("#viewTitle").textContent = VIEW_TITLES[state.view] || window.LoadToAgentI18n.t("ui.recent_conversations_and_tasks");
    $("#sessionGrid").innerHTML = visible.map((session) => sessionCard(session)).join("");
    $("#sessionGrid").classList.toggle("hidden", visible.length === 0);
    $("#loadMoreBtn").classList.toggle("hidden", regular.length <= state.visibleLimit);
    $("#loadMoreBtn").textContent = window.LoadToAgentI18n.t("common.remaining", { count: regular.length - state.visibleLimit });
    $("#emptyState").classList.toggle("hidden", graphLiveCount + regular.length !== 0);
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

  function render(motionKind = "refresh") {
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
  }

  return {
    recentConversation,
    sessionCard,
    renderSessions,
    render,
  };
};
