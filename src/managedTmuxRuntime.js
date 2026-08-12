'use strict';

const { execFileSync } = require('child_process');

function confirmedMissingTmuxSession(error) {
  if (Number(error?.status) !== 1 || error?.killed || error?.signal) return false;
  if (error?.code && error.code !== 1 && error.code !== '1') return false;
  const diagnostic = `${String(error?.stderr || '')}\n${String(error?.stdout || '')}\n${String(error?.message || '')}`;
  return /can't find session|no server running on|(?:error|failed) connecting to .*no such file/i.test(diagnostic);
}

class ManagedTmuxRuntime {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.execFileSync = options.execFileSync || execFileSync;
  }

  command(options, args) {
    if (this.platform === 'win32') {
      return {
        file: 'wsl.exe',
        args: ['-d', options.distro, '--', 'tmux', '-L', options.tmuxSocket, ...args],
      };
    }
    return {
      file: 'tmux',
      args: ['-L', options.tmuxSocket, ...args],
    };
  }

  execute(options, args) {
    const command = this.command(options, args);
    return this.execFileSync(command.file, command.args, {
      encoding: 'utf8',
      timeout: this.platform === 'win32' ? 15_000 : 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  exists(options) {
    try {
      this.execute(options, ['has-session', '-t', `=${options.managedTmuxSession}`]);
      return true;
    } catch (_missingSession) {
      return false;
    }
  }

  available(options = {}) {
    try {
      this.execute(options, ['-V']);
      return true;
    } catch (_unavailable) {
      return false;
    }
  }

  listSessionsStrict(options) {
    try {
      const output = this.execute(options, ['list-sessions', '-F', '#{session_name}']);
      return new Set(String(output || '')
        .split(/\r?\n/u)
        .map(value => value.trim())
        .filter(Boolean));
    } catch (error) {
      if (confirmedMissingTmuxSession(error)) return new Set();
      throw error;
    }
  }

  existsStrict(options) {
    try {
      this.execute(options, ['has-session', '-t', `=${options.managedTmuxSession}`]);
      return true;
    } catch (error) {
      if (confirmedMissingTmuxSession(error)) return false;
      throw error;
    }
  }

  stop(options) {
    try {
      this.execute(options, ['kill-session', '-t', `=${options.managedTmuxSession}`]);
    } catch (error) {
      if (error?.status !== 1) throw error;
    }
    return { ok: true };
  }

  stopStrict(options) {
    try {
      this.execute(options, ['kill-session', '-t', `=${options.managedTmuxSession}`]);
    } catch (error) {
      if (!confirmedMissingTmuxSession(error)) throw error;
    }
    return { ok: true };
  }
}

module.exports = { ManagedTmuxRuntime };
