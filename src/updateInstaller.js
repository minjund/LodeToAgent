'use strict';

const fs = require('fs');
const path = require('path');
const { spawn: spawnProcess } = require('child_process');

const WINDOWS_UPDATE_HELPER = `param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Stop'
$exitCode = -1
try {
  Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
  $installer = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
  $exitCode = $installer.ExitCode
} catch {
  $_ | Out-String | Set-Content -LiteralPath $LogPath -Encoding UTF8
} finally {
  try { "exitCode=$exitCode" | Add-Content -LiteralPath $LogPath -Encoding UTF8 } catch {}
  if ($exitCode -eq 0 -and (Test-Path -LiteralPath $AppPath)) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    try { Start-Process -FilePath $AppPath } catch {}
  } else {
    try { "updateFailed=true" | Add-Content -LiteralPath $LogPath -Encoding UTF8 } catch {}
  }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;

function isWithinDirectory(file, directory) {
  if (!file || !directory) return false;
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function canInstallSilently({ platform, installType, installerPath, downloadsDir }) {
  return platform === 'win32'
    && installType === 'desktop'
    && isWithinDirectory(installerPath, downloadsDir)
    && /^LoadToAgent-Setup-[0-9A-Za-z.-]+\.exe$/i.test(path.basename(installerPath));
}

function windowsPowerShell(environment = process.env) {
  const systemRoot = String(environment.SystemRoot || environment.WINDIR || 'C:\\Windows');
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function waitForProcessSpawn(child, timeoutMs = 5000) {
  if (!child || typeof child.once !== 'function' || typeof child.unref !== 'function') {
    return Promise.reject(new Error('업데이트 설치 프로세스를 시작하지 못했습니다.'));
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
    const timer = setTimeout(() => finish(new Error('업데이트 설치 프로세스 시작 확인 시간이 초과되었습니다.')), timeoutMs);
    child.once('spawn', () => finish());
    child.once('error', error => finish(error));
  });
}

async function launchDownloadedUpdate(options = {}) {
  const installerPath = String(options.installerPath || '');
  const downloadsDir = String(options.downloadsDir || '');
  if (!installerPath || !fs.existsSync(installerPath)) throw new Error('내려받은 설치 파일을 찾지 못했습니다. 다시 다운로드해 주세요.');

  if (!canInstallSilently({
    platform: String(options.platform || process.platform),
    installType: String(options.installType || ''),
    installerPath,
    downloadsDir,
  })) {
    if (!options.shell || typeof options.shell.openPath !== 'function') throw new Error('설치 파일을 열 수 없습니다.');
    const openError = await options.shell.openPath(installerPath);
    if (openError) throw new Error(openError);
    return { mode: 'manual' };
  }

  const appPath = String(options.appPath || '');
  const parentPid = Number(options.parentPid);
  if (!appPath || !fs.existsSync(appPath) || !Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error('업데이트 후 앱을 다시 시작할 정보를 준비하지 못했습니다.');
  }

  const helperPath = path.join(downloadsDir, 'install-update.ps1');
  const logPath = path.join(downloadsDir, 'install-update.log');
  await fs.promises.writeFile(helperPath, WINDOWS_UPDATE_HELPER, { encoding: 'utf8', mode: 0o600 });
  const spawn = options.spawn || spawnProcess;
  const child = spawn(windowsPowerShell(options.environment), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', helperPath,
    '-InstallerPath', installerPath,
    '-ParentPid', String(parentPid),
    '-AppPath', appPath,
    '-LogPath', logPath,
  ], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  await waitForProcessSpawn(child, Number(options.spawnTimeoutMs) || 5000);
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('업데이트 설치 프로세스를 시작하지 못했습니다.');
  child.unref();
  return { mode: 'automatic', helperPath, logPath };
}

module.exports = {
  WINDOWS_UPDATE_HELPER,
  canInstallSilently,
  isWithinDirectory,
  launchDownloadedUpdate,
  waitForProcessSpawn,
  windowsPowerShell,
};
