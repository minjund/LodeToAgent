'use strict';

/** Bind terminal DOM/preload events using dependencies owned by terminal.js. */
window.LoadToAgentTerminalEvents = function bindTerminalEvents(context) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $, state, createTerminal, openTmuxModal, refreshSnapshot, selectSession, selectTmux,
    sendCommand, currentTargetId, sendSignal, currentSession, guarded, renderAll, showSelection,
    refreshSessions, renderHistoryPanel, fitEntry, attachTmux, currentTmux, manageTmux,
    closeTmuxModal, errorMessage, notice, reorderSession, moveSessionByOffset,
    setTerminalFontSize, toggleTerminalFocusMode, focusComputerWorkInput,
    isAiTerminalSession,
    composer,
  } = context;

  const runBusy = async (button, action) => {
    if (!button || button.dataset.busy === 'true') return null;
    const wasDisabled = button.disabled;
    button.dataset.busy = 'true';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      return await action();
    } finally {
      if (button.isConnected) {
        delete button.dataset.busy;
        button.disabled = wasDisabled;
        button.removeAttribute('aria-busy');
      }
    }
  };

  const writeTerminalOutput = (entry, data) => {
    if (!entry || !data) return;
    const buffer = entry.terminal.buffer.active;
    if (entry.outputWritePending === 0) {
      entry.outputRestoreGeneration += 1;
      entry.outputViewportAnchor = Number(buffer.viewportY) || 0;
      entry.outputShouldFollow = entry.outputViewportAnchor >= Number(buffer.baseY || 0);
      entry.outputUserScrollRevision = entry.userScrollRevision;
    }
    entry.outputWritePending += 1;
    entry.terminal.write(data, () => {
      entry.outputWritePending = Math.max(0, entry.outputWritePending - 1);
      if (entry.outputWritePending > 0) return;
      const restoreGeneration = entry.outputRestoreGeneration;
      const restoreViewport = () => {
        if (
          entry.outputShouldFollow
          || entry.outputWritePending > 0
          || restoreGeneration !== entry.outputRestoreGeneration
          || entry.outputUserScrollRevision !== entry.userScrollRevision
        ) return;
        const latestBaseY = Number(entry.terminal.buffer.active.baseY) || 0;
        entry.terminal.scrollToLine(Math.min(entry.outputViewportAnchor, latestBaseY));
      };
      restoreViewport();
      requestAnimationFrame(() => requestAnimationFrame(restoreViewport));
    });
  };

  bindTerminalSessionEvents();
  bindTmuxEvents();
  bindTerminalWindowAndPreloadEvents();

  function bindTerminalSessionEvents() {
    composer?.bind();
    $('#newPowerShellBtn').addEventListener('click', event => runBusy(event.currentTarget, () => createTerminal(state.platform.localShell)));
    $('#newWslBtn').addEventListener('click', event => runBusy(event.currentTarget, () => createTerminal('wsl')));
    $('#newTmuxSessionBtn').addEventListener('click', openTmuxModal);
    $('#refreshTmuxTerminalBtn').addEventListener('click', event => runBusy(event.currentTarget, refreshSnapshot));
    $('#terminalModeComputerBtn')?.addEventListener('click', async () => {
      state.interactionMode = 'computer';
      const target = state.sessions.find(session => session.type !== 'agent' && session.type !== 'tmux'
        && ['running', 'starting'].includes(session.status));
      if (target) await selectSession(target.id, 'computer');
      else renderAll();
      $('#terminalModeComputerBtn')?.setAttribute('aria-pressed', 'true');
      $('#terminalModeQuestionBtn')?.setAttribute('aria-pressed', 'false');
      focusComputerWorkInput();
    });
    $('#terminalModeQuestionBtn')?.addEventListener('click', async () => {
      state.interactionMode = 'question';
      const selected = currentSession();
      const target = selected && isAiTerminalSession(selected) && ['running', 'starting'].includes(selected.status)
        ? selected
        : state.sessions.find(session => isAiTerminalSession(session)
        && ['running', 'starting'].includes(session.status));
      const remote = currentTmux();
      const boundTmuxTarget = Boolean(remote && !remote.pane.dead && state.boundAgent
        && state.boundTargetId === `tmux:${remote.distro.name}:${remote.pane.nativeId}`);
      if (target) await selectSession(target.id, 'question');
      else if (boundTmuxTarget) renderAll();
      else {
        renderAll();
        notice(t('terminal.agent.no_input_target'), 'warning');
      }
      $('#terminalModeComputerBtn')?.setAttribute('aria-pressed', 'false');
      $('#terminalModeQuestionBtn')?.setAttribute('aria-pressed', 'true');
      if (target || boundTmuxTarget) document.querySelector('#terminalWorkbench [data-agent-command-draft]')?.focus({ preventScroll: true });
      else $('#terminalModeQuestionBtn')?.focus({ preventScroll: true });
    });
    const sessionList = $('#terminalSessionList');
    const historyList = $('#terminalHistoryList');
    const cancelHistoryFollow = () => {
      state.historyUserRevision += 1;
      if (state.historyFollowFrame) cancelAnimationFrame(state.historyFollowFrame);
      state.historyFollowFrame = 0;
    };
    const flushPendingHistory = () => {
      if (!state.historyRenderPending || state.historyFlushFrame) return;
      state.historyFlushFrame = requestAnimationFrame(() => {
        state.historyFlushFrame = 0;
        if (!state.historyPointerActive) renderHistoryPanel();
      });
    };
    historyList.addEventListener('pointerdown', () => {
      state.historyPointerActive = true;
      cancelHistoryFollow();
    }, true);
    historyList.addEventListener('wheel', cancelHistoryFollow, { capture: true, passive: true });
    historyList.addEventListener('click', () => {
      cancelHistoryFollow();
      flushPendingHistory();
    }, true);
    const finishHistoryPointer = () => {
      state.historyPointerActive = false;
      flushPendingHistory();
    };
    window.addEventListener('pointerup', finishHistoryPointer, true);
    window.addEventListener('pointercancel', finishHistoryPointer, true);
    document.addEventListener('selectionchange', flushPendingHistory);
    const clearDropMarkers = () => {
      sessionList.querySelectorAll('.dragging, .drop-before, .drop-after').forEach(item => {
        item.classList.remove('dragging', 'drop-before', 'drop-after');
        item.setAttribute('aria-grabbed', 'false');
      });
    };
    sessionList.addEventListener('click', async event => {
      if (state.sessionDragJustEnded) return;
      const failureCause = event.target.closest('[data-terminal-failure-cause]');
      if (failureCause) {
        const session = state.sessions.find(item => item.id === failureCause.dataset.terminalFailureCause);
        await selectSession(failureCause.dataset.terminalFailureCause);
        const recordedReason = String(session?.statusDetail || '').trim();
        notice(t('terminal.failure.cause_message', {
          reason: recordedReason || (session?.error ? errorMessage(session.error) : t('terminal.failure.unknown')),
        }), 'error');
        return;
      }
      const reopen = event.target.closest('[data-terminal-restart-inline]');
      if (reopen) {
        const id = reopen.dataset.terminalRestartInline;
        const restarted = await runBusy(reopen, () => guarded(
          () => window.loadtoagent.terminalRestart(id),
          t('terminal.session.restarted'),
          `terminal-restart:${id}`,
        ));
        if (restarted) {
          await refreshSessions();
          await selectSession(id);
          renderAll();
        }
        return;
      }
      const item = event.target.closest('[data-terminal-id]');
      if (item) selectSession(item.dataset.terminalId);
    });
    sessionList.addEventListener('dragstart', event => {
      const item = event.target.closest('[data-terminal-id]');
      if (!item) return;
      state.draggedSessionId = item.dataset.terminalId;
      item.classList.add('dragging');
      item.setAttribute('aria-grabbed', 'true');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', state.draggedSessionId);
      }
    });
    sessionList.addEventListener('dragover', event => {
      const target = event.target.closest('[data-terminal-id]');
      if (!target || target.dataset.terminalId === state.draggedSessionId) return;
      event.preventDefault();
      sessionList.querySelectorAll('.drop-before, .drop-after').forEach(item => item.classList.remove('drop-before', 'drop-after'));
      const bounds = target.getBoundingClientRect();
      target.classList.add(event.clientY > bounds.top + bounds.height / 2 ? 'drop-after' : 'drop-before');
    });
    sessionList.addEventListener('drop', event => {
      const target = event.target.closest('[data-terminal-id]');
      const sourceId = state.draggedSessionId || event.dataTransfer?.getData('text/plain');
      if (!target || !sourceId || target.dataset.terminalId === sourceId) return;
      event.preventDefault();
      const bounds = target.getBoundingClientRect();
      const changed = reorderSession(sourceId, target.dataset.terminalId, event.clientY > bounds.top + bounds.height / 2);
      clearDropMarkers();
      state.draggedSessionId = '';
      state.sessionDragJustEnded = true;
      setTimeout(() => { state.sessionDragJustEnded = false; }, 0);
      if (changed) {
        renderAll();
        notice(window.LoadToAgentI18n.t('terminal.reordered'), 'success');
      }
    });
    sessionList.addEventListener('dragend', () => {
      clearDropMarkers();
      state.draggedSessionId = '';
    });
    sessionList.addEventListener('dragleave', event => {
      if (!sessionList.contains(event.relatedTarget)) clearDropMarkers();
    });
    sessionList.addEventListener('keydown', event => {
      const item = event.target.closest('[data-terminal-id]');
      if (item && !event.altKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        const items = Array.from(sessionList.querySelectorAll('[data-terminal-id]'))
          .filter(candidate => !candidate.closest('details:not([open])'));
        const current = Math.max(0, items.indexOf(item));
        const next = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        event.preventDefault();
        items.forEach((candidate, index) => { candidate.tabIndex = index === next ? 0 : -1; });
        items[next]?.focus();
        return;
      }
      if (!item || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const changed = moveSessionByOffset(item.dataset.terminalId, event.key === 'ArrowUp' ? -1 : 1);
      if (!changed) return;
      renderAll();
      requestAnimationFrame(() => sessionList.querySelector(`[data-terminal-id="${CSS.escape(item.dataset.terminalId)}"]`)?.focus());
      notice(window.LoadToAgentI18n.t('terminal.reordered'), 'success');
    });
    $('#terminalTmuxList').addEventListener('click', event => {
      const item = event.target.closest('[data-tmux-distro][data-tmux-pane]');
      if (item) selectTmux(item.dataset.tmuxDistro, item.dataset.tmuxPane, 'computer');
    });
    $('#terminalTmuxList').addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const items = Array.from(event.currentTarget.querySelectorAll('[data-tmux-distro][data-tmux-pane]'));
      const current = Math.max(0, items.indexOf(event.target.closest('[data-tmux-distro][data-tmux-pane]')));
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      event.preventDefault();
      items.forEach((candidate, index) => { candidate.tabIndex = index === next ? 0 : -1; });
      items[next]?.focus();
    });
    $('#terminalCommandForm').addEventListener('submit', async event => {
      event.preventDefault();
      if (state.commandSending) return;
      const input = $('#terminalCommandInput');
      const sent = await sendCommand(input.value);
      if (!sent) {
        if ($('#terminalNotice')?.dataset.tone === 'error') $('#terminalNotice').focus({ preventScroll: true });
        return;
      }
      const targetId = currentTargetId();
      const history = state.commandHistory.get(targetId) || [];
      const command = input.value;
      if (command && history[history.length - 1] !== command) state.commandHistory.set(targetId, [...history, command].slice(-100));
      input.value = '';
      state.commandDrafts.delete(targetId);
      state.commandHistoryNavigation = { targetId, index: -1, draft: '' };
      $('#terminalCommandForm button[type="submit"]').disabled = true;
      $('#terminalCommandClearBtn').classList.add('hidden');
      $('#terminalCommandCount').classList.remove('warning');
      $('#terminalCommandCount').textContent = t('terminal.composer.count', { count: 0 });
      composer?.sync();
      input.focus({ preventScroll: true });
    });
    $('#terminalCommandInput').addEventListener('input', event => {
      const targetId = currentTargetId();
      if (targetId) state.commandDrafts.set(targetId, event.target.value);
      $('#terminalCommandCount').textContent = t('terminal.composer.count', { count: event.target.value.length.toLocaleString() });
      $('#terminalCommandClearBtn').classList.toggle('hidden', !event.target.value);
      const count = $('#terminalCommandCount');
      const wasWarning = count.dataset.warning === 'true';
      const warning = event.target.value.length >= 7_200;
      count.classList.toggle('warning', warning);
      count.dataset.warning = warning ? 'true' : 'false';
      $('#terminalCommandForm button[type="submit"]').disabled = state.commandSending
        || event.target.disabled
        || !event.target.value.trim();
      if (warning && !wasWarning) window.LoadToAgentA11y?.announce(t('quality.command_near_limit', { count: 8_000 - event.target.value.length }));
      state.commandHistoryNavigation = { targetId, index: -1, draft: event.target.value };
      composer?.sync();
    });
    $('#terminalCommandInput').addEventListener('keydown', event => {
      if (composer?.handleKeydown(event)) return;
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        $('#terminalCommandForm').requestSubmit();
        return;
      }
      if (event.key === 'Escape' && event.currentTarget.value) {
        event.preventDefault();
        $('#terminalCommandClearBtn').click();
        return;
      }
      if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      const targetId = currentTargetId();
      const history = state.commandHistory.get(targetId) || [];
      if (!history.length) return;
      event.preventDefault();
      let navigation = state.commandHistoryNavigation;
      if (navigation.targetId !== targetId || navigation.index < 0) navigation = { targetId, index: history.length, draft: event.currentTarget.value };
      if (event.key === 'ArrowUp') navigation.index = Math.max(0, navigation.index - 1);
      else navigation.index = Math.min(history.length, navigation.index + 1);
      event.currentTarget.value = navigation.index >= history.length ? navigation.draft : history[navigation.index];
      state.commandHistoryNavigation = navigation;
      state.commandDrafts.set(targetId, event.currentTarget.value);
      $('#terminalCommandClearBtn').classList.toggle('hidden', !event.currentTarget.value);
      $('#terminalCommandCount').textContent = t('terminal.composer.count', { count: event.currentTarget.value.length.toLocaleString() });
      $('#terminalCommandForm button[type="submit"]').disabled = state.commandSending
        || event.currentTarget.disabled
        || !event.currentTarget.value.trim();
      composer?.sync();
      const input = event.currentTarget;
      requestAnimationFrame(() => {
        if (input.isConnected) input.setSelectionRange(input.value.length, input.value.length);
      });
    });
    $('#terminalCommandClearBtn').addEventListener('click', () => {
      const input = $('#terminalCommandInput');
      input.value = '';
      const targetId = currentTargetId();
      if (targetId) state.commandDrafts.delete(targetId);
      state.commandHistoryNavigation = { targetId, index: -1, draft: '' };
      $('#terminalCommandForm button[type="submit"]').disabled = true;
      $('#terminalCommandClearBtn').classList.add('hidden');
      $('#terminalCommandCount').textContent = t('terminal.composer.count', { count: 0 });
      $('#terminalCommandCount').classList.remove('warning');
      composer?.sync();
      input.focus({ preventScroll: true });
      window.LoadToAgentA11y?.announce(t('quality.terminal_draft_cleared'));
    });
    $('#terminalFontDecreaseBtn').addEventListener('click', () => setTerminalFontSize(state.terminalFontSize - 1));
    $('#terminalFontIncreaseBtn').addEventListener('click', () => setTerminalFontSize(state.terminalFontSize + 1));
    $('#terminalComputerInputBtn').addEventListener('click', () => {
      if (!focusComputerWorkInput()) notice(t('ui.select_a_session_on_the_left_first'), 'warning');
    });
    $('#terminalFocusBtn').addEventListener('click', toggleTerminalFocusMode);
    document.querySelectorAll('[data-terminal-signal]').forEach(button => button.addEventListener('click', () => sendSignal(button.dataset.terminalSignal)));
    $('#terminalRestartBtn').addEventListener('click', async event => {
      const session = currentSession();
      if (!session) return;
      await runBusy(event.currentTarget, async () => {
        const managedSession = session.backend === 'managed-tmux';
        const restarted = await guarded(
          () => managedSession
            ? window.loadtoagent.terminalReconnect(session.id)
            : window.loadtoagent.terminalRestart(session.id),
          managedSession ? t('terminal.session.reconnected') : t('terminal.session.restarted'),
          `${managedSession ? 'terminal-reconnect' : 'terminal-restart'}:${session.id}`,
        );
        if (restarted) {
          const entry = state.terminals.get(session.id);
          if (entry) entry.terminal.reset();
          await refreshSessions();
        }
      });
      renderAll();
    });
    const endTerminalSession = async (button, session) => {
      if (!session) return;
      const managedSession = session.backend === 'managed-tmux';
      const stopManagedSession = managedSession && session.status !== 'stopped';
      const confirmation = isAiTerminalSession(session) ? 'terminal.session.confirm_end_ai' : 'terminal.session.confirm_end';
      if (session.type !== 'tmux' && ['running', 'detached'].includes(session.status) && !window.confirm(t(confirmation, { title: session.title }))) return;
      await runBusy(button, async () => {
        const message = stopManagedSession
          ? t('terminal.session.stopped')
          : session.type === 'tmux' ? t('terminal.tmux.detached_input') : t('terminal.session.ended');
        const closed = await guarded(
          () => stopManagedSession
            ? window.loadtoagent.terminalStop(session.id)
            : window.loadtoagent.terminalClose(session.id),
          message,
          `${stopManagedSession ? 'terminal-stop' : 'terminal-close'}:${session.id}`,
        );
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
      renderAll();
    };
    $('#terminalCloseBtn').addEventListener('click', async event => {
      const session = currentSession();
      if (!session) {
        state.selectedTmux = null;
        renderAll();
        await showSelection();
        return;
      }
      if (isAiTerminalSession(session)) {
        if (session.backend === 'managed-tmux' && session.status === 'running') {
          const detached = await runBusy(event.currentTarget, () => guarded(
            () => window.loadtoagent.terminalDetach(session.id),
            t('terminal.tmux.detached_input'),
            `terminal-detach:${session.id}`,
          ));
          if (!detached) return;
          await refreshSessions();
        }
        state.captureGeneration += 1;
        state.selectedId = null;
        state.boundAgent = null;
        state.boundTargetId = '';
        renderAll();
        renderHistoryPanel();
        await showSelection();
        notice(t('terminal.view_closed_ai_kept'), 'success');
        return;
      }
      await endTerminalSession(event.currentTarget, session);
    });
    $('#terminalEndSessionBtn').addEventListener('click', event => endTerminalSession(event.currentTarget, currentSession()));
    $('#terminalHistoryToggle').addEventListener('click', () => {
      state.historyCollapsed = !state.historyCollapsed;
      renderHistoryPanel();
      const entry = currentSession() ? state.terminals.get(state.selectedId) : state.remoteTerminal;
      fitEntry(entry, state.selectedId || '');
    });
  }

  function bindTmuxEvents() {
    $('#terminalAttachBtn').addEventListener('click', event => runBusy(event.currentTarget, attachTmux));
    $('#terminalTmuxTools').addEventListener('click', event => {
      const button = event.target.closest('[data-tmux-manage]');
      if (button) runBusy(button, () => manageTmux(button.dataset.tmuxManage));
    });
    $('#terminalTmuxLayout').addEventListener('change', async event => {
      const remote = currentTmux();
      if (!remote) return;
      const result = await guarded(() => window.loadtoagent.tmuxSelectLayout({ distro: remote.distro.name, target: remote.window.nativeId, layout: event.target.value }), t('terminal.tmux.layout_changed'), `tmux-layout:${remote.window.nativeId}`);
      if (result) setTimeout(refreshSnapshot, 250);
    });
    $('#tmuxCreateForm').addEventListener('submit', async event => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('[type="submit"]');
      if (submit.dataset.busy === 'true') return;
      submit.dataset.busy = 'true';
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      $('#closeTmuxCreateBtn').disabled = true;
      $('#cancelTmuxCreateBtn').disabled = true;
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
          closeTmuxModal(true);
          notice(t('terminal.tmux.workspace_created'), 'success');
          setTimeout(refreshSnapshot, 300);
        } else {
          error.textContent = result && result.error || t('terminal.tmux.workspace_create_failed');
          error.classList.remove('hidden');
          error.focus({ preventScroll: true });
        }
      } catch (failure) {
        error.textContent = errorMessage(failure);
        error.classList.remove('hidden');
        error.focus({ preventScroll: true });
      } finally {
        delete submit.dataset.busy;
        submit.disabled = false;
        submit.removeAttribute('aria-busy');
        $('#closeTmuxCreateBtn').disabled = false;
        $('#cancelTmuxCreateBtn').disabled = false;
      }
    });
    $('#tmuxCreateForm').addEventListener('invalid', event => {
      event.target.setAttribute('aria-invalid', 'true');
    }, true);
    $('#tmuxCreateForm').addEventListener('input', event => {
      if (event.target.matches('input, textarea, select') && event.target.checkValidity()) event.target.removeAttribute('aria-invalid');
    });
    $('#tmuxCreateName').addEventListener('blur', event => {
      const normalized = event.target.value.trim().replace(/\s+/g, '-');
      if (normalized !== event.target.value) {
        event.target.value = normalized;
        event.target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    $('#pickTmuxCwdBtn').addEventListener('click', event => runBusy(event.currentTarget, async () => {
      try {
        const folder = await window.loadtoagent.pickWorkspace();
        if (folder) $('#tmuxCreateCwd').value = folder;
      } catch (failure) {
        notice(errorMessage(failure), 'error');
      }
    }));
    $('#closeTmuxCreateBtn').addEventListener('click', () => closeTmuxModal());
    $('#cancelTmuxCreateBtn').addEventListener('click', () => closeTmuxModal());
    let tmuxBackdropPress = null;
    $('#tmuxCreateModal').addEventListener('pointerdown', event => { tmuxBackdropPress = event.target === event.currentTarget; });
    $('#tmuxCreateModal').addEventListener('click', event => {
      if (event.target === event.currentTarget && tmuxBackdropPress !== false) closeTmuxModal();
      tmuxBackdropPress = null;
    });
  }

  function bindTerminalWindowAndPreloadEvents() {
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !$('#tmuxCreateModal').classList.contains('hidden')) closeTmuxModal();
    });
    window.addEventListener('resize', () => {
      const entry = currentSession() ? state.terminals.get(state.selectedId) : state.remoteTerminal;
      fitEntry(entry, state.selectedId || '');
    });
    window.loadtoagent.onTerminalData(payload => {
      const entry = state.terminals.get(payload && payload.id);
      writeTerminalOutput(entry, payload && payload.data);
    });
    window.loadtoagent.onTerminalState(payload => refreshSessions(payload));
    window.loadtoagent.onTerminalError(payload => notice(payload && payload.message || t('terminal.error.input_failed'), 'error'));
    window.loadtoagent.onTerminalConnection?.(payload => {
      const tone = payload?.state === 'failed' ? 'error' : payload?.state === 'connected' ? 'success' : 'info';
      notice(payload?.message || t('terminal.error.input_failed'), tone);
    });
  }
};
