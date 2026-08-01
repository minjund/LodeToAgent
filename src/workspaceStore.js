'use strict';

const fs = require('fs');
const path = require('path');

function workspacePathState(fileSystem, target) {
  try {
    return fileSystem.statSync(target).isDirectory() ? 'directory' : 'not-directory';
  } catch (_missingOrUnreadableWorkspace) {
    // Keep the user's intent when a removable/network volume is temporarily
    // unavailable. A later save must not silently erase that workspace.
    return 'unavailable';
  }
}

function workspaceKey(target, platform = process.platform) {
  return platform === 'win32' ? target.toLowerCase() : target;
}

function normalizeWorkspaces(items, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const platform = options.platform || process.platform;
  const unique = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const suppliedPath = typeof item?.path === 'string' ? item.path.trim() : '';
    if (!suppliedPath) continue;

    const target = path.resolve(suppliedPath);
    const key = workspaceKey(target, platform);
    if (seen.has(key) || workspacePathState(fileSystem, target) === 'not-directory') continue;

    seen.add(key);
    unique.push({
      path: target,
      name: String(item.name || '').trim() || path.basename(target),
    });
  }

  return unique;
}

function readWorkspaces(file, options = {}) {
  const fileSystem = options.fileSystem || fs;
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
    return normalizeWorkspaces(parsed, options);
  } catch (_missingOrInvalidConfig) {
    return [];
  }
}

function writeWorkspaces(file, items, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const normalized = normalizeWorkspaces(items, options);
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fileSystem.writeFileSync(temporary, JSON.stringify(normalized, null, 2), 'utf8');
  fileSystem.renameSync(temporary, file);
  return normalized;
}

function removeWorkspace(items, suppliedPath, options = {}) {
  const value = typeof suppliedPath === 'string' ? suppliedPath.trim() : '';
  if (!value) return normalizeWorkspaces(items, options);

  const platform = options.platform || process.platform;
  const removalKey = workspaceKey(path.resolve(value), platform);
  return normalizeWorkspaces(items, options).filter(item => workspaceKey(item.path, platform) !== removalKey);
}

module.exports = {
  normalizeWorkspaces,
  readWorkspaces,
  removeWorkspace,
  workspaceKey,
  writeWorkspaces,
};
