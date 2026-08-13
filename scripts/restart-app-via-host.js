'use strict';

const path = require('path');
const { TerminalHostClient } = require('../src/terminalHost');

const root = path.resolve(__dirname, '..');
const discoveryFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(process.env.APPDATA || '', 'Whitebox', 'terminal-host.json');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const quote = value => `'${String(value).replace(/'/g, "''")}'`;

(async () => {
  const client = new TerminalHostClient({ discoveryFile, connectTimeoutMs: 4_000 });
  await client.connect();
  const helper = await client.create({
    type: 'powershell',
    cwd: root,
    title: 'Whitebox UI restart helper',
    transient: true,
    cols: 100,
    rows: 12,
  });
  await new Promise(resolve => setTimeout(resolve, 350));
  await client.command(helper.id, [
    'Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
    `Start-Process -FilePath ${quote(electron)} -ArgumentList '.' -WorkingDirectory ${quote(root)} -WindowStyle Normal`,
    'exit',
  ].join('\n'));
  process.stdout.write(`HOST_LAUNCH_HELPER=${helper.id}\n`);
  client.dispose();
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
