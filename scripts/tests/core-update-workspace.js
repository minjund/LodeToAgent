'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { parseCliArguments, desktopLaunchSpec } = require('../../bin/loadtoagent');
const { providerList, normalizeProvider, modelContextWindow } = require('../../src/providerRegistry');
const { UpdateManager, compareVersions, normalizeVersion, safeFileName, selectReleaseAsset } = require('../../src/updateManager');
const { canInstallSilently, launchDownloadedUpdate, macAppBundlePath } = require('../../src/updateInstaller');
const { installMacUpdate } = require('../../src/macUpdateHelper');
const { normalizeWorkspaces, readWorkspaces, removeWorkspace } = require('../../src/workspaceStore');

function registerProviderAndWorkspaceTests(context) {
  const { test, temp } = context;
  test('네 제공사 레지스트리를 노출한다', () => {
    assert.deepStrictEqual(providerList().map(item => item.id), ['claude', 'codex', 'gemini', 'grok']);
    assert.equal(normalizeProvider('OpenAI GPT'), 'codex');
    assert.equal(normalizeProvider('xAI Grok'), 'grok');
  });

  test('작업 폴더 저장값을 안전하고 운영체제에 맞게 정규화한다', () => {
    const workspaceRoot = path.join(temp, 'workspaces');
    const upper = path.join(workspaceRoot, 'Project');
    const lower = path.join(workspaceRoot, 'project');
    const file = path.join(workspaceRoot, 'not-a-directory.txt');
    fs.mkdirSync(upper, { recursive: true });
    fs.mkdirSync(lower, { recursive: true });
    fs.writeFileSync(file, 'fixture', 'utf8');

    const items = [{ path: '' }, { path: file }, { path: upper }, { path: upper }, { path: lower }];
    assert.deepStrictEqual(normalizeWorkspaces(items, { platform: 'win32' }).map(item => item.path), [path.resolve(upper)]);
    assert.deepStrictEqual(normalizeWorkspaces(items, { platform: 'linux' }).map(item => item.path), [path.resolve(upper), path.resolve(lower)]);
    assert.equal(removeWorkspace([{ path: upper }], '').length, 1);
    assert.equal(removeWorkspace([{ path: upper }], upper).length, 0);
  });

  test('손상되거나 배열이 아닌 작업 폴더 파일은 빈 목록으로 복구한다', () => {
    const file = path.join(temp, 'broken-workspaces.json');
    fs.writeFileSync(file, '{broken', 'utf8');
    assert.deepStrictEqual(readWorkspaces(file), []);
    fs.writeFileSync(file, JSON.stringify({ path: temp }), 'utf8');
    assert.deepStrictEqual(readWorkspaces(file), []);
  });

}

function registerCliAndUpdateTests(context) {
  const { test, temp } = context;
  test('npm 전역 명령으로 앱 열기와 브리지 실행을 구분한다', () => {
    assert.deepStrictEqual(parseCliArguments([]), { action: 'open' });
    assert.deepStrictEqual(parseCliArguments(['open']), { action: 'open' });
    assert.deepStrictEqual(parseCliArguments(['--help']), { action: 'help' });
    assert.deepStrictEqual(parseCliArguments(['--version']), { action: 'version' });
    assert.deepStrictEqual(parseCliArguments(['run', 'codex', '--', '--model', 'gpt-5']), {
      action: 'run', provider: 'codex', args: ['--model', 'gpt-5'],
    });
    assert.throws(() => parseCliArguments(['unknown']), /사용법/);
  });

  test('npm 설치본과 패키지 앱의 데스크톱 실행 경로를 만든다', () => {
    const npmSpec = desktopLaunchSpec({
      env: { PATH: '/usr/bin' },
      electronPath: '/tmp/electron',
      packageRoot: '/tmp/loadtoagent',
    });
    assert.equal(npmSpec.executable, '/tmp/electron');
    assert.deepStrictEqual(npmSpec.args, ['/tmp/loadtoagent']);
    assert.equal(npmSpec.env.PATH, '/usr/bin');

    const packagedSpec = desktopLaunchSpec({
      env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
      execPath: '/Applications/LoadToAgent.app/Contents/MacOS/LoadToAgent',
    });
    assert.equal(packagedSpec.executable, '/Applications/LoadToAgent.app/Contents/MacOS/LoadToAgent');
    assert.deepStrictEqual(packagedSpec.args, []);
    assert.equal('ELECTRON_RUN_AS_NODE' in packagedSpec.env, false);
  });

  test('Git 태그 버전을 SemVer 순서로 비교한다', () => {
    assert.equal(normalizeVersion('refs/tags/v3.2.1').raw, '3.2.1');
    assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
    assert.equal(compareVersions('3.1.0-beta.2', '3.1.0-beta.10'), -1);
    assert.equal(compareVersions('3.1.0', '3.1.0-beta.10'), 1);
    assert.equal(compareVersions('v3.0.0', '3.0.0'), 0);
    assert.equal(compareVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
    assert.equal(compareVersions('3.1.0-beta.9007199254740993', '3.1.0-beta.9007199254740992'), 1);
    assert.throws(() => compareVersions('latest', '3.0.0'), /버전 형식/);
  });

  test('운영체제와 CPU에 맞는 신뢰된 GitHub Release 파일을 고른다', () => {
    const base = 'https://github.com/minjund/LodeToAgent/releases/download/v3.1.0/';
    const assets = [
      { name: 'LoadToAgent-3.1.0-portable.exe', browser_download_url: `${base}LoadToAgent-3.1.0-portable.exe`, state: 'uploaded' },
      { name: 'LoadToAgent-Setup-3.1.0.exe', browser_download_url: `${base}LoadToAgent-Setup-3.1.0.exe`, state: 'uploaded' },
      { name: 'LoadToAgent-3.1.0-arm64.dmg', browser_download_url: `${base}LoadToAgent-3.1.0-arm64.dmg`, state: 'uploaded' },
      { name: 'LoadToAgent-3.1.0-x64.dmg', browser_download_url: `${base}LoadToAgent-3.1.0-x64.dmg`, state: 'uploaded' },
      { name: 'LoadToAgent-Setup-9.9.9.exe', browser_download_url: 'https://example.com/fake.exe', state: 'uploaded' },
    ];
    assert.equal(selectReleaseAsset(assets, { platform: 'win32', arch: 'x64', version: '3.1.0' }).name, 'LoadToAgent-Setup-3.1.0.exe');
    assert.equal(selectReleaseAsset(assets, { platform: 'darwin', arch: 'arm64', version: '3.1.0' }).name, 'LoadToAgent-3.1.0-arm64.dmg');
    assert.equal(selectReleaseAsset(assets, { platform: 'linux', arch: 'x64', version: '3.1.0' }), null);
    assert.equal(selectReleaseAsset([assets[3]], { platform: 'darwin', arch: 'arm64', version: '3.1.0' }), null);
    assert.equal(selectReleaseAsset([assets[2]], { platform: 'darwin', arch: 'x64', version: '3.1.0' }), null);
    assert.equal(selectReleaseAsset([{ ...assets[1], name: 'LoadToAgent-Setup-2.9.0.exe' }], { platform: 'win32', arch: 'x64', version: '3.1.0' }), null);
    assert.equal(selectReleaseAsset([{ ...assets[1], name: 'LoadToAgent-Setup-13.1.0.exe' }], { platform: 'win32', arch: 'x64', version: '3.1.0' }), null);
    assert.equal(selectReleaseAsset([{ ...assets[1], name: 'LoadToAgent-Setup-3.1.0-ia32.exe' }], { platform: 'win32', arch: 'x64', version: '3.1.0' }), null);
    assert.equal(safeFileName('..'), '');
    assert.equal(safeFileName('.'), '');
  });

  test('최신 정식 태그를 확인하고 검증한 업데이트 파일을 저장한다', async () => {
    const downloadDir = path.join(temp, 'updates');
    const payload = Buffer.from('fixture installer payload');
    const digest = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
    const asset = {
      name: 'LoadToAgent-Setup-3.1.0.exe', size: payload.length, digest, state: 'uploaded',
      browser_download_url: 'https://github.com/minjund/LodeToAgent/releases/download/v3.1.0/LoadToAgent-Setup-3.1.0.exe',
    };
    const release = {
      tag_name: 'v3.1.0', draft: false, prerelease: false, published_at: '2026-07-16T00:00:00Z', body: 'fixture notes',
      html_url: 'https://github.com/minjund/LodeToAgent/releases/tag/v3.1.0', assets: [asset],
    };
    const opened = [];
    const manager = new UpdateManager({
      currentVersion: '3.0.0', platform: 'win32', arch: 'x64', downloadsDir: downloadDir,
      fetch: async url => String(url).includes('/releases/latest')
        ? new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } }),
      shell: { openPath: async file => { opened.push(file); return ''; }, openExternal: async () => {} },
    });
    const available = await manager.check();
    assert.equal(available.status, 'available');
    assert.equal(available.latestVersion, '3.1.0');
    assert.equal(available.asset.name, asset.name);
    const malformedSizeManager = new UpdateManager({
      currentVersion: '3.0.0', platform: 'win32', arch: 'x64', downloadsDir: downloadDir,
      fetch: async () => ({ ok: true, json: async () => ({ ...release, assets: [{ ...asset, size: 'Infinity' }] }) }),
    });
    const malformedSize = await malformedSizeManager.check();
    assert.equal(malformedSize.asset.size, 0);
    assert.equal(malformedSize.totalBytes, 0);
    const downloaded = await manager.download();
    assert.equal(downloaded.status, 'downloaded');
    assert.equal(fs.readFileSync(downloaded.downloadedPath, 'utf8'), payload.toString());
    await manager.openDownloaded();
    assert.deepStrictEqual(opened, [downloaded.downloadedPath]);

    let spawnCall = null;
    let unrefCalled = false;
    const automatic = await launchDownloadedUpdate({
      platform: 'win32', installType: 'desktop', downloadsDir: downloadDir,
      installerPath: downloaded.downloadedPath, appPath: process.execPath, parentPid: 4321,
      environment: { SystemRoot: 'C:\\Windows' },
      spawn: (command, args, options) => {
        spawnCall = { command, args, options };
        const child = new EventEmitter();
        child.pid = 9876;
        child.unref = () => { unrefCalled = true; };
        setImmediate(() => child.emit('spawn'));
        return child;
      },
    });
    assert.equal(automatic.mode, 'automatic');
    assert.equal(unrefCalled, true);
    assert.equal(spawnCall.command, path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.equal(spawnCall.options.detached, true);
    assert.equal(spawnCall.options.windowsHide, true);
    assert(spawnCall.args.includes(downloaded.downloadedPath));
    const helperSource = fs.readFileSync(automatic.helperPath, 'utf8');
    assert.match(helperSource, /Wait-Process -Id \$ParentPid/);
    assert.match(helperSource, /ArgumentList '\/S'/);
    assert.match(helperSource, /if \(\$exitCode -ne 0\)/);
    assert.match(helperSource, /updateFailed=true/);
    assert.match(helperSource, /if \(Test-Path -LiteralPath \$AppPath\)/);
    assert.match(helperSource, /Start-Process -FilePath \$AppPath/);
    assert.equal(canInstallSilently({
      platform: 'win32', installType: 'desktop', installerPath: path.join(downloadDir, 'LoadToAgent-3.1.0-portable.exe'), downloadsDir: downloadDir,
    }), false);
    assert.equal(canInstallSilently({
      platform: 'win32', installType: 'desktop', installerPath: path.join(temp, 'LoadToAgent-Setup-3.1.0.exe'), downloadsDir: downloadDir,
    }), false);

    const macBundle = path.join(temp, 'Applications', 'LoadToAgent.app');
    const macExecutable = path.join(macBundle, 'Contents', 'MacOS', 'LoadToAgent');
    const macInstaller = path.join(downloadDir, 'LoadToAgent-3.1.0-arm64.dmg');
    fs.mkdirSync(path.dirname(macExecutable), { recursive: true });
    fs.writeFileSync(macExecutable, 'fixture executable', 'utf8');
    fs.writeFileSync(macInstaller, 'fixture dmg', 'utf8');
    let macSpawnCall = null;
    let macUnrefCalled = false;
    const macAutomatic = await launchDownloadedUpdate({
      platform: 'darwin', installType: 'desktop', downloadsDir: downloadDir,
      installerPath: macInstaller, appPath: macExecutable, parentPid: 4321,
      environment: { FIXTURE: 'yes' },
      spawn: (command, args, options) => {
        macSpawnCall = { command, args, options };
        const child = new EventEmitter();
        child.pid = 9877;
        child.unref = () => { macUnrefCalled = true; };
        setImmediate(() => child.emit('spawn'));
        return child;
      },
    });
    assert.equal(macAutomatic.mode, 'automatic');
    assert.equal(macAutomatic.targetApp, macAppBundlePath(macExecutable));
    assert.equal(macUnrefCalled, true);
    assert.equal(macSpawnCall.command, macExecutable);
    assert.equal(macSpawnCall.options.detached, true);
    assert.equal(macSpawnCall.options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(macSpawnCall.options.env.FIXTURE, 'yes');
    assert(macSpawnCall.args.includes(macInstaller));
    assert(macSpawnCall.args.includes(macAutomatic.targetApp));
    assert.match(fs.readFileSync(macAutomatic.helperPath, 'utf8'), /async function installMacUpdate/);
    assert.equal(canInstallSilently({
      platform: 'darwin', installType: 'desktop', installerPath: macInstaller,
      downloadsDir: downloadDir, appPath: macExecutable,
    }), true);
    assert.equal(canInstallSilently({
      platform: 'darwin', installType: 'desktop', installerPath: macInstaller,
      downloadsDir: downloadDir, appPath: '/Volumes/LoadToAgent/LoadToAgent.app/Contents/MacOS/LoadToAgent',
    }), false);

    const manualOpened = [];
    const manual = await launchDownloadedUpdate({
      platform: 'darwin', installType: 'desktop', downloadsDir: downloadDir, installerPath: downloaded.downloadedPath,
      shell: { openPath: async file => { manualOpened.push(file); return ''; } },
    });
    assert.equal(manual.mode, 'manual');
    assert.deepStrictEqual(manualOpened, [downloaded.downloadedPath]);

    await assert.rejects(
      launchDownloadedUpdate({
        platform: 'win32', installType: 'desktop', downloadsDir: downloadDir,
        installerPath: downloaded.downloadedPath, appPath: process.execPath, parentPid: 4321,
        spawnTimeoutMs: 100,
        spawn: () => {
          const child = new EventEmitter();
          child.unref = () => {};
          setImmediate(() => child.emit('error', new Error('PowerShell unavailable')));
          return child;
        },
      }),
      /PowerShell unavailable/,
    );
  });

  test('macOS 업데이트 헬퍼가 앱을 교체하고 실패하면 원본을 복구해 재실행한다', async () => {
    async function prepareFixture(name) {
      const root = path.join(temp, name);
      const targetApp = path.join(root, 'Applications', 'LoadToAgent.app');
      const mountPath = path.join(root, 'mount');
      const dmgPath = path.join(root, 'LoadToAgent-3.1.0-arm64.dmg');
      const logPath = path.join(root, 'install-update.log');
      fs.mkdirSync(path.join(targetApp, 'Contents'), { recursive: true });
      fs.mkdirSync(mountPath, { recursive: true });
      fs.writeFileSync(path.join(targetApp, 'Contents', 'version.txt'), 'old', 'utf8');
      fs.writeFileSync(dmgPath, 'fixture dmg', 'utf8');
      return { root, targetApp, mountPath, dmgPath, logPath };
    }

    function fixtureRunner(fixture, options = {}) {
      const openedVersions = [];
      let openCount = 0;
      return {
        openedVersions,
        run: async (command, args) => {
          if (command === 'hdiutil' && args[0] === 'attach') {
            const source = path.join(fixture.mountPath, 'LoadToAgent.app', 'Contents');
            await fs.promises.mkdir(source, { recursive: true });
            await fs.promises.writeFile(path.join(source, 'version.txt'), 'new', 'utf8');
            return;
          }
          if (command === 'hdiutil' && args[0] === 'detach') return;
          if (command === 'ditto') {
            await fs.promises.cp(args[0], args[1], { recursive: true });
            return;
          }
          if (command === 'open') {
            openCount += 1;
            openedVersions.push(await fs.promises.readFile(path.join(args[1], 'Contents', 'version.txt'), 'utf8'));
            if (options.failFirstOpen && openCount === 1) throw new Error('fixture relaunch failure');
            return;
          }
          throw new Error(`unexpected fixture command: ${command}`);
        },
      };
    }

    const successful = await prepareFixture('mac-update-success');
    const successfulRunner = fixtureRunner(successful);
    await installMacUpdate({
      ...successful,
      parentPid: 1234,
      operationId: 'success',
      waitForParentExit: async pid => assert.equal(pid, 1234),
      commands: { hdiutil: 'hdiutil', ditto: 'ditto', open: 'open' },
      run: successfulRunner.run,
    });
    assert.equal(fs.readFileSync(path.join(successful.targetApp, 'Contents', 'version.txt'), 'utf8'), 'new');
    assert.deepStrictEqual(successfulRunner.openedVersions, ['new']);
    assert.match(fs.readFileSync(successful.logPath, 'utf8'), /update installed and relaunched/);

    const failed = await prepareFixture('mac-update-rollback');
    const failedRunner = fixtureRunner(failed, { failFirstOpen: true });
    await assert.rejects(
      installMacUpdate({
        ...failed,
        parentPid: 5678,
        operationId: 'rollback',
        waitForParentExit: async pid => assert.equal(pid, 5678),
        commands: { hdiutil: 'hdiutil', ditto: 'ditto', open: 'open' },
        run: failedRunner.run,
      }),
      /fixture relaunch failure/,
    );
    assert.equal(fs.readFileSync(path.join(failed.targetApp, 'Contents', 'version.txt'), 'utf8'), 'old');
    assert.deepStrictEqual(failedRunner.openedVersions, ['new', 'old']);
    assert.match(fs.readFileSync(failed.logPath, 'utf8'), /original app restored/);
    assert.match(fs.readFileSync(failed.logPath, 'utf8'), /original app relaunched/);
  });

}

function registerContextWindowTests(context) {
  const { test } = context;
  test('관측값을 우선해 컨텍스트 창을 계산한다', () => {
    assert.deepStrictEqual(modelContextWindow('codex', 'gpt-5.4', 258400), { tokens: 258400, source: 'session' });
    assert.equal(modelContextWindow('claude', 'claude-opus-4-8').tokens, 1_000_000);
    assert.equal(modelContextWindow('grok', 'grok-4.5').tokens, 500_000);
  });

}

function registerCoreUpdateWorkspaceTests(context) {
  registerProviderAndWorkspaceTests(context);
  registerCliAndUpdateTests(context);
  registerContextWindowTests(context);
}

module.exports = { registerCoreUpdateWorkspaceTests };
