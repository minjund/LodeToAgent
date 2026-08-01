'use strict';

/** Connect dashboard agent sessions to live or resumed terminal targets. */
window.LoadToAgentTerminalAgentActions = function createModule(context) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $, state, init, notice, moveWorkbench, selectTmux, selectSession, bindAgent, queueHistoryRefresh,
    renderTarget, fitEntry, refreshSessions, resumeSupport, resumeLaunchArgs, preferredWorkspace, providerLabel, terminalTypeLabel, esc,
    syncComposer, tmuxTargetKey,
  } = context;
  const terminalLabel = typeof terminalTypeLabel === 'function'
    ? terminalTypeLabel
    : terminal => String(terminal?.type || t('terminal.type.terminal'));

  function normalizedDeliveryState(result, fallback = 'accepted') {
    if (result?.deliveryState === 'rejected') return 'rejected';
    if (result?.deliveryState === 'unknown') return 'unknown';
    if (result?.deliveryState === 'accepted') return 'accepted';
    return fallback;
  }

  function rejectedError(message, code = 'DELIVERY_REJECTED') {
    const error = new Error(message);
    error.code = code;
    error.deliveryState = 'rejected';
    return error;
  }

  function resultError(result, fallback) {
    const error = new Error(result?.error || fallback);
    error.code = result?.code || 'DELIVERY_REJECTED';
    error.deliveryId = result?.deliveryId || '';
    error.deliveryState = result ? normalizedDeliveryState(result, 'rejected') : 'unknown';
    return error;
  }

  function markRejectedBeforeDelivery(error) {
    const value = error instanceof Error ? error : new Error(String(error || ''));
    if (!value.code) value.code = 'DELIVERY_REJECTED';
    value.deliveryState = 'rejected';
    return value;
  }

  async function initializeBeforeDelivery() {
    try {
      await init();
    } catch (error) {
      throw markRejectedBeforeDelivery(error);
    }
  }

  function reportPostDeliveryError(scope, error) {
    window.LoadToAgentRendererUtils?.reportRecoverableError?.(scope, error);
  }

  function deliveryNotice(message, tone = 'success') {
    try {
      notice(message, tone);
    } catch (error) {
      reportPostDeliveryError('terminal-agent-notice', error);
    }
  }

  function tmuxRows(snapshot = state.snapshot) {
    const rows = [];
    for (const distro of snapshot && snapshot.tmux && snapshot.tmux.distros || []) {
      for (const session of distro.sessions || []) {
        for (const windowItem of session.windows || []) {
          for (const pane of windowItem.panes || []) {
            if (!state.suppressedTmuxTargets.has(tmuxTargetKey(distro.name, pane.nativeId))) {
              rows.push({ distro, session, window: windowItem, pane });
            }
          }
        }
      }
    }
    return rows;
  }

  function agentTargets(agentSession) {
    if (!agentSession || !agentSession.id) return [];
    const targets = [];
    const presence = Array.isArray(agentSession.runtimePresence) ? agentSession.runtimePresence : [];
    const blockedTerminalIds = new Set(state.sessions
      .filter(terminal => agentSession.parentId && (terminal.type === 'agent'
        || /sub-agent is controlled by its parent|direct input is disabled/i.test(String(terminal.replay || ''))))
      .map(terminal => terminal.id));
    const tmuxPresence = presence.filter(item => item.kind === 'tmux');
    for (const row of tmuxRows()) {
      const pane = row.pane || {};
      const linked = pane.agent && pane.agent.linkedSessionId === agentSession.id;
      const observed = tmuxPresence.some(item => item.paneId === pane.id
        || item.paneNativeId === pane.nativeId
        || item.id === `tmux:${row.distro.name}:${pane.nativeId}`);
      if (!linked && !observed) continue;
      targets.push({
        id: `tmux:${row.distro.name}:${pane.nativeId}`,
        kind: 'tmux',
        label: `${row.distro.name} · ${row.session.name} · ${pane.nativeId}`,
        detail: `${row.window.index}:${row.window.name} · ${pane.command || t('terminal.agent.ai_terminal')}`,
        distro: row.distro.name,
        paneId: pane.id,
        paneNativeId: pane.nativeId,
      });
    }
    for (const terminal of state.sessions) {
      const reconnectable = terminal.status === 'detached'
        && terminal.type === 'agent'
        && terminal.backend === 'managed-tmux'
        && terminal.bridgeId === agentSession.id;
      if (terminal.status !== 'running' && !reconnectable) continue;
      if (blockedTerminalIds.has(terminal.id)) continue;
      const exactBridge = terminal.bridgeId === agentSession.id;
      const exactPresence = presence.some(item => item.terminalId === terminal.id);
      const processPresence = !agentSession.parentId && presence.some(item => Number(item.pid || 0) === Number(terminal.pid || -1)
        || Number(item.parentPid || 0) === Number(terminal.pid || -1));
      const matched = exactBridge || exactPresence || processPresence;
      if (!matched) continue;
      targets.push({
        id: terminal.id,
        kind: 'terminal',
        label: terminal.title,
        detail: `${terminalLabel(terminal)} · ${t('session.program_pid', { pid: terminal.pid || '--' })}`,
        terminalId: terminal.id,
        reconnectable,
      });
    }
    // The control-room composer is available before the terminal workbench has
    // necessarily loaded its own session list. Runtime presence already carries
    // the stable terminal id, so keep direct participation available from home.
    for (const item of presence.filter(entry => entry.kind === 'terminal' && entry.terminalId && !blockedTerminalIds.has(entry.terminalId)
      && (!agentSession.parentId || state.sessions.some(terminal => terminal.id === entry.terminalId && terminal.type !== 'agent')))) {
      if (targets.some(target => target.id === item.terminalId)) continue;
      const runtime = String(item.runtime || item.shell || '이 컴퓨터에서 실행하는 작업');
      targets.push({
        id: item.terminalId,
        kind: 'terminal',
        label: String(item.label || runtime),
        detail: `${terminalLabel({ type: runtime })} · ${t('session.program_pid', { pid: item.pid || '--' })}`,
        terminalId: item.terminalId,
      });
    }
    return [...new Map(targets.map(target => [target.id, target])).values()];
  }

  function requiredAgentTarget(agentSession, targetId = '') {
    const targets = agentTargets(agentSession);
    if (!targets.length) throw rejectedError(t('terminal.agent.no_input_target'));
    if (targetId) {
      const selected = targets.find(target => target.id === targetId);
      if (!selected) throw rejectedError(t('terminal.agent.target_expired'));
      return selected;
    }
    if (targets.length > 1) throw rejectedError(t('terminal.agent.select_target'));
    return targets[0];
  }

  async function dispatchAgentCommand(agentSession, command, targetId = '', options = {}) {
    await initializeBeforeDelivery();
    const text = String(command || '').trim();
    if (!text) throw rejectedError(t('terminal.agent.command_required'));
    const target = requiredAgentTarget(agentSession, targetId);
    let result;
    if (target.kind === 'tmux') {
      result = await window.loadtoagent.tmuxSendText({
        distro: target.distro,
        target: target.paneNativeId,
        text,
        enter: true,
        deliveryId: options.deliveryId || '',
      });
    } else {
      if (target.reconnectable) {
        try {
          await window.loadtoagent.terminalReconnect(target.terminalId);
        } catch (error) {
          throw markRejectedBeforeDelivery(error);
        }
      }
      result = await window.loadtoagent.terminalCommand(target.terminalId, text, { deliveryId: options.deliveryId || '' });
    }
    if (!result || result.ok === false) throw resultError(result, t('terminal.agent.send_failed'));
    const deliveryState = normalizedDeliveryState(result);
    deliveryNotice(t(deliveryState === 'unknown'
      ? 'terminal.agent.delivery_uncertain'
      : 'terminal.agent.command_sent', { target: target.label }), deliveryState === 'unknown' ? 'warning' : 'success');
    return {
      ok: true,
      target,
      deliveryState,
      duplicate: Boolean(result.duplicate),
      promptSent: deliveryState === 'accepted',
    };
  }

  async function interruptAgent(target) {
    await init();
    if (!target) throw new Error(t('terminal.agent.interrupt_target_missing'));
    const result = target.kind === 'tmux'
      ? await window.loadtoagent.tmuxSendKey({
        distro: target.distro,
        target: target.paneNativeId,
        key: 'C-c',
      })
      : await window.loadtoagent.terminalSignal(target.terminalId, 'interrupt');
    if (result && result.ok === false) throw new Error(result.error || t('terminal.agent.interrupt_failed'));
    notice(t('terminal.agent.interrupt_sent', { target: target.label }), 'success');
    return { ok: true, target };
  }

  async function openForAgent(agentSession, targetId = '', draft = '') {
    await init();
    const target = requiredAgentTarget(agentSession, targetId);
    state.mode = target.kind === 'tmux' ? 'tmux' : 'general';
    moveWorkbench(state.mode);
    if (target.kind === 'tmux') {
      state.interactionMode = 'question';
      await selectTmux(target.distro, target.paneNativeId);
    } else {
      await selectSession(target.terminalId, 'question');
    }
    bindAgent(agentSession, target);
    queueHistoryRefresh(agentSession);
    renderTarget();
    const entry = target.kind === 'tmux' ? state.remoteTerminal : state.terminals.get(target.terminalId);
    fitEntry(entry, target.kind === 'tmux' ? '' : target.terminalId);
    const input = $('#terminalCommandInput');
    input.value = String(draft || '');
    state.commandDrafts.set(target.id, input.value);
    syncComposer?.();
    input.focus({ preventScroll: true });
    notice(t('terminal.agent.session_kept', { target: target.label }), 'success');
    return target;
  }

  async function resumeForAgent(agentSession, draft = '', sendDraft = false, options = {}) {
    await initializeBeforeDelivery();
    let support;
    try {
      support = resumeSupport(agentSession);
    } catch (error) {
      throw markRejectedBeforeDelivery(error);
    }
    if (!support.supported) throw rejectedError(support.reason);
    const cwd = String(agentSession.cwd || preferredWorkspace() || '').trim();
    if (!cwd) throw rejectedError(t('terminal.agent.cwd_missing'));
    const environment = agentSession.environment || {};
    const tmuxPresence = (agentSession.runtimePresence || []).find(item => item.kind === 'tmux') || {};
    const tmuxPresenceId = String(tmuxPresence.id || '');
    const distroFromPresenceId = tmuxPresenceId.startsWith('tmux:')
      ? tmuxPresenceId.slice(5, tmuxPresenceId.lastIndexOf(':'))
      : '';
    const wslCwd = state.platform.id === 'win32'
      && (environment.kind === 'wsl' || /^\/(?:mnt|home|root|workspace)(?:\/|$)/.test(cwd));
    const distro = wslCwd
      ? String(environment.distro || tmuxPresence.distro || distroFromPresenceId
        || (state.wslDistros.length === 1 ? state.wslDistros[0] : '')).trim()
      : '';
    if (wslCwd && !distro) throw rejectedError(t('terminal.agent.wsl_distro_missing'));
    const prompt = String(draft || '').trim();
    const nativeCommand = sendDraft && /^(?:\/|!)(?:\S|$)/.test(prompt);
    const title = t('terminal.agent.resume_title', {
      provider: providerLabel(agentSession.provider),
      session: agentSession.taskName || agentSession.agentName || t('terminal.type.session'),
    });
    // The drawer can still hold a stale "resume" projection while the terminal
    // created by the previous send is already running. Reuse the explicit
    // bridge target so a delayed receipt cannot spawn a second Claude process
    // for the same session and prompt.
    try {
      await refreshSessions();
    } catch (error) {
      throw markRejectedBeforeDelivery(error);
    }
    const reusable = state.sessions.find(session =>
      session
      && session.type === 'agent'
      && session.provider === support.provider
      && session.bridgeId === agentSession.id
      && session.status === 'running') || null;
    if (reusable) {
      let deliveryState = sendDraft && prompt ? 'accepted' : '';
      if (sendDraft && prompt) {
        const result = await window.loadtoagent.terminalCommand(reusable.id, prompt, { deliveryId: options.deliveryId || '' });
        if (!result || result.ok === false) throw resultError(result, t('terminal.agent.send_failed'));
        deliveryState = normalizedDeliveryState(result);
      }
      const target = {
        id: reusable.id,
        kind: 'terminal',
        label: reusable.title || title,
        detail: `${terminalLabel(reusable)} · ${t('session.program_pid', { pid: reusable.pid || '--' })}`,
        terminalId: reusable.id,
      };
      const promptSent = Boolean(sendDraft && prompt && deliveryState === 'accepted');
      if (options.focus === false) return { ...target, promptSent, deliveryState, background: true, reused: true };
      try {
        state.mode = 'general';
        moveWorkbench('general');
        await selectSession(reusable.id);
        bindAgent(agentSession, target);
        queueHistoryRefresh(agentSession);
        renderTarget();
        const input = $('#terminalCommandInput');
        if (input) {
          input.value = promptSent ? '' : String(draft || '');
          state.commandDrafts.set(target.id, input.value);
          syncComposer?.();
          input.focus({ preventScroll: true });
        }
      } catch (error) {
        if (!sendDraft) throw error;
        reportPostDeliveryError('terminal-agent-reused-focus', error);
      }
      deliveryNotice(deliveryState === 'unknown'
        ? t('terminal.agent.delivery_uncertain', { target: target.label })
        : sendDraft && prompt
          ? t('terminal.agent.resumed_and_sent', { provider: providerLabel(agentSession.provider), sessionId: support.sessionId.slice(0, 12) })
          : t('terminal.agent.reconnected', { provider: providerLabel(agentSession.provider), sessionId: support.sessionId.slice(0, 12) }),
      deliveryState === 'unknown' ? 'warning' : 'success');
      return { ...target, promptSent, deliveryState, reused: true };
    }
    const promptViaTerminal = Boolean(sendDraft && prompt
      && (nativeCommand || support.promptMode === 'terminal' || /[\r\n]/.test(prompt)));
    const promptInArgs = Boolean(sendDraft && prompt && !promptViaTerminal);
    let launchArgs;
    let recoveryArgs;
    try {
      launchArgs = resumeLaunchArgs(support, promptInArgs ? prompt : '');
      recoveryArgs = resumeLaunchArgs(support);
    } catch (error) {
      throw markRejectedBeforeDelivery(error);
    }
    const created = await window.loadtoagent.terminalCreate({
      type: 'agent',
      provider: support.provider,
      args: launchArgs,
      recoveryArgs,
      cwd,
      distro,
      bridgeId: agentSession.id,
      reuseBridge: true,
      initialCommand: sendDraft ? prompt : '',
      initialCommandInArgs: promptInArgs,
      deliveryId: options.deliveryId || '',
      title,
      // Conversation sends must keep the resumed PTY alive. A transient
      // one-shot process can exit after spawn (for example when the session is
      // busy) while the composer incorrectly reports that the prompt was sent.
      transient: false,
      cols: 120,
      rows: 32,
    });
    if (!created || !created.id) throw new Error(t('terminal.agent.resume_terminal_failed'));
    try {
      await refreshSessions();
    } catch (error) {
      reportPostDeliveryError('terminal-agent-post-create-refresh', error);
    }
    let deliveryState = normalizedDeliveryState(created, created.promptSent || promptInArgs ? 'accepted' : '');
    if (promptViaTerminal && !created.promptSent && deliveryState !== 'unknown') {
      const commandResult = await window.loadtoagent.terminalCommand(created.id, prompt, { deliveryId: options.deliveryId || '' });
      if (!commandResult || commandResult.ok === false) throw resultError(commandResult, t('terminal.agent.send_failed'));
      deliveryState = normalizedDeliveryState(commandResult);
    }
    const target = {
      id: created.id,
      kind: 'terminal',
      label: created.title || title,
      detail: `${terminalLabel(created)} · ${t('session.program_pid', { pid: created.pid || '--' })}`,
      terminalId: created.id,
    };
    const promptSent = Boolean(sendDraft && prompt && deliveryState === 'accepted');
    if (options.focus === false) return {
      ...target,
      promptSent,
      deliveryState,
      background: true,
      reused: Boolean(created.reused),
    };
    try {
      state.mode = 'general';
      moveWorkbench('general');
      await selectSession(created.id);
      bindAgent(agentSession, target);
      queueHistoryRefresh(agentSession);
      renderTarget();
      const input = $('#terminalCommandInput');
      if (input) {
        input.value = promptSent ? '' : String(draft || '');
        state.commandDrafts.set(target.id, input.value);
        syncComposer?.();
        input.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!sendDraft) throw error;
      reportPostDeliveryError('terminal-agent-created-focus', error);
    }
    deliveryNotice(deliveryState === 'unknown'
      ? t('terminal.agent.delivery_uncertain', { target: target.label })
      : sendDraft && prompt
        ? t('terminal.agent.resumed_and_sent', { provider: providerLabel(agentSession.provider), sessionId: support.sessionId.slice(0, 12) })
        : t('terminal.agent.reconnected', { provider: providerLabel(agentSession.provider), sessionId: support.sessionId.slice(0, 12) }),
    deliveryState === 'unknown' ? 'warning' : 'success');
    return { ...target, promptSent, deliveryState, reused: Boolean(created.reused) };
  }

  async function resetForAgent(agentSession, options = {}) {
    await init();
    const provider = String(agentSession?.provider || '').toLowerCase();
    if (!['claude', 'codex', 'gemini', 'grok'].includes(provider)) {
      throw new Error(t('terminal.resume.unsupported_provider', { provider: providerLabel(provider) }));
    }
    const cwd = String(agentSession.cwd || preferredWorkspace() || '').trim();
    if (!cwd) throw new Error(t('terminal.agent.cwd_missing'));
    const environment = agentSession.environment || {};
    const tmuxPresence = (agentSession.runtimePresence || []).find(item => item.kind === 'tmux') || {};
    const tmuxPresenceId = String(tmuxPresence.id || '');
    const distroFromPresenceId = tmuxPresenceId.startsWith('tmux:')
      ? tmuxPresenceId.slice(5, tmuxPresenceId.lastIndexOf(':'))
      : '';
    const wslCwd = state.platform.id === 'win32'
      && (environment.kind === 'wsl' || /^\/(?:mnt|home|root|workspace)(?:\/|$)/.test(cwd));
    const distro = wslCwd
      ? String(environment.distro || tmuxPresence.distro || distroFromPresenceId
        || (state.wslDistros.length === 1 ? state.wslDistros[0] : '')).trim()
      : '';
    if (wslCwd && !distro) throw new Error(t('terminal.agent.wsl_distro_missing'));
    const created = await window.loadtoagent.terminalCreate({
      type: 'agent',
      provider,
      args: [],
      cwd,
      distro,
      title: t('session.fresh_session_title', { provider: providerLabel(provider) }),
      transient: false,
      cols: 120,
      rows: 32,
    });
    if (!created?.id) throw new Error(t('session.reset_failed'));
    await refreshSessions();
    const target = {
      id: created.id,
      kind: 'terminal',
      label: created.title || providerLabel(provider),
      detail: `${terminalLabel(created)} · ${t('session.program_pid', { pid: created.pid || '--' })}`,
      terminalId: created.id,
    };
    if (options.focus === false) return { ...target, mode: 'new-session' };
    state.mode = 'general';
    moveWorkbench('general');
    await selectSession(created.id);
    renderTarget();
    $('#terminalCommandInput')?.focus({ preventScroll: true });
    return { ...target, mode: 'new-session' };
  }

  return {
    tmuxRows, agentTargets, requiredAgentTarget, dispatchAgentCommand, interruptAgent,
    openForAgent, resumeForAgent, resetForAgent,
  };
};
