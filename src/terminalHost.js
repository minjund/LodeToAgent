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

const TERMINAL_HOST_PROTOCOL = 1;
const MAX_FRAME_CHARS = 4 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const HOST_OPERATIONS = new Set(['list', 'get', 'create', 'write', 'command', 'resize', 'signal', 'restart', 'close']);

function sendFrame(socket, payload) {
  if (!socket || socket.destroyed) return;
  socket.write(`${JSON.stringify(payload)}\n`, 'utf8');
}

function readHostDiscovery(file, fileSystem = fs) {
  const parsed = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
  if (parsed?.protocol !== TERMINAL_HOST_PROTOCOL || !parsed.endpoint || !parsed.token) {
    throw new Error('터미널 호스트 연결 정보가 올바르지 않습니다.');
  }
  return parsed;
}

function activeSessions(manager) {
  return manager.list().filter(session => session.status === 'running' || session.status === 'starting');
}

class TerminalHostServer {
  constructor(options = {}) {
    this.manager = options.manager;
    this.platform = options.platform || process.platform;
    this.discoveryFile = path.resolve(options.discoveryFile || path.join(os.tmpdir(), 'loadtoagent-terminal-host.json'));
    this.endpoint = options.endpoint || endpointFor(this.platform, `${path.dirname(this.discoveryFile)}:terminal-host`);
    this.token = options.token || crypto.randomBytes(32).toString('hex');
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
      endpoint: this.endpoint,
      token: this.token,
      pid: process.pid,
      platform: this.platform,
      updatedAt: new Date().toISOString(),
    };
  }

  start() {
    if (!this.manager) return Promise.reject(new Error('터미널 관리자가 준비되지 않았습니다.'));
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
      authTimer: setTimeout(() => socket.destroy(new Error('터미널 호스트 인증 시간이 초과되었습니다.')), AUTH_TIMEOUT_MS),
    };
    this.clients.add(client);
    socket.on('data', chunk => this.consume(client, chunk));
    socket.on('error', () => this.detach(client));
    socket.on('close', () => this.detach(client));
  }

  consume(client, chunk) {
    client.buffer += chunk.toString('utf8');
    if (client.buffer.length > MAX_FRAME_CHARS) {
      client.socket.destroy(new Error('터미널 호스트 요청이 너무 큽니다.'));
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
        client.socket.destroy(new Error('터미널 호스트 요청 형식이 올바르지 않습니다.'));
        return;
      }
      client.queue = client.queue
        .then(() => this.handle(client, message || {}))
        .catch(error => sendFrame(client.socket, {
          type: 'response',
          requestId: String(message?.requestId || ''),
          ok: false,
          error: String(error?.message || error),
        }));
    }
  }

  async handle(client, message) {
    if (!client.authenticated) {
      if (message.type !== 'authenticate' || message.token !== this.token) {
        throw new Error('터미널 호스트 인증에 실패했습니다.');
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
      throw new Error('지원하지 않는 터미널 호스트 작업입니다.');
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
      const current = readHostDiscovery(this.discoveryFile);
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
  if (!script) throw new Error('터미널 호스트 스크립트 경로가 없습니다.');
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
    this.socket = null;
    this.buffer = '';
    this.connected = false;
    this.disposed = false;
    this.sessions = [];
    this.sequence = 0;
    this.pending = new Map();
    this.handshake = null;
    this.connectPromise = null;
    this.connectGeneration = 0;
  }

  connect() {
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

  async connectLoop(generation) {
    const deadline = Date.now() + this.connectTimeoutMs;
    let launched = false;
    let lastError = null;
    while (!this.disposed && generation === this.connectGeneration && Date.now() < deadline) {
      try {
        await this.connectExisting();
        if (this.disposed || generation !== this.connectGeneration) throw new Error('터미널 호스트 재연결이 취소되었습니다.');
        return this;
      } catch (error) {
        lastError = error;
        this.resetSocket();
      }
      if (!launched) {
        if (!this.spawnHost) throw lastError;
        await Promise.resolve(this.spawnHost());
        launched = true;
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    if (this.disposed || generation !== this.connectGeneration) throw new Error('터미널 호스트 재연결이 취소되었습니다.');
    throw new Error(`터미널 호스트에 연결하지 못했습니다: ${lastError?.message || '시간 초과'}`);
  }

  connectExisting() {
    const discovery = readHostDiscovery(this.discoveryFile);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(discovery.endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('터미널 호스트 연결 시간이 초과되었습니다.'));
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
      this.socket?.destroy(new Error('터미널 호스트 응답이 너무 큽니다.'));
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
        this.connected = true;
        if (this.handshake) this.handshake.resolve();
      } else if (message.type === 'response') {
        const pending = this.pending.get(String(message.requestId || ''));
        if (!pending) continue;
        this.pending.delete(String(message.requestId || ''));
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(String(message.error || '터미널 호스트 작업 실패')));
      } else if (message.type === 'event' && message.event === 'data') {
        this.emit('data', message.payload);
      } else if (message.type === 'event' && message.event === 'state') {
        if (Array.isArray(message.payload?.sessions)) this.sessions = message.payload.sessions;
        this.emit('state', message.payload);
      }
    }
  }

  handleDisconnect(socket = this.socket) {
    if (socket && socket !== this.socket) return;
    const wasConnected = this.connected;
    this.connected = false;
    if (this.handshake) this.handshake.reject(new Error('터미널 호스트 연결이 닫혔습니다.'));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('터미널 호스트 연결이 닫혔습니다.'));
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

  async request(operation, ...args) {
    if (!this.connected || !this.socket || this.socket.destroyed) {
      await this.connect();
    }
    if (!this.connected || !this.socket || this.socket.destroyed) {
      throw new Error('터미널 호스트에 연결되어 있지 않습니다.');
    }
    const requestId = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`터미널 호스트 작업 시간이 초과되었습니다: ${operation}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      sendFrame(this.socket, { type: 'request', requestId, operation, args });
    });
  }

  list() { return this.sessions.map(session => ({ ...session })); }
  get(id, includeReplay = true) { return this.request('get', id, includeReplay); }
  create(options) { return this.request('create', options); }
  write(id, data) { return this.request('write', id, data); }
  command(id, command) { return this.request('command', id, command); }
  resize(id, cols, rows) { return this.request('resize', id, cols, rows); }
  signal(id, signal) { return this.request('signal', id, signal); }
  restart(id) { return this.request('restart', id); }
  close(id) { return this.request('close', id); }

  dispose({ shutdownIfIdle = false } = {}) {
    this.disposed = true;
    this.connectGeneration += 1;
    if (this.socket && !this.socket.destroyed) {
      if (shutdownIfIdle) sendFrame(this.socket, { type: 'control', operation: 'shutdown-if-idle' });
      this.socket.end();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('터미널 호스트 클라이언트가 종료되었습니다.'));
    }
    this.pending.clear();
  }
}

module.exports = {
  TerminalHostServer,
  TerminalHostClient,
  TERMINAL_HOST_PROTOCOL,
  readHostDiscovery,
  launchTerminalHost,
  resolveTerminalHostExecutable,
};
