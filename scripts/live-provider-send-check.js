'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveWindowsCommand } = require('../src/terminalManager');

const ANSI_PATTERN = [
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*)?\\u0007)',
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
].join('');

function plainText(value) {
  return String(value || '')
    .replace(new RegExp(ANSI_PATTERN, 'g'), '')
    .replace(/\r/g, '');
}

function providerArgs(provider, marker) {
  const prompt = `Reply with exactly ${marker} and nothing else. Do not use tools or modify files.`;
  if (provider === 'claude') {
    return ['--print', '--no-session-persistence', '--tools', '', '--output-format', 'text', prompt];
  }
  if (provider === 'codex') {
    return [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      prompt,
    ];
  }
  throw new Error(`지원하지 않는 실제 전송 점검 대상입니다: ${provider}`);
}

function powershellExecutable() {
  const modern = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return fs.existsSync(modern) ? modern : 'powershell.exe';
}

function providerLaunch(provider, marker) {
  const command = resolveWindowsCommand(provider);
  const args = providerArgs(provider, marker);
  if (process.platform === 'win32' && path.extname(command).toLowerCase() === '.ps1') {
    return {
      file: powershellExecutable(),
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
    };
  }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/D', '/S', '/C', command, ...args],
    };
  }
  return { file: command, args };
}

async function verifyProvider(provider, timeoutMs = 45_000) {
  const marker = `WHITEBOX_${provider.toUpperCase()}_SEND_OK`;
  const launch = providerLaunch(provider, marker);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const child = spawn(launch.file, launch.args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${provider} 실제 전송 확인 시간이 ${timeoutMs / 1_000}초를 넘었습니다.`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });
    child.once('error', error => finish(error));
    child.once('exit', code => {
      const text = plainText(output);
      if (code === 0 && text.includes(marker)) {
        finish(null, {
          provider,
          marker,
          elapsedMs: Date.now() - startedAt,
        });
        return;
      }
      const tail = text.trim().slice(-800);
      finish(new Error(`${provider} 실제 전송이 종료 코드 ${code}로 실패했습니다.${tail ? `\n${tail}` : ''}`));
    });
  });
}

async function main() {
  const providers = process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'codex'];
  const results = [];
  for (const provider of providers) results.push(await verifyProvider(String(provider).toLowerCase()));
  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { plainText, providerArgs, providerLaunch, verifyProvider };
