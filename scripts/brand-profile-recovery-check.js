'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const {
  openRendererStateBridge,
  recoverRendererStateFromAlternateProfile,
} = require('../src/rendererStateRecovery');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-profile-recovery-'));
const destinationPath = path.join(root, 'destination');
const sourcePath = path.join(root, 'source');
for (const candidate of [destinationPath, sourcePath]) fs.mkdirSync(candidate, { recursive: true });
app.setPath('userData', destinationPath);
app.setPath('sessionData', destinationPath);
let recoveryInProgress = true;
app.on('window-all-closed', () => {
  if (recoveryInProgress) return;
  app.quit();
});
app.once('quit', () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

const bridgeOptions = {
  BrowserWindow,
  ipcMain,
  htmlPath: path.join(__dirname, '..', 'renderer', 'brand-profile-recovery.html'),
  preloadPath: path.join(__dirname, '..', 'brand-profile-recovery-preload.js'),
};
const indexBridgeOptions = {
  ...bridgeOptions,
  htmlPath: path.join(__dirname, '..', 'renderer', 'index.html'),
};

async function withBridge(profileSession, action) {
  const bridge = await openRendererStateBridge({ ...bridgeOptions, session: profileSession });
  try { return await action(bridge); } finally { bridge.close(); }
}

app.whenReady().then(async () => {
  const destinationSession = session.defaultSession;
  const sourceSession = session.fromPath(sourcePath);
  assert.equal(path.resolve(app.getPath('userData')), path.resolve(destinationPath));
  assert.equal(path.resolve(app.getPath('sessionData')), path.resolve(destinationPath));
  assert.equal(path.resolve(destinationSession.storagePath), path.resolve(destinationPath));
  assert.equal(path.resolve(sourceSession.storagePath), path.resolve(sourcePath));
  const destinationSeed = {
    'whitebox:result-reviews:v1': JSON.stringify({
      shared: { stamp: 'destination', reviewedAt: 50 },
    }),
    'whitebox:theme:v1': 'dark',
  };
  const sourceSeed = {
    'whitebox:result-reviews:v1': JSON.stringify({
      shared: { stamp: 'source-older', reviewedAt: 40 },
      sourceOnly: { stamp: 'source-only', reviewedAt: 60 },
    }),
    'whitebox:project-notice-acks:v1': JSON.stringify({
      notice: { stamp: 'seen', seenAt: 70 },
    }),
    'whitebox:theme:v1': 'light',
  };
  await withBridge(destinationSession, bridge => bridge.write(destinationSeed));
  const sourceBridge = await openRendererStateBridge({ ...indexBridgeOptions, session: sourceSession });
  await sourceBridge.write(sourceSeed);
  const sourceBefore = (await sourceBridge.read()).values;
  sourceBridge.close();

  const first = await recoverRendererStateFromAlternateProfile({
    ...bridgeOptions,
    sourceSession,
    destinationSession,
  });
  assert.equal(first.ok, true);
  const destinationIndexBridge = await openRendererStateBridge({ ...indexBridgeOptions, session: destinationSession });
  const destinationAfterFirst = (await destinationIndexBridge.read()).values;
  destinationIndexBridge.close();
  const sourceAfterFirst = (await withBridge(sourceSession, bridge => bridge.read())).values;
  const reviews = JSON.parse(destinationAfterFirst['whitebox:result-reviews:v1']);
  assert.equal(reviews.shared.stamp, 'destination');
  assert.equal(reviews.sourceOnly.stamp, 'source-only');
  assert.equal(JSON.parse(destinationAfterFirst['whitebox:project-notice-acks:v1']).notice.stamp, 'seen');
  assert.equal(destinationAfterFirst['whitebox:theme:v1'], 'dark');
  assert.deepStrictEqual(sourceAfterFirst, sourceBefore, 'alternate profile must remain read-only');

  const firstSnapshot = JSON.stringify(destinationAfterFirst);
  const second = await recoverRendererStateFromAlternateProfile({
    ...bridgeOptions,
    sourceSession,
    destinationSession,
  });
  assert.equal(second.ok, true);
  const destinationAfterSecond = (await withBridge(destinationSession, bridge => bridge.read())).values;
  assert.equal(JSON.stringify(destinationAfterSecond), firstSnapshot, 'second recovery must be idempotent');
  recoveryInProgress = false;
  process.stdout.write('브랜드 프로필 상태 복구 검증 통과\n');
  app.exit(0);
}).catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});
