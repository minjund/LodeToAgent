'use strict';

let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) return;
  interrupted = true;
  process.stdout.write('LOADTOAGENT_BOUND_PTY_INTERRUPTED\n', () => {
    setTimeout(() => process.exit(0), 25);
  });
});

process.stdout.write('LOADTOAGENT_BOUND_PTY_READY\n');

setInterval(() => {}, 1_000);
