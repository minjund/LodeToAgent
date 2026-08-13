'use strict';

/** Connect dashboard agent sessions to live or resumed terminal targets. */
window.WhiteboxTerminalAgentActions = function createModule(context) {
  const t = (key, params) => window.WhiteboxI18n.t(key, params);
  const {
    $, state, init, notice, moveWorkbench, selectTmux, selectSession, bindAgent, queueHistoryRefresh,
    renderTarget, fitEntry, refreshSessions, resumeSupport, resumeLaunchArgs, preferredWorkspace, providerLabel, terminalTypeLabel, esc,
    syncComposer, tmuxTargetKey, ensureSessionTerminal,
  } = context;
  const terminalLabel = typeof terminalTypeLabel === 'function'
    ? terminalTypeLabel
    : terminal => String(terminal?.type || t('terminal.type.terminal'));
  const ensurePromises = new Map();
  let preconnectRefreshPromise = null;
  const MAX_PRECONNECTED_TERMINAL_HOSTS = 8;
  const SHA256_ROUND_CONSTANTS = Object.freeze([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function utf8Bytes(value) {
    const bytes = [];
    const text = String(value == null ? '' : value);
    for (let index = 0; index < text.length; index += 1) {
      let point = text.charCodeAt(index);
      if (point >= 0xd800 && point <= 0xdbff) {
        const low = text.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          point = 0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00);
          index += 1;
        } else point = 0xfffd;
      } else if (point >= 0xdc00 && point <= 0xdfff) point = 0xfffd;
      if (point < 0x80) bytes.push(point);
      else if (point < 0x800) bytes.push(0xc0 | (point >>> 6), 0x80 | (point & 0x3f));
      else if (point < 0x10000) bytes.push(0xe0 | (point >>> 12), 0x80 | ((point >>> 6) & 0x3f), 0x80 | (point & 0x3f));
      else bytes.push(0xf0 | (point >>> 18), 0x80 | ((point >>> 12) & 0x3f), 0x80 | ((point >>> 6) & 0x3f), 0x80 | (point & 0x3f));
    }
    return bytes;
  }

  function rotateRight(value, count) {
    return (value >>> count) | (value << (32 - count));
  }

  function sha256(value) {
    const bytes = utf8Bytes(value);
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const highLength = Math.floor(bitLength / 0x100000000);
    const lowLength = bitLength >>> 0;
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((highLength >>> shift) & 0xff);
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((lowLength >>> shift) & 0xff);
    const hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const words = new Uint32Array(64);
    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        const start = offset + index * 4;
        words[index] = ((bytes[start] << 24) | (bytes[start + 1] << 16)
          | (bytes[start + 2] << 8) | bytes[start + 3]) >>> 0;
      }
      for (let index = 16; index < 64; index += 1) {
        const left = words[index - 15];
        const right = words[index - 2];
        const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
        const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
        words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temporary1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
        const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temporary2 = (sum0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temporary1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temporary1 + temporary2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0;
      hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0;
      hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0;
      hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0;
      hash[7] = (hash[7] + h) >>> 0;
    }
    return hash.map(word => word.toString(16).padStart(8, '0')).join('');
  }

  function agentConnectionSignature(agentSession) {
    const environment = agentSession?.environment || {};
    // Writable conversation identity must remain stable when an unrelated
    // externally discovered tmux pane moves, respawns, or changes cwd. Only
    // the provider's canonical history id and the app bridge identity belong
    // in this signature.
    const canonical = JSON.stringify([
      String(agentSession?.id || ''),
      String(agentSession?.provider || '').toLowerCase(),
      String(agentSession?.externalId || '').trim(),
      String(environment.kind || '').toLowerCase(),
      String(environment.distro || '').trim().toLowerCase(),
    ]);
    return `acs1:${sha256(canonical)}`;
  }

  function connectionSignatures() {
    if (!(state.agentConnectionSignatures instanceof Map)) state.agentConnectionSignatures = new Map();
    return state.agentConnectionSignatures;
  }

  function terminalIdOf(target) {
    return String(target?.terminalId || target?.id || '');
  }

  function normalizedConnectionPath(value, environmentKind = '') {
    const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    const kind = String(environmentKind || '').toLowerCase();
    const caseInsensitive = kind === 'windows' || (!kind && state.platform?.id === 'win32');
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  }

  function terminalConnectionRecord(target) {
    const terminalId = terminalIdOf(target);
    return state.sessions.find(session => session.id === terminalId) || target || null;
  }

  function persistedConnectionSignature(target) {
    return String(terminalConnectionRecord(target)?.agentConnectionSignature || '').trim();
  }

  function legacyResumeIdentityMatches(target, agentSession) {
    const terminal = terminalConnectionRecord(target);
    const resumeSessionId = String(terminal?.agentResumeSessionId || '').trim();
    const bridgeId = String(terminal?.bridgeId || '').trim();
    const environment = agentSession?.environment || {};
    const normalizeEnvironmentKind = value => {
      const kind = String(value || '').trim().toLowerCase();
      if (['darwin', 'mac', 'macos'].includes(kind)) return 'macos';
      if (['win32', 'win', 'windows'].includes(kind)) return 'windows';
      return kind;
    };
    const expectedKind = normalizeEnvironmentKind(environment.kind);
    const expectedDistro = String(environment.distro || '').trim().toLowerCase();
    const linkedSessionId = String(terminal?.agentLinkedSessionId || '').trim();
    if (linkedSessionId) {
      if (linkedSessionId !== String(agentSession?.id || '').trim()) return false;
      if (String(terminal?.agentLinkedExternalId || '').trim() !== String(agentSession?.externalId || '').trim()) return false;
      if (String(terminal?.provider || '').toLowerCase() !== String(agentSession?.provider || '').toLowerCase()) return false;
      if (normalizeEnvironmentKind(terminal?.agentLinkedEnvironment) !== expectedKind) return false;
      const linkedDistro = String(terminal?.agentLinkedDistro || '').trim().toLowerCase();
      if (expectedKind === 'wsl' ? linkedDistro !== expectedDistro : Boolean(linkedDistro)) return false;
      return true;
    }
    if (resumeSessionId) {
      if (resumeSessionId !== String(agentSession?.externalId || '').trim()) return false;
      const provider = String(terminal?.provider || '').toLowerCase();
      if (provider && provider !== String(agentSession?.provider || '').toLowerCase()) return false;
      if (bridgeId && bridgeId !== String(agentSession?.id || '').trim()) return false;
      const distro = String(terminal?.distro || '').trim().toLowerCase();
      const actualKind = distro
        ? 'wsl'
        : (state.platform?.id === 'win32' ? 'windows'
          : (state.platform?.id === 'darwin' ? 'macos' : 'linux'));
      if (expectedKind && expectedKind !== actualKind) return false;
      if (actualKind === 'wsl' && (!expectedDistro || distro !== expectedDistro)) return false;
      if (actualKind !== 'wsl' && distro) return false;
      return true;
    }

    return null;
  }

  function targetMatchesConnection(target, signature, agentSession = null) {
    if (agentSession) return strongAgentTerminalMatches(
      terminalConnectionRecord(target),
      agentSession,
      signature,
    );
    const persisted = persistedConnectionSignature(target);
    if (persisted) return persisted === signature;
    const known = connectionSignatures().get(terminalIdOf(target));
    return Boolean(known && known === signature);
  }

  function bindAgentConnection(agentSession, target) {
    if (!agentSession?.id || !target || target.kind === 'tmux') return false;
    const signature = agentConnectionSignature(agentSession);
    const terminal = terminalConnectionRecord(target);
    if (!strongAgentTerminalMatches(terminal, agentSession, signature)) return false;
    const terminalId = terminalIdOf(target);
    if (!terminalId) return false;
    connectionSignatures().set(terminalId, signature);
    return true;
  }

  function strongAgentTerminalMatches(terminal, agentSession, signature = agentConnectionSignature(agentSession)) {
    if (!terminal || terminal.type !== 'agent') return false;
    if (terminal.backend !== 'direct' || terminal.conversationBound !== true) return false;
    if (String(terminal.bridgeId || '') !== String(agentSession?.id || '')) return false;
    if (String(terminal.provider || '').toLowerCase() !== String(agentSession?.provider || '').toLowerCase()) return false;
    if (legacyResumeIdentityMatches(terminal, agentSession) !== true) return false;
    const persistedSignature = String(terminal.agentConnectionSignature || '').trim();
    // Unsigned legacy bridges are display-only and are retired before a new
    // signed, prompt-free resume PTY is created.
    return Boolean(persistedSignature && persistedSignature === signature);
  }

  function normalizedDeliveryState(result, fallback = 'accepted') {
    if (result?.deliveryState === 'rejected') return 'rejected';
    if (result?.deliveryState === 'unknown') return 'unknown';
    if (result?.deliveryState === 'accepted') return 'accepted';
    return fallback;
  }

  function rejectedError(message, code = 'DELIVERY_REJECTED') {
    const error = new Error(message);
    error.code = code;
    error.deliveryState = 'rejected';
    return error;
  }

  function isCodexDesktopSession(agentSession) {
    return String(agentSession?.provider || '').toLowerCase() === 'codex'
      && String(agentSession?.clientKind || '').toLowerCase() === 'codex-desktop';
  }

  function codexDesktopOriginOwnedError() {
    return rejectedError(
      t('terminal.resume.codex_desktop_live'),
      'CODEX_DESKTOP_SESSION_ORIGIN_OWNED',
    );
  }

  function resultError(result, fallback) {
    const error = new Error(result?.error || fallback);
    error.code = result?.code || 'DELIVERY_REJECTED';
    error.deliveryId = result?.deliveryId || '';
    error.deliveryState = result ? normalizedDeliveryState(result, 'rejected') : 'unknown';
    return error;
  }

  function markRejectedBeforeDelivery(error) {
    const value = error instanceof Error ? error : new Error(String(error || ''));
    if (!value.code) value.code = 'DELIVERY_REJECTED';
    value.deliveryState = 'rejected';
    return value;
  }

  async function initializeBeforeDelivery() {
    try {
      await init();
    } catch (error) {
      throw markRejectedBeforeDelivery(error);
    }
  }

  function reportPostDeliveryError(scope, error) {
    window.WhiteboxRendererUtils?.reportRecoverableError?.(scope, error);
  }

  function nextCreationId() {
    const random = typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
    return `create:${random}`;
  }

  function markCreationError(error, creationId, state = 'unknown') {
    const value = error instanceof Error ? error : new Error(String(error || ''));
    value.creationId = creationId;
    value.creationState = state;
    if (!value.deliveryState) value.deliveryState = state === 'rejected' ? 'rejected' : 'unknown';
    return value;
  }

  function markDeliveryUnknown(error, deliveryId) {
    const value = error instanceof Error ? error : new Error(String(error || t('terminal.agent.send_failed')));
    value.deliveryId = deliveryId;
    value.deliveryState = 'unknown';
    value.retryable = true;
    return value;
  }

  function markCreatedTerminalRetry(error, created, creationId, deliveryId, deliveryState = '') {
    const value = error instanceof Error ? error : new Error(String(error || t('terminal.agent.send_failed')));
    value.creationId = creationId;
    value.creationState = 'accepted';
    value.terminalId = created?.id || '';
    value.deliveryId = value.deliveryId || deliveryId;
    if (deliveryState && !value.deliveryState) value.deliveryState = deliveryState;
    value.retryable = true;
    return value;
  }

  async function createTerminalWithRetry(createOptions, creationId) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await window.whitebox.terminalCreate(createOptions);
        if (!result?.id) {
          if (result?.ok === false) {
            const error = resultError(result, t('terminal.agent.resume_terminal_failed'));
            error.creationState = result.creationState || 'rejected';
            error.creationId = creationId;
            throw error;
          }
          throw new Error(t('terminal.agent.resume_terminal_failed'));
        }
        return result;
      } catch (error) {
        const creationState = String(error?.creationState || '').trim().toLowerCase();
        const deliveryState = String(error?.deliveryState || '').trim().toLowerCase();
        const confirmedRejected = creationState === 'rejected'
          || deliveryState === 'rejected'
          || /^CREATION_/u.test(String(error?.code || ''));
        if (confirmedRejected) throw markCreationError(error, creationId, 'rejected');
        // The host may create the PTY and lose only its RPC response. Reuse
        // the exact same object and creationId once; TerminalManager resolves
        // it to the already-persisted session without spawning again.
        if (attempt === 0) continue;
        throw markCreationError(error, creationId, 'unknown');
      }
    }
    throw markCreationError(new Error(t('terminal.agent.resume_terminal_failed')), creationId, 'unknown');
  }

  async function sendInitialCommandWithRetry(terminalId, prompt, deliveryId) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await window.whitebox.terminalCommand(terminalId, prompt, { deliveryId });
        if (!result) throw new Error(t('terminal.agent.send_failed'));
        if (result.ok === false) throw resultError(result, t('terminal.agent.send_failed'));
        return result;
      } catch (error) {
        const deliveryState = String(error?.deliveryState || '').trim().toLowerCase();
        if (deliveryState === 'rejected') throw error;
        if (deliveryState === 'unknown') throw markDeliveryUnknown(error, deliveryId);
        // The PTY host can disconnect after accepting the command but before
        // the renderer receives its response. Re-enter the command RPC once:
        // TerminalManager's persisted ledger makes the same deliveryId and
        // payload idempotent, while the new RPC reconnects the host transport.
        if (attempt === 0) continue;
        try {
          reportPostDeliveryError('terminal-agent-start-delivery-unknown', error);
        } catch (_reportError) {}
        throw markDeliveryUnknown(error, deliveryId);
      }
    }
    throw markDeliveryUnknown(new Error(t('terminal.agent.send_failed')), deliveryId);
  }

  function deliveryNotice(message, tone = 'success') {
    try {
      notice(message, tone);
    } catch (error) {
      reportPostDeliveryError('terminal-agent-notice', error);
    }
  }

  function emitCommandDelivery(agentSession, target, deliveryState) {
    if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('whitebox:terminal-command-delivery', {
      detail: { sessionId: agentSession.id, target, deliveryState },
    }));
  }

  function tmuxRows(snapshot = state.snapshot) {
    const rows = [];
    for (const distro of snapshot && snapshot.tmux && snapshot.tmux.distros || []) {
      for (const session of distro.sessions || []) {
        for (const windowItem of session.windows || []) {
          for (const pane of windowItem.panes || []) {
            if (!state.suppressedTmuxTargets.has(tmuxTargetKey(distro.name, pane.nativeId))) {
              rows.push({ distro, session, window: windowItem, pane });
            }
          }
        }
      }
    }
    return rows;
  }

  function agentTargets(agentSession) {
    if (!agentSession || !agentSession.id) return [];
    if (agentSession.parentId) return [];
    if (isCodexDesktopSession(agentSession)) return [];
    const targets = [];
    const connectionSignature = agentConnectionSignature(agentSession);
    const blockedTerminalIds = new Set(state.sessions
      .filter(terminal => agentSession.parentId && (terminal.type === 'agent'
        || /sub-agent is controlled by its parent|direct input is disabled/i.test(String(terminal.replay || ''))))
      .map(terminal => terminal.id));
    // Externally discovered tmux panes remain display-only. A provider can
    // switch histories inside the same long-lived process, so pane/PID/cwd
    // metadata cannot authorize writes to one conversation.
    for (const terminal of state.sessions) {
      if (terminal.status !== 'running') continue;
      if (blockedTerminalIds.has(terminal.id)) continue;
      if (!strongAgentTerminalMatches(terminal, agentSession, connectionSignature)) continue;
      targets.push({
        id: terminal.id,
        kind: 'terminal',
        label: terminal.title,
        detail: `${terminalLabel(terminal)} · ${t('session.program_pid', { pid: terminal.pid || '--' })}`,
        terminalId: terminal.id,
        reconnectable: false,
      });
    }
    return [...new Map(targets.map(target => [target.id, target])).values()];
  }

  function requiredAgentTarget(agentSession, targetId = '') {
    const targets = agentTargets(agentSession);
    if (!targets.length) throw rejectedError(t('terminal.agent.no_input_target'));
    let target = null;
    if (targetId) {
      target = targets.find(item => item.id === targetId) || null;
      if (!target) throw rejectedError(t('terminal.agent.target_expired'));
    } else {
      if (targets.length > 1) throw rejectedError(t('terminal.agent.select_target'));
      target = targets[0];
    }
    if (!bindAgentConnection(agentSession, target)) throw rejectedError(t('terminal.agent.target_expired'));
    return target;
  }

  function freshAgentLaunchOptions(options = {}) {
    const provider = String(options.provider || '').trim().toLowerCase();
    const prompt = String(options.prompt || '').trim();
    const model = String(options.model || '').trim();
    const allowWrites = Boolean(options.allowWrites);
    const requestedPermissionMode = String(options.permissionMode || '').trim();
    const args = [];
    if (!['claude', 'codex', 'gemini', 'grok'].includes(provider)) {
      throw rejectedError(t('terminal.resume.unsupported_provider', { provider: providerLabel(provider) }));
    }
    if (!prompt) throw rejectedError(t('terminal.agent.command_required'));

    if (provider === 'claude') {
      if (model) args.push('--model', model);
      const permissionModes = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
      if (requestedPermissionMode && !permissionModes.has(requestedPermissionMode)) {
        throw rejectedError(t('terminal.agent.invalid_permission_mode'));
      }
      if (requestedPermissionMode) args.push('--permission-mode', requestedPermissionMode);
      else if (allowWrites) args.push('--permission-mode', 'acceptEdits');
    } else if (provider === 'codex') {
      if (model) args.push('--model', model);
      args.push('--sandbox', allowWrites ? 'workspace-write' : 'read-only');
    } else if (provider === 'gemini') {
      if (model) args.push('--model', model);
      if (allowWrites) args.push('--yolo');
    } else {
      args.push('--no-auto-update');
      if (model) args.push('--model', model);
      if (allowWrites) args.push('--always-approve');
    }

    let initialCommandInArgs = true;
    if (provider === 'gemini') args.push('--prompt-interactive', prompt);
    else if (provider === 'grok') initialCommandInArgs = false;
    else args.push(prompt);
    return { provider, prompt, args, initialCommandInArgs };
  }

  async function startAgent(options = {}) {
    await initializeBeforeDelivery();
    const cwd = String(options.cwd || preferredWorkspace() || '').trim();
    if (!cwd) throw rejectedError(t('terminal.agent.cwd_missing'));
    const launch = freshAgentLaunchOptions(options);
    const creationId = String(options.creationId || '').trim() || nextCreationId();
    const deliveryId = `start:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
    const titlePrompt = launch.prompt.replace(/\s+/g, ' ').slice(0, 72);
    const createOptions = {
      type: 'agent',
      provider: launch.provider,
      args: launch.args,
      cwd,
      title: `${providerLabel(launch.provider)} · ${titlePrompt}`,
      transient: false,
      // A fresh provider transcript is bound back to this exact app-owned PTY
      // after its first user message is observed. Keep it direct from launch
      // so that later writable conversation identity cannot be switched by an
      // external tmux client.
      sessionBackend: 'direct',
      initialCommand: launch.prompt,
      initialCommandInArgs: launch.initialCommandInArgs,
      creationId,
      deliveryId,
      cols: 120,
      rows: 32,
    };
    const created = await createTerminalWithRetry(createOptions, creationId);

    let delivery = created;
    let deliveryError = null;
    const createdStatus = String(created.status || '').toLowerCase();
    const createdDeliveryState = normalizedDeliveryState(created, '');
    const terminalCanReceivePrompt = !created.creationFailed
      && !created.creationUnavailable
      && (!createdStatus || ['starting', 'running'].includes(createdStatus));
    if (!launch.initialCommandInArgs && createdDeliveryState === 'accepted') {
      delivery = created;
    } else if (!launch.initialCommandInArgs && createdDeliveryState === 'unknown') {
      deliveryError = markCreatedTerminalRetry(
        markDeliveryUnknown(new Error(t('terminal.agent.send_failed')), deliveryId),
        created,
        creationId,
        deliveryId,
        'unknown',
      );
    } else if (!launch.initialCommandInArgs && terminalCanReceivePrompt) {
      try {
        delivery = await sendInitialCommandWithRetry(created.id, launch.prompt, deliveryId);
      } catch (error) {
        const failedDeliveryState = error?.deliveryState || 'unknown';
        delivery = { ...created, deliveryState: failedDeliveryState };
        deliveryError = markCreatedTerminalRetry(
          error,
          created,
          creationId,
          deliveryId,
          failedDeliveryState,
        );
      }
    } else if (!launch.initialCommandInArgs) {
      delivery = { ...created, deliveryState: created.deliveryState || 'rejected' };
    }
    const deliveryState = normalizedDeliveryState(delivery,
      created.creationFailed || (!launch.initialCommandInArgs && !terminalCanReceivePrompt)
        ? 'rejected'
        : (launch.initialCommandInArgs ? 'accepted' : 'unknown'));
    try {
      await refreshSessions();
    } catch (error) {
      try {
        reportPostDeliveryError('terminal-agent-start-refresh', error);
      } catch (_reportError) {}
    }
    let terminalSelected = false;
    let selectionFailure = null;
    try {
      state.mode = 'general';
      if (typeof moveWorkbench === 'function') moveWorkbench('general');
      if (typeof selectSession === 'function') {
        await selectSession(created.id, 'question');
        terminalSelected = true;
      }
    } catch (error) {
      try {
        reportPostDeliveryError('terminal-agent-start-selection', error);
      } catch (_reportError) {}
      const selectionError = new Error(t('terminal.agent.resume_terminal_failed'));
      selectionError.code = 'TERMINAL_START_SELECTION_FAILED';
      selectionError.cause = error;
      selectionFailure = markCreatedTerminalRetry(
        selectionError,
        created,
        creationId,
        deliveryId,
        deliveryState,
      );
    }
    const creationFailed = Boolean(created.creationFailed || created.status === 'failed');
    const creationUnavailable = Boolean(created.creationUnavailable
      || (createdStatus && !['starting', 'running'].includes(createdStatus))
      || created.recoverySkippedReason);
    if (deliveryState !== 'accepted' && (creationFailed || creationUnavailable)) {
      const failedError = new Error(created.error || t('terminal.agent.resume_terminal_failed'));
      failedError.code = created.code || 'TERMINAL_CREATE_FAILED';
      failedError.creationFailed = creationFailed;
      failedError.creationUnavailable = creationUnavailable;
      if (selectionFailure) failedError.selectionError = selectionFailure;
      const retry = markCreatedTerminalRetry(
        failedError,
        created,
        creationId,
        deliveryId,
        deliveryState,
      );
      // A definite rejection can safely rotate the failed creation ID. When
      // delivery is unknown, preserve the accepted ledger identity so a retry
      // cannot race the still-stopping or termination-uncertain process.
      if (deliveryState === 'rejected') retry.creationState = 'failed';
      retry.terminalSelected = terminalSelected;
      throw retry;
    }
    if (deliveryError || deliveryState === 'unknown') {
      const retry = deliveryError || markCreatedTerminalRetry(
        markDeliveryUnknown(new Error(t('terminal.agent.send_failed')), deliveryId),
        created,
        creationId,
        deliveryId,
        'unknown',
      );
      if (selectionFailure) retry.selectionError = selectionFailure;
      retry.terminalSelected = terminalSelected;
      throw retry;
    }
    if (selectionFailure) throw selectionFailure;
    return {
      ok: true,
      runId: created.id,
      terminalId: created.id,
      terminalStatus: created.status || '',
      creationId,
      creationDuplicate: Boolean(created.creationDuplicate),
      creationFailed,
      creationUnavailable,
      error: created.error || '',
      code: created.code || '',
      promptSent: deliveryState === 'accepted',
      deliveryState,
      duplicate: Boolean(delivery?.duplicate || created.creationDuplicate || created.duplicate),
    };
  }

  async function dispatchAgentCommand(agentSession, command, targetId = '', options = {}) {
    await initializeBeforeDelivery();
    const text = String(command || '').trim();
    if (!text) throw rejectedError(t('terminal.agent.command_required'));
    const target = requiredAgentTarget(agentSession, targetId);
    if (target.kind !== 'terminal') throw rejectedError(t('terminal.agent.target_expired'));
    const result = await window.whitebox.terminalCommand(target.terminalId, text, { deliveryId: options.deliveryId || '' });
    if (!result || result.ok === false) throw resultError(result, t('terminal.agent.send_failed'));
    const deliveryState = normalizedDeliveryState(result);
    emitCommandDelivery(agentSession, target, deliveryState);
    deliveryNotice(t(deliveryState === 'unknown'
      ? 'terminal.agent.delivery_uncertain'
      : 'terminal.agent.command_sent', { target: target.label }), deliveryState === 'unknown' ? 'warning' : 'success');
    return {
      ok: true,
      target,
      deliveryState,
      duplicate: Boolean(result.duplicate),
      promptSent: deliveryState === 'accepted',
    };
  }

  async function interruptAgent(agentSession, targetId = '') {
    await initializeBeforeDelivery();
    const target = requiredAgentTarget(agentSession, targetId);
    if (target.kind !== 'terminal') throw rejectedError(t('terminal.agent.interrupt_target_missing'));
    const result = await window.whitebox.terminalSignal(target.terminalId, 'interrupt');
    if (result && result.ok === false) throw new Error(result.error || t('terminal.agent.interrupt_failed'));
    notice(t('terminal.agent.interrupt_sent', { target: target.label }), 'success');
    return { ok: true, target };
  }

  async function openForAgent(agentSession, targetId = '', draft = '', options = {}) {
    if (agentSession?.parentId) throw rejectedError(t('terminal.resume.parent_controlled'));
    const ensureCurrent = () => {
      if (!options.isCurrent || options.isCurrent()) return;
      const error = rejectedError(t('terminal.agent.target_expired'));
      error.code = 'ATTENTION_ACTIVATION_CANCELLED';
      throw error;
    };
    ensureCurrent();
    await init();
    ensureCurrent();
    const target = requiredAgentTarget(agentSession, targetId);
    if (target.kind !== 'terminal') throw rejectedError(t('terminal.agent.target_expired'));
    ensureCurrent();
    if (typeof options.onTargetReady === 'function') {
      await options.onTargetReady(target);
      ensureCurrent();
    }
    state.mode = 'general';
    moveWorkbench('general');
    const selected = await selectSession(target.terminalId, 'question', {
      focus: options.focus !== false,
      isCurrent: options.isCurrent,
      attentionActivation: options.attentionActivation === true,
    });
    if (selected === false) {
      ensureCurrent();
      throw rejectedError(t('terminal.agent.target_expired'));
    }
    ensureCurrent();
    bindAgent(agentSession, target);
    queueHistoryRefresh(agentSession);
    renderTarget();
    const entry = state.terminals.get(target.terminalId);
    fitEntry(entry, target.terminalId);
    const input = $('#terminalCommandInput');
    input.value = String(draft || '');
    state.commandDrafts.set(target.id, input.value);
    syncComposer?.();
    ensureCurrent();
    if (options.focus !== false) input.focus({ preventScroll: true });
    notice(t('terminal.agent.session_kept', { target: target.label }), 'success');
    return target;
  }

  function cleanupFailure(message, cause = null) {
    const error = new Error(message || 'Terminal connection cleanup failed.');
    error.code = 'TERMINAL_CONNECTION_CLEANUP_FAILED';
    error.deliveryState = 'rejected';
    if (cause) error.cause = cause;
    return error;
  }

  function cleanupOperationSucceeded(result) {
    return Boolean(result) && result.ok !== false;
  }

  function terminalStillOwnsRuntime(terminal) {
    if (!terminal) return false;
    return !['stopped', 'exited', 'failed'].includes(String(terminal.status || '').toLowerCase());
  }

  async function retireConnectionTarget(target, scope = 'terminal-agent-connection-cleanup') {
    const terminalId = terminalIdOf(target);
    if (!terminalId) throw cleanupFailure('Terminal connection cleanup target is missing.');
    let closeFailure = null;
    let retired = false;
    if (typeof window.whitebox.terminalRetire === 'function') {
      try {
        const result = await window.whitebox.terminalRetire(terminalId);
        if (!cleanupOperationSucceeded(result)) {
          throw cleanupFailure(result?.error || 'Terminal retirement was rejected.');
        }
        retired = true;
      } catch (error) {
        throw cleanupFailure('Could not retire the superseded terminal connection.', error);
      }
    } else {
      // Compatibility for older fixture/preload implementations. Production
      // exposes terminalRetire, whose promise resolves only after the process
      // tree has exited; close/stop alone cannot provide that acknowledgement.
      try {
        const result = await window.whitebox.terminalClose(terminalId);
        if (!cleanupOperationSucceeded(result)) {
          closeFailure = cleanupFailure(result?.error || 'Terminal close was rejected.');
        } else retired = true;
      } catch (error) {
        closeFailure = error;
      }
      if (!retired) {
        try {
          const result = await window.whitebox.terminalStop?.(terminalId);
          if (!cleanupOperationSucceeded(result)) {
            throw cleanupFailure(result?.error || 'Terminal stop was rejected.', closeFailure);
          }
          retired = true;
        } catch (error) {
          throw cleanupFailure('Could not stop the superseded terminal connection.', error || closeFailure);
        }
      }
    }
    try {
      await refreshSessions();
    } catch (error) {
      throw cleanupFailure('Could not verify the superseded terminal connection cleanup.', error);
    }
    const remaining = state.sessions.find(session => session.id === terminalId) || null;
    if (terminalStillOwnsRuntime(remaining)) {
      throw cleanupFailure('The superseded terminal connection is still active after cleanup.');
    }
    if (!remaining) connectionSignatures().delete(terminalId);
    if (closeFailure) reportPostDeliveryError(`${scope}-close-fallback`, closeFailure);
  }

  async function retireMismatchedConnections(agentSession, signature) {
    const staleConnections = state.sessions.filter(terminal => terminal
      && terminal.type === 'agent'
      && terminal.bridgeId === agentSession.id
      && terminalStillOwnsRuntime(terminal)
      && !strongAgentTerminalMatches(terminal, agentSession, signature));
    for (const terminal of staleConnections) {
      await retireConnectionTarget(terminal, 'terminal-agent-identity-change');
    }
  }

  async function resumeForAgent(agentSession, draft = '', sendDraft = false, options = {}) {
    if (!agentSession?.id) throw rejectedError(t('terminal.resume.no_session_info'));
    if (agentSession.parentId) throw rejectedError(t('terminal.resume.parent_controlled'));
    // Codex Desktop owns the thread through its private app-server. A projected
    // completed/idle/attention state describes only the latest turn and is not
    // evidence that the app-server released its writer, so never start an
    // independent resume for this origin.
    if (isCodexDesktopSession(agentSession)) throw codexDesktopOriginOwnedError();
    await initializeBeforeDelivery();
    const connectionSignature = agentConnectionSignature(agentSession);
    const excludedTerminalIds = new Set((options.excludeTerminalIds || []).map(value => String(value || '')).filter(Boolean));
    let support;
    try {
      support = resumeSupport(agentSession);
    } catch (error) {
      throw markRejectedBeforeDelivery(error);
    }
    if (!support.supported) throw rejectedError(support.reason);
    const cwd = String(agentSession.cwd || preferredWorkspace() || '').trim();
    if (!cwd) throw rejectedError(t('terminal.agent.cwd_missing'));
    const environment = agentSession.environment || {};
    const wslCwd = state.platform.id === 'win32'
      && (environment.kind === 'wsl' || /^\/(?:mnt|home|root|workspace)(?:\/|$)/.test(cwd));
    // A resumed conversation is writable only in the exact persisted WSL
    // environment. Even a single installed distro is not proof of identity;
    // guessing here would create a PTY that the strong matcher must reject.
    const distro = wslCwd ? String(environment.distro || '').trim() : '';
    if (wslCwd && !distro) throw rejectedError(t('terminal.agent.wsl_distro_missing'));
    const prompt = String(draft || '').trim();
    const title = t('terminal.agent.resume_title', {
      provider: providerLabel(agentSession.provider),
      session: agentSession.taskName || agentSession.agentName || t('terminal.type.session'),
    });
    // The drawer can still hold a stale "resume" projection while the terminal
    // created by the previous send is already running. Reuse the explicit
    // bridge target so a delayed receipt cannot spawn a second Claude process
    // for the same session and prompt.
    if (!options.inventoryFresh) {
      try {
        await refreshSessions();
      } catch (error) {
        throw markRejectedBeforeDelivery(error);
      }
    }
    await retireMismatchedConnections(agentSession, connectionSignature);
    const reusable = state.sessions.find(session =>
      session
      && session.type === 'agent'
      && session.provider === support.provider
      && session.bridgeId === agentSession.id
      && session.status === 'running'
      && !excludedTerminalIds.has(session.id)
      && strongAgentTerminalMatches(session, agentSession, connectionSignature)) || null;
    if (reusable) {
      if (!bindAgentConnection(agentSession, { ...reusable, kind: 'terminal', terminalId: reusable.id })) {
        throw rejectedError(t('terminal.agent.target_expired'));
      }
      let deliveryState = sendDraft && prompt ? 'accepted' : '';
      if (sendDraft && prompt) {
        const result = await window.whitebox.terminalCommand(reusable.id, prompt, { deliveryId: options.deliveryId || '' });
        if (!result || result.ok === false) throw resultError(result, t('terminal.agent.send_failed'));
        deliveryState = normalizedDeliveryState(result);
      }
      const target = {
        id: reusable.id,
        kind: 'terminal',
        label: reusable.title || title,
        detail: `${terminalLabel(reusable)} · ${t('session.program_pid', { pid: reusable.pid || '--' })}`,
        terminalId: reusable.id,
      };
      const promptSent = Boolean(sendDraft && prompt && deliveryState === 'accepted');
      if (sendDraft && prompt) emitCommandDelivery(agentSession, target, deliveryState);
      if (options.focus === false) return {
        ...target,
        promptSent,
        deliveryState,
        background: true,
        reused: true,
        terminal: reusable,
      };
      try {
        state.mode = 'general';
        moveWorkbench('general');
        await selectSession(reusable.id);
        bindAgent(agentSession, target);
        queueHistoryRefresh(agentSession);
        renderTarget();
        const input = $('#terminalCommandInput');
        if (input) {
          input.value = promptSent ? '' : String(draft || '');
          state.commandDrafts.set(target.id, input.value);
          syncComposer?.();
          input.focus({ preventScroll: true });
        }
      } catch (error) {
        if (!sendDraft) throw error;
        reportPostDeliveryError('terminal-agent-reused-focus', error);
      }
      deliveryNotice(deliveryState === 'unknown'
        ? t('terminal.agent.delivery_uncertain', { target: target.label })
        : sendDraft && prompt
          ? t('terminal.agent.resumed_and_sent', { provider: providerLabel(agentSession.provider), sessionId: support.sessionId.slice(0, 12) })
          : t('terminal.agent.reconnected', { provider: providerLabel(agentSession.provider), sessionId: support.sessionId.slice(0, 12) }),
      deliveryState === 'unknown' ? 'warning' : 'success');
      return { ...target, promptSent, deliveryState, reused: true };
    }
    // Resume arguments always contain identity only. Every user prompt is
    // delivered through terminalCommand after the prompt-free PTY exists, so
    // shell metacharacters and provider parsing can never reinterpret it.
    const promptInArgs = false;
    let launchArgs;
    let recoveryArgs;
    try {
      launchArgs = resumeLaunchArgs(support);
      recoveryArgs = resumeLaunchArgs(support);
    } catch (error) {
      throw markRejectedBeforeDelivery(error);
    }
    const identityConflict = state.sessions.some(session => session
      && session.type === 'agent'
      && session.provider === support.provider
      && session.bridgeId === agentSession.id
      && session.status === 'running'
      && (excludedTerminalIds.has(session.id) || !strongAgentTerminalMatches(session, agentSession, connectionSignature)));
    const created = await window.whitebox.terminalCreate({
      type: 'agent',
      provider: support.provider,
      args: launchArgs,
      recoveryArgs,
      cwd,
      distro,
      bridgeId: agentSession.id,
      agentConnectionSignature: connectionSignature,
      reuseBridge: !identityConflict,
      initialCommand: sendDraft ? prompt : '',
      initialCommandInArgs: promptInArgs,
      deliveryId: options.deliveryId || '',
      title,
      // Conversation sends must keep the resumed PTY alive. A transient
      // one-shot process can exit after spawn (for example when the session is
      // busy) while the composer incorrectly reports that the prompt was sent.
      transient: false,
      cols: 120,
      rows: 32,
      includeReplay: options.includeReplay !== false,
    });
    if (!created || !created.id) throw new Error(t('terminal.agent.resume_terminal_failed'));
    connectionSignatures().set(created.id, connectionSignature);
    if (!options.skipPostCreateRefresh) {
      try {
        await refreshSessions();
      } catch (error) {
        reportPostDeliveryError('terminal-agent-post-create-refresh', error);
      }
    }
    let deliveryState = normalizedDeliveryState(created, created.promptSent ? 'accepted' : '');
    if (sendDraft && prompt && !created.promptSent && !['accepted', 'unknown'].includes(deliveryState)) {
      const commandResult = await window.whitebox.terminalCommand(created.id, prompt, { deliveryId: options.deliveryId || '' });
      if (!commandResult || commandResult.ok === false) throw resultError(commandResult, t('terminal.agent.send_failed'));
      deliveryState = normalizedDeliveryState(commandResult);
    }
    const target = {
      id: created.id,
      kind: 'terminal',
      label: created.title || title,
      detail: `${terminalLabel(created)} · ${t('session.program_pid', { pid: created.pid || '--' })}`,
      terminalId: created.id,
    };
    const promptSent = Boolean(sendDraft && prompt && deliveryState === 'accepted');
    if (sendDraft && prompt) emitCommandDelivery(agentSession, target, deliveryState);
    if (options.focus === false) return {
      ...target,
      promptSent,
      deliveryState,
      background: true,
      reused: Boolean(created.reused),
      terminal: created,
    };
    try {
      state.mode = 'general';
      moveWorkbench('general');
      await selectSession(created.id);
      bindAgent(agentSession, target);
      queueHistoryRefresh(agentSession);
      renderTarget();
      const input = $('#terminalCommandInput');
      if (input) {
        input.value = promptSent ? '' : String(draft || '');
        state.commandDrafts.set(target.id, input.value);
        syncComposer?.();
        input.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!sendDraft) throw error;
      reportPostDeliveryError('terminal-agent-created-focus', error);
    }
    deliveryNotice(deliveryState === 'unknown'
      ? t('terminal.agent.delivery_uncertain', { target: target.label })
      : sendDraft && prompt
        ? t('terminal.agent.resumed_and_sent', { provider: providerLabel(agentSession.provider), sessionId: support.sessionId.slice(0, 12) })
        : t('terminal.agent.reconnected', { provider: providerLabel(agentSession.provider), sessionId: support.sessionId.slice(0, 12) }),
    deliveryState === 'unknown' ? 'warning' : 'success');
    return { ...target, promptSent, deliveryState, reused: Boolean(created.reused) };
  }

  async function discardSupersededTarget(target) {
    const terminalId = String(target?.terminalId || target?.id || '');
    if (!terminalId || target?.reused) return;
    await retireConnectionTarget(target, 'terminal-agent-superseded');
  }

  function supersededEnsureError() {
    const error = new Error('Terminal connection was superseded by newer session metadata.');
    error.code = 'TERMINAL_ENSURE_SUPERSEDED';
    return error;
  }

  async function waitForWritableTerminal(terminalId, initial = null, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let latest = initial;
    while (Date.now() < deadline) {
      const status = String(latest?.status || '');
      if (status === 'running') return latest;
      if (!latest || ['failed', 'exited', 'stopped'].includes(status)) {
        const error = rejectedError(latest?.statusDetail || t('terminal.agent.resume_terminal_failed'));
        error.code = 'TERMINAL_STARTUP_FAILED';
        throw error;
      }
      if (typeof window.whitebox.terminalGet === 'function') {
        latest = await window.whitebox.terminalGet(terminalId);
      } else {
        await refreshSessions();
        latest = state.sessions.find(item => item.id === terminalId) || null;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const error = rejectedError(t('terminal.agent.resume_terminal_failed'));
    error.code = 'TERMINAL_STARTUP_TIMEOUT';
    throw error;
  }

  async function ensureForAgent(agentSession, options = {}) {
    if (!agentSession?.id) throw rejectedError(t('terminal.resume.no_session_info'));
    if (agentSession.parentId) throw rejectedError(t('terminal.resume.parent_controlled'));
    if (isCodexDesktopSession(agentSession)) throw codexDesktopOriginOwnedError();

    const signature = agentConnectionSignature(agentSession);
    const excludedTerminalIds = new Set((options.excludeTerminalIds || []).map(value => String(value || '')).filter(Boolean));
    const existingTarget = () => agentTargets(agentSession)
      .find(target => target.kind === 'terminal'
        && !excludedTerminalIds.has(String(target.terminalId || target.id || ''))
        && targetMatchesConnection(target, signature, agentSession)) || null;
    const existing = existingTarget();
    if (existing && bindAgentConnection(agentSession, existing)) {
      return { ...existing, reused: true, terminal: terminalConnectionRecord(existing) };
    }

    const pending = ensurePromises.get(agentSession.id);
    if (pending) {
      if (pending.signature === signature) return pending.promise;
      pending.superseded = true;
      try {
        await pending.promise;
      } catch (error) {
        if (error?.code === 'TERMINAL_CONNECTION_CLEANUP_FAILED') throw error;
        // A newer resume identity must get its own attempt even when the older
        // metadata failed to connect.
      }
      return ensureForAgent(agentSession, options);
    }

    const record = { signature, promise: null, superseded: false };
    const task = (async () => {
      const target = await (async () => {
        await initializeBeforeDelivery();
        if (!options.inventoryFresh) {
          try {
            await refreshSessions();
          } catch (error) {
            throw markRejectedBeforeDelivery(error);
          }
        }
        await retireMismatchedConnections(agentSession, signature);
        const refreshed = existingTarget();
        if (refreshed && bindAgentConnection(agentSession, refreshed)) {
          return { ...refreshed, reused: true, terminal: terminalConnectionRecord(refreshed) };
        }

        const support = resumeSupport(agentSession);
        if (!support.supported) throw rejectedError(support.reason || t('terminal.agent.no_input_target'));
        const externalId = String(agentSession.externalId || '').trim();
        const runId = String(agentSession.runId || '').trim();
        if (!externalId || /^process-\d+$/i.test(externalId) || (runId && externalId === runId)) {
          throw rejectedError(t('terminal.resume.no_session_id'));
        }

        // Opening the conversation explicitly hands the provider session to a
        // real PTY. Never forward the drawer draft or an earlier prompt while
        // establishing that terminal; the user must type after xterm connects.
        return resumeForAgent(agentSession, '', false, {
          focus: false,
          excludeTerminalIds: [...excludedTerminalIds],
          inventoryFresh: true,
          includeReplay: options.includeReplay,
          skipPostCreateRefresh: options.skipPostCreateRefresh,
        });
      })();
      if (record.superseded) {
        await discardSupersededTarget(target);
        throw supersededEnsureError();
      }
      return target;
    })().finally(() => {
      if (ensurePromises.get(agentSession.id)?.promise === task) ensurePromises.delete(agentSession.id);
    });
    record.promise = task;
    ensurePromises.set(agentSession.id, record);
    return task;
  }

  async function preconnectForAgents(agentSessions, options = {}) {
    const unique = new Map();
    for (const session of Array.isArray(agentSessions) ? agentSessions : []) {
      if (!session?.id || session.parentId || unique.has(session.id)) continue;
      unique.set(session.id, session);
    }
    const candidates = [...unique.values()];
    if (!candidates.length) return [];
    // Do not initialize the terminal host just to reject a batch containing
    // only Codex Desktop-owned threads.
    if (candidates.every(isCodexDesktopSession)) {
      return candidates.map(() => ({ status: 'rejected', reason: codexDesktopOriginOwnedError() }));
    }
    const shouldStart = typeof options.shouldStart === 'function' ? options.shouldStart : () => true;
    const mayStart = () => {
      try {
        return shouldStart() !== false;
      } catch (_error) {
        return false;
      }
    };
    const cancelledError = () => {
      const error = new Error('Project terminal preconnection was cancelled.');
      error.code = 'TERMINAL_PRECONNECT_CANCELLED';
      return error;
    };

    try {
      const alreadyInitialized = Boolean(state.initialized);
      await initializeBeforeDelivery();
      if (alreadyInitialized) {
        if (!preconnectRefreshPromise) {
          const refresh = Promise.resolve().then(() => refreshSessions());
          const pendingRefresh = refresh.finally(() => {
            if (preconnectRefreshPromise === pendingRefresh) preconnectRefreshPromise = null;
          });
          preconnectRefreshPromise = pendingRefresh;
        }
        await preconnectRefreshPromise;
      }
    } catch (error) {
      return candidates.map(() => ({ status: 'rejected', reason: error }));
    }

    const settled = await Promise.allSettled(candidates.map((session) => {
      if (!mayStart()) return Promise.reject(cancelledError());
      return ensureForAgent(session, {
        focus: false,
        inventoryFresh: true,
        includeReplay: false,
        skipPostCreateRefresh: true,
      });
    }));

    if (typeof ensureSessionTerminal !== 'function') return settled;
    for (let index = 0; index < settled.length && mayStart(); index += 1) {
      const outcome = settled[index];
      if (outcome.status !== 'fulfilled') continue;
      const terminalId = String(outcome.value?.terminalId || outcome.value?.id || '');
      if (!terminalId) continue;
      const alreadyHydrating = Boolean(state.terminals?.has?.(terminalId));
      if (!alreadyHydrating && Number(state.terminals?.size || 0) >= MAX_PRECONNECTED_TERMINAL_HOSTS) continue;
      const terminal = outcome.value?.terminal
        || state.sessions.find(session => session.id === terminalId)
        || { id: terminalId };
      try {
        await ensureSessionTerminal(terminal);
      } catch (error) {
        outcome.hydrationError = error;
      }
    }
    return settled;
  }

  async function resetForAgent(agentSession, options = {}) {
    if (!agentSession?.id) throw rejectedError(t('terminal.resume.no_session_info'));
    if (agentSession.parentId) throw rejectedError(t('terminal.resume.parent_controlled'));
    await init();
    const provider = String(agentSession?.provider || '').toLowerCase();
    if (!['claude', 'codex', 'gemini', 'grok'].includes(provider)) {
      throw new Error(t('terminal.resume.unsupported_provider', { provider: providerLabel(provider) }));
    }
    const cwd = String(agentSession.cwd || preferredWorkspace() || '').trim();
    if (!cwd) throw new Error(t('terminal.agent.cwd_missing'));
    const environment = agentSession.environment || {};
    const wslCwd = state.platform.id === 'win32'
      && (environment.kind === 'wsl' || /^\/(?:mnt|home|root|workspace)(?:\/|$)/.test(cwd));
    const distro = wslCwd
      ? String(environment.distro
        || (state.wslDistros.length === 1 ? state.wslDistros[0] : '')).trim()
      : '';
    if (wslCwd && !distro) throw new Error(t('terminal.agent.wsl_distro_missing'));
    const created = await window.whitebox.terminalCreate({
      type: 'agent',
      provider,
      args: [],
      cwd,
      distro,
      title: t('session.fresh_session_title', { provider: providerLabel(provider) }),
      transient: false,
      cols: 120,
      rows: 32,
    });
    if (!created?.id) throw new Error(t('session.reset_failed'));
    await refreshSessions();
    const target = {
      id: created.id,
      kind: 'terminal',
      label: created.title || providerLabel(provider),
      detail: `${terminalLabel(created)} · ${t('session.program_pid', { pid: created.pid || '--' })}`,
      terminalId: created.id,
    };
    if (options.focus === false) return { ...target, mode: 'new-session' };
    state.mode = 'general';
    moveWorkbench('general');
    await selectSession(created.id);
    renderTarget();
    $('#terminalCommandInput')?.focus({ preventScroll: true });
    return { ...target, mode: 'new-session' };
  }

  return {
    agentConnectionSignature, tmuxRows, agentTargets, requiredAgentTarget, dispatchAgentCommand, interruptAgent,
    freshAgentLaunchOptions, startAgent,
    openForAgent, resumeForAgent, ensureForAgent, preconnectForAgents, bindAgentConnection, resetForAgent,
  };
};
