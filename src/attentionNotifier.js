'use strict';

class AttentionNotifier {
  constructor(options = {}) {
    this.Notification = options.Notification;
    this.isSupported = options.isSupported || (() => Boolean(this.Notification));
    this.copy = options.copy || (() => ({ title: '내 확인이 필요합니다', body: '응답이나 선택을 기다리는 AI 세션이 있습니다.' }));
    this.onOpen = options.onOpen || (() => {});
    this.onFallback = options.onFallback || (() => {});
    this.waitingIds = null;
    this.notifications = new Set();
  }

  sync(snapshot) {
    const waiting = (snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [])
      .filter(session => session && session.id && session.status === 'waiting');
    const nextIds = new Set(waiting.map(session => String(session.id)));

    if (this.waitingIds === null) {
      this.waitingIds = nextIds;
      return [];
    }

    const newlyWaiting = waiting.filter(session => !this.waitingIds.has(String(session.id)));
    this.waitingIds = nextIds;
    newlyWaiting.forEach(session => this.notify(session));
    return newlyWaiting.map(session => String(session.id));
  }

  notify(session) {
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
