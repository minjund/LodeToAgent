'use strict';

const fs = require('fs');
const path = require('path');
const { TerminalManager } = require('./terminalManager');
const { BridgeServer } = require('./bridgeServer');
const { TerminalHostServer, acquireTerminalHostProcessLock } = require('./terminalHost');

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
  const existing = await existingHealthyHost(config.discoveryFile);
  if (existing) return { existing: true, discovery: existing, stop: () => {} };
  process.title = 'LoadToAgent Terminal Host';
  // Acquire the OS-owned cross-process lock before reading the session store or
  // probing tmux. A slow recovery can therefore never let a second daemon race
  // the same provider sessions or persistence file.
  const processLock = await acquireTerminalHostProcessLock(config.discoveryFile);
  let stopping = false;
  let stopPromise = null;
  let manager = null;
  let host = null;
  let bridge = null;
  const logFailure = (label, error) => {
    const logFile = path.join(path.dirname(config.discoveryFile), 'terminal-host.log');
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${label}: ${error.stack || error.message}\n`, 'utf8');
    } catch {}
  };
  const stop = () => {
    if (stopping) return stopPromise;
    stopping = true;
    if (bridge) bridge.dispose();
    if (host) host.dispose();
    stopPromise = (async () => {
      try {
        await Promise.resolve(manager?.dispose({ preserveSessions: true }));
        await processLock.release();
        setImmediate(() => process.exit(0));
        return { ok: true };
      } catch (error) {
        logFailure('shutdown', error);
        return { ok: false, error };
      }
    })();
    return stopPromise;
  };
  // Install signal handling before manager construction/recovery. Once the OS
  // lock exists, even a signal during slow tmux probing must wait for confirmed
  // PTY cleanup before the lock can disappear.
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    manager = new TerminalManager({ storeFile: config.storeFile });
    manager.recoverPersistedSessions();
    host = new TerminalHostServer({ manager, discoveryFile: config.discoveryFile, onShutdown: stop });
    bridge = new BridgeServer({ terminalManager: manager, home: config.bridgeHome, platform: process.platform });
    await host.start();
    if (stopping) return { manager, host, bridge, stop, processLock };
    try { await bridge.start(); } catch (error) {
      logFailure('bridge', error);
    }
    return { manager, host, bridge, stop, processLock };
  } catch (error) {
    if (bridge) bridge.dispose();
    if (host) host.dispose();
    let cleanupFailure = null;
    if (manager) {
      try {
        await Promise.resolve(manager.dispose({ preserveSessions: true }));
      } catch (cleanupError) {
        logFailure('startup-cleanup', cleanupError);
        cleanupFailure = cleanupError;
      }
    }
    if (cleanupFailure) {
      // A recovered PTY may still own descendants. Keep the OS lock and this
      // process alive instead of allowing a second daemon to race uncertain
      // cleanup. The original startup error remains available as context.
      const failure = new Error(`명령창 연결 프로그램 시작 실패 후 PTY 종료를 확인하지 못했습니다: ${cleanupFailure.message}`);
      failure.code = 'TERMINAL_HOST_STARTUP_CLEANUP_UNCONFIRMED';
      failure.cause = cleanupFailure;
      failure.startupError = error;
      throw failure;
    }
    try {
      await processLock.release();
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    } catch (lockError) {
      logFailure('startup-lock-release', lockError);
    }
    throw error;
  }
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

module.exports = { parseConfig, processExists, existingHealthyHost, run };
