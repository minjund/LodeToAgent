'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function classList() {
  const values = new Set();
  return {
    contains: value => values.has(value),
    toggle(value, force) {
      const enabled = force == null ? !values.has(value) : Boolean(force);
      if (enabled) values.add(value);
      else values.delete(value);
      return enabled;
    },
  };
}

function createInlineHarness(root, options = {}) {
  const session = options.session || {
    id: 'codex:inline-auto-connect',
    externalId: 'inline-auto-connect-history',
    provider: 'codex',
    cwd: 'D:\\fixture',
    parentId: null,
  };
  const mountCalls = [];
  const resumeCalls = [];
  const focusCalls = [];
  const unmountCalls = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const terminalStateListeners = [];
  const resumeAttributes = new Map();
  const resume = {
    classList: classList(),
    disabled: false,
    getAttribute: name => resumeAttributes.get(name) || null,
    setAttribute(name, value) { resumeAttributes.set(name, String(value)); },
    removeAttribute(name) { resumeAttributes.delete(name); },
    closest(selector) { return selector === '[data-inline-terminal-resume]' ? this : null; },
  };
  const empty = {
    classList: classList(),
    querySelector(selector) {
      if (selector === 'b' || selector === 'small') return { textContent: '' };
      if (selector === '[data-inline-terminal-resume]') return resume;
      return null;
    },
  };
  const viewport = {
    id: 'agentInlineTerminalViewport',
    children: [],
    isConnected: true,
    appendChild(node) {
      this.children = this.children.filter(child => child !== node);
      this.children.push(node);
      node.parentElement = this;
      return node;
    },
  };
  const status = { textContent: '' };
  const meta = { textContent: '' };
  const shell = {
    dataset: { inlineAgentTerminal: session.id },
    querySelector(selector) {
      if (selector === '#agentInlineTerminalViewport') return viewport;
      if (selector === '[data-inline-terminal-empty]') return empty;
      if (selector === '[data-inline-terminal-resume]') return resume;
      if (selector === '[data-inline-terminal-status]') return status;
      if (selector === '[data-inline-terminal-meta]') return meta;
      return null;
    },
  };
  let activeSession = session;
  let activeShell = shell;
  let activeViewport = viewport;
  const app = {
    state: {
      inlineTerminalSessionId: options.initialOpen === false ? null : session.id,
      graphFocusId: null,
      details: new Map(),
      snapshot: { sessions: [session] },
    },
    snapshotSession: id => id === activeSession.id ? activeSession : null,
    renderSessions() {},
  };
  const body = { closest: () => null };
  const documentElement = { closest: () => null };
  const document = {
    activeElement: body,
    body,
    documentElement,
    visibilityState: 'visible',
    hasFocus: () => true,
    querySelector: selector => selector === '[data-inline-agent-terminal]' ? activeShell : null,
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
  };
  let embedded = { connected: false, agentSessionId: '', terminalId: '' };
  let connectedTarget = null;
  const connectResult = (result, mountedSession = activeSession, mount = activeViewport) => {
    if (!result?.ok || !result.target) return;
    connectedTarget = result.target;
    const terminalId = String(result.target.terminalId || result.target.id || '');
    embedded = { connected: true, agentSessionId: mountedSession.id, terminalId };
    mount.appendChild({ dataset: { terminalScreen: terminalId }, parentElement: mount });
  };
  const terminal = {
    agentConnectionSignature: mountedSession => options.agentConnectionSignature?.(mountedSession)
      || JSON.stringify([
        mountedSession?.id,
        mountedSession?.externalId,
        mountedSession?.provider,
        mountedSession?.environment?.kind,
        mountedSession?.environment?.distro,
      ]),
    agentTargets: mountedSession => options.agentTargets
      ? options.agentTargets(mountedSession, connectedTarget)
      : connectedTarget ? [connectedTarget] : [],
    embeddedState: () => ({ ...embedded }),
    focusEmbedded: () => {
      focusCalls.push(session.id);
      return true;
    },
    mountForAgent: async (mountedSession, mountOptions) => {
      mountCalls.push({ session: mountedSession, options: { ...mountOptions } });
      const result = await options.mountForAgent(mountedSession, mountOptions, mountCalls.length);
      if (options.autoConnectResults !== false) connectResult(result, mountedSession, mountOptions.mount);
      return result;
    },
    resumeForAgent: async (...args) => {
      resumeCalls.push(args);
      return options.resumeForAgent(...args, resumeCalls.length);
    },
    resumeSupport: () => ({ supported: false, reason: 'not resumable in fixture' }),
    unmountEmbedded: () => {
      unmountCalls.push(embedded.terminalId);
      embedded = { connected: false, agentSessionId: '', terminalId: '' };
      viewport.children = [];
    },
  };
  const window = {
    LoadToAgentApp: app,
    LoadToAgentTerminal: terminal,
    LoadToAgentI18n: {
      t: key => key,
      errorText: (_error, fallback) => fallback,
    },
    LoadToAgentRendererUtils: { reportRecoverableError() {} },
    loadtoagent: {
      onTerminalState(listener) { terminalStateListeners.push(listener); },
    },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
  };
  const sandbox = {
    window,
    document,
    CustomEvent: class CustomEvent {},
    requestAnimationFrame: callback => { callback(); return 1; },
    queueMicrotask: callback => Promise.resolve().then(callback),
    setTimeout,
  };
  const source = fs.readFileSync(path.join(root, 'renderer', 'inline-agent-terminal.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'inline-agent-terminal.js' });
  return {
    app,
    document,
    focusCalls,
    mountCalls,
    resumeCalls,
    resumeButton: resume,
    inlineViewport: viewport,
    unmountCalls,
    session,
    dispatchDocument(type, event = {}) {
      for (const listener of documentListeners.get(type) || []) listener(event);
    },
    dispatchWindow(type, event = {}) {
      for (const listener of windowListeners.get(type) || []) listener(event);
    },
    dispatchTerminalState(payload) {
      for (const listener of terminalStateListeners) listener(payload);
    },
    setEmbedded(next) {
      embedded = { connected: false, agentSessionId: '', terminalId: '', ...next };
      activeViewport.children = embedded.connected && embedded.terminalId
        ? [{ dataset: { terminalScreen: embedded.terminalId }, parentElement: activeViewport }]
        : [];
    },
    moveEmbeddedHostToDrawer() {
      const host = activeViewport.children.find(child => (
        String(child?.dataset?.terminalScreen || '') === String(embedded.terminalId || '')
      ));
      const drawerViewport = { id: 'drawerTerminalViewport', children: [] };
      if (host) {
        activeViewport.children = activeViewport.children.filter(child => child !== host);
        drawerViewport.children.push(host);
        host.parentElement = drawerViewport;
      }
      return drawerViewport;
    },
    switchSession(nextSession) {
      const nextViewport = {
        id: 'agentInlineTerminalViewport',
        children: [],
        isConnected: true,
        appendChild(node) {
          this.children = this.children.filter(child => child !== node);
          this.children.push(node);
          node.parentElement = this;
          return node;
        },
      };
      const nextEmpty = {
        classList: classList(),
        querySelector(selector) {
          if (selector === 'b' || selector === 'small') return { textContent: '' };
          if (selector === '[data-inline-terminal-resume]') return null;
          return null;
        },
      };
      activeSession = nextSession;
      activeViewport = nextViewport;
      activeShell = {
        dataset: { inlineAgentTerminal: nextSession.id },
        querySelector(selector) {
          if (selector === '#agentInlineTerminalViewport') return nextViewport;
          if (selector === '[data-inline-terminal-empty]') return nextEmpty;
          if (selector === '[data-inline-terminal-status]' || selector === '[data-inline-terminal-meta]') return { textContent: '' };
          return null;
        },
      };
      app.state.inlineTerminalSessionId = nextSession.id;
      app.state.snapshot.sessions = [nextSession];
      return activeShell;
    },
    sync: (...args) => window.LoadToAgentInlineTerminal.sync(...args),
    close: (...args) => window.LoadToAgentInlineTerminal.close(...args),
    toggle: (...args) => window.LoadToAgentInlineTerminal.toggle(...args),
  };
}

function registerInlineAgentTerminalTests(context) {
  const { test, root } = context;

  test('인라인 PTY 자동 연결은 동시·반복 sync에도 한 번만 생성한다', async () => {
    let releaseMount;
    const harness = createInlineHarness(root, {
      mountForAgent: () => new Promise(resolve => { releaseMount = resolve; }),
    });

    const first = harness.sync();
    const second = harness.sync();
    await Promise.resolve();
    assert.equal(harness.mountCalls.length, 1, '동시 sync가 mountForAgent를 중복 호출했습니다.');
    assert.equal(harness.mountCalls[0].options.createIfMissing, true);

    releaseMount({
      ok: true,
      target: { id: 'terminal:inline-auto-connect', terminalId: 'terminal:inline-auto-connect', kind: 'terminal' },
    });
    await Promise.all([first, second]);
    const repeated = await harness.sync();

    assert.equal(repeated.ok, true);
    assert.equal(repeated.reused, true);
    assert.equal(harness.mountCalls.length, 1, '연결된 PTY의 snapshot sync가 새 mount를 시작했습니다.');
  });

  test('인라인 PTY 자동 연결 실패는 같은 펼침에서 반복하지 않고 재펼침에서만 재시도한다', async () => {
    const harness = createInlineHarness(root, {
      mountForAgent: async () => ({ ok: false, reason: 'mount-failed' }),
    });

    await harness.sync();
    await harness.sync();
    assert.equal(harness.mountCalls.length, 1);
    assert.deepStrictEqual(
      harness.mountCalls.map(call => call.options.createIfMissing),
      [true],
      '실패한 같은 펼침의 snapshot sync가 PTY mount 또는 자동 생성을 다시 시도했습니다.',
    );

    assert.equal(harness.close({ render: false }), true);
    harness.toggle(harness.session.id, { focus: false });
    await harness.sync();
    assert.equal(harness.app.state.inlineTerminalSessionId, harness.session.id);
    assert.equal(harness.mountCalls.length, 2);
    assert.equal(harness.mountCalls[1].options.createIfMissing, true,
      '사용자가 PTY를 닫았다 재펼쳤도 자동 연결 실패 캐시가 초기화되지 않았습니다.');
  });

  test('부모가 관리하는 하위 AI는 PTY를 자동 생성하거나 snapshot마다 no-target을 재시도하지 않는다', async () => {
    let signedTarget = null;
    const harness = createInlineHarness(root, {
      session: {
        id: 'codex:inline-parent-controlled',
        externalId: 'inline-parent-controlled-history',
        provider: 'codex',
        cwd: 'D:\\fixture',
        parentId: 'codex:parent',
      },
      agentTargets: () => signedTarget ? [signedTarget] : [],
      mountForAgent: async (_session, _mountOptions, callCount) => callCount === 1
        ? { ok: false, reason: 'no-target' }
        : { ok: true, target: signedTarget },
    });

    await harness.sync();
    await harness.sync();
    await harness.sync();
    assert.equal(harness.mountCalls.length, 1);
    assert.equal(harness.mountCalls[0].options.createIfMissing, false);

    signedTarget = {
      id: 'terminal:inline-parent-signed',
      terminalId: 'terminal:inline-parent-signed',
      kind: 'terminal',
    };
    const connected = await harness.sync();
    assert.equal(connected.ok, true);
    assert.equal(harness.mountCalls.length, 2,
      'signed target이 나타났는데 하위 AI의 펼침 실패 캐시가 연결 재시도를 막았습니다.');
    assert.deepStrictEqual(harness.mountCalls.map(call => call.options.createIfMissing), [false, false]);
  });

  test('세션 연결 서명이 바뀌면 연결된 오래된 PTY를 재사용하지 않는다', async () => {
    let inventoryVisible = true;
    const harness = createInlineHarness(root, {
      agentTargets: (_session, target) => inventoryVisible && target ? [target] : [],
      mountForAgent: async (_session, _mountOptions, callCount) => callCount === 1
        ? {
          ok: true,
          target: { id: 'terminal:inline-old-provider', terminalId: 'terminal:inline-old-provider', kind: 'terminal' },
        }
        : { ok: false, reason: 'no-target' },
    });

    const initial = await harness.sync();
    assert.equal(initial.ok, true);
    harness.session.externalId = 'inline-new-provider-history';
    inventoryVisible = false;
    const afterIdentityChange = await harness.sync();

    assert.equal(afterIdentityChange.ok, false);
    assert.equal(afterIdentityChange.reused, undefined);
    assert.equal(harness.mountCalls.length, 2,
      '세션 연결 서명이 바뀌었는데 이전 provider PTY를 fast-path로 재사용했습니다.');
  });

  test('연결을 기다리는 동안 다른 조작이 있으면 완료 후 PTY가 포커스를 빼앗지 않는다', async () => {
    let releaseMount;
    const harness = createInlineHarness(root, {
      initialOpen: false,
      mountForAgent: () => new Promise(resolve => { releaseMount = resolve; }),
    });

    harness.toggle(harness.session.id, { focus: false });
    const pending = harness.sync();
    await Promise.resolve();
    const otherControl = { closest: () => null };
    harness.document.activeElement = otherControl;
    harness.dispatchDocument('pointerdown', { target: otherControl });
    releaseMount({
      ok: true,
      target: { id: 'terminal:inline-delayed', terminalId: 'terminal:inline-delayed', kind: 'terminal' },
    });
    await pending;

    assert.equal(harness.focusCalls.length, 0,
      '사용자가 다른 컨트롤로 이동한 뒤 늦게 연결된 PTY가 포커스를 빼앗았습니다.');
  });

  test('느린 자동 연결 중 세션 서명이 바뀌면 새 서명 mount를 즉시 시작한다', async () => {
    let releaseFirstMount;
    const observedExternalIds = [];
    const harness = createInlineHarness(root, {
      mountForAgent: (mountedSession, _mountOptions, callCount) => {
        observedExternalIds.push(mountedSession.externalId);
        return callCount === 1
          ? new Promise(resolve => { releaseFirstMount = resolve; })
          : Promise.resolve({
            ok: true,
            target: { id: 'terminal:inline-new-provider', terminalId: 'terminal:inline-new-provider', kind: 'terminal' },
          });
      },
    });

    const first = harness.sync();
    await Promise.resolve();
    harness.session.externalId = 'inline-replaced-while-connecting';
    const superseding = harness.sync();
    await Promise.resolve();

    assert.equal(harness.mountCalls.length, 2,
      '새 canonical identity가 이전 mount promise에 합쳐져 lower terminal supersession을 시작하지 못했습니다.');
    assert.deepStrictEqual(observedExternalIds, [
      'inline-auto-connect-history',
      'inline-replaced-while-connecting',
    ]);

    releaseFirstMount({
      ok: true,
      target: { id: 'terminal:inline-old-provider', terminalId: 'terminal:inline-old-provider', kind: 'terminal' },
    });
    const [firstResult, supersedingResult] = await Promise.all([first, superseding]);

    assert.equal(firstResult.reason, 'cancelled');
    assert.equal(supersedingResult.ok, true);
    assert.equal(supersedingResult.target.terminalId, 'terminal:inline-new-provider');
  });

  test('stale identity 정리는 같은 결과 target만 unmount하고 더 새로운 PTY는 보존한다', async () => {
    async function staleCompletion(activeTerminalId) {
      let releaseFirstMount;
      const harness = createInlineHarness(root, {
        autoConnectResults: false,
        mountForAgent: (_session, _mountOptions, callCount) => callCount === 1
          ? new Promise(resolve => { releaseFirstMount = resolve; })
          : Promise.resolve({ ok: false, reason: 'no-target' }),
      });
      const pending = harness.sync();
      await Promise.resolve();
      harness.session.externalId = 'inline-replaced-before-completion';
      harness.setEmbedded({
        connected: true,
        agentSessionId: harness.session.id,
        terminalId: activeTerminalId,
      });
      releaseFirstMount({
        ok: true,
        target: { id: 'terminal:inline-old-provider', terminalId: 'terminal:inline-old-provider', kind: 'terminal' },
      });
      const result = await pending;
      await new Promise(resolve => setTimeout(resolve, 5));
      return { harness, result };
    }

    const newer = await staleCompletion('terminal:inline-new-provider');
    assert.equal(newer.result.reason, 'stale-identity');
    assert.deepStrictEqual(newer.harness.unmountCalls, [],
      '오래된 mount 완료가 같은 session의 더 새로운 embedded PTY를 unmount했습니다.');

    const stale = await staleCompletion('terminal:inline-old-provider');
    assert.equal(stale.result.reason, 'stale-identity');
    assert.deepStrictEqual(stale.harness.unmountCalls, ['terminal:inline-old-provider'],
      'stale mount 결과와 정확히 같은 embedded PTY를 정리하지 않았습니다.');
  });

  test('창 blur·숨김·document focus 상실은 늦은 PTY focus를 취소한다', async () => {
    async function delayedFocus(cancelFocus) {
      let releaseMount;
      const harness = createInlineHarness(root, {
        initialOpen: false,
        mountForAgent: () => new Promise(resolve => { releaseMount = resolve; }),
      });
      harness.toggle(harness.session.id, { focus: false });
      const pending = harness.sync();
      await Promise.resolve();
      await cancelFocus(harness);
      releaseMount({
        ok: true,
        target: { id: 'terminal:inline-delayed', terminalId: 'terminal:inline-delayed', kind: 'terminal' },
      });
      await pending;
      return harness.focusCalls.length;
    }

    assert.equal(await delayedFocus(async harness => {
      harness.document.hasFocus = () => false;
      harness.dispatchWindow('blur');
      await Promise.resolve();
    }), 0,
      '앱 창 blur 뒤 늦게 연결된 PTY가 포커스를 가져갔습니다.');
    assert.equal(await delayedFocus(harness => {
      harness.document.visibilityState = 'hidden';
      harness.dispatchDocument('visibilitychange');
    }), 0, '문서가 숨겨진 뒤 늦게 연결된 PTY가 포커스를 가져갔습니다.');
    assert.equal(await delayedFocus(harness => {
      harness.document.hasFocus = () => false;
    }), 0, 'document.hasFocus()가 false인데 늦게 연결된 PTY가 포커스를 가져갔습니다.');
  });

  test('긴 resume 중 사용자 조작은 완료 뒤 PTY focus를 취소한다', async () => {
    let releaseResume;
    const harness = createInlineHarness(root, {
      resumeForAgent: () => new Promise(resolve => { releaseResume = resolve; }),
      mountForAgent: async () => ({
        ok: true,
        target: { id: 'terminal:inline-resumed', terminalId: 'terminal:inline-resumed', kind: 'terminal' },
      }),
    });

    harness.dispatchDocument('pointerdown', { target: harness.resumeButton });
    harness.dispatchDocument('click', { target: harness.resumeButton, stopPropagation() {} });
    assert.equal(harness.resumeCalls.length, 1);

    const otherControl = { closest: () => null };
    harness.document.activeElement = otherControl;
    harness.dispatchDocument('pointerdown', { target: otherControl });
    releaseResume({ id: 'terminal:inline-resumed', terminalId: 'terminal:inline-resumed' });
    await new Promise(resolve => setTimeout(resolve, 5));

    assert.equal(harness.mountCalls.length, 1, '현재 resume 결과를 inline PTY에 mount하지 않았습니다.');
    assert.equal(harness.focusCalls.length, 0,
      'resume await 중 사용자 조작을 완료 뒤 새 focus intent로 덮어써 PTY가 포커스를 빼앗았습니다.');
  });

  test('A resume 완료는 이미 전환한 B inline PTY를 force sync하지 않는다', async () => {
    let releaseResume;
    const harness = createInlineHarness(root, {
      resumeForAgent: () => new Promise(resolve => { releaseResume = resolve; }),
      mountForAgent: async () => ({
        ok: true,
        target: { id: 'terminal:unexpected-b-sync', terminalId: 'terminal:unexpected-b-sync', kind: 'terminal' },
      }),
    });

    harness.dispatchDocument('pointerdown', { target: harness.resumeButton });
    harness.dispatchDocument('click', { target: harness.resumeButton, stopPropagation() {} });
    assert.equal(harness.resumeCalls.length, 1);
    harness.switchSession({
      id: 'codex:inline-session-b',
      externalId: 'inline-session-b-history',
      provider: 'codex',
      cwd: 'D:\\fixture-b',
      parentId: null,
    });

    releaseResume({ id: 'terminal:inline-session-a', terminalId: 'terminal:inline-session-a' });
    await new Promise(resolve => setTimeout(resolve, 5));

    assert.equal(harness.mountCalls.length, 0,
      'A의 늦은 resume 완료가 현재 선택된 B session에 force sync를 실행했습니다.');
    assert.equal(harness.focusCalls.length, 0);

    let releaseOldIdentityResume;
    const sameIdHarness = createInlineHarness(root, {
      resumeForAgent: () => new Promise(resolve => { releaseOldIdentityResume = resolve; }),
      mountForAgent: async () => ({
        ok: true,
        target: { id: 'terminal:inline-new-identity', terminalId: 'terminal:inline-new-identity', kind: 'terminal' },
      }),
    });
    sameIdHarness.dispatchDocument('pointerdown', { target: sameIdHarness.resumeButton });
    sameIdHarness.dispatchDocument('click', { target: sameIdHarness.resumeButton, stopPropagation() {} });
    sameIdHarness.session.externalId = 'inline-new-canonical-identity';
    sameIdHarness.setEmbedded({
      connected: true,
      agentSessionId: sameIdHarness.session.id,
      terminalId: 'terminal:inline-new-identity',
    });
    sameIdHarness.dispatchWindow('loadtoagent:terminal-reconnect-focus', {
      detail: { terminalId: 'terminal:inline-new-identity' },
    });
    releaseOldIdentityResume({ id: 'terminal:inline-old-identity', terminalId: 'terminal:inline-old-identity' });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sameIdHarness.mountCalls.length, 0);

    sameIdHarness.setEmbedded({ connected: false, agentSessionId: '', terminalId: '' });
    await sameIdHarness.sync({ force: true });
    assert.equal(sameIdHarness.focusCalls.length, 1,
      '오래된 same-id resume 완료가 더 새로운 canonical identity의 focus intent를 지웠습니다.');
  });

  test('reconnect focus intent는 현재 embedded PTY에만 적용되고 후속 조작으로 취소된다', async () => {
    async function reconnectFocus(eventTerminalId, blurHasFocus = null) {
      const harness = createInlineHarness(root, {
        mountForAgent: async () => ({
          ok: true,
          target: { id: 'terminal:inline-reconnected', terminalId: 'terminal:inline-reconnected', kind: 'terminal' },
        }),
      });
      harness.setEmbedded({
        connected: true,
        agentSessionId: harness.session.id,
        terminalId: 'terminal:inline-before-reconnect',
      });
      harness.dispatchWindow('loadtoagent:terminal-reconnect-focus', {
        detail: { terminalId: eventTerminalId },
      });
      harness.setEmbedded({ connected: false, agentSessionId: '', terminalId: '' });
      harness.dispatchDocument('focusin', { target: harness.document.body });
      if (blurHasFocus !== null) {
        harness.document.hasFocus = () => blurHasFocus;
        harness.dispatchWindow('blur');
        await Promise.resolve();
      }
      await harness.sync({ force: true });
      return harness.focusCalls.length;
    }

    assert.equal(await reconnectFocus('terminal:inline-before-reconnect'), 1,
      '현재 focused embedded PTY의 reconnect 뒤 focus가 복원되지 않았습니다.');
    assert.equal(await reconnectFocus('terminal:unrelated'), 0,
      '다른 terminal reconnect 이벤트가 inline PTY focus intent를 만들었습니다.');
    assert.equal(await reconnectFocus('terminal:inline-before-reconnect', true), 1,
      'xterm host detach의 synthetic blur가 reconnect focus intent를 취소했습니다.');
    assert.equal(await reconnectFocus('terminal:inline-before-reconnect', false), 0,
      '실제 창 blur 뒤 reconnect된 PTY가 포커스를 가져갔습니다.');
  });

  test('reconnect remount는 이벤트 직전 inline viewport가 소유한 PTY에만 실행한다', async () => {
    async function reconnectResult(mountId) {
      const harness = createInlineHarness(root, {
        mountForAgent: async () => ({
          ok: true,
          target: { id: 'terminal:inline-owner', terminalId: 'terminal:inline-owner', kind: 'terminal' },
        }),
      });
      harness.setEmbedded({
        connected: true,
        agentSessionId: harness.session.id,
        terminalId: 'terminal:inline-owner',
      });
      if (mountId === 'drawerTerminalViewport') harness.moveEmbeddedHostToDrawer();
      harness.dispatchWindow('loadtoagent:terminal-reconnect-focus', {
        detail: { terminalId: 'terminal:inline-owner' },
      });
      harness.dispatchWindow('loadtoagent:terminal-reconnect-owner', {
        detail: { terminalId: 'terminal:inline-owner', mountId },
      });
      let passiveResult = null;
      let forceResult = null;
      let mountCountBeforeReopen = 0;
      let focusCountBeforeReopen = 0;
      let reopenResult = null;
      if (mountId === 'agentInlineTerminalViewport') {
        harness.setEmbedded({
          connected: false,
          agentSessionId: harness.session.id,
          terminalId: 'terminal:inline-owner',
        });
      } else {
        // The drawer disposes the old xterm before its replacement is ready.
        // Preserve the last exact identity so neither a passive snapshot nor
        // the reconnect force path can steal the disconnected ownership gap.
        harness.setEmbedded({
          connected: false,
          agentSessionId: harness.session.id,
          terminalId: 'terminal:inline-owner',
        });
        passiveResult = await harness.sync();
        forceResult = await harness.sync({ force: true });
        mountCountBeforeReopen = harness.mountCalls.length;
        focusCountBeforeReopen = harness.focusCalls.length;
      }
      harness.dispatchTerminalState({
        change: 'reconnected',
        sessions: [{ id: 'terminal:inline-owner', status: 'running' }],
      });
      await new Promise(resolve => setTimeout(resolve, 5));
      if (mountId === 'drawerTerminalViewport') {
        assert.equal(harness.mountCalls.length, mountCountBeforeReopen,
          'drawer reconnect listener가 disposal gap의 PTY를 inline에 remount했습니다.');
        harness.close({ render: false });
        harness.toggle(harness.session.id, { focus: false });
        reopenResult = await harness.sync();
      }
      return {
        focusCount: harness.focusCalls.length,
        mountCount: harness.mountCalls.length,
        mountCountBeforeReopen,
        focusCountBeforeReopen,
        passiveReason: passiveResult?.reason || '',
        forceReason: forceResult?.reason || '',
        reopenOk: Boolean(reopenResult?.ok),
      };
    }

    const inlineOwner = await reconnectResult('agentInlineTerminalViewport');
    assert.equal(inlineOwner.mountCount, 1,
      'inline viewport가 소유하던 PTY를 host reconnect 뒤 자동 remount하지 않았습니다.');
    const drawerOwner = await reconnectResult('drawerTerminalViewport');
    assert.equal(drawerOwner.passiveReason, 'owned-elsewhere');
    assert.equal(drawerOwner.forceReason, 'owned-elsewhere');
    assert.equal(drawerOwner.mountCountBeforeReopen, 0,
      'drawer가 소유하던 disposal gap PTY를 inline sync가 가로채 remount했습니다.');
    assert.equal(drawerOwner.reopenOk, true,
      'drawer 종료 뒤 명시적으로 다시 펼친 inline PTY가 연결되지 않았습니다.');
    assert.equal(drawerOwner.mountCount, 1,
      'drawer 종료 뒤 명시적 inline 재펼침이 정확히 한 번 mount하지 않았습니다.');
    assert.equal(drawerOwner.focusCount, 1,
      'drawer 종료 뒤 명시적으로 다시 펼친 inline PTY에 focus가 복원되지 않았습니다.');
    assert.equal(drawerOwner.focusCountBeforeReopen, 0,
      'drawer가 소유하던 embedded PTY에 inline reconnect focus가 적용됐습니다.');
  });
}

module.exports = { registerInlineAgentTerminalTests };
