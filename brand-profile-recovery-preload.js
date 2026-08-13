'use strict';

const { ipcRenderer } = require('electron');

const IPC_READY = 'whitebox:brand-profile-recovery-ready';
const IPC_REQUEST = 'whitebox:brand-profile-recovery-request';
const IPC_RESULT = 'whitebox:brand-profile-recovery-result';
const MAX_VALUE_CHARACTERS = 2 * 1024 * 1024;
const STORAGE_KEY_PATTERN = /^(?:loadtoagent|whitebox):(?:provider-visibility:v1|dashboard-preferences:v2|quality-preferences:v3|session-archives:v1|result-reviews:v1|project-notice-acks:v1|project-dismissals:v1|start-guide:v1|locale:v1|terminal-session-order:v1|terminal-view:v1|theme:v1)$/;

function safeKey(value) {
  const key = String(value || '');
  return STORAGE_KEY_PATTERN.test(key) ? key : '';
}

function read(keys) {
  const values = {};
  const errors = [];
  let totalCharacters = 0;
  for (const value of Array.isArray(keys) ? keys : []) {
    const key = safeKey(value);
    if (!key) continue;
    const stored = localStorage.getItem(key);
    if (stored !== null) {
      if (stored.length > MAX_VALUE_CHARACTERS) {
        values[key] = null;
        errors.push(`${key}:oversized`);
        continue;
      }
      totalCharacters += stored.length;
      if (totalCharacters > MAX_VALUE_CHARACTERS * 4) {
        values[key] = null;
        errors.push(`${key}:total-limit`);
        continue;
      }
    }
    values[key] = stored;
  }
  return { values, errors };
}

ipcRenderer.on(IPC_REQUEST, (_event, payload = {}) => {
  const requestId = String(payload.requestId || '');
  if (!requestId) return;
  try {
    let result;
    if (payload.operation === 'read') result = read(payload.keys);
    else if (payload.operation === 'write') {
      const requested = payload.values && typeof payload.values === 'object' ? payload.values : {};
      const keys = [];
      for (const [candidate, value] of Object.entries(requested)) {
        const key = safeKey(candidate);
        if (!key || !key.startsWith('whitebox:') || typeof value !== 'string'
          || value.length > MAX_VALUE_CHARACTERS) throw new Error('Invalid renderer profile recovery value');
        localStorage.setItem(key, value);
        keys.push(key);
      }
      result = read(keys);
    } else throw new Error('Unsupported renderer profile recovery operation');
    ipcRenderer.send(IPC_RESULT, { requestId, ok: true, ...result });
  } catch (error) {
    ipcRenderer.send(IPC_RESULT, { requestId, ok: false, error: error?.message || String(error) });
  }
});

window.addEventListener('DOMContentLoaded', () => ipcRenderer.send(IPC_READY), { once: true });
