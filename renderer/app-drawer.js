"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDrawer = function createDrawer(context = {}) {
  const CONTEXT_DRAWER_MIN_WIDTH = 1680;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $, $$, esc, state, motionPreference, motionState, STATUS, markGuideStep, rememberDialogTrigger, restoreDialogTrigger, discardDialogTrigger, setDialogOpenState,
    providerInfo, isLiveSession, controlRoomStatus = session => session?.status, subagentWorkState, subagentWorkLabel, isProjectlessSession, sessionOriginPath, sessionWorkspaceLabel,
    readablePreview = value => ({ full: String(value || "").trim(), text: String(value || "").trim(), truncated: false }),
    pendingConversationDelivery = () => null,
    agentResumeSupport, originAppInfo, selectedSession, snapshotSession, loadSessionDetail, loadSubagentParentDetail,
    chatHtml, lifecycleHtml, tokensHtml, outcomeHtml, subagentCoordinationEvents, subagentConversationHtml, executionActivityDetailHtml,
    agentCommandComposer,
    rememberDisclosureStates = () => {}, restoreDisclosureStates = () => {},
  } = context;
  let drawerFocusToken = null;
  let terminalRefreshQueued = false;
  const deliveryLabelKey = (phase) => ({
    sending: "control.delivery_sending",
    confirming: "control.delivery_confirming",
    delayed: "control.delivery_delayed",
    uncertain: "control.delivery_uncertain",
    received: "control.delivery_received",
    responding: "control.delivery_responding",
    interrupted: "control.delivery_interrupted",
    failed: "control.delivery_failed",
  })[phase] || "control.delivery_confirming";

  function reconcileFocusedComposer(composer, nextHtml, sessionId) {
    const currentForm = composer.querySelector(`[data-agent-command-form="${CSS.escape(sessionId)}"]`);
    const currentInput = currentForm?.querySelector("[data-agent-command-draft]");
    if (!currentForm || !currentInput || !nextHtml) return false;
    const template = document.createElement("template");
    template.innerHTML = nextHtml;
    const nextForm = template.content.querySelector(`[data-agent-command-form="${CSS.escape(sessionId)}"]`);
    const nextInput = nextForm?.querySelector("[data-agent-command-draft]");
    if (!nextForm || !nextInput) return false;

    currentForm.className = nextForm.className;
    for (const attribute of [...currentForm.attributes]) {
      if (attribute.name.startsWith("data-agent-") && !nextForm.hasAttribute(attribute.name)) {
        currentForm.removeAttribute(attribute.name);
      }
    }
    for (const attribute of [...nextForm.attributes]) {
      if (attribute.name.startsWith("data-agent-")) currentForm.setAttribute(attribute.name, attribute.value);
    }

    currentInput.placeholder = nextInput.placeholder;
    currentInput.disabled = nextInput.disabled;
    const inputLabel = currentInput.closest(".agent-command-input");
    const currentPicker = currentForm.querySelector(":scope > .agent-command-target");
    const nextPicker = nextForm.querySelector(":scope > .agent-command-target");
    currentPicker?.remove();
    if (nextPicker && inputLabel) currentForm.insertBefore(nextPicker.cloneNode(true), inputLabel);
    const currentHint = currentForm.querySelector(":scope > .drawer-terminal-input-hint");
    const nextHint = nextForm.querySelector(":scope > .drawer-terminal-input-hint");
    currentHint?.remove();
    if (nextHint && inputLabel) inputLabel.after(nextHint.cloneNode(true));
    const currentActions = currentForm.querySelector(":scope > .agent-command-actions");
    const nextActions = nextForm.querySelector(":scope > .agent-command-actions");
    if (currentActions && nextActions) currentActions.replaceChildren(...[...nextActions.childNodes].map(node => node.cloneNode(true)));
    return true;
  }

  window.addEventListener("loadtoagent:drawer-terminal-targets-changed", event => {
    const sessionId = String(event.detail?.sessionId || "");
    if (sessionId && sessionId !== state.selectedId) return;
    if (terminalRefreshQueued || state.drawerTab !== "chat" || !$("#detailDrawer")?.classList.contains("open")) return;
    terminalRefreshQueued = true;
    requestAnimationFrame(() => {
      terminalRefreshQueued = false;
      if (state.drawerTab === "chat" && $("#detailDrawer")?.classList.contains("open")) renderDrawer();
    });
  });

  function scheduleFlowConnections() {
    requestAnimationFrame(() => {
      window.LoadToAgentApp?.scheduleAgentWorkflowConnections?.();
      window.LoadToAgentApp?.drawAgentWorkflowConnections?.();
    });
  }

  function resolvedPresentation(options = {}) {
    const requested = options.presentation || (options.context ? "context" : "modal");
    if (requested !== "context") return "modal";
    return state.view === "all" && window.innerWidth >= CONTEXT_DRAWER_MIN_WIDTH
      ? "context"
      : "modal";
  }

  function setDrawerPresentation(presentation) {
    const drawer = $("#detailDrawer");
    const contextual = presentation === "context";
    state.drawerPresentation = presentation;
    drawer.dataset.presentation = presentation;
    drawer.setAttribute("role", contextual ? "complementary" : "dialog");
    if (contextual) drawer.removeAttribute("aria-modal");
    else drawer.setAttribute("aria-modal", "true");
    $("#drawerBackToFlowBtn").classList.toggle("hidden", !contextual);
    $("#drawerResizeHandle").classList.toggle("hidden", !contextual);
    document.body.classList.toggle("conversation-context-open", contextual);
    const currentWidth = Math.round(drawer.getBoundingClientRect().width || 640);
    $("#drawerResizeHandle").setAttribute("aria-valuenow", String(currentWidth));
    if (contextual) {
      $("#drawerBackdrop").classList.add("hidden");
      $("#drawerBackdrop").classList.remove("closing");
    } else {
      $("#drawerBackdrop").classList.remove("hidden");
      $("#drawerBackdrop").classList.remove("closing");
    }
    scheduleFlowConnections();
  }

  function openDrawerSurface(presentation) {
    clearTimeout(motionState.drawerTimer);
    setDrawerPresentation(presentation);
    $("#detailDrawer").classList.add("open");
    if (presentation === "modal") {
      setDialogOpenState($("#detailDrawer"), true);
    } else {
      $("#detailDrawer").removeAttribute("inert");
      $("#detailDrawer").setAttribute("aria-hidden", "false");
      $("#appShell")?.removeAttribute("inert");
      document.body.classList.remove("dialog-open");
    }
  }

  function rememberDrawerTrigger() {
    if ($("#detailDrawer").classList.contains("open")) return;
    drawerFocusToken = rememberDialogTrigger("detailDrawer", { refresh: Boolean(drawerFocusToken) });
  }

  function openDrawer(id, options = {}) {
    rememberDrawerTrigger();
    markGuideStep("detail");
    state.selectedId = id;
    state.drawerMode = "session";
    state.drawerExecutionId = null;
    state.drawerTab = options.tab === "summary" ? "summary" : "chat";
    state.drawerForceLatest = state.drawerTab === "chat";
    openDrawerSurface(resolvedPresentation(options));
    renderDrawer();
    loadSessionDetail(id, true);
    setTimeout(
      () => (state.drawerPresentation === "modal" ? $("#closeDrawerBtn") : $("#drawerBackToFlowBtn")).focus({ preventScroll: true }),
      0,
    );
  }

  function openSubagentConversation(id, options = {}) {
    const child = snapshotSession(id) || state.details.get(id);
    if (!child || !child.parentId) return openDrawer(id, options);
    rememberDrawerTrigger();
    markGuideStep("detail");
    state.selectedId = id;
    state.drawerMode = "subagent";
    state.drawerExecutionId = null;
    state.drawerTab = "chat";
    state.agentCommandRoutes.delete(id);
    state.drawerForceLatest = true;
    openDrawerSurface(resolvedPresentation(options));
    renderDrawer();
    loadSessionDetail(id);
    loadSubagentParentDetail(child);
    setTimeout(
      () => (state.drawerPresentation === "modal" ? $("#closeDrawerBtn") : $("#drawerBackToFlowBtn")).focus({ preventScroll: true }),
      0,
    );
  }

  function openExecutionActivity(ownerId, executionId) {
    const owner = snapshotSession(ownerId) || state.details.get(ownerId);
    if (!owner) return;
    rememberDrawerTrigger();
    markGuideStep("detail");
    state.selectedId = ownerId;
    state.drawerMode = "execution";
    state.drawerExecutionId = executionId;
    state.drawerTab = "chat";
    state.drawerForceLatest = false;
    openDrawerSurface("modal");
    renderDrawer();
    loadSessionDetail(ownerId);
    if (owner.parentId) loadSubagentParentDetail(owner);
    setTimeout(() => $("#closeDrawerBtn").focus({ preventScroll: true }), 0);
  }

  function closeDrawer(restoreFocus = true) {
    if (!$("#detailDrawer").classList.contains("open")) return;
    window.LoadToAgentDrawerTerminal?.unmount?.({ resetAvailability: true, sessionId: state.selectedId });
    const presentation = state.drawerPresentation;
    const focusToken = drawerFocusToken;
    $("#detailDrawer").classList.remove("open");
    if (presentation === "modal") {
      setDialogOpenState($("#detailDrawer"), false);
      $("#drawerBackdrop").classList.add("closing");
    } else {
      $("#detailDrawer").setAttribute("inert", "");
      $("#detailDrawer").setAttribute("aria-hidden", "true");
      $("#drawerBackdrop").classList.add("hidden");
      $("#drawerBackdrop").classList.remove("closing");
      document.body.classList.remove("conversation-context-open");
      scheduleFlowConnections();
    }
    clearTimeout(motionState.drawerTimer);
    motionState.drawerTimer = setTimeout(
      () => {
        $("#drawerBackdrop").classList.add("hidden");
        $("#drawerBackdrop").classList.remove("closing");
        setDrawerPresentation("modal");
        $("#drawerBackdrop").classList.add("hidden");
        if (drawerFocusToken !== focusToken) return;
        drawerFocusToken = null;
        if (!focusToken) return;
        if (restoreFocus) restoreDialogTrigger(focusToken);
        else discardDialogTrigger(focusToken);
      },
      motionPreference.matches ? 0 : 260,
    );
  }

  function backToAgentFlow() {
    closeDrawer();
  }

  function renderDrawer() {
    const session = selectedSession();
    if (!session) return closeDrawer();
    const provider = providerInfo(session.provider);
    const presentationStatus = controlRoomStatus(session);
    const delivery = pendingConversationDelivery(session);
    const presentationLabel = delivery ? t(deliveryLabelKey(delivery.phase)) : STATUS[presentationStatus] || presentationStatus;
    const subagentMode = state.drawerMode === "subagent" && Boolean(session.parentId);
    const executionMode = state.drawerMode === "execution" && Boolean(state.drawerExecutionId);
    // The conversation always keeps one terminal-shaped surface. When an exact
    // PTY target exists, mount that same terminal and scrollback in the chat
    // tab. Otherwise render the safe conversation transcript inside the same
    // visual shell; never guess a target that could receive another task's
    // input. PTY availability, not the provider status, is the source of truth.
    const conversationTab = state.drawerTab === "chat";
    const terminalTargets = !session.parentId && !subagentMode && !executionMode
      ? (window.LoadToAgentTerminal?.agentTargets?.(session) || [])
      : [];
    const savedTargetId = state.agentCommandTargets.get(session.id) || "";
    const attachableTerminalTargets = terminalTargets.filter(target => target.kind === "terminal");
    const savedTerminalTarget = attachableTerminalTargets.find(target => target.id === savedTargetId) || null;
    const terminalTarget = [savedTerminalTarget, ...attachableTerminalTargets]
      .filter((target, index, targets) => target && targets.indexOf(target) === index)
      .find(target => window.LoadToAgentDrawerTerminal?.canMount?.(session, target.id) !== false)
      || null;
    const terminalConversation = terminalTarget?.kind === "terminal";
    const embeddedTerminal = window.LoadToAgentTerminal?.embeddedState?.() || {};
    const terminalId = String(terminalTarget?.terminalId || terminalTarget?.id || "");
    const liveTerminalChat = conversationTab && terminalConversation
      && embeddedTerminal.connected
      && embeddedTerminal.agentSessionId === session.id
      && embeddedTerminal.terminalId === terminalId;
    const transcriptChat = conversationTab && !liveTerminalChat;
    const externallyActive = ["starting", "running", "waiting", "paused"].includes(String(session.status || ""));
    const externalOrigin = !terminalConversation && externallyActive ? originAppInfo(session) : null;
    const snapshot = snapshotSession(session.id);
    const activity = executionMode
      ? (session.executions || []).find(item => item.id === state.drawerExecutionId)
        || (snapshot?.executions || []).find(item => item.id === state.drawerExecutionId)
        || null
      : null;
    // The lightweight snapshot already contains recent conversation rows.
    // Show those immediately while the full history is fetched instead of
    // covering useful content with a blocking loading screen.
    const detailPending = state.detailLoadingIds.has(state.selectedId);
    const detailLoading = detailPending && !state.details.has(state.selectedId) && !snapshot;
    const detailPreviewing = detailPending && !state.details.has(state.selectedId) && Boolean(snapshot);
    const drawer = $("#detailDrawer");
    drawer.dataset.mode = executionMode ? "execution" : subagentMode ? "subagent" : "session";
    drawer.dataset.conversationShell = conversationTab ? "terminal" : "standard";
    drawer.dataset.terminalChat = liveTerminalChat ? "true" : "false";
    drawer.dataset.conversationSurface = conversationTab ? (liveTerminalChat ? "pty" : "transcript") : "standard";
    drawer.style.setProperty("--drawer-provider", provider.accent);
    $("#drawerProviderMark").style.setProperty("--provider", provider.accent);
    $("#drawerProviderMark").textContent = executionMode && activity?.kind === "shell" ? ">_" : provider.mark;
    $("#drawerProvider").textContent = state.drawerPresentation !== "modal" && !executionMode
      ? `${t("drawer.agent_flow")} · ${presentationLabel}`
      : executionMode
      ? `${activity?.runtime || activity?.tool || t("drawer.execution_unit")} · ${activity ? context.executionActivityStatus(activity) : t("drawer.unknown")}`
      : subagentMode
      ? `${t("control.subagent")} · ${presentationLabel}`
      : `${provider.company} · ${presentationLabel}`;
    const rawDrawerTitle = executionMode
      ? context.inferredExecutionSummary(activity || {}).text
      : subagentMode ? session.title || session.taskName || (session.delegation && session.delegation.taskName) : session.title;
    const drawerTitle = readablePreview(rawDrawerTitle || t("drawer.title"), 120);
    $("#drawerTitle").textContent = drawerTitle.text || t("drawer.title");
    $("#drawerTitle").title = drawerTitle.full || drawerTitle.text || t("drawer.title");
    const stopping = session.runId && state.stopRequests.has(session.runId);
    const stop =
      session.runId && (session.status === "running" || session.status === "starting")
        ? `<button type="button" class="meta-chip stop-run" data-stop-run="${esc(session.runId)}"
          ${stopping ? 'disabled aria-busy="true"' : ""}>
          ${esc(t(stopping ? "drawer.stop_requested" : "drawer.stop_run"))}</button>`
        : "";
    const reset = `<button type="button" class="meta-chip session-reset-button" data-session-reset="${esc(session.id)}"
      aria-label="${esc(t("session.reset"))}" title="${esc(t("session.reset_help"))}">↻ <b>${esc(t("session.reset"))}</b></button>`;
    const runtime = session.runtimePresence || [];
    const resume =
      !isLiveSession(session) && agentResumeSupport(session).supported
        ? `<button type="button" class="meta-chip resume-agent" data-resume-agent="${esc(session.id)}">▶
          <b>${esc(t(originAppInfo(session) ? "drawer.continue_background_terminal" : "drawer.resume_in_terminal"))}</b>
        </button>`
        : "";
    const originPath = sessionOriginPath(session);
    const copyWorkspace = !isProjectlessSession(session) && originPath
      ? `<button type="button" class="meta-chip meta-copy origin-project-meta" data-copy-text="${esc(originPath)}" aria-label="${esc(t("quality.copy_workspace"))}">${esc(t("project.origin"))} <b>${esc(sessionWorkspaceLabel(session))}</b><span aria-hidden="true">⧉</span></button>`
      : "";
    $("#drawerMeta").innerHTML = executionMode
      ? `<span class="meta-chip work-state ${activity?.status === "running" ? "working" : "resting"}"><b>${esc(activity ? context.executionActivityStatus(activity) : t("drawer.unknown"))}</b></span>
        <span class="meta-chip">${esc(session.parentId ? t("control.subagent") : t("control.main_agent"))} <b>${esc(session.agentName || provider.label)}</b></span>
        ${activity?.backgroundId ? `<span class="meta-chip">${esc(t("graph.execution_handle"))} <b>${esc(activity.backgroundId)}</b></span>` : ""}`
      : subagentMode
      ? `<span class="meta-chip work-state ${subagentWorkState(session)}">
        <b>${esc(subagentWorkLabel(session))}</b>
        </span>
        <span class="meta-chip">${esc(t("drawer.model"))} <b>${esc(session.model || t("drawer.unknown"))}</b></span>${resume}`
      : `<span class="meta-chip">${esc(t("drawer.model"))} <b>${esc(session.model || t("drawer.unknown"))}</b>
        </span>
        ${copyWorkspace || `<span class="meta-chip origin-project-meta">${esc(t("project.origin"))} <b>${esc(sessionWorkspaceLabel(session))}</b></span>`}
        ${
          session.parentId
            ? `<span class="meta-chip">⑂ <b>${esc(t("drawer.helper_ai"))}</b>
        </span>`
            : ""
        }${
          runtime.length
            ? `<span class="meta-chip runtime-meta">● <b>${esc(t("session.running_programs", { count: runtime.length }))}</b>
        </span>`
            : ""
        }${resume}${stop}${reset}`;
    $$(".drawer-tab").forEach((tab) => {
      const hidden = (subagentMode || executionMode) && tab.dataset.tab !== "chat";
      tab.classList.toggle("hidden", hidden);
      const shortLabel = t({
        summary: "drawer.tab_summary_short",
        chat: "drawer.tab_chat_short",
        lifecycle: "drawer.tab_progress_short",
        tokens: "drawer.tab_usage_short",
      }[tab.dataset.tab]);
      const fullLabel = tab.dataset.tab === "chat"
        ? executionMode ? t("drawer.execution_process") : subagentMode ? t("drawer.work_content") : t("ui.conversation")
        : t({
            summary: "management.summary",
            lifecycle: "ui.progress",
            tokens: "ui.usage",
          }[tab.dataset.tab]);
      tab.textContent = executionMode || subagentMode ? fullLabel : shortLabel;
      tab.setAttribute("aria-label", fullLabel);
      tab.setAttribute("aria-controls", tab.dataset.tab === "chat" && liveTerminalChat ? "drawerTerminalSurface" : "drawerContent");
      const active = tab.dataset.tab === state.drawerTab;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    });
    const activeTab = $(`.drawer-tab[data-tab="${state.drawerTab}"]`);
    const content = $("#drawerContent");
    const terminalSurface = $("#drawerTerminalSurface");
    content.classList.toggle("hidden", liveTerminalChat);
    terminalSurface.classList.toggle("hidden", !liveTerminalChat);
    terminalSurface.setAttribute("aria-hidden", liveTerminalChat ? "false" : "true");
    if (!conversationTab || !terminalConversation) window.LoadToAgentDrawerTerminal?.unmount?.();
    if (liveTerminalChat) {
      content.removeAttribute("aria-label");
      content.removeAttribute("aria-labelledby");
      terminalSurface.setAttribute("aria-labelledby", "drawerTabChat");
    } else if (subagentMode && state.drawerPresentation === "context") {
      content.removeAttribute("aria-labelledby");
      content.setAttribute("aria-label", t("control.subagent_conversation"));
    } else {
      content.removeAttribute("aria-label");
      if (activeTab) content.setAttribute("aria-labelledby", activeTab.id);
    }
    rememberDisclosureStates(content);
    const previousTop = content.scrollTop;
    const wasAtBottom = window.LoadToAgentRendererUtils.isScrolledToEnd(content);
    const renderKey = `${state.drawerMode}:${state.selectedId}:${state.drawerTab}:${detailLoading ? "loading" : "ready"}`;
    const previousRenderKey = motionState.drawerRenderKey;
    const shouldAnimateContent = previousRenderKey !== renderKey;
    const tabChanged = Boolean(motionState.drawerTab) && motionState.drawerTab !== state.drawerTab;
    motionState.drawerRenderKey = renderKey;
    motionState.drawerTab = state.drawerTab;
    const detailError = state.detailErrors.get(state.selectedId);
    let nextContentHtml = liveTerminalChat
      ? ""
      : detailLoading
      ? `<div class="drawer-loading"><span></span><b>${esc(t("drawer.loading_history"))}</b><small>${esc(t("drawer.loading_history_help"))}</small></div>`
      : detailError
        ? `<div class="drawer-error">
        <b>${esc(t("drawer.history_failed"))}</b>
        <span>${esc(detailError)}</span>
        <button type="button" data-retry-detail="${esc(state.selectedId)}">${esc(t("drawer.retry"))}</button>
        </div>`
        : executionMode
          ? executionActivityDetailHtml(session, activity)
        : subagentMode
          ? subagentConversationHtml(session)
          : state.drawerTab === "summary"
            ? outcomeHtml(session)
            : state.drawerTab === "chat"
            ? chatHtml(session)
            : state.drawerTab === "lifecycle"
              ? lifecycleHtml(session)
              : tokensHtml(session);
    if (transcriptChat && externalOrigin && !detailLoading && !detailError) {
      nextContentHtml = `<aside class="drawer-external-session-note" role="status">
        <span aria-hidden="true">↗</span><div><b>${esc(t("drawer.external_session_running", { provider: externalOrigin.provider }))}</b>
        <small>${esc(t("drawer.external_session_running_help"))}</small></div>
      </aside>${nextContentHtml}`;
    }
    if (!liveTerminalChat && detailPreviewing && !detailError) {
      nextContentHtml = `<div class="drawer-history-refreshing" role="status">
        <span aria-hidden="true"></span><small>${esc(t("drawer.loading_history_inline"))}</small>
      </div>${nextContentHtml}`;
    }
    if (transcriptChat) {
      const transcriptTone = ["starting", "running"].includes(presentationStatus)
        ? "connected"
        : ["waiting", "paused"].includes(presentationStatus)
          ? "attention"
          : presentationStatus === "failed"
            ? "error"
            : presentationStatus === "cancelled"
              ? "unavailable"
              : "history";
      const transcriptMeta = externalOrigin?.provider
        ? `${presentationLabel} · ${externalOrigin.provider}`
        : presentationLabel;
      nextContentHtml = `<section class="drawer-terminal-transcript" data-transcript-session="${esc(session.id)}">
        <header class="drawer-terminal-statusbar drawer-transcript-statusbar" data-tone="${esc(transcriptTone)}">
          <span class="drawer-terminal-connection"><i aria-hidden="true"></i><span class="drawer-terminal-prompt" aria-hidden="true">›_</span>
          <b>${esc(t("drawer.conversation"))}</b><small>${esc(transcriptMeta)}</small></span>
        </header>
        <div class="drawer-terminal-transcript-body">${nextContentHtml}</div>
      </section>`;
    }
    if (motionState.drawerContentHtml !== nextContentHtml) {
      content.innerHTML = nextContentHtml;
      motionState.drawerContentHtml = nextContentHtml;
    }
    const composer = $("#drawerComposer");
    composer.dataset.mode = liveTerminalChat ? "terminal" : "conversation";
    const showComposer = !session.parentId
      && !executionMode
      && conversationTab
      && typeof agentCommandComposer === "function"
      && (liveTerminalChat || (!detailLoading && !detailError));
    composer.classList.toggle("hidden", !showComposer);
    const nextComposerHtml = showComposer ? agentCommandComposer(session, {
      conversation: true,
      terminal: liveTerminalChat,
      terminalStyle: conversationTab,
      delivery,
      deliveryLabel: delivery ? t(deliveryLabelKey(delivery.phase)) : "",
    }) : "";
    const focusedDraft = document.activeElement?.matches?.("[data-agent-command-draft]")
      && composer.contains(document.activeElement)
      && document.activeElement.dataset.agentCommandDraft === session.id;
    // Session snapshots arrive while the user is typing. Replacing the
    // composer would destroy the focused textarea and its IME/caret state.
    // Keep that exact node alive until focus leaves it; the delegated input
    // handler already mirrors the current draft into state.
    const currentInputMode = composer.querySelector("[data-agent-command-form]")?.dataset.agentCommandInputModeSelected || "";
    const nextInputMode = liveTerminalChat ? "terminal" : "conversation";
    if (focusedDraft && currentInputMode !== nextInputMode && reconcileFocusedComposer(composer, nextComposerHtml, session.id)) {
      motionState.drawerComposerHtml = nextComposerHtml;
    } else if (!focusedDraft && motionState.drawerComposerHtml !== nextComposerHtml) {
      composer.innerHTML = nextComposerHtml;
      motionState.drawerComposerHtml = nextComposerHtml;
    } else if (!showComposer && composer.innerHTML) {
      composer.innerHTML = "";
      motionState.drawerComposerHtml = "";
    }
    // A snapshot may change delivery state while the textarea keeps focus.
    // Update the stable interrupt control in place so preserving IME/caret
    // state never delays the user's ability to stop the current AI turn.
    const interruptButton = composer.querySelector(`[data-conversation-interrupt="${CSS.escape(session.id)}"]`);
    if (interruptButton) {
      const interrupting = state.conversationInterruptRequests.has(session.id);
      const interruptible = Boolean(delivery?.entry?.target)
        && ["confirming", "delayed", "received", "responding"].includes(delivery?.phase);
      interruptButton.hidden = !interruptible && !interrupting;
      interruptButton.disabled = !interruptible || interrupting;
      interruptButton.toggleAttribute("aria-busy", interrupting);
      const interruptLabel = t(interrupting ? "agent.stopping_response" : "agent.stop_response");
      interruptButton.setAttribute("aria-label", interruptLabel);
      interruptButton.setAttribute("title", interruptLabel);
      const interruptIcon = interruptButton.querySelector(".conversation-interrupt-icon");
      const interruptVisibleLabel = interruptButton.querySelector(".conversation-interrupt-label");
      if (interruptIcon) interruptIcon.textContent = interrupting ? "…" : "";
      if (interruptVisibleLabel) interruptVisibleLabel.textContent = t(interrupting ? "agent.stopping_short" : "agent.stop_short");
    }
    if (conversationTab && terminalConversation) window.LoadToAgentDrawerTerminal?.mount?.(session, { targetId: terminalTarget.id });
    restoreDisclosureStates(content);
    content.classList.toggle("motion-content-in", shouldAnimateContent && !motionPreference.matches);
    clearTimeout(motionState.drawerContentTimer);
    if (shouldAnimateContent)
      motionState.drawerContentTimer = setTimeout(() => content.classList.remove("motion-content-in"), motionPreference.matches ? 0 : 520);
    if (!detailLoading && !liveTerminalChat) {
      if (tabChanged) {
        content.scrollTop = 0;
        state.drawerForceLatest = false;
      } else {
        const scrollGeneration = (motionState.drawerScrollGeneration || 0) + 1;
        motionState.drawerScrollGeneration = scrollGeneration;
        requestAnimationFrame(() => {
          if (motionState.drawerScrollGeneration !== scrollGeneration) return;
          const forceLatest = state.drawerForceLatest;
          if (state.drawerTab === "chat" && forceLatest) {
            if (subagentMode || executionMode) content.scrollTop = 0;
            else {
              const rows = [...content.querySelectorAll(".chat-row")];
              const latest = rows[rows.length - 1];
              if (latest && latest.offsetHeight > content.clientHeight - 90) {
                const contentTop = content.getBoundingClientRect().top;
                const stickyHeight = content.querySelector(".chat-history-head")?.getBoundingClientRect().height || 0;
                content.scrollTop = Math.max(0, content.scrollTop + latest.getBoundingClientRect().top - contentTop - stickyHeight - 12);
              } else content.scrollTop = content.scrollHeight;
            }
          } else if (state.drawerTab === "chat" && wasAtBottom) content.scrollTop = content.scrollHeight;
          else content.scrollTop = Math.min(previousTop, Math.max(0, content.scrollHeight - content.clientHeight));
          state.drawerForceLatest = false;
        });
      }
    }
  }

  return {
    openDrawer,
    openSubagentConversation,
    openExecutionActivity,
    closeDrawer,
    backToAgentFlow,
    renderDrawer,
  };
};
