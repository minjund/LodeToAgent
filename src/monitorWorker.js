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

function cardSession(session) {
  return {
    id: session.id,
    externalId: session.externalId,
    provider: session.provider,
    parentId: session.parentId,
    depth: session.depth,
    agentName: session.agentName,
    agentRole: session.agentRole,
    environment: session.environment,
    title: clip(session.title, 180),
    model: session.model,
    cwd: session.cwd,
    branch: session.branch,
    workspace: session.workspace,
    source: session.source,
    sourceLabel: session.sourceLabel,
    clientKind: session.clientKind || '',
    status: session.status,
    statusDetail: clip(session.statusDetail, 180),
    statusObserved: session.statusObserved,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    endedAt: session.endedAt,
    truncated: session.truncated,
    runId: session.runId,
    usage: session.usage,
    context: session.context,
    childIds: session.childIds,
    runtimePresence: session.runtimePresence || [],
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
    session.childIds && session.childIds.length,
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
