'use strict';

const TERMINAL_STATUSES = new Set(['opened-pty', 'opened-session', 'ignored']);

function boundedText(value, limit = 1_000) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function normalizeActivation(value = {}) {
  const activationId = boundedText(value.activationId || value.id, 1_000);
  if (!activationId) return null;
  return Object.freeze({
    activationId,
    source: boundedText(value.source, 80),
    provider: boundedText(value.provider, 80).toLowerCase(),
    sessionId: boundedText(value.sessionId, 512),
    rawSessionId: boundedText(value.rawSessionId, 512),
    agentId: boundedText(value.agentId, 512),
    targetId: boundedText(value.targetId, 512),
    terminalId: boundedText(value.terminalId, 512),
    requestId: boundedText(value.requestId, 512),
    preservePopupFocus: value.preservePopupFocus === true,
    event: value.event === 'completed' ? 'completed' : 'attention',
    createdAt: boundedText(value.createdAt, 80),
  });
}

class AttentionActivationCoordinator {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.rendererReadyState = false;
    this.onShow = options.onShow || (() => {});
    this.onDeliver = options.onDeliver || (() => false);
    this.onCancel = options.onCancel || (() => false);
    this.onError = options.onError || (() => {});
    this.maxEntries = Math.max(1, Math.min(512, Number(options.maxEntries) || 96));
    this.tombstoneMs = Math.max(1_000, Number(options.tombstoneMs) || 10 * 60_000);
    this.sequence = 0;
    this.rendererEpoch = 0;
    this.deliverySequence = 0;
    this.entries = new Map();
  }

  report(error, phase, entry = null) {
    try { this.onError(error, { phase, activation: entry?.record || null }); } catch {}
  }

  call(callback, phase, entry) {
    try { return callback(entry.record); } catch (error) {
      this.report(error, phase, entry);
      return false;
    }
  }

  cancel(entry, reason = 'removed') {
    if (!entry || !['pending', 'delivered'].includes(entry.phase)) return;
    try { this.onCancel({
      ...entry.record,
      deliveryToken: entry.deliveryToken || '',
      cancelled: true,
      reason,
    }); } catch (error) {
      this.report(error, 'cancel', entry);
    }
  }

  latestCandidate() {
    return [...this.entries.values()]
      .filter(entry => entry.active && entry.phase === 'pending')
      .sort((left, right) => right.order - left.order)[0] || null;
  }

  deliverLatest() {
    if (!this.enabled || !this.rendererReadyState) return false;
    const entry = this.latestCandidate();
    if (!entry) return false;
    entry.deliveryToken = `${this.rendererEpoch}:${++this.deliverySequence}`;
    let delivered = false;
    try {
      delivered = this.onDeliver({
        ...entry.record,
        deliveryToken: entry.deliveryToken,
      }) !== false;
    } catch (error) {
      this.report(error, 'deliver', entry);
    }
    if (delivered) {
      entry.phase = 'delivered';
      entry.deliveredEpoch = this.rendererEpoch;
    }
    return delivered;
  }

  activate(entry) {
    if (!entry || !this.enabled) return;
    entry.phase = 'pending';
    if (!entry.shown) {
      this.call(this.onShow, 'show', entry);
      entry.shown = true;
    }
    this.deliverLatest();
  }

  supersedeOlder(latest) {
    for (const entry of this.entries.values()) {
      if (!entry.active || entry === latest || !['pending', 'delivered'].includes(entry.phase)) continue;
      this.cancel(entry, 'superseded');
      entry.phase = 'superseded';
    }
  }

  promoteLatestUnhandled() {
    if (!this.enabled) return null;
    const candidates = [...this.entries.values()]
      .filter(entry => entry.active && !entry.handled)
      .sort((left, right) => right.order - left.order);
    const latest = candidates[0] || null;
    if (!latest) return null;
    for (const entry of candidates) {
      if (entry === latest) {
        if (!['pending', 'delivered'].includes(entry.phase)) entry.phase = 'pending';
      } else if (['pending', 'delivered'].includes(entry.phase)) {
        this.cancel(entry, 'superseded');
        entry.phase = 'superseded';
      }
    }
    return latest;
  }

  reconcile(values = []) {
    const incoming = new Map();
    for (const value of Array.isArray(values) ? values.slice(-this.maxEntries) : []) {
      const record = normalizeActivation(value);
      if (record && record.event !== 'completed') incoming.set(record.activationId, record);
    }

    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (incoming.has(id)) continue;
      if (!entry.active) continue;
      this.cancel(entry, 'resolved');
      entry.active = false;
      entry.resolvedAt = now;
      if (!entry.handled) entry.phase = 'resolved';
    }

    const added = [];
    for (const record of incoming.values()) {
      const current = this.entries.get(record.activationId);
      if (current) {
        current.record = record;
        if (!current.active) {
          current.active = true;
          current.resolvedAt = 0;
          if (current.handled) current.phase = 'handled';
          else {
            current.phase = this.enabled ? 'pending' : 'inactive';
            added.push(current);
          }
        }
        continue;
      }
      const entry = {
        record,
        order: ++this.sequence,
        phase: this.enabled ? 'pending' : 'inactive',
        active: true,
        handled: false,
        shown: false,
        deliveredEpoch: 0,
        deliveryToken: '',
        resolvedAt: 0,
      };
      this.entries.set(record.activationId, entry);
      added.push(entry);
    }

    if (this.enabled && added.length) {
      const latest = added[added.length - 1];
      this.supersedeOlder(latest);
      for (const entry of added) {
        if (entry !== latest) entry.phase = 'superseded';
      }
      this.activate(latest);
    } else {
      this.promoteLatestUnhandled();
      this.deliverLatest();
    }
    const expired = [...this.entries.entries()]
      .filter(([, entry]) => !entry.active && now - entry.resolvedAt >= this.tombstoneMs)
      .map(([id]) => id);
    for (const id of expired) this.entries.delete(id);
    if (this.entries.size > this.maxEntries * 2) {
      const removable = [...this.entries.entries()]
        .filter(([, entry]) => !entry.active)
        .sort((left, right) => left[1].resolvedAt - right[1].resolvedAt);
      while (this.entries.size > this.maxEntries * 2 && removable.length) {
        this.entries.delete(removable.shift()[0]);
      }
    }
    return this.snapshot();
  }

  setEnabled(value) {
    const enabled = value === true;
    if (this.enabled === enabled) return this.snapshot();
    this.enabled = enabled;
    if (!enabled) {
      for (const entry of this.entries.values()) {
        if (!entry.active || entry.handled) continue;
        this.cancel(entry, 'disabled');
        entry.phase = 'inactive';
        entry.shown = false;
      }
      return this.snapshot();
    }
    const active = [...this.entries.values()].filter(entry => entry.active && !entry.handled);
    const latest = active.sort((left, right) => right.order - left.order)[0] || null;
    for (const entry of active) entry.phase = entry === latest ? 'pending' : 'superseded';
    this.activate(latest);
    return this.snapshot();
  }

  rendererReady() {
    this.rendererReadyState = true;
    this.rendererEpoch += 1;
    this.deliverLatest();
    return this.snapshot();
  }

  rendererUnavailable() {
    this.rendererReadyState = false;
    for (const entry of this.entries.values()) {
      if (entry.phase === 'delivered') entry.phase = 'pending';
    }
    return this.snapshot();
  }

  acknowledge(value = {}) {
    const activationId = boundedText(value.activationId || value.id, 1_000);
    const status = boundedText(value.status, 80);
    const deliveryToken = boundedText(value.deliveryToken, 120);
    const entry = this.entries.get(activationId);
    if (!entry || !entry.active || !TERMINAL_STATUSES.has(status)
      || !deliveryToken || deliveryToken !== entry.deliveryToken) {
      return { ok: false, acknowledged: false };
    }
    entry.handled = true;
    entry.phase = 'handled';
    this.promoteLatestUnhandled();
    this.deliverLatest();
    return { ok: true, acknowledged: true, activationId, status };
  }

  snapshot() {
    const phases = {};
    for (const entry of this.entries.values()) phases[entry.phase] = (phases[entry.phase] || 0) + 1;
    return {
      enabled: this.enabled,
      rendererReady: this.rendererReadyState,
      count: this.entries.size,
      activeCount: [...this.entries.values()].filter(entry => entry.active).length,
      phases,
    };
  }

  dispose() {
    for (const entry of this.entries.values()) this.cancel(entry, 'disposed');
    this.entries.clear();
    this.rendererReadyState = false;
  }
}

module.exports = { AttentionActivationCoordinator, normalizeActivation };
