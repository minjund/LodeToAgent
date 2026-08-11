'use strict';

const fs = require('fs');
const path = require('path');

const ARCH_NAMES = Object.freeze({
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
});

const NODE_PTY_LIB_FILES = Object.freeze([
  'conpty_console_list_agent.js',
  'eventEmitter2.js',
  'index.js',
  'interfaces.js',
  path.join('shared', 'conout.js'),
  'terminal.js',
  'types.js',
  'unixTerminal.js',
  'utils.js',
  path.join('worker', 'conoutSocketWorker.js'),
  'windowsConoutConnection.js',
  'windowsPtyAgent.js',
  'windowsTerminal.js',
]);

const NODE_PTY_RUNTIME_FILES = Object.freeze({
  darwin: Object.freeze(['pty.node', 'spawn-helper']),
  linux: Object.freeze(['pty.node']),
  win32: Object.freeze([
    'conpty.node',
    'conpty_console_list.node',
    path.join('conpty', 'conpty.dll'),
    path.join('conpty', 'OpenConsole.exe'),
  ]),
});

function nodePtyPlatform(context) {
  const requested = String(context?.electronPlatformName || '').trim();
  const platform = requested === 'mas' ? 'darwin' : requested;
  if (!Object.hasOwn(NODE_PTY_RUNTIME_FILES, platform)) {
    throw new Error(`node-pty 패키징 운영체제를 지원하지 않습니다: ${requested || '(없음)'}`);
  }
  return platform;
}

function nodePtyArch(context) {
  const requested = context?.arch;
  const arch = typeof requested === 'number'
    ? ARCH_NAMES[requested]
    : String(requested || '').trim();
  if (!arch || arch === 'universal') {
    throw new Error(`node-pty 패키징 CPU 아키텍처를 지원하지 않습니다: ${requested ?? '(없음)'}`);
  }
  return arch;
}

function nodePtyPackageRoot(context) {
  const appOutDir = String(context?.appOutDir || '').trim();
  if (!appOutDir) throw new Error('node-pty 패키징 경로를 확인할 수 없습니다.');

  const platform = nodePtyPlatform(context);
  let resources = path.join(appOutDir, 'resources');
  if (platform === 'darwin') {
    const productFilename = String(context?.packager?.appInfo?.productFilename || '').trim();
    if (!productFilename) throw new Error('macOS 패키징 제품 이름을 확인할 수 없습니다.');
    resources = path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
  }

  return path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty');
}

function requiredDirectory(directory, label, fileSystem = fs) {
  let stat;
  try {
    stat = fileSystem.statSync(directory);
  } catch (error) {
    throw new Error(`패키징된 node-pty ${label} 디렉터리를 찾을 수 없습니다: ${directory}`, { cause: error });
  }
  if (!stat.isDirectory()) {
    throw new Error(`패키징된 node-pty ${label} 경로가 디렉터리가 아닙니다: ${directory}`);
  }
}

function requiredFile(file, label, fileSystem = fs) {
  let stat;
  try {
    stat = fileSystem.statSync(file);
  } catch (error) {
    throw new Error(`패키징된 node-pty 필수 ${label} 파일을 찾을 수 없습니다: ${file}`, { cause: error });
  }
  if (!stat.isFile()) {
    throw new Error(`패키징된 node-pty 필수 ${label} 경로가 파일이 아닙니다: ${file}`);
  }
}

function pruneDirectory(directory, allowedNames, fileSystem = fs) {
  const allowed = new Set(allowedNames);
  for (const name of fileSystem.readdirSync(directory)) {
    if (!allowed.has(name)) {
      fileSystem.rmSync(path.join(directory, name), { recursive: true, force: false });
    }
  }
}

function pruneNodePtyLib(directory, fileSystem = fs) {
  for (const entry of fileSystem.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      pruneNodePtyLib(target, fileSystem);
      if (fileSystem.readdirSync(target).length === 0) fileSystem.rmSync(target, { recursive: false });
    } else if (!entry.isFile() || path.extname(entry.name) !== '.js') {
      fileSystem.rmSync(target, { recursive: true, force: false });
    }
  }
}

function selectedNodePtyRuntime(context, fileSystem = fs) {
  const platform = nodePtyPlatform(context);
  const arch = nodePtyArch(context);
  const packageRoot = nodePtyPackageRoot(context);
  const lib = path.join(packageRoot, 'lib');
  const prebuilds = path.join(packageRoot, 'prebuilds');
  const prebuildName = `${platform}-${arch}`;
  const prebuild = path.join(prebuilds, prebuildName);
  const packageFile = path.join(packageRoot, 'package.json');
  const licenseFile = path.join(packageRoot, 'LICENSE');
  const libFiles = NODE_PTY_LIB_FILES.map(file => path.join(lib, file));
  const runtimeFiles = NODE_PTY_RUNTIME_FILES[platform].map(file => path.join(prebuild, file));

  requiredDirectory(packageRoot, '패키지', fileSystem);
  requiredDirectory(lib, 'lib', fileSystem);
  requiredDirectory(prebuilds, 'prebuilds', fileSystem);
  requiredDirectory(prebuild, `${prebuildName} prebuild`, fileSystem);
  for (const file of libFiles) {
    requiredFile(file, `lib/${path.relative(lib, file).replaceAll(path.sep, '/')}`, fileSystem);
  }
  requiredFile(packageFile, 'package.json', fileSystem);
  requiredFile(licenseFile, 'LICENSE', fileSystem);
  for (const file of runtimeFiles) {
    requiredFile(file, `${prebuildName} 런타임`, fileSystem);
  }

  return {
    arch,
    licenseFile,
    lib,
    libFiles,
    packageFile,
    packageRoot,
    platform,
    prebuild,
    prebuildName,
    prebuilds,
    runtimeFiles,
  };
}

function pruneNodePtyRuntime(context, fileSystem = fs) {
  // Validate the complete target runtime before deleting anything so a broken
  // package fails closed without destroying diagnostics from the staged app.
  const runtime = selectedNodePtyRuntime(context, fileSystem);

  pruneDirectory(runtime.packageRoot, ['LICENSE', 'lib', 'package.json', 'prebuilds'], fileSystem);
  pruneNodePtyLib(runtime.lib, fileSystem);
  pruneDirectory(runtime.prebuilds, [runtime.prebuildName], fileSystem);

  if (runtime.platform === 'win32') {
    pruneDirectory(runtime.prebuild, ['conpty', 'conpty.node', 'conpty_console_list.node'], fileSystem);
    pruneDirectory(path.join(runtime.prebuild, 'conpty'), ['conpty.dll', 'OpenConsole.exe'], fileSystem);
  } else {
    pruneDirectory(runtime.prebuild, NODE_PTY_RUNTIME_FILES[runtime.platform], fileSystem);
  }

  // Revalidate the retained files so cleanup errors cannot produce a release.
  return selectedNodePtyRuntime(context, fileSystem);
}

function macNodePtySpawnHelpers(context, fileSystem = fs) {
  if (nodePtyPlatform(context) !== 'darwin') return [];
  const runtime = selectedNodePtyRuntime(context, fileSystem);
  return [path.join(runtime.prebuild, 'spawn-helper')];
}

function ensureMacNodePtySpawnHelpersExecutable(context, fileSystem = fs) {
  const helpers = macNodePtySpawnHelpers(context, fileSystem);
  for (const helper of helpers) {
    const mode = fileSystem.statSync(helper).mode;
    fileSystem.chmodSync(helper, mode | 0o111);
    fileSystem.accessSync(helper, fileSystem.constants?.X_OK ?? fs.constants.X_OK);
  }
  return helpers;
}

async function afterPack(context, fileSystem = fs) {
  const runtime = pruneNodePtyRuntime(context, fileSystem);
  const helpers = ensureMacNodePtySpawnHelpersExecutable(context, fileSystem);
  return { ...runtime, helpers };
}

module.exports = afterPack;
module.exports.ensureMacNodePtySpawnHelpersExecutable = ensureMacNodePtySpawnHelpersExecutable;
module.exports.macNodePtySpawnHelpers = macNodePtySpawnHelpers;
module.exports.nodePtyArch = nodePtyArch;
module.exports.nodePtyPackageRoot = nodePtyPackageRoot;
module.exports.nodePtyPlatform = nodePtyPlatform;
module.exports.pruneNodePtyRuntime = pruneNodePtyRuntime;
module.exports.selectedNodePtyRuntime = selectedNodePtyRuntime;
