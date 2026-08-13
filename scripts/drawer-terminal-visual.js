'use strict';

// Kept as the stable CI entry point while the product surface moved from the
// right-side conversation drawer to the selected AI's inline PTY.
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'artifacts');
const logPath = path.join(outputDir, 'drawer-terminal-visual.log');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(logPath, `[${new Date().toISOString()}] inline PTY interaction check started\n`);

process.env.WHITEBOX_INTERACTION_ONLY = 'inline-terminal';
process.env.WHITEBOX_INTERACTION_ROUNDS = '1';
process.on('exit', code => {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] inline PTY interaction check exited with ${code}\n`);
});

require('./interaction-check');
