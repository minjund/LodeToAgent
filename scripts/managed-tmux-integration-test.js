'use strict';

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TerminalManager } = require('../src/terminalManager');
const { ManagedTmuxRuntime } = require('../src/managedTmuxRuntime');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const waitForSession = async (runtime, options, timeoutMs = 8_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (runtime.exists(options)) return;
    await wait(50);
  }
  throw new Error('관리형 tmux 세션이 제한 시간 안에 시작되지 않았습니다.');
};

const waitForOutput = (manager, id, marker, timeoutMs = 8_000) => new Promise((resolve, reject) => {
  const existing = manager.get(id, true)?.replay || '';
  if (existing.includes(marker)) {
    resolve();
    return;
  }
  const timeout = setTimeout(() => {
    manager.off('data', onData);
    reject(new Error(`관리형 tmux 출력 대기 시간이 초과되었습니다: ${marker}`));
  }, timeoutMs);
  const onData = payload => {
    if (payload.id !== id || !String(payload.data || '').includes(marker)) return;
    clearTimeout(timeout);
    manager.off('data', onData);
    resolve();
  };
  manager.on('data', onData);
});

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    process.stdout.write('✓ 관리형 tmux 실환경 검증은 POSIX 또는 WSL 환경에서 실행합니다.\n');
    app.quit();
    return;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-managed-tmux-'));
  const socket = `lta-e2e-${process.pid}-${Date.now()}`;
  const runtime = new ManagedTmuxRuntime({ platform: process.platform });
  const manager = new TerminalManager({
    platform: process.platform,
    storeFile: path.join(temp, 'sessions.json'),
    managedTmuxRuntime: runtime,
    agentProviders: {
      codex: { command: '/bin/sh', args: ['-i'], label: 'Fixture agent' },
    },
  });
  let sessionId = '';
  try {
    const created = manager.create({
      type: 'agent',
      provider: 'codex',
      cwd: path.resolve(__dirname, '..'),
      tmuxSocket: socket,
      title: 'Managed tmux integration fixture',
    });
    sessionId = created.id;
    const options = manager.required(sessionId).options;
    await waitForSession(runtime, options);
    const attachedMarker = `WHITEBOX_MANAGED_ATTACHED_${Date.now()}`;
    const attachedOutput = waitForOutput(manager, sessionId, attachedMarker);
    manager.command(sessionId, `printf '${attachedMarker}\\n'`);
    await attachedOutput;

    const windowSize = runtime.execute(options, ['show-options', '-g', '-v', 'window-size']).trim();
    if (windowSize !== 'largest') throw new Error(`tmux window-size 설정이 largest가 아닙니다: ${windowSize}`);

    const detached = await manager.detach(sessionId);
    if (detached.status !== 'detached' || !runtime.exists(options)) {
      throw new Error('PTY 화면을 분리한 뒤 tmux 작업이 유지되지 않았습니다.');
    }

    const backgroundMarker = `WHITEBOX_MANAGED_BACKGROUND_${Date.now()}`;
    const targetPane = `${options.managedTmuxSession}:0.0`;
    runtime.execute(options, ['send-keys', '-l', '-t', targetPane, `printf '${backgroundMarker}\\n'`]);
    runtime.execute(options, ['send-keys', '-t', targetPane, 'Enter']);
    const backgroundOutput = waitForOutput(manager, sessionId, backgroundMarker);
    const reconnected = manager.reconnect(sessionId);
    if (reconnected.id !== sessionId || reconnected.status !== 'running') {
      throw new Error('기존 관리형 tmux 세션에 같은 ID로 재접속하지 못했습니다.');
    }
    await backgroundOutput;

    const stopped = await manager.stop(sessionId);
    if (stopped.status !== 'stopped' || runtime.exists(options) || !manager.get(sessionId)) {
      throw new Error('명시적 중단 뒤 tmux 작업 종료와 세션 기록 보존이 일치하지 않습니다.');
    }
    await manager.close(sessionId);
    sessionId = '';
    if (manager.list().length !== 0) throw new Error('관리형 tmux 세션 기록이 제거되지 않았습니다.');

    process.stdout.write('✓ 관리형 tmux 생성·출력·분리·백그라운드 지속·동일 ID 재접속·중단·기록 제거 검증\n');
  } catch (error) {
    const replay = sessionId ? manager.get(sessionId, true)?.replay || '' : '';
    process.stderr.write(`${error.stack || error.message}\n`);
    if (replay) process.stderr.write(`--- managed tmux replay ---\n${replay}\n`);
    process.exitCode = 1;
  } finally {
    try {
      if (sessionId && manager.get(sessionId)) await manager.close(sessionId);
    } catch {}
    await manager.dispose();
    try { runtime.execute({ tmuxSocket: socket }, ['kill-server']); } catch {}
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
    setTimeout(() => app.exit(process.exitCode || 0), 100);
  }
});
