'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, net, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fileURLToPath, pathToFileURL } = require('url');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const { AgentRunner, probeProviders } = require('./src/agentRunner');
const { snapshotWithoutSessions } = require('./src/agentMonitor');
const { providerList, blankUsage } = require('./src/providerRegistry');
const { collectProviderUsage } = require('./src/providerUsage');
const { TerminalManager } = require('./src/terminalManager');
const { TerminalHostClient, launchTerminalHost, resolveTerminalHostExecutable } = require('./src/terminalHost');
const { TmuxController } = require('./src/tmuxController');
const { normalizeWslList } = require('./src/tmuxMonitor');
const { UpdateManager } = require('./src/updateManager');
const {
  findInstalledDesktopApp,
  launchDownloadedUpdate,
  readDesktopAppVersion,
  verifyDownloadedInstaller,
} = require('./src/updateInstaller');
const {
  READY_PATH_ENV,
  READY_TOKEN_ENV,
  readUpdateRelaunchRequest,
  signalRendererReady,
} = require('./src/updateRelaunch');
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
const packageMetadata = require('./package.json');
const pendingUpdateRelaunch = readUpdateRelaunchRequest(process.env);
delete process.env[READY_PATH_ENV];
delete process.env[READY_TOKEN_ENV];

const PRODUCT_NAME = 'LoadToAgent';
const DEFAULT_LOCALE = 'en';
const MONITOR_INTERVAL_MS = 5_000;
const WSL_DISTRO_CACHE_MS = 60_000;
const ALLOW_UNSIGNED_WINDOWS_UPDATES = packageMetadata.loadToAgent?.distributionChannel === 'internal'
  && packageMetadata.loadToAgent?.allowUnsignedWindowsUpdates === true;
const ALLOW_UNSIGNED_MAC_UPDATES = packageMetadata.loadToAgent?.distributionChannel === 'internal'
  && packageMetadata.loadToAgent?.allowUnsignedMacUpdates === true;
app.setName(PRODUCT_NAME);
process.title = PRODUCT_NAME;
if (process.platform === 'win32') app.setAppUserModelId('com.wincube.loadtoagent');

const demoCapture = process.env.LOADTOAGENT_DEMO_CAPTURE === '1';
const DESKTOP_NOTIFICATIONS_ENABLED = true;
const UPDATE_HELPER_CANCELLATION_GUARD_MS = 65_000;
let mainWindow = null;
let monitorWorker = null;
let monitorWorkerConfig = null;
let monitorWorkerRestartTimer = null;
let monitorWorkerRestartAttempts = 0;
let runner = null;
let terminalManager = null;
let bridgeLauncher = null;
let backgroundTray = null;
let updateManager = null;
let updateInstallPromise = null;
let attentionNotifier = null;
let isQuitting = false;
let systemSessionEnding = false;
let updateHelperCancellationGuardUntil = 0;
let updateHelperCancellationNoticePending = false;
let quitCleanupPromise = null;
let quitCleanupComplete = false;
let appLocale = DEFAULT_LOCALE;
let providerVisibilityStore = null;
let pendingAttentionSessionId = '';
let pendingAttentionEvent = 'attention';
let rendererBootstrapped = false;
let wslDistroCache = { checkedAt: 0, values: [], pending: null };
const tmuxController = new TmuxController({
  platform: process.platform,
  deliveryStoreFile: () => userFile('tmux-deliveries.json'),
  onPersistenceError: (operation, error) => reportRecoverableError(`tmux-deliveries:${operation}`, error),
});
let availability = {};
let detailRequestId = 0;
const pendingDetails = new Map();
const pendingTerminalBindings = new Map();
let monitorSnapshotRevision = 0;
const MAIN_COPY = {
  ko: {
    trayTooltip: 'LoadToAgent · 뒤에서 실행 중인 작업 {count}개',
    trayOpen: 'LoadToAgent 열기',
    traySessions: '작업 {count}개가 뒤에서 실행 중',
    trayQuit: '프로그램 끝내기 · 명령창은 유지, 직접 실행은 중지',
    addWorkspaces: '추가할 프로젝트 폴더 선택',
    pickWorkspace: '작업 폴더 선택',
    attentionTitle: '확인 필요',
    attentionBody: '{provider} · {title}',
    completionTitle: '작업 완료',
    terminalHostReconnecting: '명령창 연결을 자동으로 복구하는 중입니다.',
    terminalHostReconnected: '명령창 연결을 복구했습니다.',
    terminalHostReconnectFailed: '명령창 연결 복구가 지연되고 있습니다. 자동으로 다시 시도합니다: {reason}',
    updateActiveTitle: '실행 중인 작업을 중단하고 업데이트할까요?',
    updateActiveMessage: '실행 중인 명령창 {terminalCount}개와 직접 실행 작업 {runCount}개가 있습니다.',
    updateActiveDetail: '업데이트를 계속하면 LoadToAgent와 명령창 연결 프로그램을 완전히 종료한 뒤 새 버전을 설치하고 다시 시작합니다. 관리형 명령창 작업은 분리해 유지하지만, 직접 실행 중인 작업은 중단되며 필요하면 업데이트 후 다시 시작해야 합니다.',
    updateLater: '나중에',
    updateNow: '업데이트하고 다시 시작',
    updateCancellationGuardTitle: '업데이트 도우미 종료를 확인하는 중입니다',
    updateCancellationGuardMessage: '지금은 LoadToAgent를 종료하지 마세요.',
    updateCancellationGuardDetail: '앱을 종료하지 않은 채 최소 60초 기다린 뒤 업데이트를 다시 시도해 주세요.',
    updateCancellationGuardConfirm: '확인',
  },
  en: {
    trayTooltip: 'LoadToAgent · {count} background tasks',
    trayOpen: 'Open LoadToAgent',
    traySessions: '{count} background tasks active',
    trayQuit: 'Quit · Keep terminals, stop direct runs',
    addWorkspaces: 'Choose a project folder to add',
    pickWorkspace: 'Choose workspace',
    attentionTitle: 'Confirmation needed',
    attentionBody: '{provider} · {title}',
    completionTitle: 'Task completed',
    terminalHostReconnecting: 'Restoring the terminal connection automatically.',
    terminalHostReconnected: 'Terminal connection restored.',
    terminalHostReconnectFailed: 'Terminal recovery is delayed and will retry automatically: {reason}',
    updateActiveTitle: 'Interrupt running work and update?',
    updateActiveMessage: '{terminalCount} terminal tasks and {runCount} direct runs are still active.',
    updateActiveDetail: 'Continuing will fully close LoadToAgent and its terminal host, install the new version, and restart the app. Managed terminal work is detached and kept running, but direct work is stopped and may need to be restarted after the update.',
    updateLater: 'Later',
    updateNow: 'Update and restart',
    updateCancellationGuardTitle: 'Waiting for the update helper to stop',
    updateCancellationGuardMessage: 'Do not quit LoadToAgent yet.',
    updateCancellationGuardDetail: 'Keep the app open for at least 60 seconds, then try the update again.',
    updateCancellationGuardConfirm: 'OK',
  },
  'zh-CN': {
    trayTooltip: 'LoadToAgent · {count} 个后台任务',
    trayOpen: '打开 LoadToAgent',
    traySessions: '正在保持 {count} 个后台任务',
    trayQuit: '退出 · 保留终端并停止直接运行',
    addWorkspaces: '选择要添加的项目文件夹',
    pickWorkspace: '选择工作文件夹',
    attentionTitle: '需要你的确认',
    attentionBody: '{provider} · {title}',
    completionTitle: '任务已完成',
    terminalHostReconnecting: '正在自动恢复终端连接。',
    terminalHostReconnected: '终端连接已恢复。',
    terminalHostReconnectFailed: '终端连接恢复延迟，将自动重试：{reason}',
    updateActiveTitle: '中断正在运行的任务并更新吗？',
    updateActiveMessage: '仍有 {terminalCount} 个终端任务和 {runCount} 个直接运行任务。',
    updateActiveDetail: '继续后将完全关闭 LoadToAgent 及终端连接程序，安装新版本并重新启动。受管理的终端任务会分离并继续运行，但直接运行的任务会停止，更新后可能需要重新启动。',
    updateLater: '稍后',
    updateNow: '更新并重新启动',
    updateCancellationGuardTitle: '正在确认更新助手已停止',
    updateCancellationGuardMessage: '现在请不要退出 LoadToAgent。',
    updateCancellationGuardDetail: '请保持应用打开至少 60 秒，然后再试一次更新。',
    updateCancellationGuardConfirm: '确定',
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

function readAppearanceTheme() {
  try {
    const saved = JSON.parse(fs.readFileSync(userFile('appearance.json'), 'utf8'));
    return saved && saved.theme === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function appearanceBackground(theme) {
  return theme === 'light' ? '#f6f3ed' : '#050506';
}

function setAppearanceTheme(value) {
  const theme = value === 'light' ? 'light' : 'dark';
  try {
    fs.writeFileSync(userFile('appearance.json'), JSON.stringify({ theme }), 'utf8');
  } catch (error) {
    reportRecoverableError('appearance-save', error);
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(appearanceBackground(theme));
  return { theme };
}

function mainText(key, values = {}) {
  const source = MAIN_COPY[appLocale]?.[key] || MAIN_COPY[DEFAULT_LOCALE][key] || key;
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
    const sourceMarker = app.isPackaged ? '' : 'set "LOADTOAGENT_SOURCE_LAUNCHER=1"\r\n';
    const content = `@echo off\r\n${sourceMarker}set "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" "${script}" %*\r\n`;
    fs.writeFileSync(launcher, content, 'utf8');
    return { path: launcher, directory, commandPrefix: `& "${launcher}"`, simpleCommand: 'loadtoagent' };
  }
  const launcher = path.join(directory, 'loadtoagent');
  const sourceMarker = app.isPackaged ? '' : 'LOADTOAGENT_SOURCE_LAUNCHER=1 ';
  const content = `#!/bin/sh\n${sourceMarker}ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`;
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
  sendSnapshot(visibleSnapshotSessions(lastSnapshot));
  return saved;
}

function visibleSnapshotSessions(snapshot = lastSnapshot) {
  return { ...snapshot, sessions: (snapshot.sessions || []).filter(session => isProviderVisible(session.provider)) };
}

function saveWorkspaces(items) {
  return writeWorkspaces(userFile('workspaces.json'), items);
}

function listWslDistros(force = false) {
  if (process.platform === 'darwin') return Promise.resolve(['macOS']);
  if (process.platform !== 'win32') return Promise.resolve(['로컬']);
  const now = Date.now();
  if (!force && wslDistroCache.checkedAt && now - wslDistroCache.checkedAt < WSL_DISTRO_CACHE_MS) {
    return Promise.resolve([...wslDistroCache.values]);
  }
  if (wslDistroCache.pending) return wslDistroCache.pending;
  const pending = new Promise(resolve => {
    execFile('wsl.exe', ['--list', '--quiet'], {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error) {
        reportRecoverableError('wsl-distro-list', error);
        wslDistroCache = { checkedAt: Date.now(), values: [], pending: null };
        resolve([]);
        return;
      }
      const values = normalizeWslList(stdout);
      wslDistroCache = { checkedAt: Date.now(), values, pending: null };
      resolve([...values]);
    });
  });
  wslDistroCache.pending = pending;
  return pending;
}

function hydratePlatformPath() {
  if (process.platform !== 'darwin') return;
  process.env.PATH = macPathEntries(os.homedir(), process.env.PATH).join(path.delimiter);
}

function reportAgentRunnerCleanupErrors(operation, result) {
  for (const item of result && Array.isArray(result.errors) ? result.errors : []) {
    reportRecoverableError(`${operation}:${item.runId || 'unknown-run'}`, new Error(item.error || '알 수 없는 종료 오류'));
  }
  return result;
}

function activateUpdateHelperCancellationGuard() {
  updateHelperCancellationGuardUntil = Math.max(
    updateHelperCancellationGuardUntil,
    Date.now() + UPDATE_HELPER_CANCELLATION_GUARD_MS,
  );
}

function updateHelperCancellationGuardActive() {
  return process.platform === 'win32'
    && !systemSessionEnding
    && Date.now() < updateHelperCancellationGuardUntil;
}

function showUpdateHelperCancellationGuard() {
  if (updateHelperCancellationNoticePending) return;
  updateHelperCancellationNoticePending = true;
  const options = {
    type: 'warning',
    title: mainText('updateCancellationGuardTitle'),
    message: mainText('updateCancellationGuardMessage'),
    detail: mainText('updateCancellationGuardDetail'),
    buttons: [mainText('updateCancellationGuardConfirm')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const prompt = mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
  Promise.resolve(prompt)
    .catch(error => reportRecoverableError('update-helper-cancellation-guard-dialog', error))
    .finally(() => { updateHelperCancellationNoticePending = false; });
}

function preventQuitDuringUpdateHelperCancellation(event) {
  if (!updateHelperCancellationGuardActive()) return false;
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  isQuitting = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  showUpdateHelperCancellationGuard();
  return true;
}

function requireAgentRunnerUpdateShutdown(result) {
  const errors = result && Array.isArray(result.errors) ? result.errors : [];
  reportAgentRunnerCleanupErrors('update-agent-runner', result);
  if (!errors.length) return result;
  const error = new Error(`업데이트 전에 직접 실행 작업의 종료를 확인하지 못했습니다. LoadToAgent를 다시 시작한 뒤 재시도해 주세요. (${errors.map(item => item.error || '알 수 없는 종료 오류').join('; ')})`);
  error.code = 'UPDATE_AGENT_RUNNER_SHUTDOWN_UNCONFIRMED';
  error.failures = errors;
  throw error;
}

function persistDirectRunsForWindowsSessionEnd() {
  systemSessionEnding = true;
  isQuitting = true;
  if (!runner) return;
  try {
    reportAgentRunnerCleanupErrors('windows-session-end-checkpoint', runner.prepareForSystemShutdown());
  } catch (error) {
    reportRecoverableError('windows-session-end-checkpoint', error);
  }
  try {
    Promise.resolve(runner.dispose()).then(
      result => reportAgentRunnerCleanupErrors('windows-session-end-cleanup', result),
      error => reportRecoverableError('windows-session-end-cleanup', error),
    );
  } catch (error) {
    reportRecoverableError('windows-session-end-cleanup', error);
  }
}

function createWindow() {
  rendererBootstrapped = false;
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 360,
    minHeight: 520,
    title: 'LoadToAgent · AI 작업 도우미',
    backgroundColor: appearanceBackground(readAppearanceTheme()),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
    if (preventQuitDuringUpdateHelperCancellation(event)) return;
    if (isQuitting || !backgroundWorkloadCount()) return;
    event.preventDefault();
    mainWindow.hide();
    ensureBackgroundTray();
  });
  if (process.platform === 'win32') {
    mainWindow.on('query-session-end', persistDirectRunsForWindowsSessionEnd);
    mainWindow.on('session-end', persistDirectRunsForWindowsSessionEnd);
  }
  mainWindow.on('closed', () => {
    clearTimeout(showFallback);
    mainWindow = null;
  });
}

function backgroundTerminalSessions() {
  if (!terminalManager) return [];
  return terminalManager.list().filter(session => !session.transient && (
    session.status === 'running'
    || session.status === 'starting'
    || session.status === 'detached'
  ));
}

function backgroundAgentRuns() {
  return runner ? runner.listActive() : [];
}

function backgroundWorkloadCount() {
  return backgroundTerminalSessions().length + backgroundAgentRuns().length;
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
  const count = backgroundWorkloadCount();
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
  const senderUrl = event.senderFrame && event.senderFrame.url || event.sender.getURL();
  try {
    const senderPath = path.resolve(fileURLToPath(senderUrl));
    const allowedPath = path.resolve(__dirname, 'renderer', 'index.html');
    if (process.platform === 'win32') return senderPath.toLowerCase() === allowedPath.toLowerCase();
    return senderPath === allowedPath;
  } catch {
    return false;
  }
}

function requireTrustedSender(event) {
  if (!trustedSender(event)) throw new Error('안전을 위해 이 명령창 요청을 차단했습니다.');
}

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    requireTrustedSender(event);
    return handler(...args);
  });
}

function sendTerminal(channel, payload) {
  // PTY output can arrive many times per second. During a renderer reload the
  // BrowserWindow may still exist while its frame is already disposed; trying
  // every send then floods diagnostics and blocks useful terminal work. The
  // renderer rehydrates from TerminalManager replay after markRendererReady.
  if (!mainWindow || mainWindow.isDestroyed() || !rendererBootstrapped) return;
  const contents = mainWindow.webContents;
  if (!contents || contents.isDestroyed() || contents.isLoadingMainFrame()) return;
  try { mainWindow.webContents.send(channel, payload); } catch (error) { reportRecoverableError(`ipc-send:${channel}`, error); }
}

function refreshMonitor() {
  if (monitorWorker) monitorWorker.postMessage({ type: 'scan' });
}

function sendSnapshot(snapshot) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('agents:snapshot', snapshot); } catch (error) { reportRecoverableError('ipc-send:agents:snapshot', error); }
}

function rejectPendingDetails() {
  for (const pending of pendingDetails.values()) pending.resolve(null);
  pendingDetails.clear();
}

function sendMonitorError(error) {
  const message = error && error.message || String(error || 'Unknown monitor worker error');
  reportRecoverableError('monitor-worker', error);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agents:monitor-error', message);
}

function scheduleMonitorWorkerRestart() {
  if (isQuitting || demoCapture || monitorWorkerRestartTimer || !monitorWorkerConfig) return;
  const delay = Math.min(30_000, 1_000 * (2 ** Math.min(monitorWorkerRestartAttempts, 5)));
  monitorWorkerRestartAttempts += 1;
  monitorWorkerRestartTimer = setTimeout(() => {
    monitorWorkerRestartTimer = null;
    startMonitorWorker();
  }, delay);
}

function persistInferredTerminalBindings(bindings) {
  const requested = Array.isArray(bindings) ? bindings : [];
  if (!requested.length) return Promise.resolve({ failedSessionIds: [] });
  if (!terminalManager || typeof terminalManager.bindAgentSession !== 'function') {
    return Promise.resolve({ failedSessionIds: requested.map(binding => String(binding?.sessionId || '')).filter(Boolean) });
  }
  const attempts = [];
  for (const binding of requested) {
    const terminalId = String(binding?.terminalId || '');
    const sessionId = String(binding?.sessionId || '');
    const promptFingerprint = String(binding?.promptFingerprint || '');
    if (!terminalId || !sessionId || !promptFingerprint) {
      attempts.push(Promise.resolve({ ok: false, sessionId }));
      continue;
    }
    const key = `${terminalId}\u0000${sessionId}\u0000${promptFingerprint}`;
    const existing = pendingTerminalBindings.get(key);
    if (existing) {
      attempts.push(existing);
      continue;
    }
    const attempt = Promise.resolve()
      .then(() => terminalManager.bindAgentSession(terminalId, binding))
      .then(() => ({ ok: true, sessionId }), error => {
        reportRecoverableError('terminal-inferred-binding', error);
        return { ok: false, sessionId };
      })
      .finally(() => {
        if (pendingTerminalBindings.get(key) === attempt) pendingTerminalBindings.delete(key);
      });
    pendingTerminalBindings.set(key, attempt);
    attempts.push(attempt);
  }
  return Promise.all(attempts).then(results => ({
    failedSessionIds: [...new Set(results.filter(result => !result.ok).map(result => result.sessionId).filter(Boolean))],
  }));
}

function startMonitorWorker() {
  if (isQuitting || demoCapture || !monitorWorkerConfig) return null;
  const worker = new Worker(path.join(__dirname, 'src', 'monitorWorker.js'), {
    workerData: { ...monitorWorkerConfig, bridges: bridgePresence() },
  });
  monitorWorker = worker;
  worker.on('message', message => {
    if (message && message.type === 'snapshot') {
      monitorWorkerRestartAttempts = 0;
      const revision = ++monitorSnapshotRevision;
      persistInferredTerminalBindings(message.bridgeBindings).then(bindingResult => {
        // The state event emitted by bindAgentSession reaches the renderer
        // before its RPC response. Publish only the newest monitor snapshot
        // after that response so drawer auto-mount cannot race ahead and spawn
        // a duplicate resume PTY. If one binding fails, hide only that unsafe
        // canonical card for this scan; unrelated sessions and their rebuilt
        // summary must continue updating.
        if (revision !== monitorSnapshotRevision || monitorWorker !== worker) return;
        lastSnapshot = snapshotWithoutSessions(message.snapshot, bindingResult.failedSessionIds, availability);
        const snapshot = visibleSnapshotSessions(lastSnapshot);
        attentionNotifier.sync(visibleSnapshotSessions(lastSnapshot));
        sendSnapshot(snapshot);
      }).catch(error => reportRecoverableError('monitor-snapshot-binding', error));
    }
    if (message && message.type === 'detail-result') {
      const pending = pendingDetails.get(message.requestId);
      if (pending) {
        pendingDetails.delete(message.requestId);
        pending.resolve(message.session);
      }
    }
  });
  worker.once('error', error => {
    worker.__loadtoagentErrorReported = true;
    if (monitorWorker === worker) monitorWorker = null;
    rejectPendingDetails();
    sendMonitorError(error);
    scheduleMonitorWorkerRestart();
  });
  worker.once('exit', code => {
    if (monitorWorker === worker) monitorWorker = null;
    if (isQuitting) return;
    if (code !== 0 && !worker.__loadtoagentErrorReported) sendMonitorError(new Error(`Monitor worker exited with code ${code}.`));
    rejectPendingDetails();
    scheduleMonitorWorkerRestart();
  });
  return worker;
}

function openAttentionSession(session, event = 'attention') {
  if (!isProviderVisible(session && session.provider)) return;
  pendingAttentionSessionId = String(session && session.id || '');
  pendingAttentionEvent = event === 'completed' ? 'completed' : 'attention';
  showMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.flashFrame(false);
  if (!rendererBootstrapped || mainWindow.webContents.isLoadingMainFrame()) return;
  try {
    mainWindow.webContents.send('agents:attention-requested', {
      sessionId: pendingAttentionSessionId,
      event: pendingAttentionEvent,
    });
    pendingAttentionSessionId = '';
    pendingAttentionEvent = 'attention';
  } catch (error) {
    reportRecoverableError('ipc-send:agents:attention-requested', error);
  }
}

async function markRendererReady() {
  rendererBootstrapped = true;
  if (pendingUpdateRelaunch) showMainWindow();
  if (pendingAttentionSessionId && mainWindow && !mainWindow.isDestroyed()) {
    const sessionId = pendingAttentionSessionId;
    const event = pendingAttentionEvent;
    try {
      mainWindow.webContents.send('agents:attention-requested', { sessionId, event });
      pendingAttentionSessionId = '';
      pendingAttentionEvent = 'attention';
    } catch (error) {
      reportRecoverableError('ipc-send:agents:attention-requested', error);
    }
  }
  const readiness = await signalRendererReady({
    request: pendingUpdateRelaunch,
    pid: process.pid,
    version: app.getVersion(),
  });
  return { ok: true, updateRelaunchReady: readiness.signaled };
}

function createAttentionNotifier() {
  return new AttentionNotifier({
    enabled: DESKTOP_NOTIFICATIONS_ENABLED,
    Notification,
    isSupported: () => Notification.isSupported(),
    copy: (session, event, detail) => {
      const provider = providerList().find(item => item.id === session.provider);
      const notificationDetail = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      return {
        title: mainText(event === 'completed' ? 'completionTitle' : 'attentionTitle'),
        body: mainText('attentionBody', {
          provider: provider && provider.label || session.provider || 'AI',
          title: event === 'completed'
            ? (session.title || '이름 없는 작업')
            : (notificationDetail || session.title || '이름 없는 작업'),
        }),
      };
    },
    onOpen: openAttentionSession,
    onFallback: (session, event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
      openAttentionSession(session, event);
    },
  });
}

function notifyTerminalPrompt(payload = {}) {
  const sessionId = String(payload.sessionId || '').slice(0, 500);
  const fingerprint = String(payload.fingerprint || '').slice(0, 1_000);
  const kind = String(payload.kind || '').slice(0, 120);
  if (!attentionNotifier || !sessionId || !fingerprint) return { ok: false, notified: false };
  const session = (lastSnapshot.sessions || []).find(item => String(item.id || '') === sessionId);
  if (!session || !isProviderVisible(session.provider)) return { ok: false, notified: false };
  const notification = attentionNotifier.notifyExplicitPrompt(session, {
    fingerprint,
    kind,
    title: String(payload.title || '').slice(0, 240),
  });
  return { ok: true, notified: Boolean(notification) };
}

function sendUpdateState(update) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('app:update-state', update); } catch (error) { reportRecoverableError('ipc-send:app:update-state', error); }
}

function installationType() {
  if (app.isPackaged) return 'desktop';
  return fs.existsSync(path.join(__dirname, '.git')) ? 'source' : 'npm';
}

function currentInstallType() {
  return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : installationType();
}

async function updateInstallPlan() {
  const sourceInstallType = currentInstallType();
  const desktopAppPath = await findInstalledDesktopApp({
    platform: process.platform,
    installType: sourceInstallType,
    appPath: process.execPath,
  });
  const automatic = Boolean(desktopAppPath) && (process.platform === 'win32' || process.platform === 'darwin');
  return {
    sourceInstallType,
    installType: automatic ? 'desktop' : sourceInstallType,
    installMode: automatic ? 'automatic' : 'manual',
    appPath: automatic ? desktopAppPath : process.execPath,
  };
}

async function updateWorkloadImpact() {
  let sessions = [];
  if (terminalManager instanceof TerminalHostClient) sessions = await terminalManager.listFresh();
  else if (terminalManager && typeof terminalManager.list === 'function') sessions = terminalManager.list();
  return {
    terminalSessions: sessions.filter(session => ['running', 'starting', 'stopping'].includes(session.status)),
    agentRuns: backgroundAgentRuns(),
  };
}

async function confirmActiveTerminalUpdate(impact) {
  const terminalCount = impact.terminalSessions.length;
  const runCount = impact.agentRuns.length;
  if (!terminalCount && !runCount) return true;
  const options = {
    type: 'warning',
    title: mainText('updateActiveTitle'),
    message: mainText('updateActiveMessage', { terminalCount, runCount }),
    detail: mainText('updateActiveDetail'),
    buttons: [mainText('updateLater'), mainText('updateNow')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function connectTerminalForStartup(timeoutMs = 4_000) {
  const connection = terminalManager.connect();
  let timedOut = false;
  let timer = null;
  connection.then(() => {
    const sessions = visibleTerminalSessions(terminalManager.list());
    sendTerminal('terminals:state', { change: timedOut ? 'reconnected' : 'connected', session: null, sessions });
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
          reject(new Error('명령창 연결을 뒤에서 계속합니다.'));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    reportRecoverableError('terminal-host-startup-connect', error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function performDownloadedUpdateInstall() {
  if (!updateManager) throw new Error('업데이트 기능이 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
  const downloaded = await updateManager.download();
  const installPlan = await updateInstallPlan();
  const launchOptions = {
    platform: process.platform,
    installType: installPlan.installType,
    installerPath: downloaded.downloadedPath,
    downloadsDir: path.join(app.getPath('userData'), 'updates'),
    appPath: installPlan.appPath,
    expectedVersion: downloaded.latestVersion,
    parentPid: process.pid,
    shell,
    allowUnsignedWindowsUpdates: ALLOW_UNSIGNED_WINDOWS_UPDATES,
    allowUnsignedMacUpdates: ALLOW_UNSIGNED_MAC_UPDATES,
  };
  let terminalShutdownAttempted = false;
  let agentRunnerPrepared = false;
  if (installPlan.installMode === 'automatic') {
    const impact = await updateWorkloadImpact();
    if (!await confirmActiveTerminalUpdate(impact)) {
      return { ...updateManager.getState(), installMode: 'automatic', installCanceled: true };
    }
    launchOptions.beforeAutomaticInstall = async () => {
      if (runner) {
        runner.prepareForUpdate(impact.agentRuns);
        agentRunnerPrepared = true;
        requireAgentRunnerUpdateShutdown(await runner.dispose());
      }
      terminalShutdownAttempted = true;
      if (terminalManager instanceof TerminalHostClient) {
        await terminalManager.shutdownForUpdate(impact.terminalSessions);
      } else if (terminalManager) {
        await terminalManager.dispose({ preserveSessions: true });
      }
    };
  }
  let outcome;
  try {
    outcome = await launchDownloadedUpdate(launchOptions);
  } catch (error) {
    let failure = error;
    const cancellationUnconfirmed = error?.code === 'UPDATE_HELPER_CANCELLATION_UNCONFIRMED';
    if (cancellationUnconfirmed) {
      activateUpdateHelperCancellationGuard();
      const guardedError = new Error(`${error.message} 앱을 종료하지 않은 채 최소 60초 기다린 뒤 업데이트를 다시 시도해 주세요.`);
      guardedError.code = error.code;
      guardedError.cause = error;
      failure = guardedError;
    }
    if (agentRunnerPrepared && runner && !runner.resumeAfterUpdateFailure()) {
      if (!cancellationUnconfirmed) {
        const stoppedError = new Error(`${error.message} 직접 실행 작업 기능은 안전을 위해 중지된 상태입니다. LoadToAgent를 다시 시작해 주세요.`);
        stoppedError.code = error.code || 'UPDATE_AGENT_RUNNER_RESTART_REQUIRED';
        stoppedError.cause = error;
        failure = stoppedError;
      }
      reportRecoverableError('update-agent-runner-remains-stopped', failure);
    }
    if (terminalShutdownAttempted && terminalManager instanceof TerminalHostClient) {
      terminalManager.recoverAfterUpdateFailure()
        .catch(reconnectError => reportRecoverableError('update-terminal-host-recover', reconnectError));
    }
    throw failure;
  }
  if (outcome.mode === 'automatic') {
    isQuitting = true;
    setImmediate(() => app.quit());
  } else if (terminalShutdownAttempted && terminalManager instanceof TerminalHostClient) {
    terminalManager.recoverAfterUpdateFailure()
      .catch(error => reportRecoverableError('update-terminal-host-recover', error));
  }
  return { ...updateManager.getState(), installMode: outcome.mode };
}

function installDownloadedUpdate() {
  if (updateInstallPromise) return updateInstallPromise;
  updateInstallPromise = performDownloadedUpdateInstall().then(result => {
    if (result.installMode !== 'automatic' || result.installCanceled) updateInstallPromise = null;
    return result;
  }, error => {
    updateInstallPromise = null;
    throw error;
  });
  return updateInstallPromise;
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
  if (!demoCapture) {
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
    // Start the host before update discovery and provider probing. Terminal IPC
    // can reuse this same in-flight connection without delaying the first window.
    connectTerminalForStartup();
  }
  const installPlan = await updateInstallPlan();
  let updateCurrentVersion = app.getVersion();
  let updateCurrentVersionKnown = true;
  let updateBlockedReason = '';
  if (installPlan.installMode === 'automatic' && ['source', 'npm'].includes(installPlan.sourceInstallType)) {
    try {
      const installedVersion = await readDesktopAppVersion({
        platform: process.platform,
        appPath: installPlan.appPath,
      });
      if (installedVersion) updateCurrentVersion = installedVersion;
      else throw new Error('설치된 데스크톱 앱의 버전을 확인하지 못했습니다.');
    } catch (error) {
      updateCurrentVersionKnown = false;
      updateBlockedReason = '설치된 데스크톱 앱의 버전을 확인할 수 없어 안전하게 업데이트할 수 없습니다.';
      reportRecoverableError('installed-app-version', error);
    }
  }
  updateManager = new UpdateManager({
    currentVersion: updateCurrentVersion,
    platform: process.platform,
    arch: process.arch,
    installType: installPlan.sourceInstallType,
    targetInstallType: installPlan.installType,
    installMode: installPlan.installMode,
    currentVersionKnown: updateCurrentVersionKnown,
    blockedReason: updateBlockedReason,
    fetch: (...args) => net.fetch(...args),
    shell,
    downloadsDir: path.join(app.getPath('userData'), 'updates'),
    verifyInstaller: installerPath => verifyDownloadedInstaller({
      installerPath,
      platform: process.platform,
      allowUnsignedWindowsUpdates: ALLOW_UNSIGNED_WINDOWS_UPDATES,
      allowUnsignedMacUpdates: ALLOW_UNSIGNED_MAC_UPDATES,
    }),
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
  availability = probeProviders();
  monitorWorkerConfig = { runsDir, home: os.homedir(), intervalMs: MONITOR_INTERVAL_MS, availability };
  startMonitorWorker();
  runner.on('changed', () => {
    if (monitorWorker) monitorWorker.postMessage({ type: 'scan' });
    updateBackgroundTrayMenu();
  });
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
      initialPromptFingerprint: session.initialPromptFingerprint || '',
      kind: 'bridge',
      label: 'LoadToAgent 외부 명령창 연결',
    }));
}

/** @returns {import('./src/contracts').BootstrapPayload} */
function bootstrapState() {
  return {
    providers: providerList(),
    availability,
    workspaces: listWorkspaces(),
    snapshot: visibleSnapshotSessions(lastSnapshot),
    activeRuns: runner ? runner.listActive() : [],
    versions: { app: app.getVersion(), electron: process.versions.electron, node: process.versions.node },
    platform: {
      id: process.platform,
      label: process.platform === 'darwin' ? 'macOS' : (process.platform === 'win32' ? 'Windows' : 'Linux'),
      computerName: os.hostname(),
      localShell: process.platform === 'win32' ? 'powershell' : 'shell',
      localShellLabel: process.platform === 'darwin' ? 'macOS 명령창' : (process.platform === 'win32' ? 'Windows 명령창' : 'Linux 명령창'),
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
      backgroundSessions: backgroundWorkloadCount(),
      backgroundTerminals: backgroundTerminalSessions().length,
      backgroundRuns: backgroundAgentRuns().length,
      trayReady: Boolean(backgroundTray),
    }),
    show: () => { showMainWindow(); return { ok: true }; },
    setLocale: locale => {
      appLocale = ['ko', 'en', 'zh-CN'].includes(locale) ? locale : DEFAULT_LOCALE;
      updateBackgroundTrayMenu();
      return { locale: appLocale };
    },
    setThemeAppearance: setAppearanceTheme,
    setProviderVisibility: saveProviderVisibility,
    notifyAttentionPrompt: notifyTerminalPrompt,
    updateManager: () => updateManager,
    installUpdate: installDownloadedUpdate,
  });
  registerAgentIpc({
    handleTrusted,
    snapshot: () => { refreshMonitor(); return visibleSnapshotSessions(lastSnapshot); },
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
  handleTrusted('providers:usage', options => collectProviderUsage(options || {}));
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
      const current = listWorkspaces();
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: mainText('addWorkspaces') });
      if (result.canceled || !result.filePaths[0]) {
        return { canceled: true, workspaces: current, selected: null, alreadyAdded: false };
      }
      const selectedPath = path.resolve(result.filePaths[0]);
      const selectedKey = process.platform === 'win32' ? selectedPath.toLowerCase() : selectedPath;
      const alreadyAdded = current.some(item => {
        const itemPath = path.resolve(item.path);
        return (process.platform === 'win32' ? itemPath.toLowerCase() : itemPath) === selectedKey;
      });
      const workspaces = saveWorkspaces([
        ...current,
        { path: selectedPath, name: path.basename(selectedPath) },
      ]);
      const selected = workspaces.find(item => {
        const itemPath = path.resolve(item.path);
        return (process.platform === 'win32' ? itemPath.toLowerCase() : itemPath) === selectedKey;
      }) || { path: selectedPath, name: path.basename(selectedPath) };
      return { canceled: false, workspaces, selected, alreadyAdded };
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
  const runtimeSetup = setupRuntime();
  createWindow();
  await runtimeSetup;
  app.on('activate', showMainWindow);
}).catch(error => {
  console.error(error);
  dialog.showErrorBox('LoadToAgent 시작 실패', 'LoadToAgent를 시작하지 못했습니다. 프로그램을 다시 실행해 주세요.');
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (backgroundWorkloadCount()) {
    ensureBackgroundTray();
    return;
  }
  app.quit();
});

function quitCleanupTask(operation, action) {
  try {
    return Promise.resolve(action()).catch(error => reportRecoverableError(`before-quit:${operation}`, error));
  } catch (error) {
    reportRecoverableError(`before-quit:${operation}`, error);
    return Promise.resolve();
  }
}

async function cleanupBeforeQuit() {
  await Promise.all([
    quitCleanupTask('agent-runner', () => runner && runner.dispose())
      .then(result => reportAgentRunnerCleanupErrors('before-quit:agent-runner', result)),
    quitCleanupTask('attention-notifier', () => attentionNotifier && attentionNotifier.dispose()),
    quitCleanupTask('terminal-manager', () => {
      if (terminalManager instanceof TerminalHostClient) return terminalManager.dispose({ shutdownIfIdle: true });
      if (terminalManager) return terminalManager.dispose({ preserveSessions: true });
      return null;
    }),
    quitCleanupTask('monitor-worker', () => {
      if (!monitorWorker) return;
      monitorWorker.postMessage({ type: 'stop' });
      return monitorWorker.terminate();
    }),
    quitCleanupTask('monitor-restart-timer', () => {
      if (monitorWorkerRestartTimer) clearTimeout(monitorWorkerRestartTimer);
      monitorWorkerRestartTimer = null;
    }),
  ]);
}

app.on('before-quit', event => {
  if (preventQuitDuringUpdateHelperCancellation(event)) return;
  isQuitting = true;
  if (quitCleanupComplete) return;
  event.preventDefault();
  if (quitCleanupPromise) return;
  quitCleanupPromise = cleanupBeforeQuit()
    .catch(error => reportRecoverableError('before-quit-cleanup', error))
    .then(() => {
      quitCleanupComplete = true;
      setImmediate(() => app.quit());
    });
});

app.on('will-quit', () => {
  if (backgroundTray) backgroundTray.destroy();
  backgroundTray = null;
});
