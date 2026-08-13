'use strict';

const path = require('path');
const { spawn } = require('child_process');

const GUARD_READY = 'whitebox-interim-profile-guard-ready';
const GUARD_RELEASE = 'whitebox-interim-profile-guard-release';
const GUARD_ACTIVATE = 'whitebox-interim-profile-guard-activate';

function samePath(left, right, platform = process.platform) {
  const normalize = value => {
    const resolved = path.resolve(String(value || ''));
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function acquireInterimProfileGuard(options = {}) {
  const currentPath = path.resolve(String(options.currentPath || ''));
  const runtimePath = path.resolve(String(options.runtimePath || ''));
  if (!currentPath || !runtimePath || samePath(currentPath, runtimePath, options.platform)) {
    return Promise.resolve({ acquired: true, skipped: true, release: async () => {} });
  }
  const executable = String(options.executable || process.execPath);
  const helper = path.resolve(String(options.helper || ''));
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 8_000);
  const childEnv = {
    ...process.env,
    WHITEBOX_INTERIM_PROFILE_GUARD: '1',
    WHITEBOX_INTERIM_PROFILE_PATH: currentPath,
  };
  // Electron's CLI wrapper can leave this set in the parent process. A guard
  // launched with it would run as plain Node, where require('electron').app is
  // unavailable and no ProcessSingleton can be acquired.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    let readySettled = false;
    let acquired = false;
    let released = false;
    let exited = false;
    let lostNotified = false;
    let timer = null;
    let exitResult = null;
    let resolveExit;
    let stderr = '';
    const exitPromise = new Promise(resolveExitPromise => { resolveExit = resolveExitPromise; });
    const child = spawn(executable, [helper, currentPath], {
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      env: childEnv,
    });
    const exitDescription = (code, signal) => `Interim Whitebox profile guard exited (${code ?? 'unknown'}${signal ? `, ${signal}` : ''})${stderr ? `: ${stderr.trim()}` : ''}`;
    const notifyLost = error => {
      if (released || lostNotified || !acquired) return;
      lostNotified = true;
      try { options.onLost?.(error); } catch {}
    };
    const settleReady = (error, value) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(timer);
      if (error) {
        released = true;
        try { child.kill(); } catch {}
        reject(error);
      } else resolve(value);
    };
    const waitForExit = timeout => {
      if (exited) return Promise.resolve(true);
      return new Promise(resolveWait => {
        const waitTimer = setTimeout(() => resolveWait(false), timeout);
        exitPromise.then(() => {
          clearTimeout(waitTimer);
          resolveWait(true);
        });
      });
    };
    const release = async () => {
      if (released) {
        if (!exited) await waitForExit(1_000);
        return exitResult;
      }
      released = true;
      if (!exited && child.connected) {
        await new Promise(resolveSend => {
          let resolved = false;
          const done = () => {
            if (resolved) return;
            resolved = true;
            resolveSend();
          };
          const sendTimer = setTimeout(done, 250);
          if (typeof sendTimer.unref === 'function') sendTimer.unref();
          try {
            child.send({ type: GUARD_RELEASE }, () => {
              clearTimeout(sendTimer);
              done();
            });
          } catch {
            clearTimeout(sendTimer);
            done();
          }
        });
      }
      if (!exited) {
        const stopped = await waitForExit(1_000);
        if (!stopped) {
          try { child.kill(); } catch {}
          await waitForExit(500);
        }
      }
      return exitResult;
    };
    child.on('error', error => {
      if (!readySettled) settleReady(error);
      else notifyLost(error);
    });
    child.on('exit', (code, signal) => {
      exited = true;
      exitResult = { code, signal };
      resolveExit(exitResult);
      const error = new Error(exitDescription(code, signal));
      if (!readySettled) settleReady(error);
      else notifyLost(error);
    });
    child.on('message', message => {
      if (message?.type === GUARD_ACTIVATE) {
        try { options.onActivate?.(message); } catch {}
        return;
      }
      if (message?.type !== GUARD_READY) return;
      if (message.acquired !== true) {
        settleReady(null, { acquired: false, skipped: false, release: async () => {} });
        return;
      }
      acquired = true;
      settleReady(null, {
        acquired: true,
        skipped: false,
        pid: child.pid,
        release,
      });
    });
    child.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    timer = setTimeout(() => settleReady(new Error('Interim Whitebox profile guard timed out')), timeoutMs);
  });
}

module.exports = {
  GUARD_ACTIVATE,
  GUARD_READY,
  GUARD_RELEASE,
  acquireInterimProfileGuard,
  samePath,
};
