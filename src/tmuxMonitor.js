'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const FIELD_SEPARATOR = '|~|';
const DEFAULT_SCAN_TTL_MS = 5_000;
const DEFAULT_DISCOVERY_TTL_MS = 60_000;

function decodeCommandOutput(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.replace(/\u0000/g, '');
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const hasNullBytes = buffer.subarray(0, Math.min(buffer.length, 200)).some(byte => byte === 0);
  return buffer.toString(hasNullBytes ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').replace(/\u0000/g, '');
}

function normalizeWslList(value) {
  return [...new Set(decodeCommandOutput(value)
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(item => item && !/^docker-desktop(?:-data)?$/i.test(item)))];
}

function uncHomeFor(distro, linuxHome) {
  const parts = String(linuxHome || '').split('/').filter(Boolean);
  if (!distro || !parts.length) return '';
  return `\\\\wsl.localhost\\${distro}\\${parts.join('\\')}`;
}

function linuxPathToUnc(distro, linuxPath) {
  const parts = String(linuxPath || '').split('/').filter(Boolean);
  if (!distro || !parts.length) return '';
  return `\\\\wsl.localhost\\${distro}\\${parts.join('\\')}`;
}

function providerFromProcess(processInfo = {}) {
  const command = String(processInfo.command || '').toLowerCase();
  const args = String(processInfo.args || '').toLowerCase();
  if (command === 'claude' || /(?:^|\/)claude(?:\s|$)/.test(args) || /@anthropic-ai\/claude-code/.test(args)) return 'claude';
  if (/^codex(?:-|$)/.test(command) || /@openai\/codex/.test(args) || /(?:^|\/)bin\/codex(?:\s|$)/.test(args)) return 'codex';
  if (/^gemini(?:-|$)/.test(command) || /@google\/gemini-cli/.test(args) || /(?:^|\/)bin\/gemini(?:\s|$)/.test(args)) return 'gemini';
  if (/^grok(?:-|$)/.test(command) || /@xai-org\/grok/.test(args) || /(?:^|\/)bin\/grok(?:\s|$)/.test(args)) return 'grok';
  return '';
}

function parseElapsedSeconds(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return Number(text || 0);
  return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
}

function parseProcessLine(value) {
  const match = String(value || '').trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    elapsedSeconds: parseElapsedSeconds(match[3]),
    command: match[4],
    args: match[5] || match[4],
  };
}

function parseTmuxProbe(value, distro, now = Date.now(), kind = 'wsl') {
  const output = decodeCommandOutput(value);
  const meta = { linuxHome: '', tmuxVersion: '' };
  const panes = [];
  const processes = [];
  const historyFiles = { claude: [], codex: [], gemini: [], grok: [] };
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) continue;
    const parts = rawLine.split(FIELD_SEPARATOR);
    if (parts[0] === 'M') {
      meta.linuxHome = parts[1] || '';
      meta.tmuxVersion = parts[2] || '';
    } else if (parts[0] === 'P' && parts.length >= 18) {
      panes.push({
        sessionNativeId: parts[1],
        sessionName: parts[2],
        sessionCreatedAt: Number(parts[3]) ? new Date(Number(parts[3]) * 1000).toISOString() : null,
        sessionAttached: Number(parts[4]) > 0,
        sessionWindows: Number(parts[5] || 0),
        windowNativeId: parts[6],
        windowIndex: Number(parts[7] || 0),
        windowName: parts[8] || 'window',
        windowActive: parts[9] === '1',
        paneNativeId: parts[10],
        paneIndex: Number(parts[11] || 0),
        pid: Number(parts[12] || 0),
        currentCommand: parts[13] || '',
        cwd: parts[14] || '',
        active: parts[15] === '1',
        dead: parts[16] === '1',
        title: parts[17] || '',
      });
    } else if (parts[0] === 'R') {
      const processInfo = parseProcessLine(parts.slice(1).join(FIELD_SEPARATOR));
      if (processInfo) {
        processInfo.startedAt = new Date(now - processInfo.elapsedSeconds * 1000).toISOString();
        processes.push(processInfo);
      }
    } else if (parts[0] === 'F' && historyFiles[parts[1]] && parts.length >= 5) {
      const linuxPath = parts.slice(4).join(FIELD_SEPARATOR);
      if (linuxPath) historyFiles[parts[1]].push({
        file: linuxPath,
        mtimeMs: Math.round(Number(parts[2] || 0) * 1000),
        size: Number(parts[3] || 0),
      });
    }
  }
  return { distro, kind, ...meta, panes, processes, historyFiles };
}

function descendantProcesses(rootPid, processes) {
  const byParent = new Map();
  for (const item of processes) {
    if (!byParent.has(item.parentPid)) byParent.set(item.parentPid, []);
    byParent.get(item.parentPid).push(item);
  }
  const result = [];
  const queue = [Number(rootPid || 0)];
  const seen = new Set(queue);
  while (queue.length) {
    const parentPid = queue.shift();
    for (const child of byParent.get(parentPid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

function selectAgentProcess(pane, processes) {
  const direct = processes.find(item => item.pid === pane.pid);
  const candidates = [direct, ...descendantProcesses(pane.pid, processes)].filter(Boolean);
  const detected = candidates
    .map(item => ({ ...item, provider: providerFromProcess(item) }))
    .filter(item => item.provider);
  if (!detected.length) return null;
  return detected.sort((a, b) => {
    const binaryA = a.command === a.provider ? 1 : 0;
    const binaryB = b.command === b.provider ? 1 : 0;
    return binaryB - binaryA || b.pid - a.pid;
  })[0];
}

function buildDistroTopology(probe) {
  const distroId = `${probe.kind || 'wsl'}:${probe.distro}`;
  const sessionsById = new Map();
  for (const rawPane of probe.panes) {
    const sessionId = `${distroId}:tmux:${rawPane.sessionNativeId}`;
    if (!sessionsById.has(sessionId)) {
      sessionsById.set(sessionId, {
        id: sessionId,
        nativeId: rawPane.sessionNativeId,
        name: rawPane.sessionName,
        createdAt: rawPane.sessionCreatedAt,
        attached: rawPane.sessionAttached,
        windowCount: rawPane.sessionWindows,
        windows: [],
      });
    }
    const session = sessionsById.get(sessionId);
    let window = session.windows.find(item => item.nativeId === rawPane.windowNativeId);
    if (!window) {
      window = {
        id: `${sessionId}:window:${rawPane.windowNativeId}`,
        nativeId: rawPane.windowNativeId,
        index: rawPane.windowIndex,
        name: rawPane.windowName,
        active: rawPane.windowActive,
        panes: [],
      };
      session.windows.push(window);
    }
    const agentProcess = selectAgentProcess(rawPane, probe.processes);
    window.panes.push({
      id: `${window.id}:pane:${rawPane.paneNativeId}`,
      nativeId: rawPane.paneNativeId,
      index: rawPane.paneIndex,
      pid: rawPane.pid,
      command: rawPane.currentCommand,
      cwd: rawPane.cwd,
      active: rawPane.active,
      dead: rawPane.dead,
      title: rawPane.title,
      agentProcess: agentProcess ? {
        provider: agentProcess.provider,
        pid: agentProcess.pid,
        parentPid: agentProcess.parentPid,
        command: agentProcess.command,
        args: String(agentProcess.args || '').slice(0, 500),
        startedAt: agentProcess.startedAt,
      } : null,
      agent: null,
    });
  }
  const sessions = [...sessionsById.values()]
    .map(session => ({
      ...session,
      windows: session.windows
        .map(window => ({ ...window, panes: window.panes.sort((a, b) => a.index - b.index) }))
        .sort((a, b) => a.index - b.index),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: distroId,
    name: probe.distro,
    kind: probe.kind || 'wsl',
    linuxHome: probe.linuxHome,
    uncHome: probe.kind === 'wsl' ? uncHomeFor(probe.distro, probe.linuxHome) : '',
    tmuxInstalled: Boolean(probe.tmuxVersion),
    tmuxVersion: probe.tmuxVersion,
    historyFiles: probe.historyFiles,
    error: '',
    sessions,
  };
}

function normalizeCwd(value) {
  let text = String(value || '').trim().replace(/\\/g, '/');
  const drive = text.match(/^([a-z]):\/(.*)$/i);
  if (drive) text = `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
  return text.replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();
}

function sessionEnvironmentMatches(session, distro) {
  if (!session.environment) return false;
  if (distro.kind === 'local') return session.environment.kind === 'macos' || session.environment.kind === 'linux';
  return session.environment.kind === 'wsl'
    && String(session.environment.distro || '').toLowerCase() === String(distro.name || '').toLowerCase();
}

function linkScore(session, pane, distro, processInfo, now = Date.now()) {
  if (!session || session.provider !== processInfo.provider) return -Infinity;
  let score = 0;
  const sessionCwd = normalizeCwd(session.cwd);
  const paneCwd = normalizeCwd(pane.cwd);
  if (sessionCwd && paneCwd && sessionCwd === paneCwd) score += 2_000;
  else if (sessionCwd && paneCwd && (sessionCwd.startsWith(`${paneCwd}/`) || paneCwd.startsWith(`${sessionCwd}/`))) score += 500;
  if (sessionEnvironmentMatches(session, distro)) score += 1_500;
  else if (session.environment && session.environment.kind === 'wsl') score -= 2_000;
  if (session.status === 'running') score += 500;
  const updatedDeltaMinutes = Math.abs(now - Date.parse(session.updatedAt || 0)) / 60_000;
  score += Math.max(0, 360 - updatedDeltaMinutes);
  const processStarted = Date.parse(processInfo.startedAt || 0);
  const sessionStarted = Date.parse(session.startedAt || 0);
  if (Number.isFinite(processStarted) && Number.isFinite(sessionStarted)) {
    score += Math.max(0, 240 - Math.abs(processStarted - sessionStarted) / 60_000);
  }
  return score;
}

function linkAgentSessions(snapshot, agentSessions, now = Date.now()) {
  const result = structuredClone(snapshot);
  const usedSessionIds = new Set();
  let paneCount = 0;
  let aiPaneCount = 0;
  let linkedCount = 0;
  let windowCount = 0;
  let tmuxSessionCount = 0;
  for (const distro of result.distros || []) {
    for (const tmuxSession of distro.sessions || []) {
      tmuxSessionCount += 1;
      for (const window of tmuxSession.windows || []) {
        windowCount += 1;
        for (const pane of window.panes || []) {
          paneCount += 1;
          if (!pane.agentProcess) continue;
          aiPaneCount += 1;
          const ranked = (agentSessions || [])
            .filter(session => !usedSessionIds.has(session.id))
            .map(session => ({ session, score: linkScore(session, pane, distro, pane.agentProcess, now) }))
            .filter(item => item.score >= 1_000)
            .sort((a, b) => b.score - a.score);
          const linked = ranked[0] && ranked[0].session;
          if (linked) {
            usedSessionIds.add(linked.id);
            linkedCount += 1;
          }
          pane.agent = {
            provider: pane.agentProcess.provider,
            pid: pane.agentProcess.pid,
            command: pane.agentProcess.command,
            args: pane.agentProcess.args,
            startedAt: pane.agentProcess.startedAt,
            linkedSessionId: linked && linked.id || null,
            title: linked && linked.title || `${pane.agentProcess.provider} tmux 작업`,
            model: linked && linked.model || '',
            status: pane.dead ? 'failed' : 'running',
            statusDetail: linked && linked.statusDetail || `${pane.command || pane.agentProcess.command} 프로세스 실행 중`,
            updatedAt: linked && linked.updatedAt || new Date(now).toISOString(),
            context: linked && linked.context || { used: 0, window: 0, percent: 0, source: 'unknown' },
            usage: linked && linked.usage || { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
            childIds: linked && linked.childIds || [],
            agentName: linked && linked.agentName || '',
            linkScore: ranked[0] && Math.round(ranked[0].score) || 0,
          };
        }
      }
    }
  }
  result.summary = {
    distros: (result.distros || []).filter(item => item.tmuxInstalled).length,
    sessions: tmuxSessionCount,
    windows: windowCount,
    panes: paneCount,
    aiPanes: aiPaneCount,
    linked: linkedCount,
  };
  return result;
}

class TmuxMonitor {
  constructor(options = {}) {
    this.execFileSync = options.execFileSync || execFileSync;
    this.platform = options.platform || process.platform;
    this.scanTtlMs = options.scanTtlMs || DEFAULT_SCAN_TTL_MS;
    this.discoveryTtlMs = options.discoveryTtlMs || DEFAULT_DISCOVERY_TTL_MS;
    this.lastDiscoveryAt = 0;
    this.lastScanAt = 0;
    this.distros = [];
    this.lastGoodByDistro = new Map();
    this.lastSnapshot = { generatedAt: new Date().toISOString(), available: false, status: '확인 중', distros: [], summary: { distros: 0, sessions: 0, windows: 0, panes: 0, aiPanes: 0, linked: 0 } };
  }

  discoverDistros(force = false) {
    if (!force && Date.now() - this.lastDiscoveryAt < this.discoveryTtlMs) return this.distros;
    this.lastDiscoveryAt = Date.now();
    if (this.platform === 'darwin') {
      this.distros = ['macOS'];
      return this.distros;
    }
    if (this.platform !== 'win32') {
      this.distros = ['로컬'];
      return this.distros;
    }
    try {
      const output = this.execFileSync('wsl.exe', ['--list', '--quiet'], { windowsHide: true, timeout: 5_000, maxBuffer: 256 * 1024 });
      this.distros = normalizeWslList(output);
    } catch {
      this.distros = [];
    }
    return this.distros;
  }

  probeDistro(distro) {
    const common = [
      'printf "M|~|%s|~|" "$HOME"',
      "tmux -V 2>/dev/null | tr ' ' '_' || true",
      'if command -v tmux >/dev/null 2>&1; then tmux list-panes -a -F "P|~|#{session_id}|~|#{session_name}|~|#{session_created}|~|#{session_attached}|~|#{session_windows}|~|#{window_id}|~|#{window_index}|~|#{window_name}|~|#{window_active}|~|#{pane_id}|~|#{pane_index}|~|#{pane_pid}|~|#{pane_current_command}|~|#{pane_current_path}|~|#{pane_active}|~|#{pane_dead}|~|#{pane_title}" 2>/dev/null || true; fi',
    ];
    const history = [
      'ps -eo pid=,ppid=,etimes=,comm=,args= 2>/dev/null | sed "s/^/R|~|/"',
      'find "$HOME/.claude/projects" -type f -name "*.jsonl" -printf "%T@ %s %p\\n" 2>/dev/null | sort -nr | head -80 | while read -r MT SZ FILE; do printf "F|~|claude|~|%s|~|%s|~|%s\\n" "\\$MT" "\\$SZ" "\\$FILE"; done',
      'find "$HOME/.codex/sessions" -type f -name "*.jsonl" -printf "%T@ %s %p\\n" 2>/dev/null | sort -nr | head -80 | while read -r MT SZ FILE; do printf "F|~|codex|~|%s|~|%s|~|%s\\n" "\\$MT" "\\$SZ" "\\$FILE"; done',
      'find "$HOME/.gemini/tmp" -type f \\( -name "*.json" -o -name "*.jsonl" \\) -printf "%T@ %s %p\\n" 2>/dev/null | sort -nr | head -50 | while read -r MT SZ FILE; do printf "F|~|gemini|~|%s|~|%s|~|%s\\n" "\\$MT" "\\$SZ" "\\$FILE"; done',
      'find "$HOME/.grok/sessions" -type f \\( -name "*.json" -o -name "*.jsonl" \\) -printf "%T@ %s %p\\n" 2>/dev/null | sort -nr | head -50 | while read -r MT SZ FILE; do printf "F|~|grok|~|%s|~|%s|~|%s\\n" "\\$MT" "\\$SZ" "\\$FILE"; done',
    ];
    const localProcess = 'ps -axo pid=,ppid=,etime=,comm=,args= 2>/dev/null | sed "s/^/R|~|/"';
    const command = [...common, ...(this.platform === 'win32' ? history : [localProcess])].join('; ');
    const file = this.platform === 'win32' ? 'wsl.exe' : (process.env.SHELL || '/bin/sh');
    const args = this.platform === 'win32' ? ['-d', distro, '--', 'sh', '-lc', command] : ['-lc', command];
    const output = this.execFileSync(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const topology = buildDistroTopology(parseTmuxProbe(output, distro, Date.now(), this.platform === 'win32' ? 'wsl' : 'local'));
    topology.tmuxVersion = topology.tmuxVersion.replace(/_/g, ' ');
    return topology;
  }

  scan(force = false) {
    if (!force && Date.now() - this.lastScanAt < this.scanTtlMs) return this.lastSnapshot;
    this.lastScanAt = Date.now();
    const distros = this.discoverDistros(force);
    const results = [];
    for (const distro of distros) {
      try {
        const topology = this.probeDistro(distro);
        if (topology.tmuxInstalled) {
          this.lastGoodByDistro.set(distro, topology);
          results.push(topology);
        }
      } catch (error) {
        const previous = this.lastGoodByDistro.get(distro);
        if (previous) results.push({ ...structuredClone(previous), error: String(error.message || error), stale: true });
      }
    }
    this.lastSnapshot = {
      generatedAt: new Date().toISOString(),
      available: results.length > 0,
      status: results.some(item => item.sessions.length) ? '연결됨' : (results.length ? 'tmux 설치됨 · 실행 세션 없음' : (distros.length ? 'tmux 미설치 또는 서버 없음' : (this.platform === 'win32' ? 'WSL 배포판 없음' : '로컬 환경 없음'))),
      distros: results,
      summary: { distros: results.length, sessions: 0, windows: 0, panes: 0, aiPanes: 0, linked: 0 },
    };
    return this.lastSnapshot;
  }

  historyHomes() {
    return (this.lastSnapshot.distros || [])
      .filter(item => item.kind === 'wsl' && item.uncHome)
      .map(item => ({
        home: item.uncHome,
        kind: 'wsl',
        distro: item.name,
        label: `WSL · ${item.name}`,
        files: Object.fromEntries(Object.entries(item.historyFiles || {}).map(([provider, files]) => [provider, files.slice(0, 40).map(info => ({ ...info, file: linuxPathToUnc(item.name, info.file) }))])),
      }));
  }
}

module.exports = {
  TmuxMonitor,
  normalizeWslList,
  parseTmuxProbe,
  parseProcessLine,
  parseElapsedSeconds,
  providerFromProcess,
  buildDistroTopology,
  linkAgentSessions,
  normalizeCwd,
  uncHomeFor,
  linuxPathToUnc,
};
