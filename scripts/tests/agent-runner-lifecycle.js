'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { AgentRunner, signalPosixProcessTree } = require('../../src/agentRunner');

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
    },
    stdoutBuffer: '',
    stderrBuffer: '',
    stopping: false,
    processGroup: true,
  };
}

function registerAgentRunnerLifecycleTests(context) {
  const { test, temp, root } = context;

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

    assert.deepStrictEqual(await runner.pause(controlled.id), { ok: true, status: 'paused' });
    assert.deepStrictEqual(await runner.resume(controlled.id), { ok: true, status: 'running' });
    assert.deepStrictEqual(runner.stop(controlled.id), { ok: true });
    assert.deepStrictEqual(signals.slice(0, 3), [
      [-6_001, 'SIGSTOP'],
      [-6_001, 'SIGCONT'],
      [-6_001, 'SIGTERM'],
    ]);
    runner.active.delete(controlled.id);
  });

  test('앱 종료는 POSIX 직접 실행 AI의 자연스러운 close를 기다리고 상태를 저장한다', async () => {
    const runsDir = path.join(temp, 'agent-runner-graceful-dispose');
    const signals = [];
    const runner = new AgentRunner({
      runsDir,
      platform: 'darwin',
      terminationGraceMs: 50,
      killProcess: (pid, signal) => { signals.push([pid, signal]); },
    });
    const disposing = runFixture(runsDir, 'graceful-dispose-run', 6_002, 'paused');
    runner.active.set(disposing.id, disposing);

    const disposal = runner.dispose();
    assert.strictEqual(runner.dispose(), disposal);
    assert.deepStrictEqual(signals, [[-6_002, 'SIGCONT'], [-6_002, 'SIGTERM']]);
    assert.equal(runner.listActive().length, 1);
    assert.equal(disposing.state.status, 'paused');

    disposing.child.emit('close', 0, 'SIGTERM');
    assert.deepStrictEqual(await disposal, { stopped: 1, errors: [] });
    assert.deepStrictEqual(signals, [[-6_002, 'SIGCONT'], [-6_002, 'SIGTERM']]);
    assert.deepStrictEqual(runner.listActive(), []);
    const persisted = JSON.parse(fs.readFileSync(path.join(disposing.dir, 'session.json'), 'utf8'));
    assert.equal(persisted.status, 'cancelled');
    assert.equal(Boolean(persisted.endedAt), true);
    assert.equal(persisted.lifecycle.some(item => item.id === 'process-end'), true);
  });

  test('앱 종료는 SIGTERM을 무시하는 POSIX 직접 실행 AI 그룹에 SIGKILL을 전달한다', async () => {
    const runsDir = path.join(temp, 'agent-runner-forced-dispose');
    const signals = [];
    const runner = new AgentRunner({
      runsDir,
      platform: 'linux',
      terminationGraceMs: 5,
      killProcess: (pid, signal) => { signals.push([pid, signal]); },
    });
    const disposing = runFixture(runsDir, 'forced-dispose-run', 6_003);
    runner.active.set(disposing.id, disposing);

    const disposal = runner.dispose();
    assert.deepStrictEqual(signals, [[-6_003, 'SIGTERM']]);
    assert.equal(runner.listActive().length, 1);

    assert.deepStrictEqual(await disposal, { stopped: 1, errors: [] });
    assert.deepStrictEqual(signals, [[-6_003, 'SIGTERM'], [-6_003, 'SIGKILL']]);
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
      options: { windowsHide: true },
    }]);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(runner.listActive().length, 1);

    taskkillCallback(null);
    assert.deepStrictEqual(await disposal, { stopped: 1, errors: [] });
    assert.equal(settled, true);
    assert.deepStrictEqual(runner.listActive(), []);
  });
}

module.exports = { registerAgentRunnerLifecycleTests };
