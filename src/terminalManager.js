'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn: spawnChild } = require('child_process');
const { runBestEffort } = require('./diagnostics');
const { ManagedTmuxRuntime } = require('./managedTmuxRuntime');
const { createTmuxControlProxyHandle } = require('./tmuxControlProxy');
const { ensureMacNodePtyRuntime } = require('./nodePtyRuntime');
const {
  retentionDays,
  shouldRetainTerminalSession,
  restrictPathPermissions,
} = require('./dataRetention');

const MAX_SESSIONS = 24;
const MAX_INPUT_CHARS = 128 * 1024;
const MAX_AGENT_ARGUMENT_CHARS = 8 * 1024;
const MAX_AGENT_SESSION_ID_CHARS = 200;
const MAX_REPLAY_CHARS = 2 * 1024 * 1024;
const MAX_DELIVERY_RECORDS = 256;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_BRIDGE_ID_CHARS = 256;
const STORE_VERSION = 2;
// Full-screen AI TUIs redraw spinners and status bars continuously. Rewriting
// every retained replay (up to 64 MiB total) six times per second stalls the
// terminal-host event loop and delays input/host responses. Exit transitions
// and delivery ledgers still use persistNow(); streamed replay is coalesced to
// at most one durable checkpoint per second.
const PERSIST_DELAY_MS = 1_000;
// node-pty can deliver hundreds of small chunks during a single full-screen
// redraw or command burst. Once replay reaches its 2 MiB cap, concatenating
// and slicing the full string for every chunk creates visible event-loop
// stalls. Keep live delivery immediate, but fold replay chunks in bounded
// batches so the retained tail is copied at most once per batch.
const REPLAY_BATCH_MAX_CHARS = 256 * 1024;
const STORE_RENAME_RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80]);
const STORE_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const STORE_RENAME_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
const PTY_EXIT_CONFIRM_TIMEOUT_MS = 5_000;
const PTY_PID_READY_TIMEOUT_MS = 2_000;
// The exact-pane proxy performs an asynchronous WSL/tmux identity probe before
// it opens the control client. Cold WSL startup is part of this budget and must
// not be mistaken for a mismatched pane.
const TMUX_EXACT_PANE_READY_TIMEOUT_MS = 55_000;
const TMUX_PROXY_DELIVERY_TIMEOUT_MS = 12_000;
const TMUX_PROXY_DELIVERY_RECOVERY_GRACE_MS = 1_000;
const TMUX_PROXY_LARGE_DELIVERY_TIMEOUT_MS = 60_000;
const TERMINAL_TYPES = new Set(['powershell', 'cmd', 'shell', 'wsl', 'tmux', 'agent']);
const SESSION_BACKENDS = new Set(['direct', 'managed-tmux']);
const DEFAULT_TMUX_SOCKET = 'loadtoagent';
const WINDOWS_CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;
const AGENT_PROVIDERS = Object.freeze({
  claude: { command: 'claude', label: 'Claude' },
  codex: { command: 'codex', label: 'GPT · Codex' },
  gemini: { command: 'gemini', label: 'Gemini' },
  grok: { command: 'grok', label: 'Grok' },
});
const TERMINATION_INTENT_CODES = Object.freeze({
  kill: 'k', detach: 'd', stop: 's', close: 'c', retire: 't', restart: 'r', 'host-shutdown': 'h',
});
const BOUND_ORPHAN_ERROR_CODES = new Set([
  'AGENT_BOUND_ORPHAN_PID_LIVE',
  'AGENT_BOUND_ORPHAN_PID_UNCONFIRMED',
]);

function cleanText(value, max = 200) {
  return String(value == null ? '' : value).replace(/[\u0000\r\n]/g, ' ').trim().slice(0, max);
}

function normalizedArguments(value, maxChars = 2_000) {
  return Array.isArray(value)
    ? value.slice(0, 80).map(item => cleanText(item, maxChars))
    : [];
}

function normalizedDeliveryId(value) {
  const id = String(value == null ? '' : value).trim();
  return id.length <= 240 && /^[A-Za-z0-9:._-]+$/.test(id) ? id : '';
}

function normalizedCreationId(value) {
  return normalizedDeliveryId(value);
}

function deliveryFingerprint(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex');
}

function normalizedPromptText(value, limit = 6_000) {
  const text = String(value == null ? '' : value).replace(/\u0000/g, '').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function promptFingerprint(value) {
  const text = normalizedPromptText(value);
  return text ? deliveryFingerprint(text) : '';
}

function validFingerprint(value) {
  const fingerprint = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(fingerprint) ? fingerprint : '';
}

function creationPayloadFingerprint(options, details = {}) {
  const recoveryArgs = Array.isArray(details.recoveryArgs) ? details.recoveryArgs : null;
  const canonical = [
    'terminal-creation-v1',
    options.type,
    options.provider,
    options.cwd,
    options.distro,
    options.args,
    options.sessionBackend,
    options.tmuxSocket,
    options.managedTmuxSession,
    options.tmuxSession,
    options.tmuxSessionId,
    options.tmuxWindow,
    options.tmuxPane,
    options.tmuxPanePid,
    options.tmuxAgentPid,
    options.tmuxAgentProvider,
    options.tmuxAgentExternalId,
    options.tmuxAgentArgvHash,
    options.tmuxAgentStartTimeTicks,
    options.tmuxAgentProcessGroupId,
    options.bridgeId,
    options.agentConnectionSignature,
    options.title,
    Boolean(options.transient),
    options.cols,
    options.rows,
    String(details.initialCommand || ''),
    Boolean(details.initialCommandInArgs),
    recoveryArgs,
    Boolean(details.reuseBridge),
  ];
  return deliveryFingerprint(JSON.stringify(canonical));
}

function rejectedDeliveryError(message, code = 'DELIVERY_REJECTED', deliveryId = '') {
  const error = new Error(message);
  error.code = code;
  error.deliveryState = 'rejected';
  error.deliveryId = deliveryId;
  return error;
}

function rejectedCreationError(message, code = 'CREATION_REJECTED', creationId = '', deliveryId = '') {
  const error = rejectedDeliveryError(message, code, deliveryId);
  error.creationState = 'rejected';
  error.creationId = creationId;
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

function restoredRawInputDeliveries(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_DELIVERY_RECORDS).map(record => {
    const id = normalizedDeliveryId(record?.id);
    const timestamp = cleanText(record?.timestamp, 50);
    const fingerprint = String(record?.fingerprint || '').trim().toLowerCase();
    return id && /^[a-f0-9]{64}$/.test(fingerprint) ? {
      id,
      state: 'accepted',
      timestamp,
      fingerprint,
    } : null;
  }).filter(Boolean);
}

function validAgentSessionId(value) {
  const sessionId = String(value == null ? '' : value);
  return sessionId.length > 0
    && sessionId.length <= MAX_AGENT_SESSION_ID_CHARS
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId);
}

function replaceStoreFileSync(fileSystem, source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fileSystem.renameSync(source, destination);
      return;
    } catch (error) {
      const retryDelay = STORE_RENAME_RETRY_DELAYS_MS[attempt];
      if (!STORE_RENAME_RETRY_CODES.has(error?.code) || !retryDelay) throw error;
      // Windows scanners can briefly hold the previous JSON file between the
      // write and atomic replacement. A bounded retry keeps a verified
      // termination marker from failing without weakening fail-closed writes.
      Atomics.wait(STORE_RENAME_RETRY_SIGNAL, 0, 0, retryDelay);
    }
  }
}

function persistedTerminationIntent(value) {
  return TERMINATION_INTENT_CODES[cleanText(value, 30)] || '';
}

function restoredTerminationIntent(value) {
  const text = cleanText(value, 30);
  return Object.entries(TERMINATION_INTENT_CODES).find(([, code]) => code === text)?.[0]
    || (Object.hasOwn(TERMINATION_INTENT_CODES, text) ? text : '');
}

function validateAgentLaunchArguments(provider, value) {
  if (!Array.isArray(value)) return;
  const args = value.slice(0, 80).map(argument => String(argument == null ? '' : argument));
  if (args.some(argument => /[\u0000\r\n]/.test(argument))) {
    throw new Error('AI 명령 인자에는 줄바꿈 문자를 사용할 수 없습니다.');
  }
  if (provider === 'codex' && args[0] === 'resume') {
    const resumeIndex = args[1] === '--' ? 2 : 1;
    const suffix = args.slice(resumeIndex + 1);
    if (suffix.length > 1 || suffix.some(argument => argument === 'resume' || argument === '--resume')) {
      throw new Error('Codex 재개 인자는 resume, 선택적인 --, 대화 ID와 선택적인 질문 순서로 한 번만 지정해야 합니다.');
    }
    if (!validAgentSessionId(args[resumeIndex])) {
      throw new Error('AI 대화 ID 형식이 올바르지 않습니다. 영문자, 숫자, 점, 밑줄, 콜론, 하이픈만 사용할 수 있습니다.');
    }
    return;
  }
  if (provider !== 'claude' && provider !== 'gemini' && provider !== 'grok') return;
  const promptSeparator = args.indexOf('--');
  const invocationEnd = promptSeparator >= 0 ? promptSeparator : args.length;
  const resumeIndexes = [];
  for (let index = 0; index < invocationEnd; index += 1) {
    if (args[index] === '--resume') resumeIndexes.push(index);
  }
  if (!resumeIndexes.length) return;
  const canonicalWithoutPrompt = promptSeparator < 0 && args.length === 2;
  const canonicalWithPrompt = promptSeparator === 2 && args.length === 4;
  if (resumeIndexes.length !== 1 || resumeIndexes[0] !== 0 || (!canonicalWithoutPrompt && !canonicalWithPrompt)) {
    throw new Error('AI 재개 인자는 --resume, 대화 ID와 선택적인 -- 질문 순서로 한 번만 지정해야 합니다.');
  }
  if (!validAgentSessionId(args[1])) {
    throw new Error('AI 대화 ID 형식이 올바르지 않습니다. 영문자, 숫자, 점, 밑줄, 콜론, 하이픈만 사용할 수 있습니다.');
  }
}

function resumableAgentArguments(options = {}) {
  const args = normalizedArguments(options.args, MAX_AGENT_ARGUMENT_CHARS);
  if (options.type !== 'agent') return args;
  if (options.provider === 'codex' && args[0] === 'resume') {
    const sessionIndex = args[1] === '--' ? 2 : 1;
    if (!validAgentSessionId(args[sessionIndex])) return [];
    return args[1] === '--'
      ? ['resume', '--', args[sessionIndex]]
      : ['resume', args[sessionIndex]];
  }
  if (options.provider === 'claude' || options.provider === 'gemini' || options.provider === 'grok') {
    const resumeIndex = args.indexOf('--resume');
    if (resumeIndex < 0) return args;
    return validAgentSessionId(args[resumeIndex + 1]) ? ['--resume', args[resumeIndex + 1]] : [];
  }
  return args;
}

function agentResumeSessionId(options = {}) {
  if (options.type !== 'agent') return '';
  const args = resumableAgentArguments(options);
  if (options.provider === 'codex' && args[0] === 'resume') {
    const sessionId = args[args[1] === '--' ? 2 : 1];
    return validAgentSessionId(sessionId) ? sessionId : '';
  }
  const resumeIndex = args.indexOf('--resume');
  const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : '';
  return validAgentSessionId(sessionId) ? sessionId : '';
}

function agentBridgeKey(options = {}) {
  if (options.type !== 'agent' || !options.bridgeId || !options.provider) return '';
  return `${options.provider}:${options.bridgeId}`;
}

function agentResumeIdentityKey(options = {}, platform = process.platform) {
  const resumeSessionId = agentResumeSessionId(options);
  if (options.type !== 'agent' || !options.provider || !resumeSessionId) return '';
  const distro = cleanText(options.distro, 100).toLowerCase();
  const environment = platform === 'win32'
    ? (distro ? 'wsl' : 'windows')
    : (platform === 'darwin' ? 'macos' : 'linux');
  return JSON.stringify([String(options.provider).toLowerCase(), resumeSessionId, environment, distro]);
}

function normalizedEnvironmentKind(value) {
  const kind = cleanText(value, 30).toLowerCase();
  if (['darwin', 'mac', 'macos'].includes(kind)) return 'macos';
  if (['win32', 'win', 'windows'].includes(kind)) return 'windows';
  return ['wsl', 'linux'].includes(kind) ? kind : '';
}

function terminalEnvironmentKind(options = {}, platform = process.platform) {
  if (platform === 'win32') return options.distro ? 'wsl' : 'windows';
  return platform === 'darwin' ? 'macos' : 'linux';
}

function agentBindingSignature(binding = {}) {
  const canonical = JSON.stringify([
    String(binding.sessionId || ''),
    String(binding.provider || '').toLowerCase(),
    String(binding.externalId || '').trim(),
    String(binding.environment || '').toLowerCase(),
    String(binding.distro || '').trim().toLowerCase(),
  ]);
  return `acs1:${deliveryFingerprint(canonical)}`;
}

function normalizeAgentBinding(value, options, initialPromptFingerprint, platform = process.platform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const provider = cleanText(value.provider, 30).toLowerCase();
  const sessionId = cleanText(value.sessionId, MAX_AGENT_SESSION_ID_CHARS);
  const externalId = cleanText(value.externalId, 500);
  const environment = normalizedEnvironmentKind(value.environment);
  const distro = cleanText(value.distro, 100);
  const fingerprint = validFingerprint(value.promptFingerprint);
  const linkScore = Number(value.linkScore);
  const expectedEnvironment = terminalEnvironmentKind(options, platform);
  const expectedDistro = cleanText(options.distro, 100).toLowerCase();
  if (options.type !== 'agent'
    || options.sessionBackend !== 'direct'
    || !AGENT_PROVIDERS[provider]
    || provider !== options.provider
    || !validAgentSessionId(sessionId)
    || !externalId
    || sessionId !== `${provider}:${externalId}`
    || environment !== expectedEnvironment
    || (environment === 'wsl' && distro.toLowerCase() !== expectedDistro)
    || (environment !== 'wsl' && distro)
    || !fingerprint
    || fingerprint !== validFingerprint(initialPromptFingerprint)
    || !Number.isFinite(linkScore)
    || linkScore < 15_000) {
    return null;
  }
  const binding = {
    sessionId,
    externalId,
    provider,
    environment,
    distro,
    promptFingerprint: fingerprint,
    linkScore: Math.round(linkScore),
    boundAt: validTimestamp(value.boundAt, new Date().toISOString()),
  };
  binding.signature = agentBindingSignature(binding);
  return binding;
}

function isExactBoundAgentOptions(options = {}) {
  return options.type === 'agent'
    && Boolean(options.bridgeId)
    && Boolean(options.agentConnectionSignature)
    && Boolean(agentResumeSessionId(options));
}

function assertBoundAgentCommandSafe(options, value, deliveryId = '', agentBinding = null) {
  if (!isExactBoundAgentOptions(options) && !agentBinding) return;
  const command = String(value == null ? '' : value);
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(command)) {
    throw rejectedDeliveryError(
      '이 대화에 연결된 명령창에는 제어 문자가 포함된 입력을 보낼 수 없습니다.',
      'AGENT_BOUND_COMMAND_CONTROL_BLOCKED',
      deliveryId,
    );
  }
  if (command.split('\n').some(line => /^\s*\//u.test(line))) {
    throw rejectedDeliveryError(
      '현재 대화에 연결된 명령창에서는 제공사 슬래시 명령을 사용할 수 없습니다.',
      'AGENT_BOUND_META_COMMAND_BLOCKED',
      deliveryId,
    );
  }
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

function escapeWindowsCmdCommand(value) {
  return String(value == null ? '' : value).replace(WINDOWS_CMD_META_CHARACTERS, '^$1');
}

function escapeWindowsCmdArgument(value, doubleEscapeMetaCharacters = false) {
  const valueText = String(value == null ? '' : value);
  // Follow the Win32 argv quoting rules first, then protect every cmd.exe
  // metacharacter. npm .cmd shims parse the command twice while forwarding
  // %*, so those targets need the second caret-escaping pass as well.
  let argument = '"';
  let backslashes = 0;
  for (const character of valueText) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      argument += `${'\\'.repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    argument += `${'\\'.repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  argument += `${'\\'.repeat(backslashes * 2)}"`;
  argument = argument.replace(WINDOWS_CMD_META_CHARACTERS, '^$1');
  if (doubleEscapeMetaCharacters) argument = argument.replace(WINDOWS_CMD_META_CHARACTERS, '^$1');
  return argument;
}

function windowsBatchLaunchSpec(command, args, options, provider) {
  const commandLine = [
    escapeWindowsCmdCommand(path.normalize(command)),
    // A batch agent launcher necessarily adds another cmd.exe parse (and npm
    // shims forward through %*), so protect metacharacters for both passes.
    ...args.map(argument => escapeWindowsCmdArgument(argument, true)),
  ].join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    // node-pty accepts a pre-escaped command-line string and appends it
    // verbatim. Keeping this as one string prevents its argv serializer from
    // undoing cmd.exe's required caret escaping.
    args: `/d /v:off /s /c "${commandLine}"`,
    cwd: options.cwd,
    label: provider.label,
  };
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

function ptyTreeUnconfirmedError(cause = null) {
  const error = new Error('PTY process-tree 전체 종료를 확인하지 못했습니다.');
  error.code = 'PTY_TREE_EXIT_UNCONFIRMED';
  if (cause) error.cause = cause;
  return error;
}

function terminatePosixPtyGroup(handle, pid, timeoutMs, runtime = {}) {
  const killProcess = typeof runtime.killProcess === 'function'
    ? runtime.killProcess
    : process.kill.bind(process);
  const requestedTimeout = Math.floor(Number(timeoutMs));
  const waitMs = Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0
    ? requestedTimeout
    : PTY_EXIT_CONFIRM_TIMEOUT_MS;
  const signal = String(runtime.posixSignal || 'SIGHUP');
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + waitMs;
    let timer = null;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (error) reject(error);
      else resolve();
    };
    const groupExists = () => {
      try {
        killProcess(-pid, 0);
        return true;
      } catch (error) {
        if (error?.code === 'ESRCH') return false;
        if (error?.code === 'EPERM') return true;
        throw error;
      }
    };
    const check = () => {
      if (settled) return;
      let exists;
      try {
        exists = groupExists();
      } catch (cause) {
        finish(ptyTreeUnconfirmedError(cause));
        return;
      }
      if (!exists) {
        finish();
        return;
      }
      if (Date.now() >= deadline) {
        const cause = new Error('POSIX PTY process group 종료를 제한 시간 안에 확인하지 못했습니다.');
        cause.code = 'POSIX_PROCESS_GROUP_EXIT_TIMEOUT';
        finish(ptyTreeUnconfirmedError(cause));
        return;
      }
      timer = setTimeout(check, 20);
    };
    try {
      killProcess(-pid, signal);
    } catch (cause) {
      if (cause?.code === 'ESRCH' && !handle.__loadtoagentExited) {
        const missingGroup = new Error('실행 중인 PTY 루트의 POSIX process group을 찾지 못했습니다.');
        missingGroup.code = 'POSIX_PROCESS_GROUP_UNCONFIRMED';
        missingGroup.cause = cause;
        runBestEffort('terminal-posix-group-missing-fallback', () => handle.kill());
        finish(ptyTreeUnconfirmedError(missingGroup));
        return;
      }
      if (cause?.code !== 'ESRCH') {
        runBestEffort('terminal-posix-group-fallback', () => {
          if (!handle.__loadtoagentExited) handle.kill();
        });
        finish(ptyTreeUnconfirmedError(cause));
        return;
      }
    }
    check();
  });
}

function waitForPtyExitAfter(handle, terminate, timeoutMs = PTY_EXIT_CONFIRM_TIMEOUT_MS, options = {}) {
  if (!handle) return Promise.resolve({ ok: true, alreadyExited: true });
  if (handle.__loadtoagentExited && !options.alwaysTerminate) {
    return Promise.resolve({ ok: true, alreadyExited: true });
  }
  const requestedTimeout = Math.floor(Number(timeoutMs));
  const waitMs = Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0
    ? requestedTimeout
    : PTY_EXIT_CONFIRM_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let exitConfirmed = false;
    let terminationComplete = false;
    let disposable = null;
    let registrationError = null;
    let timer = null;
    const disposeListener = listener => {
      if (!listener || typeof listener.dispose !== 'function') return;
      runBestEffort('terminal-exit-listener-dispose', () => listener.dispose());
    };
    const finish = (error = null, result = { ok: true, exited: true }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      disposeListener(disposable);
      disposable = null;
      if (error) reject(error);
      else resolve(result);
    };
    const armTimeout = () => {
      if (settled || timer) return;
      timer = setTimeout(() => {
        const error = new Error('PTY 프로그램 종료를 제한 시간 안에 확인하지 못했습니다.');
        error.code = 'PTY_EXIT_CONFIRM_TIMEOUT';
        finish(error);
      }, waitMs);
    };
    const completeIfReady = () => {
      if (exitConfirmed && terminationComplete) finish();
    };
    const confirmed = () => {
      handle.__loadtoagentExited = true;
      exitConfirmed = true;
      completeIfReady();
    };
    try {
      if (typeof handle.onExit === 'function') {
        const registered = handle.onExit(confirmed);
        if (settled) disposeListener(registered);
        else disposable = registered;
      } else {
        registrationError = new Error('PTY 프로그램 종료 이벤트를 확인할 수 없습니다.');
        registrationError.code = 'PTY_EXIT_CONFIRM_UNAVAILABLE';
      }
    } catch (error) {
      registrationError = error;
    }
    if (handle.__loadtoagentExited) confirmed();
    let termination;
    try {
      termination = typeof terminate === 'function' ? terminate() : null;
    } catch (error) {
      finish(error);
      return;
    }
    const afterTermination = () => {
      if (settled) return;
      terminationComplete = true;
      if (handle.__loadtoagentExited) confirmed();
      if (registrationError) {
        finish(registrationError);
        return;
      }
      if (exitConfirmed) {
        completeIfReady();
        return;
      }
      armTimeout();
    };
    if (termination && typeof termination.then === 'function') {
      Promise.resolve(termination).then(afterTermination, finish);
    } else {
      afterTermination();
    }
  });
}

function waitForPtyPid(handle, pid, timeoutMs = PTY_PID_READY_TIMEOUT_MS) {
  const currentPid = () => {
    const candidates = [Number(handle?.pid), Number(pid)];
    return candidates.find(candidate => Number.isSafeInteger(candidate) && candidate > 0) || null;
  };
  const immediate = currentPid();
  if (immediate) return immediate;
  const requestedTimeout = Math.floor(Number(timeoutMs));
  const waitMs = Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0
    ? requestedTimeout
    : PTY_PID_READY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + waitMs;
    let timer = null;
    const finish = (error, resolvedPid = null) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (error) reject(error);
      else resolve(resolvedPid);
    };
    const check = () => {
      const readyPid = currentPid();
      if (readyPid) {
        finish(null, readyPid);
        return;
      }
      if (Date.now() >= deadline) {
        const cause = new Error('PTY process-tree PID가 준비될 때까지 기다렸지만 확인하지 못했습니다.');
        cause.code = 'PTY_PID_READY_TIMEOUT';
        finish(ptyTreeUnconfirmedError(cause));
        return;
      }
      timer = setTimeout(check, 10);
    };
    check();
  });
}

function killPtyTree(handle, pid, exitTimeoutMs = PTY_EXIT_CONFIRM_TIMEOUT_MS, runtime = {}) {
  if (!handle) return Promise.resolve({ ok: true, alreadyExited: true });
  const numericPid = Number(pid);
  const platform = runtime.platform || process.platform;
  const spawnProcess = runtime.spawnChild || spawnChild;
  const probeProcess = typeof runtime.processKill === 'function'
    ? runtime.processKill
    : process.kill.bind(process);
  if (platform === 'win32' && (!Number.isSafeInteger(numericPid) || numericPid <= 0)) {
    const error = ptyTreeUnconfirmedError(new Error('Windows process-tree PID를 확인할 수 없습니다.'));
    try {
      if (!handle.__loadtoagentExited) handle.kill();
    } catch (fallbackError) {
      error.cause = fallbackError;
    }
    return Promise.reject(error);
  }
  if (platform !== 'win32') {
    if (!Number.isSafeInteger(numericPid) || numericPid <= 0) {
      const error = ptyTreeUnconfirmedError(new Error('POSIX PTY process group PID를 확인할 수 없습니다.'));
      runBestEffort('terminal-posix-root-fallback', () => {
        if (!handle.__loadtoagentExited) handle.kill();
      });
      return Promise.reject(error);
    }
    const handleSignal = String(handle.__loadtoagentPosixSignal || '');
    const preferredSignal = runtime.posixSignal
      || (['SIGHUP', 'SIGTERM'].includes(handleSignal) ? handleSignal : '');
    const posixRuntime = preferredSignal ? { ...runtime, posixSignal: preferredSignal } : runtime;
    return waitForPtyExitAfter(
      handle,
      () => terminatePosixPtyGroup(handle, numericPid, exitTimeoutMs, posixRuntime),
      exitTimeoutMs,
      { alwaysTerminate: true },
    ).then(result => ({ ...result, processGroup: true }))
      .catch(error => {
        if (error?.code === 'PTY_TREE_EXIT_UNCONFIRMED') throw error;
        throw ptyTreeUnconfirmedError(error);
      });
  }
  let treeOperationFinished = false;
  let taskkillSucceeded = false;
  let usedFallback = false;
  let killer = null;
  let taskkillTimer = null;
  const rootProcessAbsent = () => {
    try {
      probeProcess(numericPid, 0);
      return false;
    } catch (error) {
      return error?.code === 'ESRCH';
    }
  };
  const terminateTree = () => new Promise((resolve, reject) => {
    let settled = false;
    let fallbackStarted = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (taskkillTimer) clearTimeout(taskkillTimer);
      taskkillTimer = null;
      if (error) reject(error);
      else resolve();
    };
    const fallback = (cause = null) => {
      if (settled || fallbackStarted) return;
      // taskkill reports ERROR_NOT_FOUND when the PTY exits naturally between
      // the close request and its process-tree walk. Confirm that exact root
      // PID is now absent before treating the non-zero helper exit as success.
      if (rootProcessAbsent()) {
        finish();
        return;
      }
      fallbackStarted = true;
      usedFallback = true;
      const failure = ptyTreeUnconfirmedError(cause);
      if (taskkillTimer) clearTimeout(taskkillTimer);
      taskkillTimer = null;
      if (treeOperationFinished) {
        finish(failure);
        return;
      }
      try {
        if (!handle.__loadtoagentExited) handle.kill();
      } catch (error) {
        failure.cause = error;
      }
      // node-pty only acknowledges the root PTY. Without taskkill exit 0 the
      // descendant tree is still unconfirmed, so never upgrade fallback to success.
      finish(failure);
    };
    try {
      killer = spawnProcess('taskkill.exe', ['/PID', String(numericPid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => fallback());
      killer.once('exit', code => {
        if (settled || fallbackStarted) return;
        if (code === 0) {
          taskkillSucceeded = true;
          finish();
          return;
        }
        fallback();
      });
      const requestedTimeout = Math.floor(Number(exitTimeoutMs));
      const waitMs = Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout
        : PTY_EXIT_CONFIRM_TIMEOUT_MS;
      taskkillTimer = setTimeout(() => {
        const error = new Error('Windows process-tree 종료 프로그램이 제한 시간 안에 끝나지 않았습니다.');
        error.code = 'TASKKILL_TIMEOUT';
        fallback(error);
        // A kill request for the helper is not an exit acknowledgement. The
        // fallback above has already failed closed before this best-effort cleanup.
        runBestEffort('terminal-taskkill-timeout', () => killer?.kill());
      }, waitMs);
    } catch (_treeKillUnavailable) {
      // Confirm that the PTY fallback was invoked before reporting completion.
      fallback();
    }
  });
  return waitForPtyExitAfter(handle, terminateTree, exitTimeoutMs, { alwaysTerminate: true })
    .then(result => ({
      ...result,
      ...(taskkillSucceeded ? { taskkill: true } : {}),
      ...(usedFallback ? { fallback: true } : {}),
    }))
    .finally(() => {
      treeOperationFinished = true;
      if (taskkillTimer) clearTimeout(taskkillTimer);
      taskkillTimer = null;
    });
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
  if ((type === 'wsl' || (platform === 'win32' && type === 'tmux')) && !distro) {
    throw new Error('작업을 실행할 Linux 환경을 선택하세요.');
  }
  const tmuxSession = cleanText(options.tmuxSession, 100);
  const tmuxSessionId = cleanText(options.tmuxSessionId, 100);
  const tmuxWindow = cleanText(options.tmuxWindow, 100);
  const tmuxPane = cleanText(options.tmuxPane, 100);
  const requestedTmuxPanePid = options.tmuxPanePid == null || options.tmuxPanePid === ''
    ? null
    : Number(options.tmuxPanePid);
  const tmuxPanePid = Number.isSafeInteger(requestedTmuxPanePid) && requestedTmuxPanePid > 0
    ? requestedTmuxPanePid
    : null;
  if (type === 'tmux' && !tmuxSession) throw new Error('연결할 명령창 묶음을 선택하세요.');
  if (tmuxWindow && !/^@\d+$/.test(tmuxWindow)) throw new Error('연결할 tmux window 식별자가 올바르지 않습니다.');
  if (tmuxPane && !/^%\d+$/.test(tmuxPane)) throw new Error('연결할 tmux pane 식별자가 올바르지 않습니다.');
  if (tmuxSessionId && !/^\$\d+$/.test(tmuxSessionId)) throw new Error('연결할 tmux session 식별자가 올바르지 않습니다.');
  if (requestedTmuxPanePid !== null && tmuxPanePid === null) throw new Error('연결할 tmux pane PID가 올바르지 않습니다.');
  if (tmuxPanePid && !tmuxPane) throw new Error('tmux pane PID에는 pane 식별자가 필요합니다.');
  const rawBridgeId = String(options.bridgeId == null ? '' : options.bridgeId).trim();
  if (rawBridgeId.length > MAX_BRIDGE_ID_CHARS || /[\u0000-\u001f\u007f]/u.test(rawBridgeId)) {
    throw new Error('AI 대화 연결 식별자가 올바르지 않습니다.');
  }
  const bridgeId = rawBridgeId;
  const agentConnectionSignature = cleanText(options.agentConnectionSignature, 1_000);
  const rawTmuxAgentIdentity = [
    options.tmuxAgentPid,
    options.tmuxAgentProvider,
    options.tmuxAgentExternalId,
    options.tmuxAgentArgvHash,
    options.tmuxAgentStartTimeTicks,
    options.tmuxAgentProcessGroupId,
  ];
  const hasTmuxAgentIdentity = rawTmuxAgentIdentity.some(value => (
    value !== undefined && value !== null && String(value) !== ''
  ));
  let tmuxAgentPid = null;
  let tmuxAgentProvider = '';
  let tmuxAgentExternalId = '';
  let tmuxAgentArgvHash = '';
  let tmuxAgentStartTimeTicks = '';
  let tmuxAgentProcessGroupId = null;
  if (hasTmuxAgentIdentity) {
    if (rawTmuxAgentIdentity.some(value => value === undefined || value === null || String(value) === '')) {
      throw new Error('tmux AI 프로세스 신원 정보가 완전하지 않습니다.');
    }
    tmuxAgentPid = Number(options.tmuxAgentPid);
    tmuxAgentProvider = String(options.tmuxAgentProvider).trim().toLowerCase();
    tmuxAgentExternalId = String(options.tmuxAgentExternalId).trim();
    tmuxAgentArgvHash = String(options.tmuxAgentArgvHash).trim().toLowerCase();
    tmuxAgentStartTimeTicks = String(options.tmuxAgentStartTimeTicks).trim();
    tmuxAgentProcessGroupId = Number(options.tmuxAgentProcessGroupId);
    if (!Number.isSafeInteger(tmuxAgentPid) || tmuxAgentPid <= 0) throw new Error('tmux AI 프로세스 PID가 올바르지 않습니다.');
    if (!AGENT_PROVIDERS[tmuxAgentProvider]) throw new Error('tmux AI 프로세스 종류가 올바르지 않습니다.');
    if (!tmuxAgentExternalId || tmuxAgentExternalId.length > 500
      || /[\u0000-\u001f\u007f]/u.test(tmuxAgentExternalId)) {
      throw new Error('tmux AI 대화 식별자가 올바르지 않습니다.');
    }
    if (!/^[a-f0-9]{64}$/u.test(tmuxAgentArgvHash)) throw new Error('tmux AI 실행 인자 지문이 올바르지 않습니다.');
    if (!/^[1-9][0-9]{0,30}$/u.test(tmuxAgentStartTimeTicks)) throw new Error('tmux AI 프로세스 시작 시각이 올바르지 않습니다.');
    if (!Number.isSafeInteger(tmuxAgentProcessGroupId) || tmuxAgentProcessGroupId <= 0) {
      throw new Error('tmux AI 프로세스 그룹이 올바르지 않습니다.');
    }
    if (!tmuxPane || !tmuxPanePid) throw new Error('tmux AI 프로세스 신원에는 정확한 pane 정보가 필요합니다.');
  }
  if (type === 'tmux' && tmuxPane && (bridgeId || agentConnectionSignature) && !hasTmuxAgentIdentity) {
    throw new Error('AI 대화용 tmux 연결에는 실제 AI 프로세스 신원이 필요합니다.');
  }
  const provider = cleanText(options.provider, 30).toLowerCase();
  if (type === 'agent' && !AGENT_PROVIDERS[provider]) throw new Error('선택한 AI 종류는 사용할 수 없습니다.');
  if (type === 'agent') validateAgentLaunchArguments(provider, options.args);
  const requestedBackend = cleanText(options.sessionBackend || options.backend, 40);
  const managedByDefault = type === 'agent'
    && !options.transient
    && (platform !== 'win32' || Boolean(distro));
  let sessionBackend = SESSION_BACKENDS.has(requestedBackend)
    ? requestedBackend
    : (managedByDefault ? 'managed-tmux' : 'direct');
  if (sessionBackend === 'managed-tmux' && type !== 'agent') {
    throw new Error('여러 명령창 기능은 AI 명령창에서만 사용할 수 있습니다.');
  }
  const args = normalizedArguments(options.args, MAX_AGENT_ARGUMENT_CHARS);
  if (type === 'agent' && bridgeId && agentConnectionSignature) {
    const canonicalResumeArgs = resumableAgentArguments({ type, provider, args });
    if (!agentResumeSessionId({ type, provider, args })
      || JSON.stringify(args) !== JSON.stringify(canonicalResumeArgs)) {
      throw new Error('대화에 연결된 AI 명령창은 질문이 섞이지 않은 정확한 재개 인자만 사용할 수 있습니다.');
    }
    // A shared tmux server would let an external client bypass command guards
    // and switch provider history inside the same PTY. Signed conversation
    // bindings therefore always use a direct app-owned PTY.
    sessionBackend = 'direct';
  }
  return {
    type,
    cwd: ['powershell', 'cmd', 'shell', 'agent'].includes(type) && !wslAgent ? path.resolve(localCwd) : suppliedCwd,
    distro,
    tmuxSession,
    tmuxSessionId,
    tmuxWindow,
    tmuxPane,
    tmuxPanePid,
    tmuxAgentPid,
    tmuxAgentProvider,
    tmuxAgentExternalId,
    tmuxAgentArgvHash,
    tmuxAgentStartTimeTicks,
    tmuxAgentProcessGroupId,
    provider,
    args,
    sessionBackend,
    tmuxSocket: sessionBackend === 'managed-tmux'
      ? safeTmuxName(options.tmuxSocket, DEFAULT_TMUX_SOCKET)
      : '',
    managedTmuxSession: sessionBackend === 'managed-tmux'
      ? safeTmuxName(options.managedTmuxSession)
      : '',
    bridgeId,
    agentConnectionSignature,
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
        return windowsBatchLaunchSpec(command, [...(provider.args || []), ...options.args], options, provider);
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
  const sessionTarget = `=${options.tmuxSession}`;
  if (options.tmuxPane) {
    if (!options.tmuxWindow) throw new Error('정확한 tmux pane 연결에는 window 식별자가 필요합니다.');
    if (!options.tmuxPanePid) throw new Error('정확한 tmux pane 연결에는 관측된 PID가 필요합니다.');
    const nonce = crypto.randomBytes(12).toString('hex');
    const proxyChannel = crypto.randomBytes(18).toString('hex');
    const readyMarkerPrefix = `LTA_TMUX_READY_${nonce}:`;
    const readyMarker = `${readyMarkerPrefix}${options.tmuxPane}`;
    const proxyOptions = Buffer.from(JSON.stringify({
      distro: options.distro || '',
      session: options.tmuxSession,
      sessionId: options.tmuxSessionId || '',
      window: options.tmuxWindow || '',
      pane: options.tmuxPane,
      panePid: options.tmuxPanePid,
      agentPid: options.tmuxAgentPid || '',
      agentProvider: options.tmuxAgentProvider || '',
      agentExternalId: options.tmuxAgentExternalId || '',
      agentArgvHash: options.tmuxAgentArgvHash || '',
      agentStartTimeTicks: options.tmuxAgentStartTimeTicks || '',
      agentProcessGroupId: options.tmuxAgentProcessGroupId || '',
      channel: proxyChannel,
      readyMarker,
      cols: options.cols,
      rows: options.rows,
    }), 'utf8').toString('base64url');
    return {
      file: process.execPath,
      args: [path.join(__dirname, 'tmuxControlProxy.js'), proxyOptions],
      cwd: options.cwd || os.homedir(),
      env: { ELECTRON_RUN_AS_NODE: '1' },
      label: `여러 명령창 · ${options.tmuxSession}`,
      readyMarker,
      readyMarkerPrefix,
      exactPaneProxy: true,
      proxyChannel,
      exactTmuxSession: options.tmuxSession,
      exactTmuxSessionId: options.tmuxSessionId,
      exactTmuxWindow: options.tmuxWindow,
      exactTmuxPane: options.tmuxPane,
      exactTmuxPanePid: options.tmuxPanePid,
      exactTmuxAgentPid: options.tmuxAgentPid,
      exactTmuxDistro: options.distro || '',
    };
  }
  const script = `exec tmux attach-session -f active-pane -t ${shellQuote(sessionTarget)}`;
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
  const binding = session.agentBinding || null;
  const value = {
    id: session.id,
    type: session.options.type,
    title: session.title,
    shell: session.shell,
    cwd: session.options.cwd,
    distro: session.options.distro,
    tmuxSession: session.options.tmuxSession,
    tmuxSessionId: session.options.tmuxSessionId,
    tmuxWindow: session.options.tmuxWindow,
    tmuxPane: session.options.tmuxPane,
    tmuxPanePid: session.options.tmuxPanePid,
    tmuxAgentPid: session.options.tmuxAgentPid,
    tmuxAgentProvider: session.options.tmuxAgentProvider,
    tmuxAgentExternalId: session.options.tmuxAgentExternalId,
    tmuxAgentArgvHash: session.options.tmuxAgentArgvHash,
    tmuxAgentStartTimeTicks: session.options.tmuxAgentStartTimeTicks,
    tmuxAgentProcessGroupId: session.options.tmuxAgentProcessGroupId,
    provider: session.options.provider,
    backend: session.options.sessionBackend,
    tmuxSocket: session.options.tmuxSocket,
    managedTmuxSession: session.options.managedTmuxSession,
    bridgeId: binding?.sessionId || session.options.bridgeId,
    agentConnectionSignature: binding?.signature || session.options.agentConnectionSignature,
    agentResumeSessionId: agentResumeSessionId(session.options),
    agentLinkedSessionId: binding?.sessionId || '',
    agentLinkedExternalId: binding?.externalId || '',
    agentLinkedEnvironment: binding?.environment || '',
    agentLinkedDistro: binding?.distro || '',
    initialPromptFingerprint: session.initialPromptFingerprint || '',
    creationId: session.creationId || '',
    conversationBound: Boolean(binding) || isExactBoundAgentOptions(session.options),
    transient: Boolean(session.options.transient),
    background: session.options.type === 'agent',
    recoveredAfterHostRestart: Boolean(session.recoveredAfterHostRestart),
    recoverySkippedReason: session.recoverySkippedReason || '',
    terminationPending: Boolean(session.terminationPending || session.retiring),
    terminationIntent: String(session.terminationIntent || ''),
    terminationUncertain: Boolean(session.terminationUncertain),
    terminationErrorCode: session.terminationUncertain ? String(session.terminationErrorCode || '') : '',
    terminationErrorMessage: session.terminationUncertain ? String(session.terminationErrorMessage || '') : '',
    pid: session.pid,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    exitCode: session.exitCode,
    signal: session.signal,
    outputSequence: Number.isSafeInteger(session.outputSequence) ? session.outputSequence : 0,
    cols: session.cols,
    rows: session.rows,
    fixedGrid: Boolean(session.spec?.exactPaneProxy || (session.options.type === 'tmux' && session.options.tmuxPane)),
  };
  if (includeReplay) value.replay = flushSessionReplay(session);
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

function flushSessionReplay(session) {
  if (!session) return '';
  const chunks = Array.isArray(session.replayPendingChunks) ? session.replayPendingChunks : [];
  if (chunks.length) {
    const pending = chunks.length === 1 ? chunks[0] : chunks.join('');
    session.replay = unicodeSafeReplayTail(`${String(session.replay || '')}${pending}`);
  }
  session.replayPendingChunks = [];
  session.replayPendingChars = 0;
  return String(session.replay || '');
}

function appendSessionReplay(session, value, { immediate = false } = {}) {
  const text = String(value == null ? '' : value);
  if (!session || !text) return;
  if (immediate) {
    flushSessionReplay(session);
    session.replay = unicodeSafeReplayTail(`${String(session.replay || '')}${text}`);
    return;
  }
  if (!Array.isArray(session.replayPendingChunks)) session.replayPendingChunks = [];
  session.replayPendingChunks.push(text);
  session.replayPendingChars = (Number(session.replayPendingChars) || 0) + text.length;
  if (session.replayPendingChars >= REPLAY_BATCH_MAX_CHARS) {
    flushSessionReplay(session);
  }
}

function resetSessionReplay(session) {
  if (!session) return;
  session.replayPendingChunks = [];
  session.replayPendingChars = 0;
  session.replay = '';
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
    tmuxSessionId: cleanText(value.tmuxSessionId, 100),
    tmuxWindow: cleanText(value.tmuxWindow, 100),
    tmuxPane: cleanText(value.tmuxPane, 100),
    tmuxPanePid: value.tmuxPanePid,
    tmuxAgentPid: value.tmuxAgentPid,
    tmuxAgentProvider: cleanText(value.tmuxAgentProvider, 30),
    tmuxAgentExternalId: cleanText(value.tmuxAgentExternalId, 500),
    tmuxAgentArgvHash: cleanText(value.tmuxAgentArgvHash, 64),
    tmuxAgentStartTimeTicks: cleanText(value.tmuxAgentStartTimeTicks, 31),
    tmuxAgentProcessGroupId: value.tmuxAgentProcessGroupId,
    provider,
    args: resumableAgentArguments({ type, provider, args: value.args }),
    sessionBackend: SESSION_BACKENDS.has(value.sessionBackend)
      ? value.sessionBackend
      : (storeVersion < STORE_VERSION ? 'direct' : undefined),
    tmuxSocket: cleanText(value.tmuxSocket, 100),
    managedTmuxSession: cleanText(value.managedTmuxSession, 100),
    bridgeId: String(value.bridgeId == null ? '' : value.bridgeId).trim(),
    agentConnectionSignature: cleanText(value.agentConnectionSignature, 1_000),
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
    pid: Number.isSafeInteger(Number(session.pid)) && Number(session.pid) > 0 ? Number(session.pid) : null,
    outputSequence: Number.isSafeInteger(session.outputSequence) ? session.outputSequence : 0,
    replay: flushSessionReplay(session),
    deliveries: restoredDeliveries(session.deliveries),
    rawInputDeliveries: restoredRawInputDeliveries(session.rawInputDeliveries),
    initialPromptFingerprint: validFingerprint(session.initialPromptFingerprint),
    creationId: normalizedCreationId(session.creationId),
    creationPayloadFingerprint: validFingerprint(session.creationPayloadFingerprint),
    agentBinding: session.agentBinding ? { ...session.agentBinding } : null,
    terminationPending: Boolean(session.terminationPending || session.retiring),
    terminationIntent: persistedTerminationIntent(session.terminationIntent),
    terminationUncertain: Boolean(session.terminationUncertain),
    terminationErrorCode: session.terminationUncertain ? cleanText(session.terminationErrorCode, 100) : '',
    terminationErrorMessage: session.terminationUncertain ? cleanText(session.terminationErrorMessage, 500) : '',
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
    this.tmuxControlProxyFactory = options.tmuxControlProxyFactory || createTmuxControlProxyHandle;
    this.killTree = options.killTree || killPtyTree;
    this.processKill = typeof options.processKill === 'function' ? options.processKill : process.kill.bind(process);
    this.ptyPidReadyTimeoutMs = Math.max(50, Number(options.ptyPidReadyTimeoutMs) || PTY_PID_READY_TIMEOUT_MS);
    this.tmuxProxyDeliveryTimeoutMs = Math.max(
      10,
      Number(options.tmuxProxyDeliveryTimeoutMs) || TMUX_PROXY_DELIVERY_TIMEOUT_MS,
    );
    this.tmuxProxyDeliveryRecoveryGraceMs = Math.max(
      10,
      Number(options.tmuxProxyDeliveryRecoveryGraceMs) || TMUX_PROXY_DELIVERY_RECOVERY_GRACE_MS,
    );
    this.tmuxProxyLargeDeliveryTimeoutMs = Math.max(
      this.tmuxProxyDeliveryTimeoutMs,
      Number(options.tmuxProxyLargeDeliveryTimeoutMs) || TMUX_PROXY_LARGE_DELIVERY_TIMEOUT_MS,
    );
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
    this.transitionPromises = new Map();
    this.loadPersistedSessions();
    this.reconcilePersistedBoundDirectSessions();
    this.reconcilePersistedManagedSessions();
    this.deduplicateAgentBridgeSessions({ bootstrap: true });
    this.deduplicateAgentResumeSessions({ bootstrap: true });
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
          const initialPromptFingerprint = validFingerprint(value.initialPromptFingerprint);
          const rawCreationId = String(value.creationId || '').trim();
          const creationId = normalizedCreationId(rawCreationId);
          const creationPayloadFingerprint = validFingerprint(value.creationPayloadFingerprint);
          if ((rawCreationId && !creationId)
            || Boolean(creationId) !== Boolean(creationPayloadFingerprint)) {
            throw new Error('저장된 명령창 생성 요청 식별자가 올바르지 않습니다.');
          }
          const agentBinding = normalizeAgentBinding(
            value.agentBinding,
            options,
            initialPromptFingerprint,
            this.platform,
          );
          const invalidAgentBinding = Boolean(value.agentBinding && !agentBinding);
          if (invalidAgentBinding) {
            // Preserve the terminal/replay but fail closed on a corrupt or
            // stale inferred conversation identity. The canonical resume args
            // and signature were derived from that binding, so retaining them
            // would silently auto-resume an identity we just rejected.
            options.bridgeId = '';
            options.agentConnectionSignature = '';
            options.args = [];
          } else if (agentBinding) {
            // The validated binding is authoritative. Rebuild every derived
            // writable/recovery field instead of trusting separately persisted
            // options that could be stale, empty, or tampered.
            options.bridgeId = agentBinding.sessionId;
            options.agentConnectionSignature = agentBinding.signature;
            options.args = agentBinding.provider === 'codex'
              ? ['resume', agentBinding.externalId]
              : ['--resume', agentBinding.externalId];
          }
          const interruptedTransition = Boolean(value.terminationPending) || value.status === 'stopping';
          const terminationUncertain = Boolean(value.terminationUncertain) || interruptedTransition;
          const status = terminationUncertain
            ? 'stopping'
            : (options.sessionBackend === 'managed-tmux' && ['detached', 'stopped'].includes(value.status)
              ? value.status
              : (value.status === 'failed' ? 'failed' : 'exited'));
          this.sessions.set(id, {
            id,
            options,
            spec: null,
            title: cleanText(value.title, 100) || options.title || options.tmuxSession || options.provider || options.type,
            shell: cleanText(value.shell, 2_000),
            pid: Number.isSafeInteger(Number(value.pid)) && Number(value.pid) > 0 ? Number(value.pid) : null,
            status,
            createdAt,
            updatedAt,
            exitCode: Number.isFinite(value.exitCode) ? value.exitCode : null,
            signal: Number.isFinite(value.signal) ? value.signal : null,
            outputSequence: Number.isSafeInteger(Number(value.outputSequence))
              && Number(value.outputSequence) >= 0
              ? Number(value.outputSequence)
              : 0,
            cols: options.cols,
            rows: options.rows,
            replay: unicodeSafeReplayTail(value.replay),
            replayPendingChunks: [],
            replayPendingChars: 0,
            deliveries: restoredDeliveries(value.deliveries),
            rawInputDeliveries: restoredRawInputDeliveries(value.rawInputDeliveries),
            initialPromptFingerprint,
            creationId,
            creationPayloadFingerprint,
            agentBinding,
            process: null,
            generation: 0,
            recoveryPending: !invalidAgentBinding
              && !terminationUncertain
              && !(options.type === 'tmux' && options.tmuxPane && (!options.tmuxWindow || !options.tmuxPanePid))
              && (value.status === 'running' || value.status === 'starting'),
            recoveredAfterHostRestart: false,
            recoverySkippedReason: invalidAgentBinding ? 'invalid-agent-binding' : '',
            terminationPending: false,
            terminationIntent: restoredTerminationIntent(value.terminationIntent),
            terminationUncertain,
            terminationErrorCode: terminationUncertain
              ? (cleanText(value.terminationErrorCode, 100)
                || (interruptedTransition ? 'TERMINATION_INTERRUPTED' : 'TERMINATION_UNCERTAIN'))
              : '',
            terminationErrorMessage: terminationUncertain
              ? (cleanText(value.terminationErrorMessage, 500)
                || (interruptedTransition
                  ? '명령창 종료 확인 중 연결 프로그램이 중단되었습니다.'
                  : '명령창 프로그램의 전체 종료를 확인하지 못했습니다.'))
              : '',
            startupTimer: null,
            startupBuffer: '',
            startupReady: false,
            startupFailure: false,
            proxyOutputBuffer: '',
            proxyDeliveryWaiters: new Map(),
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
      replaceStoreFileSync(this.fileSystem, temporary, this.storeFile);
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
    this.reconcilePersistedManagedSessions();
    this.deduplicateAgentBridgeSessions();
    this.deduplicateAgentResumeSessions({ bootstrap: true });
    const recovered = [];
    for (const session of this.sessions.values()) {
      if (!session.recoveryPending) continue;
      session.recoveryPending = false;
      if (session.options.sessionBackend === 'managed-tmux') {
        let managedSessionExists;
        try {
          managedSessionExists = this.managedSessionExistsOrMarkUncertain(session, 'recover');
        } catch (_managedStateUnconfirmed) {
          continue;
        }
        if (!managedSessionExists) {
          session.status = 'stopped';
          session.pid = null;
          session.recoveredAfterHostRestart = false;
          session.recoverySkippedReason = 'managed-tmux-missing';
          const missingMessage = '\r\n[LoadToAgent] 저장된 명령창 묶음을 찾지 못해 새 AI 대화를 자동으로 시작하지 않았습니다.\r\n';
          appendSessionReplay(session, missingMessage, { immediate: true });
          continue;
        }
        session.recoveredAfterHostRestart = true;
        session.recoverySkippedReason = '';
        const reattachMessage = '\r\n[LoadToAgent] 명령창 연결이 끊긴 뒤에도 실행 중이던 작업에 다시 연결했습니다.\r\n';
        appendSessionReplay(session, reattachMessage, { immediate: true });
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
        appendSessionReplay(session, skippedMessage, { immediate: true });
        continue;
      }
      session.recoveredAfterHostRestart = true;
      session.recoverySkippedReason = '';
      const exactTmuxReattach = session.options.type === 'tmux'
        && Boolean(session.options.tmuxWindow)
        && Boolean(session.options.tmuxPane)
        && Boolean(session.options.tmuxPanePid);
      const message = exactTmuxReattach
        ? '\r\n[LoadToAgent] 명령창 호스트가 다시 시작되어 기존 tmux pane의 실제 PTY에 다시 연결했습니다.\r\n'
        : '\r\n[LoadToAgent] 명령창 연결이 끊긴 뒤 새 프로그램으로 복구했습니다. 이전 명령창의 임시 상태는 이어지지 않습니다.\r\n';
      appendSessionReplay(session, message, { immediate: true });
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

  reconcilePersistedManagedSessions() {
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.options.sessionBackend !== 'managed-tmux'
        || session.process
        || session.terminationPending
        || session.terminationUncertain) {
        continue;
      }
      try {
        const exists = this.managedSessionExistsOrMarkUncertain(session, 'reconcile');
        session.status = exists ? 'detached' : 'stopped';
        if (!exists) session.recoveryPending = false;
        session.updatedAt = new Date().toISOString();
        changed = true;
      } catch (_managedStateUnconfirmed) {
        session.recoveryPending = false;
        changed = true;
      }
    }
    if (changed) this.persistNow();
    return changed;
  }

  reconcilePersistedBoundDirectSessions({ matchingOptions = null } = {}) {
    let changed = false;
    const matchingBridge = matchingOptions ? agentBridgeKey(matchingOptions) : '';
    const matchingResume = matchingOptions ? agentResumeIdentityKey(matchingOptions, this.platform) : '';
    for (const session of this.sessions.values()) {
      if (matchingOptions
        && (!matchingBridge || agentBridgeKey(session.options) !== matchingBridge)
        && (!matchingResume || agentResumeIdentityKey(session.options, this.platform) !== matchingResume)) continue;
      const persistedOrphanUncertain = session.terminationUncertain
        && BOUND_ORPHAN_ERROR_CODES.has(session.terminationErrorCode);
      if ((!session.recoveryPending && !persistedOrphanUncertain)
        || session.options.sessionBackend !== 'direct'
        || !isExactBoundAgentOptions(session.options)) continue;
      const pid = Number(session.pid);
      let state = 'absent';
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          this.processKill(pid, 0);
          state = 'alive';
        } catch (error) {
          state = error?.code === 'ESRCH' ? 'absent' : 'unknown';
        }
      }
      session.recoveryPending = false;
      session.recoveredAfterHostRestart = false;
      session.updatedAt = new Date().toISOString();
      if (state === 'absent') {
        session.status = 'exited';
        session.pid = null;
        session.terminationUncertain = false;
        session.terminationPending = false;
        session.terminationIntent = '';
        session.terminationErrorCode = '';
        session.terminationErrorMessage = '';
        session.recoverySkippedReason = 'bound-direct-explicit-reconnect-required';
      } else {
        session.status = 'stopping';
        session.terminationUncertain = true;
        session.terminationPending = false;
        session.terminationIntent = 'recover';
        session.terminationErrorCode = state === 'alive'
          ? 'AGENT_BOUND_ORPHAN_PID_LIVE'
          : 'AGENT_BOUND_ORPHAN_PID_UNCONFIRMED';
        session.terminationErrorMessage = state === 'alive'
          ? '이전 명령창 호스트의 AI 프로세스가 아직 살아 있어 중복 재개를 차단했습니다.'
          : '이전 명령창 호스트의 AI 프로세스 종료를 확인하지 못해 중복 재개를 차단했습니다.';
        session.recoverySkippedReason = 'bound-direct-process-unconfirmed';
      }
      changed = true;
    }
    if (changed) this.persistNow();
    return changed;
  }

  deduplicateAgentBridgeSessions({ bootstrap = false } = {}) {
    const groups = new Map();
    const removed = [];
    const removedByKey = new Map();
    for (const session of this.sessions.values()) {
      const key = agentBridgeKey(session.options);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(session);
    }
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const managedPresence = new Map();
      let managedStateError = null;
      for (const session of group) {
        if (session.options.sessionBackend !== 'managed-tmux') continue;
        if (session.retiring || session.terminationPending || session.terminationUncertain) {
          managedStateError = this.uncertainTerminationError(session);
          break;
        }
        try {
          const exists = this.managedSessionExistsConfirmed(session.options);
          if (exists && typeof exists.then === 'function') {
            const error = new Error('중복 관리형 명령창의 비동기 상태 확인을 동기 정리에 사용할 수 없습니다.');
            error.code = 'MANAGED_SESSION_ASYNC_PROBE_UNSUPPORTED';
            throw error;
          }
          managedPresence.set(session.id, Boolean(exists));
        } catch (error) {
          managedStateError = error;
          break;
        }
      }
      if (managedStateError) {
        const error = new Error(`중복된 관리형 AI 명령창의 실행 상태를 확인하지 못했습니다: ${managedStateError.message || managedStateError}`);
        error.code = 'AGENT_CONNECTION_DUPLICATE_STATE_UNCONFIRMED';
        error.cause = managedStateError;
        for (const session of group) {
          session.recoveryPending = false;
          if (!session.terminationUncertain) {
            this.markTerminationUncertain(session, error, {
              terminationPending: false,
              intent: 'deduplicate',
            });
          }
        }
        continue;
      }
      const blocking = session => Boolean(session.retiring || session.terminationPending || session.terminationUncertain);
      const live = session => Boolean(session.process)
        || (session.options.sessionBackend === 'managed-tmux' && managedPresence.get(session.id) === true);
      const liveSessions = group.filter(live);
      if (bootstrap && liveSessions.length > 1) {
        const error = new Error('저장된 같은 AI 대화에 실행 중인 관리형 명령창이 둘 이상 있어 자동 종료 대상을 결정하지 않았습니다.');
        error.code = 'AGENT_CONNECTION_DUPLICATE_LIVE_UNCONFIRMED';
        for (const session of group) {
          session.recoveryPending = false;
          if (!session.terminationUncertain) {
            this.markTerminationUncertain(session, error, {
              terminationPending: false,
              intent: 'deduplicate',
            });
          }
        }
        continue;
      }
      const ranked = [...group].sort((left, right) => {
        const blockingDelta = Number(blocking(right)) - Number(blocking(left));
        if (blockingDelta) return blockingDelta;
        const liveDelta = Number(live(right)) - Number(live(left));
        if (liveDelta) return liveDelta;
        const updatedDelta = (Date.parse(right.updatedAt || 0) || 0) - (Date.parse(left.updatedAt || 0) || 0);
        if (updatedDelta) return updatedDelta;
        return (Date.parse(right.createdAt || 0) || 0) - (Date.parse(left.createdAt || 0) || 0);
      });
      const survivor = ranked[0];
      for (const duplicate of ranked.slice(1)) {
        if (live(duplicate)) {
          const retirement = this.transition(duplicate.id, 'retire');
          if (retirement && typeof retirement.then === 'function') {
            Promise.resolve(retirement).catch(() => {});
            throw rejectedDeliveryError(
              '중복된 AI 명령창 연결을 완전히 종료하는 중입니다.',
              'AGENT_CONNECTION_RETIRE_IN_PROGRESS',
            );
          }
        } else {
          this.sessions.delete(duplicate.id);
        }
        removed.push(duplicate.id);
        removedByKey.set(key, (removedByKey.get(key) || 0) + 1);
      }
      const removedForKey = removedByKey.get(key) || 0;
      if (removedForKey && this.sessions.get(survivor.id) === survivor) {
        const message = `\r\n[LoadToAgent] 같은 AI 대화에 중복으로 열린 연결 ${removedForKey}개를 정리했습니다.\r\n`;
        appendSessionReplay(survivor, message, { immediate: true });
      }
    }
    if (removed.length) this.persistNow();
    return removed;
  }

  deduplicateAgentResumeSessions({ bootstrap = false } = {}) {
    const groups = new Map();
    let changed = false;
    for (const session of this.sessions.values()) {
      const key = agentResumeIdentityKey(session.options, this.platform);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(session);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const live = [];
      let probeError = null;
      for (const session of group) {
        if (session.process) {
          live.push(session);
          continue;
        }
        if (session.options.sessionBackend !== 'managed-tmux') continue;
        try {
          if (this.managedSessionExistsConfirmed(session.options)) live.push(session);
        } catch (error) {
          probeError = error;
          break;
        }
      }
      if (probeError || live.length > 1) {
        const error = new Error(probeError
          ? `같은 AI 대화 기록의 실행 상태를 확인하지 못했습니다: ${probeError.message || probeError}`
          : '같은 AI 대화 기록을 재개한 명령창이 둘 이상 실행 중이라 자동 복구를 차단했습니다.');
        error.code = probeError
          ? 'AGENT_RESUME_DUPLICATE_STATE_UNCONFIRMED'
          : 'AGENT_RESUME_DUPLICATE_LIVE_UNCONFIRMED';
        if (probeError) error.cause = probeError;
        for (const session of group) {
          session.recoveryPending = false;
          if (!session.terminationUncertain) {
            this.markTerminationUncertain(session, error, {
              terminationPending: false,
              intent: 'deduplicate',
            });
          }
        }
        changed = true;
        continue;
      }
      const survivor = live[0] || [...group].sort((left, right) => (
        (Date.parse(right.updatedAt || 0) || 0) - (Date.parse(left.updatedAt || 0) || 0)
      ))[0];
      for (const duplicate of group) {
        if (duplicate === survivor) continue;
        duplicate.recoveryPending = false;
        duplicate.recoveredAfterHostRestart = false;
        duplicate.recoverySkippedReason = 'duplicate-agent-resume-identity';
        if (!duplicate.process && duplicate.options.sessionBackend !== 'managed-tmux') {
          duplicate.status = 'exited';
          duplicate.pid = null;
        }
        changed = true;
      }
      if (bootstrap && survivor) survivor.recoverySkippedReason = '';
    }
    if (changed) this.persistNow();
    return changed;
  }

  reclaimFinishedSessions(requiredSlots = 1) {
    const required = Math.max(1, Number(requiredSlots) || 1);
    if (this.sessions.size + required <= MAX_SESSIONS) return [];
    const removable = [...this.sessions.values()]
      .filter(session => !session.process && ['exited', 'stopped', 'failed'].includes(session.status))
      .filter(session => {
        if (session.options.sessionBackend !== 'managed-tmux') return true;
        try {
          return !this.managedSessionLiveNow(session, 'reclaim');
        } catch (_managedStateUnconfirmed) {
          return false;
        }
      })
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

  activeAgentBridgeSessions(options = {}) {
    const key = agentBridgeKey(options);
    if (!key) return [];
    return [...this.sessions.values()]
      .filter(session => agentBridgeKey(session.options) === key)
      .filter(session => session.retiring
        || session.terminationPending
        || session.terminationUncertain
        || (session.process && session.status === 'running')
        || (session.options.sessionBackend === 'managed-tmux'
          && !session.process
          && this.managedSessionLiveNow(session, 'active-bridge')))
      .sort((left, right) => (
        (Date.parse(right.updatedAt || 0) || 0) - (Date.parse(left.updatedAt || 0) || 0)
      ));
  }

  activeAgentResumeSessions(options = {}) {
    const key = agentResumeIdentityKey(options, this.platform);
    if (!key) return [];
    return [...this.sessions.values()]
      .filter(session => agentResumeIdentityKey(session.options, this.platform) === key)
      .filter(session => session.retiring
        || session.terminationPending
        || session.terminationUncertain
        || Boolean(session.process)
        || (session.options.sessionBackend === 'managed-tmux'
          && !session.process
          && this.managedSessionLiveNow(session, 'active-resume-identity')))
      .sort((left, right) => (
        (Date.parse(right.updatedAt || 0) || 0) - (Date.parse(left.updatedAt || 0) || 0)
      ));
  }

  reusableAgentBridge(options = {}, activeCandidates = null) {
    const requestedSignature = String(options.agentConnectionSignature || '');
    const requestedResumeIdentity = agentResumeIdentityKey(options, this.platform);
    const candidates = (Array.isArray(activeCandidates)
      ? activeCandidates
      : this.activeAgentBridgeSessions(options))
      .filter(session => !session.retiring && !session.terminationPending && !session.terminationUncertain)
      .filter(session => !requestedSignature
        || String(session.options.agentConnectionSignature || '') === requestedSignature)
      .filter(session => !requestedResumeIdentity
        || agentResumeIdentityKey(session.options, this.platform) === requestedResumeIdentity);
    const running = candidates.find(session => session.process && session.status === 'running');
    if (running) return running;
    return candidates.find(session => session.options.sessionBackend === 'managed-tmux'
      && session.status === 'detached'
      && this.managedSessionExistsConfirmed(session.options)) || null;
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

  rawInputDeliveryRecord(deliveryId) {
    const id = normalizedDeliveryId(deliveryId);
    if (!id) return null;
    for (const session of this.sessions.values()) {
      const record = (session.rawInputDeliveries || []).find(item => item.id === id);
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

  creationRecord(creationId) {
    const id = normalizedCreationId(creationId);
    if (!id) return null;
    for (const session of this.sessions.values()) {
      if (session.creationId === id) return session;
    }
    return null;
  }

  duplicateCreationResult(session, details = {}) {
    const requestedDeliveryId = normalizedDeliveryId(details.deliveryId);
    const deliveryRecord = (session.deliveries || []).find(record => (
      (requestedDeliveryId && record.id === requestedDeliveryId)
      || (details.fingerprint
        && record.fingerprint === details.fingerprint
        && ((!details.target || record.target === details.target)
          || (!details.initialCommandInArgs && record.target === session.id)))
    )) || null;
    let deliveryState = '';
    if (deliveryRecord) {
      deliveryState = deliveryRecord
        .state === 'accepted' ? 'accepted' : 'unknown';
    } else if (details.initialCommandInArgs) {
      deliveryState = session.status === 'failed' ? 'rejected' : 'unknown';
    } else if (session.status === 'failed') {
      deliveryState = 'rejected';
    }
    const creationFailed = session.status === 'failed';
    const creationUnavailable = creationFailed
      || !['starting', 'running'].includes(session.status)
      || Boolean(session.recoverySkippedReason);
    return {
      ...publicSession(session, true),
      ok: true,
      reused: true,
      duplicate: true,
      creationDuplicate: true,
      creationFailed,
      creationUnavailable,
      creationId: session.creationId,
      promptSent: deliveryState === 'accepted',
      deliveryId: requestedDeliveryId,
      ...(deliveryRecord && requestedDeliveryId && deliveryRecord.id !== requestedDeliveryId
        ? { originalDeliveryId: deliveryRecord.id }
        : {}),
      deliveryState,
    };
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

  rememberRawInputDelivery(session, deliveryId, fingerprint) {
    const id = normalizedDeliveryId(deliveryId);
    if (!id || !session || !/^[a-f0-9]{64}$/.test(String(fingerprint || ''))) return null;
    const deliveries = Array.isArray(session.rawInputDeliveries) ? session.rawInputDeliveries : [];
    let record = deliveries.find(item => item.id === id);
    if (!record) {
      record = { id, state: 'accepted', timestamp: new Date().toISOString(), fingerprint };
      deliveries.push(record);
    } else {
      record.state = 'accepted';
      record.timestamp = new Date().toISOString();
      record.fingerprint = fingerprint;
    }
    session.rawInputDeliveries = deliveries.slice(-MAX_DELIVERY_RECORDS);
    // Raw xterm input can arrive once per key or IME chunk. Keep its ledger
    // durable without synchronously rewriting the complete session store for
    // every keystroke; the in-memory record is available before the host sends
    // its response, which is the socket-loss retry boundary.
    this.schedulePersist();
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
    if (launchOptions.type === 'agent'
      && launchOptions.sessionBackend === 'managed-tmux'
      && typeof this.managedTmuxRuntime?.available === 'function'
      && !this.managedTmuxRuntime.available(launchOptions)) {
      // tmux is optional on macOS, Linux, and WSL. Resume the exact provider
      // history in an app-owned node-pty instead of failing before a real
      // terminal exists. Canonical resume args and bridge identity persist.
      launchOptions.sessionBackend = 'direct';
      launchOptions.tmuxSocket = '';
      launchOptions.managedTmuxSession = '';
    }
    const initialCommand = String(rawOptions.initialCommand || '').trim();
    const initialCommandInArgs = Boolean(initialCommand && rawOptions.initialCommandInArgs);
    const requestedDeliveryId = String(rawOptions.deliveryId || '').trim();
    const deliveryId = normalizedDeliveryId(requestedDeliveryId);
    if (requestedDeliveryId && !deliveryId) {
      throw rejectedDeliveryError('전달 요청 식별자가 올바르지 않습니다.');
    }
    if (deliveryId && this.rawInputDeliveryRecord(deliveryId)) {
      throw rejectedDeliveryError(
        '이 전달 요청은 터미널 입력에 이미 사용됐습니다.',
        'DELIVERY_ID_CONFLICT',
        deliveryId,
      );
    }
    const requestedCreationId = String(rawOptions.creationId || '').trim();
    const creationId = normalizedCreationId(requestedCreationId);
    if (requestedCreationId && !creationId) {
      throw rejectedCreationError(
        '명령창 생성 요청 식별자가 올바르지 않습니다.',
        'CREATION_ID_INVALID',
        '',
        deliveryId,
      );
    }
    if (initialCommand.length > MAX_INPUT_CHARS) {
      throw rejectedDeliveryError('한 번에 보낼 수 있는 입력 크기를 초과했습니다.', 'DELIVERY_TOO_LARGE', deliveryId);
    }
    assertBoundAgentCommandSafe(launchOptions, initialCommand, deliveryId);
    if (isExactBoundAgentOptions(launchOptions) && initialCommandInArgs) {
      throw rejectedDeliveryError(
        '대화에 연결된 AI 명령창의 질문은 실행 인자가 아니라 안전한 명령 전달 경로로 보내야 합니다.',
        'AGENT_BOUND_PROMPT_IN_ARGS_BLOCKED',
        deliveryId,
      );
    }
    const recoveryArgs = Array.isArray(rawOptions.recoveryArgs)
      ? resumableAgentArguments({
          type: launchOptions.type,
          provider: launchOptions.provider,
          args: rawOptions.recoveryArgs,
        })
      : null;
    if (recoveryArgs) {
      const launchResumeId = agentResumeSessionId(launchOptions);
      const recoveryResumeId = agentResumeSessionId({
        type: launchOptions.type,
        provider: launchOptions.provider,
        args: recoveryArgs,
      });
      if (!launchResumeId || !recoveryResumeId || launchResumeId !== recoveryResumeId) {
        throw rejectedDeliveryError(
          '처음 실행할 AI 대화와 재시작할 AI 대화의 식별자가 일치하지 않습니다.',
          'AGENT_RECOVERY_IDENTITY_MISMATCH',
          deliveryId,
        );
      }
    }
    const fingerprint = initialCommand ? deliveryFingerprint(initialCommand) : '';
    const deliveryTarget = agentBridgeKey(launchOptions)
      || `agent:${launchOptions.provider}:${launchOptions.cwd}`;
    const creationFingerprint = creationId ? creationPayloadFingerprint(launchOptions, {
      initialCommand,
      initialCommandInArgs,
      recoveryArgs,
      reuseBridge: rawOptions.reuseBridge,
    }) : '';
    const knownCreation = creationId ? this.creationRecord(creationId) : null;
    if (knownCreation) {
      if (knownCreation.creationPayloadFingerprint !== creationFingerprint) {
        throw rejectedCreationError(
          '이 명령창 생성 요청은 다른 실행 내용에 이미 사용됐습니다.',
          'CREATION_ID_CONFLICT',
          creationId,
          deliveryId,
        );
      }
      return this.duplicateCreationResult(knownCreation, {
        deliveryId,
        fingerprint,
        target: deliveryTarget,
        initialCommandInArgs,
      });
    }
    if (creationId && launchOptions.transient) {
      throw rejectedCreationError(
        '일회성 명령창에는 재시도 가능한 생성 요청을 사용할 수 없습니다.',
        'CREATION_TRANSIENT_UNSUPPORTED',
        creationId,
        deliveryId,
      );
    }
    if (isExactBoundAgentOptions(launchOptions)) {
      // A hard-crash orphan may exit moments after bootstrap. Re-probe the
      // exact bridge/history immediately before deciding whether create is
      // blocked, so a confirmed ESRCH clears the fail-closed wedge without
      // ever allowing an alive or unconfirmed duplicate.
      this.reconcilePersistedBoundDirectSessions({ matchingOptions: launchOptions });
    }
    const activeBridgeCandidates = this.activeAgentBridgeSessions(launchOptions);
    const activeResumeCandidates = this.activeAgentResumeSessions(launchOptions);
    const requestedBridgeKey = agentBridgeKey(launchOptions);
    if (activeResumeCandidates.length
      && (!requestedBridgeKey || activeResumeCandidates.some(session => agentBridgeKey(session.options) !== requestedBridgeKey))) {
      throw rejectedDeliveryError(
        '같은 AI 대화 기록이 다른 명령창 연결에서 이미 실행 중입니다.',
        'AGENT_RESUME_IDENTITY_ALREADY_ACTIVE',
        deliveryId,
      );
    }
    if (activeBridgeCandidates.some(session => (
      session.retiring || session.terminationPending || session.terminationUncertain
    ))) {
      throw rejectedDeliveryError(
        '같은 AI 대화의 이전 명령창 연결을 정리하는 중입니다.',
        'AGENT_CONNECTION_RETIRE_IN_PROGRESS',
        deliveryId,
      );
    }
    const requestedSignature = String(launchOptions.agentConnectionSignature || '');
    const requestedResumeIdentity = agentResumeIdentityKey(launchOptions, this.platform);
    if ((requestedSignature || requestedResumeIdentity) && activeBridgeCandidates.some(session => (
      (requestedSignature && String(session.options.agentConnectionSignature || '') !== requestedSignature)
        || (requestedResumeIdentity
          && agentResumeIdentityKey(session.options, this.platform) !== requestedResumeIdentity)
    ))) {
      throw rejectedDeliveryError(
        '같은 AI 대화에 다른 연결 정보의 명령창이 이미 실행 중입니다.',
        'AGENT_CONNECTION_IDENTITY_CONFLICT',
        deliveryId,
      );
    }
    if (!rawOptions.reuseBridge && activeBridgeCandidates.length > 0) {
      throw rejectedDeliveryError(
        '같은 AI 대화의 명령창 연결이 이미 실행 중입니다. 기존 연결 종료를 확인한 뒤 다시 시도해 주세요.',
        'AGENT_CONNECTION_ALREADY_ACTIVE',
        deliveryId,
      );
    }
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
      const reusable = this.reusableAgentBridge(launchOptions, activeBridgeCandidates);
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
      outputSequence: 0,
      cols: options.cols,
      rows: options.rows,
      replay: '',
      replayPendingChunks: [],
      replayPendingChars: 0,
      deliveries: [],
      rawInputDeliveries: [],
      initialPromptFingerprint: initialCommand ? promptFingerprint(initialCommand) : '',
      creationId,
      creationPayloadFingerprint: creationFingerprint,
      agentBinding: null,
      process: null,
      generation: 0,
      recoveryPending: false,
      recoveredAfterHostRestart: false,
      recoverySkippedReason: '',
      terminationUncertain: false,
      terminationPending: false,
      terminationIntent: '',
      terminationErrorCode: '',
      terminationErrorMessage: '',
      startupTimer: null,
      startupBuffer: '',
      startupReady: false,
      startupFailure: false,
      proxyOutputBuffer: '',
      proxyDeliveryWaiters: new Map(),
    };
    this.sessions.set(id, session);
    const deliveryWillPersistCreation = Boolean(deliveryId && initialCommandInArgs);
    if (creationId && !deliveryWillPersistCreation && !this.persistNow()) {
      this.sessions.delete(id);
      throw rejectedCreationError(
        '명령창 생성 장부를 안전하게 저장하지 못해 작업을 시작하지 않았습니다.',
        'CREATION_LEDGER_UNAVAILABLE',
        creationId,
        deliveryId,
      );
    }
    let persistedAfterSpawn = false;
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
      persistedAfterSpawn = Boolean(deliveryId && initialCommandInArgs);
    } catch (error) {
      if (deliveryId && initialCommandInArgs && error?.terminalProcessStarted === false) {
        if (this.forgetDelivery(session, deliveryId)) {
          error = markDeliveryRejected(error, deliveryId);
        } else {
          error.deliveryId = deliveryId;
          error.deliveryState = 'unknown';
        }
      } else if (deliveryId && initialCommandInArgs && error?.terminalProcessStarted) {
        error.deliveryId = deliveryId;
        error.deliveryState = 'unknown';
      } else if (initialCommand && !initialCommandInArgs && error?.terminalProcessStarted === false) {
        error = markDeliveryRejected(error, deliveryId);
      } else if (initialCommand && !initialCommandInArgs && error?.terminalProcessStarted) {
        error.deliveryId = deliveryId;
        error.deliveryState = 'unknown';
      }
      if (error?.code === 'DELIVERY_LEDGER_UNAVAILABLE') this.sessions.delete(session.id);
      // Keep failed launches visible until the user explicitly closes them.
      // The failed session contains the startup error in replay and can be
      // inspected, restarted, or removed from the session terminal.
      this.persistNow();
      if (creationId && error?.code !== 'DELIVERY_LEDGER_UNAVAILABLE') {
        return {
          ...publicSession(session, true),
          ok: true,
          reused: false,
          creationId,
          creationDuplicate: false,
          creationFailed: true,
          creationUnavailable: true,
          promptSent: false,
          deliveryId,
          deliveryState: String(error?.deliveryState || '') || 'rejected',
          error: String(error?.message || '명령창을 시작하지 못했습니다.'),
          code: String(error?.code || 'TERMINAL_CREATE_FAILED'),
        };
      }
      throw error;
    }
    // The accepted delivery write already persisted the spawned PID/status,
    // creation ledger, and delivery ledger together. Avoid serializing and
    // atomically replacing a multi-megabyte terminal store a second time on
    // the launch hot path. Providers that send their prompt after create
    // still need this post-spawn save.
    if (!persistedAfterSpawn) this.persistNow();
    const creationUnavailable = !['starting', 'running'].includes(session.status);
    return {
      ...publicSession(session, true),
      reused: false,
      creationId,
      creationDuplicate: false,
      creationFailed: false,
      creationUnavailable,
      promptSent: initialCommandInArgs,
      deliveryId,
      deliveryState: deliveryId && initialCommandInArgs ? 'accepted' : '',
    };
  }

  clearStartupTimer(session) {
    if (session?.startupTimer) clearTimeout(session.startupTimer);
    if (session) session.startupTimer = null;
  }

  proxyWaiters(session) {
    if (!(session?.proxyDeliveryWaiters instanceof Map)) session.proxyDeliveryWaiters = new Map();
    return session.proxyDeliveryWaiters;
  }

  settleProxyDeliveries(session, state = 'unknown', message = '') {
    if (!session) return;
    for (const waiter of this.proxyWaiters(session).values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ state, message });
    }
    session.proxyDeliveryWaiters.clear();
  }

  consumeExactProxyFrames(session, value) {
    if (!session?.spec?.exactPaneProxy) return String(value || '');
    // Windows ConPTY consumes DCS in both directions. The random per-process
    // channel makes this printable sentinel private while allowing ConPTY to
    // carry it unchanged; it is removed here before replay/xterm see it.
    const frames = [
      { kind: 'ack', prefix: `LTA_PROXY_ACK_${session.spec.proxyChannel};` },
      { kind: 'meta', prefix: `LTA_PROXY_META_${session.spec.proxyChannel};` },
    ];
    const terminator = '\n';
    let buffered = `${session.proxyOutputBuffer || ''}${String(value || '')}`;
    let visible = '';
    while (buffered) {
      let frame = null;
      let markerIndex = -1;
      for (const candidate of frames) {
        const index = buffered.indexOf(candidate.prefix);
        if (index >= 0 && (markerIndex < 0 || index < markerIndex)) {
          frame = candidate;
          markerIndex = index;
        }
      }
      if (markerIndex < 0) {
        let retained = 0;
        for (const candidate of frames) {
          const maximum = Math.min(candidate.prefix.length - 1, buffered.length);
          for (let length = maximum; length > retained; length -= 1) {
            if (buffered.endsWith(candidate.prefix.slice(0, length))) {
              retained = length;
              break;
            }
          }
        }
        visible += buffered.slice(0, buffered.length - retained);
        buffered = buffered.slice(buffered.length - retained);
        break;
      }
      visible += buffered.slice(0, markerIndex);
      const payloadStart = markerIndex + frame.prefix.length;
      const markerEnd = buffered.indexOf(terminator, payloadStart);
      if (markerEnd < 0) {
        buffered = buffered.slice(markerIndex);
        break;
      }
      const payload = buffered.slice(payloadStart, markerEnd).replace(/\r$/u, '');
      if (frame.kind === 'meta') {
        const [rawCols, rawRows] = payload.split(';');
        const cols = Number(rawCols);
        const rows = Number(rawRows);
        if (Number.isSafeInteger(cols) && cols >= 20 && cols <= 500
          && Number.isSafeInteger(rows) && rows >= 5 && rows <= 300) {
          const changed = session.cols !== cols || session.rows !== rows;
          session.cols = cols;
          session.rows = rows;
          if (changed && session.status === 'running') {
            session.updatedAt = new Date().toISOString();
            this.emitState('updated', session);
            this.schedulePersist();
          }
        }
      } else {
        const [requestId, state, encodedMessage = ''] = payload.split(';');
        const waiter = this.proxyWaiters(session).get(requestId);
        if (waiter && ['accepted', 'rejected', 'unknown'].includes(state)) {
          this.proxyWaiters(session).delete(requestId);
          clearTimeout(waiter.timer);
          let message = '';
          try {
            message = encodedMessage ? Buffer.from(encodedMessage, 'base64url').toString('utf8') : '';
          } catch (_invalidProxyMessage) {}
          waiter.resolve({ state, message });
        }
      }
      buffered = buffered.slice(markerEnd + terminator.length);
    }
    session.proxyOutputBuffer = buffered;
    return visible;
  }

  commandExactPaneProxy(session, command, deliveryId, fingerprint) {
    // The proxy request id belongs to the private PTY control channel. Keep it
    // independent from the public delivery id (which has a wider allowed
    // length) so a valid delivery id can never make the proxy reject a frame.
    const requestId = `proxy-${crypto.randomBytes(12).toString('hex')}`;
    const generation = session.generation;
    const encoded = Buffer.from(JSON.stringify({ requestId, command }), 'utf8').toString('base64url');
    const frame = `LTA_PROXY_CMD_${session.spec.proxyChannel};${encoded}\r`;
    const commandBytes = Buffer.byteLength(command, 'utf8');
    const acknowledgementTimeoutMs = Math.min(
      this.tmuxProxyLargeDeliveryTimeoutMs,
      this.tmuxProxyDeliveryTimeoutMs + (Math.ceil(commandBytes / 1_024) * 200),
    );
    let resolveWaiter;
    const acknowledged = new Promise(resolve => { resolveWaiter = resolve; });
    const waiter = {
      resolve: resolveWaiter,
      timer: null,
    };
    waiter.timer = setTimeout(() => {
      // The main process may return from a long synchronous OS probe after the
      // deadline while the proxy ACK is already buffered. Leave one bounded
      // recovery interval for PTY I/O and proxy microtasks before committing
      // the exactly-once ledger to an unknown state.
      waiter.timer = setTimeout(() => {
        if (this.proxyWaiters(session).get(requestId) !== waiter) return;
        this.proxyWaiters(session).delete(requestId);
        resolveWaiter({ state: 'unknown', message: '정확한 tmux pane의 입력 확인 응답이 지연되었습니다.' });
      }, this.tmuxProxyDeliveryRecoveryGraceMs);
    }, acknowledgementTimeoutMs);
    this.proxyWaiters(session).set(requestId, waiter);
    try {
      session.process.write(frame);
    } catch (error) {
      clearTimeout(waiter.timer);
      this.proxyWaiters(session).delete(requestId);
      if (deliveryId) {
        error.deliveryId = deliveryId;
        error.deliveryState = 'unknown';
      }
      throw error;
    }
    return acknowledged.then(result => {
      if (session.generation !== generation && result.state === 'accepted') {
        result = { state: 'unknown', message: '입력 확인 중 PTY 연결 세대가 변경되었습니다.' };
      }
      if (result.state === 'accepted') {
        if (deliveryId) this.rememberDelivery(session, deliveryId, 'accepted', {
          target: session.id,
          fingerprint,
        });
        return { ok: true, deliveryId, deliveryState: 'accepted' };
      }
      if (result.state === 'rejected') {
        if (deliveryId) this.forgetDelivery(session, deliveryId);
        throw rejectedDeliveryError(
          result.message || '요청한 tmux pane이 더 이상 동일한 프로그램을 실행하지 않아 입력을 차단했습니다.',
          'TMUX_EXACT_TARGET_CHANGED',
          deliveryId,
        );
      }
      return {
        ok: true,
        deliveryId,
        deliveryState: 'unknown',
        warning: result.message || '정확한 입력 전달 여부를 확인하지 못했습니다.',
      };
    });
  }

  failExactTmuxStartup(session, generation, message) {
    if (!session
      || session.generation !== generation
      || session.startupReady
      || session.startupFailure) return;
    session.startupFailure = true;
    session.startupBuffer = '';
    this.clearStartupTimer(session);
    const failureMessage = `\r\n[LoadToAgent] ${message}\r\n`;
    appendSessionReplay(session, failureMessage, { immediate: true });
    session.outputSequence = (Number.isSafeInteger(session.outputSequence) ? session.outputSequence : 0) + 1;
    session.updatedAt = new Date().toISOString();
    this.emit('data', {
      id: session.id,
      data: failureMessage,
      outputSequence: session.outputSequence,
    });
    this.emitState('updated', session);
    let stopping;
    try {
      stopping = this.kill(session.id);
    } catch (_terminationFailure) {
      return;
    }
    Promise.resolve(stopping).then(() => {
      if (this.sessions.get(session.id) !== session
        || session.generation < generation
        || session.process) return;
      session.status = 'failed';
      session.updatedAt = new Date().toISOString();
      this.persistNow();
      this.emitState('updated', session);
    }, () => {});
  }

  cleanupFailedSpawnProcess(session, processHandle, generation, startupError) {
    if (!session || !processHandle) return;
    const finish = () => {
      if (this.sessions.get(session.id) !== session
        || session.generation !== generation
        || (session.process && session.process !== processHandle)) return;
      session.process = null;
      session.pid = null;
      session.generation += 1;
      session.retiring = false;
      session.terminationPending = false;
      session.terminationIntent = '';
      session.terminationUncertain = false;
      session.terminationErrorCode = '';
      session.terminationErrorMessage = '';
      session.status = 'failed';
      session.updatedAt = new Date().toISOString();
      this.persistNow();
      this.emitState('updated', session);
    };
    const fail = cleanupError => {
      if (processHandle.__loadtoagentExited) {
        finish();
        return;
      }
      if (this.sessions.get(session.id) !== session
        || session.generation !== generation
        || session.process !== processHandle) return;
      session.status = 'stopping';
      session.terminationPending = true;
      session.terminationIntent = 'startup-failure';
      session.terminationUncertain = true;
      session.terminationErrorCode = 'TERMINAL_START_CLEANUP_FAILED';
      session.terminationErrorMessage = cleanText(
        `명령창 시작 초기화 실패 뒤 프로그램 종료를 확인하지 못했습니다: ${cleanupError?.message || cleanupError}`,
        500,
      );
      session.updatedAt = new Date().toISOString();
      this.persistNow();
      this.emitState('updated', session);
    };
    try {
      const startupCancellation = Boolean(processHandle.__loadtoagentStartupPending);
      const terminateWithPid = resolvedPid => {
        if (Number.isSafeInteger(Number(resolvedPid)) && Number(resolvedPid) > 0) {
          session.pid = Number(resolvedPid);
        }
        return startupCancellation
          ? waitForPtyExitAfter(
              processHandle,
              () => processHandle.kill(),
              PTY_EXIT_CONFIRM_TIMEOUT_MS,
              { alwaysTerminate: true },
            )
          : this.killTree(processHandle, session.pid);
      };
      const pidResult = startupCancellation
        ? null
        : waitForPtyPid(processHandle, session.pid, this.ptyPidReadyTimeoutMs);
      const cleanup = pidResult && typeof pidResult.then === 'function'
        ? Promise.resolve(pidResult).then(terminateWithPid)
        : terminateWithPid(pidResult);
      if (cleanup && typeof cleanup.then === 'function') {
        Promise.resolve(cleanup).then(finish, fail).catch(fail);
      } else {
        finish();
      }
    } catch (cleanupError) {
      const combined = new Error(`${startupError?.message || '명령창 시작 초기화 실패'}; ${cleanupError?.message || cleanupError}`);
      combined.cause = cleanupError;
      fail(combined);
    }
  }

  spawn(session) {
    if (!session.spec) {
      session.options = normalizeLaunchOptions(session.options, this.platform);
      session.spec = launchSpec(session.options, this.platform, this.agentProviders);
      session.shell = session.spec.file;
    }
    this.settleProxyDeliveries(session, 'unknown', 'PTY 연결이 다시 시작되었습니다.');
    const generation = ++session.generation;
    this.clearStartupTimer(session);
    session.startupBuffer = '';
    session.proxyOutputBuffer = '';
    session.startupReady = !session.spec?.readyMarker;
    session.startupFailure = false;
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
        env: terminalEnvironment(session.spec.env || {}),
        useConpty: this.platform === 'win32',
      };
      if (this.platform !== 'win32') spawnOptions.encoding = 'utf8';
      processHandle = session.spec?.exactPaneProxy
        ? this.tmuxControlProxyFactory(session.spec.args[1])
        : this.pty().spawn(session.spec.file, session.spec.args, spawnOptions);
      session.process = processHandle;
      session.pid = Number(processHandle.pid) > 0 ? Number(processHandle.pid) : null;
      session.status = session.spec.readyMarker ? 'starting' : 'running';
      session.updatedAt = new Date().toISOString();
      if (session.spec.readyMarker) {
        session.startupTimer = setTimeout(() => {
          this.failExactTmuxStartup(
            session,
            generation,
            '요청한 tmux pane에 연결되었는지 확인하지 못해 입력을 차단했습니다.',
          );
        }, TMUX_EXACT_PANE_READY_TIMEOUT_MS);
      }
      processHandle.onData(data => {
        if (session.generation !== generation) return;
        const readyPid = Number(processHandle.pid);
        if (Number.isSafeInteger(readyPid) && readyPid > 0) session.pid = readyPid;
        let text = this.consumeExactProxyFrames(session, String(data || ''));
        if (session.spec.readyMarker && !session.startupReady) {
          session.startupBuffer = unicodeSafeReplayTail(`${session.startupBuffer}${text}`);
          const buffered = session.startupBuffer;
          const markerIndex = buffered.indexOf(session.spec.readyMarker);
          const markerLineEnd = markerIndex >= 0 ? buffered.indexOf('\n', markerIndex) : -1;
          if (markerIndex >= 0 && markerLineEnd >= 0) {
            session.startupReady = true;
            this.clearStartupTimer(session);
            session.status = 'running';
            text = `${buffered.slice(0, markerIndex)}${buffered.slice(markerLineEnd + 1)}`;
            session.startupBuffer = '';
            session.updatedAt = new Date().toISOString();
            this.emitState('updated', session);
          } else {
            const prefixIndex = buffered.indexOf(session.spec.readyMarkerPrefix);
            if (prefixIndex >= 0 && buffered.indexOf('\n', prefixIndex) >= 0) {
              this.failExactTmuxStartup(
                session,
                generation,
                '요청한 tmux pane과 실제 연결된 pane이 달라 입력을 차단했습니다.',
              );
            }
            return;
          }
        }
        if (!text) return;
        appendSessionReplay(session, text);
        session.outputSequence = (Number.isSafeInteger(session.outputSequence) ? session.outputSequence : 0) + 1;
        session.updatedAt = new Date().toISOString();
        this.emit('data', { id: session.id, data: text, outputSequence: session.outputSequence });
        this.schedulePersist();
      });
      processHandle.onExit(event => {
        processHandle.__loadtoagentExited = true;
        if (session.generation !== generation) return;
        flushSessionReplay(session);
        this.clearStartupTimer(session);
        session.startupBuffer = '';
        session.process = null;
        this.settleProxyDeliveries(session, 'unknown', '정확한 tmux pane 연결이 종료되었습니다.');
        session.pid = null;
        session.exitCode = Number.isFinite(event.exitCode) ? event.exitCode : null;
        session.signal = Number.isFinite(event.signal) ? event.signal : null;
        session.updatedAt = new Date().toISOString();
        if (session.retiring || session.terminationPending || session.terminationUncertain) {
          // The tree-kill/tmux operation still owns the final transition. Keep
          // the host visibly active until that operation acknowledges completion.
          session.status = 'stopping';
          this.persistNow();
          this.emitState('updated', session);
          return;
        }
        if (session.spec.readyMarker && !session.startupReady) {
          if (!session.startupFailure) {
            session.startupFailure = true;
            const failureMessage = '\r\n[LoadToAgent] 요청한 tmux pane 연결이 끝나 입력을 차단했습니다.\r\n';
            appendSessionReplay(session, failureMessage, { immediate: true });
            session.outputSequence = (Number.isSafeInteger(session.outputSequence) ? session.outputSequence : 0) + 1;
            this.emit('data', { id: session.id, data: failureMessage, outputSequence: session.outputSequence });
          }
          session.status = 'failed';
        } else if (session.spec?.exactPaneProxy && session.exitCode !== 0) {
          session.status = 'failed';
        } else if (session.options.sessionBackend === 'managed-tmux') {
          try {
            session.status = this.managedSessionExistsOrMarkUncertain(session, 'process-exit')
              ? 'detached'
              : 'stopped';
          } catch (_managedStateUnconfirmed) {
            return;
          }
        } else {
          session.status = 'exited';
        }
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
      if (processHandle) {
        session.process = processHandle;
        const readyPid = Number(processHandle.pid);
        session.pid = Number.isSafeInteger(readyPid) && readyPid > 0 ? readyPid : session.pid;
        session.status = 'stopping';
        session.terminationPending = true;
        session.terminationIntent = 'startup-failure';
      } else {
        session.process = null;
        session.pid = null;
        session.status = 'failed';
      }
      session.updatedAt = new Date().toISOString();
      const failureMessage = `\r\n[LoadToAgent] 명령창을 시작하지 못했습니다: ${error.message}\r\n`;
      appendSessionReplay(session, failureMessage, { immediate: true });
      if (processHandle) this.cleanupFailedSpawnProcess(session, processHandle, generation, error);
      session.outputSequence = (Number.isSafeInteger(session.outputSequence) ? session.outputSequence : 0) + 1;
      this.emit('data', {
        id: session.id,
        data: failureMessage,
        outputSequence: session.outputSequence,
      });
      this.emitState('updated', session);
      throw error;
    }
  }

  emitState(change, session) {
    this.emit('state', { change, session: session ? publicSession(session, false) : null, sessions: this.list() });
    this.schedulePersist();
  }

  uncertainTerminationError(session) {
    const error = new Error(session?.terminationErrorMessage || '명령창 프로그램의 전체 종료를 확인하지 못했습니다.');
    error.code = session?.terminationErrorCode || 'TERMINATION_UNCERTAIN';
    error.terminationUncertain = true;
    return error;
  }

  terminationInProgressError() {
    const error = new Error('명령창 프로그램 종료 작업이 이미 진행 중입니다.');
    error.code = 'TERMINAL_STOP_IN_PROGRESS';
    return error;
  }

  markTerminationUncertain(session, error, options = {}) {
    session.terminationUncertain = true;
    session.terminationErrorCode = cleanText(error?.code, 100) || 'TERMINATION_UNCERTAIN';
    session.terminationErrorMessage = cleanText(error?.message, 500)
      || '명령창 프로그램의 전체 종료를 확인하지 못했습니다.';
    if (options.intent) session.terminationIntent = cleanText(options.intent, 30);
    session.retiring = Boolean(options.retiring);
    session.terminationPending = Boolean(options.terminationPending);
    session.status = 'stopping';
    session.updatedAt = new Date().toISOString();
    this.emitState('updated', session);
    this.persistNow();
  }

  clearTerminationUncertainty(session) {
    session.terminationUncertain = false;
    session.terminationIntent = '';
    session.terminationErrorCode = '';
    session.terminationErrorMessage = '';
  }

  list() {
    return [...this.sessions.values()].map(session => publicSession(session, false));
  }

  bindAgentSession(id, rawBinding = {}) {
    const session = this.required(id);
    if (session.options.type !== 'agent' || !['running', 'starting'].includes(session.status)) {
      const error = new Error('실행 중인 AI 명령창만 대화 기록에 연결할 수 있습니다.');
      error.code = 'AGENT_BINDING_TARGET_INVALID';
      throw error;
    }
    const binding = normalizeAgentBinding(
      rawBinding,
      session.options,
      session.initialPromptFingerprint,
      this.platform,
    );
    if (!binding) {
      const error = new Error('AI 명령창과 대화 기록의 제공사, 환경 또는 첫 질문이 일치하지 않습니다.');
      error.code = 'AGENT_BINDING_IDENTITY_MISMATCH';
      throw error;
    }
    if (session.agentBinding) {
      if (session.agentBinding.sessionId === binding.sessionId
        && session.agentBinding.promptFingerprint === binding.promptFingerprint) {
        return publicSession(session, false);
      }
      const error = new Error('이 AI 명령창은 이미 다른 대화 기록에 연결되어 있습니다.');
      error.code = 'AGENT_BINDING_CONFLICT';
      throw error;
    }
    if (isExactBoundAgentOptions(session.options)) {
      const error = new Error('이미 명시적으로 연결된 AI 대화는 다시 추론 연결할 수 없습니다.');
      error.code = 'AGENT_BINDING_ALREADY_EXPLICIT';
      throw error;
    }
    const conflicting = [...this.sessions.values()].find(candidate => candidate.id !== session.id
      && (['running', 'starting', 'stopping'].includes(candidate.status)
        || candidate.retiring
        || candidate.terminationPending
        || candidate.terminationUncertain)
      && (candidate.agentBinding?.sessionId === binding.sessionId
        || (isExactBoundAgentOptions(candidate.options) && candidate.options.bridgeId === binding.sessionId)));
    if (conflicting) {
      const error = new Error('같은 AI 대화 기록이 다른 명령창에 이미 연결되어 있습니다.');
      error.code = 'AGENT_BINDING_SESSION_ALREADY_ACTIVE';
      throw error;
    }
    const previousBridgeId = session.options.bridgeId;
    const previousSignature = session.options.agentConnectionSignature;
    const previousArgs = session.options.args;
    const previousUpdatedAt = session.updatedAt;
    session.agentBinding = binding;
    session.options.bridgeId = binding.sessionId;
    session.options.agentConnectionSignature = binding.signature;
    session.options.args = binding.provider === 'codex'
      ? ['resume', binding.externalId]
      : ['--resume', binding.externalId];
    session.updatedAt = new Date().toISOString();
    if (!this.persistNow()) {
      session.agentBinding = null;
      session.options.bridgeId = previousBridgeId;
      session.options.agentConnectionSignature = previousSignature;
      session.options.args = previousArgs;
      session.updatedAt = previousUpdatedAt;
      const error = new Error('AI 명령창의 대화 연결 정보를 안전하게 저장하지 못했습니다.');
      error.code = 'AGENT_BINDING_PERSIST_FAILED';
      throw error;
    }
    this.emitState('updated', session);
    return publicSession(session, false);
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

  write(id, value, deliveryOptions = {}) {
    const requestedDeliveryId = String(deliveryOptions?.deliveryId || '').trim();
    const deliveryId = normalizedDeliveryId(requestedDeliveryId);
    if (requestedDeliveryId && !deliveryId) {
      throw rejectedDeliveryError('전달 요청 식별자가 올바르지 않습니다.');
    }

    // Calls from protocol-11 clients that predate raw-input delivery IDs keep
    // their exact behavior. A newer client only enables the retry path after
    // the host advertises support during the ready handshake.
    if (!deliveryId) {
      const session = this.required(id);
      if (!session.process || session.status !== 'running') throw new Error('현재 실행 중인 명령창이 아닙니다.');
      const data = String(value == null ? '' : value);
      if (data.length > MAX_INPUT_CHARS) throw new Error('한 번에 보낼 수 있는 입력 크기를 초과했습니다.');
      session.process.write(data);
      return { ok: true };
    }

    const data = String(value == null ? '' : value);
    if (data.length > MAX_INPUT_CHARS) {
      throw rejectedDeliveryError('한 번에 보낼 수 있는 입력 크기를 초과했습니다.', 'DELIVERY_TOO_LARGE', deliveryId);
    }
    const fingerprint = deliveryFingerprint(data);
    const knownRawInput = this.rawInputDeliveryRecord(deliveryId);
    if (knownRawInput) {
      if (knownRawInput.session.id !== String(id || '')
        || knownRawInput.record.fingerprint !== fingerprint) {
        throw rejectedDeliveryError(
          '이 터미널 입력 요청은 다른 명령창 또는 다른 내용에 이미 사용됐습니다.',
          'DELIVERY_ID_CONFLICT',
          deliveryId,
        );
      }
      return {
        ok: true,
        duplicate: true,
        deliveryId,
        deliveryState: 'accepted',
      };
    }
    if (this.deliveryRecord(deliveryId)) {
      throw rejectedDeliveryError(
        '이 전달 요청은 명령 또는 질문 전송에 이미 사용됐습니다.',
        'DELIVERY_ID_CONFLICT',
        deliveryId,
      );
    }

    let session;
    try {
      session = this.required(id);
      if (!session.process || session.status !== 'running') throw new Error('현재 실행 중인 명령창이 아닙니다.');
    } catch (error) {
      throw markDeliveryRejected(error, deliveryId);
    }
    try {
      session.process.write(data);
    } catch (error) {
      error.deliveryId = deliveryId;
      error.deliveryState = 'unknown';
      throw error;
    }
    this.rememberRawInputDelivery(session, deliveryId, fingerprint);
    return { ok: true, deliveryId, deliveryState: 'accepted' };
  }

  respond(id, choiceKey) {
    const session = this.required(id);
    if (!session.process || session.status !== 'running') throw new Error('현재 실행 중인 명령창이 아닙니다.');
    const key = String(choiceKey == null ? '' : choiceKey);
    const payload = key === 'Escape'
      ? '\x1b'
      : (key === 'Enter' ? '\r' : (/^[0123456789any]$/u.test(key) ? key : ''));
    if (!payload) {
      const error = new Error('허용되지 않은 터미널 승인 응답입니다.');
      error.code = 'TERMINAL_PROMPT_RESPONSE_INVALID';
      throw error;
    }
    session.process.write(payload);
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
    const commandSession = this.required(id);
    assertBoundAgentCommandSafe(commandSession.options, command, deliveryId, commandSession.agentBinding);
    const fingerprint = deliveryFingerprint(command);
    if (deliveryId && this.rawInputDeliveryRecord(deliveryId)) {
      throw rejectedDeliveryError(
        '이 전달 요청은 터미널 입력에 이미 사용됐습니다.',
        'DELIVERY_ID_CONFLICT',
        deliveryId,
      );
    }
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
    if (session.spec?.exactPaneProxy) {
      return this.commandExactPaneProxy(session, command, deliveryId, fingerprint);
    }
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
    if (session.spec?.exactPaneProxy) {
      return { ok: true, cols: session.cols, rows: session.rows, fixedGrid: true };
    }
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

  managedSessionExistsConfirmed(options) {
    const probe = typeof this.managedTmuxRuntime.existsStrict === 'function'
      ? this.managedTmuxRuntime.existsStrict
      : this.managedTmuxRuntime.exists;
    if (typeof probe !== 'function') throw new Error('관리형 명령창 존재 여부를 확인할 수 없습니다.');
    return probe.call(this.managedTmuxRuntime, options);
  }

  managedSessionExistsOrMarkUncertain(session, intent = 'probe') {
    try {
      const result = this.managedSessionExistsConfirmed(session.options);
      if (result && typeof result.then === 'function') {
        const error = new Error('동기 상태 판정에서 비동기 tmux 확인 결과를 사용할 수 없습니다.');
        error.code = 'MANAGED_SESSION_ASYNC_PROBE_UNSUPPORTED';
        throw error;
      }
      return Boolean(result);
    } catch (cause) {
      const error = new Error(`관리형 명령창 작업의 실행 여부를 확인하지 못했습니다: ${cause?.message || cause}`);
      error.code = 'MANAGED_SESSION_STATE_UNCONFIRMED';
      error.cause = cause;
      this.markTerminationUncertain(session, error, {
        terminationPending: false,
        intent,
      });
      throw error;
    }
  }

  managedSessionLiveNow(session, intent = 'probe') {
    if (session.options.sessionBackend !== 'managed-tmux') return false;
    if (session.terminationUncertain || session.terminationPending || session.retiring) return true;
    const exists = this.managedSessionExistsOrMarkUncertain(session, intent);
    const status = exists ? 'detached' : 'stopped';
    if (session.status !== status || (!exists && session.recoveryPending)) {
      session.status = status;
      if (!exists) session.recoveryPending = false;
      session.updatedAt = new Date().toISOString();
      this.persistNow();
    }
    return exists;
  }

  stopManagedSessionConfirmed(options) {
    const stop = typeof this.managedTmuxRuntime.stopStrict === 'function'
      ? this.managedTmuxRuntime.stopStrict
      : this.managedTmuxRuntime.stop;
    if (typeof stop !== 'function') throw new Error('관리형 명령창을 종료할 수 없습니다.');
    return stop.call(this.managedTmuxRuntime, options);
  }

  transition(id, operation) {
    const terminalId = String(id || '');
    const existing = this.transitionPromises.get(terminalId);
    if (existing) {
      if (existing.operation === operation
        || (['close', 'retire'].includes(existing.operation) && ['close', 'retire'].includes(operation))) {
        return existing.promise;
      }
      throw this.terminationInProgressError();
    }
    const session = this.sessions.get(terminalId);
    if (!session) {
      if (operation === 'retire') return { ok: true, alreadyRetired: true };
      return this.required(terminalId);
    }
    if (session.terminationUncertain) throw this.uncertainTerminationError(session);
    if (session.retiring || session.terminationPending) throw this.terminationInProgressError();
    if (operation === 'detach' && session.options.sessionBackend !== 'managed-tmux') {
      throw new Error('일반 명령창은 작업을 계속 둔 채 화면 연결만 끊을 수 없습니다.');
    }

    let resolveTransition;
    let rejectTransition;
    const promise = new Promise((resolve, reject) => {
      resolveTransition = resolve;
      rejectTransition = reject;
    });
    // A synchronous caller may receive a direct result, but a re-entrant call
    // from a state listener still needs a stable promise immediately.
    promise.catch(() => {});
    const context = {
      operation,
      terminalId,
      session,
      handle: session.process,
      pid: session.pid,
      generation: session.generation,
      previousStatus: session.status,
      previousUpdatedAt: session.updatedAt,
      treeAcknowledged: !session.process,
      runtimeStarted: false,
      runtimeAcknowledged: session.options.sessionBackend !== 'managed-tmux'
        || !['kill', 'detach', 'stop', 'close', 'retire', 'host-shutdown'].includes(operation),
      terminationComplete: false,
      managedSessionExists: null,
    };
    this.transitionPromises.set(terminalId, { operation, promise });
    session.retiring = operation === 'close' || operation === 'retire';
    session.terminationPending = true;
    session.terminationIntent = operation;
    session.status = 'stopping';
    session.updatedAt = new Date().toISOString();
    if (!this.persistNow()) {
      session.retiring = false;
      session.terminationPending = false;
      session.terminationIntent = '';
      session.status = context.previousStatus;
      session.updatedAt = context.previousUpdatedAt;
      this.transitionPromises.delete(terminalId);
      const error = new Error('명령창 종료 상태를 저장하지 못해 프로그램 종료를 시작하지 않았습니다.');
      error.code = 'TERMINAL_TRANSITION_PERSIST_FAILED';
      rejectTransition(error);
      throw error;
    }
    this.emitState('updated', session);

    const settleSuccess = result => {
      if (this.transitionPromises.get(terminalId)?.promise === promise) {
        this.transitionPromises.delete(terminalId);
      }
      resolveTransition(result);
      return result;
    };
    const settleFailure = error => {
      const failure = this.failTransition(context, error);
      if (this.transitionPromises.get(terminalId)?.promise === promise) {
        this.transitionPromises.delete(terminalId);
      }
      rejectTransition(failure);
      return failure;
    };

    let flow;
    try {
      // The in-process exact tmux proxy owns an asynchronous identity probe
      // before its stable control-process PID exists. Cancel it synchronously
      // through the handle in the same main-thread tick; waiting on a sampled
      // probe PID would race the probe→control handoff and could kill a stale
      // process while allowing the real control client to start afterward.
      const startupCancellation = Boolean(context.handle?.__loadtoagentStartupPending);
      const terminateWithPid = resolvedPid => {
        context.pid = resolvedPid;
        if (context.handle
          && session.process === context.handle
          && session.generation === context.generation) {
          session.pid = resolvedPid;
        }
        const treeResult = context.handle
          ? startupCancellation
            ? waitForPtyExitAfter(
                context.handle,
                () => context.handle.kill(),
                PTY_EXIT_CONFIRM_TIMEOUT_MS,
                { alwaysTerminate: true },
              )
            : this.killTree(context.handle, context.pid)
          : null;
        return treeResult && typeof treeResult.then === 'function'
          ? Promise.resolve(treeResult).then(() => this.finishTransitionAfterTree(context))
          : this.finishTransitionAfterTree(context);
      };
      const pidResult = context.handle && !startupCancellation
        ? waitForPtyPid(context.handle, context.pid, this.ptyPidReadyTimeoutMs)
        : startupCancellation ? null : context.pid;
      flow = pidResult && typeof pidResult.then === 'function'
        ? Promise.resolve(pidResult).then(terminateWithPid)
        : terminateWithPid(pidResult);
    } catch (error) {
      throw settleFailure(error);
    }
    if (flow && typeof flow.then === 'function') {
      Promise.resolve(flow).then(settleSuccess, settleFailure);
      return promise;
    }
    return settleSuccess(flow);
  }

  finishTransitionAfterTree(context) {
    const { session, terminalId, handle, generation, operation } = context;
    context.treeAcknowledged = true;
    this.clearStartupTimer(session);
    this.settleProxyDeliveries(session, 'unknown', 'PTY 연결이 종료되었습니다.');
    if (this.sessions.get(terminalId) !== session) {
      return operation === 'retire' || operation === 'close'
        ? { ok: true, alreadyRetired: true }
        : { ok: true };
    }
    if (session.generation !== generation
      || (handle && session.process && session.process !== handle)) {
      const error = new Error('명령창 종료를 기다리는 동안 다른 프로그램이 시작되었습니다.');
      error.code = 'TERMINAL_GENERATION_CHANGED';
      throw error;
    }
    if (session.process === handle && handle && session.generation === generation) {
      session.process = null;
      session.generation += 1;
    }
    context.completionGeneration = session.generation;
    session.pid = null;

    let runtimeResult = null;
    if (session.options.sessionBackend === 'managed-tmux'
      && ['kill', 'detach', 'host-shutdown'].includes(operation)) {
      context.runtimeStarted = true;
      runtimeResult = this.managedSessionExistsConfirmed(session.options);
    } else if (session.options.sessionBackend === 'managed-tmux'
      && ['stop', 'close', 'retire'].includes(operation)) {
      context.runtimeStarted = true;
      runtimeResult = this.stopManagedSessionConfirmed(session.options);
    }
    const afterRuntime = result => {
      if (context.runtimeStarted) {
        context.runtimeAcknowledged = true;
        if (['kill', 'detach', 'host-shutdown'].includes(operation)) {
          context.managedSessionExists = Boolean(result);
        }
      }
      return this.finalizeTransition(context);
    };
    return runtimeResult && typeof runtimeResult.then === 'function'
      ? Promise.resolve(runtimeResult).then(afterRuntime)
      : afterRuntime(runtimeResult);
  }

  finalizeTransition(context) {
    const { session, terminalId, operation } = context;
    if (this.sessions.get(terminalId) !== session) {
      return operation === 'retire' || operation === 'close'
        ? { ok: true, alreadyRetired: true }
        : { ok: true };
    }
    if (session.generation !== context.completionGeneration || session.process) {
      const error = new Error('명령창 종료를 완료하는 동안 다른 프로그램이 시작되었습니다.');
      error.code = 'TERMINAL_GENERATION_CHANGED';
      throw error;
    }
    context.terminationComplete = true;
    session.retiring = false;
    session.terminationPending = false;
    this.clearTerminationUncertainty(session);
    session.updatedAt = new Date().toISOString();

    if (operation === 'close' || operation === 'retire') {
      session.status = 'exited';
      this.sessions.delete(terminalId);
      if (!this.persistNow()) {
        this.sessions.set(terminalId, session);
        const error = new Error('명령창 종료 완료 상태를 저장하지 못했습니다.');
        error.code = 'TERMINATION_STATE_PERSIST_FAILED';
        this.markTerminationUncertain(session, error, {
          retiring: true,
          terminationPending: true,
          intent: operation,
        });
        throw error;
      }
      this.emit('state', { change: 'removed', session: publicSession(session, false), sessions: this.list() });
      return { ok: true };
    }
    if (operation === 'restart') {
      session.recoveredAfterHostRestart = false;
      session.recoverySkippedReason = '';
      resetSessionReplay(session);
      session.spec = launchSpec(session.options, this.platform, this.agentProviders);
      session.status = 'stopped';
      if (!this.persistNow()) {
        const error = new Error('명령창 재시작 상태를 저장하지 못했습니다.');
        error.code = 'TERMINATION_STATE_PERSIST_FAILED';
        this.markTerminationUncertain(session, error, { terminationPending: true, intent: operation });
        throw error;
      }
      this.spawn(session);
      return publicSession(session, true);
    }
    if (operation === 'host-shutdown') {
      session.status = session.options.sessionBackend === 'managed-tmux'
        ? (context.managedSessionExists ? 'detached' : 'stopped')
        : 'running';
      if (!this.persistNow()) {
        const error = new Error('명령창 호스트 종료 상태를 저장하지 못했습니다.');
        error.code = 'TERMINATION_STATE_PERSIST_FAILED';
        this.markTerminationUncertain(session, error, { terminationPending: true, intent: operation });
        throw error;
      }
      this.emitState('updated', session);
      return publicSession(session, true);
    }
    if (operation === 'detach'
      || (operation === 'kill' && session.options.sessionBackend === 'managed-tmux')) {
      session.status = context.managedSessionExists ? 'detached' : 'stopped';
    } else if (operation === 'stop') {
      session.status = 'stopped';
    } else {
      session.status = 'exited';
    }
    if (!this.persistNow()) {
      const error = new Error('명령창 종료 완료 상태를 저장하지 못했습니다.');
      error.code = 'TERMINATION_STATE_PERSIST_FAILED';
      this.markTerminationUncertain(session, error, { terminationPending: true, intent: operation });
      throw error;
    }
    this.emitState('updated', session);
    return operation === 'kill' ? { ok: true } : publicSession(session, true);
  }

  failTransition(context, error) {
    const { session, terminalId, handle, generation, previousStatus } = context;
    if (this.sessions.get(terminalId) !== session) return error;
    if (session.terminationUncertain) return error;
    if (!context.treeAcknowledged || (context.runtimeStarted && !context.runtimeAcknowledged)) {
      this.markTerminationUncertain(session, error, {
        retiring: context.operation === 'close' || context.operation === 'retire',
        terminationPending: true,
      });
      return error;
    }
    session.retiring = false;
    session.terminationPending = false;
    if (!context.terminationComplete) {
      if (session.process === handle && handle && session.generation === generation) {
        session.status = previousStatus;
      } else if (session.process) {
        session.status = 'running';
      } else if (session.options.sessionBackend === 'managed-tmux') {
        try {
          session.status = this.managedSessionExistsOrMarkUncertain(session, context.operation)
            ? 'detached'
            : 'stopped';
        } catch (probeError) {
          return probeError;
        }
      } else {
        session.status = 'exited';
      }
    }
    session.updatedAt = new Date().toISOString();
    this.emitState('updated', session);
    this.persistNow();
    return error;
  }

  retire(id) {
    try {
      return Promise.resolve(this.transition(id, 'retire'));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  kill(id) {
    return this.transition(id, 'kill');
  }

  restart(id) {
    return this.transition(id, 'restart');
  }

  reconnect(id) {
    const session = this.required(id);
    if (session.retiring || session.terminationPending || session.terminationUncertain) {
      const error = new Error('명령창 프로그램을 종료하는 중에는 다시 연결할 수 없습니다.');
      error.code = 'TERMINAL_STOP_IN_PROGRESS';
      throw error;
    }
    if (session.options.sessionBackend !== 'managed-tmux') {
      throw new Error('일반 명령창은 화면 밖에서 실행 중인 작업에 다시 연결할 수 없습니다.');
    }
    if (session.process && session.status === 'running') return publicSession(session, true);
    if (!this.managedSessionExistsOrMarkUncertain(session, 'reconnect')) {
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

  detach(id, options = {}) {
    return this.transition(id, 'detach');
  }

  stop(id, options = {}) {
    return this.transition(id, 'stop');
  }

  close(id) {
    return this.transition(id, 'close');
  }

  dispose({ preserveSessions = false } = {}) {
    if (preserveSessions) {
      const pending = [];
      for (const session of [...this.sessions.values()]) {
        if (session.terminationUncertain) {
          pending.push(Promise.reject(this.uncertainTerminationError(session)));
          continue;
        }
        const existing = this.transitionPromises.get(session.id);
        if (existing) {
          pending.push(existing.promise);
          continue;
        }
        if (!session.process) continue;
        try {
          const completion = this.transition(session.id, 'host-shutdown');
          if (completion && typeof completion.then === 'function') pending.push(completion);
        } catch (error) {
          pending.push(Promise.reject(error));
        }
      }
      const finish = () => {
        if (!this.persistNow()) {
          const error = new Error('명령창 호스트 종료 상태를 저장하지 못했습니다.');
          error.code = 'TERMINATION_STATE_PERSIST_FAILED';
          throw error;
        }
        return { ok: true };
      };
      if (!pending.length) return finish();
      const completion = Promise.all(pending).then(() => this.dispose({ preserveSessions: true }));
      completion.catch(() => {});
      return completion;
    }
    const pending = [];
    for (const id of [...this.sessions.keys()]) {
      try {
        const completion = this.close(id);
        if (completion && typeof completion.then === 'function') pending.push(completion);
      } catch (error) {
        runBestEffort(`terminal-dispose:${id}`, () => { throw error; });
      }
    }
    const finish = () => {
      this.persistNow();
      return { ok: true };
    };
    if (!pending.length) return finish();
    const completion = Promise.allSettled(pending).then(finish);
    completion.catch(() => {});
    return completion;
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
  promptFingerprint,
  resolveWindowsCommand,
  resolvePosixShell,
};
