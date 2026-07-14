'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { providerList, normalizeProvider, modelContextWindow } = require('../src/providerRegistry');
const { parseClaude, parseCodex, parseGeneric, buildSummary } = require('../src/agentMonitor');
const { commandSpec } = require('../src/agentRunner');
const { TmuxMonitor, normalizeWslList, parseTmuxProbe, buildDistroTopology, linkAgentSessions, providerFromProcess } = require('../src/tmuxMonitor');
const { processRows, posixProcessRows, providerFromPosixProcess, selectAgentProcesses, bridgeLinkScore, applyRuntimePresence } = require('../src/processMonitor');
const { TerminalManager, normalizeLaunchOptions, launchSpec } = require('../src/terminalManager');
const { TmuxController, safeName, safeTarget } = require('../src/tmuxController');
const { BridgeServer } = require('../src/bridgeServer');
const { parseArguments } = require('../bin/lodestar');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestar-test-'));
let passed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function jsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return { file, mtimeMs: fs.statSync(file).mtimeMs, size: fs.statSync(file).size };
}

test('네 제공사 레지스트리를 노출한다', () => {
  assert.deepStrictEqual(providerList().map(item => item.id), ['claude', 'codex', 'gemini', 'grok']);
  assert.equal(normalizeProvider('OpenAI GPT'), 'codex');
  assert.equal(normalizeProvider('xAI Grok'), 'grok');
});

test('관측값을 우선해 컨텍스트 창을 계산한다', () => {
  assert.deepStrictEqual(modelContextWindow('codex', 'gpt-5.4', 258400), { tokens: 258400, source: 'session' });
  assert.equal(modelContextWindow('claude', 'claude-opus-4-8').tokens, 1_000_000);
  assert.equal(modelContextWindow('grok', 'grok-4.5').tokens, 500_000);
});

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

test('Codex 서브에이전트 source를 해석한다', () => {
  const file = path.join(temp, 'codex', 'rollout-sub.jsonl');
  const session = parseCodex(jsonl(file, [{ timestamp: '2026-07-14T02:00:00Z', type: 'session_meta', payload: { id: 'child', cwd: 'D:\\repo', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1, agent_nickname: 'Cicero', agent_role: 'explorer' } } } } }]));
  assert.equal(session.parentId, 'codex:parent');
  assert.equal(session.agentName, 'Cicero');
  assert.equal(session.agentRole, 'explorer');
});

test('Codex 내부 지침 대신 실제 사용자 목표를 카드 제목으로 사용한다', () => {
  const file = path.join(temp, 'codex', 'rollout-visible-title.jsonl');
  const session = parseCodex(jsonl(file, [
    { timestamp: '2026-07-14T02:00:00Z', type: 'session_meta', payload: { id: 'visible-title', cwd: 'D:\\repo', source: 'cli' } },
    { timestamp: '2026-07-14T02:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '<permissions instructions>Filesystem sandboxing defines which files can be read or written</permissions instructions>' } },
    { timestamp: '2026-07-14T02:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'You are `/root`, the primary agent in a team of agents collaborating to fulfill the user goals. All agents share the same directory and collaboration tools cannot be called from inside another tool.' } },
    { timestamp: '2026-07-14T02:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: '<codex_internal_context><objective>실시간 토큰 게이지를 크게 보여줘</objective></codex_internal_context>' } },
    { timestamp: '2026-07-14T02:00:03Z', type: 'response_item', payload: { id: 'later-user', type: 'message', role: 'user', content: [{ type: 'input_text', text: '<codex_internal_context><objective>서브에이전트 관계를 마인드맵으로 보여줘</objective></codex_internal_context>' }] } },
  ]));
  assert.equal(session.title, '서브에이전트 관계를 마인드맵으로 보여줘');
  assert.equal(session.messages.some(item => /Filesystem sandboxing/.test(item.text)), false);
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

test('WSL tmux 패널의 PID 계보에서 AI 프로세스를 식별한다', () => {
  const sep = '|~|';
  const probe = parseTmuxProbe([
    ['M', '/home/dev', 'tmux_3.2a'].join(sep),
    ['P', '$1', 'work', '1784000000', '1', '1', '@1', '0', 'main', '1', '%1', '0', '100', 'node', '/mnt/d/repo', '1', '0', 'dev'].join(sep),
    `R${sep}100 1 120 bash -bash`,
    `R${sep}110 100 119 node node /home/dev/.local/bin/codex --json`,
    `R${sep}111 110 118 codex /opt/codex`,
    ['F', 'codex', '1784000000.123', '2048', '/home/dev/.codex/sessions/test.jsonl'].join(sep),
  ].join('\n'), 'Ubuntu-22.04', 1784000120000);
  const topology = buildDistroTopology(probe);
  const pane = topology.sessions[0].windows[0].panes[0];
  assert.equal(pane.agentProcess.provider, 'codex');
  assert.equal(pane.agentProcess.pid, 111);
  assert.equal(probe.historyFiles.codex[0].size, 2048);
  assert.equal(providerFromProcess({ command: 'node', args: 'node /x/@google/gemini-cli/bin/gemini' }), 'gemini');
});

test('tmux AI 패널을 같은 WSL 작업 폴더의 대화 세션과 연결한다', () => {
  const topology = {
    generatedAt: new Date().toISOString(), available: true, status: '연결됨', summary: {},
    distros: [{ id: 'wsl:Ubuntu', name: 'Ubuntu', tmuxInstalled: true, sessions: [{ id: 's', name: 'work', windows: [{ id: 'w', name: 'main', panes: [{ id: 'p', pid: 100, cwd: '/mnt/d/repo', command: 'node', active: true, dead: false, agentProcess: { provider: 'codex', pid: 111, command: 'codex', args: 'codex', startedAt: new Date().toISOString() } }] }] }] }],
  };
  const session = { id: 'codex:linked', provider: 'codex', cwd: 'D:\\repo', title: '연결된 작업', status: 'running', statusDetail: '턴 실행 중', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), environment: { kind: 'wsl', distro: 'Ubuntu' }, context: { used: 10, window: 100, percent: 10 }, usage: { total: 20 }, childIds: [] };
  const linked = linkAgentSessions(topology, [session]);
  assert.equal(linked.summary.aiPanes, 1);
  assert.equal(linked.summary.linked, 1);
  assert.equal(linked.distros[0].sessions[0].windows[0].panes[0].agent.linkedSessionId, 'codex:linked');
  const utf16 = Buffer.from('Ubuntu-22.04\r\ndocker-desktop\r\n', 'utf16le');
  assert.deepStrictEqual(normalizeWslList(utf16), ['Ubuntu-22.04']);
});

test('macOS에서는 WSL 없이 로컬 tmux 토폴로지를 탐지한다', () => {
  const calls = [];
  const output = [
    ['M', '/Users/dev', 'tmux_3.4'].join('|~|'),
    ['P', '$1', 'mac-work', '1784000000', '1', '1', '@1', '0', 'main', '1', '%1', '0', '500', 'zsh', '/Users/dev/repo', '1', '0', 'dev'].join('|~|'),
    'R|~|500 1 00:20 zsh -zsh',
    'R|~|510 500 00:19 codex /opt/homebrew/bin/codex',
  ].join('\n');
  const monitor = new TmuxMonitor({ platform: 'darwin', execFileSync: (file, args) => { calls.push({ file, args }); return output; }, scanTtlMs: 1, discoveryTtlMs: 1 });
  const snapshot = monitor.scan(true);
  assert.equal(calls[0].file === 'wsl.exe', false);
  assert.equal(snapshot.distros[0].kind, 'local');
  assert.equal(snapshot.distros[0].name, 'macOS');
  assert.equal(snapshot.distros[0].sessions[0].windows[0].panes[0].agentProcess.provider, 'codex');
});

test('Windows AI CLI와 tmux 프로세스를 각각의 활성 세션으로 유지한다', () => {
  const csv = [
    'Node,CommandLine,CreationDate,Name,ParentProcessId,ProcessId',
    'PC,claude,20260714120000.000000+540,claude.exe,10,101',
    'PC,"C:\\Program Files\\WindowsApps\\Claude_1.0\\app\\claude.exe" --type=renderer,20260714120000.000000+540,claude.exe,10,102',
    'PC,"node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",20260714120000.000000+540,node.exe,20,201',
    'PC,C:\\npm\\codex.exe,20260714120001.000000+540,codex.exe,201,202',
  ].join('\r\n');
  const processes = selectAgentProcesses(processRows(csv));
  assert.deepStrictEqual(processes.map(item => [item.provider, item.pid]), [['claude', 101], ['codex', 202]]);
  assert.equal(processes[0].startedAt, '2026-07-14T03:00:00.000Z');

  const base = {
    distros: [{ name: 'Ubuntu', sessions: [{ name: 'tmux-work', windows: [{ panes: [{ nativeId: '%1', index: 0, cwd: '/repo', agent: { provider: 'claude', pid: 301, linkedSessionId: 'claude:wsl', startedAt: '2026-07-14T03:00:00Z' } }] }] }] }],
  };
  const usage = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  const sessions = [
    { id: 'claude:wsl', provider: 'claude', environment: { kind: 'wsl' }, status: 'idle', title: 'WSL Claude', updatedAt: '2026-07-14T03:00:00Z', usage, childIds: [] },
    { id: 'claude:win', provider: 'claude', environment: { kind: 'windows' }, status: 'idle', title: 'Windows Claude', startedAt: '2026-07-14T03:00:00Z', updatedAt: '2026-07-14T03:00:00Z', usage, childIds: [] },
    { id: 'codex:win', provider: 'codex', environment: { kind: 'windows' }, status: 'idle', title: 'Windows Codex', startedAt: '2026-07-14T03:00:01Z', updatedAt: '2026-07-14T03:00:01Z', usage, childIds: [] },
  ];
  const active = applyRuntimePresence(sessions, base, { processes }, Date.parse('2026-07-14T03:01:00Z'));
  assert.equal(active.filter(item => item.status === 'running').length, 3);
  assert.equal(active.find(item => item.id === 'claude:wsl').runtimePresence[0].kind, 'tmux');
  assert.equal(active.find(item => item.id === 'codex:win').runtimePresence[0].pid, 202);
});

test('macOS 프로세스 목록에서 AI CLI를 찾고 데스크톱 앱 서버는 제외한다', () => {
  const now = Date.parse('2026-07-14T10:00:00Z');
  const rows = posixProcessRows([
    '101 1 00:10 claude /opt/homebrew/bin/claude',
    '201 1 01:02 node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
    '202 201 01:01 codex /opt/homebrew/bin/codex',
    '301 1 00:20 codex /Applications/Codex.app/Contents/MacOS/codex app-server',
  ].join('\n'), now);
  const processes = selectAgentProcesses(rows, { providerResolver: providerFromPosixProcess, environment: 'macos' });
  assert.deepStrictEqual(processes.map(item => [item.provider, item.pid, item.environment]), [['claude', 101, 'macos'], ['codex', 202, 'macos']]);
  assert.equal(processes[0].startedAt, '2026-07-14T09:59:50.000Z');
});

test('외부 브리지는 같은 시각의 CLI 기록에만 연결하고 Codex 데스크톱과 섞지 않는다', () => {
  const now = Date.parse('2026-07-14T10:00:00Z');
  const bridge = { provider: 'codex', environment: 'windows', cwd: 'D:\\repo', startedAt: '2026-07-14T09:59:30Z' };
  const base = { provider: 'codex', environment: { kind: 'windows' }, cwd: 'D:\\repo', parentId: null, updatedAt: '2026-07-14T10:00:00Z' };
  assert.equal(bridgeLinkScore({ ...base, clientKind: 'codex-desktop', startedAt: bridge.startedAt }, bridge, now), -Infinity);
  assert.equal(bridgeLinkScore({ ...base, clientKind: 'codex-cli', startedAt: '2026-07-14T09:40:00Z' }, bridge, now), -Infinity);
  assert.ok(bridgeLinkScore({ ...base, clientKind: 'codex-cli', startedAt: '2026-07-14T09:59:35Z' }, bridge, now) > 10_000);
});

test('Lodestar 외부 브리지는 인증 소켓으로 전용 PTY에만 입력한다', async () => {
  class FakeManager extends EventEmitter {
    constructor() { super(); this.writes = []; this.sessions = []; }
    create(options) {
      const session = { id: 'terminal:bridge', type: 'agent', title: options.title, provider: options.provider, bridgeId: options.bridgeId, pid: 777, status: 'running', cwd: options.cwd, createdAt: new Date().toISOString(), replay: 'READY\r\n' };
      this.sessions = [session];
      return session;
    }
    write(id, data) { this.writes.push([id, data]); return { ok: true }; }
    resize() { return { ok: true }; }
    signal() { return { ok: true }; }
    close() { return { ok: true }; }
    list() { return this.sessions; }
  }
  const manager = new FakeManager();
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\lodestar-test-${process.pid}-${Date.now()}` : path.join(temp, 'bridge.sock');
  const discovery = path.join(temp, 'bridge.json');
  const server = new BridgeServer({ terminalManager: manager, home: temp, platform: process.platform, endpoint, discoveryFile: discovery, token: 'test-token' });
  await server.start();
  assert.equal(fs.existsSync(discovery), true);
  const socket = net.createConnection(endpoint);
  let buffer = '';
  const nextFrame = () => new Promise((resolve, reject) => {
    const inspect = () => {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return false;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      resolve(JSON.parse(line));
      return true;
    };
    if (inspect()) return;
    const timer = setTimeout(() => reject(new Error('브리지 응답 시간 초과')), 2_000);
    socket.once('data', chunk => { clearTimeout(timer); buffer += chunk.toString('utf8'); inspect(); });
  });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(`${JSON.stringify({ type: 'run', token: 'test-token', provider: 'codex', cwd: root, args: [] })}\n`);
  const started = await nextFrame();
  assert.equal(started.type, 'started');
  assert.equal(Buffer.from(started.replay, 'base64').toString('utf8'), 'READY\r\n');
  socket.write(`${JSON.stringify({ type: 'input', data: Buffer.from('hello').toString('base64') })}\n`);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepStrictEqual(manager.writes, [['terminal:bridge', 'hello']]);
  socket.destroy();
  server.dispose();
  assert.equal(fs.existsSync(discovery), false);
  assert.deepStrictEqual(parseArguments(['run', 'codex', '--', '--model', 'gpt-5.4']), { provider: 'codex', args: ['--model', 'gpt-5.4'] });
});

test('Gemini/Grok 계열 JSON 세션을 공통 모델로 읽는다', () => {
  const file = path.join(temp, 'gemini', 'session.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: 'gem-1', model: 'gemini-3.5-flash', cwd: 'D:\\repo', messages: [{ id: 'u', role: 'user', content: '문서를 요약해줘' }, { id: 'a', role: 'model', content: '요약입니다.', usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, totalTokenCount: 50 } }] }), 'utf8');
  const stat = fs.statSync(file);
  const session = parseGeneric({ file, mtimeMs: stat.mtimeMs, size: stat.size }, 'gemini');
  assert.equal(session.title, '문서를 요약해줘');
  assert.equal(session.turnUsage.total, 50);
  assert.equal(session.usage.total, 50);
  assert.equal(session.context.window, 1_048_576);
});

test('실행 명령은 각 제공사의 공식 구조화 출력 플래그를 사용한다', () => {
  const base = { prompt: 'hello', cwd: root, allowWrites: false };
  assert.ok(commandSpec('claude', base, 'claude').args.includes('stream-json'));
  assert.ok(commandSpec('codex', base, 'codex').args.includes('--json'));
  assert.ok(commandSpec('gemini', base, 'gemini').args.includes('stream-json'));
  assert.ok(commandSpec('grok', base, 'grok').args.includes('streaming-json'));
});

test('PTY 터미널을 만들고 입력·명령·리사이즈·신호·재시작·종료를 제어한다', () => {
  const processes = [];
  class FakePty {
    constructor(pid) { this.pid = pid; this.writes = []; this.resizes = []; this.killed = false; }
    onData(callback) { this.dataCallback = callback; }
    onExit(callback) { this.exitCallback = callback; }
    write(value) { this.writes.push(value); }
    resize(cols, rows) { this.resizes.push([cols, rows]); }
    clear() { this.cleared = true; }
    kill() { this.killed = true; }
  }
  const manager = new TerminalManager({ killTree: handle => handle.kill(), ptyModule: { spawn: () => {
    const processHandle = new FakePty(9000 + processes.length);
    processes.push(processHandle);
    return processHandle;
  } } });
  const session = manager.create({ type: 'powershell', cwd: root, cols: 100, rows: 30 });
  assert.equal(session.status, 'running');
  assert.equal(session.pid, 9000);
  manager.write(session.id, 'hello');
  manager.command(session.id, 'Get-Location');
  manager.resize(session.id, 140, 44);
  manager.signal(session.id, 'interrupt');
  manager.signal(session.id, 'clear');
  assert.deepStrictEqual(processes[0].writes, ['hello', 'Get-Location\r', '\x03', '\x0c']);
  assert.deepStrictEqual(processes[0].resizes, [[140, 44]]);
  assert.equal(processes[0].cleared, true);
  processes[0].dataCallback('PTY_OK');
  assert.equal(manager.get(session.id, true).replay, 'PTY_OK');
  const restarted = manager.restart(session.id);
  assert.equal(processes[0].killed, true);
  assert.equal(restarted.pid, 9001);
  assert.equal(restarted.replay, '');
  manager.close(session.id);
  assert.equal(processes[1].killed, true);
  assert.equal(manager.list().length, 0);
  assert.equal(normalizeLaunchOptions({ type: 'cmd', cwd: root }).type, 'cmd');
  assert.ok(launchSpec(normalizeLaunchOptions({ type: 'powershell', cwd: root })).args.includes('-NoLogo'));
  const macShell = normalizeLaunchOptions({ cwd: root }, 'darwin');
  assert.equal(macShell.type, 'shell');
  assert.equal(launchSpec(macShell, 'darwin').args[0], '-l');
  const macTmux = launchSpec(normalizeLaunchOptions({ type: 'tmux', distro: 'macOS', tmuxSession: 'work' }, 'darwin'), 'darwin');
  assert.notEqual(macTmux.file, 'wsl.exe');
});

test('tmux 명령은 셸 문자열 결합 없이 대상·입력을 분리하고 관리 동작을 지원한다', async () => {
  const calls = [];
  const controller = new TmuxController({ platform: 'win32', run: async (file, args, options = {}) => {
    calls.push({ file, args, options });
    return { ok: true, stdout: args.includes('split-window') ? '%99\n' : 'capture output', stderr: '' };
  } });
  const command = 'printf "hello; $(safe)"';
  await controller.sendText({ distro: 'Ubuntu', target: '%1', text: command, enter: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].file, 'wsl.exe');
  assert.deepStrictEqual(calls[0].args.slice(-3), ['tmux', 'load-buffer', '-']);
  assert.equal(calls[0].options.input, command);
  assert.equal(calls.some(call => call.args.includes(command)), false);
  assert.deepStrictEqual(calls[1].args.slice(-5), ['tmux', 'paste-buffer', '-d', '-t', '%1']);
  assert.deepStrictEqual(calls[2].args.slice(-5), ['tmux', 'send-keys', '-t', '%1', 'Enter']);
  const split = await controller.splitPane({ distro: 'Ubuntu', target: '%1', direction: 'horizontal', cwd: '/repo' });
  assert.equal(split.paneId, '%99');
  await controller.newSession({ distro: 'Ubuntu', name: 'safe-name', cwd: '/repo' });
  await controller.selectLayout({ distro: 'Ubuntu', target: '@1', layout: 'tiled' });
  assert.equal(safeName('작업-1'), '작업-1');
  assert.equal(safeTarget('$1:@2.%3'), '$1:@2.%3');
  assert.throws(() => controller.sendKey({ distro: 'Ubuntu', target: '%1', key: 'run-shell' }), /허용되지 않은/);
  assert.throws(() => safeName('bad name;rm'), /이름에는/);
  assert.throws(() => safeTarget('%1;rm'), /대상 형식/);
  const macCalls = [];
  const mac = new TmuxController({ platform: 'darwin', run: async (file, args) => { macCalls.push({ file, args }); return { ok: true, stdout: '' }; } });
  await mac.sendKey({ distro: 'macOS', target: '%1', key: 'Enter' });
  assert.equal(macCalls[0].file, 'tmux');
  assert.deepStrictEqual(macCalls[0].args, ['send-keys', '-t', '%1', 'Enter']);
});

test('제공사별 합계와 활성 세션 수를 계산한다', () => {
  const session = { provider: 'claude', status: 'running', parentId: null, usage: { input: 10, output: 5, total: 15 } };
  const summary = buildSummary([session], { claude: 'claude.exe' });
  assert.equal(summary.totals.active, 1);
  assert.equal(summary.providers.find(item => item.id === 'claude').usage.total, 15);
});

test('메인과 렌더러 JavaScript 문법이 유효하다', () => {
  for (const file of ['main.js', 'preload.js', 'bin/lodestar.js', 'src/bridgeServer.js', 'src/providerRegistry.js', 'src/agentMonitor.js', 'src/agentRunner.js', 'src/tmuxMonitor.js', 'src/tmuxController.js', 'src/terminalManager.js', 'src/processMonitor.js', 'src/monitorWorker.js', 'renderer/app.js', 'renderer/terminal.js', 'scripts/bridge-integration-test.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  }
});

test('필수 UI 영역과 초보자용 안내 계약이 존재한다', () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  for (const id of ['beginnerGuide', 'providerOverview', 'liveSection', 'liveSessionGrid', 'graphBreadcrumbs', 'graphResetBtn', 'terminalSection', 'terminalWorkbench', 'terminalWorkbenchMount', 'terminalViewport', 'terminalCommandForm', 'terminalSessionList', 'terminalTmuxList', 'tmuxCreateModal', 'tmuxSection', 'tmuxControlSection', 'tmuxWorkbenchMount', 'tmuxStats', 'tmuxBreadcrumbs', 'tmuxResetBtn', 'tmuxMap', 'sessionGrid', 'loadMoreBtn', 'detailDrawer', 'runModal', 'drawerContent']) assert.ok(html.includes(`id="${id}"`));
  for (const label of ['처음이라면 이렇게 보세요', '>홈<', '>진행 중<', '>내 확인 필요<', '직접 실행 · tmux 안 씀', '>일반 명령창<', 'tmux 전용', '>tmux 작업<', '일반 명령창만', 'tmux 안의 명령창만', 'AI에게 새 일 맡기기', 'AI들이 맡은 일', 'tmux 작업 만들기']) assert.ok(html.includes(label), `${label} 문구가 없습니다.`);
  for (const jargon of ['AI AGENT OBSERVATORY', 'SESSION STREAM', 'AGENT MIND MAP', 'NEW TMUX SESSION']) assert.equal(html.includes(jargon), false, `${jargon} 전문 용어가 기본 화면에 남아 있습니다.`);
  const terminalBlock = html.slice(html.indexOf('id="terminalSection"'), html.indexOf('id="tmuxSection"'));
  const tmuxBlock = html.slice(html.indexOf('id="tmuxSection"'), html.indexOf('id="liveSection"'));
  for (const tmuxOnlyId of ['newTmuxSessionBtn', 'terminalTmuxList', 'tmuxControlSection']) {
    assert.equal(terminalBlock.includes(`id="${tmuxOnlyId}"`), false, `${tmuxOnlyId}가 일반 명령창 영역에 섞여 있습니다.`);
    assert.equal(tmuxBlock.includes(`id="${tmuxOnlyId}"`), true, `${tmuxOnlyId}가 tmux 전용 영역에 없습니다.`);
  }
  assert.equal(html.includes('data-view="subagents"'), false);
  assert.equal(html.includes('id="navSubagentCount"'), false);
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  for (const contract of ['function renderAgentMap', 'function connectedGraphSessions', 'function providerFlowLane', 'function focusedGraph', 'function workflowCompactNode', 'function drawAgentWorkflowConnections', 'function workflowCurve', 'function captureMotionLayout', 'function playMotionLayout', 'function motionEnterOffset', 'function animateVisibleSections', 'function agentCommandComposer', 'function agentControlMode', 'function dispatchAgentCommand', 'function openAgentTerminal', 'function copyBridgeCommand', 'function openSessionOrigin', 'data-agent-command-form', 'data-agent-command-draft', 'data-agent-terminal-open', 'data-agent-bridge-copy', 'data-agent-open-origin', '직접 입력 가능', '연결 후 입력 가능', '보기 전용 · 원래 앱에서 계속', '종료된 세션', '바로 보내기', 'data-motion-key', 'data-motion-value', 'dataset.lastMotion', 'motion-connect', 'pathLength="1"', 'prefers-reduced-motion: reduce', 'data-graph-provider-more', 'agent-flow-overview', 'agent-workflow-canvas', 'data-workflow-port', '이 일을 맡긴 AI', '지금 선택한 AI', '이 AI가 나눠 맡긴 일', 'function renderTmuxMap', 'function tmuxPaneCard', 'function messageContentHtml', 'function memoryCandidatesHtml', 'data-scroll-latest', 'data-graph-focus', 'data-tmux-type', 'data-open-session']) assert.ok(app.includes(contract));
  assert.equal(app.includes('agent-focus-layout'), false);
  assert.equal(app.includes("state.view === 'subagents'"), false);
  const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
  for (const contract of ['--motion-ease', 'motion-section-in', 'motion-live-update', 'motion-edge-draw', 'motion-modal-in', 'motion-modal-out', 'motion-toast-in', 'motion-toast-out', 'agent-command-panel', 'agent-command-input', '@media(prefers-reduced-motion:reduce)']) assert.ok(styles.includes(contract), `${contract} 모션 계약이 없습니다.`);
  const terminal = fs.readFileSync(path.join(root, 'renderer', 'terminal.js'), 'utf8');
  for (const contract of ['window.Terminal', 'FitAddon.FitAddon', 'wslDistros', 'terminalWrite', 'terminalResize', 'tmuxSendText', 'tmuxCapture', 'tmuxSplitPane', 'tmuxKillSession', 'function modeSessions', 'function moveWorkbench', 'function agentTargets', 'function requiredAgentTarget', 'function dispatchAgentCommand', 'function openForAgent', 'selectTmuxById', 'window.LodestarTerminal']) assert.ok(terminal.includes(contract));
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes('@xterm/xterm/lib/xterm.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['node-pty']);
  assert.ok(pkg.dependencies['@xterm/xterm']);
  assert.ok(pkg.dependencies['@xterm/addon-fit']);
  assert.equal(pkg.bin.lodestar, 'bin/lodestar.js');
  assert.ok(pkg.build.mac.target.some(item => item.arch.includes('arm64') && item.arch.includes('x64')));
});

test('제품 소스에 이전 워크플로우 명칭이 남아 있지 않다', () => {
  const targets = ['main.js', 'preload.js', 'package.json', 'README.md', 'src', 'renderer', 'scripts'];
  const forbidden = new RegExp(['w', 'c', 'c'].join(''), 'i');
  const visit = target => {
    const full = path.join(root, target);
    if (!fs.existsSync(full)) return;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full)) visit(path.join(target, name));
    } else if (/\.(js|json|html|css|md)$/i.test(full)) {
      assert.equal(forbidden.test(fs.readFileSync(full, 'utf8')), false, `${target}에 제거 대상 명칭이 남아 있습니다.`);
    }
  };
  targets.forEach(visit);
});

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`✓ ${name}\n`);
    } catch (error) {
      process.stderr.write(`✗ ${name}\n${error.stack}\n`);
      process.exitCode = 1;
    }
  }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  if (!process.exitCode) process.stdout.write(`\n${passed}개 회귀 테스트 통과\n`);
}

runTests().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
