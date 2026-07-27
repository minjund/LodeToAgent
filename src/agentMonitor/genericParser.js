'use strict';

const path = require('path');
const { createExecutionTracker } = require('./executionActivity');

const TOOL_START_PATTERN = /tool_use|tool-call|tool_start/;
const TOOL_END_PATTERN = /tool_result|tool-result|tool_end/;

function createGenericParser(dependencies) {
  const {
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
    assistantResponseIntent,
    isUserInputTool,
  } = dependencies;

  function normalizeUsage(raw = {}) {
    const usage = raw.usageMetadata || raw.usage_metadata || raw.usage
      || raw.stats || raw.tokens || raw;
    return finalizeUsage({
      input: usage.input_tokens || usage.inputTokenCount || usage.prompt_tokens || usage.promptTokenCount,
      cachedInput: usage.cached_input_tokens || usage.cachedContentTokenCount || usage.cached_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      output: usage.output_tokens || usage.candidatesTokenCount
        || usage.completion_tokens || usage.response_tokens,
      reasoning: usage.reasoning_tokens || usage.thoughtsTokenCount,
      total: usage.total_tokens || usage.totalTokenCount || usage.total_token_count,
    });
  }

  function flattenRows(value, out = [], depth = 0, seen = new Set()) {
    if (depth > 6 || value == null) return out;
    if (Array.isArray(value)) {
      for (const item of value) flattenRows(item, out, depth + 1, seen);
      return out;
    }
    if (typeof value !== 'object' || seen.has(value)) return out;
    seen.add(value);
    const role = value.role || value.author || value.sender;
    const deltaText = typeof value.delta === 'string' ? value.delta : '';
    const text = compactText(value.text || value.content || value.message
      || value.response || value.prompt || deltaText);
    if (role && text) out.push({ value, order: out.length });
    for (const key of ['messages', 'history', 'turns', 'events', 'conversation']) {
      if (value[key]) flattenRows(value[key], out, depth + 1, seen);
    }
    return out;
  }

  function readSessionFile(fileInfo, options = {}) {
    const isJsonl = /\.jsonl$/i.test(fileInfo.file);
    return isJsonl
      ? readJsonLines(fileInfo.file, options.fullHistory ? Math.max(1, Number(fileInfo.size || 0) + 1) : undefined)
      : { rows: [readJson(fileInfo.file, {})], truncated: false };
  }

  function initializeSession(fileInfo, provider, parsed, options = {}) {
    const rows = parsed.rows.filter(Boolean);
    const root = rows.length === 1 ? rows[0] : { events: rows };
    const externalId = root.session_id || root.sessionId || root.id
      || path.basename(fileInfo.file).replace(/\.(jsonl?|ndjson)$/i, '');
    const session = baseSession(provider, externalId, fileInfo.file, fileInfo);
    session.fullHistory = Boolean(options.fullHistory);
    session.truncated = parsed.truncated;
    session.cwd = root.cwd || root.projectPath || root.project_path || '';
    session.originCwd = session.cwd;
    session.model = root.model || root.modelId || '';
    session.startedAt = timestamp(root.startTime || root.startedAt || root.created_at, session.updatedAt);
    session.parentId = root.parent_session_id ? `${provider}:${root.parent_session_id}` : null;
    session.depth = session.parentId ? 1 : 0;
    return { rows, root, session };
  }

  function recordToolStart(session, state, event) {
    const tool = event.tool_name || event.name || event.tool || 'tool';
    const callId = event.tool_call_id || event.tool_use_id || event.id;
    const args = event.parameters || event.args || event.input || {};
    state.toolCalls.set(String(callId || ''), { name: tool, args });
    state.executionTracker.recordCall({ name: tool, callId, args, rawInput: args, at: event.timestamp });
    addMessage(session, {
      id: event.id,
      role: 'tool',
      type: 'tool',
      title: tool,
      text: compactText(event.parameters || event.args || event.input, 1000),
      status: 'started',
      timestamp: event.timestamp,
    });
    addLifecycle(session, {
      id: event.id,
      type: 'tool',
      label: tool,
      status: 'running',
      timestamp: event.timestamp,
    });
  }

  function recordToolEnd(session, state, event) {
    const callId = event.tool_call_id || event.tool_use_id || event.id;
    const call = state.toolCalls.get(String(callId || ''));
    state.executionTracker.recordOutput({
      name: call && call.name,
      callId,
      args: call && call.args || {},
      output: event.output || event.result || event.content || event,
      at: event.timestamp,
      isError: Boolean(event.error),
    });
    settleLifecycle(session, callId, event.error ? 'failed' : 'done', event.timestamp);
    addLifecycle(session, {
      id: `result:${event.id || event.tool_call_id}`,
      type: 'tool-result',
      label: '도구 완료',
      status: event.error ? 'failed' : 'done',
      timestamp: event.timestamp,
    });
  }

  function processEvents(session, events) {
    const state = {
      running: false,
      failed: false,
      pendingUserInputCalls: new Set(),
      toolCalls: new Map(),
      executionTracker: createExecutionTracker({ compactText, timestamp }),
    };
    for (const event of events) {
      const type = String(event.type || event.event || event.kind || '').toLowerCase();
      if (type === 'init') {
        session.model = event.model || session.model;
        session.externalId = event.session_id || event.sessionId || session.externalId;
        addLifecycle(session, {
          id: `init:${event.timestamp || 0}`,
          type: 'session-start',
          label: '세션 시작',
          status: 'done',
          timestamp: event.timestamp,
        });
      }
      if (TOOL_START_PATTERN.test(type)) {
        recordToolStart(session, state, event);
        state.running = true;
        const toolName = event.tool_name || event.name || event.tool;
        if (isUserInputTool(toolName)) state.pendingUserInputCalls.add(String(event.id || toolName));
      }
      if (TOOL_END_PATTERN.test(type)) {
        recordToolEnd(session, state, event);
        state.pendingUserInputCalls.delete(String(event.tool_call_id || event.tool_use_id || event.id || ''));
      }
      if (type === 'result' || /session_end|completed/.test(type)) state.running = false;
      if (type === 'error' || event.error) state.failed = true;
      const usage = normalizeUsage(event);
      if (usage.total) session.usage = usage;
    }
    return state;
  }

  function normalizedMessage(row, session) {
    const item = row.value;
    const eventType = String(item.type || item.event || item.kind || '').toLowerCase();
    if (TOOL_START_PATTERN.test(eventType) || TOOL_END_PATTERN.test(eventType)) return null;
    const rawRole = String(item.role || item.author || item.sender || '').toLowerCase();
    const role = /assistant|model|agent/.test(rawRole)
      ? 'assistant'
      : (rawRole === 'user' ? 'user' : 'system');
    const deltaText = typeof item.delta === 'string' ? item.delta : '';
    const text = compactText(item.text || item.content || item.message
      || item.response || item.prompt || deltaText);
    const id = item.id || item.uuid || '';
    const recordedAt = timestamp(item.timestamp || item.created_at, session.updatedAt);
    const isDelta = item.is_delta === true || item.delta === true
      || typeof item.delta === 'string'
      || /(?:^|[_-])delta(?:$|[_-])/.test(eventType);
    return {
      item,
      role,
      text,
      id,
      recordedAt,
      isDelta,
      key: id ? `${role}:${id}` : `${role}:${text}:${recordedAt}`,
      order: row.order,
    };
  }

  function processMessages(session, root) {
    const messages = new Map();
    const usages = [];
    let firstUser = '';
    for (const row of flattenRows(root)) {
      const message = normalizedMessage(row, session);
      if (!message) continue;
      const previous = messages.get(message.key);
      const mergedText = previous && message.isDelta
        ? `${previous.text}${message.text}`
        : message.text;
      if (!previous || message.isDelta || message.text.length >= previous.text.length) {
        messages.set(message.key, {
          id: message.id,
          role: message.role,
          text: mergedText,
          timestamp: message.recordedAt,
          order: previous ? previous.order : message.order,
        });
      }
      if (message.role === 'user' && !firstUser) firstUser = message.text;
      const usage = normalizeUsage(message.item);
      if (usage.total) {
        session.turnUsage = usage;
        usages.push(usage);
      }
    }
    const orderedMessages = [...messages.values()]
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.order - b.order);
    orderedMessages.forEach(message => addMessage(session, message));
    const lastConversation = [...orderedMessages].reverse()
      .find(message => message.role === 'assistant' || message.role === 'user');
    return {
      firstUser,
      usages,
      lastConversationRole: lastConversation && lastConversation.role || '',
      lastAssistantText: lastConversation && lastConversation.role === 'assistant' ? lastConversation.text : '',
    };
  }

  function finalizeSession(session, provider, root, eventState, messageState, fileInfo) {
    if (!session.usage.total && messageState.usages.length) {
      session.usage = sumUsage(messageState.usages);
    }
    session.title = messageState.firstUser || `${provider === 'gemini' ? 'Gemini' : 'Grok'} 세션`;
    const context = modelContextWindow(provider, session.model, root.context_window || root.contextWindow);
    session.context = contextInfo(session.turnUsage.total || session.usage.total, context);
    const age = Date.now() - fileInfo.mtimeMs;
    const pendingUserInput = eventState.pendingUserInputCalls.size > 0;
    const responseIntent = assistantResponseIntent(messageState.lastAssistantText);
    session.responseIntent = pendingUserInput
      ? {
        category: 'required', required: true, optional: false,
        requestText: responseIntent.requestText || '선택 또는 입력이 필요합니다.',
        confidence: 'high', source: 'input-tool',
      }
      : { ...responseIntent, source: responseIntent.category === 'none' ? 'none' : 'assistant-message' };
    const conversationalInput = messageState.lastConversationRole === 'assistant'
      && responseIntent.required;
    session.status = eventState.failed
      ? 'failed'
      : (pendingUserInput || (!eventState.running && conversationalInput)
        ? 'waiting'
        : ((eventState.running && age < STALE_TURN_THRESHOLD_MS) || age < ACTIVE_THRESHOLD_MS
        ? 'running'
        : 'idle'));
    session.statusDetail = eventState.failed
      ? '오류 발생'
      : (session.status === 'waiting'
        ? (pendingUserInput ? '선택 또는 입력 대기' : '답변 또는 선택 대기')
        : (session.status === 'running' ? '실시간 이벤트 수신 중' : '다음 요청 대기'));
    session.statusObserved = eventState.running || session.status === 'waiting';
    session.executions = eventState.executionTracker.finalize();
    trimSession(session);
    return session;
  }

  return function parseGeneric(fileInfo, provider, options = {}) {
    const parsed = readSessionFile(fileInfo, options);
    const initialized = initializeSession(fileInfo, provider, parsed, options);
    if (!initialized.rows.length) return null;
    const events = initialized.rows.length === 1 && Array.isArray(initialized.root.events)
      ? initialized.root.events
      : initialized.rows;
    const eventState = processEvents(initialized.session, events);
    const messageState = processMessages(initialized.session, initialized.root);
    return finalizeSession(
      initialized.session,
      provider,
      initialized.root,
      eventState,
      messageState,
      fileInfo,
    );
  };
}

module.exports = { createGenericParser };
