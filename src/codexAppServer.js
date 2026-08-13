'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn: spawnChild } = require('child_process');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

const CODEX_APP_SERVER_LISTEN_URL = 'ws://127.0.0.1:0';
const CODEX_APP_SERVER_ARGUMENTS = Object.freeze([
  'app-server',
  '--listen',
  CODEX_APP_SERVER_LISTEN_URL,
]);
const LISTENING_LINE_PATTERN = /^listening on: ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_READY_REQUEST_TIMEOUT_MS = 750;
const DEFAULT_READY_RETRY_MS = 75;
const DEFAULT_TERMINATION_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TAIL_CHARS = 8 * 1024;
const MAX_PENDING_LINE_CHARS = 16 * 1024;

function positiveDuration(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function codedError(message, code, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function validLoopbackEndpoint(value) {
  const match = String(value || '').match(/^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u);
  if (!match) return '';
  const port = Number(match[1]);
  return port <= 65_535 ? `ws://127.0.0.1:${port}` : '';
}

function parseCodexAppServerListeningLine(value) {
  // Codex currently indents this status line. Trimming the line is deliberate,
  // but the payload itself must remain an exact localhost WebSocket endpoint.
  const line = String(value == null ? '' : value).replace(/\r$/u, '').trim();
  const match = line.match(LISTENING_LINE_PATTERN);
  if (!match) return '';
  return validLoopbackEndpoint(`ws://127.0.0.1:${match[1]}`);
}

function parseCodexAppServerEndpoint(value) {
  for (const line of String(value == null ? '' : value).split(/\n/u)) {
    const endpoint = parseCodexAppServerListeningLine(line);
    if (endpoint) return endpoint;
  }
  return '';
}

class CodexAppServerOutputParser {
  constructor(options = {}) {
    this.decoder = options.decoder || new StringDecoder('utf8');
    this.buffer = '';
  }

  push(chunk) {
    if (chunk == null) return '';
    this.buffer += Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)
      ? this.decoder.write(Buffer.from(chunk.buffer || chunk, chunk.byteOffset || 0, chunk.byteLength))
      : String(chunk);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    if (this.buffer.length > MAX_PENDING_LINE_CHARS) {
      this.buffer = this.buffer.slice(-MAX_PENDING_LINE_CHARS);
    }
    for (const line of lines) {
      const endpoint = parseCodexAppServerListeningLine(line);
      if (endpoint) return endpoint;
    }
    // A five-digit port cannot be a prefix of another valid port, so accepting
    // it also supports emitters that do not terminate their final status line.
    const trailing = parseCodexAppServerListeningLine(this.buffer);
    return trailing && /:\d{5}$/u.test(trailing) ? trailing : '';
  }

  end(chunk) {
    const streamedEndpoint = chunk != null ? this.push(chunk) : '';
    this.buffer += this.decoder.end();
    const endpoint = streamedEndpoint || parseCodexAppServerEndpoint(this.buffer);
    this.buffer = '';
    return endpoint;
  }
}

function codexAppServerReadyUrl(endpoint) {
  const valid = validLoopbackEndpoint(endpoint);
  if (!valid) throw codedError('Codex app-server endpoint is not a localhost WebSocket URL.', 'CODEX_APP_SERVER_INVALID_ENDPOINT');
  return `http://${valid.slice('ws://'.length)}/readyz`;
}

function codexRemoteArguments(endpoint) {
  const valid = validLoopbackEndpoint(endpoint);
  if (!valid) throw codedError('Codex app-server endpoint is not ready.', 'CODEX_APP_SERVER_NOT_READY');
  return ['--remote', valid];
}

function codexAppServerLaunchSpec(options = {}) {
  const platform = options.platform || process.platform;
  const cwd = options.cwd || undefined;
  const env = options.env || process.env;
  if (platform === 'win32') {
    const pathKey = Object.keys(env).find(name => name.toLowerCase() === 'path');
    const pathValue = pathKey ? String(env[pathKey] || '') : '';
    const candidates = [];
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
      for (const extension of ['.exe', '.com', '.cmd', '.bat']) {
        candidates.push(path.join(directory, `codex${extension}`));
      }
    }
    let command = String(options.command || '').trim() || candidates.find(candidate => {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    });
    if (!command) {
      const appData = String(env.APPDATA || '').trim();
      const npmCandidates = appData ? ['codex.exe', 'codex.com', 'codex.cmd', 'codex.bat']
        .map(name => path.join(appData, 'npm', name)) : [];
      command = npmCandidates.find(candidate => {
        try { return fs.statSync(candidate).isFile(); } catch { return false; }
      });
    }
    if (!command) {
      throw codedError('Codex CLI executable was not found on PATH.', 'CODEX_APP_SERVER_COMMAND_NOT_FOUND');
    }
    if (/\.(?:cmd|bat)$/iu.test(command)) {
      return {
        file: env.ComSpec || env.COMSPEC || 'cmd.exe',
        // Passing CALL, the already-resolved absolute shim path, and every
        // fixed argument separately lets Node apply Win32 argv quoting while
        // CALL handles paths containing spaces without shell interpolation.
        args: ['/d', '/v:off', '/s', '/c', 'call', command, ...CODEX_APP_SERVER_ARGUMENTS],
        options: {
          cwd,
          env,
          windowsHide: true,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      };
    }
    return {
      file: command,
      args: [...CODEX_APP_SERVER_ARGUMENTS],
      options: {
        cwd,
        env,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    };
  }
  return {
    file: 'codex',
    args: [...CODEX_APP_SERVER_ARGUMENTS],
    options: {
      cwd,
      env,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  };
}

function requestCodexAppServerReady(endpoint, options = {}) {
  const timeoutMs = positiveDuration(options.timeoutMs, DEFAULT_READY_REQUEST_TIMEOUT_MS);
  const get = options.httpGet || http.get;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request = null;
    let timer = null;
    const finish = (error, ready = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (error) reject(error);
      else resolve(Boolean(ready));
    };
    try {
      request = get(codexAppServerReadyUrl(endpoint), {
        agent: false,
        headers: { Connection: 'close' },
      }, response => {
        if (typeof response.resume === 'function') response.resume();
        finish(null, response.statusCode === 200);
      });
      request.once('error', finish);
      timer = setTimeout(() => {
        const error = codedError('Codex app-server readiness request timed out.', 'CODEX_APP_SERVER_READY_REQUEST_TIMEOUT');
        try { request.destroy(error); } catch {}
        finish(error);
      }, timeoutMs);
    } catch (error) {
      finish(error);
    }
  });
}

function waitForCommandExit(child, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    if (!child || child.exitCode != null || child.signalCode != null) {
      resolve({ code: child?.exitCode ?? 0, signal: child?.signalCode || null });
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      if (timer) (options.clearTimeout || clearTimeout)(timer);
      timer = null;
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve(result);
    };
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(null, { code, signal });
    child.once('error', onError);
    child.once('exit', onExit);
    timer = (options.setTimeout || setTimeout)(() => {
      const error = codedError('Codex app-server termination command timed out.', 'CODEX_APP_SERVER_TERMINATION_COMMAND_TIMEOUT');
      try { child.kill(); } catch {}
      finish(error);
    }, timeoutMs);
  });
}

async function terminateCodexAppServerChild(child, options = {}) {
  const platform = options.platform || process.platform;
  const timeoutMs = positiveDuration(options.timeoutMs, DEFAULT_TERMINATION_TIMEOUT_MS);
  const isExited = typeof options.isExited === 'function'
    ? options.isExited
    : () => child?.exitCode != null || child?.signalCode != null;
  if (!child || isExited()) return { ok: true, alreadyExited: true };
  const pid = Number(child.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw codedError('Codex app-server process id is unavailable.', 'CODEX_APP_SERVER_TERMINATION_UNCONFIRMED');
  }
  if (platform === 'win32') {
    const spawnProcess = options.spawnProcess || spawnChild;
    let killer;
    try {
      killer = spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (cause) {
      throw codedError('Could not start Codex app-server process-tree termination.', 'CODEX_APP_SERVER_TERMINATION_FAILED', cause);
    }
    const result = await waitForCommandExit(killer, timeoutMs, options);
    if ((result.code !== 0 || result.signal) && !isExited()) {
      throw codedError(
        `Codex app-server process-tree termination failed (code=${result.code}, signal=${result.signal || 'none'}).`,
        'CODEX_APP_SERVER_TERMINATION_FAILED',
      );
    }
    return { ok: true, taskkill: true };
  }
  const killProcess = options.killProcess || process.kill.bind(process);
  const now = options.now || Date.now;
  const wait = options.delay || (milliseconds => new Promise(resolve => (
    (options.setTimeout || setTimeout)(resolve, milliseconds)
  )));
  try {
    killProcess(-pid, 'SIGTERM');
  } catch (error) {
    // ESRCH proves that the dedicated process group is already absent. The
    // owning CodexAppServer still waits for the child `exit` event separately
    // in terminateRecord(), so accepting this signal-delivery race cannot
    // acknowledge cleanup before the wrapper process is reaped.
    if (error?.code === 'ESRCH') return { ok: true, processGroup: true, alreadyExited: true };
    throw codedError('Could not terminate the Codex app-server process group.', 'CODEX_APP_SERVER_TERMINATION_FAILED', error);
  }
  const deadline = now() + timeoutMs;
  while (true) {
    try {
      killProcess(-pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') break;
      if (error?.code !== 'EPERM') {
        throw codedError('Could not confirm Codex app-server process-group termination.', 'CODEX_APP_SERVER_TERMINATION_UNCONFIRMED', error);
      }
    }
    if (now() >= deadline) {
      throw codedError(
        'Codex app-server process group did not exit before the termination timeout.',
        'CODEX_APP_SERVER_TERMINATION_TIMEOUT',
      );
    }
    await wait(Math.min(25, Math.max(1, deadline - now())));
  }
  return { ok: true, processGroup: true };
}

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

class CodexAppServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.platform = options.platform || process.platform;
    this.cwd = options.cwd || undefined;
    this.env = options.env || process.env;
    this.command = String(options.command || '').trim();
    this.startupTimeoutMs = positiveDuration(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    this.readyRequestTimeoutMs = positiveDuration(options.readyRequestTimeoutMs, DEFAULT_READY_REQUEST_TIMEOUT_MS);
    this.readyRetryMs = positiveDuration(options.readyRetryMs, DEFAULT_READY_RETRY_MS);
    this.terminationTimeoutMs = positiveDuration(options.terminationTimeoutMs, DEFAULT_TERMINATION_TIMEOUT_MS);
    this.spawnProcess = options.spawnProcess || spawnChild;
    this.spawnTerminationProcess = options.spawnTerminationProcess || spawnChild;
    this.requestReady = options.requestReady || requestCodexAppServerReady;
    this.terminateProcess = options.terminateProcess || terminateCodexAppServerChild;
    this.now = options.now || Date.now;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.delay = options.delay || (milliseconds => new Promise(resolve => this.setTimeout(resolve, milliseconds)));
    this.onDiagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : () => {};
    this.record = null;
    this.readyEndpoint = '';
    this.ensurePromise = null;
    this.disposePromise = null;
    this.disposed = false;
    this.generation = 0;
  }

  get endpoint() {
    return this.record && !this.record.exited && this.record.ready ? this.readyEndpoint : '';
  }

  get running() {
    return Boolean(this.record && !this.record.exited);
  }

  remoteArguments() {
    return codexRemoteArguments(this.endpoint);
  }

  currentInfo() {
    const endpoint = this.endpoint;
    const pid = Number(this.record?.child?.pid);
    return {
      running: this.running,
      ready: Boolean(endpoint),
      endpoint,
      remoteArguments: endpoint ? codexRemoteArguments(endpoint) : [],
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      generation: Number(this.record?.id) || 0,
      disposed: this.disposed,
    };
  }

  ensureReady() {
    if (this.disposed) {
      return Promise.reject(codedError('Codex app-server has been disposed.', 'CODEX_APP_SERVER_DISPOSED'));
    }
    if (this.endpoint) return Promise.resolve(this.endpoint);
    if (this.ensurePromise) return this.ensurePromise;
    if (this.record && !this.record.exited) {
      return Promise.reject(codedError(
        'A previous Codex app-server process is still present after an unconfirmed startup cleanup.',
        'CODEX_APP_SERVER_PROCESS_UNCONFIRMED',
        this.record.cleanupError || null,
      ));
    }
    const pending = this.startAttempt();
    this.ensurePromise = pending;
    pending.finally(() => {
      if (this.ensurePromise === pending) this.ensurePromise = null;
    }).catch(() => {});
    return pending;
  }

  createRecord(child) {
    const lifecycle = deferred();
    const exited = deferred();
    const record = {
      id: ++this.generation,
      child,
      endpoint: '',
      ready: false,
      exited: false,
      spawnError: null,
      exitCode: null,
      exitSignal: null,
      lifecycle,
      exitedSignal: exited,
      lifecycleSettled: false,
      outputTail: '',
      stdoutParser: new CodexAppServerOutputParser(),
      stderrParser: new CodexAppServerOutputParser(),
      terminationPromise: null,
    };
    const settleLifecycle = value => {
      if (record.lifecycleSettled) return;
      record.lifecycleSettled = true;
      record.lifecycle.resolve(value);
    };
    const acceptOutput = parser => chunk => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk == null ? '' : chunk);
      record.outputTail = `${record.outputTail}${text}`.slice(-MAX_OUTPUT_TAIL_CHARS);
      const endpoint = parser.push(chunk);
      if (endpoint) record.endpoint = endpoint;
    };
    child.stdout?.on('data', acceptOutput(record.stdoutParser));
    child.stderr?.on('data', acceptOutput(record.stderrParser));
    child.once('error', error => {
      record.spawnError = error;
      settleLifecycle({ type: 'error', error });
      if (!Number.isSafeInteger(Number(child.pid)) || Number(child.pid) <= 0) {
        record.exited = true;
        record.exitedSignal.resolve({ type: 'error', error });
        this.invalidate(record);
      }
    });
    child.once('exit', (code, signal) => {
      record.exited = true;
      record.exitCode = code;
      record.exitSignal = signal;
      record.exitedSignal.resolve({ type: 'exit', code, signal });
      settleLifecycle({ type: 'exit', code, signal });
      this.invalidate(record);
    });
    return record;
  }

  invalidate(record) {
    if (this.record !== record) return;
    this.record = null;
    this.readyEndpoint = '';
    record.ready = false;
    const event = {
      generation: record.id,
      pid: Number(record.child?.pid) || null,
      code: record.exitCode,
      signal: record.exitSignal,
      error: record.spawnError || null,
    };
    this.emit('exit', event);
    try {
      this.onDiagnostic({
        event: 'exit',
        ...event,
      });
    } catch {}
  }

  lifecycleFailure(record, event) {
    if (event?.type === 'error') {
      return codedError(`Codex app-server could not start: ${event.error?.message || 'unknown error'}`, 'CODEX_APP_SERVER_START_FAILED', event.error);
    }
    const detail = record.outputTail.trim().slice(-2_000);
    const suffix = detail ? `\n${detail}` : '';
    return codedError(
      `Codex app-server exited before becoming ready (code=${event?.code}, signal=${event?.signal || 'none'}).${suffix}`,
      'CODEX_APP_SERVER_EXITED',
    );
  }

  async waitUntilReady(record) {
    const deadline = this.now() + this.startupTimeoutMs;
    let lastProbeError = null;
    while (this.record === record && !record.exited && !this.disposed) {
      if (record.lifecycleSettled) {
        const event = await record.lifecycle.promise;
        throw this.lifecycleFailure(record, event);
      }
      const endpoint = record.endpoint;
      if (endpoint) {
        try {
          const ready = await Promise.race([
            Promise.resolve(this.requestReady(endpoint, { timeoutMs: this.readyRequestTimeoutMs })),
            record.lifecycle.promise.then(event => { throw this.lifecycleFailure(record, event); }),
          ]);
          if (ready && this.record === record && !record.exited && !this.disposed) return endpoint;
        } catch (error) {
          if (error?.code === 'CODEX_APP_SERVER_EXITED' || error?.code === 'CODEX_APP_SERVER_START_FAILED') throw error;
          lastProbeError = error;
        }
      }
      if (this.now() >= deadline) {
        throw codedError(
          'Codex app-server did not become ready before the startup timeout.',
          'CODEX_APP_SERVER_READY_TIMEOUT',
          lastProbeError,
        );
      }
      await Promise.race([
        this.delay(Math.min(this.readyRetryMs, Math.max(1, deadline - this.now()))),
        record.lifecycle.promise.then(event => { throw this.lifecycleFailure(record, event); }),
      ]);
    }
    if (this.disposed) throw codedError('Codex app-server has been disposed.', 'CODEX_APP_SERVER_DISPOSED');
    if (record.exited || this.record !== record) {
      const event = await record.lifecycle.promise;
      throw this.lifecycleFailure(record, event);
    }
    throw codedError('Codex app-server startup was interrupted.', 'CODEX_APP_SERVER_START_FAILED');
  }

  async startAttempt() {
    let child;
    let record;
    try {
      const spec = codexAppServerLaunchSpec({
        platform: this.platform,
        cwd: this.cwd,
        env: this.env,
        command: this.command,
      });
      child = this.spawnProcess(spec.file, spec.args, spec.options);
      record = this.createRecord(child);
      this.record = record;
      const endpoint = await this.waitUntilReady(record);
      if (this.disposed || this.record !== record || record.exited) {
        throw codedError('Codex app-server startup was interrupted.', 'CODEX_APP_SERVER_START_FAILED');
      }
      record.ready = true;
      this.readyEndpoint = endpoint;
      const event = { generation: record.id, pid: Number(record.child?.pid) || null, endpoint };
      this.emit('ready', event);
      try { this.onDiagnostic({ event: 'ready', ...event }); } catch {}
      return endpoint;
    } catch (error) {
      if (record && !record.exited) {
        try {
          await this.terminateRecord(record);
        } catch (cleanupError) {
          record.cleanupError = cleanupError;
          error.cleanupError = cleanupError;
        }
      }
      throw error;
    }
  }

  terminateRecord(record) {
    if (!record || record.exited) return Promise.resolve({ ok: true, alreadyExited: true });
    if (record.terminationPromise) return record.terminationPromise;
    const timeoutMs = this.terminationTimeoutMs;
    const timeout = new Promise((_, reject) => {
      record.terminationTimer = this.setTimeout(() => {
        reject(codedError(
          'Codex app-server did not confirm process exit before the termination timeout.',
          'CODEX_APP_SERVER_TERMINATION_TIMEOUT',
        ));
      }, timeoutMs);
    });
    const termination = Promise.resolve().then(() => this.terminateProcess(record.child, {
      platform: this.platform,
      timeoutMs,
      spawnProcess: this.spawnTerminationProcess,
      isExited: () => record.exited,
      setTimeout: this.setTimeout,
      clearTimeout: this.clearTimeout,
      now: this.now,
      delay: this.delay,
    }));
    const confirmation = record.exitedSignal.promise.then(() => ({ ok: true, exited: true }));
    record.terminationPromise = Promise.race([
      Promise.all([termination, confirmation]).then(([, result]) => result),
      timeout,
    ]).finally(() => {
      if (record.terminationTimer) this.clearTimeout(record.terminationTimer);
      record.terminationTimer = null;
    });
    return record.terminationPromise;
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const record = this.record;
    this.readyEndpoint = '';
    if (!record || record.exited) {
      this.disposePromise = Promise.resolve({ ok: true, alreadyExited: true });
      return this.disposePromise;
    }
    record.ready = false;
    this.disposePromise = this.terminateRecord(record);
    return this.disposePromise;
  }
}

module.exports = {
  CODEX_APP_SERVER_ARGUMENTS,
  CODEX_APP_SERVER_LISTEN_URL,
  CodexAppServer,
  CodexAppServerOutputParser,
  codexAppServerLaunchSpec,
  codexAppServerReadyUrl,
  codexRemoteArguments,
  parseCodexAppServerEndpoint,
  parseCodexAppServerListeningLine,
  requestCodexAppServerReady,
  terminateCodexAppServerChild,
};
