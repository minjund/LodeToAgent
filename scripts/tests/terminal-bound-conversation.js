'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  TerminalManager,
  normalizeLaunchOptions,
} = require('../../src/terminalManager');

class FakePty {
  constructor(pid, writes) {
    this.pid = pid;
    this.writes = writes;
  }

  onData(callback) { this.dataCallback = callback; }
  onExit(callback) { this.exitCallback = callback; }
  write(value) { this.writes.push(String(value)); }
  resize() {}
  kill() {}
}

function boundOptions(root, overrides = {}) {
  return {
    type: 'agent',
    provider: 'codex',
    cwd: root,
    args: ['resume', '019f-bound-history-a'],
    recoveryArgs: ['resume', '019f-bound-history-a'],
    bridgeId: 'codex:019f-bound-history-a',
    agentConnectionSignature: `acs1:${'a'.repeat(64)}`,
    sessionBackend: 'managed-tmux',
    reuseBridge: true,
    ...overrides,
  };
}

function managerFixture(root, overrides = {}) {
  const writes = [];
  const spawns = [];
  const manager = new TerminalManager({
    platform: 'darwin',
    killTree: () => {},
    managedTmuxRuntime: {
      available: () => true,
      existsStrict: () => false,
      stopStrict: () => ({ ok: true }),
    },
    ptyModule: {
      spawn(file, args) {
        spawns.push({ file, args });
        return new FakePty(41_000 + spawns.length, writes);
      },
    },
    ...overrides,
  });
  return { manager, writes, spawns };
}

function persistedBoundRecord(root, pid) {
  const now = new Date().toISOString();
  return {
    id: 'terminal:persisted-bound',
    options: {
      type: 'agent',
      provider: 'codex',
      cwd: root,
      distro: '',
      args: ['resume', '019f-persisted-bound'],
      sessionBackend: 'direct',
      tmuxSocket: '',
      managedTmuxSession: '',
      bridgeId: 'codex:019f-persisted-bound',
      agentConnectionSignature: `acs1:${'b'.repeat(64)}`,
      transient: false,
      cols: 120,
      rows: 32,
    },
    title: 'Persisted bound Codex',
    shell: 'codex',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    pid,
    replay: '',
    deliveries: [],
  };
}

function registerTerminalBoundConversationTests({ test, root, temp }) {
  test('signed conversation PTY는 요청 backend와 무관하게 direct app-owned PTY로 정규화한다', () => {
    const normalized = normalizeLaunchOptions(boundOptions(root), 'darwin');
    assert.equal(normalized.sessionBackend, 'direct');
    assert.equal(normalized.tmuxSocket, '');
    assert.equal(normalized.managedTmuxSession, '');
    assert.equal(normalized.bridgeId, 'codex:019f-bound-history-a');
    assert.throws(
      () => normalizeLaunchOptions(boundOptions(root, { args: ['resume', 'x'.repeat(201)] }), 'darwin'),
      /대화 ID 형식/u,
    );
    assert.throws(
      () => normalizeLaunchOptions(boundOptions(root, { bridgeId: 'b'.repeat(257) }), 'darwin'),
      /연결 식별자/u,
    );
  });

  test('bound PTY는 raw 키 입력을 차단하고 composer 질문·control signal·전용 승인만 전달한다', () => {
    const { manager, writes, spawns } = managerFixture(root);
    const created = manager.create(boundOptions(root));
    assert.equal(created.backend, 'direct');
    assert.equal(created.conversationBound, true);
    assert.equal(spawns.length, 1);
    assert.throws(() => manager.write(created.id, '직접 입력'), error => error.code === 'AGENT_BOUND_RAW_INPUT_BLOCKED');
    assert.deepStrictEqual(writes, []);

    manager.command(created.id, '일반 질문입니다');
    manager.signal(created.id, 'interrupt');
    manager.respond(created.id, 'y');
    manager.respond(created.id, 'Escape');
    manager.respond(created.id, '7');
    assert.deepStrictEqual(writes, ['일반 질문입니다\r', '\x03', 'y', '\x1b', '7']);
    assert.throws(() => manager.respond(created.id, 'z'), error => error.code === 'TERMINAL_PROMPT_RESPONSE_INVALID');
  });

  test('bound composer는 모든 slash meta command와 control obfuscation을 multiline에서도 거부한다', () => {
    const { manager, writes } = managerFixture(root);
    const created = manager.create(boundOptions(root));
    for (const command of [
      '/resume other',
      '앞 질문\n  /cha resume other',
      '/continue',
      '/branch topic',
      '/teleport',
      '/checkpoint',
      '/undo',
      '/chat',
      '정상처럼 보임\n\t/resu other',
    ]) {
      assert.throws(
        () => manager.command(created.id, command),
        error => ['AGENT_BOUND_META_COMMAND_BLOCKED', 'AGENT_BOUND_COMMAND_CONTROL_BLOCKED'].includes(error.code),
      );
    }
    assert.throws(
      () => manager.command(created.id, `질문\x1b[2K/resume other`),
      error => error.code === 'AGENT_BOUND_COMMAND_CONTROL_BLOCKED',
    );
    assert.deepStrictEqual(writes, []);
  });

  test('launch resume와 recovery resume가 다르면 spawn 전에 fail closed한다', () => {
    const { manager, spawns } = managerFixture(root);
    assert.throws(
      () => manager.create(boundOptions(root, { recoveryArgs: ['resume', '019f-bound-history-b'] })),
      error => error.code === 'AGENT_RECOVERY_IDENTITY_MISMATCH',
    );
    assert.equal(spawns.length, 0);
  });

  test('같은 provider history는 서로 다른 bridge의 동시 create 중 하나만 허용한다', async () => {
    const { manager, spawns } = managerFixture(root);
    const [first, second] = await Promise.allSettled([
      Promise.resolve().then(() => manager.create(boundOptions(root, { bridgeId: 'codex:bridge-a' }))),
      Promise.resolve().then(() => manager.create(boundOptions(root, { bridgeId: 'codex:bridge-b' }))),
    ]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(second.status, 'rejected');
    assert.equal(second.reason.code, 'AGENT_RESUME_IDENTITY_ALREADY_ACTIVE');
    assert.equal(spawns.length, 1);
  });

  test('hard-crash bound PID는 live/unknown이면 차단하고 absent이면 명시적 ensure만 새 PTY를 만든다', () => {
    const liveStore = path.join(temp, 'bound-live-pid.json');
    fs.writeFileSync(liveStore, JSON.stringify({ version: 2, sessions: [persistedBoundRecord(root, 55_001)] }), 'utf8');
    const live = managerFixture(root, { storeFile: liveStore, processKill: () => {} });
    assert.equal(live.manager.recoverPersistedSessions().length, 0);
    assert.equal(live.spawns.length, 0);
    assert.equal(live.manager.get('terminal:persisted-bound').terminationUncertain, true);
    assert.throws(
      () => live.manager.create(boundOptions(root, {
        args: ['resume', '019f-persisted-bound'],
        recoveryArgs: ['resume', '019f-persisted-bound'],
        bridgeId: 'codex:019f-persisted-bound',
        agentConnectionSignature: `acs1:${'b'.repeat(64)}`,
      })),
      error => ['AGENT_CONNECTION_RETIRE_IN_PROGRESS', 'AGENT_RESUME_IDENTITY_ALREADY_ACTIVE'].includes(error.code),
    );

    let releasedProbeCount = 0;
    const released = managerFixture(root, {
      storeFile: liveStore,
      processKill: () => {
        releasedProbeCount += 1;
        const error = new Error('released');
        error.code = 'ESRCH';
        throw error;
      },
    });
    const releasedRecord = released.manager.get('terminal:persisted-bound');
    assert.equal(releasedProbeCount, 1, '다음 bootstrap에서도 persisted orphan PID를 다시 확인해야 합니다.');
    assert.equal(releasedRecord.status, 'exited');
    assert.equal(releasedRecord.terminationUncertain, false);
    assert.equal(releasedRecord.terminationErrorCode, '');
    released.manager.create(boundOptions(root, {
      args: ['resume', '019f-persisted-bound'],
      recoveryArgs: ['resume', '019f-persisted-bound'],
      bridgeId: 'codex:019f-persisted-bound',
      agentConnectionSignature: `acs1:${'b'.repeat(64)}`,
    }));
    assert.equal(released.spawns.length, 1, 'orphan 종료 확인 뒤 명시적 ensure는 새 PTY를 만들 수 있어야 합니다.');

    const unknownStore = path.join(temp, 'bound-unknown-pid.json');
    fs.writeFileSync(unknownStore, JSON.stringify({ version: 2, sessions: [persistedBoundRecord(root, 55_003)] }), 'utf8');
    const unknown = managerFixture(root, {
      storeFile: unknownStore,
      processKill: () => {
        const error = new Error('access denied');
        error.code = 'EPERM';
        throw error;
      },
    });
    assert.equal(unknown.manager.get('terminal:persisted-bound').terminationErrorCode, 'AGENT_BOUND_ORPHAN_PID_UNCONFIRMED');
    const unknownReleased = managerFixture(root, {
      storeFile: unknownStore,
      processKill: () => {
        const error = new Error('released');
        error.code = 'ESRCH';
        throw error;
      },
    });
    assert.equal(unknownReleased.manager.get('terminal:persisted-bound').status, 'exited');
    assert.equal(unknownReleased.manager.get('terminal:persisted-bound').terminationUncertain, false);

    const sameHostStore = path.join(temp, 'bound-same-host-release.json');
    fs.writeFileSync(sameHostStore, JSON.stringify({ version: 2, sessions: [persistedBoundRecord(root, 55_004)] }), 'utf8');
    let sameHostProbes = 0;
    const sameHost = managerFixture(root, {
      storeFile: sameHostStore,
      processKill: () => {
        sameHostProbes += 1;
        if (sameHostProbes === 1) return;
        const error = new Error('released after bootstrap');
        error.code = 'ESRCH';
        throw error;
      },
    });
    assert.equal(sameHost.manager.get('terminal:persisted-bound').terminationUncertain, true);
    sameHost.manager.create(boundOptions(root, {
      args: ['resume', '019f-persisted-bound'],
      recoveryArgs: ['resume', '019f-persisted-bound'],
      bridgeId: 'codex:019f-persisted-bound',
      agentConnectionSignature: `acs1:${'b'.repeat(64)}`,
    }));
    assert.equal(sameHostProbes, 2, '같은 manager의 create 직전 orphan PID를 다시 확인해야 합니다.');
    assert.equal(sameHost.manager.get('terminal:persisted-bound').terminationUncertain, false);
    assert.equal(sameHost.spawns.length, 1);

    const absentStore = path.join(temp, 'bound-absent-pid.json');
    fs.writeFileSync(absentStore, JSON.stringify({ version: 2, sessions: [persistedBoundRecord(root, 55_002)] }), 'utf8');
    const absent = managerFixture(root, {
      storeFile: absentStore,
      processKill: () => {
        const error = new Error('missing');
        error.code = 'ESRCH';
        throw error;
      },
    });
    assert.equal(absent.manager.recoverPersistedSessions().length, 0);
    assert.equal(absent.spawns.length, 0);
    assert.equal(absent.manager.get('terminal:persisted-bound').status, 'exited');
    absent.manager.create(boundOptions(root, {
      args: ['resume', '019f-persisted-bound'],
      recoveryArgs: ['resume', '019f-persisted-bound'],
      bridgeId: 'codex:019f-persisted-bound',
      agentConnectionSignature: `acs1:${'b'.repeat(64)}`,
    }));
    assert.equal(absent.spawns.length, 1);
  });

  test('tmux가 없는 macOS/WSL의 일반 agent도 direct 실제 PTY로 fallback한다', () => {
    for (const [platform, distro] of [['darwin', ''], ['win32', 'Ubuntu-24.04']]) {
      const writes = [];
      const spawns = [];
      const manager = new TerminalManager({
        platform,
        killTree: () => {},
        managedTmuxRuntime: { available: () => false },
        ptyModule: { spawn: (file, args) => {
          spawns.push({ file, args });
          return new FakePty(60_000 + spawns.length, writes);
        } },
      });
      const created = manager.create({
        type: 'agent', provider: 'codex', cwd: root, distro, args: [], sessionBackend: 'managed-tmux',
      });
      assert.equal(created.backend, 'direct');
      assert.equal(spawns.length, 1);
      if (platform === 'win32') assert.equal(spawns[0].file, 'wsl.exe');
      else assert.equal(spawns[0].file, 'codex');
    }
  });

  test('bound PTY UI는 xterm stdin·slash menu를 끄고 메시지 입력란과 전용 respond API만 노출한다', () => {
    const workbench = fs.readFileSync(path.join(root, 'renderer', 'terminal-workbench.js'), 'utf8');
    const composer = fs.readFileSync(path.join(root, 'renderer', 'terminal-composer.js'), 'utf8');
    const drawer = fs.readFileSync(path.join(root, 'renderer', 'drawer-terminal.js'), 'utf8');
    const messages = fs.readFileSync(path.join(root, 'renderer', 'i18n-messages.js'), 'utf8');
    const terminal = fs.readFileSync(path.join(root, 'renderer', 'terminal.js'), 'utf8');
    const fixturePreload = fs.readFileSync(path.join(root, 'scripts', 'interaction-fixture-preload.js'), 'utf8');
    assert.match(workbench, /inputDisabled = readOnly \|\| Boolean\(session\?\.conversationBound\)/u);
    assert.match(workbench, /if \(!inputDisabled\) \{\s*terminal\.onData/u);
    assert.match(composer, /allowSlashCommands\?\.\(\) === false/u);
    assert.match(composer, /trigger\.removeAttribute\('aria-haspopup'\)/u);
    const focusHandler = drawer.slice(drawer.indexOf("element('drawerTerminalFocusBtn')"), drawer.indexOf("element('drawerTerminalReconnectBtn')"));
    assert.match(focusHandler, /data-agent-command-draft/u);
    assert.equal(focusHandler.includes('focusEmbedded'), false);
    assert.match(messages, /메시지 입력란으로 이동/u);
    assert.match(messages, /실제 PTY 출력 및 스크롤 기록/u);
    assert.match(terminal, /loadtoagent\.terminalRespond/u);
    assert.equal((fixturePreload.match(/terminalRespond:/gu) || []).length, 2,
      'controlled fixture와 real-terminal fixture가 모두 전용 승인 API를 노출해야 합니다.');
  });
}

module.exports = { registerTerminalBoundConversationTests };
