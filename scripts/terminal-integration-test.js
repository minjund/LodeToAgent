'use strict';

const path = require('path');
const { app } = require('electron');
const { TerminalManager } = require('../src/terminalManager');

const marker = `LOADTOAGENT_PTY_OK_${Date.now()}`;
const boundReadyMarker = 'LOADTOAGENT_BOUND_PTY_READY';
const boundInterruptedMarker = 'LOADTOAGENT_BOUND_PTY_INTERRUPTED';
const manager = new TerminalManager({
  agentProviders: {
    codex: {
      command: 'node',
      args: [path.join(__dirname, 'bound-pty-interrupt-fixture.js')],
      label: 'Bound PTY integration',
    },
  },
});
const outputBySession = new Map();
let sessionId = '';
let finishing = false;

manager.on('data', payload => {
  if (!payload?.id) return;
  outputBySession.set(payload.id, `${outputBySession.get(payload.id) || ''}${String(payload.data || '')}`);
});

function waitForMarker(id, expected, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      manager.off('data', onData);
    };
    const check = () => {
      if (!String(outputBySession.get(id) || '').includes(expected)) return false;
      cleanup();
      resolve();
      return true;
    };
    const onData = payload => {
      if (payload?.id === id) check();
    };
    manager.on('data', onData);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`로컬 PTY 출력 ${expected} 수신 시간이 초과되었습니다.`));
    }, timeoutMs);
    check();
  });
}

async function finish(error) {
  if (finishing) return;
  finishing = true;
  try { if (sessionId) await manager.close(sessionId); } catch (closeError) {
    if (!error) error = closeError;
  }
  if (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
  setTimeout(() => app.exit(process.exitCode || 0), 150);
}

app.whenReady().then(async () => {
  try {
    const type = process.platform === 'win32' ? 'powershell' : 'shell';
    const session = manager.create({ type, cwd: path.resolve(__dirname, '..'), cols: 100, rows: 30 });
    sessionId = session.id;
    const shellOutput = waitForMarker(sessionId, marker);
    manager.command(sessionId, process.platform === 'win32' ? `Write-Output ${marker}` : `printf '${marker}\\n'`);
    await shellOutput;
    await manager.close(sessionId);
    sessionId = '';
    process.stdout.write(`✓ Electron ${process.platform === 'win32' ? 'ConPTY' : 'PTY'} 생성·입력·출력·종료 검증\n`);

    const historyId = '019f-bound-interrupt-integration';
    const bound = manager.create({
      type: 'agent',
      provider: 'codex',
      cwd: path.resolve(__dirname, '..'),
      args: ['resume', historyId],
      recoveryArgs: ['resume', historyId],
      bridgeId: `codex:${historyId}`,
      agentConnectionSignature: `acs1:${'c'.repeat(64)}`,
      sessionBackend: 'direct',
      reuseBridge: true,
      cols: 100,
      rows: 30,
    });
    sessionId = bound.id;
    await waitForMarker(sessionId, boundReadyMarker);
    manager.write(sessionId, 'native xterm input');
    const interrupted = waitForMarker(sessionId, boundInterruptedMarker);
    manager.signal(sessionId, 'interrupt');
    await interrupted;
    process.stdout.write('✓ bound 실제 PTY 장기 작업 xterm 입력·Ctrl+C 중단 검증\n');
    await finish();
  } catch (error) {
    await finish(error);
  }
});
