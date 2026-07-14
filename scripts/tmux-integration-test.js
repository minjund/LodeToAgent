'use strict';

const assert = require('assert');
const { TmuxController } = require('../src/tmuxController');
const { TmuxMonitor } = require('../src/tmuxMonitor');

const distro = process.argv[2] || 'Ubuntu-22.04';
const baseName = `lodestar-e2e-${process.pid}-${Date.now()}`;
let activeName = baseName;
const controller = new TmuxController();
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function main() {
  try {
    await controller.newSession({ distro, name: activeName });
    const marker = `LODESTAR_TMUX_OK_${Date.now()}`;
    await controller.sendText({ distro, target: `${activeName}:0.0`, text: `printf '${marker}\\n'`, enter: true });
    await wait(250);
    const captured = await controller.capture({ distro, target: `${activeName}:0.0`, lines: 100 });
    assert.ok(captured.output.includes(marker), 'tmux 패널에서 전송한 명령 결과를 캡처하지 못했습니다.');

    const split = await controller.splitPane({ distro, target: `${activeName}:0.0`, direction: 'horizontal' });
    assert.match(split.paneId, new RegExp(`^${activeName}:0\\.\\d+$`));
    await controller.selectLayout({ distro, target: `${activeName}:0`, layout: 'tiled' });
    await controller.newWindow({ distro, target: activeName, name: 'verify-window' });

    const renamed = `${baseName}-renamed`;
    await controller.renameSession({ distro, target: activeName, name: renamed });
    activeName = renamed;
    const monitor = new TmuxMonitor({ scanTtlMs: 1, discoveryTtlMs: 1 });
    const snapshot = monitor.scan(true);
    const observed = snapshot.distros.some(environment => environment.sessions.some(session => session.name === activeName));
    assert.equal(observed, true, 'tmux 모니터가 방금 만든 세션을 찾지 못했습니다.');
    if (process.platform === 'darwin') assert.equal(snapshot.distros[0].kind, 'local', 'macOS tmux가 로컬 환경으로 표시되지 않았습니다.');
    process.stdout.write(`✓ ${distro} tmux 생성·입력·캡처·분할·윈도우·레이아웃·이름 변경 검증\n`);
  } finally {
    try { await controller.killSession({ distro, target: activeName }); } catch {}
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
