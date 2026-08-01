'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile: execFileCallback, spawn } = require('child_process');
const { promisify } = require('util');

const execFileProcess = promisify(execFileCallback);
const READY_PATH_ENV = 'LOADTOAGENT_UPDATE_READY_PATH';
const READY_TOKEN_ENV = 'LOADTOAGENT_UPDATE_READY_TOKEN';
const TOKEN_PATTERN = /^[0-9a-f]{48}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const DEFAULT_COMMANDS = Object.freeze({
  hdiutil: '/usr/bin/hdiutil',
  ditto: '/usr/bin/ditto',
  plutil: '/usr/bin/plutil',
  xattr: '/usr/bin/xattr',
  open: '/usr/bin/open',
});

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} 프로그램 실행에 실패했습니다.`));
    });
  });
}

function waitForProcessSpawn(child, timeoutMs = 5000) {
  if (!child || typeof child.once !== 'function') {
    return Promise.reject(new Error('업데이트된 앱을 시작하지 못했습니다.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error('업데이트된 앱을 시작하는 데 너무 오래 걸립니다.')),
      timeoutMs,
    );
    child.once('spawn', () => finish());
    child.once('error', error => finish(error));
  });
}

async function waitForParentExit(parentPid, options = {}) {
  const pid = Number(parentPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('종료를 기다릴 프로그램 정보가 올바르지 않습니다.');
  const processExists = options.processExists || (candidate => {
    try {
      process.kill(candidate, 0);
      return true;
    } catch (error) {
      if (error && error.code === 'ESRCH') return false;
      if (error && error.code === 'EPERM') return true;
      throw error;
    }
  });
  const pause = options.delay || delay;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60_000;
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 250;
  const startedAt = Date.now();
  while (processExists(pid)) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('기존 앱이 제한 시간 안에 종료되지 않았습니다.');
    await pause(pollMs);
  }
}

async function appendLog(logPath, message, fileSystem = fs.promises) {
  if (!logPath) return;
  try {
    await fileSystem.appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch (_logError) {
    // Logging must never prevent rollback or relaunch.
  }
}

async function pathIsDirectory(targetPath, fileSystem = fs.promises) {
  try {
    const stat = await fileSystem.lstat(targetPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (_missingPath) {
    return false;
  }
}

async function pathIsExecutableFile(targetPath, fileSystem = fs.promises) {
  try {
    const stat = await fileSystem.lstat(targetPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    await fileSystem.access(targetPath, fs.constants.X_OK);
    return true;
  } catch (_missingPath) {
    return false;
  }
}

async function removePath(targetPath, fileSystem = fs.promises) {
  if (!targetPath) return;
  await fileSystem.rm(targetPath, { recursive: true, force: true });
}

async function readBundleMetadata(appBundle, options = {}) {
  const execFile = options.execFile || execFileProcess;
  const plutil = String(options.plutil || DEFAULT_COMMANDS.plutil);
  const infoPath = path.join(appBundle, 'Contents', 'Info.plist');
  let parsed;
  try {
    const result = await execFile(plutil, ['-convert', 'json', '-o', '-', infoPath], {
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    parsed = JSON.parse(String(result && result.stdout || ''));
  } catch (_error) {
    throw new Error('새 앱의 버전 정보를 확인하지 못했습니다.');
  }
  const version = String(parsed && parsed.CFBundleShortVersionString || '').trim();
  const executable = String(parsed && parsed.CFBundleExecutable || '').trim();
  if (!VERSION_PATTERN.test(version)
    || !executable
    || executable === '.'
    || executable === '..'
    || path.basename(executable) !== executable) {
    throw new Error('새 앱의 버전 또는 실행 파일 정보가 올바르지 않습니다.');
  }
  return { version, executable };
}

async function writeHelperReady(readyPath, token, fileSystem = fs.promises) {
  const temporaryPath = `${readyPath}.${process.pid}.tmp`;
  await fileSystem.rm(temporaryPath, { force: true });
  await fileSystem.writeFile(temporaryPath, JSON.stringify({ helperPid: process.pid, token }), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fileSystem.rm(readyPath, { force: true });
  await fileSystem.rename(temporaryPath, readyPath);
}

function childHasExited(child) {
  return child && (child.exitCode != null || child.signalCode != null);
}

function validateRendererReadySignal(signal, options) {
  const rendererReadyAt = String(signal && signal.rendererReadyAt || '');
  let canonicalTimestamp = false;
  try {
    canonicalTimestamp = new Date(rendererReadyAt).toISOString() === rendererReadyAt;
  } catch (_invalidTimestamp) {
    canonicalTimestamp = false;
  }
  if (!signal
    || signal.token !== options.token
    || Number(signal.pid) !== options.pid
    || String(signal.version || '') !== options.version
    || !canonicalTimestamp) {
    throw new Error('업데이트된 앱의 준비 신호가 올바르지 않습니다.');
  }
  return signal;
}

async function waitForRendererReady(options = {}) {
  const readyPath = String(options.readyPath || '');
  const child = options.child;
  const fileSystem = options.fileSystem || fs.promises;
  const pause = options.delay || delay;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30_000;
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 200;
  const startedAt = Date.now();
  let exit = null;
  const onExit = (code, signal) => { exit = { code, signal }; };
  if (!child || typeof child.once !== 'function') throw new Error('업데이트된 앱의 실행 상태를 확인하지 못했습니다.');
  child.once('exit', onExit);
  try {
    while (true) {
      if (exit || childHasExited(child)) {
        const code = exit ? exit.code : child.exitCode;
        throw new Error(`업데이트된 앱이 준비되기 전에 종료되었습니다. (코드 ${code ?? '알 수 없음'})`);
      }
      try {
        const raw = await fileSystem.readFile(readyPath, 'utf8');
        const ready = validateRendererReadySignal(JSON.parse(raw), {
          token: options.token,
          pid: child.pid,
          version: options.version,
        });
        if (exit || childHasExited(child)) throw new Error('업데이트된 앱이 준비 신호 직후 종료되었습니다.');
        return ready;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          if (error instanceof SyntaxError) throw new Error('업데이트된 앱의 준비 신호가 올바르지 않습니다.');
          throw error;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error('업데이트된 앱이 제한 시간 안에 준비되지 않았습니다.');
      }
      await pause(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    }
  } finally {
    if (typeof child.removeListener === 'function') child.removeListener('exit', onExit);
  }
}

async function terminateApplication(child, options = {}) {
  if (!child) return;
  const pause = options.delay || delay;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5_000;
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 100;
  const signalProcess = options.signalProcess || process.kill;
  const pid = Number(child.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('준비되지 않은 새 앱의 PID가 올바르지 않습니다.');
  const groupExists = () => {
    try {
      signalProcess(-pid, 0);
      return true;
    } catch (error) {
      if (error && error.code === 'ESRCH') return false;
      if (error && error.code === 'EPERM') return true;
      throw error;
    }
  };
  let controlsGroup = groupExists();
  if (!controlsGroup && childHasExited(child)) return;
  const sendSignal = signal => {
    try {
      signalProcess(-pid, signal);
      controlsGroup = true;
      return;
    } catch (error) {
      if (!error || error.code !== 'ESRCH') throw error;
    }
    controlsGroup = false;
    if (!childHasExited(child)) {
      if (typeof child.kill === 'function') child.kill(signal);
      else signalProcess(pid, signal);
    }
  };
  const treeIsAlive = () => controlsGroup ? groupExists() : !childHasExited(child);
  sendSignal('SIGTERM');
  const startedAt = Date.now();
  while (treeIsAlive() && Date.now() - startedAt < timeoutMs) await pause(pollMs);
  if (!treeIsAlive()) return;
  sendSignal('SIGKILL');
  const killedAt = Date.now();
  while (treeIsAlive() && Date.now() - killedAt < 1_000) await pause(pollMs);
  if (treeIsAlive()) throw new Error('준비되지 않은 새 앱의 프로세스 그룹을 종료하지 못했습니다.');
}

async function installMacUpdate(options = {}) {
  const dmgPath = String(options.dmgPath || '');
  const targetApp = String(options.targetApp || '');
  const logPath = String(options.logPath || '');
  const expectedVersion = String(options.expectedVersion || '').trim();
  const readyPath = String(options.readyPath || '');
  const rendererReadyPath = String(options.rendererReadyPath || '');
  const rendererReadyToken = String(options.rendererReadyToken || '').trim().toLowerCase();
  const fileSystem = options.fileSystem || fs.promises;
  const run = options.run || runCommand;
  const wait = options.waitForParentExit || waitForParentExit;
  const inspectBundle = options.readBundleMetadata || readBundleMetadata;
  const spawnApplication = options.spawnApplication || spawn;
  const waitForReady = options.waitForRendererReady || waitForRendererReady;
  const stopApplication = options.terminateApplication || terminateApplication;
  const commands = { ...DEFAULT_COMMANDS, ...(options.commands || {}) };
  const operationId = String(options.operationId || `${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
    .replace(/[^0-9A-Za-z-]/g, '') || String(process.pid);
  const targetParent = path.dirname(targetApp);
  const targetName = path.basename(targetApp);
  let mountPath = String(options.mountPath || '');
  if (!dmgPath || !targetApp || !logPath || !VERSION_PATTERN.test(expectedVersion)) {
    throw new Error('macOS 업데이트에 필요한 파일 주소나 버전이 올바르지 않습니다.');
  }
  if (!path.isAbsolute(readyPath)
    || path.basename(readyPath) !== `install-update-macos-ready-${rendererReadyToken}.json`
    || !path.isAbsolute(rendererReadyPath)
    || path.dirname(rendererReadyPath) !== path.dirname(readyPath)
    || path.basename(rendererReadyPath) !== `install-renderer-ready-${rendererReadyToken}.json`
    || !TOKEN_PATTERN.test(rendererReadyToken)) {
    throw new Error('macOS 업데이트 준비 신호 정보가 올바르지 않습니다.');
  }
  if (!await pathIsDirectory(targetApp, fileSystem)) throw new Error('현재 설치된 앱 번들을 찾지 못했습니다.');
  if (!mountPath) mountPath = await fileSystem.mkdtemp(path.join(os.tmpdir(), 'loadtoagent-update-'));
  const stagedApp = path.join(targetParent, `.${targetName}.update-${operationId}`);
  const backupApp = path.join(targetParent, `.${targetName}.backup-${operationId}`);
  const failedApp = path.join(targetParent, `.${targetName}.failed-${operationId}`);
  let mounted = false;
  let parentExited = false;
  let oldAppMoved = false;
  let newAppMoved = false;
  let launchedApp = null;
  let committed = false;
  let originalRestored = false;

  try {
    await removePath(rendererReadyPath, fileSystem);
    await writeHelperReady(readyPath, rendererReadyToken, fileSystem);
    await appendLog(logPath, `waiting parentPid=${Number(options.parentPid)}`, fileSystem);
    await wait(Number(options.parentPid));
    parentExited = true;
    await appendLog(logPath, 'parent exited', fileSystem);

    await removePath(stagedApp, fileSystem);
    await removePath(backupApp, fileSystem);
    await removePath(failedApp, fileSystem);
    await run(commands.hdiutil, ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPath]);
    mounted = true;

    const sourceApp = path.join(mountPath, 'LoadToAgent.app');
    if (!await pathIsDirectory(sourceApp, fileSystem)) throw new Error('DMG에서 LoadToAgent.app을 찾지 못했습니다.');
    await run(commands.ditto, [sourceApp, stagedApp]);
    if (!await pathIsDirectory(stagedApp, fileSystem)) throw new Error('새 앱을 설치 위치에 복사하지 못했습니다.');
    if (options.allowUnsignedMacUpdates === true) {
      await run(commands.xattr, ['-cr', stagedApp]);
      await appendLog(logPath, 'internal unsigned update quarantine removed', fileSystem);
    }
    const metadata = await inspectBundle(stagedApp, {
      execFile: options.execFile,
      plutil: commands.plutil,
    });
    if (!metadata || metadata.version !== expectedVersion) {
      throw new Error(`새 앱 버전이 예상과 다릅니다. (예상 ${expectedVersion}, 확인 ${metadata && metadata.version || '알 수 없음'})`);
    }
    const executableName = String(metadata.executable || '');
    if (!executableName
      || executableName === '.'
      || executableName === '..'
      || path.basename(executableName) !== executableName) {
      throw new Error('새 앱의 실행 파일 정보가 올바르지 않습니다.');
    }
    const stagedExecutable = path.join(stagedApp, 'Contents', 'MacOS', executableName);
    if (!await pathIsExecutableFile(stagedExecutable, fileSystem)) {
      throw new Error('새 앱의 실행 파일을 찾지 못했거나 실행할 수 없습니다.');
    }

    try {
      await run(commands.hdiutil, ['detach', mountPath]);
      mounted = false;
    } catch (error) {
      await appendLog(logPath, `detach warning: ${error && error.message || error}`, fileSystem);
    }

    await fileSystem.rename(targetApp, backupApp);
    oldAppMoved = true;
    await fileSystem.rename(stagedApp, targetApp);
    newAppMoved = true;
    const targetExecutable = path.join(targetApp, 'Contents', 'MacOS', executableName);
    const applicationEnvironment = { ...process.env, ...(options.environment || {}) };
    delete applicationEnvironment.ELECTRON_RUN_AS_NODE;
    applicationEnvironment[READY_PATH_ENV] = rendererReadyPath;
    applicationEnvironment[READY_TOKEN_ENV] = rendererReadyToken;
    launchedApp = spawnApplication(targetExecutable, [], {
      cwd: path.dirname(targetExecutable),
      detached: true,
      stdio: 'ignore',
      env: applicationEnvironment,
    });
    await waitForProcessSpawn(launchedApp, Number(options.spawnTimeoutMs) || 5_000);
    if (!Number.isSafeInteger(Number(launchedApp.pid)) || Number(launchedApp.pid) <= 0) {
      throw new Error('업데이트된 앱의 실행 정보를 확인하지 못했습니다.');
    }
    const readySignal = await waitForReady({
      readyPath: rendererReadyPath,
      token: rendererReadyToken,
      version: expectedVersion,
      child: launchedApp,
      fileSystem,
      delay: options.delay,
      timeoutMs: Number(options.readinessTimeoutMs) || 30_000,
      pollMs: Number(options.readinessPollMs) || 200,
    });
    committed = true;
    try { launchedApp.unref(); } catch (_unrefError) {}
    await appendLog(
      logPath,
      `update installed and renderer ready;pid=${readySignal.pid};version=${readySignal.version};rendererReadyAt=${readySignal.rendererReadyAt}`,
      fileSystem,
    );

    try {
      await removePath(backupApp, fileSystem);
    } catch (error) {
      await appendLog(logPath, `backup cleanup warning: ${error && error.message || error}`, fileSystem);
    }
    return { targetApp, version: expectedVersion, pid: Number(readySignal.pid) };
  } catch (error) {
    await appendLog(logPath, `update failed: ${error && error.stack || error}`, fileSystem);
    let launchedAppStopped = true;
    if (!committed && launchedApp) {
      try {
        await stopApplication(launchedApp, {
          delay: options.delay,
          signalProcess: options.signalProcess,
          timeoutMs: Number(options.terminationTimeoutMs) || 5_000,
          pollMs: Number(options.terminationPollMs) || 100,
        });
        await appendLog(logPath, `unready updated app stopped;pid=${Number(launchedApp.pid)}`, fileSystem);
      } catch (stopError) {
        launchedAppStopped = false;
        await appendLog(logPath, `updated app stop failed: ${stopError && stopError.stack || stopError}`, fileSystem);
      }
    }
    if (!committed && oldAppMoved && launchedAppStopped) {
      try {
        if (!await pathIsDirectory(backupApp, fileSystem)) throw new Error('원본 앱 백업을 찾지 못했습니다.');
        let failedAppMoved = false;
        if (newAppMoved) {
          await fileSystem.rename(targetApp, failedApp);
          failedAppMoved = true;
        }
        try {
          await fileSystem.rename(backupApp, targetApp);
        } catch (restoreError) {
          if (failedAppMoved) {
            try {
              await fileSystem.rename(failedApp, targetApp);
            } catch (fallbackError) {
              restoreError.message = `${restoreError.message}; 새 앱 복원도 실패함: ${fallbackError.message}; failed=${failedApp}`;
            }
          }
          throw restoreError;
        }
        originalRestored = true;
        await appendLog(logPath, 'original app restored', fileSystem);
        if (failedAppMoved) {
          try {
            await removePath(failedApp, fileSystem);
          } catch (cleanupError) {
            await appendLog(logPath, `failed app cleanup warning;path=${failedApp}: ${cleanupError.message}`, fileSystem);
          }
        }
      } catch (rollbackError) {
        await appendLog(
          logPath,
          `rollback failed;backup=${backupApp}: ${rollbackError && rollbackError.stack || rollbackError}`,
          fileSystem,
        );
      }
    }
    if (parentExited
      && (!oldAppMoved || originalRestored)
      && await pathIsDirectory(targetApp, fileSystem)) {
      try {
        await run(commands.open, ['-n', targetApp]);
        await appendLog(logPath, 'original app relaunched', fileSystem);
      } catch (relaunchError) {
        await appendLog(logPath, `relaunch failed: ${relaunchError && relaunchError.stack || relaunchError}`, fileSystem);
      }
    }
    throw error;
  } finally {
    if (mounted) {
      try {
        await run(commands.hdiutil, ['detach', mountPath, '-force']);
      } catch (error) {
        await appendLog(logPath, `forced detach failed: ${error && error.message || error}`, fileSystem);
      }
    }
    try { await removePath(stagedApp, fileSystem); } catch (_cleanupError) {}
    try { await removePath(mountPath, fileSystem); } catch (_cleanupError) {}
    try { await removePath(rendererReadyPath, fileSystem); } catch (_cleanupError) {}
    try { await removePath(readyPath, fileSystem); } catch (_cleanupError) {}
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!/^--(?:dmg|target|parent-pid|expected-version|log|ready|renderer-ready-path|renderer-ready-token|allow-unsigned-mac-updates)$/.test(String(flag || '')) || value == null) {
      throw new Error('macOS 업데이트 헬퍼 인자가 올바르지 않습니다.');
    }
    values[flag.slice(2)] = value;
  }
  if (values['allow-unsigned-mac-updates'] != null
    && !/^(?:true|false)$/.test(values['allow-unsigned-mac-updates'])) {
    throw new Error('macOS 내부 업데이트 허용 값이 올바르지 않습니다.');
  }
  return {
    dmgPath: values.dmg,
    targetApp: values.target,
    parentPid: Number(values['parent-pid']),
    expectedVersion: values['expected-version'],
    logPath: values.log,
    readyPath: values.ready,
    rendererReadyPath: values['renderer-ready-path'],
    rendererReadyToken: values['renderer-ready-token'],
    allowUnsignedMacUpdates: values['allow-unsigned-mac-updates'] === 'true',
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    await installMacUpdate(options);
  } catch (error) {
    await appendLog(options.logPath, `helper stopped: ${error && error.stack || error}`);
    throw error;
  }
}

if (require.main === module) {
  runCli().catch(() => { process.exitCode = 1; });
}

module.exports = {
  DEFAULT_COMMANDS,
  appendLog,
  childHasExited,
  installMacUpdate,
  parseArguments,
  pathIsDirectory,
  pathIsExecutableFile,
  readBundleMetadata,
  runCommand,
  runCli,
  terminateApplication,
  validateRendererReadySignal,
  waitForParentExit,
  waitForProcessSpawn,
  waitForRendererReady,
  writeHelperReady,
};
