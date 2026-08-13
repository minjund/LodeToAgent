'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { McpStdioClient } = require('../../mcpClient');
const {
  buildAsideToolArguments,
  discoverAsideTools,
  unavailableCapability,
} = require('./capabilities');
const {
  canonicalRoots,
  detailAsideHistorySession,
  scanAsideHistoryFolders,
} = require('./folderHistory');
const { ASIDE_MANIFEST, asidePlatformStatus } = require('./manifest');

const MAX_OFFICIAL_TASKS = 500;
const MAX_OFFICIAL_MESSAGES = 10_000;
const MAX_OFFICIAL_EVENTS = 10_000;

function safeOfficialSessionId(value) {
  if (value == null) return '';
  const id = String(value).replace(/^aside:/, '').replace(/\u0000/g, '').trim();
  return id && id.length <= 500 && !/[\u0000-\u001f\u007f]/.test(id) ? id : '';
}

function boundedErrorMessage(error, fallback = 'Aside operation failed.') {
  return compactText(error && error.message || error || fallback, 1000) || fallback;
}

function redactBrowserUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.username = '';
    parsed.password = '';
    for (const name of [...parsed.searchParams.keys()]) {
      if (/(?:token|secret|key|password|passwd|credential|auth|session|cookie|code)/i.test(name)) {
        parsed.searchParams.set(name, '[REDACTED]');
      }
    }
    parsed.hash = '';
    return parsed.toString().slice(0, 4096);
  } catch (_error) {
    return '';
  }
}

function normalizeOfficialArtifactPath(value, isUrl = false) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isUrl || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return redactBrowserUrl(raw);
  return raw.slice(0, 32_768);
}

function compactText(value, limit = 200_000) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim().slice(0, limit);
  if (Array.isArray(value)) {
    return value.map(item => compactText(item && (item.text || item.content || item.value || item), limit))
      .filter(Boolean).join('\n').slice(0, limit);
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim().slice(0, limit);
    try {
      return JSON.stringify(value).slice(0, limit);
    } catch (_error) {
      return '';
    }
  }
  return String(value).slice(0, limit);
}

function isoTime(value, fallback = '') {
  if (value == null || value === '') return fallback;
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeRole(value) {
  const role = String(value || '').toLowerCase();
  if (['user', 'human', 'customer', 'requester'].includes(role)) return 'user';
  if (['assistant', 'agent', 'ai', 'model'].includes(role)) return 'assistant';
  if (['tool', 'function', 'browser', 'action'].includes(role)) return 'tool';
  if (role === 'system') return 'system';
  return '';
}

function officialMessages(raw) {
  let rows = [];
  for (const key of ['messages', 'turns', 'history', 'conversation', 'transcript']) {
    if (Array.isArray(raw && raw[key])) {
      rows = raw[key];
      break;
    }
  }
  return rows.slice(0, MAX_OFFICIAL_MESSAGES).map((message, index) => {
    if (!message || typeof message !== 'object') return null;
    const role = normalizeRole(message.role || message.author || message.sender || message.type);
    const text = compactText(message.text || message.content || message.message || message.prompt
      || message.response || message.output);
    if (!role || !text) return null;
    return {
      id: String(message.id || message.messageId || message.message_id || `message-${index + 1}`),
      role,
      type: role === 'tool' ? 'tool' : 'message',
      title: compactText(message.title || message.name || message.toolName || message.tool_name, 200),
      text,
      status: String(message.status || ''),
      timestamp: isoTime(message.timestamp || message.createdAt || message.created_at || message.time),
    };
  }).filter(Boolean);
}

function officialLifecycle(raw) {
  const rows = raw && (raw.steps || raw.events || raw.actions || raw.lifecycle);
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, MAX_OFFICIAL_EVENTS).map((event, index) => {
    if (!event || typeof event !== 'object') return null;
    const label = compactText(event.label || event.title || event.name || event.action || event.type, 500);
    if (!label) return null;
    return {
      id: String(event.id || `event-${index + 1}`),
      type: String(event.type || event.kind || 'step'),
      label,
      status: String(event.status || 'done'),
      timestamp: isoTime(event.timestamp || event.createdAt || event.created_at || event.time),
    };
  }).filter(Boolean);
}

function officialArtifacts(raw) {
  const rows = raw && (raw.artifacts || raw.files || raw.attachments || raw.outputs);
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 500).map((item, index) => {
    const itemValue = item && typeof item === 'object' ? item : {};
    const filePath = typeof item === 'string' ? item : itemValue.path || itemValue.file || itemValue.url;
    if (!filePath) return null;
    return {
      id: String(itemValue.id || `artifact-${index + 1}`),
      title: compactText(itemValue.title || itemValue.name || (itemValue.url ? redactBrowserUrl(filePath) : filePath), 500),
      path: normalizeOfficialArtifactPath(filePath, Boolean(itemValue.url)),
      kind: String(itemValue.kind || itemValue.type || 'file'),
    };
  }).filter(Boolean);
}

function legacyProvider(modelProvider) {
  const provider = String(modelProvider || '').toLowerCase();
  if (/anthropic|claude/.test(provider)) return 'claude';
  if (/google|gemini/.test(provider)) return 'gemini';
  if (/xai|grok/.test(provider)) return 'grok';
  return 'codex';
}

function taskIdentity(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const specific = raw.taskId || raw.task_id || raw.sessionId || raw.session_id
    || raw.conversationId || raw.conversation_id || raw.threadId || raw.thread_id;
  if (specific != null && specific !== '') return specific;
  const taskFields = ['title', 'name', 'status', 'state', 'messages', 'turns', 'conversation', 'history',
    'transcript', 'provider', 'model', 'createdAt', 'created_at', 'updatedAt', 'updated_at'];
  return raw.id != null && taskFields.some(key => raw[key] !== undefined) ? raw.id : '';
}

function normalizeOfficialTask(raw, discovery, options = {}) {
  const externalId = safeOfficialSessionId(taskIdentity(raw));
  if (!externalId) return null;
  const messages = officialMessages(raw);
  const startedAt = isoTime(raw.startedAt || raw.createdAt || raw.created_at || raw.time_created);
  const updatedAt = isoTime(raw.updatedAt || raw.updated_at || raw.time_updated,
    messages.map(message => message.timestamp).filter(Boolean).sort().pop() || startedAt);
  const statusValue = String(raw.status || raw.state || '').toLowerCase();
  const status = raw.archived || raw.time_archived ? 'archived'
    : raw.error || raw.failed || ['error', 'failed'].includes(statusValue) ? 'failed'
      : ['running', 'active', 'working', 'in_progress', 'in-progress'].includes(statusValue) ? 'running'
        : ['waiting', 'blocked', 'needs_input', 'needs-input'].includes(statusValue) ? 'waiting'
          : ['archived', 'completed', 'idle'].includes(statusValue) ? statusValue : 'completed';
  const modelProvider = String(raw.provider || raw.providerId || raw.provider_id || '');
  const model = String(raw.model || raw.modelId || raw.model_id || '');
  const title = compactText(raw.title || raw.name || raw.task || raw.prompt, 500)
    || compactText(messages.find(message => message.role === 'user')?.text, 500)
    || `Aside task ${externalId}`;
  const latestAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const capabilities = discovery && discovery.capabilities || {};
  const lifecycle = officialLifecycle(raw);
  const tabs = Array.isArray(raw.tabs || raw.browserTabs || raw.browser_tabs)
    ? (raw.tabs || raw.browserTabs || raw.browser_tabs).slice(0, 500).map((tab, index) => ({
      id: String(tab && tab.id || `tab-${index + 1}`),
      type: 'browser-tab',
      label: compactText(tab && (tab.title || redactBrowserUrl(tab.url)) || tab, 500),
      status: String(tab && tab.status || 'done'),
      timestamp: isoTime(tab && (tab.timestamp || tab.updatedAt || tab.updated_at), updatedAt),
      url: redactBrowserUrl(tab && tab.url || ''),
    })).filter(tab => tab.label) : [];
  return {
    id: `aside:${externalId}`,
    externalId: String(externalId),
    provider: legacyProvider(modelProvider),
    modelProvider,
    model,
    sourcePluginId: 'aside',
    source: 'source-plugin',
    sourceLabel: 'Aside Browser',
    clientKind: 'aside-browser',
    environment: 'macOS',
    terminalBackend: 'browser',
    conversationTransport: 'plugin',
    title,
    cwd: String(raw.cwd || raw.directory || raw.workspace || ''),
    startedAt,
    updatedAt,
    status,
    messages: options.fullHistory === false
      ? messages.slice(-6).map(message => ({ ...message, text: compactText(message.text, 2000) }))
      : messages,
    messageCount: Number(raw.messageCount || raw.message_count || messages.length),
    lifecycle: [...lifecycle, ...tabs],
    artifacts: officialArtifacts(raw),
    resources: { browserTabs: tabs },
    outcomes: latestAssistant ? [{ id: 'latest-response', title: 'Latest response', text: latestAssistant.text }] : [],
    readOnly: false,
    importMode: 'official-mcp',
    controlAuthority: 'official-session-id',
    sourceRecord: { taskId: String(externalId) },
    sourceControlCapabilities: {
      // Aside documents native CLI start/continue independently of MCP tool
      // discovery. All other mutations remain gated by observed MCP tools.
      start: true,
      sendInstruction: true,
      stop: Boolean(capabilities.stop),
      archive: Boolean(capabilities.archive),
      delete: Boolean(capabilities.delete),
      live: true,
      readConversation: true,
      readSteps: true,
      readTabs: true,
      readArtifacts: true,
    },
  };
}

function unwrapAsideToolResult(result) {
  if (result && result.isError) {
    const text = Array.isArray(result.content)
      ? result.content.map(item => item && item.text).filter(Boolean).join('\n') : '';
    const error = new Error(compactText(text, 2000) || 'Aside MCP tool returned an error.');
    error.code = 'ASIDE_TOOL_ERROR';
    throw error;
  }
  if (result && result.structuredContent !== undefined) return result.structuredContent;
  if (result && result.structured_content !== undefined) return result.structured_content;
  if (!Array.isArray(result && result.content)) return result;
  const values = [];
  for (const item of result.content) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') continue;
    try {
      values.push(JSON.parse(item.text));
    } catch (_error) {
      values.push({ text: item.text });
    }
  }
  if (values.length === 1) return values[0];
  return { items: values };
}

function extractAsideTaskRows(value, output = [], depth = 0, seen = new Set(), budget = { remaining: 10_000 }) {
  if (depth > 4 || value == null || output.length >= MAX_OFFICIAL_TASKS || budget.remaining <= 0) return output;
  budget.remaining -= 1;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (output.length >= MAX_OFFICIAL_TASKS || budget.remaining <= 0) break;
      extractAsideTaskRows(item, output, depth + 1, seen, budget);
    }
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (taskIdentity(value)) {
    output.push(value);
    return output;
  }
  for (const key of ['tasks', 'sessions', 'conversations', 'items', 'results', 'data', 'task', 'session', 'conversation']) {
    if (value[key] !== undefined) extractAsideTaskRows(value[key], output, depth + 1, seen, budget);
  }
  return output;
}

async function callDiscoveredTool(client, descriptor, input) {
  if (!descriptor) throw unavailableCapability('requested');
  const args = buildAsideToolArguments(descriptor, input);
  return unwrapAsideToolResult(await client.callTool(descriptor.name, args));
}

async function scanOfficialAside(client, discovery, options = {}) {
  const descriptor = discovery && discovery.operations && discovery.operations.list;
  if (!descriptor) throw unavailableCapability('list');
  const payload = await callDiscoveredTool(client, descriptor, {
    cursor: options.cursor,
    limit: options.limit == null ? 200 : options.limit,
  });
  const sessions = extractAsideTaskRows(payload)
    .map(row => normalizeOfficialTask(row, discovery, { fullHistory: false }))
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return { sessions, mode: 'official-mcp', readOnly: false, raw: payload };
}

async function detailOfficialAside(client, discovery, taskId) {
  const descriptor = discovery && discovery.operations && discovery.operations.detail;
  if (!descriptor) throw unavailableCapability('detail');
  const externalId = safeOfficialSessionId(taskId);
  if (!externalId) {
    const error = new Error('Aside session id is invalid.');
    error.code = 'ASIDE_INPUT_INVALID';
    throw error;
  }
  const payload = await callDiscoveredTool(client, descriptor, { taskId: externalId });
  const row = extractAsideTaskRows(payload)[0];
  return row ? normalizeOfficialTask(row, discovery, { fullHistory: true }) : null;
}

async function controlOfficialAside(client, discovery, action, input = {}, options = {}) {
  const operation = action === 'continue' || action === 'sendInstruction' ? 'send' : action;
  if (!['start', 'send', 'stop', 'archive', 'delete'].includes(operation)) {
    const error = new Error(`Unsupported Aside control action: ${action}`);
    error.code = 'ASIDE_ACTION_INVALID';
    throw error;
  }
  const descriptor = discovery && discovery.operations && discovery.operations[operation];
  if (!descriptor) throw unavailableCapability(operation);
  const normalizedInput = { ...input };
  if (operation !== 'start') {
    normalizedInput.taskId = safeOfficialSessionId(input.taskId || input.sessionId || input.externalId || input.id);
    if (!normalizedInput.taskId) {
      const error = new Error('Aside session id is invalid.');
      error.code = 'ASIDE_INPUT_INVALID';
      throw error;
    }
    if (!(options.verifiedSessionIds instanceof Set) || !options.verifiedSessionIds.has(normalizedInput.taskId)) {
      const error = new Error('Aside control requires a session id verified by the official MCP server.');
      error.code = 'ASIDE_CONTROL_AUTHORITY_REQUIRED';
      throw error;
    }
  }
  return callDiscoveredTool(client, descriptor, normalizedInput);
}

class AsideAdapter {
  constructor(options = {}) {
    this.options = options;
    this.platform = options.platform || process.platform;
    this.release = options.release;
    this.macOSMajor = options.macOSMajor;
    this.taskFolders = Array.isArray(options.taskFolders) ? [...options.taskFolders] : [];
    this.cliSpawnImpl = options.cliSpawnImpl || spawn;
    this.clientFactory = options.clientFactory || (() => new McpStdioClient({
      command: options.command || ASIDE_MANIFEST.command,
      args: options.mcpArgs || ASIDE_MANIFEST.mcpArgs,
      env: options.env,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      spawnImpl: options.spawnImpl,
    }));
    this.client = null;
    this.lastFolderScan = null;
    this.folderCache = new Map();
    this.officialSessionIds = new Set();
    this.discoveryDirty = false;
    this.probePromise = null;
    this.disposed = false;
    this.lifecycleToken = 0;
    this.discovery = discoverAsideTools([]);
    this.status = {
      id: ASIDE_MANIFEST.id,
      available: false,
      platformSupported: false,
      reason: 'Aside has not been probed.',
      code: 'ASIDE_NOT_PROBED',
      capabilities: this.discovery.capabilities,
      toolNames: [],
      tools: [],
    };
  }

  setTaskFolders(folders) {
    this.taskFolders = Array.isArray(folders) ? [...folders] : [];
  }

  watchRoots() {
    return canonicalRoots(this.taskFolders, this.options.fileSystem);
  }

  async probe(options = {}) {
    if (this.disposed) {
      return {
        ...this.status,
        available: false,
        code: 'ASIDE_ADAPTER_CLOSED',
        reason: 'Aside adapter is closed.',
        capabilities: discoverAsideTools([]).capabilities,
      };
    }
    if (this.probePromise) return this.probePromise;
    this.probePromise = this.probeNow(options).finally(() => {
      this.probePromise = null;
    });
    return this.probePromise;
  }

  async probeNow(options = {}) {
    const platform = asidePlatformStatus({
      platform: this.platform,
      release: this.release,
      macOSMajor: this.macOSMajor,
    });
    if (!platform.supported) {
      this.status = {
        id: ASIDE_MANIFEST.id,
        available: false,
        platformSupported: false,
        reason: platform.reason,
        code: platform.code,
        capabilities: discoverAsideTools([]).capabilities,
        toolNames: [],
        tools: [],
      };
      this.officialSessionIds.clear();
      return this.status;
    }
    const clientRunning = this.client && (typeof this.client.isRunning !== 'function' || this.client.isRunning());
    if (this.status.available && clientRunning && !options.refresh && !this.discoveryDirty) return this.status;
    this.officialSessionIds.clear();
    if (this.client) this.client.close();
    this.client = null;
    this.discovery = discoverAsideTools([]);
    const lifecycleToken = this.lifecycleToken;
    let connectingClient = null;
    try {
      const client = await this.clientFactory();
      connectingClient = client;
      await client.start();
      const tools = await client.listTools();
      if (this.disposed || lifecycleToken !== this.lifecycleToken) {
        client.close();
        return this.status;
      }
      if (typeof client.on === 'function') {
        client.on('notification', message => {
          if (message && message.method === 'notifications/tools/list_changed') {
            this.discoveryDirty = true;
            this.officialSessionIds.clear();
          }
        });
        const revokeConnectionAuthority = () => {
          if (this.client !== client) return;
          this.officialSessionIds.clear();
          this.status = {
            ...this.status,
            available: false,
            code: 'ASIDE_MCP_DISCONNECTED',
            reason: 'Aside MCP disconnected.',
            capabilities: discoverAsideTools([]).capabilities,
          };
        };
        client.on('process-error', revokeConnectionAuthority);
        client.on('exit', revokeConnectionAuthority);
      }
      this.discovery = discoverAsideTools(tools);
      this.discoveryDirty = false;
      this.client = client;
      connectingClient = null;
      const hasList = this.discovery.capabilities.list;
      this.status = {
        id: ASIDE_MANIFEST.id,
        available: true,
        platformSupported: true,
        reason: hasList ? '' : 'Aside MCP connected, but it did not expose a compatible task list tool.',
        code: hasList ? 'ASIDE_AVAILABLE' : 'ASIDE_MCP_NO_TASK_LIST',
        capabilities: { ...this.discovery.capabilities },
        toolNames: [...this.discovery.toolNames],
        tools: tools.map(tool => ({
          name: String(tool && tool.name || ''),
          description: String(tool && tool.description || ''),
          inputSchema: tool && (tool.inputSchema || tool.input_schema) || {},
        })),
        serverInfo: client.serverInfo,
        protocolVersion: client.protocolVersion,
      };
    } catch (error) {
      if (connectingClient && typeof connectingClient.close === 'function') connectingClient.close();
      if (this.client) this.client.close();
      this.client = null;
      this.discovery = discoverAsideTools([]);
      this.status = {
        id: ASIDE_MANIFEST.id,
        available: false,
        platformSupported: true,
        reason: `Aside MCP is unavailable: ${boundedErrorMessage(error)}`,
        code: 'ASIDE_MCP_UNAVAILABLE',
        capabilities: this.discovery.capabilities,
        toolNames: [],
        tools: [],
      };
      this.officialSessionIds.clear();
    }
    return this.status;
  }

  async scan(options = {}) {
    const status = await this.probe();
    if (status.available && status.capabilities.list && this.client) {
      try {
        const official = await scanOfficialAside(this.client, this.discovery, options);
        this.officialSessionIds = new Set(official.sessions.map(session => session.externalId));
        return { ...official, status: this.status, errors: [] };
      } catch (error) {
        this.officialSessionIds.clear();
        const fallback = this.scanFolders(options);
        const message = boundedErrorMessage(error, 'Aside MCP task scan failed.');
        return {
          ...fallback,
          status: { ...this.status, code: 'ASIDE_MCP_SCAN_FAILED', reason: message },
          errors: [{ source: 'official-mcp', message }, ...fallback.errors],
        };
      }
    }
    if (status.platformSupported) {
      const fallback = this.scanFolders(options);
      return { ...fallback, status };
    }
    return { sessions: [], errors: [], roots: [], mode: 'unavailable', readOnly: true, status };
  }

  scanFolders(options = {}) {
    const result = scanAsideHistoryFolders(this.taskFolders, { ...this.options, ...options, cache: this.folderCache });
    if (result.sessions.length || !result.errors.length || !this.lastFolderScan) {
      this.lastFolderScan = result;
      return result;
    }
    return {
      ...this.lastFolderScan,
      errors: result.errors,
      stale: true,
      reason: 'A selected Aside transcript is being updated; showing the last complete read.',
    };
  }

  async detail(sessionId, options = {}) {
    const status = await this.probe();
    if (status.available && status.capabilities.detail && this.client) {
      try {
        const official = await detailOfficialAside(this.client, this.discovery, sessionId);
        if (official) {
          this.officialSessionIds.add(official.externalId);
          return official;
        }
      } catch (_error) {
        // A selected-folder record may not exist in the official MCP server.
      }
    }
    if (!status.platformSupported) return null;
    return detailAsideHistorySession(this.taskFolders, sessionId, { ...this.options, ...options, cache: this.folderCache });
  }

  async control(action, input = {}) {
    if (action && typeof action === 'object') {
      input = action;
      action = input.action;
    }
    const status = await this.probe();
    const operation = action === 'continue' || action === 'sendInstruction' ? 'send' : action;
    if (!['start', 'send', 'stop', 'archive', 'delete'].includes(operation)) {
      const error = new Error(`Unsupported Aside control action: ${action}`);
      error.code = 'ASIDE_ACTION_INVALID';
      throw error;
    }
    if (!status.platformSupported) throw unavailableCapability(operation);
    if (operation === 'start') {
      if (status.available && this.client && this.discovery.operations.start) {
        return controlOfficialAside(this.client, this.discovery, operation, input);
      }
      return this.startWithCli(input);
    }
    if (operation !== 'start') {
      const externalId = safeOfficialSessionId(input.taskId || input.sessionId || input.externalId || input.id);
      if (!this.officialSessionIds.has(externalId)) {
        const error = new Error('Aside control requires a session id verified by the official MCP server.');
        error.code = 'ASIDE_CONTROL_AUTHORITY_REQUIRED';
        throw error;
      }
    }
    if (operation === 'send' && status.platformSupported && !this.discovery.operations.send) {
      return this.continueWithCli(input);
    }
    if (!status.available || !this.client) throw unavailableCapability(action);
    return controlOfficialAside(this.client, this.discovery, action, input, {
      verifiedSessionIds: this.officialSessionIds,
    });
  }

  startWithCli(input = {}) {
    const prompt = String(input.prompt || input.message || input.text || input.instruction || '')
      .replace(/\u0000/g, '').trim();
    if (!prompt || prompt.length > 120_000) {
      const error = new Error('Aside task prompt is empty or too long.');
      error.code = 'ASIDE_INPUT_INVALID';
      return Promise.reject(error);
    }
    return this.launchCli([prompt], input, 'start', '');
  }

  continueWithCli(input = {}) {
    const externalId = safeOfficialSessionId(input.taskId || input.sessionId || input.externalId || input.id);
    const prompt = String(input.prompt || input.message || input.text || input.instruction || '').replace(/\u0000/g, '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/.test(externalId)) {
      const error = new Error('Aside session id is invalid.');
      error.code = 'ASIDE_INPUT_INVALID';
      return Promise.reject(error);
    }
    if (!this.officialSessionIds.has(externalId)) {
      const error = new Error('Aside continuation requires a session id verified by the official MCP server.');
      error.code = 'ASIDE_CONTROL_AUTHORITY_REQUIRED';
      return Promise.reject(error);
    }
    if (!prompt || prompt.length > 120_000) {
      const error = new Error('Aside continuation prompt is empty or too long.');
      error.code = 'ASIDE_INPUT_INVALID';
      return Promise.reject(error);
    }
    return this.launchCli(['--session', externalId, prompt], input, 'continue', externalId);
  }

  launchCli(args, input = {}, action, externalId) {
    const requestedCwd = input.cwd || this.options.cwd || '';
    let cwd;
    if (requestedCwd) {
      try {
        cwd = path.resolve(String(requestedCwd));
        if (!path.isAbsolute(String(requestedCwd)) || !fs.statSync(cwd).isDirectory()) {
          throw new Error('not a directory');
        }
      } catch (_error) {
        const error = new Error('Aside CLI working directory is invalid.');
        error.code = 'ASIDE_INPUT_INVALID';
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.cliSpawnImpl(this.options.command || this.options.executable || ASIDE_MANIFEST.command,
          args, {
            cwd,
            env: this.options.env || process.env,
            detached: true,
            windowsHide: true,
            shell: false,
            stdio: 'ignore',
          });
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      child.once('error', error => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        if (typeof child.unref === 'function') child.unref();
        resolve({ accepted: true, mode: 'official-cli', action, pid: child.pid, externalId });
      });
    });
  }

  close() {
    this.disposed = true;
    this.lifecycleToken += 1;
    this.officialSessionIds.clear();
    this.discoveryDirty = false;
    this.discovery = discoverAsideTools([]);
    if (this.client) this.client.close();
    this.client = null;
    this.status = {
      ...this.status,
      available: false,
      code: 'ASIDE_ADAPTER_CLOSED',
      reason: 'Aside adapter is closed.',
      capabilities: this.discovery.capabilities,
    };
  }

  dispose() {
    this.close();
  }
}

function createAsideAdapter(options = {}) {
  return new AsideAdapter(options);
}

class AsideHistoryMonitor {
  constructor(options = {}) {
    this.options = options;
    this.taskFolders = Array.isArray(options.historyFolders)
      ? [...options.historyFolders]
      : Array.isArray(options.taskFolders) ? [...options.taskFolders] : [];
    this.lastScan = null;
    this.folderCache = new Map();
  }

  watchRoots() {
    if (!asidePlatformStatus({ platform: this.options.platform || process.platform, release: this.options.release,
      macOSMajor: this.options.macOSMajor }).supported) return [];
    return canonicalRoots(this.taskFolders, this.options.fileSystem);
  }

  scan(options = {}) {
    const platform = asidePlatformStatus({ platform: this.options.platform || process.platform,
      release: this.options.release, macOSMajor: this.options.macOSMajor });
    if (!platform.supported) {
      return {
        sessions: [], errors: [], roots: [], mode: 'unavailable', readOnly: true,
        status: { available: false, state: 'unavailable', reason: platform.reason, capabilities: {} },
      };
    }
    const result = scanAsideHistoryFolders(this.taskFolders, { ...this.options, ...options, cache: this.folderCache });
    if (result.sessions.length || !result.errors.length || !this.lastScan) this.lastScan = result;
    const effective = result.sessions.length || !result.errors.length || !this.lastScan
      ? result
      : { ...this.lastScan, errors: result.errors, stale: true };
    const validRoots = canonicalRoots(this.taskFolders, this.options.fileSystem);
    return {
      ...effective,
      status: {
        available: validRoots.length > 0,
        state: validRoots.length > 0 ? 'ready' : 'degraded',
        reason: validRoots.length > 0 ? '' : 'Select an Aside task folder to import local history.',
        capabilities: {
          start: false,
          sendInstruction: false,
          stop: false,
          archive: false,
          delete: false,
          live: validRoots.length > 0,
          readConversation: true,
          readSteps: true,
          readTabs: true,
          readArtifacts: true,
        },
      },
    };
  }

  detail(sessionId) {
    if (!asidePlatformStatus({ platform: this.options.platform || process.platform, release: this.options.release,
      macOSMajor: this.options.macOSMajor }).supported) return null;
    return detailAsideHistorySession(this.taskFolders, sessionId, { ...this.options, cache: this.folderCache });
  }

  close() {}
}

function createAsideHistoryMonitor(options = {}) {
  return new AsideHistoryMonitor(options);
}

function createAsideController(options = {}) {
  return new AsideAdapter({
    ...options,
    taskFolders: options.taskFolders || options.historyFolders || options.settings?.asideHistoryFolders || [],
    command: options.command || options.executable || ASIDE_MANIFEST.command,
  });
}

async function probeAside(options = {}) {
  const adapter = createAsideAdapter(options);
  try {
    return await adapter.probe();
  } finally {
    adapter.close();
  }
}

module.exports = {
  ASIDE_MANIFEST,
  AsideAdapter,
  AsideHistoryMonitor,
  callDiscoveredTool,
  controlOfficialAside,
  createAsideAdapter,
  createAsideController,
  createAsideHistoryMonitor,
  detailOfficialAside,
  extractAsideTaskRows,
  normalizeOfficialTask,
  normalizeOfficialArtifactPath,
  probeAside,
  scanOfficialAside,
  unwrapAsideToolResult,
  redactBrowserUrl,
};
