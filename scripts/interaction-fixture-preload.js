'use strict';

const { contextBridge } = require('electron');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const now = new Date().toISOString();

const providers = [
  { id: 'claude', label: 'Claude', company: 'Anthropic', accent: '#d58b5b', mark: 'C', installed: true },
  { id: 'gpt', label: 'GPT', company: 'OpenAI', accent: '#63d6b1', mark: 'G', installed: true },
  { id: 'gemini', label: 'Gemini', company: 'Google', accent: '#6da8ff', mark: 'Ge', installed: true },
  { id: 'grok', label: 'Grok', company: 'xAI', accent: '#c394ff', mark: 'X', installed: true },
  { id: 'codex', label: 'GPT · Codex', company: 'OpenAI', accent: '#4fd1a7', mark: 'Cx', installed: true },
];

const usage = { input: 1200, output: 540, cachedInput: 100, cacheWrite: 0, reasoning: 80, total: 1920 };
const context = { used: 5200, window: 128000, percent: 4.1, source: 'session' };
const messages = [
  { id: 'm-user', role: 'user', text: '상호작용 테스트를 진행해줘', timestamp: now },
  { id: 'm-assistant', role: 'assistant', text: '버튼과 입력 동작을 확인하고 있습니다.', timestamp: now },
];

const rootSession = {
  id: 'fixture-root', externalId: 'fixture-root-external', provider: 'claude', model: 'claude-fixture',
  title: '현재 프로그램의 모든 화면에서 긴 사용자 요청이 카드 전체를 밀어내지 않도록 지금 목표를 읽기 좋은 길이로 요약하고 원문은 상세 대화에 보존하면서 작은 화면과 큰 화면 모두에서 버튼과 상태 정보가 안정적으로 보이게 상호작용을 검증해줘', cwd: 'D:\\fixture', workspace: 'fixture', status: 'running',
  statusDetail: '버튼 동작을 확인하는 중', updatedAt: now, parentId: null, childIds: ['fixture-child', 'fixture-resting'],
  messages, usage, turnUsage: usage, context, runId: 'fixture-run',
  lifecycle: [{ type: 'start', status: 'running', label: '검증 시작', detail: 'DOM 이벤트 확인', timestamp: now }],
  runtimePresence: [{ kind: 'terminal', terminalId: 'terminal-main', pid: 41001, label: 'fixture terminal' }],
  sourceLabel: '인메모리 테스트 기록',
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
  ...rootSession, id: 'fixture-child', externalId: 'fixture-child-external', provider: 'gpt', model: 'gpt-fixture',
  title: '하위 상호작용 검증', parentId: 'fixture-root', childIds: ['fixture-grandchild'], agentName: 'button-auditor', agentRole: 'tester',
  runtimePresence: [], runId: '', collaboration: { communications: [
    { id: 'nested-assignment', kind: 'assignment', label: '새 작업 배정', from: '/root/child', to: '/root/child/nested_check', taskName: 'nested_check', childId: 'fixture-grandchild', text: '하위 흐름을 검증해줘', timestamp: now },
    { id: 'nested-started', kind: 'started', label: '서브에이전트 실행 시작', from: 'Codex 런타임', to: '/root/child/nested_check', taskName: 'nested_check', childId: 'fixture-grandchild', text: 'started', timestamp: now },
    { id: 'nested-result', kind: 'result', label: '결과 반환', from: '/root/child/nested_check', to: '/root/child', taskName: 'nested_check', childId: 'fixture-grandchild', text: '중첩 흐름 정상', timestamp: now },
  ] },
};

const grandchildSession = {
  ...childSession, id: 'fixture-grandchild', externalId: 'fixture-grandchild-external', provider: 'codex', model: 'gpt-fixture',
  title: '중첩 서브에이전트 검증', taskName: 'nested_check', parentId: 'fixture-child', childIds: [], agentName: 'nested-auditor',
  status: 'completed', statusDetail: '중첩 검증 완료', runtimePresence: [], runId: '',
  result: '중첩 흐름 정상', delegation: { taskName: 'nested_check', result: '중첩 흐름 정상' },
};

const restingSession = {
  ...childSession, id: 'fixture-resting', externalId: 'fixture-resting-external', provider: 'codex', model: 'gpt-fixture',
  title: '쉬는 서브에이전트 검증', taskName: 'resting_check', parentId: 'fixture-root', childIds: [], agentName: 'resting-auditor',
  status: 'completed', statusDetail: '작업을 마치고 쉬는 중', runtimePresence: [], runId: '',
  result: '검토 결과 이상이 없습니다.', delegation: { taskName: 'resting_check', result: '검토 결과 이상이 없습니다.' },
};

const endedSession = {
  ...rootSession, id: 'fixture-ended', externalId: 'fixture-ended-external', provider: 'gpt', model: 'gpt-fixture',
  title: '완료된 대화 상세 검증', status: 'completed', statusDetail: '검증 완료', parentId: null, childIds: [],
  runtimePresence: [], runId: '',
  messages: [
    { id: 'ended-user', role: 'user', text: '이 요청은 상세 대화에서 생략하지 말고 전체 내용을 보여주되, AI가 만든 긴 로드맵은 처음부터 전부 펼치지 말고 읽기 좋은 형태로 정리해줘.', timestamp: now },
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
  title: '사용자 확인 대기 검증', status: 'waiting', statusDetail: '사용자 선택 대기',
};

const extraLiveSessions = Array.from({ length: 7 }, (_, index) => ({
  ...rootSession,
  id: `fixture-live-${index}`,
  externalId: `fixture-live-${index}-external`,
  title: `추가 진행 작업 ${index + 1}`,
  childIds: [],
  runtimePresence: [],
  runId: '',
}));

const originSession = {
  ...rootSession,
  id: 'fixture-origin',
  externalId: 'fixture-origin-external',
  provider: 'codex',
  title: 'Codex 원래 작업 열기 검증',
  childIds: [],
  runtimePresence: [],
  runId: '',
  clientKind: 'codex-desktop',
};

const projectlessSession = {
  ...endedSession,
  id: 'fixture-projectless',
  externalId: 'fixture-projectless-external',
  provider: 'codex',
  title: '프로젝트 없이 시작한 Codex 대화',
  cwd: 'C:\\Users\\fixture\\Documents\\Codex\\2026-07-16\\new-chat',
  workspace: 'new-chat',
  clientKind: 'codex-desktop',
};

const extraEndedSessions = Array.from({ length: 34 }, (_, index) => ({
  ...endedSession,
  id: `fixture-history-${index}`,
  externalId: `fixture-history-${index}-external`,
  title: index === 0 ? '상세 오류 재시도 검증' : `지난 작업 ${String(index + 1).padStart(2, '0')}`,
  provider: index % 2 ? 'gpt' : 'gemini',
  updatedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
}));

const tmuxPane = {
  id: 'tmux-pane-id', nativeId: '%7', index: 0, pid: 51001, active: true, dead: false,
  command: 'claude', cwd: '/tmp/fixture', title: 'fixture pane',
  agent: { ...rootSession, linkedSessionId: 'fixture-root', pid: 51001 },
};
const tmuxWindow = { id: 'tmux-window-id', nativeId: '@3', index: 0, name: 'fixture-window', active: true, panes: [tmuxPane] };
const tmuxSession = { id: 'tmux-session-id', nativeId: '$2', name: 'fixture-session', attached: false, windows: [tmuxWindow] };
const tmuxDistro = { id: 'tmux-distro-id', name: 'FixtureLinux', tmuxVersion: 'tmux 3.4', sessions: [tmuxSession] };

const snapshot = {
  generatedAt: now,
  sessions: [rootSession, childSession, grandchildSession, restingSession, originSession, projectlessSession, ...extraLiveSessions, endedSession, waitingSession, ...extraEndedSessions],
  summary: {
    totals: { sessions: 48, active: 10, waiting: 1, subagents: 3, usage },
    providers: providers.map(provider => ({ ...provider, sessions: 1, active: provider.id === 'claude' ? 8 : (provider.id === 'gpt' || provider.id === 'codex' ? 1 : 0), usage })),
  },
  tmux: {
    available: true, status: 'fixture ready', distros: [tmuxDistro],
    summary: { distros: 1, sessions: 1, windows: 1, panes: 1, aiPanes: 1, linked: 1 },
  },
};

const initialTerminals = [
  { id: 'terminal-main', type: 'powershell', title: 'Fixture PowerShell', status: 'running', pid: 41001, cwd: 'D:\\fixture' },
  { id: 'terminal-ended', type: 'powershell', title: 'Fixture Ended', status: 'exited', pid: 41002, cwd: 'D:\\fixture' },
];

const availableUpdate = {
  status: 'available', currentVersion: '3.0.0', latestVersion: '3.1.0', tag: 'v3.1.0',
  releaseUrl: 'https://github.com/minjund/LodeToAgent/releases/tag/v3.1.0', publishedAt: now,
  notes: '설정 화면과 업데이트 흐름 상호작용 검증', progress: 0, downloadedBytes: 0, totalBytes: 8_192,
  downloadedPath: '', error: '', platform: 'win32', arch: 'x64', installType: 'desktop',
  asset: { name: 'LoadToAgent-Setup-3.1.0.exe', size: 8_192, url: 'https://github.com/minjund/LodeToAgent/releases/download/v3.1.0/LoadToAgent-Setup-3.1.0.exe', digest: '' },
};

const currentUpdate = {
  ...availableUpdate, status: 'current', latestVersion: '3.0.0', tag: 'v3.0.0', asset: null,
  notes: '현재 설치된 버전이 최신 정식 버전입니다.', totalBytes: 0,
};

let terminals = clone(initialTerminals);
let update = clone(availableUpdate);
let calls = [];
let failures = new Map();
let delays = new Map();
let terminalSequence = 0;
const snapshotListeners = new Set();
const terminalDataListeners = new Set();
const terminalStateListeners = new Set();
const terminalErrorListeners = new Set();
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
  bootstrap: async () => {
    record('bootstrap');
    return {
      providers: clone(providers), availability: Object.fromEntries(providers.map(provider => [provider.id, true])),
      workspaces: [{ name: 'fixture', path: 'D:\\fixture' }], snapshot: clone(snapshot), activeRuns: [],
      platform: { id: 'win32', label: 'Windows', localShell: 'powershell', localShellLabel: 'Windows 명령창', nativeTmux: false },
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
  openUpdateRelease: () => controlled('openUpdateRelease'),
  snapshot: async () => controlled('snapshot', [], snapshot),
  sessionDetail: id => controlled('sessionDetail', [id], snapshot.sessions.find(session => session.id === id) || null),
  runAgent: options => controlled('runAgent', [options], { ok: true, runId: 'fixture-new-run' }),
  stopAgent: runId => controlled('stopAgent', [runId], { ok: true }),
  activeRuns: async () => [],
  probeProviders: async () => controlled('probeProviders', [], Object.fromEntries(providers.map(provider => [provider.id, true]))),
  listWorkspaces: async () => [{ name: 'fixture', path: 'D:\\fixture' }],
  addWorkspaces: async () => controlled('addWorkspaces', [], [{ name: 'fixture', path: 'D:\\fixture' }]),
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
    return { ok: true, replay: `fixture replay for ${id}\r\n` };
  },
  terminalCreate: async options => {
    const created = { id: `terminal-created-${++terminalSequence}`, type: options.type, title: options.title || 'Fixture terminal', status: 'running', pid: 42000 + terminalSequence, cwd: options.cwd || 'D:\\fixture', provider: options.provider || '', bridgeId: options.bridgeId || '', background: options.type === 'agent' };
    await controlled('terminalCreate', [options], created);
    terminals.push(created);
    return clone(created);
  },
  terminalWrite: (id, data) => record('terminalWrite', [id, data]),
  terminalCommand: (id, command) => controlled('terminalCommand', [id, command]),
  terminalResize: (id, cols, rows) => record('terminalResize', [id, cols, rows]),
  terminalSignal: (id, signal) => controlled('terminalSignal', [id, signal]),
  terminalRestart: async id => {
    await controlled('terminalRestart', [id]);
    const terminal = terminals.find(item => item.id === id);
    if (terminal) terminal.status = 'running';
    return { ok: true };
  },
  terminalClose: async id => {
    await controlled('terminalClose', [id]);
    terminals = terminals.filter(item => item.id !== id);
    return { ok: true };
  },
  tmuxSendText: options => controlled('tmuxSendText', [options]),
  tmuxSendKey: options => controlled('tmuxSendKey', [options]),
  tmuxCapture: options => controlled('tmuxCapture', [options], { ok: true, output: 'fixture tmux output\n' }),
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
  onSnapshot: callback => { snapshotListeners.add(callback); return () => snapshotListeners.delete(callback); },
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
  clearControls: () => { failures = new Map(); delays = new Map(); },
  restoreTerminals: () => { terminals = clone(initialTerminals); return clone(terminals); },
  restoreUpdate: () => { update = clone(availableUpdate); updateStateListeners.forEach(listener => listener(clone(update))); return clone(update); },
  restoreCurrentUpdate: () => { update = clone(currentUpdate); updateStateListeners.forEach(listener => listener(clone(update))); return clone(update); },
};

contextBridge.exposeInMainWorld('loadtoagent', api);
contextBridge.exposeInMainWorld('interactionTest', testApi);
