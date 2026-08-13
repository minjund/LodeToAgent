"use strict";

window.WhiteboxAppFactories = window.WhiteboxAppFactories || {};

window.WhiteboxAppFactories.createSessionRenderer = function createSessionRenderer(context = {}) {
  const t = (key, params) => window.WhiteboxI18n.t(key, params);
  const {
    $,
    esc,
    state,
    PROJECTLESS_WORKSPACE,
    STATUS,
    sessionStatusLabel = session => STATUS[session?.status] || session?.status,
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
    sessionBadgesHtml = () => "",
    statusClass,
    currentActivity,
    isLiveSession,
    isControlRoomSession = isLiveSession,
    isResultReviewComplete = () => false,
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
    renderAttentionPopupSettings = () => {},
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
    preserveFocusDuringRender = callback => callback(),
  } = context;

  function keepDesktopSidebarAtTop() {
    const sidebar = $(".sidebar");
    if (!sidebar || !window.matchMedia("(min-width: 721px)").matches) return;
    sidebar.scrollTop = 0;
  }

  function recentConversation(session) {
    const messages = (session.messages || []).filter((message) => message && message.text && message.role !== "system");
    const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
    const user = latestUserIndex >= 0 ? messages[latestUserIndex] : null;
    // A compact monitor snapshot can contain the newest user turn before its
    // answer arrives. Never pair that request with an assistant/tool message
    // from an older turn, which makes history look like a new AI response.
    const responseMessages = latestUserIndex >= 0 ? messages.slice(latestUserIndex + 1) : messages;
    const assistant = [...responseMessages].reverse().find((message) => message.role === "assistant");
    const tool = [...responseMessages].reverse().find((message) => message.role === "tool");
    const rows = [];
    if (user) rows.push({ label: t("session.me"), text: readablePreview(user.text, 140).text, tone: "user" });
    if (assistant) rows.push({ label: providerInfo(session.provider).label, text: readablePreview(assistant.text, 140).text, tone: "assistant" });
    else if (tool) rows.push({ label: tool.title || t("session.tool"), text: readablePreview(tool.text, 140).text, tone: "tool" });
    if (!rows.length) rows.push({ label: t("session.status"), text: window.WhiteboxI18n.observedText(session.statusDetail || t("session.waiting_for_event")), tone: "system" });
    return rows.slice(-2);
  }

  function sessionCard(session, opts = {}) {
    const provider = providerInfo(session.provider);
    const activity = currentActivity(session);
    const conversation = recentConversation(session);
    const titlePreview = readablePreview(session.title, 96);
    const latest = conversation[conversation.length - 1];
    const activityCopy = latest?.text || latestWorkCopy(session) || window.WhiteboxI18n.observedText(session.statusDetail) || t("session.waiting_for_new_event");
    const activityPreview = readablePreview(activityCopy, 138);
    const accessibleId = `session-${String(session.id || "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const originPath = sessionOriginPath(session);
    const originLabel = sessionWorkspaceLabel(session);
    const explicitWaiting = session?.attention?.category === "required"
      && ["execution-approval", "input-tool"].includes(session.attention.source);
    const presentationStatus = window.WhiteboxTerminal?.pendingPromptForSession?.(session) || explicitWaiting ? "waiting" : session.status;
    return `<article class="session-card session-record ${opts.live ? "live-card" : ""} ${statusClass(presentationStatus)} ${session.parentId ? "subagent" : ""}"
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
        <span class="status-pill ${statusClass(presentationStatus)} activity-${esc(presentationStatus === "waiting" ? "notification" : session.activityState || "idle")}">${esc(sessionStatusLabel(session, presentationStatus))}</span>
      </div>
      ${sessionBadgesHtml(session, { compact: true })}
      <h3 id="${accessibleId}-title" class="card-title" title="${esc(titlePreview.full)}">${esc(titlePreview.text)}</h3>
      <div class="card-subtitle"><span class="origin-project" title="${esc(isProjectlessSession(session) ? window.WhiteboxI18n.t("ui.session_not_linked_to_a_specific_project") : originPath)}"
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

  function memoryCard(session) {
    const provider = providerInfo(session.provider);
    const titlePreview = readablePreview(session.title, 112);
    const requestMessage = (session.messages || []).find((message) => message?.role === "user" && String(message.text || "").trim());
    const requestPreview = readablePreview(requestMessage?.text || session.title || t("memory.request_not_recorded"), 72);
    const outcome = session.outcome || {};
    const executions = (session.executions || []).filter(Boolean);
    const delegationCount = (session.childIds || []).length;
    const executionCount = executions.length;
    const verified = outcome.verified === true || session.evidence?.completion === "observed";
    const explicitEvidenceCount = (outcome.artifacts || []).length + (outcome.checks || []).length;
    const evidenceState = verified
      ? "verified"
      : explicitEvidenceCount > 0
        ? "unverified"
        : "missing";
    const firstResultFile = (outcome.artifacts || []).find((item) =>
      typeof item === "string" || String(item?.kind || "").toLowerCase() === "file");
    const resultFileLocation = typeof firstResultFile === "string"
      ? firstResultFile
      : firstResultFile?.value || firstResultFile?.path || firstResultFile?.file || "";
    const outcomePreview = readablePreview(
      evidenceState === "missing"
        ? t("memory.no_result_detail")
        : resultFileLocation
          ? t("memory.result_file_location", { location: resultFileLocation })
          : outcome.summary || session.result || session.statusDetail || latestWorkCopy(session) || t("memory.recorded"),
      118,
    );
    const decisionRequested = Boolean(
      session.responseIntent?.category && session.responseIntent.category !== "none"
      || ["approval", "decision"].includes(session.attention?.kind),
    );
    const decisionRetained = hasRetainedDecision(session);
    const reviewPending = sessionNeedsResultReview(session);
    const taskCompleted = session.status === "completed";
    const decisionState = decisionRetained ? "retained" : decisionRequested ? "pending" : "absent";
    const accessibleId = `memory-${String(session.id || "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const stage = (index, label, value, tone = "") => `<span class="${tone}" title="${index} · ${esc(label)}${value ? ` · ${esc(value)}` : ""}"><small>${esc(label)}</small>${value ? `<b>${esc(value)}</b>` : ""}</span>`;
    const chain = [
      stage("01", t("memory.intent"), requestPreview.truncated ? t("memory.open_full_request") : requestPreview.text),
      stage("02", t("memory.delegation"), delegationCount ? t("memory.count_short", { count: delegationCount }) : t("memory.no_delegation")),
      stage("03", t("memory.action"), executionCount ? t("memory.count_short", { count: executionCount }) : t("memory.no_execution")),
      stage("04", t("memory.proof"), evidenceState === "missing"
        ? t("memory.none")
        : t(`memory.stage_evidence_${evidenceState}`), evidenceState === "missing" ? "pending" : evidenceState),
      stage("05", t("memory.judgement"), evidenceState === "missing"
        ? t("memory.no_result_to_review")
        : t(`memory.stage_decision_${decisionState}`), evidenceState === "missing"
        ? "pending"
        : decisionRetained ? "decision" : decisionRequested ? "unverified" : "pending"),
    ].join("");
    return `<article class="session-card memory-record ${reviewPending ? "review-pending" : ""} ${taskCompleted ? "task-completed" : ""} ${statusClass(session.status)}"
      data-session-id="${esc(session.id)}"
      ${reviewPending ? 'data-result-review="true"' : ""}
      data-motion-key="memory:${esc(session.id)}"
      data-motion-value="${esc(session.updatedAt || "")}:${esc(session.status || "")}"
      style="${providerStyle(session.provider)}"
      role="button" tabindex="0"
      aria-labelledby="${accessibleId}-title" aria-describedby="${accessibleId}-${taskCompleted ? "status" : "proof"}">
      <span class="memory-record-mark" aria-hidden="true">${taskCompleted ? "✓" : verified && !decisionRetained ? "!" : verified ? "✓" : "○"}</span>
      <span class="memory-record-intent">
        <small>${isProjectlessSession(session)
          ? `${esc(t("memory.start_folder"))}: ${esc(t("ui.no_project"))} · ${esc(t("memory.last_activity", { time: memoryActivityTime(session.updatedAt) }))}`
          : `${esc(t("memory.start_folder"))}: ${esc(sessionWorkspaceLabel(session))} · ${esc(t("memory.last_activity", { time: memoryActivityTime(session.updatedAt) }))}`}</small>
        <b id="${accessibleId}-title" title="${esc(titlePreview.full)}">${esc(t("memory.work_name", { title: titlePreview.text }))}</b>
        ${taskCompleted ? `<span id="${accessibleId}-status" class="memory-review-status completed">${esc(t("memory.current_status_completed"))}</span>` : ""}
        ${titlePreview.text.includes(provider.label) ? "" : `<em>${esc(t("memory.provider", { provider: provider.label }))}${decisionRetained ? ` · ${esc(t("memory.decisions"))}` : ""}</em>`}
        ${sessionBadgesHtml(session, { compact: true, includeModel: false })}
      </span>
      ${reviewPending
        ? `<span class="memory-review-wrap"><button type="button" class="memory-review-action" data-open-session="${esc(session.id)}" data-result-review="true"><b>${esc(provider.label)} 결과 확인하기 <i aria-hidden="true">→</i></b></button><small><span class="memory-review-help-desktop">결과를 열면 확인 상태가 저장되어 다음 실행 때 다시 나타나지 않습니다.</span><span class="memory-review-help-mobile">결과를 열면 확인 상태가 저장됩니다.</span></small></span>`
        : `<details class="memory-record-lineage">
          <summary><span class="memory-summary-closed">${esc(t("memory.expand_summary"))}</span><span class="memory-summary-open">${esc(t("memory.collapse_summary"))}</span><i aria-hidden="true">⌄</i></summary>
          <small>${esc(t("memory.lineage"))}</small>
          <span class="memory-record-chain">${chain}</span>
        </details>`}
      ${reviewPending ? `<span class="memory-record-proof memory-review-proof-proxy" aria-hidden="true"></span>` : `<span id="${accessibleId}-proof" class="memory-record-proof ${evidenceState}">
        <small>${esc(t("memory.proof"))}</small>
        <b>${esc(t(`memory.evidence_${evidenceState}`))}</b>
        <em title="${esc(outcomePreview.full)}">${esc(outcomePreview.text)}</em>
      </span>`}
      <span class="memory-record-open">${esc(t("memory.open_record"))}<i aria-hidden="true">→</i></span>
    </article>`;
  }

  function memoryActivityTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return t("memory.time_unknown");
    const localeTag = window.WhiteboxI18n.getLocaleTag();
    return new Intl.DateTimeFormat(localeTag, {
      year: "numeric", month: "long", day: "numeric",
      hour: localeTag.startsWith("ko") ? "2-digit" : "numeric",
      minute: "2-digit",
      ...(localeTag.startsWith("ko") ? { hourCycle: "h23" } : {}),
    }).format(date);
  }

  function hasRetainedDecision(session) {
    if (isResultReviewComplete(session)) return true;
    const outcome = session.outcome || {};
    if (outcome.decision || outcome.approval?.status === "approved" || outcome.approval?.status === "denied") return true;
    return (session.lifecycle || []).some((row) => {
      const copy = `${row?.type || ""} ${row?.label || ""} ${row?.detail || ""}`;
      const decisionEvent = /(?:user[-_ ]?decision|decision[-_ ]?(?:made|recorded)|approval[-_ ]?(?:approved|denied)|사용자\s*(?:판단|결정)|승인\s*(?:완료|거절)|결정\s*(?:완료|기록))/i.test(copy);
      const pending = /(?:필요|대기|요청|pending|required|request|await)/i.test(copy);
      return decisionEvent && !pending && ["completed", "done", "approved", "denied", "resolved"].includes(String(row?.status || "").toLowerCase());
    });
  }

  function sessionNeedsResultReview(session) {
    const outcome = session.outcome || {};
    const verified = outcome.verified === true || session.evidence?.completion === "observed";
    return verified && !hasRetainedDecision(session);
  }

  function renderMemoryMetrics(sessions) {
    const resultSessions = sessions.filter((session) => {
      const artifacts = session.outcome?.artifacts?.length || 0;
      const checks = session.outcome?.checks?.length || 0;
      const completion = session.outcome?.verified || session.evidence?.completion === "observed";
      return artifacts > 0 || checks > 0 || completion;
    });
    const decisionCount = resultSessions.filter(hasRetainedDecision).length;
    const evidenceCount = Math.max(0, resultSessions.length - decisionCount);
    const completedCount = resultSessions.filter(session => session.status === "completed").length;
    $("#memoryRecordCount").textContent = t("memory.metric_count", { count: fullNumber(sessions.length) });
    $("#memoryEvidenceLabel").textContent = t("memory.evidence");
    $("#memoryEvidenceCount").textContent = t("memory.metric_count", { count: fullNumber(completedCount) });
    $("#memoryDecisionLabel").textContent = "확인 완료";
    $("#memoryDecisionCount").textContent = t("memory.metric_count", { count: fullNumber(decisionCount) });
    const priorityAction = $("#memoryPriorityAction");
    if (priorityAction) {
      priorityAction.classList.toggle("hidden", evidenceCount === 0);
      priorityAction.textContent = t("memory.open_completed", { count: fullNumber(completedCount) });
    }
    if ($("#memoryPrinciple")) {
      $("#memoryPrinciple").textContent = t("memory.principle", {
        total: fullNumber(sessions.length),
        new: fullNumber(completedCount),
        reviewed: fullNumber(decisionCount),
      });
    }
    if ($("#viewTitle")) $("#viewTitle").textContent = t("memory.archive_title", { count: fullNumber(sessions.length) });
  }

  function renderSessionsContent(motionKind = "refresh", deferMotion = false) {
    keepDesktopSidebarAtTop();
    const previousLayout = deferMotion ? null : captureMotionLayout();
    syncViewChrome();
    renderGuide();
    const tmuxView = state.view === "tmux";
    const terminalView = state.view === "terminal";
    const settingsView = state.view === "settings";
    const runtimeView = state.view === "runtime";
    const attentionView = state.view === "waiting";
    const memoryView = state.view === "active";
    const homeView = state.view === "all";
    const projectSelected = state.workspace !== "all";
    const taskProjectSelected = projectSelected && state.workspace !== PROJECTLESS_WORKSPACE;
    const projectSelectionView = homeView && !projectSelected;
    const operationsView = homeView && projectSelected;
    const focusedToolView = tmuxView || terminalView || settingsView || runtimeView;
    $("#projectSelectionPrompt")?.classList.toggle("hidden", !projectSelectionView);
    $("#projectTaskToolbar")?.classList.toggle("hidden", !homeView || !taskProjectSelected);
    $("#terminalSection").classList.toggle("hidden", !terminalView);
    $("#tmuxSection").classList.toggle("hidden", !tmuxView);
    $("#settingsSection").classList.toggle("hidden", !settingsView);
    $("#globalStats").classList.toggle("hidden", focusedToolView || homeView || memoryView || attentionView);
    $("#providerOverview").classList.add("hidden");
    $("#sessionSection").classList.toggle("hidden", !memoryView);
    $("#operationsOverview").classList.toggle("hidden", !operationsView);
    $("#attentionInbox").classList.toggle("hidden", !attentionView);
    if (runtimeView) renderRuntimeOverview();
    $("#automationOverview").classList.toggle("hidden", !runtimeView);
    const guideVisible = state.view === "all" && projectSelected && state.guideExpanded && !state.graphFocusId;
    $("#beginnerGuide").classList.toggle("hidden", !guideVisible);
    $("#guideBtn").setAttribute("aria-expanded", guideVisible ? "true" : "false");
    renderUpdateSettings();
    if (runtimeView) {
      $("#liveSection").classList.add("hidden");
      if (window.WhiteboxTerminal) window.WhiteboxTerminal.deactivate();
      if (!deferMotion) playMotionLayout(previousLayout, motionKind);
      if (motionKind === "view") animateVisibleSections();
      return;
    }
    if (settingsView) {
      $("#liveSection").classList.add("hidden");
      renderAttentionPopupSettings();
      renderProviderVisibilitySettings();
      if (window.WhiteboxTerminal) window.WhiteboxTerminal.deactivate();
      if (!deferMotion) playMotionLayout(previousLayout, motionKind);
      if (motionKind === "view") animateVisibleSections();
      return;
    }
    if (terminalView) {
      $("#liveSection").classList.add("hidden");
      if (window.WhiteboxTerminal) window.WhiteboxTerminal.activate(visibleSnapshot(), state.workspaces, "general");
      if (!deferMotion) playMotionLayout(previousLayout, motionKind);
      if (motionKind === "view") animateVisibleSections();
      return;
    }
    if (tmuxView) {
      $("#liveSection").classList.add("hidden");
      renderTmuxMap();
      if (window.WhiteboxTerminal) window.WhiteboxTerminal.activate(visibleSnapshot(), state.workspaces, "tmux");
      if (!deferMotion) playMotionLayout(previousLayout, motionKind);
      if (motionKind === "view") animateVisibleSections();
      return;
    }
    if (window.WhiteboxTerminal) window.WhiteboxTerminal.deactivate();
    const sessions = filteredSessions();
    if (operationsView) renderOperationsOverview();
    const attentionCount = attentionView ? renderAttentionInbox() : 0;
    const showMap = homeView && projectSelected;
    const graphLiveCount = showMap ? renderAgentMap(graphFilteredSessions(), motionKind) : 0;
    const regular = memoryView ? [...sessions] : [];
    const compactMemory = memoryView && window.matchMedia("(max-width: 760px)").matches;
    const effectiveLimit = compactMemory && state.visibleLimit === 30 ? 2 : state.visibleLimit;
    const visible = regular.slice(0, effectiveLimit);
    const resultCount = attentionView
      ? attentionCount
      : memoryView
        ? regular.length
        : regular.length;
    const resultSummaryKey = window.matchMedia("(max-width: 760px)").matches
      ? "quality.results_summary_mobile"
      : "quality.results_summary";
    $("#sessionResultSummary").textContent = window.WhiteboxI18n.t(resultSummaryKey, {
      count: resultCount,
      total: resultCount,
      shown: visible.length,
      remaining: Math.max(0, resultCount - visible.length),
    });
    const activeEmpty = homeView && projectSelected && !state.graphFocusId && graphLiveCount === 0;
    $("#activeEmptyState").classList.toggle("hidden", !activeEmpty);
    $("#liveSection").classList.toggle("hidden", !homeView || !projectSelected);
    $("#viewTitle").textContent = memoryView ? t("memory.archive_title") : VIEW_TITLES[state.view] || window.WhiteboxI18n.t("ui.recent_conversations_and_tasks");
    $("#sessionGrid").innerHTML = visible.map((session) => memoryView ? memoryCard(session) : sessionCard(session)).join("");
    if (memoryView) renderMemoryMetrics(regular);
    $("#sessionGrid").classList.toggle("hidden", visible.length === 0);
    $("#loadMoreBtn").classList.toggle("hidden", regular.length <= effectiveLimit);
    $("#loadMoreBtn").textContent = window.WhiteboxI18n.t("common.remaining", { count: Math.max(0, regular.length - visible.length) });
    $("#emptyState").classList.toggle("hidden", attentionView || graphLiveCount + regular.length !== 0);
    const hasConditions = Boolean(state.search || state.providerFilters.size || state.workspace !== "all" || state.sort !== "recent");
    $("#emptyClearFiltersBtn").classList.toggle("hidden", resultCount !== 0 || !hasConditions);
    if (graphLiveCount + regular.length === 0) {
      const emptyCopy = state.search
        ? [window.WhiteboxI18n.t("ui.no_search_results"), window.WhiteboxI18n.t("ui.clear_the_search_or_change_the_ai_and_workspace_filters")]
        : memoryView
          ? [window.WhiteboxI18n.t("memory.empty_title"), window.WhiteboxI18n.t("memory.empty_description")]
          : state.view === "waiting"
            ? [window.WhiteboxI18n.t("ui.all_caught_up"), window.WhiteboxI18n.t("ui.no_tasks_are_waiting_for_your_response_or_choice")]
            : [window.WhiteboxI18n.t("ui.no_tasks_to_show_yet"), window.WhiteboxI18n.t("ui.check_ai_readiness_then_start_your_first_task")];
      $("#emptyState h3").textContent = emptyCopy[0];
      $("#emptyState p").textContent = emptyCopy[1];
    }
    if (!deferMotion) playMotionLayout(previousLayout, motionKind);
    if (motionKind === "view") animateVisibleSections();
  }

  function renderSessions(motionKind = "refresh", deferMotion = false) {
    return preserveFocusDuringRender(() => {
      const restoreScroll = window.WhiteboxRendererUtils.preserveScrollPositions(
        motionKind === "view" ? [".main-stage"] : [".main-stage", ".sidebar"],
      );
      context.rememberDisclosureStates?.(document);
      try {
        return renderSessionsContent(motionKind, deferMotion);
      } finally {
        context.restoreDisclosureStates?.(document);
        restoreScroll();
        if (motionKind === "view") {
          const resetSidebar = () => {
            const sidebar = $(".sidebar");
            if (sidebar) sidebar.scrollTop = 0;
          };
          resetSidebar();
          requestAnimationFrame(() => {
            resetSidebar();
            requestAnimationFrame(resetSidebar);
          });
        }
      }
    });
  }

  function render(motionKind = "refresh") {
    return preserveFocusDuringRender(() => {
      const restoreScroll = window.WhiteboxRendererUtils.preserveScrollPositions(
        motionKind === "view" ? [".main-stage"] : [".main-stage", ".sidebar"],
      );
      context.rememberDisclosureStates?.(document);
      try {
        const previousLayout = captureMotionLayout();
        renderProviderRail();
        renderWorkspaces();
        renderGlobalStats();
        renderProviderOverview();
        renderProviderFilter();
        renderAttentionPopupSettings();
        renderProviderVisibilitySettings();
        renderSessions(motionKind, true);
        if (state.selectedId && $("#detailDrawer").classList.contains("open")) context.renderDrawer();
        playMotionLayout(previousLayout, motionKind);
        if (motionKind === "view") animateVisibleSections();
      } finally {
        context.restoreDisclosureStates?.(document);
        restoreScroll();
        if (motionKind === "view") {
          const resetSidebar = () => {
            const sidebar = $(".sidebar");
            if (sidebar) sidebar.scrollTop = 0;
          };
          resetSidebar();
          requestAnimationFrame(() => {
            resetSidebar();
            requestAnimationFrame(resetSidebar);
          });
        }
      }
    });
  }

  return {
    recentConversation,
    sessionCard,
    renderSessions,
    render,
  };
};
