#!/usr/bin/env node
'use strict';

// This process deliberately sits between xterm/node-pty and tmux.  A normal
// tmux attach is not sufficient for an exact-pane view: windows are shared by
// linked sessions and tmux may select a surviving sibling after the requested
// pane exits.  Control mode lets us forward only records carrying the immutable
// pane id, and revalidate the complete target before every input operation.

const crypto = require('crypto');
const fs = require('fs');
const tty = require('tty');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { spawn: spawnChild, spawnSync } = require('child_process');

const MAX_ARGUMENT_CHARS = 24 * 1024;
const MAX_CONTROL_LINE_BYTES = 2 * 1024 * 1024;
// A compiler/build can legitimately emit several MiB while a control-mode
// identity check is in flight. Keep a bounded but practical burst window;
// replay storage is independently tail-limited by TerminalManager.
const MAX_EARLY_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_BYTES = 512 * 1024;
const MAX_INPUT_FRAME_BYTES = 1024 * 1024;
const MAX_RAW_INPUT_CHUNK_BYTES = 4 * 1024;
// quoteTmuxBytes expands each byte to a four-character octal escape. tmux 3.2
// rejects large nested if-shell commands, so keep each encoded set-buffer line
// near 2 KiB even after octal expansion.
const BUFFER_CHUNK_BYTES = 512;
// Control replies are normally immediate, but a busy WSL host or a tmux server
// flushing a multi-MiB pane can exceed five seconds. Keep this below the
// manager's delivery deadline while allowing one loaded-host scheduling stall;
// identity checks still fail closed when the bounded reply never arrives.
const CONTROL_TIMEOUT_MS = 10_000;
const INITIAL_TIMEOUT_MS = 25_000;
const SOURCE_GRID_PROBE_TIMEOUT_MS = 10_000;
const MAX_SOURCE_GRID_PROBE_BYTES = 64 * 1024;
const CHILD_EXIT_CONFIRM_TIMEOUT_MS = 3_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const CLEANUP_EXIT_CONFIRM_TIMEOUT_MS = 1_000;
const META_SEPARATOR = '\t';
const AGENT_PROVIDERS = new Set(['claude', 'codex', 'gemini', 'grok']);
const PASTE_START = Buffer.from('\x1b[200~', 'ascii');
const PASTE_END = Buffer.from('\x1b[201~', 'ascii');

function base64urlEncode(value) {
  return Buffer.from(value).toString('base64')
    .replace(/=+$/u, '')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_');
}

function base64urlDecode(value, maximum = MAX_INPUT_FRAME_BYTES) {
  const text = String(value || '');
  if (!text || text.length > Math.ceil(maximum * 4 / 3) + 8 || !/^[A-Za-z0-9_-]+$/u.test(text)) {
    throw new Error('invalid base64url value');
  }
  const bytes = Buffer.from(text.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64');
  if (bytes.length > maximum || base64urlEncode(bytes) !== text) throw new Error('non-canonical base64url value');
  return bytes;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function proxyStoppedError() {
  const error = new Error('tmux proxy stopped before control attach');
  error.code = 'TMUX_PROXY_STOPPED';
  return error;
}

function parseLaunchPayload(encoded) {
  const argument = String(encoded || '');
  if (!argument || argument.length > MAX_ARGUMENT_CHARS) throw new Error('tmux proxy launch data is missing or too large');
  let value;
  try {
    value = JSON.parse(base64urlDecode(argument, MAX_ARGUMENT_CHARS).toString('utf8'));
  } catch (cause) {
    const error = new Error('tmux proxy launch data is invalid');
    error.cause = cause;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tmux proxy launch data must be an object');
  const session = String(value.session || '');
  const sessionId = String(value.sessionId || '');
  const window = String(value.window || '');
  const pane = String(value.pane || '');
  const panePid = String(value.panePid || '');
  const channel = String(value.channel || '');
  const readyMarker = String(value.readyMarker || '');
  const distro = String(value.distro || '');
  const agentPid = String(value.agentPid == null ? '' : value.agentPid);
  const agentProvider = String(value.agentProvider || '').toLowerCase();
  const agentExternalId = String(value.agentExternalId || '');
  const agentArgvHash = String(value.agentArgvHash || '').toLowerCase();
  const agentStartTimeTicks = String(value.agentStartTimeTicks == null ? '' : value.agentStartTimeTicks);
  const agentProcessGroupId = String(value.agentProcessGroupId == null ? '' : value.agentProcessGroupId);
  const agentIdentityValues = [
    agentPid,
    agentProvider,
    agentExternalId,
    agentArgvHash,
    agentStartTimeTicks,
    agentProcessGroupId,
  ];
  const hasAgentIdentity = agentIdentityValues.some(Boolean);
  if (sessionId && !/^\$[0-9]+$/u.test(sessionId)) throw new Error('unsafe tmux session id');
  if (sessionId) {
    if (!session || session.length > 100 || /[\u0000-\u001f\u007f]/u.test(session)) throw new Error('unsafe tmux session name');
  } else if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(session)) {
    // Name-only targeting is also interpolated into a tmux format expression;
    // keep that legacy path deliberately narrow. Native $sessionId targeting
    // above safely supports localized and spaced display names.
    throw new Error('unsafe tmux session name');
  }
  if (!/^@[0-9]+$/u.test(window)) throw new Error('unsafe tmux window id');
  if (!/^%[0-9]+$/u.test(pane)) throw new Error('unsafe tmux pane id');
  if (panePid && !/^[1-9][0-9]{0,14}$/u.test(panePid)) throw new Error('unsafe tmux pane pid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(channel)) throw new Error('unsafe tmux proxy channel');
  if (!readyMarker || readyMarker.length > 240 || /[\u0000-\u001f\u007f]/u.test(readyMarker)) {
    throw new Error('unsafe tmux proxy ready marker');
  }
  if (hasAgentIdentity) {
    if (agentIdentityValues.some(value => !value)) throw new Error('incomplete tmux agent identity');
    if (!/^[1-9][0-9]{0,14}$/u.test(agentPid)) throw new Error('unsafe tmux agent pid');
    if (!AGENT_PROVIDERS.has(agentProvider)) throw new Error('unsafe tmux agent provider');
    if (agentExternalId.length > 500 || /[\u0000-\u001f\u007f]/u.test(agentExternalId)) {
      throw new Error('unsafe tmux agent external id');
    }
    if (!/^[a-f0-9]{64}$/u.test(agentArgvHash)) throw new Error('unsafe tmux agent argv hash');
    if (!/^[1-9][0-9]{0,30}$/u.test(agentStartTimeTicks)) throw new Error('unsafe tmux agent start time');
    if (!/^[1-9][0-9]{0,14}$/u.test(agentProcessGroupId)) throw new Error('unsafe tmux agent process group');
  }
  if (process.platform === 'win32'
    && (!distro || distro.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/u.test(distro))) {
    throw new Error('unsafe WSL distribution name');
  }
  return Object.freeze({
    distro,
    session,
    sessionId,
    window,
    pane,
    panePid,
    agentPid,
    agentProvider,
    agentExternalId,
    agentArgvHash,
    agentStartTimeTicks,
    agentProcessGroupId,
    channel,
    readyMarker,
    cols: boundedInteger(value.cols, 120, 20, 500),
    rows: boundedInteger(value.rows, 32, 5, 300),
  });
}

function quoteTmuxArgument(value) {
  return `'${String(value == null ? '' : value).replace(/'/gu, `'\\''`)}'`;
}

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/gu, `'"'"'`)}'`;
}

// tmux expands \ooo inside a double-quoted command argument.  Encoding every
// byte avoids newline/quote/format interpolation and preserves UTF-8 exactly.
function quoteTmuxBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value == null ? '' : value), 'utf8');
  if (bytes.includes(0)) throw new Error('NUL cannot be sent through a tmux buffer');
  let encoded = '"';
  for (const byte of bytes) encoded += `\\${byte.toString(8).padStart(3, '0')}`;
  return `${encoded}"`;
}

function decodeTmuxControlBytes(value) {
  const text = Buffer.isBuffer(value) ? value.toString('latin1') : String(value == null ? '' : value);
  const output = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x5c && index + 3 < text.length && /^[0-7]{3}$/u.test(text.slice(index + 1, index + 4))) {
      output.push(Number.parseInt(text.slice(index + 1, index + 4), 8));
      index += 3;
    } else if (code <= 0xff) {
      output.push(code);
    } else {
      output.push(...Buffer.from(text[index], 'utf8'));
    }
  }
  return Buffer.from(output);
}

function matchingSuffixLength(buffer, prefix) {
  const maximum = Math.min(buffer.length, prefix.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (buffer.subarray(buffer.length - length).equals(prefix.subarray(0, length))) return length;
  }
  return 0;
}

class ControlProtocolParser extends EventEmitter {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
    this.block = null;
    this.forwardOutputInsideBlocks = false;
  }

  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes;
    if (this.buffer.length > MAX_CONTROL_LINE_BYTES) {
      this.emit('fatal', new Error('tmux control protocol line exceeded the safety limit'));
      this.buffer = Buffer.alloc(0);
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      let line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      this.consumeLine(line);
    }
  }

  consumeLine(input) {
    const line = input;
    const text = line.toString('latin1');
    if (this.block) {
      const end = /^%(end|error) ([0-9]+) ([0-9]+) ([0-9]+)$/u.exec(text);
      if (end && end[2] === this.block.time && end[3] === this.block.number) {
        const block = this.block;
        this.block = null;
        this.emit('response', {
          ok: end[1] === 'end',
          time: block.time,
          number: block.number,
          flags: block.flags,
          lines: block.lines,
        });
        return;
      }
      // tmux may interleave live %output notifications while a command
      // response block is open. After the initial capture cutover, command
      // responses are private proxy tokens only, so route those notifications
      // immediately instead of swallowing pane bytes into the response.
      if (this.forwardOutputInsideBlocks && this.consumeOutput(text)) return;
      if (this.forwardOutputInsideBlocks
        && /^%(?:layout-change|window-add|window-close|unlinked-window-|sessions-changed)/u.test(text)) {
        this.emit('notification', text);
        return;
      }
      blockAppend(this.block, input);
      return;
    }
    const begin = /^%begin ([0-9]+) ([0-9]+) ([0-9]+)$/u.exec(text);
    if (begin) {
      this.block = { time: begin[1], number: begin[2], flags: begin[3], lines: [] };
      return;
    }
    if (this.consumeOutput(text)) return;
    const session = /^%session-changed (\$[0-9]+) (.+)$/u.exec(text);
    if (session) {
      this.emit('session-changed', { id: session[1], name: session[2] });
      return;
    }
    if (text === '%exit' || text.startsWith('%exit ')) {
      this.emit('exit', text.slice(5).trim());
      return;
    }
    if (text.startsWith('%')) this.emit('notification', text);
  }

  consumeOutput(text) {
    const output = /^%output (%[0-9]+)(?: (.*))?$/u.exec(text);
    if (output) {
      this.emit('output', { pane: output[1], data: decodeTmuxControlBytes(output[2] || '') });
      return true;
    }
    const extended = /^%extended-output (%[0-9]+) [0-9]+(?: [^:]*)? :(?: (.*))?$/u.exec(text);
    if (extended) {
      this.emit('output', { pane: extended[1], data: decodeTmuxControlBytes(extended[2] || '') });
      return true;
    }
    return false;
  }
}

function blockAppend(block, line) {
  block.lines.push(Buffer.from(line));
}

class DcsInputParser {
  constructor(onRaw, onCommand, onInvalid, channel = '') {
    this.onRaw = onRaw;
    this.onCommand = onCommand;
    this.onInvalid = onInvalid;
    this.channel = String(channel || '');
    this.prefix = Buffer.from(`LTA_PROXY_CMD_${this.channel};`, 'ascii');
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes;
    while (this.buffer.length) {
      const start = this.buffer.indexOf(this.prefix);
      if (start < 0) {
        const held = matchingSuffixLength(this.buffer, this.prefix);
        const emitLength = this.buffer.length - held;
        if (emitLength) this.onRaw(this.buffer.subarray(0, emitLength));
        this.buffer = held ? this.buffer.subarray(emitLength) : Buffer.alloc(0);
        return;
      }
      if (start) this.onRaw(this.buffer.subarray(0, start));
      const carriage = this.buffer.indexOf(0x0d, this.prefix.length);
      const newline = this.buffer.indexOf(0x0a, this.prefix.length);
      const end = carriage < 0 ? newline : (newline < 0 ? carriage : Math.min(carriage, newline));
      if (end < 0) {
        this.buffer = this.buffer.subarray(start);
        if (this.buffer.length > MAX_INPUT_FRAME_BYTES) {
          this.onInvalid('command frame exceeded the safety limit');
          this.buffer = Buffer.alloc(0);
        }
        return;
      }
      const body = this.buffer.subarray(this.prefix.length, end);
      let consumed = end + 1;
      if (this.buffer[end] === 0x0d && this.buffer[consumed] === 0x0a) consumed += 1;
      this.buffer = this.buffer.subarray(consumed);
      this.onCommand(this.channel, body.toString('ascii'));
    }
  }
}

class BracketedPasteParser {
  constructor(onRaw, onPaste, onInvalid) {
    this.onRaw = onRaw;
    this.onPaste = onPaste;
    this.onInvalid = onInvalid;
    this.buffer = Buffer.alloc(0);
    this.inPaste = false;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    while (this.buffer.length) {
      const delimiter = this.inPaste ? PASTE_END : PASTE_START;
      const index = this.buffer.indexOf(delimiter);
      if (index < 0) {
        const held = matchingSuffixLength(this.buffer, delimiter);
        const available = this.buffer.length - held;
        if (this.inPaste) {
          if (this.buffer.length > MAX_INPUT_FRAME_BYTES) {
            this.onInvalid('bracketed paste exceeded the safety limit');
            this.buffer = Buffer.alloc(0);
            this.inPaste = false;
          }
          return;
        }
        if (available) this.onRaw(this.buffer.subarray(0, available));
        this.buffer = held ? this.buffer.subarray(available) : Buffer.alloc(0);
        return;
      }
      if (this.inPaste) {
        this.onPaste(this.buffer.subarray(0, index));
        this.buffer = this.buffer.subarray(index + PASTE_END.length);
        this.inPaste = false;
      } else {
        if (index) this.onRaw(this.buffer.subarray(0, index));
        this.buffer = this.buffer.subarray(index + PASTE_START.length);
        this.inPaste = true;
      }
    }
  }
}

function commandFramePayload(encoded) {
  let value;
  try {
    value = JSON.parse(base64urlDecode(encoded, MAX_COMMAND_BYTES + 4_096).toString('utf8'));
  } catch (cause) {
    const error = new Error('invalid command payload');
    error.cause = cause;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('command payload must be an object');
  const requestId = String(value.requestId || '');
  const command = String(value.command == null ? '' : value.command);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(requestId)) throw new Error('invalid command request id');
  const bytes = Buffer.from(command, 'utf8');
  if (!bytes.length || bytes.length > MAX_COMMAND_BYTES || bytes.includes(0)) throw new Error('invalid command text');
  return { requestId, command: bytes };
}

function ansiInitialization(metadata, capture) {
  const alternate = metadata.alternateOn === '1';
  const scrollUpper = Math.max(0, Number(metadata.scrollUpper) || 0);
  const scrollLower = Math.max(scrollUpper, Number(metadata.scrollLower) || scrollUpper);
  const origin = metadata.originFlag === '1';
  const cursorRow = origin
    ? Math.max(1, (Number(metadata.cursorY) || 0) - scrollUpper + 1)
    : (Number(metadata.cursorY) || 0) + 1;
  const chunks = [
    Buffer.from(alternate ? '\x1b[?1049h' : '\x1b[?1049l', 'ascii'),
    Buffer.from('\x1b[H\x1b[2J', 'ascii'),
    capture,
    Buffer.from(metadata.keypadCursor === '1' ? '\x1b[?1h' : '\x1b[?1l', 'ascii'),
    Buffer.from(metadata.keypad === '1' ? '\x1b=' : '\x1b>', 'ascii'),
    Buffer.from('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l', 'ascii'),
  ];
  if (metadata.mouseAll === '1' || metadata.mouseAny === '1') chunks.push(Buffer.from('\x1b[?1003h', 'ascii'));
  else if (metadata.mouseButton === '1') chunks.push(Buffer.from('\x1b[?1002h', 'ascii'));
  else if (metadata.mouseStandard === '1') chunks.push(Buffer.from('\x1b[?1000h', 'ascii'));
  if (metadata.mouseUtf8 === '1') chunks.push(Buffer.from('\x1b[?1005h', 'ascii'));
  if (metadata.mouseSgr === '1') chunks.push(Buffer.from('\x1b[?1006h', 'ascii'));
  chunks.push(Buffer.from(`\x1b[${scrollUpper + 1};${scrollLower + 1}r`, 'ascii'));
  chunks.push(Buffer.from(origin ? '\x1b[?6h' : '\x1b[?6l', 'ascii'));
  chunks.push(Buffer.from(metadata.wrapFlag === '1' ? '\x1b[?7h' : '\x1b[?7l', 'ascii'));
  chunks.push(Buffer.from(metadata.insertFlag === '1' ? '\x1b[4h' : '\x1b[4l', 'ascii'));
  chunks.push(Buffer.from(`\x1b[${cursorRow};${Number(metadata.cursorX) + 1}H`, 'ascii'));
  chunks.push(Buffer.from(metadata.cursorFlag === '1' ? '\x1b[?25h' : '\x1b[?25l', 'ascii'));
  chunks.push(Buffer.from('\x1b[?2004h', 'ascii'));
  return Buffer.concat(chunks);
}

class TmuxControlProxy extends EventEmitter {
  constructor(options, runtime = {}) {
    super();
    this.options = options;
    this.runtime = runtime;
    this.nonce = crypto.randomBytes(12).toString('hex');
    this.shadowSession = `lta-proxy-${process.pid}-${this.nonce.slice(0, 12)}`;
    this.shadowTarget = `=${this.shadowSession}`;
    this.sessionTarget = options.sessionId || `=${options.session}`;
    this.fullTarget = `${this.sessionTarget}:${options.window}.${options.pane}`;
    this.windowTarget = `${this.sessionTarget}:${options.window}`;
    this.expectedPanePid = options.panePid || '';
    this.control = null;
    this.controlStarted = false;
    this.controlExited = false;
    this.controlClosePromise = null;
    this.destroyUnattachedEnabled = false;
    this.probeProcess = null;
    this.probeClosePromise = null;
    this.cancelProbe = null;
    this.startPromise = null;
    this.parser = new ControlProtocolParser();
    this.pendingResponses = [];
    this.commandChain = Promise.resolve();
    this.attachedWaiter = null;
    this.verified = false;
    this.captureCutover = false;
    this.earlyOutput = [];
    this.earlyOutputBytes = 0;
    this.outputPending = [];
    this.outputPendingBytes = 0;
    this.outputFlushRunning = false;
    this.outputFlushTimer = null;
    this.stopping = false;
    this.cleaned = false;
    this.cleanupPromise = null;
    this.stopPromise = null;
    this.exitCode = 1;
    this.healthTimer = null;
    this.healthCheckPromise = null;
    this.resizeTimer = null;
    this.lastSize = { cols: options.cols, rows: options.rows };
    this.pid = null;
    this.exitEmitted = false;
    this.outputDecoder = new StringDecoder('utf8');
    this.outputDecoderEnded = false;
    this.inputParser = null;
    this.inputOperationChain = Promise.resolve();
    this.topologyEpoch = 0;
    this.topologyRefreshTimer = null;
    this.topologyRefreshPromise = null;
    this.topologyRefreshPending = false;
    this.sourceCols = options.cols;
    this.sourceRows = options.rows;
    this.controlCols = options.cols;
    this.controlRows = options.rows;
    this.bindParser();
  }

  onData(callback) {
    this.on('data', callback);
    return { dispose: () => this.off('data', callback) };
  }

  onExit(callback) {
    this.on('pty-exit', callback);
    return { dispose: () => this.off('pty-exit', callback) };
  }

  get __loadtoagentStartupPending() {
    return !this.controlStarted && !this.stopping;
  }

  get __loadtoagentPosixSignal() {
    return 'SIGTERM';
  }

  emitData(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    if (this.runtime.inProcess) {
      const text = this.outputDecoder.write(bytes);
      if (text) this.emit('data', text);
    }
    else process.stdout.write(bytes);
  }

  emitProtocolData(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'ascii');
    if (this.runtime.inProcess) this.emit('data', bytes.toString('ascii'));
    else process.stdout.write(bytes);
  }

  endData() {
    if (!this.runtime.inProcess || this.outputDecoderEnded) return;
    this.outputDecoderEnded = true;
    const text = this.outputDecoder.end();
    if (text) this.emit('data', text);
  }

  emitSourceMeta() {
    this.emitProtocolData(Buffer.from(`LTA_PROXY_META_${this.options.channel};${this.sourceCols};${this.sourceRows}\n`, 'ascii'));
  }

  emitExit(exitCode = this.exitCode, signal = null) {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.emit('pty-exit', { exitCode: Number.isInteger(exitCode) ? exitCode : 1, signal });
  }

  write(value) {
    if (this.stopping || !this.inputParser) return;
    this.inputParser.push(Buffer.from(String(value == null ? '' : value), 'utf8'));
  }

  resize(cols, rows) {
    // A tmux 3.2a control client can still resize a linked source window via
    // refresh-client -C despite ignore-size.  The source grid is immutable;
    // the renderer letterboxes the authenticated META dimensions instead.
    void cols;
    void rows;
  }

  kill() {
    return this.stop(0);
  }

  bindParser() {
    this.parser.on('response', response => {
      const pending = this.pendingResponses[0];
      if (process.env.LTA_TMUX_PROXY_DEBUG === '1') {
        process.stderr.write(`[tmux-control-proxy:response${pending ? '' : ':unclaimed'}] ${response.ok} ${response.lines.map(line => JSON.stringify(line.toString('latin1'))).join(' ')}\n`);
      }
      if (!pending) return;
      if (!response.ok) {
        this.pendingResponses.shift();
        clearTimeout(pending.timer);
        pending.reject(new Error(response.lines.map(line => line.toString('utf8')).join('\n') || 'tmux command failed'));
        return;
      }
      if (pending.until) {
        pending.lines.push(...response.lines);
        if (!pending.until(response, pending.lines)) return;
        pending.onSatisfied?.(response, pending.lines);
      }
      this.pendingResponses.shift();
      clearTimeout(pending.timer);
      pending.resolve(pending.lines || response.lines);
    });
    this.parser.on('session-changed', event => {
      if (event.name === this.shadowSession && this.attachedWaiter) {
        const waiter = this.attachedWaiter;
        this.attachedWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    });
    this.parser.on('output', event => this.handleOutput(event));
    this.parser.on('notification', text => {
      // Active-pane/window selection notifications are client UI state, not
      // structural identity changes. Counting them here can invalidate later
      // exact output after an unrelated client merely changes selection.
      if (/^%(?:layout-change|window-add|window-close|unlinked-window-|sessions-changed)/u.test(text)) {
        this.topologyEpoch += 1;
        this.scheduleTopologyRefresh();
      }
    });
    this.parser.on('exit', reason => this.fatal(new Error(`tmux control client exited${reason ? `: ${reason}` : ''}`)));
    this.parser.on('fatal', error => this.fatal(error));
  }

  scheduleTopologyRefresh() {
    if (!this.verified || this.stopping) return;
    this.topologyRefreshPending = true;
    // A running verification gets exactly one trailing check after the latest
    // notification. This preserves post-topology ordering without allowing a
    // layout storm to queue an unbounded series of identical control probes.
    if (this.topologyRefreshPromise) return;
    if (this.topologyRefreshTimer) return;
    this.topologyRefreshTimer = setTimeout(() => {
      this.topologyRefreshTimer = null;
      if (!this.topologyRefreshPending || this.stopping) return;
      this.topologyRefreshPending = false;
      const operation = this.verifyIdentity('topology');
      this.topologyRefreshPromise = operation;
      operation.catch(error => this.fatal(error)).finally(() => {
        if (this.topologyRefreshPromise === operation) this.topologyRefreshPromise = null;
        if (this.topologyRefreshPending && !this.stopping) this.scheduleTopologyRefresh();
      });
    }, 10);
    this.topologyRefreshTimer.unref?.();
  }

  executable() {
    return process.platform === 'win32'
      ? { file: 'wsl.exe', prefix: ['-d', this.options.distro, '--exec', 'tmux'] }
      : { file: 'tmux', prefix: [] };
  }

  controlArguments() {
    // Window 0 is a server-side startup watchdog.  If this process is killed
    // after new-session but before the attached client can enable
    // destroy-unattached, it destroys the shadow by itself.  Successful
    // startup removes the watchdog window immediately after enabling the
    // server-owned detach cleanup.
    // The dedicated shadow control client must remain writable: user input is
    // parsed into guarded set-buffer/paste-buffer/send-keys operations below.
    // `read-only` makes tmux 3.7+ reject those operations before the immutable
    // pane and process identity guards can run. Raw control commands are never
    // forwarded from the renderer. Every operation targets the immutable pane
    // explicitly, and ignore-size keeps the linked source window isolated from
    // this client's dimensions; tracking a client-local active pane is neither
    // required nor safe across move/join/swap on older tmux releases.
    const placeholder = `sleep 15; tmux kill-session -t ${this.shadowSession}`;
    return [
      '-C',
      'new-session', '-d', '-s', this.shadowSession, '-n', 'lta-hold', placeholder,
      ';', 'link-window', '-a', '-s', this.windowTarget, '-t', `${this.shadowTarget}:`,
      ';', 'attach-session', '-f', 'ignore-size', '-t', `${this.shadowTarget}:${this.options.window}`,
    ];
  }

  controlLaunch() {
    // tmux control mode is a pipe protocol and does not require a terminal.
    // Running it through script(1) adds a PTY line discipline whose echo and
    // canonical processing can interleave command input with multi-MiB output
    // records. Spawn tmux directly so stdout is the unmodified control stream.
    const executable = this.executable();
    return {
      file: executable.file,
      args: [...executable.prefix, ...this.controlArguments()],
    };
  }

  probeSourceGrid() {
    const executable = this.executable();
    const format = [
      '#{session_id}', '#{session_name}', '#{window_id}', '#{pane_id}', '#{pane_pid}', '#{pane_dead}',
      '#{window_width}', '#{window_height}', '#{pane_width}', '#{pane_height}',
    ].join(META_SEPARATOR);
    const spawnProbe = this.runtime.spawnProbeChild || spawnChild;
    return new Promise((resolve, reject) => {
      if (this.stopping) {
        reject(proxyStoppedError());
        return;
      }

      let child;
      let settled = false;
      let outputBytes = 0;
      const stdout = [];
      const stderr = [];
      let timer = null;
      let resolveProbeClose;
      const probeClosePromise = new Promise(resolveClose => { resolveProbeClose = resolveClose; });

      const markProbeClosed = () => {
        if (this.probeProcess === child) this.probeProcess = null;
        if (!this.control && this.pid === Number(child?.pid)) this.pid = null;
        resolveProbeClose();
        if (this.probeClosePromise === probeClosePromise) this.probeClosePromise = null;
      };

      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (this.cancelProbe === cancel) this.cancelProbe = null;
        if (error) reject(error);
        else resolve(Buffer.concat(stdout).toString('utf8'));
      };
      const cancel = () => {
        try { child?.kill(); } catch (_ignored) { /* already gone */ }
        finish(proxyStoppedError());
      };
      const append = (chunks, data) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        outputBytes += bytes.length;
        if (outputBytes > MAX_SOURCE_GRID_PROBE_BYTES) {
          try { child?.kill(); } catch (_ignored) { /* already gone */ }
          finish(new Error('tmux source grid probe returned too much output'));
          return;
        }
        chunks.push(bytes);
      };

      try {
        child = spawnProbe(executable.file, [
          ...executable.prefix,
          'display-message', '-p', '-t', this.fullTarget, format,
        ], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        finish(error);
        return;
      }
      this.probeProcess = child;
      this.probeClosePromise = probeClosePromise;
      this.cancelProbe = cancel;
      this.pid = Number(child.pid) || null;
      child.stdout?.on('data', data => append(stdout, data));
      child.stderr?.on('data', data => append(stderr, data));
      child.once('error', finish);
      child.once('close', (code, signal) => {
        markProbeClosed();
        if (settled) return;
        if (this.stopping) {
          finish(proxyStoppedError());
          return;
        }
        if (code !== 0) {
          if (process.env.LTA_TMUX_PROXY_DEBUG === '1' && stderr.length) {
            process.stderr.write(`[tmux-control-proxy:probe-stderr] ${Buffer.concat(stderr).toString('utf8')}`);
          }
          finish(new Error(`tmux source grid could not be read before control attach (${code ?? signal ?? 'unknown'})`));
          return;
        }
        finish();
      });
      timer = setTimeout(() => {
        try { child.kill(); } catch (_ignored) { /* already gone */ }
        finish(new Error('tmux source grid probe timed out'));
      }, SOURCE_GRID_PROBE_TIMEOUT_MS);
      if (this.stopping) cancel();
    }).then(rawOutput => {
      if (this.stopping) throw proxyStoppedError();
      const values = String(rawOutput || '').replace(/\r/gu, '').trim().split(META_SEPARATOR);
      const sessionMatches = this.options.sessionId
        ? values[0] === this.options.sessionId
        : values[1] === this.options.session;
      if (values.length !== 10 || !sessionMatches || values[2] !== this.options.window
        || values[3] !== this.options.pane || (this.expectedPanePid && values[4] !== this.expectedPanePid)
        || !/^[1-9][0-9]*$/u.test(values[4]) || values[5] !== '0') {
        throw new Error('tmux source identity changed before control attach');
      }
      this.expectedPanePid = values[4];
      const windowCols = Number(values[6]);
      const windowRows = Number(values[7]);
      const paneCols = Number(values[8]);
      const paneRows = Number(values[9]);
      if (![windowCols, windowRows, paneCols, paneRows].every(value => Number.isInteger(value) && value > 0)) {
        throw new Error('tmux source grid is invalid');
      }
      this.controlCols = windowCols;
      this.controlRows = windowRows;
      this.sourceCols = paneCols;
      this.sourceRows = paneRows;
    });
  }

  start() {
    if (!this.startPromise) this.startPromise = this.startOnce();
    return this.startPromise;
  }

  async startOnce() {
    if (this.stopping) throw proxyStoppedError();
    await this.probeSourceGrid();
    if (this.stopping) throw proxyStoppedError();
    const launch = this.controlLaunch();
    const spawn = this.runtime.spawnChild || spawnChild;
    this.control = spawn(launch.file, launch.args, {
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.controlStarted = true;
    this.controlClosePromise = new Promise(resolve => {
      this.control.once('close', (exitCode, signal) => {
        this.controlExited = true;
        resolve({ exitCode, signal });
      });
    });
    this.pid = Number(this.control.pid) || null;
    this.control.stdin.on?.('error', error => {
      if (!this.stopping) this.fatal(error);
    });
    this.control.stdout.on('data', data => this.parser.push(data));
    this.control.stderr.on('data', data => {
      if (process.env.LTA_TMUX_PROXY_DEBUG === '1') process.stderr.write(`[tmux-control-proxy:control-stderr] ${data}`);
    });
    this.control.on('error', error => this.fatal(error));
    this.control.on('exit', (exitCode, signal) => {
      if (!this.stopping) this.fatal(new Error(`tmux control process exited (${exitCode ?? signal ?? 'unknown'})`));
    });
    await this.waitForAttachment();
    this.setupInput();
    await this.initializeExactPane();
    this.setupResize();
    this.healthTimer = setInterval(() => {
      this.checkHealth().catch(error => this.fatal(error));
    }, 1_000);
    this.healthTimer.unref?.();
    this.exitCode = 0;
  }

  waitForAttachment() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.attachedWaiter) this.attachedWaiter = null;
        reject(new Error('tmux control client did not attach to the shadow session'));
      }, INITIAL_TIMEOUT_MS);
      this.attachedWaiter = { resolve, reject, timer };
    });
  }

  deferControlTimeout(resolve, reject, message) {
    setImmediate(() => {
      const index = this.pendingResponses.findIndex(candidate => candidate.resolve === resolve);
      if (index < 0) return;
      this.pendingResponses.splice(index, 1);
      const error = new Error(message);
      error.code = 'TMUX_CONTROL_PROTOCOL_TIMEOUT';
      this.fatal(error);
      reject(error);
    });
  }

  execute(command, timeoutMs = CONTROL_TIMEOUT_MS) {
    if (/\r|\n/u.test(command)) return Promise.reject(new Error('tmux control command contains a newline'));
    const operation = this.commandChain.then(() => new Promise((resolve, reject) => {
      if (!this.control || this.stopping) {
        reject(new Error('tmux control client is unavailable'));
        return;
      }
      const timer = setTimeout(() => {
        // A synchronous system probe can starve the Node loop past this timer
        // even when tmux's reply is already readable. Give the poll phase one
        // turn to drain stdout; a real missing FIFO response still poisons the
        // connection before commandChain can release the next write.
        this.deferControlTimeout(resolve, reject, 'tmux control command timed out');
      }, timeoutMs);
      this.pendingResponses.push({ resolve, reject, timer });
      if (process.env.LTA_TMUX_PROXY_DEBUG === '1') process.stderr.write(`[tmux-control-proxy:command] ${command.slice(0, 700)}${command.length > 700 ? '…' : ''}\n`);
      this.control.stdin.write(`${command}\n`);
    }));
    this.commandChain = operation.catch(() => {});
    return operation;
  }

  executeUntil(command, until, timeoutMs = CONTROL_TIMEOUT_MS, options = {}) {
    if (/\r|\n/u.test(command)) return Promise.reject(new Error('tmux control command contains a newline'));
    const operation = this.commandChain.then(() => new Promise((resolve, reject) => {
      if (!this.control || this.stopping) {
        reject(new Error('tmux control client is unavailable'));
        return;
      }
      const timer = setTimeout(() => {
        this.deferControlTimeout(resolve, reject, 'tmux conditional command timed out');
      }, timeoutMs);
      this.pendingResponses.push({ resolve, reject, timer, until, lines: [], onSatisfied: options.onSatisfied });
      if (process.env.LTA_TMUX_PROXY_DEBUG === '1') process.stderr.write(`[tmux-control-proxy:command] ${command.slice(0, 700)}${command.length > 700 ? '…' : ''}\n`);
      this.control.stdin.write(`${command}\n`);
    }));
    this.commandChain = operation.catch(() => {});
    return operation;
  }

  identityCondition(includePid = true) {
    const sessionCheck = this.options.sessionId
      ? `#{==:#{session_id},${this.options.sessionId}}`
      : `#{==:#{session_name},${this.options.session}}`;
    const terms = [
      sessionCheck,
      `#{==:#{window_id},${this.options.window}}`,
      `#{==:#{pane_id},${this.options.pane}}`,
      '#{==:#{pane_dead},0}',
      '#{>:#{pane_pid},0}',
    ];
    if (includePid && this.expectedPanePid) terms.push(`#{==:#{pane_pid},${this.expectedPanePid}}`);
    return terms.reduceRight((right, left) => right ? `#{&&:${left},${right}}` : left, '');
  }

  hasAgentIdentity() {
    return Boolean(this.options.agentPid);
  }

  agentIdentityShellCondition() {
    if (!this.hasAgentIdentity()) return '';
    const rootPid = String(this.expectedPanePid || this.options.panePid || '');
    if (!/^[1-9][0-9]*$/u.test(rootPid)) throw new Error('tmux agent identity requires the pane root pid');
    const {
      agentPid,
      agentArgvHash,
      agentStartTimeTicks,
      agentProcessGroupId,
    } = this.options;
    // This predicate executes inside the tmux server's Linux environment. It
    // binds the writable proxy to one concrete agent process, not merely to a
    // long-lived shell pane. /proc stat is parsed after its final ") " because
    // the comm field may itself contain spaces or closing parentheses.
    return [
      'command -v sha256sum >/dev/null 2>&1 || exit 1',
      `agent_tail=$(LC_ALL=C sed -n '$s/^.*) //p' /proc/${agentPid}/stat 2>/dev/null) || exit 1`,
      'set -- $agent_tail',
      '[ "$#" -ge 20 ] || exit 1',
      `[ "$3" = "${agentProcessGroupId}" ] || exit 1`,
      `[ "\${20}" = "${agentStartTimeTicks}" ] || exit 1`,
      `agent_hash=$(sha256sum /proc/${agentPid}/cmdline 2>/dev/null) || exit 1`,
      'set -- $agent_hash',
      `[ "$1" = "${agentArgvHash}" ] || exit 1`,
      `root_tail=$(LC_ALL=C sed -n '$s/^.*) //p' /proc/${rootPid}/stat 2>/dev/null) || exit 1`,
      'set -- $root_tail',
      '[ "$#" -ge 6 ] || exit 1',
      `[ "$6" = "${agentProcessGroupId}" ] || exit 1`,
      `current=${agentPid}`,
      'hops=0',
      `while [ "$current" -ne "${rootPid}" ]; do`,
      '  [ "$current" -gt 1 ] || exit 1',
      '  hops=$((hops + 1))',
      '  [ "$hops" -le 4096 ] || exit 1',
      '  current_tail=$(LC_ALL=C sed -n \'$s/^.*) //p\' "/proc/$current/stat" 2>/dev/null) || exit 1',
      '  set -- $current_tail',
      '  [ "$#" -ge 2 ] || exit 1',
      '  current=$2',
      'done',
    ].join('; ');
  }

  guardedOperation(successCommands, failureCommands, includePid = true) {
    let guardedSuccess = successCommands;
    if (this.hasAgentIdentity()) {
      guardedSuccess = `if-shell ${quoteTmuxArgument(this.agentIdentityShellCondition())} { ${successCommands} ; } { ${failureCommands} ; }`;
    }
    return `if-shell -F -t ${quoteTmuxArgument(this.fullTarget)} ${quoteTmuxArgument(this.identityCondition(includePid))} { ${guardedSuccess} ; } { ${failureCommands} ; }`;
  }

  async initializeExactPane() {
    // Setting this before attach would make some tmux versions destroy the
    // still-unattached shadow immediately.  It is the first command issued by
    // the attached control client; process-exit cleanup covers the tiny gap.
    await this.execute(`set-option -t ${quoteTmuxArgument(`${this.shadowTarget}:`)} destroy-unattached on`, INITIAL_TIMEOUT_MS);
    this.destroyUnattachedEnabled = true;
    await this.execute(`kill-window -t ${quoteTmuxArgument(`${this.shadowTarget}:0`)}`, INITIAL_TIMEOUT_MS);
    await this.execute(`select-pane -t ${quoteTmuxArgument(this.fullTarget)}`, INITIAL_TIMEOUT_MS);
    const clientLines = await this.execute("display-message -p '#{session_name}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_dead}'", INITIAL_TIMEOUT_MS);
    const client = clientLines.map(line => line.toString('utf8')).find(Boolean)?.split('|') || [];
    if (client.length !== 5 || client[0] !== this.shadowSession || client[1] !== this.options.window
      || client[2] !== this.options.pane || client[4] !== '0' || !/^[1-9][0-9]*$/u.test(client[3])
      || (this.expectedPanePid && client[3] !== this.expectedPanePid)) {
      throw new Error('tmux control client selected a different pane');
    }

    const token = `LTA_INIT_${this.nonce}`;
    const done = `LTA_INIT_DONE_${this.nonce}`;
    const failure = `LTA_INIT_FAIL_${this.nonce}`;
    const format = [
      token, '#{session_id}', '#{session_name}', '#{window_id}', '#{pane_id}', '#{pane_pid}', '#{pane_dead}',
      '#{pane_width}', '#{pane_height}', '#{cursor_x}', '#{cursor_y}', '#{cursor_flag}',
      '#{keypad_cursor_flag}', '#{keypad_flag}', '#{mouse_standard_flag}', '#{mouse_button_flag}',
      '#{mouse_all_flag}', '#{mouse_any_flag}', '#{mouse_utf8_flag}', '#{mouse_sgr_flag}', '#{alternate_on}',
      '#{insert_flag}', '#{origin_flag}', '#{wrap_flag}', '#{scroll_region_upper}', '#{scroll_region_lower}',
    ].join(META_SEPARATOR);
    const successCommands = `display-message -p -t ${quoteTmuxArgument(this.fullTarget)} ${quoteTmuxArgument(format)} ; capture-pane -p -e -J -C -t ${quoteTmuxArgument(this.fullTarget)} ; display-message -p ${quoteTmuxArgument(done)}`;
    const failureCommands = `display-message -p ${quoteTmuxArgument(failure)}`;
    const command = this.guardedOperation(
      successCommands,
      failureCommands,
      Boolean(this.expectedPanePid),
    );
    const lines = await this.executeUntil(command, (_response, aggregate) => aggregate.some(line => {
      const text = line.toString('latin1');
      return text === done || text === failure;
    }), INITIAL_TIMEOUT_MS, {
      onSatisfied: () => {
        // The DONE block's %end is the exact snapshot/live cutover: output
        // observed before it is represented by capture-pane. Later response
        // blocks may interleave %output, which the parser must forward.
        this.captureCutover = true;
        this.parser.forwardOutputInsideBlocks = true;
        this.earlyOutput = [];
        this.earlyOutputBytes = 0;
      },
    });
    const strings = lines.map(line => line.toString('latin1'));
    if (strings.includes(failure)) throw new Error('the requested tmux target changed before capture');
    const metaIndex = strings.findIndex(line => line.startsWith(`${token}${META_SEPARATOR}`));
    if (metaIndex < 0) throw new Error('tmux did not return exact-pane metadata');
    const values = strings[metaIndex].split(META_SEPARATOR);
    if (values.length !== 26) throw new Error('tmux returned malformed exact-pane metadata');
    const metadata = {
      sessionId: values[1], sessionName: values[2], window: values[3], pane: values[4], panePid: values[5], dead: values[6],
      width: values[7], height: values[8], cursorX: values[9], cursorY: values[10], cursorFlag: values[11],
      keypadCursor: values[12], keypad: values[13], mouseStandard: values[14], mouseButton: values[15],
      mouseAll: values[16], mouseAny: values[17], mouseUtf8: values[18], mouseSgr: values[19], alternateOn: values[20],
      insertFlag: values[21], originFlag: values[22], wrapFlag: values[23], scrollUpper: values[24], scrollLower: values[25],
    };
    const sessionMatches = this.options.sessionId
      ? metadata.sessionId === this.options.sessionId
      : metadata.sessionName === this.options.session;
    if (!sessionMatches || metadata.window !== this.options.window || metadata.pane !== this.options.pane
      || metadata.dead !== '0' || !/^[1-9][0-9]*$/u.test(metadata.panePid)
      || !/^[0-9]+$/u.test(metadata.cursorX) || !/^[0-9]+$/u.test(metadata.cursorY)
      || !/^[0-9]+$/u.test(metadata.scrollUpper) || !/^[0-9]+$/u.test(metadata.scrollLower)
      || Number(metadata.scrollUpper) > Number(metadata.scrollLower)
      || Number(metadata.scrollLower) >= Number(metadata.height)) {
      throw new Error('tmux exact-pane identity verification failed');
    }
    this.expectedPanePid = metadata.panePid;
    this.sourceCols = Number(metadata.width);
    this.sourceRows = Number(metadata.height);
    this.emit('source-size', { cols: this.sourceCols, rows: this.sourceRows });
    const doneIndex = strings.lastIndexOf(done);
    if (doneIndex <= metaIndex) throw new Error('tmux exact-pane capture did not complete');
    const captureLines = lines.slice(metaIndex + 1, doneIndex).map(decodeTmuxControlBytes);
    const capture = captureLines.length ? Buffer.concat(captureLines.flatMap((line, index) => (
      index + 1 < captureLines.length ? [line, Buffer.from('\r\n', 'ascii')] : [line]
    ))) : Buffer.alloc(0);
    await this.verifyIdentity('initial');
    this.emitSourceMeta();
    this.emitData(ansiInitialization(metadata, capture));
    this.verified = true;
    for (const output of this.earlyOutput) this.queueExactOutput(output);
    this.earlyOutput = [];
    this.earlyOutputBytes = 0;
    this.emitProtocolData(Buffer.from(`\r\n${this.options.readyMarker}\r\n`, 'utf8'));
  }

  handleOutput(event) {
    if (event.pane !== this.options.pane || !event.data.length) return;
    if (this.verified) {
      this.queueExactOutput(event.data);
      return;
    }
    if (!this.captureCutover) return;
    this.earlyOutputBytes += event.data.length;
    if (this.earlyOutputBytes > MAX_EARLY_OUTPUT_BYTES) {
      this.fatal(new Error('tmux emitted too much data before exact-pane verification'));
      return;
    }
    this.earlyOutput.push(event.data);
  }

  queueExactOutput(bytes) {
    this.outputPending.push({ data: Buffer.from(bytes), topologyEpoch: this.topologyEpoch });
    this.outputPendingBytes += bytes.length;
    if (this.outputPendingBytes > MAX_EARLY_OUTPUT_BYTES) {
      this.outputPending = [];
      this.outputPendingBytes = 0;
      this.fatal(new Error('tmux output validation fell behind the pane'));
      return;
    }
    if (!this.outputFlushTimer && !this.outputFlushRunning) {
      this.outputFlushTimer = setTimeout(() => {
        this.outputFlushTimer = null;
        this.flushExactOutput().catch(error => this.fatal(error));
      }, 4);
    }
  }

  async flushExactOutput() {
    if (this.outputFlushRunning || this.stopping) return;
    this.outputFlushRunning = true;
    try {
      while (this.outputPending.length && !this.stopping) {
        // Only bytes already observed before this exact identity check belong
        // to the batch.  Notifications arriving while the ACK is in flight are
        // left for a subsequent check, closing the respawn-between-check race.
        const batch = this.outputPending;
        this.outputPending = [];
        this.outputPendingBytes = 0;
        // Every item was already filtered by immutable pane id. A structural
        // notification may be an unrelated sibling split/resize, so never
        // discard observed pane bytes merely because an epoch boundary crossed
        // the batch. The identity/PID check below fails closed for a real target
        // replacement; bytes arriving during that check remain in the next batch.
        await this.verifyIdentity('output');
        this.emitData(Buffer.concat(batch.map(item => item.data)));
      }
    } finally {
      this.outputFlushRunning = false;
      if (this.outputPending.length && !this.outputFlushTimer && !this.stopping) {
        this.outputFlushTimer = setTimeout(() => {
          this.outputFlushTimer = null;
          this.flushExactOutput().catch(error => this.fatal(error));
        }, 4);
      }
    }
  }

  exactOperation(successCommands, ackToken, failToken) {
    const thenBranch = `${successCommands} ; display-message -p ${quoteTmuxArgument(ackToken)}`;
    const elseBranch = `display-message -p ${quoteTmuxArgument(failToken)}`;
    return this.guardedOperation(thenBranch, elseBranch, true);
  }

  async performInput(successCommands) {
    if (!this.verified) {
      const error = new Error('tmux pane is not verified');
      error.code = 'TMUX_EXACT_TARGET_UNVERIFIED';
      throw error;
    }
    const nonce = crypto.randomBytes(9).toString('hex');
    const ack = `LTA_INPUT_ACK_${nonce}`;
    const fail = `LTA_INPUT_FAIL_${nonce}`;
    const responseLines = await this.executeUntil(
      this.exactOperation(successCommands, ack, fail),
      (_response, aggregate) => aggregate.some(line => [ack, fail].includes(line.toString('utf8'))),
    );
    const lines = responseLines.map(line => line.toString('utf8'));
    if (lines.includes(ack)) return;
    if (lines.includes(fail)) {
      const error = new Error('tmux exact pane disappeared or changed');
      error.code = 'TMUX_EXACT_TARGET_CHANGED';
      throw error;
    }
    const error = new Error('tmux did not acknowledge exact-pane input');
    error.code = 'TMUX_EXACT_INPUT_UNCONFIRMED';
    throw error;
  }

  enqueueInputOperation(operation) {
    const pending = this.inputOperationChain.then(() => {
      if (this.stopping) throw new Error('tmux proxy is stopping');
      return operation();
    });
    this.inputOperationChain = pending.catch(error => this.fatal(error));
    return pending;
  }

  async loadBufferExact(bufferName, bytes) {
    const chunks = [];
    let chunkIndex = -1;
    if (!bytes.length) chunks.push(Buffer.alloc(0));
    for (let offset = 0; offset < bytes.length; offset += BUFFER_CHUNK_BYTES) {
      chunks.push(bytes.subarray(offset, offset + BUFFER_CHUNK_BYTES));
    }
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        chunkIndex = index;
        const append = index ? '-a ' : '';
        // Loading a private random buffer has no pane side effect. Keep these
        // commands small and direct; the final paste-buffer remains guarded by
        // the complete immutable target/PID condition before any input occurs.
        await this.execute(`set-buffer ${append}-b ${bufferName} ${quoteTmuxBytes(chunks[index])}`);
      }
    } catch (error) {
      await this.execute(`delete-buffer -b ${bufferName}`).catch(() => {});
      const failure = new Error(`tmux buffer chunk ${chunkIndex + 1}/${chunks.length} failed: ${error?.message || error}`);
      failure.cause = error;
      throw failure;
    }
  }

  async pasteBufferExact(bufferName, bytes, pasteCommand, options = {}) {
    try {
      await this.loadBufferExact(bufferName, bytes);
      options.onInputAttempt?.();
      await this.performInput(pasteCommand);
    } finally {
      // paste-buffer -d deletes on success, but an identity failure between
      // loading and paste must not leave command contents in tmux's global
      // buffer store. A second delete after success is harmless and best-effort.
      await this.execute(`delete-buffer -b ${bufferName}`).catch(() => {});
    }
  }

  sendRaw(bytes) {
    if (!bytes.length || this.stopping) return;
    const input = Buffer.from(bytes);
    this.enqueueInputOperation(async () => {
      for (let offset = 0; offset < input.length; offset += MAX_RAW_INPUT_CHUNK_BYTES) {
        const chunk = input.subarray(offset, offset + MAX_RAW_INPUT_CHUNK_BYTES);
        const hex = [...chunk].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
        await this.performInput(`send-keys -H -t ${quoteTmuxArgument(this.fullTarget)} ${hex}`);
      }
    }).catch(() => {});
  }

  sendPaste(bytes) {
    if (this.stopping) return;
    if (bytes.length > MAX_COMMAND_BYTES || bytes.includes(0)) {
      this.fatal(new Error('bracketed paste is invalid or too large'));
      return;
    }
    const input = Buffer.from(bytes);
    const bufferName = `lta-${this.nonce.slice(0, 10)}-${crypto.randomBytes(5).toString('hex')}`;
    this.enqueueInputOperation(async () => {
      await this.pasteBufferExact(
        bufferName,
        input,
        `paste-buffer -p -r -d -b ${bufferName} -t ${quoteTmuxArgument(this.fullTarget)}`,
      );
    }).catch(() => {});
  }

  emitCommandAck(requestId, state, message = '') {
    const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(requestId) ? requestId : 'invalid';
    const encodedMessage = message ? base64urlEncode(Buffer.from(message, 'utf8')) : '';
    this.emitProtocolData(Buffer.from(`LTA_PROXY_ACK_${this.options.channel};${safeId};${state};${encodedMessage}\n`, 'ascii'));
  }

  handleCommandFrame(channel, encoded) {
    let payload;
    try {
      if (channel !== this.options.channel) throw new Error('command channel does not match this terminal');
      payload = commandFramePayload(encoded);
    } catch (error) {
      this.emitCommandAck('invalid', 'rejected', error.message);
      return;
    }
    const bufferName = `lta-${this.nonce.slice(0, 10)}-${crypto.randomBytes(5).toString('hex')}`;
    this.enqueueInputOperation(async () => {
      let inputAttempted = false;
      try {
        // Prove the complete source session/window/pane/PID identity before
        // any pane-side effect. If the old compound target no longer resolves,
        // this failure is safely retryable. The guarded input below repeats the
        // check; a target change after preflight remains conservatively unknown.
        await this.verifyIdentity('input-preflight');
        await this.pasteBufferExact(
          bufferName,
          payload.command,
          // tmux appends paste-buffer bytes and send-keys to the same pane
          // bufferevent in command-queue order. Keep both writes in one guarded
          // control operation so health/topology commands cannot interleave and
          // small deliveries remain within the manager ACK deadline.
          `paste-buffer -p -r -d -b ${bufferName} -t ${quoteTmuxArgument(this.fullTarget)} ; send-keys -t ${quoteTmuxArgument(this.fullTarget)} Enter`,
          { onInputAttempt: () => { inputAttempted = true; } },
        );
        this.emitCommandAck(payload.requestId, 'accepted');
      } catch (error) {
        // Loading a private buffer has no pane side effect. An exact guard fail
        // also proves its combined paste+Enter success branch never ran. Any
        // other failure after the control write is uncertain: retrying could
        // execute the same command twice, so preserve the delivery ledger.
        const safelyRejected = !inputAttempted
          || ['TMUX_EXACT_TARGET_UNVERIFIED', 'TMUX_EXACT_TARGET_CHANGED'].includes(error?.code);
        this.emitCommandAck(payload.requestId, safelyRejected ? 'rejected' : 'unknown', error.message);
        throw error;
      }
    }).catch(() => {});
  }

  setupInput() {
    const paste = new BracketedPasteParser(
      bytes => this.sendRaw(bytes),
      bytes => this.sendPaste(bytes),
      message => this.fatal(new Error(message)),
    );
    const dcs = new DcsInputParser(
      bytes => paste.push(bytes),
      (channel, encoded) => this.handleCommandFrame(channel, encoded),
      message => this.emitCommandAck('invalid', 'rejected', message),
      this.options.channel,
    );
    this.inputParser = dcs;
    if (this.runtime.inProcess) return;
    let input = process.stdin;
    if (process.platform === 'win32') {
      // electron.exe is a GUI-subsystem binary.  When a console cmd.exe owns
      // the outer ConPTY, Electron's inherited process.stdin is permanently
      // ended even though the console is live.  Open that console explicitly;
      // the cmd parent is synchronously waiting for this process and does not
      // compete for reads.
      try {
        const consoleFd = fs.openSync('CONIN$', 'r');
        input = new tty.ReadStream(consoleFd);
      } catch (_noParentConsole) {
        input = process.stdin;
      }
    }
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.on('data', chunk => {
      if (process.env.LTA_TMUX_PROXY_DEBUG === '1') process.stderr.write(`[tmux-control-proxy:stdin] ${JSON.stringify(Buffer.from(chunk).toString('latin1'))}\n`);
      dcs.push(chunk);
    });
  }

  currentSize() {
    if (this.runtime.inProcess) return { ...this.lastSize };
    return {
      cols: boundedInteger(process.stdout.columns, this.lastSize.cols, 20, 500),
      rows: boundedInteger(process.stdout.rows, this.lastSize.rows, 5, 300),
    };
  }

  applyResize() {
    // Fixed-grid source contract; see resize().
  }

  setupResize() {
    if (this.runtime.inProcess) return;
    const resize = () => this.applyResize();
    process.on('SIGWINCH', resize);
    process.stdout.on?.('resize', resize);
    this.resizeTimer = setInterval(resize, 500);
    this.resizeTimer.unref?.();
    resize();
  }

  checkHealth() {
    if (!this.verified || this.stopping) return Promise.resolve();
    // setInterval must not build an unbounded FIFO of health checks while WSL
    // or the tmux server is briefly descheduled. Output/topology checks retain
    // their own post-event ordering; only redundant periodic probes coalesce.
    if (this.healthCheckPromise) return this.healthCheckPromise;
    if (this.topologyRefreshPromise || this.topologyRefreshTimer || this.topologyRefreshPending) {
      return this.topologyRefreshPromise || Promise.resolve();
    }
    const operation = this.verifyIdentity('health').finally(() => {
      if (this.healthCheckPromise === operation) this.healthCheckPromise = null;
    });
    this.healthCheckPromise = operation;
    return operation;
  }

  async verifyIdentity(purpose) {
    const token = `LTA_HEALTH_${crypto.randomBytes(6).toString('hex')}`;
    const fail = `${token}_FAIL`;
    const samplePrefix = `${token}_${purpose}|`;
    const sampleFormat = `${samplePrefix}#{pane_width}|#{pane_height}`;
    const command = this.exactOperation(
      `display-message -p -t ${quoteTmuxArgument(this.fullTarget)} ${quoteTmuxArgument(sampleFormat)}`,
      token,
      fail,
    );
    const lines = (await this.executeUntil(
      command,
      (_response, aggregate) => aggregate.some(line => [token, fail].includes(line.toString('utf8'))),
    )).map(line => line.toString('utf8'));
    if (!lines.includes(token)) throw new Error('tmux exact pane is no longer alive');
    const sample = lines.find(line => line.startsWith(samplePrefix));
    const dimensions = sample?.slice(samplePrefix.length).split('|') || [];
    const cols = Number(dimensions[0]);
    const rows = Number(dimensions[1]);
    if (Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0
      && (cols !== this.sourceCols || rows !== this.sourceRows)) {
      this.sourceCols = cols;
      this.sourceRows = rows;
      this.emit('source-size', { cols, rows });
      if (this.verified) this.emitSourceMeta();
    }
  }

  cleanupSync() {
    if (this.cleaned) return;
    this.cleaned = true;
    if (!this.controlStarted) return;
    const executable = this.executable();
    try {
      spawnSync(executable.file, [...executable.prefix, 'kill-session', '-t', this.shadowSession], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 2_000,
      });
    } catch (_ignored) {
      // destroy-unattached is the second, server-owned cleanup path.
    }
  }

  cleanup() {
    if (this.cleaned || !this.controlStarted) {
      this.cleaned = true;
      return Promise.resolve();
    }
    if (this.cleanupPromise) return this.cleanupPromise;
    if (this.destroyUnattachedEnabled && this.controlClosePromise) {
      const timeoutMs = Math.max(
        10,
        Number(this.runtime.controlExitConfirmTimeoutMs) || CHILD_EXIT_CONFIRM_TIMEOUT_MS,
      );
      this.cleanupPromise = new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const error = new Error('tmux control child exit was not confirmed after detach');
          error.code = 'TMUX_PROXY_CONTROL_EXIT_UNCONFIRMED';
          reject(error);
        }, timeoutMs);
        this.controlClosePromise.then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.cleaned = true;
          resolve();
        });
      });
      this.cleanupPromise.catch(() => {});
      return this.cleanupPromise;
    }
    const command = [
      `tmux kill-session -t ${shellQuote(this.shadowSession)} >/dev/null 2>&1 || true`,
      `! tmux has-session -t ${shellQuote(this.shadowSession)} 2>/dev/null`,
    ].join('; ');
    const launch = process.platform === 'win32'
      ? { file: 'wsl.exe', args: ['-d', this.options.distro, '--exec', 'sh', '-c', command] }
      : { file: '/bin/sh', args: ['-c', command] };
    const spawnCleanup = this.runtime.spawnCleanupChild || spawnChild;
    const cleanupTimeoutMs = Math.max(10, Number(this.runtime.cleanupTimeoutMs) || CLEANUP_TIMEOUT_MS);
    const exitConfirmTimeoutMs = Math.max(
      10,
      Number(this.runtime.cleanupExitConfirmTimeoutMs) || CLEANUP_EXIT_CONFIRM_TIMEOUT_MS,
    );
    this.cleanupPromise = new Promise((resolve, reject) => {
      let child;
      let timer = null;
      let exitConfirmationTimer = null;
      let settled = false;
      let timedOut = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (exitConfirmationTimer) clearTimeout(exitConfirmationTimer);
        if (error) {
          reject(error);
          return;
        }
        this.cleaned = true;
        resolve();
      };
      try {
        child = spawnCleanup(launch.file, launch.args, {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch (error) {
        finish(error);
        return;
      }
      child.once('error', finish);
      child.once('close', (code, signal) => {
        if (timedOut) {
          const error = new Error('tmux shadow cleanup timed out before its child exited');
          error.code = 'TMUX_PROXY_CLEANUP_TIMEOUT';
          finish(error);
          return;
        }
        if (code !== 0) {
          const error = new Error(`tmux shadow cleanup was not confirmed (${code ?? signal ?? 'unknown'})`);
          error.code = 'TMUX_PROXY_CLEANUP_UNCONFIRMED';
          finish(error);
          return;
        }
        finish();
      });
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch (_ignored) { /* already gone */ }
        exitConfirmationTimer = setTimeout(() => {
          const error = new Error('tmux shadow cleanup child exit was not confirmed');
          error.code = 'TMUX_PROXY_CLEANUP_CHILD_EXIT_UNCONFIRMED';
          finish(error);
        }, exitConfirmTimeoutMs);
      }, cleanupTimeoutMs);
    });
    this.cleanupPromise.catch(() => {});
    return this.cleanupPromise;
  }

  fatal(error) {
    if (this.stopping) return;
    const message = String(error?.message || error || 'tmux proxy failure').replace(/[\r\n]+/gu, ' ').slice(0, 400);
    process.stderr.write(`[tmux-control-proxy] ${message}\n`);
    this.stop(1);
  }

  stop(code = this.exitCode) {
    if (this.stopping) return this.stopPromise;
    this.stopping = true;
    this.exitCode = code;
    const pendingProbeClose = this.probeClosePromise;
    const probeClose = pendingProbeClose ? new Promise((resolve, reject) => {
      let settled = false;
      const timeoutMs = Math.max(
        10,
        Number(this.runtime.probeExitConfirmTimeoutMs) || CHILD_EXIT_CONFIRM_TIMEOUT_MS,
      );
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new Error('tmux source probe child exit was not confirmed');
        error.code = 'TMUX_PROXY_PROBE_EXIT_UNCONFIRMED';
        reject(error);
      }, timeoutMs);
      pendingProbeClose.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    }) : Promise.resolve();
    probeClose.catch(() => {});
    this.cancelProbe?.();
    if (this.attachedWaiter) {
      const waiter = this.attachedWaiter;
      this.attachedWaiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(proxyStoppedError());
    }
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.resizeTimer) clearInterval(this.resizeTimer);
    if (this.outputFlushTimer) clearTimeout(this.outputFlushTimer);
    if (this.topologyRefreshTimer) clearTimeout(this.topologyRefreshTimer);
    this.topologyRefreshTimer = null;
    this.topologyRefreshPending = false;
    for (const pending of this.pendingResponses.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new Error('tmux proxy stopped'));
    }
    try { this.control?.stdin?.write('detach-client\n'); } catch (_ignored) { /* already gone */ }
    this.stopPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        probeClose.then(() => {
          try { this.control?.kill(); } catch (_ignored) { /* already gone */ }
          return this.cleanup();
        }).then(() => {
          if (this.runtime.inProcess) {
            this.endData();
            this.emitExit(this.exitCode);
            resolve();
          } else {
            process.exit(this.exitCode);
          }
        }, error => {
          if (this.runtime.inProcess) {
            reject(error);
            return;
          }
          process.stderr.write(`[tmux-control-proxy] ${String(error?.message || error)}\n`);
          this.cleanupSync();
          process.exit(1);
        });
      }, 40);
    });
    this.stopPromise.catch(() => {});
    return this.stopPromise;
  }
}

function createTmuxControlProxyHandle(options, runtime = {}) {
  const normalized = typeof options === 'string' ? parseLaunchPayload(options) : options;
  const proxy = new TmuxControlProxy(normalized, { ...runtime, inProcess: true });
  proxy.start().catch(error => proxy.fatal(error));
  return proxy;
}

async function main() {
  let proxy;
  try {
    const options = parseLaunchPayload(process.argv[2]);
    proxy = new TmuxControlProxy(options);
    process.once('exit', () => proxy.cleanupSync());
    process.once('SIGINT', () => proxy.stop(0));
    process.once('SIGTERM', () => proxy.stop(0));
    process.once('SIGHUP', () => proxy.stop(0));
    process.once('uncaughtException', error => proxy.fatal(error));
    process.once('unhandledRejection', error => proxy.fatal(error));
    await proxy.start();
  } catch (error) {
    if (proxy) proxy.fatal(error);
    else {
      process.stderr.write(`[tmux-control-proxy] ${String(error?.message || error)}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  BracketedPasteParser,
  ControlProtocolParser,
  DcsInputParser,
  TmuxControlProxy,
  ansiInitialization,
  base64urlDecode,
  base64urlEncode,
  commandFramePayload,
  createTmuxControlProxyHandle,
  decodeTmuxControlBytes,
  parseLaunchPayload,
  quoteTmuxArgument,
  quoteTmuxBytes,
  shellQuote,
};

if (require.main === module) main();
