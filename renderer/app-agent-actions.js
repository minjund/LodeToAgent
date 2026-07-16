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

  function agentControlMode(session, targets) {
    if (targets.length) return "direct";
    if (originAppInfo(session)) return !isLiveSession(session) && agentResumeSupport(session).supported ? "origin-resume" : "origin";
    if (agentResumeSupport(session).supported) return isLiveSession(session) ? "handoff" : "resume";
    if (isLiveSession(session)) return "connect";
    return "ended";
  }

  function agentCommandComposer(session) {
    const targets = agentCommandTargets(session);
    const mode = agentControlMode(session, targets);
    const savedTarget = state.agentCommandTargets.get(session.id) || "";
    const targetId = targets.some((target) => target.id === savedTarget) ? savedTarget : targets.length === 1 ? targets[0].id : "";
    if (targetId) state.agentCommandTargets.set(session.id, targetId);
    const target = targets.find((item) => item.id === targetId) || null;
    const draft = state.agentCommandDrafts.get(session.id) || "";
    const sending = state.agentCommandSending.has(session.id);
    const canSend = ((mode === "direct" && Boolean(target)) || ["resume", "handoff", "origin-resume"].includes(mode)) && !sending;
    const origin = originAppInfo(session);
    const status =
      mode === "direct"
        ? t("agent.direct_status", { target: targets.length === 1 ? target.label : t("agent.choose_terminal_count", { count: targets.length }) })
        : mode === "handoff"
          ? t("agent.handoff_status")
          : mode === "resume"
            ? t("agent.resume_status")
            : mode === "origin-resume"
              ? t("agent.origin_resume_status")
              : mode === "connect"
                ? t("agent.connect_status")
                : mode === "origin"
                  ? t("agent.origin_status")
                  : window.LoadToAgentI18n.t("ui.ended_session");
    const help =
      mode === "direct"
        ? t("agent.direct_help")
        : mode === "handoff"
          ? t("agent.handoff_help")
          : mode === "resume"
            ? t("agent.resume_help")
            : mode === "origin-resume"
              ? t("agent.origin_resume_help", { provider: (origin && origin.provider) || t("agent.desktop") })
              : mode === "connect"
                ? t("agent.connect_help", { provider: session.provider })
                : mode === "origin"
                  ? t("agent.origin_help", { app: (origin && origin.label) || t("agent.desktop_app", { provider: "" }).trim() })
                  : agentResumeSupport(session).reason || t("agent.resume_method_unknown");
    const picker =
      targets.length > 1
        ? `<label class="agent-command-target">
      <span>${esc(t("agent.target_terminal"))}</span>
      <select data-agent-command-target="${esc(session.id)}">
      <option value="">${esc(t("agent.choose_terminal"))}</option>
      ${targets.map((item) => `<option value="${esc(item.id)}" ${item.id === targetId ? "selected" : ""}>${esc(item.label)}</option>`).join("")}
      </select>
      </label>`
        : "";
    const originAction = `<button type="button" data-agent-open-origin="${esc(session.id)}">${esc(t("agent.continue_in_origin", { provider: (origin && origin.provider) || t("agent.desktop") }))}</button>`;
    const actions =
      mode === "direct"
        ? `<button type="button" data-agent-terminal-open="${esc(session.id)}" ${canSend ? "" : "disabled"}>${esc(t("agent.open_terminal"))}</button>
      <button type="submit" ${canSend ? "" : "disabled"}>${esc(t(sending ? "agent.sending" : "agent.send_now"))}</button>`
        : mode === "resume"
          ? `<button type="submit" ${canSend ? "" : "disabled"}>${esc(t(sending ? "agent.restoring" : "agent.restore_and_send"))}</button>`
          : mode === "handoff"
            ? `<button type="submit" ${canSend ? "" : "disabled"}>${esc(t(sending ? "agent.handing_off" : "agent.handoff_and_send"))}</button>`
            : mode === "origin-resume"
              ? `${originAction}<button type="submit" ${canSend ? "" : "disabled"}>${esc(t(sending ? "agent.connecting" : "agent.background_and_send"))}</button>`
              : mode === "connect"
                ? `<button type="button" data-agent-bridge-copy="${esc(session.provider)}">${esc(t("agent.copy_bridge"))}</button>`
                : mode === "origin"
                  ? originAction
                  : "";
    const editable = ["direct", "resume", "handoff", "origin-resume"].includes(mode);
    const placeholder = editable ? t("agent.command_example") : status;
    const availabilityClass = mode === "direct" ? "connected" : ["resume", "handoff", "origin-resume"].includes(mode) ? "resume-ready" : "unavailable";
    return `<form class="agent-command-panel ${availabilityClass} control-${mode}"
      data-agent-command-form="${esc(session.id)}">
      <header>
        <span class="agent-command-icon" aria-hidden="true">›_</span>
        <span><b>${esc(t("agent.command_title"))}</b><small>${esc(status)}</small></span>
        <i class="${mode === "direct" ? "connected" : ""}" aria-hidden="true"></i>
      </header>
      ${picker}
      <label class="agent-command-input">
        <span class="sr-only">${esc(t("agent.command_sr"))}</span>
        <textarea data-agent-command-draft="${esc(session.id)}" maxlength="8000" rows="3"
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

  function chosenAgentCommandTarget(session) {
    const targets = agentCommandTargets(session);
    const saved = state.agentCommandTargets.get(session.id) || "";
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
    const mode = agentControlMode(session, agentCommandTargets(session));
    if (mode === "resume" || mode === "handoff" || mode === "origin-resume") {
      const input = form.querySelector("[data-agent-command-draft]");
      if (input) state.agentCommandDrafts.set(sessionId, input.value);
      if (!String((input && input.value) || "").trim()) return context.toast(t("agent.enter_command"));
      return resumeAgentTerminal(sessionId, true);
    }
    const target = chosenAgentCommandTarget(session);
    const input = form.querySelector("[data-agent-command-draft]");
    const command = String((input && input.value) || "").trim();
    if (!target)
      return context.toast(t(agentCommandTargets(session).length ? "agent.select_target_first" : "agent.no_writable_terminal"));
    if (!command) return context.toast(t("agent.enter_command"));
    state.agentCommandSending.add(sessionId);
    const submit = form.querySelector('[type="submit"]');
    if (submit) {
      submit.disabled = true;
      submit.textContent = t("agent.sending");
    }
    try {
      await window.LoadToAgentTerminal.dispatchAgentCommand(session, command, target.id);
      state.agentCommandDrafts.delete(sessionId);
      if (input) input.value = "";
      context.toast(t("agent.command_sent", { target: target.label }));
    } catch (error) {
      const latest = snapshotSession(sessionId) || session;
      const support = agentResumeSupport(latest);
      if (!agentCommandTargets(latest).length && support.supported) {
        try {
          state.agentCommandDrafts.set(sessionId, command);
          await window.LoadToAgentTerminal.resumeForAgent(latest, command, true);
          state.agentCommandDrafts.delete(sessionId);
          if (input) input.value = "";
          context.toast(t("agent.recovered_and_sent"));
          return;
        } catch (resumeError) {
          context.toast(errorText(resumeError, "agent.recovery_failed"));
        }
      } else context.toast(errorText(error, "agent.send_failed"));
    } finally {
      state.agentCommandSending.delete(sessionId);
      if (submit && submit.isConnected) {
        submit.disabled = false;
        submit.textContent = t("agent.send_now");
      }
    }
  }

  async function openAgentTerminal(sessionId) {
    const session = snapshotSession(sessionId);
    if (!session || !window.LoadToAgentTerminal) return context.toast(t("agent.terminal_info_not_found"));
    const target = chosenAgentCommandTarget(session);
    if (!target)
      return context.toast(t(agentCommandTargets(session).length ? "agent.select_open_target" : "agent.no_writable_terminal"));
    selectView(target.kind === "tmux" ? "tmux" : "terminal");
    try {
      await window.LoadToAgentTerminal.openForAgent(session, target.id, state.agentCommandDrafts.get(sessionId) || "");
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

  async function openSessionOrigin(sessionId) {
    const session = snapshotSession(sessionId);
    const origin = originAppInfo(session);
    if (!session || !origin) return context.toast(t("agent.origin_not_found"));
    try {
      const result = await window.loadtoagent.openSessionOrigin(session);
      if (!result || !result.ok) return context.toast(t("agent.origin_cannot_open", { app: origin.label }));
      context.toast(t("agent.origin_opened", { provider: origin.provider }));
    } catch (error) {
      context.toast(errorText(error, "agent.origin_open_failed", { app: origin.label }));
    }
  }

  return {
    agentCommandTargets,
    agentResumeSupport,
    originAppInfo,
    agentControlMode,
    agentCommandComposer,
    selectedSession,
    snapshotSession,
    chosenAgentCommandTarget,
    resumeAgentTerminal,
    dispatchAgentCommand,
    openAgentTerminal,
    copyBridgeCommand,
    openSessionOrigin,
  };
};
