'use strict';

const LIVE_STATUSES = new Set(['starting', 'running']);
const COMPLETE_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const FAILURE_PATTERN = /(?:error|failed|failure|fatal|exception|오류|실패)/i;
const TEST_PATTERN = /(?:^|[^A-Za-z0-9])(?:tests?|testing|specs?|pytest|vitest|jest|mocha)(?=$|[^A-Za-z0-9])|검증|테스트/i;
const FAILED_CHECK_STATUSES = new Set(['failed', 'failure', 'error', 'errored']);
const RUNNING_CHECK_STATUSES = new Set(['running', 'pending', 'started', 'starting', 'in-progress', 'in_progress']);
const PASSED_CHECK_STATUSES = new Set(['passed', 'completed', 'complete', 'done', 'success', 'succeeded']);

function sessionIndex(sessions) {
  return new Map((sessions || []).map(row => [row.id, row]));
}

function text(value, limit = 1200) {
  const output = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return output.length > limit ? `${output.slice(0, limit).trimEnd()}…` : output;
}

function timestamp(value) {
  const parsed = Date.parse(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestActivity(session) {
  const values = [session.updatedAt, session.startedAt];
  for (const row of session.messages || []) values.push(row && row.timestamp);
  for (const row of session.lifecycle || []) values.push(row && (row.completedAt || row.timestamp));
  for (const row of session.executions || []) values.push(row && (row.updatedAt || row.startedAt));
  const millis = Math.max(0, ...values.map(timestamp));
  return millis ? new Date(millis).toISOString() : null;
}

function latestMeaningfulText(session) {
  const messages = [...(session.messages || [])].reverse();
  const latest = messages.find(row => row && text(row.text));
  return text((latest || {}).text || session.statusDetail || session.result || '', 360);
}

function currentResponseIntent(session) {
  const responseIntent = session.responseIntent || {};
  if (responseIntent.source === 'input-tool') return responseIntent;
  const latestConversation = [...(session.messages || [])].reverse().find(row => (
    row
    && (row.role === 'assistant' || row.role === 'user')
    && text(row.text)
  ));
  if (latestConversation?.role !== 'user') return responseIntent;
  // Parsers retain the previous assistant prose so completed turns can still
  // be summarized. Once a newer user turn exists, however, an offer or
  // question from that old prose no longer asks for attention. Keeping it
  // would make the new request look as if the AI had already replied.
  return {
    category: 'none',
    required: false,
    optional: false,
    requestText: '',
    confidence: 'low',
    source: 'none',
  };
}

function checkStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (FAILED_CHECK_STATUSES.has(status)) return 'failed';
  if (RUNNING_CHECK_STATUSES.has(status)) return 'running';
  if (PASSED_CHECK_STATUSES.has(status)) return 'passed';
  return 'unknown';
}

function controlCapabilities(session) {
  if (session.sourcePluginId || session.sourcePlugin?.id) {
    const source = session.sourceControlCapabilities || session.controlCapabilities || {};
    const canSend = Boolean(source.sendInstruction || source.continue || source.respond);
    return {
      managed: Boolean(source.managed),
      respond: Boolean(source.respond == null ? canSend : source.respond),
      approve: Boolean(source.approve),
      deny: Boolean(source.deny),
      sendInstruction: canSend,
      continue: Boolean(source.continue == null ? canSend : source.continue),
      start: Boolean(source.start),
      stop: Boolean(source.stop),
      pause: Boolean(source.pause),
      resume: Boolean(source.resume),
      retry: Boolean(source.retry),
      reassign: Boolean(source.reassign),
      archive: Boolean(source.archive),
      delete: Boolean(source.delete),
      openOrigin: Boolean(source.openOrigin),
      readConversation: Boolean(source.readConversation),
      readSteps: Boolean(source.readSteps),
      readTabs: Boolean(source.readTabs),
      readArtifacts: Boolean(source.readArtifacts),
      live: Boolean(source.live),
      pty: false,
    };
  }
  const live = LIVE_STATUSES.has(session.status);
  const managed = Boolean(session.runId);
  const resumable = Boolean(session.externalId && ['claude', 'codex', 'gemini', 'grok'].includes(session.provider));
  const directlyControllable = (session.runtimePresence || []).some(item => item && (item.terminalId || item.paneId || item.nativeId));
  const canSend = directlyControllable || resumable;
  return {
    managed,
    respond: (session.status === 'waiting' || live) && canSend,
    approve: session.status === 'waiting' && canSend,
    deny: session.status === 'waiting' && canSend,
    sendInstruction: canSend,
    continue: canSend,
    start: false,
    stop: managed && (live || session.status === 'paused'),
    pause: managed && session.status === 'running',
    resume: (managed && session.status === 'paused') || (!live && resumable),
    retry: managed && ['failed', 'cancelled'].includes(session.status),
    reassign: Boolean(session.cwd && (session.title || session.sharedGoal || latestMeaningfulText(session))),
    archive: false,
    delete: false,
    openOrigin: ['claude-desktop', 'codex-desktop'].includes(session.clientKind),
    readConversation: true,
    readSteps: true,
    readTabs: false,
    readArtifacts: true,
    live: true,
    pty: !session.parentId,
  };
}

function evidenceFor(session) {
  const statusObserved = Boolean(session.statusObserved || session.runId || session.runtimePresence?.length);
  const delegation = session.delegation || {};
  const hierarchyObserved = !session.parentId
    || Boolean(delegation.assignmentObserved && delegation.assignmentSource !== 'unavailable')
    || session.source === 'collaboration-history';
  const completionObserved = Boolean(session.completionObserved || (session.runId && COMPLETE_STATUSES.has(session.status)));
  const sources = [session.sourceLabel, statusObserved ? 'runtime-event' : 'activity-inference'];
  if (session.parentId) sources.push(hierarchyObserved ? 'delegation-event' : 'hierarchy-inference');
  if (completionObserved) sources.push('completion-event');
  return {
    confidence: statusObserved && hierarchyObserved ? 'high' : statusObserved || hierarchyObserved ? 'medium' : 'low',
    status: statusObserved ? 'observed' : 'inferred',
    hierarchy: hierarchyObserved ? 'observed' : 'inferred',
    completion: completionObserved ? 'observed' : 'unverified',
    sources: [...new Set(sources.filter(Boolean).map(value => text(value, 80)))],
  };
}

function progressFor(session, attention) {
  const lifecycle = (session.lifecycle || []).filter(Boolean);
  const checkpoints = lifecycle.slice(-12).map((row, index) => ({
    id: String(row.id || `${session.id}:checkpoint:${index}`),
    label: text(row.label || row.type || 'Activity', 140),
    detail: text(row.detail || '', 240),
    status: ['failed', 'error'].includes(row.status) ? 'failed'
      : ['running', 'pending', 'started'].includes(row.status) ? 'running'
        : 'completed',
    timestamp: row.completedAt || row.timestamp || session.updatedAt || null,
  }));
  const completedSteps = checkpoints.filter(row => row.status === 'completed').length;
  const failedSteps = checkpoints.filter(row => row.status === 'failed').length;
  const running = [...checkpoints].reverse().find(row => row.status === 'running');
  const last = checkpoints.at(-1);
  const totalSteps = checkpoints.length;
  let percent = totalSteps ? Math.round(completedSteps / totalSteps * 100) : 0;
  if (session.status === 'completed') percent = 100;
  else if (LIVE_STATUSES.has(session.status) && percent >= 100) percent = 95;
  const stage = session.status === 'completed' ? 'completed'
    : session.status === 'failed' ? 'failed'
      : session.status === 'waiting' ? 'waiting'
        : session.status === 'paused' ? 'paused'
          : LIVE_STATUSES.has(session.status) ? 'executing' : 'idle';
  return {
    stage,
    percent,
    completedSteps,
    failedSteps,
    totalSteps,
    currentStep: text((running || last || {}).label || session.statusDetail || '', 180),
    blocker: attention.actionable ? attention.summary : '',
    lastActivityAt: latestActivity(session),
    source: totalSteps ? 'lifecycle-events' : 'session-status',
    checkpoints,
  };
}

function extractArtifacts(session) {
  const body = [
    session.result,
    ...(session.messages || []).map(row => row && row.text),
    ...(session.lifecycle || []).map(row => row && `${row.label || ''} ${row.detail || ''}`),
  ].filter(Boolean).join('\n');
  const artifacts = [];
  const seen = new Set();
  const add = (kind, value, verified = false) => {
    const clean = text(value, 260).replace(/[),.;:]+$/, '');
    const key = `${kind}:${clean.toLowerCase()}`;
    if (!clean || seen.has(key) || artifacts.length >= 24) return;
    seen.add(key);
    artifacts.push({ kind, value: clean, verified });
  };
  const explicitArtifacts = [
    ...(Array.isArray(session.artifacts) ? session.artifacts : []),
    ...(Array.isArray(session.outcome?.artifacts) ? session.outcome.artifacts : []),
  ];
  for (const artifact of explicitArtifacts) {
    if (artifact == null) continue;
    if (typeof artifact === 'string') {
      add('file', artifact, false);
      continue;
    }
    add(
      artifact.kind || artifact.type || 'file',
      artifact.value || artifact.path || artifact.externalPath || artifact.title || artifact.name,
      Boolean(artifact.verified),
    );
  }
  const filePattern = /(?:[A-Za-z]:\\|\/)?(?:[\w.@-]+[\\/])+[\w.@()+-]+\.[A-Za-z0-9]{1,12}/g;
  for (const match of body.match(filePattern) || []) add(TEST_PATTERN.test(match) ? 'test' : 'file', match, false);
  if (/(?:commit|커밋)/i.test(body)) {
    // A hash mentioned in a log is only a candidate reference. Confirming that
    // the commit exists belongs to repository verification, which this view
    // intentionally does not perform.
    for (const match of body.match(/\b[0-9a-f]{7,40}\b/gi) || []) add('commit', match, false);
  }
  return artifacts;
}

function outcomeFor(session, evidence) {
  const artifacts = extractArtifacts(session);
  const checks = (session.lifecycle || [])
    .filter(row => row && TEST_PATTERN.test(`${row.label || ''} ${row.detail || ''}`))
    .slice(-12)
    .map(row => ({
      label: text(row.label || row.detail || 'Test', 180),
      status: checkStatus(row.status),
      timestamp: row.completedAt || row.timestamp || null,
    }));
  const latestAssistant = [...(session.messages || [])].reverse().find(row => row && row.role === 'assistant' && text(row.text));
  return {
    status: session.status === 'completed' ? 'completed'
      : session.status === 'failed' ? 'failed'
        : session.status === 'cancelled' ? 'cancelled' : 'in-progress',
    summary: text(session.result || (COMPLETE_STATUSES.has(session.status) && latestAssistant && latestAssistant.text) || session.statusDetail || '', 800),
    verified: evidence.completion === 'observed',
    verification: evidence.completion,
    completedAt: session.completedAt || session.endedAt || null,
    artifacts,
    checks,
  };
}

function attentionFor(session) {
  const latest = latestMeaningfulText(session);
  const responseIntent = currentResponseIntent(session);
  const requestText = text(responseIntent.requestText || '', 420);
  const permissionExecution = [...(session.executions || [])].reverse().find(execution => (
    execution
    && execution.approvalRequired === true
    && ['running', 'pending', 'awaiting-approval'].includes(String(execution.status || '').toLowerCase())
  ));
  const permissionRequest = permissionExecution
    ? text(permissionExecution.label || permissionExecution.command || '명령 실행', 320)
    : '';
  let category = 'none';
  let kind = 'none';
  if (session.status === 'failed' || (session.status === 'waiting' && FAILURE_PATTERN.test(session.statusDetail || ''))) {
    category = 'risk';
    kind = 'error';
  } else if (session.status === 'paused') {
    category = 'risk';
    kind = 'paused';
  } else if (permissionExecution) {
    category = 'required';
    kind = 'approval';
  } else if (session.status === 'waiting'
    && (responseIntent.category === 'required' || responseIntent.required === true)
    && responseIntent.source === 'input-tool') {
    category = 'required';
    kind = 'input';
  } else if (responseIntent.category === 'optional') {
    category = 'optional';
    kind = 'optional';
  }
  const required = category === 'required';
  const actionable = required || category === 'risk';
  const summaries = {
    error: session.statusDetail || latest || 'The run failed and needs review.',
    paused: session.statusDetail || 'The run is paused.',
    approval: permissionExecution
      ? permissionRequest || session.statusDetail || latest || 'Approval is required.'
      : requestText || latest || session.statusDetail || 'Approval is required.',
    decision: requestText || latest || session.statusDetail || 'A decision is required.',
    input: requestText || latest || session.statusDetail || 'Input is required.',
    response: requestText || latest || session.statusDetail || 'A response is required.',
    optional: requestText || latest || 'An optional follow-up was offered.',
  };
  return {
    category,
    required,
    actionable,
    kind,
    summary: category !== 'none' ? text(summaries[kind], 420) : '',
    requestId: category === 'required'
      ? text(permissionExecution?.id || responseIntent.requestId || '', 240)
      : '',
    requestedAt: category !== 'none'
      ? (responseIntent.requestedAt || permissionExecution?.startedAt || latestActivity(session))
      : null,
    source: permissionExecution
      ? 'execution-approval'
      : responseIntent.source && responseIntent.source !== 'none'
        ? responseIntent.source
        : session.statusObserved || session.runId ? 'observed-status' : 'message-inference',
    confidence: permissionExecution
      ? 'high'
      : responseIntent.confidence && responseIntent.category !== 'none'
        ? responseIntent.confidence
        : session.statusObserved || session.runId ? 'high' : actionable ? 'medium' : 'low',
  };
}

function healthFor(session, sessions, attention, progress, evidence, nowValue, sessionById = null) {
  const now = Number(nowValue || Date.now());
  const byId = sessionById || sessionIndex(sessions);
  const signals = [];
  const add = (code, severity, detail = '') => signals.push({ code, severity, detail: text(detail, 240) });
  const activity = timestamp(progress.lastActivityAt);
  const ageMs = activity ? Math.max(0, now - activity) : 0;
  if (session.status === 'failed') add('run-failed', 'critical', session.statusDetail);
  if (session.status === 'paused') add('run-paused', 'warning', session.statusDetail);
  if (LIVE_STATUSES.has(session.status) && ageMs >= 10 * 60_000) add('stalled', 'critical', progress.currentStep);
  else if (LIVE_STATUSES.has(session.status) && ageMs >= 2 * 60_000) add('stale', 'warning', progress.currentStep);
  if (session.status === 'waiting' && ageMs >= 60 * 60_000) add('waiting-too-long', 'critical', attention.summary);
  else if (session.status === 'waiting' && ageMs >= 10 * 60_000) add('waiting-too-long', 'warning', attention.summary);
  const contextPercent = Number(session.context && session.context.percent || 0);
  if (contextPercent >= 90) add('context-critical', 'critical', `${contextPercent.toFixed(1)}%`);
  else if (contextPercent >= 75) add('context-warning', 'warning', `${contextPercent.toFixed(1)}%`);
  if (progress.failedSteps >= 2) add('repeated-failures', 'critical', String(progress.failedSteps));
  if (session.parentId && !byId.has(session.parentId)) add('orphan-agent', 'warning', session.parentId);
  if (evidence.confidence === 'low') add('low-confidence', 'info', evidence.sources.join(', '));
  const rank = { info: 1, warning: 2, critical: 3 };
  const max = signals.reduce((value, signal) => Math.max(value, rank[signal.severity] || 0), 0);
  return {
    level: max >= 3 ? 'critical' : max === 2 ? 'warning' : max === 1 ? 'unknown' : 'healthy',
    score: Math.max(0, 100 - signals.reduce((sum, signal) => sum + (signal.severity === 'critical' ? 35 : signal.severity === 'warning' ? 18 : 5), 0)),
    signals,
    lastActivityAt: progress.lastActivityAt,
    ageSeconds: activity ? Math.round(ageMs / 1000) : null,
  };
}

function enrichSession(session, sessions = [], nowValue = Date.now(), sessionById = null) {
  if (!session) return session;
  const responseIntent = currentResponseIntent(session);
  const attention = attentionFor(session);
  const progress = progressFor(session, attention);
  const evidence = evidenceFor(session);
  const controls = controlCapabilities(session);
  const health = healthFor(session, sessions, attention, progress, evidence, nowValue, sessionById);
  return {
    ...session,
    responseIntent,
    attention,
    progress,
    health,
    controlCapabilities: controls,
    evidence,
    outcome: outcomeFor(session, evidence),
  };
}

function enrichSessions(sessions = [], nowValue = Date.now()) {
  const sessionById = sessionIndex(sessions);
  return sessions.map(session => enrichSession(session, sessions, nowValue, sessionById));
}

module.exports = {
  attentionFor,
  controlCapabilities,
  enrichSession,
  enrichSessions,
  evidenceFor,
  extractArtifacts,
  healthFor,
  outcomeFor,
  progressFor,
};
