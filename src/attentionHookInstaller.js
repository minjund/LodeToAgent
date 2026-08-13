'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OWNER_MARKER = '--loadtoagent-attention-hook';
const OWN_HTTP_URL = /^http:\/\/127\.0\.0\.1:\d+\/loadtoagent\/attention\/v1\/[a-f0-9]{32,128}$/iu;
const DEFAULT_TIMEOUT_SECONDS = 600;
const OWN_BACKUP_LIMIT = 3;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function packagedHookScriptPath() {
  const source = path.resolve(__dirname, '..', 'bin', 'attention-permission-hook.js');
  return source.replace(/([\\/])app\.asar([\\/])/iu, '$1app.asar.unpacked$2');
}

function configuredHome(environment, key, fallback) {
  const configured = typeof environment?.[key] === 'string' ? environment[key].trim() : '';
  return configured || fallback;
}

function defaultPaths(home = os.homedir(), environment = process.env) {
  const claudeHome = configuredHome(environment, 'CLAUDE_CONFIG_DIR', path.join(home, '.claude'));
  const codexHome = configuredHome(environment, 'CODEX_HOME', path.join(home, '.codex'));
  return {
    claudeSettingsPath: path.join(claudeHome, 'settings.json'),
    codexHooksPath: path.join(codexHome, 'hooks.json'),
    codexConfigPath: path.join(codexHome, 'config.toml'),
    runtimeFile: path.join(home, '.loadtoagent', 'attention-hook.json'),
    hookScriptPath: packagedHookScriptPath(),
  };
}

function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function parseJsonFile(file) {
  const source = readText(file, '');
  if (!source.trim()) return { source, value: {} };
  let value;
  try { value = JSON.parse(source); } catch (cause) {
    const error = new Error(`Cannot update invalid JSON configuration: ${file}`);
    error.code = 'ATTENTION_HOOK_INVALID_JSON_CONFIG';
    error.cause = cause;
    throw error;
  }
  if (!isPlainObject(value)) {
    const error = new Error(`Configuration root must be a JSON object: ${file}`);
    error.code = 'ATTENTION_HOOK_INVALID_JSON_CONFIG';
    throw error;
  }
  return { source, value };
}

function jsonIndent(source) {
  const match = String(source).match(/\n([\t ]+)\S/u);
  if (!match) return 2;
  return match[1].includes('\t') ? '\t' : Math.min(8, Math.max(1, match[1].length));
}

function jsonText(value, source = '') {
  const eol = String(source).includes('\r\n') ? '\r\n' : '\n';
  return `${JSON.stringify(value, null, jsonIndent(source)).replace(/\n/gu, eol)}${eol}`;
}

function regularOwnedBackups(file) {
  const absoluteFile = path.resolve(file);
  const directory = path.resolve(path.dirname(absoluteFile));
  const basename = path.basename(absoluteFile);
  const escapedBasename = basename.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
  const ownedName = new RegExp(
    `^${escapedBasename}\\.loadtoagent-backup-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-[a-f0-9]{8}$`,
    'u',
  );
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter(entry => entry.isFile() && ownedName.test(entry.name)).map(entry => {
    const candidate = path.resolve(directory, entry.name);
    const candidateDirectory = path.resolve(path.dirname(candidate));
    const sameDirectory = process.platform === 'win32'
      ? candidateDirectory.toLowerCase() === directory.toLowerCase()
      : candidateDirectory === directory;
    if (!path.isAbsolute(candidate) || !sameDirectory) return null;
    let stat;
    try { stat = fs.lstatSync(candidate); } catch { return null; }
    return stat.isFile() && !stat.isSymbolicLink() ? { name: entry.name, path: candidate } : null;
  }).filter(Boolean).sort((left, right) => right.name.localeCompare(left.name, 'en'));
}

function pruneOwnedBackups(file, limit = OWN_BACKUP_LIMIT, preservePath = '') {
  const maximum = Number.isInteger(limit) ? Math.max(0, limit) : OWN_BACKUP_LIMIT;
  const backups = regularOwnedBackups(file);
  const preserved = preservePath ? path.resolve(preservePath) : '';
  const keep = [];
  if (maximum > 0 && preserved) {
    const current = backups.find(backup => backup.path === preserved);
    if (current) keep.push(current);
  }
  for (const backup of backups) {
    if (keep.length >= maximum) break;
    if (!keep.some(candidate => candidate.path === backup.path)) keep.push(backup);
  }
  const keepPaths = new Set(keep.map(backup => backup.path));
  const removed = [];
  for (const backup of backups.filter(candidate => !keepPaths.has(candidate.path))) {
    // Revalidate immediately before unlinking. In particular, never follow a
    // symlink that replaced a backup after directory enumeration.
    let stat;
    try { stat = fs.lstatSync(backup.path); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    fs.unlinkSync(backup.path);
    removed.push(backup.path);
  }
  return removed;
}

function pruneOwnedBackupsSafely(file, preservePath = '') {
  try { return { backupsPruned: pruneOwnedBackups(file, OWN_BACKUP_LIMIT, preservePath), backupPruneError: null }; } catch (error) {
    return {
      backupsPruned: [],
      backupPruneError: typeof error?.message === 'string' ? error.message : 'Unable to prune hook backups.',
    };
  }
}

function atomicWriteWithBackup(file, content, previousSource) {
  if (content === previousSource) {
    return { path: file, changed: false, backupPath: null, ...pruneOwnedBackupsSafely(file) };
  }
  const directory = path.resolve(path.dirname(file));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let backupPath = null;
  if (previousSource !== '') {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    backupPath = `${file}.loadtoagent-backup-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
    const backupTemporary = `${backupPath}.tmp`;
    const backupDescriptor = fs.openSync(backupTemporary, 'wx', 0o600);
    try {
      fs.writeFileSync(backupDescriptor, previousSource, 'utf8');
      fs.fsyncSync(backupDescriptor);
    } finally {
      fs.closeSync(backupDescriptor);
    }
    fs.renameSync(backupTemporary, backupPath);
  }
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const existingMode = (() => {
    try { return fs.statSync(file).mode & 0o777; } catch { return 0o600; }
  })();
  const descriptor = fs.openSync(temporary, 'wx', existingMode);
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return { path: file, changed: true, backupPath, ...pruneOwnedBackupsSafely(file, backupPath) };
}

function isOwnClaudeHandler(handler) {
  return isPlainObject(handler)
    && handler.type === 'http'
    && typeof handler.url === 'string'
    && OWN_HTTP_URL.test(handler.url);
}

function isOwnCodexHandler(handler) {
  if (!isPlainObject(handler) || handler.type !== 'command') return false;
  return [handler.command, handler.commandWindows, handler.command_windows]
    .some(value => {
      if (typeof value !== 'string') return false;
      if (value.includes(OWNER_MARKER)) return true;
      const encoded = value.match(/(?:^|\s)-EncodedCommand\s+([a-z0-9+/]+={0,2})(?:\s|$)/iu)?.[1];
      if (!encoded || encoded.length > 256 * 1024) return false;
      try { return Buffer.from(encoded, 'base64').toString('utf16le').includes(OWNER_MARKER); } catch { return false; }
    });
}

function isKnownForeignPermissionHttpHandler(handler) {
  if (!isPlainObject(handler) || handler.type !== 'http' || typeof handler.url !== 'string'
    || isOwnClaudeHandler(handler)) return false;
  let parsed;
  try { parsed = new URL(handler.url); } catch { return false; }
  return parsed.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())
    && /^\/permission\/?$/iu.test(parsed.pathname);
}

function isKnownClawdCodexPermissionHandler(handler) {
  if (!isPlainObject(handler) || handler.type !== 'command' || isOwnCodexHandler(handler)) return false;
  return [handler.command, handler.commandWindows, handler.command_windows].some(value => {
    const normalized = typeof value === 'string' ? value.replace(/\\/gu, '/').toLowerCase() : '';
    return normalized.includes('codex-hook.js')
      && (normalized.includes('clawd on desk') || /(?:^|\/)clawd(?:\/|[-_])/u.test(normalized));
  });
}

function eventHasHandler(config, eventName, predicate) {
  return (Array.isArray(config.hooks?.[eventName]) ? config.hooks[eventName] : [])
    .flatMap(group => Array.isArray(group?.hooks) ? group.hooks : [])
    .some(predicate);
}

function ensureHooksRoot(config, file) {
  if (config.hooks === undefined) config.hooks = {};
  if (!isPlainObject(config.hooks)) {
    const error = new Error(`The hooks field must be an object: ${file}`);
    error.code = 'ATTENTION_HOOK_INVALID_HOOKS_CONFIG';
    throw error;
  }
  return config.hooks;
}

function removeOwnedHandlers(config, predicate, file) {
  const hooks = ensureHooksRoot(config, file);
  let removed = 0;
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      const error = new Error(`Hook event ${eventName} must be an array: ${file}`);
      error.code = 'ATTENTION_HOOK_INVALID_HOOKS_CONFIG';
      throw error;
    }
    const nextGroups = [];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        nextGroups.push(group);
        continue;
      }
      const nextHandlers = group.hooks.filter(handler => {
        const own = predicate(handler);
        if (own) removed += 1;
        return !own;
      });
      if (nextHandlers.length > 0) nextGroups.push({ ...group, hooks: nextHandlers });
    }
    hooks[eventName] = nextGroups;
  }
  return removed;
}

function upsertOwnCodexPermissionHandler(config, handler, file) {
  const hooks = ensureHooksRoot(config, file);
  let installed = false;
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      const error = new Error(`Hook event ${eventName} must be an array: ${file}`);
      error.code = 'ATTENTION_HOOK_INVALID_HOOKS_CONFIG';
      throw error;
    }
    const nextGroups = [];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        nextGroups.push(group);
        continue;
      }
      const nextHandlers = [];
      for (const candidate of group.hooks) {
        if (!isOwnCodexHandler(candidate)) {
          nextHandlers.push(candidate);
          continue;
        }
        if (eventName === 'PermissionRequest' && !installed) {
          nextHandlers.push(handler);
          installed = true;
        }
      }
      if (nextHandlers.length > 0) nextGroups.push({ ...group, hooks: nextHandlers });
    }
    hooks[eventName] = nextGroups;
  }
  if (!installed) appendHandler(config, 'PermissionRequest', '', handler, file);
}

function appendHandler(config, eventName, matcher, handler, file) {
  const hooks = ensureHooksRoot(config, file);
  if (hooks[eventName] === undefined) hooks[eventName] = [];
  if (!Array.isArray(hooks[eventName])) {
    const error = new Error(`Hook event ${eventName} must be an array: ${file}`);
    error.code = 'ATTENTION_HOOK_INVALID_HOOKS_CONFIG';
    throw error;
  }
  const group = { hooks: [handler] };
  if (matcher) group.matcher = matcher;
  hooks[eventName].push(group);
}

function validateIdentity(identity) {
  let parsedUrl;
  try { parsedUrl = new URL(identity?.url); } catch {}
  if (!isPlainObject(identity)
    || identity.protocol !== 1
    || identity.service !== 'loadtoagent-attention-hook'
    || identity.host !== '127.0.0.1'
    || !Number.isInteger(identity.port)
    || identity.port < 1
    || identity.port > 65_535
    || typeof identity.url !== 'string'
    || !OWN_HTTP_URL.test(identity.url)
    || parsedUrl?.hostname !== identity.host
    || Number(parsedUrl?.port) !== identity.port
    || (typeof identity.path === 'string' && parsedUrl?.pathname !== identity.path)
    || (typeof identity.nonce === 'string' && !parsedUrl?.pathname.endsWith(`/${identity.nonce}`))) {
    const error = new TypeError('A running LoadToAgent attention hook identity is required.');
    error.code = 'ATTENTION_HOOK_INVALID_IDENTITY';
    throw error;
  }
  return identity;
}

function posixQuote(value) {
  return `'${String(value).replace(/'/gu, `'"'"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function buildCodexHookCommands(options = {}) {
  const nodeExecutable = path.resolve(options.nodeExecutable || process.execPath);
  const hookScriptPath = path.resolve(options.hookScriptPath || packagedHookScriptPath());
  const runtimeFile = path.resolve(options.runtimeFile || defaultPaths().runtimeFile);
  const marker = OWNER_MARKER;
  const platform = options.platform || process.platform;
  const powershellScript = [
    "$env:ELECTRON_RUN_AS_NODE='1';",
    '&',
    powershellQuote(nodeExecutable),
    powershellQuote(hookScriptPath),
    '--runtime-file',
    powershellQuote(runtimeFile),
    marker,
  ].join(' ');
  // Codex runs Windows hooks through the active turn shell, which may be
  // cmd.exe rather than PowerShell. Make the interpreter explicit, and use an
  // encoded command so the same string is safe when the outer shell is cmd,
  // PowerShell, or WSL's Windows executable interop.
  const encodedPowershellScript = Buffer.from(powershellScript, 'utf16le').toString('base64');
  const commandWindows = [
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedPowershellScript,
  ].join(' ');
  // WSL inherits the Windows hooks.json but a POSIX KEY=value prefix is not
  // transferred through Windows executable interop. Start PowerShell inside
  // Windows and set ELECTRON_RUN_AS_NODE there before invoking Electron.
  const command = platform === 'win32'
    ? commandWindows
    : [
      'ELECTRON_RUN_AS_NODE=1',
      posixQuote(nodeExecutable),
      posixQuote(hookScriptPath),
      '--runtime-file',
      posixQuote(runtimeFile),
      marker,
    ].join(' ');
  return { command, commandWindows };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function decodeTomlBasicString(value) {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    index += 1;
    if (index >= value.length) return null;
    const escaped = value[index];
    const simple = {
      b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\',
    };
    if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
      decoded += simple[escaped];
      continue;
    }
    if (escaped !== 'u' && escaped !== 'U') return null;
    const length = escaped === 'u' ? 4 : 8;
    const hexadecimal = value.slice(index + 1, index + 1 + length);
    if (!new RegExp(`^[a-f0-9]{${length}}$`, 'iu').test(hexadecimal)) return null;
    const codePoint = Number.parseInt(hexadecimal, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
    decoded += String.fromCodePoint(codePoint);
    index += length;
  }
  return decoded;
}

function decodedTomlCapture(match) {
  return match[1] !== undefined ? decodeTomlBasicString(match[1]) : match[2];
}

function parseCodexTrustedHashes(source) {
  const states = new Map();
  let activeKey = null;
  for (const line of String(source).replace(/^\ufeff/u, '').split(/\r?\n/u)) {
    if (/^\s*\[/u.test(line)) {
      const header = line.match(
        /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*\]\s*(?:#.*)?$/u,
      );
      activeKey = header ? decodedTomlCapture(header) : null;
      continue;
    }
    if (activeKey === null) continue;
    const trustedHash = line.match(
      /^\s*trusted_hash\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*(?:#.*)?$/u,
    );
    if (!trustedHash) continue;
    const decoded = decodedTomlCapture(trustedHash);
    if (typeof decoded === 'string') states.set(activeKey, decoded);
  }
  return states;
}

function tomlBasicString(value) {
  return JSON.stringify(String(value));
}

function splitCodexHookStateKey(value) {
  const match = String(value).match(/^(.*):permission_request:(\d+):(\d+)$/u);
  if (!match) return null;
  return {
    file: match[1],
    groupIndex: Number(match[2]),
    handlerIndex: Number(match[3]),
  };
}

function comparableHookPath(value, platform = process.platform) {
  if (platform === 'win32') {
    const normalized = path.win32.normalize(String(value).replace(/\//gu, '\\')).replace(/^\\\\\?\\/u, '');
    return normalized.toLowerCase();
  }
  return path.resolve(String(value));
}

function equivalentCodexHookStateKey(leftKey, rightKey, platform = process.platform) {
  const left = splitCodexHookStateKey(leftKey);
  const right = splitCodexHookStateKey(rightKey);
  return Boolean(left && right
    && left.groupIndex === right.groupIndex
    && left.handlerIndex === right.handlerIndex
    && comparableHookPath(left.file, platform) === comparableHookPath(right.file, platform));
}

function findTrustedCodexHash(source, expectedKey, platform = process.platform) {
  const expected = splitCodexHookStateKey(expectedKey);
  if (!expected) return null;
  const states = parseCodexTrustedHashes(source);
  if (states.has(expectedKey)) return states.get(expectedKey);
  const matching = [];
  for (const [key, trustedHash] of states) {
    const candidate = splitCodexHookStateKey(key);
    if (!candidate
      || candidate.groupIndex !== expected.groupIndex
      || candidate.handlerIndex !== expected.handlerIndex
      || comparableHookPath(candidate.file, platform) !== comparableHookPath(expected.file, platform)) continue;
    matching.push(trustedHash);
  }
  const distinct = [...new Set(matching)];
  return distinct.length === 1 ? distinct[0] : null;
}

function normalizeCodexCommandHandler(handler, platform = process.platform) {
  const windowsCommand = handler.commandWindows ?? handler.command_windows;
  const command = platform === 'win32' && typeof windowsCommand === 'string' && windowsCommand
    ? windowsCommand
    : handler.command;
  const normalized = {
    type: 'command',
    command,
    timeout: Math.max(Number.isInteger(handler.timeout) ? handler.timeout : DEFAULT_TIMEOUT_SECONDS, 1),
    async: handler.async === true,
  };
  if (typeof handler.statusMessage === 'string') normalized.statusMessage = handler.statusMessage;
  return normalized;
}

function codexPermissionHookHash(group, handler, platform = process.platform) {
  const identity = {
    event_name: 'permission_request',
    hooks: [normalizeCodexCommandHandler(handler, platform)],
  };
  if (typeof group.matcher === 'string') identity.matcher = group.matcher;
  return `sha256:${crypto.createHash('sha256').update(stableJson(identity), 'utf8').digest('hex')}`;
}

function codexPermissionHookState(config, hooksPath, platform = process.platform) {
  const groups = Array.isArray(config.hooks?.PermissionRequest) ? config.hooks.PermissionRequest : [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
    for (let handlerIndex = 0; handlerIndex < handlers.length; handlerIndex += 1) {
      const handler = handlers[handlerIndex];
      if (!isOwnCodexHandler(handler)) continue;
      return {
        key: `${path.resolve(hooksPath)}:permission_request:${groupIndex}:${handlerIndex}`,
        trustedHash: codexPermissionHookHash(group, handler, platform),
      };
    }
  }
  return null;
}

function trustCodexPermissionHook(config, source, hooksPath, platform = process.platform) {
  const state = codexPermissionHookState(config, hooksPath, platform);
  if (!state) return { source, changed: false, key: null, trustedHash: null };

  const bom = source.startsWith('\ufeff') ? '\ufeff' : '';
  const body = bom ? source.slice(1) : source;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalEol = body.endsWith('\n');
  const lines = body ? body.split(/\r?\n/u) : [];
  if (hadFinalEol && lines[lines.length - 1] === '') lines.pop();

  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(
      /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*\]\s*(?:#.*)?$/u,
    );
    if (!header) continue;
    const candidateKey = decodedTomlCapture(header);
    if (!equivalentCodexHookStateKey(candidateKey, state.key, platform)) continue;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (!isTomlTableHeader(lines[next])) continue;
      end = next;
      break;
    }
    sections.push({ start: index, end });
  }

  if (sections.length === 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(
      `[hooks.state.${tomlBasicString(state.key)}]`,
      `trusted_hash = ${tomlBasicString(state.trustedHash)}`,
    );
  } else {
    for (const section of sections.reverse()) {
      let assignment = -1;
      for (let index = section.start + 1; index < section.end; index += 1) {
        const leading = leadingTomlKey(lines[index]);
        if (leading?.key === 'trusted_hash' && leading.separator === '=') {
          assignment = index;
          break;
        }
      }
      const trustedLine = `trusted_hash = ${tomlBasicString(state.trustedHash)}`;
      if (assignment >= 0) lines[assignment] = trustedLine;
      else lines.splice(section.start + 1, 0, trustedLine);
    }
  }

  const nextBody = `${lines.join(eol)}${hadFinalEol || sections.length === 0 ? eol : ''}`;
  const next = `${bom}${nextBody}`;
  return {
    source: next,
    changed: next !== source,
    key: state.key,
    trustedHash: state.trustedHash,
  };
}

function codexReviewStatus(config, configSource, hooksPath, platform = process.platform) {
  const hookState = codexPermissionHookState(config, hooksPath, platform);
  if (hookState) {
    const trustedHash = findTrustedCodexHash(configSource, hookState.key, platform);
    const trusted = trustedHash === hookState.trustedHash;
    return {
      required: !trusted,
      state: trusted ? 'trusted' : 'review-required',
      key: hookState.key,
    };
  }
  return { required: true, state: 'review-required', key: null };
}

function leadingTomlKey(line) {
  const match = String(line).match(
    /^\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([a-zA-Z0-9_-]+))\s*([.=])\s*(.*)$/u,
  );
  if (!match) return null;
  const key = match[1] !== undefined ? decodeTomlBasicString(match[1]) : (match[2] ?? match[3]);
  return typeof key === 'string' ? { key, separator: match[4], remainder: match[5] } : null;
}

function simpleTomlTableName(line) {
  const match = String(line).match(
    /^\s*\[\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([a-zA-Z0-9_-]+))\s*\]\s*(?:#.*)?$/u,
  );
  if (!match) return null;
  const name = match[1] !== undefined ? decodeTomlBasicString(match[1]) : (match[2] ?? match[3]);
  return typeof name === 'string' ? name : null;
}

function isTomlTableHeader(line) {
  const value = String(line).trimStart();
  if (!value.startsWith('[')) return false;
  const arrayTable = value.startsWith('[[');
  const openLength = arrayTable ? 2 : 1;
  let quote = '';
  let escaped = false;
  for (let index = openLength; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (quote === '"' && !escaped && character === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && character === quote) quote = '';
      escaped = false;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    const closes = arrayTable
      ? character === ']' && value[index + 1] === ']'
      : character === ']';
    if (!closes) continue;
    const remainder = value.slice(index + (arrayTable ? 2 : 1)).trimStart();
    return remainder === '' || remainder.startsWith('#');
  }
  return false;
}

function explicitBoolean(value) {
  const match = String(value).match(/^\s*(true|false)\s*(?:#.*)?$/u);
  return match ? match[1] === 'true' : null;
}

function topLevelFeaturesState(lines) {
  let sawFeatures = false;
  for (const line of lines) {
    if (isTomlTableHeader(line)) break;
    const leading = leadingTomlKey(line);
    if (!leading || leading.key !== 'features') continue;
    sawFeatures = true;
    if (leading.separator === '.') {
      const nested = leadingTomlKey(leading.remainder);
      if (nested?.key !== 'hooks' || nested.separator !== '=') continue;
      const enabled = explicitBoolean(nested.remainder);
      if (enabled !== null) return { enabled, state: enabled ? 'already-enabled' : 'explicitly-disabled' };
      continue;
    }
    const hookValue = leading.remainder.match(
      /(?:^|[,{])\s*(?:"hooks"|'hooks'|hooks)\s*=\s*(true|false)\s*(?=[,}])/u,
    );
    if (hookValue) {
      const enabled = hookValue[1] === 'true';
      return { enabled, state: enabled ? 'already-enabled' : 'explicitly-disabled' };
    }
  }
  return sawFeatures ? { enabled: false, state: 'unrecognized-value' } : null;
}

function enableCodexHooksFeature(source) {
  const bom = source.startsWith('\ufeff') ? '\ufeff' : '';
  const body = bom ? source.slice(1) : source;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalEol = body.endsWith('\n');
  const lines = body ? body.split(/\r?\n/u) : [];
  if (hadFinalEol && lines[lines.length - 1] === '') lines.pop();
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (simpleTomlTableName(lines[index]) === 'features') {
      sectionStart = index;
      for (let next = index + 1; next < lines.length; next += 1) {
        if (isTomlTableHeader(lines[next])) {
          sectionEnd = next;
          break;
        }
      }
      break;
    }
  }
  if (sectionStart >= 0) {
    for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
      const leading = leadingTomlKey(lines[index]);
      if (!leading || leading.key !== 'hooks') continue;
      if (leading.separator !== '=') return { source, changed: false, enabled: false, state: 'unrecognized-value' };
      const enabled = explicitBoolean(leading.remainder);
      if (enabled === null) return { source, changed: false, enabled: false, state: 'unrecognized-value' };
      if (enabled) {
        return { source, changed: false, enabled: true, state: 'already-enabled' };
      }
      return { source, changed: false, enabled: false, state: 'explicitly-disabled' };
    }
    lines.splice(sectionEnd, 0, 'hooks = true');
    const next = `${bom}${lines.join(eol)}${hadFinalEol || lines.length > 0 ? eol : ''}`;
    return { source: next, changed: true, enabled: true, state: 'enabled' };
  }
  const topLevel = topLevelFeaturesState(lines);
  if (topLevel) return { source, changed: false, ...topLevel };
  const prefix = lines.length > 0 ? ['', '[features]', 'hooks = true'] : ['[features]', 'hooks = true'];
  lines.push(...prefix);
  const next = `${bom}${lines.join(eol)}${eol}`;
  return { source: next, changed: true, enabled: true, state: 'enabled' };
}

function resolveInstallerOptions(options = {}) {
  const paths = defaultPaths(options.home || os.homedir(), options.env || process.env);
  return {
    ...paths,
    ...options,
    claudeSettingsPath: path.resolve(options.claudeSettingsPath || paths.claudeSettingsPath),
    codexHooksPath: path.resolve(options.codexHooksPath || paths.codexHooksPath),
    codexConfigPath: path.resolve(options.codexConfigPath || paths.codexConfigPath),
    runtimeFile: path.resolve(options.runtimeFile || paths.runtimeFile),
    hookScriptPath: path.resolve(options.hookScriptPath || paths.hookScriptPath),
    timeoutSeconds: Number.isInteger(options.timeoutSeconds)
      ? Math.min(86_400, Math.max(1, options.timeoutSeconds))
      : DEFAULT_TIMEOUT_SECONDS,
  };
}

function planJsonConfig(file, transform) {
  const parsed = parseJsonFile(file);
  const value = transform(parsed.value);
  return { file, previousSource: parsed.source, source: jsonText(value, parsed.source), value };
}

function planJsonRemoval(file, predicate) {
  if (!fs.existsSync(file)) {
    return { file, previousSource: '', source: '', value: {}, skip: true, removed: 0 };
  }
  const parsed = parseJsonFile(file);
  const removed = removeOwnedHandlers(parsed.value, predicate, file);
  return {
    file,
    previousSource: parsed.source,
    source: removed > 0 ? jsonText(parsed.value, parsed.source) : parsed.source,
    value: parsed.value,
    skip: false,
    removed,
  };
}

function applyPlans(plans) {
  const results = {};
  for (const plan of plans) {
    results[plan.name] = plan.skip
      ? { path: plan.file, changed: false, backupPath: null }
      : atomicWriteWithBackup(plan.file, plan.source, plan.previousSource);
  }
  return results;
}

function installAttentionHooks(rawOptions = {}) {
  const identity = validateIdentity(rawOptions.identity);
  const options = resolveInstallerOptions({
    ...rawOptions,
    runtimeFile: rawOptions.runtimeFile || identity.runtimeFile,
  });
  const httpHandler = {
    type: 'http',
    url: identity.url,
    timeout: options.timeoutSeconds,
    headers: { 'X-LoadToAgent-Provider': 'claude' },
  };
  const commands = buildCodexHookCommands(options);
  const commandHandler = {
    type: 'command',
    command: commands.command,
    commandWindows: commands.commandWindows,
    timeout: options.timeoutSeconds,
    statusMessage: 'Waiting for LoadToAgent response',
  };

  const claude = planJsonConfig(options.claudeSettingsPath, config => {
    removeOwnedHandlers(config, isOwnClaudeHandler, options.claudeSettingsPath);
    appendHandler(config, 'PermissionRequest', '', httpHandler, options.claudeSettingsPath);
    appendHandler(config, 'PreToolUse', 'AskUserQuestion', httpHandler, options.claudeSettingsPath);
    return config;
  });
  const codex = planJsonConfig(options.codexHooksPath, config => {
    upsertOwnCodexPermissionHandler(config, commandHandler, options.codexHooksPath);
    return config;
  });
  const configSource = readText(options.codexConfigPath, '');
  const feature = enableCodexHooksFeature(configSource);
  const platform = options.platform || process.platform;
  const trust = feature.enabled
    ? trustCodexPermissionHook(codex.value, feature.source, options.codexHooksPath, platform)
    : { source: feature.source, changed: false, key: null, trustedHash: null };
  const review = feature.enabled
    ? codexReviewStatus(codex.value, trust.source, options.codexHooksPath, platform)
    : { required: false, state: 'disabled', key: trust.key };
  const plans = [
    { ...claude, name: 'claude' },
    { ...codex, name: 'codexHooks' },
    {
      name: 'codexConfig', file: options.codexConfigPath,
      source: trust.source, previousSource: configSource,
    },
  ];
  const files = applyPlans(plans);
  const warnings = [];
  const backupFailures = Object.entries(files)
    .filter(([, result]) => result.backupPruneError)
    .map(([name]) => name);
  if (backupFailures.length > 0) {
    warnings.push(`Could not enforce hook backup retention for: ${backupFailures.join(', ')}.`);
  }
  if (!feature.enabled) warnings.push(`Codex hooks feature remains ${feature.state}; existing user setting was preserved.`);
  return {
    action: 'install',
    changed: Object.values(files).some(result => result.changed),
    files,
    feature: { enabled: feature.enabled, state: feature.state },
    review,
    warnings,
  };
}

function uninstallAttentionHooks(rawOptions = {}) {
  const options = resolveInstallerOptions(rawOptions);
  const claude = planJsonRemoval(options.claudeSettingsPath, isOwnClaudeHandler);
  const codex = planJsonRemoval(options.codexHooksPath, isOwnCodexHandler);
  const files = applyPlans([
    { ...claude, name: 'claude' },
    { ...codex, name: 'codexHooks' },
  ]);
  return {
    action: 'uninstall',
    changed: Object.values(files).some(result => result.changed),
    files,
    feature: { enabled: null, state: 'preserved' },
    warnings: [],
  };
}

function syncAttentionHooks(options = {}) {
  return options.enabled === true
    ? installAttentionHooks(options)
    : uninstallAttentionHooks(options);
}

class AttentionHookInstaller {
  constructor(options = {}) {
    this.options = { ...options };
  }

  install(identity) {
    return installAttentionHooks({ ...this.options, identity });
  }

  uninstall() {
    return uninstallAttentionHooks(this.options);
  }

  sync(enabled, identity) {
    return enabled === true ? this.install(identity) : this.uninstall();
  }
}

module.exports = {
  DEFAULT_TIMEOUT_SECONDS,
  OWNER_MARKER,
  AttentionHookInstaller,
  atomicWriteWithBackup,
  buildCodexHookCommands,
  codexPermissionHookHash,
  codexReviewStatus,
  defaultPaths,
  enableCodexHooksFeature,
  findTrustedCodexHash,
  installAttentionHooks,
  isOwnClaudeHandler,
  isOwnCodexHandler,
  isKnownClawdCodexPermissionHandler,
  isKnownForeignPermissionHttpHandler,
  packagedHookScriptPath,
  parseCodexTrustedHashes,
  pruneOwnedBackups,
  syncAttentionHooks,
  trustCodexPermissionHook,
  uninstallAttentionHooks,
};
