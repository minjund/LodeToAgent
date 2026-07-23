'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, net, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { Worker } = require('worker_threads');
const { execFileSync } = require('child_process');
const { AgentRunner, probeProviders } = require('./src/agentRunner');
const { providerList, blankUsage } = require('./src/providerRegistry');
const { TerminalManager } = require('./src/terminalManager');
const { TerminalHostClient, launchTerminalHost, resolveTerminalHostExecutable } = require('./src/terminalHost');
const { TmuxController } = require('./src/tmuxController');
const { normalizeWslList } = require('./src/tmuxMonitor');
const { UpdateManager } = require('./src/updateManager');
const { launchDownloadedUpdate } = require('./src/updateInstaller');
const { readWorkspaces, removeWorkspace, writeWorkspaces } = require('./src/workspaceStore');
const { registerAppIpc } = require('./src/ipc/registerAppIpc');
const { registerAgentIpc } = require('./src/ipc/registerAgentIpc');
const { registerTerminalIpc } = require('./src/ipc/registerTerminalIpc');
const { registerTmuxIpc } = require('./src/ipc/registerTmuxIpc');
const { registerWorkspaceIpc } = require('./src/ipc/registerWorkspaceIpc');
const { reportRecoverableError } = require('./src/diagnostics');
const { AttentionNotifier } = require('./src/attentionNotifier');
const { ProviderVisibilityStore } = require('./src/providerVisibilityStore');
const { macPathEntries } = require('./src/platformPath');

const PRODUCT_NAME = 'LoadToAgent';
app.setName(PRODUCT_NAME);
process.title = PRODUCT_NAME;
if (process.platform === 'win32') app.setAppUserModelId('com.wincube.loadtoagent');

const demoCapture = process.env.LOADTOAGENT_DEMO_CAPTURE === '1';
// 사용자 메시지와 실제 개입 요청을 안정적으로 구분할 때까지 알림 발송을 중지한다.
const ATTENTION_NOTIFICATIONS_ENABLED = false;
let mainWindow = null;
let monitorWorker = null;
let runner = null;
let terminalManager = null;
let bridgeLauncher = null;
let backgroundTray = null;
let updateManager = null;
let attentionNotifier = null;
let isQuitting = false;
let appLocale = 'ko';
let providerVisibilityStore = null;
let pendingAttentionSessionId = '';
let rendererBootstrapped = false;
const tmuxController = new TmuxController({ platform: process.platform });
let availability = {};
let detailRequestId = 0;
const pendingDetails = new Map();
const MAIN_COPY = {
  ko: {
    trayTooltip: 'LoadToAgent · 백그라운드 터미널 {count}개',
    trayOpen: 'LoadToAgent 열기',
    traySessions: '백그라운드 터미널 {count}개 유지 중',
    trayQuit: '프로그램 끝내기 · 터미널 세션 유지',
    addWorkspaces: 'AI 작업 폴더 선택',
    pickWorkspace: '작업 폴더 선택',
    attentionTitle: '내 확인이 필요합니다',
    attentionBody: '{provider} · {title}',
    terminalHostReconnecting: '터미널 연결을 자동으로 복구하는 중입니다.',
    terminalHostReconnected: '터미널 연결을 복구했습니다.',
    terminalHostReconnectFailed: '터미널 연결을 복구하지 못했습니다: {reason}',
  },
  en: {
    trayTooltip: 'LoadToAgent · {count} background terminals',
    trayOpen: 'Open LoadToAgent',
    traySessions: '{count} background terminals active',
    trayQuit: 'Quit app · Keep terminal sessions',
    addWorkspaces: 'Choose AI workspaces',
    pickWorkspace: 'Choose workspace',
    attentionTitle: 'Your review is needed',
    attentionBody: '{provider} · {title}',
    terminalHostReconnecting: 'Restoring the terminal connection automatically.',
    terminalHostReconnected: 'Terminal connection restored.',
    terminalHostReconnectFailed: 'Could not restore the terminal connection: {reason}',
  },
  'zh-CN': {
    trayTooltip: 'LoadToAgent · {count} 个后台终端',
    trayOpen: '打开 LoadToAgent',
    traySessions: '正在保持 {count} 个后台终端',
    trayQuit: '退出应用 · 保留终端会话',
    addWorkspaces: '选择 AI 工作文件夹',
    pickWorkspace: '选择工作文件夹',
    attentionTitle: '需要你的确认',
    attentionBody: '{provider} · {title}',
    terminalHostReconnecting: '正在自动恢复终端连接。',
    terminalHostReconnected: '终端连接已恢复。',
    terminalHostReconnectFailed: '无法恢复终端连接：{reason}',
  },
};
let lastSnapshot = {
  generatedAt: new Date().toISOString(),
  sessions: [],
  automations: [],
  tmux: { generatedAt: new Date().toISOString(), available: false, status: '확인 중', distros: [], summary: { distros: 0, sessions: 0, windows: 0, panes: 0, aiPanes: 0, linked: 0 } },
  summary: {
    providers: providerList().map(provider => ({ ...provider, installed: false, sessions: 0, active: 0, waiting: 0, subagents: 0, usage: blankUsage() })),
    totals: { sessions: 0, active: 0, waiting: 0, subagents: 0, usage: blankUsage() },
  },
};

const isolatedTestInstance = process.env.LOADTOAGENT_TEST_INSTANCE === '1';
const bridgeHome = process.env.LOADTOAGENT_BRIDGE_HOME || os.homedir();
const singleInstance = isolatedTestInstance || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function userFile(name) {
  return path.join(app.getPath('userData'), name);
}

function mainText(key, values = {}) {
  const source = MAIN_COPY[appLocale]?.[key] || MAIN_COPY.ko[key] || key;
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), source);
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'"'"'`)}'`;
}

function installBridgeLauncher(home = bridgeHome) {
  const directory = path.join(home, '.loadtoagent', 'bin');
  fs.mkdirSync(directory, { recursive: true });
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', 'loadtoagent.js')
    : path.join(__dirname, 'bin', 'loadtoagent.js');
  if (process.platform === 'win32') {
    const launcher = path.join(directory, 'loadtoagent.cmd');
    const content = `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" "${script}" %*\r\n`;
    fs.writeFileSync(launcher, content, 'utf8');
    return { path: launcher, directory, commandPrefix: `& "${launcher}"`, simpleCommand: 'loadtoagent' };
  }
  const launcher = path.join(directory, 'loadtoagent');
  const content = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`;
  fs.writeFileSync(launcher, content, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
  return { path: launcher, directory, commandPrefix: shellQuote(launcher), simpleCommand: 'loadtoagent' };
}

function listWorkspaces() {
  return readWorkspaces(userFile('workspaces.json'));
}

function isProviderVisible(providerId) {
  return providerVisibilityStore ? providerVisibilityStore.isVisible(providerId) : true;
}

function loadProviderVisibility() {
  providerVisibilityStore = new ProviderVisibilityStore(
    userFile('provider-visibility.json'),
    providerList().map(provider => provider.id),
    error => reportRecoverableError('provider-visibility-load', error),
  );
  return providerVisibilityStore.load();
}

function saveProviderVisibility(value = {}) {
  if (!providerVisibilityStore) loadProviderVisibility();
  const saved = providerVisibilityStore.save(value);
  updateBackgroundTrayMenu();
  return saved;
}

function visibleSnapshotSessions(snapshot = lastSnapshot) {
  return { ...snapshot, sessions: (snapshot.sessions || []).filter(session => isProviderVisible(session.provider)) };
}

function saveWorkspaces(items) {
  return writeWorkspaces(userFile('workspaces.json'), items);
}

function listWslDistros() {
  if (process.platform === 'darwin') return ['macOS'];
  if (process.platform !== 'win32') return ['로컬'];
  try {
    return normalizeWslList(execFileSync('wsl.exe', ['--list', '--quiet'], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    }));
  } catch (error) {
    reportRecoverableError('wsl-distro-list', error);
    return [];
  }
}

function hydratePlatformPath() {
  if (process.platform !== 'darwin') return;
  process.env.PATH = macPathEntries(os.homedir(), process.env.PATH).join(path.delimiter);
}

function createWindow() {
  rendererBootstrapped = false;
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 360,
    minHeight: 520,
    title: 'LoadToAgent · AI Agent Observatory',
    backgroundColor: '#080b12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on('did-start-loading', () => { rendererBootstrapped = false; });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const allowedUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== allowedUrl) event.preventDefault(); });
  const showWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  };
  const showFallback = setTimeout(showWindow, 2_000);
  mainWindow.once('ready-to-show', () => {
    clearTimeout(showFallback);
    showWindow();
  });
  mainWindow.on('close', event => {
    if (isQuitting || !backgroundTerminalSessions().length) return;
    event.preventDefault();
    mainWindow.hide();
    ensureBackgroundTray();
  });
  mainWindow.on('closed', () => {
    clearTimeout(showFallback);
    mainWindow = null;
  });
}

function backgroundTerminalSessions() {
  if (!terminalManager) return [];
  return terminalManager.list().filter(session => !session.transient && (session.status === 'running' || session.status === 'starting'));
}

function visibleTerminalSessions(sessions) {
  return (sessions || []).filter(session => !session.transient && (session.type !== 'agent' || isProviderVisible(session.provider)));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateBackgroundTrayMenu() {
  if (!backgroundTray) return;
  const count = backgroundTerminalSessions().length;
  backgroundTray.setToolTip(mainText('trayTooltip', { count }));
  backgroundTray.setContextMenu(Menu.buildFromTemplate([
    { label: mainText('trayOpen'), click: showMainWindow },
    { label: mainText('traySessions', { count }), enabled: false },
    { type: 'separator' },
    { label: mainText('trayQuit'), click: () => { isQuitting = true; app.quit(); } },
  ]));
}

async function ensureBackgroundTray() {
  if (backgroundTray || isQuitting) return backgroundTray;
  try {
    const icon = await app.getFileIcon(process.execPath, { size: 'small' });
    if (isQuitting || backgroundTray) return backgroundTray;
    backgroundTray = new Tray(icon);
    backgroundTray.on('click', showMainWindow);
    backgroundTray.on('double-click', showMainWindow);
    updateBackgroundTrayMenu();
  } catch (error) {
    reportRecoverableError('background-tray', error);
  }
  return backgroundTray;
}

function trustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || !event || !event.sender || event.sender.id !== mainWindow.webContents.id) return false;
  const allowedUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  const senderUrl = event.senderFrame && event.senderFrame.url || event.sender.getURL();
  return senderUrl === allowedUrl;
}

function requireTrustedSender(event) {
  if (!trustedSender(event)) throw new Error('허용되지 않은 터미널 요청입니다.');
}

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    requireTrustedSender(event);
    return handler(...args);
  });
}

function sendTerminal(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send(channel, payload); } catch (error) { reportRecoverableError(`ipc-send:${channel}`, error); }
}

function refreshMonitor() {
  if (monitorWorker) monitorWorker.postMessage({ type: 'scan' });
}

function sendSnapshot(snapshot) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('agents:snapshot', snapshot); } catch (error) { reportRecoverableError('ipc-send:agents:snapshot', error); }
}

function openAttentionSession(session) {
  if (!isProviderVisible(session && session.provider)) return;
  pendingAttentionSessionId = String(session && session.id || '');
  showMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.flashFrame(false);
  if (!rendererBootstrapped || mainWindow.webContents.isLoadingMainFrame()) return;
  try {
    mainWindow.webContents.send('agents:attention-requested', { sessionId: pendingAttentionSessionId });
    pendingAttentionSessionId = '';
  } catch (error) {
    reportRecoverableError('ipc-send:agents:attention-requested', error);
  }
}

function markRendererReady() {
  rendererBootstrapped = true;
  if (!pendingAttentionSessionId || !mainWindow || mainWindow.isDestroyed()) return { ok: true };
  const sessionId = pendingAttentionSessionId;
  try {
    mainWindow.webContents.send('agents:attention-requested', { sessionId });
    pendingAttentionSessionId = '';
  } catch (error) {
    reportRecoverableError('ipc-send:agents:attention-requested', error);
  }
  return { ok: true };
}

function createAttentionNotifier() {
  return new AttentionNotifier({
    enabled: ATTENTION_NOTIFICATIONS_ENABLED,
    Notification,
    isSupported: () => Notification.isSupported(),
    copy: session => {
      const provider = providerList().find(item => item.id === session.provider);
      return {
        title: mainText('attentionTitle'),
        body: mainText('attentionBody', {
          provider: provider && provider.label || session.provider || 'AI',
          title: session.title || '이름 없는 세션',
        }),
      };
    },
    onOpen: openAttentionSession,
    onFallback: session => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
      openAttentionSession(session);
    },
  });
}

function sendUpdateState(update) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('app:update-state', update); } catch (error) { reportRecoverableError('ipc-send:app:update-state', error); }
}

function installationType() {
  if (app.isPackaged) return 'desktop';
  return fs.existsSync(path.join(__dirname, '.git')) ? 'source' : 'npm';
}

async function connectTerminalForStartup(timeoutMs = 4_000) {
  const connection = terminalManager.connect();
  let timedOut = false;
  let timer = null;
  connection.then(() => {
    if (!timedOut) return;
    const sessions = visibleTerminalSessions(terminalManager.list());
    sendTerminal('terminals:state', { change: 'reconnected', session: null, sessions });
    sendTerminal('terminals:connection', { state: 'connected', message: mainText('terminalHostReconnected') });
    updateBackgroundTrayMenu();
  }).catch(error => {
    if (timedOut) reportRecoverableError('terminal-host-late-connect', error);
  });
  try {
    await Promise.race([
      connection,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('터미널 호스트 연결을 백그라운드에서 계속합니다.'));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    reportRecoverableError('terminal-host-startup-connect', error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function installDownloadedUpdate() {
  if (!updateManager) throw new Error('업데이트 관리자가 준비되지 않았습니다.');
  const downloaded = await updateManager.download();
  const outcome = await launchDownloadedUpdate({
    platform: process.platform,
    installType: process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : installationType(),
    installerPath: downloaded.downloadedPath,
    downloadsDir: path.join(app.getPath('userData'), 'updates'),
    appPath: process.execPath,
    parentPid: process.pid,
    shell,
  });
  if (outcome.mode === 'automatic') {
    isQuitting = true;
    setImmediate(() => app.quit());
  }
  return { ...updateManager.getState(), installMode: outcome.mode };
}

async function setupRuntime() {
  loadProviderVisibility();
  const runsDir = userFile('agent-runs');
  runner = new AgentRunner({ runsDir });
  const terminalStoreFile = userFile('terminal-sessions.json');
  const terminalHostFile = userFile('terminal-host.json');
  terminalManager = demoCapture
    ? new TerminalManager({
      storeFile: terminalStoreFile,
      onPersistenceError: (operation, error) => reportRecoverableError(`terminal-sessions:${operation}`, error),
    })
    : new TerminalHostClient({
      discoveryFile: terminalHostFile,
      spawnHost: () => launchTerminalHost({
        executable: resolveTerminalHostExecutable({ isPackaged: app.isPackaged }),
        script: path.join(__dirname, 'src', 'terminalHostDaemon.js'),
        storeFile: terminalStoreFile,
        discoveryFile: terminalHostFile,
        bridgeHome,
      }),
    });
  updateManager = new UpdateManager({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    installType: installationType(),
    fetch: (...args) => net.fetch(...args),
    shell,
    downloadsDir: path.join(app.getPath('userData'), 'updates'),
  });
  updateManager.on('state', sendUpdateState);
  attentionNotifier = createAttentionNotifier();
  updateManager.check().catch(error => reportRecoverableError('startup-update-check', error));
  if (demoCapture) {
    availability = Object.fromEntries(providerList().map(provider => [provider.id, true]));
    return;
  }
  try {
    bridgeLauncher = installBridgeLauncher(bridgeHome);
  } catch (error) {
    bridgeLauncher = null;
    reportRecoverableError('bridge-launcher-install', error);
  }
  terminalManager.on('data', payload => sendTerminal('terminals:data', payload));
  terminalManager.on('state', payload => {
    if (!payload.session || (!payload.session.transient && (payload.session.type !== 'agent' || isProviderVisible(payload.session.provider)))) {
      sendTerminal('terminals:state', { ...payload, sessions: visibleTerminalSessions(payload.sessions) });
    }
    updateBackgroundTrayMenu();
    if (monitorWorker) monitorWorker.postMessage({ type: 'bridge-presence', bridges: bridgePresence() });
  });
  terminalManager.on('disconnect', () => {
    sendTerminal('terminals:connection', { state: 'reconnecting', message: mainText('terminalHostReconnecting') });
  });
  terminalManager.on('reconnect', payload => {
    const sessions = visibleTerminalSessions(payload?.sessions || terminalManager.list());
    sendTerminal('terminals:state', { change: 'reconnected', session: null, sessions });
    sendTerminal('terminals:connection', { state: 'connected', message: mainText('terminalHostReconnected') });
    updateBackgroundTrayMenu();
    if (monitorWorker) monitorWorker.postMessage({ type: 'bridge-presence', bridges: bridgePresence() });
  });
  terminalManager.on('reconnect-error', error => {
    sendTerminal('terminals:connection', {
      state: 'failed',
      message: mainText('terminalHostReconnectFailed', { reason: error?.message || String(error) }),
    });
  });
  await connectTerminalForStartup();
  availability = probeProviders();
  monitorWorker = new Worker(path.join(__dirname, 'src', 'monitorWorker.js'), {
    workerData: { runsDir, home: os.homedir(), intervalMs: 1200, availability },
  });
  monitorWorker.postMessage({ type: 'bridge-presence', bridges: bridgePresence() });
  monitorWorker.on('message', message => {
    if (message && message.type === 'snapshot') {
      lastSnapshot = message.snapshot;
      attentionNotifier.sync(visibleSnapshotSessions(lastSnapshot));
      sendSnapshot(lastSnapshot);
    }
    if (message && message.type === 'detail-result') {
      const pending = pendingDetails.get(message.requestId);
      if (pending) {
        pendingDetails.delete(message.requestId);
        pending.resolve(message.session);
      }
    }
  });
  monitorWorker.on('error', error => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agents:monitor-error', error.message);
  });
  runner.on('changed', () => monitorWorker && monitorWorker.postMessage({ type: 'scan' }));
}

function bridgePresence() {
  if (!terminalManager) return [];
  const localEnvironment = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
  return terminalManager.list()
    .filter(session => !session.transient && session.type === 'agent' && (session.status === 'running' || session.status === 'starting'))
    .map(session => ({
      id: session.bridgeId || session.id,
      bridgeId: session.bridgeId || '',
      linkedSessionId: session.bridgeId || '',
      terminalId: session.id,
      provider: session.provider,
      pid: session.pid,
      cwd: session.cwd,
      startedAt: session.createdAt,
      environment: session.distro && process.platform === 'win32' ? 'wsl' : localEnvironment,
      distro: session.distro || '',
      kind: 'bridge',
      label: 'LoadToAgent 외부 터미널 브리지',
    }));
}

/** @returns {import('./src/contracts').BootstrapPayload} */
function bootstrapState() {
  return {
    providers: providerList(),
    availability,
    workspaces: listWorkspaces(),
    snapshot: lastSnapshot,
    activeRuns: runner ? runner.listActive() : [],
    versions: { app: app.getVersion(), electron: process.versions.electron, node: process.versions.node },
    platform: {
      id: process.platform,
      label: process.platform === 'darwin' ? 'macOS' : (process.platform === 'win32' ? 'Windows' : 'Linux'),
      localShell: process.platform === 'win32' ? 'powershell' : 'shell',
      localShellLabel: process.platform === 'darwin' ? 'macOS shell' : (process.platform === 'win32' ? 'Windows PowerShell' : 'Linux shell'),
      nativeTmux: process.platform !== 'win32',
    },
    bridgeCli: bridgeLauncher,
    update: updateManager ? updateManager.getState() : null,
    providerVisibility: providerVisibilityStore ? providerVisibilityStore.snapshot() : { hidden: [] },
  };
}

function requestAgentDetail(sessionId) {
  return new Promise(resolve => {
    if (!monitorWorker || String(sessionId || '').length > 500) return resolve(null);
    const card = (lastSnapshot.sessions || []).find(session => session.id === String(sessionId || ''));
    if (card && !isProviderVisible(card.provider)) return resolve(null);
    const requestId = ++detailRequestId;
    const timer = setTimeout(() => {
      if (!pendingDetails.has(requestId)) return;
      pendingDetails.delete(requestId);
      resolve(null);
    }, 15000);
    pendingDetails.set(requestId, {
      resolve: value => {
        clearTimeout(timer);
        resolve(value);
      },
    });
    monitorWorker.postMessage({ type: 'detail', requestId, sessionId: String(sessionId || '') });
  });
}

function registerIpcHandlers() {
  registerAppIpc({
    handleTrusted,
    bootstrap: bootstrapState,
    rendererReady: markRendererReady,
    backgroundState: () => ({
      visible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
      backgroundSessions: backgroundTerminalSessions().length,
      trayReady: Boolean(backgroundTray),
    }),
    show: () => { showMainWindow(); return { ok: true }; },
    setLocale: locale => {
      appLocale = ['ko', 'en', 'zh-CN'].includes(locale) ? locale : 'ko';
      updateBackgroundTrayMenu();
      return { locale: appLocale };
    },
    setProviderVisibility: saveProviderVisibility,
    updateManager: () => updateManager,
    installUpdate: installDownloadedUpdate,
  });
  registerAgentIpc({
    handleTrusted,
    snapshot: () => { refreshMonitor(); return lastSnapshot; },
    requestDetail: requestAgentDetail,
    runner: () => runner,
    isProviderVisible,
    probeProviders: () => {
      availability = probeProviders();
      if (monitorWorker) monitorWorker.postMessage({ type: 'availability', availability });
      refreshMonitor();
      return availability;
    },
  });
  registerTerminalIpc({
    ipcMain,
    requireTrustedSender,
    trustedSender,
    manager: () => terminalManager,
    isProviderVisible,
    listWslDistros,
    sendError: payload => sendTerminal('terminals:error', payload),
  });
  registerTmuxIpc({ handleTrusted, controller: tmuxController, refresh: refreshMonitor });
  registerWorkspaceIpc({
    handleTrusted,
    list: listWorkspaces,
    add: async () => {
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'], title: mainText('addWorkspaces') });
      if (result.canceled) return listWorkspaces();
      return saveWorkspaces([...listWorkspaces(), ...result.filePaths.map(folder => ({ path: folder, name: path.basename(folder) }))]);
    },
    remove: folder => saveWorkspaces(removeWorkspace(listWorkspaces(), folder)),
    pick: async () => {
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: mainText('pickWorkspace') });
      return result.canceled ? null : result.filePaths[0];
    },
    openExternal: async target => {
      const value = String(target || '');
      if (!/^https:\/\//i.test(value)) return { ok: false };
      await shell.openExternal(value);
      return { ok: true };
    },
    writeClipboard: value => {
      clipboard.writeText(String(value || '').slice(0, 8_000));
      return { ok: true };
    },
    bridgeCommand: provider => {
      const id = String(provider || '').toLowerCase();
      if (!['claude', 'codex', 'gemini', 'grok'].includes(id)) return { ok: false };
      const prefix = bridgeLauncher && bridgeLauncher.commandPrefix || 'loadtoagent';
      return { ok: true, command: `${prefix} run ${id}`, launcher: bridgeLauncher };
    },
    openOrigin: async session => {
      const provider = String(session && session.provider || '');
      const externalId = String(session && session.externalId || '');
      const clientKind = String(session && session.clientKind || '');
      if (provider === 'codex' && clientKind === 'codex-desktop' && /^[0-9a-f-]{20,80}$/i.test(externalId)) {
        await shell.openExternal(`codex://threads/${encodeURIComponent(externalId)}`);
        return { ok: true };
      }
      if (provider === 'claude' && clientKind === 'claude-desktop') {
        await shell.openExternal('claude://');
        return { ok: true };
      }
      return { ok: false };
    },
  });
}

registerIpcHandlers();

app.whenReady().then(async () => {
  hydratePlatformPath();
  await setupRuntime();
  createWindow();
  app.on('activate', showMainWindow);
}).catch(error => {
  dialog.showErrorBox('LoadToAgent 시작 실패', error.stack || error.message || String(error));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (attentionNotifier) attentionNotifier.dispose();
  if (terminalManager instanceof TerminalHostClient) terminalManager.dispose({ shutdownIfIdle: true });
  else if (terminalManager) terminalManager.dispose({ preserveSessions: true });
  if (monitorWorker) {
    monitorWorker.postMessage({ type: 'stop' });
    monitorWorker.terminate();
  }
});

app.on('will-quit', () => {
  if (backgroundTray) backgroundTray.destroy();
  backgroundTray = null;
});
