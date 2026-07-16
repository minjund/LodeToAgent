'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { AttentionNotifier } = require('../../src/attentionNotifier');

class FakeNotification extends EventEmitter {
  static created = [];

  constructor(options) {
    super();
    this.options = options;
    this.shown = false;
    this.closed = false;
    FakeNotification.created.push(this);
  }

  show() { this.shown = true; }
  close() { this.closed = true; this.emit('close'); }
}

function registerAttentionNotifierTests(context) {
  const { test } = context;

  test('확인 대기 세션은 최초 실행 때 울리지 않고 새 전환마다 한 번만 알린다', () => {
    FakeNotification.created = [];
    const opened = [];
    const notifier = new AttentionNotifier({
      Notification: FakeNotification,
      isSupported: () => true,
      copy: session => ({ title: '내 확인이 필요합니다', body: `Claude · ${session.title}` }),
      onOpen: session => opened.push(session.id),
    });
    const waiting = { id: 'waiting-a', provider: 'claude', title: '배포 승인', status: 'waiting' };
    const second = { id: 'waiting-b', provider: 'claude', title: '파일 변경 승인', status: 'waiting' };

    assert.deepEqual(notifier.sync({ sessions: [waiting] }), []);
    assert.deepEqual(notifier.sync({ sessions: [waiting] }), []);
    assert.deepEqual(notifier.sync({ sessions: [waiting, second] }), ['waiting-b']);
    assert.equal(FakeNotification.created.length, 1);
    assert.equal(FakeNotification.created[0].shown, true);
    assert.deepEqual(FakeNotification.created[0].options, {
      title: '내 확인이 필요합니다', body: 'Claude · 파일 변경 승인', silent: false,
    });
    FakeNotification.created[0].emit('click');
    assert.deepEqual(opened, ['waiting-b']);

    notifier.sync({ sessions: [] });
    assert.deepEqual(notifier.sync({ sessions: [second] }), ['waiting-b']);
    assert.equal(FakeNotification.created.length, 2);
    notifier.dispose();
    assert.equal(FakeNotification.created.every(item => item.closed), true);
  });

  test('시스템 알림을 지원하지 않으면 앱 내 대체 알림 경로를 사용한다', () => {
    const fallback = [];
    const notifier = new AttentionNotifier({
      Notification: FakeNotification,
      isSupported: () => false,
      onFallback: session => fallback.push(session.id),
    });
    notifier.sync({ sessions: [] });
    notifier.sync({ sessions: [{ id: 'waiting-fallback', status: 'waiting' }] });
    assert.deepEqual(fallback, ['waiting-fallback']);
  });
}

module.exports = { registerAttentionNotifierTests };
