'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  TerminalManager,
  normalizeLaunchOptions,
  promptFingerprint,
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
  test('fresh PTY는 첫 질문이 일치하는 실제 provider 기록에만 영속 연결한다', () => {
    const storeFile = path.join(temp, 'fresh-inferred-binding.json');
    const { manager } = managerFixture(root, { storeFile });
    const prompt = '새 작업의 고유한 첫 질문';
    const created = manager.create({
      type: 'agent',
      provider: 'codex',
      cwd: root,
      args: ['--sandbox', 'read-only', prompt],
      initialCommand: prompt,
      initialCommandInArgs: true,
      deliveryId: 'start:fresh-binding',
      sessionBackend: 'direct',
    });
    assert.equal(created.initialPromptFingerprint, promptFingerprint(prompt));
    assert.equal(created.conversationBound, false);
    assert.throws(
      () => manager.bindAgentSession(created.id, {
        terminalId: created.id,
        sessionId: 'codex:wrong-history',
        externalId: 'wrong-history',
        provider: 'codex',
        environment: 'macos',
        distro: '',
        promptFingerprint: promptFingerprint('다른 질문'),
        linkScore: 19_000,
      }),
      error => error.code === 'AGENT_BINDING_IDENTITY_MISMATCH',
    );

    const bound = manager.bindAgentSession(created.id, {
      terminalId: created.id,
      sessionId: 'codex:fresh-history',
      externalId: 'fresh-history',
      provider: 'codex',
      environment: 'macos',
      distro: '',
      promptFingerprint: promptFingerprint(prompt),
      linkScore: 19_000,
    });
    assert.equal(bound.conversationBound, true);
    assert.equal(bound.bridgeId, 'codex:fresh-history');
    assert.equal(bound.agentLinkedSessionId, 'codex:fresh-history');
    assert.equal(bound.agentLinkedExternalId, 'fresh-history');
    assert.equal(bound.agentResumeSessionId, 'fresh-history');
    assert.match(bound.agentConnectionSignature, /^acs1:[a-f0-9]{64}$/u);
    assert.throws(
      () => manager.command(created.id, '/resume stale-history'),
      error => error.code === 'AGENT_BOUND_META_COMMAND_BLOCKED',
    );

    const restoredFixture = managerFixture(root, { storeFile });
    const restored = restoredFixture.manager.get(created.id);
    assert.equal(restored.conversationBound, true);
    assert.equal(restored.agentLinkedSessionId, 'codex:fresh-history');
    assert.equal(restored.initialPromptFingerprint, promptFingerprint(prompt));
    assert.equal(restored.recoverySkippedReason, 'bound-direct-explicit-reconnect-required');
    restoredFixture.manager.recoverPersistedSessions();
    assert.equal(restoredFixture.spawns.length, 0, 'host 재시작이 원래 fresh 인자를 다시 실행하면 안 됩니다.');

    const authoritativeFile = path.join(temp, 'fresh-inferred-binding-derived-options.json');
    const authoritativeStore = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    authoritativeStore.sessions[0].status = 'running';
    authoritativeStore.sessions[0].pid = 59_998;
    authoritativeStore.sessions[0].options.agentConnectionSignature = '';
    authoritativeStore.sessions[0].options.args = [];
    fs.writeFileSync(authoritativeFile, JSON.stringify(authoritativeStore), 'utf8');
    let authoritativeProbes = 0;
    const authoritativeFixture = managerFixture(root, {
      storeFile: authoritativeFile,
      processKill: () => {
        authoritativeProbes += 1;
        const error = new Error('released');
        error.code = 'ESRCH';
        throw error;
      },
    });
    const rebuiltBinding = authoritativeFixture.manager.get(created.id);
    assert.equal(rebuiltBinding.conversationBound, true);
    assert.equal(rebuiltBinding.agentResumeSessionId, 'fresh-history');
    assert.match(rebuiltBinding.agentConnectionSignature, /^acs1:[a-f0-9]{64}$/u);
    assert.equal(rebuiltBinding.recoverySkippedReason, 'bound-direct-explicit-reconnect-required');
    assert.equal(authoritativeProbes, 1, 'valid binding은 canonical recovery identity를 재구성해 orphan을 fail-closed 확인해야 합니다.');
    authoritativeFixture.manager.recoverPersistedSessions();
    assert.equal(authoritativeFixture.spawns.length, 0);

    const tamperedFile = path.join(temp, 'fresh-inferred-binding-tampered.json');
    const tamperedStore = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    tamperedStore.sessions[0].status = 'running';
    tamperedStore.sessions[0].pid = 59_999;
    tamperedStore.sessions[0].agentBinding.promptFingerprint = 'f'.repeat(64);
    fs.writeFileSync(tamperedFile, JSON.stringify(tamperedStore), 'utf8');
    let orphanProbes = 0;
    const tamperedFixture = managerFixture(root, {
      storeFile: tamperedFile,
      processKill: () => {
        orphanProbes += 1;
        const error = new Error('should not probe rejected binding');
        error.code = 'ESRCH';
        throw error;
      },
    });
    const rejectedBinding = tamperedFixture.manager.get(created.id);
    assert.equal(rejectedBinding.conversationBound, false);
    assert.equal(rejectedBinding.bridgeId, '');
    assert.equal(rejectedBinding.agentResumeSessionId, '');
    assert.equal(rejectedBinding.recoverySkippedReason, 'invalid-agent-binding');
    tamperedFixture.manager.recoverPersistedSessions();
    assert.equal(tamperedFixture.spawns.length, 0);
    assert.equal(orphanProbes, 0, '검증 실패한 binding의 PID/자동 resume 경로를 신뢰하면 안 됩니다.');

    const conflictFixture = managerFixture(root);
    const createFresh = (text, deliveryId) => conflictFixture.manager.create({
      type: 'agent', provider: 'codex', cwd: root,
      args: ['--sandbox', 'read-only', text],
      initialCommand: text, initialCommandInArgs: true, deliveryId,
      sessionBackend: 'direct',
    });
    const firstConflict = createFresh('종료 확인 중인 첫 PTY', 'start:conflict-first');
    conflictFixture.manager.bindAgentSession(firstConflict.id, {
      sessionId: 'codex:conflict-history', externalId: 'conflict-history', provider: 'codex',
      environment: 'macos', distro: '', promptFingerprint: promptFingerprint('종료 확인 중인 첫 PTY'), linkScore: 19_000,
    });
    const firstConflictState = conflictFixture.manager.sessions.get(firstConflict.id);
    firstConflictState.status = 'stopping';
    firstConflictState.terminationPending = true;
    const secondConflict = createFresh('두 번째 PTY', 'start:conflict-second');
    assert.throws(
      () => conflictFixture.manager.bindAgentSession(secondConflict.id, {
        sessionId: 'codex:conflict-history', externalId: 'conflict-history', provider: 'codex',
        environment: 'macos', distro: '', promptFingerprint: promptFingerprint('두 번째 PTY'), linkScore: 19_000,
      }),
      error => error.code === 'AGENT_BINDING_SESSION_ALREADY_ACTIVE',
      '같은 canonical 대화의 기존 PTY가 종료 확인 중이면 새 binding을 허용하면 안 됩니다.',
    );

    const creationStoreFile = path.join(temp, 'fresh-creation-idempotency.json');
    const creationFixture = managerFixture(root, { storeFile: creationStoreFile });
    const creationRequest = {
      type: 'agent', provider: 'grok', cwd: root,
      args: ['--no-auto-update'], title: 'Grok · 생성 요청 멱등성',
      initialCommand: '응답이 유실되어도 새 PTY는 하나', initialCommandInArgs: false,
      creationId: 'create:fresh-grok-idempotent', deliveryId: 'start:fresh-grok-idempotent',
      sessionBackend: 'direct', transient: false, cols: 120, rows: 32,
    };
    const firstCreation = creationFixture.manager.create(creationRequest);
    const duplicateCreation = creationFixture.manager.create({ ...creationRequest, includeReplay: false });
    assert.equal(Object.hasOwn(firstCreation, 'replay'), true, 'create는 기본적으로 replay를 반환해야 합니다.');
    assert.equal(Object.hasOwn(duplicateCreation, 'replay'), false, 'metadata-only 중복 create가 replay를 반환하면 안 됩니다.');
    assert.equal(duplicateCreation.id, firstCreation.id);
    assert.equal(duplicateCreation.creationDuplicate, true);
    assert.equal(duplicateCreation.creationUnavailable, false);
    assert.equal(creationFixture.spawns.length, 1, '같은 creationId 재전송은 PTY를 다시 spawn하면 안 됩니다.');
    const persistedCreation = JSON.parse(fs.readFileSync(creationStoreFile, 'utf8')).sessions
      .find(session => session.id === firstCreation.id);
    assert.equal(persistedCreation.creationId, creationRequest.creationId);
    assert.match(persistedCreation.creationPayloadFingerprint, /^[a-f0-9]{64}$/u);
    const metadataOnlyFresh = creationFixture.manager.create({
      ...creationRequest,
      creationId: 'create:fresh-grok-metadata-only',
      deliveryId: 'start:fresh-grok-metadata-only',
      includeReplay: false,
    });
    assert.equal(Object.hasOwn(metadataOnlyFresh, 'replay'), false, 'metadata-only 신규 create가 replay를 반환하면 안 됩니다.');
    assert.throws(
      () => creationFixture.manager.create({ ...creationRequest, initialCommand: '다른 생성 payload' }),
      error => error.code === 'CREATION_ID_CONFLICT'
        && error.creationState === 'rejected'
        && error.creationId === creationRequest.creationId,
    );
    const firstFollowup = creationFixture.manager.command(firstCreation.id, creationRequest.initialCommand, {
      deliveryId: creationRequest.deliveryId,
    });
    const duplicateFollowup = creationFixture.manager.command(firstCreation.id, creationRequest.initialCommand, {
      deliveryId: creationRequest.deliveryId,
    });
    assert.equal(firstFollowup.deliveryState, 'accepted');
    assert.equal(duplicateFollowup.duplicate, true);
    assert.equal(creationFixture.writes.length, 1, 'Grok 후속 command도 실제 PTY에는 한 번만 써야 합니다.');
    const duplicateAfterAcceptedCommand = creationFixture.manager.create({
      ...creationRequest,
      deliveryId: 'start:fresh-grok-after-command-response-loss',
      includeReplay: false,
    });
    assert.equal(Object.hasOwn(duplicateAfterAcceptedCommand, 'replay'), false);
    assert.equal(duplicateAfterAcceptedCommand.deliveryState, 'accepted');
    assert.equal(duplicateAfterAcceptedCommand.promptSent, true);
    assert.equal(duplicateAfterAcceptedCommand.originalDeliveryId, creationRequest.deliveryId);
    assert.equal(creationFixture.writes.length, 1,
      'command 응답 뒤 renderer가 재시도해도 creation ledger가 이미 전달된 Grok 질문을 다시 쓰게 하면 안 됩니다.');

    const overlongIdPrefix = 'x'.repeat(240);
    const spawnsBeforeInvalidIds = creationFixture.spawns.length;
    for (const suffix of ['A', 'B']) {
      assert.throws(
        () => creationFixture.manager.create({
          ...creationRequest,
          creationId: `${overlongIdPrefix}${suffix}`,
          deliveryId: '',
        }),
        error => error.code === 'CREATION_ID_INVALID' && error.creationState === 'rejected',
        '공통 240자 prefix를 가진 서로 다른 creationId를 잘라 같은 장부 키로 취급하면 안 됩니다.',
      );
    }
    assert.equal(creationFixture.spawns.length, spawnsBeforeInvalidIds,
      '길이 제한을 넘은 creationId는 PTY spawn 전에 거절해야 합니다.');
    const writesBeforeInvalidDelivery = creationFixture.writes.length;
    assert.throws(
      () => creationFixture.manager.command(firstCreation.id, '잘린 ID로 전달하지 마', {
        deliveryId: `${'d'.repeat(240)}A`,
      }),
      error => error.code === 'DELIVERY_REJECTED' && error.deliveryState === 'rejected',
    );
    assert.equal(creationFixture.writes.length, writesBeforeInvalidDelivery,
      '길이 제한을 넘은 deliveryId는 PTY write 전에 거절해야 합니다.');
    assert.throws(
      () => creationFixture.manager.create({
        ...creationRequest,
        creationId: 'create:valid-id-with-invalid-delivery',
        deliveryId: `${'d'.repeat(240)}B`,
      }),
      error => error.code === 'DELIVERY_REJECTED' && error.deliveryState === 'rejected',
      '생성 요청의 과긴 deliveryId도 creation ledger/spawn 전에 거절해야 합니다.',
    );
    assert.equal(creationFixture.spawns.length, spawnsBeforeInvalidIds);

    const codexCreationRequest = {
      ...creationRequest,
      provider: 'codex',
      args: ['--sandbox', 'read-only', '생성·전달 장부를 함께 저장'],
      title: 'Codex · 생성 장부 저장 횟수',
      initialCommand: '생성·전달 장부를 함께 저장',
      initialCommandInArgs: true,
      creationId: 'create:fresh-codex-persist-count',
      deliveryId: 'start:fresh-codex-persist-count',
    };
    let creationPersistCalls = 0;
    const originalPersistNow = creationFixture.manager.persistNow.bind(creationFixture.manager);
    creationFixture.manager.persistNow = () => {
      creationPersistCalls += 1;
      return originalPersistNow();
    };
    creationFixture.manager.create(codexCreationRequest);
    assert.equal(creationPersistCalls, 2,
      'argv prompt 생성은 spawn 전 creation+prepared, spawn 후 accepted 상태를 각각 한 번만 저장해야 합니다.');

    const restartedCreation = managerFixture(root, { storeFile: creationStoreFile });
    restartedCreation.manager.recoverPersistedSessions();
    const afterHostRestart = restartedCreation.manager.create({ ...creationRequest, includeReplay: false });
    assert.equal(Object.hasOwn(afterHostRestart, 'replay'), false);
    assert.equal(afterHostRestart.id, firstCreation.id);
    assert.equal(afterHostRestart.creationDuplicate, true);
    assert.equal(afterHostRestart.creationUnavailable, true);
    assert.equal(afterHostRestart.recoverySkippedReason, 'unsafe-agent-restart');
    assert.equal(restartedCreation.spawns.length, 0, 'host 재시작 뒤 동일 생성 요청은 fresh provider를 다시 실행하면 안 됩니다.');

    let failedSpawnAttempts = 0;
    const failedCreation = managerFixture(root, {
      ptyModule: {
        spawn() {
          failedSpawnAttempts += 1;
          throw new Error('provider executable missing');
        },
      },
    });
    const failedResult = failedCreation.manager.create({
      ...creationRequest,
      creationId: 'create:fresh-grok-failed',
      deliveryId: 'start:fresh-grok-failed',
      includeReplay: false,
    });
    const reusedFailure = failedCreation.manager.create({
      ...creationRequest,
      creationId: 'create:fresh-grok-failed',
      deliveryId: 'start:fresh-grok-failed',
    });
    assert.equal(Object.hasOwn(failedResult, 'replay'), false, 'metadata-only 실패 create가 replay를 반환하면 안 됩니다.');
    assert.equal(Object.hasOwn(reusedFailure, 'replay'), true, '실패 create 재시도도 기본 replay 동작을 유지해야 합니다.');
    assert.equal(failedResult.status, 'failed');
    assert.equal(failedResult.creationFailed, true);
    assert.equal(reusedFailure.id, failedResult.id);
    assert.equal(reusedFailure.creationDuplicate, true);
    assert.equal(failedSpawnAttempts, 1, '실패한 생성 요청도 같은 session을 열어야 하며 다시 spawn하면 안 됩니다.');

    let registrationSpawnAttempts = 0;
    let registrationCleanupKills = 0;
    const registrationFailure = managerFixture(root, {
      killTree: handle => handle.kill(),
      ptyModule: {
        spawn() {
          registrationSpawnAttempts += 1;
          return {
            pid: 61_000,
            onData() { throw new Error('PTY data listener registration failed'); },
            onExit() {},
            write() {},
            resize() {},
            kill() { registrationCleanupKills += 1; },
          };
        },
      },
    });
    const registrationRequest = {
      ...codexCreationRequest,
      creationId: 'create:fresh-codex-registration-failed',
      deliveryId: 'start:fresh-codex-registration-failed',
    };
    const registrationResult = registrationFailure.manager.create(registrationRequest);
    const registrationDuplicate = registrationFailure.manager.create(registrationRequest);
    assert.equal(registrationResult.status, 'failed');
    assert.equal(registrationResult.deliveryState, 'unknown',
      '프로세스가 시작된 뒤 초기화가 실패하면 argv 질문 도달 여부를 rejected로 단정하면 안 됩니다.');
    assert.equal(registrationCleanupKills, 1,
      'listener 등록 뒤 실패한 실제 프로세스는 handle을 잃기 전에 전체 종료해야 합니다.');
    assert.equal(registrationFailure.manager.sessions.get(registrationResult.id).process, null);
    assert.equal(registrationDuplicate.id, registrationResult.id);
    assert.equal(registrationSpawnAttempts, 1,
      '초기화 실패한 creationId 재전송이 제어 불가능한 두 번째 AI 프로세스를 만들면 안 됩니다.');

    const failingFileSystem = Object.create(fs);
    failingFileSystem.writeFileSync = () => { throw new Error('simulated creation ledger failure'); };
    failingFileSystem.unlinkSync = () => {};
    const blockedCreation = managerFixture(root, {
      storeFile: path.join(temp, 'fresh-creation-ledger-blocked.json'),
      fileSystem: failingFileSystem,
      onPersistenceError: () => {},
    });
    assert.throws(
      () => blockedCreation.manager.create({
        ...creationRequest,
        creationId: 'create:fresh-grok-ledger-blocked',
        deliveryId: 'start:fresh-grok-ledger-blocked',
      }),
      error => error.code === 'CREATION_LEDGER_UNAVAILABLE'
        && error.creationState === 'rejected',
    );
    assert.equal(blockedCreation.spawns.length, 0, '생성 장부 영속화 실패 시 spawn 전에 fail closed해야 합니다.');
  });

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

  test('bound PTY는 xterm의 raw 키 입력과 control signal·전용 승인을 전달한다', () => {
    const { manager, writes, spawns } = managerFixture(root);
    const created = manager.create(boundOptions(root));
    assert.equal(created.backend, 'direct');
    assert.equal(created.conversationBound, true);
    assert.equal(spawns.length, 1);
    manager.write(created.id, '직접 입력');
    manager.write(created.id, '\r');
    assert.deepStrictEqual(writes, ['직접 입력', '\r']);

    manager.command(created.id, '일반 질문입니다');
    manager.signal(created.id, 'interrupt');
    manager.respond(created.id, 'y');
    manager.respond(created.id, 'Escape');
    manager.respond(created.id, '7');
    const guarded = manager.respond(created.id, 'a', {
      deliveryId: 'attention:approval-once',
      expectedOutputSequence: 0,
    });
    assert.equal(guarded.deliveryState, 'accepted');
    assert.equal(manager.respond(created.id, 'a', {
      deliveryId: 'attention:approval-once',
      expectedOutputSequence: 0,
    }).duplicate, true, '같은 승인 전달 ID는 PTY에 두 번 쓰면 안 됩니다.');
    assert.deepStrictEqual(writes, ['직접 입력', '\r', '일반 질문입니다\r', '\x03', 'y', '\x1b', '7', 'a']);
    manager.sessions.get(created.id).process.dataCallback('새 프롬프트 출력');
    assert.throws(
      () => manager.respond(created.id, 'y', {
        deliveryId: 'attention:stale-approval',
        expectedOutputSequence: 0,
      }),
      error => error.code === 'TERMINAL_PROMPT_STALE' && error.deliveryState === 'rejected',
    );
    assert.deepStrictEqual(writes, ['직접 입력', '\r', '일반 질문입니다\r', '\x03', 'y', '\x1b', '7', 'a']);
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

  test('bound PTY UI는 중복 포커스 버튼 없이 xterm stdin과 전용 respond API를 노출한다', () => {
    const workbench = fs.readFileSync(path.join(root, 'renderer', 'terminal-workbench.js'), 'utf8');
    const drawer = fs.readFileSync(path.join(root, 'renderer', 'drawer-terminal.js'), 'utf8');
    const drawerView = fs.readFileSync(path.join(root, 'renderer', 'app-drawer.js'), 'utf8');
    const graph = fs.readFileSync(path.join(root, 'renderer', 'app-graph-view.js'), 'utf8');
    const messages = fs.readFileSync(path.join(root, 'renderer', 'i18n-messages.js'), 'utf8');
    const terminal = fs.readFileSync(path.join(root, 'renderer', 'terminal.js'), 'utf8');
    const fixturePreload = fs.readFileSync(path.join(root, 'scripts', 'interaction-fixture-preload.js'), 'utf8');
    assert.match(workbench, /inputDisabled = readOnly;/u);
    assert.match(workbench, /const inputDisabled = false;/u);
    assert.match(workbench, /if \(!inputDisabled\) \{\s*terminal\.onData/u);
    assert.equal(drawer.includes('drawerTerminalFocusBtn'), false);
    assert.match(drawerView, /&& !actualTerminalChat/u);
    assert.equal(graph.includes('data-inline-terminal-composer'), false);
    assert.equal(graph.includes('data-inline-terminal-focus'), false);
    assert.equal(messages.includes('"drawer.terminal_focus"'), false);
    assert.match(messages, /실제 PTY 출력 및 스크롤 기록/u);
    assert.match(terminal, /loadtoagent\.terminalRespond/u);
    assert.equal((fixturePreload.match(/terminalRespond:/gu) || []).length, 2,
      'controlled fixture와 real-terminal fixture가 모두 전용 승인 API를 노출해야 합니다.');
  });
}

module.exports = { registerTerminalBoundConversationTests };
