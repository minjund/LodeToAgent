'use strict';

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

process.stdout.write('WHITEBOX_DRAWER_BOUND_PTY_READY\r\n');

rl.on('line', line => {
  const command = String(line || '').trim();
  if (!command.startsWith('LTA_DRAWER_ECHO:')) {
    process.stdout.write(`UNEXPECTED_DRAWER_COMMAND:${command}\r\n`);
    return;
  }
  const encoded = command.slice('LTA_DRAWER_ECHO:'.length);
  try {
    process.stdout.write(`${Buffer.from(encoded, 'base64url').toString('utf8')}\r\n`);
  } catch (_invalidPayload) {
    process.stdout.write('INVALID_DRAWER_MARKER\r\n');
  }
});

const finish = () => {
  rl.close();
  process.exit(0);
};

process.on('SIGTERM', finish);
process.on('SIGHUP', finish);
