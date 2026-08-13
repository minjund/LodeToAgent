'use strict';

const path = require('path');

const SOURCE_PLUGIN_API_VERSION = 1;
const SOURCE_SESSION_ID_LIMIT = 500;

function cleanText(value, limit = 240) {
  const text = String(value == null ? '' : value).replace(/\u0000/g, '').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function platformKind(value = process.platform) {
  return value === 'win32' ? 'windows' : value === 'darwin' ? 'macos' : 'linux';
}

function providerFamily(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (/anthropic|claude/.test(provider)) return 'claude';
  if (/google|gemini/.test(provider)) return 'gemini';
  if (/xai|grok/.test(provider)) return 'grok';
  return 'codex';
}

function providerLabel(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'google') return 'Google';
  if (provider === 'xai') return 'xAI';
  if (provider === 'moonshot') return 'Moonshot AI';
  if (provider === 'opencode') return 'OpenCode';
  return cleanText(value || 'Unknown', 80);
}

function validateManifest(raw) {
  const manifest = raw && typeof raw === 'object' ? raw : {};
  if (manifest.apiVersion !== SOURCE_PLUGIN_API_VERSION) throw new Error('지원하지 않는 source plugin API 버전입니다.');
  if (!/^builtin\.[a-z0-9-]{1,64}$/.test(String(manifest.id || ''))) throw new Error('source plugin ID가 올바르지 않습니다.');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(manifest.version || ''))) throw new Error('source plugin 버전이 올바르지 않습니다.');
  const sourceId = String(manifest.source && manifest.source.id || '');
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(sourceId)) throw new Error('source ID가 올바르지 않습니다.');
  const platforms = Array.isArray(manifest.platforms) ? manifest.platforms : [];
  if (!platforms.length || platforms.some(item => !['win32', 'darwin', 'linux'].includes(item))) throw new Error('source plugin 플랫폼 목록이 올바르지 않습니다.');
  return Object.freeze({
    ...manifest,
    id: String(manifest.id),
    name: cleanText(manifest.name || sourceId, 80),
    version: String(manifest.version),
    source: Object.freeze({ id: sourceId, label: cleanText(manifest.source.label || sourceId, 80) }),
    platforms: Object.freeze([...new Set(platforms)]),
    capabilities: Object.freeze({
      history: Object.freeze({
        list: Boolean(manifest.capabilities?.history?.list),
        detail: Boolean(manifest.capabilities?.history?.detail),
      }),
      live: Boolean(manifest.capabilities?.live),
      control: Object.freeze({
        start: Boolean(manifest.capabilities?.control?.start),
        sendInstruction: Boolean(manifest.capabilities?.control?.sendInstruction),
        stop: Boolean(manifest.capabilities?.control?.stop),
        archive: Boolean(manifest.capabilities?.control?.archive),
        delete: Boolean(manifest.capabilities?.control?.delete),
      }),
    }),
  });
}

function canonicalSessionId(pluginId, externalId) {
  const owner = String(pluginId || '');
  const external = cleanText(externalId, SOURCE_SESSION_ID_LIMIT);
  if (!/^builtin\.[a-z0-9-]{1,64}$/.test(owner) || !external) throw new Error('source session ID를 만들 수 없습니다.');
  return `${owner}:${external}`;
}

function normalizedCapabilities(value = {}, fallback = {}) {
  const requested = value && typeof value === 'object' ? value : {};
  const defaults = fallback && typeof fallback === 'object' ? fallback : {};
  const bool = key => requested[key] == null ? Boolean(defaults[key]) : Boolean(requested[key]);
  return {
    managed: false,
    respond: requested.respond == null ? bool('sendInstruction') : Boolean(requested.respond),
    approve: Boolean(requested.approve),
    deny: Boolean(requested.deny),
    sendInstruction: bool('sendInstruction'),
    continue: bool('sendInstruction'),
    start: bool('start'),
    stop: bool('stop'),
    pause: false,
    resume: Boolean(requested.resume),
    retry: false,
    reassign: false,
    archive: bool('archive'),
    delete: bool('delete'),
    openOrigin: false,
    readConversation: Boolean(requested.readConversation),
    readSteps: Boolean(requested.readSteps),
    readTabs: Boolean(requested.readTabs),
    readArtifacts: Boolean(requested.readArtifacts),
    live: bool('live'),
    pty: false,
  };
}

function normalizeSourceSession(raw, manifest, options = {}) {
  const externalId = cleanText(raw && (raw.externalId || raw.id), SOURCE_SESSION_ID_LIMIT);
  if (!externalId) return null;
  const id = canonicalSessionId(manifest.id, externalId);
  const parentExternalId = cleanText(raw.parentExternalId || raw.parentId, SOURCE_SESSION_ID_LIMIT);
  const actualProvider = cleanText(raw.modelProvider || raw.provenance?.provider?.id || raw.provenance?.modelProvider?.id || raw.providerId || '', 80).toLowerCase();
  const family = ['claude', 'codex', 'gemini', 'grok'].includes(raw.provider)
    ? raw.provider
    : providerFamily(actualProvider || raw.provider);
  const environment = cleanText(raw.environment?.kind || raw.runtimeEnvironment?.kind || raw.runtimeEnvironment?.platform || raw.provenance?.environment?.kind || raw.provenance?.runtime?.platform || platformKind(options.platform), 32).toLowerCase();
  const runtimeKind = cleanText(raw.provenance?.runtime?.kind || raw.terminalBackend || 'application', 48).toLowerCase();
  const sourceCapabilities = normalizedCapabilities(raw.sourceControlCapabilities || raw.controlCapabilities, {
    ...manifest.capabilities.control,
    live: manifest.capabilities.live,
  });
  const updatedAt = raw.updatedAt && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : new Date().toISOString();
  return {
    ...raw,
    id,
    externalId,
    parentId: parentExternalId ? canonicalSessionId(manifest.id, parentExternalId.replace(`${manifest.id}:`, '')) : null,
    provider: family,
    modelProvider: actualProvider,
    modelProviderLabel: cleanText(raw.modelProviderLabel || providerLabel(actualProvider), 80),
    orchestrator: manifest.source.id,
    sourcePluginId: manifest.id,
    sourcePlugin: {
      id: manifest.id,
      version: manifest.version,
      revision: cleanText(raw.sourcePlugin?.revision || raw.revision || updatedAt, 180),
    },
    source: raw.source || `${manifest.source.id}-history`,
    sourceLabel: manifest.source.label,
    clientKind: raw.clientKind || `${manifest.source.id}-application`,
    environment: raw.environment && typeof raw.environment === 'object'
      ? { ...raw.environment, kind: environment }
      : { kind: environment, label: environment === 'macos' ? 'macOS' : environment === 'windows' ? 'Windows' : environment === 'wsl' ? 'WSL' : 'Linux' },
    terminalBackend: runtimeKind,
    provenance: {
      source: { id: manifest.source.id, label: manifest.source.label, pluginId: manifest.id },
      provider: { id: actualProvider, label: cleanText(raw.modelProviderLabel || providerLabel(actualProvider), 80), family },
      environment: raw.provenance?.environment || (raw.environment && typeof raw.environment === 'object'
        ? raw.environment
        : { kind: environment, label: environment }),
      runtime: {
        ...(raw.provenance?.runtime || {}),
        kind: raw.provenance?.runtime?.kind || raw.provenance?.runtime?.backend || runtimeKind,
        label: raw.provenance?.runtime?.label || cleanText(raw.runtimeLabel || raw.provenance?.runtime?.backend || runtimeKind, 80),
        id: raw.provenance?.runtime?.id || '',
        managed: Boolean(raw.provenance?.runtime?.managed),
      },
    },
    presentation: { ...(raw.presentation || {}), conversationSurface: 'transcript' },
    controlCapabilities: sourceCapabilities,
    sourceControlCapabilities: sourceCapabilities,
    controlUnavailableReasons: raw.controlUnavailableReasons || {},
    resources: raw.resources || { browserTabs: [] },
    updatedAt,
  };
}

function ensureContainedPath(root, candidate) {
  const fs = require('fs');
  const base = fs.realpathSync(path.resolve(root));
  const resolved = fs.realpathSync(path.resolve(candidate));
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('선택한 폴더 밖의 경로는 읽을 수 없습니다.');
  return resolved;
}

module.exports = {
  SOURCE_PLUGIN_API_VERSION,
  SOURCE_SESSION_ID_LIMIT,
  canonicalSessionId,
  cleanText,
  ensureContainedPath,
  normalizeSourceSession,
  normalizedCapabilities,
  platformKind,
  providerFamily,
  providerLabel,
  validateManifest,
};
