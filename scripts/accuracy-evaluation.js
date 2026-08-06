'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  attachHierarchy,
  mergeManagedWithHistory,
  parseClaude,
} = require('../src/agentMonitor');
const { assistantRequestsUserResponse } = require('../src/agentMonitor/responseIntent');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-accuracy-'));
const checks = [];
const check = (label, passed) => checks.push({ label, passed: Boolean(passed) });
const jsonl = (file, rows, mtime = new Date()) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  fs.utimesSync(file, mtime, mtime);
  const stat = fs.statSync(file);
  return { file, mtimeMs: stat.mtimeMs, size: stat.size };
};

try {
  const now = Date.now();
  const activeRows = [
    { type: 'user', timestamp: new Date(now - 8_000).toISOString(), message: { role: 'user', content: '서브에이전트와 두 번 대화해줘' } },
    { type: 'assistant', timestamp: new Date(now - 7_000).toISOString(), message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'agent-call', name: 'Agent', input: { description: '토큰 확인', prompt: 'FIRST-91C2를 반환해줘' } },
    ] } },
    { type: 'user', timestamp: new Date(now - 6_000).toISOString(), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'agent-call', content: 'FIRST-91C2\nagentId: accuracy-child' },
    ] } },
    { type: 'assistant', timestamp: new Date(now - 5_000).toISOString(), message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'send-call', name: 'SendMessage', input: { to: 'accuracy-child', summary: '두 번째 토큰', message: 'SECOND-4DB8과 FIRST를 결합해줘', type: 'message' } },
    ] } },
    { type: 'user', timestamp: new Date(now - 4_000).toISOString(), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'send-call', content: '{"success":true,"resumedAgentId":"accuracy-child"}' },
    ] } },
    { type: 'assistant', timestamp: new Date(now - 3_000).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '후속 결과를 기다립니다.' }] } },
  ];
  const activeFile = path.join(temp, 'project', 'accuracy-parent.jsonl');
  const active = parseClaude(jsonl(activeFile, activeRows));
  const spawn = active.collaboration.spawns[0];
  const followup = active.collaboration.communications.find(event => event.kind === 'followup');
  check('active.parent.status', active.status === 'running');
  check('active.parent.detail', active.statusDetail === '도움 AI 작업 진행 중');
  check('active.spawn.count', active.collaboration.spawns.length === 1);
  check('active.spawn.status', spawn.status === 'running');
  check('active.spawn.child', spawn.childId === 'claude:accuracy-child');
  check('active.spawn.assignment', spawn.assignment === 'FIRST-91C2를 반환해줘');
  check('active.communication.count', active.collaboration.communications.length === 4);
  check('active.communication.kinds', active.collaboration.communications.map(event => event.kind).join(',') === 'assignment,started,result,followup');
  check('active.followup.count', active.collaboration.communications.filter(event => event.kind === 'followup').length === 1);
  check('active.followup.text', followup.text === 'SECOND-4DB8과 FIRST를 결합해줘');
  check('active.followup.to', followup.to === 'claude:accuracy-child');
  check('active.followup.child', followup.childId === 'claude:accuracy-child');
  check('active.initial.result', active.collaboration.communications.find(event => event.kind === 'result').text.includes('FIRST-91C2'));
  check('active.spawn.not-completed', spawn.completedAt == null);
  check('active.spawn.last-sent', Boolean(spawn.lastSentAt));

  const child = parseClaude(jsonl(path.join(temp, 'project', 'accuracy-parent', 'subagents', 'agent-accuracy-child.jsonl'), [
    { type: 'user', timestamp: new Date(now - 7_000).toISOString(), message: { role: 'user', content: 'FIRST-91C2를 반환해줘' } },
    { type: 'assistant', timestamp: new Date(now - 6_000).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'FIRST-91C2' }] } },
  ]));
  attachHierarchy([active, child]);
  check('hierarchy.parent-child', active.childIds.includes(child.id));
  check('hierarchy.assignment', child.delegation.assignment === 'FIRST-91C2를 반환해줘');
  check('hierarchy.followup-keeps-running', active.collaboration.spawns[0].status === 'running');
  check('hierarchy.followup-clears-completion', child.delegation.completedAt == null);
  check('hierarchy.child-observed-complete', child.status === 'completed');

  const completed = parseClaude(jsonl(path.join(temp, 'project', 'accuracy-completed.jsonl'), [
    ...activeRows.slice(0, -1),
    { type: 'queue-operation', operation: 'enqueue', timestamp: new Date(now - 2_000).toISOString(), content: '<task-notification><task-id>accuracy-child</task-id><tool-use-id>send-call</tool-use-id><status>completed</status><result>FIRST-91C2 SECOND-4DB8</result></task-notification>' },
    { type: 'assistant', uuid: 'completed-final-answer', timestamp: new Date(now - 1_000).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '왕복 완료' }] } },
  ]));
  const completedResults = completed.collaboration.communications.filter(event => event.kind === 'result');
  check('completed.parent.status', completed.status === 'completed');
  check('completed.spawn.status', completed.collaboration.spawns[0].status === 'completed');
  check('completed.spawn.completed-at', Boolean(completed.collaboration.spawns[0].completedAt));
  check('completed.spawn.result', completed.collaboration.spawns[0].result === 'FIRST-91C2 SECOND-4DB8');
  check('completed.communication.count', completed.collaboration.communications.length === 5);
  check('completed.communication.last-kind', completed.collaboration.communications.at(-1).kind === 'result');
  check('completed.communication.last-text', completed.collaboration.communications.at(-1).text === 'FIRST-91C2 SECOND-4DB8');
  check('completed.communication.last-child', completed.collaboration.communications.at(-1).childId === 'claude:accuracy-child');
  check('completed.result-rounds', completedResults.length === 2);
  check('completed.parent.detail', completed.statusDetail === '작업 완료');

  const waitingQuestion = parseClaude(jsonl(path.join(temp, 'states', 'question.jsonl'), [
    { type: 'assistant', timestamp: new Date(now - 1_000).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Windows와 WSL 중 무엇을 선택할까요?' }] } },
  ]));
  const waitingTool = parseClaude(jsonl(path.join(temp, 'states', 'input-tool.jsonl'), [
    { type: 'assistant', timestamp: new Date(now - 1_000).toISOString(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { question: '선택' } }] } },
  ]));
  const staleTime = new Date(now - 10 * 60_000);
  const idle = parseClaude(jsonl(path.join(temp, 'states', 'idle.jsonl'), [
    { type: 'assistant', timestamp: staleTime.toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '작업을 완료했습니다.' }] } },
  ], staleTime));
  const responding = parseClaude(jsonl(path.join(temp, 'states', 'responding.jsonl'), [
    { type: 'user', timestamp: new Date(now - 1_000).toISOString(), message: { role: 'user', content: '계속 진행해줘' } },
  ]));
  check('states.question.status', waitingQuestion.status === 'waiting');
  check('states.question.detail', waitingQuestion.statusDetail === '내 답변을 기다리는 중');
  check('states.input-tool.status', waitingTool.status === 'waiting');
  check('states.input-tool.detail', waitingTool.statusDetail === '내 답변을 기다리는 중');
  check('states.idle.status', idle.status === 'completed');
  check('states.idle.detail', idle.statusDetail === '작업 완료');
  check('states.responding.status', responding.status === 'running');
  check('states.responding.detail', responding.statusDetail === '응답 생성 중');

  const managed = mergeManagedWithHistory(completed, {
    ...completed,
    source: 'loadtoagent',
    runId: 'accuracy-managed',
    file: 'managed-events.jsonl',
    messages: [{ id: 'managed-final', role: 'assistant', text: '관리 실행 완료', timestamp: new Date(now).toISOString() }],
    childIds: [],
    collaboration: { capacity: {}, spawns: [], communications: [], retainedAgents: [] },
  });
  check('merge.source', managed.source === 'loadtoagent');
  check('merge.run-id', managed.runId === 'accuracy-managed');
  check('merge.history-file', managed.historyFile === completed.file);
  check('merge.spawns', managed.collaboration.spawns.length === 1);
  check('merge.communications', managed.collaboration.communications.length === 5);
  check('merge.managed-message', managed.messages.some(message => message.id === 'managed-final'));
  check('merge.history-message', managed.messages.some(message => message.text === '왕복 완료'));

  check('intent.question', assistantRequestsUserResponse('어느 환경을 선택할까요?'));
  check('intent.korean-request', assistantRequestsUserResponse('원하는 값을 알려주세요.'));
  check('intent.english-request', assistantRequestsUserResponse('Please choose Windows or WSL.'));
  check('intent.optional-not-waiting',
    !assistantRequestsUserResponse('추가 질문이 있으면 알려주세요.')
    && !assistantRequestsUserResponse('필요하시면 OPS 파일로 저장해 드리겠습니다. 저장할까요?'));
  check('intent.completion-not-waiting', !assistantRequestsUserResponse('모든 작업을 완료했습니다.'));

  const passed = checks.filter(item => item.passed).length;
  const score = Number((passed / checks.length * 10).toFixed(2));
  for (const item of checks.filter(item => !item.passed)) console.error(`FAIL ${item.label}`);
  console.log(`정확도 체크포인트: ${passed}/${checks.length}`);
  console.log(`정확도 점수: ${score.toFixed(2)}/10`);
  if (checks.length !== 50 || score <= 9.8) process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
