'use strict';

const fs = require('fs');
const path = require('path');

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function versionParts(value) {
  const match = String(value || '').match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  return match ? match.slice(1).map(part => Number(part || 0)) : null;
}

function compareVersionNames(left, right) {
  const a = versionParts(left) || [0, 0, 0];
  const b = versionParts(right) || [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

function resolveNvmDefault(home, fileSystem = fs) {
  const aliasRoot = path.join(home, '.nvm', 'alias');
  let value = 'default';
  const visited = new Set();
  for (let depth = 0; depth < 6; depth += 1) {
    if (/^v?\d+(?:\.\d+){0,2}$/.test(value)) return value.replace(/^v/, '');
    if (value === 'node' || value === 'stable') return '';
    if (!/^[A-Za-z0-9*._/-]+$/.test(value) || value.includes('..') || visited.has(value)) return '';
    visited.add(value);
    try {
      value = String(fileSystem.readFileSync(path.join(aliasRoot, value), 'utf8')).trim();
    } catch (_missingAlias) {
      return '';
    }
  }
  return '';
}

function preferredNvmBin(home, fileSystem = fs) {
  const versionsRoot = path.join(home, '.nvm', 'versions', 'node');
  let versions = [];
  try {
    versions = fileSystem.readdirSync(versionsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && versionParts(entry.name))
      .map(entry => entry.name)
      .sort(compareVersionNames);
  } catch (_missingNvm) {
    return '';
  }
  const selector = resolveNvmDefault(home, fileSystem);
  const selectorParts = selector ? selector.split('.') : [];
  const selected = versions.find(version => {
    if (!selectorParts.length) return true;
    const parts = String(version).replace(/^v/, '').split('.');
    return selectorParts.every((part, index) => parts[index] === part);
  });
  return selected ? path.join(versionsRoot, selected, 'bin') : '';
}

function macPathEntries(home, pathValue = '', fileSystem = fs) {
  const existing = String(pathValue || '').split(path.delimiter).filter(Boolean);
  return unique([
    ...existing,
    preferredNvmBin(home, fileSystem),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
  ]);
}

module.exports = { macPathEntries, preferredNvmBin, resolveNvmDefault };
