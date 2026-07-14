'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn: spawnChild } = require('child_process');

const MAX_SESSIONS = 24;
const MAX_INPUT_CHARS = 128 * 1024;
const MAX_REPLAY_CHARS = 2 * 1024 * 1024;
const TERMINAL_TYPES = new Set(['powershell', 'cmd', 'shell', 'wsl', 'tmux', 'agent']);
const AGENT_PROVIDERS = Object.freeze({
  claude: { command: 'claude', label: 'Claude' },
  codex: { command: 'codex', label: 'GPT · Codex' },
  gemini: { command: 'gemini', label: 'Gemini' },
  grok: { command: 'grok', label: 'Grok' },
});

function cleanText(value, max = 200) {
  return String(value == null ? '' : value).replace(/[\u0000\r\n]/g, ' ').trim().slice(0, max);
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
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';
  return env;
}

function powershellExecutable() {
  const modern = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return fs.existsSync(modern) ? modern : 'powershell.exe';
}

function killPtyTree(handle, pid) {
  if (!handle) return;
  if (process.platform !== 'win32' || !Number.isFinite(Number(pid))) {
    try { handle.kill(); } catch {}
    return;
  }
  try {
    const killer = spawnChild('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('exit', code => {
      if (code === 0 || handle.__lodestarExited) return;
      try { handle.kill(); } catch {}
    });
    killer.unref();
  } catch {
    try { handle.kill(); } catch {}
  }
}

function normalizeLaunchOptions(options = {}, platform = process.platform) {
  const fallbackType = platform === 'win32' ? 'powershell' : 'shell';
  const type = TERMINAL_TYPES.has(options.type) ? options.type : fallbackType;
  const suppliedCwd = String(options.cwd || '').trim();
  const localCwd = suppliedCwd || os.homedir();
  if (['powershell', 'cmd', 'shell', 'agent'].includes(type) && (!fs.existsSync(localCwd) || !fs.statSync(localCwd).isDirectory())) {
    throw new Error(`작업 폴더를 찾을 수 없습니다: ${localCwd}`);
  }
  const distro = cleanText(options.distro, 100);
  if ((type === 'wsl' || type === 'tmux') && !distro) throw new Error(type === 'tmux' ? 'tmux 환경을 선택하세요.' : 'WSL 배포판을 선택하세요.');
  const tmuxSession = cleanText(options.tmuxSession, 100);
  const tmuxPane = cleanText(options.tmuxPane, 100);
  if (type === 'tmux' && !tmuxSession) throw new Error('연결할 tmux 세션이 필요합니다.');
  const provider = cleanText(options.provider, 30).toLowerCase();
  if (type === 'agent' && !AGENT_PROVIDERS[provider]) throw new Error('지원하지 않는 AI 제공사입니다.');
  const args = Array.isArray(options.args)
    ? options.args.slice(0, 80).map(value => cleanText(value, 2_000))
    : [];
  return {
    type,
    cwd: ['powershell', 'cmd', 'shell', 'agent'].includes(type) ? path.resolve(localCwd) : suppliedCwd,
    distro,
    tmuxSession,
    tmuxPane,
    provider,
    args,
    bridgeId: cleanText(options.bridgeId, 100),
    title: cleanText(options.title, 100),
    cols: numericDimension(options.cols, 120, 20, 500),
    rows: numericDimension(options.rows, 32, 5, 200),
  };
}

function launchSpec(options, platform = process.platform, agentProviders = AGENT_PROVIDERS) {
  if (options.type === 'powershell') {
    const file = powershellExecutable();
    return { file, args: ['-NoLogo'], cwd: options.cwd, label: path.basename(file, '.exe') };
  }
  if (options.type === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: ['/Q'], cwd: options.cwd, label: '명령 프롬프트' };
  if (options.type === 'shell') {
    const file = process.env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    return { file, args: ['-l'], cwd: options.cwd, label: path.basename(file) };
  }
  if (options.type === 'agent') {
    const provider = agentProviders[options.provider] || AGENT_PROVIDERS[options.provider];
    return { file: provider.command, args: [...(provider.args || []), ...options.args], cwd: options.cwd, label: provider.label };
  }
  if (options.type === 'wsl') {
    const args = ['-d', options.distro];
    if (options.cwd) args.push('--cd', options.cwd);
    return { file: 'wsl.exe', args, cwd: os.homedir(), label: `${options.distro} 셸` };
  }
  const selectPane = options.tmuxPane ? `tmux select-pane -t ${shellQuote(options.tmuxPane)} 2>/dev/null || true; ` : '';
  const script = `${selectPane}exec tmux attach-session -t ${shellQuote(options.tmuxSession)}`;
  if (platform !== 'win32') {
    return { file: process.env.SHELL || '/bin/sh', args: ['-lc', script], cwd: options.cwd || os.homedir(), label: `tmux · ${options.tmuxSession}` };
  }
  return {
    file: 'wsl.exe',
    args: ['-d', options.distro, '--', 'sh', '-lc', script],
    cwd: os.homedir(),
    label: `tmux · ${options.tmuxSession}`,
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
    bridgeId: session.options.bridgeId,
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

class TerminalManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ptyModule = options.ptyModule || null;
    this.killTree = options.killTree || killPtyTree;
    this.platform = options.platform || process.platform;
    this.agentProviders = options.agentProviders || AGENT_PROVIDERS;
    this.sessions = new Map();
  }

  pty() {
    if (!this.ptyModule) this.ptyModule = require('node-pty');
    return this.ptyModule;
  }

  create(rawOptions = {}) {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`동시에 열 수 있는 터미널은 최대 ${MAX_SESSIONS}개입니다.`);
    const options = normalizeLaunchOptions(rawOptions, this.platform);
    const spec = launchSpec(options, this.platform, this.agentProviders);
    const id = `terminal:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`;
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
    };
    this.sessions.set(id, session);
    this.spawn(session);
    return publicSession(session, true);
  }

  spawn(session) {
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
      session.pid = processHandle.pid;
      session.status = 'running';
      session.updatedAt = new Date().toISOString();
      processHandle.onData(data => {
        if (session.generation !== generation) return;
        const text = String(data || '');
        session.replay = `${session.replay}${text}`.slice(-MAX_REPLAY_CHARS);
        session.updatedAt = new Date().toISOString();
        this.emit('data', { id: session.id, data: text });
      });
      processHandle.onExit(event => {
        processHandle.__lodestarExited = true;
        if (session.generation !== generation) return;
        session.process = null;
        session.status = 'exited';
        session.exitCode = Number.isFinite(event.exitCode) ? event.exitCode : null;
        session.signal = Number.isFinite(event.signal) ? event.signal : null;
        session.updatedAt = new Date().toISOString();
        this.emitState('updated', session);
      });
      this.emitState('updated', session);
    } catch (error) {
      session.process = null;
      session.status = 'failed';
      session.updatedAt = new Date().toISOString();
      session.replay += `\r\n[Lodestar] 터미널을 시작하지 못했습니다: ${error.message}\r\n`;
      this.emit('data', { id: session.id, data: session.replay });
      this.emitState('updated', session);
      throw error;
    }
  }

  emitState(change, session) {
    this.emit('state', { change, session: session ? publicSession(session, false) : null, sessions: this.list() });
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
    if (!session) throw new Error('터미널 세션을 찾을 수 없습니다.');
    return session;
  }

  write(id, value) {
    const session = this.required(id);
    if (!session.process || session.status !== 'running') throw new Error('실행 중인 터미널이 아닙니다.');
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
    throw new Error('지원하지 않는 터미널 신호입니다.');
  }

  kill(id) {
    const session = this.required(id);
    if (session.process) {
      const handle = session.process;
      session.process = null;
      session.generation += 1;
      this.killTree(handle, session.pid);
    }
    session.status = 'exited';
    session.updatedAt = new Date().toISOString();
    this.emitState('updated', session);
    return { ok: true };
  }

  restart(id) {
    const session = this.required(id);
    if (session.process) {
      const handle = session.process;
      session.process = null;
      session.generation += 1;
      this.killTree(handle, session.pid);
    }
    session.replay = '';
    this.spawn(session);
    return publicSession(session, true);
  }

  close(id) {
    const session = this.required(id);
    if (session.process) {
      const handle = session.process;
      session.process = null;
      session.generation += 1;
      this.killTree(handle, session.pid);
    }
    session.status = 'exited';
    session.updatedAt = new Date().toISOString();
    this.sessions.delete(session.id);
    this.emit('state', { change: 'removed', session: publicSession(session, false), sessions: this.list() });
    return { ok: true };
  }

  dispose() {
    for (const id of [...this.sessions.keys()]) {
      try { this.close(id); } catch {}
    }
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
};
