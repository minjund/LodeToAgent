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
const MAX_AGENT_ARGUMENT_CHARS = 8 * 1024;
const MAX_REPLAY_CHARS = 2 * 1024 * 1024;
const MAX_DELIVERY_RECORDS = 256;
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

function normalizedArguments(value, maxChars = 2_000) {
  return Array.isArray(value)
    ? value.slice(0, 80).map(item => cleanText(item, maxChars))
    : [];
}

function normalizedDeliveryId(value) {
  const id = cleanText(value, 240);
  return /^[A-Za-z0-9:._-]+$/.test(id) ? id : '';
}

function deliveryFingerprint(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex');
}

function rejectedDeliveryError(message, code = 'DELIVERY_REJECTED', deliveryId = '') {
  const error = new Error(message);
  error.code = code;
  error.deliveryState = 'rejected';
  error.deliveryId = deliveryId;
  return error;
}

function markDeliveryRejected(error, deliveryId) {
  const value = error instanceof Error ? error : new Error(String(error || '질문을 보내지 못했습니다.'));
  if (!value.code) value.code = 'DELIVERY_REJECTED';
  value.deliveryState = 'rejected';
  value.deliveryId = deliveryId;
  return value;
}

function restoredDeliveries(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_DELIVERY_RECORDS).map(record => {
    const id = normalizedDeliveryId(record?.id);
    const state = record?.state === 'accepted' ? 'accepted' : (record?.state === 'prepared' ? 'prepared' : '');
    const timestamp = cleanText(record?.timestamp, 50);
    const target = cleanText(record?.target, 400);
    const fingerprint = String(record?.fingerprint || '').trim().toLowerCase();
    return id && state ? {
      id,
      state,
      timestamp,
      ...(target ? { target } : {}),
      ...(/^[a-f0-9]{64}$/.test(fingerprint) ? { fingerprint } : {}),
    } : null;
  }).filter(Boolean);
}

function validAgentSessionId(value) {
  const sessionId = cleanText(value, MAX_AGENT_ARGUMENT_CHARS);
  return Boolean(sessionId && sessionId !== '--' && !sessionId.startsWith('-'));
}

function resumableAgentArguments(options = {}) {
  const args = normalizedArguments(options.args, MAX_AGENT_ARGUMENT_CHARS);
  if (options.type !== 'agent') return args;
  if (options.provider === 'codex' && args[0] === 'resume') {
    const sessionIndex = args[1] === '--' ? 2 : 1;
    if (!validAgentSessionId(args[sessionIndex])) return args;
    return args[1] === '--'
      ? ['resume', '--', args[sessionIndex]]
      : ['resume', args[sessionIndex]];
  }
  if (options.provider === 'claude' || options.provider === 'gemini' || options.provider === 'grok') {
    const resumeIndex = args.indexOf('--resume');
    return resumeIndex >= 0 && validAgentSessionId(args[resumeIndex + 1])
      ? ['--resume', args[resumeIndex + 1]]
      : args;
  }
  return args;
}

function agentBridgeKey(options = {}) {
  if (options.type !== 'agent' || !options.bridgeId || !options.provider) return '';
  return `${options.provider}:${options.bridgeId}`;
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
  const args = normalizedArguments(options.args, MAX_AGENT_ARGUMENT_CHARS);
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

function managedTmuxAttachSpec(options, platform = process.platform) {
  if (!options?.managedTmuxSession) throw new Error('재연결할 명령창 묶음 정보가 없습니다.');
  const tmuxArgs = [
    '-L', options.tmuxSocket,
    'attach-session', '-t', `=${options.managedTmuxSession}`,
  ];
  if (platform !== 'win32') {
    return {
      file: 'tmux',
      args: tmuxArgs,
      cwd: options.cwd,
      label: options.title || options.provider || '관리형 AI 명령창',
    };
  }
  return {
    file: 'wsl.exe',
    args: ['-d', options.distro, '--cd', options.cwd, '--', 'tmux', ...tmuxArgs],
    cwd: os.homedir(),
    label: options.title || options.provider || '관리형 AI 명령창',
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

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function unicodeSafeReplayTail(value, maxChars = MAX_REPLAY_CHARS) {
  const text = String(value == null ? '' : value);
  if (text.length <= maxChars) return text;
  let start = text.length - maxChars;
  if (start > 0
    && isLowSurrogate(text.charCodeAt(start))
    && isHighSurrogate(text.charCodeAt(start - 1))) {
    start += 1;
  }
  return text.slice(start);
}

function jsonBudgetedReplayTail(value, maxBytes) {
  const text = String(value == null ? '' : value);
  const byteLimit = Math.max(0, Math.floor(Number(maxBytes) || 0));
  let start = text.length;
  let chars = 0;
  let bytes = 0;
  while (start > 0) {
    const code = text.charCodeAt(start - 1);
    let unitStart = start - 1;
    let unitChars = 1;
    let unitBytes;
    if (isLowSurrogate(code) && start > 1 && isHighSurrogate(text.charCodeAt(start - 2))) {
      unitStart = start - 2;
      unitChars = 2;
      unitBytes = 4;
    } else if (isHighSurrogate(code) || isLowSurrogate(code)) {
      unitBytes = 6;
    } else if (code === 0x22 || code === 0x5c
      || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      unitBytes = 2;
    } else if (code < 0x20) {
      unitBytes = 6;
    } else if (code < 0x80) {
      unitBytes = 1;
    } else if (code < 0x800) {
      unitBytes = 2;
    } else {
      unitBytes = 3;
    }
    if (chars + unitChars > MAX_REPLAY_CHARS || bytes + unitBytes > byteLimit) break;
    start = unitStart;
    chars += unitChars;
    bytes += unitBytes;
  }
  return { replay: text.slice(start), bytes };
}

function restoredOptions(value = {}, platform = process.platform, storeVersion = STORE_VERSION) {
  const persistedType = cleanText(value?.type, 30);
  const persistedCwd = typeof value?.cwd === 'string' ? cleanText(value.cwd, 2_000) : '';
  const persistedDistro = cleanText(value?.distro, 100);
  if (storeVersion >= STORE_VERSION) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const canonicalType = typeof value.type === 'string' && value.type === persistedType;
    const directWslAgent = platform === 'win32'
      && persistedType === 'agent'
      && value.sessionBackend === 'direct'
      && Boolean(persistedDistro);
    if (!canonicalType
      || !TERMINAL_TYPES.has(persistedType)
      || typeof value.cwd !== 'string'
      || (['powershell', 'cmd', 'shell', 'agent'].includes(persistedType) && !directWslAgent && !persistedCwd)
      || !SESSION_BACKENDS.has(value.sessionBackend)
      || (value.sessionBackend === 'managed-tmux' && !cleanText(value.managedTmuxSession, 100))) {
      return null;
    }
  }
  const fallbackType = platform === 'win32' ? 'powershell' : 'shell';
  const type = storeVersion >= STORE_VERSION
    ? persistedType
    : (TERMINAL_TYPES.has(value.type) ? value.type : fallbackType);
  const provider = cleanText(value.provider, 30).toLowerCase();
  if (type === 'agent' && !AGENT_PROVIDERS[provider]) return null;
  const directWslAgent = platform === 'win32'
    && type === 'agent'
    && value.sessionBackend === 'direct'
    && Boolean(persistedDistro);
  return {
    type,
    cwd: directWslAgent ? persistedCwd : (persistedCwd || os.homedir()),
    distro: persistedDistro,
    tmuxSession: cleanText(value.tmuxSession, 100),
    tmuxPane: cleanText(value.tmuxPane, 100),
    provider,
    args: resumableAgentArguments({ type, provider, args: value.args }),
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
    deliveries: restoredDeliveries(session.deliveries),
  };
}

function serializedStorePayload(sessions, maxStoreBytes) {
  const records = sessions.map(persistedSession);
  const replays = records.map(record => String(record.replay || ''));
  for (const record of records) record.replay = '';
  const payload = { version: STORE_VERSION, sessions: records };
  const replayless = JSON.stringify(payload);
  const replaylessBytes = Buffer.byteLength(replayless, 'utf8');
  if (replaylessBytes > maxStoreBytes) {
    const error = new Error('명령창 기록의 필수 정보가 저장 용량을 초과했습니다.');
    error.code = 'TERMINAL_STORE_TOO_LARGE';
    throw error;
  }
  const availableReplayBytes = maxStoreBytes - replaylessBytes;
  const fullReplays = replays.map(replay => jsonBudgetedReplayTail(replay, Number.MAX_SAFE_INTEGER));
  const requiredReplayBytes = fullReplays.reduce((total, replay) => total + replay.bytes, 0);
  if (requiredReplayBytes <= availableReplayBytes) {
    for (let index = 0; index < records.length; index += 1) {
      records[index].replay = fullReplays[index].replay;
    }
  } else {
    let remainingBytes = availableReplayBytes;
    const allocations = fullReplays
      .map((replay, index) => ({ index, replay }))
      .sort((left, right) => left.replay.bytes - right.replay.bytes);
    for (let position = 0; position < allocations.length; position += 1) {
      const allocation = allocations[position];
      const remainingRecords = allocations.length - position;
      const share = Math.floor(remainingBytes / remainingRecords);
      const bounded = allocation.replay.bytes <= share
        ? allocation.replay
        : jsonBudgetedReplayTail(replays[allocation.index], share);
      records[allocation.index].replay = bounded.replay;
      remainingBytes -= bounded.bytes;
    }
  }
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > maxStoreBytes) {
    const error = new Error('명령창 기록 파일이 저장 용량을 초과했습니다.');
    error.code = 'TERMINAL_STORE_TOO_LARGE';
    throw error;
  }
  return serialized;
}

function hasSafeAgentResume(options = {}) {
  if (options.type !== 'agent') return true;
  const args = resumableAgentArguments(options);
  if (options.provider === 'codex') {
    if (args[0] !== 'resume') return false;
    return validAgentSessionId(args[args[1] === '--' ? 2 : 1]);
  }
  const resumeIndex = args.indexOf('--resume');
  return resumeIndex >= 0 && validAgentSessionId(args[resumeIndex + 1]);
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
    const requestedStoreBytes = Math.floor(Number(options.maxStoreBytes));
    this.maxStoreBytes = Number.isSafeInteger(requestedStoreBytes) && requestedStoreBytes > 0
      ? Math.min(requestedStoreBytes, MAX_STORE_BYTES)
      : MAX_STORE_BYTES;
    this.persistTimer = null;
    this.storeWriteBlocked = false;
    this.quarantinedStoreFile = '';
    this.sessions = new Map();
    this.loadPersistedSessions();
    this.deduplicateAgentBridgeSessions();
  }

  persistenceError(operation, error) {
    runBestEffort(`terminal-persistence:${operation}`, () => this.onPersistenceError(operation, error));
  }

  quarantineUnreadableStore() {
    try {
      const suffix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      const quarantine = `${this.storeFile}.unreadable-${suffix}`;
      const stat = this.fileSystem.statSync(this.storeFile);
      if (!stat.isFile()) throw new Error('읽을 수 없는 명령창 기록 경로가 파일이 아닙니다.');
      this.fileSystem.renameSync(this.storeFile, quarantine);
      this.quarantinedStoreFile = quarantine;
      restrictPathPermissions(quarantine, { fileSystem: this.fileSystem, platform: this.platform });
      return true;
    } catch (error) {
      this.storeWriteBlocked = true;
      this.persistenceError('quarantine', error);
      return false;
    }
  }

  loadPersistedSessions() {
    if (!this.storeFile) return;
    try {
      const stat = this.fileSystem.statSync(this.storeFile);
      if (!stat.isFile() || stat.size > this.maxStoreBytes) throw new Error('명령창 기록 파일이 너무 큽니다.');
      const parsed = JSON.parse(this.fileSystem.readFileSync(this.storeFile, 'utf8'));
      if (![1, STORE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.sessions)) throw new Error('이 버전에서 읽을 수 없는 명령창 기록입니다.');
      let hasUnreadableRecord = false;
      for (const [index, value] of parsed.sessions.slice(0, MAX_SESSIONS).entries()) {
        try {
          if (!shouldRetainTerminalSession(value, this.retentionDays, this.now())) continue;
          const id = cleanText(value?.id, 200);
          if (!id || this.sessions.has(id)) continue;
          const restored = restoredOptions(value?.options, this.platform, parsed.version);
          if (!restored) throw new Error('저장된 명령창 실행 설정을 읽을 수 없습니다.');
          const options = normalizeLaunchOptions(restored, this.platform);
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
            replay: unicodeSafeReplayTail(value.replay),
            deliveries: restoredDeliveries(value.deliveries),
            process: null,
            generation: 0,
            recoveryPending: value.status === 'running' || value.status === 'starting',
            recoveredAfterHostRestart: false,
            recoverySkippedReason: '',
          });
        } catch (error) {
          hasUnreadableRecord = true;
          const id = cleanText(value?.id, 200) || `#${index + 1}`;
          const recordError = new Error(`저장된 명령창 기록 ${id}을(를) 건너뛰었습니다: ${error.message}`);
          recordError.cause = error;
          this.persistenceError('load-record', recordError);
        }
      }
      if (hasUnreadableRecord) this.quarantineUnreadableStore();
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.persistenceError('load', error);
        this.quarantineUnreadableStore();
      }
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
    if (!this.storeFile) return true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.storeWriteBlocked) return false;
    const temporary = `${this.storeFile}.${process.pid}.tmp`;
    try {
      const sessions = [...this.sessions.values()]
        .filter(session => !session.options.transient)
        .filter(session => shouldRetainTerminalSession(session, this.retentionDays, this.now()));
      const serialized = serializedStorePayload(sessions, this.maxStoreBytes);
      this.fileSystem.mkdirSync(path.dirname(this.storeFile), { recursive: true, mode: 0o700 });
      this.fileSystem.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      this.fileSystem.renameSync(temporary, this.storeFile);
      restrictPathPermissions(path.dirname(this.storeFile), { fileSystem: this.fileSystem, platform: this.platform });
      restrictPathPermissions(this.storeFile, { fileSystem: this.fileSystem, platform: this.platform });
      return true;
    } catch (error) {
      runBestEffort('terminal-persistence-temp-cleanup', () => {
        try {
          this.fileSystem.unlinkSync(temporary);
        } catch (cleanupError) {
          if (cleanupError?.code !== 'ENOENT') throw cleanupError;
        }
      });
      this.persistenceError('save', error);
      return false;
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
    this.deduplicateAgentBridgeSessions();
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
          session.replay = unicodeSafeReplayTail(`${session.replay}${missingMessage}`);
          continue;
        }
        session.recoveredAfterHostRestart = true;
        session.recoverySkippedReason = '';
        const reattachMessage = '\r\n[LoadToAgent] 명령창 연결이 끊긴 뒤에도 실행 중이던 작업에 다시 연결했습니다.\r\n';
        session.replay = unicodeSafeReplayTail(`${session.replay}${reattachMessage}`);
        try {
          session.spec = managedTmuxAttachSpec(session.options, this.platform);
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
        session.replay = unicodeSafeReplayTail(`${session.replay}${skippedMessage}`);
        continue;
      }
      session.recoveredAfterHostRestart = true;
      session.recoverySkippedReason = '';
      const message = '\r\n[LoadToAgent] 명령창 연결이 끊긴 뒤 새 프로그램으로 복구했습니다. 이전 명령창의 임시 상태는 이어지지 않습니다.\r\n';
      session.replay = unicodeSafeReplayTail(`${session.replay}${message}`);
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

  deduplicateAgentBridgeSessions() {
    const survivors = new Map();
    const removed = [];
    const removedByKey = new Map();
    for (const session of this.sessions.values()) {
      const key = agentBridgeKey(session.options);
      if (!key) continue;
      const current = survivors.get(key);
      if (!current) {
        survivors.set(key, session);
        continue;
      }
      const sessionUpdated = Date.parse(session.updatedAt || 0) || 0;
      const currentUpdated = Date.parse(current.updatedAt || 0) || 0;
      const sessionCreated = Date.parse(session.createdAt || 0) || 0;
      const currentCreated = Date.parse(current.createdAt || 0) || 0;
      const keepSession = sessionUpdated > currentUpdated
        || (sessionUpdated === currentUpdated && sessionCreated >= currentCreated);
      const survivor = keepSession ? session : current;
      const duplicate = keepSession ? current : session;
      survivors.set(key, survivor);
      if (duplicate.process) this.releaseProcess(duplicate);
      this.sessions.delete(duplicate.id);
      removed.push(duplicate.id);
      removedByKey.set(key, (removedByKey.get(key) || 0) + 1);
    }
    if (removed.length) {
      for (const session of survivors.values()) {
        const key = agentBridgeKey(session.options);
        if (!key) continue;
        const removedForKey = removedByKey.get(key) || 0;
        if (!removedForKey) continue;
        const message = `\r\n[LoadToAgent] 같은 AI 대화에 중복으로 열린 연결 ${removedForKey}개를 정리했습니다.\r\n`;
        session.replay = unicodeSafeReplayTail(`${session.replay}${message}`);
      }
    }
    return removed;
  }

  reclaimFinishedSessions(requiredSlots = 1) {
    const required = Math.max(1, Number(requiredSlots) || 1);
    if (this.sessions.size + required <= MAX_SESSIONS) return [];
    const removable = [...this.sessions.values()]
      .filter(session => !session.process && ['exited', 'stopped', 'failed'].includes(session.status))
      .sort((left, right) => (
        (Date.parse(left.updatedAt || 0) || 0) - (Date.parse(right.updatedAt || 0) || 0)
      ));
    const removed = [];
    for (const session of removable) {
      if (this.sessions.size + required <= MAX_SESSIONS) break;
      this.sessions.delete(session.id);
      removed.push(session.id);
    }
    return removed;
  }

  reusableAgentBridge(options = {}) {
    const key = agentBridgeKey(options);
    if (!key) return null;
    const candidates = [...this.sessions.values()]
      .filter(session => agentBridgeKey(session.options) === key)
      .sort((left, right) => (
        (Date.parse(right.updatedAt || 0) || 0) - (Date.parse(left.updatedAt || 0) || 0)
      ));
    const running = candidates.find(session => session.process && session.status === 'running');
    if (running) return running;
    return candidates.find(session => session.options.sessionBackend === 'managed-tmux'
      && session.status === 'detached'
      && this.managedTmuxRuntime.exists(session.options)) || null;
  }

  deliveryRecord(deliveryId) {
    const id = normalizedDeliveryId(deliveryId);
    if (!id) return null;
    for (const session of this.sessions.values()) {
      const record = (session.deliveries || []).find(item => item.id === id);
      if (record) return { session, record };
    }
    return null;
  }

  preparedDeliveryRecord(target, fingerprint, sessionId = '') {
    if (!target || !fingerprint) return null;
    for (const session of this.sessions.values()) {
      if (sessionId && session.id !== sessionId) continue;
      const record = (session.deliveries || []).find(item => (
        item.state === 'prepared'
        && item.target === target
        && item.fingerprint === fingerprint
      ));
      if (record) return { session, record };
    }
    return null;
  }

  rememberDelivery(session, deliveryId, state, options = {}) {
    const id = normalizedDeliveryId(deliveryId);
    if (!id || !session) return null;
    const deliveries = Array.isArray(session.deliveries) ? session.deliveries : [];
    const previousDeliveries = deliveries.map(item => ({ ...item }));
    let record = deliveries.find(item => item.id === id);
    if (!record) {
      record = { id, state, timestamp: new Date().toISOString() };
      deliveries.push(record);
    } else {
      record.state = state;
      record.timestamp = new Date().toISOString();
    }
    if (options.target) record.target = cleanText(options.target, 400);
    if (/^[a-f0-9]{64}$/.test(String(options.fingerprint || ''))) record.fingerprint = options.fingerprint;
    session.deliveries = deliveries.slice(-MAX_DELIVERY_RECORDS);
    if (!this.persistNow() && options.required) {
      session.deliveries = previousDeliveries;
      throw rejectedDeliveryError(
        '전달 장부를 안전하게 저장하지 못해 질문을 보내지 않았습니다.',
        'DELIVERY_LEDGER_UNAVAILABLE',
        id,
      );
    }
    return record;
  }

  forgetDelivery(session, deliveryId) {
    const id = normalizedDeliveryId(deliveryId);
    if (!id || !session) return true;
    const previousDeliveries = (session.deliveries || []).map(item => ({ ...item }));
    session.deliveries = previousDeliveries.filter(item => item.id !== id);
    if (this.persistNow()) return true;
    session.deliveries = previousDeliveries;
    return false;
  }

  duplicateDeliveryResult(found, requestedDeliveryId = '') {
    const state = found.record.state === 'accepted' ? 'accepted' : 'unknown';
    return {
      ...publicSession(found.session, true),
      ok: true,
      reused: true,
      duplicate: true,
      promptSent: state === 'accepted',
      deliveryId: requestedDeliveryId || found.record.id,
      ...(requestedDeliveryId && requestedDeliveryId !== found.record.id
        ? { originalDeliveryId: found.record.id }
        : {}),
      deliveryState: state,
    };
  }

  create(rawOptions = {}) {
    const launchOptions = normalizeLaunchOptions(rawOptions, this.platform);
    const initialCommand = String(rawOptions.initialCommand || '').trim();
    const initialCommandInArgs = Boolean(initialCommand && rawOptions.initialCommandInArgs);
    const requestedDeliveryId = String(rawOptions.deliveryId || '').trim();
    const deliveryId = normalizedDeliveryId(requestedDeliveryId);
    if (requestedDeliveryId && !deliveryId) {
      throw rejectedDeliveryError('전달 요청 식별자가 올바르지 않습니다.');
    }
    if (initialCommand.length > MAX_INPUT_CHARS) {
      throw rejectedDeliveryError('한 번에 보낼 수 있는 입력 크기를 초과했습니다.', 'DELIVERY_TOO_LARGE', deliveryId);
    }
    const fingerprint = initialCommand ? deliveryFingerprint(initialCommand) : '';
    const deliveryTarget = agentBridgeKey(launchOptions)
      || `agent:${launchOptions.provider}:${launchOptions.cwd}`;
    const knownDelivery = deliveryId ? this.deliveryRecord(deliveryId) : null;
    if (knownDelivery) {
      if (agentBridgeKey(knownDelivery.session.options) !== agentBridgeKey(launchOptions)) {
        throw rejectedDeliveryError('이 전달 요청은 다른 AI 대화에 이미 사용됐습니다.', 'DELIVERY_ID_CONFLICT', deliveryId);
      }
      if (fingerprint && knownDelivery.record.fingerprint && knownDelivery.record.fingerprint !== fingerprint) {
        throw rejectedDeliveryError('이 전달 요청은 다른 내용에 이미 사용됐습니다.', 'DELIVERY_ID_CONFLICT', deliveryId);
      }
      return this.duplicateDeliveryResult(knownDelivery);
    }
    const matchingPrepared = deliveryId && fingerprint
      ? this.preparedDeliveryRecord(deliveryTarget, fingerprint)
      : null;
    if (matchingPrepared) return this.duplicateDeliveryResult(matchingPrepared, deliveryId);
    if (rawOptions.reuseBridge) {
      const reusable = this.reusableAgentBridge(launchOptions);
      if (reusable) {
        const reconnected = !reusable.process || reusable.status !== 'running';
        if (reconnected) this.reconnect(reusable.id);
        const delivery = initialCommand
          ? this.command(reusable.id, initialCommand, { deliveryId })
          : { ok: true, deliveryId, deliveryState: 'accepted' };
        return {
          ...publicSession(reusable, true),
          ...delivery,
          reused: true,
          reconnected,
          promptSent: Boolean(initialCommand),
        };
      }
    }
    this.deduplicateAgentBridgeSessions();
    this.reclaimFinishedSessions(1);
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`동시에 열 수 있는 명령창은 최대 ${MAX_SESSIONS}개입니다.`);
    const recoveryArgs = Array.isArray(rawOptions.recoveryArgs)
      ? resumableAgentArguments({
          type: launchOptions.type,
          provider: launchOptions.provider,
          args: rawOptions.recoveryArgs,
        })
      : null;
    const id = `terminal:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`;
    if (launchOptions.sessionBackend === 'managed-tmux' && !launchOptions.managedTmuxSession) {
      launchOptions.managedTmuxSession = safeTmuxName(`lta-${launchOptions.provider}-${id.split(':').slice(1).join('-')}`);
    }
    const options = recoveryArgs ? { ...launchOptions, args: recoveryArgs } : launchOptions;
    const spec = launchSpec(launchOptions, this.platform, this.agentProviders);
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
      deliveries: [],
      process: null,
      generation: 0,
      recoveryPending: false,
      recoveredAfterHostRestart: false,
      recoverySkippedReason: '',
    };
    this.sessions.set(id, session);
    try {
      if (deliveryId && initialCommandInArgs) this.rememberDelivery(session, deliveryId, 'prepared', {
        required: true,
        target: deliveryTarget,
        fingerprint,
      });
      this.spawn(session);
      if (deliveryId && initialCommandInArgs) this.rememberDelivery(session, deliveryId, 'accepted', {
        target: deliveryTarget,
        fingerprint,
      });
    } catch (error) {
      if (deliveryId && initialCommandInArgs && error?.terminalProcessStarted === false) {
        if (this.forgetDelivery(session, deliveryId)) {
          error = markDeliveryRejected(error, deliveryId);
        } else {
          error.deliveryId = deliveryId;
          error.deliveryState = 'unknown';
        }
      }
      if (error?.code === 'DELIVERY_LEDGER_UNAVAILABLE') this.sessions.delete(session.id);
      // Keep failed launches visible until the user explicitly closes them.
      // The failed session contains the startup error in replay and can be
      // inspected, restarted, or removed from the session terminal.
      this.persistNow();
      throw error;
    }
    this.persistNow();
    return {
      ...publicSession(session, true),
      reused: false,
      promptSent: initialCommandInArgs,
      deliveryId,
      deliveryState: deliveryId && initialCommandInArgs ? 'accepted' : '',
    };
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
    let processHandle = null;
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
      processHandle = this.pty().spawn(session.spec.file, session.spec.args, spawnOptions);
      session.process = processHandle;
      session.pid = Number(processHandle.pid) > 0 ? Number(processHandle.pid) : null;
      session.status = 'running';
      session.updatedAt = new Date().toISOString();
      processHandle.onData(data => {
        if (session.generation !== generation) return;
        const readyPid = Number(processHandle.pid);
        if (Number.isSafeInteger(readyPid) && readyPid > 0) session.pid = readyPid;
        const text = String(data || '');
        session.replay = unicodeSafeReplayTail(`${session.replay}${text}`);
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
      error.terminalProcessStarted = Boolean(processHandle);
      session.process = null;
      session.pid = null;
      session.status = 'failed';
      session.updatedAt = new Date().toISOString();
      const failureMessage = `\r\n[LoadToAgent] 명령창을 시작하지 못했습니다: ${error.message}\r\n`;
      session.replay = unicodeSafeReplayTail(`${session.replay}${failureMessage}`);
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

  command(id, value, deliveryOptions = {}) {
    const command = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
    const requestedDeliveryId = String(deliveryOptions?.deliveryId || '').trim();
    const deliveryId = normalizedDeliveryId(requestedDeliveryId);
    if (requestedDeliveryId && !deliveryId) {
      throw rejectedDeliveryError('전달 요청 식별자가 올바르지 않습니다.');
    }
    if (!command.trim()) return {
      ok: false,
      error: '명령을 입력하세요.',
      code: 'DELIVERY_EMPTY',
      deliveryId,
      deliveryState: 'rejected',
    };
    if (command.length > MAX_INPUT_CHARS) {
      throw rejectedDeliveryError('한 번에 보낼 수 있는 입력 크기를 초과했습니다.', 'DELIVERY_TOO_LARGE', deliveryId);
    }
    const fingerprint = deliveryFingerprint(command);
    const known = deliveryId ? this.deliveryRecord(deliveryId) : null;
    if (known) {
      if (known.session.id !== String(id || '')
        || (known.record.fingerprint && known.record.fingerprint !== fingerprint)) {
        throw rejectedDeliveryError(
          '이 전달 요청은 다른 명령창 또는 다른 내용에 이미 사용됐습니다.',
          'DELIVERY_ID_CONFLICT',
          deliveryId,
        );
      }
      return {
        ok: true,
        duplicate: true,
        deliveryId,
        deliveryState: known.record.state === 'accepted' ? 'accepted' : 'unknown',
      };
    }
    let session;
    try {
      session = this.required(id);
      const matchingPrepared = deliveryId
        ? (this.preparedDeliveryRecord(session.id, fingerprint, session.id)
          || this.preparedDeliveryRecord(agentBridgeKey(session.options), fingerprint, session.id))
        : null;
      if (matchingPrepared) return {
        ok: true,
        duplicate: true,
        deliveryId,
        originalDeliveryId: matchingPrepared.record.id,
        deliveryState: 'unknown',
      };
      if ((!session.process || session.status !== 'running')
        && session.options.sessionBackend === 'managed-tmux'
        && session.status === 'detached') {
        this.reconnect(session.id);
      }
      if (!session.process || session.status !== 'running') throw new Error('현재 실행 중인 명령창이 아닙니다.');
    } catch (error) {
      if (deliveryId) throw markDeliveryRejected(error, deliveryId);
      throw error;
    }
    if (deliveryId) this.rememberDelivery(session, deliveryId, 'prepared', {
      required: true,
      target: session.id,
      fingerprint,
    });
    try {
      const payload = command.includes('\n')
        ? `\x1b[200~${command}\x1b[201~\r`
        : `${command}\r`;
      session.process.write(payload);
    } catch (error) {
      if (deliveryId) {
        error.deliveryId = deliveryId;
        error.deliveryState = 'unknown';
      }
      throw error;
    }
    if (deliveryId) this.rememberDelivery(session, deliveryId, 'accepted', {
      target: session.id,
      fingerprint,
    });
    return { ok: true, deliveryId, deliveryState: 'accepted' };
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
    // The first-launch spec may contain an initial prompt. An explicit restart
    // must always rebuild from the persisted, prompt-free recovery options.
    session.spec = launchSpec(session.options, this.platform, this.agentProviders);
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
    // Reconnection is attach-only. It must never create a new provider process
    // if the managed tmux target disappears after the existence check.
    session.spec = managedTmuxAttachSpec(session.options, this.platform);
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
