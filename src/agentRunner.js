'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { PROVIDERS, normalizeProvider, modelContextWindow, blankUsage, finalizeUsage } = require('./providerRegistry');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {}
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
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  try { fs.renameSync(temp, file); } catch {
    try { fs.copyFileSync(temp, file); } finally { try { fs.unlinkSync(temp); } catch {} }
  }
}

function eventText(value) {
  if (typeof value === 'string') return value.trim();
  if (!value) return '';
  if (Array.isArray(value)) return value.map(eventText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const nested = value.text || value.output_text || value.content || value.message || value.response;
    if (nested != null) return eventText(nested);
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
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
    statusDetail: 'CLI 시작 중',
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

function handleClaude(state, event) {
  if (event.type === 'system' && event.subtype === 'init') {
    state.externalId = event.session_id || state.externalId;
    state.model = event.model || state.model;
    state.status = 'running';
    state.statusDetail = '에이전트 루프 실행 중';
    addLifecycle(state, 'session-start', '세션 시작', { id: 'session-start', status: 'done' });
  }
  if (event.type === 'stream_event') {
    const inner = event.event || {};
    if (inner.type === 'content_block_delta' && inner.delta && inner.delta.type === 'text_delta') {
      addMessage(state, 'assistant', inner.delta.text, { id: 'live-answer', append: true, status: 'streaming' });
      state.statusDetail = '응답 스트리밍 중';
    }
    if (inner.type === 'message_delta' && inner.usage) state.turnUsage = usageFrom(inner.usage);
  }
  if (event.type === 'assistant' && event.message) {
    state.model = event.message.model || state.model;
    const blocks = Array.isArray(event.message.content) ? event.message.content : [];
    for (const block of blocks) {
      if (block.type === 'text') addMessage(state, 'assistant', block.text, { id: event.uuid || event.message.id, status: 'done' });
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
    if (event.result) addMessage(state, 'assistant', event.result, { id: 'final-result', status: 'done' });
    addLifecycle(state, state.status === 'failed' ? 'error' : 'session-end', state.status === 'failed' ? '실행 실패' : '세션 완료', { id: 'session-end', status: state.status === 'failed' ? 'failed' : 'done' });
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
    state.statusDetail = '세션 시작';
    addLifecycle(state, 'session-start', '세션 시작', { id: 'session-start' });
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
    addLifecycle(state, 'session-end', state.status === 'failed' ? '실행 실패' : '세션 완료', { id: 'session-end', status: state.status === 'failed' ? 'failed' : 'done' });
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
    state.statusDetail = '세션 실행 중';
    addLifecycle(state, 'session-start', '세션 시작', { id: 'session-start' });
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
    addLifecycle(state, 'session-end', state.status === 'failed' ? '실행 실패' : '세션 완료', { id: 'session-end', status: state.status === 'failed' ? 'failed' : 'done' });
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

class AgentRunner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.runsDir = options.runsDir;
    this.active = new Map();
    ensureDir(this.runsDir);
  }

  listActive() {
    return [...this.active.values()].map(item => ({ runId: item.id, provider: item.provider, pid: item.child.pid, externalId: item.state.externalId }));
  }

  start(raw = {}) {
    const provider = normalizeProvider(raw.provider);
    const prompt = String(raw.prompt || '').trim();
    const cwd = path.resolve(String(raw.cwd || process.cwd()));
    if (!prompt) return { ok: false, error: '작업 내용을 입력하세요.' };
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { ok: false, error: '작업 폴더를 찾을 수 없습니다.' };
    const executable = findExecutable(PROVIDERS[provider].command);
    if (!executable) return { ok: false, error: `${PROVIDERS[provider].label} CLI가 설치되어 있지 않습니다.` };

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
      child = spawn(spec.command, spec.args, {
        cwd,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
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

    const run = { id, provider, dir, child, state, stdoutBuffer: '', stderrBuffer: '', stopping: false };
    this.active.set(id, run);
    state.status = 'running';
    state.statusDetail = '구조화 이벤트 연결됨';
    addLifecycle(state, 'process-start', 'CLI 프로세스 시작', { id: 'process-start', detail: `PID ${child.pid}`, status: 'running' });
    this.persist(run);

    child.stdout.on('data', chunk => this.consume(run, 'stdout', chunk));
    child.stderr.on('data', chunk => this.consume(run, 'stderr', chunk));
    child.on('error', error => {
      state.status = 'failed';
      state.statusDetail = error.message;
      addLifecycle(state, 'error', '프로세스 오류', { id: 'process-error', detail: error.message, status: 'failed' });
      this.persist(run);
    });
    child.on('close', (code, signal) => {
      this.flush(run, 'stdout');
      this.flush(run, 'stderr');
      if (run.stopping) {
        state.status = 'cancelled';
        state.statusDetail = '사용자가 중지함';
      } else if (state.status === 'running' || state.status === 'starting') {
        state.status = code === 0 ? 'completed' : 'failed';
        state.statusDetail = code === 0 ? '작업 완료' : `CLI 종료 코드 ${code}${signal ? ` · ${signal}` : ''}`;
      }
      state.endedAt = new Date().toISOString();
      addLifecycle(state, 'process-end', state.status === 'completed' ? '프로세스 완료' : (state.status === 'cancelled' ? '프로세스 중지' : '프로세스 실패'), { id: 'process-end', detail: state.statusDetail, status: state.status === 'completed' ? 'done' : 'failed' });
      this.persist(run);
      this.active.delete(id);
      this.emit('changed', { runId: id, state });
    });

    this.emit('changed', { runId: id, state });
    return { ok: true, runId: id, sessionId: state.externalId, pid: child.pid };
  }

  consume(run, stream, chunk) {
    const key = `${stream}Buffer`;
    run[key] += chunk.toString('utf8');
    let index;
    while ((index = run[key].indexOf('\n')) >= 0) {
      const line = run[key].slice(0, index).trim();
      run[key] = run[key].slice(index + 1);
      if (line) this.handleLine(run, stream, line);
    }
  }

  flush(run, stream) {
    const key = `${stream}Buffer`;
    const line = run[key].trim();
    run[key] = '';
    if (line) this.handleLine(run, stream, line);
  }

  handleLine(run, stream, line) {
    let event = null;
    try { event = JSON.parse(line); } catch {}
    fs.appendFileSync(path.join(run.dir, 'events.jsonl'), `${JSON.stringify({ timestamp: new Date().toISOString(), stream, event, text: event ? undefined : clip(line, 4000) })}\n`, 'utf8');
    if (event) {
      if (run.provider === 'claude') handleClaude(run.state, event);
      else if (run.provider === 'codex') handleCodex(run.state, event);
      else if (run.provider === 'gemini') handleGemini(run.state, event);
      else handleGrok(run.state, event);
    } else if (stream === 'stderr') {
      addLifecycle(run.state, 'log', 'CLI 상태', { detail: clip(line, 500), status: 'running' });
      if (/error|failed|fatal/i.test(line)) run.state.statusDetail = clip(line, 240);
    }
    run.state.updatedAt = new Date().toISOString();
    updateContext(run.state);
    this.persist(run);
    this.emit('changed', { runId: run.id, state: run.state });
  }

  persist(run) {
    atomicJson(path.join(run.dir, 'session.json'), run.state);
  }

  stop(id) {
    const run = this.active.get(String(id || ''));
    if (!run) return { ok: false, error: '실행 중인 작업을 찾을 수 없습니다.' };
    run.stopping = true;
    run.state.statusDetail = '중지 요청 중';
    this.persist(run);
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try { run.child.kill('SIGTERM'); } catch {}
    }
    return { ok: true };
  }
}

module.exports = {
  AgentRunner,
  probeProviders,
  findExecutable,
  commandSpec,
  usageFrom,
};
