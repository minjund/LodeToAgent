'use strict';

(() => {
  const { $, esc, uiLocale, providerLabel, reportRecoverableError } = window.LoadToAgentRendererUtils;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const SESSION_ORDER_KEY = 'loadtoagent:terminal-session-order:v1';

  function loadSessionOrder() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_ORDER_KEY) || '[]');
      return Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : [];
    } catch (error) {
      reportRecoverableError('terminal-session-order-load', error);
      return [];
    }
  }

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
    remoteViewportAnchor: null,
    remoteViewportAtBottom: false,
    captureTimer: null,
    captureInFlight: false,
    captureGeneration: 0,
    captureRevision: 0,
    resizeObserver: null,
    initialized: false,
    eventsBound: false,
    initPromise: null,
    mode: 'general',
    boundAgent: null,
    boundTargetId: '',
    historyCollapsed: false,
    historyRefreshTimer: null,
    historyRequests: new Map(),
    commandDrafts: new Map(),
    commandSending: false,
    sessionOrder: loadSessionOrder(),
    draggedSessionId: '',
    sessionDragJustEnded: false,
    platform: { id: 'win32', label: 'Windows', localShell: 'powershell', localShellLabel: 'Windows Terminal', nativeTmux: false },
  };

  const STATUS_LABELS = {};

  function refreshStatusLabels() {
    Object.assign(STATUS_LABELS, {
      starting: t('ui.preparing'),
      running: t('terminal.status.running'),
      exited: t('terminal.status.exited'),
      failed: t('terminal.status.failed'),
    });
  }
  refreshStatusLabels();

  function notice(message, tone = '') {
    const element = $('#terminalNotice');
    if (!element) return;
    element.innerHTML = `<span class="terminal-notice-dot"></span><span>${esc(message)}</span>`;
    element.dataset.tone = tone;
  }

  function errorMessage(error) {
    return window.LoadToAgentI18n.errorText(error, 'terminal.error.unknown');
  }

  function persistSessionOrder() {
    try {
      localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(state.sessionOrder));
    } catch (error) {
      reportRecoverableError('terminal-session-order-save', error);
    }
  }

  function normalizedSessionOrder() {
    const currentIds = state.sessions.map(session => session.id);
    const validIds = new Set(currentIds);
    const next = [
      ...state.sessionOrder.filter(id => validIds.has(id)),
      ...currentIds.filter(id => !state.sessionOrder.includes(id)),
    ];
    if (next.length !== state.sessionOrder.length || next.some((id, index) => id !== state.sessionOrder[index])) {
      state.sessionOrder = next;
      persistSessionOrder();
    }
    return next;
  }

  function reorderSession(sourceId, targetId, placeAfter = false) {
    if (!sourceId || !targetId || sourceId === targetId) return false;
    const order = normalizedSessionOrder().filter(id => id !== sourceId);
    const targetIndex = order.indexOf(targetId);
    if (targetIndex < 0) return false;
    order.splice(targetIndex + (placeAfter ? 1 : 0), 0, sourceId);
    state.sessionOrder = order;
    persistSessionOrder();
    return true;
  }

  function moveSessionByOffset(sessionId, offset) {
    const visible = modeSessions('general');
    const currentIndex = visible.findIndex(session => session.id === sessionId);
    const target = visible[currentIndex + offset];
    if (currentIndex < 0 || !target) return false;
    return reorderSession(sessionId, target.id, offset > 0);
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

  function resumeSupport(agentSession) {
    if (!agentSession) return { supported: false, reason: t('terminal.resume.no_session_info') };
    const sessionId = String(agentSession.externalId || '').trim();
    if (!sessionId) return { supported: false, reason: t('terminal.resume.no_session_id') };
    const provider = String(agentSession.provider || '').toLowerCase();
    if (!['codex', 'claude', 'gemini'].includes(provider)) {
      return { supported: false, reason: t('terminal.resume.unsupported_provider', { provider: providerLabel(provider) }) };
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
    if (!session) return t('terminal.type.terminal');
    if (session.type === 'wsl') return session.distro || 'Linux';
    if (session.type === 'agent') return providerLabel(session.provider);
    if (session.type === 'powershell') return 'PowerShell';
    if (session.type === 'cmd') return t('terminal.type.command_prompt');
    if (session.type === 'shell') return session.shell || 'Shell';
    return String(session.type || t('terminal.type.terminal')).toUpperCase();
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
      toggle.title = state.historyCollapsed ? t('terminal.history.expand') : t('ui.collapse_conversation_panel');
    }
    if (!agent) return;
    const allMessages = Array.isArray(agent.messages) ? agent.messages.filter(message => message && message.text) : [];
    const messages = allMessages.filter(message => message.role === 'user' || message.role === 'assistant');
    const activityCount = allMessages.length - messages.length;
    const shown = messages.slice(-80);
    $('#terminalHistoryTitle').textContent = agent.title || t('terminal.history.provider_session', { provider: providerLabel(agent.provider) });
    $('#terminalHistoryMeta').textContent = [
      providerLabel(agent.provider),
      window.LoadToAgentI18n.t('session.messages', { count: messages.length }),
      activityCount ? window.LoadToAgentI18n.t('terminal.activity_details', { count: activityCount }) : '',
      messages.length > shown.length ? window.LoadToAgentI18n.t('session.latest_count', { count: shown.length }) : '',
    ].filter(Boolean).join(' · ');
    const list = $('#terminalHistoryList');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    list.innerHTML = shown.length ? shown.map(message => {
      const role = message.role === 'assistant' ? 'assistant' : (message.role === 'tool' ? 'tool' : (message.role === 'system' ? 'system' : 'user'));
      const label = role === 'assistant' ? providerLabel(agent.provider) : (role === 'tool' ? (message.title || t('terminal.history.tool')) : (role === 'system' ? t('terminal.history.system') : t('terminal.history.me')));
      return `<article class="terminal-history-message ${role}"><header><b>${esc(label)}</b><time>${esc(timeLabel(message.timestamp))}</time></header>${historyMessageHtml(message.text)}</article>`;
    }).join('') : `<div class="terminal-history-empty"><b>${t('terminal.history.empty_title')}</b><span>${t('terminal.history.empty_description')}</span></div>`;
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
      } catch (error) {
        reportRecoverableError("terminal-history-refresh", error);
      } finally {
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

  function currentSession() {
    const session = state.sessions.find(item => item.id === state.selectedId) || null;
    if (!session) return null;
    return state.mode === 'tmux' ? (session.type === 'tmux' ? session : null) : (session.type !== 'tmux' ? session : null);
  }

  function currentTmux() {
    if (state.mode !== 'tmux') return null;
    if (!state.selectedTmux) return null;
    const match = tmuxRows().find(row => row.distro.name === state.selectedTmux.distro.name && row.pane.nativeId === state.selectedTmux.pane.nativeId);
    state.selectedTmux = match || null;
    return state.selectedTmux;
  }

  function preferredWorkspace() {
    return state.workspaces[0] && state.workspaces[0].path || '';
  }

  function modeSessions(mode = state.mode) {
    const rank = new Map(normalizedSessionOrder().map((id, index) => [id, index]));
    return state.sessions
      .filter(session => session.type !== 'agent' || window.LoadToAgentApp?.isProviderVisible?.(session.provider) !== false)
      .filter(session => mode === 'tmux' ? session.type === 'tmux' : session.type !== 'tmux')
      .sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER));
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
    if (localButton) localButton.textContent = t('terminal.new_local_session', { platform: state.platform.label });
    if (linuxButton) linuxButton.classList.toggle('hidden', state.platform.id !== 'win32');
    const explain = $('#terminalPlatformExplain');
    if (explain) explain.textContent = state.platform.id === 'win32'
      ? t('terminal.platform.windows_description')
      : t('terminal.platform.description', { platform: state.platform.label });
    const environmentLabel = $('#tmuxEnvironmentLabel');
    if (environmentLabel) environmentLabel.textContent = state.platform.nativeTmux ? t('terminal.environment.local_tmux') : t('terminal.environment.wsl');
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

  const {
    createXtermHost, fitEntry, ensureSessionTerminal, ensureRemoteTerminal, hideScreens, renderSessions, renderTmuxResources, renderTarget, showSelection, selectSession, selectTmux, selectTmuxById, renderAll, refreshSessions, createTerminal, captureRemote, startCapture, stopCapture, sendCommand, sendSignal, openTmuxModal, closeTmuxModal, refreshSnapshot, attachTmux, manageTmux,
  } = window.LoadToAgentTerminalWorkbench({
    $, state, notice, setConnectionState, currentSession, currentTmux, saveCurrentDraft, restoreCurrentDraft,
    renderHistoryPanel, terminalTypeMark, terminalTypeLabel, xtermOptions, preferredWorkspace, firstDistro, guarded,
    esc, errorMessage, modeSessions, STATUS_LABELS, visibleBoundAgent, moveWorkbench,
    tmuxRows: (...args) => tmuxRows(...args),
    updateSnapshot: (...args) => updateSnapshot(...args),
  });

  const {
    tmuxRows, agentTargets, requiredAgentTarget, dispatchAgentCommand, openForAgent, resumeForAgent,
  } = window.LoadToAgentTerminalAgentActions({
    $, state, init, notice, moveWorkbench, selectTmux, selectSession, bindAgent, queueHistoryRefresh,
    renderTarget, fitEntry, refreshSessions, resumeSupport, resumeLaunchArgs, preferredWorkspace, providerLabel, esc,
  });

  function bindEvents() {
    window.LoadToAgentTerminalEvents({
      $,
      state,
      createTerminal,
      openTmuxModal,
      refreshSnapshot,
      selectSession,
      selectTmux,
      sendCommand,
      currentTargetId,
      sendSignal,
      currentSession,
      guarded,
      renderAll,
      showSelection,
      refreshSessions,
      renderHistoryPanel,
      fitEntry,
      attachTmux,
      currentTmux,
      manageTmux,
      closeTmuxModal,
      errorMessage,
      notice,
      reorderSession,
      moveSessionByOffset,
    });
  }

  async function activate(snapshot, workspaces, mode = 'general') {
    const nextMode = mode === 'tmux' ? 'tmux' : 'general';
    const enteringMode = !state.active || state.mode !== nextMode;
    state.active = true;
    state.mode = nextMode;
    moveWorkbench(state.mode);
    if (state.mode === 'general') state.selectedTmux = null;
    if (state.selectedId && !modeSessions().some(item => item.id === state.selectedId)) state.selectedId = null;
    updateSnapshot(snapshot, workspaces);
    if (!state.initialized) {
      state.active = false;
      return;
    }
    await refreshSessions();
    if (!state.active || state.mode !== nextMode) return;
    if (enteringMode && !state.selectedId && !state.selectedTmux) {
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
    const projected = snapshot && window.LoadToAgentApp?.projectVisibleSnapshot
      ? window.LoadToAgentApp.projectVisibleSnapshot(snapshot)
      : snapshot;
    state.snapshot = projected || state.snapshot;
    state.workspaces = Array.isArray(workspaces) ? workspaces : state.workspaces;
    if (!state.initialized) return;
    if (state.boundAgent && state.snapshot && Array.isArray(state.snapshot.sessions)) {
      const updated = state.snapshot.sessions.find(session => session.id === state.boundAgent.id);
      if (!updated) bindAgent(null, null);
      else if (updated.updatedAt !== state.boundAgent.updatedAt) queueHistoryRefresh(updated);
    }
    renderTmuxResources();
    renderTarget();
    if (state.active && state.selectedTmux) startCapture();
  }

  function scrollTmuxToLine(line) {
    if (!state.remoteTerminal) return false;
    const target = Math.max(0, Math.floor(Number(line) || 0));
    state.remoteTerminal.terminal.scrollToLine(target);
    const buffer = state.remoteTerminal.terminal.buffer.active;
    state.remoteViewportAnchor = Number(buffer.viewportY) || 0;
    state.remoteViewportAtBottom = state.remoteViewportAnchor >= Number(buffer.baseY || 0);
    return true;
  }

  function init() {
    if (state.initPromise) return state.initPromise;
    state.initPromise = (async () => {
      if (!window.loadtoagent) return;
      if (!state.eventsBound) {
        bindEvents();
        state.eventsBound = true;
      }
      const [bootstrap, sessions, environments] = await Promise.all([window.loadtoagent.bootstrap(), window.loadtoagent.terminalList(), window.loadtoagent.wslDistros()]);
      state.platform = bootstrap.platform || state.platform;
      state.sessions = Array.isArray(sessions) ? sessions : [];
      state.wslDistros = Array.isArray(environments) ? environments : [];
      state.initialized = true;
      configurePlatform();
      renderAll();
    })().catch(error => {
      state.initialized = false;
      state.initPromise = null;
      throw error;
    });
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
    scrollTmuxToLine,
  };
  window.addEventListener('loadtoagent:locale-changed', () => {
    refreshStatusLabels();
    if (!state.initialized) return;
    configurePlatform();
    renderAll();
  });
  init().catch(error => notice(t('terminal.error.initialization_failed', { message: errorMessage(error) }), 'error'));
})();
