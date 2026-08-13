'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { findExecutable } = require('../agentRunner');
const { ASIDE_MANIFEST, OMO_MANIFEST } = require('./bundled');
const { cleanText, normalizedCapabilities } = require('./contracts');

const DELETE_TOKEN_TTL_MS = 30_000;
const MAX_PROMPT_LENGTH = 120_000;
const MAX_CHILD_OUTPUT = 2 * 1024 * 1024;

function requestId(value) {
  const id = cleanText(value, 160);
  return id || crypto.randomUUID();
}

function safePrompt(value) {
  const prompt = String(value || '').replace(/\u0000/g, '').trim();
  if (!prompt) throw new Error('작업 내용을 입력하세요.');
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error('작업 내용이 너무 깁니다.');
  return prompt;
}

function safeCwd(value) {
  const cwd = path.resolve(String(value || process.cwd()));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('작업 폴더를 찾을 수 없습니다.');
  return cwd;
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, windowsHide: true, maxBuffer: MAX_CHILD_OUTPUT }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: cleanText(stdout, 4000), stderr: cleanText(stderr, 2000) });
    });
  });
}

function emptySourceStatus(manifest, reason, platform = process.platform) {
  return {
    id: manifest.id,
    name: manifest.name,
    source: manifest.source,
    platform,
    installed: false,
    connected: false,
    available: false,
    state: 'unavailable',
    reason,
    capabilities: normalizedCapabilities({}, {}),
    controlUnavailableReasons: {},
  };
}

class SourcePluginControlHost extends EventEmitter {
  constructor(options = {}) {
    super();
    this.platform = options.platform || process.platform;
    this.home = options.home || process.env.USERPROFILE || process.env.HOME || process.cwd();
    this.settingsStore = options.settingsStore || null;
    this.spawn = options.spawn || spawn;
    this.execFile = options.execFile || execFilePromise;
    this.findExecutable = options.findExecutable || findExecutable;
    this.now = options.now || (() => Date.now());
    this.statuses = new Map();
    this.deleteTokens = new Map();
    this.requests = new Map();
    this.children = new Map();
    this.externalSnapshots = {};
    this.aside = null;
    this.disposed = false;
    this.refreshPromise = null;
    this.statuses.set(OMO_MANIFEST.id, emptySourceStatus(OMO_MANIFEST, 'OpenCode CLI를 확인하는 중입니다.', this.platform));
    this.statuses.set(ASIDE_MANIFEST.id, emptySourceStatus(ASIDE_MANIFEST, this.platform === 'darwin'
      ? 'Aside CLI를 확인하는 중입니다.'
      : 'Aside Browser는 현재 macOS 15 이상에서만 사용할 수 있습니다.', this.platform));
  }

  settings() {
    return this.settingsStore ? this.settingsStore.snapshot() : { version: 1, asideHistoryFolders: [] };
  }

  listSources() {
    return [...this.statuses.values()].map(status => {
      const { executable: _privateExecutable, ...publicStatus } = status;
      const managedSessionIds = status.id === OMO_MANIFEST.id
        ? [...new Set([...this.children.values()]
          .filter(record => record.pluginId === status.id && record.externalId)
          .map(record => record.externalId))]
        : [];
      return ({
        ...publicStatus,
        capabilities: { ...(status.capabilities || {}) },
        controlUnavailableReasons: { ...(status.controlUnavailableReasons || {}) },
        managedSessionIds,
      });
    });
  }

  monitorState() {
    return { statuses: this.listSources(), snapshots: { ...this.externalSnapshots } };
  }

  async initialize() {
    await this.refresh();
    return this.listSources();
  }

  async refresh() {
    if (this.disposed) return this.listSources();
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshNow().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async refreshNow() {
    const opencode = this.findExecutable('opencode');
    const omoConfigured = opencode ? require('./bundled/omo').detectOmoConfiguration({ home: this.home }) : false;
    this.statuses.set(OMO_MANIFEST.id, opencode && omoConfigured ? {
      id: OMO_MANIFEST.id,
      name: OMO_MANIFEST.name,
      source: OMO_MANIFEST.source,
      platform: this.platform,
      installed: true,
      connected: true,
      available: true,
      state: 'ready',
      reason: '',
      executable: opencode,
      capabilities: normalizedCapabilities({
        start: true, sendInstruction: true, stop: false, archive: false, delete: true, live: true,
        readConversation: true, readSteps: true, readTabs: false, readArtifacts: true,
      }),
      controlUnavailableReasons: { stop: 'Whitebox에서 시작한 OMO 프로세스만 실행 중에 중지할 수 있습니다.', archive: 'OpenCode CLI는 세션 보관 명령을 제공하지 않습니다.' },
    } : {
      ...emptySourceStatus(OMO_MANIFEST, opencode
        ? 'OpenCode는 설치되어 있지만 Oh My OpenAgent 설정을 찾을 수 없습니다.'
        : 'OpenCode CLI를 찾을 수 없습니다.', this.platform),
      installed: Boolean(opencode),
    });

    if (this.platform !== 'darwin') {
      this.statuses.set(ASIDE_MANIFEST.id, emptySourceStatus(ASIDE_MANIFEST, 'Aside Browser는 현재 macOS 15 이상에서만 사용할 수 있습니다.', this.platform));
      this.externalSnapshots[ASIDE_MANIFEST.id] = { sessions: [], status: this.statuses.get(ASIDE_MANIFEST.id) };
      this.emit('changed', this.monitorState());
      return this.listSources();
    }

    const asideExecutable = this.findExecutable('aside');
    if (!asideExecutable) {
      this.statuses.set(ASIDE_MANIFEST.id, emptySourceStatus(ASIDE_MANIFEST, 'Aside CLI를 찾을 수 없습니다. Aside Developer settings에서 CLI 경로를 확인하세요.', this.platform));
      this.externalSnapshots[ASIDE_MANIFEST.id] = { sessions: [], status: this.statuses.get(ASIDE_MANIFEST.id) };
      this.emit('changed', this.monitorState());
      return this.listSources();
    }

    try {
      if (!this.aside) this.aside = await this.createAsideController(asideExecutable);
      const probe = typeof this.aside.probe === 'function' ? await this.aside.probe() : {};
      if (probe.platformSupported === false) {
        const status = {
          ...emptySourceStatus(ASIDE_MANIFEST, cleanText(probe.reason || 'Aside Browser는 macOS 15 이상이 필요합니다.', 500), this.platform),
          installed: true,
          state: 'unavailable',
        };
        this.statuses.set(ASIDE_MANIFEST.id, status);
        this.externalSnapshots[ASIDE_MANIFEST.id] = { sessions: [], status };
        this.emit('changed', this.monitorState());
        return this.listSources();
      }
      const discovered = probe.capabilities || this.aside.capabilities || {};
      const capabilities = normalizedCapabilities({
        start: true,
        sendInstruction: true,
        stop: Boolean(discovered.stop),
        archive: Boolean(discovered.archive),
        delete: Boolean(discovered.delete),
        live: Boolean(discovered.live || discovered.list),
        readConversation: Boolean(discovered.detail || discovered.readConversation),
        readSteps: Boolean(discovered.detail || discovered.readSteps),
        readTabs: Boolean(discovered.detail || discovered.readTabs),
        readArtifacts: Boolean(discovered.detail || discovered.readArtifacts),
      });
      const unavailable = {};
      if (!capabilities.stop) unavailable.stop = 'Aside MCP가 stop/cancel 도구를 제공하지 않았습니다.';
      if (!capabilities.archive) unavailable.archive = 'Aside MCP가 archive 도구를 제공하지 않았습니다.';
      if (!capabilities.delete) unavailable.delete = 'Aside MCP가 delete/remove 도구를 제공하지 않았습니다.';
      const status = {
        id: ASIDE_MANIFEST.id, name: ASIDE_MANIFEST.name, source: ASIDE_MANIFEST.source,
        platform: this.platform, installed: true, connected: Boolean(probe.available), available: true,
        state: probe.available && discovered.list ? 'ready' : 'degraded',
        reason: !probe.available
          ? cleanText(probe.reason || 'Aside MCP에 연결할 수 없어 CLI 시작과 이어가기만 사용할 수 있습니다.', 500)
          : discovered.list ? '' : 'Aside MCP에 기존 작업 목록 도구가 없어 새로 시작한 작업만 추적합니다.',
        executable: asideExecutable, capabilities, controlUnavailableReasons: unavailable,
        discoveredTools: Array.isArray(probe.tools) ? probe.tools.map(tool => cleanText(tool.name, 120)) : [],
      };
      this.statuses.set(ASIDE_MANIFEST.id, status);
      let sessions = [];
      if (typeof this.aside.scan === 'function' && discovered.list) {
        const result = await this.aside.scan();
        sessions = Array.isArray(result) ? result : result?.sessions || [];
      }
      this.externalSnapshots[ASIDE_MANIFEST.id] = { sessions, status };
    } catch (error) {
      const status = {
        ...emptySourceStatus(ASIDE_MANIFEST, `Aside MCP 연결 실패: ${cleanText(error && error.message || error, 500)}`, this.platform),
        installed: true,
        available: true,
        connected: false,
        state: 'degraded',
        executable: asideExecutable,
        capabilities: normalizedCapabilities({
          start: true, sendInstruction: true, live: false,
          readConversation: false, readSteps: false, readTabs: false, readArtifacts: false,
        }),
        controlUnavailableReasons: {
          stop: 'Aside MCP가 연결되지 않아 기존 작업을 중지할 수 없습니다.',
          archive: 'Aside MCP가 연결되지 않아 작업을 보관할 수 없습니다.',
          delete: 'Aside MCP가 연결되지 않아 작업을 삭제할 수 없습니다.',
        },
      };
      this.statuses.set(ASIDE_MANIFEST.id, status);
      this.externalSnapshots[ASIDE_MANIFEST.id] = { sessions: [], status };
    }
    this.emit('changed', this.monitorState());
    return this.listSources();
  }

  async createAsideController(executable) {
    const adapter = require('./bundled/aside');
    const context = { command: executable, executable, platform: this.platform, home: this.home, settings: this.settings() };
    if (typeof adapter.createAsideController === 'function') return adapter.createAsideController(context);
    if (typeof adapter.AsideController === 'function') return new adapter.AsideController(context);
    if (typeof adapter.AsideMcpConnector === 'function') return new adapter.AsideMcpConnector(context);
    throw new Error('Aside MCP adapter를 불러오지 못했습니다.');
  }

  rememberRequest(id, promise) {
    this.requests.set(id, promise);
    if (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value);
    return promise;
  }

  start(pluginId, raw = {}) {
    if (this.disposed) return Promise.resolve({ ok: false, error: '프로그램이 종료 중입니다.' });
    const id = requestId(raw.requestId);
    if (this.requests.has(id)) return this.requests.get(id);
    const action = Promise.resolve().then(async () => {
      const status = this.statuses.get(String(pluginId || ''));
      if (!status || !status.available || !status.capabilities?.start) throw new Error(status?.reason || '선택한 출처에서 새 작업을 시작할 수 없습니다.');
      const input = { ...raw, prompt: safePrompt(raw.prompt), cwd: safeCwd(raw.cwd), requestId: id };
      if (pluginId === OMO_MANIFEST.id) return this.startCliProcess({ pluginId, executable: status.executable, input, args: this.omoArgs(input) });
      if (pluginId === ASIDE_MANIFEST.id) {
        if (this.aside && typeof this.aside.start === 'function') return this.aside.start(input);
        return this.startCliProcess({ pluginId, executable: status.executable, input, args: [input.prompt] });
      }
      throw new Error('알 수 없는 source plugin입니다.');
    }).then(result => ({ ok: true, accepted: true, requestId: id, ...result }), error => ({ ok: false, accepted: false, requestId: id, error: cleanText(error && error.message || error, 1000) }));
    return this.rememberRequest(id, action);
  }

  omoArgs(input) {
    const args = ['run', '--format', 'json', '--dir', input.cwd];
    if (input.externalId) args.push('--session', input.externalId);
    if (input.model) args.push('--model', cleanText(input.model, 160));
    if (input.agent) args.push('--agent', cleanText(input.agent, 160));
    args.push(input.prompt);
    return args;
  }

  startCliProcess({ pluginId, executable, input, args }) {
    const child = this.spawn(executable, args, {
      cwd: input.cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      detached: this.platform !== 'win32', windowsHide: true, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = {
      id: input.requestId, pluginId, child, externalId: input.externalId || '', outputBytes: 0,
      stdoutDecoder: new StringDecoder('utf8'), stderrDecoder: new StringDecoder('utf8'), stdoutBuffer: '', stopping: false,
    };
    this.children.set(record.id, record);
    const consumeStdout = (chunk) => {
      if (record.outputBytes >= MAX_CHILD_OUTPUT) return;
      record.outputBytes += chunk.length;
      record.stdoutBuffer += record.stdoutDecoder.write(chunk);
      const lines = record.stdoutBuffer.split(/\r?\n/);
      record.stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const externalId = event.sessionID || event.sessionId || event.session_id || event.session?.id;
          if (externalId) {
            const nextExternalId = cleanText(externalId, 500);
            if (nextExternalId && nextExternalId !== record.externalId) {
              record.externalId = nextExternalId;
              this.emit('changed', this.monitorState());
            }
          }
        } catch {}
      }
    };
    child.stdout?.on('data', consumeStdout);
    // stderr is deliberately not parsed or returned. It can contain prompts,
    // paths, or account context and is not an authoritative session-ID source.
    child.stderr?.on('data', chunk => { record.outputBytes = Math.min(MAX_CHILD_OUTPUT, record.outputBytes + chunk.length); });
    child.once('error', () => { this.children.delete(record.id); this.emit('changed', this.monitorState()); });
    child.once('exit', () => { this.children.delete(record.id); this.emit('changed', this.monitorState()); });
    this.emit('changed', this.monitorState());
    return { pid: child.pid, processId: record.id, externalId: record.externalId };
  }

  async control(session, action, raw = {}) {
    if (!session || !session.sourcePluginId || !session.externalId) throw new Error('조작할 source session을 찾을 수 없습니다.');
    const status = this.statuses.get(session.sourcePluginId);
    const capability = action === 'send' ? 'sendInstruction' : action;
    if (!['send', 'stop', 'archive', 'delete'].includes(action)) throw new Error('지원하지 않는 source session 조작입니다.');
    if (session.sourcePluginId === ASIDE_MANIFEST.id) {
      if (session.readOnly === true || session.controlAuthority !== 'official-session-id') {
        throw new Error('사용자가 선택한 Aside 폴더 기록은 읽기 전용입니다. 공식 Aside 세션 ID만 조작할 수 있습니다.');
      }
      const sessionCapabilities = session.sourceControlCapabilities || session.controlCapabilities || {};
      if (!sessionCapabilities[capability]) throw new Error(session.controlUnavailableReasons?.[capability] || '이 Aside 세션에는 해당 조작 권한이 없습니다.');
    }
    if (!status?.capabilities?.[capability] && !(action === 'stop' && this.managedChild(session))) {
      throw new Error(status?.controlUnavailableReasons?.[capability] || `${action} 기능을 사용할 수 없습니다.`);
    }
    if (action === 'delete') this.consumeDeleteToken(session, raw.deleteToken);
    if (action === 'send') {
      const prompt = safePrompt(raw.prompt || raw.input);
      const id = requestId(raw.requestId);
      if (this.requests.has(id)) return this.requests.get(id);
      const promise = session.sourcePluginId === OMO_MANIFEST.id
        ? this.start(OMO_MANIFEST.id, { ...raw, prompt, cwd: session.cwd, externalId: session.externalId, requestId: id })
        : this.controlAside(session, 'sendInstruction', { ...raw, prompt, requestId: id });
      return this.rememberRequest(id, Promise.resolve(promise));
    }
    if (action === 'stop') {
      const child = this.managedChild(session);
      if (child) return this.stopChild(child);
    }
    if (session.sourcePluginId === OMO_MANIFEST.id) {
      if (action === 'delete') {
        await this.execFile(status.executable, ['session', 'delete', session.externalId], { cwd: session.cwd || this.home });
        this.emit('changed', this.monitorState());
        return { ok: true, accepted: true };
      }
      throw new Error('OpenCode CLI가 이 조작을 제공하지 않습니다.');
    }
    return this.controlAside(session, action, raw);
  }

  async controlAside(session, action, raw) {
    if (!this.aside || typeof this.aside.control !== 'function') throw new Error('Aside MCP 조작 도구가 연결되지 않았습니다.');
    const result = await this.aside.control({ externalId: session.externalId, sessionId: session.externalId, action, ...raw });
    await this.refresh();
    return result;
  }

  managedChild(session) {
    return [...this.children.values()].find(item => item.pluginId === session.sourcePluginId && item.externalId && item.externalId === session.externalId) || null;
  }

  stopChild(record) {
    if (record.stopping) return { ok: true, accepted: true };
    record.stopping = true;
    if (this.platform === 'win32') {
      execFile('taskkill', ['/PID', String(record.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try { process.kill(-record.child.pid, 'SIGTERM'); } catch { record.child.kill('SIGTERM'); }
    }
    return { ok: true, accepted: true };
  }

  prepareDelete(session) {
    if (!session || !session.id || !session.sourcePluginId || !session.externalId) throw new Error('삭제할 source session을 찾을 수 없습니다.');
    const status = this.statuses.get(session.sourcePluginId);
    if (session.sourcePluginId === ASIDE_MANIFEST.id
      && (session.readOnly === true || session.controlAuthority !== 'official-session-id' || !(session.sourceControlCapabilities || session.controlCapabilities || {}).delete)) {
      throw new Error('읽기 전용 Aside 기록은 삭제할 수 없습니다. 공식 Aside 세션의 delete 도구가 확인되어야 합니다.');
    }
    if (!status?.capabilities?.delete) throw new Error(status?.controlUnavailableReasons?.delete || '이 출처는 삭제를 지원하지 않습니다.');
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = this.now() + DELETE_TOKEN_TTL_MS;
    this.deleteTokens.set(token, {
      sessionId: session.id,
      externalId: session.externalId,
      revision: String(session.sourcePlugin?.revision || session.updatedAt || ''),
      expiresAt,
    });
    return { token, expiresAt, title: cleanText(session.title, 180), sourceLabel: cleanText(session.sourceLabel, 80) };
  }

  consumeDeleteToken(session, tokenValue) {
    const token = String(tokenValue || '');
    const record = this.deleteTokens.get(token);
    this.deleteTokens.delete(token);
    if (!record || record.expiresAt < this.now()) throw new Error('삭제 확인이 만료되었습니다. 다시 확인해 주세요.');
    if (record.sessionId !== session.id || record.externalId !== session.externalId) throw new Error('삭제 확인 대상이 현재 작업과 다릅니다.');
    if (record.revision !== String(session.sourcePlugin?.revision || session.updatedAt || '')) throw new Error('작업이 변경되어 삭제 확인을 다시 받아야 합니다.');
    return true;
  }

  async detail(session) {
    if (session?.sourcePluginId !== ASIDE_MANIFEST.id || !this.aside || typeof this.aside.detail !== 'function') return null;
    return this.aside.detail(session.externalId);
  }

  async dispose() {
    this.disposed = true;
    for (const record of this.children.values()) this.stopChild(record);
    this.children.clear();
    this.deleteTokens.clear();
    if (this.aside && typeof this.aside.dispose === 'function') await this.aside.dispose();
    this.aside = null;
  }
}

module.exports = {
  DELETE_TOKEN_TTL_MS,
  MAX_CHILD_OUTPUT,
  MAX_PROMPT_LENGTH,
  SourcePluginControlHost,
  emptySourceStatus,
  safeCwd,
  safePrompt,
};
