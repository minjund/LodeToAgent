'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  AgentMonitor, parseClaude, parseCodex, parseGeneric, attachHierarchy, isProjectlessSession, mergeManagedWithHistory,
} = require('../../src/agentMonitor');
const { MAX_JSON_BYTES } = require('../../src/agentMonitor/sessionFiles');
const { assistantRequestsUserResponse, assistantResponseIntent } = require('../../src/agentMonitor/responseIntent');

function registerClaudeParserTests(context) {
  const { test, temp, jsonl } = context;
  test('Claude 대화, 도구, usage를 정규화한다', () => {
    const file = path.join(temp, 'claude', 'project', '11111111-1111-1111-1111-111111111111.jsonl');
    const info = jsonl(file, [
      { type: 'user', uuid: 'u1', timestamp: '2026-07-14T01:00:00Z', cwd: 'D:\\repo', gitBranch: 'main', message: { role: 'user', content: '로그인 버그를 고쳐줘' } },
      { type: 'assistant', uuid: 'a1', requestId: 'r1', timestamp: '2026-07-14T01:00:01Z', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'auth.js' } }] } },
      { type: 'assistant', uuid: 'a2', requestId: 'r2', timestamp: '2026-07-14T01:00:02Z', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 180, output_tokens: 40 }, content: [{ type: 'text', text: '수정했습니다.' }] } },
    ]);
    const session = parseClaude(info);
    assert.equal(session.provider, 'claude');
    assert.equal(session.originCwd, 'D:\\repo');
    assert.equal(session.title, '로그인 버그를 고쳐줘');
    assert.equal(session.usage.input, 280);
    assert.equal(session.usage.cachedInput, 50);
    assert.equal(session.usage.output, 60);
    assert.equal(session.context.window, 1_000_000);
    assert.ok(session.messages.some(item => item.type === 'tool'));

    const backgroundShell = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'background-shell.jsonl'), [
      { type: 'user', uuid: 'bg-u', timestamp: '2026-07-14T01:05:00Z', message: { role: 'user', content: '개발 서버를 백그라운드로 실행해줘' } },
      { type: 'assistant', uuid: 'bg-a1', timestamp: '2026-07-14T01:05:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bash-bg', name: 'Bash', input: { command: 'npm run dev', description: '개발 서버', run_in_background: true } }] } },
      { type: 'user', uuid: 'bg-result-1', timestamp: '2026-07-14T01:05:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-bg', content: 'Command running in background with ID: shell-42' }] } },
      { type: 'assistant', uuid: 'bg-a2', timestamp: '2026-07-14T01:05:03Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'task-output', name: 'TaskOutput', input: { task_id: 'shell-42', block: true } }] } },
      { type: 'user', uuid: 'bg-result-2', timestamp: '2026-07-14T01:05:04Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'task-output', content: 'Process exited with code 0' }] } },
    ]));
    assert.deepStrictEqual(backgroundShell.executions.map(item => [item.kind, item.mode, item.status]), [['shell', 'background', 'completed']]);
    assert.equal(backgroundShell.executions[0].backgroundId, 'shell-42');
    assert.equal(backgroundShell.executions[0].command, 'npm run dev');

    const completedNotification = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'background-notification.jsonl'), [
      { type: 'assistant', uuid: 'notify-a1', timestamp: '2026-07-14T01:06:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'notify-bg', name: 'Bash', input: { command: 'git commit -m done', description: '백그라운드 커밋', run_in_background: true } }] } },
      { type: 'user', uuid: 'notify-result', timestamp: '2026-07-14T01:06:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'notify-bg', content: 'Command running in background with ID: task-42' }] } },
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-14T01:06:02Z', content: '<task-notification><task-id>task-42</task-id><tool-use-id>notify-bg</tool-use-id><status>completed</status><summary>Background command completed (exit code 0)</summary></task-notification>' },
    ]));
    assert.equal(completedNotification.executions[0].status, 'completed');
    assert.equal(completedNotification.executions[0].completedAt, '2026-07-14T01:06:02.000Z');

    const processLog = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'process-log.jsonl'), [
      { type: 'assistant', uuid: 'process-a1', timestamp: '2026-07-14T01:07:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'process-poll', name: 'Bash', input: { command: 'powershell.exe -Command poll', description: '서버 시작 확인' } }] } },
      { type: 'user', uuid: 'process-result', timestamp: '2026-07-14T01:07:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'process-poll', content: 'poll 1: port=UP\nStarted Application in 18 seconds (process running for 20 seconds)' }] } },
    ]));
    assert.equal(processLog.executions[0].status, 'completed');

    const waiting = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'question.jsonl'), [
      { type: 'user', uuid: 'question-u', timestamp: '2026-07-14T01:10:00Z', message: { role: 'user', content: '실행 환경을 정해줘' } },
      { type: 'assistant', uuid: 'question-a', timestamp: '2026-07-14T01:10:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'WSL과 Windows 중 어떤 환경으로 진행할까요?' }] } },
      { type: 'system', subtype: 'turn_complete', timestamp: '2026-07-14T01:10:02Z' },
    ]));
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.statusDetail, '내 답변을 기다리는 중');

    const now = Date.now();
    const recentBackground = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'question-with-recent-background.jsonl'), [
      { type: 'user', timestamp: new Date(now - 4_000).toISOString(), message: { role: 'user', content: '개발 서버를 켜고 배포 환경을 물어봐' } },
      { type: 'assistant', timestamp: new Date(now - 3_000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'recent-bg', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } },
      { type: 'user', timestamp: new Date(now - 2_000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'recent-bg', content: 'Command running in background with ID: recent-42' }] } },
      { type: 'assistant', timestamp: new Date(now - 1_000).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '배포 환경은 Windows와 WSL 중 무엇으로 할까요?' }] } },
    ]));
    assert.equal(recentBackground.status, 'waiting');
    assert.deepStrictEqual(recentBackground.executions.map(item => [item.mode, item.status]), [['background', 'running']]);

    const staleAt = new Date(now - 10 * 60_000).toISOString();
    const staleBackground = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'question-with-stale-background.jsonl'), [
      { type: 'assistant', timestamp: staleAt, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'stale-bg', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } },
      { type: 'user', timestamp: staleAt, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'stale-bg', content: 'Command running in background with ID: stale-42' }] } },
      { type: 'assistant', timestamp: staleAt, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '계속 진행할까요?' }] } },
    ]));
    assert.equal(staleBackground.status, 'waiting');
    assert.deepStrictEqual(staleBackground.executions.map(item => [item.mode, item.status]), [['background', 'unverified']]);
    assert.equal(staleBackground.executions[0].statusDetail, '최근 실행 활동이 확인되지 않음');
  });

  test('Claude 구조화 오류는 실패로 표시하고 다음 정상 턴에서 해제한다', () => {
    const failed = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'structured-failure.jsonl'), [
      { type: 'user', uuid: 'failure-user', timestamp: '2026-07-14T01:00:00Z', message: { role: 'user', content: '인증 상태를 확인해줘' } },
      {
        type: 'assistant',
        uuid: 'failure-assistant',
        error: 'authentication_failed',
        timestamp: '2026-07-14T01:00:01Z',
        message: {
          role: 'assistant',
          stop_reason: 'stop_sequence',
          content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.' }],
        },
      },
    ]));
    assert.equal(failed.status, 'failed');
    assert.match(failed.statusDetail, /Failed to authenticate/);
    assert.equal(failed.statusObserved, true);
    assert.ok(failed.lifecycle.some(item => item.type === 'error' && item.status === 'failed'));

    const recovered = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'recovered-after-failure.jsonl'), [
      { type: 'user', uuid: 'first-user', timestamp: '2026-07-14T01:00:00Z', message: { role: 'user', content: '첫 시도' } },
      { type: 'assistant', uuid: 'first-error', error: 'overloaded_error', timestamp: '2026-07-14T01:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Service overloaded' }] } },
      { type: 'user', uuid: 'retry-user', timestamp: '2026-07-14T01:00:02Z', message: { role: 'user', content: '다시 시도해줘' } },
      { type: 'assistant', uuid: 'retry-answer', timestamp: '2026-07-14T01:00:03Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '재시도에 성공했습니다.' }] } },
    ]));
    assert.equal(recovered.status, 'idle');
    assert.equal(recovered.title, '다시 시도해줘');
    assert.equal(recovered.statusDetail, '다음 요청 대기');
  });

  test('세션 상세 조회는 카드 제한과 달리 Claude 전체 대화를 다시 읽는다', () => {
    const home = path.join(temp, 'full-history-home');
    const file = path.join(home, '.claude', 'projects', 'full-history-project', 'full-history-session.jsonl');
    const rows = Array.from({ length: 240 }, (_, index) => ({
      type: index % 2 ? 'assistant' : 'user',
      uuid: `full-${index}`,
      timestamp: new Date(Date.parse('2026-07-14T01:00:00Z') + index * 1000).toISOString(),
      message: {
        role: index % 2 ? 'assistant' : 'user',
        content: index === 239 ? [{ type: 'text', text: `마지막 긴 답변 ${'가'.repeat(7000)}` }] : `전체 기록 ${index}`,
      },
    }));
    jsonl(file, rows);
    const monitor = new AgentMonitor({ home });
    const snapshot = monitor.scanNow();
    const card = snapshot.sessions.find(session => session.id === 'claude:full-history-session');
    assert.equal(card.messages.length, 180);
    assert.equal(card.omittedMessages, 60);

    const detail = monitor.detailSession(card.id);
    assert.equal(detail.messages.length, 240);
    assert.equal(detail.omittedMessages, 0);
    assert.equal(detail.truncated, false);
    assert.equal(detail.messages.at(-1).text.length, '마지막 긴 답변 '.length + 7000);
  });

  test('Claude 데스크톱 기록과 터미널 CLI 기록을 구분한다', () => {
    const desktopFile = path.join(temp, 'claude', 'desktop', '22222222-2222-2222-2222-222222222222.jsonl');
    const desktop = parseClaude(jsonl(desktopFile, [
      { type: 'last-prompt', sessionId: '22222222-2222-2222-2222-222222222222' },
      { type: 'user', timestamp: '2026-07-14T01:00:00Z', message: { role: 'user', content: '데스크톱 작업' } },
    ]));
    const cliFile = path.join(temp, 'claude', 'cli', '33333333-3333-3333-3333-333333333333.jsonl');
    const cli = parseClaude(jsonl(cliFile, [
      { type: 'user', timestamp: '2026-07-14T01:00:00Z', message: { role: 'user', content: '터미널 작업' } },
    ]));
    assert.equal(desktop.clientKind, 'claude-desktop');
    assert.equal(desktop.sourceLabel, 'Claude 데스크톱 앱');
    assert.equal(cli.clientKind, 'claude-cli');

    const scheduled = parseClaude(jsonl(path.join(temp, 'claude', 'desktop', 'scheduled.jsonl'), [
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-14T01:10:00Z', sessionId: 'scheduled', content: '/scheduled-run --tick order-verify\n\nThis is an unattended scheduled wake-up.' },
      { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-07-14T01:10:01Z', sessionId: 'scheduled' },
      { type: 'attachment', entrypoint: 'sdk-cli', timestamp: '2026-07-14T01:10:01Z', sessionId: 'scheduled' },
      { type: 'last-prompt', timestamp: '2026-07-14T01:10:02Z', sessionId: 'scheduled', lastPrompt: '/scheduled-run --tick order-verify…' },
      { type: 'assistant', uuid: 'scheduled-a', timestamp: '2026-07-14T01:10:03Z', message: { role: 'assistant', content: [{ type: 'text', text: '예약 작업을 실행 중입니다.' }] } },
    ]));
    assert.equal(scheduled.title, '/scheduled-run --tick order-verify');
    assert.equal(scheduled.clientKind, 'claude-cli');
  });

  test('Claude 서브에이전트를 부모 세션에 연결한다', () => {
    const file = path.join(temp, 'claude', 'project', 'parent-session', 'subagents', 'agent-child-01.jsonl');
    const session = parseClaude(jsonl(file, [{ type: 'assistant', agentId: 'child-01', timestamp: '2026-07-14T01:00:02Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: '조사 완료' }], usage: { input_tokens: 10, output_tokens: 5 } } }]));
    assert.equal(session.parentId, 'claude:parent-session');
    assert.equal(session.depth, 1);
  });

  test('Claude Agent와 Task 호출의 실제 prompt를 자식 세션에 연결한다', () => {
    const parent = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'claude-parent.jsonl'), [
      { type: 'user', uuid: 'claude-parent-user', timestamp: '2026-07-14T00:59:59Z', message: { role: 'user', content: '두 검사를 나눠서 진행해줘' } },
      { type: 'assistant', uuid: 'claude-parent-tools', timestamp: '2026-07-14T01:00:00Z', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu-agent', name: 'Agent', input: { description: '암호화 인자 검사', subagent_type: 'tester', prompt: 'Crypto.encrypt 호출과 repository 인자를 정확히 검증해줘' } },
        { type: 'tool_use', id: 'toolu-task', name: 'Task', input: { description: '문서 검사', subagent_type: 'reviewer', prompt: '계획 문서의 frontmatter만 읽기 전용으로 검증해줘' } },
      ] } },
      { type: 'user', uuid: 'claude-agent-started', timestamp: '2026-07-14T01:00:01Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu-agent', content: 'Async agent launched successfully.\nagentId: claude-agent-child' },
        { type: 'tool_result', tool_use_id: 'toolu-task', content: 'Async agent launched successfully.\nagentId: claude-task-child' },
      ] } },
      { type: 'user', uuid: 'claude-agent-done', timestamp: '2026-07-14T01:00:03Z', message: { role: 'user', content: '<task-notification><task-id>claude-agent-child</task-id><tool-use-id>toolu-agent</tool-use-id><status>completed</status><result>암호화 검사 완료</result></task-notification>' } },
    ]));
    const agentChild = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'claude-parent', 'subagents', 'agent-claude-agent-child.jsonl'), [
      { type: 'user', timestamp: '2026-07-14T01:00:01Z', message: { role: 'user', content: 'Crypto.encrypt 호출과 repository 인자를 정확히 검증해줘' } },
      { type: 'assistant', timestamp: '2026-07-14T01:00:03Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '암호화 검사 완료' }] } },
    ]));
    const taskChild = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'claude-parent', 'subagents', 'agent-claude-task-child.jsonl'), [
      { type: 'user', timestamp: '2026-07-14T01:00:01Z', message: { role: 'user', content: '계획 문서의 frontmatter만 읽기 전용으로 검증해줘' } },
    ]));
    const sessions = [parent, agentChild, taskChild];
    attachHierarchy(sessions);

    assert.equal(parent.collaboration.spawns.length, 2);
    assert.deepStrictEqual(parent.collaboration.spawns.map(spawn => spawn.assignment), [
      'Crypto.encrypt 호출과 repository 인자를 정확히 검증해줘',
      '계획 문서의 frontmatter만 읽기 전용으로 검증해줘',
    ]);
    assert.equal(parent.collaboration.spawns.every(spawn => spawn.assignmentSource === 'claude-agent-prompt'), true);
    assert.equal(agentChild.delegation.assignment, 'Crypto.encrypt 호출과 repository 인자를 정확히 검증해줘');
    assert.equal(taskChild.delegation.assignment, '계획 문서의 frontmatter만 읽기 전용으로 검증해줘');
    assert.equal(agentChild.delegation.assignmentProtected, false);
    assert.deepStrictEqual(parent.collaboration.communications.map(event => event.kind), [
      'assignment', 'assignment', 'started', 'started', 'result',
    ]);
  });

  test('Claude SendMessage 후속 대화와 재개된 서브에이전트 상태를 추적한다', () => {
    const activeAt = new Date(Date.now() - 1_000);
    const activeFile = path.join(temp, 'claude', 'project', 'claude-followup-active.jsonl');
    const activeInfo = jsonl(activeFile, [
      { type: 'user', uuid: 'followup-user', timestamp: '2026-07-14T01:00:00Z', message: { role: 'user', content: '서브에이전트와 두 번 대화해줘' } },
      { type: 'assistant', uuid: 'followup-agent-call', timestamp: '2026-07-14T01:00:01Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'toolu-agent-followup', name: 'Agent', input: { description: '토큰 확인', prompt: 'FIRST-91C2를 반환해줘' } },
      ] } },
      { type: 'user', uuid: 'followup-agent-result', timestamp: '2026-07-14T01:00:02Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu-agent-followup', content: 'FIRST-91C2\nagentId: child-followup' },
      ] } },
      { type: 'assistant', uuid: 'followup-message-call', timestamp: '2026-07-14T01:00:03Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'toolu-send-followup', name: 'SendMessage', input: { to: 'child-followup', summary: '두 번째 토큰', message: 'SECOND-4DB8과 FIRST를 결합해줘', type: 'message' } },
      ] } },
      { type: 'user', uuid: 'followup-message-result', timestamp: '2026-07-14T01:00:04Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu-send-followup', content: '{"success":true,"resumedAgentId":"child-followup"}' },
      ] } },
      { type: 'assistant', uuid: 'followup-waiting', timestamp: '2026-07-14T01:00:05Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [
        { type: 'text', text: '후속 답변이 도착하면 계속하겠습니다.' },
      ] } },
    ]);
    fs.utimesSync(activeFile, activeAt, activeAt);
    activeInfo.mtimeMs = fs.statSync(activeFile).mtimeMs;
    const active = parseClaude(activeInfo);

    assert.equal(active.status, 'running');
    assert.equal(active.statusDetail, '도움 AI 작업 진행 중');
    assert.equal(active.collaboration.spawns[0].status, 'running');
    assert.equal(active.collaboration.spawns[0].childId, 'claude:child-followup');
    assert.deepStrictEqual(active.collaboration.communications.map(event => event.kind), [
      'assignment', 'started', 'result', 'followup',
    ]);
    const followup = active.collaboration.communications.find(event => event.kind === 'followup');
    assert.equal(followup.childId, 'claude:child-followup');
    assert.equal(followup.text, 'SECOND-4DB8과 FIRST를 결합해줘');

    const child = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'claude-followup-active', 'subagents', 'agent-child-followup.jsonl'), [
      { type: 'user', timestamp: '2026-07-14T01:00:01Z', message: { role: 'user', content: 'FIRST-91C2를 반환해줘' } },
      { type: 'assistant', timestamp: '2026-07-14T01:00:02Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'FIRST-91C2' }] } },
    ]));
    const activeSessions = [active, child];
    attachHierarchy(activeSessions);
    assert.equal(active.collaboration.spawns[0].status, 'running');
    assert.equal(child.delegation.completedAt, null);

    const completed = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'claude-followup-completed.jsonl'), [
      { type: 'user', timestamp: '2026-07-14T02:00:00Z', message: { role: 'user', content: '서브에이전트와 두 번 대화해줘' } },
      { type: 'assistant', timestamp: '2026-07-14T02:00:01Z', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu-agent-completed', name: 'Agent', input: { description: '토큰 확인', prompt: 'FIRST-91C2를 반환해줘' } },
      ] } },
      { type: 'user', timestamp: '2026-07-14T02:00:02Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu-agent-completed', content: 'FIRST-91C2\nagentId: child-completed' },
      ] } },
      { type: 'assistant', timestamp: '2026-07-14T02:00:03Z', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu-send-completed', name: 'SendMessage', input: { to: 'child-completed', message: 'SECOND-4DB8과 FIRST를 결합해줘', type: 'message' } },
      ] } },
      { type: 'user', timestamp: '2026-07-14T02:00:04Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu-send-completed', content: '{"success":true,"resumedAgentId":"child-completed"}' },
      ] } },
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-14T02:00:05Z', content: '<task-notification><task-id>child-completed</task-id><tool-use-id>toolu-send-completed</tool-use-id><status>completed</status><result>FIRST-91C2 SECOND-4DB8</result></task-notification>' },
      { type: 'assistant', timestamp: '2026-07-14T02:00:06Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '왕복 완료' }] } },
    ]));
    assert.equal(completed.collaboration.spawns[0].status, 'completed');
    assert.equal(completed.collaboration.spawns[0].result, 'FIRST-91C2 SECOND-4DB8');
    assert.deepStrictEqual(completed.collaboration.communications.map(event => event.kind), [
      'assignment', 'started', 'result', 'followup', 'result',
    ]);
    assert.equal(completed.collaboration.communications.at(-1).text, 'FIRST-91C2 SECOND-4DB8');

    const managed = mergeManagedWithHistory(completed, {
      ...completed,
      source: 'loadtoagent',
      runId: 'managed-run',
      file: 'managed-events.jsonl',
      messages: [{ id: 'managed-final', role: 'assistant', text: '관리 실행 완료', timestamp: '2026-07-14T02:00:07Z' }],
      childIds: [],
      collaboration: { capacity: {}, spawns: [], communications: [], retainedAgents: [] },
    });
    assert.equal(managed.source, 'loadtoagent');
    assert.equal(managed.historyFile, completed.file);
    assert.equal(managed.collaboration.spawns.length, 1);
    assert.equal(managed.collaboration.communications.length, 5);
    assert.equal(managed.messages.some(message => message.id === 'managed-final'), true);
  });

  test('완료 알림 없이 끊긴 오래된 Claude 서브에이전트를 실행 중으로 남기지 않는다', () => {
    const staleAt = new Date(Date.now() - 10 * 60_000);
    const parentFile = path.join(temp, 'claude', 'project', 'claude-stale-subagent.jsonl');
    const parentInfo = jsonl(parentFile, [
      { type: 'user', timestamp: '2026-07-14T02:30:00Z', message: { role: 'user', content: '세 검사를 병렬로 진행해줘' } },
      { type: 'assistant', timestamp: '2026-07-14T02:30:01Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'toolu-stale-agent', name: 'Agent', input: { description: '유령 상태 검사', prompt: '상태를 검사해줘' } },
      ] } },
      { type: 'user', timestamp: '2026-07-14T02:30:02Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu-stale-agent', content: 'Async agent launched successfully.\nagentId: stale-child' },
      ] } },
    ]);
    fs.utimesSync(parentFile, staleAt, staleAt);
    parentInfo.mtimeMs = fs.statSync(parentFile).mtimeMs;

    const childFile = path.join(temp, 'claude', 'project', 'claude-stale-subagent', 'subagents', 'agent-stale-child.jsonl');
    const childInfo = jsonl(childFile, [
      { type: 'user', timestamp: '2026-07-14T02:30:02Z', message: { role: 'user', content: '상태를 검사해줘' } },
      { type: 'assistant', timestamp: '2026-07-14T02:30:03Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'stale-read', name: 'Read', input: { file_path: 'status.js' } },
      ] } },
    ]);
    fs.utimesSync(childFile, staleAt, staleAt);
    childInfo.mtimeMs = fs.statSync(childFile).mtimeMs;

    const parent = parseClaude(parentInfo);
    const child = parseClaude(childInfo);
    const sessions = [parent, child];
    attachHierarchy(sessions);

    assert.equal(parent.status, 'idle');
    assert.equal(parent.collaboration.spawns[0].status, 'unverified');
    assert.equal(parent.collaboration.metrics.currentlyRunning, 0);
    assert.equal(child.status, 'idle');
  });

  test('Claude 서브에이전트의 end_turn만 작업 완료로 판정한다', () => {
    const completed = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'completed-parent', 'subagents', 'agent-completed.jsonl'), [
      { type: 'user', timestamp: '2026-07-14T01:00:00Z', message: { role: 'user', content: '주문 관리 이관을 점검해줘' } },
      { type: 'assistant', timestamp: '2026-07-14T01:00:01Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '점검을 완료했습니다.' }] } },
    ]));
    assert.equal(completed.status, 'completed');
    assert.equal(completed.statusDetail, '작업 완료');
    assert.equal(completed.completionObserved, true);
    assert.equal(completed.completedAt, '2026-07-14T01:00:01.000Z');
    assert.equal(completed.result, '점검을 완료했습니다.');

    const interrupted = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'interrupted-parent', 'subagents', 'agent-interrupted.jsonl'), [
      { type: 'assistant', timestamp: '2026-07-14T02:00:00Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'orders.js' } }] } },
      { type: 'user', timestamp: '2026-07-14T02:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'file contents' }] } },
    ]));
    assert.notEqual(interrupted.status, 'completed');
    assert.equal(interrupted.completionObserved, false);

    const main = parseClaude(jsonl(path.join(temp, 'claude', 'project', 'main-end-turn.jsonl'), [
      { type: 'assistant', timestamp: '2026-07-14T03:00:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '메인 응답 완료' }] } },
    ]));
    assert.notEqual(main.status, 'completed');
    assert.equal(main.completionObserved, false);
  });

  test('Claude의 과거 완료 턴이 새로 실행 중인 턴을 대기 상태로 덮지 않는다', () => {
    const file = path.join(temp, 'claude', 'project', 'active-after-complete.jsonl');
    const info = jsonl(file, [
      { type: 'user', timestamp: '2026-07-14T01:00:00Z', message: { role: 'user', content: '첫 작업' } },
      { type: 'assistant', timestamp: '2026-07-14T01:00:01Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '첫 작업 완료' }] } },
      { type: 'system', subtype: 'turn_complete', timestamp: '2026-07-14T01:00:02Z' },
      { type: 'user', timestamp: '2026-07-14T01:01:00Z', message: { role: 'user', content: '다음 작업을 계속해줘' } },
      { type: 'assistant', timestamp: '2026-07-14T01:01:01Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'npm test' } }] } },
    ]);
    const active = new Date(Date.now() - 30_000);
    fs.utimesSync(file, active, active);
    info.mtimeMs = fs.statSync(file).mtimeMs;
    const session = parseClaude(info);
    assert.equal(session.status, 'running');
    assert.equal(session.statusDetail, '도구 실행 또는 스트리밍 중');
  });

  test('Claude 내부 명령 안내를 숨기고 최근 실제 요청을 제목으로 사용한다', () => {
    const file = path.join(temp, 'claude', 'project', 'visible-claude.jsonl');
    const session = parseClaude(jsonl(file, [
      { type: 'user', uuid: 'u0', timestamp: '2026-07-14T01:00:00Z', message: { role: 'user', content: '<local-command-caveat>Caveat: generated command</local-command-caveat>' } },
      { type: 'user', uuid: 'u1', timestamp: '2026-07-14T01:00:01Z', message: { role: 'user', content: '첫 번째 작업' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-07-14T01:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: '처리 중입니다.' }] } },
      { type: 'user', uuid: 'u2', timestamp: '2026-07-14T01:00:03Z', message: { role: 'user', content: '<objective>가장 최근 실제 작업</objective>' } },
      { type: 'user', uuid: 'u3', timestamp: '2026-07-14T01:00:04Z', message: { role: 'user', content: '<task-notification><task-id>worker</task-id><status>completed</status></task-notification>' } },
      { type: 'user', uuid: 'u4', timestamp: '2026-07-14T01:00:05Z', isMeta: true, sourceToolUseID: 'tool-memory', message: { role: 'user', content: '# memory-add\n내부 메모리 명령' } },
    ]));
    assert.equal(session.title, '가장 최근 실제 작업');
    assert.equal(session.messages.some(item => /local-command-caveat/.test(item.text)), false);
    assert.equal(session.messages.some(item => /memory-add|내부 메모리 명령/.test(item.text)), false);
  });

  test('Claude 메모리 추출과 인증 점검은 사용자 작업 목록에서 제외한다', () => {
    const home = path.join(temp, 'utility-home');
    const project = path.join(home, '.claude', 'projects', 'D--repo');
    const memory = parseClaude(jsonl(path.join(project, 'memory.jsonl'), [
      { type: 'user', timestamp: '2026-07-14T01:20:00Z', message: { role: 'user', content: 'Extract durable memory candidates from this Claude Code transcript tail. Return ONLY JSON array. No markdown.' } },
      { type: 'assistant', timestamp: '2026-07-14T01:20:01Z', message: { role: 'assistant', content: '[]' } },
    ]));
    const authentication = parseClaude(jsonl(path.join(project, 'authentication.jsonl'), [
      { type: 'user', timestamp: '2026-07-14T01:21:00Z', message: { role: 'user', content: 'Reply with exactly OK. Do not use tools.' } },
      { type: 'assistant', timestamp: '2026-07-14T01:21:01Z', message: { role: 'assistant', content: 'OK' } },
    ]));
    assert.equal(memory.utilityKind, 'memory-extraction');
    assert.equal(authentication.utilityKind, 'authentication-check');
    assert.equal(memory.messages.some(item => item.role === 'user'), false);
    assert.equal(authentication.messages.some(item => item.role === 'user'), false);

    const snapshot = new AgentMonitor({ home }).scanNow();
    assert.deepStrictEqual(snapshot.sessions.filter(session => session.provider === 'claude'), []);
  });

}

function registerCodexParserTests(context) {
  const { test, temp, jsonl } = context;
  test('실행 중인 Codex 연결은 최근 파일 한도를 벗어난 정확한 대화도 불러온다', () => {
    const home = path.join(temp, 'pinned-codex-home');
    const sessionsRoot = path.join(home, '.codex', 'sessions', '2026', '07', '24');
    const pinnedId = '019f92f6-b724-7ee1-85f6-3d3bc6939e0b';
    const pinnedFile = path.join(sessionsRoot, `rollout-2026-07-24T16-11-15-${pinnedId}.jsonl`);
    jsonl(pinnedFile, [
      { timestamp: '2026-07-24T07:11:15Z', type: 'session_meta', payload: { id: pinnedId, cwd: 'D:\\repo', originator: 'Codex Desktop', source: 'vscode', thread_source: 'user' } },
      { timestamp: '2026-07-24T07:11:16Z', type: 'event_msg', payload: { type: 'user_message', message: '오래 실행 중인 연결의 실제 대화를 보여줘' } },
      { timestamp: '2026-07-24T07:11:17Z', type: 'event_msg', payload: { type: 'agent_message', message: '정확한 대화를 불러왔습니다.' } },
    ]);
    const oldTime = new Date('2026-07-24T07:11:17Z');
    fs.utimesSync(pinnedFile, oldTime, oldTime);
    for (let index = 0; index < 81; index += 1) {
      const id = `recent-${String(index).padStart(3, '0')}`;
      const file = path.join(home, '.codex', 'sessions', '2026', '08', '04', `rollout-2026-08-04T10-${String(index).padStart(2, '0')}-00-${id}.jsonl`);
      jsonl(file, [
        { timestamp: `2026-08-04T01:${String(index % 60).padStart(2, '0')}:00Z`, type: 'session_meta', payload: { id, cwd: 'D:\\other' } },
        { timestamp: `2026-08-04T01:${String(index % 60).padStart(2, '0')}:01Z`, type: 'event_msg', payload: { type: 'user_message', message: `최근 대화 ${index}` } },
      ]);
      const recentTime = new Date(2026, 7, 4, 10, index % 60, index);
      fs.utimesSync(file, recentTime, recentTime);
    }
    const monitor = new AgentMonitor({ home });
    const localEnvironment = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
    assert.equal(monitor.scanNow().sessions.some(session => session.externalId === pinnedId), false);
    monitor.setPinnedSessions([{ provider: 'codex', linkedSessionId: `codex:${pinnedId}`, environment: localEnvironment }]);
    const pinned = monitor.scanNow().sessions.find(session => session.externalId === pinnedId);
    assert.ok(pinned, '실행 중인 연결의 정확한 과거 세션을 찾지 못했습니다.');
    assert.deepStrictEqual(pinned.messages.filter(message => message.role === 'user' || message.role === 'assistant').map(message => message.text), [
      '오래 실행 중인 연결의 실제 대화를 보여줘',
      '정확한 대화를 불러왔습니다.',
    ]);
  });

  test('Codex thread, turn, item, token_count와 사용자 응답 대기를 정규화한다', () => {
    const file = path.join(temp, 'codex', 'rollout-test.jsonl');
    const info = jsonl(file, [
      { timestamp: '2026-07-14T02:00:00Z', type: 'session_meta', payload: { id: 'codex-session', cwd: 'D:\\repo', originator: 'Codex Desktop', source: 'vscode', thread_source: 'user', git: { branch: 'main' } } },
      { timestamp: '2026-07-14T02:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.4', cwd: 'D:\\repo\\packages\\dashboard' } },
      { timestamp: '2026-07-14T02:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1', started_at: '2026-07-14T02:00:02Z' } },
      { timestamp: '2026-07-14T02:00:03Z', type: 'event_msg', payload: { type: 'user_message', client_id: 'u1', message: '테스트를 실행해줘' } },
      { timestamp: '2026-07-14T02:00:04Z', type: 'response_item', payload: { type: 'function_call', id: 'call-1', call_id: 'call-1', name: 'shell_command', arguments: '{"command":"npm test"}' } },
      { timestamp: '2026-07-14T02:00:04.500Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Exit code: 0\nOutput:\nall tests passed' } },
      { timestamp: '2026-07-14T02:00:05Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 150, output_tokens: 30, reasoning_output_tokens: 20, total_tokens: 250 }, last_token_usage: { input_tokens: 120, output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 150 }, model_context_window: 258400 } } },
      { timestamp: '2026-07-14T02:00:06Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '완료', completed_at: '2026-07-14T02:00:06Z' } },
    ]);
    const session = parseCodex(info);
    assert.equal(session.id, 'codex:codex-session');
    assert.equal(session.model, 'gpt-5.4');
    assert.equal(session.originCwd, 'D:\\repo');
    assert.equal(session.cwd, 'D:\\repo\\packages\\dashboard');
    assert.equal(session.title, '테스트를 실행해줘');
    assert.equal(session.usage.total, 250);
    assert.equal(session.context.window, 258400);
    assert.equal(session.status, 'idle');
    assert.equal(session.clientKind, 'codex-desktop');
    assert.deepStrictEqual(session.executions.map(item => [item.kind, item.mode, item.status]), [['shell', 'foreground', 'completed']]);
    assert.equal(session.executions[0].command, 'npm test');
    assert.match(session.executions[0].output, /all tests passed/);

    const backgroundShell = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-background-shell.jsonl'), [
      { timestamp: '2026-07-14T02:05:00Z', type: 'session_meta', payload: { id: 'background-shell', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T02:05:01Z', type: 'event_msg', payload: { type: 'user_message', message: '서버를 실행해줘' } },
      { timestamp: '2026-07-14T02:05:02Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'custom-exec', name: 'exec', input: 'const r = await tools.exec_command({\n  cmd: "npm run dev",\n  workdir: "D:\\\\repo",\n  yield_time_ms: 1000\n});\ntext(r.output)' } },
      { timestamp: '2026-07-14T02:05:03Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'custom-exec', output: [{ type: 'input_text', text: 'Script running with cell ID cell-77' }] } },
      { timestamp: '2026-07-14T02:05:04Z', type: 'response_item', payload: { type: 'function_call', call_id: 'wait-exec', name: 'wait', arguments: '{"cell_id":"cell-77","yield_time_ms":10000}' } },
      { timestamp: '2026-07-14T02:05:05Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'wait-exec', output: 'Script completed\nExit code: 0' } },
      { timestamp: '2026-07-14T02:05:06Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'custom-complete', name: 'exec', input: 'const r = await tools.exec_command({ cmd: "rg session renderer" });\ntext(r.output)' } },
      { timestamp: '2026-07-14T02:05:07Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'custom-complete', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\nconst session = drawer; process.exitCode = 1;' }] } },
      { timestamp: '2026-07-14T02:05:08Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'custom-session', name: 'exec', input: 'const r = await tools.exec_command({ cmd: "npm run watch", yield_time_ms: 1000 });\ntext(r.output)' } },
      { timestamp: '2026-07-14T02:05:09Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'custom-session', output: [{ type: 'input_text', text: 'Process running with session ID 912' }] } },
      { timestamp: '2026-07-14T02:05:10Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'custom-stdin', name: 'exec', input: 'const r = await tools.write_stdin({ session_id: 912, yield_time_ms: 1000 });\ntext(r.output)' } },
      { timestamp: '2026-07-14T02:05:11Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'custom-stdin', output: [{ type: 'input_text', text: 'Process exited with code 0' }] } },
    ]));
    assert.deepStrictEqual(backgroundShell.executions.map(item => [item.kind, item.mode, item.status]), [
      ['shell', 'background', 'completed'],
      ['shell', 'foreground', 'completed'],
      ['shell', 'background', 'completed'],
    ]);
    assert.equal(backgroundShell.executions[0].backgroundId, 'cell-77');
    assert.equal(backgroundShell.executions[0].command, 'npm run dev');
    assert.equal(backgroundShell.executions[1].backgroundId, '');
    assert.match(backgroundShell.executions[1].output, /const session = drawer/);
    assert.equal(backgroundShell.executions[2].backgroundId, '912');
    assert.equal(backgroundShell.executions[2].command, 'npm run watch');

    const question = '실행 환경은 WSL과 Windows 중에서 선택할 수 있습니다.\n\n어떤 방식으로 갈까요?';
    const waiting = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-question.jsonl'), [
      { timestamp: '2026-07-14T03:00:00Z', type: 'session_meta', payload: { id: 'question', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T03:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'question-turn' } },
      { timestamp: '2026-07-14T03:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: '회귀 검증 계획을 잡아줘' } },
      { timestamp: '2026-07-14T03:00:03Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: question } },
      { timestamp: '2026-07-14T03:00:04Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'question-turn', last_agent_message: question } },
    ]));
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.statusDetail, '내 답변을 기다리는 중');

    const answered = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-question-answered.jsonl'), [
      { timestamp: '2026-07-14T03:10:00Z', type: 'session_meta', payload: { id: 'question-answered', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T03:10:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'question-turn' } },
      { timestamp: '2026-07-14T03:10:02Z', type: 'event_msg', payload: { type: 'user_message', message: '회귀 검증 계획을 잡아줘' } },
      { timestamp: '2026-07-14T03:10:03Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'question-turn', last_agent_message: question } },
      { timestamp: '2026-07-14T03:10:04Z', type: 'event_msg', payload: { type: 'user_message', message: 'WSL로 진행해줘' } },
    ]));
    assert.notEqual(answered.status, 'waiting');

    const restartedSubagent = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-restarted-subagent.jsonl'), [
      { timestamp: '2026-07-14T03:15:00Z', type: 'session_meta', payload: { id: 'restarted-subagent', cwd: 'D:\\repo', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1, agent_path: '/root/restarted' } } } } },
      { timestamp: '2026-07-14T03:15:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'first-turn' } },
      { timestamp: '2026-07-14T03:15:02Z', type: 'event_msg', payload: { type: 'user_message', message: '첫 작업을 확인해줘' } },
      { timestamp: '2026-07-14T03:15:03Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'first-turn', completed_at: '2026-07-14T03:15:03Z', last_agent_message: '첫 작업 완료' } },
      { timestamp: '2026-07-14T03:15:04Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'second-turn' } },
      { timestamp: '2026-07-14T03:15:05Z', type: 'event_msg', payload: { type: 'user_message', message: '다음 작업을 계속해줘' } },
    ]));
    assert.equal(restartedSubagent.status, 'running');
    assert.equal(restartedSubagent.completionObserved, false);
    assert.equal(restartedSubagent.completedAt, null);

    const structured = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-input-tool.jsonl'), [
      { timestamp: '2026-07-14T03:20:00Z', type: 'session_meta', payload: { id: 'input-tool', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T03:20:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'input-turn' } },
      { timestamp: '2026-07-14T03:20:02Z', type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'input-1', arguments: '{}' } },
    ]));
    assert.equal(structured.status, 'waiting');
    assert.equal(structured.statusDetail, '내 답변을 기다리는 중');

    assert.equal(assistantRequestsUserResponse('실행 환경을 골라주세요:\n- WSL\n- Windows'), true);
    assert.equal(assistantRequestsUserResponse('수정을 완료했습니다.'), false);
    assert.equal(assistantRequestsUserResponse('질문 표기는 \`ready?\`이며 처리를 완료했습니다.'), false);
    assert.equal(assistantRequestsUserResponse('궁금한 점이 있으면 알려주세요.'), false);
    assert.equal(assistantRequestsUserResponse('order resend 미커밋분은 stash에 보존했습니다.'), false);
    assert.equal(assistantRequestsUserResponse('다시 세팅 완료됐어. 현재 전부 attached 상태야.\n\n창 attach를 직접 다시 해놨어. 지금 최종 검수 기준으로는 정상 상태야.'), false);
    assert.equal(assistantRequestsUserResponse('Please send the log file.'), true);
    assert.equal(assistantRequestsUserResponse('To continue, please confirm the branch.'), true);
    assert.equal(assistantRequestsUserResponse('Could you select one?\n- WSL\n- Windows'), true);
    assert.deepStrictEqual(
      assistantResponseIntent('필요하시면 이 SQL을 OPS 스크립트 파일로 저장해 드리겠습니다. 저장할까요?'),
      {
        category: 'optional', required: false, optional: true,
        requestText: '저장할까요?', confidence: 'high',
      },
    );
    assert.equal(assistantRequestsUserResponse('원하시면 변경 내역도 문서화해 드릴까요?'), false);
    assert.equal(assistantResponseIntent('배포 전에 대상 환경을 선택해 주세요.').category, 'required');
  });

  test('Codex 데스크톱의 new-chat 임시 경로를 프로젝트 없는 세션으로 분류한다', () => {
    const projectless = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-projectless.jsonl'), [
      { timestamp: '2026-07-16T00:00:00Z', type: 'session_meta', payload: { id: 'projectless', cwd: '/Users/test/Documents/Codex/2026-07-16/new-chat', originator: 'Codex Desktop' } },
      { timestamp: '2026-07-16T00:00:01Z', type: 'turn_context', payload: { cwd: '/Users/test/worktrees/later-location' } },
      { timestamp: '2026-07-16T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '프로젝트 없이 시작한 대화' } },
    ]));
    const namedProject = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-named-project.jsonl'), [
      { timestamp: '2026-07-16T00:00:00Z', type: 'session_meta', payload: { id: 'named-project', cwd: '/Users/test/Documents/Codex/2026-07-16/my-project', originator: 'Codex Desktop' } },
    ]));
    assert.equal(isProjectlessSession(projectless), true);
    assert.equal(isProjectlessSession(namedProject), false);
    assert.equal(isProjectlessSession({ provider: 'claude', clientKind: 'claude-cli', cwd: '' }), true);
  });

  test('Codex event와 response_item에 함께 기록된 같은 채팅은 한 번만 표시한다', () => {
    const file = path.join(temp, 'codex', 'rollout-duplicate-chat.jsonl');
    const session = parseCodex(jsonl(file, [
      { timestamp: '2026-07-14T02:00:00.000Z', type: 'session_meta', payload: { id: 'duplicate-chat', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T02:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', client_id: 'u1', message: '중복 없이 보여줘' } },
      { timestamp: '2026-07-14T02:00:01.100Z', type: 'event_msg', payload: { type: 'user_message', client_id: 'u2', message: '중복 없이 보여줘' } },
      { timestamp: '2026-07-14T02:00:01.750Z', type: 'response_item', payload: { id: 'user-item', type: 'message', role: 'user', content: [{ type: 'input_text', text: '중복 없이 보여줘' }] } },
      { timestamp: '2026-07-14T02:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: '한 번만 표시합니다.' } },
      { timestamp: '2026-07-14T02:00:02.001Z', type: 'response_item', payload: { id: 'assistant-item', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '한 번만 표시합니다.' }] } },
      { timestamp: '2026-07-14T02:00:03.000Z', type: 'response_item', payload: { id: 'reverse-assistant', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '역순도 한 번입니다.' }] } },
      { timestamp: '2026-07-14T02:00:03.300Z', type: 'event_msg', payload: { type: 'agent_message', message: '역순도 한 번입니다.' } },
      { timestamp: '2026-07-14T02:00:04.000Z', type: 'response_item', payload: { id: 'developer-message', type: 'message', role: 'developer', content: [{ type: 'input_text', text: '내부 개발자 지침' }] } },
    ]));
    assert.deepStrictEqual(session.messages.map(item => [item.role, item.text]), [
      ['user', '중복 없이 보여줘'],
      ['user', '중복 없이 보여줘'],
      ['assistant', '한 번만 표시합니다.'],
      ['assistant', '역순도 한 번입니다.'],
    ]);
  });

  test('Codex 서브에이전트 source를 해석한다', () => {
    const file = path.join(temp, 'codex', 'rollout-sub.jsonl');
    const session = parseCodex(jsonl(file, [{ timestamp: '2026-07-14T02:00:00Z', type: 'session_meta', payload: { id: 'child', cwd: 'D:\\repo', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1, agent_nickname: 'Cicero', agent_role: 'explorer' } } } } }]));
    assert.equal(session.parentId, 'codex:parent');
    assert.equal(session.agentName, 'Cicero');
    assert.equal(session.agentRole, 'explorer');
  });

}

function registerCollaborationSummaryTests(context) {
  const { test, temp, jsonl } = context;
  test('Codex 협업 이벤트로 누적·동시 한도·실행·완료와 통신을 구분한다', () => {
    const parent = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-collaboration-parent.jsonl'), [
      { timestamp: '2026-07-14T02:10:00Z', type: 'session_meta', payload: { id: 'collaboration-parent', cwd: 'D:\\repo', originator: 'Codex Desktop' } },
      { timestamp: '2026-07-14T02:10:01Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'There are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.' }] } },
      { timestamp: '2026-07-14T02:10:02Z', type: 'event_msg', payload: { type: 'user_message', message: '버튼 정확도를 검사해줘' } },
      { timestamp: '2026-07-14T02:10:03Z', type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: 'spawn-1', arguments: JSON.stringify({ task_name: 'button_audit', message: '버튼의 실제 동작을 검사해줘' }) } },
      { timestamp: '2026-07-14T02:10:04Z', type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'spawn-1', agent_thread_id: 'collaboration-child', agent_path: '/root/button_audit', kind: 'started' } },
      { timestamp: '2026-07-14T02:10:05Z', type: 'response_item', payload: { type: 'agent_message', author: '/root/button_audit', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/button_audit\nPayload:\n버튼 12개 확인 완료' }] } },
      { timestamp: '2026-07-14T02:10:06Z', type: 'response_item', payload: { type: 'function_call', name: 'list_agents', namespace: 'collaboration', call_id: 'list-1', arguments: '{}' } },
      { timestamp: '2026-07-14T02:10:07Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'list-1', output: JSON.stringify({ agents: [{ agent_name: '/root', agent_status: 'running' }, { agent_name: '/root/button_audit', agent_status: { completed: 'done' } }] }) } },
    ]));
    const child = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-collaboration-child.jsonl'), [
      { timestamp: '2026-07-14T02:10:04Z', type: 'session_meta', payload: { id: 'collaboration-child', source: { subagent: { thread_spawn: { parent_thread_id: 'collaboration-parent', depth: 1, agent_path: '/root/button_audit', agent_nickname: 'Pascal', agent_role: 'tester' } } } } },
      { timestamp: '2026-07-14T02:10:04Z', type: 'event_msg', payload: { type: 'user_message', message: '버튼 정확도를 검사해줘' } },
      { timestamp: '2026-07-14T02:10:05Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: '버튼 12개 확인 완료' } },
      { timestamp: '2026-07-14T02:10:06Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child-turn', last_agent_message: '버튼 12개 확인 완료', completed_at: '2026-07-14T02:10:06Z' } },
    ]));
    const sessions = [parent, child];
    attachHierarchy(sessions);
    assert.deepStrictEqual(parent.collaboration.capacity, { totalThreads: 4, subagents: 3, source: 'runtime-instruction' });
    assert.deepStrictEqual(parent.collaboration.metrics, {
      cumulativeCreated: 1,
      simultaneousCapacity: 3,
      currentlyRunning: 0,
      completedRecords: 1,
      retainedCount: 1,
      capacitySource: 'runtime-instruction',
      cumulativeSource: 'spawn-events',
    });
    assert.equal(parent.collaboration.communications.some(item => item.kind === 'assignment' && item.text === '버튼의 실제 동작을 검사해줘'), true);
    assert.equal(parent.collaboration.communications.some(item => item.kind === 'result' && item.text === '버튼 12개 확인 완료'), true);
    assert.equal(child.status, 'completed');
    assert.equal(child.title, 'button_audit');
    assert.equal(child.originCwd, 'D:\\repo');
    assert.equal(child.cwd, 'D:\\repo');
    assert.equal(child.sharedGoal, '버튼 정확도를 검사해줘');
    assert.equal(child.delegation.assignment, '버튼의 실제 동작을 검사해줘');
  });

  test('암호화된 spawn 지시와 직전 메인 AI 설명을 실제 원문으로 혼동하지 않는다', () => {
    const parent = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-encrypted-assignment.jsonl'), [
      { timestamp: '2026-07-14T02:15:00Z', type: 'session_meta', payload: { id: 'encrypted-assignment', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T02:15:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { timestamp: '2026-07-14T02:15:02Z', type: 'event_msg', payload: { type: 'agent_message', message: '서브에이전트를 생성해 독립적으로 1 = 1을 확인시키겠습니다.' } },
      { timestamp: '2026-07-14T02:15:03Z', type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: 'spawn-encrypted', arguments: JSON.stringify({ task_name: 'equality_check', message: 'gAAAAABencryptedPayload' }) } },
    ]));
    const spawn = parent.collaboration.spawns[0];
    const assignment = parent.collaboration.communications.find(item => item.kind === 'assignment');
    assert.equal(spawn.assignment, '');
    assert.equal(spawn.assignmentObserved, false);
    assert.equal(spawn.assignmentProtected, true);
    assert.equal(spawn.assignmentSource, 'protected');
    assert.equal(spawn.assignmentContext, '서브에이전트를 생성해 독립적으로 1 = 1을 확인시키겠습니다.');
    assert.equal(assignment.text, '');
    assert.equal(assignment.protected, true);
    assert.equal(assignment.assignmentSource, 'protected');
    assert.equal(JSON.stringify(parent).includes('gAAAAABencryptedPayload'), false);
  });

}

function registerProtectedCollaborationTests(context) {
  const { test, temp, jsonl } = context;
  test('암호화된 서브에이전트 메시지를 통신·도구 기록에 노출하지 않는다', () => {
    const sendToken = 'gAAAAABprotectedSendPayload==';
    const followupToken = 'gAAAAABprotectedFollowupPayload==';
    const parent = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-encrypted-messages.jsonl'), [
      { timestamp: '2026-07-14T02:16:00Z', type: 'session_meta', payload: { id: 'encrypted-messages', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T02:16:01Z', type: 'response_item', payload: { type: 'function_call', name: 'send_message', namespace: 'collaboration', call_id: 'send-encrypted', arguments: JSON.stringify({ target: '/root/worker', message: sendToken }) } },
      { timestamp: '2026-07-14T02:16:02Z', type: 'response_item', payload: { type: 'function_call', name: 'followup_task', namespace: 'collaboration', call_id: 'followup-encrypted', arguments: JSON.stringify({ target: '/root/worker', message: followupToken }) } },
    ]));
    const protectedEvents = parent.collaboration.communications.filter(item => item.kind === 'message' || item.kind === 'followup');
    assert.deepStrictEqual(protectedEvents.map(item => [item.kind, item.text, item.protected]), [
      ['message', '', true],
      ['followup', '', true],
    ]);
    assert.equal(JSON.stringify(parent).includes(sendToken), false);
    assert.equal(JSON.stringify(parent).includes(followupToken), false);
  });

  test('기존 서브에이전트 interrupt 이벤트를 새 생성으로 중복 집계하지 않는다', () => {
    const parent = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-collaboration-interrupt.jsonl'), [
      { timestamp: '2026-07-14T02:20:00Z', type: 'session_meta', payload: { id: 'interrupt-parent', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T02:20:01Z', type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: 'spawn-original', arguments: JSON.stringify({ task_name: 'worker', message: '검사해줘' }) } },
      { timestamp: '2026-07-14T02:20:02Z', type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'spawn-original', agent_thread_id: 'interrupt-child', agent_path: '/root/worker', kind: 'started' } },
      { timestamp: '2026-07-14T02:20:03Z', type: 'response_item', payload: { type: 'function_call', name: 'interrupt_agent', namespace: 'collaboration', call_id: 'interrupt-later', arguments: JSON.stringify({ target: '/root/worker' }) } },
      { timestamp: '2026-07-14T02:20:04Z', type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'interrupt-later', agent_thread_id: 'interrupt-child', agent_path: '/root/worker', kind: 'interrupted' } },
    ]));
    const child = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-interrupt-child.jsonl'), [
      { timestamp: '2026-07-14T02:20:02Z', type: 'session_meta', payload: { id: 'interrupt-child', source: { subagent: { thread_spawn: { parent_thread_id: 'interrupt-parent', depth: 1, agent_path: '/root/worker' } } } } },
      { timestamp: '2026-07-14T02:20:04Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'done', completed_at: '2026-07-14T02:20:04Z' } },
    ]));
    const sessions = [parent, child];
    attachHierarchy(sessions);
    assert.equal(parent.collaboration.spawns.length, 1);
    assert.equal(parent.collaboration.spawns[0].callId, 'spawn-original');
    assert.equal(parent.collaboration.metrics.cumulativeCreated, 1);
    assert.equal(parent.childIds.length, 1);
    assert.equal(parent.collaboration.communications.some(item => item.kind === 'interrupt'), true);
  });

  test('fork로 상속된 부모의 과거 협업 호출을 서브에이전트가 만든 하위 작업으로 오인하지 않는다', () => {
    const child = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-forked-collaboration.jsonl'), [
      { timestamp: '2026-07-14T02:30:00Z', type: 'session_meta', payload: { id: 'forked-child', timestamp: '2026-07-14T02:30:00Z', source: { subagent: { thread_spawn: { parent_thread_id: 'forked-parent', depth: 1, agent_path: '/root/current_child' } } } } },
      { timestamp: '2026-07-14T02:29:00Z', type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: 'inherited-spawn', arguments: JSON.stringify({ task_name: 'older_sibling', message: '부모가 과거에 배정한 일' }) } },
      { timestamp: '2026-07-14T02:30:05Z', type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'inherited-spawn', occurred_at_ms: Date.parse('2026-07-14T02:29:01Z'), agent_thread_id: 'older-sibling', agent_path: '/root/older_sibling', kind: 'started' } },
      { timestamp: '2026-07-14T02:31:00Z', type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: 'own-spawn', arguments: JSON.stringify({ task_name: 'real_nested_child', message: '현재 서브가 새로 배정한 일' }) } },
      { timestamp: '2026-07-14T02:31:01Z', type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'own-spawn', occurred_at_ms: Date.parse('2026-07-14T02:31:01Z'), agent_thread_id: 'real-nested-child', agent_path: '/root/current_child/real_nested_child', kind: 'started' } },
    ]));
    assert.equal(child.collaboration.spawns.length, 1);
    assert.equal(child.collaboration.spawns[0].taskName, 'real_nested_child');
    assert.equal(child.collaboration.spawns[0].childId, 'codex:real-nested-child');
    assert.equal(child.collaboration.communications.some(item => item.taskName === 'older_sibling'), false);
    assert.equal(child.collaboration.communications.some(item => item.taskName === 'real_nested_child'), true);
  });

}

function registerCodexRecoveryTests(context) {
  const { test, temp, jsonl } = context;
  test('큰 Codex 로그가 잘려도 첫 세션 메타데이터를 보존한다', () => {
    const file = path.join(temp, 'codex', 'rollout-large-subagent.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const first = { timestamp: '2026-07-14T03:00:00Z', type: 'session_meta', payload: { id: 'large-child', timestamp: '2026-07-14T03:00:00Z', source: { subagent: { thread_spawn: { parent_thread_id: 'large-parent', depth: 1, agent_path: '/root/large_child', agent_nickname: 'Kepler' } } } } };
    const filler = { timestamp: '2026-07-14T03:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(12 * 1024 * 1024 + 2048) }] } };
    const inherited = { timestamp: '2026-07-14T03:00:02Z', type: 'session_meta', payload: { id: 'large-parent', source: 'vscode' } };
    fs.writeFileSync(file, [first, filler, inherited].map(row => JSON.stringify(row)).join('\n'));
    const stat = fs.statSync(file);
    const session = parseCodex({ file, mtimeMs: stat.mtimeMs, size: stat.size });
    assert.equal(session.id, 'codex:large-child');
    assert.equal(session.parentId, 'codex:large-parent');
    assert.equal(session.agentName, 'Kepler');
    assert.equal(session.taskName, 'large_child');
    assert.equal(session.truncated, true);

    const detail = parseCodex({ file, mtimeMs: stat.mtimeMs, size: stat.size }, { fullHistory: true });
    assert.equal(detail.fullHistory, true);
    assert.equal(detail.truncated, true);
    assert.equal(detail.id, 'codex:large-child');

    const oversizedJson = path.join(temp, 'gemini', 'oversized-session.json');
    fs.mkdirSync(path.dirname(oversizedJson), { recursive: true });
    fs.writeFileSync(oversizedJson, '{"id":"oversized"}', 'utf8');
    fs.truncateSync(oversizedJson, MAX_JSON_BYTES + 1);
    const oversizedStat = fs.statSync(oversizedJson);
    const boundedGeneric = parseGeneric({
      file: oversizedJson,
      mtimeMs: oversizedStat.mtimeMs,
      size: oversizedStat.size,
    }, 'gemini', { fullHistory: true });
    assert.equal(boundedGeneric.fullHistory, true);
    assert.equal(boundedGeneric.truncated, true);
    assert.equal(boundedGeneric.externalId, 'oversized-session');
  });

  test('부모 로그에 spawn 이벤트가 없어도 자식 세션으로 메인 대화 이력을 복원한다', () => {
    const parent = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-inferred-parent.jsonl'), [
      { timestamp: '2026-07-14T03:10:00Z', type: 'session_meta', payload: { id: 'inferred-parent', cwd: 'D:\\repo' } },
    ]));
    const child = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-inferred-child.jsonl'), [
      { timestamp: '2026-07-14T03:10:01Z', type: 'session_meta', payload: { id: 'inferred-child', source: { subagent: { thread_spawn: { parent_thread_id: 'inferred-parent', depth: 1, agent_path: '/root/inferred_task', agent_nickname: 'Darwin' } } } } },
      { timestamp: '2026-07-14T03:10:02Z', type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: '검사 결과 이상 없음' } },
      { timestamp: '2026-07-14T03:10:03Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'done', completed_at: '2026-07-14T03:10:03Z', last_agent_message: '검사 결과 이상 없음' } },
    ]));
    const sessions = [parent, child];
    attachHierarchy(sessions);
    assert.equal(parent.collaboration.spawns.length, 1);
    assert.equal(parent.collaboration.spawns[0].childId, child.id);
    assert.deepStrictEqual(parent.collaboration.communications.map(item => item.kind), ['assignment', 'started', 'result']);
    assert.equal(parent.collaboration.communications.every(item => item.childId === child.id), true);
    assert.equal(parent.collaboration.communications[2].text, '검사 결과 이상 없음');
  });

  test('Codex 내부 지침 대신 실제 사용자 목표를 카드 제목으로 사용한다', () => {
    const file = path.join(temp, 'codex', 'rollout-visible-title.jsonl');
    const session = parseCodex(jsonl(file, [
      { timestamp: '2026-07-14T02:00:00Z', type: 'session_meta', payload: { id: 'visible-title', cwd: 'D:\\repo', source: 'cli' } },
      { timestamp: '2026-07-14T02:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '<permissions instructions>Filesystem sandboxing defines which files can be read or written</permissions instructions>' } },
      { timestamp: '2026-07-14T02:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'You are `/root`, the primary agent in a team of agents collaborating to fulfill the user goals. All agents share the same directory and collaboration tools cannot be called from inside another tool.' } },
      { timestamp: '2026-07-14T02:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '완료된 서브에이전트는 기본으로 숨기고 펼쳐서 보게 해줘' } },
      { timestamp: '2026-07-14T02:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '<skill><name>efficiency-alarm-overnight-loop</name><instructions>내부 스킬 지침</instructions></skill>' } },
      { timestamp: '2026-07-14T02:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: '<codex_internal_context source="goal"><objective>실시간 토큰 게이지를 크게 보여줘</objective></codex_internal_context>' } },
      { timestamp: '2026-07-14T02:00:03Z', type: 'response_item', payload: { id: 'later-user', type: 'message', role: 'user', content: [{ type: 'input_text', text: '<codex_internal_context source="goal"><objective>서브에이전트 관계를 마인드맵으로 보여줘</objective></codex_internal_context>' }] } },
      { timestamp: '2026-07-14T02:00:04Z', type: 'event_msg', payload: { type: 'user_message', message: '<subagent_notification><agent_id>worker</agent_id><status>completed</status><summary>내부 완료 알림</summary></subagent_notification>' } },
    ]));
    assert.equal(session.title, '완료된 서브에이전트는 기본으로 숨기고 펼쳐서 보게 해줘');
    assert.equal(session.messages.some(item => /Filesystem sandboxing/.test(item.text)), false);
    assert.equal(session.messages.some(item => /efficiency-alarm-overnight-loop/.test(item.text)), false);
    assert.equal(session.messages.some(item => /실시간 토큰 게이지|서브에이전트 관계/.test(item.text)), false);
    assert.equal(session.messages.some(item => /subagent_notification|내부 완료 알림/.test(item.text)), false);
    assert.deepStrictEqual(session.loop, { kind: 'goal', iteration: 2 });
  });

  test('잘린 Codex 로그에 내부 목표만 남아도 마크업 없이 카드 제목을 복원한다', () => {
    const session = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-internal-goal-title.jsonl'), [
      { timestamp: '2026-07-14T02:10:00Z', type: 'session_meta', payload: { id: 'internal-goal-title', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T02:10:01Z', type: 'event_msg', payload: { type: 'user_message', message: '<codex_internal_context source="goal">\n<untrusted_objective>완료된 서브에이전트는 기본으로 숨겨줘</untrusted_objective>\n</codex_internal_context>' } },
    ]));
    assert.equal(session.title, '완료된 서브에이전트는 기본으로 숨겨줘');
    assert.equal(session.messages.some(item => item.role === 'user' || /codex_internal_context|untrusted_objective/.test(item.text)), false);
    assert.deepStrictEqual(session.loop, { kind: 'goal', iteration: 1 });
  });

  test('Codex 데스크톱 첨부파일 안내 대신 실제 요청을 카드 제목으로 사용한다', () => {
    const session = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-desktop-request-title.jsonl'), [
      { timestamp: '2026-07-14T02:20:00Z', type: 'session_meta', payload: { id: 'desktop-request-title', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T02:20:01Z', type: 'event_msg', payload: { type: 'user_message', message: '# Files mentioned by the user:\n\n## screenshot.png: C:/Temp/screenshot.png\n\n## My request for Codex:\n완료 에이전트를 보기 좋게 접어줘\n\n<image name="Image #1">' } },
    ]));
    assert.equal(session.title, '완료 에이전트를 보기 좋게 접어줘');
  });

  test('오래전에 끊긴 미완료 턴을 현재 작업 중으로 표시하지 않는다', () => {
    const codexFile = path.join(temp, 'codex', 'stale-running.jsonl');
    const codexInfo = jsonl(codexFile, [
      { timestamp: '2026-07-10T02:00:00Z', type: 'session_meta', payload: { id: 'stale-running', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-10T02:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'old-turn' } },
      { timestamp: '2026-07-10T02:00:02Z', type: 'response_item', payload: { type: 'function_call', call_id: 'orphan-shell', name: 'shell_command', arguments: '{"command":"npm test"}' } },
    ]);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(codexFile, old, old);
    codexInfo.mtimeMs = fs.statSync(codexFile).mtimeMs;
    const staleCodex = parseCodex(codexInfo);
    assert.equal(staleCodex.status, 'idle');
    assert.deepStrictEqual(staleCodex.executions.map(item => [item.mode, item.status, item.statusDetail]), [
      ['foreground', 'unverified', '최근 실행 활동이 확인되지 않음'],
    ]);

    const claudeFile = path.join(temp, 'claude', 'stale-waiting.jsonl');
    const claudeInfo = jsonl(claudeFile, [{ type: 'user', timestamp: '2026-07-10T02:00:00Z', message: { role: 'user', content: '오래된 요청' } }]);
    fs.utimesSync(claudeFile, old, old);
    claudeInfo.mtimeMs = fs.statSync(claudeFile).mtimeMs;
    assert.equal(parseClaude(claudeInfo).status, 'idle');

    const realNow = Date.now;
    const cacheClock = realNow();
    const cacheHome = path.join(temp, 'time-sensitive-cache-home');
    const cacheFile = path.join(cacheHome, '.claude', 'projects', 'cache-project', 'cache-refresh.jsonl');
    jsonl(cacheFile, [
      { type: 'user', timestamp: new Date(cacheClock - 4_000).toISOString(), message: { role: 'user', content: '서버를 켜고 진행 여부를 물어봐' } },
      { type: 'assistant', timestamp: new Date(cacheClock - 3_000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'cache-bg', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } },
      { type: 'user', timestamp: new Date(cacheClock - 2_000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cache-bg', content: 'Command running in background with ID: cache-42' }] } },
      { type: 'assistant', timestamp: new Date(cacheClock - 1_000).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '계속 진행할까요?' }] } },
    ]);
    const monitor = new AgentMonitor({ home: cacheHome });
    Date.now = () => cacheClock;
    try {
      const fresh = monitor.scanNow().sessions.find(session => session.externalId === 'cache-refresh');
      assert.equal(fresh.executions[0].status, 'running');
      Date.now = () => cacheClock + 6 * 60_000;
      const refreshed = monitor.scanNow().sessions.find(session => session.externalId === 'cache-refresh');
      assert.equal(refreshed.executions[0].status, 'unverified');
    } finally {
      Date.now = realNow;
    }
  });

}

function registerAgentParserTests(context) {
  registerClaudeParserTests(context);
  registerCodexParserTests(context);
  registerCollaborationSummaryTests(context);
  registerProtectedCollaborationTests(context);
  registerCodexRecoveryTests(context);
}

module.exports = { registerAgentParserTests };
