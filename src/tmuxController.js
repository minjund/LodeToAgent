'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { reportRecoverableError, runBestEffort } = require('./diagnostics');

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DELIVERY_RECORDS = 256;
const MAX_DELIVERY_STORE_BYTES = 2 * 1024 * 1024;
const DELIVERY_STORE_VERSION = 1;
const ALLOWED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'BSpace', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PPage', 'NPage', 'C-c', 'C-d', 'C-l', 'C-z']);
const ALLOWED_LAYOUTS = new Set(['even-horizontal', 'even-vertical', 'main-horizontal', 'main-vertical', 'tiled']);

function clean(value, max = 200) {
  const text = String(value == null ? '' : value).replace(/[\u0000\r\n]/g, '').trim();
  if (!text || text.length > max) throw new Error('선택한 명령창 정보가 올바르지 않습니다.');
  return text;
}

function safeName(value) {
  const text = clean(value, 100);
  if (!/^[\p{L}\p{N}_.-]+$/u.test(text)) throw new Error('이름에는 글자, 숫자, 점(.), 밑줄(_), - 기호만 사용할 수 있습니다.');
  return text;
}

function safeTarget(value) {
  const text = clean(value, 160);
  if (!/^[\p{L}\p{N}_@%$.:+\/-]+$/u.test(text)) throw new Error('선택한 명령창 정보의 형식이 올바르지 않습니다.');
  return text;
}

function normalizedDeliveryId(value) {
  const id = String(value == null ? '' : value).trim().slice(0, 240);
  return /^[A-Za-z0-9:._-]+$/.test(id) ? id : '';
}

function deliveryFingerprint(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex');
}

function rejectedDeliveryError(message, code = 'TMUX_DELIVERY_REJECTED', deliveryId = '') {
  const error = new Error(message);
  error.code = code;
  error.deliveryState = 'rejected';
  error.deliveryId = deliveryId;
  return error;
}

function runProcess(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      runBestEffort('tmux-timeout-kill', () => child.kill());
      finish(new Error('여러 명령창 작업이 제한 시간 안에 끝나지 않았습니다.'));
    }, options.timeoutMs || 8_000);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.on('error', error => finish(error));
    child.on('exit', code => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) finish(null, { ok: true, stdout: out, stderr: err });
      else finish(new Error(err || '여러 명령창 관리 요청을 처리하지 못했습니다.'));
    });
    if (options.input != null) child.stdin.end(String(options.input), 'utf8');
    else child.stdin.end();
  });
}

class TmuxController {
  constructor(options = {}) {
    this.run = options.run || runProcess;
    this.platform = options.platform || process.platform;
    this.fileSystem = options.fileSystem || fs;
    this.deliveryStoreFile = options.deliveryStoreFile || '';
    this.onPersistenceError = typeof options.onPersistenceError === 'function'
      ? options.onPersistenceError
      : () => {};
    this.deliveries = new Map();
    this.deliveryLedgerLoaded = false;
    this.deliveryLedgerError = null;
    this.deliveryQueue = Promise.resolve();
  }

  persistenceError(operation, error) {
    try {
      this.onPersistenceError(operation, error);
    } catch (callbackError) {
      reportRecoverableError(`tmux-delivery-${operation}-callback`, callbackError);
    }
  }

  resolvedDeliveryStoreFile() {
    const value = typeof this.deliveryStoreFile === 'function'
      ? this.deliveryStoreFile()
      : this.deliveryStoreFile;
    return String(value || '').trim() ? path.resolve(String(value)) : '';
  }

  loadDeliveryLedger() {
    if (this.deliveryLedgerLoaded) {
      if (this.deliveryLedgerError) throw this.deliveryLedgerError;
      return;
    }
    this.deliveryLedgerLoaded = true;
    const storeFile = this.resolvedDeliveryStoreFile();
    if (!storeFile) return;
    try {
      const stat = this.fileSystem.statSync(storeFile);
      if (!stat.isFile() || stat.size > MAX_DELIVERY_STORE_BYTES) {
        throw new Error('tmux 전달 장부 파일의 크기가 올바르지 않습니다.');
      }
      const parsed = JSON.parse(this.fileSystem.readFileSync(storeFile, 'utf8'));
      if (parsed?.version !== DELIVERY_STORE_VERSION || !Array.isArray(parsed.deliveries)) {
        throw new Error('tmux 전달 장부 형식이 올바르지 않습니다.');
      }
      for (const value of parsed.deliveries.slice(-MAX_DELIVERY_RECORDS)) {
        const id = normalizedDeliveryId(value?.id);
        const target = String(value?.target || '').trim();
        const fingerprint = String(value?.fingerprint || '').trim().toLowerCase();
        const state = value?.state === 'accepted' ? 'accepted' : (value?.state === 'prepared' ? 'prepared' : '');
        if (!id || !target || target.length > 400 || !/^[a-f0-9]{64}$/.test(fingerprint) || !state) {
          throw new Error('tmux 전달 장부 항목이 올바르지 않습니다.');
        }
        this.deliveries.set(id, {
          target,
          fingerprint,
          state,
          timestamp: String(value?.timestamp || ''),
        });
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      this.persistenceError('load', error);
      this.deliveryLedgerError = rejectedDeliveryError(
        'tmux 전달 장부를 확인하지 못해 질문을 보내지 않았습니다.',
        'TMUX_DELIVERY_LEDGER_INVALID',
      );
      throw this.deliveryLedgerError;
    }
  }

  persistDeliveryLedger() {
    const storeFile = this.resolvedDeliveryStoreFile();
    if (!storeFile) return true;
    if (this.deliveryLedgerError) return false;
    const temporary = `${storeFile}.${process.pid}.tmp`;
    try {
      this.fileSystem.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 });
      const deliveries = [...this.deliveries.entries()].slice(-MAX_DELIVERY_RECORDS).map(([id, record]) => ({
        id,
        target: record.target,
        fingerprint: record.fingerprint,
        state: record.state,
        timestamp: record.timestamp,
      }));
      this.fileSystem.writeFileSync(temporary, JSON.stringify({
        version: DELIVERY_STORE_VERSION,
        deliveries,
      }), { encoding: 'utf8', mode: 0o600 });
      this.fileSystem.renameSync(temporary, storeFile);
      if (typeof this.fileSystem.chmodSync === 'function') this.fileSystem.chmodSync(storeFile, 0o600);
      return true;
    } catch (error) {
      runBestEffort('tmux-delivery-temp-cleanup', () => this.fileSystem.unlinkSync(temporary));
      this.persistenceError('save', error);
      return false;
    }
  }

  rememberDelivery(deliveryId, record, options = {}) {
    const previous = new Map(this.deliveries);
    this.deliveries.set(deliveryId, {
      ...record,
      timestamp: new Date().toISOString(),
    });
    while (this.deliveries.size > MAX_DELIVERY_RECORDS) {
      this.deliveries.delete(this.deliveries.keys().next().value);
    }
    if (!this.persistDeliveryLedger() && options.required) {
      this.deliveries = previous;
      throw rejectedDeliveryError(
        'tmux 전달 장부를 안전하게 저장하지 못해 질문을 보내지 않았습니다.',
        'TMUX_DELIVERY_LEDGER_UNAVAILABLE',
        deliveryId,
      );
    }
  }

  execute(distro, args, options = {}) {
    if (this.platform !== 'win32') return this.run('tmux', args.map(String), options);
    // A cold WSL distro can take several seconds before tmux itself starts.
    return this.run('wsl.exe', ['-d', clean(distro, 100), '--', 'tmux', ...args.map(String)], {
      ...options,
      timeoutMs: options.timeoutMs ?? 15_000,
    });
  }

  sendText(options = {}) {
    if (!String(options.deliveryId || '').trim()) return this.sendTextUnlocked(options);
    const operation = this.deliveryQueue.then(() => this.sendTextUnlocked(options));
    this.deliveryQueue = operation.catch(() => {});
    return operation;
  }

  async sendTextUnlocked(options = {}) {
    const distro = clean(options.distro, 100);
    const target = safeTarget(options.target);
    const text = String(options.text == null ? '' : options.text);
    if (!text || text.length > 128 * 1024) throw new Error('보낼 명령의 크기가 올바르지 않습니다.');
    const requestedDeliveryId = String(options.deliveryId || '').trim();
    const deliveryId = normalizedDeliveryId(requestedDeliveryId);
    if (requestedDeliveryId && !deliveryId) {
      throw rejectedDeliveryError('전달 요청 식별자가 올바르지 않습니다.');
    }
    const deliveryTarget = `${distro}:${target}`;
    const fingerprint = deliveryFingerprint(text);
    if (deliveryId) this.loadDeliveryLedger();
    const knownDelivery = deliveryId ? this.deliveries.get(deliveryId) : null;
    if (knownDelivery) {
      if (knownDelivery.target !== deliveryTarget || knownDelivery.fingerprint !== fingerprint) {
        throw rejectedDeliveryError(
          '이 전달 요청은 다른 대상 또는 다른 내용에 이미 사용됐습니다.',
          'TMUX_DELIVERY_ID_CONFLICT',
          deliveryId,
        );
      }
      return {
        ok: true,
        deliveryId,
        deliveryState: knownDelivery.state === 'accepted' ? 'accepted' : 'unknown',
        duplicate: true,
      };
    }
    const matchingPrepared = deliveryId
      ? [...this.deliveries.entries()].find(([, record]) => (
          record.state === 'prepared'
          && record.target === deliveryTarget
          && record.fingerprint === fingerprint
        ))
      : null;
    if (matchingPrepared) {
      return {
        ok: true,
        deliveryId,
        originalDeliveryId: matchingPrepared[0],
        deliveryState: 'unknown',
        duplicate: true,
      };
    }
    const bufferName = `loadtoagent-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      await this.execute(distro, ['load-buffer', '-b', bufferName, '-'], { input: text });
    } catch (error) {
      if (!deliveryId) throw error;
      throw rejectedDeliveryError(
        error?.message || 'tmux 입력 버퍼를 준비하지 못했습니다.',
        'TMUX_BUFFER_LOAD_REJECTED',
        deliveryId,
      );
    }
    if (deliveryId) {
      try {
        this.rememberDelivery(deliveryId, {
          target: deliveryTarget,
          fingerprint,
          state: 'prepared',
        }, { required: true });
      } catch (error) {
        await this.execute(distro, ['delete-buffer', '-b', bufferName]).catch(cleanupError => {
          reportRecoverableError('tmux-delete-unpersisted-buffer', cleanupError);
        });
        throw error;
      }
    }
    try {
      // Preserve embedded newlines and let interactive AI TUIs treat the whole
      // value as one bracketed paste. Enter is sent separately, exactly once.
      await this.execute(distro, ['paste-buffer', '-p', '-r', '-b', bufferName, '-d', '-t', target]);
    } catch (error) {
      await this.execute(distro, ['delete-buffer', '-b', bufferName]).catch(cleanupError => {
        reportRecoverableError('tmux-delete-failed-buffer', cleanupError);
      });
      if (deliveryId) {
        return { ok: true, deliveryId, deliveryState: 'unknown', partial: true };
      }
      throw error;
    }
    if (options.enter !== false) {
      try {
        await this.execute(distro, ['send-keys', '-t', target, 'Enter']);
      } catch (error) {
        if (deliveryId) {
          return { ok: true, deliveryId, deliveryState: 'unknown', partial: true };
        }
        throw error;
      }
    }
    if (deliveryId) this.rememberDelivery(deliveryId, {
      target: deliveryTarget,
      fingerprint,
      state: 'accepted',
    });
    return { ok: true, ...(deliveryId ? { deliveryId, deliveryState: 'accepted' } : {}) };
  }

  sendKey(options = {}) {
    const key = clean(options.key, 20);
    if (!ALLOWED_KEYS.has(key)) throw new Error('이 명령창에서는 사용할 수 없는 키입니다.');
    return this.execute(options.distro, ['send-keys', '-t', safeTarget(options.target), key]).then(() => ({ ok: true }));
  }

  async capture(options = {}) {
    const lines = Math.max(20, Math.min(5_000, Math.floor(Number(options.lines || 500))));
    const result = await this.execute(options.distro, ['capture-pane', '-p', '-e', '-S', `-${lines}`, '-t', safeTarget(options.target)]);
    return { ok: true, output: result.stdout };
  }

  async newSession(options = {}) {
    const distro = clean(options.distro, 100);
    const name = safeName(options.name);
    const args = ['new-session', '-d', '-s', name];
    if (options.cwd) args.push('-c', clean(options.cwd, 500));
    await this.execute(distro, args);
    if (String(options.command || '').trim()) await this.sendText({ distro, target: name, text: options.command, enter: true });
    return { ok: true, name };
  }

  async newWindow(options = {}) {
    const args = ['new-window', '-d', '-t', safeTarget(options.target)];
    if (options.name) args.push('-n', safeName(options.name));
    if (options.cwd) args.push('-c', clean(options.cwd, 500));
    const result = await this.execute(options.distro, args);
    return { ok: true, output: result.stdout };
  }

  async splitPane(options = {}) {
    // WSL routes command arguments through a Linux command line; a bare tmux
    // format beginning with # can be consumed as a shell comment. -P's default
    // target format is stable and avoids that quoting boundary entirely.
    if (!['horizontal', 'vertical'].includes(options.direction)) throw new Error('지원하지 않는 명령창 나누기 방향입니다.');
    const args = ['split-window', '-d', '-t', safeTarget(options.target), '-P'];
    if (options.direction === 'horizontal') args.splice(1, 0, '-h');
    if (options.cwd) args.push('-c', clean(options.cwd, 500));
    const result = await this.execute(options.distro, args);
    return { ok: true, paneId: result.stdout.trim() };
  }

  async renameSession(options = {}) {
    await this.execute(options.distro, ['rename-session', '-t', safeTarget(options.target), safeName(options.name)]);
    return { ok: true };
  }

  async renameWindow(options = {}) {
    await this.execute(options.distro, ['rename-window', '-t', safeTarget(options.target), safeName(options.name)]);
    return { ok: true };
  }

  async selectLayout(options = {}) {
    const layout = clean(options.layout, 40);
    if (!ALLOWED_LAYOUTS.has(layout)) throw new Error('지원하지 않는 명령창 배치 방식입니다.');
    await this.execute(options.distro, ['select-layout', '-t', safeTarget(options.target), layout]);
    return { ok: true };
  }

  async killPane(options = {}) {
    await this.execute(options.distro, ['kill-pane', '-t', safeTarget(options.target)]);
    return { ok: true };
  }

  async killWindow(options = {}) {
    await this.execute(options.distro, ['kill-window', '-t', safeTarget(options.target)]);
    return { ok: true };
  }

  async killSession(options = {}) {
    await this.execute(options.distro, ['kill-session', '-t', safeTarget(options.target)]);
    return { ok: true };
  }
}

module.exports = {
  TmuxController,
  runProcess,
  safeName,
  safeTarget,
  ALLOWED_KEYS,
  ALLOWED_LAYOUTS,
};
