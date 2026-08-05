'use strict';

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TerminalManager } = require('../src/terminalManager');
const { TmuxControlProxy, parseLaunchPayload } = require('../src/tmuxControlProxy');

const root = path.resolve(__dirname, '..');
const runId = `${process.pid}-${Date.now()}`;
const sessions = new Set();
const terminals = new Set();
const outputByTerminal = new Map();
const wireByTerminal = new Map();
const highOutputTrackers = new Map();
const wireHighOutputTrackers = new Map();
const parserHighOutputTrackers = new WeakMap();
const emitHighOutputTrackers = new WeakMap();
const OUTPUT_TAIL_CHARS = 512 * 1024;
const CLEANUP_TIMEOUT_MS = 15_000;
// This is an intentionally heavy real-environment test: WSL startup, a 128 KiB
// command and a 4 MiB lossless stream all share the host with the rest of the
// release gate.  Keep the safety deadline above the observed loaded-host time;
// the individual operations still have substantially tighter failure bounds.
const TEST_TIMEOUT_MS = 600_000;
const ABORT_SETTLE_TIMEOUT_MS = 5_000;
const HARD_EXIT_TIMEOUT_MS = 650_000;
const TEST_STARTED_AT = Date.now();
const REQUESTED_STAGES = new Set(String(process.env.LOADTOAGENT_EXACT_TMUX_STAGES || '')
  .split(',').map(value => value.trim()).filter(Boolean));
let manager = null;
let distro = '';
let finished = false;
let cleanupPromise = null;
let rawWire = '';
const testAbortController = new AbortController();

function testAbortError() {
  return testAbortController.signal.reason instanceof Error
    ? testAbortController.signal.reason
    : new Error('exact tmux pane real-environment test aborted');
}

function abortable(value) {
  if (testAbortController.signal.aborted) return Promise.reject(testAbortError());
  return new Promise((resolve, reject) => {
    const aborted = () => reject(testAbortError());
    testAbortController.signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(value).then(result => {
      testAbortController.signal.removeEventListener('abort', aborted);
      resolve(result);
    }, error => {
      testAbortController.signal.removeEventListener('abort', aborted);
      reject(error);
    });
  });
}

function withTimeout(value, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(message);
        error.code = 'EXACT_TMUX_E2E_TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function command(file, args, options = {}) {
  return spawnSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    ...options,
  });
}

function resolveTmuxRuntime() {
  if (process.platform !== 'win32') {
    const probe = command('tmux', ['-V']);
    return probe.status === 0 ? { available: true, distro: '' } : { available: false, distro: '' };
  }
  const candidates = [process.env.LOADTOAGENT_TEST_WSL_DISTRO, 'Ubuntu-22.04', 'Ubuntu']
    .filter(Boolean);
  for (const candidate of candidates) {
    const probe = command('wsl.exe', ['-d', candidate, '--exec', 'tmux', '-V']);
    if (probe.status === 0) return { available: true, distro: candidate };
  }
  return { available: false, distro: '' };
}

function tmux(args, allowFailure = false) {
  const result = process.platform === 'win32'
    ? command('wsl.exe', ['-d', distro, '--exec', 'tmux', ...args])
    : command('tmux', args);
  if (!allowFailure && result.status !== 0) {
    throw new Error(`tmux ${args.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function tmuxText(args, allowFailure = false) {
  return String(tmux(args, allowFailure).stdout || '').replace(/\r/g, '').trim();
}

function linux(args, options = {}) {
  return process.platform === 'win32'
    ? command('wsl.exe', ['-d', distro, '--exec', ...args], options)
    : command(args[0], args.slice(1), options);
}

function delay(milliseconds) {
  if (testAbortController.signal.aborted) return Promise.reject(testAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      testAbortController.signal.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    const aborted = () => {
      clearTimeout(timer);
      reject(testAbortError());
    };
    testAbortController.signal.addEventListener('abort', aborted, { once: true });
  });
}

async function waitUntil(predicate, timeoutMs = 12_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  try {
    if (await predicate()) return true;
  } catch (error) {
    lastError = error;
  }
  if (lastError) throw lastError;
  return false;
}

async function stablePaneSize(pane, stableMs = 300, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  let observed = paneFormat(pane, '#{pane_width}x#{pane_height}');
  let stableSince = Date.now();
  const samples = [observed];
  while (Date.now() < deadline) {
    await delay(50);
    const current = paneFormat(pane, '#{pane_width}x#{pane_height}');
    if (current !== observed) {
      observed = current;
      stableSince = Date.now();
      samples.push(current);
      continue;
    }
    if (Date.now() - stableSince >= stableMs) return observed;
  }
  throw new Error(`tmux source grid did not settle: ${samples.join(' -> ')}`);
}

function assert(condition, message) {
  if (testAbortController.signal.aborted) throw testAbortError();
  if (!condition) throw new Error(message);
}

async function runStage(name, operation) {
  if (REQUESTED_STAGES.size && !REQUESTED_STAGES.has(name)) return;
  const startedAt = Date.now();
  process.stdout.write(`[exact-tmux] ${name} started at +${startedAt - TEST_STARTED_AT}ms\n`);
  try {
    await operation();
  } finally {
    process.stdout.write(`[exact-tmux] ${name} finished in ${Date.now() - startedAt}ms\n`);
  }
}

function unique(label) {
  return `LTA_${label}_${runId}_${Math.random().toString(16).slice(2)}`;
}

function terminalOutput(id) {
  return `${outputByTerminal.get(id) || ''}${manager?.get(id, true)?.replay || ''}`;
}

function consumeIndexedHighOutput(tracker, value) {
  const text = String(value || '');
  tracker.tail = `${tracker.tail}${text}`.slice(-8_192);
  if (tracker.done) return;
  tracker.lineBuffer += text;
  let newline;
  while ((newline = tracker.lineBuffer.indexOf('\n')) >= 0) {
    let line = tracker.lineBuffer.slice(0, newline);
    tracker.lineBuffer = tracker.lineBuffer.slice(newline + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!tracker.started) {
      if (line === tracker.startMarker) tracker.started = true;
      continue;
    }
    if (line === tracker.tailMarker) {
      tracker.done = true;
      tracker.observedHash = tracker.hasher.digest('hex');
      break;
    }

    tracker.observedBytes += Buffer.byteLength(line, 'utf8') + 1;
    tracker.hasher.update(Buffer.from(`${line}\n`, 'utf8'));
    const match = /^B([0-9]{6}):(.*)$/u.exec(line);
    if (!match) {
      tracker.firstMismatch ||= `block ${tracker.nextBlock}: malformed line length=${line.length}`;
      if (tracker.diagnostics.length < 12) {
        tracker.diagnostics.push({
          expected: tracker.nextBlock,
          observed: null,
          length: line.length,
          head: line.slice(0, 80),
          tail: line.slice(-120),
          headCodes: [...line.slice(0, 40)].map(character => character.charCodeAt(0)),
          tailCodes: [...line.slice(-40)].map(character => character.charCodeAt(0)),
        });
      }
      continue;
    }
    const index = Number(match[1]);
    const expectedBody = String.fromCharCode(65 + (index % 26));
    const problems = [];
    if (index !== tracker.nextBlock) {
      problems.push(`expected ${tracker.nextBlock}, observed ${index}`);
    }
    if (index < 0 || index >= tracker.blockCount || tracker.seen[index]) {
      problems.push(`duplicate or out-of-range ${index}`);
    } else {
      tracker.seen[index] = 1;
      tracker.observedBlocks += 1;
    }
    if (match[2].length !== tracker.bodyLength || match[2] !== expectedBody.repeat(tracker.bodyLength)) {
      problems.push(`body length/content ${match[2].length}/${tracker.bodyLength}`);
    }
    if (problems.length) {
      tracker.firstMismatch ||= `block ${index}: ${problems.join(', ')}`;
      if (tracker.diagnostics.length < 12) {
        tracker.diagnostics.push({
          expected: tracker.nextBlock,
          observed: index,
          length: line.length,
          problems,
          embeddedHeaders: [...line.matchAll(/B[0-9]{6}:/gu)].slice(0, 8).map(item => ({ value: item[0], offset: item.index })),
          head: line.slice(0, 80),
          tail: line.slice(-120),
          headCodes: [...line.slice(0, 40)].map(character => character.charCodeAt(0)),
          tailCodes: [...line.slice(-40)].map(character => character.charCodeAt(0)),
        });
      }
      tracker.recoveryDiagnosticsRemaining = 2;
    } else if (tracker.firstMismatch && tracker.recoveryDiagnosticsRemaining > 0
      && tracker.diagnostics.length < 12) {
      tracker.diagnostics.push({ expected: tracker.nextBlock, observed: index, length: line.length, recovered: true });
      tracker.recoveryDiagnosticsRemaining -= 1;
    }
    tracker.nextBlock = index + 1;
  }
  if (!tracker.started && tracker.lineBuffer.length > 8_192) {
    tracker.lineBuffer = tracker.lineBuffer.slice(-8_192);
  }
}

function createIndexedHighOutputTracker({ blockCount, bodyLength, startMarker, tailMarker }) {
  return {
    blockCount,
    bodyLength,
    startMarker,
    tailMarker,
    started: false,
    done: false,
    lineBuffer: '',
    tail: '',
    nextBlock: 0,
    observedBlocks: 0,
    observedBytes: 0,
    observedHash: '',
    firstMismatch: '',
    diagnostics: [],
    recoveryDiagnosticsRemaining: 0,
    seen: new Uint8Array(blockCount),
    hasher: crypto.createHash('sha256'),
  };
}

function createInstrumentedTmuxControlProxy(options) {
  const proxy = new TmuxControlProxy(parseLaunchPayload(options), { inProcess: true });
  proxy.parser.on('output', event => {
    if (event?.pane !== proxy.options.pane) return;
    const tracker = parserHighOutputTrackers.get(proxy);
    if (tracker) consumeIndexedHighOutput(tracker, event.data);
  });
  const emitData = proxy.emitData.bind(proxy);
  proxy.emitData = value => {
    const tracker = emitHighOutputTrackers.get(proxy);
    if (tracker) consumeIndexedHighOutput(tracker, value);
    return emitData(value);
  };
  proxy.start().catch(error => proxy.fatal(error));
  return proxy;
}

function highOutputTrackerSummary(name, tracker, expected) {
  const missingBlocks = [];
  for (let index = 0; index < tracker.seen.length && missingBlocks.length < 20; index += 1) {
    if (!tracker.seen[index]) missingBlocks.push(index);
  }
  return {
    name,
    blocks: `${tracker.observedBlocks}/${expected.blockCount}`,
    bytes: `${tracker.observedBytes}/${expected.burstBytes}`,
    hash: `${tracker.observedHash}/${expected.expectedHash}`,
    firstMismatch: tracker.firstMismatch || 'none',
    missingBlocks,
    diagnostics: tracker.diagnostics,
    tail: tracker.tail.slice(-512),
  };
}

function paneCapture(pane, includeEscapes = false) {
  const args = ['capture-pane', '-p', '-J'];
  if (includeEscapes) args.push('-e');
  args.push('-t', pane);
  return tmuxText(args, true);
}

function paneFormat(pane, format) {
  return tmuxText(['display-message', '-p', '-t', pane, format]);
}

async function waitForTerminal(id, wanted, timeoutMs = 20_000) {
  const terminal = () => manager.get(id, true);
  const reached = await waitUntil(() => {
    const current = terminal();
    return wanted.includes(current?.status);
  }, timeoutMs);
  const current = terminal();
  if (!reached) {
    throw new Error(`terminal state timeout (${wanted.join(', ')}): ${JSON.stringify(current)}, wire=${JSON.stringify(rawWire)}`);
  }
  return current;
}

async function waitForRunning(id) {
  const current = await waitForTerminal(id, ['running', 'failed', 'exited', 'stopping']);
  if (current.status !== 'running') {
    throw new Error(`exact pane proxy did not become running: ${JSON.stringify(current)}, wire=${JSON.stringify(wireByTerminal.get(id) || rawWire)}`);
  }
  return current;
}

async function waitForNotRunning(id, timeoutMs = 8_000) {
  const stopped = await waitUntil(() => {
    const current = manager.get(id, true);
    return !current || ['failed', 'exited', 'stopping', 'stopped'].includes(current.status);
  }, timeoutMs);
  assert(stopped, `exact pane proxy stayed writable after target loss: ${JSON.stringify(manager.get(id, true))}`);
}

async function acceptedCommand(id, text, label) {
  const deliveryId = `e2e-${label}-${runId}-${Math.random().toString(16).slice(2)}`;
  const pending = manager.command(id, text, { deliveryId });
  assert(pending && typeof pending.then === 'function', `${label}: exact-pane command did not wait for proxy ACK`);
  const result = await abortable(pending);
  assert(result?.deliveryState === 'accepted', `${label}: proxy did not return accepted ACK: ${JSON.stringify(result)}`);
  return result;
}

async function rejectedCommand(id, text, label) {
  let rejection = null;
  try {
    await abortable(Promise.resolve(manager.command(id, text, {
      deliveryId: `e2e-reject-${label}-${runId}-${Math.random().toString(16).slice(2)}`,
    })));
  } catch (error) {
    rejection = error;
  }
  assert(rejection, `${label}: changed exact pane accepted input`);
  return rejection;
}

function paneRows(sessionName) {
  const rows = tmuxText([
    'list-panes', '-s', '-t', `=${sessionName}`,
    '-F', '#{session_id}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_pid}',
  ]).split('\n').filter(Boolean).map(row => {
    const [sessionId, window, windowName, pane, index, pid] = row.split('\t');
    return { sessionId, window, windowName, pane, index, pid };
  });
  return rows;
}

function createFixture(label, { extraWindows = 0 } = {}) {
  const sessionName = `lta-e2e-${label}-${runId}`.slice(0, 90);
  sessions.add(sessionName);
  tmux(['new-session', '-d', '-x', '104', '-y', '32', '-s', sessionName, '-n', 'main', 'bash --noprofile --norc']);
  tmux(['split-window', '-d', '-h', '-t', `=${sessionName}:main`, 'bash --noprofile --norc']);
  for (let index = 0; index < extraWindows; index += 1) {
    tmux(['new-window', '-d', '-t', `=${sessionName}:`, '-n', `aux${index + 1}`, 'bash --noprofile --norc']);
  }
  const rows = paneRows(sessionName);
  const main = rows.filter(row => row.windowName === 'main').sort((left, right) => Number(left.index) - Number(right.index));
  assert(main.length === 2, `${label}: fixture did not create two main panes: ${JSON.stringify(rows)}`);
  const extras = rows.filter(row => row.windowName.startsWith('aux'))
    .sort((left, right) => left.windowName.localeCompare(right.windowName));
  assert(extras.length === extraWindows, `${label}: fixture extra windows mismatch: ${JSON.stringify(rows)}`);
  assert(/^\$\d+$/.test(main[0].sessionId), `${label}: missing native tmux session id`);
  assert(/^@\d+$/.test(main[0].window), `${label}: missing native tmux window id`);
  assert(/^%\d+$/.test(main[0].pane) && /^\d+$/.test(main[0].pid), `${label}: missing native pane identity`);
  return {
    sessionName,
    sessionId: main[0].sessionId,
    window: main[0].window,
    target: main[0].pane,
    targetPid: main[0].pid,
    targetSize: paneFormat(main[0].pane, '#{pane_width}x#{pane_height}'),
    sibling: main[1].pane,
    extras,
  };
}

async function connectFixture(fixture, label) {
  rawWire = '';
  const created = manager.create({
    type: 'tmux',
    distro,
    tmuxSession: fixture.sessionName,
    tmuxSessionId: fixture.sessionId,
    tmuxWindow: fixture.window,
    tmuxPane: fixture.target,
    tmuxPanePid: Number(fixture.targetPid),
    title: `exact pane E2E ${label}`,
    cwd: root,
    cols: 100,
    rows: 30,
    transient: false,
  });
  terminals.add(created.id);
  outputByTerminal.set(created.id, '');
  wireByTerminal.set(created.id, '');
  manager.sessions.get(created.id)?.process?.onData(data => {
    const text = String(data || '');
    wireByTerminal.set(created.id, `${wireByTerminal.get(created.id) || ''}${text}`.slice(-32_000));
    const tracker = wireHighOutputTrackers.get(created.id);
    if (tracker) consumeIndexedHighOutput(tracker, text);
  });
  await waitForRunning(created.id);
  const connectedPid = Number(manager.get(created.id)?.pid);
  assert(Number.isSafeInteger(connectedPid) && connectedPid > 0, `${label}: proxy PID was not confirmed after READY`);
  assert(paneFormat(fixture.target, '#{pane_pid}') === fixture.targetPid,
    `${label}: target PID changed while connecting`);
  return created.id;
}

async function closeTerminal(id, ignoreAbort = false) {
  if (!id || !terminals.has(id)) return;
  let closeError = null;
  try {
    const closing = Promise.resolve(manager.close(id));
    await (ignoreAbort ? closing : abortable(closing));
  } catch (error) {
    if (!ignoreAbort && testAbortController.signal.aborted) throw testAbortError();
    // The proxy may already have exited after an intentional identity failure.
    closeError = error;
  }
  // In-process proxy handles use this Electron process PID in their private
  // shadow name.  The public manager PID is the WSL control child and must not
  // be used for leak detection.
  const shadowPrefix = `lta-proxy-${process.pid}-`;
  const shadowNames = tmuxText(['list-sessions', '-F', '#{session_name}'], true)
    .split('\n').filter(name => name.startsWith(shadowPrefix));
  for (const name of shadowNames) tmux(['kill-session', '-t', `=${name}`], true);
  if (!finished && shadowNames.length) {
    throw new Error(`exact pane proxy leaked attached shadow sessions: ${shadowNames.join(', ')}`);
  }
  if (!finished && closeError) {
    throw closeError;
  }
  terminals.delete(id);
}

async function testStableExactPane() {
  const fixture = createFixture('stable', { extraWindows: 2 });
  const startupPrefix = `CUT${Math.random().toString(36).slice(2, 10)}`;
  tmux(['send-keys', '-t', fixture.target, '-l',
    `for i in $(seq 1 20); do printf '${startupPrefix}_%02d\\n' "$i"; sleep 0.12; done`]);
  tmux(['send-keys', '-t', fixture.target, 'Enter']);
  const id = await connectFixture(fixture, 'stable');
  assert(await waitUntil(() => String(manager.get(id, true)?.replay || '').includes(`${startupPrefix}_20`), 10_000),
    'startup output did not cross the initial capture/live boundary');
  const startupReplay = String(manager.get(id, true)?.replay || '');
  for (let index = 1; index <= 20; index += 1) {
    const marker = `${startupPrefix}_${String(index).padStart(2, '0')}`;
    const count = startupReplay.split(marker).length - 1;
    assert(count === 1, `startup capture/live cutover duplicated or lost ${marker}: count=${count}`);
  }

  const originalSize = paneFormat(fixture.target, '#{pane_width}x#{pane_height}');
  assert(originalSize === fixture.targetSize,
    `proxy attachment polluted the original pane size: before=${fixture.targetSize}, after=${originalSize}`);
  manager.resize(id, 137, 41);
  await delay(900);
  const resizedOriginal = paneFormat(fixture.target, '#{pane_width}x#{pane_height}');
  assert(resizedOriginal === originalSize,
    `proxy resize polluted the original pane size: before=${originalSize}, after=${resizedOriginal}`);
  const sourceWidth = Number(originalSize.split('x')[0]);
  assert(Number.isSafeInteger(sourceWidth) && sourceWidth > 20, `invalid source pane width: ${originalSize}`);
  const wrapHead = `WB${Math.random().toString(36).slice(2, 10)}`;
  const wrapTail = `WN${Math.random().toString(36).slice(2, 10)}`;
  const wrapPayload = `${wrapHead}${'W'.repeat(sourceWidth - wrapHead.length)}${wrapTail}`;
  await acceptedCommand(id, `printf '\\r%s\\n' '${wrapPayload}'`, 'resize-wrap');
  assert(await waitUntil(() => terminalOutput(id).includes(wrapTail)), 'resize wrap sentinel was not forwarded');
  const wrapOutput = terminalOutput(id);
  const wrapStart = wrapOutput.indexOf(`\r${wrapHead}`);
  const wrapTailIndex = wrapOutput.indexOf(wrapTail, wrapStart + 1 + sourceWidth);
  assert(wrapStart >= 0 && wrapTailIndex >= 0, 'could not isolate source-width wrap output');
  const viewerWidth = Number(manager.get(id)?.cols);
  const explicitBoundary = wrapOutput.slice(wrapStart + 1 + sourceWidth, wrapTailIndex);
  assert(viewerWidth === sourceWidth || /[\r\n]|\x1b\[[0-9;?]*[Hf]/u.test(explicitBoundary),
    `xterm/source width mismatch lost tmux wrap parity: source=${sourceWidth}, viewer=${viewerWidth}`);

  tmux(['select-pane', '-t', fixture.sibling]);
  tmux(['select-window', '-t', `${fixture.sessionId}:${fixture.extras[0].window}`]);
  const selectedMarker = unique('EXTERNAL_SELECTION');
  await acceptedCommand(id, `printf '${selectedMarker}\\n'`, 'external-select');
  assert(await waitUntil(() => paneCapture(fixture.target).includes(selectedMarker)),
    'command ACK arrived but target pane did not receive the command');
  assert(!paneCapture(fixture.sibling).includes(selectedMarker), 'selected sibling received exact-pane command');
  assert(!paneCapture(fixture.extras[0].pane).includes(selectedMarker), 'selected window received exact-pane command');

  const vtMarker = unique('RAW_VT');
  await acceptedCommand(
    id,
    `printf '\\033[38;5;196m${vtMarker}\\033[0m\\033[?1h\\033[?2004h\\n'`,
    'raw-vt',
  );
  assert(await waitUntil(() => terminalOutput(id).includes(vtMarker)), 'raw VT marker was not forwarded to manager data');
  const liveVt = terminalOutput(id);
  assert(liveVt.includes(`\x1b[38;5;196m${vtMarker}\x1b[0m`), 'raw ANSI color bytes were flattened or lost');
  assert(liveVt.includes('\x1b[?1h'), 'application-cursor DECSET was not forwarded');
  assert(liveVt.includes('\x1b[?2004h'), 'bracketed-paste DECSET was not forwarded');
  assert(String(manager.get(id, true)?.replay || '').includes(vtMarker), 'raw VT output was not retained in replay');

  tmux(['swap-pane', '-d', '-s', fixture.target, '-t', fixture.sibling]);
  tmux(['move-pane', '-d', '-s', fixture.extras[0].pane, '-t', fixture.target]);
  tmux(['join-pane', '-d', '-s', fixture.extras[1].pane, '-t', fixture.target]);
  assert(paneFormat(fixture.target, '#{window_id}') === fixture.window, 'target pane identity changed after sibling move/join/swap');
  assert(paneFormat(fixture.target, '#{pane_pid}') === fixture.targetPid, 'target PID changed after sibling move/join/swap');
  const structuralMarker = unique('STRUCTURAL');
  await acceptedCommand(id, `printf '${structuralMarker}\\n'`, 'structural');
  assert(await waitUntil(() => paneCapture(fixture.target).includes(structuralMarker)),
    'exact target was lost after pane swap/move/join');
  const currentRows = paneRows(fixture.sessionName);
  for (const row of currentRows.filter(row => row.pane !== fixture.target)) {
    assert(!paneCapture(row.pane).includes(structuralMarker), `non-target ${row.pane} received structural command`);
  }
  // Establish a control interval after the synchronous topology edits. This
  // separates an independent tmux layout change from the renderer resize that
  // follows and makes any regression diagnostic show all three dimensions.
  const structuralSize = await stablePaneSize(fixture.target);
  assert(structuralSize !== originalSize,
    `sibling pane move/join did not exercise a source grid change: ${structuralSize}`);
  const [structuralCols, structuralRows] = structuralSize.split('x').map(Number);
  assert(await waitUntil(() => {
    const terminal = manager.get(id);
    return terminal?.cols === structuralCols && terminal?.rows === structuralRows;
  }), `source grid META did not update manager dimensions: source=${structuralSize}, terminal=${JSON.stringify(manager.get(id))}`);
  const preResizeSize = paneFormat(fixture.target, '#{pane_width}x#{pane_height}');
  const resizeResult = manager.resize(id, 177, 55);
  assert(resizeResult?.fixedGrid === true,
    `exact-pane resize did not report fixed-grid handling: ${JSON.stringify(resizeResult)}`);
  await delay(500);
  const postResizeSize = paneFormat(fixture.target, '#{pane_width}x#{pane_height}');
  assert(preResizeSize === structuralSize && postResizeSize === structuralSize,
    `post-layout xterm resize polluted the new source grid: control=${structuralSize}, before=${preResizeSize}, after=${postResizeSize}`);
  assert(manager.get(id)?.cols === structuralCols && manager.get(id)?.rows === structuralRows,
    'fixed-grid terminal dimensions diverged after post-layout resize');

  const newWrapHead = `SB${Math.random().toString(36).slice(2, 10)}`;
  const newWrapTail = `SN${Math.random().toString(36).slice(2, 10)}`;
  const newWrapPayload = `${newWrapHead}${'S'.repeat(structuralCols - newWrapHead.length)}${newWrapTail}`;
  await acceptedCommand(id, `printf '\\r%s\\n' '${newWrapPayload}'`, 'structural-wrap');
  assert(await waitUntil(() => terminalOutput(id).includes(newWrapTail)), 'updated-grid wrap sentinel was not forwarded');
  const newWrapOutput = terminalOutput(id);
  const newWrapStart = newWrapOutput.indexOf(`\r${newWrapHead}`);
  const newWrapTailIndex = newWrapOutput.indexOf(newWrapTail, newWrapStart + 1 + structuralCols);
  assert(newWrapStart >= 0 && newWrapTailIndex >= 0, 'could not isolate updated-grid wrap output');
  const newBoundary = newWrapOutput.slice(newWrapStart + 1 + structuralCols, newWrapTailIndex);
  assert(manager.get(id)?.cols === structuralCols || /[\r\n]|\x1b\[[0-9;?]*[Hf]/u.test(newBoundary),
    `updated source/viewer width lost wrap parity: source=${structuralCols}, viewer=${manager.get(id)?.cols}`);

  const rawPayload = Buffer.concat([
    Buffer.from('한글', 'utf8'),
    Buffer.from([0x1b, 0x03, 0x04, 0x1b, 0x5b, 0x41]),
  ]);
  await testRawInput(id, rawPayload, false, 'RAW_INPUT');
  const pastePayload = Buffer.from('paste-one\r붙여넣기', 'utf8');
  await testRawInput(id, pastePayload, true, 'PASTE_INPUT');

  await closeTerminal(id);
  process.stdout.write(`✓ native ${fixture.sessionId}/${fixture.window}/${fixture.target}/PID ${fixture.targetPid}: ACK, selection, VT, input, resize, structural routing\n`);
}

async function testScreenStateInitialization() {
  const fixture = createFixture('screen-state');
  tmux(['send-keys', '-t', fixture.target, '-l',
    "printf '\\033[4h\\033[?6h\\033[?7l\\033[3;20r'"]);
  tmux(['send-keys', '-t', fixture.target, 'Enter']);
  const modeFormat = '#{insert_flag}|#{origin_flag}|#{wrap_flag}|#{scroll_region_upper}|#{scroll_region_lower}';
  assert(await waitUntil(() => paneFormat(fixture.target, modeFormat) === '1|1|0|2|19'),
    `tmux did not enter the requested screen modes: ${paneFormat(fixture.target, modeFormat)}`);
  const id = await connectFixture(fixture, 'screen-state');
  const initialization = String(manager.get(id, true)?.replay || '');
  assert(initialization.includes('\x1b[4h'), 'attach snapshot did not restore insert mode');
  assert(initialization.includes('\x1b[?6h'), 'attach snapshot did not restore origin mode');
  assert(initialization.includes('\x1b[?7l'), 'attach snapshot did not restore disabled auto-wrap mode');
  assert(initialization.includes('\x1b[3;20r'), 'attach snapshot did not restore the scroll region');
  await closeTerminal(id);
  process.stdout.write('✓ existing tmux full-screen modes are restored in the actual PTY initialization stream\n');
}

async function testMaximumUnicodeCommand() {
  const fixture = createFixture('max-command');
  const id = await connectFixture(fixture, 'max-command');
  const marker = unique('MAX_COMMAND_RESULT');
  const commandPrefix = "printf '%s' '";
  const commandSuffix = `' | python3 -c 'import sys,hashlib;d=sys.stdin.buffer.read();print("${marker}:"+str(len(d))+":"+hashlib.sha256(d).hexdigest(),flush=True)'`;
  const maximumCharacters = 128 * 1024;
  const payloadCharacters = maximumCharacters - commandPrefix.length - commandSuffix.length;
  assert(payloadCharacters > 0, 'maximum command fixture has no payload budget');
  const pattern = 'Ab한글42';
  const payload = pattern.repeat(Math.ceil(payloadCharacters / pattern.length)).slice(0, payloadCharacters);
  const commandText = `${commandPrefix}${payload}${commandSuffix}`;
  assert(commandText.length === maximumCharacters,
    `maximum command did not reach the manager boundary: ${commandText.length}`);
  const payloadBytes = Buffer.from(payload, 'utf8');
  const expectedHash = crypto.createHash('sha256').update(payloadBytes).digest('hex');
  const expectedResult = `${marker}:${payloadBytes.length}:${expectedHash}`;

  await acceptedCommand(id, commandText, 'maximum-unicode-command');
  assert(await waitUntil(() => (outputByTerminal.get(id) || '').includes(expectedResult), 30_000),
    `maximum Unicode command ACKed but target length/hash did not match: expected=${expectedResult}, tail=${JSON.stringify((outputByTerminal.get(id) || '').slice(-2_000))}`);
  assert(manager.get(id)?.status === 'running', 'maximum Unicode command disconnected the exact PTY');
  assert(paneCapture(fixture.target).includes(expectedResult), 'maximum Unicode command result was not visible in the target pane');
  assert(!paneCapture(fixture.sibling).includes(marker), 'maximum Unicode command reached the sibling pane');
  await closeTerminal(id);
  process.stdout.write(`✓ ${maximumCharacters}-character multilingual command ACKed with exact ${payloadBytes.length}-byte SHA-256 match\n`);
}

async function testHighOutputAvailability() {
  const fixture = createFixture('high-output');
  const id = await connectFixture(fixture, 'high-output');
  const processHandle = manager.sessions.get(id)?.process;
  assert(processHandle, 'high-output proxy process handle is unavailable');
  const blockSize = 1024;
  const blockCount = (4 * 1024) + 64;
  const bodyLength = blockSize - 9;
  const burstBytes = blockSize * blockCount;
  const startMarker = unique('HIGH_OUTPUT_START');
  const tailMarker = unique('HIGH_OUTPUT_TAIL');
  const expectedHasher = crypto.createHash('sha256');
  for (let index = 0; index < blockCount; index += 1) {
    const header = `B${String(index).padStart(6, '0')}:`;
    expectedHasher.update(Buffer.from(`${header}${String.fromCharCode(65 + (index % 26)).repeat(bodyLength)}\n`, 'ascii'));
  }
  const expectedHash = expectedHasher.digest('hex');
  const producerTailMarker = `${tailMarker}:${burstBytes}:${expectedHash}`;
  const trackerOptions = { blockCount, bodyLength, startMarker, tailMarker: producerTailMarker };
  const sourceTracker = createIndexedHighOutputTracker(trackerOptions);
  const parserTracker = createIndexedHighOutputTracker(trackerOptions);
  const emitTracker = createIndexedHighOutputTracker(trackerOptions);
  const managerTracker = createIndexedHighOutputTracker(trackerOptions);
  const wireTracker = createIndexedHighOutputTracker(trackerOptions);
  highOutputTrackers.set(id, managerTracker);
  wireHighOutputTrackers.set(id, wireTracker);
  parserHighOutputTrackers.set(processHandle, parserTracker);
  emitHighOutputTrackers.set(processHandle, emitTracker);
  const sourcePath = `/tmp/lta-e2e-high-output-${runId}.bin`;
  let sourcePipeOpen = false;
  const stopSourcePipe = async () => {
    if (sourcePipeOpen) {
      tmux(['pipe-pane', '-t', fixture.target], true);
      sourcePipeOpen = false;
      await delay(150);
    }
    const captured = linux(['cat', sourcePath], { encoding: null, maxBuffer: 8 * 1024 * 1024 });
    if (captured.status === 0 && Buffer.isBuffer(captured.stdout)) {
      consumeIndexedHighOutput(sourceTracker, captured.stdout);
    }
    return captured;
  };
  const summaries = () => [
    highOutputTrackerSummary('source-pipe-pane', sourceTracker, { blockCount, burstBytes, expectedHash }),
    highOutputTrackerSummary('parser-buffer', parserTracker, { blockCount, burstBytes, expectedHash }),
    highOutputTrackerSummary('pre-decoder-buffer', emitTracker, { blockCount, burstBytes, expectedHash }),
    highOutputTrackerSummary('proxy-onData', wireTracker, { blockCount, burstBytes, expectedHash }),
    highOutputTrackerSummary('manager', managerTracker, { blockCount, burstBytes, expectedHash }),
  ];
  const burstCommand = `python3 -c 'import sys,hashlib;out=sys.stdout.buffer;out.write(b"\\n${startMarker}\\n");d=b"".join((("B%06d:"%i).encode()+bytes([65+i%26])*${bodyLength}+b"\\n") for i in range(${blockCount}));n=out.write(d);h=hashlib.sha256(d).hexdigest().encode();out.write(b"${tailMarker}:"+str(n).encode()+b":"+h+b"\\n");out.flush()'`;
  try {
    tmux(['pipe-pane', '-O', '-t', fixture.target, `cat > '${sourcePath}'`]);
    sourcePipeOpen = true;
    assert(await waitUntil(() => linux(['test', '-e', sourcePath]).status === 0, 3_000),
      'source pipe-pane capture did not start');
    await acceptedCommand(id, burstCommand, 'high-output-burst');
    const liveTailReached = await waitUntil(() => parserTracker.done && emitTracker.done
      && wireTracker.done && managerTracker.done, 45_000);
    await stopSourcePipe();
    assert(liveTailReached && sourceTracker.done,
      `high-output stream lost its tail: ${JSON.stringify(summaries())}`);
    const valid = tracker => tracker.observedBlocks === blockCount && tracker.observedBytes === burstBytes
      && tracker.observedHash === expectedHash && !tracker.firstMismatch;
    assert([sourceTracker, parserTracker, emitTracker, wireTracker, managerTracker].every(valid),
      `high-output integrity mismatch: ${JSON.stringify(summaries())}`);
    assert(manager.get(id)?.status === 'running', 'high-output burst disconnected the exact PTY');

    const followMarker = unique('HIGH_OUTPUT_FOLLOWUP');
    await acceptedCommand(id, `printf '${followMarker}\\n'`, 'high-output-followup');
    assert(await waitUntil(() => (outputByTerminal.get(id) || '').includes(followMarker), 12_000),
      'exact PTY stopped forwarding output after the high-output burst');
    assert(paneCapture(fixture.target).includes(followMarker), 'follow-up command did not execute after high output');
    assert(!paneCapture(fixture.sibling).includes(followMarker), 'high-output follow-up reached the sibling pane');
  } finally {
    await stopSourcePipe();
    linux(['rm', '-f', '--', sourcePath]);
    highOutputTrackers.delete(id);
    wireHighOutputTrackers.delete(id);
    parserHighOutputTrackers.delete(processHandle);
    emitHighOutputTrackers.delete(processHandle);
  }
  await closeTerminal(id);
  process.stdout.write(`✓ ${burstBytes}-byte continuous output preserved its tail and subsequent accepted command\n`);
}

async function testRawInput(id, payload, bracketed, label) {
  const ready = unique(`${label}_READY`);
  const result = unique(`${label}_HEX`);
  const readyHex = Buffer.from(ready, 'utf8').toString('hex');
  const resultHex = Buffer.from(result, 'utf8').toString('hex');
  const expectedReceived = bracketed
    ? Buffer.concat([Buffer.from('\x1b[200~', 'ascii'), payload, Buffer.from('\x1b[201~', 'ascii')])
    : payload;
  const python = [
    'import sys,termios,tty',
    'o=termios.tcgetattr(0)',
    'tty.setraw(0)',
    `r=bytes.fromhex("${readyHex}").decode()`,
    `q=bytes.fromhex("${resultHex}").decode()`,
    ...(bracketed ? ['sys.stdout.write("\\x1b[?2004h")'] : []),
    'sys.stdout.write(r+"\\r\\n")',
    'sys.stdout.flush()',
    `b=sys.stdin.buffer.read(${expectedReceived.length})`,
    ...(bracketed ? ['sys.stdout.write("\\x1b[?2004l")', 'sys.stdout.flush()'] : []),
    'termios.tcsetattr(0,termios.TCSADRAIN,o)',
    'print("\\n"+q+":"+b.hex(),flush=True)',
  ].join(';');
  await acceptedCommand(id, `python3 -c '${python}'`, label.toLowerCase());
  assert(await waitUntil(() => terminalOutput(id).includes(`${ready}\r\n`)), `${label}: reader did not enter raw mode`);
  const value = bracketed
    ? Buffer.concat([Buffer.from('\x1b[200~', 'ascii'), payload, Buffer.from('\x1b[201~', 'ascii')])
    : payload;
  manager.write(id, value.toString('utf8'));
  const prefix = `\r\n${result}:`;
  assert(await waitUntil(() => {
    const output = terminalOutput(id);
    const index = output.lastIndexOf(prefix);
    const value = index >= 0
      ? output.slice(index + prefix.length, index + prefix.length + (expectedReceived.length * 2))
      : '';
    return value.length === expectedReceived.length * 2 && /^[0-9a-f]+$/u.test(value);
  }, 12_000), `${label}: byte result was not observed; output=${JSON.stringify(terminalOutput(id).slice(-2_000))}`);
  const output = terminalOutput(id);
  const resultIndex = output.lastIndexOf(prefix);
  const observedHex = output.slice(resultIndex + prefix.length, resultIndex + prefix.length + (expectedReceived.length * 2));
  const expectedHex = expectedReceived.toString('hex');
  assert(observedHex === expectedHex,
    `${label}: input bytes changed unexpectedly; expected=${expectedHex}, observed=${observedHex}`);
}

async function testRespawnRejected() {
  const fixture = createFixture('respawn');
  const id = await connectFixture(fixture, 'respawn');
  tmux(['respawn-pane', '-k', '-t', fixture.target, 'bash --noprofile --norc']);
  assert(await waitUntil(() => {
    const pid = paneFormat(fixture.target, '#{pane_pid}');
    return /^\d+$/.test(pid) && pid !== fixture.targetPid;
  }), 'respawn did not change the target PID');
  const marker = unique('RESPAWN_BLOCK');
  await rejectedCommand(id, `printf '${marker}\\n'`, 'respawn');
  const staleOutput = unique('RESPAWN_STALE_OUTPUT');
  tmux(['send-keys', '-t', fixture.target, '-l', `printf '${staleOutput}\\n'`], true);
  tmux(['send-keys', '-t', fixture.target, 'Enter'], true);
  await delay(1_300);
  assert(!paneCapture(fixture.target).includes(marker), 'rejected command reached respawned target');
  assert(!paneCapture(fixture.sibling).includes(marker), 'rejected command reached sibling after respawn');
  assert(!terminalOutput(id).includes(staleOutput), 'respawned program output leaked through stale exact-pane proxy');
  await waitForNotRunning(id);
  await closeTerminal(id);
  process.stdout.write('✓ pane PID respawn is rejected and stale output is not forwarded\n');
}

async function testNaturalExitRejected() {
  const fixture = createFixture('exit');
  const id = await connectFixture(fixture, 'exit');
  await acceptedCommand(id, 'exit', 'natural-exit');
  assert(await waitUntil(() => !paneRows(fixture.sessionName).some(row => row.pane === fixture.target), 8_000),
    'target pane did not exit naturally');
  await waitForNotRunning(id);
  const marker = unique('EXIT_BLOCK');
  await rejectedCommand(id, `printf '${marker}\\n'`, 'natural-exit-after');
  assert(!paneCapture(fixture.sibling).includes(marker), 'post-exit command was redirected to surviving sibling');
  await closeTerminal(id);
  process.stdout.write('✓ natural target exit closes the proxy and never redirects input to a sibling\n');
}

async function testMovedTargetRejected() {
  const fixture = createFixture('moved');
  const id = await connectFixture(fixture, 'moved');
  tmux(['break-pane', '-d', '-s', fixture.target, '-t', fixture.sessionId, '-n', 'moved-target']);
  assert(await waitUntil(() => paneFormat(fixture.target, '#{window_id}') !== fixture.window),
    'break-pane did not move target away from its immutable window');
  const marker = unique('MOVED_BLOCK');
  await rejectedCommand(id, `printf '${marker}\\n'`, 'moved-window');
  const staleOutput = unique('MOVED_STALE_OUTPUT');
  tmux(['send-keys', '-t', fixture.target, '-l', `printf '${staleOutput}\\n'`], true);
  tmux(['send-keys', '-t', fixture.target, 'Enter'], true);
  await delay(1_300);
  assert(!paneCapture(fixture.target).includes(marker), 'rejected command reached moved target');
  assert(!paneCapture(fixture.sibling).includes(marker), 'rejected command reached old-window sibling');
  assert(!terminalOutput(id).includes(staleOutput), 'moved target output leaked through stale exact-pane proxy');
  await waitForNotRunning(id);
  await closeTerminal(id);
  process.stdout.write('✓ target window identity break rejects input and stale output\n');
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  finished = true;
  cleanupPromise = (async () => {
    let closeTimedOut = false;
    if (manager && terminals.size) {
      try {
        await withTimeout(
          Promise.allSettled([...terminals].map(id => closeTerminal(id, true))),
          CLEANUP_TIMEOUT_MS,
          'exact tmux pane cleanup timed out while closing terminal proxies',
        );
      } catch (error) {
        closeTimedOut = true;
        process.stderr.write(`${error.message}\n`);
      }
    }
    for (const sessionName of sessions) tmux(['kill-session', '-t', `=${sessionName}`], true);
    const shadowPrefix = `lta-proxy-${process.pid}-`;
    const shadowNames = tmuxText(['list-sessions', '-F', '#{session_name}'], true)
      .split('\n').filter(name => name.startsWith(shadowPrefix));
    for (const name of shadowNames) tmux(['kill-session', '-t', `=${name}`], true);
    if (closeTimedOut) process.exitCode = 1;
  })();
  cleanupPromise.catch(() => {});
  return cleanupPromise;
}

async function run() {
  const runtime = resolveTmuxRuntime();
  if (!runtime.available) {
    process.stdout.write('✓ exact tmux pane real-environment test requires tmux on POSIX or WSL.\n');
    return;
  }
  distro = runtime.distro;
  const version = tmuxText(['-V']);
  assert(/^tmux \d/u.test(version), `unexpected tmux runtime: ${version}`);
  const realPty = require('node-pty');
  manager = new TerminalManager({
    tmuxControlProxyFactory: createInstrumentedTmuxControlProxy,
    ptyModule: {
      spawn(...args) {
        const processHandle = realPty.spawn(...args);
        processHandle.onData(data => { rawWire = `${rawWire}${String(data || '')}`.slice(-32_000); });
        return processHandle;
      },
    },
  });
  manager.on('data', event => {
    if (!event?.id) return;
    const text = String(event.data || '');
    outputByTerminal.set(event.id, `${outputByTerminal.get(event.id) || ''}${text}`.slice(-OUTPUT_TAIL_CHARS));
    const tracker = highOutputTrackers.get(event.id);
    if (tracker) consumeIndexedHighOutput(tracker, text);
  });
  await runStage('screen-state', testScreenStateInitialization);
  await runStage('maximum-command', testMaximumUnicodeCommand);
  await runStage('high-output', testHighOutputAvailability);
  await runStage('stable-routing', testStableExactPane);
  await runStage('respawn-rejection', testRespawnRejected);
  await runStage('natural-exit', testNaturalExitRejected);
  await runStage('moved-target', testMovedTargetRejected);
  process.stdout.write(`✓ exact tmux control proxy E2E passed on ${version}${distro ? ` (${distro})` : ''}\n`);
}

const hardExitTimeout = setTimeout(() => {
  process.stderr.write('exact tmux pane real-environment test exceeded its hard exit deadline.\n');
  app.exit(1);
}, HARD_EXIT_TIMEOUT_MS);

const overallTimeout = setTimeout(() => {
  const error = new Error('exact tmux pane real-environment test timed out');
  error.code = 'EXACT_TMUX_E2E_TIMEOUT';
  process.exitCode = 1;
  testAbortController.abort(error);
}, TEST_TIMEOUT_MS);

app.whenReady().then(async () => {
  const runPromise = run();
  try {
    await abortable(runPromise);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(overallTimeout);
    if (testAbortController.signal.aborted) {
      try {
        await withTimeout(
          runPromise.catch(() => {}),
          ABORT_SETTLE_TIMEOUT_MS,
          'exact tmux pane test did not settle promptly after timeout',
        );
      } catch (error) {
        process.stderr.write(`${error.message}\n`);
      }
    }
    await cleanup();
    clearTimeout(hardExitTimeout);
    setTimeout(() => app.exit(process.exitCode || 0), 100);
  }
});
