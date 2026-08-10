'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { PROVIDERS, normalizeProvider, modelContextWindow, blankUsage, finalizeUsage } = require('./providerRegistry');
const { reportRecoverableError, runBestEffort } = require('./diagnostics');
const { pruneManagedRuns, restrictPathPermissions } = require('./dataRetention');

const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_PERSIST_DELAY_MS = 50;
const MAX_AGENT_OUTPUT_LINE_BYTES = 4 * 1024 * 1024;
const DISPOSING_ERROR = '프로그램이 종료 중이므로 새 작업을 시작할 수 없습니다.';

function terminationTimeoutError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  restrictPathPermissions(dir);
}

function runId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function findExecutable(command) {
  const raw = String(command || '');
  if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
  const pathParts = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? ['', '.exe', '.cmd', '.bat'].concat(String(process.env.PATHEXT || '').toLowerCase().split(';'))
    : [''];
  for (const dir of pathParts) {
    for (const ext of [...new Set(extensions)]) {
      const file = path.join(dir.replace(/^"|"$/g, ''), raw + ext);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return '';
}

function probeProviders() {
  const result = {};
  for (const provider of Object.values(PROVIDERS)) result[provider.id] = findExecutable(provider.command);
  return result;
}

function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.renameSync(temp, file); } catch (_renameUnavailable) {
    // Windows can transiently lock the destination; copy-and-clean is the atomic-write fallback.
    try { fs.copyFileSync(temp, file); } finally { runBestEffort('runner-temp-cleanup', () => fs.unlinkSync(temp)); }
  }
  restrictPathPermissions(file);
}

function eventText(value) {
  if (typeof value === 'string') return value.trim();
  if (!value) return '';
  if (Array.isArray(value)) return value.map(eventText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const nested = value.text || value.output_text || value.content || value.message || value.response;
    if (nested != null) return eventText(nested);
    try { return JSON.stringify(value, null, 2); } catch (_circularValue) { return String(value); }
  }
  return String(value);
}

function clip(text, max = 6000) {
  const value = eventText(text).replace(/\u0000/g, '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function makeSession(id, provider, opts) {
  const now = new Date().toISOString();
  const context = modelContextWindow(provider, opts.model, 0);
  return {
    externalId: id,
    provider,
    parentId: opts.parentId || null,
    depth: opts.parentId ? 1 : 0,
    agentName: '',
    agentRole: '',
    title: clip(opts.title || opts.prompt, 140) || `${PROVIDERS[provider].label} 작업`,
    model: opts.model || '',
    cwd: opts.cwd,
    branch: '',
    status: 'starting',
    statusDetail: 'AI 프로그램 시작 중',
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    usage: blankUsage(),
    turnUsage: blankUsage(),
    context: { used: 0, window: context.tokens, percent: 0, source: context.source },
    messages: [{ id: `${id}:prompt`, role: 'user', type: 'message', text: opts.prompt, timestamp: now }],
    lifecycle: [{ id: `${id}:queued`, type: 'queued', label: '실행 준비', detail: provider, status: 'done', timestamp: now }],
    childIds: [],
  };
}

function addMessage(state, role, text, extra = {}) {
  const value = clip(text, extra.type === 'tool' ? 1600 : 8000);
  if (!value && extra.type !== 'tool') return;
  const id = String(extra.id || `${state.externalId}:m:${state.messages.length}`);
  const existing = state.messages.find(item => item.id === id);
  if (existing) {
    if (extra.append) existing.text = clip(`${existing.text}${value}`, 12000);
    else if (value) existing.text = value;
    existing.status = extra.status || existing.status;
    return;
  }
  state.messages.push({
    id,
    role,
    type: extra.type || 'message',
    title: extra.title || '',
    text: value,
    status: extra.status || '',
    timestamp: extra.timestamp || new Date().toISOString(),
  });
  state.messages = state.messages.slice(-220);
}

function addLifecycle(state, type, label, extra = {}) {
  const id = String(extra.id || `${state.externalId}:e:${state.lifecycle.length}`);
  const existing = state.lifecycle.find(item => item.id === id);
  if (existing) {
    existing.status = extra.status || existing.status;
    existing.detail = clip(extra.detail || existing.detail, 600);
    existing.timestamp = extra.timestamp || existing.timestamp;
    return;
  }
  state.lifecycle.push({
    id,
    type,
    label,
    detail: clip(extra.detail, 600),
    status: extra.status || 'done',
    timestamp: extra.timestamp || new Date().toISOString(),
  });
  state.lifecycle = state.lifecycle.slice(-260);
}

function usageFrom(raw = {}) {
  return finalizeUsage({
    input: raw.input_tokens || raw.inputTokenCount || raw.prompt_tokens || raw.promptTokenCount,
    cachedInput: raw.cached_input_tokens || raw.cache_read_input_tokens || raw.cachedContentTokenCount,
    cacheWrite: raw.cache_creation_input_tokens,
    output: raw.output_tokens || raw.outputTokenCount || raw.completion_tokens || raw.candidatesTokenCount,
    reasoning: raw.reasoning_output_tokens || raw.reasoning_tokens || raw.thoughtsTokenCount,
    total: raw.total_tokens || raw.totalTokenCount,
  });
}

function updateContext(state, observedWindow = 0) {
  const info = modelContextWindow(state.provider, state.model, observedWindow || (state.context && state.context.window));
  const used = state.turnUsage.total || state.turnUsage.input || state.usage.total;
  state.context = {
    used,
    window: info.tokens,
    percent: info.tokens ? Math.min(100, used / info.tokens * 100) : 0,
    source: info.source,
  };
}

function setClaudeStreamMessageId(state, id) {
  Object.defineProperty(state, '__claudeStreamMessageId', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: String(id || '').trim(),
  });
}

function handleClaude(state, event) {
  if (event.type === 'system' && event.subtype === 'init') {
    state.externalId = event.session_id || state.externalId;
    state.model = event.model || state.model;
    state.status = 'running';
    state.statusDetail = 'AI 반복 작업 중';
    addLifecycle(state, 'session-start', '작업 시작', { id: 'session-start', status: 'done' });
  }
  if (event.type === 'stream_event') {
    const inner = event.event || {};
    if (inner.type === 'message_start' && inner.message?.id) {
      setClaudeStreamMessageId(state, inner.message.id);
    }
    if (inner.type === 'content_block_delta' && inner.delta && inner.delta.type === 'text_delta') {
      addMessage(state, 'assistant', inner.delta.text, {
        id: state.__claudeStreamMessageId || 'live-answer',
        append: true,
        status: 'streaming',
      });
      state.statusDetail = '응답 스트리밍 중';
    }
    if (inner.type === 'message_delta' && inner.usage) state.turnUsage = usageFrom(inner.usage);
  }
  if (event.type === 'assistant' && event.message) {
    state.model = event.message.model || state.model;
    const blocks = Array.isArray(event.message.content) ? event.message.content : [];
    const messageId = event.message.id || event.uuid || state.__claudeStreamMessageId || 'live-answer';
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).filter(Boolean).join('\n');
    if (text) addMessage(state, 'assistant', text, { id: messageId, status: 'done' });
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        addMessage(state, 'tool', block.input, { id: block.id, type: 'tool', title: block.name, status: 'running' });
        addLifecycle(state, 'tool', block.name || '도구 실행', { id: block.id, status: 'running' });
      }
    }
    if (event.message.usage) state.turnUsage = usageFrom(event.message.usage);
  }
  if (event.type === 'result') {
    state.status = event.is_error ? 'failed' : 'completed';
    state.statusDetail = event.is_error ? (event.result || '실행 실패') : '작업 완료';
    state.endedAt = new Date().toISOString();
    state.usage = usageFrom(event.usage || event);
    if (event.result) {
      const resultText = clip(event.result, 8000);
      const existing = state.messages.find(message => message.role === 'assistant' && clip(message.text, 8000) === resultText);
      if (existing) existing.status = 'done';
      else addMessage(state, 'assistant', resultText, { id: 'final-result', status: 'done' });
    }
    addLifecycle(state, state.status === 'failed' ? 'error' : 'session-end', state.status === 'failed' ? '실행 실패' : '작업 완료', { id: 'session-end', status: state.status === 'failed' ? 'failed' : 'done' });
  }
}

function handleCodex(state, event) {
  if (event.type === 'thread.started') {
    state.externalId = event.thread_id || state.externalId;
    state.status = 'running';
    state.statusDetail = '스레드 시작';
    addLifecycle(state, 'session-start', '스레드 시작', { id: 'session-start' });
  } else if (event.type === 'turn.started') {
    state.status = 'running';
    state.statusDetail = '턴 실행 중';
    addLifecycle(state, 'turn-start', '턴 시작', { id: `turn:${state.lifecycle.length}`, status: 'running' });
  } else if (event.type === 'item.started' || event.type === 'item.completed' || event.type === 'item.updated') {
    const item = event.item || {};
    const done = event.type === 'item.completed';
    if (item.type === 'agent_message') addMessage(state, 'assistant', item.text, { id: item.id, status: done ? 'done' : 'streaming' });
    else if (item.type === 'reasoning') addLifecycle(state, 'reasoning', '추론', { id: item.id, status: done ? 'done' : 'running' });
    else {
      const title = item.command || item.name || item.type || '작업 항목';
      addMessage(state, 'tool', item.command || item.text || item.arguments || title, { id: item.id, type: 'tool', title, status: done ? 'done' : 'running' });
      addLifecycle(state, 'tool', clip(title, 100), { id: item.id, status: done ? 'done' : 'running' });
    }
  } else if (event.type === 'turn.completed') {
    state.status = 'completed';
    state.statusDetail = '작업 완료';
    state.endedAt = new Date().toISOString();
    state.usage = usageFrom(event.usage);
    state.turnUsage = state.usage;
    addLifecycle(state, 'turn-complete', '턴 완료', { id: 'turn-complete', status: 'done' });
  } else if (event.type === 'turn.failed' || event.type === 'error') {
    state.status = 'failed';
    state.statusDetail = clip(event.message || event.error || 'Codex 실행 실패', 240);
    state.endedAt = new Date().toISOString();
    addLifecycle(state, 'error', '실행 실패', { id: 'run-error', detail: state.statusDetail, status: 'failed' });
  }
}

function handleGemini(state, event) {
  const type = String(event.type || '').toLowerCase();
  if (type === 'init') {
    state.externalId = event.session_id || event.sessionId || state.externalId;
    state.model = event.model || state.model;
    state.status = 'running';
    state.statusDetail = '작업 시작';
    addLifecycle(state, 'session-start', '작업 시작', { id: 'session-start' });
  } else if (type === 'message') {
    const role = /assistant|model/.test(String(event.role || event.author || '').toLowerCase()) ? 'assistant' : 'user';
    addMessage(state, role, event.content || event.text || event.message, { id: event.id, status: event.delta ? 'streaming' : 'done' });
    state.statusDetail = role === 'assistant' ? '응답 스트리밍 중' : '요청 처리 중';
  } else if (type === 'tool_use') {
    const name = event.tool_name || event.name || '도구 실행';
    addMessage(state, 'tool', event.parameters || event.args, { id: event.id, type: 'tool', title: name, status: 'running' });
    addLifecycle(state, 'tool', name, { id: event.id, status: 'running' });
  } else if (type === 'tool_result') {
    addLifecycle(state, 'tool-result', '도구 완료', { id: `result:${event.id || event.tool_id}`, status: event.error ? 'failed' : 'done' });
  } else if (type === 'result') {
    state.usage = usageFrom(event.stats || event.usage || event);
    state.turnUsage = state.usage;
    state.status = event.error ? 'failed' : 'completed';
    state.statusDetail = event.error ? clip(event.error, 220) : '작업 완료';
    state.endedAt = new Date().toISOString();
    addLifecycle(state, 'session-end', state.status === 'failed' ? '실행 실패' : '작업 완료', { id: 'session-end', status: state.status === 'failed' ? 'failed' : 'done' });
  } else if (type === 'error') {
    addLifecycle(state, 'error', '경고 또는 오류', { id: event.id, detail: event.message || event.error, status: 'failed' });
  }
}

function handleGrok(state, event) {
  const type = String(event.type || event.event || event.kind || '').toLowerCase();
  const sessionId = event.session_id || event.sessionId;
  if (sessionId) state.externalId = sessionId;
  if (event.model) state.model = event.model;
  if (/init|session_start|started/.test(type)) {
    state.status = 'running';
    state.statusDetail = '작업 진행 중';
    addLifecycle(state, 'session-start', '작업 시작', { id: 'session-start' });
  }
  if (/message|agent_message|assistant/.test(type)) {
    const role = /user/.test(String(event.role || '')) ? 'user' : 'assistant';
    addMessage(state, role, event.text || event.content || event.message || event.delta, { id: event.id, status: event.delta ? 'streaming' : 'done' });
  }
  if (/tool.*(?:start|use|call)/.test(type)) {
    const name = event.tool_name || event.name || event.tool || '도구 실행';
    addMessage(state, 'tool', event.input || event.args || event.parameters, { id: event.id, type: 'tool', title: name, status: 'running' });
    addLifecycle(state, 'tool', name, { id: event.id, status: 'running' });
  }
  if (/tool.*(?:result|end|complete)/.test(type)) addLifecycle(state, 'tool-result', '도구 완료', { id: `result:${event.id || event.tool_call_id}`, status: event.error ? 'failed' : 'done' });
  const usage = usageFrom(event.usage || event.stats || {});
  if (usage.total) state.turnUsage = usage;
  if (/result|session_end|completed|done/.test(type)) {
    state.usage = usage.total ? usage : state.turnUsage;
    state.status = event.error ? 'failed' : 'completed';
    state.statusDetail = event.error ? clip(event.error, 220) : '작업 완료';
    state.endedAt = new Date().toISOString();
    addLifecycle(state, 'session-end', state.status === 'failed' ? '실행 실패' : '작업 완료', { id: 'session-end', status: state.status === 'failed' ? 'failed' : 'done' });
  }
}

function commandSpec(provider, opts, executable) {
  const prompt = opts.prompt;
  if (provider === 'claude') {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.allowWrites) args.push('--permission-mode', 'acceptEdits');
    return { command: executable, args };
  }
  if (provider === 'codex') {
    const args = ['exec', '--json', '--sandbox', opts.allowWrites ? 'workspace-write' : 'read-only', '-C', opts.cwd];
    if (opts.model) args.push('--model', opts.model);
    args.push(prompt);
    return { command: executable, args };
  }
  if (provider === 'gemini') {
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.allowWrites) args.push('--yolo');
    return { command: executable, args };
  }
  const args = ['--no-auto-update', '-p', prompt, '--cwd', opts.cwd, '--output-format', 'streaming-json'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.allowWrites) args.push('--always-approve');
  return { command: executable, args };
}

function signalPosixProcessTree(pidValue, signal, killProcess = process.kill) {
  const pid = Number(pidValue);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('실행 중인 프로그램의 PID가 올바르지 않습니다.');
  try {
    killProcess(-pid, signal);
    return { group: true, pid, signal };
  } catch (groupError) {
    try {
      killProcess(pid, signal);
      return { group: false, pid, signal };
    } catch (processError) {
      if (!processError.cause) processError.cause = groupError;
      throw processError;
    }
  }
}

class AgentRunner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.runsDir = options.runsDir;
    this.active = new Map();
    this.platform = options.platform || process.platform;
    this.spawn = options.spawn || spawn;
    this.execFile = options.execFile || execFile;
    this.killProcess = options.killProcess || process.kill;
    const terminationGraceMs = Number(options.terminationGraceMs);
    this.terminationGraceMs = Number.isFinite(terminationGraceMs) && terminationGraceMs >= 0
      ? Math.min(terminationGraceMs, 30_000)
      : DEFAULT_TERMINATION_GRACE_MS;
    const persistDelayMs = Number(options.persistDelayMs);
    this.persistDelayMs = Number.isFinite(persistDelayMs) && persistDelayMs >= 0
      ? Math.min(persistDelayMs, 1_000)
      : DEFAULT_PERSIST_DELAY_MS;
    this.disposing = false;
    this.disposePromise = null;
    ensureDir(this.runsDir);
    pruneManagedRuns(this.runsDir, {
      retentionDays: options.retentionDays,
      now: options.now,
    });
  }

  listActive() {
    return [...this.active.values()].map(item => ({ runId: item.id, provider: item.provider, pid: item.child.pid, externalId: item.state.externalId }));
  }

  prepareForUpdate(confirmedRuns = []) {
    if (this.disposing) throw new Error(DISPOSING_ERROR);
    const confirmedIds = new Set((Array.isArray(confirmedRuns) ? confirmedRuns : [])
      .map(run => String(run && (run.runId || run.id) || ''))
      .filter(Boolean));
    const active = this.listActive();
    if (active.some(run => !confirmedIds.has(run.runId))) {
      throw new Error('업데이트 준비 중 새 직접 실행 작업이 시작되었습니다. 상태를 확인한 뒤 다시 시도해 주세요.');
    }
    this.disposing = true;
    return { active: active.length };
  }

  resumeAfterUpdateFailure() {
    if (this.disposePromise) return false;
    this.disposing = false;
    return true;
  }

  start(raw = {}) {
    if (this.disposing) return { ok: false, error: DISPOSING_ERROR };
    const provider = normalizeProvider(raw.provider);
    const prompt = String(raw.prompt || '').trim();
    const cwd = path.resolve(String(raw.cwd || process.cwd()));
    if (!prompt) return { ok: false, error: '작업 내용을 입력하세요.' };
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { ok: false, error: '작업 폴더를 찾을 수 없습니다.' };
    const executable = findExecutable(PROVIDERS[provider].command);
    if (!executable) return { ok: false, error: `${PROVIDERS[provider].label} AI 프로그램이 설치되어 있지 않습니다.` };

    const id = runId();
    const dir = path.join(this.runsDir, id);
    ensureDir(dir);
    const opts = { ...raw, provider, prompt, cwd };
    const state = makeSession(id, provider, opts);
    const meta = { id, provider, prompt, cwd, model: raw.model || '', allowWrites: !!raw.allowWrites, createdAt: state.startedAt };
    atomicJson(path.join(dir, 'meta.json'), meta);
    atomicJson(path.join(dir, 'session.json'), state);
    const spec = commandSpec(provider, opts, executable);

    let child;
    try {
      child = this.spawn(spec.command, spec.args, {
        cwd,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        detached: this.platform !== 'win32',
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      state.status = 'failed';
      state.statusDetail = error.message;
      atomicJson(path.join(dir, 'session.json'), state);
      return { ok: false, error: error.message };
    }

    const run = {
      id, provider, dir, child, state, stdoutBuffer: '', stderrBuffer: '', stopping: false,
      processGroup: this.platform !== 'win32',
      pendingEventLines: [], persistTimer: null, outputOverflow: false,
    };
    this.active.set(id, run);
    state.status = 'running';
    state.statusDetail = '자세한 활동 기록 연결됨';
    addLifecycle(state, 'process-start', 'AI 프로그램 시작', { id: 'process-start', detail: '프로그램 실행 중', status: 'running' });
    this.persist(run);

    child.stdout.on('data', chunk => this.consume(run, 'stdout', chunk));
    child.stderr.on('data', chunk => this.consume(run, 'stderr', chunk));
    child.on('error', error => this.handleChildError(run, error));
    child.on('close', (code, signal) => {
      run.closed = true;
      run.closeCode = code;
      run.closeSignal = signal;
      if (run.disposing || run.finalized) return;
      this.flush(run, 'stdout');
      this.flush(run, 'stderr');
      if (run.stopping) {
        state.status = 'cancelled';
        state.statusDetail = '사용자가 중지함';
      } else if (state.status === 'running' || state.status === 'starting' || state.status === 'paused') {
        state.status = code === 0 ? 'completed' : 'failed';
        state.statusDetail = code === 0 ? '작업 완료' : 'AI 프로그램 실행 실패';
      }
      state.endedAt = new Date().toISOString();
      addLifecycle(state, 'process-end', state.status === 'completed' ? '프로그램 실행 완료' : (state.status === 'cancelled' ? '프로그램 실행 중지' : '프로그램 실행 실패'), { id: 'process-end', detail: state.statusDetail, status: state.status === 'completed' ? 'done' : 'failed' });
      this.persist(run);
      this.active.delete(id);
      this.emit('changed', { runId: id, state });
    });

    this.emit('changed', { runId: id, state });
    return { ok: true, runId: id, sessionId: state.externalId, pid: child.pid };
  }

  consume(run, stream, chunk) {
    if (!run || run.finalized || run.outputOverflow) return;
    const key = `${stream}Buffer`;
    run[key] += chunk.toString('utf8');
    let index;
    while ((index = run[key].indexOf('\n')) >= 0) {
      const rawLine = run[key].slice(0, index);
      run[key] = run[key].slice(index + 1);
      if (Buffer.byteLength(rawLine, 'utf8') > MAX_AGENT_OUTPUT_LINE_BYTES) {
        this.handleOutputOverflow(run, stream);
        return;
      }
      const line = rawLine.trim();
      if (line) this.handleLine(run, stream, line);
    }
    if (Buffer.byteLength(run[key], 'utf8') > MAX_AGENT_OUTPUT_LINE_BYTES) {
      this.handleOutputOverflow(run, stream);
    }
  }

  flush(run, stream) {
    const key = `${stream}Buffer`;
    if (Buffer.byteLength(run[key], 'utf8') > MAX_AGENT_OUTPUT_LINE_BYTES) {
      this.handleOutputOverflow(run, stream);
      return;
    }
    const line = run[key].trim();
    run[key] = '';
    if (line) this.handleLine(run, stream, line);
  }

  handleOutputOverflow(run, stream) {
    if (!run || run.finalized || run.outputOverflow) return;
    run.outputOverflow = true;
    run.stdoutBuffer = '';
    run.stderrBuffer = '';
    run.state.status = 'failed';
    run.state.statusDetail = 'AI 프로그램 출력 한 줄이 안전한 크기를 초과했습니다.';
    run.state.endedAt = new Date().toISOString();
    run.state.updatedAt = run.state.endedAt;
    addLifecycle(run.state, 'error', 'AI 프로그램 출력 중단', {
      id: 'output-overflow',
      detail: `${stream} 출력 한 줄이 ${MAX_AGENT_OUTPUT_LINE_BYTES.toLocaleString()}바이트 제한을 초과했습니다.`,
      status: 'failed',
    });
    try {
      this.persist(run);
    } catch (error) {
      reportRecoverableError('agent-runner-output-overflow-persist', error);
    }
    try {
      if (this.platform === 'win32') {
        this.execFile('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true }, error => {
          if (error) reportRecoverableError('runner-output-overflow-taskkill', error);
        });
      } else {
        this.signalRun(run, 'SIGKILL');
      }
    } catch (error) {
      reportRecoverableError('runner-output-overflow-terminate', error);
    }
    this.emit('changed', { runId: run.id, state: run.state });
  }

  handleLine(run, stream, line) {
    if (!run || run.finalized) return;
    let event = null;
    try { event = JSON.parse(line); } catch (_plainOutputLine) { event = null; } // Plain stderr/stdout lines are valid runner output.
    const eventLine = `${JSON.stringify({ timestamp: new Date().toISOString(), stream, event, text: event ? undefined : clip(line, 4000) })}\n`;
    if (event) {
      if (run.provider === 'claude') handleClaude(run.state, event);
      else if (run.provider === 'codex') handleCodex(run.state, event);
      else if (run.provider === 'gemini') handleGemini(run.state, event);
      else handleGrok(run.state, event);
    } else if (stream === 'stderr') {
      addLifecycle(run.state, 'log', 'AI 프로그램 상태', { detail: clip(line, 500), status: 'running' });
      if (/error|failed|fatal/i.test(line)) run.state.statusDetail = clip(line, 240);
    }
    run.state.updatedAt = new Date().toISOString();
    updateContext(run.state);
    this.schedulePersist(run, eventLine);
    this.emit('changed', { runId: run.id, state: run.state });
  }

  handleChildError(run, error) {
    if (!run || run.finalized) return;
    run.state.status = 'failed';
    run.state.statusDetail = error.message;
    addLifecycle(run.state, 'error', '실행 중인 프로그램 오류', {
      id: 'process-error', detail: error.message, status: 'failed',
    });
    this.persist(run);
  }

  schedulePersist(run, eventLine = '') {
    if (eventLine) {
      if (!Array.isArray(run.pendingEventLines)) run.pendingEventLines = [];
      run.pendingEventLines.push(eventLine);
    }
    if (run.persistTimer) return;
    run.persistTimer = setTimeout(() => {
      run.persistTimer = null;
      try {
        this.persist(run);
      } catch (error) {
        reportRecoverableError(`agent-runner-persist:${run.id}`, error);
      }
    }, this.persistDelayMs);
  }

  persist(run) {
    if (run.persistTimer) {
      clearTimeout(run.persistTimer);
      run.persistTimer = null;
    }
    const pendingEventLines = Array.isArray(run.pendingEventLines) ? run.pendingEventLines : [];
    if (pendingEventLines.length) {
      fs.appendFileSync(path.join(run.dir, 'events.jsonl'), pendingEventLines.join(''), 'utf8');
      pendingEventLines.length = 0;
    }
    atomicJson(path.join(run.dir, 'session.json'), run.state);
  }

  signalRun(run, signal) {
    return signalPosixProcessTree(run && run.child && run.child.pid, signal, this.killProcess);
  }

  stop(id) {
    const run = this.active.get(String(id || ''));
    if (!run) return { ok: false, error: '실행 중인 작업을 찾을 수 없습니다.' };
    run.stopping = true;
    run.state.statusDetail = '중지 요청 중';
    this.persist(run);
    if (this.platform === 'win32') {
      this.execFile('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      if (run.state.status === 'paused') runBestEffort('runner-stop-resume', () => this.signalRun(run, 'SIGCONT'));
      try {
        this.signalRun(run, 'SIGTERM');
      } catch (error) {
        run.state.statusDetail = '중지 요청을 전달하지 못함';
        addLifecycle(run.state, 'error', '프로그램 중지 실패', {
          id: `stop-error:${Date.now()}`, detail: error.message, status: 'failed',
        });
        this.persist(run);
        return { ok: false, error: error.message };
      }
    }
    return { ok: true };
  }

  retry(id) {
    if (this.disposing) return { ok: false, error: DISPOSING_ERROR };
    const runIdValue = String(id || '');
    if (!/^[a-z0-9-]{4,120}$/i.test(runIdValue)) return { ok: false, error: '다시 시작할 작업 정보가 올바르지 않습니다.' };
    if (this.active.has(runIdValue)) return { ok: false, error: '아직 실행 중인 작업은 다시 실행할 수 없습니다.' };
    const file = path.join(this.runsDir, runIdValue, 'meta.json');
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_unavailableRunMetadata) {
      return { ok: false, error: '이전 실행 설정을 찾을 수 없습니다.' };
    }
    const result = this.start({
      provider: meta.provider,
      prompt: meta.prompt,
      cwd: meta.cwd,
      model: meta.model,
      allowWrites: Boolean(meta.allowWrites),
    });
    return result && result.ok ? { ...result, retriedFrom: runIdValue } : result;
  }

  setPaused(id, paused) {
    const run = this.active.get(String(id || ''));
    if (!run) return Promise.resolve({ ok: false, error: '실행 중인 작업을 찾을 수 없습니다.' });
    if (paused && run.state.status === 'paused') return Promise.resolve({ ok: true, status: 'paused' });
    if (!paused && run.state.status !== 'paused') return Promise.resolve({ ok: true, status: run.state.status });
    const applyState = () => {
      if (run.finalized) return { ok: false, error: '이미 종료된 작업은 상태를 바꿀 수 없습니다.' };
      run.state.status = paused ? 'paused' : 'running';
      run.state.statusDetail = paused ? '사용자가 실행을 일시정지함' : '사용자가 실행을 다시 시작함';
      addLifecycle(run.state, paused ? 'process-pause' : 'process-resume', paused ? '실행 일시정지' : '실행 다시 시작', {
        id: `${paused ? 'pause' : 'resume'}:${Date.now()}`,
        status: paused ? 'done' : 'running',
      });
      run.state.updatedAt = new Date().toISOString();
      this.persist(run);
      this.emit('changed', { runId: run.id, state: run.state });
      return { ok: true, status: run.state.status };
    };
    if (this.platform !== 'win32') {
      try {
        this.signalRun(run, paused ? 'SIGSTOP' : 'SIGCONT');
        return Promise.resolve(applyState());
      } catch (error) {
        return Promise.resolve({ ok: false, error: error.message });
      }
    }
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = `${paused ? 'Suspend' : 'Resume'}-Process -Id ${Number(run.child.pid)} -ErrorAction Stop`;
    return new Promise(resolve => {
      this.execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, error => {
        resolve(error ? { ok: false, error: error.message } : applyState());
      });
    });
  }

  pause(id) {
    return this.setPaused(id, true);
  }

  resume(id) {
    return this.setPaused(id, false);
  }

  closeWaiter(run) {
    if (run.closed) return { promise: Promise.resolve(true), cancel: () => {} };
    let timer = null;
    let settled = false;
    let resolveWait;
    const child = run.child;
    const onClose = () => finish(true);
    const finish = closed => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child && typeof child.removeListener === 'function') child.removeListener('close', onClose);
      resolveWait(closed);
    };
    const promise = new Promise(resolve => {
      resolveWait = resolve;
      if (!child || typeof child.once !== 'function') {
        finish(false);
        return;
      }
      child.once('close', onClose);
      timer = setTimeout(() => finish(false), this.terminationGraceMs);
    });
    return { promise, cancel: () => finish(false) };
  }

  runWindowsTaskkill(run) {
    return new Promise(resolve => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(error || null);
      };
      const timer = setTimeout(() => finish(terminationTimeoutError(
        'Windows taskkill 응답 대기 시간이 초과되었습니다.',
        'TASKKILL_TIMEOUT',
      )), this.terminationGraceMs);
      try {
        this.execFile('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: this.terminationGraceMs,
        }, finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  async terminateWindowsRun(run) {
    const errors = [];
    const taskkillError = await this.runWindowsTaskkill(run);
    if (taskkillError) errors.push(taskkillError);
    const forcedClose = this.closeWaiter(run);
    const closed = await forcedClose.promise;
    if (!closed) {
      errors.push(terminationTimeoutError(
        'Windows taskkill 이후 프로그램 종료를 확인하지 못했습니다.',
        'TASKKILL_CLOSE_TIMEOUT',
      ));
    }
    return errors;
  }

  async terminatePosixRun(run) {
    const errors = [];
    const gracefulClose = this.closeWaiter(run);
    if (run.state.status === 'paused') {
      runBestEffort('runner-dispose-resume', () => this.signalRun(run, 'SIGCONT'));
    }
    if (run.closed) {
      gracefulClose.cancel();
      return errors;
    }
    try {
      this.signalRun(run, 'SIGTERM');
    } catch (error) {
      errors.push(error);
      gracefulClose.cancel();
    }
    const closed = errors.length ? false : await gracefulClose.promise;
    if (!closed) {
      const forcedClose = this.closeWaiter(run);
      let killSent = false;
      try {
        this.signalRun(run, 'SIGKILL');
        killSent = true;
      } catch (error) {
        errors.push(error);
        forcedClose.cancel();
      }
      if (killSent) {
        const killed = await forcedClose.promise;
        if (!killed) {
          errors.push(terminationTimeoutError(
            'SIGKILL 이후 프로그램 종료를 확인하지 못했습니다.',
            'SIGKILL_CLOSE_TIMEOUT',
          ));
        }
      }
    }
    return errors;
  }

  finalizeCancelledState(run, errors, systemShutdown = false) {
    if (!run.finalized) {
      runBestEffort('runner-dispose-flush-stdout', () => this.flush(run, 'stdout'));
      runBestEffort('runner-dispose-flush-stderr', () => this.flush(run, 'stderr'));
      run.finalized = true;
      run.state.status = 'cancelled';
      run.state.statusDetail = systemShutdown
        ? 'Windows 시스템 종료로 실행을 중지함'
        : (errors.length ? '프로그램 종료 중 실행 상태를 확인하지 못함' : '프로그램 종료로 실행을 중지함');
      run.state.endedAt = new Date().toISOString();
      run.state.updatedAt = run.state.endedAt;
      addLifecycle(run.state, 'process-end', systemShutdown ? '시스템 종료로 실행 중지' : '프로그램 종료로 실행 중지', {
        id: 'process-end', detail: run.state.statusDetail, status: 'failed',
      });
    }
    if (errors.length) {
      run.state.statusDetail = '프로그램 종료 중 실행 상태를 확인하지 못함';
      addLifecycle(run.state, 'error', '프로그램 종료 확인 실패', {
        id: 'dispose-error',
        detail: errors.map(error => error.message).join('\n'),
        status: 'failed',
      });
    }
    try {
      this.persist(run);
    } catch (error) {
      errors.push(error);
    }
  }

  finalizeDisposedRun(run, errors) {
    this.finalizeCancelledState(run, errors);
    this.active.delete(run.id);
    this.emit('changed', { runId: run.id, state: run.state });
  }

  async disposeRun(run) {
    run.stopping = true;
    run.disposing = true;
    let errors = [];
    if (this.platform === 'win32') {
      errors = await this.terminateWindowsRun(run);
    } else {
      errors = await this.terminatePosixRun(run);
    }
    this.finalizeDisposedRun(run, errors);
    return errors.map(error => ({ runId: run.id, error: error.message }));
  }

  prepareForSystemShutdown() {
    this.disposing = true;
    const runs = [...this.active.values()];
    const errors = [];
    for (const run of runs) {
      const runErrors = [];
      try {
        run.stopping = true;
        run.disposing = true;
        this.finalizeCancelledState(run, runErrors, true);
      } catch (error) {
        runErrors.push(error);
      }
      errors.push(...runErrors.map(error => ({ runId: run.id, error: error.message })));
    }
    return { stopped: runs.length, errors };
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposing = true;
    const runs = [...this.active.values()];
    this.disposePromise = Promise.all(runs.map(run => this.disposeRun(run))).then(results => ({
      stopped: runs.length,
      errors: results.flat(),
    }));
    return this.disposePromise;
  }
}

module.exports = {
  AgentRunner,
  MAX_AGENT_OUTPUT_LINE_BYTES,
  probeProviders,
  findExecutable,
  commandSpec,
  handleClaude,
  signalPosixProcessTree,
  usageFrom,
};
