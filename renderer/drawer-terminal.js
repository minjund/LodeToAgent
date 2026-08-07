'use strict';

(() => {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const report = (scope, error) => window.LoadToAgentRendererUtils?.reportRecoverableError?.(scope, error);
  const state = {
    session: null,
    target: null,
    generation: 0,
    pendingMountKey: '',
    connectionSignature: '',
    unavailableTargets: new Map(),
    connectionFailures: new Map(),
    baseStatus: { tone: 'connecting', key: 'drawer.terminal_connecting', meta: '' },
  };

  const element = id => document.getElementById(id);
  const surface = () => element('drawerTerminalSurface');
  const viewport = () => element('drawerTerminalViewport');

  function targetIdOf(target) {
    return String(target?.terminalId || target?.id || '');
  }

  function connectionSignature(session) {
    const sharedSignature = window.LoadToAgentTerminal?.agentConnectionSignature?.(session);
    if (sharedSignature) return sharedSignature;
    const environment = session?.environment || {};
    // Keep the fallback stable for the same conversation. External runtime
    // discovery is display metadata and must never remount or authorize the
    // app-owned PTY when a tmux pane moves.
    return JSON.stringify([
      session?.id,
      String(session?.provider || '').toLowerCase(),
      session?.externalId,
      String(environment.kind || '').toLowerCase(),
      String(environment.distro || '').toLowerCase(),
    ].map(value => String(value || '').trim()));
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
    if (element('drawerTerminalStatus')) element('drawerTerminalStatus').textContent = t(status.key);
    if (element('drawerTerminalMeta')) element('drawerTerminalMeta').textContent = String(status.meta || '');
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

  function resumeSupport(session) {
    return window.LoadToAgentTerminal?.resumeSupport?.(session)
      || { supported: false, reason: '' };
  }

  function setResumeAction(visible) {
    const button = element('drawerTerminalResumeBtn');
    if (!button) return;
    button.classList.toggle('hidden', !visible);
    button.disabled = !visible;
  }

  function showUnavailable(session) {
    const support = resumeSupport(session);
    const resumable = Boolean(support.supported);
    setResumeAction(resumable);
    setEmpty(
      true,
      resumable ? 'drawer.terminal_resume_available' : 'drawer.terminal_unavailable',
      resumable ? 'drawer.terminal_resume_available_help' : 'drawer.terminal_unavailable_help',
    );
    setStatus('unavailable', resumable ? 'drawer.terminal_resume_available' : 'drawer.terminal_unavailable', support.reason || '');
    return { ok: false, reason: 'no-target', targets: [], resumable };
  }

  function selectedTargetId(session, createIfMissing = false, excludedTargetIds = new Set()) {
    const targets = (window.LoadToAgentTerminal?.agentTargets?.(session) || [])
      .filter(target => !excludedTargetIds.has(targetIdOf(target)));
    return (targets.find(target => target.kind === 'terminal') || (createIfMissing ? null : targets[0]) || {}).id || '';
  }

  function targetMeta(result) {
    const target = result?.target || state.target;
    const label = target?.label || result?.terminal?.title || target?.id || '';
    return label ? `${label} · ${t('drawer.terminal_scrollback_restored')}` : t('drawer.terminal_scrollback_restored');
  }

  async function mount(session, options = {}) {
    if (!session?.id || !viewport()?.isConnected) return { ok: false, reason: 'invalid-mount', targets: [] };
    const signature = connectionSignature(session);
    const embeddedBefore = window.LoadToAgentTerminal?.embeddedState?.() || {};
    const previousSessionId = String(state.session?.id || '');
    const previousSignature = state.connectionSignature;
    const switchingSession = (previousSessionId && previousSessionId !== session.id)
      || (previousSessionId === session.id && previousSignature && previousSignature !== signature)
      || (embeddedBefore.agentSessionId && embeddedBefore.agentSessionId !== session.id);
    if (switchingSession) {
      state.generation += 1;
      window.LoadToAgentTerminal?.unmountEmbedded?.();
      state.target = null;
      state.pendingMountKey = '';
    }
    state.session = session;
    state.connectionSignature = signature;
    if (switchingSession) {
      setEmpty(true);
      setStatus('connecting', 'drawer.terminal_connecting');
    }
    const createIfMissing = options.createIfMissing === true;
    const excludedTargetIds = new Set((options.excludeTargetIds || []).map(value => String(value || '')).filter(Boolean));
    const requestedOptionTargetId = String(options.targetId || '');
    const requestedTargetId = requestedOptionTargetId && !excludedTargetIds.has(requestedOptionTargetId)
      ? requestedOptionTargetId
      : selectedTargetId(session, createIfMissing, excludedTargetIds);
    if (!options.force && requestedTargetId && targetUnavailable(session.id, requestedTargetId)) {
      state.target = (window.LoadToAgentTerminal?.agentTargets?.(session) || [])
        .find(target => target.id === requestedTargetId) || null;
      if (switchingSession || !['error', 'unavailable'].includes(state.baseStatus.tone)) {
        setEmpty(true, 'drawer.terminal_unavailable', 'drawer.terminal_unavailable_help');
        setStatus('unavailable', 'drawer.terminal_unavailable', state.target?.label || '');
        notifyTargetsChanged({ sessionId: session.id, targetId: requestedTargetId, available: false, reason: 'unavailable' });
      } else renderStatus();
      return { ok: false, reason: 'unavailable', target: state.target, targets: [] };
    }
    let cachedFailure = !requestedTargetId ? state.connectionFailures.get(session.id) : null;
    if (cachedFailure && cachedFailure.signature !== signature) {
      state.connectionFailures.delete(session.id);
      cachedFailure = null;
    }
    if (!options.force && createIfMissing && cachedFailure) {
      setEmpty(true, 'drawer.terminal_failed', 'drawer.terminal_failed_help');
      setStatus('error', 'drawer.terminal_failed', cachedFailure.message || '');
      if (switchingSession) notifyTargetsChanged({
        sessionId: session.id,
        available: false,
        reason: cachedFailure.reason || 'mount-failed',
      });
      return { ok: false, reason: cachedFailure.reason || 'mount-failed', error: cachedFailure.error, targets: [] };
    }
    if (options.force) state.connectionFailures.delete(session.id);
    const embedded = window.LoadToAgentTerminal?.embeddedState?.() || {};
    const embeddedTarget = (window.LoadToAgentTerminal?.agentTargets?.(session) || [])
      .find(target => target.kind === 'terminal' && targetIdOf(target) === embedded.terminalId) || null;
    const embeddedVerified = Boolean(embeddedTarget && !targetUnavailable(session.id, embedded.terminalId));
    const embeddedJustConnected = state.session?.id === session.id
      && targetIdOf(state.target) === embedded.terminalId
      && state.baseStatus.tone === 'connected';
    if (!options.force
      && embedded.connected
      && embedded.agentSessionId === session.id
      && (!requestedTargetId || embedded.terminalId === requestedTargetId)
      && (embeddedVerified || embeddedJustConnected)) {
      renderStatus();
      return { ok: true, reused: true, target: state.target };
    }

    const mountKey = `${signature}:${requestedTargetId}:${createIfMissing ? 'create' : 'reuse'}:${[...excludedTargetIds].sort().join(',')}`;
    if (!options.force && state.pendingMountKey === mountKey) return { ok: false, reason: 'pending', targets: [] };
    state.pendingMountKey = mountKey;

    const generation = ++state.generation;
    state.target = null;
    setResumeAction(false);
    setEmpty(true);
    setStatus('connecting', 'drawer.terminal_connecting');
    try {
      const result = await window.LoadToAgentTerminal?.mountForAgent?.(session, {
        mount: viewport(),
        targetId: requestedTargetId,
        focus: false,
        createIfMissing,
        excludeTerminalIds: [...excludedTargetIds],
      });
      if (generation !== state.generation || state.session?.id !== session.id) {
        return { ok: false, reason: 'cancelled', targets: [] };
      }
      state.target = result?.target || null;
      if (result?.ok) {
        const connectedTargetId = targetIdOf(result.target) || requestedTargetId;
        state.connectionFailures.delete(session.id);
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
        if (createIfMissing && !requestedTargetId) {
          state.connectionFailures.set(session.id, {
            reason: result?.reason || 'unavailable',
            message: t('drawer.terminal_unavailable'),
            signature,
          });
          notifyTargetsChanged({ sessionId: session.id, available: false, reason: result?.reason || 'unavailable' });
        }
      }
      if (result?.reason === 'no-target') return showUnavailable(session);
      setResumeAction(false);
      setEmpty(true, 'drawer.terminal_unavailable', 'drawer.terminal_unavailable_help');
      setStatus('unavailable', 'drawer.terminal_unavailable');
      return result || { ok: false, reason: 'unavailable', targets: [] };
    } catch (error) {
      if (generation !== state.generation) return { ok: false, reason: 'cancelled', targets: [] };
      markUnavailable(session.id, requestedTargetId, 'mount-failed');
      const message = window.LoadToAgentI18n.errorText(error, 'drawer.terminal_failed');
      if (createIfMissing && !requestedTargetId) {
        state.connectionFailures.set(session.id, { reason: 'mount-failed', message, error, signature });
        notifyTargetsChanged({ sessionId: session.id, available: false, reason: 'mount-failed' });
      }
      setEmpty(true, 'drawer.terminal_failed', 'drawer.terminal_failed_help');
      setStatus('error', 'drawer.terminal_failed', message);
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
    state.connectionSignature = '';
    if (options.resetAvailability && resetSessionId) {
      clearUnavailable(resetSessionId);
      state.connectionFailures.delete(resetSessionId);
    }
    setResumeAction(false);
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
      clearUnavailable(state.session.id);
      state.connectionFailures.delete(state.session.id);
      await window.LoadToAgentTerminal?.refresh?.();
      const missingTargetIds = (window.LoadToAgentTerminal?.agentTargets?.(state.session) || [])
        .filter(target => target.kind === 'terminal'
          && !window.LoadToAgentTerminal?.hasTerminalSession?.(targetIdOf(target)))
        .map(targetIdOf);
      await mount(state.session, {
        force: true,
        targetId: selectedTargetId(state.session, true, new Set(missingTargetIds)),
        createIfMissing: true,
        excludeTargetIds: missingTargetIds,
      });
    } catch (error) {
      setStatus('error', 'drawer.terminal_failed', window.LoadToAgentI18n.errorText(error, 'drawer.terminal_failed'));
      report('drawer-terminal-reconnect', error);
    } finally {
      button.removeAttribute('aria-busy');
    }
  });
  element('drawerTerminalResumeBtn')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const session = state.session;
    if (!session || button.getAttribute('aria-busy') === 'true') return;
    const support = resumeSupport(session);
    if (!support.supported) {
      setResumeAction(false);
      setEmpty(true, 'drawer.terminal_unavailable', 'drawer.terminal_unavailable_help');
      setStatus('unavailable', 'drawer.terminal_unavailable', support.reason || '');
      return;
    }
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    setEmpty(true, 'drawer.terminal_resuming', 'drawer.terminal_resuming_help');
    setStatus('connecting', 'drawer.terminal_resuming');
    try {
      // Resuming is explicit: merely viewing an external session must never
      // spawn another AI process. The existing resume path preserves the
      // provider session id and creates only the LoadToAgent-owned PTY needed
      // for subsequent input and scrollback.
      const resumed = await window.LoadToAgentTerminal.resumeForAgent(session, '', false, { focus: false });
      if (state.session?.id !== session.id) return;
      const terminalId = targetIdOf(resumed);
      if (!terminalId) throw new Error(t('terminal.agent.resume_terminal_failed'));
      clearUnavailable(session.id, terminalId);
      const mounted = await mount(session, { force: true, targetId: terminalId });
      if (!mounted?.ok && !['cancelled', 'pending'].includes(mounted?.reason)) {
        throw new Error(t('drawer.terminal_resume_failed'));
      }
    } catch (error) {
      if (state.session?.id !== session.id) return;
      setResumeAction(true);
      setEmpty(true, 'drawer.terminal_resume_failed', 'drawer.terminal_resume_failed_help');
      setStatus('error', 'drawer.terminal_resume_failed', window.LoadToAgentI18n.errorText(error, 'drawer.terminal_resume_failed'));
      report('drawer-terminal-resume', error);
    } finally {
      button.removeAttribute('aria-busy');
      if (state.session?.id === session.id && !state.target) setResumeAction(true);
      else button.disabled = false;
    }
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
        state.connectionFailures.set(state.session.id, {
          reason: terminal?.status || 'removed',
          message: terminal?.statusDetail || t('drawer.terminal_unavailable'),
          signature: state.connectionSignature || connectionSignature(state.session),
        });
        state.generation += 1;
        state.pendingMountKey = '';
        window.LoadToAgentTerminal?.unmountEmbedded?.();
        state.target = null;
        setStatus('unavailable', 'drawer.terminal_unavailable', terminal?.statusDetail || '');
      }
    }
    // The terminal inventory can change while the drawer is showing the PTY's
    // unavailable state. Re-evaluate even when no xterm is mounted.
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
    refresh: () => {
      if (!state.session) return null;
      const missingTargetIds = (window.LoadToAgentTerminal?.agentTargets?.(state.session) || [])
        .filter(target => target.kind === 'terminal'
          && !window.LoadToAgentTerminal?.hasTerminalSession?.(targetIdOf(target)))
        .map(targetIdOf);
      return mount(state.session, {
        force: true,
        createIfMissing: true,
        excludeTargetIds: missingTargetIds,
      });
    },
    canMount: (session, targetId) => !targetUnavailable(session?.id, targetId),
    resetAvailability: sessionId => {
      const changed = clearUnavailable(sessionId);
      state.connectionFailures.delete(String(sessionId || ''));
      return changed;
    },
    state: () => ({
      sessionId: state.session?.id || '',
      targetId: state.target?.id || '',
      targetKind: state.target?.kind || '',
      phase: state.baseStatus.tone,
      connectionSignature: state.connectionSignature,
    }),
  };
})();
