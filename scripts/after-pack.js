'use strict';

const fs = require('fs');
const path = require('path');

function macNodePtySpawnHelpers(context, fileSystem = fs) {
  if (context?.electronPlatformName !== 'darwin') return [];
  const appOutDir = String(context.appOutDir || '').trim();
  const productFilename = String(context.packager?.appInfo?.productFilename || '').trim();
  if (!appOutDir || !productFilename) throw new Error('macOS 패키징 경로를 확인할 수 없습니다.');

  const prebuilds = path.join(
    appOutDir,
    `${productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds',
  );
  let entries;
  try {
    entries = fileSystem.readdirSync(prebuilds, { withFileTypes: true });
  } catch (error) {
    throw new Error(`node-pty macOS 프리빌드를 찾을 수 없습니다: ${prebuilds}`, { cause: error });
  }

  return entries
    .filter(entry => entry.isDirectory() && /^darwin-(?:arm64|x64)$/.test(entry.name))
    .map(entry => path.join(prebuilds, entry.name, 'spawn-helper'))
    .filter(file => fileSystem.existsSync(file));
}

function ensureMacNodePtySpawnHelpersExecutable(context, fileSystem = fs) {
  const helpers = macNodePtySpawnHelpers(context, fileSystem);
  if (context?.electronPlatformName !== 'darwin') return helpers;
  if (!helpers.length) throw new Error('패키징된 node-pty macOS spawn-helper를 찾을 수 없습니다.');

  for (const helper of helpers) {
    const mode = fileSystem.statSync(helper).mode;
    fileSystem.chmodSync(helper, mode | 0o111);
    fileSystem.accessSync(helper, fileSystem.constants?.X_OK ?? fs.constants.X_OK);
  }
  return helpers;
}

async function afterPack(context) {
  ensureMacNodePtySpawnHelpersExecutable(context);
}

module.exports = afterPack;
module.exports.ensureMacNodePtySpawnHelpersExecutable = ensureMacNodePtySpawnHelpersExecutable;
module.exports.macNodePtySpawnHelpers = macNodePtySpawnHelpers;
