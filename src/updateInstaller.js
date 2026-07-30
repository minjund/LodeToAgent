'use strict';

const fs = require('fs');
const path = require('path');
const { execFile: execFileCallback, spawn: spawnProcess } = require('child_process');
const { promisify } = require('util');

const execFileProcess = promisify(execFileCallback);

const MAC_UPDATE_HELPER_SOURCE = path.join(__dirname, 'macUpdateHelper.js');

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
  if ($exitCode -ne 0) {
    try { "updateFailed=true" | Add-Content -LiteralPath $LogPath -Encoding UTF8 } catch {}
  }
  if (Test-Path -LiteralPath $AppPath) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    try { Start-Process -FilePath $AppPath } catch {}
  }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;

function isWithinDirectory(file, directory) {
  if (!file || !directory) return false;
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function macAppBundlePath(executablePath) {
  const normalized = path.posix.normalize(String(executablePath || '').replace(/\\/g, '/'));
  const match = normalized.match(/^((?:\/|[A-Za-z]:\/).+?\.app)\/Contents\/MacOS\/[^/]+$/i);
  return match ? match[1] : '';
}

function automaticInstallPlatform({ platform, installType, installerPath, downloadsDir, appPath }) {
  if (installType !== 'desktop' || !isWithinDirectory(installerPath, downloadsDir)) return '';
  const fileName = path.basename(installerPath);
  if (platform === 'win32' && /^LoadToAgent-Setup-[0-9A-Za-z.-]+\.exe$/i.test(fileName)) return 'win32';
  if (platform === 'darwin' && /^LoadToAgent-[0-9A-Za-z.-]+-(?:arm64|x64)\.dmg$/i.test(fileName)) {
    const appBundle = macAppBundlePath(appPath);
    if (appBundle && appBundle !== '/Volumes' && !appBundle.startsWith('/Volumes/')) return 'darwin';
  }
  return '';
}

function canInstallSilently(options) {
  return Boolean(automaticInstallPlatform(options || {}));
}

function windowsPowerShell(environment = process.env) {
  const systemRoot = String(environment.SystemRoot || environment.WINDIR || 'C:\\Windows');
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function waitForProcessSpawn(child, timeoutMs = 5000) {
  if (!child || typeof child.once !== 'function' || typeof child.unref !== 'function') {
    return Promise.reject(new Error('업데이트 설치 프로그램을 시작하지 못했습니다.'));
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
    const timer = setTimeout(() => finish(new Error('업데이트 설치 프로그램이 시작되는 데 너무 오래 걸립니다.')), timeoutMs);
    child.once('spawn', () => finish());
    child.once('error', error => finish(error));
  });
}

async function verifyDownloadedInstaller(options = {}) {
  const installerPath = String(options.installerPath || '');
  const platform = String(options.platform || process.platform);
  const execFile = options.execFile || execFileProcess;
  if (!installerPath || !fs.existsSync(installerPath)) throw new Error('안전성을 확인할 설치 파일을 찾지 못했습니다.');
  if (platform === 'win32') {
    const systemRoot = String(options.environment?.SystemRoot || options.environment?.WINDIR || process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows');
    const windowsModulePath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
    const script = [
      'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop',
      '$signature = Get-AuthenticodeSignature -LiteralPath $env:LOADTOAGENT_VERIFY_PATH',
      "if ($signature.Status -eq 'Valid') { Write-Output 'Valid'; exit 0 }",
      "if (($env:LOADTOAGENT_ALLOW_UNSIGNED_WINDOWS -eq 'true') -and ($signature.Status -eq 'NotSigned')) { Write-Output 'NotSigned'; exit 0 }",
      "if ($signature.Status -ne 'Valid') { throw ('Invalid Authenticode signature: ' + $signature.Status) }",
    ].join('; ');
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const result = await execFile(windowsPowerShell(options.environment), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedScript,
    ], {
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 256 * 1024,
      env: {
        ...process.env,
        ...(options.environment || {}),
        PSModulePath: windowsModulePath,
        LOADTOAGENT_VERIFY_PATH: installerPath,
        LOADTOAGENT_ALLOW_UNSIGNED_WINDOWS: String(options.allowUnsignedWindowsUpdates === true),
      },
    });
    const unsignedAllowed = String(result && result.stdout || '').trim() === 'NotSigned';
    return { platform, verified: !unsignedAllowed, unsignedAllowed };
  }
  if (platform === 'darwin') {
    try {
      await execFile('/usr/sbin/spctl', [
        '--assess',
        '--type', 'open',
        '--context', 'context:primary-signature',
        '--verbose=2',
        installerPath,
      ], { timeout: 20_000, maxBuffer: 256 * 1024 });
      return { platform, verified: true, unsignedAllowed: false };
    } catch (error) {
      if (!options.allowUnsignedMacUpdates) throw error;
      return { platform, verified: false, unsignedAllowed: true };
    }
  }
  throw new Error('이 운영체제에서는 업데이트 설치 파일의 안전성을 확인할 수 없습니다.');
}

async function launchDownloadedUpdate(options = {}) {
  const installerPath = String(options.installerPath || '');
  const downloadsDir = String(options.downloadsDir || '');
  if (!installerPath || !fs.existsSync(installerPath)) throw new Error('받은 설치 파일을 찾지 못했습니다. 다시 받아 주세요.');

  const platform = String(options.platform || process.platform);
  const verifyInstaller = options.verifyInstaller || verifyDownloadedInstaller;
  await verifyInstaller({
    installerPath,
    platform,
    environment: options.environment,
    execFile: options.execFile,
    allowUnsignedWindowsUpdates: options.allowUnsignedWindowsUpdates === true,
    allowUnsignedMacUpdates: options.allowUnsignedMacUpdates === true,
  });
  const automaticPlatform = automaticInstallPlatform({
    platform,
    installType: String(options.installType || ''),
    installerPath,
    downloadsDir,
    appPath: String(options.appPath || ''),
  });
  if (!automaticPlatform) {
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

  const spawn = options.spawn || spawnProcess;
  if (automaticPlatform === 'darwin') {
    const targetApp = macAppBundlePath(appPath);
    if (!targetApp || !fs.existsSync(targetApp)) throw new Error('현재 설치된 macOS 앱을 찾지 못했습니다.');
    const helperPath = path.join(downloadsDir, 'install-update-macos.js');
    const logPath = path.join(downloadsDir, 'install-update.log');
    const helperSource = await fs.promises.readFile(MAC_UPDATE_HELPER_SOURCE, 'utf8');
    await fs.promises.writeFile(helperPath, helperSource, { encoding: 'utf8', mode: 0o700 });
    const environment = { ...process.env, ...(options.environment || {}), ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(appPath, [
      helperPath,
      '--dmg', installerPath,
      '--target', targetApp,
      '--parent-pid', String(parentPid),
      '--log', logPath,
      '--allow-unsigned-mac-updates', String(options.allowUnsignedMacUpdates === true),
    ], {
      detached: true,
      stdio: 'ignore',
      env: environment,
    });
    await waitForProcessSpawn(child, Number(options.spawnTimeoutMs) || 5000);
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('업데이트 설치 프로그램을 시작하지 못했습니다.');
    child.unref();
    return { mode: 'automatic', helperPath, logPath, targetApp };
  }

  const helperPath = path.join(downloadsDir, 'install-update.ps1');
  const logPath = path.join(downloadsDir, 'install-update.log');
  await fs.promises.writeFile(helperPath, WINDOWS_UPDATE_HELPER, { encoding: 'utf8', mode: 0o600 });
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
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('업데이트 설치 프로그램을 시작하지 못했습니다.');
  child.unref();
  return { mode: 'automatic', helperPath, logPath };
}

module.exports = {
  MAC_UPDATE_HELPER_SOURCE,
  WINDOWS_UPDATE_HELPER,
  automaticInstallPlatform,
  canInstallSilently,
  isWithinDirectory,
  launchDownloadedUpdate,
  macAppBundlePath,
  waitForProcessSpawn,
  verifyDownloadedInstaller,
  windowsPowerShell,
};
