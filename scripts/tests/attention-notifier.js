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

  test('구조화된 선택 요청과 권한 승인만 확인 필요로 알리고 성공 완료도 한 번 알린다', () => {
    FakeNotification.created = [];
    const disabledFallback = [];
    const disabled = new AttentionNotifier({
      enabled: false,
      Notification: FakeNotification,
      isSupported: () => true,
      onFallback: session => disabledFallback.push(session.id),
    });
    assert.deepEqual(disabled.sync({ sessions: [] }), []);
    assert.deepEqual(disabled.sync({ sessions: [{ id: 'waiting-disabled', status: 'waiting' }] }), []);
    assert.equal(disabled.notify({ id: 'manual-disabled', status: 'waiting' }), null);
    assert.equal(FakeNotification.created.length, 0);
    assert.deepEqual(disabledFallback, []);

    const opened = [];
    const notifier = new AttentionNotifier({
      Notification: FakeNotification,
      isSupported: () => true,
      copy: (session, event) => ({
        title: event === 'completed' ? '작업 완료' : '확인 필요',
        body: `Claude · ${session.title}`,
      }),
      onOpen: (session, event) => opened.push(`${event}:${session.id}`),
    });
    const running = {
      id: 'task-a', provider: 'claude', title: '배포 작업', status: 'running',
      updatedAt: '2026-08-06T01:00:00.000Z', parentId: null,
    };
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:00.000Z', sessions: [running] }), []);

    const inferredQuestion = {
      ...running,
      status: 'waiting',
      attention: {
        category: 'required', source: 'assistant-message', kind: 'decision',
        requestedAt: '2026-08-06T01:00:01.000Z', summary: '배포 환경을 고를까요?',
      },
    };
    const failed = {
      id: 'failed-b', provider: 'codex', title: '검증 실패', status: 'failed',
      attention: { category: 'risk', source: 'observed-status', kind: 'error' },
      health: { level: 'critical' },
    };
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:01.000Z', sessions: [inferredQuestion, failed] }), []);
    assert.equal(FakeNotification.created.length, 0);

    const explicitQuestion = {
      ...inferredQuestion,
      attention: {
        ...inferredQuestion.attention,
        source: 'input-tool',
        requestedAt: '2026-08-06T01:00:02.000Z',
      },
    };
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:02.000Z', sessions: [explicitQuestion] }), ['task-a']);
    assert.deepEqual(FakeNotification.created[0].options, {
      title: '확인 필요', body: 'Claude · 배포 작업', silent: false,
    });
    FakeNotification.created[0].emit('click');
    assert.deepEqual(opened, ['attention:task-a']);
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:03.000Z', sessions: [explicitQuestion] }), []);

    const permission = {
      ...running,
      status: 'running',
      attention: {
        category: 'required', source: 'execution-approval', kind: 'approval',
        requestedAt: '2026-08-06T01:00:04.000Z', summary: '개발 서버 다시 시작',
      },
    };
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:04.000Z', sessions: [permission] }), ['task-a']);
    assert.equal(FakeNotification.created[1].options.title, '확인 필요');

    const completed = {
      ...running,
      status: 'completed',
      completionObserved: true,
      completedAt: '2026-08-06T01:00:05.000Z',
    };
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:05.000Z', sessions: [completed] }), ['task-a']);
    assert.deepEqual(FakeNotification.created[2].options, {
      title: '작업 완료', body: 'Claude · 배포 작업', silent: false,
    });
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:06.000Z', sessions: [completed] }), []);

    const childCompleted = { ...completed, id: 'child-c', parentId: 'task-a' };
    const oldCompleted = { ...completed, id: 'old-d', completedAt: '2026-08-05T01:00:00.000Z' };
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:07.000Z', sessions: [completed, childCompleted, oldCompleted] }), []);
    assert.equal(FakeNotification.created.length, 3);

    const terminalApproval = notifier.notifyExplicitPrompt(running, {
      kind: 'codex-edit-approval', fingerprint: 'edit:one', title: '파일 수정 승인',
    });
    assert.ok(terminalApproval);
    assert.equal(FakeNotification.created[3].options.title, '확인 필요');
    assert.equal(notifier.notifyExplicitPrompt(running, { kind: 'codex-edit-approval', fingerprint: 'edit:one' }), null);
    assert.equal(notifier.notifyExplicitPrompt(running, { kind: 'status-warning', fingerprint: 'warning:one' }), null);

    notifier.dispose();
    assert.equal(FakeNotification.created.every(item => item.closed), true);
  });

  test('시스템 알림을 지원하지 않으면 앱 내 대체 알림 경로를 사용한다', () => {
    const fallback = [];
    const notifier = new AttentionNotifier({
      Notification: FakeNotification,
      isSupported: () => false,
      onFallback: (session, event) => fallback.push(`${event}:${session.id}`),
    });
    notifier.sync({ generatedAt: '2026-08-06T01:00:00.000Z', sessions: [] });
    notifier.sync({
      generatedAt: '2026-08-06T01:00:01.000Z',
      sessions: [{
        id: 'waiting-fallback', status: 'waiting', updatedAt: '2026-08-06T01:00:01.000Z',
        attention: {
          category: 'required', source: 'input-tool', kind: 'input',
          requestedAt: '2026-08-06T01:00:01.000Z', summary: '선택해 주세요.',
        },
      }],
    });
    assert.deepEqual(fallback, ['attention:waiting-fallback']);
  });
}

module.exports = { registerAttentionNotifierTests };
