'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const RELEASE_API = 'https://api.github.com/repos/minjund/LodeToAgent/releases/latest';
const RELEASE_PAGE = 'https://github.com/minjund/LodeToAgent/releases/latest';

function normalizeVersion(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^refs\/tags\//i, '')
    .replace(/^v/i, '');
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    raw: normalized,
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (!a || !b) throw new Error('비교할 버전 형식이 올바르지 않습니다.');
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
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
    if (aNumeric && bNumeric) return Number(aPart) > Number(bPart) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart > bPart ? 1 : -1;
  }
  return 0;
}

function trustedDownloadUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/minjund/LodeToAgent/releases/download/');
  } catch {
    return false;
  }
}

function assetScore(asset, options) {
  const name = String(asset && asset.name || '');
  const lower = name.toLowerCase();
  const version = String(options.version || '').toLowerCase();
  if (!name || asset.state && asset.state !== 'uploaded' || !trustedDownloadUrl(asset.browser_download_url)) return -1;
  let score = lower.includes(version) ? 12 : 0;
  if (options.platform === 'win32') {
    if (!lower.endsWith('.exe')) return -1;
    if (lower.includes('setup')) score += 100;
    else if (lower.includes('portable')) score += 70;
    else score += 30;
    if (options.arch === 'arm64') score += lower.includes('arm64') ? 25 : -40;
    else if (lower.includes('arm64')) score -= 40;
    return score;
  }
  if (options.platform === 'darwin') {
    if (!lower.endsWith('.dmg')) return -1;
    score += 90;
    if (options.arch === 'arm64') score += lower.includes('arm64') ? 30 : -50;
    if (options.arch === 'x64') score += lower.includes('x64') ? 30 : -50;
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
    size: Number(asset.size || 0),
    url: String(asset.browser_download_url || ''),
    digest: /^sha256:[0-9a-f]{64}$/i.test(String(asset.digest || '')) ? String(asset.digest).toLowerCase() : '',
  };
}

function safeFileName(value) {
  return path.basename(String(value || '')).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 180);
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
    this.downloadsDir = String(options.downloadsDir || '');
    this.apiUrl = String(options.apiUrl || RELEASE_API);
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
    try {
      if (typeof this.fetch !== 'function') throw new Error('업데이트 서버에 연결할 수 없습니다.');
      const response = await this.fetch(this.apiUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': `LoadToAgent/${this.currentVersion}`,
        },
      });
      if (!response || !response.ok) throw new Error(`GitHub에서 최신 버전을 확인하지 못했습니다${response && response.status ? ` (${response.status})` : ''}.`);
      const release = await response.json();
      const latest = normalizeVersion(release && release.tag_name);
      if (!latest || release.draft || release.prerelease) throw new Error('최신 정식 릴리스의 버전 정보가 올바르지 않습니다.');
      const releaseUrl = trustedReleasePage(release.html_url) ? release.html_url : RELEASE_PAGE;
      const asset = selectReleaseAsset(release.assets, { platform: this.platform, arch: this.arch, version: latest.raw });
      const available = compareVersions(latest.raw, this.currentVersion) > 0;
      return this.setState({
        status: available ? 'available' : 'current',
        latestVersion: latest.raw,
        tag: String(release.tag_name || `v${latest.raw}`),
        releaseUrl,
        publishedAt: String(release.published_at || ''),
        notes: String(release.body || '').slice(0, 12_000),
        asset: available ? publicAsset(asset) : null,
        progress: 0,
        downloadedBytes: 0,
        totalBytes: Number(asset && asset.size || 0),
        downloadedPath: '',
        checkedAt: new Date().toISOString(),
        error: available && !asset ? '이 운영체제에 맞는 설치 파일이 아직 릴리스에 올라오지 않았습니다.' : '',
      });
    } catch (error) {
      return this.setState({ status: 'error', error: error && error.message || '업데이트 확인 중 문제가 발생했습니다.', checkedAt: new Date().toISOString() });
    }
  }

  async download() {
    if (this.downloadPromise) return this.downloadPromise;
    if (this.state.status === 'downloaded' && this.state.downloadedPath && fs.existsSync(this.state.downloadedPath)) return this.getState();
    if (!this.state.asset || !trustedDownloadUrl(this.state.asset.url)) throw new Error('다운로드할 설치 파일이 없습니다.');
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
    try {
      await fs.promises.mkdir(this.downloadsDir, { recursive: true });
      await fs.promises.rm(temporaryPath, { force: true });
      const response = await this.fetch(asset.url, { headers: { 'User-Agent': `LoadToAgent/${this.currentVersion}` } });
      if (!response || !response.ok) throw new Error(`업데이트 파일을 내려받지 못했습니다${response && response.status ? ` (${response.status})` : ''}.`);
      const headerSize = Number(response.headers && response.headers.get && response.headers.get('content-length') || 0);
      const totalBytes = Number(asset.size || headerSize || 0);
      const hash = crypto.createHash('sha256');
      let downloadedBytes = 0;
      let lastProgressAt = 0;
      handle = await fs.promises.open(temporaryPath, 'w');
      const writeChunk = async value => {
        const chunk = Buffer.from(value);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(chunk, offset, chunk.length - offset);
          if (!result.bytesWritten) throw new Error('업데이트 파일을 디스크에 저장하지 못했습니다.');
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
        const reader = response.body.getReader();
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          await writeChunk(result.value);
        }
      } else {
        await writeChunk(await response.arrayBuffer());
      }
      await handle.close();
      handle = null;
      if (asset.size && downloadedBytes !== Number(asset.size)) throw new Error('다운로드한 파일 크기가 GitHub 릴리스 정보와 다릅니다.');
      const digest = `sha256:${hash.digest('hex')}`;
      if (asset.digest && digest !== asset.digest) throw new Error('다운로드한 파일의 SHA-256 검증에 실패했습니다.');
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
      if (handle) await handle.close().catch(() => {});
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
      this.setState({ status: 'available', progress: 0, downloadedBytes: 0, downloadedPath: '', error: error && error.message || '업데이트 파일을 내려받지 못했습니다.' });
      throw error;
    }
  }

  async openDownloaded() {
    const file = this.state.downloadedPath;
    if (!file || !fs.existsSync(file)) throw new Error('내려받은 설치 파일을 찾지 못했습니다. 다시 다운로드해 주세요.');
    if (!this.shell || typeof this.shell.openPath !== 'function') throw new Error('설치 파일을 열 수 없습니다.');
    const error = await this.shell.openPath(file);
    if (error) throw new Error(error);
    return this.getState();
  }

  async openReleasePage() {
    const url = trustedReleasePage(this.state.releaseUrl) ? this.state.releaseUrl : RELEASE_PAGE;
    if (!this.shell || typeof this.shell.openExternal !== 'function') throw new Error('릴리스 페이지를 열 수 없습니다.');
    await this.shell.openExternal(url);
    return { ok: true };
  }
}

function trustedReleasePage(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/minjund/LodeToAgent/releases/');
  } catch {
    return false;
  }
}

module.exports = {
  RELEASE_API,
  RELEASE_PAGE,
  UpdateManager,
  compareVersions,
  normalizeVersion,
  selectReleaseAsset,
  trustedDownloadUrl,
};
