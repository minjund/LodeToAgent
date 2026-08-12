'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { parseArguments } = require('../../bin/loadtoagent');
const { parseGeneric, buildSummary, snapshotWithoutSessions } = require('../../src/agentMonitor');
const { AgentRunner, commandSpec, handleClaude } = require('../../src/agentRunner');
const { BridgeServer, decodeBase64 } = require('../../src/bridgeServer');
const { ProcessMonitor, processRows, powershellProcessRows, posixProcessRows, providerFromPosixProcess, selectAgentProcesses, processSessionExternalId, promptFingerprint, bridgeLinkScore, applyRuntimePresence, inferredBridgeBindings } = require('../../src/processMonitor');
const { TerminalManager, normalizeLaunchOptions, launchSpec, resolveWindowsCommand, resolvePosixShell, killPtyTree } = require('../../src/terminalManager');
const {
  TerminalHostServer,
  TerminalHostClient,
  TERMINAL_HOST_PROTOCOL,
  acquireTerminalHostProcessLock,
  terminalHostLockEndpoint,
  terminateHostProcess,
  verifyHostDiscovery,
  resolveTerminalHostExecutable,
} = require('../../src/terminalHost');
const { parseConfig: parseTerminalHostConfig, run: runTerminalHostDaemon } = require('../../src/terminalHostDaemon');
const { TmuxController, safeName, safeTarget } = require('../../src/tmuxController');
const { TmuxMonitor, normalizeWslList, parseTmuxProbe, buildDistroTopology, linkAgentSessions, providerFromProcess } = require('../../src/tmuxMonitor');
const { ManagedTmuxRuntime } = require('../../src/managedTmuxRuntime');
const { parseLaunchPayload } = require('../../src/tmuxControlProxy');

async function waitUntil(predicate, timeoutMs = 2_000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, intervalMs));
  return predicate();
}

function registerTmuxAndProcessTests(context) {
  const { test } = context;
  test('WSL tmux 패널의 PID 계보에서 AI 프로세스를 식별한다', () => {
    const sep = '|~|';
    const argvRow = (pid, parentPid, age, command, argv) => [
      'A', String(pid), String(parentPid), String(age), command,
      Buffer.from(`${argv.join('\0')}\0`, 'utf8').toString('base64'),
    ].join(sep);
    const probe = parseTmuxProbe([
      ['M', '/home/dev', 'tmux_3.2a'].join(sep),
      ['P', '$1', 'work', '1784000000', '1', '1', '@1', '0', 'main', '1', '%1', '0', '100', 'node', '/mnt/d/repo', '1', '0', 'dev'].join(sep),
      `R${sep}100 1 120 bash -bash`,
      argvRow(110, 100, 119, 'node', ['node', '/home/dev/.local/bin/codex', 'resume', '--', 'session-111']),
      `R${sep}111 110 118 codex /opt/codex`,
      ['A', '190', '100', '117', 'codex', '%%%'].join(sep),
      ['A', '191', '100', '116', 'codex', 'YQ'].join(sep),
      ['A', '192', '100', '115', 'codex', Buffer.from('codex\0resume\0unterminated', 'utf8').toString('base64')].join(sep),
      ['F', 'codex', '1784000000.123', '2048', '/home/dev/.codex/sessions/test.jsonl'].join(sep),
    ].join('\n'), 'Ubuntu-22.04', 1784000120000);
    const topology = buildDistroTopology(probe);
    const pane = topology.sessions[0].windows[0].panes[0];
    assert.equal(pane.agentProcess.provider, 'codex');
    assert.equal(pane.agentProcess.pid, 111);
    assert.equal(pane.agentProcess.externalId, 'session-111');
    const ambiguousProbe = parseTmuxProbe([
      ['M', '/home/dev', 'tmux_3.2a'].join(sep),
      ['P', '$2', 'ambiguous', '1784000000', '1', '1', '@2', '0', 'main', '1', '%2', '0', '200', 'node', '/mnt/d/repo', '1', '0', 'dev'].join(sep),
      argvRow(210, 200, 119, 'node', ['node', '/home/dev/.local/bin/codex', 'resume', 'session-a']),
      argvRow(211, 210, 118, 'codex', ['codex', 'resume', 'session-b']),
    ].join('\n'), 'Ubuntu-22.04', 1784000120000);
    assert.equal(buildDistroTopology(ambiguousProbe).sessions[0].windows[0].panes[0].agentProcess.externalId, '');
    assert.equal(buildDistroTopology(ambiguousProbe).sessions[0].windows[0].panes[0].agentProcess.identityAmbiguous, true);
    assert.equal(probe.historyFiles.codex[0].size, 2048);
    assert.equal(providerFromProcess({ command: 'node', args: 'node /x/@google/gemini-cli/bin/gemini' }), 'gemini');
    assert.deepStrictEqual(probe.processes.find(item => item.pid === 110).argv,
      ['node', '/home/dev/.local/bin/codex', 'resume', '--', 'session-111']);
    assert.equal(probe.processes.some(item => [190, 191, 192].includes(item.pid)), false,
      'malformed or non-canonical argv base64 must fail closed');
    const emptyArgvProbe = parseTmuxProbe([
      ['M', '/home/dev', 'tmux_3.2a'].join(sep),
      ['P', '$3', 'empty-argv', '1784000000', '1', '1', '@3', '0', 'main', '1', '%3', '0', '300', 'gemini', '/mnt/d/repo', '1', '0', 'dev'].join(sep),
      argvRow(300, 1, 10, 'gemini', ['gemini', '', '--resume', 'must-not-authorize']),
    ].join('\n'), 'Ubuntu-22.04', 1784000120000);
    const emptyArgvPane = buildDistroTopology(emptyArgvProbe).sessions[0].windows[0].panes[0];
    assert.equal(emptyArgvPane.agentProcess.externalId, '', 'internal empty argv must not be filtered or shift identity options');
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
    assert.equal(linked.distros[0].sessions[0].windows[0].panes[0].agent.linkAuthority, 'heuristic-display');

    const crosswireTopology = structuredClone(topology);
    crosswireTopology.distros[0].sessions[0].windows[0].panes = [
      { ...structuredClone(topology.distros[0].sessions[0].windows[0].panes[0]), id: 'pane-b', agentProcess: {
        provider: 'codex', pid: 211, command: 'codex', args: 'codex resume session-B', argv: ['codex', 'resume', 'session-B'], startedAt: new Date().toISOString(),
      } },
      { ...structuredClone(topology.distros[0].sessions[0].windows[0].panes[0]), id: 'pane-a', agentProcess: {
        provider: 'codex', pid: 212, command: 'codex', args: 'codex resume session-A', argv: ['codex', 'resume', 'session-A'], startedAt: new Date().toISOString(),
      } },
    ];
    const exactSessions = [
      { ...session, id: 'codex:session-A', externalId: 'session-A', title: 'A' },
      { ...session, id: 'codex:session-B', externalId: 'session-B', title: 'B' },
    ];
    const exactLinked = linkAgentSessions(crosswireTopology, exactSessions);
    const [paneB, paneA] = exactLinked.distros[0].sessions[0].windows[0].panes;
    assert.equal(paneB.agent.linkedSessionId, 'codex:session-B');
    assert.equal(paneA.agent.linkedSessionId, 'codex:session-A');
    assert.equal(paneB.agent.linkAuthority, 'explicit-session-id');
    assert.equal(paneA.agent.linkAuthority, 'explicit-session-id');
    const exactRuntime = applyRuntimePresence(exactSessions, exactLinked, { processes: [] });
    assert.equal(exactRuntime.find(item => item.id === 'codex:session-B').runtimePresence[0].paneId, 'pane-b');
    assert.equal(exactRuntime.find(item => item.id === 'codex:session-A').runtimePresence[0].paneId, 'pane-a');

    const providerCommands = {
      claude: id => `claude --resume ${id}`,
      codex: id => `codex resume -- ${id}`,
      gemini: id => `gemini --resume ${id}`,
      grok: id => `grok --resume ${id}`,
    };
    const providerArgv = {
      claude: id => ['claude', '--resume', id],
      codex: id => ['codex', 'resume', '--', id],
      gemini: id => ['gemini', '--resume', id],
      grok: id => ['grok', '--resume', id],
    };
    const promptInjectionCommands = {
      claude: id => `claude -- "investigate --resume ${id}"`,
      codex: id => `codex -- "investigate codex resume -- ${id}"`,
      gemini: id => `gemini -- "investigate --resume ${id}"`,
      grok: id => `grok -- "investigate --resume ${id}"`,
    };
    for (const [provider, commandFor] of Object.entries(providerCommands)) {
      const providerTopology = structuredClone(topology);
      providerTopology.distros[0].sessions[0].windows[0].panes = ['B', 'A'].map((suffix, index) => ({
        ...structuredClone(topology.distros[0].sessions[0].windows[0].panes[0]),
        id: `${provider}-pane-${suffix}`,
        agentProcess: {
          provider,
          pid: 300 + index,
          command: provider,
          args: commandFor(`${provider}-session-${suffix}`),
          argv: providerArgv[provider](`${provider}-session-${suffix}`),
          startedAt: new Date().toISOString(),
        },
      }));
      const providerSessions = ['A', 'B'].map(suffix => ({
        ...session,
        id: `${provider}:${provider}-session-${suffix}`,
        externalId: `${provider}-session-${suffix}`,
        provider,
      }));
      const providerLinked = linkAgentSessions(providerTopology, providerSessions);
      const providerPanes = providerLinked.distros[0].sessions[0].windows[0].panes;
      assert.deepStrictEqual(providerPanes.map(item => item.agent.linkedSessionId), [
        `${provider}:${provider}-session-B`,
        `${provider}:${provider}-session-A`,
      ]);
      assert.deepStrictEqual(providerPanes.map(item => item.agent.linkAuthority), [
        'explicit-session-id',
        'explicit-session-id',
      ]);

      const ambiguousTopology = structuredClone(providerTopology);
      for (const ambiguousPane of ambiguousTopology.distros[0].sessions[0].windows[0].panes) {
        ambiguousPane.agentProcess.args = commandFor(`${provider}-session-A`);
        ambiguousPane.agentProcess.argv = providerArgv[provider](`${provider}-session-A`);
      }
      const ambiguousLinked = linkAgentSessions(ambiguousTopology, providerSessions);
      const ambiguousPanes = ambiguousLinked.distros[0].sessions[0].windows[0].panes;
      assert.deepStrictEqual(ambiguousPanes.map(item => item.agent.linkedSessionId), [null, null]);
      assert.deepStrictEqual(ambiguousPanes.map(item => item.agent.linkAuthority), ['', '']);

      const injectedTopology = structuredClone(providerTopology);
      const injectedArgv = {
        claude: id => ['claude', '--', `investigate --resume ${id}`],
        codex: id => ['codex', `resume ${id}`],
        gemini: id => ['gemini', `--resume ${id}`],
        grok: id => ['grok', `--resume ${id}`],
      };
      injectedTopology.distros[0].sessions[0].windows[0].panes = [{
        ...injectedTopology.distros[0].sessions[0].windows[0].panes[0],
        agentProcess: {
          ...injectedTopology.distros[0].sessions[0].windows[0].panes[0].agentProcess,
          args: promptInjectionCommands[provider](`${provider}-session-A`),
          argv: injectedArgv[provider](`${provider}-session-A`),
        },
      }];
      const injectedPane = linkAgentSessions(injectedTopology, providerSessions)
        .distros[0].sessions[0].windows[0].panes[0];
      assert.notEqual(injectedPane.agent.linkAuthority, 'explicit-session-id',
        `${provider} prompt text must never become writable tmux authority`);

      const flattenedTopology = structuredClone(providerTopology);
      delete flattenedTopology.distros[0].sessions[0].windows[0].panes[0].agentProcess.argv;
      flattenedTopology.distros[0].sessions[0].windows[0].panes.length = 1;
      const flattenedPane = linkAgentSessions(flattenedTopology, providerSessions)
        .distros[0].sessions[0].windows[0].panes[0];
      assert.equal(flattenedPane.agent.linkAuthority, 'heuristic-display',
        `${provider} flattened ps text must remain display-only`);
      const flattenedRuntime = applyRuntimePresence(providerSessions,
        linkAgentSessions(flattenedTopology, providerSessions), { processes: [] });
      assert.equal(flattenedRuntime.every(item => !(item.runtimePresence || []).some(presence => presence.kind === 'tmux')), true);
    }

    const heuristicRuntime = applyRuntimePresence([session], linked, { processes: [] });
    assert.deepStrictEqual(heuristicRuntime[0].runtimePresence || [], [],
      'provider/cwd/time heuristic must remain display-only and never authorize tmux input');
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
      distros: [{ name: 'Ubuntu', sessions: [{ name: 'tmux-work', windows: [{ panes: [{ nativeId: '%1', index: 0, cwd: '/repo', agent: { provider: 'claude', pid: 301, linkedSessionId: 'claude:wsl', linkAuthority: 'explicit-session-id', startedAt: '2026-07-14T03:00:00Z' } }] }] }] }],
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
    const completedBatch = applyRuntimePresence([{
      ...batch[0], status: 'completed', statusDetail: '작업 완료',
      completionObserved: true, completedAt: '2026-07-14T03:00:55Z',
    }], {}, { processes: [processes[1]] }, Date.parse('2026-07-14T03:01:00Z'));
    assert.equal(completedBatch[0].status, 'completed');
    assert.equal(completedBatch[0].statusDetail, '작업 완료');
    assert.equal(completedBatch[0].runtimePresence[0].pid, 404);
    const restartedBatch = applyRuntimePresence([{
      ...completedBatch[0], runtimePresence: [],
    }], {}, { processes: [{
      ...processes[1], id: 'windows:claude:405', pid: 405,
      startedAt: '2026-07-14T03:01:05Z',
    }] }, Date.parse('2026-07-14T03:01:10Z'));
    assert.equal(restartedBatch[0].status, 'running');
    assert.equal(restartedBatch[0].conversationStatus, 'completed');
    const commandLine = 'claude.exe --session-id current-session --fork-session --resume C:\\Users\\dev\\.claude\\projects\\repo\\old-session.jsonl';
    assert.equal(processSessionExternalId({ commandLine }, 'claude'), 'current-session');
    assert.equal(processSessionExternalId({ commandLine: 'claude.exe --resume "C:\\Users\\dev\\.claude\\projects\\repo\\resumed-session.jsonl"' }, 'claude'), 'resumed-session');
    assert.equal(processSessionExternalId({ commandLine: 'codex resume -- codex-session' }, 'codex'), 'codex-session');
    assert.equal(processSessionExternalId({ commandLine: 'gemini --resume gemini-session' }, 'gemini'), 'gemini-session');
    assert.equal(processSessionExternalId({ commandLine: 'grok --resume grok-session' }, 'grok'), 'grok-session');
    assert.equal(processSessionExternalId({ commandLine: 'claude -- "investigate --resume claude-session"' }, 'claude'), '');
    assert.equal(processSessionExternalId({ commandLine: 'codex -- "investigate codex resume -- codex-session"' }, 'codex'), '');
    assert.equal(processSessionExternalId({ commandLine: 'gemini -- "investigate --resume gemini-session"' }, 'gemini'), '');
    assert.equal(processSessionExternalId({ commandLine: 'grok -- "investigate --resume grok-session"' }, 'grok'), '');
    assert.equal(processSessionExternalId({
      argv: ['claude', '--', 'investigate', '--resume', 'argv-injected'],
    }, 'claude'), '');
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
    const prompt = '새 PTY에서만 보낸 질문';
    const bridge = {
      provider: 'codex', environment: 'windows', cwd: 'D:\\repo',
      terminalId: 'terminal:new', startedAt: '2026-07-14T09:59:30Z',
      initialPromptFingerprint: promptFingerprint(prompt),
    };
    const base = {
      provider: 'codex', externalId: 'matched', environment: { kind: 'windows', distro: '' },
      cwd: 'D:\\repo', parentId: null, updatedAt: '2026-07-14T10:00:00Z',
      messages: [{ role: 'user', text: prompt, timestamp: '2026-07-14T09:59:35Z' }],
    };
    assert.equal(bridgeLinkScore({ ...base, clientKind: 'codex-desktop', startedAt: bridge.startedAt }, bridge, now), -Infinity);
    assert.equal(bridgeLinkScore({ ...base, provider: 'claude', clientKind: 'claude-desktop', startedAt: bridge.startedAt }, { ...bridge, provider: 'claude' }, now), -Infinity);
    assert.equal(bridgeLinkScore({ ...base, clientKind: 'codex-cli', startedAt: '2026-07-14T09:40:00Z' }, bridge, now), -Infinity);
    assert.equal(bridgeLinkScore({ ...base, messages: [], clientKind: 'codex-cli', startedAt: '2026-07-14T09:59:35Z' }, bridge, now), -Infinity);
    assert.equal(bridgeLinkScore({ ...base, messages: [{ role: 'user', text: '지난 질문', timestamp: '2026-07-14T09:59:35Z' }], clientKind: 'codex-cli', startedAt: '2026-07-14T09:59:35Z' }, bridge, now), -Infinity);
    assert.equal(bridgeLinkScore({ ...base, messages: [{ role: 'user', text: prompt, timestamp: '2026-07-14T09:55:30Z' }], clientKind: 'codex-cli', startedAt: bridge.startedAt }, bridge, now), -Infinity,
      'launch 전 과거 prompt 기록은 같은 cwd/text여도 새 PTY에 연결하면 안 됩니다.');
    assert.equal(bridgeLinkScore({ ...base, clientKind: 'codex-cli', startedAt: '2026-07-14T09:55:30Z' }, bridge, now), -Infinity,
      'launch 전 과거 session 시작 시각도 새 PTY에 연결하면 안 됩니다.');
    assert.ok(bridgeLinkScore({
      ...base,
      messages: [{ role: 'user', text: prompt, timestamp: '2026-07-14T09:59:29Z' }],
      clientKind: 'codex-cli',
      startedAt: '2026-07-14T09:59:29Z',
    }, bridge, now) > 10_000, '초 단위 기록/시계 오차는 허용해야 합니다.');
    assert.ok(bridgeLinkScore({ ...base, clientKind: 'codex-cli', startedAt: '2026-07-14T09:59:35Z' }, bridge, now) > 10_000);
    const observed = applyRuntimePresence([{ ...base, id: 'codex:matched', clientKind: 'codex-cli', startedAt: '2026-07-14T09:59:35Z' }], {}, { processes: [] }, now, [{ ...bridge, id: 'terminal:new', terminalId: 'terminal:new' }]);
    assert.deepStrictEqual(inferredBridgeBindings(observed).map(item => [item.terminalId, item.sessionId]), [['terminal:new', 'codex:matched']]);
    assert.equal(inferredBridgeBindings(observed)[0].promptFingerprint, bridge.initialPromptFingerprint);
    assert.deepStrictEqual(inferredBridgeBindings(observed, 20_000), []);

    const oldSamePrompt = applyRuntimePresence([{
      ...base,
      id: 'codex:old-same-prompt', externalId: 'old-same-prompt', clientKind: 'codex-cli',
      startedAt: '2026-07-14T09:55:30Z',
      messages: [{ role: 'user', text: prompt, timestamp: '2026-07-14T09:55:30Z' }],
    }], {}, { processes: [] }, now, [{ ...bridge, id: 'terminal:old-guard', terminalId: 'terminal:old-guard' }]);
    assert.deepStrictEqual(inferredBridgeBindings(oldSamePrompt), [],
      '4분 전 동일 prompt/cwd history는 새 transcript가 생기기 전에도 연결하면 안 됩니다.');
    assert.equal(oldSamePrompt.some(session => session.id === 'bridge:terminal:old-guard'), true,
      '과거 history만 있는 fresh PTY는 unresolved synthetic bridge로 남아야 합니다.');

    const ambiguousHistories = applyRuntimePresence([
      { ...base, id: 'codex:ambiguous-a', externalId: 'ambiguous-a', clientKind: 'codex-cli', startedAt: '2026-07-14T09:59:35Z' },
      { ...base, id: 'codex:ambiguous-b', externalId: 'ambiguous-b', clientKind: 'codex-cli', startedAt: '2026-07-14T09:59:35Z' },
    ], {}, { processes: [] }, now, [{ ...bridge, id: 'terminal:ambiguous', terminalId: 'terminal:ambiguous' }]);
    assert.deepStrictEqual(inferredBridgeBindings(ambiguousHistories), [],
      '동일 prompt/time/cwd의 history 후보가 둘이면 greedy 표시 결과를 영속 연결하면 안 됩니다.');
    assert.equal(ambiguousHistories
      .filter(session => session.id.startsWith('codex:ambiguous-'))
      .some(session => (session.runtimePresence || []).some(presence => presence.terminalId === 'terminal:ambiguous')), false,
    '모호한 fresh PTY를 어느 과거 history 카드에도 표시 연결하면 안 됩니다.');
    assert.equal(ambiguousHistories.some(session => session.id === 'bridge:terminal:ambiguous'), true,
      '모호한 PTY는 unresolved synthetic bridge로 남아야 합니다.');

    const ambiguousTerminals = applyRuntimePresence([
      { ...base, id: 'codex:one-history', externalId: 'one-history', clientKind: 'codex-cli', startedAt: '2026-07-14T09:59:35Z' },
    ], {}, { processes: [] }, now, [
      { ...bridge, id: 'terminal:first', terminalId: 'terminal:first' },
      { ...bridge, id: 'terminal:second', terminalId: 'terminal:second' },
    ]);
    assert.deepStrictEqual(inferredBridgeBindings(ambiguousTerminals), [],
      '같은 history 후보인 fresh terminal이 둘이면 어느 쪽도 영속 연결하면 안 됩니다.');
    const oneHistory = ambiguousTerminals.find(session => session.id === 'codex:one-history');
    assert.equal((oneHistory.runtimePresence || []).some(presence => presence.kind === 'bridge'), false);
    assert.equal(ambiguousTerminals.filter(session => session.id.startsWith('bridge:terminal:')).length, 2);
  });

}

function registerBridgeIntegrationTests(context) {
  const { test, temp, root } = context;
  test('LoadToAgent 외부 브리지는 인증 소켓으로 전용 PTY에만 입력한다', async () => {
    class FakeManager extends EventEmitter {
      constructor() { super(); this.writes = []; this.sessions = []; this.lastOptions = null; }
      create(options) {
        this.lastOptions = options;
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
    assert.equal(await waitUntil(() => server.clients.size === 1), true);
    const bridgeClient = [...server.clients.values()][0];
    const runFrame = Buffer.from(`${JSON.stringify({
      type: 'run', token: 'test-token', provider: 'codex', cwd: root, args: ['질문😀'],
    })}\n`, 'utf8');
    // Force every multibyte code point across a transport chunk boundary.
    for (let index = 0; index < runFrame.length; index += 1) {
      server.consume(bridgeClient, runFrame.subarray(index, index + 1));
    }
    const started = await nextFrame();
    assert.equal(started.type, 'started');
    assert.deepStrictEqual(manager.lastOptions.args, ['질문😀']);
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
    const inferredQuestion = parseGeneric({ file: questionFile, mtimeMs: questionStat.mtimeMs, size: questionStat.size }, 'gemini');
    assert.equal(inferredQuestion.status, 'running');
    assert.equal(inferredQuestion.statusDetail, '실시간 이벤트 수신 중');
    assert.equal(inferredQuestion.responseIntent.source, 'assistant-message');
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
    assert.equal(state.completionObserved, true);
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
  test('터미널 호스트 데몬 진입점은 패키지 런타임에서 정의되지 않은 참조 없이 로드된다', () => {
    assert.equal(typeof parseTerminalHostConfig, 'function');
    assert.equal(typeof runTerminalHostDaemon, 'function');
  });

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

  test('늦게 도착한 다른 identity의 브리지 create는 기존 PTY에 쓰거나 새 PTY를 만들지 않는다', async () => {
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
      killTree: () => ({ ok: true }),
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(8_700 + processes.length);
          processes.push(handle);
          return handle;
        },
      },
    });
    const bridge = {
      type: 'agent',
      provider: 'codex',
      cwd: root,
      bridgeId: 'codex:identity-race',
      sessionBackend: 'direct',
      reuseBridge: true,
    };
    const current = manager.create({
      ...bridge,
      args: ['resume', 'identity-race-current'],
      recoveryArgs: ['resume', 'identity-race-current'],
      agentConnectionSignature: 'signature:current',
    });

    assert.throws(() => manager.create({
      ...bridge,
      args: ['resume', 'identity-race-stale'],
      recoveryArgs: ['resume', 'identity-race-stale'],
      agentConnectionSignature: 'signature:stale',
      initialCommand: '이전 identity에 보내면 안 되는 질문',
      initialCommandInArgs: false,
    }), error => error.code === 'AGENT_CONNECTION_IDENTITY_CONFLICT'
      && error.deliveryState === 'rejected');

    assert.throws(() => manager.create({
      ...bridge,
      reuseBridge: false,
      args: ['resume', 'identity-race-stale-no-reuse'],
      recoveryArgs: ['resume', 'identity-race-stale-no-reuse'],
      agentConnectionSignature: 'signature:stale',
      initialCommand: 'reuseBridge=false로도 이전 identity를 우회하면 안 되는 질문',
      initialCommandInArgs: false,
    }), error => error.code === 'AGENT_CONNECTION_IDENTITY_CONFLICT'
      && error.deliveryState === 'rejected');

    assert.throws(() => manager.create({
      ...bridge,
      reuseBridge: false,
      args: ['resume', 'identity-race-current'],
      recoveryArgs: ['resume', 'identity-race-current'],
      agentConnectionSignature: 'signature:current',
      initialCommand: '같은 identity여도 기존 연결 종료 확인 전 새 PTY를 만들면 안 되는 질문',
      initialCommandInArgs: false,
    }), error => error.code === 'AGENT_CONNECTION_ALREADY_ACTIVE'
      && error.deliveryState === 'rejected');

    assert.equal(processes.length, 1);
    assert.deepStrictEqual(processes[0].writes, []);
    assert.deepStrictEqual(manager.list().map(session => session.id), [current.id]);

    const reused = manager.create({
      ...bridge,
      args: ['resume', 'identity-race-current'],
      recoveryArgs: ['resume', 'identity-race-current'],
      agentConnectionSignature: 'signature:current',
      initialCommand: '같은 identity의 후속 질문',
      initialCommandInArgs: false,
    });
    assert.equal(reused.id, current.id);
    assert.equal(reused.reused, true);
    assert.deepStrictEqual(processes[0].writes, ['같은 identity의 후속 질문\r']);
    manager.close(current.id);

    let releaseDuplicateRetirement;
    const duplicateRetirementGate = new Promise(resolve => { releaseDuplicateRetirement = resolve; });
    const dedupeProcesses = [];
    const dedupeManager = new TerminalManager({
      platform: 'win32',
      killTree: () => duplicateRetirementGate,
      ptyModule: { spawn: () => {
        const handle = new FakePty(8_750 + dedupeProcesses.length);
        dedupeProcesses.push(handle);
        return handle;
      } },
    });
    const dedupeBase = {
      type: 'agent', provider: 'codex', cwd: root,
      sessionBackend: 'direct',
      agentConnectionSignature: 'signature:dedupe',
      args: ['resume', 'identity-dedupe'],
      recoveryArgs: ['resume', 'identity-dedupe'],
    };
    const olderDuplicate = dedupeManager.create({ ...dedupeBase, bridgeId: 'codex:dedupe-old' });
    const survivor = dedupeManager.create({
      ...dedupeBase,
      bridgeId: 'codex:dedupe-new',
      args: ['resume', 'identity-dedupe-new'],
      recoveryArgs: ['resume', 'identity-dedupe-new'],
    });
    const survivorRecord = dedupeManager.sessions.get(survivor.id);
    survivorRecord.options.bridgeId = 'codex:dedupe-old';
    survivorRecord.updatedAt = new Date(Date.now() + 60_000).toISOString();

    assert.throws(
      () => dedupeManager.deduplicateAgentBridgeSessions(),
      error => error.code === 'AGENT_CONNECTION_RETIRE_IN_PROGRESS'
        && error.deliveryState === 'rejected',
    );
    const pendingDuplicate = dedupeManager.get(olderDuplicate.id);
    assert.equal(pendingDuplicate.status, 'stopping');
    assert.equal(pendingDuplicate.terminationPending, true);
    assert.equal(dedupeManager.list().length, 2, 'tree 종료 ACK 전에는 중복 행을 삭제하면 안 됩니다.');
    const duplicateRetirement = dedupeManager.transitionPromises.get(olderDuplicate.id).promise;
    releaseDuplicateRetirement({ ok: true, exited: true });
    await duplicateRetirement;
    assert.equal(dedupeManager.get(olderDuplicate.id), null);
    assert.deepStrictEqual(dedupeManager.list().map(item => item.id), [survivor.id]);
    await dedupeManager.close(survivor.id);
  });

  test('PTY exit 확인 전 retire는 레지스트리를 유지하고 exit 후 완료하며 timeout은 fail closed 한다', async () => {
    class FakePty {
      constructor(pid = 8_801) {
        this.pid = pid;
        this.killed = false;
        this.exitCallbacks = new Set();
        this.disposals = 0;
      }
      onData() {}
      onExit(callback) {
        this.exitCallbacks.add(callback);
        return {
          dispose: () => {
            this.disposals += 1;
            this.exitCallbacks.delete(callback);
          },
        };
      }
      write() {}
      resize() {}
      kill() { this.killed = true; }
      emitExit(event = { exitCode: 0, signal: 0 }) {
        for (const callback of [...this.exitCallbacks]) callback(event);
      }
    }
    const terminatedPosixGroups = new Set();
    const posixSignals = [];
    const posixKillProcess = (target, signal) => {
      const groupPid = -Number(target);
      posixSignals.push([target, signal]);
      if (signal === 'SIGHUP') {
        terminatedPosixGroups.add(groupPid);
        return;
      }
      if (signal === 0 && terminatedPosixGroups.has(groupPid)) {
        const error = new Error('missing process group');
        error.code = 'ESRCH';
        throw error;
      }
    };
    const processHandle = new FakePty();
    const manager = new TerminalManager({
      platform: 'win32',
      // Exercise confirmed POSIX process-group shutdown independently of the
      // host OS running this regression suite.
      killTree: (handle, pid) => killPtyTree(handle, pid, 250, {
        platform: 'darwin',
        killProcess: posixKillProcess,
      }),
      ptyModule: { spawn: () => processHandle },
    });
    const session = manager.create({
      type: 'agent', provider: 'codex', cwd: root,
      sessionBackend: 'direct', bridgeId: 'codex:posix-group-direct',
    });
    let settled = false;
    const retiring = manager.retire(session.id);
    retiring.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();

    assert.equal(processHandle.killed, false);
    assert.deepStrictEqual(posixSignals.slice(0, 2), [[-8_801, 'SIGHUP'], [-8_801, 0]]);
    assert.equal(settled, false);
    assert.equal(manager.get(session.id).status, 'stopping');
    assert.equal(manager.list().length, 1);
    assert.equal(processHandle.exitCallbacks.size, 2);

    processHandle.emitExit();
    assert.deepStrictEqual(await retiring, { ok: true });
    assert.equal(settled, true);
    assert.equal(processHandle.disposals, 1);
    assert.equal(manager.get(session.id), null);
    assert.equal(manager.list().length, 0);

    const alreadyExited = new FakePty(8_803);
    alreadyExited.__loadtoagentExited = true;
    assert.deepStrictEqual(await killPtyTree(alreadyExited, alreadyExited.pid, 50, {
      platform: 'darwin', killProcess: posixKillProcess,
    }), {
      ok: true,
      exited: true,
      processGroup: true,
    });
    assert.equal(alreadyExited.killed, false);
    assert.equal(alreadyExited.exitCallbacks.size, 0);

    const preferredSignalHandle = new FakePty(8_804);
    preferredSignalHandle.__loadtoagentPosixSignal = 'SIGTERM';
    const preferredSignals = [];
    let preferredGroupAlive = true;
    const preferredCompletion = killPtyTree(preferredSignalHandle, preferredSignalHandle.pid, 200, {
      platform: 'darwin',
      killProcess: (target, signal) => {
        preferredSignals.push([target, signal]);
        if (signal === 'SIGTERM') {
          preferredGroupAlive = false;
          setImmediate(() => preferredSignalHandle.emitExit());
          return;
        }
        if (signal === 0 && !preferredGroupAlive) {
          const error = new Error('missing preferred-signal process group');
          error.code = 'ESRCH';
          throw error;
        }
      },
    });
    assert.deepStrictEqual(await preferredCompletion, { ok: true, exited: true, processGroup: true });
    assert.deepStrictEqual(preferredSignals.slice(0, 2), [[-8_804, 'SIGTERM'], [-8_804, 0]]);

    let synchronousDisposals = 0;
    let synchronousKills = 0;
    const synchronousExit = {
      onExit(callback) {
        callback({ exitCode: 0, signal: 0 });
        return { dispose: () => { synchronousDisposals += 1; } };
      },
      kill() { synchronousKills += 1; },
    };
    assert.deepStrictEqual(await killPtyTree(synchronousExit, 8_804, 50, {
      platform: 'darwin', killProcess: posixKillProcess,
    }), {
      ok: true,
      exited: true,
      processGroup: true,
    });
    assert.equal(synchronousDisposals, 1);
    assert.equal(synchronousKills, 0);

    const missingPosixPid = new FakePty(0);
    await assert.rejects(
      killPtyTree(missingPosixPid, Number.NaN, 50, { platform: 'darwin' }),
      error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED',
    );
    assert.equal(missingPosixPid.killed, true);

    let delayedGroupAlive = true;
    const delayedGroupHandle = new FakePty(8_807);
    let delayedGroupSettled = false;
    const delayedGroupCompletion = killPtyTree(delayedGroupHandle, delayedGroupHandle.pid, 200, {
      platform: 'darwin',
      killProcess: (_target, signal) => {
        if (signal === 0 && !delayedGroupAlive) {
          const error = new Error('missing process group');
          error.code = 'ESRCH';
          throw error;
        }
      },
    }).then(result => {
      delayedGroupSettled = true;
      return result;
    });
    delayedGroupHandle.emitExit();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(delayedGroupSettled, false, 'root PTY exit만으로 POSIX process group 종료를 확정하면 안 됩니다.');
    delayedGroupAlive = false;
    const delayedGroupKeepAlive = setTimeout(() => {}, 500);
    try {
      assert.deepStrictEqual(await delayedGroupCompletion, { ok: true, exited: true, processGroup: true });
    } finally {
      clearTimeout(delayedGroupKeepAlive);
    }

    const managedGroupHandle = new FakePty(8_806);
    const managedTerminatedGroups = new Set();
    let managedGroupStopCalls = 0;
    const managedGroupManager = new TerminalManager({
      platform: 'darwin',
      killTree: (handle, pid) => killPtyTree(handle, pid, 200, {
        platform: 'darwin',
        killProcess: (target, signal) => {
          const groupPid = -Number(target);
          if (signal === 'SIGHUP') {
            managedTerminatedGroups.add(groupPid);
            return;
          }
          if (signal === 0 && managedTerminatedGroups.has(groupPid)) {
            const error = new Error('missing process group');
            error.code = 'ESRCH';
            throw error;
          }
        },
      }),
      managedTmuxRuntime: {
        existsStrict: () => true,
        stopStrict: () => { managedGroupStopCalls += 1; return { ok: true }; },
      },
      ptyModule: { spawn: () => managedGroupHandle },
    });
    const managedGroupSession = managedGroupManager.create({
      type: 'agent', provider: 'codex', cwd: root,
      sessionBackend: 'managed-tmux', managedTmuxSession: 'posix-group-managed',
      bridgeId: 'codex:posix-group-managed',
    });
    const managedGroupDetach = managedGroupManager.detach(managedGroupSession.id);
    assert.equal(managedGroupManager.get(managedGroupSession.id).status, 'stopping');
    assert.equal(managedGroupStopCalls, 0);
    managedGroupHandle.emitExit();
    assert.equal((await managedGroupDetach).status, 'detached');
    assert.equal(managedGroupStopCalls, 0, 'managed attach 분리는 tmux provider를 종료하면 안 됩니다.');
    assert.deepStrictEqual(managedGroupManager.close(managedGroupSession.id), { ok: true });
    assert.equal(managedGroupStopCalls, 1);

    const managedKillHandle = new FakePty(8_805);
    const managedKillGroups = new Set();
    const managedKillManager = new TerminalManager({
      platform: 'darwin',
      killTree: (handle, pid) => killPtyTree(handle, pid, 200, {
        platform: 'darwin',
        killProcess: (target, signal) => {
          const groupPid = -Number(target);
          if (signal === 'SIGHUP') {
            managedKillGroups.add(groupPid);
            return;
          }
          if (signal === 0 && managedKillGroups.has(groupPid)) {
            const error = new Error('missing process group');
            error.code = 'ESRCH';
            throw error;
          }
        },
      }),
      managedTmuxRuntime: { existsStrict: () => true, stopStrict: () => ({ ok: true }) },
      ptyModule: { spawn: () => managedKillHandle },
    });
    const managedKillSession = managedKillManager.create({
      type: 'agent', provider: 'codex', cwd: root,
      sessionBackend: 'managed-tmux', managedTmuxSession: 'posix-group-managed-kill',
      bridgeId: 'codex:posix-group-managed-kill',
    });
    const managedKill = managedKillManager.kill(managedKillSession.id);
    managedKillHandle.emitExit();
    assert.deepStrictEqual(await managedKill, { ok: true });
    assert.equal(managedKillManager.get(managedKillSession.id).status, 'detached');
    assert.throws(
      () => managedKillManager.create({
        type: 'agent', provider: 'codex', cwd: root,
        sessionBackend: 'managed-tmux', managedTmuxSession: 'posix-group-managed-kill-new',
        bridgeId: 'codex:posix-group-managed-kill',
        reuseBridge: false,
      }),
      error => error.code === 'AGENT_CONNECTION_ALREADY_ACTIVE',
    );
    assert.deepStrictEqual(managedKillManager.close(managedKillSession.id), { ok: true });

    const missingWindowsPid = new FakePty(0);
    await assert.rejects(
      killPtyTree(missingWindowsPid, Number.NaN, 50, { platform: 'win32' }),
      error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED',
    );
    assert.equal(missingWindowsPid.killed, true);

    const delayedPidHandle = new FakePty(0);
    let delayedTreePid = null;
    const delayedPidManager = new TerminalManager({
      platform: 'win32',
      ptyPidReadyTimeoutMs: 200,
      killTree: async (handle, pid) => {
        delayedTreePid = pid;
        handle.emitExit();
        return { ok: true, exited: true, taskkill: true };
      },
      ptyModule: { spawn: () => delayedPidHandle },
    });
    const delayedPidSession = delayedPidManager.create({ type: 'powershell', cwd: root });
    const delayedPidClose = delayedPidManager.close(delayedPidSession.id);
    assert.equal(delayedTreePid, null, 'ConPTY PID가 0인 동안 process-tree 종료를 시작하면 안 됩니다.');
    setTimeout(() => { delayedPidHandle.pid = 8_814; }, 20);
    assert.deepStrictEqual(await delayedPidClose, { ok: true });
    assert.equal(delayedTreePid, 8_814, 'ready_datapipe 뒤 공개된 실제 ConPTY PID로 taskkill해야 합니다.');
    assert.equal(delayedPidManager.get(delayedPidSession.id), null);

    const successfulTaskkillHandle = new FakePty(8_805);
    const successfulTaskkill = new EventEmitter();
    successfulTaskkill.unref = () => {};
    successfulTaskkill.kill = () => {};
    let taskkillSpawn = null;
    let taskkillSettled = false;
    const taskkillCompletion = killPtyTree(successfulTaskkillHandle, 8_805, 100, {
      platform: 'win32',
      spawnChild: (file, args, options) => {
        taskkillSpawn = { file, args, options };
        return successfulTaskkill;
      },
    }).then(result => {
      taskkillSettled = true;
      return result;
    });
    assert.equal(successfulTaskkillHandle.exitCallbacks.size, 1, 'taskkill 실행 전에 PTY exit listener를 등록해야 합니다.');
    assert.deepStrictEqual(taskkillSpawn, {
      file: 'taskkill.exe',
      args: ['/PID', '8805', '/T', '/F'],
      options: { windowsHide: true, stdio: 'ignore' },
    });
    successfulTaskkill.emit('exit', 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(taskkillSettled, false, 'taskkill exit 0만으로 프로세스 종료를 확정하면 안 됩니다.');
    assert.equal(successfulTaskkillHandle.killed, false, '성공한 taskkill 뒤 handle.kill을 다시 호출하면 안 됩니다.');
    successfulTaskkillHandle.emitExit();
    assert.deepStrictEqual(await taskkillCompletion, { ok: true, exited: true, taskkill: true });
    assert.equal(successfulTaskkillHandle.killed, false);

    const preExitedHandle = new FakePty(8_813);
    preExitedHandle.__loadtoagentExited = true;
    const preExitedTaskkill = new EventEmitter();
    preExitedTaskkill.unref = () => {};
    preExitedTaskkill.kill = () => {};
    let preExitedSpawnCalls = 0;
    let preExitedSettled = false;
    const preExitedCompletion = killPtyTree(preExitedHandle, 8_813, 100, {
      platform: 'win32',
      spawnChild: () => {
        preExitedSpawnCalls += 1;
        return preExitedTaskkill;
      },
    }).then(result => {
      preExitedSettled = true;
      return result;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(preExitedSpawnCalls, 1, 'numeric PID가 있으면 이미 끝난 PTY도 taskkill /T 확인을 생략하면 안 됩니다.');
    assert.equal(preExitedSettled, false);
    preExitedTaskkill.emit('exit', 0);
    assert.deepStrictEqual(await preExitedCompletion, { ok: true, exited: true, taskkill: true });
    assert.equal(preExitedHandle.killed, false);

    const exitFirstHandle = new FakePty(8_808);
    const exitFirstTaskkill = new EventEmitter();
    exitFirstTaskkill.unref = () => {};
    exitFirstTaskkill.kill = () => {};
    let exitFirstSettled = false;
    const exitFirstCompletion = killPtyTree(exitFirstHandle, 8_808, 100, {
      platform: 'win32',
      spawnChild: () => exitFirstTaskkill,
    }).then(result => {
      exitFirstSettled = true;
      return result;
    });
    exitFirstHandle.emitExit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(exitFirstSettled, false, 'PTY exit가 먼저 와도 taskkill 작업 완료 전에 ACK하면 안 됩니다.');
    exitFirstTaskkill.emit('exit', 0);
    assert.deepStrictEqual(await exitFirstCompletion, { ok: true, exited: true, taskkill: true });
    assert.equal(exitFirstHandle.killed, false);

    const exitedNonzeroHandle = new FakePty(8_809);
    const exitedNonzeroTaskkill = new EventEmitter();
    exitedNonzeroTaskkill.unref = () => {};
    exitedNonzeroTaskkill.kill = () => {};
    const exitedNonzeroCompletion = killPtyTree(exitedNonzeroHandle, 8_809, 100, {
      platform: 'win32',
      spawnChild: () => exitedNonzeroTaskkill,
      processKill: () => {
        const error = new Error('already gone');
        error.code = 'ESRCH';
        throw error;
      },
    });
    exitedNonzeroHandle.emitExit();
    exitedNonzeroTaskkill.emit('exit', 1);
    assert.deepStrictEqual(await exitedNonzeroCompletion, { ok: true, exited: true });
    assert.equal(exitedNonzeroHandle.killed, false, 'PTY가 이미 끝났음을 PID probe로 확인하면 fallback kill을 호출하면 안 됩니다.');

    const nonzeroHandle = new FakePty(8_810);
    const nonzeroTaskkill = new EventEmitter();
    nonzeroTaskkill.unref = () => {};
    nonzeroTaskkill.kill = () => {};
    const nonzeroCompletion = killPtyTree(nonzeroHandle, 8_810, 100, {
      platform: 'win32',
      spawnChild: () => nonzeroTaskkill,
      processKill: () => {},
    });
    const nonzeroRejection = assert.rejects(
      nonzeroCompletion,
      error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED',
    );
    nonzeroTaskkill.emit('exit', 1);
    await nonzeroRejection;
    assert.equal(nonzeroHandle.killed, true);

    const erroredHandle = new FakePty(8_811);
    const erroredTaskkill = new EventEmitter();
    erroredTaskkill.unref = () => {};
    erroredTaskkill.kill = () => {};
    const erroredCompletion = killPtyTree(erroredHandle, 8_811, 100, {
      platform: 'win32',
      spawnChild: () => erroredTaskkill,
      processKill: () => {},
    });
    const erroredRejection = assert.rejects(
      erroredCompletion,
      error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED',
    );
    erroredTaskkill.emit('error', new Error('taskkill unavailable'));
    await erroredRejection;
    assert.equal(erroredHandle.killed, true);

    const timedOutTreeHandle = new FakePty(8_812);
    const timedOutTaskkill = new EventEmitter();
    timedOutTaskkill.unref = () => {};
    timedOutTaskkill.kill = () => {};
    const timedOutTreeCompletion = killPtyTree(timedOutTreeHandle, 8_812, 20, {
      platform: 'win32',
      spawnChild: () => timedOutTaskkill,
      processKill: () => {},
    });
    const timedOutKeepAlive = setTimeout(() => {}, 200);
    try {
      await assert.rejects(
        timedOutTreeCompletion,
        error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED'
          && error.cause?.code === 'TASKKILL_TIMEOUT',
      );
    } finally {
      clearTimeout(timedOutKeepAlive);
    }
    assert.equal(timedOutTreeHandle.killed, true);

    const unconfirmedTaskkillHandle = new FakePty(8_806);
    const unconfirmedTaskkill = new EventEmitter();
    unconfirmedTaskkill.unref = () => {};
    unconfirmedTaskkill.kill = () => {};
    const unconfirmedCompletion = killPtyTree(unconfirmedTaskkillHandle, 8_806, 20, {
      platform: 'win32',
      spawnChild: () => unconfirmedTaskkill,
    });
    unconfirmedTaskkill.emit('exit', 0);
    const taskkillKeepAlive = setTimeout(() => {}, 200);
    try {
      await assert.rejects(
        unconfirmedCompletion,
        error => error.code === 'PTY_EXIT_CONFIRM_TIMEOUT',
      );
    } finally {
      clearTimeout(taskkillKeepAlive);
    }
    assert.equal(unconfirmedTaskkillHandle.killed, false, 'taskkill 성공 ACK 이후 timeout에서도 fallback kill을 호출하면 안 됩니다.');

    const stuckHandle = new FakePty(8_804);
    const stuckManager = new TerminalManager({
      platform: 'win32',
      killTree: (handle, pid) => killPtyTree(handle, pid, 20, {
        platform: 'darwin',
        killProcess: () => {},
      }),
      ptyModule: { spawn: () => stuckHandle },
    });
    const stuckSession = stuckManager.create({ type: 'powershell', cwd: root });
    const keepAlive = setTimeout(() => {}, 200);
    try {
      await assert.rejects(
        stuckManager.retire(stuckSession.id),
        error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED',
      );
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(stuckManager.get(stuckSession.id).status, 'stopping');
    assert.equal(stuckManager.get(stuckSession.id).terminationUncertain, true);
    assert.equal(stuckManager.list().length, 1);
    await assert.rejects(
      stuckManager.retire(stuckSession.id),
      error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED' && error.terminationUncertain === true,
    );
    stuckHandle.emitExit();
    assert.equal(stuckManager.get(stuckSession.id).status, 'stopping');
    assert.throws(
      () => stuckManager.close(stuckSession.id),
      error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED' && error.terminationUncertain === true,
    );
    stuckManager.dispose({ preserveSessions: true });

    const uncertainStore = path.join(temp, 'terminal-tree-exit-uncertain.json');
    const hangingTaskkill = new EventEmitter();
    hangingTaskkill.unref = () => {};
    hangingTaskkill.kill = () => {};
    class ExitOnFallbackPty extends FakePty {
      kill() {
        this.killed = true;
        this.emitExit();
      }
    }
    const uncertainHandle = new ExitOnFallbackPty(8_814);
    let uncertainSpawnCalls = 0;
    const uncertainManager = new TerminalManager({
      platform: 'win32',
      storeFile: uncertainStore,
      killTree: (handle, pid) => killPtyTree(handle, pid, 20, {
        platform: 'win32',
        spawnChild: () => hangingTaskkill,
        processKill: () => {},
      }),
      ptyModule: { spawn: () => {
        uncertainSpawnCalls += 1;
        return uncertainHandle;
      } },
    });
    const uncertainOptions = {
      type: 'agent',
      provider: 'codex',
      cwd: root,
      sessionBackend: 'direct',
      bridgeId: 'codex:tree-uncertain',
      agentConnectionSignature: 'signature:tree-uncertain',
      args: ['resume', 'tree-uncertain'],
      recoveryArgs: ['resume', 'tree-uncertain'],
      reuseBridge: true,
    };
    const uncertainSession = uncertainManager.create(uncertainOptions);
    const uncertainKeepAlive = setTimeout(() => {}, 200);
    try {
      await assert.rejects(
        uncertainManager.retire(uncertainSession.id),
        error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED',
      );
    } finally {
      clearTimeout(uncertainKeepAlive);
    }
    const uncertainRecord = uncertainManager.get(uncertainSession.id);
    assert.equal(uncertainRecord.status, 'stopping');
    assert.equal(uncertainRecord.terminationUncertain, true);
    assert.equal(uncertainRecord.terminationErrorCode, 'PTY_TREE_EXIT_UNCONFIRMED');
    assert.equal(uncertainManager.sessions.get(uncertainSession.id).process, null);
    await assert.rejects(
      uncertainManager.retire(uncertainSession.id),
      error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED' && error.terminationUncertain === true,
    );
    assert.throws(
      () => uncertainManager.close(uncertainSession.id),
      error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED' && error.terminationUncertain === true,
    );
    assert.throws(
      () => uncertainManager.create(uncertainOptions),
      error => error.code === 'AGENT_CONNECTION_RETIRE_IN_PROGRESS',
    );
    assert.throws(
      () => uncertainManager.create({ ...uncertainOptions, reuseBridge: false }),
      error => error.code === 'AGENT_CONNECTION_RETIRE_IN_PROGRESS',
    );
    assert.equal(uncertainSpawnCalls, 1, 'reuseBridge=false도 sticky bridge를 우회해 새 provider를 만들면 안 됩니다.');
    uncertainManager.persistNow();
    const persistedUncertain = JSON.parse(fs.readFileSync(uncertainStore, 'utf8')).sessions[0];
    assert.equal(persistedUncertain.status, 'stopping');
    assert.equal(persistedUncertain.terminationUncertain, true);
    assert.equal(persistedUncertain.terminationErrorCode, 'PTY_TREE_EXIT_UNCONFIRMED');
    fs.writeFileSync(uncertainStore, JSON.stringify({
      version: 2,
      sessions: [
        persistedUncertain,
        {
          ...persistedUncertain,
          id: 'terminal:newer-healthy-duplicate',
          status: 'exited',
          updatedAt: new Date(Date.parse(persistedUncertain.updatedAt) + 60_000).toISOString(),
          terminationPending: false,
          terminationIntent: '',
          terminationUncertain: false,
          terminationErrorCode: '',
          terminationErrorMessage: '',
        },
      ],
    }), 'utf8');

    const restoredUncertainManager = new TerminalManager({
      platform: 'win32',
      storeFile: uncertainStore,
      killTree: () => { throw new Error('복원된 uncertainty는 killTree를 재시도하면 안 됩니다.'); },
      ptyModule: { spawn: () => { throw new Error('복원된 uncertainty는 spawn하면 안 됩니다.'); } },
    });
    const restoredUncertain = restoredUncertainManager.get(uncertainSession.id);
    assert.equal(restoredUncertainManager.list().length, 1, 'dedupe는 더 최신인 정상 행보다 sticky marker를 보존해야 합니다.');
    assert.equal(restoredUncertain.status, 'stopping');
    assert.equal(restoredUncertain.terminationUncertain, true);
    await assert.rejects(
      restoredUncertainManager.retire(uncertainSession.id),
      error => error.code === 'PTY_TREE_EXIT_UNCONFIRMED' && error.terminationUncertain === true,
    );
    assert.throws(
      () => restoredUncertainManager.create(uncertainOptions),
      error => error.code === 'AGENT_CONNECTION_RETIRE_IN_PROGRESS',
    );

    const uncertaintySuffix = `${process.pid}-${Date.now()}-uncertain`;
    const uncertaintyDiscovery = path.join(temp, `terminal-host-uncertain-${uncertaintySuffix}.json`);
    const uncertaintyEndpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-uncertain-${uncertaintySuffix}`
      : path.join(os.tmpdir(), `lta-host-uncertain-${uncertaintySuffix}.sock`);
    let uncertaintyShutdowns = 0;
    const uncertaintyServer = new TerminalHostServer({
      manager: restoredUncertainManager,
      endpoint: uncertaintyEndpoint,
      discoveryFile: uncertaintyDiscovery,
      token: 'uncertain-host-token',
      idleShutdownMs: 20,
      onShutdown: () => { uncertaintyShutdowns += 1; },
    });
    const uncertaintyClient = new TerminalHostClient({ discoveryFile: uncertaintyDiscovery });
    try {
      await uncertaintyServer.start();
      await uncertaintyClient.connect();
      const confirmedUncertain = await uncertaintyClient.listFresh();
      await assert.rejects(
        uncertaintyClient.shutdownForUpdate(confirmedUncertain, 1_000),
        /정리 중인 명령창 작업이 끝나지 않았습니다/,
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(uncertaintyClient.connected, true);
      assert.equal(uncertaintyClient.socket.destroyed, false);
      assert.equal(uncertaintyShutdowns, 0, '종료 불확실한 세션이 있으면 호스트를 유지해야 합니다.');
    } finally {
      uncertaintyClient.dispose();
      uncertaintyServer.dispose();
      restoredUncertainManager.dispose({ preserveSessions: true });
      uncertainManager.dispose({ preserveSessions: true });
    }

    let releaseHostShutdown;
    const hostShutdownGate = new Promise(resolve => { releaseHostShutdown = resolve; });
    let hostShutdownKillCalls = 0;
    const hostShutdownStore = path.join(temp, 'terminal-host-confirmed-dispose.json');
    const hostShutdownHandles = [];
    const hostShutdownOptions = {
      platform: 'win32',
      storeFile: hostShutdownStore,
      killTree: () => {
        hostShutdownKillCalls += 1;
        return hostShutdownKillCalls === 1
          ? hostShutdownGate
          : { ok: true, exited: true };
      },
      ptyModule: { spawn: () => {
        const handle = new FakePty(8_900 + hostShutdownHandles.length);
        hostShutdownHandles.push(handle);
        return handle;
      } },
    };
    const hostShutdownManager = new TerminalManager(hostShutdownOptions);
    const hostShutdownSession = hostShutdownManager.create({
      type: 'agent', provider: 'codex', cwd: root,
      bridgeId: 'codex:confirmed-host-shutdown',
      sessionBackend: 'direct',
      args: ['resume', 'confirmed-host-shutdown'],
      recoveryArgs: ['resume', 'confirmed-host-shutdown'],
    });
    let hostShutdownSettled = false;
    const hostShutdown = hostShutdownManager.dispose({ preserveSessions: true });
    hostShutdown.then(() => { hostShutdownSettled = true; }, () => { hostShutdownSettled = true; });
    assert.equal(hostShutdownManager.get(hostShutdownSession.id).status, 'stopping');
    assert.equal(hostShutdownSettled, false);
    assert.equal(hostShutdownKillCalls, 1);
    const persistedHostShutdownPending = JSON.parse(fs.readFileSync(hostShutdownStore, 'utf8')).sessions[0];
    assert.equal(persistedHostShutdownPending.terminationPending, true);
    assert.equal(persistedHostShutdownPending.terminationIntent, 'h');

    releaseHostShutdown({ ok: true, exited: true });
    await hostShutdown;
    assert.equal(hostShutdownSettled, true);
    assert.equal(hostShutdownManager.get(hostShutdownSession.id).status, 'running');
    assert.equal(hostShutdownManager.sessions.get(hostShutdownSession.id).process, null);
    const persistedHostShutdownComplete = JSON.parse(fs.readFileSync(hostShutdownStore, 'utf8')).sessions[0];
    assert.equal(persistedHostShutdownComplete.terminationPending, false);
    assert.equal(persistedHostShutdownComplete.terminationIntent, '');

    const recoveredHostShutdownManager = new TerminalManager(hostShutdownOptions);
    const recoveredHostShutdown = recoveredHostShutdownManager.recoverPersistedSessions();
    assert.equal(recoveredHostShutdown.length, 1);
    assert.equal(recoveredHostShutdown[0].id, hostShutdownSession.id);
    assert.equal(hostShutdownHandles.length, 2, 'tree 종료 ACK 전에는 새 호스트가 resume PTY를 만들면 안 됩니다.');
    assert.equal(recoveredHostShutdownManager.close(hostShutdownSession.id).ok, true);
  });

  test('managed-tmux retire는 비동기 tmux stop이 끝난 뒤에만 레지스트리를 삭제한다', async () => {
    const missingTmuxError = new Error("can't find session: missing");
    missingTmuxError.status = 1;
    missingTmuxError.stderr = "can't find session: missing";
    const missingRuntime = new ManagedTmuxRuntime({
      platform: 'darwin',
      execFileSync: () => { throw missingTmuxError; },
    });
    missingRuntime.available = () => true;
    assert.equal(missingRuntime.existsStrict({ tmuxSocket: 'test', managedTmuxSession: 'missing' }), false);
    assert.deepStrictEqual(missingRuntime.stopStrict({ tmuxSocket: 'test', managedTmuxSession: 'missing' }), { ok: true });
    const infrastructureError = new Error('WSL 배포판을 찾을 수 없습니다.');
    infrastructureError.status = 1;
    infrastructureError.stderr = 'There is no distribution with the supplied name.';
    const unavailableRuntime = new ManagedTmuxRuntime({
      platform: 'win32',
      execFileSync: () => { throw infrastructureError; },
    });
    unavailableRuntime.available = () => true;
    assert.throws(
      () => unavailableRuntime.existsStrict({ distro: 'Missing', tmuxSocket: 'test', managedTmuxSession: 'missing' }),
      error => error === infrastructureError,
    );
    assert.throws(
      () => unavailableRuntime.stopStrict({ distro: 'Missing', tmuxSocket: 'test', managedTmuxSession: 'missing' }),
      error => error === infrastructureError,
    );

    let releaseKill;
    let releaseStop;
    let stopCalls = 0;
    const killGate = new Promise(resolve => { releaseKill = resolve; });
    const stopGate = new Promise(resolve => { releaseStop = resolve; });
    class FakePty {
      constructor() { this.pid = 8_802; this.exitCallbacks = new Set(); }
      onData() {}
      onExit(callback) { this.exitCallbacks.add(callback); }
      write() {}
      resize() {}
      kill() {}
      emitExit(event = { exitCode: 0, signal: 0 }) {
        for (const callback of [...this.exitCallbacks]) callback(event);
      }
    }
    const processHandle = new FakePty();
    const manager = new TerminalManager({
      platform: 'darwin',
      killTree: () => killGate,
      managedTmuxRuntime: {
        exists: () => true,
        stop: () => {
          stopCalls += 1;
          return stopGate;
        },
      },
      ptyModule: { spawn: () => processHandle },
    });
    const session = manager.create({ type: 'agent', provider: 'codex', cwd: root });
    let settled = false;
    const retiring = manager.retire(session.id);
    retiring.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();

    processHandle.emitExit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.get(session.id).status, 'stopping', 'PTY exit 뒤에도 tree/tmux 정리가 끝날 때까지 stopping이어야 합니다.');
    assert.equal(stopCalls, 0);
    assert.equal(settled, false);

    releaseKill({ ok: true, exited: true });
    assert.equal(await waitUntil(() => stopCalls === 1), true);
    assert.equal(stopCalls, 1);
    assert.equal(settled, false);
    assert.equal(manager.get(session.id).status, 'stopping');

    releaseStop({ ok: true });
    assert.deepStrictEqual(await retiring, { ok: true });
    assert.equal(settled, true);
    assert.equal(manager.get(session.id), null);

    const missingDetachHandle = new FakePty();
    const missingDetachManager = new TerminalManager({
      platform: 'darwin',
      killTree: () => ({ ok: true, exited: true }),
      managedTmuxRuntime: missingRuntime,
      ptyModule: { spawn: () => missingDetachHandle },
    });
    const missingDetachSession = missingDetachManager.create({
      type: 'agent', provider: 'codex', cwd: root,
      sessionBackend: 'managed-tmux', managedTmuxSession: 'missing',
    });
    assert.equal(missingDetachManager.detach(missingDetachSession.id).status, 'stopped');
    assert.deepStrictEqual(missingDetachManager.close(missingDetachSession.id), { ok: true });

    const unavailableDetachHandle = new FakePty();
    const unavailableDetachManager = new TerminalManager({
      platform: 'darwin',
      killTree: () => ({ ok: true, exited: true }),
      managedTmuxRuntime: unavailableRuntime,
      ptyModule: { spawn: () => unavailableDetachHandle },
    });
    const unavailableDetachSession = unavailableDetachManager.create({
      type: 'agent', provider: 'codex', cwd: root,
      sessionBackend: 'managed-tmux', managedTmuxSession: 'unavailable',
    });
    assert.throws(
      () => unavailableDetachManager.detach(unavailableDetachSession.id),
      error => error === infrastructureError,
    );
    assert.equal(unavailableDetachManager.get(unavailableDetachSession.id).status, 'stopping');
    assert.equal(unavailableDetachManager.get(unavailableDetachSession.id).terminationUncertain, true);
    assert.throws(
      () => unavailableDetachManager.close(unavailableDetachSession.id),
      error => error.code === 'TERMINATION_UNCERTAIN' && error.terminationUncertain === true,
    );
    unavailableDetachManager.dispose({ preserveSessions: true });

    const unavailableExitHandle = new FakePty();
    const unavailableExitManager = new TerminalManager({
      platform: 'darwin',
      killTree: () => ({ ok: true, exited: true }),
      managedTmuxRuntime: unavailableRuntime,
      ptyModule: { spawn: () => unavailableExitHandle },
    });
    const unavailableExitSession = unavailableExitManager.create({
      type: 'agent', provider: 'codex', cwd: root,
      sessionBackend: 'managed-tmux', managedTmuxSession: 'unavailable-exit',
    });
    unavailableExitHandle.emitExit();
    assert.equal(unavailableExitManager.get(unavailableExitSession.id).status, 'stopping');
    assert.equal(unavailableExitManager.get(unavailableExitSession.id).terminationUncertain, true);
    assert.equal(unavailableExitManager.get(unavailableExitSession.id).terminationErrorCode, 'MANAGED_SESSION_STATE_UNCONFIRMED');

    let reconnectInfrastructureUnavailable = false;
    const reconnectHandle = new FakePty();
    const reconnectManager = new TerminalManager({
      platform: 'darwin',
      killTree: () => ({ ok: true, exited: true }),
      managedTmuxRuntime: {
        existsStrict: () => {
          if (reconnectInfrastructureUnavailable) throw infrastructureError;
          return true;
        },
        stopStrict: () => ({ ok: true }),
      },
      ptyModule: { spawn: () => reconnectHandle },
    });
    const reconnectSession = reconnectManager.create({
      type: 'agent', provider: 'codex', cwd: root,
      sessionBackend: 'managed-tmux', managedTmuxSession: 'unavailable-reconnect',
    });
    assert.equal(reconnectManager.detach(reconnectSession.id).status, 'detached');
    reconnectInfrastructureUnavailable = true;
    assert.throws(
      () => reconnectManager.reconnect(reconnectSession.id),
      error => error.code === 'MANAGED_SESSION_STATE_UNCONFIRMED',
    );
    assert.equal(reconnectManager.get(reconnectSession.id).status, 'stopping');
    assert.equal(reconnectManager.get(reconnectSession.id).terminationUncertain, true);

    const recoveryStore = path.join(temp, 'managed-infrastructure-recovery.json');
    const recoverySourceHandle = new FakePty();
    const recoverySourceManager = new TerminalManager({
      platform: 'darwin',
      storeFile: recoveryStore,
      killTree: () => ({ ok: true, exited: true }),
      managedTmuxRuntime: { existsStrict: () => true, stopStrict: () => ({ ok: true }) },
      ptyModule: { spawn: () => recoverySourceHandle },
    });
    const recoverySourceSession = recoverySourceManager.create({
      type: 'agent', provider: 'codex', cwd: root,
      sessionBackend: 'managed-tmux', managedTmuxSession: 'unavailable-recovery',
    });
    recoverySourceManager.persistNow();
    const unavailableRecoveryManager = new TerminalManager({
      platform: 'darwin',
      storeFile: recoveryStore,
      killTree: () => ({ ok: true, exited: true }),
      managedTmuxRuntime: unavailableRuntime,
      ptyModule: { spawn: () => { throw new Error('인프라 오류를 missing으로 오판해 attach하면 안 됩니다.'); } },
    });
    assert.deepStrictEqual(unavailableRecoveryManager.recoverPersistedSessions(), []);
    assert.equal(unavailableRecoveryManager.get(recoverySourceSession.id).status, 'stopping');
    assert.equal(unavailableRecoveryManager.get(recoverySourceSession.id).terminationUncertain, true);
    assert.equal(unavailableRecoveryManager.get(recoverySourceSession.id).terminationErrorCode, 'MANAGED_SESSION_STATE_UNCONFIRMED');

    let generationConflictManager;
    const generationConflictHandle = new FakePty();
    generationConflictManager = new TerminalManager({
      platform: 'darwin',
      killTree: () => {
        const record = generationConflictManager.sessions.get(generationConflictSession.id);
        record.process = null;
        record.generation += 1;
        return { ok: true, exited: true };
      },
      managedTmuxRuntime: unavailableRuntime,
      ptyModule: { spawn: () => generationConflictHandle },
    });
    const generationConflictSession = generationConflictManager.create({
      type: 'agent', provider: 'codex', cwd: root,
      sessionBackend: 'managed-tmux', managedTmuxSession: 'unavailable-fail-transition',
    });
    assert.throws(
      () => generationConflictManager.kill(generationConflictSession.id),
      error => error.code === 'MANAGED_SESSION_STATE_UNCONFIRMED',
    );
    assert.equal(generationConflictManager.get(generationConflictSession.id).status, 'stopping');
    assert.equal(generationConflictManager.get(generationConflictSession.id).terminationUncertain, true);

    const legacyManagedStore = path.join(temp, 'managed-legacy-stopped-reconcile.json');
    const legacyNow = '2026-08-05T00:00:00.000Z';
    const legacyManagedRecord = (id, bridgeId, managedTmuxSession, status = 'stopped', offset = 0) => ({
      id,
      options: {
        type: 'agent', provider: 'codex', cwd: root,
        sessionBackend: 'managed-tmux', bridgeId, managedTmuxSession,
      },
      status,
      createdAt: new Date(Date.parse(legacyNow) + offset).toISOString(),
      updatedAt: new Date(Date.parse(legacyNow) + offset).toISOString(),
      replay: '',
    });
    fs.writeFileSync(legacyManagedStore, JSON.stringify({
      version: 2,
      sessions: [
        legacyManagedRecord('terminal:legacy-live', 'codex:legacy-live', 'legacy-live'),
        legacyManagedRecord('terminal:legacy-missing', 'codex:legacy-missing', 'legacy-missing'),
        legacyManagedRecord('terminal:legacy-failed-live', 'codex:legacy-failed-live', 'legacy-failed-live', 'failed'),
        legacyManagedRecord('terminal:legacy-reclaim-live', 'codex:legacy-reclaim-live', 'legacy-reclaim-live'),
      ],
    }), 'utf8');
    const legacyStops = [];
    const legacyLiveSessions = new Set(['legacy-live', 'legacy-failed-live', 'legacy-reclaim-live']);
    const legacyManager = new TerminalManager({
      platform: 'darwin',
      storeFile: legacyManagedStore,
      managedTmuxRuntime: {
        existsStrict: options => legacyLiveSessions.has(options.managedTmuxSession),
        stopStrict: options => { legacyStops.push(options.managedTmuxSession); return { ok: true }; },
      },
    });
    assert.equal(legacyManager.get('terminal:legacy-live').status, 'detached');
    assert.equal(legacyManager.get('terminal:legacy-missing').status, 'stopped');
    assert.equal(legacyManager.get('terminal:legacy-failed-live').status, 'detached');
    assert.equal(legacyManager.get('terminal:legacy-reclaim-live').status, 'detached');
    assert.throws(
      () => legacyManager.create({
        type: 'agent', provider: 'codex', cwd: root,
        sessionBackend: 'managed-tmux', bridgeId: 'codex:legacy-live',
        managedTmuxSession: 'legacy-live-new', reuseBridge: false,
      }),
      error => error.code === 'AGENT_CONNECTION_ALREADY_ACTIVE',
    );
    legacyLiveSessions.add('legacy-missing');
    assert.throws(
      () => legacyManager.create({
        type: 'agent', provider: 'codex', cwd: root,
        sessionBackend: 'managed-tmux', bridgeId: 'codex:legacy-missing',
        managedTmuxSession: 'legacy-missing-new', reuseBridge: false,
      }),
      error => error.code === 'AGENT_CONNECTION_ALREADY_ACTIVE',
    );
    assert.equal(legacyManager.get('terminal:legacy-missing').status, 'detached');
    legacyManager.sessions.get('terminal:legacy-reclaim-live').status = 'stopped';
    legacyManager.reclaimFinishedSessions(100);
    assert.equal(legacyManager.get('terminal:legacy-reclaim-live').status, 'detached');

    const livePreferredStore = path.join(temp, 'managed-dedupe-live-preferred.json');
    fs.writeFileSync(livePreferredStore, JSON.stringify({
      version: 2,
      sessions: [
        legacyManagedRecord('terminal:older-live', 'codex:managed-dedupe', 'older-live', 'stopped', 0),
        legacyManagedRecord('terminal:newer-missing', 'codex:managed-dedupe', 'newer-missing', 'stopped', 60_000),
      ],
    }), 'utf8');
    const livePreferredStops = [];
    const livePreferredManager = new TerminalManager({
      platform: 'darwin',
      storeFile: livePreferredStore,
      managedTmuxRuntime: {
        existsStrict: options => options.managedTmuxSession === 'older-live',
        stopStrict: options => { livePreferredStops.push(options.managedTmuxSession); return { ok: true }; },
      },
    });
    assert.deepStrictEqual(livePreferredManager.list().map(item => item.id), ['terminal:older-live']);
    assert.deepStrictEqual(livePreferredStops, [], 'newer missing 기록을 남기려고 실제 live tmux를 종료하면 안 됩니다.');

    const bothLiveStore = path.join(temp, 'managed-dedupe-both-live.json');
    fs.writeFileSync(bothLiveStore, JSON.stringify({
      version: 2,
      sessions: [
        legacyManagedRecord('terminal:older-live-duplicate', 'codex:managed-both-live', 'older-live-duplicate', 'detached', 0),
        legacyManagedRecord('terminal:newer-live-survivor', 'codex:managed-both-live', 'newer-live-survivor', 'detached', 60_000),
      ],
    }), 'utf8');
    const bothLiveStops = [];
    const bothLiveManager = new TerminalManager({
      platform: 'darwin',
      storeFile: bothLiveStore,
      managedTmuxRuntime: {
        existsStrict: () => true,
        stopStrict: options => { bothLiveStops.push(options.managedTmuxSession); return { ok: true }; },
      },
    });
    assert.deepStrictEqual(bothLiveManager.list().map(item => item.id), [
      'terminal:older-live-duplicate',
      'terminal:newer-live-survivor',
    ]);
    assert.equal(bothLiveManager.list().every(item => item.terminationUncertain), true);
    assert.equal(bothLiveManager.list().every(item => item.terminationErrorCode === 'AGENT_CONNECTION_DUPLICATE_LIVE_UNCONFIRMED'), true);
    assert.deepStrictEqual(bothLiveStops, [], 'startup 생성자에서 비동기 retire를 시작하거나 live tmux를 임의 종료하면 안 됩니다.');

    const unknownDedupeStore = path.join(temp, 'managed-dedupe-probe-unknown.json');
    fs.writeFileSync(unknownDedupeStore, JSON.stringify({
      version: 2,
      sessions: [
        legacyManagedRecord('terminal:unknown-one', 'codex:managed-unknown', 'unknown-one', 'detached', 0),
        legacyManagedRecord('terminal:unknown-two', 'codex:managed-unknown', 'unknown-two', 'detached', 60_000),
      ],
    }), 'utf8');
    const unknownDedupeManager = new TerminalManager({
      platform: 'darwin',
      storeFile: unknownDedupeStore,
      managedTmuxRuntime: {
        existsStrict: options => {
          if (options.managedTmuxSession === 'unknown-one') throw infrastructureError;
          return true;
        },
        stopStrict: () => { throw new Error('probe 불확실 상태에서 어느 tmux도 종료하면 안 됩니다.'); },
      },
    });
    assert.equal(unknownDedupeManager.list().length, 2);
    assert.equal(unknownDedupeManager.list().every(item => item.terminationUncertain), true);
    assert.throws(
      () => unknownDedupeManager.create({
        type: 'agent', provider: 'codex', cwd: root,
        sessionBackend: 'managed-tmux', bridgeId: 'codex:managed-unknown',
        managedTmuxSession: 'unknown-new', reuseBridge: false,
      }),
      error => error.code === 'AGENT_CONNECTION_RETIRE_IN_PROGRESS',
    );

    unavailableExitManager.dispose({ preserveSessions: true });
    reconnectManager.dispose({ preserveSessions: true });
    unavailableRecoveryManager.dispose({ preserveSessions: true });
    recoverySourceManager.close(recoverySourceSession.id);
    generationConflictManager.dispose({ preserveSessions: true });
    legacyManager.close('terminal:legacy-live');
    legacyManager.close('terminal:legacy-missing');
    legacyManager.close('terminal:legacy-failed-live');
    legacyManager.close('terminal:legacy-reclaim-live');
    livePreferredManager.close('terminal:older-live');
    bothLiveManager.dispose({ preserveSessions: true });
    unknownDedupeManager.dispose({ preserveSessions: true });
  });

  test('터미널 호스트 프로토콜이 prompt response·detach·reconnect·stop 생명주기를 전달한다', async () => {
    class FakeManager extends EventEmitter {
      constructor() { super(); this.calls = []; }
      list() { return []; }
      create(options) {
        this.calls.push(['create', options]);
        const error = new Error('생성 장부를 저장하지 못해 시작하지 않음');
        error.code = 'CREATION_LEDGER_UNAVAILABLE';
        error.creationId = options.creationId;
        error.creationState = 'rejected';
        error.deliveryId = options.deliveryId;
        error.deliveryState = 'rejected';
        throw error;
      }
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
      bindAgentSession(id, binding) {
        this.calls.push(['bindAgentSession', id, binding]);
        return { id, conversationBound: true, agentLinkedSessionId: binding.sessionId };
      }
      respond(id, choiceKey) { this.calls.push(['respond', id, choiceKey]); return { ok: true }; }
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
      const createOptions = { type: 'agent', provider: 'codex', creationId: 'create:host:rejected', deliveryId: 'delivery:host:create' };
      await assert.rejects(
        client.create(createOptions),
        error => error.code === 'CREATION_LEDGER_UNAVAILABLE'
          && error.creationId === createOptions.creationId
          && error.creationState === 'rejected'
          && error.deliveryId === createOptions.deliveryId
          && error.deliveryState === 'rejected',
      );
      const binding = { sessionId: 'codex:history-1', promptFingerprint: 'a'.repeat(64) };
      assert.equal((await client.bindAgentSession('terminal:managed', binding)).agentLinkedSessionId, 'codex:history-1');
      assert.equal((await client.respond('terminal:managed', 'y')).ok, true);
      assert.equal((await client.detach('terminal:managed')).status, 'detached');
      assert.equal((await client.reconnect('terminal:managed')).status, 'running');
      assert.equal((await client.stop('terminal:managed')).status, 'stopped');
      assert.deepStrictEqual(manager.calls, [
        ['command', 'terminal:managed', '한 번만 보내기', { deliveryId: 'delivery:host:1' }],
        ['command', 'terminal:managed', '보내기 전 거절', { deliveryId: 'delivery:host:rejected' }],
        ['create', createOptions],
        ['bindAgentSession', 'terminal:managed', binding],
        ['respond', 'terminal:managed', 'y'],
        ['detach', 'terminal:managed'],
        ['reconnect', 'terminal:managed'],
        ['stop', 'terminal:managed'],
      ]);
    } finally {
      client.dispose();
      server.dispose();
    }

    class BackpressureSocket extends EventEmitter {
      constructor({ blockFirstWrite = true } = {}) {
        super();
        this.blockNextWrite = blockFirstWrite;
        this.destroyed = false;
        this.destroyError = null;
        this.frames = [];
        this.writableLength = 0;
        this.ended = false;
        this.endCalls = 0;
      }
      setNoDelay() {}
      write(frame) {
        const copied = Buffer.from(frame);
        this.frames.push(copied);
        if (!this.blockNextWrite) return true;
        this.blockNextWrite = false;
        this.writableLength = copied.length;
        return false;
      }
      releaseBackpressure() {
        this.writableLength = 0;
        this.emit('drain');
      }
      end() {
        this.ended = true;
        this.endCalls += 1;
      }
      destroy(error = null) {
        this.destroyed = true;
        this.destroyError = error;
      }
    }

    const queuedServer = new TerminalHostServer({
      manager,
      discoveryFile: path.join(temp, 'terminal-host-backpressure-queue.json'),
      token: 'backpressure-token',
      maxOutboundQueueBytes: 4_096,
    });
    const queuedSocket = new BackpressureSocket();
    queuedServer.accept(queuedSocket);
    const queuedClient = [...queuedServer.clients][0];
    await queuedServer.handle(queuedClient, { type: 'authenticate', token: 'backpressure-token' });
    queuedServer.broadcast({ type: 'event', event: 'data', payload: { id: 'terminal:queue', data: 'first' } });
    queuedServer.broadcast({ type: 'event', event: 'state', payload: { sessions: [] } });
    await queuedServer.handle(queuedClient, { type: 'request', operation: 'list', requestId: 'queued-list', args: [] });
    assert.equal(queuedSocket.frames.length, 1,
      'socket.write가 false를 반환한 뒤에는 drain 전에 다음 프레임을 쓰면 안 됩니다.');
    queuedSocket.releaseBackpressure();
    const queuedFrames = queuedSocket.frames.map(frame => JSON.parse(frame.toString('utf8')));
    assert.deepStrictEqual(queuedFrames.map(frame => [frame.type, frame.event || frame.requestId || '']), [
      ['ready', ''],
      ['event', 'data'],
      ['event', 'state'],
      ['response', 'queued-list'],
    ], 'ready/data/state/response는 backpressure 뒤에도 FIFO 순서를 유지해야 합니다.');
    queuedServer.dispose();

    const unauthenticatedServer = new TerminalHostServer({
      manager,
      discoveryFile: path.join(temp, 'terminal-host-auth-fail-close.json'),
      token: 'auth-fail-close-token',
      maxOutboundQueueBytes: 4_096,
    });
    const unauthenticatedSocket = new BackpressureSocket();
    unauthenticatedServer.accept(unauthenticatedSocket);
    const unauthenticatedClient = [...unauthenticatedServer.clients][0];
    const callsBeforeRejectedAuthentication = manager.calls.length;
    unauthenticatedServer.consume(unauthenticatedClient, Buffer.from([
      JSON.stringify({ type: 'authenticate', token: 'wrong-token' }),
      JSON.stringify({ type: 'authenticate', token: 'auth-fail-close-token' }),
      JSON.stringify({ type: 'request', operation: 'create', requestId: 'must-not-create', args: [{}] }),
      '',
    ].join('\n'), 'utf8'));
    await unauthenticatedClient.queue;
    assert.equal(manager.calls.length, callsBeforeRejectedAuthentication,
      '인증 실패 뒤 같은 chunk의 유효한 authenticate/create를 실행하면 보이지 않는 PTY가 생깁니다.');
    assert.equal(unauthenticatedClient.authenticated, false);
    assert.deepStrictEqual(
      unauthenticatedSocket.frames.map(frame => JSON.parse(frame.toString('utf8')).type),
      ['response'],
    );
    assert.equal(unauthenticatedSocket.ended, false,
      '인증 오류 응답이 backpressure로 대기 중일 때 socket을 먼저 닫으면 안 됩니다.');
    unauthenticatedSocket.releaseBackpressure();
    assert.equal(unauthenticatedSocket.ended, true);
    assert.equal(unauthenticatedSocket.endCalls, 1);
    unauthenticatedSocket.releaseBackpressure();
    assert.equal(unauthenticatedSocket.endCalls, 1, '늦은 drain이 socket.end를 중복 호출하면 안 됩니다.');
    unauthenticatedServer.dispose();

    const overflowServer = new TerminalHostServer({
      manager,
      discoveryFile: path.join(temp, 'terminal-host-backpressure-overflow.json'),
      token: 'overflow-token',
      maxOutboundQueueBytes: 256,
    });
    const overflowSocket = new BackpressureSocket();
    overflowServer.accept(overflowSocket);
    const overflowClient = [...overflowServer.clients][0];
    await overflowServer.handle(overflowClient, { type: 'authenticate', token: 'overflow-token' });
    overflowServer.broadcast({
      type: 'event', event: 'data', payload: { id: 'terminal:overflow', data: 'x'.repeat(512) },
    });
    assert.equal(overflowSocket.destroyed, true,
      'bounded queue 상한을 넘긴 느린 클라이언트는 reconnect/replay가 복원하도록 연결을 닫아야 합니다.');
    assert.equal(overflowSocket.destroyError?.code, 'TERMINAL_HOST_CLIENT_BACKPRESSURE_OVERFLOW');
    assert.equal(overflowClient.outboundQueue.length, 0);
    overflowServer.dispose();
  });

  test('macOS 패키지는 터미널 호스트를 숨김 Helper 실행 파일로 연다', () => {
    const executable = '/Applications/LoadToAgent.app/Contents/MacOS/LoadToAgent';
    const helper = '/Applications/LoadToAgent.app/Contents/Frameworks/LoadToAgent Helper.app/Contents/MacOS/LoadToAgent Helper';
    const fileSystem = { existsSync: file => file === helper };
    assert.equal(resolveTerminalHostExecutable({ platform: 'darwin', isPackaged: true, executable, fileSystem }), helper);
    assert.equal(resolveTerminalHostExecutable({ platform: 'darwin', isPackaged: false, executable, fileSystem }), executable);
    assert.equal(resolveTerminalHostExecutable({ platform: 'win32', isPackaged: true, executable, fileSystem }), executable);
  });

  test('PTY 터미널을 만들고 입력·명령·리사이즈·신호·재시작·종료를 제어한다', async () => {
    const processes = [];
    const spawnOptions = [];
    const storeFile = path.join(temp, 'terminal-sessions-lifecycle.json');
    const lifecycleFileSystem = Object.create(fs);
    let transientRenameFailures = 1;
    lifecycleFileSystem.renameSync = (source, destination) => {
      if (destination === storeFile && transientRenameFailures > 0) {
        transientRenameFailures -= 1;
        const error = new Error('simulated transient Windows scanner lock');
        error.code = 'EPERM';
        throw error;
      }
      return fs.renameSync(source, destination);
    };
    class FakePty {
      constructor(pid) { this.pid = pid; this.writes = []; this.resizes = []; this.killed = false; }
      onData(callback) { this.dataCallback = callback; }
      onExit(callback) { this.exitCallback = callback; }
      write(value) { this.writes.push(value); }
      resize(cols, rows) { this.resizes.push([cols, rows]); }
      clear() { this.cleared = true; }
      kill() { this.killed = true; }
    }
    const managerOptions = { platform: 'darwin', storeFile, fileSystem: lifecycleFileSystem, killTree: handle => handle.kill(), managedTmuxRuntime: {
      exists: () => true,
      stop: () => ({ ok: true }),
    }, ptyModule: { spawn: (...args) => {
      const processHandle = new FakePty(9000 + processes.length);
      processes.push(processHandle);
      spawnOptions.push(args[2]);
      return processHandle;
    } } };
    let manager = new TerminalManager(managerOptions);
    assert.equal(transientRenameFailures, 1);
    const outputSequences = [];
    manager.on('data', payload => outputSequences.push(payload.outputSequence));
    const session = manager.create({ type: 'powershell', cwd: root, cols: 100, rows: 30 });
    assert.equal(transientRenameFailures, 0, '일시적인 저장 파일 잠금은 제한된 재시도로 복구해야 합니다.');
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
    assert.equal(manager.get(session.id).outputSequence, 1);
    assert.deepStrictEqual(outputSequences, [1]);
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
    assert.equal(manager.get(session.id).outputSequence, 1);
    const restarted = manager.restart(session.id);
    assert.equal(processes[0].killed, false);
    assert.equal(restarted.pid, 9001);
    assert.equal(restarted.replay, '');
    assert.equal(restarted.outputSequence, 1, 'restart 뒤에도 output sequence를 재설정하면 안 됩니다.');
    processes[1].dataCallback('PTY_AFTER_RESTART');
    assert.equal(manager.get(session.id).outputSequence, 2);
    manager.close(session.id);
    assert.equal(processes[1].killed, true);
    assert.equal(manager.list().length, 0);
    const backgroundAgent = manager.create({ type: 'agent', provider: 'codex', cwd: root });
    assert.equal(backgroundAgent.background, true);
    await manager.dispose({ preserveSessions: true });
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
    const normalizedMacTmux = normalizeLaunchOptions({ type: 'tmux', tmuxSession: 'work' }, 'darwin');
    assert.equal(normalizedMacTmux.distro, '');
    assert.equal(normalizeLaunchOptions({ type: 'tmux', tmuxSession: 'work' }, 'linux').distro, '');
    assert.throws(
      () => normalizeLaunchOptions({ type: 'tmux', tmuxSession: 'work' }, 'win32'),
      /Linux 환경을 선택/,
    );
    assert.throws(() => normalizeLaunchOptions({ type: 'wsl' }, 'win32'), /Linux 환경을 선택/);
    const macTmux = launchSpec(normalizedMacTmux, 'darwin', undefined, { env: { SHELL: '/broken/login-shell' }, fileSystem: posixFs });
    assert.notEqual(macTmux.file, 'wsl.exe');
    assert.equal(macTmux.file, '/bin/zsh');
    const exactTmux = launchSpec(normalizeLaunchOptions({
      type: 'tmux',
      distro: 'Ubuntu',
      tmuxSession: 'work',
      tmuxWindow: '@7',
      tmuxPane: '%19',
      tmuxPanePid: 4190,
    }, 'win32'), 'win32');
    assert.equal(exactTmux.file, process.execPath);
    assert.equal(path.basename(exactTmux.args[0]), 'tmuxControlProxy.js');
    assert.equal(exactTmux.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(exactTmux.exactPaneProxy, true);
    const exactTmuxProxy = JSON.parse(Buffer.from(exactTmux.args[1], 'base64url').toString('utf8'));
    assert.equal(exactTmuxProxy.distro, 'Ubuntu');
    assert.equal(exactTmuxProxy.session, 'work');
    assert.equal(exactTmuxProxy.window, '@7');
    assert.equal(exactTmuxProxy.pane, '%19');
    assert.equal(exactTmuxProxy.panePid, 4190);
    assert.equal(exactTmuxProxy.channel, exactTmux.proxyChannel);
    assert.equal(exactTmuxProxy.readyMarker, exactTmux.readyMarker);
    const localizedExactTmux = launchSpec(normalizeLaunchOptions({
      type: 'tmux',
      distro: 'Ubuntu',
      tmuxSession: '한글 작업 세션',
      tmuxSessionId: '$71',
      tmuxWindow: '@72',
      tmuxPane: '%73',
      tmuxPanePid: 4_191,
    }, 'win32'), 'win32');
    const localizedPayload = parseLaunchPayload(localizedExactTmux.args[1]);
    assert.equal(localizedPayload.session, '한글 작업 세션');
    assert.equal(localizedPayload.sessionId, '$71');
    assert.throws(() => launchSpec(normalizeLaunchOptions({
      type: 'tmux', distro: 'Ubuntu', tmuxSession: 'work', tmuxPane: '%20', tmuxPanePid: 4200,
    }, 'win32'), 'win32'), /window/);
    manager.dispose();
  });

  test('exact tmux 대화 명령은 proxy의 원자적 ACK 전까지 전달 완료로 표시하지 않는다', async () => {
    class FakePty {
      constructor() {
        this.pid = 9_490;
        this.writes = [];
        this.dataHandler = () => {};
        this.exitHandler = () => {};
      }
      onData(handler) { this.dataHandler = handler; }
      onExit(handler) { this.exitHandler = handler; }
      write(value) { this.writes.push(String(value)); }
      resize() {}
      kill() {}
    }
    const processHandle = new FakePty();
    const manager = new TerminalManager({
      platform: 'win32',
      killTree: () => ({ ok: true }),
      ptyModule: { spawn: () => processHandle },
      tmuxControlProxyFactory: () => processHandle,
      tmuxProxyDeliveryTimeoutMs: 10,
      tmuxProxyDeliveryRecoveryGraceMs: 30,
      tmuxProxyLargeDeliveryTimeoutMs: 20,
    });
    const created = manager.create({
      type: 'tmux', distro: 'Ubuntu', tmuxSession: 'work', tmuxSessionId: '$7', tmuxWindow: '@8', tmuxPane: '%9', tmuxPanePid: 4900,
    });
    const internal = manager.sessions.get(created.id);
    processHandle.dataHandler(`${internal.spec.readyMarker}\r\n`);
    assert.equal(manager.get(created.id).status, 'running');

    let settled = false;
    const acceptedPromise = manager.command(created.id, '한 번만 전달', { deliveryId: 'delivery:proxy:accepted' })
      .then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'tmux control ACK 전에 accepted를 반환하면 안 됩니다.');
    const commandFrame = processHandle.writes.at(-1);
    const encodedCommand = commandFrame.match(/^LTA_PROXY_CMD_[^;]+;([^\r]+)\r$/u)?.[1];
    const request = JSON.parse(Buffer.from(encodedCommand, 'base64url').toString('utf8'));
    assert.equal(request.command, '한 번만 전달');
    const acceptedAck = `LTA_PROXY_ACK_${internal.spec.proxyChannel};${request.requestId};accepted;\n`;
    processHandle.dataHandler(acceptedAck.slice(0, 17));
    processHandle.dataHandler(acceptedAck.slice(17));
    const accepted = await acceptedPromise;
    assert.equal(accepted.deliveryState, 'accepted');
    assert.equal(manager.get(created.id, true).replay.includes('LTA_PROXY_ACK_'), false, 'proxy ACK 제어 프레임을 xterm에 노출하면 안 됩니다.');

    const gracePromise = manager.command(created.id, '이벤트 루프 복구 뒤 전달', { deliveryId: 'delivery:proxy:grace' });
    const graceFrame = processHandle.writes.at(-1);
    const encodedGrace = graceFrame.match(/^LTA_PROXY_CMD_[^;]+;([^\r]+)\r$/u)?.[1];
    const graceRequest = JSON.parse(Buffer.from(encodedGrace, 'base64url').toString('utf8'));
    await new Promise(resolve => setTimeout(resolve, 25));
    processHandle.dataHandler(`LTA_PROXY_ACK_${internal.spec.proxyChannel};${graceRequest.requestId};accepted;\n`);
    const graceAccepted = await gracePromise;
    assert.equal(graceAccepted.deliveryState, 'accepted', 'deadline 직후 buffered ACK를 unknown으로 오판하면 안 됩니다.');

    const rejectedPromise = manager.command(created.id, '바뀐 pane에는 금지', { deliveryId: 'delivery:proxy:rejected' });
    const rejectedFrame = processHandle.writes.at(-1);
    const encodedRejected = rejectedFrame.match(/^LTA_PROXY_CMD_[^;]+;([^\r]+)\r$/u)?.[1];
    const rejectedRequest = JSON.parse(Buffer.from(encodedRejected, 'base64url').toString('utf8'));
    const reason = Buffer.from('pane PID가 변경되었습니다.', 'utf8').toString('base64url');
    processHandle.dataHandler(`LTA_PROXY_ACK_${internal.spec.proxyChannel};${rejectedRequest.requestId};rejected;${reason}\r\n`);
    await assert.rejects(rejectedPromise, error => error.code === 'TMUX_EXACT_TARGET_CHANGED'
      && error.deliveryState === 'rejected' && /PID/.test(error.message));
    await manager.dispose();
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

    const promptAfterSpawnRequest = {
      type: 'agent', provider: 'claude', cwd: root,
      bridgeId: 'claude:prompt-after-spawn', sessionBackend: 'direct',
      args: ['--resume', 'prompt-after-spawn'],
      recoveryArgs: ['--resume', 'prompt-after-spawn'],
      initialCommand: 'PTY가 열린 뒤 보낼 질문', initialCommandInArgs: false,
      deliveryId: 'delivery:prompt-after-spawn:rejected',
    };
    const promptAfterSpawnManager = new TerminalManager({
      platform: 'win32',
      killTree: () => {},
      ptyModule: { spawn: () => { throw new Error('prompt-free PTY missing'); } },
    });
    assert.throws(
      () => promptAfterSpawnManager.create(promptAfterSpawnRequest),
      error => error.deliveryState === 'rejected'
        && error.deliveryId === 'delivery:prompt-after-spawn:rejected'
        && error.terminalProcessStarted === false,
    );
    promptAfterSpawnManager.dispose();

    const promptAfterStartedManager = new TerminalManager({
      platform: 'win32',
      killTree: () => {},
      ptyModule: { spawn: () => ({
        pid: 11_501,
        onData() { throw new Error('PTY IPC registration lost'); },
        onExit() {},
        write() {},
        resize() {},
        kill() {},
      }) },
    });
    assert.throws(
      () => promptAfterStartedManager.create({
        ...promptAfterSpawnRequest,
        bridgeId: 'claude:prompt-after-started',
        deliveryId: 'delivery:prompt-after-spawn:unknown',
      }),
      error => error.deliveryState === 'unknown'
        && error.deliveryId === 'delivery:prompt-after-spawn:unknown'
        && error.terminalProcessStarted === true,
    );
    promptAfterStartedManager.dispose();
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

  test('raw 터미널 입력 delivery 장부는 명령 장부와 분리해 중복을 막고 256개로 제한한다', () => {
    const processes = [];
    class FakePty {
      constructor(pid) { this.pid = pid; this.writes = []; }
      onData() {}
      onExit(callback) { this.exitCallback = callback; }
      write(value) { this.writes.push(value); }
      resize() {}
      kill() {}
    }
    const storeFile = path.join(temp, 'raw-write-delivery-ledger.json');
    const manager = new TerminalManager({
      platform: 'win32',
      storeFile,
      killTree: () => {},
      ptyModule: { spawn: () => {
        const handle = new FakePty(11_800 + processes.length);
        processes.push(handle);
        return handle;
      } },
    });
    const session = manager.create({ type: 'powershell', cwd: root, title: 'raw 입력 장부 검증' });
    const commandDeliveryId = 'delivery:command:kept';
    manager.command(session.id, 'Write-Output kept', { deliveryId: commandDeliveryId });

    for (let index = 0; index < 300; index += 1) {
      const result = manager.write(session.id, `raw-${index}`, {
        deliveryId: `delivery:raw:bounded:${index}`,
      });
      assert.equal(result.deliveryState, 'accepted');
    }

    const internal = manager.sessions.get(session.id);
    assert.equal(internal.rawInputDeliveries.length, 256);
    assert.equal(internal.rawInputDeliveries[0].id, 'delivery:raw:bounded:44');
    assert.equal(internal.rawInputDeliveries.at(-1).id, 'delivery:raw:bounded:299');
    assert.equal(internal.deliveries.some(record => record.id === commandDeliveryId), true,
      'raw 입력이 질문/명령 delivery 장부를 밀어내면 안 됩니다.');

    const writesBeforeDuplicates = processes[0].writes.length;
    assert.deepStrictEqual(manager.write(session.id, 'raw-299', {
      deliveryId: 'delivery:raw:bounded:299',
    }), {
      ok: true,
      duplicate: true,
      deliveryId: 'delivery:raw:bounded:299',
      deliveryState: 'accepted',
    });
    assert.equal(manager.command(session.id, 'Write-Output kept', {
      deliveryId: commandDeliveryId,
    }).duplicate, true);
    assert.equal(processes[0].writes.length, writesBeforeDuplicates);
    assert.throws(
      () => manager.write(session.id, 'different', { deliveryId: 'delivery:raw:bounded:299' }),
      error => error.code === 'DELIVERY_ID_CONFLICT' && error.deliveryState === 'rejected',
    );
    assert.throws(
      () => manager.command(session.id, 'Write-Output collision', { deliveryId: 'delivery:raw:bounded:299' }),
      error => error.code === 'DELIVERY_ID_CONFLICT' && error.deliveryState === 'rejected',
    );
    assert.throws(
      () => manager.write(session.id, 'command-collision', { deliveryId: commandDeliveryId }),
      error => error.code === 'DELIVERY_ID_CONFLICT' && error.deliveryState === 'rejected',
    );
    assert.equal(processes[0].writes.length, writesBeforeDuplicates);

    assert.equal(manager.persistNow(), true);
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8')).sessions
      .find(item => item.id === session.id);
    assert.equal(stored.rawInputDeliveries.length, 256);
    assert.equal(stored.deliveries.some(record => record.id === commandDeliveryId), true);
    manager.dispose();
  });

  test('raw 터미널 입력은 응답 유실과 write 전 단절 모두 같은 deliveryId로 한 번만 전달한다', async () => {
    const processes = [];
    class FakePty {
      constructor(pid) { this.pid = pid; this.writes = []; }
      onData(callback) { this.dataCallback = callback; }
      onExit(callback) { this.exitCallback = callback; }
      write(value) { this.writes.push(value); }
      resize() {}
      kill() {}
    }
    const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-raw-write-${suffix}`
      : path.join(os.tmpdir(), `lta-raw-write-${suffix}.sock`);
    const discovery = path.join(temp, `raw-write-host-${suffix}.json`);
    const manager = new TerminalManager({
      platform: 'win32',
      killTree: () => {},
      ptyModule: { spawn: () => {
        const handle = new FakePty(11_900 + processes.length);
        processes.push(handle);
        return handle;
      } },
    });
    const server = new TerminalHostServer({
      manager,
      endpoint,
      discoveryFile: discovery,
      token: `raw-write-token-${suffix}`,
      idleShutdownMs: 10_000,
    });
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      connectTimeoutMs: 3_000,
      spawnHost: () => { throw new Error('실행 중인 raw 입력 검증 호스트를 다시 시작하면 안 됩니다.'); },
    });
    let replacementServer = null;
    let safeFirstSendServer = null;
    try {
      await server.start();
      await client.connect();
      assert.equal(client.capabilities.rawWriteDelivery, 1);
      const session = await client.create({ type: 'powershell', cwd: root, title: 'raw 입력 재시도 검증' });

      const afterWriteId = 'delivery:raw:response-lost';
      const afterWritePayload = '응답 유실 뒤에도 한 번만 😀\r';
      const originalEnqueueFrame = server.enqueueFrame.bind(server);
      let droppedAfterWrite = false;
      server.enqueueFrame = (serverClient, payload) => {
        if (!droppedAfterWrite
          && payload?.type === 'response'
          && payload?.ok === true
          && payload?.result?.deliveryId === afterWriteId) {
          droppedAfterWrite = true;
          serverClient.socket.destroy();
          return false;
        }
        return originalEnqueueFrame(serverClient, payload);
      };
      const afterWriteResult = await client.write(session.id, afterWritePayload, {
        deliveryId: afterWriteId,
      });
      assert.equal(droppedAfterWrite, true);
      assert.equal(afterWriteResult.deliveryState, 'accepted');
      assert.equal(afterWriteResult.duplicate, true,
        '응답이 유실된 첫 write는 manager 장부에서 중복으로 승인되어야 합니다.');
      assert.equal(processes[0].writes.filter(value => value === afterWritePayload).length, 1);

      const beforeWriteId = 'delivery:raw:disconnect-before-write';
      const beforeWritePayload = 'write 전에 끊겨도 한 번만\r';
      const originalHandle = server.handle.bind(server);
      let droppedBeforeWrite = false;
      server.handle = (serverClient, message) => {
        if (!droppedBeforeWrite
          && message?.type === 'request'
          && message?.operation === 'write'
          && message?.args?.[2]?.deliveryId === beforeWriteId) {
          droppedBeforeWrite = true;
          serverClient.socket.destroy();
          return undefined;
        }
        return originalHandle(serverClient, message);
      };
      const beforeWriteResult = await client.write(session.id, beforeWritePayload, {
        deliveryId: beforeWriteId,
      });
      assert.equal(droppedBeforeWrite, true);
      assert.equal(beforeWriteResult.deliveryState, 'accepted');
      assert.equal(processes[0].writes.filter(value => value === beforeWritePayload).length, 1);

      const cachedResult = await client.write(session.id, beforeWritePayload, { deliveryId: beforeWriteId });
      assert.equal(cachedResult.duplicate, true);
      assert.equal(processes[0].writes.filter(value => value === beforeWritePayload).length, 1);
      await assert.rejects(
        client.write(session.id, '다른 입력', { deliveryId: beforeWriteId }),
        error => error.code === 'DELIVERY_ID_CONFLICT' && error.deliveryState === 'rejected',
      );

      const concurrentId = 'delivery:raw:concurrent';
      const concurrentPayload = '동시 입력도 한 번만';
      const concurrent = await Promise.all([
        client.write(session.id, concurrentPayload, { deliveryId: concurrentId }),
        client.write(session.id, concurrentPayload, { deliveryId: concurrentId }),
      ]);
      assert.equal(concurrent[1].duplicate, true);
      assert.equal(processes[0].writes.filter(value => value === concurrentPayload).length, 1);

      for (let index = 0; index < 260; index += 1) {
        await client.write(session.id, `bounded-${index}`, {
          deliveryId: `delivery:raw:client-bounded:${index}`,
        });
      }
      assert.equal(client.rawWriteDeliveries.size, 256);
      assert.equal(manager.sessions.get(session.id).rawInputDeliveries.length, 256);

      const replacementEndpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\loadtoagent-raw-write-replacement-${suffix}`
        : path.join(os.tmpdir(), `lta-raw-write-replacement-${suffix}.sock`);
      replacementServer = new TerminalHostServer({
        manager,
        endpoint: replacementEndpoint,
        discoveryFile: discovery,
        token: `raw-write-replacement-token-${suffix}`,
        idleShutdownMs: 10_000,
      });
      let replacementWriteRequests = 0;
      const replacementHandle = replacementServer.handle.bind(replacementServer);
      replacementServer.handle = (serverClient, message) => {
        if (message?.type === 'request' && message?.operation === 'write') replacementWriteRequests += 1;
        return replacementHandle(serverClient, message);
      };
      await replacementServer.start();

      const replacementDeliveryId = 'delivery:raw:host-replaced-after-write';
      const replacementPayload = '교체된 daemon에는 다시 쓰지 않기\r';
      let droppedForReplacement = false;
      server.enqueueFrame = (serverClient, payload) => {
        if (!droppedForReplacement
          && payload?.type === 'response'
          && payload?.ok === true
          && payload?.result?.deliveryId === replacementDeliveryId) {
          droppedForReplacement = true;
          serverClient.socket.destroy();
          return false;
        }
        return originalEnqueueFrame(serverClient, payload);
      };
      await assert.rejects(
        client.write(session.id, replacementPayload, { deliveryId: replacementDeliveryId }),
        error => error.deliveryId === replacementDeliveryId
          && error.deliveryState === 'unknown'
          && /교체/.test(error.message),
      );
      assert.equal(droppedForReplacement, true);
      assert.equal(replacementWriteRequests, 0,
        'ACK 유실 뒤 다른 daemon에 같은 raw frame을 재전송하면 안 됩니다.');
      assert.equal(processes[0].writes.filter(value => value === replacementPayload).length, 1);
      assert.equal(client.discovery.token, `raw-write-replacement-token-${suffix}`);

      const safeFirstSendEndpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\loadtoagent-raw-write-safe-first-${suffix}`
        : path.join(os.tmpdir(), `lta-raw-write-safe-first-${suffix}.sock`);
      safeFirstSendServer = new TerminalHostServer({
        manager,
        endpoint: safeFirstSendEndpoint,
        discoveryFile: discovery,
        token: `raw-write-safe-first-token-${suffix}`,
        idleShutdownMs: 10_000,
      });
      let safeFirstSendRequests = 0;
      const safeFirstSendHandle = safeFirstSendServer.handle.bind(safeFirstSendServer);
      safeFirstSendServer.handle = (serverClient, message) => {
        if (message?.type === 'request' && message?.operation === 'write') safeFirstSendRequests += 1;
        return safeFirstSendHandle(serverClient, message);
      };
      await safeFirstSendServer.start();

      const safeFirstSendId = 'delivery:raw:replacement-before-frame';
      const safeFirstSendPayload = 'frame 전 단절이면 새 daemon에 최초 1회만 쓰기\r';
      const originalRawWriteDeliverySupported = client.rawWriteDeliverySupported;
      let disconnectedBeforeFrame = false;
      client.rawWriteDeliverySupported = function rawWriteDeliverySupportedWithPreSendDisconnect() {
        if (!disconnectedBeforeFrame) {
          disconnectedBeforeFrame = true;
          this.socket.destroy();
        }
        return originalRawWriteDeliverySupported.call(this);
      };
      let safeFirstSendResult;
      try {
        safeFirstSendResult = await client.write(session.id, safeFirstSendPayload, {
          deliveryId: safeFirstSendId,
        });
      } finally {
        client.rawWriteDeliverySupported = originalRawWriteDeliverySupported;
      }
      assert.equal(disconnectedBeforeFrame, true);
      assert.equal(safeFirstSendResult.deliveryState, 'accepted');
      assert.equal(safeFirstSendRequests, 1,
        '실제 frame 전 단절은 교체 daemon에 안전한 최초 전송을 정확히 한 번 허용해야 합니다.');
      assert.equal(replacementWriteRequests, 0,
        '끊긴 이전 daemon에는 pre-send raw frame이 기록되면 안 됩니다.');
      assert.equal(processes[0].writes.filter(value => value === safeFirstSendPayload).length, 1);
      assert.equal(client.discovery.token, `raw-write-safe-first-token-${suffix}`);
    } finally {
      client.dispose();
      safeFirstSendServer?.dispose();
      replacementServer?.dispose();
      server.dispose();
      manager.dispose();
    }
  });

  test('legacy raw ACK 유실은 재시도하지 않고 실제 frame 전 실패만 안전한 최초 전송을 허용한다', async () => {
    const processes = [];
    class FakePty {
      constructor(pid) { this.pid = pid; this.writes = []; }
      onData() {}
      onExit(callback) { this.exitCallback = callback; }
      write(value) { this.writes.push(value); }
      resize() {}
      kill() {}
    }
    const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-raw-write-legacy-${suffix}`
      : path.join(os.tmpdir(), `lta-raw-write-legacy-${suffix}.sock`);
    const discovery = path.join(temp, `raw-write-legacy-host-${suffix}.json`);
    const manager = new TerminalManager({
      platform: 'win32',
      killTree: () => {},
      ptyModule: { spawn: () => {
        const handle = new FakePty(12_100 + processes.length);
        processes.push(handle);
        return handle;
      } },
    });
    const server = new TerminalHostServer({
      manager,
      endpoint,
      discoveryFile: discovery,
      token: `raw-write-legacy-token-${suffix}`,
      capabilities: {},
      idleShutdownMs: 10_000,
    });
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      connectTimeoutMs: 3_000,
      spawnHost: () => { throw new Error('실행 중인 legacy 검증 호스트를 다시 시작하면 안 됩니다.'); },
    });
    try {
      await server.start();
      await client.connect();
      assert.deepStrictEqual(client.capabilities, {});
      const session = await client.create({ type: 'powershell', cwd: root, title: 'legacy raw 입력 검증' });
      const originalEnqueueFrame = server.enqueueFrame.bind(server);
      let dropNextResponse = true;
      server.enqueueFrame = (serverClient, payload) => {
        if (dropNextResponse && payload?.type === 'response' && payload?.ok === true) {
          dropNextResponse = false;
          serverClient.socket.destroy();
          return false;
        }
        return originalEnqueueFrame(serverClient, payload);
      };
      const deliveryId = 'delivery:raw:legacy-ambiguous';
      const payload = 'legacy 호스트에서는 재전송 금지';
      await assert.rejects(
        client.write(session.id, payload, { deliveryId }),
        error => error.deliveryId === deliveryId && error.deliveryState === 'unknown',
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(processes[0].writes.filter(value => value === payload).length, 1);
      assert.equal(manager.sessions.get(session.id).rawInputDeliveries.length, 0,
        'capability 없는 호스트에는 delivery 옵션을 보내면 안 됩니다.');
      assert.equal(client.rawWriteDeliveries.has(deliveryId), false);
    } finally {
      client.dispose();
      server.dispose();
      manager.dispose();
    }

    const preSendClient = new TerminalHostClient({
      discoveryFile: path.join(temp, 'unused-raw-presend-host.json'),
    });
    preSendClient.capabilities = {};
    const preSendArgs = [];
    let preSendAttempts = 0;
    preSendClient.requestWithToken = async (_requestToken, operation, args, transportAttempt) => {
      assert.equal(operation, 'write');
      preSendAttempts += 1;
      transportAttempt.hostInstance = 'same-legacy-host';
      const resolvedArgs = typeof args === 'function' ? args() : args;
      preSendArgs.push(resolvedArgs);
      if (preSendAttempts === 1) {
        transportAttempt.frameSent = false;
        throw new Error('frame 전 socket 종료');
      }
      transportAttempt.frameSent = true;
      return { ok: true };
    };
    const preSendResult = await preSendClient.write('terminal:legacy-presend', 'first-safe-frame', {
      deliveryId: 'delivery:raw:legacy-presend',
    });
    assert.equal(preSendAttempts, 2);
    assert.deepStrictEqual(preSendArgs.map(args => args.length), [2, 2],
      'legacy host에는 delivery 옵션을 보내면 안 됩니다.');
    assert.equal(preSendResult.deliveryState, 'accepted');
    preSendClient.dispose();

    const preConnectClient = new TerminalHostClient({
      discoveryFile: path.join(temp, 'unused-raw-preconnect-host.json'),
    });
    preConnectClient.capabilities = { rawWriteDelivery: 1 };
    let preConnectAttempts = 0;
    preConnectClient.requestWithToken = async (_requestToken, operation, args, transportAttempt) => {
      assert.equal(operation, 'write');
      preConnectAttempts += 1;
      if (preConnectAttempts === 1) throw new Error('연결 전 실패');
      transportAttempt.hostInstance = 'first-connected-host';
      const resolvedArgs = typeof args === 'function' ? args() : args;
      assert.equal(resolvedArgs[2]?.deliveryId, 'delivery:raw:preconnect');
      transportAttempt.frameSent = true;
      return { ok: true, deliveryState: 'accepted' };
    };
    const preConnectResult = await preConnectClient.write('terminal:preconnect', 'connected-once', {
      deliveryId: 'delivery:raw:preconnect',
    });
    assert.equal(preConnectAttempts, 2);
    assert.equal(preConnectResult.deliveryState, 'accepted');
    preConnectClient.dispose();

    const neverSentClient = new TerminalHostClient({
      discoveryFile: path.join(temp, 'unused-raw-never-sent-host.json'),
    });
    let neverSentAttempts = 0;
    neverSentClient.requestWithToken = async () => {
      neverSentAttempts += 1;
      throw new Error('계속 연결 전 실패');
    };
    await assert.rejects(
      neverSentClient.write('terminal:never-sent', 'not-sent', {
        deliveryId: 'delivery:raw:never-sent',
      }),
      error => error.code === 'TERMINAL_WRITE_NOT_SENT'
        && error.deliveryState === 'rejected'
        && error.deliveryId === 'delivery:raw:never-sent',
    );
    assert.equal(neverSentAttempts, 2);
    neverSentClient.dispose();
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
    const serverClient = [...server.clients].find(entry => entry.authenticated);
    const unicodeRequest = Buffer.from(`${JSON.stringify({
      type: 'request', requestId: 'unicode-request', operation: 'command',
      args: [created.id, '한글😀'],
    })}\n`, 'utf8');
    for (let index = 0; index < unicodeRequest.length; index += 1) {
      server.consume(serverClient, unicodeRequest.subarray(index, index + 1));
    }
    await serverClient.queue;
    assert.equal(processes[0].writes.at(-1), '한글😀\r');
    await secondClient.command(created.id, 'Write-Output AFTER_RESTART');
    assert.equal(processes[0].writes.at(-1), 'Write-Output AFTER_RESTART\r');

    let acknowledgeRetirement;
    let retirementSettled = false;
    const retireCalls = [];
    manager.retire = async id => {
      retireCalls.push(id);
      return new Promise(resolve => { acknowledgeRetirement = resolve; });
    };
    const retirement = secondClient.retire(created.id).then(result => {
      retirementSettled = true;
      return result;
    });
    assert.equal(await waitUntil(() => retireCalls.length === 1), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(retireCalls, [created.id]);
    assert.equal(retirementSettled, false);
    acknowledgeRetirement({ ok: true, id: created.id, retired: true });
    assert.deepStrictEqual(await retirement, { ok: true, id: created.id, retired: true });
    assert.equal(retirementSettled, true);

    await secondClient.close(created.id);
    assert.equal(processes[0].killed, true);
    secondClient.dispose();
    server.dispose();
    manager.dispose();
  });

  test('느린 터미널 호스트 시작이 연결 제한시간을 넘겨도 같은 PID가 살아 있는 동안 다시 띄우지 않는다', async () => {
    const discovery = path.join(temp, 'terminal-host-slow-launch.json');
    let spawnCalls = 0;
    let processState = 'alive';
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      connectTimeoutMs: 30,
      spawnHost: () => {
        spawnCalls += 1;
        return 55_000 + spawnCalls;
      },
      processExists: pid => {
        assert.equal(pid, 55_000 + spawnCalls);
        if (processState === 'unknown') throw new Error('PID 상태 확인 실패');
        return processState === 'alive';
      },
    });
    client.connectExisting = async () => {
      const error = new Error('호스트가 아직 준비되지 않았습니다.');
      error.code = 'ENOENT';
      throw error;
    };

    await assert.rejects(client.connect(), /호스트가 아직 준비되지 않았습니다/);
    assert.equal(spawnCalls, 1);
    assert.equal(client.hostLaunch.pid, 55_001);

    await assert.rejects(client.connect(), /호스트가 아직 준비되지 않았습니다/);
    assert.equal(spawnCalls, 1, '살아 있는 첫 호스트 대신 두 번째 daemon을 시작하면 안 됩니다.');

    processState = 'unknown';
    await assert.rejects(client.connect(), /호스트가 아직 준비되지 않았습니다/);
    assert.equal(spawnCalls, 1, 'PID 상태가 불확실할 때도 두 번째 daemon을 시작하면 안 됩니다.');

    processState = 'dead';
    await assert.rejects(client.connect(), /호스트가 아직 준비되지 않았습니다/);
    assert.equal(spawnCalls, 2, '첫 호스트의 종료가 확인된 뒤에만 교체 daemon을 시작해야 합니다.');
    assert.equal(client.hostLaunch.pid, 55_002);
    client.dispose();
  });

  test('연결 재시도 중 시작한 호스트 PID가 죽으면 같은 연결 루프에서만 교체한다', async () => {
    const discovery = path.join(temp, 'terminal-host-dies-during-connect.json');
    let spawnCalls = 0;
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      connectTimeoutMs: 1_000,
      spawnHost: () => {
        spawnCalls += 1;
        return 56_000 + spawnCalls;
      },
      processExists: pid => {
        assert.equal(pid, 56_001);
        return false;
      },
    });
    client.connectExisting = async () => {
      if (spawnCalls >= 2) {
        client.connected = true;
        return;
      }
      const error = new Error('호스트가 아직 준비되지 않았습니다.');
      error.code = 'ENOENT';
      throw error;
    };

    await client.connect();
    assert.equal(spawnCalls, 2);
    assert.equal(client.connected, true);
    client.dispose();
  });

  test('동시에 시작한 터미널 호스트는 OS 잠금을 하나만 소유하고 해제 뒤에만 교체된다', async () => {
    const formerlyCollidingA = terminalHostLockEndpoint('C:/audit/discovery-129.json', 'linux');
    const formerlyCollidingB = terminalHostLockEndpoint('C:/audit/discovery-190.json', 'linux');
    assert.notDeepStrictEqual(formerlyCollidingA, formerlyCollidingB, '서로 다른 discovery가 같은 10k-port 잠금으로 충돌하면 안 됩니다.');
    assert.equal(formerlyCollidingA.startsWith('\0lta-th-'), true);

    let darwinCloseCalls = 0;
    let darwinKeepAliveCalls = 0;
    let darwinClearKeepAliveCalls = 0;
    const darwinKeepAlive = { kind: 'darwin-lock-keepalive' };
    const darwinOpen = [];
    const darwinFileSystem = {
      constants: { O_CREAT: 0x200, O_RDWR: 0x2, O_NONBLOCK: 0x4 },
      mkdirSync() {},
      openSync(file, flags, mode) {
        darwinOpen.push({ file, flags, mode });
        return 71;
      },
      closeSync(fileDescriptor) {
        darwinCloseCalls += 1;
        assert.equal(fileDescriptor, 71);
      },
    };
    const darwinLock = await acquireTerminalHostProcessLock('/tmp/loadtoagent/discovery.json', {
      platform: 'darwin',
      fileSystem: darwinFileSystem,
      setInterval(callback, delay) {
        darwinKeepAliveCalls += 1;
        assert.equal(typeof callback, 'function');
        assert.equal(delay, 60_000);
        return darwinKeepAlive;
      },
      clearInterval(handle) {
        darwinClearKeepAliveCalls += 1;
        assert.equal(handle, darwinKeepAlive);
      },
    });
    assert.equal(darwinLock.server, null);
    assert.equal(darwinOpen.length, 1);
    assert.equal((darwinOpen[0].flags & 0x20) === 0x20, true, 'Darwin O_EXLOCK 없이 파일을 열면 안 됩니다.');
    assert.equal((darwinOpen[0].flags & 0x4) === 0x4, true, 'Darwin lock open은 non-blocking이어야 합니다.');
    assert.equal((darwinOpen[0].flags & 0x100) === 0x100, true, 'Darwin lock은 symlink를 따라가면 안 됩니다.');
    assert.equal(darwinOpen[0].mode, 0o600);
    assert.equal(darwinKeepAliveCalls, 1, 'Darwin lock 소유 중 daemon을 살리는 handle이 필요합니다.');
    assert.equal(darwinClearKeepAliveCalls, 0, 'lock fd를 닫기 전에 keepalive를 해제하면 안 됩니다.');
    assert.equal((await darwinLock.release()).ok, true);
    assert.equal(darwinClearKeepAliveCalls, 1, 'lock fd가 닫힌 뒤 keepalive를 해제해야 합니다.');
    assert.equal((await darwinLock.release()).alreadyReleased, true);
    assert.equal(darwinClearKeepAliveCalls, 1, '중복 release가 keepalive를 다시 해제하면 안 됩니다.');
    assert.equal(darwinCloseCalls, 1);

    let failClosedCloseCalls = 0;
    let failClosedClearCalls = 0;
    const failClosedLock = await acquireTerminalHostProcessLock('/tmp/loadtoagent/fail-closed.json', {
      platform: 'darwin',
      fileSystem: {
        ...darwinFileSystem,
        openSync() { return 72; },
        closeSync(fileDescriptor) {
          failClosedCloseCalls += 1;
          assert.equal(fileDescriptor, 72);
          if (failClosedCloseCalls === 1) throw Object.assign(new Error('close failed'), { code: 'EIO' });
        },
      },
      setInterval: () => darwinKeepAlive,
      clearInterval: handle => {
        assert.equal(handle, darwinKeepAlive);
        failClosedClearCalls += 1;
      },
    });
    await assert.rejects(failClosedLock.release(), error => error.code === 'TERMINAL_HOST_LOCK_RELEASE_FAILED');
    assert.equal(failClosedClearCalls, 0, 'release 실패 뒤에는 keepalive와 lock 소유를 유지해야 합니다.');
    assert.equal((await failClosedLock.release()).ok, true, 'release 실패 뒤 재시도할 수 있어야 합니다.');
    assert.equal(failClosedClearCalls, 1);
    await assert.rejects(
      acquireTerminalHostProcessLock('/tmp/loadtoagent/discovery.json', {
        platform: 'darwin',
        fileSystem: {
          ...darwinFileSystem,
          openSync() { throw Object.assign(new Error('would block'), { code: 'EAGAIN' }); },
        },
      }),
      error => error.code === 'TERMINAL_HOST_ALREADY_RUNNING',
    );

    const discovery = path.join(temp, `terminal-host-process-lock-${process.pid}-${Date.now()}.json`);
    const attempts = await Promise.allSettled([
      acquireTerminalHostProcessLock(discovery),
      acquireTerminalHostProcessLock(discovery),
    ]);
    const acquired = attempts.filter(result => result.status === 'fulfilled');
    const rejected = attempts.filter(result => result.status === 'rejected');
    try {
      assert.equal(acquired.length, 1, '동시에 두 daemon이 OS 잠금을 소유하면 안 됩니다.');
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].reason.code, 'TERMINAL_HOST_ALREADY_RUNNING');

      const owner = acquired[0].value;
      assert.equal((await owner.release()).ok, true);
      assert.equal((await owner.release()).alreadyReleased, true);

      const replacement = await acquireTerminalHostProcessLock(discovery);
      try {
        if (process.platform === 'darwin') {
          assert.equal(replacement.server, null);
          assert.equal(Number.isInteger(replacement.fileDescriptor), true);
        } else {
          assert.equal(Boolean(replacement.server?.listening), true);
        }
      } finally {
        await replacement.release();
      }
    } finally {
      await Promise.allSettled(acquired.map(result => result.value.release()));
    }

    const deniedServer = new EventEmitter();
    deniedServer.listen = () => setImmediate(() => {
      const error = new Error('listen denied');
      error.code = 'EACCES';
      deniedServer.emit('error', error);
    });
    await assert.rejects(
      acquireTerminalHostProcessLock(discovery, {
        platform: 'linux',
        endpoint: 'denied-test-endpoint',
        createServer: () => deniedServer,
      }),
      error => error.code === 'TERMINAL_HOST_LOCK_FAILED' && error.cause?.code === 'EACCES',
    );

    let closeCalls = 0;
    const retryServer = new EventEmitter();
    retryServer.listen = () => setImmediate(() => retryServer.emit('listening'));
    retryServer.close = callback => {
      closeCalls += 1;
      callback(closeCalls === 1 ? Object.assign(new Error('close failed'), { code: 'EIO' }) : null);
    };
    const retryLock = await acquireTerminalHostProcessLock(discovery, {
      platform: 'linux',
      endpoint: 'retry-test-endpoint',
      createServer: () => retryServer,
    });
    await assert.rejects(retryLock.release(), error => error.code === 'TERMINAL_HOST_LOCK_RELEASE_FAILED');
    assert.equal((await retryLock.release()).ok, true);
    assert.equal(closeCalls, 2, 'OS lock close 실패 뒤에는 release를 다시 시도할 수 있어야 합니다.');
  });

  test('PTY 런타임이 바뀌면 idle 구버전 호스트의 자연 종료 뒤 새 런타임으로 교체한다', async () => {
    class EmptyManager extends EventEmitter {
      constructor() {
        super();
        this.sessions = [{ id: 'terminal:startup-guard', status: 'running' }];
      }
      list() { return this.sessions.map(session => ({ ...session })); }
      on() { return super.on(...arguments); }
      removeListener() { return super.removeListener(...arguments); }
    }
    const manager = new EmptyManager();
    const discovery = path.join(temp, 'terminal-host-runtime-upgrade.json');
    const endpoint = suffix => process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-runtime-${process.pid}-${suffix}`
      : path.join(os.tmpdir(), `lta-host-runtime-${process.pid}-${suffix}.sock`);
    let oldServer = null;
    let legacyExitedNaturally = false;
    oldServer = new TerminalHostServer({
      manager,
      endpoint: endpoint('old'),
      discoveryFile: discovery,
      token: 'old-runtime-token',
      runtime: 'node-pty-1.1.0',
      idleShutdownMs: 50,
      onShutdown: () => {
        legacyExitedNaturally = true;
        oldServer.dispose();
      },
    });
    await oldServer.start();
    // Prevent startup's idle timer from winning the test. The verifier's
    // disconnect must be what gives the now-idle legacy daemon permission to
    // shut itself down.
    manager.sessions = [];
    let replacementServer = null;
    let terminateCalls = 0;
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      expectedRuntime: 'node-pty-1.2.0-beta.14',
      connectTimeoutMs: 2_000,
      terminateHost: async () => { terminateCalls += 1; },
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
    await assert.rejects(
      client.connect(),
      error => error.code === 'TERMINAL_HOST_REPLACEMENT_DEFERRED_LIVE_HOST'
        && error.retryable === true,
    );
    assert.equal(await waitUntil(() => client.connected, 4_000), true,
      'idle legacy runtime이 자연 종료되면 background retry가 새 runtime을 시작해야 합니다.');

    assert.equal(legacyExitedNaturally, true);
    assert.equal(terminateCalls, 0, '인증된 live legacy runtime을 tree-kill하면 안 됩니다.');
    assert.equal(client.connected, true);
    assert.equal(JSON.parse(fs.readFileSync(discovery, 'utf8')).runtime, 'node-pty-1.2.0-beta.14');

    const taskkill = new EventEmitter();
    taskkill.exitCode = null;
    taskkill.kill = () => {};
    taskkill.removeListener = EventEmitter.prototype.removeListener;
    const taskkillCalls = [];
    const treeTermination = terminateHostProcess({ pid: 43_210 }, {
      platform: 'win32',
      timeoutMs: 1_000,
      processExists: () => false,
      spawnProcess: (file, args, options) => {
        taskkillCalls.push({ file, args, options });
        return taskkill;
      },
    });
    taskkill.emit('exit', 0, null);
    await treeTermination;
    assert.deepStrictEqual(taskkillCalls[0].args, ['/PID', '43210', '/T', '/F']);
    assert.equal(taskkillCalls[0].options.windowsHide, true);

    let processGroupAlive = true;
    const groupSignals = [];
    const killProcess = (target, signal) => {
      groupSignals.push([target, signal]);
      if (signal === 'SIGTERM') {
        processGroupAlive = false;
        return;
      }
      if (!processGroupAlive) {
        const error = new Error('missing group');
        error.code = 'ESRCH';
        throw error;
      }
    };
    await terminateHostProcess({ pid: 43_211 }, {
      platform: 'linux',
      timeoutMs: 1_000,
      processExists: () => false,
      killProcess,
    });
    assert.deepStrictEqual(groupSignals, [[-43_211, 'SIGTERM'], [-43_211, 0]]);
    client.dispose();
    replacementServer?.dispose();
  });

  test('native PTY 입력 정책이 오래된 v10 호스트는 자연 종료를 확인한 뒤 v11 호스트로 교체한다', async () => {
    class EmptyManager extends EventEmitter {
      constructor(sessions = []) {
        super();
        this.sessions = sessions;
      }
      list() { return this.sessions.map(session => ({ ...session })); }
      on() { return super.on(...arguments); }
      removeListener() { return super.removeListener(...arguments); }
    }
    const endpoint = suffix => process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-protocol-${process.pid}-${suffix}`
      : path.join(os.tmpdir(), `lta-host-protocol-${process.pid}-${suffix}.sock`);
    const removeLegacyDiscovery = file => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    };

    const manager = new EmptyManager([{ id: 'terminal:startup-guard', status: 'running' }]);
    const discovery = path.join(temp, 'terminal-host-protocol-upgrade.json');
    let oldServer = null;
    let legacyExitedNaturally = false;
    const transitionOrder = [];
    oldServer = new TerminalHostServer({
      manager,
      endpoint: endpoint('v10'),
      discoveryFile: discovery,
      token: 'v10-protocol-token',
      idleShutdownMs: 50,
      onShutdown: () => {
        legacyExitedNaturally = true;
        transitionOrder.push('legacy-exit');
        oldServer.dispose();
        // This test simulates a v10 daemon with the current server class. Its
        // v11 dispose validator intentionally cannot remove the tampered v10
        // discovery, while the real v10 daemon removes its own discovery.
        removeLegacyDiscovery(discovery);
      },
    });
    await oldServer.start();
    const oldDiscovery = JSON.parse(fs.readFileSync(discovery, 'utf8'));
    fs.writeFileSync(discovery, JSON.stringify({ ...oldDiscovery, protocol: 10 }), 'utf8');
    manager.sessions = [];

    let replacementServer = null;
    let terminateCalls = 0;
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      connectTimeoutMs: 2_000,
      terminateHost: async () => { terminateCalls += 1; },
      spawnHost: async () => {
        transitionOrder.push('spawn');
        replacementServer = new TerminalHostServer({
          manager,
          endpoint: endpoint('v11'),
          discoveryFile: discovery,
          token: 'v11-protocol-token',
        });
        await replacementServer.start();
      },
    });
    await assert.rejects(
      client.connect(),
      error => error.code === 'TERMINAL_HOST_REPLACEMENT_DEFERRED_LIVE_HOST'
        && error.retryable === true,
    );
    assert.equal(await waitUntil(() => client.connected, 4_000), true,
      'idle v10 verifier가 연결을 놓은 뒤 legacy daemon이 자연 종료되면 v11을 시작해야 합니다.');

    const replacementDiscovery = JSON.parse(fs.readFileSync(discovery, 'utf8'));
    assert.equal(TERMINAL_HOST_PROTOCOL, 11);
    assert.equal(legacyExitedNaturally, true);
    assert.equal(terminateCalls, 0, '인증된 idle v10 host도 tree-kill하면 안 됩니다.');
    assert.equal(client.connected, true);
    assert.equal(replacementDiscovery.protocol, 11);
    assert.deepStrictEqual(transitionOrder, ['legacy-exit', 'spawn']);
    client.dispose();
    replacementServer?.dispose();

    const activeManager = new EmptyManager([
      { id: 'terminal:legacy-running', status: 'running' },
      { id: 'terminal:legacy-starting', status: 'starting' },
      { id: 'terminal:legacy-stopping', status: 'stopping' },
      { id: 'terminal:legacy-pending', status: 'exited', terminationPending: true },
      { id: 'terminal:legacy-uncertain', status: 'exited', terminationUncertain: true },
    ]);
    const activeDiscovery = path.join(temp, 'terminal-host-active-protocol-upgrade.json');
    let activeOldServer = null;
    let activeLegacyExitedNaturally = false;
    activeOldServer = new TerminalHostServer({
      manager: activeManager,
      endpoint: endpoint('active-v10'),
      discoveryFile: activeDiscovery,
      token: 'active-v10-protocol-token',
      idleShutdownMs: 50,
      onShutdown: () => {
        activeLegacyExitedNaturally = true;
        activeOldServer.dispose();
        removeLegacyDiscovery(activeDiscovery);
      },
    });
    await activeOldServer.start();
    const activeOldDiscovery = JSON.parse(fs.readFileSync(activeDiscovery, 'utf8'));
    fs.writeFileSync(activeDiscovery, JSON.stringify({ ...activeOldDiscovery, protocol: 10 }), 'utf8');

    let activeTerminateCalls = 0;
    let activeSpawnCalls = 0;
    let activeReplacementServer = null;
    const activeClient = new TerminalHostClient({
      discoveryFile: activeDiscovery,
      connectTimeoutMs: 2_000,
      terminateHost: async () => { activeTerminateCalls += 1; },
      spawnHost: async () => {
        activeSpawnCalls += 1;
        activeReplacementServer = new TerminalHostServer({
          manager: activeManager,
          endpoint: endpoint('active-v11'),
          discoveryFile: activeDiscovery,
          token: 'active-v11-protocol-token',
        });
        await activeReplacementServer.start();
      },
    });
    await assert.rejects(
      activeClient.connect(),
      error => error.code === 'TERMINAL_HOST_REPLACEMENT_DEFERRED_ACTIVE_SESSIONS'
        && error.retryable === true
        && error.sessions?.length === 5,
    );
    assert.equal(activeTerminateCalls, 0, '실행 중인 구버전 PTY가 있으면 host tree를 종료하면 안 됩니다.');
    assert.equal(activeSpawnCalls, 0, '실행 중인 구버전 PTY가 있으면 대체 host도 시작하면 안 됩니다.');

    activeManager.sessions = [];
    activeManager.emit('state', { change: 'updated', session: null, sessions: [] });
    assert.equal(await waitUntil(() => activeClient.connected, 4_000), true,
      '구버전 PTY가 모두 끝나고 daemon이 자연 종료되면 background retry가 v11을 시작해야 합니다.');
    assert.equal(activeLegacyExitedNaturally, true);
    assert.equal(activeTerminateCalls, 0);
    assert.equal(activeSpawnCalls, 1);
    assert.equal(JSON.parse(fs.readFileSync(activeDiscovery, 'utf8')).protocol, 11);
    activeClient.dispose();
    activeReplacementServer?.dispose();

    // TOCTOU regression: the ready frame can truthfully contain sessions:[]
    // while the old renderer creates a PTY immediately after that snapshot.
    // A verified live host must never be authorized for tree termination from
    // the stale empty snapshot.
    const raceManager = new EmptyManager([{ id: 'terminal:race-startup-guard', status: 'running' }]);
    const raceDiscovery = path.join(temp, 'terminal-host-protocol-upgrade-race.json');
    let raceOldServer = null;
    raceOldServer = new TerminalHostServer({
      manager: raceManager,
      endpoint: endpoint('race-v10'),
      discoveryFile: raceDiscovery,
      token: 'race-v10-protocol-token',
      idleShutdownMs: 50,
    });
    await raceOldServer.start();
    const raceOldDiscovery = JSON.parse(fs.readFileSync(raceDiscovery, 'utf8'));
    fs.writeFileSync(raceDiscovery, JSON.stringify({ ...raceOldDiscovery, protocol: 10 }), 'utf8');
    raceManager.sessions = [];

    let emptySnapshotObserved = false;
    let raceTerminateCalls = 0;
    let raceSpawnCalls = 0;
    const raceClient = new TerminalHostClient({
      discoveryFile: raceDiscovery,
      connectTimeoutMs: 2_000,
      verifyHost: async info => {
        const verification = await verifyHostDiscovery(info);
        emptySnapshotObserved = Array.isArray(verification.sessions) && verification.sessions.length === 0;
        raceManager.sessions = [{ id: 'terminal:created-after-ready', status: 'running' }];
        return verification;
      },
      terminateHost: async () => { raceTerminateCalls += 1; },
      spawnHost: async () => { raceSpawnCalls += 1; },
    });
    await assert.rejects(
      raceClient.connect(),
      error => error.code === 'TERMINAL_HOST_REPLACEMENT_DEFERRED_LIVE_HOST'
        && error.retryable === true,
    );
    assert.equal(emptySnapshotObserved, true);
    assert.equal(raceManager.sessions.length, 1, 'ready snapshot 직후 old client가 새 PTY를 만들었다고 가정합니다.');
    assert.equal(raceTerminateCalls, 0, 'sessions:[] snapshot은 live legacy host tree-kill 권한이 아닙니다.');
    assert.equal(raceSpawnCalls, 0, 'live legacy host가 남아 있으면 replacement를 시작하면 안 됩니다.');
    raceClient.dispose();
    raceOldServer.dispose();
    removeLegacyDiscovery(raceDiscovery);
  });

  test('인증할 수 없는 구버전 호스트 PID가 살아 있으면 종료하거나 교체하지 않는다', async () => {
    const discovery = path.join(temp, 'terminal-host-live-unresponsive-runtime.json');
    fs.writeFileSync(discovery, JSON.stringify({
      protocol: 1,
      endpoint: process.platform === 'win32'
        ? `\\\\.\\pipe\\loadtoagent-live-unresponsive-${process.pid}`
        : path.join(os.tmpdir(), `lta-live-unresponsive-${process.pid}.sock`),
      token: 'live-unresponsive-token',
      pid: process.pid,
    }), 'utf8');
    let terminated = 0;
    let spawned = 0;
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      connectTimeoutMs: 2_000,
      verifyHost: async () => { throw new Error('호스트 무응답'); },
      processExists: pid => {
        assert.equal(pid, process.pid);
        return true;
      },
      terminateHost: () => { terminated += 1; },
      spawnHost: () => { spawned += 1; },
    });

    await assert.rejects(
      client.connect(),
      error => error.code === 'TERMINAL_HOST_REPLACEMENT_UNCONFIRMED',
    );
    await assert.rejects(
      client.connect(),
      error => error.code === 'TERMINAL_HOST_REPLACEMENT_UNCONFIRMED',
    );
    assert.equal(terminated, 0);
    assert.equal(spawned, 0);
    client.dispose();
  });

  test('인증할 수 없는 구버전 호스트 PID 상태가 불확실하면 교체하지 않는다', async () => {
    const discovery = path.join(temp, 'terminal-host-unknown-runtime.json');
    fs.writeFileSync(discovery, JSON.stringify({
      protocol: 1,
      endpoint: process.platform === 'win32'
        ? `\\\\.\\pipe\\loadtoagent-unknown-${process.pid}`
        : path.join(os.tmpdir(), `lta-unknown-${process.pid}.sock`),
      token: 'unknown-token',
      pid: 98_765,
    }), 'utf8');
    let spawned = 0;
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      verifyHost: async () => { throw new Error('호스트 무응답'); },
      processExists: () => { throw Object.assign(new Error('PID 확인 권한 없음'), { code: 'EACCES' }); },
      spawnHost: () => { spawned += 1; },
    });

    await assert.rejects(
      client.connect(),
      error => error.code === 'TERMINAL_HOST_REPLACEMENT_UNCONFIRMED'
        && error.cause?.code === 'EACCES',
    );
    assert.equal(spawned, 0);
    client.dispose();
  });

  test('서로 다른 클라이언트도 살아 있는 무응답 구버전 호스트를 동시에 교체하지 않는다', async () => {
    const discovery = path.join(temp, 'terminal-host-shared-live-runtime.json');
    fs.writeFileSync(discovery, JSON.stringify({
      protocol: 8,
      endpoint: process.platform === 'win32'
        ? `\\\\.\\pipe\\loadtoagent-shared-live-${process.pid}`
        : path.join(os.tmpdir(), `lta-shared-live-${process.pid}.sock`),
      token: 'shared-live-token',
      pid: process.pid,
    }), 'utf8');
    let spawned = 0;
    const clients = [0, 1].map(() => new TerminalHostClient({
      discoveryFile: discovery,
      verifyHost: async () => { throw new Error('호스트 무응답'); },
      processExists: () => true,
      spawnHost: () => { spawned += 1; },
    }));

    const results = await Promise.allSettled(clients.map(client => client.connect()));
    assert.equal(results.every(result => result.status === 'rejected'
      && result.reason?.code === 'TERMINAL_HOST_REPLACEMENT_UNCONFIRMED'), true);
    assert.equal(spawned, 0);
    clients.forEach(client => client.dispose());
  });

  test('인증할 수 없는 구버전 호스트 PID의 종료가 확인된 경우에만 교체한다', async () => {
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
      pid: 98_766,
    }), 'utf8');
    let terminated = false;
    let spawned = 0;
    let replacementServer = null;
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      connectTimeoutMs: 2_000,
      verifyHost: async () => { throw new Error('호스트 없음'); },
      processExists: pid => {
        assert.equal(pid, 98_766);
        return false;
      },
      terminateHost: () => { terminated = true; },
      spawnHost: async () => {
        spawned += 1;
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
    assert.equal(spawned, 1);
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

  test('자연 종료 상태는 즉시 저장해 직후 호스트가 죽어도 끝난 셸을 되살리지 않는다', async () => {
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
    const countedFileSystem = Object.create(fs);
    let storeWrites = 0;
    countedFileSystem.writeFileSync = (...args) => {
      storeWrites += 1;
      return fs.writeFileSync(...args);
    };
    const options = {
      storeFile,
      fileSystem: countedFileSystem,
      killTree: () => {},
      ptyModule: { spawn: () => {
        const processHandle = new FakePty(16_000 + processes.length);
        processes.push(processHandle);
        return processHandle;
      } },
    };
    const manager = new TerminalManager(options);
    const session = manager.create({ type: 'powershell', cwd: root });
    const writesAfterCreate = storeWrites;
    for (let index = 0; index < 4; index += 1) {
      processes[0].dataCallback(`spinner-${index}\r`);
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    assert.equal(
      storeWrites,
      writesAfterCreate,
      '연속 PTY 출력을 150ms마다 전체 저장소로 동기 저장하면 안 됩니다.',
    );
    assert.equal(
      await waitUntil(() => storeWrites === writesAfterCreate + 1, 1_500),
      true,
      '연속 출력도 1초 내에 한 번은 안전하게 저장해야 합니다.',
    );
    assert.equal(storeWrites, writesAfterCreate + 1);

    processes[0].dataCallback('final-output');
    const writesBeforeExit = storeWrites;
    processes[0].exitCallback({ exitCode: 0, signal: 0 });
    assert.equal(
      storeWrites,
      writesBeforeExit + 1,
      '종료 상태와 마지막 출력은 지연 타이머를 기다리지 않고 즉시 저장해야 합니다.',
    );
    const storedAtExit = JSON.parse(fs.readFileSync(storeFile, 'utf8')).sessions
      .find(item => item.id === session.id);
    assert.equal(storedAtExit.status, 'exited');
    assert.match(storedAtExit.replay, /final-output/);

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
    let reconnectErrors = 0;
    let resolveReplacementReady;
    let rejectReplacementReady;
    const replacementReady = new Promise((resolve, reject) => {
      resolveReplacementReady = resolve;
      rejectReplacementReady = reject;
    });
    const client = new TerminalHostClient({
      discoveryFile: discovery,
      connectTimeoutMs: 350,
      processExists: pid => {
        assert.equal(pid, 58_001);
        return true;
      },
      spawnHost: () => {
        spawnCalls += 1;
        // Keep the first replacement attempt unavailable past connectTimeout.
        // The client must retain its launch lease and retry the connection in
        // the background instead of wedging until another UI request arrives.
        setTimeout(() => {
          replacementServer = new TerminalHostServer({ manager, endpoint: endpoint('second'), discoveryFile: discovery, token: 'second-token' });
          replacementServer.start().then(resolveReplacementReady, rejectReplacementReady);
        }, 550);
        return { pid: 58_001 };
      },
    });
    client.on('reconnect-error', () => { reconnectErrors += 1; });
    await client.connect();
    firstServer.dispose();
    // Keep the isolated test process alive long enough to observe the socket
    // close; production Electron already has a live event loop. Retry timers
    // themselves are intentionally unref'ed so they never block app exit.
    await new Promise(resolve => setTimeout(resolve, 30));
    await replacementReady;
    assert.equal(await waitUntil(() => client.connected, 2_000), true,
      '첫 자동 복구 제한시간이 지나도 다음 bounded retry에서 연결되어야 합니다.');
    assert.equal(reconnectErrors >= 1, true);

    const created = await client.create({ type: 'powershell', cwd: root, title: '자동 재연결 검증' });
    assert.equal(spawnCalls, 1);
    assert.equal(created.status, 'running');
    assert.equal(client.list()[0].id, created.id);

    await client.close(created.id);
    client.dispose();
    replacementServer?.dispose();

    const startupDiscovery = path.join(temp, 'terminal-host-startup-retry-discovery.json');
    let startupServer = null;
    let startupSpawnCalls = 0;
    let resolveStartupReady;
    let rejectStartupReady;
    const startupReady = new Promise((resolve, reject) => {
      resolveStartupReady = resolve;
      rejectStartupReady = reject;
    });
    const startupClient = new TerminalHostClient({
      discoveryFile: startupDiscovery,
      connectTimeoutMs: 80,
      processExists: () => true,
      spawnHost: () => {
        startupSpawnCalls += 1;
        setTimeout(() => {
          startupServer = new TerminalHostServer({
            manager,
            endpoint: endpoint('startup-retry'),
            discoveryFile: startupDiscovery,
            token: 'startup-retry-token',
          });
          startupServer.start().then(resolveStartupReady, rejectStartupReady);
        }, 250);
        return { pid: 58_002 };
      },
    });
    let startupReconnects = 0;
    startupClient.on('reconnect', () => { startupReconnects += 1; });
    await assert.rejects(startupClient.connect(), /명령창에 연결하지 못했습니다/);
    await startupReady;
    assert.equal(await waitUntil(() => startupClient.connected, 2_000), true,
      '최초 startup 연결 실패도 다음 UI 요청 없이 bounded retry로 복구해야 합니다.');
    assert.equal(startupSpawnCalls, 1);
    assert.equal(startupReconnects, 1);
    startupClient.dispose();
    startupServer?.dispose();
    manager.dispose();
  });

  test('이전 소켓의 늦은 close 이벤트가 새 터미널 호스트 연결을 끊지 않는다', async () => {
    const client = new TerminalHostClient({ discoveryFile: path.join(temp, 'unused-host.json') });
    const staleSocket = { destroyed: true };
    const activeSocket = {
      destroyed: false,
      destroy(error) { this.destroyed = true; this.error = error; },
      end() { this.destroyed = true; },
    };
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

    const output = [];
    client.on('data', payload => output.push(payload));
    const unicodeFrame = Buffer.from(`${JSON.stringify({
      type: 'event', event: 'data',
      payload: { id: 'terminal:active', data: '한😀', outputSequence: 1 },
    })}\n`, 'utf8');
    for (let index = 0; index < unicodeFrame.length; index += 1) {
      client.consume(unicodeFrame.subarray(index, index + 1), activeSocket);
    }
    assert.equal(output[0].data, '한😀');

    const retainedAnsi = '\x1b'.repeat(2 * 1024 * 1024);
    const replayFrame = Buffer.from(`${JSON.stringify({
      type: 'response', requestId: 'large-replay', ok: true,
      result: { id: 'terminal:active', replay: retainedAnsi },
    })}\n`, 'utf8');
    assert.equal(replayFrame.length > 4 * 1024 * 1024, true,
      'control-character-heavy replay must exercise the former frame ceiling');
    let replayResult = null;
    client.pending.set('large-replay', {
      resolve: value => { replayResult = value; },
      reject: error => { throw error; },
      timer: setTimeout(() => {}, 10_000),
    });
    client.consume(replayFrame, activeSocket);
    assert.equal(activeSocket.destroyed, false);
    assert.equal(replayResult.replay.length, retainedAnsi.length);

    let destroyedChecks = 0;
    const closingSocket = {
      get destroyed() {
        destroyedChecks += 1;
        return destroyedChecks >= 3;
      },
      write() {
        throw new Error('닫힌 소켓에 쓰면 안 됩니다.');
      },
      destroy() {},
      end() {},
    };
    const closingClient = new TerminalHostClient({ discoveryFile: path.join(temp, 'unused-closing-host.json') });
    closingClient.socket = closingSocket;
    closingClient.connected = true;
    await assert.rejects(
      closingClient.request('list'),
      /요청을 보내기 전에 닫혔습니다/,
    );
    assert.equal(closingClient.pending.size, 0, '닫힘 race가 요청을 timeout까지 남기면 안 됩니다.');
    closingClient.dispose();
    client.dispose();
  });

  test('늦은 호스트 list 응답과 역순 list 요청이 최신 세션 상태를 지우지 않는다', async () => {
    const client = new TerminalHostClient({ discoveryFile: path.join(temp, 'unused-list-race-host.json') });
    const frames = [];
    const socket = {
      destroyed: false,
      write: value => { frames.push(JSON.parse(String(value).trim())); return true; },
    };
    client.connected = true;
    client.socket = socket;
    const staleList = client.listFresh();
    const requestId = frames[0].requestId;
    client.consume(Buffer.from([
      JSON.stringify({
        type: 'response', requestId, ok: true,
        result: [{ id: 'terminal:list-old', status: 'running' }],
      }),
      JSON.stringify({
        type: 'event', event: 'state',
        payload: { sessions: [{ id: 'terminal:event-new', status: 'running' }] },
      }),
      '',
    ].join('\n')), socket);

    assert.deepStrictEqual((await staleList).map(session => session.id), ['terminal:event-new']);
    assert.deepStrictEqual(client.list().map(session => session.id), ['terminal:event-new']);

    const resolvers = [];
    client.request = () => new Promise(resolve => { resolvers.push(resolve); });
    const olderRequest = client.listFresh();
    const newerRequest = client.listFresh();
    resolvers[1]([{ id: 'terminal:list-newest', status: 'running' }]);
    await newerRequest;
    resolvers[0]([{ id: 'terminal:list-older', status: 'running' }]);
    await olderRequest;

    assert.deepStrictEqual(client.list().map(session => session.id), ['terminal:list-newest']);
  });

  test('업데이트 종료는 최신 상태와 진행 중인 retire를 기다린 뒤 관리형 작업은 분리하고 직접 작업은 중지한다', async () => {
    const client = new TerminalHostClient({ discoveryFile: path.join(temp, 'unused-update-host.json') });
    const sessions = [
      { id: 'managed', status: 'running', backend: 'managed-tmux' },
      { id: 'direct', status: 'starting', backend: 'direct' },
      { id: 'finished', status: 'exited', backend: 'direct' },
    ];
    const calls = [];
    const frames = [];
    client.connected = true;
    client.discovery = { pid: 2_147_483_646 };
    client.socket = {
      destroyed: false,
      write: value => { frames.push(JSON.parse(String(value).trim())); return true; },
      end() { this.destroyed = true; },
    };
    const updateRequest = async (operation, ...args) => {
      calls.push([operation, ...args]);
      if (operation === 'list') return sessions;
      if (operation === 'detach' || operation === 'stop') {
        const session = sessions.find(candidate => candidate.id === args[0]);
        if (session) session.status = operation === 'detach' ? 'detached' : 'stopped';
      }
      return { ok: true };
    };
    client.request = updateRequest;
    client.requestForUpdate = updateRequest;

    const fresh = await client.listFresh();
    await assert.rejects(
      client.shutdownForUpdate(fresh.filter(session => session.id !== 'managed'), 1_000),
      /새 명령창 작업이 시작/,
    );
    calls.length = 0;
    const result = await client.shutdownForUpdate(fresh, 1_000);

    assert.deepStrictEqual(calls, [
      ['list'],
      ['detach', 'managed', { waitForExit: true }],
      ['stop', 'direct', { waitForExit: true }],
      ['list'],
    ]);
    assert.deepStrictEqual(frames, [{ type: 'control', operation: 'shutdown-if-idle' }]);
    assert.equal(result.stopped, 2);
    assert.equal(client.disposed, true);
    assert.equal(client.socket.destroyed, true);
    assert.throws(() => client.create({}), /업데이트를 준비하는 동안/);

    let blockedTransitionKills = 0;
    const blockedTransitionManager = new TerminalManager({
      storeFile: path.join(temp, 'terminal-transition-persist-blocked.json'),
      killTree: () => {
        blockedTransitionKills += 1;
        return { ok: true, exited: true };
      },
      ptyModule: { spawn: () => ({
        pid: 8_816, onData() {}, onExit() {}, write() {}, resize() {}, kill() {},
      }) },
    });
    const blockedTransitionSession = blockedTransitionManager.create({
      type: process.platform === 'win32' ? 'powershell' : 'shell', cwd: root,
    });
    blockedTransitionManager.storeWriteBlocked = true;
    assert.throws(
      () => blockedTransitionManager.stop(blockedTransitionSession.id),
      error => error.code === 'TERMINAL_TRANSITION_PERSIST_FAILED',
    );
    assert.equal(blockedTransitionKills, 0, 'pending marker 저장 실패 뒤 process kill을 시작하면 안 됩니다.');
    assert.equal(blockedTransitionManager.get(blockedTransitionSession.id).status, 'running');
    assert.equal(blockedTransitionManager.get(blockedTransitionSession.id).terminationPending, false);
    blockedTransitionManager.storeWriteBlocked = false;
    assert.equal(blockedTransitionManager.close(blockedTransitionSession.id).ok, true);

    let releaseStopAcknowledgement;
    const stopAcknowledgement = new Promise(resolve => { releaseStopAcknowledgement = resolve; });
    let confirmedKillCalls = 0;
    class ConfirmedStopPty {
      constructor() { this.pid = 8_807; this.exitCallbacks = new Set(); }
      onData() {}
      onExit(callback) { this.exitCallbacks.add(callback); }
      write() {}
      resize() {}
      kill() { throw new Error('confirmed stop은 releaseProcess를 사용하면 안 됩니다.'); }
      emitExit(event = { exitCode: 0, signal: 0 }) {
        for (const callback of [...this.exitCallbacks]) callback(event);
      }
    }
    const confirmedStopStore = path.join(temp, 'terminal-confirmed-stop-pending.json');
    const confirmedStopManager = new TerminalManager({
      storeFile: confirmedStopStore,
      killTree: () => {
        confirmedKillCalls += 1;
        return stopAcknowledgement;
      },
      ptyModule: { spawn: () => new ConfirmedStopPty() },
    });
    const confirmedStopSession = confirmedStopManager.create({
      type: process.platform === 'win32' ? 'powershell' : 'shell',
      cwd: root,
    });
    const confirmedHandle = confirmedStopManager.sessions.get(confirmedStopSession.id).process;
    const confirmedPid = confirmedStopManager.sessions.get(confirmedStopSession.id).pid;
    const confirmedGeneration = confirmedStopManager.sessions.get(confirmedStopSession.id).generation;
    const confirmedSuffix = `${process.pid}-${Date.now()}-confirmed-stop`;
    const confirmedDiscovery = path.join(temp, `terminal-host-update-stop-${confirmedSuffix}.json`);
    const confirmedEndpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-update-stop-${confirmedSuffix}`
      : path.join(os.tmpdir(), `lta-host-update-stop-${confirmedSuffix}.sock`);
    const confirmedServer = new TerminalHostServer({
      manager: confirmedStopManager,
      endpoint: confirmedEndpoint,
      discoveryFile: confirmedDiscovery,
      token: 'update-stop-token',
    });
    const confirmedClient = new TerminalHostClient({ discoveryFile: confirmedDiscovery });
    let confirmedShutdown = null;
    try {
      await confirmedServer.start();
      await confirmedClient.connect();
      const confirmedSessions = await confirmedClient.listFresh();
      confirmedClient.discovery = { ...confirmedClient.discovery, pid: 2_147_483_646 };
      let confirmedShutdownSettled = false;
      confirmedShutdown = confirmedClient.shutdownForUpdate(confirmedSessions, 1_000).then(result => {
        confirmedShutdownSettled = true;
        return result;
      });
      assert.equal(await waitUntil(() => confirmedStopManager.get(confirmedStopSession.id)?.status === 'stopping'), true);
      await new Promise(resolve => setTimeout(resolve, 80));
      const stoppingRecord = confirmedStopManager.sessions.get(confirmedStopSession.id);
      assert.equal(confirmedShutdownSettled, false, '실제 process-tree 종료 ACK 전에 업데이트 종료가 완료되면 안 됩니다.');
      assert.equal(confirmedKillCalls, 1);
      assert.equal(stoppingRecord.process, confirmedHandle);
      assert.equal(stoppingRecord.pid, confirmedPid);
      assert.equal(stoppingRecord.generation, confirmedGeneration);
      const persistedPending = JSON.parse(fs.readFileSync(confirmedStopStore, 'utf8')).sessions[0];
      assert.equal(persistedPending.status, 'stopping');
      assert.equal(persistedPending.terminationPending, true);
      assert.equal(persistedPending.terminationIntent, 's');
      const sameStopTransition = confirmedStopManager.stop(confirmedStopSession.id);
      assert.strictEqual(sameStopTransition, confirmedStopManager.stop(confirmedStopSession.id, { waitForExit: true }));
      assert.throws(
        () => confirmedStopManager.restart(confirmedStopSession.id),
        error => error.code === 'TERMINAL_STOP_IN_PROGRESS',
      );
      assert.throws(
        () => confirmedStopManager.close(confirmedStopSession.id),
        error => error.code === 'TERMINAL_STOP_IN_PROGRESS',
      );
      assert.throws(
        () => confirmedClient.close(confirmedStopSession.id),
        /업데이트를 준비하는 동안/,
      );

      const interruptedStore = path.join(temp, 'terminal-confirmed-stop-interrupted.json');
      fs.copyFileSync(confirmedStopStore, interruptedStore);
      const interruptedManager = new TerminalManager({
        storeFile: interruptedStore,
        killTree: () => { throw new Error('중단된 transition을 자동 재시도하면 안 됩니다.'); },
      });
      const interruptedRecord = interruptedManager.get(confirmedStopSession.id);
      assert.equal(interruptedRecord.status, 'stopping');
      assert.equal(interruptedRecord.terminationUncertain, true);
      assert.equal(interruptedRecord.terminationErrorCode, 'TERMINATION_INTERRUPTED');
      assert.throws(
        () => interruptedManager.stop(confirmedStopSession.id),
        error => error.code === 'TERMINATION_INTERRUPTED' && error.terminationUncertain === true,
      );
      interruptedManager.dispose({ preserveSessions: true });
      confirmedHandle.emitExit();
      await new Promise(resolve => setImmediate(resolve));
      const exitedButPendingRecord = confirmedStopManager.sessions.get(confirmedStopSession.id);
      assert.equal(exitedButPendingRecord.status, 'stopping', 'onExit만으로 confirmed stop을 완료 처리하면 안 됩니다.');
      assert.equal(exitedButPendingRecord.process, null);
      assert.equal(exitedButPendingRecord.pid, null);
      assert.equal(confirmedShutdownSettled, false);

      releaseStopAcknowledgement({ ok: true, exited: true });
      const confirmedResult = await confirmedShutdown;
      const stoppedRecord = confirmedStopManager.sessions.get(confirmedStopSession.id);
      assert.equal(confirmedResult.stopped, 1);
      assert.equal(confirmedShutdownSettled, true);
      assert.equal(stoppedRecord.status, 'stopped');
      assert.equal(stoppedRecord.process, null);
      assert.equal(stoppedRecord.pid, null);
      assert.equal(stoppedRecord.generation, confirmedGeneration);
      assert.equal((await sameStopTransition).status, 'stopped');
      const persistedStopped = JSON.parse(fs.readFileSync(confirmedStopStore, 'utf8')).sessions[0];
      assert.equal(persistedStopped.terminationPending, false);
      assert.equal(persistedStopped.terminationIntent, '');

      let postShutdownSpawnCalls = 0;
      confirmedClient.spawnHost = () => { postShutdownSpawnCalls += 1; };
      const postShutdownConnectGeneration = confirmedClient.connectGeneration;
      await assert.rejects(confirmedClient.connect(), /업데이트를 준비하는 동안/);
      await assert.rejects(confirmedClient.listFresh(), /업데이트를 준비하는 동안/);
      await assert.rejects(confirmedClient.get(confirmedStopSession.id), /업데이트를 준비하는 동안/);
      await assert.rejects(confirmedClient.write(confirmedStopSession.id, '업데이트 뒤 쓰기 금지'), /업데이트를 준비하는 동안/);
      await assert.rejects(confirmedClient.command(confirmedStopSession.id, '업데이트 뒤 명령 금지'), /업데이트를 준비하는 동안/);
      await assert.rejects(confirmedClient.resize(confirmedStopSession.id, 120, 40), /업데이트를 준비하는 동안/);
      assert.throws(() => confirmedClient.signal(confirmedStopSession.id, 'interrupt'), /업데이트를 준비하는 동안/);
      assert.throws(
        () => confirmedClient.detach(confirmedStopSession.id, { waitForExit: true }),
        /업데이트를 준비하는 동안/,
      );
      assert.throws(
        () => confirmedClient.stop(confirmedStopSession.id, { waitForExit: true }),
        /업데이트를 준비하는 동안/,
      );
      assert.equal(postShutdownSpawnCalls, 0, '업데이트 종료 뒤 polling/입력이 새 호스트를 시작하면 안 됩니다.');
      assert.equal(confirmedClient.connectGeneration, postShutdownConnectGeneration);
    } finally {
      releaseStopAcknowledgement({ ok: true, exited: true });
      await Promise.resolve(confirmedShutdown).catch(() => {});
      confirmedClient.dispose();
      confirmedServer.dispose();
      confirmedStopManager.dispose();
    }

    let releaseManagedDetach;
    const managedDetachGate = new Promise(resolve => { releaseManagedDetach = resolve; });
    let managedKillCalls = 0;
    let managedStopCalls = 0;
    class ManagedDetachPty {
      constructor() { this.pid = 8_815; this.exitCallbacks = new Set(); }
      onData() {}
      onExit(callback) { this.exitCallbacks.add(callback); }
      write() {}
      resize() {}
      kill() { throw new Error('confirmed detach는 releaseProcess를 사용하면 안 됩니다.'); }
      emitExit(event = { exitCode: 0, signal: 0 }) {
        for (const callback of [...this.exitCallbacks]) callback(event);
      }
    }
    const managedDetachHandle = new ManagedDetachPty();
    const managedDetachManager = new TerminalManager({
      platform: 'darwin',
      killTree: () => {
        managedKillCalls += 1;
        return managedDetachGate;
      },
      managedTmuxRuntime: {
        exists: () => true,
        stop: () => {
          managedStopCalls += 1;
          return { ok: true };
        },
      },
      ptyModule: { spawn: () => managedDetachHandle },
    });
    const managedDetachSession = managedDetachManager.create({
      type: 'agent',
      provider: 'codex',
      cwd: root,
      sessionBackend: 'managed-tmux',
      managedTmuxSession: 'update-confirmed-detach',
    });
    const managedSuffix = `${process.pid}-${Date.now()}-confirmed-detach`;
    const managedDiscovery = path.join(temp, `terminal-host-update-detach-${managedSuffix}.json`);
    const managedEndpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-update-detach-${managedSuffix}`
      : path.join(os.tmpdir(), `lta-host-update-detach-${managedSuffix}.sock`);
    const managedServer = new TerminalHostServer({
      manager: managedDetachManager,
      endpoint: managedEndpoint,
      discoveryFile: managedDiscovery,
      token: 'update-detach-token',
    });
    const managedClient = new TerminalHostClient({ discoveryFile: managedDiscovery });
    let managedShutdown = null;
    try {
      await managedServer.start();
      await managedClient.connect();
      const managedSessions = await managedClient.listFresh();
      managedClient.discovery = { ...managedClient.discovery, pid: 2_147_483_646 };
      let managedShutdownSettled = false;
      managedShutdown = managedClient.shutdownForUpdate(managedSessions, 1_000).then(result => {
        managedShutdownSettled = true;
        return result;
      });
      assert.equal(await waitUntil(() => managedDetachManager.get(managedDetachSession.id)?.status === 'stopping'), true);
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(managedShutdownSettled, false);
      assert.equal(managedKillCalls, 1);
      assert.equal(managedStopCalls, 0, '업데이트 detach는 tmux 작업 자체를 종료하면 안 됩니다.');
      assert.ok(managedDetachManager.get(managedDetachSession.id));
      managedDetachHandle.emitExit();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(managedDetachManager.get(managedDetachSession.id).status, 'stopping');
      assert.equal(managedShutdownSettled, false);

      releaseManagedDetach({ ok: true, exited: true });
      const managedResult = await managedShutdown;
      const detachedRecord = managedDetachManager.get(managedDetachSession.id);
      assert.equal(managedResult.stopped, 1);
      assert.equal(detachedRecord.status, 'detached');
      assert.ok(detachedRecord, '업데이트 detach 뒤 tmux 세션 레코드는 살아 있어야 합니다.');
      assert.equal(managedStopCalls, 0);
    } finally {
      releaseManagedDetach({ ok: true, exited: true });
      await Promise.resolve(managedShutdown).catch(() => {});
      managedClient.dispose();
      managedServer.dispose();
      managedDetachManager.dispose({ preserveSessions: true });
    }

    let releaseRetirement;
    const retirementGate = new Promise(resolve => { releaseRetirement = resolve; });
    class RetiringPty {
      constructor() { this.pid = 8_803; }
      onData() {}
      onExit() {}
      write() {}
      resize() {}
      kill() {}
    }
    const manager = new TerminalManager({
      killTree: () => retirementGate,
      ptyModule: { spawn: () => new RetiringPty() },
    });
    const retiringSession = manager.create({
      type: process.platform === 'win32' ? 'powershell' : 'shell',
      cwd: root,
    });
    const suffix = `${process.pid}-${Date.now()}`;
    const overlapDiscovery = path.join(temp, `terminal-host-update-retire-${suffix}.json`);
    const overlapEndpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\loadtoagent-host-update-retire-${suffix}`
      : path.join(os.tmpdir(), `lta-host-update-retire-${suffix}.sock`);
    const overlapServer = new TerminalHostServer({
      manager,
      endpoint: overlapEndpoint,
      discoveryFile: overlapDiscovery,
      token: 'update-retire-token',
    });
    const retireClient = new TerminalHostClient({ discoveryFile: overlapDiscovery });
    const updateClient = new TerminalHostClient({ discoveryFile: overlapDiscovery });
    let retirement = null;
    let overlappingShutdown = null;
    try {
      await overlapServer.start();
      await retireClient.connect();
      await updateClient.connect();
      const confirmedBeforeRetire = await updateClient.listFresh();
      retirement = retireClient.close(retiringSession.id);
      assert.equal(await waitUntil(() => manager.get(retiringSession.id)?.status === 'stopping'), true);

      // The host runs in this test process, so use a guaranteed-nonexistent PID
      // for shutdownForUpdate's final daemon-exit check.
      updateClient.discovery = { ...updateClient.discovery, pid: 2_147_483_646 };
      let shutdownSettled = false;
      overlappingShutdown = updateClient.shutdownForUpdate(confirmedBeforeRetire, 1_000).then(result => {
        shutdownSettled = true;
        return result;
      });
      await new Promise(resolve => setTimeout(resolve, 120));
      assert.equal(shutdownSettled, false, 'retire process-tree 종료 ack 전에 업데이트 종료가 완료되면 안 됩니다.');
      assert.equal(manager.get(retiringSession.id)?.status, 'stopping');

      releaseRetirement({ ok: true });
      assert.deepStrictEqual(await retirement, { ok: true });
      const overlapResult = await overlappingShutdown;
      assert.equal(overlapResult.stopped, 0);
      assert.equal(manager.get(retiringSession.id), null);
      assert.equal(shutdownSettled, true);
    } finally {
      releaseRetirement({ ok: true });
      await Promise.resolve(retirement).catch(() => {});
      await Promise.resolve(overlappingShutdown).catch(() => {});
      retireClient.dispose();
      updateClient.dispose();
      overlapServer.dispose();
      manager.dispose();
    }
  });

  test('마지막 클라이언트가 떠나도 retire 중에는 호스트를 유지하고 완료 뒤 스스로 종료한다', async () => {
    class EmptyManager extends EventEmitter {
      constructor() {
        super();
        this.sessions = [{ id: 'terminal:retiring', status: 'stopping' }];
      }
      list() { return this.sessions.map(session => ({ ...session })); }
      finishRetirement() {
        this.sessions = [];
        this.emit('state', { change: 'removed', sessions: [] });
      }
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
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(shutdowns, 0, 'retire 중인 세션을 idle로 판단해 호스트를 종료하면 안 됩니다.');
    manager.finishRetirement();
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
          options: { type: 'powershell', cwd: root, sessionBackend: 'direct' },
          status: 'running', createdAt: timestamp, updatedAt: timestamp, replay: 'before',
        },
        {
          id: 'terminal:missing-cwd',
          options: { type: 'powershell', cwd: path.join(storeDir, 'missing'), sessionBackend: 'direct' },
          status: 'running', createdAt: timestamp, updatedAt: timestamp, replay: 'missing',
        },
        {
          id: 'terminal:valid-after',
          options: { type: 'powershell', cwd: root, sessionBackend: 'direct' },
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
      platform: 'win32',
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

  test('v2 터미널 저장소의 필수 실행 설정이 손상되면 자동으로 셸을 시작하지 않는다', () => {
    const storeDir = path.join(temp, 'terminal-store-invalid-v2-options');
    const storeFile = path.join(storeDir, 'terminal-sessions.json');
    const timestamp = '2026-08-01T00:00:00.000Z';
    const original = JSON.stringify({
      version: 2,
      sessions: [
        {
          id: 'terminal:valid-shell',
          options: { type: 'powershell', cwd: root, sessionBackend: 'direct' },
          status: 'running', createdAt: timestamp, updatedAt: timestamp,
        },
        {
          id: 'terminal:missing-options',
          status: 'running', createdAt: timestamp, updatedAt: timestamp,
        },
        {
          id: 'terminal:missing-type',
          options: { cwd: root, sessionBackend: 'direct' },
          status: 'running', createdAt: timestamp, updatedAt: timestamp,
        },
        {
          id: 'terminal:unknown-type',
          options: { type: 'unknown', cwd: root, sessionBackend: 'direct' },
          status: 'running', createdAt: timestamp, updatedAt: timestamp,
        },
        {
          id: 'terminal:whitespace-type',
          options: { type: 'agent ', provider: 'codex', cwd: root, args: ['resume', 'must-not-run'], sessionBackend: 'direct' },
          status: 'running', createdAt: timestamp, updatedAt: timestamp,
        },
        {
          id: 'terminal:missing-cwd',
          options: { type: 'powershell', sessionBackend: 'direct' },
          status: 'running', createdAt: timestamp, updatedAt: timestamp,
        },
      ],
    });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(storeFile, original, 'utf8');
    const spawns = [];
    const persistenceErrors = [];
    class FakePty {
      constructor() { this.pid = 19_000 + spawns.length; }
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
      onPersistenceError: (operation, error) => persistenceErrors.push([operation, error.message]),
      ptyModule: {
        spawn: () => {
          const handle = new FakePty();
          spawns.push(handle);
          return handle;
        },
      },
    });

    assert.deepStrictEqual(manager.list().map(session => session.id), ['terminal:valid-shell']);
    assert.deepStrictEqual(manager.recoverPersistedSessions().map(session => session.id), ['terminal:valid-shell']);
    assert.equal(spawns.length, 1);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(storeFile, 'utf8')).sessions.map(session => session.id), ['terminal:valid-shell']);
    assert.equal(persistenceErrors.filter(([operation]) => operation === 'load-record').length, 5);
    const quarantine = fs.readdirSync(storeDir)
      .find(name => name.startsWith('terminal-sessions.json.unreadable-'));
    assert.ok(quarantine);
    assert.equal(fs.readFileSync(path.join(storeDir, quarantine), 'utf8'), original);
    manager.dispose({ preserveSessions: true });
  });

  test('v2 Windows WSL 직접 AI 세션은 빈 작업 폴더를 보존해 안전하게 복구한다', () => {
    const storeDir = path.join(temp, 'terminal-store-valid-wsl-agent');
    const storeFile = path.join(storeDir, 'terminal-sessions.json');
    const timestamp = '2026-08-01T00:00:00.000Z';
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify({
      version: 2,
      sessions: [
        {
          id: 'terminal:wsl-agent',
          options: {
            type: 'agent',
            provider: 'codex',
            cwd: '',
            distro: 'Ubuntu',
            args: ['resume', 'wsl-session-123'],
            sessionBackend: 'direct',
          },
          status: 'running',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: 'terminal:tmux-pane',
          options: {
            type: 'tmux',
            cwd: '',
            distro: 'Ubuntu',
            tmuxSession: 'work',
            tmuxWindow: '@7',
            tmuxPane: '%19',
            tmuxPanePid: 4190,
            agentConnectionSignature: '["tmux-signature-v1"]',
            sessionBackend: 'direct',
          },
          status: 'running',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    }), 'utf8');
    const spawns = [];
    const exactProxySpawns = [];
    class FakePty {
      constructor() { this.pid = 20_001; }
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
        spawn: (file, args, options) => {
          spawns.push({ file, args, options });
          return new FakePty();
        },
      },
      tmuxControlProxyFactory: encoded => {
        exactProxySpawns.push(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
        return new FakePty();
      },
    });

    assert.equal(manager.list()[0].cwd, '');
    assert.deepStrictEqual(manager.recoverPersistedSessions().map(session => session.id), ['terminal:wsl-agent']);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].file, 'wsl.exe');
    assert.deepStrictEqual(spawns[0].args, ['-d', 'Ubuntu', '--', 'codex', 'resume', 'wsl-session-123']);
    assert.equal(manager.list()[0].cwd, '');
    assert.equal(manager.get('terminal:tmux-pane'), null, 'process identity 없는 legacy external tmux record는 복구하면 안 됩니다.');
    assert.equal(exactProxySpawns.length, 0);
    assert.equal(manager.get('terminal:wsl-agent').agentConnectionSignature, '');
    assert.equal(manager.get('terminal:wsl-agent').agentResumeSessionId, 'wsl-session-123');
    manager.persistNow();
    const storedTmux = JSON.parse(fs.readFileSync(storeFile, 'utf8')).sessions
      .find(session => session.id === 'terminal:tmux-pane');
    assert.equal(storedTmux, undefined);
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
      platform: 'win32',
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
      platform: 'win32',
      killTree: () => {},
      ptyModule: {
        spawn: () => {
          const handle = new FakePty(17_900 + replayCapProcesses.length);
          replayCapProcesses.push(handle);
          return handle;
        },
      },
    });
    const replayCapSession = replayCapManager.create({ type: 'powershell', cwd: root });
    replayCapProcesses[0].dataCallback(`😀${'x'.repeat(512 * 1024 - 1)}`);
    const characterCappedReplay = replayCapManager.get(replayCapSession.id, true).replay;
    assert.equal(characterCappedReplay.length, 512 * 1024 + 1);
    assert.equal(hasUnpairedSurrogate(characterCappedReplay), false);
    let burstEvents = 0;
    replayCapManager.on('data', payload => {
      if (payload.id === replayCapSession.id) burstEvents += 1;
    });
    const burstChunk = 'z'.repeat(16 * 1024);
    for (let index = 0; index < 192; index += 1) replayCapProcesses[0].dataCallback(burstChunk);
    const replayCapInternal = replayCapManager.sessions.get(replayCapSession.id);
    replayCapProcesses[0].dataCallback('A');
    assert.equal(replayCapInternal.replayPendingChars, 1,
      '작은 PTY 조각은 live event를 즉시 내보내되 replay 전체를 매번 복사하지 않아야 합니다.');
    const batchedReplay = replayCapManager.get(replayCapSession.id, true).replay;
    assert.equal(batchedReplay.length, 2 * 1024 * 1024);
    assert.equal(batchedReplay.endsWith('A'), true);
    assert.equal(hasUnpairedSurrogate(batchedReplay), false);
    assert.equal(burstEvents, 193, 'replay batching이 live PTY 출력 event를 합치거나 늦추면 안 됩니다.');
    replayCapManager.dispose();

    let manager = new TerminalManager(managerOptions());
    const created = manager.create({ type: 'powershell', cwd: root });
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
    manager = new TerminalManager(managerOptions(replaylessBytes + 16));
    manager.restart(created.id);
    const retainedTail = `${String.fromCharCode(92, 27)}😀`;
    const fullReplay = `discarded😀${retainedTail}`;
    processes.at(-1).dataCallback(fullReplay);
    assert.equal(manager.persistNow(), true);
    stored = JSON.parse(fs.readFileSync(storeFile, 'utf8')).sessions[0];
    assert.equal(stored.replay, retainedTail);
    assert.equal(hasUnpairedSurrogate(stored.replay), false);
    assert.equal(manager.get(created.id, true).replay, fullReplay);
    assert.equal(fs.statSync(storeFile).size <= replaylessBytes + 16, true);
    manager.dispose({ preserveSessions: true });

    const sparseStoreFile = path.join(storeDir, 'sparse-terminal-sessions.json');
    const sparseProcesses = [];
    const sparseManager = new TerminalManager({
      platform: 'win32',
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
    const replayOwner = sparseManager.create({ type: 'powershell', cwd: root });
    sparseManager.create({ type: 'powershell', cwd: root });
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
       ...managerOptions(1),
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

  test('Windows npm AI 명령은 실행 가능한 PowerShell 호스트로 열고 배치 인자를 코드와 분리한다', () => {
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

    // Keep the real cmd.exe injection regression independent from environment-
    // derived temp paths. The command under test still receives hostile argv,
    // but every executable and fixture path used by this test is rooted in the
    // checked-out repository.
    const batchSandbox = path.join(root, 'artifacts', `windows-agent-batch-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    const batchDir = path.join(batchSandbox, 'node_modules', '.bin');
    fs.mkdirSync(batchDir, { recursive: true });
    const captureFile = path.join(batchDir, 'captured-args.json');
    const injectedFile = path.join(batchDir, 'batch-injected.txt');
    const captureScript = path.join(batchDir, 'capture-args.js');
    const batchShim = path.join(batchDir, 'codex.cmd');
    fs.writeFileSync(captureScript, `require('fs').writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(2)), 'utf8');\n`, 'utf8');
    fs.writeFileSync(batchShim, `@echo off\r\n"${process.execPath}" "${captureScript}" %*\r\n`, 'utf8');
    const batchArguments = [
      '--normal-provider-arg',
      'run',
      'safe-session-id',
      '--',
      'normal prompt',
      'x&whoami',
      'x&echo INJECTED>batch-injected.txt',
      '%PATH%',
      '!LOADTOAGENT_LITERAL_TEST!',
      'embedded"quote',
      String.raw`two-backslashes-before-quote:a\\"b`,
      'argument-after-backslash-quote',
      'x|whoami',
      'caret^value',
    ];
    const batchSpec = launchSpec(normalizeLaunchOptions({
      type: 'agent',
      provider: 'codex',
      args: batchArguments.slice(1),
      cwd: batchDir,
      sessionBackend: 'direct',
    }, 'win32'), 'win32', {
      codex: { command: batchShim, args: batchArguments.slice(0, 1), label: 'Codex batch' },
    });
    assert.ok(/cmd\.exe$/i.test(batchSpec.file));
    assert.equal(typeof batchSpec.args, 'string');
    assert.match(batchSpec.args, /^\/d \/v:off \/s \/c "/);
    assert.equal(batchSpec.args.includes('x&whoami'), false);
    const commandLine = batchSpec.args.slice('/d /v:off /s /c '.length);
    assert.equal(['/d', '/v:off', '/s', '/c', commandLine].join(' '), batchSpec.args);
    const trustedCmd = 'C:\\Windows\\System32\\cmd.exe';
    if (process.platform === 'win32') {
      // node-pty treats a string args value as an already assembled command
      // line. spawnSync below uses the identical tail verbatim, so the real
      // cmd.exe execution also verifies the ConPTY serialization contract.
      const { argsToCommandLine: nodePtyArgsToCommandLine } = require('node-pty/lib/windowsPtyAgent');
      assert.equal(
        nodePtyArgsToCommandLine(batchSpec.file, batchSpec.args),
        `${nodePtyArgsToCommandLine(batchSpec.file, [])} ${batchSpec.args}`,
      );
      assert.equal(path.win32.normalize(batchSpec.file).toLowerCase(), path.win32.normalize(trustedCmd).toLowerCase());
      const launched = spawnSync(trustedCmd, ['/d', '/v:off', '/s', '/c', commandLine], {
        cwd: batchSpec.cwd,
        env: { ...process.env, LOADTOAGENT_LITERAL_TEST: 'EXPANDED' },
        encoding: 'utf8',
        timeout: 10_000,
        windowsVerbatimArguments: true,
      });
      assert.equal(launched.error, undefined);
      assert.equal(launched.status, 0, launched.stderr || launched.stdout);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(captureFile, 'utf8')), batchArguments);
      assert.equal(fs.existsSync(injectedFile), false);

      // An explicit /v:off must win even if a parent/default invocation has
      // delayed expansion enabled. Otherwise !NAME! can disclose environment
      // values into a prompt before the agent starts.
      fs.rmSync(captureFile, { force: true });
      const launchedAfterDelayedExpansion = spawnSync(trustedCmd, ['/d', '/v:on', '/v:off', '/s', '/c', commandLine], {
        cwd: batchSpec.cwd,
        env: { ...process.env, LOADTOAGENT_LITERAL_TEST: 'EXPANDED' },
        encoding: 'utf8',
        timeout: 10_000,
        windowsVerbatimArguments: true,
      });
      assert.equal(launchedAfterDelayedExpansion.error, undefined);
      assert.equal(launchedAfterDelayedExpansion.status, 0, launchedAfterDelayedExpansion.stderr || launchedAfterDelayedExpansion.stdout);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(captureFile, 'utf8')), batchArguments);
    }

    if (process.platform === 'win32') fs.rmSync(captureFile, { force: true });
    const batShim = path.join(batchDir, 'gemini.bat');
    fs.writeFileSync(batShim, `@echo off\r\n"${process.execPath}" "${captureScript}" %*\r\n`, 'utf8');
    const batSpec = launchSpec(normalizeLaunchOptions({
      type: 'agent', provider: 'gemini', args: batchArguments, cwd: batchDir, sessionBackend: 'direct',
    }, 'win32'), 'win32', { gemini: { command: batShim, label: 'Gemini batch' } });
    const batCommandLine = batSpec.args.slice('/d /v:off /s /c '.length);
    assert.equal(['/d', '/v:off', '/s', '/c', batCommandLine].join(' '), batSpec.args);
    if (process.platform === 'win32') {
      const batLaunched = spawnSync(trustedCmd, ['/d', '/v:off', '/s', '/c', batCommandLine], {
        cwd: batSpec.cwd,
        env: { ...process.env, LOADTOAGENT_LITERAL_TEST: 'EXPANDED' },
        encoding: 'utf8',
        timeout: 10_000,
        windowsVerbatimArguments: true,
      });
      assert.equal(batLaunched.error, undefined);
      assert.equal(batLaunched.status, 0, batLaunched.stderr || batLaunched.stdout);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(captureFile, 'utf8')), batchArguments);
      assert.equal(fs.existsSync(injectedFile), false);
    }

    assert.throws(() => normalizeLaunchOptions({
      type: 'agent', provider: 'codex', args: ['resume', 'x&whoami'], cwd: batchDir, sessionBackend: 'direct',
    }, 'win32'), /AI 대화 ID 형식/);
    assert.throws(() => normalizeLaunchOptions({
      type: 'agent', provider: 'codex', args: ['resume', 'safe-id', 'resume'], cwd: batchDir, sessionBackend: 'direct',
    }, 'win32'), /한 번만 지정/);
    assert.throws(() => normalizeLaunchOptions({
      type: 'agent', provider: 'codex', args: ['resume', '--', 'safe-id', '--resume'], cwd: batchDir, sessionBackend: 'direct',
    }, 'win32'), /한 번만 지정/);
    assert.throws(() => normalizeLaunchOptions({
      type: 'agent', provider: 'claude', args: ['--resume', 'x|whoami'], cwd: batchDir, sessionBackend: 'direct',
    }, 'win32'), /AI 대화 ID 형식/);
    assert.throws(() => normalizeLaunchOptions({
      type: 'agent', provider: 'claude', args: ['--resume', 'safe-id', '--resume', 'x&whoami'], cwd: batchDir, sessionBackend: 'direct',
    }, 'win32'), /한 번만 지정/);
    assert.throws(() => normalizeLaunchOptions({
      type: 'agent', provider: 'gemini', args: ['--model', 'flash', '--resume', 'safe-id'], cwd: batchDir, sessionBackend: 'direct',
    }, 'win32'), /한 번만 지정/);
    assert.deepStrictEqual(normalizeLaunchOptions({
      type: 'agent', provider: 'claude', args: ['--resume', 'safe-id', '--', '--resume'], cwd: batchDir, sessionBackend: 'direct',
    }, 'win32').args, ['--resume', 'safe-id', '--', '--resume']);
    assert.equal(normalizeLaunchOptions({
      type: 'agent', provider: 'claude', args: ['--resume', 'safe-id'], cwd: batchDir,
      agentConnectionSignature: 's'.repeat(1_200), sessionBackend: 'direct',
    }, 'win32').agentConnectionSignature.length, 1_000);
    assert.throws(() => normalizeLaunchOptions({
      type: 'agent', provider: 'codex', args: ['resume', 'safe-id', '--', 'line one\r\nwhoami'], cwd: batchDir, sessionBackend: 'direct',
    }, 'win32'), /줄바꿈 문자/);
    fs.rmSync(batchSandbox, { recursive: true, force: true });

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

    const filtered = snapshotWithoutSessions({
      generatedAt: '2026-08-10T00:00:00Z',
      sessions: [
        { id: 'claude:binding-failed', provider: 'claude', status: 'running', parentId: null, usage: { input: 10, output: 5, total: 15 } },
        { id: 'codex:unrelated', provider: 'codex', status: 'running', parentId: null, usage: { input: 7, output: 3, total: 10 } },
      ],
      summary: buildSummary([], {}),
    }, ['claude:binding-failed'], { claude: 'claude.exe', codex: 'codex.exe' });
    assert.deepStrictEqual(filtered.sessions.map(item => item.id), ['codex:unrelated']);
    assert.equal(filtered.summary.totals.sessions, 1);
    assert.equal(filtered.summary.totals.active, 1);
    assert.equal(filtered.summary.totals.usage.total, 10);
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
