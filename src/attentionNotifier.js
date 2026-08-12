'use strict';

const ACTIVE_STATUSES = new Set(['starting', 'running', 'waiting']);
const NOTIFIABLE_ATTENTION_SOURCES = new Set(['execution-approval', 'input-tool']);
const STARTUP_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function explicitAttentionFingerprints(session) {
  const attention = session && session.attention || {};
  if (attention.category !== 'required' || !NOTIFIABLE_ATTENTION_SOURCES.has(attention.source)) return [];
  if (attention.requestId) {
    return [...new Set(String(attention.requestId)
      .split('|')
      .map(requestId => requestId.trim())
      .filter(Boolean)
      .map(requestId => `${attention.source}:${requestId}`))];
  }
  return [[
    attention.source,
    attention.requestedAt || session.updatedAt || '',
    attention.summary || '',
  ].join(':')];
}

function explicitAttentionFingerprint(session) {
  return explicitAttentionFingerprints(session)[0] || '';
}

function attentionFingerprintKey(sessionId, fingerprint) {
  return `${sessionId}\u0000${fingerprint}`;
}

function isStartupRecoveryCandidate(session, snapshotAt) {
  const attention = session && session.attention || {};
  if (session.status !== 'waiting' || attention.category !== 'required' || attention.source !== 'input-tool') return false;
  const requestedAt = timestamp(attention.requestedAt) || timestamp(session.updatedAt);
  if (!requestedAt) return false;
  const age = snapshotAt - requestedAt;
  return age >= 0 && age <= STARTUP_RECOVERY_WINDOW_MS;
}

function observedCompletionAt(session) {
  if (!session || session.status !== 'completed' || session.parentId) return 0;
  const hasObservedFlag = Object.prototype.hasOwnProperty.call(session, 'completionObserved');
  if (hasObservedFlag ? !session.completionObserved : !session.runId) return 0;
  return timestamp(session.completedAt || session.endedAt || session.updatedAt);
}

class AttentionNotifier {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.Notification = options.Notification;
    this.isSupported = options.isSupported || (() => Boolean(this.Notification));
    this.copy = options.copy || ((_session, event) => ({
      title: event === 'completed' ? '작업 완료' : '확인 필요',
      body: event === 'completed' ? 'AI 작업이 완료되었습니다.' : '선택 또는 권한 승인을 기다리고 있습니다.',
    }));
    this.onOpen = options.onOpen || (() => {});
    this.onFallback = options.onFallback || (() => {});
    this.attentionFingerprints = null;
    this.notifiedAttentionFingerprints = new Set();
    this.sessionStatuses = null;
    this.lastSnapshotAt = 0;
    this.promptFingerprints = new Set();
    this.notifications = new Set();
  }

  sync(snapshot) {
    if (!this.enabled) return [];
    const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions.filter(Boolean) : [];
    const nextAttention = new Map();
    const nextStatuses = new Map();
    for (const session of sessions) {
      if (!session.id) continue;
      const id = String(session.id);
      const fingerprints = explicitAttentionFingerprints(session);
      if (fingerprints.length) nextAttention.set(id, new Set(fingerprints));
      nextStatuses.set(id, String(session.status || ''));
    }

    const snapshotAt = timestamp(snapshot && snapshot.generatedAt) || Date.now();
    if (this.attentionFingerprints === null || this.sessionStatuses === null) {
      this.attentionFingerprints = nextAttention;
      this.sessionStatuses = nextStatuses;
      this.lastSnapshotAt = snapshotAt;
      for (const [id, fingerprints] of nextAttention) {
        for (const fingerprint of fingerprints) this.rememberAttentionFingerprint(id, fingerprint);
      }
      const recoveredIds = [];
      for (const session of sessions) {
        if (!session.id || !isStartupRecoveryCandidate(session, snapshotAt)) continue;
        this.notify(session, 'attention');
        recoveredIds.push(String(session.id));
      }
      return recoveredIds;
    }

    const notifiedIds = [];
    for (const session of sessions) {
      if (!session.id) continue;
      const id = String(session.id);
      const fingerprints = nextAttention.get(id) || new Set();
      const freshFingerprints = [...fingerprints].filter(fingerprint => (
        !this.notifiedAttentionFingerprints.has(attentionFingerprintKey(id, fingerprint))
      ));
      if (freshFingerprints.length) {
        this.notify(session, 'attention');
        notifiedIds.push(id);
        for (const fingerprint of freshFingerprints) this.rememberAttentionFingerprint(id, fingerprint);
      }

      const completedAt = observedCompletionAt(session);
      const previousStatus = this.sessionStatuses.get(id);
      const transitionedFromActive = ACTIVE_STATUSES.has(previousStatus);
      const completedSinceLastSnapshot = !previousStatus && completedAt > this.lastSnapshotAt;
      if (completedAt && (transitionedFromActive || completedSinceLastSnapshot)) {
        this.notify(session, 'completed');
        notifiedIds.push(id);
      }
    }

    this.attentionFingerprints = nextAttention;
    this.sessionStatuses = nextStatuses;
    this.lastSnapshotAt = snapshotAt;
    return notifiedIds;
  }

  notifyExplicitPrompt(session, prompt = {}) {
    if (!this.enabled || !session || !session.id) return null;
    const kind = String(prompt.kind || '');
    if (!/(?:approval|permission)/i.test(kind)) return null;
    const fingerprint = `${session.id}:${String(prompt.fingerprint || kind)}`;
    if (this.promptFingerprints.has(fingerprint)) return null;
    this.promptFingerprints.add(fingerprint);
    if (this.promptFingerprints.size > 500) this.promptFingerprints.delete(this.promptFingerprints.values().next().value);
    return this.notify({ ...session, notificationDetail: prompt.title || prompt.question || '' }, 'attention');
  }

  rememberAttentionFingerprint(sessionId, fingerprint) {
    this.notifiedAttentionFingerprints.add(attentionFingerprintKey(sessionId, fingerprint));
    if (this.notifiedAttentionFingerprints.size > 2_000) {
      this.notifiedAttentionFingerprints.delete(this.notifiedAttentionFingerprints.values().next().value);
    }
  }

  notify(session, event = 'attention') {
    if (!this.enabled) return null;
    let supported = false;
    try {
      supported = Boolean(this.Notification && this.isSupported());
    } catch (_supportProbeFailure) {
      supported = false;
    }
    if (!supported) {
      this.onFallback(session, event);
      return null;
    }
    try {
      const detail = String(session.notificationDetail || session.attention?.summary || '');
      const copy = this.copy(session, event, detail) || {};
      const notification = new this.Notification({
        title: String(copy.title || (event === 'completed' ? '작업 완료' : '확인 필요')),
        body: String(copy.body || session.title || 'AI 작업 상태가 변경되었습니다.'),
        silent: false,
      });
      this.notifications.add(notification);
      notification.once('click', () => this.onOpen(session, event));
      notification.once('close', () => this.notifications.delete(notification));
      notification.show();
      return notification;
    } catch (_notificationFailure) {
      this.onFallback(session, event);
      return null;
    }
  }

  dispose() {
    for (const notification of this.notifications) {
      try { notification.close(); } catch {}
    }
    this.notifications.clear();
    this.notifiedAttentionFingerprints.clear();
  }
}

module.exports = { AttentionNotifier, explicitAttentionFingerprint, observedCompletionAt };
