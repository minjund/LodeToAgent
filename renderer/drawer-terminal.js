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
    reconnectFocusIntent: null,
    reconnectOwnerTerminalId: '',
    userFocusRevision: 0,
  };

  const element = id => document.getElementById(id);
  const surface = () => element('drawerTerminalSurface');
  const viewport = () => element('drawerTerminalViewport');

  function targetIdOf(target) {
    return String(target?.terminalId || target?.id || '');
  }

  function drawerSessionVisible(sessionId, expectedViewport = viewport()) {
    const drawer = element('detailDrawer');
    const terminalSurface = surface();
    return Boolean(sessionId
      && state.session?.id === sessionId
      && expectedViewport
      && expectedViewport === viewport()
      && expectedViewport.isConnected
      && drawer?.classList.contains('open')
      && drawer.dataset.terminalChat === 'true'
      && terminalSurface?.isConnected
      && !terminalSurface.classList.contains('hidden')
      && terminalSurface.getAttribute('aria-hidden') !== 'true');
  }

  function captureReconnectFocus(terminalId) {
    const safeTerminalId = String(terminalId || '');
    const sessionId = String(state.session?.id || '');
    const currentViewport = viewport();
    const embedded = window.LoadToAgentTerminal?.embeddedState?.() || {};
    const active = document.activeElement;
    const host = currentViewport
      ? [...currentViewport.children].find(child => String(child?.dataset?.terminalScreen || '') === safeTerminalId)
      : null;
    const rejected = !safeTerminalId
      || state.target?.kind !== 'terminal'
      || targetIdOf(state.target) !== safeTerminalId
      || !drawerSessionVisible(sessionId, currentViewport)
      || !embedded.connected
      || embedded.agentSessionId !== sessionId
      || String(embedded.terminalId || '') !== safeTerminalId
      || !host?.contains(active)
      || !active?.classList?.contains('xterm-helper-textarea');
    if (rejected) return;
    state.reconnectFocusIntent = {
      sessionId,
      terminalId: safeTerminalId,
      signature: state.connectionSignature,
      viewport: currentViewport,
      origin: active,
      revision: state.userFocusRevision,
    };
  }

  function restoreReconnectFocus(intent, attempt = 0) {
    if (!intent || state.reconnectFocusIntent !== intent) return;
    const identityStillCurrent = drawerSessionVisible(intent.sessionId, intent.viewport)
      && state.connectionSignature === intent.signature;
    if (!identityStillCurrent || state.userFocusRevision !== intent.revision) {
      state.reconnectFocusIntent = null;
      return;
    }
    requestAnimationFrame(() => {
      if (state.reconnectFocusIntent !== intent) return;
      const embedded = window.LoadToAgentTerminal?.embeddedState?.() || {};
      const host = [...(intent.viewport?.children || [])].find(child => (
        String(child?.dataset?.terminalScreen || '') === intent.terminalId
      ));
      const connectedTargetReady = state.target?.kind === 'terminal'
        && targetIdOf(state.target) === intent.terminalId
        && embedded.connected
        && embedded.agentSessionId === intent.sessionId
        && String(embedded.terminalId || '') === intent.terminalId
        && host?.parentElement === intent.viewport;
      if (!connectedTargetReady) {
        if (attempt < 240
          && drawerSessionVisible(intent.sessionId, intent.viewport)
          && state.connectionSignature === intent.signature
          && state.userFocusRevision === intent.revision) {
          setTimeout(() => restoreReconnectFocus(intent, attempt + 1), 50);
        } else {
          state.reconnectFocusIntent = null;
        }
        return;
      }
      const active = document.activeElement;
      const documentFocused = typeof document.hasFocus !== 'function' || document.hasFocus();
      const documentVisible = !document.visibilityState || document.visibilityState === 'visible';
      const focusStayedPassive = !active
        || active === document.body
        || active === document.documentElement
        || active === intent.origin
        || active.isConnected === false;
      const identityRemainsCurrent = drawerSessionVisible(intent.sessionId, intent.viewport)
        && state.connectionSignature === intent.signature
        && state.userFocusRevision === intent.revision;
      const shouldFocus = identityRemainsCurrent
        && focusStayedPassive
        && documentFocused
        && documentVisible;
      if (shouldFocus) {
        const focused = window.LoadToAgentTerminal?.focusEmbedded?.() === true;
        if (focused) state.reconnectFocusIntent = null;
        else if (attempt < 240) setTimeout(() => restoreReconnectFocus(intent, attempt + 1), 50);
        else state.reconnectFocusIntent = null;
      } else if (identityRemainsCurrent && focusStayedPassive && (!documentFocused || !documentVisible) && attempt < 240) {
        // Chromium can briefly report an unfocused/hidden document while the
        // old textarea is being detached. A real blur/visibility/user action
        // increments the revision and is cancelled at the next attempt.
        setTimeout(() => restoreReconnectFocus(intent, attempt + 1), 50);
      } else {
        state.reconnectFocusIntent = null;
      }
    });
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
      state.reconnectFocusIntent = null;
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
    state.reconnectFocusIntent = null;
    state.reconnectOwnerTerminalId = '';
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
  document.addEventListener('pointerdown', () => { state.userFocusRevision += 1; }, true);
  document.addEventListener('keydown', () => { state.userFocusRevision += 1; }, true);
  document.addEventListener('focusin', event => {
    // Removing the focused xterm host can move focus to the document body.
    // That passive browser fallback is part of reconnect, not a user choice.
    if (event.target === document.body
      || event.target === document.documentElement
      || event.target?.isConnected === false
      || event.target === state.reconnectFocusIntent?.origin) return;
    state.userFocusRevision += 1;
  }, true);
  window.addEventListener('blur', () => {
    queueMicrotask(() => {
      // Chromium emits a window blur while removing the focused xterm
      // textarea even though the document itself keeps focus. Only a real
      // window departure may cancel the reconnect focus intent.
      const documentFocused = typeof document.hasFocus !== 'function' || document.hasFocus();
      if (documentFocused) return;
      state.userFocusRevision += 1;
    });
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') state.userFocusRevision += 1;
  }, true);
  window.addEventListener('loadtoagent:terminal-reconnect-focus', event => {
    captureReconnectFocus(event.detail?.terminalId);
  });
  window.addEventListener('loadtoagent:terminal-reconnect-owner', event => {
    const terminalId = String(event.detail?.terminalId || '');
    const currentViewport = viewport();
    const host = [...(currentViewport?.children || [])].find(child => (
      String(child?.dataset?.terminalScreen || '') === terminalId
    ));
    if (!terminalId
      || event.detail?.mountId !== 'drawerTerminalViewport'
      || state.target?.kind !== 'terminal'
      || targetIdOf(state.target) !== terminalId
      || !drawerSessionVisible(state.session?.id, currentViewport)
      || !host
      || host.parentElement !== currentViewport) return;
    state.reconnectOwnerTerminalId = terminalId;
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
        const ownsReconnect = state.reconnectOwnerTerminalId === terminalId;
        state.reconnectOwnerTerminalId = '';
        if (!ownsReconnect || !drawerSessionVisible(state.session.id)) return;
        const reconnectSessionId = String(state.session.id || '');
        const focusIntent = state.reconnectFocusIntent?.sessionId === reconnectSessionId
          && state.reconnectFocusIntent?.terminalId === terminalId
          ? state.reconnectFocusIntent
          : null;
        setTimeout(async () => {
          const currentSession = state.session;
          if (!currentSession || currentSession.id !== reconnectSessionId) {
            if (state.reconnectFocusIntent === focusIntent) state.reconnectFocusIntent = null;
            return;
          }
          // Match renderDrawer's key so its scheduled refresh adopts this
          // authoritative reconnect instead of starting a competing mount.
          await mount(currentSession, {
            force: true,
            targetId: terminalId,
            createIfMissing: true,
          });
          restoreReconnectFocus(focusIntent);
        }, 0);
      } else if (!terminal || ['stopped', 'exited', 'failed'].includes(terminal.status)) {
        markUnavailable(state.session.id, terminalId, terminal?.status || 'removed');
        state.connectionFailures.set(state.session.id, {
          reason: terminal?.status || 'removed',
          message: terminal?.statusDetail || t('drawer.terminal_unavailable'),
          signature: state.connectionSignature || connectionSignature(state.session),
        });
        state.generation += 1;
        state.pendingMountKey = '';
        state.reconnectFocusIntent = null;
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
