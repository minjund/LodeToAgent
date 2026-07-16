'use strict';

(() => {
  const $ = selector => document.querySelector(selector);
  const uiLocale = () => window.LoadToAgentI18n?.getLocaleTag() || 'ko-KR';
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
    boundAgent: null,
    boundTargetId: '',
    historyCollapsed: false,
    historyRefreshTimer: null,
    historyRequests: new Map(),
    commandDrafts: new Map(),
    commandSending: false,
    platform: { id: 'win32', label: 'Windows', localShell: 'powershell', localShellLabel: 'Windows 명령창', nativeTmux: false },
  };

  const STATUS_LABELS = {
    starting: '준비 중',
    running: '세션 유지 중',
    exited: '끝남',
    failed: '열지 못함',
  };

  function notice(message, tone = '') {
    const element = $('#terminalNotice');
    if (!element) return;
    element.innerHTML = `<span class="terminal-notice-dot"></span><span>${esc(message)}</span>`;
    element.dataset.tone = tone;
  }

  function errorMessage(error) {
    return error && error.message ? error.message : String(error || '알 수 없는 오류');
  }

  function timeLabel(value) {
    const date = new Date(value || 0);
    return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' }) : '';
  }

  function historyMessageHtml(value) {
    const blocks = [];
    let fenced = false;
    let code = [];
    for (const line of String(value || '').replace(/\r\n/g, '\n').split('\n')) {
      if (/^```/.test(line)) {
        if (fenced) { blocks.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = []; fenced = false; } else fenced = true;
        continue;
      }
      if (fenced) { code.push(line); continue; }
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      const safe = esc(bullet ? bullet[1] : line).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      if (bullet) blocks.push(`<p class="bullet">${safe}</p>`);
      else if (line.trim()) blocks.push(`<p>${safe}</p>`);
      else blocks.push('<br>');
    }
    if (fenced) blocks.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    return `<div class="terminal-history-copy">${blocks.join('')}</div>`;
  }

  function providerLabel(provider) {
    return ({ claude: 'Claude', codex: 'GPT · Codex', gemini: 'Gemini', grok: 'Grok' })[provider] || 'AI';
  }

  function resumeSupport(agentSession) {
    if (!agentSession) return { supported: false, reason: '세션 정보가 없습니다.' };
    const sessionId = String(agentSession.externalId || '').trim();
    if (!sessionId) return { supported: false, reason: '재개에 필요한 세션 ID가 기록되지 않았습니다.' };
    const provider = String(agentSession.provider || '').toLowerCase();
    if (!['codex', 'claude', 'gemini'].includes(provider)) {
      return { supported: false, reason: `${providerLabel(provider)} CLI의 세션 ID 재개 방식이 공식 문서에서 확인되지 않았습니다.` };
    }
    const args = provider === 'codex' ? ['resume', sessionId] : ['--resume', sessionId];
    return { supported: true, provider, sessionId, args };
  }

  function resumeLaunchArgs(support, prompt = '') {
    const args = [...support.args];
    const text = String(prompt || '').trim();
    if (text) args.push(text);
    return args;
  }

  function terminalTypeLabel(session) {
    if (!session) return '터미널';
    if (session.type === 'wsl') return session.distro || 'Linux';
    if (session.type === 'agent') return providerLabel(session.provider);
    if (session.type === 'powershell') return 'PowerShell';
    if (session.type === 'cmd') return '명령 프롬프트';
    if (session.type === 'shell') return session.shell || 'Shell';
    return String(session.type || '터미널').toUpperCase();
  }

  function terminalTypeMark(session) {
    if (!session) return '›_';
    if (session.type === 'wsl') return 'WSL';
    if (session.type === 'agent') return 'AI';
    if (session.type === 'powershell') return 'PS';
    if (session.type === 'cmd') return 'CMD';
    if (session.type === 'shell') return 'SH';
    return '›_';
  }

  function setConnectionState(label, status = '') {
    const element = $('#terminalConnectionState');
    if (!element) return;
    element.innerHTML = `<i></i><span>${esc(label)}</span>`;
    element.dataset.status = status;
  }

  function currentTargetId() {
    const session = currentSession();
    if (session) return session.id;
    const remote = currentTmux();
    return remote ? `tmux:${remote.distro.name}:${remote.pane.nativeId}` : '';
  }

  function visibleBoundAgent() {
    return state.boundAgent && state.boundTargetId === currentTargetId() ? state.boundAgent : null;
  }

  function saveCurrentDraft() {
    const targetId = currentTargetId();
    const input = $('#terminalCommandInput');
    if (targetId && input) state.commandDrafts.set(targetId, input.value);
  }

  function restoreCurrentDraft() {
    const input = $('#terminalCommandInput');
    if (input) input.value = state.commandDrafts.get(currentTargetId()) || '';
  }

  function renderHistoryPanel(forceBottom = false) {
    const panel = $('#terminalHistoryPanel');
    if (!panel) return;
    const agent = visibleBoundAgent();
    panel.classList.toggle('hidden', !agent);
    panel.classList.toggle('collapsed', Boolean(agent && state.historyCollapsed));
    $('#terminalStage')?.classList.toggle('history-collapsed', Boolean(agent && state.historyCollapsed));
    const toggle = $('#terminalHistoryToggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', state.historyCollapsed ? 'false' : 'true');
      toggle.textContent = state.historyCollapsed ? '›' : '‹';
      toggle.title = state.historyCollapsed ? '대화 영역 펼치기' : '대화 영역 접기';
    }
    if (!agent) return;
    const allMessages = Array.isArray(agent.messages) ? agent.messages.filter(message => message && message.text) : [];
    const messages = allMessages.filter(message => message.role === 'user' || message.role === 'assistant');
    const activityCount = allMessages.length - messages.length;
    const shown = messages.slice(-80);
    $('#terminalHistoryTitle').textContent = agent.title || `${providerLabel(agent.provider)} 세션`;
    $('#terminalHistoryMeta').textContent = `${providerLabel(agent.provider)} · 대화 ${messages.length}개${activityCount ? ` · 활동 ${activityCount}건은 상세에서 확인` : ''}${messages.length > shown.length ? ` · 최근 ${shown.length}개 표시` : ''}`;
    const list = $('#terminalHistoryList');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    list.innerHTML = shown.length ? shown.map(message => {
      const role = message.role === 'assistant' ? 'assistant' : (message.role === 'tool' ? 'tool' : (message.role === 'system' ? 'system' : 'user'));
      const label = role === 'assistant' ? providerLabel(agent.provider) : (role === 'tool' ? (message.title || '도구') : (role === 'system' ? '시스템' : '나'));
      return `<article class="terminal-history-message ${role}"><header><b>${esc(label)}</b><time>${esc(timeLabel(message.timestamp))}</time></header>${historyMessageHtml(message.text)}</article>`;
    }).join('') : '<div class="terminal-history-empty"><b>아직 표시할 대화가 없습니다</b><span>터미널 출력은 오른쪽에 그대로 유지됩니다.</span></div>';
    if (forceBottom || nearBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  function bindAgent(agentSession, target) {
    state.boundAgent = agentSession || null;
    state.boundTargetId = target && target.id || '';
    state.historyCollapsed = false;
    renderHistoryPanel(true);
  }

  function queueHistoryRefresh(cardSession) {
    if (!state.boundAgent || !cardSession || cardSession.id !== state.boundAgent.id) return;
    const currentMessages = state.boundAgent.messages || [];
    const cardMessages = cardSession.messages || [];
    const messages = cardMessages.length && (!currentMessages.length || Date.parse(cardSession.updatedAt || 0) >= Date.parse(state.boundAgent.updatedAt || 0)) ? cardMessages : currentMessages;
    state.boundAgent = { ...state.boundAgent, ...cardSession, messages };
    renderHistoryPanel();
    clearTimeout(state.historyRefreshTimer);
    state.historyRefreshTimer = setTimeout(async () => {
      if (!state.boundAgent) return;
      const id = state.boundAgent.id;
      if (state.historyRequests.has(id)) return;
      const request = window.loadtoagent.sessionDetail(id);
      state.historyRequests.set(id, request);
      try {
        const detail = await request;
        if (detail && state.boundAgent && state.boundAgent.id === id) {
          state.boundAgent = detail;
          renderHistoryPanel();
        }
      } catch {} finally {
        state.historyRequests.delete(id);
      }
    }, 240);
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
      const matched = terminal.bridgeId === agentSession.id || presence.some(item => item.terminalId === terminal.id
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
    if (!targets.length) throw new Error('이 AI가 실행 중인 입력 가능한 터미널을 찾지 못했습니다. 외부 터미널에서 시작한 AI는 LoadToAgent가 직접 입력할 수 없습니다.');
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
      ? await window.loadtoagent.tmuxSendText({ distro: target.distro, target: target.paneNativeId, text, enter: true })
      : await window.loadtoagent.terminalCommand(target.terminalId, text);
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
    bindAgent(agentSession, target);
    queueHistoryRefresh(agentSession);
    renderTarget();
    const entry = target.kind === 'tmux' ? state.remoteTerminal : state.terminals.get(target.terminalId);
    fitEntry(entry, target.kind === 'tmux' ? '' : target.terminalId);
    const input = $('#terminalCommandInput');
    input.value = String(draft || '');
    state.commandDrafts.set(target.id, input.value);
    input.focus({ preventScroll: true });
    notice(`${target.label}의 기존 세션을 유지하고 있습니다. 이전 대화를 보면서 이어서 입력하세요.`, 'success');
    return target;
  }

  async function resumeForAgent(agentSession, draft = '', sendDraft = false) {
    await init();
    const support = resumeSupport(agentSession);
    if (!support.supported) throw new Error(support.reason);
    const cwd = String(agentSession.cwd || preferredWorkspace() || '').trim();
    if (!cwd) throw new Error('이 AI가 작업하던 폴더를 찾지 못해 세션을 안전하게 재개할 수 없습니다.');
    const prompt = String(draft || '').trim();
    const title = `${providerLabel(agentSession.provider)} · ${agentSession.taskName || agentSession.agentName || '세션'} 이어서 작업`;
    const created = await window.loadtoagent.terminalCreate({
      type: 'agent',
      provider: support.provider,
      args: resumeLaunchArgs(support, sendDraft ? prompt : ''),
      cwd,
      bridgeId: agentSession.id,
      title,
      cols: 120,
      rows: 32,
    });
    if (!created || !created.id) throw new Error('AI 세션을 재개할 터미널을 만들지 못했습니다.');
    state.mode = 'general';
    moveWorkbench('general');
    await refreshSessions();
    await selectSession(created.id);
    const target = {
      id: created.id,
      kind: 'terminal',
      label: created.title || title,
      detail: `${String(created.type || 'agent').toUpperCase()} · PID ${created.pid || '--'}`,
      terminalId: created.id,
    };
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
      ? `${providerLabel(agentSession.provider)} 세션 ${support.sessionId.slice(0, 12)}을 이어받아 지시를 보냈습니다.`
      : `${providerLabel(agentSession.provider)} 세션 ${support.sessionId.slice(0, 12)}을 다시 연결했습니다. 이어서 지시할 수 있습니다.`, 'success');
    return { ...target, promptSent: Boolean(sendDraft && prompt) };
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
    if (localButton) localButton.textContent = `＋ ${state.platform.localShellLabel.replace('명령창', '세션')}`;
    if (linuxButton) linuxButton.classList.toggle('hidden', state.platform.id !== 'win32');
    const explain = $('#terminalPlatformExplain');
    if (explain) explain.textContent = state.platform.id === 'win32'
      ? '기존 Windows·WSL 터미널 세션을 유지한 채 같은 화면에서 계속 입력합니다. AI 카드에서 열면 이전 대화도 함께 표시됩니다.'
      : `기존 ${state.platform.label} 터미널 세션을 유지한 채 계속 입력합니다. AI 카드에서 열면 이전 대화도 함께 표시됩니다.`;
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
      screenReaderMode: true,
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
        if (state.selectedId === key) window.loadtoagent.terminalWrite(key, data);
      });
      terminal.onResize(size => window.loadtoagent.terminalResize(key, size.cols, size.rows));
    }
    return entry;
  }

  function fitEntry(entry, sessionId = '') {
    if (!entry || entry.host.classList.contains('hidden')) return;
    requestAnimationFrame(() => {
      try {
        entry.fit.fit();
        if (sessionId) window.loadtoagent.terminalResize(sessionId, entry.terminal.cols, entry.terminal.rows);
      } catch {}
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
    $('#terminalSessionSummary').textContent = `${running}개 유지 중${background ? ` · AI 백그라운드 ${background}개` : ''} · 전체 ${general.length}개`;
    $('#terminalSessionList').innerHTML = general.length ? general.map(session => `
      <button type="button" class="terminal-session-item ${state.selectedId === session.id ? 'active' : ''}" data-terminal-id="${esc(session.id)}">
        <span class="terminal-session-icon">${esc(terminalTypeMark(session))}</span>
        <span><b>${esc(session.title)}</b><small>${esc(terminalTypeLabel(session))}${session.background ? ' · 백그라운드 유지' : ''} · ${esc(STATUS_LABELS[session.status] || session.status)}</small><em>${esc(session.cwd || session.distro || `PID ${session.pid || '--'}`)}</em></span>
        <i class="${session.status === 'running' ? 'live' : ''}"></i>
      </button>`).join('') : '<div class="terminal-resource-empty">열어 둔 일반 명령창이 없습니다.</div>';
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
    closeButton.textContent = remote && !session ? '선택 해제' : '세션 종료';
    closeButton.classList.toggle('terminal-danger-button', Boolean(session));
    $('#terminalRestartBtn').classList.toggle('hidden', !session || session.status === 'running' || session.type === 'agent');
    $('#terminalRestartBtn').disabled = !session || session.status === 'running';
    $('#terminalCommandInput').disabled = !canInput;
    const commandForm = $('#terminalCommandForm');
    const commandButton = commandForm.querySelector('button');
    commandButton.disabled = !canInput || state.commandSending;
    commandForm.toggleAttribute('aria-busy', state.commandSending);
    const commandButtonLabel = commandButton.querySelector('span');
    if (commandButtonLabel) commandButtonLabel.textContent = state.commandSending ? '보내는 중' : '보내기';
    document.querySelectorAll('[data-terminal-signal]').forEach(button => { button.disabled = !canInput; });
    $('#terminalAttachBtn').classList.toggle('hidden', !remote || Boolean(session));
    $('#terminalTmuxTools').classList.toggle('hidden', !remote || Boolean(session));
    if (session) {
      setConnectionState(STATUS_LABELS[session.status] || session.status, session.status);
      $('#terminalTargetIcon').textContent = terminalTypeMark(session);
      $('#terminalTargetMeta').innerHTML = `<b>${esc(session.title)}</b><span>${bound ? '● 기존 AI 세션 유지 중 · ' : ''}${esc(session.type.toUpperCase())} · PID ${session.pid || '--'} · ${esc(session.cwd || session.distro || '')}</span>`;
      $('#terminalConsoleCaption').textContent = `${terminalTypeLabel(session)} · PID ${session.pid || '--'}`;
      $('#terminalConsoleState').textContent = canInput ? '직접 입력 가능' : '종료된 세션';
      $('#terminalConsoleState').dataset.status = session.status;
    } else if (remote) {
      setConnectionState(remote.pane.dead ? '종료된 tmux 칸' : 'tmux 연결됨', remote.pane.dead ? 'exited' : 'running');
      $('#terminalTargetIcon').textContent = 'tm';
      $('#terminalTargetMeta').innerHTML = `<b>${esc(remote.distro.name)} · ${esc(remote.session.name)} · ${esc(remote.pane.nativeId)}</b><span>${esc(remote.window.index)}:${esc(remote.window.name)} · ${esc(remote.pane.command || 'shell')} · ${esc(remote.pane.cwd || '')}</span>`;
      $('#terminalConsoleCaption').textContent = `${remote.window.index}:${remote.window.name} · ${remote.pane.command || 'shell'}`;
      $('#terminalConsoleState').textContent = remote.pane.dead ? '종료된 칸' : '명령 전송 가능';
      $('#terminalConsoleState').dataset.status = remote.pane.dead ? 'exited' : 'running';
    } else {
      setConnectionState('선택 대기');
      $('#terminalTargetIcon').textContent = '›_';
      $('#terminalTargetMeta').innerHTML = state.mode === 'tmux'
        ? '<b>아직 선택한 tmux 명령창이 없습니다</b><span>왼쪽 tmux 목록이나 위 지도에서 조작할 칸을 선택하세요.</span>'
        : '<b>세션을 선택해 주세요</b><span>왼쪽 목록에서 이어갈 세션을 고르거나 새 세션을 만드세요.</span>';
      $('#terminalConsoleCaption').textContent = '세션을 선택하면 출력이 여기에 표시됩니다';
      $('#terminalConsoleState').textContent = '선택 대기';
      $('#terminalConsoleState').dataset.status = '';
    }
    const commandLabel = $('#terminalCommandLabel');
    const commandInput = $('#terminalCommandInput');
    if (commandLabel) commandLabel.textContent = bound ? 'AI에게 이어서 지시' : (remote ? 'tmux 명령창에 보내기' : '터미널에 명령 보내기');
    if (commandInput) commandInput.placeholder = !hasTarget
      ? '먼저 왼쪽에서 세션을 선택하세요'
      : (bound ? '이전 대화에 이어서 AI에게 지시할 내용을 입력하세요' : '실행할 명령을 입력하세요');
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
    state.selectedId = null;
    state.selectedTmux = row;
    state.remoteCapture = '';
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
    state.sessions = payload && payload.sessions || await window.loadtoagent.terminalList();
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
    const remote = currentTmux();
    if (!remote || !state.active || state.selectedId) return;
    const result = await guarded(() => window.loadtoagent.tmuxCapture({ distro: remote.distro.name, target: remote.pane.nativeId, lines: 1_500 }));
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

  function bindEvents() {
    $('#newPowerShellBtn').addEventListener('click', () => createTerminal(state.platform.localShell));
    $('#newWslBtn').addEventListener('click', () => createTerminal('wsl'));
    $('#newTmuxSessionBtn').addEventListener('click', openTmuxModal);
    $('#refreshTmuxTerminalBtn').addEventListener('click', refreshSnapshot);
    $('#terminalSessionList').addEventListener('click', event => {
      const item = event.target.closest('[data-terminal-id]');
      if (item) selectSession(item.dataset.terminalId);
    });
    $('#terminalTmuxList').addEventListener('click', event => {
      const item = event.target.closest('[data-tmux-distro][data-tmux-pane]');
      if (item) selectTmux(item.dataset.tmuxDistro, item.dataset.tmuxPane);
    });
    $('#terminalCommandForm').addEventListener('submit', async event => {
      event.preventDefault();
      if (state.commandSending) return;
      const input = $('#terminalCommandInput');
      const sent = await sendCommand(input.value);
      if (!sent) return;
      input.value = '';
      state.commandDrafts.delete(currentTargetId());
      input.focus({ preventScroll: true });
    });
    $('#terminalCommandInput').addEventListener('input', event => {
      const targetId = currentTargetId();
      if (targetId) state.commandDrafts.set(targetId, event.target.value);
    });
    $('#terminalCommandInput').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        $('#terminalCommandForm').requestSubmit();
      }
    });
    document.querySelectorAll('[data-terminal-signal]').forEach(button => button.addEventListener('click', () => sendSignal(button.dataset.terminalSignal)));
    $('#terminalRestartBtn').addEventListener('click', async () => {
      const session = currentSession();
      if (!session) return;
      const restarted = await guarded(() => window.loadtoagent.terminalRestart(session.id), '명령창을 다시 시작했습니다.');
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
      if (session.status === 'running' && !window.confirm(`${session.title} 세션과 실행 중인 프로세스를 끝낼까요?\n이 작업은 터미널을 숨기는 것이 아니라 실제 세션을 종료합니다.`)) return;
      const closed = await guarded(() => window.loadtoagent.terminalClose(session.id), '터미널 세션을 종료했습니다.');
      if (!closed) return;
      const entry = state.terminals.get(session.id);
      if (entry) {
        entry.terminal.dispose();
        entry.host.remove();
        state.terminals.delete(session.id);
      }
      state.commandDrafts.delete(session.id);
      state.selectedId = null;
      if (state.boundTargetId === session.id) {
        state.boundAgent = null;
        state.boundTargetId = '';
      }
      await refreshSessions();
    });
    $('#terminalHistoryToggle').addEventListener('click', () => {
      state.historyCollapsed = !state.historyCollapsed;
      renderHistoryPanel();
      const entry = currentSession() ? state.terminals.get(state.selectedId) : state.remoteTerminal;
      fitEntry(entry, state.selectedId || '');
    });
    $('#terminalAttachBtn').addEventListener('click', attachTmux);
    $('#terminalTmuxTools').addEventListener('click', event => {
      const button = event.target.closest('[data-tmux-manage]');
      if (button) manageTmux(button.dataset.tmuxManage);
    });
    $('#terminalTmuxLayout').addEventListener('change', async event => {
      const remote = currentTmux();
      if (!remote) return;
      const result = await guarded(() => window.loadtoagent.tmuxSelectLayout({ distro: remote.distro.name, target: remote.window.nativeId, layout: event.target.value }), '창 배치를 변경했습니다.');
      if (result) setTimeout(refreshSnapshot, 250);
    });
    $('#tmuxCreateForm').addEventListener('submit', async event => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('[type="submit"]');
      submit.disabled = true;
      const error = $('#tmuxCreateError');
      error.classList.add('hidden');
      try {
        const result = await window.loadtoagent.tmuxNewSession({
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
    window.loadtoagent.onTerminalData(payload => {
      const entry = state.terminals.get(payload && payload.id);
      if (entry && payload.data) entry.terminal.write(payload.data);
    });
    window.loadtoagent.onTerminalState(payload => refreshSessions(payload));
    window.loadtoagent.onTerminalError(payload => notice(payload && payload.message || '명령창 입력에 실패했습니다.', 'error'));
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
    if (state.boundAgent && state.snapshot && Array.isArray(state.snapshot.sessions)) {
      const updated = state.snapshot.sessions.find(session => session.id === state.boundAgent.id);
      if (updated && updated.updatedAt !== state.boundAgent.updatedAt) queueHistoryRefresh(updated);
    }
    renderTmuxResources();
    renderTarget();
    if (state.active && state.selectedTmux) startCapture();
  }

  function init() {
    if (state.initPromise) return state.initPromise;
    state.initPromise = (async () => {
      if (!window.loadtoagent) return;
      state.initialized = true;
      bindEvents();
      const [bootstrap, sessions, environments] = await Promise.all([window.loadtoagent.bootstrap(), window.loadtoagent.terminalList(), window.loadtoagent.wslDistros()]);
      state.platform = bootstrap.platform || state.platform;
      state.sessions = sessions;
      state.wslDistros = environments;
      configurePlatform();
      renderAll();
    })();
    return state.initPromise;
  }

  window.LoadToAgentTerminal = {
    activate,
    deactivate,
    updateSnapshot,
    refresh: refreshSessions,
    selectTmuxById,
    openTmuxModal,
    agentTargets,
    resumeSupport,
    dispatchAgentCommand,
    openForAgent,
    resumeForAgent,
  };
  window.addEventListener('loadtoagent:locale-changed', () => {
    if (!state.initialized) return;
    configurePlatform();
    renderAll();
  });
  init().catch(error => notice(`명령창 준비 실패: ${errorMessage(error)}`, 'error'));
})();
