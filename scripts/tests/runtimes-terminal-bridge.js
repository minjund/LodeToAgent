'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { parseArguments } = require('../../bin/loadtoagent');
const { parseGeneric, buildSummary } = require('../../src/agentMonitor');
const { AgentRunner, commandSpec, handleClaude } = require('../../src/agentRunner');
const { BridgeServer, decodeBase64 } = require('../../src/bridgeServer');
const { ProcessMonitor, processRows, powershellProcessRows, posixProcessRows, providerFromPosixProcess, selectAgentProcesses, processSessionExternalId, bridgeLinkScore, applyRuntimePresence } = require('../../src/processMonitor');
const { TerminalManager, normalizeLaunchOptions, launchSpec, resolveWindowsCommand, resolvePosixShell } = require('../../src/terminalManager');
const { TerminalHostServer, TerminalHostClient, resolveTerminalHostExecutable } = require('../../src/terminalHost');
const { TmuxController, safeName, safeTarget } = require('../../src/tmuxController');
const { TmuxMonitor, normalizeWslList, parseTmuxProbe, buildDistroTopology, linkAgentSessions, providerFromProcess } = require('../../src/tmuxMonitor');

async function waitUntil(predicate, timeoutMs = 2_000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, intervalMs));
  return predicate();
}

function registerTmuxAndProcessTests(context) {
  const { test } = context;
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
    const deadTopology = structuredClone(topology);
    deadTopology.distros[0].sessions[0].windows[0].panes[0].dead = true;
    const deadLinked = linkAgentSessions(deadTopology, [session]);
    assert.equal(deadLinked.summary.aiPanes, 0);
    assert.equal(deadLinked.summary.linked, 0);
    assert.equal(deadLinked.distros[0].sessions[0].windows[0].panes[0].agent.status, 'failed');
    assert.equal(deadLinked.distros[0].sessions[0].windows[0].panes[0].agent.linkedSessionId, null);
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
    const zeroTtlMonitor = new TmuxMonitor({ platform: 'darwin', execFileSync: () => output, scanTtlMs: 0, discoveryTtlMs: 0 });
    assert.equal(zeroTtlMonitor.scanTtlMs, 0);
    assert.equal(zeroTtlMonitor.discoveryTtlMs, 0);
  });

  test('Windows AI CLI와 tmux 연결은 대화 로그의 실제 상태를 덮어쓰지 않는다', () => {
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
    const multiline = powershellProcessRows(JSON.stringify({
      pid: 103, parentPid: 10, name: 'claude.exe',
      commandLine: 'claude.exe -p "첫 줄\n둘째 줄"', startedAt: '2026-07-14T03:00:02.0000000Z',
    }));
    assert.equal(multiline[0].commandLine, 'claude.exe -p "첫 줄\n둘째 줄"');
    assert.equal(multiline[0].startedAt, '2026-07-14T03:00:02.000Z');
    const processCalls = [];
    const windowsMonitor = new ProcessMonitor({
      platform: 'win32', scanTtlMs: 0,
      execFileSync: (file, args, options) => {
        processCalls.push({ file, args, options });
        return JSON.stringify(multiline);
      },
    });
    const windowsSnapshot = windowsMonitor.scan(true);
    assert.equal(windowsSnapshot.available, true);
    assert.equal(windowsSnapshot.processes[0].pid, 103);
    assert.equal(windowsSnapshot.processes[0].interactionMode, 'batch');
    assert.equal(processCalls[0].file, 'powershell.exe');
    assert.equal(processCalls[0].options.windowsHide, true);

    const base = {
      distros: [{ name: 'Ubuntu', sessions: [{ name: 'tmux-work', windows: [{ panes: [{ nativeId: '%1', index: 0, cwd: '/repo', agent: { provider: 'claude', pid: 301, linkedSessionId: 'claude:wsl', startedAt: '2026-07-14T03:00:00Z' } }] }] }] }],
    };
    const usage = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
    const sessions = [
      { id: 'claude:wsl', provider: 'claude', environment: { kind: 'wsl' }, status: 'running', title: 'WSL Claude', updatedAt: '2026-07-14T03:00:00Z', usage, childIds: [] },
      { id: 'claude:win', provider: 'claude', environment: { kind: 'windows' }, status: 'idle', title: 'Windows Claude', startedAt: '2026-07-14T03:00:00Z', updatedAt: '2026-07-14T03:00:00Z', usage, childIds: [] },
      { id: 'codex:win', provider: 'codex', environment: { kind: 'windows' }, status: 'running', title: 'Windows Codex', startedAt: '2026-07-14T03:00:01Z', updatedAt: '2026-07-14T03:00:01Z', usage, childIds: [] },
    ];
    const active = applyRuntimePresence(sessions, base, { processes }, Date.parse('2026-07-14T03:01:00Z'));
    assert.equal(active.filter(item => item.status === 'running').length, 2);
    assert.equal(active.find(item => item.id === 'claude:wsl').runtimePresence[0].kind, 'tmux');
    assert.equal(active.find(item => item.id === 'claude:wsl').runtimePresence[0].distro, 'Ubuntu');
    assert.equal(active.find(item => item.id === 'claude:wsl').runtimePresence[0].paneNativeId, '%1');
    assert.equal(active.find(item => item.id === 'claude:win').status, 'idle');
    assert.equal(active.find(item => item.id === 'claude:win').runtimePresence[0].pid, 101);
    assert.equal(active.find(item => item.id === 'codex:win').runtimePresence[0].pid, 202);

    const deadTmux = structuredClone(base);
    deadTmux.distros[0].sessions[0].windows[0].panes[0].dead = true;
    const afterDeadPane = applyRuntimePresence([sessions[0]], deadTmux, { processes: [] }, Date.parse('2026-07-14T03:01:00Z'));
    assert.equal(afterDeadPane[0].status, 'running');
    assert.deepStrictEqual(afterDeadPane[0].runtimePresence || [], []);
  });

  test('인자가 있는 Windows Claude CLI는 감지하고 자동 점검·데몬은 제외한다', () => {
    const rows = [
      { pid: 401, parentPid: 40, name: 'claude.exe', commandLine: 'C:\\Users\\dev\\.local\\bin\\claude.exe --resume session-1', startedAt: '2026-07-14T03:00:00Z' },
      { pid: 402, parentPid: 40, name: 'claude.exe', commandLine: 'C:\\Users\\dev\\.local\\bin\\claude.exe daemon run --json-path daemon.json', startedAt: '2026-07-14T03:00:00Z' },
      { pid: 403, parentPid: 40, name: 'claude.exe', commandLine: 'C:\\Users\\dev\\.local\\bin\\claude.exe -p Reply with exactly OK. Do not use tools.', startedAt: '2026-07-14T03:00:00Z' },
      { pid: 404, parentPid: 40, name: 'claude.exe', commandLine: 'C:\\Users\\dev\\.local\\bin\\claude.exe -p --output-format json "/scheduled-run --tick seo; memory example: Reply with exactly OK. Do not use tools."', startedAt: '2026-07-14T03:00:20Z' },
    ];
    const processes = selectAgentProcesses(rows);
    assert.deepStrictEqual(processes.map(item => [item.provider, item.pid, item.parentPid]), [['claude', 401, 40], ['claude', 404, 40]]);
    assert.equal(processes[0].externalId, 'session-1');
    assert.equal(processes[1].interactionMode, 'batch');
    const runtime = applyRuntimePresence([], {}, { processes }, Date.parse('2026-07-14T03:01:00Z'));
    assert.deepStrictEqual(runtime, []);

    const linked = applyRuntimePresence([{
      id: 'claude:session-1', externalId: 'session-1', provider: 'claude', environment: { kind: 'windows' },
      clientKind: 'claude-desktop', status: 'idle', title: '사용자가 최근 실행한 대화',
      startedAt: '2026-07-10T03:00:00Z', updatedAt: '2026-07-14T03:00:00Z', childIds: [],
    }], {}, { processes }, Date.parse('2026-07-14T03:01:00Z'));
    assert.equal(linked.length, 1);
    assert.equal(linked[0].title, '사용자가 최근 실행한 대화');
    assert.equal(linked[0].status, 'idle');
    assert.equal(linked[0].runtimePresence[0].pid, 401);
    assert.equal(linked[0].runtimePresence[0].linkScore, 'explicit-session-id');
    const batch = applyRuntimePresence([{
      id: 'claude:scheduled', externalId: 'scheduled', provider: 'claude', environment: { kind: 'windows' },
      clientKind: 'claude-cli', status: 'waiting', statusDetail: '응답 또는 권한 확인 필요', title: '/scheduled-run --tick seo',
      startedAt: '2026-07-14T03:00:20Z', updatedAt: '2026-07-14T03:00:50Z', childIds: [],
    }], {}, { processes: [processes[1]] }, Date.parse('2026-07-14T03:01:00Z'));
    assert.equal(batch[0].status, 'running');
    assert.equal(batch[0].conversationStatus, 'waiting');
    assert.match(batch[0].statusDetail, /화면 밖에서 AI가 계속 작업 중/);
    assert.equal(batch[0].runtimePresence[0].pid, 404);
    const commandLine = 'claude.exe --session-id current-session --fork-session --resume C:\\Users\\dev\\.claude\\projects\\repo\\old-session.jsonl';
    assert.equal(processSessionExternalId({ commandLine }, 'claude'), 'current-session');
    assert.equal(processSessionExternalId({ commandLine: 'claude.exe --resume "C:\\Users\\dev\\.claude\\projects\\repo\\resumed-session.jsonl"' }, 'claude'), 'resumed-session');
  });

  test('세션 터미널은 추측 대신 명시된 AI 세션 ID에 연결한다', () => {
    const usage = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
    const sessions = [
      { id: 'claude:bound', provider: 'claude', environment: { kind: 'windows' }, clientKind: 'claude-desktop', status: 'idle', title: '이어갈 실제 대화', startedAt: '2026-07-10T00:00:00Z', updatedAt: '2026-07-10T00:00:00Z', usage, childIds: [] },
      { id: 'claude:recent', provider: 'claude', environment: { kind: 'windows' }, clientKind: 'claude-cli', status: 'idle', title: '최근의 다른 대화', startedAt: '2026-07-14T03:00:00Z', updatedAt: '2026-07-14T03:00:00Z', usage, childIds: [] },
    ];
    const bridge = {
      id: 'claude:bound', bridgeId: 'claude:bound', linkedSessionId: 'claude:bound', terminalId: 'terminal:resume',
      provider: 'claude', pid: 501, cwd: 'D:\\repo', startedAt: '2026-07-14T03:01:00Z', environment: 'windows',
    };
    const active = applyRuntimePresence(sessions, {}, { processes: [] }, Date.parse('2026-07-14T03:01:00Z'), [bridge]);
    const bound = active.find(item => item.id === 'claude:bound');
    assert.equal(bound.status, 'idle');
    assert.equal(bound.runtimePresence[0].terminalId, 'terminal:resume');
    assert.equal(bound.runtimePresence[0].linkScore, 'explicit');
    assert.equal(active.find(item => item.id === 'claude:recent').status, 'idle');
    assert.equal(active.some(item => item.id.startsWith('bridge:')), false);
  });

}

function registerNativeProcessTests(context) {
  const { test } = context;

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
    assert.equal(bridgeLinkScore({ ...base, provider: 'claude', clientKind: 'claude-desktop', startedAt: bridge.startedAt }, { ...bridge, provider: 'claude' }, now), -Infinity);
    assert.equal(bridgeLinkScore({ ...base, clientKind: 'codex-cli', startedAt: '2026-07-14T09:40:00Z' }, bridge, now), -Infinity);
    assert.ok(bridgeLinkScore({ ...base, clientKind: 'codex-cli', startedAt: '2026-07-14T09:59:35Z' }, bridge, now) > 10_000);
  });

}

function registerBridgeIntegrationTests(context) {
  const { test, temp, root } = context;
  test('LoadToAgent 외부 브리지는 인증 소켓으로 전용 PTY에만 입력한다', async () => {
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
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\loadtoagent-test-${process.pid}-${Date.now()}` : path.join(temp, 'bridge.sock');
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
    const closed = new Promise(resolve => socket.once('close', resolve));
    manager.emit('state', {
      session: { ...manager.sessions[0], status: 'stopped', exitCode: 0, signal: 0 },
    });
    const stopped = await nextFrame();
    assert.equal(stopped.type, 'state');
    assert.equal(stopped.status, 'stopped');
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('중단된 관리형 브리지 연결이 닫히지 않았습니다.')), 2_000)),
    ]);
    server.dispose();
    assert.equal(fs.existsSync(discovery), false);
    assert.deepStrictEqual(parseArguments(['run', 'codex', '--', '--model', 'gpt-5.4']), { provider: 'codex', args: ['--model', 'gpt-5.4'] });
  });

}

function registerGenericAgentTests(context) {
  const { test, temp, root } = context;
  test('Gemini/Grok 계열 JSON 세션을 공통 모델로 읽는다', () => {
    const file = path.join(temp, 'gemini', 'session.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      id: 'gem-1', model: 'gemini-3.5-flash', cwd: 'D:\\repo',
      messages: [{ id: 'u', role: 'user', content: '문서를 요약해줘' }, { id: 'a', role: 'model', content: '요약입니다.', usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, totalTokenCount: 50 } }],
      events: [
        { id: 'gem-shell', type: 'tool_use', name: 'shell_command', parameters: { command: 'npm test', cwd: 'D:\\repo' }, timestamp: '2026-07-14T02:00:00Z' },
        { id: 'gem-shell-result', type: 'tool_result', tool_call_id: 'gem-shell', output: 'Exit code: 0', timestamp: '2026-07-14T02:00:01Z' },
      ],
    }), 'utf8');
    const stat = fs.statSync(file);
    const session = parseGeneric({ file, mtimeMs: stat.mtimeMs, size: stat.size }, 'gemini');
    assert.equal(session.title, '문서를 요약해줘');
    assert.equal(session.turnUsage.total, 50);
    assert.equal(session.usage.total, 50);
    assert.equal(session.context.window, 1_048_576);
    assert.deepStrictEqual(session.executions.map(item => [item.kind, item.mode, item.status, item.command]), [['shell', 'foreground', 'completed', 'npm test']]);

    const questionFile = path.join(temp, 'gemini', 'question.json');
    fs.writeFileSync(questionFile, JSON.stringify({
      id: 'gem-question',
      messages: [
        { id: 'question-u', role: 'user', content: '실행 환경을 정해줘' },
        { id: 'question-a', role: 'model', content: 'WSL과 Windows 중 어떤 환경으로 진행할까요?' },
      ],
    }), 'utf8');
    const questionStat = fs.statSync(questionFile);
    const waiting = parseGeneric({ file: questionFile, mtimeMs: questionStat.mtimeMs, size: questionStat.size }, 'gemini');
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.statusDetail, '내 답변을 기다리는 중');
  });

  test('Gemini/Grok 스트리밍 메시지는 같은 ID의 최종 내용만 시간순으로 표시한다', () => {
    const file = path.join(temp, 'grok', 'stream.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ id: 'grok-1', events: [
      { id: 'a1', role: 'assistant', content: '답', timestamp: '2026-01-01T00:00:02.000Z' },
      { id: 'u1', role: 'user', content: '질문', timestamp: '2026-01-01T00:00:01.000Z' },
      { id: 'a1', role: 'assistant', content: '답변 완성', timestamp: '2026-01-01T00:00:03.000Z' },
      { id: 'a2', type: 'message_delta', role: 'assistant', delta: '조', timestamp: '2026-01-01T00:00:04.000Z' },
      { id: 'a2', type: 'message_delta', role: 'assistant', delta: '각', timestamp: '2026-01-01T00:00:05.000Z' },
      { id: 'tool1', type: 'tool_use', role: 'assistant', content: '도구 중복 본문', name: 'search', timestamp: '2026-01-01T00:00:02.500Z' },
    ] }), 'utf8');
    const stat = fs.statSync(file);
    const session = parseGeneric({ file, mtimeMs: stat.mtimeMs, size: stat.size }, 'grok');
    const chat = session.messages.filter(message => message.role === 'user' || message.role === 'assistant');
    assert.deepStrictEqual(chat.map(message => message.text), ['질문', '답변 완성', '조각']);
    assert.equal(session.messages.filter(message => message.id === 'tool1').length, 1);
  });

  test('실행 명령은 각 제공사의 공식 구조화 출력 플래그를 사용한다', () => {
    const base = { prompt: 'hello', cwd: root, allowWrites: false };
    assert.ok(commandSpec('claude', base, 'claude').args.includes('stream-json'));
    assert.ok(commandSpec('codex', base, 'codex').args.includes('--json'));
    assert.ok(commandSpec('gemini', base, 'gemini').args.includes('stream-json'));
    assert.ok(commandSpec('grok', base, 'grok').args.includes('streaming-json'));
  });

  test('Claude 구조화 스트림은 부분·완료·result 이벤트를 하나의 답변으로 합친다', () => {
    const state = {
      externalId: 'runner-fixture',
      model: '',
      status: 'running',
      statusDetail: '',
      endedAt: null,
      messages: [],
      lifecycle: [],
      usage: {},
      turnUsage: {},
    };
    handleClaude(state, {
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'claude-message-1' } },
    });
    handleClaude(state, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '첫 번째' } },
    });
    handleClaude(state, {
      type: 'assistant',
      message: {
        id: 'claude-message-1',
        model: 'claude-haiku-fixture',
        content: [
          { type: 'text', text: '첫 번째 답변' },
          { type: 'text', text: '두 번째 문단' },
        ],
      },
    });
    handleClaude(state, {
      type: 'result',
      is_error: false,
      result: '첫 번째 답변\n두 번째 문단',
      usage: { input_tokens: 10, output_tokens: 4 },
    });

    assert.deepStrictEqual(
      state.messages.filter(message => message.role === 'assistant').map(message => [message.id, message.text, message.status]),
      [['claude-message-1', '첫 번째 답변\n두 번째 문단', 'done']],
    );
    assert.equal(state.status, 'completed');
    assert.equal(state.usage.total, 14);

    const errorState = {
      externalId: 'runner-error-fixture',
      model: '',
      status: 'running',
      statusDetail: '',
      endedAt: null,
      messages: [],
      lifecycle: [],
      usage: {},
      turnUsage: {},
    };
    const errorText = 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.';
    handleClaude(errorState, {
      type: 'assistant',
      message: {
        id: 'claude-error-message',
        model: '<synthetic>',
        content: [{ type: 'text', text: errorText }],
      },
    });
    handleClaude(errorState, {
      type: 'result',
      is_error: true,
      result: errorText,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    assert.deepStrictEqual(
      errorState.messages.filter(message => message.role === 'assistant').map(message => message.text),
      [errorText],
    );
    assert.equal(errorState.status, 'failed');
  });

  test('실패한 관리 실행은 저장된 안전 설정으로 새 실행을 만든다', () => {
    const runsDir = path.join(temp, 'agent-runs-retry');
    const previousId = 'legacy-run';
    const previousDir = path.join(runsDir, previousId);
    const expiredDir = path.join(runsDir, 'expired-completed-run');
    const activeDir = path.join(runsDir, 'old-active-run');
    fs.mkdirSync(previousDir, { recursive: true });
    fs.mkdirSync(expiredDir, { recursive: true });
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(previousDir, 'meta.json'), JSON.stringify({
      provider: 'codex', prompt: '검증을 다시 실행해줘', cwd: root, model: 'gpt-fixture', allowWrites: true,
    }), 'utf8');
    fs.writeFileSync(path.join(expiredDir, 'session.json'), JSON.stringify({
      status: 'completed', endedAt: '2025-01-01T00:00:00.000Z',
    }), 'utf8');
    fs.writeFileSync(path.join(activeDir, 'session.json'), JSON.stringify({
      status: 'running', updatedAt: '2025-01-01T00:00:00.000Z',
    }), 'utf8');
    const runner = new AgentRunner({
      runsDir,
      retentionDays: 30,
      now: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(fs.existsSync(expiredDir), false);
    assert.equal(fs.existsSync(activeDir), true);
    let received = null;
    runner.start = options => {
      received = options;
      return { ok: true, runId: 'new-run', sessionId: 'new-session' };
    };
    assert.deepStrictEqual(runner.retry(previousId), {
      ok: true, runId: 'new-run', sessionId: 'new-session', retriedFrom: previousId,
    });
    assert.deepStrictEqual(received, {
      provider: 'codex', prompt: '검증을 다시 실행해줘', cwd: root, model: 'gpt-fixture', allowWrites: true,
    });
    runner.active.set(previousId, {});
    assert.equal(runner.retry(previousId).ok, false);
    assert.equal(runner.retry('../escape').ok, false);
  });

}

function registerTerminalLifecycleTests(context) {
  const { test, temp, root } = context;
  test('지속형 AI 터미널은 독립 tmux 소켓의 관리 세션으로 시작한다', () => {
    const spawns = [];
    class FakePty {
      constructor() { this.pid = 8_001; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile: path.join(temp, 'managed-tmux-create.json'),
      killTree: () => {},
      ptyModule: {
        spawn: (file, args, options) => {
          spawns.push({ file, args, options });
          return new FakePty();
        },
      },
      managedTmuxRuntime: {
        exists: () => true,
        stop: () => ({ ok: true }),
      },
    });

    const session = manager.create({ type: 'agent', provider: 'codex', cwd: root });

    assert.equal(session.backend, 'managed-tmux');
    assert.equal(session.tmuxSocket, 'loadtoagent');
    assert.match(session.managedTmuxSession, /^lta-codex-/);
    assert.equal(spawns[0].file, 'tmux');
    assert.deepStrictEqual(spawns[0].args.slice(0, 5), ['-L', 'loadtoagent', 'new-session', '-A', '-s']);
    assert.equal(spawns[0].args.includes(session.managedTmuxSession), true);
    assert.deepStrictEqual(spawns[0].args.slice(-5), ['codex', ';', 'set-option', '-g', 'window-size', 'largest'].slice(-5));
    manager.close(session.id);
  });

  test('관리형 AI 전송은 복구 인자가 있어도 새 tmux 세션을 만들고 질문은 한 번만 실행한다', () => {
    const spawns = [];
    class FakePty {
      constructor() { this.pid = 8_021; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const storeFile = path.join(temp, 'managed-tmux-send-with-recovery.json');
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile,
      killTree: () => {},
      ptyModule: {
        spawn: (file, args) => {
          spawns.push({ file, args });
          return new FakePty();
        },
      },
      managedTmuxRuntime: {
        exists: () => true,
        stop: () => ({ ok: true }),
      },
    });

    const session = manager.create({
      type: 'agent',
      provider: 'codex',
      cwd: root,
      bridgeId: 'codex:send-with-recovery',
      args: ['resume', 'send-with-recovery', '실제 질문'],
      recoveryArgs: ['resume', 'send-with-recovery'],
      initialCommand: '실제 질문',
      initialCommandInArgs: true,
      reuseBridge: true,
    });

    assert.equal(session.status, 'running');
    assert.match(session.managedTmuxSession, /^lta-codex-/);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].args.includes(session.managedTmuxSession), true);
    assert.equal(spawns[0].args.filter(item => item === '실제 질문').length, 1);
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8')).sessions[0];
    assert.deepStrictEqual(stored.options.args, ['resume', 'send-with-recovery']);
    assert.equal(JSON.stringify(stored).includes('실제 질문'), false);
    manager.close(session.id);
  });

  test('관리형 attach 화면이 자연 종료되어도 살아 있는 tmux 작업은 detached로 보존한다', () => {
    let tmuxExists = true;
    class FakePty {
      constructor() { this.pid = 8_051; }
      onData() {}
      onExit(callback) { this.exitCallback = callback; }
      write() {}
      resize() {}
      kill() {}
    }
    const processHandle = new FakePty();
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile: path.join(temp, 'managed-tmux-natural-detach.json'),
      killTree: () => {},
      managedTmuxRuntime: {
        exists: () => tmuxExists,
        stop: () => ({ ok: true }),
      },
      ptyModule: { spawn: () => processHandle },
    });
    const session = manager.create({ type: 'agent', provider: 'codex', cwd: root });

    processHandle.exitCallback({ exitCode: 0, signal: 0 });

    assert.equal(manager.get(session.id).status, 'detached');
    assert.equal(manager.get(session.id).pid, null);
    tmuxExists = false;
    manager.close(session.id);
  });

  test('관리형 attach 화면 종료 시 tmux 작업도 끝났다면 stopped 기록만 보존한다', () => {
    class FakePty {
      constructor() { this.pid = 8_052; }
      onData() {}
      onExit(callback) { this.exitCallback = callback; }
      write() {}
      resize() {}
      kill() {}
    }
    const processHandle = new FakePty();
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile: path.join(temp, 'managed-tmux-natural-stop.json'),
      killTree: () => {},
      managedTmuxRuntime: {
        exists: () => false,
        stop: () => ({ ok: true }),
      },
      ptyModule: { spawn: () => processHandle },
    });
    const session = manager.create({ type: 'agent', provider: 'codex', cwd: root });

    processHandle.exitCallback({ exitCode: 0, signal: 0 });

    assert.equal(manager.get(session.id).status, 'stopped');
    assert.equal(manager.get(session.id).pid, null);
    manager.close(session.id);
  });

  test('관리형 AI 터미널 detach는 화면 PTY만 닫고 세션을 유지한다', () => {
    const processes = [];
    const stopped = [];
    class FakePty {
      constructor(pid) { this.pid = pid; this.killed = false; }
      onData() {}
      onExit(callback) { this.exitCallback = callback; }
      write() {}
      resize() {}
      kill() { this.killed = true; }
    }
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile: path.join(temp, 'managed-tmux-detach.json'),
      killTree: handle => handle.kill(),
      managedTmuxRuntime: {
        exists: () => true,
        stop: options => stopped.push(options.managedTmuxSession),
      },
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(8_100 + processes.length);
          processes.push(handle);
          return handle;
        },
      },
    });
    const session = manager.create({ type: 'agent', provider: 'codex', cwd: root });

    const detached = manager.detach(session.id);

    assert.equal(detached.status, 'detached');
    assert.equal(detached.pid, null);
    assert.equal(processes[0].killed, true);
    assert.equal(manager.get(session.id).status, 'detached');
    assert.deepStrictEqual(stopped, []);
    manager.close(session.id);
  });

  test('관리형 AI 터미널 stop은 tmux 작업을 종료하되 기록을 보존한다', () => {
    const stopped = [];
    class FakePty {
      constructor() { this.pid = 8_201; this.killed = false; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() { this.killed = true; }
    }
    const processHandle = new FakePty();
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile: path.join(temp, 'managed-tmux-stop.json'),
      killTree: handle => handle.kill(),
      managedTmuxRuntime: {
        exists: () => true,
        stop: options => stopped.push({
          socket: options.tmuxSocket,
          session: options.managedTmuxSession,
        }),
      },
      ptyModule: { spawn: () => processHandle },
    });
    const session = manager.create({ type: 'agent', provider: 'codex', cwd: root });

    const result = manager.stop(session.id);

    assert.equal(result.status, 'stopped');
    assert.equal(result.pid, null);
    assert.equal(processHandle.killed, true);
    assert.deepStrictEqual(stopped, [{
      socket: 'loadtoagent',
      session: session.managedTmuxSession,
    }]);
    assert.equal(manager.list().length, 1);
    assert.equal(manager.get(session.id).status, 'stopped');
    manager.close(session.id);
  });

  test('터미널 호스트 장애 뒤 살아 있는 관리형 tmux 세션에 같은 ID로 재접속한다', () => {
    const storeFile = path.join(temp, 'managed-tmux-recovery.json');
    const spawned = [];
    class FakePty {
      constructor(pid) { this.pid = pid; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const runtime = {
      exists: () => true,
      stop: () => ({ ok: true }),
    };
    const managerOptions = {
      platform: 'darwin',
      storeFile,
      managedTmuxRuntime: runtime,
      killTree: () => {},
      ptyModule: {
        spawn: (file, args) => {
          spawned.push({ file, args });
          return new FakePty(8_300 + spawned.length);
        },
      },
    };
    const beforeCrash = new TerminalManager(managerOptions);
    const created = beforeCrash.create({
      type: 'agent',
      provider: 'codex',
      cwd: root,
      args: [],
    });
    beforeCrash.persistNow();

    const afterCrash = new TerminalManager(managerOptions);
    const recovered = afterCrash.recoverPersistedSessions();

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, created.id);
    assert.equal(recovered[0].status, 'running');
    assert.equal(recovered[0].managedTmuxSession, created.managedTmuxSession);
    assert.equal(spawned.length, 2);
    assert.equal(spawned[1].file, 'tmux');
    assert.deepStrictEqual(spawned[1].args, [
      '-L', 'loadtoagent',
      'attach-session', '-t', `=${created.managedTmuxSession}`,
    ]);
    assert.match(afterCrash.get(created.id, true).replay, /실행 중이던 작업에 다시 연결/);
    afterCrash.close(created.id);
  });

  test('관리형 AI 터미널 close는 tmux 작업과 저장 기록을 함께 제거한다', () => {
    const stopped = [];
    class FakePty {
      constructor() { this.pid = 8_401; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const storeFile = path.join(temp, 'managed-tmux-close.json');
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile,
      killTree: () => {},
      managedTmuxRuntime: {
        exists: () => true,
        stop: options => stopped.push(options.managedTmuxSession),
      },
      ptyModule: { spawn: () => new FakePty() },
    });
    const session = manager.create({ type: 'agent', provider: 'codex', cwd: root });

    manager.close(session.id);

    assert.deepStrictEqual(stopped, [session.managedTmuxSession]);
    assert.equal(manager.get(session.id), null);
    assert.equal(fs.readFileSync(storeFile, 'utf8').includes(session.id), false);
  });

  test('분리된 관리형 AI 터미널은 기존 tmux 세션에만 재접속한다', () => {
    const processes = [];
    let exists = true;
    class FakePty {
      constructor(pid) { this.pid = pid; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile: path.join(temp, 'managed-tmux-reconnect.json'),
      killTree: () => {},
      managedTmuxRuntime: {
        exists: () => exists,
        stop: () => ({ ok: true }),
      },
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(8_500 + processes.length);
          processes.push(handle);
          return handle;
        },
      },
    });
    const session = manager.create({ type: 'agent', provider: 'codex', cwd: root });
    manager.detach(session.id);

    const reconnected = manager.reconnect(session.id);

    assert.equal(reconnected.id, session.id);
    assert.equal(reconnected.status, 'running');
    assert.equal(reconnected.managedTmuxSession, session.managedTmuxSession);
    assert.equal(processes.length, 2);
    manager.detach(session.id);
    exists = false;
    assert.throws(() => manager.reconnect(session.id), /명령창 묶음이 끝나/);
    assert.equal(manager.get(session.id).status, 'stopped');
    assert.equal(processes.length, 2);
    manager.close(session.id);
  });

  test('관리형 AI 재접속은 새 AI를 시작하거나 이전 질문을 재실행하지 않는다', () => {
    const spawns = [];
    class FakePty {
      constructor(pid) { this.pid = pid; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile: path.join(temp, 'managed-tmux-attach-only.json'),
      killTree: () => {},
      managedTmuxRuntime: {
        exists: () => true,
        stop: () => ({ ok: true }),
      },
      ptyModule: {
        spawn: (file, args) => {
          spawns.push({ file, args });
          return new FakePty(8_550 + spawns.length);
        },
      },
    });
    const session = manager.create({
      type: 'agent',
      provider: 'codex',
      cwd: root,
      args: ['resume', '--', 'attach-only', '이전 질문'],
      recoveryArgs: ['resume', '--', 'attach-only'],
      initialCommand: '이전 질문',
      initialCommandInArgs: true,
    });
    manager.detach(session.id);

    manager.reconnect(session.id);

    assert.equal(spawns.length, 2);
    assert.deepStrictEqual(spawns[1].args, [
      '-L', 'loadtoagent',
      'attach-session', '-t', `=${session.managedTmuxSession}`,
    ]);
    assert.equal(spawns[1].args.includes('new-session'), false);
    assert.equal(spawns[1].args.includes('codex'), false);
    assert.equal(spawns[1].args.includes('이전 질문'), false);
    manager.close(session.id);

    const wslSpawns = [];
    const wslManager = new TerminalManager({
      platform: 'win32',
      storeFile: path.join(temp, 'managed-tmux-wsl-attach-only.json'),
      killTree: () => {},
      managedTmuxRuntime: {
        exists: () => true,
        stop: () => ({ ok: true }),
      },
      ptyModule: {
        spawn: (file, args) => {
          wslSpawns.push({ file, args });
          return new FakePty(8_600 + wslSpawns.length);
        },
      },
    });
    const wslSession = wslManager.create({
      type: 'agent',
      provider: 'gemini',
      cwd: '/mnt/c/workspace',
      distro: 'Ubuntu',
      sessionBackend: 'managed-tmux',
      args: ['--resume', 'wsl-attach-only', '--', 'WSL의 이전 질문'],
      recoveryArgs: ['--resume', 'wsl-attach-only'],
      initialCommand: 'WSL의 이전 질문',
      initialCommandInArgs: true,
    });
    wslManager.detach(wslSession.id);
    wslManager.reconnect(wslSession.id);
    assert.equal(wslSpawns.length, 2);
    assert.deepStrictEqual(wslSpawns[1], {
      file: 'wsl.exe',
      args: [
        '-d', 'Ubuntu', '--cd', '/mnt/c/workspace', '--',
        'tmux', '-L', 'loadtoagent', 'attach-session', '-t', `=${wslSession.managedTmuxSession}`,
      ],
    });
    assert.equal(wslSpawns[1].args.includes('gemini'), false);
    assert.equal(JSON.stringify(wslSpawns[1]).includes('WSL의 이전 질문'), false);
    wslManager.close(wslSession.id);
  });

  test('분리된 같은 AI 대화로 보내면 새 세션 없이 재접속해 명령을 한 번만 쓴다', () => {
    const processes = [];
    class FakePty {
      constructor(pid) { this.pid = pid; this.writes = []; }
      onData() {}
      onExit() {}
      write(value) { this.writes.push(value); }
      resize() {}
      kill() {}
    }
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile: path.join(temp, 'managed-tmux-detached-send.json'),
      killTree: () => {},
      managedTmuxRuntime: {
        exists: () => true,
        stop: () => ({ ok: true }),
      },
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(8_600 + processes.length);
          processes.push(handle);
          return handle;
        },
      },
    });
    const shared = {
      type: 'agent',
      provider: 'claude',
      cwd: root,
      bridgeId: 'claude:detached-send',
      reuseBridge: true,
    };
    const original = manager.create({
      ...shared,
      args: ['--resume', 'detached-send'],
      recoveryArgs: ['--resume', 'detached-send'],
    });
    manager.detach(original.id);

    const delivered = manager.create({
      ...shared,
      args: ['--resume', 'detached-send', '--', '후속 지시'],
      recoveryArgs: ['--resume', 'detached-send'],
      initialCommand: '후속 지시',
      initialCommandInArgs: true,
    });

    assert.equal(delivered.id, original.id);
    assert.equal(delivered.reused, true);
    assert.equal(delivered.status, 'running');
    assert.equal(delivered.promptSent, true);
    assert.equal(manager.list().length, 1);
    assert.equal(processes.length, 2);
    assert.deepStrictEqual(processes[0].writes, []);
    assert.deepStrictEqual(processes[1].writes, ['후속 지시\r']);
    manager.close(original.id);
  });

  test('터미널 호스트 프로토콜이 detach·reconnect·stop 생명주기를 전달한다', async () => {
    class FakeManager extends EventEmitter {
      constructor() { super(); this.calls = []; }
      list() { return []; }
      command(id, value, options) {
        this.calls.push(['command', id, value, options]);
        if (value === '보내기 전 거절') {
          const error = new Error('장부를 저장하지 못해 보내지 않음');
          error.code = 'DELIVERY_LEDGER_UNAVAILABLE';
          error.deliveryState = 'rejected';
          throw error;
        }
        return { ok: true, deliveryState: 'accepted' };
      }
      detach(id) { this.calls.push(['detach', id]); return { id, status: 'detached' }; }
      reconnect(id) { this.calls.push(['reconnect', id]); return { id, status: 'running' }; }
      stop(id) { this.calls.push(['stop', id]); return { id, status: 'stopped' }; }
    }
    const manager = new FakeManager();
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-managed-lifecycle-${process.pid}-${Date.now()}`
      : path.join(os.tmpdir(), `lta-managed-lifecycle-${process.pid}-${Date.now()}.sock`);
    const discovery = path.join(temp, 'managed-tmux-lifecycle-host.json');
    const server = new TerminalHostServer({
      manager,
      endpoint,
      discoveryFile: discovery,
      token: 'managed-lifecycle-token',
    });
    await server.start();
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      spawnHost: () => { throw new Error('기존 테스트 호스트를 사용해야 합니다.'); },
    });
    try {
      await client.connect();
      assert.equal((await client.command('terminal:managed', '한 번만 보내기', { deliveryId: 'delivery:host:1' })).deliveryState, 'accepted');
      await assert.rejects(
        client.command('terminal:managed', '보내기 전 거절', { deliveryId: 'delivery:host:rejected' }),
        error => error.code === 'DELIVERY_LEDGER_UNAVAILABLE' && error.deliveryState === 'rejected',
      );
      assert.equal((await client.detach('terminal:managed')).status, 'detached');
      assert.equal((await client.reconnect('terminal:managed')).status, 'running');
      assert.equal((await client.stop('terminal:managed')).status, 'stopped');
      assert.deepStrictEqual(manager.calls, [
        ['command', 'terminal:managed', '한 번만 보내기', { deliveryId: 'delivery:host:1' }],
        ['command', 'terminal:managed', '보내기 전 거절', { deliveryId: 'delivery:host:rejected' }],
        ['detach', 'terminal:managed'],
        ['reconnect', 'terminal:managed'],
        ['stop', 'terminal:managed'],
      ]);
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test('macOS 패키지는 터미널 호스트를 숨김 Helper 실행 파일로 연다', () => {
    const executable = '/Applications/LoadToAgent.app/Contents/MacOS/LoadToAgent';
    const helper = '/Applications/LoadToAgent.app/Contents/Frameworks/LoadToAgent Helper.app/Contents/MacOS/LoadToAgent Helper';
    const fileSystem = { existsSync: file => file === helper };
    assert.equal(resolveTerminalHostExecutable({ platform: 'darwin', isPackaged: true, executable, fileSystem }), helper);
    assert.equal(resolveTerminalHostExecutable({ platform: 'darwin', isPackaged: false, executable, fileSystem }), executable);
    assert.equal(resolveTerminalHostExecutable({ platform: 'win32', isPackaged: true, executable, fileSystem }), executable);
  });

  test('PTY 터미널을 만들고 입력·명령·리사이즈·신호·재시작·종료를 제어한다', () => {
    const processes = [];
    const spawnOptions = [];
    const storeFile = path.join(temp, 'terminal-sessions-lifecycle.json');
    class FakePty {
      constructor(pid) { this.pid = pid; this.writes = []; this.resizes = []; this.killed = false; }
      onData(callback) { this.dataCallback = callback; }
      onExit(callback) { this.exitCallback = callback; }
      write(value) { this.writes.push(value); }
      resize(cols, rows) { this.resizes.push([cols, rows]); }
      clear() { this.cleared = true; }
      kill() { this.killed = true; }
    }
    const managerOptions = { platform: 'darwin', storeFile, killTree: handle => handle.kill(), managedTmuxRuntime: {
      exists: () => true,
      stop: () => ({ ok: true }),
    }, ptyModule: { spawn: (...args) => {
      const processHandle = new FakePty(9000 + processes.length);
      processes.push(processHandle);
      spawnOptions.push(args[2]);
      return processHandle;
    } } };
    let manager = new TerminalManager(managerOptions);
    const session = manager.create({ type: 'powershell', cwd: root, cols: 100, rows: 30 });
    assert.equal(session.status, 'running');
    assert.equal(session.background, false);
    assert.equal(session.pid, 9000);
    assert.notEqual(String(spawnOptions[0].env.TERM || '').toLowerCase(), 'dumb');
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
    processes[0].exitCallback({ exitCode: 0, signal: 0 });
    assert.equal(manager.list().length, 1);
    assert.equal(manager.get(session.id).status, 'exited');
    assert.equal(manager.get(session.id).pid, null);
    manager.dispose({ preserveSessions: true });
    manager = new TerminalManager(managerOptions);
    assert.equal(manager.list().length, 1);
    assert.equal(manager.get(session.id).status, 'exited');
    assert.equal(manager.get(session.id).pid, null);
    assert.equal(manager.get(session.id, true).replay, 'PTY_OK');
    const restarted = manager.restart(session.id);
    assert.equal(processes[0].killed, false);
    assert.equal(restarted.pid, 9001);
    assert.equal(restarted.replay, '');
    manager.close(session.id);
    assert.equal(processes[1].killed, true);
    assert.equal(manager.list().length, 0);
    const backgroundAgent = manager.create({ type: 'agent', provider: 'codex', cwd: root });
    assert.equal(backgroundAgent.background, true);
    manager.dispose({ preserveSessions: true });
    assert.equal(processes[2].killed, true);
    manager = new TerminalManager(managerOptions);
    assert.equal(manager.get(backgroundAgent.id).status, 'detached');
    assert.equal(manager.get(backgroundAgent.id).pid, null);
    manager.close(backgroundAgent.id);
    manager = new TerminalManager(managerOptions);
    assert.equal(manager.list().length, 0);
    const transient = manager.create({ type: 'agent', provider: 'codex', cwd: root, transient: true, args: ['exec', 'resume', 'session-transient', 'relay'] });
    assert.equal(transient.transient, true);
    processes[3].exitCallback({ exitCode: 0, signal: 0 });
    assert.equal(manager.get(transient.id), null);
    assert.equal(fs.readFileSync(storeFile, 'utf8').includes(transient.id), false);
    manager.persistNow();
    fs.writeFileSync(storeFile, JSON.stringify({
      version: 2,
      sessions: [{
        id: 'expired-terminal',
        options: { type: 'powershell', cwd: root, sessionBackend: 'direct' },
        status: 'exited',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      }],
    }), 'utf8');
    manager = new TerminalManager({
      ...managerOptions,
      retentionDays: 30,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(manager.get('expired-terminal'), null);
    manager.persistNow();
    assert.equal(fs.readFileSync(storeFile, 'utf8').includes('expired-terminal'), false);
    assert.equal(normalizeLaunchOptions({ type: 'cmd', cwd: root }).type, 'cmd');
    assert.ok(launchSpec(normalizeLaunchOptions({ type: 'powershell', cwd: root })).args.includes('-NoLogo'));
    const macShell = normalizeLaunchOptions({ cwd: root }, 'darwin');
    assert.equal(macShell.type, 'shell');
    const posixFs = {
      constants: { X_OK: 1 },
      statSync(file) { if (file !== '/bin/zsh') throw new Error('missing'); return { isFile: () => true }; },
      accessSync(file) { if (file !== '/bin/zsh') throw new Error('not executable'); },
    };
    assert.equal(resolvePosixShell({ SHELL: '/broken/login-shell' }, 'darwin', posixFs), '/bin/zsh');
    const customShellFs = {
      constants: { X_OK: 1 },
      statSync(file) { return { isFile: () => file === '/opt/homebrew/bin/fish' || file === '/bin/bash' }; },
      accessSync(file) { if (!['/opt/homebrew/bin/fish', '/bin/bash'].includes(file)) throw new Error('not executable'); },
    };
    assert.equal(resolvePosixShell({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin', customShellFs), '/opt/homebrew/bin/fish');
    assert.equal(resolvePosixShell({}, 'linux', customShellFs), '/bin/bash');
    assert.throws(() => resolvePosixShell({ SHELL: '/missing' }, 'linux', {
      constants: { X_OK: 1 }, statSync() { throw new Error('missing'); }, accessSync() { throw new Error('missing'); },
    }), /Linux 명령창을 실행할 프로그램/);
    assert.equal(launchSpec(macShell, 'darwin', undefined, { env: { SHELL: '/broken/login-shell' }, fileSystem: posixFs }).file, '/bin/zsh');
    assert.equal(launchSpec(macShell, 'darwin', undefined, { env: { SHELL: '/broken/login-shell' }, fileSystem: posixFs }).args[0], '-l');
    const macTmux = launchSpec(normalizeLaunchOptions({ type: 'tmux', distro: 'macOS', tmuxSession: 'work' }, 'darwin'), 'darwin', undefined, { env: { SHELL: '/broken/login-shell' }, fileSystem: posixFs });
    assert.notEqual(macTmux.file, 'wsl.exe');
    assert.equal(macTmux.file, '/bin/zsh');
    manager.dispose();
  });

  test('여러 줄 질문은 bracketed paste 한 번과 마지막 Enter 한 번으로 보낸다', () => {
    class FakePty {
      constructor() { this.pid = 9_501; this.writes = []; }
      onData() {}
      onExit() {}
      write(value) { this.writes.push(value); }
      resize() {}
      kill() {}
    }
    const processHandle = new FakePty();
    const manager = new TerminalManager({
      platform: 'darwin',
      killTree: () => {},
      ptyModule: { spawn: () => processHandle },
    });
    const session = manager.create({ type: 'agent', provider: 'claude', cwd: root, sessionBackend: 'direct' });

    manager.command(session.id, '첫째 줄\r\n둘째 줄\n셋째 줄', { deliveryId: 'delivery:multiline:1' });

    assert.deepStrictEqual(processHandle.writes, ['\x1b[200~첫째 줄\n둘째 줄\n셋째 줄\x1b[201~\r']);
    manager.dispose();
  });

  test('같은 AI 대화 전송은 하나의 명령창을 재사용하고 원래 질문을 복구 인자에 남기지 않는다', () => {
    const processes = [];
    class FakePty {
      constructor(pid) { this.pid = pid; this.writes = []; }
      onData() {}
      onExit() {}
      write(value) { this.writes.push(value); }
      resize() {}
      kill() {}
    }
    const storeFile = path.join(temp, 'terminal-agent-send-reuse.json');
    const manager = new TerminalManager({
      platform: 'win32',
      storeFile,
      killTree: () => {},
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(11_000 + processes.length);
          processes.push(handle);
          return handle;
        },
      },
    });
    const shared = {
      type: 'agent',
      provider: 'claude',
      cwd: root,
      bridgeId: 'claude:send-reuse',
      sessionBackend: 'direct',
      reuseBridge: true,
    };
    const first = manager.create({
      ...shared,
      args: ['--resume', 'send-reuse', '--', '첫 질문'],
      recoveryArgs: ['--resume', 'send-reuse'],
      initialCommand: '첫 질문',
      initialCommandInArgs: true,
    });
    const second = manager.create({
      ...shared,
      args: ['--resume', 'send-reuse', '--', '두 번째 질문'],
      recoveryArgs: ['--resume', 'send-reuse'],
      initialCommand: '두 번째 질문',
      initialCommandInArgs: true,
    });

    assert.equal(second.id, first.id);
    assert.equal(second.reused, true);
    assert.equal(second.promptSent, true);
    assert.equal(processes.length, 1);
    assert.deepStrictEqual(processes[0].writes, ['두 번째 질문\r']);
    manager.persistNow();
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8')).sessions;
    assert.deepStrictEqual(stored[0].options.args, ['--resume', 'send-reuse']);
    assert.equal(JSON.stringify(stored).includes('첫 질문'), false);
    assert.equal(JSON.stringify(stored).includes('두 번째 질문'), false);
    manager.dispose();
  });

  test('전달 확인 응답만 유실된 같은 요청은 질문을 다시 쓰지 않는다', () => {
    const processes = [];
    class FakePty {
      constructor(pid) { this.pid = pid; this.writes = []; }
      onData() {}
      onExit() {}
      write(value) { this.writes.push(value); }
      resize() {}
      kill() {}
    }
    const manager = new TerminalManager({
      platform: 'win32',
      storeFile: path.join(temp, 'terminal-delivery-dedup.json'),
      killTree: () => {},
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(11_100 + processes.length);
          processes.push(handle);
          return handle;
        },
      },
    });
    const request = {
      type: 'agent',
      provider: 'claude',
      cwd: root,
      bridgeId: 'claude:delivery-dedup',
      sessionBackend: 'direct',
      reuseBridge: true,
      args: ['--resume', 'delivery-dedup', '--', '한 번만 보낼 질문'],
      recoveryArgs: ['--resume', 'delivery-dedup'],
      initialCommand: '한 번만 보낼 질문',
      initialCommandInArgs: true,
      deliveryId: 'delivery:dedup:1',
    };

    const first = manager.create(request);
    const retry = manager.create(request);

    assert.equal(retry.id, first.id);
    assert.equal(retry.reused, true);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.deliveryState, 'accepted');
    assert.equal(processes.length, 1);
    assert.deepStrictEqual(processes[0].writes, []);
    assert.throws(() => manager.create({
      ...request,
      args: ['--resume', 'delivery-dedup', '--', '같은 ID의 다른 질문'],
      initialCommand: '같은 ID의 다른 질문',
    }), /다른 내용/);
    manager.persistNow();
    const afterHostRestartProcesses = [];
    const afterHostRestart = new TerminalManager({
      platform: 'win32',
      storeFile: path.join(temp, 'terminal-delivery-dedup.json'),
      killTree: () => {},
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(11_200 + afterHostRestartProcesses.length);
          afterHostRestartProcesses.push(handle);
          return handle;
        },
      },
    });
    const retryAfterRestart = afterHostRestart.create(request);
    assert.equal(retryAfterRestart.id, first.id);
    assert.equal(retryAfterRestart.duplicate, true);
    assert.equal(retryAfterRestart.deliveryState, 'accepted');
    assert.equal(afterHostRestartProcesses.length, 0);
    afterHostRestart.dispose({ preserveSessions: true });
    manager.dispose({ preserveSessions: true });

    const stored = JSON.parse(fs.readFileSync(path.join(temp, 'terminal-delivery-dedup.json'), 'utf8'));
    stored.sessions[0].deliveries[0].state = 'prepared';
    fs.writeFileSync(path.join(temp, 'terminal-delivery-dedup.json'), JSON.stringify(stored), 'utf8');
    const rendererRestartProcesses = [];
    const rendererRestart = new TerminalManager({
      platform: 'win32',
      storeFile: path.join(temp, 'terminal-delivery-dedup.json'),
      killTree: () => {},
      ptyModule: {
        spawn: () => {
          rendererRestartProcesses.push(true);
          return new FakePty(11_300);
        },
      },
    });
    const retryWithNewId = rendererRestart.create({ ...request, deliveryId: 'delivery:dedup:renderer-restart' });
    assert.equal(retryWithNewId.duplicate, true);
    assert.equal(retryWithNewId.deliveryState, 'unknown');
    assert.deepStrictEqual(rendererRestartProcesses, []);
    rendererRestart.dispose();
  });

  test('전달 장부를 저장하지 못하면 PTY에 질문을 쓰기 전에 안전하게 중단한다', () => {
    const failingFileSystem = Object.create(fs);
    failingFileSystem.writeFileSync = () => { throw new Error('simulated disk failure'); };
    failingFileSystem.unlinkSync = () => {};
    let spawns = 0;
    const manager = new TerminalManager({
      platform: 'win32',
      storeFile: path.join(temp, 'terminal-delivery-store-blocked.json'),
      fileSystem: failingFileSystem,
      killTree: () => {},
      onPersistenceError: () => {},
      ptyModule: {
        spawn: () => {
          spawns += 1;
          throw new Error('전달 장부 저장 전에 PTY를 시작하면 안 됩니다.');
        },
      },
    });

    assert.throws(() => manager.create({
      type: 'agent',
      provider: 'claude',
      cwd: root,
      bridgeId: 'claude:persistence-blocked',
      sessionBackend: 'direct',
      args: ['--resume', 'persistence-blocked', '--', '보내면 안 되는 질문'],
      recoveryArgs: ['--resume', 'persistence-blocked'],
      initialCommand: '보내면 안 되는 질문',
      initialCommandInArgs: true,
      deliveryId: 'delivery:persistence:blocked',
    }), /전달 장부/);
    assert.equal(spawns, 0);
    manager.dispose();

    const spawnStoreFile = path.join(temp, 'terminal-delivery-spawn-rejected.json');
    let spawnAttempts = 0;
    class RetryablePty {
      constructor() { this.pid = 11_500; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const spawnManager = new TerminalManager({
      platform: 'win32',
      storeFile: spawnStoreFile,
      killTree: () => {},
      ptyModule: {
        spawn: () => {
          spawnAttempts += 1;
          if (spawnAttempts === 1) throw new Error('provider executable missing');
          return new RetryablePty();
        },
      },
    });
    const spawnRequest = {
      type: 'agent', provider: 'gemini', cwd: root,
      bridgeId: 'gemini:spawn-rejected', sessionBackend: 'direct', reuseBridge: true,
      args: ['--resume', 'spawn-rejected', '--', '실행 전에 거절될 질문'],
      recoveryArgs: ['--resume', 'spawn-rejected'],
      initialCommand: '실행 전에 거절될 질문', initialCommandInArgs: true,
      deliveryId: 'delivery:spawn:rejected',
    };
    assert.throws(
      () => spawnManager.create(spawnRequest),
      error => error.deliveryState === 'rejected' && /provider executable missing/.test(error.message),
    );
    const retriedSpawn = spawnManager.create(spawnRequest);
    assert.equal(retriedSpawn.deliveryState, 'accepted');
    assert.equal(Boolean(retriedSpawn.duplicate), false);
    assert.equal(spawnAttempts, 2);
    spawnManager.dispose();
  });

  test('호스트 재시작 시 같은 AI 대화의 중복 연결은 하나만 복구하고 과거 질문을 다시 보내지 않는다', () => {
    const storeFile = path.join(temp, 'terminal-agent-duplicate-recovery.json');
    const oldAt = '2026-07-30T01:00:00.000Z';
    const newAt = '2026-07-30T02:00:00.000Z';
    fs.writeFileSync(storeFile, JSON.stringify({
      version: 2,
      sessions: [
        {
          id: 'terminal:duplicate-old',
          options: {
            type: 'agent',
            provider: 'codex',
            cwd: root,
            args: ['resume', 'duplicate-session', '이미 처리한 옛 질문'],
            bridgeId: 'codex:duplicate-session',
            sessionBackend: 'direct',
          },
          status: 'running',
          createdAt: oldAt,
          updatedAt: oldAt,
          replay: '',
        },
        {
          id: 'terminal:duplicate-new',
          options: {
            type: 'agent',
            provider: 'codex',
            cwd: root,
            args: ['resume', '--', 'duplicate-session', '가장 최근 질문'],
            bridgeId: 'codex:duplicate-session',
            sessionBackend: 'direct',
          },
          status: 'running',
          createdAt: newAt,
          updatedAt: newAt,
          replay: '',
        },
      ],
    }), 'utf8');
    const spawned = [];
    class FakePty {
      constructor() { this.pid = 12_001; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const manager = new TerminalManager({
      platform: 'win32',
      storeFile,
      killTree: () => {},
      ptyModule: {
        spawn: (file, args) => {
          spawned.push({ file, args });
          return new FakePty();
        },
      },
    });

    assert.equal(manager.list().length, 1);
    assert.equal(manager.list()[0].id, 'terminal:duplicate-new');
    const recovered = manager.recoverPersistedSessions();
    assert.equal(recovered.length, 1);
    assert.equal(spawned.length, 1);
    assert.deepStrictEqual(spawned[0].args.slice(-3), ['resume', '--', 'duplicate-session']);
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8')).sessions;
    assert.equal(stored.length, 1);
    assert.deepStrictEqual(stored[0].options.args, ['resume', '--', 'duplicate-session']);
    assert.equal(JSON.stringify(stored).includes('이미 처리한 옛 질문'), false);
    assert.equal(JSON.stringify(stored).includes('가장 최근 질문'), false);
    manager.dispose();
  });

  test('명령창 최대치에서는 끝난 기록을 자동 정리해 새 AI 전송 연결을 만든다', () => {
    const processes = [];
    class FakePty {
      constructor(pid) { this.pid = pid; }
      onData() {}
      onExit(callback) { this.exitCallback = callback; }
      write() {}
      resize() {}
      kill() {}
    }
    const manager = new TerminalManager({
      platform: 'win32',
      killTree: () => {},
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(13_000 + processes.length);
          processes.push(handle);
          return handle;
        },
      },
    });
    const sessions = Array.from({ length: 24 }, (_, index) => manager.create({
      type: 'powershell',
      cwd: root,
      title: `용량 검증 ${index + 1}`,
    }));
    processes[0].exitCallback({ exitCode: 0, signal: 0 });
    const replacement = manager.create({
      type: 'agent',
      provider: 'codex',
      cwd: root,
      args: ['resume', 'capacity-session'],
      bridgeId: 'codex:capacity-session',
      sessionBackend: 'direct',
    });

    assert.equal(manager.list().length, 24);
    assert.equal(manager.get(sessions[0].id), null);
    assert.equal(manager.get(replacement.id).status, 'running');
    manager.dispose();
  });

  test('앱 클라이언트가 종료되어도 터미널 호스트의 PTY와 세션 ID를 유지하고 다시 연결한다', async () => {
    const processes = [];
    class FakePty {
      constructor(pid) { this.pid = pid; this.writes = []; this.killed = false; }
      onData(callback) { this.dataCallback = callback; }
      onExit(callback) { this.exitCallback = callback; }
      write(value) { this.writes.push(value); }
      resize() {}
      kill() { this.killed = true; }
    }
    const manager = new TerminalManager({
      storeFile: path.join(temp, 'terminal-host-sessions.json'),
      killTree: handle => handle.kill(),
      ptyModule: { spawn: () => {
        const handle = new FakePty(12_000 + processes.length);
        processes.push(handle);
        return handle;
      } },
    });
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-test-${process.pid}-${Date.now()}`
      : path.join(os.tmpdir(), `lta-host-${process.pid}-${Date.now()}.sock`);
    const discovery = path.join(temp, 'terminal-host-discovery.json');
    const server = new TerminalHostServer({ manager, endpoint, discoveryFile: discovery, token: 'host-test-token' });
    await server.start();
    const spawnHost = () => { throw new Error('실행 중인 테스트 호스트를 다시 시작하면 안 됩니다.'); };
    const firstClient = new TerminalHostClient({ discoveryFile: discovery, spawnHost });
    await firstClient.connect();
    const created = await firstClient.create({ type: 'powershell', cwd: root, title: '재시작 유지 검증' });
    processes[0].dataCallback('BEFORE_RESTART');
    assert.equal(created.status, 'running');
    assert.equal(firstClient.list()[0].id, created.id);
    firstClient.dispose();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(processes[0].killed, false);
    assert.equal(manager.get(created.id).status, 'running');

    const secondClient = new TerminalHostClient({ discoveryFile: discovery, spawnHost });
    await secondClient.connect();
    assert.equal(secondClient.list()[0].id, created.id);
    assert.equal(secondClient.list()[0].status, 'running');
    assert.match((await secondClient.get(created.id, true)).replay, /BEFORE_RESTART/);
    await secondClient.command(created.id, 'Write-Output AFTER_RESTART');
    assert.equal(processes[0].writes.at(-1), 'Write-Output AFTER_RESTART\r');
    await secondClient.close(created.id);
    assert.equal(processes[0].killed, true);
    secondClient.dispose();
    server.dispose();
    manager.dispose();
  });

  test('PTY 런타임이 바뀌면 이전 터미널 호스트를 종료한 뒤 새 런타임으로 교체한다', async () => {
    class EmptyManager extends EventEmitter {
      list() { return []; }
      on() { return super.on(...arguments); }
      removeListener() { return super.removeListener(...arguments); }
    }
    const manager = new EmptyManager();
    const discovery = path.join(temp, 'terminal-host-runtime-upgrade.json');
    const endpoint = suffix => process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-runtime-${process.pid}-${suffix}`
      : path.join(os.tmpdir(), `lta-host-runtime-${process.pid}-${suffix}.sock`);
    const oldServer = new TerminalHostServer({
      manager,
      endpoint: endpoint('old'),
      discoveryFile: discovery,
      token: 'old-runtime-token',
      runtime: 'node-pty-1.1.0',
    });
    await oldServer.start();
    let replacementServer = null;
    let retiredRuntime = '';
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      expectedRuntime: 'node-pty-1.2.0-beta.14',
      connectTimeoutMs: 2_000,
      terminateHost: async info => {
        retiredRuntime = info.runtime;
        oldServer.dispose();
      },
      spawnHost: async () => {
        replacementServer = new TerminalHostServer({
          manager,
          endpoint: endpoint('new'),
          discoveryFile: discovery,
          token: 'new-runtime-token',
          runtime: 'node-pty-1.2.0-beta.14',
        });
        await replacementServer.start();
      },
    });
    await client.connect();

    assert.equal(retiredRuntime, 'node-pty-1.1.0');
    assert.equal(client.connected, true);
    assert.equal(JSON.parse(fs.readFileSync(discovery, 'utf8')).runtime, 'node-pty-1.2.0-beta.14');
    client.dispose();
    replacementServer?.dispose();
  });

  test('stale 구버전 호스트 정보의 재사용된 PID는 인증 없이 종료하지 않는다', async () => {
    class EmptyManager extends EventEmitter {
      list() { return []; }
      on() { return super.on(...arguments); }
      removeListener() { return super.removeListener(...arguments); }
    }
    const manager = new EmptyManager();
    const discovery = path.join(temp, 'terminal-host-stale-runtime.json');
    const replacementEndpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-stale-${process.pid}`
      : path.join(os.tmpdir(), `lta-host-stale-${process.pid}.sock`);
    fs.writeFileSync(discovery, JSON.stringify({
      protocol: 1,
      endpoint: process.platform === 'win32'
        ? `\\\\.\\pipe\\loadtoagent-missing-${process.pid}`
        : path.join(os.tmpdir(), `lta-host-missing-${process.pid}.sock`),
      token: 'stale-token',
      pid: process.pid,
    }), 'utf8');
    let terminated = false;
    let replacementServer = null;
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      connectTimeoutMs: 2_000,
      terminateHost: () => { terminated = true; },
      spawnHost: async () => {
        replacementServer = new TerminalHostServer({
          manager,
          endpoint: replacementEndpoint,
          discoveryFile: discovery,
          token: 'replacement-token',
        });
        await replacementServer.start();
      },
    });
    await client.connect();

    assert.equal(terminated, false);
    assert.equal(client.connected, true);
    client.dispose();
    replacementServer?.dispose();
  });

  test('터미널 호스트가 죽어도 저장된 실행 세션을 같은 ID와 설정으로 다시 시작한다', () => {
    const processes = [];
    class FakePty {
      constructor(pid) { this.pid = pid; }
      onData(callback) { this.dataCallback = callback; }
      onExit(callback) { this.exitCallback = callback; }
      write() {}
      resize() {}
      kill() {}
    }
    const storeFile = path.join(temp, 'terminal-host-crash-recovery.json');
    const options = {
      storeFile,
      killTree: () => {},
      ptyModule: { spawn: () => {
        const processHandle = new FakePty(15_000 + processes.length);
        processes.push(processHandle);
        return processHandle;
      } },
    };
    const beforeCrash = new TerminalManager(options);
    const created = beforeCrash.create({ type: 'agent', provider: 'codex', args: ['resume', 'session-123'], cwd: root, bridgeId: 'codex:session-123', sessionBackend: 'direct' });
    const freshAgent = beforeCrash.create({ type: 'agent', provider: 'codex', args: [], cwd: root, bridgeId: 'external-bridge', sessionBackend: 'direct' });
    const stalledAgent = beforeCrash.create({ type: 'agent', provider: 'codex', args: ['resume', 'session-stalled'], cwd: root, bridgeId: 'codex:session-stalled', sessionBackend: 'direct' });
    processes[2].dataCallback('WARNING: TERM is set to "dumb". Codex interactive mode may not work.\r\nContinue anyway? [y/N]:');
    beforeCrash.persistNow();

    const afterCrash = new TerminalManager(options);
    assert.equal(afterCrash.get(created.id).status, 'exited');
    const recovered = afterCrash.recoverPersistedSessions();

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, created.id);
    assert.equal(recovered[0].status, 'running');
    assert.equal(recovered[0].pid, 15_003);
    assert.equal(recovered[0].bridgeId, 'codex:session-123');
    assert.match(afterCrash.get(created.id, true).replay, /연결이 끊긴 뒤 새 프로그램으로 복구/);
    assert.equal(afterCrash.get(freshAgent.id).status, 'exited');
    assert.match(afterCrash.get(freshAgent.id, true).replay, /새 대화를 만들 수 있어 자동으로 이어가지는 않았습니다/);
    assert.equal(afterCrash.get(stalledAgent.id), null);
    afterCrash.dispose();
  });

  test('세션 ID가 없는 재개 인자와 과거 질문이 붙은 Grok 인자는 안전하게 복구한다', () => {
    const storeFile = path.join(temp, 'terminal-safe-resume-arguments.json');
    const now = '2026-08-01T00:00:00.000Z';
    fs.writeFileSync(storeFile, JSON.stringify({
      version: 2,
      sessions: [
        {
          id: 'terminal:bad-codex',
          options: { type: 'agent', provider: 'codex', cwd: root, args: ['resume', '--'], sessionBackend: 'direct' },
          status: 'running', createdAt: now, updatedAt: now, replay: '',
        },
        {
          id: 'terminal:bad-claude',
          options: { type: 'agent', provider: 'claude', cwd: root, args: ['--resume', '--'], sessionBackend: 'direct' },
          status: 'running', createdAt: now, updatedAt: now, replay: '',
        },
        {
          id: 'terminal:safe-grok',
          options: {
            type: 'agent', provider: 'grok', cwd: root,
            args: ['--resume', 'grok-session-7', '--', '절대 다시 보내면 안 되는 과거 질문'],
            sessionBackend: 'direct',
          },
          status: 'running', createdAt: now, updatedAt: now, replay: '',
        },
        {
          id: 'terminal:safe-gemini',
          options: {
            type: 'agent', provider: 'gemini', cwd: root,
            args: ['절대 다시 보내면 안 되는 앞쪽 질문', '--resume', 'gemini-session-8', '--', '뒤쪽 질문'],
            sessionBackend: 'direct',
          },
          status: 'running', createdAt: now, updatedAt: now, replay: '',
        },
        {
          id: 'terminal:safe-claude',
          options: {
            type: 'agent', provider: 'claude', cwd: root,
            args: ['Claude의 앞쪽 옛 질문', '--resume', 'claude-session-9', '--', 'Claude의 뒤쪽 옛 질문'],
            sessionBackend: 'direct',
          },
          status: 'running', createdAt: now, updatedAt: now, replay: '',
        },
      ],
    }), 'utf8');
    const spawns = [];
    class FakePty {
      constructor() { this.pid = 15_700 + spawns.length; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile,
      killTree: () => {},
      ptyModule: {
        spawn: (file, args) => {
          spawns.push({ file, args });
          return new FakePty();
        },
      },
    });

    const recovered = manager.recoverPersistedSessions();

    assert.equal(recovered.length, 3);
    assert.equal(recovered[0].id, 'terminal:safe-grok');
    assert.equal(manager.get('terminal:bad-codex').recoverySkippedReason, 'unsafe-agent-restart');
    assert.equal(manager.get('terminal:bad-claude').recoverySkippedReason, 'unsafe-agent-restart');
    assert.deepStrictEqual(spawns[0].args, ['--resume', 'grok-session-7']);
    assert.deepStrictEqual(spawns[1].args, ['--resume', 'gemini-session-8']);
    assert.deepStrictEqual(spawns[2].args, ['--resume', 'claude-session-9']);
    assert.equal(JSON.stringify(spawns).includes('과거 질문'), false);
    assert.equal(JSON.stringify(spawns).includes('앞쪽 질문'), false);

    const created = manager.create({
      type: 'agent',
      provider: 'gemini',
      cwd: root,
      bridgeId: 'gemini:canonical-recovery',
      sessionBackend: 'direct',
      args: ['--resume', 'canonical-recovery', '--', '새 질문'],
      recoveryArgs: ['저장된 옛 질문', '--resume', 'canonical-recovery', '--', '다른 옛 질문'],
    });
    const storedCreated = JSON.parse(fs.readFileSync(storeFile, 'utf8')).sessions
      .find(session => session.id === created.id);
    assert.deepStrictEqual(storedCreated.options.args, ['--resume', 'canonical-recovery']);
    manager.dispose();
  });

  test('자연 종료 상태는 즉시 저장해 직후 호스트가 죽어도 끝난 셸을 되살리지 않는다', () => {
    const processes = [];
    class FakePty {
      constructor(pid) { this.pid = pid; }
      onData(callback) { this.dataCallback = callback; }
      onExit(callback) { this.exitCallback = callback; }
      write() {}
      resize() {}
      kill() {}
    }
    const storeFile = path.join(temp, 'terminal-host-natural-exit.json');
    const options = {
      storeFile,
      killTree: () => {},
      ptyModule: { spawn: () => {
        const processHandle = new FakePty(16_000 + processes.length);
        processes.push(processHandle);
        return processHandle;
      } },
    };
    const manager = new TerminalManager(options);
    const session = manager.create({ type: 'powershell', cwd: root });
    processes[0].exitCallback({ exitCode: 0, signal: 0 });

    const afterHostCrash = new TerminalManager(options);
    assert.equal(afterHostCrash.get(session.id).status, 'exited');
    assert.deepStrictEqual(afterHostCrash.recoverPersistedSessions(), []);
    afterHostCrash.dispose();
    manager.dispose();
  });

  test('터미널 호스트 단절 뒤 다음 요청이 새 호스트에 자동 재연결된다', async () => {
    class FakePty {
      constructor(pid) { this.pid = pid; this.killed = false; }
      onData(callback) { this.dataCallback = callback; }
      onExit(callback) { this.exitCallback = callback; }
      write() {}
      resize() {}
      kill() { this.killed = true; }
    }
    let nextPid = 14_000;
    const manager = new TerminalManager({
      storeFile: path.join(temp, 'terminal-host-reconnect-sessions.json'),
      killTree: handle => handle.kill(),
      ptyModule: { spawn: () => new FakePty(nextPid++) },
    });
    const discovery = path.join(temp, 'terminal-host-reconnect-discovery.json');
    const endpoint = suffix => process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-reconnect-${process.pid}-${suffix}`
      : path.join(os.tmpdir(), `lta-host-reconnect-${process.pid}-${suffix}.sock`);
    const firstServer = new TerminalHostServer({ manager, endpoint: endpoint('first'), discoveryFile: discovery, token: 'first-token' });
    await firstServer.start();
    let replacementServer = null;
    let spawnCalls = 0;
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      connectTimeoutMs: 2_000,
      spawnHost: async () => {
        spawnCalls += 1;
        replacementServer = new TerminalHostServer({ manager, endpoint: endpoint('second'), discoveryFile: discovery, token: 'second-token' });
        await replacementServer.start();
      },
    });
    await client.connect();
    firstServer.dispose();
    await new Promise(resolve => setTimeout(resolve, 30));

    const created = await client.create({ type: 'powershell', cwd: root, title: '자동 재연결 검증' });
    assert.equal(spawnCalls, 1);
    assert.equal(created.status, 'running');
    assert.equal(client.list()[0].id, created.id);

    await client.close(created.id);
    client.dispose();
    replacementServer?.dispose();
    manager.dispose();
  });

  test('이전 소켓의 늦은 close 이벤트가 새 터미널 호스트 연결을 끊지 않는다', () => {
    const client = new TerminalHostClient({ discoveryFile: path.join(temp, 'unused-host.json') });
    const staleSocket = { destroyed: true };
    const activeSocket = { destroyed: false };
    client.socket = activeSocket;
    client.connected = true;
    client.sessions = [{ id: 'terminal:active', status: 'running' }];
    let activeHandshakeRejected = false;
    client.handshake = { reject: () => { activeHandshakeRejected = true; } };

    client.handleSocketError(staleSocket, new Error('stale socket error'));
    client.consume(Buffer.from('{"type":"ready"'), staleSocket);
    client.handleDisconnect(staleSocket);

    assert.equal(client.socket, activeSocket);
    assert.equal(client.connected, true);
    assert.equal(activeHandshakeRejected, false);
    assert.equal(client.buffer, '');
    assert.equal(client.list()[0].id, 'terminal:active');
  });

  test('마지막 클라이언트가 떠난 빈 터미널 호스트는 유예 뒤 스스로 종료한다', async () => {
    class EmptyManager extends EventEmitter {
      list() { return []; }
      on() { return super.on(...arguments); }
      removeListener() { return super.removeListener(...arguments); }
    }
    const manager = new EmptyManager();
    const discovery = path.join(temp, 'terminal-host-idle-discovery.json');
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-idle-${process.pid}`
      : path.join(os.tmpdir(), `lta-host-idle-${process.pid}.sock`);
    let shutdowns = 0;
    const server = new TerminalHostServer({
      manager,
      endpoint,
      discoveryFile: discovery,
      token: 'idle-token',
      idleShutdownMs: 20,
      onShutdown: () => { shutdowns += 1; },
    });
    await server.start();
    const client = new TerminalHostClient({ discoveryFile: discovery });
    await client.connect();
    client.dispose();
    await waitUntil(() => shutdowns === 1);

    assert.equal(shutdowns, 1);
    server.dispose();
  });

  test('클라이언트가 붙기 전에 앱이 끝나도 빈 터미널 호스트는 고아 프로세스로 남지 않는다', async () => {
    class EmptyManager extends EventEmitter {
      list() { return []; }
      on() { return super.on(...arguments); }
      removeListener() { return super.removeListener(...arguments); }
    }
    const suffix = `${process.pid}-${Date.now()}`;
    const discovery = path.join(temp, `terminal-host-orphan-${suffix}.json`);
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-orphan-${suffix}`
      : path.join(os.tmpdir(), `lta-host-orphan-${suffix}.sock`);
    let shutdowns = 0;
    const server = new TerminalHostServer({
      manager: new EmptyManager(),
      endpoint,
      discoveryFile: discovery,
      token: 'orphan-token',
      idleShutdownMs: 20,
      onShutdown: () => { shutdowns += 1; },
    });
    await server.start();
    await waitUntil(() => shutdowns === 1);

    assert.equal(shutdowns, 1);
    server.dispose();
  });

}

function registerTerminalFailureTests(context) {
  const { test, temp, root } = context;

  test('손상된 cwd 레코드만 격리하고 나머지 터미널을 복구한다', () => {
    const storeDir = path.join(temp, 'terminal-store-invalid-record');
    const storeFile = path.join(storeDir, 'terminal-sessions.json');
    const timestamp = '2026-08-01T00:00:00.000Z';
    const original = JSON.stringify({
      version: 2,
      sessions: [
        {
          id: 'terminal:valid-before',
          options: { type: 'shell', cwd: root, sessionBackend: 'direct' },
          status: 'running', createdAt: timestamp, updatedAt: timestamp, replay: 'before',
        },
        {
          id: 'terminal:missing-cwd',
          options: { type: 'shell', cwd: path.join(storeDir, 'missing'), sessionBackend: 'direct' },
          status: 'running', createdAt: timestamp, updatedAt: timestamp, replay: 'missing',
        },
        {
          id: 'terminal:valid-after',
          options: { type: 'shell', cwd: root, sessionBackend: 'direct' },
          status: 'running', createdAt: timestamp, updatedAt: timestamp, replay: 'after',
        },
      ],
    });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(storeFile, original, 'utf8');
    const spawns = [];
    const persistenceErrors = [];
    class FakePty {
      constructor(pid) { this.pid = pid; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const manager = new TerminalManager({
      platform: 'darwin',
      storeFile,
      killTree: () => {},
      onPersistenceError: (operation, error) => persistenceErrors.push([operation, error.message]),
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(17_000 + spawns.length);
          spawns.push(handle);
          return handle;
        },
      },
    });

    assert.deepStrictEqual(manager.list().map(session => session.id), [
      'terminal:valid-before',
      'terminal:valid-after',
    ]);
    const recovered = manager.recoverPersistedSessions();
    assert.deepStrictEqual(recovered.map(session => session.id), [
      'terminal:valid-before',
      'terminal:valid-after',
    ]);
    assert.equal(spawns.length, 2);
    const active = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    assert.deepStrictEqual(active.sessions.map(session => session.id), [
      'terminal:valid-before',
      'terminal:valid-after',
    ]);
    const quarantine = fs.readdirSync(storeDir)
      .find(name => name.startsWith('terminal-sessions.json.unreadable-'));
    assert.ok(quarantine);
    assert.equal(fs.readFileSync(path.join(storeDir, quarantine), 'utf8'), original);
    assert.equal(persistenceErrors.filter(([operation]) => operation === 'load-record').length, 1);
    manager.dispose({ preserveSessions: true });
  });

  test('읽을 수 없는 터미널 저장소는 격리 실패 시 덮어쓰지 않는다', () => {
    const successfulDir = path.join(temp, 'terminal-store-envelope-quarantine');
    const successfulStore = path.join(successfulDir, 'terminal-sessions.json');
    const malformed = '{not-json';
    fs.mkdirSync(successfulDir, { recursive: true });
    fs.writeFileSync(successfulStore, malformed, 'utf8');
    const successfulErrors = [];
    const recoveredManager = new TerminalManager({
      storeFile: successfulStore,
      onPersistenceError: (operation, error) => successfulErrors.push([operation, error.message]),
    });

    assert.deepStrictEqual(recoveredManager.recoverPersistedSessions(), []);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(successfulStore, 'utf8')), {
      version: 2,
      sessions: [],
    });
    const quarantine = fs.readdirSync(successfulDir)
      .find(name => name.startsWith('terminal-sessions.json.unreadable-'));
    assert.ok(quarantine);
    assert.equal(fs.readFileSync(path.join(successfulDir, quarantine), 'utf8'), malformed);
    assert.equal(successfulErrors.some(([operation]) => operation === 'load'), true);

    const blockedDir = path.join(temp, 'terminal-store-quarantine-blocked');
    const blockedStore = path.join(blockedDir, 'terminal-sessions.json');
    fs.mkdirSync(blockedDir, { recursive: true });
    fs.writeFileSync(blockedStore, malformed, 'utf8');
    const blockedFileSystem = Object.create(fs);
    const blockedErrors = [];
    let writes = 0;
    blockedFileSystem.renameSync = (source, destination) => {
      if (source === blockedStore && destination.startsWith(`${blockedStore}.unreadable-`)) {
        const error = new Error('simulated quarantine failure');
        error.code = 'EACCES';
        throw error;
      }
      return fs.renameSync(source, destination);
    };
    blockedFileSystem.writeFileSync = (...args) => {
      writes += 1;
      return fs.writeFileSync(...args);
    };
    const blockedManager = new TerminalManager({
      storeFile: blockedStore,
      fileSystem: blockedFileSystem,
      onPersistenceError: (operation, error) => blockedErrors.push([operation, error.message]),
    });

    assert.deepStrictEqual(blockedManager.recoverPersistedSessions(), []);
    assert.equal(blockedManager.persistNow(), false);
    assert.equal(writes, 0);
    assert.equal(fs.readFileSync(blockedStore, 'utf8'), malformed);
    assert.deepStrictEqual(blockedErrors.map(([operation]) => operation), ['load', 'quarantine']);
  });

  test('터미널 저장소는 JSON UTF-8 예산 안에서 replay 꼬리를 surrogate-safe하게 저장한다', () => {
    const storeDir = path.join(temp, 'terminal-store-byte-budget');
    const storeFile = path.join(storeDir, 'terminal-sessions.json');
    const processes = [];
    class FakePty {
      constructor(pid) { this.pid = pid; }
      onData(callback) { this.dataCallback = callback; }
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const managerOptions = maxStoreBytes => ({
      platform: 'darwin',
      storeFile,
      maxStoreBytes,
      killTree: () => {},
      onPersistenceError: () => {},
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(18_000 + processes.length);
          processes.push(handle);
          return handle;
        },
      },
    });
    const hasUnpairedSurrogate = value => {
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = value.charCodeAt(index + 1);
          if (next < 0xdc00 || next > 0xdfff) return true;
          index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          return true;
        }
      }
      return false;
    };

    const replayCapProcesses = [];
    const replayCapManager = new TerminalManager({
      platform: 'darwin',
      killTree: () => {},
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(17_900 + replayCapProcesses.length);
          replayCapProcesses.push(handle);
          return handle;
        },
      },
    });
    const replayCapSession = replayCapManager.create({ type: 'shell', cwd: root });
    replayCapProcesses[0].dataCallback(`😀${'x'.repeat(2 * 1024 * 1024 - 1)}`);
    const characterCappedReplay = replayCapManager.get(replayCapSession.id, true).replay;
    assert.equal(characterCappedReplay.length, 2 * 1024 * 1024 - 1);
    assert.equal(hasUnpairedSurrogate(characterCappedReplay), false);
    replayCapManager.dispose();

    let manager = new TerminalManager(managerOptions());
    const created = manager.create({ type: 'shell', cwd: root });
    manager.dispose({ preserveSessions: true });
    const emptyBaseBytes = fs.statSync(storeFile).size;

    manager = new TerminalManager(managerOptions(emptyBaseBytes + 3));
    manager.restart(created.id);
    processes.at(-1).dataCallback('x😀');
    assert.equal(manager.get(created.id, true).replay, 'x😀');
    assert.equal(manager.persistNow(), true);
    let stored = JSON.parse(fs.readFileSync(storeFile, 'utf8')).sessions[0];
    assert.equal(stored.replay, '');
    assert.equal(manager.get(created.id, true).replay, 'x😀');
    assert.equal(fs.statSync(storeFile).size <= emptyBaseBytes + 3, true);
    manager.dispose({ preserveSessions: true });

    const replaylessBytes = fs.statSync(storeFile).size;
    manager = new TerminalManager(managerOptions(replaylessBytes + 12));
    manager.restart(created.id);
    const retainedTail = `${String.fromCharCode(92, 27)}😀`;
    const fullReplay = `discarded😀${retainedTail}`;
    processes.at(-1).dataCallback(fullReplay);
    assert.equal(manager.persistNow(), true);
    stored = JSON.parse(fs.readFileSync(storeFile, 'utf8')).sessions[0];
    assert.equal(stored.replay, retainedTail);
    assert.equal(hasUnpairedSurrogate(stored.replay), false);
    assert.equal(manager.get(created.id, true).replay, fullReplay);
    assert.equal(fs.statSync(storeFile).size <= replaylessBytes + 12, true);
    manager.dispose({ preserveSessions: true });

    const sparseStoreFile = path.join(storeDir, 'sparse-terminal-sessions.json');
    const sparseProcesses = [];
    const sparseManager = new TerminalManager({
      platform: 'darwin',
      storeFile: sparseStoreFile,
      maxStoreBytes: 4_096,
      killTree: () => {},
      onPersistenceError: () => {},
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(18_500 + sparseProcesses.length);
          sparseProcesses.push(handle);
          return handle;
        },
      },
    });
    const replayOwner = sparseManager.create({ type: 'shell', cwd: root });
    sparseManager.create({ type: 'shell', cwd: root });
    const sparseAvailableBytes = 4_096 - fs.statSync(sparseStoreFile).size;
    const fittingReplay = 'r'.repeat(Math.floor(sparseAvailableBytes * 0.75));
    sparseProcesses[0].dataCallback(fittingReplay);
    assert.equal(sparseManager.persistNow(), true);
    const sparseStored = JSON.parse(fs.readFileSync(sparseStoreFile, 'utf8')).sessions
      .find(session => session.id === replayOwner.id);
    assert.equal(sparseStored.replay, fittingReplay);
    assert.equal(fs.statSync(sparseStoreFile).size <= 4_096, true);
    sparseManager.dispose({ preserveSessions: true });

    const preserved = fs.readFileSync(storeFile, 'utf8');
    const fixedPayloadBytes = Buffer.byteLength(preserved, 'utf8') - 12;
    const sizeMaskingFileSystem = Object.create(fs);
    let writes = 0;
    sizeMaskingFileSystem.statSync = target => {
      const stat = fs.statSync(target);
      if (target !== storeFile) return stat;
      return {
        ...stat,
        size: 0,
        isFile: () => stat.isFile(),
        isDirectory: () => stat.isDirectory(),
      };
    };
    sizeMaskingFileSystem.writeFileSync = (...args) => {
      writes += 1;
      return fs.writeFileSync(...args);
    };
    const oversizedMetadata = new TerminalManager({
      // Loading a saved running session normalizes its in-memory status to
      // exited, which shortens the fixed payload by one byte.
      ...managerOptions(fixedPayloadBytes - 2),
      fileSystem: sizeMaskingFileSystem,
    });
    assert.equal(oversizedMetadata.get(created.id) != null, true);
    assert.equal(oversizedMetadata.persistNow(), false);
    assert.equal(writes, 0);
    assert.equal(fs.readFileSync(storeFile, 'utf8'), preserved);
  });

  test('손상된 POSIX 실행 시간과 실패한 재스캔은 stale 프로세스로 남지 않는다', () => {
    assert.deepStrictEqual(posixProcessRows('12 1 invalid codex codex --json'), []);
    let fail = false;
    const monitor = new ProcessMonitor({
      platform: 'darwin',
      scanTtlMs: 0,
      execFileSync: () => {
        if (fail) throw new Error('ps failed');
        return '12 1 00:01 codex codex --json\n';
      },
    });
    assert.equal(monitor.scan().available, true);
    fail = true;
    const failed = monitor.scan();
    assert.equal(failed.available, false);
    assert.deepStrictEqual(failed.processes, []);
  });

  test('외부 브리지는 손상된 입력과 알 수 없는 메시지를 거부한다', () => {
    assert.equal(decodeBase64(Buffer.from('안전한 입력').toString('base64')), '안전한 입력');
    assert.throws(() => decodeBase64('%%%'), /글자를 읽을 수 없습니다/);
    const terminalManager = new EventEmitter();
    terminalManager.write = () => { throw new Error('호출되면 안 됨'); };
    const server = new BridgeServer({ terminalManager });
    const client = { authenticated: true, terminalId: 'terminal:1', socket: { end() {} } };
    assert.throws(() => server.handle(client, { type: 'unknown' }), /지원하지 않습니다/);
    assert.throws(() => server.handle(client, { type: 'input', data: '%%%' }), /글자를 읽을 수 없습니다/);
  });

  test('시작 실패한 PTY도 사용자가 닫기 전까지 실패 상태와 replay를 보존한다', () => {
    const storeFile = path.join(temp, 'terminal-sessions-failed.json');
    let manager = new TerminalManager({ storeFile, ptyModule: { spawn: () => { throw new Error('spawn failed'); } } });
    const chunks = [];
    manager.on('data', payload => chunks.push(payload.data));
    assert.throws(() => manager.create({ type: 'powershell', cwd: root }), /spawn failed/);
    assert.equal(manager.list().length, 1);
    assert.equal(manager.list()[0].status, 'failed');
    assert.match(manager.get(manager.list()[0].id, true).replay, /spawn failed/);
    assert.equal(chunks.length, 1);
    assert.equal((chunks[0].match(/spawn failed/g) || []).length, 1);
    const failedId = manager.list()[0].id;
    manager.dispose({ preserveSessions: true });
    manager = new TerminalManager({ storeFile });
    assert.equal(manager.get(failedId).status, 'failed');
    assert.match(manager.get(failedId, true).replay, /spawn failed/);
    manager.close(manager.list()[0].id);
    assert.equal(manager.list().length, 0);
    manager = new TerminalManager({ storeFile });
    assert.equal(manager.list().length, 0);
    manager.dispose();
  });

  test('Windows npm AI 명령은 실행 가능한 PowerShell 호스트로 연다', () => {
    const bin = path.join(temp, 'windows-agent-bin');
    fs.mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, 'codex.ps1');
    fs.writeFileSync(shim, 'Write-Output codex', 'utf8');
    assert.equal(resolveWindowsCommand('codex', { Path: bin }), shim);
    const spec = launchSpec(normalizeLaunchOptions({
      type: 'agent',
      provider: 'codex',
      args: ['resume', 'session-id'],
      cwd: root,
    }, 'win32'), 'win32', { codex: { command: shim, label: 'Codex' } });
    assert.ok(/powershell|pwsh/i.test(spec.file));
    assert.deepStrictEqual(spec.args.slice(-3), [shim, 'resume', 'session-id']);
    const options = normalizeLaunchOptions({
      type: 'agent',
      provider: 'codex',
      args: ['resume', 'wsl-session-id'],
      cwd: '/mnt/c/Users/dev/board-migration-loop',
      distro: 'Ubuntu',
      sessionBackend: 'direct',
    }, 'win32');
    assert.equal(options.cwd, '/mnt/c/Users/dev/board-migration-loop');
    assert.equal(options.distro, 'Ubuntu');
    const wslSpec = launchSpec(options, 'win32', { codex: { command: 'codex', label: 'Codex' } });
    assert.equal(wslSpec.file, 'wsl.exe');
    assert.deepStrictEqual(wslSpec.args, [
      '-d', 'Ubuntu',
      '--cd', '/mnt/c/Users/dev/board-migration-loop',
      '--', 'codex', 'resume', 'wsl-session-id',
    ]);
    assert.equal(wslSpec.cwd, os.homedir());
  });

}

function registerTmuxControlTests(context) {
  const { test, temp } = context;
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
    assert.deepStrictEqual(calls[0].args.slice(-5, -2), ['tmux', 'load-buffer', '-b']);
    const bufferName = calls[0].args.at(-2);
    assert.match(bufferName, /^loadtoagent-/);
    assert.equal(calls[0].args.at(-1), '-');
    assert.equal(calls[0].options.input, command);
    assert.equal(calls[0].options.timeoutMs, 15_000);
    assert.equal(calls.some(call => call.args.includes(command)), false);
    assert.deepStrictEqual(calls[1].args.slice(-9), ['tmux', 'paste-buffer', '-p', '-r', '-b', bufferName, '-d', '-t', '%1']);
    assert.deepStrictEqual(calls[2].args.slice(-5), ['tmux', 'send-keys', '-t', '%1', 'Enter']);
    const split = await controller.splitPane({ distro: 'Ubuntu', target: '%1', direction: 'horizontal', cwd: '/repo' });
    assert.equal(split.paneId, '%99');
    await assert.rejects(() => controller.splitPane({ distro: 'Ubuntu', target: '%1', direction: 'diagonal' }), /명령창 나누기 방향/);
    await controller.newSession({ distro: 'Ubuntu', name: 'safe-name', cwd: '/repo' });
    await controller.selectLayout({ distro: 'Ubuntu', target: '@1', layout: 'tiled' });
    assert.equal(safeName('작업-1'), '작업-1');
    assert.equal(safeTarget('$1:@2.%3'), '$1:@2.%3');
    assert.throws(() => controller.sendKey({ distro: 'Ubuntu', target: '%1', key: 'run-shell' }), /사용할 수 없는 키/);
    assert.throws(() => safeName('bad name;rm'), /이름에는/);
    assert.throws(() => safeTarget('%1;rm'), /명령창 정보의 형식/);
    await controller.execute('Ubuntu', ['list-sessions'], { timeoutMs: 1_234 });
    assert.equal(calls.at(-1).options.timeoutMs, 1_234);
    const macCalls = [];
    const mac = new TmuxController({ platform: 'darwin', run: async (file, args, options = {}) => { macCalls.push({ file, args, options }); return { ok: true, stdout: '' }; } });
    await mac.sendKey({ distro: 'macOS', target: '%1', key: 'Enter' });
    assert.equal(macCalls[0].file, 'tmux');
    assert.deepStrictEqual(macCalls[0].args, ['send-keys', '-t', '%1', 'Enter']);
    assert.equal(macCalls[0].options.timeoutMs, undefined);
  });

  test('tmux에 내용을 붙인 뒤 Enter 확인이 끊기면 재전송하지 않도록 확인 필요를 반환한다', async () => {
    const calls = [];
    const deliveryStoreFile = path.join(temp, 'tmux-delivery-ledger.json');
    const controller = new TmuxController({
      platform: 'darwin',
      deliveryStoreFile,
      run: async (_file, args, options = {}) => {
        calls.push({ args, options });
        if (args.includes('send-keys')) throw new Error('Enter 응답 유실');
        return { ok: true, stdout: '', stderr: '' };
      },
    });

    const result = await controller.sendText({
      distro: 'macOS',
      target: '%1',
      text: '중복되면 안 되는 질문',
      enter: true,
      deliveryId: 'delivery:tmux:1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.deliveryState, 'unknown');
    assert.equal(result.partial, true);
    assert.equal(fs.readFileSync(deliveryStoreFile, 'utf8').includes('중복되면 안 되는 질문'), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(deliveryStoreFile).mode & 0o777, 0o600);
    assert.equal(calls.filter(call => call.args.includes('paste-buffer')).length, 1);
    assert.equal(calls.filter(call => call.args.includes('send-keys')).length, 1);
    const callCount = calls.length;
    const duplicate = await controller.sendText({
      distro: 'macOS',
      target: '%1',
      text: '중복되면 안 되는 질문',
      enter: true,
      deliveryId: 'delivery:tmux:1',
    });
    assert.equal(duplicate.deliveryState, 'unknown');
    assert.equal(duplicate.duplicate, true);
    assert.equal(calls.length, callCount);

    const afterRestartCalls = [];
    const afterRestart = new TmuxController({
      platform: 'darwin',
      deliveryStoreFile,
      run: async (_file, args, options = {}) => {
        afterRestartCalls.push({ args, options });
        return { ok: true, stdout: '', stderr: '' };
      },
    });
    const afterRestartDuplicate = await afterRestart.sendText({
      distro: 'macOS',
      target: '%1',
      text: '중복되면 안 되는 질문',
      enter: true,
      deliveryId: 'delivery:tmux:1',
    });
    assert.equal(afterRestartDuplicate.deliveryState, 'unknown');
    assert.equal(afterRestartDuplicate.duplicate, true);
    assert.deepStrictEqual(afterRestartCalls, []);

    await assert.rejects(() => afterRestart.sendText({
      distro: 'macOS',
      target: '%1',
      text: '같은 ID로 바꿔치기한 질문',
      enter: true,
      deliveryId: 'delivery:tmux:1',
    }), /다른 내용/);

    const failingCalls = [];
    const failingFileSystem = Object.create(fs);
    failingFileSystem.writeFileSync = () => { throw new Error('simulated tmux ledger failure'); };
    failingFileSystem.unlinkSync = () => {};
    const persistenceBlocked = new TmuxController({
      platform: 'darwin',
      deliveryStoreFile: path.join(temp, 'tmux-delivery-blocked.json'),
      fileSystem: failingFileSystem,
      onPersistenceError: () => {},
      run: async (_file, args, options = {}) => {
        failingCalls.push({ args, options });
        return { ok: true, stdout: '', stderr: '' };
      },
    });
    await assert.rejects(() => persistenceBlocked.sendText({
      distro: 'macOS', target: '%2', text: '장부 없이는 보내면 안 됨', enter: true,
      deliveryId: 'delivery:tmux:blocked',
    }), error => error.deliveryState === 'rejected' && error.code === 'TMUX_DELIVERY_LEDGER_UNAVAILABLE');
    assert.equal(failingCalls.filter(call => call.args.includes('load-buffer')).length, 1);
    assert.equal(failingCalls.filter(call => call.args.includes('delete-buffer')).length, 1);
    assert.equal(failingCalls.some(call => call.args.includes('paste-buffer')), false);
    assert.equal(failingCalls.some(call => call.args.includes('send-keys')), false);

    const corruptFile = path.join(temp, 'tmux-delivery-corrupt.json');
    fs.writeFileSync(corruptFile, '{not-json', 'utf8');
    const corruptCalls = [];
    const corruptLedger = new TmuxController({
      platform: 'darwin',
      deliveryStoreFile: corruptFile,
      onPersistenceError: () => {},
      run: async (_file, args) => {
        corruptCalls.push(args);
        return { ok: true, stdout: '', stderr: '' };
      },
    });
    await assert.rejects(() => corruptLedger.sendText({
      distro: 'macOS', target: '%3', text: '손상 장부에서는 보내면 안 됨', enter: true,
      deliveryId: 'delivery:tmux:corrupt',
    }), error => error.deliveryState === 'rejected' && error.code === 'TMUX_DELIVERY_LEDGER_INVALID');
    assert.deepStrictEqual(corruptCalls, []);

    const concurrentCalls = [];
    let releaseFirstLoad;
    const firstLoadGate = new Promise(resolve => { releaseFirstLoad = resolve; });
    const concurrentController = new TmuxController({
      platform: 'darwin',
      run: async (_file, args, options = {}) => {
        concurrentCalls.push({ args, options });
        if (args.includes('load-buffer')) await firstLoadGate;
        return { ok: true, stdout: '', stderr: '' };
      },
    });
    const concurrentOptions = {
      distro: 'macOS', target: '%4', text: '동시에 호출돼도 한 번만 보낼 질문', enter: true,
      deliveryId: 'delivery:tmux:concurrent',
    };
    const concurrentFirst = concurrentController.sendText(concurrentOptions);
    await waitUntil(() => concurrentCalls.some(call => call.args.includes('load-buffer')));
    const concurrentSecond = concurrentController.sendText(concurrentOptions);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(concurrentCalls.filter(call => call.args.includes('load-buffer')).length, 1);
    releaseFirstLoad();
    const concurrentResults = await Promise.all([concurrentFirst, concurrentSecond]);
    assert.equal(concurrentResults[0].deliveryState, 'accepted');
    assert.equal(concurrentResults[1].duplicate, true);
    assert.equal(concurrentCalls.filter(call => call.args.includes('paste-buffer')).length, 1);
    assert.equal(concurrentCalls.filter(call => call.args.includes('send-keys')).length, 1);
  });

  test('제공사별 합계와 활성 세션 수를 계산한다', () => {
    const session = { provider: 'claude', status: 'running', parentId: null, usage: { input: 10, output: 5, total: 15 } };
    const summary = buildSummary([session], { claude: 'claude.exe' });
    assert.equal(summary.totals.active, 1);
    assert.equal(summary.providers.find(item => item.id === 'claude').usage.total, 15);
  });

}

function registerRuntimeTerminalBridgeTests(context) {
  registerTmuxAndProcessTests(context);
  registerNativeProcessTests(context);
  registerBridgeIntegrationTests(context);
  registerGenericAgentTests(context);
  registerTerminalLifecycleTests(context);
  registerTerminalFailureTests(context);
  registerTmuxControlTests(context);
}

module.exports = { registerRuntimeTerminalBridgeTests };
