"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDrawer = function createDrawer(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
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
      ? t("drawer.subagent_title", { name: session.agentName || provider.label })
      : `${provider.company} · ${STATUS[session.status] || session.status}`;
    $("#drawerTitle").textContent = subagentMode ? session.taskName || (session.delegation && session.delegation.taskName) || session.title : session.title;
    const stopping = session.runId && state.stopRequests.has(session.runId);
    const stop =
      session.runId && (session.status === "running" || session.status === "starting")
        ? `<button class="meta-chip stop-run" data-stop-run="${esc(session.runId)}"
          ${stopping ? 'disabled aria-busy="true"' : ""}>
          ${esc(t(stopping ? "drawer.stop_requested" : "drawer.stop_run"))}</button>`
        : "";
    const runtime = session.runtimePresence || [];
    const resume =
      !isLiveSession(session) && agentResumeSupport(session).supported
        ? `<button class="meta-chip resume-agent" data-resume-agent="${esc(session.id)}">▶
          <b>${esc(t(originAppInfo(session) ? "drawer.continue_background_terminal" : "drawer.resume_in_terminal"))}</b>
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
        <span class="meta-chip">${esc(t("drawer.model"))} <b>${esc(session.model || t("drawer.unknown"))}</b>
        </span>
        <span class="meta-chip">${esc(t("drawer.work_history"))} <b>${esc(t("drawer.event_count", { count: subagentMessageCount }))}</b>
        </span>
        <span class="meta-chip">${esc(t("drawer.main_instructions_results"))} <b>${esc(t("drawer.event_count", { count: communicationCount }))}</b>
        </span>${resume}`
      : `<span class="meta-chip">${esc(t("drawer.model"))} <b>${esc(session.model || t("drawer.unknown"))}</b>
        </span>
        <span class="meta-chip">${esc(t("drawer.workspace"))}
          <b title="${esc(isProjectlessSession(session) ? window.LoadToAgentI18n.t("ui.session_not_linked_to_a_specific_project") : session.cwd)}">
            ${esc(sessionWorkspaceLabel(session))}
          </b>
        </span>
        <span class="meta-chip">${esc(t("drawer.task_id"))} <b>${esc(String(session.externalId || "").slice(0, 12) || t("drawer.unknown"))}</b>
        </span>${
          session.parentId
            ? `<span class="meta-chip">⑂ <b>${esc(t("drawer.helper_ai"))}</b>
        </span>`
            : ""
        }${
          runtime.length
            ? `<span class="meta-chip runtime-meta">● <b>${esc(t("session.running_programs", { count: runtime.length }))}</b>
        </span>`
            : ""
        }${resume}${stop}`;
    $$(".drawer-tab").forEach((tab) => {
      const hidden = subagentMode && tab.dataset.tab !== "chat";
      tab.classList.toggle("hidden", hidden);
      if (tab.dataset.tab === "chat") tab.textContent = subagentMode ? t("drawer.work_content") : t("ui.conversation");
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
      ? `<div class="drawer-loading"><span></span><b>${esc(t("drawer.loading_history"))}</b><small>${esc(t("drawer.loading_history_help"))}</small></div>`
      : detailError
        ? `<div class="drawer-error">
        <b>${esc(t("drawer.history_failed"))}</b>
        <span>${esc(detailError)}</span>
        <button type="button" data-retry-detail="${esc(state.selectedId)}">${esc(t("drawer.retry"))}</button>
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
