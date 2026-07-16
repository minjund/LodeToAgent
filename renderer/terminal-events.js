'use strict';

/** Bind terminal DOM/preload events using dependencies owned by terminal.js. */
window.LoadToAgentTerminalEvents = function bindTerminalEvents(context) {
  const {
    $, state, createTerminal, openTmuxModal, refreshSnapshot, selectSession, selectTmux,
    sendCommand, currentTargetId, sendSignal, currentSession, guarded, renderAll, showSelection,
    refreshSessions, renderHistoryPanel, fitEntry, attachTmux, currentTmux, manageTmux,
    closeTmuxModal, errorMessage, notice, reorderSession, moveSessionByOffset,
  } = context;

  bindTerminalSessionEvents();
  bindTmuxEvents();
  bindTerminalWindowAndPreloadEvents();

  function bindTerminalSessionEvents() {
    $('#newPowerShellBtn').addEventListener('click', () => createTerminal(state.platform.localShell));
    $('#newWslBtn').addEventListener('click', () => createTerminal('wsl'));
    $('#newTmuxSessionBtn').addEventListener('click', openTmuxModal);
    $('#refreshTmuxTerminalBtn').addEventListener('click', refreshSnapshot);
    const sessionList = $('#terminalSessionList');
    const clearDropMarkers = () => {
      sessionList.querySelectorAll('.dragging, .drop-before, .drop-after').forEach(item => {
        item.classList.remove('dragging', 'drop-before', 'drop-after');
        item.setAttribute('aria-grabbed', 'false');
      });
    };
    sessionList.addEventListener('click', event => {
      const move = event.target.closest('[data-session-move][data-session-move-id]');
      if (move) {
        const changed = moveSessionByOffset(move.dataset.sessionMoveId, Number(move.dataset.sessionMove));
        if (!changed) return;
        renderAll();
        requestAnimationFrame(() => {
          const next = sessionList.querySelector(`[data-session-move-id="${CSS.escape(move.dataset.sessionMoveId)}"][data-session-move="${CSS.escape(move.dataset.sessionMove)}"]`);
          if (next && !next.disabled) next.focus();
          else sessionList.querySelector(`[data-terminal-id="${CSS.escape(move.dataset.sessionMoveId)}"]`)?.focus();
        });
        notice(window.LoadToAgentI18n.t('terminal.reordered'), 'success');
        return;
      }
      if (state.sessionDragJustEnded) return;
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
  }

  function bindTmuxEvents() {
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
        } else {
          error.textContent = result && result.error || '새 tmux 작업을 만들지 못했습니다.';
          error.classList.remove('hidden');
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
      if (entry && payload.data) entry.terminal.write(payload.data);
    });
    window.loadtoagent.onTerminalState(payload => refreshSessions(payload));
    window.loadtoagent.onTerminalError(payload => notice(payload && payload.message || '명령창 입력에 실패했습니다.', 'error'));
  }
};
