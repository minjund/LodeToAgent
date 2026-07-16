'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { parseArguments } = require('../../bin/loadtoagent');
const { parseGeneric, buildSummary } = require('../../src/agentMonitor');
const { commandSpec } = require('../../src/agentRunner');
const { BridgeServer, decodeBase64 } = require('../../src/bridgeServer');
const { ProcessMonitor, processRows, posixProcessRows, providerFromPosixProcess, selectAgentProcesses, bridgeLinkScore, applyRuntimePresence } = require('../../src/processMonitor');
const { TerminalManager, normalizeLaunchOptions, launchSpec, resolveWindowsCommand, resolvePosixShell } = require('../../src/terminalManager');
const { TmuxController, safeName, safeTarget } = require('../../src/tmuxController');
const { TmuxMonitor, normalizeWslList, parseTmuxProbe, buildDistroTopology, linkAgentSessions, providerFromProcess } = require('../../src/tmuxMonitor');

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
    socket.destroy();
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
    fs.writeFileSync(file, JSON.stringify({ id: 'gem-1', model: 'gemini-3.5-flash', cwd: 'D:\\repo', messages: [{ id: 'u', role: 'user', content: '문서를 요약해줘' }, { id: 'a', role: 'model', content: '요약입니다.', usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, totalTokenCount: 50 } }] }), 'utf8');
    const stat = fs.statSync(file);
    const session = parseGeneric({ file, mtimeMs: stat.mtimeMs, size: stat.size }, 'gemini');
    assert.equal(session.title, '문서를 요약해줘');
    assert.equal(session.turnUsage.total, 50);
    assert.equal(session.usage.total, 50);
    assert.equal(session.context.window, 1_048_576);
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

}

function registerTerminalLifecycleTests(context) {
  const { test, root } = context;
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
    assert.equal(session.background, false);
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
    const backgroundAgent = manager.create({ type: 'agent', provider: 'codex', cwd: root });
    assert.equal(backgroundAgent.background, true);
    manager.close(backgroundAgent.id);
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
    }), /실행 가능한 POSIX 셸/);
    assert.equal(launchSpec(macShell, 'darwin', undefined, { env: { SHELL: '/broken/login-shell' }, fileSystem: posixFs }).file, '/bin/zsh');
    assert.equal(launchSpec(macShell, 'darwin', undefined, { env: { SHELL: '/broken/login-shell' }, fileSystem: posixFs }).args[0], '-l');
    const macTmux = launchSpec(normalizeLaunchOptions({ type: 'tmux', distro: 'macOS', tmuxSession: 'work' }, 'darwin'), 'darwin', undefined, { env: { SHELL: '/broken/login-shell' }, fileSystem: posixFs });
    assert.notEqual(macTmux.file, 'wsl.exe');
    assert.equal(macTmux.file, '/bin/zsh');
  });

}

function registerTerminalFailureTests(context) {
  const { test, temp, root } = context;

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
    assert.throws(() => decodeBase64('%%%'), /인코딩/);
    const terminalManager = new EventEmitter();
    terminalManager.write = () => { throw new Error('호출되면 안 됨'); };
    const server = new BridgeServer({ terminalManager });
    const client = { authenticated: true, terminalId: 'terminal:1', socket: { end() {} } };
    assert.throws(() => server.handle(client, { type: 'unknown' }), /지원하지 않는/);
    assert.throws(() => server.handle(client, { type: 'input', data: '%%%' }), /인코딩/);
  });

  test('시작 실패한 PTY는 세션 슬롯을 점유하거나 기존 replay를 중복 전송하지 않는다', () => {
    const manager = new TerminalManager({ ptyModule: { spawn: () => { throw new Error('spawn failed'); } } });
    const chunks = [];
    manager.on('data', payload => chunks.push(payload.data));
    assert.throws(() => manager.create({ type: 'powershell', cwd: root }), /spawn failed/);
    assert.equal(manager.list().length, 0);
    assert.equal(chunks.length, 1);
    assert.equal((chunks[0].match(/spawn failed/g) || []).length, 1);
  });

  test('Windows npm AI 명령은 실행 가능한 PowerShell 호스트로 연다', () => {
    const bin = path.join(temp, 'windows-agent-bin');
    fs.mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, 'codex.ps1');
    fs.writeFileSync(shim, 'Write-Output codex', 'utf8');
    assert.equal(resolveWindowsCommand('codex', { Path: bin }), shim);
    const spec = launchSpec(normalizeLaunchOptions({ type: 'agent', provider: 'codex', args: ['resume', 'session-id'], cwd: root }), 'win32', { codex: { command: shim, label: 'Codex' } });
    assert.ok(/powershell|pwsh/i.test(spec.file));
    assert.deepStrictEqual(spec.args.slice(-3), [shim, 'resume', 'session-id']);
  });

}

function registerTmuxControlTests(context) {
  const { test } = context;
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
    assert.deepStrictEqual(calls[1].args.slice(-7), ['tmux', 'paste-buffer', '-b', bufferName, '-d', '-t', '%1']);
    assert.deepStrictEqual(calls[2].args.slice(-5), ['tmux', 'send-keys', '-t', '%1', 'Enter']);
    const split = await controller.splitPane({ distro: 'Ubuntu', target: '%1', direction: 'horizontal', cwd: '/repo' });
    assert.equal(split.paneId, '%99');
    await assert.rejects(() => controller.splitPane({ distro: 'Ubuntu', target: '%1', direction: 'diagonal' }), /분할 방향/);
    await controller.newSession({ distro: 'Ubuntu', name: 'safe-name', cwd: '/repo' });
    await controller.selectLayout({ distro: 'Ubuntu', target: '@1', layout: 'tiled' });
    assert.equal(safeName('작업-1'), '작업-1');
    assert.equal(safeTarget('$1:@2.%3'), '$1:@2.%3');
    assert.throws(() => controller.sendKey({ distro: 'Ubuntu', target: '%1', key: 'run-shell' }), /허용되지 않은/);
    assert.throws(() => safeName('bad name;rm'), /이름에는/);
    assert.throws(() => safeTarget('%1;rm'), /대상 형식/);
    await controller.execute('Ubuntu', ['list-sessions'], { timeoutMs: 1_234 });
    assert.equal(calls.at(-1).options.timeoutMs, 1_234);
    const macCalls = [];
    const mac = new TmuxController({ platform: 'darwin', run: async (file, args, options = {}) => { macCalls.push({ file, args, options }); return { ok: true, stdout: '' }; } });
    await mac.sendKey({ distro: 'macOS', target: '%1', key: 'Enter' });
    assert.equal(macCalls[0].file, 'tmux');
    assert.deepStrictEqual(macCalls[0].args, ['send-keys', '-t', '%1', 'Enter']);
    assert.equal(macCalls[0].options.timeoutMs, undefined);
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
