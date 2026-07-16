'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'darwin') {
  console.log('macOS 업데이트 통합 테스트 건너뜀: darwin에서만 실행됩니다.');
  process.exit(0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error([
      `${path.basename(command)} failed (${result.status})`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function waitForFile(file, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`재실행 표시 파일을 기다리다 시간 초과: ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-updater-integration-'));
const sourceRoot = path.join(root, 'dmg-source');
const sourceApp = path.join(sourceRoot, 'LoadToAgent.app');
const targetApp = path.join(root, 'Applications', 'LoadToAgent.app');
const dmgPath = path.join(root, 'LoadToAgent-9.9.9-arm64.dmg');
const logPath = path.join(root, 'install-update.log');
const launchMarker = path.join(root, 'relaunched.txt');
const leakedEnvironmentMarker = path.join(root, 'electron-run-as-node.txt');
const helperPath = path.join(__dirname, '..', 'src', 'macUpdateHelper.js');
const helperRuntime = process.env.LOADTOAGENT_UPDATE_TEST_RUNTIME || process.execPath;

try {
  fs.mkdirSync(path.join(sourceApp, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(targetApp, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(sourceApp, 'Contents', 'version.txt'), 'new', 'utf8');
  fs.writeFileSync(path.join(targetApp, 'Contents', 'version.txt'), 'old', 'utf8');
  fs.writeFileSync(path.join(sourceApp, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>LoadToAgent</string>
<key>CFBundleIdentifier</key><string>com.wincube.loadtoagent.updater.integration.${process.pid}</string>
<key>CFBundleName</key><string>LoadToAgent Update Integration</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>9.9.9</string>
</dict></plist>
`, 'utf8');
  fs.writeFileSync(
    path.join(sourceApp, 'Contents', 'MacOS', 'LoadToAgent'),
    `#!/bin/sh\nif [ -n "$ELECTRON_RUN_AS_NODE" ]; then /bin/echo "$ELECTRON_RUN_AS_NODE" > ${JSON.stringify(leakedEnvironmentMarker)}; fi\n/usr/bin/touch ${JSON.stringify(launchMarker)}\n`,
    { encoding: 'utf8', mode: 0o755 },
  );

  run('/usr/bin/hdiutil', [
    'create', '-volname', `LoadToAgentUpdateTest-${process.pid}`,
    '-srcfolder', sourceRoot, '-ov', '-format', 'UDZO', dmgPath,
  ]);
  run(helperRuntime, [
    helperPath,
    '--dmg', dmgPath,
    '--target', targetApp,
    '--parent-pid', '99999999',
    '--log', logPath,
  ], {
    timeout: 60_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  waitForFile(launchMarker);
  assert.equal(fs.readFileSync(path.join(targetApp, 'Contents', 'version.txt'), 'utf8'), 'new');
  assert.equal(fs.existsSync(leakedEnvironmentMarker), false);
  assert.match(fs.readFileSync(logPath, 'utf8'), /update installed and relaunched/);
  console.log('✓ 실제 DMG 마운트, 앱 교체, 자동 재실행 통합 테스트 통과');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
