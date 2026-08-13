'use strict';

const fs = require('fs');
const path = require('path');

const LEGACY_PRODUCT_NAME = 'LoadToAgent';
const LEGACY_USER_DATA_NAMES = Object.freeze(['loadtoagent', LEGACY_PRODUCT_NAME]);
const PRODUCT_NAME = 'Whitebox';
const ACTIVE_PROFILE_SENTINEL = '.whitebox-profile-active-v2.json';
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

function regularFile(fileSystem, candidate) {
  try {
    const state = fileSystem.lstatSync(candidate);
    return !state.isSymbolicLink() && state.isFile() ? state : null;
  } catch (error) {
    if (MISSING_CODES.has(error?.code)) return null;
    throw error;
  }
}

function hasActiveProfileSentinel(currentPath, fileSystem = fs, pathModule = path) {
  const sentinel = pathModule.join(currentPath, ACTIVE_PROFILE_SENTINEL);
  const state = regularFile(fileSystem, sentinel);
  if (!state || state.size > 4 * 1024) return false;
  try {
    const value = JSON.parse(fileSystem.readFileSync(sentinel, 'utf8'));
    return value?.product === PRODUCT_NAME && value?.version === 2 && value?.active === true;
  } catch {
    return false;
  }
}

function markProfileActive(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const pathModule = options.pathModule || path;
  if (typeof options.currentPath !== 'string' || !options.currentPath.trim()
    || typeof options.selectedPath !== 'string' || !options.selectedPath.trim()) {
    throw new TypeError('currentPath and selectedPath are required');
  }
  const currentPath = pathModule.resolve(options.currentPath);
  const selectedPath = pathModule.resolve(options.selectedPath);
  const platform = options.platform || process.platform;
  const key = value => platform === 'win32' ? value.toLowerCase() : value;
  if (!currentPath || key(currentPath) !== key(selectedPath)) return { written: false, reason: 'legacy-profile' };
  if (hasActiveProfileSentinel(currentPath, fileSystem, pathModule)) {
    return { written: false, reason: 'already-active', path: pathModule.join(currentPath, ACTIVE_PROFILE_SENTINEL) };
  }

  const sentinel = pathModule.join(currentPath, ACTIVE_PROFILE_SENTINEL);
  const temporary = `${sentinel}.${process.pid}.${Date.now()}.tmp`;
  fileSystem.mkdirSync(currentPath, { recursive: true, mode: 0o700 });
  try {
    fileSystem.writeFileSync(temporary, JSON.stringify({
      product: PRODUCT_NAME,
      version: 2,
      active: true,
      activatedAt: new Date().toISOString(),
    }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fileSystem.renameSync(temporary, sentinel);
    return { written: true, path: sentinel };
  } catch (error) {
    try { fileSystem.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
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
    currentPath: '',
    runtimePath: '',
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
  result.currentPath = currentPath;
  result.runtimePath = currentPath;
  const seen = new Set();
  let legacyPath = '';
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

    legacyPath = candidate;
    break;
  }

  result.legacyPath = legacyPath;
  result.runtimePath = legacyPath || currentPath;
  let currentProfileActive = false;
  try {
    // Only a marker written after a verified renderer bootstrap can switch an
    // existing installation to the new profile. Raw LevelDB bytes are not a
    // reliable signal (deleted keys can remain in old table files). Renderer
    // state from an interim Whitebox profile is merged logically at startup.
    currentProfileActive = hasActiveProfileSentinel(currentPath, fileSystem, pathModule);
  } catch (error) {
    result.errors.push(errorRecord(currentPath, 'inspect-current-renderer-state', error));
  }
  if (legacyPath && !currentProfileActive) {
    result.path = legacyPath;
    result.source = 'legacy';
  } else if (legacyPath) {
    result.source = 'whitebox-recovered';
  }

  return result;
}

module.exports = {
  LEGACY_PRODUCT_NAME,
  LEGACY_USER_DATA_NAMES,
  ACTIVE_PROFILE_SENTINEL,
  PRODUCT_NAME,
  hasActiveProfileSentinel,
  markProfileActive,
  resolveLegacyUserDataPath,
  resolveLegacyUserDataPaths,
  selectBrandUserData,
};
