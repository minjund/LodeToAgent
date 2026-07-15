'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { AgentMonitor, buildSummary } = require('./agentMonitor');
const { TmuxMonitor, linkAgentSessions } = require('./tmuxMonitor');
const { ProcessMonitor, applyRuntimePresence } = require('./processMonitor');

const tmuxMonitor = new TmuxMonitor();
tmuxMonitor.scan();
const processMonitor = new ProcessMonitor();

const monitor = new AgentMonitor({
  runsDir: workerData.runsDir,
  home: workerData.home,
  intervalMs: workerData.intervalMs || 1200,
});

monitor.setAvailability(workerData.availability || {});
let lastFingerprint = '';
let lastPublishedSessions = [];
let currentBridges = [];
const discoveryWatchers = [];

for (const root of [
  path.join(workerData.home, '.claude', 'projects'),
  path.join(workerData.home, '.codex', 'sessions'),
  path.join(workerData.home, '.gemini', 'tmp'),
  path.join(workerData.home, '.grok', 'sessions'),
]) {
  if (!fs.existsSync(root)) continue;
  try {
    const watcher = fs.watch(root, { recursive: process.platform === 'win32' || process.platform === 'darwin' }, (eventType, filename) => {
      if (eventType === 'rename') return monitor.listCache.clear();
      const changed = filename ? path.resolve(root, String(filename)) : '';
      const known = changed && [...monitor.listCache.values()].some(entry => (entry.paths || []).some(file => path.resolve(file) === changed));
      if (!known) monitor.listCache.clear();
    });
    discoveryWatchers.push(watcher);
  } catch {}
}

function clip(value, limit) {
  const text = String(value == null ? '' : value).replace(/\u0000/g, '').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function cardMessage(message) {
  return {
    id: message.id,
    role: message.role,
    type: message.type,
    title: clip(message.title, 80),
    text: clip(message.text, 420),
    status: message.status,
    timestamp: message.timestamp,
  };
}

function cardLifecycle(event) {
  return {
    id: event.id,
    type: event.type,
    label: clip(event.label, 100),
    detail: clip(event.detail, 180),
    status: event.status,
    timestamp: event.timestamp,
  };
}

function selectCardMessages(messages) {
  const list = messages || [];
  const selected = new Set();
  for (const role of ['user', 'assistant', 'tool']) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index] && list[index].role === role) {
        selected.add(index);
        break;
      }
    }
  }
  return [...selected].sort((a, b) => a - b).map(index => cardMessage(list[index]));
}

function cardCollaboration(value) {
  const collaboration = value || {};
  return {
    capacity: collaboration.capacity || { totalThreads: 0, subagents: 0, source: 'unknown' },
    retainedObserved: Boolean(collaboration.retainedObserved),
    retainedAgents: (collaboration.retainedAgents || []).slice(-30).map(agent => ({
      path: clip(agent.path, 180), taskName: clip(agent.taskName, 180), name: clip(agent.name, 120), status: agent.status, observedAt: agent.observedAt,
    })),
    metrics: collaboration.metrics || null,
    spawns: (collaboration.spawns || []).slice(-160).map(record => ({
      callId: record.callId,
      taskName: clip(record.taskName, 180),
      agentPath: clip(record.agentPath, 180),
      childId: record.childId,
      assignment: clip(record.assignment, 1200),
      assignmentObserved: Boolean(record.assignmentObserved),
      assignmentProtected: Boolean(record.assignmentProtected),
      assignmentSource: clip(record.assignmentSource, 80),
      sharedGoal: clip(record.sharedGoal, 1200),
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      result: clip(record.result, 1200),
      agentName: clip(record.agentName, 120),
      currentlyRetained: Boolean(record.currentlyRetained),
      inferred: Boolean(record.inferred),
    })),
    communications: (collaboration.communications || []).slice(-120).map(event => ({
      id: event.id,
      kind: event.kind,
      label: clip(event.label, 100),
      from: clip(event.from, 180),
      to: clip(event.to, 180),
      taskName: clip(event.taskName, 180),
      childId: event.childId,
      text: clip(event.text, 1200),
      protected: Boolean(event.protected),
      assignmentSource: clip(event.assignmentSource, 80),
      timestamp: event.timestamp,
    })),
  };
}

function cardSession(session) {
  return {
    id: session.id,
    externalId: session.externalId,
    provider: session.provider,
    parentId: session.parentId,
    depth: session.depth,
    agentName: session.agentName,
    agentRole: session.agentRole,
    agentPath: session.agentPath || '',
    taskName: session.taskName || '',
    sharedGoal: clip(session.sharedGoal, 1200),
    environment: session.environment,
    title: clip(session.title, 180),
    model: session.model,
    cwd: session.cwd,
    branch: session.branch,
    workspace: session.workspace,
    projectless: Boolean(session.projectless),
    source: session.source,
    sourceLabel: session.sourceLabel,
    clientKind: session.clientKind || '',
    status: session.status,
    statusDetail: clip(session.statusDetail, 180),
    statusObserved: session.statusObserved,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    endedAt: session.endedAt,
    completedAt: session.completedAt,
    completionObserved: Boolean(session.completionObserved),
    result: clip(session.result, 1200),
    delegation: session.delegation ? {
      taskName: clip(session.delegation.taskName, 180),
      assignment: clip(session.delegation.assignment, 1200),
      assignmentObserved: Boolean(session.delegation.assignmentObserved),
      assignmentProtected: Boolean(session.delegation.assignmentProtected),
      assignmentSource: clip(session.delegation.assignmentSource, 80),
      sharedGoal: clip(session.delegation.sharedGoal, 1200),
      result: clip(session.delegation.result, 1200),
      startedAt: session.delegation.startedAt,
      completedAt: session.delegation.completedAt,
      currentlyRetained: Boolean(session.delegation.currentlyRetained),
    } : null,
    truncated: session.truncated,
    runId: session.runId,
    usage: session.usage,
    context: session.context,
    childIds: session.childIds,
    runtimePresence: session.runtimePresence || [],
    collaboration: cardCollaboration(session.collaboration),
    messages: selectCardMessages(session.messages),
    lifecycle: (session.lifecycle || []).slice(-2).map(cardLifecycle),
  };
}

function fingerprint(snapshot, tmux) {
  const sessions = snapshot.sessions.map(session => [
    session.id,
    session.updatedAt,
    session.status,
    session.usage && session.usage.total,
    session.context && session.context.used,
    session.workspace,
    Boolean(session.projectless),
    session.childIds && session.childIds.length,
    session.collaboration && session.collaboration.metrics && Object.values(session.collaboration.metrics).join(':'),
    session.collaboration && session.collaboration.communications && session.collaboration.communications.length,
    session.collaboration && session.collaboration.communications && session.collaboration.communications.at(-1) && session.collaboration.communications.at(-1).id,
    (session.runtimePresence || []).map(item => `${item.id}:${item.pid}:${item.terminalId || ''}`).join(','),
  ]);
  const tmuxState = (tmux.distros || []).flatMap(distro => (distro.sessions || []).flatMap(tmuxSession => (tmuxSession.windows || []).flatMap(window => (window.panes || []).map(pane => [
    distro.name,
    tmuxSession.id,
    window.id,
    pane.id,
    pane.pid,
    pane.command,
    pane.cwd,
    pane.active,
    pane.dead,
    pane.agent && pane.agent.provider,
    pane.agent && pane.agent.linkedSessionId,
    pane.agent && pane.agent.updatedAt,
  ]))));
  return JSON.stringify([sessions, tmuxState]);
}

monitor.on('snapshot', snapshot => {
  const tmuxBase = tmuxMonitor.scan();
  monitor.setHistoryHomes(tmuxMonitor.historyHomes());
  const tmux = linkAgentSessions(tmuxBase, snapshot.sessions);
  const processSnapshot = processMonitor.scan();
  const sessions = applyRuntimePresence(snapshot.sessions, tmux, processSnapshot, Date.now(), currentBridges);
  const runtimeSnapshot = {
    generatedAt: snapshot.generatedAt,
    sessions,
    summary: buildSummary(sessions, monitor.availability),
  };
  const nextFingerprint = fingerprint(runtimeSnapshot, tmux);
  if (nextFingerprint === lastFingerprint) return;
  lastFingerprint = nextFingerprint;
  lastPublishedSessions = sessions;
  parentPort.postMessage({
    type: 'snapshot',
    snapshot: {
      generatedAt: snapshot.generatedAt,
      sessions: sessions.map(cardSession),
      summary: runtimeSnapshot.summary,
      tmux,
      runtime: {
        localProcesses: processSnapshot.processes.length,
        bridgeProcesses: currentBridges.length,
        tmuxProcesses: tmux.summary.aiPanes,
      },
    },
  });
});
parentPort.on('message', message => {
  if (!message) return;
  if (message.type === 'availability') monitor.setAvailability(message.availability || {});
  if (message.type === 'scan') {
    monitor.scanNow();
  }
  if (message.type === 'bridge-presence') {
    currentBridges = Array.isArray(message.bridges) ? message.bridges : [];
    monitor.scanNow();
  }
  if (message.type === 'detail') {
    const runtime = lastPublishedSessions.find(item => item.id === message.sessionId) || null;
    const stored = (monitor.lastSnapshot.sessions || []).find(item => item.id === message.sessionId) || null;
    const session = stored && runtime
      ? { ...stored, status: runtime.status, statusDetail: runtime.statusDetail, statusObserved: runtime.statusObserved, runtimePresence: runtime.runtimePresence || [] }
      : (stored || runtime);
    parentPort.postMessage({ type: 'detail-result', requestId: message.requestId, session });
  }
  if (message.type === 'stop') {
    monitor.stop();
    discoveryWatchers.forEach(watcher => watcher.close());
  }
});
monitor.start();
