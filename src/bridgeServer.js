'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { AGENT_PROVIDERS } = require('./terminalManager');
const { runBestEffort } = require('./diagnostics');

const PROTOCOL_VERSION = 1;
const MAX_FRAME_CHARS = 1024 * 1024;
const AUTH_TIMEOUT_MS = 10_000;

function bridgeDirectory(home = os.homedir()) {
  return path.join(home, '.loadtoagent');
}

function discoveryFile(home = os.homedir()) {
  return path.join(bridgeDirectory(home), 'bridge.json');
}

function endpointFor(platform = process.platform, home = os.homedir(), nonce = crypto.randomBytes(8).toString('hex')) {
  const identity = crypto.createHash('sha256').update(`${home}:${nonce}`).digest('hex').slice(0, 18);
  if (platform === 'win32') return `\\\\.\\pipe\\loadtoagent-${identity}`;
  return path.join(os.tmpdir(), `loadtoagent-${typeof process.getuid === 'function' ? process.getuid() : 'user'}-${identity}.sock`);
}

function safeWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  runBestEffort('bridge-temp-permissions', () => fs.chmodSync(temporary, 0o600));
  fs.renameSync(temporary, file);
  runBestEffort('bridge-discovery-permissions', () => fs.chmodSync(file, 0o600));
}

function sendFrame(socket, payload) {
  if (!socket || socket.destroyed) return;
  socket.write(`${JSON.stringify(payload)}\n`, 'utf8');
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
    this.file = options.discoveryFile || discoveryFile(this.home);
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
          safeWriteJson(this.file, this.info());
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
    return {
      protocol: PROTOCOL_VERSION,
      endpoint: this.endpoint,
      token: this.token,
      pid: process.pid,
      platform: this.platform,
      updatedAt: new Date().toISOString(),
    };
  }

  accept(socket) {
    socket.setNoDelay(true);
    const client = { socket, buffer: '', authenticated: false, terminalId: '', bridgeId: '', authTimer: null };
    client.authTimer = setTimeout(() => {
      if (!client.authenticated) socket.destroy(new Error('외부 명령창 연결 확인 시간이 초과되었습니다.'));
    }, AUTH_TIMEOUT_MS);
    this.clients.set(socket, client);
    socket.on('data', chunk => this.consume(client, chunk));
    socket.on('error', () => this.detach(client));
    socket.on('close', () => this.detach(client));
  }

  consume(client, chunk) {
    client.buffer += chunk.toString('utf8');
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
      try { this.handle(client, message || {}); } catch (error) {
        sendFrame(client.socket, { type: 'error', message: String(error.message || error) });
        if (!client.authenticated) client.socket.end();
      }
    }
  }

  handle(client, message) {
    if (!client.authenticated) {
      if (message.type !== 'run' || message.token !== this.token) throw new Error('LoadToAgent와 외부 명령창의 연결을 확인하지 못했습니다.');
      const provider = validProvider(message.provider);
      if (!provider) throw new Error('선택한 AI 종류는 사용할 수 없습니다.');
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
      sendFrame(client.socket, {
        type: 'started',
        bridgeId,
        terminalId: session.id,
        pid: session.pid,
        replay: Buffer.from(session.replay || '', 'utf8').toString('base64'),
      });
      return;
    }
    if (message.type === 'input') {
      this.terminalManager.write(client.terminalId, decodeBase64(message.data));
    } else if (message.type === 'resize') {
      this.terminalManager.resize(client.terminalId, message.cols, message.rows);
    } else if (message.type === 'signal') {
      this.terminalManager.signal(client.terminalId, message.signal);
    } else if (message.type === 'close') {
      this.terminalManager.close(client.terminalId);
      client.socket.end();
    } else throw new Error('이 외부 명령창 요청은 지원하지 않습니다.');
  }

  forwardData(payload) {
    for (const client of this.clients.values()) {
      if (client.terminalId === payload.id) sendFrame(client.socket, { type: 'output', data: Buffer.from(String(payload.data || ''), 'utf8').toString('base64') });
    }
  }

  forwardState(payload) {
    const session = payload && payload.session;
    if (!session) return;
    for (const client of this.clients.values()) {
      if (client.terminalId !== session.id) continue;
      sendFrame(client.socket, { type: 'state', status: session.status, exitCode: session.exitCode, signal: session.signal });
      if (['detached', 'stopped', 'exited', 'failed'].includes(session.status)) client.socket.end();
    }
  }

  detach(client) {
    if (client.authTimer) clearTimeout(client.authTimer);
    this.clients.delete(client.socket);
  }

  dispose() {
    this.detachTerminalListeners();
    for (const client of this.clients.values()) {
      runBestEffort('bridge-client-close', () => client.socket.destroy());
    }
    this.clients.clear();
    if (this.server) {
      runBestEffort('bridge-server-close', () => this.server.close());
      this.server = null;
    }
    if (fs.existsSync(this.file)) runBestEffort('bridge-discovery-cleanup', () => fs.unlinkSync(this.file));
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
  endpointFor,
  safeWriteJson,
  decodeBase64,
};
