'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixtureElement() {
  return {
    dataset: {},
    value: '',
    textContent: '',
    innerHTML: '',
    isConnected: true,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    addEventListener() {},
    appendChild(child) { child.parentElement = this; return child; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    removeAttribute() {},
    toggleAttribute() {},
    focus() {},
  };
}

function connectionSignature(session) {
  return JSON.stringify([
    session?.id,
    session?.provider,
    session?.externalId,
    session?.environment?.kind,
    session?.environment?.distro,
  ].map(value => String(value || '').trim().toLowerCase()));
}

function createTerminalPreconnectHarness(root, options = {}) {
  const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
  const ensureCalls = [];
  const openCalls = [];
  const selectedSessions = [];
  const mountedHosts = [];
  const retiredTerminals = [];
  const errors = [];
  let initCalls = 0;
  const state = {
    initialized: true,
    sessions: [],
    terminals: new Map(),
    agentConnectionSignatures: new Map(),
    suppressedTmuxTargets: new Set(),
    platform: { id: 'win32' },
    wslDistros: [],
  };
  const window = {
    LoadToAgentI18n: {
      t: key => key,
      errorText: error => String(error?.message || error || ''),
    },
    LoadToAgentRendererUtils: {
      reportRecoverableError: (scope, error) => { errors.push([scope, error]); },
    },
    loadtoagent: {
      terminalCreate: async createOptions => {
        const externalId = String(createOptions.args?.[1] || createOptions.args?.[0] || '');
        const session = options.sessionsByExternalId?.get(externalId)
          || { id: createOptions.bridgeId, externalId, provider: createOptions.provider };
        ensureCalls.push({ session, options: createOptions });
        const created = options.ensureForAgent
          ? await options.ensureForAgent(session, createOptions, ensureCalls.length)
          : { id: `terminal:${session.id}`, terminalId: `terminal:${session.id}`, kind: 'terminal' };
        if (created?.id && !state.sessions.some(item => item.id === created.id)) {
          state.sessions.push({
            ...created,
            id: created.id,
            type: 'agent',
            status: created.status || 'running',
            provider: createOptions.provider,
            bridgeId: createOptions.bridgeId,
            agentResumeSessionId: externalId,
            agentConnectionSignature: createOptions.agentConnectionSignature,
            conversationBound: true,
            backend: 'direct',
          });
        }
        return created;
      },
      terminalRetire: async id => {
        retiredTerminals.push(id);
        state.sessions = state.sessions.filter(session => session.id !== id);
        return { ok: true };
      },
      terminalClose: async () => ({ ok: true }),
      terminalStop: async () => ({ ok: true }),
      terminalCommand: async () => ({ ok: true, deliveryState: 'accepted' }),
    },
  };
  const sandbox = { window, setTimeout, clearTimeout, Uint32Array };
  vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
  const actions = window.LoadToAgentTerminalAgentActions({
    $: () => null,
    state,
    init: async () => { initCalls += 1; },
    notice() {},
    moveWorkbench() {},
    selectTmux: async () => {},
    selectSession: async id => { selectedSessions.push(id); },
    bindAgent() {},
    queueHistoryRefresh() {},
    renderTarget() {},
    fitEntry() {},
    refreshSessions: async () => {},
    resumeSupport: session => ({
      supported: true,
      provider: session.provider,
      sessionId: session.externalId,
      args: ['resume', session.externalId],
    }),
    resumeLaunchArgs: support => [...support.args],
    preferredWorkspace: () => 'D:\\project-a',
    providerLabel: provider => provider,
    terminalTypeLabel: () => 'AI',
    esc: value => String(value ?? ''),
    ensureSessionTerminal: async terminal => {
      mountedHosts.push(terminal?.id || '');
      return { host: fixtureElement(), terminal: { focus() {} } };
    },
  });
  const api = {
    preconnectForAgents: actions.preconnectForAgents,
    openForAgent: async (...args) => {
      openCalls.push(args);
      return actions.openForAgent(...args);
    },
  };
  return {
    api,
    actions,
    state,
    ensureCalls,
    openCalls,
    selectedSessions,
    mountedHosts,
    retiredTerminals,
    errors,
    initCalls: () => initCalls,
  };
}

function createProjectPreconnectHarness(root, sessions) {
  const source = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
  const preconnectCalls = [];
  const mountCalls = [];
  const openCalls = [];
  const focusCalls = [];
  const state = {
    workspace: 'D:\\project-a',
    snapshot: { sessions },
    details: new Map(),
    agentCommandRoutes: new Map(),
    agentCommandTargets: new Map(),
    agentCommandDrafts: new Map(),
    agentCommandSending: new Set(),
    pendingConversationMessages: new Map(),
    conversationInterruptRequests: new Set(),
  };
  const window = {
    LoadToAgentAppFactories: {},
    LoadToAgentI18n: { t: key => key, errorText: (_error, key) => key },
    LoadToAgentRendererUtils: { reportRecoverableError() {} },
    LoadToAgentTerminal: {
      preconnectForAgents: (candidates, options) => {
        preconnectCalls.push({ candidates, options });
        return Promise.resolve([]);
      },
      mountForAgent: (...args) => { mountCalls.push(args); },
      openForAgent: (...args) => { openCalls.push(args); },
      focusEmbedded: (...args) => { focusCalls.push(args); },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    window,
    document: { querySelector: () => null },
    CSS: { escape: value => String(value) },
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    requestAnimationFrame: callback => { callback(); return 1; },
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
    CustomEvent: class CustomEvent {},
  };
  vm.runInNewContext(source, sandbox, { filename: 'app-agent-actions.js' });
  const actions = window.LoadToAgentAppFactories.createAgentActions({
    state,
    isLiveSession: session => session.status === 'running',
    controlRoomRootSessions: () => sessions.filter(session => session.status === 'running'),
    matchesWorkspaceFilter: session => String(session.originCwd || session.cwd || '').toLowerCase()
      .startsWith(String(state.workspace || '').toLowerCase()),
    providerInfo: provider => ({ label: provider }),
    conversationMessageKey: message => message?.id || '',
  });
  return { actions, state, preconnectCalls, mountCalls, openCalls, focusCalls };
}

function registerProjectPtyPreconnectTests(context) {
  const { test, root } = context;

  test('프로젝트 사전 연결은 선택한 프로젝트의 활성 최상위 AI만 background batch에 넘긴다', async () => {
    const rootA = { id: 'codex:root-a', externalId: 'root-a', provider: 'codex', cwd: 'D:\\project-a', status: 'running', parentId: null };
    const rootB = { id: 'claude:root-b', externalId: 'root-b', provider: 'claude', cwd: 'D:\\project-a\\nested', status: 'running', parentId: null };
    const child = { id: 'codex:child', externalId: 'child', provider: 'codex', cwd: 'D:\\project-a', status: 'running', parentId: rootA.id };
    const grandchild = { id: 'codex:grandchild', externalId: 'grandchild', provider: 'codex', cwd: 'D:\\project-a', status: 'running', parentId: child.id };
    const otherRoot = { id: 'codex:other-root', externalId: 'other-root', provider: 'codex', cwd: 'D:\\project-b', status: 'running', parentId: null };
    const completedRoot = { id: 'codex:completed-root', externalId: 'completed-root', provider: 'codex', cwd: 'D:\\project-a', status: 'completed', parentId: null };
    const harness = createProjectPreconnectHarness(root, [rootA, rootB, child, grandchild, otherRoot, completedRoot]);

    await harness.actions.preconnectProjectAgentTerminals(harness.state.workspace);

    assert.equal(harness.preconnectCalls.length, 1);
    assert.deepStrictEqual(
      Array.from(harness.preconnectCalls[0].candidates, session => session.id),
      [rootA.id, rootB.id],
      '하위 AI·다른 프로젝트·종료 기록이 PTY 사전 연결 batch에 포함됐습니다.',
    );
    assert.equal(typeof harness.preconnectCalls[0].options?.shouldStart, 'function');
    assert.equal(harness.preconnectCalls[0].options.shouldStart(), true);
    assert.deepStrictEqual(harness.mountCalls, [], '프로젝트 선택이 xterm mount를 열었습니다.');
    assert.deepStrictEqual(harness.openCalls, [], '프로젝트 선택이 PTY 화면을 열었습니다.');
    assert.deepStrictEqual(harness.focusCalls, [], '프로젝트 선택이 PTY 포커스를 가져갔습니다.');

    harness.state.workspace = 'D:\\project-b';
    assert.equal(harness.preconnectCalls[0].options.shouldStart(), false,
      '다른 프로젝트로 이동한 뒤 이전 batch가 새 PTY 시작 권한을 유지했습니다.');
  });

  test('PTY 사전 연결은 같은 canonical identity를 합치고 identity 변경은 별도 요청으로 시작한다', async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const harness = createTerminalPreconnectHarness(root, {
      ensureForAgent: (_session, _options, callCount) => {
        if (callCount === 1) {
          firstStarted.resolve();
          return firstGate.promise;
        }
        secondStarted.resolve();
        return secondGate.promise;
      },
    });
    const firstIdentity = { id: 'codex:preconnect-dedupe', externalId: 'history-a', provider: 'codex', cwd: 'D:\\project-a' };
    const sameIdentity = { ...firstIdentity };
    const secondIdentity = { ...firstIdentity, externalId: 'history-b' };

    const first = harness.api.preconnectForAgents([firstIdentity, sameIdentity], { shouldStart: () => true });
    const repeated = harness.api.preconnectForAgents([sameIdentity], { shouldStart: () => true });
    await firstStarted.promise;
    assert.equal(harness.ensureCalls.length, 1,
      `같은 batch·반복 호출이 동일 identity ensure를 중복 시작했습니다: ${harness.ensureCalls.length}`);

    const superseding = harness.api.preconnectForAgents([secondIdentity], { shouldStart: () => true });
    await Promise.resolve();
    assert.equal(harness.ensureCalls.length, 1,
      '새 identity가 이전 PTY 정리를 기다리지 않고 동시에 provider resume을 시작했습니다.');

    firstGate.resolve({ id: 'terminal:history-a', terminalId: 'terminal:history-a', status: 'running' });
    await Promise.all([first, repeated]);
    await secondStarted.promise;
    assert.equal(harness.ensureCalls.length, 2, '이전 identity 정리 뒤 새 canonical identity ensure가 시작되지 않았습니다.');
    assert.deepStrictEqual(Array.from(harness.ensureCalls, call => call.session.externalId), ['history-a', 'history-b']);
    assert.deepStrictEqual(harness.retiredTerminals, ['terminal:history-a'],
      'superseded identity의 사전 연결 PTY를 정리하지 않았습니다.');
    const repeatedNewIdentity = harness.api.preconnectForAgents([{ ...secondIdentity }], { shouldStart: () => true });
    await Promise.resolve();
    assert.equal(harness.ensureCalls.length, 2,
      '이전 identity 완료가 최신 identity pending dedupe를 지웠습니다.');
    secondGate.resolve({ id: 'terminal:history-b', terminalId: 'terminal:history-b', status: 'running' });
    await Promise.all([superseding, repeatedNewIdentity]);
  });

  test('하위 AI의 public PTY API는 조회·열기·재개·ensure·reset을 생성 전에 모두 거부한다', async () => {
    const harness = createTerminalPreconnectHarness(root);
    const child = {
      id: 'codex:parent-controlled-child',
      externalId: 'parent-controlled-child',
      provider: 'codex',
      cwd: 'D:\\project-a',
      parentId: 'codex:parent',
    };

    assert.deepStrictEqual(Array.from(harness.actions.agentTargets(child)), []);
    for (const operation of [
      () => harness.actions.openForAgent(child),
      () => harness.actions.resumeForAgent(child),
      () => harness.actions.ensureForAgent(child),
      () => harness.actions.resetForAgent(child),
    ]) {
      await assert.rejects(operation, error => (
        error?.deliveryState === 'rejected'
        && error?.message === 'terminal.resume.parent_controlled'
      ));
    }

    assert.equal(harness.initCalls(), 0, '하위 AI 거절 전에 terminal init을 시작했습니다.');
    assert.deepStrictEqual(harness.ensureCalls, [], '하위 AI를 위해 terminalCreate를 호출했습니다.');
    assert.deepStrictEqual(harness.selectedSessions, [], '하위 AI PTY를 화면에서 선택했습니다.');
    assert.deepStrictEqual(harness.mountedHosts, [], '하위 AI의 hidden xterm host를 만들었습니다.');
  });

  test('한 AI의 사전 연결 실패는 다른 AI를 막지 않고 화면 mount·open·focus를 수행하지 않는다', async () => {
    const harness = createTerminalPreconnectHarness(root, {
      ensureForAgent: async session => {
        if (session.id === 'codex:preconnect-failed') throw new Error('fixture preconnect failure');
        return { id: `terminal:${session.id}`, terminalId: `terminal:${session.id}` };
      },
    });
    const failed = { id: 'codex:preconnect-failed', externalId: 'failed', provider: 'codex', cwd: 'D:\\project-a' };
    const connected = { id: 'claude:preconnect-connected', externalId: 'connected', provider: 'claude', cwd: 'D:\\project-a' };

    await assert.doesNotReject(() => harness.api.preconnectForAgents([failed, connected], { shouldStart: () => true }));

    assert.deepStrictEqual(Array.from(harness.ensureCalls, call => call.session.id), [failed.id, connected.id],
      '첫 연결 실패 때문에 다음 최상위 AI ensure가 실행되지 않았습니다.');
    assert.deepStrictEqual(harness.openCalls, [], '사전 연결이 PTY 화면을 열었습니다.');
    assert.deepStrictEqual(harness.selectedSessions, [], '사전 연결이 터미널 화면을 선택했습니다.');
    assert.deepStrictEqual(harness.mountedHosts, [`terminal:${connected.id}`],
      '연결에 성공한 최상위 AI의 숨은 xterm host를 미리 준비하지 않았습니다.');
  });
}

module.exports = { registerProjectPtyPreconnectTests };
