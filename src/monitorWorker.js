'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { AgentMonitor, buildSummary } = require('./agentMonitor');
const { TmuxMonitor, linkAgentSessions } = require('./tmuxMonitor');
const { ProcessMonitor, applyRuntimePresence, inferredBridgeBindings } = require('./processMonitor');
const { scanCodexAutomationHomes } = require('./automationMonitor');
const { reportRecoverableError } = require('./diagnostics');
const { enrichSession, enrichSessions } = require('./sessionIntelligence');

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
let currentBridges = Array.isArray(workerData.bridges) ? workerData.bridges : [];
const discoveryWatchers = [];
let scheduledScanTimer = null;

monitor.setPinnedSessions(currentBridges);

function scheduleScan(delayMs = 120) {
  if (scheduledScanTimer) clearTimeout(scheduledScanTimer);
  scheduledScanTimer = setTimeout(() => {
    scheduledScanTimer = null;
    monitor.scanNow();
  }, Math.max(0, Number(delayMs) || 0));
  if (typeof scheduledScanTimer.unref === 'function') scheduledScanTimer.unref();
}

for (const root of [
  path.join(workerData.home, '.claude', 'projects'),
  path.join(workerData.home, '.codex', 'sessions'),
  path.join(workerData.home, '.gemini', 'tmp'),
  path.join(workerData.home, '.grok', 'sessions'),
]) {
  if (!fs.existsSync(root)) continue;
  try {
    const watcher = fs.watch(root, { recursive: process.platform === 'win32' || process.platform === 'darwin' }, (eventType, filename) => {
      if (eventType === 'rename') monitor.listCache.clear();
      const changed = filename ? path.resolve(root, String(filename)) : '';
      const known = changed && [...monitor.listCache.values()].some(entry => (entry.paths || []).some(file => path.resolve(file) === changed));
      if (!known) monitor.listCache.clear();
      scheduleScan();
    });
    discoveryWatchers.push(watcher);
  } catch (error) {
    reportRecoverableError(`session-watch:${root}`, error);
  }
}

function clip(value, limit) {
  const text = String(value == null ? '' : value).replace(/\u0000/g, '').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Creates the compact renderer projection of a provider-neutral session message. */
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
      assignmentContext: clip(record.assignmentContext, 1200),
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

function cardExecutions(value) {
  return (value || []).slice(-120).map(activity => ({
    id: activity.id,
    callId: activity.callId,
    kind: activity.kind,
    mode: activity.mode,
    tool: clip(activity.tool, 80),
    runtime: clip(activity.runtime, 80),
    label: clip(activity.label, 180),
    command: clip(activity.command, 1200),
    cwd: clip(activity.cwd, 360),
    status: activity.status,
    statusDetail: clip(activity.statusDetail, 180),
    output: clip(activity.output, 2400),
    backgroundId: clip(activity.backgroundId, 180),
    backgroundIdType: clip(activity.backgroundIdType, 40),
    exitCode: activity.exitCode == null ? null : Number(activity.exitCode),
    startedAt: activity.startedAt,
    updatedAt: activity.updatedAt,
    completedAt: activity.completedAt,
    source: activity.source,
  }));
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
    originCwd: session.originCwd || session.cwd,
    branch: session.branch,
    workspace: session.workspace,
    projectless: Boolean(session.projectless),
    source: session.source,
    sourceLabel: session.sourceLabel,
    clientKind: session.clientKind || '',
    status: session.status,
    statusDetail: clip(session.statusDetail, 180),
    statusObserved: session.statusObserved,
    responseIntent: session.responseIntent,
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
      assignmentContext: clip(session.delegation.assignmentContext, 1200),
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
    loop: session.loop && typeof session.loop === 'object' ? {
      kind: clip(session.loop.kind, 40),
      iteration: Math.max(0, Number(session.loop.iteration || 0)),
      phase: clip(session.loop.phase, 40),
    } : (session.loop === true ? true : null),
    collaboration: cardCollaboration(session.collaboration),
    executions: cardExecutions(session.executions),
    attention: session.attention,
    progress: session.progress,
    health: session.health,
    controlCapabilities: session.controlCapabilities,
    evidence: session.evidence,
    outcome: session.outcome,
    messages: selectCardMessages(session.messages),
    lifecycle: (session.lifecycle || []).slice(-2).map(cardLifecycle),
  };
}

function fingerprint(snapshot, tmux, automations) {
  const sessions = snapshot.sessions.map(session => [
    session.id,
    session.updatedAt,
    session.status,
    session.usage && session.usage.total,
    session.context && session.context.used,
    session.originCwd,
    session.workspace,
    Boolean(session.projectless),
    session.loop && `${session.loop.kind || ''}:${session.loop.iteration || 0}:${session.loop.phase || ''}`,
    session.childIds && session.childIds.length,
    session.collaboration && session.collaboration.metrics && Object.values(session.collaboration.metrics).join(':'),
    session.collaboration && session.collaboration.communications && session.collaboration.communications.length,
    session.collaboration && session.collaboration.communications && session.collaboration.communications.at(-1) && session.collaboration.communications.at(-1).id,
    (session.executions || []).map(activity => `${activity.id}:${activity.status}:${activity.mode}:${activity.backgroundId || ''}:${activity.updatedAt || ''}`).join(','),
    session.attention && `${session.attention.category}:${session.attention.kind}:${session.attention.required}:${session.attention.actionable}`,
    session.progress && `${session.progress.stage}:${session.progress.percent}:${session.progress.currentStep}`,
    session.health && `${session.health.level}:${session.health.signals.map(signal => signal.code).join(',')}`,
    session.outcome && `${session.outcome.status}:${session.outcome.artifacts.length}:${session.outcome.checks.length}`,
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
    pane.agent && pane.agent.linkAuthority,
    pane.agent && pane.agent.updatedAt,
  ]))));
  const automationState = (automations || []).map(item => [
    item.id, item.name, item.status, item.rrule, item.nextRunAt, item.updatedAt, (item.cwds || []).join('|'),
  ]);
  return JSON.stringify([Math.floor(Date.now() / 60_000), sessions, tmuxState, automationState]);
}

monitor.on('snapshot', snapshot => {
  const tmuxBase = tmuxMonitor.scan();
  const historyHomes = tmuxMonitor.historyHomes();
  monitor.setHistoryHomes(historyHomes);
  const tmux = linkAgentSessions(tmuxBase, snapshot.sessions);
  const processSnapshot = processMonitor.scan();
  const observedAt = Date.now();
  const observedSessions = applyRuntimePresence(snapshot.sessions, tmux, processSnapshot, observedAt, currentBridges);
  const sessions = enrichSessions(observedSessions, observedAt);
  const localKind = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
  const automations = scanCodexAutomationHomes({
    homes: [{ home: workerData.home, kind: localKind, distro: '', label: 'Local' }, ...historyHomes],
    now: new Date(snapshot.generatedAt),
  });
  const runtimeSnapshot = {
    generatedAt: snapshot.generatedAt,
    sessions,
    automations,
    summary: buildSummary(sessions, monitor.availability),
  };
  const nextFingerprint = fingerprint(runtimeSnapshot, tmux, automations);
  if (nextFingerprint === lastFingerprint) return;
  lastFingerprint = nextFingerprint;
  lastPublishedSessions = sessions;
  parentPort.postMessage({
    type: 'snapshot',
    bridgeBindings: inferredBridgeBindings(observedSessions),
    snapshot: {
      generatedAt: snapshot.generatedAt,
      sessions: sessions.map(cardSession),
      automations,
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
    scheduleScan(0);
  }
  if (message.type === 'bridge-presence') {
    currentBridges = Array.isArray(message.bridges) ? message.bridges : [];
    monitor.setPinnedSessions(currentBridges);
    scheduleScan(0);
  }
  if (message.type === 'detail') {
    const runtime = lastPublishedSessions.find(item => item.id === message.sessionId) || null;
    const stored = monitor.detailSession(message.sessionId);
    const merged = stored && runtime
      ? { ...stored, status: runtime.status, statusDetail: runtime.statusDetail, statusObserved: runtime.statusObserved, runtimePresence: runtime.runtimePresence || [] }
      : (stored || runtime);
    const session = enrichSession(merged, lastPublishedSessions, Date.now());
    parentPort.postMessage({ type: 'detail-result', requestId: message.requestId, session });
  }
  if (message.type === 'stop') {
    if (scheduledScanTimer) clearTimeout(scheduledScanTimer);
    scheduledScanTimer = null;
    monitor.stop();
    discoveryWatchers.forEach(watcher => watcher.close());
  }
});
monitor.start();
