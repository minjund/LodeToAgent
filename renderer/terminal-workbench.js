'use strict';

/** Own xterm views, terminal/tmux selection, capture, and management actions. */
window.LoadToAgentTerminalWorkbench = function createModule(context) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const RAW_INPUT_BATCH_CHARS = 128 * 1024;
  const MAX_RAW_INPUT_QUEUE_CHARS = 512 * 1024;
  const {
    $, state, notice, setConnectionState, currentSession, currentTmux, saveCurrentDraft, restoreCurrentDraft,
    renderHistoryPanel, terminalTypeMark, terminalTypeLabel, providerLabel, xtermOptions, preferredWorkspace, firstDistro, guarded,
    esc, errorMessage, modeSessions, STATUS_LABELS, visibleBoundAgent, moveWorkbench, tmuxRows, updateSnapshot,
    tmuxTargetKey,
    syncComposer,
  } = context;
  let tmuxModalFocusToken = null;
  const rawInputBarriers = new Map();
  const scheduledRawInputEntries = new Set();
  const enqueueMicrotask = typeof window.queueMicrotask === 'function'
    ? callback => window.queueMicrotask(callback)
    : callback => Promise.resolve().then(callback);

  function documentIsHidden() {
    return document.hidden === true || document.visibilityState === 'hidden';
  }

  function flushHiddenRawInputPumps() {
    if (!documentIsHidden()) return;
    for (const entry of [...scheduledRawInputEntries]) {
      if (typeof entry.inputPumpFlush === 'function') enqueueMicrotask(entry.inputPumpFlush);
    }
  }

  document.addEventListener?.('visibilitychange', flushHiddenRawInputPumps);

  function nextRawInputDeliveryId(entry) {
    entry.inputSequence += 1;
    const random = window.crypto?.randomUUID?.().replace(/-/g, '')
      || `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    return `delivery:raw:${Date.now().toString(36)}:${entry.inputSequence.toString(36)}:${random}`;
  }

  function takeRawInputBatch(entry) {
    let batch = '';
    while (entry.inputQueue.length) {
      const chunk = entry.inputQueue[0];
      // xterm emits bracketed paste and other control sequences as one data
      // event. Never cut an event in half: dropping a trailing paste terminator
      // can leave the remote TTY in paste mode and corrupt all later typing.
      if (batch && batch.length + chunk.length > RAW_INPUT_BATCH_CHARS) break;
      if (chunk.length > RAW_INPUT_BATCH_CHARS) break;
      batch += chunk;
      entry.inputQueue.shift();
      entry.inputQueueChars = Math.max(0, entry.inputQueueChars - chunk.length);
    }
    return batch;
  }

  function clearRawInputQueue(entry) {
    entry.inputQueue = [];
    entry.inputQueueChars = 0;
  }

  function closeRawInputEntry(entry) {
    if (!entry) return;
    entry.inputClosed = true;
    entry.inputPumpHalted = true;
    clearRawInputQueue(entry);
    entry.inputPumpScheduleGeneration += 1;
    entry.inputPumpScheduled = false;
    entry.inputPumpFlush = null;
    scheduledRawInputEntries.delete(entry);
    if (entry.inputPumpFrame) {
      window.cancelAnimationFrame?.(entry.inputPumpFrame);
      entry.inputPumpFrame = 0;
    }
    if (entry.inputPumpTimer) {
      clearTimeout(entry.inputPumpTimer);
      entry.inputPumpTimer = 0;
    }
  }

  async function pumpRawInput(entry, key) {
    while (!entry.inputClosed && entry.inputQueue.length) {
      const batch = takeRawInputBatch(entry);
      if (!batch) break;
      const deliveryId = nextRawInputDeliveryId(entry);
      let failed = false;
      try {
        const result = await window.loadtoagent.terminalWrite(key, batch, { deliveryId });
        if (result?.deliveryState === 'unknown') {
          notice(t('terminal.error.input_failed'), 'warning');
          failed = true;
        }
      } catch (error) {
        notice(errorMessage(error), error?.deliveryState === 'unknown' ? 'warning' : 'error');
        failed = true;
      }
      if (failed) {
        // The current bytes may already be in the PTY. Sending a queued suffix
        // automatically could submit half a command or finish an uncertain
        // paste. Drop the suffix and require the user's next explicit input.
        clearRawInputQueue(entry);
        entry.inputPumpHalted = true;
        break;
      }
    }
    if (!entry.inputQueue.length) entry.inputOverflowNotified = false;
  }

  function scheduleRawInputPump(entry, key) {
    if (entry.inputPump || entry.inputPumpScheduled) return;
    const generation = ++entry.inputPumpScheduleGeneration;
    entry.inputPumpScheduled = true;
    scheduledRawInputEntries.add(entry);
    const flush = () => {
      if (!entry.inputPumpScheduled || generation !== entry.inputPumpScheduleGeneration) return;
      entry.inputPumpScheduled = false;
      entry.inputPumpFlush = null;
      scheduledRawInputEntries.delete(entry);
      if (entry.inputPumpFrame) window.cancelAnimationFrame?.(entry.inputPumpFrame);
      entry.inputPumpFrame = 0;
      if (entry.inputPumpTimer) clearTimeout(entry.inputPumpTimer);
      entry.inputPumpTimer = 0;
      if (entry.inputPump || entry.inputClosed) return;
      const previous = rawInputBarriers.get(key) || Promise.resolve();
      const task = previous.catch(() => {}).then(() => pumpRawInput(entry, key)).finally(() => {
        if (entry.inputPump === task) entry.inputPump = null;
        if (rawInputBarriers.get(key) === task) rawInputBarriers.delete(key);
        if (!entry.inputClosed && !entry.inputPumpHalted && entry.inputQueue.length) scheduleRawInputPump(entry, key);
      });
      rawInputBarriers.set(key, task);
      entry.inputPump = task;
      entry.writeQueue = task;
    };
    entry.inputPumpFlush = flush;
    if (documentIsHidden()) {
      enqueueMicrotask(flush);
      return;
    }
    // Visible xterms still coalesce the short burst of onData fragments in one
    // paint. The bounded task fallback prevents a stalled paint from holding
    // input, while visibilitychange switches to a microtask before background
    // animation-frame throttling can strand the final keystroke.
    entry.inputPumpFrame = requestAnimationFrame(flush);
    entry.inputPumpTimer = setTimeout(() => enqueueMicrotask(flush), 32);
  }

  function enqueueRawInput(entry, key, value) {
    const data = String(value || '');
    if (!data || entry.inputClosed) return;
    if (entry.inputPumpHalted) entry.inputPumpHalted = false;
    const available = Math.max(0, MAX_RAW_INPUT_QUEUE_CHARS - entry.inputQueueChars);
    if (data.length > RAW_INPUT_BATCH_CHARS || data.length > available) {
      // An onData event is one logical xterm input operation. All-or-nothing
      // admission keeps surrogate pairs and bracketed-paste delimiters intact.
      if (!entry.inputOverflowNotified) {
        entry.inputOverflowNotified = true;
        notice(t('terminal.error.input_failed'), 'error');
      }
      return;
    }
    entry.inputQueue.push(data);
    entry.inputQueueChars += data.length;
    scheduleRawInputPump(entry, key);
  }

  function relativeTime(value) {
    const ms = Date.now() - Date.parse(value || 0);
    if (!Number.isFinite(ms) || ms < 8_000) return t('time.just_now');
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return t('time.seconds_ago', { count: seconds });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('time.minutes_ago', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time.hours_ago', { count: hours });
    return t('time.days_ago', { count: Math.floor(hours / 24) });
  }

  function createXtermHost(key, readOnly = false, session = null) {
    if (!window.Terminal || !window.FitAddon || !window.FitAddon.FitAddon) throw new Error(t('terminal.error.screen_unavailable'));
    const host = document.createElement('div');
    host.className = 'terminal-screen hidden';
    host.dataset.terminalScreen = key;
    $('#terminalViewport').appendChild(host);
    const fixedGrid = session?.fixedGrid ? {
      cols: Number(session.cols) || 120,
      rows: Number(session.rows) || 32,
    } : null;
    const inputDisabled = readOnly;
    const terminal = new window.Terminal({
      ...xtermOptions(inputDisabled),
      ...(fixedGrid || {}),
    });
    const fit = new window.FitAddon.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const entry = {
      terminal, fit, host, readOnly, inputDisabled, fixedGrid, userScrollRevision: 0, outputWritePending: 0,
      outputRestoreGeneration: 0, wheelLineRemainder: 0,
      writeQueue: Promise.resolve(), pendingResize: null, resizePromise: null,
      inputQueue: [], inputQueueChars: 0, inputPump: null, inputPumpFrame: 0, inputPumpTimer: 0,
      inputPumpScheduled: false, inputPumpScheduleGeneration: 0, inputPumpFlush: null,
      inputSequence: 0, inputOverflowNotified: false, inputPumpHalted: false, inputClosed: false,
      outputHydrating: !readOnly,
      outputSequence: null,
      outputHydrationBuffer: [],
    };
    entry.acceptOutput = payload => {
      const data = String(payload?.data || '');
      const sequenceValue = payload?.outputSequence;
      const parsedSequence = sequenceValue == null || sequenceValue === '' ? Number.NaN : Number(sequenceValue);
      const outputSequence = Number.isSafeInteger(parsedSequence) && parsedSequence >= 0
        ? parsedSequence
        : null;
      if (entry.outputHydrating) {
        entry.outputHydrationBuffer.push({ data, outputSequence, arrival: entry.outputHydrationBuffer.length });
        return null;
      }
      if (outputSequence != null) {
        if (entry.outputSequence != null && outputSequence <= entry.outputSequence) return null;
        entry.outputSequence = outputSequence;
      }
      return data;
    };
    const syncScrollState = viewportY => {
      const normalizedViewport = Number(viewportY) || 0;
      const baseY = Number(terminal.buffer.active.baseY) || 0;
      host.dataset.viewportY = String(normalizedViewport);
      host.dataset.baseY = String(baseY);
      // Xterm may consume wheel events before they bubble to the host. Its
      // scroll event is the reliable source for mouse, keyboard and scrollbar
      // viewport changes.
      if (readOnly && !state.remoteCaptureApplying) {
        state.remoteViewportAnchor = normalizedViewport;
        state.remoteViewportAtBottom = normalizedViewport >= baseY;
      }
    };
    terminal.onScroll(syncScrollState);
    syncScrollState(0);
    if (!readOnly) {
      const rememberUserScroll = () => { entry.userScrollRevision += 1; };
      host.addEventListener('wheel', event => {
        const deltaY = Number(event.deltaY) || 0;
        const activeBuffer = terminal.buffer.active;
        if (!deltaY || Number(activeBuffer.baseY || 0) <= 0) return;
        const lineDelta = event.deltaMode === 1
          ? deltaY
          : event.deltaMode === 2
            ? deltaY * Math.max(1, terminal.rows - 1)
            : deltaY / Math.max(16, (state.terminalFontSize || 15) * 1.25);
        entry.wheelLineRemainder += lineDelta;
        const lines = Math.trunc(entry.wheelLineRemainder);
        event.preventDefault();
        event.stopPropagation();
        if (!lines) return;
        entry.wheelLineRemainder -= lines;
        terminal.scrollLines(lines);
        rememberUserScroll();
      }, { capture: true, passive: false });
      host.addEventListener('pointerup', rememberUserScroll, true);
      host.addEventListener('keyup', event => {
        if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) rememberUserScroll();
      }, true);
      if (!inputDisabled) {
        terminal.onData(data => {
          if (state.selectedId !== key && state.embeddedTerminalId !== key) return;
          enqueueRawInput(entry, key, data);
        });
      }
      terminal.onResize(size => {
        entry.pendingResize = { cols: size.cols, rows: size.rows };
        if (entry.resizePromise) return;
        entry.resizePromise = (async () => {
          while (entry.pendingResize) {
            const pending = entry.pendingResize;
            entry.pendingResize = null;
            await window.loadtoagent.terminalResize(key, pending.cols, pending.rows);
          }
        })().catch(error => {
          window.LoadToAgentRendererUtils.reportRecoverableError('terminal-resize', error);
        }).finally(() => { entry.resizePromise = null; });
      });
    }
    return entry;
  }

  function fitEntry(entry, _sessionId = '') {
    if (!entry || entry.host.classList.contains('hidden')) return;
    requestAnimationFrame(() => {
      try {
        if (entry.fixedGrid) {
          entry.host.dataset.fixedGrid = 'true';
          entry.terminal.resize(entry.fixedGrid.cols, entry.fixedGrid.rows);
        } else entry.fit.fit();
      } catch (error) {
        window.LoadToAgentRendererUtils.reportRecoverableError('terminal-fit', error);
      }
    });
  }

  async function writeTerminalReplay(terminal, replay) {
    const text = String(replay || '');
    const chunkChars = 32 * 1024;
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + chunkChars);
      const lastCode = text.charCodeAt(end - 1);
      const nextCode = text.charCodeAt(end);
      if (end < text.length && lastCode >= 0xd800 && lastCode <= 0xdbff
        && nextCode >= 0xdc00 && nextCode <= 0xdfff) end -= 1;
      const chunk = text.slice(offset, end);
      await new Promise(resolve => terminal.write(chunk, resolve));
      offset = end;
    }
  }

  async function ensureSessionTerminal(session) {
    let entry = state.terminals.get(session.id);
    const inputDisabled = false;
    if (entry && entry.inputDisabled !== inputDisabled) {
      closeRawInputEntry(entry);
      entry.terminal.dispose();
      entry.host.remove();
      state.terminals.delete(session.id);
      entry = null;
    }
    if (!entry) {
      entry = createXtermHost(session.id, false, session);
      state.terminals.set(session.id, entry);
      entry.ready = (async () => {
        const detail = await window.loadtoagent.terminalGet(session.id);
        const sequenceValue = detail?.outputSequence;
        const parsedSequence = sequenceValue == null || sequenceValue === '' ? Number.NaN : Number(sequenceValue);
        entry.outputSequence = Number.isSafeInteger(parsedSequence) && parsedSequence >= 0
          ? parsedSequence
          : null;
        // A retained full-screen TUI replay can be multiple MiB of ANSI redraw
        // traffic. Parse it in bounded xterm writes so opening an old task does
        // not monopolize the renderer and delay fresh AI output.
        if (detail && detail.replay) await writeTerminalReplay(entry.terminal, detail.replay);
        const buffered = entry.outputHydrationBuffer.splice(0).sort((left, right) => (
          left.outputSequence != null && right.outputSequence != null
            ? left.outputSequence - right.outputSequence || left.arrival - right.arrival
            : left.arrival - right.arrival
        ));
        entry.outputHydrating = false;
        for (const payload of buffered) {
          const data = entry.acceptOutput(payload);
          if (data) entry.terminal.write(data);
        }
        return entry;
      })().catch(error => {
        // Every caller awaiting this entry must observe the same initialization
        // failure. Remove it only when it is still the entry registered for the
        // session, so no caller can mistake an unverified blank xterm for a PTY.
        if (state.terminals.get(session.id) === entry) state.terminals.delete(session.id);
        closeRawInputEntry(entry);
        entry.terminal.dispose();
        entry.host.remove();
        throw error;
      });
    }
    return entry.ready ? await entry.ready : entry;
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

  function linkedAgentSession(session) {
    if (!session) return null;
    if (state.boundTargetId === session.id && state.boundAgent) return state.boundAgent;
    const agents = Array.isArray(state.snapshot?.sessions) ? state.snapshot.sessions : [];
    const bridgeId = String(session.bridgeId || '');
    const bridged = bridgeId ? agents.find(item => item.id === bridgeId) : null;
    if (bridged) return bridged;
    const terminalPid = Number(session.pid || 0);
    return agents.find(agent => (Array.isArray(agent.runtimePresence) ? agent.runtimePresence : []).some(item => (
      item.terminalId === session.id
      || (terminalPid > 0 && Number(item.pid || 0) === terminalPid)
      || (terminalPid > 0 && Number(item.parentPid || 0) === terminalPid)
    ))) || null;
  }

  function isAiTerminalSession(session) {
    return Boolean(session && (session.type === 'agent' || linkedAgentSession(session)));
  }

  function hasRunningQuestionTarget(session = currentSession(), remote = currentTmux()) {
    if (session) return session.status === 'running' && isAiTerminalSession(session);
    return Boolean(remote && !remote.pane.dead && visibleBoundAgent());
  }

  function terminalPresentation(session) {
    const agent = session?.type === 'agent' ? session : linkedAgentSession(session);
    if (agent?.attention?.category === 'required' || agent?.status === 'waiting') return { tone: 'attention', label: t('ui.waiting_for_review') };
    if (session?.status === 'failed') return { tone: 'failed', label: t('terminal.status.failed') };
    if (agent?.attention?.category === 'risk') return { tone: 'attention', label: t('ui.needs_attention') };
    if (agent?.status === 'failed') return { tone: 'attention', label: t('ui.needs_attention') };
    if (agent?.attention?.category === 'optional') return { tone: 'idle', label: t('management.attention.optional') };
    if (agent?.status === 'completed') return { tone: 'completed', label: t('ui.completed') };
    if (agent && ['running', 'starting'].includes(agent.status)) {
      return {
        tone: 'running',
        label: t(
          session?.type === 'agent' ? 'terminal.status.ai_dialog_running' : 'terminal.status.running_with_ai',
          { provider: providerLabel(agent.provider || session?.provider) },
        ),
      };
    }
    if (session?.type === 'agent' && ['running', 'starting'].includes(session.status)) {
      return {
        tone: 'running',
        label: t('terminal.status.ai_dialog_running', { provider: providerLabel(session.provider) }),
      };
    }
    if (session?.status === 'running' || session?.status === 'starting') return { tone: 'running', label: STATUS_LABELS[session.status] || session.status };
    return { tone: session?.status || 'idle', label: STATUS_LABELS[session?.status] || session?.status || t('ui.idle') };
  }

  function visibleFolder(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const saved = (state.workspaces || []).find(item => String(item.path || '').toLowerCase() === raw.toLowerCase());
    if (saved?.name) return saved.name;
    const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || raw;
  }

  function displayTerminalTitle(session) {
    const general = modeSessions('general');
    const sameTitle = general.filter(candidate => candidate.title === session.title);
    const position = sameTitle.findIndex(candidate => candidate.id === session.id) + 1;
    if (session.type === 'powershell' && /^(내 PC|내 컴퓨터|이 PC).*(작업 창|작업창|명령 창|명령창|실행하는 작업|실행 중인 작업)/.test(session.title || '')) {
      return sameTitle.length > 1 ? `실행 중인 작업 ${position}` : `실행 중인 작업`;
    }
    if (session.type === 'agent') return `${providerLabel(session.provider || linkedAgentSession(session)?.provider)} 대화`;
    return sameTitle.length > 1 ? `${session.title} ${position}` : session.title;
  }

  function executionComputerName(session) {
    const linuxName = session?.distro || session?.environment?.distro;
    if (linuxName) return `다른 Linux 컴퓨터 (${linuxName})`;
    const localName = state.platform.computerName || state.platform.label || '';
    return localName ? `내 Windows 컴퓨터 (${localName})` : '내 Windows 컴퓨터';
  }

  function renderSessions() {
    const general = modeSessions('general');
    const running = general.filter(item => ['running', 'starting'].includes(item.status)).length;
    const background = general.filter(item => item.background && item.status === 'running').length;
    const visibleRunning = Math.max(0, running - background);
    const failed = general.filter(item => item.status === 'failed').length;
    const ended = Math.max(0, general.length - running - failed);
    const conversations = general.filter(item => item.type === 'agent').length;
    const workWindows = general.filter(item => item.type !== 'agent' && ['running', 'starting'].includes(item.status)).length;
    const attention = general.filter(item => terminalPresentation(item).tone === 'attention').length;
    const navTerminalCount = $('#navTerminalCount');
    if (navTerminalCount) navTerminalCount.textContent = t('terminal.nav_usable', { count: running });
    const terminalNav = document.querySelector('.nav-item[data-view="terminal"]');
    if (terminalNav) terminalNav.setAttribute('aria-label', t('quality.nav_count_detailed', { label: t('app.nav.session_terminal'), count: running, unit: t('quality.unit.sessions') }));
    const advancedCount = 2;
    const advancedCounter = document.getElementById('advancedToolsCount');
    if (advancedCounter) advancedCounter.textContent = String(advancedCount);
    const advancedBaseLabel = t('quality.nav_count_detailed', {
      label: t('management.advanced_tools'), count: advancedCount, unit: t('quality.unit.types'),
    });
    const advancedSummary = document.querySelector('#advancedToolsNav > summary');
    advancedSummary?.setAttribute('aria-label', advancedBaseLabel);
    advancedSummary?.setAttribute('title', advancedBaseLabel);
    $('#terminalSessionSummary').textContent = t('terminal.summary.overall', {
      total: general.length,
      open: running,
      visible: visibleRunning,
      background,
      ended,
      failed,
      conversations,
      workWindows,
    });
    const selectedSession = general.find(session => session.id === state.selectedId);
    const inferredQuestionMode = selectedSession?.type === 'agent' || Boolean(linkedAgentSession(selectedSession));
    const questionMode = state.interactionMode === 'question'
      || (state.interactionMode === 'auto' && inferredQuestionMode);
    const questionTargetReady = hasRunningQuestionTarget(currentSession(), currentTmux());
    const selectedProvider = providerLabel(linkedAgentSession(selectedSession)?.provider || selectedSession?.provider || 'claude');
    $('#terminalModeComputerBtn')?.setAttribute('aria-pressed', questionMode ? 'false' : 'true');
    $('#terminalModeQuestionBtn')?.setAttribute('aria-pressed', questionMode ? 'true' : 'false');
    $('#terminalModeComputerBtn')?.setAttribute('aria-checked', questionMode ? 'false' : 'true');
    $('#terminalModeQuestionBtn')?.setAttribute('aria-checked', questionMode ? 'true' : 'false');
    if ($('#terminalModeTitle')) {
      $('#terminalModeTitle').textContent = questionMode
        ? questionTargetReady
          ? `${selectedProvider}에게 질문 보내기`
          : t('terminal.agent.select_target')
        : "컴퓨터 작업 요청하기";
    }
    if (document.body?.dataset?.currentView === 'terminal' && $('#pageTitle')) {
      $('#pageTitle').textContent = questionMode
        ? `${selectedProvider} 대화`
        : "컴퓨터 작업";
    }
    if ($('#terminalModeInstruction')) {
      $('#terminalModeInstruction').textContent = questionMode
        ? questionTargetReady
          ? "현재 ‘질문만 하기’가 선택되어 있습니다. 아래 입력칸에 질문을 적으세요."
          : t('terminal.agent.no_input_target')
        : "현재 ‘컴퓨터 작업 요청하기’가 선택되어 있습니다. 아래 입력칸에 할 일을 적고 ‘보내기’를 누르세요.";
    }
    const renderKey = JSON.stringify([
      state.selectedId,
      general.map(session => {
        const presentation = terminalPresentation(session);
        return [
          session.id, session.title, session.type, session.status, session.pid, session.cwd, session.background,
          session.recoveredAfterHostRestart, session.recoverySkippedReason, presentation.tone, presentation.label,
        ];
      }),
    ]);
    if (renderKey === state.sessionRenderKey) return;
    state.sessionRenderKey = renderKey;
    const rowHtml = (session) => {
      const index = general.findIndex((item) => item.id === session.id);
      const presentation = terminalPresentation(session);
      const sessionNote = session.background ? t('terminal.background_kept', {
        provider: providerLabel(session.provider || linkedAgentSession(session)?.provider),
        folder: visibleFolder(session.cwd) || '이름 없는 폴더',
      }) : '';
      return `
      <div class="terminal-session-row">
        <button type="button" draggable="true"
          class="terminal-session-item ${state.selectedId === session.id ? 'active' : ''}"
          data-status="${esc(presentation.tone)}"
          data-terminal-id="${esc(session.id)}"
          role="option"
          aria-selected="${state.selectedId === session.id ? 'true' : 'false'}"
          tabindex="${state.selectedId === session.id || (!state.selectedId && index === 0) ? '0' : '-1'}"
          aria-pressed="${state.selectedId === session.id ? 'true' : 'false'}"
          aria-grabbed="false"
          aria-describedby="terminalReorderHelp"
          title="${esc(session.cwd || window.LoadToAgentI18n.t('terminal.reorder_hint'))}">
          <span class="terminal-session-drag-handle" aria-hidden="true"></span>
          <span class="terminal-session-icon">${esc(terminalTypeMark(session))}</span>
          <span><b>${esc(displayTerminalTitle(session))}</b><small>${esc(sessionNote)}${session.recoveredAfterHostRestart ? `${sessionNote ? " · " : ""}${t('terminal.recovered_after_host_restart')}` : ''}</small><em>${esc(visibleFolder(session.cwd) || session.distro || t('session.program_pid', { pid: session.pid || '--' }))}</em><span class="sr-only">${index + 1}/${general.length}</span></span>
          <span class="terminal-session-status" data-status="${esc(presentation.tone)}"><i></i>${esc(presentation.label)}</span>
        </button>
        ${session.status === 'failed' ? `<span class="terminal-session-failed-actions"><button type="button" data-terminal-failure-cause="${esc(session.id)}">${esc(t('terminal.failure.cause'))}</button><button type="button" data-terminal-restart-inline="${esc(session.id)}">${esc(t('terminal.failure.reopen', { computer: executionComputerName(session), title: displayTerminalTitle(session) }))}</button></span>` : ''}
      </div>`;
    };
    const currentSessions = general.filter((session) => (
      ['running', 'starting'].includes(session.status) && session.type !== 'agent'
    ));
    const conversationSessions = general.filter((session) => session.type === 'agent');
    const pastSessions = general.filter((session) => !currentSessions.includes(session) && !conversationSessions.includes(session));
    const selectedPastSession = pastSessions.some((session) => session.id === state.selectedId);
    $('#terminalSessionList').innerHTML = general.length
      ? `<section class="terminal-session-group"><h3>진행 중 작업 ${currentSessions.length}개</h3>${currentSessions.map(rowHtml).join('')}</section>
        ${conversationSessions.length ? `<section class="terminal-session-group"><h3>AI 대화 ${conversationSessions.length}개</h3>${conversationSessions.map(rowHtml).join('')}</section>` : ''}
        ${pastSessions.length ? `<details class="terminal-past-sessions" ${selectedPastSession ? 'open' : ''}>
          <summary>완료·실패한 항목 ${pastSessions.length}개 보기 <i aria-hidden="true">⌄</i></summary>
          <div>${pastSessions.map(rowHtml).join('')}</div>
        </details>` : ''}`
      : `<div class="terminal-resource-empty">${t('terminal.empty.general')}</div>`;
  }

  function renderTmuxResources() {
    const distros = state.snapshot && state.snapshot.tmux && state.snapshot.tmux.distros || [];
    if (!distros.length) {
      $('#terminalTmuxList').innerHTML = `<div class="terminal-resource-empty">${t('terminal.empty.tmux')}</div>`;
      return;
    }
    let paneIndex = 0;
    $('#terminalTmuxList').innerHTML = distros.map(distro => `
      <section class="terminal-tmux-group">
        <header><b>${esc(distro.displayName || distro.name)}</b><span>${t('terminal.tmux.workspace_count', { count: (distro.sessions || []).length })}</span></header>
        ${(distro.sessions || []).map(session => `
          <div class="terminal-tmux-session"><strong>${esc(session.displayName || session.name)}</strong><small>${session.attached ? t('terminal.tmux.attached') : t('terminal.tmux.running_background')}</small></div>
          ${(session.windows || []).flatMap(windowItem => (windowItem.panes || [])
            .filter(pane => !state.suppressedTmuxTargets.has(tmuxTargetKey(distro.name, pane.nativeId)))
            .map(pane => `
            <button type="button" role="option" class="terminal-tmux-pane ${state.selectedTmux && state.selectedTmux.distro.name === distro.name && state.selectedTmux.pane.nativeId === pane.nativeId ? 'active' : ''}" data-tmux-distro="${esc(distro.name)}" data-tmux-pane="${esc(pane.nativeId)}" aria-selected="${state.selectedTmux && state.selectedTmux.distro.name === distro.name && state.selectedTmux.pane.nativeId === pane.nativeId ? 'true' : 'false'}" aria-pressed="${state.selectedTmux && state.selectedTmux.distro.name === distro.name && state.selectedTmux.pane.nativeId === pane.nativeId ? 'true' : 'false'}" tabindex="${state.selectedTmux && state.selectedTmux.distro.name === distro.name && state.selectedTmux.pane.nativeId === pane.nativeId || (!state.selectedTmux && paneIndex === 0) ? '0' : '-1'}" data-pane-index="${paneIndex++}">
              <span><b>${esc(pane.nativeId)} · ${esc(windowItem.index)}:${esc(windowItem.name)}</b><small>${esc(pane.command || 'shell')} · ${esc(pane.cwd || t('terminal.path_unreported'))}</small></span>
              <i class="${pane.agent ? 'agent' : (pane.active ? 'live' : '')}">${pane.agent ? 'AI' : (pane.active ? 'ON' : '')}</i>
            </button>`)).join('')}`).join('')}
      </section>`).join('');
  }

  function renderTarget() {
    const session = currentSession();
    const remote = currentTmux();
    const bound = visibleBoundAgent() || linkedAgentSession(session);
    const boundProvider = bound ? providerLabel(bound.provider || session?.provider) : '';
    const aiTerminal = isAiTerminalSession(session);
    const managedSession = Boolean(session && session.backend === 'managed-tmux');
    const reconnectable = managedSession && session.status === 'detached';
    const hasTarget = Boolean(session || remote);
    const questionBlocked = state.interactionMode === 'question' && !hasRunningQuestionTarget(session, remote);
    const canInput = Boolean((remote && !remote.pane.dead) || (session && session.status === 'running'))
      && !questionBlocked;
    const closeButton = $('#terminalCloseBtn');
    closeButton.disabled = !hasTarget;
    closeButton.textContent = remote && !session
      ? t('terminal.clear_selection')
      : session?.type === 'tmux'
        ? t('terminal.detach_tmux_input')
        : aiTerminal ? t('terminal.close_view') : t('ui.end_session');
    closeButton.classList.toggle('terminal-danger-button', Boolean(session && !aiTerminal && session.type !== 'tmux'));
    const endSessionButton = $('#terminalEndSessionBtn');
    endSessionButton.classList.toggle('hidden', !aiTerminal);
    endSessionButton.disabled = !aiTerminal;
    endSessionButton.textContent = managedSession && session.status === 'stopped'
      ? t('terminal.remove_session_record')
      : t('terminal.end_ai_session');
    const restartButton = $('#terminalRestartBtn');
    const showRestart = Boolean(session && (reconnectable || (session.type !== 'agent' && session.status !== 'running')));
    restartButton.classList.toggle('hidden', !showRestart);
    restartButton.disabled = !showRestart;
    restartButton.textContent = reconnectable ? t('terminal.reconnect') : t('terminal.restart');
    if (showRestart) document.querySelector('.terminal-session-tools')?.setAttribute('open', '');
    const terminalCommandInput = $('#terminalCommandInput');
    terminalCommandInput.disabled = !canInput;
    const commandForm = $('#terminalCommandForm');
    const commandButton = commandForm.querySelector('button[type="submit"]');
    commandButton.disabled = !canInput || state.commandSending || !terminalCommandInput.value.trim();
    commandButton.toggleAttribute('aria-busy', state.commandSending);
    commandForm.toggleAttribute('aria-busy', state.commandSending);
    const commandButtonLabel = commandButton.querySelector('span');
    if (commandButtonLabel) commandButtonLabel.textContent = state.commandSending ? t('terminal.sending') : t('common.send');
    document.querySelectorAll('[data-terminal-signal]').forEach(button => { button.disabled = !canInput; });
    const computerInputButton = $('#terminalComputerInputBtn');
    const showComputerInput = Boolean(canInput && session && !aiTerminal);
    computerInputButton?.classList.toggle('hidden', !showComputerInput);
    if (computerInputButton) computerInputButton.disabled = !showComputerInput;
    $('#terminalAttachBtn').classList.toggle('hidden', !remote || Boolean(session));
    $('#terminalTmuxTools').classList.toggle('hidden', !remote || Boolean(session));
    if (session) {
      const presentation = terminalPresentation(session);
      setConnectionState(presentation.label, presentation.tone);
      $('#terminalTargetIcon').textContent = terminalTypeMark(session);
      const title = displayTerminalTitle(session);
      const targetTitle = String(bound?.title || title).trim();
      $('#terminalTargetMeta').innerHTML = `<b>${esc(targetTitle)}</b><span class="terminal-target-facts">
        ${bound ? `<i>${esc(t('terminal.meta.connected_ai'))}: ${esc(boundProvider)}</i>` : ''}
        <i>${esc(t('terminal.meta.location'))}: ${esc(executionComputerName(session))}</i>
        <i>${esc(t('terminal.meta.folder'))}: ${esc(visibleFolder(session.cwd) || t('terminal.path_unreported'))} 폴더</i>
      </span>`;
      const sessionSettingsLabel = document.querySelector('.terminal-session-tools summary span');
      if (sessionSettingsLabel) sessionSettingsLabel.textContent = t('terminal.session_controls_current', {
        folder: visibleFolder(session.cwd) || t('terminal.path_unreported'),
      });
      $('#terminalConsoleCaption').textContent = session.type === 'powershell'
        ? t('terminal.console.output_caption')
        : `${terminalTypeLabel(session)} · ${t('session.program_pid', { pid: session.pid || '--' })}`;
      $('#terminalConsoleState').textContent = session.status === 'detached'
        ? t('terminal.detached_work_continues')
        : session.status === 'stopped'
          ? t('terminal.stopped_record_kept')
          : presentation.tone === 'attention' || presentation.tone === 'completed'
        ? presentation.label
        : canInput
          ? bound
            ? t('terminal.console.bound_input_available', { provider: boundProvider })
            : t('terminal.console.direct_input_available')
          : window.LoadToAgentI18n.t("ui.ended_session");
      $('#terminalConsoleState').dataset.status = presentation.tone;
      const viewportHelp = document.querySelector('.terminal-viewport-help');
      if (viewportHelp) viewportHelp.textContent = bound
        ? `지금 할 수 있는 일: 이 작업 결과를 보면서 ${boundProvider}에게 질문하기. 질문은 파일이나 프로그램을 바꾸지 않습니다.`
        : `현재 선택한 ${executionComputerName(session)}의 컴퓨터 작업입니다. 아래 입력칸의 내용을 컴퓨터에서 실행합니다.`;
    } else if (remote) {
      setConnectionState(remote.pane.dead ? t('terminal.tmux.ended_pane') : t('terminal.tmux.connected'), remote.pane.dead ? 'exited' : 'running');
      $('#terminalTargetIcon').textContent = 'tm';
      $('#terminalTargetMeta').innerHTML = `<b>${esc(remote.distro.name)} · ${esc(remote.session.name)} · ${esc(remote.pane.nativeId)}</b><span>${esc(remote.window.index)}:${esc(remote.window.name)} · ${esc(remote.pane.command || 'shell')} · ${esc(remote.pane.cwd || '')}</span>`;
      $('#terminalConsoleCaption').textContent = `${remote.window.index}:${remote.window.name} · ${remote.pane.command || 'shell'}`;
      $('#terminalConsoleState').textContent = remote.pane.dead ? window.LoadToAgentI18n.t("ui.ended_pane") : window.LoadToAgentI18n.t("ui.ready_for_commands");
      $('#terminalConsoleState').dataset.status = remote.pane.dead ? 'exited' : 'running';
      const viewportHelp = document.querySelector('.terminal-viewport-help');
      if (viewportHelp) viewportHelp.textContent = `현재 선택한 ${remote.distro.name}의 컴퓨터 작업입니다. 실행한 결과를 보고 아래 입력칸에 컴퓨터에서 실행할 내용을 입력하세요.`;
    } else {
      setConnectionState(window.LoadToAgentI18n.t("ui.waiting_for_selection"));
      $('#terminalTargetIcon').textContent = '›_';
      $('#terminalTargetMeta').innerHTML = state.mode === 'tmux'
        ? `<b>${t('terminal.tmux.no_selection_title')}</b><span>${t('terminal.tmux.no_selection_description')}</span>`
        : `<b>${window.LoadToAgentI18n.t("ui.select_a_session")}</b><span>${window.LoadToAgentI18n.t("ui.choose_a_session_on_the_left_or_create_a_new")}</span>`;
      $('#terminalConsoleCaption').textContent = window.LoadToAgentI18n.t("ui.select_a_session_to_show_its_output_here");
      $('#terminalConsoleState').textContent = window.LoadToAgentI18n.t("ui.waiting_for_selection");
      $('#terminalConsoleState').dataset.status = '';
      const viewportHelp = document.querySelector('.terminal-viewport-help');
      if (viewportHelp) viewportHelp.textContent = '컴퓨터 작업 결과가 이곳에 표시됩니다. 결과를 보며 아래에서 AI에게 질문할 수 있습니다.';
    }
    const commandLabel = $('#terminalCommandLabel');
    const commandInput = $('#terminalCommandInput');
    if (commandLabel) commandLabel.textContent = questionBlocked
      ? t('terminal.agent.select_target')
      : bound
      ? `현재 ‘${String(bound.title || displayTerminalTitle(session)).trim()}’ 작업에 대해 ${boundProvider || providerLabel(bound.provider)}에게 질문`
      : (remote ? window.LoadToAgentI18n.t("ui.send_to_tmux_terminal") : window.LoadToAgentI18n.t("ui.send_command_to_terminal"));
    if (commandInput) commandInput.placeholder = questionBlocked
      ? t('terminal.agent.no_input_target')
      : !hasTarget
      ? window.LoadToAgentI18n.t("ui.select_a_session_on_the_left_first")
      : (bound ? t('terminal.command.continue_ai_placeholder', { provider: boundProvider || providerLabel(bound.provider) }) : t('ui.enter_a_command_to_run'));
    if (commandInput) {
      $('#terminalCommandCount').textContent = t('terminal.composer.count', { count: commandInput.value.length.toLocaleString() });
      $('#terminalCommandClearBtn')?.classList.toggle('hidden', !commandInput.value);
    }
    const terminalNotice = $('#terminalNotice');
    const terminalNoticeText = terminalNotice?.querySelector('span:last-child');
    if (bound && terminalNoticeText && !terminalNotice.dataset.tone) {
      terminalNoticeText.textContent = t('terminal.current_connected_ai', { provider: boundProvider || providerLabel(bound.provider) });
    }
    if (terminalNotice) terminalNotice.classList.toggle('hidden', Boolean(bound) && !terminalNotice.dataset.tone);
    const answerDestination = $('#terminalAnswerDestination');
    if (answerDestination) answerDestination.textContent = questionBlocked
      ? t('terminal.agent.no_input_target')
      : bound
      ? `보낸 질문과 ${boundProvider || providerLabel(bound.provider)}의 답변이 이곳에 차례대로 표시됩니다.`
      : "실행 결과는 이 입력칸 위에 표시됩니다.";
    syncComposer?.();
    const submitButton = $('#terminalCommandForm')?.querySelector('.terminal-command-submit');
    const submitButtonLabel = submitButton?.querySelector('span');
    if (bound && submitButton && submitButtonLabel) {
      const recipient = boundProvider || providerLabel(bound.provider);
      submitButton.setAttribute('aria-label', `${recipient}에게 보내기`);
      submitButtonLabel.textContent = `${recipient}에게 보내기`;
    }
    renderHistoryPanel();
  }

  async function showSelection() {
    const generation = state.captureGeneration;
    const expectedMode = state.mode;
    const expectedSessionId = state.selectedId;
    const expectedTmuxId = state.selectedTmux?.pane?.id || state.selectedTmux?.pane?.nativeId || '';
    const selectionIsCurrent = () => generation === state.captureGeneration
      && expectedMode === state.mode
      && expectedSessionId === state.selectedId
      && expectedTmuxId === (state.selectedTmux?.pane?.id || state.selectedTmux?.pane?.nativeId || '');
    const session = currentSession();
    const remote = currentTmux();
    const visibleEntry = session
      ? state.terminals.get(session.id)
      : remote ? state.remoteTerminal : null;
    // State snapshots for the currently selected PTY are frequent. Hiding the
    // already-mounted xterm before awaiting its resolved ready promise causes a
    // visible flash and can interrupt focus/IME. Keep only that exact selection
    // visible; genuine selection changes still hide the previous screen while
    // the new one is prepared.
    const keepVisible = Boolean(visibleEntry && !visibleEntry.host.classList.contains('hidden'));
    if (!keepVisible) hideScreens();
    if (session) {
      const entry = await ensureSessionTerminal(session);
      if (!selectionIsCurrent()) return;
      for (const [id, other] of state.terminals) {
        if (id !== session.id) other.host.classList.add('hidden');
      }
      if (state.remoteTerminal) state.remoteTerminal.host.classList.add('hidden');
      $('#terminalEmpty').classList.add('hidden');
      entry.host.classList.remove('hidden');
      if (!keepVisible || entry !== visibleEntry) fitEntry(entry, session.id);
      stopCapture();
    } else if (remote) {
      if (!selectionIsCurrent()) return;
      const entry = ensureRemoteTerminal();
      for (const other of state.terminals.values()) other.host.classList.add('hidden');
      $('#terminalEmpty').classList.add('hidden');
      entry.host.classList.remove('hidden');
      if (!keepVisible || entry !== visibleEntry) fitEntry(entry);
      startCapture();
    } else {
      if (!selectionIsCurrent()) return;
      hideScreens();
      $('#terminalEmpty').classList.remove('hidden');
      stopCapture();
    }
    renderTarget();
  }

  async function selectSession(id, interactionMode = '') {
    saveCurrentDraft();
    const generation = ++state.captureGeneration;
    state.selectedId = id;
    const selectedSession = state.sessions.find(item => item.id === id);
    state.interactionMode = interactionMode || (isAiTerminalSession(selectedSession) ? 'question' : 'computer');
    state.selectedTmux = null;
    renderSessions();
    renderTmuxResources();
    await showSelection();
    if (!state.active || state.captureGeneration !== generation || state.selectedId !== id || state.mode !== 'general') return;
    restoreCurrentDraft();
    if (!$('#terminalCommandInput')?.disabled) $('#terminalCommandInput').focus({ preventScroll: true });
  }

  async function selectTmux(distroName, paneId, interactionMode = '') {
    const row = tmuxRows().find(item => item.distro.name === distroName && item.pane.nativeId === paneId);
    if (!row) return notice(t('terminal.error.selected_split_missing'), 'error');
    saveCurrentDraft();
    const generation = ++state.captureGeneration;
    if (interactionMode) state.interactionMode = interactionMode;
    state.selectedId = null;
    state.selectedTmux = row;
    state.remoteCapture = '';
    state.remoteViewportAnchor = null;
    state.remoteViewportAtBottom = false;
    if (state.remoteTerminal) state.remoteTerminal.terminal.clear();
    renderSessions();
    renderTmuxResources();
    await showSelection();
    if (!state.active || state.captureGeneration !== generation || state.selectedId || state.mode !== 'tmux'
      || state.selectedTmux?.distro?.name !== distroName || state.selectedTmux?.pane?.nativeId !== paneId) return;
    restoreCurrentDraft();
    if (!$('#terminalCommandInput')?.disabled) $('#terminalCommandInput').focus({ preventScroll: true });
  }

  async function selectTmuxById(paneId) {
    const row = tmuxRows().find(item => item.pane.id === paneId || item.pane.nativeId === paneId);
    if (!row) return notice(t('terminal.error.selected_tmux_missing'), 'error');
    state.mode = 'tmux';
    moveWorkbench('tmux');
    return selectTmux(row.distro.name, row.pane.nativeId, 'computer');
  }

  function renderAll() {
    renderSessions();
    renderTmuxResources();
    renderTarget();
  }

  async function refreshSessions(payload = null) {
    if (!Number.isSafeInteger(state.terminalSessionRevision)) state.terminalSessionRevision = 0;
    if (!Number.isSafeInteger(state.terminalListRequestGeneration)) state.terminalListRequestGeneration = 0;
    const payloadSessions = payload && Array.isArray(payload.sessions) ? payload.sessions : null;
    const requestGeneration = payloadSessions ? 0 : ++state.terminalListRequestGeneration;
    const revision = state.terminalSessionRevision;
    const nextSessions = payloadSessions || await window.loadtoagent.terminalList();
    // IPC state events are authoritative. A list request started before one of
    // those events (or before a newer list request) must not restore stale rows.
    if (!payloadSessions && (revision !== state.terminalSessionRevision
      || requestGeneration !== state.terminalListRequestGeneration)) return false;
    state.sessions = Array.isArray(nextSessions) ? nextSessions : [];
    state.terminalSessionRevision += 1;
    const activeIds = new Set(state.sessions.map(session => session.id));
    for (const session of state.sessions) {
      const entry = state.terminals.get(session.id);
      if (!entry || !session.fixedGrid) continue;
      entry.fixedGrid = { cols: Number(session.cols) || 120, rows: Number(session.rows) || 32 };
      fitEntry(entry, session.id);
    }
    const rehydratedIds = new Set(payload?.change === 'reconnected' ? activeIds : []);
    const reconnectEntries = payload?.change === 'reconnected'
      ? [...state.terminals].filter(([id]) => activeIds.has(id))
      : [];
    if (typeof CustomEvent === 'function') {
      for (const [id, entry] of reconnectEntries) {
        window.dispatchEvent(new CustomEvent('loadtoagent:terminal-reconnect-owner', {
          detail: {
            terminalId: id,
            mountId: String(entry.host.parentElement?.id || ''),
          },
        }));
      }
    }
    const reconnectFocus = reconnectEntries
      .find(([, entry]) => entry.host.contains(document.activeElement)) || null;
    const reconnectFocusId = String(reconnectFocus?.[0] || '');
    const reconnectFocusOrigin = reconnectFocus?.[1]?.host?.contains(document.activeElement)
      ? document.activeElement
      : null;
    if (reconnectFocusId && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('loadtoagent:terminal-reconnect-focus', {
        detail: { terminalId: reconnectFocusId },
      }));
    }
    for (const [id, entry] of state.terminals) {
      if (activeIds.has(id) && !rehydratedIds.has(id)) continue;
      closeRawInputEntry(entry);
      entry.terminal.dispose();
      entry.host.remove();
      state.terminals.delete(id);
      if (!rehydratedIds.has(id)) state.commandDrafts.delete(id);
    }
    if (state.selectedId && !state.sessions.some(item => item.id === state.selectedId)) state.selectedId = null;
    renderAll();
    if (state.active) await showSelection();
    if (reconnectFocusId && state.active && state.selectedId === reconnectFocusId) {
      const entry = state.terminals.get(reconnectFocusId);
      const active = document.activeElement;
      const focusStayedPassive = !active
        || active === document.body
        || active === document.documentElement
        || active === reconnectFocusOrigin
        || active.isConnected === false;
      const documentFocused = typeof document.hasFocus !== 'function' || document.hasFocus();
      const documentVisible = !document.visibilityState || document.visibilityState === 'visible';
      if (entry && focusStayedPassive && documentFocused && documentVisible) entry.terminal.focus();
    }
    return true;
  }

  async function createTerminal(type) {
    const distro = type === 'wsl' ? firstDistro() : null;
    if (type === 'wsl' && !distro) return notice(t('terminal.error.no_linux_environment'), 'error');
    const created = await guarded(() => window.loadtoagent.terminalCreate({
      type,
      cwd: (type === 'powershell' || type === 'shell') ? (preferredWorkspace() || undefined) : undefined,
      distro: distro && distro.name,
      title: type === 'powershell' ? t('terminal.windows_shell') : (type === 'shell' ? state.platform.localShellLabel : t('terminal.linux_shell_title', { distro: distro.name })),
      cols: 120,
      rows: 32,
    }), t('terminal.opened', { platform: type === 'powershell' ? '내 컴퓨터' : (type === 'shell' ? state.platform.label : 'Linux') }), `terminal-create:${type}`);
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
      state.remoteCaptureApplying = true;
      entry.terminal.reset();
      await new Promise(resolve => entry.terminal.write(result.output.replace(/\n/g, '\r\n'), resolve));
      const selected = currentTmux();
      if (!state.active || captureGeneration !== state.captureGeneration || !selected || `${selected.distro.name}:${selected.pane.nativeId}` !== captureKey) {
        entry.terminal.reset();
        state.remoteCapture = '';
        setTimeout(captureRemote, 0);
        return;
      }
      await new Promise(resolve => requestAnimationFrame(() => {
        try {
          const latest = currentTmux();
          if (captureGeneration !== state.captureGeneration || !latest || `${latest.distro.name}:${latest.pane.nativeId}` !== captureKey) return;
          if (firstCapture) entry.terminal.scrollToTop();
          else if (state.remoteViewportAnchor == null ? wasAtBottom : state.remoteViewportAtBottom) entry.terminal.scrollToBottom();
          else entry.terminal.scrollToLine(state.remoteViewportAnchor == null ? previousViewport : state.remoteViewportAnchor);
          const restoredBuffer = entry.terminal.buffer.active;
          state.remoteViewportAnchor = Number(restoredBuffer.viewportY) || 0;
          state.remoteViewportAtBottom = !firstCapture && state.remoteViewportAnchor >= Number(restoredBuffer.baseY || 0);
          state.captureRevision += 1;
          entry.host.dataset.captureRevision = String(state.captureRevision);
        } catch (error) {
          window.LoadToAgentRendererUtils.reportRecoverableError('tmux-capture-render', error);
        } finally {
          resolve();
        }
      }));
    } finally {
      state.remoteCaptureApplying = false;
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
    if (state.interactionMode === 'question' && !hasRunningQuestionTarget(session, remote)) {
      notice(t('terminal.agent.no_input_target'), 'error');
      return false;
    }
    const questionDelivery = state.interactionMode === 'question';
    const targetId = session?.id || (remote ? `tmux:${remote.distro.name}:${remote.pane.nativeId}` : '');
    const deliveryKey = questionDelivery ? `${targetId}\u0000${text}` : '';
    const deliveries = state.commandDeliveries instanceof Map
      ? state.commandDeliveries
      : (state.commandDeliveries = new Map());
    if (questionDelivery && deliveries.get(deliveryKey)?.state === 'unknown') {
      notice(t('terminal.agent.delivery_uncertain', {
        target: session?.title || remote?.pane?.nativeId || t('terminal.agent.ai_terminal'),
      }), 'warning');
      return false;
    }
    state.commandSending = true;
    renderTarget();
    try {
      if (!questionDelivery) {
        const result = session
          ? await guarded(() => window.loadtoagent.terminalCommand(session.id, text), t('terminal.command.sent'))
          : await guarded(() => window.loadtoagent.tmuxSendText({ distro: remote.distro.name, target: remote.pane.nativeId, text, enter: true }), t('terminal.command.executed_in_split'));
        if (result && remote) setTimeout(captureRemote, 160);
        return Boolean(result);
      }

      const deliveryId = `delivery:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
      const operation = () => session
        ? window.loadtoagent.terminalCommand(session.id, text, { deliveryId })
        : window.loadtoagent.tmuxSendText({
          distro: remote.distro.name,
          target: remote.pane.nativeId,
          text,
          enter: true,
          deliveryId,
        });
      let result = null;
      let transportError = null;
      try {
        result = await operation();
      } catch (error) {
        transportError = error;
      }
      // The terminal host ledger makes one same-ID retry safe: if the first
      // write succeeded but its response was lost, this returns the recorded
      // result without writing the question again. tmux stays single-attempt;
      // its durable ledger handles an explicit later retry instead.
      if (transportError && session && transportError.deliveryState !== 'rejected') {
        try {
          result = await operation();
          transportError = null;
        } catch (error) {
          transportError = error;
        }
      }
      const deliveryState = result?.deliveryState === 'rejected' || transportError?.deliveryState === 'rejected'
        ? 'rejected'
        : result?.deliveryState === 'accepted'
        ? 'accepted'
        : result?.deliveryState === 'unknown' || transportError || !result || result.ok === false
          ? 'unknown'
          : 'accepted';
      if (deliveryState === 'rejected') {
        deliveries.delete(deliveryKey);
        notice(t('agent.delivery_retry_ready'), 'warning');
        return false;
      }
      if (deliveryState === 'unknown') {
        deliveries.set(deliveryKey, { id: deliveryId, state: 'unknown' });
        while (deliveries.size > 64) deliveries.delete(deliveries.keys().next().value);
        notice(t('terminal.agent.delivery_uncertain', {
          target: session?.title || remote?.pane?.nativeId || t('terminal.agent.ai_terminal'),
        }), 'warning');
        return false;
      }
      deliveries.delete(deliveryKey);
      notice(session ? t('terminal.command.sent') : t('terminal.command.executed_in_split'), 'success');
      if (result && remote) setTimeout(captureRemote, 160);
      return true;
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
    if (!tmuxModalFocusToken) tmuxModalFocusToken = window.LoadToAgentA11y?.rememberDialogTrigger('tmuxCreateModal');
    const distros = state.snapshot && state.snapshot.tmux && state.snapshot.tmux.distros || [];
    $('#tmuxCreateDistro').innerHTML = distros.map(item => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join('');
    $('#tmuxCreateError').classList.add('hidden');
    window.LoadToAgentA11y?.setDialogOpenState($('#tmuxCreateModal'), true);
    $('#tmuxCreateModal').classList.remove('hidden');
    $('#tmuxCreateName').focus();
  }

  function closeTmuxModal(force = false) {
    if (force !== true && $('#tmuxCreateForm [type="submit"]').dataset.busy === 'true') return;
    $('#tmuxCreateModal').classList.add('hidden');
    window.LoadToAgentA11y?.setDialogOpenState($('#tmuxCreateModal'), false);
    $('#tmuxCreateForm').reset();
    $('#tmuxCreateForm').querySelectorAll('[aria-invalid="true"]').forEach(element => element.removeAttribute('aria-invalid'));
    const focusToken = tmuxModalFocusToken;
    tmuxModalFocusToken = null;
    if (focusToken) window.LoadToAgentA11y?.restoreDialogTrigger(focusToken);
  }

  async function refreshSnapshot() {
    const snapshot = await guarded(() => window.loadtoagent.snapshot(), t('terminal.tmux.refreshed'), 'tmux-refresh');
    if (snapshot) updateSnapshot(snapshot, state.workspaces);
  }

  async function attachTmux() {
    const remote = currentTmux();
    if (!remote) return;
    const agent = remote.pane?.agent || {};
    const agentPid = Number(agent.identityPid || agent.pid);
    const agentProcessGroupId = Number(agent.identityProcessGroupId || agent.processGroupId);
    const agentForegroundGroupId = Number(agent.identityTerminalForegroundGroupId
      || agent.terminalForegroundGroupId);
    const agentProvider = String(agent.provider || '').toLowerCase();
    const agentExternalId = String(agent.externalId || '').trim();
    const agentArgvHash = String(agent.identityArgvHash || agent.argvHash || '').toLowerCase();
    const agentStartTimeTicks = String(agent.identityStartTimeTicks || agent.startTimeTicks || '');
    const exactAgentIdentity = Number.isSafeInteger(agentPid) && agentPid > 0
      && Number.isSafeInteger(agentProcessGroupId) && agentProcessGroupId > 0
      && agentForegroundGroupId === agentProcessGroupId
      && ['claude', 'codex', 'gemini', 'grok'].includes(agentProvider)
      && agentExternalId && !/[\u0000-\u001f\u007f]/u.test(agentExternalId)
      && /^[a-f0-9]{64}$/u.test(agentArgvHash)
      && /^[1-9][0-9]{0,30}$/u.test(agentStartTimeTicks)
      ? {
          tmuxAgentPid: agentPid,
          tmuxAgentProvider: agentProvider,
          tmuxAgentExternalId: agentExternalId,
          tmuxAgentArgvHash: agentArgvHash,
          tmuxAgentStartTimeTicks: agentStartTimeTicks,
          tmuxAgentProcessGroupId: agentProcessGroupId,
        }
      : {};
    const created = await guarded(() => window.loadtoagent.terminalCreate({
      type: 'tmux',
      distro: remote.distro.name,
      tmuxSession: remote.session.name,
      tmuxSessionId: remote.session.nativeId,
      tmuxWindow: remote.window.nativeId,
      tmuxPane: remote.pane.nativeId,
      tmuxPanePid: remote.pane.pid,
      ...exactAgentIdentity,
      title: `${t('app.nav.tmux')} · ${remote.session.name} · ${remote.pane.nativeId}`,
      cols: 120,
      rows: 32,
    }), t('terminal.tmux.attached_for_input'), `tmux-attach:${remote.distro.name}:${remote.pane.nativeId}`);
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
      const name = window.prompt(t('terminal.tmux.prompt_window_name'), '새-창');
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
    const result = await guarded(operation, message, `tmux-manage:${action}`);
    if (result) {
      if (action.startsWith('kill-')) {
        const closedRows = tmuxRows().filter(row => {
          if (row.distro.name !== remote.distro.name) return false;
          if (action === 'kill-pane') return row.pane.nativeId === remote.pane.nativeId;
          if (action === 'kill-window') return row.window.nativeId === remote.window.nativeId;
          return row.session.nativeId === remote.session.nativeId;
        });
        for (const row of closedRows) {
          state.suppressedTmuxTargets.add(tmuxTargetKey(row.distro.name, row.pane.nativeId));
        }
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

  function focusComputerWorkInput() {
    const entry = currentSession() ? state.terminals.get(state.selectedId) : state.remoteTerminal;
    if (!entry || entry.readOnly) return false;
    entry.terminal.focus();
    entry.host.scrollIntoView({ block: 'nearest' });
    return true;
  }

  return { createXtermHost, fitEntry, ensureSessionTerminal, ensureRemoteTerminal, hideScreens, linkedAgentSession, isAiTerminalSession, renderSessions, renderTmuxResources, renderTarget, showSelection, selectSession, selectTmux, selectTmuxById, renderAll, refreshSessions, createTerminal, captureRemote, startCapture, stopCapture, sendCommand, sendSignal, openTmuxModal, closeTmuxModal, refreshSnapshot, attachTmux, manageTmux, focusComputerWorkInput };
};
