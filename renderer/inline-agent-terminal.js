"use strict";

(() => {
  const local = {
    generation: 0,
    targetIds: new Map(),
  };
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const report = (scope, error) => window.LoadToAgentRendererUtils?.reportRecoverableError?.(scope, error);

  function app() {
    return window.LoadToAgentApp;
  }

  function selectedSession() {
    const instance = app();
    const id = String(instance?.state?.inlineTerminalSessionId || "");
    if (!id) return null;
    return instance.snapshotSession?.(id)
      || instance.state?.details?.get?.(id)
      || (instance.state?.snapshot?.sessions || []).find(session => session.id === id)
      || null;
  }

  function shell() {
    return document.querySelector("[data-inline-agent-terminal]");
  }

  function setStatus(root, key, meta = "", tone = "connecting") {
    if (!root) return;
    root.dataset.connection = tone;
    const label = root.querySelector("[data-inline-terminal-status]");
    const detail = root.querySelector("[data-inline-terminal-meta]");
    if (label) label.textContent = t(key);
    if (detail) detail.textContent = String(meta || "");
  }

  function setEmpty(root, visible, titleKey = "drawer.terminal_connecting", helpKey = "drawer.terminal_connecting_help", resumable = false) {
    const empty = root?.querySelector("[data-inline-terminal-empty]");
    if (!empty) return;
    empty.classList.toggle("hidden", !visible);
    const title = empty.querySelector("b");
    const help = empty.querySelector("small");
    const resume = empty.querySelector("[data-inline-terminal-resume]");
    if (title) title.textContent = t(titleKey);
    if (help) help.textContent = t(helpKey);
    resume?.classList.toggle("hidden", !resumable);
    if (resume) resume.disabled = !resumable;
  }

  function setComposerReady(root, ready) {
    const form = root?.querySelector("[data-inline-terminal-composer] [data-agent-command-form]");
    if (!form) return;
    form.dataset.agentTerminalReady = ready ? "true" : "false";
    form.dataset.agentSendAvailable = ready ? "true" : "false";
    const input = form.querySelector("[data-agent-command-draft]");
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = !ready || !String(input?.value || "").trim();
    const interrupt = form.querySelector("[data-terminal-interrupt]");
    if (interrupt) interrupt.disabled = !ready;
  }

  async function sync() {
    const instance = app();
    const session = selectedSession();
    const root = shell();
    const terminal = window.LoadToAgentTerminal;
    if (!instance?.state || !session || !root || !terminal?.mountForAgent) return { ok: false, reason: "not-ready" };
    if (root.dataset.inlineAgentTerminal !== session.id) return { ok: false, reason: "stale-shell" };
    const viewport = root.querySelector("#agentInlineTerminalViewport");
    if (!viewport) return { ok: false, reason: "missing-viewport" };

    const generation = ++local.generation;
    setEmpty(root, true);
    setStatus(root, "drawer.terminal_connecting");
    setComposerReady(root, false);
    try {
      const result = await terminal.mountForAgent(session, {
        mount: viewport,
        targetId: local.targetIds.get(session.id) || "",
      });
      if (generation !== local.generation || instance.state.inlineTerminalSessionId !== session.id) {
        return { ok: false, reason: "cancelled" };
      }
      if (!result?.ok) {
        const support = result?.reason === "no-target" ? terminal.resumeSupport?.(session) : null;
        const resumable = Boolean(support?.supported);
        setEmpty(
          root,
          true,
          resumable ? "drawer.terminal_resume_available" : "drawer.terminal_unavailable",
          resumable ? "drawer.terminal_resume_available_help" : "drawer.terminal_unavailable_help",
          resumable,
        );
        setStatus(root, resumable ? "drawer.terminal_resume_available" : "drawer.terminal_unavailable", "", "unavailable");
        setComposerReady(root, false);
        return result || { ok: false, reason: "unavailable" };
      }
      const targetId = String(result.target?.terminalId || result.target?.id || "");
      if (targetId) local.targetIds.set(session.id, targetId);
      setEmpty(root, false);
      setStatus(root, "drawer.terminal_connected", result.target?.label || result.terminal?.title || "", "connected");
      setComposerReady(root, true);
      return result;
    } catch (error) {
      if (generation !== local.generation) return { ok: false, reason: "cancelled" };
      setEmpty(root, true, "drawer.terminal_unavailable", "drawer.terminal_unavailable_help");
      setStatus(root, "drawer.terminal_unavailable", window.LoadToAgentI18n.errorText(error, "drawer.terminal_unavailable"), "error");
      setComposerReady(root, false);
      report("inline-agent-terminal-mount", error);
      return { ok: false, reason: "error", error };
    }
  }

  function close(options = {}) {
    const instance = app();
    const sessionId = String(instance?.state?.inlineTerminalSessionId || "");
    if (!instance?.state || !sessionId) return false;
    local.generation += 1;
    instance.state.inlineTerminalSessionId = null;
    const embedded = window.LoadToAgentTerminal?.embeddedState?.();
    if (!embedded?.agentSessionId || embedded.agentSessionId === sessionId) {
      window.LoadToAgentTerminal?.unmountEmbedded?.();
    }
    if (options.render !== false) instance.renderSessions?.("focus");
    return true;
  }

  function toggle(sessionId, options = {}) {
    const instance = app();
    const id = String(sessionId || "");
    if (!instance?.state || !id) return;
    if (instance.state.inlineTerminalSessionId === id) {
      close();
      return;
    }
    close({ render: false });
    if (options.focus !== false) instance.state.graphFocusId = id;
    instance.state.inlineTerminalSessionId = id;
    instance.renderSessions?.("focus");
  }

  async function resume() {
    const session = selectedSession();
    const root = shell();
    const button = root?.querySelector("[data-inline-terminal-resume]");
    if (!session || !button || button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
    setEmpty(root, true, "drawer.terminal_resuming", "drawer.terminal_resuming_help");
    setStatus(root, "drawer.terminal_resuming");
    try {
      const resumed = await window.LoadToAgentTerminal.resumeForAgent(session, "", false, { focus: false });
      const targetId = String(resumed?.terminalId || resumed?.id || "");
      if (!targetId) throw new Error(t("terminal.agent.resume_terminal_failed"));
      local.targetIds.set(session.id, targetId);
      await sync();
    } catch (error) {
      setEmpty(root, true, "drawer.terminal_resume_failed", "drawer.terminal_resume_failed_help", true);
      setStatus(root, "drawer.terminal_resume_failed", window.LoadToAgentI18n.errorText(error, "drawer.terminal_resume_failed"), "error");
      report("inline-agent-terminal-resume", error);
    } finally {
      button.removeAttribute("aria-busy");
      button.disabled = false;
    }
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-inline-terminal-close]")) {
      event.stopPropagation();
      close();
      return;
    }
    if (event.target.closest("[data-inline-terminal-focus]")) {
      event.stopPropagation();
      window.LoadToAgentTerminal?.focusEmbedded?.();
      return;
    }
    if (event.target.closest("[data-inline-terminal-reconnect]")) {
      event.stopPropagation();
      const sessionId = selectedSession()?.id;
      if (sessionId) local.targetIds.delete(sessionId);
      window.LoadToAgentTerminal?.unmountEmbedded?.();
      sync();
      return;
    }
    if (event.target.closest("[data-inline-terminal-resume]")) {
      event.stopPropagation();
      resume();
    }
  });

  window.addEventListener("loadtoagent:terminal-command-delivery", (event) => {
    const root = shell();
    if (!root || event.detail?.sessionId !== root.dataset.inlineAgentTerminal) return;
    if (event.detail.deliveryState === "rejected") {
      setStatus(root, "drawer.terminal_delivery_failed", t("drawer.terminal_delivery_failed_help"), "error");
    } else if (event.detail.deliveryState === "unknown") {
      setStatus(root, "drawer.terminal_delivery_uncertain", event.detail.target?.label || "", "unavailable");
    }
  });

  window.LoadToAgentInlineTerminal = { toggle, close, sync };
})();
