'use strict';

const fs = require('fs');
const path = require('path');
const { TerminalManager } = require('./terminalManager');
const { BridgeServer } = require('./bridgeServer');
const { TerminalHostServer } = require('./terminalHost');

function parseConfig(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--config');
  if (index < 0 || !argv[index + 1]) throw new Error('명령창 연결 설정이 없습니다.');
  const parsed = JSON.parse(Buffer.from(argv[index + 1], 'base64').toString('utf8'));
  for (const key of ['storeFile', 'discoveryFile', 'bridgeHome']) {
    if (!parsed[key] || typeof parsed[key] !== 'string') throw new Error(`명령창 연결 설정이 올바르지 않습니다: ${key}`);
  }
  return {
    storeFile: path.resolve(parsed.storeFile),
    discoveryFile: path.resolve(parsed.discoveryFile),
    bridgeHome: path.resolve(parsed.bridgeHome),
  };
}

async function run(config = parseConfig()) {
  process.title = 'LoadToAgent Terminal Host';
  const manager = new TerminalManager({ storeFile: config.storeFile });
  manager.recoverPersistedSessions();
  let stopping = false;
  let host = null;
  let bridge = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (bridge) bridge.dispose();
    if (host) host.dispose();
    manager.dispose({ preserveSessions: true });
    setImmediate(() => process.exit(0));
  };
  host = new TerminalHostServer({ manager, discoveryFile: config.discoveryFile, onShutdown: stop });
  bridge = new BridgeServer({ terminalManager: manager, home: config.bridgeHome, platform: process.platform });
  await host.start();
  try { await bridge.start(); } catch (error) {
    const logFile = path.join(path.dirname(config.discoveryFile), 'terminal-host.log');
    fs.appendFileSync(logFile, `${new Date().toISOString()} bridge: ${error.stack || error.message}\n`, 'utf8');
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { manager, host, bridge, stop };
}

if (require.main === module) {
  run().catch(error => {
    try {
      const config = parseConfig();
      fs.mkdirSync(path.dirname(config.discoveryFile), { recursive: true });
      fs.appendFileSync(path.join(path.dirname(config.discoveryFile), 'terminal-host.log'), `${new Date().toISOString()} fatal: ${error.stack || error.message}\n`, 'utf8');
    } catch {}
    process.exitCode = 1;
  });
}

module.exports = { parseConfig, run };
