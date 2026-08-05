'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

const outputDir = path.join(__dirname, '..', 'artifacts');
const logPath = path.join(outputDir, 'drawer-terminal-visual.log');
fs.mkdirSync(outputDir, { recursive: true });
const log = (message) => {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
};
fs.writeFileSync(logPath, '');
log(`starting with Electron ${process.versions.electron || 'unknown'}`);
process.on('uncaughtException', error => log(`uncaughtException\n${error.stack || error}`));
process.on('unhandledRejection', error => log(`unhandledRejection\n${error?.stack || error}`));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-drawer-terminal-'));
app.setPath('userData', userData);
app.once('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(win, expression, message, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await wait(60);
  }
  throw new Error(message);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

app.whenReady().then(async () => {
  log('app ready');
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: true,
    backgroundColor: '#08111b',
    webPreferences: {
      preload: path.join(__dirname, 'interaction-fixture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_event, details) => {
    const level = typeof details === 'object' ? details.level : 'log';
    const message = typeof details === 'object' ? details.message : String(details || '');
    log(`renderer:${level} ${message}`);
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    log('renderer loaded');
    await waitFor(win, `Boolean(window.LoadToAgentApp?.initialized && window.LoadToAgentTerminal && window.LoadToAgentDrawerTerminal)`, '앱과 드로어 PTY 모듈이 준비되지 않았습니다.');
    await win.webContents.executeJavaScript(`window.interactionTest.setTerminalReplay('terminal-main', [
      '\\u001b[36mLoadToAgent / same PTY session\\u001b[0m',
      'PS D:\\\\fixture> npm test',
      '153 tests passed · waiting for the next instruction',
      '',
    ].join('\\r\\n'))`);
    const workspace = await win.webContents.executeJavaScript(`(() => {
      const item = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(node => node.dataset.workspace === 'D:\\\\fixture');
      item?.click();
      return item?.dataset.workspace || '';
    })()`);
    assert(workspace === 'D:\\fixture', `검증할 프로젝트를 찾지 못했습니다: ${workspace}`);
    await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\fixture' && !document.querySelector('#operationsOverview')?.classList.contains('hidden')`, '프로젝트 화면이 준비되지 않았습니다.');

    const shellBefore = await win.webContents.executeJavaScript(`(() => {
      const rect = selector => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      };
      return {
        sidebar: rect('.sidebar'),
        topbar: rect('.topbar'),
        projectNavLabels: [...document.querySelectorAll('#projectContextNav [data-view]')].map(node => node.textContent.trim()),
        selectedWorkspace: window.LoadToAgentApp.state.workspace,
      };
    })()`);

    await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-root', { context: true })`);
    await waitFor(win, `(() => {
      const drawer = document.querySelector('#detailDrawer');
      const embedded = window.LoadToAgentTerminal.embeddedState();
      return drawer?.classList.contains('open')
        && ['context', 'modal'].includes(drawer.dataset.presentation)
        && drawer.dataset.conversationShell === 'terminal'
        && drawer.dataset.conversationSurface === 'pty'
        && drawer.dataset.terminalChat === 'true'
        && document.querySelector('[data-tab="chat"]')?.getAttribute('aria-selected') === 'true'
        && document.querySelector('[data-tab="chat"]')?.getAttribute('aria-controls') === 'drawerTerminalSurface'
        && !document.querySelector('[data-tab="terminal"]')
        && !document.querySelector('#drawerTerminalSurface')?.classList.contains('hidden')
        && document.querySelector('#drawerContent')?.classList.contains('hidden')
        && embedded.agentSessionId === 'fixture-root'
        && embedded.terminalId === 'terminal-main'
        && embedded.connected
        && document.querySelector('#drawerTerminalViewport > .terminal-screen .xterm');
    })()`, '실행 중 세션의 대화 탭에 같은 PTY가 바로 연결되지 않았습니다.');
    await wait(500);

    const opened = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('#detailDrawer');
      const host = document.querySelector('#drawerTerminalViewport > .terminal-screen');
      if (host) host.dataset.drawerVisualIdentity = 'same-xterm-host';
      const visible = node => Boolean(node && !node.classList.contains('hidden') && node.getClientRects().length);
      return {
        drawerWidth: drawer.getBoundingClientRect().width,
        title: document.querySelector('#drawerTitle')?.textContent.trim() || '',
        tabs: [...document.querySelectorAll('.drawer-tab:not(.hidden)')].map(node => node.textContent.trim()),
        terminalTabAbsent: !document.querySelector('[data-tab="terminal"]'),
        conversationShell: drawer.dataset.conversationShell || '',
        conversationSurface: drawer.dataset.conversationSurface || '',
        chatControls: document.querySelector('[data-tab="chat"]')?.getAttribute('aria-controls') || '',
        metaCount: document.querySelector('#drawerMeta')?.children.length || 0,
        terminalVisible: visible(document.querySelector('#drawerTerminalSurface')),
        transcriptHidden: document.querySelector('#drawerContent')?.classList.contains('hidden'),
        structuredRows: drawer.querySelectorAll('.chat-row').length,
        composerVisible: visible(document.querySelector('#drawerComposer')),
        composerTerminalMode: document.querySelector('#drawerComposer [data-agent-command-input-mode-selected]')?.dataset.agentCommandInputModeSelected || '',
        composerTerminalStyle: document.querySelector('#drawerComposer [data-agent-command-form]')?.classList.contains('terminal-conversation'),
        status: document.querySelector('#drawerTerminalStatus')?.textContent.trim() || '',
        hostParent: host?.parentElement?.id || '',
        projectNavLabels: [...document.querySelectorAll('#projectContextNav [data-view]')].map(node => node.textContent.trim()),
      };
    })()`);
    assert(opened.drawerWidth >= 600 && opened.drawerWidth <= 680, `기존 드로어 폭이 바뀌었습니다: ${opened.drawerWidth}`);
    assert(opened.title === '화면 설명과 버튼을 쉽게 개선하기', `드로어 헤더 제목이 달라졌습니다: ${opened.title}`);
    assert(JSON.stringify(opened.tabs) === JSON.stringify(['요약', '대화', '진행 과정', '사용량'])
      && opened.terminalTabAbsent && opened.conversationShell === 'terminal'
      && opened.conversationSurface === 'pty' && opened.chatControls === 'drawerTerminalSurface',
    `대화 탭의 PTY 구성이 올바르지 않습니다: ${JSON.stringify(opened)}`);
    assert(opened.metaCount > 0 && opened.terminalVisible && opened.transcriptHidden && opened.structuredRows === 0,
      `대화 본문만 PTY로 바뀌지 않았습니다: ${JSON.stringify(opened)}`);
    assert(opened.composerVisible && opened.composerTerminalMode === 'terminal' && opened.composerTerminalStyle
      && opened.status === 'PTY 연결됨'
      && opened.hostParent === 'drawerTerminalViewport', `PTY 입력·상태 연결이 올바르지 않습니다: ${JSON.stringify(opened)}`);
    assert(JSON.stringify(opened.projectNavLabels) === JSON.stringify(shellBefore.projectNavLabels), '프로젝트 내비게이션이 드로어 PTY 때문에 바뀌었습니다.');

    const output = path.join(outputDir, 'loadtoagent-drawer-terminal.png');
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    win.webContents.invalidate();
    await wait(300);
    fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());

    await win.webContents.executeJavaScript(`window.interactionTest.clearCalls(); window.LoadToAgentTerminal.focusEmbedded()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'z' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z' });
    await wait(120);
    const rawXtermInput = await win.webContents.executeJavaScript(`(() => ({
      terminalWriteCalls: window.interactionTest.getCalls().filter(call =>
        call.name === 'terminalWrite' && call.args[0] === 'terminal-main'),
      terminalCommandCalls: window.interactionTest.getCalls().filter(call =>
        call.name === 'terminalCommand' && call.args[0] === 'terminal-main'),
    }))()`);
    assert(rawXtermInput.terminalWriteCalls.length === 0 && rawXtermInput.terminalCommandCalls.length === 0,
      `서명된 대화 PTY의 xterm이 raw 키 입력을 전달했습니다: ${JSON.stringify(rawXtermInput)}`);
    log('signed raw xterm gate passed');

    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.clearCalls();
      const form = document.querySelector('#drawerComposer [data-agent-command-form="fixture-root"]');
      const input = form?.querySelector('[data-agent-command-draft]');
      input.value = '터미널에서 계속 진행해줘';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
    })()`);
    await waitFor(win, `window.interactionTest.getCalls().some(call => call.name === 'terminalCommand'
      && call.args[0] === 'terminal-main' && call.args[1] === '터미널에서 계속 진행해줘')
      && document.querySelector('#detailDrawer').classList.contains('open')
      && document.querySelector('#drawerTerminalStatus').textContent.trim() === '메시지 전달됨'`, '하단 PTY 입력이 같은 세션으로 전달되거나 드로어가 유지되지 않았습니다.');
    log('signed composer command passed');

    await win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('loadtoagent:terminal-command-delivery', {
      detail: { sessionId: 'fixture-root', deliveryState: 'rejected', target: { id: 'terminal-main', label: '내 컴퓨터에서 실행하는 작업' } },
    }))`);
    await waitFor(win, `document.querySelector('#drawerTerminalStatus').textContent.trim() === '메시지를 전달하지 못함'
      && document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar').dataset.tone === 'error'`,
    'PTY 전송 실패가 계속 전송 중인 상태로 남았습니다.');

    await win.webContents.executeJavaScript(`window.interactionTest.emitTerminalData('terminal-main', '\\r\\nLIVE_DRAWER_PTY_OUTPUT\\r\\n')`);
    await waitFor(win, `document.querySelector('#drawerTerminalStatus').textContent.trim() === '실행 중'`, '실시간 PTY 출력 상태가 드로어에 반영되지 않았습니다.');

    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.setTerminalReplay('terminal-main', [
        'Edited renderer/drawer-terminal.js (+1 -0)',
        '',
        'Would you like to make the following edits?',
        '',
        '› 1. Yes, proceed (y)',
        '  2. Yes, and don\\'t ask again for these files',
        '     (a)',
        '  3. No, and tell Codex what to do differently',
        '     (esc)',
      ].join('\\r\\n'));
      window.LoadToAgentTerminal.updateSnapshot(window.LoadToAgentApp.state.snapshot, window.LoadToAgentApp.state.workspaces);
      window.LoadToAgentTerminal.refreshPendingPrompts();
    })()`);
    await waitFor(win, `Boolean(window.LoadToAgentTerminal.pendingPromptForSession('fixture-root'))
      && document.querySelector('#drawerTerminalStatus').textContent.trim() === '내 답변을 기다리는 중'
      && document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar').dataset.tone === 'attention'`,
    'PTY가 답변을 기다리는 상태를 드로어에 표시하지 않았습니다.');
    log('pending prompt detected; starting stale identity gate');
    const stalePromptGate = await win.webContents.executeJavaScript(`(async () => {
      const original = window.interactionTest.getSnapshot().sessions.find(item => item.id === 'fixture-root');
      window.interactionTest.clearCalls();
      window.interactionTest.updateSession('fixture-root', {
        externalId: 'fixture-root-external-replaced',
      });
      window.LoadToAgentTerminal.updateSnapshot(
        window.interactionTest.getSnapshot(),
        window.LoadToAgentApp.state.workspaces,
      );
      let rejected = false;
      let errorCode = '';
      try {
        await window.LoadToAgentTerminal.respondToPrompt('fixture-root', 'proceed');
      } catch (error) {
        rejected = true;
        errorCode = String(error?.code || error?.message || error || '');
      }
      const result = {
        rejected,
        errorCode,
        pendingAfter: Boolean(window.LoadToAgentTerminal.pendingPromptForSession('fixture-root')),
        respondCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalRespond'),
      };
      window.interactionTest.updateSession('fixture-root', {
        externalId: original.externalId,
        updatedAt: original.updatedAt,
      });
      window.LoadToAgentTerminal.updateSnapshot(
        window.interactionTest.getSnapshot(),
        window.LoadToAgentApp.state.workspaces,
      );
      window.interactionTest.emitSnapshot();
      return result;
    })()`);
    assert(stalePromptGate.rejected && stalePromptGate.errorCode === 'DELIVERY_REJECTED'
      && !stalePromptGate.pendingAfter
      && stalePromptGate.respondCalls.length === 0,
    `이전 대화 신원의 승인 요청이 현재 PTY로 전달됐습니다: ${JSON.stringify(stalePromptGate)}`);
    log('stale prompt identity gate passed');
    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.setTerminalReplay('terminal-main', 'LIVE_DRAWER_PTY_OUTPUT\\r\\n');
      window.LoadToAgentTerminal.refreshPendingPrompts();
    })()`);
    await waitFor(win, `!window.LoadToAgentTerminal.pendingPromptForSession('fixture-root')
      && document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar').dataset.tone === 'running'`,
    '답변 대기 상태가 끝난 뒤 PTY 실행 상태로 돌아오지 않았습니다.');

    const hydrationRaceMarker = `DRAWER_HYDRATION_RACE_${Date.now()}`;
    await win.webContents.executeJavaScript(`(() => {
      const base = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === 'fixture-root');
      const hydrationSession = {
        ...base,
        id: 'fixture-hydration-race',
        externalId: 'fixture-hydration-race-external',
        title: 'PTY replay와 live 출력 경합 검증',
        shortTitle: 'PTY replay와 live 출력 경합 검증',
        displayName: 'PTY replay와 live 출력 경합 검증',
        runtimePresence: [{
          kind: 'terminal', terminalId: 'terminal-race-a', pid: 41003,
          label: 'replay와 live 출력 경합 검증 명령창',
        }],
        childIds: [],
        parentId: null,
      };
      window.interactionTest.addSession(hydrationSession);
      window.interactionTest.updateTerminal('terminal-race-a', {
        type: 'agent',
        provider: hydrationSession.provider,
        bridgeId: hydrationSession.id,
        agentResumeSessionId: hydrationSession.externalId,
        agentConnectionSignature: window.interactionTest.connectionSignatureForSession(hydrationSession),
        conversationBound: true,
        background: true,
        backend: 'direct',
        distro: '',
        replay: 'HYDRATION_RACE_BEFORE\\r\\n',
        outputSequence: 0,
      });
      window.interactionTest.setTerminalGetDelays({ 'terminal-race-a': 260 });
      window.interactionTest.clearCalls();
      window.LoadToAgentApp.openDrawer('fixture-hydration-race', { context: true });
      return true;
    })()`);
    await waitFor(win, `window.interactionTest.getCalls().some(call =>
      call.name === 'terminalGet' && call.args[0] === 'terminal-race-a')`,
    'PTY hydrate 경합 검증의 delayed terminalGet이 시작되지 않았습니다.');
    await win.webContents.executeJavaScript(`window.interactionTest.emitTerminalData(
      'terminal-race-a', '\\r\\n${hydrationRaceMarker}\\r\\n')`);
    await waitFor(win, `(() => {
      const embedded = window.LoadToAgentTerminal.embeddedState();
      const host = document.querySelector('[data-terminal-screen="terminal-race-a"]');
      const rows = [...(host?.querySelectorAll('.xterm-rows > div') || [])]
        .map(row => row.textContent || '').join('\\n');
      const accessible = host?.querySelector('.xterm-accessibility-tree')?.textContent || '';
      const text = rows || accessible;
      return embedded.connected
        && embedded.agentSessionId === 'fixture-hydration-race'
        && embedded.terminalId === 'terminal-race-a'
        && text.includes(${JSON.stringify(hydrationRaceMarker)});
    })()`, 'delayed replay와 같은 tick의 live PTY 출력이 xterm에서 유실되었습니다.');
    const hydrationRace = await win.webContents.executeJavaScript(`(() => {
      const host = document.querySelector('[data-terminal-screen="terminal-race-a"]');
      const rows = [...(host?.querySelectorAll('.xterm-rows > div') || [])]
        .map(row => row.textContent || '').join('\\n');
      const accessible = host?.querySelector('.xterm-accessibility-tree')?.textContent || '';
      const text = rows || accessible;
      const marker = ${JSON.stringify(hydrationRaceMarker)};
      const terminal = window.interactionTest.getTerminals().find(item => item.id === 'terminal-race-a');
      return {
        markerCount: text.split(marker).length - 1,
        outputSequence: terminal?.outputSequence,
        replayMarkerCount: String(terminal?.replay || '').split(marker).length - 1,
        getCalls: window.interactionTest.getCalls().filter(call =>
          call.name === 'terminalGet' && call.args[0] === 'terminal-race-a').length,
      };
    })()`);
    assert(hydrationRace.markerCount === 1 && hydrationRace.replayMarkerCount === 1
      && hydrationRace.outputSequence === 1 && hydrationRace.getCalls === 1,
    `PTY hydration outputSequence가 live 출력을 정확히 한 번 보존하지 못했습니다: ${JSON.stringify(hydrationRace)}`);
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentApp.closeDrawer();
      window.interactionTest.clearControls();
      window.LoadToAgentApp.openDrawer('fixture-root', { context: true });
    })()`);
    await waitFor(win, `window.LoadToAgentTerminal.embeddedState().connected
      && window.LoadToAgentTerminal.embeddedState().agentSessionId === 'fixture-root'
      && window.LoadToAgentTerminal.embeddedState().terminalId === 'terminal-main'`,
    'PTY hydration 경합 검증 후 원래 대화 명령창으로 돌아오지 못했습니다.');

    const statusRetention = [];
    for (const status of ['waiting', 'paused']) {
      await win.webContents.executeJavaScript(`(() => {
        window.interactionTest.clearCalls();
        window.interactionTest.updateSession('fixture-root', {
          status: ${JSON.stringify(status)},
          statusDetail: ${JSON.stringify(status === 'waiting' ? '내 답변을 기다리는 중' : '작업이 잠시 멈춤')},
          runtimePresence: [{
            kind: 'terminal', terminalId: 'terminal-main', pid: 41001,
            label: '내 컴퓨터에서 실행하는 작업',
          }],
        });
        window.interactionTest.emitSnapshot();
      })()`);
      await waitFor(win, `(() => {
        const embedded = window.LoadToAgentTerminal.embeddedState();
        const drawer = document.querySelector('#detailDrawer');
        return window.LoadToAgentApp.selectedSession()?.status === ${JSON.stringify(status)}
          && window.LoadToAgentApp.state.drawerTab === 'chat'
          && drawer?.dataset.conversationSurface === 'pty'
          && drawer?.dataset.terminalChat === 'true'
          && embedded.agentSessionId === 'fixture-root'
          && embedded.terminalId === 'terminal-main'
          && embedded.connected
          && document.querySelector('#drawerTerminalViewport > .terminal-screen[data-drawer-visual-identity="same-xterm-host"]')
          && document.querySelector('#drawerComposer')?.dataset.mode === 'terminal';
      })()`, `${status} 상태에서도 같은 PTY가 대화 탭에 유지되지 않았습니다.`);
      const retained = await win.webContents.executeJavaScript(`(() => ({
        status: ${JSON.stringify(status)},
        surface: document.querySelector('#detailDrawer')?.dataset.conversationSurface || '',
        connected: window.LoadToAgentTerminal.embeddedState().connected,
        sameHost: Boolean(document.querySelector('#drawerTerminalViewport > .terminal-screen[data-drawer-visual-identity="same-xterm-host"]')),
        destructiveCalls: window.interactionTest.getCalls().filter(call => ['terminalGet','terminalReconnect','terminalRetire','terminalClose','terminalStop','terminalDetach'].includes(call.name)),
      }))()`);
      assert(retained.surface === 'pty' && retained.connected && retained.sameHost && retained.destructiveCalls.length === 0,
        `상태 전환 중 PTY를 재생성하거나 변경했습니다: ${JSON.stringify(retained)}`);
      statusRetention.push(retained);
    }
    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.updateSession('fixture-root', { status: 'running', statusDetail: '턴 실행 중' });
      window.interactionTest.emitSnapshot();
    })()`);
    await waitFor(win, `window.LoadToAgentApp.selectedSession()?.status === 'running'
      && window.LoadToAgentTerminal.embeddedState().connected
      && Boolean(document.querySelector('#drawerTerminalViewport > .terminal-screen[data-drawer-visual-identity="same-xterm-host"]'))`,
    '상태 복원 뒤 같은 PTY가 유지되지 않았습니다.');

    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="summary"]')?.click()`);
    await waitFor(win, `window.LoadToAgentApp.state.drawerTab === 'summary'
      && document.querySelector('#drawerTerminalSurface').classList.contains('hidden')
      && window.LoadToAgentTerminal.embeddedState().connected === false
      && document.querySelector('#terminalViewport > .terminal-screen[data-drawer-visual-identity="same-xterm-host"]')`, '요약 탭 전환 시 기존 xterm 호스트가 원래 위치로 돌아가지 않았습니다.');
    const unchangedAfterTab = await win.webContents.executeJavaScript(`(() => ({
      title: document.querySelector('#drawerTitle')?.textContent.trim() || '',
      tabs: [...document.querySelectorAll('.drawer-tab:not(.hidden)')].map(node => node.textContent.trim()),
      width: document.querySelector('#detailDrawer')?.getBoundingClientRect().width || 0,
      chatControls: document.querySelector('[data-tab="chat"]')?.getAttribute('aria-controls') || '',
      terminalTabAbsent: !document.querySelector('[data-tab="terminal"]'),
    }))()`);
    assert(unchangedAfterTab.title === opened.title && JSON.stringify(unchangedAfterTab.tabs) === JSON.stringify(opened.tabs)
      && Math.abs(unchangedAfterTab.width - opened.drawerWidth) < 1
      && unchangedAfterTab.chatControls === 'drawerContent'
      && unchangedAfterTab.terminalTabAbsent,
    `탭 전환 뒤 드로어 셸 또는 대화 탭 연결이 달라졌습니다: ${JSON.stringify(unchangedAfterTab)}`);

    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="chat"]')?.click()`);
    await waitFor(win, `window.LoadToAgentTerminal.embeddedState().connected
      && document.querySelector('#drawerTerminalViewport > .terminal-screen[data-drawer-visual-identity="same-xterm-host"]')`, '대화 탭 복귀 시 같은 xterm 호스트가 다시 연결되지 않았습니다.');

    await win.webContents.executeJavaScript(`window.interactionTest.clearCalls(); document.querySelector('#closeDrawerBtn')?.click()`);
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')
      && !window.LoadToAgentTerminal.embeddedState().connected
      && document.querySelector('#terminalViewport > .terminal-screen[data-drawer-visual-identity="same-xterm-host"]')`, '드로어를 닫은 뒤 xterm 호스트가 원래 위치로 복귀하지 않았습니다.');
    const destructiveCalls = await win.webContents.executeJavaScript(`window.interactionTest.getCalls().filter(call => ['terminalRetire','terminalClose','terminalStop','terminalDetach'].includes(call.name))`);
    assert(destructiveCalls.length === 0, `드로어를 닫으면서 PTY 프로세스를 변경했습니다: ${JSON.stringify(destructiveCalls)}`);

    await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-root', { context: true })`);
    await waitFor(win, `document.querySelector('#detailDrawer')?.dataset.conversationSurface === 'pty'
      && window.LoadToAgentTerminal.embeddedState().terminalId === 'terminal-main'`, 'PTY 전환 검사를 위해 루트 세션을 다시 연결하지 못했습니다.');
    const disconnectComposerEdge = await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.clearCalls();
      window.interactionTest.configure({ delays: { terminalCreate: 180 } });
      const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      const form = input?.closest('[data-agent-command-form]');
      input.value = '전환 중에도 초안 유지';
      input.dataset.terminalTransitionIdentity = 'same-focused-draft';
      form.dataset.terminalTransitionIdentity = 'same-focused-form';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(5, 5);
      const before = {
        terminalReady: form?.dataset.agentTerminalReady || '',
        sendAvailable: form?.dataset.agentSendAvailable || '',
        sendDisabled: document.querySelector('#drawerComposer .conversation-send')?.disabled,
      };
      window.interactionTest.setSessionRuntimePresence('fixture-root', [{
        kind: 'bridge', terminalId: 'terminal-main', pid: 41001,
        runtime: 'claude', label: '늦게 남은 이전 PTY presence',
      }]);
      window.interactionTest.emitSnapshot();
      window.interactionTest.removeTerminal('terminal-main');
      window.interactionTest.emitTerminalState('removed');
      const immediateInput = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      const immediateForm = immediateInput?.closest('[data-agent-command-form]');
      return {
        before,
        immediate: {
          embeddedConnected: window.LoadToAgentTerminal.embeddedState().connected,
          terminalReady: immediateForm?.dataset.agentTerminalReady || '',
          sendAvailable: immediateForm?.dataset.agentSendAvailable || '',
          sendDisabled: immediateForm?.querySelector('.conversation-send')?.disabled,
          sameInput: immediateInput?.dataset.terminalTransitionIdentity === 'same-focused-draft',
          sameForm: immediateForm?.dataset.terminalTransitionIdentity === 'same-focused-form',
          focused: document.activeElement === immediateInput,
          selectionStart: immediateInput?.selectionStart,
          selectionEnd: immediateInput?.selectionEnd,
        },
      };
    })()`);
    const disconnectComposerBefore = disconnectComposerEdge.before;
    const disconnectedComposerImmediate = disconnectComposerEdge.immediate;
    assert(disconnectComposerBefore.terminalReady === 'true'
      && disconnectComposerBefore.sendAvailable === 'true'
      && disconnectComposerBefore.sendDisabled === false,
    `PTY 종료 전 입력기가 실제 연결 상태가 아닙니다: ${JSON.stringify(disconnectComposerBefore)}`);
    assert(!disconnectedComposerImmediate.embeddedConnected
      && disconnectedComposerImmediate.terminalReady === 'false'
      && disconnectedComposerImmediate.sendAvailable === 'false'
      && disconnectedComposerImmediate.sendDisabled
      && disconnectedComposerImmediate.sameInput && disconnectedComposerImmediate.sameForm
      && disconnectedComposerImmediate.focused
      && disconnectedComposerImmediate.selectionStart === 5 && disconnectedComposerImmediate.selectionEnd === 5,
    `PTY disconnect 이벤트와 같은 tick에서 입력기를 안전하게 비활성화하지 못했습니다: ${JSON.stringify(disconnectedComposerImmediate)}`);
    await waitFor(win, `(() => {
      const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      const form = input?.closest('[data-agent-command-form]');
      const send = form?.querySelector('.conversation-send');
      return !window.LoadToAgentTerminal.embeddedState().connected
        && input?.dataset.terminalTransitionIdentity === 'same-focused-draft'
        && form?.dataset.terminalTransitionIdentity === 'same-focused-form'
        && form.dataset.agentTerminalReady === 'false'
        && form.dataset.agentSendAvailable === 'false'
        && send?.disabled
        && input.value === '전환 중에도 초안 유지'
        && input.selectionStart === 5 && input.selectionEnd === 5
        && document.activeElement === input;
    })()`, 'PTY 종료 즉시 포커스된 입력기를 같은 노드에서 비활성 상태로 바꾸지 못했습니다.');
    const disconnectedComposer = await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      const form = input?.closest('[data-agent-command-form]');
      return {
        terminalReady: form?.dataset.agentTerminalReady || '',
        sendAvailable: form?.dataset.agentSendAvailable || '',
        sendDisabled: form?.querySelector('.conversation-send')?.disabled,
        sameInput: input?.dataset.terminalTransitionIdentity === 'same-focused-draft',
        sameForm: form?.dataset.terminalTransitionIdentity === 'same-focused-form',
        focused: document.activeElement === input,
        selectionStart: input?.selectionStart,
        selectionEnd: input?.selectionEnd,
      };
    })()`);
    assert(disconnectedComposer.terminalReady === 'false'
      && disconnectedComposer.sendAvailable === 'false'
      && disconnectedComposer.sendDisabled
      && disconnectedComposer.sameInput && disconnectedComposer.sameForm
      && disconnectedComposer.focused
      && disconnectedComposer.selectionStart === 5 && disconnectedComposer.selectionEnd === 5,
    `PTY 종료 중 입력기 연결 상태를 안전하게 갱신하지 못했습니다: ${JSON.stringify(disconnectedComposer)}`);
    await waitFor(win, `document.querySelector('#detailDrawer')?.dataset.conversationSurface === 'error'
      && Boolean(document.querySelector('#drawerTerminalReconnectBtn')?.getClientRects().length)
      && window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
        && call.args[0]?.bridgeId === 'fixture-root').length === 0`,
    'PTY 종료 뒤 자동 생성 대신 명시적 재연결 상태로 전환되지 않았습니다.');
    const removedTerminalTransition = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('#detailDrawer');
      const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      return {
        surface: drawer?.dataset.conversationSurface || '',
        terminalVisible: Boolean(document.querySelector('#drawerTerminalSurface')?.getClientRects().length),
        transcriptHidden: document.querySelector('#drawerContent')?.classList.contains('hidden'),
        draftPreserved: input?.value || '',
        focused: document.activeElement === input,
        sameInput: input?.dataset.terminalTransitionIdentity === 'same-focused-draft',
        selectionStart: input?.selectionStart,
        selectionEnd: input?.selectionEnd,
        terminalCreateCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
          && call.args[0]?.bridgeId === 'fixture-root').length,
        retryVisible: Boolean(document.querySelector('#drawerTerminalReconnectBtn')?.getClientRects().length),
        stalePresenceRetained: window.LoadToAgentApp.selectedSession()?.runtimePresence?.some(item =>
          item.terminalId === 'terminal-main') || false,
      };
    })()`);
    assert(removedTerminalTransition.surface === 'error'
      && removedTerminalTransition.terminalVisible && removedTerminalTransition.transcriptHidden
      && removedTerminalTransition.draftPreserved === '전환 중에도 초안 유지'
      && removedTerminalTransition.focused && removedTerminalTransition.sameInput
      && removedTerminalTransition.selectionStart === 5 && removedTerminalTransition.selectionEnd === 5
      && removedTerminalTransition.terminalCreateCalls === 0
      && removedTerminalTransition.retryVisible
      && removedTerminalTransition.stalePresenceRetained,
    `PTY 종료 뒤 명시적 재연결 상태에서 입력이 손상됐습니다: ${JSON.stringify(removedTerminalTransition)}`);

    await win.webContents.executeJavaScript(`document.querySelector('#drawerTerminalReconnectBtn')?.click()`);

    await waitFor(win, `(() => {
      const drawer = document.querySelector('#detailDrawer');
      const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      const form = input?.closest('[data-agent-command-form]');
      const embedded = window.LoadToAgentTerminal.embeddedState();
      return drawer?.dataset.conversationSurface === 'pty'
        && drawer.dataset.terminalChat === 'true'
        && embedded.connected && embedded.terminalId.startsWith('terminal-created-')
        && document.querySelector('#drawerComposer')?.dataset.mode === 'terminal'
        && form?.dataset.agentCommandInputModeSelected === 'terminal'
        && input?.dataset.terminalTransitionIdentity === 'same-focused-draft'
        && input.value === '전환 중에도 초안 유지'
        && input.selectionStart === 5 && input.selectionEnd === 5
        && document.activeElement === input
        && input.placeholder.includes('터미널');
    })()`, 'PTY 종료 뒤 새 PTY를 만들고 같은 대화창에 연결하지 못했습니다.');
    const restoredTerminalTransition = await win.webContents.executeJavaScript(`(() => ({
      surface: document.querySelector('#detailDrawer')?.dataset.conversationSurface || '',
      outerMode: document.querySelector('#drawerComposer')?.dataset.mode || '',
      innerMode: document.querySelector('#drawerComposer [data-agent-command-form]')?.dataset.agentCommandInputModeSelected || '',
      draftPreserved: document.querySelector('#drawerComposer [data-agent-command-draft]')?.value || '',
      focused: document.activeElement === document.querySelector('#drawerComposer [data-agent-command-draft]'),
      terminalId: window.LoadToAgentTerminal.embeddedState().terminalId || '',
      terminalCreateCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
        && call.args[0]?.bridgeId === 'fixture-root').length,
      terminalGetCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalGet'
        && call.args[0] === window.LoadToAgentTerminal.embeddedState().terminalId).length,
      commandCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCommand').length,
    }))()`);
    assert(restoredTerminalTransition.surface === 'pty'
      && restoredTerminalTransition.outerMode === 'terminal'
      && restoredTerminalTransition.innerMode === 'terminal'
      && restoredTerminalTransition.draftPreserved === '전환 중에도 초안 유지'
      && restoredTerminalTransition.focused && restoredTerminalTransition.terminalId.startsWith('terminal-created-')
      && restoredTerminalTransition.terminalCreateCalls === 1 && restoredTerminalTransition.terminalGetCalls >= 1
      && restoredTerminalTransition.commandCalls === 0,
    `PTY 명시적 재연결 전환이 올바르지 않습니다: ${JSON.stringify(restoredTerminalTransition)}`);

    const retainedTerminalReplacements = [];
    let retainedTerminalId = restoredTerminalTransition.terminalId;
    for (const terminalStatus of ['stopped', 'exited']) {
      const previousTerminalId = retainedTerminalId;
      await win.webContents.executeJavaScript(`(() => {
        window.interactionTest.clearCalls();
        window.interactionTest.configure({ delays: { terminalCreate: 140 } });
        const previous = document.querySelector('[data-terminal-screen="${previousTerminalId}"]');
        if (previous) previous.dataset.retainedDeadIdentity = ${JSON.stringify(terminalStatus)};
        window.interactionTest.setSessionRuntimePresence('fixture-root', [{
          kind: 'terminal', terminalId: ${JSON.stringify(previousTerminalId)}, pid: 47001,
          label: '종료 상태가 늦게 반영된 실제 PTY',
        }]);
        window.interactionTest.emitSnapshot();
        window.interactionTest.updateTerminal(${JSON.stringify(previousTerminalId)}, {
          status: ${JSON.stringify(terminalStatus)},
          statusDetail: ${JSON.stringify(`fixture inventory retained as ${terminalStatus}`)},
        });
        window.interactionTest.emitTerminalState('updated');
      })()`);
      await waitFor(win, `document.querySelector('#detailDrawer')?.dataset.conversationSurface === 'error'
        && Boolean(document.querySelector('#drawerTerminalReconnectBtn')?.getClientRects().length)
        && window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
          && call.args[0]?.bridgeId === 'fixture-root').length === 0`,
      `${terminalStatus} PTY가 자동 생성 없이 명시적 재연결 상태로 전환되지 않았습니다.`);
      await win.webContents.executeJavaScript(`document.querySelector('#drawerTerminalReconnectBtn')?.click()`);
      await waitFor(win, `(() => {
        const embedded = window.LoadToAgentTerminal.embeddedState();
        return embedded.connected
          && embedded.agentSessionId === 'fixture-root'
          && embedded.terminalId !== ${JSON.stringify(previousTerminalId)}
          && embedded.terminalId.startsWith('terminal-created-')
          && document.querySelector('#detailDrawer')?.dataset.conversationSurface === 'pty'
          && window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
            && call.args[0]?.bridgeId === 'fixture-root').length === 1;
      })()`, `${terminalStatus} PTY 행을 죽은 xterm으로 재사용하지 않고 교체하지 못했습니다.`);
      await wait(180);
      const replacement = await win.webContents.executeJavaScript(`(() => {
        const embedded = window.LoadToAgentTerminal.embeddedState();
        const createCalls = window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
          && call.args[0]?.bridgeId === 'fixture-root');
        const retained = window.interactionTest.getTerminals().find(item => item.id === ${JSON.stringify(previousTerminalId)});
        return {
          retainedStatus: retained?.status || '',
          previousTerminalId: ${JSON.stringify(previousTerminalId)},
          terminalId: embedded.terminalId || '',
          createCalls: createCalls.length,
          createOptions: createCalls[0]?.args[0] || null,
          commandCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCommand').length,
          stalePresenceRetained: window.LoadToAgentApp.selectedSession()?.runtimePresence?.some(item =>
            item.kind === 'terminal' && item.terminalId === ${JSON.stringify(previousTerminalId)}),
          oldHostInDrawer: Boolean(document.querySelector('#drawerTerminalViewport > [data-terminal-screen="${previousTerminalId}"]')),
          oldHostIdentity: document.querySelector('[data-terminal-screen="${previousTerminalId}"]')?.dataset.retainedDeadIdentity || '',
          newXtermMounted: Boolean(document.querySelector('#drawerTerminalViewport > [data-terminal-screen="' + embedded.terminalId + '"] .xterm')),
        };
      })()`);
      assert(replacement.retainedStatus === terminalStatus
        && replacement.terminalId !== replacement.previousTerminalId
        && replacement.terminalId.startsWith('terminal-created-')
        && replacement.createCalls === 1
        && replacement.createOptions?.type === 'agent'
        && !String(replacement.createOptions?.initialCommand || '')
        && replacement.commandCalls === 0
        && replacement.stalePresenceRetained
        && !replacement.oldHostInDrawer
        && replacement.oldHostIdentity === terminalStatus
        && replacement.newXtermMounted,
      `inventory에 남은 ${terminalStatus} PTY 교체가 올바르지 않습니다: ${JSON.stringify(replacement)}`);
      await win.webContents.executeJavaScript(`(() => {
        window.interactionTest.emitTerminalState('updated');
        window.interactionTest.emitSnapshot();
        window.interactionTest.emitSnapshot();
      })()`);
      await wait(180);
      const stableReplacement = await win.webContents.executeJavaScript(`(() => ({
        terminalId: window.LoadToAgentTerminal.embeddedState().terminalId || '',
        createCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
          && call.args[0]?.bridgeId === 'fixture-root').length,
      }))()`);
      assert(stableReplacement.terminalId === replacement.terminalId && stableReplacement.createCalls === 1,
        `${terminalStatus} PTY 교체 뒤 중복 생성이 발생했습니다: ${JSON.stringify(stableReplacement)}`);
      retainedTerminalReplacements.push(replacement);
      retainedTerminalId = replacement.terminalId;
    }
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer(); window.interactionTest.clearControls()`);
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, 'PTY 전환 검사용 드로어를 닫지 못했습니다.');

    await win.webContents.executeJavaScript(`(async () => {
      const base = window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-root');
      const staleSession = {
        ...base,
        id: 'fixture-stale-terminal', externalId: 'fixture-stale-terminal-external',
        title: '만료된 PTY 후보가 있는 작업', childIds: [], runId: '',
        runtimePresence: [{ kind: 'terminal', terminalId: 'terminal-stale', pid: 44001, label: '만료된 터미널 후보' }],
      };
      window.interactionTest.addSession(staleSession);
      window.interactionTest.addTerminal({
        id: 'terminal-stale', type: 'agent', title: '만료된 터미널 후보',
        status: 'running', pid: 44001, cwd: 'D:\\fixture', provider: staleSession.provider,
        bridgeId: staleSession.id, agentResumeSessionId: staleSession.externalId,
        agentConnectionSignature: window.interactionTest.connectionSignatureForSession(staleSession),
        conversationBound: true, background: true, backend: 'direct', distro: '',
      });
      window.interactionTest.emitSnapshot();
      await window.LoadToAgentTerminal.refresh();
      window.interactionTest.configure({ failures: { terminalGet: 1 } });
      window.interactionTest.setTerminalGetDelays({ 'terminal-stale': 180 });
      window.interactionTest.clearCalls();
      window.LoadToAgentApp.openDrawer('fixture-stale-terminal');
    })()`);
    await waitFor(win, `(() => {
      const drawer = document.querySelector('#detailDrawer');
      return drawer?.dataset.conversationSurface === 'error'
        && drawer.dataset.terminalChat === 'true'
        && Boolean(document.querySelector('#drawerTerminalSurface')?.getClientRects().length)
        && document.querySelector('#drawerContent')?.classList.contains('hidden')
        && document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar')?.dataset.tone === 'error'
        && window.interactionTest.getCalls().filter(call => call.name === 'terminalGet' && call.args[0] === 'terminal-stale').length === 1
        && !window.LoadToAgentTerminal.embeddedState().connected;
    })()`, 'PTY 조회 실패가 실제 터미널 화면의 명시적 오류로 남지 않았습니다.');
    await wait(350);
    const failedCandidateFallback = await win.webContents.executeJavaScript(`(() => ({
      surface: document.querySelector('#detailDrawer')?.dataset.conversationSurface || '',
      terminalVisible: Boolean(document.querySelector('#drawerTerminalSurface')?.getClientRects().length),
      transcriptHidden: document.querySelector('#drawerContent')?.classList.contains('hidden'),
      errorTone: document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar')?.dataset.tone || '',
      retryVisible: Boolean(document.querySelector('#drawerTerminalReconnectBtn')?.getClientRects().length),
      terminalGetCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalGet' && call.args[0] === 'terminal-stale').length,
      terminalCreateCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate').length,
      cachedBlankTerminal: Boolean(document.querySelector('[data-terminal-screen="terminal-stale"]')),
    }))()`);
    assert(failedCandidateFallback.surface === 'error' && failedCandidateFallback.terminalVisible
      && failedCandidateFallback.transcriptHidden && failedCandidateFallback.errorTone === 'error'
      && failedCandidateFallback.retryVisible && failedCandidateFallback.terminalGetCalls === 1
      && failedCandidateFallback.terminalCreateCalls === 0 && !failedCandidateFallback.cachedBlankTerminal,
    `실패한 PTY 후보가 명시적 오류 또는 단일 재시도 상태로 남지 않았습니다: ${JSON.stringify(failedCandidateFallback)}`);
    const unavailableBeforeSwitch = await win.webContents.executeJavaScript(`(() => {
      const session = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === 'fixture-stale-terminal');
      return window.LoadToAgentDrawerTerminal.canMount(session, 'terminal-stale');
    })()`);
    assert(unavailableBeforeSwitch === false, 'A→B 격리 검사의 B PTY가 canMount=false 전제 상태가 아닙니다.');
    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.clearControls();
      window.LoadToAgentApp.openDrawer('fixture-root', { context: true });
    })()`);
    await waitFor(win, `(() => {
      const embedded = window.LoadToAgentTerminal.embeddedState();
      return embedded.connected && embedded.agentSessionId === 'fixture-root'
        && embedded.terminalId === ${JSON.stringify(retainedTerminalId)}
        && document.querySelector('#detailDrawer')?.dataset.conversationSurface === 'pty';
    })()`, 'canMount=false 전환 검사에서 A PTY를 다시 연결하지 못했습니다.');
    await win.webContents.executeJavaScript(`(() => {
      const embedded = window.LoadToAgentTerminal.embeddedState();
      const host = document.querySelector('[data-terminal-screen="' + embedded.terminalId + '"]');
      if (host) host.dataset.unavailableSwitchSource = 'fixture-root';
      window.interactionTest.clearCalls();
      window.LoadToAgentApp.openDrawer('fixture-stale-terminal', { context: true });
    })()`);
    await waitFor(win, `(() => {
      const embedded = window.LoadToAgentTerminal.embeddedState();
      const drawerState = window.LoadToAgentDrawerTerminal.state();
      return window.LoadToAgentApp.state.selectedId === 'fixture-stale-terminal'
        && drawerState.sessionId === 'fixture-stale-terminal'
        && ['unavailable', 'error'].includes(drawerState.phase)
        && !embedded.connected
        && embedded.agentSessionId !== 'fixture-root'
        && !document.querySelector('#drawerTerminalViewport > [data-unavailable-switch-source="fixture-root"]')
        && document.querySelector('#detailDrawer')?.dataset.conversationSurface === 'error';
    })()`, 'A PTY 연결 상태에서 canMount=false인 B로 전환할 때 A xterm을 즉시 격리하지 못했습니다.');
    await win.webContents.executeJavaScript(`(() => {
      const viewport = document.querySelector('#drawerTerminalViewport');
      viewport.tabIndex = -1;
      viewport.focus();
    })()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'X' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'X' });
    await wait(80);
    const unavailableSwitchIsolation = await win.webContents.executeJavaScript(`(() => {
      const embedded = window.LoadToAgentTerminal.embeddedState();
      const session = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === 'fixture-stale-terminal');
      return {
        selectedId: window.LoadToAgentApp.state.selectedId,
        canMount: window.LoadToAgentDrawerTerminal.canMount(session, 'terminal-stale'),
        surface: document.querySelector('#detailDrawer')?.dataset.conversationSurface || '',
        terminalVisible: Boolean(document.querySelector('#drawerTerminalSurface')?.getClientRects().length),
        embedded,
        aHostInDrawer: Boolean(document.querySelector('#drawerTerminalViewport > [data-unavailable-switch-source="fixture-root"]')),
        aHostParked: Boolean(document.querySelector('#terminalViewport > [data-unavailable-switch-source="fixture-root"]')),
        aComposerPresent: Boolean(document.querySelector('#drawerComposer [data-agent-command-form="fixture-root"]')),
        aInputFocused: Boolean(document.activeElement?.closest?.('[data-unavailable-switch-source="fixture-root"]')),
        aInputCalls: window.interactionTest.getCalls().filter(call =>
          (call.name === 'terminalWrite' || call.name === 'terminalCommand')
          && call.args[0] === ${JSON.stringify(retainedTerminalId)}),
      };
    })()`);
    assert(unavailableSwitchIsolation.selectedId === 'fixture-stale-terminal'
      && unavailableSwitchIsolation.canMount === false
      && unavailableSwitchIsolation.surface === 'error'
      && unavailableSwitchIsolation.terminalVisible
      && !unavailableSwitchIsolation.embedded.connected
      && !unavailableSwitchIsolation.aHostInDrawer
      && unavailableSwitchIsolation.aHostParked
      && !unavailableSwitchIsolation.aComposerPresent
      && !unavailableSwitchIsolation.aInputFocused
      && unavailableSwitchIsolation.aInputCalls.length === 0,
    `canMount=false B 화면에 A PTY 또는 입력 경로가 남았습니다: ${JSON.stringify(unavailableSwitchIsolation)}`);
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer(); window.interactionTest.clearControls()`);
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, '실패 후보 검사용 드로어를 닫지 못했습니다.');

    await win.webContents.executeJavaScript(`(async () => {
      window.interactionTest.clearCalls();
      for (const terminal of window.interactionTest.getTerminals().filter(item => item.bridgeId === 'fixture-root')) {
        window.interactionTest.removeTerminal(terminal.id);
      }
      window.interactionTest.emitTerminalState('removed');
      window.interactionTest.addTerminal({
        id: 'terminal-detached-drawer', type: 'agent', title: '분리된 같은 AI 작업', status: 'detached',
        pid: 43001, cwd: 'D:\\fixture', provider: 'claude', bridgeId: 'fixture-root',
        background: true, backend: 'managed-tmux', tmuxSocket: 'loadtoagent', managedTmuxSession: 'lta-detached-drawer',
      });
      window.interactionTest.setSessionRuntimePresence('fixture-root', []);
      window.interactionTest.configure({ delays: { terminalCreate: 260 } });
      window.interactionTest.emitSnapshot();
      await window.LoadToAgentTerminal.refresh();
      window.LoadToAgentApp.openDrawer('fixture-root', { context: true });
    })()`);
    await waitFor(win, `window.interactionTest.getCalls().some(call =>
      call.name === 'terminalRetire' && call.args[0] === 'terminal-detached-drawer')
      && window.interactionTest.getCalls().some(call => call.name === 'terminalCreate'
        && call.args[0]?.bridgeId === 'fixture-root' && call.args[0]?.type === 'agent')`,
    'unsigned 관리형 PTY를 폐기하고 서명된 앱 소유 agent PTY 생성을 시작하지 않았습니다.');
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer()`);
    await wait(420);
    const detachedRace = await win.webContents.executeJavaScript(`(() => {
      const createCalls = window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
        && call.args[0]?.bridgeId === 'fixture-root');
      const created = window.interactionTest.getTerminals().find(item =>
        item.id.startsWith('terminal-created-') && item.bridgeId === 'fixture-root');
      return {
        drawerOpen: document.querySelector('#detailDrawer').classList.contains('open'),
        embedded: window.LoadToAgentTerminal.embeddedState(),
        oldDrawerHost: Boolean(document.querySelector('#drawerTerminalViewport > .terminal-screen[data-terminal-screen="terminal-detached-drawer"]')),
        oldTerminalRetained: window.interactionTest.getTerminals().some(item => item.id === 'terminal-detached-drawer'),
        reconnectCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalReconnect' && call.args[0] === 'terminal-detached-drawer').length,
        oldGetCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalGet' && call.args[0] === 'terminal-detached-drawer').length,
        retireCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalRetire' && call.args[0] === 'terminal-detached-drawer').length,
        createCalls: createCalls.length,
        createOptions: createCalls[0]?.args[0] || null,
        created,
      };
    })()`);
    assert(!detachedRace.drawerOpen && !detachedRace.embedded.connected && !detachedRace.oldDrawerHost
      && !detachedRace.oldTerminalRetained && detachedRace.reconnectCalls === 0
      && detachedRace.oldGetCalls === 0 && detachedRace.retireCalls === 1
      && detachedRace.createCalls === 1
      && detachedRace.createOptions?.type === 'agent'
      && detachedRace.createOptions?.bridgeId === 'fixture-root'
      && String(detachedRace.createOptions?.agentConnectionSignature || '').startsWith('acs1:')
      && detachedRace.created?.conversationBound === true
      && detachedRace.created?.backend === 'direct',
    `unsigned detached PTY가 재사용되거나 새 signed direct PTY 수명주기가 손상됐습니다: ${JSON.stringify(detachedRace)}`);

    await win.webContents.executeJavaScript(`(async () => {
      window.interactionTest.clearControls();
      window.interactionTest.clearCalls();
      window.interactionTest.configure({ delays: { terminalCreate: 160 } });
      const base = window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-root');
      window.interactionTest.addSession({
        ...base,
        id: 'fixture-tmux-only', externalId: 'fixture-tmux-only-external',
        title: '기존 tmux pane을 실제 터미널로 여는 작업', parentId: null, childIds: [],
        provider: 'claude', runId: '', cwd: '/mnt/c/Users/fixture/tmux-only-project',
        originCwd: '/mnt/c/Users/fixture/tmux-only-project',
        environment: { kind: 'wsl', distro: 'FixtureLinux', label: 'WSL · FixtureLinux' },
        runtimePresence: [{
          kind: 'tmux', id: 'tmux:FixtureLinux:%8', distro: 'FixtureLinux',
          paneId: 'tmux-pane-unlinked', paneNativeId: '%8',
          label: 'FixtureLinux · fixture-session · %8',
        }],
      });
      window.interactionTest.emitSnapshot();
      await window.LoadToAgentTerminal.refresh();
      window.LoadToAgentApp.openDrawer('fixture-tmux-only', { context: true });
    })()`);
    await waitFor(win, `(() => {
      const embedded = window.LoadToAgentTerminal.embeddedState();
      return embedded.connected
        && embedded.agentSessionId === 'fixture-tmux-only'
        && embedded.terminalId.startsWith('terminal-created-')
        && document.querySelector('#detailDrawer')?.dataset.conversationSurface === 'pty'
        && document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar')?.dataset.tone === 'connected'
        && Boolean(document.querySelector('#drawerTerminalViewport > [data-terminal-screen="' + embedded.terminalId + '"] .xterm'))
        && window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
          && call.args[0]?.bridgeId === 'fixture-tmux-only').length === 1;
    })()`, '외부 tmux 관측값을 쓰기 권한으로 사용하지 않고 exact provider 대화 PTY를 열지 못했습니다.');
    await wait(180);
    const tmuxOnlyAttach = await win.webContents.executeJavaScript(`(() => {
      const embedded = window.LoadToAgentTerminal.embeddedState();
      const createCalls = window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
        && call.args[0]?.bridgeId === 'fixture-tmux-only');
      const created = window.interactionTest.getTerminals().find(item => item.id === embedded.terminalId);
      return {
        surface: document.querySelector('#detailDrawer')?.dataset.conversationSurface || '',
        terminalChat: document.querySelector('#detailDrawer')?.dataset.terminalChat || '',
        transcriptHidden: document.querySelector('#drawerContent')?.classList.contains('hidden'),
        embedded,
        createCalls: createCalls.length,
        createOptions: createCalls[0]?.args[0] || null,
        created: created ? {
          id: created.id, type: created.type, provider: created.provider, bridgeId: created.bridgeId,
          distro: created.distro, tmuxSession: created.tmuxSession,
          tmuxWindow: created.tmuxWindow, tmuxPane: created.tmuxPane,
          agentResumeSessionId: created.agentResumeSessionId,
          agentConnectionSignature: created.agentConnectionSignature,
          conversationBound: created.conversationBound,
          backend: created.backend,
        } : null,
        terminalGetCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalGet'
          && call.args[0] === embedded.terminalId).length,
        providerResumeCalls: createCalls.filter(call => call.args[0]?.type === 'agent').length,
        commandCalls: window.interactionTest.getCalls().filter(call =>
          call.name === 'terminalCommand' || call.name === 'tmuxSendText').length,
        xtermMounted: Boolean(document.querySelector('#drawerTerminalViewport > [data-terminal-screen="' + embedded.terminalId + '"] .xterm')),
        replayMarkerVisible: [...document.querySelectorAll('#drawerTerminalViewport .xterm-rows')]
          .some(node => node.textContent.includes('CREATED_PTY')),
      };
    })()`);
    assert(tmuxOnlyAttach.surface === 'pty' && tmuxOnlyAttach.terminalChat === 'true'
      && tmuxOnlyAttach.transcriptHidden
      && tmuxOnlyAttach.embedded.connected
      && tmuxOnlyAttach.embedded.agentSessionId === 'fixture-tmux-only'
      && tmuxOnlyAttach.createCalls === 1
      && tmuxOnlyAttach.createOptions?.type === 'agent'
      && tmuxOnlyAttach.createOptions?.provider === 'claude'
      && tmuxOnlyAttach.createOptions?.distro === 'FixtureLinux'
      && JSON.stringify(tmuxOnlyAttach.createOptions?.args) === JSON.stringify(['--resume', 'fixture-tmux-only-external'])
      && JSON.stringify(tmuxOnlyAttach.createOptions?.recoveryArgs) === JSON.stringify(['--resume', 'fixture-tmux-only-external'])
      && !tmuxOnlyAttach.createOptions?.tmuxSession
      && !tmuxOnlyAttach.createOptions?.tmuxWindow
      && !tmuxOnlyAttach.createOptions?.tmuxPane
      && tmuxOnlyAttach.createOptions?.bridgeId === 'fixture-tmux-only'
      && String(tmuxOnlyAttach.createOptions?.agentConnectionSignature || '').startsWith('acs1:')
      && tmuxOnlyAttach.created?.type === 'agent'
      && tmuxOnlyAttach.created?.provider === 'claude'
      && tmuxOnlyAttach.created?.bridgeId === 'fixture-tmux-only'
      && tmuxOnlyAttach.created?.distro === 'FixtureLinux'
      && !tmuxOnlyAttach.created?.tmuxSession
      && !tmuxOnlyAttach.created?.tmuxWindow
      && !tmuxOnlyAttach.created?.tmuxPane
      && tmuxOnlyAttach.created?.agentResumeSessionId === 'fixture-tmux-only-external'
      && tmuxOnlyAttach.created?.agentConnectionSignature === tmuxOnlyAttach.createOptions?.agentConnectionSignature
      && tmuxOnlyAttach.created?.conversationBound === true
      && tmuxOnlyAttach.created?.backend === 'direct'
      && tmuxOnlyAttach.terminalGetCalls >= 1
      && tmuxOnlyAttach.providerResumeCalls === 1
      && tmuxOnlyAttach.commandCalls === 0
      && tmuxOnlyAttach.xtermMounted && tmuxOnlyAttach.replayMarkerVisible,
    `외부 tmux 관측값이 writable attach로 승격되거나 exact provider resume가 손상됐습니다: ${JSON.stringify(tmuxOnlyAttach)}`);
    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.emitTerminalState('updated');
      window.interactionTest.emitSnapshot();
      window.interactionTest.emitSnapshot();
    })()`);
    await wait(180);
    const tmuxCreateStable = await win.webContents.executeJavaScript(`window.interactionTest.getCalls().filter(call =>
      call.name === 'terminalCreate' && call.args[0]?.bridgeId === 'fixture-tmux-only').length`);
    assert(tmuxCreateStable === 1, `외부 tmux가 있는 대화의 provider resume PTY가 중복 생성됐습니다: ${tmuxCreateStable}`);
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer(); window.interactionTest.clearControls()`);
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, 'tmux-only attach 검사용 드로어를 닫지 못했습니다.');

    await win.webContents.executeJavaScript(`(async () => {
      window.interactionTest.clearCalls();
      window.interactionTest.configure({ delays: { terminalCreate: 180 } });
      const base = window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-root');
      window.interactionTest.addSession({
        ...base,
        id: 'fixture-codex-desktop', externalId: '019fcb16-3521-7222-869d-2d40578c490a',
        provider: 'codex', model: 'gpt-5.6-sol', clientKind: 'codex-desktop',
        title: '**지난 세션이 없습니다** 완료된 작업이 여기에 제목으로 표시됩니다. 이것도 이쁘게 위치해줘',
        runId: '', runtimePresence: [], childIds: [], status: 'running', statusDetail: '턴 실행 중',
      });
      window.interactionTest.emitSnapshot();
      await window.LoadToAgentTerminal.refresh();
      window.LoadToAgentApp.openDrawer('fixture-codex-desktop');
      window.interactionTest.emitSnapshot();
    })()`);
    await waitFor(win, `(() => {
      const drawer = document.querySelector('#detailDrawer');
      return drawer?.classList.contains('open')
        && drawer.dataset.presentation === 'modal'
        && drawer.dataset.conversationShell === 'terminal'
        && drawer.dataset.conversationSurface === 'pty'
        && drawer.dataset.terminalChat === 'true'
        && !document.querySelector('#drawerTerminalSurface')?.classList.contains('hidden')
        && document.querySelector('#drawerContent')?.classList.contains('hidden')
        && window.LoadToAgentTerminal.embeddedState().connected
        && window.LoadToAgentTerminal.embeddedState().terminalId.startsWith('terminal-created-')
        && document.querySelector('#drawerTerminalViewport > .terminal-screen .xterm')
        && document.querySelector('#drawerTitle')?.textContent.includes('지난 세션이 없습니다');
    })()`, '외부 Codex Desktop 세션을 열 때 실제 PTY를 자동 생성·연결하지 않았습니다.');
    await wait(300);
    const externalSession = await win.webContents.executeJavaScript(`(() => {
      const rect = selector => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } : null;
      };
      const title = document.querySelector('#drawerTitle');
      const surface = document.querySelector('#drawerTerminalSurface');
      return {
        title: title?.textContent.trim() || '',
        titleAttribute: title?.title || '',
        headDisplay: getComputedStyle(document.querySelector('.drawer-head')).display,
        mark: rect('#drawerProviderMark'),
        titleBox: rect('.drawer-title'),
        close: rect('#closeDrawerBtn'),
        conversationShell: document.querySelector('#detailDrawer')?.dataset.conversationShell || '',
        conversationSurface: document.querySelector('#detailDrawer')?.dataset.conversationSurface || '',
        terminalHidden: surface?.classList.contains('hidden'),
        terminalTabAbsent: !document.querySelector('[data-tab="terminal"]'),
        tabs: [...document.querySelectorAll('.drawer-tab:not(.hidden)')].map(node => node.textContent.trim()),
        terminalVisible: Boolean(surface?.getClientRects().length),
        transcriptHidden: document.querySelector('#drawerContent')?.classList.contains('hidden'),
        embedded: window.LoadToAgentTerminal.embeddedState(),
        replayMarkerVisible: document.querySelector('#drawerTerminalViewport .xterm-rows')?.textContent.includes('CREATED_PTY') || false,
        composerShell: document.querySelector('#drawerComposer [data-agent-command-form]')?.classList.contains('terminal-conversation'),
        composerMode: document.querySelector('#drawerComposer [data-agent-command-input-mode-selected]')?.dataset.agentCommandInputModeSelected || '',
        composerPlaceholder: document.querySelector('#drawerComposer [data-agent-command-draft]')?.placeholder || '',
        createCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
          && call.args[0]?.bridgeId === 'fixture-codex-desktop'),
        getCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalGet'),
        commandCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCommand'),
      };
    })()`);
    assert(!externalSession.title.includes('**') && !externalSession.titleAttribute.includes('**'),
      `세션 제목에 Markdown 강조 문자가 그대로 노출됩니다: ${JSON.stringify(externalSession)}`);
    assert(externalSession.headDisplay === 'grid'
      && externalSession.mark.right + 8 <= externalSession.titleBox.left
      && externalSession.titleBox.right + 8 <= externalSession.close.left,
    `긴 제목과 제공자·닫기 버튼의 헤더 배치가 겹칩니다: ${JSON.stringify(externalSession)}`);
    assert(externalSession.conversationShell === 'terminal' && externalSession.conversationSurface === 'pty'
      && !externalSession.terminalHidden && externalSession.terminalTabAbsent && externalSession.terminalVisible
      && externalSession.transcriptHidden && externalSession.embedded.connected
      && externalSession.embedded.terminalId.startsWith('terminal-created-') && externalSession.replayMarkerVisible
      && JSON.stringify(externalSession.tabs) === JSON.stringify(['요약', '대화', '진행 과정', '사용량'])
      && externalSession.composerShell
      && externalSession.composerMode === 'terminal' && externalSession.composerPlaceholder.includes('터미널')
      && externalSession.createCalls.length === 1
      && externalSession.createCalls[0].args[0]?.type === 'agent'
      && externalSession.createCalls[0].args[0]?.provider === 'codex'
      && externalSession.createCalls[0].args[0]?.transient === false
      && externalSession.createCalls[0].args[0]?.initialCommand === ''
      && externalSession.createCalls[0].args[0]?.initialCommandInArgs === false
      && externalSession.getCalls.some(call => call.args[0] === externalSession.embedded.terminalId)
      && externalSession.commandCalls.length === 0,
    `PTY가 없는 외부 실행 세션의 실제 PTY 자동 연결이 올바르지 않습니다: ${JSON.stringify(externalSession)}`);

    const externalOutput = path.join(outputDir, 'loadtoagent-drawer-external-session.png');
    win.webContents.invalidate();
    await wait(250);
    fs.writeFileSync(externalOutput, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer(); window.interactionTest.clearControls()`);
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, '외부 세션 드로어를 닫지 못했습니다.');

    await win.webContents.executeJavaScript(`(() => {
      const base = window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-root');
      window.interactionTest.addSession({
        ...base,
        id: 'fixture-create-failure', externalId: 'fixture-create-failure-external',
        title: 'PTY 생성 실패 뒤 다시 연결하는 작업', childIds: [], parentId: null,
        runId: '', runtimePresence: [], status: 'completed', statusDetail: '이전 작업 완료',
      });
      window.interactionTest.emitSnapshot();
      window.interactionTest.clearCalls();
      window.interactionTest.configure({ delays: { terminalCreate: 100 }, failures: { terminalCreate: 1 } });
      window.LoadToAgentApp.openDrawer('fixture-create-failure');
    })()`);
    await waitFor(win, `(() => {
      const drawer = document.querySelector('#detailDrawer');
      return drawer?.dataset.conversationSurface === 'error'
        && drawer.dataset.terminalChat === 'true'
        && Boolean(document.querySelector('#drawerTerminalSurface')?.getClientRects().length)
        && document.querySelector('#drawerContent')?.classList.contains('hidden')
        && document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar')?.dataset.tone === 'error'
        && window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
          && call.args[0]?.bridgeId === 'fixture-create-failure').length === 1
        && !window.LoadToAgentTerminal.embeddedState().connected;
    })()`, 'PTY 생성 실패가 실제 터미널 화면의 명시적 오류로 남지 않았습니다.');
    await win.webContents.executeJavaScript(`window.interactionTest.emitSnapshot(); window.interactionTest.emitSnapshot()`);
    await wait(350);
    const creationFailure = await win.webContents.executeJavaScript(`(() => ({
        createCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
          && call.args[0]?.bridgeId === 'fixture-create-failure').length,
        terminalGetCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalGet').length,
        errorTone: document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar')?.dataset.tone || '',
        retryVisible: Boolean(document.querySelector('#drawerTerminalReconnectBtn')?.getClientRects().length),
        composerHidden: document.querySelector('#drawerComposer')?.classList.contains('hidden'),
      }))()`);
    assert(creationFailure.createCalls === 1
      && creationFailure.errorTone === 'error' && creationFailure.retryVisible
      && creationFailure.composerHidden,
    `PTY 생성 실패가 재시도 루프 또는 가짜 입력 화면으로 이어졌습니다: ${JSON.stringify(creationFailure)}`);
    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.clearControls();
      document.querySelector('#drawerTerminalReconnectBtn')?.click();
    })()`);
    await waitFor(win, `(() => {
      const embedded = window.LoadToAgentTerminal.embeddedState();
      return embedded.connected && embedded.agentSessionId === 'fixture-create-failure'
        && embedded.terminalId.startsWith('terminal-created-')
        && document.querySelector('#drawerTerminalViewport > .terminal-screen .xterm')
        && document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar')?.dataset.tone === 'connected'
        && document.querySelector('#detailDrawer')?.dataset.conversationSurface === 'pty'
        && !document.querySelector('#drawerComposer')?.classList.contains('hidden')
        && document.querySelector('#drawerComposer [data-agent-command-form]')?.dataset.agentTerminalReady === 'true'
        && window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
          && call.args[0]?.bridgeId === 'fixture-create-failure').length === 2;
    })()`, '명시적 재시도 뒤 새 PTY를 생성·연결하지 못했습니다.');
    const creationFailureRecovery = await win.webContents.executeJavaScript(`(() => {
      const embedded = window.LoadToAgentTerminal.embeddedState();
      return {
        terminalId: embedded.terminalId,
        composerMode: document.querySelector('#drawerComposer')?.dataset.mode || '',
        composerHidden: document.querySelector('#drawerComposer')?.classList.contains('hidden'),
        getCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalGet'
          && call.args[0] === embedded.terminalId).length,
        commandCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCommand').length,
      };
    })()`);
    assert(creationFailureRecovery.terminalId.startsWith('terminal-created-')
      && creationFailureRecovery.composerMode === 'terminal' && !creationFailureRecovery.composerHidden
      && creationFailureRecovery.getCalls >= 1
      && creationFailureRecovery.commandCalls === 0,
    `PTY 생성 재시도 뒤 실제 xterm 연결이 손상됐습니다: ${JSON.stringify(creationFailureRecovery)}`);
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer(); window.interactionTest.clearControls()`);
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, 'PTY 생성 실패 검사용 드로어를 닫지 못했습니다.');

    const conversationStatuses = [
      ['starting', 'claude-cli'],
      ['waiting', 'codex-ide'],
      ['paused', 'external-cli'],
      ['idle', 'claude-desktop'],
      ['completed', 'codex-cli'],
      ['failed', 'loadtoagent-bridge'],
      ['cancelled', 'codex-desktop'],
    ];
    await win.webContents.executeJavaScript(`(() => {
      const base = window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-root');
      for (const [status, clientKind] of ${JSON.stringify(conversationStatuses)}) {
        window.interactionTest.addSession({
          ...base,
          id: 'fixture-conversation-' + status,
          externalId: 'fixture-conversation-external-' + status,
          title: '**' + status + ' 대화** 모든 작업에서 같은 화면',
          status,
          statusDetail: status + ' 상태',
          clientKind,
          runId: '',
          runtimePresence: [],
          childIds: [],
          parentId: null,
        });
      }
      window.interactionTest.emitSnapshot();
      return true;
    })()`);
    const conversationMatrix = [];
    for (const [status, clientKind] of conversationStatuses) {
      const id = `fixture-conversation-${status}`;
      await win.webContents.executeJavaScript(`window.interactionTest.clearCalls(); window.LoadToAgentApp.openDrawer(${JSON.stringify(id)})`);
      await waitFor(win, `(() => {
        const drawer = document.querySelector('#detailDrawer');
        return drawer?.classList.contains('open')
          && window.LoadToAgentApp.state.selectedId === ${JSON.stringify(id)}
          && window.LoadToAgentApp.state.drawerTab === 'chat'
          && drawer.dataset.mode === 'session'
          && drawer.dataset.conversationShell === 'terminal'
          && drawer.dataset.conversationSurface === 'pty'
          && drawer.dataset.terminalChat === 'true'
          && !document.querySelector('#drawerTerminalSurface')?.classList.contains('hidden')
          && document.querySelector('#drawerContent')?.classList.contains('hidden')
          && window.LoadToAgentTerminal.embeddedState().connected
          && window.LoadToAgentTerminal.embeddedState().agentSessionId === ${JSON.stringify(id)}
          && window.LoadToAgentTerminal.embeddedState().terminalId.startsWith('terminal-created-')
          && document.querySelector('#drawerTerminalViewport > .terminal-screen .xterm');
      })()`, `${status}/${clientKind} 작업이 실제 PTY 대화 화면으로 열리지 않았습니다.`);
      const metrics = await win.webContents.executeJavaScript(`(() => {
        const rect = selector => document.querySelector(selector)?.getBoundingClientRect() || null;
        const drawer = document.querySelector('#detailDrawer');
        const mark = rect('#drawerProviderMark');
        const title = rect('.drawer-title');
        const close = rect('#closeDrawerBtn');
        return {
          status: ${JSON.stringify(status)},
          clientKind: ${JSON.stringify(clientKind)},
          title: document.querySelector('#drawerTitle')?.textContent.trim() || '',
          tabs: [...document.querySelectorAll('.drawer-tab:not(.hidden)')].map(node => node.textContent.trim()),
          terminalTabAbsent: !document.querySelector('[data-tab="terminal"]'),
          conversationShell: drawer.dataset.conversationShell || '',
          conversationSurface: drawer.dataset.conversationSurface || '',
          terminalVisible: Boolean(document.querySelector('#drawerTerminalSurface')?.getClientRects().length),
          transcriptHidden: document.querySelector('#drawerContent')?.classList.contains('hidden'),
          terminalId: window.LoadToAgentTerminal.embeddedState().terminalId || '',
          composerMode: document.querySelector('#drawerComposer')?.dataset.mode || '',
          composerInputMode: document.querySelector('#drawerComposer [data-agent-command-input-mode-selected]')?.dataset.agentCommandInputModeSelected || '',
          composerTerminalStyle: document.querySelector('#drawerComposer [data-agent-command-form]')?.classList.contains('terminal-conversation'),
          headerGrid: getComputedStyle(document.querySelector('.drawer-head')).display === 'grid',
          headerSeparated: Boolean(mark && title && close && mark.right + 8 <= title.left && title.right + 8 <= close.left),
          noOverflow: drawer.scrollWidth <= drawer.clientWidth + 2,
          createCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate'
            && call.args[0]?.bridgeId === ${JSON.stringify(id)}),
          getCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalGet'),
          commandCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCommand'),
        };
      })()`);
      assert(!metrics.title.includes('**')
        && JSON.stringify(metrics.tabs) === JSON.stringify(['요약', '대화', '진행 과정', '사용량'])
        && metrics.terminalTabAbsent
        && metrics.conversationShell === 'terminal'
        && metrics.conversationSurface === 'pty'
        && metrics.terminalVisible && metrics.transcriptHidden && metrics.terminalId.startsWith('terminal-created-')
        && metrics.composerMode === 'terminal'
        && metrics.composerInputMode === 'terminal'
        && metrics.composerTerminalStyle
        && metrics.headerGrid && metrics.headerSeparated && metrics.noOverflow
        && metrics.createCalls.length === 1
        && metrics.createCalls[0].args[0]?.initialCommand === ''
        && metrics.createCalls[0].args[0]?.initialCommandInArgs === false
        && metrics.getCalls.some(call => call.args[0] === metrics.terminalId)
        && metrics.commandCalls.length === 0,
      `상태별 실제 PTY 자동 연결 계약이 달라졌습니다: ${JSON.stringify(metrics)}`);
      conversationMatrix.push(metrics);
      await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer()`);
      await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, `${status} 대화창을 닫지 못했습니다.`);
    }

    const completedTerminalId = conversationMatrix.find(item => item.status === 'completed')?.terminalId || '';
    await win.webContents.executeJavaScript(`window.interactionTest.clearCalls(); window.LoadToAgentApp.openDrawer('fixture-conversation-completed')`);
    await waitFor(win, `window.LoadToAgentTerminal.embeddedState().connected
      && window.LoadToAgentTerminal.embeddedState().terminalId === ${JSON.stringify(completedTerminalId)}`,
    '완료된 대화창을 다시 열 때 기존 PTY를 재사용하지 못했습니다.');
    const completedReopen = await win.webContents.executeJavaScript(`(() => ({
      terminalId: window.LoadToAgentTerminal.embeddedState().terminalId,
      createCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalCreate').length,
      destructiveCalls: window.interactionTest.getCalls().filter(call => ['terminalRetire','terminalClose','terminalStop','terminalDetach'].includes(call.name)).length,
    }))()`);
    assert(completedReopen.terminalId === completedTerminalId && completedReopen.createCalls === 0
      && completedReopen.destructiveCalls === 0,
    `완료된 대화창 재열기가 같은 PTY를 재사용하지 않았습니다: ${JSON.stringify(completedReopen)}`);
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer()`);
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, '완료 대화창 재열기 검증 후 닫지 못했습니다.');

    await win.webContents.executeJavaScript(`window.interactionTest.clearCalls(); window.LoadToAgentApp.openSubagentConversation('fixture-child')`);
    await waitFor(win, `(() => {
      const drawer = document.querySelector('#detailDrawer');
      return drawer?.classList.contains('open')
        && drawer.dataset.mode === 'subagent'
        && drawer.dataset.conversationShell === 'terminal'
        && drawer.dataset.conversationSurface === 'transcript'
        && drawer.dataset.terminalChat === 'false'
        && document.querySelector('.drawer-terminal-transcript')
        && document.querySelectorAll('#drawerContent .chat-row').length > 0
        && document.querySelector('#drawerComposer')?.classList.contains('hidden');
    })()`, '도움 AI 대화가 터미널형 기록 화면으로 열리지 않았습니다.');
    const subagentProjection = await win.webContents.executeJavaScript(`(() => ({
      tabs: [...document.querySelectorAll('.drawer-tab:not(.hidden)')].map(node => node.textContent.trim()),
      terminalTabAbsent: !document.querySelector('[data-tab="terminal"]'),
      transcriptVisible: Boolean(document.querySelector('.drawer-terminal-transcript')?.getClientRects().length),
      assignmentVisible: Boolean(document.querySelector('.subagent-assignment-card')?.getClientRects().length),
      chatRows: document.querySelectorAll('#drawerContent .chat-row').length,
      composerHidden: document.querySelector('#drawerComposer')?.classList.contains('hidden'),
      noOverflow: document.querySelector('#detailDrawer').scrollWidth <= document.querySelector('#detailDrawer').clientWidth + 2,
      terminalCalls: window.interactionTest.getCalls().filter(call => ['terminalCreate','terminalGet','terminalWrite','terminalCommand','terminalReconnect','terminalRetire','terminalClose','terminalStop','terminalDetach'].includes(call.name)),
    }))()`);
    assert(JSON.stringify(subagentProjection.tabs) === JSON.stringify(['작업 내용'])
      && subagentProjection.terminalTabAbsent && subagentProjection.transcriptVisible
      && subagentProjection.chatRows > 0 && subagentProjection.composerHidden
      && subagentProjection.noOverflow && subagentProjection.terminalCalls.length === 0,
    `도움 AI 터미널형 기록 화면이 올바르지 않습니다: ${JSON.stringify(subagentProjection)}`);
    const subagentOutput = path.join(outputDir, 'loadtoagent-drawer-subagent.png');
    win.webContents.invalidate();
    await wait(250);
    fs.writeFileSync(subagentOutput, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer()`);
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, '도움 AI 대화창을 닫지 못했습니다.');

    await win.webContents.executeJavaScript(`(() => {
      const ended = new Set(['completed', 'cancelled', 'failed', 'idle']);
      window.LoadToAgentApp.state.snapshot.sessions = window.LoadToAgentApp.state.snapshot.sessions.map(session => (
        !session.parentId && ended.has(session.status)
          ? { ...session, status: 'running', statusDetail: '시각 검증용 실행 상태' }
          : session
      ));
      window.LoadToAgentApp.render();
    })()`);
    await waitFor(win, `document.querySelector('.project-history-empty')?.textContent.includes('아직 완료된 작업이 없습니다')`,
      '지난 기록 빈 상태의 명확한 안내가 표시되지 않았습니다.');
    const historyEmpty = await win.webContents.executeJavaScript(`(() => {
      const empty = document.querySelector('.project-history-empty');
      const list = document.querySelector('#projectHistoryList');
      const emptyBox = empty.getBoundingClientRect();
      const listBox = list.getBoundingClientRect();
      return {
        text: empty.textContent.replace(/\\s+/g, ' ').trim(),
        width: emptyBox.width,
        listWidth: listBox.width,
        height: emptyBox.height,
        borderStyle: getComputedStyle(empty).borderStyle,
      };
    })()`);
    assert(historyEmpty.text.includes('진행 중인 작업은 위에 표시되고')
      && historyEmpty.borderStyle === 'dashed'
      && historyEmpty.height >= 118
      && historyEmpty.width >= historyEmpty.listWidth - 2,
    `지난 기록 빈 상태가 기록 레일 전체에 안정적으로 배치되지 않았습니다: ${JSON.stringify(historyEmpty)}`);
    await win.webContents.executeJavaScript(`document.querySelector('.project-history-empty')?.scrollIntoView({ block: 'center' })`);
    const historyOutput = path.join(outputDir, 'loadtoagent-history-empty.png');
    win.webContents.invalidate();
    await wait(250);
    fs.writeFileSync(historyOutput, (await win.webContents.capturePage()).toPNG());

    const result = {
      shellBefore, opened, stalePromptGate, hydrationRace, statusRetention, unchangedAfterTab,
      disconnectComposerBefore, disconnectedComposerImmediate, disconnectedComposer,
      removedTerminalTransition, restoredTerminalTransition, retainedTerminalReplacements,
      failedCandidateFallback, unavailableSwitchIsolation,
      detachedRace, tmuxOnlyAttach, externalSession, creationFailure, creationFailureRecovery,
      conversationMatrix, completedReopen, subagentProjection, historyEmpty,
    };
    log(`passed\n${JSON.stringify(result, null, 2)}\n${output}\n${externalOutput}\n${subagentOutput}\n${historyOutput}`);
    process.stdout.write(`드로어 대화·PTY 시각·입력 검증 통과\n${JSON.stringify(result, null, 2)}\n${output}\n${externalOutput}\n${subagentOutput}\n${historyOutput}\n`);
    app.exit(0);
  } catch (error) {
    try {
      const diagnostic = await win.webContents.executeJavaScript(`(() => ({
        appState: {
          workspace: window.LoadToAgentApp?.state?.workspace || '',
          selectedId: window.LoadToAgentApp?.state?.selectedId || '',
          drawerTab: window.LoadToAgentApp?.state?.drawerTab || '',
        },
        drawer: (() => {
          const node = document.querySelector('#detailDrawer');
          return node ? {
            className: node.className,
            presentation: node.dataset.presentation,
            conversationShell: node.dataset.conversationShell,
            conversationSurface: node.dataset.conversationSurface,
            terminalChat: node.dataset.terminalChat,
          } : null;
        })(),
        embedded: window.LoadToAgentTerminal?.embeddedState?.() || null,
        selectedRuntimePresence: window.LoadToAgentApp?.selectedSession?.()?.runtimePresence || [],
        selectedTerminalTargets: window.LoadToAgentTerminal?.agentTargets?.(window.LoadToAgentApp?.selectedSession?.()) || [],
        mountableTargets: (window.LoadToAgentTerminal?.agentTargets?.(window.LoadToAgentApp?.selectedSession?.()) || []).map(target => ({
          id: target.id,
          kind: target.kind,
          canMount: window.LoadToAgentDrawerTerminal?.canMount?.(window.LoadToAgentApp?.selectedSession?.(), target.id),
        })),
        savedTerminalTarget: window.LoadToAgentApp?.state?.agentCommandTargets?.get?.(window.LoadToAgentApp?.state?.selectedId) || '',
        drawerTerminalState: window.LoadToAgentDrawerTerminal?.state?.() || null,
        terminalSurfaceHidden: document.querySelector('#drawerTerminalSurface')?.classList.contains('hidden'),
        terminalStatus: document.querySelector('#drawerTerminalStatus')?.textContent || '',
        terminalMeta: document.querySelector('#drawerTerminalMeta')?.textContent || '',
        emptyText: document.querySelector('#drawerTerminalEmpty')?.textContent || '',
        viewportConnected: document.querySelector('#drawerTerminalViewport')?.isConnected,
        viewportChildren: document.querySelector('#drawerTerminalViewport')?.children.length,
        calls: window.interactionTest?.getCalls?.().slice(-20) || [],
      }))()`);
      log(`diagnostic\n${JSON.stringify(diagnostic, null, 2)}`);
    } catch (diagnosticError) {
      log(`diagnostic failed\n${diagnosticError.stack || diagnosticError}`);
    }
    log(`failed\n${error.stack || error}`);
    process.stderr.write(`${error.stack}\n`);
    app.exit(1);
  }
});
