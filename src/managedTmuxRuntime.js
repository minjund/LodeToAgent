'use strict';

const { execFileSync } = require('child_process');

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

  stop(options) {
    try {
      this.execute(options, ['kill-session', '-t', `=${options.managedTmuxSession}`]);
    } catch (error) {
      if (error?.status !== 1) throw error;
    }
    return { ok: true };
  }
}

module.exports = { ManagedTmuxRuntime };
