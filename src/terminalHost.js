'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { endpointFor, safeWriteJson } = require('./bridgeServer');
const { runBestEffort } = require('./diagnostics');

const TERMINAL_HOST_PROTOCOL = 10;
const TERMINAL_HOST_RUNTIME = `node-pty-${require('node-pty/package.json').version}`;
const MAX_FRAME_CHARS = 4 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const UPDATE_REQUEST_TOKEN = Symbol('terminal-host-update-request');
const ACTIVE_TERMINAL_STATUSES = new Set(['running', 'starting', 'stopping']);
const HOST_OPERATIONS = new Set([
  'list', 'get', 'create', 'write', 'command', 'respond', 'resize', 'signal',
  'restart', 'reconnect', 'detach', 'stop', 'close', 'retire',
]);

function isActiveTerminalSession(session) {
  return Boolean(session)
    && (ACTIVE_TERMINAL_STATUSES.has(session.status)
      || Boolean(session.terminationPending)
      || Boolean(session.terminationUncertain));
}

function sendFrame(socket, payload) {
  if (!socket || socket.destroyed) return;
  socket.write(`${JSON.stringify(payload)}\n`, 'utf8');
}

function incompatibleHostError(message, discovery) {
  const error = new Error(message);
  error.code = 'LOADTOAGENT_INCOMPATIBLE_TERMINAL_HOST';
  error.discovery = discovery;
  return error;
}

function hostReplacementUnconfirmedError(discovery, cause = null) {
  const error = new Error('이전 명령창 연결 프로그램의 종료를 확인하지 못해 새 연결 프로그램을 시작하지 않았습니다.');
  error.code = 'TERMINAL_HOST_REPLACEMENT_UNCONFIRMED';
  error.discovery = discovery;
  if (cause) error.cause = cause;
  return error;
}

function readHostDiscovery(file, fileSystem = fs, expectedRuntime = TERMINAL_HOST_RUNTIME) {
  const parsed = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
  if (!parsed?.endpoint || !parsed.token || !Number.isSafeInteger(Number(parsed.pid)) || Number(parsed.pid) <= 0) {
    throw new Error('명령창 연결 정보가 올바르지 않습니다.');
  }
  if (parsed.protocol !== TERMINAL_HOST_PROTOCOL || parsed.runtime !== expectedRuntime) {
    throw incompatibleHostError('현재 앱과 맞지 않는 명령창 연결 프로그램입니다.', parsed);
  }
  return parsed;
}

function verifyHostDiscovery(discovery, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(discovery.endpoint);
    let buffer = '';
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('이전 명령창 연결 확인 시간이 초과되었습니다.')), timeoutMs);
    socket.setNoDelay(true);
    socket.on('connect', () => sendFrame(socket, { type: 'authenticate', token: discovery.token }));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_FRAME_CHARS) {
        finish(new Error('이전 명령창 연결 프로그램이 보낸 내용이 너무 큽니다.'));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          if (JSON.parse(line).type === 'ready') {
            finish();
            return;
          }
        } catch (_invalidFrame) {}
      }
    });
    socket.on('error', finish);
    socket.on('close', () => {
      if (!settled) finish(new Error('이전 명령창 연결 확인이 중단되었습니다.'));
    });
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function waitForProcessCommand(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error, code = null, signal = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener?.('error', onError);
      child.removeListener?.('exit', onExit);
      if (error) reject(error);
      else resolve({ code, signal });
    };
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(null, code, signal);
    child.once('error', onError);
    child.once('exit', onExit);
    timer = setTimeout(() => {
      runBestEffort('terminal-host-terminate-command-timeout', () => child.kill());
      const error = new Error('이전 명령창 연결 프로그램의 전체 종료 명령이 시간 초과되었습니다.');
      error.code = 'TERMINAL_HOST_TREE_TERMINATION_TIMEOUT';
      finish(error);
    }, timeoutMs);
    if (child.exitCode !== null && child.exitCode !== undefined) {
      finish(null, child.exitCode, child.signalCode || null);
    }
  });
}

function terminalHostLockEndpoint(discoveryFile, platform = process.platform) {
  const resolved = path.resolve(String(discoveryFile || ''));
  const identity = platform === 'win32' ? resolved.toLowerCase() : resolved;
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  if (platform === 'win32') {
    return `\\\\.\\pipe\\loadtoagent-terminal-host-lock-${digest.slice(0, 32)}`;
  }
  if (platform === 'darwin') {
    return path.join(path.dirname(resolved), `.loadtoagent-terminal-host-${digest}.lock`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
  // Linux abstract Unix sockets are kernel-owned, disappear on process death,
  // and retain the full discovery identity without filesystem stale-file races.
  return `\0lta-th-${uid}-${digest}`;
}

function terminalHostLockError(cause, busy = false) {
  const error = new Error(busy
    ? '다른 명령창 연결 프로그램이 이미 시작 중이거나 실행 중입니다.'
    : `명령창 연결 프로그램의 단일 실행 잠금을 얻지 못했습니다: ${cause?.message || cause}`);
  error.code = busy ? 'TERMINAL_HOST_ALREADY_RUNNING' : 'TERMINAL_HOST_LOCK_FAILED';
  error.cause = cause;
  return error;
}

function acquireDarwinTerminalHostFileLock(discoveryFile, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const endpoint = options.endpoint || terminalHostLockEndpoint(discoveryFile, 'darwin');
  // O_EXLOCK is a Darwin open(2) flag. Combining it with O_NONBLOCK makes lock
  // acquisition atomic and crash-safe while leaving a harmless stable file.
  const constants = fileSystem.constants || fs.constants;
  const flags = Number(constants.O_CREAT) | Number(constants.O_RDWR)
    | Number(constants.O_NONBLOCK || 0x4) | Number(constants.O_NOFOLLOW || 0x100) | 0x20;
  let fileDescriptor;
  try {
    fileSystem.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    fileDescriptor = fileSystem.openSync(endpoint, flags, 0o600);
  } catch (cause) {
    const busy = cause?.code === 'EAGAIN' || cause?.code === 'EWOULDBLOCK';
    return Promise.reject(terminalHostLockError(cause, busy));
  }
  // A raw locked fd does not keep Node's event loop alive. Keep the daemon
  // referenced for as long as it owns O_EXLOCK, including fail-closed cleanup
  // paths. The timer is cleared only after closeSync confirms lock release.
  const keepAlive = setIntervalFn(() => {}, 60_000);
  let released = false;
  const release = () => {
    if (released) return Promise.resolve({ ok: true, alreadyReleased: true });
    try {
      fileSystem.closeSync(fileDescriptor);
      released = true;
      clearIntervalFn(keepAlive);
      return Promise.resolve({ ok: true });
    } catch (cause) {
      const error = new Error(`명령창 연결 프로그램의 단일 실행 잠금을 해제하지 못했습니다: ${cause.message}`);
      error.code = 'TERMINAL_HOST_LOCK_RELEASE_FAILED';
      error.cause = cause;
      return Promise.reject(error);
    }
  };
  return Promise.resolve({ endpoint, fileDescriptor, server: null, keepAlive, release });
}

function acquireTerminalHostProcessLock(discoveryFile, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'darwin') return acquireDarwinTerminalHostFileLock(discoveryFile, options);
  const endpoint = options.endpoint || terminalHostLockEndpoint(discoveryFile, platform);
  const createServer = typeof options.createServer === 'function' ? options.createServer : net.createServer;
  const server = createServer(socket => socket.destroy());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishFailure = cause => {
      if (settled) return;
      settled = true;
      server.removeListener('listening', finishSuccess);
       reject(terminalHostLockError(cause, cause?.code === 'EADDRINUSE'));
    };
    const finishSuccess = () => {
      if (settled) return;
      settled = true;
      server.removeListener('error', finishFailure);
      let released = false;
      let releasePromise = null;
      const release = () => {
        if (released) return Promise.resolve({ ok: true, alreadyReleased: true });
        if (releasePromise) return releasePromise;
        let releaseResolve;
        let releaseReject;
        const pendingRelease = new Promise((resolveRelease, rejectRelease) => {
          releaseResolve = resolveRelease;
          releaseReject = rejectRelease;
        });
        releasePromise = pendingRelease;
        let releaseSettled = false;
        const finishRelease = error => {
          if (releaseSettled) return;
          releaseSettled = true;
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
            const failure = new Error(`명령창 연결 프로그램의 단일 실행 잠금을 해제하지 못했습니다: ${error.message}`);
            failure.code = 'TERMINAL_HOST_LOCK_RELEASE_FAILED';
            failure.cause = error;
            releasePromise = null;
            releaseReject(failure);
            return;
          }
          released = true;
          releaseResolve({ ok: true });
        };
        try {
          server.close(error => {
            finishRelease(error);
          });
        } catch (error) {
          finishRelease(error);
        }
        return pendingRelease;
      };
      resolve({ endpoint, server, release });
    };
    server.once('error', finishFailure);
    server.once('listening', finishSuccess);
    try {
      server.listen(endpoint);
    } catch (error) {
      finishFailure(error);
    }
  });
}

function processGroupExists(pid, killProcess = process.kill.bind(process)) {
  try {
    killProcess(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function terminateHostProcess(discovery, options = {}) {
  const pid = Number(discovery?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error('교체할 명령창 연결 프로그램 정보가 올바르지 않습니다.');
  }
  const platform = options.platform || process.platform;
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 8_000);
  const exists = typeof options.processExists === 'function' ? options.processExists : processExists;
  const killProcess = typeof options.killProcess === 'function'
    ? options.killProcess
    : process.kill.bind(process);
  if (platform === 'win32') {
    const spawnProcess = typeof options.spawnProcess === 'function' ? options.spawnProcess : spawn;
    let child;
    try {
      child = spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (cause) {
      const error = new Error(`이전 명령창 연결 프로그램의 전체 종료 명령을 시작하지 못했습니다: ${cause.message}`);
      error.code = 'TERMINAL_HOST_TREE_TERMINATION_FAILED';
      error.cause = cause;
      throw error;
    }
    const result = await waitForProcessCommand(child, timeoutMs);
    if (result.code !== 0 || result.signal) {
      const error = new Error(`이전 명령창 연결 프로그램의 전체 종료 명령이 실패했습니다 (code=${result.code}, signal=${result.signal || 'none'}).`);
      error.code = 'TERMINAL_HOST_TREE_TERMINATION_FAILED';
      throw error;
    }
  } else {
    try {
      killProcess(-pid, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      if (exists(pid)) {
        const unsafe = new Error('이전 명령창 연결 프로그램의 분리된 프로세스 그룹을 확인하지 못했습니다.');
        unsafe.code = 'TERMINAL_HOST_PROCESS_GROUP_UNCONFIRMED';
        throw unsafe;
      }
      return;
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (exists(pid) || (platform !== 'win32' && processGroupExists(pid, killProcess))) {
    if (Date.now() >= deadline) {
      const error = new Error('이전 명령창 연결이 아직 끝나지 않았습니다.');
      error.code = 'TERMINAL_HOST_TREE_TERMINATION_TIMEOUT';
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function activeSessions(manager) {
  return manager.list().filter(isActiveTerminalSession);
}

class TerminalHostServer {
  constructor(options = {}) {
    this.manager = options.manager;
    this.platform = options.platform || process.platform;
    this.discoveryFile = path.resolve(options.discoveryFile || path.join(os.tmpdir(), 'loadtoagent-terminal-host.json'));
    this.endpoint = options.endpoint || endpointFor(this.platform, `${path.dirname(this.discoveryFile)}:terminal-host`);
    this.token = options.token || crypto.randomBytes(32).toString('hex');
    this.runtime = String(options.runtime || TERMINAL_HOST_RUNTIME);
    this.server = null;
    this.clients = new Set();
    this.shutdownTimer = null;
    this.idleShutdownMs = Number.isFinite(Number(options.idleShutdownMs))
      ? Math.max(0, Number(options.idleShutdownMs))
      : 1_500;
    this.onShutdown = typeof options.onShutdown === 'function' ? options.onShutdown : () => {};
    this.onManagerData = payload => this.broadcast({ type: 'event', event: 'data', payload });
    this.onManagerState = payload => {
      this.broadcast({ type: 'event', event: 'state', payload });
      this.scheduleShutdownIfIdle();
    };
  }

  info() {
    return {
      protocol: TERMINAL_HOST_PROTOCOL,
      runtime: this.runtime,
      endpoint: this.endpoint,
      token: this.token,
      pid: process.pid,
      platform: this.platform,
      updatedAt: new Date().toISOString(),
    };
  }

  start() {
    if (!this.manager) return Promise.reject(new Error('명령창 기능이 아직 준비되지 않았습니다.'));
    if (this.server) return Promise.resolve(this.info());
    if (this.platform !== 'win32' && fs.existsSync(this.endpoint)) {
      runBestEffort('terminal-host-stale-endpoint', () => fs.unlinkSync(this.endpoint));
    }
    this.server = net.createServer(socket => this.accept(socket));
    return new Promise((resolve, reject) => {
      const fail = error => {
        if (this.server) runBestEffort('terminal-host-start-close', () => this.server.close());
        this.server = null;
        reject(error);
      };
      this.server.once('error', fail);
      this.server.listen(this.endpoint, () => {
        this.server.removeListener('error', fail);
        try {
          safeWriteJson(this.discoveryFile, this.info());
          this.manager.on('data', this.onManagerData);
          this.manager.on('state', this.onManagerState);
          this.scheduleShutdownIfIdle();
          resolve(this.info());
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  accept(socket) {
    this.cancelIdleShutdown();
    socket.setNoDelay(true);
    const client = {
      socket,
      buffer: '',
      authenticated: false,
      queue: Promise.resolve(),
      authTimer: setTimeout(() => socket.destroy(new Error('명령창 연결 확인 시간이 초과되었습니다.')), AUTH_TIMEOUT_MS),
    };
    this.clients.add(client);
    socket.on('data', chunk => this.consume(client, chunk));
    socket.on('error', () => this.detach(client));
    socket.on('close', () => this.detach(client));
  }

  consume(client, chunk) {
    client.buffer += chunk.toString('utf8');
    if (client.buffer.length > MAX_FRAME_CHARS) {
      client.socket.destroy(new Error('명령창에 보낸 내용이 너무 큽니다.'));
      return;
    }
    let newline;
    while ((newline = client.buffer.indexOf('\n')) >= 0) {
      const line = client.buffer.slice(0, newline).trim();
      client.buffer = client.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_invalidFrame) {
        client.socket.destroy(new Error('명령창에 보낸 내용의 형식이 올바르지 않습니다.'));
        return;
      }
      client.queue = client.queue
        .then(() => this.handle(client, message || {}))
        .catch(error => sendFrame(client.socket, {
          type: 'response',
          requestId: String(message?.requestId || ''),
          ok: false,
          error: String(error?.message || error),
          code: String(error?.code || ''),
          deliveryId: String(error?.deliveryId || ''),
          deliveryState: ['rejected', 'unknown'].includes(error?.deliveryState) ? error.deliveryState : '',
        }));
    }
  }

  async handle(client, message) {
    if (!client.authenticated) {
      if (message.type !== 'authenticate' || message.token !== this.token) {
        throw new Error('명령창 연결을 확인하지 못했습니다.');
      }
      client.authenticated = true;
      clearTimeout(client.authTimer);
      client.authTimer = null;
      this.cancelIdleShutdown();
      sendFrame(client.socket, { type: 'ready', sessions: this.manager.list() });
      return;
    }
    if (message.type === 'control' && message.operation === 'shutdown-if-idle') {
      this.scheduleShutdownIfIdle();
      return;
    }
    if (message.type !== 'request' || !HOST_OPERATIONS.has(message.operation)) {
      throw new Error('이 명령창 작업은 사용할 수 없습니다.');
    }
    const operation = message.operation;
    const args = Array.isArray(message.args) ? message.args : [];
    const result = await Promise.resolve(this.manager[operation](...args));
    sendFrame(client.socket, { type: 'response', requestId: String(message.requestId || ''), ok: true, result });
  }

  broadcast(payload) {
    for (const client of this.clients) {
      if (client.authenticated) sendFrame(client.socket, payload);
    }
  }

  detach(client) {
    if (client.authTimer) clearTimeout(client.authTimer);
    this.clients.delete(client);
    this.scheduleShutdownIfIdle();
  }

  cancelIdleShutdown() {
    if (!this.shutdownTimer) return;
    clearTimeout(this.shutdownTimer);
    this.shutdownTimer = null;
  }

  scheduleShutdownIfIdle() {
    const connectedClients = [...this.clients].filter(entry => entry.authenticated && !entry.socket.destroyed);
    if (activeSessions(this.manager).length > 0 || connectedClients.length > 0) {
      this.cancelIdleShutdown();
      return;
    }
    if (this.shutdownTimer) return;
    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      const activeClients = [...this.clients].filter(entry => entry.authenticated && !entry.socket.destroyed);
      if (activeSessions(this.manager).length === 0 && activeClients.length === 0) this.onShutdown();
    }, this.idleShutdownMs);
    if (typeof this.shutdownTimer.unref === 'function') this.shutdownTimer.unref();
  }

  dispose() {
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
    this.shutdownTimer = null;
    this.manager.removeListener('data', this.onManagerData);
    this.manager.removeListener('state', this.onManagerState);
    for (const client of this.clients) runBestEffort('terminal-host-client-close', () => client.socket.destroy());
    this.clients.clear();
    if (this.server) runBestEffort('terminal-host-server-close', () => this.server.close());
    this.server = null;
    try {
      const current = readHostDiscovery(this.discoveryFile, fs, this.runtime);
      if (current.pid === process.pid && current.token === this.token) fs.unlinkSync(this.discoveryFile);
    } catch (_missingOrReplacedDiscovery) {}
    if (this.platform !== 'win32' && fs.existsSync(this.endpoint)) {
      runBestEffort('terminal-host-endpoint-cleanup', () => fs.unlinkSync(this.endpoint));
    }
  }
}

function launchTerminalHost(options = {}) {
  const executable = options.executable || process.execPath;
  const script = options.script;
  if (!script) throw new Error('명령창 연결에 필요한 파일 위치가 없습니다.');
  const config = Buffer.from(JSON.stringify({
    storeFile: options.storeFile,
    discoveryFile: options.discoveryFile,
    bridgeHome: options.bridgeHome,
  }), 'utf8').toString('base64');
  fs.mkdirSync(path.dirname(options.discoveryFile), { recursive: true });
  const child = (options.spawnProcess || spawn)(executable, [script, '--config', config], {
    cwd: path.dirname(options.discoveryFile),
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  return child.pid;
}

function resolveTerminalHostExecutable(options = {}) {
  const platform = options.platform || process.platform;
  const executable = String(options.executable || process.execPath);
  if (platform !== 'darwin' || !options.isPackaged) return executable;
  const targetPath = path.posix;
  const resolvedExecutable = targetPath.resolve(executable);
  const productName = targetPath.basename(resolvedExecutable);
  const helper = targetPath.resolve(
    targetPath.dirname(resolvedExecutable),
    '..',
    'Frameworks',
    `${productName} Helper.app`,
    'Contents',
    'MacOS',
    `${productName} Helper`,
  );
  const fileSystem = options.fileSystem || fs;
  return fileSystem.existsSync(helper) ? helper : executable;
}

class TerminalHostClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.discoveryFile = path.resolve(options.discoveryFile);
    this.spawnHost = typeof options.spawnHost === 'function' ? options.spawnHost : null;
    this.connectTimeoutMs = Number(options.connectTimeoutMs || 12_000);
    this.expectedRuntime = String(options.expectedRuntime || TERMINAL_HOST_RUNTIME);
    this.verifyHost = typeof options.verifyHost === 'function' ? options.verifyHost : verifyHostDiscovery;
    this.terminateHost = typeof options.terminateHost === 'function' ? options.terminateHost : terminateHostProcess;
    this.processExists = typeof options.processExists === 'function' ? options.processExists : processExists;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.hostLaunchLeaseMs = Math.max(30_000, Number(options.hostLaunchLeaseMs) || this.connectTimeoutMs * 4);
    this.hostLaunch = null;
    this.socket = null;
    this.buffer = '';
    this.connected = false;
    this.disposed = false;
    this.sessions = [];
    this.sessionsRevision = 0;
    this.listRequestGeneration = 0;
    this.sequence = 0;
    this.pending = new Map();
    this.handshake = null;
    this.connectPromise = null;
    this.connectGeneration = 0;
    this.discovery = null;
    this.updateShutdown = false;
  }

  connect(requestToken = null) {
    if (this.updateShutdown && requestToken !== UPDATE_REQUEST_TOKEN) {
      return Promise.reject(new Error('업데이트를 준비하는 동안 명령창 연결 프로그램을 다시 시작할 수 없습니다.'));
    }
    if (this.connected && this.socket && !this.socket.destroyed) return Promise.resolve(this);
    if (this.connectPromise) return this.connectPromise;
    this.disposed = false;
    const generation = ++this.connectGeneration;
    const connecting = this.connectLoop(generation);
    const tracked = connecting.finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = null;
    });
    this.connectPromise = tracked;
    return this.connectPromise;
  }

  hostLaunchPending() {
    const launch = this.hostLaunch;
    if (!launch) return false;
    if (Number.isSafeInteger(launch.pid) && launch.pid > 0) {
      try {
        if (this.processExists(launch.pid)) return true;
      } catch (_processStateUnconfirmed) {
        // PID uncertainty must never authorize a second daemon. Keep the
        // original launch lease until a later probe can prove that it exited.
        return true;
      }
      this.hostLaunch = null;
      return false;
    }
    if (this.now() < launch.expiresAt) return true;
    this.hostLaunch = null;
    return false;
  }

  async launchHostOnce() {
    if (this.hostLaunchPending()) {
      return { launched: false, pending: true, pid: this.hostLaunch?.pid || null };
    }
    if (!this.spawnHost) throw new Error('명령창 연결 프로그램을 시작할 수 없습니다.');
    const startedAt = this.now();
    // Record a fail-closed lease before invoking a potentially asynchronous
    // launcher. If it throws after creating a child, a later request must not
    // immediately create a second daemon with unknown ownership.
    this.hostLaunch = {
      pid: null,
      startedAt,
      expiresAt: startedAt + this.hostLaunchLeaseMs,
    };
    const launched = await Promise.resolve(this.spawnHost());
    const candidatePid = Number(launched && typeof launched === 'object' ? launched.pid : launched);
    const pid = Number.isSafeInteger(candidatePid) && candidatePid > 0 ? candidatePid : null;
    this.hostLaunch.pid = pid;
    return { launched: true, pending: true, pid };
  }

  async connectLoop(generation) {
    const deadline = Date.now() + this.connectTimeoutMs;
    let lastError = null;
    while (!this.disposed && generation === this.connectGeneration && Date.now() < deadline) {
      try {
        await this.connectExisting();
        if (this.disposed || generation !== this.connectGeneration) throw new Error('명령창 다시 연결이 취소되었습니다.');
        // A verified discovery/socket handshake acknowledges the launch. A
        // later reconnect may spawn a replacement only after this host exits.
        this.hostLaunch = null;
        return this;
      } catch (error) {
        lastError = error;
        this.resetSocket();
        if (error?.code === 'LOADTOAGENT_INCOMPATIBLE_TERMINAL_HOST') {
          let verified = false;
          try {
            await Promise.resolve(this.verifyHost(error.discovery));
            verified = true;
          } catch (verificationError) {
            lastError = verificationError;
          }
          if (verified) {
            await Promise.resolve(this.terminateHost(error.discovery));
            this.hostLaunch = null;
          } else {
            let previousHostExited = false;
            try {
              // Only a definite "not running" result may authorize a new
              // daemon. A live or unobservable legacy host does not own the
              // v10 process lock and could otherwise recover the same PTYs in
              // parallel with its replacement.
              previousHostExited = this.processExists(Number(error.discovery?.pid)) === false;
            } catch (processStateError) {
              throw hostReplacementUnconfirmedError(error.discovery, processStateError);
            }
            if (!previousHostExited) {
              throw hostReplacementUnconfirmedError(error.discovery, lastError);
            }
          }
        }
      }
      if (!this.spawnHost) throw lastError;
      // Re-evaluate the persistent launch lease after every failed attempt.
      // This still prevents duplicate daemons while the recorded PID lives,
      // but allows a replacement within the same connect loop once that PID
      // is proven dead.
      await this.launchHostOnce();
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    if (this.disposed || generation !== this.connectGeneration) throw new Error('명령창 다시 연결이 취소되었습니다.');
    throw new Error(`명령창에 연결하지 못했습니다: ${lastError?.message || '시간 초과'}`);
  }

  connectExisting() {
    const discovery = readHostDiscovery(this.discoveryFile, fs, this.expectedRuntime);
    this.discovery = discovery;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(discovery.endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('명령창 연결 시간이 초과되었습니다.'));
      }, 1_500);
      this.socket = socket;
      this.buffer = '';
      this.handshake = {
        resolve: () => { clearTimeout(timer); this.handshake = null; resolve(); },
        reject: error => { clearTimeout(timer); this.handshake = null; reject(error); },
      };
      socket.setNoDelay(true);
      socket.on('connect', () => sendFrame(socket, { type: 'authenticate', token: discovery.token }));
      socket.on('data', chunk => this.consume(chunk, socket));
      socket.on('error', error => this.handleSocketError(socket, error));
      socket.on('close', () => this.handleDisconnect(socket));
    });
  }

  handleSocketError(socket, error) {
    if (socket && socket !== this.socket) return;
    if (this.handshake) this.handshake.reject(error);
  }

  consume(chunk, socket = this.socket) {
    if (socket && socket !== this.socket) return;
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > MAX_FRAME_CHARS) {
      this.socket?.destroy(new Error('명령창 연결 프로그램이 보낸 내용이 너무 큽니다.'));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type === 'ready') {
        this.sessions = Array.isArray(message.sessions) ? message.sessions : [];
        this.sessionsRevision += 1;
        this.connected = true;
        if (this.handshake) this.handshake.resolve();
      } else if (message.type === 'response') {
        const pending = this.pending.get(String(message.requestId || ''));
        if (!pending) continue;
        this.pending.delete(String(message.requestId || ''));
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else {
          const error = new Error(String(message.error || '명령창 작업 실패'));
          if (message.code) error.code = String(message.code);
          if (message.deliveryId) error.deliveryId = String(message.deliveryId);
          if (['rejected', 'unknown'].includes(message.deliveryState)) error.deliveryState = message.deliveryState;
          pending.reject(error);
        }
      } else if (message.type === 'event' && message.event === 'data') {
        this.emit('data', message.payload);
      } else if (message.type === 'event' && message.event === 'state') {
        if (Array.isArray(message.payload?.sessions)) {
          this.sessions = message.payload.sessions;
          this.sessionsRevision += 1;
        }
        this.emit('state', message.payload);
      }
    }
  }

  handleDisconnect(socket = this.socket) {
    if (socket && socket !== this.socket) return;
    const wasConnected = this.connected;
    this.connected = false;
    if (this.handshake) this.handshake.reject(new Error('명령창 연결이 닫혔습니다.'));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('명령창 연결이 닫혔습니다.'));
    }
    this.pending.clear();
    this.socket = null;
    if (wasConnected && !this.disposed) {
      this.emit('disconnect');
      this.connect()
        .then(() => this.emit('reconnect', { sessions: this.list() }))
        .catch(error => {
          if (!this.disposed) this.emit('reconnect-error', error);
        });
    }
  }

  resetSocket() {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.buffer = '';
    if (socket) socket.destroy();
  }

  async requestWithToken(requestToken, operation, args) {
    if (this.updateShutdown && requestToken !== UPDATE_REQUEST_TOKEN) {
      throw new Error('업데이트를 준비하는 동안 명령창 작업을 요청할 수 없습니다.');
    }
    if (!this.connected || !this.socket || this.socket.destroyed) {
      await this.connect(requestToken);
    }
    if (this.updateShutdown && requestToken !== UPDATE_REQUEST_TOKEN) {
      throw new Error('업데이트를 준비하는 동안 명령창 작업을 요청할 수 없습니다.');
    }
    if (!this.connected || !this.socket || this.socket.destroyed) {
      throw new Error('명령창이 연결되어 있지 않습니다.');
    }
    const requestId = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('명령창 작업이 제한 시간 안에 끝나지 않았습니다.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      sendFrame(this.socket, { type: 'request', requestId, operation, args });
    });
  }

  request(operation, ...args) {
    return this.requestWithToken(null, operation, args);
  }

  requestForUpdate(operation, ...args) {
    return this.requestWithToken(UPDATE_REQUEST_TOKEN, operation, args);
  }

  list() { return this.sessions.map(session => ({ ...session })); }
  async listFreshWithToken(requestToken = null) {
    const generation = ++this.listRequestGeneration;
    const revision = this.sessionsRevision;
    const sessions = requestToken === UPDATE_REQUEST_TOKEN
      ? await this.requestForUpdate('list')
      : await this.request('list');
    if (!Array.isArray(sessions)) throw new Error('명령창 작업 상태를 새로 확인하지 못했습니다.');
    // A state event or a newer list request may have landed while this request
    // was in flight. Never let its older snapshot erase the newer registry.
    if (revision !== this.sessionsRevision || generation !== this.listRequestGeneration) return this.list();
    this.sessions = sessions;
    this.sessionsRevision += 1;
    return this.list();
  }
  listFresh() { return this.listFreshWithToken(); }
  listFreshForUpdate() { return this.listFreshWithToken(UPDATE_REQUEST_TOKEN); }
  get(id, includeReplay = true) { return this.request('get', id, includeReplay); }
  create(options) {
    if (this.updateShutdown) throw new Error('업데이트를 준비하는 동안 새 명령창 작업을 시작할 수 없습니다.');
    return this.request('create', options);
  }
  write(id, data) { return this.request('write', id, data); }
  command(id, command, options) { return this.request('command', id, command, options || {}); }
  respond(id, choiceKey) { return this.request('respond', id, choiceKey); }
  resize(id, cols, rows) { return this.request('resize', id, cols, rows); }
  signal(id, signal) {
    if (this.updateShutdown) throw new Error('업데이트를 준비하는 동안 명령창 신호를 보낼 수 없습니다.');
    return this.request('signal', id, signal);
  }
  restart(id) {
    if (this.updateShutdown) throw new Error('업데이트를 준비하는 동안 명령창 작업을 다시 시작할 수 없습니다.');
    return this.request('restart', id);
  }
  reconnect(id) {
    if (this.updateShutdown) throw new Error('업데이트를 준비하는 동안 명령창 작업을 다시 연결할 수 없습니다.');
    return this.request('reconnect', id);
  }
  detach(id, options = null) {
    if (this.updateShutdown) throw new Error('업데이트를 준비하는 동안 명령창 분리 작업을 따로 시작할 수 없습니다.');
    return options ? this.request('detach', id, options) : this.request('detach', id);
  }
  stop(id, options = null) {
    if (this.updateShutdown) throw new Error('업데이트를 준비하는 동안 명령창 종료 작업을 따로 시작할 수 없습니다.');
    return options ? this.request('stop', id, options) : this.request('stop', id);
  }
  close(id) {
    if (this.updateShutdown) throw new Error('업데이트를 준비하는 동안 명령창 삭제 작업을 시작할 수 없습니다.');
    return this.request('close', id);
  }
  retire(id) {
    if (this.updateShutdown) throw new Error('업데이트를 준비하는 동안 명령창 정리 작업을 시작할 수 없습니다.');
    return this.request('retire', id);
  }

  async waitForRetirements(sessions, deadline) {
    let current = Array.isArray(sessions) ? sessions : [];
    while (current.some(session => session?.status === 'stopping'
      || session?.terminationPending
      || session?.terminationUncertain)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error('업데이트 전에 정리 중인 명령창 작업이 끝나지 않았습니다.');
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(50, remainingMs)));
      current = await this.listFreshForUpdate();
    }
    return current;
  }

  async shutdownForUpdate(sessions = null, timeoutMs = 8_000) {
    this.updateShutdown = true;
    try {
      const shutdownTimeoutMs = Math.max(1_000, Number(timeoutMs) || 8_000);
      const retirementDeadline = Date.now() + shutdownTimeoutMs;
      const confirmed = Array.isArray(sessions) ? sessions : null;
      let current = await this.listFreshForUpdate();
      if (confirmed) {
        const confirmedIds = new Set(confirmed
          .filter(isActiveTerminalSession)
          .map(session => session.id));
        const unconfirmed = current.find(session => isActiveTerminalSession(session)
          && !confirmedIds.has(session.id));
        if (unconfirmed) throw new Error('업데이트 준비 중 새 명령창 작업이 시작되었습니다. 상태를 확인한 뒤 다시 시도해 주세요.');
      }
      current = await this.waitForRetirements(current, retirementDeadline);
      const active = current
        .filter(session => session && ['running', 'starting'].includes(session.status))
        .sort((left, right) => Number(left.backend !== 'managed-tmux') - Number(right.backend !== 'managed-tmux'));
      for (const session of active) {
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            if (session.backend === 'managed-tmux') {
              await this.requestForUpdate('detach', session.id, { waitForExit: true });
            } else {
              await this.requestForUpdate('stop', session.id, { waitForExit: true });
            }
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            try {
              const latest = await this.listFreshForUpdate();
              const remaining = latest.find(candidate => candidate.id === session.id
                && ['running', 'starting'].includes(candidate.status));
              if (!remaining) {
                lastError = null;
                break;
              }
            } catch (_statusCheckError) {
              // Retry the original transition; never assume work stopped when status cannot be refreshed.
            }
          }
        }
        if (lastError) throw lastError;
      }
      const settled = await this.waitForRetirements(await this.listFreshForUpdate(), retirementDeadline);
      const remaining = settled.filter(session => isActiveTerminalSession(session));
      if (remaining.length) throw new Error('업데이트 전에 모든 명령창 작업을 안전하게 정리하지 못했습니다.');
      const discovery = this.discovery || readHostDiscovery(this.discoveryFile, fs, this.expectedRuntime);
      const pid = Number(discovery.pid);
      if (!this.connected || !this.socket || this.socket.destroyed) {
        throw new Error('업데이트 전에 명령창 연결 프로그램을 종료하지 못했습니다.');
      }
      this.disposed = true;
      this.connectGeneration += 1;
      sendFrame(this.socket, { type: 'control', operation: 'shutdown-if-idle' });
      this.socket.end();
      const deadline = Date.now() + shutdownTimeoutMs;
      while (processExists(pid)) {
        if (Date.now() >= deadline) {
          throw new Error('업데이트 전에 명령창 연결 프로그램이 완전히 종료되지 않았습니다.');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { ok: true, stopped: active.length };
    } catch (error) {
      this.updateShutdown = false;
      throw error;
    }
  }

  recoverAfterUpdateFailure() {
    this.updateShutdown = false;
    this.disposed = false;
    return this.connect();
  }

  dispose({ shutdownIfIdle = false } = {}) {
    this.disposed = true;
    this.connectGeneration += 1;
    if (this.socket && !this.socket.destroyed) {
      if (shutdownIfIdle) sendFrame(this.socket, { type: 'control', operation: 'shutdown-if-idle' });
      this.socket.end();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('명령창 연결 프로그램이 종료되었습니다.'));
    }
    this.pending.clear();
  }
}

module.exports = {
  TerminalHostServer,
  TerminalHostClient,
  TERMINAL_HOST_PROTOCOL,
  TERMINAL_HOST_RUNTIME,
  readHostDiscovery,
  verifyHostDiscovery,
  terminateHostProcess,
  terminalHostLockEndpoint,
  acquireTerminalHostProcessLock,
  launchTerminalHost,
  resolveTerminalHostExecutable,
};
