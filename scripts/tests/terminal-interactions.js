'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createElement() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
    disabled: false,
    value: '',
    textContent: '',
    innerHTML: '',
    placeholder: '',
    isConnected: true,
    querySelector() { return createElement(); },
    setAttribute() {},
    toggleAttribute() {},
    removeAttribute() {},
    focus() {},
  };
}

function createWorkbench(root, options = {}) {
  const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-workbench.js'), 'utf8');
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, createElement());
    return elements.get(selector);
  };
  const terminalCalls = [];
  const notices = [];
  const session = options.session || null;
  const remote = options.remote || null;
  const sandbox = {
    document: {
      body: { dataset: {} },
      querySelector: element,
      querySelectorAll: () => [],
      getElementById: id => element(`#${id}`),
    },
    requestAnimationFrame: callback => callback(),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    window: {
      LoadToAgentI18n: { t: key => key },
      loadtoagent: {
        terminalList: options.terminalList || (async () => []),
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
      host: createElement(),
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
  return { state, workbench, terminalCalls, notices, elements };
}

function registerTerminalInteractionTests(context) {
  const { test, root } = context;

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
