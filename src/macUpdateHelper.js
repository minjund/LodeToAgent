'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_COMMANDS = Object.freeze({
  hdiutil: '/usr/bin/hdiutil',
  ditto: '/usr/bin/ditto',
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
      else reject(new Error(`${path.basename(command)} 종료 코드: ${code == null ? signal : code}`));
    });
  });
}

async function waitForParentExit(parentPid, options = {}) {
  const pid = Number(parentPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('종료를 기다릴 앱 프로세스 정보가 올바르지 않습니다.');
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

async function removePath(targetPath, fileSystem = fs.promises) {
  if (!targetPath) return;
  await fileSystem.rm(targetPath, { recursive: true, force: true });
}

async function installMacUpdate(options = {}) {
  const dmgPath = String(options.dmgPath || '');
  const targetApp = String(options.targetApp || '');
  const logPath = String(options.logPath || '');
  const fileSystem = options.fileSystem || fs.promises;
  const run = options.run || runCommand;
  const wait = options.waitForParentExit || waitForParentExit;
  const commands = { ...DEFAULT_COMMANDS, ...(options.commands || {}) };
  const operationId = String(options.operationId || `${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
    .replace(/[^0-9A-Za-z-]/g, '') || String(process.pid);
  const targetParent = path.dirname(targetApp);
  const targetName = path.basename(targetApp);
  let mountPath = String(options.mountPath || '');
  if (!dmgPath || !targetApp || !logPath) throw new Error('macOS 업데이트에 필요한 경로가 비어 있습니다.');
  if (!await pathIsDirectory(targetApp, fileSystem)) throw new Error('현재 설치된 앱 번들을 찾지 못했습니다.');
  if (!mountPath) mountPath = await fileSystem.mkdtemp(path.join(os.tmpdir(), 'loadtoagent-update-'));
  const stagedApp = path.join(targetParent, `.${targetName}.update-${operationId}`);
  const backupApp = path.join(targetParent, `.${targetName}.backup-${operationId}`);
  let mounted = false;
  let parentExited = false;
  let oldAppMoved = false;
  let newAppMoved = false;

  await appendLog(logPath, `waiting parentPid=${Number(options.parentPid)}`, fileSystem);
  try {
    await wait(Number(options.parentPid));
    parentExited = true;
    await appendLog(logPath, 'parent exited', fileSystem);

    await removePath(stagedApp, fileSystem);
    await removePath(backupApp, fileSystem);
    await run(commands.hdiutil, ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPath]);
    mounted = true;

    const sourceApp = path.join(mountPath, 'LoadToAgent.app');
    if (!await pathIsDirectory(sourceApp, fileSystem)) throw new Error('DMG에서 LoadToAgent.app을 찾지 못했습니다.');
    await run(commands.ditto, [sourceApp, stagedApp]);
    if (!await pathIsDirectory(stagedApp, fileSystem)) throw new Error('새 앱을 설치 위치에 복사하지 못했습니다.');

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
    await run(commands.open, ['-n', targetApp]);
    await appendLog(logPath, 'update installed and relaunched', fileSystem);

    try {
      await removePath(backupApp, fileSystem);
    } catch (error) {
      await appendLog(logPath, `backup cleanup warning: ${error && error.message || error}`, fileSystem);
    }
    return { targetApp };
  } catch (error) {
    await appendLog(logPath, `update failed: ${error && error.stack || error}`, fileSystem);
    if (oldAppMoved) {
      try {
        if (newAppMoved) await removePath(targetApp, fileSystem);
        if (await pathIsDirectory(backupApp, fileSystem)) await fileSystem.rename(backupApp, targetApp);
        await appendLog(logPath, 'original app restored', fileSystem);
      } catch (rollbackError) {
        await appendLog(logPath, `rollback failed: ${rollbackError && rollbackError.stack || rollbackError}`, fileSystem);
      }
    }
    if (parentExited && await pathIsDirectory(targetApp, fileSystem)) {
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
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!/^--(?:dmg|target|parent-pid|log)$/.test(String(flag || '')) || value == null) {
      throw new Error('macOS 업데이트 헬퍼 인자가 올바르지 않습니다.');
    }
    values[flag.slice(2)] = value;
  }
  return {
    dmgPath: values.dmg,
    targetApp: values.target,
    parentPid: Number(values['parent-pid']),
    logPath: values.log,
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
  installMacUpdate,
  parseArguments,
  pathIsDirectory,
  runCommand,
  runCli,
  waitForParentExit,
};
