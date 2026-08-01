'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UpdateManager } = require('../../src/updateManager');

const DOWNLOAD_ROOT = 'https://github.com/minjund/LodeToAgent/releases/download/v3.1.0/';

function asset(name, size, payload = Buffer.alloc(0)) {
  return {
    name,
    size,
    url: `${DOWNLOAD_ROOT}${name}`,
    digest: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
  };
}

function managerWithAsset(options, updateAsset) {
  const manager = new UpdateManager({
    currentVersion: '3.0.0',
    platform: 'win32',
    arch: 'x64',
    installType: 'desktop',
    ...options,
  });
  manager.state = { ...manager.state, status: 'available', asset: updateAsset };
  return manager;
}

function registerUpdateDownloadLimitTests(context) {
  const { test, temp } = context;

  test('업데이트 확인은 응답 본문이 멈추면 제한 시간 안에 중단한다', async () => {
    let requestSignal = null;
    let readerCancelled = false;
    const manager = new UpdateManager({
      currentVersion: '3.0.0',
      platform: 'win32',
      arch: 'x64',
      checkTimeoutMs: 20,
      fetch: async (_url, options) => {
        requestSignal = options.signal;
        return {
          ok: true,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: () => new Promise((resolve, reject) => {
                if (requestSignal.aborted) {
                  reject(Object.assign(new Error('fixture aborted'), { name: 'AbortError' }));
                  return;
                }
                requestSignal.addEventListener('abort', () => {
                  reject(Object.assign(new Error('fixture aborted'), { name: 'AbortError' }));
                }, { once: true });
              }),
              cancel: async () => { readerCancelled = true; },
            }),
          },
        };
      },
    });

    const state = await manager.check();

    assert.equal(state.status, 'error');
    assert.match(state.error, /시간이 초과/);
    assert.equal(requestSignal.aborted, true);
    assert.equal(readerCancelled, true);
  });

  test('업데이트 확인은 길이 헤더가 없는 과대 응답 본문을 중단한다', async () => {
    let requestSignal = null;
    let readerCancelled = false;
    let reads = 0;
    const manager = new UpdateManager({
      currentVersion: '3.0.0',
      platform: 'win32',
      arch: 'x64',
      maxCheckBytes: 16,
      fetch: async (_url, options) => {
        requestSignal = options.signal;
        return {
          ok: true,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: async () => {
                reads += 1;
                return reads === 1
                  ? { done: false, value: Buffer.alloc(17, 0x20) }
                  : { done: true, value: undefined };
              },
              cancel: async () => { readerCancelled = true; },
            }),
          },
        };
      },
    });

    const state = await manager.check();

    assert.equal(state.status, 'error');
    assert.match(state.error, /최대 크기/);
    assert.equal(reads, 1);
    assert.equal(requestSignal.aborted, true);
    assert.equal(readerCancelled, true);
  });

  test('업데이트 다운로드는 크기 상한·공식 크기·시간 제한을 쓰기 전에 강제한다', async () => {
    const downloadsDir = path.join(temp, 'bounded-update-downloads');
    let fetchCalls = 0;
    const oversized = managerWithAsset({
      downloadsDir,
      maxDownloadBytes: 4,
      fetch: async () => { fetchCalls += 1; },
    }, asset('oversized.exe', 5));
    await assert.rejects(oversized.download(), /최대 크기/);
    assert.equal(fetchCalls, 0);
    assert.equal(fs.existsSync(path.join(downloadsDir, 'oversized.exe.download')), false);

    let overrunCancelled = false;
    const expectedPayload = Buffer.from('safe');
    const existingInstaller = path.join(downloadsDir, 'overrun.exe');
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.writeFileSync(existingInstaller, 'previous verified installer', 'utf8');
    const overrun = managerWithAsset({
      downloadsDir,
      maxDownloadBytes: 32,
      fetch: async () => ({
        ok: true,
        headers: { get: name => String(name).toLowerCase() === 'content-length' ? String(expectedPayload.length) : null },
        body: {
          getReader: () => ({
            read: async () => ({ done: false, value: Buffer.from('unsafe') }),
            cancel: async () => { overrunCancelled = true; },
          }),
        },
      }),
    }, asset('overrun.exe', expectedPayload.length, expectedPayload));
    await assert.rejects(overrun.download(), /공식 파일.*보다 큽니다/);
    assert.equal(overrunCancelled, true);
    assert.equal(fs.readFileSync(existingInstaller, 'utf8'), 'previous verified installer');
    assert.equal(fs.existsSync(`${existingInstaller}.download`), false);

    let timeoutSignal = null;
    let timeoutCancelled = false;
    const timeoutPayload = Buffer.from('wait');
    const timedOut = managerWithAsset({
      downloadsDir,
      maxDownloadBytes: 32,
      downloadTimeoutMs: 20,
      fetch: async (_url, options) => {
        timeoutSignal = options.signal;
        return {
          ok: true,
          headers: { get: name => String(name).toLowerCase() === 'content-length' ? String(timeoutPayload.length) : null },
          body: {
            getReader: () => ({
              read: () => new Promise((resolve, reject) => {
                if (timeoutSignal.aborted) {
                  reject(Object.assign(new Error('fixture aborted'), { name: 'AbortError' }));
                  return;
                }
                timeoutSignal.addEventListener('abort', () => {
                  reject(Object.assign(new Error('fixture aborted'), { name: 'AbortError' }));
                }, { once: true });
              }),
              cancel: async () => { timeoutCancelled = true; },
            }),
          },
        };
      },
    }, asset('timeout.exe', timeoutPayload.length, timeoutPayload));
    await assert.rejects(timedOut.download(), /시간이 초과/);
    assert.equal(timeoutSignal.aborted, true);
    assert.equal(timeoutCancelled, true);
    assert.equal(fs.existsSync(path.join(downloadsDir, 'timeout.exe.download')), false);
    assert.equal(timedOut.getState().status, 'available');
  });
}

module.exports = { registerUpdateDownloadLimitTests };
