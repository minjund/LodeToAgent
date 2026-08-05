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
    const launchArgsCalls = [];
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
        launchArgsCalls.push({ support, prompt, options });
        return prompt ? [...support.args, '--', prompt] : [...support.args];
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

    assert.equal(launchArgsCalls[0].prompt, '? 안되는데?');
    assert.equal(launchArgsCalls[1].prompt, undefined);
    assert.equal(launchOptions.transient, false);
    assert.deepStrictEqual(Array.from(launchOptions.args), ['--resume', 'session-123', '--', '? 안되는데?']);
    assert.deepStrictEqual(Array.from(launchOptions.recoveryArgs), ['--resume', 'session-123']);
    assert.equal(launchOptions.reuseBridge, true);
    assert.equal(launchOptions.initialCommand, '? 안되는데?');
    assert.equal(launchOptions.initialCommandInArgs, true);
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

  test('호스트 응답 확인이 끊긴 재개 전송은 중복 없이 확인 필요 상태를 돌려준다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    let refreshes = 0;
    let commands = 0;
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async () => ({
            id: 'terminal:uncertain-resume',
            type: 'agent',
            provider: 'claude',
            status: 'running',
            title: 'Claude uncertain',
            promptSent: false,
            deliveryState: 'unknown',
          }),
          terminalCommand: async () => {
            commands += 1;
            return { ok: true };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      $: () => null,
      state: { snapshot: null, sessions: [], platform: { id: 'darwin' }, wslDistros: [] },
      init: async () => {},
      notice: () => {},
      moveWorkbench: () => {},
      selectTmux: async () => {},
      selectSession: async () => {},
      bindAgent: () => {},
      queueHistoryRefresh: () => {},
      renderTarget: () => {},
      fitEntry: () => {},
      refreshSessions: async () => {
        refreshes += 1;
        if (refreshes === 2) throw new Error('전송 뒤 화면 새로고침 연결이 끊김');
      },
      resumeSupport: () => ({
        supported: true,
        provider: 'claude',
        sessionId: 'uncertain-resume',
        args: ['--resume', 'uncertain-resume'],
      }),
      resumeLaunchArgs: (support, prompt = '') => prompt ? [...support.args, '--', prompt] : [...support.args],
      preferredWorkspace: () => '/workspace',
      providerLabel: provider => provider,
      terminalTypeLabel: () => 'Claude',
      esc: value => String(value),
    });

    const result = await actions.resumeForAgent({
      id: 'claude:uncertain-resume',
      provider: 'claude',
      externalId: 'uncertain-resume',
      cwd: '/workspace',
      runtimePresence: [],
    }, '한 번만 처리해', true, { focus: false, deliveryId: 'delivery:uncertain:1' });

    assert.equal(result.deliveryState, 'unknown');
    assert.equal(result.promptSent, false);
    assert.equal(commands, 0, '확인 불명 상태에서는 같은 질문을 다시 쓰면 안 됩니다.');
  });

  test('Grok 대화 재개는 질문을 시작 인자에 섞지 않고 PTY에 한 번만 보낸다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    let launchOptions = null;
    const commands = [];
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            launchOptions = options;
            return {
              id: 'terminal:grok-resume',
              type: 'agent',
              provider: 'grok',
              status: 'running',
              title: 'Grok resume',
              promptSent: false,
            };
          },
          terminalCommand: async (id, prompt, options) => {
            commands.push([id, prompt, options]);
            return { ok: true, deliveryState: 'accepted' };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      $: () => null,
      state: { snapshot: null, sessions: [], platform: { id: 'darwin' }, wslDistros: [] },
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
        provider: 'grok',
        sessionId: 'grok-session-42',
        args: ['--resume', 'grok-session-42'],
        promptMode: 'terminal',
      }),
      resumeLaunchArgs: (support, prompt = '') => prompt ? [...support.args, '--', prompt] : [...support.args],
      preferredWorkspace: () => '/workspace',
      providerLabel: provider => provider,
      terminalTypeLabel: () => 'Grok',
      esc: value => String(value),
    });

    const result = await actions.resumeForAgent({
      id: 'grok:grok-session-42',
      provider: 'grok',
      externalId: 'grok-session-42',
      cwd: '/workspace',
      runtimePresence: [],
    }, 'Grok에게 한 번만 보낼 질문', true, { focus: false, deliveryId: 'delivery:grok:42' });

    assert.deepStrictEqual(Array.from(launchOptions.args), ['--resume', 'grok-session-42']);
    assert.deepStrictEqual(Array.from(launchOptions.recoveryArgs), ['--resume', 'grok-session-42']);
    assert.equal(launchOptions.initialCommandInArgs, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(commands)), [[
      'terminal:grok-resume',
      'Grok에게 한 번만 보낼 질문',
      { deliveryId: 'delivery:grok:42' },
    ]]);
    assert.equal(result.promptSent, true);
    assert.equal(result.deliveryState, 'accepted');
  });

  test('재개 명령을 모르는 AI도 분리된 관리 터미널을 재연결해 한 번만 보낸다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const calls = [];
    const state = {
      snapshot: null,
      sessions: [{
        id: 'terminal:grok-detached',
        type: 'agent',
        provider: 'grok',
        bridgeId: 'grok:session-42',
        backend: 'managed-tmux',
        status: 'detached',
        title: 'Grok detached',
        pid: null,
      }],
      platform: { id: 'darwin' },
      wslDistros: [],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalReconnect: async id => {
            calls.push(['reconnect', id]);
            return { id, status: 'running' };
          },
          terminalCommand: async (id, prompt) => {
            calls.push(['command', id, prompt]);
            return { ok: true };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      notice: () => {},
      terminalTypeLabel: () => 'Grok',
    });
    const agentSession = {
      id: 'grok:session-42',
      provider: 'grok',
      externalId: 'session-42',
      runtimePresence: [],
    };
    const targets = actions.agentTargets(agentSession);

    assert.equal(targets.length, 1);
    assert.equal(targets[0].id, 'terminal:grok-detached');
    assert.equal(targets[0].reconnectable, true);
    const result = await actions.dispatchAgentCommand(agentSession, '조심해서 이어서 진행해', targets[0].id);
    assert.equal(result.ok, true);
    assert.deepStrictEqual(calls, [
      ['reconnect', 'terminal:grok-detached'],
      ['command', 'terminal:grok-detached', '조심해서 이어서 진행해'],
    ]);
  });

  test('터미널 목록보다 브리지 presence가 먼저 도착해도 같은 PTY를 찾는다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state: {
        snapshot: null,
        sessions: [],
        suppressedTmuxTargets: new Set(),
      },
      terminalTypeLabel: () => 'Codex',
    });
    const targets = actions.agentTargets({
      id: 'codex:bridge-race',
      provider: 'codex',
      runtimePresence: [{
        kind: 'bridge',
        terminalId: 'terminal:bridge-race',
        pid: 42420,
        runtime: 'codex',
        label: 'LoadToAgent AI 명령창',
      }],
    });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(targets)), [{
      id: 'terminal:bridge-race',
      kind: 'terminal',
      label: 'LoadToAgent AI 명령창',
      detail: 'Codex · session.program_pid',
      terminalId: 'terminal:bridge-race',
    }]);
  });

  test('분리된 관리 터미널이 있으면 히스토리 세션도 직접 전송 경로를 쓴다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    const sandbox = {
      window: {
        LoadToAgentAppFactories: {},
        LoadToAgentI18n: {
          t: key => key,
          errorText: (_error, key) => key,
        },
        LoadToAgentTerminal: {
          resumeSupport: () => ({ supported: false, reason: 'resume unsupported' }),
        },
        LoadToAgentRendererUtils: { reportRecoverableError: () => {} },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-agent-actions.js' });
    const actions = sandbox.window.LoadToAgentAppFactories.createAgentActions({
      state: {
        details: new Map(),
        snapshot: { sessions: [] },
        agentCommandRoutes: new Map(),
        agentCommandTargets: new Map(),
        agentCommandDrafts: new Map(),
        agentCommandSending: new Set(),
      },
      isLiveSession: () => false,
    });

    assert.equal(actions.agentControlMode({ id: 'grok:history', provider: 'grok' }, [{
      id: 'terminal:grok-detached',
      kind: 'terminal',
      reconnectable: true,
    }]), 'direct');
  });

  test('전송 결과를 확인하지 못한 대화는 실패가 아니라 확인 필요로 남긴다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    const state = {
      details: new Map(),
      snapshot: { sessions: [] },
      agentCommandRoutes: new Map(),
      agentCommandTargets: new Map(),
      agentCommandDrafts: new Map(),
      agentCommandSending: new Set(),
      pendingConversationMessages: new Map(),
      conversationInterruptRequests: new Set(),
    };
    const sandbox = {
      clearTimeout,
      window: {
        LoadToAgentAppFactories: {},
        LoadToAgentI18n: { t: key => key, errorText: (_error, key) => key },
        LoadToAgentConversationDelivery: { CONFIRMATION_DELAY_MS: 60_000 },
        LoadToAgentRendererUtils: { reportRecoverableError: () => {} },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-agent-actions.js' });
    const actions = sandbox.window.LoadToAgentAppFactories.createAgentActions({ state });
    const entry = { status: 'sending', phase: 'sending', dispatchedAt: null };

    assert.equal(typeof actions.updateConversationMessage, 'function');
    actions.updateConversationMessage('claude:uncertain', entry, 'uncertain', '호스트 응답 유실');

    assert.equal(entry.status, 'uncertain');
    assert.equal(entry.phase, 'uncertain');
    assert.equal(Boolean(entry.dispatchedAt), true);
    assert.equal(entry.failedAt, undefined);
  });

  test('확인 불명 응답은 대화 초안과 대상은 보존하고 같은 질문을 재전송하지 않는다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    const target = { id: 'terminal:unknown', kind: 'terminal', terminalId: 'terminal:unknown', label: 'GPT terminal' };
    const session = {
      id: 'codex:unknown', provider: 'codex', status: 'running', title: 'GPT work', messages: [], lifecycle: [],
    };
    const state = {
      details: new Map(),
      snapshot: { sessions: [session] },
      agentCommandRoutes: new Map(),
      agentCommandTargets: new Map(),
      agentCommandDrafts: new Map(),
      agentCommandSending: new Set(),
      pendingConversationMessages: new Map(),
      conversationInterruptRequests: new Set(),
    };
    const toasts = [];
    const sandbox = {
      clearTimeout,
      window: {
        LoadToAgentAppFactories: {},
        LoadToAgentI18n: { t: key => key, errorText: (_error, key) => key },
        LoadToAgentConversationDelivery: {
          CONFIRMATION_DELAY_MS: 60_000,
          normalizedText: value => String(value || '').replace(/\s+/g, ' ').trim(),
        },
        LoadToAgentRendererUtils: { reportRecoverableError: () => {} },
        LoadToAgentTerminal: {
          agentTargets: () => [target],
          resumeSupport: () => ({ supported: true, provider: 'codex', sessionId: 'unknown' }),
          dispatchAgentCommand: async () => ({ ok: true, target, deliveryState: 'unknown' }),
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-agent-actions.js' });
    const actions = sandbox.window.LoadToAgentAppFactories.createAgentActions({
      state,
      isLiveSession: () => true,
      providerInfo: () => ({ label: 'GPT' }),
      conversationMessageKey: message => String(message?.id || ''),
      toast: message => toasts.push(message),
      renderDrawer: () => {},
    });
    const input = { value: '중복 없이 한 번만 보내줘' };
    const form = {
      dataset: {
        agentCommandRouting: 'conversation',
        agentCommandInputModeSelected: 'conversation',
        agentCommandRouteSelected: 'direct',
      },
      querySelector: selector => selector === '[data-agent-command-draft]' ? input : null,
    };

    await actions.dispatchAgentCommand(session.id, form);

    const [entry] = state.pendingConversationMessages.get(session.id);
    assert.equal(entry.status, 'uncertain');
    assert.equal(entry.phase, 'uncertain');
    assert.equal(entry.target.id, target.id);
    assert.equal(input.value, '중복 없이 한 번만 보내줘');
    assert.equal(state.agentCommandDrafts.get(session.id), '중복 없이 한 번만 보내줘');
    assert.deepStrictEqual(toasts, ['agent.delivery_uncertain']);
  });

  test('세션 터미널의 재개 전송도 확인 불명일 때 초안을 지우지 않는다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    const session = {
      id: 'gemini:resume-unknown', provider: 'gemini', status: 'completed', title: 'Gemini work', messages: [],
    };
    const state = {
      details: new Map(),
      snapshot: { sessions: [session] },
      agentCommandRoutes: new Map(),
      agentCommandTargets: new Map(),
      agentCommandDrafts: new Map(),
      agentCommandSending: new Set(),
      pendingConversationMessages: new Map(),
      conversationInterruptRequests: new Set(),
    };
    const calls = [];
    const toasts = [];
    const sandbox = {
      document: { querySelector: () => null },
      window: {
        LoadToAgentAppFactories: {},
        LoadToAgentI18n: { t: key => key, errorText: (_error, key) => key },
        LoadToAgentRendererUtils: { reportRecoverableError: () => {} },
        LoadToAgentTerminal: {
          agentTargets: () => [],
          resumeSupport: () => ({ supported: true, provider: 'gemini', sessionId: 'resume-unknown' }),
          resumeForAgent: async (_session, prompt, sendDraft, options) => {
            calls.push({ prompt, sendDraft, options });
            return { id: 'terminal:gemini-unknown', deliveryState: 'unknown', promptSent: false };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-agent-actions.js' });
    const actions = sandbox.window.LoadToAgentAppFactories.createAgentActions({
      $: () => ({ classList: { contains: () => false } }),
      state,
      isLiveSession: () => false,
      providerInfo: () => ({ label: 'Gemini' }),
      selectView: () => {},
      toast: message => toasts.push(message),
    });
    const input = { value: '재개해서 한 번만 보내줘' };
    const form = {
      dataset: { agentCommandRouting: 'session', agentCommandInputModeSelected: 'terminal' },
      querySelector: selector => selector === '[data-agent-command-draft]' ? input : null,
    };

    await actions.dispatchAgentCommand(session.id, form);
    await actions.dispatchAgentCommand(session.id, form);

    assert.equal(state.agentCommandDrafts.get(session.id), '재개해서 한 번만 보내줘');
    assert.equal(calls.length, 2);
    assert.match(calls[0].options.deliveryId, /^delivery:/);
    assert.equal(calls[1].options.deliveryId, calls[0].options.deliveryId);
    assert.deepStrictEqual(toasts, ['agent.delivery_uncertain', 'agent.delivery_uncertain']);
  });

  test('보내기 전 거절은 초안을 유지하되 다시 시도할 수 있고 확인 불명으로 표시하지 않는다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    const target = { id: 'terminal:retryable', kind: 'terminal', terminalId: 'terminal:retryable', label: 'Claude terminal' };
    const session = { id: 'claude:retryable', provider: 'claude', status: 'running', title: 'Claude work', messages: [] };
    const state = {
      details: new Map(),
      snapshot: { sessions: [session] },
      agentCommandRoutes: new Map(),
      agentCommandTargets: new Map(),
      agentCommandDrafts: new Map(),
      agentCommandDeliveries: new Map(),
      agentCommandSending: new Set(),
      pendingConversationMessages: new Map(),
      conversationInterruptRequests: new Set(),
    };
    const calls = [];
    const toasts = [];
    const sandbox = {
      clearTimeout,
      window: {
        LoadToAgentAppFactories: {},
        LoadToAgentI18n: { t: key => key, errorText: (_error, key) => key },
        LoadToAgentRendererUtils: { reportRecoverableError: () => {} },
        LoadToAgentTerminal: {
          agentTargets: () => [target],
          resumeSupport: () => ({ supported: false }),
          dispatchAgentCommand: async (_session, _command, _targetId, options) => {
            calls.push(options.deliveryId);
            if (calls.length === 1) {
              const error = new Error('보내기 전에 안전하게 중단');
              error.deliveryState = 'rejected';
              throw error;
            }
            return { ok: true, target, deliveryState: 'accepted' };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-agent-actions.js' });
    const actions = sandbox.window.LoadToAgentAppFactories.createAgentActions({
      state,
      isLiveSession: () => true,
      providerInfo: () => ({ label: 'Claude' }),
      toast: message => toasts.push(message),
    });
    const input = { value: '안전하게 다시 보낼 질문' };
    const form = {
      dataset: { agentCommandRouting: 'session', agentCommandInputModeSelected: 'terminal' },
      querySelector: selector => selector === '[data-agent-command-draft]' ? input : null,
    };

    await actions.dispatchAgentCommand(session.id, form);
    assert.equal(input.value, '안전하게 다시 보낼 질문');
    assert.equal(state.agentCommandDrafts.get(session.id), '안전하게 다시 보낼 질문');
    assert.deepStrictEqual(toasts, ['agent.delivery_retry_ready']);

    await actions.dispatchAgentCommand(session.id, form);
    assert.notEqual(calls[1], calls[0]);
    assert.equal(input.value, '');
    assert.equal(state.agentCommandDrafts.has(session.id), false);
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
