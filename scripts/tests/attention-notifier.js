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

  test('구조화된 입력·권한 요청과 성공 완료를 중복 없이 알리고 시작 시 미해결 입력 요청만 복구한다', () => {
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
      copy: (session, event, detail) => ({
        title: event === 'completed' ? '작업 완료' : '확인 필요',
        body: detail || `Claude · ${session.title}`,
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
    assert.equal(FakeNotification.created.length, 0, '문장 휴리스틱 질문은 시스템 알림을 울리면 안 됩니다.');
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:01.500Z', sessions: [inferredQuestion, failed] }), []);

    const explicitQuestion = {
      ...inferredQuestion,
      attention: {
        ...inferredQuestion.attention,
        source: 'input-tool',
        requestId: 'request-user-input-1',
        requestedAt: '2026-08-06T01:00:02.000Z',
      },
    };
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:02.000Z', sessions: [explicitQuestion] }), ['task-a']);
    assert.deepEqual(FakeNotification.created[0].options, {
      title: '확인 필요', body: '배포 환경을 고를까요?', silent: false,
    });
    FakeNotification.created[0].emit('click');
    assert.deepEqual(opened, ['attention:task-a']);
    assert.deepEqual(notifier.sync({
      generatedAt: '2026-08-06T01:00:03.000Z',
      sessions: [{
        ...explicitQuestion, updatedAt: '2026-08-06T01:00:03.000Z',
        attention: { ...explicitQuestion.attention, requestedAt: '2026-08-06T01:00:03.000Z', summary: '배포 환경을 지금 선택해 주세요.' },
      }],
    }), [], '같은 requestId는 로그 갱신 시각이 바뀌어도 다시 알리지 않아야 합니다.');

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
    const metadataOnlyCompleted = {
      ...completed, id: 'empty-e', runId: 'managed-empty', completionObserved: false,
      completedAt: '2026-08-06T01:00:06.500Z',
    };
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:07.000Z', sessions: [completed, childCompleted, oldCompleted, metadataOnlyCompleted] }), []);
    assert.equal(FakeNotification.created.length, 3);

    const terminalApproval = notifier.notifyExplicitPrompt({
      ...running,
      attention: { category: 'required', source: 'execution-approval', summary: '일반 승인 요약' },
    }, {
      kind: 'codex-edit-approval', fingerprint: 'edit:one', title: '파일 수정 승인',
    });
    assert.ok(terminalApproval);
    assert.deepEqual(FakeNotification.created[3].options, {
      title: '확인 필요', body: '파일 수정 승인', silent: false,
    });
    assert.equal(notifier.notifyExplicitPrompt(running, { kind: 'codex-edit-approval', fingerprint: 'edit:one' }), null);
    assert.equal(notifier.notifyExplicitPrompt(running, { kind: 'status-warning', fingerprint: 'warning:one' }), null);

    const snapshotFirst = new AttentionNotifier({ Notification: FakeNotification, isSupported: () => true });
    const permissionWithId = {
      ...permission,
      attention: { ...permission.attention, requestId: 'permission-shared-key' },
    };
    snapshotFirst.sync({ generatedAt: '2026-08-06T01:01:00.000Z', sessions: [running] });
    const beforeSnapshotFirst = FakeNotification.created.length;
    assert.deepEqual(snapshotFirst.sync({ generatedAt: '2026-08-06T01:01:01.000Z', sessions: [permissionWithId] }), ['task-a']);
    assert.ok(snapshotFirst.notifyExplicitPrompt(permissionWithId, {
      kind: 'codex-edit-approval', fingerprint: 'pty-permission-shared-key', title: '파일 수정 승인',
    }));
    assert.equal(FakeNotification.created.length, beforeSnapshotFirst + 2, '셸 권한 요청 뒤의 별도 파일 수정 승인을 놓치면 안 됩니다.');

    const promptFirst = new AttentionNotifier({ Notification: FakeNotification, isSupported: () => true });
    promptFirst.sync({ generatedAt: '2026-08-06T01:02:00.000Z', sessions: [running] });
    const beforePromptFirst = FakeNotification.created.length;
    assert.ok(promptFirst.notifyExplicitPrompt(running, {
      kind: 'codex-edit-approval', fingerprint: 'pty-permission-shared-key', title: '파일 수정 승인',
    }));
    assert.deepEqual(promptFirst.sync({ generatedAt: '2026-08-06T01:02:01.000Z', sessions: [permissionWithId] }), ['task-a']);
    assert.equal(FakeNotification.created.length, beforePromptFirst + 2, '파일 수정 승인 뒤의 별도 셸 권한 요청을 놓치면 안 됩니다.');
    const followupPermission = {
      ...permissionWithId,
      attention: { ...permissionWithId.attention, requestId: 'permission-followup-key' },
    };
    assert.deepEqual(promptFirst.sync({ generatedAt: '2026-08-06T01:02:02.000Z', sessions: [followupPermission] }), ['task-a']);
    assert.equal(FakeNotification.created.length, beforePromptFirst + 3, '같은 세션의 다음 셸 권한 요청을 억제하면 안 됩니다.');

    const multipleInputs = new AttentionNotifier({ Notification: FakeNotification, isSupported: () => true });
    multipleInputs.sync({ generatedAt: '2026-08-06T01:03:00.000Z', sessions: [running] });
    const beforeMultipleInputs = FakeNotification.created.length;
    const firstInput = {
      ...explicitQuestion,
      attention: { ...explicitQuestion.attention, requestId: 'input-1' },
    };
    assert.deepEqual(multipleInputs.sync({ generatedAt: '2026-08-06T01:03:01.000Z', sessions: [firstInput] }), ['task-a']);
    assert.deepEqual(multipleInputs.sync({
      generatedAt: '2026-08-06T01:03:02.000Z',
      sessions: [{ ...firstInput, attention: { ...firstInput.attention, requestId: 'input-1|input-2' } }],
    }), ['task-a'], '새로 추가된 입력 요청은 한 번 알려야 합니다.');
    assert.deepEqual(multipleInputs.sync({
      generatedAt: '2026-08-06T01:03:03.000Z',
      sessions: [{ ...firstInput, attention: { ...firstInput.attention, requestId: 'input-2' } }],
    }), [], '기존 입력 요청의 해결로 pending 집합이 줄어들 때 다시 알리면 안 됩니다.');
    assert.equal(FakeNotification.created.length, beforeMultipleInputs + 2);
    snapshotFirst.dispose();
    promptFirst.dispose();
    multipleInputs.dispose();

    notifier.dispose();
    assert.equal(FakeNotification.created.every(item => item.closed), true);

    FakeNotification.created = [];
    const startup = new AttentionNotifier({
      Notification: FakeNotification,
      isSupported: () => true,
      copy: (_session, _event, detail) => ({ title: '복구된 요청', body: detail }),
    });
    const recentInput = {
      id: 'startup-input', status: 'waiting', updatedAt: '2026-08-05T01:00:00.000Z',
      attention: {
        category: 'required', source: 'input-tool', kind: 'input',
        requestedAt: '2026-08-05T01:00:00.000Z', summary: '시작 전에 선택해 주세요.',
      },
    };
    const updatedAtFallback = {
      ...recentInput, id: 'startup-updated-at', updatedAt: '2026-08-05T23:00:00.000Z',
      attention: { ...recentInput.attention, requestedAt: '', summary: '복구 후 값을 입력해 주세요.' },
    };
    const oldInput = {
      ...recentInput, id: 'startup-old',
      attention: { ...recentInput.attention, requestedAt: '2026-08-05T00:59:59.999Z' },
    };
    const inferredAtStartup = {
      ...recentInput, id: 'startup-inferred',
      attention: { ...recentInput.attention, source: 'assistant-message' },
    };
    const completedAtStartup = {
      id: 'startup-completed', status: 'completed', completionObserved: true,
      completedAt: '2026-08-06T00:59:00.000Z', updatedAt: '2026-08-06T00:59:00.000Z',
    };
    const startupSnapshot = {
      generatedAt: '2026-08-06T01:00:00.000Z',
      sessions: [recentInput, updatedAtFallback, oldInput, inferredAtStartup, completedAtStartup],
    };
    assert.deepEqual(startup.sync(startupSnapshot), ['startup-input', 'startup-updated-at']);
    assert.deepEqual(FakeNotification.created.map(item => item.options.body), [
      '시작 전에 선택해 주세요.', '복구 후 값을 입력해 주세요.',
    ]);
    assert.deepEqual(startup.sync(startupSnapshot), [], '시작 복구 알림은 같은 요청에 한 번만 보내야 합니다.');
    assert.equal(FakeNotification.created.length, 2);
    startup.dispose();
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
