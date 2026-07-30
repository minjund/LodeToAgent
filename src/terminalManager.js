'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn: spawnChild } = require('child_process');
const { runBestEffort } = require('./diagnostics');
const { ManagedTmuxRuntime } = require('./managedTmuxRuntime');
const { ensureMacNodePtyRuntime } = require('./nodePtyRuntime');
const {
  retentionDays,
  shouldRetainTerminalSession,
  restrictPathPermissions,
} = require('./dataRetention');

const MAX_SESSIONS = 24;
const MAX_INPUT_CHARS = 128 * 1024;
const MAX_REPLAY_CHARS = 2 * 1024 * 1024;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const STORE_VERSION = 2;
const PERSIST_DELAY_MS = 150;
const TERMINAL_TYPES = new Set(['powershell', 'cmd', 'shell', 'wsl', 'tmux', 'agent']);
const SESSION_BACKENDS = new Set(['direct', 'managed-tmux']);
const DEFAULT_TMUX_SOCKET = 'loadtoagent';
const AGENT_PROVIDERS = Object.freeze({
  claude: { command: 'claude', label: 'Claude' },
  codex: { command: 'codex', label: 'GPT · Codex' },
  gemini: { command: 'gemini', label: 'Gemini' },
  grok: { command: 'grok', label: 'Grok' },
});

function cleanText(value, max = 200) {
  return String(value == null ? '' : value).replace(/[\u0000\r\n]/g, ' ').trim().slice(0, max);
}

function safeTmuxName(value, fallback = '') {
  const text = cleanText(value, 100);
  if (!text) return fallback;
  if (!/^[\p{L}\p{N}_.-]+$/u.test(text)) throw new Error('명령창 묶음 이름에는 글자, 숫자, 점(.), 밑줄(_), - 기호만 사용할 수 있습니다.');
  return text;
}

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'"'"'`)}'`;
}

function numericDimension(value, fallback, min, max) {
  const number = Math.floor(Number(value || fallback));
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
}

function terminalEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries({ ...process.env, ...extra })) {
    if (value != null) env[key] = String(value);
  }
  env.TERM = !env.TERM || String(env.TERM).toLowerCase() === 'dumb' ? 'xterm-256color' : env.TERM;
  env.COLORTERM = env.COLORTERM || 'truecolor';
  return env;
}

function powershellExecutable() {
  const modern = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return fs.existsSync(modern) ? modern : 'powershell.exe';
}

function isExecutableFile(file, fileSystem = fs) {
  try {
    if (!path.isAbsolute(file) || !fileSystem.statSync(file).isFile()) return false;
    fileSystem.accessSync(file, fileSystem.constants?.X_OK ?? fs.constants.X_OK);
    return true;
  } catch (_missingOrNonExecutableShell) {
    return false;
  }
}

function resolvePosixShell(environment = process.env, platform = process.platform, fileSystem = fs) {
  const configured = String(environment.SHELL || '').trim();
  const platformDefaults = platform === 'darwin'
    ? ['/bin/zsh', '/bin/bash', '/bin/sh']
    : ['/bin/bash', '/bin/zsh', '/bin/sh'];
  const candidates = [...new Set([configured, ...platformDefaults].filter(Boolean))];
  const shell = candidates.find(candidate => isExecutableFile(candidate, fileSystem));
  if (!shell) throw new Error('Linux 명령창을 실행할 프로그램을 찾지 못했습니다. Linux 명령창 설치 상태를 확인하세요.');
  return shell;
}

function windowsPathValue(env = process.env) {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path');
  return key ? String(env[key] || '') : '';
}

function resolveWindowsCommand(command, env = process.env) {
  const value = String(command || '').trim();
  if (!value) return '';
  const hasPath = /[\\/]/.test(value);
  const directories = hasPath ? [''] : windowsPathValue(env).split(path.delimiter).filter(Boolean);
  const extension = path.extname(value).toLowerCase();
  const suffixes = extension ? [''] : ['.exe', '.com', '.ps1', '.cmd', '.bat'];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = hasPath ? `${value}${suffix}` : path.join(directory, `${value}${suffix}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return value;
}

function killPtyTree(handle, pid) {
  if (!handle) return;
  if (process.platform !== 'win32' || !Number.isFinite(Number(pid))) {
    runBestEffort('terminal-kill', () => handle.kill());
    return;
  }
  try {
    const killer = spawnChild('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('exit', code => {
      if (code === 0 || handle.__loadtoagentExited) return;
      runBestEffort('terminal-kill-fallback', () => handle.kill());
    });
    killer.unref();
  } catch (_treeKillUnavailable) {
    // Fall back to the PTY handle when the platform process-tree command is unavailable.
    runBestEffort('terminal-kill-spawn-fallback', () => handle.kill());
  }
}

function normalizeLaunchOptions(options = {}, platform = process.platform) {
  const fallbackType = platform === 'win32' ? 'powershell' : 'shell';
  const type = TERMINAL_TYPES.has(options.type) ? options.type : fallbackType;
  const suppliedCwd = String(options.cwd || '').trim();
  const localCwd = suppliedCwd || os.homedir();
  const distro = cleanText(options.distro, 100);
  const wslAgent = platform === 'win32' && type === 'agent' && Boolean(distro);
  if (['powershell', 'cmd', 'shell', 'agent'].includes(type) && !wslAgent && (!fs.existsSync(localCwd) || !fs.statSync(localCwd).isDirectory())) {
    throw new Error(`작업 폴더를 찾을 수 없습니다: ${localCwd}`);
  }
  if ((type === 'wsl' || type === 'tmux') && !distro) throw new Error('작업을 실행할 Linux 환경을 선택하세요.');
  const tmuxSession = cleanText(options.tmuxSession, 100);
  const tmuxPane = cleanText(options.tmuxPane, 100);
  if (type === 'tmux' && !tmuxSession) throw new Error('연결할 명령창 묶음을 선택하세요.');
  const provider = cleanText(options.provider, 30).toLowerCase();
  if (type === 'agent' && !AGENT_PROVIDERS[provider]) throw new Error('선택한 AI 종류는 사용할 수 없습니다.');
  const requestedBackend = cleanText(options.sessionBackend || options.backend, 40);
  const managedByDefault = type === 'agent'
    && !options.transient
    && (platform !== 'win32' || Boolean(distro));
  const sessionBackend = SESSION_BACKENDS.has(requestedBackend)
    ? requestedBackend
    : (managedByDefault ? 'managed-tmux' : 'direct');
  if (sessionBackend === 'managed-tmux' && type !== 'agent') {
    throw new Error('여러 명령창 기능은 AI 명령창에서만 사용할 수 있습니다.');
  }
  const args = Array.isArray(options.args)
    ? options.args.slice(0, 80).map(value => cleanText(value, 2_000))
    : [];
  return {
    type,
    cwd: ['powershell', 'cmd', 'shell', 'agent'].includes(type) && !wslAgent ? path.resolve(localCwd) : suppliedCwd,
    distro,
    tmuxSession,
    tmuxPane,
    provider,
    args,
    sessionBackend,
    tmuxSocket: sessionBackend === 'managed-tmux'
      ? safeTmuxName(options.tmuxSocket, DEFAULT_TMUX_SOCKET)
      : '',
    managedTmuxSession: sessionBackend === 'managed-tmux'
      ? safeTmuxName(options.managedTmuxSession)
      : '',
    bridgeId: cleanText(options.bridgeId, 100),
    title: cleanText(options.title, 100),
    transient: Boolean(options.transient),
    cols: numericDimension(options.cols, 120, 20, 500),
    rows: numericDimension(options.rows, 32, 5, 200),
  };
}

function launchSpec(options, platform = process.platform, agentProviders = AGENT_PROVIDERS, runtime = {}) {
  if (options.type === 'powershell') {
    const file = powershellExecutable();
    return { file, args: ['-NoLogo'], cwd: options.cwd, label: path.basename(file, '.exe') };
  }
  if (options.type === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: ['/Q'], cwd: options.cwd, label: 'Windows 명령창' };
  if (options.type === 'shell') {
    const file = resolvePosixShell(runtime.env || process.env, platform, runtime.fileSystem || fs);
    return { file, args: ['-l'], cwd: options.cwd, label: path.basename(file) };
  }
  if (options.type === 'agent') {
    const provider = agentProviders[options.provider] || AGENT_PROVIDERS[options.provider];
    if (options.sessionBackend === 'managed-tmux') {
      if (!options.managedTmuxSession) throw new Error('명령창 묶음 이름을 입력하세요.');
      const tmuxArgs = [
        '-L', options.tmuxSocket,
        'new-session', '-A',
        '-s', options.managedTmuxSession,
        '-c', options.cwd,
        provider.command,
        ...(provider.args || []),
        ...options.args,
        ';',
        'set-option', '-g', 'window-size', 'largest',
      ];
      if (platform !== 'win32') {
        return {
          file: 'tmux',
          args: tmuxArgs,
          cwd: options.cwd,
          label: provider.label,
        };
      }
      return {
        file: 'wsl.exe',
        args: ['-d', options.distro, '--cd', options.cwd, '--', 'tmux', ...tmuxArgs],
        cwd: os.homedir(),
        label: `${provider.label} · ${options.distro}`,
      };
    }
    if (platform === 'win32') {
      if (options.distro) {
        const args = ['-d', options.distro];
        if (options.cwd) args.push('--cd', options.cwd);
        args.push('--', provider.command, ...(provider.args || []), ...options.args);
        return {
          file: 'wsl.exe',
          args,
          cwd: os.homedir(),
          label: `${provider.label} · ${options.distro}`,
        };
      }
      const command = resolveWindowsCommand(provider.command);
      if (path.extname(command).toLowerCase() === '.ps1') {
        return {
          file: powershellExecutable(),
          args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...(provider.args || []), ...options.args],
          cwd: options.cwd,
          label: provider.label,
        };
      }
      if (/\.(?:cmd|bat)$/i.test(command)) {
        return { file: process.env.ComSpec || 'cmd.exe', args: ['/D', '/S', '/C', command, ...(provider.args || []), ...options.args], cwd: options.cwd, label: provider.label };
      }
      return { file: command, args: [...(provider.args || []), ...options.args], cwd: options.cwd, label: provider.label };
    }
    return { file: provider.command, args: [...(provider.args || []), ...options.args], cwd: options.cwd, label: provider.label };
  }
  if (options.type === 'wsl') {
    const args = ['-d', options.distro];
    if (options.cwd) args.push('--cd', options.cwd);
    return { file: 'wsl.exe', args, cwd: os.homedir(), label: `${options.distro} Linux 명령창` };
  }
  const selectPane = options.tmuxPane ? `tmux select-pane -t ${shellQuote(options.tmuxPane)} 2>/dev/null || true; ` : '';
  const script = `${selectPane}exec tmux attach-session -t ${shellQuote(options.tmuxSession)}`;
  if (platform !== 'win32') {
    const file = resolvePosixShell(runtime.env || process.env, platform, runtime.fileSystem || fs);
    return { file, args: ['-lc', script], cwd: options.cwd || os.homedir(), label: `여러 명령창 · ${options.tmuxSession}` };
  }
  return {
    file: 'wsl.exe',
    args: ['-d', options.distro, '--', 'sh', '-lc', script],
    cwd: os.homedir(),
    label: `여러 명령창 · ${options.tmuxSession}`,
  };
}

function publicSession(session, includeReplay = false) {
  const value = {
    id: session.id,
    type: session.options.type,
    title: session.title,
    shell: session.shell,
    cwd: session.options.cwd,
    distro: session.options.distro,
    tmuxSession: session.options.tmuxSession,
    tmuxPane: session.options.tmuxPane,
    provider: session.options.provider,
    backend: session.options.sessionBackend,
    tmuxSocket: session.options.tmuxSocket,
    managedTmuxSession: session.options.managedTmuxSession,
    bridgeId: session.options.bridgeId,
    transient: Boolean(session.options.transient),
    background: session.options.type === 'agent',
    recoveredAfterHostRestart: Boolean(session.recoveredAfterHostRestart),
    recoverySkippedReason: session.recoverySkippedReason || '',
    pid: session.pid,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    exitCode: session.exitCode,
    signal: session.signal,
    cols: session.cols,
    rows: session.rows,
  };
  if (includeReplay) value.replay = session.replay;
  return value;
}

function validTimestamp(value, fallback) {
  const text = cleanText(value, 50);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : fallback;
}

function restoredOptions(value = {}, platform = process.platform, storeVersion = STORE_VERSION) {
  const fallbackType = platform === 'win32' ? 'powershell' : 'shell';
  const type = TERMINAL_TYPES.has(value.type) ? value.type : fallbackType;
  const provider = cleanText(value.provider, 30).toLowerCase();
  if (type === 'agent' && !AGENT_PROVIDERS[provider]) return null;
  return {
    type,
    cwd: cleanText(value.cwd, 2_000) || os.homedir(),
    distro: cleanText(value.distro, 100),
    tmuxSession: cleanText(value.tmuxSession, 100),
    tmuxPane: cleanText(value.tmuxPane, 100),
    provider,
    args: Array.isArray(value.args) ? value.args.slice(0, 80).map(item => cleanText(item, 2_000)) : [],
    sessionBackend: SESSION_BACKENDS.has(value.sessionBackend)
      ? value.sessionBackend
      : (storeVersion < STORE_VERSION ? 'direct' : undefined),
    tmuxSocket: cleanText(value.tmuxSocket, 100),
    managedTmuxSession: cleanText(value.managedTmuxSession, 100),
    bridgeId: cleanText(value.bridgeId, 100),
    title: cleanText(value.title, 100),
    transient: Boolean(value.transient),
    cols: numericDimension(value.cols, 120, 20, 500),
    rows: numericDimension(value.rows, 32, 5, 200),
  };
}

function persistedSession(session) {
  return {
    id: session.id,
    options: { ...session.options, cols: session.cols, rows: session.rows },
    title: session.title,
    shell: session.shell,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    exitCode: session.exitCode,
    signal: session.signal,
    replay: session.replay,
  };
}

function hasSafeAgentResume(options = {}) {
  if (options.type !== 'agent') return true;
  const args = Array.isArray(options.args) ? options.args.map(value => String(value || '')) : [];
  if (options.provider === 'codex') return args[0] === 'resume' && Boolean(args[1]);
  const resumeIndex = args.indexOf('--resume');
  return resumeIndex >= 0 && Boolean(args[resumeIndex + 1]);
}

class TerminalManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ptyModule = options.ptyModule || null;
    this.killTree = options.killTree || killPtyTree;
    this.platform = options.platform || process.platform;
    this.agentProviders = options.agentProviders || AGENT_PROVIDERS;
    this.managedTmuxRuntime = options.managedTmuxRuntime || new ManagedTmuxRuntime({ platform: this.platform });
    this.fileSystem = options.fileSystem || fs;
    this.storeFile = typeof options.storeFile === 'string' && options.storeFile.trim()
      ? path.resolve(options.storeFile)
      : '';
    this.onPersistenceError = typeof options.onPersistenceError === 'function'
      ? options.onPersistenceError
      : () => {};
    this.retentionDays = retentionDays(options.retentionDays);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.persistTimer = null;
    this.sessions = new Map();
    this.loadPersistedSessions();
  }

  persistenceError(operation, error) {
    runBestEffort(`terminal-persistence:${operation}`, () => this.onPersistenceError(operation, error));
  }

  loadPersistedSessions() {
    if (!this.storeFile) return;
    try {
      const stat = this.fileSystem.statSync(this.storeFile);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error('명령창 기록 파일이 너무 큽니다.');
      const parsed = JSON.parse(this.fileSystem.readFileSync(this.storeFile, 'utf8'));
      if (![1, STORE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.sessions)) throw new Error('이 버전에서 읽을 수 없는 명령창 기록입니다.');
      for (const value of parsed.sessions.slice(0, MAX_SESSIONS)) {
        if (!shouldRetainTerminalSession(value, this.retentionDays, this.now())) continue;
        const id = cleanText(value?.id, 200);
        const options = normalizeLaunchOptions(
          restoredOptions(value?.options, this.platform, parsed.version),
          this.platform,
        );
        if (!id || !options || this.sessions.has(id)) continue;
        const now = new Date().toISOString();
        const createdAt = validTimestamp(value.createdAt, now);
        const updatedAt = validTimestamp(value.updatedAt, createdAt);
        const status = options.sessionBackend === 'managed-tmux' && ['detached', 'stopped'].includes(value.status)
          ? value.status
          : (value.status === 'failed' ? 'failed' : 'exited');
        this.sessions.set(id, {
          id,
          options,
          spec: null,
          title: cleanText(value.title, 100) || options.title || options.tmuxSession || options.provider || options.type,
          shell: cleanText(value.shell, 2_000),
          pid: null,
          status,
          createdAt,
          updatedAt,
          exitCode: Number.isFinite(value.exitCode) ? value.exitCode : null,
          signal: Number.isFinite(value.signal) ? value.signal : null,
          cols: options.cols,
          rows: options.rows,
          replay: String(value.replay || '').slice(-MAX_REPLAY_CHARS),
          process: null,
          generation: 0,
          recoveryPending: value.status === 'running' || value.status === 'starting',
          recoveredAfterHostRestart: false,
          recoverySkippedReason: '',
        });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.persistenceError('load', error);
    }
  }

  schedulePersist() {
    if (!this.storeFile || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_DELAY_MS);
    if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
  }

  persistNow() {
    if (!this.storeFile) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const temporary = `${this.storeFile}.${process.pid}.tmp`;
    try {
      this.fileSystem.mkdirSync(path.dirname(this.storeFile), { recursive: true, mode: 0o700 });
      const payload = {
        version: STORE_VERSION,
        sessions: [...this.sessions.values()]
          .filter(session => !session.options.transient)
          .filter(session => shouldRetainTerminalSession(session, this.retentionDays, this.now()))
          .map(persistedSession),
      };
      this.fileSystem.writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
      this.fileSystem.renameSync(temporary, this.storeFile);
      restrictPathPermissions(path.dirname(this.storeFile), { fileSystem: this.fileSystem, platform: this.platform });
      restrictPathPermissions(this.storeFile, { fileSystem: this.fileSystem, platform: this.platform });
    } catch (error) {
      runBestEffort('terminal-persistence-temp-cleanup', () => this.fileSystem.unlinkSync(temporary));
      this.persistenceError('save', error);
    }
  }

  pty() {
    if (!this.ptyModule) {
      ensureMacNodePtyRuntime({ platform: this.platform });
      this.ptyModule = require('node-pty');
    }
    return this.ptyModule;
  }

  recoverPersistedSessions() {
    const recovered = [];
    for (const session of this.sessions.values()) {
      if (!session.recoveryPending) continue;
      session.recoveryPending = false;
      if (session.options.sessionBackend === 'managed-tmux') {
        if (!this.managedTmuxRuntime.exists(session.options)) {
          session.status = 'stopped';
          session.pid = null;
          session.recoveredAfterHostRestart = false;
          session.recoverySkippedReason = 'managed-tmux-missing';
          const missingMessage = '\r\n[LoadToAgent] 저장된 명령창 묶음을 찾지 못해 새 AI 대화를 자동으로 시작하지 않았습니다.\r\n';
          session.replay = `${session.replay}${missingMessage}`.slice(-MAX_REPLAY_CHARS);
          continue;
        }
        session.recoveredAfterHostRestart = true;
        session.recoverySkippedReason = '';
        const reattachMessage = '\r\n[LoadToAgent] 명령창 연결이 끊긴 뒤에도 실행 중이던 작업에 다시 연결했습니다.\r\n';
        session.replay = `${session.replay}${reattachMessage}`.slice(-MAX_REPLAY_CHARS);
        try {
          this.spawn(session);
          recovered.push(publicSession(session, true));
        } catch (_recoveryFailed) {
          session.recoveredAfterHostRestart = false;
        }
        continue;
      }
      if (session.options.type === 'agent'
        && /TERM is set to ["']?dumb["']?[\s\S]{0,500}Continue anyway\?/i.test(session.replay)) {
        this.sessions.delete(session.id);
        continue;
      }
      if (!hasSafeAgentResume(session.options)) {
        session.status = 'exited';
        session.pid = null;
        session.recoveredAfterHostRestart = false;
        session.recoverySkippedReason = 'unsafe-agent-restart';
        const skippedMessage = '\r\n[LoadToAgent] 이어갈 기존 AI 대화를 찾지 못했습니다. 새 대화를 만들 수 있어 자동으로 이어가지는 않았습니다.\r\n';
        session.replay = `${session.replay}${skippedMessage}`.slice(-MAX_REPLAY_CHARS);
        continue;
      }
      session.recoveredAfterHostRestart = true;
      session.recoverySkippedReason = '';
      const message = '\r\n[LoadToAgent] 명령창 연결이 끊긴 뒤 새 프로그램으로 복구했습니다. 이전 명령창의 임시 상태는 이어지지 않습니다.\r\n';
      session.replay = `${session.replay}${message}`.slice(-MAX_REPLAY_CHARS);
      try {
        this.spawn(session);
      } catch (_recoveryFailed) {
        session.recoveredAfterHostRestart = false;
      }
      recovered.push(publicSession(session, true));
    }
    this.persistNow();
    return recovered;
  }

  create(rawOptions = {}) {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`동시에 열 수 있는 명령창은 최대 ${MAX_SESSIONS}개입니다.`);
    const options = normalizeLaunchOptions(rawOptions, this.platform);
    const id = `terminal:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`;
    if (options.sessionBackend === 'managed-tmux' && !options.managedTmuxSession) {
      options.managedTmuxSession = safeTmuxName(`lta-${options.provider}-${id.split(':').slice(1).join('-')}`);
    }
    const spec = launchSpec(options, this.platform, this.agentProviders);
    const now = new Date().toISOString();
    const session = {
      id,
      options,
      spec,
      title: options.title || spec.label,
      shell: spec.file,
      pid: null,
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      exitCode: null,
      signal: null,
      cols: options.cols,
      rows: options.rows,
      replay: '',
      process: null,
      generation: 0,
      recoveryPending: false,
      recoveredAfterHostRestart: false,
      recoverySkippedReason: '',
    };
    this.sessions.set(id, session);
    try {
      this.spawn(session);
    } catch (error) {
      // Keep failed launches visible until the user explicitly closes them.
      // The failed session contains the startup error in replay and can be
      // inspected, restarted, or removed from the session terminal.
      this.persistNow();
      throw error;
    }
    this.persistNow();
    return publicSession(session, true);
  }

  spawn(session) {
    if (!session.spec) {
      session.options = normalizeLaunchOptions(session.options, this.platform);
      session.spec = launchSpec(session.options, this.platform, this.agentProviders);
      session.shell = session.spec.file;
    }
    const generation = ++session.generation;
    session.status = 'starting';
    session.exitCode = null;
    session.signal = null;
    session.updatedAt = new Date().toISOString();
    this.emitState('updated', session);
    try {
      const spawnOptions = {
        name: 'xterm-256color',
        cols: session.cols,
        rows: session.rows,
        cwd: session.spec.cwd,
        env: terminalEnvironment(),
        useConpty: this.platform === 'win32',
      };
      if (this.platform !== 'win32') spawnOptions.encoding = 'utf8';
      const processHandle = this.pty().spawn(session.spec.file, session.spec.args, spawnOptions);
      session.process = processHandle;
      session.pid = Number(processHandle.pid) > 0 ? Number(processHandle.pid) : null;
      session.status = 'running';
      session.updatedAt = new Date().toISOString();
      processHandle.onData(data => {
        if (session.generation !== generation) return;
        const readyPid = Number(processHandle.pid);
        if (Number.isSafeInteger(readyPid) && readyPid > 0) session.pid = readyPid;
        const text = String(data || '');
        session.replay = `${session.replay}${text}`.slice(-MAX_REPLAY_CHARS);
        session.updatedAt = new Date().toISOString();
        this.emit('data', { id: session.id, data: text });
        this.schedulePersist();
      });
      processHandle.onExit(event => {
        processHandle.__loadtoagentExited = true;
        if (session.generation !== generation) return;
        session.process = null;
        session.pid = null;
        if (session.options.sessionBackend === 'managed-tmux') {
          session.status = this.managedTmuxRuntime.exists(session.options) ? 'detached' : 'stopped';
        } else {
          session.status = 'exited';
        }
        session.exitCode = Number.isFinite(event.exitCode) ? event.exitCode : null;
        session.signal = Number.isFinite(event.signal) ? event.signal : null;
        session.updatedAt = new Date().toISOString();
        if (session.options.transient) {
          this.sessions.delete(session.id);
          this.emit('state', { change: 'removed', session: publicSession(session, false), sessions: this.list() });
          this.persistNow();
          return;
        }
        this.persistNow();
        this.emitState('updated', session);
      });
      this.emitState('updated', session);
    } catch (error) {
      session.process = null;
      session.pid = null;
      session.status = 'failed';
      session.updatedAt = new Date().toISOString();
      const failureMessage = `\r\n[LoadToAgent] 명령창을 시작하지 못했습니다: ${error.message}\r\n`;
      session.replay = `${session.replay}${failureMessage}`.slice(-MAX_REPLAY_CHARS);
      this.emit('data', { id: session.id, data: failureMessage });
      this.emitState('updated', session);
      throw error;
    }
  }

  emitState(change, session) {
    this.emit('state', { change, session: session ? publicSession(session, false) : null, sessions: this.list() });
    this.schedulePersist();
  }

  list() {
    return [...this.sessions.values()].map(session => publicSession(session, false));
  }

  get(id, includeReplay = true) {
    const session = this.sessions.get(String(id || ''));
    return session ? publicSession(session, includeReplay) : null;
  }

  required(id) {
    const session = this.sessions.get(String(id || ''));
    if (!session) throw new Error('명령창 작업을 찾을 수 없습니다.');
    return session;
  }

  write(id, value) {
    const session = this.required(id);
    if (!session.process || session.status !== 'running') throw new Error('현재 실행 중인 명령창이 아닙니다.');
    const data = String(value == null ? '' : value);
    if (data.length > MAX_INPUT_CHARS) throw new Error('한 번에 보낼 수 있는 입력 크기를 초과했습니다.');
    session.process.write(data);
    return { ok: true };
  }

  command(id, value) {
    const command = String(value == null ? '' : value).replace(/\r?\n/g, '\r');
    if (!command.trim()) return { ok: false, error: '명령을 입력하세요.' };
    this.write(id, `${command}\r`);
    return { ok: true };
  }

  resize(id, cols, rows) {
    const session = this.required(id);
    session.cols = numericDimension(cols, session.cols, 20, 500);
    session.rows = numericDimension(rows, session.rows, 5, 200);
    if (session.process && session.status === 'running') session.process.resize(session.cols, session.rows);
    this.schedulePersist();
    return { ok: true, cols: session.cols, rows: session.rows };
  }

  signal(id, signal) {
    const session = this.required(id);
    const key = String(signal || '').toLowerCase();
    if (key === 'interrupt') return this.write(id, '\x03');
    if (key === 'eof') return this.write(id, '\x04');
    if (key === 'clear') {
      if (session.process && typeof session.process.clear === 'function') session.process.clear();
      return this.write(id, '\x0c');
    }
    if (key === 'terminate') return this.kill(id);
    throw new Error('이 명령창에서는 이 버튼을 사용할 수 없습니다.');
  }

  releaseProcess(session) {
    if (!session.process) return false;
    const handle = session.process;
    const pid = session.pid;
    session.process = null;
    session.generation += 1;
    this.killTree(handle, pid);
    return true;
  }

  kill(id) {
    const session = this.required(id);
    this.releaseProcess(session);
    session.pid = null;
    session.status = 'exited';
    session.updatedAt = new Date().toISOString();
    this.emitState('updated', session);
    this.persistNow();
    return { ok: true };
  }

  restart(id) {
    const session = this.required(id);
    session.recoveredAfterHostRestart = false;
    session.recoverySkippedReason = '';
    this.releaseProcess(session);
    session.pid = null;
    session.replay = '';
    this.spawn(session);
    return publicSession(session, true);
  }

  reconnect(id) {
    const session = this.required(id);
    if (session.options.sessionBackend !== 'managed-tmux') {
      throw new Error('일반 명령창은 화면 밖에서 실행 중인 작업에 다시 연결할 수 없습니다.');
    }
    if (session.process && session.status === 'running') return publicSession(session, true);
    if (!this.managedTmuxRuntime.exists(session.options)) {
      session.pid = null;
      session.status = 'stopped';
      session.recoveredAfterHostRestart = false;
      session.recoverySkippedReason = 'managed-tmux-missing';
      session.updatedAt = new Date().toISOString();
      this.emitState('updated', session);
      this.persistNow();
      throw new Error('기존 명령창 묶음이 끝나 다시 연결할 수 없습니다.');
    }
    session.recoveredAfterHostRestart = false;
    session.recoverySkippedReason = '';
    this.spawn(session);
    return publicSession(session, true);
  }

  detach(id) {
    const session = this.required(id);
    if (session.options.sessionBackend !== 'managed-tmux') {
      throw new Error('일반 명령창은 작업을 계속 둔 채 화면 연결만 끊을 수 없습니다.');
    }
    this.releaseProcess(session);
    session.pid = null;
    session.status = 'detached';
    session.updatedAt = new Date().toISOString();
    this.emitState('updated', session);
    this.persistNow();
    return publicSession(session, true);
  }

  stop(id) {
    const session = this.required(id);
    this.releaseProcess(session);
    if (session.options.sessionBackend === 'managed-tmux') {
      this.managedTmuxRuntime.stop(session.options);
    }
    session.pid = null;
    session.status = 'stopped';
    session.updatedAt = new Date().toISOString();
    this.emitState('updated', session);
    this.persistNow();
    return publicSession(session, true);
  }

  close(id) {
    const session = this.required(id);
    this.releaseProcess(session);
    if (session.options.sessionBackend === 'managed-tmux') {
      this.managedTmuxRuntime.stop(session.options);
    }
    session.pid = null;
    session.status = 'exited';
    session.updatedAt = new Date().toISOString();
    this.sessions.delete(session.id);
    this.emit('state', { change: 'removed', session: publicSession(session, false), sessions: this.list() });
    this.persistNow();
    return { ok: true };
  }

  dispose({ preserveSessions = false } = {}) {
    if (preserveSessions) {
      const now = new Date().toISOString();
      for (const session of this.sessions.values()) {
        const shouldRecover = session.status === 'running' || session.status === 'starting';
        this.releaseProcess(session);
        if (shouldRecover) {
          session.status = session.options.sessionBackend === 'managed-tmux' ? 'detached' : 'running';
        }
        session.pid = null;
        session.updatedAt = now;
      }
      this.persistNow();
      return;
    }
    for (const id of [...this.sessions.keys()]) {
      runBestEffort(`terminal-dispose:${id}`, () => this.close(id));
    }
    this.persistNow();
  }
}

module.exports = {
  TerminalManager,
  normalizeLaunchOptions,
  launchSpec,
  shellQuote,
  numericDimension,
  killPtyTree,
  AGENT_PROVIDERS,
  resolveWindowsCommand,
  resolvePosixShell,
};
