'use strict';

const fs = require('fs');
const path = require('path');

const MAX_FILES_PER_PROVIDER = 80;
const MAX_JSONL_BYTES = 12 * 1024 * 1024;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const JSONL_HEAD_CHUNK_BYTES = 64 * 1024;
const MAX_JSONL_HEAD_BYTES = 2 * 1024 * 1024;

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

function rowTimestamp(row) {
  const value = row && row.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Number.isFinite(Date.parse(String(value || ''))) ? value : null;
}

function readJsonLinesHead(fileDescriptor, size) {
  const limit = Math.min(size, MAX_JSONL_HEAD_BYTES);
  let position = 0;
  let pending = Buffer.alloc(0);
  let headerLine = '';
  let headerCaptured = false;
  let firstTimestamp = null;
  while (position < limit && (!headerCaptured || firstTimestamp == null)) {
    const chunk = readRange(fileDescriptor, position, Math.min(JSONL_HEAD_CHUNK_BYTES, limit - position));
    if (!chunk.length) break;
    position += chunk.length;
    const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let lineStart = 0;
    while (lineStart < buffer.length) {
      const newline = buffer.indexOf(10, lineStart);
      if (newline < 0) break;
      const carriageReturn = newline > lineStart && buffer[newline - 1] === 13;
      const line = buffer.subarray(lineStart, carriageReturn ? newline - 1 : newline).toString('utf8');
      if (!headerCaptured) {
        headerLine = line;
        headerCaptured = true;
      }
      if (firstTimestamp == null && line.trim()) firstTimestamp = rowTimestamp(parseJsonText(line));
      lineStart = newline + 1;
      if (headerCaptured && firstTimestamp != null) break;
    }
    if (headerCaptured && firstTimestamp != null) break;
    pending = buffer.subarray(lineStart);
  }
  return { headerLine, firstTimestamp };
}

function appendJsonLines(text, rows) {
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim()) {
      const row = parseJsonText(line);
      if (row) rows.push(row);
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
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
      ({ headerLine, firstTimestamp } = readJsonLinesHead(fd, stat.size));
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
  appendJsonLines(text, rows);
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

function jsonlReadBudget(size, maxBytes = MAX_JSONL_BYTES) {
  const fileSize = Number.isFinite(Number(size)) ? Math.max(0, Number(size)) : 0;
  const tailBytes = boundedBytes(maxBytes, MAX_JSONL_BYTES, MAX_JSONL_BYTES);
  return Math.min(fileSize, tailBytes)
    + (fileSize > tailBytes ? Math.min(fileSize, MAX_JSONL_HEAD_BYTES) : 0);
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
  jsonlReadBudget,
  safeStat,
  walkRecent,
};
