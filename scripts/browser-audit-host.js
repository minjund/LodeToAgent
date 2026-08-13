'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-browser-audit-'));
const debuggingPort = String(process.env.WHITEBOX_AUDIT_PORT || '9333');

app.setPath('userData', userData);
app.commandLine.appendSwitch('remote-debugging-port', debuggingPort);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    show: process.env.WHITEBOX_AUDIT_HEADLESS !== '1',
    webPreferences: {
      preload: path.join(__dirname, 'interaction-fixture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  process.stdout.write(`Whitebox UI audit host ready on CDP port ${debuggingPort}\n`);
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('quit', () => {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {}
});
