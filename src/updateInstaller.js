'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile: execFileCallback, spawn: spawnProcess } = require('child_process');
const { promisify } = require('util');
const { reportRecoverableError } = require('./diagnostics');

const execFileProcess = promisify(execFileCallback);

const MAC_UPDATE_HELPER_SOURCE = path.join(__dirname, 'macUpdateHelper.js');

const WINDOWS_UPDATE_HELPER = `param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$RendererReadyPath,
  [Parameter(Mandatory = $true)][string]$RendererReadyToken
)

$ErrorActionPreference = 'Stop'
$exitCode = -1
$launchPath = ''

function Write-UpdateLog([string]$Message) {
  try { $Message | Add-Content -LiteralPath $LogPath -Encoding UTF8 } catch {}
}

function Add-LaunchCandidate([System.Collections.Generic.List[string]]$Candidates, [string]$Candidate) {
  if ([string]::IsNullOrWhiteSpace($Candidate)) { return }
  $normalized = $Candidate.Trim()
  if ($normalized.EndsWith(',0')) { $normalized = $normalized.Substring(0, $normalized.Length - 2) }
  $normalized = $normalized.Trim().Trim('"')
  if ((Test-Path -LiteralPath $normalized -PathType Leaf) -and -not $Candidates.Contains($normalized)) {
    $Candidates.Add($normalized)
  }
}

function Executable-Version([string]$Candidate) {
  try {
    $info = (Get-Item -LiteralPath $Candidate).VersionInfo
    foreach ($value in @($info.ProductVersion, $info.FileVersion)) {
      if ([string]$value -match '[0-9]+\\.[0-9]+\\.[0-9]+') { return $Matches[0] }
    }
  } catch {}
  return ''
}

function App-Processes([string]$ExecutablePath) {
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) -and [string]$_.ExecutablePath -ieq $ExecutablePath })
  } catch {
    Write-UpdateLog ('processLookupError=' + $_.Exception.Message)
    return @()
  }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class LoadToAgentWindow {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

function Renderer-IsReady([string]$SignalPath, [string]$Token, [int]$TargetPid, [string]$Version) {
  try {
    if (-not (Test-Path -LiteralPath $SignalPath -PathType Leaf)) { return $false }
    $signal = Get-Content -LiteralPath $SignalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return ([string]$signal.token -eq $Token -and [int]$signal.pid -eq $TargetPid -and [string]$signal.version -eq $Version -and -not [string]::IsNullOrWhiteSpace([string]$signal.rendererReadyAt))
  } catch {
    return $false
  }
}

function Restore-AppWindow([int]$TargetPid) {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    if ($process.MainWindowHandle -ne 0) {
      [void][LoadToAgentWindow]::ShowWindowAsync($process.MainWindowHandle, 9)
      [void][LoadToAgentWindow]::SetForegroundWindow($process.MainWindowHandle)
      Start-Sleep -Milliseconds 250
      Write-UpdateLog ('windowRestored=true;pid=' + $TargetPid + ';handle=' + $process.MainWindowHandle)
      return $true
    }
    Start-Sleep -Milliseconds 100
  }
  Write-UpdateLog ('windowRestoreFailed=true;pid=' + $TargetPid)
  return $false
}

function Stop-AppProcesses([string]$ExecutablePath, [string]$Reason) {
  foreach ($process in (App-Processes $ExecutablePath)) {
    Write-UpdateLog ($Reason + '=' + $process.ProcessId)
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Find-InstalledApp([string]$OriginalPath, [string]$Version) {
  $candidates = [System.Collections.Generic.List[string]]::new()
  Add-LaunchCandidate $candidates $OriginalPath
  Add-LaunchCandidate $candidates (Join-Path $env:LOCALAPPDATA 'Programs\\LoadToAgent\\LoadToAgent.exe')

  foreach ($root in @(
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
  )) {
    try {
      Get-ItemProperty $root -ErrorAction SilentlyContinue |
        Where-Object { [string]$_.DisplayName -like 'LoadToAgent*' } |
        ForEach-Object {
          Add-LaunchCandidate $candidates ([string]$_.DisplayIcon)
          if (-not [string]::IsNullOrWhiteSpace([string]$_.InstallLocation)) {
            Add-LaunchCandidate $candidates (Join-Path ([string]$_.InstallLocation) 'LoadToAgent.exe')
          }
          if ([string]$_.UninstallString -match '^"?(.+?\\\\)Uninstall LoadToAgent\\.exe') {
            Add-LaunchCandidate $candidates (Join-Path $Matches[1] 'LoadToAgent.exe')
          }
        }
    } catch {
      Write-UpdateLog ('registryLookupError=' + $_.Exception.Message)
    }
  }

  foreach ($candidate in $candidates) {
    $candidateVersion = Executable-Version $candidate
    Write-UpdateLog ('candidate=' + $candidate + ';version=' + $candidateVersion)
    if ($candidateVersion -eq $Version) { return $candidate }
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return ''
}

try {
  $readyTemporary = $ReadyPath + '.' + $PID + '.tmp'
  @{ helperPid = $PID; token = $RendererReadyToken } | ConvertTo-Json -Compress | Set-Content -LiteralPath $readyTemporary -Encoding UTF8
  Move-Item -LiteralPath $readyTemporary -Destination $ReadyPath -Force
} catch {
  Remove-Item -LiteralPath $readyTemporary -Force -ErrorAction SilentlyContinue
  Write-UpdateLog ('readySignalError=' + $_.Exception.Message)
  exit 41
}

try {
  Write-UpdateLog ('helperStarted=true;parentPid=' + $ParentPid + ';expectedVersion=' + $ExpectedVersion)
  for ($attempt = 0; $attempt -lt 240; $attempt++) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    throw '기존 앱이 60초 안에 종료되지 않아 업데이트를 중단했습니다.'
  }

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $remaining = App-Processes $AppPath
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  }
  Stop-AppProcesses $AppPath 'stoppingOrphanProcess'

  $installer = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
  $exitCode = $installer.ExitCode
  Write-UpdateLog ('exitCode=' + $exitCode)
  if ($exitCode -eq 0) {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      $launchPath = Find-InstalledApp $AppPath $ExpectedVersion
      if (-not [string]::IsNullOrWhiteSpace($launchPath) -and (Executable-Version $launchPath) -eq $ExpectedVersion) { break }
      Start-Sleep -Milliseconds 500
    }
  }
} catch {
  Write-UpdateLog ('installError=' + $_.Exception.Message)
} finally {
  if ($exitCode -ne 0) {
    Write-UpdateLog 'updateFailed=true'
  }
  if ([string]::IsNullOrWhiteSpace($launchPath)) {
    $launchPath = Find-InstalledApp $AppPath $ExpectedVersion
  }
  if (-not [string]::IsNullOrWhiteSpace($launchPath)) {
    $installedVersion = Executable-Version $launchPath
    Write-UpdateLog ('relaunchPath=' + $launchPath + ';installedVersion=' + $installedVersion + ';expectedVersion=' + $ExpectedVersion)
    if ($exitCode -eq 0 -and $installedVersion -ne $ExpectedVersion) {
      Write-UpdateLog 'versionMismatch=true'
    }
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    try {
      $verifiedUpdatedApp = $exitCode -eq 0 -and $installedVersion -eq $ExpectedVersion
      if ($verifiedUpdatedApp) {
        $relaunchReady = $false
        for ($attempt = 1; $attempt -le 3; $attempt++) {
          Remove-Item -LiteralPath $RendererReadyPath -Force -ErrorAction SilentlyContinue
          $env:LOADTOAGENT_UPDATE_READY_PATH = $RendererReadyPath
          $env:LOADTOAGENT_UPDATE_READY_TOKEN = $RendererReadyToken
          $relaunched = Start-Process -FilePath $launchPath -WorkingDirectory (Split-Path -Parent $launchPath) -PassThru
          Write-UpdateLog ('relaunchStarted=true;attempt=' + $attempt + ';pid=' + $relaunched.Id)
          for ($readyAttempt = 0; $readyAttempt -lt 150; $readyAttempt++) {
            Start-Sleep -Milliseconds 200
            $relaunched.Refresh()
            if ($relaunched.HasExited) {
              Write-UpdateLog ('relaunchExited=true;attempt=' + $attempt + ';exitCode=' + $relaunched.ExitCode)
              break
            }
            if (Renderer-IsReady $RendererReadyPath $RendererReadyToken $relaunched.Id $ExpectedVersion) {
              if (Restore-AppWindow $relaunched.Id) {
                $relaunchReady = $true
                Write-UpdateLog ('rendererReady=true;attempt=' + $attempt + ';pid=' + $relaunched.Id)
                Write-UpdateLog ('relaunchReady=true;attempt=' + $attempt + ';pid=' + $relaunched.Id)
              }
              break
            }
          }
          if ($relaunchReady) { break }
          Write-UpdateLog ('rendererReadyTimeout=true;attempt=' + $attempt + ';pid=' + $relaunched.Id)
          Stop-AppProcesses $launchPath 'stoppingUnreadyProcess'
          if ($attempt -lt 3) {
            Start-Sleep -Milliseconds 750
          }
        }
        if (-not $relaunchReady) { Write-UpdateLog 'relaunchError=renderer did not become ready after three attempts' }
      } else {
        $recovered = Start-Process -FilePath $launchPath -WorkingDirectory (Split-Path -Parent $launchPath) -PassThru
        Start-Sleep -Milliseconds 1500
        if ($recovered.HasExited) {
          Write-UpdateLog ('recoveryRelaunchError=app exited;exitCode=' + $recovered.ExitCode)
        } else {
          [void](Restore-AppWindow $recovered.Id)
          Write-UpdateLog ('recoveryRelaunchStarted=true;pid=' + $recovered.Id + ';version=' + $installedVersion)
        }
      }
    } catch {
      Write-UpdateLog ('relaunchError=' + $_.Exception.Message)
    }
  } else {
    Write-UpdateLog 'relaunchError=installed executable not found'
  }
  Remove-Item Env:LOADTOAGENT_UPDATE_READY_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:LOADTOAGENT_UPDATE_READY_TOKEN -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $RendererReadyPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;

const WINDOWS_UPDATE_BOOTSTRAP = `param(
  [Parameter(Mandatory = $true)][string]$HelperPath,
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$RendererReadyPath,
  [Parameter(Mandatory = $true)][string]$RendererReadyToken
)

$ErrorActionPreference = 'Stop'

function Write-BootstrapLog([string]$Message) {
  try { $Message | Add-Content -LiteralPath $LogPath -Encoding UTF8 } catch {}
}

function Quote-ProcessArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\\"') + '"'
}

try {
  $helperArguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Quote-ProcessArgument $HelperPath),
    '-InstallerPath', (Quote-ProcessArgument $InstallerPath),
    '-ParentPid', [string]$ParentPid,
    '-AppPath', (Quote-ProcessArgument $AppPath),
    '-ExpectedVersion', $ExpectedVersion,
    '-LogPath', (Quote-ProcessArgument $LogPath),
    '-ReadyPath', (Quote-ProcessArgument $ReadyPath),
    '-RendererReadyPath', (Quote-ProcessArgument $RendererReadyPath),
    '-RendererReadyToken', $RendererReadyToken
  )
  $helperProcess = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $helperArguments -WindowStyle Hidden -PassThru
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if (Test-Path -LiteralPath $ReadyPath -PathType Leaf) {
      $readySignal = Get-Content -LiteralPath $ReadyPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ([int]$readySignal.helperPid -ne $helperProcess.Id -or [string]$readySignal.token -ne $RendererReadyToken) {
        throw '업데이트 설치 도우미의 준비 신호가 올바르지 않습니다.'
      }
      Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
      exit 0
    }
    if ($helperProcess.HasExited) {
      throw ('업데이트 설치 도우미가 준비 전에 종료되었습니다. 코드: ' + $helperProcess.ExitCode)
    }
    Start-Sleep -Milliseconds 100
    $helperProcess.Refresh()
  }
  Stop-Process -Id $helperProcess.Id -Force -ErrorAction SilentlyContinue
  throw '업데이트 설치 도우미가 10초 안에 준비되지 않았습니다.'
} catch {
  if ($null -ne $helperProcess -and -not $helperProcess.HasExited) {
    Stop-Process -Id $helperProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Write-BootstrapLog ('bootstrapError=' + $_.Exception.Message)
  Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
  exit 42
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

function resolveInstalledDesktopApp(options = {}) {
  const platform = String(options.platform || process.platform);
  const installType = String(options.installType || '');
  const currentAppPath = String(options.appPath || '');
  const fileSystem = options.fileSystem || fs;
  const environment = options.environment || process.env;
  const homeDir = String(options.homeDir || environment.HOME || environment.USERPROFILE || '');
  const candidates = [];
  const addCandidate = candidate => {
    const value = String(candidate || '').trim();
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  if (installType === 'desktop') addCandidate(currentAppPath);
  if (['source', 'npm'].includes(installType)) {
    for (const candidate of Array.isArray(options.candidates) ? options.candidates : []) addCandidate(candidate);
    if (platform === 'win32') {
      if (environment.LOCALAPPDATA) {
        addCandidate(path.join(environment.LOCALAPPDATA, 'Programs', 'LoadToAgent', 'LoadToAgent.exe'));
      }
    } else if (platform === 'darwin') {
      addCandidate('/Applications/LoadToAgent.app/Contents/MacOS/LoadToAgent');
      if (homeDir) addCandidate(path.join(homeDir, 'Applications', 'LoadToAgent.app', 'Contents', 'MacOS', 'LoadToAgent'));
    }
  }

  for (const candidate of candidates) {
    try {
      if (!fileSystem.existsSync(candidate)) continue;
      if (typeof fileSystem.statSync === 'function' && !fileSystem.statSync(candidate).isFile()) continue;
      return path.resolve(candidate);
    } catch (_unreadableCandidate) {}
  }
  return '';
}

async function windowsInstalledDesktopAppCandidates(options = {}) {
  const environment = options.environment || process.env;
  const execFile = options.execFile || execFileProcess;
  const script = [
    '$paths = [System.Collections.Generic.List[string]]::new()',
    'function Add-Candidate([string]$Candidate) {',
    '  if ([string]::IsNullOrWhiteSpace($Candidate)) { return }',
    '  $value = $Candidate.Trim()',
    "  if ($value.EndsWith(',0')) { $value = $value.Substring(0, $value.Length - 2) }",
    "  $value = $value.Trim().Trim('\"')",
    '  if (-not $paths.Contains($value)) { $paths.Add($value) }',
    '}',
    'foreach ($root in @(',
    "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    ')) {',
    '  Get-ItemProperty $root -ErrorAction SilentlyContinue |',
    "    Where-Object { [string]$_.DisplayName -like 'LoadToAgent*' } |",
    '    ForEach-Object {',
    '      Add-Candidate ([string]$_.DisplayIcon)',
    '      if (-not [string]::IsNullOrWhiteSpace([string]$_.InstallLocation)) {',
    "        Add-Candidate (Join-Path ([string]$_.InstallLocation) 'LoadToAgent.exe')",
    '      }',
    "      if ([string]$_.UninstallString -match '^\"?(.+?\\\\)Uninstall LoadToAgent\\.exe') {",
    "        Add-Candidate (Join-Path $Matches[1] 'LoadToAgent.exe')",
    '      }',
    '    }',
    '}',
    '$paths | ForEach-Object { [Console]::Out.WriteLine($_) }',
  ].join('\n');
  const result = await execFile(windowsPowerShell(environment), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    env: { ...process.env, ...environment },
  });
  return String(result && result.stdout || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

async function findInstalledDesktopApp(options = {}) {
  const platform = String(options.platform || process.platform);
  const installType = String(options.installType || '');
  let candidates = Array.isArray(options.candidates) ? [...options.candidates] : [];
  if (platform === 'win32' && ['source', 'npm'].includes(installType)) {
    try {
      candidates = [
        ...await windowsInstalledDesktopAppCandidates(options),
        ...candidates,
      ];
    } catch (_registryUnavailable) {}
  }
  return resolveInstalledDesktopApp({ ...options, platform, installType, candidates });
}

function normalizedExecutableVersion(value) {
  const match = String(value || '').trim().match(/(?:^|[^0-9])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:[^0-9]|$)/);
  return match ? match[1] : '';
}

async function readDesktopAppVersion(options = {}) {
  const platform = String(options.platform || process.platform);
  const appPath = String(options.appPath || '');
  if (!appPath) return '';
  const execFile = options.execFile || execFileProcess;
  if (platform === 'win32') {
    const environment = options.environment || process.env;
    const script = [
      '$info = (Get-Item -LiteralPath $env:LOADTOAGENT_VERSION_PATH -ErrorAction Stop).VersionInfo',
      '$version = @($info.ProductVersion, $info.FileVersion) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -First 1',
      '[Console]::Out.Write([string]$version)',
    ].join('; ');
    const result = await execFile(windowsPowerShell(environment), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command', script,
    ], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, ...environment, LOADTOAGENT_VERSION_PATH: appPath },
    });
    return normalizedExecutableVersion(result && result.stdout);
  }
  if (platform === 'darwin') {
    const appBundle = macAppBundlePath(appPath);
    if (!appBundle) return '';
    const result = await execFile('/usr/libexec/PlistBuddy', [
      '-c', 'Print :CFBundleShortVersionString', path.join(appBundle, 'Contents', 'Info.plist'),
    ], { timeout: 10_000, maxBuffer: 64 * 1024 });
    return normalizedExecutableVersion(result && result.stdout);
  }
  return '';
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

async function terminateWindowsUpdateProcesses(pids, options = {}) {
  const targets = [...new Set((Array.isArray(pids) ? pids : [pids])
    .map(Number)
    .filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid))];
  const terminateTree = typeof options.killProcessTree === 'function'
    ? options.killProcessTree
    : pid => execFileProcess(
      path.join(
        String(options.environment?.SystemRoot || options.environment?.WINDIR || process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'),
        'System32',
        'taskkill.exe',
      ),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 },
    );
  for (const pid of targets) {
    try {
      await terminateTree(pid);
    } catch (_treeTerminationError) {
      try { (options.killProcess || process.kill)(pid, 'SIGTERM'); } catch (_alreadyExited) {}
    }
  }
}

async function readUpdateReadySignal(readyPath, expected = {}) {
  let value;
  try {
    const raw = await fs.promises.readFile(readyPath, 'utf8');
    value = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
  } catch (error) {
    if (error && error.code === 'ENOENT') throw error;
    throw new Error('업데이트 설치 도우미의 준비 신호가 올바르지 않습니다.');
  }
  if (value.token !== expected.token || (expected.pid != null && Number(value.helperPid) !== Number(expected.pid))) {
    throw new Error('업데이트 설치 도우미의 준비 신호가 올바르지 않습니다.');
  }
  if (!Number.isSafeInteger(Number(value.helperPid)) || Number(value.helperPid) <= 0) {
    throw new Error('업데이트 설치 도우미의 준비 신호가 올바르지 않습니다.');
  }
  return value;
}

function waitForUpdateHelperReady(readyPath, child, timeoutMs = 5000, expected = null) {
  if (!readyPath || !child || typeof child.once !== 'function') {
    return Promise.reject(new Error('업데이트 설치 도우미의 준비 상태를 확인하지 못했습니다.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (typeof child.removeListener === 'function') {
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
      }
      if (error) reject(error);
      else resolve(value);
    };
    const onError = error => finish(error);
    const onExit = code => {
      if (!expected && code === 0 && fs.existsSync(readyPath)) finish();
      else finish(new Error(`업데이트 설치 도우미가 준비되기 전에 종료되었습니다. (코드 ${code ?? '알 수 없음'})`));
    };
    const checkReady = () => {
      if (child.exitCode != null || child.signalCode != null) {
        finish(new Error('업데이트 설치 도우미가 준비되기 전에 종료되었습니다.'));
        return;
      }
      const check = expected
        ? readUpdateReadySignal(readyPath, expected).then(value => {
          if (child.exitCode != null || child.signalCode != null) {
            throw new Error('업데이트 설치 도우미가 준비 신호 직후 종료되었습니다.');
          }
          return value;
        })
        : fs.promises.access(readyPath, fs.constants.F_OK);
      check
        .then(value => finish(null, value))
        .catch(error => {
          if (error && error.code !== 'ENOENT') finish(error);
        });
    };
    const poll = setInterval(checkReady, 50);
    const timer = setTimeout(
      () => finish(new Error('업데이트 설치 도우미가 준비되는 데 너무 오래 걸립니다. 앱을 종료하지 않았습니다.')),
      timeoutMs,
    );
    child.once('error', onError);
    child.once('exit', onExit);
    checkReady();
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
  const expectedVersion = String(options.expectedVersion || '').trim();
  const parentPid = Number(options.parentPid);
  if (!appPath || !fs.existsSync(appPath) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion) || !Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error('업데이트 후 앱을 다시 시작할 정보를 준비하지 못했습니다.');
  }

  const spawn = options.spawn || spawnProcess;
  if (automaticPlatform === 'darwin') {
    const targetApp = macAppBundlePath(appPath);
    if (!targetApp || !fs.existsSync(targetApp)) throw new Error('현재 설치된 macOS 앱을 찾지 못했습니다.');
    const helperPath = path.join(downloadsDir, 'install-update-macos.js');
    const logPath = path.join(downloadsDir, 'install-update.log');
    const rendererReadyToken = crypto.randomBytes(24).toString('hex');
    const readyPath = path.join(downloadsDir, `install-update-macos-ready-${rendererReadyToken}.json`);
    const rendererReadyPath = path.join(downloadsDir, `install-renderer-ready-${rendererReadyToken}.json`);
    await fs.promises.rm(readyPath, { force: true });
    await fs.promises.rm(rendererReadyPath, { force: true });
    const helperSource = await fs.promises.readFile(MAC_UPDATE_HELPER_SOURCE, 'utf8');
    await fs.promises.writeFile(helperPath, helperSource, { encoding: 'utf8', mode: 0o700 });
    const environment = { ...process.env, ...(options.environment || {}), ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(appPath, [
      helperPath,
      '--dmg', installerPath,
      '--target', targetApp,
      '--parent-pid', String(parentPid),
      '--expected-version', expectedVersion,
      '--log', logPath,
      '--ready', readyPath,
      '--renderer-ready-path', rendererReadyPath,
      '--renderer-ready-token', rendererReadyToken,
      '--allow-unsigned-mac-updates', String(options.allowUnsignedMacUpdates === true),
    ], {
      detached: true,
      stdio: 'ignore',
      env: environment,
    });
    const waitForReady = options.waitForReady || waitForUpdateHelperReady;
    try {
      await waitForProcessSpawn(child, Number(options.spawnTimeoutMs) || 5000);
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('업데이트 설치 프로그램을 시작하지 못했습니다.');
      const readySignal = await waitForReady(readyPath, child, Number(options.readyTimeoutMs) || 5000, {
        pid: child.pid,
        token: rendererReadyToken,
      });
      if (typeof options.beforeAutomaticInstall === 'function') {
        await options.beforeAutomaticInstall({
          platform: 'darwin',
          helperPid: Number(readySignal && readySignal.helperPid || child.pid),
        });
      }
    } catch (error) {
      try { if (typeof child.kill === 'function') child.kill(); } catch (_killError) {}
      await fs.promises.rm(readyPath, { force: true }).catch(cleanupError => {
        reportRecoverableError('mac-update-helper-ready-remove', cleanupError);
      });
      await fs.promises.rm(rendererReadyPath, { force: true }).catch(cleanupError => {
        reportRecoverableError('mac-update-renderer-ready-remove', cleanupError);
      });
      throw error;
    }
    child.unref();
    await fs.promises.rm(readyPath, { force: true }).catch(cleanupError => {
      reportRecoverableError('mac-update-helper-ready-remove', cleanupError);
    });
    return {
      mode: 'automatic',
      helperPath,
      logPath,
      readyPath,
      rendererReadyPath,
      rendererReadyToken,
      targetApp,
    };
  }

  const rendererReadyToken = crypto.randomBytes(24).toString('hex');
  const helperPath = path.join(downloadsDir, `install-update-${rendererReadyToken}.ps1`);
  const bootstrapPath = path.join(downloadsDir, `install-update-bootstrap-${rendererReadyToken}.ps1`);
  const logPath = path.join(downloadsDir, 'install-update.log');
  const readyPath = path.join(downloadsDir, `install-update-ready-${rendererReadyToken}.json`);
  const rendererReadyPath = path.join(downloadsDir, `install-renderer-ready-${rendererReadyToken}.json`);
  await fs.promises.rm(readyPath, { force: true });
  await fs.promises.rm(rendererReadyPath, { force: true });
  await fs.promises.writeFile(helperPath, `\uFEFF${WINDOWS_UPDATE_HELPER}`, { encoding: 'utf8', mode: 0o600 });
  await fs.promises.writeFile(bootstrapPath, `\uFEFF${WINDOWS_UPDATE_BOOTSTRAP}`, { encoding: 'utf8', mode: 0o600 });
  const child = spawn(windowsPowerShell(options.environment), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', bootstrapPath,
    '-HelperPath', helperPath,
    '-InstallerPath', installerPath,
    '-ParentPid', String(parentPid),
    '-AppPath', appPath,
    '-ExpectedVersion', expectedVersion,
    '-LogPath', logPath,
    '-ReadyPath', readyPath,
    '-RendererReadyPath', rendererReadyPath,
    '-RendererReadyToken', rendererReadyToken,
  ], {
    detached: false,
    windowsHide: true,
    stdio: 'ignore',
  });
  let readySignal = null;
  try {
    await waitForProcessSpawn(child, Number(options.spawnTimeoutMs) || 5000);
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('업데이트 설치 프로그램을 시작하지 못했습니다.');
    const waitForReady = options.waitForReady || waitForUpdateHelperReady;
    readySignal = await waitForReady(readyPath, child, Number(options.readyTimeoutMs) || 5000);
    if (!readySignal || typeof readySignal !== 'object') {
      readySignal = await readUpdateReadySignal(readyPath, { token: rendererReadyToken });
    } else if (readySignal.token !== rendererReadyToken || !Number.isSafeInteger(Number(readySignal.helperPid)) || Number(readySignal.helperPid) <= 0) {
      throw new Error('업데이트 설치 도우미의 준비 신호가 올바르지 않습니다.');
    }
    if (typeof options.beforeAutomaticInstall === 'function') {
      await options.beforeAutomaticInstall({
        platform: 'win32',
        helperPid: Number(readySignal && readySignal.helperPid || 0),
      });
    }
    await fs.promises.rm(readyPath, { force: true }).catch(cleanupError => {
      reportRecoverableError('windows-update-helper-ready-remove', cleanupError);
    });
    child.unref();
  } catch (error) {
    if (!readySignal) {
      try { readySignal = await readUpdateReadySignal(readyPath, { token: rendererReadyToken }); } catch (_missingReadySignal) {}
    }
    const helperPid = Number(readySignal && readySignal.helperPid || 0);
    await terminateWindowsUpdateProcesses([helperPid, helperPid > 0 ? 0 : child && child.pid], options);
    await Promise.all([
      fs.promises.rm(readyPath, { force: true }),
      fs.promises.rm(rendererReadyPath, { force: true }),
      fs.promises.rm(helperPath, { force: true }),
      fs.promises.rm(bootstrapPath, { force: true }),
    ]).catch(cleanupError => reportRecoverableError('windows-update-failed-cleanup', cleanupError));
    throw error;
  }
  return {
    mode: 'automatic',
    helperPath,
    bootstrapPath,
    logPath,
    readyPath,
    rendererReadyPath,
    rendererReadyToken,
  };
}

module.exports = {
  MAC_UPDATE_HELPER_SOURCE,
  WINDOWS_UPDATE_BOOTSTRAP,
  WINDOWS_UPDATE_HELPER,
  automaticInstallPlatform,
  canInstallSilently,
  findInstalledDesktopApp,
  isWithinDirectory,
  launchDownloadedUpdate,
  macAppBundlePath,
  readDesktopAppVersion,
  resolveInstalledDesktopApp,
  waitForProcessSpawn,
  waitForUpdateHelperReady,
  verifyDownloadedInstaller,
  windowsPowerShell,
};
