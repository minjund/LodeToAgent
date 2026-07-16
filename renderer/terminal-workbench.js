'use strict';

/** Own xterm views, terminal/tmux selection, capture, and management actions. */
window.LoadToAgentTerminalWorkbench = function createModule(context) {
  const {
    $, state, notice, setConnectionState, currentSession, currentTmux, saveCurrentDraft, restoreCurrentDraft,
    renderHistoryPanel, terminalTypeMark, terminalTypeLabel, xtermOptions, preferredWorkspace, firstDistro, guarded,
    esc, errorMessage, modeSessions, STATUS_LABELS, visibleBoundAgent, moveWorkbench, tmuxRows, updateSnapshot,
  } = context;

  function createXtermHost(key, readOnly = false) {
    if (!window.Terminal || !window.FitAddon || !window.FitAddon.FitAddon) throw new Error('명령창 화면을 불러오지 못했습니다.');
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
          <span><b>${esc(session.title)}</b><small>${esc(terminalTypeLabel(session))}${session.background ? ' · 백그라운드 유지' : ''} · ${esc(STATUS_LABELS[session.status] || session.status)}</small><em>${esc(session.cwd || session.distro || `PID ${session.pid || '--'}`)}</em><span class="sr-only">${index + 1}/${general.length}</span></span>
          <i class="${session.status === 'running' ? 'live' : ''}"></i>
        </button>
        <span class="terminal-reorder-actions" aria-label="${esc(window.LoadToAgentI18n.t('terminal.reorder_group', { title: session.title }))}">
          <button type="button" data-session-move="-1" data-session-move-id="${esc(session.id)}" aria-label="${esc(window.LoadToAgentI18n.t('terminal.move_up', { title: session.title }))}" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-session-move="1" data-session-move-id="${esc(session.id)}" aria-label="${esc(window.LoadToAgentI18n.t('terminal.move_down', { title: session.title }))}" ${index === general.length - 1 ? 'disabled' : ''}>↓</button>
        </span>
      </div>`).join('') : '<div class="terminal-resource-empty">열어 둔 일반 명령창이 없습니다.</div>';
  }

  function renderTmuxResources() {
    const distros = state.snapshot && state.snapshot.tmux && state.snapshot.tmux.distros || [];
    if (!distros.length) {
      $('#terminalTmuxList').innerHTML = '<div class="terminal-resource-empty">Linux에서 나눠 실행 중인 작업이 없습니다.</div>';
      return;
    }
    $('#terminalTmuxList').innerHTML = distros.map(distro => `
      <section class="terminal-tmux-group">
        <header><b>${esc(distro.name)}</b><span>작업 묶음 ${(distro.sessions || []).length}개</span></header>
        ${(distro.sessions || []).map(session => `
          <div class="terminal-tmux-session"><strong>${esc(session.name)}</strong><small>${session.attached ? '화면에 연결됨' : '뒤에서 실행 중'}</small></div>
          ${(session.windows || []).flatMap(windowItem => (windowItem.panes || []).map(pane => `
            <button type="button" class="terminal-tmux-pane ${state.selectedTmux && state.selectedTmux.distro.name === distro.name && state.selectedTmux.pane.nativeId === pane.nativeId ? 'active' : ''}" data-tmux-distro="${esc(distro.name)}" data-tmux-pane="${esc(pane.nativeId)}">
              <span><b>${esc(pane.nativeId)} · ${esc(windowItem.index)}:${esc(windowItem.name)}</b><small>${esc(pane.command || 'shell')} · ${esc(pane.cwd || '경로 미보고')}</small></span>
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
    closeButton.textContent = remote && !session ? '선택 해제' : window.LoadToAgentI18n.t("ui.end_session");
    closeButton.classList.toggle('terminal-danger-button', Boolean(session));
    $('#terminalRestartBtn').classList.toggle('hidden', !session || session.status === 'running' || session.type === 'agent');
    $('#terminalRestartBtn').disabled = !session || session.status === 'running';
    $('#terminalCommandInput').disabled = !canInput;
    const commandForm = $('#terminalCommandForm');
    const commandButton = commandForm.querySelector('button');
    commandButton.disabled = !canInput || state.commandSending;
    commandForm.toggleAttribute('aria-busy', state.commandSending);
    const commandButtonLabel = commandButton.querySelector('span');
    if (commandButtonLabel) commandButtonLabel.textContent = state.commandSending ? '보내는 중' : window.LoadToAgentI18n.t("common.send");
    document.querySelectorAll('[data-terminal-signal]').forEach(button => { button.disabled = !canInput; });
    $('#terminalAttachBtn').classList.toggle('hidden', !remote || Boolean(session));
    $('#terminalTmuxTools').classList.toggle('hidden', !remote || Boolean(session));
    if (session) {
      setConnectionState(STATUS_LABELS[session.status] || session.status, session.status);
      $('#terminalTargetIcon').textContent = terminalTypeMark(session);
      $('#terminalTargetMeta').innerHTML = `<b>${esc(session.title)}</b><span>${bound ? '● 기존 AI 세션 유지 중 · ' : ''}${esc(session.type.toUpperCase())} · PID ${session.pid || '--'} · ${esc(session.cwd || session.distro || '')}</span>`;
      $('#terminalConsoleCaption').textContent = `${terminalTypeLabel(session)} · PID ${session.pid || '--'}`;
      $('#terminalConsoleState').textContent = canInput ? window.LoadToAgentI18n.t("ui.direct_input_available") : window.LoadToAgentI18n.t("ui.ended_session");
      $('#terminalConsoleState').dataset.status = session.status;
    } else if (remote) {
      setConnectionState(remote.pane.dead ? '종료된 tmux 칸' : 'tmux 연결됨', remote.pane.dead ? 'exited' : 'running');
      $('#terminalTargetIcon').textContent = 'tm';
      $('#terminalTargetMeta').innerHTML = `<b>${esc(remote.distro.name)} · ${esc(remote.session.name)} · ${esc(remote.pane.nativeId)}</b><span>${esc(remote.window.index)}:${esc(remote.window.name)} · ${esc(remote.pane.command || 'shell')} · ${esc(remote.pane.cwd || '')}</span>`;
      $('#terminalConsoleCaption').textContent = `${remote.window.index}:${remote.window.name} · ${remote.pane.command || 'shell'}`;
      $('#terminalConsoleState').textContent = remote.pane.dead ? window.LoadToAgentI18n.t("ui.ended_pane") : window.LoadToAgentI18n.t("ui.ready_for_commands");
      $('#terminalConsoleState').dataset.status = remote.pane.dead ? 'exited' : 'running';
    } else {
      setConnectionState(window.LoadToAgentI18n.t("ui.waiting_for_selection"));
      $('#terminalTargetIcon').textContent = '›_';
      $('#terminalTargetMeta').innerHTML = state.mode === 'tmux'
        ? '<b>아직 선택한 tmux 명령창이 없습니다</b><span>왼쪽 tmux 목록이나 위 지도에서 조작할 칸을 선택하세요.</span>'
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
      : (bound ? '이전 대화에 이어서 AI에게 지시할 내용을 입력하세요' : window.LoadToAgentI18n.t("ui.enter_a_command_to_run"));
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
    if (!row) return notice('선택한 나눠진 명령창을 찾을 수 없습니다.', 'error');
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
    if (!row) return notice('선택한 tmux 명령창을 찾을 수 없습니다.', 'error');
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
    if (type === 'wsl' && !distro) return notice('사용 가능한 Linux 환경이 없습니다.', 'error');
    const created = await guarded(() => window.loadtoagent.terminalCreate({
      type,
      cwd: (type === 'powershell' || type === 'shell') ? (preferredWorkspace() || undefined) : undefined,
      distro: distro && distro.name,
      title: type === 'powershell' ? 'PowerShell' : (type === 'shell' ? state.platform.localShellLabel : `${distro.name} 셸`),
      cols: 120,
      rows: 32,
    }), `${type === 'powershell' ? 'Windows' : (type === 'shell' ? state.platform.label : 'Linux')} 명령창을 열었습니다.`);
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
      notice('보낼 명령을 입력하세요.', 'error');
      return false;
    }
    const session = currentSession();
    const remote = currentTmux();
    if (!session && !remote) {
      notice('사용할 명령창을 먼저 선택하세요.', 'error');
      return false;
    }
    state.commandSending = true;
    renderTarget();
    try {
      const result = session
        ? await guarded(() => window.loadtoagent.terminalCommand(session.id, text), '명령을 전송했습니다.')
        : await guarded(() => window.loadtoagent.tmuxSendText({ distro: remote.distro.name, target: remote.pane.nativeId, text, enter: true }), '선택한 나눠진 명령창에서 실행했습니다.');
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
    if (session) return guarded(() => window.loadtoagent.terminalSignal(session.id, signal), signal === 'interrupt' ? 'Ctrl+C를 보냈습니다.' : '화면을 정리했습니다.');
    if (remote) {
      const key = signal === 'interrupt' ? 'C-c' : 'C-l';
      return guarded(() => window.loadtoagent.tmuxSendKey({ distro: remote.distro.name, target: remote.pane.nativeId, key }), `${key}를 보냈습니다.`);
    }
    notice('사용할 명령창을 먼저 선택하세요.', 'error');
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
    const snapshot = await guarded(() => window.loadtoagent.snapshot(), '여러 창 작업을 새로고침했습니다.');
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
    }), '키보드로 직접 조작할 수 있게 연결했습니다.');
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
      const name = window.prompt('새 작업 묶음 이름', remote.session.name);
      if (!name || name === remote.session.name) return;
      operation = () => window.loadtoagent.tmuxRenameSession({ ...base, target: remote.session.nativeId, name });
      message = '작업 묶음 이름을 변경했습니다.';
    } else if (action === 'new-window') {
      const name = window.prompt('새 창 이름', 'window');
      if (!name) return;
      operation = () => window.loadtoagent.tmuxNewWindow({ ...base, target: remote.session.nativeId, name, cwd: remote.pane.cwd });
      message = '새 창을 만들었습니다.';
    } else if (action === 'split-horizontal' || action === 'split-vertical') {
      operation = () => window.loadtoagent.tmuxSplitPane({ ...base, target: remote.pane.nativeId, direction: action === 'split-horizontal' ? 'horizontal' : 'vertical', cwd: remote.pane.cwd });
      message = '선택한 명령창을 나눴습니다.';
    } else if (action === 'kill-pane') {
      if (!window.confirm(`${remote.pane.nativeId} 명령창을 닫을까요?`)) return;
      operation = () => window.loadtoagent.tmuxKillPane({ ...base, target: remote.pane.nativeId });
      message = '선택한 명령창을 닫았습니다.';
    } else if (action === 'kill-window') {
      if (!window.confirm(`${remote.window.index}:${remote.window.name} 창과 안에 있는 명령창을 모두 닫을까요?`)) return;
      operation = () => window.loadtoagent.tmuxKillWindow({ ...base, target: remote.window.nativeId });
      message = '창 전체를 닫았습니다.';
    } else if (action === 'kill-session') {
      if (!window.confirm(`${remote.session.name} 작업 묶음을 모두 끝낼까요?`)) return;
      operation = () => window.loadtoagent.tmuxKillSession({ ...base, target: remote.session.nativeId });
      message = '작업 묶음을 끝냈습니다.';
    }
    if (!operation) return;
    const result = await guarded(operation, message);
    if (result) {
      if (action.startsWith('kill-')) state.selectedTmux = null;
      setTimeout(refreshSnapshot, 300);
    }
  }

  return { createXtermHost, fitEntry, ensureSessionTerminal, ensureRemoteTerminal, hideScreens, renderSessions, renderTmuxResources, renderTarget, showSelection, selectSession, selectTmux, selectTmuxById, renderAll, refreshSessions, createTerminal, captureRemote, startCapture, stopCapture, sendCommand, sendSignal, openTmuxModal, closeTmuxModal, refreshSnapshot, attachTmux, manageTmux };
};
