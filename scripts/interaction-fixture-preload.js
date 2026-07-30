'use strict';

const { contextBridge } = require('electron');
const { enrichSession } = require('../src/sessionIntelligence');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const now = new Date().toISOString();
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const lastDaily = (hour, minute = 0) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  if (date > new Date()) date.setDate(date.getDate() - 1);
  return date.toISOString();
};
const nextDaily = (hour, minute = 0) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  if (date <= new Date()) date.setDate(date.getDate() + 1);
  return date.toISOString();
};
const nextWeekday = (weekday, hour, minute = 0) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  const daysAhead = (weekday - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + daysAhead);
  if (date <= new Date()) date.setDate(date.getDate() + 7);
  return date.toISOString();
};

const providers = [
  {
    id: 'claude', label: 'Claude', company: 'Anthropic', accent: '#d58b5b', mark: 'C', installed: true,
    docs: 'https://example.test/claude',
  },
  {
    id: 'gpt', label: 'GPT', company: 'OpenAI', accent: '#63d6b1', mark: 'G', installed: true,
    docs: 'https://example.test/gpt',
  },
  {
    id: 'gemini', label: 'Gemini', company: 'Google', accent: '#6da8ff', mark: 'Ge', installed: true,
    docs: 'https://example.test/gemini',
  },
  {
    id: 'grok', label: 'Grok', company: 'xAI', accent: '#c394ff', mark: 'X', installed: true,
    docs: 'https://example.test/grok',
  },
  {
    id: 'codex', label: 'GPT 코딩 도우미', company: 'OpenAI', accent: '#4fd1a7', mark: 'Cx', installed: true,
    docs: 'https://example.test/codex',
  },
];

const usage = { input: 1200, output: 540, cachedInput: 100, cacheWrite: 0, reasoning: 80, total: 1920 };
const context = { used: 5200, window: 128000, percent: 4.1, source: 'session' };
const messages = [
  { id: 'm-user', role: 'user', text: '상호작용 테스트를 진행해줘', timestamp: now },
  { id: 'm-assistant', role: 'assistant', text: '버튼과 입력 동작을 확인하고 있습니다.', timestamp: now },
];

const rootSession = {
  id: 'fixture-root', externalId: 'fixture-root-external', provider: 'claude', model: 'Claude',
  title: '화면 설명과 버튼을 쉽게 개선하기', shortTitle: '화면 개선 결과를 확인하고 필요한 문구 수정', displayName: '화면 개선 결과를 확인하고 필요한 문구 수정', cwd: 'D:\\fixture', originCwd: 'D:\\fixture', workspace: '화면 개선 작업', status: 'running',
  statusDetail: '화면 개선 결과를 확인하고 필요한 문구를 수정하는 중', startedAt: lastDaily(22), updatedAt: now, parentId: null, childIds: ['fixture-child', 'fixture-resting'],
  messages, usage, turnUsage: usage, context, runId: 'fixture-run',
  lifecycle: [{ type: 'tool', status: 'running', label: '화면 개선 결과를 확인하고 필요한 문구를 수정하는 중', detail: '결과를 확인한 뒤 버튼 설명과 화면 배치를 수정', timestamp: now }],
  executions: [
    { id: 'fixture-shell-running', callId: 'fixture-shell-running', kind: 'shell', mode: 'background', tool: 'exec_command', runtime: 'PowerShell', label: '프로그램 실행 작업', command: 'npm run dev', cwd: 'D:\\fixture', status: 'running', statusDetail: '다른 화면을 보고 있어도 계속 실행됨', output: '화면 미리보기가 실행 중입니다.', backgroundId: 'fixture-cell-1', backgroundIdType: 'cell', exitCode: null, startedAt: now, updatedAt: now, completedAt: null, source: 'tool-call' },
    { id: 'fixture-shell-completed', callId: 'fixture-shell-completed', kind: 'shell', mode: 'foreground', tool: 'shell_command', runtime: 'PowerShell', label: '기존 기능 다시 확인', command: 'npm test', cwd: 'D:\\fixture', status: 'completed', statusDetail: '문제 없이 완료', output: '128개 테스트 통과\n실패 0개', backgroundId: '', backgroundIdType: '', exitCode: 0, startedAt: now, updatedAt: now, completedAt: now, source: 'tool-call' },
    { id: 'fixture-background-running', callId: 'fixture-background-running', kind: 'background', mode: 'background', tool: 'background_job', runtime: 'Background', label: '화면 목록 새로 정리', command: '', cwd: 'D:\\fixture', status: 'running', statusDetail: '다른 화면을 보고 있어도 계속 실행됨', output: '', backgroundId: 'fixture-task-2', backgroundIdType: 'task', exitCode: null, startedAt: now, updatedAt: now, completedAt: null, source: 'tool-call' },
  ],
  runtimePresence: [{ kind: 'terminal', terminalId: 'terminal-main', pid: 41001, label: '내 컴퓨터에서 실행하는 작업' }],
  sourceLabel: '화면 작업 기록',
  collaboration: {
    communications: [
      { id: 'resting-assignment', kind: 'assignment', label: '새 작업 배정', from: '/root', to: '/root/resting_check', taskName: 'resting_check', childId: 'fixture-resting', text: '완료된 테스트를 다시 검토해줘', timestamp: now },
      { id: 'resting-protected-followup', kind: 'followup', label: '추가 작업 지시', from: '/root', to: '/root/resting_check', taskName: 'resting_check', childId: 'fixture-resting', text: 'gAAAAABfixtureProtectedPayload==', protected: true, timestamp: now },
      { id: 'resting-started', kind: 'started', label: '서브에이전트 실행 시작', from: 'Codex 런타임', to: '/root/resting_check', taskName: 'resting_check', childId: 'fixture-resting', text: 'started', timestamp: now },
      { id: 'resting-result', kind: 'result', label: '결과 반환', from: '/root/resting_check', to: '/root', taskName: 'resting_check', childId: 'fixture-resting', text: '검토 결과 이상이 없습니다.', timestamp: now },
    ],
    metrics: { cumulativeCreated: 3, simultaneousCapacity: 3, currentlyRunning: 1, completedRecords: 2, retainedCount: 3, capacitySource: 'runtime-instruction' },
  },
};

const childSession = {
  ...rootSession, id: 'fixture-child', externalId: 'fixture-child-external', provider: 'gpt', model: 'GPT',
  title: '처음 보는 사람도 화면의 작업 흐름을 바로 이해하는지 확인', parentId: 'fixture-root', childIds: ['fixture-grandchild'], agentName: '화면 확인 AI', agentRole: 'tester',
  statusDetail: '첫 화면과 대화 입력 방법을 확인하는 중',
  responseIntent: { category: 'none', required: false, optional: false },
  messages: [
    { id: 'm-user', role: 'user', text: '상호작용 테스트를 진행해줘', timestamp: now },
    { id: 'm-assistant', role: 'assistant', text: '버튼과 입력 동작을 확인하고 있습니다.', timestamp: now },
    { id: 'child-user', role: 'user', text: '홈에서 실행 구조가 즉시 읽히는지, 서브에이전트 대화에 직접 참여할 수 있는지 검증해줘.', timestamp: now },
    { id: 'child-assistant', role: 'assistant', text: '실행 구조, 대화 기록, 직접 개입과 메인 에이전트 경유 개입을 순서대로 확인하고 있습니다.', timestamp: now },
  ],
  delegation: {
    taskName: 'control_room_audit',
    assignment: '홈 화면에서 메인 에이전트, 서브에이전트, PowerShell의 실행 흐름이 클릭 없이 보이는지 확인하고 대화 참여 경로까지 검증해줘.',
  },
  runtimePresence: [{ kind: 'windows', pid: 41006, parentPid: 40000, label: '공유 메인 프로세스' }], executions: [], runId: '', collaboration: { communications: [
    { id: 'nested-assignment', kind: 'assignment', label: '새 작업 배정', from: '/root/child', to: '/root/child/nested_check', taskName: 'nested_check', childId: 'fixture-grandchild', text: '하위 흐름을 검증해줘', timestamp: now },
    { id: 'nested-started', kind: 'started', label: '서브에이전트 실행 시작', from: 'Codex 런타임', to: '/root/child/nested_check', taskName: 'nested_check', childId: 'fixture-grandchild', text: 'started', timestamp: now },
    { id: 'nested-result', kind: 'result', label: '결과 반환', from: '/root/child/nested_check', to: '/root/child', taskName: 'nested_check', childId: 'fixture-grandchild', text: '중첩 흐름 정상', timestamp: now },
  ] },
};

const grandchildSession = {
  ...childSession, id: 'fixture-grandchild', externalId: 'fixture-grandchild-external', provider: 'codex', model: 'gpt-fixture',
  title: '함께 작업하는 AI의 연결 상태 확인', taskName: 'nested_check', parentId: 'fixture-child', childIds: [], agentName: '연결 확인 AI',
  status: 'completed', statusDetail: '연결 확인 완료', runtimePresence: [], runId: '',
  result: '중첩 흐름 정상', delegation: { taskName: 'nested_check', result: '중첩 흐름 정상' },
};

const restingSession = {
  ...childSession, id: 'fixture-resting', externalId: 'fixture-resting-external', provider: 'codex', model: 'gpt-fixture',
  title: '완료된 도움 작업 다시 확인', taskName: 'resting_check', parentId: 'fixture-root', childIds: [], agentName: '결과 확인 AI',
  status: 'completed', statusDetail: '작업을 마치고 내 다음 요청을 기다리는 중', runtimePresence: [], runId: '',
  result: '검토 결과 이상이 없습니다.', delegation: { taskName: 'resting_check', result: '검토 결과 이상이 없습니다.' },
};

const endedSession = {
  ...rootSession, id: 'fixture-ended', externalId: 'fixture-ended-external', provider: 'gpt', model: 'gpt-fixture',
  title: '화면 개선 작업의 처리 기록', status: 'completed', statusDetail: '처리 완료 · 컴퓨터 작업 기록과 저장된 결과는 없음', parentId: null, childIds: [],
  runtimePresence: [], executions: [], runId: '',
  messages: [
    { id: 'ended-user', role: 'user', text: '이 요청은 상세 대화에서 생략하지 말고 전체 내용을 보여주되, AI가 만든 긴 로드맵은 처음부터 전부 펼치지 말고 읽기 좋은 형태로 정리해줘. 사용자 프롬프트가 길어져도 대화 흐름을 한눈에 읽을 수 있도록 처음 200자까지만 미리 보여주고 나머지는 전체 보기 버튼으로 확인할 수 있게 해줘. 전체 내용을 펼친 상태에서는 닫기 버튼으로 다시 간단히 접을 수 있어야 하고, 화면이 자동으로 새로고침되어도 사용자가 선택한 펼침 상태가 유지되어야 해. 또한 원문을 손실 없이 클립보드로 옮길 수 있도록 각 사용자 프롬프트마다 복사 버튼을 제공하고 실제 전체 문장이 복사되는지도 검증해줘.', timestamp: now },
    { id: 'ended-progress', role: 'assistant', text: '먼저 상세 대화 구조와 반응형 화면을 확인하겠습니다.', timestamp: now },
    { id: 'ended-hidden-tool', role: 'tool', title: '검사 도구', text: '대화 탭에서 숨겨야 하는 도구 시스템 활동', timestamp: now },
    { id: 'ended-roadmap', role: 'assistant', text: `## 반응형 UI 개선 로드맵

1. 현재 목표 카드에서 긴 사용자 요청을 의미가 보존되는 한 줄 요약으로 표시합니다.
2. 요약된 목표의 전체 원문은 제목 속성과 상세 대화 기록에서 언제든 확인할 수 있게 유지합니다.
3. 세션 상세에 생성된 긴 로드맵은 기본 상태에서 핵심 세 단계만 미리 보여줍니다.
4. 사용자가 로드맵 헤더를 누르면 모든 단계와 설명이 손실 없이 펼쳐지도록 구성합니다.
5. 새 AI 작업 창에서는 할 일 입력을 가장 먼저 배치하고 AI와 폴더 선택을 다음 단계로 분리합니다.
6. 작은 화면에서는 제공사 선택과 폴더 입력, 하단 실행 버튼이 화면 밖으로 밀려나지 않는지 확인합니다.
7. 키보드 단축키와 빠른 요청 예시, 글자 수 표시가 실제 입력 흐름에서 정확하게 작동하는지 검증합니다.
8. 마지막으로 데스크톱과 모바일 크기에서 수평 스크롤과 카드 넘침이 없는지 자동 테스트합니다.`, timestamp: now },
  ],
  lifecycle: [
    { type: 'start', status: 'completed', label: '작업 시작', detail: '상세 화면 확인', timestamp: now },
    { type: 'complete', status: 'completed', label: '작업 완료', detail: '정상 완료', timestamp: now },
  ],
};

const waitingSession = {
  ...endedSession, id: 'fixture-waiting', externalId: 'fixture-waiting-external', provider: 'gemini',
  title: '왼쪽 메뉴 이름을 ‘내 요청’으로 바꾸는 것을 승인해 주세요.', status: 'waiting', statusDetail: '내 승인이 필요한 작업',
  messages: [
    { id: 'waiting-user', role: 'user', text: '화면 설명을 더 쉽게 바꿔 주세요.', timestamp: now },
    { id: 'waiting-assistant', role: 'assistant', text: '바꿀 화면: 왼쪽 메뉴 · 현재 왼쪽 메뉴 이름: “답변·확인” · 새 왼쪽 메뉴 이름: “내 요청” · 바뀌는 위치: 왼쪽 메뉴, 하단 메뉴 · 기능 변경: 없음', timestamp: now },
  ],
  responseIntent: {
    category: 'required', required: true, optional: false,
    requestText: '왼쪽 메뉴 이름 “답변·확인”을 “내 요청”으로 바꾸려 합니다. 이대로 진행해도 될까요?',
    confidence: 'high', source: 'assistant-message',
  },
};

const optionalSession = {
  ...endedSession, id: 'fixture-optional', externalId: 'fixture-optional-external', provider: 'claude',
  title: '변경 내용을 글로 정리할지 답변이 필요한 작업', status: 'idle', statusDetail: '다음 요청 대기',
  responseIntent: {
    category: 'optional', required: false, optional: true,
    requestText: '원하시면 변경 내역도 문서화해 드릴까요?',
    confidence: 'high', source: 'assistant-message',
  },
};

const failedSession = {
  ...endedSession, id: 'fixture-failed', externalId: 'fixture-failed-external', provider: 'codex',
  title: 'GPT 코딩 도우미 작업의 완료 여부 확인', status: 'failed', statusDetail: '완료 여부를 자동으로 확인하지 못했습니다.',
  runId: 'fixture-failed-run', completionObserved: true,
};

const pausedSession = {
  ...rootSession, id: 'fixture-paused-run', externalId: 'fixture-paused-external', provider: 'claude',
  title: '잠시 멈춘 화면 확인 작업', status: 'paused', statusDetail: '사용자가 작업을 잠시 멈춤',
  runId: 'fixture-paused-run', runtimePresence: [], executions: [], childIds: [],
};

const extraLiveNames = [
  '설정 화면 설명 확인',
  '버튼 이름 확인',
  '자동 시작 화면 문구 확인',
  '컴퓨터 작업 안내 확인',
  '다른 컴퓨터의 관련 작업을 보여 주는 화면 설명 확인',
  '지난 작업 검색 안내 확인',
  '요청 분류 설명 확인',
];
const extraLiveSessions = Array.from({ length: 7 }, (_, index) => ({
  ...rootSession,
  id: `fixture-live-${index}`,
  externalId: `fixture-live-${index}-external`,
  title: extraLiveNames[index],
  shortTitle: extraLiveNames[index],
  childIds: [],
  runtimePresence: [],
  ...(index === 0 ? {
    cwd: '/mnt/c/Users/fixture/board-migration-loop',
    environment: { kind: 'wsl', distro: 'FixtureLinux', label: 'WSL · FixtureLinux' },
  } : {}),
  executions: [],
  runId: '',
  loop: index < 5 ? {
    iteration: index + 1,
    phase: index === 0 ? 'act' : 'observe',
    scheduleName: [
      '매일 09:00 설정 화면 확인',
      '매일 10:00 버튼 이름 확인',
      '매일 11:00 자동 시작 화면 확인',
      '매일 12:00 컴퓨터 작업 안내 확인',
      '매일 13:00 작업 모음 설명 확인',
    ][index],
  } : null,
}));

const originSession = {
  ...rootSession,
  id: 'fixture-origin',
  externalId: 'fixture-origin-external',
  provider: 'codex',
  title: '화면 개선 폴더의 GPT 대화창',
  childIds: [],
  runtimePresence: [{ kind: 'windows', pid: 41999, label: 'Codex 데스크톱 앱' }],
  executions: [],
  runId: '',
  clientKind: 'codex-desktop',
  cwd: 'D:\\moved-worktree',
  originCwd: 'D:\\unregistered-origin',
  workspace: 'unregistered-origin',
};

const projectlessSession = {
  ...endedSession,
  id: 'fixture-projectless',
  externalId: 'fixture-projectless-external',
  provider: 'codex',
  title: '화면 설명을 이해하기 쉽게 고치기',
  cwd: 'C:\\Users\\fixture\\Documents\\Codex\\2026-07-16\\new-chat',
  originCwd: 'C:\\Users\\fixture\\Documents\\Codex\\2026-07-16\\new-chat',
  workspace: 'new-chat',
  clientKind: 'codex-desktop',
};

const extraEndedSessions = Array.from({ length: 34 }, (_, index) => ({
  ...endedSession,
  id: `fixture-history-${index}`,
  externalId: `fixture-history-${index}-external`,
  title: index === 0 ? '오류가 난 작업 다시 시작하기' : `지난 작업 ${String(index + 1).padStart(2, '0')}`,
  provider: index % 2 ? 'gpt' : 'gemini',
  updatedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
}));

const staleIdleSession = {
  ...endedSession,
  id: 'fixture-stale-idle',
  externalId: 'fixture-stale-idle-external',
  provider: 'claude',
  title: '화면 개선 작업 결과 확인',
  status: 'idle',
  statusDetail: '연결된 AI 대화창을 선택해 Claude에게 새 요청을 보내세요.',
  cwd: 'D:\\fixture',
  originCwd: 'D:\\fixture',
  workspace: 'fixture',
  updatedAt: twoHoursAgo,
  messages: [{ id: 'stale-assistant', role: 'assistant', text: '대기합니다.', timestamp: twoHoursAgo }],
};

const oldParentWithRunningChild = {
  ...staleIdleSession,
  id: 'fixture-old-parent',
  externalId: 'fixture-old-parent-external',
  title: '화면 설명 변경 방법 선택',
  status: 'waiting',
  statusDetail: '이 카드를 눌러 요청을 이 화면에서 열고, 화면 설명 변경 방법을 선택하세요.',
  cwd: '/mnt/c/Users/fixture/nested-active-project',
  originCwd: '/mnt/c/Users/fixture/nested-active-project',
  workspace: '다시 시작한 작업',
  childIds: ['fixture-running-child'],
};
const runningChildOfOldParent = {
  ...rootSession,
  id: 'fixture-running-child',
  externalId: 'fixture-running-child-external',
  title: '이전 작업에서 계속 도움을 주는 AI',
  parentId: oldParentWithRunningChild.id,
  childIds: [],
  cwd: oldParentWithRunningChild.cwd,
  originCwd: oldParentWithRunningChild.originCwd,
  workspace: oldParentWithRunningChild.workspace,
  executions: [],
  runtimePresence: [{ kind: 'tmux', paneId: 'fixture-nested-pane', label: '다른 컴퓨터 · 컴퓨터 작업 창' }],
  runId: '',
};

const tmuxPane = {
  id: 'tmux-pane-id', nativeId: '%7', index: 0, pid: 51001, active: true, dead: false,
  command: 'claude', cwd: '/tmp/fixture', displayFolder: '화면 개선 작업', title: '화면 개선 컴퓨터 작업', displayName: '진행 중: 결과 화면 문구 수정',
  agent: { ...rootSession, linkedSessionId: 'fixture-root', pid: 51001 },
};
const unlinkedTmuxPane = {
  ...tmuxPane, id: 'tmux-pane-unlinked', nativeId: '%8', index: 1, pid: 51002, active: false,
  cwd: '/mnt/c/Users/fixture/tmux-only-project', displayName: '진행 중: 여러 작업 안내 문구 수정',
  agent: { ...rootSession, id: 'tmux-unlinked-agent', linkedSessionId: '', pid: 51002, title: '다른 컴퓨터에서 화면 설명 고치기' },
};
const staleIdleTmuxPane = {
  ...tmuxPane, id: 'tmux-pane-stale-idle', nativeId: '%10', index: 2, pid: 51004, active: false,
  cwd: 'D:\\fixture', displayName: '완료: 화면 개선 결과 확인',
  agent: { ...staleIdleSession, linkedSessionId: staleIdleSession.id, pid: 51004 },
};
const deadTmuxPane = {
  ...tmuxPane, id: 'tmux-pane-dead', nativeId: '%9', index: 3, pid: 51003, active: false, dead: true, displayName: '종료된 확인 창',
  agent: { ...rootSession, id: 'tmux-dead-agent', linkedSessionId: '', pid: 51003 },
};
const tmuxWindow = { id: 'tmux-window-id', nativeId: '@3', index: 0, name: 'fixture-window', displayName: '화면 개선', active: true, panes: [tmuxPane, unlinkedTmuxPane, staleIdleTmuxPane, deadTmuxPane] };
const tmuxSession = { id: 'tmux-session-id', nativeId: '$2', name: 'fixture-session', displayName: '화면 개선', attached: false, windows: [tmuxWindow] };
const tmuxDistro = { id: 'tmux-distro-id', name: 'FixtureLinux', displayName: '화면 개선', tmuxVersion: 'tmux 3.4', sessions: [tmuxSession] };

const sessionRecords = [
  rootSession, childSession, grandchildSession, restingSession, originSession, projectlessSession,
  ...extraLiveSessions, endedSession, waitingSession, optionalSession, failedSession, pausedSession, staleIdleSession,
  oldParentWithRunningChild, runningChildOfOldParent, ...extraEndedSessions,
];
const enrichedSessionRecords = sessionRecords
  .map(session => enrichSession(session, sessionRecords, Date.now()))
  .map(session => session.id === 'fixture-child' ? {
    ...session,
    attention: {
      category: 'none', required: false, actionable: false, kind: 'none',
      summary: '', requestedAt: now, source: 'structured-input', confidence: 'high',
    },
  } : session)
  .map(session => session.id === 'fixture-waiting' ? {
    ...session,
    attention: {
      category: 'required', required: true, actionable: true, kind: 'approval',
      summary: '바꿀 화면: 왼쪽 메뉴 · 현재 왼쪽 메뉴 이름: “답변·확인” · 새 왼쪽 메뉴 이름: “내 요청” · 바뀌는 위치: 왼쪽 메뉴, 하단 메뉴 · 기능 변경: 없음',
      requestedAt: now, source: 'assistant-message', confidence: 'high',
    },
    controlCapabilities: { ...(session.controlCapabilities || {}), sendInstruction: true },
  } : session);

const snapshot = {
  generatedAt: now,
  sessions: enrichedSessionRecords,
  automations: [
    {
      id: 'fixture-daily', kind: 'cron', name: '매일 22:00 화면 개선 결과 확인과 문구 수정', status: 'ACTIVE', enabled: true,
      rrule: 'FREQ=DAILY;BYHOUR=22;BYMINUTE=0', nextRunAt: nextDaily(22),
      provider: 'codex', model: 'gpt-fixture', targetThreadId: 'fixture-root-external', cwds: ['D:\\fixture'],
      createdAt: now, updatedAt: now,
    },
    {
      id: 'fixture-report', kind: 'cron', name: '아침 결과 보고', status: 'ACTIVE', enabled: true,
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', nextRunAt: nextDaily(9),
      provider: 'codex', model: 'gpt-fixture', targetThreadId: '', cwds: ['D:\\fixture'],
      createdAt: now, updatedAt: now,
    },
    {
      id: 'fixture-biweekly', kind: 'cron', name: '격주 금요일 검수', status: 'ACTIVE', enabled: true,
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=18;BYMINUTE=30', nextRunAt: nextWeekday(5, 18, 30),
      provider: 'codex', model: 'gpt-fixture', targetThreadId: '', cwds: ['D:\\fixture'],
      createdAt: now, updatedAt: now,
    },
    {
      id: 'fixture-hourly', kind: 'cron', name: '화면 개선 작업의 진행 상태를 2시간마다 확인', status: 'ACTIVE', enabled: true,
      rrule: 'FREQ=HOURLY;INTERVAL=2;BYMINUTE=15', nextRunAt: nextDaily(20, 15),
      provider: 'codex', model: 'gpt-fixture', targetThreadId: '', cwds: ['D:\\fixture'],
      createdAt: now, updatedAt: now,
    },
    {
      id: 'fixture-boundary', kind: 'cron', name: '화면 문구 확인', status: 'ACTIVE', enabled: true,
      rrule: 'FREQ=DAILY;BYHOUR=23;BYMINUTE=0', nextRunAt: nextDaily(23),
      provider: 'codex', model: 'gpt-fixture', targetThreadId: '', cwds: ['D:\\fixture-other'],
      createdAt: now, updatedAt: now, sourceLabel: '다른 컴퓨터', environment: { kind: 'wsl', distro: 'FixtureLinux' },
    },
    {
      id: 'fixture-projectless', kind: 'cron', name: '백업 결과 확인', status: 'ACTIVE', enabled: true,
      rrule: 'FREQ=DAILY;BYHOUR=23;BYMINUTE=30', nextRunAt: nextDaily(23, 30),
      provider: 'codex', model: 'gpt-fixture', targetThreadId: '', cwds: [],
      createdAt: now, updatedAt: now, sourceLabel: '내 컴퓨터', environment: { kind: 'windows', distro: '' },
    },
    {
      id: 'fixture-paused', kind: 'cron', name: '잠시 멈춘 야간 검수', status: 'PAUSED', enabled: false,
      rrule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0', nextRunAt: null,
      provider: 'codex', model: 'gpt-fixture', targetThreadId: '', cwds: ['D:\\fixture'],
      createdAt: now, updatedAt: now,
    },
  ],
  summary: {
    totals: { sessions: 48, active: 10, waiting: 1, subagents: 3, usage },
    providers: providers.map(provider => ({ ...provider, sessions: 1, active: provider.id === 'claude' ? 8 : (provider.id === 'gpt' || provider.id === 'codex' ? 1 : 0), usage })),
  },
  tmux: {
    available: true, status: 'fixture ready', distros: [tmuxDistro],
    summary: { distros: 1, sessions: 1, windows: 1, panes: 4, aiPanes: 3, linked: 2 },
  },
};

const initialTerminals = [
  { id: 'terminal-main', type: 'powershell', title: '내 컴퓨터에서 실행하는 작업', status: 'running', pid: 41001, cwd: 'D:\\fixture' },
  {
    id: 'terminal-managed', type: 'agent', title: 'GPT 대화창', status: 'running', pid: 41005,
    cwd: 'D:\\fixture', provider: 'codex', background: true, backend: 'managed-tmux',
    tmuxSocket: 'loadtoagent', managedTmuxSession: 'lta-codex-fixture',
  },
  { id: 'terminal-ended', type: 'powershell', title: '완료된 컴퓨터 작업', status: 'exited', pid: 41002, cwd: 'D:\\fixture' },
  { id: 'terminal-failed', type: 'powershell', title: '작업용-PC의 작업 화면을 열지 못했습니다', status: 'failed', pid: null, cwd: 'D:\\fixture', statusDetail: '작업 화면을 여는 프로그램이 응답하지 않았습니다.' },
  { id: 'terminal-race-a', type: 'powershell', title: '내 컴퓨터에서 실행하는 작업', status: 'running', pid: 41003, cwd: 'D:\\fixture' },
  { id: 'terminal-race-b', type: 'powershell', title: '내 컴퓨터에서 실행하는 작업', status: 'running', pid: 41004, cwd: 'D:\\fixture' },
];

const availableUpdate = {
  status: 'available', currentVersion: '1.5.0', latestVersion: '1.5.1', tag: 'v1.5.1',
  releaseUrl: 'https://github.com/minjund/LodeToAgent/releases/tag/v1.5.1', publishedAt: now,
  notes: '설정 화면과 업데이트 흐름 상호작용 검증', progress: 0, downloadedBytes: 0, totalBytes: 8_192,
  downloadedPath: '', error: '', platform: 'win32', arch: 'x64', installType: 'desktop',
  asset: { name: 'LoadToAgent-Setup-1.5.1.exe', size: 8_192, url: 'https://github.com/minjund/LodeToAgent/releases/download/v1.5.1/LoadToAgent-Setup-1.5.1.exe', digest: '' },
};

const currentUpdate = {
  ...availableUpdate, status: 'current', latestVersion: '1.5.0', tag: 'v1.5.0', asset: null,
  notes: '현재 설치된 버전이 최신 정식 버전입니다.', totalBytes: 0,
};

let terminals = clone(initialTerminals);
let update = clone(availableUpdate);
let calls = [];
let failures = new Map();
let delays = new Map();
let terminalGetDelays = new Map();
let detailResponses = new Map();
let terminalSequence = 0;
let tmuxCaptureSequence = 0;
const snapshotListeners = new Set();
const attentionListeners = new Set();
const terminalDataListeners = new Set();
const terminalStateListeners = new Set();
const terminalErrorListeners = new Set();
const terminalConnectionListeners = new Set();
const updateStateListeners = new Set();

function record(name, args = []) {
  calls.push({ name, args: clone(args), at: Date.now() });
}

async function controlled(name, args, value = { ok: true }) {
  record(name, args);
  const delay = Number(delays.get(name) || 0);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  const remaining = Number(failures.get(name) || 0);
  if (remaining > 0) {
    failures.set(name, remaining - 1);
    throw new Error(`${name} fixture failure`);
  }
  return clone(value);
}

const api = {
  rendererReady: () => controlled('rendererReady'),
  bootstrap: async () => {
    record('bootstrap');
    return {
      providers: clone(providers), availability: Object.fromEntries(providers.map(provider => [provider.id, true])),
      workspaces: [
        { name: '화면 개선', path: 'D:\\fixture' },
        { name: '자동 시작 작업 결과', path: 'D:\\fixture-other' },
        { name: '설정 개선', path: '/mnt/c/Users/fixture/nested-active-project' },
        { name: '관련 작업 모음', path: '/mnt/c/Users/fixture/tmux-only-project' },
        { name: '다시 시작한 작업', path: 'D:\\unregistered-origin' },
      ], snapshot: clone(snapshot), activeRuns: [],
      platform: { id: 'win32', label: 'Windows', computerName: '작업용-PC', localShell: 'powershell', localShellLabel: '작업용-PC에서 실행하는 작업', nativeTmux: false },
      versions: { app: '3.0.0', electron: '31.0.0', node: '20.0.0' }, update: clone(update),
    };
  },
  checkForUpdate: async () => {
    update = clone(availableUpdate);
    return controlled('checkForUpdate', [], update);
  },
  downloadUpdate: async () => {
    await controlled('downloadUpdate', []);
    update = { ...clone(availableUpdate), status: 'downloaded', progress: 100, downloadedBytes: 8_192, downloadedPath: 'D:\\fixture\\LoadToAgent-Setup-3.1.0.exe' };
    updateStateListeners.forEach(listener => listener(clone(update)));
    return clone(update);
  },
  openDownloadedUpdate: () => controlled('openDownloadedUpdate'),
  installDownloadedUpdate: async () => {
    await controlled('installDownloadedUpdate', []);
    update = {
      ...clone(availableUpdate), status: 'downloaded', progress: 100, downloadedBytes: 8_192,
      downloadedPath: 'D:\\fixture\\LoadToAgent-Setup-3.1.0.exe', installMode: 'automatic',
    };
    updateStateListeners.forEach(listener => listener(clone(update)));
    return clone(update);
  },
  openUpdateRelease: () => controlled('openUpdateRelease'),
  snapshot: async () => controlled('snapshot', [], snapshot),
  sessionDetail: async id => {
    const queue = detailResponses.get(id);
    if (!queue || !queue.length) return controlled('sessionDetail', [id], snapshot.sessions.find(session => session.id === id) || null);
    record('sessionDetail', [id]);
    const response = queue.shift();
    if (!queue.length) detailResponses.delete(id);
    if (response.delay) await new Promise(resolve => setTimeout(resolve, response.delay));
    return clone(response.detail);
  },
  runAgent: options => controlled('runAgent', [options], { ok: true, runId: 'fixture-new-run' }),
  stopAgent: runId => controlled('stopAgent', [runId], { ok: true }),
  pauseAgent: runId => controlled('pauseAgent', [runId], { ok: true, status: 'paused' }),
  resumeAgentRun: runId => controlled('resumeAgentRun', [runId], { ok: true, status: 'running' }),
  retryAgent: runId => controlled('retryAgent', [runId], { ok: true, runId: 'fixture-retry-run', retriedFrom: runId }),
  activeRuns: async () => [],
  probeProviders: async () => controlled('probeProviders', [], Object.fromEntries(providers.map(provider => [provider.id, true]))),
  providerUsage: options => controlled('providerUsage', [options], {
    generatedAt: new Date().toISOString(),
    providers: {
      claude: {
        provider: 'claude', available: true, source: 'anthropic-oauth', plan: 'max',
        shortWindow: { label: '5시간 한도', usedPercent: 35, remainingPercent: 65, resetsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), windowMinutes: 300 },
        weekly: { label: '주간 한도', usedPercent: 60, remainingPercent: 40, resetsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), windowMinutes: 10080 },
      },
      codex: {
        provider: 'codex', available: true, source: 'codex-session', plan: 'plus',
        shortWindow: { label: '5시간 한도', usedPercent: 20, remainingPercent: 80, resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), windowMinutes: 300 },
        weekly: { label: '주간 한도', usedPercent: 10, remainingPercent: 90, resetsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(), windowMinutes: 10080 },
      },
      gemini: { provider: 'gemini', available: false, source: 'provider', reason: 'usage-not-supported' },
      grok: { provider: 'grok', available: false, source: 'provider', reason: 'usage-not-supported' },
    },
  }),
  setProviderVisibility: preference => controlled('setProviderVisibility', [preference]),
  listWorkspaces: async () => [
    { name: '화면 개선', path: 'D:\\fixture' },
    { name: '자동 시작 작업 결과', path: 'D:\\fixture-other' },
    { name: '설정 개선', path: '/mnt/c/Users/fixture/nested-active-project' },
    { name: '관련 작업 모음', path: '/mnt/c/Users/fixture/tmux-only-project' },
    { name: '다시 시작한 작업', path: 'D:\\unregistered-origin' },
  ],
  addWorkspaces: async () => controlled('addWorkspaces', [], {
    canceled: false,
    workspaces: [
      { name: '화면 개선', path: 'D:\\fixture' },
      { name: '자동 시작 작업 결과', path: 'D:\\fixture-other' },
      { name: '설정 개선', path: '/mnt/c/Users/fixture/nested-active-project' },
      { name: '관련 작업 모음', path: '/mnt/c/Users/fixture/tmux-only-project' },
      { name: '다시 시작한 작업', path: 'D:\\unregistered-origin' },
    ],
    selected: { name: '화면 개선', path: 'D:\\fixture' },
    alreadyAdded: true,
  }),
  removeWorkspace: folder => controlled('removeWorkspace', [folder], []),
  pickWorkspace: () => controlled('pickWorkspace', [], 'D:\\fixture-picked'),
  openExternal: url => controlled('openExternal', [url]),
  openSessionOrigin: session => controlled('openSessionOrigin', [session], { ok: true }),
  writeClipboard: value => controlled('writeClipboard', [value]),
  bridgeCommand: provider => controlled('bridgeCommand', [provider], { ok: true, command: `loadtoagent bridge ${provider}` }),
  terminalList: async () => {
    record('terminalList');
    return clone(terminals);
  },
  wslDistros: async () => {
    record('wslDistros');
    return ['FixtureLinux'];
  },
  terminalGet: async id => {
    record('terminalGet', [id]);
    const delay = Number(terminalGetDelays.get(id) || 0);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return { ok: true, replay: `컴퓨터에 직접 지시할 준비가 되었습니다. 예: 메모장 열기\r\n` };
  },
  terminalCreate: async options => {
    const created = {
      id: `terminal-created-${++terminalSequence}`,
      type: options.type,
      title: options.title || '새 컴퓨터 작업',
      status: 'running',
      pid: 42000 + terminalSequence,
      cwd: options.cwd || 'D:\\fixture',
      provider: options.provider || '',
      bridgeId: options.bridgeId || '',
      background: options.type === 'agent',
      backend: options.sessionBackend || 'direct',
      tmuxSocket: options.tmuxSocket || '',
      managedTmuxSession: options.managedTmuxSession || '',
    };
    await controlled('terminalCreate', [options], created);
    terminals.push(created);
    return clone(created);
  },
  terminalWrite: (id, data) => record('terminalWrite', [id, data]),
  terminalCommand: (id, command) => controlled('terminalCommand', [id, command]),
  terminalResize: (id, cols, rows) => controlled('terminalResize', [id, cols, rows]),
  terminalSignal: (id, signal) => controlled('terminalSignal', [id, signal]),
  terminalRestart: async id => {
    await controlled('terminalRestart', [id]);
    const terminal = terminals.find(item => item.id === id);
    if (terminal) terminal.status = 'running';
    return { ok: true };
  },
  terminalReconnect: async id => {
    await controlled('terminalReconnect', [id]);
    const terminal = terminals.find(item => item.id === id);
    if (terminal) terminal.status = 'running';
    return clone(terminal || { id, status: 'running' });
  },
  terminalDetach: async id => {
    await controlled('terminalDetach', [id]);
    const terminal = terminals.find(item => item.id === id);
    if (terminal) terminal.status = 'detached';
    return clone(terminal || { id, status: 'detached' });
  },
  terminalStop: async id => {
    await controlled('terminalStop', [id]);
    const terminal = terminals.find(item => item.id === id);
    if (terminal) terminal.status = 'stopped';
    return clone(terminal || { id, status: 'stopped' });
  },
  terminalClose: async id => {
    await controlled('terminalClose', [id]);
    terminals = terminals.filter(item => item.id !== id);
    return { ok: true };
  },
  tmuxSendText: options => controlled('tmuxSendText', [options]),
  tmuxSendKey: options => controlled('tmuxSendKey', [options]),
  tmuxCapture: options => controlled('tmuxCapture', [options], {
    ok: true,
    output: `${Array.from({ length: 240 }, (_, index) => `fixture tmux line ${String(index + 1).padStart(3, '0')}`).join('\n')}\nfixture capture ${++tmuxCaptureSequence}\n`,
  }),
  tmuxNewSession: options => controlled('tmuxNewSession', [options]),
  tmuxNewWindow: options => controlled('tmuxNewWindow', [options]),
  tmuxSplitPane: options => controlled('tmuxSplitPane', [options]),
  tmuxRenameSession: options => controlled('tmuxRenameSession', [options]),
  tmuxRenameWindow: options => controlled('tmuxRenameWindow', [options]),
  tmuxSelectLayout: options => controlled('tmuxSelectLayout', [options]),
  tmuxKillPane: options => controlled('tmuxKillPane', [options]),
  tmuxKillWindow: options => controlled('tmuxKillWindow', [options]),
  tmuxKillSession: options => controlled('tmuxKillSession', [options]),
  onTerminalData: callback => { terminalDataListeners.add(callback); return () => terminalDataListeners.delete(callback); },
  onTerminalState: callback => { terminalStateListeners.add(callback); return () => terminalStateListeners.delete(callback); },
  onTerminalError: callback => { terminalErrorListeners.add(callback); return () => terminalErrorListeners.delete(callback); },
  onTerminalConnection: callback => { terminalConnectionListeners.add(callback); return () => terminalConnectionListeners.delete(callback); },
  onSnapshot: callback => { snapshotListeners.add(callback); return () => snapshotListeners.delete(callback); },
  onAttentionRequested: callback => { attentionListeners.add(callback); return () => attentionListeners.delete(callback); },
  onUpdateState: callback => { updateStateListeners.add(callback); return () => updateStateListeners.delete(callback); },
};

const testApi = {
  getCalls: () => clone(calls),
  getSnapshot: () => clone(snapshot),
  clearCalls: () => { calls = []; },
  configure: options => {
    if (options && options.delays) for (const [name, value] of Object.entries(options.delays)) delays.set(name, Number(value) || 0);
    if (options && options.failures) for (const [name, value] of Object.entries(options.failures)) failures.set(name, Number(value) || 0);
    return true;
  },
  setTerminalGetDelays: values => { terminalGetDelays = new Map(Object.entries(values || {}).map(([id, value]) => [id, Number(value) || 0])); return true; },
  queueSessionDetail: (id, responses) => { detailResponses.set(id, clone(responses || [])); return true; },
  setSessionRuntimePresence: (id, presence) => {
    const session = snapshot.sessions.find(item => item.id === id);
    if (!session) return false;
    session.runtimePresence = clone(presence || []);
    return true;
  },
  appendSessionMessages: (id, messages) => {
    const session = snapshot.sessions.find(item => item.id === id);
    if (!session) return false;
    session.messages = [...(session.messages || []), ...clone(messages || [])];
    session.updatedAt = new Date(Date.now() + 1000).toISOString();
    snapshot.generatedAt = session.updatedAt;
    return true;
  },
  addSession: session => {
    if (!session || !session.id || snapshot.sessions.some(item => item.id === session.id)) return false;
    snapshot.sessions.push(clone(session));
    snapshot.generatedAt = new Date(Date.now() + 1000).toISOString();
    return true;
  },
  addTerminal: terminal => {
    if (!terminal || !terminal.id || terminals.some(item => item.id === terminal.id)) return false;
    terminals.push(clone(terminal));
    return true;
  },
  clearControls: () => { failures = new Map(); delays = new Map(); terminalGetDelays = new Map(); detailResponses = new Map(); },
  restoreTerminals: () => { terminals = clone(initialTerminals); return clone(terminals); },
  restoreUpdate: () => { update = clone(availableUpdate); updateStateListeners.forEach(listener => listener(clone(update))); return clone(update); },
  restoreCurrentUpdate: () => { update = clone(currentUpdate); updateStateListeners.forEach(listener => listener(clone(update))); return clone(update); },
  triggerAttention: sessionId => { attentionListeners.forEach(listener => listener({ sessionId })); return attentionListeners.size; },
  emitSnapshot: () => { snapshotListeners.forEach(listener => listener(clone(snapshot))); return snapshotListeners.size; },
  emitTerminalData: (id, data) => { terminalDataListeners.forEach(listener => listener({ id, data })); return terminalDataListeners.size; },
  emitTerminalReconnect: id => {
    terminals = terminals.map(session => session.id === id ? { ...session, recoveredAfterHostRestart: true } : session);
    const payload = { change: 'reconnected', session: null, sessions: clone(terminals) };
    terminalStateListeners.forEach(listener => listener(payload));
    return terminalStateListeners.size;
  },
};

contextBridge.exposeInMainWorld('loadtoagent', api);
contextBridge.exposeInMainWorld('interactionTest', testApi);
