#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const MAX_STDIN_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const RUNTIME_SERVICE = 'loadtoagent-attention-hook';
const RUNTIME_PATH = /^\/loadtoagent\/attention\/v1\/([a-f0-9]{32,128})$/iu;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanString(value, maximum = 4_096) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, maximum);
}

function parseArguments(argv = process.argv.slice(2), environment = process.env) {
  let runtimeFile = environment.LOADTOAGENT_ATTENTION_HOOK_FILE
    || path.join(os.homedir(), '.loadtoagent', 'attention-hook.json');
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--runtime-file' && argv[index + 1]) {
      runtimeFile = argv[index + 1];
      index += 1;
    } else if (argv[index].startsWith('--runtime-file=')) {
      runtimeFile = argv[index].slice('--runtime-file='.length);
    }
  }
  return { runtimeFile: path.resolve(runtimeFile) };
}

function readRuntimeIdentity(runtimeFile, options = {}) {
  const fileSystem = options.fs || fs;
  const stat = fileSystem.statSync(runtimeFile);
  if (!stat.isFile() || stat.size < 2 || stat.size > 64 * 1024) throw new Error('Invalid attention hook runtime file.');
  const identity = JSON.parse(fileSystem.readFileSync(runtimeFile, 'utf8'));
  const route = typeof identity?.path === 'string' ? identity.path.match(RUNTIME_PATH) : null;
  if (!isPlainObject(identity)
    || identity.protocol !== 1
    || identity.service !== RUNTIME_SERVICE
    || identity.host !== '127.0.0.1'
    || !Number.isInteger(identity.port)
    || identity.port < 1
    || identity.port > 65_535
    || !route
    || identity.nonce !== route[1]
    || !Number.isInteger(identity.pid)
    || identity.pid < 1) {
    throw new Error('Invalid attention hook runtime identity.');
  }
  return {
    host: '127.0.0.1',
    port: identity.port,
    path: identity.path,
    nonce: identity.nonce,
    pid: identity.pid,
  };
}

function sanitizeOfficialOutput(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return {};
  const specific = value.hookSpecificOutput;
  if (!isPlainObject(specific)) return {};
  if (specific.hookEventName === 'PermissionRequest') {
    const decision = specific.decision;
    if (!isPlainObject(decision) || (decision.behavior !== 'allow' && decision.behavior !== 'deny')) return {};
    const sanitizedDecision = { behavior: decision.behavior };
    if (decision.behavior === 'deny') {
      const message = cleanString(decision.message, 4_096);
      if (message) sanitizedDecision.message = message;
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: sanitizedDecision,
      },
    };
  }
  return {};
}

function readBoundedJson(stream, maximum = MAX_STDIN_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let failed = false;
    stream.on('data', chunk => {
      if (failed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > maximum) {
        failed = true;
        chunks.length = 0;
        const error = new Error('Hook input exceeds the size limit.');
        error.code = 'ATTENTION_HOOK_INPUT_TOO_LARGE';
        reject(error);
        return;
      }
      chunks.push(buffer);
    });
    stream.on('error', error => {
      if (!failed) reject(error);
      failed = true;
    });
    stream.on('end', () => {
      if (failed) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks, received).toString('utf8'));
        if (!isPlainObject(value)) throw new Error('Hook input must be a JSON object.');
        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
    stream.resume();
  });
}

function postHookPayload(identity, payload, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(100, Math.min(24 * 60 * 60 * 1000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
  if (encoded.length > MAX_STDIN_BYTES) return Promise.resolve({});
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request({
      method: 'POST',
      host: identity.host,
      port: identity.port,
      path: identity.path,
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': encoded.length,
        'X-LoadToAgent-Provider': 'codex',
      },
    }, response => {
      const chunks = [];
      let received = 0;
      let overflow = false;
      response.on('data', chunk => {
        if (overflow) return;
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          overflow = true;
          chunks.length = 0;
          response.destroy();
          finish({});
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (overflow || response.statusCode < 200 || response.statusCode >= 300) return finish({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks, received).toString('utf8'));
          finish(sanitizeOfficialOutput(parsed));
        } catch {
          finish({});
        }
      });
      response.on('error', () => finish({}));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish({});
    });
    request.on('error', () => finish({}));
    request.end(encoded);
  });
}

async function run(options = {}) {
  const stdout = options.stdout || process.stdout;
  let output = {};
  try {
    const args = parseArguments(options.argv, options.env || process.env);
    const payload = await readBoundedJson(options.stdin || process.stdin, options.maxInputBytes || MAX_STDIN_BYTES);
    const identity = readRuntimeIdentity(args.runtimeFile, options);
    output = await postHookPayload(identity, payload, { timeoutMs: options.timeoutMs });
  } catch {}
  const sanitized = sanitizeOfficialOutput(output);
  stdout.write(`${JSON.stringify(sanitized)}\n`);
  return sanitized;
}

if (require.main === module) {
  run().catch(() => {
    try { process.stdout.write('{}\n'); } catch {}
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_STDIN_BYTES,
  parseArguments,
  postHookPayload,
  readBoundedJson,
  readRuntimeIdentity,
  run,
  sanitizeOfficialOutput,
};
