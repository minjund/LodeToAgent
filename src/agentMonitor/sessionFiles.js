'use strict';

const fs = require('fs');
const path = require('path');

const MAX_FILES_PER_PROVIDER = 80;
const MAX_JSONL_BYTES = 12 * 1024 * 1024;
const MAX_JSON_BYTES = 12 * 1024 * 1024;

function safeStat(file) {
  try { return fs.statSync(file); } catch (_missingOrUnreadableFile) { return null; }
}

function boundedBytes(value, fallback, ceiling) {
  const requested = Number(value);
  const normalized = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : fallback;
  return Math.max(1, Math.min(normalized, ceiling));
}

function readRange(fileDescriptor, start, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fileDescriptor, buffer, offset, length - offset, start + offset);
    if (!read) break;
    offset += read;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

function readJson(file, fallback = null, maxBytes = MAX_JSON_BYTES) {
  const stat = safeStat(file);
  const limit = boundedBytes(maxBytes, MAX_JSON_BYTES, MAX_JSON_BYTES);
  if (!stat || !stat.isFile() || stat.size > limit) return fallback;
  let fileDescriptor = null;
  try {
    fileDescriptor = fs.openSync(file, 'r');
    return JSON.parse(readRange(fileDescriptor, 0, stat.size).toString('utf8'));
  } catch (_missingOrPartialJson) {
    return fallback;
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
  }
}

function parseJsonText(text) {
  try { return JSON.parse(text); } catch (_plainTextPayload) { return null; }
}

function firstJsonLineTimestamp(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = parseJsonText(line);
    const value = row && row.timestamp;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Number.isFinite(Date.parse(String(value || '')))) return value;
  }
  return null;
}

function readJsonLines(file, maxBytes = MAX_JSONL_BYTES) {
  const stat = safeStat(file);
  if (!stat || !stat.isFile()) return { rows: [], truncated: false, firstTimestamp: null };
  const limit = boundedBytes(maxBytes, MAX_JSONL_BYTES, MAX_JSONL_BYTES);
  const start = Math.max(0, stat.size - limit);
  const length = stat.size - start;
  const fd = fs.openSync(file, 'r');
  let buffer = Buffer.alloc(0);
  let headerLine = '';
  let firstTimestamp = null;
  try {
    buffer = readRange(fd, start, length);
    if (start > 0) {
      const headLength = Math.min(stat.size, 2 * 1024 * 1024);
      const head = readRange(fd, 0, headLength);
      firstTimestamp = firstJsonLineTimestamp(head.toString('utf8'));
      const newline = head.indexOf(10);
      if (newline >= 0) {
        headerLine = head.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString('utf8');
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline >= 0 ? text.slice(newline + 1) : '';
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = parseJsonText(line);
    if (row) rows.push(row);
  }
  if (headerLine) {
    const header = parseJsonText(headerLine);
    if (header && header.type === 'session_meta') rows.unshift(header);
  }
  if (firstTimestamp == null) {
    const firstTimestampedRow = rows.find(row => {
      const value = row && row.timestamp;
      return (typeof value === 'number' && Number.isFinite(value))
        || Number.isFinite(Date.parse(String(value || '')));
    });
    firstTimestamp = firstTimestampedRow ? firstTimestampedRow.timestamp : null;
  }
  return { rows, truncated: start > 0, firstTimestamp };
}

function walkRecent(root, predicate, max = MAX_FILES_PER_PROVIDER, maxDepth = 6) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_unreadableDirectory) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      if (!entry.isFile() || !predicate(full, entry.name)) continue;
      const stat = safeStat(full);
      if (stat) out.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max);
}

module.exports = {
  MAX_FILES_PER_PROVIDER,
  MAX_JSON_BYTES,
  MAX_JSONL_BYTES,
  readJson,
  readJsonLines,
  safeStat,
  walkRecent,
};
