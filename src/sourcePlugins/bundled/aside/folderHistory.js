'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_MESSAGES = 10_000;
const DEFAULT_MAX_TASKS = 500;
const TRANSCRIPT_FILE_NAMES = new Set([
  'task.json', 'session.json', 'conversation.json', 'messages.json', 'transcript.json',
  'task.jsonl', 'session.jsonl', 'conversation.jsonl', 'messages.jsonl', 'transcript.jsonl',
  'events.jsonl', 'transcript.md', 'conversation.md',
]);
const BLOCKED_DIRECTORY_NAMES = new Set([
  '.git', 'node_modules', 'cache', 'code cache', 'gpu cache', 'dawncache', 'network',
  'local storage', 'session storage', 'indexeddb', 'service worker', 'safe browsing',
  'browser profile', 'browser profiles', 'profiles', 'crashpad', 'blob_storage',
  'extensions', 'extension state', 'extension rules', 'sync data', 'webstorage',
  'platform notifications', 'segmentation platform', 'optimization hints',
  'storage', 'storage-sync', 'sessionstore-backups', 'webrtc_event_logs',
]);
const BLOCKED_FILE_NAMES = new Set([
  'cookies', 'cookies-journal', 'login data', 'login data-journal', 'web data', 'web data-journal',
  'history', 'history-journal', 'local state', 'preferences', 'secure preferences',
  'network persistent state', 'trusted vault', 'transportsecurity', '.env', 'auth',
  'authentication', 'account', 'accounts', 'secret', 'secrets', 'token', 'tokens',
  'favicons', 'top sites', 'shortcuts', 'visited links', 'quota manager', 'databases',
  'extension cookies', 'shared dictionary', 'id_rsa', 'id_ed25519',
  'logins', 'key3', 'key4', 'cert8', 'cert9', 'pkcs11',
]);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function blockedName(value, kind) {
  const normalized = String(value || '').toLowerCase().trim();
  if (kind === 'directory') {
    return BLOCKED_DIRECTORY_NAMES.has(normalized)
      || /^profile\s+\d+$/i.test(normalized)
      || normalized === 'default';
  }
  const withoutExtension = normalized.replace(/\.(?:jsonl?|ndjson|txt|bak)$/i, '');
  return BLOCKED_FILE_NAMES.has(normalized) || BLOCKED_FILE_NAMES.has(withoutExtension)
    || /(?:cookie|login|password|passwd|credential|secret|api[-_ ]?key|private[-_ ]?key|auth[-_ ]?token|refresh[-_ ]?token)/i.test(normalized);
}

function blockedArtifactPath(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.some((segment, index) => segment.startsWith('.')
    || blockedName(segment, index === segments.length - 1 ? 'file' : 'directory'))) return true;
  return /\.(?:db|sqlite3?|pem|key|p12|pfx|kdbx)(?:-(?:wal|shm))?$/i.test(relative);
}

function canonicalRoots(roots, fileSystem = fs) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(roots) ? roots : []) {
    const selected = typeof value === 'string' ? value : value && value.path;
    if (!selected || !path.isAbsolute(selected)) continue;
    try {
      const resolved = fileSystem.realpathSync(path.resolve(selected));
      if (!fileSystem.statSync(resolved).isDirectory()) continue;
      if (blockedName(path.basename(resolved), 'directory')) continue;
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(resolved);
      }
    } catch (_error) {
      // Missing or inaccessible user selections are reported as empty roots.
    }
  }
  return result;
}

function safeCandidateFiles(roots, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const maxDepth = Number.isInteger(options.maxDepth) ? Math.max(0, options.maxDepth) : DEFAULT_MAX_DEPTH;
  const maxFileBytes = Number(options.maxFileBytes) > 0 ? Number(options.maxFileBytes) : DEFAULT_MAX_FILE_BYTES;
  const maxFiles = Number(options.maxFiles) > 0 ? Number(options.maxFiles) : DEFAULT_MAX_FILES;
  const files = [];

  for (const root of canonicalRoots(roots, fileSystem)) {
    const visitedDirectories = new Set();
    const visit = (directory, depth) => {
      if (depth > maxDepth || files.length >= maxFiles) return;
      let realDirectory;
      try {
        realDirectory = fileSystem.realpathSync(directory);
        if (!isWithin(root, realDirectory) || visitedDirectories.has(realDirectory)) return;
        visitedDirectories.add(realDirectory);
      } catch (_error) {
        return;
      }
      let entries;
      try {
        entries = fileSystem.readdirSync(realDirectory, { withFileTypes: true });
      } catch (_error) {
        return;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        if (blockedName(entry.name, entry.isDirectory() ? 'directory' : 'file')) continue;
        const unresolved = path.join(realDirectory, entry.name);
        let stat;
        let realEntry;
        try {
          const linkStat = fileSystem.lstatSync(unresolved);
          realEntry = fileSystem.realpathSync(unresolved);
          if (!isWithin(root, realEntry)) continue;
          stat = linkStat.isSymbolicLink() ? fileSystem.statSync(realEntry) : linkStat;
        } catch (_error) {
          continue;
        }
        if (stat.isDirectory()) {
          if (!blockedName(entry.name, 'directory')) visit(realEntry, depth + 1);
          continue;
        }
        if (!stat.isFile() || stat.size <= 0 || stat.size > maxFileBytes) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (!['.json', '.jsonl', '.ndjson', '.md'].includes(extension)) continue;
        const base = entry.name.toLowerCase();
        if (!TRANSCRIPT_FILE_NAMES.has(base) && !/(?:task|session|conversation|message|transcript|event)/i.test(base)) continue;
        files.push({ root, file: realEntry, directory: realDirectory, size: stat.size, extension });
      }
    };
    visit(root, 0);
  }
  return files;
}

function readBoundedText(fileInfo, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const maxFileBytes = Number(options.maxFileBytes) > 0 ? Number(options.maxFileBytes) : DEFAULT_MAX_FILE_BYTES;
  const realFile = fileSystem.realpathSync(fileInfo.file);
  if (!isWithin(fileInfo.root, realFile)) throw new Error('Aside transcript escaped its selected folder.');
  const stat = fileSystem.statSync(realFile);
  if (!stat.isFile() || stat.size > maxFileBytes) throw new Error('Aside transcript exceeds the read limit.');
  return fileSystem.readFileSync(realFile, 'utf8').replace(/^\uFEFF/, '');
}

function listContainedArtifactFiles(root, directory, transcriptFiles = new Set(), options = {}) {
  const fileSystem = options.fileSystem || fs;
  const maxDepth = Number.isInteger(options.artifactMaxDepth) ? Math.max(0, options.artifactMaxDepth) : 3;
  const maxFiles = Number(options.maxArtifactFiles) > 0 ? Number(options.maxArtifactFiles) : 100;
  const artifacts = [];
  const visited = new Set();
  const visit = (current, depth) => {
    if (depth > maxDepth || artifacts.length >= maxFiles) return;
    let realDirectory;
    try {
      realDirectory = fileSystem.realpathSync(current);
      if (!isWithin(root, realDirectory) || visited.has(realDirectory)) return;
      visited.add(realDirectory);
    } catch (_error) {
      return;
    }
    let entries;
    try {
      entries = fileSystem.readdirSync(realDirectory, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      if (artifacts.length >= maxFiles || entry.name.startsWith('.')) continue;
      const unresolved = path.join(realDirectory, entry.name);
      let realEntry;
      let stat;
      try {
        realEntry = fileSystem.realpathSync(unresolved);
        if (!isWithin(root, realEntry)) continue;
        const linkStat = fileSystem.lstatSync(unresolved);
        stat = linkStat.isSymbolicLink() ? fileSystem.statSync(realEntry) : linkStat;
      } catch (_error) {
        continue;
      }
      if (stat.isDirectory()) {
        if (!blockedName(entry.name, 'directory')) visit(realEntry, depth + 1);
        continue;
      }
      if (!stat.isFile() || blockedName(entry.name, 'file') || transcriptFiles.has(realEntry)
        || TRANSCRIPT_FILE_NAMES.has(entry.name.toLowerCase())) continue;
      if (blockedArtifactPath(root, realEntry)) continue;
      artifacts.push({
        id: `folder-artifact-${crypto.createHash('sha256').update(realEntry).digest('hex').slice(0, 16)}`,
        title: entry.name,
        path: realEntry,
        kind: 'file',
        size: stat.size,
        updatedAt: isoTime(stat.mtimeMs),
      });
    }
  };
  visit(directory, 0);
  return artifacts;
}

function parseJsonFile(fileInfo, options = {}) {
  const text = readBoundedText(fileInfo, options);
  if (fileInfo.extension === '.json') return JSON.parse(text);
  const rows = [];
  const maxMessages = Number(options.maxMessages) > 0 ? Number(options.maxMessages) : DEFAULT_MAX_MESSAGES;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || rows.length >= maxMessages) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function compactText(value, limit = 200_000) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim().slice(0, limit);
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.text || item.content || item.value || '';
      return '';
    }).filter(Boolean).join('\n').trim().slice(0, limit);
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim().slice(0, limit);
    try {
      return JSON.stringify(value).slice(0, limit);
    } catch (_error) {
      return '';
    }
  }
  return String(value).slice(0, limit);
}

function isoTime(value, fallback = '') {
  if (value == null || value === '') return fallback;
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeRole(value) {
  const role = String(value || '').toLowerCase();
  if (['user', 'human', 'customer', 'requester'].includes(role)) return 'user';
  if (['assistant', 'agent', 'ai', 'model'].includes(role)) return 'assistant';
  if (['tool', 'browser', 'action', 'function'].includes(role)) return 'tool';
  if (role === 'system') return 'system';
  return '';
}

function looksLikeMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const role = normalizeRole(value.role || value.author || value.sender || value.type);
  return Boolean(role && compactText(value.text || value.content || value.message || value.prompt || value.response));
}

function normalizeMessages(value, fallbackTime = '') {
  const list = Array.isArray(value) ? value.slice(0, DEFAULT_MAX_MESSAGES) : [];
  return list.map((row, index) => {
    if (!row || typeof row !== 'object') return null;
    const role = normalizeRole(row.role || row.author || row.sender || row.type);
    const text = compactText(row.text || row.content || row.message || row.prompt || row.response || row.output);
    if (!role || !text) return null;
    return {
      id: String(row.id || row.messageId || row.message_id || `message-${index + 1}`),
      role,
      type: role === 'tool' ? 'tool' : 'message',
      title: compactText(row.title || row.name || row.toolName || row.tool_name, 200),
      text,
      status: String(row.status || ''),
      timestamp: isoTime(row.timestamp || row.createdAt || row.created_at || row.time, fallbackTime),
    };
  }).filter(Boolean);
}

function parseMarkdownMessages(text) {
  const messages = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    if (body) messages.push({
      id: `markdown-${messages.length + 1}`,
      role: current.role,
      type: 'message',
      title: '',
      text: body.slice(0, 200_000),
      status: '',
      timestamp: '',
    });
    current = null;
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    const heading = trimmed.match(/^#{1,6}\s*(user|human|assistant|ai|agent)\s*:?\s*(.*)$/i)
      || trimmed.match(/^\*\*(user|human|assistant|ai|agent)\s*:\s*\*\*\s*(.*)$/i)
      || trimmed.match(/^\*\*(user|human|assistant|ai|agent)\*\*\s*:\s*(.*)$/i)
      || trimmed.match(/^(user|human|assistant|ai|agent)\s*:\s*(.*)$/i);
    if (heading) {
      flush();
      current = { role: normalizeRole(heading[1]), lines: heading[2] ? [heading[2]] : [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return messages;
}

function explicitAsideMarker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.asideVersion || value.aside_version || value.asideTask || value.aside_task) return true;
  return [value.source, value.app, value.application, value.product, value.client]
    .some(marker => /\baside(?:\s+browser)?\b/i.test(String(marker || '')));
}

function messageContainer(value) {
  if (!value || typeof value !== 'object') return [];
  for (const key of ['messages', 'turns', 'conversation', 'history', 'transcript']) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (Array.isArray(value) && value.some(looksLikeMessage)) return value;
  return [];
}

function taskValues(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    if (value.some(looksLikeMessage)) return [{ messages: value.slice(0, DEFAULT_MAX_MESSAGES) }];
    return value.filter(item => item && typeof item === 'object').slice(0, DEFAULT_MAX_TASKS);
  }
  for (const key of ['tasks', 'sessions', 'conversations']) {
    if (Array.isArray(value[key])) return value[key]
      .filter(item => item && typeof item === 'object').slice(0, DEFAULT_MAX_TASKS);
  }
  return [value];
}

function recordIdentity(value) {
  return value && (value.taskId || value.task_id || value.sessionId || value.session_id
    || value.conversationId || value.conversation_id || value.threadId || value.thread_id || value.id);
}

function boundedRecordIdentity(value) {
  const raw = recordIdentity(value);
  if (raw == null) return '';
  const id = String(raw).replace(/\u0000/g, '').trim();
  return id && id.length <= 500 && !/[\u0000-\u001f\u007f]/.test(id) ? id : '';
}

function stableFolderId(root, directory) {
  return `folder-${crypto.createHash('sha256').update(`${root}\0${directory}`).digest('hex').slice(0, 20)}`;
}

function safeFolderErrorMessage(error) {
  const message = String(error && error.message || error || '');
  if (message.startsWith('Aside transcript ')) return message.slice(0, 500);
  if (message === 'Aside transcript did not contain a complete task record yet.') return message;
  if (error instanceof SyntaxError) return 'Aside transcript is incomplete or invalid JSON.';
  return 'Aside transcript could not be read safely.';
}

function containedExistingPath(root, candidate, fileSystem = fs, expectDirectory = false) {
  if (!candidate) return '';
  const unresolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  if (!isWithin(root, unresolved)) return '';
  try {
    const resolved = fileSystem.realpathSync(unresolved);
    if (!isWithin(root, resolved)) return '';
    const stat = fileSystem.statSync(resolved);
    if (expectDirectory ? !stat.isDirectory() : !stat.isFile()) return '';
    return resolved;
  } catch (_error) {
    return '';
  }
}

function normalizeArtifacts(raw, root, fileSystem = fs) {
  const candidates = raw && (raw.artifacts || raw.attachments || raw.files || raw.outputs);
  if (!Array.isArray(candidates)) return [];
  return candidates.map((item, index) => {
    const filePath = typeof item === 'string' ? item : item && (item.path || item.file || item.url);
    const title = typeof item === 'string' ? path.basename(item) : compactText(item && (item.title || item.name), 300);
    if (!filePath) return null;
    const candidate = path.isAbsolute(String(filePath))
      ? path.resolve(String(filePath)) : path.resolve(root, String(filePath));
    const resolved = blockedArtifactPath(root, candidate)
      ? '' : containedExistingPath(root, String(filePath), fileSystem, false);
    return {
      id: String(item && item.id || `artifact-${index + 1}`),
      title: title || path.basename(filePath),
      path: resolved,
      unavailable: !resolved,
      kind: String(item && (item.kind || item.type) || 'file'),
    };
  }).filter(Boolean);
}

function normalizeLifecycle(raw, fallbackTime = '') {
  const events = raw && (raw.events || raw.steps || raw.actions || raw.lifecycle);
  if (!Array.isArray(events)) return [];
  return events.map((event, index) => {
    if (!event || typeof event !== 'object') return null;
    const label = compactText(event.label || event.title || event.name || event.action || event.type, 500);
    if (!label) return null;
    return {
      id: String(event.id || `event-${index + 1}`),
      type: String(event.type || event.kind || 'step'),
      label,
      status: String(event.status || 'done'),
      timestamp: isoTime(event.timestamp || event.createdAt || event.created_at || event.time, fallbackTime),
    };
  }).filter(Boolean);
}

function safeBrowserUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.username = '';
    parsed.password = '';
    for (const name of [...parsed.searchParams.keys()]) {
      if (/(?:token|secret|key|password|passwd|credential|auth|session|cookie|code)/i.test(name)) {
        parsed.searchParams.set(name, '[REDACTED]');
      }
    }
    parsed.hash = '';
    return parsed.toString().slice(0, 4096);
  } catch (_error) {
    return '';
  }
}

function normalizeBrowserTabs(raw, fallbackTime = '') {
  const rows = raw && (raw.tabs || raw.browserTabs || raw.browser_tabs);
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 500).map((tab, index) => {
    const value = tab && typeof tab === 'object' ? tab : {};
    const url = safeBrowserUrl(value.url || (typeof tab === 'string' ? tab : ''));
    const title = compactText(value.title || url, 500);
    if (!title && !url) return null;
    return {
      id: String(value.id || `tab-${index + 1}`),
      title,
      label: title,
      url,
      status: String(value.status || 'done'),
      updatedAt: isoTime(value.updatedAt || value.updated_at || value.timestamp, fallbackTime),
    };
  }).filter(Boolean);
}

function legacyProvider(modelProvider) {
  const provider = String(modelProvider || '').toLowerCase();
  if (/anthropic|claude/.test(provider)) return 'claude';
  if (/google|gemini/.test(provider)) return 'gemini';
  if (/xai|grok/.test(provider)) return 'grok';
  return 'codex';
}

function normalizeFolderRecord(raw, context, messagesOverride = null) {
  const messages = messagesOverride || normalizeMessages(messageContainer(raw));
  const explicitId = boundedRecordIdentity(raw);
  const externalId = String(explicitId || stableFolderId(context.root, context.directory));
  const fileTime = isoTime(context.mtimeMs, new Date(0).toISOString());
  const startedAt = isoTime(raw && (raw.startedAt || raw.createdAt || raw.created_at || raw.time_created), fileTime);
  const updatedAt = isoTime(raw && (raw.updatedAt || raw.updated_at || raw.time_updated),
    messages.map(message => message.timestamp).filter(Boolean).sort().pop() || fileTime);
  const modelProvider = String(raw && (raw.provider || raw.providerId || raw.provider_id) || '');
  const model = String(raw && (raw.model || raw.modelId || raw.model_id) || '');
  const status = raw && (raw.archived || raw.time_archived) ? 'archived'
    : raw && (raw.error || raw.failed) ? 'failed'
      : String(raw && raw.status || 'completed').toLowerCase();
  const latestAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const title = compactText(raw && (raw.title || raw.name || raw.task || raw.prompt), 500)
    || compactText(messages.find(message => message.role === 'user')?.text, 500)
    || path.basename(context.directory);
  const lifecycle = normalizeLifecycle(raw, updatedAt);
  const browserTabs = normalizeBrowserTabs(raw, updatedAt);
  const artifactMap = new Map();
  for (const artifact of [...normalizeArtifacts(raw, context.root, context.fileSystem), ...(context.discoveredArtifacts || [])]) {
    artifactMap.set(artifact.path || artifact.externalPath || artifact.id, artifact);
  }
  return {
    id: `aside:${externalId}`,
    externalId,
    provider: legacyProvider(modelProvider),
    modelProvider,
    model,
    sourcePluginId: 'aside',
    source: 'source-plugin',
    sourceLabel: 'Aside Browser · selected folder',
    clientKind: 'aside-browser',
    environment: 'macOS',
    terminalBackend: 'browser',
    conversationTransport: 'plugin',
    title,
    cwd: containedExistingPath(context.root,
      String(raw && (raw.cwd || raw.directory || raw.workspace) || context.directory),
      context.fileSystem, true) || context.directory,
    startedAt,
    updatedAt,
    status: ['running', 'failed', 'archived', 'completed', 'waiting', 'idle'].includes(status) ? status : 'completed',
    messages,
    messageCount: messages.length,
    lifecycle,
    artifacts: [...artifactMap.values()],
    resources: { browserTabs },
    outcomes: latestAssistant ? [{ id: 'latest-response', title: 'Latest response', text: latestAssistant.text }] : [],
    filePath: context.file,
    selectedRoot: context.root,
    readOnly: true,
    importMode: 'selected-folder',
    controlAuthority: 'read-only-import',
    importEvidence: {
      kind: 'user-selected-task-folder',
      root: context.root,
      transcript: context.file,
    },
    sourceControlCapabilities: {
      start: false,
      sendInstruction: false,
      stop: false,
      archive: false,
      delete: false,
      // The record remains mutation read-only, while selected roots are
      // watched by the monitor worker for live transcript/artifact refreshes.
      live: true,
      readConversation: true,
      readSteps: true,
      readTabs: true,
      readArtifacts: true,
    },
  };
}

function mergeRecords(left, right) {
  const messages = [...left.messages, ...right.messages];
  const seen = new Set();
  const dedupedMessages = messages.filter(message => {
    const key = `${message.id}\0${message.role}\0${message.timestamp}\0${message.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...left,
    ...right,
    title: left.title || right.title,
    startedAt: [left.startedAt, right.startedAt].filter(Boolean).sort()[0] || '',
    updatedAt: [left.updatedAt, right.updatedAt].filter(Boolean).sort().pop() || '',
    messages: dedupedMessages,
    messageCount: dedupedMessages.length,
    lifecycle: [...left.lifecycle, ...right.lifecycle],
    artifacts: [...left.artifacts, ...right.artifacts],
    outcomes: right.outcomes.length ? right.outcomes : left.outcomes,
  };
}

function scanAsideHistoryFolders(roots, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const records = new Map();
  const errors = [];
  const cache = options.cache instanceof Map ? options.cache : null;
  const candidates = safeCandidateFiles(roots, options);
  const seenFiles = new Set(candidates.map(fileInfo => fileInfo.file));
  const transcriptFiles = new Set(seenFiles);
  const artifactsByDirectory = new Map();
  const addRecord = record => {
    records.set(record.id, records.has(record.id) ? mergeRecords(records.get(record.id), record) : record);
  };
  for (const fileInfo of candidates) {
    const fileRecords = [];
    try {
      const stat = fileSystem.statSync(fileInfo.file);
      if (!artifactsByDirectory.has(fileInfo.directory)) {
        artifactsByDirectory.set(fileInfo.directory,
          listContainedArtifactFiles(fileInfo.root, fileInfo.directory, transcriptFiles, options));
      }
      const context = {
        ...fileInfo,
        fileSystem,
        mtimeMs: stat.mtimeMs,
        discoveredArtifacts: artifactsByDirectory.get(fileInfo.directory),
      };
      if (fileInfo.extension === '.md') {
        const messages = parseMarkdownMessages(readBoundedText(fileInfo, options));
        if (messages.length) fileRecords.push(normalizeFolderRecord({}, context, messages));
      } else {
        const value = parseJsonFile(fileInfo, options);
        for (const raw of taskValues(value)) {
          const messages = normalizeMessages(messageContainer(raw));
          const recognizedFile = TRANSCRIPT_FILE_NAMES.has(path.basename(fileInfo.file).toLowerCase());
          if (!explicitAsideMarker(raw) && !(recognizedFile && (messages.length || boundedRecordIdentity(raw)))) continue;
          fileRecords.push(normalizeFolderRecord(raw, context, messages));
        }
      }
      const previous = cache && cache.get(fileInfo.file);
      if (!fileRecords.length && previous && Array.isArray(previous.records) && previous.records.length
        && TRANSCRIPT_FILE_NAMES.has(path.basename(fileInfo.file).toLowerCase())) {
        throw new Error('Aside transcript did not contain a complete task record yet.');
      }
      for (const record of fileRecords) addRecord(record);
      if (cache) cache.set(fileInfo.file, { records: fileRecords });
    } catch (error) {
      errors.push({ file: fileInfo.file, message: safeFolderErrorMessage(error) });
      const previous = cache && cache.get(fileInfo.file);
      for (const record of previous && Array.isArray(previous.records) ? previous.records : []) addRecord(record);
    }
  }
  if (cache) {
    for (const file of cache.keys()) if (!seenFiles.has(file)) cache.delete(file);
  }
  let sessions = [...records.values()].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  if (!options.fullHistory) {
    sessions = sessions.map(session => ({
      ...session,
      messages: session.messages.slice(-6).map(message => ({ ...message, text: compactText(message.text, 2000) })),
    }));
  }
  return {
    sessions,
    errors,
    roots: canonicalRoots(roots, fileSystem),
    mode: 'selected-folder',
    readOnly: true,
  };
}

function detailAsideHistorySession(roots, sessionId, options = {}) {
  const target = String(sessionId || '');
  const result = scanAsideHistoryFolders(roots, { ...options, fullHistory: true });
  return result.sessions.find(session => session.id === target || session.externalId === target) || null;
}

module.exports = {
  BLOCKED_DIRECTORY_NAMES,
  BLOCKED_FILE_NAMES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_TASKS,
  TRANSCRIPT_FILE_NAMES,
  blockedName,
  blockedArtifactPath,
  canonicalRoots,
  containedExistingPath,
  detailAsideHistorySession,
  explicitAsideMarker,
  isWithin,
  listContainedArtifactFiles,
  normalizeFolderRecord,
  normalizeBrowserTabs,
  parseMarkdownMessages,
  safeCandidateFiles,
  safeFolderErrorMessage,
  safeBrowserUrl,
  scanAsideHistoryFolders,
};
