'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { parseCliArguments, desktopLaunchSpec, readCodexEndpoint } = require('../../bin/whitebox');
const { providerList, normalizeProvider, modelContextWindow } = require('../../src/providerRegistry');
const { UpdateManager, compareVersions, normalizeVersion, safeFileName, selectReleaseAsset } = require('../../src/updateManager');
const {
  canInstallSilently,
  findInstalledDesktopApp,
  launchDownloadedUpdate,
  macAppBundlePath,
  readDesktopAppVersion,
  resolveInstalledDesktopApp,
  terminateWindowsUpdateProcesses,
  verifyDownloadedInstaller,
  waitForUpdateHelperReady,
  WINDOWS_UPDATE_BOOTSTRAP,
} = require('../../src/updateInstaller');
const {
  installMacUpdate,
  parseArguments: parseMacUpdateArguments,
  readBundleMetadata,
  terminateApplication,
} = require('../../src/macUpdateHelper');
const { readUpdateRelaunchRequest, signalRendererReady } = require('../../src/updateRelaunch');
const { normalizeWorkspaces, readWorkspaces, removeWorkspace, writeWorkspaces } = require('../../src/workspaceStore');
const { macPathEntries, preferredNvmBin } = require('../../src/platformPath');
const { ensureMacNodePtyRuntime, unpackedAsarPath } = require('../../src/nodePtyRuntime');
const { WINDOWS_APP_USER_MODEL_ID, registerWindowsShellIdentity } = require('../../src/windowsShellIdentity');
const afterPack = require('../after-pack');

function macHelperReadyPath(root, token) {
  return path.join(root, `install-update-macos-ready-${token}.json`);
}

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
    const unavailable = path.join(workspaceRoot, 'detached-volume', 'Project');
    fs.mkdirSync(upper, { recursive: true });
    fs.mkdirSync(lower, { recursive: true });
    fs.writeFileSync(file, 'fixture', 'utf8');

    const items = [{ path: '' }, { path: file }, { path: upper }, { path: upper }, { path: lower }, { path: unavailable }];
    assert.deepStrictEqual(normalizeWorkspaces(items, { platform: 'win32' }).map(item => item.path), [path.resolve(upper), path.resolve(unavailable)]);
    assert.deepStrictEqual(normalizeWorkspaces(items, { platform: 'linux' }).map(item => item.path), [path.resolve(upper), path.resolve(lower), path.resolve(unavailable)]);
    assert.equal(removeWorkspace([{ path: upper }], '').length, 1);
    assert.equal(removeWorkspace([{ path: upper }], upper).length, 0);

    const persistedFile = path.join(workspaceRoot, 'persisted-workspaces.json');
    const saved = writeWorkspaces(persistedFile, [{ path: unavailable, name: 'External project' }]);
    assert.deepStrictEqual(saved, [{ path: path.resolve(unavailable), name: 'External project' }]);
    assert.deepStrictEqual(readWorkspaces(persistedFile), saved);

    fs.mkdirSync(path.dirname(unavailable), { recursive: true });
    fs.writeFileSync(unavailable, 'not a workspace', 'utf8');
    assert.deepStrictEqual(readWorkspaces(persistedFile), []);
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
    assert.deepStrictEqual(parseCliArguments(['codex-endpoint']), { action: 'codex-endpoint' });
    assert.deepStrictEqual(parseCliArguments(['run', 'codex', '--', '--model', 'gpt-5']), {
      action: 'run', provider: 'codex', args: ['--model', 'gpt-5'],
    });
    assert.throws(() => parseCliArguments(['unknown']), /사용법/);
    const bridgeFile = path.join(temp, 'codex-endpoint-bridge.json');
    fs.writeFileSync(bridgeFile, JSON.stringify({
      protocol: 1,
      endpoint: 'local-bridge',
      token: 'bridge-token',
      codexAppServer: { ready: true, endpoint: 'ws://127.0.0.1:45123' },
    }), 'utf8');
    assert.equal(readCodexEndpoint(temp, { env: { WHITEBOX_BRIDGE_FILE: bridgeFile } }), 'ws://127.0.0.1:45123');
    fs.writeFileSync(bridgeFile, JSON.stringify({
      protocol: 1,
      endpoint: 'local-bridge',
      token: 'bridge-token',
      codexAppServer: { ready: true, endpoint: 'ws://example.com:45123' },
    }), 'utf8');
    assert.throws(
      () => readCodexEndpoint(temp, { env: { WHITEBOX_BRIDGE_FILE: bridgeFile } }),
      /아직 준비되지 않았습니다/,
    );
  });

  test('npm 설치본과 패키지 앱의 데스크톱 실행 경로를 만든다', () => {
    const npmSpec = desktopLaunchSpec({
      env: { PATH: '/usr/bin' },
      electronPath: '/tmp/electron',
      packageRoot: '/tmp/whitebox',
    });
    assert.equal(npmSpec.executable, '/tmp/electron');
    assert.deepStrictEqual(npmSpec.args, ['/tmp/whitebox']);
    assert.equal(npmSpec.env.PATH, '/usr/bin');

    const sourceBridgeSpec = desktopLaunchSpec({
      env: {
        PATH: 'C:\\Windows',
        ELECTRON_RUN_AS_NODE: '1',
        WHITEBOX_SOURCE_LAUNCHER: '1',
      },
      execPath: 'D:\\workspace\\node_modules\\electron\\dist\\electron.exe',
      packageRoot: 'D:\\workspace',
    });
    assert.equal(sourceBridgeSpec.executable, 'D:\\workspace\\node_modules\\electron\\dist\\electron.exe');
    assert.deepStrictEqual(sourceBridgeSpec.args, ['D:\\workspace']);
    assert.equal('ELECTRON_RUN_AS_NODE' in sourceBridgeSpec.env, false);
    assert.equal('WHITEBOX_SOURCE_LAUNCHER' in sourceBridgeSpec.env, false);

    const legacyMarkedSourceSpec = desktopLaunchSpec({
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        LOADTOAGENT_SOURCE_LAUNCHER: '1',
      },
      execPath: 'D:\\workspace\\node_modules\\electron\\dist\\electron.exe',
      packageRoot: 'D:\\workspace',
    });
    assert.deepStrictEqual(legacyMarkedSourceSpec.args, ['D:\\workspace']);
    assert.equal('LOADTOAGENT_SOURCE_LAUNCHER' in legacyMarkedSourceSpec.env, false);

    const legacySourceBridgeSpec = desktopLaunchSpec({
      env: { ELECTRON_RUN_AS_NODE: '1' },
      execPath: 'D:\\workspace\\node_modules\\electron\\dist\\electron.exe',
      packageRoot: 'D:\\workspace',
    });
    assert.deepStrictEqual(legacySourceBridgeSpec.args, ['D:\\workspace']);

    const packagedSpec = desktopLaunchSpec({
      env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
      execPath: '/Applications/Whitebox.app/Contents/MacOS/Whitebox',
    });
    assert.equal(packagedSpec.executable, '/Applications/Whitebox.app/Contents/MacOS/Whitebox');
    assert.deepStrictEqual(packagedSpec.args, []);
    assert.equal('ELECTRON_RUN_AS_NODE' in packagedSpec.env, false);
  });

  test('개발 실행판은 설치된 데스크톱 앱과 실제 설치 버전을 업데이트 대상으로 찾는다', async () => {
    const localAppData = path.join(temp, 'local-app-data');
    const installed = path.join(localAppData, 'Programs', 'Whitebox', 'Whitebox.exe');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, 'fixture executable', 'utf8');

    assert.equal(resolveInstalledDesktopApp({
      platform: 'win32', installType: 'source', appPath: path.join(temp, 'electron.exe'),
      environment: { LOCALAPPDATA: localAppData },
    }), path.resolve(installed));
    assert.equal(resolveInstalledDesktopApp({
      platform: 'win32', installType: 'portable', appPath: installed,
      environment: { LOCALAPPDATA: localAppData },
    }), '');
    assert.equal(resolveInstalledDesktopApp({
      platform: 'win32', installType: 'desktop', appPath: installed,
      environment: {},
    }), path.resolve(installed));
    assert.equal(await readDesktopAppVersion({
      platform: 'win32', appPath: installed, environment: { SystemRoot: 'C:\\Windows' },
      execFile: async (_command, _args, options) => {
        assert.equal(options.env.WHITEBOX_VERSION_PATH, installed);
        return { stdout: '1.6.6.0' };
      },
    }), '1.6.6');

    const customInstalled = path.join(temp, 'custom-install', 'Whitebox.exe');
    fs.mkdirSync(path.dirname(customInstalled), { recursive: true });
    fs.writeFileSync(customInstalled, 'custom fixture executable', 'utf8');
    assert.equal(await findInstalledDesktopApp({
      platform: 'win32', installType: 'source', appPath: path.join(temp, 'electron.exe'),
      environment: { LOCALAPPDATA: localAppData, SystemRoot: 'C:\\Windows' },
      execFile: async () => ({ stdout: `${customInstalled}\r\n` }),
    }), path.resolve(customInstalled));
  });

  test('macOS 실행 경로는 활성 PATH와 nvm 기본 버전 하나만 우선한다', () => {
    const home = path.join(temp, 'platform-path-home');
    const versions = path.join(home, '.nvm', 'versions', 'node');
    for (const version of ['v15.0.1', 'v22.16.0', 'v24.1.0']) fs.mkdirSync(path.join(versions, version, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, '.nvm', 'alias'), { recursive: true });
    fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), '24\n', 'utf8');
    const entries = macPathEntries(home, ['/active/bin', '/usr/bin'].join(path.delimiter));
    assert.deepStrictEqual(entries.slice(0, 2), ['/active/bin', '/usr/bin']);
    assert.equal(preferredNvmBin(home), path.join(versions, 'v24.1.0', 'bin'));
    assert(entries.includes(path.join(versions, 'v24.1.0', 'bin')));
    assert(!entries.includes(path.join(versions, 'v15.0.1', 'bin')));
    assert(!entries.includes(path.join(versions, 'v22.16.0', 'bin')));
  });

  test('앱 패키징 후 현재 OS·CPU의 node-pty 런타임만 남기고 macOS helper 권한을 검증한다', async () => {
    const fixtureFiles = [
      'LICENSE',
      'README.md',
      'binding.gyp',
      'build/Release/conpty/conpty.dll',
      'build/Release/conpty/OpenConsole.exe',
      'lib/conpty_console_list_agent.js',
      'lib/eventEmitter2.js',
      'lib/index.js',
      'lib/interfaces.js',
      'lib/shared/conout.js',
      'lib/terminal.js',
      'lib/types.js',
      'lib/unixTerminal.js',
      'lib/utils.js',
      'lib/worker/conoutSocketWorker.js',
      'lib/windowsConoutConnection.js',
      'lib/windowsPtyAgent.js',
      'lib/windowsTerminal.js',
      'lib/index.js.map',
      'package.json',
      'prebuilds/darwin-arm64/pty.node',
      'prebuilds/darwin-arm64/spawn-helper',
      'prebuilds/darwin-x64/pty.node',
      'prebuilds/darwin-x64/spawn-helper',
      'prebuilds/linux-arm64/pty.node',
      'prebuilds/linux-x64/pty.node',
      'prebuilds/win32-arm64/conpty.node',
      'prebuilds/win32-arm64/conpty_console_list.node',
      'prebuilds/win32-arm64/conpty/conpty.dll',
      'prebuilds/win32-arm64/conpty/OpenConsole.exe',
      'prebuilds/win32-x64/conpty.node',
      'prebuilds/win32-x64/conpty.pdb',
      'prebuilds/win32-x64/conpty_console_list.node',
      'prebuilds/win32-x64/conpty_console_list.pdb',
      'prebuilds/win32-x64/conpty/conpty.dll',
      'prebuilds/win32-x64/conpty/OpenConsole.exe',
      'scripts/post-install.js',
      'src/win/conpty.h',
      'third_party/conpty/version/win10-x64/conpty.dll',
      'third_party/conpty/version/win10-x64/OpenConsole.exe',
      'typings/node-pty.d.ts',
    ];
    const createFixture = (name, platform) => {
      const appOutDir = path.join(temp, name);
      const resources = platform === 'darwin'
        ? path.join(appOutDir, 'Whitebox.app', 'Contents', 'Resources')
        : path.join(appOutDir, 'resources');
      const packageRoot = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty');
      for (const relative of fixtureFiles) {
        const file = path.join(packageRoot, ...relative.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `fixture:${relative}`, 'utf8');
      }
      return { appOutDir, packageRoot };
    };
    const relativeFiles = packageRoot => {
      const files = [];
      const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(target);
          else if (entry.isFile()) files.push(path.relative(packageRoot, target).replaceAll('\\', '/'));
        }
      };
      visit(packageRoot);
      return files.sort();
    };
    const contextFor = (fixture, platform, arch) => ({
      electronPlatformName: platform,
      arch,
      appOutDir: fixture.appOutDir,
      packager: { appInfo: { productFilename: 'Whitebox' } },
    });

    const windows = createFixture('win-after-pack', 'win32');
    const windowsResult = await afterPack(contextFor(windows, 'win32', 1));
    assert.equal(windowsResult.prebuildName, 'win32-x64');
    assert.deepStrictEqual(relativeFiles(windows.packageRoot), [
      'LICENSE',
      'lib/conpty_console_list_agent.js',
      'lib/eventEmitter2.js',
      'lib/index.js',
      'lib/interfaces.js',
      'lib/shared/conout.js',
      'lib/terminal.js',
      'lib/types.js',
      'lib/unixTerminal.js',
      'lib/utils.js',
      'lib/worker/conoutSocketWorker.js',
      'lib/windowsConoutConnection.js',
      'lib/windowsPtyAgent.js',
      'lib/windowsTerminal.js',
      'package.json',
      'prebuilds/win32-x64/conpty.node',
      'prebuilds/win32-x64/conpty/conpty.dll',
      'prebuilds/win32-x64/conpty/OpenConsole.exe',
      'prebuilds/win32-x64/conpty_console_list.node',
    ].sort());

    const mac = createFixture('mac-after-pack', 'darwin');
    const helper = path.join(mac.packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    const helperMode = fs.statSync(helper).mode;
    const calls = { chmod: [], access: [] };
    const fileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'chmodSync') {
          return (file, mode) => { calls.chmod.push({ file, mode }); };
        }
        if (property === 'accessSync') {
          return (file, mode) => { calls.access.push({ file, mode }); };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const macResult = await afterPack(contextFor(mac, 'darwin', 3), fileSystem);
    assert.equal(macResult.prebuildName, 'darwin-arm64');
    assert.deepStrictEqual(macResult.helpers, [helper]);
    assert.deepStrictEqual(relativeFiles(mac.packageRoot), [
      'LICENSE',
      'lib/conpty_console_list_agent.js',
      'lib/eventEmitter2.js',
      'lib/index.js',
      'lib/interfaces.js',
      'lib/shared/conout.js',
      'lib/terminal.js',
      'lib/types.js',
      'lib/unixTerminal.js',
      'lib/utils.js',
      'lib/worker/conoutSocketWorker.js',
      'lib/windowsConoutConnection.js',
      'lib/windowsPtyAgent.js',
      'lib/windowsTerminal.js',
      'package.json',
      'prebuilds/darwin-arm64/pty.node',
      'prebuilds/darwin-arm64/spawn-helper',
    ].sort());
    assert.deepStrictEqual(calls.chmod, [{ file: helper, mode: helperMode | 0o111 }]);
    assert.deepStrictEqual(calls.access, [{ file: helper, mode: fs.constants.X_OK }]);

    const broken = createFixture('broken-after-pack', 'win32');
    const missingAddon = path.join(broken.packageRoot, 'prebuilds', 'win32-x64', 'conpty.node');
    fs.rmSync(missingAddon);
    await assert.rejects(
      afterPack(contextFor(broken, 'win32', 1)),
      /필수 win32-x64 런타임 파일을 찾을 수 없습니다/,
    );
    assert.equal(fs.existsSync(path.join(broken.packageRoot, 'src', 'win', 'conpty.h')), true);

    const missingPrebuild = createFixture('missing-prebuild-after-pack', 'darwin');
    fs.rmSync(path.join(missingPrebuild.packageRoot, 'prebuilds', 'darwin-x64'), { recursive: true });
    await assert.rejects(
      afterPack(contextFor(missingPrebuild, 'darwin', 1)),
      /darwin-x64 prebuild 디렉터리를 찾을 수 없습니다/,
    );
  });

  test('패키지된 Windows 앱은 작업 표시줄 아이콘 ID와 실행 파일을 등록한다', async () => {
    const calls = [];
    const execFile = (command, args, options, callback) => {
      calls.push({ command, args, options });
      setImmediate(() => callback(null, '', ''));
    };
    const executable = 'C:\\Program Files\\Whitebox\\Whitebox.exe';
    const result = await registerWindowsShellIdentity({
      platform: 'win32',
      executable,
      systemRoot: 'C:\\Windows',
      execFile,
    });
    assert.equal(result.registered, true);
    assert.equal(result.refreshed, true);
    assert.equal(result.appId, WINDOWS_APP_USER_MODEL_ID);
    assert.equal(calls.length, 3);
    assert.deepStrictEqual(calls[0].args, [
      'ADD', `HKCU\\Software\\Classes\\AppUserModelId\\${WINDOWS_APP_USER_MODEL_ID}`,
      '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Whitebox', '/f',
    ]);
    assert.deepStrictEqual(calls[1].args, [
      'ADD', `HKCU\\Software\\Classes\\AppUserModelId\\${WINDOWS_APP_USER_MODEL_ID}`,
      '/v', 'IconUri', '/t', 'REG_SZ', '/d', path.resolve(executable), '/f',
    ]);
    assert.match(calls[2].command, /ie4uinit\.exe$/i);
    assert.deepStrictEqual(calls[2].args, ['-show']);

    const skipped = await registerWindowsShellIdentity({
      platform: 'win32', enabled: false, executable, execFile,
    });
    assert.deepStrictEqual(skipped, { registered: false, refreshed: false });
    assert.equal(calls.length, 3);
  });

  test('macOS node-pty 런타임은 현재 아키텍처 helper 권한과 ASAR 경로를 자가 복구한다', () => {
    const packageFile = '/Applications/Whitebox.app/Contents/Resources/app.asar/node_modules/node-pty/package.json';
    const packageRoot = '/Applications/Whitebox.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty';
    const helper = path.join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    const addon = path.join(packageRoot, 'prebuilds', 'darwin-arm64', 'pty.node');
    let executable = false;
    const chmodCalls = [];
    const fileSystem = {
      constants: { X_OK: 1 },
      statSync: file => {
        assert.ok(file === helper || file === addon);
        return { isFile: () => true, mode: file === helper ? 0o100644 : 0o100644 };
      },
      accessSync: (file, mode) => {
        assert.equal(file, helper);
        assert.equal(mode, 1);
        if (!executable) throw Object.assign(new Error('not executable'), { code: 'EACCES' });
      },
      chmodSync: (file, mode) => {
        chmodCalls.push({ file, mode });
        executable = true;
      },
    };
    const result = ensureMacNodePtyRuntime({
      platform: 'darwin',
      arch: 'arm64',
      fileSystem,
      resolvePackage: () => packageFile,
    });
    assert.equal(result.repaired, true);
    assert.deepStrictEqual(result.files, { packageRoot, helper, addon });
    assert.deepStrictEqual(chmodCalls, [{ file: helper, mode: 0o100755 }]);
    assert.equal(unpackedAsarPath(packageRoot), packageRoot);
    assert.equal(unpackedAsarPath(packageFile), `${packageRoot}/package.json`);
  });

  test('업데이트 재실행은 렌더러 준비 신호를 검증된 파일에 기록한다', async () => {
    const signalRoot = path.join(temp, 'update-renderer-ready');
    const token = 'a'.repeat(48);
    const readyPath = path.join(signalRoot, `install-renderer-ready-${token}.json`);
    const environment = {
      WHITEBOX_UPDATE_READY_PATH: readyPath,
      WHITEBOX_UPDATE_READY_TOKEN: token,
    };
    assert.deepStrictEqual(readUpdateRelaunchRequest(environment), { readyPath, token });
    const result = await signalRendererReady({
      environment,
      pid: 4321,
      version: '3.1.0',
      now: () => new Date('2026-07-31T09:00:00.000Z'),
    });
    assert.deepStrictEqual(result, { signaled: true, readyPath });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(readyPath, 'utf8')), {
      token,
      pid: 4321,
      version: '3.1.0',
      rendererReadyAt: '2026-07-31T09:00:00.000Z',
    });
    assert.equal('WHITEBOX_UPDATE_READY_PATH' in environment, false);
    assert.equal('WHITEBOX_UPDATE_READY_TOKEN' in environment, false);
    const legacyToken = 'c'.repeat(48);
    const legacyReadyPath = path.join(signalRoot, `install-renderer-ready-${legacyToken}.json`);
    const legacyEnvironment = {
      LOADTOAGENT_UPDATE_READY_PATH: legacyReadyPath,
      LOADTOAGENT_UPDATE_READY_TOKEN: legacyToken,
    };
    assert.deepStrictEqual(readUpdateRelaunchRequest(legacyEnvironment), {
      readyPath: legacyReadyPath,
      token: legacyToken,
    });
    assert.deepStrictEqual(await signalRendererReady({
      environment: legacyEnvironment,
      pid: 4323,
      version: '3.1.0',
    }), { signaled: true, readyPath: legacyReadyPath });
    assert.equal('LOADTOAGENT_UPDATE_READY_PATH' in legacyEnvironment, false);
    assert.equal('LOADTOAGENT_UPDATE_READY_TOKEN' in legacyEnvironment, false);
    const directReadyPath = path.join(signalRoot, `install-renderer-ready-${'b'.repeat(48)}.json`);
    assert.deepStrictEqual(await signalRendererReady({
      request: { readyPath: directReadyPath, token: 'b'.repeat(48) },
      environment: {},
      pid: 4322,
      version: '3.1.0',
    }), { signaled: true, readyPath: directReadyPath });
    assert.equal(readUpdateRelaunchRequest({
      WHITEBOX_UPDATE_READY_PATH: path.join(signalRoot, 'unexpected.json'),
      WHITEBOX_UPDATE_READY_TOKEN: token,
    }), null);
    assert.deepStrictEqual(await signalRendererReady({ environment: {} }), { signaled: false, readyPath: '' });
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
    const base = 'https://github.com/minjund/Whitebox/releases/download/v3.1.0/';
    const assets = [
      { name: 'Whitebox-3.1.0-portable.exe', browser_download_url: `${base}Whitebox-3.1.0-portable.exe`, state: 'uploaded' },
      { name: 'Whitebox-Setup-3.1.0.exe', browser_download_url: `${base}Whitebox-Setup-3.1.0.exe`, state: 'uploaded' },
      { name: 'Whitebox-3.1.0-arm64.dmg', browser_download_url: `${base}Whitebox-3.1.0-arm64.dmg`, state: 'uploaded' },
      { name: 'Whitebox-3.1.0-x64.dmg', browser_download_url: `${base}Whitebox-3.1.0-x64.dmg`, state: 'uploaded' },
      { name: 'Whitebox-Setup-9.9.9.exe', browser_download_url: 'https://example.com/fake.exe', state: 'uploaded' },
    ];
    assert.equal(selectReleaseAsset(assets, { platform: 'win32', arch: 'x64', version: '3.1.0' }).name, 'Whitebox-Setup-3.1.0.exe');
    assert.equal(selectReleaseAsset(assets, { platform: 'darwin', arch: 'arm64', version: '3.1.0' }).name, 'Whitebox-3.1.0-arm64.dmg');
    assert.equal(selectReleaseAsset(assets, { platform: 'linux', arch: 'x64', version: '3.1.0' }), null);
    assert.equal(selectReleaseAsset([assets[3]], { platform: 'darwin', arch: 'arm64', version: '3.1.0' }), null);
    assert.equal(selectReleaseAsset([assets[2]], { platform: 'darwin', arch: 'x64', version: '3.1.0' }), null);
    assert.equal(selectReleaseAsset([{ ...assets[1], name: 'Whitebox-Setup-2.9.0.exe' }], { platform: 'win32', arch: 'x64', version: '3.1.0' }), null);
    assert.equal(selectReleaseAsset([{ ...assets[1], name: 'Whitebox-Setup-13.1.0.exe' }], { platform: 'win32', arch: 'x64', version: '3.1.0' }), null);
    assert.equal(selectReleaseAsset([{ ...assets[1], name: 'Whitebox-Setup-3.1.0-ia32.exe' }], { platform: 'win32', arch: 'x64', version: '3.1.0' }), null);
    const legacyBase = 'https://github.com/minjund/LodeToAgent/releases/download/v3.1.0/';
    assert.equal(selectReleaseAsset([{
      name: 'LoadToAgent-Setup-3.1.0.exe',
      browser_download_url: `${legacyBase}LoadToAgent-Setup-3.1.0.exe`,
      state: 'uploaded',
    }], { platform: 'win32', arch: 'x64', version: '3.1.0' }).name, 'LoadToAgent-Setup-3.1.0.exe');
    assert.equal(safeFileName('..'), '');
    assert.equal(safeFileName('.'), '');
  });

  test('최신 정식 태그를 확인하고 검증한 업데이트 파일을 저장한다', async () => {
    const downloadDir = path.join(temp, 'updates');
    const payload = Buffer.from('fixture installer payload');
    const digest = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
    const asset = {
      name: 'Whitebox-Setup-3.1.0.exe', size: payload.length, digest, state: 'uploaded',
      browser_download_url: 'https://github.com/minjund/Whitebox/releases/download/v3.1.0/Whitebox-Setup-3.1.0.exe',
    };
    const release = {
      tag_name: 'v3.1.0', draft: false, prerelease: false, published_at: '2026-07-16T00:00:00Z', body: 'fixture notes',
      html_url: 'https://github.com/minjund/Whitebox/releases/tag/v3.1.0', assets: [asset],
    };
    let blockedFetchCalled = false;
    const blockedManager = new UpdateManager({
      currentVersion: '9.0.0', currentVersionKnown: false, blockedReason: 'fixture installed version unavailable',
      platform: 'win32', arch: 'x64', downloadsDir: downloadDir,
      fetch: async () => { blockedFetchCalled = true; throw new Error('must not fetch'); },
    });
    const blockedState = await blockedManager.check();
    assert.equal(blockedState.status, 'error');
    assert.equal(blockedState.currentVersionKnown, false);
    assert.equal(blockedState.blocked, true);
    assert.equal(blockedState.error, 'fixture installed version unavailable');
    assert.equal(blockedFetchCalled, false);
    await assert.rejects(blockedManager.download(), /fixture installed version unavailable/);
    let transientAttempts = 0;
    const transientManager = new UpdateManager({
      currentVersion: '3.1.0', platform: 'win32', arch: 'x64', downloadsDir: downloadDir,
      fetch: async () => {
        transientAttempts += 1;
        return transientAttempts === 1
          ? new Response('temporarily unavailable', { status: 503, headers: { 'x-ratelimit-remaining': '4' } })
          : new Response(JSON.stringify(release), { status: 200 });
      },
    });
    const silentFailure = await transientManager.check({ surfaceError: false });
    assert.equal(silentFailure.status, 'idle', '시작 시 일시 오류를 영구 실패 화면으로 노출하면 안 됩니다.');
    assert.equal(silentFailure.error, '');
    const recoveredCheck = await transientManager.check();
    assert.equal(recoveredCheck.status, 'current');
    assert.equal(recoveredCheck.latestVersion, '3.1.0');
    const manualFailureManager = new UpdateManager({
      currentVersion: '3.1.0', platform: 'win32', arch: 'x64', downloadsDir: downloadDir,
      fetch: async () => new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    });
    const manualFailure = await manualFailureManager.check();
    assert.equal(manualFailure.status, 'error');
    assert.match(manualFailure.error, /HTTP 403/);
    let resolveConcurrentFetch;
    const concurrentResponse = new Promise(resolve => { resolveConcurrentFetch = resolve; });
    const concurrentManager = new UpdateManager({
      currentVersion: '3.1.0', platform: 'win32', arch: 'x64', downloadsDir: downloadDir,
      fetch: async () => concurrentResponse,
    });
    const startupCheck = concurrentManager.check({ surfaceError: false });
    const manualCheck = concurrentManager.check();
    resolveConcurrentFetch(new Response('temporarily unavailable', { status: 503 }));
    const [startupJoined, manualJoined] = await Promise.all([startupCheck, manualCheck]);
    assert.equal(startupJoined.status, 'error', '진행 중인 시작 확인에 수동 확인이 합류하면 오류 표시 요청을 승격해야 합니다.');
    assert.equal(manualJoined.status, 'error');
    assert.match(manualJoined.error, /HTTP 503/);
    const opened = [];
    const manager = new UpdateManager({
      currentVersion: '3.0.0', platform: 'win32', arch: 'x64', downloadsDir: downloadDir,
      installMode: 'automatic',
      fetch: async url => String(url).includes('/releases/latest')
        ? new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } }),
      shell: { openPath: async file => { opened.push(file); return ''; }, openExternal: async () => {} },
      verifyInstaller: async () => {},
    });
    const available = await manager.check();
    assert.equal(available.status, 'available');
    assert.equal(available.latestVersion, '3.1.0');
    assert.equal(available.asset.name, asset.name);
    assert.equal(available.installMode, 'automatic');
    const malformedSizeManager = new UpdateManager({
      currentVersion: '3.0.0', platform: 'win32', arch: 'x64', downloadsDir: downloadDir,
      fetch: async () => new Response(JSON.stringify({ ...release, assets: [{ ...asset, size: 'Infinity' }] }), { status: 200 }),
    });
    const malformedSize = await malformedSizeManager.check();
    assert.equal(malformedSize.asset.size, 0);
    assert.equal(malformedSize.totalBytes, 0);
    const missingDigestManager = new UpdateManager({
      currentVersion: '3.0.0', platform: 'win32', arch: 'x64', downloadsDir: downloadDir,
      fetch: async () => new Response(JSON.stringify({ ...release, assets: [{ ...asset, digest: '' }] }), { status: 200 }),
    });
    const missingDigest = await missingDigestManager.check();
    assert.equal(missingDigest.asset, null);
    assert.match(missingDigest.error, /원본인지 확인할 안전 정보/);
    const downloaded = await manager.download();
    assert.equal(downloaded.status, 'downloaded');
    assert.equal(fs.readFileSync(downloaded.downloadedPath, 'utf8'), payload.toString());
    await manager.openDownloaded();
    assert.deepStrictEqual(opened, [downloaded.downloadedPath]);

    let spawnCall = null;
    let unrefCalled = false;
    let beforeAutomaticInstall = null;
    const verifiedInstallers = [];
    const verifyInstaller = async options => { verifiedInstallers.push(options); };
    const automatic = await launchDownloadedUpdate({
      platform: 'win32', installType: 'desktop', downloadsDir: downloadDir,
      installerPath: downloaded.downloadedPath, appPath: process.execPath, parentPid: 4321,
      expectedVersion: '3.1.0',
      environment: { SystemRoot: 'C:\\Windows' },
      allowUnsignedWindowsUpdates: true,
      verifyInstaller,
      waitForReady: async readyPath => {
        const tokenIndex = spawnCall.args.indexOf('-RendererReadyToken');
        const token = spawnCall.args[tokenIndex + 1];
        assert.equal(path.basename(readyPath), `install-update-ready-${token}.json`);
        return { helperPid: 2468, token };
      },
      beforeAutomaticInstall: async context => { beforeAutomaticInstall = context; },
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
    assert.deepStrictEqual(beforeAutomaticInstall, { platform: 'win32', helperPid: 2468 });
    assert.equal(verifiedInstallers[0].installerPath, downloaded.downloadedPath);
    assert.equal(verifiedInstallers[0].allowUnsignedWindowsUpdates, true);
    assert.equal(spawnCall.command, path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.equal(spawnCall.options.detached, false);
    assert.equal(spawnCall.options.windowsHide, true);
    assert(spawnCall.args.includes(downloaded.downloadedPath));
    assert(spawnCall.args.includes('3.1.0'));
    assert(spawnCall.args.includes('-HelperPath'));
    assert(spawnCall.args.includes(automatic.helperPath));
    assert(spawnCall.args.includes(automatic.bootstrapPath));
    assert(spawnCall.args.includes('-ReadyPath'));
    assert(spawnCall.args.includes(automatic.readyPath));
    assert(spawnCall.args.includes('-RendererReadyPath'));
    assert(spawnCall.args.includes(automatic.rendererReadyPath));
    assert(spawnCall.args.includes('-RendererReadyToken'));
    assert(spawnCall.args.includes(automatic.rendererReadyToken));
    assert.equal(path.basename(automatic.rendererReadyPath), `install-renderer-ready-${automatic.rendererReadyToken}.json`);
    assert.match(automatic.rendererReadyToken, /^[0-9a-f]{48}$/);
    assert.match(WINDOWS_UPDATE_BOOTSTRAP, /Start-Process -FilePath \(Join-Path \$PSHOME 'powershell\.exe'\)/);
    assert.match(WINDOWS_UPDATE_BOOTSTRAP, /Test-Path -LiteralPath \$ReadyPath/);
    assert.match(WINDOWS_UPDATE_BOOTSTRAP, /\$readySignal\.helperPid -ne \$helperProcess\.Id/);
    assert.match(WINDOWS_UPDATE_BOOTSTRAP, /Stop-Process -Id \$helperProcess\.Id -Force/);
    assert.match(WINDOWS_UPDATE_BOOTSTRAP, /'-RendererReadyPath'/);
    assert.match(WINDOWS_UPDATE_BOOTSTRAP, /'-RendererReadyToken'/);
    assert.match(WINDOWS_UPDATE_BOOTSTRAP, /bootstrapError=/);
    assert.deepStrictEqual([...fs.readFileSync(automatic.helperPath).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.deepStrictEqual([...fs.readFileSync(automatic.bootstrapPath).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const helperSource = fs.readFileSync(automatic.helperPath, 'utf8');
    assert.match(helperSource, /Set-Content -LiteralPath \$readyTemporary/);
    assert.match(helperSource, /Move-Item -LiteralPath \$readyTemporary -Destination \$ReadyPath -Force/);
    assert.match(helperSource, /helperPid = \$PID; token = \$RendererReadyToken/);
    assert.match(helperSource, /helperStarted=true;parentPid=/);
    assert.match(helperSource, /Get-CimInstance Win32_Process -ErrorAction Stop/);
    assert.match(helperSource, /\[string\]\$_.ExecutablePath -ieq \$ExecutablePath/);
    assert.match(helperSource, /processLookupError=.*\n\s*throw/);
    assert.match(helperSource, /function Wait-ForAppProcessesToStop/);
    assert.match(helperSource, /if \(\$remaining\.Count -eq 0\)/);
    assert.match(helperSource, /if \(\$remaining\.Count -ne 0\)/);
    assert.match(helperSource, /Whitebox 프로세스 종료를 확인하지 못했습니다/);
    assert.match(helperSource, /Stop-AppProcesses \$AppPath 'stoppingOrphanProcess'/);
    assert.match(helperSource, /Wait-ForAppProcessesToStop \$AppPath 10000/);
    const stopAppProcessesIndex = helperSource.indexOf("Stop-AppProcesses $AppPath 'stoppingOrphanProcess'");
    const confirmAppProcessesStoppedIndex = helperSource.indexOf('Wait-ForAppProcessesToStop $AppPath 10000');
    const installerStartIndex = helperSource.indexOf("Start-Process -FilePath $InstallerPath -ArgumentList '/S'");
    assert(stopAppProcessesIndex >= 0 && stopAppProcessesIndex < confirmAppProcessesStoppedIndex);
    assert(confirmAppProcessesStoppedIndex < installerStartIndex);
    assert.match(helperSource, /ArgumentList '\/S'/);
    assert.match(helperSource, /if \(\$exitCode -ne 0\)/);
    assert.match(helperSource, /updateFailed=true/);
    assert.match(helperSource, /Find-InstalledApp \$AppPath \$ExpectedVersion/);
    assert.match(helperSource, /Start-Process -FilePath \$launchPath/);
    assert.match(helperSource, /function Renderer-IsReady/);
    assert.match(helperSource, /function Restore-AppWindow/);
    assert.match(helperSource, /WHITEBOX_UPDATE_READY_PATH/);
    assert.match(helperSource, /rendererReady=true/);
    assert.match(helperSource, /rendererReadyTimeout=true/);
    assert.match(helperSource, /relaunchReady=true/);
    assert.match(helperSource, /\$verifiedUpdatedApp = \$exitCode -eq 0 -and \$installedVersion -eq \$ExpectedVersion/);
    assert.match(helperSource, /recoveryRelaunchStarted=true/);
    assert.match(helperSource, /versionMismatch=true/);
    if (process.platform === 'win32') {
      const parserScript = [
        '$helperErrors = $null',
        '$bootstrapErrors = $null',
        '[void][System.Management.Automation.Language.Parser]::ParseFile($env:WHITEBOX_HELPER_PATH, [ref]$null, [ref]$helperErrors)',
        '[void][System.Management.Automation.Language.Parser]::ParseFile($env:WHITEBOX_BOOTSTRAP_PATH, [ref]$null, [ref]$bootstrapErrors)',
        'if ($helperErrors.Count -or $bootstrapErrors.Count) {',
        "  throw ('PowerShell parse errors: ' + (($helperErrors + $bootstrapErrors | ForEach-Object Message) -join '; '))",
        '}',
      ].join('; ');
      execFileSync(path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        parserScript,
      ], {
        windowsHide: true,
        env: {
          ...process.env,
          WHITEBOX_HELPER_PATH: automatic.helperPath,
          WHITEBOX_BOOTSTRAP_PATH: automatic.bootstrapPath,
        },
      });
    }
    const readyFixture = path.join(downloadDir, 'helper-ready-test');
    const readyChild = new EventEmitter();
    setTimeout(() => fs.writeFileSync(readyFixture, 'ready', 'utf8'), 20);
    await waitForUpdateHelperReady(readyFixture, readyChild, 500);
    fs.rmSync(readyFixture, { force: true });
    const authenticatedToken = '8'.repeat(48);
    const authenticatedReady = path.join(downloadDir, `helper-ready-${authenticatedToken}.json`);
    const authenticatedChild = new EventEmitter();
    authenticatedChild.pid = 7_654;
    setTimeout(() => fs.writeFileSync(authenticatedReady, `\uFEFF${JSON.stringify({
      helperPid: authenticatedChild.pid,
      token: authenticatedToken,
    })}`, 'utf8'), 20);
    const authenticatedSignal = await waitForUpdateHelperReady(authenticatedReady, authenticatedChild, 500, {
      pid: authenticatedChild.pid,
      token: authenticatedToken,
    });
    assert.deepStrictEqual(authenticatedSignal, { helperPid: authenticatedChild.pid, token: authenticatedToken });
    fs.rmSync(authenticatedReady, { force: true });
    const mismatchedReady = path.join(downloadDir, `helper-ready-mismatch-${authenticatedToken}.json`);
    fs.writeFileSync(mismatchedReady, JSON.stringify({ helperPid: 1, token: authenticatedToken }), 'utf8');
    await assert.rejects(
      waitForUpdateHelperReady(mismatchedReady, authenticatedChild, 500, {
        pid: authenticatedChild.pid,
        token: authenticatedToken,
      }),
      /준비 신호가 올바르지 않습니다/,
    );
    fs.rmSync(mismatchedReady, { force: true });
    const exitedChild = new EventEmitter();
    const exitedWait = waitForUpdateHelperReady(path.join(downloadDir, 'never-ready'), exitedChild, 500);
    setImmediate(() => exitedChild.emit('exit', 41));
    await assert.rejects(exitedWait, /준비되기 전에 종료.*41/);
    const killedHelpers = [];
    let failedReadyToken = '';
    await assert.rejects(launchDownloadedUpdate({
      platform: 'win32', installType: 'desktop', downloadsDir: downloadDir,
      installerPath: downloaded.downloadedPath, appPath: process.execPath, parentPid: 4321,
      expectedVersion: '3.1.0', environment: { SystemRoot: 'C:\\Windows' }, verifyInstaller,
      waitForReady: async () => ({ helperPid: 3579, token: failedReadyToken }),
      beforeAutomaticInstall: async () => { throw new Error('fixture terminal shutdown failure'); },
      killProcessTree: async pid => { killedHelpers.push(pid); },
      processExists: () => false,
      spawn: (_command, args) => {
        failedReadyToken = args[args.indexOf('-RendererReadyToken') + 1];
        const child = new EventEmitter();
        child.pid = 3580;
        child.kill = () => {};
        child.unref = () => {};
        setImmediate(() => child.emit('spawn'));
        return child;
      },
    }), /fixture terminal shutdown failure/);
    assert.deepStrictEqual(killedHelpers, [3579, 3580]);
    assert.equal(fs.existsSync(path.join(downloadDir, `install-update-${failedReadyToken}.ps1`)), false);
    assert.equal(fs.existsSync(path.join(downloadDir, `install-update-bootstrap-${failedReadyToken}.ps1`)), false);
    const killedBootstrapTrees = [];
    await assert.rejects(launchDownloadedUpdate({
      platform: 'win32', installType: 'desktop', downloadsDir: downloadDir,
      installerPath: downloaded.downloadedPath, appPath: process.execPath, parentPid: 4321,
      expectedVersion: '3.1.0', environment: { SystemRoot: 'C:\\Windows' }, verifyInstaller,
      waitForReady: async () => { throw new Error('fixture helper readiness timeout'); },
      killProcessTree: async pid => { killedBootstrapTrees.push(pid); },
      processExists: () => false,
      spawn: () => {
        const child = new EventEmitter();
        child.pid = 3581;
        child.unref = () => {};
        setImmediate(() => child.emit('spawn'));
        return child;
      },
    }), /fixture helper readiness timeout/);
    assert.deepStrictEqual(killedBootstrapTrees, [3581]);

    const fallbackSignals = [];
    let fallbackProbe = 0;
    assert.deepStrictEqual(await terminateWindowsUpdateProcesses([3_590], {
      killProcessTree: async () => { throw new Error('fixture taskkill failure'); },
      killProcess: (pid, signal) => fallbackSignals.push([pid, signal]),
      processExists: () => (++fallbackProbe === 1),
      delay: async () => {},
      terminationTimeoutMs: 20,
    }), { ok: true, pids: [3_590] });
    assert.deepStrictEqual(fallbackSignals, [[3_590, 'SIGTERM']]);
    await terminateWindowsUpdateProcesses([3_591], {
      killProcessTree: async () => {},
      processExists: () => { throw Object.assign(new Error('already gone'), { code: 'ESRCH' }); },
    });
    let liveClock = 0;
    await assert.rejects(terminateWindowsUpdateProcesses([3_592], {
      killProcessTree: async () => {},
      processExists: () => { throw Object.assign(new Error('access denied'), { code: 'EPERM' }); },
      now: () => liveClock,
      delay: async milliseconds => { liveClock += milliseconds; },
      terminationTimeoutMs: 5,
      terminationPollMs: 1,
    }), error => error.code === 'UPDATE_HELPER_CANCELLATION_UNCONFIRMED' && error.pids[0] === 3_592);
    await assert.rejects(terminateWindowsUpdateProcesses([3_593], {
      killProcessTree: async () => {},
      processExists: () => { throw Object.assign(new Error('lookup failed'), { code: 'EIO' }); },
    }), error => error.code === 'UPDATE_HELPER_PROCESS_PROBE_FAILED');

    let unconfirmedReadyToken = '';
    let unconfirmedClock = 0;
    let unconfirmedError = null;
    try {
      await launchDownloadedUpdate({
        platform: 'win32', installType: 'desktop', downloadsDir: downloadDir,
        installerPath: downloaded.downloadedPath, appPath: process.execPath, parentPid: 4321,
        expectedVersion: '3.1.0', environment: { SystemRoot: 'C:\\Windows' }, verifyInstaller,
        waitForReady: async () => ({ helperPid: 3_594, token: unconfirmedReadyToken }),
        beforeAutomaticInstall: async () => { throw new Error('fixture shutdown rejected'); },
        killProcessTree: async () => {},
        processExists: () => true,
        now: () => unconfirmedClock,
        delay: async milliseconds => { unconfirmedClock += milliseconds; },
        terminationTimeoutMs: 1,
        spawn: (_command, args) => {
          unconfirmedReadyToken = args[args.indexOf('-RendererReadyToken') + 1];
          const child = new EventEmitter();
          child.pid = 3_595;
          child.unref = () => {};
          setImmediate(() => child.emit('spawn'));
          return child;
        },
      });
    } catch (error) {
      unconfirmedError = error;
    }
    assert(unconfirmedError);
    assert.equal(unconfirmedError.code, 'UPDATE_HELPER_CANCELLATION_UNCONFIRMED');
    assert.match(unconfirmedError.message, /fixture shutdown rejected/);
    assert.equal(fs.existsSync(path.join(downloadDir, `install-update-${unconfirmedReadyToken}.ps1`)), true);
    assert.equal(fs.existsSync(path.join(downloadDir, `install-update-bootstrap-${unconfirmedReadyToken}.ps1`)), true);
    fs.rmSync(path.join(downloadDir, `install-update-${unconfirmedReadyToken}.ps1`), { force: true });
    fs.rmSync(path.join(downloadDir, `install-update-bootstrap-${unconfirmedReadyToken}.ps1`), { force: true });
    assert.equal(canInstallSilently({
      platform: 'win32', installType: 'desktop', installerPath: path.join(downloadDir, 'Whitebox-3.1.0-portable.exe'), downloadsDir: downloadDir,
    }), false);
    assert.equal(canInstallSilently({
      platform: 'win32', installType: 'desktop', installerPath: path.join(temp, 'Whitebox-Setup-3.1.0.exe'), downloadsDir: downloadDir,
    }), false);

    const macBundle = path.join(temp, 'Applications', 'Whitebox.app');
    const macExecutable = path.join(macBundle, 'Contents', 'MacOS', 'Whitebox');
    const macInstaller = path.join(downloadDir, 'Whitebox-3.1.0-arm64.dmg');
    fs.mkdirSync(path.dirname(macExecutable), { recursive: true });
    fs.writeFileSync(macExecutable, 'fixture executable', 'utf8');
    fs.writeFileSync(macInstaller, 'fixture dmg', 'utf8');
    let macSpawnCall = null;
    let macUnrefCalled = false;
    let macReadyWaited = false;
    const macAutomatic = await launchDownloadedUpdate({
      platform: 'darwin', installType: 'desktop', downloadsDir: downloadDir,
      installerPath: macInstaller, appPath: macExecutable, parentPid: 4321,
      expectedVersion: '3.1.0',
      environment: { FIXTURE: 'yes' },
      allowUnsignedMacUpdates: true,
      verifyInstaller,
      waitForReady: async (readyPath, child, _timeoutMs, expected) => {
        macReadyWaited = true;
        assert.equal(path.basename(readyPath), `install-update-macos-ready-${expected.token}.json`);
        assert.equal(expected.pid, child.pid);
      },
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
    assert.equal(macReadyWaited, true);
    assert.equal(macSpawnCall.command, macExecutable);
    assert.equal(macSpawnCall.options.detached, true);
    assert.equal(macSpawnCall.options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(macSpawnCall.options.env.FIXTURE, 'yes');
    assert(macSpawnCall.args.includes(macInstaller));
    assert(macSpawnCall.args.includes(macAutomatic.targetApp));
    assert(macSpawnCall.args.includes('--expected-version'));
    assert(macSpawnCall.args.includes('3.1.0'));
    assert(macSpawnCall.args.includes('--ready'));
    assert(macSpawnCall.args.includes(macAutomatic.readyPath));
    assert(macSpawnCall.args.includes('--renderer-ready-path'));
    assert(macSpawnCall.args.includes(macAutomatic.rendererReadyPath));
    assert(macSpawnCall.args.includes('--renderer-ready-token'));
    assert(macSpawnCall.args.includes(macAutomatic.rendererReadyToken));
    assert.equal(path.basename(macAutomatic.rendererReadyPath), `install-renderer-ready-${macAutomatic.rendererReadyToken}.json`);
    assert.match(macAutomatic.rendererReadyToken, /^[0-9a-f]{48}$/);
    assert(macSpawnCall.args.includes('--allow-unsigned-mac-updates'));
    assert(macSpawnCall.args.includes('true'));
    assert.equal(verifiedInstallers.at(-1).allowUnsignedMacUpdates, true);
    assert.match(fs.readFileSync(macAutomatic.helperPath, 'utf8'), /async function installMacUpdate/);

    let failedMacHelperKilled = false;
    await assert.rejects(
      launchDownloadedUpdate({
        platform: 'darwin', installType: 'desktop', downloadsDir: downloadDir,
        installerPath: macInstaller, appPath: macExecutable, parentPid: 4321,
        expectedVersion: '3.1.0',
        verifyInstaller,
        waitForReady: async () => { throw new Error('fixture helper readiness timeout'); },
        signalProcess: () => { throw Object.assign(new Error('fixture process group missing'), { code: 'ESRCH' }); },
        spawn: () => {
          const child = new EventEmitter();
          child.pid = 9888;
          child.unref = () => {};
          child.kill = signal => {
            failedMacHelperKilled = true;
            child.signalCode = signal || 'SIGTERM';
            return true;
          };
          setImmediate(() => child.emit('spawn'));
          return child;
        },
      }),
      /fixture helper readiness timeout/,
    );
    assert.equal(failedMacHelperKilled, true);

    let unconfirmedMacReadyPath = '';
    let unconfirmedMacRendererReadyPath = '';
    let unconfirmedMacError = null;
    try {
      await launchDownloadedUpdate({
        platform: 'darwin', installType: 'desktop', downloadsDir: downloadDir,
        installerPath: macInstaller, appPath: macExecutable, parentPid: 4321,
        expectedVersion: '3.1.0', verifyInstaller,
        waitForReady: async readyPath => {
          unconfirmedMacReadyPath = readyPath;
          fs.writeFileSync(readyPath, 'fixture-ready', 'utf8');
        },
        beforeAutomaticInstall: async () => { throw new Error('fixture mac shutdown rejected'); },
        signalProcess: () => { throw Object.assign(new Error('fixture mac helper still live'), { code: 'EPERM' }); },
        spawn: (_command, args) => {
          unconfirmedMacRendererReadyPath = args[args.indexOf('--renderer-ready-path') + 1];
          const child = new EventEmitter();
          child.pid = 9_889;
          child.unref = () => {};
          child.kill = () => true;
          setImmediate(() => child.emit('spawn'));
          return child;
        },
      });
    } catch (error) {
      unconfirmedMacError = error;
    }
    assert(unconfirmedMacError);
    assert.equal(unconfirmedMacError.code, 'UPDATE_HELPER_CANCELLATION_UNCONFIRMED');
    assert.match(unconfirmedMacError.message, /fixture mac shutdown rejected/);
    assert.equal(fs.existsSync(unconfirmedMacReadyPath), true);
    fs.rmSync(unconfirmedMacReadyPath, { force: true });
    fs.rmSync(unconfirmedMacRendererReadyPath, { force: true });

    assert.equal(canInstallSilently({
      platform: 'darwin', installType: 'desktop', installerPath: macInstaller,
      downloadsDir: downloadDir, appPath: macExecutable,
    }), true);
    assert.equal(canInstallSilently({
      platform: 'darwin', installType: 'desktop', installerPath: macInstaller,
      downloadsDir: downloadDir, appPath: '/Volumes/Whitebox/Whitebox.app/Contents/MacOS/Whitebox',
    }), false);

    const manualOpened = [];
    const manual = await launchDownloadedUpdate({
      platform: 'darwin', installType: 'desktop', downloadsDir: downloadDir, installerPath: downloaded.downloadedPath,
      shell: { openPath: async file => { manualOpened.push(file); return ''; } },
      verifyInstaller,
    });
    assert.equal(manual.mode, 'manual');
    assert.deepStrictEqual(manualOpened, [downloaded.downloadedPath]);

    await assert.rejects(
      launchDownloadedUpdate({
        platform: 'win32', installType: 'desktop', downloadsDir: downloadDir,
        installerPath: downloaded.downloadedPath, appPath: process.execPath, parentPid: 4321,
        expectedVersion: '3.1.0',
        spawnTimeoutMs: 100,
        verifyInstaller,
        spawn: () => {
          const child = new EventEmitter();
          child.unref = () => {};
          setImmediate(() => child.emit('error', new Error('PowerShell unavailable')));
          return child;
        },
      }),
      /PowerShell unavailable/,
    );
    const signatureCalls = [];
    const signedWindowsResult = await verifyDownloadedInstaller({
      platform: 'win32',
      installerPath: downloaded.downloadedPath,
      environment: { SystemRoot: 'C:\\Windows' },
      execFile: async (command, args, options) => {
        signatureCalls.push({ command, args, options });
        return { stdout: 'Valid\r\n' };
      },
    });
    assert.deepStrictEqual(signedWindowsResult, { platform: 'win32', verified: true, unsignedAllowed: false });
    assert.equal(signatureCalls.length, 1);
    assert(signatureCalls[0].args.includes('-EncodedCommand'));
    assert.equal(signatureCalls[0].options.env.WHITEBOX_VERIFY_PATH, downloaded.downloadedPath);
    assert.equal(signatureCalls[0].options.env.WHITEBOX_ALLOW_UNSIGNED_WINDOWS, 'false');
    const encodedIndex = signatureCalls[0].args.indexOf('-EncodedCommand') + 1;
    assert.match(Buffer.from(signatureCalls[0].args[encodedIndex], 'base64').toString('utf16le'), /Get-AuthenticodeSignature/);
    assert.match(Buffer.from(signatureCalls[0].args[encodedIndex], 'base64').toString('utf16le'), /NotSigned/);

    const unsignedWindowsResult = await verifyDownloadedInstaller({
      platform: 'win32',
      installerPath: downloaded.downloadedPath,
      environment: { SystemRoot: 'C:\\Windows' },
      allowUnsignedWindowsUpdates: true,
      execFile: async (command, args, options) => {
        assert.equal(options.env.WHITEBOX_ALLOW_UNSIGNED_WINDOWS, 'true');
        return { stdout: 'NotSigned\r\n' };
      },
    });
    assert.deepStrictEqual(unsignedWindowsResult, { platform: 'win32', verified: false, unsignedAllowed: true });

    await assert.rejects(
      verifyDownloadedInstaller({
        platform: 'win32',
        installerPath: downloaded.downloadedPath,
        environment: { SystemRoot: 'C:\\Windows' },
        allowUnsignedWindowsUpdates: true,
        execFile: async () => { throw new Error('Invalid Authenticode signature: HashMismatch'); },
      }),
      /HashMismatch/,
    );

    const macSignatureCalls = [];
    const signedMacResult = await verifyDownloadedInstaller({
      platform: 'darwin',
      installerPath: macInstaller,
      execFile: async (command, args) => { macSignatureCalls.push({ command, args }); },
    });
    assert.deepStrictEqual(signedMacResult, { platform: 'darwin', verified: true, unsignedAllowed: false });
    assert.equal(macSignatureCalls[0].command, '/usr/sbin/spctl');
    assert(macSignatureCalls[0].args.includes('--assess'));

    const unsignedMacResult = await verifyDownloadedInstaller({
      platform: 'darwin',
      installerPath: macInstaller,
      allowUnsignedMacUpdates: true,
      execFile: async () => { throw new Error('rejected unsigned fixture'); },
    });
    assert.deepStrictEqual(unsignedMacResult, { platform: 'darwin', verified: false, unsignedAllowed: true });
    await assert.rejects(
      verifyDownloadedInstaller({
        platform: 'darwin',
        installerPath: macInstaller,
        execFile: async () => { throw new Error('rejected unsigned fixture'); },
      }),
      /rejected unsigned fixture/,
    );
  });

  test('macOS 업데이트 헬퍼가 앱을 교체하고 실패하면 원본을 복구해 재실행한다', async () => {
    const noProcessGroup = () => { throw Object.assign(new Error('missing fixture process group'), { code: 'ESRCH' }); };
    const macFixtureFileSystem = new Proxy(fs.promises, {
      get(target, property) {
        if (property === 'rename') {
          return async (source, destination) => {
            for (let attempt = 0; ; attempt += 1) {
              try {
                return await fs.promises.rename(source, destination);
              } catch (error) {
                if (process.platform !== 'win32'
                  || !['EACCES', 'EPERM'].includes(error?.code)
                  || attempt >= 4) throw error;
                await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
              }
            }
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const parsedToken = '9'.repeat(48);
    const parsedReadyPath = macHelperReadyPath(temp, parsedToken);
    const parsedRendererReadyPath = path.join(temp, `install-renderer-ready-${parsedToken}.json`);
    assert.deepStrictEqual(parseMacUpdateArguments([
      '--dmg', '/tmp/Whitebox-3.1.0-arm64.dmg',
      '--target', '/Applications/Whitebox.app',
      '--parent-pid', '1234',
      '--expected-version', '3.1.0',
      '--log', '/tmp/install-update.log',
      '--ready', parsedReadyPath,
      '--renderer-ready-path', parsedRendererReadyPath,
      '--renderer-ready-token', parsedToken,
      '--allow-unsigned-mac-updates', 'false',
    ]), {
      dmgPath: '/tmp/Whitebox-3.1.0-arm64.dmg',
      targetApp: '/Applications/Whitebox.app',
      parentPid: 1234,
      expectedVersion: '3.1.0',
      logPath: '/tmp/install-update.log',
      readyPath: parsedReadyPath,
      rendererReadyPath: parsedRendererReadyPath,
      rendererReadyToken: parsedToken,
      allowUnsignedMacUpdates: false,
    });

    let metadataCall = null;
    assert.deepStrictEqual(await readBundleMetadata('/Applications/Whitebox.app', {
      plutil: 'plutil',
      execFile: async (command, args) => {
        metadataCall = { command, args };
        return { stdout: JSON.stringify({
          CFBundleShortVersionString: '3.1.0',
          CFBundleExecutable: 'Whitebox',
        }) };
      },
    }), { version: '3.1.0', executable: 'Whitebox' });
    assert.equal(metadataCall.command, 'plutil');
    assert.deepStrictEqual(metadataCall.args, [
      '-convert', 'json', '-o', '-', path.join('/Applications/Whitebox.app', 'Contents', 'Info.plist'),
    ]);
    await assert.rejects(
      readBundleMetadata('/Applications/Whitebox.app', {
        execFile: async () => ({ stdout: JSON.stringify({
          CFBundleShortVersionString: '3.1.0',
          CFBundleExecutable: '../OtherApp',
        }) }),
      }),
      /버전 또는 실행 파일 정보가 올바르지 않습니다/,
    );

    async function prepareFixture(name) {
      const root = path.join(temp, name);
      const targetApp = path.join(root, 'Applications', 'Whitebox.app');
      const mountPath = path.join(root, 'mount');
      const dmgPath = path.join(root, 'Whitebox-3.1.0-arm64.dmg');
      const logPath = path.join(root, 'install-update.log');
      fs.mkdirSync(path.join(targetApp, 'Contents'), { recursive: true });
      fs.mkdirSync(mountPath, { recursive: true });
      fs.writeFileSync(path.join(targetApp, 'Contents', 'version.txt'), 'old', 'utf8');
      fs.writeFileSync(dmgPath, 'fixture dmg', 'utf8');
      return { root, targetApp, mountPath, dmgPath, logPath, fileSystem: macFixtureFileSystem };
    }

    function fixtureRunner(fixture, options = {}) {
      const openedVersions = [];
      const xattrCalls = [];
      let openCount = 0;
      return {
        openedVersions,
        xattrCalls,
        run: async (command, args) => {
          if (command === 'hdiutil' && args[0] === 'attach') {
            const source = path.join(fixture.mountPath, 'Whitebox.app', 'Contents');
            await fs.promises.mkdir(source, { recursive: true });
            await fs.promises.writeFile(path.join(source, 'version.txt'), 'new', 'utf8');
            await fs.promises.mkdir(path.join(source, 'MacOS'), { recursive: true });
            await fs.promises.writeFile(
              path.join(source, 'MacOS', 'Whitebox'),
              '#!/bin/sh\nexit 0\n',
              { encoding: 'utf8', mode: 0o755 },
            );
            return;
          }
          if (command === 'hdiutil' && args[0] === 'detach') return;
          if (command === 'ditto') {
            await fs.promises.cp(args[0], args[1], { recursive: true });
            return;
          }
          if (command === 'xattr') {
            xattrCalls.push(args);
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
    const successfulRendererToken = 'c'.repeat(48);
    const successfulReadyPath = macHelperReadyPath(successful.root, successfulRendererToken);
    const successfulRendererReadyPath = path.join(
      successful.root,
      `install-renderer-ready-${successfulRendererToken}.json`,
    );
    const successfulBackup = path.join(successful.root, 'Applications', '.Whitebox.app.backup-success');
    let backupPresentAtRendererSignal = false;
    let appUnrefCalled = false;
    await installMacUpdate({
      ...successful,
      parentPid: 1234,
      operationId: 'success',
      expectedVersion: '3.1.0',
      readyPath: successfulReadyPath,
      rendererReadyPath: successfulRendererReadyPath,
      rendererReadyToken: successfulRendererToken,
      allowUnsignedMacUpdates: true,
      waitForParentExit: async pid => {
        assert.equal(pid, 1234);
        assert.equal(fs.existsSync(successfulReadyPath), true);
      },
      readBundleMetadata: async () => ({
        version: '3.1.0',
        executable: 'Whitebox',
      }),
      spawnApplication: (command, args, options) => {
        backupPresentAtRendererSignal = fs.existsSync(successfulBackup);
        assert.equal(command, path.join(successful.targetApp, 'Contents', 'MacOS', 'Whitebox'));
        assert.deepStrictEqual(args, []);
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
        assert.equal(options.env.WHITEBOX_UPDATE_READY_PATH, successfulRendererReadyPath);
        assert.equal(options.env.WHITEBOX_UPDATE_READY_TOKEN, successfulRendererToken);
        const child = new EventEmitter();
        child.pid = 2468;
        child.exitCode = null;
        child.signalCode = null;
        child.unref = () => { appUnrefCalled = true; };
        fs.writeFileSync(successfulRendererReadyPath, JSON.stringify({
          token: successfulRendererToken,
          pid: child.pid,
          version: '3.1.0',
          rendererReadyAt: '2026-08-01T00:00:00.000Z',
        }), 'utf8');
        setImmediate(() => child.emit('spawn'));
        return child;
      },
      readinessTimeoutMs: 500,
      readinessPollMs: 5,
      commands: { hdiutil: 'hdiutil', ditto: 'ditto', xattr: 'xattr', open: 'open' },
      run: successfulRunner.run,
    });
    assert.equal(fs.readFileSync(path.join(successful.targetApp, 'Contents', 'version.txt'), 'utf8'), 'new');
    assert.equal(backupPresentAtRendererSignal, true);
    assert.equal(appUnrefCalled, true);
    assert.equal(fs.existsSync(successfulBackup), false);
    assert.equal(fs.existsSync(successfulRendererReadyPath), false);
    assert.deepStrictEqual(successfulRunner.openedVersions, []);
    assert.deepStrictEqual(successfulRunner.xattrCalls, [['-cr', path.join(successful.root, 'Applications', '.Whitebox.app.update-success')]]);
    assert.match(fs.readFileSync(successful.logPath, 'utf8'), /internal unsigned update quarantine removed/);
    assert.match(fs.readFileSync(successful.logPath, 'utf8'), /update installed and renderer ready/);

    const failed = await prepareFixture('mac-update-rollback');
    const failedRunner = fixtureRunner(failed);
    const failedRendererToken = 'd'.repeat(48);
    const failedReadyPath = macHelperReadyPath(failed.root, failedRendererToken);
    const failedRendererReadyPath = path.join(
      failed.root,
      `install-renderer-ready-${failedRendererToken}.json`,
    );
    const terminationSignals = [];
    await assert.rejects(
      installMacUpdate({
        ...failed,
        parentPid: 5678,
        operationId: 'rollback',
        expectedVersion: '3.1.0',
        readyPath: failedReadyPath,
        rendererReadyPath: failedRendererReadyPath,
        rendererReadyToken: failedRendererToken,
        signalProcess: noProcessGroup,
        waitForParentExit: async pid => assert.equal(pid, 5678),
        readBundleMetadata: async () => ({ version: '3.1.0', executable: 'Whitebox' }),
        spawnApplication: () => {
          const child = new EventEmitter();
          child.pid = 3579;
          child.exitCode = null;
          child.signalCode = null;
          child.unref = () => {};
          child.kill = signal => {
            terminationSignals.push(signal);
            child.signalCode = signal;
            setImmediate(() => child.emit('exit', null, signal));
            return true;
          };
          setImmediate(() => child.emit('spawn'));
          return child;
        },
        readinessTimeoutMs: 20,
        readinessPollMs: 2,
        terminationTimeoutMs: 100,
        terminationPollMs: 2,
        commands: { hdiutil: 'hdiutil', ditto: 'ditto', open: 'open' },
        run: failedRunner.run,
      }),
      /제한 시간 안에 준비되지 않았습니다/,
    );
    assert.equal(fs.readFileSync(path.join(failed.targetApp, 'Contents', 'version.txt'), 'utf8'), 'old');
    assert.deepStrictEqual(terminationSignals, ['SIGTERM']);
    assert.deepStrictEqual(failedRunner.openedVersions, ['old']);
    assert.equal(fs.existsSync(failedRendererReadyPath), false);
    assert.match(fs.readFileSync(failed.logPath, 'utf8'), /original app restored/);
    assert.match(fs.readFileSync(failed.logPath, 'utf8'), /original app relaunched/);

    const mismatched = await prepareFixture('mac-update-version-mismatch');
    const mismatchedRunner = fixtureRunner(mismatched);
    const mismatchedToken = 'e'.repeat(48);
    let mismatchedSpawned = false;
    await assert.rejects(
      installMacUpdate({
        ...mismatched,
        parentPid: 6789,
        operationId: 'version-mismatch',
        expectedVersion: '3.1.0',
        readyPath: macHelperReadyPath(mismatched.root, mismatchedToken),
        rendererReadyPath: path.join(mismatched.root, `install-renderer-ready-${mismatchedToken}.json`),
        rendererReadyToken: mismatchedToken,
        waitForParentExit: async () => {},
        readBundleMetadata: async () => ({ version: '3.2.0', executable: 'Whitebox' }),
        spawnApplication: () => { mismatchedSpawned = true; throw new Error('must not launch'); },
        commands: { hdiutil: 'hdiutil', ditto: 'ditto', open: 'open' },
        run: mismatchedRunner.run,
      }),
      /새 앱 버전이 예상과 다릅니다/,
    );
    assert.equal(mismatchedSpawned, false);
    assert.equal(fs.readFileSync(path.join(mismatched.targetApp, 'Contents', 'version.txt'), 'utf8'), 'old');
    assert.deepStrictEqual(mismatchedRunner.openedVersions, ['old']);

    const invalidReadySignals = [
      { name: 'token', patch: { token: 'f'.repeat(48) } },
      { name: 'pid', patch: { pid: 4001 } },
      { name: 'version', patch: { version: '3.0.0' } },
      { name: 'timestamp', patch: { rendererReadyAt: 'not-an-iso-timestamp' } },
      { name: 'json', raw: '{broken-json' },
    ];
    for (let index = 0; index < invalidReadySignals.length; index += 1) {
      const invalid = invalidReadySignals[index];
      const fixture = await prepareFixture(`mac-update-invalid-ready-${invalid.name}`);
      const runner = fixtureRunner(fixture);
      const token = String(index).repeat(48);
      const rendererReadyPath = path.join(fixture.root, `install-renderer-ready-${token}.json`);
      const childPid = 4000;
      await assert.rejects(
        installMacUpdate({
          ...fixture,
          parentPid: 7000 + index,
          operationId: `invalid-${invalid.name}`,
          expectedVersion: '3.1.0',
          readyPath: macHelperReadyPath(fixture.root, token),
          rendererReadyPath,
          rendererReadyToken: token,
          signalProcess: noProcessGroup,
          waitForParentExit: async () => {},
          readBundleMetadata: async () => ({ version: '3.1.0', executable: 'Whitebox' }),
          spawnApplication: () => {
            const child = new EventEmitter();
            child.pid = childPid;
            child.exitCode = null;
            child.signalCode = null;
            child.unref = () => {};
            child.kill = signal => { child.signalCode = signal; return true; };
            const signal = JSON.stringify({
              token,
              pid: childPid,
              version: '3.1.0',
              rendererReadyAt: '2026-08-01T00:00:00.000Z',
              ...invalid.patch,
            });
            fs.writeFileSync(rendererReadyPath, invalid.raw || signal, 'utf8');
            setImmediate(() => child.emit('spawn'));
            return child;
          },
          terminationTimeoutMs: 20,
          terminationPollMs: 1,
          commands: { hdiutil: 'hdiutil', ditto: 'ditto', open: 'open' },
          run: runner.run,
        }),
        /준비 신호가 올바르지 않습니다/,
      );
      assert.equal(fs.readFileSync(path.join(fixture.targetApp, 'Contents', 'version.txt'), 'utf8'), 'old');
      assert.deepStrictEqual(runner.openedVersions, ['old']);
    }

    const exited = await prepareFixture('mac-update-early-exit');
    const exitedRunner = fixtureRunner(exited);
    const exitedToken = 'a'.repeat(48);
    await assert.rejects(
      installMacUpdate({
        ...exited,
        parentPid: 8000,
        operationId: 'early-exit',
        expectedVersion: '3.1.0',
        readyPath: macHelperReadyPath(exited.root, exitedToken),
        rendererReadyPath: path.join(exited.root, `install-renderer-ready-${exitedToken}.json`),
        rendererReadyToken: exitedToken,
        signalProcess: noProcessGroup,
        waitForParentExit: async () => {},
        readBundleMetadata: async () => ({ version: '3.1.0', executable: 'Whitebox' }),
        spawnApplication: () => {
          const child = new EventEmitter();
          child.pid = 4100;
          child.exitCode = null;
          child.signalCode = null;
          child.unref = () => {};
          setImmediate(() => {
            child.emit('spawn');
            child.exitCode = 17;
            child.emit('exit', 17, null);
          });
          return child;
        },
        commands: { hdiutil: 'hdiutil', ditto: 'ditto', open: 'open' },
        run: exitedRunner.run,
      }),
      /준비되기 전에 종료.*17/,
    );
    assert.equal(fs.readFileSync(path.join(exited.targetApp, 'Contents', 'version.txt'), 'utf8'), 'old');
    assert.deepStrictEqual(exitedRunner.openedVersions, ['old']);

    const cleanupWarning = await prepareFixture('mac-update-backup-cleanup-warning');
    const cleanupRunner = fixtureRunner(cleanupWarning);
    const cleanupToken = 'b'.repeat(48);
    const cleanupRendererReadyPath = path.join(
      cleanupWarning.root,
      `install-renderer-ready-${cleanupToken}.json`,
    );
    const cleanupBackup = path.join(
      cleanupWarning.root,
      'Applications',
      '.Whitebox.app.backup-cleanup-warning',
    );
    let backupRemoveCalls = 0;
    const cleanupFileSystem = new Proxy(macFixtureFileSystem, {
      get(target, property) {
        if (property === 'rm') {
          return async (targetPath, options) => {
            if (targetPath === cleanupBackup) {
              backupRemoveCalls += 1;
              if (backupRemoveCalls === 2) throw new Error('fixture backup cleanup denied');
            }
            return target.rm(targetPath, options);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await installMacUpdate({
      ...cleanupWarning,
      parentPid: 8100,
      operationId: 'cleanup-warning',
      expectedVersion: '3.1.0',
      readyPath: macHelperReadyPath(cleanupWarning.root, cleanupToken),
      rendererReadyPath: cleanupRendererReadyPath,
      rendererReadyToken: cleanupToken,
      fileSystem: cleanupFileSystem,
      waitForParentExit: async () => {},
      readBundleMetadata: async () => ({ version: '3.1.0', executable: 'Whitebox' }),
      spawnApplication: () => {
        const child = new EventEmitter();
        child.pid = 4200;
        child.exitCode = null;
        child.signalCode = null;
        child.unref = () => {};
        fs.writeFileSync(cleanupRendererReadyPath, JSON.stringify({
          token: cleanupToken,
          pid: child.pid,
          version: '3.1.0',
          rendererReadyAt: '2026-08-01T00:00:00.000Z',
        }), 'utf8');
        setImmediate(() => child.emit('spawn'));
        return child;
      },
      commands: { hdiutil: 'hdiutil', ditto: 'ditto', open: 'open' },
      run: cleanupRunner.run,
    });
    assert.equal(fs.readFileSync(path.join(cleanupWarning.targetApp, 'Contents', 'version.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(cleanupBackup), true);
    assert.match(fs.readFileSync(cleanupWarning.logPath, 'utf8'), /backup cleanup warning: fixture backup cleanup denied/);

    const recoveryOpenFailure = await prepareFixture('mac-update-recovery-open-failure');
    const recoveryFailureRunner = fixtureRunner(recoveryOpenFailure, { failFirstOpen: true });
    const recoveryFailureToken = 'c'.repeat(48);
    await assert.rejects(
      installMacUpdate({
        ...recoveryOpenFailure,
        parentPid: 8200,
        operationId: 'recovery-open-failure',
        expectedVersion: '3.1.0',
        readyPath: macHelperReadyPath(recoveryOpenFailure.root, recoveryFailureToken),
        rendererReadyPath: path.join(
          recoveryOpenFailure.root,
          `install-renderer-ready-${recoveryFailureToken}.json`,
        ),
        rendererReadyToken: recoveryFailureToken,
        signalProcess: noProcessGroup,
        waitForParentExit: async () => {},
        readBundleMetadata: async () => ({ version: '3.1.0', executable: 'Whitebox' }),
        spawnApplication: () => {
          const child = new EventEmitter();
          child.pid = 4300;
          child.exitCode = null;
          child.signalCode = null;
          child.unref = () => {};
          child.kill = signal => { child.signalCode = signal; return true; };
          setImmediate(() => child.emit('spawn'));
          return child;
        },
        readinessTimeoutMs: 10,
        readinessPollMs: 1,
        commands: { hdiutil: 'hdiutil', ditto: 'ditto', open: 'open' },
        run: recoveryFailureRunner.run,
      }),
      /제한 시간 안에 준비되지 않았습니다/,
    );
    assert.equal(fs.readFileSync(path.join(recoveryOpenFailure.targetApp, 'Contents', 'version.txt'), 'utf8'), 'old');
    assert.deepStrictEqual(recoveryFailureRunner.openedVersions, ['old']);
    assert.match(fs.readFileSync(recoveryOpenFailure.logPath, 'utf8'), /relaunch failed: Error: fixture relaunch failure/);

    const stopFailure = await prepareFixture('mac-update-stop-failure');
    const stopFailureRunner = fixtureRunner(stopFailure);
    const stopFailureToken = 'd'.repeat(48);
    const stopFailureBackup = path.join(
      stopFailure.root,
      'Applications',
      '.Whitebox.app.backup-stop-failure',
    );
    await assert.rejects(
      installMacUpdate({
        ...stopFailure,
        parentPid: 8300,
        operationId: 'stop-failure',
        expectedVersion: '3.1.0',
        readyPath: macHelperReadyPath(stopFailure.root, stopFailureToken),
        rendererReadyPath: path.join(
          stopFailure.root,
          `install-renderer-ready-${stopFailureToken}.json`,
        ),
        rendererReadyToken: stopFailureToken,
        waitForParentExit: async () => {},
        readBundleMetadata: async () => ({ version: '3.1.0', executable: 'Whitebox' }),
        spawnApplication: () => {
          const child = new EventEmitter();
          child.pid = 4400;
          child.exitCode = null;
          child.signalCode = null;
          child.unref = () => {};
          setImmediate(() => child.emit('spawn'));
          return child;
        },
        terminateApplication: async () => { throw new Error('fixture process would not stop'); },
        readinessTimeoutMs: 10,
        readinessPollMs: 1,
        commands: { hdiutil: 'hdiutil', ditto: 'ditto', open: 'open' },
        run: stopFailureRunner.run,
      }),
      /제한 시간 안에 준비되지 않았습니다/,
    );
    assert.equal(fs.readFileSync(path.join(stopFailure.targetApp, 'Contents', 'version.txt'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(stopFailureBackup, 'Contents', 'version.txt'), 'utf8'), 'old');
    assert.deepStrictEqual(stopFailureRunner.openedVersions, []);
    assert.match(fs.readFileSync(stopFailure.logPath, 'utf8'), /updated app stop failed: Error: fixture process would not stop/);

    const restoreFailure = await prepareFixture('mac-update-restore-rename-failure');
    const restoreFailureRunner = fixtureRunner(restoreFailure);
    const restoreFailureToken = 'e'.repeat(48);
    const restoreFailureBackup = path.join(
      restoreFailure.root,
      'Applications',
      '.Whitebox.app.backup-restore-rename-failure',
    );
    const restoreFailureFileSystem = new Proxy(restoreFailure.fileSystem, {
      get(target, property) {
        if (property === 'rename') {
          return async (source, destination) => {
            if (source === restoreFailureBackup && destination === restoreFailure.targetApp) {
              throw new Error('fixture backup restore rename denied');
            }
            return target.rename(source, destination);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      installMacUpdate({
        ...restoreFailure,
        parentPid: 8_400,
        operationId: 'restore-rename-failure',
        expectedVersion: '3.1.0',
        readyPath: macHelperReadyPath(restoreFailure.root, restoreFailureToken),
        rendererReadyPath: path.join(
          restoreFailure.root,
          `install-renderer-ready-${restoreFailureToken}.json`,
        ),
        rendererReadyToken: restoreFailureToken,
        fileSystem: restoreFailureFileSystem,
        signalProcess: noProcessGroup,
        waitForParentExit: async () => {},
        readBundleMetadata: async () => ({ version: '3.1.0', executable: 'Whitebox' }),
        spawnApplication: () => {
          const child = new EventEmitter();
          child.pid = 4_600;
          child.exitCode = null;
          child.signalCode = null;
          child.unref = () => {};
          child.kill = signal => { child.signalCode = signal; return true; };
          setImmediate(() => child.emit('spawn'));
          return child;
        },
        readinessTimeoutMs: 10,
        readinessPollMs: 1,
        commands: { hdiutil: 'hdiutil', ditto: 'ditto', open: 'open' },
        run: restoreFailureRunner.run,
      }),
      /제한 시간 안에 준비되지 않았습니다/,
    );
    assert.equal(fs.readFileSync(path.join(restoreFailure.targetApp, 'Contents', 'version.txt'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(restoreFailureBackup, 'Contents', 'version.txt'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(
      restoreFailure.root,
      'Applications',
      '.Whitebox.app.failed-restore-rename-failure',
    )), false);
    assert.match(fs.readFileSync(restoreFailure.logPath, 'utf8'), /rollback failed.*fixture backup restore rename denied/);

    const processTreeSignals = [];
    let descendantAlive = true;
    const exitedLeader = new EventEmitter();
    exitedLeader.pid = 4_500;
    exitedLeader.exitCode = null;
    exitedLeader.signalCode = null;
    exitedLeader.kill = () => { throw new Error('프로세스 그룹 대신 리더만 종료하면 안 됩니다.'); };
    const missingGroup = () => Object.assign(new Error('missing process group'), { code: 'ESRCH' });
    await terminateApplication(exitedLeader, {
      timeoutMs: 2,
      pollMs: 1,
      delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
      signalProcess: (pid, signal) => {
        processTreeSignals.push([pid, signal]);
        if (pid !== -exitedLeader.pid) throw missingGroup();
        if (signal === 0) {
          if (!descendantAlive) throw missingGroup();
          return;
        }
        if (signal === 'SIGTERM') {
          exitedLeader.exitCode = 0;
          return;
        }
        if (signal === 'SIGKILL') descendantAlive = false;
      },
    });
    assert.equal(descendantAlive, false);
    assert.equal(processTreeSignals.some(([pid, signal]) => pid === -4_500 && signal === 'SIGTERM'), true);
    assert.equal(processTreeSignals.some(([pid, signal]) => pid === -4_500 && signal === 'SIGKILL'), true);
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
