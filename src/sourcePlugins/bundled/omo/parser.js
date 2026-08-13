'use strict';

const path = require('path');
const { OMO_MANIFEST, OMO_PLUGIN_ID } = require('./manifest');

const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_MESSAGE_TEXT = 256 * 1024;
const MAX_TOOL_DETAIL = 8 * 1024;
const MAX_TOOL_OUTPUT = 16 * 1024;
const MAX_ARTIFACTS = 200;

const SHELL_TOOLS = new Set([
  'bash',
  'cmd',
  'exec',
  'exec_command',
  'powershell',
  'pwsh',
  'shell',
  'shell_command',
  'terminal',
]);

const ARTIFACT_TOOLS = new Set([
  'apply_patch',
  'edit',
  'multiedit',
  'patch',
  'write',
]);

const SECRET_PATH_PATTERN = /(?:^|[\\/])(?:\.env(?:\.|$)|cookies?(?:\.|$)|credentials?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|keychain(?:\.|$)|login data(?:\.|$)|passwords?(?:\.|$)|secrets?(?:\.|$)|tokens?(?:\.|$))/i;
const SECRET_KEY_PATTERN = /^(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|password|private[_-]?key|refresh[_-]?token|secret|token)$/i;

function safeJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_invalidJson) {
    return fallback;
  }
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timeMs(value) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestamp(value, fallback = null) {
  const parsed = timeMs(value);
  if (!parsed) return fallback;
  try {
    return new Date(parsed).toISOString();
  } catch (_invalidTime) {
    return fallback;
  }
}

function clipped(value, limit = 4000) {
  const text = String(value == null ? '' : value).replace(/[\u0000\u200B-\u200D\u2060\uFEFF]/g, '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function redactSecrets(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') {
    return value
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
      .replace(/([?&](?:access_token|api_key|key|secret|token)=)[^&#\s]+/gi, '$1[REDACTED]')
      .replace(/\b((?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|password|private[_-]?key|refresh[_-]?token|secret|token)\s*[:=]\s*)('[^']*'|"[^"]*"|[^\s,;]+)/gi, '$1[REDACTED]');
  }
  if (value == null || typeof value !== 'object') return value;
  if (depth > 5 || seen.has(value)) return '[omitted]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactSecrets(item, seen, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(item, seen, depth + 1);
  }
  return result;
}

function serialized(value, limit = MAX_TOOL_DETAIL) {
  if (typeof value === 'string') return clipped(redactSecrets(value), limit);
  if (value == null) return '';
  try {
    return clipped(JSON.stringify(redactSecrets(value), null, 2), limit);
  } catch (_unserializable) {
    return '';
  }
}

function compatibilityProvider(value) {
  const raw = String(value || '').toLowerCase();
  if (/anthropic|claude/.test(raw)) return 'claude';
  if (/google|gemini/.test(raw)) return 'gemini';
  if (/xai|grok/.test(raw)) return 'grok';
  return 'codex';
}

function normalizeModelProvider(value) {
  const raw = clipped(value, 120).toLowerCase();
  if (!raw) return { id: 'unknown', label: 'Unknown', compatibilityProvider: 'codex' };
  const aliases = [
    [/anthropic|claude/, 'anthropic', 'Anthropic'],
    [/openai|codex/, 'openai', 'OpenAI'],
    [/google|gemini/, 'google', 'Google'],
    [/xai|grok/, 'xai', 'xAI'],
    [/moonshot|kimi/, 'moonshot', 'Moonshot AI'],
    [/openrouter/, 'openrouter', 'OpenRouter'],
    [/opencode/, 'opencode', 'OpenCode'],
  ];
  const match = aliases.find(([pattern]) => pattern.test(raw));
  const id = match ? match[1] : raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
  const label = match ? match[2] : clipped(value, 120);
  return { id, label, compatibilityProvider: compatibilityProvider(raw) };
}

function platformEnvironment(platform = process.platform, arch = process.arch) {
  const label = platform === 'win32' ? 'Windows' : (platform === 'darwin' ? 'macOS' : (platform === 'linux' ? 'Linux' : platform));
  const kind = platform === 'win32' ? 'windows' : (platform === 'darwin' ? 'macos' : platform);
  return {
    platform,
    kind,
    arch,
    label,
    host: 'local',
    runtime: 'OpenCode',
    backend: 'opencode',
  };
}

function parsedMessageRow(row) {
  const data = safeJson(row && row.data, {});
  return {
    id: clipped(row && row.id || data.id, 240),
    sessionId: clipped(row && row.session_id || data.sessionID || data.sessionId, 240),
    createdMs: timeMs(data.time && data.time.created || row && row.time_created),
    updatedMs: timeMs(data.time && (data.time.completed || data.time.updated) || row && row.time_updated),
    role: String(data.role || '').toLowerCase(),
    agent: clipped(data.agent || data.mode, 180),
    providerId: clipped(data.providerID || data.providerId || data.model && (data.model.providerID || data.model.providerId), 120),
    modelId: clipped(data.modelID || data.modelId || data.model && (data.model.modelID || data.model.modelId), 240),
    finish: clipped(data.finish || data.stopReason, 120),
    error: data.error || null,
    cost: number(data.cost),
    tokens: data.tokens && typeof data.tokens === 'object' ? data.tokens : {},
    path: data.path && typeof data.path === 'object' ? data.path : {},
    raw: data,
  };
}

function parsedPartRow(row) {
  const data = safeJson(row && row.data, {});
  const state = data.state && typeof data.state === 'object' ? data.state : {};
  return {
    id: clipped(row && row.id || data.id, 240),
    messageId: clipped(row && row.message_id || data.messageID || data.messageId, 240),
    sessionId: clipped(row && row.session_id || data.sessionID || data.sessionId, 240),
    createdMs: timeMs(data.time && (data.time.start || data.time.created) || state.time && state.time.start || row && row.time_created),
    updatedMs: timeMs(data.time && (data.time.end || data.time.completed) || state.time && state.time.end || row && row.time_updated),
    type: String(data.type || '').toLowerCase(),
    text: typeof data.text === 'string' ? data.text : '',
    tool: clipped(data.tool || data.name, 180),
    callId: clipped(data.callID || data.callId || data.id || row && row.id, 240),
    state,
    raw: data,
  };
}

function usageFromMessages(messages) {
  const usage = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const tokens = message.tokens || {};
    const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
    const input = number(tokens.input || tokens.input_tokens);
    const output = number(tokens.output || tokens.output_tokens);
    const reasoning = number(tokens.reasoning || tokens.reasoning_tokens);
    const cachedInput = number(cache.read || tokens.cachedInput || tokens.cached_input_tokens);
    const cacheWrite = number(cache.write || tokens.cacheWrite || tokens.cache_write_tokens);
    const total = number(tokens.total || tokens.total_tokens) || input + output + reasoning;
    usage.input += Math.max(0, input);
    usage.output += Math.max(0, output);
    usage.reasoning += Math.max(0, reasoning);
    usage.cachedInput += Math.max(0, cachedInput);
    usage.cacheWrite += Math.max(0, cacheWrite);
    usage.total += Math.max(0, total);
  }
  return usage;
}

function lastTurnUsage(messages) {
  const latest = [...messages].reverse().find(message => message.role === 'assistant');
  return usageFromMessages(latest ? [latest] : []);
}

function toolStatus(value) {
  const raw = String(value || '').toLowerCase();
  if (/error|fail|reject|cancel/.test(raw)) return 'failed';
  if (/pending|running|started|progress/.test(raw)) return 'running';
  if (/complete|success|done/.test(raw)) return 'completed';
  return raw ? 'unverified' : 'unverified';
}

function lifecycleStatus(value) {
  const status = toolStatus(value);
  if (status === 'completed') return 'done';
  return status;
}

function toolInputSummary(tool, state) {
  const input = state.input && typeof state.input === 'object' ? state.input : {};
  const preferred = input.description || input.command || input.path || input.filePath || input.file_path
    || input.pattern || input.query || input.url || input.task_id || input.session_id;
  if (preferred) return clipped(redactSecrets(String(preferred)), MAX_TOOL_DETAIL);
  const summary = serialized(input, MAX_TOOL_DETAIL);
  return summary === '{}' ? '' : summary;
}

function shellRuntime(tool, command, platform) {
  const value = `${tool} ${command}`.toLowerCase();
  if (/powershell|pwsh/.test(value)) return 'OpenCode · PowerShell';
  if (/\bcmd(?:\.exe)?\b/.test(value)) return 'OpenCode · Windows command prompt';
  if (/\bbash\b|\bsh\b/.test(value)) return platform === 'win32' ? 'OpenCode · shell/WSL' : 'OpenCode · shell';
  return 'OpenCode · terminal';
}

function executionFromTool(part, environment) {
  const tool = String(part.tool || '').toLowerCase().split(/[.:/]/).filter(Boolean).pop() || '';
  if (!SHELL_TOOLS.has(tool)) return null;
  const input = part.state.input && typeof part.state.input === 'object' ? part.state.input : {};
  const metadata = part.state.metadata && typeof part.state.metadata === 'object' ? part.state.metadata : {};
  const command = clipped(redactSecrets(input.command || input.cmd || input.script || ''), 16 * 1024);
  const status = toolStatus(part.state.status);
  const startedAt = timestamp(part.state.time && part.state.time.start || part.createdMs);
  const updatedAt = timestamp(part.state.time && part.state.time.end || part.updatedMs || part.createdMs, startedAt);
  const exit = number(metadata.exit, Number.NaN);
  const output = clipped(redactSecrets(part.state.output || metadata.output || part.state.error || ''), MAX_TOOL_OUTPUT);
  const backgroundId = clipped(metadata.backgroundTaskId || metadata.taskId || input.task_id || input.session_id, 240);
  return {
    id: part.callId || part.id,
    callId: part.callId || '',
    kind: 'shell',
    mode: backgroundId ? 'background' : 'foreground',
    tool,
    runtime: shellRuntime(tool, command, environment.platform),
    label: clipped(input.description || part.state.title || command.split(/\r?\n/).find(Boolean) || tool, 180),
    command,
    cwd: clipped(input.workdir || input.cwd || '', 1000),
    status,
    statusDetail: status === 'running' ? 'OpenCode에서 실행 중' : (status === 'failed' ? 'OpenCode 실행 실패' : (status === 'completed' ? 'OpenCode 실행 완료' : '최근 상태를 확인하지 못함')),
    output,
    backgroundId,
    exitCode: Number.isFinite(exit) ? exit : null,
    startedAt,
    updatedAt,
    completedAt: status === 'completed' || status === 'failed' ? updatedAt : null,
    source: 'omo-opencode-tool',
  };
}

function acceptableArtifactPath(value) {
  const raw = clipped(value, 2000);
  if (!raw || raw.includes('\u0000') || /^https?:\/\//i.test(raw) || SECRET_PATH_PATTERN.test(raw)) return '';
  return raw;
}

function patchPaths(value) {
  const paths = [];
  const pattern = /^\*\*\*\s+(Add|Update|Delete) File:\s*(.+?)\s*$/gmi;
  for (const match of String(value || '').matchAll(pattern)) {
    const file = acceptableArtifactPath(match[2]);
    if (file) paths.push({ path: file, action: match[1].toLowerCase() });
  }
  return paths;
}

function artifactCandidates(part, sessionDirectory) {
  const tool = String(part.tool || '').toLowerCase().split(/[.:/]/).filter(Boolean).pop() || '';
  if (!ARTIFACT_TOOLS.has(tool)) return [];
  const input = part.state.input && typeof part.state.input === 'object' ? part.state.input : {};
  const metadata = part.state.metadata && typeof part.state.metadata === 'object' ? part.state.metadata : {};
  const metadataFiles = Array.isArray(metadata.files) ? metadata.files : [];
  const values = [input.filePath, input.file_path, input.path, input.filename, input.target];
  const candidates = values.map(file => ({ path: acceptableArtifactPath(file), action: tool === 'write' ? 'write' : 'update' }));
  candidates.push(...metadataFiles.slice(0, MAX_ARTIFACTS).map(file => ({
    path: acceptableArtifactPath(file && (file.filePath || file.relativePath || file.path)),
    action: clipped(file && file.type || 'update', 40),
  })));
  if (tool === 'apply_patch' || tool === 'patch') candidates.push(...patchPaths(input.patch || input.patchText || input.diff));
  return candidates.filter(candidate => candidate.path).map((candidate, index) => {
    const absolute = path.isAbsolute(candidate.path) || !sessionDirectory
      ? candidate.path
      : path.resolve(sessionDirectory, candidate.path);
    return {
      id: `${part.id || part.callId}:artifact:${index}`,
      kind: 'file',
      action: candidate.action,
      path: absolute,
      name: path.basename(absolute),
      timestamp: timestamp(part.updatedMs || part.createdMs),
      source: 'omo-opencode-tool',
    };
  });
}

function summaryArtifacts(sessionRow, sessionDirectory) {
  const parsed = safeJson(sessionRow && sessionRow.summary_diffs, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, MAX_ARTIFACTS).flatMap((diff, index) => {
    if (!diff || typeof diff !== 'object') return [];
    const candidate = acceptableArtifactPath(diff.file || diff.path || diff.filename);
    if (!candidate) return [];
    const absolute = path.isAbsolute(candidate) || !sessionDirectory ? candidate : path.resolve(sessionDirectory, candidate);
    return [{
      id: `summary:artifact:${index}`,
      kind: 'file',
      action: diff.status || diff.type || 'changed',
      path: absolute,
      name: path.basename(absolute),
      timestamp: timestamp(sessionRow.time_updated),
      source: 'opencode-summary',
    }];
  });
}

function dedupeArtifacts(rows) {
  const result = [];
  const keys = new Set();
  for (const row of rows) {
    const key = String(row.path || '').toLowerCase();
    if (!key || keys.has(key)) continue;
    keys.add(key);
    result.push(row);
    if (result.length >= MAX_ARTIFACTS) break;
  }
  return result;
}

function buildMessages(messageRows, partRows, maxText = MAX_MESSAGE_TEXT) {
  const partsByMessage = new Map();
  for (const part of partRows) {
    if (part.type !== 'text' || !part.text) continue;
    const rows = partsByMessage.get(part.messageId) || [];
    rows.push(part);
    partsByMessage.set(part.messageId, rows);
  }
  const result = [];
  for (const message of messageRows) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const parts = (partsByMessage.get(message.id) || []).sort((left, right) => left.createdMs - right.createdMs);
    const text = clipped(parts.map(part => part.text).filter(Boolean).join('\n\n'), maxText);
    if (!text) continue;
    result.push({
      id: message.id,
      role: message.role,
      type: 'message',
      text,
      title: '',
      status: message.error ? 'failed' : '',
      timestamp: timestamp(message.createdMs),
      modelProvider: message.providerId || '',
      model: message.modelId || '',
      agentName: message.agent || '',
    });
  }
  return result;
}

function buildLifecycle(partRows) {
  const result = [];
  let openStep = null;
  for (const part of partRows) {
    if (part.type === 'step-start') {
      openStep = {
        id: part.id,
        type: 'step-start',
        label: 'OpenCode 작업 단계 시작',
        detail: '',
        status: 'running',
        timestamp: timestamp(part.createdMs),
      };
      result.push(openStep);
    } else if (part.type === 'step-finish') {
      if (openStep) openStep.status = 'done';
      const reason = clipped(part.raw.reason, 180);
      result.push({
        id: part.id,
        type: 'step-finish',
        label: reason ? `OpenCode 단계 완료 · ${reason}` : 'OpenCode 작업 단계 완료',
        detail: '',
        status: /error|fail/.test(reason.toLowerCase()) ? 'failed' : 'done',
        timestamp: timestamp(part.updatedMs || part.createdMs),
      });
      openStep = null;
    } else if (part.type === 'reasoning') {
      result.push({
        id: part.id,
        type: 'reasoning',
        label: '모델이 다음 작업을 검토함',
        detail: '',
        status: 'done',
        timestamp: timestamp(part.createdMs),
      });
    } else if (part.type === 'tool') {
      if (String(part.tool || '').toLowerCase() === 'todowrite') {
        const todos = part.state.input && Array.isArray(part.state.input.todos) ? part.state.input.todos : [];
        for (const [index, todo] of todos.slice(0, 100).entries()) {
          const todoStatus = String(todo && todo.status || '').toLowerCase();
          result.push({
            id: `${part.callId || part.id}:todo:${index}`,
            type: 'plan-step',
            label: clipped(todo && todo.content || 'OpenCode 계획 항목', 240),
            detail: '',
            status: todoStatus === 'completed' ? 'done' : (todoStatus === 'in_progress' ? 'running' : 'pending'),
            timestamp: timestamp(part.state.time && part.state.time.start || part.createdMs),
            completedAt: todoStatus === 'completed' ? timestamp(part.state.time && part.state.time.end || part.updatedMs) : null,
          });
        }
      }
      const inputDetail = toolInputSummary(part.tool, part.state);
      const output = clipped(redactSecrets(part.state.output || part.state.error || ''), MAX_TOOL_OUTPUT);
      const detail = clipped([inputDetail, output].filter(Boolean).join('\n\n'), MAX_TOOL_DETAIL);
      result.push({
        id: part.callId || part.id,
        type: 'tool',
        tool: part.tool,
        label: clipped(part.state.title || part.tool || 'OpenCode 도구', 180),
        detail,
        output,
        status: lifecycleStatus(part.state.status),
        timestamp: timestamp(part.state.time && part.state.time.start || part.createdMs),
        completedAt: timestamp(part.state.time && part.state.time.end || part.updatedMs),
      });
    }
  }
  return result;
}

function latestModelMessage(messages) {
  return [...messages].reverse().find(message => message.providerId || message.modelId) || null;
}

function computeStatus(sessionRow, messages, parts, nowMs) {
  const archivedAt = timestamp(sessionRow.time_archived);
  const finish = value => archivedAt
    ? {
      ...value,
      status: value.status === 'running' ? 'idle' : value.status,
      detail: 'OpenCode에서 보관됨',
      archived: true,
      archivedAt,
    }
    : { ...value, archived: false, archivedAt: null };
  const latestConversation = [...messages].reverse().find(message => message.role === 'assistant' || message.role === 'user') || null;
  const latestAssistant = [...messages].reverse().find(message => message.role === 'assistant') || null;
  const latestUser = [...messages].reverse().find(message => message.role === 'user') || null;
  const latestTool = [...parts].reverse().find(part => part.type === 'tool') || null;
  const latestStepFinish = [...parts].reverse().find(part => part.type === 'step-finish') || null;
  const messageTime = message => message ? Math.max(message.createdMs, message.updatedMs) : 0;
  const partTime = part => part ? Math.max(part.createdMs, part.updatedMs) : 0;
  const latestTime = Math.max(
    timeMs(sessionRow.time_updated),
    messageTime(latestConversation),
    partTime(latestTool),
  );
  const recent = latestTime > 0 && Math.max(0, nowMs - latestTime) <= ACTIVE_THRESHOLD_MS;
  const latestUserTime = messageTime(latestUser);
  const assistantTime = messageTime(latestAssistant);
  const messageFailed = Boolean(latestAssistant && latestAssistant.error && assistantTime >= latestUserTime);
  const toolState = latestTool ? toolStatus(latestTool.state.status) : '';
  if (messageFailed || toolState === 'failed' && partTime(latestTool) >= messageTime(latestConversation)) {
    return finish({ status: 'failed', detail: 'OpenCode 작업에서 오류가 발생함', observed: true });
  }
  const terminalFinish = value => /^(?:stop|end[_-]?turn|length|content[_-]?filter|completed?)$/i.test(String(value || '').trim());
  const assistantIsLatest = Boolean(latestAssistant && latestConversation && latestAssistant.id === latestConversation.id);
  const finalResponse = assistantIsLatest && (
    terminalFinish(latestAssistant.finish)
    || (latestStepFinish && partTime(latestStepFinish) >= assistantTime && terminalFinish(latestStepFinish.raw.reason))
  );
  const newerUserRequest = Boolean(latestUser && (!latestAssistant || latestUserTime > assistantTime));
  const assistantOpen = Boolean(latestAssistant && assistantIsLatest && !finalResponse && !latestAssistant.error);
  if (recent && (newerUserRequest || assistantOpen || toolState === 'running' || timeMs(sessionRow.time_compacting))) {
    return finish({ status: 'running', detail: 'OpenCode에서 작업 중', observed: true });
  }
  if (finalResponse) return finish({ status: 'completed', detail: 'OpenCode 응답 완료', observed: true });
  return finish({ status: 'idle', detail: '다음 요청 대기', observed: false });
}

function emptyCollaboration() {
  return {
    capacity: { totalThreads: 0, subagents: 0, source: 'unknown' },
    spawns: [],
    communications: [],
    retainedAgents: [],
    retainedObserved: false,
    metrics: null,
  };
}

function buildCollaboration(partRows, idPrefix) {
  const spawns = [];
  const communications = [];
  const childExternalIds = [];
  for (const part of partRows) {
    if (part.type !== 'tool' || String(part.tool || '').toLowerCase() !== 'task') continue;
    const input = part.state.input && typeof part.state.input === 'object' ? part.state.input : {};
    const metadata = part.state.metadata && typeof part.state.metadata === 'object' ? part.state.metadata : {};
    const childExternalId = clipped(metadata.sessionId || metadata.session_id, 240);
    if (!childExternalId) continue;
    const taskName = clipped(input.description || input.subagent_type || input.category || 'OMO 하위 작업', 240);
    const status = toolStatus(part.state.status);
    const childId = `${idPrefix}:${childExternalId}`;
    childExternalIds.push(childExternalId);
    spawns.push({
      id: part.callId || part.id,
      childId,
      externalId: childExternalId,
      agentName: clipped(metadata.agent || input.subagent_type || input.category, 180),
      taskName,
      status,
      startedAt: timestamp(part.state.time && part.state.time.start || part.createdMs),
      completedAt: status === 'completed' || status === 'failed'
        ? timestamp(part.state.time && part.state.time.end || part.updatedMs)
        : null,
      assignment: clipped(redactSecrets(input.prompt || ''), 12 * 1024),
      assignmentObserved: Boolean(input.prompt),
      assignmentSource: input.prompt ? 'opencode-task-tool' : 'unavailable',
    });
    communications.push({
      id: `assign:${part.callId || part.id}`,
      kind: 'assignment',
      label: 'OMO 하위 작업 배정',
      from: 'OMO',
      to: childId,
      taskName,
      childId,
      text: clipped(redactSecrets(input.prompt || ''), 12 * 1024),
      timestamp: timestamp(part.state.time && part.state.time.start || part.createdMs),
    });
  }
  const collaboration = emptyCollaboration();
  collaboration.spawns = spawns;
  collaboration.communications = communications;
  collaboration.metrics = {
    spawnedTotal: spawns.length,
    running: spawns.filter(row => row.status === 'running').length,
    completed: spawns.filter(row => row.status === 'completed').length,
    concurrencyLimit: null,
  };
  return { collaboration, childExternalIds: [...new Set(childExternalIds)] };
}

function parseOpenCodeSession(input, options = {}) {
  const sessionRow = input && input.sessionRow || {};
  const messageRows = (input && input.messageRows || []).map(parsedMessageRow).sort((left, right) => left.createdMs - right.createdMs);
  const partRows = (input && input.partRows || []).map(parsedPartRow).sort((left, right) => left.createdMs - right.createdMs);
  const externalId = clipped(sessionRow.id, 240);
  if (!externalId) return null;
  const idPrefix = clipped(options.idPrefix || OMO_PLUGIN_ID, 120);
  const id = `${idPrefix}:${externalId}`;
  const parentExternalId = clipped(sessionRow.parent_id, 240);
  const environment = platformEnvironment(options.platform, options.arch);
  const messages = buildMessages(messageRows, partRows, options.maxMessageText || MAX_MESSAGE_TEXT);
  const modelMessage = latestModelMessage(messageRows);
  const modelProvider = normalizeModelProvider(modelMessage && modelMessage.providerId);
  const status = computeStatus(sessionRow, messageRows, partRows, number(options.now, Date.now()));
  const executions = partRows.map(part => executionFromTool(part, environment)).filter(Boolean);
  const sessionDirectory = clipped(sessionRow.directory || modelMessage && (modelMessage.path.cwd || modelMessage.path.root), 2000);
  const artifacts = dedupeArtifacts([
    ...summaryArtifacts(sessionRow, sessionDirectory),
    ...partRows.flatMap(part => artifactCandidates(part, sessionDirectory)),
  ]);
  const resultMessage = [...messages].reverse().find(message => message.role === 'assistant');
  const firstUser = messages.find(message => message.role === 'user');
  const agent = [...messageRows].reverse().find(message => message.agent);
  const startedAt = timestamp(sessionRow.time_created || messageRows[0] && messageRows[0].createdMs);
  const updatedAt = timestamp(Math.max(
    timeMs(sessionRow.time_updated),
    ...messageRows.map(message => Math.max(message.createdMs, message.updatedMs)),
    ...partRows.map(part => Math.max(part.createdMs, part.updatedMs)),
  ), startedAt || new Date(0).toISOString());
  const lifecycle = buildLifecycle(partRows);
  const collaborationInfo = buildCollaboration(partRows, idPrefix);
  const usage = usageFromMessages(messageRows);
  const totalRows = number(input && input.totalMessages, messageRows.length) + number(input && input.totalParts, partRows.length);
  const observedRows = messageRows.length + partRows.length;
  const truncated = Boolean(input && input.truncated) || totalRows > observedRows;
  const title = clipped(sessionRow.title || firstUser && firstUser.text || sessionRow.slug || 'OpenCode 작업', 240);
  const result = clipped(resultMessage && resultMessage.text, options.resultLimit || 64 * 1024);
  const controls = {
    managed: false,
    respond: true,
    approve: false,
    deny: false,
    sendInstruction: true,
    continue: true,
    // This is only an observed stop candidate: the database proves that work
    // is active, not that LoadToAgent owns its process. SourcePluginMonitorHost
    // intersects it with controlHost.managedSessionIds before the renderer can
    // receive an enabled stop action.
    stop: status.status === 'running',
    pause: false,
    resume: false,
    retry: false,
    reassign: false,
    openOrigin: Boolean(sessionDirectory),
    start: true,
    archive: false,
    delete: true,
    readConversation: true,
    readSteps: true,
    readTabs: false,
    readArtifacts: true,
    live: true,
    pty: false,
  };
  return {
    id,
    externalId,
    parentId: parentExternalId ? `${idPrefix}:${parentExternalId}` : null,
    parentExternalId: parentExternalId || null,
    depth: parentExternalId ? 1 : 0,
    childIds: collaborationInfo.childExternalIds.map(childId => `${idPrefix}:${childId}`),
    childExternalIds: collaborationInfo.childExternalIds,
    provider: modelProvider.compatibilityProvider,
    modelProvider: modelProvider.id,
    modelProviderLabel: modelProvider.label,
    model: modelMessage && modelMessage.modelId || '',
    title,
    status: status.status,
    activityState: status.status === 'failed' ? 'error' : (status.status === 'running' ? 'working' : 'idle'),
    statusDetail: status.detail,
    statusObserved: status.observed,
    cwd: sessionDirectory,
    originCwd: sessionDirectory,
    branch: '',
    source: 'omo',
    sourceLabel: OMO_MANIFEST.label,
    sourcePluginId: OMO_PLUGIN_ID,
    sourcePlugin: {
      id: OMO_PLUGIN_ID,
      version: String(OMO_MANIFEST.version),
      revision: 'bundled',
      label: OMO_MANIFEST.label,
      mark: OMO_MANIFEST.mark,
      accent: OMO_MANIFEST.accent,
      trust: OMO_MANIFEST.trust,
    },
    orchestrator: 'omo',
    clientKind: 'opencode-omo',
    conversationTransport: 'plugin',
    terminalBackend: 'opencode',
    environment: {
      kind: environment.kind,
      distro: '',
      label: `${environment.label} · OpenCode`,
      home: '',
    },
    runtimeEnvironment: environment,
    presentation: { ...OMO_MANIFEST.presentation },
    provenance: {
      source: { id: 'omo', label: OMO_MANIFEST.label, pluginId: OMO_PLUGIN_ID, trust: 'bundled' },
      provider: { id: modelProvider.id, label: modelProvider.label, family: modelProvider.compatibilityProvider },
      environment: { kind: environment.kind, label: environment.label },
      runtime: {
        kind: 'opencode', label: 'OpenCode', id: '', managed: false,
        platform: environment.platform, arch: environment.arch, backend: 'opencode', host: 'local',
      },
      orchestrator: { id: 'omo', label: 'Oh My OpenAgent' },
      client: { id: 'opencode', label: 'OpenCode' },
      modelProvider: { id: modelProvider.id, label: modelProvider.label },
    },
    agentName: agent && agent.agent || '',
    agentRole: agent && agent.agent || '',
    agentPath: '',
    taskName: parentExternalId ? title : '',
    sharedGoal: '',
    startedAt,
    updatedAt,
    endedAt: status.status === 'completed' || status.status === 'failed' || status.archived ? updatedAt : null,
    archived: status.archived,
    archivedAt: status.archivedAt,
    completedAt: status.status === 'completed' ? updatedAt : null,
    completionObserved: status.status === 'completed',
    result,
    cost: messageRows.reduce((total, message) => total + Math.max(0, message.cost), 0),
    changeSummary: {
      additions: Math.max(0, number(sessionRow.summary_additions)),
      deletions: Math.max(0, number(sessionRow.summary_deletions)),
      files: Math.max(0, number(sessionRow.summary_files)),
    },
    usage,
    turnUsage: lastTurnUsage(messageRows),
    context: { used: 0, window: 0, percent: 0, source: 'unknown' },
    messages,
    lifecycle,
    executions,
    artifacts,
    outcome: {
      status: status.status,
      summary: result,
      verified: status.status === 'completed',
      verification: status.status === 'completed' ? 'OpenCode finish event' : 'OpenCode local history',
      completedAt: status.status === 'completed' ? updatedAt : null,
      artifacts,
      checks: [],
    },
    collaboration: collaborationInfo.collaboration,
    loop: null,
    sourceControlCapabilities: { ...controls },
    controlCapabilities: controls,
    controlUnavailableReasons: {
      stop: 'LoadToAgent에서 시작해 현재 소유 중인 OMO 프로세스만 중지할 수 있습니다.',
      archive: 'OpenCode CLI는 세션 보관 명령을 제공하지 않습니다.',
    },
    fullHistory: Boolean(options.fullHistory),
    truncated,
    omittedMessages: Math.max(0, number(input && input.totalMessages, messageRows.length) - messageRows.length),
    omittedLifecycle: Math.max(0, number(input && input.totalParts, partRows.length) - partRows.length),
    file: options.dbPath || '',
  };
}

function attachOpenCodeHierarchy(sessions, idPrefix = OMO_PLUGIN_ID) {
  const byExternalId = new Map(sessions.map(session => [session.externalId, session]));
  function depthOf(session, seen = new Set()) {
    if (!session || !session.parentExternalId || seen.has(session.externalId)) return 0;
    seen.add(session.externalId);
    const parent = byExternalId.get(session.parentExternalId);
    return parent ? depthOf(parent, seen) + 1 : 1;
  }
  for (const session of sessions) {
    session.id = `${idPrefix}:${session.externalId}`;
    session.parentId = session.parentExternalId ? `${idPrefix}:${session.parentExternalId}` : null;
    session.childIds = (session.childExternalIds || []).map(childId => `${idPrefix}:${childId}`);
    session.depth = depthOf(session);
  }
  for (const session of sessions) {
    const parent = byExternalId.get(session.parentExternalId);
    if (parent && !parent.childIds.includes(session.id)) parent.childIds.push(session.id);
  }
  return sessions;
}

module.exports = {
  ACTIVE_THRESHOLD_MS,
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
};
