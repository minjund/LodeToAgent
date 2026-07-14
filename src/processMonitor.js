'use strict';

const { execFileSync } = require('child_process');
const { blankUsage } = require('./providerRegistry');

const DEFAULT_SCAN_TTL_MS = 12_000;
const WMIC_QUERY = "Name='claude.exe' or Name='codex.exe' or Name='node.exe' or Name='gemini.exe' or Name='grok.exe'";

function parseCsvRows(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      field = '';
      if (row.some(item => item.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (row.some(item => item.trim())) rows.push(row);
  }
  if (!rows.length) return [];
  const headerIndex = rows.findIndex(item => item.some(fieldName => fieldName.replace(/^\uFEFF/, '').trim() === 'ProcessId'));
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex].map(item => item.replace(/^\uFEFF/, '').trim());
  return rows.slice(headerIndex + 1).filter(item => item.length >= headers.length).map(values => Object.fromEntries(headers.map((key, index) => [key, values[index] || ''])));
}

function wmiDateToIso(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d*([+-])(\d{3})$/);
  if (!match) return null;
  const offsetMinutes = Number(match[9] || 0);
  const offsetHour = String(Math.floor(offsetMinutes / 60)).padStart(2, '0');
  const offsetMinute = String(offsetMinutes % 60).padStart(2, '0');
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}${match[8]}${offsetHour}:${offsetMinute}`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function providerFromWindowsProcess(processInfo = {}) {
  const name = String(processInfo.name || processInfo.Name || '').toLowerCase();
  const commandLine = String(processInfo.commandLine || processInfo.CommandLine || '');
  const args = commandLine.toLowerCase().replace(/\\/g, '/');
  if (name === 'claude.exe') {
    if (args.includes('/windowsapps/claude_') || args.includes('--type=')) return null;
    if (/^(?:"?[a-z]:)?[^\r\n]*\/\.local\/bin\/claude\.exe"?\s*$/i.test(args) || /^claude(?:\.exe)?\s*$/i.test(args)) return 'claude';
    return null;
  }
  if (name === 'codex.exe') {
    if (args.includes('/windowsapps/openai.codex_') || /\bapp-server\b/.test(args)) return null;
    return 'codex';
  }
  if (name === 'gemini.exe') return args.includes('--type=') ? null : 'gemini';
  if (name === 'grok.exe') return args.includes('--type=') ? null : 'grok';
  if (name !== 'node.exe') return null;
  if (/@openai[\\/]codex|@openai\/codex/.test(args)) return 'codex';
  if (/@anthropic-ai[\\/]claude-code|@anthropic-ai\/claude-code/.test(args)) return 'claude';
  if (/@google[\\/]gemini-cli|@google\/gemini-cli/.test(args)) return 'gemini';
  if (/node_modules[\\/]grok(?:-cli)?/.test(args)) return 'grok';
  return null;
}

function providerFromPosixProcess(processInfo = {}) {
  const name = String(processInfo.name || processInfo.command || '').toLowerCase().split('/').pop();
  const args = String(processInfo.commandLine || processInfo.args || '').toLowerCase();
  if (name === 'claude') return /--type=|\/applications\/claude\.app/.test(args) ? null : 'claude';
  if (name === 'codex' || /^codex-/.test(name)) return /\bapp-server\b|\/applications\/(?:chatgpt|codex)\.app/.test(args) ? null : 'codex';
  if (name === 'gemini') return 'gemini';
  if (name === 'grok') return 'grok';
  if (name !== 'node') return null;
  if (/@openai\/codex/.test(args)) return 'codex';
  if (/@anthropic-ai\/claude-code/.test(args)) return 'claude';
  if (/@google\/gemini-cli/.test(args)) return 'gemini';
  if (/node_modules\/grok(?:-cli)?/.test(args)) return 'grok';
  return null;
}

function elapsedSeconds(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return Number(text || 0);
  return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
}

function posixProcessRows(value, now = Date.now()) {
  return String(value || '').split(/\r?\n/).map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) return null;
    const age = elapsedSeconds(match[3]);
    return {
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      name: match[4],
      commandLine: match[5] || match[4],
      startedAt: new Date(now - age * 1000).toISOString(),
    };
  }).filter(Boolean);
}

function processRows(value) {
  return parseCsvRows(value).map(row => ({
    pid: Number(row.ProcessId || 0),
    parentPid: Number(row.ParentProcessId || 0),
    name: row.Name || '',
    commandLine: row.CommandLine || '',
    startedAt: wmiDateToIso(row.CreationDate),
  })).filter(item => item.pid > 0);
}

function selectAgentProcesses(rows, options = {}) {
  const providerResolver = options.providerResolver || providerFromWindowsProcess;
  const environment = options.environment || 'windows';
  const candidates = rows.map(item => ({ ...item, provider: providerResolver(item) })).filter(item => item.provider);
  const byParent = new Map();
  for (const item of candidates) {
    if (!byParent.has(item.parentPid)) byParent.set(item.parentPid, []);
    byParent.get(item.parentPid).push(item);
  }
  const hasProviderDescendant = item => {
    const queue = [item.pid];
    const seen = new Set(queue);
    while (queue.length) {
      const pid = queue.shift();
      for (const child of byParent.get(pid) || []) {
        if (seen.has(child.pid)) continue;
        if (child.provider === item.provider) return true;
        seen.add(child.pid);
        queue.push(child.pid);
      }
    }
    return false;
  };
  return candidates.filter(item => !hasProviderDescendant(item)).map(item => ({
    id: `${environment}:${item.provider}:${item.pid}`,
    environment,
    provider: item.provider,
    pid: item.pid,
    parentPid: item.parentPid,
    command: String(item.name || '').replace(/\.exe$/i, '').split(/[\\/]/).pop(),
    startedAt: item.startedAt,
  })).sort((a, b) => a.provider.localeCompare(b.provider) || a.pid - b.pid);
}

function utilitySession(session) {
  return /^(?:extract durable memory candidates|approved command prefix saved|you are a memory extraction)/i.test(String(session.title || '').trim());
}

function runtimeLinkScore(session, processInfo, now = Date.now()) {
  if (!session || session.provider !== processInfo.provider) return -Infinity;
  if (!session.environment || session.environment.kind !== processInfo.environment) return -Infinity;
  let score = session.parentId ? -800 : 2_000;
  if (utilitySession(session)) score -= 10_000;
  if (session.status === 'running' || session.status === 'starting') score += 3_000;
  else if (session.status === 'waiting') score += 1_000;
  const ageMinutes = Math.max(0, (now - Date.parse(session.updatedAt || 0)) / 60_000);
  score += Math.max(0, 2_880 - ageMinutes);
  const sessionStart = Date.parse(session.startedAt || 0);
  const processStart = Date.parse(processInfo.startedAt || 0);
  if (Number.isFinite(sessionStart) && Number.isFinite(processStart)) {
    const deltaMinutes = Math.abs(sessionStart - processStart) / 60_000;
    if (deltaMinutes <= 3) score += 6_000;
    else if (deltaMinutes <= 30) score += 2_500;
    else if (deltaMinutes <= 180) score += 800;
  }
  return score;
}

function markRuntime(session, presence) {
  const existing = Array.isArray(session.runtimePresence) ? session.runtimePresence : [];
  if (!existing.some(item => item.id === presence.id)) existing.push(presence);
  session.runtimePresence = existing;
  session.status = 'running';
  session.statusObserved = true;
  session.statusDetail = presence.kind === 'tmux'
    ? `tmux에서 AI 프로세스 실행 중 · PID ${presence.pid}`
    : (presence.kind === 'bridge'
      ? `안전하게 연결된 외부 터미널 · PID ${presence.pid}`
      : `AI CLI 프로세스 실행 중 · PID ${presence.pid}`);
  return session;
}

function syntheticRuntimeSession(processInfo, now = Date.now()) {
  const label = processInfo.provider === 'claude' ? 'Claude' : (processInfo.provider === 'codex' ? 'GPT · Codex' : (processInfo.provider === 'gemini' ? 'Gemini' : 'Grok'));
  const environmentLabel = processInfo.environment === 'macos' ? 'macOS' : (processInfo.environment === 'linux' ? 'Linux' : 'Windows');
  const updatedAt = new Date(now).toISOString();
  return {
    id: `runtime:${processInfo.id}`,
    externalId: `process-${processInfo.pid}`,
    provider: processInfo.provider,
    parentId: null,
    depth: 0,
    agentName: '',
    agentRole: '',
    environment: { kind: processInfo.environment || 'windows', distro: '', label: `${environmentLabel} 실행 프로세스`, home: '' },
    title: `${label} CLI · PID ${processInfo.pid}`,
    model: '',
    cwd: '',
    branch: '',
    workspace: '작업 폴더 확인 중',
    source: 'runtime-process',
    sourceLabel: `${environmentLabel} 실행 프로세스`,
    clientKind: 'external-cli',
    status: 'running',
    statusDetail: `AI CLI 프로세스 실행 중 · PID ${processInfo.pid}`,
    statusObserved: true,
    startedAt: processInfo.startedAt || updatedAt,
    updatedAt,
    endedAt: null,
    truncated: false,
    runId: null,
    usage: blankUsage(),
    turnUsage: blankUsage(),
    context: { used: 0, window: 0, percent: 0, source: 'unknown' },
    childIds: [],
    runtimePresence: [{ ...processInfo, kind: processInfo.environment || 'windows', label: `${environmentLabel} CLI` }],
    messages: [{ id: `runtime:${processInfo.pid}:notice`, role: 'system', type: 'notice', title: '프로세스 감지', text: '실행 중인 AI CLI는 확인했지만 연결할 대화 기록을 아직 찾지 못했습니다.', status: 'running', timestamp: updatedAt }],
    lifecycle: [{ id: `runtime:${processInfo.pid}:start`, type: 'session-start', label: 'AI CLI 프로세스 감지', detail: `PID ${processInfo.pid}`, status: 'running', timestamp: processInfo.startedAt || updatedAt }],
  };
}

function bridgeLinkScore(session, bridge, now = Date.now()) {
  if (!session || session.provider !== bridge.provider) return -Infinity;
  if (!session.environment || session.environment.kind !== bridge.environment) return -Infinity;
  if (session.clientKind === 'codex-desktop' || session.clientKind === 'codex-ide') return -Infinity;
  let score = session.parentId ? -500 : 3_000;
  const sessionCwd = String(session.cwd || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const bridgeCwd = String(bridge.cwd || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  if (sessionCwd && bridgeCwd && sessionCwd === bridgeCwd) score += 8_000;
  const sessionStart = Date.parse(session.startedAt || 0);
  const bridgeStart = Date.parse(bridge.startedAt || 0);
  if (!Number.isFinite(sessionStart) || !Number.isFinite(bridgeStart)) return -Infinity;
  const delta = Math.abs(sessionStart - bridgeStart) / 60_000;
  if (delta > 5) return -Infinity;
  score += delta <= 1 ? 8_000 : 4_000;
  const age = Math.max(0, (now - Date.parse(session.updatedAt || 0)) / 60_000);
  return score + Math.max(0, 720 - age);
}

function syntheticBridgeSession(bridge, now = Date.now()) {
  const session = syntheticRuntimeSession({ ...bridge, id: `bridge:${bridge.id}` }, now);
  session.id = `bridge:${bridge.id}`;
  session.externalId = bridge.id;
  session.title = `${bridge.provider === 'codex' ? 'GPT · Codex' : bridge.provider} 외부 연결`;
  session.cwd = bridge.cwd || '';
  session.workspace = session.cwd ? session.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() : '작업 폴더 확인 중';
  session.source = 'lodestar-bridge';
  session.sourceLabel = 'Lodestar 외부 터미널 브리지';
  session.clientKind = 'lodestar-bridge';
  session.runtimePresence = [{ ...bridge, kind: 'bridge', label: 'Lodestar 외부 터미널 브리지' }];
  session.statusDetail = `안전하게 연결된 외부 터미널 · PID ${bridge.pid}`;
  return session;
}

function applyRuntimePresence(agentSessions, tmuxSnapshot, processSnapshot, now = Date.now(), bridges = []) {
  const sessions = structuredClone(agentSessions || []);
  const byId = new Map(sessions.map(session => [session.id, session]));
  const usedSessionIds = new Set();
  const usedBridgeIds = new Set();
  const bridgePairs = [];
  for (const bridge of bridges || []) {
    for (const session of sessions) {
      const score = bridgeLinkScore(session, bridge, now);
      if (score > 0) bridgePairs.push({ bridge, session, score });
    }
  }
  bridgePairs.sort((a, b) => b.score - a.score);
  for (const pair of bridgePairs) {
    if (usedBridgeIds.has(pair.bridge.id) || usedSessionIds.has(pair.session.id)) continue;
    usedBridgeIds.add(pair.bridge.id);
    usedSessionIds.add(pair.session.id);
    markRuntime(pair.session, { ...pair.bridge, kind: 'bridge', label: 'Lodestar 외부 터미널 브리지', linkScore: Math.round(pair.score) });
  }
  for (const distro of tmuxSnapshot && tmuxSnapshot.distros || []) {
    for (const tmuxSession of distro.sessions || []) {
      for (const window of tmuxSession.windows || []) {
        for (const pane of window.panes || []) {
          const agent = pane.agent;
          const linked = agent && agent.linkedSessionId && byId.get(agent.linkedSessionId);
          if (!linked) continue;
          usedSessionIds.add(linked.id);
          markRuntime(linked, {
            id: `tmux:${distro.name}:${pane.nativeId}`,
            kind: 'tmux',
            label: `${distro.name} · ${tmuxSession.name} · pane ${pane.index}`,
            provider: agent.provider,
            pid: agent.pid,
            startedAt: agent.startedAt,
            cwd: pane.cwd,
          });
        }
      }
    }
  }

  const bridgePids = new Set((bridges || []).map(item => Number(item.pid || 0)).filter(Boolean));
  const processes = (processSnapshot && processSnapshot.processes || []).filter(item => !bridgePids.has(Number(item.pid || 0)));
  const pairs = [];
  for (const processInfo of processes) {
    for (const session of sessions) {
      if (usedSessionIds.has(session.id)) continue;
      const score = runtimeLinkScore(session, processInfo, now);
      if (score > 0) pairs.push({ processInfo, session, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedProcessIds = new Set();
  for (const pair of pairs) {
    if (usedProcessIds.has(pair.processInfo.id) || usedSessionIds.has(pair.session.id)) continue;
    usedProcessIds.add(pair.processInfo.id);
    usedSessionIds.add(pair.session.id);
    const label = pair.processInfo.environment === 'macos' ? 'macOS CLI' : (pair.processInfo.environment === 'linux' ? 'Linux CLI' : 'Windows CLI');
    markRuntime(pair.session, { ...pair.processInfo, kind: pair.processInfo.environment || 'windows', label, linkScore: Math.round(pair.score) });
  }
  for (const processInfo of processes) {
    if (!usedProcessIds.has(processInfo.id)) sessions.push(syntheticRuntimeSession(processInfo, now));
  }
  for (const bridge of bridges || []) {
    if (!usedBridgeIds.has(bridge.id)) sessions.push(syntheticBridgeSession(bridge, now));
  }
  return sessions.sort((a, b) => {
    const liveA = a.status === 'running' || a.status === 'starting' ? 1 : 0;
    const liveB = b.status === 'running' || b.status === 'starting' ? 1 : 0;
    return liveB - liveA || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
  });
}

class ProcessMonitor {
  constructor(options = {}) {
    this.execFileSync = options.execFileSync || execFileSync;
    this.platform = options.platform || process.platform;
    this.scanTtlMs = options.scanTtlMs || DEFAULT_SCAN_TTL_MS;
    this.lastScanAt = 0;
    this.lastSnapshot = { generatedAt: new Date().toISOString(), available: false, processes: [], error: '' };
  }

  scan(force = false) {
    if (!force && Date.now() - this.lastScanAt < this.scanTtlMs) return this.lastSnapshot;
    this.lastScanAt = Date.now();
    try {
      let processes;
      if (this.platform === 'win32') {
        const output = this.execFileSync('wmic.exe', ['process', 'where', WMIC_QUERY, 'get', 'ProcessId,ParentProcessId,CreationDate,Name,CommandLine', '/format:csv'], {
          encoding: 'utf8', windowsHide: true, timeout: 8_000, maxBuffer: 2 * 1024 * 1024,
        });
        processes = selectAgentProcesses(processRows(output));
      } else {
        const output = this.execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,comm=,args='], { encoding: 'utf8', timeout: 8_000, maxBuffer: 2 * 1024 * 1024 });
        const environment = this.platform === 'darwin' ? 'macos' : 'linux';
        processes = selectAgentProcesses(posixProcessRows(output), { providerResolver: providerFromPosixProcess, environment });
      }
      this.lastSnapshot = { generatedAt: new Date().toISOString(), available: true, processes, error: '' };
    } catch (error) {
      this.lastSnapshot = { ...this.lastSnapshot, generatedAt: new Date().toISOString(), error: String(error.message || error) };
    }
    return this.lastSnapshot;
  }
}

module.exports = {
  ProcessMonitor,
  parseCsvRows,
  processRows,
  wmiDateToIso,
  providerFromWindowsProcess,
  providerFromPosixProcess,
  posixProcessRows,
  elapsedSeconds,
  selectAgentProcesses,
  runtimeLinkScore,
  bridgeLinkScore,
  applyRuntimePresence,
};
