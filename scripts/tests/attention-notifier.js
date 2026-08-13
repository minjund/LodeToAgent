'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { AttentionNotifier, completionNotificationSummary } = require('../../src/attentionNotifier');

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
      completionStabilityMs: 0,
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
      outcome: { summary: '  배포와\n검증을\u0000 완료했습니다.  ' },
      result: '결과 fallback은 outcome보다 뒤여야 합니다.',
      messages: [{ role: 'assistant', text: '메시지 fallback도 outcome보다 뒤여야 합니다.' }],
    };
    assert.deepEqual(notifier.sync({ generatedAt: '2026-08-06T01:00:05.000Z', sessions: [completed] }), ['task-a']);
    assert.deepEqual(FakeNotification.created[2].options, {
      title: '작업 완료', body: '배포와 검증을 완료했습니다.', silent: false,
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

    FakeNotification.created = [];
    const summaries = new AttentionNotifier({
      Notification: FakeNotification,
      isSupported: () => true,
      copy: (_session, _event, detail) => ({ title: '작업 완료', body: detail || 'AI 최종 답변 없음' }),
    });
    summaries.notify({
      title: '사용자 요청',
      outcome: { summary: '   ' },
      result: '  실제\t최종\u0007 답변  ',
      messages: [{ role: 'assistant', text: '이전 답변' }],
    }, 'completed');
    summaries.notify({
      title: '사용자 요청', result: '',
      messages: [
        { role: 'assistant', text: '이전 답변' },
        { role: 'assistant', text: '\n\t' },
        { role: 'assistant', text: `최신 답변 ${'가'.repeat(260)}` },
      ],
    }, 'completed');
    summaries.notify({ title: '  사용자\n요청  ', messages: [] }, 'completed');
    summaries.notify({
      title: '사용자 요청', outcome: { summary: '완료 요약' },
      notificationDetail: '직접 승인', attention: { summary: '기존 승인 요약' },
    }, 'attention');
    assert.equal(FakeNotification.created[0].options.body, '실제 최종 답변', 'result를 outcome 다음 fallback으로 사용해야 합니다.');
    assert.equal(FakeNotification.created[1].options.body, `최신 답변 ${'가'.repeat(234)}`,
      '최신 non-empty assistant 답변을 사용하고 240자로 제한해야 합니다.');
    assert.equal([...FakeNotification.created[1].options.body].length, 240);
    assert.equal(completionNotificationSummary({ title: '사용자 요청', messages: [] }), '',
      'AI 답변이 없을 때 사용자 요청 title을 완료 detail로 재사용하면 안 됩니다.');
    assert.equal(completionNotificationSummary({
      title: '새 사용자 요청',
      messages: [
        { role: 'assistant', text: '직전 턴 답변' },
        { role: 'user', text: '새 사용자 요청' },
      ],
    }), '', '마지막 사용자 요청보다 앞선 assistant 답변을 새 완료 detail로 재사용하면 안 됩니다.');
    assert.equal(FakeNotification.created[2].options.body, 'AI 최종 답변 없음');
    assert.equal(FakeNotification.created[3].options.body, '직접 승인', 'attention 본문 선택은 기존 동작을 유지해야 합니다.');
    summaries.dispose();
  });

  test('새 메인 턴이 시작되면 직전 턴의 순간적인 완료 알림 후보를 취소한다', () => {
    FakeNotification.created = [];
    const timers = [];
    const notifier = new AttentionNotifier({
      Notification: FakeNotification,
      isSupported: () => true,
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, cancelled: false, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeout: timer => { timer.cancelled = true; },
    });
    const running = {
      id: 'codex:main-turn-race', provider: 'codex', title: '메인 작업', status: 'running',
      completionObserved: false, completedAt: null, parentId: null,
      updatedAt: '2026-08-13T01:46:38.000Z',
    };
    const childRunning = {
      ...running, id: 'codex:child-turn', title: '하위 작업', parentId: running.id,
    };
    assert.deepEqual(notifier.sync({
      generatedAt: '2026-08-13T01:46:38.000Z', sessions: [running, childRunning],
    }), []);

    const childCompleted = {
      ...childRunning, status: 'completed', completionObserved: true,
      completedAt: '2026-08-13T01:46:39.000Z', updatedAt: '2026-08-13T01:46:39.000Z',
    };
    assert.deepEqual(notifier.sync({
      generatedAt: '2026-08-13T01:46:39.100Z', sessions: [running, childCompleted],
    }), []);
    assert.equal(timers.length, 0, '하위 에이전트 완료는 메인 완료 후보로 등록하면 안 됩니다.');
    assert.equal(FakeNotification.created.length, 0);

    const transientCompletion = {
      ...running, status: 'completed', completionObserved: true,
      completedAt: '2026-08-13T01:46:39.443Z', updatedAt: '2026-08-13T01:46:39.443Z',
    };
    assert.deepEqual(notifier.sync({
      generatedAt: '2026-08-13T01:46:39.500Z', sessions: [transientCompletion, childCompleted],
    }), []);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 8_000, '자동 후속 턴이 이어질 시간을 기다린 뒤에만 완료를 알려야 합니다.');
    assert.equal(FakeNotification.created.length, 0, '첫 completed 관측만으로 알림을 보내면 안 됩니다.');

    const nextTurnRunning = {
      ...running, updatedAt: '2026-08-13T01:46:39.639Z',
    };
    assert.deepEqual(notifier.sync({
      generatedAt: '2026-08-13T01:46:39.800Z', sessions: [nextTurnRunning, childCompleted],
    }), []);
    assert.equal(timers[0].cancelled, true, '새 턴 시작 시 보류 중인 완료 후보를 취소해야 합니다.');
    timers[0].callback();
    assert.equal(FakeNotification.created.length, 0, '취소된 완료 후보가 뒤늦게 알림을 보내면 안 됩니다.');

    const stableCompletion = {
      ...running, status: 'completed', completionObserved: true,
      completedAt: '2026-08-13T01:47:00.000Z', updatedAt: '2026-08-13T01:47:00.000Z',
    };
    assert.deepEqual(notifier.sync({
      generatedAt: '2026-08-13T01:47:00.100Z', sessions: [stableCompletion],
    }), []);
    assert.equal(timers.length, 2);
    timers[1].callback();
    assert.equal(FakeNotification.created.length, 1, '안정적으로 완료된 메인 작업은 한 번 알려야 합니다.');
    assert.equal(FakeNotification.created[0].options.title, '작업 완료');
    assert.deepEqual(notifier.sync({
      generatedAt: '2026-08-13T01:47:03.000Z', sessions: [stableCompletion],
    }), []);
    assert.equal(FakeNotification.created.length, 1, '같은 완료 상태를 중복 알리면 안 됩니다.');
    notifier.dispose();

    FakeNotification.created = [];
    const guardedTimers = [];
    const guarded = new AttentionNotifier({
      Notification: FakeNotification,
      isSupported: () => true,
      completionStabilityMs: 2_000,
      setTimeout: callback => {
        const timer = { callback, cancelled: false, unref() {} };
        guardedTimers.push(timer);
        return timer;
      },
      clearTimeout: timer => { timer.cancelled = true; },
    });
    const guardedRoot = {
      id: 'codex:guarded-root', provider: 'codex', title: '전체 작업', status: 'running',
      completionObserved: false, completedAt: null, parentId: null, childIds: ['codex:guarded-child'],
      executions: [], collaboration: { spawns: [] }, updatedAt: '2026-08-13T02:00:00.000Z',
    };
    const guardedChild = {
      id: 'codex:guarded-child', provider: 'codex', title: '하위 작업', status: 'running',
      parentId: guardedRoot.id, childIds: [], executions: [], collaboration: { spawns: [] },
      updatedAt: '2026-08-13T02:00:00.000Z',
    };
    guarded.sync({ generatedAt: '2026-08-13T02:00:00.000Z', sessions: [guardedRoot, guardedChild] });

    const guardedCompleted = {
      ...guardedRoot, status: 'completed', completionObserved: true,
      completedAt: '2026-08-13T02:00:01.000Z', updatedAt: '2026-08-13T02:00:01.000Z',
    };
    assert.deepEqual(guarded.sync({
      generatedAt: '2026-08-13T02:00:01.100Z', sessions: [guardedCompleted, guardedChild],
    }), []);
    assert.equal(guardedTimers.length, 0, 'active child가 있으면 root completed 후보를 만들면 안 됩니다.');

    const guardedChildPaused = { ...guardedChild, status: 'paused' };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:01.200Z', sessions: [guardedCompleted, guardedChildPaused],
    });
    assert.equal(guardedTimers.length, 0, 'paused child가 있으면 root completed 후보를 만들면 안 됩니다.');

    const guardedChildCompleted = {
      ...guardedChild, status: 'completed', completionObserved: true,
      completedAt: '2026-08-13T02:00:02.000Z', updatedAt: '2026-08-13T02:00:02.000Z',
    };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:02.100Z', sessions: [guardedCompleted, guardedChildCompleted],
    });
    assert.equal(guardedTimers.length, 1, '하위 작업이 끝나면 root 완료 후보를 만들어야 합니다.');

    const requestedSpawn = {
      ...guardedCompleted,
      collaboration: {
        metrics: { currentlyRunning: 0 },
        spawns: [{ callId: 'requested-reviewer', childId: 'codex:requested-reviewer', status: 'requested', completedAt: null }],
      },
    };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:02.150Z', sessions: [requestedSpawn, guardedChildCompleted],
    });
    assert.equal(guardedTimers.length, 1, '미완료 requested spawn을 새 완료 후보로 만들면 안 됩니다.');
    assert.equal(guardedTimers[0].cancelled, true,
      'childId가 확인된 미완료 requested spawn이 생기면 pending 완료를 취소해야 합니다.');
    guardedTimers[0].callback();
    assert.equal(FakeNotification.created.length, 0);

    const terminalRequestedSpawns = {
      ...guardedCompleted,
      collaboration: {
        metrics: { currentlyRunning: 0 },
        spawns: [
          { callId: 'failed-reviewer', childId: 'codex:failed-reviewer', status: 'failed', completedAt: '2026-08-13T02:00:02.160Z' },
          { callId: 'completed-request', childId: 'codex:completed-request', status: 'requested', completedAt: '2026-08-13T02:00:02.170Z' },
          { callId: 'terminal-child-request', childId: guardedChildCompleted.id, status: 'requested', completedAt: null },
        ],
      },
    };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:02.180Z', sessions: [terminalRequestedSpawns, guardedChildCompleted],
    });
    assert.equal(guardedTimers.length, 2,
      'failed spawn, completedAt이 있는 request, terminal child의 stale requested record는 완료를 영구 차단하면 안 됩니다.');

    const aggregateRunning = {
      ...terminalRequestedSpawns,
      collaboration: { ...terminalRequestedSpawns.collaboration, metrics: { currentlyRunning: 1 } },
    };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:02.190Z', sessions: [aggregateRunning, guardedChildCompleted],
    });
    assert.equal(guardedTimers.length, 2, 'aggregate running 수치가 남아 있을 때 새 완료 후보를 만들면 안 됩니다.');
    assert.equal(guardedTimers[1].cancelled, true,
      'collaboration aggregate에 running spawn이 있으면 pending 완료를 취소해야 합니다.');
    guardedTimers[1].callback();
    assert.equal(FakeNotification.created.length, 0);

    const aggregateCompleted = {
      ...terminalRequestedSpawns,
      collaboration: { ...terminalRequestedSpawns.collaboration, metrics: { currentlyRunning: 0 } },
    };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:02.195Z', sessions: [aggregateCompleted, guardedChildCompleted],
    });
    assert.equal(guardedTimers.length, 3);

    const runningExecution = {
      ...aggregateCompleted,
      executions: [{ id: 'background-build', status: 'running' }],
    };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:02.200Z', sessions: [runningExecution, guardedChildCompleted],
    });
    assert.equal(guardedTimers[2].cancelled, true, 'running execution이 생기면 pending 완료를 취소해야 합니다.');
    guardedTimers[2].callback();
    assert.equal(FakeNotification.created.length, 0);

    const completedExecution = {
      ...aggregateCompleted,
      executions: [{ id: 'background-build', status: 'completed' }],
    };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:02.300Z', sessions: [completedExecution, guardedChildCompleted],
    });
    assert.equal(guardedTimers.length, 4);

    const activeSpawn = {
      ...completedExecution,
      collaboration: { spawns: [{ callId: 'reviewer', status: 'running' }] },
    };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:02.400Z', sessions: [activeSpawn, guardedChildCompleted],
    });
    assert.equal(guardedTimers[3].cancelled, true, 'active collaboration spawn이 생기면 pending 완료를 취소해야 합니다.');
    guardedTimers[3].callback();
    assert.equal(FakeNotification.created.length, 0);

    const completedSpawn = {
      ...completedExecution,
      collaboration: { spawns: [{ callId: 'reviewer', status: 'completed' }] },
    };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:02.500Z', sessions: [completedSpawn, guardedChildCompleted],
    });
    assert.equal(guardedTimers.length, 5);

    const nestedChild = {
      ...guardedChild, id: 'codex:guarded-grandchild', parentId: guardedChild.id,
      status: 'waiting', updatedAt: '2026-08-13T02:00:02.600Z',
    };
    const childWithDescendant = { ...guardedChildCompleted, childIds: [nestedChild.id] };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:02.600Z',
      sessions: [completedSpawn, childWithDescendant, nestedChild],
    });
    assert.equal(guardedTimers[4].cancelled, true, '재귀 active descendant가 생기면 pending 완료를 취소해야 합니다.');
    guardedTimers[4].callback();
    assert.equal(FakeNotification.created.length, 0);

    const nestedCompleted = {
      ...nestedChild, status: 'completed', completionObserved: true,
      completedAt: '2026-08-13T02:00:03.000Z', updatedAt: '2026-08-13T02:00:03.000Z',
    };
    guarded.sync({
      generatedAt: '2026-08-13T02:00:03.100Z',
      sessions: [completedSpawn, childWithDescendant, nestedCompleted],
    });
    assert.equal(guardedTimers.length, 6);
    guardedTimers[5].callback();
    assert.equal(FakeNotification.created.length, 1, '모든 active work가 끝난 뒤 root 완료를 한 번 알려야 합니다.');
    guarded.dispose();
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
