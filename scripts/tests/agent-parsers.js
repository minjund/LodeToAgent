'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseClaude, parseCodex, attachHierarchy, isProjectlessSession } = require('../../src/agentMonitor');

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
    assert.equal(session.title, '로그인 버그를 고쳐줘');
    assert.equal(session.usage.input, 280);
    assert.equal(session.usage.cachedInput, 50);
    assert.equal(session.usage.output, 60);
    assert.equal(session.context.window, 1_000_000);
    assert.ok(session.messages.some(item => item.type === 'tool'));
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
  });

  test('Claude 서브에이전트를 부모 세션에 연결한다', () => {
    const file = path.join(temp, 'claude', 'project', 'parent-session', 'subagents', 'agent-child-01.jsonl');
    const session = parseClaude(jsonl(file, [{ type: 'assistant', agentId: 'child-01', timestamp: '2026-07-14T01:00:02Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: '조사 완료' }], usage: { input_tokens: 10, output_tokens: 5 } } }]));
    assert.equal(session.parentId, 'claude:parent-session');
    assert.equal(session.depth, 1);
  });

  test('Claude 내부 명령 안내를 숨기고 최근 실제 요청을 제목으로 사용한다', () => {
    const file = path.join(temp, 'claude', 'project', 'visible-claude.jsonl');
    const session = parseClaude(jsonl(file, [
      { type: 'user', uuid: 'u0', timestamp: '2026-07-14T01:00:00Z', message: { role: 'user', content: '<local-command-caveat>Caveat: generated command</local-command-caveat>' } },
      { type: 'user', uuid: 'u1', timestamp: '2026-07-14T01:00:01Z', message: { role: 'user', content: '첫 번째 작업' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-07-14T01:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: '처리 중입니다.' }] } },
      { type: 'user', uuid: 'u2', timestamp: '2026-07-14T01:00:03Z', message: { role: 'user', content: '<objective>가장 최근 실제 작업</objective>' } },
      { type: 'user', uuid: 'u3', timestamp: '2026-07-14T01:00:04Z', message: { role: 'user', content: '<task-notification><task-id>worker</task-id><status>completed</status></task-notification>' } },
    ]));
    assert.equal(session.title, '가장 최근 실제 작업');
    assert.equal(session.messages.some(item => /local-command-caveat/.test(item.text)), false);
  });

}

function registerCodexParserTests(context) {
  const { test, temp, jsonl } = context;
  test('Codex thread, turn, item, token_count를 정규화한다', () => {
    const file = path.join(temp, 'codex', 'rollout-test.jsonl');
    const info = jsonl(file, [
      { timestamp: '2026-07-14T02:00:00Z', type: 'session_meta', payload: { id: 'codex-session', cwd: 'D:\\repo', originator: 'Codex Desktop', source: 'vscode', thread_source: 'user', git: { branch: 'main' } } },
      { timestamp: '2026-07-14T02:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.4', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T02:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1', started_at: '2026-07-14T02:00:02Z' } },
      { timestamp: '2026-07-14T02:00:03Z', type: 'event_msg', payload: { type: 'user_message', client_id: 'u1', message: '테스트를 실행해줘' } },
      { timestamp: '2026-07-14T02:00:04Z', type: 'response_item', payload: { type: 'function_call', id: 'call-1', call_id: 'call-1', name: 'shell_command', arguments: '{"command":"npm test"}' } },
      { timestamp: '2026-07-14T02:00:05Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 150, output_tokens: 30, reasoning_output_tokens: 20, total_tokens: 250 }, last_token_usage: { input_tokens: 120, output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 150 }, model_context_window: 258400 } } },
      { timestamp: '2026-07-14T02:00:06Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '완료', completed_at: '2026-07-14T02:00:06Z' } },
    ]);
    const session = parseCodex(info);
    assert.equal(session.id, 'codex:codex-session');
    assert.equal(session.model, 'gpt-5.4');
    assert.equal(session.title, '테스트를 실행해줘');
    assert.equal(session.usage.total, 250);
    assert.equal(session.context.window, 258400);
    assert.equal(session.status, 'idle');
    assert.equal(session.clientKind, 'codex-desktop');
  });

  test('Codex 데스크톱의 new-chat 임시 경로를 프로젝트 없는 세션으로 분류한다', () => {
    const projectless = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-projectless.jsonl'), [
      { timestamp: '2026-07-16T00:00:00Z', type: 'session_meta', payload: { id: 'projectless', cwd: '/Users/test/Documents/Codex/2026-07-16/new-chat', originator: 'Codex Desktop' } },
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
    assert.equal(child.sharedGoal, '버튼 정확도를 검사해줘');
    assert.equal(child.delegation.assignment, '버튼의 실제 동작을 검사해줘');
  });

  test('암호화된 spawn 지시는 직전 메인 AI 설명으로 복원한다', () => {
    const parent = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-encrypted-assignment.jsonl'), [
      { timestamp: '2026-07-14T02:15:00Z', type: 'session_meta', payload: { id: 'encrypted-assignment', cwd: 'D:\\repo' } },
      { timestamp: '2026-07-14T02:15:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { timestamp: '2026-07-14T02:15:02Z', type: 'event_msg', payload: { type: 'agent_message', message: '서브에이전트를 생성해 독립적으로 1 = 1을 확인시키겠습니다.' } },
      { timestamp: '2026-07-14T02:15:03Z', type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: 'spawn-encrypted', arguments: JSON.stringify({ task_name: 'equality_check', message: 'gAAAAABencryptedPayload' }) } },
    ]));
    const spawn = parent.collaboration.spawns[0];
    const assignment = parent.collaboration.communications.find(item => item.kind === 'assignment');
    assert.equal(spawn.assignment, '서브에이전트를 생성해 독립적으로 1 = 1을 확인시키겠습니다.');
    assert.equal(spawn.assignmentObserved, true);
    assert.equal(spawn.assignmentProtected, true);
    assert.equal(spawn.assignmentSource, 'parent-narration');
    assert.equal(assignment.text, spawn.assignment);
    assert.equal(assignment.protected, false);
    assert.equal(assignment.assignmentSource, 'parent-narration');
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
    ]));
    assert.equal(session.title, '완료된 서브에이전트는 기본으로 숨기고 펼쳐서 보게 해줘');
    assert.equal(session.messages.some(item => /Filesystem sandboxing/.test(item.text)), false);
    assert.equal(session.messages.some(item => /efficiency-alarm-overnight-loop/.test(item.text)), false);
    assert.equal(session.messages.some(item => /실시간 토큰 게이지|서브에이전트 관계/.test(item.text)), false);
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
    ]);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(codexFile, old, old);
    codexInfo.mtimeMs = fs.statSync(codexFile).mtimeMs;
    assert.equal(parseCodex(codexInfo).status, 'idle');

    const claudeFile = path.join(temp, 'claude', 'stale-waiting.jsonl');
    const claudeInfo = jsonl(claudeFile, [{ type: 'user', timestamp: '2026-07-10T02:00:00Z', message: { role: 'user', content: '오래된 요청' } }]);
    fs.utimesSync(claudeFile, old, old);
    claudeInfo.mtimeMs = fs.statSync(claudeFile).mtimeMs;
    assert.equal(parseClaude(claudeInfo).status, 'idle');
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
