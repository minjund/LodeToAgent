'use strict';

const { normalizeSourceSession, normalizedCapabilities, validateManifest } = require('./contracts');
const { bundledSourceDefinitions } = require('./bundled');

const SCAN_TIMEOUT_MS = 12_000;

function withTimeout(value, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 시간이 초과되었습니다.`)), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

class SourcePluginMonitorHost {
  constructor(options = {}) {
    this.home = options.home;
    this.platform = options.platform || process.platform;
    this.settings = options.settings || {};
    this.definitions = options.definitions || bundledSourceDefinitions(options);
    this.monitors = new Map();
    this.statuses = new Map();
    this.sessions = new Map();
    this.external = new Map();
    this.runtimeStatuses = new Map();
    this.initialize();
  }

  initialize() {
    const ids = new Set();
    for (const definition of this.definitions) {
      const manifest = validateManifest(definition.manifest);
      if (ids.has(manifest.id)) throw new Error(`중복 source plugin ID: ${manifest.id}`);
      ids.add(manifest.id);
      if (!manifest.platforms.includes(this.platform)) {
        this.statuses.set(manifest.id, {
          id: manifest.id, source: manifest.source, name: manifest.name, available: false, state: 'unavailable',
          reason: manifest.id === 'builtin.aside' ? 'Aside Browser는 현재 macOS 15 이상에서만 사용할 수 있습니다.' : '현재 운영체제에서 지원하지 않습니다.',
          capabilities: normalizedCapabilities({}, {}),
        });
        continue;
      }
      try {
        const monitor = definition.createMonitor({
          home: this.home,
          platform: this.platform,
          settings: this.settings,
          historyFolders: this.settings.asideHistoryFolders || [],
          manifest,
        });
        if (monitor) this.monitors.set(manifest.id, { manifest, monitor });
        this.statuses.set(manifest.id, {
          id: manifest.id, source: manifest.source, name: manifest.name, available: Boolean(monitor),
          state: monitor ? 'ready' : 'degraded', reason: monitor ? '' : '읽을 수 있는 기록원이 없습니다.',
          capabilities: normalizedCapabilities({
            ...manifest.capabilities.control,
            live: manifest.capabilities.live,
            readConversation: manifest.capabilities.history.list,
            readSteps: manifest.capabilities.history.detail,
            readTabs: manifest.id === 'builtin.aside' && manifest.capabilities.history.detail,
            readArtifacts: manifest.capabilities.history.detail,
          }),
        });
      } catch (error) {
        this.statuses.set(manifest.id, {
          id: manifest.id, source: manifest.source, name: manifest.name, available: false, state: 'failed',
          reason: String(error && error.message || error), capabilities: normalizedCapabilities({}, {}),
        });
      }
    }
  }

  setRuntimeStatuses(statuses = []) {
    this.runtimeStatuses.clear();
    for (const status of Array.isArray(statuses) ? statuses : []) {
      if (status && status.id) this.runtimeStatuses.set(String(status.id), status);
    }
  }

  setExternalSnapshot(pluginId, payload = {}) {
    const id = String(pluginId || '');
    const definition = this.definitions.find(item => item.manifest.id === id);
    if (!definition) return false;
    this.external.set(id, {
      sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
      status: payload.status || null,
    });
    return true;
  }

  watchRoots() {
    const roots = [];
    for (const { monitor } of this.monitors.values()) {
      try {
        if (typeof monitor.watchRoots === 'function') roots.push(...(monitor.watchRoots() || []));
      } catch {}
    }
    return [...new Set(roots.filter(Boolean))];
  }

  effectiveStatus(manifest) {
    return this.runtimeStatuses.get(manifest.id)
      || this.external.get(manifest.id)?.status
      || this.statuses.get(manifest.id)
      || null;
  }

  normalizeRows(rows, manifest) {
    const runtime = this.effectiveStatus(manifest);
    const runtimeControls = runtime && runtime.capabilities ? runtime.capabilities : null;
    return (Array.isArray(rows) ? rows : []).map(raw => {
      const observed = raw.sourceControlCapabilities || raw.controlCapabilities || {};
      const readOnlyImport = raw.readOnly === true || raw.controlAuthority === 'read-only-import';
      const officialAside = manifest.id !== 'builtin.aside' || raw.controlAuthority === 'official-session-id';
      const managedStop = manifest.id === 'builtin.omo'
        && Array.isArray(runtime?.managedSessionIds)
        && runtime.managedSessionIds.includes(String(raw.externalId || ''));
      const observedRuntimeIntersection = runtimeControls ? {
        ...observed,
        start: Boolean(runtimeControls.start),
        sendInstruction: Boolean(observed.sendInstruction !== false && runtimeControls.sendInstruction),
        continue: Boolean(observed.continue !== false && (runtimeControls.continue || runtimeControls.sendInstruction)),
        respond: Boolean(observed.respond !== false && (runtimeControls.respond || runtimeControls.sendInstruction)),
        approve: Boolean(observed.approve && runtimeControls.approve),
        deny: Boolean(observed.deny && runtimeControls.deny),
        stop: Boolean((observed.stop && runtimeControls.stop) || (observed.stop && managedStop)),
        resume: Boolean(observed.resume && runtimeControls.resume),
        archive: Boolean(observed.archive && runtimeControls.archive),
        delete: Boolean(observed.delete && runtimeControls.delete),
        live: Boolean(observed.live || runtimeControls.live),
        readConversation: Boolean(observed.readConversation || runtimeControls.readConversation),
        readSteps: Boolean(observed.readSteps || runtimeControls.readSteps),
        readTabs: Boolean(observed.readTabs || runtimeControls.readTabs),
        readArtifacts: Boolean(observed.readArtifacts || runtimeControls.readArtifacts),
        pty: false,
      } : observed;
      const capabilities = readOnlyImport || !officialAside
        ? {
          ...observed,
          start: false, sendInstruction: false, continue: false, respond: false, approve: false, deny: false,
          stop: false, resume: false, archive: false, delete: false, pty: false,
        }
        : observedRuntimeIntersection;
      return normalizeSourceSession({
        ...raw,
        sourceControlCapabilities: capabilities,
        controlUnavailableReasons: readOnlyImport
          ? { ...(raw.controlUnavailableReasons || {}), sendInstruction: '선택 폴더 기록은 읽기 전용입니다.', stop: '선택 폴더 기록은 읽기 전용입니다.', archive: '선택 폴더 기록은 읽기 전용입니다.', delete: '선택 폴더 기록은 읽기 전용입니다.' }
          : runtime?.controlUnavailableReasons || raw.controlUnavailableReasons,
      }, manifest, { platform: this.platform });
    }).filter(Boolean);
  }

  async scan() {
    const collected = [];
    const statuses = [];
    for (const definition of this.definitions) {
      const manifest = definition.manifest;
      const record = this.monitors.get(manifest.id);
      let localRows = [];
      if (record && typeof record.monitor.scan === 'function') {
        try {
          const result = await withTimeout(record.monitor.scan({ limit: 240 }), SCAN_TIMEOUT_MS, `${manifest.name} 기록 조회`);
          localRows = Array.isArray(result) ? result : result?.sessions || [];
          const adapterStatus = !Array.isArray(result) && result?.status ? result.status : (typeof record.monitor.status === 'function' ? record.monitor.status() : null);
          if (adapterStatus) this.statuses.set(manifest.id, { ...this.statuses.get(manifest.id), ...adapterStatus, id: manifest.id, source: manifest.source, name: manifest.name });
        } catch (error) {
          this.statuses.set(manifest.id, {
            ...this.statuses.get(manifest.id), available: false, state: 'degraded', reason: String(error && error.message || error),
          });
        }
      }
      const externalRows = this.external.get(manifest.id)?.sessions || [];
      const byId = new Map();
      for (const row of this.normalizeRows(localRows, manifest)) byId.set(row.id, row);
      // Official connector data wins over folder fallbacks for the same record.
      for (const row of this.normalizeRows(externalRows, manifest)) byId.set(row.id, row);
      for (const row of byId.values()) collected.push(row);
      const status = this.effectiveStatus(manifest) || this.statuses.get(manifest.id);
      statuses.push({ ...status, id: manifest.id, source: manifest.source, name: manifest.name, sessionCount: byId.size });
    }
    this.sessions = new Map(collected.map(session => [session.id, session]));
    return { sessions: collected, statuses };
  }

  owns(sessionId) {
    return this.sessions.has(String(sessionId || ''));
  }

  async detail(sessionId) {
    const card = this.sessions.get(String(sessionId || ''));
    if (!card) return null;
    const owner = this.monitors.get(card.sourcePluginId);
    const external = (this.external.get(card.sourcePluginId)?.sessions || []).find(row => String(row.externalId || row.id) === card.externalId);
    let raw = external || card;
    if (!external && owner && typeof owner.monitor.detail === 'function') {
      raw = await withTimeout(owner.monitor.detail(card.externalId), SCAN_TIMEOUT_MS, `${owner.manifest.name} 상세 기록 조회`) || card;
    }
    return normalizeSourceSession(raw, owner?.manifest || this.definitions.find(item => item.manifest.id === card.sourcePluginId).manifest, { platform: this.platform });
  }

  async dispose() {
    const tasks = [];
    for (const { monitor } of this.monitors.values()) {
      if (typeof monitor.close === 'function') tasks.push(Promise.resolve().then(() => monitor.close()));
      else if (typeof monitor.dispose === 'function') tasks.push(Promise.resolve().then(() => monitor.dispose()));
    }
    await Promise.allSettled(tasks);
    this.monitors.clear();
    this.sessions.clear();
  }
}

module.exports = { SCAN_TIMEOUT_MS, SourcePluginMonitorHost, withTimeout };
