'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const packagedExecutable = String(process.env.LOADTOAGENT_TEST_EXECUTABLE || '').trim();
const electron = packagedExecutable || require('electron');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function launchApp(port, userData, bridgeHome) {
  const stderr = [];
  const switches = [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
  const child = spawn(electron, packagedExecutable ? switches : [root, ...switches], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      LOADTOAGENT_TEST_INSTANCE: '1',
      LOADTOAGENT_BRIDGE_HOME: bridgeHome,
    },
  });
  child.stderr.on('data', chunk => {
    stderr.push(chunk.toString('utf8'));
    if (stderr.length > 100) stderr.shift();
  });
  child.capturedStderr = stderr;
  return child;
}

async function targetPage(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Electron 앱이 시작 중 종료되었습니다.\n${child.capturedStderr.join('')}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
      const target = targets.find(item => item.type === 'page' && /LoadToAgent/i.test(item.title || '')) || targets.find(item => item.type === 'page');
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await pause(150);
  }
  throw new Error(`Electron 디버그 대상(${port})을 찾지 못했습니다.\n${child.capturedStderr.join('')}`);
}

async function connectPage(port, child) {
  const target = await targetPage(port, child);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result || {});
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  return { socket, send };
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '렌더러 평가 실패');
  return result.result?.value;
}

async function waitFor(send, expression, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = await evaluate(send, expression);
      if (value) return value;
    } catch {}
    await pause(120);
  }
  throw new Error(message);
}

function stopUiChildren(testToken) {
  if (process.platform !== 'win32' || !testToken) return;
  const script = [
    "$token = [Environment]::GetEnvironmentVariable('LOADTOAGENT_TEST_CLEANUP_TOKEN')",
    "$targets = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('electron.exe','LoadToAgent.exe') -and $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir') -and $_.CommandLine.Contains($token) })",
    'foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, LOADTOAGENT_TEST_CLEANUP_TOKEN: testToken },
    });
  } catch {}
}

async function stopUi(child, testToken) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    pause(4_000),
  ]);
  stopUiChildren(testToken);
  await pause(300);
}

function processExists(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-restart-'));
  const userData = path.join(temp, 'user-data');
  const bridgeHome = path.join(temp, 'home');
  const testToken = path.basename(temp);
  const hostFile = path.join(userData, 'terminal-host.json');
  const beforeMarker = `LTA_BEFORE_RESTART_${Date.now()}`;
  const afterMarker = `LTA_AFTER_RESTART_${Date.now()}`;
  const recoveryMarker = `LTA_AFTER_HOST_RECOVERY_${Date.now()}`;
  const gracefulRecoveryMarker = `LTA_AFTER_HOST_SIGTERM_${Date.now()}`;
  const [firstPort, secondPort] = await Promise.all([reservePort(), reservePort()]);
  let firstApp = null;
  let secondApp = null;
  let firstPage = null;
  let secondPage = null;
  let hostPid = 0;
  let terminalPid = 0;
  let terminalId = '';
  let outcome = null;
  try {
    firstApp = launchApp(firstPort, userData, bridgeHome);
    firstPage = await connectPage(firstPort, firstApp);
    const bootstrap = await evaluate(firstPage.send, 'window.loadtoagent.bootstrap()');
    const command = bootstrap.platform.id === 'win32'
      ? `Write-Output "${beforeMarker}"`
      : `printf '${beforeMarker}\\n'`;
    const created = await evaluate(firstPage.send, `(async () => window.loadtoagent.terminalCreate({ type: ${JSON.stringify(bootstrap.platform.localShell)}, cwd: ${JSON.stringify(root)}, title: '앱 재시작 유지 검증' }))()`);
    terminalId = created.id;
    await evaluate(firstPage.send, `window.loadtoagent.terminalCommand(${JSON.stringify(terminalId)}, ${JSON.stringify(command)})`);
    const liveTerminal = await waitFor(firstPage.send, `(async () => { const item = await window.loadtoagent.terminalGet(${JSON.stringify(terminalId)}); return item?.replay?.includes(${JSON.stringify(beforeMarker)}) && item.pid > 0 ? item : null; })()`, '첫 앱에서 터미널 출력 표식과 PID를 받지 못했습니다.');
    terminalPid = liveTerminal.pid;
    for (let attempt = 0; attempt < 50 && !fs.existsSync(hostFile); attempt += 1) await pause(100);
    if (!fs.existsSync(hostFile)) throw new Error(`터미널 호스트 발견 파일이 없습니다: ${hostFile}`);
    hostPid = Number(JSON.parse(fs.readFileSync(hostFile, 'utf8')).pid || 0);
    if (!processExists(hostPid) || !processExists(terminalPid)) throw new Error('첫 앱 종료 전 터미널 호스트 또는 PTY가 실행 중이 아닙니다.');

    firstPage.socket.close();
    firstPage = null;
    await stopUi(firstApp, testToken);
    firstApp = null;
    await pause(700);
    if (!processExists(hostPid)) throw new Error('첫 앱 종료와 함께 터미널 호스트가 종료되었습니다.');
    if (!processExists(terminalPid)) throw new Error('첫 앱 종료와 함께 PTY 프로세스가 종료되었습니다.');

    secondApp = launchApp(secondPort, userData, bridgeHome);
    secondPage = await connectPage(secondPort, secondApp);
    const restored = await waitFor(secondPage.send, `(async () => (await window.loadtoagent.terminalList()).find(item => item.id === ${JSON.stringify(terminalId)} && item.status === 'running') || null)()`, '두 번째 앱이 실행 중인 터미널 세션에 다시 연결하지 못했습니다.');
    if (restored.pid !== terminalPid) throw new Error(`PTY PID가 바뀌었습니다: ${terminalPid} -> ${restored.pid}`);
    const afterCommand = bootstrap.platform.id === 'win32'
      ? `Write-Output "${afterMarker}"`
      : `printf '${afterMarker}\\n'`;
    await evaluate(secondPage.send, `window.loadtoagent.terminalCommand(${JSON.stringify(terminalId)}, ${JSON.stringify(afterCommand)})`);
    await waitFor(secondPage.send, `(async () => (await window.loadtoagent.terminalGet(${JSON.stringify(terminalId)}))?.replay?.includes(${JSON.stringify(afterMarker)}))()`, '재연결 뒤 동일 터미널에 명령을 보내지 못했습니다.');

    await pause(300);
    const crashedHostPid = hostPid;
    process.kill(crashedHostPid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL');
    let nextHostPid = 0;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const pid = Number(JSON.parse(fs.readFileSync(hostFile, 'utf8')).pid || 0);
        if (pid && pid !== crashedHostPid && processExists(pid)) {
          nextHostPid = pid;
          break;
        }
      } catch {}
      await pause(120);
    }
    if (!nextHostPid) throw new Error('터미널 호스트가 강제 종료 뒤 자동으로 다시 실행되지 않았습니다.');
    hostPid = nextHostPid;
    let recovered = await waitFor(secondPage.send, `(async () => (await window.loadtoagent.terminalList()).find(item => item.id === ${JSON.stringify(terminalId)} && item.status === 'running' && item.recoveredAfterHostRestart) || null)()`, '호스트 강제 종료 뒤 저장된 터미널을 새 프로세스로 복구하지 못했습니다.');
    const recoveryCommand = bootstrap.platform.id === 'win32'
      ? `Write-Output "${recoveryMarker}"`
      : `printf '${recoveryMarker}\\n'`;
    await evaluate(secondPage.send, `window.loadtoagent.terminalCommand(${JSON.stringify(terminalId)}, ${JSON.stringify(recoveryCommand)})`);
    recovered = await waitFor(secondPage.send, `(async () => { const item = await window.loadtoagent.terminalGet(${JSON.stringify(terminalId)}); return item?.replay?.includes(${JSON.stringify(recoveryMarker)}) && item.pid > 0 ? item : null; })()`, '호스트 복구 뒤 터미널 명령과 PID를 확인하지 못했습니다.');
    // Windows can immediately reuse the terminated ConPTY PID. The changed
    // authenticated host PID plus recoveredAfterHostRestart is authoritative
    // there; POSIX systems should always expose a distinct child PID.
    if (process.platform !== 'win32' && recovered.pid === terminalPid) {
      throw new Error('호스트 강제 종료 뒤 PTY 프로세스가 교체되지 않았습니다.');
    }

    await pause(300);
    const terminatedHostPid = hostPid;
    process.kill(terminatedHostPid, 'SIGTERM');
    let gracefulHostPid = 0;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const pid = Number(JSON.parse(fs.readFileSync(hostFile, 'utf8')).pid || 0);
        if (pid && pid !== terminatedHostPid && processExists(pid)) {
          gracefulHostPid = pid;
          break;
        }
      } catch {}
      await pause(120);
    }
    if (!gracefulHostPid) throw new Error('터미널 호스트가 SIGTERM 뒤 자동으로 다시 실행되지 않았습니다.');
    hostPid = gracefulHostPid;
    let gracefulRecovered = await waitFor(secondPage.send, `(async () => (await window.loadtoagent.terminalList()).find(item => item.id === ${JSON.stringify(terminalId)} && item.status === 'running' && item.recoveredAfterHostRestart) || null)()`, '호스트 SIGTERM 뒤 저장된 터미널을 새 프로세스로 복구하지 못했습니다.');
    const gracefulCommand = bootstrap.platform.id === 'win32'
      ? `Write-Output "${gracefulRecoveryMarker}"`
      : `printf '${gracefulRecoveryMarker}\\n'`;
    await evaluate(secondPage.send, `window.loadtoagent.terminalCommand(${JSON.stringify(terminalId)}, ${JSON.stringify(gracefulCommand)})`);
    gracefulRecovered = await waitFor(secondPage.send, `(async () => { const item = await window.loadtoagent.terminalGet(${JSON.stringify(terminalId)}); return item?.replay?.includes(${JSON.stringify(gracefulRecoveryMarker)}) && item.pid > 0 ? item : null; })()`, '호스트 SIGTERM 복구 뒤 터미널 명령과 PID를 확인하지 못했습니다.');
    if (process.platform !== 'win32' && gracefulRecovered.pid === recovered.pid) throw new Error('호스트 SIGTERM 뒤 PTY PID가 새 프로세스로 교체되지 않았습니다.');
    await evaluate(secondPage.send, `window.loadtoagent.terminalClose(${JSON.stringify(terminalId)})`);
    terminalId = '';
    outcome = {
      ok: true,
      hostPid,
      crashedHostPid,
      terminatedHostPid,
      terminalPid,
      recoveredTerminalPid: recovered.pid,
      gracefulRecoveredTerminalPid: gracefulRecovered.pid,
      sameSession: gracefulRecovered.id,
      status: gracefulRecovered.status,
    };
  } finally {
    if (terminalId && secondPage) {
      try { await evaluate(secondPage.send, `window.loadtoagent.terminalClose(${JSON.stringify(terminalId)})`); } catch {}
    }
    if (firstPage) firstPage.socket.close();
    if (secondPage) secondPage.socket.close();
    await stopUi(firstApp, testToken);
    await stopUi(secondApp, testToken);
    stopUiChildren(testToken);
    if (hostPid && processExists(hostPid)) {
      try { process.kill(hostPid); } catch {}
    }
    await pause(1_500);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
