'use strict';

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CACHE_TTL_MS = 60_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
let cached = null;
let cachedAt = 0;

function clampPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function windowValue(label, usedPercent, resetsAt, windowMinutes = 0) {
  const used = clampPercent(usedPercent);
  if (used === null) return null;
  const resetDate = resetsAt
    ? new Date(Number(resetsAt) < 10_000_000_000 ? Number(resetsAt) * 1000 : resetsAt)
    : null;
  return {
    label,
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    resetsAt: resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : '',
    windowMinutes: Number(windowMinutes || 0),
  };
}

async function newestJsonlFiles(root, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(entries.map(async entry => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return newestJsonlFiles(target, depth + 1);
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return [];
    try {
      const stat = await fsp.stat(target);
      return [{ file: target, mtimeMs: stat.mtimeMs, size: stat.size }];
    } catch {
      return [];
    }
  }));
  return nested.flat();
}

async function readTail(file, size) {
  const length = Math.min(Number(size || 0), MAX_LOG_BYTES);
  if (!length) return '';
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function codexRateLimitsFromText(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"rate_limits"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const limits = event?.payload?.rate_limits || event?.rate_limits;
    if (!limits) continue;
    return limits;
  }
  return null;
}

async function collectCodexUsage(home) {
  const roots = [
    path.join(home, '.codex', 'sessions'),
    path.join(home, '.codex', 'archived_sessions'),
  ];
  const files = (await Promise.all(roots.map(root => newestJsonlFiles(root))))
    .flat()
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 24);
  for (const item of files) {
    let limits;
    try { limits = codexRateLimitsFromText(await readTail(item.file, item.size)); } catch { limits = null; }
    if (!limits) continue;
    return {
      provider: 'codex',
      available: true,
      source: 'codex-session',
      plan: String(limits.plan_type || ''),
      shortWindow: windowValue(
        Number(limits.primary?.window_minutes) === 300 ? '5시간 한도' : '단기 한도',
        limits.primary?.used_percent,
        limits.primary?.resets_at,
        limits.primary?.window_minutes,
      ),
      weekly: windowValue(
        Number(limits.secondary?.window_minutes) === 10080 ? '주간 한도' : '장기 한도',
        limits.secondary?.used_percent,
        limits.secondary?.resets_at,
        limits.secondary?.window_minutes,
      ),
      updatedAt: new Date(item.mtimeMs).toISOString(),
    };
  }
  return { provider: 'codex', available: false, source: 'codex-session', reason: 'usage-not-observed' };
}

function execFileText(file, args, timeout = 3000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || '').trim());
    });
  });
}

async function claudeAccessToken(home) {
  try {
    if (process.platform === 'darwin') {
      const raw = await execFileText('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
      return JSON.parse(raw)?.claudeAiOauth?.accessToken || '';
    }
    const raw = await fsp.readFile(path.join(home, '.claude', '.credentials.json'), 'utf8');
    return JSON.parse(raw)?.claudeAiOauth?.accessToken || '';
  } catch {
    return '';
  }
}

async function collectClaudeUsage(home) {
  const token = await claudeAccessToken(home);
  if (!token) return { provider: 'claude', available: false, source: 'anthropic-oauth', reason: 'not-signed-in' };
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { provider: 'claude', available: false, source: 'anthropic-oauth', reason: `http-${response.status}` };
    }
    const usage = await response.json();
    return {
      provider: 'claude',
      available: true,
      source: 'anthropic-oauth',
      plan: '',
      shortWindow: windowValue('5시간 한도', usage?.five_hour?.utilization, usage?.five_hour?.resets_at, 300),
      weekly: windowValue('주간 한도', usage?.seven_day?.utilization, usage?.seven_day?.resets_at, 10080),
      modelWindow: windowValue('Sonnet 주간 한도', usage?.seven_day_sonnet?.utilization, usage?.seven_day_sonnet?.resets_at, 10080),
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return { provider: 'claude', available: false, source: 'anthropic-oauth', reason: 'request-failed' };
  }
}

async function collectProviderUsage(options = {}) {
  const force = Boolean(options.force);
  if (!force && cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  const home = os.homedir();
  const [claude, codex] = await Promise.all([
    collectClaudeUsage(home),
    collectCodexUsage(home),
  ]);
  cached = {
    generatedAt: new Date().toISOString(),
    providers: {
      claude,
      codex,
      gemini: { provider: 'gemini', available: false, source: 'provider', reason: 'usage-not-supported' },
      grok: { provider: 'grok', available: false, source: 'provider', reason: 'usage-not-supported' },
    },
  };
  cachedAt = Date.now();
  return cached;
}

module.exports = {
  clampPercent,
  windowValue,
  codexRateLimitsFromText,
  collectProviderUsage,
};
