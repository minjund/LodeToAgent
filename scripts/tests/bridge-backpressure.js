'use strict';

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { BridgeServer } = require('../../src/bridgeServer');
const { createSocketBackpressure, createStdoutBackpressure } = require('../../bin/whitebox');

class FakeBridgeSocket extends EventEmitter {
  constructor({ blockFirstWrite = false } = {}) {
    super();
    this.blockNextWrite = blockFirstWrite;
    this.destroyed = false;
    this.destroyError = null;
    this.ended = false;
    this.endCalls = 0;
    this.frames = [];
    this.writableLength = 0;
  }

  setNoDelay() {}

  write(frame) {
    if (this.destroyed) throw new Error('destroyed bridge socket write');
    const copied = Buffer.from(frame);
    this.frames.push(copied);
    if (!this.blockNextWrite) return true;
    this.blockNextWrite = false;
    this.writableLength = copied.length;
    return false;
  }

  releaseBackpressure() {
    this.writableLength = 0;
    this.emit('drain');
  }

  end() {
    this.endCalls += 1;
    this.ended = true;
  }

  destroy(error = null) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyError = error;
    this.emit('error', error || new Error('fake socket destroyed'));
    this.emit('close');
  }
}

class FakeBridgeManager extends EventEmitter {
  constructor({ sharedId = false } = {}) {
    super();
    this.sharedId = sharedId;
    this.sequence = 0;
  }

  create() {
    this.sequence += 1;
    return {
      id: this.sharedId ? 'terminal:shared' : `terminal:bridge-${this.sequence}`,
      pid: 40_000 + this.sequence,
      status: 'running',
      replay: 'READY',
    };
  }

  write() {}
  resize() {}
  signal() {}
  close() {}
}

function decodedFrames(socket) {
  return socket.frames.map(frame => JSON.parse(frame.toString('utf8')));
}

function authenticate(server, socket, provider = 'codex') {
  server.accept(socket);
  const client = server.clients.get(socket);
  server.handle(client, {
    type: 'run', token: server.token, provider, args: [], cwd: process.cwd(), cols: 80, rows: 24,
  });
  return client;
}

function registerBridgeBackpressureTests(context) {
  const { test, temp } = context;

  test('브리지 started·output·state·error 프레임은 drain 전후 FIFO 순서와 종료를 보존한다', async () => {
    const manager = new FakeBridgeManager();
    const server = new BridgeServer({
      terminalManager: manager,
      discoveryFile: path.join(temp, 'bridge-backpressure-fifo.json'),
      token: 'bridge-backpressure-fifo-token',
      maxOutboundQueueBytes: 4_096,
    });
    const socket = new FakeBridgeSocket({ blockFirstWrite: true });
    const client = authenticate(server, socket);

    server.forwardData({ id: client.terminalId, data: '한글😀' });
    server.forwardState({ session: { id: client.terminalId, status: 'exited', exitCode: 0, signal: null } });
    server.forwardData({ id: client.terminalId, data: 'LATE_OUTPUT_MUST_NOT_BE_SENT' });
    assert.equal(socket.frames.length, 1, 'socket.write(false) 뒤에는 drain 전까지 다음 프레임을 쓰면 안 됩니다.');
    assert.equal(socket.ended, false, '마지막 state가 queue에 남은 동안 socket.end를 먼저 호출하면 안 됩니다.');
    socket.releaseBackpressure();

    const frames = decodedFrames(socket);
    assert.deepStrictEqual(frames.map(frame => frame.type), ['started', 'output', 'state']);
    assert.equal(Buffer.from(frames[1].data, 'base64').toString('utf8'), '한글😀');
    assert.equal(frames.some(frame => Buffer.from(String(frame.data || ''), 'base64').toString('utf8').includes('LATE_OUTPUT')), false,
      'final state 뒤 늦은 output은 socket.end 이후 write될 수 있으므로 queue에 추가하면 안 됩니다.');
    assert.equal(socket.ended, true);
    socket.releaseBackpressure();
    assert.equal(socket.endCalls, 1, '늦은 drain이 socket.end를 중복 호출하면 안 됩니다.');

    const errorSocket = new FakeBridgeSocket({ blockFirstWrite: true });
    const errorClient = authenticate(server, errorSocket);
    server.consume(errorClient, Buffer.from(`${JSON.stringify({ type: 'unsupported' })}\n`, 'utf8'));
    await errorClient.queue;
    assert.equal(errorSocket.frames.length, 1);
    errorSocket.releaseBackpressure();
    assert.deepStrictEqual(decodedFrames(errorSocket).map(frame => frame.type), ['started', 'error']);

    const unauthSocket = new FakeBridgeSocket();
    server.accept(unauthSocket);
    const unauthClient = server.clients.get(unauthSocket);
    const creationsBeforeRejectedAuth = manager.sequence;
    server.consume(unauthClient, Buffer.from([
      JSON.stringify({ type: 'input', data: '' }),
      JSON.stringify({
        type: 'run', token: server.token, provider: 'codex', args: [], cwd: process.cwd(), cols: 80, rows: 24,
      }),
      '',
    ].join('\n'), 'utf8'));
    await unauthClient.queue;
    assert.equal(manager.sequence, creationsBeforeRejectedAuth,
      '인증 전 오류로 종료를 예약한 같은 packet의 다음 run frame이 보이지 않는 PTY를 만들면 안 됩니다.');
    assert.equal(server.clients.get(unauthSocket)?.authenticated, false);
    assert.deepStrictEqual(decodedFrames(unauthSocket).map(frame => frame.type), ['error']);
    assert.equal(unauthSocket.ended, true);

    let releasePreparation;
    let preparationStarted;
    const waitingForPreparation = new Promise(resolve => { preparationStarted = resolve; });
    const disconnectedManager = new FakeBridgeManager();
    const disconnectedServer = new BridgeServer({
      terminalManager: disconnectedManager,
      discoveryFile: path.join(temp, 'bridge-backpressure-disconnected-preparation.json'),
      token: 'bridge-backpressure-disconnected-preparation-token',
      beforeRun: () => {
        preparationStarted();
        return new Promise(resolve => { releasePreparation = resolve; });
      },
    });
    const disconnectedSocket = new FakeBridgeSocket();
    disconnectedServer.accept(disconnectedSocket);
    const disconnectedClient = disconnectedServer.clients.get(disconnectedSocket);
    disconnectedServer.consume(disconnectedClient, Buffer.from(`${JSON.stringify({
      type: 'run',
      token: disconnectedServer.token,
      provider: 'codex',
      args: [],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })}\n`, 'utf8'));
    await waitingForPreparation;
    assert.equal(disconnectedClient.preparing, true);
    assert.equal(disconnectedClient.authTimer, null,
      '유효한 run 요청이 app-server 준비를 기다리는 동안 인증 타임아웃이 소켓을 끊었습니다.');
    disconnectedSocket.emit('close');
    releasePreparation();
    await disconnectedClient.queue;
    assert.equal(disconnectedManager.sequence, 0,
      'app-server 준비를 기다리는 사이 끊긴 클라이언트의 PTY를 뒤늦게 만들면 안 됩니다.');
    disconnectedServer.dispose();

    server.dispose();
    assert.equal(socket.listenerCount('drain'), 0);
    assert.equal(errorSocket.listenerCount('drain'), 0);
    assert.equal(client.outboundQueue.length, 0);
    assert.equal(errorClient.outboundQueue.length, 0);
  });

  test('느린 브리지 client의 bounded queue overflow는 그 client만 끊고 다른 client는 계속 출력한다', () => {
    const manager = new FakeBridgeManager({ sharedId: true });
    const server = new BridgeServer({
      terminalManager: manager,
      discoveryFile: path.join(temp, 'bridge-backpressure-overflow.json'),
      token: 'bridge-backpressure-overflow-token',
      maxOutboundQueueBytes: 512,
    });
    const slowSocket = new FakeBridgeSocket({ blockFirstWrite: true });
    const fastSocket = new FakeBridgeSocket();
    const slowClient = authenticate(server, slowSocket);
    authenticate(server, fastSocket);

    const chunk = 'x'.repeat(150);
    server.forwardData({ id: slowClient.terminalId, data: chunk });
    server.forwardData({ id: slowClient.terminalId, data: chunk });

    assert.equal(slowSocket.destroyed, true);
    assert.equal(slowSocket.destroyError?.code, 'BRIDGE_CLIENT_BACKPRESSURE_OVERFLOW');
    assert.equal(slowClient.outboundQueue.length, 0);
    assert.equal(fastSocket.destroyed, false, '느린 client overflow가 빠른 client 연결까지 끊으면 안 됩니다.');
    assert.deepStrictEqual(decodedFrames(fastSocket).map(frame => frame.type), ['started', 'output', 'output']);
    assert.equal(server.clients.size, 1);
    server.dispose();
  });

  test('CLI stdout backpressure는 bridge socket을 pause하고 drain 뒤에만 resume하며 listener를 정리한다', () => {
    class FakeStdout extends EventEmitter {
      constructor() {
        super();
        this.results = [false, false, true, false];
        this.writes = [];
      }
      write(data) {
        this.writes.push(Buffer.from(data).toString('utf8'));
        return this.results.shift();
      }
    }
    const stdout = new FakeStdout();
    const socket = {
      destroyed: false,
      pauses: 0,
      resumes: 0,
      pause() { this.pauses += 1; },
      resume() { this.resumes += 1; },
    };
    let flow;
    const pending = ['second'];
    flow = createStdoutBackpressure(socket, stdout, () => {
      if (pending.length) flow.write(pending.shift());
    });

    assert.equal(flow.write('first'), false);
    assert.equal(socket.pauses, 1);
    assert.equal(stdout.listenerCount('drain'), 1);
    stdout.emit('drain');
    assert.equal(socket.pauses, 2, 'drain 처리 중 stdout이 다시 막히면 socket을 resume하면 안 됩니다.');
    assert.equal(socket.resumes, 0);
    assert.equal(stdout.listenerCount('drain'), 1);
    stdout.emit('drain');
    assert.equal(socket.resumes, 1);
    assert.deepStrictEqual(stdout.writes, ['first', 'second']);

    assert.equal(flow.write('accepted'), true);
    assert.equal(flow.write('cleanup-blocked'), false);
    assert.equal(stdout.listenerCount('drain'), 1);
    flow.cleanup();
    assert.equal(stdout.listenerCount('drain'), 0);
    stdout.emit('drain');
    assert.equal(socket.resumes, 1, '종료 cleanup 뒤 늦은 drain이 socket을 되살리면 안 됩니다.');
  });

  test('CLI stdin backpressure는 bounded FIFO와 drain 재개 및 종료 순서를 보존한다', () => {
    class FakeCliSocket extends EventEmitter {
      constructor(results = []) {
        super();
        this.results = [...results];
        this.frames = [];
        this.destroyed = false;
        this.destroyError = null;
        this.ended = false;
      }
      write(frame) {
        this.frames.push(Buffer.from(frame));
        return this.results.length > 0 ? this.results.shift() : true;
      }
      end(frame) {
        if (frame) this.frames.push(Buffer.from(frame));
        this.ended = true;
      }
      destroy(error) {
        this.destroyed = true;
        this.destroyError = error;
      }
    }
    const decode = socket => socket.frames.map(frame => JSON.parse(frame.toString('utf8')));

    const socket = new FakeCliSocket([false, true, true, true]);
    let pauses = 0;
    let resumes = 0;
    const flow = createSocketBackpressure(socket, {
      pause: () => { pauses += 1; },
      resume: () => { resumes += 1; },
    });

    assert.equal(flow.send({ type: 'input', data: 'first' }, 'input'), false);
    assert.equal(flow.blocked(), true);
    assert.equal(pauses, 1);
    assert.equal(socket.listenerCount('drain'), 1);
    flow.send({ type: 'resize', cols: 80, rows: 24 }, 'resize');
    flow.send({ type: 'resize', cols: 120, rows: 40 }, 'resize');
    flow.send({ type: 'signal', signal: 'interrupt' }, 'signal');
    flow.send({ type: 'control', value: 'checkpoint' }, 'control');
    assert.equal(flow.pendingCount(), 3, '연속 resize는 최신 값 하나로 합쳐져야 합니다.');
    flow.terminate({ type: 'signal', signal: 'terminate' });
    assert.equal(flow.pendingCount(), 4);
    assert.equal(flow.send({ type: 'input', data: 'late' }, 'input'), false,
      'terminate가 예약된 뒤에는 새 프레임을 받으면 안 됩니다.');

    socket.emit('drain');
    assert.deepStrictEqual(decode(socket), [
      { type: 'input', data: 'first' },
      { type: 'resize', cols: 120, rows: 40 },
      { type: 'signal', signal: 'interrupt' },
      { type: 'control', value: 'checkpoint' },
      { type: 'signal', signal: 'terminate' },
    ]);
    assert.equal(socket.ended, true);
    assert.equal(resumes, 0, '종료 프레임을 보낸 뒤 stdin을 다시 열면 안 됩니다.');
    assert.equal(socket.listenerCount('drain'), 0);

    const resumeSocket = new FakeCliSocket([false]);
    let resumeOnly = 0;
    const resumeFlow = createSocketBackpressure(resumeSocket, {
      pause: () => {},
      resume: () => { resumeOnly += 1; },
    });
    resumeFlow.send({ type: 'input', data: 'blocked' }, 'input');
    resumeSocket.emit('drain');
    assert.equal(resumeOnly, 1, 'drain 뒤 대기 프레임이 없으면 stdin을 한 번 재개해야 합니다.');
    resumeFlow.cleanup();

    const cleanupSocket = new FakeCliSocket([false]);
    let resumeAfterCleanup = 0;
    const cleanupFlow = createSocketBackpressure(cleanupSocket, {
      pause: () => {},
      resume: () => { resumeAfterCleanup += 1; },
    });
    cleanupFlow.send({ type: 'input', data: 'cleanup' }, 'input');
    cleanupFlow.cleanup();
    assert.equal(cleanupSocket.listenerCount('drain'), 0);
    cleanupSocket.emit('drain');
    assert.equal(resumeAfterCleanup, 0, 'shutdown cleanup 뒤 늦은 drain은 stdin을 재개하면 안 됩니다.');

    const overflowSocket = new FakeCliSocket([false]);
    const overflowFlow = createSocketBackpressure(overflowSocket, { pause: () => {} });
    overflowFlow.send({ type: 'input', data: 'blocked' }, 'input');
    for (let index = 0; index < 9; index += 1) {
      overflowFlow.send({ type: 'control', index }, 'control');
    }
    assert.equal(overflowSocket.destroyed, true, 'bounded queue를 넘기면 연결을 명시적으로 종료해야 합니다.');
    assert.equal(overflowSocket.destroyError?.code, 'CLI_BRIDGE_OUTBOUND_OVERFLOW');
    assert.equal(overflowFlow.pendingCount(), 0);
    assert.equal(overflowSocket.listenerCount('drain'), 0);

    const timeoutSocket = new FakeCliSocket([false]);
    let deadlineCallback = null;
    const timeoutToken = { type: 'fake-timeout' };
    const timeoutFlow = createSocketBackpressure(timeoutSocket, { pause: () => {} }, {
      terminateTimeoutMs: 25,
      setTimeout(callback, timeoutMs) {
        assert.equal(timeoutMs, 25);
        deadlineCallback = callback;
        return timeoutToken;
      },
      clearTimeout(token) {
        assert.strictEqual(token, timeoutToken);
      },
    });
    timeoutFlow.send({ type: 'input', data: 'blocked' }, 'input');
    timeoutFlow.terminate({ type: 'signal', signal: 'terminate' });
    assert.equal(timeoutSocket.destroyed, false);
    assert.equal(typeof deadlineCallback, 'function');
    deadlineCallback();
    assert.equal(timeoutSocket.destroyed, true, 'drain이 없으면 종료 deadline 뒤 소켓을 끊어야 합니다.');
    assert.equal(timeoutSocket.destroyError?.code, 'CLI_BRIDGE_TERMINATE_TIMEOUT');
    assert.equal(timeoutFlow.pendingCount(), 0);
    assert.equal(timeoutSocket.listenerCount('drain'), 0);

    const endSocket = new FakeCliSocket();
    let endDeadline = null;
    let clearedEndDeadline = false;
    const endFlow = createSocketBackpressure(endSocket, { pause: () => {} }, {
      setTimeout(callback) {
        endDeadline = callback;
        return timeoutToken;
      },
      clearTimeout(token) {
        assert.strictEqual(token, timeoutToken);
        clearedEndDeadline = true;
      },
    });
    assert.equal(endFlow.terminate({ type: 'signal', signal: 'terminate' }), true);
    assert.equal(endSocket.ended, true);
    endFlow.cleanup();
    assert.equal(clearedEndDeadline, true, '정상 shutdown cleanup은 종료 deadline을 제거해야 합니다.');
    endDeadline();
    assert.equal(endSocket.destroyed, false, 'cleanup 뒤 늦은 deadline callback은 정상 종료 소켓을 끊으면 안 됩니다.');
  });
}

module.exports = { registerBridgeBackpressureTests };
