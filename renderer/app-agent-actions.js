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
  } = context;

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

  function conversationMessageKey(message) {
    const id = String(message?.id || "").trim();
    if (id) return `id:${id}`;
    return `${message?.role || ""}:${String(message?.text || "").replace(/\s+/g, " ").trim()}:${message?.timestamp || ""}`;
  }

  function beginConversationMessage(session, command) {
    const detail = state.details.get(session.id);
    const baselineMessages = [...(session.messages || []), ...(detail?.messages || [])];
    const entry = {
      id: `local:${session.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      text: command,
      timestamp: new Date().toISOString(),
      status: "sending",
      presented: false,
      baselineMessageKeys: new Set(baselineMessages.map(conversationMessageKey)),
    };
    const pending = state.pendingConversationMessages.get(session.id) || [];
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
    state.drawerForceLatest = true;
    context.renderDrawer?.();
  }

  function agentControlMode(session, targets) {
    if (targets.length && isLiveSession(session)) return "direct";
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
    const relayed = routingEnabled && route === "parent" && routeAvailable;
    const targetKey = agentCommandTargetKey(session, route);
    const savedTarget = state.agentCommandTargets.get(targetKey) || "";
    const relayTarget = relayed ? targets.find((target) => target.kind === "terminal") || targets[0] || null : null;
    const targetId = targets.some((target) => target.id === savedTarget)
      ? savedTarget
      : targets.length === 1
        ? targets[0].id
        : relayTarget?.id || "";
    if (targetId) state.agentCommandTargets.set(targetKey, targetId);
    const target = targets.find((item) => item.id === targetId) || null;
    const draft = state.agentCommandDrafts.get(session.id) || "";
    const sending = state.agentCommandSending.has(session.id);
    const canSend = ((mode === "direct" && Boolean(target)) || ["resume", "handoff", "origin-resume"].includes(mode)) && !sending;
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
    const help = relayed
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
    const routePicker = routingEnabled
      ? `<div class="agent-command-route" role="group" aria-label="${esc(t("agent.route_label"))}">
        <span>${esc(t("agent.route_label"))}</span>
        <div>${routeContext.options.map(option => `<button type="button" data-agent-command-session="${esc(session.id)}" data-agent-command-route="${esc(option.id)}"
          aria-pressed="${option.id === route ? "true" : "false"}" ${option.available ? "" : "disabled"}>${esc(option.label)}</button>`).join("")}</div>
        <small class="${routeAvailable ? "available" : "unavailable"}">${esc(t(routeAvailable
          ? route === "direct" ? "agent.route_direct_available" : "agent.route_parent_available"
          : route === "direct" ? "agent.route_direct_unavailable" : "agent.route_parent_unavailable"))}</small>
      </div>`
      : "";
    const picker =
      targets.length > 1 && !relayed
        ? `<label class="agent-command-target">
      <span>${esc(t("agent.target_terminal"))}</span>
      <select data-agent-command-target="${esc(targetKey)}">
      <option value="">${esc(t("agent.choose_terminal"))}</option>
      ${targets.map((item) => `<option value="${esc(item.id)}" ${item.id === targetId ? "selected" : ""}>${esc(item.label)}</option>`).join("")}
      </select>
      </label>`
        : "";
    const actions = relayed
      ? `<button type="submit" ${canSend ? "" : "disabled"}>${esc(t(sending ? "agent.sending" : "agent.send_via_parent"))}</button>`
      : mode === "direct"
        ? `<button type="button" data-agent-terminal-open="${esc(session.id)}" ${canSend ? "" : "disabled"}>${esc(t("agent.open_terminal"))}</button>
      <button type="submit" ${canSend ? "" : "disabled"}>${esc(t(sending ? "agent.sending" : "agent.send_now"))}</button>`
        : mode === "resume"
          ? `<button type="submit" ${canSend ? "" : "disabled"}>${esc(t(sending ? "agent.restoring" : "agent.restore_and_send"))}</button>`
          : mode === "handoff"
            ? `<button type="submit" ${canSend ? "" : "disabled"}>${esc(t(sending ? "agent.handing_off" : "agent.handoff_and_send"))}</button>`
            : mode === "origin-resume"
              ? `<button type="submit" ${canSend ? "" : "disabled"}>${esc(t(sending ? "agent.connecting" : "agent.background_and_send"))}</button>`
              : mode === "connect"
              ? `<button type="button" data-agent-bridge-copy="${esc(targetSession.provider)}">${esc(t("agent.copy_bridge"))}</button>`
                : "";
    const editable = relayed || ["direct", "resume", "handoff", "origin-resume"].includes(mode);
    const placeholder = editable ? t(options.conversation ? "agent.conversation_placeholder" : "agent.command_example") : status;
    const availabilityClass = mode === "direct" ? "connected" : ["resume", "handoff", "origin-resume"].includes(mode) ? "resume-ready" : "unavailable";
    return `<form class="agent-command-panel ${availabilityClass} control-${mode} ${options.conversation ? "conversation-composer" : ""}"
      data-agent-command-form="${esc(session.id)}" data-agent-command-route-selected="${esc(route)}" data-agent-command-routing="${options.conversation ? "conversation" : "session"}">
      <header>
        <span class="agent-command-icon" aria-hidden="true">›_</span>
        <span><b>${esc(t(options.conversation ? "agent.conversation_title" : "agent.command_title"))}</b><small>${esc(status)}</small></span>
        <i class="${mode === "direct" ? "connected" : ""}" aria-hidden="true"></i>
      </header>
      ${routePicker}
      ${picker}
      <label class="agent-command-input">
        <span class="sr-only">${esc(t("agent.command_sr"))}</span>
        <textarea data-agent-command-draft="${esc(session.id)}" maxlength="8000" rows="${options.conversation ? "2" : "3"}"
          placeholder="${esc(placeholder)}" ${editable ? "" : "disabled"}>${editable ? esc(draft) : ""}</textarea>
      </label>
      <div class="agent-command-actions"><small aria-live="polite">${esc(help)}</small>${actions}</div>
    </form>`;
  }

  function selectedSession() {
    return (
      state.details.get(state.selectedId) || ((state.snapshot && state.snapshot.sessions) || []).find((session) => session.id === state.selectedId) || null
    );
  }

  function snapshotSession(id) {
    return ((state.snapshot && state.snapshot.sessions) || []).find((session) => session.id === id) || null;
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
      await window.LoadToAgentTerminal.resumeForAgent(session, draft, sendDraft);
      if (sendDraft && draft.trim()) state.agentCommandDrafts.delete(sessionId);
      document.querySelector(".main-stage")?.scrollTo({ top: 0, behavior: "auto" });
      context.toast(t("agent.reconnected", { provider: providerInfo(session.provider).label }));
    } catch (error) {
      context.toast(errorText(error, "agent.reconnect_failed"));
    } finally {
      state.agentCommandSending.delete(sessionId);
    }
  }

  async function dispatchAgentCommand(sessionId, form) {
    if (state.agentCommandSending.has(sessionId)) return;
    const session = snapshotSession(sessionId);
    if (!session || !window.LoadToAgentTerminal) return context.toast(t("agent.latest_not_found"));
    const conversationSubmission = form?.dataset.agentCommandRouting === "conversation";
    const routingEnabled = conversationSubmission && Boolean(session.parentId);
    const requestedRoute = routingEnabled ? form?.dataset.agentCommandRouteSelected || selectedAgentCommandRoute(session) : "direct";
    const routeContext = routingEnabled
      ? routedAgentCommandContext(session, requestedRoute)
      : { route: "direct", targetSession: session, targets: agentCommandTargets(session), available: true };
    const targetSession = routeContext.targetSession;
    const mode = routingEnabled && !routeContext.available ? "ended" : agentControlMode(targetSession, routeContext.targets);
    if (routingEnabled && !["direct", "resume", "handoff", "origin-resume"].includes(mode)) return context.toast(t("agent.route_unavailable"));
    const input = form.querySelector("[data-agent-command-draft]");
    const command = String((input && input.value) || "").trim();
    const routedCommand = routingEnabled && routeContext.route === "parent"
      ? t("agent.route_via_parent_prompt", {
          task: session.delegation?.taskName || session.taskName || session.agentName || session.title,
          message: command,
        })
      : command;
    if (mode === "resume" || mode === "handoff" || mode === "origin-resume") {
      if (input) state.agentCommandDrafts.set(sessionId, input.value);
      if (!command) return context.toast(t("agent.enter_command"));
      if (conversationSubmission) {
        state.agentCommandSending.add(sessionId);
        const pendingMessage = beginConversationMessage(session, command);
        try {
          await window.LoadToAgentTerminal.resumeForAgent(targetSession, routedCommand, true, { focus: false });
          state.agentCommandDrafts.delete(sessionId);
          updateConversationMessage(sessionId, pendingMessage, "awaiting");
          context.toast(t(routingEnabled && routeContext.route === "parent" ? "agent.command_routed_via_parent" : "agent.command_sent_background"));
        } catch (error) {
          updateConversationMessage(sessionId, pendingMessage, "failed", errorText(error, "agent.send_failed"));
          context.toast(errorText(error, "agent.send_failed"));
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
    const submit = form.querySelector('[type="submit"]');
    if (submit) {
      submit.disabled = true;
      submit.textContent = t("agent.sending");
    }
    try {
      await window.LoadToAgentTerminal.dispatchAgentCommand(targetSession, routedCommand, target.id);
      state.agentCommandDrafts.delete(sessionId);
      if (input) input.value = "";
      updateConversationMessage(sessionId, pendingMessage, "awaiting");
      context.toast(t(routingEnabled && routeContext.route === "parent" ? "agent.command_routed_via_parent" : "agent.command_sent", { target: target.label }));
    } catch (error) {
      const latest = snapshotSession(targetSession.id) || targetSession;
      const support = agentResumeSupport(latest);
      const shouldRecover = support.supported
        && (conversationSubmission || !agentCommandTargets(latest).length);
      if (shouldRecover) {
        try {
          state.agentCommandDrafts.set(sessionId, command);
          await window.LoadToAgentTerminal.resumeForAgent(latest, routedCommand, true, { focus: conversationSubmission ? false : true });
          state.agentCommandDrafts.delete(sessionId);
          if (input) input.value = "";
          updateConversationMessage(sessionId, pendingMessage, "awaiting");
          context.toast(t("agent.recovered_and_sent"));
          return;
        } catch (resumeError) {
          updateConversationMessage(sessionId, pendingMessage, "failed", errorText(resumeError, "agent.recovery_failed"));
          context.toast(errorText(resumeError, "agent.recovery_failed"));
        }
      } else {
        updateConversationMessage(sessionId, pendingMessage, "failed", errorText(error, "agent.send_failed"));
        context.toast(errorText(error, "agent.send_failed"));
      }
    } finally {
      state.agentCommandSending.delete(sessionId);
      if (conversationSubmission) context.renderDrawer?.();
      if (submit && submit.isConnected) {
        submit.disabled = false;
        submit.textContent = t(routingEnabled && routeContext.route === "parent" ? "agent.send_via_parent" : "agent.send_now");
      }
    }
  }

  async function openAgentTerminal(sessionId) {
    const session = snapshotSession(sessionId);
    if (!session || !window.LoadToAgentTerminal) return context.toast(t("agent.terminal_info_not_found"));
    const routeContext = routedAgentCommandContext(session);
    const target = chosenAgentCommandTarget(session, routeContext.route);
    if (!target)
      return context.toast(t(routeContext.targets.length ? "agent.select_open_target" : "agent.no_writable_terminal"));
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
    context.openRunModal?.();
    const request = session.sharedGoal
      || session.delegation?.assignment
      || [...(session.messages || [])].find(message => message.role === "user" && message.text)?.text
      || session.title;
    const task = request && request !== session.title ? `${session.title}\n\n${request}` : (request || session.title);
    const prompt = t("management.reassign_prompt", { task, provider: providerInfo(session.provider).label });
    const promptInput = $("#runPrompt");
    const cwdInput = $("#runCwd");
    if (promptInput) promptInput.value = prompt;
    if (cwdInput && session.cwd) cwdInput.value = session.cwd;
    $("#runProviderPicker") && ($("#runProviderPicker").innerHTML = context.providerPickerHtml?.() || "");
    context.syncRunComposer?.();
    promptInput?.focus({ preventScroll: true });
  }

  return {
    agentCommandTargets,
    agentResumeSupport,
    originAppInfo,
    agentControlMode,
    agentCommandRouteOptions,
    selectedAgentCommandRoute,
    routedAgentCommandContext,
    agentCommandComposer,
    selectedSession,
    snapshotSession,
    chosenAgentCommandTarget,
    resumeAgentTerminal,
    dispatchAgentCommand,
    openAgentTerminal,
    copyBridgeCommand,
    controlManagedRun,
    quickRespond,
    prepareReassignment,
  };
};
