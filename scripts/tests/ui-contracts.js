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
  'src/platformPath.js',
  'src/agentMonitor.js',
  'src/automationMonitor.js',
  'src/agentRunner.js',
  'src/tmuxMonitor.js',
  'src/tmuxController.js',
  'src/terminalManager.js',
  'src/terminalHost.js',
  'src/terminalHostDaemon.js',
  'src/processMonitor.js',
  'src/monitorWorker.js',
  'src/attentionNotifier.js',
  'src/sessionIntelligence.js',
  'src/providerVisibilityStore.js',
  'src/updateInstaller.js',
  'src/ipc/registerAppIpc.js',
  'src/ipc/registerAgentIpc.js',
  'src/ipc/registerTerminalIpc.js',
  'src/ipc/registerTmuxIpc.js',
  'src/ipc/registerWorkspaceIpc.js',
  'renderer/i18n-messages.js',
  'renderer/i18n.js',
  'renderer/shared.js',
  'renderer/app.js',
  'renderer/app-provider-visibility.js',
  'renderer/app-dashboard.js',
  'renderer/app-runtime-overview.js',
  'renderer/app-graph-model.js',
  'renderer/app-graph-view.js',
  'renderer/app-graph-layout.js',
  'renderer/app-graph-orchestration.js',
  'renderer/app-tmux-render.js',
  'renderer/app-agent-actions.js',
  'renderer/app-management.js',
  'renderer/app-session-render.js',
  'renderer/app-drawer-data.js',
  'renderer/app-drawer-content.js',
  'renderer/app-drawer.js',
  'renderer/app-run-modal.js',
  'renderer/app-quality.js',
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
  'scripts/runtime-overview-visual.js',
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
  'advancedToolsNav',
  'operationsOverview',
  'attentionInbox',
  'navRuntimeCount',
  'providerOverview',
  'automationOverview',
  'liveSection',
  'controlRoomProjectToolbar',
  'workspaceList',
  'addWorkspaceBtn',
  'controlRoomListToolbar',
  'controlRoomSortSelect',
  'controlRoomProjectSelect',
  'controlRoomSearch',
  'controlRoomSearchInput',
  'controlRoomSearchBtn',
  'controlRoomExpandAll',
  'controlRoomCollapseAll',
  'agentMapToolbar',
  'liveSessionGrid',
  'activeEmptyState',
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
  'quickPaletteModal',
  'quickPaletteInput',
  'shortcutHelpModal',
  'shortcutHelpBtn',
  'sessionResultSummary',
  'emptyClearFiltersBtn',
  'clearRunDraftBtn',
  'terminalCommandClearBtn',
  'terminalFontDecreaseBtn',
  'terminalFontIncreaseBtn',
  'terminalFontSizeLabel',
  'terminalFocusBtn',
  'drawerContent',
  'drawerComposer',
  'drawerTabSummary',
  'sidebarAppVersion',
  'settingsSection',
  'languageSettingsTitle',
  'languageSelect',
  'providerVisibilityList',
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
  '내 응답과 상태 신호 확인',
  '작업 자세히 보기',
  '>홈<',
  '>진행 중<',
  '>확인할 일<',
  '>고급 도구<',
  '>AI 세션 터미널<',
  '>예약·실행 단계<',
  '>tmux 터미널 관리<',
  '내 터미널 세션',
  'AI 대화 기록',
  '이 대화가 오른쪽 터미널과 연결되어 있습니다',
  '실시간 터미널',
  'Enter 전송 · Shift+Enter 줄바꿈',
  'tmux 안의 명령창만',
  'AI에게 새 일 맡기기',
  '에이전트가 일하는 흐름을 실시간으로 확인하세요.',
  'tmux 세션 만들기',
  '현재 설치 버전',
  '업데이트 확인',
];

const DISALLOWED_UI_JARGON = [
  'AI AGENT OBSERVATORY',
  'SESSION STREAM',
  'AGENT MIND MAP',
  'NEW TMUX SESSION',
];

const SEMANTIC_UI_COPY = [
  '상태 정보 불확실',
  '감지된 상태 신호',
  '상태·관계 직접 확인',
  '완료 신호 수신',
  '완료 신호 미확인',
  '최근 실행 이벤트',
  '로그에서 찾은 산출물 후보',
  '로그에 기록된 테스트 실행',
  '승인 메시지 보내기',
  '거절 메시지 보내기',
  '다른 AI로 새 작업 만들기',
  'CLI 설치 감지',
  '내 응답 필요',
  '위험 신호 · 긴급',
  '2분 이상 새 활동 없음',
  'AI 기억 한도 75% 이상 사용',
  '부모 작업 연결 정보 없음',
  '현재 추정 단계',
  '결과 확인',
  '반복 실행 횟수',
  'AI 세션 터미널',
  'tmux 터미널 관리',
  '프로젝트 폴더 필터',
  '도움 AI',
  '설정상 동시 도움 AI 한도',
];

const AMBIGUOUS_KO_MESSAGE_VALUES = [
  '근거 부족',
  '실행 건강 상태',
  '높은 신뢰도',
  '보통 신뢰도',
  '낮은 신뢰도',
  '검증 필요',
  '완료 이벤트 확인',
  '구조화된 진행 상황',
  '관측된 산출물',
  '테스트·검증 기록',
  '승인하고 계속',
  '거절하고 중단',
  '다른 AI로 넘기기',
  '사용 가능한 AI',
  '확인·주의',
  '예약·반복',
  '대화·명령창',
  '여러 명령창',
  '동시에 유지 가능',
  '최근 활동이 지연됨',
  '작업 정체 감지',
  '서브 AI',
  '실행 시작 관측',
  '관측된 반복 정보',
  '근거와 상세 보기',
  '여러 창 작업 만들기',
  '조치 필요',
  '에이전트 루프 실행 중',
  '에이전트 메시지',
  '작업공간 미지정',
  '에이전트 탐색 경로',
  '에이전트 운영 상태',
];

const MANAGEMENT_SEMANTIC_CONTRACTS = [
  'function matchesManagementFilter',
  'RESPONSE_ATTENTION_KINDS.has(session.attention.kind)',
  'ACTIONABLE_RISK_SIGNALS.has(signal.code)',
  'RECENT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000',
  'function managementBucket(session, now = Date.now())',
  'needsManagementReview',
  'management-filter-group response',
  'management-filter-group risk',
  'signals.length',
  'loggedRatio',
  'attention.kind === "approval"',
  't("management.detected")',
  'function renderOperationsOverview',
  'function renderHomeAttention',
  'data-home-attention',
  'control.attention_title',
  'attention-decision-flow',
  'latestAgentReply',
  'management.flow_agent_reply',
  'management.flow_my_check',
  'management.flow_my_reply',
  'data-attention-draft',
  'attention-evidence-details',
  'sessionOrder',
  'function stableSessionSort',
  'function moveSessionOrder',
  'bindSortableSessionList',
  'data-session-sortable',
  'data-session-drop-edge',
  'saveDashboardPreferences();',
];

const MONITOR_WORKER_CONTRACTS = [
  'function cardCollaboration',
  'collaboration: cardCollaboration(session.collaboration)',
  'function cardExecutions',
  'executions: cardExecutions(session.executions)',
  'taskName: session.taskName',
  'completionObserved: Boolean(session.completionObserved)',
  'attention: session.attention',
  'progress: session.progress',
  'health: session.health',
  'controlCapabilities: session.controlCapabilities',
  'evidence: session.evidence',
  'outcome: session.outcome',
  'projectless: Boolean(session.projectless)',
  'originCwd: session.originCwd || session.cwd',
  'loop: session.loop',
  'session.collaboration && session.collaboration.metrics',
  'session.collaboration && session.collaboration.communications',
  'scanCodexAutomationHomes',
  'automations,',
];

const APP_MODULES = [
  'app.js',
  'app-provider-visibility.js',
  'app-dashboard.js',
  'app-runtime-overview.js',
  'app-graph-model.js',
  'app-graph-view.js',
  'app-graph-layout.js',
  'app-graph-orchestration.js',
  'app-tmux-render.js',
  'app-agent-actions.js',
  'app-management.js',
  'app-session-render.js',
  'app-drawer-data.js',
  'app-drawer-content.js',
  'app-drawer.js',
  'app-run-modal.js',
  'app-quality.js',
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
  'createManagement',
  'createDrawer',
  'createRunModal',
  'createQualityEnhancements',
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
  'function phaseStatusLabel',
  'runtime-now-strip',
  'runtime-active-phase',
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
  'function executionActivityPanel',
  'data-execution-activity',
  'data-execution-kind',
  'data-execution-mode',
  'data-execution-status',
  'function controlRoomSession',
  'function controlRoomChildNode',
  'function controlRoomExecutionNode',
  'function controlRoomSummary',
  'function controlRoomAgentGoal',
  'function controlRoomProject',
  'function runtimeSeparatedOverview',
  'function inferredExecutionSummary',
  'function executionActivityDetailHtml',
  'function openExecutionActivity',
  'data-control-summary',
  'data-open-execution-id',
  'data-conversation-scope="execution-only"',
  'data-control-room-overview',
  'data-control-project',
  'control-room-project-group',
  'data-control-session',
  'data-session-archive',
  'function isControlRoomSession',
  'control.waiting_background_session',
  'is-unverified',
  'function archiveSession',
  'function isRuntimeLoopSession',
  'function subagentTextPreview',
  'function subagentConversationHtml',
  'function openSubagentConversation',
  'function resumeAgentTerminal',
];

const COLLABORATION_VIEW_CONTRACTS = [
  'data-collaboration-metric',
  'data-collaboration-communications',
  'function subagentCallEvents',
  'function subagentCallHtml',
  'data-subagent-call-event',
  'data-subagent-call-sequence',
  'data-subagent-call-elapsed-ms',
  'function subagentCallElapsed',
  'function turnWithSubagentCallsHtml',
  'subagent-call-anchor',
  'data-open-subagent-chat',
  'openSubagentConversation(subagent.dataset.openSubagentChat)',
  'data-subagent-completed-toggle',
  'data-resume-agent',
  'data-subagent-message-preview',
  'data-truncated',
  'assignmentProtected',
  'assignmentContext',
  'drawer.assignment_protected',
  'drawer.assignment_source_claude',
  'drawer.assignment_source_codex',
  'graph.created_in_task',
  'graph.simultaneous_capacity',
  'graph.currently_running',
  'graph.completed_records',
  'graph.communication_title',
  'graph.tmux_used',
  'graph.tmux_not_used',
  'graph.completed_subagents',
  'graph.execution_activity',
  'graph.shell_foreground',
  'graph.shell_background',
  'graph.background_task',
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
  'function agentCommandRouteOptions',
  'function selectedAgentCommandRoute',
  'function routedAgentCommandContext',
  'function originAppInfo',
  'function agentControlMode',
  'function dispatchAgentCommand',
  '{ focus: false }',
  'function openAgentTerminal',
  'function copyBridgeCommand',
  'data-agent-command-form',
  'data-agent-command-draft',
  'data-agent-terminal-open',
  'data-agent-bridge-copy',
  'data-agent-command-route',
  'agent.route_direct',
  'agent.route_parent',
  'agent.direct_status',
  'agent.handoff_status',
  'agent.resume_status',
  'agent.origin_resume_status',
  'agent.background_and_send',
  'ui.ended_session',
  'agent.send_now',
];

const MOTION_AND_MAP_CONTRACTS = [
  'data-motion-key',
  'data-motion-value',
  'dataset.lastMotion',
  'motion-connect',
  'pathLength="1"',
  'prefers-reduced-motion: reduce',
  'data-graph-provider-more',
  'control-room-overview',
  'agent-workflow-canvas',
  'data-workflow-port',
  'graph.assigning_ai',
  'graph.selected_ai',
  'graph.subagent_sessions',
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
  'styles-management.css',
  'styles-runtime-overview.css',
  'styles-onboarding.css',
  'styles-settings.css',
  'styles-quality.css',
  'styles-responsive-shell.css',
  'styles-responsive-workflows.css',
  'styles-responsive-runtime.css',
  'styles-responsive-product.css',
  'styles-control-room.css',
];

const I18N_RUNTIME_CONTRACTS = [
  "'ko', 'en', 'zh-CN'",
  'loadtoagent:locale:v1',
  'window.LoadToAgentI18n',
  'loadtoagent:locale-changed',
  'MutationObserver',
  'function t(key, params)',
  'function errorText(error, fallbackKey, params)',
  'function observedText(value)',
  'data-i18n',
];

const I18N_MESSAGE_CONTRACTS = [
  'window.LoadToAgentMessages',
  'settings.title',
  'Application Settings',
  '应用设置',
  'common.progress',
  'time.seconds_ago',
  'control.all_projects',
  'control.add_project',
  'control.page_summary',
  'control.project_filter',
  'control.search_sessions',
  'control.sort_sessions',
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
  'Runtime schedules and loop observability',
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
  'live-tmux-shortcut',
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

const QUALITY_201_300_APP_CONTRACTS = [
  'QUALITY_PREF_STORAGE_KEY',
  'QUALITY_PREF_VERSION = 3',
  'function qualityText',
  'function defaultQualityPreferences',
  'function loadQualityPreferences',
  'function saveQualityPreferences',
  'function applyQualityPreferences',
  'function markInputModality',
  'function describeControl',
  'function enhanceControl',
  'function enhanceQualityControls',
  'function installQualityMutationObserver',
  'function installPressedStateMirrors',
  'function installFormRecovery',
  'function installDetailsStateMemory',
  'function installOverflowTitles',
  'function installViewportSafetyClass',
  'function installGlobalQualityGuards',
  'qualityGuardsInstalled',
  'data-quality-disabled-reason',
  'data-quality-touch-target',
  'data-quality-pressed',
  'data-quality-control',
  'aria-required',
  'body.dataset.inputModality',
  'body.dataset.qualityMotion',
  'body.dataset.qualityDensity',
  'document.documentElement.dataset.qualityViewport',
  'requestAnimationFrame(() => enhanceQualityControls())',
  'MutationObserver',
];

const QUALITY_201_300_STYLE_CONTRACTS = [
  'Quality pass 201–300',
  'body.quality-keyboard-mode :focus-visible',
  '[data-quality-control]',
  '[data-quality-pressed="true"]',
  '[data-quality-disabled="true"]',
  '[data-quality-touch-target="padded"]::after',
  '[data-quality-density="compact"] .session-grid',
  '[data-quality-motion="reduced"] *',
  '[data-quality-viewport="mobile"] .quality-modal',
  'touch-action: manipulation',
  'cursor: not-allowed',
  'outline: 3px solid #77e2c2',
];

const QUALITY_201_300_I18N_CONTRACTS = [
  'quality.disabled_reason',
  'Unavailable for the current state.',
  '当前状态不可用。',
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
  'function terminalPresentation',
  'function setTerminalFontSize',
  'function toggleTerminalFocusMode',
  'data-status="${esc(presentation.tone)}"',
  'function agentTargets',
  'terminal.bridgeId === agentSession.id',
  'terminal.background_kept',
  'session.background_count',
  'function requiredAgentTarget',
  'function resumeSupport',
  'parentControlled: true',
  "terminal.type === 'agent'",
  'sub-agent is controlled by its parent',
  'function resumeForAgent',
  "provider === 'codex' ? ['resume', sessionId] : ['--resume', sessionId]",
  'function dispatchAgentCommand',
  'function openForAgent',
  'function bindAgent',
  'function renderHistoryPanel',
  'function queueHistoryRefresh',
  'selectTmuxById',
  'window.LoadToAgentTerminal',
  "t('terminal.detach_tmux_input')",
  "t('terminal.recovered_after_host_restart')",
  'entry.pendingResize',
  'resizeObserver.observe',
];

const IPC_MODULE_FILES = [
  'registerAppIpc.js',
  'registerAgentIpc.js',
  'registerTerminalIpc.js',
  'registerTmuxIpc.js',
  'registerWorkspaceIpc.js',
];

const MAIN_PROCESS_CONTRACTS = [
  'function backgroundTerminalSessions',
  'function ensureBackgroundTray',
  'function updateBackgroundTrayMenu',
  'function mainText',
  '프로그램 끝내기 · 터미널 세션 유지',
  'Quit app · Keep terminal sessions',
  '退出应用 · 保留终端会话',
  'new TerminalHostClient',
  "terminalManager.on('reconnect'",
  "terminalManager.on('reconnect-error'",
  'function connectTerminalForStartup',
  "reportRecoverableError('terminal-host-startup-connect'",
  "sendTerminal('terminals:connection'",
  'terminalManager.dispose({ shutdownIfIdle: true })',
  "session.status === 'running' || session.status === 'starting'",
  'event.preventDefault()',
  'mainWindow.hide()',
  'const showFallback = setTimeout(showWindow, 2_000)',
  'function registerIpcHandlers',
  'function createAttentionNotifier',
  'const ATTENTION_NOTIFICATIONS_ENABLED = false',
  'enabled: ATTENTION_NOTIFICATIONS_ENABLED',
  "attentionNotifier.sync(visibleSnapshotSessions(lastSnapshot))",
  "agents:attention-requested",
  "pendingAttentionSessionId",
  "markRendererReady",
  "did-start-loading",
];

const APP_IPC_CHANNELS = [
  'app:renderer-ready',
  'app:background-state',
  'app:show',
  'app:set-locale',
  'app:update-check',
  'app:update-download',
  'app:update-open',
  'app:update-install',
];

const TRUSTED_IPC_CHANNELS = [
  'app:bootstrap',
  'agents:snapshot',
  'agents:detail',
  'agents:run',
  'agents:stop',
  'agents:pause',
  'agents:resume-run',
  'agents:retry',
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
  'installDownloadedUpdate',
  'onUpdateState',
  'onAttentionRequested',
  'onTerminalConnection',
  "terminalWrite: (id, data) => ipcRenderer.invoke('terminals:write'",
  "terminalResize: (id, cols, rows) => ipcRenderer.invoke('terminals:resize'",
  'pauseAgent',
  'resumeAgentRun',
  'retryAgent',
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
    assert.ok(
      html.includes('for="runCwd" data-i18n="ui.work_folder"'),
      '새 작업 창의 작업 폴더 라벨은 폴더 필터와 분리된 번역 키를 사용해야 합니다.',
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
    const sidebarBlock = html.slice(html.indexOf('<aside class="sidebar"'), html.indexOf('<main id="mainContent"'));
    const liveBlock = html.slice(html.indexOf('id="liveSection"'), html.indexOf('id="globalStats"'));
    assert.equal(sidebarBlock.includes('id="workspaceList"'), false, '데스크톱 사이드바에 프로젝트 목록이 다시 들어가면 안 됩니다.');
    assert.equal(sidebarBlock.includes('id="addWorkspaceBtn"'), false, '프로젝트 추가 버튼은 사이드바가 아니라 실행 세션 영역에 있어야 합니다.');
    assert.ok(liveBlock.includes('id="workspaceList"') && liveBlock.includes('id="addWorkspaceBtn"'), '프로젝트 목록과 추가 버튼이 실행 세션 영역에 없습니다.');
    assert.ok(liveBlock.indexOf('id="workspaceList"') < liveBlock.indexOf('id="addWorkspaceBtn"'), '프로젝트 추가 버튼은 프로젝트 목록 오른쪽 순서에 있어야 합니다.');
    assert.ok(liveBlock.indexOf('id="controlRoomExpandAll"') < liveBlock.indexOf('id="liveSessionGrid"'), '프로젝트 전체 열기·닫기 버튼은 목록 상단에 있어야 합니다.');
    assert.equal(liveBlock.includes('controlRoomPagePrev'), false, '실행 세션 페이징 버튼이 남아 있습니다.');
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
    assertIncludesAll(
      app,
      MANAGEMENT_SEMANTIC_CONTRACTS,
      contract => `${contract} 상태·행동 의미 일치 계약이 없습니다.`,
    );
    assert.equal(app.includes('Number(health.score'), false, '검증되지 않은 건강 점수를 UI에 표시하면 안 됩니다.');
    assert.equal(app.includes('agent-focus-layout'), false);
    assert.equal(app.includes("state.view === 'subagents'"), false);
    assert.equal(app.includes('data-session-order-move'), false, '세션 위치 변경용 화살표 버튼 계약이 남아 있습니다.');
    assert.equal(app.includes('data-session-move='), false, '터미널 위치 변경용 화살표 버튼 계약이 남아 있습니다.');
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
    assertIncludesAll(
      i18nMessages,
      SEMANTIC_UI_COPY,
      copy => `${copy} 의미 중심 UI 문구가 없습니다.`,
    );
    for (const copy of AMBIGUOUS_KO_MESSAGE_VALUES) {
      assert.equal(
        i18nMessages.includes(`"ko":"${copy}"`),
        false,
        `${copy} 모호한 한국어 UI 문구가 다시 추가되었습니다.`,
      );
    }
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
    assertIncludesAll(
      app,
      QUALITY_201_300_APP_CONTRACTS,
      contract => `${contract} 201–300 품질 보강 계약이 없습니다.`,
    );
    assertIncludesAll(
      styles,
      QUALITY_201_300_STYLE_CONTRACTS,
      contract => `${contract} 201–300 품질 스타일 계약이 없습니다.`,
    );
    assertIncludesAll(
      i18nMessages,
      QUALITY_201_300_I18N_CONTRACTS,
      contract => `${contract} 201–300 품질 번역 계약이 없습니다.`,
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
    assert.ok(mainEntry.includes('macPathEntries(os.homedir(), process.env.PATH)'), 'macOS PATH 조회가 검증된 정적 경로 병합기를 사용해야 합니다.');
    assert.ok(!mainEntry.includes('execFileSync(shellPath'), '앱 창 생성 전에 사용자 셸 초기화를 동기 실행하면 안 됩니다.');
    for (const channel of APP_IPC_CHANNELS) {
      assert.ok(
        ipcSource.includes(`handleTrusted('${channel}'`),
        `${channel} IPC 등록이 없습니다.`,
      );
    }
    for (const channel of TRUSTED_IPC_CHANNELS) {
      assert.ok(ipcSource.includes(`handleTrusted('${channel}'`), `${channel} IPC에 신뢰 발신자 검증이 없습니다.`);
    }
    assert.ok(ipcSource.includes("ipcMain.handle('terminals:write'"), '터미널 입력 IPC 응답 계약이 없습니다.');
    assert.ok(ipcSource.includes("ipcMain.handle('terminals:resize'"), '터미널 크기 변경 IPC 응답 계약이 없습니다.');
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
    assert.equal(pkg.build.portable.unpackDirName, false);
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

  test('종료된 세션은 최근 기록 위치만 유지하고 실제 상태와 수동 기록 이동을 보존한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
    const values = new Map();
    const sandbox = {
      localStorage: {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
      },
      document: { documentElement: { dataset: {} } },
      window: {
        LoadToAgentAppFactories: {},
        LoadToAgentRendererUtils: {
          $: () => null, $$: () => [], esc: value => String(value), uiLocale: () => 'ko',
          providerLabel: value => value, reportRecoverableError: () => {},
        },
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        LoadToAgentI18n: { t: key => key, observedText: value => value },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app.js' });
    const core = sandbox.window.LoadToAgentAppFactories.createCore({});
    const now = Date.parse('2026-07-23T01:00:00.000Z');
    const responseAt = new Date(now - 5 * 60 * 1000).toISOString();
    const ended = { id: 'ended', status: 'completed', messages: [{ role: 'assistant', timestamp: responseAt }] };
    assert.equal(core.isControlRoomSession(ended, now), false);
    const waitingWithBackground = {
      ...ended,
      id: 'waiting-background',
      status: 'waiting',
      executions: [{ id: 'background-1', status: 'running', mode: 'background' }],
    };
    assert.equal(core.isControlRoomSession(waitingWithBackground, now), true);
    assert.equal(core.controlRoomStatus(waitingWithBackground, now), 'waiting');
    assert.equal(core.isControlRoomSession({ ...ended, status: 'running' }, now), true);
    assert.equal(core.isControlRoomSession(ended, now), true);
    assert.equal(core.controlRoomStatus(ended, now), 'completed');
    assert.equal(core.sessionRetentionMinutes(ended, now), 25);
    assert.equal(core.archiveSession(ended), true);
    assert.equal(core.isControlRoomSession(ended, now), false);
    const resumed = {
      ...ended,
      messages: [...ended.messages, { role: 'assistant', timestamp: new Date(now - 60 * 1000).toISOString() }],
    };
    assert.equal(core.isControlRoomSession(resumed, now), true);
    const expired = { ...ended, id: 'expired', messages: [{ role: 'assistant', timestamp: new Date(now - 31 * 60 * 1000).toISOString() }] };
    assert.equal(core.isControlRoomSession({ ...expired, status: 'running' }, now), true);
    assert.equal(core.isControlRoomSession(expired, now), false);
    const child = { ...ended, id: 'child', parentId: 'root' };
    const rootSession = { ...ended, id: 'root', childIds: ['child'] };
    core.state.snapshot = { sessions: [rootSession, child] };
    assert.equal(core.isControlRoomSession({ ...rootSession, status: 'running' }, now), true);
    assert.equal(core.isControlRoomSession({ ...child, status: 'running' }, now), true);
    assert.equal(core.archiveSession('root'), true);
    assert.equal(core.isControlRoomSession(child, now), false);
    assert.ok(values.get(core.SESSION_ARCHIVE_STORAGE_KEY));
  });

  test('서브에이전트 대화에 메인 AI의 SendMessage 후속 지시를 시간순으로 합친다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-drawer-content.js'), 'utf8');
    const sandbox = {
      window: {
        LoadToAgentAppFactories: {},
        LoadToAgentI18n: { t: key => key, observedText: value => value },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-drawer-content.js' });
    const parent = {
      id: 'claude:parent',
      messages: [],
      collaboration: {
        communications: [{
          id: 'followup:send-1',
          kind: 'followup',
          childId: 'claude:child',
          taskName: '토큰 확인',
          from: 'claude:parent',
          to: 'claude:child',
          text: 'SECOND-4DB8과 FIRST를 결합해줘',
          timestamp: '2026-07-14T01:00:03Z',
        }],
      },
    };
    const child = {
      id: 'claude:child',
      parentId: parent.id,
      taskName: '토큰 확인',
      agentPath: 'claude:child',
      startedAt: '2026-07-14T01:00:01Z',
      updatedAt: '2026-07-14T01:00:04Z',
      delegation: { taskName: '토큰 확인', startedAt: '2026-07-14T01:00:01Z' },
      messages: [
        { id: 'child-user', role: 'user', text: 'FIRST-91C2를 반환해줘', timestamp: '2026-07-14T01:00:01Z' },
        { id: 'child-first', role: 'assistant', text: 'FIRST-91C2', timestamp: '2026-07-14T01:00:02Z' },
        { id: 'child-second', role: 'assistant', text: 'FIRST-91C2 SECOND-4DB8', timestamp: '2026-07-14T01:00:04Z' },
      ],
    };
    const details = new Map([[parent.id, parent], [child.id, child]]);
    const drawer = sandbox.window.LoadToAgentAppFactories.createDrawerContent({
      state: { details },
      snapshotSession: id => details.get(id),
      agentPathTaskName: value => String(value || '').split(':').pop(),
    });
    const messages = drawer.subagentWorkMessages(child);
    assert.deepStrictEqual(
      Array.from(messages, message => [message.role, message.text]),
      [
        ['user', 'FIRST-91C2를 반환해줘'],
        ['assistant', 'FIRST-91C2'],
        ['user', 'SECOND-4DB8과 FIRST를 결합해줘'],
        ['assistant', 'FIRST-91C2 SECOND-4DB8'],
      ],
    );
  });

  test('AI 표시 설정은 기본값·저장값·세션과 tmux 투영을 일관되게 적용한다', () => {
    const source = [
      fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8'),
      fs.readFileSync(path.join(root, 'renderer', 'app-provider-visibility.js'), 'utf8'),
    ].join('\n');
    const values = new Map();
    const sandbox = {
      localStorage: {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
      },
      document: { documentElement: { dataset: {} } },
      window: {
        LoadToAgentAppFactories: {},
        LoadToAgentRendererUtils: {
          $: () => null, $$: () => [], esc: value => String(value), uiLocale: () => 'ko',
          providerLabel: value => value, reportRecoverableError: () => {},
        },
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        LoadToAgentI18n: { t: key => key },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app.js' });
    const core = sandbox.window.LoadToAgentAppFactories.createCore({});
    Object.assign(core, sandbox.window.LoadToAgentAppFactories.createProviderVisibility(core));
    core.state.providers = ['claude', 'codex', 'gemini', 'grok'].map(id => ({ id }));
    core.loadProviderVisibility();
    assert.deepStrictEqual(Array.from(core.state.hiddenProviders), []);
    core.setProviderVisible('claude', false);
    assert.deepStrictEqual(JSON.parse(values.get(core.PROVIDER_VISIBILITY_STORAGE_KEY)), { hidden: ['claude'] });
    core.state.rawSnapshot = {
      sessions: [
        { id: 'hidden', provider: 'claude', status: 'waiting', usage: { total: 10 } },
        { id: 'shown', provider: 'codex', status: 'running', usage: { total: 20 } },
      ],
      summary: { providers: [{ id: 'claude' }, { id: 'codex' }] },
      tmux: { distros: [{ id: 'd', sessions: [{ id: 's', windows: [{ id: 'w', panes: [
        { id: 'hidden-pane', agent: { provider: 'claude' } },
        { id: 'shown-pane', agent: { provider: 'codex', linkedSessionId: 'shown' } },
        { id: 'shell-pane', agent: null },
      ] }] }] }] },
    };
    const projected = core.projectVisibleSnapshot(core.state.rawSnapshot);
    assert.deepStrictEqual(Array.from(projected.sessions, session => session.id), ['shown']);
    assert.deepStrictEqual(
      Array.from(projected.tmux.distros[0].sessions[0].windows[0].panes, pane => pane.id),
      ['shown-pane', 'shell-pane'],
    );
    assert.equal(projected.summary.totals.active, 1);
    assert.equal(projected.summary.totals.waiting, 0);
    assert.equal(projected.tmux.summary.aiPanes, 1);
    core.loadProviderVisibility({ hidden: ['gemini', 'unknown'] });
    assert.deepStrictEqual(Array.from(core.state.hiddenProviders), ['gemini']);
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
  test('UI 전수 점검 장부는 기존 항목을 제외해 1–300 완료 항목을 정확히 기록한다', () => {
    const auditFiles = [
      ['UI-AUDIT-100.md', 1],
      ['UI-AUDIT-101-200.md', 101],
      ['UI-AUDIT-201-300.md', 201],
    ];
    const allItems = [];
    for (const [file, start] of auditFiles) {
      const source = fs.readFileSync(path.join(root, 'docs', file), 'utf8');
      const items = [...source.matchAll(/^(\d+)\. \[x\]/gm)].map(match => Number(match[1]));
      assert.equal(items.length, 100, `${file} 완료 항목이 100개가 아닙니다.`);
      assert.deepStrictEqual(items, Array.from({ length: 100 }, (_, index) => start + index), `${file} 번호가 예상 범위와 다릅니다.`);
      assert.equal(source.includes('[ ]'), false, `${file}에 검증되지 않은 UI 점검 항목이 남아 있습니다.`);
      allItems.push(...items);
    }
    assert.equal(allItems.length, 300, '전체 UI 점검 장부 완료 항목이 300개가 아닙니다.');
    assert.equal(new Set(allItems).size, 300, 'UI 점검 항목 번호가 겹칩니다.');
  });

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
