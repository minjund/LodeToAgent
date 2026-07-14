#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'grok']);

function usage() {
  return [
    '사용법: lodestar run <claude|codex|gemini|grok> [-- AI_CLI_옵션...]',
    '예시: lodestar run codex',
    '      lodestar run claude -- --model claude-sonnet-4-6',
    '',
    'Lodestar 프로그램을 먼저 실행해야 합니다.',
  ].join('\n');
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

function readDiscovery(home = os.homedir()) {
  const file = process.env.LODESTAR_BRIDGE_FILE || path.join(home, '.lodestar', 'bridge.json');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('실행 중인 Lodestar 브리지를 찾지 못했습니다. Lodestar 프로그램을 먼저 여세요.'); }
  if (!value || value.protocol !== 1 || !value.endpoint || !value.token) throw new Error('Lodestar 브리지 정보가 올바르지 않습니다. 프로그램을 다시 시작하세요.');
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
      else if (message.type === 'state' && (message.status === 'exited' || message.status === 'failed')) exitCode = Number(message.exitCode || 0);
      else if (message.type === 'error') {
        process.stderr.write(`\nLodestar: ${message.message}\n`);
        exitCode = 1;
      }
    }
  });
  socket.on('error', error => {
    process.stderr.write(`Lodestar 연결 실패: ${error.message}\n`);
    exitCode = 1;
  });
  socket.on('close', () => finish(exitCode));
  process.on('SIGTERM', () => { writeFrame(socket, { type: 'signal', signal: 'terminate' }); socket.end(); });
}

if (require.main === module) {
  try { run(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArguments, readDiscovery, terminalSize, run };
