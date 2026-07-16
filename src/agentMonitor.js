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
const {
  MAX_FILES_PER_PROVIDER,
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
  const text = compactText(message.text, message.type === 'tool' ? 1600 : 6000);
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
  const duplicate = session.messages.some(item => item.id === row.id
    || (item.role === row.role && item.text === row.text && item.timestamp === row.timestamp));
  if (!duplicate) session.messages.push(row);
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
  const duplicate = session.lifecycle.some(item => item.id === row.id);
  if (!duplicate) session.lifecycle.push(row);
}

function settleLifecycle(session, id, status = 'done', completedAt = null) {
  const key = String(id || '');
  if (!key) return;
  const row = session.lifecycle.find(item => item.id === key || item.id === `tool:${key}`);
  if (!row) return;
  row.status = status;
  if (completedAt) row.completedAt = timestamp(completedAt, row.timestamp);
}

function settleRunningLifecycle(session, completedAt = null) {
  for (const row of session.lifecycle) {
    if (row.status !== 'running') continue;
    row.status = 'done';
    if (completedAt) row.completedAt = timestamp(completedAt, row.timestamp);
  }
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
    branch: '',
    source: 'local-history',
    sourceLabel: '로컬 세션',
    clientKind: '',
    status: 'idle',
    statusDetail: '',
    statusObserved: false,
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
  readJson,
  readJsonLines,
  settleLifecycle,
  sumUsage,
  timestamp,
  trimSession,
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
  session.omittedMessages = Math.max(0, session.messages.length - MAX_MESSAGES);
  session.omittedLifecycle = Math.max(0, session.lifecycle.length - MAX_LIFECYCLE);
  session.messages = session.messages.slice(-MAX_MESSAGES);
  session.lifecycle = session.lifecycle.slice(-MAX_LIFECYCLE);
  if (!session.messages.length) addMessage(session, { id: `${session.id}:empty`, role: 'system', text: '표시할 대화 메시지가 아직 없습니다.', timestamp: session.updatedAt });
}

function parseManagedSession(runDir) {
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
  };
  session.usage = finalizeUsage(session.usage);
  session.turnUsage = finalizeUsage(session.turnUsage);
  const window = modelContextWindow(session.provider, session.model, session.context && session.context.window);
  session.context = contextInfo(session.context && session.context.used || session.turnUsage.total, window);
  trimSession(session);
  return session;
}

function workspaceLabel(cwd) {
  if (!cwd) return '작업 폴더 미상';
  const normalized = String(cwd).replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').filter(Boolean).pop() || cwd;
}

function isProjectlessSession(session) {
  if (!session || !session.cwd) return true;
  const normalized = String(session.cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  return session.provider === 'codex'
    && session.clientKind === 'codex-desktop'
    && /(?:^|\/)Documents\/Codex\/\d{4}-\d{2}-\d{2}\/new-chat$/i.test(normalized);
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

class AgentMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.home = options.home || os.homedir();
    this.runsDir = options.runsDir;
    this.intervalMs = options.intervalMs || 1200;
    this.availability = {};
    this.parseCache = new Map();
    this.listCache = new Map();
    this.historyHomes = [];
    this.timer = null;
    this.scanning = false;
    this.lastSnapshot = { generatedAt: new Date().toISOString(), sessions: [], summary: buildSummary([], {}) };
    this.setHistoryHomes(options.historyHomes || []);
  }

  setAvailability(availability) {
    this.availability = { ...availability };
  }

  setHistoryHomes(historyHomes = []) {
    const localKind = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
    const localLabel = process.platform === 'win32' ? 'Windows 로컬' : (process.platform === 'darwin' ? 'macOS 로컬' : 'Linux 로컬');
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

  parseFile(info, parser) {
    const key = `${info.file}|${info.mtimeMs}|${info.size}`;
    const cached = this.parseCache.get(key);
    if (cached) return cached;
    const value = parser(info);
    if (value) this.parseCache.set(key, value);
    if (this.parseCache.size > 500) {
      const keep = [...this.parseCache.entries()].slice(-300);
      this.parseCache = new Map(keep);
    }
    return value;
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
          const infos = history.files && Array.isArray(history.files[provider])
            ? this.hintedFiles(history.files[provider], max)
            : this.files(key, roots[provider], predicate, max, 6, cacheMs);
          for (const info of infos) {
            const value = this.parseFile(info, parser);
            if (!value) continue;
            const copy = structuredClone(value);
            copy.environment = { kind: history.kind, distro: history.distro, label: history.label, home: history.home };
            if (history.kind === 'wsl') copy.sourceLabel = history.label;
            sessions.push(copy);
          }
        };
        addSessions('claude', (_f, name) => name.endsWith('.jsonl'), MAX_FILES_PER_PROVIDER, parseClaude);
        addSessions('codex', (_f, name) => name.endsWith('.jsonl'), MAX_FILES_PER_PROVIDER, parseCodex);
        addSessions('gemini', (_f, name) => /\.(json|jsonl)$/i.test(name), 50, item => parseGeneric(item, 'gemini'));
        addSessions('grok', (_f, name) => /\.(json|jsonl)$/i.test(name), 50, item => parseGeneric(item, 'grok'));
      }

      const managed = this.managedSessions();
      const byId = new Map();
      for (const session of sessions) {
        const existing = byId.get(session.id);
        if (!existing || Date.parse(session.updatedAt || 0) > Date.parse(existing.updatedAt || 0)) byId.set(session.id, session);
      }
      for (const session of managed) byId.set(session.id, session);
      const merged = [...byId.values()]
        .map(session => {
          const projectless = isProjectlessSession(session);
          return { ...session, projectless, workspace: projectless ? '프로젝트 없음' : workspaceLabel(session.cwd) };
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
  contextInfo,
  attachHierarchy,
};
