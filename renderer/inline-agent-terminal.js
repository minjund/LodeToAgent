"use strict";

(() => {
  const local = {
    generation: 0,
    targetIds: new Map(),
    targetSignatures: new Map(),
    autoFailures: new Map(),
    pendingMount: null,
    focusSessionId: "",
    focusRequestToken: 0,
    focusRequestRevision: 0,
    focusOrigin: null,
    userFocusRevision: 0,
    reconnectOwnerTerminalId: "",
    embeddedOwnerGeneration: 0,
    foreignEmbeddedOwner: null,
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

  function mountedTerminalHost(viewport, terminalId) {
    const id = String(terminalId || "");
    if (!viewport || !id) return null;
    return [...viewport.children].find(child => (
      String(child?.dataset?.terminalScreen || "") === id
      && child.parentElement === viewport
    )) || null;
  }

  function clearForeignEmbeddedOwner(sessionId = "") {
    if (sessionId && local.foreignEmbeddedOwner?.sessionId !== sessionId) return;
    local.embeddedOwnerGeneration += 1;
    local.foreignEmbeddedOwner = null;
  }

  function cancelInlineClaim(sessionId) {
    local.generation += 1;
    local.pendingMount = null;
    if (local.focusSessionId === sessionId) {
      local.focusSessionId = "";
      local.focusOrigin = null;
    }
  }

  function connectionSignature(session, terminal = window.LoadToAgentTerminal) {
    return terminal?.agentConnectionSignature?.(session)
      || JSON.stringify([
        session?.id,
        session?.externalId,
        session?.provider,
        session?.environment?.kind,
        session?.environment?.distro,
      ].map(value => String(value || "").trim()));
  }

  function requestTerminalFocus(sessionId) {
    local.focusSessionId = String(sessionId || "");
    local.focusRequestToken += 1;
    local.focusRequestRevision = local.userFocusRevision;
    local.focusOrigin = document.activeElement;
    return local.focusRequestToken;
  }

  function focusWhenReady(sessionId) {
    if (local.focusSessionId !== sessionId) return;
    const revision = local.focusRequestRevision;
    const origin = local.focusOrigin;
    local.focusSessionId = "";
    local.focusOrigin = null;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      const root = shell();
      const embedded = window.LoadToAgentTerminal?.embeddedState?.() || {};
      const viewport = root?.querySelector("#agentInlineTerminalViewport");
      const ownsEmbeddedHost = root?.dataset.inlineAgentTerminal === sessionId
        && embedded.agentSessionId === sessionId
        && Boolean(mountedTerminalHost(viewport, embedded.terminalId));
      const documentFocused = typeof document.hasFocus !== "function" || document.hasFocus();
      const documentVisible = !document.visibilityState || document.visibilityState === "visible";
      const focusStayedPassive = !active
        || active === document.body
        || active === document.documentElement
        || active === origin;
      if (local.userFocusRevision === revision
        && focusStayedPassive
        && documentFocused
        && documentVisible
        && ownsEmbeddedHost
        && app()?.state?.inlineTerminalSessionId === sessionId) {
        window.LoadToAgentTerminal?.focusEmbedded?.();
      }
    });
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

  async function sync(options = {}) {
    const instance = app();
    const session = selectedSession();
    const root = shell();
    const terminal = window.LoadToAgentTerminal;
    if (!instance?.state || !session || !root || !terminal?.mountForAgent) return { ok: false, reason: "not-ready" };
    if (root.dataset.inlineAgentTerminal !== session.id) return { ok: false, reason: "stale-shell" };
    const viewport = root.querySelector("#agentInlineTerminalViewport");
    if (!viewport) return { ok: false, reason: "missing-viewport" };

    const signature = connectionSignature(session, terminal);
    const rememberedTargetId = String(local.targetIds.get(session.id) || "");
    const embedded = terminal.embeddedState?.() || {};
    const mountedHost = mountedTerminalHost(viewport, embedded.terminalId);
    const foreignOwner = local.foreignEmbeddedOwner;
    const foreignOwnerMatches = foreignOwner
      && foreignOwner.generation === local.embeddedOwnerGeneration
      && foreignOwner.mountId === "drawerTerminalViewport"
      && foreignOwner.sessionId === session.id
      && foreignOwner.signature === signature
      && foreignOwner.terminalId === String(embedded.terminalId || rememberedTargetId || "");
    if (foreignOwnerMatches) {
      cancelInlineClaim(session.id);
      return { ok: false, reason: "owned-elsewhere" };
    }
    if (options.force) {
      local.autoFailures.delete(session.id);
      local.pendingMount = null;
    }
    if (embedded.connected
      && embedded.agentSessionId === session.id
      && embedded.terminalId
      && !mountedHost) {
      // The terminal module has one embedded host shared by the inline panel
      // and drawer. A passive snapshot or reconnect must never pull a host
      // back after the drawer has taken ownership of it.
      cancelInlineClaim(session.id);
      return { ok: false, reason: "owned-elsewhere" };
    }
    const verifiedEmbeddedTarget = (terminal.agentTargets?.(session) || []).find(item => (
      item?.kind === "terminal"
      && String(item.terminalId || item.id || "") === embedded.terminalId
    )) || null;
    const rememberedConnectionMatches = rememberedTargetId === embedded.terminalId
      && local.targetSignatures.get(session.id) === signature;
    if (embedded.connected
      && embedded.agentSessionId === session.id
      && mountedHost
      && (verifiedEmbeddedTarget || rememberedConnectionMatches)) {
      const target = verifiedEmbeddedTarget || { id: embedded.terminalId, terminalId: embedded.terminalId };
      local.targetIds.set(session.id, embedded.terminalId);
      local.targetSignatures.set(session.id, signature);
      local.autoFailures.delete(session.id);
      setEmpty(root, false);
      setStatus(root, "drawer.terminal_connected", target.label || "", "connected");
      focusWhenReady(session.id);
      return { ok: true, reused: true, target };
    }

    if (local.pendingMount?.sessionId === session.id
      && local.pendingMount.viewport === viewport
      && local.pendingMount.signature === signature) {
      return local.pendingMount.promise;
    }

    const generation = ++local.generation;
    let cachedAutoFailure = local.autoFailures.get(session.id) === signature;
    const mountableTargetAppeared = (terminal.agentTargets?.(session) || []).some(target => target?.kind === "terminal");
    if (cachedAutoFailure && mountableTargetAppeared) {
      local.autoFailures.delete(session.id);
      cachedAutoFailure = false;
    }
    if (!options.force && cachedAutoFailure && !mountableTargetAppeared) {
      const support = terminal.resumeSupport?.(session);
      const resumable = Boolean(support?.supported);
      setEmpty(
        root,
        true,
        resumable ? "drawer.terminal_resume_available" : "drawer.terminal_unavailable",
        resumable ? "drawer.terminal_resume_available_help" : "drawer.terminal_unavailable_help",
        resumable,
      );
      setStatus(root, resumable ? "drawer.terminal_resume_available" : "drawer.terminal_unavailable", support?.reason || "", "unavailable");
      local.focusSessionId = "";
      return { ok: false, reason: "cached-failure", resumable };
    }
    const createIfMissing = !session.parentId && !cachedAutoFailure;
    setEmpty(root, true);
    setStatus(root, "drawer.terminal_connecting");
    const task = (async () => {
      try {
        const result = await terminal.mountForAgent(session, {
          mount: viewport,
          targetId: rememberedTargetId,
          createIfMissing,
        });
        if (generation !== local.generation || instance.state.inlineTerminalSessionId !== session.id) {
          return { ok: false, reason: "cancelled" };
        }
        const currentSession = selectedSession();
        if (!currentSession || connectionSignature(currentSession, terminal) !== signature) {
          const active = terminal.embeddedState?.() || {};
          const resultTargetId = String(result?.target?.terminalId || result?.target?.id || "");
          if (resultTargetId
            && String(active.terminalId || "") === resultTargetId
            && active.agentSessionId === session.id) {
            terminal.unmountEmbedded?.();
          }
          local.targetIds.delete(session.id);
          local.targetSignatures.delete(session.id);
          local.autoFailures.delete(session.id);
          setTimeout(() => {
            if (app()?.state?.inlineTerminalSessionId === session.id) sync({ force: true });
          }, 0);
          return { ok: false, reason: "stale-identity" };
        }
        if (!result?.ok) {
          if (!["cancelled", "pending"].includes(result?.reason)) {
            local.autoFailures.set(session.id, signature);
          }
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
          local.focusSessionId = "";
          return result || { ok: false, reason: "unavailable" };
        }
        const targetId = String(result.target?.terminalId || result.target?.id || "");
        if (targetId) {
          local.targetIds.set(session.id, targetId);
          local.targetSignatures.set(session.id, signature);
        }
        local.autoFailures.delete(session.id);
        setEmpty(root, false);
        setStatus(root, "drawer.terminal_connected", result.target?.label || result.terminal?.title || "", "connected");
        focusWhenReady(session.id);
        return result;
      } catch (error) {
        if (generation !== local.generation) return { ok: false, reason: "cancelled" };
        local.autoFailures.set(session.id, signature);
        local.focusSessionId = "";
        setEmpty(root, true, "drawer.terminal_unavailable", "drawer.terminal_unavailable_help");
        setStatus(root, "drawer.terminal_unavailable", window.LoadToAgentI18n.errorText(error, "drawer.terminal_unavailable"), "error");
        report("inline-agent-terminal-mount", error);
        return { ok: false, reason: "error", error };
      } finally {
        if (local.pendingMount?.promise === task) local.pendingMount = null;
      }
    })();
    local.pendingMount = { sessionId: session.id, viewport, signature, promise: task };
    return task;
  }

  function close(options = {}) {
    const instance = app();
    const sessionId = String(instance?.state?.inlineTerminalSessionId || "");
    if (!instance?.state || !sessionId) return false;
    local.generation += 1;
    local.pendingMount = null;
    local.focusSessionId = "";
    local.focusOrigin = null;
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
    clearForeignEmbeddedOwner(id);
    local.autoFailures.delete(id);
    // `options.focus` controls whether the graph itself changes focus. The
    // user's PTY click should still place the caret in xterm after either the
    // overview or focused layout finishes mounting.
    requestTerminalFocus(id);
    instance.state.inlineTerminalSessionId = id;
    instance.renderSessions?.("focus");
  }

  async function resume() {
    const instance = app();
    const session = selectedSession();
    const root = shell();
    const button = root?.querySelector("[data-inline-terminal-resume]");
    if (!session || !button || button.getAttribute("aria-busy") === "true") return;
    const sessionId = String(session.id || "");
    const signature = connectionSignature(session);
    const stillCurrent = () => {
      const currentSession = selectedSession();
      return instance?.state?.inlineTerminalSessionId === sessionId
        && shell() === root
        && root.dataset.inlineAgentTerminal === sessionId
        && currentSession?.id === sessionId
        && connectionSignature(currentSession) === signature;
    };
    let focusRequestToken = 0;
    const clearOwnFocusIntent = () => {
      if (local.focusSessionId !== sessionId || local.focusRequestToken !== focusRequestToken) return;
      local.focusSessionId = "";
      local.focusOrigin = null;
    };
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
    setEmpty(root, true, "drawer.terminal_resuming", "drawer.terminal_resuming_help");
    setStatus(root, "drawer.terminal_resuming");
    // Capture the user's resume gesture before the provider can spend seconds
    // reopening its history. Later interaction changes userFocusRevision and
    // must not be erased when this await eventually resolves.
    focusRequestToken = requestTerminalFocus(sessionId);
    try {
      const resumed = await window.LoadToAgentTerminal.resumeForAgent(session, "", false, { focus: false });
      const targetId = String(resumed?.terminalId || resumed?.id || "");
      if (!targetId) throw new Error(t("terminal.agent.resume_terminal_failed"));
      if (!stillCurrent()) {
        clearOwnFocusIntent();
        return;
      }
      clearForeignEmbeddedOwner(sessionId);
      local.targetIds.set(sessionId, targetId);
      local.targetSignatures.set(sessionId, signature);
      local.autoFailures.delete(sessionId);
      await sync({ force: true });
    } catch (error) {
      if (!stillCurrent()) {
        clearOwnFocusIntent();
        return;
      }
      clearOwnFocusIntent();
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
      if (sessionId) {
        clearForeignEmbeddedOwner(sessionId);
        local.targetIds.delete(sessionId);
        local.targetSignatures.delete(sessionId);
        local.autoFailures.delete(sessionId);
        requestTerminalFocus(sessionId);
      }
      window.LoadToAgentTerminal?.unmountEmbedded?.();
      sync({ force: true });
      return;
    }
    if (event.target.closest("[data-inline-terminal-resume]")) {
      event.stopPropagation();
      resume();
    }
  });

  // A provider resume can take long enough for the user to move elsewhere.
  // Only the original expand/reconnect gesture may grant delayed xterm focus;
  // any later pointer, keyboard or external focus action cancels that intent.
  document.addEventListener("pointerdown", () => { local.userFocusRevision += 1; }, true);
  document.addEventListener("keydown", () => { local.userFocusRevision += 1; }, true);
  document.addEventListener("focusin", (event) => {
    if (event.target === document.body
      || event.target === document.documentElement
      || event.target?.isConnected === false
      || event.target === local.focusOrigin) return;
    if (!event.target?.closest?.("[data-inline-agent-terminal]")) local.userFocusRevision += 1;
  }, true);
  window.addEventListener("blur", () => {
    queueMicrotask(() => {
      // Chromium can emit a synthetic window blur while the focused xterm
      // helper textarea is detached, even though the app keeps document
      // focus. Only a real window departure cancels delayed PTY focus.
      const documentFocused = typeof document.hasFocus !== "function" || document.hasFocus();
      if (documentFocused) return;
      local.userFocusRevision += 1;
    });
  }, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") local.userFocusRevision += 1;
  }, true);

  window.addEventListener("loadtoagent:terminal-reconnect-focus", (event) => {
    const terminalId = String(event.detail?.terminalId || "");
    const session = selectedSession();
    const root = shell();
    const embedded = window.LoadToAgentTerminal?.embeddedState?.() || {};
    const viewport = root?.querySelector("#agentInlineTerminalViewport");
    const host = mountedTerminalHost(viewport, terminalId);
    if (!terminalId
      || !session
      || !root
      || root.dataset.inlineAgentTerminal !== session.id
      || embedded.agentSessionId !== session.id
      || String(embedded.terminalId || "") !== terminalId
      || !host) return;
    requestTerminalFocus(session.id);
  });

  window.addEventListener("loadtoagent:terminal-reconnect-owner", (event) => {
    const terminalId = String(event.detail?.terminalId || "");
    const session = selectedSession();
    const root = shell();
    const embedded = window.LoadToAgentTerminal?.embeddedState?.() || {};
    const viewport = root?.querySelector("#agentInlineTerminalViewport");
    const host = mountedTerminalHost(viewport, terminalId);
    if (terminalId
      && event.detail?.mountId === "drawerTerminalViewport"
      && session
      && root?.dataset.inlineAgentTerminal === session.id
      && embedded.agentSessionId === session.id
      && String(embedded.terminalId || "") === terminalId) {
      const generation = ++local.embeddedOwnerGeneration;
      local.foreignEmbeddedOwner = {
        generation,
        mountId: "drawerTerminalViewport",
        sessionId: session.id,
        signature: connectionSignature(session),
        terminalId,
      };
      cancelInlineClaim(session.id);
      return;
    }
    if (!terminalId
      || event.detail?.mountId !== "agentInlineTerminalViewport"
      || !session
      || root?.dataset.inlineAgentTerminal !== session.id
      || embedded.agentSessionId !== session.id
      || String(embedded.terminalId || "") !== terminalId
      || !host) return;
    clearForeignEmbeddedOwner(session.id);
    local.reconnectOwnerTerminalId = terminalId;
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

  window.loadtoagent?.onTerminalState?.((payload) => {
    if (payload?.change !== "reconnected") return;
    const session = selectedSession();
    const root = shell();
    if (!session || !root || root.dataset.inlineAgentTerminal !== session.id) return;
    const targetId = String(local.targetIds.get(session.id)
      || window.LoadToAgentTerminal?.embeddedState?.().terminalId
      || "");
    const reconnectOwnerTerminalId = local.reconnectOwnerTerminalId;
    local.reconnectOwnerTerminalId = "";
    if (!targetId || !payload.sessions?.some(item => String(item?.id || "") === targetId)) return;
    if (reconnectOwnerTerminalId !== targetId) return;
    local.autoFailures.delete(session.id);
    setEmpty(root, true);
    setStatus(root, "drawer.terminal_connecting");
    setTimeout(() => sync({ force: true }), 0);
  });

  window.LoadToAgentInlineTerminal = { toggle, close, sync };
})();
