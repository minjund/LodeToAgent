'use strict';

const fs = require('fs');
const path = require('path');
const { TerminalManager, AGENT_PROVIDERS, normalizeLaunchOptions } = require('./terminalManager');
const { BridgeServer } = require('./bridgeServer');
const { TerminalHostServer, acquireTerminalHostProcessLock } = require('./terminalHost');
const { CodexAppServer } = require('./codexAppServer');

function isNativeCodexLaunch(value = {}, platform = process.platform) {
  return String(value?.type || '').toLowerCase() === 'agent'
    && String(value?.provider || '').toLowerCase() === 'codex'
    && !(platform === 'win32' && String(value.distro || '').trim());
}

function codexLaunchBackend(value = {}, platform = process.platform) {
  const requested = String(value.sessionBackend || value.backend || '').trim();
  let backend = requested === 'direct' || requested === 'managed-tmux'
    ? requested
    : (!value.transient && (platform !== 'win32' || String(value.distro || '').trim())
      ? 'managed-tmux'
      : 'direct');
  // normalizeLaunchOptions forces a signed conversation binding onto an
  // app-owned direct PTY even when the caller requested managed tmux.
  if (String(value.bridgeId || '').trim() && String(value.agentConnectionSignature || '').trim()) {
    backend = 'direct';
  }
  return backend;
}

function usesSharedCodexAppServer(value = {}, platform = process.platform) {
  return isNativeCodexLaunch(value, platform)
    && codexLaunchBackend(value, platform) === 'direct';
}

function codexCreatePreparationOptions(manager, value = {}, platform = process.platform) {
  if (!isNativeCodexLaunch(value, platform)) return value;
  const normalized = normalizeLaunchOptions(value, platform);
  if (normalized.sessionBackend !== 'managed-tmux'
    || typeof manager?.managedTmuxRuntime?.available !== 'function'
    || manager.managedTmuxRuntime.available(normalized)) return normalized;
  // TerminalManager uses this same failover when optional tmux is unavailable.
  // Prepare the app-server for the effective direct launch, without ever
  // injecting its host-scoped endpoint into a real managed-tmux process.
  return {
    ...normalized,
    sessionBackend: 'direct',
    tmuxSocket: '',
    managedTmuxSession: '',
  };
}

function sharedCodexAgentProviders(codexAppServer, platform = process.platform) {
  return {
    ...AGENT_PROVIDERS,
    codex: {
      ...AGENT_PROVIDERS.codex,
      argsFor: options => usesSharedCodexAppServer(options, platform)
        ? codexAppServer.remoteArguments()
        : [],
    },
  };
}

async function prepareCodexOperation(manager, codexAppServer, operation, args = [], platform = process.platform) {
  let options = null;
  if (operation === 'create') options = codexCreatePreparationOptions(manager, args[0] || {}, platform);
  else if (operation === 'restart') {
    options = manager?.sessions?.get?.(String(args[0] || ''))?.options
      || manager.get(args[0], false);
  }
  if (usesSharedCodexAppServer(options, platform)) await codexAppServer.ensureReady();
}

async function recoverPersistedSessionsWithCodexAppServer(
  manager,
  codexAppServer,
  options = {},
) {
  const platform = options.platform || process.platform;
  const onFailure = typeof options.onFailure === 'function' ? options.onFailure : () => {};
  const recoveryNeedsCodex = [...manager.sessions.values()].some(session => session.recoveryPending
    && usesSharedCodexAppServer(session.options, platform));
  if (recoveryNeedsCodex) {
    try {
      await codexAppServer.ensureReady();
    } catch (error) {
      // launchSpec remains fail-closed for each direct Codex recovery because
      // remoteArguments() still rejects while the server is unavailable. Do
      // not prevent unrelated providers and shells from recovering.
      try { onFailure(error); } catch {}
    }
  }
  return manager.recoverPersistedSessions();
}

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
  process.title = 'Whitebox Terminal Host';
  // Acquire the OS-owned cross-process lock before reading the session store or
  // probing tmux. A slow recovery can therefore never let a second daemon race
  // the same provider sessions or persistence file.
  const processLock = await acquireTerminalHostProcessLock(config.discoveryFile);
  let stopping = false;
  let stopPromise = null;
  let manager = null;
  let host = null;
  let bridge = null;
  let codexAppServer = null;
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
        await Promise.resolve(codexAppServer?.dispose());
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
    codexAppServer = new CodexAppServer({
      onDiagnostic: event => {
        if (event?.event === 'exit' && (event.error || Number(event.code))) {
          logFailure('codex-app-server-exit', event.error || new Error(`code=${event.code}, signal=${event.signal || 'none'}`));
        }
      },
    });
    manager = new TerminalManager({
      storeFile: config.storeFile,
      deferPersistedSessionReconciliation: true,
      agentProviders: sharedCodexAgentProviders(codexAppServer),
    });
    await recoverPersistedSessionsWithCodexAppServer(manager, codexAppServer, {
      onFailure: error => logFailure('codex-app-server-recovery', error),
    });
    host = new TerminalHostServer({
      manager,
      discoveryFile: config.discoveryFile,
      onShutdown: stop,
      beforeOperation: (operation, args) => prepareCodexOperation(manager, codexAppServer, operation, args),
      extraInfo: () => ({ codexAppServer: codexAppServer.currentInfo() }),
    });
    bridge = new BridgeServer({
      terminalManager: manager,
      home: config.bridgeHome,
      platform: process.platform,
      beforeRun: async message => {
        const launch = codexCreatePreparationOptions(manager, {
          type: 'agent',
          provider: message?.provider,
          args: Array.isArray(message?.args) ? message.args : [],
          cwd: message?.cwd || config.bridgeHome,
          distro: '',
        });
        if (usesSharedCodexAppServer(launch)) {
          await codexAppServer.ensureReady();
        }
      },
      extraInfo: () => ({ codexAppServer: codexAppServer.currentInfo() }),
    });
    const refreshCodexDiscovery = () => {
      try { host?.refreshDiscovery(); } catch (error) { logFailure('codex-host-discovery', error); }
      try { bridge?.refreshDiscovery(); } catch (error) { logFailure('codex-bridge-discovery', error); }
    };
    codexAppServer.on('ready', refreshCodexDiscovery);
    codexAppServer.on('exit', refreshCodexDiscovery);
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
    if (codexAppServer) {
      try {
        await codexAppServer.dispose();
      } catch (cleanupError) {
        logFailure('codex-app-server-startup-cleanup', cleanupError);
        cleanupFailure = cleanupFailure || cleanupError;
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

module.exports = {
  codexCreatePreparationOptions,
  codexLaunchBackend,
  isNativeCodexLaunch,
  parseConfig,
  prepareCodexOperation,
  recoverPersistedSessionsWithCodexAppServer,
  run,
  sharedCodexAgentProviders,
  usesSharedCodexAppServer,
};
