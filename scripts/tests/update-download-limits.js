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
              read: () => new Promise(() => {}),
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
