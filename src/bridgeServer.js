'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { AGENT_PROVIDERS } = require('./terminalManager');

const PROTOCOL_VERSION = 1;
const MAX_FRAME_CHARS = 1024 * 1024;

function bridgeDirectory(home = os.homedir()) {
  return path.join(home, '.lodestar');
}

function discoveryFile(home = os.homedir()) {
  return path.join(bridgeDirectory(home), 'bridge.json');
}

function endpointFor(platform = process.platform, home = os.homedir(), nonce = crypto.randomBytes(8).toString('hex')) {
  const identity = crypto.createHash('sha256').update(`${home}:${nonce}`).digest('hex').slice(0, 18);
  if (platform === 'win32') return `\\\\.\\pipe\\lodestar-${identity}`;
  return path.join(os.tmpdir(), `lodestar-${typeof process.getuid === 'function' ? process.getuid() : 'user'}-${identity}.sock`);
}

function safeWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(temporary, 0o600); } catch {}
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function sendFrame(socket, payload) {
  if (!socket || socket.destroyed) return;
  socket.write(`${JSON.stringify(payload)}\n`, 'utf8');
}

function validProvider(value) {
  const provider = String(value || '').toLowerCase();
  return AGENT_PROVIDERS[provider] ? provider : '';
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
    this.onTerminalData = payload => this.forwardData(payload);
    this.onTerminalState = payload => this.forwardState(payload);
  }

  start() {
    if (!this.terminalManager) return Promise.reject(new Error('터미널 관리자가 준비되지 않았습니다.'));
    if (this.server) return Promise.resolve(this.info());
    if (this.platform !== 'win32') {
      try { fs.unlinkSync(this.endpoint); } catch {}
    }
    this.server = net.createServer(socket => this.accept(socket));
    this.terminalManager.on('data', this.onTerminalData);
    this.terminalManager.on('state', this.onTerminalState);
    return new Promise((resolve, reject) => {
      const fail = error => {
        this.server = null;
        reject(error);
      };
      this.server.once('error', fail);
      this.server.listen(this.endpoint, () => {
        this.server.removeListener('error', fail);
        safeWriteJson(this.file, this.info());
        resolve(this.info());
      });
    });
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
    const client = { socket, buffer: '', authenticated: false, terminalId: '', bridgeId: '' };
    this.clients.set(socket, client);
    socket.on('data', chunk => this.consume(client, chunk));
    socket.on('error', () => this.detach(client));
    socket.on('close', () => this.detach(client));
  }

  consume(client, chunk) {
    client.buffer += chunk.toString('utf8');
    if (client.buffer.length > MAX_FRAME_CHARS) return client.socket.destroy(new Error('브리지 입력이 너무 큽니다.'));
    let newline;
    while ((newline = client.buffer.indexOf('\n')) >= 0) {
      const line = client.buffer.slice(0, newline).trim();
      client.buffer = client.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { return client.socket.destroy(new Error('브리지 메시지가 올바르지 않습니다.')); }
      try { this.handle(client, message || {}); } catch (error) {
        sendFrame(client.socket, { type: 'error', message: String(error.message || error) });
        if (!client.authenticated) client.socket.end();
      }
    }
  }

  handle(client, message) {
    if (!client.authenticated) {
      if (message.type !== 'run' || message.token !== this.token) throw new Error('Lodestar 브리지 인증에 실패했습니다.');
      const provider = validProvider(message.provider);
      if (!provider) throw new Error('지원하지 않는 AI 제공사입니다.');
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
      const data = Buffer.from(String(message.data || ''), 'base64').toString('utf8');
      this.terminalManager.write(client.terminalId, data);
    } else if (message.type === 'resize') {
      this.terminalManager.resize(client.terminalId, message.cols, message.rows);
    } else if (message.type === 'signal') {
      this.terminalManager.signal(client.terminalId, message.signal);
    } else if (message.type === 'close') {
      this.terminalManager.close(client.terminalId);
      client.socket.end();
    }
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
      if (session.status === 'exited' || session.status === 'failed') client.socket.end();
    }
  }

  detach(client) {
    this.clients.delete(client.socket);
  }

  dispose() {
    if (this.terminalManager) {
      this.terminalManager.removeListener('data', this.onTerminalData);
      this.terminalManager.removeListener('state', this.onTerminalState);
    }
    for (const client of this.clients.values()) {
      try { client.socket.destroy(); } catch {}
    }
    this.clients.clear();
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }
    try { fs.unlinkSync(this.file); } catch {}
    if (this.platform !== 'win32') {
      try { fs.unlinkSync(this.endpoint); } catch {}
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
};
