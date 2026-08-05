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
    const commandCalls = [];
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
          terminalCommand: async (...args) => {
            commandCalls.push(args);
            return { ok: true, deliveryState: 'accepted' };
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

    const prompt = '? 안되는데? & % ! "quoted" | < > ^ $(echo nope)';
    const result = await actions.resumeForAgent({
      id: 'claude:session-123',
      provider: 'claude',
      externalId: 'session-123',
      cwd: 'D:\\workspace',
      runtimePresence: [],
    }, prompt, true, { focus: false, deliveryId: 'delivery:special-characters' });

    assert.equal(launchArgsCalls[0].prompt, undefined);
    assert.equal(launchArgsCalls[1].prompt, undefined);
    assert.equal(launchOptions.transient, false);
    assert.deepStrictEqual(Array.from(launchOptions.args), ['--resume', 'session-123']);
    assert.deepStrictEqual(Array.from(launchOptions.recoveryArgs), ['--resume', 'session-123']);
    assert.equal(JSON.stringify(launchOptions.args).includes(prompt), false, '질문은 프로세스 인자에 포함되면 안 됩니다.');
    assert.equal(JSON.stringify(launchOptions.recoveryArgs).includes(prompt), false, '복구 인자에도 질문은 포함되면 안 됩니다.');
    assert.equal(launchOptions.reuseBridge, true);
    assert.equal(launchOptions.initialCommand, prompt, '중복 방지 ledger용 질문 메타데이터는 유지해야 합니다.');
    assert.equal(launchOptions.initialCommandInArgs, false);
    assert.equal(commandCalls.length, 1, '특수문자가 든 질문은 terminalCommand로 정확히 한 번 보내야 합니다.');
    assert.equal(commandCalls[0][0], 'terminal:managed-resume');
    assert.equal(commandCalls[0][1], prompt, '특수문자가 든 질문 전체를 그대로 보내야 합니다.');
    assert.equal(commandCalls[0][2]?.deliveryId, 'delivery:special-characters');
    assert.equal(result.background, true);
    assert.equal(result.promptSent, true);
    assert.equal(workbenchOpened, false, '백그라운드 전송은 터미널 화면을 강제로 열지 않아야 합니다.');
  });

  test('대화창을 열면 질문 없이 같은 세션의 실제 PTY를 한 번만 만들고 재사용한다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const createCalls = [];
    const commandCalls = [];
    let createdRecord = null;
    const state = {
      snapshot: null,
      sessions: [],
      platform: { id: 'win32' },
      wslDistros: [],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            createCalls.push(options);
            await new Promise(resolve => setTimeout(resolve, 10));
            createdRecord = {
              id: 'terminal:prompt-free-resume',
              type: 'agent',
              provider: options.provider,
              bridgeId: options.bridgeId,
              agentResumeSessionId: '019f-prompt-free-resume',
              agentConnectionSignature: options.agentConnectionSignature,
              backend: 'direct',
              conversationBound: true,
              cwd: options.cwd,
              distro: options.distro,
              status: 'running',
              pid: 5252,
              title: options.title,
            };
            return createdRecord;
          },
          terminalCommand: async (...args) => {
            commandCalls.push(args);
            return { ok: true };
          },
        },
      },
      setTimeout,
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
      refreshSessions: async () => {
        if (createdRecord) state.sessions = [createdRecord];
      },
      resumeSupport: session => ({
        supported: true,
        provider: session.provider,
        sessionId: session.externalId,
        args: ['resume', session.externalId],
      }),
      resumeLaunchArgs: (support, prompt = '') => prompt ? [...support.args, '--', prompt] : [...support.args],
      preferredWorkspace: () => 'D:\\workspace',
      providerLabel: provider => provider,
      terminalTypeLabel: () => 'Codex',
      esc: value => String(value),
    });
    const session = {
      id: 'codex:prompt-free-resume',
      provider: 'codex',
      externalId: '019f-prompt-free-resume',
      cwd: 'D:\\workspace',
      runtimePresence: [],
    };

    const [first, second] = await Promise.all([
      actions.ensureForAgent(session),
      actions.ensureForAgent(session),
    ]);
    const third = await actions.ensureForAgent(session);

    assert.equal(first.id, 'terminal:prompt-free-resume');
    assert.equal(second.id, first.id);
    assert.equal(third.id, first.id);
    assert.equal(createCalls.length, 1, '동시 렌더와 재렌더가 PTY를 중복 생성하면 안 됩니다.');
    assert.deepStrictEqual(Array.from(createCalls[0].args), ['resume', '019f-prompt-free-resume']);
    assert.deepStrictEqual(Array.from(createCalls[0].recoveryArgs), ['resume', '019f-prompt-free-resume']);
    assert.equal(createCalls[0].bridgeId, session.id);
    assert.equal(createCalls[0].reuseBridge, true);
    assert.equal(createCalls[0].transient, false);
    assert.equal(createCalls[0].initialCommand, '');
    assert.equal(createCalls[0].initialCommandInArgs, false);
    assert.equal(commandCalls.length, 0, 'PTY 연결 중 예전 질문이나 초안을 보내면 안 됩니다.');
  });

  test('외부 tmux에서 실행 중인 대화도 writable pane 대신 app-owned provider resume PTY에 연결한다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const createCalls = [];
    let terminalGetCalls = 0;
    const state = {
      snapshot: {
        tmux: {
          distros: [{
            name: 'FixtureLinux',
            sessions: [{
              nativeId: '$2',
              name: 'fixture-session',
              windows: [{
                index: 0,
                nativeId: '@3',
                name: 'fixture-window',
                panes: [{
                  id: 'tmux-pane-id',
                  nativeId: '%7',
                  pid: 51001,
                  command: 'codex',
                  agent: { linkedSessionId: 'codex:tmux-live' },
                }],
              }],
            }],
          }],
        },
      },
      sessions: [],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: ['FixtureLinux'],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            createCalls.push(options);
            const created = {
              id: 'terminal:tmux-attach',
              type: 'agent',
              provider: options.provider,
              bridgeId: options.bridgeId,
              agentResumeSessionId: '019f-tmux-live',
              agentConnectionSignature: options.agentConnectionSignature,
              backend: 'direct',
              conversationBound: true,
              cwd: options.cwd,
              distro: options.distro,
              status: 'running',
              title: options.title,
              pid: 6262,
            };
            state.sessions = [created];
            return created;
          },
          terminalGet: async id => {
            terminalGetCalls += 1;
            const created = state.sessions.find(item => item.id === id);
            if (terminalGetCalls >= 2) created.status = 'running';
            return created;
          },
        },
      },
      setTimeout,
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      refreshSessions: async () => {},
      resumeSupport: session => ({ supported: true, provider: session.provider, sessionId: session.externalId, args: ['resume', session.externalId] }),
      resumeLaunchArgs: support => [...support.args],
      preferredWorkspace: () => '/workspace',
      providerLabel: provider => provider,
      tmuxTargetKey: (distro, pane) => `${distro}:${pane}`,
      terminalTypeLabel: () => 'tmux',
    });
    const session = {
      id: 'codex:tmux-live',
      provider: 'codex',
      externalId: '019f-tmux-live',
      cwd: '/workspace',
      environment: { kind: 'wsl', distro: 'FixtureLinux' },
      runtimePresence: [{
        kind: 'tmux',
        linkAuthority: 'explicit-session-id',
        id: 'tmux:FixtureLinux:%7',
        distro: 'FixtureLinux',
        paneId: 'tmux-pane-id',
        paneNativeId: '%7',
      }],
    };

    assert.deepStrictEqual(Array.from(actions.agentTargets(session).filter(item => item.kind === 'tmux')), [],
      '외부 tmux pane은 full presence여도 conversation writable target이 되면 안 됩니다.');

    const target = await actions.ensureForAgent(session);

    assert.equal(target.id, 'terminal:tmux-attach');
    assert.equal(target.kind, 'terminal');
    assert.equal(createCalls.length, 1);
    assert.equal(terminalGetCalls, 0);
    assert.equal(createCalls[0].type, 'agent');
    assert.equal(createCalls[0].provider, 'codex');
    assert.deepStrictEqual(Array.from(createCalls[0].args), ['resume', '019f-tmux-live']);
    assert.equal(createCalls[0].distro, 'FixtureLinux');
    assert.equal(createCalls[0].bridgeId, session.id);
    assert.equal(createCalls[0].tmuxPane, undefined);
    assert.equal(createCalls[0].initialCommand, '');
  });

  test('WSL conversation은 persisted distro가 없으면 설치 distro가 하나여도 PTY를 추측 생성하지 않는다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const createCalls = [];
    const pane = (distro, sessionName, windowId, paneId) => ({
      name: distro,
      sessions: [{
        id: `wsl:${distro}:tmux:$1`,
        name: sessionName,
        windows: [{
          index: 0,
          nativeId: windowId,
          name: `${sessionName}-window`,
          panes: [{
            id: `wsl:${distro}:tmux:$1:window:${windowId}:pane:%7`,
            nativeId: '%7',
            command: 'codex',
            agent: { linkedSessionId: 'codex:cross-distro-pane' },
          }],
        }],
      }],
    });
    const state = {
      snapshot: {
        tmux: {
          // The wrong distro is intentionally first: a native-id-only lookup
          // would attach this pane and leak input into another tmux server.
          distros: [
            pane('WrongLinux', 'wrong-session', '@1'),
            pane('RightLinux', 'right-session', '@2'),
          ],
        },
      },
      sessions: [],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: ['WrongLinux', 'RightLinux'],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            createCalls.push(options);
            const created = {
              id: 'terminal:cross-distro-pane',
              type: 'agent',
              provider: options.provider,
              bridgeId: options.bridgeId,
              distro: options.distro,
              agentResumeSessionId: '019f-cross-distro-pane',
              agentConnectionSignature: options.agentConnectionSignature,
              backend: 'direct',
              conversationBound: true,
              cwd: options.cwd,
              status: 'running',
              pid: 6363,
              title: options.title,
            };
            state.sessions = [created];
            return created;
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      refreshSessions: async () => {},
      resumeSupport: session => ({ supported: true, provider: session.provider, sessionId: session.externalId, args: ['resume', session.externalId] }),
      resumeLaunchArgs: support => [...support.args],
      preferredWorkspace: () => '/workspace',
      providerLabel: provider => provider,
      tmuxTargetKey: (distro, nativePane) => `${distro}:${nativePane}`,
      terminalTypeLabel: () => 'tmux',
    });
    const session = {
      id: 'codex:cross-distro-pane',
      provider: 'codex',
      externalId: '019f-cross-distro-pane',
      cwd: '/workspace',
      environment: { kind: 'wsl', distro: 'RightLinux' },
      runtimePresence: [{
        kind: 'tmux',
        linkAuthority: 'explicit-session-id',
        id: 'tmux:RightLinux:%7',
        distro: 'RightLinux',
        sessionId: 'wsl:RightLinux:tmux:$1',
        sessionName: 'right-session',
        paneId: 'wsl:RightLinux:tmux:$1:window:@2:pane:%7',
        paneNativeId: '%7',
      }],
    };

    const tmuxTargets = actions.agentTargets(session).filter(target => target.kind === 'tmux');
    const target = await actions.ensureForAgent(session);

    assert.deepStrictEqual(Array.from(tmuxTargets, item => item.id), []);
    assert.equal(target.id, 'terminal:cross-distro-pane');
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].distro, 'RightLinux');
    assert.equal(createCalls[0].type, 'agent');
    assert.equal(createCalls[0].tmuxPane, undefined);

    state.wslDistros = ['OnlyInstalledButUntrusted'];
    const missingDistroSession = {
      ...session,
      id: 'codex:missing-wsl-distro',
      externalId: '019f-missing-wsl-distro',
      environment: { kind: 'wsl', distro: '' },
      runtimePresence: [],
    };
    await assert.rejects(
      actions.ensureForAgent(missingDistroSession),
      error => error.deliveryState === 'rejected' && /wsl_distro_missing/u.test(error.message),
    );
    assert.equal(createCalls.length, 1, '설치 distro가 하나여도 persisted distro 없이 provider PTY를 추측 생성하면 안 됩니다.');
  });

  test('같은 대화 id의 재개 정보가 바뀌면 이전 PTY를 완전히 닫은 뒤 새 실제 PTY를 만든다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const createCalls = [];
    const retireCalls = [];
    const closeCalls = [];
    const stopCalls = [];
    const lifecycle = [];
    const state = {
      snapshot: null,
      sessions: [],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: [],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            createCalls.push(options);
            lifecycle.push(`create:${options.args[1]}`);
            await new Promise(resolve => setTimeout(resolve, 5));
            const created = {
              id: `terminal:identity-${createCalls.length}`,
              type: 'agent',
              provider: options.provider,
              bridgeId: options.bridgeId,
              agentResumeSessionId: options.args[1],
              agentConnectionSignature: options.agentConnectionSignature,
              backend: 'direct',
              conversationBound: true,
              cwd: options.cwd,
              distro: options.distro,
              status: 'running',
              title: options.title,
              pid: 7000 + createCalls.length,
            };
            state.sessions.push(created);
            return created;
          },
          terminalRetire: async id => {
            retireCalls.push(id);
            lifecycle.push(`retire-begin:${id}`);
            await new Promise(resolve => setTimeout(resolve, 1));
            state.sessions = state.sessions.filter(item => item.id !== id);
            lifecycle.push(`retire-ack:${id}`);
            return { ok: true };
          },
          terminalClose: async id => {
            closeCalls.push(id);
            lifecycle.push(`close:${id}`);
            state.sessions = state.sessions.filter(item => item.id !== id);
            return { ok: true };
          },
          terminalStop: async id => {
            stopCalls.push(id);
            state.sessions = state.sessions.map(item => item.id === id ? { ...item, status: 'stopped' } : item);
            return { ok: true };
          },
        },
      },
      setTimeout,
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      refreshSessions: async () => {},
      resumeSupport: session => ({
        supported: true,
        provider: session.provider,
        sessionId: session.externalId,
        args: ['resume', session.externalId],
      }),
      resumeLaunchArgs: support => [...support.args],
      preferredWorkspace: () => 'D:\\workspace',
      providerLabel: provider => provider,
      terminalTypeLabel: () => 'Codex',
    });
    const firstIdentity = {
      id: 'codex:changing-identity',
      provider: 'codex',
      externalId: '019f-first-identity',
      cwd: 'D:\\workspace-a',
      runtimePresence: [],
    };
    const secondIdentity = {
      ...firstIdentity,
      externalId: '019f-second-identity',
      cwd: 'D:\\workspace-b',
    };

    const first = await actions.ensureForAgent(firstIdentity);
    const second = await actions.ensureForAgent(secondIdentity);

    assert.notEqual(first.id, second.id);
    assert.equal(createCalls.length, 2);
    assert.deepStrictEqual(Array.from(createCalls[0].args), ['resume', '019f-first-identity']);
    assert.deepStrictEqual(Array.from(createCalls[1].args), ['resume', '019f-second-identity']);
    assert.equal(createCalls[0].reuseBridge, true);
    assert.equal(createCalls[1].reuseBridge, true, '이전 bridge 점유를 확실히 끝낸 뒤 새 PTY를 생성해야 합니다.');
    assert.deepStrictEqual(retireCalls, [first.id]);
    assert.deepStrictEqual(closeCalls, [], '확정 종료 API가 있으면 비동기 close fallback을 호출하면 안 됩니다.');
    assert.deepStrictEqual(stopCalls, []);
    assert.deepStrictEqual(lifecycle, [
      'create:019f-first-identity',
      `retire-begin:${first.id}`,
      `retire-ack:${first.id}`,
      'create:019f-second-identity',
    ], '이전 PTY process-tree 종료 ack 전에 새 identity를 생성하면 안 됩니다.');
    assert.deepStrictEqual(state.sessions.map(item => item.id), [second.id]);
  });

  test('순차 identity 변경에서 이전 PTY cleanup이 거절되면 새 PTY를 만들지 않고 기존 서명을 유지한다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const createCalls = [];
    const retireCalls = [];
    const closeCalls = [];
    const stopCalls = [];
    const state = {
      snapshot: null,
      sessions: [],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: [],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            createCalls.push(options);
            const created = {
              id: 'terminal:cleanup-fail-a',
              type: 'agent',
              provider: options.provider,
              bridgeId: options.bridgeId,
              cwd: options.cwd,
              distro: options.distro,
              agentResumeSessionId: options.args[1],
              agentConnectionSignature: options.agentConnectionSignature,
              backend: 'direct',
              conversationBound: true,
              status: 'running',
              pid: 7101,
              title: options.title,
            };
            state.sessions = [created];
            return created;
          },
          terminalRetire: async id => {
            retireCalls.push(id);
            return { ok: false, error: 'fixture retire rejected' };
          },
          terminalClose: async id => {
            closeCalls.push(id);
            return { ok: false, error: 'fixture close rejected' };
          },
          terminalStop: async id => {
            stopCalls.push(id);
            return { ok: false, error: 'fixture stop rejected' };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      refreshSessions: async () => {},
      resumeSupport: current => ({
        supported: true,
        provider: current.provider,
        sessionId: current.externalId,
        args: ['resume', current.externalId],
      }),
      resumeLaunchArgs: support => [...support.args],
      preferredWorkspace: () => 'D:\\workspace',
      providerLabel: provider => provider,
      terminalTypeLabel: () => 'Codex',
    });
    const firstIdentity = {
      id: 'codex:cleanup-fail',
      provider: 'codex',
      externalId: '019f-cleanup-fail-a',
      cwd: 'D:\\workspace-a',
      runtimePresence: [],
    };
    const secondIdentity = {
      ...firstIdentity,
      externalId: '019f-cleanup-fail-b',
      cwd: 'D:\\workspace-b',
    };

    const first = await actions.ensureForAgent(firstIdentity);
    await assert.rejects(
      actions.ensureForAgent(secondIdentity),
      error => error?.code === 'TERMINAL_CONNECTION_CLEANUP_FAILED',
    );

    assert.equal(createCalls.length, 1, 'cleanup 실패 뒤 B PTY를 생성하면 안 됩니다.');
    assert.deepStrictEqual(retireCalls, [first.id]);
    assert.deepStrictEqual(closeCalls, [], 'terminalRetire 거절을 close 성공으로 덮어쓰면 안 됩니다.');
    assert.deepStrictEqual(stopCalls, []);
    assert.deepStrictEqual(state.sessions.map(item => item.id), [first.id]);
    assert.deepStrictEqual(Array.from(actions.agentTargets(firstIdentity), target => target.id), [first.id],
      'cleanup 실패 시 기존 서명을 지워 A 연결까지 잃으면 안 됩니다.');
    assert.deepStrictEqual(Array.from(actions.agentTargets(secondIdentity), target => target.id), []);
  });

  test('종료 행이 사라진 뒤 남은 runtime presence는 유령 PTY로 재사용하지 않는다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const createCalls = [];
    const commandCalls = [];
    const session = {
      id: 'codex:ghost-bridge',
      provider: 'codex',
      externalId: '019f-ghost-bridge',
      cwd: 'D:\\workspace',
      runtimePresence: [{
        kind: 'bridge',
        terminalId: 'terminal:ghost-bridge',
        pid: 7301,
        runtime: 'codex',
      }],
    };
    const state = {
      snapshot: null,
      sessions: [{
        id: 'terminal:ghost-bridge',
        type: 'agent',
        provider: 'codex',
        bridgeId: session.id,
        status: 'stopped',
        pid: 7301,
      }],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: [],
    };
    let refreshes = 0;
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            createCalls.push(options);
            const created = {
              id: 'terminal:ghost-replacement',
              type: 'agent',
              provider: options.provider,
              bridgeId: options.bridgeId,
              agentResumeSessionId: options.args[1],
              agentConnectionSignature: options.agentConnectionSignature,
              backend: 'direct',
              conversationBound: true,
              cwd: options.cwd,
              distro: options.distro,
              status: 'running',
              pid: 7302,
              title: options.title,
            };
            state.sessions = [created];
            return created;
          },
          terminalCommand: async (...args) => {
            commandCalls.push(args);
            return { ok: true };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      refreshSessions: async () => {
        refreshes += 1;
        if (refreshes === 1) state.sessions = [];
      },
      resumeSupport: current => ({
        supported: true,
        provider: current.provider,
        sessionId: current.externalId,
        args: ['resume', current.externalId],
      }),
      resumeLaunchArgs: support => [...support.args],
      preferredWorkspace: () => 'D:\\workspace',
      providerLabel: provider => provider,
      terminalTypeLabel: () => 'Codex',
    });

    const target = await actions.ensureForAgent(session, {
      excludeTerminalIds: ['terminal:ghost-bridge'],
    });

    assert.equal(target.id, 'terminal:ghost-replacement');
    assert.equal(target.reused, false);
    assert.equal(createCalls.length, 1, '사라진 PTY id를 presence에서 다시 쓰지 말고 교체 PTY를 만들어야 합니다.');
    assert.deepStrictEqual(Array.from(createCalls[0].args), ['resume', session.externalId]);
    assert.equal(createCalls[0].initialCommand, '');
    assert.equal(createCalls[0].initialCommandInArgs, false);
    assert.equal(commandCalls.length, 0, '교체 PTY 연결 중에 질문을 전송하면 안 됩니다.');
  });

  test('같은 대화 id의 연결 서명이 바뀌면 agentTargets에서 이전 PTY를 제외한다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const state = {
      snapshot: null,
      sessions: [],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: [],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            const created = {
              id: 'terminal:signature-a',
              type: 'agent',
              provider: options.provider,
              bridgeId: options.bridgeId,
              status: 'running',
              pid: 7401,
              title: options.title,
            };
            state.sessions = [created];
            return created;
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      refreshSessions: async () => {},
      resumeSupport: current => ({
        supported: true,
        provider: current.provider,
        sessionId: current.externalId,
        args: ['resume', current.externalId],
      }),
      resumeLaunchArgs: support => [...support.args],
      preferredWorkspace: () => 'D:\\workspace',
      providerLabel: provider => provider,
      terminalTypeLabel: () => 'Codex',
    });
    const firstIdentity = {
      id: 'codex:signature-change',
      provider: 'codex',
      externalId: '019f-signature-a',
      cwd: 'D:\\workspace-a',
      runtimePresence: [],
    };
    const secondIdentity = {
      ...firstIdentity,
      externalId: '019f-signature-b',
      cwd: 'D:\\workspace-b',
    };

    await actions.ensureForAgent(firstIdentity);
    const targets = actions.agentTargets(secondIdentity);

    assert.deepStrictEqual(JSON.parse(JSON.stringify(targets)), [], '이전 externalId/cwd에서 생성한 PTY는 새 identity의 입력 대상이 아닙니다.');
  });

  test('공개 연결 서명만 writable이고 unsigned legacy와 최초 bind는 fail closed한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const state = {
      snapshot: null,
      sessions: [],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: [],
    };
    const sandbox = { window: { LoadToAgentI18n: { t: key => key } } };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      terminalTypeLabel: () => 'Codex',
    });
    const firstIdentity = {
      id: 'codex:persisted-identity',
      provider: 'codex',
      externalId: '019f-persisted-a',
      cwd: 'D:\\Workspace-A',
      runtimePresence: [],
    };
    const secondIdentity = {
      ...firstIdentity,
      externalId: '019f-persisted-b',
      cwd: 'D:\\Workspace-B',
    };
    const firstSignature = actions.agentConnectionSignature(firstIdentity);

    state.sessions = [{
      id: 'terminal:public-signature',
      type: 'agent',
      provider: 'codex',
      bridgeId: firstIdentity.id,
      agentResumeSessionId: firstIdentity.externalId,
      agentConnectionSignature: firstSignature,
      backend: 'direct',
      conversationBound: true,
      cwd: firstIdentity.cwd,
      status: 'running',
      pid: 7601,
    }];
    assert.deepStrictEqual(Array.from(actions.agentTargets(firstIdentity), target => target.id), ['terminal:public-signature']);
    assert.deepStrictEqual(Array.from(actions.agentTargets(secondIdentity), target => target.id), []);
    assert.equal(actions.bindAgentConnection(secondIdentity, {
      id: 'terminal:public-signature', kind: 'terminal', terminalId: 'terminal:public-signature',
    }), false, '공개 서명 불일치는 renderer 메모리 fallback으로 덮어쓰면 안 됩니다.');

    state.sessions = [{
      id: 'terminal:legacy-resume',
      type: 'agent',
      provider: 'CODEX',
      bridgeId: firstIdentity.id,
      agentResumeSessionId: firstIdentity.externalId,
      cwd: 'd:\\workspace-a',
      status: 'running',
      pid: 7602,
    }];
    assert.deepStrictEqual(Array.from(actions.agentTargets(firstIdentity), target => target.id), [],
      'resume ID만 있는 unsigned legacy PTY는 display-only여야 합니다.');
    assert.deepStrictEqual(Array.from(actions.agentTargets(secondIdentity), target => target.id), []);

    state.sessions = [{
      id: 'terminal:first-bind',
      type: 'agent',
      bridgeId: firstIdentity.id,
      status: 'running',
      pid: 7603,
    }];
    const firstBindTarget = { id: 'terminal:first-bind', kind: 'terminal', terminalId: 'terminal:first-bind' };
    assert.equal(actions.bindAgentConnection(firstIdentity, firstBindTarget), false);
    assert.deepStrictEqual(Array.from(actions.agentTargets(firstIdentity), target => target.id), []);
    assert.deepStrictEqual(Array.from(actions.agentTargets(secondIdentity), target => target.id), [],
      'metadata가 없던 PTY도 최초 mount/selection에서 bind된 뒤 identity 변경으로 재승인되면 안 됩니다.');
    assert.equal(actions.bindAgentConnection(secondIdentity, firstBindTarget), false);
  });

  test('연결 서명은 고정 길이이며 cwd 변경과 무관하게 canonical history identity를 유지한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const state = {
      snapshot: null,
      sessions: [],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: [],
    };
    const sandbox = { window: { LoadToAgentI18n: { t: key => key } } };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      terminalTypeLabel: () => 'Codex',
    });
    const longPrefix = `D:\\${'매우-긴-작업-폴더\\'.repeat(140)}`;
    const firstIdentity = {
      id: 'codex:long-signature',
      provider: 'CODEX',
      externalId: '019f-long-signature',
      cwd: `${longPrefix}tail-a`,
      runtimePresence: [],
    };
    const secondIdentity = { ...firstIdentity, cwd: `${longPrefix}tail-b` };
    const firstSignature = actions.agentConnectionSignature(firstIdentity);
    const secondSignature = actions.agentConnectionSignature(secondIdentity);

    assert.match(firstSignature, /^acs1:[a-f0-9]{64}$/);
    assert.equal(firstSignature.length, 69);
    assert.equal(firstSignature, secondSignature, 'cwd 변경은 canonical conversation identity를 바꾸면 안 됩니다.');
    state.sessions = [{
      id: 'terminal:long-signature',
      type: 'agent',
      provider: 'codex',
      bridgeId: firstIdentity.id,
      agentResumeSessionId: firstIdentity.externalId,
      agentConnectionSignature: firstSignature,
      backend: 'direct',
      conversationBound: true,
      cwd: firstIdentity.cwd,
      status: 'running',
      pid: 7650,
    }];
    assert.deepStrictEqual(Array.from(actions.agentTargets(firstIdentity), target => target.id), ['terminal:long-signature'],
      '메인 프로세스의 1000자 저장 한도 뒤에도 같은 긴 cwd PTY를 재사용해야 합니다.');
    assert.deepStrictEqual(Array.from(actions.agentTargets(secondIdentity), target => target.id), ['terminal:long-signature']);
  });

  test('cached detail보다 snapshot의 writable connection identity를 timestamp와 무관하게 우선한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    const sessionId = 'codex:snapshot-identity-authority';
    const oldPresence = [{
      kind: 'tmux', linkAuthority: 'explicit-session-id', id: 'tmux:OldLinux:%7', distro: 'OldLinux',
      sessionId: 'wsl:OldLinux:tmux:$1', sessionName: 'old-session',
      paneId: 'wsl:OldLinux:tmux:$1:window:@1:pane:%7', paneNativeId: '%7',
    }];
    const livePresence = [{
      kind: 'tmux', linkAuthority: 'explicit-session-id', id: 'tmux:NewLinux:%8', distro: 'NewLinux',
      sessionId: 'wsl:NewLinux:tmux:$2', sessionName: 'live-session',
      paneId: 'wsl:NewLinux:tmux:$2:window:@2:pane:%8', paneNativeId: '%8',
    }];
    const state = {
      selectedId: sessionId,
      details: new Map([[sessionId, {
        id: sessionId,
        provider: 'claude',
        externalId: 'old-external-id',
        cwd: 'D:\\old-workspace',
        environment: { kind: 'wsl', distro: 'OldLinux' },
        runtimePresence: oldPresence,
        updatedAt: '2026-08-05T12:00:00.000Z',
        messages: [{ role: 'assistant', text: '전체 기록은 detail에서 유지' }],
      }]]),
      snapshot: {
        sessions: [{
          id: sessionId,
          provider: 'codex',
          externalId: 'live-external-id',
          cwd: 'D:\\live-workspace',
          environment: { kind: 'windows', distro: '' },
          runtimePresence: livePresence,
          // Deliberately older: connection identity must still be authoritative.
          updatedAt: '2026-08-05T11:00:00.000Z',
        }],
      },
    };
    const sandbox = {
      window: {
        LoadToAgentAppFactories: {},
        LoadToAgentI18n: { t: key => key, errorText: error => String(error?.message || error || '') },
        LoadToAgentRendererUtils: { reportRecoverableError: () => {} },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-agent-actions.js' });
    const actions = sandbox.window.LoadToAgentAppFactories.createAgentActions({
      state,
      providerInfo: provider => ({ label: provider }),
      isLiveSession: () => true,
    });

    const selected = actions.selectedSession();

    assert.equal(selected.provider, 'codex');
    assert.equal(selected.externalId, 'live-external-id');
    assert.equal(selected.cwd, 'D:\\live-workspace');
    assert.equal(selected.environment.kind, 'windows');
    assert.equal(selected.runtimePresence[0].sessionName, 'live-session');
    assert.equal(selected.messages[0].text, '전체 기록은 detail에서 유지');
    assert.equal(selected.updatedAt, '2026-08-05T12:00:00.000Z', '오래된 snapshot은 history timestamp를 되돌리면 안 됩니다.');
  });

  test('legacy tmux PTY는 writable bind하지 않고 app-owned signed resume PTY를 별도로 만든다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const lifecycle = [];
    const createCalls = [];
    const state = {
      snapshot: {
        tmux: {
          distros: [{
            name: 'FixtureLinux',
            sessions: [{
              name: 'fixture-session-a',
              windows: [{
                index: 0,
                nativeId: '@3',
                name: 'fixture-window-a',
                panes: [{
                  id: 'fixture-pane-a',
                  nativeId: '%7',
                  command: 'codex',
                  agent: { linkedSessionId: 'codex:legacy-tmux' },
                }],
              }],
            }],
          }],
        },
      },
      sessions: [{
        id: 'terminal:legacy-tmux-a',
        type: 'tmux',
        bridgeId: 'codex:legacy-tmux',
        distro: 'FixtureLinux',
        tmuxSession: 'fixture-session-a',
        tmuxWindow: '@3',
        tmuxPane: '%7',
        status: 'running',
        pid: 7701,
      }],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: ['FixtureLinux'],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalClose: async id => {
            lifecycle.push(`close:${id}`);
            state.sessions = state.sessions.filter(item => item.id !== id);
            return { ok: true };
          },
          terminalCreate: async options => {
            createCalls.push(options);
            lifecycle.push(`create:${options.args[1]}`);
            const created = {
              id: 'terminal:legacy-tmux-b',
              type: 'agent',
              provider: options.provider,
              bridgeId: options.bridgeId,
              distro: options.distro,
              cwd: options.cwd,
              agentResumeSessionId: options.args[1],
              agentConnectionSignature: options.agentConnectionSignature,
              backend: 'direct',
              conversationBound: true,
              status: 'running',
              pid: 7702,
              title: options.title,
            };
            state.sessions.push(created);
            return created;
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      refreshSessions: async () => {},
      resumeSupport: session => ({ supported: true, provider: session.provider, sessionId: session.externalId, args: ['resume', session.externalId] }),
      resumeLaunchArgs: support => [...support.args],
      preferredWorkspace: () => '/workspace',
      providerLabel: provider => provider,
      tmuxTargetKey: (distro, pane) => `${distro}:${pane}`,
      terminalTypeLabel: () => 'tmux',
    });
    const firstIdentity = {
      id: 'codex:legacy-tmux',
      provider: 'codex',
      externalId: '019f-legacy-tmux',
      cwd: '/workspace',
      environment: { kind: 'wsl', distro: 'FixtureLinux' },
      runtimePresence: [{
        kind: 'tmux', linkAuthority: 'explicit-session-id', id: 'tmux:FixtureLinux:%7', distro: 'FixtureLinux', paneId: 'fixture-pane-a', paneNativeId: '%7',
      }],
    };
    assert.equal(actions.bindAgentConnection(firstIdentity, {
      id: 'terminal:legacy-tmux-a', kind: 'terminal', terminalId: 'terminal:legacy-tmux-a',
    }), false);

    state.snapshot.tmux.distros[0].sessions[0] = {
      name: 'fixture-session-b',
      windows: [{
        index: 1,
        nativeId: '@4',
        name: 'fixture-window-b',
        panes: [{
          id: 'fixture-pane-b',
          nativeId: '%8',
          command: 'codex',
          agent: { linkedSessionId: firstIdentity.id },
        }],
      }],
    };
    const secondIdentity = {
      ...firstIdentity,
      runtimePresence: [{
        kind: 'tmux', linkAuthority: 'explicit-session-id', id: 'tmux:FixtureLinux:%8', distro: 'FixtureLinux', paneId: 'fixture-pane-b', paneNativeId: '%8',
      }],
    };

    const target = await actions.ensureForAgent(secondIdentity);

    assert.equal(target.id, 'terminal:legacy-tmux-b');
    assert.deepStrictEqual(lifecycle, ['create:019f-legacy-tmux']);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].type, 'agent');
    assert.equal(createCalls[0].provider, 'codex');
    assert.equal(createCalls[0].tmuxPane, undefined);
  });

  test('외부 tmux pane 이동은 stable conversation 서명을 바꾸거나 app-owned PTY를 retire하지 않는다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const lifecycle = [];
    const createCalls = [];
    const state = {
      snapshot: {
        tmux: {
          distros: [{
            name: 'FixtureLinux',
            sessions: [{
              id: 'wsl:FixtureLinux:tmux:$1',
              name: 'fixture-session-a',
              windows: [{
                index: 0,
                nativeId: '@3',
                name: 'fixture-window-a',
                panes: [{
                  id: 'wsl:FixtureLinux:tmux:$1:window:@3:pane:%7',
                  nativeId: '%7',
                  command: 'codex',
                  agent: { linkedSessionId: 'codex:move-pane' },
                }],
              }],
            }],
          }],
        },
      },
      sessions: [],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: ['FixtureLinux'],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            createCalls.push(options);
            const created = {
              id: `terminal:move-pane-${createCalls.length}`,
              type: 'agent',
              provider: options.provider,
              bridgeId: options.bridgeId,
              distro: options.distro,
              cwd: options.cwd,
              agentResumeSessionId: options.args[1],
              agentConnectionSignature: options.agentConnectionSignature,
              backend: 'direct',
              conversationBound: true,
              status: 'running',
              pid: 7750 + createCalls.length,
              title: options.title,
            };
            lifecycle.push(`create:${options.args[1]}`);
            state.sessions.push(created);
            return created;
          },
          terminalRetire: async id => {
            lifecycle.push(`retire:${id}`);
            state.sessions = state.sessions.filter(item => item.id !== id);
            return { ok: true };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      refreshSessions: async () => {},
      resumeSupport: session => ({ supported: true, provider: session.provider, sessionId: session.externalId, args: ['resume', session.externalId] }),
      resumeLaunchArgs: support => [...support.args],
      preferredWorkspace: () => '/workspace',
      providerLabel: provider => provider,
      tmuxTargetKey: (distro, pane) => `${distro}:${pane}`,
      terminalTypeLabel: () => 'tmux',
    });
    const firstIdentity = {
      id: 'codex:move-pane',
      provider: 'codex',
      externalId: '019f-move-pane',
      cwd: '/workspace',
      environment: { kind: 'wsl', distro: 'FixtureLinux' },
      runtimePresence: [{
        kind: 'tmux', linkAuthority: 'explicit-session-id', id: 'tmux:FixtureLinux:%7', distro: 'FixtureLinux',
        sessionId: 'wsl:FixtureLinux:tmux:$1', sessionName: 'fixture-session-a',
        paneId: 'wsl:FixtureLinux:tmux:$1:window:@3:pane:%7', paneNativeId: '%7',
      }],
    };
    const first = await actions.ensureForAgent(firstIdentity);

    state.snapshot.tmux.distros[0].sessions = [{
      id: 'wsl:FixtureLinux:tmux:$2',
      name: 'fixture-session-b',
      windows: [{
        index: 1,
        nativeId: '@4',
        name: 'fixture-window-b',
        panes: [{
          id: 'wsl:FixtureLinux:tmux:$2:window:@4:pane:%7',
          nativeId: '%7',
          command: 'codex',
          agent: { linkedSessionId: firstIdentity.id },
        }],
      }],
    }];
    const movedIdentity = {
      ...firstIdentity,
      runtimePresence: [{
        kind: 'tmux', linkAuthority: 'explicit-session-id', id: 'tmux:FixtureLinux:%7', distro: 'FixtureLinux',
        sessionId: 'wsl:FixtureLinux:tmux:$2', sessionName: 'fixture-session-b',
        paneId: 'wsl:FixtureLinux:tmux:$2:window:@4:pane:%7', paneNativeId: '%7',
      }],
    };
    assert.equal(actions.agentConnectionSignature(firstIdentity), actions.agentConnectionSignature(movedIdentity));

    const moved = await actions.ensureForAgent(movedIdentity);

    assert.equal(first.id, 'terminal:move-pane-1');
    assert.equal(moved.id, 'terminal:move-pane-1');
    assert.deepStrictEqual(lifecycle, ['create:019f-move-pane']);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].distro, 'FixtureLinux');
    assert.equal(createCalls[0].tmuxPane, undefined);
    assert.deepStrictEqual(state.sessions.map(item => item.id), ['terminal:move-pane-1']);
  });

  test('느린 A 연결 중 B identity가 대체하면 A PTY를 닫고 B만 연결한다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const createCalls = [];
    const retireCalls = [];
    const closeCalls = [];
    const stopCalls = [];
    const commandCalls = [];
    let releaseFirstCreate;
    let markFirstCreateStarted;
    const firstCreateGate = new Promise(resolve => { releaseFirstCreate = resolve; });
    const firstCreateStarted = new Promise(resolve => { markFirstCreateStarted = resolve; });
    const state = {
      snapshot: null,
      sessions: [],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: [],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            createCalls.push(options);
            const ordinal = createCalls.length;
            if (ordinal === 1) {
              markFirstCreateStarted();
              await firstCreateGate;
            }
            const created = {
              id: ordinal === 1 ? 'terminal:superseded-a' : 'terminal:current-b',
              type: 'agent',
              provider: options.provider,
              bridgeId: options.bridgeId,
              agentResumeSessionId: options.args[1],
              agentConnectionSignature: options.agentConnectionSignature,
              backend: 'direct',
              conversationBound: true,
              cwd: options.cwd,
              distro: options.distro,
              status: 'running',
              pid: 7500 + ordinal,
              title: options.title,
            };
            state.sessions.push(created);
            return created;
          },
          terminalRetire: async id => {
            retireCalls.push(id);
            state.sessions = state.sessions.filter(item => item.id !== id);
            return { ok: true };
          },
          terminalClose: async id => {
            closeCalls.push(id);
            state.sessions = state.sessions.filter(item => item.id !== id);
            return { ok: true };
          },
          terminalStop: async id => {
            stopCalls.push(id);
            state.sessions = state.sessions.map(item => item.id === id ? { ...item, status: 'stopped' } : item);
            return { ok: true };
          },
          terminalCommand: async (...args) => {
            commandCalls.push(args);
            return { ok: true };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      refreshSessions: async () => {},
      resumeSupport: current => ({
        supported: true,
        provider: current.provider,
        sessionId: current.externalId,
        args: ['resume', current.externalId],
      }),
      resumeLaunchArgs: support => [...support.args],
      preferredWorkspace: () => 'D:\\workspace',
      providerLabel: provider => provider,
      terminalTypeLabel: () => 'Codex',
    });
    const firstIdentity = {
      id: 'codex:superseded-identity',
      provider: 'codex',
      externalId: '019f-superseded-a',
      cwd: 'D:\\workspace-a',
      runtimePresence: [],
    };
    const secondIdentity = {
      ...firstIdentity,
      externalId: '019f-current-b',
      cwd: 'D:\\workspace-b',
    };

    const firstOutcomePromise = actions.ensureForAgent(firstIdentity).then(
      value => ({ value }),
      error => ({ error }),
    );
    await firstCreateStarted;
    const secondPromise = actions.ensureForAgent(secondIdentity);
    releaseFirstCreate();
    const [firstOutcome, second] = await Promise.all([firstOutcomePromise, secondPromise]);

    assert.equal(firstOutcome.value, undefined, '대체된 A 요청에 A PTY를 반환하면 안 됩니다.');
    assert.equal(firstOutcome.error?.code, 'TERMINAL_ENSURE_SUPERSEDED');
    assert.equal(second.id, 'terminal:current-b');
    assert.deepStrictEqual(retireCalls, ['terminal:superseded-a'], '대체된 PTY의 process tree 종료 ack를 받아야 합니다.');
    assert.deepStrictEqual(closeCalls, []);
    assert.deepStrictEqual(stopCalls, []);
    assert.equal(createCalls.length, 2);
    assert.deepStrictEqual(Array.from(createCalls[0].args), ['resume', firstIdentity.externalId]);
    assert.deepStrictEqual(Array.from(createCalls[1].args), ['resume', secondIdentity.externalId]);
    assert.equal(createCalls[0].initialCommand, '');
    assert.equal(createCalls[1].initialCommand, '');
    assert.equal(commandCalls.length, 0, 'identity 교체 중에 질문을 전송하면 안 됩니다.');
    assert.deepStrictEqual(state.sessions.filter(item => item.status === 'running').map(item => item.id), ['terminal:current-b']);
    assert.deepStrictEqual(Array.from(actions.agentTargets(secondIdentity), target => target.id), ['terminal:current-b']);
  });

  test('느린 A 연결을 B가 대체해도 superseded cleanup 실패 시 B를 만들지 않고 fail closed 한다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const createCalls = [];
    const retireCalls = [];
    const closeCalls = [];
    const stopCalls = [];
    let releaseFirstCreate;
    let markFirstCreateStarted;
    const firstCreateGate = new Promise(resolve => { releaseFirstCreate = resolve; });
    const firstCreateStarted = new Promise(resolve => { markFirstCreateStarted = resolve; });
    const state = {
      snapshot: null,
      sessions: [],
      suppressedTmuxTargets: new Set(),
      platform: { id: 'win32' },
      wslDistros: [],
    };
    const sandbox = {
      window: {
        LoadToAgentI18n: { t: key => key },
        loadtoagent: {
          terminalCreate: async options => {
            createCalls.push(options);
            markFirstCreateStarted();
            await firstCreateGate;
            const created = {
              id: 'terminal:superseded-cleanup-fail-a',
              type: 'agent',
              provider: options.provider,
              bridgeId: options.bridgeId,
              agentResumeSessionId: options.args[1],
              agentConnectionSignature: options.agentConnectionSignature,
              backend: 'direct',
              conversationBound: true,
              cwd: options.cwd,
              distro: options.distro,
              status: 'running',
              pid: 7801,
              title: options.title,
            };
            state.sessions = [created];
            return created;
          },
          terminalRetire: async id => {
            retireCalls.push(id);
            return { ok: false, error: 'fixture superseded retire rejected' };
          },
          terminalClose: async id => {
            closeCalls.push(id);
            return { ok: false, error: 'fixture superseded close rejected' };
          },
          terminalStop: async id => {
            stopCalls.push(id);
            return { ok: false, error: 'fixture superseded stop rejected' };
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-agent.js' });
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      refreshSessions: async () => {},
      resumeSupport: current => ({
        supported: true,
        provider: current.provider,
        sessionId: current.externalId,
        args: ['resume', current.externalId],
      }),
      resumeLaunchArgs: support => [...support.args],
      preferredWorkspace: () => 'D:\\workspace',
      providerLabel: provider => provider,
      terminalTypeLabel: () => 'Codex',
    });
    const firstIdentity = {
      id: 'codex:superseded-cleanup-fail',
      provider: 'codex',
      externalId: '019f-superseded-cleanup-fail-a',
      cwd: 'D:\\workspace-a',
      runtimePresence: [],
    };
    const secondIdentity = {
      ...firstIdentity,
      externalId: '019f-superseded-cleanup-fail-b',
      cwd: 'D:\\workspace-b',
    };

    const firstOutcomePromise = actions.ensureForAgent(firstIdentity).then(
      value => ({ value }),
      error => ({ error }),
    );
    await firstCreateStarted;
    const secondOutcomePromise = actions.ensureForAgent(secondIdentity).then(
      value => ({ value }),
      error => ({ error }),
    );
    releaseFirstCreate();
    const [firstOutcome, secondOutcome] = await Promise.all([firstOutcomePromise, secondOutcomePromise]);

    assert.equal(firstOutcome.error?.code, 'TERMINAL_CONNECTION_CLEANUP_FAILED');
    assert.equal(secondOutcome.error?.code, 'TERMINAL_CONNECTION_CLEANUP_FAILED');
    assert.equal(createCalls.length, 1, 'superseded cleanup 실패 뒤 B 생성으로 진행하면 안 됩니다.');
    assert.deepStrictEqual(retireCalls, ['terminal:superseded-cleanup-fail-a']);
    assert.deepStrictEqual(closeCalls, [], 'terminalRetire 실패를 fallback close로 우회하면 안 됩니다.');
    assert.deepStrictEqual(stopCalls, []);
    assert.deepStrictEqual(Array.from(actions.agentTargets(firstIdentity), target => target.id), ['terminal:superseded-cleanup-fail-a'],
      'cleanup 실패 시 A signature를 유지해야 합니다.');
    assert.deepStrictEqual(Array.from(actions.agentTargets(secondIdentity), target => target.id), []);
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

    const agentSession = {
      id: 'claude:session-123',
      provider: 'claude',
      externalId: 'session-123',
      cwd: 'D:\\workspace',
      runtimePresence: [],
    };
    Object.assign(state.sessions[0], {
      agentResumeSessionId: agentSession.externalId,
      agentConnectionSignature: actions.agentConnectionSignature(agentSession),
      backend: 'direct',
      conversationBound: true,
      cwd: agentSession.cwd,
      distro: '',
    });
    const result = await actions.resumeForAgent(agentSession, '중복 없이 이어서 보내줘', true, { focus: false });

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

  test('unsigned detached 관리 터미널은 writable target이나 재연결 경로가 아니다', async () => {
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

    assert.deepStrictEqual(Array.from(targets), []);
    assert.deepStrictEqual(calls, []);
  });

  test('터미널 목록보다 먼저 도착한 브리지 presence만으로 writable PTY를 추측하지 않는다', () => {
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

    assert.deepStrictEqual(JSON.parse(JSON.stringify(targets)), []);
  });

  test('종료된 PTY 행이 있으면 늦은 runtime presence로 쓰기 대상을 되살리지 않는다', () => {
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
        sessions: [{
          id: 'terminal:stopped-presence',
          type: 'agent',
          provider: 'codex',
          bridgeId: 'codex:stopped-presence',
          status: 'stopped',
        }],
        suppressedTmuxTargets: new Set(),
      },
      terminalTypeLabel: () => 'Codex',
    });

    const targets = actions.agentTargets({
      id: 'codex:stopped-presence',
      provider: 'codex',
      runtimePresence: [{
        kind: 'bridge',
        terminalId: 'terminal:stopped-presence',
        pid: 42420,
        runtime: 'codex',
      }],
    });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(targets)), []);
  });

  test('authoritative 목록에서 삭제된 PTY는 남은 runtime presence만으로 복원하지 않는다', () => {
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
        terminalSessionRevision: 3,
      },
      terminalTypeLabel: () => 'Codex',
    });

    const targets = actions.agentTargets({
      id: 'codex:removed-presence',
      provider: 'codex',
      runtimePresence: [{
        kind: 'bridge',
        terminalId: 'terminal:removed-presence',
        pid: 42421,
        runtime: 'codex',
      }],
    });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(targets)), []);
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

  test('대화 응답 중단은 signed app terminal에만 Ctrl+C를 전달하고 외부 tmux를 거부한다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    const terminalSignals = [];
    const tmuxKeys = [];
    const agentSession = {
      id: 'claude:interrupt',
      provider: 'claude',
      externalId: 'claude-history-interrupt',
      environment: { kind: 'windows' },
    };
    const terminal = {
      id: 'terminal-main',
      type: 'agent',
      provider: 'claude',
      bridgeId: agentSession.id,
      agentResumeSessionId: agentSession.externalId,
      agentConnectionSignature: '',
      backend: 'direct',
      conversationBound: true,
      status: 'running',
      distro: '',
      title: 'Claude terminal',
      pid: 41001,
    };
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
    const state = { platform: { id: 'win32' }, snapshot: null, sessions: [terminal] };
    const actions = sandbox.window.LoadToAgentTerminalAgentActions({
      state,
      init: async () => {},
      notice: () => {},
      terminalTypeLabel: () => 'Claude',
    });
    terminal.agentConnectionSignature = actions.agentConnectionSignature(agentSession);

    await actions.interruptAgent(agentSession, terminal.id);
    terminal.agentConnectionSignature = 'acs1:wrong';
    await assert.rejects(
      actions.interruptAgent(agentSession, terminal.id),
      /target_expired|no_input_target/u,
    );
    terminal.agentConnectionSignature = actions.agentConnectionSignature(agentSession);
    terminal.backend = 'managed-tmux';
    await assert.rejects(
      actions.interruptAgent(agentSession, terminal.id),
      /target_expired|no_input_target/u,
    );
    await assert.rejects(
      actions.interruptAgent(agentSession, 'tmux:FixtureLinux:%7'),
      /target_expired|no_input_target/u,
    );

    assert.deepStrictEqual(terminalSignals, [['terminal-main', 'interrupt']]);
    assert.deepStrictEqual(tmuxKeys, []);
  });

  test('실제 PTY 대화 composer는 pending 기록 없이도 Ctrl+C 중단을 한 번만 보내고 연결 끊김에는 비활성화한다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    const session = { id: 'codex:bound-interrupt', provider: 'codex', externalId: 'bound-interrupt', cwd: root };
    const target = {
      id: 'terminal:bound-interrupt',
      kind: 'terminal',
      terminalId: 'terminal:bound-interrupt',
      label: 'Codex PTY',
    };
    const state = {
      snapshot: { sessions: [session] },
      details: new Map(),
      selectedId: session.id,
      agentCommandTargets: new Map(),
      agentCommandDrafts: new Map([[session.id, '작성 중인 질문']]),
      agentCommandSending: new Set(),
      pendingConversationMessages: new Map(),
      conversationInterruptRequests: new Set(),
    };
    const interrupted = [];
    let releaseInterrupt;
    const pendingInterrupt = new Promise(resolve => { releaseInterrupt = resolve; });
    const sandbox = {
      clearTimeout,
      window: {
        LoadToAgentAppFactories: {},
        LoadToAgentI18n: {
          t: key => key === 'agent.terminal_interrupt' ? '응답 중단(Ctrl+C)' : key,
          errorText: (_error, key) => key,
        },
        LoadToAgentRendererUtils: { reportRecoverableError: () => {} },
        LoadToAgentTerminal: {
          agentTargets: () => [target],
          resumeSupport: () => ({ supported: false }),
          interruptAgent: async (value, targetId) => {
            interrupted.push([value, targetId]);
            await pendingInterrupt;
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-agent-actions.js' });
    const actions = sandbox.window.LoadToAgentAppFactories.createAgentActions({
      $: () => null,
      esc: value => String(value),
      state,
      isLiveSession: () => true,
      providerInfo: () => ({ label: 'Codex' }),
      conversationMessageKey: value => String(value?.id || ''),
      toast: () => {},
      render: () => {},
      renderDrawer: () => {},
    });

    const connectedHtml = actions.agentCommandComposer(session, {
      conversation: true,
      terminal: true,
      connectionReady: true,
    });
    assert.match(connectedHtml, /data-terminal-interrupt="codex:bound-interrupt"/u);
    assert.match(connectedHtml, /응답 중단\(Ctrl\+C\)/u);
    assert.equal(connectedHtml.includes('data-conversation-slash-menu'), false);
    assert.equal(connectedHtml.includes('aria-haspopup="listbox"'), false);
    const connectedButton = connectedHtml.match(/<button class="conversation-interrupt terminal-interrupt"[\s\S]*?<\/button>/u)?.[0] || '';
    assert.equal(/\sdisabled(?:\s|>)/u.test(connectedButton), false);

    const disconnectedHtml = actions.agentCommandComposer(session, {
      conversation: true,
      terminal: true,
      connectionReady: false,
    });
    const disconnectedButton = disconnectedHtml.match(/<button class="conversation-interrupt terminal-interrupt"[\s\S]*?<\/button>/u)?.[0] || '';
    assert.match(disconnectedButton, /\sdisabled(?:\s|>)/u);

    const first = actions.interruptAgentTerminal(session.id);
    const second = actions.interruptAgentTerminal(session.id);
    await Promise.resolve();
    assert.equal(interrupted.length, 1, '빠른 더블클릭도 terminal interrupt를 한 번만 보내야 합니다.');
    assert.equal(interrupted[0][0].id, session.id);
    assert.equal(interrupted[0][1], 'terminal:bound-interrupt');
    assert.equal(state.agentCommandDrafts.get(session.id), '작성 중인 질문', 'Ctrl+C 중단은 draft를 변경하면 안 됩니다.');
    releaseInterrupt();
    await Promise.all([first, second]);
  });

  function createQuickResponseHarness() {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    const sessionA = { id: 'codex:quick-a', provider: 'codex', externalId: 'quick-a', cwd: root };
    const sessionB = { id: 'codex:quick-b', provider: 'codex', externalId: 'quick-b', cwd: root };
    const state = {
      snapshot: { sessions: [sessionA, sessionB] },
      details: new Map(),
      selectedId: '',
      drawerMode: '',
      drawerTab: '',
      agentCommandRoutes: new Map(),
      agentCommandTargets: new Map(),
      agentCommandDrafts: new Map(),
      agentCommandSending: new Set(),
      pendingConversationMessages: new Map(),
      conversationInterruptRequests: new Set(),
    };
    const listeners = new Map();
    const frames = new Map();
    const observers = [];
    const targets = new Map();
    const opened = [];
    const submissions = [];
    const errors = [];
    let nextFrame = 1;
    let embedded = {};
    let activeForm = null;
    let drawerOpen = false;
    let preserveFormOnOpen = false;

    const composer = {
      dataset: { mode: 'terminal' },
      querySelector(selector) {
        return activeForm && selector === `[data-agent-command-form="${activeForm.sessionId}"]` ? activeForm : null;
      },
    };
    const drawer = {
      dataset: { mode: 'session', terminalChat: 'true', conversationSurface: 'connecting' },
      classList: { contains: name => name === 'open' && drawerOpen },
      querySelector: selector => selector === '#drawerComposer' ? composer : composer.querySelector(selector),
    };
    class FakeMutationObserver {
      constructor(callback) {
        this.callback = callback;
        this.active = false;
        observers.push(this);
      }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    }
    const notifyMutation = () => {
      for (const observer of observers) if (observer.active) observer.callback([]);
    };
    const requestFrame = callback => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    };
    const cancelFrame = id => frames.delete(id);
    const flushFrames = () => {
      let turns = 0;
      while (frames.size) {
        assert.ok(turns++ < 20, 'quick response frame queue가 안정화되어야 합니다.');
        const queued = [...frames.values()];
        frames.clear();
        for (const callback of queued) callback();
      }
    };
    const addEventListener = (name, listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    };
    const removeEventListener = (name, listener) => listeners.get(name)?.delete(listener);
    const dispatchTerminalChange = sessionId => {
      for (const listener of [...(listeners.get('loadtoagent:drawer-terminal-targets-changed') || [])]) {
        listener({ detail: { sessionId } });
      }
    };
    const documentObject = { querySelector: selector => selector === '#detailDrawer' ? drawer : null };
    const windowObject = {
      LoadToAgentAppFactories: {},
      LoadToAgentI18n: { t: key => key, errorText: (_error, key) => key },
      LoadToAgentRendererUtils: { reportRecoverableError: (scope, error) => errors.push([scope, error]) },
      LoadToAgentTerminal: {
        embeddedState: () => ({ ...embedded }),
        agentTargets: session => targets.get(session.id) || [],
      },
      addEventListener,
      removeEventListener,
    };
    const sandbox = {
      window: windowObject,
      document: documentObject,
      CSS: { escape: value => String(value) },
      MutationObserver: FakeMutationObserver,
      requestAnimationFrame: requestFrame,
      cancelAnimationFrame: cancelFrame,
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-agent-actions.js' });
    const actions = windowObject.LoadToAgentAppFactories.createAgentActions({
      state,
      isLiveSession: () => true,
      providerInfo: provider => ({ label: provider }),
      toast: () => {},
      openDrawer: sessionId => {
        opened.push(sessionId);
        state.selectedId = sessionId;
        state.drawerMode = 'session';
        state.drawerTab = 'chat';
        drawerOpen = true;
        drawer.dataset.mode = 'session';
        drawer.dataset.terminalChat = 'true';
        drawer.dataset.conversationSurface = 'connecting';
        if (!preserveFormOnOpen) activeForm = null;
        embedded = {};
        notifyMutation();
      },
    });
    const connectForm = (sessionId, terminalId) => {
      const input = { value: '', disabled: false, dataset: { agentCommandDraft: sessionId } };
      const submit = { disabled: false };
      const form = {
        sessionId,
        dataset: {
          agentCommandForm: sessionId,
          agentCommandProvider: sessionId.split(':')[0],
          agentCommandRouting: 'conversation',
          agentCommandRouteSelected: 'direct',
          agentCommandInputModeSelected: 'terminal',
          agentTerminalReady: 'true',
          agentSendAvailable: 'true',
        },
        closest: selector => selector === '#drawerComposer' ? composer : null,
        querySelector: selector => selector === '[data-agent-command-draft]'
          ? input
          : selector === '[type="submit"]' ? submit : null,
        requestSubmit: () => submissions.push({ sessionId, terminalId, command: input.value }),
      };
      activeForm = form;
      embedded = { connected: true, agentSessionId: sessionId, terminalId };
      drawer.dataset.conversationSurface = 'pty';
      notifyMutation();
      return form;
    };

    return {
      actions,
      state,
      sessionA,
      sessionB,
      targets,
      opened,
      submissions,
      errors,
      window: windowObject,
      drawerRoot: drawer,
      noFormRoot: { querySelector: () => null },
      requestFrame,
      flushFrames,
      notifyMutation,
      dispatchTerminalChange,
      connectForm,
      setEmbedded(value) { embedded = { ...(value || {}) }; },
      setPreserveFormOnOpen(value) { preserveFormOnOpen = Boolean(value); },
      switchDrawer(sessionId) {
        state.selectedId = sessionId;
        state.drawerMode = 'session';
        state.drawerTab = 'chat';
        drawerOpen = true;
        drawer.dataset.conversationSurface = 'connecting';
        activeForm = null;
        embedded = {};
        notifyMutation();
      },
    };
  }

  test('빠른 응답은 drawer PTY 비동기 렌더 뒤 signed direct target에 정확히 한 번 제출한다', () => {
    const harness = createQuickResponseHarness();
    const target = {
      id: 'terminal:quick-a',
      terminalId: 'terminal:quick-a',
      kind: 'terminal',
      label: 'Codex PTY',
    };
    // The drawer's listener is registered before the per-click waiter. Its
    // animation frame therefore renders the connected composer first.
    harness.window.addEventListener('loadtoagent:drawer-terminal-targets-changed', event => {
      if (event.detail?.sessionId !== harness.sessionA.id) return;
      harness.requestFrame(() => {
        harness.targets.set(harness.sessionA.id, [target]);
        harness.connectForm(harness.sessionA.id, target.terminalId);
      });
    });

    harness.actions.quickRespond(harness.sessionA.id, '승인하고 계속해 주세요.', harness.noFormRoot);
    harness.actions.quickRespond(harness.sessionA.id, '중복 클릭은 보내지 마세요.', harness.noFormRoot);
    harness.flushFrames();
    assert.equal(harness.submissions.length, 0, 'PTY가 연결되기 전에는 제출하면 안 됩니다.');
    assert.deepStrictEqual(harness.opened, [harness.sessionA.id]);

    harness.dispatchTerminalChange(harness.sessionA.id);
    harness.flushFrames();
    harness.dispatchTerminalChange(harness.sessionA.id);
    harness.flushFrames();

    assert.deepStrictEqual(harness.submissions, [{
      sessionId: harness.sessionA.id,
      terminalId: target.terminalId,
      command: '승인하고 계속해 주세요.',
    }]);
    assert.equal(harness.state.agentCommandDrafts.get(harness.sessionA.id), '승인하고 계속해 주세요.');
    assert.deepStrictEqual(harness.errors, []);
  });

  test('transport-ready 관리 form은 빈 draft 때문에 submit이 disabled여도 빠른 응답을 즉시 제출한다', () => {
    const harness = createQuickResponseHarness();
    const target = {
      id: 'terminal:quick-a', terminalId: 'terminal:quick-a', kind: 'terminal', label: 'Codex PTY',
    };
    harness.targets.set(harness.sessionA.id, [target]);
    const form = harness.connectForm(harness.sessionA.id, target.terminalId);
    form.dataset.agentCommandInputModeSelected = 'conversation';
    form.closest = () => null;
    form.querySelector('[data-agent-command-draft]').value = '';
    form.querySelector('[type="submit"]').disabled = true;
    const managementRoot = { querySelector: () => form };

    harness.actions.quickRespond(harness.sessionA.id, '승인하고 바로 계속', managementRoot);
    harness.flushFrames();

    assert.deepStrictEqual(harness.submissions, [{
      sessionId: harness.sessionA.id,
      terminalId: target.terminalId,
      command: '승인하고 바로 계속',
    }]);
    assert.deepStrictEqual(harness.opened, [], 'transport-ready form은 drawer fallback을 열면 안 됩니다.');
  });

  test('preserved disabled form의 빠른 응답은 PTY ready까지 기다린 뒤 한 번만 제출한다', () => {
    const harness = createQuickResponseHarness();
    const target = {
      id: 'terminal:quick-a', terminalId: 'terminal:quick-a', kind: 'terminal', label: 'Codex PTY',
    };
    harness.targets.set(harness.sessionA.id, [target]);
    const form = harness.connectForm(harness.sessionA.id, target.terminalId);
    const submit = form.querySelector('[type="submit"]');
    form.dataset.agentTerminalReady = 'false';
    form.dataset.agentSendAvailable = 'false';
    submit.disabled = true;
    harness.setEmbedded({ connected: false, agentSessionId: harness.sessionA.id, terminalId: target.terminalId });
    harness.setPreserveFormOnOpen(true);

    harness.actions.quickRespond(harness.sessionA.id, '연결되면 한 번만 전달', harness.drawerRoot);
    harness.flushFrames();
    assert.equal(harness.submissions.length, 0);
    assert.deepStrictEqual(harness.opened, [harness.sessionA.id], '미준비 form도 drawer PTY 대기 경로를 써야 합니다.');

    form.dataset.agentTerminalReady = 'true';
    form.dataset.agentSendAvailable = 'true';
    submit.disabled = false;
    harness.setEmbedded({ connected: true, agentSessionId: harness.sessionA.id, terminalId: target.terminalId });
    harness.drawerRoot.dataset.conversationSurface = 'pty';
    harness.notifyMutation();
    harness.dispatchTerminalChange(harness.sessionA.id);
    harness.flushFrames();
    harness.dispatchTerminalChange(harness.sessionA.id);
    harness.flushFrames();

    assert.deepStrictEqual(harness.submissions, [{
      sessionId: harness.sessionA.id,
      terminalId: target.terminalId,
      command: '연결되면 한 번만 전달',
    }]);
  });

  test('다른 세션의 present form은 직접 제출하지 않고 현재 대화 PTY로 다시 검증한다', () => {
    const harness = createQuickResponseHarness();
    const wrongTarget = {
      id: 'terminal:quick-b', terminalId: 'terminal:quick-b', kind: 'terminal', label: 'B PTY',
    };
    harness.targets.set(harness.sessionB.id, [wrongTarget]);
    const wrongForm = harness.connectForm(harness.sessionB.id, wrongTarget.terminalId);
    const deceptiveRoot = { querySelector: () => wrongForm };

    harness.actions.quickRespond(harness.sessionA.id, 'A 대화 응답', deceptiveRoot);
    harness.flushFrames();

    assert.deepStrictEqual(harness.submissions, []);
    assert.deepStrictEqual(harness.opened, [harness.sessionA.id]);
    assert.equal(harness.state.agentCommandDrafts.get(harness.sessionA.id), 'A 대화 응답');
  });

  test('빠른 응답 대기 중 drawer가 다른 대화로 바뀌면 교차 세션 제출을 fail-closed 한다', () => {
    const harness = createQuickResponseHarness();
    harness.actions.quickRespond(harness.sessionA.id, 'A 대화에만 전달', harness.noFormRoot);
    harness.flushFrames();

    harness.switchDrawer(harness.sessionB.id);
    harness.flushFrames();
    harness.targets.set(harness.sessionA.id, [{
      id: 'terminal:quick-a', terminalId: 'terminal:quick-a', kind: 'terminal', label: 'A PTY',
    }]);
    harness.connectForm(harness.sessionA.id, 'terminal:quick-a');
    harness.dispatchTerminalChange(harness.sessionA.id);
    harness.flushFrames();

    assert.deepStrictEqual(harness.submissions, []);
    assert.equal(harness.state.agentCommandDrafts.get(harness.sessionA.id), 'A 대화에만 전달');
  });

  test('빠른 응답은 embedded PTY와 일치하는 signed target이 생길 때까지 제출하지 않는다', () => {
    const harness = createQuickResponseHarness();
    harness.actions.quickRespond(harness.sessionA.id, '정확한 PTY에만 전달', harness.noFormRoot);
    harness.flushFrames();
    harness.connectForm(harness.sessionA.id, 'terminal:quick-a');
    harness.targets.set(harness.sessionA.id, [{
      id: 'terminal:wrong', terminalId: 'terminal:wrong', kind: 'terminal', label: 'Wrong PTY',
    }]);
    harness.dispatchTerminalChange(harness.sessionA.id);
    harness.flushFrames();
    assert.deepStrictEqual(harness.submissions, []);

    harness.targets.set(harness.sessionA.id, [{
      id: 'terminal:quick-a', terminalId: 'terminal:quick-a', kind: 'terminal', label: 'Signed PTY',
    }]);
    harness.state.agentCommandSending.add(harness.sessionA.id);
    harness.dispatchTerminalChange(harness.sessionA.id);
    harness.flushFrames();
    assert.deepStrictEqual(harness.submissions, [], '다른 전송 중에는 stale ready form을 제출하면 안 됩니다.');

    harness.state.agentCommandSending.delete(harness.sessionA.id);
    harness.notifyMutation();
    harness.dispatchTerminalChange(harness.sessionA.id);
    harness.flushFrames();
    assert.equal(harness.submissions.length, 1);
    assert.equal(harness.submissions[0].command, '정확한 PTY에만 전달');
  });
}

module.exports = { registerTerminalAgentActionTests };
