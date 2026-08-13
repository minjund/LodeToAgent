'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createElement(documentRef = () => null) {
  const classes = new Set();
  const changes = [];
  const element = {
    dataset: {},
    disabled: false,
    value: '',
    textContent: '',
    innerHTML: '',
    placeholder: '',
    isConnected: true,
    querySelector() { return createElement(documentRef); },
    appendChild(child) {
      child.parentElement = this;
      child.isConnected = this.isConnected;
      return child;
    },
    contains(candidate) {
      for (let current = candidate; current; current = current.parentElement) {
        if (current === this) return true;
      }
      return false;
    },
    remove() {
      this.parentElement = null;
      this.isConnected = false;
    },
    addEventListener() {},
    setAttribute() {},
    toggleAttribute() {},
    removeAttribute() {},
    focus() {
      const document = documentRef();
      if (document) document.activeElement = this;
    },
  };
  const record = (type, tokens) => {
    changes.push({ type, tokens: [...tokens] });
    if (type === 'add' && tokens.includes('hidden')) {
      const document = documentRef();
      if (document?.activeElement && element.contains(document.activeElement)) document.activeElement = document.body;
    }
  };
  element.classList = {
    changes,
    add(...tokens) {
      const added = tokens.filter(token => !classes.has(token));
      tokens.forEach(token => classes.add(token));
      if (added.length) record('add', added);
    },
    remove(...tokens) {
      const removed = tokens.filter(token => classes.delete(token));
      if (removed.length) record('remove', removed);
    },
    toggle(token, force) {
      const enabled = force === undefined ? !classes.has(token) : Boolean(force);
      if (enabled) this.add(token);
      else this.remove(token);
      return enabled;
    },
    contains(token) { return classes.has(token); },
  };
  Object.defineProperty(element, 'className', {
    get() { return [...classes].join(' '); },
    set(value) {
      const next = String(value || '').split(/\s+/).filter(Boolean);
      classes.clear();
      next.forEach(token => classes.add(token));
      changes.push({ type: 'set', tokens: next });
    },
  });
  return element;
}

function createWorkbench(root, options = {}) {
  const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-workbench.js'), 'utf8');
  let fixtureDocument = null;
  const createFixtureElement = () => createElement(() => fixtureDocument);
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, createFixtureElement());
    return elements.get(selector);
  };
  const terminalCalls = [];
  const rawWrites = [];
  const terminalInstances = [];
  const notices = [];
  const documentListeners = new Map();
  const session = options.session || null;
  const remote = options.remote || null;
  fixtureDocument = {
    body: createFixtureElement(),
    activeElement: null,
    hidden: options.visibilityState === 'hidden',
    visibilityState: options.visibilityState || 'visible',
    createElement: createFixtureElement,
    querySelector: element,
    querySelectorAll: () => [],
    getElementById: id => element(`#${id}`),
    addEventListener(type, callback) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(callback);
    },
    dispatchEvent(event) {
      for (const callback of documentListeners.get(String(event?.type || '')) || []) callback(event);
      return true;
    },
  };
  fixtureDocument.activeElement = fixtureDocument.body;
  const sandbox = {
    document: fixtureDocument,
    requestAnimationFrame: options.requestAnimationFrame || (callback => callback()),
    cancelAnimationFrame: options.cancelAnimationFrame || (() => {}),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    window: {
      cancelAnimationFrame: options.cancelAnimationFrame || (() => {}),
      LoadToAgentI18n: { t: key => key },
      Terminal: class FixtureTerminal {
        constructor() {
          this.writes = [];
          this.buffer = { active: { viewportY: 0, baseY: 0 } };
          terminalInstances.push(this);
        }
        loadAddon() {}
        open(host) {
          this.helperTextarea = createFixtureElement();
          this.helperTextarea.className = 'xterm-helper-textarea';
          host.appendChild(this.helperTextarea);
        }
        onScroll() {}
        onData(callback) { this.dataHandler = callback; }
        onResize() {}
        attachCustomKeyEventHandler(callback) { this.keyEventHandler = callback; }
        focus() { this.helperTextarea?.focus(); }
        write(data, callback) { this.writes.push(String(data)); callback?.(); }
        dispose() {}
      },
      FitAddon: { FitAddon: class FixtureFitAddon { fit() {} } },
      loadtoagent: {
        terminalList: options.terminalList || (async () => []),
        terminalGet: options.terminalGet || (async () => ({ replay: '', outputSequence: 0 })),
        terminalWrite: async (id, data, deliveryOptions) => {
          rawWrites.push([id, data, deliveryOptions]);
          if (options.terminalWrite) return options.terminalWrite(id, data, deliveryOptions, rawWrites.length);
          return { ok: true, deliveryState: 'accepted' };
        },
        terminalCommand: async (id, text, deliveryOptions) => {
          terminalCalls.push([id, text, deliveryOptions]);
          return options.terminalCommandResult || { ok: true };
        },
      },
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'terminal-workbench.js' });
  const state = {
    sessions: session ? [session] : [],
    selectedId: session?.id || null,
    selectedTmux: remote,
    snapshot: null,
    mode: remote ? 'tmux' : 'general',
    interactionMode: options.interactionMode || 'computer',
    commandSending: false,
    commandDrafts: new Map(),
    commandDeliveries: new Map(),
    terminals: new Map(),
    remoteTerminal: {
      host: createFixtureElement(),
      terminal: { clear() {}, reset() {} },
      fit: { fit() {} },
      readOnly: true,
    },
    captureGeneration: 0,
    terminalSessionRevision: 0,
    terminalListRequestGeneration: 0,
    sessionOrder: [],
    sessionRenderKey: '',
    active: false,
    platform: { label: 'Test computer' },
  };
  const workbench = sandbox.window.LoadToAgentTerminalWorkbench({
    $: element,
    state,
    notice: (message, tone) => notices.push([message, tone]),
    setConnectionState() {},
    currentSession: () => session,
    currentTmux: () => remote,
    saveCurrentDraft() {},
    restoreCurrentDraft() {},
    renderHistoryPanel() {},
    terminalTypeMark: () => '›_',
    terminalTypeLabel: () => 'shell',
    providerLabel: provider => provider || 'AI',
    xtermOptions: () => ({}),
    preferredWorkspace: () => '',
    firstDistro: () => null,
    guarded: async action => action(),
    esc: value => String(value ?? ''),
    errorMessage: error => String(error),
    modeSessions: () => state.sessions,
    STATUS_LABELS: {},
    visibleBoundAgent: () => options.boundAgent || null,
    moveWorkbench() {},
    syncComposer() {},
    tmuxRows: () => options.tmuxRows || [],
    updateSnapshot() {},
  });
  return { state, workbench, terminalCalls, rawWrites, terminalInstances, notices, elements, document: fixtureDocument };
}

function loadPreloadApi(root, invoke) {
  const source = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  let exposed = null;
  const ipcRenderer = {
    invoke,
    on() {},
    removeListener() {},
  };
  vm.runInNewContext(source, {
    require: name => {
      if (name === 'electron') {
        return {
          ipcRenderer,
          contextBridge: {
            exposeInMainWorld(name, value) {
              if (name === 'loadtoagent') exposed = value;
            },
          },
        };
      }
      throw new Error(`unexpected preload dependency: ${name}`);
    },
  }, { filename: 'preload.js' });
  return exposed;
}

function registerTerminalInteractionTests(context) {
  const { test, root } = context;

  function terminalWriteHandler(write) {
    const handlers = new Map();
    const { registerTerminalIpc } = require(path.join(root, 'src', 'ipc', 'registerTerminalIpc'));
    registerTerminalIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      requireTrustedSender() {},
      manager: () => ({ write }),
      listWslDistros: () => [],
    });
    return handlers.get('terminals:write');
  }

  test('늦은 터미널 목록 응답이 더 최신 state 이벤트를 덮어쓰지 않는다', async () => {
    let resolveList;
    const pendingList = new Promise(resolve => { resolveList = resolve; });
    const { state, workbench } = createWorkbench(root, {
      terminalList: () => pendingList,
    });
    const staleRefresh = workbench.refreshSessions();
    await Promise.resolve();
    await workbench.refreshSessions({
      change: 'created',
      sessions: [{ id: 'terminal:new', type: 'agent', status: 'running', title: '새 PTY' }],
    });
    resolveList([{ id: 'terminal:old', type: 'agent', status: 'running', title: '옛 PTY' }]);
    await staleRefresh;

    assert.deepStrictEqual(state.sessions.map(session => session.id), ['terminal:new']);
  });

  test('동일 선택 PTY의 state 갱신은 보이는 xterm과 입력 포커스를 유지한다', async () => {
    let terminalGetCalls = 0;
    const session = { id: 'terminal:stable-refresh', type: 'agent', status: 'running', title: 'Stable PTY' };
    const { state, workbench, terminalInstances, document } = createWorkbench(root, {
      session,
      terminalGet: async () => {
        terminalGetCalls += 1;
        return { replay: 'ready\r\n', outputSequence: 1 };
      },
    });

    const entry = await workbench.ensureSessionTerminal(session);
    entry.host.classList.remove('hidden');
    state.active = true;
    terminalInstances[0].helperTextarea.focus();
    entry.host.classList.changes.length = 0;

    await workbench.refreshSessions({
      change: 'updated',
      sessions: [{ ...session, updatedAt: '2026-08-11T00:00:00.000Z' }],
    });

    assert.strictEqual(state.terminals.get(session.id), entry, '같은 PTY state 갱신이 xterm entry를 교체했습니다.');
    assert.equal(entry.host.classList.contains('hidden'), false, '선택된 PTY가 state 갱신 뒤 숨겨졌습니다.');
    assert.equal(
      entry.host.classList.changes.some(change => change.type === 'add' && change.tokens.includes('hidden')),
      false,
      '동일 선택 state 갱신 중 xterm을 잠시 hidden으로 전환하면 화면 깜빡임과 IME 중단이 발생합니다.',
    );
    assert.strictEqual(document.activeElement, terminalInstances[0].helperTextarea,
      '동일 선택 state 갱신이 xterm 입력 포커스를 잃었습니다.');
    assert.equal(terminalGetCalls, 1, '동일 xterm state 갱신이 replay를 다시 조회했습니다.');
  });

  test('host reconnect로 xterm을 교체하면 사용 중이던 PTY 입력 포커스를 조건부 복원한다', async () => {
    const session = { id: 'terminal:reconnect-focus', type: 'agent', status: 'running', title: 'Reconnect focus PTY' };
    const { state, workbench, terminalInstances, document } = createWorkbench(root, { session });
    const oldEntry = await workbench.ensureSessionTerminal(session);
    oldEntry.host.classList.remove('hidden');
    state.active = true;
    terminalInstances[0].helperTextarea.focus();

    await workbench.refreshSessions({ change: 'reconnected', sessions: [{ ...session }] });

    assert.equal(terminalInstances.length, 2, 'reconnect 뒤 xterm entry를 다시 만들지 않았습니다.');
    assert.strictEqual(document.activeElement, terminalInstances[1].helperTextarea,
      'reconnect 직전 사용 중이던 PTY의 입력 포커스를 새 xterm에 복원하지 않았습니다.');
  });

  test('xterm 입력 pump는 한 프레임의 IME 조각을 묶고 deliveryId로 순서대로 전달한다', async () => {
    const frames = [];
    const session = { id: 'terminal:raw-input-pump', type: 'agent', status: 'running', title: 'Input PTY' };
    const { state, workbench, terminalInstances, rawWrites } = createWorkbench(root, {
      session,
      requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    });
    const entry = await workbench.ensureSessionTerminal(session);
    entry.host.classList.remove('hidden');
    state.active = true;

    terminalInstances[0].dataHandler('한');
    terminalInstances[0].dataHandler('글😀');
    terminalInstances[0].dataHandler('\r');
    assert.equal(rawWrites.length, 0, '같은 화면 프레임의 IME 조각마다 IPC를 즉시 만들었습니다.');
    assert.equal(frames.length, 1, '입력 pump animation frame을 중복 예약했습니다.');

    frames.shift()();
    await entry.writeQueue;
    assert.equal(rawWrites.length, 1);
    assert.equal(rawWrites[0][0], session.id);
    assert.equal(rawWrites[0][1], '한글😀\r');
    assert.match(rawWrites[0][2]?.deliveryId || '', /^delivery:raw:/);

    terminalInstances[0].dataHandler('다음');
    assert.equal(frames.length, 1);
    frames.shift()();
    await entry.writeQueue;
    assert.equal(rawWrites.length, 2);
    assert.equal(rawWrites[1][1], '다음');
    assert.match(rawWrites[1][2]?.deliveryId || '', /^delivery:raw:/);
    assert.notEqual(rawWrites[0][2].deliveryId, rawWrites[1][2].deliveryId);
  });

  test('Shift+Tab은 PTY backtab으로 보내면서 브라우저 포커스 이동을 막는다', async () => {
    const frames = [];
    const session = { id: 'terminal:shift-tab', type: 'agent', status: 'running', title: 'Mode switch PTY' };
    const { state, workbench, terminalInstances, rawWrites } = createWorkbench(root, {
      session,
      requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    });
    const entry = await workbench.ensureSessionTerminal(session);
    entry.host.classList.remove('hidden');
    state.active = true;
    const terminal = terminalInstances[0];
    let defaultPrevented = false;
    let propagationStopped = false;
    const accepted = terminal.keyEventHandler({
      type: 'keydown', key: 'Tab', shiftKey: true,
      altKey: false, ctrlKey: false, metaKey: false,
      preventDefault() { defaultPrevented = true; },
      stopPropagation() { propagationStopped = true; },
    });

    assert.equal(accepted, true, 'custom handler가 xterm의 Shift+Tab 처리를 막았습니다.');
    assert.equal(defaultPrevented, true, 'Chromium의 역방향 포커스 이동을 취소하지 않았습니다.');
    assert.equal(propagationStopped, true, '상위 dialog 포커스 트랩까지 Shift+Tab이 전파됐습니다.');

    // xterm 6 converts the accepted Shift+Tab event to the VT backtab
    // sequence before raising onData. Verify the app preserves that sequence.
    terminal.dataHandler('\u001b[Z');
    frames.shift()();
    await entry.writeQueue;
    assert.equal(rawWrites.length, 1);
    assert.equal(rawWrites[0][1], '\u001b[Z');

    // The app normally focuses its separate command composer after selecting
    // an AI. That surface must route the same backtab sequence through the
    // selected PTY's ordered raw-input queue.
    assert.equal(workbench.sendRawInputToCurrentSession('\u001b[Z'), true);
    frames.shift()();
    await entry.writeQueue;
    assert.equal(rawWrites.length, 2);
    assert.equal(rawWrites[1][1], '\u001b[Z');
    assert.match(rawWrites[1][2]?.deliveryId || '', /^delivery:raw:/);

    const eventSource = fs.readFileSync(path.join(root, 'renderer', 'terminal-events.js'), 'utf8');
    const eventSandbox = { window: {} };
    vm.runInNewContext(eventSource, eventSandbox, { filename: 'terminal-events.js' });
    const handleModeCycle = eventSandbox.window.LoadToAgentTerminalEventKeys.handleClaudeModeCycle;
    const composerWrites = [];
    let composerDefaultPrevented = 0;
    let composerPropagationStopped = 0;
    let menuClosed = 0;
    const composerEvent = {
      type: 'keydown', key: 'Tab', shiftKey: true,
      altKey: false, ctrlKey: false, metaKey: false,
      preventDefault() { composerDefaultPrevented += 1; },
      stopPropagation() { composerPropagationStopped += 1; },
    };
    assert.equal(handleModeCycle(composerEvent, {
      provider: 'claude',
      isAiSession: true,
      sendRawInput: data => { composerWrites.push(data); return true; },
      closeMenu: () => { menuClosed += 1; },
    }), true);
    assert.deepStrictEqual(composerWrites, ['\u001b[Z']);
    assert.equal(composerDefaultPrevented, 1);
    assert.equal(composerPropagationStopped, 1);
    assert.equal(menuClosed, 1);

    for (const provider of ['codex', 'gemini', 'grok']) {
      assert.equal(handleModeCycle(composerEvent, {
        provider,
        isAiSession: true,
        sendRawInput: data => { composerWrites.push(data); return true; },
      }), false);
    }
    assert.deepStrictEqual(composerWrites, ['\u001b[Z'], '비-Claude PTY에 mode 제어문자를 보내면 안 됩니다.');
    assert.equal(composerDefaultPrevented, 1, '비-Claude 입력창의 역방향 포커스 이동을 막으면 안 됩니다.');
    assert.equal(composerPropagationStopped, 1, '비-Claude Shift+Tab 전파를 막으면 안 됩니다.');
  });

  test('창이 hidden으로 바뀌면 대기 중인 raw 입력을 animation frame 없이 즉시 전달한다', async () => {
    const frames = [];
    const session = { id: 'terminal:raw-input-hidden', type: 'agent', status: 'running', title: 'Hidden input PTY' };
    const { state, workbench, terminalInstances, rawWrites, document } = createWorkbench(root, {
      session,
      requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    });
    const entry = await workbench.ensureSessionTerminal(session);
    entry.host.classList.remove('hidden');
    state.active = true;

    terminalInstances[0].dataHandler('숨기기 직전 입력\r');
    assert.equal(frames.length, 1, '보이는 동안의 짧은 입력 burst batching을 제거했습니다.');
    document.hidden = true;
    document.visibilityState = 'hidden';
    document.dispatchEvent({ type: 'visibilitychange' });
    await Promise.resolve();
    await entry.writeQueue;

    assert.equal(rawWrites.length, 1, 'hidden 전환으로 마지막 PTY 입력이 animation frame에 갇혔습니다.');
    assert.equal(rawWrites[0][1], '숨기기 직전 입력\r');
    assert.equal(frames.length, 1, '검증 중 animation frame callback을 실행하면 hidden 경계를 확인할 수 없습니다.');
  });

  test('terminal write IPC unknown envelope는 preload Error 메타데이터를 보존한다', async () => {
    const write = terminalWriteHandler(() => {
      const error = new Error('응답 유실로 입력 상태를 확인할 수 없습니다.');
      error.code = 'TERMINAL_WRITE_UNCERTAIN';
      error.deliveryId = 'delivery:raw:unknown';
      error.deliveryState = 'unknown';
      throw error;
    });
    const api = loadPreloadApi(root, (channel, ...args) => {
      assert.equal(channel, 'terminals:write');
      return write({}, ...args);
    });

    await assert.rejects(
      api.terminalWrite('terminal:unknown', '입력', { deliveryId: 'delivery:raw:unknown' }),
      error => error.message === '응답 유실로 입력 상태를 확인할 수 없습니다.'
        && error.code === 'TERMINAL_WRITE_UNCERTAIN'
        && error.deliveryId === 'delivery:raw:unknown'
        && error.deliveryState === 'unknown',
    );
  });

  test('terminal write IPC rejected envelope는 preload reject 계약과 성공 결과를 유지한다', async () => {
    const write = terminalWriteHandler((_id, data) => {
      if (data === '성공') return { ok: true, deliveryId: 'delivery:raw:accepted', deliveryState: 'accepted' };
      const error = new Error('PTY에 쓰기 전에 거절했습니다.');
      error.code = 'TERMINAL_WRITE_NOT_SENT';
      error.deliveryId = 'delivery:raw:rejected';
      error.deliveryState = 'rejected';
      throw error;
    });
    const api = loadPreloadApi(root, (_channel, ...args) => write({}, ...args));

    await assert.rejects(
      api.terminalWrite('terminal:rejected', '거절', { deliveryId: 'delivery:raw:rejected' }),
      error => error.message === 'PTY에 쓰기 전에 거절했습니다.'
        && error.code === 'TERMINAL_WRITE_NOT_SENT'
        && error.deliveryId === 'delivery:raw:rejected'
        && error.deliveryState === 'rejected',
    );
    assert.deepStrictEqual(
      await api.terminalWrite('terminal:accepted', '성공', { deliveryId: 'delivery:raw:accepted' }),
      { ok: true, deliveryId: 'delivery:raw:accepted', deliveryState: 'accepted' },
    );
  });

  test('확인 불명 raw 입력 뒤에는 같은 프레임의 suffix를 자동 전송하지 않는다', async () => {
    const frames = [];
    const session = { id: 'terminal:raw-input-unknown', type: 'agent', status: 'running', title: 'Unknown input PTY' };
    const { state, workbench, terminalInstances, rawWrites, notices } = createWorkbench(root, {
      session,
      requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
      terminalWrite: async (_id, _data, _deliveryOptions, callCount) => callCount === 1
        ? { ok: false, deliveryState: 'unknown' }
        : { ok: true, deliveryState: 'accepted' },
    });
    const entry = await workbench.ensureSessionTerminal(session);
    entry.host.classList.remove('hidden');
    state.active = true;

    terminalInstances[0].dataHandler('A'.repeat(128 * 1024));
    terminalInstances[0].dataHandler('SECOND\r');
    frames.shift()();
    await entry.writeQueue;

    assert.equal(rawWrites.length, 1, '확인 불명 head 뒤 queued suffix를 자동 전송했습니다.');
    assert.equal(rawWrites[0][1].length, 128 * 1024);
    assert.equal(notices.some(([, tone]) => tone === 'warning'), true);

    terminalInstances[0].dataHandler('RETRY\r');
    assert.equal(frames.length, 1, '사용자의 다음 명시적 입력으로 pump가 다시 열리지 않았습니다.');
    frames.shift()();
    await entry.writeQueue;
    assert.deepStrictEqual(rawWrites.map(([, data]) => data.length), [128 * 1024, 6]);
    assert.equal(rawWrites[1][1], 'RETRY\r');
  });

  test('reconnect는 이전 xterm tail을 버리고 in-flight 뒤 새 입력 순서를 보장한다', async () => {
    const frames = [];
    let resolveOldHead;
    const oldHeadPending = new Promise(resolve => { resolveOldHead = resolve; });
    const session = { id: 'terminal:raw-input-reconnect', type: 'agent', status: 'running', title: 'Reconnect input PTY' };
    const { state, workbench, terminalInstances, rawWrites } = createWorkbench(root, {
      session,
      requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
      terminalWrite: async (_id, _data, _deliveryOptions, callCount) => callCount === 1
        ? oldHeadPending
        : { ok: true, deliveryState: 'accepted' },
    });
    const oldEntry = await workbench.ensureSessionTerminal(session);
    oldEntry.host.classList.remove('hidden');
    terminalInstances[0].dataHandler('OLD_HEAD');
    frames.shift()();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(rawWrites.map(([, data]) => data), ['OLD_HEAD']);

    terminalInstances[0].dataHandler('OLD_TAIL');
    await workbench.refreshSessions({ change: 'reconnected', sessions: [{ ...session }] });
    const newEntry = await workbench.ensureSessionTerminal(session);
    terminalInstances[1].dataHandler('NEW_INPUT');
    frames.shift()();
    await Promise.resolve();
    assert.deepStrictEqual(rawWrites.map(([, data]) => data), ['OLD_HEAD'],
      '새 entry 입력이 이전 in-flight write보다 먼저 전달됐습니다.');

    resolveOldHead({ ok: true, deliveryState: 'accepted' });
    await Promise.all([oldEntry.writeQueue, newEntry.writeQueue]);
    assert.deepStrictEqual(rawWrites.map(([, data]) => data), ['OLD_HEAD', 'NEW_INPUT']);
  });

  test('큰 bracketed paste는 종료 제어문자를 자르지 않고 전체 거절한다', async () => {
    const frames = [];
    const session = { id: 'terminal:raw-input-paste-bound', type: 'agent', status: 'running', title: 'Paste bound PTY' };
    const { workbench, terminalInstances, rawWrites, notices } = createWorkbench(root, {
      session,
      requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    });
    await workbench.ensureSessionTerminal(session);
    const oversizedPaste = `\u001b[200~${'가'.repeat(128 * 1024)}\u001b[201~`;

    terminalInstances[0].dataHandler(oversizedPaste);

    assert.equal(frames.length, 0, '부분 paste를 보내는 input frame을 예약했습니다.');
    assert.equal(rawWrites.length, 0, 'bracketed paste의 prefix만 부분 전송했습니다.');
    assert.equal(notices.some(([, tone]) => tone === 'error'), true);
  });

  test('PTY replay hydration 중 도착한 live 출력은 sequence 기준으로 정확히 한 번만 이어 붙인다', async () => {
    let resolveGet;
    const pendingGet = new Promise(resolve => { resolveGet = resolve; });
    const session = { id: 'terminal:hydrate', type: 'agent', status: 'running', title: 'Hydration PTY' };
    const { state, workbench, terminalInstances } = createWorkbench(root, {
      session,
      terminalGet: () => pendingGet,
    });

    const ready = workbench.ensureSessionTerminal(session);
    await Promise.resolve();
    const entry = state.terminals.get(session.id);
    assert.ok(entry, 'terminalGet을 기다리는 동안에도 live event가 찾을 수 있게 entry를 먼저 등록해야 합니다.');
    assert.equal(entry.acceptOutput({ data: 'already-in-replay\r\n', outputSequence: 7 }), null);
    assert.equal(entry.acceptOutput({ data: 'live-once\r\n', outputSequence: 8 }), null);

    resolveGet({ replay: 'history\r\nalready-in-replay\r\n', outputSequence: 7 });
    await ready;

    assert.deepStrictEqual(terminalInstances[0].writes, [
      'history\r\nalready-in-replay\r\n',
      'live-once\r\n',
    ]);
    assert.equal(entry.outputSequence, 8);
    assert.equal(entry.acceptOutput({ data: 'duplicate-live\r\n', outputSequence: 8 }), null);
    assert.equal(entry.acceptOutput({ data: 'next-live\r\n', outputSequence: 9 }), 'next-live\r\n');

    const longReplay = 'x'.repeat((32 * 1024) + 1);
    const longSession = { id: 'terminal:long-replay', type: 'agent', status: 'running', title: 'Long replay PTY' };
    const longHydration = createWorkbench(root, {
      session: longSession,
      terminalGet: async () => ({ replay: longReplay, outputSequence: 1 }),
    });
    await longHydration.workbench.ensureSessionTerminal(longSession);
    assert.deepStrictEqual(
      longHydration.terminalInstances[0].writes.map(value => value.length),
      [32 * 1024, 1],
      'large replay must yield between bounded xterm writes',
    );
  });

  test('취소된 attention 이동은 느린 PTY hydration 뒤 이전 화면을 표시하지 않는다', async () => {
    let resolveGet;
    let current = true;
    const pendingGet = new Promise(resolve => { resolveGet = resolve; });
    const session = { id: 'terminal:attention-stale', type: 'agent', status: 'running', title: 'Stale attention PTY' };
    const { state, workbench } = createWorkbench(root, {
      session,
      terminalGet: () => pendingGet,
    });
    state.active = true;

    const selecting = workbench.selectSession(session.id, 'question', {
      attentionActivation: true,
      focus: false,
      isCurrent: () => current,
    });
    await Promise.resolve();
    const entry = state.terminals.get(session.id);
    assert.ok(entry);
    current = false;
    resolveGet({ replay: 'stale\r\n', outputSequence: 1 });

    assert.equal(await selecting, false);
    assert.equal(entry.host.classList.contains('hidden'), true);
  });

  test('질문 모드는 일반 셸에 질문을 명령으로 보내지 않는다', async () => {
    const session = {
      id: 'terminal:shell',
      type: 'shell',
      status: 'running',
      title: 'Plain shell',
      cwd: '/tmp',
    };
    const { workbench, terminalCalls, notices, elements } = createWorkbench(root, {
      session,
      interactionMode: 'question',
    });

    workbench.renderTarget();
    assert.equal(elements.get('#terminalCommandInput').disabled, true);
    assert.equal(elements.get('#terminalCommandInput').placeholder, 'terminal.agent.no_input_target');

    const sent = await workbench.sendCommand('이 질문에 답해 줘');

    assert.equal(sent, false);
    assert.deepStrictEqual(terminalCalls, []);
    assert.deepStrictEqual(notices, [['terminal.agent.no_input_target', 'error']]);
  });

  test('일반 tmux 선택은 질문 상태를 지우고 agent-bound 선택만 질문 상태를 보존한다', async () => {
    const row = {
      distro: { name: 'FixtureLinux' },
      session: { name: 'workspace' },
      window: { index: 0, name: 'main' },
      pane: { id: 'pane-7', nativeId: '%7', command: 'zsh', cwd: '/workspace', dead: false },
    };
    const ordinary = createWorkbench(root, {
      remote: row,
      tmuxRows: [row],
      interactionMode: 'question',
    });

    await ordinary.workbench.selectTmux('FixtureLinux', '%7', 'computer');
    assert.equal(ordinary.state.interactionMode, 'computer');

    const agentBound = createWorkbench(root, {
      remote: row,
      tmuxRows: [row],
      interactionMode: 'question',
      boundAgent: { id: 'agent:1', provider: 'claude', title: 'Claude task' },
    });
    await agentBound.workbench.selectTmux('FixtureLinux', '%7');
    assert.equal(agentBound.state.interactionMode, 'question');
  });

  test('AI 질문 화면의 확인 불명 응답은 초안을 유지하고 같은 질문을 다시 보내지 않는다', async () => {
    const session = {
      id: 'terminal:agent-unknown',
      type: 'agent',
      provider: 'codex',
      status: 'running',
      title: 'GPT terminal',
      cwd: '/tmp',
    };
    const { workbench, terminalCalls, notices } = createWorkbench(root, {
      session,
      interactionMode: 'question',
      boundAgent: { id: 'codex:unknown', provider: 'codex', title: 'GPT task' },
      terminalCommandResult: { ok: true, deliveryState: 'unknown' },
    });

    const first = await workbench.sendCommand('한 번만 보낼 질문');
    const second = await workbench.sendCommand('한 번만 보낼 질문');

    assert.equal(first, false);
    assert.equal(second, false);
    assert.equal(terminalCalls.length, 1);
    assert.match(terminalCalls[0][2].deliveryId, /^delivery:/);
    assert.deepStrictEqual(notices, [
      ['terminal.agent.delivery_uncertain', 'warning'],
      ['terminal.agent.delivery_uncertain', 'warning'],
    ]);

    const rejected = createWorkbench(root, {
      session: { ...session, id: 'terminal:agent-rejected' },
      interactionMode: 'question',
      boundAgent: { id: 'codex:rejected', provider: 'codex', title: 'GPT task' },
      terminalCommandResult: {
        ok: false,
        error: '질문을 쓰기 전에 안전하게 중단',
        deliveryState: 'rejected',
      },
    });
    const rejectedFirst = await rejected.workbench.sendCommand('초안을 유지하고 재시도할 질문');
    const rejectedSecond = await rejected.workbench.sendCommand('초안을 유지하고 재시도할 질문');
    assert.equal(rejectedFirst, false);
    assert.equal(rejectedSecond, false);
    assert.equal(rejected.terminalCalls.length, 2);
    assert.notEqual(rejected.terminalCalls[0][2].deliveryId, rejected.terminalCalls[1][2].deliveryId);
    assert.deepStrictEqual(rejected.notices, [
      ['agent.delivery_retry_ready', 'warning'],
      ['agent.delivery_retry_ready', 'warning'],
    ]);
  });
}

module.exports = { registerTerminalInteractionTests };
