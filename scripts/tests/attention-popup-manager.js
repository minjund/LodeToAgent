'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const {
  AttentionPopupManager,
  canonicalDecision,
  normalizeRequest,
  POPUP_WIDTH,
  EDGE_MARGIN,
  STACK_GAP,
} = require('../../src/attentionPopupManager');
const { AttentionPopupPreferenceStore } = require('../../src/attentionPopupPreferenceStore');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.url = 'about:blank';
    this.destroyed = false;
    this.messages = [];
    this.windowOpenHandler = null;
  }

  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
  send(channel, payload) { this.messages.push({ channel, payload }); }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];

  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
    this.destroyed = false;
    this.closed = false;
    this.shown = 0;
    this.shownInactive = 0;
    this.focused = 0;
    this.alwaysOnTop = null;
    this.visibleOnAllWorkspaces = null;
    this.menuBarVisible = true;
    this.loadedFile = '';
    FakeBrowserWindow.instances.push(this);
  }

  loadFile(file) {
    this.loadedFile = file;
    this.webContents.url = pathToFileURL(file).href;
    return Promise.resolve();
  }

  setAlwaysOnTop(...args) { this.alwaysOnTop = args; }
  setVisibleOnAllWorkspaces(...args) { this.visibleOnAllWorkspaces = args; }
  setMenuBarVisibility(value) { this.menuBarVisible = value; }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  getBounds() { return { ...this.bounds }; }
  show() { this.shown += 1; }
  showInactive() { this.shownInactive += 1; }
  focus() { this.focused += 1; }
  isDestroyed() { return this.destroyed; }
  close() {
    if (this.destroyed) return;
    this.closed = true;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit('closed');
  }
}

class FakeScreen extends EventEmitter {
  constructor(displays = [{ id: 1, workArea: { x: 100, y: 100, width: 500, height: 600 } }]) {
    super();
    this.displays = displays;
  }

  getPrimaryDisplay() { return this.displays[0]; }
  getAllDisplays() { return this.displays; }
  getDisplayNearestPoint(point) {
    return this.displays.find(display => (
      point.x >= display.workArea.x && point.x < display.workArea.x + display.workArea.width
      && point.y >= display.workArea.y && point.y < display.workArea.y + display.workArea.height
    )) || this.displays[0];
  }
  getDisplayMatching(bounds) {
    return this.getDisplayNearestPoint({ x: bounds.x + 1, y: bounds.y + 1 });
  }
}

function fixture(options = {}) {
  FakeBrowserWindow.instances = [];
  const screen = options.screen || new FakeScreen();
  const calls = { decide: [], dismiss: [], open: [], errors: [] };
  const manager = new AttentionPopupManager({
    BrowserWindow: options.BrowserWindow || FakeBrowserWindow,
    screen,
    preloadPath: path.resolve(__dirname, '../../attention-popup-preload.js'),
    htmlPath: path.resolve(__dirname, '../../renderer/attention-popup.html'),
    enabled: options.enabled,
    onDecide: options.onDecide || ((request, decision, context) => { calls.decide.push({ request, decision, context }); }),
    onDismiss: options.noDismissCallback ? undefined : options.onDismiss || ((request, meta, context) => { calls.dismiss.push({ request, meta, context }); }),
    onOpenMain: options.onOpenMain || ((request, context) => { calls.open.push({ request, context }); }),
    onError: (error, detail) => calls.errors.push({ error, detail }),
  });
  return { manager, screen, calls };
}

function eventFor(win, url = win.webContents.url) {
  return { sender: win.webContents, senderFrame: { url } };
}

function permission(id, createdAt, extra = {}) {
  return {
    id,
    type: 'permission',
    title: `권한 ${id}`,
    body: '이 작업을 허용할까요?',
    createdAt,
    context: { secretTarget: `terminal-${id}` },
    ...extra,
  };
}

async function flush() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('preference defaults on, reports corrupt JSON, and persists an explicit opt-out atomically', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-popup-pref-'));
  try {
    const file = path.join(temp, 'nested', 'attention-popup.json');
    const errors = [];
    const store = new AttentionPopupPreferenceStore(file, { onError: error => errors.push(error) });
    assert.deepStrictEqual(store.load(), { enabled: true });
    assert.equal(errors.length, 0);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}', 'utf8');
    assert.deepStrictEqual(store.load(), { enabled: true });
    fs.writeFileSync(file, '{"enabled":"false"}', 'utf8');
    assert.deepStrictEqual(store.load(), { enabled: true });
    assert.deepStrictEqual(store.setEnabled(false), { enabled: false });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { enabled: false });
    assert.equal(store.getEnabled(), false);
    fs.writeFileSync(file, '{invalid json', 'utf8');
    assert.deepStrictEqual(store.load(), { enabled: true });
    assert.equal(errors.length, 1);
    assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('disabled reconciliation retains requests, enabling creates one hardened window per request', () => {
  const { manager } = fixture();
  manager.reconcile('agent', [permission('old', '2026-08-13T01:00:00Z'), permission('new', '2026-08-13T01:01:00Z')]);
  assert.deepStrictEqual(manager.status(), {
    enabled: false,
    disposed: false,
    requestCount: 2,
    windowCount: 0,
    suppressedCount: 0,
    requests: [
      { key: 'agent\u0000old', source: 'agent', id: 'old', type: 'permission', visible: false, suppressed: false },
      { key: 'agent\u0000new', source: 'agent', id: 'new', type: 'permission', visible: false, suppressed: false },
    ],
    lastError: null,
  });
  manager.setEnabled(true);
  assert.equal(FakeBrowserWindow.instances.length, 2);
  for (const win of FakeBrowserWindow.instances) {
    assert.equal(win.options.width, POPUP_WIDTH);
    assert.equal(win.options.show, false);
    assert.equal(win.options.frame, false);
    assert.equal(win.options.transparent, true);
    assert.equal(win.options.alwaysOnTop, true);
    assert.equal(win.options.skipTaskbar, true);
    assert.deepStrictEqual(win.options.webPreferences, {
      preload: path.resolve(__dirname, '../../attention-popup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    });
    assert.deepStrictEqual(win.alwaysOnTop, [true, 'floating']);
    assert.deepStrictEqual(win.visibleOnAllWorkspaces, [true, { visibleOnFullScreen: true }]);
    assert.equal(win.menuBarVisible, false);
    assert.deepStrictEqual(win.webContents.windowOpenHandler(), { action: 'deny' });
  }
  manager.dispose();
});

test('oldest window is above newest and the stack stays bottom-right with the reference spacing', () => {
  const { manager } = fixture({ enabled: true });
  manager.reconcile('agent', [permission('new', '2026-08-13T01:01:00Z'), permission('old', '2026-08-13T01:00:00Z')]);
  const byTitle = new Map([...manager.windows.values()].map(entry => [entry.record.request.title, entry]));
  const oldEntry = byTitle.get('권한 old');
  const newEntry = byTitle.get('권한 new');
  manager.handleReady(eventFor(oldEntry.window));
  manager.handleReady(eventFor(newEntry.window));
  manager.handleResize(eventFor(oldEntry.window), { height: 120, hasTextInput: false });
  manager.handleResize(eventFor(newEntry.window), { height: 140, hasTextInput: false });
  const oldBounds = oldEntry.window.getBounds();
  const newBounds = newEntry.window.getBounds();
  assert.deepStrictEqual(newBounds, { x: 100 + 500 - EDGE_MARGIN - POPUP_WIDTH, y: 100 + 600 - EDGE_MARGIN - 140, width: 340, height: 140 });
  assert.deepStrictEqual(oldBounds, { x: newBounds.x, y: newBounds.y - STACK_GAP - 120, width: 340, height: 120 });
  assert.equal(oldEntry.window.shownInactive, 1);
  assert.equal(oldEntry.window.shown, 0);
  assert.equal(newEntry.window.shownInactive, 1);
  manager.dispose();
});

test('overflowing old windows clamp to the work-area top instead of leaving the display', () => {
  const screen = new FakeScreen([{ id: 1, workArea: { x: 10, y: 30, width: 500, height: 300 } }]);
  const { manager } = fixture({ enabled: true, screen });
  manager.reconcile('agent', [
    permission('one', '2026-08-13T01:00:00Z'),
    permission('two', '2026-08-13T01:01:00Z'),
    permission('three', '2026-08-13T01:02:00Z'),
    permission('four', '2026-08-13T01:03:00Z'),
  ]);
  for (const entry of manager.windows.values()) {
    manager.handleReady(eventFor(entry.window));
    manager.handleResize(eventFor(entry.window), { height: 150 });
  }
  const bounds = [...manager.windows.values()].map(entry => entry.window.getBounds());
  assert.ok(bounds.every(item => item.y >= 30));
  assert.equal(bounds.filter(item => item.y === 30).length, 3, 'overflowing oldest windows may overlap at the safe top edge');
  manager.dispose();
});

test('width and reported height are capped at ninety percent of the work area', () => {
  const screen = new FakeScreen([{ id: 1, workArea: { x: 0, y: 0, width: 300, height: 200 } }]);
  const { manager } = fixture({ enabled: true, screen });
  manager.upsert(permission('small-screen', '', { initialHeight: 999 }));
  const entry = [...manager.windows.values()][0];
  assert.equal(entry.window.options.width, 270);
  assert.equal(entry.window.options.height, 180);
  manager.handleReady(eventFor(entry.window));
  manager.handleResize(eventFor(entry.window), { height: 5000 });
  assert.deepStrictEqual(entry.window.getBounds(), { x: 22, y: 12, width: 270, height: 180 });
  manager.dispose();
});

test('sender validation binds IPC to the exact popup webContents and exact local file URL', () => {
  const { manager } = fixture({ enabled: true });
  manager.upsert(permission('secure'));
  const entry = [...manager.windows.values()][0];
  assert.strictEqual(manager.validateSender(eventFor(entry.window)), entry);
  assert.equal(manager.validateSender({ sender: new FakeWebContents(), senderFrame: { url: manager.allowedUrl } }), null);
  assert.equal(manager.validateSender(eventFor(entry.window, 'https://attacker.example/')), null);
  entry.window.webContents.url = 'file:///different.html';
  assert.equal(manager.validateSender(eventFor(entry.window, manager.allowedUrl)), null);
  assert.throws(() => manager.handleReady({ sender: new FakeWebContents() }), error => error.code === 'ATTENTION_POPUP_UNAUTHORIZED');
  entry.window.webContents.url = manager.allowedUrl;
  const navigation = { prevented: false, preventDefault() { this.prevented = true; } };
  entry.window.webContents.emit('will-navigate', navigation, 'https://attacker.example/');
  assert.equal(navigation.prevented, true);
  const allowed = { prevented: false, preventDefault() { this.prevented = true; } };
  entry.window.webContents.emit('will-navigate', allowed, manager.allowedUrl);
  assert.equal(allowed.prevented, false);
  manager.dispose();
});

test('permission decisions are allow/deny only without a server-provided suggestion, callback context remains main-only, and duplicates stay suppressed', async () => {
  const { manager, calls } = fixture({ enabled: true });
  manager.reconcile('permission-source', [permission('permission-1')]);
  const entry = [...manager.windows.values()][0];
  const ready = manager.handleReady(eventFor(entry.window));
  assert.equal(Object.prototype.hasOwnProperty.call(ready.request, 'context'), false);
  const rejected = await manager.handleDecide(eventFor(entry.window), { action: 'maybe' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'ATTENTION_POPUP_INVALID_DECISION');
  assert.equal(manager.status().windowCount, 1);
  const accepted = await manager.handleDecide(eventFor(entry.window), { action: 'allow', injected: 'ignored' });
  assert.deepStrictEqual(accepted, { ok: true });
  assert.deepStrictEqual(calls.decide[0].decision, { action: 'allow' });
  assert.deepStrictEqual(calls.decide[0].context.context, { secretTarget: 'terminal-permission-1' });
  assert.equal(manager.status().windowCount, 0);
  assert.equal(manager.status().suppressedCount, 1);
  manager.reconcile('permission-source', [permission('permission-1')]);
  assert.equal(manager.status().windowCount, 0, 'unresolved source echo must not recreate a decided popup');
  manager.reconcile('permission-source', []);
  assert.equal(manager.status().suppressedCount, 0);
  manager.dispose();
});

test('permission suggestions and question denial are canonicalized only from the displayed allowlists', () => {
  const permissionRequest = normalizeRequest({
    id: 'permission-with-suggestion',
    type: 'permission',
    toolLabel: 'BASH',
    meta: 'media_dashboard · #TZi',
    permissionSuggestions: [{ id: 'always-python', label: '항상 허용 `python -c *`', description: '이 명령 범위만 허용' }],
  });
  assert.equal(permissionRequest.toolLabel, 'BASH');
  assert.equal(permissionRequest.meta, 'media_dashboard · #TZi');
  assert.deepStrictEqual(permissionRequest.permissionSuggestions, [{
    id: 'always-python', label: '항상 허용 `python -c *`', description: '이 명령 범위만 허용',
  }]);
  assert.deepStrictEqual(canonicalDecision(permissionRequest, {
    action: 'suggestion', suggestionId: 'always-python', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }],
  }), { action: 'suggestion', suggestionId: 'always-python' });
  assert.throws(
    () => canonicalDecision(permissionRequest, { action: 'suggestion', suggestionId: 'forged' }),
    error => error.code === 'ATTENTION_POPUP_INVALID_DECISION',
  );

  const questionRequest = normalizeRequest({
    id: 'question-with-deny', type: 'question', canDeny: true,
    questions: [{ id: 'environment', question: '어디서 실행할까요?' }],
  });
  assert.deepStrictEqual(canonicalDecision(questionRequest, { action: 'deny', answers: [{ questionId: 'forged' }] }), { action: 'deny' });
  const answerOnly = normalizeRequest({
    id: 'question-without-deny', type: 'question',
    questions: [{ id: 'environment', question: '어디서 실행할까요?' }],
  });
  assert.throws(
    () => canonicalDecision(answerOnly, { action: 'deny' }),
    error => error.code === 'ATTENTION_POPUP_INVALID_DECISION',
  );
});

test('a callback-resolved source leaves no stale suppression and the same terminal fingerprint can appear in a new lifecycle', async () => {
  let manager;
  const fixtureResult = fixture({
    enabled: true,
    onDecide: () => {
      manager.reconcile('terminal', []);
      return { ok: true };
    },
  });
  manager = fixtureResult.manager;
  const terminalRequest = () => ({
    id: 'session:terminal:codex-edit:src/example.js',
    type: 'terminal-approval',
    title: '파일 수정 승인',
    body: 'AI가 요청한 파일 수정을 적용할까요?',
    choices: [{ id: 'proceed', label: '이번 수정 진행' }],
    context: { fingerprint: 'codex-edit:src/example.js' },
  });

  for (let lifecycle = 0; lifecycle < 3; lifecycle += 1) {
    manager.reconcile('terminal', [terminalRequest()]);
    const entry = manager.windows.get('terminal\u0000session:terminal:codex-edit:src/example.js');
    assert.ok(entry, `lifecycle ${lifecycle + 1} must show the recurring fingerprint`);
    manager.handleReady(eventFor(entry.window));
    assert.deepStrictEqual(
      await manager.handleDecide(eventFor(entry.window), { action: 'choice', choiceId: 'proceed' }),
      { ok: true },
    );
    assert.equal(manager.status().requestCount, 0);
    assert.equal(manager.status().windowCount, 0);
    assert.equal(manager.status().suppressedCount, 0, 'resolved lifecycles must not accumulate stale suppression');
  }
  manager.dispose();
});

test('question decisions validate single, multi, Other, required, free-text, and unknown answers', () => {
  const request = normalizeRequest({
    id: 'questions', type: 'question', questions: [
      { id: 'environment', question: '환경?', options: [{ value: 'wsl', label: 'WSL' }, { value: 'win', label: 'Windows' }] },
      { id: 'checks', question: '검사?', multiple: true, options: ['lint', 'test'], allowOther: true },
      { id: 'note', question: '메모?', required: false },
    ],
  });
  assert.deepStrictEqual(canonicalDecision(request, {
    action: 'answer', answers: [
      { questionId: 'environment', values: ['wsl'] },
      { questionId: 'checks', values: ['lint'], otherText: '보안 검사' },
      { questionId: 'note', text: '배포 전에 실행' },
    ],
  }), {
    action: 'answer', answers: [
      { questionId: 'environment', values: ['wsl'], otherText: '', text: '' },
      { questionId: 'checks', values: ['lint'], otherText: '보안 검사', text: '' },
      { questionId: 'note', values: [], otherText: '', text: '배포 전에 실행' },
    ],
  });
  assert.throws(() => canonicalDecision(request, { action: 'answer', answers: [
    { questionId: 'environment', values: ['wsl', 'win'] },
    { questionId: 'checks', values: ['lint'] },
  ] }), error => error.code === 'ATTENTION_POPUP_INVALID_DECISION');
  assert.throws(() => canonicalDecision(request, { action: 'answer', answers: [
    { questionId: 'environment', values: ['mac'] },
    { questionId: 'checks', values: ['lint'] },
  ] }), error => error.code === 'ATTENTION_POPUP_INVALID_DECISION');
  assert.throws(() => canonicalDecision(request, { action: 'answer', answers: [
    { questionId: 'checks', values: ['lint'] },
  ] }), error => error.code === 'ATTENTION_POPUP_INCOMPLETE_DECISION');
  assert.throws(() => canonicalDecision(request, { action: 'answer', answers: [
    { questionId: 'environment', values: ['wsl'] },
    { questionId: 'checks', values: ['lint'] },
    { questionId: 'intruder', text: 'ignored' },
  ] }), error => error.code === 'ATTENTION_POPUP_INVALID_DECISION');
});

test('free-text question is focused, terminal choices are allowlisted, and input request is read-only/open-main', async () => {
  const { manager, calls } = fixture({ enabled: true });
  manager.upsert({ id: 'free', type: 'question', questions: [{ id: 'answer', question: '설명해 주세요.' }] }, 'question');
  const freeEntry = manager.windows.get('question\u0000free');
  manager.handleReady(eventFor(freeEntry.window));
  assert.equal(freeEntry.window.shown, 1);
  assert.equal(freeEntry.window.focused, 1);
  assert.equal(freeEntry.window.shownInactive, 0);

  manager.upsert({ id: 'terminal', type: 'terminal-approval', choices: [{ id: 'once', label: '이번만' }, { id: 'always', label: '항상' }] }, 'terminal');
  const terminalEntry = manager.windows.get('terminal\u0000terminal');
  manager.handleReady(eventFor(terminalEntry.window));
  const badChoice = await manager.handleDecide(eventFor(terminalEntry.window), { action: 'choice', choiceId: 'shell-injection' });
  assert.equal(badChoice.ok, false);
  const chosen = await manager.handleDecide(eventFor(terminalEntry.window), { action: 'choice', choiceId: 'once' });
  assert.equal(chosen.ok, true);
  assert.deepStrictEqual(calls.decide.at(-1).decision, { action: 'choice', choiceId: 'once' });

  manager.upsert({ id: 'readonly', type: 'input', body: '터미널에서 답변해 주세요.' }, 'input');
  const inputEntry = manager.windows.get('input\u0000readonly');
  manager.handleReady(eventFor(inputEntry.window));
  const cannotDecide = await manager.handleDecide(eventFor(inputEntry.window), { action: 'answer', answers: [] });
  assert.equal(cannotDecide.error.code, 'ATTENTION_POPUP_READ_ONLY');
  const opened = await manager.handleOpenMain(eventFor(inputEntry.window));
  assert.deepStrictEqual(opened, { ok: true });
  assert.equal(calls.open.at(-1).request.id, 'readonly');
  assert.equal(manager.windows.has('input\u0000readonly'), false);
  manager.dispose();
});

test('toggle off emits no-decision dismissal, closes all, and toggle on restores unresolved requests', async () => {
  const { manager, calls } = fixture({ enabled: true });
  manager.reconcile([permission('one'), permission('two')]);
  assert.equal(manager.status().windowCount, 2);
  manager.setEnabled(false);
  await flush();
  assert.equal(manager.status().requestCount, 2);
  assert.equal(manager.status().windowCount, 0);
  assert.equal(calls.decide.length, 0);
  assert.deepStrictEqual(calls.dismiss.map(item => item.meta), [
    { reason: 'disabled', decision: null, willRestore: true },
    { reason: 'disabled', decision: null, willRestore: true },
  ]);
  manager.setEnabled(true);
  assert.equal(manager.status().windowCount, 2);
  assert.equal(FakeBrowserWindow.instances.length, 4);
  manager.dispose();
});

test('user dismissal suppresses the same revision while reconcile removal is silent', async () => {
  const { manager, calls } = fixture({ enabled: true });
  manager.reconcile('agent', [permission('dismiss-me'), permission('resolve-me')]);
  const dismissedEntry = manager.windows.get('agent\u0000dismiss-me');
  manager.handleReady(eventFor(dismissedEntry.window));
  assert.deepStrictEqual(await manager.handleDismiss(eventFor(dismissedEntry.window)), { ok: true });
  assert.equal(calls.dismiss.length, 1);
  assert.deepStrictEqual(calls.dismiss[0].meta, { reason: 'user', decision: null, willRestore: false });
  manager.reconcile('agent', [permission('dismiss-me')]);
  assert.equal(calls.dismiss.length, 1, 'source resolution must not be reported as a user dismissal');
  assert.equal(manager.status().windowCount, 0);
  manager.reconcile('agent', [permission('dismiss-me', '', { body: '새로운 내용' })]);
  assert.equal(manager.status().windowCount, 1, 'a changed revision must escape stale dismissal suppression');
  manager.dispose();
});

test('async decide, dismiss, and open-main completions cannot close a newer revision of the same request', async () => {
  const runRace = async ({ action, invoke, options }) => {
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    const observed = [];
    const { manager } = fixture({
      enabled: true,
      ...options(gate, observed),
    });
    manager.upsert(permission(action, '', {
      body: `old ${action}`,
      openMain: action === 'open-main',
    }), 'hook');
    const entry = manager.windows.get(`hook\u0000${action}`);
    manager.handleReady(eventFor(entry.window));

    const pending = invoke(manager, entry);
    assert.equal(entry.busy, true);
    manager.upsert(permission(action, '', {
      body: `new ${action}`,
      openMain: action === 'open-main',
    }), 'hook');
    assert.strictEqual(manager.windows.get(`hook\u0000${action}`), entry, `${action} must reuse the active popup window`);
    assert.equal(entry.record.request.body, `new ${action}`);
    assert.equal(entry.window.webContents.messages.at(-1).channel, 'attention-popup:request');
    assert.equal(entry.window.webContents.messages.at(-1).payload.body, `new ${action}`);

    finish({ ok: true });
    assert.deepStrictEqual(await pending, { ok: true });
    assert.equal(entry.busy, false);
    assert.equal(entry.window.closed, false, `${action} completion closed the newer revision`);
    assert.strictEqual(manager.windows.get(`hook\u0000${action}`), entry);
    assert.equal(manager.status().suppressedCount, 0, `${action} completion suppressed the newer revision`);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].request.body, `old ${action}`, `${action} callback did not retain its starting request snapshot`);
    assert.deepStrictEqual(observed[0].context.context, { secretTarget: `terminal-${action}` });
    manager.dispose();
  };

  await runRace({
    action: 'decide',
    invoke: (manager, entry) => manager.handleDecide(eventFor(entry.window), { action: 'allow' }),
    options: (gate, observed) => ({
      onDecide: (request, decision, context) => {
        observed.push({ request, decision, context });
        return gate;
      },
    }),
  });
  await runRace({
    action: 'dismiss',
    invoke: (manager, entry) => manager.handleDismiss(eventFor(entry.window)),
    options: (gate, observed) => ({
      onDismiss: (request, meta, context) => {
        observed.push({ request, meta, context });
        return gate;
      },
    }),
  });
  await runRace({
    action: 'open-main',
    invoke: (manager, entry) => manager.handleOpenMain(eventFor(entry.window)),
    options: (gate, observed) => ({
      onOpenMain: (request, context) => {
        observed.push({ request, context });
        return gate;
      },
    }),
  });
});

test('display changes reflow each display stack and preserve explicit display affinity', () => {
  const screen = new FakeScreen([
    { id: 1, workArea: { x: 0, y: 0, width: 1000, height: 800 } },
    { id: 2, workArea: { x: 1000, y: 40, width: 600, height: 700 } },
  ]);
  const { manager } = fixture({ enabled: true, screen });
  manager.upsert(permission('secondary', '', { displayId: 2 }));
  const entry = [...manager.windows.values()][0];
  manager.handleReady(eventFor(entry.window));
  manager.handleResize(eventFor(entry.window), { height: 110 });
  assert.deepStrictEqual(entry.window.getBounds(), { x: 1252, y: 622, width: 340, height: 110 });
  screen.displays[1].workArea = { x: 900, y: 20, width: 500, height: 500 };
  screen.emit('display-metrics-changed', {}, screen.displays[1], ['workArea']);
  assert.deepStrictEqual(entry.window.getBounds(), { x: 1052, y: 402, width: 340, height: 110 });
  manager.dispose();
  assert.equal(screen.listenerCount('display-added'), 0);
  assert.equal(screen.listenerCount('display-removed'), 0);
  assert.equal(screen.listenerCount('display-metrics-changed'), 0);
});

test('callback failure keeps the popup open and sends a bounded renderer error', async () => {
  const failure = new Error('전송 경로가 응답을 거절했습니다.');
  failure.code = 'DELIVERY_REJECTED';
  const { manager, calls } = fixture({ enabled: true, onDecide: async () => { throw failure; } });
  manager.upsert(permission('retry'));
  const entry = [...manager.windows.values()][0];
  manager.handleReady(eventFor(entry.window));
  const result = await manager.handleDecide(eventFor(entry.window), { action: 'deny' });
  assert.deepStrictEqual(result, { ok: false, error: { code: 'DELIVERY_REJECTED', message: failure.message } });
  assert.equal(manager.status().windowCount, 1);
  assert.equal(calls.errors.at(-1).detail.phase, 'decide');
  assert.deepStrictEqual(entry.window.webContents.messages.at(-1), {
    channel: 'attention-popup:error',
    payload: { code: 'DELIVERY_REJECTED', message: failure.message },
  });
  manager.dispose();
});

test('load, renderer, and unexpected-window failures release each request exactly once without affecting normal closes', async () => {
  const loadFailure = new Error('popup asset unavailable');
  class RejectingBrowserWindow extends FakeBrowserWindow {
    loadFile(file) {
      this.loadedFile = file;
      this.webContents.url = pathToFileURL(file).href;
      return Promise.reject(loadFailure);
    }
  }

  const rejected = fixture({ enabled: true, BrowserWindow: RejectingBrowserWindow });
  rejected.manager.upsert(permission('load-failure'), 'hook');
  const rejectedWindow = FakeBrowserWindow.instances[0];
  await flush();
  rejectedWindow.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  rejectedWindow.emit('closed');
  await flush();
  assert.deepStrictEqual(rejected.calls.dismiss.map(item => item.meta), [
    { reason: 'failure', decision: null, willRestore: false },
  ]);
  assert.equal(rejected.calls.errors.filter(item => item.detail.phase === 'load-file').length, 1);
  assert.equal(rejected.manager.status().windowCount, 0);
  assert.equal(rejected.manager.status().suppressedCount, 1);
  rejected.manager.dispose();

  const crashed = fixture({ enabled: true });
  crashed.manager.upsert(permission('renderer-failure'), 'hook');
  const crashedEntry = [...crashed.manager.windows.values()][0];
  crashedEntry.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  crashedEntry.window.webContents.emit('render-process-gone', {}, { reason: 'crashed-again' });
  crashedEntry.window.emit('closed');
  await flush();
  assert.deepStrictEqual(crashed.calls.dismiss.map(item => item.meta), [
    { reason: 'failure', decision: null, willRestore: false },
  ]);
  assert.equal(crashed.calls.errors.filter(item => item.detail.phase === 'renderer-gone').length, 1);
  crashed.manager.dispose();

  const externallyClosed = fixture({ enabled: true });
  externallyClosed.manager.upsert(permission('window-failure'), 'hook');
  const externalEntry = [...externallyClosed.manager.windows.values()][0];
  externalEntry.window.close();
  externalEntry.window.emit('closed');
  await flush();
  assert.deepStrictEqual(externallyClosed.calls.dismiss.map(item => item.meta), [
    { reason: 'failure', decision: null, willRestore: false },
  ]);
  assert.equal(externallyClosed.calls.errors.filter(item => item.detail.phase === 'window-closed').length, 1);

  externallyClosed.manager.reconcile('hook', [permission('normal-close')]);
  externallyClosed.manager.remove('hook', 'normal-close');
  await flush();
  assert.equal(externallyClosed.calls.dismiss.length, 1, 'normal source removal must not emit a failure dismissal');
  externallyClosed.manager.dispose();
});

test('renderer failure waits for in-flight decisions and user dismissals instead of sending a second fallback', async () => {
  let finishDecision;
  const decisionGate = new Promise(resolve => { finishDecision = resolve; });
  const deciding = fixture({ enabled: true, onDecide: () => decisionGate });
  deciding.manager.upsert(permission('deciding'), 'hook');
  const decisionEntry = [...deciding.manager.windows.values()][0];
  const decisionResult = deciding.manager.handleDecide(eventFor(decisionEntry.window), { action: 'allow' });
  decisionEntry.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  decisionEntry.window.emit('closed');
  finishDecision({ ok: true });
  assert.deepStrictEqual(await decisionResult, { ok: true });
  await flush();
  assert.equal(deciding.calls.dismiss.length, 0, 'a delivered decision must not also emit no-decision fallback');
  assert.equal(deciding.calls.errors.filter(item => item.detail.phase === 'renderer-gone').length, 1);
  deciding.manager.dispose();

  let finishDismiss;
  const dismissGate = new Promise(resolve => { finishDismiss = resolve; });
  const dismissEvents = [];
  const dismissing = fixture({
    enabled: true,
    onDismiss: (_request, meta) => {
      dismissEvents.push(meta);
      return dismissGate;
    },
  });
  dismissing.manager.upsert(permission('dismissing'), 'hook');
  const dismissEntry = [...dismissing.manager.windows.values()][0];
  const dismissResult = dismissing.manager.handleDismiss(eventFor(dismissEntry.window));
  dismissEntry.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  dismissEntry.window.emit('closed');
  finishDismiss({ ok: true });
  assert.deepStrictEqual(await dismissResult, { ok: true });
  await flush();
  assert.deepStrictEqual(dismissEvents, [{ reason: 'user', decision: null, willRestore: false }]);
  dismissing.manager.dispose();
});

test('main, preload, settings, and terminal prompt sources wire the interactive popup lifecycle end to end', () => {
  const root = path.resolve(__dirname, '../..');
  const source = file => fs.readFileSync(path.join(root, file), 'utf8');
  const main = source('main.js');
  const preload = source('preload.js');
  const appIpc = source('src/ipc/registerAppIpc.js');
  const bootstrap = source('renderer/app-bootstrap.js');
  const terminal = source('renderer/terminal.js');
  const index = source('renderer/index.html');
  const pkg = JSON.parse(source('package.json'));
  assert.match(main, /new AttentionPopupManager\(\{/);
  assert.match(main, /new AttentionHookServer\(\{/);
  assert.match(main, /new AttentionActivationCoordinator\(\{/);
  assert.match(main, /attentionPopups: attentionPopupPreferenceSnapshot\(\)/);
  assert.match(main, /attention-popup:ready/);
  assert.match(main, /attention-popup:resize/);
  assert.match(main, /attention-popup:decide/);
  assert.match(main, /attention-popup:dismiss/);
  assert.match(main, /attention-popup:open-main/);
  assert.match(main, /detectPendingPrompt\(terminal\.replay\)/);
  assert.match(main, /detected\.fingerprint !== context\.fingerprint/);
  assert.match(main, /agents:terminal-prompt-resolved/);
  assert.match(main, /requiresText: selected\.requiresText === true/);
  assert.match(main, /result\.review\?\.required === true \|\| result\.review\?\.state === 'review-required'/);
  assert.match(main, /permissionSuggestionId: suggestion\.id/);
  assert.match(main, /attentionHookServer\?\.resolve\(context\.hookKey, \{ action: 'none' \}\)/);
  assert.match(main, /openMainLabel: appLocale === 'ko' \? '터미널로 이동'/);
  assert.match(main, /canDeny: true/);
  assert.match(main, /openAttentionSession\(session, context\.kind === 'hook' \? 'terminal' : 'attention'\)/);
  assert.match(preload, /setAttentionPopups: preference => ipcRenderer\.invoke\('app:set-attention-popups'/);
  assert.match(preload, /ackAttentionActivation: result => ipcRenderer\.invoke\('app:ack-attention-activation'/);
  assert.match(preload, /syncAttentionPrompts: prompts => ipcRenderer\.invoke\('app:sync-attention-prompts'/);
  assert.match(preload, /onTerminalPromptResolved: callback/);
  assert.match(appIpc, /app:set-attention-popups/);
  assert.match(appIpc, /app:ack-attention-activation/);
  assert.match(appIpc, /app:sync-attention-prompts/);
  assert.match(bootstrap, /loadAttentionPopupSettings\(bootstrap\.attentionPopups\)/);
  assert.match(bootstrap, /bindAttentionPopupSettings\(\)/);
  assert.match(bootstrap, /resolveAttentionPrompt\?\.\(payload\)/);
  assert.match(bootstrap, /openForAgent\(session, resolution\.targetId\)/);
  assert.match(bootstrap, /createAttentionActivationController/);
  assert.match(bootstrap, /createTerminalIfMissing: false/);
  assert.match(bootstrap, /mountTerminal: false/);
  assert.match(bootstrap, /terminal\.agentTargets\(session\)/);
  assert.match(bootstrap, /focus: activation\.preservePopupFocus !== true/);
  assert.match(bootstrap, /payload\?\.event === 'terminal'/);
  assert.match(bootstrap, /terminal\.openForAgent\(session, '', '', \{/);
  assert.match(terminal, /syncPendingPromptsToMain\(prompts\)/);
  assert.match(terminal, /resolveAttentionPrompt/);
  assert.match(index, /id="attentionPopupEnabled"[^>]*role="switch"/);
  assert.match(index, /src="app-attention-popup-settings\.js"/);
  assert.match(index, /src="attention-activation\.js"/);
  assert.ok(pkg.files.includes('attention-popup-preload.js'));
  assert.ok(pkg.build.files.includes('attention-popup-preload.js'));
});

async function run() {
  let passed = 0;
  for (const item of tests) {
    try {
      await item.run();
      passed += 1;
      process.stdout.write(`PASS ${item.name}\n`);
    } catch (error) {
      process.stderr.write(`FAIL ${item.name}\n${error.stack}\n`);
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${passed}/${tests.length} attention popup manager tests passed\n`);
}

if (require.main === module) run();

module.exports = { registerAttentionPopupManagerTests: context => {
  for (const item of tests) context.test(item.name, item.run);
} };
