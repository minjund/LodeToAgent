'use strict';

const fs = require('fs');
const path = require('path');
const { runBestEffort } = require('./diagnostics');

const DEFAULT_RETENTION_DAYS = 30;
const TERMINAL_RETENTION_STATUSES = new Set(['exited', 'failed', 'stopped']);
const RUN_RETENTION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function retentionDays(value = process.env.LOADTOAGENT_RETENTION_DAYS) {
  if (value === '' || value == null) return DEFAULT_RETENTION_DAYS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(Math.floor(parsed), 3650) : DEFAULT_RETENTION_DAYS;
}

function isExpired(timestamp, days, now = Date.now()) {
  const time = Date.parse(String(timestamp || ''));
  if (!Number.isFinite(time)) return false;
  return now - time > days * 24 * 60 * 60 * 1000;
}

function shouldRetainTerminalSession(session, days, now = Date.now()) {
  if (!TERMINAL_RETENTION_STATUSES.has(String(session?.status || ''))) return true;
  return !isExpired(session?.updatedAt || session?.createdAt, days, now);
}

function isDirectChild(parent, target) {
  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(target);
  return path.dirname(resolvedTarget) === resolvedParent && resolvedTarget !== resolvedParent;
}

function pruneManagedRuns(runsDir, options = {}) {
  const days = retentionDays(options.retentionDays);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fileSystem = options.fileSystem || fs;
  const root = path.resolve(runsDir);
  let removed = 0;
  let inspected = 0;
  let entries;

  try {
    entries = fileSystem.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { inspected, removed };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    inspected += 1;
    const dir = path.resolve(root, entry.name);
    if (!isDirectChild(root, dir)) continue;
    try {
      const state = JSON.parse(fileSystem.readFileSync(path.join(dir, 'session.json'), 'utf8'));
      if (!RUN_RETENTION_STATUSES.has(String(state?.status || ''))) continue;
      if (!isExpired(state.endedAt || state.updatedAt || state.startedAt, days, now)) continue;
      fileSystem.rmSync(dir, { recursive: true, force: false });
      removed += 1;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) {
        runBestEffort(`retention-run:${entry.name}`, () => {
          throw error;
        });
      }
    }
  }
  return { inspected, removed };
}

function restrictPathPermissions(target, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const platform = options.platform || process.platform;
  if (platform === 'win32') return;
  runBestEffort(`restrict-permissions:${target}`, () => {
    const stat = fileSystem.statSync(target);
    fileSystem.chmodSync(target, stat.isDirectory() ? 0o700 : 0o600);
  });
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  retentionDays,
  isExpired,
  shouldRetainTerminalSession,
  pruneManagedRuns,
  restrictPathPermissions,
};
