'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_KEYS = new Set([
  'version',
  'id',
  'kind',
  'name',
  'status',
  'rrule',
  'model',
  'reasoning_effort',
  'execution_environment',
  'target_thread_id',
  'cwds',
  'created_at',
  'updated_at',
]);

const WEEKDAYS = Object.freeze({ SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 });

function parseQuoted(value) {
  try {
    return JSON.parse(value);
  } catch (_invalidQuotedValue) {
    return value.slice(1, -1);
  }
}

function parseTomlValue(raw) {
  const value = String(raw || '').trim();
  if (value.startsWith('"') && value.endsWith('"')) return parseQuoted(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    const strings = [...value.matchAll(/"(?:\\.|[^"\\])*"/g)].map(match => parseQuoted(match[0]));
    return strings;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  return value;
}

/** Parse only non-sensitive fields used by the dashboard. Prompt text is intentionally discarded. */
function parseAutomationToml(source) {
  const parsed = {};
  let multilineDelimiter = '';
  for (const line of String(source || '').split(/\r?\n/)) {
    if (multilineDelimiter) {
      if (line.includes(multilineDelimiter)) multilineDelimiter = '';
      continue;
    }
    const match = line.match(/^\s*([a-zA-Z][\w]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const triple = match[2].startsWith('"""') ? '"""' : (match[2].startsWith("'''") ? "'''" : '');
    if (triple) {
      if (!match[2].slice(3).includes(triple)) multilineDelimiter = triple;
      continue;
    }
    if (!PUBLIC_KEYS.has(match[1])) continue;
    parsed[match[1]] = parseTomlValue(match[2]);
  }
  return parsed;
}

function parseRRule(value) {
  const output = {};
  for (const pair of String(value || '').split(';')) {
    const [key, raw] = pair.split('=', 2);
    if (key && raw != null) output[key.trim().toUpperCase()] = raw.trim();
  }
  return output;
}

function localCandidate(base, dayOffset, hour, minute, second = 0) {
  const candidate = new Date(base);
  candidate.setHours(hour, minute, second, 0);
  candidate.setDate(candidate.getDate() + dayOffset);
  return candidate;
}

function nextDaily(rule, now, anchor) {
  const hours = String(rule.BYHOUR || '0').split(',').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const minutes = String(rule.BYMINUTE || '0').split(',').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const anchorDay = new Date(anchor || now);
  anchorDay.setHours(0, 0, 0, 0);
  for (let offset = 0; offset <= interval + 2; offset += 1) {
    const day = localCandidate(now, offset, 0, 0);
    day.setHours(0, 0, 0, 0);
    const elapsedDays = Math.round((day.getTime() - anchorDay.getTime()) / 86_400_000);
    if (elapsedDays >= 0 && elapsedDays % interval !== 0) continue;
    for (const hour of hours) for (const minute of minutes) {
      const candidate = localCandidate(now, offset, hour, minute);
      if (candidate > now) return candidate;
    }
  }
  return null;
}

function nextHourly(rule, now, anchorValue) {
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const minutes = String(rule.BYMINUTE || String(now.getMinutes())).split(',').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const anchor = new Date(anchorValue || now);
  anchor.setMinutes(0, 0, 0);
  for (let offset = 0; offset <= interval * 2 + 2; offset += 1) {
    for (const minute of minutes) {
      const candidate = new Date(now);
      candidate.setMinutes(minute, 0, 0);
      candidate.setHours(candidate.getHours() + offset);
      const candidateHour = new Date(candidate);
      candidateHour.setMinutes(0, 0, 0);
      const elapsedHours = Math.round((candidateHour.getTime() - anchor.getTime()) / 3_600_000);
      if (candidate > now && elapsedHours >= 0 && elapsedHours % interval === 0) return candidate;
    }
  }
  return null;
}

function nextWeekly(rule, now, anchorValue) {
  const days = String(rule.BYDAY || Object.keys(WEEKDAYS)[now.getDay()]).split(',')
    .map(value => WEEKDAYS[value.slice(-2).toUpperCase()])
    .filter(Number.isFinite);
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const hour = Number(String(rule.BYHOUR || '0').split(',')[0]);
  const minute = Number(String(rule.BYMINUTE || '0').split(',')[0]);
  const anchorWeek = new Date(anchorValue || now);
  anchorWeek.setHours(0, 0, 0, 0);
  anchorWeek.setDate(anchorWeek.getDate() - anchorWeek.getDay());
  for (let offset = 0; offset <= interval * 14 + 7; offset += 1) {
    const candidate = localCandidate(now, offset, hour, minute);
    const candidateWeek = new Date(candidate);
    candidateWeek.setHours(0, 0, 0, 0);
    candidateWeek.setDate(candidateWeek.getDate() - candidateWeek.getDay());
    const elapsedWeeks = Math.round((candidateWeek.getTime() - anchorWeek.getTime()) / (7 * 86_400_000));
    if (days.includes(candidate.getDay()) && candidate > now && elapsedWeeks >= 0 && elapsedWeeks % interval === 0) return candidate;
  }
  return null;
}

function nextMinutely(rule, now, anchorValue) {
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const anchor = new Date(anchorValue || now);
  anchor.setSeconds(0, 0);
  for (let offset = 1; offset <= interval * 2 + 1; offset += 1) {
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + offset);
    const elapsedMinutes = Math.round((candidate.getTime() - anchor.getTime()) / 60_000);
    if (elapsedMinutes >= 0 && elapsedMinutes % interval === 0) return candidate;
  }
  return null;
}

function nextOccurrence(rrule, nowValue = new Date(), anchorValue = null) {
  const now = nowValue instanceof Date ? new Date(nowValue) : new Date(nowValue);
  if (Number.isNaN(now.getTime())) return null;
  const rule = parseRRule(rrule);
  let candidate = null;
  if (rule.FREQ === 'DAILY') candidate = nextDaily(rule, now, anchorValue);
  else if (rule.FREQ === 'HOURLY') candidate = nextHourly(rule, now, anchorValue);
  else if (rule.FREQ === 'WEEKLY') candidate = nextWeekly(rule, now, anchorValue);
  else if (rule.FREQ === 'MINUTELY') candidate = nextMinutely(rule, now, anchorValue);
  if (!candidate) return null;
  if (rule.UNTIL) {
    const until = new Date(rule.UNTIL);
    if (!Number.isNaN(until.getTime()) && candidate > until) return null;
  }
  return candidate.toISOString();
}

function isoTimestamp(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return null;
  const millis = number > 10_000_000_000 ? number : number * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeAutomation(config, file, now) {
  const createdAt = isoTimestamp(config.created_at);
  const status = String(config.status || 'INACTIVE').toUpperCase();
  return {
    id: String(config.id || path.basename(path.dirname(file))),
    kind: String(config.kind || 'automation'),
    name: String(config.name || config.id || 'Codex automation'),
    status,
    enabled: status === 'ACTIVE',
    rrule: String(config.rrule || ''),
    nextRunAt: status === 'ACTIVE' ? nextOccurrence(config.rrule, now, createdAt) : null,
    provider: 'codex',
    model: String(config.model || ''),
    reasoningEffort: String(config.reasoning_effort || ''),
    executionEnvironment: String(config.execution_environment || ''),
    targetThreadId: String(config.target_thread_id || ''),
    cwds: Array.isArray(config.cwds) ? config.cwds.slice(0, 8).map(String) : [],
    createdAt,
    updatedAt: isoTimestamp(config.updated_at),
  };
}

function scanCodexAutomations(options = {}) {
  const home = options.home || '';
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const root = options.root || path.join(home, '.codex', 'automations');
  if (!root || !fs.existsSync(root)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_unreadableAutomationDirectory) {
    return [];
  }
  const automations = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'automation.toml');
    try {
      const source = fs.readFileSync(file, 'utf8');
      automations.push(normalizeAutomation(parseAutomationToml(source), file, now));
    } catch (_unreadableAutomationFile) {
      // One malformed automation must not hide the other schedules.
    }
  }
  return automations.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return Date.parse(a.nextRunAt || 0) - Date.parse(b.nextRunAt || 0) || a.name.localeCompare(b.name);
  });
}

function scanCodexAutomationHomes(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const seen = new Set();
  const homes = (options.homes || []).filter((entry) => {
    const key = String(entry && entry.home || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return homes.flatMap((entry) => scanCodexAutomations({ home: entry.home, now }).map((automation) => ({
    ...automation,
    environment: {
      kind: String(entry.kind || 'external'),
      distro: String(entry.distro || ''),
    },
    sourceLabel: String(entry.label || entry.distro || entry.kind || ''),
  }))).sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return Date.parse(a.nextRunAt || 0) - Date.parse(b.nextRunAt || 0) || a.name.localeCompare(b.name);
  });
}

module.exports = {
  nextOccurrence,
  parseAutomationToml,
  parseRRule,
  scanCodexAutomationHomes,
  scanCodexAutomations,
};
