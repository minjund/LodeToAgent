'use strict';

const path = require('path');
const { execFile: defaultExecFile } = require('child_process');

const WINDOWS_APP_USER_MODEL_ID = 'com.wincube.whitebox';

function run(command, args, options = {}) {
  const execFile = options.execFile || defaultExecFile;
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function registerWindowsShellIdentity(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32' || options.enabled === false) return { registered: false, refreshed: false };

  const executable = path.resolve(options.executable || process.execPath);
  const iconUri = path.resolve(options.iconUri || executable);
  const systemRoot = path.resolve(options.systemRoot || process.env.SystemRoot || 'C:\\Windows');
  const appId = String(options.appId || WINDOWS_APP_USER_MODEL_ID);
  const displayName = String(options.displayName || 'Whitebox');
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;
  const reg = path.join(systemRoot, 'System32', 'reg.exe');
  const execOptions = { execFile: options.execFile };

  await run(reg, ['ADD', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', displayName, '/f'], execOptions);
  await run(reg, ['ADD', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', iconUri, '/f'], execOptions);

  const iconRefresh = path.join(systemRoot, 'System32', 'ie4uinit.exe');
  await run(iconRefresh, ['-show'], execOptions);
  return { registered: true, refreshed: true, appId, executable, iconUri };
}

module.exports = { WINDOWS_APP_USER_MODEL_ID, registerWindowsShellIdentity };
