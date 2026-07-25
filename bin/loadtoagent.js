#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'grok']);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

function usage() {
  return [
    'LoadToAgent · AI 작업 도우미',
    '',
    '사용법:',
    '  loadtoagent                                           데스크톱 앱 열기',
    '  loadtoagent open                                      데스크톱 앱 열기',
    '  loadtoagent run <claude|codex|gemini|grok> [-- 옵션]  앱 브리지에서 AI 실행',
    '  loadtoagent --version                                 버전 확인',
    '',
    '예시:',
    '  loadtoagent',
    '  loadtoagent run codex',
    '  loadtoagent run claude -- --model claude-sonnet-4-6',
    '',
    '`run` 명령을 사용하려면 LoadToAgent 데스크톱 앱이 열려 있어야 합니다.',
  ].join('\n');
}

function parseCliArguments(argv) {
  const args = [...argv];
  const command = String(args[0] || '').toLowerCase();
  if (!command || command === 'open') return { action: 'open' };
  if (command === '--help' || command === '-h' || command === 'help') return { action: 'help' };
  if (command === '--version' || command === '-v' || command === 'version') return { action: 'version' };
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
  delete env.ELECTRON_RUN_AS_NODE;
  if (packagedLauncher) {
    return { executable: options.execPath || process.execPath, args: [], env };
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

function readDiscovery(home = os.homedir()) {
  const file = process.env.LOADTOAGENT_BRIDGE_FILE || path.join(home, '.loadtoagent', 'bridge.json');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('실행 중인 LoadToAgent 브리지를 찾지 못했습니다. LoadToAgent 프로그램을 먼저 여세요.'); }
  if (!value || value.protocol !== 1 || !value.endpoint || !value.token) throw new Error('LoadToAgent 브리지 정보가 올바르지 않습니다. 프로그램을 다시 시작하세요.');
  return value;
}

function writeFrame(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`, 'utf8');
}

function run(argv = process.argv.slice(2)) {
  const command = parseArguments(argv);
  const discovery = readDiscovery();
  const socket = net.createConnection(discovery.endpoint);
  let buffer = '';
  let raw = false;
  let exitCode = 0;

  const restore = () => {
    if (raw && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try { process.stdin.setRawMode(false); } catch {}
    }
    process.stdin.pause();
  };
  const finish = code => {
    restore();
    process.exitCode = Number.isFinite(code) ? code : exitCode;
  };
  const sendResize = () => writeFrame(socket, { type: 'resize', ...terminalSize() });

  socket.on('connect', () => writeFrame(socket, {
    type: 'run',
    token: discovery.token,
    provider: command.provider,
    args: command.args,
    cwd: process.cwd(),
    ...terminalSize(),
  }));
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type === 'started') {
        if (message.replay) process.stdout.write(Buffer.from(message.replay, 'base64'));
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
          process.stdin.setRawMode(true);
          raw = true;
        }
        process.stdin.resume();
        process.stdin.on('data', data => writeFrame(socket, { type: 'input', data: Buffer.from(data).toString('base64') }));
        process.stdout.on('resize', sendResize);
      } else if (message.type === 'output') process.stdout.write(Buffer.from(String(message.data || ''), 'base64'));
      else if (message.type === 'state' && ['detached', 'stopped', 'exited', 'failed'].includes(message.status)) {
        exitCode = Number(message.exitCode || 0);
      }
      else if (message.type === 'error') {
        process.stderr.write(`\nLoadToAgent: ${message.message}\n`);
        exitCode = 1;
      }
    }
  });
  socket.on('error', error => {
    process.stderr.write(`LoadToAgent 연결 실패: ${error.message}\n`);
    exitCode = 1;
  });
  socket.on('close', () => finish(exitCode));
  process.on('SIGTERM', () => { writeFrame(socket, { type: 'signal', signal: 'terminate' }); socket.end(); });
}

if (require.main === module) {
  try {
    const command = parseCliArguments(process.argv.slice(2));
    if (command.action === 'open') launchDesktop();
    else if (command.action === 'help') process.stdout.write(`${usage()}\n`);
    else if (command.action === 'version') process.stdout.write(`${require('../package.json').version}\n`);
    else run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, parseCliArguments, desktopLaunchSpec, launchDesktop, readDiscovery, terminalSize, run, usage };
