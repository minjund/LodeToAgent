'use strict';

const path = require('path');
const { app } = require('electron');
const { TerminalManager } = require('../src/terminalManager');

const marker = `LODESTAR_PTY_OK_${Date.now()}`;
const manager = new TerminalManager();
let sessionId = '';

function finish(error) {
  try { if (sessionId) manager.close(sessionId); } catch {}
  if (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
  setTimeout(() => app.quit(), 150);
}

app.whenReady().then(() => {
  const output = [];
  const timeout = setTimeout(() => finish(new Error('로컬 PTY 명령 결과 수신 시간이 초과되었습니다.')), 12_000);
  manager.on('data', payload => {
    if (payload.id !== sessionId) return;
    output.push(payload.data);
    if (!output.join('').includes(marker)) return;
    clearTimeout(timeout);
    process.stdout.write(`✓ Electron ${process.platform === 'win32' ? 'ConPTY' : 'PTY'} 생성·입력·출력·종료 검증\n`);
    finish();
  });
  try {
    const type = process.platform === 'win32' ? 'powershell' : 'shell';
    const session = manager.create({ type, cwd: path.resolve(__dirname, '..'), cols: 100, rows: 30 });
    sessionId = session.id;
    manager.command(sessionId, process.platform === 'win32' ? `Write-Output ${marker}` : `printf '${marker}\\n'`);
  } catch (error) {
    clearTimeout(timeout);
    finish(error);
  }
});
