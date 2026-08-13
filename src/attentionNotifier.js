'use strict';

const ACTIVE_STATUSES = new Set(['starting', 'running', 'waiting']);
const ACTIVE_DESCENDANT_STATUSES = new Set([...ACTIVE_STATUSES, 'paused']);
const ACTIVE_EXECUTION_STATUSES = new Set(['starting', 'running', 'pending', 'awaiting-approval']);
const TERMINAL_DESCENDANT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'stopped']);
const NOTIFIABLE_ATTENTION_SOURCES = new Set(['execution-approval', 'input-tool']);
const STARTUP_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
// A completed turn can be followed by an automatic continuation several
// seconds later. Hold the toast long enough to observe that next turn instead
// of announcing an intermediate turn as the end of the whole assignment.
const COMPLETION_STABILITY_MS = 8_000;

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

function completionFingerprint(session) {
  const completedAt = observedCompletionAt(session);
  if (!completedAt) return '';
  return `${completedAt}:${String(session.runId || '')}`;
}

function notificationText(value, limit = 240) {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...normalized].slice(0, limit).join('');
}

function completionNotificationSummary(session) {
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  let latestAssistant = null;
  for (let index = messages.length - 1; index > latestUserIndex; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'assistant' && notificationText(message.text)) {
      latestAssistant = message;
      break;
    }
  }
  const candidates = [
    session && session.outcome && session.outcome.summary,
    session && session.result,
    latestAssistant && latestAssistant.text,
  ];
  for (const candidate of candidates) {
    const summary = notificationText(candidate);
    if (summary) return summary;
  }
  return '';
}

function completionContext(sessions) {
  const childIdsByParent = new Map();
  const addChild = (parentId, childId) => {
    const parent = String(parentId || '');
    const child = String(childId || '');
    if (!parent || !child || parent === child) return;
    if (!childIdsByParent.has(parent)) childIdsByParent.set(parent, new Set());
    childIdsByParent.get(parent).add(child);
  };
  for (const session of sessions.values()) {
    addChild(session.parentId, session.id);
    for (const childId of Array.isArray(session.childIds) ? session.childIds : []) addChild(session.id, childId);
    for (const spawn of Array.isArray(session.collaboration && session.collaboration.spawns)
      ? session.collaboration.spawns : []) addChild(session.id, spawn && spawn.childId);
  }
  return { sessions, childIdsByParent };
}

function hasActiveCompletionWork(session, context) {
  if (!session || !context) return false;
  const rootId = String(session.id || '');
  const queue = [rootId];
  const visited = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const current = context.sessions.get(id);
    if (current) {
      if (id !== rootId && ACTIVE_DESCENDANT_STATUSES.has(String(current.status || '').toLowerCase())) return true;
      if ((Array.isArray(current.executions) ? current.executions : [])
        .some(execution => execution && ACTIVE_EXECUTION_STATUSES.has(String(execution.status || '').toLowerCase()))) return true;
      const collaboration = current.collaboration && typeof current.collaboration === 'object'
        ? current.collaboration : {};
      if (Number(collaboration.metrics && collaboration.metrics.currentlyRunning || 0) > 0) return true;
      if ((Array.isArray(collaboration.spawns) ? collaboration.spawns : []).some((spawn) => {
        if (!spawn) return false;
        const status = String(spawn.status || '').toLowerCase();
        if (ACTIVE_DESCENDANT_STATUSES.has(status)) return true;
        const childId = String(spawn.childId || '').trim();
        const child = childId && context.sessions.get(childId);
        const childTerminal = child
          && TERMINAL_DESCENDANT_STATUSES.has(String(child.status || '').toLowerCase());
        return status === 'requested' && Boolean(childId) && !spawn.completedAt && !childTerminal;
      })) return true;
    }
    for (const childId of context.childIdsByParent.get(id) || []) queue.push(childId);
  }
  return false;
}

function completionCandidateFingerprint(session, context) {
  const fingerprint = completionFingerprint(session);
  if (!fingerprint || hasActiveCompletionWork(session, context)) return '';
  return fingerprint;
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
    this.completionStabilityMs = Math.max(0, Number.isFinite(Number(options.completionStabilityMs))
      ? Number(options.completionStabilityMs)
      : COMPLETION_STABILITY_MS);
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.pendingCompletions = new Map();
    this.notifiedCompletionFingerprints = new Set();
    this.completionCandidates = null;
    this.latestSessions = new Map();
    this.notifications = new Set();
  }

  completionKey(sessionId, fingerprint) {
    return `${sessionId}\u0000${fingerprint}`;
  }

  cancelPendingCompletion(sessionId) {
    const id = String(sessionId || '');
    const pending = this.pendingCompletions.get(id);
    if (!pending) return;
    this.pendingCompletions.delete(id);
    if (pending.timer != null) this.clearTimer(pending.timer);
  }

  rememberCompletion(sessionId, fingerprint) {
    this.notifiedCompletionFingerprints.add(this.completionKey(sessionId, fingerprint));
    if (this.notifiedCompletionFingerprints.size > 2_000) {
      this.notifiedCompletionFingerprints.delete(this.notifiedCompletionFingerprints.values().next().value);
    }
  }

  scheduleCompletion(session, context = completionContext(this.latestSessions)) {
    const id = String(session && session.id || '');
    const fingerprint = completionCandidateFingerprint(session, context);
    if (!id || !fingerprint) {
      if (id) this.cancelPendingCompletion(id);
      return false;
    }
    if (this.notifiedCompletionFingerprints.has(this.completionKey(id, fingerprint))) return false;
    const existing = this.pendingCompletions.get(id);
    if (existing && existing.fingerprint === fingerprint) return false;
    this.cancelPendingCompletion(id);
    if (this.completionStabilityMs === 0) {
      this.rememberCompletion(id, fingerprint);
      this.notify(session, 'completed');
      return true;
    }
    const pending = { fingerprint, timer: null };
    this.pendingCompletions.set(id, pending);
    pending.timer = this.setTimer(() => {
      if (this.pendingCompletions.get(id) !== pending) return;
      const current = this.latestSessions.get(id);
      const currentContext = completionContext(this.latestSessions);
      if (completionCandidateFingerprint(current, currentContext) !== fingerprint) {
        this.pendingCompletions.delete(id);
        return;
      }
      this.pendingCompletions.delete(id);
      this.rememberCompletion(id, fingerprint);
      this.notify(current, 'completed');
    }, this.completionStabilityMs);
    if (pending.timer && typeof pending.timer.unref === 'function') pending.timer.unref();
    return false;
  }

  reconcilePendingCompletions(nextSessions, context = completionContext(nextSessions)) {
    for (const [id, pending] of this.pendingCompletions) {
      if (completionCandidateFingerprint(nextSessions.get(id), context) !== pending.fingerprint) {
        this.cancelPendingCompletion(id);
      }
    }
  }

  sync(snapshot) {
    if (!this.enabled) return [];
    const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions.filter(Boolean) : [];
    const nextAttention = new Map();
    const nextStatuses = new Map();
    const nextSessions = new Map();
    for (const session of sessions) {
      if (!session.id) continue;
      const id = String(session.id);
      const fingerprints = explicitAttentionFingerprints(session);
      if (fingerprints.length) nextAttention.set(id, new Set(fingerprints));
      nextStatuses.set(id, String(session.status || ''));
      nextSessions.set(id, session);
    }
    const nextCompletionContext = completionContext(nextSessions);
    const nextCompletionCandidates = new Map([...nextSessions].map(([id, session]) => (
      [id, completionCandidateFingerprint(session, nextCompletionContext)]
    )));
    this.latestSessions = nextSessions;
    this.reconcilePendingCompletions(nextSessions, nextCompletionContext);

    const snapshotAt = timestamp(snapshot && snapshot.generatedAt) || Date.now();
    if (this.attentionFingerprints === null || this.sessionStatuses === null) {
      this.attentionFingerprints = nextAttention;
      this.sessionStatuses = nextStatuses;
      this.completionCandidates = nextCompletionCandidates;
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
      const candidateFingerprint = nextCompletionCandidates.get(id) || '';
      const previousCandidateFingerprint = this.completionCandidates && this.completionCandidates.get(id) || '';
      const activeWorkJustFinished = previousStatus === 'completed'
        && !previousCandidateFingerprint && Boolean(candidateFingerprint);
      if (candidateFingerprint && (transitionedFromActive || completedSinceLastSnapshot || activeWorkJustFinished)) {
        if (this.scheduleCompletion(session, nextCompletionContext)) notifiedIds.push(id);
      }
    }

    this.attentionFingerprints = nextAttention;
    this.sessionStatuses = nextStatuses;
    this.completionCandidates = nextCompletionCandidates;
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
      const detail = event === 'completed'
        ? completionNotificationSummary(session)
        : String(session.notificationDetail || session.attention?.summary || '');
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
    for (const id of [...this.pendingCompletions.keys()]) this.cancelPendingCompletion(id);
    for (const notification of this.notifications) {
      try { notification.close(); } catch {}
    }
    this.notifications.clear();
    this.notifiedAttentionFingerprints.clear();
    this.notifiedCompletionFingerprints.clear();
    this.completionCandidates = null;
    this.latestSessions.clear();
  }
}

module.exports = {
  AttentionNotifier,
  completionNotificationSummary,
  explicitAttentionFingerprint,
  observedCompletionAt,
};
