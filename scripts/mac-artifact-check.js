'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'darwin') {
  console.log('macOS 산출물 테스트 건너뜀: darwin에서만 실행됩니다.');
  process.exit(0);
}

const root = path.resolve(__dirname, '..');
const release = path.resolve(process.env.WHITEBOX_RELEASE_DIR || path.join(root, 'release'));
const version = require('../package.json').version;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed (${result.status})\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result.stdout;
}

function assertExecutable(file) {
  const stat = fs.statSync(file);
  assert.ok(stat.isFile(), `파일이 아닙니다: ${file}`);
  assert.equal(stat.mode & 0o111, 0o111, `실행 권한이 없습니다: ${file}`);
}

function assertArchitecture(file, expected) {
  const description = run('/usr/bin/file', ['-b', file]);
  assert.match(description, expected === 'arm64' ? /arm64/ : /x86_64/, `${file}: ${description}`);
}

function nodePtyFiles(app, arch) {
  const prebuild = path.join(
    app,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds',
    `darwin-${arch}`,
  );
  return { helper: path.join(prebuild, 'spawn-helper'), addon: path.join(prebuild, 'pty.node') };
}

const targets = [
  { arch: 'x64', directory: 'mac' },
  { arch: 'arm64', directory: 'mac-arm64' },
];

for (const target of targets) {
  const app = path.join(release, target.directory, 'Whitebox.app');
  const executable = path.join(app, 'Contents', 'MacOS', 'Whitebox');
  const files = nodePtyFiles(app, target.arch);
  assert.ok(fs.existsSync(app), `패키징된 ${target.arch} 앱이 없습니다: ${app}`);
  assertExecutable(files.helper);
  assertArchitecture(executable, target.arch);
  assertArchitecture(files.helper, target.arch);
  assertArchitecture(files.addon, target.arch);

  const zip = path.join(release, `Whitebox-${version}-${target.arch}.zip`);
  const dmg = path.join(release, `Whitebox-${version}-${target.arch}.dmg`);
  assert.ok(fs.statSync(zip).size > 0, `${target.arch} ZIP이 비어 있습니다.`);
  assert.ok(fs.statSync(dmg).size > 0, `${target.arch} DMG가 비어 있습니다.`);
  const zipListing = run('/usr/bin/unzip', ['-Z', '-l', zip]);
  const helperSuffix = `darwin-${target.arch}/spawn-helper`;
  const helperLine = zipListing.split(/\r?\n/).find(line => line.includes(helperSuffix));
  assert.ok(helperLine && /^-rwx/.test(helperLine.trim()), `${target.arch} ZIP의 spawn-helper 실행 권한이 없습니다.`);

  const mountPath = fs.mkdtempSync(path.join(os.tmpdir(), `whitebox-${target.arch}-dmg-`));
  try {
    run('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mountPath]);
    const mountedFiles = nodePtyFiles(path.join(mountPath, 'Whitebox.app'), target.arch);
    assertExecutable(mountedFiles.helper);
    assertArchitecture(mountedFiles.helper, target.arch);
    assertArchitecture(mountedFiles.addon, target.arch);
  } finally {
    spawnSync('/usr/bin/hdiutil', ['detach', mountPath, '-force'], { stdio: 'ignore' });
    fs.rmSync(mountPath, { recursive: true, force: true });
  }
  console.log(`✓ macOS ${target.arch} 앱·ZIP·DMG node-pty 실행 권한과 아키텍처 검증`);
}
