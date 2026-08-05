'use strict';

(() => {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const report = (scope, error) => window.LoadToAgentRendererUtils?.reportRecoverableError?.(scope, error);
  const state = {
    session: null,
    target: null,
    generation: 0,
    pendingMountKey: '',
    unavailableTargets: new Map(),
    baseStatus: { tone: 'connecting', key: 'drawer.terminal_connecting', meta: '' },
  };

  const element = id => document.getElementById(id);
  const surface = () => element('drawerTerminalSurface');
  const viewport = () => element('drawerTerminalViewport');

  function targetIdOf(target) {
    return String(target?.terminalId || target?.id || '');
  }

  function targetUnavailable(sessionId, targetId) {
    return Boolean(sessionId && targetId && state.unavailableTargets.get(String(sessionId))?.has(String(targetId)));
  }

  function notifyTargetsChanged(detail = {}) {
    window.dispatchEvent(new CustomEvent('loadtoagent:drawer-terminal-targets-changed', { detail }));
  }

  function markUnavailable(sessionId, targetId, reason = '') {
    const safeSessionId = String(sessionId || '');
    const safeTargetId = String(targetId || '');
    if (!safeSessionId || !safeTargetId) return;
    const targets = state.unavailableTargets.get(safeSessionId) || new Set();
    const changed = !targets.has(safeTargetId);
    targets.add(safeTargetId);
    state.unavailableTargets.set(safeSessionId, targets);
    if (changed) notifyTargetsChanged({ sessionId: safeSessionId, targetId: safeTargetId, available: false, reason });
  }

  function clearUnavailable(sessionId, targetId = '') {
    const safeSessionId = String(sessionId || '');
    const targets = state.unavailableTargets.get(safeSessionId);
    if (!targets) return false;
    if (!targetId) {
      state.unavailableTargets.delete(safeSessionId);
      return true;
    }
    const changed = targets.delete(String(targetId));
    if (!targets.size) state.unavailableTargets.delete(safeSessionId);
    return changed;
  }

  function pendingPrompt() {
    return state.session
      ? window.LoadToAgentTerminal?.pendingPromptForSession?.(state.session) || null
      : null;
  }

  function renderStatus() {
    const prompt = pendingPrompt();
    const status = prompt
      ? { tone: 'attention', key: 'drawer.terminal_needs_input', meta: prompt.summary || prompt.question || '' }
      : state.baseStatus;
    const bar = surface()?.querySelector('.drawer-terminal-statusbar');
    if (bar) bar.dataset.tone = status.tone;
    const composer = element('drawerComposer');
    const terminalComposer = composer?.dataset.mode === 'terminal';
    if (terminalComposer) composer.dataset.tone = status.tone;
    if (element('drawerTerminalStatus')) element('drawerTerminalStatus').textContent = t(status.key);
    if (element('drawerTerminalMeta')) element('drawerTerminalMeta').textContent = String(status.meta || '');
    const input = composer?.querySelector('[data-agent-command-draft]');
    if (terminalComposer && input) input.placeholder = t(prompt ? 'drawer.terminal_answer_placeholder' : 'drawer.terminal_placeholder');
  }

  function setStatus(tone, key, meta = '') {
    state.baseStatus = { tone, key, meta };
    renderStatus();
  }

  function setEmpty(visible, titleKey = 'drawer.terminal_connecting', helpKey = 'drawer.terminal_connecting_help') {
    const empty = element('drawerTerminalEmpty');
    if (!empty) return;
    empty.classList.toggle('hidden', !visible);
    const title = empty.querySelector('b');
    const help = empty.querySelector('small');
    if (title) title.textContent = t(titleKey);
    if (help) help.textContent = t(helpKey);
  }

  function selectedTargetId(session) {
    const selected = element('drawerComposer')?.querySelector('[data-agent-command-target]')?.value || '';
    if (selected) return selected;
    const targets = window.LoadToAgentTerminal?.agentTargets?.(session) || [];
    return (targets.find(target => target.kind === 'terminal') || targets[0] || {}).id || '';
  }

  function targetMeta(result) {
    const target = result?.target || state.target;
    const label = target?.label || result?.terminal?.title || target?.id || '';
    return label ? `${label} · ${t('drawer.terminal_scrollback_restored')}` : t('drawer.terminal_scrollback_restored');
  }

  async function mount(session, options = {}) {
    if (!session?.id || !viewport()?.isConnected) return { ok: false, reason: 'invalid-mount', targets: [] };
    state.session = session;
    const requestedTargetId = options.targetId || selectedTargetId(session);
    const embedded = window.LoadToAgentTerminal?.embeddedState?.() || {};
    if (!options.force
      && embedded.connected
      && embedded.agentSessionId === session.id
      && (!requestedTargetId || embedded.terminalId === requestedTargetId)) {
      renderStatus();
      return { ok: true, reused: true, target: state.target };
    }

    const mountKey = `${session.id}:${requestedTargetId}`;
    if (!options.force && state.pendingMountKey === mountKey) return { ok: false, reason: 'pending', targets: [] };
    state.pendingMountKey = mountKey;

    const generation = ++state.generation;
    state.target = null;
    setEmpty(true);
    setStatus('connecting', 'drawer.terminal_connecting');
    try {
      const result = await window.LoadToAgentTerminal?.mountForAgent?.(session, {
        mount: viewport(),
        targetId: requestedTargetId,
        focus: false,
      });
      if (generation !== state.generation || state.session?.id !== session.id) {
        return { ok: false, reason: 'cancelled', targets: [] };
      }
      state.target = result?.target || null;
      if (result?.ok) {
        const connectedTargetId = targetIdOf(result.target) || requestedTargetId;
        clearUnavailable(session.id, connectedTargetId);
        setEmpty(false);
        setStatus('connected', 'drawer.terminal_connected', targetMeta(result));
        notifyTargetsChanged({ sessionId: session.id, targetId: connectedTargetId, available: true, connected: true });
        return result;
      }
      if (result?.reason === 'tmux-readonly' && state.target) {
        markUnavailable(session.id, targetIdOf(state.target) || requestedTargetId, result.reason);
        setEmpty(true, 'drawer.terminal_tmux_target', 'drawer.terminal_tmux_help');
        setStatus('unavailable', 'drawer.terminal_tmux_target', state.target.label || '');
        return result;
      }
      if (result?.reason !== 'cancelled' && result?.reason !== 'pending') {
        markUnavailable(session.id, targetIdOf(result?.target) || requestedTargetId, result?.reason || 'unavailable');
      }
      setEmpty(true, 'drawer.terminal_unavailable', 'drawer.terminal_unavailable_help');
      setStatus('unavailable', 'drawer.terminal_unavailable');
      return result || { ok: false, reason: 'unavailable', targets: [] };
    } catch (error) {
      if (generation !== state.generation) return { ok: false, reason: 'cancelled', targets: [] };
      markUnavailable(session.id, requestedTargetId, 'mount-failed');
      setEmpty(true, 'drawer.terminal_failed', 'drawer.terminal_failed_help');
      setStatus('error', 'drawer.terminal_failed', window.LoadToAgentI18n.errorText(error, 'drawer.terminal_failed'));
      report('drawer-terminal-mount', error);
      return { ok: false, reason: 'mount-failed', error, targets: [] };
    } finally {
      if (generation === state.generation) state.pendingMountKey = '';
    }
  }

  function unmount(options = {}) {
    const resetSessionId = String(options.sessionId || state.session?.id || '');
    state.generation += 1;
    window.LoadToAgentTerminal?.unmountEmbedded?.();
    state.session = null;
    state.target = null;
    state.pendingMountKey = '';
    if (options.resetAvailability && resetSessionId) clearUnavailable(resetSessionId);
    setEmpty(true);
    setStatus('connecting', 'drawer.terminal_connecting');
  }

  element('drawerTerminalFocusBtn')?.addEventListener('click', () => {
    if (!window.LoadToAgentTerminal?.focusEmbedded?.()) setStatus('unavailable', 'drawer.terminal_unavailable');
  });
  element('drawerTerminalReconnectBtn')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!state.session || button.getAttribute('aria-busy') === 'true') return;
    button.setAttribute('aria-busy', 'true');
    try {
      await window.LoadToAgentTerminal?.refresh?.();
      await mount(state.session, { force: true, targetId: selectedTargetId(state.session) });
    } catch (error) {
      setStatus('error', 'drawer.terminal_failed', window.LoadToAgentI18n.errorText(error, 'drawer.terminal_failed'));
      report('drawer-terminal-reconnect', error);
    } finally {
      button.removeAttribute('aria-busy');
    }
  });
  element('drawerComposer')?.addEventListener('submit', event => {
    if (!state.session || element('drawerComposer')?.dataset.mode !== 'terminal') return;
    setStatus('running', 'drawer.terminal_sending', state.target?.label || '');
  }, true);
  element('drawerComposer')?.addEventListener('change', event => {
    const picker = event.target.closest?.('[data-agent-command-target]');
    if (!state.session || !picker?.value) return;
    mount(state.session, { force: true, targetId: picker.value });
  });

  window.loadtoagent?.onTerminalData?.(payload => {
    if (!state.target || state.target.kind !== 'terminal' || payload?.id !== (state.target.terminalId || state.target.id)) return;
    setStatus('running', 'drawer.terminal_running', state.target.label || '');
  });
  window.loadtoagent?.onTerminalState?.(payload => {
    if (!Array.isArray(payload?.sessions)) return;
    const usableIds = new Set(payload.sessions
      .filter(item => !['stopped', 'exited', 'failed'].includes(String(item?.status || '')))
      .map(item => String(item.id || ''))
      .filter(Boolean));
    for (const [sessionId, targets] of state.unavailableTargets) {
      for (const targetId of [...targets]) {
        if (usableIds.has(targetId)) clearUnavailable(sessionId, targetId);
      }
    }
    if (state.session && state.target?.kind === 'terminal') {
      const terminalId = targetIdOf(state.target);
      const terminal = payload.sessions.find(item => item.id === terminalId);
      if (payload.change === 'reconnected' && terminal) {
        setTimeout(() => state.session && mount(state.session, { force: true, targetId: terminalId }), 0);
      } else if (!terminal || ['stopped', 'exited', 'failed'].includes(terminal.status)) {
        markUnavailable(state.session.id, terminalId, terminal?.status || 'removed');
        setStatus('unavailable', 'drawer.terminal_unavailable', terminal?.statusDetail || '');
      }
    }
    // The terminal inventory can change while the drawer is showing a safe
    // transcript. Re-evaluate the surface even when no xterm is mounted.
    setTimeout(() => notifyTargetsChanged({ change: payload.change || 'updated' }), 0);
  });
  window.loadtoagent?.onTerminalConnection?.(payload => {
    if (!state.session) return;
    if (payload?.state === 'reconnecting') setStatus('connecting', 'drawer.terminal_connecting', payload.message || '');
    else if (payload?.state === 'failed') setStatus('error', 'drawer.terminal_failed', payload.message || '');
  });
  window.loadtoagent?.onTerminalError?.(payload => {
    if (state.session) setStatus('error', 'drawer.terminal_failed', payload?.message || '');
  });
  window.addEventListener('loadtoagent:terminal-command-delivery', event => {
    if (!state.session || event.detail?.sessionId !== state.session.id) return;
    if (event.detail.deliveryState === 'rejected') {
      setStatus('error', 'drawer.terminal_delivery_failed', t('drawer.terminal_delivery_failed_help'));
    } else if (event.detail.deliveryState === 'unknown') {
      setStatus('attention', 'drawer.terminal_delivery_uncertain', event.detail.target?.label || '');
    } else {
      setStatus('delivered', 'drawer.terminal_delivered', t('drawer.terminal_delivered_help'));
    }
  });
  window.addEventListener('loadtoagent:terminal-prompts-changed', renderStatus);
  window.addEventListener('loadtoagent:locale-changed', renderStatus);

  window.LoadToAgentDrawerTerminal = {
    mount,
    unmount,
    refresh: () => state.session && mount(state.session, { force: true }),
    canMount: (session, targetId) => !targetUnavailable(session?.id, targetId),
    resetAvailability: sessionId => clearUnavailable(sessionId),
    state: () => ({
      sessionId: state.session?.id || '',
      targetId: state.target?.id || '',
      targetKind: state.target?.kind || '',
    }),
  };
})();
