"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createAgentActions = function createAgentActions(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const errorText = (error, key, params) => window.LoadToAgentI18n.errorText(error, key, params);
  const {
    $,
    esc,
    state,
    selectView,
    providerInfo,
    isLiveSession,
    conversationMessageKey,
  } = context;

  function emitTerminalDelivery(sessionId, deliveryState, target = null) {
    if (typeof window.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
    window.dispatchEvent(new CustomEvent("loadtoagent:terminal-command-delivery", {
      detail: { sessionId, target, deliveryState },
    }));
  }

  function agentCommandTargets(session) {
    try {
      return window.LoadToAgentTerminal && typeof window.LoadToAgentTerminal.agentTargets === "function"
        ? window.LoadToAgentTerminal.agentTargets(session)
        : [];
    } catch (error) {
      window.LoadToAgentRendererUtils.reportRecoverableError("agent-command-targets", error);
      return [];
    }
  }

  function agentResumeSupport(session) {
    try {
      return window.LoadToAgentTerminal && typeof window.LoadToAgentTerminal.resumeSupport === "function"
        ? window.LoadToAgentTerminal.resumeSupport(session)
        : { supported: false, reason: t("agent.resume_preparing") };
    } catch (error) {
      return { supported: false, reason: errorText(error, "agent.resume_check_failed") };
    }
  }

  function originAppInfo(session) {
    if (session && session.provider === "codex" && session.clientKind === "codex-desktop") {
      return { provider: "Codex", label: t("agent.desktop_app", { provider: "Codex" }) };
    }
    if (session && session.provider === "claude" && session.clientKind === "claude-desktop") {
      return { provider: "Claude", label: t("agent.desktop_app", { provider: "Claude" }) };
    }
    return null;
  }

  function agentCommandRouteOptions(session) {
    if (!session?.parentId) return [];
    let parent = snapshotSession(session.parentId) || state.details.get(session.parentId) || null;
    const visited = new Set([session.id]);
    while (parent?.parentId && !visited.has(parent.id)) {
      visited.add(parent.id);
      parent = snapshotSession(parent.parentId) || state.details.get(parent.parentId) || parent;
    }
    const directTargets = isLiveSession(session) ? agentCommandTargets(session) : [];
    const parentTargets = parent ? agentCommandTargets(parent) : [];
    return [
      { id: "direct", label: t("agent.route_direct"), available: directTargets.length > 0, targetSession: session, targets: directTargets },
      { id: "parent", label: t("agent.route_parent"), available: Boolean(parent && (parentTargets.length || agentResumeSupport(parent).supported)), targetSession: parent, targets: parentTargets },
    ];
  }

  function selectedAgentCommandRoute(session) {
    if (!session?.parentId) return "direct";
    const options = agentCommandRouteOptions(session);
    const saved = state.agentCommandRoutes.get(session.id);
    if (options.some(option => option.id === saved && option.available)) return saved;
    const selected = options.find(option => option.id === "direct" && option.available)
      || options.find(option => option.id === "parent" && option.available)
      || options.find(option => option.id === "direct");
    const route = selected?.id || "direct";
    state.agentCommandRoutes.set(session.id, route);
    return route;
  }

  function routedAgentCommandContext(session, requestedRoute = "") {
    const route = requestedRoute || selectedAgentCommandRoute(session);
    const options = agentCommandRouteOptions(session);
    const selected = options.find(option => option.id === route) || null;
    return {
      route,
      options,
      targetSession: selected?.targetSession || session,
      targets: selected?.targets || agentCommandTargets(session),
      available: session?.parentId ? Boolean(selected?.available) : true,
    };
  }

  function agentCommandTargetKey(session, route = "direct") {
    return session?.parentId ? `${session.id}:${route}` : session.id;
  }

  function deliveryStateOf(value, fallback = "unknown") {
    if (value?.deliveryState === "rejected") return "rejected";
    if (value?.deliveryState === "accepted") return "accepted";
    if (value?.deliveryState === "unknown") return "unknown";
    return fallback;
  }

  function commandDeliveryMap() {
    if (!state.agentCommandDeliveries || typeof state.agentCommandDeliveries.get !== "function") {
      state.agentCommandDeliveries = new Map();
    }
    return state.agentCommandDeliveries;
  }

  function commandDeliveryKey(sessionId, targetId, command) {
    const normalized = String(command || "").replace(/\r\n?/g, "\n").trim();
    return `${sessionId || ""}\u001f${targetId || ""}\u001f${normalized}`;
  }

  function commandDeliveryId(key) {
    if (!key) return "";
    const deliveries = commandDeliveryMap();
    const existing = deliveries.get(key);
    if (existing?.id && ["prepared", "unknown"].includes(existing.state)) return existing.id;
    const id = `delivery:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
    deliveries.set(key, { id, state: "prepared" });
    while (deliveries.size > 128) deliveries.delete(deliveries.keys().next().value);
    return id;
  }

  function settleCommandDelivery(key, id, deliveryState) {
    if (!key || !id) return;
    const deliveries = commandDeliveryMap();
    if (deliveryState === "unknown") deliveries.set(key, { id, state: "unknown" });
    else deliveries.delete(key);
  }

  function removePendingConversation(sessionId, entry) {
    if (!entry) return;
    clearTimeout(entry.confirmationTimer);
    const remaining = (state.pendingConversationMessages.get(sessionId) || []).filter(item => item !== entry);
    if (remaining.length) state.pendingConversationMessages.set(sessionId, remaining);
    else state.pendingConversationMessages.delete(sessionId);
    context.renderDrawer?.();
  }

  function beginConversationMessage(session, command) {
    const detail = state.details.get(session.id);
    const baselineMessages = [...(session.messages || []), ...(detail?.messages || [])];
    const entry = {
      id: `local:${session.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      deliveryId: `delivery:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`,
      text: command,
      timestamp: new Date().toISOString(),
      status: "sending",
      phase: "sending",
      dispatchedAt: null,
      presented: false,
      baselineMessageKeys: new Set(baselineMessages.map(conversationMessageKey)),
    };
    // Keep the stopped state visible until the user starts the next turn, then
    // retire it so it cannot resurface as the latest delivery after that turn.
    const pending = (state.pendingConversationMessages.get(session.id) || [])
      .filter(item => item?.status !== "interrupted");
    pending.push(entry);
    state.pendingConversationMessages.set(session.id, pending);
    state.drawerForceLatest = true;
    context.renderDrawer?.();
    return entry;
  }

  function updateConversationMessage(sessionId, entry, status, error = "") {
    if (!entry) return;
    entry.status = status;
    entry.error = error;
    if (status === "awaiting") {
      entry.dispatchedAt = entry.dispatchedAt || new Date().toISOString();
      entry.phase = "confirming";
      const delay = Number(window.LoadToAgentConversationDelivery?.CONFIRMATION_DELAY_MS || 60_000);
      clearTimeout(entry.confirmationTimer);
      entry.confirmationTimer = setTimeout(() => {
        entry.confirmationTimer = 0;
        const pending = state.pendingConversationMessages.get(sessionId) || [];
        if (!pending.includes(entry) || entry.status !== "awaiting") return;
        state.drawerForceLatest = true;
        context.render?.();
        context.renderDrawer?.();
      }, delay + 40);
    } else if (status === "uncertain") {
      entry.dispatchedAt = entry.dispatchedAt || new Date().toISOString();
      entry.phase = "uncertain";
      entry.uncertainAt = new Date().toISOString();
      clearTimeout(entry.confirmationTimer);
      entry.confirmationTimer = 0;
    } else if (status === "failed") {
      entry.phase = "failed";
      entry.failedAt = new Date().toISOString();
      clearTimeout(entry.confirmationTimer);
      entry.confirmationTimer = 0;
    }
    state.drawerForceLatest = true;
    context.renderDrawer?.();
  }

  function matchingPendingConversation(sessionId, command) {
    const normalize = window.LoadToAgentConversationDelivery?.normalizedText
      || (value => String(value || "").replace(/\s+/g, " ").trim());
    const expected = normalize(command);
    return (state.pendingConversationMessages.get(sessionId) || []).find(entry =>
      entry
      && !["failed", "interrupted"].includes(entry.status)
      && !["responded", "interrupted"].includes(entry.phase)
      && normalize(entry.text) === expected) || null;
  }

  function agentControlMode(session, targets) {
    // A discovered terminal target is stronger evidence than the transcript's
    // projected status. This also keeps provider-neutral managed terminals
    // writable after their UI attachment has been detached.
    if (targets.length) return "direct";
    const resume = agentResumeSupport(session);
    if (resume.supported) {
      if (originAppInfo(session)) return "origin-resume";
      return isLiveSession(session) ? "handoff" : "resume";
    }
    if (isLiveSession(session)) return "connect";
    return "ended";
  }

  function agentCommandComposer(session, options = {}) {
    const routingEnabled = Boolean(options.conversation && session.parentId);
    const routeContext = routingEnabled
      ? routedAgentCommandContext(session)
      : {
          route: "direct",
          options: [],
          targetSession: session,
          targets: agentCommandTargets(session),
          available: true,
        };
    const { route, targetSession, targets, available: routeAvailable } = routeContext;
    const mode = routingEnabled && !routeAvailable ? "ended" : agentControlMode(targetSession, targets);
    const inputMode = options.terminal ? "terminal" : options.conversation ? "conversation" : "terminal";
    const relayed = routingEnabled && route === "parent" && routeAvailable;
    const targetKey = agentCommandTargetKey(session, route);
    const savedTarget = state.agentCommandTargets.get(targetKey) || "";
    const relayTarget = relayed ? targets.find((target) => target.kind === "terminal") || targets[0] || null : null;
    const automaticTarget = relayTarget || targets.find((item) => item.kind === "terminal") || targets[0] || null;
    const targetId = targets.some((target) => target.id === savedTarget)
      ? savedTarget
      : targets.length === 1
        ? targets[0].id
        : options.conversation ? automaticTarget?.id || "" : "";
    if (targetId) state.agentCommandTargets.set(targetKey, targetId);
    const target = targets.find((item) => item.id === targetId) || null;
    const draft = state.agentCommandDrafts.get(session.id) || "";
    const sending = state.agentCommandSending.has(session.id);
    const interruptEntry = options.conversation ? options.delivery?.entry || null : null;
    const interrupting = state.conversationInterruptRequests.has(session.id);
    const canInterrupt = inputMode === "conversation"
      && Boolean(interruptEntry?.target)
      && ["confirming", "delayed", "received", "responding"].includes(options.delivery?.phase);
    const sendAvailable = ((mode === "direct" && Boolean(target)) || ["resume", "handoff", "origin-resume"].includes(mode)) && !sending;
    const canSend = sendAvailable && (!options.conversation || Boolean(draft.trim()));
    const origin = originAppInfo(targetSession);
    const status = relayed
      ? t("agent.route_parent_status")
      : mode === "direct"
        ? t("agent.direct_status", { target: targets.length === 1 ? target.label : t("agent.choose_terminal_count", { count: targets.length }) })
        : mode === "handoff"
          ? t("agent.handoff_status")
          : mode === "resume"
            ? t("agent.resume_status")
            : mode === "origin-resume"
              ? t("agent.origin_resume_status")
              : mode === "connect"
                ? t("agent.connect_status")
                : window.LoadToAgentI18n.t("ui.ended_session");
    const controlHelp = relayed
      ? t("agent.route_parent_inline_help")
      : mode === "direct"
        ? t("agent.direct_help")
        : mode === "handoff"
          ? t("agent.handoff_help")
          : mode === "resume"
            ? t("agent.resume_help")
            : mode === "origin-resume"
              ? t("agent.origin_resume_help", { provider: (origin && origin.provider) || t("agent.desktop") })
              : mode === "connect"
                ? t("agent.connect_help", { provider: targetSession.provider })
                : agentResumeSupport(targetSession).reason || t("agent.resume_method_unknown");
    const help = options.conversation
      ? inputMode === "terminal"
        ? t("agent.terminal_input_help", { target: target?.label || providerInfo(targetSession.provider).label })
        : t("agent.ai_input_help", { provider: providerInfo(session.provider).label })
      : controlHelp;
    const picker =
      targets.length > 1 && !relayed && (!options.conversation || inputMode === "terminal")
        ? `<label class="agent-command-target">
      <span>${esc(t("agent.target_terminal"))}</span>
      <select data-agent-command-target="${esc(targetKey)}">
      <option value="">${esc(t("agent.choose_terminal"))}</option>
      ${targets.map((item) => `<option value="${esc(item.id)}" ${item.id === targetId ? "selected" : ""}>${esc(item.label)}</option>`).join("")}
      </select>
      </label>`
        : "";
    const submitActionLabel = relayed
      ? t(sending
        ? "agent.sending"
        : inputMode === "terminal" ? "agent.send_terminal" : "agent.send_via_parent")
      : mode === "direct"
        ? t(sending
          ? "agent.sending"
          : inputMode === "terminal" ? "agent.send_terminal" : options.conversation ? "agent.send_request" : "agent.send_now")
        : mode === "resume"
          ? t(sending
            ? "agent.restoring"
            : options.conversation && inputMode === "terminal" ? "agent.send_terminal" : "agent.restore_and_send")
          : mode === "handoff"
            ? t(sending
              ? "agent.handing_off"
              : options.conversation && inputMode === "terminal" ? "agent.send_terminal" : "agent.handoff_and_send")
            : mode === "origin-resume"
              ? t(sending
                ? "agent.connecting"
                : options.conversation && inputMode === "terminal" ? "agent.send_terminal" : "agent.background_and_send")
              : "";
    const submitAction = submitActionLabel
      ? `<button type="submit" ${canSend ? "" : "disabled"}>${esc(submitActionLabel)}</button>`
      : "";
    const actions = !relayed && mode === "connect"
      ? `<button type="button" data-agent-bridge-copy="${esc(targetSession.provider)}">${esc(t("agent.copy_bridge"))}</button>`
      : `${!relayed && mode === "direct" && !options.conversation
        ? `<button type="button" data-agent-terminal-open="${esc(session.id)}" ${canSend ? "" : "disabled"}>${esc(t("agent.open_terminal"))}</button>`
        : ""}${submitAction}`;
    const editable = relayed || ["direct", "resume", "handoff", "origin-resume"].includes(mode);
    const placeholder = editable
      ? t(options.conversation
        ? inputMode === "terminal" ? "agent.terminal_placeholder" : "agent.conversation_placeholder"
        : "agent.command_example")
      : status;
    const availabilityClass = mode === "direct" ? "connected" : ["resume", "handoff", "origin-resume"].includes(mode) ? "resume-ready" : "unavailable";
    const interruptLabel = t(interrupting ? "agent.stopping_response" : "agent.stop_response");
    const interruptAction = options.conversation && inputMode === "conversation"
      ? `<button class="conversation-interrupt" type="button" data-conversation-interrupt="${esc(session.id)}"
          ${canInterrupt && !interrupting ? "" : "disabled"} ${canInterrupt || interrupting ? "" : 'hidden'}
          ${interrupting ? 'aria-busy="true"' : ""} aria-label="${esc(interruptLabel)}" title="${esc(interruptLabel)}">
          <span class="conversation-interrupt-icon" aria-hidden="true">${interrupting ? "…" : ""}</span>
          <span class="conversation-interrupt-label">${esc(t(interrupting ? "agent.stopping_short" : "agent.stop_short"))}</span></button>`
      : "";
    const safeSessionId = String(session.id || "").replace(/[^a-z0-9_-]/gi, "-");
    if (options.conversation) {
      const slashMenuId = `conversation-slash-menu-${safeSessionId}`;
      const conversationActions = submitActionLabel
        ? `<button class="conversation-send" type="submit" ${canSend ? "" : "disabled"}
            ${sending ? 'aria-busy="true"' : ""} aria-label="${esc(submitActionLabel)}" title="${esc(submitActionLabel)}">
            <span class="conversation-send-label">${esc(t(sending ? "agent.sending" : "agent.send_short"))}</span>
            <svg class="conversation-send-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"></path>
            </svg>
          </button>`
        : actions;
      const showDraftCount = draft.length >= 7200;
      return `<div class="conversation-composer-shell mode-conversation">
        <form class="agent-command-panel ${availabilityClass} control-${mode} conversation-composer ${options.terminal ? "terminal-conversation" : ""}"
          data-agent-command-form="${esc(session.id)}" data-agent-command-route-selected="${esc(route)}"
          data-agent-command-input-mode-selected="${esc(inputMode)}" data-agent-command-routing="conversation"
          data-agent-command-provider="${esc(session.provider)}" data-agent-send-available="${sendAvailable ? "true" : "false"}">
          <div class="conversation-slash-menu hidden" id="${esc(slashMenuId)}" data-conversation-slash-menu role="listbox"
            aria-label="${esc(t("terminal.slash.title", { provider: providerInfo(session.provider).label }))}">
            <header>
              <b data-conversation-slash-title></b>
              <small data-conversation-slash-status aria-live="polite"></small>
            </header>
            <div class="conversation-slash-menu-list" data-conversation-slash-list></div>
          </div>
          ${options.terminal ? picker : ""}
          <label class="agent-command-input">
            <span class="sr-only">${esc(t("agent.command_sr"))}</span>
            <textarea data-agent-command-draft="${esc(session.id)}" maxlength="8000" rows="2"
              aria-controls="${esc(slashMenuId)}" aria-expanded="false" aria-autocomplete="list" aria-haspopup="listbox"
              placeholder="${esc(t(options.terminal ? "drawer.terminal_placeholder" : "agent.chat_placeholder"))}" ${editable ? "" : "disabled"}>${editable ? esc(draft) : ""}</textarea>
          </label>
          ${options.terminal ? `<small class="drawer-terminal-input-hint"><span>${esc(t("drawer.terminal_raw_input"))}</span><span>${esc(t("drawer.terminal_shortcuts"))}</span></small>` : ""}
          <div class="agent-command-actions">
            <span class="conversation-draft-count ${showDraftCount ? "" : "hidden"}" data-conversation-draft-count
              aria-live="polite">${esc(t("agent.input_count", { count: draft.length.toLocaleString() }))}</span>
            ${interruptAction}${conversationActions}
          </div>
        </form>
      </div>`;
    }
    const countId = `agent-command-count-${safeSessionId}`;
    const draftLength = draft.length;
    const form = `<form class="agent-command-panel ${availabilityClass} control-${mode}"
      data-agent-command-form="${esc(session.id)}" data-agent-command-route-selected="${esc(route)}"
      data-agent-command-input-mode-selected="${esc(inputMode)}" data-agent-command-routing="session">
      <header>
        <span class="agent-command-icon" aria-hidden="true">›_</span>
        <span><b>${esc(t("agent.command_title"))}</b><small>${esc(status)}</small></span>
        <i class="${mode === "direct" ? "connected" : ""}" aria-hidden="true"></i>
      </header>
      ${picker}
      <label class="agent-command-input">
        <span class="sr-only">${esc(t("agent.command_sr"))}</span>
        <textarea data-agent-command-draft="${esc(session.id)}" maxlength="8000" rows="3"
          aria-describedby="${esc(countId)}" placeholder="${esc(placeholder)}" ${editable ? "" : "disabled"}>${editable ? esc(draft) : ""}</textarea>
        <span class="agent-command-input-count" id="${esc(countId)}" data-agent-command-count aria-live="off">${esc(t("agent.input_count", { count: draftLength.toLocaleString() }))}</span>
      </label>
      <div class="agent-command-actions"><small aria-live="polite">${esc(help)}</small>${actions}</div>
    </form>`;
    return form;
  }

  function snapshotSession(id) {
    return ((state.snapshot && state.snapshot.sessions) || []).find((session) => session.id === id) || null;
  }

  function selectedSession() {
    const detail = state.details.get(state.selectedId) || null;
    const snapshot = snapshotSession(state.selectedId);
    if (!detail) return snapshot;
    if (!snapshot) return detail;

    const detailUpdatedAt = Date.parse(detail.updatedAt || 0);
    const snapshotUpdatedAt = Date.parse(snapshot.updatedAt || 0);
    if (Number.isFinite(detailUpdatedAt) && Number.isFinite(snapshotUpdatedAt) && snapshotUpdatedAt < detailUpdatedAt) {
      return detail;
    }

    // Full-history detail is kept for conversation and lifecycle rendering,
    // but its cached liveness can lag behind the frequently refreshed card.
    // Use the latest observed fields so opening a past record cannot revive an
    // already idle session as "running" while retaining the complete history.
    const selected = { ...detail };
    for (const field of [
      "status", "statusDetail", "statusObserved", "updatedAt", "completedAt", "completionObserved",
      "attention", "outcome", "responseIntent", "runtimePresence", "executions",
    ]) {
      if (Object.prototype.hasOwnProperty.call(snapshot, field)) selected[field] = snapshot[field];
    }
    return selected;
  }

  function chosenAgentCommandTarget(session, requestedRoute = "") {
    const routeContext = routedAgentCommandContext(session, requestedRoute);
    const targets = routeContext.targets;
    const saved = state.agentCommandTargets.get(agentCommandTargetKey(session, routeContext.route)) || "";
    if (saved) return targets.find((target) => target.id === saved) || null;
    return targets.length === 1 ? targets[0] : null;
  }

  async function resumeAgentTerminal(sessionId, sendDraft = false) {
    if (state.agentCommandSending.has(sessionId)) return;
    const session = snapshotSession(sessionId) || state.details.get(sessionId);
    if (!session || !window.LoadToAgentTerminal) return context.toast(t("agent.session_not_found"));
    const support = agentResumeSupport(session);
    if (!support.supported) return context.toast(support.reason || t("agent.cannot_reconnect"));
    state.agentCommandSending.add(sessionId);
    try {
      if ($("#detailDrawer").classList.contains("open")) context.closeDrawer(false);
      selectView("terminal");
      const draft = state.agentCommandDrafts.get(sessionId) || "";
      const deliveryKey = sendDraft && draft.trim()
        ? commandDeliveryKey(sessionId, "resume", draft)
        : "";
      const deliveryId = commandDeliveryId(deliveryKey);
      let resumed = null;
      try {
        resumed = await window.LoadToAgentTerminal.resumeForAgent(session, draft, sendDraft, { deliveryId });
      } catch (error) {
        if (sendDraft && deliveryStateOf(error) === "rejected") {
          settleCommandDelivery(deliveryKey, deliveryId, "rejected");
          context.toast(t("agent.delivery_retry_ready"));
          return;
        }
        if (sendDraft) settleCommandDelivery(deliveryKey, deliveryId, "unknown");
        context.toast(t(sendDraft ? "agent.delivery_uncertain" : "agent.reconnect_failed"));
        return;
      }
      if (sendDraft && resumed?.deliveryState === "unknown") {
        settleCommandDelivery(deliveryKey, deliveryId, "unknown");
        context.toast(t("agent.delivery_uncertain"));
        return;
      }
      if (sendDraft) settleCommandDelivery(deliveryKey, deliveryId, "accepted");
      if (sendDraft && draft.trim()) state.agentCommandDrafts.delete(sessionId);
      try {
        document.querySelector(".main-stage")?.scrollTo({ top: 0, behavior: "auto" });
      } catch (error) {
        window.LoadToAgentRendererUtils.reportRecoverableError("agent-resume-post-delivery", error);
      }
      context.toast(t("agent.reconnected", { provider: providerInfo(session.provider).label }));
    } finally {
      state.agentCommandSending.delete(sessionId);
    }
  }

  async function dispatchAgentCommand(sessionId, form) {
    if (state.agentCommandSending.has(sessionId)) return;
    const session = snapshotSession(sessionId);
    if (!session || !window.LoadToAgentTerminal) return context.toast(t("agent.latest_not_found"));
    const drawerSubmission = form?.dataset.agentCommandRouting === "conversation";
    const inputMode = drawerSubmission ? form?.dataset.agentCommandInputModeSelected || "conversation" : "terminal";
    let conversationSubmission = drawerSubmission && inputMode === "conversation";
    const routingEnabled = drawerSubmission && Boolean(session.parentId);
    const requestedRoute = routingEnabled ? form?.dataset.agentCommandRouteSelected || selectedAgentCommandRoute(session) : "direct";
    const routeContext = routingEnabled
      ? routedAgentCommandContext(session, requestedRoute)
      : { route: "direct", targetSession: session, targets: agentCommandTargets(session), available: true };
    const targetSession = routeContext.targetSession;
    const mode = routingEnabled && !routeContext.available ? "ended" : agentControlMode(targetSession, routeContext.targets);
    if (routingEnabled && !["direct", "resume", "handoff", "origin-resume"].includes(mode)) return context.toast(t("agent.route_unavailable"));
    const input = form.querySelector("[data-agent-command-draft]");
    const command = String((input && input.value) || "").trim();
    const nativeCommand = /^(?:\/|!)(?:\S|$)/.test(command);
    if (nativeCommand) conversationSubmission = false;
    if (conversationSubmission && command && matchingPendingConversation(sessionId, command)) {
      return context.toast(t("agent.command_already_pending"));
    }
    const routedCommand = conversationSubmission && routingEnabled && routeContext.route === "parent" && !nativeCommand
      ? t("agent.route_via_parent_prompt", {
          task: session.delegation?.taskName || session.taskName || session.agentName || session.title,
          message: command,
        })
      : command;
    if (mode === "resume" || mode === "handoff" || mode === "origin-resume") {
      if (input) state.agentCommandDrafts.set(sessionId, input.value);
      if (!command) return context.toast(t("agent.enter_command"));
      if (drawerSubmission) {
        state.agentCommandSending.add(sessionId);
        const pendingMessage = conversationSubmission ? beginConversationMessage(session, command) : null;
        const deliveryKey = pendingMessage ? "" : commandDeliveryKey(targetSession.id, `resume:${mode}`, routedCommand);
        const deliveryId = pendingMessage?.deliveryId || commandDeliveryId(deliveryKey);
        try {
          let resumedTarget = null;
          let transportError = null;
          try {
            resumedTarget = await window.LoadToAgentTerminal.resumeForAgent(targetSession, routedCommand, true, { focus: false, deliveryId });
          } catch (error) {
            transportError = error;
          }
          if (pendingMessage && resumedTarget) pendingMessage.target = resumedTarget;
          const deliveryState = transportError
            ? deliveryStateOf(transportError)
            : deliveryStateOf(resumedTarget, "accepted");
          if (deliveryState === "rejected") {
            if (inputMode === "terminal") emitTerminalDelivery(sessionId, "rejected", resumedTarget);
            settleCommandDelivery(deliveryKey, deliveryId, "rejected");
            removePendingConversation(sessionId, pendingMessage);
            context.toast(t("agent.delivery_retry_ready"));
            return;
          }
          if (transportError || resumedTarget?.deliveryState === "unknown") {
            if (inputMode === "terminal") emitTerminalDelivery(sessionId, "unknown", resumedTarget);
            settleCommandDelivery(deliveryKey, deliveryId, "unknown");
            updateConversationMessage(
              sessionId,
              pendingMessage,
              "uncertain",
              transportError ? errorText(transportError, "agent.delivery_uncertain") : t("agent.delivery_uncertain"),
            );
            context.toast(t("agent.delivery_uncertain"));
            return;
          }
          settleCommandDelivery(deliveryKey, deliveryId, "accepted");
          state.agentCommandDrafts.delete(sessionId);
          if (input) input.value = "";
          updateConversationMessage(sessionId, pendingMessage, "awaiting");
          if (nativeCommand) {
            context.toast(t("agent.native_command_sent"));
            return;
          }
          context.toast(t(routingEnabled && routeContext.route === "parent"
            ? "agent.command_routed_via_parent"
            : inputMode === "terminal" ? "agent.terminal_command_sent_background" : "agent.command_sent_background"));
        } finally {
          state.agentCommandSending.delete(sessionId);
          context.renderDrawer?.();
        }
        return;
      }
      return resumeAgentTerminal(sessionId, true);
    }
    const savedTarget = state.agentCommandTargets.get(agentCommandTargetKey(session, routeContext.route)) || "";
    const target = savedTarget
      ? routeContext.targets.find((item) => item.id === savedTarget) || null
      : routeContext.targets.length === 1 ? routeContext.targets[0] : null;
    if (!target)
      return context.toast(t(agentCommandTargets(session).length ? "agent.select_target_first" : "agent.no_writable_terminal"));
    if (!command) return context.toast(t("agent.enter_command"));
    state.agentCommandSending.add(sessionId);
    if (input) state.agentCommandDrafts.set(sessionId, input.value);
    const pendingMessage = conversationSubmission ? beginConversationMessage(session, command) : null;
    if (pendingMessage) pendingMessage.target = target;
    const deliveryKey = pendingMessage ? "" : commandDeliveryKey(targetSession.id, target.id, routedCommand);
    const deliveryId = pendingMessage?.deliveryId || commandDeliveryId(deliveryKey);
    const submit = form.querySelector('[type="submit"]');
    if (submit) {
      submit.disabled = true;
      const sendingLabel = t("agent.sending");
      const visibleLabel = submit.querySelector(".conversation-send-label");
      if (visibleLabel) {
        visibleLabel.textContent = sendingLabel;
        submit.setAttribute("aria-label", sendingLabel);
        submit.setAttribute("title", sendingLabel);
        submit.setAttribute("aria-busy", "true");
      } else {
        submit.textContent = sendingLabel;
      }
    }
    try {
      let dispatched = null;
      let transportError = null;
      try {
        dispatched = await window.LoadToAgentTerminal.dispatchAgentCommand(targetSession, routedCommand, target.id, { deliveryId });
      } catch (error) {
        transportError = error;
      }

      if (transportError && target.kind !== "tmux") {
        const latest = snapshotSession(targetSession.id) || targetSession;
        const support = agentResumeSupport(latest);
        const shouldRecover = support.supported
          && (drawerSubmission || !agentCommandTargets(latest).length);
        if (shouldRecover) {
          state.agentCommandDrafts.set(sessionId, command);
          try {
            dispatched = await window.LoadToAgentTerminal.resumeForAgent(
              latest,
              routedCommand,
              true,
              { focus: drawerSubmission ? false : true, deliveryId },
            );
            transportError = null;
          } catch (resumeError) {
            transportError = resumeError;
          }
        }
      }

      const deliveryState = transportError
        ? deliveryStateOf(transportError)
        : deliveryStateOf(dispatched, "accepted");
      if (deliveryState === "rejected") {
        if (inputMode === "terminal") emitTerminalDelivery(sessionId, "rejected", dispatched?.target || dispatched || target);
        settleCommandDelivery(deliveryKey, deliveryId, "rejected");
        removePendingConversation(sessionId, pendingMessage);
        context.toast(t("agent.delivery_retry_ready"));
        return;
      }
      if (transportError || dispatched?.deliveryState === "unknown") {
        if (inputMode === "terminal") emitTerminalDelivery(sessionId, "unknown", dispatched?.target || dispatched || target);
        settleCommandDelivery(deliveryKey, deliveryId, "unknown");
        updateConversationMessage(
          sessionId,
          pendingMessage,
          "uncertain",
          transportError ? errorText(transportError, "agent.delivery_uncertain") : t("agent.delivery_uncertain"),
        );
        context.toast(t("agent.delivery_uncertain"));
        return;
      }

      settleCommandDelivery(deliveryKey, deliveryId, "accepted");
      if (pendingMessage) pendingMessage.target = dispatched?.target || dispatched || target;
      state.agentCommandDrafts.delete(sessionId);
      if (input) input.value = "";
      updateConversationMessage(sessionId, pendingMessage, "awaiting");
      if (nativeCommand) {
        context.toast(t("agent.native_command_sent"));
        return;
      }
      context.toast(t(dispatched?.reused && transportError === null
        ? "agent.recovered_and_sent"
        : routingEnabled && routeContext.route === "parent"
          ? "agent.command_routed_via_parent"
          : inputMode === "terminal" ? "agent.terminal_command_sent" : "agent.command_sent", { target: target.label }));
    } finally {
      state.agentCommandSending.delete(sessionId);
      if (drawerSubmission) context.renderDrawer?.();
      if (submit && submit.isConnected) {
        const restoredLabel = t(routingEnabled && routeContext.route === "parent"
          ? "agent.send_via_parent"
          : inputMode === "terminal" ? "agent.send_terminal" : drawerSubmission ? "agent.send_request" : "agent.send_now");
        const visibleLabel = submit.querySelector(".conversation-send-label");
        if (visibleLabel) {
          submit.disabled = !String(input?.value || "").trim();
          visibleLabel.textContent = t("agent.send_short");
          submit.setAttribute("aria-label", restoredLabel);
          submit.setAttribute("title", restoredLabel);
          submit.removeAttribute("aria-busy");
        } else {
          submit.disabled = false;
          submit.textContent = restoredLabel;
        }
      }
    }
  }

  async function resetAgentSession(sessionId) {
    if (state.agentCommandSending.has(sessionId)) return;
    const session = snapshotSession(sessionId) || state.details.get(sessionId);
    if (!session || !window.LoadToAgentTerminal?.resetForAgent) return context.toast(t("agent.session_not_found"));
    state.agentCommandSending.add(sessionId);
    try {
      if ($("#detailDrawer").classList.contains("open")) context.closeDrawer(false);
      selectView("terminal");
      await window.LoadToAgentTerminal.resetForAgent(session);
      document.querySelector(".main-stage")?.scrollTo({ top: 0, behavior: "auto" });
      context.toast(t("session.reset_complete"));
    } catch (error) {
      context.toast(errorText(error, "session.reset_failed"));
    } finally {
      state.agentCommandSending.delete(sessionId);
    }
  }

  async function interruptConversation(sessionId) {
    if (state.conversationInterruptRequests.has(sessionId)) return;
    const entries = state.pendingConversationMessages.get(sessionId) || [];
    const entry = [...entries].reverse().find(item =>
      item?.target
      && !["failed", "interrupted"].includes(item.status)
      && !["responded", "interrupted"].includes(item.phase));
    if (!entry || typeof window.LoadToAgentTerminal?.interruptAgent !== "function") {
      return context.toast(t("agent.no_active_response"));
    }
    state.conversationInterruptRequests.add(sessionId);
    context.renderDrawer?.();
    try {
      await window.LoadToAgentTerminal.interruptAgent(entry.target);
      entry.status = "interrupted";
      entry.phase = "interrupted";
      entry.interruptedAt = new Date().toISOString();
      clearTimeout(entry.confirmationTimer);
      entry.confirmationTimer = 0;
      state.drawerForceLatest = true;
      context.toast(t("agent.response_stopped"));
    } catch (error) {
      context.toast(errorText(error, "agent.interrupt_failed"));
    } finally {
      state.conversationInterruptRequests.delete(sessionId);
      context.render?.();
      context.renderDrawer?.();
    }
  }

  async function openAgentTerminal(sessionId) {
    const session = snapshotSession(sessionId);
    if (!session || !window.LoadToAgentTerminal) return context.toast(t("agent.terminal_info_not_found"));
    const routeContext = routedAgentCommandContext(session);
    const target = chosenAgentCommandTarget(session, routeContext.route);
    if (!target)
      return context.toast(t(routeContext.targets.length ? "agent.select_open_target" : "agent.no_writable_terminal"));
    if ($("#detailDrawer").classList.contains("open")) context.closeDrawer?.(false);
    selectView(target.kind === "tmux" ? "tmux" : "terminal");
    try {
      await window.LoadToAgentTerminal.openForAgent(routeContext.targetSession, target.id, state.agentCommandDrafts.get(sessionId) || "");
      document.querySelector(".main-stage")?.scrollTo({ top: 0, behavior: "auto" });
    } catch (error) {
      context.toast(errorText(error, "agent.open_terminal_failed"));
    }
  }

  async function copyBridgeCommand(provider) {
    try {
      const result = await window.loadtoagent.bridgeCommand(provider);
      if (!result || !result.ok) throw new Error(t("agent.bridge_create_failed"));
      const command = result.command;
      await window.loadtoagent.writeClipboard(command);
      context.toast(t("agent.command_copied", { command }));
    } catch (error) {
      context.toast(errorText(error, "agent.bridge_copy_failed"));
    }
  }

  async function controlManagedRun(sessionId, action) {
    const session = snapshotSession(sessionId) || state.details.get(sessionId);
    const runId = session && session.runId;
    const key = `${runId || sessionId}:${action}`;
    if (!session || !runId || state.runControlRequests.has(key)) return;
    const methods = {
      stop: "stopAgent",
      pause: "pauseAgent",
      resume: "resumeAgentRun",
      retry: "retryAgent",
    };
    const method = methods[action];
    if (!method || typeof window.loadtoagent?.[method] !== "function") return context.toast(t("management.control_unavailable"));
    state.runControlRequests.add(key);
    if (action === "stop") state.stopRequests.add(runId);
    context.renderDrawer?.();
    try {
      const result = await window.loadtoagent[method](runId);
      if (!result || result.ok === false) throw new Error(result && result.error || t("management.control_failed"));
      context.toast(t(`management.control_${action}_sent`));
    } catch (error) {
      context.toast(errorText(error, "management.control_failed"));
    } finally {
      state.runControlRequests.delete(key);
      state.stopRequests.delete(runId);
      if (state.selectedId) context.renderDrawer?.();
    }
  }

  function quickRespond(sessionId, value, root = document) {
    const command = String(value || "").trim();
    if (!command) return;
    state.agentCommandDrafts.set(sessionId, command);
    const form = root.querySelector?.(`[data-agent-command-form="${CSS.escape(sessionId)}"]`);
    const input = form?.querySelector("[data-agent-command-draft]");
    if (input) input.value = command;
    if (form) form.requestSubmit();
    else {
      state.drawerTab = "summary";
      context.openDrawer?.(sessionId);
    }
  }

  function prepareReassignment(sessionId) {
    const session = snapshotSession(sessionId) || state.details.get(sessionId);
    if (!session) return context.toast(t("agent.session_not_found"));
    const provider = (context.visibleProviders?.() || state.providers)
      .find(item => item.id !== session.provider && state.availability[item.id]);
    if (!provider) return context.toast(t("management.reassign_unavailable"));
    state.runProvider = provider.id;
    context.closeDrawer?.(false);
    if (context.openRunModal?.() === false) return;
    const request = session.sharedGoal
      || session.delegation?.assignment
      || [...(session.messages || [])].find(message => message.role === "user" && message.text)?.text
      || session.title;
    const task = request && request !== session.title ? `${session.title}\n\n${request}` : (request || session.title);
    const prompt = t("management.reassign_prompt", { task, provider: providerInfo(session.provider).label });
    const promptInput = $("#runPrompt");
    const cwdInput = $("#runCwd");
    if (promptInput) promptInput.value = prompt;
    if (cwdInput && session.cwd && !cwdInput.readOnly) cwdInput.value = session.cwd;
    $("#runProviderPicker") && ($("#runProviderPicker").innerHTML = context.providerPickerHtml?.() || "");
    context.syncRunComposer?.();
    promptInput?.focus({ preventScroll: true });
  }

  return {
    agentCommandTargets,
    agentResumeSupport,
    originAppInfo,
    updateConversationMessage,
    agentControlMode,
    agentCommandRouteOptions,
    selectedAgentCommandRoute,
    routedAgentCommandContext,
    agentCommandComposer,
    selectedSession,
    snapshotSession,
    chosenAgentCommandTarget,
    resumeAgentTerminal,
    resetAgentSession,
    dispatchAgentCommand,
    interruptConversation,
    openAgentTerminal,
    copyBridgeCommand,
    controlManagedRun,
    quickRespond,
    prepareReassignment,
  };
};
