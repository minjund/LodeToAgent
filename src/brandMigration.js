'use strict';

const fs = require('fs');
const path = require('path');

const LEGACY_PRODUCT_NAME = 'LoadToAgent';
const LEGACY_USER_DATA_NAMES = Object.freeze(['loadtoagent', LEGACY_PRODUCT_NAME]);
const PRODUCT_NAME = 'Whitebox';
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

function errorRecord(candidate, operation, error) {
  return {
    path: candidate,
    operation,
    code: typeof error?.code === 'string' ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

function resolveLegacyUserDataPaths(userDataPath, pathModule = path) {
  const parent = pathModule.dirname(userDataPath);
  return LEGACY_USER_DATA_NAMES.map(name => pathModule.join(parent, name));
}

function resolveLegacyUserDataPath(userDataPath, pathModule = path) {
  return resolveLegacyUserDataPaths(userDataPath, pathModule)[0];
}

/**
 * Existing installations keep using their original Electron userData root.
 * This is deliberately a path handoff rather than a file copy: Chromium
 * LevelDB stores and the live terminal-host discovery file must move as one
 * unit or settings and active PTYs can split across two app identities.
 * New installations, which have no legacy root, use Whitebox's normal path.
 */
function selectBrandUserData(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const pathModule = options.pathModule || path;
  const platform = options.platform || process.platform;
  const result = {
    path: '',
    source: 'whitebox',
    legacyPath: '',
    errors: [],
  };

  if (typeof options.userDataPath !== 'string' || !options.userDataPath.trim()) {
    result.errors.push(errorRecord('.', 'validate-current-path', new TypeError('userDataPath is required')));
    return result;
  }

  let currentPath;
  let candidates;
  try {
    currentPath = pathModule.resolve(options.userDataPath);
    candidates = options.legacyUserDataPath
      ? [pathModule.resolve(options.legacyUserDataPath)]
      : resolveLegacyUserDataPaths(currentPath, pathModule).map(candidate => pathModule.resolve(candidate));
  } catch (error) {
    result.errors.push(errorRecord('.', 'resolve-paths', error));
    return result;
  }

  result.path = currentPath;
  const seen = new Set();
  for (const candidate of candidates) {
    const comparisonKey = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(comparisonKey)) continue;
    seen.add(comparisonKey);
    if (candidate === currentPath) {
      result.errors.push(errorRecord(candidate, 'validate-legacy-path', new Error('Legacy and current userData paths must differ')));
      continue;
    }

    let state;
    try {
      state = fileSystem.lstatSync(candidate);
    } catch (error) {
      if (MISSING_CODES.has(error?.code)) continue;
      result.errors.push(errorRecord(candidate, 'inspect-legacy-path', error));
      continue;
    }

    if (state.isSymbolicLink() || !state.isDirectory()) {
      result.errors.push(errorRecord(candidate, 'validate-legacy-path', new Error('Legacy userData path is symbolic or not a directory')));
      continue;
    }

    result.path = candidate;
    result.source = 'legacy';
    result.legacyPath = candidate;
    return result;
  }

  return result;
}

module.exports = {
  LEGACY_PRODUCT_NAME,
  LEGACY_USER_DATA_NAMES,
  PRODUCT_NAME,
  resolveLegacyUserDataPath,
  resolveLegacyUserDataPaths,
  selectBrandUserData,
};
