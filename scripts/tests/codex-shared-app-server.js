'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  CodexAppServer,
  CodexAppServerOutputParser,
  codexAppServerLaunchSpec,
  codexAppServerReadyUrl,
  codexRemoteArguments,
  parseCodexAppServerEndpoint,
  terminateCodexAppServerChild,
} = require('../../src/codexAppServer');
const { processSessionExternalId } = require('../../src/processMonitor');
const { AGENT_PROVIDERS, launchSpec, normalizeLaunchOptions } = require('../../src/terminalManager');
const {
  codexCreatePreparationOptions,
  codexLaunchBackend,
  isNativeCodexLaunch,
  prepareCodexOperation,
  recoverPersistedSessionsWithCodexAppServer,
  sharedCodexAgentProviders,
  usesSharedCodexAppServer,
} = require('../../src/terminalHostDaemon');

function fakeChild(pid) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.finish = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  child.kill = () => true;
  return child;
}

function terminatingFake(child, calls) {
  calls.push(child.pid);
  child.finish(null, 'SIGTERM');
  return Promise.resolve({ ok: true });
}

function registerCodexSharedAppServerTests(context) {
  const { test } = context;

  test('Codex app-server의 청크 출력을 조립하고 localhost 준비 주소만 허용한다', () => {
    const parser = new CodexAppServerOutputParser();
    assert.equal(parser.push(Buffer.from('startup noise\n  listen')), '');
    assert.equal(parser.push(Buffer.from('ing on: ws://127.0.0.1:45')), '');
    assert.equal(parser.push(Buffer.from('123\n')), 'ws://127.0.0.1:45123');
    assert.equal(parseCodexAppServerEndpoint('listening on: ws://0.0.0.0:45123\n'), '');
    assert.equal(parseCodexAppServerEndpoint('listening on: ws://127.0.0.1:65536\n'), '');
    assert.equal(codexAppServerReadyUrl('ws://127.0.0.1:45123'), 'http://127.0.0.1:45123/readyz');
    assert.deepStrictEqual(codexRemoteArguments('ws://127.0.0.1:45123'), [
      '--remote',
      'ws://127.0.0.1:45123',
    ]);
    assert.throws(() => codexRemoteArguments('ws://example.com:45123'), error => (
      error?.code === 'CODEX_APP_SERVER_NOT_READY'
    ));
  });

  test('동시 Codex app-server 준비 요청은 하나의 프로세스와 endpoint를 공유한다', async () => {
    const children = [];
    const probes = [];
    const terminationCalls = [];
    const server = new CodexAppServer({
      platform: 'linux',
      spawnProcess(file, args, options) {
        assert.equal(file, 'codex');
        assert.deepStrictEqual(args, ['app-server', '--listen', 'ws://127.0.0.1:0']);
        assert.equal(options.detached, true);
        const child = fakeChild(41_001 + children.length);
        children.push(child);
        return child;
      },
      requestReady(endpoint) {
        probes.push(endpoint);
        return Promise.resolve(true);
      },
      terminateProcess: child => terminatingFake(child, terminationCalls),
    });

    const first = server.ensureReady();
    const second = server.ensureReady();
    assert.strictEqual(first, second);
    assert.equal(children.length, 1);
    children[0].stderr.emit('data', Buffer.from('  listening on: ws://127.0.0.1:45'));
    children[0].stderr.emit('data', Buffer.from('123\n'));
    const endpoints = await Promise.all([first, second]);
    assert.deepStrictEqual(endpoints, ['ws://127.0.0.1:45123', 'ws://127.0.0.1:45123']);
    assert.deepStrictEqual(probes, ['ws://127.0.0.1:45123']);
    assert.equal(server.endpoint, 'ws://127.0.0.1:45123');
    assert.deepStrictEqual(server.remoteArguments(), ['--remote', 'ws://127.0.0.1:45123']);

    await server.dispose();
    assert.deepStrictEqual(terminationCalls, [41_001]);
  });

  test('Codex app-server가 준비 전에 종료되면 오류 출력과 함께 실패한다', async () => {
    const child = fakeChild(42_001);
    const server = new CodexAppServer({
      platform: 'linux',
      spawnProcess: () => child,
      requestReady: () => Promise.resolve(true),
    });
    const pending = server.ensureReady();
    child.stderr.emit('data', Buffer.from('configuration rejected'));
    child.finish(23, null);
    await assert.rejects(pending, error => (
      error?.code === 'CODEX_APP_SERVER_EXITED'
      && error.message.includes('configuration rejected')
      && error.message.includes('code=23')
    ));
    assert.equal(server.endpoint, '');
    assert.equal(server.running, false);
  });

  test('Codex app-server는 비-localhost 수신 출력을 endpoint로 신뢰하지 않는다', async () => {
    let clock = 0;
    let probes = 0;
    const terminationCalls = [];
    const child = fakeChild(43_001);
    const server = new CodexAppServer({
      platform: 'linux',
      startupTimeoutMs: 3,
      readyRetryMs: 1,
      now: () => clock,
      delay: milliseconds => {
        clock += milliseconds;
        return Promise.resolve();
      },
      spawnProcess: () => child,
      requestReady: () => {
        probes += 1;
        return Promise.resolve(true);
      },
      terminateProcess: process => terminatingFake(process, terminationCalls),
    });
    const pending = server.ensureReady();
    child.stdout.emit('data', Buffer.from('listening on: ws://0.0.0.0:45123\n'));
    await assert.rejects(pending, error => error?.code === 'CODEX_APP_SERVER_READY_TIMEOUT');
    assert.equal(probes, 0);
    assert.deepStrictEqual(terminationCalls, [43_001]);
    assert.equal(server.endpoint, '');
  });

  test('종료된 Codex app-server 뒤의 다음 준비 요청은 새 프로세스를 시작한다', async () => {
    const children = [];
    const terminationCalls = [];
    const server = new CodexAppServer({
      platform: 'linux',
      spawnProcess: () => {
        const child = fakeChild(44_001 + children.length);
        children.push(child);
        return child;
      },
      requestReady: () => Promise.resolve(true),
      terminateProcess: child => terminatingFake(child, terminationCalls),
    });

    const first = server.ensureReady();
    children[0].stdout.emit('data', Buffer.from('listening on: ws://127.0.0.1:45123\n'));
    assert.equal(await first, 'ws://127.0.0.1:45123');
    children[0].finish(1, null);
    assert.equal(server.endpoint, '');

    const second = server.ensureReady();
    assert.equal(children.length, 2);
    children[1].stdout.emit('data', Buffer.from('listening on: ws://127.0.0.1:45124\n'));
    assert.equal(await second, 'ws://127.0.0.1:45124');
    assert.equal(server.endpoint, 'ws://127.0.0.1:45124');
    await server.dispose();
    assert.deepStrictEqual(terminationCalls, [44_002]);
  });

  test('Codex app-server dispose는 한 번만 종료하고 이후 재시작을 막는다', async () => {
    const child = fakeChild(45_001);
    const terminationCalls = [];
    const server = new CodexAppServer({
      platform: 'linux',
      spawnProcess: () => child,
      requestReady: () => Promise.resolve(true),
      terminateProcess: process => terminatingFake(process, terminationCalls),
    });
    const ready = server.ensureReady();
    child.stdout.emit('data', Buffer.from('listening on: ws://127.0.0.1:45123\n'));
    await ready;

    const firstDispose = server.dispose();
    const secondDispose = server.dispose();
    assert.strictEqual(firstDispose, secondDispose);
    assert.equal(server.endpoint, '');
    await firstDispose;
    assert.deepStrictEqual(terminationCalls, [45_001]);
    await assert.rejects(server.ensureReady(), error => error?.code === 'CODEX_APP_SERVER_DISPOSED');

    const exitingChild = fakeChild(45_002);
    const groupAbsent = await terminateCodexAppServerChild(exitingChild, {
      platform: 'linux',
      isExited: () => false,
      killProcess: () => {
        const error = new Error('fixture process group already exited');
        error.code = 'ESRCH';
        throw error;
      },
    });
    assert.deepStrictEqual(groupAbsent, { ok: true, processGroup: true, alreadyExited: true });

  });

  test('Codex launchSpec은 실행 때만 remote 인자를 주입하고 정규 옵션은 보존한다', () => {
    const endpoint = 'ws://127.0.0.1:45123';
    const options = normalizeLaunchOptions({
      type: 'agent',
      provider: 'codex',
      cwd: process.cwd(),
      args: ['resume', 'session-remote'],
      sessionBackend: 'direct',
    }, 'linux');
    const snapshot = JSON.parse(JSON.stringify(options));
    let receivedOptions = null;
    const providers = {
      ...AGENT_PROVIDERS,
      codex: {
        ...AGENT_PROVIDERS.codex,
        argsFor(candidate) {
          receivedOptions = candidate;
          return candidate.distro ? [] : ['--remote', endpoint];
        },
      },
    };
    const spec = launchSpec(options, 'linux', providers);
    assert.strictEqual(receivedOptions, options);
    assert.deepStrictEqual(spec.args, ['--remote', endpoint, 'resume', 'session-remote']);
    assert.deepStrictEqual(options, snapshot);
    assert.deepStrictEqual(options.args, ['resume', 'session-remote']);
  });

  test('Windows WSL Codex는 native app-server remote를 주입하지 않는다', () => {
    const options = normalizeLaunchOptions({
      type: 'agent',
      provider: 'codex',
      cwd: '/mnt/d/repository',
      distro: 'Ubuntu-24.04',
      args: ['resume', 'wsl-session'],
      sessionBackend: 'direct',
    }, 'win32');
    const providers = {
      ...AGENT_PROVIDERS,
      codex: {
        ...AGENT_PROVIDERS.codex,
        argsFor(candidate) {
          return candidate.distro ? [] : ['--remote', 'ws://127.0.0.1:45123'];
        },
      },
    };
    const spec = launchSpec(options, 'win32', providers);
    assert.equal(spec.file, 'wsl.exe');
    assert.deepStrictEqual(spec.args, [
      '-d', 'Ubuntu-24.04', '--cd', '/mnt/d/repository', '--',
      'codex', 'resume', 'wsl-session',
    ]);
  });

  test('Codex remote 주입은 다른 provider의 launchSpec을 바꾸지 않는다', () => {
    const options = normalizeLaunchOptions({
      type: 'agent',
      provider: 'claude',
      cwd: process.cwd(),
      args: ['--resume', 'claude-session'],
      sessionBackend: 'direct',
    }, 'linux');
    const providers = {
      ...AGENT_PROVIDERS,
      codex: {
        ...AGENT_PROVIDERS.codex,
        argsFor: () => ['--remote', 'ws://127.0.0.1:45123'],
      },
    };
    const spec = launchSpec(options, 'linux', providers);
    assert.equal(spec.file, AGENT_PROVIDERS.claude.command);
    assert.deepStrictEqual(spec.args, ['--resume', 'claude-session']);
  });

  test('프로세스 감시는 Codex remote 전송 인자를 제외하고 resume ID를 찾는다', () => {
    assert.equal(processSessionExternalId({
      argv: ['codex', '--remote', 'ws://127.0.0.1:45123', 'resume', '--', 'session-one'],
    }, 'codex'), 'session-one');
    assert.equal(processSessionExternalId({
      argv: ['node', '/opt/node_modules/@openai/codex/bin/codex.js', '--remote=ws://127.0.0.1:45123', 'resume', 'session-two'],
    }, 'codex'), 'session-two');
    assert.equal(processSessionExternalId({
      argv: ['codex', '--remote-auth-token-env', 'LOADTOAGENT_CODEX_TOKEN', '--remote', 'ws://127.0.0.1:45123', 'resume', 'session-three'],
    }, 'codex'), 'session-three');
    assert.equal(processSessionExternalId({
      argv: ['codex', '--remote', '', 'resume', 'must-fail-closed'],
    }, 'codex'), '');
  });

  test('Codex app-server 실행 명세는 loopback 동적 포트만 요청한다', () => {
    const posix = codexAppServerLaunchSpec({ platform: 'linux', cwd: '/repo', env: { PATH: '/bin' } });
    assert.equal(posix.file, 'codex');
    assert.deepStrictEqual(posix.args, ['app-server', '--listen', 'ws://127.0.0.1:0']);
    assert.equal(posix.options.detached, true);
    assert.equal(posix.options.windowsHide, true);
    const windows = codexAppServerLaunchSpec({
      platform: 'win32',
      cwd: 'C:\\repo',
      env: { ComSpec: 'cmd.exe' },
      command: 'C:\\npm tools\\codex.cmd',
    });
    assert.equal(windows.file, 'cmd.exe');
    assert.deepStrictEqual(windows.args, [
      '/d', '/v:off', '/s', '/c', 'call', 'C:\\npm tools\\codex.cmd',
      'app-server', '--listen', 'ws://127.0.0.1:0',
    ]);
    assert.equal(windows.options.detached, false);
  });

  test('터미널 호스트는 direct native Codex만 준비하고 managed tmux·다른 provider·WSL은 그대로 둔다', async () => {
    const calls = [];
    let ready = false;
    const appServer = {
      async ensureReady() { calls.push('ensure'); ready = true; return 'ws://127.0.0.1:45123'; },
      remoteArguments() {
        assert.equal(ready, true, 'app-server 준비 전에 remote 인자를 요청했습니다.');
        return ['--remote', 'ws://127.0.0.1:45123'];
      },
    };
    const providers = sharedCodexAgentProviders(appServer, 'win32');
    assert.strictEqual(providers.claude, AGENT_PROVIDERS.claude);
    assert.strictEqual(providers.gemini, AGENT_PROVIDERS.gemini);
    assert.strictEqual(providers.grok, AGENT_PROVIDERS.grok);
    assert.equal(isNativeCodexLaunch({ type: 'agent', provider: 'codex' }, 'win32'), true);
    assert.equal(isNativeCodexLaunch({ type: 'agent', provider: 'codex', distro: 'Ubuntu' }, 'win32'), false);
    assert.equal(codexLaunchBackend({ type: 'agent', provider: 'codex' }, 'linux'), 'managed-tmux');
    assert.equal(codexLaunchBackend({ type: 'agent', provider: 'codex', transient: true }, 'linux'), 'direct');
    assert.equal(codexLaunchBackend({
      type: 'agent',
      provider: 'codex',
      sessionBackend: 'managed-tmux',
      bridgeId: 'codex:bound',
      agentConnectionSignature: 'signed-binding',
    }, 'linux'), 'direct');
    assert.equal(usesSharedCodexAppServer({ type: 'agent', provider: 'codex' }, 'linux'), false);
    assert.equal(usesSharedCodexAppServer({ type: 'agent', provider: 'codex', transient: true }, 'linux'), true);
    assert.equal(usesSharedCodexAppServer({
      type: 'agent', provider: 'codex', sessionBackend: 'direct', distro: 'Ubuntu',
    }, 'win32'), false);

    const linuxManaged = normalizeLaunchOptions({
      type: 'agent', provider: 'codex', cwd: process.cwd(), args: ['resume', 'managed-session'],
    }, 'linux');
    const linuxDirect = normalizeLaunchOptions({
      type: 'agent', provider: 'codex', cwd: process.cwd(), args: ['resume', 'direct-session'],
      sessionBackend: 'direct',
    }, 'linux');
    const linuxProviders = sharedCodexAgentProviders(appServer, 'linux');
    assert.equal(linuxManaged.sessionBackend, 'managed-tmux');
    assert.deepStrictEqual(linuxProviders.codex.argsFor(linuxManaged), []);

    const manager = {
      sessions: new Map([
        ['terminal:codex', { options: { type: 'agent', provider: 'codex', sessionBackend: 'direct' } }],
        ['terminal:managed', { options: { type: 'agent', provider: 'codex', sessionBackend: 'managed-tmux' } }],
      ]),
      managedTmuxRuntime: { available: () => true },
      get(id) {
        return id === 'terminal:codex'
          ? { type: 'agent', provider: 'codex', distro: '', backend: 'direct' }
          : { type: 'agent', provider: 'claude', distro: '' };
      },
    };
    await prepareCodexOperation(manager, appServer, 'create', [{ type: 'agent', provider: 'claude' }], 'win32');
    await prepareCodexOperation(manager, appServer, 'create', [{ type: 'agent', provider: 'codex', distro: 'Ubuntu' }], 'win32');
    assert.deepStrictEqual(calls, []);
    await prepareCodexOperation(manager, appServer, 'create', [{ type: 'agent', provider: 'codex' }], 'win32');
    await prepareCodexOperation(manager, appServer, 'create', [{
      type: 'agent', provider: 'codex', cwd: process.cwd(), args: ['resume', 'managed-session'],
    }], 'linux');
    await prepareCodexOperation(manager, appServer, 'create', [{
      type: 'agent', provider: 'codex', cwd: process.cwd(), args: ['resume', 'transient-session'], transient: true,
    }], 'linux');
    await prepareCodexOperation(manager, appServer, 'create', [{
      type: 'agent', provider: 'codex', cwd: process.cwd(), args: ['resume', 'bound-session'],
      sessionBackend: 'managed-tmux', bridgeId: 'codex:bound', agentConnectionSignature: 'signed-binding',
    }], 'linux');
    assert.deepStrictEqual(providers.codex.argsFor({ type: 'agent', provider: 'codex' }), [
      '--remote', 'ws://127.0.0.1:45123',
    ]);
    assert.deepStrictEqual(providers.codex.argsFor({ type: 'agent', provider: 'codex', distro: 'Ubuntu' }), []);
    await prepareCodexOperation(manager, appServer, 'restart', ['terminal:codex'], 'win32');
    await prepareCodexOperation(manager, appServer, 'restart', ['terminal:managed'], 'linux');
    await prepareCodexOperation(manager, appServer, 'restart', ['terminal:claude'], 'win32');
    assert.deepStrictEqual(linuxProviders.codex.argsFor(linuxDirect), [
      '--remote', 'ws://127.0.0.1:45123',
    ]);
    assert.deepStrictEqual(calls, ['ensure', 'ensure', 'ensure', 'ensure']);

    let fallbackChecks = 0;
    const fallback = codexCreatePreparationOptions({
      managedTmuxRuntime: {
        available() { fallbackChecks += 1; return false; },
      },
    }, {
      type: 'agent', provider: 'codex', cwd: process.cwd(), args: ['resume', 'fallback-session'],
    }, 'linux');
    assert.equal(fallback.sessionBackend, 'direct');
    assert.equal(fallbackChecks, 1);

    const recoveryFailure = new Error('Codex executable unavailable');
    let recoveryEnsureCalls = 0;
    let recoveryCalls = 0;
    const recoveryLogs = [];
    const recoveryManager = {
      sessions: new Map([
        ['codex', {
          recoveryPending: true,
          options: { type: 'agent', provider: 'codex', sessionBackend: 'direct' },
        }],
        ['claude', {
          recoveryPending: true,
          options: { type: 'agent', provider: 'claude', sessionBackend: 'direct' },
        }],
      ]),
      recoverPersistedSessions() {
        recoveryCalls += 1;
        return ['claude-recovered'];
      },
    };
    const recovered = await recoverPersistedSessionsWithCodexAppServer(recoveryManager, {
      async ensureReady() { recoveryEnsureCalls += 1; throw recoveryFailure; },
    }, {
      platform: 'linux',
      onFailure: error => recoveryLogs.push(error),
    });
    assert.deepStrictEqual(recovered, ['claude-recovered']);
    assert.equal(recoveryEnsureCalls, 1);
    assert.equal(recoveryCalls, 1);
    assert.deepStrictEqual(recoveryLogs, [recoveryFailure]);

    const managedRecoveryManager = {
      sessions: new Map([['codex-managed', {
        recoveryPending: true,
        options: { type: 'agent', provider: 'codex', sessionBackend: 'managed-tmux' },
      }]]),
      recoverPersistedSessions: () => ['managed-reattached'],
    };
    assert.deepStrictEqual(await recoverPersistedSessionsWithCodexAppServer(managedRecoveryManager, {
      async ensureReady() { throw new Error('managed recovery must not start the host-scoped server'); },
    }, { platform: 'linux' }), ['managed-reattached']);
  });
}

module.exports = { registerCodexSharedAppServerTests };
