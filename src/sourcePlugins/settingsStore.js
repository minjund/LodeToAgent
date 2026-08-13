'use strict';

const fs = require('fs');
const path = require('path');
const { restrictPathPermissions } = require('../dataRetention');

const DEFAULT_SETTINGS = Object.freeze({ version: 1, asideHistoryFolders: [] });

function normalizeSettings(value) {
  const folders = Array.isArray(value && value.asideHistoryFolders)
    ? value.asideHistoryFolders.map(item => String(item || '').trim()).filter(Boolean).map(item => path.resolve(item))
    : [];
  return { version: 1, asideHistoryFolders: [...new Set(folders)].slice(0, 20) };
}

class SourcePluginSettingsStore {
  constructor(file) {
    this.file = file;
    this.value = { ...DEFAULT_SETTINGS };
    this.load();
  }

  load() {
    try {
      this.value = normalizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      this.value = { ...DEFAULT_SETTINGS };
    }
    return this.snapshot();
  }

  snapshot() {
    return { ...this.value, asideHistoryFolders: [...this.value.asideHistoryFolders] };
  }

  save(next) {
    this.value = normalizeSettings(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.value, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temporary, this.file);
    } catch (_renameUnavailable) {
      // Windows can reject replacing an existing destination. Keep the update
      // recoverable without ever writing a partial JSON document in place.
      try {
        fs.copyFileSync(temporary, this.file);
      } finally {
        try { fs.unlinkSync(temporary); } catch {}
      }
    }
    restrictPathPermissions(this.file);
    return this.snapshot();
  }

  addAsideHistoryFolder(folder) {
    const value = String(folder || '').trim();
    if (!value) throw new Error('Aside 작업 폴더를 선택하세요.');
    const resolved = path.resolve(value);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('Aside 작업 폴더를 찾을 수 없습니다.');
    return this.save({ ...this.value, asideHistoryFolders: [...this.value.asideHistoryFolders, resolved] });
  }

  removeAsideHistoryFolder(folder) {
    const value = String(folder || '').trim();
    if (!value) return this.snapshot();
    const resolved = path.resolve(value);
    return this.save({ ...this.value, asideHistoryFolders: this.value.asideHistoryFolders.filter(item => item !== resolved) });
  }
}

module.exports = { DEFAULT_SETTINGS, SourcePluginSettingsStore, normalizeSettings };
