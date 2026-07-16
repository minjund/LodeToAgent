'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const SYNTAX_CHECK_FILES = [
  'main.js',
  'preload.js',
  'bin/loadtoagent.js',
  'src/bridgeServer.js',
  'src/providerRegistry.js',
  'src/agentMonitor.js',
  'src/agentRunner.js',
  'src/tmuxMonitor.js',
  'src/tmuxController.js',
  'src/terminalManager.js',
  'src/processMonitor.js',
  'src/monitorWorker.js',
  'src/attentionNotifier.js',
  'src/ipc/registerAppIpc.js',
  'src/ipc/registerAgentIpc.js',
  'src/ipc/registerTerminalIpc.js',
  'src/ipc/registerTmuxIpc.js',
  'src/ipc/registerWorkspaceIpc.js',
  'renderer/i18n-messages.js',
  'renderer/i18n.js',
  'renderer/shared.js',
  'renderer/app.js',
  'renderer/app-dashboard.js',
  'renderer/app-graph-model.js',
  'renderer/app-graph-view.js',
  'renderer/app-graph-layout.js',
  'renderer/app-graph-orchestration.js',
  'renderer/app-tmux-render.js',
  'renderer/app-session-render.js',
  'renderer/app-agent-actions.js',
  'renderer/app-drawer-data.js',
  'renderer/app-drawer-content.js',
  'renderer/app-drawer.js',
  'renderer/app-run-modal.js',
  'renderer/app-events-navigation.js',
  'renderer/app-events-sessions.js',
  'renderer/app-events-filters.js',
  'renderer/app-events-dialogs.js',
  'renderer/app-events.js',
  'renderer/app-bootstrap.js',
  'renderer/terminal-workbench.js',
  'renderer/terminal-agent.js',
  'renderer/terminal-events.js',
  'renderer/terminal.js',
  'scripts/bridge-integration-test.js',
  'scripts/organize-css.js',
];

const REQUIRED_UI_IDS = [
  'mainContent',
  'beginnerGuide',
  'guideBtn',
  'guideProgressBar',
  'dismissGuideBtn',
  'mobileMoreBtn',
  'mobileToolsMenu',
  'providerOverview',
  'liveSection',
  'liveSessionGrid',
  'graphBreadcrumbs',
  'graphResetBtn',
  'terminalSection',
  'terminalWorkbench',
  'terminalWorkbenchMount',
  'terminalStage',
  'terminalHistoryPanel',
  'terminalHistoryList',
  'terminalViewport',
  'terminalCommandForm',
  'terminalSessionList',
  'terminalTmuxList',
  'tmuxCreateModal',
  'tmuxSection',
  'tmuxControlSection',
  'tmuxWorkbenchMount',
  'tmuxStats',
  'tmuxBreadcrumbs',
  'tmuxResetBtn',
  'tmuxMap',
  'sessionGrid',
  'loadMoreBtn',
  'detailDrawer',
  'runModal',
  'drawerContent',
  'sidebarAppVersion',
  'settingsSection',
  'languageSettingsTitle',
  'languageSelect',
  'currentVersion',
  'latestVersion',
  'checkUpdateBtn',
  'updateStateTitle',
];

const RUN_COMPOSER_IDS = ['runPromptCount', 'runWorkspaceSuggestions'];
const TMUX_ONLY_IDS = ['newTmuxSessionBtn', 'terminalTmuxList', 'tmuxControlSection'];

const BEGINNER_GUIDE_LABELS = [
  '첫 10분 코스',
  '이 네 가지만 익히면 충분해요',
  'AI에게 일 맡기기',
  '진행 상황 확인',
  '확인할 일 찾기',
  '작업 자세히 보기',
  '>홈<',
  '>진행 중<',
  '>내 확인 필요<',
  '기존 세션에 이어서 입력',
  '>세션 터미널<',
  'tmux 전용',
  '>tmux 작업<',
  '내 터미널 세션',
  'AI 대화 기록',
  '이 대화가 오른쪽 터미널과 연결되어 있습니다',
  '실시간 터미널',
  'Enter 전송 · Shift+Enter 줄바꿈',
  'tmux 안의 명령창만',
  'AI에게 새 일 맡기기',
  'AI들이 맡은 일',
  'tmux 작업 만들기',
  '현재 설치 버전',
  '업데이트 확인',
];

const DISALLOWED_UI_JARGON = [
  'AI AGENT OBSERVATORY',
  'SESSION STREAM',
  'AGENT MIND MAP',
  'NEW TMUX SESSION',
];

const MONITOR_WORKER_CONTRACTS = [
  'function cardCollaboration',
  'collaboration: cardCollaboration(session.collaboration)',
  'taskName: session.taskName',
  'completionObserved: Boolean(session.completionObserved)',
  'projectless: Boolean(session.projectless)',
  'session.collaboration && session.collaboration.metrics',
  'session.collaboration && session.collaboration.communications',
];

const APP_MODULES = [
  'app.js',
  'app-dashboard.js',
  'app-graph-model.js',
  'app-graph-view.js',
  'app-graph-layout.js',
  'app-graph-orchestration.js',
  'app-tmux-render.js',
  'app-session-render.js',
  'app-agent-actions.js',
  'app-drawer-data.js',
  'app-drawer-content.js',
  'app-drawer.js',
  'app-run-modal.js',
  'app-events-navigation.js',
  'app-events-sessions.js',
  'app-events-filters.js',
  'app-events-dialogs.js',
  'app-events.js',
  'app-bootstrap.js',
];

const APP_PUBLIC_API_CONTRACTS = [
  'window.LoadToAgentAppFactories',
  'createCore',
  'createGraphModel',
  'createGraphView',
  'createGraphLayout',
  'createGraphOrchestration',
  'createSessionRenderer',
  'createAgentActions',
  'createDrawer',
  'createRunModal',
  'createEventBindings',
  'window.LoadToAgentApp = app',
];

const APP_READABILITY_CONTRACTS = [
  'function readablePreview',
  'function roadmapHtml',
  'function runWorkspaceSuggestionsHtml',
  'function syncRunComposer',
  'function renderUpdateSettings',
  'function renderGuide',
  'function markGuideStep',
  'function trapDialogFocus',
  'function selectView',
  'sidebarAppVersion',
  'ui.you_are_up_to_date',
];

const AGENT_GRAPH_CONTRACTS = [
  'function renderAgentMap',
  'function connectedGraphSessions',
  'function providerFlowLane',
  'function focusedGraph',
  'function workflowCompactNode',
  'function workflowChildrenSummary',
  'function workflowMetrics',
  'function workflowCommunicationPanel',
  'function subagentWorkState',
  'function splitSubagents',
  'function completedSubagentDisclosure',
  'function agentExecutionMode',
  'function executionModeBadge',
  'function subagentTextPreview',
  'function subagentConversationHtml',
  'function openSubagentConversation',
  'function resumeAgentTerminal',
];

const COLLABORATION_VIEW_CONTRACTS = [
  'data-collaboration-metric',
  'data-collaboration-communications',
  'data-open-subagent-chat',
  'data-subagent-completed-toggle',
  'data-resume-agent',
  'data-subagent-message-preview',
  'data-truncated',
  '이 작업에서 누적 생성',
  '동시에 유지 가능',
  '현재 실행 중',
  '작업 완료 기록',
  '메인 AI ↔ 서브에이전트 소통',
  'TMUX 사용',
  'TMUX 미사용',
  '완료된 서브에이전트',
  'child-session',
  'agent-flow-session-title',
  'agent-flow-outcome-copy',
  'children-group-input',
];

const WORKFLOW_INTERACTION_CONTRACTS = [
  'function drawAgentWorkflowConnections',
  'function workflowCurve',
  'data-workflow-edge-kind',
  'function captureMotionLayout',
  'function playMotionLayout',
  'function motionEnterOffset',
  'function animateVisibleSections',
  'function agentCommandComposer',
  'function originAppInfo',
  'function agentControlMode',
  'function dispatchAgentCommand',
  'function openAgentTerminal',
  'function copyBridgeCommand',
  'function openSessionOrigin',
  'data-agent-command-form',
  'data-agent-command-draft',
  'data-agent-terminal-open',
  'data-agent-bridge-copy',
  'data-agent-open-origin',
  '직접 입력 가능',
  '외부 터미널에서 실행 중 · 같은 대화로 이어받기 가능',
  '원래 터미널이 종료됨 · 같은 세션으로 복구 가능',
  '쉬는 데스크톱 작업 · 백그라운드 터미널로 이어가기 가능',
  '백그라운드 터미널로 이어서 보내기',
  '보기 전용 · 원래 앱에서 계속',
  'ui.ended_session',
  '바로 보내기',
];

const MOTION_AND_MAP_CONTRACTS = [
  'data-motion-key',
  'data-motion-value',
  'dataset.lastMotion',
  'motion-connect',
  'pathLength="1"',
  'prefers-reduced-motion: reduce',
  'data-graph-provider-more',
  'agent-flow-overview',
  'agent-workflow-canvas',
  'data-workflow-port',
  '이 일을 맡긴 AI',
  '지금 선택한 AI',
  '서브에이전트 세션',
];

const TERMINAL_VIEW_CONTRACTS = [
  'function renderTmuxMap',
  'function tmuxPaneCard',
  'function messageContentHtml',
  'function memoryCandidatesHtml',
  'data-scroll-latest',
  'data-graph-focus',
  'data-tmux-type',
  'data-open-session',
];

const APP_AGENT_CONTRACTS = [
  ...AGENT_GRAPH_CONTRACTS,
  ...COLLABORATION_VIEW_CONTRACTS,
  ...WORKFLOW_INTERACTION_CONTRACTS,
  ...MOTION_AND_MAP_CONTRACTS,
  ...TERMINAL_VIEW_CONTRACTS,
];

const STYLE_FILES = [
  'styles.css',
  'styles-components.css',
  'styles-cards.css',
  'styles-overlays.css',
  'styles-agent-map.css',
  'styles-workflows.css',
  'styles-workflow-map.css',
  'styles-collaboration.css',
  'styles-tmux.css',
  'styles-terminal.css',
  'styles-run-composer.css',
  'styles-product.css',
  'styles-onboarding.css',
  'styles-settings.css',
  'styles-responsive-shell.css',
  'styles-responsive-workflows.css',
  'styles-responsive-runtime.css',
  'styles-responsive-product.css',
];

const I18N_RUNTIME_CONTRACTS = [
  "'ko', 'en', 'zh-CN'",
  'loadtoagent:locale:v1',
  'window.LoadToAgentI18n',
  'loadtoagent:locale-changed',
  'MutationObserver',
  'function t(key, params)',
  'data-i18n',
];

const I18N_MESSAGE_CONTRACTS = [
  'window.LoadToAgentMessages',
  'settings.title',
  'Application Settings',
  '应用设置',
  'common.progress',
  'time.seconds_ago',
];

const LEGACY_I18N_INFERENCE_CONTRACTS = [
  'const rows',
  'applyRules',
  'createTreeWalker',
  'textSources',
  'attributeSources',
  'catalog[core]',
];

const CSS_RESPONSIBILITY_HEADINGS = [
  'Foundation',
  'Shared components',
  'Session cards and metrics',
  'Overlays and transient UI',
  'Agent map',
  'Agent workflows',
  'Directed workflow map',
  'Collaboration detail',
  'Terminal workspaces',
  'tmux workspaces',
  'Product experiences',
  'Run composer',
  'Onboarding and navigation help',
  'Settings and releases',
  'Responsive shell and shared components',
  'Responsive agent workflows',
  'Responsive terminal and tmux workspaces',
  'Responsive product surfaces',
];

const READABILITY_STYLE_CONTRACTS = [
  'chat-roadmap',
  'agent-goal-note',
  'new-run-cta',
  'run-composer',
  'run-modal-actions',
];

const INTERACTION_STYLE_CONTRACTS = [
  '--motion-ease',
  'motion-section-in',
  'motion-live-update',
  'motion-edge-draw',
  'motion-modal-in',
  'motion-modal-out',
  'motion-toast-in',
  'motion-toast-out',
  'agent-command-panel',
  'agent-command-input',
  'terminal-stage',
  'terminal-history-panel',
  'terminal-history-message',
  'terminal-console-pane',
  'terminal-console-head',
  'terminal-command-composer',
  'terminal-resource-tip',
  'agent-workflow-summary',
  'workflow-summary-chip',
  'density-many',
  'agent-workflow-edge.downstream.group',
  'agent-flow-session-title',
  'agent-flow-outcome-copy',
  'completed-subagent-disclosure',
  'completed-subagent-list',
  'execution-mode-badge',
  'work-working',
  'work-resting',
  'subagent-work-source',
  'subagent-coordination',
  'provider-filter-check',
  'provider-filter-confirm',
  'poc-filter-state',
  'subagent-message-preview',
  'resume-ready',
  'control-handoff',
  'control-origin-resume',
];

const TERMINAL_RUNTIME_CONTRACTS = [
  'window.Terminal',
  'FitAddon.FitAddon',
  'wslDistros',
  'terminalWrite',
  'terminalResize',
  'tmuxSendText',
  'tmuxCapture',
  'tmuxSplitPane',
  'tmuxKillSession',
  'function modeSessions',
  'function moveWorkbench',
  'function terminalTypeLabel',
  'function terminalTypeMark',
  'function setConnectionState',
  'function agentTargets',
  'terminal.bridgeId === agentSession.id',
  '백그라운드 유지',
  'session.background_count',
  'function requiredAgentTarget',
  'function resumeSupport',
  'function resumeForAgent',
  "provider === 'codex' ? ['resume', sessionId] : ['--resume', sessionId]",
  'function dispatchAgentCommand',
  'function openForAgent',
  'function bindAgent',
  'function renderHistoryPanel',
  'function queueHistoryRefresh',
  'selectTmuxById',
  'window.LoadToAgentTerminal',
];

const IPC_MODULE_FILES = [
  'registerAppIpc.js',
  'registerAgentIpc.js',
  'registerTerminalIpc.js',
  'registerTmuxIpc.js',
  'registerWorkspaceIpc.js',
];

const MAIN_PROCESS_CONTRACTS = [
  'function backgroundAgentSessions',
  'function ensureBackgroundTray',
  'function updateBackgroundTrayMenu',
  'function mainText',
  '프로그램 끝내기 · AI 세션도 종료',
  'Quit app · End AI sessions too',
  '退出应用 · 同时结束 AI 会话',
  'event.preventDefault()',
  'mainWindow.hide()',
  'function registerIpcHandlers',
  'function createAttentionNotifier',
  "attentionNotifier.sync(lastSnapshot)",
  "agents:attention-requested",
];

const APP_IPC_CHANNELS = [
  'app:background-state',
  'app:show',
  'app:set-locale',
  'app:update-check',
  'app:update-download',
  'app:update-open',
];

const TRUSTED_IPC_CHANNELS = [
  'app:bootstrap',
  'agents:snapshot',
  'agents:detail',
  'agents:run',
  'agents:stop',
  'providers:probe',
  'workspaces:list',
  'workspaces:add',
  'workspaces:remove',
  'workspaces:pick',
  'external:open',
];

const PRELOAD_IPC_CONTRACTS = [
  'backgroundState',
  'showApp',
  'setLocale',
  'checkForUpdate',
  'downloadUpdate',
  'openDownloadedUpdate',
  'onUpdateState',
  'onAttentionRequested',
];

const LEGACY_NAME_TARGETS = [
  'main.js',
  'preload.js',
  'package.json',
  'README.md',
  'src',
  'renderer',
  'scripts',
];

const PRODUCT_NAME_TARGETS = [
  '.github',
  'bin',
  'docs',
  'main.js',
  'preload.js',
  'package.json',
  'README.md',
  'README.ko.md',
  'README.zh-CN.md',
  'src',
  'renderer',
  'scripts',
];

const RELEASE_WORKFLOW_CONTRACTS = [
  'tags:',
  '"v*"',
  'actions/checkout@v6',
  'actions/setup-node@v6',
  'gh release create',
  'release/*.exe',
  'release/*.dmg',
  'release/*.zip',
  'LoadToAgent-Windows',
  'LoadToAgent-macOS',
  'npm_version.outputs.published',
  'id-token: write',
  'npm publish --access public --tag latest',
  'Verify npm publication and latest tag',
];

function assertIncludesAll(source, contracts, messageForContract) {
  for (const contract of contracts) {
    assert.ok(source.includes(contract), messageForContract && messageForContract(contract));
  }
}

function assertExcludesAll(source, contracts, messageForContract) {
  for (const contract of contracts) {
    assert.equal(source.includes(contract), false, messageForContract(contract));
  }
}

function registerSyntaxContractTests(context) {
  const { test, root } = context;
  test('메인과 렌더러 JavaScript 문법이 유효하다', () => {
    for (const file of SYNTAX_CHECK_FILES) {
      execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
    }
  });

}

function registerUiContractTests(context) {
  const { test, root } = context;
  test('필수 UI 영역과 초보자용 안내 계약이 존재한다', () => {
    const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
    const monitorWorker = fs.readFileSync(path.join(root, 'src', 'monitorWorker.js'), 'utf8');
    for (const id of REQUIRED_UI_IDS) assert.ok(html.includes(`id="${id}"`));
    for (const id of RUN_COMPOSER_IDS) assert.ok(html.includes(`id="${id}"`));
    assertIncludesAll(html, BEGINNER_GUIDE_LABELS, label => `${label} 문구가 없습니다.`);
    assertExcludesAll(
      html,
      DISALLOWED_UI_JARGON,
      jargon => `${jargon} 전문 용어가 기본 화면에 남아 있습니다.`,
    );
    assertIncludesAll(
      monitorWorker,
      MONITOR_WORKER_CONTRACTS,
      contract => `${contract} 협업 전송 계약이 없습니다.`,
    );
    const terminalBlock = html.slice(html.indexOf('id="terminalSection"'), html.indexOf('id="tmuxSection"'));
    const tmuxBlock = html.slice(html.indexOf('id="tmuxSection"'), html.indexOf('id="liveSection"'));
    for (const tmuxOnlyId of TMUX_ONLY_IDS) {
      assert.equal(
        terminalBlock.includes(`id="${tmuxOnlyId}"`),
        false,
        `${tmuxOnlyId}가 일반 명령창 영역에 섞여 있습니다.`,
      );
      assert.equal(
        tmuxBlock.includes(`id="${tmuxOnlyId}"`),
        true,
        `${tmuxOnlyId}가 tmux 전용 영역에 없습니다.`,
      );
    }
    assert.equal(html.includes('data-view="subagents"'), false);
    assert.equal(html.includes('id="navSubagentCount"'), false);
    const rendererSource = files => files
      .map(file => fs.readFileSync(path.join(root, 'renderer', file), 'utf8'))
      .join('\n');
    const app = rendererSource(APP_MODULES);
    assertIncludesAll(
      app,
      APP_PUBLIC_API_CONTRACTS,
      contract => `${contract} 앱 공개 API 계약이 없습니다.`,
    );
    assertIncludesAll(app, APP_READABILITY_CONTRACTS);
    assertIncludesAll(app, APP_AGENT_CONTRACTS);
    assert.equal(app.includes('agent-focus-layout'), false);
    assert.equal(app.includes("state.view === 'subagents'"), false);
    const styles = STYLE_FILES
      .map(file => fs.readFileSync(path.join(root, 'renderer', file), 'utf8'))
      .join('\n');
    const i18n = fs.readFileSync(path.join(root, 'renderer', 'i18n.js'), 'utf8');
    const i18nMessages = fs.readFileSync(path.join(root, 'renderer', 'i18n-messages.js'), 'utf8');
    assertIncludesAll(
      i18n,
      I18N_RUNTIME_CONTRACTS,
      contract => `${contract} 다국어 런타임 계약이 없습니다.`,
    );
    assertIncludesAll(
      i18nMessages,
      I18N_MESSAGE_CONTRACTS,
      contract => `${contract} 명시 메시지 계약이 없습니다.`,
    );
    assertExcludesAll(
      i18n,
      LEGACY_I18N_INFERENCE_CONTRACTS,
      legacy => `${legacy} 원문 추론 계약이 남아 있습니다.`,
    );
    const messageReferences = new Set([
      ...[...app.matchAll(/LoadToAgentI18n\.t\(["']([^"']+)["']/g)].map(match => match[1]),
      ...[...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(match => match[1]),
    ]);
    for (const key of messageReferences) {
      assert.ok(
        i18nMessages.includes(`"${key}":`),
        `${key} 메시지 키가 카탈로그에 없습니다.`,
      );
    }
    assert.ok(
      (html.match(/data-i18n(?:-[a-z-]+)?=/g) || []).length >= 150,
      '정적 번역 대상이 명시 키를 충분히 사용하지 않습니다.',
    );
    assert.ok(
      html.indexOf('src="i18n-messages.js"') < html.indexOf('src="i18n.js"'),
      '메시지 카탈로그는 다국어 런타임보다 먼저 로드되어야 합니다.',
    );
    assert.ok(
      html.indexOf('src="i18n.js"') < html.indexOf('src="app.js"'),
      '다국어 런타임은 앱 렌더링보다 먼저 로드되어야 합니다.',
    );
    STYLE_FILES.reduce((previous, style) => {
      const index = html.indexOf(`href="${style}"`);
      assert.ok(index > previous, `${style} CSS 계층 로드 순서가 올바르지 않습니다.`);
      return index;
    }, -1);
    for (const heading of CSS_RESPONSIBILITY_HEADINGS) {
      assert.ok(styles.includes(heading), `${heading} CSS 책임 경계가 없습니다.`);
    }
    const rendererScripts = [
      'i18n-messages.js',
      'i18n.js',
      'shared.js',
      ...APP_MODULES,
      'terminal-workbench.js',
      'terminal-agent.js',
      'terminal-events.js',
      'terminal.js',
    ];
    rendererScripts.reduce((previous, script) => {
      const index = html.indexOf(`src="${script}"`);
      assert.ok(index > previous, `${script} 렌더러 모듈 로드 순서가 올바르지 않습니다.`);
      return index;
    }, -1);
    assertIncludesAll(
      styles,
      READABILITY_STYLE_CONTRACTS,
      contract => `${contract} 가독성 UI 계약이 없습니다.`,
    );
    assertIncludesAll(
      styles,
      INTERACTION_STYLE_CONTRACTS,
      contract => `${contract} UI 계약이 없습니다.`,
    );
    assert.match(styles, /-webkit-line-clamp:\s*5/, '서브에이전트 미리보기의 5줄 제한 계약이 없습니다.');
    assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, '동작 줄이기 미디어 계약이 없습니다.');
    const terminal = rendererSource([
      'terminal-workbench.js',
      'terminal-agent.js',
      'terminal-events.js',
      'terminal.js',
    ]);
    assertIncludesAll(terminal, TERMINAL_RUNTIME_CONTRACTS);
    const mainEntry = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const ipcSource = IPC_MODULE_FILES
      .map(file => fs.readFileSync(path.join(root, 'src', 'ipc', file), 'utf8'))
      .join('\n');
    assertIncludesAll(
      mainEntry,
      MAIN_PROCESS_CONTRACTS,
      contract => `${contract} 메인 프로세스 계약이 없습니다.`,
    );
    for (const channel of APP_IPC_CHANNELS) {
      assert.ok(
        ipcSource.includes(`handleTrusted('${channel}'`),
        `${channel} IPC 등록이 없습니다.`,
      );
    }
    for (const channel of TRUSTED_IPC_CHANNELS) {
      assert.ok(ipcSource.includes(`handleTrusted('${channel}'`), `${channel} IPC에 신뢰 발신자 검증이 없습니다.`);
    }
    const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
    assertIncludesAll(
      preload,
      PRELOAD_IPC_CONTRACTS,
      contract => `${contract} 렌더러 IPC 계약이 없습니다.`,
    );
    assert.ok(html.includes('Content-Security-Policy'));
    assert.ok(html.includes('@xterm/xterm/lib/xterm.js'));
    assert.ok(
      html.indexOf('class="topbar"') < html.indexOf('id="beginnerGuide"')
        && html.indexOf('id="beginnerGuide"') < html.indexOf('id="providerOverview"'),
      '시작 가이드는 홈 화면 콘텐츠의 최상단에 있어야 합니다.',
    );
    assert.ok(
      html.indexOf('id="providerOverview"') < html.indexOf('id="updateNotice"'),
      'AI 제공사 요약 카드는 시작 가이드 바로 아래에 있어야 합니다.',
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.build.productName, 'LoadToAgent');
    assert.equal(pkg.build.win.icon, 'build/icon.ico');
    assert.equal(pkg.build.mac.icon, 'build/icon.png');
    assert.ok(mainEntry.includes("app.setName(PRODUCT_NAME)"));
    assert.ok(mainEntry.includes("app.setAppUserModelId('com.wincube.loadtoagent')"));
    assert.ok(pkg.dependencies['node-pty']);
    assert.ok(pkg.dependencies['@xterm/xterm']);
    assert.ok(pkg.dependencies['@xterm/addon-fit']);
    assert.equal(pkg.bin.loadtoagent, 'bin/loadtoagent.js');
    assert.ok(pkg.build.mac.target.some(item => item.arch.includes('arm64') && item.arch.includes('x64')));
  });

  test('tmux 도움 AI 순회가 자기·상호 순환과 중복 자식을 안전하게 제외한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-tmux-render.js'), 'utf8');
    const sandbox = { window: { LoadToAgentAppFactories: {} } };
    vm.runInNewContext(source, sandbox, { filename: 'app-tmux-render.js' });
    const sessions = [
      { id: 'root', childIds: ['root', 'child-a', 'child-a'] },
      { id: 'child-a', childIds: ['child-b'] },
      { id: 'child-b', childIds: ['child-a'] },
    ];
    const renderer = sandbox.window.LoadToAgentAppFactories.createTmuxRenderer({
      state: { snapshot: { sessions } },
    });
    const rows = renderer.linkedTmuxSubagents({ linkedSessionId: 'root' });
    assert.deepStrictEqual(
      Array.from(rows, ({ session, depth }) => [session.id, depth]),
      [['child-a', 1], ['child-b', 2]],
    );
  });

}

function registerLegacyNameTests(context) {
  const { test, root } = context;
  test('제품 소스에 이전 워크플로우 명칭이 남아 있지 않다', () => {
    const forbidden = new RegExp(['w', 'c', 'c'].join(''), 'i');
    const visit = target => {
      const full = path.join(root, target);
      if (!fs.existsSync(full)) return;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(full)) visit(path.join(target, name));
      } else if (/\.(js|json|html|css|md)$/i.test(full)) {
        assert.equal(forbidden.test(fs.readFileSync(full, 'utf8')), false, `${target}에 제거 대상 명칭이 남아 있습니다.`);
      }
    };
    LEGACY_NAME_TARGETS.forEach(visit);
  });

  test('제품 소스와 파일명에 이전 프로그램 명칭이 남아 있지 않다', () => {
    const forbidden = new RegExp(['lode', 'star'].join(''), 'i');
    const visit = target => {
      const full = path.join(root, target);
      if (!fs.existsSync(full)) return;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(full)) {
          assert.equal(forbidden.test(name), false, `${path.join(target, name)} 파일명에 이전 프로그램 명칭이 남아 있습니다.`);
          visit(path.join(target, name));
        }
      } else if (/\.(js|json|ya?ml|html|css|md)$/i.test(full)) {
        assert.equal(forbidden.test(fs.readFileSync(full, 'utf8')), false, `${target}에 이전 프로그램 명칭이 남아 있습니다.`);
      }
    };
    PRODUCT_NAME_TARGETS.forEach(visit);
  });

}

function registerDocumentationContractTests(context) {
  const { test, root } = context;
  test('README와 릴리스 워크플로가 npm·Windows·macOS 실행 경로를 안내한다', () => {
    for (const file of ['README.md', 'README.ko.md', 'README.zh-CN.md']) {
      const readme = fs.readFileSync(path.join(root, file), 'utf8');
      for (const contract of [
        'npm install -g loadtoagent',
        'loadtoagent',
        'https://github.com/minjund/LodeToAgent/releases/latest',
        'LoadToAgent-Setup-<version>.exe',
        'LoadToAgent-<version>-portable.exe',
        'LoadToAgent-<version>-arm64.dmg',
        'LoadToAgent-<version>-x64.dmg',
      ]) assert.ok(readme.includes(contract), `${file}에 ${contract} 안내가 없습니다.`);
    }

    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    for (const contract of RELEASE_WORKFLOW_CONTRACTS) {
      assert.ok(workflow.includes(contract), `release.yml에 ${contract} 계약이 없습니다.`);
    }
    assert.equal(workflow.includes('continue-on-error'), false, 'npm 게시 실패를 성공으로 숨기면 안 됩니다.');
    assert.equal(workflow.includes('NODE_AUTH_TOKEN'), false, 'npm 게시는 장기 토큰 대신 OIDC Trusted Publisher를 사용해야 합니다.');
  });
}

function registerUiContractSuite(context) {
  registerSyntaxContractTests(context);
  registerUiContractTests(context);
  registerLegacyNameTests(context);
  registerDocumentationContractTests(context);
}

module.exports = { registerUiContractSuite };
