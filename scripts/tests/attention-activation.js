'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  AttentionActivationCoordinator,
} = require('../../src/attentionActivationCoordinator');
const {
  createAttentionActivationController,
} = require('../../renderer/attention-activation');

const flush = () => new Promise(resolve => setImmediate(resolve));

function activation(id, overrides = {}) {
  return {
    activationId: id,
    source: 'hook',
    provider: 'codex',
    sessionId: 'codex:session-1',
    rawSessionId: 'session-1',
    event: 'attention',
    deliveryToken: `delivery-${id}`,
    ...overrides,
  };
}

function registerAttentionActivationTests(context) {
  const { test } = context;

  test('알람 자동 이동은 설정을 따르고 처리된 요청을 renderer reload 뒤 다시 열지 않는다', () => {
    const shown = [];
    const delivered = [];
    const tokens = new Map();
    const coordinator = new AttentionActivationCoordinator({
      enabled: false,
      onShow: item => shown.push(item.activationId),
      onDeliver: item => { delivered.push(item.activationId); tokens.set(item.activationId, item.deliveryToken); return true; },
    });
    coordinator.rendererReady();
    coordinator.reconcile([activation('a')]);
    assert.deepEqual(shown, []);
    assert.deepEqual(delivered, []);

    coordinator.setEnabled(true);
    assert.deepEqual(shown, ['a']);
    assert.deepEqual(delivered, ['a']);
    assert.deepEqual(coordinator.acknowledge({ activationId: 'a', deliveryToken: tokens.get('a'), status: 'opened-pty' }), {
      ok: true, acknowledged: true, activationId: 'a', status: 'opened-pty',
    });
    coordinator.rendererUnavailable();
    coordinator.rendererReady();
    assert.deepEqual(delivered, ['a']);
    coordinator.dispose();
  });

  test('같은 논리 요청의 source 공백은 창 focus를 반복하지 않고 미처리 delivery만 복구한다', () => {
    const shown = [];
    const delivered = [];
    const cancelled = [];
    const tokens = new Map();
    const coordinator = new AttentionActivationCoordinator({
      enabled: true,
      tombstoneMs: 60_000,
      onShow: item => shown.push(item.activationId),
      onDeliver: item => { delivered.push(item.activationId); tokens.set(item.activationId, item.deliveryToken); return true; },
      onCancel: item => { cancelled.push(`${item.activationId}:${item.reason}`); return true; },
    });
    coordinator.rendererReady();
    coordinator.reconcile([activation('same')]);
    coordinator.reconcile([]);
    coordinator.reconcile([activation('same', { source: 'snapshot' })]);
    assert.deepEqual(shown, ['same']);
    assert.deepEqual(delivered, ['same', 'same']);
    assert.deepEqual(cancelled, ['same:resolved']);
    coordinator.acknowledge({ activationId: 'same', deliveryToken: tokens.get('same'), status: 'opened-session' });
    coordinator.reconcile([]);
    coordinator.reconcile([activation('same')]);
    assert.deepEqual(shown, ['same']);
    assert.deepEqual(delivered, ['same', 'same']);
    coordinator.dispose();
  });

  test('최신 알람이 해결되면 남아 있는 이전 미처리 알람을 다시 전달한다', () => {
    const delivered = [];
    const tokens = new Map();
    const coordinator = new AttentionActivationCoordinator({
      enabled: true,
      onShow: () => {},
      onDeliver: item => { delivered.push(item.activationId); tokens.set(item.activationId, item.deliveryToken); return true; },
    });
    coordinator.rendererReady();
    coordinator.reconcile([activation('older')]);
    coordinator.reconcile([activation('older'), activation('newer')]);
    assert.deepEqual(delivered, ['older', 'newer']);
    coordinator.acknowledge({ activationId: 'newer', deliveryToken: tokens.get('newer'), status: 'opened-pty' });
    assert.deepEqual(delivered, ['older', 'newer', 'older']);
    coordinator.acknowledge({ activationId: 'older', deliveryToken: tokens.get('older'), status: 'opened-session' });
    assert.equal(coordinator.snapshot().phases.handled, 2);
    coordinator.dispose();
  });

  test('renderer reload 전 delivery ACK는 새 delivery를 처리 완료시키지 못한다', () => {
    const deliveries = [];
    const coordinator = new AttentionActivationCoordinator({
      enabled: true,
      onShow: () => {},
      onDeliver: item => { deliveries.push(item); return true; },
    });
    coordinator.rendererReady();
    coordinator.reconcile([activation('reload')]);
    const oldToken = deliveries.at(-1).deliveryToken;
    coordinator.rendererUnavailable();
    coordinator.rendererReady();
    const newToken = deliveries.at(-1).deliveryToken;
    assert.notEqual(oldToken, newToken);
    assert.deepEqual(coordinator.acknowledge({
      activationId: 'reload', deliveryToken: oldToken, status: 'opened-pty',
    }), { ok: false, acknowledged: false });
    assert.deepEqual(coordinator.acknowledge({
      activationId: 'reload', deliveryToken: newToken, status: 'opened-pty',
    }), { ok: true, acknowledged: true, activationId: 'reload', status: 'opened-pty' });
    coordinator.dispose();
  });

  test('세션이나 정확한 PTY가 늦게 나타나도 새 프로세스 없이 재시도해 한 번만 연다', async () => {
    let sessions = [];
    let ptyReady = false;
    const shown = [];
    const opened = [];
    const acknowledged = [];
    const controller = createAttentionActivationController({
      getSessions: () => sessions,
      isProviderVisible: () => true,
      showSession: session => shown.push(session.id),
      openPty: async session => {
        opened.push(session.id);
        return ptyReady ? { opened: true, retryable: false } : { opened: false, retryable: true };
      },
      acknowledge: value => { acknowledged.push(value); return { acknowledged: true }; },
    });
    controller.handle(activation('late'));
    await flush();
    assert.equal(controller.pendingCount(), 1);
    assert.deepEqual(opened, []);

    sessions = [{ id: 'codex:session-1', externalId: 'session-1', provider: 'codex' }];
    controller.retry();
    await flush();
    assert.deepEqual(opened, ['codex:session-1']);
    assert.deepEqual(shown, ['codex:session-1']);
    assert.equal(controller.pendingCount(), 1);

    ptyReady = true;
    controller.retry();
    await flush();
    assert.deepEqual(opened, ['codex:session-1', 'codex:session-1']);
    assert.deepEqual(shown, ['codex:session-1']);
    assert.deepEqual(acknowledged, [{ activationId: 'late', deliveryToken: 'delivery-late', status: 'opened-pty' }]);
    assert.equal(controller.pendingCount(), 0);
  });

  test('새 알람이 온 동안 오래된 PTY open Promise가 끝나도 담당 AI 선택을 되돌리지 않는다', async () => {
    let releaseOld;
    const sessions = [
      { id: 'codex:old', externalId: 'old', provider: 'codex' },
      { id: 'codex:new', externalId: 'new', provider: 'codex' },
      { id: 'codex:child', externalId: 'child', provider: 'codex', parentId: 'codex:new' },
    ];
    const opened = [];
    const shown = [];
    const acknowledged = [];
    const controller = createAttentionActivationController({
      getSessions: () => sessions,
      isProviderVisible: () => true,
      showSession: session => shown.push(session.id),
      openPty: (session, currentActivation) => {
        opened.push(`${session.id}:${currentActivation.preservePopupFocus}`);
        if (session.id === 'codex:old') return new Promise(resolve => { releaseOld = resolve; });
        return Promise.resolve({ opened: true, retryable: false });
      },
      acknowledge: value => { acknowledged.push(value); return { acknowledged: true }; },
    });
    controller.handle(activation('old-alert', { sessionId: 'codex:old', rawSessionId: 'old' }));
    await flush();
    controller.handle(activation('new-alert', { sessionId: 'codex:new', rawSessionId: 'new' }));
    releaseOld({ opened: true, retryable: false });
    await flush();
    await flush();
    assert.deepEqual(opened, ['codex:old:false', 'codex:new:false']);
    assert.deepEqual(acknowledged, [{ activationId: 'new-alert', deliveryToken: 'delivery-new-alert', status: 'opened-pty' }]);

    controller.handle(activation('child-alert', {
      sessionId: 'codex:child', rawSessionId: 'child', agentId: 'child',
    }));
    await flush();
    assert.deepEqual(shown, ['codex:child']);
    assert.deepEqual(acknowledged.at(-1), { activationId: 'child-alert', deliveryToken: 'delivery-child-alert', status: 'opened-session' });
    assert.deepEqual(opened, ['codex:old:false', 'codex:new:false']);

    controller.handle(activation('question-alert', {
      sessionId: 'codex:new', rawSessionId: 'new', preservePopupFocus: true,
    }));
    await flush();
    assert.equal(opened.at(-1), 'codex:new:true');
  });

  test('취소된 느린 PTY 이동은 UI를 커밋하지 않고 새 알람을 막지 않는다', async () => {
    let releaseOld;
    const committed = [];
    const acknowledged = [];
    const sessions = [
      { id: 'codex:old', externalId: 'old', provider: 'codex' },
      { id: 'codex:new', externalId: 'new', provider: 'codex' },
    ];
    const controller = createAttentionActivationController({
      getSessions: () => sessions,
      isProviderVisible: () => true,
      openPty: (session, _activation, operation) => {
        if (session.id === 'codex:old') {
          return new Promise(resolve => {
            releaseOld = () => {
              if (operation.isCurrent()) committed.push(session.id);
              resolve({ opened: operation.isCurrent(), retryable: true });
            };
          });
        }
        if (operation.isCurrent()) committed.push(session.id);
        return Promise.resolve({ opened: true, retryable: false });
      },
      acknowledge: value => { acknowledged.push(value); return { acknowledged: true }; },
    });
    controller.handle(activation('old-slow', { sessionId: 'codex:old', rawSessionId: 'old' }));
    await flush();
    controller.handle(activation('new-fast', { sessionId: 'codex:new', rawSessionId: 'new' }));
    await flush();
    assert.deepEqual(committed, ['codex:new']);
    assert.equal(acknowledged.at(-1).activationId, 'new-fast');
    releaseOld();
    await flush();
    assert.deepEqual(committed, ['codex:new']);
  });

  test('ACK 거절은 요청을 보존하고 재시도할 때 PTY를 다시 열지 않는다', async () => {
    let ackCount = 0;
    let openCount = 0;
    const controller = createAttentionActivationController({
      getSessions: () => [{ id: 'codex:session-1', externalId: 'session-1', provider: 'codex' }],
      isProviderVisible: () => true,
      openPty: async () => { openCount += 1; return { opened: true, retryable: false }; },
      acknowledge: () => ({ acknowledged: ++ackCount > 1 }),
    });
    controller.handle(activation('ack-retry'));
    await flush();
    assert.equal(controller.pendingCount(), 1);
    assert.equal(openCount, 1);
    controller.retry();
    await flush();
    assert.equal(controller.pendingCount(), 0);
    assert.equal(openCount, 1);
    assert.equal(ackCount, 2);
  });

  test('정확한 PTY를 확인한 뒤에만 terminal 화면을 연다', () => {
    const root = path.resolve(__dirname, '..', '..');
    const bootstrapSource = fs.readFileSync(path.join(root, 'renderer', 'app-bootstrap.js'), 'utf8');
    const terminalAgentSource = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const terminalWorkbenchSource = fs.readFileSync(path.join(root, 'renderer', 'terminal-workbench.js'), 'utf8');
    const readyIndex = terminalAgentSource.indexOf("if (typeof options.onTargetReady === 'function')");
    const terminalCommitIndex = terminalAgentSource.indexOf("state.mode = 'general';", readyIndex);
    assert(readyIndex >= 0 && terminalCommitIndex > readyIndex);
    assert(bootstrapSource.includes('onTargetReady: target => {'));
    assert(bootstrapSource.indexOf('onTargetReady: target => {') < bootstrapSource.indexOf('selectView("terminal");'));
    assert(terminalWorkbenchSource.includes('async function showSelection(options = {})'));
    assert(terminalWorkbenchSource.includes('(!options.isCurrent || options.isCurrent())'));
    assert(terminalWorkbenchSource.includes('if (await showSelection(options) === false) return false;'));
  });
}

async function run() {
  const tests = [];
  registerAttentionActivationTests({ test: (name, fn) => tests.push({ name, fn }) });
  let passed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      process.stdout.write(`PASS ${item.name}\n`);
    } catch (error) {
      process.stderr.write(`FAIL ${item.name}\n${error.stack}\n`);
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${passed}/${tests.length} attention activation tests passed\n`);
}

if (require.main === module) run();

module.exports = { registerAttentionActivationTests };
