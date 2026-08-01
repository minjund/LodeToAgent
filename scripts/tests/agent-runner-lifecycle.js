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

  test('직접 실행 AI는 POSIX 프로세스 그룹 전체를 제어하고 앱 종료 상태를 저장한다', async () => {
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

    const disposing = runFixture(runsDir, 'dispose-run', 6_002, 'paused');
    runner.active.set(disposing.id, disposing);
    const disposed = runner.dispose();
    assert.deepStrictEqual(disposed, { stopped: 1, errors: [] });
    assert.deepStrictEqual(signals.slice(-2), [[-6_002, 'SIGCONT'], [-6_002, 'SIGTERM']]);
    assert.deepStrictEqual(runner.listActive(), []);
    const persisted = JSON.parse(fs.readFileSync(path.join(disposing.dir, 'session.json'), 'utf8'));
    assert.equal(persisted.status, 'cancelled');
    assert.equal(Boolean(persisted.endedAt), true);
    assert.equal(persisted.lifecycle.some(item => item.id === 'process-end'), true);
  });
}

module.exports = { registerAgentRunnerLifecycleTests };
