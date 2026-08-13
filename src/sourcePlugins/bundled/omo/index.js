'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { OMO_MANIFEST, OMO_PLUGIN_ID } = require('./manifest');
const {
  attachOpenCodeHierarchy,
  computeStatus,
  normalizeModelProvider,
  parseOpenCodeSession,
  parsedMessageRow,
  parsedPartRow,
  platformEnvironment,
  redactSecrets,
  safeJson,
  timestamp,
  toolStatus,
} = require('./parser');

const DEFAULT_CARD_LIMIT = 200;
const DEFAULT_CARD_MESSAGES = 32;
const DEFAULT_CARD_PARTS = 160;
const DEFAULT_DETAIL_MESSAGES = 2_000;
const DEFAULT_DETAIL_PARTS = 12_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function openCodeDbPath(options = {}) {
  if (options.dbPath) return path.resolve(String(options.dbPath));
  const env = options.env || process.env;
  if (env.OPENCODE_DATA_DIR) return path.resolve(String(env.OPENCODE_DATA_DIR), 'opencode.db');
  return path.join(options.homeDir || options.home || os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

function omoConfigPaths(options = {}) {
  const env = options.env || process.env;
  const home = options.homeDir || options.home || os.homedir();
  const paths = [];
  if (env.OPENCODE_CONFIG) paths.push(path.resolve(String(env.OPENCODE_CONFIG)));
  if (env.XDG_CONFIG_HOME) {
    paths.push(path.resolve(String(env.XDG_CONFIG_HOME), 'opencode', 'opencode.json'));
    paths.push(path.resolve(String(env.XDG_CONFIG_HOME), 'opencode', 'opencode.jsonc'));
  }
  paths.push(path.join(home, '.config', 'opencode', 'opencode.json'));
  paths.push(path.join(home, '.config', 'opencode', 'opencode.jsonc'));
  if (env.APPDATA) {
    paths.push(path.resolve(String(env.APPDATA), 'opencode', 'opencode.json'));
    paths.push(path.resolve(String(env.APPDATA), 'opencode', 'opencode.jsonc'));
  }
  return [...new Set(paths)];
}

function detectOmoConfiguration(options = {}) {
  const maxBytes = 512 * 1024;
  for (const file of omoConfigPaths(options)) {
    let descriptor = null;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size <= 0) continue;
      descriptor = fs.openSync(file, 'r');
      const buffer = Buffer.allocUnsafe(Math.min(maxBytes, stat.size));
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      if (/oh-my-(?:openagent|opencode)(?:@|["'\s,\]]|$)/i.test(buffer.toString('utf8', 0, bytes))) return true;
    } catch (_unreadableConfig) {
      // Configuration is optional evidence. Never expose its contents.
    } finally {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
  }
  return false;
}

function hasOmoSessionEvidence(session) {
  if (!session) return false;
  const agentText = [
    session.agentName,
    session.agentRole,
    session.title,
    ...(session.messages || []).map(message => message && message.agentName),
  ].filter(Boolean).join(' ');
  if (/\b(?:atlas|hephaestus|librarian|metis|momus|multimodal-looker|oracle|prometheus|sisyphus(?:-junior)?)\b/i.test(agentText)) return true;
  return (session.lifecycle || []).some(event => /^(?:background_(?:cancel|output|task)|call_omo_agent|look_at)$/i.test(String(event && event.tool || '')));
}

function selectOmoSessions(sessions, configured) {
  if (configured) return sessions;
  const byExternalId = new Map(sessions.map(session => [session.externalId, session]));
  const selected = new Set(sessions.filter(hasOmoSessionEvidence).map(session => session.externalId));
  let changed = true;
  while (changed) {
    changed = false;
    for (const externalId of [...selected]) {
      const session = byExternalId.get(externalId);
      const related = [session && session.parentExternalId, ...(session && session.childExternalIds || [])].filter(Boolean);
      for (const id of related) {
        if (!byExternalId.has(id) || selected.has(id)) continue;
        selected.add(id);
        changed = true;
      }
    }
  }
  return sessions.filter(session => selected.has(session.externalId));
}

function sqliteConstructor() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_unsupportedRuntime) {
    return null;
  }
}

class OmoOpenCodeError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'OmoOpenCodeError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

class OmoOpenCodeMonitor {
  constructor(options = {}) {
    this.dbPath = openCodeDbPath(options);
    this.idPrefix = String(options.idPrefix || OMO_PLUGIN_ID);
    this.cardLimit = boundedInteger(options.cardLimit, DEFAULT_CARD_LIMIT, 1, 500);
    this.cardMessages = boundedInteger(options.cardMessages, DEFAULT_CARD_MESSAGES, 1, 100);
    this.cardParts = boundedInteger(options.cardParts, DEFAULT_CARD_PARTS, 1, 500);
    this.detailMessages = boundedInteger(options.detailMessages, DEFAULT_DETAIL_MESSAGES, 1, 10_000);
    this.detailParts = boundedInteger(options.detailParts, DEFAULT_DETAIL_PARTS, 1, 50_000);
    this.now = typeof options.now === 'function' ? options.now : () => Number(options.now || Date.now());
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.omoConfigured = options.omoConfigured == null ? detectOmoConfiguration(options) : Boolean(options.omoConfigured);
    this.evidenceObserved = null;
    this.ownedExternalIds = new Set();
    this.DatabaseSync = options.DatabaseSync || sqliteConstructor();
    this.db = null;
    this.lastError = null;
  }

  watchRoots() {
    return [path.dirname(this.dbPath)];
  }

  watchFiles() {
    return [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`];
  }

  status() {
    if (!this.DatabaseSync) {
      return {
        id: OMO_PLUGIN_ID,
        available: false,
        enabled: true,
        mode: 'read-only',
        reason: 'This Node.js runtime does not provide node:sqlite.',
      };
    }
    if (!fs.existsSync(this.dbPath)) {
      return {
        id: OMO_PLUGIN_ID,
        available: false,
        enabled: true,
        mode: 'read-only',
        reason: 'OpenCode local history was not found.',
      };
    }
    if (this.evidenceObserved === false) {
      return {
        id: OMO_PLUGIN_ID,
        available: false,
        enabled: true,
        mode: 'read-only',
        reason: 'OpenCode history exists, but no Oh My OpenAgent configuration or session evidence was found.',
      };
    }
    return {
      id: OMO_PLUGIN_ID,
      available: !this.lastError,
      enabled: true,
      mode: 'read-only',
      reason: this.lastError ? this.lastError.message : '',
    };
  }

  _open() {
    if (this.db) return this.db;
    if (!this.DatabaseSync) throw new OmoOpenCodeError('SQLITE_UNAVAILABLE', 'node:sqlite is unavailable in this runtime.');
    if (!fs.existsSync(this.dbPath)) throw new OmoOpenCodeError('DB_NOT_FOUND', 'OpenCode local history was not found.');
    try {
      this.db = new this.DatabaseSync(this.dbPath, { readOnly: true, timeout: 500 });
      const requiredTables = new Set(['session', 'message', 'part']);
      const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      for (const row of rows) requiredTables.delete(String(row.name || ''));
      if (requiredTables.size) {
        this.close();
        throw new OmoOpenCodeError('DB_SCHEMA_UNSUPPORTED', `OpenCode history is missing table(s): ${[...requiredTables].join(', ')}`);
      }
      const requiredColumns = {
        session: ['id', 'project_id', 'parent_id', 'slug', 'directory', 'title', 'version', 'summary_additions', 'summary_deletions', 'summary_files', 'summary_diffs', 'time_created', 'time_updated', 'time_compacting', 'time_archived'],
        message: ['id', 'session_id', 'time_created', 'time_updated', 'data'],
        part: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'],
      };
      for (const [table, columns] of Object.entries(requiredColumns)) {
        const available = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name || '')));
        const missing = columns.filter(column => !available.has(column));
        if (!missing.length) continue;
        this.close();
        throw new OmoOpenCodeError('DB_SCHEMA_UNSUPPORTED', `OpenCode ${table} table is missing column(s): ${missing.join(', ')}`);
      }
      this.lastError = null;
      return this.db;
    } catch (error) {
      this.lastError = error instanceof OmoOpenCodeError
        ? error
        : new OmoOpenCodeError('DB_OPEN_FAILED', 'OpenCode local history could not be opened read-only.', error);
      throw this.lastError;
    }
  }

  _sessionRows(limit) {
    return this._open().prepare(`
      WITH RECURSIVE
      recent(id) AS (
        SELECT id FROM session ORDER BY time_updated DESC LIMIT ?
      ),
      closure(id) AS (
        SELECT id FROM recent
        UNION
        SELECT parent.parent_id
        FROM session AS parent
        JOIN closure ON parent.id = closure.id
        WHERE parent.parent_id IS NOT NULL
      )
      SELECT
        id, project_id, parent_id, slug, directory, title, version,
        summary_additions, summary_deletions, summary_files, summary_diffs,
        time_created, time_updated, time_compacting, time_archived
      FROM session
      WHERE id IN (SELECT id FROM closure)
      ORDER BY time_updated DESC
    `).all(limit);
  }

  _oneSession(externalId) {
    return this._open().prepare(`
      SELECT
        id, project_id, parent_id, slug, directory, title, version,
        summary_additions, summary_deletions, summary_files, summary_diffs,
        time_created, time_updated, time_compacting, time_archived
      FROM session
      WHERE id = ?
      LIMIT 1
    `).get(externalId) || null;
  }

  _messageRows(externalId, limit) {
    return this._open().prepare(`
      SELECT * FROM (
        SELECT id, session_id, time_created, time_updated, data
        FROM message
        WHERE session_id = ?
        ORDER BY time_created DESC
        LIMIT ?
      )
      ORDER BY time_created ASC
    `).all(externalId, limit);
  }

  _partRows(externalId, limit) {
    return this._open().prepare(`
      SELECT * FROM (
        SELECT id, message_id, session_id, time_created, time_updated, data
        FROM part
        WHERE session_id = ?
        ORDER BY time_created DESC
        LIMIT ?
      )
      ORDER BY time_created ASC
    `).all(externalId, limit);
  }

  _counts(externalId) {
    const db = this._open();
    return {
      totalMessages: Number(db.prepare('SELECT COUNT(*) AS count FROM message WHERE session_id = ?').get(externalId).count || 0),
      totalParts: Number(db.prepare('SELECT COUNT(*) AS count FROM part WHERE session_id = ?').get(externalId).count || 0),
    };
  }

  _parse(sessionRow, options = {}) {
    const externalId = String(sessionRow.id || '');
    const messageLimit = options.fullHistory ? this.detailMessages : this.cardMessages;
    const partLimit = options.fullHistory ? this.detailParts : this.cardParts;
    const counts = options.fullHistory ? this._counts(externalId) : null;
    return parseOpenCodeSession({
      sessionRow,
      messageRows: this._messageRows(externalId, messageLimit),
      partRows: this._partRows(externalId, partLimit),
      totalMessages: counts && counts.totalMessages,
      totalParts: counts && counts.totalParts,
    }, {
      idPrefix: this.idPrefix,
      dbPath: this.dbPath,
      now: this.now(),
      platform: this.platform,
      arch: this.arch,
      fullHistory: Boolean(options.fullHistory),
      resultLimit: options.fullHistory ? 64 * 1024 : 1200,
    });
  }

  scan(options = {}) {
    const limit = boundedInteger(options.limit, this.cardLimit, 1, 500);
    try {
      const parsed = this._sessionRows(limit).map(row => this._parse(row, { fullHistory: false })).filter(Boolean);
      const sessions = selectOmoSessions(parsed, this.omoConfigured);
      this.ownedExternalIds = new Set(sessions.map(session => session.externalId));
      this.evidenceObserved = this.omoConfigured || sessions.some(hasOmoSessionEvidence);
      this.lastError = null;
      return attachOpenCodeHierarchy(sessions, this.idPrefix);
    } catch (error) {
      this.lastError = error instanceof OmoOpenCodeError
        ? error
        : new OmoOpenCodeError('DB_READ_FAILED', 'OpenCode local history could not be read.', error);
      throw this.lastError;
    }
  }

  detail(id) {
    const raw = String(id || '');
    const prefix = `${this.idPrefix}:`;
    const externalId = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    if (!externalId || externalId.includes('\u0000')) return null;
    try {
      const row = this._oneSession(externalId);
      if (!row) return null;
      const session = this._parse(row, { fullHistory: true });
      if (!this.omoConfigured && !this.ownedExternalIds.has(externalId) && !hasOmoSessionEvidence(session)) return null;
      this.lastError = null;
      return session;
    } catch (error) {
      this.lastError = error instanceof OmoOpenCodeError
        ? error
        : new OmoOpenCodeError('DB_READ_FAILED', 'OpenCode session detail could not be read.', error);
      throw this.lastError;
    }
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch (_alreadyClosed) {
      // Closing a read-only observer must not interfere with app shutdown.
    }
    this.db = null;
  }
}

function createOmoMonitorPlugin(options = {}) {
  const monitor = new OmoOpenCodeMonitor(options);
  return {
    manifest: OMO_MANIFEST,
    watchRoots: () => monitor.watchRoots(),
    watchFiles: () => monitor.watchFiles(),
    status: () => monitor.status(),
    scan: scanOptions => monitor.scan(scanOptions),
    detail: id => monitor.detail(id),
    close: () => monitor.close(),
    monitor,
  };
}

module.exports = {
  DEFAULT_CARD_LIMIT,
  OMO_MANIFEST,
  OMO_PLUGIN_ID,
  OmoOpenCodeError,
  OmoOpenCodeMonitor,
  attachOpenCodeHierarchy,
  computeStatus,
  createOmoMonitorPlugin,
  detectOmoConfiguration,
  hasOmoSessionEvidence,
  omoConfigPaths,
  normalizeModelProvider,
  openCodeDbPath,
  parseOpenCodeSession,
  parsedMessageRow,
  parsedPartRow,
  platformEnvironment,
  redactSecrets,
  safeJson,
  selectOmoSessions,
  timestamp,
  toolStatus,
};
