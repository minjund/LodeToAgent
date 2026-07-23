'use strict';

/** Connect dashboard agent sessions to live or resumed terminal targets. */
window.LoadToAgentTerminalAgentActions = function createModule(context) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $, state, init, notice, moveWorkbench, selectTmux, selectSession, bindAgent, queueHistoryRefresh,
    renderTarget, fitEntry, refreshSessions, resumeSupport, resumeLaunchArgs, preferredWorkspace, providerLabel, esc,
  } = context;

  function tmuxRows(snapshot = state.snapshot) {
    const rows = [];
    for (const distro of snapshot && snapshot.tmux && snapshot.tmux.distros || []) {
      for (const session of distro.sessions || []) {
        for (const windowItem of session.windows || []) {
          for (const pane of windowItem.panes || []) rows.push({ distro, session, window: windowItem, pane });
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
      if (terminal.status !== 'running') continue;
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
        detail: `${String(terminal.type || '').toUpperCase()} · PID ${terminal.pid || '--'}`,
        terminalId: terminal.id,
      });
    }
    // The control-room composer is available before the terminal workbench has
    // necessarily loaded its own session list. Runtime presence already carries
    // the stable terminal id, so keep direct participation available from home.
    for (const item of presence.filter(entry => entry.kind === 'terminal' && entry.terminalId && !blockedTerminalIds.has(entry.terminalId)
      && (!agentSession.parentId || state.sessions.some(terminal => terminal.id === entry.terminalId && terminal.type !== 'agent')))) {
      if (targets.some(target => target.id === item.terminalId)) continue;
      const runtime = String(item.runtime || item.shell || 'PowerShell');
      targets.push({
        id: item.terminalId,
        kind: 'terminal',
        label: String(item.label || runtime),
        detail: `${runtime.toUpperCase()} · PID ${item.pid || '--'}`,
        terminalId: item.terminalId,
      });
    }
    return [...new Map(targets.map(target => [target.id, target])).values()];
  }

  function requiredAgentTarget(agentSession, targetId = '') {
    const targets = agentTargets(agentSession);
    if (!targets.length) throw new Error(t('terminal.agent.no_input_target'));
    if (targetId) {
      const selected = targets.find(target => target.id === targetId);
      if (!selected) throw new Error(t('terminal.agent.target_expired'));
      return selected;
    }
    if (targets.length > 1) throw new Error(t('terminal.agent.select_target'));
    return targets[0];
  }

  async function dispatchAgentCommand(agentSession, command, targetId = '') {
    await init();
    const text = String(command || '').trim();
    if (!text) throw new Error(t('terminal.agent.command_required'));
    const target = requiredAgentTarget(agentSession, targetId);
    const result = target.kind === 'tmux'
      ? await window.loadtoagent.tmuxSendText({ distro: target.distro, target: target.paneNativeId, text, enter: true })
      : await window.loadtoagent.terminalCommand(target.terminalId, text);
    if (!result || result.ok === false) throw new Error(result && result.error || t('terminal.agent.send_failed'));
    notice(t('terminal.agent.command_sent', { target: target.label }), 'success');
    return { ok: true, target };
  }

  async function openForAgent(agentSession, targetId = '', draft = '') {
    await init();
    const target = requiredAgentTarget(agentSession, targetId);
    state.mode = target.kind === 'tmux' ? 'tmux' : 'general';
    moveWorkbench(state.mode);
    if (target.kind === 'tmux') await selectTmux(target.distro, target.paneNativeId);
    else await selectSession(target.terminalId);
    bindAgent(agentSession, target);
    queueHistoryRefresh(agentSession);
    renderTarget();
    const entry = target.kind === 'tmux' ? state.remoteTerminal : state.terminals.get(target.terminalId);
    fitEntry(entry, target.kind === 'tmux' ? '' : target.terminalId);
    const input = $('#terminalCommandInput');
    input.value = String(draft || '');
    state.commandDrafts.set(target.id, input.value);
    input.focus({ preventScroll: true });
    notice(t('terminal.agent.session_kept', { target: target.label }), 'success');
    return target;
  }

  async function resumeForAgent(agentSession, draft = '', sendDraft = false, options = {}) {
    await init();
    const support = resumeSupport(agentSession);
    if (!support.supported) throw new Error(support.reason);
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
    const prompt = String(draft || '').trim();
    const title = t('terminal.agent.resume_title', {
      provider: providerLabel(agentSession.provider),
      session: agentSession.taskName || agentSession.agentName || t('terminal.type.session'),
    });
    const created = await window.loadtoagent.terminalCreate({
      type: 'agent',
      provider: support.provider,
      args: resumeLaunchArgs(support, sendDraft ? prompt : '', { background: options.focus === false }),
      cwd,
      distro,
      bridgeId: agentSession.id,
      title,
      transient: options.focus === false,
      cols: 120,
      rows: 32,
    });
    if (!created || !created.id) throw new Error(t('terminal.agent.resume_terminal_failed'));
    await refreshSessions();
    const target = {
      id: created.id,
      kind: 'terminal',
      label: created.title || title,
      detail: `${String(created.type || 'agent').toUpperCase()} · PID ${created.pid || '--'}`,
      terminalId: created.id,
    };
    if (options.focus === false) return { ...target, promptSent: Boolean(sendDraft && prompt), background: true };
    state.mode = 'general';
    moveWorkbench('general');
    await selectSession(created.id);
    bindAgent(agentSession, target);
    queueHistoryRefresh(agentSession);
    renderTarget();
    const input = $('#terminalCommandInput');
    if (input) {
      input.value = sendDraft ? '' : String(draft || '');
      state.commandDrafts.set(target.id, input.value);
      input.focus({ preventScroll: true });
    }
    notice(sendDraft && prompt
      ? t('terminal.agent.resumed_and_sent', { provider: providerLabel(agentSession.provider), sessionId: support.sessionId.slice(0, 12) })
      : t('terminal.agent.reconnected', { provider: providerLabel(agentSession.provider), sessionId: support.sessionId.slice(0, 12) }), 'success');
    return { ...target, promptSent: Boolean(sendDraft && prompt) };
  }

  return { tmuxRows, agentTargets, requiredAgentTarget, dispatchAgentCommand, openForAgent, resumeForAgent };
};
