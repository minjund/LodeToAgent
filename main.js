'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { Worker } = require('worker_threads');
const { execFileSync } = require('child_process');
const { AgentRunner, probeProviders } = require('./src/agentRunner');
const { providerList, blankUsage } = require('./src/providerRegistry');
const { TerminalManager } = require('./src/terminalManager');
const { TmuxController } = require('./src/tmuxController');
const { normalizeWslList } = require('./src/tmuxMonitor');
const { BridgeServer } = require('./src/bridgeServer');

let mainWindow = null;
let monitorWorker = null;
let runner = null;
let terminalManager = null;
let bridgeServer = null;
let bridgeLauncher = null;
const tmuxController = new TmuxController({ platform: process.platform });
let availability = {};
let detailRequestId = 0;
const pendingDetails = new Map();
let lastSnapshot = {
  generatedAt: new Date().toISOString(),
  sessions: [],
  tmux: { generatedAt: new Date().toISOString(), available: false, status: '확인 중', distros: [], summary: { distros: 0, sessions: 0, windows: 0, panes: 0, aiPanes: 0, linked: 0 } },
  summary: {
    providers: providerList().map(provider => ({ ...provider, installed: false, sessions: 0, active: 0, waiting: 0, subagents: 0, usage: blankUsage() })),
    totals: { sessions: 0, active: 0, waiting: 0, subagents: 0, usage: blankUsage() },
  },
};

const singleInstance = app.requestSingleInstanceLock();
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

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  } catch {}
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'"'"'`)}'`;
}

function installBridgeLauncher() {
  const directory = path.join(os.homedir(), '.lodestar', 'bin');
  fs.mkdirSync(directory, { recursive: true });
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', 'lodestar.js')
    : path.join(__dirname, 'bin', 'lodestar.js');
  if (process.platform === 'win32') {
    const launcher = path.join(directory, 'lodestar.cmd');
    const content = `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" "${script}" %*\r\n`;
    fs.writeFileSync(launcher, content, 'utf8');
    return { path: launcher, directory, commandPrefix: `& "${launcher}"`, simpleCommand: 'lodestar' };
  }
  const launcher = path.join(directory, 'lodestar');
  const content = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`;
  fs.writeFileSync(launcher, content, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
  return { path: launcher, directory, commandPrefix: shellQuote(launcher), simpleCommand: 'lodestar' };
}

function listWorkspaces() {
  return readJson(userFile('workspaces.json'), [])
    .filter(item => item && item.path && fs.existsSync(item.path))
    .map(item => ({ ...item, name: item.name || path.basename(item.path) }));
}

function saveWorkspaces(items) {
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    const target = path.resolve(String(item.path || ''));
    const key = target.toLowerCase();
    if (!target || seen.has(key) || !fs.existsSync(target)) continue;
    seen.add(key);
    unique.push({ path: target, name: item.name || path.basename(target) });
  }
  writeJson(userFile('workspaces.json'), unique);
  return unique;
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
  } catch {
    return [];
  }
}

function hydratePlatformPath() {
  if (process.platform !== 'darwin') return;
  const additions = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
  try {
    const shellPath = process.env.SHELL || '/bin/zsh';
    const loginPath = execFileSync(shellPath, ['-lic', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5_000 }).trim();
    additions.unshift(...loginPath.split(path.delimiter));
  } catch {}
  process.env.PATH = [...new Set([...additions, ...String(process.env.PATH || '').split(path.delimiter)].filter(Boolean))].join(path.delimiter);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1080,
    minHeight: 700,
    title: 'Lodestar · AI Agent Observatory',
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
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const allowedUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== allowedUrl) event.preventDefault(); });
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
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

function sendTerminal(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send(channel, payload); } catch {}
}

function refreshMonitor() {
  if (monitorWorker) monitorWorker.postMessage({ type: 'scan' });
}

function sendSnapshot(snapshot) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('agents:snapshot', snapshot); } catch {}
}

function setupRuntime() {
  const runsDir = userFile('agent-runs');
  runner = new AgentRunner({ runsDir });
  terminalManager = new TerminalManager();
  try { bridgeLauncher = installBridgeLauncher(); } catch { bridgeLauncher = null; }
  terminalManager.on('data', payload => sendTerminal('terminals:data', payload));
  terminalManager.on('state', payload => {
    sendTerminal('terminals:state', payload);
    if (monitorWorker) monitorWorker.postMessage({ type: 'bridge-presence', bridges: bridgePresence() });
  });
  bridgeServer = new BridgeServer({ terminalManager, home: os.homedir(), platform: process.platform });
  bridgeServer.start().catch(error => sendTerminal('terminals:error', { id: '', message: `외부 터미널 브리지를 열지 못했습니다: ${error.message}` }));
  availability = probeProviders();
  monitorWorker = new Worker(path.join(__dirname, 'src', 'monitorWorker.js'), {
    workerData: { runsDir, home: os.homedir(), intervalMs: 1200, availability },
  });
  monitorWorker.postMessage({ type: 'bridge-presence', bridges: bridgePresence() });
  monitorWorker.on('message', message => {
    if (message && message.type === 'snapshot') {
      lastSnapshot = message.snapshot;
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
  const environment = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
  return terminalManager.list()
    .filter(session => session.type === 'agent' && session.status === 'running')
    .map(session => ({
      id: session.bridgeId || session.id,
      bridgeId: session.bridgeId || '',
      terminalId: session.id,
      provider: session.provider,
      pid: session.pid,
      cwd: session.cwd,
      startedAt: session.createdAt,
      environment,
      kind: 'bridge',
      label: 'Lodestar 외부 터미널 브리지',
    }));
}

ipcMain.handle('app:bootstrap', () => ({
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
    localShellLabel: process.platform === 'darwin' ? 'Mac 명령창' : (process.platform === 'win32' ? 'Windows 명령창' : 'Linux 명령창'),
    nativeTmux: process.platform !== 'win32',
  },
  bridgeCli: bridgeLauncher,
}));

ipcMain.handle('agents:snapshot', () => {
  if (monitorWorker) monitorWorker.postMessage({ type: 'scan' });
  return lastSnapshot;
});
ipcMain.handle('agents:detail', (_event, sessionId) => new Promise(resolve => {
  if (!monitorWorker) return resolve(null);
  const requestId = ++detailRequestId;
  const timer = setTimeout(() => {
    const pending = pendingDetails.get(requestId);
    if (!pending) return;
    pendingDetails.delete(requestId);
    resolve(null);
  }, 4000);
  pendingDetails.set(requestId, {
    resolve: value => {
      clearTimeout(timer);
      resolve(value);
    },
  });
  monitorWorker.postMessage({ type: 'detail', requestId, sessionId: String(sessionId || '') });
}));
ipcMain.handle('agents:run', (_event, opts) => runner.start(opts));
ipcMain.handle('agents:stop', (_event, runId) => runner.stop(runId));
ipcMain.handle('agents:active-runs', () => runner.listActive());
ipcMain.handle('providers:probe', () => {
  availability = probeProviders();
  if (monitorWorker) monitorWorker.postMessage({ type: 'availability', availability });
  if (monitorWorker) monitorWorker.postMessage({ type: 'scan' });
  return availability;
});

ipcMain.handle('terminals:list', event => {
  requireTrustedSender(event);
  return terminalManager ? terminalManager.list() : [];
});
ipcMain.handle('wsl:list-distros', event => {
  requireTrustedSender(event);
  return listWslDistros();
});
ipcMain.handle('terminals:get', (event, id) => {
  requireTrustedSender(event);
  return terminalManager ? terminalManager.get(id, true) : null;
});
ipcMain.handle('terminals:create', (event, options) => {
  requireTrustedSender(event);
  if (!terminalManager) throw new Error('터미널 관리자가 준비되지 않았습니다.');
  return terminalManager.create(options || {});
});
ipcMain.on('terminals:write', (event, id, data) => {
  if (!trustedSender(event) || !terminalManager) return;
  try { terminalManager.write(id, data); } catch (error) { sendTerminal('terminals:error', { id: String(id || ''), message: error.message }); }
});
ipcMain.handle('terminals:command', (event, id, command) => {
  requireTrustedSender(event);
  return terminalManager.command(id, command);
});
ipcMain.on('terminals:resize', (event, id, cols, rows) => {
  if (!trustedSender(event) || !terminalManager) return;
  try { terminalManager.resize(id, cols, rows); } catch {}
});
ipcMain.handle('terminals:signal', (event, id, signal) => {
  requireTrustedSender(event);
  return terminalManager.signal(id, signal);
});
ipcMain.handle('terminals:restart', (event, id) => {
  requireTrustedSender(event);
  return terminalManager.restart(id);
});
ipcMain.handle('terminals:close', (event, id) => {
  requireTrustedSender(event);
  return terminalManager.close(id);
});

ipcMain.handle('tmux:send-text', async (event, options) => {
  requireTrustedSender(event);
  return tmuxController.sendText(options || {});
});
ipcMain.handle('tmux:send-key', async (event, options) => {
  requireTrustedSender(event);
  return tmuxController.sendKey(options || {});
});
ipcMain.handle('tmux:capture', async (event, options) => {
  requireTrustedSender(event);
  return tmuxController.capture(options || {});
});
ipcMain.handle('tmux:new-session', async (event, options) => {
  requireTrustedSender(event);
  const result = await tmuxController.newSession(options || {});
  refreshMonitor();
  return result;
});
ipcMain.handle('tmux:new-window', async (event, options) => {
  requireTrustedSender(event);
  const result = await tmuxController.newWindow(options || {});
  refreshMonitor();
  return result;
});
ipcMain.handle('tmux:split-pane', async (event, options) => {
  requireTrustedSender(event);
  const result = await tmuxController.splitPane(options || {});
  refreshMonitor();
  return result;
});
ipcMain.handle('tmux:rename-session', async (event, options) => {
  requireTrustedSender(event);
  const result = await tmuxController.renameSession(options || {});
  refreshMonitor();
  return result;
});
ipcMain.handle('tmux:rename-window', async (event, options) => {
  requireTrustedSender(event);
  const result = await tmuxController.renameWindow(options || {});
  refreshMonitor();
  return result;
});
ipcMain.handle('tmux:select-layout', async (event, options) => {
  requireTrustedSender(event);
  const result = await tmuxController.selectLayout(options || {});
  refreshMonitor();
  return result;
});
ipcMain.handle('tmux:kill-pane', async (event, options) => {
  requireTrustedSender(event);
  const result = await tmuxController.killPane(options || {});
  refreshMonitor();
  return result;
});
ipcMain.handle('tmux:kill-window', async (event, options) => {
  requireTrustedSender(event);
  const result = await tmuxController.killWindow(options || {});
  refreshMonitor();
  return result;
});
ipcMain.handle('tmux:kill-session', async (event, options) => {
  requireTrustedSender(event);
  const result = await tmuxController.killSession(options || {});
  refreshMonitor();
  return result;
});

ipcMain.handle('workspaces:list', () => listWorkspaces());
ipcMain.handle('workspaces:add', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'], title: 'AI 작업 폴더 선택' });
  if (result.canceled) return listWorkspaces();
  return saveWorkspaces([...listWorkspaces(), ...result.filePaths.map(folder => ({ path: folder, name: path.basename(folder) }))]);
});
ipcMain.handle('workspaces:remove', (_event, folder) => saveWorkspaces(listWorkspaces().filter(item => path.resolve(item.path) !== path.resolve(String(folder || '')))));
ipcMain.handle('workspaces:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '작업 폴더 선택' });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('external:open', (_event, target) => {
  const value = String(target || '');
  if (!/^https:\/\//i.test(value)) return { ok: false };
  shell.openExternal(value);
  return { ok: true };
});
ipcMain.handle('clipboard:write', (event, value) => {
  requireTrustedSender(event);
  clipboard.writeText(String(value || '').slice(0, 8_000));
  return { ok: true };
});
ipcMain.handle('bridge:command', (event, provider) => {
  requireTrustedSender(event);
  const id = String(provider || '').toLowerCase();
  if (!['claude', 'codex', 'gemini', 'grok'].includes(id)) return { ok: false };
  const prefix = bridgeLauncher && bridgeLauncher.commandPrefix || 'lodestar';
  return { ok: true, command: `${prefix} run ${id}`, launcher: bridgeLauncher };
});
ipcMain.handle('agents:open-origin', async (event, session) => {
  requireTrustedSender(event);
  const provider = String(session && session.provider || '');
  const externalId = String(session && session.externalId || '');
  const clientKind = String(session && session.clientKind || '');
  if (provider !== 'codex' || clientKind !== 'codex-desktop' || !/^[0-9a-f-]{20,80}$/i.test(externalId)) return { ok: false };
  await shell.openExternal(`codex://threads/${encodeURIComponent(externalId)}`);
  return { ok: true };
});

app.whenReady().then(() => {
  hydratePlatformPath();
  setupRuntime();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (bridgeServer) bridgeServer.dispose();
  if (terminalManager) terminalManager.dispose();
  if (monitorWorker) {
    monitorWorker.postMessage({ type: 'stop' });
    monitorWorker.terminate();
  }
});
