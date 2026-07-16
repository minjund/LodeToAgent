'use strict';

/** Own xterm views, terminal/tmux selection, capture, and management actions. */
window.LoadToAgentTerminalWorkbench = function createModule(context) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $, state, notice, setConnectionState, currentSession, currentTmux, saveCurrentDraft, restoreCurrentDraft,
    renderHistoryPanel, terminalTypeMark, terminalTypeLabel, xtermOptions, preferredWorkspace, firstDistro, guarded,
    esc, errorMessage, modeSessions, STATUS_LABELS, visibleBoundAgent, moveWorkbench, tmuxRows, updateSnapshot,
  } = context;

  function createXtermHost(key, readOnly = false) {
    if (!window.Terminal || !window.FitAddon || !window.FitAddon.FitAddon) throw new Error(t('terminal.error.screen_unavailable'));
    const host = document.createElement('div');
    host.className = 'terminal-screen hidden';
    host.dataset.terminalScreen = key;
    $('#terminalViewport').appendChild(host);
    const terminal = new window.Terminal(xtermOptions(readOnly));
    const fit = new window.FitAddon.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const syncScrollState = viewportY => {
      host.dataset.viewportY = String(Number(viewportY) || 0);
      host.dataset.baseY = String(Number(terminal.buffer.active.baseY) || 0);
    };
    terminal.onScroll(syncScrollState);
    syncScrollState(0);
    const entry = { terminal, fit, host, readOnly };
    if (readOnly) {
      const rememberUserViewport = () => requestAnimationFrame(() => {
        const buffer = terminal.buffer.active;
        state.remoteViewportAnchor = Number(buffer.viewportY) || 0;
        state.remoteViewportAtBottom = state.remoteViewportAnchor >= Number(buffer.baseY || 0);
      });
      host.addEventListener('wheel', rememberUserViewport, { passive: true });
      host.addEventListener('pointerup', rememberUserViewport);
      host.addEventListener('keyup', event => {
        if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) rememberUserViewport();
      });
    }
    if (!readOnly) {
      terminal.onData(data => {
        if (state.selectedId === key) Promise.resolve(window.loadtoagent.terminalWrite(key, data)).catch(error => notice(errorMessage(error), 'error'));
      });
      terminal.onResize(size => {
        Promise.resolve(window.loadtoagent.terminalResize(key, size.cols, size.rows)).catch(error => {
          window.LoadToAgentRendererUtils.reportRecoverableError('terminal-resize', error);
        });
      });
    }
    return entry;
  }

  function fitEntry(entry, sessionId = '') {
    if (!entry || entry.host.classList.contains('hidden')) return;
    requestAnimationFrame(() => {
      try {
        entry.fit.fit();
        if (sessionId) {
          Promise.resolve(window.loadtoagent.terminalResize(sessionId, entry.terminal.cols, entry.terminal.rows)).catch(error => {
            window.LoadToAgentRendererUtils.reportRecoverableError('terminal-fit-resize', error);
          });
        }
      } catch (error) {
        window.LoadToAgentRendererUtils.reportRecoverableError('terminal-fit', error);
      }
    });
  }

  async function ensureSessionTerminal(session) {
    let entry = state.terminals.get(session.id);
    if (!entry) {
      entry = createXtermHost(session.id, false);
      state.terminals.set(session.id, entry);
      const detail = await window.loadtoagent.terminalGet(session.id);
      if (detail && detail.replay) entry.terminal.write(detail.replay);
    }
    return entry;
  }

  function ensureRemoteTerminal() {
    if (!state.remoteTerminal) state.remoteTerminal = createXtermHost('__tmux_remote__', true);
    return state.remoteTerminal;
  }

  function hideScreens() {
    for (const entry of state.terminals.values()) entry.host.classList.add('hidden');
    if (state.remoteTerminal) state.remoteTerminal.host.classList.add('hidden');
    $('#terminalEmpty').classList.add('hidden');
  }

  function renderSessions() {
    const general = modeSessions('general');
    const running = general.filter(item => item.status === 'running').length;
    const background = general.filter(item => item.background && item.status === 'running').length;
    $('#navTerminalCount').textContent = running;
    $('#terminalSessionSummary').textContent = [
      window.LoadToAgentI18n.t('common.active', { count: running }),
      background ? window.LoadToAgentI18n.t('session.background_count', { count: background }) : '',
      window.LoadToAgentI18n.t('session.total_count', { count: general.length }),
    ].filter(Boolean).join(' · ');
    $('#terminalSessionList').innerHTML = general.length ? general.map((session, index) => `
      <div class="terminal-session-row">
        <button type="button" draggable="true"
          class="terminal-session-item ${state.selectedId === session.id ? 'active' : ''}"
          data-terminal-id="${esc(session.id)}"
          aria-grabbed="false"
          aria-describedby="terminalReorderHelp"
          title="${esc(window.LoadToAgentI18n.t('terminal.reorder_hint'))}">
          <span class="terminal-session-icon">${esc(terminalTypeMark(session))}</span>
          <span><b>${esc(session.title)}</b><small>${esc(terminalTypeLabel(session))}${session.background ? ` · ${t('terminal.background_kept')}` : ''} · ${esc(STATUS_LABELS[session.status] || session.status)}</small><em>${esc(session.cwd || session.distro || `PID ${session.pid || '--'}`)}</em><span class="sr-only">${index + 1}/${general.length}</span></span>
          <i class="${session.status === 'running' ? 'live' : ''}"></i>
        </button>
        <span class="terminal-reorder-actions" aria-label="${esc(window.LoadToAgentI18n.t('terminal.reorder_group', { title: session.title }))}">
          <button type="button" data-session-move="-1" data-session-move-id="${esc(session.id)}" aria-label="${esc(window.LoadToAgentI18n.t('terminal.move_up', { title: session.title }))}" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-session-move="1" data-session-move-id="${esc(session.id)}" aria-label="${esc(window.LoadToAgentI18n.t('terminal.move_down', { title: session.title }))}" ${index === general.length - 1 ? 'disabled' : ''}>↓</button>
        </span>
      </div>`).join('') : `<div class="terminal-resource-empty">${t('terminal.empty.general')}</div>`;
  }

  function renderTmuxResources() {
    const distros = state.snapshot && state.snapshot.tmux && state.snapshot.tmux.distros || [];
    if (!distros.length) {
      $('#terminalTmuxList').innerHTML = `<div class="terminal-resource-empty">${t('terminal.empty.tmux')}</div>`;
      return;
    }
    $('#terminalTmuxList').innerHTML = distros.map(distro => `
      <section class="terminal-tmux-group">
        <header><b>${esc(distro.name)}</b><span>${t('terminal.tmux.workspace_count', { count: (distro.sessions || []).length })}</span></header>
        ${(distro.sessions || []).map(session => `
          <div class="terminal-tmux-session"><strong>${esc(session.name)}</strong><small>${session.attached ? t('terminal.tmux.attached') : t('terminal.tmux.running_background')}</small></div>
          ${(session.windows || []).flatMap(windowItem => (windowItem.panes || []).map(pane => `
            <button type="button" class="terminal-tmux-pane ${state.selectedTmux && state.selectedTmux.distro.name === distro.name && state.selectedTmux.pane.nativeId === pane.nativeId ? 'active' : ''}" data-tmux-distro="${esc(distro.name)}" data-tmux-pane="${esc(pane.nativeId)}">
              <span><b>${esc(pane.nativeId)} · ${esc(windowItem.index)}:${esc(windowItem.name)}</b><small>${esc(pane.command || 'shell')} · ${esc(pane.cwd || t('terminal.path_unreported'))}</small></span>
              <i class="${pane.agent ? 'agent' : (pane.active ? 'live' : '')}">${pane.agent ? 'AI' : (pane.active ? 'ON' : '')}</i>
            </button>`)).join('')}`).join('')}
      </section>`).join('');
  }

  function renderTarget() {
    const session = currentSession();
    const remote = currentTmux();
    const bound = visibleBoundAgent();
    const hasTarget = Boolean(session || remote);
    const canInput = Boolean((remote && !remote.pane.dead) || (session && session.status === 'running'));
    const closeButton = $('#terminalCloseBtn');
    closeButton.disabled = !hasTarget;
    closeButton.textContent = remote && !session ? t('terminal.clear_selection') : t('ui.end_session');
    closeButton.classList.toggle('terminal-danger-button', Boolean(session));
    $('#terminalRestartBtn').classList.toggle('hidden', !session || session.status === 'running' || session.type === 'agent');
    $('#terminalRestartBtn').disabled = !session || session.status === 'running';
    $('#terminalCommandInput').disabled = !canInput;
    const commandForm = $('#terminalCommandForm');
    const commandButton = commandForm.querySelector('button');
    commandButton.disabled = !canInput || state.commandSending;
    commandForm.toggleAttribute('aria-busy', state.commandSending);
    const commandButtonLabel = commandButton.querySelector('span');
    if (commandButtonLabel) commandButtonLabel.textContent = state.commandSending ? t('terminal.sending') : t('common.send');
    document.querySelectorAll('[data-terminal-signal]').forEach(button => { button.disabled = !canInput; });
    $('#terminalAttachBtn').classList.toggle('hidden', !remote || Boolean(session));
    $('#terminalTmuxTools').classList.toggle('hidden', !remote || Boolean(session));
    if (session) {
      setConnectionState(STATUS_LABELS[session.status] || session.status, session.status);
      $('#terminalTargetIcon').textContent = terminalTypeMark(session);
      $('#terminalTargetMeta').innerHTML = `<b>${esc(session.title)}</b><span>${bound ? `● ${t('terminal.bound_ai_session')} · ` : ''}${esc(session.type.toUpperCase())} · PID ${session.pid || '--'} · ${esc(session.cwd || session.distro || '')}</span>`;
      $('#terminalConsoleCaption').textContent = `${terminalTypeLabel(session)} · PID ${session.pid || '--'}`;
      $('#terminalConsoleState').textContent = canInput ? window.LoadToAgentI18n.t("ui.direct_input_available") : window.LoadToAgentI18n.t("ui.ended_session");
      $('#terminalConsoleState').dataset.status = session.status;
    } else if (remote) {
      setConnectionState(remote.pane.dead ? t('terminal.tmux.ended_pane') : t('terminal.tmux.connected'), remote.pane.dead ? 'exited' : 'running');
      $('#terminalTargetIcon').textContent = 'tm';
      $('#terminalTargetMeta').innerHTML = `<b>${esc(remote.distro.name)} · ${esc(remote.session.name)} · ${esc(remote.pane.nativeId)}</b><span>${esc(remote.window.index)}:${esc(remote.window.name)} · ${esc(remote.pane.command || 'shell')} · ${esc(remote.pane.cwd || '')}</span>`;
      $('#terminalConsoleCaption').textContent = `${remote.window.index}:${remote.window.name} · ${remote.pane.command || 'shell'}`;
      $('#terminalConsoleState').textContent = remote.pane.dead ? window.LoadToAgentI18n.t("ui.ended_pane") : window.LoadToAgentI18n.t("ui.ready_for_commands");
      $('#terminalConsoleState').dataset.status = remote.pane.dead ? 'exited' : 'running';
    } else {
      setConnectionState(window.LoadToAgentI18n.t("ui.waiting_for_selection"));
      $('#terminalTargetIcon').textContent = '›_';
      $('#terminalTargetMeta').innerHTML = state.mode === 'tmux'
        ? `<b>${t('terminal.tmux.no_selection_title')}</b><span>${t('terminal.tmux.no_selection_description')}</span>`
        : `<b>${window.LoadToAgentI18n.t("ui.select_a_session")}</b><span>${window.LoadToAgentI18n.t("ui.choose_a_session_on_the_left_or_create_a_new")}</span>`;
      $('#terminalConsoleCaption').textContent = window.LoadToAgentI18n.t("ui.select_a_session_to_show_its_output_here");
      $('#terminalConsoleState').textContent = window.LoadToAgentI18n.t("ui.waiting_for_selection");
      $('#terminalConsoleState').dataset.status = '';
    }
    const commandLabel = $('#terminalCommandLabel');
    const commandInput = $('#terminalCommandInput');
    if (commandLabel) commandLabel.textContent = bound ? window.LoadToAgentI18n.t("ui.continue_instructing_ai") : (remote ? window.LoadToAgentI18n.t("ui.send_to_tmux_terminal") : window.LoadToAgentI18n.t("ui.send_command_to_terminal"));
    if (commandInput) commandInput.placeholder = !hasTarget
      ? window.LoadToAgentI18n.t("ui.select_a_session_on_the_left_first")
      : (bound ? t('terminal.command.continue_ai_placeholder') : t('ui.enter_a_command_to_run'));
    renderHistoryPanel();
  }

  async function showSelection() {
    hideScreens();
    const session = currentSession();
    const remote = currentTmux();
    if (session) {
      const entry = await ensureSessionTerminal(session);
      entry.host.classList.remove('hidden');
      fitEntry(entry, session.id);
      stopCapture();
    } else if (remote) {
      const entry = ensureRemoteTerminal();
      entry.host.classList.remove('hidden');
      fitEntry(entry);
      startCapture();
    } else {
      $('#terminalEmpty').classList.remove('hidden');
      stopCapture();
    }
    renderTarget();
  }

  async function selectSession(id) {
    saveCurrentDraft();
    state.captureGeneration += 1;
    state.selectedId = id;
    state.selectedTmux = null;
    renderSessions();
    renderTmuxResources();
    await showSelection();
    restoreCurrentDraft();
  }

  async function selectTmux(distroName, paneId) {
    const row = tmuxRows().find(item => item.distro.name === distroName && item.pane.nativeId === paneId);
    if (!row) return notice(t('terminal.error.selected_split_missing'), 'error');
    saveCurrentDraft();
    state.captureGeneration += 1;
    state.selectedId = null;
    state.selectedTmux = row;
    state.remoteCapture = '';
    state.remoteViewportAnchor = null;
    state.remoteViewportAtBottom = false;
    if (state.remoteTerminal) state.remoteTerminal.terminal.clear();
    renderSessions();
    renderTmuxResources();
    await showSelection();
    restoreCurrentDraft();
  }

  async function selectTmuxById(paneId) {
    const row = tmuxRows().find(item => item.pane.id === paneId || item.pane.nativeId === paneId);
    if (!row) return notice(t('terminal.error.selected_tmux_missing'), 'error');
    state.mode = 'tmux';
    moveWorkbench('tmux');
    return selectTmux(row.distro.name, row.pane.nativeId);
  }

  function renderAll() {
    renderSessions();
    renderTmuxResources();
    renderTarget();
  }

  async function refreshSessions(payload = null) {
    const nextSessions = payload && Array.isArray(payload.sessions) ? payload.sessions : await window.loadtoagent.terminalList();
    state.sessions = Array.isArray(nextSessions) ? nextSessions : [];
    const activeIds = new Set(state.sessions.map(session => session.id));
    for (const [id, entry] of state.terminals) {
      if (activeIds.has(id)) continue;
      entry.terminal.dispose();
      entry.host.remove();
      state.terminals.delete(id);
      state.commandDrafts.delete(id);
    }
    if (state.selectedId && !state.sessions.some(item => item.id === state.selectedId)) state.selectedId = null;
    renderAll();
    if (state.active) await showSelection();
  }

  async function createTerminal(type) {
    const distro = type === 'wsl' ? firstDistro() : null;
    if (type === 'wsl' && !distro) return notice(t('terminal.error.no_linux_environment'), 'error');
    const created = await guarded(() => window.loadtoagent.terminalCreate({
      type,
      cwd: (type === 'powershell' || type === 'shell') ? (preferredWorkspace() || undefined) : undefined,
      distro: distro && distro.name,
      title: type === 'powershell' ? 'PowerShell' : (type === 'shell' ? state.platform.localShellLabel : t('terminal.linux_shell_title', { distro: distro.name })),
      cols: 120,
      rows: 32,
    }), t('terminal.opened', { platform: type === 'powershell' ? 'Windows' : (type === 'shell' ? state.platform.label : 'Linux') }));
    if (!created) return;
    await refreshSessions();
    await selectSession(created.id);
  }

  async function captureRemote() {
    if (state.captureInFlight) return;
    const remote = currentTmux();
    if (!remote || !state.active || state.selectedId) return;
    const captureKey = `${remote.distro.name}:${remote.pane.nativeId}`;
    const captureGeneration = state.captureGeneration;
    state.captureInFlight = true;
    try {
      const result = await guarded(() => window.loadtoagent.tmuxCapture({ distro: remote.distro.name, target: remote.pane.nativeId, lines: 1_500 }));
      const current = currentTmux();
      if (!current || `${current.distro.name}:${current.pane.nativeId}` !== captureKey) return;
      if (!result || typeof result.output !== 'string' || result.output === state.remoteCapture) return;
      const firstCapture = !state.remoteCapture;
      state.remoteCapture = result.output;
      const entry = ensureRemoteTerminal();
      const buffer = entry.terminal.buffer.active;
      const previousViewport = state.remoteViewportAnchor == null
        ? Number(buffer && buffer.viewportY || 0)
        : state.remoteViewportAnchor;
      const wasAtBottom = state.remoteViewportAnchor == null
        ? Boolean(buffer && buffer.viewportY >= buffer.baseY)
        : state.remoteViewportAtBottom;
      entry.terminal.reset();
      await new Promise(resolve => entry.terminal.write(result.output.replace(/\n/g, '\r\n'), resolve));
      const selected = currentTmux();
      if (!state.active || captureGeneration !== state.captureGeneration || !selected || `${selected.distro.name}:${selected.pane.nativeId}` !== captureKey) {
        entry.terminal.reset();
        state.remoteCapture = '';
        setTimeout(captureRemote, 0);
        return;
      }
      requestAnimationFrame(() => {
        const latest = currentTmux();
        if (captureGeneration !== state.captureGeneration || !latest || `${latest.distro.name}:${latest.pane.nativeId}` !== captureKey) return;
        if (firstCapture) {
          entry.terminal.scrollToTop();
          state.remoteViewportAnchor = 0;
          state.remoteViewportAtBottom = false;
        } else if (state.remoteViewportAnchor == null ? wasAtBottom : state.remoteViewportAtBottom) entry.terminal.scrollToBottom();
        else entry.terminal.scrollToLine(state.remoteViewportAnchor == null ? previousViewport : state.remoteViewportAnchor);
        state.captureRevision += 1;
        entry.host.dataset.captureRevision = String(state.captureRevision);
      });
    } finally {
      state.captureInFlight = false;
    }
  }

  function startCapture() {
    stopCapture();
    captureRemote();
    state.captureTimer = setInterval(captureRemote, 1_000);
  }

  function stopCapture() {
    if (state.captureTimer) clearInterval(state.captureTimer);
    state.captureTimer = null;
  }

  async function sendCommand(command) {
    const text = String(command || '');
    if (state.commandSending) return false;
    if (!text.trim()) {
      notice(t('terminal.command.required'), 'error');
      return false;
    }
    const session = currentSession();
    const remote = currentTmux();
    if (!session && !remote) {
      notice(t('terminal.command.select_first'), 'error');
      return false;
    }
    state.commandSending = true;
    renderTarget();
    try {
      const result = session
        ? await guarded(() => window.loadtoagent.terminalCommand(session.id, text), t('terminal.command.sent'))
        : await guarded(() => window.loadtoagent.tmuxSendText({ distro: remote.distro.name, target: remote.pane.nativeId, text, enter: true }), t('terminal.command.executed_in_split'));
      if (result && remote) setTimeout(captureRemote, 160);
      return Boolean(result);
    } finally {
      state.commandSending = false;
      renderTarget();
    }
  }

  async function sendSignal(signal) {
    const session = currentSession();
    const remote = currentTmux();
    if (session) return guarded(() => window.loadtoagent.terminalSignal(session.id, signal), signal === 'interrupt' ? t('terminal.signal.interrupt_sent') : t('terminal.signal.cleared'));
    if (remote) {
      const key = signal === 'interrupt' ? 'C-c' : 'C-l';
      return guarded(() => window.loadtoagent.tmuxSendKey({ distro: remote.distro.name, target: remote.pane.nativeId, key }), t('terminal.signal.key_sent', { key }));
    }
    notice(t('terminal.command.select_first'), 'error');
  }

  function openTmuxModal() {
    window.LoadToAgentA11y?.rememberDialogTrigger();
    const distros = state.snapshot && state.snapshot.tmux && state.snapshot.tmux.distros || [];
    $('#tmuxCreateDistro').innerHTML = distros.map(item => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join('');
    $('#tmuxCreateError').classList.add('hidden');
    $('#tmuxCreateModal').classList.remove('hidden');
    $('#tmuxCreateName').focus();
  }

  function closeTmuxModal() {
    $('#tmuxCreateModal').classList.add('hidden');
    $('#tmuxCreateForm').reset();
    window.LoadToAgentA11y?.restoreDialogTrigger();
  }

  async function refreshSnapshot() {
    const snapshot = await guarded(() => window.loadtoagent.snapshot(), t('terminal.tmux.refreshed'));
    if (snapshot) updateSnapshot(snapshot, state.workspaces);
  }

  async function attachTmux() {
    const remote = currentTmux();
    if (!remote) return;
    const created = await guarded(() => window.loadtoagent.terminalCreate({
      type: 'tmux',
      distro: remote.distro.name,
      tmuxSession: remote.session.name,
      tmuxPane: remote.pane.nativeId,
      title: `tmux · ${remote.session.name} · ${remote.pane.nativeId}`,
      cols: 120,
      rows: 32,
    }), t('terminal.tmux.attached_for_input'));
    if (!created) return;
    await refreshSessions();
    await selectSession(created.id);
  }

  async function manageTmux(action) {
    const remote = currentTmux();
    if (!remote) return;
    const base = { distro: remote.distro.name };
    let operation = null;
    let message = '';
    if (action === 'rename-session') {
      const name = window.prompt(t('terminal.tmux.prompt_workspace_name'), remote.session.name);
      if (!name || name === remote.session.name) return;
      operation = () => window.loadtoagent.tmuxRenameSession({ ...base, target: remote.session.nativeId, name });
      message = t('terminal.tmux.workspace_renamed');
    } else if (action === 'new-window') {
      const name = window.prompt(t('terminal.tmux.prompt_window_name'), 'window');
      if (!name) return;
      operation = () => window.loadtoagent.tmuxNewWindow({ ...base, target: remote.session.nativeId, name, cwd: remote.pane.cwd });
      message = t('terminal.tmux.window_created');
    } else if (action === 'split-horizontal' || action === 'split-vertical') {
      operation = () => window.loadtoagent.tmuxSplitPane({ ...base, target: remote.pane.nativeId, direction: action === 'split-horizontal' ? 'horizontal' : 'vertical', cwd: remote.pane.cwd });
      message = t('terminal.tmux.pane_split');
    } else if (action === 'kill-pane') {
      if (!window.confirm(t('terminal.tmux.confirm_close_pane', { pane: remote.pane.nativeId }))) return;
      operation = () => window.loadtoagent.tmuxKillPane({ ...base, target: remote.pane.nativeId });
      message = t('terminal.tmux.pane_closed');
    } else if (action === 'kill-window') {
      if (!window.confirm(t('terminal.tmux.confirm_close_window', { window: `${remote.window.index}:${remote.window.name}` }))) return;
      operation = () => window.loadtoagent.tmuxKillWindow({ ...base, target: remote.window.nativeId });
      message = t('terminal.tmux.window_closed');
    } else if (action === 'kill-session') {
      if (!window.confirm(t('terminal.tmux.confirm_end_workspace', { workspace: remote.session.name }))) return;
      operation = () => window.loadtoagent.tmuxKillSession({ ...base, target: remote.session.nativeId });
      message = t('terminal.tmux.workspace_ended');
    }
    if (!operation) return;
    const result = await guarded(operation, message);
    if (result) {
      if (action.startsWith('kill-')) {
        stopCapture();
        state.captureGeneration += 1;
        state.selectedTmux = null;
        state.remoteCapture = '';
        state.remoteViewportAnchor = null;
        state.remoteViewportAtBottom = false;
        if (state.remoteTerminal) state.remoteTerminal.terminal.reset();
        renderAll();
        await showSelection();
      }
      setTimeout(refreshSnapshot, 300);
    }
  }

  return { createXtermHost, fitEntry, ensureSessionTerminal, ensureRemoteTerminal, hideScreens, renderSessions, renderTmuxResources, renderTarget, showSelection, selectSession, selectTmux, selectTmuxById, renderAll, refreshSessions, createTerminal, captureRemote, startCapture, stopCapture, sendCommand, sendSignal, openTmuxModal, closeTmuxModal, refreshSnapshot, attachTmux, manageTmux };
};
