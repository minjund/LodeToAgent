'use strict';

(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  const state = {
    sessions: [],
    selectedId: null,
    selectedTmux: null,
    snapshot: null,
    workspaces: [],
    wslDistros: [],
    active: false,
    terminals: new Map(),
    remoteTerminal: null,
    remoteCapture: '',
    captureTimer: null,
    resizeObserver: null,
    initialized: false,
    initPromise: null,
    mode: 'general',
    platform: { id: 'win32', label: 'Windows', localShell: 'powershell', localShellLabel: 'Windows 명령창', nativeTmux: false },
  };

  const STATUS_LABELS = {
    starting: '준비 중',
    running: '사용 중',
    exited: '끝남',
    failed: '열지 못함',
  };

  function notice(message, tone = '') {
    const element = $('#terminalNotice');
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function errorMessage(error) {
    return error && error.message ? error.message : String(error || '알 수 없는 오류');
  }

  async function guarded(action, successMessage = '') {
    try {
      const result = await action();
      if (successMessage) notice(successMessage, 'success');
      return result;
    } catch (error) {
      notice(errorMessage(error), 'error');
      return null;
    }
  }

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
        detail: `${row.window.index}:${row.window.name} · ${pane.command || 'AI 명령창'}`,
        distro: row.distro.name,
        paneId: pane.id,
        paneNativeId: pane.nativeId,
      });
    }
    for (const terminal of state.sessions) {
      if (terminal.status !== 'running') continue;
      const matched = presence.some(item => item.terminalId === terminal.id
        || Number(item.pid || 0) === Number(terminal.pid || -1)
        || Number(item.parentPid || 0) === Number(terminal.pid || -1));
      if (!matched) continue;
      targets.push({
        id: terminal.id,
        kind: 'terminal',
        label: terminal.title,
        detail: `${String(terminal.type || '').toUpperCase()} · PID ${terminal.pid || '--'}`,
        terminalId: terminal.id,
      });
    }
    return [...new Map(targets.map(target => [target.id, target])).values()];
  }

  function requiredAgentTarget(agentSession, targetId = '') {
    const targets = agentTargets(agentSession);
    if (!targets.length) throw new Error('이 AI가 실행 중인 입력 가능한 터미널을 찾지 못했습니다. 외부 터미널에서 시작한 AI는 Lodestar가 직접 입력할 수 없습니다.');
    if (targetId) {
      const selected = targets.find(target => target.id === targetId);
      if (!selected) throw new Error('선택한 터미널 연결이 더 이상 유효하지 않습니다.');
      return selected;
    }
    if (targets.length > 1) throw new Error('지시를 보낼 터미널을 먼저 선택하세요.');
    return targets[0];
  }

  async function dispatchAgentCommand(agentSession, command, targetId = '') {
    await init();
    const text = String(command || '').trim();
    if (!text) throw new Error('AI에게 보낼 지시를 입력하세요.');
    const target = requiredAgentTarget(agentSession, targetId);
    const result = target.kind === 'tmux'
      ? await window.lodestar.tmuxSendText({ distro: target.distro, target: target.paneNativeId, text, enter: true })
      : await window.lodestar.terminalCommand(target.terminalId, text);
    if (!result || result.ok === false) throw new Error(result && result.error || '터미널에 지시를 보내지 못했습니다.');
    notice(`${target.label}에 AI 지시를 보냈습니다.`, 'success');
    return { ok: true, target };
  }

  async function openForAgent(agentSession, targetId = '', draft = '') {
    await init();
    const target = requiredAgentTarget(agentSession, targetId);
    state.mode = target.kind === 'tmux' ? 'tmux' : 'general';
    moveWorkbench(state.mode);
    if (target.kind === 'tmux') await selectTmux(target.distro, target.paneNativeId);
    else await selectSession(target.terminalId);
    const input = $('#terminalCommandInput');
    input.value = String(draft || '');
    input.focus();
    notice(`${target.label}에 보낼 지시를 입력하세요.`, 'success');
    return target;
  }

  function currentSession() {
    const session = state.sessions.find(item => item.id === state.selectedId) || null;
    if (!session) return null;
    return state.mode === 'tmux' ? (session.type === 'tmux' ? session : null) : (session.type !== 'tmux' ? session : null);
  }

  function currentTmux() {
    if (state.mode !== 'tmux') return null;
    if (!state.selectedTmux) return null;
    const match = tmuxRows().find(row => row.distro.name === state.selectedTmux.distro.name && row.pane.nativeId === state.selectedTmux.pane.nativeId);
    if (match) state.selectedTmux = match;
    return match || state.selectedTmux;
  }

  function preferredWorkspace() {
    return state.workspaces[0] && state.workspaces[0].path || '';
  }

  function modeSessions(mode = state.mode) {
    return state.sessions.filter(session => mode === 'tmux' ? session.type === 'tmux' : session.type !== 'tmux');
  }

  function moveWorkbench(mode = state.mode) {
    const workbench = $('#terminalWorkbench');
    const mount = mode === 'tmux' ? $('#tmuxWorkbenchMount') : $('#terminalWorkbenchMount');
    if (workbench && mount && workbench.parentElement !== mount) mount.appendChild(workbench);
  }

  function firstDistro() {
    const name = state.wslDistros[0];
    if (name) return { name };
    return state.snapshot && state.snapshot.tmux && state.snapshot.tmux.distros && state.snapshot.tmux.distros[0] || null;
  }

  function configurePlatform() {
    const localButton = $('#newPowerShellBtn');
    const linuxButton = $('#newWslBtn');
    if (localButton) localButton.textContent = `＋ ${state.platform.localShellLabel}`;
    if (linuxButton) linuxButton.classList.toggle('hidden', state.platform.id !== 'win32');
    const explain = $('#terminalPlatformExplain');
    if (explain) explain.textContent = state.platform.id === 'win32'
      ? 'Windows 또는 WSL 명령창을 하나씩 직접 엽니다. 여러 창을 묶는 작업은 tmux 전용 메뉴에서 다룹니다.'
      : `${state.platform.label} 로컬 명령창을 직접 엽니다. tmux는 WSL 없이 이 컴퓨터에서 바로 제어합니다.`;
    const environmentLabel = $('#tmuxEnvironmentLabel');
    if (environmentLabel) environmentLabel.textContent = state.platform.nativeTmux ? '로컬 tmux 환경' : 'WSL 환경';
  }

  function xtermOptions(readOnly = false) {
    return {
      allowProposedApi: false,
      cursorBlink: !readOnly,
      cursorStyle: 'bar',
      disableStdin: readOnly,
      convertEol: readOnly,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.22,
      scrollback: 10_000,
      theme: {
        background: '#080c12',
        foreground: '#dce6ef',
        cursor: '#5de5ba',
        cursorAccent: '#080c12',
        selectionBackground: '#28475c',
        black: '#0c1119', red: '#ff7486', green: '#5de5a5', yellow: '#f4c66a',
        blue: '#68aef5', magenta: '#c790f5', cyan: '#60dbea', white: '#d6e0e9',
        brightBlack: '#657286', brightRed: '#ff93a1', brightGreen: '#83efbd', brightYellow: '#f7d891',
        brightBlue: '#90c3fa', brightMagenta: '#d9b1fa', brightCyan: '#8ae8f1', brightWhite: '#f4f7fa',
      },
    };
  }

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
    const entry = { terminal, fit, host, readOnly };
    if (!readOnly) {
      terminal.onData(data => {
        if (state.selectedId === key) window.lodestar.terminalWrite(key, data);
      });
      terminal.onResize(size => window.lodestar.terminalResize(key, size.cols, size.rows));
    }
    return entry;
  }

  function fitEntry(entry, sessionId = '') {
    if (!entry || entry.host.classList.contains('hidden')) return;
    requestAnimationFrame(() => {
      try {
        entry.fit.fit();
        if (sessionId) window.lodestar.terminalResize(sessionId, entry.terminal.cols, entry.terminal.rows);
      } catch {}
    });
  }

  async function ensureSessionTerminal(session) {
    let entry = state.terminals.get(session.id);
    if (!entry) {
      entry = createXtermHost(session.id, false);
      state.terminals.set(session.id, entry);
      const detail = await window.lodestar.terminalGet(session.id);
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
    const visible = modeSessions();
    const running = general.filter(item => item.status === 'running').length;
    $('#navTerminalCount').textContent = running;
    $('#terminalSessionSummary').textContent = `${running}개 실행 중 · 전체 ${general.length}개`;
    $('#terminalSessionList').innerHTML = general.length ? general.map(session => `
      <button type="button" class="terminal-session-item ${state.selectedId === session.id ? 'active' : ''}" data-terminal-id="${esc(session.id)}">
        <span class="terminal-session-icon">${session.type === 'tmux' ? 'tm' : (session.type === 'wsl' ? 'WSL' : (session.type === 'shell' ? 'SH' : (session.type === 'agent' ? 'AI' : 'PS')))}</span>
        <span><b>${esc(session.title)}</b><small>${esc(STATUS_LABELS[session.status] || session.status)} · PID ${session.pid || '--'}</small></span>
        <i class="${session.status === 'running' ? 'live' : ''}"></i>
      </button>`).join('') : '<div class="terminal-resource-empty">열어 둔 일반 명령창이 없습니다.</div>';
    $('#terminalTabs').innerHTML = visible.map(session => `
      <button type="button" class="terminal-tab ${state.selectedId === session.id ? 'active' : ''}" data-terminal-id="${esc(session.id)}">
        <i class="${session.status === 'running' ? 'live' : ''}"></i><span>${esc(session.title)}</span><small>${esc(STATUS_LABELS[session.status] || session.status)}</small>
      </button>`).join('');
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
    const hasTarget = Boolean(session || remote);
    $('#terminalCloseBtn').disabled = !hasTarget;
    $('#terminalRestartBtn').disabled = !session;
    $('#terminalCommandInput').disabled = !hasTarget;
    $('#terminalCommandForm').querySelector('button').disabled = !hasTarget;
    $('#terminalAttachBtn').classList.toggle('hidden', !remote || Boolean(session));
    $('#terminalTmuxTools').classList.toggle('hidden', !remote || Boolean(session));
    if (session) {
      $('#terminalConnectionState').textContent = STATUS_LABELS[session.status] || session.status;
      $('#terminalConnectionState').dataset.status = session.status;
      $('#terminalTargetMeta').innerHTML = `<b>${esc(session.title)}</b><span>${esc(session.type.toUpperCase())} · PID ${session.pid || '--'} · ${esc(session.cwd || session.distro || '')}</span>`;
    } else if (remote) {
      $('#terminalConnectionState').textContent = '나눠진 명령창 보기';
      $('#terminalConnectionState').dataset.status = 'running';
      $('#terminalTargetMeta').innerHTML = `<b>${esc(remote.distro.name)} · ${esc(remote.session.name)} · ${esc(remote.pane.nativeId)}</b><span>${esc(remote.window.index)}:${esc(remote.window.name)} · ${esc(remote.pane.command || 'shell')} · ${esc(remote.pane.cwd || '')}</span>`;
    } else {
      $('#terminalConnectionState').textContent = state.mode === 'tmux' ? 'tmux 명령창을 선택하세요' : '일반 명령창을 선택하세요';
      $('#terminalConnectionState').dataset.status = '';
      $('#terminalTargetMeta').innerHTML = state.mode === 'tmux'
        ? '<b>아직 선택한 tmux 명령창이 없습니다</b><span>왼쪽 tmux 목록이나 위 지도에서 조작할 칸을 선택하세요.</span>'
        : '<b>아직 선택한 일반 명령창이 없습니다</b><span>새 명령창을 열거나 왼쪽 목록에서 하나를 선택하세요.</span>';
    }
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
    state.selectedId = id;
    state.selectedTmux = null;
    renderSessions();
    renderTmuxResources();
    await showSelection();
  }

  async function selectTmux(distroName, paneId) {
    const row = tmuxRows().find(item => item.distro.name === distroName && item.pane.nativeId === paneId);
    if (!row) return notice('선택한 나눠진 명령창을 찾을 수 없습니다.', 'error');
    state.selectedId = null;
    state.selectedTmux = row;
    state.remoteCapture = '';
    if (state.remoteTerminal) state.remoteTerminal.terminal.clear();
    renderSessions();
    renderTmuxResources();
    await showSelection();
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
    state.sessions = payload && payload.sessions || await window.lodestar.terminalList();
    if (state.selectedId && !state.sessions.some(item => item.id === state.selectedId)) state.selectedId = null;
    renderAll();
    if (state.active) await showSelection();
  }

  async function createTerminal(type) {
    const distro = type === 'wsl' ? firstDistro() : null;
    if (type === 'wsl' && !distro) return notice('사용 가능한 Linux 환경이 없습니다.', 'error');
    const created = await guarded(() => window.lodestar.terminalCreate({
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
    const remote = currentTmux();
    if (!remote || !state.active || state.selectedId) return;
    const result = await guarded(() => window.lodestar.tmuxCapture({ distro: remote.distro.name, target: remote.pane.nativeId, lines: 1_500 }));
    if (!result || typeof result.output !== 'string') return;
    if (result.output === state.remoteCapture) return;
    state.remoteCapture = result.output;
    const entry = ensureRemoteTerminal();
    entry.terminal.reset();
    entry.terminal.write(result.output.replace(/\n/g, '\r\n'));
    entry.terminal.scrollToBottom();
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
    if (!text.trim()) return notice('보낼 명령을 입력하세요.', 'error');
    const session = currentSession();
    const remote = currentTmux();
    if (session) await guarded(() => window.lodestar.terminalCommand(session.id, text), '명령을 전송했습니다.');
    else if (remote) {
      await guarded(() => window.lodestar.tmuxSendText({ distro: remote.distro.name, target: remote.pane.nativeId, text, enter: true }), '선택한 나눠진 명령창에서 실행했습니다.');
      setTimeout(captureRemote, 160);
    } else notice('사용할 명령창을 먼저 선택하세요.', 'error');
  }

  async function sendSignal(signal) {
    const session = currentSession();
    const remote = currentTmux();
    if (session) return guarded(() => window.lodestar.terminalSignal(session.id, signal), signal === 'interrupt' ? 'Ctrl+C를 보냈습니다.' : '화면을 정리했습니다.');
    if (remote) {
      const key = signal === 'interrupt' ? 'C-c' : 'C-l';
      return guarded(() => window.lodestar.tmuxSendKey({ distro: remote.distro.name, target: remote.pane.nativeId, key }), `${key}를 보냈습니다.`);
    }
    notice('사용할 명령창을 먼저 선택하세요.', 'error');
  }

  function openTmuxModal() {
    const distros = state.snapshot && state.snapshot.tmux && state.snapshot.tmux.distros || [];
    $('#tmuxCreateDistro').innerHTML = distros.map(item => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join('');
    $('#tmuxCreateError').classList.add('hidden');
    $('#tmuxCreateModal').classList.remove('hidden');
    $('#tmuxCreateName').focus();
  }

  function closeTmuxModal() {
    $('#tmuxCreateModal').classList.add('hidden');
    $('#tmuxCreateForm').reset();
  }

  async function refreshSnapshot() {
    const snapshot = await guarded(() => window.lodestar.snapshot(), '여러 창 작업을 새로고침했습니다.');
    if (snapshot) updateSnapshot(snapshot, state.workspaces);
  }

  async function attachTmux() {
    const remote = currentTmux();
    if (!remote) return;
    const created = await guarded(() => window.lodestar.terminalCreate({
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
      operation = () => window.lodestar.tmuxRenameSession({ ...base, target: remote.session.nativeId, name });
      message = '작업 묶음 이름을 변경했습니다.';
    } else if (action === 'new-window') {
      const name = window.prompt('새 창 이름', 'window');
      if (!name) return;
      operation = () => window.lodestar.tmuxNewWindow({ ...base, target: remote.session.nativeId, name, cwd: remote.pane.cwd });
      message = '새 창을 만들었습니다.';
    } else if (action === 'split-horizontal' || action === 'split-vertical') {
      operation = () => window.lodestar.tmuxSplitPane({ ...base, target: remote.pane.nativeId, direction: action === 'split-horizontal' ? 'horizontal' : 'vertical', cwd: remote.pane.cwd });
      message = '선택한 명령창을 나눴습니다.';
    } else if (action === 'kill-pane') {
      if (!window.confirm(`${remote.pane.nativeId} 명령창을 닫을까요?`)) return;
      operation = () => window.lodestar.tmuxKillPane({ ...base, target: remote.pane.nativeId });
      message = '선택한 명령창을 닫았습니다.';
    } else if (action === 'kill-window') {
      if (!window.confirm(`${remote.window.index}:${remote.window.name} 창과 안에 있는 명령창을 모두 닫을까요?`)) return;
      operation = () => window.lodestar.tmuxKillWindow({ ...base, target: remote.window.nativeId });
      message = '창 전체를 닫았습니다.';
    } else if (action === 'kill-session') {
      if (!window.confirm(`${remote.session.name} 작업 묶음을 모두 끝낼까요?`)) return;
      operation = () => window.lodestar.tmuxKillSession({ ...base, target: remote.session.nativeId });
      message = '작업 묶음을 끝냈습니다.';
    }
    if (!operation) return;
    const result = await guarded(operation, message);
    if (result) {
      if (action.startsWith('kill-')) state.selectedTmux = null;
      setTimeout(refreshSnapshot, 300);
    }
  }

  function bindEvents() {
    $('#newPowerShellBtn').addEventListener('click', () => createTerminal(state.platform.localShell));
    $('#newWslBtn').addEventListener('click', () => createTerminal('wsl'));
    $('#newTmuxSessionBtn').addEventListener('click', openTmuxModal);
    $('#refreshTmuxTerminalBtn').addEventListener('click', refreshSnapshot);
    $('#terminalSessionList').addEventListener('click', event => {
      const item = event.target.closest('[data-terminal-id]');
      if (item) selectSession(item.dataset.terminalId);
    });
    $('#terminalTabs').addEventListener('click', event => {
      const item = event.target.closest('[data-terminal-id]');
      if (item) selectSession(item.dataset.terminalId);
    });
    $('#terminalTmuxList').addEventListener('click', event => {
      const item = event.target.closest('[data-tmux-distro][data-tmux-pane]');
      if (item) selectTmux(item.dataset.tmuxDistro, item.dataset.tmuxPane);
    });
    $('#terminalCommandForm').addEventListener('submit', async event => {
      event.preventDefault();
      const input = $('#terminalCommandInput');
      await sendCommand(input.value);
      input.value = '';
      input.focus();
    });
    $('#terminalCommandInput').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        $('#terminalCommandForm').requestSubmit();
      }
    });
    document.querySelectorAll('[data-terminal-signal]').forEach(button => button.addEventListener('click', () => sendSignal(button.dataset.terminalSignal)));
    $('#terminalRestartBtn').addEventListener('click', async () => {
      const session = currentSession();
      if (!session) return;
      const restarted = await guarded(() => window.lodestar.terminalRestart(session.id), '명령창을 다시 시작했습니다.');
      if (restarted) {
        const entry = state.terminals.get(session.id);
        if (entry) entry.terminal.reset();
        await refreshSessions();
      }
    });
    $('#terminalCloseBtn').addEventListener('click', async () => {
      const session = currentSession();
      if (!session) {
        state.selectedTmux = null;
        renderAll();
        showSelection();
        return;
      }
      const closed = await guarded(() => window.lodestar.terminalClose(session.id), '명령창을 닫았습니다.');
      if (!closed) return;
      const entry = state.terminals.get(session.id);
      if (entry) {
        entry.terminal.dispose();
        entry.host.remove();
        state.terminals.delete(session.id);
      }
      state.selectedId = null;
      await refreshSessions();
    });
    $('#terminalAttachBtn').addEventListener('click', attachTmux);
    $('#terminalTmuxTools').addEventListener('click', event => {
      const button = event.target.closest('[data-tmux-manage]');
      if (button) manageTmux(button.dataset.tmuxManage);
    });
    $('#terminalTmuxLayout').addEventListener('change', async event => {
      const remote = currentTmux();
      if (!remote) return;
      const result = await guarded(() => window.lodestar.tmuxSelectLayout({ distro: remote.distro.name, target: remote.window.nativeId, layout: event.target.value }), '창 배치를 변경했습니다.');
      if (result) setTimeout(refreshSnapshot, 250);
    });
    $('#tmuxCreateForm').addEventListener('submit', async event => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('[type="submit"]');
      submit.disabled = true;
      const error = $('#tmuxCreateError');
      error.classList.add('hidden');
      try {
        const result = await window.lodestar.tmuxNewSession({
          distro: $('#tmuxCreateDistro').value,
          name: $('#tmuxCreateName').value,
          cwd: $('#tmuxCreateCwd').value,
          command: $('#tmuxCreateCommand').value,
        });
        if (result && result.ok) {
          closeTmuxModal();
          notice('새 여러 창 작업을 만들었습니다.', 'success');
          setTimeout(refreshSnapshot, 300);
        }
      } catch (failure) {
        error.textContent = errorMessage(failure);
        error.classList.remove('hidden');
      } finally {
        submit.disabled = false;
      }
    });
    $('#closeTmuxCreateBtn').addEventListener('click', closeTmuxModal);
    $('#cancelTmuxCreateBtn').addEventListener('click', closeTmuxModal);
    $('#tmuxCreateModal').addEventListener('click', event => { if (event.target === event.currentTarget) closeTmuxModal(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !$('#tmuxCreateModal').classList.contains('hidden')) closeTmuxModal();
    });
    window.addEventListener('resize', () => {
      const entry = currentSession() ? state.terminals.get(state.selectedId) : state.remoteTerminal;
      fitEntry(entry, state.selectedId || '');
    });
    window.lodestar.onTerminalData(payload => {
      const entry = state.terminals.get(payload && payload.id);
      if (entry && payload.data) entry.terminal.write(payload.data);
    });
    window.lodestar.onTerminalState(payload => refreshSessions(payload));
    window.lodestar.onTerminalError(payload => notice(payload && payload.message || '명령창 입력에 실패했습니다.', 'error'));
  }

  async function activate(snapshot, workspaces, mode = 'general') {
    state.active = true;
    state.mode = mode === 'tmux' ? 'tmux' : 'general';
    moveWorkbench(state.mode);
    if (state.mode === 'general') state.selectedTmux = null;
    if (state.selectedId && !modeSessions().some(item => item.id === state.selectedId)) state.selectedId = null;
    updateSnapshot(snapshot, workspaces);
    if (!state.initialized) return;
    await refreshSessions();
    if (!state.selectedId && !state.selectedTmux) {
      const visible = modeSessions();
      if (visible.length) state.selectedId = visible[0].id;
      else if (state.mode === 'tmux') state.selectedTmux = tmuxRows()[0] || null;
    }
    renderAll();
    await showSelection();
  }

  function deactivate() {
    state.active = false;
    stopCapture();
  }

  function updateSnapshot(snapshot, workspaces = state.workspaces) {
    state.snapshot = snapshot || state.snapshot;
    state.workspaces = Array.isArray(workspaces) ? workspaces : state.workspaces;
    if (!state.initialized) return;
    renderTmuxResources();
    renderTarget();
    if (state.active && state.selectedTmux) startCapture();
  }

  function init() {
    if (state.initPromise) return state.initPromise;
    state.initPromise = (async () => {
      if (!window.lodestar) return;
      state.initialized = true;
      bindEvents();
      const [bootstrap, sessions, environments] = await Promise.all([window.lodestar.bootstrap(), window.lodestar.terminalList(), window.lodestar.wslDistros()]);
      state.platform = bootstrap.platform || state.platform;
      state.sessions = sessions;
      state.wslDistros = environments;
      configurePlatform();
      renderAll();
    })();
    return state.initPromise;
  }

  window.LodestarTerminal = {
    activate,
    deactivate,
    updateSnapshot,
    refresh: refreshSessions,
    selectTmuxById,
    openTmuxModal,
    agentTargets,
    dispatchAgentCommand,
    openForAgent,
  };
  init().catch(error => notice(`명령창 준비 실패: ${errorMessage(error)}`, 'error'));
})();
