'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ATTENTION_HOOK_PROTOCOL = 1;
const ATTENTION_HOOK_SERVICE = 'whitebox-attention-hook';
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 9 * 60 * 1000;
const LOOPBACK_HOST = '127.0.0.1';
const MAX_PERMISSION_SUGGESTIONS = 20;
const MAX_PERMISSION_RULES = 32;
const MAX_PERMISSION_DIRECTORIES = 32;
const MAX_PERMISSION_LABEL_LENGTH = 512;
const MAX_PERMISSION_TOOL_NAME_LENGTH = 256;
const MAX_PERMISSION_RULE_LENGTH = 4_096;
const MAX_PERMISSION_DIRECTORY_LENGTH = 4_096;
const PERMISSION_UPDATE_TYPES = new Set([
  'addRules', 'replaceRules', 'removeRules', 'setMode', 'addDirectories', 'removeDirectories',
]);
const PERMISSION_UPDATE_DESTINATIONS = new Set([
  'userSettings', 'projectSettings', 'localSettings', 'session',
]);
const PERMISSION_BEHAVIORS = new Set(['allow', 'deny', 'ask']);
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanString(value, maximum = 4_096) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, maximum);
}

function stableJson(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map(item => stableJson(item, seen)).join(',')}]`;
  } else {
    result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}

function hashValue(value, length = 32) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex').slice(0, length);
}

function normalizeOption(option, index) {
  if (typeof option === 'string') {
    const label = cleanString(option, 512);
    return label ? { id: String(index), label, value: label, description: '' } : null;
  }
  if (!isPlainObject(option)) return null;
  const label = cleanString(option.label ?? option.name ?? option.value ?? option.text, 512);
  if (!label) return null;
  return {
    id: cleanString(option.id ?? option.value, 256) || String(index),
    label,
    value: cleanString(option.value ?? option.label ?? option.name, 512) || label,
    description: cleanString(option.description ?? option.detail, 2_048),
  };
}

function normalizeQuestions(toolInput) {
  if (!isPlainObject(toolInput) || !Array.isArray(toolInput.questions)) return [];
  return toolInput.questions.map((question, index) => {
    if (!isPlainObject(question)) return null;
    const text = cleanString(question.question ?? question.prompt ?? question.text, 4_096);
    if (!text) return null;
    const options = Array.isArray(question.options)
      ? question.options.map(normalizeOption).filter(Boolean).slice(0, 100)
      : [];
    return {
      id: cleanString(question.id, 256) || `question-${index + 1}`,
      header: cleanString(question.header ?? question.title, 256),
      question: text,
      options,
      multiSelect: Boolean(question.multiSelect ?? question.multi_select),
    };
  }).filter(Boolean).slice(0, 20);
}

function normalizePermissionRule(value) {
  if (!isPlainObject(value)) return null;
  const toolName = cleanString(value.toolName, MAX_PERMISSION_TOOL_NAME_LENGTH);
  if (!toolName) return null;
  const entry = { toolName };
  if (Object.prototype.hasOwnProperty.call(value, 'ruleContent')) {
    const ruleContent = cleanString(value.ruleContent, MAX_PERMISSION_RULE_LENGTH);
    if (!ruleContent) return null;
    entry.ruleContent = ruleContent;
  }
  return Object.freeze(entry);
}

function normalizePermissionUpdate(value) {
  if (!isPlainObject(value)) return null;
  const type = cleanString(value.type, 64);
  const destination = cleanString(value.destination, 64);
  if (!PERMISSION_UPDATE_TYPES.has(type) || !PERMISSION_UPDATE_DESTINATIONS.has(destination)) return null;

  if (type === 'addRules' || type === 'replaceRules' || type === 'removeRules') {
    const behavior = cleanString(value.behavior, 32);
    if (!PERMISSION_BEHAVIORS.has(behavior)
      || !Array.isArray(value.rules)
      || value.rules.length === 0
      || value.rules.length > MAX_PERMISSION_RULES) return null;
    const rules = value.rules.map(normalizePermissionRule);
    if (rules.some(rule => !rule)) return null;
    return Object.freeze({ type, rules: Object.freeze(rules), behavior, destination });
  }

  if (type === 'setMode') {
    const mode = cleanString(value.mode, 64);
    if (!PERMISSION_MODES.has(mode)) return null;
    return Object.freeze({ type, mode, destination });
  }

  if (!Array.isArray(value.directories)
    || value.directories.length === 0
    || value.directories.length > MAX_PERMISSION_DIRECTORIES) return null;
  const directories = value.directories.map(directory => cleanString(directory, MAX_PERMISSION_DIRECTORY_LENGTH));
  if (directories.some(directory => !directory)) return null;
  return Object.freeze({ type, directories: Object.freeze(directories), destination });
}

function permissionSuggestionLabel(entry) {
  let scopes = [];
  if (Array.isArray(entry.rules)) {
    scopes = entry.rules.map(rule => (
      rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
    ));
  } else if (Array.isArray(entry.directories)) {
    scopes = entry.directories;
  } else if (entry.mode) {
    scopes = [entry.mode];
  }
  return cleanString(scopes.join(', '), MAX_PERMISSION_LABEL_LENGTH);
}

function normalizePermissionSuggestions(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const suggestions = [];
  value.slice(0, MAX_PERMISSION_SUGGESTIONS).forEach((candidate, index) => {
    const entry = normalizePermissionUpdate(candidate);
    if (!entry) return;
    const label = permissionSuggestionLabel(entry);
    if (!label) return;
    suggestions.push(Object.freeze({
      id: `permission-suggestion:${index}:${hashValue(entry, 16)}`,
      label,
      entry,
    }));
  });
  return Object.freeze(suggestions);
}

function permissionDetail(toolInput) {
  if (!isPlainObject(toolInput)) return '';
  const preferred = [
    toolInput.description,
    toolInput.command,
    toolInput.file_path,
    toolInput.path,
    toolInput.query,
    toolInput.url,
  ].map(value => cleanString(value, 8_192)).find(Boolean);
  if (preferred) return preferred;
  try { return JSON.stringify(toolInput).slice(0, 8_192); } catch { return ''; }
}

function normalizeHookRequest(payload, options = {}) {
  if (!isPlainObject(payload)) {
    const error = new TypeError('Hook payload must be a JSON object.');
    error.code = 'ATTENTION_HOOK_INVALID_PAYLOAD';
    throw error;
  }
  const providerHint = cleanString(options.provider, 32).toLowerCase();
  const provider = providerHint === 'codex' ? 'codex' : 'claude';
  const eventName = cleanString(payload.hook_event_name ?? payload.hookEventName, 128);
  const toolName = cleanString(payload.tool_name ?? payload.toolName, 256);
  const toolInput = isPlainObject(payload.tool_input ?? payload.toolInput)
    ? (payload.tool_input ?? payload.toolInput)
    : {};
  const questions = normalizeQuestions(toolInput);
  const normalizedToolName = toolName.replace(/[-_\s]/gu, '').toLowerCase();
  const questionTool = normalizedToolName === 'askuserquestion'
    || normalizedToolName === 'requestuserinput';
  const kind = questions.length > 0 && (questionTool || /pretooluse/i.test(eventName))
    ? 'question'
    : 'permission';
  const sessionId = cleanString(
    payload.session_id ?? payload.sessionId ?? payload.thread_id ?? payload.threadId ?? payload.conversation_id,
    512,
  );
  const agentId = cleanString(
    payload.agent_id ?? payload.agentId ?? payload.subagent?.agent_id ?? payload.subagent?.agentId,
    512,
  );
  const explicitRequestId = cleanString(
    payload.request_id ?? payload.requestId ?? payload.tool_use_id ?? payload.toolUseId
      ?? payload.call_id ?? payload.callId,
    512,
  );
  const turnId = cleanString(payload.turn_id ?? payload.turnId, 512);
  const generatedRequestId = hashValue({ eventName, sessionId, turnId, toolName, toolInput }, 32);
  const requestId = explicitRequestId || generatedRequestId;
  // PermissionRequest does not carry tool_use_id in Claude's official schema.
  // Never collapse two live, identical-looking permission connections in that
  // case: allowing one must not approve another request by accident. Only a
  // provider-supplied request id is safe to use as a retransmission key.
  const requestInstanceId = cleanString(options.requestInstanceId, 512)
    || crypto.randomBytes(24).toString('hex');
  const key = `${provider}:${hashValue(explicitRequestId
    ? { sessionId, requestId: explicitRequestId }
    : { sessionId, requestInstanceId }, 40)}`;
  const questionDetail = questions.map(question => question.question).join('\n');
  const firstHeader = questions.map(question => question.header).find(Boolean);
  const permissionSuggestions = provider === 'claude' && eventName === 'PermissionRequest'
    ? normalizePermissionSuggestions(payload.permission_suggestions)
    : Object.freeze([]);
  return Object.freeze({
    key,
    provider,
    sessionId,
    agentId,
    requestId,
    requestIdExplicit: Boolean(explicitRequestId),
    kind,
    toolName,
    toolInput,
    questions,
    permissionSuggestions,
    title: kind === 'question'
      ? (firstHeader || 'Agent question')
      : `${toolName || 'Tool'} permission request`,
    detail: kind === 'question' ? questionDetail : permissionDetail(toolInput),
    responseType: kind === 'question' ? 'pre-tool-use' : 'permission-request',
    createdAt: new Date().toISOString(),
  });
}

function normalizeAnswerValue(value) {
  if (Array.isArray(value)) {
    const labels = value.map(item => cleanString(item, 512)).filter(Boolean);
    return labels.length > 0 ? labels.join(', ') : '';
  }
  return cleanString(value, 2_048);
}

function questionAnswers(request, decision) {
  let source = isPlainObject(decision.answers)
    ? decision.answers
    : (isPlainObject(decision.updatedInput?.answers) ? decision.updatedInput.answers : {});
  if (Array.isArray(decision.answers)) {
    source = {};
    for (const item of decision.answers) {
      if (!isPlainObject(item)) continue;
      const questionId = cleanString(item.questionId ?? item.question_id ?? item.id, 4_096);
      if (!questionId) continue;
      const question = request.questions.find(candidate => (
        candidate.id === questionId || candidate.question === questionId || candidate.header === questionId
      ));
      const values = Array.isArray(item.values) ? item.values : (item.values === undefined ? [] : [item.values]);
      const resolved = values.map(value => {
        const normalized = cleanString(value, 512);
        if (!normalized) return '';
        const option = question?.options.find(candidate => (
          candidate.id === normalized || candidate.value === normalized || candidate.label === normalized
        ));
        return option?.label || normalized;
      }).filter(Boolean);
      const freeText = [item.otherText, item.text]
        .map(value => cleanString(value, 2_048))
        .filter(Boolean);
      const combined = [...new Set([...resolved, ...freeText])].join(', ');
      if (combined) source[questionId] = combined;
    }
  }
  const answers = {};
  for (const question of request.questions) {
    const value = source[question.question] ?? source[question.id] ?? source[question.header];
    const normalized = normalizeAnswerValue(value);
    if (normalized) answers[question.question] = normalized;
  }
  if (request.questions.length === 1 && Object.keys(answers).length === 0) {
    const normalized = normalizeAnswerValue(decision.answer);
    if (normalized) answers[request.questions[0].question] = normalized;
  }
  return answers;
}

function normalizeDecision(decision) {
  if (decision === undefined || decision === null) return { action: 'none' };
  if (typeof decision === 'string') return { action: decision.toLowerCase() };
  if (!isPlainObject(decision)) throw new TypeError('Attention decision must be an object or string.');
  const action = cleanString(decision.action ?? decision.behavior ?? decision.decision, 32).toLowerCase();
  return { ...decision, action: action || 'none' };
}

function buildOfficialHookResponse(request, rawDecision) {
  if (request?.provider === 'codex' && request?.responseType !== 'permission-request') return {};
  const decision = normalizeDecision(rawDecision);
  if (decision.action === 'answer') decision.action = 'allow';
  if (decision.action === 'none' || decision.action === 'dismiss' || decision.action === 'cancel') return {};
  if (decision.action !== 'allow' && decision.action !== 'deny') {
    const error = new TypeError(`Unsupported attention decision: ${decision.action || '(empty)'}`);
    error.code = 'ATTENTION_HOOK_INVALID_DECISION';
    throw error;
  }

  if (request.responseType === 'pre-tool-use') {
    const hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.action,
    };
    if (decision.action === 'deny') {
      hookSpecificOutput.permissionDecisionReason = cleanString(decision.message ?? decision.reason, 4_096)
        || 'Denied in Whitebox.';
    } else {
      const answers = questionAnswers(request, decision);
      if (request.questions.length > 0 && Object.keys(answers).length !== request.questions.length) {
        const error = new TypeError('Every structured question requires an answer before approval.');
        error.code = 'ATTENTION_HOOK_ANSWERS_REQUIRED';
        throw error;
      }
      const suppliedInput = isPlainObject(decision.updatedInput) ? decision.updatedInput : {};
      hookSpecificOutput.updatedInput = {
        ...request.toolInput,
        ...suppliedInput,
        ...(request.questions.length > 0 ? { answers } : {}),
      };
    }
    return { hookSpecificOutput };
  }

  const officialDecision = { behavior: decision.action };
  if (decision.action === 'deny') {
    officialDecision.message = cleanString(decision.message ?? decision.reason, 4_096) || 'Denied in Whitebox.';
  }
  if (request.provider !== 'codex' && decision.action === 'allow' && isPlainObject(decision.updatedInput)) {
    officialDecision.updatedInput = decision.updatedInput;
  }
  const permissionSuggestionId = cleanString(decision.permissionSuggestionId, 256);
  if (request.provider !== 'codex' && decision.action === 'allow' && permissionSuggestionId) {
    const suggestion = Array.isArray(request.permissionSuggestions)
      ? request.permissionSuggestions.find(candidate => candidate.id === permissionSuggestionId)
      : null;
    if (!suggestion) {
      const error = new TypeError('The selected permission suggestion is not available for this request.');
      error.code = 'ATTENTION_HOOK_INVALID_PERMISSION_SUGGESTION';
      throw error;
    }
    officialDecision.updatedPermissions = [suggestion.entry];
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: officialDecision,
    },
  };
}

function writeJsonResponse(response, statusCode, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  try { fs.chmodSync(file, 0o600); } catch {}
}

class AttentionHookServer {
  constructor(options = {}) {
    this.host = options.host || LOOPBACK_HOST;
    if (this.host !== LOOPBACK_HOST) {
      const error = new Error('The attention hook server may only bind to 127.0.0.1.');
      error.code = 'ATTENTION_HOOK_HOST_MUST_BE_LOOPBACK';
      throw error;
    }
    this.port = Number.isInteger(options.port) && options.port >= 0 && options.port <= 65_535
      ? options.port
      : 0;
    this.maxBodyBytes = Number.isInteger(options.maxBodyBytes) && options.maxBodyBytes > 0
      ? options.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES;
    this.requestTimeoutMs = Number.isFinite(Number(options.requestTimeoutMs))
      ? Math.max(10, Number(options.requestTimeoutMs))
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.runtimeFile = options.runtimeFile || path.join(os.homedir(), '.whitebox', 'attention-hook.json');
    this.enabled = options.enabled === true;
    this.getEnabled = typeof options.getEnabled === 'function' ? options.getEnabled : null;
    this.onRequest = typeof options.onRequest === 'function' ? options.onRequest : () => {};
    this.onResolved = typeof options.onResolved === 'function' ? options.onResolved : () => {};
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this.nonce = cleanString(options.nonce, 256) || crypto.randomBytes(32).toString('hex');
    if (!/^[a-f0-9]{32,128}$/iu.test(this.nonce)) throw new TypeError('Attention hook nonce must be 32-128 hexadecimal characters.');
    this.routePath = `/whitebox/attention/v1/${this.nonce}`;
    this.server = null;
    this.identity = null;
    this.pending = new Map();
    this.startPromise = null;
    this.disposed = false;
  }

  _enabledNow() {
    if (!this.enabled) return false;
    if (!this.getEnabled) return true;
    try { return this.getEnabled() === true; } catch (error) {
      this._reportError(error, { phase: 'get-enabled' });
      return false;
    }
  }

  _reportError(error, context = {}) {
    try { this.onError(error, context); } catch {}
  }

  async start() {
    if (this.disposed) throw new Error('Attention hook server has been disposed.');
    if (this.identity) return { ...this.identity };
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => this._handleRequest(request, response));
      this.server = server;
      const onError = error => {
        server.removeListener('listening', onListening);
        this.server = null;
        this.startPromise = null;
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        server.on('error', error => this._reportError(error, { phase: 'server' }));
        const address = server.address();
        const boundPort = typeof address === 'object' && address ? address.port : this.port;
        this.identity = Object.freeze({
          protocol: ATTENTION_HOOK_PROTOCOL,
          service: ATTENTION_HOOK_SERVICE,
          pid: process.pid,
          host: LOOPBACK_HOST,
          port: boundPort,
          nonce: this.nonce,
          path: this.routePath,
          url: `http://${LOOPBACK_HOST}:${boundPort}${this.routePath}`,
          runtimeFile: this.runtimeFile,
          startedAt: new Date().toISOString(),
        });
        try {
          atomicWriteJson(this.runtimeFile, this.identity);
        } catch (error) {
          server.close(() => {});
          this.server = null;
          this.identity = null;
          this.startPromise = null;
          reject(error);
          return;
        }
        resolve({ ...this.identity });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: LOOPBACK_HOST, port: this.port, exclusive: true });
    });
    return this.startPromise;
  }

  _handleRequest(request, response) {
    if (request.url !== this.routePath) {
      writeJsonResponse(response, 404, {});
      request.resume();
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      writeJsonResponse(response, 405, {});
      request.resume();
      return;
    }
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxBodyBytes) {
      writeJsonResponse(response, 413, {});
      request.resume();
      return;
    }
    const chunks = [];
    let received = 0;
    let overflow = false;
    request.on('data', chunk => {
      if (overflow) return;
      received += chunk.length;
      if (received > this.maxBodyBytes) {
        overflow = true;
        chunks.length = 0;
        writeJsonResponse(response, 413, {});
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', error => this._reportError(error, { phase: 'request-read' }));
    request.on('end', () => {
      if (overflow || response.writableEnded) return;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks, received).toString('utf8'));
      } catch {
        writeJsonResponse(response, 400, {});
        return;
      }
      const providerHeader = cleanString(request.headers['x-whitebox-provider'], 32).toLowerCase();
      let normalized;
      try {
        normalized = normalizeHookRequest(payload, {
          provider: providerHeader,
          requestInstanceId: crypto.randomBytes(24).toString('hex'),
        });
      } catch (error) {
        this._reportError(error, { phase: 'normalize' });
        writeJsonResponse(response, 400, {});
        return;
      }
      if (!this._enabledNow()) {
        writeJsonResponse(response, 200, {});
        return;
      }
      // Codex currently exposes actionable answers through PermissionRequest
      // only. In particular, request_user_input is a TUI/app-server flow, not
      // an official command-hook response channel.
      if (normalized.provider === 'codex' && normalized.responseType !== 'permission-request') {
        writeJsonResponse(response, 200, {});
        return;
      }
      this._queue(normalized, response);
    });
  }

  _queue(request, response) {
    let entry = this.pending.get(request.key);
    if (entry) {
      entry.responses.add(response);
      this._watchResponse(entry, response);
      return;
    }
    entry = {
      request,
      responses: new Set([response]),
      timer: null,
      settled: false,
    };
    entry.timer = setTimeout(() => this._settle(entry, { action: 'none' }, 'timeout'), this.requestTimeoutMs);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    this.pending.set(request.key, entry);
    this._watchResponse(entry, response);
    let result;
    try {
      result = this.onRequest(request, decision => this.resolve(request.key, decision));
    } catch (error) {
      this._reportError(error, { phase: 'on-request', request });
      this._settle(entry, { action: 'none' }, 'callback-error');
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(decision => {
        if (typeof decision === 'string' || isPlainObject(decision)) this.resolve(request.key, decision);
      }).catch(error => {
        this._reportError(error, { phase: 'on-request', request });
        this._settle(entry, { action: 'none' }, 'callback-error');
      });
    } else if (typeof result === 'string' || isPlainObject(result)) {
      this.resolve(request.key, result);
    }
  }

  _watchResponse(entry, response) {
    const disconnected = () => {
      if (entry.settled) return;
      entry.responses.delete(response);
      if (entry.responses.size === 0) this._settle(entry, { action: 'none' }, 'client-disconnected');
    };
    response.once('close', disconnected);
  }

  _settle(entry, rawDecision, reason = 'resolved') {
    if (!entry || entry.settled) return false;
    let output;
    try {
      output = buildOfficialHookResponse(entry.request, rawDecision);
    } catch (error) {
      this._reportError(error, { phase: 'resolve', request: entry.request });
      throw error;
    }
    entry.settled = true;
    clearTimeout(entry.timer);
    this.pending.delete(entry.request.key);
    for (const response of entry.responses) writeJsonResponse(response, 200, output);
    const decision = normalizeDecision(rawDecision);
    try { this.onResolved({ request: entry.request, decision, output, reason }); } catch (error) {
      this._reportError(error, { phase: 'on-resolved', request: entry.request });
    }
    return true;
  }

  resolve(requestKey, decision) {
    const entry = this.pending.get(String(requestKey || ''));
    if (!entry) return false;
    return this._settle(entry, decision, 'resolved');
  }

  setEnabled(enabled) {
    this.enabled = enabled === true;
    if (!this.enabled) {
      for (const entry of [...this.pending.values()]) this._settle(entry, { action: 'none' }, 'disabled');
    }
    return this.enabled;
  }

  getPendingRequests() {
    return [...this.pending.values()].map(entry => entry.request);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    for (const entry of [...this.pending.values()]) this._settle(entry, { action: 'none' }, 'disposed');
    const identity = this.identity;
    this.identity = null;
    this.startPromise = null;
    if (identity && this.runtimeFile) {
      try {
        const current = JSON.parse(fs.readFileSync(this.runtimeFile, 'utf8'));
        if (current?.pid === process.pid && current?.nonce === identity.nonce) fs.unlinkSync(this.runtimeFile);
      } catch {}
    }
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise(resolve => server.close(() => resolve()));
  }
}

module.exports = {
  ATTENTION_HOOK_PROTOCOL,
  ATTENTION_HOOK_SERVICE,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LOOPBACK_HOST,
  AttentionHookServer,
  buildOfficialHookResponse,
  normalizeHookRequest,
  normalizePermissionSuggestions,
  normalizeQuestions,
};
