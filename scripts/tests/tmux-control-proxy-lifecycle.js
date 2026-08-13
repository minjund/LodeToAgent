'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  ControlProtocolParser,
  TmuxControlProxy,
  base64urlEncode,
  parseLaunchPayload,
} = require('../../src/tmuxControlProxy');

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { write() {} };
    this.killed = false;
  }

  kill() {
    this.killed = true;
  }
}

function proxyOptions(index = 0) {
  return {
    distro: 'Ubuntu-22.04',
    session: `work-${index}`,
    sessionId: `$${70 + index}`,
    window: `@${80 + index}`,
    pane: `%${90 + index}`,
    panePid: String(4_900 + index),
    channel: `proxy-lifecycle-${index}`,
    readyMarker: `PROXY_READY_${index}`,
    cols: 120,
    rows: 32,
  };
}

function sourceProbeLine(options) {
  return [
    options.sessionId, options.session, options.window, options.pane, options.panePid, '0',
    '120', '32', '60', '30',
  ].join('\t') + '\n';
}

function immediate() {
  return new Promise(resolve => setImmediate(resolve));
}

function exitPromise(proxy) {
  return new Promise(resolve => proxy.onExit(resolve));
}

function completeProbe(child, options) {
  child.stdout.emit('data', Buffer.from(sourceProbeLine(options), 'utf8'));
  child.emit('close', 0, null);
}

function registerTmuxControlProxyLifecycleTests({ test }) {
  test('exact proxy launch payload는 완전한 agent process identity만 허용한다', () => {
    const options = {
      ...proxyOptions(0),
      agentPid: 5_101,
      agentProvider: 'codex',
      agentExternalId: '019f-bound-agent',
      agentArgvHash: 'a'.repeat(64),
      agentStartTimeTicks: '99112233',
      agentProcessGroupId: 5_101,
    };
    const parsed = parseLaunchPayload(base64urlEncode(JSON.stringify(options)));
    assert.equal(parsed.agentPid, '5101');
    assert.equal(parsed.agentProcessGroupId, '5101');
    assert.equal(parsed.agentArgvHash, 'a'.repeat(64));
    const partial = { ...options };
    delete partial.agentStartTimeTicks;
    assert.throws(
      () => parseLaunchPayload(base64urlEncode(JSON.stringify(partial))),
      /incomplete tmux agent identity/u,
    );
  });

  test('exact proxy의 모든 guarded operation은 live agent proc lineage를 함께 검증한다', () => {
    const proxy = new TmuxControlProxy({
      ...proxyOptions(0),
      agentPid: '5101',
      agentProvider: 'codex',
      agentExternalId: '019f-bound-agent',
      agentArgvHash: 'b'.repeat(64),
      agentStartTimeTicks: '88112233',
      agentProcessGroupId: '5101',
    }, { inProcess: true });
    const predicate = proxy.agentIdentityShellCondition();
    assert.match(predicate, /\/proc\/5101\/stat/u);
    assert.match(predicate, /\/proc\/4900\/stat/u);
    assert.match(predicate, /sha256sum \/proc\/5101\/cmdline/u);
    assert.match(predicate, /\$6" = "5101/u, 'pane root의 live tpgid가 agent pgrp와 같아야 합니다.');
    assert.match(predicate, /current=5101/u);
    const operation = proxy.exactOperation('send-keys -t target Enter', 'ACK', 'FAIL');
    assert.match(operation, /if-shell[^\n]+if-shell/u);
    assert.match(operation, /^if-shell -F -t '\$70:@80\.%90'/u, 'linked shadow가 아닌 source session/window identity로 검증해야 합니다.');
    assert.equal(operation.includes(predicate), false, 'tmux command에는 shell predicate가 안전하게 quote되어야 합니다.');
    assert.match(operation, /sha256sum/u);
  });

  test('exact proxy 시작 probe는 UI를 막지 않고 close 시 취소되어 control을 만들지 않는다', async () => {
    const options = proxyOptions(1);
    const probe = new FakeChild(10_101);
    let controlSpawns = 0;
    let probeSpawnOptions = null;
    const proxy = new TmuxControlProxy(options, {
      inProcess: true,
      spawnProbeChild: (_file, _args, spawnOptions) => {
        probeSpawnOptions = spawnOptions;
        return probe;
      },
      spawnChild: () => {
        controlSpawns += 1;
        return new FakeChild(20_101);
      },
    });
    const exited = exitPromise(proxy);
    const starting = proxy.start();

    assert.equal(proxy.pid, probe.pid);
    assert.equal(proxy.__whiteboxStartupPending, true);
    assert.equal(probeSpawnOptions.detached, process.platform !== 'win32');
    await immediate();
    assert.equal(controlSpawns, 0);

    proxy.kill();
    await assert.rejects(starting, error => error.code === 'TMUX_PROXY_STOPPED');
    assert.equal(probe.killed, true);
    completeProbe(probe, options);
    await exited;
    assert.equal(controlSpawns, 0, '취소 뒤 늦은 probe close가 control을 만들면 안 됩니다.');
  });

  test('exact proxy probe 완료와 control spawn 사이 close도 새 child를 만들지 않는다', async () => {
    const options = proxyOptions(2);
    const probe = new FakeChild(10_102);
    let controlSpawns = 0;
    const proxy = new TmuxControlProxy(options, {
      inProcess: true,
      spawnProbeChild: () => probe,
      spawnChild: () => {
        controlSpawns += 1;
        return new FakeChild(20_102);
      },
    });
    const exited = exitPromise(proxy);
    const starting = proxy.start();

    completeProbe(probe, options);
    assert.equal(proxy.__whiteboxStartupPending, true);
    proxy.kill();
    await assert.rejects(starting, error => error.code === 'TMUX_PROXY_STOPPED');
    await exited;
    assert.equal(controlSpawns, 0);
  });

  test('cancel된 source probe가 close를 알리지 않으면 bounded fail-closed한다', async () => {
    const options = proxyOptions(4);
    const probe = new FakeChild(10_104);
    const proxy = new TmuxControlProxy(options, {
      inProcess: true,
      probeExitConfirmTimeoutMs: 20,
      spawnProbeChild: () => probe,
      spawnChild: () => new FakeChild(20_104),
    });
    let exited = false;
    proxy.onExit(() => { exited = true; });
    const starting = proxy.start();
    const stopping = proxy.kill();

    await assert.rejects(starting, error => error.code === 'TMUX_PROXY_STOPPED');
    await assert.rejects(stopping, error => error.code === 'TMUX_PROXY_PROBE_EXIT_UNCONFIRMED');
    assert.equal(probe.killed, true);
    assert.equal(exited, false, '확인되지 않은 probe 종료를 성공 onExit으로 알리면 안 됩니다.');
  });

  test('attach 후 exact proxy close는 비동기 shadow cleanup 확인 뒤 exit을 알린다', async () => {
    const options = proxyOptions(3);
    const probe = new FakeChild(10_103);
    const control = new FakeChild(20_103);
    const cleanup = new FakeChild(30_103);
    let controlSpawnOptions = null;
    let controlSpawnArgs = null;
    let cleanupSpawned = false;
    const proxy = new TmuxControlProxy(options, {
      inProcess: true,
      spawnProbeChild: () => probe,
      spawnChild: (_file, args, spawnOptions) => {
        controlSpawnArgs = args;
        controlSpawnOptions = spawnOptions;
        return control;
      },
      spawnCleanupChild: () => {
        cleanupSpawned = true;
        return cleanup;
      },
    });
    let exited = false;
    const exitedPromise = exitPromise(proxy).then(() => { exited = true; });
    const starting = proxy.start();
    completeProbe(probe, options);
    await immediate();

    assert.equal(proxy.__whiteboxStartupPending, false);
    assert.equal(proxy.__whiteboxPosixSignal, 'SIGTERM');
    assert.equal(proxy.pid, control.pid);
    assert.equal(controlSpawnOptions.detached, process.platform !== 'win32');
    const attachFlags = controlSpawnArgs[controlSpawnArgs.indexOf('-f') + 1].split(',');
    assert.deepEqual(attachFlags, ['ignore-size']);
    assert.equal(attachFlags.includes('read-only'), false);
    proxy.kill();
    await assert.rejects(starting, error => error.code === 'TMUX_PROXY_STOPPED');
    await new Promise(resolve => setTimeout(resolve, 55));
    assert.equal(cleanupSpawned, true);
    assert.equal(exited, false, 'shadow cleanup child 완료 전 exit을 확인하면 안 됩니다.');
    cleanup.emit('close', 0, null);
    await exitedPromise;
    assert.equal(exited, true);
  });

  test('동시 exact proxy close는 event loop를 막지 않고 모두 cleanup과 exit을 완료한다', async () => {
    const count = 8;
    const records = Array.from({ length: count }, (_, index) => {
      const options = proxyOptions(10 + index);
      const probe = new FakeChild(11_000 + index);
      const control = new FakeChild(21_000 + index);
      const cleanup = new FakeChild(31_000 + index);
      const proxy = new TmuxControlProxy(options, {
        inProcess: true,
        spawnProbeChild: () => probe,
        spawnChild: () => control,
        spawnCleanupChild: () => cleanup,
      });
      const starting = proxy.start();
      completeProbe(probe, options);
      return { proxy, cleanup, starting, exited: exitPromise(proxy) };
    });
    await immediate();

    let heartbeat = false;
    setImmediate(() => { heartbeat = true; });
    for (const record of records) record.proxy.kill();
    await Promise.all(records.map(record => assert.rejects(
      record.starting,
      error => error.code === 'TMUX_PROXY_STOPPED',
    )));
    await new Promise(resolve => setTimeout(resolve, 55));
    assert.equal(heartbeat, true, '동시 cleanup이 main event loop를 막으면 안 됩니다.');
    for (const record of records) record.cleanup.emit('close', 0, null);
    await Promise.all(records.map(record => record.exited));
  });

  test('shadow cleanup timeout은 child close를 재확인하고 exit 성공으로 오인하지 않는다', async () => {
    const options = proxyOptions(25);
    const probe = new FakeChild(12_025);
    const control = new FakeChild(22_025);
    const cleanup = new FakeChild(32_025);
    const proxy = new TmuxControlProxy(options, {
      inProcess: true,
      cleanupTimeoutMs: 20,
      cleanupExitConfirmTimeoutMs: 100,
      spawnProbeChild: () => probe,
      spawnChild: () => control,
      spawnCleanupChild: () => cleanup,
    });
    let exited = false;
    proxy.onExit(() => { exited = true; });
    const starting = proxy.start();
    completeProbe(probe, options);
    await immediate();

    let stopSettled = false;
    let stopError = null;
    const stopping = proxy.kill().then(
      () => { stopSettled = true; },
      error => { stopSettled = true; stopError = error; },
    );
    await assert.rejects(starting, error => error.code === 'TMUX_PROXY_STOPPED');
    const killDeadline = Date.now() + 500;
    while (!cleanup.killed && Date.now() < killDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(cleanup.killed, true);
    assert.equal(stopSettled, false, 'timeout kill 뒤 cleanup child close를 기다려야 합니다.');
    cleanup.emit('close', null, 'SIGTERM');
    await stopping;
    assert.equal(stopError?.code, 'TMUX_PROXY_CLEANUP_TIMEOUT');
    assert.equal(exited, false, 'cleanup 미확인 종료를 성공 onExit으로 알리면 안 됩니다.');
  });

  test('topology 경계를 가로지른 pane bytes와 분할 UTF-8을 손실 없이 전달한다', async () => {
    const proxy = new TmuxControlProxy(proxyOptions(30), { inProcess: true });
    proxy.verified = true;
    proxy.topologyEpoch = 3;
    proxy.outputPending = [
      { data: Buffer.from('before-'), topologyEpoch: 2 },
      { data: Buffer.from('boundary-'), topologyEpoch: 3 },
      { data: Buffer.from('after|'), topologyEpoch: 4 },
    ];
    proxy.outputPendingBytes = proxy.outputPending.reduce((total, item) => total + item.data.length, 0);
    let identityChecks = 0;
    proxy.verifyIdentity = async () => {
      identityChecks += 1;
      proxy.topologyEpoch += 1;
    };
    let observed = '';
    proxy.onData(value => { observed += value; });

    await proxy.flushExactOutput();
    const unicode = Buffer.from('한😀', 'utf8');
    proxy.emitData(unicode.subarray(0, 1));
    proxy.emitProtocolData('LTA_PROXY_ACK_proxy-lifecycle-30;split;accepted;\n');
    for (const byte of unicode.subarray(1)) proxy.emitData(Buffer.from([byte]));

    assert.equal(identityChecks, 1);
    assert.equal(
      observed,
      'before-boundary-after|LTA_PROXY_ACK_proxy-lifecycle-30;split;accepted;\n한😀',
    );
    assert.equal(observed.includes('\ufffd'), false);
  });

  test('capture cutover 뒤 response block에 끼어든 tmux output도 pane bytes로 전달한다', () => {
    const parser = new ControlProtocolParser();
    parser.forwardOutputInsideBlocks = true;
    const output = [];
    const responses = [];
    const notifications = [];
    parser.on('output', event => output.push(event));
    parser.on('response', response => responses.push(response));
    parser.on('notification', notification => notifications.push(notification));

    parser.push(Buffer.from('garbage-prefix %output %90 SHOULD_NOT_FORWARD\\012\n', 'ascii'));
    parser.push(Buffer.from([
      '%begin 100 7 0',
      '%output %90 \\355\\225\\234\\360\\237\\230\\200\\012',
      '%layout-change @80 layout-data',
      'literal response with embedded %output %90 marker',
      'LTA_HEALTH_TOKEN',
      '%end 100 7 0',
      '',
    ].join('\n'), 'ascii'));

    assert.equal(output.length, 1);
    assert.equal(output[0].pane, '%90');
    assert.equal(output[0].data.toString('utf8'), '한😀\n');
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0].lines.map(line => line.toString('utf8')), [
      'literal response with embedded %output %90 marker',
      'LTA_HEALTH_TOKEN',
    ]);
    assert.deepEqual(notifications, ['%layout-change @80 layout-data']);
  });

  test('tmux control response block은 여러 짧은 줄의 누적 크기도 제한한다', () => {
    const parser = new ControlProtocolParser({ maxBlockBytes: 32 });
    let fatalError = null;
    parser.on('fatal', error => { fatalError = error; });
    parser.push(Buffer.from([
      '%begin 101 8 0',
      '1234567890123456',
      'abcdefghijklmnop',
      'overflow',
      '',
    ].join('\n'), 'ascii'));

    assert.match(fatalError?.message || '', /response block exceeded the safety limit/);
    assert.equal(parser.block, null);
  });

  test('command frame은 paste와 Enter를 한 guard로 보내고 확인 뒤 accepted ACK한다', async () => {
    const proxy = new TmuxControlProxy(proxyOptions(41), { inProcess: true });
    const stages = [];
    const acks = [];
    let fatalError = null;
    let releaseInput;
    const inputGate = new Promise(resolve => { releaseInput = resolve; });
    proxy.verifyIdentity = async purpose => { stages.push({ type: 'preflight', purpose }); };
    proxy.loadBufferExact = async (bufferName, bytes) => {
      stages.push({ type: 'load', bufferName, bytes });
    };
    proxy.performInput = command => {
      stages.push({ type: 'input', command });
      return inputGate;
    };
    proxy.execute = async command => { stages.push({ type: 'cleanup', command }); };
    proxy.emitCommandAck = (...args) => { acks.push(args); };
    proxy.fatal = error => { fatalError ||= error; };

    const requestId = 'atomic-command-success';
    const commandText = "printf 'atomic-ok\\n'";
    proxy.handleCommandFrame(
      proxy.options.channel,
      base64urlEncode(JSON.stringify({ requestId, command: commandText })),
    );
    await immediate();

    assert.deepEqual(stages.map(stage => stage.type), ['preflight', 'load', 'input']);
    assert.equal(stages[0].purpose, 'input-preflight');
    const bufferName = stages[1].bufferName;
    assert.match(bufferName, new RegExp(`^lta-${proxy.nonce.slice(0, 10)}-[a-f0-9]{10}$`, 'u'));
    assert.equal(stages[1].bytes.equals(Buffer.from(commandText, 'utf8')), true);
    assert.equal(
      stages[2].command,
      `paste-buffer -p -r -d -b ${bufferName} -t '${proxy.fullTarget}' ; send-keys -t '${proxy.fullTarget}' Enter`,
    );
    assert.deepEqual(acks, []);
    assert.equal(fatalError, null);

    releaseInput();
    await proxy.inputOperationChain;
    await immediate();
    assert.deepEqual(stages.map(stage => stage.type), ['preflight', 'load', 'input', 'cleanup']);
    assert.equal(stages[3].command, `delete-buffer -b ${bufferName}`);
    assert.deepEqual(acks, [[requestId, 'accepted']]);
    assert.equal(fatalError, null);
  });

  test('command frame의 불확실한 input만 unknown이고 guard 실패는 rejected다', async () => {
    async function failedCommand(index, errorCode, message, failAtPreflight = false) {
      const proxy = new TmuxControlProxy(proxyOptions(index), { inProcess: true });
      const stages = [];
      const acks = [];
      let fatalError = null;
      proxy.verifyIdentity = async () => {
        stages.push('preflight');
        if (failAtPreflight) {
          const error = new Error(message);
          if (errorCode) error.code = errorCode;
          throw error;
        }
      };
      proxy.loadBufferExact = async () => { stages.push('load'); };
      proxy.performInput = async () => {
        stages.push('input');
        const error = new Error(message);
        error.code = errorCode;
        throw error;
      };
      proxy.execute = async () => { stages.push('cleanup'); };
      proxy.emitCommandAck = (...args) => { acks.push(args); };
      proxy.fatal = error => { fatalError ||= error; };
      const requestId = errorCode === 'TMUX_EXACT_TARGET_CHANGED' || failAtPreflight
        ? 'atomic-command-rejected'
        : 'atomic-command-unknown';
      proxy.handleCommandFrame(
        proxy.options.channel,
        base64urlEncode(JSON.stringify({ requestId, command: "printf 'once\\n'" })),
      );
      await proxy.inputOperationChain;
      await immediate();
      return { acks, fatalError, requestId, stages };
    }

    const uncertain = await failedCommand(42, 'TMUX_CONTROL_PROTOCOL_TIMEOUT', 'input confirmation timed out');
    assert.deepEqual(uncertain.stages, ['preflight', 'load', 'input', 'cleanup']);
    assert.deepEqual(uncertain.acks, [[uncertain.requestId, 'unknown', 'input confirmation timed out']]);
    assert.equal(uncertain.fatalError?.message, 'input confirmation timed out');

    const rejected = await failedCommand(43, 'TMUX_EXACT_TARGET_CHANGED', 'target changed before guarded input');
    assert.deepEqual(rejected.stages, ['preflight', 'load', 'input', 'cleanup']);
    assert.deepEqual(rejected.acks, [[rejected.requestId, 'rejected', 'target changed before guarded input']]);
    assert.equal(rejected.fatalError?.message, 'target changed before guarded input');

    const preflight = await failedCommand(44, '', 'old window target is gone', true);
    assert.deepEqual(preflight.stages, ['preflight']);
    assert.deepEqual(preflight.acks, [[preflight.requestId, 'rejected', 'old window target is gone']]);
    assert.equal(preflight.fatalError?.message, 'old window target is gone');
  });

  test('health와 topology probe는 느린 control 응답 동안 bounded coalesce된다', async () => {
    const proxy = new TmuxControlProxy(proxyOptions(45), { inProcess: true });
    proxy.verified = true;
    let checks = 0;
    let release;
    proxy.verifyIdentity = () => {
      checks += 1;
      return new Promise(resolve => { release = resolve; });
    };

    const first = proxy.checkHealth();
    const second = proxy.checkHealth();
    assert.equal(first, second);
    assert.equal(checks, 1);
    release();
    await first;

    const third = proxy.checkHealth();
    assert.equal(checks, 2);
    release();
    await third;
    assert.equal(proxy.healthCheckPromise, null);

    const topology = new TmuxControlProxy(proxyOptions(46), { inProcess: true });
    topology.verified = true;
    const purposes = [];
    let releaseTopology;
    topology.verifyIdentity = purpose => {
      purposes.push(purpose);
      return new Promise(resolve => { releaseTopology = resolve; });
    };
    topology.parser.emit('notification', '%layout-change @125 layout-one');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(purposes, ['topology']);
    const skippedHealth = topology.checkHealth();
    topology.parser.emit('notification', '%layout-change @125 layout-two');
    topology.parser.emit('notification', '%window-add @126');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(purposes, ['topology']);
    releaseTopology();
    await skippedHealth;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(purposes, ['topology', 'topology']);
    releaseTopology();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(topology.topologyRefreshPromise, null);
    assert.equal(topology.topologyRefreshPending, false);
  });

  test('exact input 실패는 private buffer와 timeout 뒤 protocol 연결을 fail-closed 정리한다', async () => {
    const proxy = new TmuxControlProxy(proxyOptions(40), { inProcess: true });
    const commands = [];
    proxy.loadBufferExact = async () => {};
    proxy.performInput = async () => {
      throw new Error('target identity changed');
    };
    proxy.execute = async command => { commands.push(command); };

    await assert.rejects(
      proxy.pasteBufferExact('lta-private-buffer', Buffer.from('secret'), 'paste-buffer guarded'),
      /target identity changed/u,
    );
    assert.deepEqual(commands, ['delete-buffer -b lta-private-buffer']);

    const graceProxy = new TmuxControlProxy(proxyOptions(34), { inProcess: true });
    let graceFatal = null;
    graceProxy.fatal = error => { graceFatal = error; };
    let resolveGrace;
    let rejectGrace;
    const recovered = new Promise((resolve, reject) => {
      resolveGrace = resolve;
      rejectGrace = reject;
    });
    const graceTimer = setTimeout(() => {}, 1_000);
    graceProxy.pendingResponses.push({ resolve: resolveGrace, reject: rejectGrace, timer: graceTimer });
    graceProxy.deferControlTimeout(resolveGrace, rejectGrace, 'should be recovered from buffered stdout');
    graceProxy.parser.push(Buffer.from([
      '%begin 99 68 0',
      'BUFFERED_RESPONSE',
      '%end 99 68 0',
      '',
    ].join('\n'), 'ascii'));
    const recoveredLines = await recovered;
    await immediate();
    assert.deepEqual(recoveredLines.map(line => line.toString('utf8')), ['BUFFERED_RESPONSE']);
    assert.equal(graceFatal, null);

    const timedProxy = new TmuxControlProxy(proxyOptions(35), { inProcess: true });
    const control = new FakeChild(20_135);
    const writes = [];
    control.stdin.write = value => { writes.push(String(value)); };
    timedProxy.control = control;
    const exited = exitPromise(timedProxy);

    const first = timedProxy.execute('display-message -p FIRST', 20);
    const second = timedProxy.execute('display-message -p SECOND', 100);
    await assert.rejects(first, error => error.code === 'TMUX_CONTROL_PROTOCOL_TIMEOUT');
    assert.equal(timedProxy.stopping, true);
    await assert.rejects(second, /unavailable/u);

    timedProxy.parser.push(Buffer.from([
      '%begin 100 70 0',
      'LATE_FIRST_RESPONSE',
      '%end 100 70 0',
      '',
    ].join('\n'), 'ascii'));
    await exited;
    assert.equal(writes.includes('display-message -p FIRST\n'), true);
    assert.equal(writes.includes('display-message -p SECOND\n'), false);
  });
}

module.exports = { registerTmuxControlProxyLifecycleTests };
