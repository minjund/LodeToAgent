'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

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
        && drawer.dataset.presentation === 'context'
        && drawer.dataset.terminalChat === 'true'
        && embedded.connected
        && embedded.terminalId === 'terminal-main'
        && document.querySelector('#drawerTerminalViewport > .terminal-screen .xterm');
    })()`, '실행 중 세션의 같은 PTY가 대화 탭에 연결되지 않았습니다.');
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
        metaCount: document.querySelector('#drawerMeta')?.children.length || 0,
        terminalVisible: visible(document.querySelector('#drawerTerminalSurface')),
        transcriptHidden: document.querySelector('#drawerContent')?.classList.contains('hidden'),
        structuredRows: drawer.querySelectorAll('.chat-row').length,
        composerVisible: visible(document.querySelector('#drawerComposer')),
        composerTerminalMode: document.querySelector('#drawerComposer [data-agent-command-input-mode-selected]')?.dataset.agentCommandInputModeSelected || '',
        status: document.querySelector('#drawerTerminalStatus')?.textContent.trim() || '',
        hostParent: host?.parentElement?.id || '',
        projectNavLabels: [...document.querySelectorAll('#projectContextNav [data-view]')].map(node => node.textContent.trim()),
      };
    })()`);
    assert(opened.drawerWidth >= 600 && opened.drawerWidth <= 680, `기존 드로어 폭이 바뀌었습니다: ${opened.drawerWidth}`);
    assert(opened.title === '화면 설명과 버튼을 쉽게 개선하기', `드로어 헤더 제목이 달라졌습니다: ${opened.title}`);
    assert(JSON.stringify(opened.tabs) === JSON.stringify(['요약', '대화', '진행 과정', '사용량']), `기존 탭 구성이 달라졌습니다: ${JSON.stringify(opened.tabs)}`);
    assert(opened.metaCount > 0 && opened.terminalVisible && opened.transcriptHidden && opened.structuredRows === 0,
      `대화 본문만 PTY로 바뀌지 않았습니다: ${JSON.stringify(opened)}`);
    assert(opened.composerVisible && opened.composerTerminalMode === 'terminal' && opened.status === 'PTY 연결됨'
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
    await waitFor(win, `window.interactionTest.getCalls().some(call => call.name === 'terminalWrite' && call.args[0] === 'terminal-main' && call.args[1].includes('z'))`, 'xterm 직접 키 입력이 같은 PTY로 전달되지 않았습니다.');

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
    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.setTerminalReplay('terminal-main', 'LIVE_DRAWER_PTY_OUTPUT\\r\\n');
      window.LoadToAgentTerminal.refreshPendingPrompts();
    })()`);
    await waitFor(win, `!window.LoadToAgentTerminal.pendingPromptForSession('fixture-root')
      && document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar').dataset.tone === 'running'`,
    '답변 대기 상태가 끝난 뒤 PTY 실행 상태로 돌아오지 않았습니다.');

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
    }))()`);
    assert(unchangedAfterTab.title === opened.title && JSON.stringify(unchangedAfterTab.tabs) === JSON.stringify(opened.tabs)
      && Math.abs(unchangedAfterTab.width - opened.drawerWidth) < 1
      && unchangedAfterTab.chatControls === 'drawerTerminalSurface',
    `탭 전환 뒤 드로어 셸 또는 대화 탭 연결이 달라졌습니다: ${JSON.stringify(unchangedAfterTab)}`);

    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="chat"]')?.click()`);
    await waitFor(win, `window.LoadToAgentTerminal.embeddedState().connected
      && document.querySelector('#drawerTerminalViewport > .terminal-screen[data-drawer-visual-identity="same-xterm-host"]')`, '대화 탭 복귀 시 같은 xterm 호스트가 다시 연결되지 않았습니다.');

    await win.webContents.executeJavaScript(`window.interactionTest.clearCalls(); document.querySelector('#closeDrawerBtn')?.click()`);
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')
      && !window.LoadToAgentTerminal.embeddedState().connected
      && document.querySelector('#terminalViewport > .terminal-screen[data-drawer-visual-identity="same-xterm-host"]')`, '드로어를 닫은 뒤 xterm 호스트가 원래 위치로 복귀하지 않았습니다.');
    const destructiveCalls = await win.webContents.executeJavaScript(`window.interactionTest.getCalls().filter(call => ['terminalClose','terminalStop','terminalDetach'].includes(call.name))`);
    assert(destructiveCalls.length === 0, `드로어를 닫으면서 PTY 프로세스를 변경했습니다: ${JSON.stringify(destructiveCalls)}`);

    await win.webContents.executeJavaScript(`(async () => {
      window.interactionTest.clearCalls();
      window.interactionTest.addTerminal({
        id: 'terminal-detached-drawer', type: 'agent', title: '분리된 같은 AI 작업', status: 'detached',
        pid: 43001, cwd: 'D:\\fixture', provider: 'claude', bridgeId: 'fixture-root',
        background: true, backend: 'managed-tmux', tmuxSocket: 'loadtoagent', managedTmuxSession: 'lta-detached-drawer',
      });
      window.interactionTest.setSessionRuntimePresence('fixture-root', []);
      window.interactionTest.setTerminalGetDelays({ 'terminal-detached-drawer': 260 });
      window.interactionTest.emitSnapshot();
      await window.LoadToAgentTerminal.refresh();
      window.LoadToAgentApp.openDrawer('fixture-root', { context: true });
    })()`);
    await waitFor(win, `window.interactionTest.getCalls().some(call => call.name === 'terminalReconnect' && call.args[0] === 'terminal-detached-drawer')
      && window.interactionTest.getCalls().some(call => call.name === 'terminalGet' && call.args[0] === 'terminal-detached-drawer')`,
    '분리된 관리형 PTY를 다시 연결하거나 scrollback 복원을 시작하지 않았습니다.');
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer()`);
    await wait(420);
    const detachedRace = await win.webContents.executeJavaScript(`(() => ({
      drawerOpen: document.querySelector('#detailDrawer').classList.contains('open'),
      embedded: window.LoadToAgentTerminal.embeddedState(),
      drawerHost: Boolean(document.querySelector('#drawerTerminalViewport > .terminal-screen[data-terminal-screen="terminal-detached-drawer"]')),
      parkedHost: Boolean(document.querySelector('#terminalViewport > .terminal-screen[data-terminal-screen="terminal-detached-drawer"]')),
      reconnectCalls: window.interactionTest.getCalls().filter(call => call.name === 'terminalReconnect' && call.args[0] === 'terminal-detached-drawer').length,
      destructiveCalls: window.interactionTest.getCalls().filter(call => ['terminalClose','terminalStop','terminalDetach'].includes(call.name)),
    }))()`);
    assert(!detachedRace.drawerOpen && !detachedRace.embedded.connected && !detachedRace.drawerHost
      && detachedRace.parkedHost && detachedRace.reconnectCalls === 1 && detachedRace.destructiveCalls.length === 0,
    `초기 PTY 연결 중 닫기 또는 detached 재연결 수명주기가 올바르지 않습니다: ${JSON.stringify(detachedRace)}`);

    await win.webContents.executeJavaScript(`(async () => {
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
    })()`);
    await waitFor(win, `(() => {
      const drawer = document.querySelector('#detailDrawer');
      return drawer?.classList.contains('open')
        && drawer.dataset.presentation === 'modal'
        && drawer.dataset.terminalChat === 'false'
        && document.querySelector('#drawerTerminalSurface')?.classList.contains('hidden')
        && !document.querySelector('#drawerContent')?.classList.contains('hidden')
        && document.querySelector('.drawer-external-session-note')
        && document.querySelector('#drawerTitle')?.textContent.includes('지난 세션이 없습니다');
    })()`, '외부 Codex Desktop 세션이 PTY 없음 화면 대신 안전한 대화 화면으로 열리지 않았습니다.');
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
        terminalHidden: surface?.classList.contains('hidden'),
        chatRows: document.querySelectorAll('#drawerContent .chat-row').length,
        note: document.querySelector('.drawer-external-session-note')?.textContent.replace(/\\s+/g, ' ').trim() || '',
        composerMode: document.querySelector('#drawerComposer [data-agent-command-input-mode-selected]')?.dataset.agentCommandInputModeSelected || '',
        composerPlaceholder: document.querySelector('#drawerComposer [data-agent-command-draft]')?.placeholder || '',
      };
    })()`);
    assert(!externalSession.title.includes('**') && !externalSession.titleAttribute.includes('**'),
      `세션 제목에 Markdown 강조 문자가 그대로 노출됩니다: ${JSON.stringify(externalSession)}`);
    assert(externalSession.headDisplay === 'grid'
      && externalSession.mark.right + 8 <= externalSession.titleBox.left
      && externalSession.titleBox.right + 8 <= externalSession.close.left,
    `긴 제목과 제공자·닫기 버튼의 헤더 배치가 겹칩니다: ${JSON.stringify(externalSession)}`);
    assert(externalSession.terminalHidden && externalSession.chatRows > 0
      && externalSession.composerMode === 'conversation'
      && externalSession.composerPlaceholder === 'AI에게 보낼 답변을 입력하세요'
      && externalSession.note.includes('Codex 앱에서 실행 중'),
    `PTY가 없는 외부 실행 세션의 대화 대체 화면이 올바르지 않습니다: ${JSON.stringify(externalSession)}`);

    const externalOutput = path.join(outputDir, 'loadtoagent-drawer-external-session.png');
    win.webContents.invalidate();
    await wait(250);
    fs.writeFileSync(externalOutput, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer()`);
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, '외부 세션 드로어를 닫지 못했습니다.');

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

    log(`passed\n${JSON.stringify({ shellBefore, opened, unchangedAfterTab, detachedRace, externalSession, historyEmpty }, null, 2)}\n${output}\n${externalOutput}\n${historyOutput}`);
    process.stdout.write(`드로어 PTY 시각·입력 검증 통과\n${JSON.stringify({ shellBefore, opened, unchangedAfterTab, detachedRace, externalSession, historyEmpty }, null, 2)}\n${output}\n${externalOutput}\n${historyOutput}\n`);
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
          return node ? { className: node.className, presentation: node.dataset.presentation, terminalChat: node.dataset.terminalChat } : null;
        })(),
        embedded: window.LoadToAgentTerminal?.embeddedState?.() || null,
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
