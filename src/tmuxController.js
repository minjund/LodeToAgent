'use strict';

const { spawn } = require('child_process');

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const ALLOWED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'BSpace', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PPage', 'NPage', 'C-c', 'C-d', 'C-l', 'C-z']);
const ALLOWED_LAYOUTS = new Set(['even-horizontal', 'even-vertical', 'main-horizontal', 'main-vertical', 'tiled']);

function clean(value, max = 200) {
  const text = String(value == null ? '' : value).replace(/[\u0000\r\n]/g, '').trim();
  if (!text || text.length > max) throw new Error('tmux 대상 값이 올바르지 않습니다.');
  return text;
}

function safeName(value) {
  const text = clean(value, 100);
  if (!/^[\p{L}\p{N}_.-]+$/u.test(text)) throw new Error('이름에는 문자, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.');
  return text;
}

function safeTarget(value) {
  const text = clean(value, 160);
  if (!/^[\p{L}\p{N}_@%$.:+\/-]+$/u.test(text)) throw new Error('tmux 대상 형식이 올바르지 않습니다.');
  return text;
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
      try { child.kill(); } catch {}
      finish(new Error('tmux 명령 시간이 초과되었습니다.'));
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
      else finish(new Error(err || `tmux 명령이 종료 코드 ${code}로 실패했습니다.`));
    });
    if (options.input != null) child.stdin.end(String(options.input), 'utf8');
    else child.stdin.end();
  });
}

class TmuxController {
  constructor(options = {}) {
    this.run = options.run || runProcess;
    this.platform = options.platform || process.platform;
  }

  execute(distro, args, options = {}) {
    if (this.platform !== 'win32') return this.run('tmux', args.map(String), options);
    return this.run('wsl.exe', ['-d', clean(distro, 100), '--', 'tmux', ...args.map(String)], options);
  }

  async sendText(options = {}) {
    const distro = clean(options.distro, 100);
    const target = safeTarget(options.target);
    const text = String(options.text == null ? '' : options.text);
    if (!text || text.length > 128 * 1024) throw new Error('보낼 명령의 크기가 올바르지 않습니다.');
    await this.execute(distro, ['load-buffer', '-'], { input: text });
    await this.execute(distro, ['paste-buffer', '-d', '-t', target]);
    if (options.enter !== false) await this.execute(distro, ['send-keys', '-t', target, 'Enter']);
    return { ok: true };
  }

  sendKey(options = {}) {
    const key = clean(options.key, 20);
    if (!ALLOWED_KEYS.has(key)) throw new Error('허용되지 않은 tmux 키입니다.');
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
    if (!ALLOWED_LAYOUTS.has(layout)) throw new Error('지원하지 않는 tmux 레이아웃입니다.');
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
