'use strict';

(() => {
  const { $, esc, uiLocale, providerLabel, reportRecoverableError } = window.LoadToAgentRendererUtils;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const SESSION_ORDER_KEY = 'loadtoagent:terminal-session-order:v1';
  const TERMINAL_VIEW_KEY = 'loadtoagent:terminal-view:v1';

  function loadSessionOrder() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_ORDER_KEY) || '[]');
      return Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : [];
    } catch (error) {
      reportRecoverableError('terminal-session-order-load', error);
      return [];
    }
  }

  function loadTerminalViewPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(TERMINAL_VIEW_KEY) || '{}');
      const fontSize = Math.min(20, Math.max(12, Number(saved.fontSize) || 15));
      return { fontSize };
    } catch (error) {
      reportRecoverableError('terminal-view-load', error);
      return { fontSize: 15 };
    }
  }

  const terminalViewPreferences = loadTerminalViewPreferences();

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
    remoteCaptureApplying: false,
    captureTimer: null,
    captureInFlight: false,
    captureGeneration: 0,
    captureRevision: 0,
    resizeObserver: null,
    initialized: false,
    eventsBound: false,
    initPromise: null,
    mode: 'general',
    interactionMode: 'auto',
    boundAgent: null,
    boundTargetId: '',
    historyCollapsed: false,
    historyRefreshTimer: null,
    historyRequests: new Map(),
    historyRenderKey: '',
    historyPointerActive: false,
    historyUserRevision: 0,
    historyFollowFrame: 0,
    historyRenderPending: false,
    historyFlushFrame: 0,
    commandDrafts: new Map(),
    commandHistory: new Map(),
    commandHistoryNavigation: { targetId: '', index: -1, draft: '' },
    commandSending: false,
    pendingActions: new Set(),
    sessionOrder: loadSessionOrder(),
    sessionRenderKey: '',
    draggedSessionId: '',
    sessionDragJustEnded: false,
    terminalFontSize: terminalViewPreferences.fontSize,
    pendingInputFocusId: '',
    terminalFocusMode: false,
    platform: { id: 'win32', label: '내 컴퓨터', computerName: '이 컴퓨터', localShell: 'powershell', localShellLabel: '내 컴퓨터에서 실행하는 작업', nativeTmux: false },
  };
  let composer = null;
  let inputFocusRevision = 0;
  let inputFocusRestoreGeneration = 0;
  document.addEventListener('focusin', () => {
    inputFocusRevision += 1;
  }, true);

  const STATUS_LABELS = {};

  function refreshStatusLabels() {
    Object.assign(STATUS_LABELS, {
      starting: t('ui.preparing'),
      running: t('terminal.status.running'),
      detached: t('terminal.status.detached'),
      stopped: t('terminal.status.stopped'),
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
    const locale = uiLocale();
    return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      ...(String(locale).toLowerCase().startsWith('ko') ? { hourCycle: 'h23' } : {}),
    }) : '';
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
    if (agentSession.parentId) return { supported: false, parentControlled: true, reason: t('terminal.resume.parent_controlled') };
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
    if (session.type === 'wsl') return '이 컴퓨터에서 직접 실행되지 않는 별도 작업 공간';
    if (session.type === 'agent') return providerLabel(session.provider);
    if (session.type === 'powershell') return state.platform.computerName || state.platform.label || '이 컴퓨터';
    if (session.type === 'cmd') return t('terminal.type.command_prompt');
    if (session.type === 'shell') return session.shell || '컴퓨터 작업';
    return t('terminal.type.terminal');
  }

  function terminalTypeMark(session) {
    if (!session) return '›_';
    if (session.type === 'wsl') return '›_';
    if (session.type === 'agent') return 'AI';
    if (session.type === 'powershell') return '›_';
    if (session.type === 'cmd') return '›_';
    if (session.type === 'shell') return '›_';
    return '›_';
  }

  function setConnectionState(label, status = '') {
    const element = $('#terminalConnectionState');
    if (!element) return;
    element.innerHTML = `<i></i><span>${esc(label)}</span>`;
    element.dataset.status = status;
  }

  function persistTerminalViewPreferences() {
    try {
      localStorage.setItem(TERMINAL_VIEW_KEY, JSON.stringify({ fontSize: state.terminalFontSize }));
    } catch (error) {
      reportRecoverableError('terminal-view-save', error);
    }
  }

  function syncTerminalViewControls() {
    const section = $('#terminalSection');
    const focusButton = $('#terminalFocusBtn');
    section?.classList.toggle('terminal-focus-mode', state.terminalFocusMode);
    $('#terminalResourcePanel')?.toggleAttribute('inert', state.terminalFocusMode);
    $('#terminalHistoryPanel')?.toggleAttribute('inert', state.terminalFocusMode);
    const readableFontSize = state.terminalFontSize <= 13 ? '작게' : state.terminalFontSize <= 16 ? '보통' : '크게';
    if ($('#terminalFontCurrentLabel')) $('#terminalFontCurrentLabel').textContent = t('terminal.view.font_size_current', { size: readableFontSize });
    if ($('#terminalFontSizeLabel')) $('#terminalFontSizeLabel').textContent = t('terminal.view.font_size_value', { size: readableFontSize });
    if ($('#terminalFontDecreaseBtn')) $('#terminalFontDecreaseBtn').disabled = state.terminalFontSize <= 12;
    if ($('#terminalFontIncreaseBtn')) $('#terminalFontIncreaseBtn').disabled = state.terminalFontSize >= 20;
    if (focusButton) {
      focusButton.setAttribute('aria-pressed', state.terminalFocusMode ? 'true' : 'false');
      focusButton.title = state.terminalFocusMode ? t('terminal.view.focus_exit') : t('terminal.view.focus');
      const label = focusButton.querySelector('span');
      if (label) label.textContent = state.terminalFocusMode ? t('terminal.view.focus_exit') : t('terminal.view.focus');
    }
  }

  function refitVisibleTerminal() {
    const session = currentSession();
    const entry = session ? state.terminals.get(session.id) : state.remoteTerminal;
    fitEntry(entry, session?.id || '');
  }

  function setTerminalFontSize(value) {
    const next = Math.min(20, Math.max(12, Math.round(Number(value) || 15)));
    if (next === state.terminalFontSize) return;
    state.terminalFontSize = next;
    for (const entry of [...state.terminals.values(), state.remoteTerminal].filter(Boolean)) {
      entry.terminal.options.fontSize = next;
      entry.terminal.options.lineHeight = next >= 17 ? 1.32 : 1.28;
    }
    persistTerminalViewPreferences();
    syncTerminalViewControls();
    refitVisibleTerminal();
    window.LoadToAgentA11y?.announce(t('terminal.view.font_size_value', { size: next }));
  }

  function toggleTerminalFocusMode() {
    state.terminalFocusMode = !state.terminalFocusMode;
    syncTerminalViewControls();
    requestAnimationFrame(refitVisibleTerminal);
    window.LoadToAgentA11y?.announce(state.terminalFocusMode ? t('terminal.view.focus_on') : t('terminal.view.focus_off'));
  }

  function currentTargetId() {
    const session = currentSession();
    if (session) return session.id;
    const remote = currentTmux();
    return remote ? `tmux:${remote.distro.name}:${remote.pane.nativeId}` : '';
  }

  function visibleBoundAgent() {
    if (!state.boundAgent || state.boundTargetId !== currentTargetId()) return null;
    if (window.LoadToAgentApp?.isProviderVisible?.(state.boundAgent.provider) === false) return null;
    return state.boundAgent;
  }

  function saveCurrentDraft() {
    const targetId = currentTargetId();
    const input = $('#terminalCommandInput');
    if (targetId && input) state.commandDrafts.set(targetId, input.value);
  }

  function restoreCurrentDraft() {
    const input = $('#terminalCommandInput');
    if (input) {
      input.value = state.commandDrafts.get(currentTargetId()) || '';
      $('#terminalCommandClearBtn')?.classList.toggle('hidden', !input.value);
      composer?.sync();
    }
  }

  function observedProgressText(value) {
    const observed = window.LoadToAgentI18n.observedText
      ? window.LoadToAgentI18n.observedText(value)
      : String(value || '');
    const readable = window.LoadToAgentApp?.readableActivityDetail?.(observed);
    return String(readable || observed || '').replace(/\s+/g, ' ').trim();
  }

  function terminalSubagentRecords(root) {
    const sessions = Array.isArray(state.snapshot?.sessions) ? state.snapshot.sessions : [];
    const byId = new Map(sessions.map(session => [session.id, session]));
    // A detail refresh can contain newer root collaboration events than the card
    // in the snapshot, so keep it as the authoritative root record.
    byId.set(root.id, root);
    const records = [];
    const seen = new Set([root.id]);
    const visit = (parent, depth) => {
      const declaredIds = Array.isArray(parent?.childIds) ? parent.childIds : [];
      const inferredIds = sessions
        .filter(session => session?.parentId === parent?.id)
        .map(session => session.id);
      for (const id of [...new Set([...declaredIds, ...inferredIds])]) {
        if (!id || seen.has(id)) continue;
        const session = byId.get(id);
        if (!session) continue;
        seen.add(id);
        records.push({ session, parent, depth });
        visit(session, depth + 1);
      }
    };
    visit(root, 1);

    return records.map(record => {
      const { session, parent, depth } = record;
      const taskName = session.taskName || session.delegation?.taskName || session.title || '';
      const communications = Array.isArray(parent?.collaboration?.communications)
        ? parent.collaboration.communications
        : [];
      const related = communications
        .filter(event => event && !event.protected)
        .filter(event => ['assignment', 'started', 'followup', 'message', 'result', 'interrupt'].includes(event.kind))
        .filter(event => event.childId === session.id || (taskName && event.taskName === taskName));
      const assignmentEvent = [...related].reverse().find(event => event.kind === 'assignment' && observedProgressText(event.text));
      const delegation = session.delegation || {};
      const assignment = delegation.assignmentObserved && !delegation.assignmentProtected && observedProgressText(delegation.assignment)
        ? observedProgressText(delegation.assignment)
        : (assignmentEvent ? observedProgressText(assignmentEvent.text) : observedProgressText(session.title || taskName));
      const lifecycle = (Array.isArray(session.lifecycle) ? session.lifecycle : [])
        .filter(item => item && (item.label || item.detail))
        .map((item, index) => ({
          id: item.id || `lifecycle:${index}`,
          kind: item.type || 'activity',
          label: observedProgressText(item.label || t('ui.progress')),
          detail: observedProgressText(item.detail),
          timestamp: item.timestamp || session.updatedAt || '',
        }));
      const coordination = related
        .filter(event => event.kind !== 'assignment')
        .map(event => ({
          id: event.id || `${event.kind}:${event.timestamp || ''}`,
          kind: event.kind,
          label: observedProgressText(event.label || event.kind),
          detail: event.kind === 'started' && String(event.text || '').trim().toLowerCase() === 'started'
            ? ''
            : observedProgressText(event.text),
          timestamp: event.timestamp || session.updatedAt || '',
        }));
      const events = [...lifecycle, ...coordination]
        .sort((left, right) => (Date.parse(left.timestamp || 0) || 0) - (Date.parse(right.timestamp || 0) || 0))
        .filter((event, index, items) => index === items.findIndex(candidate => (
          candidate.kind === event.kind
          && candidate.label === event.label
          && candidate.detail === event.detail
          && candidate.timestamp === event.timestamp
        )))
        .slice(-4);
      const workState = window.LoadToAgentApp?.subagentWorkState?.(session)
        || (session.status === 'running' || session.status === 'starting' ? 'working' : (session.status === 'failed' ? 'attention' : 'resting'));
      const stateLabel = window.LoadToAgentApp?.subagentWorkLabel?.(session)
        || ({ working: t('ui.working'), attention: t('ui.needs_attention'), resting: t('ui.idle') })[workState];
      return {
        session,
        depth,
        taskName,
        assignment,
        events,
        workState,
        stateLabel,
        name: observedProgressText(session.agentName || taskName || session.title || providerLabel(session.provider)),
        role: observedProgressText(session.agentRole || providerLabel(session.provider)),
        statusDetail: observedProgressText(session.statusDetail),
      };
    });
  }

  function terminalSubagentProgress(root) {
    const records = terminalSubagentRecords(root);
    if (!records.length) return { html: '', key: [], count: 0, working: 0, attention: 0 };
    const working = records.filter(record => record.workState === 'working').length;
    const attention = records.filter(record => record.workState === 'attention').length;
    const summary = [
      t('tmux.subagents.connected_count', { count: records.length }),
      working ? t('tmux.subagents.working_count', { count: working }) : t('tmux.subagents.all_idle'),
      attention ? t('tmux.subagents.attention_count', { count: attention }) : '',
    ].filter(Boolean).join(' · ');
    const cards = records.map(record => {
      const events = record.events.length
        ? record.events.map(event => `<li data-terminal-subagent-event="${esc(event.kind)}">
            <i></i><div><b>${esc(event.label || t('ui.progress'))}</b>${event.detail ? `<span>${esc(event.detail)}</span>` : ''}</div><time>${esc(timeLabel(event.timestamp))}</time>
          </li>`).join('')
        : `<li class="empty"><i></i><span>${esc(t('terminal.subagents.no_updates'))}</span></li>`;
      return `<article class="terminal-subagent-card ${esc(record.workState)}" data-terminal-subagent-id="${esc(record.session.id)}" data-terminal-subagent-state="${esc(record.workState)}" data-terminal-subagent-depth="${record.depth}" style="--terminal-subagent-depth:${Math.min(record.depth - 1, 3)}">
        <header><div><span>${record.depth > 1 ? '↳ ' : ''}${esc(record.name)}</span><small>${esc(record.role)}</small></div><b>${esc(record.stateLabel)}</b></header>
        <div class="terminal-subagent-assignment"><em>${esc(t('drawer.assignment'))}</em><span>${esc(record.assignment || t('tmux.subagents.checking_assignment'))}</span></div>
        ${record.statusDetail ? `<div class="terminal-subagent-current"><em>${esc(t('terminal.subagents.current'))}</em><span>${esc(record.statusDetail)}</span></div>` : ''}
        <ol>${events}</ol>
      </article>`;
    }).join('');
    return {
      html: `<section class="terminal-subagent-progress" data-terminal-subagent-progress data-terminal-subagent-count="${records.length}">
        <header><div><b>${esc(t('terminal.subagents.title'))}</b><span>${esc(t('terminal.subagents.description'))}</span></div><small>${esc(summary)}</small></header>
        <div class="terminal-subagent-cards">${cards}</div>
      </section>`,
      key: records.map(record => [
        record.session.id, record.session.parentId || '', record.depth, record.workState,
        record.name, record.role, record.assignment, record.statusDetail,
        record.events.map(event => [event.id, event.kind, event.label, event.detail, event.timestamp]),
      ]),
      count: records.length,
      working,
      attention,
    };
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
      const toggleLabel = state.historyCollapsed ? t('terminal.history.expand') : t('ui.collapse_conversation_panel');
      toggle.title = toggleLabel;
      toggle.setAttribute('aria-label', toggleLabel);
    }
    if (!agent) return;
    const allMessages = Array.isArray(agent.messages) ? agent.messages.filter(message => message && message.text) : [];
    const messages = allMessages.filter(message => message.role === 'user' || message.role === 'assistant');
    const activityCount = allMessages.length - messages.length;
    const shown = messages.slice(-80);
    const subagents = terminalSubagentProgress(agent);
    $('#terminalHistoryTitle').textContent = agent.title || t('terminal.history.provider_session', { provider: providerLabel(agent.provider) });
    $('#terminalHistoryMeta').textContent = [
      providerLabel(agent.provider),
      window.LoadToAgentI18n.t('session.messages', { count: messages.length }),
      subagents.count ? t('tmux.subagents.connected_count', { count: subagents.count }) : '',
      activityCount ? window.LoadToAgentI18n.t('terminal.activity_details', { count: activityCount }) : '',
      messages.length > shown.length ? window.LoadToAgentI18n.t('session.latest_count', { count: shown.length }) : '',
    ].filter(Boolean).join(' · ');
    const list = $('#terminalHistoryList');
    const previousTop = list.scrollTop;
    const wasAtBottom = window.LoadToAgentRendererUtils.isScrolledToEnd(list);
    const renderKey = JSON.stringify([
      agent.id,
      uiLocale(),
      providerLabel(agent.provider),
      subagents.key,
      shown.map(message => [message.id || '', message.role || '', message.title || '', message.timestamp || '', message.text || '']),
    ]);
    const contentChanged = state.historyRenderKey !== renderKey;
    const selection = window.getSelection?.();
    const selectionInside = Boolean(selection && !selection.isCollapsed && (
      (selection.anchorNode && list.contains(selection.anchorNode))
      || (selection.focusNode && list.contains(selection.focusNode))
    ));
    if (contentChanged && !forceBottom && (state.historyPointerActive || selectionInside)) {
      state.historyRenderPending = true;
      return;
    }
    state.historyRenderPending = false;
    if (contentChanged) {
      const conversationHtml = shown.length ? shown.map(message => {
        const role = message.role === 'assistant' ? 'assistant' : (message.role === 'tool' ? 'tool' : (message.role === 'system' ? 'system' : 'user'));
        const label = role === 'assistant' ? providerLabel(agent.provider) : (role === 'tool' ? (message.title || t('terminal.history.tool')) : (role === 'system' ? t('terminal.history.system') : t('terminal.history.me')));
        return `<article class="terminal-history-message ${role}"><header><b>${esc(label)}</b><time>${esc(timeLabel(message.timestamp))}</time></header>${historyMessageHtml(message.text)}</article>`;
      }).join('') : `<div class="terminal-history-empty${subagents.count ? ' with-subagents' : ''}"><b>${t('terminal.history.empty_title')}</b><span>${t('terminal.history.empty_description')}</span></div>`;
      list.innerHTML = `${subagents.html}${conversationHtml}`;
      state.historyRenderKey = renderKey;
    }

    const shouldFollow = forceBottom || (contentChanged && wasAtBottom && !state.historyPointerActive && !selectionInside);
    if (state.historyFollowFrame) cancelAnimationFrame(state.historyFollowFrame);
    state.historyFollowFrame = 0;
    if (!contentChanged && !forceBottom) return;
    if (!shouldFollow) {
      list.scrollTop = Math.min(previousTop, Math.max(0, list.scrollHeight - list.clientHeight));
      return;
    }
    const revision = state.historyUserRevision;
    state.historyFollowFrame = requestAnimationFrame(() => {
      state.historyFollowFrame = 0;
      if (revision !== state.historyUserRevision || state.historyPointerActive) return;
      const activeSelection = window.getSelection?.();
      if (activeSelection && !activeSelection.isCollapsed && (
        (activeSelection.anchorNode && list.contains(activeSelection.anchorNode))
        || (activeSelection.focusNode && list.contains(activeSelection.focusNode))
      )) return;
      list.scrollTop = list.scrollHeight;
    });
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
          const currentUpdatedAt = Date.parse(state.boundAgent.updatedAt || 0);
          const detailUpdatedAt = Date.parse(detail.updatedAt || 0);
          const currentHasMessages = Array.isArray(state.boundAgent.messages) && state.boundAgent.messages.length > 0;
          const detailIsCurrent = !currentHasMessages
            || !Number.isFinite(currentUpdatedAt)
            || (Number.isFinite(detailUpdatedAt) && detailUpdatedAt >= currentUpdatedAt);
          // A slower detail request may finish after a newer snapshot has
          // already reached the terminal. Never replace the newer conversation
          // with that stale response or the reader's scroll range will shrink.
          if (detailIsCurrent) {
            state.boundAgent = detail;
            renderHistoryPanel();
          }
        }
      } catch (error) {
        reportRecoverableError("terminal-history-refresh", error);
      } finally {
        state.historyRequests.delete(id);
      }
    }, 240);
  }

  async function guarded(action, successMessage = '', actionKey = '') {
    if (actionKey && state.pendingActions.has(actionKey)) return null;
    if (actionKey) state.pendingActions.add(actionKey);
    try {
      const result = await action();
      if (successMessage) notice(successMessage, 'success');
      return result;
    } catch (error) {
      notice(errorMessage(error), 'error');
      return null;
    } finally {
      if (actionKey) state.pendingActions.delete(actionKey);
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
      .filter(Boolean)
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
    const computerName = state.platform.computerName || state.platform.label || t('runtime.location_this_computer', {
      computer: '이 컴퓨터',
      platform: state.platform.label,
    });
    const distro = firstDistro();
    if (localButton) localButton.textContent = '＋ 내 Windows 컴퓨터에서 시작';
    if (linuxButton) {
      linuxButton.classList.toggle('hidden', state.platform.id !== 'win32');
      linuxButton.textContent = '＋ 다른 Linux 컴퓨터에서 시작';
    }
    const tmuxButton = $('#newTmuxSessionBtn');
    if (tmuxButton) tmuxButton.textContent = t('ui.create_tmux_workspace', {
      computer: distro?.name || distro?.displayName || t('tmux.name_unknown'),
    });
    const tmuxTitle = $('#tmuxSelectedComputerTitle');
    if (tmuxTitle && !/’에서 실행한 작업 \d+건$/.test(tmuxTitle.textContent || '')) {
      tmuxTitle.textContent = '‘업무용 컴퓨터 2’에서 실행한 작업';
    }
    const tmuxCreateTitle = $('#tmuxCreateTitle');
    if (tmuxCreateTitle) tmuxCreateTitle.textContent = t('ui.create_multi_window_workspace', {
      computer: distro?.name || distro?.displayName || t('tmux.name_unknown'),
    });
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
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "D2Coding", monospace',
      fontSize: state.terminalFontSize,
      letterSpacing: -2,
      lineHeight: state.terminalFontSize >= 17 ? 1.32 : 1.28,
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
    createXtermHost, fitEntry, ensureSessionTerminal, ensureRemoteTerminal, hideScreens, linkedAgentSession, isAiTerminalSession, renderSessions, renderTmuxResources, renderTarget, showSelection, selectSession, selectTmux, selectTmuxById, renderAll, refreshSessions, createTerminal, captureRemote, startCapture, stopCapture, sendCommand, sendSignal, openTmuxModal, closeTmuxModal, refreshSnapshot, attachTmux, manageTmux, focusComputerWorkInput,
  } = window.LoadToAgentTerminalWorkbench({
    $, state, notice, setConnectionState, currentSession, currentTmux, saveCurrentDraft, restoreCurrentDraft,
    renderHistoryPanel, terminalTypeMark, terminalTypeLabel, providerLabel, xtermOptions, preferredWorkspace, firstDistro, guarded,
    esc, errorMessage, modeSessions, STATUS_LABELS, visibleBoundAgent, moveWorkbench,
    syncComposer: (...args) => composer?.sync(...args),
    tmuxRows: (...args) => tmuxRows(...args),
    updateSnapshot: (...args) => updateSnapshot(...args),
  });

  composer = window.LoadToAgentTerminalComposer.create({
    $, state, currentTargetId, esc,
    isAiTarget: () => isAiTerminalSession(currentSession()),
    providerForTarget: () => visibleBoundAgent()?.provider || currentSession()?.provider || '',
  });

  const {
    tmuxRows, agentTargets, requiredAgentTarget, dispatchAgentCommand, interruptAgent, openForAgent, resumeForAgent, resetForAgent,
  } = window.LoadToAgentTerminalAgentActions({
    $, state, init, notice, moveWorkbench, selectTmux, selectSession, bindAgent, queueHistoryRefresh,
    renderTarget, fitEntry, refreshSessions, resumeSupport, resumeLaunchArgs, preferredWorkspace, providerLabel, terminalTypeLabel, esc,
    syncComposer: (...args) => composer?.sync(...args),
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
      setTerminalFontSize,
      toggleTerminalFocusMode,
      focusComputerWorkInput,
      isAiTerminalSession,
      composer,
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
    // Snapshot renders call activate repeatedly while this view is already
    // open. Refreshing and re-showing the same xterm screen would temporarily
    // hide its helper textarea and steal direct keyboard focus.
    if (!enteringMode) return;
    await refreshSessions();
    if (!state.active || state.mode !== nextMode) return;
    let selectionChanged = false;
    if (enteringMode && !state.selectedId && !state.selectedTmux) {
      const visible = modeSessions();
      if (visible.length) {
        state.selectedId = visible[0].id;
        selectionChanged = true;
      } else if (state.mode === 'tmux') {
        state.selectedTmux = tmuxRows()[0] || null;
        selectionChanged = Boolean(state.selectedTmux);
      }
    }
    // refreshSessions already rendered and showed the existing selection. Avoid
    // hiding the same xterm host a second time after users can start typing.
    if (!selectionChanged) return;
    renderAll();
    await showSelection();
  }

  function deactivate() {
    inputFocusRestoreGeneration += 1;
    state.pendingInputFocusId = '';
    state.active = false;
    stopCapture();
  }

  function updateSnapshot(snapshot, workspaces = state.workspaces) {
    const focusedTerminalPair = [...state.terminals.entries()].find(([, entry]) =>
      entry.host.contains(document.activeElement)) || null;
    const focusedTerminal = focusedTerminalPair?.[1] || null;
    const focusedTerminalId = focusedTerminalPair?.[0] || state.pendingInputFocusId;
    const restoreGeneration = focusedTerminalPair
      ? ++inputFocusRestoreGeneration
      : inputFocusRestoreGeneration;
    let restoreFocusRevision = inputFocusRevision;
    if (focusedTerminalPair) state.pendingInputFocusId = focusedTerminalId;
    const projected = snapshot && window.LoadToAgentApp?.projectVisibleSnapshot
      ? window.LoadToAgentApp.projectVisibleSnapshot(snapshot)
      : snapshot;
    state.snapshot = projected || state.snapshot;
    state.workspaces = Array.isArray(workspaces) ? workspaces : state.workspaces;
    if (!state.initialized) {
      state.pendingInputFocusId = '';
      return;
    }
    if (state.boundAgent && state.snapshot && Array.isArray(state.snapshot.sessions)) {
      const updated = state.snapshot.sessions.find(session => session.id === state.boundAgent.id);
      // Keep the conversation associated with its live terminal even when a
      // monitor refresh temporarily omits an ended or slow-to-scan AI session.
      // The binding is explicitly cleared when the terminal closes, and the
      // provider visibility guard above prevents hidden providers from leaking.
      if (updated && updated.updatedAt !== state.boundAgent.updatedAt) queueHistoryRefresh(updated);
      // Child sessions are updated independently from their parent. The render
      // key prevents unnecessary DOM replacement while still reflecting their
      // latest lifecycle and collaboration events in the terminal history.
      renderHistoryPanel();
    }
    renderSessions();
    renderTmuxResources();
    renderTarget();
    if (focusedTerminal && !focusedTerminal.host.classList.contains('hidden')) {
      const clearPendingFocus = () => {
        if (restoreGeneration === inputFocusRestoreGeneration
          && state.pendingInputFocusId === focusedTerminalId) state.pendingInputFocusId = '';
      };
      const restoreInputFocus = (finalAttempt = false) => {
        if (restoreGeneration !== inputFocusRestoreGeneration
          || state.pendingInputFocusId !== focusedTerminalId) return;
        const pending = state.terminals.get(focusedTerminalId);
        const activeElement = document.activeElement;
        const terminalStillSelected = state.active
          && state.mode === 'general'
          && state.selectedId === focusedTerminalId;
        const focusStillRestorable = inputFocusRevision === restoreFocusRevision
          && (!activeElement
            || activeElement === document.body
            || activeElement === document.documentElement
            || pending?.host.contains(activeElement));
        if (!pending
          || !pending.host.isConnected
          || pending.host.classList.contains('hidden')
          || !terminalStillSelected
          || !focusStillRestorable) {
          clearPendingFocus();
          return;
        }
        if (!pending.host.contains(activeElement)) {
          pending.terminal.focus();
          restoreFocusRevision = inputFocusRevision;
        }
        if (finalAttempt) clearPendingFocus();
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          restoreInputFocus();
          // The application snapshot renderer also runs in an animation frame.
          // Its final DOM synchronization can finish after this module's frame,
          // so make one last focus restoration in the following task.
          setTimeout(() => restoreInputFocus(true), 0);
        });
      });
    } else if (focusedTerminalPair) {
      state.pendingInputFocusId = '';
    }
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

  function scrollTmuxByLines(lines) {
    if (!state.remoteTerminal) return false;
    state.remoteTerminal.terminal.scrollLines(Math.trunc(Number(lines) || 0));
    return true;
  }

  function scrollTerminalToLine(id, line) {
    const entry = state.terminals.get(String(id || ''));
    if (!entry) return false;
    entry.userScrollRevision += 1;
    entry.terminal.scrollToLine(Math.max(0, Math.floor(Number(line) || 0)));
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
      const [bootstrap, sessions, environments] = await Promise.all([window.LoadToAgentRendererUtils.bootstrap(), window.loadtoagent.terminalList(), window.loadtoagent.wslDistros()]);
      state.platform = bootstrap.platform || state.platform;
      state.sessions = Array.isArray(sessions) ? sessions : [];
      state.wslDistros = Array.isArray(environments) ? environments : [];
      state.initialized = true;
      configurePlatform();
      if (!state.resizeObserver && 'ResizeObserver' in window) {
        state.resizeObserver = new ResizeObserver(() => {
          const entry = currentSession() ? state.terminals.get(state.selectedId) : state.remoteTerminal;
          fitEntry(entry, state.selectedId || '');
        });
        state.resizeObserver.observe($('#terminalViewport'));
      }
      syncTerminalViewControls();
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
    interruptAgent,
    openForAgent,
    resumeForAgent,
    resetForAgent,
    scrollTmuxToLine,
    scrollTmuxByLines,
    scrollTerminalToLine,
  };
  window.addEventListener('loadtoagent:locale-changed', () => {
    refreshStatusLabels();
    if (!state.initialized) return;
    configurePlatform();
    syncTerminalViewControls();
    renderAll();
  });
  init().catch(error => notice(t('terminal.error.initialization_failed', { message: errorMessage(error) }), 'error'));
})();
