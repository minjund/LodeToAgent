'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const SYNTAX_CHECK_FILES = [
  'main.js',
  'preload.js',
  'bin/whitebox.js',
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
  'src/windowsShellIdentity.js',
  'src/ipc/registerAppIpc.js',
  'src/ipc/registerAgentIpc.js',
  'src/ipc/registerTerminalIpc.js',
  'src/ipc/registerTmuxIpc.js',
  'src/ipc/registerWorkspaceIpc.js',
  'renderer/i18n-messages.js',
  'renderer/i18n.js',
  'renderer/conversation-delivery.js',
  'renderer/shared.js',
  'renderer/ime-submit.js',
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
  'renderer/terminal-composer.js',
  'renderer/terminal-events.js',
  'renderer/terminal.js',
  'renderer/inline-agent-terminal.js',
  'renderer/drawer-terminal.js',
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
  'drawerResizeHandle',
  'drawerBackToFlowBtn',
  'runModal',
  'quickPaletteModal',
  'quickPaletteInput',
  'shortcutHelpModal',
  'shortcutHelpBtn',
  'sessionResultSummary',
  'emptyClearFiltersBtn',
  'clearRunDraftBtn',
  'terminalCommandClearBtn',
  'terminalSlashMenu',
  'terminalSlashMenuList',
  'terminalSlashTrigger',
  'terminalLongDraftMeta',
  'terminalLongDraftToggle',
  'terminalFontDecreaseBtn',
  'terminalFontIncreaseBtn',
  'terminalFontSizeLabel',
  'terminalFocusBtn',
  'drawerContent',
  'drawerComposer',
  'drawerTerminalSurface',
  'drawerTerminalViewport',
  'drawerTerminalStatus',
  'drawerTerminalReconnectBtn',
  'drawerTerminalResumeBtn',
  'drawerTabSummary',
  'drawerTabChat',
  'sidebarAppVersion',
  'backToProjectsBtn',
  'projectSelectionPrompt',
  'settingsSection',
  'languageSettingsTitle',
  'languageSelect',
  'providerVisibilityList',
  'currentVersion',
  'latestVersion',
  'checkUpdateBtn',
  'updateStateTitle',
];

const RUN_COMPOSER_IDS = [
  'runPromptCount', 'runWorkspaceSuggestions',
  'runClaudePermissionModeField', 'runClaudePermissionMode', 'runClaudePermissionModeHelp',
];
const TMUX_ONLY_IDS = ['newTmuxSessionBtn', 'terminalTmuxList', 'tmuxControlSection'];

const BEGINNER_GUIDE_LABELS = [
  '첫 10분 코스',
  '이 네 가지만 익히면 충분해요',
  '새 AI 작업',
  '진행 중인 작업 확인',
  '확인할 일 보기',
  '작업 자세히 보기',
  '>처리 중<',
  '>지난 작업<',
  '>확인 대기<',
  '>추가 기능<',
  '>반복 일정<',
  '>다른 컴퓨터의 작업<',
  '내 컴퓨터',
  'AI 대화 기록',
  '이 AI 대화는 오른쪽 입력칸에서 이어갈 수 있습니다',
  '선택한 컴퓨터에 작업 추가',
  'Enter(엔터): 보내기 · Shift+Enter(시프트+엔터): 줄 바꿈',
  '관련 작업에서 결과를 볼 항목 선택',
  '새 AI 작업 시작',
  '처리 중인 작업',
  '에서 함께 볼 새 작업 시작',
  '설치 버전과 최신 버전 비교',
  '최신 버전 다시 확인',
];

const DISALLOWED_UI_JARGON = [
  'AI AGENT OBSERVATORY',
  'SESSION STREAM',
  'AGENT MIND MAP',
  'NEW TMUX SESSION',
  '기억에서 증거 찾기',
  '내 응답과 상태 신호 확인',
  '인과 기억',
  '끝난 의도',
  '보존된 계보',
  '에이전트 운영 상태',
];

const SEMANTIC_UI_COPY = [
  '현재 상태를 확실히 알 수 없음',
  '최근 활동',
  '작업 화면을 열어 현재 상태 확인 필요',
  '완료 기록 확인됨',
  '완료 기록을 찾지 못함',
  '작업 기록에서 찾은 파일과 결과',
  '작업 기록에 남은 테스트 결과',
  '네, ‘{name}’으로 변경',
  '지금은 바꾸지 않기',
  '다른 AI로 새 작업 만들기',
  '현재 설치된 버전',
  '내 답변을 기다리는 중',
  '완료 여부를 직접 확인해야 하는 작업',
  '2분 이상 새 활동 없음',
  'AI가 한 번에 참고할 수 있는 양을 75% 이상 사용',
  '이 일을 맡긴 담당 AI 정보를 찾지 못함',
  '현재 실행 중인 작업',
  '전체 지난 작업 {total}건 · 작업 완료 {new}건 · 결과 확인 완료 {reviewed}건',
  '실행 횟수',
  '컴퓨터 작업과 AI 대화',
  '다른 컴퓨터의 작업',
  '작업 폴더',
  '함께 작업하는 AI',
  '담당 AI가 나눠 맡긴 작업',
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
  'AI 작업 위치',
  'AI 작업 관리 상태',
];

const MANAGEMENT_SEMANTIC_CONTRACTS = [
  'function matchesManagementFilter',
  'EXPLICIT_ATTENTION_SOURCES.has(session.attention.source)',
  'ACTIONABLE_RISK_SIGNALS.has(signal.code)',
  'RECENT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000',
  'function managementBucket(session, now = Date.now())',
  'needsManagementReview',
  'needsManagementInbox',
  'data-attention-category',
  'management-filter-group optional',
  'management-filter-group response',
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
  'window.WhiteboxAppFactories',
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
  'window.WhiteboxApp = app',
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
  'openSubagentConversation(subagentChat.dataset.openSubagentChat, { context: true })',
  'data-subagent-completed-toggle',
  'data-resume-agent',
  'data-subagent-message-preview',
  'data-truncated',
  'assignmentProtected',
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
  'CONTEXT_DRAWER_MIN_WIDTH',
  'CONTEXT_WORKSPACE_MIN_WIDTH',
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
  'function interruptConversation',
  'data-conversation-interrupt',
  '{ focus: false, deliveryId }',
  'function openAgentTerminal',
  'drawerPresentation',
  'function copyBridgeCommand',
  'data-agent-command-form',
  'data-agent-command-draft',
  'data-agent-command-route-selected',
  'data-conversation-slash-menu',
  'data-conversation-slash-command',
  'data-agent-terminal-open',
  'data-agent-bridge-copy',
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
  'data-user-prompt',
  'data-prompt-toggle',
  'data-user-prompt-copy',
  'function memoryCandidatesHtml',
  'data-scroll-latest',
  'conversationTurnLimits',
  'data-load-earlier-turns',
  'drawer.loading_history_inline',
  'drawer.load_earlier_turns',
  'data-graph-focus',
  'data-tmux-type',
  'data-open-session',
];

const DRAWER_TERMINAL_CONTRACTS = [
  'const ptyConversation = conversationTab && !session.parentId && !subagentMode && !executionMode',
  'const embeddedTerminal = window.WhiteboxTerminal?.embeddedState?.() || {}',
  'embeddedTerminal.connected',
  'window.WhiteboxDrawerTerminal?.canMount?.(session, target.id)',
  'readablePreview(rawDrawerTitle || t("drawer.title"), 120)',
  'drawer.dataset.conversationShell = conversationTab ? "terminal" : "standard"',
  'terminalSurface.setAttribute("aria-labelledby", "drawerTabChat")',
  'terminalStyle: conversationTab',
  'window.WhiteboxDrawerTerminal?.mount?.(session',
  'state.drawerCreateTerminalIfMissing = options.createTerminalIfMissing !== false',
  'createIfMissing: createTerminalIfMissing',
  'ensureForAgent',
  'resumeForAgent',
  'window.WhiteboxDrawerTerminal?.unmount?.()',
  'composer.classList.toggle("hidden", !showComposer)',
  '&& !actualTerminalChat',
  'composer.dataset.mode = actualTerminalChat ? "terminal" : "conversation"',
  'whitebox:drawer-terminal-targets-changed',
  'window.WhiteboxTerminal.resumeForAgent(session, \'\', false, { focus: false })',
  'drawer.terminal_resume_available',
  'function setResumeAction(visible)',
  'function showUnavailable(session)',
  "markUnavailable(session.id, requestedTargetId, 'mount-failed')",
  'mountForAgent',
  'unmountEmbedded',
  'embeddedTerminalId',
  'const generation = ++state.embeddedGeneration',
  'await window.whitebox.terminalReconnect(terminalId)',
  'state.terminals.delete(session.id)',
  'entry.terminal.dispose()',
  'state.selectedId !== key && state.embeddedTerminalId !== key',
  'startAgent',
  'initialCommandInArgs',
  'drawerTerminalSurface',
  'drawerTerminalViewport',
];

const APP_AGENT_CONTRACTS = [
  ...AGENT_GRAPH_CONTRACTS,
  ...COLLABORATION_VIEW_CONTRACTS,
  ...WORKFLOW_INTERACTION_CONTRACTS,
  ...MOTION_AND_MAP_CONTRACTS,
  ...TERMINAL_VIEW_CONTRACTS,
];

const STYLE_FILES = [
  'styles-bundle.css',
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
  'styles-drawer-terminal.css',
];

const I18N_RUNTIME_CONTRACTS = [
  "const DEFAULT_LOCALE = 'en'",
  "'ko', 'en', 'zh-CN'",
  'whitebox:locale:v1',
  'return SUPPORTED.has(saved) ? saved : DEFAULT_LOCALE',
  'window.WhiteboxI18n',
  'whitebox:locale-changed',
  'MutationObserver',
  'function t(key, params)',
  'function errorText(error, fallbackKey, params)',
  'function observedText(value)',
  'data-i18n',
];

const I18N_MESSAGE_CONTRACTS = [
  'window.WhiteboxMessages',
  'settings.title',
  'Language, screen, AI list, and updates',
  '语言、画面、AI 列表和更新',
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
  'conversation-context-open',
  'conversation-slash-menu',
  'conversation-slash-command',
  'drawer-resize-handle',
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
  'roots.forEach(enhanceQualityControls)',
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
  'terminalDetach',
  'terminalReconnect',
  'terminalStop',
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
  'function requiredAgentTarget',
  'function resumeSupport',
  'parentControlled: true',
  'CODEX_DESKTOP_SESSION_ORIGIN_OWNED',
  'WHITEBOX_BRIDGE_PROJECTION_ORIGIN_OWNED',
  "['codex', 'claude', 'gemini', 'grok']",
  "promptMode: provider === 'grok' ? 'terminal' : 'arguments'",
  "terminal.type === 'agent'",
  'sub-agent is controlled by its parent',
  'function resumeForAgent',
  "provider === 'codex' ? ['resume', sessionId] : ['--resume', sessionId]",
  'function dispatchAgentCommand',
  'function interruptAgent',
  'function openForAgent',
  'function bindAgent',
  'function renderHistoryPanel',
  'function queueHistoryRefresh',
  'selectTmuxById',
  'window.WhiteboxTerminal',
  "t('terminal.detach_tmux_input')",
  "t('terminal.recovered_after_host_restart')",
  "t('terminal.status.detached')",
  "t('terminal.status.stopped')",
  "session.backend === 'managed-tmux'",
  'window.whitebox.terminalDetach(session.id)',
  'window.whitebox.terminalReconnect(session.id)',
  'window.whitebox.terminalStop(session.id)',
  'entry.pendingResize',
  'if (!rehydratedIds.has(id)) state.commandDrafts.delete(id)',
  'resizeObserver.observe',
  'window.WhiteboxTerminalComposer',
  'function slashQuery',
  'function filterCommands',
  'function isLongDraft',
  'form.dataset.aiTarget',
  'form.dataset.longDraft',
  'composer?.handleKeydown(event)',
  'function sendRawInputToCurrentSession',
  "context.sendRawInput?.('\\u001b[Z')",
  "context.provider !== 'claude'",
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
  'function backgroundAgentRuns',
  'function backgroundWorkloadCount',
  'function ensureBackgroundTray',
  'function updateBackgroundTrayMenu',
  'function mainText',
  '프로그램 끝내기 · 명령창은 유지, 직접 실행은 중지',
  'Quit · Keep terminals, stop direct runs',
  '退出 · 保留终端并停止直接运行',
  'new TerminalHostClient',
  "terminalManager.on('reconnect'",
  "terminalManager.on('reconnect-error'",
  'function connectTerminalForStartup',
  "reportRecoverableError('terminal-host-startup-connect'",
  "sendTerminal('terminals:connection'",
  'terminalManager.dispose({ shutdownIfIdle: true })',
  'let quitCleanupPromise = null',
  'let quitCleanupComplete = false',
  'function quitCleanupTask',
  'async function cleanupBeforeQuit',
  "quitCleanupTask('agent-runner', () => runner && runner.dispose())",
  "app.on('before-quit', event =>",
  'if (quitCleanupComplete) return',
  'if (quitCleanupPromise) return',
  'quitCleanupComplete = true',
  'setImmediate(() => app.quit())',
  "session.status === 'running' || session.status === 'starting'",
  '!isInternalTerminalProjectionSessionId(session.bridgeId)',
  "terminalSessions: sessions.filter(session => ['running', 'starting', 'stopping'].includes(session.status))",
  "session.status === 'detached'",
  'event.preventDefault()',
  'mainWindow.hide()',
  'const showFallback = setTimeout(showWindow, 2_000)',
  'function registerIpcHandlers',
  'function createAttentionNotifier',
  'const DESKTOP_NOTIFICATIONS_ENABLED = true',
  'enabled: DESKTOP_NOTIFICATIONS_ENABLED',
  "event === 'completed' ? 'completionTitle' : 'attentionTitle'",
  "completionFallback: 'AI 작업이 완료되었습니다.'",
  "completionFallback: 'The AI task is complete.'",
  "completionFallback: 'AI 任务已完成。'",
  "notificationDetail || mainText('completionFallback')",
  ": (notificationDetail || session.title || '이름 없는 작업')",
  'title: notificationCopy',
  'function notifyTerminalPrompt',
  "attentionNotifier.sync(visibleSnapshotSessions(lastSnapshot))",
  "agents:attention-requested",
  "pendingAttentionSessionId",
  "markRendererReady",
  "readUpdateRelaunchRequest",
  "signalRendererReady",
  "updateRelaunchReady",
  "let updateInstallPromise = null",
  "function performDownloadedUpdateInstall",
  "async function updateInstallPlan",
  "findInstalledDesktopApp",
  "readDesktopAppVersion",
  "currentVersionKnown: updateCurrentVersionKnown",
  "blockedReason: updateBlockedReason",
  "installed-app-version",
  "async function confirmActiveTerminalUpdate",
  "installCanceled",
  "did-start-loading",
];

const APP_IPC_CHANNELS = [
  'app:renderer-ready',
  'app:background-state',
  'app:show',
  'app:set-locale',
  'app:notify-attention-prompt',
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
  'notifyAttentionPrompt',
  'checkForUpdate',
  'downloadUpdate',
  'openDownloadedUpdate',
  'installDownloadedUpdate',
  'onUpdateState',
  'onAttentionRequested',
  'onTerminalPromptResolved',
  'onTerminalConnection',
  'async function terminalWrite(id, data, options)',
  "ipcRenderer.invoke('terminals:write', id, data, options)",
  'terminalWrite,',
  "terminalResize: (id, cols, rows) => ipcRenderer.invoke('terminals:resize'",
  "terminalDetach: id => ipcRenderer.invoke('terminals:detach'",
  "terminalReconnect: id => ipcRenderer.invoke('terminals:reconnect'",
  "terminalStop: id => ipcRenderer.invoke('terminals:stop'",
  "terminalRetire: id => ipcRenderer.invoke('terminals:retire'",
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
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
  'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
  'gh release create',
  'release/*.exe',
  'release/*.dmg',
  'release/*.zip',
  'Whitebox-Windows',
  'Whitebox-macOS',
  'npm_version.outputs.published',
  'id-token: write',
  'npm publish --access public --tag latest',
  'Verify npm publication',
  'npm run test:drawer-conversation',
  'npm run test:drawer-actual-pty',
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
  test('프로젝트 경로 정규화는 빈 경로와 POSIX 루트를 구분한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-dashboard.js'), 'utf8');
    const helperStart = source.indexOf('function normalizedProjectPath(value)');
    const helperEnd = source.indexOf('function projectName(projectPath)', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, '프로젝트 경로 helper를 찾을 수 없습니다.');
    const sandbox = {};
    vm.runInNewContext(`${source.slice(helperStart, helperEnd)}\nthis.helpers = { normalizedProjectPath, projectContainsPath };`, sandbox, {
      filename: 'app-dashboard-project-path-helpers.js',
    });
    const { normalizedProjectPath, projectContainsPath } = sandbox.helpers;

    assert.equal(normalizedProjectPath(''), '');
    assert.equal(normalizedProjectPath(undefined), '');
    assert.equal(normalizedProjectPath('/'), '/');
    assert.equal(normalizedProjectPath('///'), '/');
    assert.equal(normalizedProjectPath('C:\\'), 'c:');
    assert.equal(normalizedProjectPath('/mnt/C/Users/Example/'), 'c:/users/example');
    assert.equal(projectContainsPath('/', '/workspace/project'), true);
    assert.equal(projectContainsPath('/', '/'), true);
    assert.equal(projectContainsPath('/', ''), false);
    assert.equal(projectContainsPath('', '/workspace/project'), false);
    assert.equal(projectContainsPath('/workspace', '/workspace/project'), true);
    assert.equal(projectContainsPath('/workspace', '/workspace-other'), false);
    assert.equal(projectContainsPath('C:\\', 'c:\\Users\\Example'), true);
  });

  test('최신 AI 요청에 답이 없으면 지난 답변을 새 응답처럼 붙이지 않는다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-session-render.js'), 'utf8');
    const sandbox = {
      window: {
        WhiteboxAppFactories: {},
        WhiteboxI18n: { t: key => key, observedText: value => value },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-session-render.js' });
    const renderer = sandbox.window.WhiteboxAppFactories.createSessionRenderer({
      state: {},
      readablePreview: text => ({ text: String(text), full: String(text) }),
      providerInfo: provider => ({ label: provider }),
    });
    const waiting = renderer.recentConversation({
      provider: 'claude',
      messages: [
        { role: 'user', text: '지난 질문' },
        { role: 'assistant', text: '지난 답변' },
        { role: 'user', text: '아직 답이 없는 새 질문' },
      ],
    });
    assert.deepStrictEqual(
      Array.from(waiting, row => [row.tone, row.text]),
      [['user', '아직 답이 없는 새 질문']],
    );

    const answered = renderer.recentConversation({
      provider: 'claude',
      messages: [
        { role: 'user', text: '지난 질문' },
        { role: 'assistant', text: '지난 답변' },
        { role: 'user', text: '새 질문' },
        { role: 'assistant', text: '새 답변' },
      ],
    });
    assert.deepStrictEqual(
      Array.from(answered, row => [row.tone, row.text]),
      [['user', '새 질문'], ['assistant', '새 답변']],
    );
  });

  test('필수 UI 영역과 초보자용 안내 계약이 존재한다', () => {
    const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
    const monitorWorker = fs.readFileSync(path.join(root, 'src', 'monitorWorker.js'), 'utf8');
    const appSource = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
    const agentActions = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    const messages = fs.readFileSync(path.join(root, 'renderer', 'i18n-messages.js'), 'utf8');
    for (const id of REQUIRED_UI_IDS) assert.ok(html.includes(`id="${id}"`));
    for (const id of RUN_COMPOSER_IDS) assert.ok(html.includes(`id="${id}"`));
    assertIncludesAll(html, BEGINNER_GUIDE_LABELS, label => `${label} 문구가 없습니다.`);
    assertExcludesAll(
      html,
      DISALLOWED_UI_JARGON,
      jargon => `${jargon} 전문 용어가 기본 화면에 남아 있습니다.`,
    );
    assert.ok(
      html.includes('id="runProjectName" class="run-modal-project-name"')
        && !html.includes('id="runProjectLock"')
        && html.includes('id="runCwd" required readonly aria-readonly="true"'),
      '새 작업 창은 현재 프로젝트 이름만 표시하고 작업 경로는 내부에서 변경할 수 없게 고정해야 합니다.',
    );
    assertIncludesAll(
      monitorWorker,
      MONITOR_WORKER_CONTRACTS,
      contract => `${contract} 협업 전송 계약이 없습니다.`,
    );
    assertIncludesAll(appSource, ['const ACTIVITY_STATUS', 'sessionStatusLabel', 'session.activityState']);
    assert.ok(appSource.includes('pendingPromptForSession?.(session) || explicitWaiting'), '터미널·구조화 승인 요청을 대기 중 배지로 우선 표시하지 않습니다.');
    assertIncludesAll(messages, [
      '"ui.agent_thinking": {"ko":"생각 중"',
      '"ui.agent_working": {"ko":"작업 중"',
      '"ui.agent_waiting": {"ko":"대기 중"',
      '"ui.agent_idle": {"ko":"대기"',
    ]);
    assert.ok(monitorWorker.includes('activityState: session.activityState'), 'compact snapshot에 activityState가 전달되지 않습니다.');
    assert.match(
      monitorWorker,
      /session\.status,\r?\n\s+session\.activityState,/,
      'activityState만 바뀐 snapshot을 게시하지 못합니다.',
    );
    assert.match(
      monitorWorker,
      /session\.status,\r?\n\s+session\.activityState,\r?\n\s+completionPresentationFingerprint\(session\),/,
      '완료 표시용 답변만 바뀐 snapshot을 다시 게시하지 못합니다.',
    );
    assert.match(
      monitorWorker,
      /function completionPresentationFingerprint\(session\)[\s\S]*normalizedFingerprintText\(session && session\.result, 1200\)[\s\S]*normalizedFingerprintText\(session && session\.outcome && session\.outcome\.summary, 800\)[\s\S]*normalizedFingerprintText\(latestAssistantText, 420\)/,
      '완료 알림 fingerprint는 제한된 result·outcome·최신 AI 답변만 사용해야 합니다.',
    );
    assert.match(
      monitorWorker,
      /function normalizedFingerprintText\(value, limit\)\s*\{\r?\n\s+return clip\(value, limit\)\.replace\(\/\\s\+\/g, ' '\);/,
      '완료 알림 fingerprint 문구는 크기를 제한하고 공백을 정규화해야 합니다.',
    );
    assert.ok(agentActions.includes('"status", "activityState", "statusDetail"'), '상세 화면이 최신 activityState를 덮어쓰지 못합니다.');
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
    const projectContextTag = html.match(/<section id="projectContextNav"[^>]*>/)?.[0] || '';
    assert.ok(
      projectContextTag.includes(' hidden"')
        && projectContextTag.includes('aria-hidden="true"')
        && projectContextTag.includes(' inert'),
      '이번 배포에서 프로젝트 탐색 영역 전체는 여백을 남기지 않고 화면과 보조 기기에서 모두 숨겨야 합니다.',
    );
    const sidebarBlock = html.slice(html.indexOf('<aside class="sidebar"'), html.indexOf('<main id="mainContent"'));
    const liveBlock = html.slice(html.indexOf('id="liveSection"'), html.indexOf('id="globalStats"'));
    assert.equal(sidebarBlock.includes('id="workspaceList"'), false, '데스크톱 사이드바에 프로젝트 목록이 다시 들어가면 안 됩니다.');
    assert.ok(sidebarBlock.includes('id="sidebarNewProjectBtn"'), '프로젝트 목록 머리글에 프로젝트 추가 버튼이 없습니다.');
    assert.equal(
      sidebarBlock.slice(sidebarBlock.indexOf('id="sidebarNewProjectBtn"'), sidebarBlock.indexOf('id="projectSidebarList"')).includes('data-open-run'),
      false,
      '왼쪽 프로젝트 추가 버튼이 새 AI 작업 시작 동작과 섞여 있습니다.',
    );
    assert.ok(liveBlock.includes('id="projectTaskToolbar"') && liveBlock.includes('id="newRunBtn"'), '새 AI 작업 버튼은 선택한 프로젝트 영역에 있어야 합니다.');
    assert.ok(liveBlock.includes('id="workspaceList"') && liveBlock.includes('id="addWorkspaceBtn"'), '프로젝트 목록과 추가 버튼이 실행 세션 영역에 없습니다.');
    assert.ok(liveBlock.indexOf('id="workspaceList"') < liveBlock.indexOf('id="addWorkspaceBtn"'), '프로젝트 추가 버튼은 프로젝트 목록 오른쪽 순서에 있어야 합니다.');
    assert.ok(liveBlock.indexOf('id="controlRoomExpandAll"') < liveBlock.indexOf('id="liveSessionGrid"'), '프로젝트 전체 열기·닫기 버튼은 목록 상단에 있어야 합니다.');
    assert.equal(liveBlock.includes('controlRoomPagePrev'), false, '실행 세션 페이징 버튼이 남아 있습니다.');
    const rendererSource = files => files
      .map(file => fs.readFileSync(path.join(root, 'renderer', file), 'utf8'))
      .join('\n');
    const app = rendererSource(APP_MODULES);
    const terminalIntegration = rendererSource([
      'terminal-workbench.js',
      'terminal-agent.js',
      'terminal.js',
      'inline-agent-terminal.js',
      'drawer-terminal.js',
    ]);
    assertIncludesAll(
      app,
      APP_PUBLIC_API_CONTRACTS,
      contract => `${contract} 앱 공개 API 계약이 없습니다.`,
    );
    assertIncludesAll(app, APP_READABILITY_CONTRACTS);
    assertIncludesAll(app, APP_AGENT_CONTRACTS);
    assertIncludesAll(
      `${app}\n${terminalIntegration}\n${html}`,
      DRAWER_TERMINAL_CONTRACTS,
      contract => `${contract} 드로어 PTY 계약이 없습니다.`,
    );
    const drawerSource = fs.readFileSync(path.join(root, 'renderer', 'app-drawer.js'), 'utf8');
    const drawerTerminalSource = fs.readFileSync(path.join(root, 'renderer', 'drawer-terminal.js'), 'utf8');
    const terminalSource = fs.readFileSync(path.join(root, 'renderer', 'terminal.js'), 'utf8');
    const terminalAgentSource = fs.readFileSync(path.join(root, 'renderer', 'terminal-agent.js'), 'utf8');
    assert.match(
      terminalAgentSource,
      /async function openForAgent\(agentSession, targetId = '', draft = '', options = \{\}\)[\s\S]*selectSession\(target\.terminalId, 'question', \{[\s\S]*focus: options\.focus !== false,[\s\S]*isCurrent: options\.isCurrent/,
      '자동 질문 이동은 PTY를 열되 질문 팝업의 텍스트 포커스를 보존할 수 있어야 합니다.',
    );
    assert.equal(html.includes('id="drawerTabTerminal"'), false, '대화와 분리된 터미널 탭을 다시 만들면 안 됩니다.');
    assert.ok(html.includes('id="drawerTabChat"'), '대화 탭이 없습니다.');
    assert.equal(drawerSource.includes('state.drawerTab === "terminal"'), false, '별도 터미널 탭 상태 분기가 남아 있습니다.');
    assert.equal(drawerSource.includes('tab.dataset.tab === "terminal"'), false, '별도 터미널 탭 렌더링 분기가 남아 있습니다.');
    assert.equal(drawerSource.includes('transcriptChat'), false, '상위 세션 대화 탭에 transcript fallback이 남아 있습니다.');
    assert.match(drawerSource, /const showComposer =[^;]*&& !actualTerminalChat/s, 'PTY 아래에는 별도 채팅 composer를 만들면 안 됩니다.');
    assert.doesNotMatch(
      drawerSource,
      /const terminalTargets\s*=[^;]*isLiveSession/s,
      'PTY 연결 여부를 작업 상태값으로 제한하면 waiting/paused 전환에서 같은 PTY가 사라집니다.',
    );
    assert.doesNotMatch(
      drawerSource,
      /conversationSurface\s*=\s*conversationTab\s*\?\s*\(liveTerminalChat\s*\?\s*["']pty["']\s*:\s*["']transcript["']/,
      '정상 대화창은 PTY 연결 완료 전에도 실제 터미널 surface를 유지해야 합니다.',
    );
    assert.match(
      drawerSource,
      /state\.drawerCreateTerminalIfMissing\s*=\s*options\.createTerminalIfMissing\s*!==\s*false[\s\S]*WhiteboxDrawerTerminal\?\.mount\?\.\(session,\s*\{[^}]*createIfMissing:\s*createTerminalIfMissing/s,
      '일반 대화창은 PTY 생성을 허용하고 자동 알람 이동은 생성 없이 mount할 수 있어야 합니다.',
    );
    const sessionSwitchIndex = drawerTerminalSource.indexOf('if (switchingSession)');
    const sessionSwitchUnmountIndex = drawerTerminalSource.indexOf('unmountEmbedded', sessionSwitchIndex);
    const cachedFailureIndex = drawerTerminalSource.indexOf('let cachedFailure', sessionSwitchIndex);
    assert.ok(sessionSwitchIndex >= 0
      && sessionSwitchUnmountIndex > sessionSwitchIndex
      && cachedFailureIndex > sessionSwitchUnmountIndex,
    '다른 작업으로 전환할 때 실패·canMount 판정보다 먼저 이전 PTY를 격리해야 합니다.');
    assert.match(
      terminalSource,
      /const currentTarget\s*=\s*currentTargets\.find[\s\S]*if \(current && currentTarget/,
      'embedded xterm 재사용 전에 현재 작업의 usable terminal인지 확인해야 합니다.',
    );
    assert.match(
      drawerTerminalSource,
      /\['stopped', 'exited', 'failed'\]\.includes[\s\S]*unmountEmbedded/,
      '종료 상태가 inventory에 남아 있어도 embedded xterm을 즉시 해제해야 합니다.',
    );
    assert.doesNotMatch(
      terminalAgentSource,
      /terminalCreate\(\{\s*type:\s*['"]tmux['"]/,
      '메인 대화창이 외부 tmux pane에 입력 가능한 터미널을 직접 붙이면 안 됩니다.',
    );
    assert.match(
      terminalAgentSource,
      /if \(terminal\.backend !== 'direct' \|\| terminal\.conversationBound !== true\) return false;/,
      '메인 대화 입력 대상은 앱이 소유한 direct conversation PTY로 제한해야 합니다.',
    );
    assert.match(
      terminalAgentSource,
      /return resumeForAgent\(agentSession,\s*'',\s*false,\s*\{[\s\S]*focus:\s*false/,
      '기존 앱 소유 PTY가 없으면 원래 세션을 prompt 없이 새 실제 PTY로 재개해야 합니다.',
    );
    assert.match(
      drawerSource,
      /const currentTerminalReady\s*=[\s\S]*const nextTerminalReady\s*=\s*liveTerminalChat\s*\?\s*"true"\s*:\s*"false"[\s\S]*reconcileFocusedComposer/,
      '포커스된 composer도 PTY disconnect 즉시 같은 노드에서 terminal-ready 상태를 갱신해야 합니다.',
    );
    assertIncludesAll(
      app,
      MANAGEMENT_SEMANTIC_CONTRACTS,
      contract => `${contract} 상태·행동 의미 일치 계약이 없습니다.`,
    );
    const managementSource = fs.readFileSync(path.join(root, 'renderer', 'app-management.js'), 'utf8');
    const managementSandbox = {
      window: {
        WhiteboxAppFactories: {},
        WhiteboxI18n: { t: key => key, getLocaleTag: () => 'ko-KR' },
      },
      Intl,
    };
    vm.runInNewContext(managementSource, managementSandbox, { filename: 'app-management.js' });
    let managementResultReviewed = false;
    const managementState = { snapshot: { sessions: [] }, providers: [], availability: {} };
    const management = managementSandbox.window.WhiteboxAppFactories.createManagement({
      state: managementState,
      esc: value => String(value ?? ''),
      providerInfo: () => ({ label: 'Codex', mark: 'C', accent: '#64cbe5' }),
      timeAgo: () => '방금 전',
      readablePreview: value => ({ text: String(value || ''), full: String(value || '') }),
      isResultReviewComplete: session => managementResultReviewed && session?.id === 'result-contract',
      resultReviewTargets: session => session?.pendingResultReview && !managementResultReviewed ? [session] : [],
    });
    const managementNow = Date.parse('2026-08-06T01:00:00.000Z');
    const managementSession = {
      id: 'attention-contract', status: 'waiting', updatedAt: '2026-08-06T01:00:00.000Z',
      attention: { category: 'required', required: true, kind: 'input', requestedAt: '2026-08-06T01:00:00.000Z' },
      health: { signals: [] },
    };
    assert.equal(management.needsManagementInbox({
      ...managementSession,
      attention: { ...managementSession.attention, source: 'assistant-message' },
    }, managementNow), false, '일반 질문 문장 추정은 확인 필요에 들어가면 안 됩니다.');
    assert.equal(management.needsManagementInbox({
      ...managementSession,
      attention: { ...managementSession.attention, source: 'input-tool' },
    }, managementNow), true, '구조화된 사용자 선택 요청은 확인 필요에 들어가야 합니다.');
    assert.equal(management.needsManagementInbox({
      ...managementSession,
      status: 'running',
      attention: { ...managementSession.attention, kind: 'approval', source: 'execution-approval' },
    }, managementNow), true, '실제 권한 승인 대기는 확인 필요에 들어가야 합니다.');
    assert.equal(management.needsManagementInbox({
      ...managementSession,
      status: 'failed',
      attention: { category: 'risk', kind: 'error', source: 'observed-status' },
      health: { signals: [{ code: 'run-failed', severity: 'critical' }] },
    }, managementNow), false, '실패나 위험 신호만으로 확인 필요에 들어가면 안 됩니다.');
    assert.equal(management.needsManagementInbox({
      ...managementSession,
      id: 'stale-completed-outcome', status: 'failed', pendingResultReview: true,
      outcome: { status: 'completed', verified: true, summary: '이전 완료 결과' },
      attention: { category: 'none', required: false },
    }, managementNow), false, '실패 상태에 남은 과거 완료 outcome을 성공 완료 결과로 다시 표시하면 안 됩니다.');
    const managementResultSession = {
      id: 'result-contract', provider: 'codex', title: '완료 결과 확인 계약',
      status: 'completed', statusDetail: '작업 완료', pendingResultReview: true,
      completedAt: '2026-08-06T01:00:00.000Z', updatedAt: '2026-08-06T01:00:00.000Z',
      attention: { category: 'none', required: false },
      outcome: { status: 'completed', verified: true, summary: '요청한 작업을 모두 마쳤습니다.' },
      health: { level: 'healthy', signals: [] },
      evidence: { confidence: 'high' },
    };
    managementState.snapshot.sessions = [managementResultSession];
    assert.equal(management.needsManagementInbox(managementResultSession, managementNow), true,
      '답변 요청이 없는 순수 완료 결과도 확인 대기 목록에 들어가야 합니다.');
    assert.equal(management.needsUserResponse(managementResultSession), false,
      '순수 완료 결과를 실행 흐름을 가리는 답변 대기로 분류하면 안 됩니다.');
    assert.equal(management.needsManagementReview(managementResultSession, managementNow), true,
      '순수 완료 결과가 홈 확인 목록에서 제외되면 안 됩니다.');
    assert.equal(management.rootManagementReviews([managementResultSession], managementNow).length, 1,
      '순수 완료 결과가 홈의 실제 렌더링 소스로 그룹화되어야 합니다.');
    const managementResultHtml = management.attentionCardHtml(managementResultSession);
    assert.equal((managementResultHtml.match(/data-result-review="true"/g) || []).length, 2,
      '완료 결과 카드의 기본·상세 열기 모두 확인 저장 동작을 사용해야 합니다.');
    assert.match(managementResultHtml, /class="attention-primary-action"[^>]*data-result-review="true"/,
      '완료 결과 기본 버튼은 키보드 클릭에도 동일한 확인 저장 경로를 사용해야 합니다.');
    assert.doesNotMatch(managementResultHtml, /data-attention-quick=/,
      '완료 결과 확인 카드에 답변·승인 빠른 응답을 노출하면 안 됩니다.');
    managementResultReviewed = true;
    assert.equal(management.needsManagementInbox(managementResultSession, managementNow), false,
      '확인 저장을 마친 완료 결과는 확인 대기 목록에서 사라져야 합니다.');
    assert.equal(management.rootManagementReviews([managementResultSession], managementNow).length, 0,
      '확인 저장을 마친 완료 결과는 홈 확인 목록에서도 사라져야 합니다.');
    const operationsStart = managementSource.indexOf('function renderOperationsOverview()');
    const operationsEnd = managementSource.indexOf('\n  function outcomeHtml', operationsStart);
    const operationsSource = managementSource.slice(operationsStart, operationsEnd);
    const homeAttentionRender = operationsSource.indexOf('renderHomeAttention(section)');
    assert.ok(homeAttentionRender >= 0, '선택한 프로젝트 홈이 확인 필요 요약을 렌더링하지 않습니다.');
    assert.doesNotMatch(
      operationsSource.slice(0, homeAttentionRender),
      /section\.classList\.add\(["']hidden["']\)|(?:^|\n)\s*return\s*;/,
      'renderOperationsOverview가 확인 필요 요약을 렌더링하기 전에 무조건 숨기거나 종료하면 안 됩니다.',
    );
    assert.ok(
      operationsSource.includes('document.body.dataset.homeAttentionCount = String(attentionCount)')
        && operationsSource.includes('attentionCount ? "control.home_title_attention" : "control.home_title_clear"'),
      '홈 확인 필요 개수와 제목이 실제 렌더링 결과를 반영해야 합니다.',
    );
    assert.equal(operationsSource.includes('renderProviderUsage('), false, '홈 확인 요약에 제공사 사용량 중복 UI를 다시 넣으면 안 됩니다.');
    assert.ok(html.includes('id="sessionTokenOverview"'), 'AI 사용량은 상단 단일 요약 영역에 있어야 합니다.');
    assert.equal(html.includes('provider-usage-disclosure'), false, '폐기된 홈 제공사 사용량 disclosure가 다시 추가되면 안 됩니다.');
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
      ...[...app.matchAll(/WhiteboxI18n\.t\(["']([^"']+)["']/g)].map(match => match[1]),
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
    assert.ok(html.includes('href="styles-bundle.css"'), '명시적 cascade layer 번들이 로드되어야 합니다.');
    const styleBundle = fs.readFileSync(path.join(root, 'renderer', 'styles-bundle.css'), 'utf8');
    STYLE_FILES.slice(1).forEach((style) => {
      assert.ok(styleBundle.includes(`url("${style}")`), `${style} CSS가 명시적 계층 번들에 없습니다.`);
    });
    for (const heading of CSS_RESPONSIBILITY_HEADINGS) {
      assert.ok(styles.includes(heading), `${heading} CSS 책임 경계가 없습니다.`);
    }
    const rendererScripts = [
      'i18n-messages.js',
      'i18n.js',
      'shared.js',
      'ime-submit.js',
      ...APP_MODULES,
      'terminal-workbench.js',
      'terminal-agent.js',
      'terminal-composer.js',
      'terminal-events.js',
      'terminal.js',
      'drawer-terminal.js',
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
    assert.match(
      styles,
      /(?:^|\n)\.detail-drawer \.chat-content\.markdown\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s,
      '오버레이와 2분할 대화창 모두 평면형 대화 스타일을 유지해야 합니다.',
    );
    assert.doesNotMatch(
      styles,
      /(?:^|\n)\.detail-drawer \.chat-row\.user \.chat-content\.markdown\s*\{/,
      '사용자 대화만 다시 말풍선으로 덮어쓰면 안 됩니다.',
    );
    assert.match(
      styles,
      /\.detail-drawer\[data-conversation-surface="transcript"\] #drawerContent\s*\{[^}]*background-color:\s*#080c12;[^}]*font-family:\s*var\(--font-mono/s,
      '부모가 제어하는 서브에이전트의 읽기 전용 기록 화면 스타일이 필요합니다.',
    );
    assert.doesNotMatch(styles, /\.agent-inline-terminal-composer\s*\{/, '인라인 PTY에 별도 메시지 입력 셸을 다시 만들면 안 됩니다.');
    assert.match(styles, /html\[data-theme="light"\].*data-conversation-surface="transcript"/s, '터미널형 기록 화면의 밝은 테마 계약이 없습니다.');
    assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, '동작 줄이기 미디어 계약이 없습니다.');
    const terminal = rendererSource([
      'terminal-workbench.js',
      'terminal-agent.js',
      'terminal-composer.js',
      'terminal-events.js',
      'terminal.js',
    ]);
    assertIncludesAll(terminal, TERMINAL_RUNTIME_CONTRACTS);
    const mainEntry = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
    const ipcSource = IPC_MODULE_FILES
      .map(file => fs.readFileSync(path.join(root, 'src', 'ipc', file), 'utf8'))
      .join('\n');
    assertIncludesAll(
      mainEntry,
      MAIN_PROCESS_CONTRACTS,
      contract => `${contract} 메인 프로세스 계약이 없습니다.`,
    );
    assert.equal(
      (mainEntry.match(/completionFallback:/g) || []).length,
      3,
      '완료 답변이 없을 때 사용할 일반 문구는 지원 언어마다 하나씩 있어야 합니다.',
    );
    assert.match(
      mainEntry,
      /const notificationCopy = event === 'completed'\s*\?\s*\(notificationDetail \|\| mainText\('completionFallback'\)\)\s*:\s*\(notificationDetail \|\| session\.title \|\| '이름 없는 작업'\);/,
      '완료 알림은 사용자 요청 제목을 fallback으로 쓰지 않고 확인 알림만 기존 제목 fallback을 유지해야 합니다.',
    );
    assert.ok(
      mainEntry.includes("const DEFAULT_LOCALE = 'en'")
        && mainEntry.includes('let appLocale = DEFAULT_LOCALE')
        && mainEntry.includes("['ko', 'en', 'zh-CN'].includes(locale) ? locale : DEFAULT_LOCALE"),
      '신규 사용자는 영어로 시작하고 지원되는 기존 언어 선택은 유지되어야 합니다.',
    );
    assert.ok(mainEntry.includes('macPathEntries(os.homedir(), process.env.PATH)'), 'macOS PATH 조회가 검증된 정적 경로 병합기를 사용해야 합니다.');
    assert.ok(!mainEntry.includes('execFileSync(shellPath'), '앱 창 생성 전에 사용자 셸 초기화를 동기 실행하면 안 됩니다.');
    assert.ok(
      mainEntry.includes('const pendingTerminalBindings = new Map()')
        && mainEntry.includes('const existing = pendingTerminalBindings.get(key)')
        && mainEntry.includes('revision !== monitorSnapshotRevision')
        && mainEntry.includes('persistInferredTerminalBindings(message.bridgeBindings).then')
        && mainEntry.includes('snapshotWithoutSessions(message.snapshot, bindingResult.failedSessionIds, availability)'),
      'monitor snapshot은 동일 in-flight binding을 기다리고 최신 generation만 게시하며 실패 카드만 제외해야 합니다.',
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
    assert.ok(ipcSource.includes("ipcMain.handle('terminals:write'"), '터미널 입력 IPC 응답 계약이 없습니다.');
    assert.match(
      ipcSource,
      /ipcMain\.handle\('terminals:write',\s*async\s*\(event, id, data, options\)[\s\S]*?\.write\(id, data, options \|\| \{\}\)/,
      '터미널 입력 deliveryId 옵션이 IPC에서 호스트 클라이언트까지 전달되지 않습니다.',
    );
    assert.ok(
      ipcSource.includes('terminalWriteEnvelope: 1')
        && preload.includes('unwrapTerminalWriteEnvelope')
        && preload.includes("['rejected', 'unknown'].includes(details.deliveryState)"),
      '터미널 입력 IPC가 Electron 경계에서 delivery 오류 메타데이터를 보존하지 않습니다.',
    );
    assert.ok(ipcSource.includes("ipcMain.handle('terminals:resize'"), '터미널 크기 변경 IPC 응답 계약이 없습니다.');
    for (const operation of ['detach', 'reconnect', 'stop', 'retire']) {
      assert.ok(
        ipcSource.includes(`ipcMain.handle(\`terminals:\${operation}\``)
          || ipcSource.includes(`'${operation}'`),
        `terminals:${operation} IPC 응답 계약이 없습니다.`,
      );
    }
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
    assert.equal(pkg.build.productName, 'Whitebox');
    assert.equal(pkg.build.executableName, 'Whitebox');
    assert.equal(pkg.build.appId, 'com.wincube.whitebox');
    assert.equal(pkg.build.win.icon, 'build/icon.ico');
    assert.equal(pkg.build.mac.icon, 'build/icon.png');
    assert.ok(pkg.files.includes('build/icon.ico'));
    assert.ok(pkg.build.files.includes('build/icon.ico'));
    assert.equal(pkg.build.portable.unpackDirName, false);
    assert.ok(mainEntry.includes("app.setName(PRODUCT_NAME)"));
    assert.ok(mainEntry.includes('app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)'));
    assert.ok(mainEntry.includes("const BRAND_WINDOWS_ICON_PATH = path.join(__dirname, 'build', 'icon.ico')"));
    assert.ok(mainEntry.includes('icon: brandWindowIcon.isEmpty() ? BRAND_ICON_PATH : brandWindowIcon'));
    assert.ok(mainEntry.includes("typeof mainWindow.setAppDetails === 'function'"));
    assert.ok(mainEntry.includes('appIconPath: app.isPackaged ? process.execPath : BRAND_WINDOWS_ICON_PATH'));
    assert.ok(mainEntry.includes('await registerWindowsShellIdentity({'));
    assert.ok(mainEntry.includes("new Tray(icon)"));
    assert.ok(mainEntry.includes("app.dock.setIcon(sourceDockIcon)"));
    assert.ok(html.includes('id="brandIcon"'));
    assert.ok(html.includes('src="assets/whitebox-mark.svg"'));
    const brandMark = fs.readFileSync(path.join(root, 'renderer', 'assets', 'whitebox-mark.svg'), 'utf8');
    assert.match(brandMark, /<svg[^>]+viewBox="0 0 64 64"/);
    assert.ok(
      mainEntry.includes('WHITEBOX_SOURCE_LAUNCHER=1'),
      '소스 브리지에서 데스크톱 앱을 열 때 Electron 실행 파일과 앱 경로를 함께 전달해야 합니다.',
    );
    assert.ok(pkg.dependencies['node-pty']);
    assert.ok(pkg.dependencies['@xterm/xterm']);
    assert.ok(pkg.dependencies['@xterm/addon-fit']);
    assert.deepStrictEqual(pkg.build.electronLanguages, ['en-US', 'ko', 'zh-CN', 'zh_CN']);
    for (const pattern of [
      '!node_modules/@xterm/xterm/src/**/*',
      '!node_modules/@xterm/xterm/typings/**/*',
      '!node_modules/@xterm/xterm/lib/**/*.map',
      '!node_modules/@xterm/xterm/lib/**/*.mjs',
      '!node_modules/@xterm/addon-fit/src/**/*',
      '!node_modules/@xterm/addon-fit/typings/**/*',
      '!node_modules/@xterm/addon-fit/lib/**/*.map',
      '!node_modules/@xterm/addon-fit/lib/**/*.mjs',
    ]) {
      assert.ok(pkg.build.files.includes(pattern), `패키징 제외 규칙이 없습니다: ${pattern}`);
    }
    assert.equal(pkg.bin.whitebox, 'bin/whitebox.js');
    assert.equal(pkg.scripts['test:drawer-conversation'], 'electron scripts/drawer-terminal-visual.js');
    assert.equal(pkg.scripts['test:drawer-actual-pty'], 'electron scripts/drawer-actual-pty-integration.js');
    assert.ok(pkg.build.mac.target.some(item => item.arch.includes('arm64') && item.arch.includes('x64')));
  });

  test('tmux 도움 AI 순회가 자기·상호 순환과 중복 자식을 안전하게 제외한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-tmux-render.js'), 'utf8');
    const sandbox = { window: { WhiteboxAppFactories: {} } };
    vm.runInNewContext(source, sandbox, { filename: 'app-tmux-render.js' });
    const sessions = [
      { id: 'root', childIds: ['root', 'child-a', 'child-a'] },
      { id: 'child-a', childIds: ['child-b'] },
      { id: 'child-b', childIds: ['child-a'] },
    ];
    const renderer = sandbox.window.WhiteboxAppFactories.createTmuxRenderer({
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
        WhiteboxAppFactories: {},
        WhiteboxRendererUtils: {
          $: () => null, $$: () => [], esc: value => String(value), uiLocale: () => 'ko',
          providerLabel: value => value, reportRecoverableError: () => {},
        },
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        WhiteboxI18n: { t: key => key, observedText: value => value },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app.js' });
    const core = sandbox.window.WhiteboxAppFactories.createCore({});
    const now = Date.parse('2026-07-23T01:00:00.000Z');
    const responseAt = new Date(now - 5 * 60 * 1000).toISOString();
    const ended = { id: 'ended', status: 'completed', messages: [{ role: 'assistant', timestamp: responseAt }] };
    assert.equal(core.isControlRoomSession(ended, now), false);
    const transientActivities = ['thinking', 'working', 'juggling', 'notification'];
    for (const activityState of transientActivities) {
      const transient = {
        id: `generic-${activityState}`,
        status: 'idle',
        activityState,
        updatedAt: new Date(now - 18_000).toISOString(),
        messages: [{ role: 'user', timestamp: new Date(now - 18_000).toISOString() }],
      };
      assert.equal(core.isLiveSession(transient), true, `${activityState} activity가 live 분류에서 빠졌습니다.`);
      assert.equal(core.isControlRoomSession(transient, now), true, `${activityState} activity가 관제에서 빠졌습니다.`);
    }
    assert.equal(core.isLiveSession({ id: 'observed-attention', status: 'idle', activityState: 'attention' }), false);
    assert.equal(core.isLiveSession({ id: 'observed-error', status: 'idle', activityState: 'error' }), false);
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
    const child = { ...ended, id: 'child', parentId: 'root', childIds: ['grandchild'] };
    const grandchild = { ...ended, id: 'grandchild', parentId: 'child', status: 'running', activityState: 'working', childIds: [] };
    const rootSession = { ...ended, id: 'root', childIds: ['child'] };
    core.state.snapshot = { sessions: [rootSession, child, grandchild] };
    assert.equal(core.workflowHasActiveDescendant(rootSession), true);
    assert.equal(core.isWorkflowLive(rootSession), true);
    assert.equal(core.controlRoomStatus(rootSession, now), 'running',
      '중첩 서브에이전트가 실행 중이면 완료된 메인 AI를 작업 중으로 표시해야 합니다.');
    assert.equal(core.isResultReviewCandidate(rootSession), false,
      '하위 작업이 남아 있는 메인 AI의 결과를 완료 확인 대상으로 먼저 노출하면 안 됩니다.');
    assert.equal(core.archiveSession(rootSession), false,
      '하위 작업이 남아 있는 메인 AI를 지난 기록으로 이동하면 안 됩니다.');
    grandchild.status = 'completed';
    grandchild.activityState = 'attention';
    core.state.snapshot = { sessions: [rootSession, child, grandchild] };
    assert.equal(core.isWorkflowLive(rootSession), false);
    assert.equal(core.controlRoomStatus(rootSession, now), 'completed');
    assert.equal(core.isResultReviewCandidate(rootSession), true);
    assert.equal(core.isControlRoomSession({ ...rootSession, status: 'running' }, now), true);
    assert.equal(core.isControlRoomSession({ ...child, status: 'running', activityState: 'working' }, now), true);
    assert.equal(core.archiveSession('root'), true);
    assert.equal(core.isControlRoomSession(child, now), false);
    assert.ok(values.get(core.SESSION_ARCHIVE_STORAGE_KEY));
  });

  test('결과 확인 완료는 현재 결과만 저장하고 새 결과가 오면 다시 확인 대상으로 돌린다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
    const values = new Map();
    const sandbox = {
      localStorage: {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
      },
      document: { documentElement: { dataset: {} } },
      window: {
        WhiteboxAppFactories: {},
        WhiteboxRendererUtils: {
          $: () => null, $$: () => [], esc: value => String(value), uiLocale: () => 'ko',
          providerLabel: value => value, reportRecoverableError: () => {},
        },
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        WhiteboxI18n: { t: key => key, observedText: value => value },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app.js' });
    const core = sandbox.window.WhiteboxAppFactories.createCore({});
    const rootSession = {
      id: 'review-root',
      status: 'running',
      childIds: ['review-result'],
      updatedAt: '2026-07-31T01:00:00.000Z',
    };
    const resultSession = {
      id: 'review-result',
      parentId: rootSession.id,
      childIds: [],
      status: 'completed',
      completedAt: '2026-07-31T01:00:01.000Z',
      updatedAt: '2026-07-31T01:00:01.000Z',
      attention: { category: 'none', required: false },
      outcome: { status: 'completed', verified: true, completedAt: '2026-07-31T01:00:01.000Z', summary: `${'같은 앞부분'.repeat(160)} · 첫 결과` },
    };
    core.state.snapshot = { sessions: [rootSession, resultSession] };
    assert.deepStrictEqual(Array.from(core.resultReviewTargets(rootSession), session => session.id), ['review-result']);
    assert.equal(core.markResultReviewComplete(rootSession), 1);
    assert.equal(core.isResultReviewComplete(resultSession), true);
    assert.ok(values.get(core.RESULT_REVIEW_STORAGE_KEY));

    const reloaded = sandbox.window.WhiteboxAppFactories.createCore({});
    reloaded.state.snapshot = core.state.snapshot;
    assert.equal(reloaded.isResultReviewComplete(resultSession), true);
    const drawerSource = fs.readFileSync(path.join(root, 'renderer', 'app-drawer.js'), 'utf8');
    const sessionEventSource = fs.readFileSync(path.join(root, 'renderer', 'app-events-sessions.js'), 'utf8');
    const bootstrapSource = fs.readFileSync(path.join(root, 'renderer', 'app-bootstrap.js'), 'utf8');
    assert.match(drawerSource, /options\.resultReview === true \? markResultReviewComplete/,
      '완료 결과를 열 때 확인 상태를 즉시 저장해야 합니다.');
    assert.match(sessionEventSource, /tab: "summary", resultReview: true/,
      '결과 확인 진입점이 자동 확인 옵션을 전달해야 합니다.');
    assert.match(bootstrapSource, /\{ tab: 'summary', resultReview: true \}/,
      '완료 알림을 열어 확인한 경우에도 확인 상태를 저장해야 합니다.');
    assert.ok(bootstrapSource.indexOf('window.whitebox.onUpdateState')
      < bootstrapSource.indexOf('window.WhiteboxRendererUtils.bootstrap()'),
    '시작 중 업데이트 상태 변경을 놓치지 않도록 bootstrap 전에 구독해야 합니다.');
    assert.match(bootstrapSource, /state\.update = latestUpdateState \|\| bootstrap\.update/,
      'bootstrap 도중 도착한 최신 업데이트 상태를 초기 스냅샷보다 우선해야 합니다.');
    const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.match(mainSource, /if \(updateManager\) sendUpdateState\(updateManager\.getState\(\)\)/,
      'renderer ready 시 최신 업데이트 상태를 한 번 더 보내 이벤트 경합을 닫아야 합니다.');

    resultSession.outcome = { ...resultSession.outcome, summary: `${'같은 앞부분'.repeat(160)} · 뒤에서 바뀐 결과` };
    assert.equal(core.isResultReviewComplete(resultSession), false,
      '타임스탬프와 긴 앞부분이 같아도 결과 뒷부분이 바뀌면 다시 확인해야 합니다.');
    assert.equal(core.markResultReviewComplete(resultSession), 1);
    assert.equal(core.isResultReviewComplete(resultSession), true);

    resultSession.outcome = { ...resultSession.outcome, completedAt: undefined, summary: '완료 시각이 없는 안정된 결과' };
    delete resultSession.completedAt;
    resultSession.updatedAt = '2026-07-31T03:00:00.000Z';
    assert.equal(core.markResultReviewComplete(resultSession), 1);
    resultSession.updatedAt = '2026-07-31T03:30:00.000Z';
    assert.equal(core.isResultReviewComplete(resultSession), true,
      '재스캔 시각만 바뀐 같은 완료 결과가 다시 나타나면 안 됩니다.');
    resultSession.outcome = { ...resultSession.outcome, summary: '실제로 달라진 완료 결과' };
    assert.equal(core.isResultReviewComplete(resultSession), false,
      '실제 결과 내용이 바뀌면 다시 확인할 수 있어야 합니다.');

    resultSession.outcome = { ...resultSession.outcome, completedAt: '2026-07-31T02:00:00.000Z', summary: '새 결과' };
    resultSession.updatedAt = '2026-07-31T02:00:00.000Z';
    assert.equal(core.isResultReviewComplete(resultSession), false);
    assert.deepStrictEqual(Array.from(core.resultReviewTargets(rootSession), session => session.id), ['review-result']);

    resultSession.attention = { category: 'required', required: true };
    assert.equal(core.isResultReviewCandidate(resultSession), false);
    assert.deepStrictEqual(Array.from(core.resultReviewTargets(rootSession), session => session.id), []);
  });

  test('프로젝트 알림 확인은 현재 신호만 숨기고 새 결과와 새 요청을 다시 표시한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
    const values = new Map();
    const sandbox = {
      localStorage: {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
      },
      document: { documentElement: { dataset: {} } },
      window: {
        WhiteboxAppFactories: {},
        WhiteboxRendererUtils: {
          $: () => null, $$: () => [], esc: value => String(value), uiLocale: () => 'ko',
          providerLabel: value => value, reportRecoverableError: () => {},
        },
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        WhiteboxI18n: { t: key => key, observedText: value => value },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app.js' });
    const core = sandbox.window.WhiteboxAppFactories.createCore({});
    const result = {
      id: 'notice-result', status: 'completed', updatedAt: '2026-08-12T01:00:00.000Z',
      completionObserved: true, messages: [], attention: { category: 'none', required: false },
      outcome: { verified: true, completedAt: '2026-08-12T01:00:00.000Z', summary: '첫 완료 결과' },
    };
    const attention = {
      id: 'notice-attention', status: 'waiting', updatedAt: '2026-08-12T01:01:00.000Z', messages: [],
      attention: {
        category: 'required', required: true, kind: 'input', source: 'input-tool',
        requestId: 'request-a|request-b', requestedAt: '2026-08-12T01:01:00.000Z', summary: '환경을 고르세요.',
      },
    };
    core.state.snapshot = { sessions: [result, attention] };

    assert.equal(core.isProjectNoticeSeen('result', result), false);
    assert.equal(core.markProjectNoticeSeen('result', result), true);
    assert.equal(core.isProjectNoticeSeen('result', result), true);
    assert.equal(core.isResultReviewComplete(result), false, '프로젝트 알림 열람이 실제 결과 확인 완료로 바뀌면 안 됩니다.');
    assert.deepStrictEqual(Array.from(core.resultReviewTargets(result), session => session.id), ['notice-result']);
    assert.ok(values.get(core.PROJECT_NOTICE_ACK_STORAGE_KEY));

    const reloaded = sandbox.window.WhiteboxAppFactories.createCore({});
    reloaded.state.snapshot = core.state.snapshot;
    assert.equal(reloaded.isProjectNoticeSeen('result', result), true, '프로젝트 알림 열람 상태가 재시작 후 유지되어야 합니다.');
    result.outcome = { ...result.outcome, summary: '새 완료 결과' };
    assert.equal(reloaded.isProjectNoticeSeen('result', result), false, '새 결과 내용은 다시 프로젝트에 표시해야 합니다.');

    assert.equal(core.markProjectNoticeSeen('attention', attention), true);
    assert.equal(core.isProjectNoticeSeen('attention', attention), true);
    attention.updatedAt = '2026-08-12T01:02:00.000Z';
    attention.attention = { ...attention.attention, summary: '환경을 지금 고르세요.' };
    assert.equal(core.isProjectNoticeSeen('attention', attention), true,
      '같은 requestId의 문구나 갱신 시각 변화만으로 프로젝트 알림이 되살아나면 안 됩니다.');
    attention.attention = { ...attention.attention, requestId: 'request-b' };
    assert.equal(core.isProjectNoticeSeen('attention', attention), true,
      '함께 확인한 요청 중 하나가 해결되어도 남은 기존 요청을 새 알림처럼 표시하면 안 됩니다.');
    attention.attention = { ...attention.attention, requestId: 'request-b|request-c' };
    assert.equal(core.isProjectNoticeSeen('attention', attention), false, '새 요청 ID만 다시 프로젝트에 표시해야 합니다.');

    const firstPrompt = { fingerprint: 'prompt-a', target: { id: 'terminal-a' } };
    assert.equal(core.markProjectNoticeSeen('terminal', attention, firstPrompt), true);
    assert.equal(core.isProjectNoticeSeen('terminal', attention, firstPrompt), true);
    assert.equal(core.isProjectNoticeSeen('terminal', attention, { ...firstPrompt, fingerprint: 'prompt-b' }), false,
      '새 PTY 승인 요청은 다시 프로젝트에 표시해야 합니다.');
  });

  test('서브에이전트 대화에 메인 AI의 SendMessage 후속 지시를 시간순으로 합친다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-drawer-content.js'), 'utf8');
    const sandbox = {
      window: {
        WhiteboxAppFactories: {},
        WhiteboxI18n: { t: key => key, observedText: value => value },
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
    const drawer = sandbox.window.WhiteboxAppFactories.createDrawerContent({
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

  test('지난 기록 상세 화면은 전체 대화는 보존하고 최신 대기 상태를 우선한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    const sandbox = {
      window: {
        WhiteboxAppFactories: {},
        WhiteboxI18n: { t: key => key, errorText: error => String(error) },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-agent-actions.js' });
    const detailMessages = [{ id: 'message-1', role: 'assistant', text: '완료된 답변' }];
    const staleDetail = {
      id: 'history-session',
      status: 'running',
      statusDetail: '작업 진행 중',
      updatedAt: '2026-08-03T01:00:00.000Z',
      messages: detailMessages,
      lifecycle: [{ id: 'turn-1', status: 'running' }],
      executions: [{ id: 'shell-1', status: 'running' }],
    };
    const latestSnapshot = {
      id: staleDetail.id,
      status: 'idle',
      statusDetail: '다음 요청 대기',
      updatedAt: '2026-08-03T01:01:00.000Z',
      completionObserved: true,
      executions: [{ id: 'shell-1', status: 'completed' }],
    };
    const state = {
      selectedId: staleDetail.id,
      details: new Map([[staleDetail.id, staleDetail]]),
      snapshot: { sessions: [latestSnapshot] },
    };
    const actions = sandbox.window.WhiteboxAppFactories.createAgentActions({ state });
    const selected = actions.selectedSession();

    assert.equal(selected.status, 'idle');
    assert.equal(selected.statusDetail, '다음 요청 대기');
    assert.equal(selected.executions[0].status, 'completed');
    assert.strictEqual(selected.messages, detailMessages);
    assert.strictEqual(selected.lifecycle, staleDetail.lifecycle);
  });

  test('상세 기록을 읽는 중 최신 snapshot이 오면 완료 직후 한 번 다시 읽는다', async () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-drawer-data.js'), 'utf8');
    const bootstrapSource = fs.readFileSync(path.join(root, 'renderer', 'app-bootstrap.js'), 'utf8');
    const pending = [];
    let detailCalls = 0;
    const state = {
      selectedId: 'slow-detail',
      drawerTab: 'chat',
      details: new Map(),
      detailErrors: new Map(),
      detailLoadingIds: new Set(),
      snapshot: { sessions: [{
        id: 'slow-detail', updatedAt: '2026-08-10T01:00:00.000Z',
      }] },
    };
    const sandbox = {
      Promise,
      window: {
        WhiteboxAppFactories: {},
        WhiteboxI18n: { t: key => key, errorText: error => String(error) },
        whitebox: {
          sessionDetail: () => {
            detailCalls += 1;
            return new Promise(resolve => pending.push(resolve));
          },
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-drawer-data.js' });
    const drawerData = sandbox.window.WhiteboxAppFactories.createDrawerData({
      state,
      renderDrawer: () => {},
      reportRecoverableError: () => {},
    });

    const first = drawerData.loadSessionDetail('slow-detail', true);
    await Promise.resolve();
    assert.equal(detailCalls, 1);
    assert.match(bootstrapSource, /loadSessionDetail\(state\.selectedId, true, card\.updatedAt\)/u,
      '최초 상세 요청에 캐시가 없어도 더 최신 snapshot은 후속 full-history read를 예약해야 합니다.');
    state.snapshot.sessions[0].updatedAt = '2026-08-10T01:00:10.000Z';
    drawerData.loadSessionDetail('slow-detail', true, state.snapshot.sessions[0].updatedAt);
    pending.shift()({
      id: 'slow-detail', updatedAt: '2026-08-10T01:00:00.000Z', messages: [],
    });
    await first;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(detailCalls, 2, 'in-flight snapshot 갱신은 후속 full-history read를 예약해야 합니다.');
    assert.equal(state.details.has('slow-detail'), false,
      '더 최신 snapshot이 확인된 뒤 먼저 도착한 stale 상세 응답을 화면 캐시에 반영하면 안 됩니다.');

    drawerData.loadSessionDetail('slow-detail', true, state.snapshot.sessions[0].updatedAt);
    state.snapshot.sessions[0].updatedAt = '2026-08-10T01:00:20.000Z';
    drawerData.loadSessionDetail('slow-detail', true, state.snapshot.sessions[0].updatedAt);
    pending.shift()({
      id: 'slow-detail', updatedAt: '2026-08-10T01:00:10.000Z',
      messages: [{ id: 'latest-answer', role: 'assistant', text: '최신 답변' }],
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(detailCalls, 2,
      '진행 중인 follow-up은 snapshot이 다시 바뀌어도 재귀 full-history read를 만들면 안 됩니다.');
    assert.equal(state.details.get('slow-detail').updatedAt, '2026-08-10T01:00:10.000Z');
    assert.equal(state.details.get('slow-detail').messages[0].text, '최신 답변');
    assert.equal(state.detailLoadingIds.has('slow-detail'), false);

    const third = drawerData.loadSessionDetail('slow-detail', true, state.snapshot.sessions[0].updatedAt);
    assert.equal(detailCalls, 3,
      'bounded follow-up 완료 뒤 실제 newer snapshot은 다음 독립 요청으로 읽어야 합니다.');
    pending.shift()({
      id: 'slow-detail', updatedAt: '2026-08-10T01:00:20.000Z',
      messages: [{ id: 'newest-answer', role: 'assistant', text: '가장 최신 답변' }],
    });
    await third;
    assert.equal(state.details.get('slow-detail').updatedAt, '2026-08-10T01:00:20.000Z');
    assert.equal(state.details.get('slow-detail').messages[0].text, '가장 최신 답변');
  });

  test('같은 세션의 최신 스냅샷에서 확인된 대화는 상세 캐시가 갱신될 때까지 보존한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
    const sandbox = {
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { documentElement: { dataset: {} } },
      console: { info: () => {} },
      window: {
        WhiteboxAppFactories: {},
        WhiteboxRendererUtils: {
          $: () => null, $$: () => [], esc: value => String(value), uiLocale: () => 'ko',
          providerLabel: value => value, reportRecoverableError: () => {},
        },
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        WhiteboxI18n: { t: key => key, observedText: value => value },
        WhiteboxConversationDelivery: {
          messageKey: message => `id:${message.id}`,
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app.js' });
    const core = sandbox.window.WhiteboxAppFactories.createCore({});
    const staleDetail = {
      id: 'same-session',
      messages: [{ id: 'old-answer', role: 'assistant', text: '이전 답변' }],
    };
    const deliveredUser = {
      id: 'new-user', role: 'user', text: '화면에서 사라지면 안 되는 질문', timestamp: '2026-08-04T01:00:00.000Z',
    };
    const deliveredAssistant = {
      id: 'new-answer', role: 'assistant', text: '새 답변', timestamp: '2026-08-04T01:00:01.000Z',
    };

    core.observeConversationDelivery(staleDetail, {}, {
      phase: 'responded',
      observationSessionId: staleDetail.id,
      userMessage: deliveredUser,
      assistantMessage: deliveredAssistant,
    });

    assert.deepStrictEqual(
      Array.from(core.state.resolvedConversationMessages.get(staleDetail.id) || [], message => message.id),
      ['new-user', 'new-answer'],
    );
  });

  test('수신 확인된 사용자 메시지는 상세 캐시에 아직 없어도 대화 화면에서 유지한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-drawer-content.js'), 'utf8');
    const sandbox = {
      window: {
        WhiteboxAppFactories: {},
        WhiteboxI18n: { t: key => key },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-drawer-content.js' });
    const session = { id: 'same-session', provider: 'codex', messages: [] };
    const observedUser = {
      id: 'observed-user', role: 'user', text: '수신 뒤에도 남아야 하는 질문', timestamp: '2026-08-04T01:00:00.000Z',
    };
    const entry = { id: 'local-user', text: observedUser.text, timestamp: observedUser.timestamp };
    const state = {
      pendingConversationMessages: new Map([[session.id, [entry]]]),
      resolvedConversationMessages: new Map(),
      expandedConversationPrompts: new Set(),
      details: new Map(),
    };
    const drawer = sandbox.window.WhiteboxAppFactories.createDrawerContent({
      esc: value => String(value),
      uiLocale: () => 'ko',
      state,
      messageContentHtml: message => String(message?.text || ''),
      fullNumber: value => String(value || 0),
      timeOnly: () => '10:00',
      providerInfo: () => ({ mark: 'C', label: 'Codex' }),
      snapshotSession: () => null,
      conversationDeliveryState: () => ({ phase: 'received', userMessage: observedUser }),
      observeConversationDelivery: () => {},
    });

    const html = drawer.chatHtml(session, { showSubagentCalls: false, synthesizeRequest: false });

    assert.ok(html.includes(observedUser.text));
    assert.ok(html.includes('chat-delivery-status received'));
  });

  test('도움 AI 상세는 보호된 지시 대체문과 입력창 없이 실제 응답을 보여준다', () => {
    const contentSource = fs.readFileSync(path.join(root, 'renderer', 'app-drawer-content.js'), 'utf8');
    const drawerSource = fs.readFileSync(path.join(root, 'renderer', 'app-drawer.js'), 'utf8');
    const sandbox = {
      Intl,
      window: {
        WhiteboxAppFactories: {},
        WhiteboxI18n: {
          t: (key, params = {}) => `${key}:${params.count || ''}`,
          observedText: value => value,
        },
      },
    };
    vm.runInNewContext(contentSource, sandbox, { filename: 'app-drawer-content.js' });
    const parent = { id: 'parent', title: '담당 AI 작업', messages: [], collaboration: { spawns: [], communications: [] } };
    const state = {
      pendingConversationMessages: new Map(),
      resolvedConversationMessages: new Map(),
      expandedConversationPrompts: new Set(),
      conversationTurnLimits: new Map(),
      details: new Map([[parent.id, parent]]),
    };
    const drawer = sandbox.window.WhiteboxAppFactories.createDrawerContent({
      esc: value => String(value),
      uiLocale: () => 'ko',
      state,
      messageContentHtml: message => String(message?.text || ''),
      compact: value => String(value || 0),
      fullNumber: value => String(value || 0),
      timeOnly: () => '10:00',
      providerInfo: () => ({ mark: 'C', label: 'Codex' }),
      statusIcon: () => '',
      agentPathTaskName: value => String(value || '').split('/').filter(Boolean).at(-1) || '',
      snapshotSession: id => id === parent.id ? parent : null,
      conversationDeliveryState: () => null,
      observeConversationDelivery: () => {},
    });
    const session = {
      id: 'protected-child', parentId: parent.id, provider: 'codex', title: '도움 AI 작업',
      status: 'completed', updatedAt: '2026-08-04T01:00:02.000Z', completedAt: '2026-08-04T01:00:02.000Z',
      messages: [{ id: 'progress', role: 'assistant', text: '진행 중 응답', timestamp: '2026-08-04T01:00:01.000Z' }],
      result: '최종 응답',
      delegation: {
        assignmentProtected: true,
        assignmentSource: 'protected',
        assignmentContext: '화면에 보이면 안 되는 직전 설명',
      },
    };

    const html = drawer.subagentConversationHtml(session);
    assert.ok(html.includes('진행 중 응답'));
    assert.ok(html.includes('최종 응답'));
    assert.ok(html.includes('data-subagent-work-messages="2"'));
    assert.equal(html.includes('subagent-assignment-card'), false);
    assert.equal(html.includes('화면에 보이면 안 되는 직전 설명'), false);
    assert.equal(html.includes('drawer.assignment_protected'), false);
    assert.match(drawerSource, /const ptyConversation = conversationTab && !session\.parentId && !subagentMode && !executionMode/);
    assert.match(drawerSource, /composer\.classList\.toggle\("hidden", !showComposer\)/);
  });

  test('긴 대화 기록은 최근 요청부터 제한해 렌더링하고 이전 기록을 단계적으로 연다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-drawer-content.js'), 'utf8');
    const sandbox = {
      Intl,
      window: {
        WhiteboxAppFactories: {},
        WhiteboxI18n: {
          t: (key, params = {}) => `${key}:${params.count || ''}`,
        },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app-drawer-content.js' });
    const messages = [];
    for (let index = 0; index < 260; index += 1) {
      messages.push({ id: `user-${index}`, role: 'user', text: `[요청:${index}:끝]`, timestamp: new Date(1700000000000 + index * 2000).toISOString() });
      messages.push({ id: `assistant-${index}`, role: 'assistant', text: `답변-${index}`, timestamp: new Date(1700000001000 + index * 2000).toISOString() });
    }
    const state = {
      pendingConversationMessages: new Map(),
      resolvedConversationMessages: new Map(),
      expandedConversationPrompts: new Set(),
      conversationTurnLimits: new Map(),
      details: new Map(),
    };
    const drawer = sandbox.window.WhiteboxAppFactories.createDrawerContent({
      esc: value => String(value),
      uiLocale: () => 'ko',
      state,
      messageContentHtml: message => String(message?.text || ''),
      fullNumber: value => String(value || 0),
      timeOnly: () => '10:00',
      providerInfo: () => ({ mark: 'C', label: 'Codex' }),
      snapshotSession: () => null,
      conversationDeliveryState: () => null,
      observeConversationDelivery: () => {},
    });
    const session = { id: 'long-session', provider: 'codex', messages };

    const initial = drawer.chatHtml(session, { showSubagentCalls: false, synthesizeRequest: false });
    assert.equal(initial.includes('[요청:0:끝]'), false);
    assert.ok(initial.includes('[요청:140:끝]'));
    assert.ok(initial.includes('[요청:259:끝]'));
    assert.ok(initial.includes('data-next-turn-limit="240"'));

    state.conversationTurnLimits.set(session.id, 240);
    const expanded = drawer.chatHtml(session, { showSubagentCalls: false, synthesizeRequest: false });
    assert.equal(expanded.includes('[요청:19:끝]'), false);
    assert.ok(expanded.includes('[요청:20:끝]'));
    assert.ok(expanded.includes('data-next-turn-limit="360"'));
  });

  test('포커스 작업 흐름 연결선 모션은 주기적 상태 새로고침 뒤에도 유지한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-graph-view.js'), 'utf8');
    const focusedStart = source.indexOf('function focusedGraph(');
    const focusedEnd = source.indexOf('\n  return {', focusedStart);
    const focusedSource = source.slice(focusedStart, focusedEnd);
    assert.ok(focusedStart >= 0 && focusedEnd > focusedStart, '포커스 작업 흐름 렌더러를 찾을 수 없습니다.');
    assert.ok(focusedSource.includes('const connectMotion = "motion-connect";'));
    assert.equal(focusedSource.includes('["focus", "focus-back", "view"].includes(motionKind)'), false);
    assert.ok(focusedSource.includes('workflowProgressPanel(focus, children)'), '작업 흐름에 읽기 전용 진행 현황이 없습니다.');
    assert.equal(focusedSource.includes('context.agentCommandComposer(focus)'), false, '별도 대화창이 있는데 작업 진행 화면에 지시 입력창이 다시 노출되었습니다.');
    assert.ok(source.includes('data-workflow-progress='), '현재 단계와 최근 활동을 식별할 진행 패널 계약이 없습니다.');
    assert.ok(source.includes('graph.progress_basis_note'), '기록된 단계 비율을 전체 계획 진척률로 오해하지 않도록 근거 안내가 필요합니다.');
  });

  test('메인 담당 AI만 바로 아래 PTY를 토글하고 실행·도움 노드는 기존 상세를 연다', () => {
    const graph = fs.readFileSync(path.join(root, 'renderer', 'app-graph-view.js'), 'utf8');
    const events = fs.readFileSync(path.join(root, 'renderer', 'app-events-sessions.js'), 'utf8');
    const dashboard = fs.readFileSync(path.join(root, 'renderer', 'app-dashboard.js'), 'utf8');
    const filterEvents = fs.readFileSync(path.join(root, 'renderer', 'app-events-filters.js'), 'utf8');
    const sessionRenderer = fs.readFileSync(path.join(root, 'renderer', 'app-session-render.js'), 'utf8');
    const orchestration = fs.readFileSync(path.join(root, 'renderer', 'app-graph-orchestration.js'), 'utf8');
    const inlineTerminal = fs.readFileSync(path.join(root, 'renderer', 'inline-agent-terminal.js'), 'utf8');
    const workbench = fs.readFileSync(path.join(root, 'renderer', 'terminal-workbench.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
    const styles = fs.readFileSync(path.join(root, 'renderer', 'styles-workflow-map.css'), 'utf8');
    const controlRoomStyles = fs.readFileSync(path.join(root, 'renderer', 'styles-control-room.css'), 'utf8');

    const graphNodeSource = graph.slice(graph.indexOf('function graphNode('), graph.indexOf('function compactGraphNode('));
    const compactGraphSource = graph.slice(graph.indexOf('function compactGraphNode('), graph.indexOf('function providerFlowLane('));
    const helperNodeSource = graph.slice(graph.indexOf('function controlRoomChildNode('), graph.indexOf('function controlRoomExecutionNode('));
    const executionNodeSource = graph.slice(graph.indexOf('function controlRoomExecutionNode('), graph.indexOf('function controlRoomRetainedDecision('));
    const controlRoomSource = graph.slice(graph.indexOf('function controlRoomSession('), graph.indexOf('function runtimeSeparatedOverview('));
    const historySource = dashboard.slice(dashboard.indexOf('if (historyList) {'), dashboard.indexOf('const projectSelect ='));
    const graphFilterSource = dashboard.slice(dashboard.indexOf('function graphFilteredSessions()'), dashboard.indexOf('function renderProviderVisibilitySettings()'));
    const historyEvents = filterEvents.slice(filterEvents.indexOf('$("#projectHistoryRail")'), filterEvents.indexOf('const controlProjectSelect'));

    assert.match(graphNodeSource, /const inlinePtyAttributes = session\.parentId[\s\S]*data-inline-pty-trigger=/,
      '선택 흐름의 PTY 트리거가 메인 담당 AI로 제한되지 않았습니다.');
    assert.match(controlRoomSource, /const controlRoomPtyAttributes = root\.parentId[\s\S]*data-inline-pty-trigger=/,
      '처리 중 화면의 PTY 트리거가 메인 담당 AI로 제한되지 않았습니다.');
    assert.match(controlRoomSource, /class="control-room-main"\$\{controlRoomPtyAttributes\}/,
      '처리 중 화면의 메인 담당 AI에 PTY 토글 속성을 연결하지 않았습니다.');
    assert.doesNotMatch(helperNodeSource, /data-inline-pty-trigger=/,
      '실행 중 도움 AI 노드가 PTY를 열고 있습니다.');
    assert.ok(helperNodeSource.includes('data-open-subagent-chat='),
      '실행 중 도움 AI 노드의 기존 읽기 전용 상세 경로가 없습니다.');
    assert.doesNotMatch(compactGraphSource, /data-inline-pty-trigger=/,
      '작업 흐름 탐색 노드가 PTY 토글로 바뀌었습니다.');
    assert.doesNotMatch(executionNodeSource, /data-inline-pty-trigger=/,
      '실행 명령 노드가 PTY 토글로 바뀌었습니다.');
    assert.ok(executionNodeSource.includes('${esc(command.text)}</em>'),
      '실행 중인 컴퓨터 작업 노드에 실제 명령어가 보이지 않습니다.');
    const inlinePanelIndex = graph.indexOf('${!focus.parentId && state.inlineTerminalSessionId === focus.id ? inlineTerminalPanel(focus) : ""}');
    const detailPanelIndex = graph.indexOf('${workflowDetailPanel(focus)}', inlinePanelIndex);
    assert.ok(inlinePanelIndex >= 0 && detailPanelIndex > inlinePanelIndex, 'PTY가 선택한 AI 영역과 작업 상세 정보 사이에 배치되지 않았습니다.');
    assert.ok(graph.includes('tab("summary"'), '작업 상세 화면에 요약 탭이 없습니다.');
    assert.ok(graph.includes('tab("tokens"'), '작업 상세 화면에 토큰 사용량 탭이 없습니다.');
    assert.ok(events.includes('window.WhiteboxInlineTerminal?.toggle?.(inlineTerminal.dataset.inlinePtyTrigger') && events.includes('focus: !inlineTerminal.closest(".control-room-session")'), 'AI 클릭이 현재 화면의 인라인 PTY 토글로 연결되지 않았습니다.');
    assert.ok(historySource.includes('data-inline-pty-trigger=') && historySource.includes('data-open-session='),
      '지난 기록이 PTY 가능 여부에 따라 인라인 터미널 또는 읽기 전용 상세로 연결되지 않았습니다.');
    assert.ok(historySource.includes('session.presentation?.conversationSurface === "transcript"')
      && historySource.includes('session.controlCapabilities?.pty === false'),
    'PTY가 없는 지난 기록을 쓰기 가능한 화면으로 잘못 열 수 있습니다.');
    assert.ok(historyEvents.indexOf('[data-inline-pty-trigger]') >= 0
      && historyEvents.indexOf('[data-inline-pty-trigger]') < historyEvents.indexOf('[data-open-session]')
      && historyEvents.includes('window.WhiteboxInlineTerminal?.toggle?.(inlineTerminal.dataset.inlinePtyTrigger)'),
    '지난 기록 클릭이 팝업보다 먼저 인라인 PTY 경로로 연결되지 않았습니다.');
    assert.ok(historyEvents.includes('openDrawer(open.dataset.openSession, {')
      && historyEvents.includes('context: true,')
      && historyEvents.includes('resultReview: true'),
      'PTY가 없는 지난 기록도 진행 중 AI와 같은 컨텍스트 상세 UX로 열려야 합니다.');
    assert.ok(graphFilterSource.includes('state.graphFocusId || state.inlineTerminalSessionId')
      && graphFilterSource.includes('const selectedGraphSession = allById.get(selectedGraphId)')
      && graphFilterSource.includes('contextual.set(currentId, current)'),
    '최근 표시 기간을 지난 선택 기록을 포커스 그래프에 유지하는 계약이 없습니다.');
    assert.ok(fs.readFileSync(path.join(root, 'renderer', 'app-graph-model.js'), 'utf8')
      .includes('included.add(requestedFocus.id)'),
    '사용자가 직접 선택한 보관 기록을 라이브 그래프 규칙이 다시 제외할 수 있습니다.');
    assert.ok(sessionRenderer.includes('!state.graphFocusId && graphLiveCount === 0'),
      '지난 기록 포커스 화면 위에 활성 작업 없음 안내가 겹칠 수 있습니다.');
    assert.equal(events.includes('if (state.graphFocusId === node.dataset.graphFocus) openDrawer'), false, '같은 AI 재클릭이 오른쪽 드로어를 다시 열고 있습니다.');
    assert.ok(orchestration.includes('window.WhiteboxInlineTerminal?.sync?.()'), '작업 흐름 갱신 후 PTY 재마운트 계약이 없습니다.');
    assert.match(
      orchestration,
      /if \(!replacement\)\s*\{[\s\S]*state\.inlineTerminalSessionId = null;[\s\S]*unmountEmbedded/,
      '작업 topology가 바뀌어 인라인 PTY 보존에 실패하면 오래된 writable 화면을 닫아야 합니다.',
    );
    assert.ok(orchestration.includes('preserveRuntimeConnection && name === "data-connection"'),
      'snapshot reconcile이 런타임 연결 상태를 지워 한 프레임 깜빡이면 안 됩니다.');
    assert.ok(inlineTerminal.includes('terminal.mountForAgent(session'), '인라인 PTY가 실제 에이전트 터미널 호스트를 마운트하지 않습니다.');
    assert.ok(inlineTerminal.includes('if (!isMainSession(session)) return { ok: false, reason: "not-main-session" };'),
      '렌더러를 우회해도 하위 AI PTY 마운트를 막는 런타임 계약이 없습니다.');
    assert.match(
      inlineTerminal,
      /const createIfMissing\s*=\s*!session\.parentId[\s\S]*terminal\.mountForAgent\(session,\s*\{[\s\S]*createIfMissing,/,
      '최상위 AI의 PTY를 펼쳤을 때 기존 대화를 prompt 없이 자동 연결하는 생성 계약이 없습니다.',
    );
    assert.equal(graph.includes('data-inline-terminal-composer'), false, '인라인 PTY에 별도 메시지 입력창을 다시 만들면 안 됩니다.');
    assert.match(workbench, /const inputDisabled = readOnly;/, '인라인 PTY가 실제 xterm 입력을 전달해야 합니다.');
    assert.ok(inlineTerminal.includes('instance.state.inlineTerminalSessionId === id'), '같은 AI를 다시 눌렀을 때 닫는 토글 계약이 없습니다.');
    assert.ok(html.includes('<script src="inline-agent-terminal.js"></script>'), '인라인 PTY 런타임이 로드되지 않습니다.');
    assert.ok(styles.includes('.agent-inline-terminal-link'), '선택한 AI와 PTY의 시각적 연결 표시가 없습니다.');
    assert.ok(styles.indexOf('.agent-inline-terminal') < styles.indexOf('.workflow-detail'), 'PTY가 작업 상세보다 먼저 배치된 시각 계약이 없습니다.');
    const stableLayoutStart = controlRoomStyles.indexOf('/* Opening the PTY must not move work units that are already on screen. */');
    const stableLayoutEnd = controlRoomStyles.indexOf('@keyframes control-room-spawn', stableLayoutStart);
    const stableLayoutSource = controlRoomStyles.slice(stableLayoutStart, stableLayoutEnd);
    assert.ok(stableLayoutStart >= 0 && stableLayoutEnd > stableLayoutStart, 'PTY 위치 고정 스타일 계약을 찾을 수 없습니다.');
    assert.match(stableLayoutSource, /\.agent-inline-terminal\s*\{[\s\S]*grid-column:\s*1\s*\/\s*-1;/,
      'PTY가 기존 작업 행 뒤의 전체 폭 행에 배치되지 않았습니다.');
    assert.doesNotMatch(stableLayoutSource, /\.control-room-flow|\.completed-column|\.control-flow-link|grid-row:/,
      'PTY open 상태가 기존 작업 열이나 행을 재배치하고 있습니다.');
    const allOpenStateRules = [...controlRoomStyles.matchAll(/\.control-room-session\.has-inline-terminal[^{}]*\{[^{}]*\}/g)]
      .map(match => match[0])
      .join('\n');
    assert.doesNotMatch(allOpenStateRules, /\.control-room-flow|\.completed-column|\.control-flow-link|grid-row:/,
      '반응형 PTY open 스타일이 기존 완료 노드의 위치를 재배치하고 있습니다.');
    const overviewInlineIndex = controlRoomSource.indexOf('${inlineSession ? inlineTerminalPanel(inlineSession) : ""}');
    const overviewCompletedIndex = controlRoomSource.indexOf('class="control-room-column completed-column"');
    assert.ok(overviewCompletedIndex >= 0 && overviewInlineIndex > overviewCompletedIndex,
      'PTY가 완료 노드 뒤에 배치되지 않아 시각 순서와 키보드 탐색 순서가 어긋납니다.');
  });

  test('프로젝트 선택은 화면 렌더를 기다리게 하지 않고 최상위 AI PTY 사전 연결을 시작한다', () => {
    const filters = fs.readFileSync(path.join(root, 'renderer', 'app-events-filters.js'), 'utf8');
    const actions = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    const terminal = fs.readFileSync(path.join(root, 'renderer', 'terminal.js'), 'utf8');
    const drawerTerminal = fs.readFileSync(path.join(root, 'renderer', 'drawer-terminal.js'), 'utf8');
    const drawer = fs.readFileSync(path.join(root, 'renderer', 'app-drawer.js'), 'utf8');
    const eventHelper = filters.slice(
      filters.indexOf('function preconnectSelectedWorkspace()'),
      filters.indexOf('function bindFilterAndWorkspaceEvents()'),
    );
    const workspaceClick = filters.slice(
      filters.indexOf('const handleWorkspaceClick = async'),
      filters.indexOf('workspaceLists.forEach'),
    );
    const workspaceSelection = workspaceClick.slice(
      workspaceClick.indexOf('const item = event.target.closest("[data-workspace]")'),
      workspaceClick.indexOf('if (activeList.id === "projectSidebarList" && state.workspace !== "all")'),
    );

    assert.ok(actions.includes('function preconnectProjectAgentTerminals(workspace = state.workspace)'),
      '선택 프로젝트의 최상위 AI를 수집하는 사전 연결 orchestration이 없습니다.');
    assert.match(actions, /session\.parentId \|\| !isLiveSession\(session\)/,
      '사전 연결 후보가 active 최상위 AI로 제한되지 않았습니다.');
    assert.match(terminal, /ensureForAgent, preconnectForAgents, bindAgentConnection/,
      '터미널 공개 API가 batch 사전 연결 함수를 전달하지 않습니다.');
    assert.ok(terminal.includes("if (agentSession.parentId) return { ok: false, reason: 'parent-controlled', targets: [] };"),
      '중앙 mount API가 하위 AI의 PTY host 연결을 막지 않습니다.');
    assert.ok(drawerTerminal.includes("if (session?.parentId) return { ok: false, reason: 'parent-controlled', targets: [] };"),
      'drawer terminal이 하위 AI PTY mount를 fail-closed 하지 않습니다.');
    assert.match(drawer, /if \(selected\?\.parentId\) return openSubagentConversation\(id, options\);/,
      '일반 drawer 진입점을 우회한 하위 AI가 읽기 전용 상세 경로로 전환되지 않습니다.');
    assert.match(eventHelper, /void Promise\.resolve\(preconnectProjectAgentTerminals\(state\.workspace\)\)\.catch/,
      '프로젝트 PTY 사전 연결이 fire-and-forget으로 시작되지 않습니다.');
    assert.doesNotMatch(eventHelper, /await\s+(?:Promise\.resolve\()?preconnectProjectAgentTerminals/,
      '프로젝트 선택 이벤트가 느린 PTY 준비 완료를 기다리고 있습니다.');
    assert.match(
      workspaceSelection,
      /if \(activeList\.id === "projectSidebarList" && state\.view !== "all"\) selectView[\s\S]*else renderSessions\("filter"\);\s*preconnectSelectedWorkspace\(\);/,
      '프로젝트 결과 화면을 먼저 렌더한 뒤 PTY 사전 연결을 백그라운드로 시작해야 합니다.',
    );
  });

  test('터미널은 한글 글리프를 압축하지 않고 휠 이동을 짧게 보간한다', () => {
    const terminal = fs.readFileSync(path.join(root, 'renderer', 'terminal.js'), 'utf8');
    const optionsSource = terminal.slice(
      terminal.indexOf('function xtermOptions('),
      terminal.indexOf('function syncXtermTheme()'),
    );

    assert.match(optionsSource, /letterSpacing:\s*0,/, '음수 자간이 한글 대체 글꼴을 겹쳐 보이게 하면 안 됩니다.');
    assert.doesNotMatch(optionsSource, /letterSpacing:\s*-\d/, '터미널 글리프 셀 간격을 강제로 압축하면 안 됩니다.');
    assert.match(
      optionsSource,
      /smoothScrollDuration:\s*reduceMotion\s*\?\s*0\s*:\s*TERMINAL_SMOOTH_SCROLL_MS/,
      '휠 스크롤은 동작 줄이기 설정을 존중하면서 짧게 보간해야 합니다.',
    );
    assert.match(terminal, /const TERMINAL_SMOOTH_SCROLL_MS\s*=\s*100;/,
      '휠 스크롤 보간은 입력이 밀리지 않는 짧은 시간이어야 합니다.');
  });

  test('프로젝트 사이드바는 드래그와 키보드로 위치를 바꾸고 순서를 저장한다', () => {
    const dashboardSource = fs.readFileSync(path.join(root, 'renderer', 'app-dashboard.js'), 'utf8');
    const filterEvents = fs.readFileSync(path.join(root, 'renderer', 'app-events-filters.js'), 'utf8');
    const drawerSource = fs.readFileSync(path.join(root, 'renderer', 'app-drawer.js'), 'utf8');
    const quality = fs.readFileSync(path.join(root, 'renderer', 'app-quality.js'), 'utf8');
    const styles = fs.readFileSync(path.join(root, 'renderer', 'styles-studio-shell.css'), 'utf8');
    const sidebarMarkup = dashboardSource.slice(
      dashboardSource.indexOf('const sidebarPriorityRank'),
      dashboardSource.indexOf('const desktopHtml'),
    );
    const sortableBinding = filterEvents.slice(
      filterEvents.indexOf('const bindSortableSidebarProjects'),
      filterEvents.indexOf('$("#loadMoreBtn")'),
    );

    assert.match(sidebarMarkup, /sidebarProjectOrder\s*=\s*ensureProjectOrder\([\s\S]*sidebarProjectRank/,
      '사이드바가 저장된 프로젝트 순서를 적용하지 않습니다.');
    assert.ok(sidebarMarkup.includes('data-project-sortable="${esc(normalizedProjectPath(item.path))}"'),
      '프로젝트 경로를 정규화한 정렬 키가 없습니다.');
    assert.ok(sidebarMarkup.includes('draggable="${canReorderSidebarProjects ? "true" : "false"}"'),
      '프로젝트가 둘 이상일 때 드래그 가능한 항목을 만들지 않습니다.');
    assertIncludesAll(sidebarMarkup, [
      'aria-grabbed="false"',
      'aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"',
      'aria-describedby="projectReorderHelp"',
      'project-sidebar-drag-handle',
    ]);
    assertIncludesAll(sortableBinding, [
      'container.addEventListener("dragstart"',
      'container.addEventListener("dragover"',
      'container.addEventListener("drop"',
      'container.addEventListener("dragend"',
      'moveProjectOrder(sourceId, targetId, placeAfter)',
      'saveDashboardPreferences();',
      'renderWorkspaces();',
      'renderSessions("reorder")',
      'event.altKey',
      '"ArrowUp", "ArrowDown"',
    ]);
    assert.ok(filterEvents.includes('bindSortableSidebarProjects($("#projectSidebarList"))'),
      '왼쪽 프로젝트 목록에 정렬 이벤트를 연결하지 않았습니다.');
    assert.match(filterEvents, /Date\.now\(\) - sidebarProjectDragEndedAt < 250/,
      '드래그 직후 click이 프로젝트 선택으로 실행되는 것을 막아야 합니다.');
    assert.ok(quality.includes('projectOrder: (state.projectOrder || [])'),
      '변경한 프로젝트 순서를 대시보드 환경설정에 저장하지 않습니다.');
    assertIncludesAll(styles, [
      '.project-sidebar-group.project-sort-dragging',
      '.project-sidebar-group[data-project-drop-edge]::after',
      '.project-sidebar-drag-handle',
      'cursor: grab',
      'cursor: grabbing',
    ]);
    assertIncludesAll(dashboardSource, [
      'projectNoticeSignals',
      'acknowledgeProjectNotices',
      'acknowledgeSessionNotices',
      'context.isProjectNoticeSeen?.("result", session)',
      'context.isProjectNoticeSeen?.("attention", session)',
      'context.isProjectNoticeSeen?.("terminal", session, prompt)',
      'priority: attention.length ? "attention" : resultReady.length ? "result-ready"',
    ]);
    assert.match(filterEvents, /acknowledgeProjectNotices\(requestedWorkspace\);[\s\S]*renderWorkspaces\(\);/,
      '프로젝트 선택은 현재 알림을 먼저 확인 처리한 뒤 사이드바를 다시 그려야 합니다.');
    assertIncludesAll(drawerSource, [
      'acknowledgeSessionNotices(selected || id)',
      'acknowledgeSessionNotices(child)',
      'renderWorkspaces()',
    ]);
    assertIncludesAll(sidebarMarkup, [
      'data-attention-session-count=',
      'data-result-ready-count=',
      'project-sidebar-result-ready',
    ]);
    assertIncludesAll(styles, ['.project-sidebar-group.has-result-ready', '.project-sidebar-result-ready']);

    const sidebar = { dataset: {}, innerHTML: '' };
    const sandbox = {
      window: {
        WhiteboxAppFactories: {},
        WhiteboxI18n: { t: (key, params = {}) => `${key}:${params.count ?? ''}` },
      },
      document: { body: { dataset: {} } },
      Intl,
    };
    vm.runInNewContext(dashboardSource, sandbox, { filename: 'app-dashboard.js' });
    const state = { projectOrder: [] };
    const dashboard = sandbox.window.WhiteboxAppFactories.createDashboard({ state, visibleSessions: () => [] });
    dashboard.ensureProjectOrder(['project:a', 'project:b', 'project:c']);
    assert.equal(dashboard.moveProjectOrder('project:c', 'project:a', false), true);
    assert.deepStrictEqual(Array.from(state.projectOrder), ['project:c', 'project:a', 'project:b']);
    assert.equal(dashboard.moveProjectOrder('project:c', 'project:b', true), true);
    assert.deepStrictEqual(Array.from(state.projectOrder), ['project:a', 'project:b', 'project:c']);

    const completed = {
      id: 'completed-root', provider: 'codex', status: 'completed', completionObserved: true,
      cwd: 'D:\\repo\\nested\\worktree', originCwd: 'D:\\repo\\nested\\worktree', childIds: [],
      updatedAt: '2026-08-12T01:00:00.000Z', messages: [],
    };
    const premature = {
      ...completed, id: 'premature-root', cwd: 'D:\\repo\\nested', originCwd: 'D:\\repo\\nested',
      childIds: ['running-child'], updatedAt: '2026-08-12T01:01:00.000Z',
    };
    const runningChild = {
      ...completed, id: 'running-child', parentId: premature.id, status: 'running', completionObserved: false,
      childIds: [], updatedAt: '2026-08-12T01:02:00.000Z',
    };
    const resultSessions = [completed, premature, runningChild];
    const resultState = {
      snapshot: { sessions: resultSessions, tmux: { distros: [] } },
      workspaces: [
        { name: '상위', path: 'D:\\repo' },
        { name: '하위', path: 'D:\\repo\\nested' },
      ],
      workspace: 'all', projectOrder: [], dismissedProjects: new Set(), providerMap: new Map(),
      providers: [], availability: {}, sessionOrder: [], view: 'all', search: '', sort: 'recent',
      providerFilters: new Set(),
    };
    let resultReviewed = false;
    const seenNotices = new Set();
    const resultDashboard = sandbox.window.WhiteboxAppFactories.createDashboard({
      $: selector => selector === '#projectSidebarList' ? sidebar : null,
      esc: value => String(value),
      uiLocale: () => 'ko-KR',
      state: resultState,
      visibleSessions: () => resultSessions,
      isProviderVisible: () => true,
      isControlRoomSession: session => session.status === 'running',
      controlRoomStatus: session => session.id === premature.id ? 'running' : session.status,
      resultReviewTargets: session => !resultReviewed && [completed.id, premature.id].includes(session.id) ? [session] : [],
      isProjectNoticeSeen: (kind, session) => seenNotices.has(`${kind}:${session.id}`),
      markProjectNoticesSeen: entries => {
        let changed = 0;
        entries.forEach(entry => {
          const key = `${entry.kind}:${entry.session.id}`;
          if (!seenNotices.has(key)) { seenNotices.add(key); changed += 1; }
        });
        return changed;
      },
    });
    resultDashboard.renderWorkspaces();
    const projectMarkup = key => {
      const marker = `data-project-sortable="${key}"`;
      const start = sidebar.innerHTML.indexOf(marker);
      const next = sidebar.innerHTML.indexOf('data-project-sortable="', start + marker.length);
      return start < 0 ? '' : sidebar.innerHTML.slice(start, next < 0 ? sidebar.innerHTML.length : next);
    };
    const parentProjectMarkup = projectMarkup('d:/repo');
    const nestedProjectMarkup = projectMarkup('d:/repo/nested');
    assert.match(parentProjectMarkup, /data-result-ready-count="0"/,
      '중첩 프로젝트의 완료 결과가 상위 프로젝트에도 중복 집계되면 안 됩니다.');
    assert.match(nestedProjectMarkup, /data-result-ready-count="1"/,
      '실제로 끝난 메인 세션만 소유 프로젝트의 완료 결과로 집계해야 합니다.');
    assert.match(nestedProjectMarkup, /project-sidebar-result-ready/);
    assert.equal((nestedProjectMarkup.match(/project-sidebar-result-ready/g) || []).length, 1,
      '하위 작업이 실행 중인 메인 세션을 완료 결과로 먼저 세면 안 됩니다.');

    assert.equal(resultDashboard.acknowledgeProjectNotices('D:\\repo\\nested'), 1);
    resultDashboard.renderWorkspaces();
    assert.equal(sidebar.innerHTML.includes('project-sidebar-result-ready'), false,
      '프로젝트를 확인한 뒤 완료 결과 배지가 남아 있으면 안 됩니다.');
    completed.updatedAt = '2026-08-12T02:00:00.000Z';
    seenNotices.clear();
    resultDashboard.renderWorkspaces();
    assert.match(projectMarkup('d:/repo/nested'), /data-result-ready-count="1"/,
      '새 완료 결과 신호가 생기면 프로젝트 배지가 다시 표시되어야 합니다.');

    resultReviewed = true;
    resultDashboard.renderWorkspaces();
    assert.equal(sidebar.innerHTML.includes('project-sidebar-result-ready'), false,
      '결과 확인을 마친 뒤 프로젝트 완료 결과 배지가 남아 있으면 안 됩니다.');
    assert.equal((sidebar.innerHTML.match(/data-result-ready-count="0"/g) || []).length, 2);
  });

  test('프로젝트 선택 화면은 진행 작업 정보 없이 선택 안내와 지속 모션만 제공한다', () => {
    const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
    const styles = fs.readFileSync(path.join(root, 'renderer', 'styles-studio-shell.css'), 'utf8');
    const themeStyles = fs.readFileSync(path.join(root, 'renderer', 'styles-theme.css'), 'utf8');
    const historyEmptyRule = styles.match(/\.project-history-list > \.project-history-empty\s*\{([^}]*)\}/)?.[1] || '';
    const selection = html.slice(html.indexOf('id="projectSelectionPrompt"'), html.indexOf('id="projectTaskToolbar"'));
    for (const contract of ['project-selection-visual', 'project-selection-direction', 'project-selection-orbit', 'project-selection-scan']) {
      assert.ok(selection.includes(contract), `${contract} 프로젝트 선택 안내 요소가 없습니다.`);
    }
    assert.equal(selection.includes('project-selection-flow'), false, '프로젝트 선택 전에는 진행 작업 안내를 표시하지 않아야 합니다.');
    assert.ok(themeStyles.includes('body[data-current-view="all"]:not([data-project-selected="true"]) #projectContextNav'), '프로젝트 선택 전에는 처리 중 작업 탭을 숨겨야 합니다.');
    assert.match(historyEmptyRule, /grid-column:\s*1\s*\/\s*-1\s*;/, '지난 세션 빈 상태가 기록 그리드의 첫 열에만 갇혀 있습니다.');
    assert.match(historyEmptyRule, /align-content:\s*center\s*;/, '지난 세션 빈 상태의 문구 묶음이 세로 중앙에 정렬되지 않습니다.');
    assert.match(historyEmptyRule, /border:\s*1px\s+dashed/, '지난 세션 빈 상태의 경계가 주변 기록 카드와 구분되지 않습니다.');
    const messages = fs.readFileSync(path.join(root, 'renderer', 'i18n-messages.js'), 'utf8');
    assert.ok(messages.includes('아직 완료된 작업이 없습니다'), '지난 기록 빈 상태가 실행 중 작업까지 없다는 뜻으로 읽힙니다.');
    assert.ok(messages.includes('진행 중인 작업은 위에 표시되고'), '실행 중 작업과 완료 기록의 위치를 구분하는 안내가 없습니다.');
    for (const animation of ['project-selection-enter', 'project-selection-orbit', 'project-selection-float', 'project-selection-breathe', 'project-selection-scan', 'project-selection-point']) {
      assert.ok(styles.includes(`@keyframes ${animation}`), `${animation} 프로젝트 선택 모션이 없습니다.`);
    }
    assert.ok(
      styles.includes('@media (prefers-reduced-motion: reduce)')
        && styles.includes('.project-selection-eyebrow i'),
      '프로젝트 선택 모션은 감소 모션 환경에서 중단되어야 합니다.',
    );
  });

  test('지난 기록은 대기 상태를 포함하고 마지막 갱신 시각 최신순으로 표시한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'app-dashboard.js'), 'utf8');
    const sandbox = { window: { WhiteboxAppFactories: {}, WhiteboxI18n: { t: key => key } }, Intl };
    vm.runInNewContext(source, sandbox, { filename: 'app-dashboard.js' });
    const sessions = [
      { id: 'claude:older', provider: 'claude', status: 'idle', updatedAt: '2026-08-06T03:00:00Z' },
      { id: 'claude:supplier-today', provider: 'claude', status: 'waiting', updatedAt: '2026-08-06T05:04:44Z' },
      { id: 'claude:running', provider: 'claude', status: 'running', updatedAt: '2026-08-06T06:00:00Z' },
    ];
    const state = { view: 'active', workspace: 'all', search: '', sort: 'recent', providerFilters: new Set(), workspaces: [], providers: [] };
    const dashboard = sandbox.window.WhiteboxAppFactories.createDashboard({ state, visibleSessions: () => sessions });
    assert.deepStrictEqual(Array.from(dashboard.filteredSessions(), session => session.id), ['claude:supplier-today', 'claude:older']);
    assert.equal(dashboard.isPastRecord(sessions[1]), true);
    assert.equal(dashboard.isPastRecord(sessions[2]), false);
  });

  test('설정 화면은 변경 가능한 항목만 읽기 쉬운 순서로 표시한다', () => {
    const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
    const themeStyles = fs.readFileSync(path.join(root, 'renderer', 'styles-theme.css'), 'utf8');
    const settingsStyles = fs.readFileSync(path.join(root, 'renderer', 'styles-settings.css'), 'utf8');
    const popupSettingsSource = fs.readFileSync(path.join(root, 'renderer', 'app-attention-popup-settings.js'), 'utf8');
    const i18nSource = fs.readFileSync(path.join(root, 'renderer', 'i18n-messages.js'), 'utf8');
    const dashboard = fs.readFileSync(path.join(root, 'renderer', 'app-dashboard.js'), 'utf8');
    const settings = html.slice(html.indexOf('id="settingsSection"'), html.indexOf('id="terminalSection"'));
    assert.equal(settings.includes('settings-meta-grid'), false, '설정과 무관한 설치 진단 정보가 다시 노출되면 안 됩니다.');
    assert.equal(settings.includes('settings-emblem'), false, '설정 제목에 의미 없는 장식이 다시 추가되면 안 됩니다.');
    assert.equal(dashboard.includes('provider-visibility-name"><b>${esc(provider.label)}</b><small>'), false, 'AI 표시 설정에 제공사 부가 정보가 다시 노출되면 안 됩니다.');
    assert.ok(dashboard.includes('update.installMode === "automatic"'), '업데이트 안내가 자동 설치와 수동 설치를 구분해야 합니다.');
    assert.ok(dashboard.includes('ui.open_the_installer_and_follow_its_instructions_to_finish_updating'), '수동 업데이트에는 설치 파일 안내가 표시되어야 합니다.');
    assert.ok(
      themeStyles.includes('body[data-current-view="settings"] .topbar')
        && themeStyles.includes('body[data-current-view="settings"] #projectContextNav')
        && themeStyles.includes('body[data-current-view="settings"] .sidebar-projects')
        && themeStyles.includes('body[data-current-view="settings"] .project-sidebar-list')
        && themeStyles.includes('width: min(100%, 1040px);'),
      '설정 화면은 읽기 폭을 제한하면서 프로젝트와 작업 탐색 탭을 유지해야 합니다.',
    );
    const languageIndex = settings.indexOf('language-settings-card');
    const themeIndex = settings.indexOf('theme-settings-card');
    const providersIndex = settings.indexOf('provider-visibility-card');
    const updateIndex = settings.indexOf('id="updatePanel"');
    assert.ok(languageIndex < themeIndex && themeIndex < providersIndex && providersIndex < updateIndex, '설정 항목의 읽기 순서가 언어, 화면, AI 목록, 업데이트 순이어야 합니다.');

    const elements = {
      attentionPopupSettingsCard: { dataset: {} },
      attentionPopupEnabled: { checked: false, disabled: false, setAttribute() {}, addEventListener() {} },
      attentionPopupStatus: { textContent: '' },
    };
    const popupSandbox = { window: { WhiteboxAppFactories: {} } };
    vm.runInNewContext(i18nSource, popupSandbox, { filename: 'i18n-messages.js' });
    const messages = popupSandbox.window.WhiteboxMessages;
    popupSandbox.window.WhiteboxI18n = {
      t(key, params = {}) {
        return String(messages[key]?.en || key).replace(/\{([a-zA-Z][\w]*)\}/g, (match, name) => (
          Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
        ));
      },
    };
    vm.runInNewContext(popupSettingsSource, popupSandbox, { filename: 'app-attention-popup-settings.js' });
    const popupState = {};
    const popupSettings = popupSandbox.window.WhiteboxAppFactories.createAttentionPopupSettings({
      state: popupState,
      $: selector => elements[String(selector).replace(/^#/, '')] || null,
    });
    popupSettings.loadAttentionPopupSettings({});
    popupSettings.renderAttentionPopupSettings();
    assert.equal(elements.attentionPopupEnabled.checked, true, '팝업 설정이 없으면 기본값은 켜짐이어야 합니다.');
    assert.equal(elements.attentionPopupSettingsCard.dataset.enabled, 'true');
    popupSettings.loadAttentionPopupSettings({ enabled: false });
    popupSettings.renderAttentionPopupSettings();
    assert.equal(elements.attentionPopupEnabled.checked, false, '사용자가 명시적으로 끈 값은 보존해야 합니다.');
    popupSettings.loadAttentionPopupSettings({
      enabled: true,
      hookStatus: 'warning',
      hookDetail: `\u0000\u202e${'x'.repeat(400)}`,
    });
    popupSettings.renderAttentionPopupSettings();
    assert.equal(elements.attentionPopupSettingsCard.dataset.hookStatus, 'warning');
    assert.match(elements.attentionPopupStatus.textContent, /^On · response connection warning: /);
    assert.equal((elements.attentionPopupStatus.textContent.match(/x+$/) || [''])[0].length, 240, '훅 세부 정보는 안전한 표시 길이로 제한해야 합니다.');
    assert.doesNotMatch(elements.attentionPopupStatus.textContent, /[\u0000\u202e]/, '훅 세부 정보의 제어 문자를 설정 화면에 표시하면 안 됩니다.');
    for (const [hookStatus, expectedCopy] of [
      ['error', 'response connection error'],
      ['review-required', 'connection settings need review'],
    ]) {
      popupSettings.loadAttentionPopupSettings({ enabled: true, hookStatus, hookDetail: 'Review the hook configuration.' });
      popupSettings.renderAttentionPopupSettings();
      assert.equal(elements.attentionPopupSettingsCard.dataset.hookStatus, hookStatus);
      assert.ok(elements.attentionPopupStatus.textContent.includes(expectedCopy));
      assert.ok(elements.attentionPopupStatus.textContent.includes('Review the hook configuration.'));
    }
    popupSettings.loadAttentionPopupSettings({ enabled: true, hookStatus: 'installed', hookDetail: 'hidden' });
    popupSettings.renderAttentionPopupSettings();
    assert.equal(elements.attentionPopupStatus.textContent, messages['settings.attention_popups.enabled'].en);
    popupSettings.loadAttentionPopupSettings({ enabled: false, hookStatus: 'error', hookDetail: 'hidden' });
    popupSettings.renderAttentionPopupSettings();
    assert.equal(elements.attentionPopupSettingsCard.dataset.hookStatus, 'disabled');
    assert.equal(elements.attentionPopupStatus.textContent, messages['settings.attention_popups.disabled'].en);
    for (const key of [
      'settings.attention_popups.hook_warning',
      'settings.attention_popups.hook_error',
      'settings.attention_popups.hook_review_required',
    ]) {
      assert.ok(messages[key]?.ko && messages[key]?.en, `${key} 한국어·영어 번역이 필요합니다.`);
    }
    assert.ok(
      settingsStyles.includes('[data-hook-status="warning"]')
        && settingsStyles.includes('[data-hook-status="review-required"]')
        && settingsStyles.includes('[data-hook-status="error"]'),
      '훅 경고·오류 상태를 구분하는 설정 카드 스타일이 필요합니다.',
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
        WhiteboxAppFactories: {},
        WhiteboxRendererUtils: {
          $: () => null, $$: () => [], esc: value => String(value), uiLocale: () => 'ko',
          providerLabel: value => value, reportRecoverableError: () => {},
        },
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        WhiteboxI18n: { t: key => key },
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'app.js' });
    const core = sandbox.window.WhiteboxAppFactories.createCore({});
    Object.assign(core, sandbox.window.WhiteboxAppFactories.createProviderVisibility(core));
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
        'npm install -g whitebox-ai',
        'whitebox',
        'https://github.com/minjund/Whitebox/releases/latest',
        'Whitebox-Setup-<version>.exe',
        'Whitebox-<version>-portable.exe',
        'Whitebox-<version>-arm64.dmg',
        'Whitebox-<version>-x64.dmg',
      ]) assert.ok(readme.includes(contract), `${file}에 ${contract} 안내가 없습니다.`);
    }

    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    for (const contract of RELEASE_WORKFLOW_CONTRACTS) {
      assert.ok(workflow.includes(contract), `release.yml에 ${contract} 계약이 없습니다.`);
    }
    const desktopWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'desktop-ci.yml'), 'utf8');
    assert.ok(desktopWorkflow.includes('npm run test:drawer-conversation'), 'Desktop CI가 대화창 터미널 회귀 검사를 실행해야 합니다.');
    assert.ok(desktopWorkflow.includes("if: runner.os == 'Windows'"), '대화창 Electron 검사는 Windows fixture에서 실행해야 합니다.');
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
