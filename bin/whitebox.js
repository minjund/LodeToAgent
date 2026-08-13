#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'grok']);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

function usage() {
  return [
    'Whitebox · AI 작업 도우미',
    '',
    '사용법:',
    '  whitebox                                           데스크톱 앱 열기',
    '  whitebox open                                      데스크톱 앱 열기',
    '  whitebox run <claude|codex|gemini|grok> [-- 옵션]  앱 브리지에서 AI 실행',
    '  whitebox codex-endpoint                              공유 Codex 서버 주소 확인',
    '  whitebox --version                                 버전 확인',
    '',
    '예시:',
    '  whitebox',
    '  whitebox run codex',
    '  whitebox run claude -- --model claude-sonnet-4-6',
    '',
    '`run` 명령을 사용하려면 Whitebox 데스크톱 앱이 열려 있어야 합니다.',
  ].join('\n');
}

function parseCliArguments(argv) {
  const args = [...argv];
  const command = String(args[0] || '').toLowerCase();
  if (!command || command === 'open') return { action: 'open' };
  if (command === '--help' || command === '-h' || command === 'help') return { action: 'help' };
  if (command === '--version' || command === '-v' || command === 'version') return { action: 'version' };
  if (command === 'codex-endpoint') return { action: 'codex-endpoint' };
  if (command === 'run') return { action: 'run', ...parseArguments(args) };
  throw new Error(usage());
}

function parseArguments(argv) {
  const args = [...argv];
  if (args[0] !== 'run') throw new Error(usage());
  const provider = String(args[1] || '').toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error(usage());
  const passthrough = args.slice(2);
  if (passthrough[0] === '--') passthrough.shift();
  return { provider, args: passthrough };
}

function terminalSize() {
  return {
    cols: Math.max(20, Number(process.stdout.columns || 120)),
    rows: Math.max(5, Number(process.stdout.rows || 32)),
  };
}

function desktopLaunchSpec(options = {}) {
  const sourceEnv = options.env || process.env;
  const env = { ...sourceEnv };
  const packagedLauncher = sourceEnv.ELECTRON_RUN_AS_NODE === '1';
  const sourceLauncher = sourceEnv.WHITEBOX_SOURCE_LAUNCHER === '1'
    || sourceEnv.LOADTOAGENT_SOURCE_LAUNCHER === '1';
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WHITEBOX_SOURCE_LAUNCHER;
  delete env.LOADTOAGENT_SOURCE_LAUNCHER;
  if (packagedLauncher) {
    const executable = options.execPath || process.execPath;
    const executableName = String(executable).split(/[\\/]/u).pop() || '';
    const electronExecutable = /^electron(?:\.exe)?$/i.test(executableName);
    return {
      executable,
      args: sourceLauncher || electronExecutable ? [options.packageRoot || PACKAGE_ROOT] : [],
      env,
    };
  }
  const executable = options.electronPath || require('electron');
  return { executable, args: [options.packageRoot || PACKAGE_ROOT], env };
}

function launchDesktop(options = {}) {
  const spec = desktopLaunchSpec(options);
  const spawnProcess = options.spawnProcess || spawn;
  const child = spawnProcess(spec.executable, spec.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: spec.env,
  });
  child.unref();
  return spec;
}

function readDiscovery(home = os.homedir(), options = {}) {
  const environment = options.env || process.env;
  const fileSystem = options.fileSystem || fs;
  const configured = environment.WHITEBOX_BRIDGE_FILE || environment.LOADTOAGENT_BRIDGE_FILE;
  const files = configured
    ? [configured]
    : [path.join(home, '.whitebox', 'bridge.json'), path.join(home, '.loadtoagent', 'bridge.json')];
  let value;
  for (const file of files) {
    try {
      value = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
      break;
    } catch (_unavailableDiscovery) {}
  }
  if (!value) throw new Error('실행 중인 Whitebox 브리지를 찾지 못했습니다. Whitebox 프로그램을 먼저 여세요.');
  if (!value || value.protocol !== 1 || !value.endpoint || !value.token) throw new Error('Whitebox 브리지 정보가 올바르지 않습니다. 프로그램을 다시 시작하세요.');
  return value;
}

function readCodexEndpoint(home = os.homedir(), options = {}) {
  const discovery = readDiscovery(home, options);
  const endpoint = String(discovery?.codexAppServer?.endpoint || '');
  if (!discovery?.codexAppServer?.ready || !/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(endpoint)) {
    throw new Error('공유 Codex 서버가 아직 준비되지 않았습니다. Whitebox에서 Codex 작업을 먼저 여세요.');
  }
  const port = Number(endpoint.slice(endpoint.lastIndexOf(':') + 1));
  if (port > 65_535) throw new Error('Whitebox의 공유 Codex 서버 주소가 올바르지 않습니다.');
  return endpoint;
}

function writeFrame(socket, value) {
  return socket.write(`${JSON.stringify(value)}\n`, 'utf8');
}

const MAX_PENDING_OUTBOUND_FRAMES = 8;
const MAX_PENDING_OUTBOUND_BYTES = 2 * 1024 * 1024;
const TERMINATE_DRAIN_TIMEOUT_MS = 1_500;

function createSocketBackpressure(socket, inputFlow = {}, options = {}) {
  const pauseInput = typeof inputFlow.pause === 'function' ? inputFlow.pause : () => {};
  const resumeInput = typeof inputFlow.resume === 'function' ? inputFlow.resume : () => {};
  const scheduleTimeout = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const cancelTimeout = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const terminateTimeoutMs = Number.isFinite(Number(options.terminateTimeoutMs))
    ? Math.max(1, Number(options.terminateTimeoutMs))
    : TERMINATE_DRAIN_TIMEOUT_MS;
  let blocked = false;
  let cleaned = false;
  let ending = false;
  let terminateQueued = false;
  let terminateTimer = null;
  let drainAttached = false;
  let pendingBytes = 0;
  const pending = [];

  const destroyOverflow = () => {
    const error = new Error('Whitebox 브리지 입력 전송 대기열이 가득 찼습니다.');
    error.code = 'CLI_BRIDGE_OUTBOUND_OVERFLOW';
    cleanup();
    try { socket.destroy(error); } catch {}
  };

  const clearTerminateTimer = () => {
    if (terminateTimer === null) return;
    cancelTimeout(terminateTimer);
    terminateTimer = null;
  };
  const scheduleTerminateDeadline = () => {
    if (terminateTimer !== null || cleaned) return;
    terminateTimer = scheduleTimeout(() => {
      terminateTimer = null;
      if (cleaned || (!terminateQueued && !ending)) return;
      const error = new Error('Whitebox 브리지 종료 신호 전송 시간이 초과되었습니다.');
      error.code = 'CLI_BRIDGE_TERMINATE_TIMEOUT';
      cleanup();
      try { socket.destroy(error); } catch {}
    }, terminateTimeoutMs);
    if (typeof terminateTimer?.unref === 'function') terminateTimer.unref();
  };

  const encode = value => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const removePendingAt = index => {
    const [removed] = pending.splice(index, 1);
    if (removed) pendingBytes = Math.max(0, pendingBytes - removed.frame.length);
  };
  const enqueue = (value, kind) => {
    if (cleaned || ending || terminateQueued) return false;
    const frame = encode(value);
    if (kind === 'resize') {
      const resizeIndex = pending.findIndex(entry => entry.kind === 'resize');
      if (resizeIndex >= 0) removePendingAt(resizeIndex);
    }
    if (pending.length >= MAX_PENDING_OUTBOUND_FRAMES
      || pendingBytes + frame.length > MAX_PENDING_OUTBOUND_BYTES) {
      destroyOverflow();
      return false;
    }
    pending.push({ frame, kind });
    pendingBytes += frame.length;
    return false;
  };
  const attachDrain = () => {
    if (drainAttached || cleaned || ending) return;
    drainAttached = true;
    socket.once('drain', onDrain);
  };
  const markBlocked = () => {
    blocked = true;
    pauseInput();
    attachDrain();
  };
  const flush = () => {
    while (!blocked && !cleaned && !ending && pending.length > 0) {
      const entry = pending.shift();
      pendingBytes = Math.max(0, pendingBytes - entry.frame.length);
      if (entry.kind === 'terminate') {
        ending = true;
        pauseInput();
        try {
          socket.end(entry.frame);
        } catch (error) {
          cleanup();
          try { socket.destroy(error); } catch {}
        }
        return;
      }
      let writable;
      try { writable = socket.write(entry.frame); } catch (error) {
        cleanup();
        try { socket.destroy(error); } catch {}
        return;
      }
      if (!writable) markBlocked();
    }
  };
  function onDrain() {
    drainAttached = false;
    if (cleaned || ending) return;
    blocked = false;
    flush();
    if (!blocked && !cleaned && !ending) resumeInput();
  }
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTerminateTimer();
    if (drainAttached) socket.removeListener('drain', onDrain);
    drainAttached = false;
    blocked = false;
    pending.length = 0;
    pendingBytes = 0;
  }

  return {
    send(value, kind = 'control') {
      if (cleaned || ending || terminateQueued) return false;
      if (blocked || pending.length > 0) return enqueue(value, kind);
      let writable;
      try { writable = writeFrame(socket, value); } catch (error) {
        cleanup();
        try { socket.destroy(error); } catch {}
        return false;
      }
      if (!writable) markBlocked();
      return writable;
    },
    terminate(value) {
      if (cleaned || ending || terminateQueued) return false;
      terminateQueued = true;
      pauseInput();
      scheduleTerminateDeadline();
      let frame;
      try {
        frame = encode(value);
      } catch (error) {
        cleanup();
        try { socket.destroy(error); } catch {}
        return false;
      }
      if (blocked || pending.length > 0) {
        if (pending.length >= MAX_PENDING_OUTBOUND_FRAMES
          || pendingBytes + frame.length > MAX_PENDING_OUTBOUND_BYTES) {
          destroyOverflow();
          return false;
        }
        pending.push({ frame, kind: 'terminate' });
        pendingBytes += frame.length;
        return false;
      }
      ending = true;
      try {
        socket.end(frame);
      } catch (error) {
        cleanup();
        try { socket.destroy(error); } catch {}
        return false;
      }
      return true;
    },
    blocked: () => blocked,
    pendingCount: () => pending.length,
    cleanup,
  };
}

function createStdoutBackpressure(socket, stdout, drainWork = () => {}) {
  let blocked = false;
  let cleaned = false;
  const onDrain = () => {
    if (cleaned) return;
    blocked = false;
    drainWork();
    if (!blocked && !cleaned && !socket.destroyed) socket.resume();
  };
  return {
    write(data) {
      if (cleaned || blocked) return false;
      const writable = stdout.write(data);
      if (!writable) {
        blocked = true;
        socket.pause();
        stdout.once('drain', onDrain);
      }
      return writable;
    },
    blocked: () => blocked,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      stdout.removeListener('drain', onDrain);
      blocked = false;
    },
  };
}

function run(argv = process.argv.slice(2)) {
  const command = parseArguments(argv);
  const discovery = readDiscovery();
  const socket = net.createConnection(discovery.endpoint);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let raw = false;
  let exitCode = 0;
  let started = false;
  let finished = false;

  const sendInput = data => outgoingFlow.send({ type: 'input', data: Buffer.from(data).toString('base64') }, 'input');
  const sendResize = () => outgoingFlow.send({ type: 'resize', ...terminalSize() }, 'resize');
  const sendTerminate = () => outgoingFlow.terminate({ type: 'signal', signal: 'terminate' });

  const restore = () => {
    if (raw && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try { process.stdin.setRawMode(false); } catch {}
    }
    process.stdin.removeListener('data', sendInput);
    process.stdout.removeListener('resize', sendResize);
    process.removeListener('SIGTERM', sendTerminate);
    process.stdin.pause();
  };
  const finish = code => {
    if (finished) return;
    finished = true;
    outputFlow.cleanup();
    outgoingFlow.cleanup();
    restore();
    process.exitCode = Number.isFinite(code) ? code : exitCode;
  };

  const configureStartedSession = () => {
    if (started) return;
    started = true;
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true);
      raw = true;
    }
    process.stdin.on('data', sendInput);
    process.stdout.on('resize', sendResize);
    if (!outgoingFlow.blocked()) process.stdin.resume();
  };

  const handleMessage = message => {
    if (message.type === 'started') {
      configureStartedSession();
      return !message.replay || outputFlow.write(Buffer.from(message.replay, 'base64'));
    }
    if (message.type === 'output') {
      return outputFlow.write(Buffer.from(String(message.data || ''), 'base64'));
    }
    if (message.type === 'state' && ['detached', 'stopped', 'exited', 'failed'].includes(message.status)) {
      exitCode = Number(message.exitCode || 0);
    } else if (message.type === 'error') {
      process.stderr.write(`\nWhitebox: ${message.message}\n`);
      exitCode = 1;
    }
    return true;
  };

  const consumeFrames = () => {
    if (outputFlow.blocked()) return;
    let newline;
    while (!outputFlow.blocked() && (newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_invalidFrame) {
        socket.destroy(new Error('Whitebox 브리지가 올바르지 않은 내용을 보냈습니다.'));
        return;
      }
      if (!handleMessage(message || {})) return;
    }
  };

  const outputFlow = createStdoutBackpressure(socket, process.stdout, consumeFrames);
  const outgoingFlow = createSocketBackpressure(socket, {
    pause: () => process.stdin.pause(),
    resume: () => {
      if (started && !finished) process.stdin.resume();
    },
  });

  socket.on('connect', () => outgoingFlow.send({
    type: 'run',
    token: discovery.token,
    provider: command.provider,
    args: command.args,
    cwd: process.cwd(),
    ...terminalSize(),
  }, 'run'));
  socket.on('data', chunk => {
    buffer += decoder.write(chunk);
    consumeFrames();
  });
  socket.on('error', error => {
    process.stderr.write(`Whitebox 연결 실패: ${error.message}\n`);
    exitCode = 1;
  });
  socket.on('close', () => finish(exitCode));
  process.on('SIGTERM', sendTerminate);
}

if (require.main === module) {
  try {
    const command = parseCliArguments(process.argv.slice(2));
    if (command.action === 'open') launchDesktop();
    else if (command.action === 'help') process.stdout.write(`${usage()}\n`);
    else if (command.action === 'version') process.stdout.write(`${require('../package.json').version}\n`);
    else if (command.action === 'codex-endpoint') process.stdout.write(`${readCodexEndpoint()}\n`);
    else run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArguments,
  parseCliArguments,
  desktopLaunchSpec,
  launchDesktop,
  readCodexEndpoint,
  readDiscovery,
  terminalSize,
  createSocketBackpressure,
  createStdoutBackpressure,
  run,
  usage,
};
