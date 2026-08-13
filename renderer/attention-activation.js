(function exposeAttentionActivation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WhiteboxAttentionActivation = api;
})(typeof window !== 'undefined' ? window : globalThis, function createAttentionActivationApi() {
  'use strict';

  function text(value, limit = 1_000) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, limit);
  }

  function normalize(value = {}) {
    const activationId = text(value.activationId || value.id, 1_000);
    if (!activationId) return null;
    return {
      activationId,
      cancelled: value.cancelled === true,
      source: text(value.source, 80),
      provider: text(value.provider, 80).toLowerCase(),
      sessionId: text(value.sessionId, 512),
      rawSessionId: text(value.rawSessionId, 512),
      agentId: text(value.agentId, 512),
      targetId: text(value.targetId, 512),
      terminalId: text(value.terminalId, 512),
      deliveryToken: text(value.deliveryToken, 120),
      preservePopupFocus: value.preservePopupFocus === true,
    };
  }

  function createAttentionActivationController(options = {}) {
    const pending = new Map();
    let sequence = 0;

    const report = (scope, error) => {
      try { options.onError?.(scope, error); } catch {}
    };

    const sessionFor = activation => {
      const sessions = options.getSessions?.() || [];
      const preferredId = activation.agentId || activation.sessionId;
      const fallbackId = activation.agentId ? '' : activation.rawSessionId;
      return sessions.find(session => {
        if (activation.provider && String(session?.provider || '').toLowerCase() !== activation.provider) return false;
        const ids = [session?.id, session?.externalId].map(String);
        return (preferredId && ids.includes(preferredId)) || (fallbackId && ids.includes(fallbackId));
      }) || null;
    };

    const isCurrent = entry => pending.get(entry.activation.activationId) === entry;

    const acknowledge = async (entry, status) => {
      if (!isCurrent(entry) || entry.acknowledging) return false;
      entry.ackStatus = status;
      entry.acknowledging = true;
      try {
        const result = await options.acknowledge?.({
          activationId: entry.activation.activationId,
          deliveryToken: entry.activation.deliveryToken,
          status,
        });
        if (!isCurrent(entry)) return false;
        const accepted = result === true || result?.acknowledged === true;
        if (accepted) pending.delete(entry.activation.activationId);
        return accepted;
      } catch (error) {
        report('attention-activation-ack', error);
        return false;
      } finally {
        entry.acknowledging = false;
      }
    };

    const showSession = (entry, session) => {
      if (entry.contextShown) return;
      entry.contextShown = true;
      try { options.showSession?.(session, entry.activation); } catch (error) {
        report('attention-activation-show-session', error);
      }
    };

    const latest = () => [...pending.values()].sort((left, right) => right.order - left.order)[0] || null;

    const attempt = async entry => {
      if (!isCurrent(entry)) return;
      if (entry.inFlight) {
        entry.retryQueued = true;
        return;
      }
      if (entry.ackStatus) {
        await acknowledge(entry, entry.ackStatus);
        return;
      }
      entry.inFlight = true;
      entry.retryQueued = false;
      const operationEpoch = entry.operationEpoch;
      const operationCurrent = () => isCurrent(entry) && entry.operationEpoch === operationEpoch;
      try {
      const session = sessionFor(entry.activation);
      if (!session) return;
      if (options.isProviderVisible?.(session.provider) === false) {
        await acknowledge(entry, 'ignored');
        return;
      }
      if (session.parentId || session.sourcePluginId || session.controlCapabilities?.pty === false
        || session.presentation?.conversationSurface === 'transcript') {
        showSession(entry, session);
        await acknowledge(entry, 'opened-session');
        return;
      }

      let outcome = { opened: false, retryable: true };
      try {
        outcome = await options.openPty?.(session, entry.activation, {
          isCurrent: operationCurrent,
        }) || outcome;
      } catch (error) {
        report('attention-activation-open-pty', error);
      }
      if (!operationCurrent()) return;
      if (outcome.opened) {
        await acknowledge(entry, 'opened-pty');
        return;
      }
      showSession(entry, session);
      if (outcome.retryable === false) await acknowledge(entry, 'opened-session');
      } finally {
        entry.inFlight = false;
        if (isCurrent(entry) && entry.retryQueued) {
          entry.retryQueued = false;
          void attempt(entry);
        }
      }
    };

    const retryLatest = () => {
      const entry = latest();
      if (entry) void attempt(entry);
    };

    const handle = value => {
      const activation = normalize(value);
      if (!activation) return { ok: false };
      if (activation.cancelled) {
        const entry = pending.get(activation.activationId);
        if (entry) entry.operationEpoch += 1;
        pending.delete(activation.activationId);
        return { ok: true, cancelled: true };
      }
      const existing = pending.get(activation.activationId);
      if (existing) {
        existing.activation = activation;
        existing.operationEpoch += 1;
        existing.ackStatus = '';
      }
      else {
        for (const entry of pending.values()) entry.operationEpoch += 1;
        pending.clear();
        pending.set(activation.activationId, {
          activation,
          order: ++sequence,
          contextShown: false,
          operationEpoch: 1,
          inFlight: false,
          retryQueued: false,
          acknowledging: false,
          ackStatus: '',
        });
      }
      retryLatest();
      return { ok: true, pending: true };
    };

    const userNavigated = () => {
      for (const entry of pending.values()) {
        entry.operationEpoch += 1;
        entry.ackStatus = 'opened-session';
        void acknowledge(entry, 'opened-session');
      }
    };

    return {
      handle,
      retry: retryLatest,
      userNavigated,
      pendingCount: () => pending.size,
      pendingIds: () => [...pending.keys()],
      dispose: () => {
        for (const entry of pending.values()) entry.operationEpoch += 1;
        pending.clear();
      },
    };
  }

  return { createAttentionActivationController, normalizeAttentionActivation: normalize };
});
