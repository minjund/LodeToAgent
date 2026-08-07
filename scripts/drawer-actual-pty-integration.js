'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain } = require('electron');
const { TerminalManager } = require('../src/terminalManager');
const { TerminalHostServer, TerminalHostClient } = require('../src/terminalHost');
const { registerTerminalIpc } = require('../src/ipc/registerTerminalIpc');

app.disableHardwareAcceleration();

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
const logFile = path.join(artifacts, 'inline-actual-pty-integration.log');
const screenshotFile = path.join(artifacts, 'loadtoagent-inline-actual-pty-failure.png');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-drawer-actual-pty-'));
const discoveryFile = path.join(temporary, 'terminal-host.json');
const storeFile = path.join(temporary, 'terminals.json');
const endpoint = process.platform === 'win32'
  ? `\\\\.\\pipe\\loadtoagent-drawer-actual-pty-${process.pid}-${Date.now()}`
  : path.join(temporary, 'terminal-host.sock');
const ipcChannels = [
  'terminals:list', 'wsl:list-distros', 'terminals:get', 'terminals:create',
  'terminals:write', 'terminals:command', 'terminals:respond', 'terminals:resize', 'terminals:signal',
  'terminals:restart', 'terminals:reconnect', 'terminals:detach', 'terminals:stop',
  'terminals:close', 'terminals:retire',
];

fs.mkdirSync(artifacts, { recursive: true });
fs.writeFileSync(logFile, '');
app.setPath('userData', path.join(temporary, 'electron-user-data'));

function log(message) {
  const line = `[${new Date().toISOString()}] ${String(message || '')}`;
  fs.appendFileSync(logFile, `${line}\n`);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitUntil(check, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await wait(50);
  }
  throw new Error(`${message}${lastError ? ` (${lastError.message})` : ''}`);
}

function encodedMarkerCommand(marker) {
  return `LTA_DRAWER_ECHO:${Buffer.from(marker, 'utf8').toString('base64url')}`;
}

function encodedAdditionalArgument(name, value) {
  return `--${name}=${Buffer.from(String(value || ''), 'utf8').toString('base64url')}`;
}

async function rendererValue(win, expression) {
  return win.webContents.executeJavaScript(expression);
}

async function waitForRenderer(win, expression, message, timeoutMs = 12_000) {
  return waitUntil(() => rendererValue(win, expression), message, timeoutMs);
}

async function run() {
  const manager = new TerminalManager({
    storeFile,
    agentProviders: {
      claude: {
        command: 'node',
        args: [path.join(__dirname, 'drawer-bound-pty-agent-fixture.js')],
        label: 'Signed drawer PTY integration',
      },
    },
  });
  const server = new TerminalHostServer({
    manager,
    discoveryFile,
    endpoint,
    idleShutdownMs: 60_000,
  });
  const client = new TerminalHostClient({ discoveryFile, connectTimeoutMs: 8_000 });
  const clientData = [];
  const ipcCalls = [];
  let win = null;
  let terminalId = '';
  let terminalRetired = false;

  const collectData = payload => {
    clientData.push(String(payload?.data || ''));
    if (win && !win.isDestroyed()) win.webContents.send('terminals:data', payload);
  };
  const forwardState = payload => {
    if (win && !win.isDestroyed()) win.webContents.send('terminals:state', payload);
  };
  const forwardDisconnect = () => {
    if (win && !win.isDestroyed()) win.webContents.send('terminals:connection', { state: 'reconnecting' });
  };
  const forwardReconnect = payload => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('terminals:state', { change: 'reconnected', session: null, sessions: payload?.sessions || client.list() });
    win.webContents.send('terminals:connection', { state: 'connected' });
  };
  const forwardReconnectError = error => {
    if (win && !win.isDestroyed()) win.webContents.send('terminals:connection', { state: 'failed', message: String(error?.message || error) });
  };

  client.on('data', collectData);
  client.on('state', forwardState);
  client.on('disconnect', forwardDisconnect);
  client.on('reconnect', forwardReconnect);
  client.on('reconnect-error', forwardReconnectError);

  const ipcManager = new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        ipcCalls.push({ operation: String(property), args });
        return Reflect.apply(value, target, args);
      };
    },
  });

  try {
    const hostInfo = await server.start();
    await client.connect();
    assert(client.connected, 'TerminalHostClient가 실제 소켓에 연결되지 않았습니다.');
    assert(hostInfo.endpoint === endpoint && server.clients.size === 1,
      'TerminalHostServer의 인증 소켓 연결을 확인하지 못했습니다.');

    const agentSessionId = 'fixture-root';
    const agentResumeSessionId = 'fixture-root-external';
    const agentConnectionSignature = `acs1:${crypto.createHash('sha256').update(JSON.stringify([
      agentSessionId,
      'claude',
      agentResumeSessionId,
      '',
      '',
    ]), 'utf8').digest('hex')}`;
    const resumeArgs = ['--resume', agentResumeSessionId];
    let session = await client.create({
      type: 'agent',
      provider: 'claude',
      cwd: root,
      args: resumeArgs,
      recoveryArgs: resumeArgs,
      bridgeId: agentSessionId,
      agentConnectionSignature,
      sessionBackend: 'direct',
      reuseBridge: true,
      cols: 120,
      rows: 32,
      title: '실제 drawer PTY 통합 검증',
    });
    terminalId = String(session?.id || '');
    assert(terminalId && session.status === 'running'
      && session.type === 'agent'
      && session.provider === 'claude'
      && session.bridgeId === agentSessionId
      && session.agentResumeSessionId === agentResumeSessionId
      && session.agentConnectionSignature === agentConnectionSignature
      && session.conversationBound === true
      && session.backend === 'direct',
    `서명된 앱 소유 agent PTY가 실행되지 않았습니다: ${JSON.stringify(session)}`);

    const hydrationMarker = `LTA_REPLAY_${Date.now()}`;
    const liveMarker = `LTA_LIVE_${Date.now()}`;
    const hydrationCommand = encodedMarkerCommand(hydrationMarker);
    const liveCommand = encodedMarkerCommand(liveMarker);

    await client.command(terminalId, hydrationCommand);
    await waitUntil(() => clientData.join('').includes(hydrationMarker),
      'TerminalManager 출력이 TerminalHost 소켓을 통해 돌아오지 않았습니다.');
    await waitUntil(async () => String((await client.get(terminalId, true))?.replay || '').includes(hydrationMarker),
      '실제 PTY replay에 사전 출력 marker가 기록되지 않았습니다.');
    session = await client.get(terminalId, true);
    assert(Number(session?.pid) > 0,
      `실제 node-pty 자식 프로세스 id를 확인하지 못했습니다: ${JSON.stringify(session)}`);

    win = new BrowserWindow({
      width: 1440,
      height: 960,
      show: false,
      backgroundColor: '#08111b',
      webPreferences: {
        preload: path.join(__dirname, 'interaction-fixture-preload.js'),
        additionalArguments: [
          `--loadtoagent-real-terminal-id=${terminalId}`,
          `--loadtoagent-real-terminal-pid=${session.pid}`,
          encodedAdditionalArgument('loadtoagent-real-terminal-cwd', root),
        ],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.on('console-message', (_event, details, legacyMessage) => {
      const message = typeof details === 'object' ? details.message : String(legacyMessage || details || '');
      log(`renderer ${message}`);
    });

    registerTerminalIpc({
      ipcMain,
      requireTrustedSender: event => {
        if (!win || win.isDestroyed() || event.sender !== win.webContents) {
          throw new Error('신뢰할 수 없는 실제 PTY 통합 검증 요청입니다.');
        }
      },
      trustedSender: event => Boolean(win && !win.isDestroyed() && event.sender === win.webContents),
      manager: () => ipcManager,
      isProviderVisible: () => true,
      listWslDistros: () => [],
      sendError: payload => {
        if (win && !win.isDestroyed()) win.webContents.send('terminals:error', payload);
      },
    });

    await win.loadFile(path.join(root, 'renderer', 'index.html'));
    await waitForRenderer(win,
      `Boolean(window.LoadToAgentApp?.initialized && window.LoadToAgentTerminal && window.LoadToAgentInlineTerminal && window.interactionTest)`,
      'renderer와 실제 PTY preload가 준비되지 않았습니다.');

    const openedInline = await rendererValue(win, `(() => {
      const workspace = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(node => node.dataset.workspace === ${JSON.stringify(root)});
      workspace?.click();
      const trigger = document.querySelector('.control-room-main[data-inline-pty-trigger="fixture-root"]');
      trigger?.click();
      return Boolean(workspace && trigger);
    })()`);
    assert(openedInline, '실제 PTY를 열 프로젝트 또는 메인 AI 영역을 찾지 못했습니다.');
    await waitForRenderer(win, `(() => {
      const inline = document.querySelector('[data-inline-agent-terminal="fixture-root"]');
      const embedded = window.LoadToAgentTerminal.embeddedState();
      const rootSession = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === 'fixture-root');
      const terminal = window.interactionTest.getTerminals().find(item =>
        item.id === ${JSON.stringify(terminalId)});
      return inline
        && !document.querySelector('#detailDrawer')?.classList.contains('open')
        && embedded.connected
        && embedded.agentSessionId === 'fixture-root'
        && embedded.terminalId === ${JSON.stringify(terminalId)}
        && window.LoadToAgentTerminal.agentTargets(rootSession).some(target =>
          target.terminalId === ${JSON.stringify(terminalId)})
        && terminal?.conversationBound === true
        && terminal?.backend === 'direct'
        && terminal?.agentResumeSessionId === rootSession.externalId
        && document.querySelector('#agentInlineTerminalViewport > .terminal-screen .xterm')
        && document.querySelector('#agentInlineTerminalViewport .xterm-helper-textarea')
        && !document.querySelector('[data-inline-terminal-composer]');
    })()`, '클릭한 메인 AI 바로 아래에 별도 메시지 입력란 없는 실제 PTY가 연결되지 않았습니다.');

    const terminalTextExpression = `(() => {
      const screen = document.querySelector('#agentInlineTerminalViewport > .terminal-screen');
      if (!screen) return '';
      return [
        ...[...screen.querySelectorAll('.xterm-rows > div')].map(row => row.textContent || ''),
        screen.querySelector('.xterm-accessibility-tree')?.textContent || '',
      ].join('\\n');
    })()`;
    await waitForRenderer(win, `${terminalTextExpression}.includes(${JSON.stringify(hydrationMarker)})`,
      'terminalGet replay가 인라인 xterm에 hydrate되지 않았습니다.');

    const focused = await rendererValue(win, `(() => {
      window.interactionTest.clearCalls();
      return window.LoadToAgentTerminal.focusEmbedded()
        && document.activeElement === document.querySelector('#agentInlineTerminalViewport .xterm-helper-textarea');
    })()`);
    assert(focused, '인라인 PTY의 실제 xterm 입력 커서에 포커스하지 못했습니다.');
    const pasted = await rendererValue(win, `(() => {
      const input = document.querySelector('#agentInlineTerminalViewport .xterm-helper-textarea');
      if (!input) return false;
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', ${JSON.stringify(liveCommand)});
      input.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }));
      return true;
    })()`);
    assert(pasted, 'xterm의 실제 붙여넣기 입력 경로가 명령을 처리하지 않았습니다.');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

    await waitUntil(() => clientData.join('').includes(liveMarker),
      '인라인 PTY 입력 명령이 TerminalHost 소켓을 거쳐 실제 PTY 출력으로 돌아오지 않았습니다.');
    await waitForRenderer(win, `${terminalTextExpression}.includes(${JSON.stringify(liveMarker)})`,
      '실제 PTY live marker가 인라인 xterm에 표시되지 않았습니다.');

    const rendererResult = await rendererValue(win, `(() => ({
      embedded: window.LoadToAgentTerminal.embeddedState(),
      inlineMounted: Boolean(document.querySelector('[data-inline-agent-terminal="fixture-root"]')),
      drawerOpen: document.querySelector('#detailDrawer')?.classList.contains('open') || false,
      xtermMounted: Boolean(document.querySelector('#agentInlineTerminalViewport > .terminal-screen .xterm')),
      composerAbsent: !document.querySelector('[data-inline-terminal-composer]'),
      calls: window.interactionTest.getCalls(),
      text: ${terminalTextExpression},
    }))()`);
    const rendererWrites = rendererResult.calls.filter(call => call.name === 'terminalWrite');
    const rendererWriteText = rendererWrites
      .filter(call => call.args[0] === terminalId)
      .map(call => String(call.args[1] || ''))
      .join('');
    assert(rendererResult.inlineMounted && !rendererResult.drawerOpen && rendererResult.xtermMounted && rendererResult.composerAbsent,
      `메인 AI 바로 아래 인라인 영역이 실제 PTY 전용 화면이 아닙니다: ${JSON.stringify(rendererResult)}`);
    assert(rendererWriteText.endsWith(`${liveCommand}\r`),
      `xterm 직접 입력이 terminalWrite IPC로 전달되지 않았습니다: ${JSON.stringify(rendererWrites)}`);
    assert(!rendererResult.calls.some(call => call.name === 'terminalCreate'),
      '기존 실제 PTY가 있는데 인라인 화면이 별도 터미널을 생성했습니다.');
    assert(!rendererResult.calls.some(call => call.name === 'terminalCommand'),
      'PTY 직접 입력 중 별도 메시지 command 경로가 호출되었습니다.');
    assert(ipcCalls.some(call => call.operation === 'list')
      && ipcCalls.some(call => call.operation === 'get' && call.args[0] === terminalId)
      && ipcCalls.filter(call => call.operation === 'write' && call.args[0] === terminalId)
        .map(call => String(call.args[1] || '')).join('').endsWith(`${liveCommand}\r`),
    `preload→IPC→TerminalHostClient 호출 경로가 완주하지 않았습니다: ${JSON.stringify(ipcCalls)}`);
    assert(String((await client.get(terminalId, true))?.replay || '').includes(liveMarker),
      'TerminalManager/node-pty replay에서 live marker를 확인하지 못했습니다.');

    const summary = {
      terminalId,
      pid: session.pid,
      hostEndpoint: hostInfo.endpoint,
      authenticatedHostClients: server.clients.size,
      hydrationMarker,
      liveMarker,
      rendererTerminalWriteCalls: rendererWrites.length,
      ipcOperations: ipcCalls.map(call => call.operation),
    };
    log(`passed ${JSON.stringify(summary)}`);
    process.stdout.write(`✓ AI 아래 인라인 PTY → preload → IPC → TerminalHost socket → TerminalManager → node-pty → xterm 통합 검증\n${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    log(`failed ${error.stack || error}`);
    if (win && !win.isDestroyed()) {
      try {
        fs.writeFileSync(screenshotFile, (await win.webContents.capturePage()).toPNG());
        log(`failure screenshot ${screenshotFile}`);
      } catch (captureError) {
        log(`failure screenshot error ${captureError.stack || captureError}`);
      }
    }
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    client.removeListener('data', collectData);
    client.removeListener('state', forwardState);
    client.removeListener('disconnect', forwardDisconnect);
    client.removeListener('reconnect', forwardReconnect);
    client.removeListener('reconnect-error', forwardReconnectError);
    if (terminalId && manager.get(terminalId, false)) {
      try {
        await client.retire(terminalId);
        await waitUntil(() => !manager.get(terminalId, false),
          '실제 PTY retire 완료가 확인되지 않았습니다.', 5_000);
        terminalRetired = true;
      } catch (error) {
        log(`client retire failed ${error.stack || error}`);
        try {
          await manager.retire(terminalId);
          terminalRetired = !manager.get(terminalId, false);
        } catch (fallbackError) {
          log(`manager retire fallback failed ${fallbackError.stack || fallbackError}`);
        }
      }
    } else {
      terminalRetired = true;
    }
    log(`cleanup terminalRetired=${terminalRetired}`);
    client.dispose();
    server.dispose();
    await manager.dispose();
    for (const channel of ipcChannels) ipcMain.removeHandler(channel);
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (error) { log(`temporary cleanup failed ${error.message}`); }
    if (!terminalRetired) process.exitCode = 1;
    app.exit(process.exitCode || 0);
  }
}

app.whenReady().then(run).catch(error => {
  log(`startup failed ${error.stack || error}`);
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
  app.quit();
});
