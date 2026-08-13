'use strict';

const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { app } = require('electron');
const { GUARD_ACTIVATE, GUARD_READY, GUARD_RELEASE } = require('./interimProfileGuard');

const profilePath = path.resolve(String(process.env.WHITEBOX_INTERIM_PROFILE_PATH || process.argv[2] || ''));
if (!profilePath) app.exit(2);
else {
  app.setName('Whitebox');
  app.setPath('userData', profilePath);
  const profileKey = crypto.createHash('sha256').update(profilePath).digest('hex').slice(0, 16);
  app.setPath('sessionData', path.join(os.tmpdir(), `whitebox-profile-guard-${profileKey}`));
  app.on('second-instance', (_event, argv, cwd) => {
    process.send?.({
      type: GUARD_ACTIVATE,
      argv: (Array.isArray(argv) ? argv : []).map(String).slice(0, 32),
      cwd: String(cwd || '').slice(0, 4_000),
    });
  });
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) {
    process.send?.({ type: GUARD_READY, acquired: false });
    app.exit(3);
  }
  else {
    process.title = 'Whitebox Profile Guard';
    process.on('message', message => {
      if (message?.type === GUARD_RELEASE) app.exit(0);
    });
    process.on('disconnect', () => app.exit(0));
    setInterval(() => {}, 60_000);
    if (process.platform === 'darwin') {
      app.whenReady().then(() => {
        app.setActivationPolicy('prohibited');
        process.send?.({ type: GUARD_READY, acquired: true });
      });
    } else process.send?.({ type: GUARD_READY, acquired: true });
  }
}
