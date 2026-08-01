'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { reportRecoverableError } = require('./diagnostics');

const RELEASE_API = 'https://api.github.com/repos/minjund/LodeToAgent/releases/latest';
const RELEASE_PAGE = 'https://github.com/minjund/LodeToAgent/releases/latest';
const MAX_UPDATE_CHECK_BYTES = 2 * 1024 * 1024;
const MAX_UPDATE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_CHECK_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

function boundedPositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function withTimeout(promise, timeoutMs, onTimeout, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Settle the public timeout first. Aborting fetch/stream readers can
      // synchronously reject their own promise with AbortError; rejecting here
      // before aborting keeps the stable, user-facing timeout as the race winner.
      reject(new Error(message));
      try { if (onTimeout) onTimeout(); } catch (_abortUnavailable) { /* timeout still wins */ }
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function cancelResponseReader(reader) {
  if (!reader || typeof reader.cancel !== 'function') return;
  try {
    const cancellation = reader.cancel();
    if (cancellation && typeof cancellation.catch === 'function') {
      cancellation.catch(error => reportRecoverableError('update-check-reader-cancel', error));
    }
  } catch (error) {
    reportRecoverableError('update-check-reader-cancel', error);
  }
}

async function readJsonResponse(response, awaitRead, maxBytes) {
  const rawContentLength = Number(response.headers && response.headers.get && response.headers.get('content-length') || 0);
  const contentLength = Number.isSafeInteger(rawContentLength) && rawContentLength > 0 ? rawContentLength : 0;
  if (contentLength > maxBytes) {
    throw new Error('업데이트 서버 응답이 허용된 최대 크기를 초과했습니다.');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('업데이트 서버가 안전한 스트리밍 형식으로 정보를 보내지 않았습니다.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await awaitRead(() => reader.read());
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      if (chunk.length > maxBytes - totalBytes) {
        throw new Error('업데이트 서버 응답이 허용된 최대 크기를 초과했습니다.');
      }
      chunks.push(chunk);
      totalBytes += chunk.length;
    }
  } catch (error) {
    cancelResponseReader(reader);
    throw error;
  }
  if (typeof reader.releaseLock === 'function') reader.releaseLock();
  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8').replace(/^\uFEFF/, ''));
  } catch (_invalidJson) {
    throw new Error('업데이트 서버 응답 형식이 올바르지 않습니다.');
  }
}

function normalizeVersion(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^refs\/tags\//i, '')
    .replace(/^v/i, '');
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    raw: normalized,
    core: match.slice(1, 4),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (!a || !b) throw new Error('비교할 버전 형식이 올바르지 않습니다.');
  for (let index = 0; index < 3; index += 1) {
    const leftPart = BigInt(a.core[index]);
    const rightPart = BigInt(b.core[index]);
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart == null) return -1;
    if (bPart == null) return 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) return BigInt(aPart) > BigInt(bPart) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart > bPart ? 1 : -1;
  }
  return 0;
}

function trustedDownloadUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/minjund/LodeToAgent/releases/download/');
  } catch (_invalidDownloadUrl) {
    // Malformed external input is an expected validation miss, not an operational failure.
    return false;
  }
}

function assetScore(asset, options) {
  const name = String(asset && asset.name || '');
  const lower = name.toLowerCase();
  const version = String(options.version || '').toLowerCase();
  if (!name || asset.state && asset.state !== 'uploaded' || !trustedDownloadUrl(asset.browser_download_url)) return -1;
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasExactVersion = new RegExp(`(?:^|[-_.])${escapedVersion}(?:[-_.]|$)`).test(lower);
  if (!version || !hasExactVersion) return -1;
  const hasArm64 = /(?:^|[-_.])arm64(?:[-_.]|$)/.test(lower);
  const hasX64 = /(?:^|[-_.])(?:x64|amd64)(?:[-_.]|$)/.test(lower);
  const hasIa32 = /(?:^|[-_.])(?:ia32|x86)(?:[-_.]|$)/.test(lower);
  let score = 12;
  if (options.platform === 'win32') {
    if (!lower.endsWith('.exe')) return -1;
    if (options.arch === 'arm64' && !hasArm64) return -1;
    if (options.arch === 'x64' && (hasArm64 || hasIa32)) return -1;
    if (options.arch === 'ia32' && !hasIa32) return -1;
    if (lower.includes('setup')) score += 100;
    else if (lower.includes('portable')) score += 70;
    else score += 30;
    if (options.arch === 'arm64' && hasArm64) score += 25;
    if (options.arch === 'x64' && hasX64) score += 25;
    if (options.arch === 'ia32' && hasIa32) score += 25;
    return score;
  }
  if (options.platform === 'darwin') {
    if (!lower.endsWith('.dmg')) return -1;
    if (options.arch === 'arm64' && !hasArm64) return -1;
    if (options.arch === 'x64' && !hasX64) return -1;
    score += 90;
    if (options.arch === 'arm64') score += 30;
    if (options.arch === 'x64') score += 30;
    return score;
  }
  return -1;
}

function selectReleaseAsset(assets, options) {
  return (Array.isArray(assets) ? assets : [])
    .map(asset => ({ asset, score: assetScore(asset, options || {}) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.asset || null;
}

function publicAsset(asset) {
  if (!asset) return null;
  return {
    name: String(asset.name || ''),
    size: Number.isSafeInteger(Number(asset.size)) && Number(asset.size) >= 0 ? Number(asset.size) : 0,
    url: String(asset.browser_download_url || ''),
    digest: /^sha256:[0-9a-f]{64}$/i.test(String(asset.digest || '')) ? String(asset.digest).toLowerCase() : '',
  };
}

function hasTrustedDigest(asset) {
  return /^sha256:[0-9a-f]{64}$/i.test(String(asset && asset.digest || ''));
}

function safeFileName(value) {
  const fileName = path.basename(String(value || '')).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 180);
  return !fileName || fileName === '.' || fileName === '..' ? '' : fileName;
}

class UpdateManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.currentVersion = String(options.currentVersion || '0.0.0');
    this.platform = String(options.platform || process.platform);
    this.arch = String(options.arch || process.arch);
    this.installType = String(options.installType || 'desktop');
    this.fetch = options.fetch;
    this.shell = options.shell;
    this.verifyInstaller = options.verifyInstaller;
    this.downloadsDir = String(options.downloadsDir || '');
    this.apiUrl = String(options.apiUrl || RELEASE_API);
    this.maxCheckBytes = boundedPositiveInteger(options.maxCheckBytes, MAX_UPDATE_CHECK_BYTES, MAX_UPDATE_CHECK_BYTES);
    this.maxDownloadBytes = boundedPositiveInteger(options.maxDownloadBytes, MAX_UPDATE_BYTES, MAX_UPDATE_BYTES);
    this.checkTimeoutMs = boundedPositiveInteger(options.checkTimeoutMs, DEFAULT_CHECK_TIMEOUT_MS);
    this.downloadTimeoutMs = boundedPositiveInteger(options.downloadTimeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS);
    this.AbortController = options.AbortController || globalThis.AbortController;
    this.checkPromise = null;
    this.downloadPromise = null;
    this.state = {
      status: this.platform === 'darwin' || this.platform === 'win32' ? 'idle' : 'unsupported',
      currentVersion: this.currentVersion,
      latestVersion: '',
      tag: '',
      releaseUrl: RELEASE_PAGE,
      publishedAt: '',
      notes: '',
      asset: null,
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      downloadedPath: '',
      checkedAt: '',
      error: '',
      platform: this.platform,
      arch: this.arch,
      installType: this.installType,
    };
  }

  getState() {
    return { ...this.state, asset: this.state.asset ? { ...this.state.asset } : null };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    this.emit('state', snapshot);
    return snapshot;
  }

  async check() {
    if (this.checkPromise) return this.checkPromise;
    if (this.state.status === 'unsupported') return this.getState();
    this.checkPromise = this.performCheck().finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  async performCheck() {
    this.setState({ status: 'checking', error: '', checkedAt: new Date().toISOString() });
    const controller = this.AbortController ? new this.AbortController() : null;
    const timeoutMessage = '업데이트 확인 시간이 초과되었습니다. 다시 시도해 주세요.';
    const deadline = Date.now() + this.checkTimeoutMs;
    const awaitCheck = operation => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (controller) controller.abort();
        return Promise.reject(new Error(timeoutMessage));
      }
      return withTimeout(Promise.resolve().then(operation), remaining, () => controller && controller.abort(), timeoutMessage);
    };
    try {
      if (typeof this.fetch !== 'function') throw new Error('업데이트 서버에 연결할 수 없습니다.');
      const response = await awaitCheck(() => this.fetch(this.apiUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': `LoadToAgent/${this.currentVersion}`,
        },
        ...(controller ? { signal: controller.signal } : {}),
      }));
      if (!response || !response.ok) throw new Error('최신 버전을 확인하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.');
      const release = await readJsonResponse(response, awaitCheck, this.maxCheckBytes);
      const latest = normalizeVersion(release && release.tag_name);
      if (!latest || release.draft || release.prerelease) throw new Error('공개된 최신 정식 버전 정보가 올바르지 않습니다.');
      const releaseUrl = trustedReleasePage(release.html_url) ? release.html_url : RELEASE_PAGE;
      const asset = selectReleaseAsset(release.assets, { platform: this.platform, arch: this.arch, version: latest.raw });
      const available = compareVersions(latest.raw, this.currentVersion) > 0;
      const candidateAsset = available && hasTrustedDigest(asset) ? publicAsset(asset) : null;
      const assetTooLarge = Boolean(candidateAsset && candidateAsset.size > this.maxDownloadBytes);
      const exposedAsset = assetTooLarge ? null : candidateAsset;
      return this.setState({
        status: available ? 'available' : 'current',
        latestVersion: latest.raw,
        tag: String(release.tag_name || `v${latest.raw}`),
        releaseUrl,
        publishedAt: String(release.published_at || ''),
        notes: String(release.body || '').slice(0, 12_000),
        asset: exposedAsset,
        progress: 0,
        downloadedBytes: 0,
        totalBytes: exposedAsset ? exposedAsset.size : 0,
        downloadedPath: '',
        checkedAt: new Date().toISOString(),
        error: assetTooLarge
          ? '업데이트 파일이 허용된 최대 크기를 초과해 자동으로 받을 수 없습니다.'
          : (available && !asset
          ? '이 운영체제에 맞는 설치 파일이 공식 파일 받기 페이지에 아직 올라오지 않았습니다.'
          : (available && !hasTrustedDigest(asset) ? '설치 파일이 원본인지 확인할 안전 정보가 없어 업데이트할 수 없습니다.' : '')),
      });
    } catch (error) {
      if (controller) controller.abort();
      return this.setState({ status: 'error', error: error && error.message || '업데이트 확인 중 문제가 발생했습니다.', checkedAt: new Date().toISOString() });
    }
  }

  async download() {
    if (this.downloadPromise) return this.downloadPromise;
    if (this.state.status === 'downloaded' && this.state.downloadedPath && fs.existsSync(this.state.downloadedPath)) return this.getState();
    if (!this.state.asset || !trustedDownloadUrl(this.state.asset.url)) throw new Error('받을 설치 파일이 없습니다.');
    if (!hasTrustedDigest(this.state.asset)) throw new Error('원본 여부를 확인할 수 없는 설치 파일은 받을 수 없습니다.');
    this.downloadPromise = this.performDownload().finally(() => { this.downloadPromise = null; });
    return this.downloadPromise;
  }

  async performDownload() {
    const asset = { ...this.state.asset };
    const fileName = safeFileName(asset.name);
    if (!fileName || !this.downloadsDir) throw new Error('업데이트 파일을 저장할 위치를 준비하지 못했습니다.');
    const finalPath = path.join(this.downloadsDir, fileName);
    const temporaryPath = `${finalPath}.download`;
    let handle = null;
    let reader = null;
    const controller = this.AbortController ? new this.AbortController() : null;
    const deadline = Date.now() + this.downloadTimeoutMs;
    const awaitDownload = promise => withTimeout(
      promise,
      Math.max(1, deadline - Date.now()),
      () => controller && controller.abort(),
      '업데이트 파일 받기 시간이 초과되었습니다. 다시 시도해 주세요.',
    );
    try {
      const officialSize = Number(asset.size) > 0 ? Number(asset.size) : 0;
      if (officialSize > this.maxDownloadBytes) throw new Error('업데이트 파일이 허용된 최대 크기를 초과합니다.');
      await fs.promises.mkdir(this.downloadsDir, { recursive: true });
      await fs.promises.rm(temporaryPath, { force: true });
      const response = await awaitDownload(this.fetch(asset.url, {
        headers: { 'User-Agent': `LoadToAgent/${this.currentVersion}` },
        ...(controller ? { signal: controller.signal } : {}),
      }));
      if (!response || !response.ok) throw new Error(`업데이트 파일을 내려받지 못했습니다${response && response.status ? ` (${response.status})` : ''}.`);
      const rawHeaderSize = Number(response.headers && response.headers.get && response.headers.get('content-length') || 0);
      const headerSize = Number.isSafeInteger(rawHeaderSize) && rawHeaderSize > 0 ? rawHeaderSize : 0;
      if (headerSize > this.maxDownloadBytes) throw new Error('업데이트 서버가 허용된 최대 크기보다 큰 파일을 응답했습니다.');
      if (officialSize && headerSize && headerSize !== officialSize) throw new Error('업데이트 서버의 파일 크기가 공식 파일 정보와 다릅니다.');
      const totalBytes = officialSize || headerSize;
      const hash = crypto.createHash('sha256');
      let downloadedBytes = 0;
      let lastProgressAt = 0;
      handle = await fs.promises.open(temporaryPath, 'w');
      const writeChunk = async value => {
        const chunk = Buffer.from(value);
        const nextDownloadedBytes = downloadedBytes + chunk.length;
        if (nextDownloadedBytes > this.maxDownloadBytes) throw new Error('업데이트 파일이 허용된 최대 크기를 초과했습니다.');
        if (officialSize && nextDownloadedBytes > officialSize) throw new Error('받은 파일 크기가 공식 파일 받기 페이지의 파일 정보보다 큽니다.');
        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(chunk, offset, chunk.length - offset);
          if (!result.bytesWritten) throw new Error('업데이트 파일을 컴퓨터에 저장하지 못했습니다.');
          offset += result.bytesWritten;
        }
        hash.update(chunk);
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastProgressAt > 100 || totalBytes && downloadedBytes >= totalBytes) {
          lastProgressAt = now;
          this.setState({
            status: 'downloading',
            downloadedBytes,
            totalBytes,
            progress: totalBytes ? Math.min(100, Math.round(downloadedBytes / totalBytes * 100)) : 0,
            error: '',
          });
        }
      };
      this.setState({ status: 'downloading', progress: 0, downloadedBytes: 0, totalBytes, error: '' });
      if (response.body && typeof response.body.getReader === 'function') {
        reader = response.body.getReader();
        while (true) {
          const result = await awaitDownload(reader.read());
          if (result.done) break;
          await writeChunk(result.value);
        }
      } else {
        throw new Error('업데이트 서버가 안전한 스트리밍 형식으로 파일을 보내지 않았습니다.');
      }
      await handle.close();
      handle = null;
      if (asset.size && downloadedBytes !== Number(asset.size)) throw new Error('받은 파일 크기가 공식 파일 받기 페이지의 파일 정보와 다릅니다.');
      const digest = `sha256:${hash.digest('hex')}`;
      if (digest !== asset.digest) throw new Error('설치 파일이 공식 원본과 같은지 확인하지 못했습니다.');
      await fs.promises.rm(finalPath, { force: true });
      await fs.promises.rename(temporaryPath, finalPath);
      return this.setState({
        status: 'downloaded',
        progress: 100,
        downloadedBytes,
        totalBytes: totalBytes || downloadedBytes,
        downloadedPath: finalPath,
        error: '',
      });
    } catch (error) {
      if (controller) controller.abort();
      if (reader && typeof reader.cancel === 'function') {
        try {
          const cancellation = reader.cancel();
          if (cancellation && typeof cancellation.catch === 'function') {
            cancellation.catch(cleanupError => reportRecoverableError('update-download-reader-cancel', cleanupError));
          }
        } catch (cleanupError) {
          reportRecoverableError('update-download-reader-cancel', cleanupError);
        }
      }
      if (handle) {
        await handle.close().catch(cleanupError => {
          reportRecoverableError('update-download-handle-close', cleanupError);
        });
      }
      await fs.promises.rm(temporaryPath, { force: true }).catch(cleanupError => {
        reportRecoverableError('update-download-temporary-remove', cleanupError);
      });
      this.setState({ status: 'available', progress: 0, downloadedBytes: 0, downloadedPath: '', error: error && error.message || '업데이트 파일을 내려받지 못했습니다.' });
      throw error;
    }
  }

  async openDownloaded() {
    const file = this.state.downloadedPath;
    if (!file || !fs.existsSync(file)) throw new Error('받은 설치 파일을 찾지 못했습니다. 다시 받아 주세요.');
    if (typeof this.verifyInstaller !== 'function') throw new Error('설치 파일의 안전성을 확인하는 기능을 사용할 수 없습니다.');
    await this.verifyInstaller(file);
    if (!this.shell || typeof this.shell.openPath !== 'function') throw new Error('설치 파일을 열 수 없습니다.');
    const error = await this.shell.openPath(file);
    if (error) throw new Error(error);
    return this.getState();
  }

  async openReleasePage() {
    const url = trustedReleasePage(this.state.releaseUrl) ? this.state.releaseUrl : RELEASE_PAGE;
    if (!this.shell || typeof this.shell.openExternal !== 'function') throw new Error('버전 안내 페이지를 열 수 없습니다.');
    await this.shell.openExternal(url);
    return { ok: true };
  }
}

function trustedReleasePage(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/minjund/LodeToAgent/releases/');
  } catch (_invalidReleaseUrl) {
    // Malformed external input is an expected validation miss, not an operational failure.
    return false;
  }
}

module.exports = {
  MAX_UPDATE_CHECK_BYTES,
  MAX_UPDATE_BYTES,
  RELEASE_API,
  RELEASE_PAGE,
  UpdateManager,
  compareVersions,
  normalizeVersion,
  hasTrustedDigest,
  selectReleaseAsset,
  trustedDownloadUrl,
  safeFileName,
};
