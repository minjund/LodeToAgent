'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { providerList, normalizeProvider, modelContextWindow } = require('../src/providerRegistry');
const { parseClaude, parseCodex, parseGeneric, buildSummary, attachHierarchy, isProjectlessSession } = require('../src/agentMonitor');
const { commandSpec } = require('../src/agentRunner');
const { TmuxMonitor, normalizeWslList, parseTmuxProbe, buildDistroTopology, linkAgentSessions, providerFromProcess } = require('../src/tmuxMonitor');
const { processRows, posixProcessRows, providerFromPosixProcess, selectAgentProcesses, bridgeLinkScore, applyRuntimePresence } = require('../src/processMonitor');
const { TerminalManager, normalizeLaunchOptions, launchSpec, resolveWindowsCommand } = require('../src/terminalManager');
const { TmuxController, safeName, safeTarget } = require('../src/tmuxController');
const { BridgeServer } = require('../src/bridgeServer');
const { parseArguments, parseCliArguments, desktopLaunchSpec } = require('../bin/loadtoagent');
const { UpdateManager, compareVersions, normalizeVersion, selectReleaseAsset } = require('../src/updateManager');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-test-'));
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

test('npm 전역 명령으로 앱 열기와 브리지 실행을 구분한다', () => {
  assert.deepStrictEqual(parseCliArguments([]), { action: 'open' });
  assert.deepStrictEqual(parseCliArguments(['open']), { action: 'open' });
  assert.deepStrictEqual(parseCliArguments(['--help']), { action: 'help' });
  assert.deepStrictEqual(parseCliArguments(['--version']), { action: 'version' });
  assert.deepStrictEqual(parseCliArguments(['run', 'codex', '--', '--model', 'gpt-5']), {
    action: 'run', provider: 'codex', args: ['--model', 'gpt-5'],
  });
  assert.throws(() => parseCliArguments(['unknown']), /사용법/);
});

test('npm 설치본과 패키지 앱의 데스크톱 실행 경로를 만든다', () => {
  const npmSpec = desktopLaunchSpec({
    env: { PATH: '/usr/bin' },
    electronPath: '/tmp/electron',
    packageRoot: '/tmp/loadtoagent',
  });
  assert.equal(npmSpec.executable, '/tmp/electron');
  assert.deepStrictEqual(npmSpec.args, ['/tmp/loadtoagent']);
  assert.equal(npmSpec.env.PATH, '/usr/bin');

  const packagedSpec = desktopLaunchSpec({
    env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
    execPath: '/Applications/LoadToAgent.app/Contents/MacOS/LoadToAgent',
  });
  assert.equal(packagedSpec.executable, '/Applications/LoadToAgent.app/Contents/MacOS/LoadToAgent');
  assert.deepStrictEqual(packagedSpec.args, []);
  assert.equal('ELECTRON_RUN_AS_NODE' in packagedSpec.env, false);
});

test('Git 태그 버전을 SemVer 순서로 비교한다', () => {
  assert.equal(normalizeVersion('refs/tags/v3.2.1').raw, '3.2.1');
  assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
  assert.equal(compareVersions('3.1.0-beta.2', '3.1.0-beta.10'), -1);
  assert.equal(compareVersions('3.1.0', '3.1.0-beta.10'), 1);
  assert.equal(compareVersions('v3.0.0', '3.0.0'), 0);
  assert.throws(() => compareVersions('latest', '3.0.0'), /버전 형식/);
});

test('운영체제와 CPU에 맞는 신뢰된 GitHub Release 파일을 고른다', () => {
  const base = 'https://github.com/minjund/LodeToAgent/releases/download/v3.1.0/';
  const assets = [
    { name: 'LoadToAgent-3.1.0-portable.exe', browser_download_url: `${base}LoadToAgent-3.1.0-portable.exe`, state: 'uploaded' },
    { name: 'LoadToAgent-Setup-3.1.0.exe', browser_download_url: `${base}LoadToAgent-Setup-3.1.0.exe`, state: 'uploaded' },
    { name: 'LoadToAgent-3.1.0-arm64.dmg', browser_download_url: `${base}LoadToAgent-3.1.0-arm64.dmg`, state: 'uploaded' },
    { name: 'LoadToAgent-3.1.0-x64.dmg', browser_download_url: `${base}LoadToAgent-3.1.0-x64.dmg`, state: 'uploaded' },
    { name: 'LoadToAgent-Setup-9.9.9.exe', browser_download_url: 'https://example.com/fake.exe', state: 'uploaded' },
  ];
  assert.equal(selectReleaseAsset(assets, { platform: 'win32', arch: 'x64', version: '3.1.0' }).name, 'LoadToAgent-Setup-3.1.0.exe');
  assert.equal(selectReleaseAsset(assets, { platform: 'darwin', arch: 'arm64', version: '3.1.0' }).name, 'LoadToAgent-3.1.0-arm64.dmg');
  assert.equal(selectReleaseAsset(assets, { platform: 'linux', arch: 'x64', version: '3.1.0' }), null);
});

test('최신 정식 태그를 확인하고 검증한 업데이트 파일을 저장한다', async () => {
  const downloadDir = path.join(temp, 'updates');
  const payload = Buffer.from('fixture installer payload');
  const digest = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
  const asset = {
    name: 'LoadToAgent-Setup-3.1.0.exe', size: payload.length, digest, state: 'uploaded',
    browser_download_url: 'https://github.com/minjund/LodeToAgent/releases/download/v3.1.0/LoadToAgent-Setup-3.1.0.exe',
  };
  const release = {
    tag_name: 'v3.1.0', draft: false, prerelease: false, published_at: '2026-07-16T00:00:00Z', body: 'fixture notes',
    html_url: 'https://github.com/minjund/LodeToAgent/releases/tag/v3.1.0', assets: [asset],
  };
  const opened = [];
  const manager = new UpdateManager({
    currentVersion: '3.0.0', platform: 'win32', arch: 'x64', downloadsDir: downloadDir,
    fetch: async url => String(url).includes('/releases/latest')
      ? new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } }),
    shell: { openPath: async file => { opened.push(file); return ''; }, openExternal: async () => {} },
  });
  const available = await manager.check();
  assert.equal(available.status, 'available');
  assert.equal(available.latestVersion, '3.1.0');
  assert.equal(available.asset.name, asset.name);
  const downloaded = await manager.download();
  assert.equal(downloaded.status, 'downloaded');
  assert.equal(fs.readFileSync(downloaded.downloadedPath, 'utf8'), payload.toString());
  await manager.openDownloaded();
  assert.deepStrictEqual(opened, [downloaded.downloadedPath]);
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
});

test('잘린 Codex 로그에 내부 목표만 남아도 마크업 없이 카드 제목을 복원한다', () => {
  const session = parseCodex(jsonl(path.join(temp, 'codex', 'rollout-internal-goal-title.jsonl'), [
    { timestamp: '2026-07-14T02:10:00Z', type: 'session_meta', payload: { id: 'internal-goal-title', cwd: 'D:\\repo' } },
    { timestamp: '2026-07-14T02:10:01Z', type: 'event_msg', payload: { type: 'user_message', message: '<codex_internal_context source="goal">\n<untrusted_objective>완료된 서브에이전트는 기본으로 숨겨줘</untrusted_objective>\n</codex_internal_context>' } },
  ]));
  assert.equal(session.title, '완료된 서브에이전트는 기본으로 숨겨줘');
  assert.equal(session.messages.some(item => item.role === 'user' || /codex_internal_context|untrusted_objective/.test(item.text)), false);
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
  assert.equal(bridgeLinkScore({ ...base, provider: 'claude', clientKind: 'claude-desktop', startedAt: bridge.startedAt }, { ...bridge, provider: 'claude' }, now), -Infinity);
  assert.equal(bridgeLinkScore({ ...base, clientKind: 'codex-cli', startedAt: '2026-07-14T09:40:00Z' }, bridge, now), -Infinity);
  assert.ok(bridgeLinkScore({ ...base, clientKind: 'codex-cli', startedAt: '2026-07-14T09:59:35Z' }, bridge, now) > 10_000);
});

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
  assert.equal(launchSpec(macShell, 'darwin').args[0], '-l');
  const macTmux = launchSpec(normalizeLaunchOptions({ type: 'tmux', distro: 'macOS', tmuxSession: 'work' }, 'darwin'), 'darwin');
  assert.notEqual(macTmux.file, 'wsl.exe');
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
  for (const file of ['main.js', 'preload.js', 'bin/loadtoagent.js', 'src/bridgeServer.js', 'src/providerRegistry.js', 'src/agentMonitor.js', 'src/agentRunner.js', 'src/tmuxMonitor.js', 'src/tmuxController.js', 'src/terminalManager.js', 'src/processMonitor.js', 'src/monitorWorker.js', 'renderer/i18n.js', 'renderer/app.js', 'renderer/terminal.js', 'scripts/bridge-integration-test.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  }
});

test('필수 UI 영역과 초보자용 안내 계약이 존재한다', () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const monitorWorker = fs.readFileSync(path.join(root, 'src', 'monitorWorker.js'), 'utf8');
  for (const id of ['mainContent', 'beginnerGuide', 'guideBtn', 'guideProgressBar', 'dismissGuideBtn', 'mobileMoreBtn', 'mobileToolsMenu', 'providerOverview', 'liveSection', 'liveSessionGrid', 'graphBreadcrumbs', 'graphResetBtn', 'terminalSection', 'terminalWorkbench', 'terminalWorkbenchMount', 'terminalStage', 'terminalHistoryPanel', 'terminalHistoryList', 'terminalViewport', 'terminalCommandForm', 'terminalSessionList', 'terminalTmuxList', 'tmuxCreateModal', 'tmuxSection', 'tmuxControlSection', 'tmuxWorkbenchMount', 'tmuxStats', 'tmuxBreadcrumbs', 'tmuxResetBtn', 'tmuxMap', 'sessionGrid', 'loadMoreBtn', 'detailDrawer', 'runModal', 'drawerContent', 'sidebarAppVersion', 'settingsSection', 'languageSettingsTitle', 'languageSelect', 'currentVersion', 'latestVersion', 'checkUpdateBtn', 'updateStateTitle']) assert.ok(html.includes(`id="${id}"`));
  for (const id of ['runPromptCount', 'runWorkspaceSuggestions']) assert.ok(html.includes(`id="${id}"`));
  for (const label of ['첫 10분 코스', '이 네 가지만 익히면 충분해요', 'AI에게 일 맡기기', '진행 상황 확인', '확인할 일 찾기', '작업 자세히 보기', '>홈<', '>진행 중<', '>내 확인 필요<', '기존 세션에 이어서 입력', '>세션 터미널<', 'tmux 전용', '>tmux 작업<', '내 터미널 세션', 'AI 대화 기록', '이 대화가 오른쪽 터미널과 연결되어 있습니다', '실시간 터미널', 'Enter 전송 · Shift+Enter 줄바꿈', 'tmux 안의 명령창만', 'AI에게 새 일 맡기기', 'AI들이 맡은 일', 'tmux 작업 만들기', '현재 설치 버전', '업데이트 확인']) assert.ok(html.includes(label), `${label} 문구가 없습니다.`);
  for (const jargon of ['AI AGENT OBSERVATORY', 'SESSION STREAM', 'AGENT MIND MAP', 'NEW TMUX SESSION']) assert.equal(html.includes(jargon), false, `${jargon} 전문 용어가 기본 화면에 남아 있습니다.`);
  for (const contract of ['function cardCollaboration', 'collaboration: cardCollaboration(session.collaboration)', 'taskName: session.taskName', 'completionObserved: Boolean(session.completionObserved)', 'projectless: Boolean(session.projectless)', 'session.collaboration && session.collaboration.metrics', 'session.collaboration && session.collaboration.communications']) assert.ok(monitorWorker.includes(contract), `${contract} 협업 전송 계약이 없습니다.`);
  const terminalBlock = html.slice(html.indexOf('id="terminalSection"'), html.indexOf('id="tmuxSection"'));
  const tmuxBlock = html.slice(html.indexOf('id="tmuxSection"'), html.indexOf('id="liveSection"'));
  for (const tmuxOnlyId of ['newTmuxSessionBtn', 'terminalTmuxList', 'tmuxControlSection']) {
    assert.equal(terminalBlock.includes(`id="${tmuxOnlyId}"`), false, `${tmuxOnlyId}가 일반 명령창 영역에 섞여 있습니다.`);
    assert.equal(tmuxBlock.includes(`id="${tmuxOnlyId}"`), true, `${tmuxOnlyId}가 tmux 전용 영역에 없습니다.`);
  }
  assert.equal(html.includes('data-view="subagents"'), false);
  assert.equal(html.includes('id="navSubagentCount"'), false);
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  for (const contract of ['function readablePreview', 'function roadmapHtml', 'function runWorkspaceSuggestionsHtml', 'function syncRunComposer', 'function renderUpdateSettings', 'function renderGuide', 'function markGuideStep', 'function trapDialogFocus', 'function selectView', 'sidebarAppVersion', '현재 최신 버전입니다.']) assert.ok(app.includes(contract));
  for (const contract of ['function renderAgentMap', 'function connectedGraphSessions', 'function providerFlowLane', 'function focusedGraph', 'function workflowCompactNode', 'function workflowChildrenSummary', 'function workflowMetrics', 'function workflowCommunicationPanel', 'function subagentWorkState', 'function splitSubagents', 'function completedSubagentDisclosure', 'function agentExecutionMode', 'function executionModeBadge', 'function subagentTextPreview', 'function subagentConversationHtml', 'function openSubagentConversation', 'function resumeAgentTerminal', 'data-collaboration-metric', 'data-collaboration-communications', 'data-open-subagent-chat', 'data-subagent-completed-toggle', 'data-resume-agent', 'data-subagent-message-preview', 'data-truncated', '이 작업에서 누적 생성', '동시에 유지 가능', '현재 실행 중', '작업 완료 기록', '메인 AI ↔ 서브에이전트 소통', 'TMUX 사용', 'TMUX 미사용', '완료된 서브에이전트', 'child-session', 'agent-flow-session-title', 'agent-flow-outcome-copy', 'children-group-input', 'function drawAgentWorkflowConnections', 'function workflowCurve', 'data-workflow-edge-kind', 'function captureMotionLayout', 'function playMotionLayout', 'function motionEnterOffset', 'function animateVisibleSections', 'function agentCommandComposer', 'function originAppInfo', 'function agentControlMode', 'function dispatchAgentCommand', 'function openAgentTerminal', 'function copyBridgeCommand', 'function openSessionOrigin', 'data-agent-command-form', 'data-agent-command-draft', 'data-agent-terminal-open', 'data-agent-bridge-copy', 'data-agent-open-origin', '직접 입력 가능', '외부 터미널에서 실행 중 · 같은 대화로 이어받기 가능', '원래 터미널이 종료됨 · 같은 세션으로 복구 가능', '쉬는 데스크톱 작업 · 백그라운드 터미널로 이어가기 가능', '백그라운드 터미널로 이어서 보내기', '보기 전용 · 원래 앱에서 계속', '종료된 세션', '바로 보내기', 'data-motion-key', 'data-motion-value', 'dataset.lastMotion', 'motion-connect', 'pathLength="1"', 'prefers-reduced-motion: reduce', 'data-graph-provider-more', 'agent-flow-overview', 'agent-workflow-canvas', 'data-workflow-port', '이 일을 맡긴 AI', '지금 선택한 AI', '서브에이전트 세션', 'function renderTmuxMap', 'function tmuxPaneCard', 'function messageContentHtml', 'function memoryCandidatesHtml', 'data-scroll-latest', 'data-graph-focus', 'data-tmux-type', 'data-open-session']) assert.ok(app.includes(contract));
  assert.equal(app.includes('agent-focus-layout'), false);
  assert.equal(app.includes("state.view === 'subagents'"), false);
  const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'renderer', 'i18n.js'), 'utf8');
  for (const contract of ["'ko', 'en', 'zh-CN'", 'loadtoagent:locale:v1', 'window.LoadToAgentI18n', 'loadtoagent:locale-changed', 'MutationObserver', 'Application Settings', '应用设置']) assert.ok(i18n.includes(contract), `${contract} 다국어 계약이 없습니다.`);
  assert.ok(html.indexOf('src="i18n.js"') < html.indexOf('src="app.js"'), '다국어 런타임은 앱 렌더링보다 먼저 로드되어야 합니다.');
  for (const contract of ['chat-roadmap', 'agent-goal-note', 'new-run-cta', 'run-composer', 'run-modal-actions']) assert.ok(styles.includes(contract), `${contract} 가독성 UI 계약이 없습니다.`);
  for (const contract of ['--motion-ease', 'motion-section-in', 'motion-live-update', 'motion-edge-draw', 'motion-modal-in', 'motion-modal-out', 'motion-toast-in', 'motion-toast-out', 'agent-command-panel', 'agent-command-input', 'terminal-stage', 'terminal-history-panel', 'terminal-history-message', 'terminal-console-pane', 'terminal-console-head', 'terminal-command-composer', 'terminal-resource-tip', 'agent-workflow-summary', 'workflow-summary-chip', 'density-many', 'agent-workflow-edge.downstream.group', 'agent-flow-session-title', 'agent-flow-outcome-copy', 'completed-subagent-disclosure', 'completed-subagent-list', 'execution-mode-badge', 'work-working', 'work-resting', 'subagent-conversation-summary', 'subagent-message-preview', '-webkit-line-clamp:5', 'resume-ready', 'control-handoff', 'control-origin-resume', '@media(prefers-reduced-motion:reduce)']) assert.ok(styles.includes(contract), `${contract} UI 계약이 없습니다.`);
  const terminal = fs.readFileSync(path.join(root, 'renderer', 'terminal.js'), 'utf8');
  for (const contract of ['window.Terminal', 'FitAddon.FitAddon', 'wslDistros', 'terminalWrite', 'terminalResize', 'tmuxSendText', 'tmuxCapture', 'tmuxSplitPane', 'tmuxKillSession', 'function modeSessions', 'function moveWorkbench', 'function terminalTypeLabel', 'function terminalTypeMark', 'function setConnectionState', 'function agentTargets', 'terminal.bridgeId === agentSession.id', '백그라운드 유지', 'AI 백그라운드', 'function requiredAgentTarget', 'function resumeSupport', 'function resumeForAgent', "provider === 'codex' ? ['resume', sessionId] : ['--resume', sessionId]", 'function dispatchAgentCommand', 'function openForAgent', 'function bindAgent', 'function renderHistoryPanel', 'function queueHistoryRefresh', 'selectTmuxById', 'window.LoadToAgentTerminal']) assert.ok(terminal.includes(contract));
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  for (const contract of ['function backgroundAgentSessions', 'function ensureBackgroundTray', 'function updateBackgroundTrayMenu', 'function mainText', "ipcMain.handle('app:background-state'", "ipcMain.handle('app:show'", "ipcMain.handle('app:set-locale'", "ipcMain.handle('app:update-check'", "ipcMain.handle('app:update-download'", "ipcMain.handle('app:update-open'", '프로그램 끝내기 · AI 세션도 종료', 'Quit app · End AI sessions too', '退出应用 · 同时结束 AI 会话', 'event.preventDefault()', 'mainWindow.hide()']) assert.ok(main.includes(contract), `${contract} 메인 프로세스 계약이 없습니다.`);
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  for (const contract of ['backgroundState', 'showApp', 'setLocale', 'checkForUpdate', 'downloadUpdate', 'openDownloadedUpdate', 'onUpdateState']) assert.ok(preload.includes(contract), `${contract} 렌더러 IPC 계약이 없습니다.`);
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes('@xterm/xterm/lib/xterm.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['node-pty']);
  assert.ok(pkg.dependencies['@xterm/xterm']);
  assert.ok(pkg.dependencies['@xterm/addon-fit']);
  assert.equal(pkg.bin.loadtoagent, 'bin/loadtoagent.js');
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

test('제품 소스와 파일명에 이전 프로그램 명칭이 남아 있지 않다', () => {
  const targets = ['.github', 'bin', 'docs', 'main.js', 'preload.js', 'package.json', 'README.md', 'README.ko.md', 'README.zh-CN.md', 'src', 'renderer', 'scripts'];
  const forbidden = new RegExp(['lode', 'star'].join(''), 'i');
  const visit = target => {
    const full = path.join(root, target);
    if (!fs.existsSync(full)) return;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full)) {
        assert.equal(forbidden.test(name), false, `${path.join(target, name)} 파일명에 이전 프로그램 명칭이 남아 있습니다.`);
        visit(path.join(target, name));
      }
    } else if (/\.(js|json|ya?ml|html|css|md)$/i.test(full)) {
      assert.equal(forbidden.test(fs.readFileSync(full, 'utf8')), false, `${target}에 이전 프로그램 명칭이 남아 있습니다.`);
    }
  };
  targets.forEach(visit);
});

test('README와 릴리스 워크플로가 npm·Windows·macOS 실행 경로를 안내한다', () => {
  for (const file of ['README.md', 'README.ko.md', 'README.zh-CN.md']) {
    const readme = fs.readFileSync(path.join(root, file), 'utf8');
    for (const contract of [
      'npm install -g loadtoagent',
      'loadtoagent',
      'https://github.com/minjund/LodeToAgent/releases/latest',
      'LoadToAgent-Setup-<version>.exe',
      'LoadToAgent-<version>-portable.exe',
      'LoadToAgent-<version>-arm64.dmg',
      'LoadToAgent-<version>-x64.dmg',
    ]) assert.ok(readme.includes(contract), `${file}에 ${contract} 안내가 없습니다.`);
  }

  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  for (const contract of ['tags:', '"v*"', 'actions/checkout@v6', 'actions/setup-node@v6', 'gh release create', 'release/*.exe', 'release/*.dmg', 'release/*.zip', 'LoadToAgent-Windows', 'LoadToAgent-macOS', 'npm_version.outputs.published']) {
    assert.ok(workflow.includes(contract), `release.yml에 ${contract} 계약이 없습니다.`);
  }
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
