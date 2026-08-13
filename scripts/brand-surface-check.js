'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const root = path.resolve(__dirname, '..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-brand-surface-'));
const userDataPath = path.join(temporaryRoot, 'Whitebox');
const bridgeHome = path.join(temporaryRoot, 'bridge-home');
fs.mkdirSync(userDataPath, { recursive: true });
fs.mkdirSync(bridgeHome, { recursive: true });

process.env.WHITEBOX_TEST_INSTANCE = '1';
process.env.WHITEBOX_BRIDGE_HOME = bridgeHome;
app.disableHardwareAcceleration();
app.setPath('userData', userDataPath);

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForMainWindow() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const candidate = BrowserWindow.getAllWindows().find(window => {
      if (window.isDestroyed()) return false;
      try {
        return /renderer[\\/]index\.html$/i.test(decodeURIComponent(new URL(window.webContents.getURL()).pathname));
      } catch {
        return false;
      }
    });
    if (candidate && !candidate.webContents.isLoadingMainFrame()) return candidate;
    await wait(100);
  }
  throw new Error('Whitebox main window did not finish loading');
}

async function run() {
  const iconPath = path.join(root, 'build', 'icon.png');
  const applicationIcon = nativeImage.createFromPath(iconPath);
  assert.equal(applicationIcon.isEmpty(), false, 'The application icon could not be loaded');
  assert.ok(applicationIcon.getSize().width >= 512, 'The application icon is too small for packaging');

  const win = await waitForMainWindow();
  const brand = await win.webContents.executeJavaScript(`(() => {
    const icon = document.querySelector('#brandIcon');
    const label = document.querySelector('.brand-copy strong');
    const rect = icon?.getBoundingClientRect();
    const style = icon && getComputedStyle(icon);
    return {
      windowTitle: document.title,
      label: label?.textContent?.trim() || '',
      source: icon?.getAttribute('src') || '',
      complete: Boolean(icon?.complete),
      naturalWidth: Number(icon?.naturalWidth || 0),
      naturalHeight: Number(icon?.naturalHeight || 0),
      width: Number(rect?.width || 0),
      height: Number(rect?.height || 0),
      display: style?.display || '',
      visibility: style?.visibility || '',
      opacity: Number(style?.opacity || 0),
    };
  })()`);

  assert.match(win.getTitle(), /Whitebox/, 'The native window title does not contain Whitebox');
  assert.match(brand.windowTitle, /Whitebox/, 'The document title does not contain Whitebox');
  assert.equal(brand.label, 'Whitebox', 'The in-app product name is missing');
  assert.equal(brand.source, 'assets/whitebox-mark.svg', 'The in-app brand mark uses an unexpected asset');
  assert.equal(brand.complete, true, 'The in-app brand mark did not finish loading');
  assert.ok(brand.naturalWidth >= 32 && brand.naturalHeight >= 32, 'The in-app brand mark has no readable intrinsic size');
  assert.ok(brand.width >= 31 && brand.height >= 31, 'The in-app brand mark is not visibly sized');
  assert.notEqual(brand.display, 'none', 'The in-app brand mark is hidden');
  assert.notEqual(brand.visibility, 'hidden', 'The in-app brand mark is invisible');
  assert.ok(brand.opacity > 0, 'The in-app brand mark is transparent');

  const bounds = await win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('.sidebar > .brand')?.getBoundingClientRect();
    return rect ? {
      x: Math.max(0, Math.floor(rect.x)),
      y: Math.max(0, Math.floor(rect.y)),
      width: Math.max(1, Math.ceil(rect.width)),
      height: Math.max(1, Math.ceil(rect.height)),
    } : null;
  })()`);
  assert.ok(bounds, 'The in-app brand header is missing');
  const capture = await win.webContents.capturePage(bounds);
  const artifactDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const artifact = path.join(artifactDirectory, 'whitebox-brand-surface.png');
  fs.writeFileSync(artifact, capture.toPNG());
  process.stdout.write(`Whitebox 이름·창 아이콘·앱 내부 로고 검증 통과\n${artifact}\n`);
}

let finished = false;
const deadline = setTimeout(() => {
  if (finished) return;
  process.stderr.write('Whitebox brand surface verification timed out\n');
  app.exit(1);
}, 30_000);

app.once('quit', () => {
  clearTimeout(deadline);
  try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch {}
});

require('../main');

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    await run();
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error.stack}\n`);
  } finally {
    finished = true;
    clearTimeout(deadline);
    app.exit(exitCode);
  }
});
