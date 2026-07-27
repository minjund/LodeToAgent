'use strict';

const SHELL_TOOLS = new Set([
  'bash',
  'cmd',
  'exec_command',
  'powershell',
  'pwsh',
  'shell',
  'shell_command',
  'terminal',
]);

const CONTINUATION_TOOLS = new Set([
  'bashoutput',
  'taskoutput',
  'wait',
  'write_stdin',
]);

function toolName(value) {
  return String(value || '').trim().toLowerCase().split(/[.:/]/).filter(Boolean).pop() || '';
}

function outputText(value, seen = new Set()) {
  if (typeof value === 'string') return value;
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value == null ? '' : String(value);
  if (seen.has(value)) return '';
  if (typeof value !== 'object') return '';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => outputText(item, seen)).filter(Boolean).join('\n');
  return [
    value.text,
    value.input_text,
    value.output_text,
    value.message,
    value.content,
    value.output,
    value.error,
  ].map(item => outputText(item, seen)).filter(Boolean).join('\n');
}

function quotedProperty(source, key) {
  const pattern = new RegExp(`\\b${key}\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)`, 'm');
  const match = String(source || '').match(pattern);
  if (!match) return '';
  const literal = match[1];
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal);
    } catch (_invalidStringLiteral) {
      return literal.slice(1, -1);
    }
  }
  return literal.slice(1, -1)
    .replace(/\\([\\'`])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function booleanProperty(source, key) {
  const match = String(source || '').match(new RegExp(`\\b${key}\\s*:\\s*(true|false)`, 'i'));
  return match ? match[1].toLowerCase() === 'true' : null;
}

function scalarProperty(source, key) {
  const quoted = quotedProperty(source, key);
  if (quoted) return quoted;
  const match = String(source || '').match(new RegExp(`\\b${key}\\s*:\\s*([A-Za-z0-9._:-]+)`, 'i'));
  return match ? match[1] : '';
}

function nestedToolName(name, rawInput) {
  const normalizedName = toolName(name);
  if (normalizedName !== 'exec') return normalizedName;
  const match = String(rawInput || '').match(/tools\.(exec_command|write_stdin|wait)\s*\(/);
  return match ? match[1] : normalizedName;
}

function executionInput(name, args = {}, rawInput = '') {
  const normalizedName = toolName(name);
  const source = String(rawInput || '');
  const nestedExec = normalizedName === 'exec' && /tools\.exec_command\s*\(/.test(source);
  const shell = SHELL_TOOLS.has(normalizedName) || nestedExec;
  const sandboxPermissions = args.sandbox_permissions || args.sandboxPermissions
    || scalarProperty(source, 'sandbox_permissions') || scalarProperty(source, 'sandboxPermissions');
  const approvalRequired = String(sandboxPermissions || '').toLowerCase() === 'require_escalated';
  const runInBackground = args.run_in_background === true
    || args.background === true
    || args.detach === true
    || booleanProperty(source, 'run_in_background') === true
    || booleanProperty(source, 'background') === true;
  if (!shell && !runInBackground) return null;
  if (/^(?:task|agent|spawn_agent)$/.test(normalizedName)) return null;
  const command = args.command || args.cmd || args.script
    || quotedProperty(source, 'cmd') || quotedProperty(source, 'command');
  const cwd = args.workdir || args.cwd
    || quotedProperty(source, 'workdir') || quotedProperty(source, 'cwd');
  const description = args.description || quotedProperty(source, 'description');
  return {
    kind: shell ? 'shell' : 'background',
    mode: runInBackground ? 'background' : 'foreground',
    command: String(command || ''),
    cwd: String(cwd || ''),
    description: String(description || ''),
    tool: nestedExec ? 'exec_command' : normalizedName,
    approvalRequired,
  };
}

function runtimeLabel(activity) {
  const command = String(activity.command || '');
  const value = `${activity.tool || ''} ${command}`.toLowerCase();
  if (/\bpowershell\b|\bpwsh\b/.test(value)) return 'PowerShell';
  if (/(?:^|[;&|]\s*)(?:get|set|new|start|stop|remove|select|where|resolve|join|test|write|convert(?:to|from)|invoke|format)-[a-z][\w-]*/im.test(command)
    || /\[(?:pscustomobject|system\.[\w.]+)\]/i.test(command)
    || /(?:^|\s)-(?:literalpath|erroraction|expandproperty|windowstyle|passthru)\b/i.test(command)
    || /\.ps1(?:\s|$)/i.test(command)) return 'PowerShell';
  if (/\bcmd(?:\.exe)?\b/.test(value)) return 'Command Prompt';
  if (/\bbash\b/.test(value)) return 'Bash';
  return activity.kind === 'shell' ? 'Shell' : 'Background';
}

function firstCommandLine(value, fallback = '') {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || fallback;
}

function runtimeHandle(value) {
  const text = outputText(value);
  const patterns = [
    { type: 'cell', pattern: /(?:cell(?:\s+id)?|cell_id)[\s:=`"']+([A-Za-z0-9._:-]+)/i },
    { type: 'session', pattern: /(?:session(?:\s+id)?|session_id)[\s:=`"']+([A-Za-z0-9._:-]+)/i },
    { type: 'task', pattern: /(?:background(?:\s+(?:task|command))?(?:\s+with)?(?:\s+id)?|task_id)[\s:=`"']+([A-Za-z0-9._:-]+)/i },
  ];
  for (const candidate of patterns) {
    const match = text.match(candidate.pattern);
    if (match) return { type: candidate.type, id: match[1].replace(/[.,;]+$/, '') };
  }
  return null;
}

function handleFromArgs(args = {}) {
  const values = [
    ['cell', args.cell_id || args.cellId],
    ['session', args.session_id || args.sessionId],
    ['task', args.task_id || args.taskId || args.bash_id || args.shell_id],
  ];
  const found = values.find(([, value]) => value != null && String(value));
  return found ? { type: found[0], id: String(found[1]) } : null;
}

function exitCode(value) {
  const text = outputText(value);
  const match = text.match(/^\s*(?:exit\s+code|exit_code)\s*[:=]\s*(-?\d+)\b/im)
    || text.match(/\b(?:process|command)\s+exited\s+with\s+(?:exit\s+)?code\s+(-?\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function outputStatus(value, explicitError = false) {
  const text = outputText(value);
  const firstLine = text.split(/\r?\n/).map(line => line.trim().toLowerCase()).find(Boolean) || '';
  if (firstLine.startsWith('script failed')) return 'failed';
  if (firstLine.startsWith('script completed')) return 'completed';
  if (firstLine.startsWith('script running')) return 'running';
  const code = exitCode(text);
  if (explicitError || (code != null && code !== 0) || /(?:script|command|process)\s+failed|isError["':\s]+true|fatal error/i.test(text)) return 'failed';
  if (/^(?:command|process)\s+(?:is\s+)?(?:still\s+)?running\b|\brunning\s+in\s+(?:the\s+)?background\b|^background\s+(?:task|command)\b.*\brunning\b|\byielded\b/i.test(firstLine)) return 'running';
  return 'completed';
}

function createExecutionTracker(options = {}) {
  const compactText = options.compactText || (value => String(value || ''));
  const timestamp = options.timestamp || (value => value || null);
  const activities = [];
  const byCallId = new Map();
  const byHandle = new Map();
  const continuations = new Map();

  function registerHandle(activity, handle) {
    if (!activity || !handle || !handle.id) return;
    activity.backgroundId = handle.id;
    activity.backgroundIdType = handle.type;
    activity.mode = 'background';
    byHandle.set(`${handle.type}:${handle.id}`, activity);
    byHandle.set(handle.id, activity);
  }

  function recordCall({ name, callId, args = {}, rawInput = '', at }) {
    const normalizedName = nestedToolName(name, rawInput);
    const effectiveArgs = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
    if (normalizedName === 'wait' && !effectiveArgs.cell_id) effectiveArgs.cell_id = scalarProperty(rawInput, 'cell_id');
    if (normalizedName === 'write_stdin' && !effectiveArgs.session_id) effectiveArgs.session_id = scalarProperty(rawInput, 'session_id');
    if (CONTINUATION_TOOLS.has(normalizedName)) {
      continuations.set(String(callId || ''), { name: normalizedName, args: effectiveArgs });
      return null;
    }
    const input = executionInput(normalizedName, effectiveArgs, rawInput);
    if (!input) return null;
    const startedAt = timestamp(at, null);
    const activity = {
      id: String(callId || `execution:${activities.length}`),
      callId: String(callId || ''),
      kind: input.kind,
      mode: input.mode,
      tool: input.tool,
      runtime: '',
      label: compactText(input.description || firstCommandLine(input.command, input.kind === 'shell' ? '셸 명령' : '백그라운드 작업'), 180),
      command: compactText(input.command, 1200),
      cwd: compactText(input.cwd, 360),
      status: 'running',
      statusDetail: input.mode === 'background' ? '백그라운드 실행 시작' : '포그라운드 실행 시작',
      output: '',
      backgroundId: '',
      backgroundIdType: '',
      exitCode: null,
      startedAt,
      updatedAt: startedAt,
      completedAt: null,
      approvalRequired: input.approvalRequired,
      source: 'tool-call',
    };
    activity.runtime = runtimeLabel(activity);
    activities.push(activity);
    if (activity.callId) byCallId.set(activity.callId, activity);
    const requestedHandle = handleFromArgs(effectiveArgs);
    if (requestedHandle) registerHandle(activity, requestedHandle);
    return activity;
  }

  function findContinuation(args = {}) {
    const handle = handleFromArgs(args);
    if (handle) return byHandle.get(`${handle.type}:${handle.id}`) || byHandle.get(handle.id) || null;
    return [...activities].reverse().find(activity => activity.mode === 'background' && activity.status === 'running') || null;
  }

  function recordOutput({ name, callId, args = {}, output, at, isError = false }) {
    const pendingContinuation = continuations.get(String(callId || ''));
    const normalizedName = pendingContinuation && pendingContinuation.name || toolName(name);
    const effectiveArgs = pendingContinuation && pendingContinuation.args || args;
    const continuation = CONTINUATION_TOOLS.has(normalizedName);
    const activity = continuation ? findContinuation(effectiveArgs) : byCallId.get(String(callId || ''));
    if (!activity) {
      continuations.delete(String(callId || ''));
      return null;
    }
    const status = outputStatus(output, isError);
    const observedOutput = compactText(outputText(output), 2400);
    const argumentHandle = handleFromArgs(effectiveArgs);
    const handle = argumentHandle || (status === 'running' ? runtimeHandle(output) : null);
    if (handle && (status === 'running' || continuation || activity.mode === 'background')) registerHandle(activity, handle);
    const code = exitCode(output);
    activity.status = status;
    if (observedOutput) {
      activity.output = continuation && activity.output
        ? compactText(`${activity.output}\n${observedOutput}`, 2400)
        : observedOutput;
    }
    activity.exitCode = code;
    activity.updatedAt = timestamp(at, activity.updatedAt);
    if (status === 'running') {
      activity.mode = 'background';
      activity.statusDetail = handle && handle.id
        ? `백그라운드 ${handle.type} ${handle.id}`
        : '백그라운드에서 계속 실행 중';
    } else {
      activity.completedAt = activity.updatedAt;
      activity.statusDetail = status === 'failed'
        ? (code == null ? '실행 실패' : `종료 코드 ${code}`)
        : (code == null ? '실행 완료' : `종료 코드 ${code}`);
    }
    continuations.delete(String(callId || ''));
    return activity;
  }

  function finalize(limit = 120) {
    return activities.slice(-limit).map(activity => ({ ...activity }));
  }

  return { activities, recordCall, recordOutput, finalize };
}

function reconcileExecutionActivities(activities = [], options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const staleAfterMs = Math.max(0, Number(options.staleAfterMs || 0));
  const turnSettled = Boolean(options.turnFinished || options.waitingForUser);
  return activities.map((activity) => {
    if (!activity || activity.status !== 'running') return activity;
    const observedAt = Date.parse(activity.updatedAt || activity.startedAt || 0);
    const observationAge = Number.isFinite(observedAt) ? Math.max(0, now - observedAt) : Number.POSITIVE_INFINITY;
    const observationStale = staleAfterMs > 0 && observationAge >= staleAfterMs;
    const foregroundEnded = activity.mode !== 'background' && turnSettled;
    const executionUnobserved = observationStale;
    if (!foregroundEnded && !executionUnobserved) return activity;
    if (activity.approvalRequired) {
      return {
        ...activity,
        status: 'cancelled',
        statusDetail: foregroundEnded
          ? '권한 승인 없이 실행 종료'
          : '권한 승인 요청 만료',
        completedAt: activity.updatedAt || activity.startedAt || null,
      };
    }
    return {
      ...activity,
      status: 'unverified',
      statusDetail: foregroundEnded
        ? '턴 종료 후 실행 상태 미확인'
        : '최근 실행 신호 없음',
      completedAt: null,
    };
  });
}

module.exports = {
  CONTINUATION_TOOLS,
  SHELL_TOOLS,
  createExecutionTracker,
  executionInput,
  outputStatus,
  outputText,
  reconcileExecutionActivities,
  runtimeHandle,
  toolName,
};
