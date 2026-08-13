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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-updater-integration-'));
const sourceRoot = path.join(root, 'dmg-source');
const sourceApp = path.join(sourceRoot, 'Whitebox.app');
const targetApp = path.join(root, 'Applications', 'Whitebox.app');
const dmgPath = path.join(root, 'Whitebox-9.9.9-arm64.dmg');
const logPath = path.join(root, 'install-update.log');
const rendererReadyToken = 'a'.repeat(48);
const readyPath = path.join(root, `install-update-macos-ready-${rendererReadyToken}.json`);
const rendererReadyPath = path.join(root, `install-renderer-ready-${rendererReadyToken}.json`);
const launchMarker = path.join(root, 'relaunched.txt');
const leakedEnvironmentMarker = path.join(root, 'electron-run-as-node.txt');
const helperPath = path.join(__dirname, '..', 'src', 'macUpdateHelper.js');
const helperRuntime = process.env.WHITEBOX_UPDATE_TEST_RUNTIME || process.execPath;
const nodePtyHelper = path.join(
  'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty',
  'prebuilds', `darwin-${process.arch}`, 'spawn-helper',
);

try {
  fs.mkdirSync(path.join(sourceApp, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(sourceApp, nodePtyHelper)), { recursive: true });
  fs.mkdirSync(path.join(targetApp, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(sourceApp, 'Contents', 'version.txt'), 'new', 'utf8');
  fs.writeFileSync(path.join(targetApp, 'Contents', 'version.txt'), 'old', 'utf8');
  fs.writeFileSync(path.join(sourceApp, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Whitebox</string>
<key>CFBundleIdentifier</key><string>com.wincube.whitebox.updater.integration.${process.pid}</string>
<key>CFBundleName</key><string>Whitebox Update Integration</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>9.9.9</string>
</dict></plist>
`, 'utf8');
  fs.writeFileSync(
    path.join(sourceApp, 'Contents', 'MacOS', 'Whitebox'),
    [
      '#!/bin/sh',
      `if [ -n "$ELECTRON_RUN_AS_NODE" ]; then /bin/echo "$ELECTRON_RUN_AS_NODE" > ${JSON.stringify(leakedEnvironmentMarker)}; fi`,
      'ready_tmp="$WHITEBOX_UPDATE_READY_PATH.$$.tmp"',
      `if [ "$WHITEBOX_UPDATE_READY_TOKEN" = ${JSON.stringify(rendererReadyToken)} ]; then`,
      `  /usr/bin/printf '{"token":"%s","pid":%s,"version":"9.9.9","rendererReadyAt":"2026-08-01T00:00:00.000Z"}' "$WHITEBOX_UPDATE_READY_TOKEN" "$$" > "$ready_tmp"`,
      '  /bin/mv -f "$ready_tmp" "$WHITEBOX_UPDATE_READY_PATH"',
      'fi',
      `/usr/bin/touch ${JSON.stringify(launchMarker)}`,
      '/bin/sleep 2',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 },
  );
  fs.writeFileSync(path.join(sourceApp, nodePtyHelper), '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o755 });

  run('/usr/bin/hdiutil', [
    'create', '-volname', `WhiteboxUpdateTest-${process.pid}`,
    '-srcfolder', sourceRoot, '-ov', '-format', 'UDZO', dmgPath,
  ]);
  run(helperRuntime, [
    helperPath,
    '--dmg', dmgPath,
    '--target', targetApp,
    '--parent-pid', '99999999',
    '--expected-version', '9.9.9',
    '--log', logPath,
    '--ready', readyPath,
    '--renderer-ready-path', rendererReadyPath,
    '--renderer-ready-token', rendererReadyToken,
    '--allow-unsigned-mac-updates', 'true',
  ], {
    timeout: 60_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  waitForFile(launchMarker);
  assert.equal(fs.readFileSync(path.join(targetApp, 'Contents', 'version.txt'), 'utf8'), 'new');
  assert.equal(fs.statSync(path.join(targetApp, nodePtyHelper)).mode & 0o111, 0o111);
  assert.equal(fs.existsSync(leakedEnvironmentMarker), false);
  assert.equal(fs.existsSync(rendererReadyPath), false);
  assert.equal(fs.readdirSync(path.dirname(targetApp)).some(name => name.includes('.backup-')), false);
  assert.match(fs.readFileSync(logPath, 'utf8'), /internal unsigned update quarantine removed/);
  assert.match(fs.readFileSync(logPath, 'utf8'), /update installed and renderer ready;pid=\d+;version=9\.9\.9/);
  console.log('✓ 실제 DMG 마운트, 실행 권한 보존, 인증된 준비 신호, 앱 교체 통합 테스트 통과');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
