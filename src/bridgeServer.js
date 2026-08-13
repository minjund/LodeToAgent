'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { AGENT_PROVIDERS } = require('./terminalManager');
const { runBestEffort } = require('./diagnostics');

const PROTOCOL_VERSION = 1;
const MAX_FRAME_CHARS = 1024 * 1024;
const MAX_OUTBOUND_QUEUE_BYTES = 16 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 10_000;

function bridgeDirectory(home = os.homedir()) {
  return path.join(home, '.whitebox');
}

function discoveryFile(home = os.homedir()) {
  return path.join(bridgeDirectory(home), 'bridge.json');
}

function legacyDiscoveryFile(home = os.homedir()) {
  return path.join(home, '.loadtoagent', 'bridge.json');
}

function endpointFor(platform = process.platform, home = os.homedir(), nonce = crypto.randomBytes(8).toString('hex')) {
  const identity = crypto.createHash('sha256').update(`${home}:${nonce}`).digest('hex').slice(0, 18);
  if (platform === 'win32') return `\\\\.\\pipe\\whitebox-${identity}`;
  return path.join(os.tmpdir(), `whitebox-${typeof process.getuid === 'function' ? process.getuid() : 'user'}-${identity}.sock`);
}

function safeWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  runBestEffort('bridge-temp-permissions', () => fs.chmodSync(temporary, 0o600));
  fs.renameSync(temporary, file);
  runBestEffort('bridge-discovery-permissions', () => fs.chmodSync(file, 0o600));
}

function validProvider(value) {
  const provider = String(value || '').toLowerCase();
  return AGENT_PROVIDERS[provider] ? provider : '';
}

function decodeBase64(value) {
  const encoded = String(value || '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('외부 명령창에서 받은 글자를 읽을 수 없습니다.');
  }
  return Buffer.from(encoded, 'base64').toString('utf8');
}

class BridgeServer {
  constructor(options = {}) {
    this.terminalManager = options.terminalManager;
    this.home = options.home || os.homedir();
    this.platform = options.platform || process.platform;
    this.endpoint = options.endpoint || endpointFor(this.platform, this.home);
    this.token = options.token || crypto.randomBytes(32).toString('hex');
    const explicitDiscoveryFile = typeof options.discoveryFile === 'string' && options.discoveryFile.trim();
    this.file = explicitDiscoveryFile || discoveryFile(this.home);
    this.discoveryFiles = [this.file];
    if (!explicitDiscoveryFile && options.legacyDiscovery !== false) {
      this.discoveryFiles.push(legacyDiscoveryFile(this.home));
    }
    this.maxOutboundQueueBytes = Number.isFinite(Number(options.maxOutboundQueueBytes))
      ? Math.max(1, Number(options.maxOutboundQueueBytes))
      : MAX_OUTBOUND_QUEUE_BYTES;
    this.beforeRun = typeof options.beforeRun === 'function' ? options.beforeRun : null;
    this.extraInfo = typeof options.extraInfo === 'function' ? options.extraInfo : null;
    this.server = null;
    this.clients = new Map();
    this.terminalListenersAttached = false;
    this.onTerminalData = payload => this.forwardData(payload);
    this.onTerminalState = payload => this.forwardState(payload);
  }

  start() {
    if (!this.terminalManager) return Promise.reject(new Error('명령창 기능이 아직 준비되지 않았습니다.'));
    if (this.server) return Promise.resolve(this.info());
    if (this.platform !== 'win32') {
      if (fs.existsSync(this.endpoint)) runBestEffort('bridge-stale-endpoint', () => fs.unlinkSync(this.endpoint));
    }
    this.server = net.createServer(socket => this.accept(socket));
    return new Promise((resolve, reject) => {
      const fail = error => {
        if (this.server) {
          runBestEffort('bridge-start-close', () => this.server.close());
        }
        this.server = null;
        reject(error);
      };
      this.server.once('error', fail);
      this.server.listen(this.endpoint, () => {
        this.server.removeListener('error', fail);
        try {
          this.refreshDiscovery();
          this.attachTerminalListeners();
          resolve(this.info());
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  attachTerminalListeners() {
    if (this.terminalListenersAttached) return;
    this.terminalManager.on('data', this.onTerminalData);
    this.terminalManager.on('state', this.onTerminalState);
    this.terminalListenersAttached = true;
  }

  detachTerminalListeners() {
    if (!this.terminalManager || !this.terminalListenersAttached) return;
    this.terminalManager.removeListener('data', this.onTerminalData);
    this.terminalManager.removeListener('state', this.onTerminalState);
    this.terminalListenersAttached = false;
  }

  info() {
    const extra = this.extraInfo ? this.extraInfo() : null;
    return {
      protocol: PROTOCOL_VERSION,
      endpoint: this.endpoint,
      token: this.token,
      pid: process.pid,
      platform: this.platform,
      ...(extra && typeof extra === 'object' ? extra : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  refreshDiscovery() {
    if (!this.server) return this.info();
    const info = this.info();
    for (const file of this.discoveryFiles) safeWriteJson(file, info);
    return info;
  }

  accept(socket) {
    socket.setNoDelay(true);
    const client = {
      socket,
      buffer: '',
      decoder: new StringDecoder('utf8'),
      authenticated: false,
      terminalId: '',
      bridgeId: '',
      authTimer: null,
      outboundQueue: [],
      outboundBytes: 0,
      outboundInFlightBytes: 0,
      outboundBlocked: false,
      outboundFlushing: false,
      outboundEndRequested: false,
      outboundEndCalled: false,
      detached: false,
      preparing: false,
      queue: Promise.resolve(),
    };
    client.onDrain = () => {
      if (client.detached) return;
      client.outboundBlocked = false;
      client.outboundInFlightBytes = 0;
      this.flushOutbound(client);
    };
    client.authTimer = setTimeout(() => {
      if (!client.authenticated) socket.destroy(new Error('외부 명령창 연결 확인 시간이 초과되었습니다.'));
    }, AUTH_TIMEOUT_MS);
    this.clients.set(socket, client);
    socket.on('data', chunk => this.consume(client, chunk));
    socket.on('drain', client.onDrain);
    socket.on('error', () => this.detach(client));
    socket.on('close', () => this.detach(client));
  }

  consume(client, chunk) {
    client.buffer += client.decoder.write(chunk);
    if (client.buffer.length > MAX_FRAME_CHARS) return client.socket.destroy(new Error('외부 명령창에서 받은 내용이 너무 큽니다.'));
    let newline;
    while ((newline = client.buffer.indexOf('\n')) >= 0) {
      const line = client.buffer.slice(0, newline).trim();
      client.buffer = client.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_invalidBridgeFrame) {
        return client.socket.destroy(new Error('외부 명령창에서 받은 메시지 형식이 올바르지 않습니다.'));
      }
      client.queue = client.queue.then(() => {
        if (client.detached || client.outboundEndRequested) return undefined;
        return Promise.resolve(this.handle(client, message || {}));
      })
        .catch(error => {
          this.enqueueFrame(client, { type: 'error', message: String(error.message || error) });
          if (!client.authenticated) this.endWhenFlushed(client);
        });
      if (client.detached || client.outboundEndRequested) return;
    }
  }

  handle(client, message) {
    if (!client.authenticated) {
      if (message.type !== 'run' || message.token !== this.token) throw new Error('Whitebox와 외부 명령창의 연결을 확인하지 못했습니다.');
      const provider = validProvider(message.provider);
      if (!provider) throw new Error('선택한 AI 종류는 사용할 수 없습니다.');
      // A valid, authenticated run may need to wait for the Codex app-server
      // readiness budget. Stop the unauthenticated-socket deadline now; the
      // queued preparation still has to succeed before the client is marked
      // authenticated or any provider PTY is created.
      client.preparing = true;
      if (client.authTimer) clearTimeout(client.authTimer);
      client.authTimer = null;
      const start = () => {
        // Codex app-server preparation is asynchronous. The CLI can disconnect
        // while it is in flight, in which case creating an unattached PTY
        // would leak a provider process that no client can control.
        client.preparing = false;
        if (client.detached || client.outboundEndRequested) return null;
        // Keep the discovery file current so another local Codex client can
        // opt into the exact same app-server endpoint.
        if (this.extraInfo) this.refreshDiscovery();
        const bridgeId = crypto.randomUUID();
        const session = this.terminalManager.create({
          type: 'agent',
          provider,
          args: Array.isArray(message.args) ? message.args : [],
          cwd: message.cwd || this.home,
          title: `외부 연결 · ${AGENT_PROVIDERS[provider].label}`,
          bridgeId,
          cols: message.cols,
          rows: message.rows,
        });
        client.authenticated = true;
        clearTimeout(client.authTimer);
        client.authTimer = null;
        client.terminalId = session.id;
        client.bridgeId = bridgeId;
        this.enqueueFrame(client, {
          type: 'started',
          bridgeId,
          terminalId: session.id,
          pid: session.pid,
          replay: Buffer.from(session.replay || '', 'utf8').toString('base64'),
        });
        return session;
      };
      const preparation = this.beforeRun ? this.beforeRun({ ...message, provider }) : null;
      return preparation && typeof preparation.then === 'function'
        ? Promise.resolve(preparation).then(start, error => {
            client.preparing = false;
            throw error;
          })
        : start();
    }
    if (message.type === 'input') {
      this.terminalManager.write(client.terminalId, decodeBase64(message.data));
    } else if (message.type === 'resize') {
      this.terminalManager.resize(client.terminalId, message.cols, message.rows);
    } else if (message.type === 'signal') {
      const signaling = this.terminalManager.signal(client.terminalId, message.signal);
      if (signaling && typeof signaling.then === 'function') {
        Promise.resolve(signaling).catch(error => {
          this.enqueueFrame(client, { type: 'error', message: String(error.message || error) });
        });
      }
    } else if (message.type === 'close') {
      const closing = this.terminalManager.close(client.terminalId);
      if (closing && typeof closing.then === 'function') {
        Promise.resolve(closing).then(
          () => this.endWhenFlushed(client),
          error => this.enqueueFrame(client, { type: 'error', message: String(error.message || error) }),
        );
      } else {
        this.endWhenFlushed(client);
      }
    } else throw new Error('이 외부 명령창 요청은 지원하지 않습니다.');
  }

  forwardData(payload) {
    for (const client of this.clients.values()) {
      if (client.terminalId === payload.id) this.enqueueFrame(client, { type: 'output', data: Buffer.from(String(payload.data || ''), 'utf8').toString('base64') });
    }
  }

  forwardState(payload) {
    const session = payload && payload.session;
    if (!session) return;
    for (const client of this.clients.values()) {
      if (client.terminalId !== session.id) continue;
      this.enqueueFrame(client, { type: 'state', status: session.status, exitCode: session.exitCode, signal: session.signal });
      if (['detached', 'stopped', 'exited', 'failed'].includes(session.status)) this.endWhenFlushed(client);
    }
  }

  enqueueFrame(client, payload) {
    if (!client || client.detached || client.outboundEndRequested
      || !this.clients.has(client.socket) || client.socket.destroyed) return false;
    let frame;
    try {
      frame = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    } catch (error) {
      runBestEffort('bridge-frame-encode', () => client.socket.destroy(error));
      return false;
    }
    const socketBuffered = Math.max(0, Number(client.socket.writableLength) || 0);
    const bufferedBytes = Math.max(client.outboundInFlightBytes, socketBuffered);
    if (bufferedBytes + client.outboundBytes + frame.length > this.maxOutboundQueueBytes) {
      const error = new Error('외부 명령창 출력 전송 대기열이 가득 차 연결을 종료합니다.');
      error.code = 'BRIDGE_CLIENT_BACKPRESSURE_OVERFLOW';
      client.outboundQueue.length = 0;
      client.outboundBytes = 0;
      runBestEffort('bridge-backpressure-overflow', () => client.socket.destroy(error));
      return false;
    }
    client.outboundQueue.push(frame);
    client.outboundBytes += frame.length;
    this.flushOutbound(client);
    return true;
  }

  flushOutbound(client) {
    if (!client || client.detached || client.outboundBlocked || client.outboundFlushing
      || client.socket.destroyed || !this.clients.has(client.socket)) return;
    client.outboundFlushing = true;
    try {
      while (!client.outboundBlocked && !client.detached && !client.socket.destroyed
        && client.outboundQueue.length > 0) {
        const frame = client.outboundQueue.shift();
        client.outboundBytes = Math.max(0, client.outboundBytes - frame.length);
        let writable;
        try {
          writable = client.socket.write(frame);
        } catch (error) {
          runBestEffort('bridge-socket-write', () => client.socket.destroy(error));
          break;
        }
        if (!writable) {
          client.outboundBlocked = true;
          client.outboundInFlightBytes = Math.max(frame.length, Number(client.socket.writableLength) || 0);
        }
      }
    } finally {
      client.outboundFlushing = false;
    }
    if (client.outboundEndRequested && !client.outboundEndCalled && !client.outboundBlocked
      && client.outboundQueue.length === 0 && !client.socket.destroyed) {
      client.outboundEndCalled = true;
      client.socket.end();
    }
  }

  endWhenFlushed(client) {
    if (!client || client.detached || client.socket.destroyed) return;
    client.outboundEndRequested = true;
    this.flushOutbound(client);
  }

  detach(client) {
    if (!client || client.detached) return;
    client.detached = true;
    if (client.authTimer) clearTimeout(client.authTimer);
    client.authTimer = null;
    if (client.onDrain) client.socket.removeListener?.('drain', client.onDrain);
    client.outboundQueue.length = 0;
    client.outboundBytes = 0;
    client.outboundInFlightBytes = 0;
    client.outboundBlocked = false;
    client.outboundEndRequested = false;
    client.outboundEndCalled = false;
    this.clients.delete(client.socket);
  }

  dispose() {
    this.detachTerminalListeners();
    for (const client of [...this.clients.values()]) {
      this.detach(client);
      runBestEffort('bridge-client-close', () => client.socket.destroy());
    }
    this.clients.clear();
    if (this.server) {
      runBestEffort('bridge-server-close', () => this.server.close());
      this.server = null;
    }
    for (const file of this.discoveryFiles) {
      if (fs.existsSync(file)) runBestEffort('bridge-discovery-cleanup', () => fs.unlinkSync(file));
    }
    if (this.platform !== 'win32') {
      if (fs.existsSync(this.endpoint)) runBestEffort('bridge-endpoint-cleanup', () => fs.unlinkSync(this.endpoint));
    }
  }
}

module.exports = {
  BridgeServer,
  PROTOCOL_VERSION,
  bridgeDirectory,
  discoveryFile,
  legacyDiscoveryFile,
  endpointFor,
  safeWriteJson,
  decodeBase64,
};
