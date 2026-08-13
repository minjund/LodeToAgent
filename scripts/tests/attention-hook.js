'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const {
  AttentionHookServer,
  buildOfficialHookResponse,
  normalizeHookRequest,
} = require('../../src/attentionHookServer');
const {
  AttentionHookInstaller,
  atomicWriteWithBackup,
  buildCodexHookCommands,
  codexPermissionHookHash,
  defaultPaths,
  enableCodexHooksFeature,
  findTrustedCodexHash,
  installAttentionHooks,
  isOwnClaudeHandler,
  isOwnCodexHandler,
  uninstallAttentionHooks,
} = require('../../src/attentionHookInstaller');
const {
  readBoundedJson,
  readRuntimeIdentity,
  sanitizeOfficialOutput,
} = require('../../bin/attention-permission-hook');
const { createTestHarness } = require('./harness');

const temporaryRoots = [];

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-attention-hook-'));
  temporaryRoots.push(root);
  return root;
}

function cleanup() {
  for (const root of temporaryRoots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for hook state.'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function requestJson(url, payload, options = {}) {
  const target = new URL(url);
  const body = options.rawBody === undefined ? JSON.stringify(payload) : options.rawBody;
  return new Promise((resolve, reject) => {
    const request = http.request({
      method: options.method || 'POST',
      host: target.hostname,
      port: target.port,
      path: options.path || target.pathname,
      headers: {
        ...(body !== null ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
        ...(options.headers || {}),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value;
        try { value = JSON.parse(text); } catch { value = text; }
        resolve({ statusCode: response.statusCode, headers: response.headers, value, text });
      });
    });
    request.on('error', reject);
    if (body !== null) request.end(body);
    else request.end();
  });
}

function runHookProcess(runtimeFile, payload) {
  const script = path.resolve(__dirname, '..', '..', 'bin', 'attention-permission-hook.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--runtime-file', runtimeFile, '--loadtoagent-attention-hook'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function runWindowsCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function decodePowerShellCommand(command) {
  const encoded = String(command || '').match(/-EncodedCommand ([a-z0-9+/=]+)$/iu)?.[1];
  return encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : '';
}

function countOwned(config, predicate) {
  return Object.values(config.hooks || {}).flatMap(groups => Array.isArray(groups) ? groups : [])
    .flatMap(group => Array.isArray(group?.hooks) ? group.hooks : [])
    .filter(predicate).length;
}

function fakeIdentity(runtimeFile, port = 31_337, nonce = 'a'.repeat(64)) {
  const routePath = `/loadtoagent/attention/v1/${nonce}`;
  return {
    protocol: 1,
    service: 'loadtoagent-attention-hook',
    pid: process.pid,
    host: '127.0.0.1',
    port,
    nonce,
    path: routePath,
    url: `http://127.0.0.1:${port}${routePath}`,
    runtimeFile,
  };
}

function registerAttentionHookTests(context) {
  const { test } = context;

  test('Claude 권한 요청과 AskUserQuestion을 팝업 계약으로 정규화하고 공식 응답을 만든다', () => {
    const permission = normalizeHookRequest({
      session_id: 'claude-session',
      agent_id: 'claude-child-agent',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test', description: 'Run the test suite' },
    });
    assert.equal(permission.provider, 'claude');
    assert.equal(permission.kind, 'permission');
    assert.equal(permission.responseType, 'permission-request');
    assert.equal(permission.sessionId, 'claude-session');
    assert.equal(permission.agentId, 'claude-child-agent');
    assert.equal(permission.requestIdExplicit, false);
    assert.equal(permission.toolName, 'Bash');
    assert.equal(permission.detail, 'Run the test suite');
    assert.match(permission.key, /^claude:[a-f0-9]{40}$/u);
    assert.deepEqual(buildOfficialHookResponse(permission, { action: 'allow' }), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    assert.deepEqual(buildOfficialHookResponse(permission, { action: 'deny', message: 'Not now' }), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Not now' },
      },
    });
    assert.deepEqual(buildOfficialHookResponse(permission, { action: 'none' }), {});

    const question = normalizeHookRequest({
      session_id: 'claude-question-session',
      request_id: 'question-call-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        context: 'Keep me',
        questions: [
          {
            id: 'environment', header: 'Environment', question: 'Where should this deploy?',
            options: [
              { label: 'Staging', description: 'Safe test environment' },
              { label: 'Production', description: 'Live environment' },
            ],
          },
          {
            id: 'checks', header: 'Checks', question: 'Which checks?', multiSelect: true,
            options: ['Unit', 'E2E'],
          },
        ],
      },
    }, { provider: 'claude' });
    assert.equal(question.provider, 'claude');
    assert.equal(question.kind, 'question');
    assert.equal(question.responseType, 'pre-tool-use');
    assert.equal(question.requestId, 'question-call-1');
    assert.equal(question.requestIdExplicit, true);
    assert.deepEqual(question.questions[0], {
      id: 'environment', header: 'Environment', question: 'Where should this deploy?',
      options: [
        { id: '0', label: 'Staging', value: 'Staging', description: 'Safe test environment' },
        { id: '1', label: 'Production', value: 'Production', description: 'Live environment' },
      ],
      multiSelect: false,
    });
    assert.deepEqual(buildOfficialHookResponse(question, {
      action: 'answer',
      answers: [
        { questionId: 'environment', values: ['0'] },
        { questionId: 'checks', values: ['Unit'], otherText: 'E2E', text: 'Unit' },
      ],
    }), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          context: 'Keep me',
          questions: question.toolInput.questions,
          answers: {
            'Where should this deploy?': 'Staging',
            'Which checks?': 'Unit, E2E',
          },
        },
      },
    });
    assert.throws(
      () => buildOfficialHookResponse(question, { action: 'allow', answers: { environment: 'Staging' } }),
      error => error.code === 'ATTENTION_HOOK_ANSWERS_REQUIRED',
    );
    assert.deepEqual(buildOfficialHookResponse(question, { action: 'deny', reason: 'Need more context' }), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Need more context',
      },
    });
  });

  test('localhost nonce 서버가 크기를 제한하고 중복 요청·해결·비활성화·시간초과를 안전하게 처리한다', async () => {
    const root = temporaryRoot();
    const runtimeFile = path.join(root, 'runtime', 'attention.json');
    const requests = [];
    const resolutions = [];
    const errors = [];
    const server = new AttentionHookServer({
      enabled: true,
      runtimeFile,
      maxBodyBytes: 1_024,
      requestTimeoutMs: 100,
      onRequest: request => requests.push(request),
      onResolved: event => resolutions.push(event),
      onError: error => errors.push(error),
    });
    const identity = await server.start();
    assert.equal(identity.host, '127.0.0.1');
    assert.match(identity.path, /^\/loadtoagent\/attention\/v1\/[a-f0-9]{64}$/u);
    assert.deepEqual(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).nonce, identity.nonce);
    assert.deepEqual(await server.start(), identity, 'start는 같은 런타임 identity를 재사용해야 합니다.');

    const payload = {
      session_id: 'shared', hook_event_name: 'PermissionRequest', tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    };
    const first = requestJson(identity.url, payload);
    const independent = requestJson(identity.url, payload);
    await waitFor(() => requests.length === 2 && server.getPendingRequests().length === 2);
    assert.notEqual(requests[0].key, requests[1].key, '명시 ID가 없는 동일 요청은 서로 다른 승인을 가져야 합니다.');
    assert.equal(server.resolve(requests[0].key, { action: 'allow' }), true);
    assert.equal(server.resolve(requests[1].key, { action: 'deny' }), true);
    const [firstResult, independentResult] = await Promise.all([first, independent]);
    assert.equal(firstResult.statusCode, 200);
    assert.equal(firstResult.value.hookSpecificOutput.decision.behavior, 'allow');
    assert.equal(independentResult.value.hookSpecificOutput.decision.behavior, 'deny');
    assert.equal(resolutions.length, 2);

    const explicit = { ...payload, request_id: 'same-explicit-request' };
    const retransmitOne = requestJson(identity.url, explicit);
    const retransmitTwo = requestJson(identity.url, explicit);
    await waitFor(() => requests.length === 3 && server.getPendingRequests().length === 1);
    assert.equal(server.resolve(requests[2].key, { action: 'allow' }), true);
    const retransmitResults = await Promise.all([retransmitOne, retransmitTwo]);
    assert.deepEqual(retransmitResults[0].value, retransmitResults[1].value);

    const pending = requestJson(identity.url, { ...payload, request_id: 'disable-me' });
    await waitFor(() => server.getPendingRequests().length === 1);
    assert.equal(server.setEnabled(false), false);
    assert.deepEqual((await pending).value, {});
    assert.equal(resolutions.at(-1).reason, 'disabled');
    const requestCount = requests.length;
    assert.deepEqual((await requestJson(identity.url, { ...payload, request_id: 'while-disabled' })).value, {});
    assert.equal(requests.length, requestCount, '꺼진 상태에서는 UI 요청을 만들면 안 됩니다.');

    server.setEnabled(true);
    const timeout = requestJson(identity.url, { ...payload, request_id: 'timeout-me' });
    await waitFor(() => server.getPendingRequests().length === 1);
    assert.deepEqual((await timeout).value, {});
    assert.equal(resolutions.at(-1).reason, 'timeout');

    assert.equal((await requestJson(identity.url, {}, { path: '/wrong' })).statusCode, 404);
    assert.equal((await requestJson(identity.url, null, { method: 'GET', rawBody: null })).statusCode, 405);
    assert.equal((await requestJson(identity.url, null, { rawBody: '{nope' })).statusCode, 400);
    assert.equal((await requestJson(identity.url, null, { rawBody: JSON.stringify({ value: 'x'.repeat(2_000) }) })).statusCode, 413);
    assert.deepEqual(errors, []);
    await server.dispose();
    assert.equal(fs.existsSync(runtimeFile), false, '자신이 쓴 런타임 identity만 정리해야 합니다.');
  });

  test('동적 설정이 꺼져 있거나 콜백이 실패하면 공식 no-decision으로 즉시 복귀한다', async () => {
    const root = temporaryRoot();
    let externallyEnabled = false;
    const errors = [];
    const requests = [];
    const server = new AttentionHookServer({
      enabled: true,
      getEnabled: () => externallyEnabled,
      runtimeFile: path.join(root, 'runtime.json'),
      onRequest(request) {
        requests.push(request);
        throw new Error('renderer unavailable');
      },
      onError: error => errors.push(error.message),
    });
    const identity = await server.start();
    const payload = {
      session_id: 'dynamic', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {},
    };
    assert.deepEqual((await requestJson(identity.url, payload)).value, {});
    assert.equal(requests.length, 0);
    externallyEnabled = true;
    assert.deepEqual((await requestJson(identity.url, payload)).value, {});
    assert.equal(requests.length, 1);
    assert.deepEqual(errors, ['renderer unavailable']);
    await server.dispose();
  });

  test('Codex PreToolUse/request_user_input은 비지원 공식 경로라 팝업을 만들지 않고 즉시 no-decision한다', async () => {
    const root = temporaryRoot();
    const requests = [];
    const server = new AttentionHookServer({
      enabled: true,
      runtimeFile: path.join(root, 'runtime.json'),
      onRequest: request => requests.push(request),
    });
    const identity = await server.start();
    const result = await requestJson(identity.url, {
      session_id: 'codex-question', hook_event_name: 'PreToolUse', tool_name: 'request_user_input',
      tool_input: { questions: [{ id: 'q', question: 'Choose?', options: [{ label: 'A' }] }] },
    }, { headers: { 'X-LoadToAgent-Provider': 'codex' } });
    assert.deepEqual(result.value, {});
    assert.deepEqual(requests, []);
    const direct = normalizeHookRequest({
      hook_event_name: 'PreToolUse', tool_name: 'request_user_input',
      tool_input: { questions: [{ id: 'q', question: 'Choose?', options: [{ label: 'A' }] }] },
    }, { provider: 'codex' });
    assert.deepEqual(buildOfficialHookResponse(direct, { action: 'allow', answer: 'A' }), {});
    await server.dispose();
  });

  test('Codex 명령 훅이 런타임 identity로 원문을 POST하고 정제된 공식 응답만 stdout에 쓴다', async () => {
    const root = temporaryRoot();
    let observed;
    const server = new AttentionHookServer({
      enabled: true,
      runtimeFile: path.join(root, 'attention.json'),
      onRequest(request) {
        observed = request;
        return { action: 'allow', updatedInput: { command: 'npm run test:safe' } };
      },
    });
    await server.start();
    const result = await runHookProcess(server.runtimeFile, {
      session_id: 'codex-hook', hook_event_name: 'PermissionRequest', tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    assert.equal(observed.provider, 'codex');
    assert.equal(observed.sessionId, 'codex-hook');

    const fallback = await runHookProcess(path.join(root, 'missing.json'), { hello: 'world' });
    assert.equal(fallback.code, 0);
    assert.equal(fallback.stderr, '');
    assert.deepEqual(JSON.parse(fallback.stdout), {});
    await server.dispose();
  });

  test('명령 훅 입력·런타임·출력을 제한하고 알려진 공식 필드 외에는 버린다', async () => {
    assert.deepEqual(sanitizeOfficialOutput({ arbitrary: 'context injection' }), {});
    assert.deepEqual(sanitizeOfficialOutput({
      ignored: 'remove me',
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        extra: 'remove me',
        decision: {
          behavior: 'deny', message: 'No\u0000pe', extra: 'remove me',
          updatedInput: { must: 'not survive deny' },
        },
      },
    }), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Nope' },
      },
    });
    assert.deepEqual(sanitizeOfficialOutput({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'allow', extra: true,
        updatedInput: { questions: [], answers: { Framework: 'React' } },
      },
    }), {});

    const oversized = Readable.from([Buffer.alloc(50), Buffer.alloc(51)]);
    await assert.rejects(readBoundedJson(oversized, 100), error => error.code === 'ATTENTION_HOOK_INPUT_TOO_LARGE');

    const root = temporaryRoot();
    const file = path.join(root, 'runtime.json');
    fs.writeFileSync(file, JSON.stringify({
      ...fakeIdentity(file), host: 'example.com',
    }));
    assert.throws(() => readRuntimeIdentity(file), /Invalid attention hook runtime identity/u);
    fs.writeFileSync(file, JSON.stringify({
      ...fakeIdentity(file), path: `/loadtoagent/attention/v1/${'b'.repeat(64)}`,
    }));
    assert.throws(() => readRuntimeIdentity(file), /Invalid attention hook runtime identity/u);
  });

  test('설치기가 외부 훅을 보존하며 자체 HTTP/command 훅만 원자적으로 설치·갱신·삭제한다', () => {
    const root = temporaryRoot();
    const claudeSettingsPath = path.join(root, '.claude', 'settings.json');
    const codexHooksPath = path.join(root, '.codex', 'hooks.json');
    const codexConfigPath = path.join(root, '.codex', 'config.toml');
    const runtimeFile = path.join(root, '.loadtoagent', 'attention.json');
    fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
    fs.mkdirSync(path.dirname(codexHooksPath), { recursive: true });
    const foreignClaude = { type: 'command', command: 'foreign-claude-hook', timeout: 10 };
    const foreignCodex = { type: 'command', command: 'foreign-codex-hook', timeout: 30 };
    const claudeOriginal = `${JSON.stringify({
      permissions: { deny: ['Read(.env)'] },
      hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [foreignClaude] }] },
      foreignTopLevel: { keep: true },
    }, null, 4)}\n`;
    const codexOriginal = `${JSON.stringify({
      description: 'foreign hooks',
      hooks: {
        SessionStart: [{ hooks: [foreignCodex] }],
        PreToolUse: [{
          matcher: 'request_user_input',
          hooks: [{ type: 'command', command: 'node stale-hook.js --loadtoagent-attention-hook' }],
        }],
      },
      foreignTopLevel: ['keep'],
    }, null, 2)}\n`;
    const configOriginal = 'model = "gpt-test"\r\n\r\n[projects.demo]\r\ntrust_level = "trusted"\r\n';
    fs.writeFileSync(claudeSettingsPath, claudeOriginal);
    fs.writeFileSync(codexHooksPath, codexOriginal);
    fs.writeFileSync(codexConfigPath, configOriginal);

    const hookScriptPath = path.resolve(root, 'LoadToAgent resources', 'attention-permission-hook.js');
    const common = {
      claudeSettingsPath, codexHooksPath, codexConfigPath, hookScriptPath,
      nodeExecutable: process.execPath,
    };
    const firstIdentity = fakeIdentity(runtimeFile);
    const first = installAttentionHooks({ ...common, identity: firstIdentity });
    assert.equal(first.action, 'install');
    assert.equal(first.changed, true);
    assert.equal(first.feature.enabled, true);
    assert.equal(first.feature.state, 'enabled');
    const installedWindowsCommand = JSON.parse(
      fs.readFileSync(codexHooksPath, 'utf8'),
    ).hooks.PermissionRequest.at(-1).hooks[0].commandWindows;
    const installedEncoded = installedWindowsCommand.match(/-EncodedCommand ([a-z0-9+/=]+)$/iu)?.[1];
    assert.ok(installedEncoded, '설치된 Windows hook은 encoded PowerShell 명령이어야 합니다.');
    assert.match(
      Buffer.from(installedEncoded, 'base64').toString('utf16le'),
      new RegExp(runtimeFile.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&'), 'u'),
      'start() identity의 runtimeFile을 명령 훅에 직접 사용해야 합니다.',
    );
    assert.equal(fs.readFileSync(first.files.claude.backupPath, 'utf8'), claudeOriginal);
    assert.equal(fs.readFileSync(first.files.codexHooks.backupPath, 'utf8'), codexOriginal);
    assert.equal(fs.readFileSync(first.files.codexConfig.backupPath, 'utf8'), configOriginal);

    const claudeInstalled = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    const codexInstalled = JSON.parse(fs.readFileSync(codexHooksPath, 'utf8'));
    assert.deepEqual(claudeInstalled.permissions, { deny: ['Read(.env)'] });
    assert.deepEqual(claudeInstalled.foreignTopLevel, { keep: true });
    assert.deepEqual(claudeInstalled.hooks.PermissionRequest[0].hooks[0], foreignClaude);
    assert.equal(countOwned(claudeInstalled, isOwnClaudeHandler), 2);
    assert.deepEqual(codexInstalled.description, 'foreign hooks');
    assert.deepEqual(codexInstalled.foreignTopLevel, ['keep']);
    assert.deepEqual(codexInstalled.hooks.SessionStart[0].hooks[0], foreignCodex);
    assert.equal(countOwned(codexInstalled, isOwnCodexHandler), 1);
    assert.equal(
      (codexInstalled.hooks.PreToolUse || []).flatMap(group => group.hooks || []).some(isOwnCodexHandler),
      false,
      '기존 Codex request_user_input용 비공식 PreToolUse 훅도 제거해야 합니다.',
    );
    const ownCodex = Object.values(codexInstalled.hooks).flatMap(groups => groups)
      .flatMap(group => group.hooks).find(isOwnCodexHandler);
    assert.match(decodePowerShellCommand(ownCodex.command), /--loadtoagent-attention-hook/u);
    assert.match(decodePowerShellCommand(ownCodex.commandWindows), /--loadtoagent-attention-hook/u);
    const configInstalled = fs.readFileSync(codexConfigPath, 'utf8');
    assert.match(configInstalled, /\[features\]\r\nhooks = true\r\n/u);
    assert.match(configInstalled, /\[projects\.demo\]\r\ntrust_level = "trusted"/u);
    assert.equal(first.review.required, false);
    assert.equal(first.review.state, 'trusted');
    assert.equal(first.warnings.some(warning => /Codex \/hooks/u.test(warning)), false);

    const second = installAttentionHooks({ ...common, identity: firstIdentity });
    assert.equal(second.changed, false, '동일 identity 재설치는 파일을 다시 쓰면 안 됩니다.');
    assert.equal(second.files.claude.backupPath, null);
    assert.equal(second.files.codexHooks.backupPath, null);
    assert.equal(second.files.codexConfig.backupPath, null);
    assert.equal(second.review.state, 'trusted', '재시작 후에도 자동 등록한 Codex 신뢰가 유지되어야 합니다.');
    assert.equal(second.warnings.some(warning => /Codex \/hooks/u.test(warning)), false);

    const ownGroup = codexInstalled.hooks.PermissionRequest.find(group => group.hooks.some(isOwnCodexHandler));
    const ownHandler = ownGroup.hooks.find(isOwnCodexHandler);
    const trustedHash = codexPermissionHookHash(ownGroup, ownHandler, process.platform);
    assert.equal(findTrustedCodexHash(configInstalled, first.review.key, process.platform), trustedHash);
    const withLaterForeignGroup = JSON.parse(fs.readFileSync(codexHooksPath, 'utf8'));
    withLaterForeignGroup.hooks.PermissionRequest.push({ hooks: [{ type: 'command', command: 'foreign-later-hook' }] });
    fs.writeFileSync(codexHooksPath, `${JSON.stringify(withLaterForeignGroup, null, 2)}\n`);
    const afterForeignAppend = installAttentionHooks({ ...common, identity: firstIdentity });
    assert.equal(afterForeignAppend.review.state, 'trusted', '뒤에 추가된 외부 훅 때문에 자체 훅 위치를 옮겨 신뢰를 잃으면 안 됩니다.');
    const trustedConfig = fs.readFileSync(codexConfigPath, 'utf8');

    const secondIdentity = fakeIdentity(runtimeFile, 31_338, 'b'.repeat(64));
    const updated = installAttentionHooks({ ...common, identity: secondIdentity });
    assert.equal(updated.files.claude.changed, true);
    assert.equal(updated.files.codexHooks.changed, false, 'Codex command는 고정 runtime 파일을 읽으므로 서버 포트 갱신에 불변이어야 합니다.');
    assert.equal(updated.files.codexConfig.changed, false);
    assert.equal(updated.review.state, 'trusted');
    const claudeUpdated = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    const ownUrls = Object.values(claudeUpdated.hooks).flatMap(groups => groups)
      .flatMap(group => group.hooks).filter(isOwnClaudeHandler).map(handler => handler.url);
    assert.deepEqual(ownUrls, [secondIdentity.url, secondIdentity.url]);

    const removed = uninstallAttentionHooks(common);
    assert.equal(removed.changed, true);
    const claudeRemoved = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    const codexRemoved = JSON.parse(fs.readFileSync(codexHooksPath, 'utf8'));
    assert.equal(countOwned(claudeRemoved, isOwnClaudeHandler), 0);
    assert.equal(countOwned(codexRemoved, isOwnCodexHandler), 0);
    assert.deepEqual(claudeRemoved.hooks.PermissionRequest[0].hooks[0], foreignClaude);
    assert.deepEqual(codexRemoved.hooks.SessionStart[0].hooks[0], foreignCodex);
    assert.equal(
      codexRemoved.hooks.PermissionRequest.flatMap(group => group.hooks).some(handler => handler.command === 'foreign-later-hook'),
      true,
    );
    assert.equal(fs.readFileSync(codexConfigPath, 'utf8'), trustedConfig, '제거 시 공유 feature/trust state는 보존해야 합니다.');
    assert.equal(uninstallAttentionHooks(common).changed, false, '반복 제거는 byte-for-byte no-op이어야 합니다.');
  });

  test('Codex 신뢰 해시는 install 변경 여부와 무관하게 지속 판정하고 Windows 경로 대소문자를 무시한다', () => {
    const officialWindowsFixture = {
      hooks: [{
        type: 'command',
        command: '"/mnt/c/Program Files/nodejs/node.exe" "C:/Users/wincubeDevTeam/AppData/Local/Programs/Clawd on Desk/resources/app.asar.unpacked/hooks/codex-hook.js" --clawd-wsl-interop',
        commandWindows: '& "C:\\Program Files\\nodejs\\node.exe" "C:/Users/wincubeDevTeam/AppData/Local/Programs/Clawd on Desk/resources/app.asar.unpacked/hooks/codex-hook.js"',
        timeout: 600,
      }],
    };
    assert.equal(
      codexPermissionHookHash(officialWindowsFixture, officialWindowsFixture.hooks[0], 'win32'),
      'sha256:210b1243fc5c4269e9379fe91ab2e2f298a9dfa533c2f1b80120ddcccd70182e',
      '실제 Codex /hooks가 저장한 Windows PermissionRequest trusted_hash와 일치해야 합니다.',
    );
    const root = temporaryRoot();
    const paths = {
      claudeSettingsPath: path.join(root, 'claude', 'settings.json'),
      codexHooksPath: path.join(root, 'CodexHome', 'hooks.json'),
      codexConfigPath: path.join(root, 'CodexHome', 'config.toml'),
      runtimeFile: path.join(root, 'runtime.json'),
      hookScriptPath: path.join(root, 'hook.js'),
      nodeExecutable: path.join(root, 'LoadToAgent.exe'),
      platform: 'win32',
    };
    fs.mkdirSync(path.dirname(paths.codexHooksPath), { recursive: true });
    fs.writeFileSync(paths.codexConfigPath, '[features]\nhooks = true\n');

    const first = installAttentionHooks({ ...paths, identity: fakeIdentity(paths.runtimeFile) });
    assert.equal(first.review.state, 'trusted');
    const installed = JSON.parse(fs.readFileSync(paths.codexHooksPath, 'utf8'));
    const group = installed.hooks.PermissionRequest.find(candidate => candidate.hooks.some(isOwnCodexHandler));
    const handler = group.hooks.find(isOwnCodexHandler);
    const hash = codexPermissionHookHash(group, handler, 'win32');
    const differentlyCasedKey = first.review.key.toLowerCase();
    const trustedSource = fs.readFileSync(paths.codexConfigPath, 'utf8');
    fs.writeFileSync(paths.codexConfigPath, trustedSource
      .replace(JSON.stringify(first.review.key), JSON.stringify(differentlyCasedKey))
      .replace(hash, `sha256:${'0'.repeat(64)}`));

    const repaired = installAttentionHooks({ ...paths, identity: fakeIdentity(paths.runtimeFile) });
    assert.equal(repaired.changed, true, '대소문자가 다른 기존 state의 신뢰 해시는 제자리에서 복구해야 합니다.');
    assert.deepEqual(repaired.review, { required: false, state: 'trusted', key: first.review.key });
    assert.equal(
      findTrustedCodexHash(fs.readFileSync(paths.codexConfigPath, 'utf8'), first.review.key, 'win32'),
      hash,
    );

    const stable = installAttentionHooks({ ...paths, identity: fakeIdentity(paths.runtimeFile) });
    assert.equal(stable.changed, false);
    assert.equal(stable.review.state, 'trusted');
    assert.equal(stable.warnings.some(warning => /Codex \/hooks/u.test(warning)), false);
  });

  test('설치기는 Clawd와 일반 외부 훅을 보존하고 별도 설정 경고 없이 즉시 활성화한다', () => {
    const root = temporaryRoot();
    const paths = {
      claudeSettingsPath: path.join(root, 'known', 'claude.json'),
      codexHooksPath: path.join(root, 'known', 'hooks.json'),
      codexConfigPath: path.join(root, 'known', 'config.toml'),
      runtimeFile: path.join(root, 'runtime.json'),
      hookScriptPath: path.join(root, 'hook.js'),
      nodeExecutable: process.execPath,
    };
    fs.mkdirSync(path.dirname(paths.claudeSettingsPath), { recursive: true });
    const clawdClaude = { type: 'http', url: 'http://127.0.0.1:23333/permission', timeout: 600 };
    const clawdCodex = {
      type: 'command',
      command: "node '/mnt/c/Program Files/Clawd on Desk/resources/app.asar.unpacked/hooks/codex-hook.js'",
      commandWindows: "node 'C:\\Program Files\\Clawd on Desk\\resources\\app.asar.unpacked\\hooks\\codex-hook.js'",
    };
    fs.writeFileSync(paths.claudeSettingsPath, JSON.stringify({
      hooks: { PermissionRequest: [{ hooks: [clawdClaude] }] },
    }));
    fs.writeFileSync(paths.codexHooksPath, JSON.stringify({
      hooks: { PermissionRequest: [{ hooks: [clawdCodex] }] },
    }));
    fs.writeFileSync(paths.codexConfigPath, '[features]\nhooks = true\n');
    const installed = installAttentionHooks({ ...paths, identity: fakeIdentity(paths.runtimeFile) });
    assert.equal(installed.review.state, 'trusted');
    assert.deepEqual(installed.warnings, []);
    uninstallAttentionHooks(paths);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.claudeSettingsPath, 'utf8')).hooks.PermissionRequest[0].hooks[0], clawdClaude);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.codexHooksPath, 'utf8')).hooks.PermissionRequest[0].hooks[0], clawdCodex);

    const generic = {
      ...paths,
      claudeSettingsPath: path.join(root, 'generic', 'claude.json'),
      codexHooksPath: path.join(root, 'generic', 'hooks.json'),
      codexConfigPath: path.join(root, 'generic', 'config.toml'),
    };
    fs.mkdirSync(path.dirname(generic.claudeSettingsPath), { recursive: true });
    fs.writeFileSync(generic.claudeSettingsPath, JSON.stringify({
      hooks: { PermissionRequest: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:23333/log' }] }] },
    }));
    fs.writeFileSync(generic.codexHooksPath, JSON.stringify({
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'node permission-logger.js' }] }] },
    }));
    fs.writeFileSync(generic.codexConfigPath, '[features]\nhooks = true\n');
    const genericInstalled = installAttentionHooks({ ...generic, identity: fakeIdentity(generic.runtimeFile) });
    assert.equal(genericInstalled.warnings.some(warning => /Both apps|already has an interactive/u.test(warning)), false);
  });

  test('LoadToAgent 전용 config backup만 파일별 최근 3개를 남기고 사용자 backup은 보존한다', () => {
    const root = temporaryRoot();
    const file = path.join(root, 'settings.json');
    const userBackup = `${file}.user-backup`;
    const foreignLookalike = `${file}.loadtoagent-backup-manual`;
    fs.writeFileSync(file, '{"revision":0}\n');
    fs.writeFileSync(userBackup, 'user');
    fs.writeFileSync(foreignLookalike, 'foreign');

    let previous = fs.readFileSync(file, 'utf8');
    for (let revision = 1; revision <= 8; revision += 1) {
      const next = `${JSON.stringify({ revision })}\n`;
      atomicWriteWithBackup(file, next, previous);
      previous = next;
    }
    const ownBackups = fs.readdirSync(root).filter(name => (
      /^settings\.json\.loadtoagent-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/u.test(name)
    ));
    assert.equal(ownBackups.length, 3);
    assert.equal(fs.readFileSync(userBackup, 'utf8'), 'user');
    assert.equal(fs.readFileSync(foreignLookalike, 'utf8'), 'foreign');
  });

  test('설치기는 명시적인 Codex hooks=false와 누락 파일을 보존하고 잘못된 JSON을 부분 적용하지 않는다', () => {
    const root = temporaryRoot();
    const paths = {
      claudeSettingsPath: path.join(root, 'claude.json'),
      codexHooksPath: path.join(root, 'hooks.json'),
      codexConfigPath: path.join(root, 'config.toml'),
      runtimeFile: path.join(root, 'runtime.json'),
      hookScriptPath: path.join(root, 'hook.js'),
      nodeExecutable: process.execPath,
    };
    const missingClaude = paths.claudeSettingsPath;
    const missingCodex = paths.codexHooksPath;
    const installer = new AttentionHookInstaller(paths);
    const removed = installer.uninstall();
    assert.equal(removed.changed, false);
    assert.equal(fs.existsSync(missingClaude), false);
    assert.equal(fs.existsSync(missingCodex), false);

    fs.writeFileSync(paths.codexConfigPath, '[features]\nhooks = false # user policy\n');
    const installed = installer.install(fakeIdentity(paths.runtimeFile));
    assert.equal(installed.feature.enabled, false);
    assert.equal(installed.feature.state, 'explicitly-disabled');
    assert.equal(installed.review.state, 'disabled');
    assert.equal(installed.files.codexConfig.changed, false);
    assert.match(installed.warnings[0], /preserved/u);
    assert.equal(fs.readFileSync(paths.codexConfigPath, 'utf8'), '[features]\nhooks = false # user policy\n');
    assert.equal(fs.readFileSync(paths.codexConfigPath, 'utf8').includes('[hooks.state.'), false);

    uninstallAttentionHooks(paths);
    const claudeBefore = '{"hooks":{}}\n';
    const invalidCodex = '{ invalid';
    fs.writeFileSync(paths.claudeSettingsPath, claudeBefore);
    fs.writeFileSync(paths.codexHooksPath, invalidCodex);
    assert.throws(
      () => installAttentionHooks({ ...paths, identity: fakeIdentity(paths.runtimeFile, 31_339, 'c'.repeat(64)) }),
      error => error.code === 'ATTENTION_HOOK_INVALID_JSON_CONFIG',
    );
    assert.equal(fs.readFileSync(paths.claudeSettingsPath, 'utf8'), claudeBefore, '모든 파일 검증 전에 부분 쓰기하면 안 됩니다.');
    assert.equal(fs.readFileSync(paths.codexHooksPath, 'utf8'), invalidCodex);
  });

  test('Codex feature 편집과 cross-platform command 생성이 기존 TOML/경로를 손상하지 않는다', async () => {
    assert.deepEqual(enableCodexHooksFeature('[features]\nhooks = true\n'), {
      source: '[features]\nhooks = true\n', changed: false, enabled: true, state: 'already-enabled',
    });
    assert.deepEqual(enableCodexHooksFeature('[features]\nhooks = false\n'), {
      source: '[features]\nhooks = false\n', changed: false, enabled: false, state: 'explicitly-disabled',
    });
    assert.deepEqual(enableCodexHooksFeature('["features"]\n"hooks" = false\n'), {
      source: '["features"]\n"hooks" = false\n', changed: false, enabled: false, state: 'explicitly-disabled',
    });
    assert.deepEqual(enableCodexHooksFeature('features = { hooks = false, shell_tool = true }\n'), {
      source: 'features = { hooks = false, shell_tool = true }\n',
      changed: false, enabled: false, state: 'explicitly-disabled',
    });
    assert.deepEqual(enableCodexHooksFeature('features.hooks = false\n'), {
      source: 'features.hooks = false\n', changed: false, enabled: false, state: 'explicitly-disabled',
    });
    assert.deepEqual(enableCodexHooksFeature('features = { shell_tool = true }\n'), {
      source: 'features = { shell_tool = true }\n', changed: false, enabled: false, state: 'unrecognized-value',
    });
    assert.equal(
      enableCodexHooksFeature('[features]\nshell_tool = true\n\n[[model_providers]]\nname = "x"\n').source,
      '[features]\nshell_tool = true\n\nhooks = true\n[[model_providers]]\nname = "x"\n',
    );
    assert.equal(
      enableCodexHooksFeature('[features]\nmodels = [\n  ["a", "b"],\n]\n\n[tui]\ncolor = true\n').source,
      '[features]\nmodels = [\n  ["a", "b"],\n]\n\nhooks = true\n[tui]\ncolor = true\n',
    );
    const inserted = enableCodexHooksFeature('\ufeffmodel = "gpt"\r\n\r\n[features]\r\nflag = true\r\n\r\n[tui]\r\ncolor = true\r\n');
    assert.equal(inserted.enabled, true);
    assert.match(inserted.source, /^\ufeffmodel = "gpt"/u);
    assert.match(inserted.source, /flag = true\r\n\r\nhooks = true\r\n\[tui\]/u);
    const customHome = temporaryRoot();
    const claudeConfig = path.join(customHome, 'claude-config');
    const codexHome = path.join(customHome, 'codex-home');
    const configured = defaultPaths(customHome, {
      CLAUDE_CONFIG_DIR: claudeConfig,
      CODEX_HOME: codexHome,
    });
    assert.equal(configured.claudeSettingsPath, path.join(claudeConfig, 'settings.json'));
    assert.equal(configured.codexHooksPath, path.join(codexHome, 'hooks.json'));
    assert.equal(configured.codexConfigPath, path.join(codexHome, 'config.toml'));
    const commands = buildCodexHookCommands({
      nodeExecutable: 'C:\\Program Files\\LoadToAgent\\LoadToAgent.exe',
      hookScriptPath: 'C:\\Program Files\\LoadToAgent\\resources\\hook.js',
      runtimeFile: 'C:\\Users\\tester\\.loadtoagent\\attention.json',
      platform: 'win32',
    });
    assert.match(commands.command, /^powershell\.exe /u);
    assert.equal(commands.commandWindows, commands.command);
    const encoded = commands.commandWindows.match(/-EncodedCommand ([a-z0-9+/=]+)$/iu)?.[1];
    assert.ok(encoded, 'Windows hook command must carry an encoded PowerShell payload.');
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.match(decoded, /^\$env:ELECTRON_RUN_AS_NODE='1'; & /u);
    assert.match(decoded, /Program Files/u);
    assert.match(decoded, /--loadtoagent-attention-hook$/u);

    if (process.platform === 'win32') {
      const smokeRoot = path.join(temporaryRoot(), "cmd hook fixture's");
      const hookScriptPath = path.join(smokeRoot, 'hook script.js');
      const outputPath = path.join(smokeRoot, 'hook output.json');
      fs.mkdirSync(smokeRoot, { recursive: true });
      fs.writeFileSync(hookScriptPath, [
        "'use strict';",
        "const fs = require('fs');",
        "const outputIndex = process.argv.indexOf('--runtime-file') + 1;",
        "fs.writeFileSync(process.argv[outputIndex], JSON.stringify({",
        "  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,",
        "  marker: process.argv.includes('--loadtoagent-attention-hook'),",
        '}));',
      ].join('\n'));
      const smokeCommands = buildCodexHookCommands({
        nodeExecutable: process.execPath,
        hookScriptPath,
        runtimeFile: outputPath,
        platform: 'win32',
      });
      const smoke = await runWindowsCommand(smokeCommands.commandWindows);
      assert.equal(smoke.code, 0, smoke.stderr || smoke.stdout);
      assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), {
        electronRunAsNode: '1', marker: true,
      });
    }
    const posix = buildCodexHookCommands({
      nodeExecutable: '/opt/LoadToAgent/LoadToAgent',
      hookScriptPath: '/opt/LoadToAgent/hook.js',
      runtimeFile: '/home/tester/.loadtoagent/attention.json',
      platform: 'linux',
    });
    assert.match(posix.command, /^ELECTRON_RUN_AS_NODE=1 /u);
  });
}

if (require.main === module) {
  const harness = createTestHarness();
  registerAttentionHookTests(harness);
  harness.run({ cleanup });
}

module.exports = { registerAttentionHookTests };
