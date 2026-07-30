'use strict';

const fs = require('fs');
const path = require('path');

function unpackedAsarPath(file) {
  return String(file || '')
    .replace(/([\\/])app\.asar(?=[\\/])/g, '$1app.asar.unpacked')
    .replace(/([\\/])node_modules\.asar(?=[\\/])/g, '$1node_modules.asar.unpacked');
}

function macNodePtyRuntimeFiles(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return null;
  const arch = String(options.arch || process.arch);
  if (!/^(?:arm64|x64)$/.test(arch)) throw new Error(`지원하지 않는 Mac 프로세서 종류입니다: ${arch}`);
  const resolvePackage = options.resolvePackage || (() => require.resolve('node-pty/package.json'));
  const packageRoot = path.dirname(unpackedAsarPath(resolvePackage()));
  const prebuild = path.join(packageRoot, 'prebuilds', `darwin-${arch}`);
  return {
    packageRoot,
    helper: path.join(prebuild, 'spawn-helper'),
    addon: path.join(prebuild, 'pty.node'),
  };
}

function ensureMacNodePtyRuntime(options = {}) {
  const files = macNodePtyRuntimeFiles(options);
  if (!files) return { repaired: false, files: null };
  const fileSystem = options.fileSystem || fs;
  const executableMode = fileSystem.constants?.X_OK ?? fs.constants.X_OK;
  for (const file of [files.addon, files.helper]) {
    let stat;
    try {
      stat = fileSystem.statSync(file);
    } catch (error) {
      throw new Error(`macOS 명령창에 필요한 파일을 찾을 수 없습니다: ${file}`, { cause: error });
    }
    if (!stat.isFile()) throw new Error(`macOS 명령창에 필요한 항목이 파일이 아닙니다: ${file}`);
  }

  let repaired = false;
  try {
    fileSystem.accessSync(files.helper, executableMode);
  } catch (_notExecutable) {
    const mode = fileSystem.statSync(files.helper).mode;
    try {
      fileSystem.chmodSync(files.helper, mode | 0o111);
      fileSystem.accessSync(files.helper, executableMode);
      repaired = true;
    } catch (error) {
      throw new Error(`macOS 명령창을 실행할 권한을 복구할 수 없습니다: ${files.helper}`, { cause: error });
    }
  }
  return { repaired, files };
}

module.exports = { ensureMacNodePtyRuntime, macNodePtyRuntimeFiles, unpackedAsarPath };
