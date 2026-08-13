'use strict';

const assert = require('assert');
const { enrichSession, enrichSessions } = require('../../src/sessionIntelligence');

function registerSessionIntelligenceTests(context) {
  const { test } = context;

  test('세션 관리 인텔리전스가 주의·진행·건강·근거·결과를 함께 계산한다', () => {
    const now = Date.parse('2026-07-21T04:20:00.000Z');
    const waiting = {
      id: 'child', provider: 'codex', parentId: 'missing-parent', status: 'waiting', statusObserved: false,
      updatedAt: '2026-07-21T04:00:00.000Z', statusDetail: '권한 승인과 선택이 필요합니다.',
      externalId: 'thread-1', cwd: 'D:\\project', title: '결제 검토', context: { percent: 82 },
      responseIntent: {
        category: 'required', required: true, requestText: '배포 방식을 선택해 주세요?',
        requestId: 'request-user-input-1', requestedAt: '2026-07-21T03:59:30.000Z',
        confidence: 'high', source: 'input-tool',
      },
      messages: [{ role: 'assistant', text: '배포 방식을 선택해 주세요?', timestamp: '2026-07-21T04:00:00.000Z' }],
      lifecycle: [
        { id: 'a', label: '분석 완료', status: 'done', timestamp: '2026-07-21T03:58:00.000Z' },
        { id: 'b', label: '테스트 실패', status: 'failed', timestamp: '2026-07-21T03:59:00.000Z' },
      ],
    };
    const result = enrichSession(waiting, [waiting], now);
    assert.equal(result.attention.required, true);
    assert.equal(result.attention.kind, 'input');
    assert.equal(result.attention.source, 'input-tool');
    assert.equal(result.attention.requestId, 'request-user-input-1');
    assert.equal(result.attention.requestedAt, '2026-07-21T03:59:30.000Z');
    assert.equal(result.progress.totalSteps, 2);
    assert.equal(result.progress.completedSteps, 1);
    assert.equal(result.progress.failedSteps, 1);
    assert.equal(result.progress.blocker.includes('선택'), true);
    assert.equal(result.health.level, 'warning');
    assert.equal(result.health.signals.some(signal => signal.code === 'orphan-agent'), true);
    assert.equal(result.health.signals.some(signal => signal.code === 'context-warning'), true);
    assert.equal(result.evidence.status, 'inferred');
    assert.equal(result.controlCapabilities.respond, true);
    assert.equal(result.controlCapabilities.sendInstruction, true);
    assert.equal(result.controlCapabilities.reassign, true);

    const recovering = enrichSession({
      ...waiting, id: 'recovering', parentId: null, status: 'running', runId: 'run-recovering',
      statusObserved: true, statusDetail: '테스트 실패를 확인했고 자동으로 수정하는 중',
    }, [], now);
    assert.equal(recovering.attention.required, false);

    const cleanWaiting = enrichSession({
      ...waiting, id: 'clean-waiting', parentId: null, context: { percent: 10 }, lifecycle: [],
      updatedAt: '2026-07-21T04:20:00.000Z', statusDetail: '권한 승인이 필요합니다.',
      messages: [{ role: 'assistant', text: '이 작업을 계속 진행하도록 승인해 주세요.', timestamp: '2026-07-21T04:20:00.000Z' }],
      responseIntent: {
        category: 'required', required: true, requestText: '이 작업을 계속 진행하도록 승인해 주세요.',
        confidence: 'high', source: 'assistant-message',
      },
    }, [], now);
    assert.equal(cleanWaiting.attention.category, 'none', '일반 assistant 문장 추정은 명시적 확인 요청으로 승격하면 안 됩니다.');
    assert.equal(cleanWaiting.attention.required, false);
    assert.equal(cleanWaiting.attention.actionable, false);
    assert.equal(cleanWaiting.health.level, 'healthy', '응답 요청은 실제 상태 위험 신호와 분리해야 합니다.');
    assert.equal(cleanWaiting.health.signals.length, 0);

    const optional = enrichSession({
      ...waiting, id: 'optional-followup', parentId: null, status: 'idle', statusObserved: false,
      statusDetail: '다음 요청 대기', lifecycle: [], context: { percent: 10 },
      responseIntent: {
        category: 'optional', required: false, optional: true, requestText: 'OPS 파일로 저장할까요?',
        confidence: 'high', source: 'assistant-message',
      },
    }, [], now);
    assert.equal(optional.attention.category, 'optional');
    assert.equal(optional.attention.required, false);
    assert.equal(optional.attention.actionable, false);
    assert.equal(optional.attention.summary, 'OPS 파일로 저장할까요?');

    const unansweredLatestUser = enrichSession({
      ...waiting,
      id: 'unanswered-latest-user',
      parentId: null,
      status: 'running',
      statusObserved: true,
      statusDetail: '새 요청 처리 중',
      lifecycle: [],
      context: { percent: 10 },
      messages: [
        { role: 'assistant', text: '이전 결과를 파일로 저장할까요?', timestamp: '2026-07-21T04:19:00.000Z' },
        { role: 'user', text: '새 요청부터 처리해줘', timestamp: '2026-07-21T04:20:00.000Z' },
      ],
      responseIntent: {
        category: 'optional', required: false, optional: true,
        requestText: '이전 결과를 파일로 저장할까요?', confidence: 'high', source: 'assistant-message',
      },
    }, [], now);
    assert.equal(unansweredLatestUser.attention.category, 'none');
    assert.equal(unansweredLatestUser.attention.summary, '');
    assert.equal(unansweredLatestUser.responseIntent.category, 'none');
    assert.equal(unansweredLatestUser.responseIntent.requestText, '');
    assert.equal(unansweredLatestUser.progress.currentStep, '새 요청 처리 중');

    const permissionCheck = enrichSession({
      ...waiting, id: 'permission-check', parentId: null, status: 'running', statusObserved: true,
      updatedAt: '2026-07-21T04:20:00.000Z', statusDetail: '도구 실행 준비 중', lifecycle: [], context: { percent: 10 },
      messages: [],
      responseIntent: { category: 'optional', requestText: '완료 후 로그도 정리할까요?', confidence: 'high' },
      executions: [{
        id: 'permission-command', status: 'running', approvalRequired: true,
        label: '개발 서버 다시 시작', command: 'npm run dev',
        startedAt: '2026-07-21T04:20:00.000Z', updatedAt: '2026-07-21T04:20:00.000Z',
      }],
    }, [], now);
    assert.equal(permissionCheck.attention.category, 'required');
    assert.equal(permissionCheck.attention.required, true);
    assert.equal(permissionCheck.attention.kind, 'approval');
    assert.equal(permissionCheck.attention.source, 'execution-approval');
    assert.equal(permissionCheck.attention.summary, '개발 서버 다시 시작');
    assert.equal(permissionCheck.attention.requestedAt, '2026-07-21T04:20:00.000Z');

    const approvedPermission = enrichSession({
      ...permissionCheck,
      id: 'permission-approved',
      attention: undefined,
      responseIntent: { category: 'none', requestText: '' },
      executions: permissionCheck.executions.map(execution => ({ ...execution, status: 'completed' })),
    }, [], now);
    assert.equal(approvedPermission.attention.category, 'none');
    assert.equal(approvedPermission.attention.required, false);

    const failed = enrichSession({
      ...waiting, id: 'failed-risk', parentId: null, status: 'failed', statusObserved: true,
      statusDetail: '테스트 실패', lifecycle: [], context: { percent: 10 },
    }, [], now);
    assert.equal(failed.attention.category, 'risk');
    assert.equal(failed.attention.required, false);
    assert.equal(failed.attention.actionable, true);

    const grok = enrichSession({
      ...waiting,
      id: 'grok-resumable',
      provider: 'grok',
      parentId: null,
      status: 'completed',
      externalId: 'grok-session-42',
      runtimePresence: [],
    }, [], now);
    assert.equal(grok.controlCapabilities.sendInstruction, true);
    assert.equal(grok.controlCapabilities.resume, true);

    const indexedParent = {
      ...waiting,
      id: 'indexed-parent',
      parentId: null,
      status: 'running',
      context: { percent: 10 },
      messages: [],
      lifecycle: [],
    };
    const indexedChild = {
      ...indexedParent,
      id: 'indexed-child',
      parentId: indexedParent.id,
    };
    const sharedSnapshot = [indexedParent, indexedChild];
    assert.equal(enrichSession(indexedChild, sharedSnapshot, now).health.signals.some(signal => signal.code === 'orphan-agent'), false);
    sharedSnapshot[0] = { ...indexedParent, id: 'replacement-parent' };
    assert.equal(
      enrichSession(indexedChild, sharedSnapshot, now).health.signals.some(signal => signal.code === 'orphan-agent'),
      true,
      '같은 길이 배열의 부모 ID가 교체되면 단독 계산도 최신 구성원을 반영해야 합니다.',
    );
    sharedSnapshot[0] = indexedParent;

    const arrayMap = sharedSnapshot.map;
    let snapshotPasses = 0;
    sharedSnapshot.map = function countedMap(...args) {
      snapshotPasses += 1;
      return arrayMap.apply(this, args);
    };
    const indexedResults = enrichSessions(sharedSnapshot, now);
    assert.equal(snapshotPasses, 2, '일괄 계산은 결과 순회 한 번과 공유 ID 인덱스 구성 한 번만 수행해야 합니다.');
    assert.equal(indexedResults[1].health.signals.some(signal => signal.code === 'orphan-agent'), false);
  });

  test('로그의 테스트 실행 상태를 통과·실패·실행 중·미확인으로 구분한다', () => {
    const session = {
      id: 'check-statuses', provider: 'codex', status: 'completed', statusObserved: true,
      completionObserved: true, updatedAt: '2026-07-21T04:00:00.000Z', title: '테스트 상태 확인',
      messages: [],
      lifecycle: [
        { label: '결제 test', status: 'error' },
        { label: 'API spec', status: 'pending' },
        { label: 'UI test', status: 'started' },
        { label: '성능 테스트', status: 'completed' },
        { label: 'unknown test', status: 'queued' },
        { label: 'inspect output', status: 'completed' },
      ],
    };
    const result = enrichSession(session, [session], Date.parse('2026-07-21T04:01:00.000Z'));
    assert.deepEqual(result.outcome.checks.map(check => check.status), ['failed', 'running', 'running', 'passed', 'unknown']);
    assert.equal(result.outcome.checks.some(check => check.label === 'inspect output'), false, 'inspect 같은 일반 문구를 테스트 실행으로 오인하면 안 됩니다.');
  });

  test('완료 세션은 산출물·검증 이벤트·제어 가능 범위를 보존한다', () => {
    const session = {
      id: 'managed', runId: 'run-1', provider: 'claude', status: 'completed', statusObserved: true,
      completionObserved: true, updatedAt: '2026-07-21T04:00:00.000Z', cwd: '/work/project', title: '완료 작업',
      result: 'src/payment.js를 수정하고 tests/payment.test.js 검증을 완료했습니다. commit abcdef1234567',
      messages: [],
      lifecycle: [{ id: 'test', label: '결제 테스트', status: 'done', timestamp: '2026-07-21T04:00:00.000Z' }],
    };
    const result = enrichSession(session, [session], Date.parse('2026-07-21T04:01:00.000Z'));
    assert.equal(result.progress.percent, 100);
    assert.equal(result.outcome.verified, true);
    assert.equal(result.outcome.artifacts.some(item => item.kind === 'file' && item.value.includes('src/payment.js')), true);
    assert.equal(result.outcome.artifacts.some(item => item.kind === 'test'), true);
    assert.equal(result.outcome.artifacts.some(item => item.kind === 'commit'), true);
    assert.equal(result.outcome.artifacts.find(item => item.kind === 'commit').verified, false, '로그에 언급된 커밋 해시는 저장소 검증 없이 확인된 것으로 표시하면 안 됩니다.');
    assert.equal(result.outcome.checks[0].status, 'passed');
    assert.equal(result.controlCapabilities.stop, false);

    const withoutCurrentAnswer = enrichSession({
      ...session,
      id: 'empty-current-answer',
      result: '',
      statusDetail: '작업 완료',
      messages: [
        { role: 'assistant', text: '이전 턴 답변', timestamp: '2026-07-21T03:59:00.000Z' },
        { role: 'user', text: '새 작업', timestamp: '2026-07-21T04:00:00.000Z' },
      ],
    }, [], Date.parse('2026-07-21T04:01:00.000Z'));
    assert.equal(withoutCurrentAnswer.outcome.summary, '작업 완료', '새 턴에 답변이 없으면 이전 assistant 답변을 재사용하면 안 됩니다.');

    const withCurrentAnswer = enrichSession({
      ...session,
      id: 'current-answer',
      result: '',
      messages: [
        { role: 'assistant', text: '이전 턴 답변', timestamp: '2026-07-21T03:59:00.000Z' },
        { role: 'user', text: '새 작업', timestamp: '2026-07-21T04:00:00.000Z' },
        { role: 'assistant', text: '새 턴 최종 답변', timestamp: '2026-07-21T04:00:05.000Z' },
      ],
    }, [], Date.parse('2026-07-21T04:01:00.000Z'));
    assert.equal(withCurrentAnswer.outcome.summary, '새 턴 최종 답변');
  });

  test('장시간 신호가 없는 관리 실행은 정체 상태와 제어 기능을 노출한다', () => {
    const session = {
      id: 'running', runId: 'run-2', provider: 'codex', status: 'running', statusObserved: true,
      updatedAt: '2026-07-21T03:00:00.000Z', cwd: '/work/project', title: '긴 작업', messages: [], lifecycle: [],
    };
    const result = enrichSession(session, [session], Date.parse('2026-07-21T03:11:00.000Z'));
    assert.equal(result.health.level, 'critical');
    assert.equal(result.health.signals.some(signal => signal.code === 'stalled'), true);
    assert.equal(result.controlCapabilities.stop, true);
    assert.equal(result.controlCapabilities.pause, true);
  });
}

module.exports = { registerSessionIntelligenceTests };
