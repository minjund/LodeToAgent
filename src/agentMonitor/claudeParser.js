'use strict';

const path = require('path');
const { finalizedActivityState, observeActivity } = require('./activityState');
const { createExecutionTracker, reconcileExecutionActivities } = require('./executionActivity');
const { structuredInputRequest, structuredInputRequestText } = require('./responseIntent');

function createClaudeParser(dependencies) {
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
    readJsonLines,
    settleLifecycle,
    sumUsage,
    timestamp,
    trimSession,
    assistantResponseIntent,
    isUserInputTool,
  } = dependencies;

  function taskNotification(value) {
    const text = String(value || '');
    if (!/<task-notification\b/i.test(text)) return null;
    const field = name => {
      const match = text.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
      return match ? match[1].trim() : '';
    };
    const taskId = field('task-id');
    const toolUseId = field('tool-use-id');
    const status = field('status').toLowerCase();
    if (!taskId && !toolUseId) return null;
    return { taskId, toolUseId, status, text };
  }

  function recordTaskNotification(state, value, at) {
    const notification = taskNotification(value);
    if (!notification || !/^(?:completed|failed|error|cancelled)$/.test(notification.status)) return null;
    state.executionTracker.recordOutput({
      name: 'bash',
      callId: notification.toolUseId,
      args: { task_id: notification.taskId },
      output: notification.text,
      at,
      isError: /^(?:failed|error)$/.test(notification.status),
    });
    observeActivity(state, 'working', at);
    return notification;
  }

  function normalizeUsage(raw = {}) {
    return finalizeUsage({
      input: raw.input_tokens,
      cachedInput: raw.cache_read_input_tokens,
      cacheWrite: raw.cache_creation_input_tokens,
      output: raw.output_tokens,
      reasoning: raw.reasoning_tokens,
    });
  }

  function utilityKind(value) {
    const raw = compactText(value, 12000);
    if (/^Extract durable memory candidates from this Claude Code transcript tail/i.test(raw)
      || /^You are a memory extraction/i.test(raw)) return 'memory-extraction';
    if (/^Reply with exactly OK\. Do not use tools\.?$/i.test(raw)) return 'authentication-check';
    if (/^Approved command prefix saved:/i.test(raw)) return 'command-approval';
    return '';
  }

  function visibleUserText(value) {
    const raw = compactText(value, 12000);
    if (!raw) return '';
    const objective = raw.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/i);
    if (objective) return compactText(objective[1], 6000);
    if (/^<(?:local-command-[^>]+|command-name|command-message|system-reminder|task-notification)>/i.test(raw)) return '';
    if (utilityKind(raw)) return '';
    if (/^(?:Updated task #\d+|Your questions have been answered:)/i.test(raw)) return '';
    return raw;
  }

  function structuredFailure(row) {
    const explicitError = row && (row.error || row.message && row.message.error);
    if (!explicitError && row && row.is_error !== true) return '';
    const message = row && row.message || {};
    const content = Array.isArray(message.content)
      ? message.content
        .filter(item => item && (!item.type || item.type === 'text'))
        .map(item => typeof item === 'string' ? item : item.text)
        .filter(Boolean)
        .join('\n')
      : message.content;
    return compactText(content || row.result || explicitError || 'Claude 실행 실패', 600);
  }

  function recordStructuredFailure(session, state, row) {
    const detail = structuredFailure(row);
    if (!detail) return false;
    state.failure = {
      detail,
      at: timestamp(row.timestamp, state.latestTs),
    };
    observeActivity(state, 'error', row.timestamp);
    addLifecycle(session, {
      id: `error:${row.uuid || row.requestId || row.timestamp || session.externalId}`,
      type: 'error',
      label: '실행 실패',
      detail,
      status: 'failed',
      timestamp: row.timestamp,
    });
    return true;
  }

  function isClaudeAgentTool(name) {
    return /^(?:Agent|Task)$/i.test(String(name || ''));
  }

  function isClaudeMessageTool(name) {
    return /^(?:SendMessage|send_message)$/i.test(String(name || ''));
  }

  function claudeChildId(value) {
    const externalId = compactText(value, 180).replace(/^claude:/i, '');
    return externalId ? `claude:${externalId}` : '';
  }

  function addClaudeCommunication(session, event) {
    const communications = session.collaboration.communications;
    const row = {
      id: String(event.id || `claude-communication:${communications.length}`),
      kind: event.kind || 'message',
      label: compactText(event.label || '메시지', 100),
      from: compactText(event.from, 180),
      to: compactText(event.to, 180),
      taskName: compactText(event.taskName, 180),
      childId: compactText(event.childId, 180),
      text: compactText(event.text, 6000),
      protected: false,
      assignmentSource: compactText(event.assignmentSource, 80),
      timestamp: timestamp(event.timestamp, session.updatedAt),
    };
    if (!communications.some(item => item.id === row.id)) communications.push(row);
  }

  function findClaudeSpawn(session, callId, childExternalId = '') {
    const childId = claudeChildId(childExternalId);
    return session.collaboration.spawns.find(record => record.callId === String(callId || '')
      || (childId && (record.childId === childId || record.agentPath === childId)));
  }

  function recordClaudeAgentCall(session, state, row, callId, args) {
    const prompt = compactText(args.prompt || args.message, 6000);
    const taskName = compactText(args.description || args.name || args.subagent_type, 180);
    const record = {
      callId: String(callId || `claude-spawn:${session.collaboration.spawns.length}`),
      taskName,
      agentPath: '',
      childId: '',
      assignment: prompt,
      assignmentObserved: Boolean(prompt),
      assignmentProtected: false,
      assignmentSource: prompt ? 'claude-agent-prompt' : 'unavailable',
      assignmentContext: '',
      sharedGoal: compactText(state.latestUser, 6000),
      status: 'requested',
      startedAt: timestamp(row.timestamp, session.updatedAt),
      completedAt: null,
      result: '',
      agentName: compactText(args.subagent_type, 120),
      currentlyRetained: false,
    };
    session.collaboration.spawns.push(record);
    addClaudeCommunication(session, {
      id: `assign:${record.callId}`,
      kind: 'assignment',
      label: '새 작업 배정',
      from: session.agentPath || session.id,
      to: record.taskName,
      taskName: record.taskName,
      text: record.assignment,
      assignmentSource: record.assignmentSource,
      timestamp: row.timestamp,
    });
  }

  function updateClaudeSpawn(session, callId, details = {}) {
    const record = findClaudeSpawn(session, callId, details.childExternalId);
    if (!record) return;
    const childExternalId = compactText(details.childExternalId, 180);
    if (childExternalId) {
      record.childId = claudeChildId(childExternalId);
      record.agentPath = record.childId;
    }
    if (details.status) record.status = details.status;
    if (details.startedAt) record.lastSentAt = timestamp(details.startedAt, record.lastSentAt || record.startedAt);
    if (details.status === 'running') record.completedAt = null;
    if (details.completedAt) record.completedAt = timestamp(details.completedAt, record.completedAt || session.updatedAt);
    if (details.result) record.result = compactText(details.result, 6000);
    for (const communication of session.collaboration.communications) {
      if (communication.taskName !== record.taskName || communication.childId) continue;
      communication.childId = record.childId;
      communication.to = record.agentPath || communication.to;
    }
    if ((record.status === 'running' || record.childId) && !session.collaboration.communications.some(item => item.id === `started:${record.callId}`)) {
      addClaudeCommunication(session, {
        id: `started:${record.callId}`,
        kind: 'started',
        label: '도움 AI 작업 시작',
        from: 'Claude AI',
        to: record.agentPath || record.taskName,
        taskName: record.taskName,
        childId: record.childId,
        timestamp: record.startedAt,
      });
    }
    const resultCallId = String(details.resultCallId || record.callId);
    if (record.completedAt && !session.collaboration.communications.some(item => item.id === `result:${resultCallId}`)) {
      addClaudeCommunication(session, {
        id: `result:${resultCallId}`,
        kind: 'result',
        label: '결과 반환 확인',
        from: record.agentPath || record.taskName,
        to: session.agentPath || session.id,
        taskName: record.taskName,
        childId: record.childId,
        text: record.result,
        timestamp: record.completedAt,
      });
    }
  }

  function recordClaudeMessageCall(session, state, row, callId, args) {
    const target = compactText(args.to || args.recipient || args.agent_id || args.agentId || args.task_id || args.taskId, 180);
    const childId = claudeChildId(target);
    const record = findClaudeSpawn(session, '', target);
    const messageType = String(args.type || '').toLowerCase();
    const kind = /interrupt|cancel|shutdown|stop/.test(messageType) ? 'interrupt' : 'followup';
    const text = compactText(args.message || args.content || args.prompt, 6000);
    const taskName = record && record.taskName || compactText(args.summary, 180);
    state.claudeMessageCalls.set(String(callId), { target, childId, kind, text, taskName });
    if (record && kind === 'followup') {
      updateClaudeSpawn(session, callId, {
        childExternalId: target,
        status: 'running',
        startedAt: row.timestamp,
      });
    }
    addClaudeCommunication(session, {
      id: `${kind}:${callId}`,
      kind,
      label: kind === 'interrupt' ? '도움 AI 작업 중단 요청' : '추가 메시지 전달',
      from: session.agentPath || session.id,
      to: childId || target,
      taskName,
      childId,
      text,
      timestamp: row.timestamp,
    });
  }

  function recordClaudeMessageToolResult(session, state, item, at) {
    const callId = String(item.tool_use_id || '');
    const messageCall = state.claudeMessageCalls.get(callId);
    if (!messageCall) return;
    const output = compactText(item.content || item, 12000);
    const resumed = output.match(/"resumedAgentId"\s*:\s*"([^"]+)"/i)
      || output.match(/\bAgent\s+"([^"]+)"\s+had no active task/i);
    const target = resumed && resumed[1] || messageCall.target;
    updateClaudeSpawn(session, callId, {
      childExternalId: target,
      status: item.is_error === true || /"success"\s*:\s*false/i.test(output)
        ? 'failed'
        : (messageCall.kind === 'interrupt' ? 'cancelled' : 'running'),
      startedAt: at,
    });
  }

  function recordClaudeAgentToolResult(session, state, item, at) {
    const call = state.toolCalls.get(String(item.tool_use_id || ''));
    if (!call) return;
    if (isClaudeMessageTool(call.name)) {
      recordClaudeMessageToolResult(session, state, item, at);
      return;
    }
    if (!isClaudeAgentTool(call.name)) return;
    const output = compactText(item.content || item, 12000);
    const agentId = output.match(/\bagentId:\s*([A-Za-z0-9_-]+)/i);
    const launched = /agent launched successfully|working in the background/i.test(output);
    const failed = item.is_error === true;
    updateClaudeSpawn(session, item.tool_use_id, {
      childExternalId: agentId && agentId[1],
      status: failed ? 'failed' : (launched ? 'running' : 'completed'),
      completedAt: launched ? null : at,
      result: launched ? '' : output,
    });
  }

  function recordClaudeTaskCompletion(session, state, notification, at) {
    if (!notification) return;
    const resultMatch = notification.text.match(/<result>([\s\S]*?)<\/result>/i);
    const messageCall = state.claudeMessageCalls.get(String(notification.toolUseId || ''));
    updateClaudeSpawn(session, notification.toolUseId, {
      childExternalId: notification.taskId,
      status: notification.status === 'completed' ? 'completed' : notification.status,
      completedAt: at,
      result: resultMatch ? resultMatch[1].trim() : '',
      resultCallId: messageCall ? notification.toolUseId : undefined,
    });
  }

  function recordContent(session, state, row, item, index) {
    const kind = item && item.type;
    const id = `${row.uuid || row.requestId || session.externalId}:${index}`;
    if (kind === 'text' && item.text) {
      const text = row.message.role === 'user' ? visibleUserText(item.text) : item.text;
      if (text) {
        addMessage(session, { id, role: row.message.role, text, timestamp: row.timestamp });
        if (row.message.role === 'user') observeActivity(state, 'thinking', row.timestamp);
      }
    } else if (kind === 'tool_use') {
      const name = item.name || 'tool';
      const callId = item.id || id;
      const args = item.input && typeof item.input === 'object' ? item.input : {};
      state.toolCalls.set(String(callId), { name, args });
      if (isClaudeAgentTool(name)) recordClaudeAgentCall(session, state, row, callId, args);
      if (isClaudeMessageTool(name)) recordClaudeMessageCall(session, state, row, callId, args);
      state.executionTracker.recordCall({ name, callId, args, rawInput: item.input, at: row.timestamp });
      observeActivity(state, isUserInputTool(name) ? 'notification' : 'working', row.timestamp);
      addMessage(session, {
        id,
        role: 'tool',
        type: 'tool',
        title: name,
        text: compactText(item.input
          && (item.input.command || item.input.description || item.input.prompt || JSON.stringify(item.input)), 1200),
        status: 'started',
        timestamp: row.timestamp,
      });
      addLifecycle(session, {
        id: `tool:${item.id || id}`,
        type: 'tool',
        label: name,
        detail: compactText(item.input, 260),
        status: 'running',
        timestamp: row.timestamp,
      });
    } else if (kind === 'tool_result') {
      const call = state.toolCalls.get(String(item.tool_use_id || ''));
      state.executionTracker.recordOutput({
        name: call && call.name,
        callId: item.tool_use_id,
        args: call && call.args || {},
        output: item.content || item,
        at: row.timestamp,
        isError: item.is_error === true,
      });
      observeActivity(state, 'working', row.timestamp);
      recordClaudeAgentToolResult(session, state, item, row.timestamp);
      settleLifecycle(session, item.tool_use_id, item.is_error ? 'failed' : 'done', row.timestamp);
      addLifecycle(session, {
        id: `result:${item.tool_use_id || id}`,
        type: 'tool-result',
        label: item.is_error ? '도구 실패' : '도구 완료',
        status: item.is_error ? 'failed' : 'done',
        timestamp: row.timestamp,
      });
    } else if (kind === 'thinking') {
      observeActivity(state, 'thinking', row.timestamp);
      addLifecycle(session, {
        id,
        type: 'reasoning',
        label: '추론',
        status: 'done',
        timestamp: row.timestamp,
      });
    }
  }

  function initializeSession(fileInfo, parsed, options = {}) {
    const basename = path.basename(fileInfo.file, '.jsonl');
    const subMatch = fileInfo.file.match(/[\\/]([^\\/]+)[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/i);
    const externalId = subMatch ? subMatch[2] : basename;
    const session = baseSession('claude', externalId, fileInfo.file, fileInfo);
    session.fullHistory = Boolean(options.fullHistory);
    session.truncated = parsed.truncated;
    session.parentId = subMatch ? `claude:${subMatch[1]}` : null;
    session.depth = subMatch ? 1 : 0;
    session.agentName = subMatch ? `agent-${subMatch[2].slice(0, 8)}` : '';
    const desktopSignals = new Set(parsed.rows.map(row => String(row && row.type || '')).filter(Boolean));
    const entrypoints = new Set(parsed.rows.map(row => String(row && row.entrypoint || '').toLowerCase()).filter(Boolean));
    const cliEntrypoint = [...entrypoints].some(value => /^(?:sdk-)?cli$/.test(value));
    const isDesktop = !subMatch
      && !cliEntrypoint
      && (desktopSignals.has('queue-operation') || desktopSignals.has('last-prompt') || desktopSignals.has('ai-title'));
    session.clientKind = isDesktop ? 'claude-desktop' : 'claude-cli';
    if (isDesktop) session.sourceLabel = 'Claude 데스크톱 앱';
    return session;
  }

  function processMessageRow(session, state, row) {
    const role = row.message.role === 'assistant' ? 'assistant' : 'user';
    const internalUserRow = role === 'user' && Boolean(row.isMeta || row.sourceToolUseID);
    state.lastTurnFinished = false;
    state.lastRole = role;
    if (row.message.model) session.model = row.message.model;
    const content = Array.isArray(row.message.content)
      ? row.message.content
      : [{ type: 'text', text: row.message.content }];
    content.filter(item => item && (!item.type || item.type === 'text'))
      .forEach((item) => {
        const notification = recordTaskNotification(state, typeof item === 'string' ? item : item.text, row.timestamp);
        recordClaudeTaskCompletion(session, state, notification, row.timestamp);
      });
    if (session.depth && role === 'user') state.subagentCompletedAt = null;
    content.forEach((item, index) => {
      if (internalUserRow && (!item.type || item.type === 'text')) return;
      recordContent(session, state, row, item, index);
    });
    if (role === 'user') {
      const toolResults = content.filter(item => item && item.type === 'tool_result');
      toolResults
        .forEach(item => {
          const callId = String(item.tool_use_id || '');
          state.pendingUserInputCalls.delete(callId);
          state.pendingUserInputAt.delete(callId);
          state.pendingUserInputText.delete(callId);
          state.pendingUserInputRequests.delete(callId);
        });
      if (!internalUserRow && toolResults.length === 0) state.failure = null;
      const rawUser = content
        .filter(item => !item.type || item.type === 'text')
        .map(item => typeof item === 'string' ? item : item.text)
        .filter(Boolean)
        .join('\n');
      if (!internalUserRow) {
        const detectedUtility = utilityKind(rawUser);
        if (detectedUtility) session.utilityKind = detectedUtility;
        const visibleUser = visibleUserText(rawUser);
        if (visibleUser) {
          beginObservedTurn(session, state);
          state.pendingUserInputCalls.clear();
          state.pendingUserInputAt.clear();
          state.pendingUserInputText.clear();
          state.pendingUserInputRequests.clear();
          session.utilityKind = '';
          state.latestUser = visibleUser;
          state.lastConversationRole = 'user';
        }
      }
    }
    if (role === 'assistant') {
      const assistantText = compactText(content
        .filter(item => item && item.type === 'text')
        .map(item => item.text)
        .filter(Boolean)
        .join('\n'), 6000);
      if (assistantText) {
        state.lastAssistantText = assistantText;
        state.lastConversationRole = 'assistant';
        observeActivity(state, 'working', row.timestamp);
      }
      content.filter(item => item && item.type === 'tool_use' && isUserInputTool(item.name))
        .forEach(item => {
          const callId = String(item.id || item.name);
          state.pendingUserInputCalls.add(callId);
          if (!state.pendingUserInputAt.has(callId)) state.pendingUserInputAt.set(callId, timestamp(row.timestamp, state.latestTs));
          state.pendingUserInputText.set(callId, structuredInputRequestText(item.input));
          state.pendingUserInputRequests.set(callId, structuredInputRequest(item.input, callId));
        });
      if (String(row.message.stop_reason || '').toLowerCase() === 'end_turn') {
        finishObservedTurn(session, state, row.timestamp);
        if (!structuredFailure(row)) state.failure = null;
      }
    }
    if (role === 'assistant' && row.message.usage) {
      const key = row.requestId || row.message.id || row.uuid;
      const usage = normalizeUsage(row.message.usage);
      const previous = state.requestUsage.get(key);
      if (!previous || usage.total >= previous.total) state.requestUsage.set(key, usage);
      session.turnUsage = usage;
    }
  }

  function beginObservedTurn(session, state) {
    state.lastTurnFinished = false;
    state.subagentCompletedAt = null;
    state.lastAssistantText = '';
    state.lastConversationRole = '';
    session.completedAt = null;
    session.completionObserved = false;
  }

  function finishObservedTurn(session, state, observedAt) {
    const finishedAt = Date.parse(timestamp(observedAt, null) || '');
    if (state.activityAt && Number.isFinite(finishedAt) && finishedAt < state.activityAt) return false;
    state.lastTurnFinished = true;
    if (session.depth) state.subagentCompletedAt = timestamp(observedAt, state.latestTs);
    observeActivity(state, 'attention', observedAt);
    return true;
  }

  function processRows(session, rows) {
    const state = {
      requestUsage: new Map(),
      latestUser: '',
      lastRole: '',
      lastConversationRole: '',
      lastAssistantText: '',
      pendingUserInputCalls: new Set(),
      pendingUserInputAt: new Map(),
      pendingUserInputText: new Map(),
      pendingUserInputRequests: new Map(),
      toolCalls: new Map(),
      executionTracker: createExecutionTracker({ compactText, timestamp }),
      claudeMessageCalls: new Map(),
      latestTs: session.updatedAt,
      lastTurnFinished: false,
      subagentCompletedAt: null,
      failure: null,
      activityState: 'idle',
      activityAt: 0,
    };
    for (const row of rows) {
      state.latestTs = timestamp(row.timestamp, state.latestTs);
      if (row.cwd && !session.originCwd) session.originCwd = row.cwd;
      if (row.cwd && !session.cwd) session.cwd = row.cwd;
      if (row.gitBranch) session.branch = row.gitBranch;
      if (row.agentId && session.depth) session.agentName = row.agentId;
      if (row.type === 'queue-operation' && row.operation === 'enqueue' && row.content) {
        const notification = recordTaskNotification(state, row.content, row.timestamp);
        recordClaudeTaskCompletion(session, state, notification, row.timestamp);
        const detectedUtility = utilityKind(row.content);
        if (detectedUtility) session.utilityKind = detectedUtility;
        const visibleUser = visibleUserText(row.content);
        const queueTitle = /^\//.test(visibleUser)
          ? compactText(visibleUser.split(/\r?\n/)[0], 6000)
          : visibleUser;
        if (queueTitle) {
          beginObservedTurn(session, state);
          state.pendingUserInputCalls.clear();
          state.pendingUserInputAt.clear();
          state.pendingUserInputText.clear();
          state.pendingUserInputRequests.clear();
          session.utilityKind = '';
          state.latestUser = queueTitle;
          state.lastRole = 'user';
          state.lastConversationRole = 'user';
          state.failure = null;
          observeActivity(state, 'thinking', row.timestamp);
        }
      }
      if (row.type === 'last-prompt' && !state.latestUser && row.lastPrompt) {
        const visibleUser = visibleUserText(row.lastPrompt);
        if (visibleUser) {
          state.latestUser = visibleUser;
          observeActivity(state, 'thinking', row.timestamp);
        }
      }
      if (row.type === 'system' && row.subtype === 'init') {
        session.model = row.model || session.model;
        addLifecycle(session, {
          id: row.uuid,
          type: 'session-start',
          label: '작업 시작',
          status: 'done',
          timestamp: row.timestamp,
        });
      }
      if (row.type === 'system' && /turn_duration|turn_complete|stop/i.test(String(row.subtype || ''))) {
        finishObservedTurn(session, state, row.timestamp);
      }
      if (row.message && row.message.role) processMessageRow(session, state, row);
      recordStructuredFailure(session, state, row);
    }
    return state;
  }

  function finalizeSession(session, state, parsed, fileInfo) {
    session.updatedAt = state.latestTs;
    session.startedAt = timestamp(parsed.firstTimestamp, session.updatedAt);
    session.usage = sumUsage([...state.requestUsage.values()]);
    const utilityTitle = session.utilityKind === 'memory-extraction'
      ? 'Claude가 지난 작업 내용을 정리하는 중'
      : (session.utilityKind === 'authentication-check' ? 'Claude 인증 점검' : '');
    session.title = compactText(state.latestUser, 180)
      || utilityTitle
      || (session.depth ? `Claude ${session.agentName}` : 'Claude 작업');
    const currentInput = session.turnUsage.input + session.turnUsage.cachedInput
      + session.turnUsage.cacheWrite + session.turnUsage.output + session.turnUsage.reasoning;
    session.context = contextInfo(currentInput, modelContextWindow('claude', session.model, 0));
    const age = Date.now() - fileInfo.mtimeMs;
    const pendingUserInput = state.pendingUserInputCalls.size > 0;
    const inputRequestId = [...state.pendingUserInputCalls].sort().join('|');
    const inputRequestedAt = inputRequestId
      ? inputRequestId.split('|').map(callId => state.pendingUserInputAt.get(callId)).filter(Boolean).sort().at(0) || null
      : null;
    const inputRequestText = structuredInputRequestText([...state.pendingUserInputCalls]
      .map(callId => state.pendingUserInputText.get(callId))
      .filter(Boolean));
    const inputRequests = [...state.pendingUserInputCalls]
      .sort()
      .flatMap(callId => state.pendingUserInputRequests.get(callId) || []);
    const responseIntent = assistantResponseIntent(state.lastAssistantText);
    session.responseIntent = pendingUserInput
      ? {
        category: 'required', required: true, optional: false,
        requestText: inputRequestText || responseIntent.requestText || '선택 또는 입력이 필요합니다.',
        requestId: inputRequestId, requestedAt: inputRequestedAt,
        requests: inputRequests,
        confidence: 'high', source: 'input-tool',
      }
      : { ...responseIntent, source: responseIntent.category === 'none' ? 'none' : 'assistant-message' };
    if (age >= STALE_TURN_THRESHOLD_MS) {
      for (const record of session.collaboration.spawns) {
        if (record.status === 'running') record.status = 'unverified';
      }
    }
    const activeSubagents = session.collaboration.spawns.filter(record => record.status === 'running');
    if (state.failure) {
      session.status = 'failed';
      session.statusDetail = state.failure.detail;
      session.completedAt = state.failure.at;
      session.statusObserved = true;
    } else if (!session.depth && pendingUserInput) {
      session.status = 'waiting';
      session.statusDetail = '내 답변을 기다리는 중';
    } else if (!session.depth && activeSubagents.length) {
      session.status = 'running';
      session.statusDetail = activeSubagents.length === 1
        ? '도움 AI 작업 진행 중'
        : `도움 AI ${activeSubagents.length}개 작업 진행 중`;
    } else if (state.lastTurnFinished) {
      session.status = 'completed';
      session.statusDetail = '작업 완료';
      session.completedAt = state.subagentCompletedAt || state.latestTs;
      session.completionObserved = true;
      session.statusObserved = false;
      session.result = state.lastAssistantText || session.result;
    } else if (age < STALE_TURN_THRESHOLD_MS && !state.lastTurnFinished) {
      session.status = 'running';
      session.statusDetail = state.lastRole === 'user' ? '응답 생성 중' : '도구 실행 또는 스트리밍 중';
    } else if (state.lastRole === 'user' && age < STALE_TURN_THRESHOLD_MS) {
      // A user-authored row means the AI may still owe a response; it never
      // means the user is blocking the task.
      session.status = 'idle';
      session.statusDetail = 'AI 응답 신호 대기';
    } else {
      session.status = 'idle';
      session.statusDetail = state.lastRole === 'user' ? '마지막 응답 기록이 종료됨' : '다음 요청 대기';
    }
    session.executions = reconcileExecutionActivities(state.executionTracker.finalize(), {
      staleAfterMs: STALE_TURN_THRESHOLD_MS,
      turnFinished: state.lastTurnFinished,
      waitingForUser: session.status === 'waiting',
    });
    session.statusObserved = session.status === 'failed' || age < ACTIVE_THRESHOLD_MS;
    session.activityState = finalizedActivityState({
      status: session.status,
      completionObserved: session.completionObserved,
      pendingInput: pendingUserInput,
      activeSubagents: activeSubagents.length > 0,
      recent: age < STALE_TURN_THRESHOLD_MS,
      observed: state.activityState,
    });
    trimSession(session);
    return session;
  }

  return function parseClaude(fileInfo, options = {}) {
    const parsed = readJsonLines(fileInfo.file, options.maxBytes);
    if (!parsed.rows.length) return null;
    const session = initializeSession(fileInfo, parsed, options);
    const state = processRows(session, parsed.rows);
    return finalizeSession(session, state, parsed, fileInfo);
  };
}

module.exports = { createClaudeParser };
