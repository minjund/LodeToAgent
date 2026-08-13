'use strict';

const crypto = require('crypto');
const path = require('path');

const LEGACY_STORAGE_PREFIX = 'loadtoagent';
const CURRENT_STORAGE_PREFIX = 'whitebox';
const PERSISTENT_STORAGE_SUFFIXES = Object.freeze([
  'provider-visibility:v1',
  'dashboard-preferences:v2',
  'quality-preferences:v3',
  'session-archives:v1',
  'result-reviews:v1',
  'project-notice-acks:v1',
  'project-dismissals:v1',
  'start-guide:v1',
  'locale:v1',
  'terminal-session-order:v1',
  'terminal-view:v1',
  'theme:v1',
]);
const STORAGE_KEYS = Object.freeze(PERSISTENT_STORAGE_SUFFIXES.flatMap(suffix => [
  `${LEGACY_STORAGE_PREFIX}:${suffix}`,
  `${CURRENT_STORAGE_PREFIX}:${suffix}`,
]));
const RECORD_MAP_CONFIG = Object.freeze({
  'session-archives:v1': Object.freeze({ limit: 500, timestamp: value => Number(value?.archivedAt || value?.responseAt || 0) }),
  'result-reviews:v1': Object.freeze({ limit: 500, timestamp: value => Number(value?.reviewedAt || 0) }),
  'project-notice-acks:v1': Object.freeze({ limit: 1_000, timestamp: value => Number(value?.seenAt || 0) }),
});
const MAX_VALUE_CHARACTERS = 2 * 1024 * 1024;
const IPC_READY = 'whitebox:brand-profile-recovery-ready';
const IPC_REQUEST = 'whitebox:brand-profile-recovery-request';
const IPC_RESULT = 'whitebox:brand-profile-recovery-result';
const DEFAULT_TIMEOUT_MS = 8_000;

function storageKey(prefix, suffix) {
  return `${prefix}:${suffix}`;
}

function boundedStorageValue(value) {
  return typeof value === 'string' && value.length <= MAX_VALUE_CHARACTERS ? value : null;
}

function recordIsValid(suffix, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (suffix === 'session-archives:v1') {
    return Number.isFinite(Number(value.responseAt))
      && Number.isFinite(Number(value.archivedAt || 0));
  }
  if (suffix === 'result-reviews:v1') {
    return typeof value.stamp === 'string' && Boolean(value.stamp)
      && Number.isFinite(Number(value.reviewedAt || 0));
  }
  return typeof value.stamp === 'string' && Boolean(value.stamp)
    && Number.isFinite(Number(value.seenAt || 0));
}

function parseRecordMap(value, suffix, label, warnings) {
  const bounded = boundedStorageValue(value);
  if (bounded === null) {
    if (value != null) warnings.push(`${label}:${suffix}:oversized`);
    return null;
  }
  try {
    const parsed = JSON.parse(bounded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return Object.fromEntries(Object.entries(parsed)
      .filter(([key, record]) => key && recordIsValid(suffix, record)));
  } catch {
    warnings.push(`${label}:${suffix}:invalid-json`);
    return null;
  }
}

function mergeRecordMap(suffix, candidates, warnings) {
  const config = RECORD_MAP_CONFIG[suffix];
  const records = new Map();
  let found = false;
  candidates.forEach((candidate, priority) => {
    const parsed = parseRecordMap(candidate.value, suffix, candidate.label, warnings);
    if (parsed === null) return;
    found = true;
    for (const [key, value] of Object.entries(parsed)) {
      const timestamp = config.timestamp(value);
      const previous = records.get(key);
      if (!previous || timestamp > previous.timestamp
        || (timestamp === previous.timestamp && priority >= previous.priority)) {
        records.set(key, { value, timestamp, priority });
      }
    }
  });
  if (!found) return null;
  const recent = [...records.entries()]
    .sort((left, right) => right[1].timestamp - left[1].timestamp || left[0].localeCompare(right[0]))
    .slice(0, config.limit)
    .map(([key, record]) => [key, record.value]);
  return JSON.stringify(Object.fromEntries(recent));
}

function validPreferenceValue(suffix, value) {
  const bounded = boundedStorageValue(value);
  if (bounded === null) return false;
  if (suffix === 'theme:v1') return ['dark', 'light'].includes(bounded);
  if (suffix === 'locale:v1') return ['ko', 'en', 'zh-CN'].includes(bounded);
  try {
    const parsed = JSON.parse(bounded);
    if (suffix === 'provider-visibility:v1') {
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Array.isArray(parsed.hidden) && parsed.hidden.every(value => typeof value === 'string');
    }
    if (suffix === 'dashboard-preferences:v2') return parsed?.version === 2;
    if (suffix === 'quality-preferences:v3') return parsed?.version === 3;
    if (suffix === 'project-dismissals:v1' || suffix === 'terminal-session-order:v1') {
      return Array.isArray(parsed) && parsed.every(value => typeof value === 'string');
    }
    if (suffix === 'start-guide:v1') {
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (!('completed' in parsed) || Array.isArray(parsed.completed));
    }
    if (suffix === 'terminal-view:v1') return parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    return false;
  } catch {
    return false;
  }
}

function mergeRendererState(options = {}) {
  const destination = options.destination && typeof options.destination === 'object' ? options.destination : {};
  const source = options.source && typeof options.source === 'object' ? options.source : {};
  const warnings = [];
  const values = {};
  for (const suffix of PERSISTENT_STORAGE_SUFFIXES) {
    // Low-to-high priority. Equal-timestamp record conflicts prefer the
    // selected destination profile and its current Whitebox key.
    const candidates = [
      { label: 'source-legacy', value: source[storageKey(LEGACY_STORAGE_PREFIX, suffix)] },
      { label: 'destination-legacy', value: destination[storageKey(LEGACY_STORAGE_PREFIX, suffix)] },
      { label: 'source-current', value: source[storageKey(CURRENT_STORAGE_PREFIX, suffix)] },
      { label: 'destination-current', value: destination[storageKey(CURRENT_STORAGE_PREFIX, suffix)] },
    ];
    let merged;
    if (RECORD_MAP_CONFIG[suffix]) merged = mergeRecordMap(suffix, candidates, warnings);
    else {
      const preferred = [...candidates].reverse().find(candidate => {
        if (candidate.value == null) return false;
        if (validPreferenceValue(suffix, candidate.value)) return true;
        warnings.push(`${candidate.label}:${suffix}:invalid-value`);
        return false;
      });
      merged = preferred ? boundedStorageValue(preferred.value) : null;
    }
    if (merged !== null && merged !== undefined) {
      values[storageKey(CURRENT_STORAGE_PREFIX, suffix)] = merged;
    }
  }
  return { values, warnings };
}

function waitForIpc(ipcMain, channel, sender, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      ipcMain.removeListener(channel, listener);
      if (timer) clearTimeout(timer);
    };
    const listener = (event, payload) => {
      if (event.sender !== sender || (predicate && !predicate(payload))) return;
      cleanup();
      resolve(payload);
    };
    ipcMain.on(channel, listener);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Renderer profile recovery timed out waiting for ${channel}`));
    }, timeoutMs);
  });
}

async function openRendererStateBridge(options = {}) {
  const { BrowserWindow, ipcMain, session: profileSession } = options;
  if (typeof BrowserWindow !== 'function' || !ipcMain || !profileSession) {
    throw new TypeError('BrowserWindow, ipcMain, and session are required');
  }
  const htmlPath = path.resolve(options.htmlPath || '');
  const preloadPath = path.resolve(options.preloadPath || '');
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const window = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    webPreferences: {
      preload: preloadPath,
      session: profileSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.on('preload-error', (_event, candidate, error) => {
    process.stderr.write(`Renderer profile recovery preload failed (${candidate}): ${error?.stack || error}\n`);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const ready = waitForIpc(ipcMain, IPC_READY, window.webContents, null, timeoutMs);
  try {
    await Promise.all([window.loadFile(htmlPath), ready]);
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }

  const request = async (operation, payload = {}) => {
    if (window.isDestroyed()) throw new Error('Renderer profile recovery window is closed');
    const requestId = crypto.randomUUID();
    const result = waitForIpc(
      ipcMain,
      IPC_RESULT,
      window.webContents,
      value => value?.requestId === requestId,
      timeoutMs,
    );
    window.webContents.send(IPC_REQUEST, { requestId, operation, ...payload });
    const response = await result;
    if (!response?.ok) throw new Error(String(response?.error || `Renderer profile ${operation} failed`));
    return {
      values: response.values && typeof response.values === 'object' ? response.values : {},
      errors: Array.isArray(response.errors) ? response.errors.map(String) : [],
    };
  };

  return {
    read: () => request('read', { keys: STORAGE_KEYS }),
    write: values => request('write', { values }),
    close: () => { if (!window.isDestroyed()) window.destroy(); },
  };
}

async function recoverRendererStateFromAlternateProfile(options = {}) {
  if (!options.sourceSession || !options.destinationSession) {
    return { ok: true, skipped: true, reason: 'single-profile', written: 0, warnings: [] };
  }
  let sourceBridge = null;
  let destinationBridge = null;
  try {
    // Keep the destination bridge alive for the whole operation. On Windows
    // and Linux, closing the last BrowserWindow can otherwise start app quit
    // while the alternate profile is still being read.
    destinationBridge = await openRendererStateBridge({ ...options, session: options.destinationSession });
    const destinationRead = await destinationBridge.read();
    const destination = destinationRead.values;
    sourceBridge = await openRendererStateBridge({ ...options, session: options.sourceSession });
    const sourceRead = await sourceBridge.read();
    const source = sourceRead.values;
    sourceBridge.close();
    sourceBridge = null;
    const merged = mergeRendererState({ source, destination });
    const expected = merged.values;
    const changes = Object.fromEntries(Object.entries(expected)
      .filter(([key, value]) => destination[key] !== value));
    const written = Object.keys(changes).length ? await destinationBridge.write(changes) : { values: {}, errors: [] };
    for (const [key, value] of Object.entries(changes)) {
      if (written.values[key] !== value) throw new Error(`Renderer profile recovery readback mismatch for ${key}`);
    }
    if (Object.keys(changes).length && typeof options.destinationSession.flushStorageData === 'function') {
      options.destinationSession.flushStorageData();
    }
    return {
      ok: true,
      skipped: false,
      written: Object.keys(changes).length,
      warnings: [
        ...destinationRead.errors.map(value => `destination:${value}`),
        ...sourceRead.errors.map(value => `source:${value}`),
        ...written.errors.map(value => `write:${value}`),
        ...merged.warnings,
      ],
    };
  } finally {
    sourceBridge?.close();
    destinationBridge?.close();
  }
}

module.exports = {
  CURRENT_STORAGE_PREFIX,
  IPC_READY,
  IPC_REQUEST,
  IPC_RESULT,
  LEGACY_STORAGE_PREFIX,
  MAX_VALUE_CHARACTERS,
  PERSISTENT_STORAGE_SUFFIXES,
  RECORD_MAP_CONFIG,
  STORAGE_KEYS,
  mergeRendererState,
  openRendererStateBridge,
  recoverRendererStateFromAlternateProfile,
};
