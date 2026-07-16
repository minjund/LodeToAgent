"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDrawer = function createDrawer(context = {}) {
  const {
    $, $$, esc, state, motionPreference, motionState, STATUS, markGuideStep, rememberDialogTrigger, restoreDialogTrigger,
    providerInfo, isLiveSession, subagentWorkState, subagentWorkLabel, isProjectlessSession, sessionWorkspaceLabel,
    agentResumeSupport, originAppInfo, selectedSession, snapshotSession, loadSessionDetail, loadSubagentParentDetail,
    chatHtml, lifecycleHtml, tokensHtml, subagentCoordinationEvents, subagentConversationHtml,
  } = context;

  function openDrawer(id) {
    rememberDialogTrigger();
    markGuideStep("detail");
    state.selectedId = id;
    state.drawerMode = "session";
    state.drawerTab = "chat";
    state.drawerForceLatest = true;
    clearTimeout(motionState.drawerTimer);
    $("#drawerBackdrop").classList.remove("hidden");
    $("#drawerBackdrop").classList.remove("closing");
    $("#detailDrawer").classList.add("open");
    $("#detailDrawer").removeAttribute("inert");
    $("#detailDrawer").setAttribute("aria-hidden", "false");
    renderDrawer();
    loadSessionDetail(id, true);
    setTimeout(() => $("#closeDrawerBtn").focus(), 0);
  }

  function openSubagentConversation(id) {
    const child = snapshotSession(id) || state.details.get(id);
    if (!child || !child.parentId) return openDrawer(id);
    rememberDialogTrigger();
    markGuideStep("detail");
    state.selectedId = id;
    state.drawerMode = "subagent";
    state.drawerTab = "chat";
    state.drawerForceLatest = true;
    clearTimeout(motionState.drawerTimer);
    $("#drawerBackdrop").classList.remove("hidden");
    $("#drawerBackdrop").classList.remove("closing");
    $("#detailDrawer").classList.add("open");
    $("#detailDrawer").removeAttribute("inert");
    $("#detailDrawer").setAttribute("aria-hidden", "false");
    renderDrawer();
    loadSessionDetail(id);
    loadSubagentParentDetail(child);
    setTimeout(() => $("#closeDrawerBtn").focus(), 0);
  }

  function closeDrawer(restoreFocus = true) {
    if (!$("#detailDrawer").classList.contains("open")) return;
    $("#detailDrawer").classList.remove("open");
    $("#detailDrawer").setAttribute("aria-hidden", "true");
    $("#detailDrawer").setAttribute("inert", "");
    $("#drawerBackdrop").classList.add("closing");
    clearTimeout(motionState.drawerTimer);
    motionState.drawerTimer = setTimeout(
      () => {
        $("#drawerBackdrop").classList.add("hidden");
        $("#drawerBackdrop").classList.remove("closing");
        if (restoreFocus) restoreDialogTrigger();
        else motionState.activeDialogTrigger = null;
      },
      motionPreference.matches ? 0 : 260,
    );
  }

  function renderDrawer() {
    const session = selectedSession();
    if (!session) return closeDrawer();
    const provider = providerInfo(session.provider);
    const subagentMode = state.drawerMode === "subagent" && Boolean(session.parentId);
    const detailLoading = state.detailLoadingIds.has(state.selectedId);
    $("#detailDrawer").style.setProperty("--drawer-provider", provider.accent);
    $("#drawerProviderMark").style.setProperty("--provider", provider.accent);
    $("#drawerProviderMark").textContent = provider.mark;
    $("#drawerProvider").textContent = subagentMode
      ? `${session.agentName || provider.label} · 서브에이전트 작업 기록`
      : `${provider.company} · ${STATUS[session.status] || session.status}`;
    $("#drawerTitle").textContent = subagentMode ? session.taskName || (session.delegation && session.delegation.taskName) || session.title : session.title;
    const stopping = session.runId && state.stopRequests.has(session.runId);
    const stop =
      session.runId && (session.status === "running" || session.status === "starting")
        ? `<button class="meta-chip stop-run" data-stop-run="${esc(session.runId)}"
          ${stopping ? 'disabled aria-busy="true"' : ""}>
          ${stopping ? "중지 요청 중…" : "■ 실행 중지"}</button>`
        : "";
    const runtime = session.runtimePresence || [];
    const resume =
      !isLiveSession(session) && agentResumeSupport(session).supported
        ? `<button class="meta-chip resume-agent" data-resume-agent="${esc(session.id)}">▶
          <b>${originAppInfo(session) ? "백그라운드 터미널로 이어가기" : "터미널로 다시 일 시키기"}</b>
        </button>`
        : "";
    const communicationCount = subagentMode ? subagentCoordinationEvents(session).length : 0;
    const subagentMessageCount = subagentMode
      ? (session.messages || []).filter((message) => message.role === "user" || message.role === "assistant").length
      : 0;
    $("#drawerMeta").innerHTML = subagentMode
      ? `<span class="meta-chip work-state ${subagentWorkState(session)}">
        <b>${esc(subagentWorkLabel(session))}</b>
        </span>
        <span class="meta-chip">사용 모델 <b>${esc(session.model || "정보 없음")}</b>
        </span>
        <span class="meta-chip">작업 기록 <b>${subagentMessageCount}건</b>
        </span>
        <span class="meta-chip">메인 지시·결과 <b>${communicationCount}건</b>
        </span>${resume}`
      : `<span class="meta-chip">사용 모델 <b>${esc(session.model || "정보 없음")}</b>
        </span>
        <span class="meta-chip">작업 폴더
          <b title="${esc(isProjectlessSession(session) ? window.LoadToAgentI18n.t("ui.session_not_linked_to_a_specific_project") : session.cwd)}">
            ${esc(sessionWorkspaceLabel(session))}
          </b>
        </span>
        <span class="meta-chip">작업 번호 <b>${esc(String(session.externalId || "").slice(0, 12) || "정보 없음")}</b>
        </span>${
          session.parentId
            ? `<span class="meta-chip">⑂ <b>도움을 맡은 AI</b>
        </span>`
            : ""
        }${
          runtime.length
            ? `<span class="meta-chip runtime-meta">● <b>실행 중인 프로그램 ${runtime.length}개</b>
        </span>`
            : ""
        }${resume}${stop}`;
    $$(".drawer-tab").forEach((tab) => {
      const hidden = subagentMode && tab.dataset.tab !== "chat";
      tab.classList.toggle("hidden", hidden);
      if (tab.dataset.tab === "chat") tab.textContent = subagentMode ? "작업 내용" : window.LoadToAgentI18n.t("ui.conversation");
      const active = tab.dataset.tab === state.drawerTab;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    });
    const activeTab = $(`.drawer-tab[data-tab="${state.drawerTab}"]`);
    if (activeTab) $("#drawerContent").setAttribute("aria-labelledby", activeTab.id);
    const content = $("#drawerContent");
    const previousTop = content.scrollTop;
    const wasNearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 90;
    const renderKey = `${state.drawerMode}:${state.selectedId}:${state.drawerTab}:${detailLoading ? "loading" : "ready"}`;
    const previousRenderKey = motionState.drawerRenderKey;
    const shouldAnimateContent = previousRenderKey !== renderKey;
    const tabChanged = Boolean(motionState.drawerTab) && motionState.drawerTab !== state.drawerTab;
    motionState.drawerRenderKey = renderKey;
    motionState.drawerTab = state.drawerTab;
    const detailError = state.detailErrors.get(state.selectedId);
    content.innerHTML = detailLoading
      ? '<div class="drawer-loading"><span></span><b>전체 작업 기록을 불러오는 중</b><small>잠시만 기다리면 대화와 진행 과정을 볼 수 있어요.</small></div>'
      : detailError
        ? `<div class="drawer-error">
        <b>작업 기록을 불러오지 못했습니다</b>
        <span>${esc(detailError)}</span>
        <button type="button" data-retry-detail="${esc(state.selectedId)}">다시 시도</button>
        </div>`
        : subagentMode
          ? subagentConversationHtml(session)
          : state.drawerTab === "chat"
            ? chatHtml(session)
            : state.drawerTab === "lifecycle"
              ? lifecycleHtml(session)
              : tokensHtml(session);
    content.classList.toggle("motion-content-in", shouldAnimateContent && !motionPreference.matches);
    clearTimeout(motionState.drawerContentTimer);
    if (shouldAnimateContent)
      motionState.drawerContentTimer = setTimeout(() => content.classList.remove("motion-content-in"), motionPreference.matches ? 0 : 520);
    if (!detailLoading)
      requestAnimationFrame(() => {
        const forceLatest = state.drawerForceLatest;
        if (state.drawerTab === "chat" && forceLatest) {
          const rows = [...content.querySelectorAll(".chat-row")];
          const latest = rows[rows.length - 1];
          if (latest && latest.offsetHeight > content.clientHeight - 90) {
            const contentTop = content.getBoundingClientRect().top;
            const stickyHeight = content.querySelector(".chat-history-head")?.getBoundingClientRect().height || 0;
            content.scrollTop = Math.max(0, content.scrollTop + latest.getBoundingClientRect().top - contentTop - stickyHeight - 12);
          } else content.scrollTop = content.scrollHeight;
        } else if (tabChanged) content.scrollTop = 0;
        else if (state.drawerTab === "chat" && wasNearBottom) content.scrollTop = content.scrollHeight;
        else content.scrollTop = Math.min(previousTop, Math.max(0, content.scrollHeight - content.clientHeight));
        state.drawerForceLatest = false;
      });
  }

  return { openDrawer, openSubagentConversation, closeDrawer, renderDrawer };
};
