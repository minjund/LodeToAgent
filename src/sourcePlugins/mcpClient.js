'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_PROTOCOL_BUFFER_BYTES = 32 * 1024 * 1024;

function protocolError(message, details = {}) {
  const error = new Error(message);
  error.code = details.code || 'MCP_PROTOCOL_ERROR';
  if (details.data !== undefined) error.data = details.data;
  return error;
}

function indexOfHeaderEnd(buffer) {
  const windowsEnd = buffer.indexOf(Buffer.from('\r\n\r\n'));
  if (windowsEnd >= 0) return { index: windowsEnd, length: 4 };
  const unixEnd = buffer.indexOf(Buffer.from('\n\n'));
  return unixEnd >= 0 ? { index: unixEnd, length: 2 } : null;
}

/**
 * Incrementally parses both MCP's newline-delimited stdio messages and
 * Content-Length framed JSON-RPC messages. Invalid stdout lines are ignored
 * and reported instead of being treated as protocol responses.
 */
function createMessageParser(onMessage, onWarning = () => {}) {
  let pending = Buffer.alloc(0);

  function warn(message, cause) {
    onWarning({ message, cause: cause ? String(cause.message || cause) : '' });
  }

  function emitJson(bytes) {
    const raw = bytes.toString('utf8').trim();
    if (!raw) return;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        warn('Ignored a non-object MCP stdout message.');
        return;
      }
      onMessage(value);
    } catch (error) {
      warn('Ignored invalid JSON on MCP stdout.', error);
    }
  }

  function drain(final = false) {
    while (pending.length) {
      while (pending.length && (pending[0] === 0x0a || pending[0] === 0x0d)) {
        pending = pending.subarray(1);
      }
      if (!pending.length) break;

      const prefix = pending.subarray(0, Math.min(pending.length, 32)).toString('ascii');
      if (/^content-length\s*:/i.test(prefix)) {
        const headerEnd = indexOfHeaderEnd(pending);
        if (!headerEnd) {
          if (final) {
            warn('Discarded an incomplete MCP Content-Length header.');
            pending = Buffer.alloc(0);
          }
          break;
        }
        const header = pending.subarray(0, headerEnd.index).toString('ascii');
        const match = header.match(/(?:^|\r?\n)content-length\s*:\s*(\d+)\s*(?:\r?\n|$)/i);
        if (!match) {
          warn('Discarded an MCP frame without a valid Content-Length header.');
          pending = pending.subarray(headerEnd.index + headerEnd.length);
          continue;
        }
        const byteLength = Number(match[1]);
        if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_PROTOCOL_BUFFER_BYTES) {
          warn('Discarded an MCP frame with an unsafe Content-Length value.');
          pending = pending.subarray(headerEnd.index + headerEnd.length);
          continue;
        }
        const bodyStart = headerEnd.index + headerEnd.length;
        if (pending.length < bodyStart + byteLength) {
          if (final) {
            warn('Discarded an incomplete MCP Content-Length body.');
            pending = Buffer.alloc(0);
          }
          break;
        }
        const body = pending.subarray(bodyStart, bodyStart + byteLength);
        pending = pending.subarray(bodyStart + byteLength);
        emitJson(body);
        continue;
      }

      const newline = pending.indexOf(0x0a);
      if (newline < 0) {
        if (final) {
          emitJson(pending);
          pending = Buffer.alloc(0);
        }
        break;
      }
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      emitJson(line);
    }
  }

  return {
    push(chunk) {
      if (chunk == null) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (pending.length + bytes.length > MAX_PROTOCOL_BUFFER_BYTES) {
        warn('Discarded oversized data on MCP stdout.');
        pending = Buffer.alloc(0);
        return;
      }
      pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      drain(false);
    },
    end() {
      drain(true);
    },
    bufferedBytes() {
      return pending.length;
    },
  };
}

function encodeJsonRpcMessage(message, framing = 'newline') {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (framing === 'content-length') {
    return Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
      body,
    ]);
  }
  return Buffer.concat([body, Buffer.from('\n')]);
}

class McpStdioClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command || 'aside';
    this.args = Array.isArray(options.args) ? [...options.args] : ['mcp'];
    this.cwd = options.cwd || undefined;
    this.env = options.env || process.env;
    this.spawnImpl = options.spawnImpl || spawn;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.framing = options.framing === 'content-length' ? 'content-length' : 'newline';
    this.clientInfo = {
      name: options.clientName || 'whitebox',
      version: options.clientVersion || '1.0.0',
    };
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.protocolVersion = DEFAULT_PROTOCOL_VERSION;
    this.serverInfo = null;
    this.serverCapabilities = {};
    this.stderrBytes = 0;
    this.started = false;
    this.closing = false;
  }

  isRunning() {
    return Boolean(this.started && this.child && this.child.exitCode == null && !this.child.killed);
  }

  async start() {
    if (this.isRunning()) return this;
    if (this.child) throw protocolError('The MCP client cannot restart a closed process.', { code: 'MCP_CLOSED' });

    let child;
    try {
      child = this.spawnImpl(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      error.code = error.code || 'MCP_SPAWN_FAILED';
      throw error;
    }
    this.child = child;

    const parser = createMessageParser(
      message => this._handleMessage(message),
      warning => this.emit('warning', warning),
    );
    child.stdout.on('data', chunk => parser.push(chunk));
    child.stdout.on('end', () => parser.end());
    child.stdin.on('error', error => this._handleProcessFailure(error));
    child.stderr.on('data', chunk => {
      this.stderrBytes = Math.min(MAX_STDERR_BYTES, this.stderrBytes + chunk.length);
      this.emit('stderr-activity', { bytes: chunk.length });
    });
    child.on('error', error => this._handleProcessFailure(error));
    child.on('exit', (code, signal) => {
      parser.end();
      if (!this.closing) {
        this._handleProcessFailure(protocolError(
          `MCP process exited (${code == null ? signal : code}).`,
          { code: 'MCP_PROCESS_EXITED' },
        ));
      }
      this.started = false;
      this.emit('exit', { code, signal });
    });

    const result = await this.request('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    this.protocolVersion = String(result && result.protocolVersion || DEFAULT_PROTOCOL_VERSION);
    this.serverInfo = result && result.serverInfo || null;
    this.serverCapabilities = result && result.capabilities || {};
    this.notify('notifications/initialized', {});
    this.started = true;
    return this;
  }

  _handleProcessFailure(error) {
    this.started = false;
    const failure = error instanceof Error ? error : protocolError(String(error || 'MCP process failed.'));
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    this.pending.clear();
    this.emit('process-error', failure);
  }

  _handleMessage(message) {
    if (message.method && message.id !== undefined && message.id !== null) {
      this._handleServerRequest(message);
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const key = String(message.id);
      const entry = this.pending.get(key);
      if (!entry) {
        this.emit('warning', { message: `Received an MCP response for unknown id ${key}.`, cause: '' });
        return;
      }
      this.pending.delete(key);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(protocolError(
          String(message.error.message || 'MCP request failed.'),
          { code: message.error.code == null ? 'MCP_REQUEST_FAILED' : message.error.code, data: message.error.data },
        ));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  _handleServerRequest(message) {
    try {
      if (message.method === 'ping') {
        this._write({ jsonrpc: '2.0', id: message.id, result: {} });
        return;
      }
      if (message.method === 'roots/list') {
        this._write({ jsonrpc: '2.0', id: message.id, result: { roots: [] } });
        return;
      }
      this._write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not supported by this MCP client.' },
      });
    } catch (error) {
      this.emit('warning', { message: 'Could not answer an MCP server request.', cause: String(error.message || error) });
    }
  }

  _write(message) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw protocolError('MCP stdin is not available.', { code: 'MCP_NOT_RUNNING' });
    }
    this.child.stdin.write(encodeJsonRpcMessage(message, this.framing));
  }

  request(method, params = {}, options = {}) {
    if (!method || typeof method !== 'string') {
      return Promise.reject(protocolError('An MCP request method is required.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(protocolError(`MCP request timed out: ${method}`, { code: 'MCP_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer, method });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  async listTools() {
    const tools = [];
    let cursor;
    let pages = 0;
    const seenCursors = new Set();
    do {
      pages += 1;
      if (pages > 100) throw protocolError('MCP tools/list exceeded the pagination limit.', { code: 'MCP_PAGE_LIMIT' });
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      if (Array.isArray(result && result.tools)) tools.push(...result.tools);
      if (tools.length > 10_000) throw protocolError('MCP tools/list exceeded the tool limit.', { code: 'MCP_TOOL_LIMIT' });
      cursor = result && (result.nextCursor || result.next_cursor) || '';
      if (cursor && seenCursors.has(cursor)) {
        throw protocolError('MCP tools/list returned a repeated cursor.', { code: 'MCP_CURSOR_LOOP' });
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return tools;
  }

  callTool(name, args = {}, options = {}) {
    if (!name || typeof name !== 'string') {
      return Promise.reject(protocolError('An MCP tool name is required.'));
    }
    return this.request('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} }, options);
  }

  close() {
    this.closing = true;
    const error = protocolError('MCP client closed.', { code: 'MCP_CLOSED' });
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    if (this.child) {
      try {
        if (this.child.stdin && !this.child.stdin.destroyed) this.child.stdin.end();
        if (this.child.exitCode == null && !this.child.killed) this.child.kill();
      } catch (_error) {
        // The process may already have exited between the state check and kill.
      }
    }
    this.started = false;
  }
}

module.exports = {
  DEFAULT_PROTOCOL_VERSION,
  MAX_PROTOCOL_BUFFER_BYTES,
  McpStdioClient,
  createMessageParser,
  encodeJsonRpcMessage,
  protocolError,
};
