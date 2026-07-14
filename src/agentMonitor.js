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

const MAX_FILES_PER_PROVIDER = 80;
const MAX_JSONL_BYTES = 12 * 1024 * 1024;
const MAX_MESSAGES = 180;
const MAX_LIFECYCLE = 220;
const ACTIVE_THRESHOLD_MS = 18_000;
const STALE_TURN_THRESHOLD_MS = 5 * 60_000;
const LIST_CACHE_MS = 60_000;

function safeStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
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

function readJsonLines(file, maxBytes = MAX_JSONL_BYTES) {
  const stat = safeStat(file);
  if (!stat || !stat.isFile()) return { rows: [], truncated: false };
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(length);
  try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
  let text = buffer.toString('utf8');
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline >= 0 ? text.slice(newline + 1) : '';
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return { rows, truncated: start > 0 };
}

function walkRecent(root, predicate, max = MAX_FILES_PER_PROVIDER, maxDepth = 6) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      if (!entry.isFile() || !predicate(full, entry.name)) continue;
      const stat = safeStat(full);
      if (stat) out.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max);
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
    file,
    truncated: false,
    usage: blankUsage(),
    turnUsage: blankUsage(),
    context: { used: 0, window: 0, percent: 0, source: 'unknown' },
    messages: [],
    lifecycle: [],
    childIds: [],
  };
}

function normalizeClaudeUsage(raw = {}) {
  return finalizeUsage({
    input: raw.input_tokens,
    cachedInput: raw.cache_read_input_tokens,
    cacheWrite: raw.cache_creation_input_tokens,
    output: raw.output_tokens,
    reasoning: raw.reasoning_tokens,
  });
}

function sumUsage(values) {
  const total = blankUsage();
  for (const value of values) {
    const usage = finalizeUsage(value);
    for (const key of Object.keys(total)) total[key] += usage[key] || 0;
  }
  return finalizeUsage(total);
}

function claudeContent(session, row, item, index) {
  const kind = item && item.type;
  const id = `${row.uuid || row.requestId || session.externalId}:${index}`;
  if (kind === 'text' && item.text) {
    const text = row.message.role === 'user' ? claudeVisibleUserText(item.text) : item.text;
    if (text) addMessage(session, { id, role: row.message.role, text, timestamp: row.timestamp });
  } else if (kind === 'tool_use') {
    const name = item.name || 'tool';
    addMessage(session, {
      id,
      role: 'tool',
      type: 'tool',
      title: name,
      text: compactText(item.input && (item.input.command || item.input.description || item.input.prompt || JSON.stringify(item.input)), 1200),
      status: 'started',
      timestamp: row.timestamp,
    });
    addLifecycle(session, { id: `tool:${item.id || id}`, type: 'tool', label: name, detail: compactText(item.input, 260), status: 'running', timestamp: row.timestamp });
  } else if (kind === 'tool_result') {
    addLifecycle(session, { id: `result:${item.tool_use_id || id}`, type: 'tool-result', label: item.is_error ? '도구 실패' : '도구 완료', status: item.is_error ? 'failed' : 'done', timestamp: row.timestamp });
  } else if (kind === 'thinking') {
    addLifecycle(session, { id, type: 'reasoning', label: '추론', status: 'done', timestamp: row.timestamp });
  }
}

function claudeVisibleUserText(value) {
  const raw = compactText(value, 12000);
  if (!raw) return '';
  const objective = raw.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/i);
  if (objective) return compactText(objective[1], 6000);
  if (/^<(?:local-command-[^>]+|command-name|command-message|system-reminder|task-notification)>/i.test(raw)) return '';
  if (/^Extract durable memory candidates from this Claude Code transcript tail/i.test(raw)) return '';
  if (/^(?:Updated task #\d+|Your questions have been answered:)/i.test(raw)) return '';
  return raw;
}

function parseClaude(fileInfo) {
  const file = fileInfo.file;
  const parsed = readJsonLines(file);
  if (!parsed.rows.length) return null;
  const basename = path.basename(file, '.jsonl');
  const subMatch = file.match(/[\\/]([^\\/]+)[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/i);
  const externalId = subMatch ? subMatch[2] : basename;
  const session = baseSession('claude', externalId, file, fileInfo);
  session.truncated = parsed.truncated;
  session.parentId = subMatch ? `claude:${subMatch[1]}` : null;
  session.depth = subMatch ? 1 : 0;
  session.agentName = subMatch ? `agent-${subMatch[2].slice(0, 8)}` : '';

  const requestUsage = new Map();
  let latestUser = '';
  let lastRole = '';
  let latestTs = session.updatedAt;
  let lastTurnFinished = false;

  for (const row of parsed.rows) {
    latestTs = timestamp(row.timestamp, latestTs);
    if (row.cwd && !session.cwd) session.cwd = row.cwd;
    if (row.gitBranch) session.branch = row.gitBranch;
    if (row.agentId && session.depth) session.agentName = row.agentId;
    if (row.type === 'system' && row.subtype === 'init') {
      session.model = row.model || session.model;
      addLifecycle(session, { id: row.uuid, type: 'session-start', label: '세션 시작', status: 'done', timestamp: row.timestamp });
    }
    if (row.type === 'system' && /turn_duration|turn_complete|stop/i.test(String(row.subtype || ''))) lastTurnFinished = true;
    if (row.message && row.message.role) {
      const role = row.message.role === 'assistant' ? 'assistant' : 'user';
      lastRole = role;
      if (row.message.model) session.model = row.message.model;
      const content = Array.isArray(row.message.content) ? row.message.content : [{ type: 'text', text: row.message.content }];
      content.forEach((item, index) => claudeContent(session, row, item, index));
      if (role === 'user') {
        const visibleUser = claudeVisibleUserText(content
          .filter(item => !item.type || item.type === 'text')
          .map(item => typeof item === 'string' ? item : item.text)
          .filter(Boolean)
          .join('\n'));
        if (visibleUser) latestUser = visibleUser;
      }
      if (role === 'assistant' && row.message.usage) {
        const key = row.requestId || row.message.id || row.uuid;
        const usage = normalizeClaudeUsage(row.message.usage);
        const previous = requestUsage.get(key);
        if (!previous || usage.total >= previous.total) requestUsage.set(key, usage);
        session.turnUsage = usage;
      }
    }
  }

  session.updatedAt = latestTs;
  session.startedAt = timestamp(parsed.rows[0].timestamp, session.updatedAt);
  session.usage = sumUsage([...requestUsage.values()]);
  session.title = compactText(latestUser, 180) || (session.depth ? `Claude ${session.agentName}` : 'Claude 세션');
  const currentInput = session.turnUsage.input + session.turnUsage.cachedInput + session.turnUsage.cacheWrite
    + session.turnUsage.output + session.turnUsage.reasoning;
  const windowInfo = modelContextWindow('claude', session.model, 0);
  session.context = contextInfo(currentInput, windowInfo);
  const age = Date.now() - fileInfo.mtimeMs;
  if (age < ACTIVE_THRESHOLD_MS && !lastTurnFinished) {
    session.status = 'running';
    session.statusDetail = lastRole === 'user' ? '응답 생성 중' : '도구 실행 또는 스트리밍 중';
  } else if (lastRole === 'user' && age < STALE_TURN_THRESHOLD_MS) {
    session.status = 'waiting';
    session.statusDetail = '응답 또는 권한 확인 필요';
  } else {
    session.status = 'idle';
    session.statusDetail = lastRole === 'user' ? '마지막 응답 기록이 종료됨' : '다음 요청 대기';
  }
  session.statusObserved = age < ACTIVE_THRESHOLD_MS;
  trimSession(session);
  return session;
}

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
  const objective = raw.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/i);
  if (objective) return compactText(objective[1], 6000);
  if (/^<(?:permissions instructions|app-context|environment_context|skills_instructions|plugins_instructions|apps_instructions|multi_agent_mode|collaboration_mode)>/i.test(raw)) return '';
  if (/^#\s*Codex desktop context/i.test(raw)) return '';
  if (/^Approved command prefix saved:/i.test(raw)) return '';
  if (/^You are (?:`?\/root|Codex, an agent based on)/i.test(raw)) return '';
  if (/Filesystem sandboxing defines which files can be read or written/i.test(raw)) return '';
  if (raw.length > 800 && /(?:primary agent in a team of agents|All agents share the same directory|collaboration tools cannot be called|valid channels|Target channel)/i.test(raw)) return '';
  if (raw.length > 2500 && /(?:approval policy|sandbox_mode|workspace dependencies|thread coordination)/i.test(raw)) return '';
  return raw;
}

function parseCodex(fileInfo) {
  const parsed = readJsonLines(fileInfo.file);
  if (!parsed.rows.length) return null;
  const metaRow = parsed.rows.find(row => row.type === 'session_meta');
  const meta = (metaRow && metaRow.payload) || {};
  const externalId = meta.id || meta.session_id || path.basename(fileInfo.file, '.jsonl').split('-').slice(-5).join('-');
  const session = baseSession('codex', externalId, fileInfo.file, fileInfo);
  session.truncated = parsed.truncated;
  session.cwd = meta.cwd || '';
  session.model = meta.model || '';
  session.branch = meta.git && meta.git.branch || '';
  session.startedAt = timestamp(meta.timestamp || (metaRow && metaRow.timestamp), session.updatedAt);
  if (/codex desktop/i.test(String(meta.originator || ''))) {
    session.clientKind = 'codex-desktop';
    session.sourceLabel = 'Codex 데스크톱 앱';
  } else if (/vscode|ide/i.test(String(meta.source || ''))) {
    session.clientKind = 'codex-ide';
    session.sourceLabel = 'Codex IDE';
  } else {
    session.clientKind = 'codex-cli';
  }
  const spawn = meta.source && meta.source.subagent && meta.source.subagent.thread_spawn;
  if (spawn && spawn.parent_thread_id) {
    session.parentId = `codex:${spawn.parent_thread_id}`;
    session.depth = Number(spawn.depth || 1);
    session.agentName = spawn.agent_nickname || spawn.agent_role || 'subagent';
    session.agentRole = spawn.agent_role || '';
  }

  let latestUser = '';
  let activeTurn = false;
  let latestTs = session.updatedAt;
  let observedWindow = Number(meta.context_window || 0);
  const seenMessages = new Set();

  for (const row of parsed.rows) {
    latestTs = timestamp(row.timestamp, latestTs);
    const payload = row.payload || {};
    if (row.type === 'turn_context') {
      session.model = payload.model || session.model;
      session.cwd = payload.cwd || session.cwd;
    }
    if (row.type === 'event_msg') {
      if (payload.type === 'task_started') {
        activeTurn = true;
        addLifecycle(session, { id: payload.turn_id, type: 'turn-start', label: '턴 시작', status: 'running', timestamp: payload.started_at || row.timestamp });
      } else if (payload.type === 'task_complete') {
        activeTurn = false;
        addLifecycle(session, { id: payload.turn_id, type: 'turn-complete', label: '턴 완료', detail: payload.duration_ms ? `${payload.duration_ms} ms` : '', status: 'done', timestamp: payload.completed_at || row.timestamp });
      } else if (payload.type === 'user_message') {
        const text = codexVisibleUserText(payload.message || payload.text_elements);
        if (!text) continue;
        latestUser = text;
        const key = `u:${payload.client_id || row.timestamp}:${text}`;
        if (!seenMessages.has(key)) addMessage(session, { id: key, role: 'user', text, timestamp: row.timestamp });
        seenMessages.add(key);
      } else if (payload.type === 'agent_message') {
        const text = compactText(payload.message);
        const key = `a:${row.timestamp}:${text}`;
        if (!seenMessages.has(key)) addMessage(session, { id: key, role: 'assistant', text, timestamp: row.timestamp });
        seenMessages.add(key);
      } else if (payload.type === 'agent_reasoning') {
        addLifecycle(session, { id: `r:${row.timestamp}`, type: 'reasoning', label: '판단 중', detail: '다음 작업을 판단하고 결과를 정리하는 중', status: 'running', timestamp: row.timestamp });
      } else if (payload.type === 'token_count' && payload.info) {
        session.usage = codexUsage(payload.info.total_token_usage);
        session.turnUsage = codexUsage(payload.info.last_token_usage);
        observedWindow = Number(payload.info.model_context_window || observedWindow);
      } else if (/failed|error/.test(String(payload.type || ''))) {
        session.status = 'failed';
        session.statusDetail = compactText(payload.message || payload.error || payload.type, 240);
        activeTurn = false;
      }
    }
    if (row.type === 'response_item') {
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const name = payload.name || 'tool';
        addMessage(session, { id: payload.call_id || payload.id, role: 'tool', type: 'tool', title: name, text: compactText(payload.arguments || payload.input, 1000), status: payload.status || 'started', timestamp: row.timestamp });
        addLifecycle(session, { id: payload.call_id || payload.id, type: 'tool', label: name, detail: compactText(payload.arguments || payload.input, 240), status: payload.status === 'completed' ? 'done' : 'running', timestamp: row.timestamp });
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        addLifecycle(session, { id: `out:${payload.call_id}`, type: 'tool-result', label: '도구 완료', status: 'done', timestamp: row.timestamp });
      } else if (payload.type === 'message') {
        const role = payload.role === 'assistant' ? 'assistant' : 'user';
        const rawText = codexContentText(payload.content);
        const text = role === 'user' ? codexVisibleUserText(rawText) : rawText;
        if (!text) continue;
        const key = payload.id || `message:${role}:${row.timestamp}:${text.slice(0, 80)}`;
        if (!seenMessages.has(key)) addMessage(session, { id: key, role, text, timestamp: row.timestamp });
        seenMessages.add(key);
        if (role === 'user') latestUser = text;
      }
    }
  }

  session.updatedAt = latestTs;
  session.title = compactText(latestUser, 180) || (session.depth ? `${session.agentName} 서브에이전트` : 'GPT 작업 세션');
  const windowInfo = modelContextWindow('codex', session.model, observedWindow);
  session.context = contextInfo(session.turnUsage.total || session.turnUsage.input, windowInfo);
  if (session.status !== 'failed') {
    const turnAge = Date.now() - fileInfo.mtimeMs;
    if (activeTurn && turnAge < STALE_TURN_THRESHOLD_MS) {
      session.status = 'running';
      session.statusDetail = '턴 실행 중';
      session.statusObserved = true;
    } else {
      session.status = 'idle';
      session.statusDetail = activeTurn ? '마지막 턴 기록이 종료됨' : '다음 요청 대기';
      session.statusObserved = Date.now() - fileInfo.mtimeMs < ACTIVE_THRESHOLD_MS;
    }
  }
  trimSession(session);
  return session;
}

function genericUsage(raw = {}) {
  const usage = raw.usageMetadata || raw.usage_metadata || raw.usage || raw.stats || raw.tokens || raw;
  return finalizeUsage({
    input: usage.input_tokens || usage.inputTokenCount || usage.prompt_tokens || usage.promptTokenCount,
    cachedInput: usage.cached_input_tokens || usage.cachedContentTokenCount || usage.cached_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
    output: usage.output_tokens || usage.candidatesTokenCount || usage.completion_tokens || usage.response_tokens,
    reasoning: usage.reasoning_tokens || usage.thoughtsTokenCount,
    total: usage.total_tokens || usage.totalTokenCount || usage.total_token_count,
  });
}

function flattenGenericRows(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenGenericRows(item, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;
  const role = value.role || value.author || value.sender;
  const text = compactText(value.text || value.content || value.message || value.response || value.prompt);
  if (role && text) out.push(value);
  for (const key of ['messages', 'history', 'turns', 'events', 'conversation']) {
    if (value[key]) flattenGenericRows(value[key], out, depth + 1);
  }
  return out;
}

function parseGeneric(fileInfo, provider) {
  const isJsonl = /\.jsonl$/i.test(fileInfo.file);
  const parsed = isJsonl ? readJsonLines(fileInfo.file) : { rows: [readJson(fileInfo.file, {})], truncated: false };
  const rows = parsed.rows.filter(Boolean);
  if (!rows.length) return null;
  const root = rows.length === 1 ? rows[0] : { events: rows };
  const externalId = root.session_id || root.sessionId || root.id || path.basename(fileInfo.file).replace(/\.(jsonl?|ndjson)$/i, '');
  const session = baseSession(provider, externalId, fileInfo.file, fileInfo);
  session.truncated = parsed.truncated;
  session.cwd = root.cwd || root.projectPath || root.project_path || '';
  session.model = root.model || root.modelId || '';
  session.startedAt = timestamp(root.startTime || root.startedAt || root.created_at, session.updatedAt);
  session.parentId = root.parent_session_id ? `${provider}:${root.parent_session_id}` : null;
  session.depth = session.parentId ? 1 : 0;
  let firstUser = '';
  let running = false;
  let failed = false;
  const messageUsage = [];

  const events = rows.length === 1 && Array.isArray(root.events) ? root.events : rows;
  for (const event of events) {
    const type = String(event.type || event.event || event.kind || '').toLowerCase();
    if (type === 'init') {
      session.model = event.model || session.model;
      session.externalId = event.session_id || event.sessionId || session.externalId;
      addLifecycle(session, { id: `init:${event.timestamp || 0}`, type: 'session-start', label: '세션 시작', status: 'done', timestamp: event.timestamp });
    }
    if (/tool_use|tool-call|tool_start/.test(type)) {
      const tool = event.tool_name || event.name || event.tool || 'tool';
      addMessage(session, { id: event.id, role: 'tool', type: 'tool', title: tool, text: compactText(event.parameters || event.args || event.input, 1000), status: 'started', timestamp: event.timestamp });
      addLifecycle(session, { id: event.id, type: 'tool', label: tool, status: 'running', timestamp: event.timestamp });
      running = true;
    }
    if (/tool_result|tool-result|tool_end/.test(type)) addLifecycle(session, { id: `result:${event.id || event.tool_call_id}`, type: 'tool-result', label: '도구 완료', status: event.error ? 'failed' : 'done', timestamp: event.timestamp });
    if (type === 'result' || /session_end|completed/.test(type)) running = false;
    if (type === 'error' || event.error) failed = true;
    const usage = genericUsage(event);
    if (usage.total) session.usage = usage;
  }

  for (const item of flattenGenericRows(root)) {
    const rawRole = String(item.role || item.author || item.sender || '').toLowerCase();
    const role = /assistant|model|agent/.test(rawRole) ? 'assistant' : (rawRole === 'user' ? 'user' : 'system');
    const text = compactText(item.text || item.content || item.message || item.response || item.prompt);
    addMessage(session, { id: item.id || item.uuid, role, text, timestamp: item.timestamp || item.created_at });
    if (role === 'user' && !firstUser) firstUser = text;
    const usage = genericUsage(item);
    if (usage.total) {
      session.turnUsage = usage;
      messageUsage.push(usage);
    }
  }

  if (!session.usage.total && messageUsage.length) session.usage = sumUsage(messageUsage);
  session.title = firstUser || `${provider === 'gemini' ? 'Gemini' : 'Grok'} 세션`;
  const context = modelContextWindow(provider, session.model, root.context_window || root.contextWindow);
  session.context = contextInfo(session.turnUsage.total || session.usage.total, context);
  const age = Date.now() - fileInfo.mtimeMs;
  session.status = failed ? 'failed' : ((running && age < STALE_TURN_THRESHOLD_MS) || age < ACTIVE_THRESHOLD_MS ? 'running' : 'idle');
  session.statusDetail = failed ? '오류 발생' : (session.status === 'running' ? '실시간 이벤트 수신 중' : '다음 요청 대기');
  session.statusObserved = running;
  trimSession(session);
  return session;
}

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
    source: 'lodestar',
    sourceLabel: 'Lodestar 실행',
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

function attachHierarchy(sessions) {
  const byId = new Map(sessions.map(session => [session.id, session]));
  for (const session of sessions) session.childIds = [];
  for (const session of sessions) {
    if (!session.parentId) continue;
    const parent = byId.get(session.parentId);
    if (parent && !parent.childIds.includes(session.id)) parent.childIds.push(session.id);
  }
}

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
    try { dirs = fs.readdirSync(this.runsDir, { withFileTypes: true }).filter(item => item.isDirectory()); } catch { return []; }
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
      const byId = new Map(sessions.map(session => [session.id, session]));
      for (const session of managed) byId.set(session.id, session);
      const merged = [...byId.values()]
        .map(session => ({ ...session, workspace: workspaceLabel(session.cwd) }))
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
  readJsonLines,
  buildSummary,
  contextInfo,
};
