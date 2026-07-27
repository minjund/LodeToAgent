'use strict';

class AttentionNotifier {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.Notification = options.Notification;
    this.isSupported = options.isSupported || (() => Boolean(this.Notification));
    this.copy = options.copy || (() => ({ title: '내 확인이 필요합니다', body: '응답이나 선택을 기다리는 AI 세션이 있습니다.' }));
    this.onOpen = options.onOpen || (() => {});
    this.onFallback = options.onFallback || (() => {});
    this.attentionIds = null;
    this.notifications = new Set();
  }

  sync(snapshot) {
    if (!this.enabled) return [];
    const needsAttention = (snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [])
      .filter(session => session && session.id && (
        session.attention?.actionable
        || session.attention?.required
        || session.health?.level === 'critical'
        || session.status === 'waiting'
      ));
    const nextIds = new Set(needsAttention.map(session => String(session.id)));

    if (this.attentionIds === null) {
      this.attentionIds = nextIds;
      return [];
    }

    const newlyActionable = needsAttention.filter(session => !this.attentionIds.has(String(session.id)));
    this.attentionIds = nextIds;
    newlyActionable.forEach(session => this.notify(session));
    return newlyActionable.map(session => String(session.id));
  }

  notify(session) {
    if (!this.enabled) return null;
    let supported = false;
    try {
      supported = Boolean(this.Notification && this.isSupported());
    } catch (_supportProbeFailure) {
      supported = false;
    }
    if (!supported) {
      this.onFallback(session);
      return null;
    }
    try {
      const copy = this.copy(session) || {};
      const notification = new this.Notification({
        title: String(copy.title || '내 확인이 필요합니다'),
        body: String(copy.body || session.title || 'AI 세션이 응답을 기다리고 있습니다.'),
        silent: false,
      });
      this.notifications.add(notification);
      notification.once('click', () => this.onOpen(session));
      notification.once('close', () => this.notifications.delete(notification));
      notification.show();
      return notification;
    } catch (_notificationFailure) {
      this.onFallback(session);
      return null;
    }
  }

  dispose() {
    for (const notification of this.notifications) {
      try { notification.close(); } catch {}
    }
    this.notifications.clear();
  }
}

module.exports = { AttentionNotifier };
