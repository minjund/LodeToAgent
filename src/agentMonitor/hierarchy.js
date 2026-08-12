'use strict';

function createHierarchyAttacher(dependencies) {
  const {
    addMessage,
    baseSession,
    collaborationTaskName,
    compactText,
    timestamp,
    trimSession,
  } = dependencies;

  function indexExistingRelationships(sessions) {
    const byId = new Map(sessions.map(session => [session.id, session]));
    for (const session of sessions) session.childIds = [];
    for (const session of sessions) {
      if (!session.parentId) continue;
      const parent = byId.get(session.parentId);
      if (parent && !parent.childIds.includes(session.id)) parent.childIds.push(session.id);
    }
    const inheritOrigin = (session, seen = new Set()) => {
      if (!session || !session.parentId || seen.has(session.id)) return;
      seen.add(session.id);
      const parent = byId.get(session.parentId);
      if (!parent) return;
      inheritOrigin(parent, seen);
      const hadOrigin = Boolean(session.originCwd || session.cwd);
      if (!session.cwd) session.cwd = parent.cwd;
      if (!session.originCwd) session.originCwd = parent.originCwd || parent.cwd;
      if (!hadOrigin) {
        session.workspace = parent.workspace;
        session.projectless = parent.projectless;
      }
      if (!session.environment) session.environment = parent.environment;
    };
    for (const session of sessions) inheritOrigin(session);
    return byId;
  }

  function findRecordedChild(sessions, byId, parent, record) {
    if (record.childId && byId.has(record.childId)) return byId.get(record.childId);
    return sessions.find(candidate => candidate.parentId === parent.id
      && ((record.agentPath && candidate.agentPath === record.agentPath)
        || (record.taskName && candidate.taskName === record.taskName)));
  }

  function createHistoryChild(parent, record) {
    const externalId = String(record.childId || `${parent.externalId}:spawn:${record.callId}`).replace(/^(?:codex|claude):/, '');
    const child = baseSession(parent.provider, externalId, '', {
      mtimeMs: Date.parse(record.completedAt || record.startedAt || parent.updatedAt) || Date.now(),
    });
    child.id = record.childId || child.id;
    child.parentId = parent.id;
    child.depth = Number(parent.depth || 0) + 1;
    child.agentPath = record.agentPath;
    child.taskName = record.taskName;
    child.agentName = record.agentName || record.taskName || 'subagent';
    child.title = record.assignmentObserved
      ? compactText(record.assignment, 180)
      : (record.taskName || '도움 AI 작업');
    child.sharedGoal = record.sharedGoal || parent.title;
    child.status = record.status === 'completed' ? 'completed' : (record.status === 'running' ? 'running' : 'idle');
    child.statusDetail = child.status === 'completed'
      ? '작업 완료 기록'
      : (child.status === 'running' ? '실행 시작 관측' : '상태 기록만 확인됨');
    child.startedAt = timestamp(record.startedAt, parent.startedAt);
    child.updatedAt = timestamp(record.completedAt || record.startedAt, parent.updatedAt);
    child.completedAt = timestamp(record.completedAt, null);
    child.completionObserved = child.status === 'completed';
    child.result = record.result || '';
    child.source = 'collaboration-history';
    child.sourceLabel = parent.provider === 'claude' ? 'Claude 도움 AI 활동' : 'Codex 도움 AI 활동';
    child.clientKind = parent.clientKind;
    child.model = parent.model;
    child.cwd = parent.cwd;
    child.originCwd = parent.originCwd || parent.cwd;
    child.workspace = parent.workspace;
    child.projectless = parent.projectless;
    child.environment = parent.environment;
    if (child.result) {
      addMessage(child, {
        id: `${child.id}:result`,
        role: 'assistant',
        text: child.result,
        timestamp: child.completedAt || child.updatedAt,
      });
    }
    trimSession(child);
    return child;
  }

  function resolveChild(sessions, byId, parent, record) {
    const existing = findRecordedChild(sessions, byId, parent, record);
    if (existing) return existing;
    const child = createHistoryChild(parent, record);
    sessions.push(child);
    byId.set(child.id, child);
    return child;
  }

  function connectCommunications(collaboration, record, child) {
    for (const communication of collaboration.communications || []) {
      if (communication.childId) continue;
      if ((record.agentPath && (communication.from === record.agentPath || communication.to === record.agentPath))
        || (record.taskName && communication.taskName === record.taskName)) {
        communication.childId = child.id;
      }
    }
  }

  function synchronizeSpawn(parent, collaboration, retainedByTask, record, child) {
    record.childId = child.id;
    record.agentPath = record.agentPath || child.agentPath;
    record.taskName = record.taskName || child.taskName || collaborationTaskName(child.agentPath);
    record.agentName = child.agentName || record.agentName;
    record.result = record.result || child.result || '';
    const lastSentAt = Date.parse(record.lastSentAt || 0);
    const childCompletedAt = Date.parse(child.completedAt || 0);
    const followupStillNewer = record.status === 'running'
      && Number.isFinite(lastSentAt)
      && (!Number.isFinite(childCompletedAt) || lastSentAt > childCompletedAt);
    if (child.status === 'running' || child.status === 'starting' || followupStillNewer) record.status = 'running';
    else if (child.status === 'completed' || child.completionObserved || record.result) record.status = 'completed';
    if (!record.completedAt && child.completedAt && !followupStillNewer) record.completedAt = child.completedAt;

    const retained = retainedByTask.get(record.taskName);
    record.currentlyRetained = Boolean(retained);
    if (retained && retained.name && (!child.agentName || child.agentName === child.taskName)) {
      child.agentName = retained.name;
    }
    child.taskName = child.taskName || record.taskName;
    child.sharedGoal = child.sharedGoal || record.sharedGoal || parent.title;
    child.delegation = {
      taskName: record.taskName,
      assignment: record.assignment,
      assignmentObserved: record.assignmentObserved,
      assignmentProtected: record.assignmentProtected,
      assignmentSource: record.assignmentSource,
      assignmentContext: record.assignmentContext || '',
      sharedGoal: record.sharedGoal || child.sharedGoal || parent.title,
      result: record.result,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      currentlyRetained: record.currentlyRetained,
    };
    if (!parent.childIds.includes(child.id)) parent.childIds.push(child.id);
    connectCommunications(collaboration, record, child);
  }

  function inferredSpawn(parent, child) {
    return {
      callId: `inferred:${child.id}`,
      taskName: child.taskName || collaborationTaskName(child.agentPath) || child.agentName,
      agentPath: child.agentPath,
      childId: child.id,
      assignment: '',
      assignmentObserved: false,
      assignmentProtected: false,
      assignmentSource: 'unavailable',
      assignmentContext: '',
      sharedGoal: child.sharedGoal || parent.title,
      status: child.status === 'completed' ? 'completed' : (child.status === 'running' ? 'running' : 'idle'),
      startedAt: child.startedAt,
      completedAt: child.completedAt,
      result: child.result || '',
      agentName: child.agentName,
      currentlyRetained: false,
      inferred: true,
    };
  }

  function attachInferredDelegation(parent, child, record) {
    child.delegation = {
      taskName: record.taskName,
      assignment: '',
      assignmentObserved: false,
      assignmentProtected: true,
      assignmentSource: 'unavailable',
      assignmentContext: '',
      sharedGoal: child.sharedGoal || parent.title,
      result: child.result || '',
      startedAt: child.startedAt,
      completedAt: child.completedAt,
      currentlyRetained: false,
    };
  }

  function appendInferredCommunications(parent, collaboration, child, record) {
    const communications = collaboration.communications || (collaboration.communications = []);
    if (communications.some(event => event.childId === child.id)) return;
    communications.push({
      id: `inferred-assignment:${child.id}`,
      kind: 'assignment',
      label: '작업 배정 확인',
      from: parent.agentPath || '/root',
      to: child.agentPath || child.id,
      taskName: record.taskName,
      childId: child.id,
      text: '',
      protected: true,
      timestamp: child.startedAt || parent.updatedAt,
    });
    communications.push({
      id: `inferred-started:${child.id}`,
      kind: 'started',
      label: '도움 AI 작업 시작',
      from: 'Codex AI',
      to: child.agentPath || child.id,
      taskName: record.taskName,
      childId: child.id,
      text: '',
      protected: false,
      timestamp: child.startedAt || parent.updatedAt,
    });
    if (!child.result && child.status !== 'completed') return;
    communications.push({
      id: `inferred-result:${child.id}`,
      kind: 'result',
      label: '결과 반환 확인',
      from: child.agentPath || child.id,
      to: parent.agentPath || '/root',
      taskName: record.taskName,
      childId: child.id,
      text: child.result || '맡은 일을 마치고 담당 AI에게 결과를 보냈습니다.',
      protected: false,
      timestamp: child.completedAt || child.updatedAt,
    });
  }

  function inferUnrecordedChildren(parent, collaboration, byId) {
    for (const childId of parent.childIds) {
      const child = byId.get(childId);
      if (!child || collaboration.spawns.some(record => record.childId === child.id)) continue;
      const record = inferredSpawn(parent, child);
      collaboration.spawns.push(record);
      attachInferredDelegation(parent, child, record);
      appendInferredCommunications(parent, collaboration, child, record);
    }
  }

  function updateMetrics(collaboration) {
    const spawns = collaboration.spawns;
    collaboration.metrics = {
      cumulativeCreated: spawns.length,
      simultaneousCapacity: Number(collaboration.capacity && collaboration.capacity.subagents || 0),
      currentlyRunning: spawns.filter(record => record.status === 'running').length,
      completedRecords: spawns.filter(record => record.status === 'completed').length,
      retainedCount: collaboration.retainedObserved ? (collaboration.retainedAgents || []).length : null,
      capacitySource: collaboration.capacity && collaboration.capacity.source || 'unknown',
      cumulativeSource: spawns.some(record => !record.inferred) ? 'spawn-events' : 'child-sessions',
    };
  }

  function reconcileWorkflowStates(sessions, byId, parents) {
    const protectedStatuses = new Set(['failed', 'waiting', 'paused']);
    const activeStatuses = new Set(['running', 'starting']);
    const parentIds = new Set(parents.map(parent => parent.id));
    const workflowById = new Map();
    const visiting = new Set();

    const reconcile = session => {
      if (workflowById.has(session.id)) return workflowById.get(session.id);
      if (visiting.has(session.id)) return activeStatuses.has(session.status);
      visiting.add(session.id);

      const childWorkflowById = new Map();
      for (const childId of session.childIds || []) {
        const child = byId.get(childId);
        if (child) childWorkflowById.set(childId, reconcile(child));
      }

      if (parentIds.has(session.id)) {
        const collaboration = session.collaboration;
        const retainedByTask = new Map((collaboration.retainedAgents || []).map(agent => [agent.taskName, agent]));
        for (const record of collaboration.spawns || []) {
          const child = record.childId && byId.get(record.childId);
          if (child) synchronizeSpawn(session, collaboration, retainedByTask, record, child);
        }
        updateMetrics(collaboration);
      }

      const runningChildIds = new Set(((session.collaboration && session.collaboration.spawns) || [])
        .filter(record => record.status === 'running' && record.childId)
        .map(record => record.childId));
      const activeChildCount = [...childWorkflowById]
        .filter(([childId, active]) => active || runningChildIds.has(childId))
        .length;
      const hasActiveChildWorkflow = activeChildCount > 0;

      if (hasActiveChildWorkflow && !protectedStatuses.has(session.status)) {
        session.status = 'running';
        session.activityState = 'juggling';
        session.statusDetail = activeChildCount === 1
          ? '도움 AI 작업 진행 중'
          : `도움 AI ${activeChildCount}개 작업 진행 중`;
        session.completionObserved = false;
        session.completedAt = null;
      }

      const workflowActive = activeStatuses.has(session.status) || hasActiveChildWorkflow;
      visiting.delete(session.id);
      workflowById.set(session.id, workflowActive);
      return workflowActive;
    };

    for (const session of sessions) reconcile(session);
  }

  return function attachHierarchy(sessions) {
    const byId = indexExistingRelationships(sessions);
    const parents = sessions.filter(session => session.collaboration
      && ((Array.isArray(session.collaboration.spawns) && session.collaboration.spawns.length)
        || (Array.isArray(session.childIds) && session.childIds.length)));

    for (const parent of parents) {
      const collaboration = parent.collaboration;
      const retainedByTask = new Map((collaboration.retainedAgents || []).map(agent => [agent.taskName, agent]));
      for (const record of collaboration.spawns) {
        const child = resolveChild(sessions, byId, parent, record);
        synchronizeSpawn(parent, collaboration, retainedByTask, record, child);
      }
      inferUnrecordedChildren(parent, collaboration, byId);
    }

    reconcileWorkflowStates(sessions, byId, parents);
  };
}

module.exports = { createHierarchyAttacher };
