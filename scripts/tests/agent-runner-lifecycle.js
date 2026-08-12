'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { AgentRunner, MAX_AGENT_OUTPUT_LINE_BYTES, signalPosixProcessTree } = require('../../src/agentRunner');

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function runFixture(runsDir, id, pid, status = 'running') {
  const dir = path.join(runsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  return {
    id,
    provider: 'codex',
    dir,
    child: fakeChild(pid),
    state: {
      externalId: id,
      provider: 'codex',
      status,
      statusDetail: '실행 중',
      updatedAt: new Date().toISOString(),
      endedAt: null,
      lifecycle: [],
      messages: [],
      usage: { total: 0, input: 0 },
      turnUsage: { total: 0, input: 0 },
    },
    stdoutBuffer: '',
    stderrBuffer: '',
    stopping: false,
    processGroup: true,
  };
}

function registerAgentRunnerLifecycleTests(context) {
  const { test, temp, root } = context;

  test('직접 실행 AI 출력은 줄 크기를 제한하고 디스크 저장을 묶어서 처리한다', () => {
    const runsDir = path.join(temp, 'agent-runner-output-bounds');
    const signals = [];
    const runner = new AgentRunner({
      runsDir,
      platform: 'linux',
      persistDelayMs: 1_000,
      killProcess: (pid, signal) => { signals.push([pid, signal]); },
    });
    const batched = runFixture(runsDir, 'batched-output-run', 5_100);
    runner.consume(batched, 'stdout', Buffer.from([
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } }),
      '',
    ].join('\n')));
    assert.equal(batched.pendingEventLines.length, 2);
    assert.equal(fs.existsSync(path.join(batched.dir, 'events.jsonl')), false,
      '각 출력 줄마다 즉시 디스크에 쓰면 안 됩니다.');
    runner.persist(batched);
    assert.equal(batched.persistTimer, null);
    assert.equal(fs.readFileSync(path.join(batched.dir, 'events.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(batched.dir, 'session.json'), 'utf8')).status, 'completed');

    const unicode = runFixture(runsDir, 'split-unicode-output-run', 5_102);
    const answer = '청크 경계에서도 한글과 이모지 😀 답변 보존';
    const encoded = Buffer.from(`${JSON.stringify({
      type: 'item.completed',
      item: { id: 'unicode-answer', type: 'agent_message', text: answer },
    })}\n`, 'utf8');
    // One-byte chunks force every multi-byte code point across stream events.
    for (let index = 0; index < encoded.length; index += 1) {
      runner.consume(unicode, 'stdout', encoded.subarray(index, index + 1));
    }
    assert.equal(unicode.stdoutBuffer, '');
    assert.equal(unicode.state.messages.find(message => message.id === 'unicode-answer')?.text, answer);
    assert.equal(unicode.pendingEventLines.length, 1, '분할 UTF-8 JSONL을 plain text로 잃으면 안 됩니다.');

    const oversized = runFixture(runsDir, 'oversized-output-run', 5_101);
    runner.consume(oversized, 'stdout', Buffer.alloc(MAX_AGENT_OUTPUT_LINE_BYTES + 1, 0x61));
    assert.equal(oversized.outputOverflow, true);
    assert.equal(oversized.stdoutBuffer, '');
    assert.equal(oversized.state.status, 'failed');
    assert.equal(oversized.state.activityState, 'error');
    assert.equal(oversized.state.completionObserved, false);
    assert.equal(oversized.state.lifecycle.some(item => item.id === 'output-overflow'), true);
    assert.deepStrictEqual(signals, [[-5_101, 'SIGKILL']]);
  });

  test('직접 실행 AI는 POSIX 프로세스 그룹 전체를 제어한다', async () => {
    const fallbackSignals = [];
    const fallback = signalPosixProcessTree(4_321, 'SIGTERM', (pid, signal) => {
      fallbackSignals.push([pid, signal]);
      if (pid < 0) throw Object.assign(new Error('missing group'), { code: 'ESRCH' });
    });
    assert.deepStrictEqual(fallback, { group: false, pid: 4_321, signal: 'SIGTERM' });
    assert.deepStrictEqual(fallbackSignals, [[-4_321, 'SIGTERM'], [4_321, 'SIGTERM']]);
    assert.throws(() => signalPosixProcessTree(1, 'SIGTERM', () => {}), /PID/);

    const executableDir = path.join(temp, 'agent-runner-bin');
    fs.mkdirSync(executableDir, { recursive: true });
    for (const name of ['codex', 'codex.cmd']) {
      const executable = path.join(executableDir, name);
      fs.writeFileSync(executable, '', 'utf8');
      fs.chmodSync(executable, 0o755);
    }
    const previousPath = process.env.PATH;
    const spawnCalls = [];
    const spawnedChild = fakeChild(5_001);
    const spawnedRunsDir = path.join(temp, 'agent-runner-spawn');
    try {
      process.env.PATH = `${executableDir}${path.delimiter}${previousPath || ''}`;
      const spawningRunner = new AgentRunner({
        runsDir: spawnedRunsDir,
        platform: 'darwin',
        spawn: (command, args, options) => {
          spawnCalls.push({ command, args, options });
          return spawnedChild;
        },
        killProcess: () => {},
      });
      const started = spawningRunner.start({ provider: 'codex', prompt: '프로세스 그룹 확인', cwd: root });
      assert.equal(started.ok, true);
      assert.equal(spawnCalls[0].options.detached, true);
      assert.equal(spawnCalls[0].options.shell, false);
      spawnedChild.emit('close', 0, null);
      assert.deepStrictEqual(spawningRunner.listActive(), []);
    } finally {
      process.env.PATH = previousPath;
    }

    const runsDir = path.join(temp, 'agent-runner-lifecycle');
    const signals = [];
    const runner = new AgentRunner({
      runsDir,
      platform: 'darwin',
      killProcess: (pid, signal) => { signals.push([pid, signal]); },
    });
    const controlled = runFixture(runsDir, 'controlled-run', 6_001);
    runner.active.set(controlled.id, controlled);

    assert.throws(() => runner.prepareForUpdate([]), /새 직접 실행 작업/);
    assert.deepStrictEqual(runner.prepareForUpdate([{ runId: controlled.id }]), { active: 1 });
    assert.match(runner.start({}).error, /종료 중/);
    assert.equal(runner.resumeAfterUpdateFailure(), true);

    assert.deepStrictEqual(await runner.pause(controlled.id), { ok: true, status: 'paused' });
    assert.deepStrictEqual(await runner.resume(controlled.id), { ok: true, status: 'running' });
    assert.deepStrictEqual(runner.stop(controlled.id), { ok: true });
    assert.deepStrictEqual(signals.slice(0, 3), [
      [-6_001, 'SIGSTOP'],
      [-6_001, 'SIGCONT'],
      [-6_001, 'SIGTERM'],
    ]);
    runner.active.delete(controlled.id);
    assert.deepStrictEqual(runner.prepareForUpdate([]), { active: 0 });
    assert.deepStrictEqual(await runner.dispose(), { stopped: 0, errors: [] });
    assert.equal(runner.resumeAfterUpdateFailure(), false, 'dispose가 시작된 runner를 다시 활성화하면 안 됩니다.');
    assert.match(runner.start({}).error, /종료 중/);
  });

  test('앱 종료는 POSIX 직접 실행 AI의 자연스러운 close를 기다리고 상태를 저장한다', async () => {
    const runsDir = path.join(temp, 'agent-runner-graceful-dispose');
    const signals = [];
    let reentrantStart = null;
    let reentrantRetry = null;
    let runner = null;
    runner = new AgentRunner({
      runsDir,
      platform: 'darwin',
      terminationGraceMs: 50,
      killProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 'SIGTERM') {
          reentrantStart = runner.start({});
          reentrantRetry = runner.retry('graceful-dispose-run');
        }
      },
    });
    const disposing = runFixture(runsDir, 'graceful-dispose-run', 6_002, 'paused');
    runner.active.set(disposing.id, disposing);

    const disposal = runner.dispose();
    assert.strictEqual(runner.dispose(), disposal);
    assert.deepStrictEqual(signals, [[-6_002, 'SIGCONT'], [-6_002, 'SIGTERM']]);
    assert.equal(runner.listActive().length, 1);
    assert.equal(disposing.state.status, 'paused');
    assert.deepStrictEqual(reentrantStart, { ok: false, error: '프로그램이 종료 중이므로 새 작업을 시작할 수 없습니다.' });
    assert.deepStrictEqual(reentrantRetry, reentrantStart);
    assert.deepStrictEqual(runner.start({}), reentrantStart);
    assert.deepStrictEqual(runner.retry('graceful-dispose-run'), reentrantStart);

    disposing.child.emit('close', 0, 'SIGTERM');
    assert.deepStrictEqual(await disposal, { stopped: 1, errors: [] });
    assert.deepStrictEqual(signals, [[-6_002, 'SIGCONT'], [-6_002, 'SIGTERM']]);
    assert.deepStrictEqual(runner.listActive(), []);
    const persisted = JSON.parse(fs.readFileSync(path.join(disposing.dir, 'session.json'), 'utf8'));
    assert.equal(persisted.status, 'cancelled');
    assert.equal(Boolean(persisted.endedAt), true);
    assert.equal(persisted.lifecycle.some(item => item.id === 'process-end'), true);

    const endedAt = persisted.endedAt;
    runner.consume(disposing, 'stdout', Buffer.from('{"type":"turn.started"}\n'));
    runner.handleChildError(disposing, new Error('늦은 프로세스 오류'));
    const afterLateEvents = JSON.parse(fs.readFileSync(path.join(disposing.dir, 'session.json'), 'utf8'));
    assert.equal(disposing.state.status, 'cancelled');
    assert.equal(afterLateEvents.status, 'cancelled');
    assert.equal(afterLateEvents.endedAt, endedAt);
    assert.equal(afterLateEvents.lifecycle.some(item => item.id === 'process-error'), false);
  });

  test('앱 종료는 SIGTERM을 무시하는 POSIX 직접 실행 AI 그룹에 SIGKILL을 전달한다', async () => {
    const runsDir = path.join(temp, 'agent-runner-forced-dispose');
    const signals = [];
    let forcedKillResolve;
    const forcedKill = new Promise(resolve => { forcedKillResolve = resolve; });
    const runner = new AgentRunner({
      runsDir,
      platform: 'linux',
      terminationGraceMs: 0,
      killProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 'SIGKILL') forcedKillResolve();
      },
    });
    const disposing = runFixture(runsDir, 'forced-dispose-run', 6_003);
    runner.active.set(disposing.id, disposing);

    let settled = false;
    const disposal = runner.dispose().then(result => {
      settled = true;
      return result;
    });
    assert.deepStrictEqual(signals, [[-6_003, 'SIGTERM']]);
    assert.equal(runner.listActive().length, 1);

    await forcedKill;
    assert.deepStrictEqual(signals, [[-6_003, 'SIGTERM'], [-6_003, 'SIGKILL']]);
    assert.equal(settled, false);
    assert.equal(runner.listActive().length, 1);
    disposing.child.emit('close', null, 'SIGKILL');
    assert.deepStrictEqual(await disposal, { stopped: 1, errors: [] });
    assert.deepStrictEqual(runner.listActive(), []);
  });

  test('앱 종료는 Windows taskkill 콜백이 완료될 때까지 직접 실행 AI를 유지한다', async () => {
    const runsDir = path.join(temp, 'agent-runner-windows-dispose');
    const calls = [];
    let taskkillCallback = null;
    const runner = new AgentRunner({
      runsDir,
      platform: 'win32',
      execFile: (command, args, options, callback) => {
        calls.push({ command, args, options });
        taskkillCallback = callback;
      },
    });
    const disposing = runFixture(runsDir, 'windows-dispose-run', 6_004);
    runner.active.set(disposing.id, disposing);

    let settled = false;
    const disposal = runner.dispose().then(result => {
      settled = true;
      return result;
    });
    assert.deepStrictEqual(calls, [{
      command: 'taskkill',
      args: ['/PID', '6004', '/T', '/F'],
      options: { windowsHide: true, timeout: 1_000 },
    }]);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(runner.listActive().length, 1);

    taskkillCallback(null);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(runner.listActive().length, 1);
    disposing.child.emit('close', null, 'SIGKILL');
    assert.deepStrictEqual(await disposal, { stopped: 1, errors: [] });
    assert.equal(settled, true);
    assert.deepStrictEqual(runner.listActive(), []);

    const timedOutDir = path.join(temp, 'agent-runner-windows-timeout');
    const timedOutRunner = new AgentRunner({
      runsDir: timedOutDir,
      platform: 'win32',
      terminationGraceMs: 0,
      execFile: () => {},
    });
    const timedOutRun = runFixture(timedOutDir, 'windows-timeout-run', 6_005);
    timedOutRunner.active.set(timedOutRun.id, timedOutRun);
    const timedOutResult = await timedOutRunner.dispose();
    assert.equal(timedOutResult.stopped, 1);
    assert.equal(timedOutResult.errors.length, 2);
    assert.match(timedOutResult.errors[0].error, /taskkill 응답 대기 시간/);
    assert.match(timedOutResult.errors[1].error, /taskkill 이후 프로그램 종료/);
    assert.deepStrictEqual(timedOutRunner.listActive(), []);
    assert.equal(timedOutRunner.resumeAfterUpdateFailure(), false,
      '종료 확인 오류가 난 runner도 업데이트 실패 뒤 새 실행을 허용하면 안 됩니다.');
    const timedOutState = JSON.parse(fs.readFileSync(path.join(timedOutRun.dir, 'session.json'), 'utf8'));
    assert.equal(timedOutState.status, 'cancelled');
    assert.equal(timedOutState.lifecycle.some(item => item.id === 'dispose-error'), true);

    const sessionEndDir = path.join(temp, 'agent-runner-windows-session-end');
    const sessionEndRunner = new AgentRunner({ runsDir: sessionEndDir, platform: 'win32' });
    const sessionEndRun = runFixture(sessionEndDir, 'windows-session-end-run', 6_006);
    sessionEndRunner.active.set(sessionEndRun.id, sessionEndRun);
    assert.deepStrictEqual(sessionEndRunner.prepareForSystemShutdown(), { stopped: 1, errors: [] });
    const checkpoint = JSON.parse(fs.readFileSync(path.join(sessionEndRun.dir, 'session.json'), 'utf8'));
    assert.equal(checkpoint.status, 'cancelled');
    assert.equal(Boolean(checkpoint.endedAt), true);
    assert.equal(checkpoint.lifecycle.some(item => item.id === 'process-end'), true);
    assert.equal(sessionEndRunner.listActive().length, 1);
    assert.equal(sessionEndRun.finalized, true);
    assert.match(sessionEndRunner.start({}).error, /종료 중/);
    assert.match(sessionEndRunner.retry('windows-session-end-run').error, /종료 중/);

    const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.match(mainSource, /mainWindow\.on\('query-session-end', persistDirectRunsForWindowsSessionEnd\)/);
    assert.match(mainSource, /runner\.prepareForSystemShutdown\(\)/);
    assert.match(mainSource, /reportAgentRunnerCleanupErrors\('before-quit:agent-runner', result\)/);
    assert.match(mainSource, /runner\.prepareForUpdate\(impact\.agentRuns\)/);
    assert.match(mainSource, /requireAgentRunnerUpdateShutdown\(await runner\.dispose\(\)\)/);
    assert.match(mainSource, /UPDATE_AGENT_RUNNER_SHUTDOWN_UNCONFIRMED/);
    assert.match(mainSource, /!runner\.resumeAfterUpdateFailure\(\)/);
    assert.match(mainSource, /update-agent-runner-remains-stopped/);
    assert.match(mainSource, /error\?\.code === 'UPDATE_HELPER_CANCELLATION_UNCONFIRMED'/);
    assert.match(mainSource, /앱을 종료하지 않은 채 최소 60초 기다린 뒤 업데이트를 다시 시도해 주세요/);
    assert.match(mainSource, /UPDATE_HELPER_CANCELLATION_GUARD_MS = 65_000/);
    assert.match(mainSource, /function preventQuitDuringUpdateHelperCancellation/);
    assert.match(mainSource, /if \(preventQuitDuringUpdateHelperCancellation\(event\)\) return/);
    assert.match(mainSource, /systemSessionEnding = true/);
    assert.match(mainSource, /process\.platform === 'win32'[\s\S]+!systemSessionEnding/);
  });
}

module.exports = { registerAgentRunnerLifecycleTests };
