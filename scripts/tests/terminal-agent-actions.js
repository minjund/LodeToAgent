'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function registerTerminalAgentActionTests(context) {
  const { test, root } = context;

  test('대화창 Enter 전송은 숨겨진 일회성 프로세스 대신 지속형 관리 터미널을 만든다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    let launchOptions = null;
    let launchArgsCall = null;
    let workbenchOpened = false;
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            launchOptions = options;
            return {
              id: 'terminal:managed-resume',
              type: 'agent',
              provider: options.provider,
              status: 'running',
              pid: 4242,
              title: options.title,
            };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      $: () => null,
      state: {
        snapshot: null,
        sessions: [],
        platform: { id: 'win32' },
        wslDistros: [],
      },
      init: async () => {},
      notice: () => {},
      moveWorkbench: () => { workbenchOpened = true; },
      selectTmux: async () => {},
      selectSession: async () => {},
      bindAgent: () => {},
      queueHistoryRefresh: () => {},
      renderTarget: () => {},
      fitEntry: () => {},
      refreshSessions: async () => {},
      resumeSupport: () => ({
        supported: true,
        provider: 'claude',
        sessionId: 'session-123',
        args: ['--resume', 'session-123'],
      }),
      resumeLaunchArgs: (support, prompt, options) => {
        launchArgsCall = { support, prompt, options };
        return [...support.args, prompt];
      },
      preferredWorkspace: () => 'D:\\workspace',
      providerLabel: provider => provider,
      esc: value => String(value),
    });

    const result = await actions.resumeForAgent({
      id: 'claude:session-123',
      provider: 'claude',
      externalId: 'session-123',
      cwd: 'D:\\workspace',
      runtimePresence: [],
    }, '? 안되는데?', true, { focus: false });

    assert.deepStrictEqual(launchArgsCall.options, undefined);
    assert.equal(launchArgsCall.prompt, '? 안되는데?');
    assert.equal(launchOptions.transient, false);
    assert.deepStrictEqual(Array.from(launchOptions.args), ['--resume', 'session-123', '? 안되는데?']);
    assert.equal(result.background, true);
    assert.equal(result.promptSent, true);
    assert.equal(workbenchOpened, false, '백그라운드 전송은 터미널 화면을 강제로 열지 않아야 합니다.');
  });

  test('느린 수신 확인 중 다시 보내도 같은 Claude 터미널을 재사용한다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    let created = 0;
    const commands = [];
    const state = {
      snapshot: null,
      sessions: [{
        id: 'terminal:existing',
        type: 'agent',
        provider: 'claude',
        bridgeId: 'claude:session-123',
        status: 'running',
        title: 'Claude existing',
        pid: 4242,
      }],
      platform: { id: 'win32' },
      wslDistros: [],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCommand: async (id, prompt) => {
            commands.push([id, prompt]);
            return { ok: true };
          },
          terminalCreate: async () => {
            created += 1;
            return { id: 'terminal:new' };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      $: () => null,
      state,
      init: async () => {},
      notice: () => {},
      moveWorkbench: () => {},
      selectTmux: async () => {},
      selectSession: async () => {},
      bindAgent: () => {},
      queueHistoryRefresh: () => {},
      renderTarget: () => {},
      fitEntry: () => {},
      refreshSessions: async () => {},
      resumeSupport: () => ({
        supported: true,
        provider: 'claude',
        sessionId: 'session-123',
        args: ['--resume', 'session-123'],
      }),
      resumeLaunchArgs: support => support.args,
      preferredWorkspace: () => 'D:\\workspace',
      providerLabel: provider => provider,
      esc: value => String(value),
    });

    const result = await actions.resumeForAgent({
      id: 'claude:session-123',
      provider: 'claude',
      externalId: 'session-123',
      cwd: 'D:\\workspace',
      runtimePresence: [],
    }, '중복 없이 이어서 보내줘', true, { focus: false });

    assert.deepStrictEqual(commands, [['terminal:existing', '중복 없이 이어서 보내줘']]);
    assert.equal(created, 0);
    assert.equal(result.reused, true);
    assert.equal(result.promptSent, true);
  });

  test('대화 응답 중단은 연결된 terminal과 tmux에 Ctrl+C를 전달하고 세션을 유지한다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const terminalSignals = [];
    const tmuxKeys = [];
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalSignal: async (id, signal) => {
            terminalSignals.push([id, signal]);
            return { ok: true };
          },
          tmuxSendKey: async options => {
            tmuxKeys.push(options);
            return { ok: true };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state: { snapshot: null, sessions: [] },
      init: async () => {},
      notice: () => {},
    });

    await actions.interruptAgent({
      id: 'terminal-main',
      kind: 'terminal',
      label: 'Claude terminal',
      terminalId: 'terminal-main',
    });
    await actions.interruptAgent({
      id: 'tmux:FixtureLinux:%7',
      kind: 'tmux',
      label: 'Claude tmux',
      distro: 'FixtureLinux',
      paneNativeId: '%7',
    });

    assert.deepStrictEqual(terminalSignals, [['terminal-main', 'interrupt']]);
    assert.equal(tmuxKeys.length, 1);
    assert.equal(tmuxKeys[0].distro, 'FixtureLinux');
    assert.equal(tmuxKeys[0].target, '%7');
    assert.equal(tmuxKeys[0].key, 'C-c');
  });
}

module.exports = { registerTerminalAgentActionTests };
