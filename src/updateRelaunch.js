'use strict';

const fs = require('fs');
const path = require('path');

const READY_PATH_ENV = 'LOADTOAGENT_UPDATE_READY_PATH';
const READY_TOKEN_ENV = 'LOADTOAGENT_UPDATE_READY_TOKEN';
const TOKEN_PATTERN = /^[0-9a-f]{48}$/;

function readUpdateRelaunchRequest(environment = process.env) {
  const readyPath = String(environment && environment[READY_PATH_ENV] || '').trim();
  const token = String(environment && environment[READY_TOKEN_ENV] || '').trim().toLowerCase();
  if (!path.isAbsolute(readyPath) || !TOKEN_PATTERN.test(token)) return null;
  if (path.basename(readyPath) !== `install-renderer-ready-${token}.json`) return null;
  return { readyPath: path.resolve(readyPath), token };
}

async function signalRendererReady(options = {}) {
  const environment = options.environment || process.env;
  const request = options.request
    ? readUpdateRelaunchRequest({
      [READY_PATH_ENV]: options.request.readyPath,
      [READY_TOKEN_ENV]: options.request.token,
    })
    : readUpdateRelaunchRequest(environment);
  if (!request) return { signaled: false, readyPath: '' };

  const pid = Number(options.pid ?? process.pid);
  const version = String(options.version || '').trim();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !version) {
    throw new Error('업데이트 재실행 준비 신호에 필요한 앱 정보를 확인하지 못했습니다.');
  }

  const fileSystem = options.fileSystem || fs;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const temporaryPath = `${request.readyPath}.${pid}.tmp`;
  const payload = {
    token: request.token,
    pid,
    version,
    rendererReadyAt: now().toISOString(),
  };

  await fileSystem.promises.mkdir(path.dirname(request.readyPath), { recursive: true });
  await fileSystem.promises.rm(temporaryPath, { force: true });
  await fileSystem.promises.writeFile(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  await fileSystem.promises.rm(request.readyPath, { force: true });
  await fileSystem.promises.rename(temporaryPath, request.readyPath);
  delete environment[READY_PATH_ENV];
  delete environment[READY_TOKEN_ENV];
  return { signaled: true, readyPath: request.readyPath };
}

module.exports = {
  READY_PATH_ENV,
  READY_TOKEN_ENV,
  readUpdateRelaunchRequest,
  signalRendererReady,
};
