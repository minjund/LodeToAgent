'use strict';

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { TerminalManager } = require('../src/terminalManager');
const { BridgeServer } = require('../src/bridgeServer');

function runCli(file, discovery) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, 'run', 'codex'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LODESTAR_BRIDGE_FILE: discovery },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

app.whenReady().then(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestar-bridge-e2e-'));
  const discovery = path.join(temp, 'bridge.json');
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\lodestar-e2e-${process.pid}` : path.join(temp, 'bridge.sock');
  const command = process.platform === 'win32'
    ? { command: process.env.ComSpec || 'cmd.exe', args: ['/Q', '/D', '/C', 'echo LODESTAR_BRIDGE_E2E'], label: '가짜 Codex' }
    : { command: '/bin/sh', args: ['-lc', 'printf LODESTAR_BRIDGE_E2E'], label: '가짜 Codex' };
  const manager = new TerminalManager({ platform: process.platform, agentProviders: { codex: command } });
  const server = new BridgeServer({ terminalManager: manager, home: temp, platform: process.platform, endpoint, discoveryFile: discovery, token: 'e2e-token' });
  try {
    await server.start();
    const result = await runCli(path.join(__dirname, '..', 'bin', 'lodestar.js'), discovery);
    if (result.code !== 0 || !result.stdout.includes('LODESTAR_BRIDGE_E2E')) throw new Error(`브리지 왕복 실패: code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    if (!manager.list().some(session => session.type === 'agent' && session.provider === 'codex')) throw new Error('브리지 AI PTY가 생성되지 않았습니다.');
    process.stdout.write('✓ 외부 CLI → 인증 소켓 → Lodestar PTY → AI 출력 왕복 검증\n');
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    server.dispose();
    manager.dispose();
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
    app.quit();
  }
});
