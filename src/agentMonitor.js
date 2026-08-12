'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const {
  providerList,
  modelContextWindow,
  blankUsage,
  finalizeUsage,
} = require('./providerRegistry');
const { createCodexParser } = require('./agentMonitor/codexParser');
const { createClaudeParser } = require('./agentMonitor/claudeParser');
const { createGenericParser } = require('./agentMonitor/genericParser');
const { createHierarchyAttacher } = require('./agentMonitor/hierarchy');
const { assistantResponseIntent, isUserInputTool } = require('./agentMonitor/responseIntent');
const {
  MAX_FILES_PER_PROVIDER,
  MAX_JSON_BYTES,
  jsonlReadBudget,
  readJson,
  readJsonLines,
  safeStat,
  walkRecent,
} = require('./agentMonitor/sessionFiles');

const MAX_MESSAGES = 180;
const MAX_LIFECYCLE = 220;
const ACTIVE_THRESHOLD_MS = 18_000;
const STALE_TURN_THRESHOLD_MS = 5 * 60_000;
const LIST_CACHE_MS = 60_000;
const PINNED_FILE_CACHE_MS = 60_000;
const CARD_JSONL_BYTES = 4 * 1024 * 1024;
const STARTUP_INPUT_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STARTUP_INPUT_RECOVERY_MAX_FILES = 20;
const STARTUP_INPUT_RECOVERY_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const sessionCollectionIndexes = new WeakMap();

function isRecentPendingInputSession(session, now = Date.now()) {
  const intent = session && session.responseIntent || {};
  if (session?.status !== 'waiting' || intent.source !== 'input-tool'
    || (intent.category !== 'required' && intent.required !== true)) return false;
  // The file timestamp is only a discovery hint. The request event timestamp is
  // authoritative so a touched old transcript cannot resurrect a stale prompt.
  const requestedAt = Date.parse(intent.requestedAt || '');
  if (!Number.isFinite(requestedAt)) return false;
  const age = Number(now) - requestedAt;
  return age >= 0 && age <= STARTUP_INPUT_RECOVERY_MAX_AGE_MS;
}

function collectionIndexes(session) {
  const cached = sessionCollectionIndexes.get(session);
  if (cached && cached.messages === session.messages && cached.lifecycle === session.lifecycle) return cached;
  const messageIds = new Set();
  const messageSignatures = new Set();
  for (const message of session.messages || []) {
    messageIds.add(String(message.id || ''));
    messageSignatures.add(`${message.role}\u0000${message.text}\u0000${message.timestamp}`);
  }
  const lifecycleById = new Map();
  const runningLifecycle = new Set();
  for (const event of session.lifecycle || []) {
    lifecycleById.set(String(event.id || ''), event);
    if (event.status === 'running') runningLifecycle.add(event);
  }
  const indexes = {
    messages: session.messages,
    lifecycle: session.lifecycle,
    messageIds,
    messageSignatures,
    lifecycleById,
    runningLifecycle,
  };
  sessionCollectionIndexes.set(session, indexes);
  return indexes;
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return String(value);
  if (typeof value.text === 'string') return value.text;
  if (typeof value.output_text === 'string') return value.output_text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return asText(value.content);
  if (typeof value.message === 'string') return value.message;
  return '';
}

function compactText(value, limit = 4000) {
  const text = asText(value).replace(/\u0000/g, '').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function timestamp(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function addMessage(session, message) {
  const text = compactText(message.text, session.fullHistory ? Number.MAX_SAFE_INTEGER : (message.type === 'tool' ? 1600 : 6000));
  if (!text && message.type !== 'tool') return;
  const row = {
    id: String(message.id || `${session.id}:m:${session.messages.length}`),
    role: message.role || 'system',
    type: message.type || 'message',
    text,
    title: compactText(message.title, 160),
    status: message.status || '',
    timestamp: timestamp(message.timestamp, session.updatedAt),
  };
  const indexes = collectionIndexes(session);
  const signature = `${row.role}\u0000${row.text}\u0000${row.timestamp}`;
  if (indexes.messageIds.has(row.id) || indexes.messageSignatures.has(signature)) return;
  session.messages.push(row);
  indexes.messageIds.add(row.id);
  indexes.messageSignatures.add(signature);
}

function jsonObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_invalidJson) {
    // Provider metadata may be absent or partially written while a session is live.
    return {};
  }
}

function collaborationTaskName(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').filter(Boolean).pop() || '';
}

function encryptedCollaborationText(value) {
  return /^gAAAA[A-Za-z0-9_-]+={0,2}$/.test(String(value || '').trim());
}

function agentEnvelope(value) {
  const text = compactText(value, 12000);
  const type = text.match(/(?:^|\n)Message Type:\s*([^\n]+)/i);
  const task = text.match(/(?:^|\n)Task name:\s*([^\n]+)/i);
  const sender = text.match(/(?:^|\n)Sender:\s*([^\n]+)/i);
  const payload = text.match(/(?:^|\n)Payload:\s*\n?([\s\S]*)$/i);
  return {
    type: compactText(type && type[1], 40).toUpperCase(),
    task: compactText(task && task[1], 180),
    sender: compactText(sender && sender[1], 180),
    payload: compactText(payload && payload[1], 6000),
  };
}

function collaborationCapacity(value) {
  const text = String(value || '');
  const match = text.match(/There are\s+(\d+)\s+available concurrency slots[\s\S]{0,240}?including you/i)
    || text.match(/main(?:\s+agent)?\s+included[^\d]{0,40}(\d+)\s+(?:slots|agents)/i)
    || text.match(/메인(?:\s*에이전트)?\s*포함[^\d]{0,40}(\d+)개/i);
  const totalThreads = Number(match && match[1] || 0);
  return totalThreads > 0 ? { totalThreads, subagents: Math.max(0, totalThreads - 1), source: 'runtime-instruction' } : null;
}

function retainedAgentsFromValue(value) {
  const parsed = jsonObject(value);
  const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
  return agents.map(agent => {
    const statusValue = agent && agent.agent_status;
    const status = typeof statusValue === 'string' ? statusValue : (statusValue && typeof statusValue === 'object' ? Object.keys(statusValue)[0] : 'unknown');
    const pathValue = compactText(agent && agent.agent_name, 180);
    return { path: pathValue, taskName: collaborationTaskName(pathValue), name: '', status, observedAt: null };
  }).filter(agent => agent.path && agent.path !== '/root');
}

function retainedAgentsFromWorldState(value, observedAt) {
  const rows = String(value || '').split(/\r?\n/).map(line => line.match(/^\s*-\s*([^:]+):\s*(.+?)\s*$/)).filter(Boolean);
  return rows.map(match => ({ path: `/root/${match[1].trim()}`, taskName: match[1].trim(), name: match[2].trim(), status: 'retained', observedAt }));
}

function addLifecycle(session, event) {
  const row = {
    id: String(event.id || `${session.id}:e:${session.lifecycle.length}`),
    type: event.type || 'activity',
    label: compactText(event.label || '활동', 120),
    detail: compactText(event.detail, 600),
    status: event.status || 'done',
    timestamp: timestamp(event.timestamp, session.updatedAt),
  };
  const indexes = collectionIndexes(session);
  if (indexes.lifecycleById.has(row.id)) return;
  session.lifecycle.push(row);
  indexes.lifecycleById.set(row.id, row);
  if (row.status === 'running') indexes.runningLifecycle.add(row);
}

function settleLifecycle(session, id, status = 'done', completedAt = null) {
  const key = String(id || '');
  if (!key) return;
  const indexes = collectionIndexes(session);
  const row = indexes.lifecycleById.get(key) || indexes.lifecycleById.get(`tool:${key}`);
  if (!row) return;
  row.status = status;
  if (status === 'running') indexes.runningLifecycle.add(row);
  else indexes.runningLifecycle.delete(row);
  if (completedAt) row.completedAt = timestamp(completedAt, row.timestamp);
}

function settleRunningLifecycle(session, completedAt = null) {
  const indexes = collectionIndexes(session);
  for (const row of indexes.runningLifecycle) {
    row.status = 'done';
    if (completedAt) row.completedAt = timestamp(completedAt, row.timestamp);
  }
  indexes.runningLifecycle.clear();
}

function baseSession(provider, externalId, file, stat) {
  const id = `${provider}:${externalId}`;
  const updatedAt = new Date((stat && stat.mtimeMs) || Date.now()).toISOString();
  return {
    id,
    externalId: String(externalId),
    provider,
    parentId: null,
    depth: 0,
    agentName: '',
    agentRole: '',
    agentPath: '',
    taskName: '',
    sharedGoal: '',
    title: '제목을 불러오는 중',
    model: '',
    cwd: '',
    originCwd: '',
    branch: '',
    source: 'local-history',
    sourceLabel: '이 컴퓨터의 지난 작업',
    clientKind: '',
    utilityKind: '',
    status: 'idle',
    activityState: 'idle',
    statusDetail: '',
    statusObserved: false,
    responseIntent: { category: 'none', required: false, optional: false, requestText: '', confidence: 'low', source: 'none' },
    startedAt: updatedAt,
    updatedAt,
    endedAt: null,
    completedAt: null,
    completionObserved: false,
    result: '',
    file,
    truncated: false,
    usage: blankUsage(),
    turnUsage: blankUsage(),
    context: { used: 0, window: 0, percent: 0, source: 'unknown' },
    messages: [],
    lifecycle: [],
    executions: [],
    childIds: [],
    collaboration: {
      capacity: { totalThreads: 0, subagents: 0, source: 'unknown' },
      spawns: [],
      communications: [],
      retainedAgents: [],
      retainedObserved: false,
      metrics: null,
    },
    loop: null,
  };
}

function sumUsage(values) {
  const total = blankUsage();
  for (const value of values) {
    const usage = finalizeUsage(value);
    for (const key of Object.keys(total)) total[key] += usage[key] || 0;
  }
  return finalizeUsage(total);
}

const parseClaude = createClaudeParser({
  ACTIVE_THRESHOLD_MS,
  STALE_TURN_THRESHOLD_MS,
  addLifecycle,
  addMessage,
  baseSession,
  compactText,
  contextInfo,
  finalizeUsage,
  modelContextWindow,
  readJsonLines,
  settleLifecycle,
  sumUsage,
  timestamp,
  trimSession,
  assistantResponseIntent,
  isUserInputTool,
});

function codexUsage(raw = {}) {
  return finalizeUsage({
    input: raw.input_tokens,
    cachedInput: raw.cached_input_tokens,
    output: raw.output_tokens,
    reasoning: raw.reasoning_output_tokens,
    total: raw.total_tokens,
  });
}

function codexContentText(content) {
  if (!Array.isArray(content)) return compactText(content);
  return content.map(part => part && (part.text || part.input_text || part.output_text || asText(part))).filter(Boolean).join('\n').trim();
}

function codexVisibleUserText(value) {
  const raw = compactText(value, 12000);
  if (!raw) return '';
  const objective = raw.match(/<(?:untrusted_)?objective>\s*([\s\S]*?)\s*<\/(?:untrusted_)?objective>/i);
  if (objective) return compactText(objective[1], 6000);
  const desktopRequest = raw.match(/##\s*My request for Codex:\s*([\s\S]*?)(?:\n{2,}<image\b|$)/i);
  if (desktopRequest) return compactText(desktopRequest[1], 6000);
  if (/^<(?:subagent_notification|task_notification|task-notification|agent_notification|collaboration_notification)(?:\s|>)/i.test(raw)) return '';
  if (/^<(?:permissions instructions|app-context|environment_context|skills_instructions|plugins_instructions|apps_instructions|multi_agent_mode|collaboration_mode)>/i.test(raw)) return '';
  if (/^<skill(?:\s|>)/i.test(raw)) return '';
  if (/^#\s*Codex desktop context/i.test(raw)) return '';
  if (/^Approved command prefix saved:/i.test(raw)) return '';
  if (/^You are (?:`?\/root|Codex, an agent based on)/i.test(raw)) return '';
  if (/Filesystem sandboxing defines which files can be read or written/i.test(raw)) return '';
  if (raw.length > 800 && /(?:primary agent in a team of agents|All agents share the same directory|collaboration tools cannot be called|valid channels|Target channel)/i.test(raw)) return '';
  if (raw.length > 2500 && /(?:approval policy|sandbox_mode|workspace dependencies|thread coordination)/i.test(raw)) return '';
  return raw;
}

function addCodexMessage(session, observations, message, source) {
  const type = message.type || 'message';
  const text = compactText(message.text, type === 'tool' ? 1600 : 6000);
  if (!text && type !== 'tool') return;
  const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const role = message.role || 'system';
  const at = Date.parse(timestamp(message.timestamp, session.updatedAt));
  const key = `${role}\u0000${type}\u0000${normalized}`;
  const candidates = observations.get(key) || [];
  let match = null;
  let distance = Infinity;
  for (const candidate of candidates) {
    const delta = Math.abs(candidate.at - at);
    if (candidate.source === source || candidate.matched || delta > 2_000 || delta >= distance) continue;
    match = candidate;
    distance = delta;
  }
  const observation = { source, at, matched: Boolean(match) };
  if (match) match.matched = true;
  candidates.push(observation);
  observations.set(key, candidates.filter(candidate => Math.abs(candidate.at - at) <= 5_000 || !candidate.matched));
  if (!match) addMessage(session, { ...message, text });
}

const parseCodex = createCodexParser({
  thresholds: { ACTIVE_THRESHOLD_MS, STALE_TURN_THRESHOLD_MS },
  sessionOps: {
    addCodexMessage, addLifecycle, addMessage, baseSession,
    settleLifecycle, settleRunningLifecycle, trimSession,
  },
  textOps: {
    agentEnvelope, codexContentText, codexVisibleUserText,
    compactText, encryptedCollaborationText, jsonObject,
    assistantResponseIntent, isUserInputTool,
  },
  collaborationOps: {
    collaborationCapacity, collaborationTaskName,
    retainedAgentsFromValue, retainedAgentsFromWorldState,
  },
  usageOps: { codexUsage, contextInfo, modelContextWindow },
  storageOps: { readJsonLines },
  timeOps: { timestamp },
});

const parseGeneric = createGenericParser({
  ACTIVE_THRESHOLD_MS,
  STALE_TURN_THRESHOLD_MS,
  addLifecycle,
  addMessage,
  baseSession,
  compactText,
  contextInfo,
  finalizeUsage,
  modelContextWindow,
  MAX_JSON_BYTES,
  readJson,
  readJsonLines,
  settleLifecycle,
  sumUsage,
  timestamp,
  trimSession,
  assistantResponseIntent,
  isUserInputTool,
});

function contextInfo(used, windowInfo) {
  const window = Number(windowInfo && windowInfo.tokens || 0);
  const current = Number(used || 0);
  return {
    used: current,
    window,
    percent: window ? Math.min(100, Math.max(0, current / window * 100)) : 0,
    source: windowInfo && windowInfo.source || 'unknown',
  };
}

function trimSession(session) {
  if (session.fullHistory) {
    session.omittedMessages = 0;
    session.omittedLifecycle = 0;
    session.truncated = Boolean(session.truncated);
    if (!session.messages.length) addMessage(session, { id: `${session.id}:empty`, role: 'system', text: '표시할 대화 메시지가 아직 없습니다.', timestamp: session.updatedAt });
    return;
  }
  session.omittedMessages = Math.max(0, session.messages.length - MAX_MESSAGES);
  session.omittedLifecycle = Math.max(0, session.lifecycle.length - MAX_LIFECYCLE);
  session.messages = session.messages.slice(-MAX_MESSAGES);
  session.lifecycle = session.lifecycle.slice(-MAX_LIFECYCLE);
  if (!session.messages.length) addMessage(session, { id: `${session.id}:empty`, role: 'system', text: '표시할 대화 메시지가 아직 없습니다.', timestamp: session.updatedAt });
}

function parseManagedSession(runDir, options = {}) {
  const meta = readJson(path.join(runDir, 'meta.json'));
  const live = readJson(path.join(runDir, 'session.json'));
  if (!meta || !live) return null;
  const session = {
    ...baseSession(meta.provider, live.externalId || meta.externalId || meta.id, path.join(runDir, 'events.jsonl'), safeStat(path.join(runDir, 'session.json'))),
    ...live,
    id: `${meta.provider}:${live.externalId || meta.externalId || meta.id}`,
    provider: meta.provider,
    runId: meta.id,
    source: 'loadtoagent',
    sourceLabel: 'LoadToAgent 실행',
    statusObserved: true,
    fullHistory: Boolean(options.fullHistory),
  };
  session.originCwd = session.originCwd || meta.cwd || session.cwd || '';
  session.usage = finalizeUsage(session.usage);
  session.turnUsage = finalizeUsage(session.turnUsage);
  const window = modelContextWindow(session.provider, session.model, session.context && session.context.window);
  session.context = contextInfo(session.context && session.context.used || session.turnUsage.total, window);
  trimSession(session);
  return session;
}

function workspaceLabel(cwd) {
  if (!cwd) return '작업 시작 폴더 정보 없음';
  const normalized = String(cwd).replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').filter(Boolean).pop() || cwd;
}

function isProjectlessSession(session) {
  const cwd = session && (session.originCwd || session.cwd);
  if (!cwd) return true;
  const normalized = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  return session.provider === 'codex'
    && session.clientKind === 'codex-desktop'
    && /(?:^|\/)Documents\/Codex\/\d{4}-\d{2}-\d{2}\/new-chat$/i.test(normalized);
}

function mergeObservedRows(historyRows = [], managedRows = []) {
  const rows = [];
  const ids = new Map();
  const signatures = new Set();
  for (const row of [...historyRows, ...managedRows]) {
    if (!row) continue;
    const id = String(row.id || row.callId || row.path || '');
    const signature = [
      row.role || row.type || '',
      compactText(row.text || row.detail || row.label || row.assignment || row.taskName || row.result, 6000),
      timestamp(row.timestamp || row.updatedAt || row.startedAt, ''),
    ].join('\u0000');
    if (id && ids.has(id)) {
      Object.assign(rows[ids.get(id)], row);
      continue;
    }
    if (signatures.has(signature)) continue;
    if (id) ids.set(id, rows.length);
    signatures.add(signature);
    rows.push(structuredClone(row));
  }
  return rows.sort((left, right) =>
    Date.parse(left.timestamp || left.updatedAt || left.startedAt || 0)
    - Date.parse(right.timestamp || right.updatedAt || right.startedAt || 0));
}

function mergeManagedWithHistory(history, managed) {
  if (!history) return managed;
  if (!managed) return history;
  const historyCollaboration = history.collaboration || {};
  const managedCollaboration = managed.collaboration || {};
  const collaboration = {
    ...managedCollaboration,
    ...historyCollaboration,
    capacity: Number(historyCollaboration.capacity && historyCollaboration.capacity.totalThreads || 0)
      ? historyCollaboration.capacity
      : managedCollaboration.capacity,
    spawns: mergeObservedRows(historyCollaboration.spawns, managedCollaboration.spawns),
    communications: mergeObservedRows(historyCollaboration.communications, managedCollaboration.communications),
    retainedAgents: mergeObservedRows(historyCollaboration.retainedAgents, managedCollaboration.retainedAgents),
  };
  return {
    ...history,
    ...managed,
    historyFile: history.historyFile || history.file || '',
    messages: mergeObservedRows(history.messages, managed.messages),
    lifecycle: mergeObservedRows(history.lifecycle, managed.lifecycle),
    executions: (history.executions || []).length ? history.executions : (managed.executions || []),
    responseIntent: history.responseIntent?.category !== 'none' ? history.responseIntent : managed.responseIntent,
    childIds: [...new Set([...(history.childIds || []), ...(managed.childIds || [])])],
    collaboration,
  };
}

const attachHierarchy = createHierarchyAttacher({
  addMessage,
  baseSession,
  collaborationTaskName,
  compactText,
  timestamp,
  trimSession,
});

function buildSummary(sessions, availability) {
  const providers = providerList().map(provider => {
    const own = sessions.filter(session => session.provider === provider.id);
    const usage = sumUsage(own.map(session => session.usage));
    return {
      ...provider,
      installed: !!availability[provider.id],
      executable: availability[provider.id] || '',
      sessions: own.length,
      active: own.filter(session => session.status === 'running').length,
      waiting: own.filter(session => session.status === 'waiting').length,
      subagents: own.filter(session => session.parentId).length,
      usage,
    };
  });
  return {
    providers,
    totals: {
      sessions: sessions.length,
      active: sessions.filter(session => session.status === 'running').length,
      waiting: sessions.filter(session => session.status === 'waiting').length,
      subagents: sessions.filter(session => session.parentId).length,
      usage: sumUsage(sessions.map(session => session.usage)),
    },
  };
}

function snapshotWithoutSessions(snapshot, sessionIds, availability = {}) {
  const excluded = new Set((sessionIds || []).map(value => String(value || '')).filter(Boolean));
  if (!excluded.size) return snapshot;
  const sessions = (snapshot?.sessions || []).filter(session => !excluded.has(String(session?.id || '')));
  return { ...snapshot, sessions, summary: buildSummary(sessions, availability) };
}

// Parser results are cached and must remain immutable between scans. Hierarchy
// assembly only mutates session fields plus spawn/communication records, so a
// targeted copy avoids cloning large message, lifecycle, and execution arrays
// that are read-only in the scan pipeline.
function cloneSessionForScan(session) {
  const collaboration = session.collaboration ? {
    ...session.collaboration,
    capacity: session.collaboration.capacity ? { ...session.collaboration.capacity } : session.collaboration.capacity,
    metrics: session.collaboration.metrics ? { ...session.collaboration.metrics } : session.collaboration.metrics,
    spawns: (session.collaboration.spawns || []).map(record => ({ ...record })),
    communications: (session.collaboration.communications || []).map(event => ({ ...event })),
    retainedAgents: (session.collaboration.retainedAgents || []).map(agent => ({ ...agent })),
  } : session.collaboration;
  return {
    ...session,
    childIds: [...(session.childIds || [])],
    runtimePresence: (session.runtimePresence || []).map(item => ({ ...item })),
    collaboration,
  };
}

class AgentMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.home = options.home || os.homedir();
    this.runsDir = options.runsDir;
    this.intervalMs = options.intervalMs || 1200;
    this.cardJsonlBytes = Math.max(256 * 1024, Math.min(
      12 * 1024 * 1024,
      Number(options.cardJsonlBytes) || CARD_JSONL_BYTES,
    ));
    this.availability = {};
    this.parseCache = new Map();
    this.listCache = new Map();
    this.pinnedFileCache = new Map();
    this.pinnedSessions = [];
    this.historyHomes = [];
    this.startupRecoveryKeys = new Set();
    this.startupRecoveredFiles = new Map();
    this.timer = null;
    this.scanning = false;
    this.lastSnapshot = { generatedAt: new Date().toISOString(), sessions: [], summary: buildSummary([], {}) };
    this.setHistoryHomes(options.historyHomes || []);
  }

  setAvailability(availability) {
    this.availability = { ...availability };
  }

  setPinnedSessions(bindings = []) {
    const normalized = [];
    const seen = new Set();
    for (const binding of bindings || []) {
      const provider = String(binding && binding.provider || '').toLowerCase();
      if (!['claude', 'codex', 'gemini', 'grok'].includes(provider)) continue;
      const rawId = String(binding.linkedSessionId || binding.sessionId || binding.bridgeId || '').trim();
      const prefix = `${provider}:`;
      const externalId = rawId.toLowerCase().startsWith(prefix) ? rawId.slice(prefix.length) : rawId;
      if (!/^[a-z0-9._-]{3,160}$/i.test(externalId)) continue;
      const environment = String(binding.environment || '').toLowerCase();
      const distro = String(binding.distro || '').toLowerCase();
      const key = `${provider}:${externalId}:${environment}:${distro}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({ provider, externalId, environment, distro });
    }
    this.pinnedSessions = normalized;
  }

  pinnedFiles(provider, history, root, predicate) {
    const environment = String(history && history.kind || '').toLowerCase();
    const distro = String(history && history.distro || '').toLowerCase();
    const files = [];
    for (const binding of this.pinnedSessions) {
      if (binding.provider !== provider) continue;
      if (binding.environment && binding.environment !== environment) continue;
      if (binding.distro && binding.distro !== distro) continue;
      const cacheKey = `${root}|${provider}|${binding.externalId}`;
      const cached = this.pinnedFileCache.get(cacheKey);
      let file = cached && Date.now() - cached.at < PINNED_FILE_CACHE_MS ? cached.file : '';
      if (file && !safeStat(file)) file = '';
      if (!file && (!cached || Date.now() - cached.at >= PINNED_FILE_CACHE_MS)) {
        const externalId = binding.externalId.toLowerCase();
        const match = walkRecent(root, (candidate, name) => (
          predicate(candidate, name)
          && String(name || '').toLowerCase().includes(externalId)
        ), 1, 6)[0];
        file = match && match.file || '';
        this.pinnedFileCache.set(cacheKey, { at: Date.now(), file });
      }
      const stat = safeStat(file);
      if (stat && stat.isFile()) files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    return files;
  }

  setHistoryHomes(historyHomes = []) {
    const localKind = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
    const localLabel = process.platform === 'win32' ? '이 컴퓨터의 Windows' : (process.platform === 'darwin' ? '이 컴퓨터의 macOS' : '이 컴퓨터의 Linux');
    const next = [{ home: this.home, kind: localKind, distro: '', label: localLabel }, ...historyHomes]
      .filter(item => item && item.home)
      .filter((item, index, list) => list.findIndex(other => String(other.home).toLowerCase() === String(item.home).toLowerCase()) === index)
      .map(item => ({ home: String(item.home), kind: item.kind || 'external', distro: item.distro || '', label: item.label || item.kind || '외부 환경', files: item.files || null }));
    const previousKey = JSON.stringify(this.historyHomes.map(item => [item.home, item.kind, item.distro]));
    const nextKey = JSON.stringify(next.map(item => [item.home, item.kind, item.distro]));
    this.historyHomes = next;
    if (previousKey !== nextKey && this.listCache) this.listCache.clear();
  }

  files(key, root, predicate, max, depth, cacheMs = LIST_CACHE_MS) {
    const cached = this.listCache.get(key);
    let paths;
    if (cached && Date.now() - cached.at < cacheMs) {
      paths = cached.paths;
    } else {
      paths = walkRecent(root, predicate, max, depth).map(item => item.file);
      this.listCache.set(key, { at: Date.now(), paths });
    }
    return paths.map(file => {
      const stat = safeStat(file);
      return stat && stat.isFile() ? { file, mtimeMs: stat.mtimeMs, size: stat.size } : null;
    }).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max);
  }

  parseFile(info, parser, variant = '') {
    const key = `${info.file}|${info.mtimeMs}|${info.size}|${variant}`;
    const cachedEntry = this.parseCache.get(key);
    const cached = cachedEntry && cachedEntry.value || cachedEntry;
    const parsedAt = Number(cachedEntry && cachedEntry.parsedAt || 0);
    const timeSensitive = Boolean(cached && (
      cached.status === 'running'
      || cached.status === 'starting'
      || ['thinking', 'working', 'juggling'].includes(cached.activityState)
      || (cached.executions || []).some(execution => execution.status === 'running')
    ));
    if (cached && (!timeSensitive || Date.now() - parsedAt < ACTIVE_THRESHOLD_MS)) return cached;
    const value = parser(info);
    if (value) this.parseCache.set(key, { value, parsedAt: Date.now() });
    if (this.parseCache.size > 500) {
      const keep = [...this.parseCache.entries()].slice(-300);
      this.parseCache = new Map(keep);
    }
    return value;
  }

  detailSession(sessionId) {
    const stored = (this.lastSnapshot.sessions || []).find(session => session.id === String(sessionId || '')) || null;
    if (!stored) return null;
    let detailed = null;
    if (stored.source === 'loadtoagent' && stored.runId && this.runsDir) {
      detailed = parseManagedSession(path.join(this.runsDir, stored.runId), { fullHistory: true });
      if (stored.historyFile) {
        const historyStat = safeStat(stored.historyFile);
        if (historyStat && historyStat.isFile()) {
          const historyInfo = { file: stored.historyFile, mtimeMs: historyStat.mtimeMs, size: historyStat.size };
          const historyParser = stored.provider === 'claude'
            ? item => parseClaude(item, { fullHistory: true })
            : stored.provider === 'codex'
              ? item => parseCodex(item, { fullHistory: true })
              : item => parseGeneric(item, stored.provider, { fullHistory: true });
          const historyDetail = this.parseFile(historyInfo, historyParser, 'full-history');
          detailed = mergeManagedWithHistory(historyDetail, detailed);
        }
      }
    } else if (stored.file) {
      const stat = safeStat(stored.file);
      if (stat && stat.isFile()) {
        const info = { file: stored.file, mtimeMs: stat.mtimeMs, size: stat.size };
        const parser = stored.provider === 'claude'
          ? item => parseClaude(item, { fullHistory: true })
          : stored.provider === 'codex'
            ? item => parseCodex(item, { fullHistory: true })
            : item => parseGeneric(item, stored.provider, { fullHistory: true });
        detailed = this.parseFile(info, parser, 'full-history');
      }
    }
    if (!detailed) return stored;
    return {
      ...stored,
      ...detailed,
      environment: stored.environment,
      delegation: stored.delegation || detailed.delegation,
      childIds: stored.childIds || detailed.childIds || [],
      fullHistory: true,
      truncated: Boolean(detailed.truncated),
      omittedMessages: Number(detailed.omittedMessages || 0),
      omittedLifecycle: Number(detailed.omittedLifecycle || 0),
    };
  }

  hintedFiles(paths, max) {
    return (paths || []).map(value => {
      if (value && typeof value === 'object' && value.file && Number.isFinite(value.mtimeMs) && Number.isFinite(value.size)) {
        return { file: value.file, mtimeMs: value.mtimeMs, size: value.size };
      }
      const file = typeof value === 'string' ? value : value && value.file;
      const stat = safeStat(file);
      return stat && stat.isFile() ? { file, mtimeMs: stat.mtimeMs, size: stat.size } : null;
    }).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max);
  }

  managedSessions() {
    if (!this.runsDir || !fs.existsSync(this.runsDir)) return [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.runsDir, { withFileTypes: true }).filter(item => item.isDirectory());
    } catch (_unreadableRunsDirectory) {
      // A missing or temporarily locked run directory represents an empty snapshot.
      return [];
    }
    return dirs.map(item => parseManagedSession(path.join(this.runsDir, item.name))).filter(Boolean);
  }

  scanNow() {
    if (this.scanning) return this.lastSnapshot;
    this.scanning = true;
    try {
      const sessions = [];
      const includedFiles = new Set();
      const startupRecoveryCandidates = [];
      const scanStartedAt = Date.now();

      for (const [homeIndex, history] of this.historyHomes.entries()) {
        const roots = {
          claude: path.join(history.home, '.claude', 'projects'),
          codex: path.join(history.home, '.codex', 'sessions'),
          gemini: path.join(history.home, '.gemini', 'tmp'),
          grok: path.join(history.home, '.grok', 'sessions'),
        };
        const cacheMs = history.kind === 'wsl' ? 5_000 : LIST_CACHE_MS;
        const addSessions = (provider, predicate, max, parser) => {
          const key = `${history.kind}:${history.distro || homeIndex}:${provider}`;
          const recoverStartupInput = provider === 'codex' && !this.startupRecoveryKeys.has(key);
          const discoveryMax = max + (recoverStartupInput ? STARTUP_INPUT_RECOVERY_MAX_FILES : 0);
          const discoveredInfos = history.files && Array.isArray(history.files[provider])
            ? this.hintedFiles(history.files[provider], discoveryMax)
            : this.files(key, roots[provider], predicate, discoveryMax, 6, cacheMs);
          const infos = discoveredInfos.slice(0, max);
          if (recoverStartupInput) {
            this.startupRecoveryKeys.add(key);
            for (const info of discoveredInfos.slice(max)) {
              startupRecoveryCandidates.push({ info, parser, history, key });
            }
          }
          const recoveredInfos = [];
          for (const [file, recovery] of this.startupRecoveredFiles) {
            if (recovery.key !== key) continue;
            const stat = safeStat(file);
            if (stat && stat.isFile()) recoveredInfos.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
            else this.startupRecoveredFiles.delete(file);
          }
          const pinnedInfos = this.pinnedFiles(provider, history, roots[provider], predicate);
          const uniqueInfos = [...infos, ...recoveredInfos, ...pinnedInfos]
            .filter((info, index, list) => list.findIndex(other => other.file === info.file) === index);
          for (const info of uniqueInfos) {
            includedFiles.add(info.file);
            const value = this.parseFile(info, parser);
            const recovered = this.startupRecoveredFiles.has(info.file);
            if (!value) {
              if (recovered) this.startupRecoveredFiles.delete(info.file);
              continue;
            }
            if (recovered && !isRecentPendingInputSession(value)) {
              this.startupRecoveredFiles.delete(info.file);
              const intent = value.responseIntent || {};
              if (value.status === 'waiting' && intent.source === 'input-tool') continue;
            }
            const copy = cloneSessionForScan(value);
            // Provider health checks and detached memory extraction turns are
            // implementation details, not user work. Keep them out of the
            // dashboard and runtime-link candidate pool entirely.
            if (copy.utilityKind) continue;
            copy.environment = { kind: history.kind, distro: history.distro, label: history.label, home: history.home };
            if (history.kind === 'wsl') copy.sourceLabel = history.label;
            sessions.push(copy);
          }
        };
        addSessions('claude', (_f, name) => name.endsWith('.jsonl'), MAX_FILES_PER_PROVIDER, item => parseClaude(item, { maxBytes: this.cardJsonlBytes }));
        addSessions('codex', (_f, name) => name.endsWith('.jsonl'), MAX_FILES_PER_PROVIDER, item => parseCodex(item, { maxBytes: this.cardJsonlBytes }));
        addSessions('gemini', (_f, name) => /\.(json|jsonl)$/i.test(name), 50, item => parseGeneric(item, 'gemini', { maxBytes: this.cardJsonlBytes }));
        addSessions('grok', (_f, name) => /\.(json|jsonl)$/i.test(name), 50, item => parseGeneric(item, 'grok', { maxBytes: this.cardJsonlBytes }));
      }

      let recoveryFilesRead = 0;
      let recoveryBytesRead = 0;
      const recoveryPaths = new Set();
      const orderedRecoveryCandidates = startupRecoveryCandidates
        .filter(candidate => !includedFiles.has(candidate.info.file))
        .filter((candidate, index, list) => list.findIndex(other => other.info.file === candidate.info.file) === index)
        .sort((left, right) => right.info.mtimeMs - left.info.mtimeMs);
      for (const candidate of orderedRecoveryCandidates) {
        if (recoveryFilesRead >= STARTUP_INPUT_RECOVERY_MAX_FILES) break;
        const readCost = jsonlReadBudget(candidate.info.size, this.cardJsonlBytes);
        if (recoveryBytesRead + readCost > STARTUP_INPUT_RECOVERY_MAX_TOTAL_BYTES) continue;
        recoveryFilesRead += 1;
        recoveryBytesRead += readCost;
        const value = this.parseFile(candidate.info, candidate.parser);
        const postStat = safeStat(candidate.info.file);
        if (!value || !postStat || !postStat.isFile()
          || postStat.size !== candidate.info.size || postStat.mtimeMs !== candidate.info.mtimeMs
          || !isRecentPendingInputSession(value, scanStartedAt)) continue;
        const copy = cloneSessionForScan(value);
        if (copy.utilityKind || recoveryPaths.has(copy.id)) continue;
        recoveryPaths.add(copy.id);
        this.startupRecoveredFiles.set(candidate.info.file, { key: candidate.key });
        copy.environment = {
          kind: candidate.history.kind,
          distro: candidate.history.distro,
          label: candidate.history.label,
          home: candidate.history.home,
        };
        if (candidate.history.kind === 'wsl') copy.sourceLabel = candidate.history.label;
        sessions.push(copy);
      }

      const managed = this.managedSessions();
      const byId = new Map();
      for (const session of sessions) {
        const existing = byId.get(session.id);
        if (!existing || Date.parse(session.updatedAt || 0) > Date.parse(existing.updatedAt || 0)) byId.set(session.id, session);
      }
      for (const session of managed) {
        byId.set(session.id, mergeManagedWithHistory(byId.get(session.id), session));
      }
      const merged = [...byId.values()]
        .map(session => {
          const originCwd = session.originCwd || session.cwd || '';
          const projectless = isProjectlessSession(session);
          return { ...session, originCwd, projectless, workspace: projectless ? '프로젝트 없음' : workspaceLabel(originCwd) };
        })
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      attachHierarchy(merged);
      this.lastSnapshot = {
        generatedAt: new Date().toISOString(),
        sessions: merged,
        summary: buildSummary(merged, this.availability),
      };
      this.emit('snapshot', this.lastSnapshot);
      return this.lastSnapshot;
    } finally {
      this.scanning = false;
    }
  }

  start() {
    if (this.timer) return;
    this.scanNow();
    this.timer = setInterval(() => this.scanNow(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  AgentMonitor,
  parseClaude,
  parseCodex,
  parseGeneric,
  isProjectlessSession,
  readJsonLines,
  buildSummary,
  snapshotWithoutSessions,
  contextInfo,
  attachHierarchy,
  mergeManagedWithHistory,
  cloneSessionForScan,
};
