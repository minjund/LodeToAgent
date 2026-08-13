'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { acquireInterimProfileGuard } = require('../src/interimProfileGuard');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-interim-profile-guard-'));
const runtimePath = path.join(root, 'legacy');
const currentPath = path.join(root, 'Whitebox');
fs.mkdirSync(runtimePath, { recursive: true });
fs.mkdirSync(currentPath, { recursive: true });
app.setPath('userData', runtimePath);
app.setPath('sessionData', runtimePath);

const options = {
  currentPath,
  runtimePath,
  executable: process.execPath,
  helper: path.join(__dirname, '..', 'src', 'interimProfileGuardProcess.js'),
};
const packagedEntryOptions = {
  ...options,
  helper: path.join(__dirname, '..', 'main.js'),
};

app.whenReady().then(async () => {
  let activationCount = 0;
  const first = await acquireInterimProfileGuard({
    ...options,
    onActivate: () => { activationCount += 1; },
  });
  assert.equal(first.acquired, true);
  assert.equal(first.skipped, false);
  const competing = await acquireInterimProfileGuard(options);
  assert.equal(competing.acquired, false, 'an interim Whitebox instance must block the new split-profile app');
  assert.equal(activationCount, 1, 'a blocked interim launch must be forwarded to the owning app');
  await first.release();
  const packagedEntry = await acquireInterimProfileGuard(packagedEntryOptions);
  assert.equal(packagedEntry.acquired, true, 'the packaged main entry must support guard mode');
  const packagedCompeting = await acquireInterimProfileGuard(options);
  assert.equal(packagedCompeting.acquired, false, 'the packaged guard entry must own the Whitebox profile lock');
  await packagedEntry.release();
  let lostError = null;
  const lostGuard = await acquireInterimProfileGuard({
    ...options,
    onLost: error => { lostError = error; },
  });
  process.kill(lostGuard.pid);
  for (let attempt = 0; attempt < 50 && !lostError; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(String(lostError?.message || ''), /profile guard exited/i,
    'an unexpected guard exit must invalidate the continuous lease');
  await lostGuard.release();
  const afterCrash = await acquireInterimProfileGuard(options);
  assert.equal(afterCrash.acquired, true, 'the profile lock must be reusable after a crashed owner is observed');
  await afterCrash.release();
  process.stdout.write('교차 버전 Whitebox 프로필 잠금 검증 통과\n');
  app.exit(0);
}).catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});

app.once('quit', () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
