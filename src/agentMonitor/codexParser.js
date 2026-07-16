'use strict';

const path = require('path');
const { createCodexCollaboration } = require('./codexCollaboration');

const COLLABORATION_TOOLS = new Set([
  'spawn_agent',
  'followup_task',
  'send_message',
  'interrupt_agent',
  'wait_agent',
  'list_agents',
]);

function createCodexParser(dependencies) {
  const {
    thresholds: { ACTIVE_THRESHOLD_MS, STALE_TURN_THRESHOLD_MS },
    sessionOps: {
      addCodexMessage,
      addLifecycle,
      addMessage,
      baseSession,
      settleLifecycle,
      settleRunningLifecycle,
      trimSession,
    },
    textOps: {
      agentEnvelope,
      codexContentText,
      codexVisibleUserText,
      compactText,
      encryptedCollaborationText,
      jsonObject,
    },
    collaborationOps: {
      collaborationCapacity,
      collaborationTaskName,
      retainedAgentsFromValue,
      retainedAgentsFromWorldState,
    },
    usageOps: { codexUsage, contextInfo, modelContextWindow },
    storageOps: { readJsonLines },
    timeOps: { timestamp },
  } = dependencies;

  function initializeSession(fileInfo, parsed) {
    const metaRow = parsed.rows.find(row => row.type === 'session_meta');
    const meta = (metaRow && metaRow.payload) || {};
    const externalId = meta.id
      || meta.session_id
      || path.basename(fileInfo.file, '.jsonl').split('-').slice(-5).join('-');
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
      session.agentPath = spawn.agent_path || meta.agent_path || '';
      session.taskName = collaborationTaskName(session.agentPath);
    }
    return { session, meta };
  }

  function createParseState(session, meta) {
    return {
      latestUser: '',
      latestInternalGoal: '',
      goalContexts: new Set(),
      latestDelegationNarration: '',
      activeTurn: false,
      lastTurnCompleted: false,
      lastFinalAnswer: '',
      latestTs: session.updatedAt,
      observedWindow: Number(meta.context_window || 0),
      messageObservations: new Map(),
      collaboration: createCodexCollaboration(session, { compactText, timestamp }),
      sessionStartedMs: Date.parse(session.startedAt || '') || 0,
    };
  }

  function recordSubagentActivity(session, state, payload, row, timing) {
    const activityMs = Date.parse(timestamp(payload.occurred_at_ms || row.timestamp, session.startedAt)) || timing.rowMs;
    if (!timing.ownCollaborationRow || (session.depth && state.sessionStartedMs && activityMs < state.sessionStartedMs)) return;
    if (session.depth && session.agentPath) {
      const activityPath = String(payload.agent_path || '').replace(/\/$/, '');
      const nestedPrefix = `${String(session.agentPath).replace(/\/$/, '')}/`;
      if (!activityPath.startsWith(nestedPrefix)) return;
    }

    const childId = payload.agent_thread_id ? `codex:${payload.agent_thread_id}` : '';
    const agentPath = payload.agent_path || '';
    let record = state.collaboration.findSpawn({ childId, agentPath });
    if (!record) {
      const fallbackId = `activity:${payload.agent_thread_id || payload.agent_path || payload.event_id}`;
      record = state.collaboration.ensureSpawn(payload.kind === 'started'
        ? (payload.event_id || payload.agent_thread_id)
        : fallbackId);
    }
    record.childId = childId || record.childId;
    record.agentPath = payload.agent_path || record.agentPath;
    record.taskName = record.taskName || collaborationTaskName(record.agentPath);
    record.status = payload.kind === 'started' ? 'running' : (payload.kind || record.status);
    if (payload.kind === 'started' || !record.startedAt) {
      record.startedAt = timestamp(payload.occurred_at_ms || row.timestamp, record.startedAt || session.updatedAt);
    }
    if (payload.kind === 'completed' || payload.kind === 'interrupted') {
      record.completedAt = timestamp(payload.occurred_at_ms || row.timestamp, record.completedAt || session.updatedAt);
    }
    state.collaboration.addCommunication({
      id: `activity:${payload.event_id || payload.agent_thread_id}:${payload.kind}`,
      kind: payload.kind === 'started' ? 'started' : 'status',
      label: payload.kind === 'started' ? '서브에이전트 실행 시작' : '서브에이전트 상태 변경',
      from: 'Codex 런타임',
      to: record.agentPath,
      taskName: record.taskName,
      childId: record.childId,
      text: payload.kind || '',
      timestamp: payload.occurred_at_ms || row.timestamp,
    });
  }

  function processEventMessage(session, state, row, payload, timing) {
    if (payload.type === 'task_started') {
      state.activeTurn = true;
      state.lastTurnCompleted = false;
      state.latestDelegationNarration = '';
      addLifecycle(session, {
        id: payload.turn_id,
        type: 'turn-start',
        label: '턴 시작',
        status: 'running',
        timestamp: payload.started_at || row.timestamp,
      });
    } else if (payload.type === 'task_complete') {
      state.activeTurn = false;
      state.lastTurnCompleted = true;
      settleRunningLifecycle(session, payload.completed_at || row.timestamp);
      session.completedAt = timestamp(payload.completed_at || row.timestamp, session.updatedAt);
      session.completionObserved = true;
      if (payload.last_agent_message) state.lastFinalAnswer = compactText(payload.last_agent_message, 6000);
      addLifecycle(session, {
        id: payload.turn_id,
        type: 'turn-complete',
        label: '턴 완료',
        detail: payload.duration_ms ? `${payload.duration_ms} ms` : '',
        status: 'done',
        timestamp: payload.completed_at || row.timestamp,
      });
    } else if (payload.type === 'sub_agent_activity') {
      recordSubagentActivity(session, state, payload, row, timing);
    } else if (payload.type === 'user_message') {
      const rawUser = compactText(payload.message || payload.text_elements, 12000);
      const text = codexVisibleUserText(rawUser);
      if (!text) return;
      if (/<codex_internal_context(?:\s|>)/i.test(rawUser)) {
        state.latestInternalGoal = text;
        if (/<codex_internal_context[^>]*\bsource=["']goal["']/i.test(rawUser)) state.goalContexts.add(`${row.timestamp || ''}:${text}`);
        return;
      }
      state.latestUser = text;
      const key = `u:${payload.client_id || row.timestamp}:${text}`;
      addCodexMessage(session, state.messageObservations, { id: key, role: 'user', text, timestamp: row.timestamp }, 'event');
    } else if (payload.type === 'agent_message') {
      const text = compactText(payload.message);
      if (text) state.latestDelegationNarration = text;
      if (payload.phase === 'final_answer') state.lastFinalAnswer = text;
      const key = `a:${row.timestamp}:${text}`;
      addCodexMessage(session, state.messageObservations, { id: key, role: 'assistant', text, timestamp: row.timestamp }, 'event');
    } else if (payload.type === 'agent_reasoning') {
      addLifecycle(session, {
        id: `r:${row.timestamp}`,
        type: 'reasoning',
        label: '판단 중',
        detail: '다음 작업을 판단하고 결과를 정리하는 중',
        status: 'running',
        timestamp: row.timestamp,
      });
    } else if (payload.type === 'token_count' && payload.info) {
      session.usage = codexUsage(payload.info.total_token_usage);
      session.turnUsage = codexUsage(payload.info.last_token_usage);
      state.observedWindow = Number(payload.info.model_context_window || state.observedWindow);
    } else if (/failed|error/.test(String(payload.type || ''))) {
      session.status = 'failed';
      session.statusDetail = compactText(payload.message || payload.error || payload.type, 240);
      state.activeTurn = false;
    }
  }

  function recordCollaborationToolCall(session, state, row, name, callId, args) {
    const rawMessage = compactText(args.message, 6000);
    const messageProtected = encryptedCollaborationText(rawMessage);
    if (name === 'spawn_agent') {
      const record = state.collaboration.ensureSpawn(callId);
      record.taskName = compactText(args.task_name, 180);
      record.agentPath = record.taskName
        ? `${session.agentPath || '/root'}/${record.taskName}`.replace(/\/+/g, '/')
        : record.agentPath;
      record.assignmentProtected = messageProtected;
      const directAssignment = rawMessage && !messageProtected ? rawMessage : '';
      record.assignment = directAssignment || (messageProtected ? state.latestDelegationNarration : '');
      record.assignmentObserved = Boolean(record.assignment);
      record.assignmentSource = directAssignment ? 'spawn-message' : (record.assignment ? 'parent-narration' : 'unavailable');
      record.sharedGoal = compactText(state.latestUser, 6000);
      record.startedAt = timestamp(row.timestamp, record.startedAt || session.updatedAt);
      state.collaboration.addCommunication({
        id: `assign:${callId}`,
        kind: 'assignment',
        label: record.assignmentSource === 'parent-narration' ? '메인 AI 작업 지시' : '새 작업 배정',
        from: session.agentPath || '/root',
        to: record.agentPath,
        taskName: record.taskName,
        text: record.assignment,
        protected: record.assignmentProtected && !record.assignment,
        assignmentSource: record.assignmentSource,
        timestamp: row.timestamp,
      });
    } else if (name === 'send_message' || name === 'followup_task') {
      const target = compactText(args.target, 180);
      state.collaboration.addCommunication({
        id: `${name}:${callId}`,
        kind: name === 'followup_task' ? 'followup' : 'message',
        label: name === 'followup_task' ? '추가 작업 지시' : '메시지 전달',
        from: session.agentPath || '/root',
        to: target,
        taskName: collaborationTaskName(target),
        text: messageProtected ? '' : rawMessage,
        protected: messageProtected,
        timestamp: row.timestamp,
      });
    } else if (name === 'interrupt_agent') {
      const target = compactText(args.target, 180);
      state.collaboration.addCommunication({
        id: `interrupt:${callId}`,
        kind: 'interrupt',
        label: '작업 중단 요청',
        from: session.agentPath || '/root',
        to: target,
        taskName: collaborationTaskName(target),
        timestamp: row.timestamp,
      });
    }
    return messageProtected;
  }

  function processToolCall(session, state, row, payload, timing) {
    const name = payload.name || 'tool';
    const callId = payload.call_id || payload.id;
    const args = jsonObject(payload.arguments || payload.input);
    const collaborationTool = payload.namespace === 'collaboration' || COLLABORATION_TOOLS.has(name);
    if (collaborationTool && !timing.ownCollaborationRow) return;
    state.collaboration.calls.set(String(callId || ''), { name, args, timestamp: row.timestamp });

    let collaborationMessageProtected = false;
    if (collaborationTool) {
      collaborationMessageProtected = recordCollaborationToolCall(session, state, row, name, callId, args);
    }
    const protectedToolText = name === 'followup_task' ? '보호된 추가 작업 지시' : '보호된 메시지 전달';
    const toolText = collaborationTool
      ? (name === 'spawn_agent'
        ? `담당 작업: ${args.task_name || '이름 미상'}`
        : (collaborationMessageProtected
          ? protectedToolText
          : compactText(args.message || args.target || '', 1000)))
      : compactText(payload.arguments || payload.input, 1000);
    addMessage(session, {
      id: callId,
      role: 'tool',
      type: 'tool',
      title: name,
      text: toolText,
      status: payload.status || 'started',
      timestamp: row.timestamp,
    });
    addLifecycle(session, {
      id: callId,
      type: collaborationTool ? 'collaboration' : 'tool',
      label: name,
      detail: toolText,
      status: payload.status === 'completed' ? 'done' : 'running',
      timestamp: row.timestamp,
    });
  }

  function processToolOutput(session, state, row, payload) {
    settleLifecycle(session, payload.call_id, 'done', row.timestamp);
    const call = state.collaboration.calls.get(String(payload.call_id || ''));
    const output = jsonObject(payload.output);
    if (call && call.name === 'spawn_agent') {
      const record = state.collaboration.ensureSpawn(payload.call_id);
      record.agentPath = compactText(output.task_name, 180) || record.agentPath;
      record.taskName = record.taskName || collaborationTaskName(record.agentPath);
    }
    if (call && call.name === 'list_agents') {
      session.collaboration.retainedAgents = retainedAgentsFromValue(payload.output)
        .map(agent => ({ ...agent, observedAt: timestamp(row.timestamp, session.updatedAt) }));
      session.collaboration.retainedObserved = true;
    }
    addLifecycle(session, { id: `out:${payload.call_id}`, type: 'tool-result', label: '도구 완료', status: 'done', timestamp: row.timestamp });
  }

  function processAgentMessage(session, state, row, payload, timing) {
    if (!timing.ownCollaborationRow) return;
    const rawText = codexContentText(payload.content);
    const envelope = agentEnvelope(rawText);
    const from = compactText(payload.author || envelope.sender, 180);
    const to = compactText(payload.recipient || envelope.task, 180);
    const taskName = collaborationTaskName(from === (session.agentPath || '/root') ? to : from);
    const kind = envelope.type === 'FINAL_ANSWER' ? 'result' : (envelope.type === 'NEW_TASK' ? 'assignment' : 'message');
    const text = envelope.payload || (envelope.type ? '' : rawText);
    const communication = state.collaboration.addCommunication({
      id: payload.id || `agent-message:${row.timestamp}:${from}:${to}`,
      kind,
      label: kind === 'result' ? '결과 반환' : (kind === 'assignment' ? '작업 전달' : '에이전트 메시지'),
      from,
      to,
      taskName,
      text,
      protected: !text && /encrypted_content/.test(JSON.stringify(payload.content || [])),
      timestamp: row.timestamp,
    });
    if (kind !== 'result') return;
    const record = [...state.collaboration.spawns.values()]
      .find(item => item.agentPath === from || item.taskName === taskName);
    if (!record) return;
    record.status = 'completed';
    record.completedAt = timestamp(row.timestamp, record.completedAt || session.updatedAt);
    record.result = text;
    communication.childId = record.childId;
  }

  function processConversationMessage(session, state, row, payload) {
    if (payload.role === 'developer') {
      const capacity = collaborationCapacity(codexContentText(payload.content));
      if (capacity) session.collaboration.capacity = capacity;
      return;
    }
    if (payload.role !== 'assistant' && payload.role !== 'user') return;
    const role = payload.role;
    const rawText = codexContentText(payload.content);
    const text = role === 'user' ? codexVisibleUserText(rawText) : rawText;
    if (!text) return;
    if (role === 'user' && /<codex_internal_context(?:\s|>)/i.test(rawText)) {
      state.latestInternalGoal = text;
      if (/<codex_internal_context[^>]*\bsource=["']goal["']/i.test(rawText)) state.goalContexts.add(`${row.timestamp || ''}:${text}`);
      return;
    }
    if (role === 'user') state.latestUser = text;
    if (role === 'assistant') state.latestDelegationNarration = text;
    const key = payload.id || `message:${role}:${row.timestamp}:${text.slice(0, 80)}`;
    addCodexMessage(session, state.messageObservations, { id: key, role, text, timestamp: row.timestamp }, 'response');
  }

  function processResponseItem(session, state, row, payload, timing) {
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      processToolCall(session, state, row, payload, timing);
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      processToolOutput(session, state, row, payload);
    } else if (payload.type === 'agent_message') {
      processAgentMessage(session, state, row, payload, timing);
    } else if (payload.type === 'message') {
      processConversationMessage(session, state, row, payload);
    }
  }

  function processRow(session, state, row) {
    state.latestTs = timestamp(row.timestamp, state.latestTs);
    const payload = row.payload || {};
    const rowMs = Date.parse(timestamp(row.timestamp, session.startedAt)) || 0;
    const timing = {
      rowMs,
      ownCollaborationRow: !session.depth || !state.sessionStartedMs || !rowMs || rowMs >= state.sessionStartedMs,
    };
    if (row.type === 'turn_context') {
      session.model = payload.model || session.model;
      session.cwd = payload.cwd || session.cwd;
    } else if (row.type === 'world_state') {
      const retainedText = payload.state && payload.state.environments && payload.state.environments.subagents;
      const retained = retainedAgentsFromWorldState(retainedText, row.timestamp);
      if (retainedText !== undefined) {
        session.collaboration.retainedAgents = retained;
        session.collaboration.retainedObserved = true;
      }
    } else if (row.type === 'event_msg') {
      processEventMessage(session, state, row, payload, timing);
    } else if (row.type === 'response_item') {
      processResponseItem(session, state, row, payload, timing);
    }
  }

  function finalizeSession(session, state, fileInfo) {
    session.updatedAt = state.latestTs;
    session.sharedGoal = session.depth ? compactText(state.latestUser, 6000) : '';
    session.title = session.depth
      ? (session.taskName || `${session.agentName} 서브에이전트`)
      : (compactText(state.latestUser || state.latestInternalGoal, 180) || 'GPT 작업 세션');
    session.result = state.lastFinalAnswer;
    if (!session.depth && state.goalContexts.size) session.loop = { kind: 'goal', iteration: state.goalContexts.size };
    const collaboration = state.collaboration.finalize(session.collaboration.retainedAgents);
    session.collaboration.spawns = collaboration.spawns;
    session.collaboration.communications = collaboration.communications;
    const windowInfo = modelContextWindow('codex', session.model, state.observedWindow);
    session.context = contextInfo(session.turnUsage.total || session.turnUsage.input, windowInfo);

    if (session.status !== 'failed') {
      const turnAge = Date.now() - fileInfo.mtimeMs;
      if (state.activeTurn && turnAge < STALE_TURN_THRESHOLD_MS) {
        session.status = 'running';
        session.statusDetail = '턴 실행 중';
        session.statusObserved = true;
      } else if (session.depth && state.lastTurnCompleted) {
        session.status = 'completed';
        session.statusDetail = '작업 완료';
        session.statusObserved = false;
      } else {
        session.status = 'idle';
        session.statusDetail = state.activeTurn ? '마지막 턴 기록이 종료됨' : '다음 요청 대기';
        session.statusObserved = Date.now() - fileInfo.mtimeMs < ACTIVE_THRESHOLD_MS;
      }
    }
    trimSession(session);
    return session;
  }

  return function parseCodex(fileInfo) {
    const parsed = readJsonLines(fileInfo.file);
    if (!parsed.rows.length) return null;
    const { session, meta } = initializeSession(fileInfo, parsed);
    const state = createParseState(session, meta);
    for (const row of parsed.rows) processRow(session, state, row);
    return finalizeSession(session, state, fileInfo);
  };
}

module.exports = { createCodexParser };
