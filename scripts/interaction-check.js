'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-interaction-'));
app.setPath('userData', userData);

const failures = [];
const coverage = new Map();
const selectorActivations = new Map();
const rounds = [];
const ROUND_COUNT = Math.max(1, Math.min(3, Number(process.env.LOADTOAGENT_INTERACTION_ROUNDS || 3)));
const ONLY_STEPS = new Set(String(process.env.LOADTOAGENT_INTERACTION_ONLY || '').split(',').map(value => value.trim()).filter(Boolean));
const manifestSeen = new Set();
const manifestVisible = new Set();
const manifestUnknown = new Set();
let activeRoundIndex = 0;
let expectedTerminalFirstAfterReload = '';

const ACTION_MANIFEST = [
  { selector: '#sidebarNewProjectBtn', action: 'workspace:add-sidebar' },
  ...['all', 'active', 'waiting', 'runtime', 'tmux', 'settings'].map(view => ({ selector: `[data-view="${view}"]`, action: `nav:${view}` })),
  { selector: '#backToProjectsBtn', action: 'nav:back-to-projects' },
  { selector: '#openTmuxFromAgentWork', action: 'tmux:shortcut-from-agent-work', required: false },
  { selector: '#openProjectHistoryBtn', action: 'history:open-all' },
  { selector: '[data-theme-choice="light"]', action: 'theme:light' },
  { selector: '[data-theme-choice="dark"]', action: 'theme:dark' },
  {
    selector: '#guideBtn',
    action: 'guide:toggle',
    required: false,
    optionalReason: 'The desktop shell keeps this dispatcher hidden; the visible mobile help action invokes it.',
  },
  { selector: '#shortcutHelpBtn', action: 'quality:shortcuts-open' },
  { selector: '#closeShortcutHelpBtn', action: 'quality:shortcuts-close' },
  { selector: '#quickPaletteInput', action: 'quality:quick-search' },
  { selector: '#closeQuickPaletteBtn', action: 'quality:quick-close' },
  { selector: '[data-quick-command]', action: 'quality:quick-command' },
  { selector: '#dismissGuideBtn', action: 'guide:dismiss' },
  { selector: '[data-guide-action]', action: 'guide:step' },
  ...['create', 'active', 'waiting', 'detail'].map(action => ({ selector: `[data-guide-action="${action}"]`, action: `guide:${action}` })),
  { selector: '#mobileMoreBtn', action: 'mobile:more' },
  { selector: '#mobileToolsCloseBtn', action: 'mobile:close' },
  { selector: '[data-mobile-view]', action: 'mobile:view' },
  ...['runtime', 'tmux', 'settings'].map(view => ({ selector: `[data-mobile-view="${view}"]`, action: `mobile:view-${view}` })),
  { selector: '.mobile-project-picker > summary', action: 'mobile:project-picker' },
  {
    selector: '#updateNoticeBtn',
    action: 'update:notice-open',
    required: false,
    optionalReason: 'The project-first home intentionally routes update status through the settings navigation badge instead of a separate notice card.',
  },
  { selector: '#checkUpdateBtn', action: 'update:check' },
  { selector: '#installUpdateBtn', action: 'update:download' },
  {
    selector: '#openReleaseBtn',
    action: 'update:release-open',
    required: false,
    optionalReason: 'The beginner settings view intentionally hides detailed release notes and their external-link button.',
  },
  { selector: '#languageSelect', action: 'settings:language' },
  { selector: '[data-provider-visibility]', action: 'settings:provider-visibility' },
  { selector: '#probeBtn', action: 'dashboard:probe' },
  {
    selector: '#addWorkspaceBtn',
    action: 'workspace:add',
    required: false,
    optionalReason: 'The project-first desktop shell uses the visible sidebar new-project action; this legacy toolbar duplicate stays hidden.',
  },
  { selector: '#mobileAddWorkspaceBtn', action: 'workspace:add' },
  { selector: '#newRunBtn', action: 'run:open' },
  {
    selector: '#newPowerShellBtn',
    action: 'terminal:create-windows',
    required: false,
    optionalReason: 'The project-first terminal opens from its owning task and intentionally hides the legacy general-terminal creation header.',
  },
  {
    selector: '#newWslBtn',
    action: 'terminal:create-linux',
    required: false,
    optionalReason: 'The project-first terminal opens from its owning task and intentionally hides the legacy general-terminal creation header.',
  },
  { selector: '[data-terminal-signal="interrupt"]', action: 'terminal:signal-interrupt' },
  { selector: '[data-terminal-signal="clear"]', action: 'terminal:signal-clear' },
  { selector: '#terminalRestartBtn', action: 'terminal:restart' },
  { selector: '#terminalAttachBtn', action: 'terminal:attach' },
  { selector: '#terminalCloseBtn', action: 'terminal:close' },
  { selector: '#terminalEndSessionBtn', action: 'terminal:end-session' },
  { selector: '#terminalHistoryToggle', action: 'terminal:history-collapse' },
  { selector: '.terminal-session-tools > summary', action: 'terminal:session-controls' },
  { selector: '#terminalFontDecreaseBtn', action: 'terminal:font-decrease' },
  { selector: '#terminalFontIncreaseBtn', action: 'terminal:font-increase' },
  { selector: '#terminalComputerInputBtn', action: 'terminal:computer-input-focus' },
  {
    selector: '#terminalModeQuestionBtn',
    action: 'terminal:mode-question',
    required: false,
    optionalReason: 'The contextual terminal infers its input mode from the opened task and keeps the legacy global mode switch hidden.',
  },
  {
    selector: '#terminalModeComputerBtn',
    action: 'terminal:mode-computer',
    required: false,
    optionalReason: 'The contextual terminal infers its input mode from the opened task and keeps the legacy global mode switch hidden.',
  },
  { selector: '#terminalFocusBtn', action: 'terminal:focus-mode' },
  { selector: '#terminalSlashTrigger', action: 'terminal:slash-open' },
  { selector: '[data-terminal-slash-command]', action: 'terminal:slash-select' },
  { selector: '#terminalLongDraftToggle', action: 'terminal:long-draft-expand' },
  { selector: '#terminalCommandForm', action: 'terminal:failure-submit' },
  { selector: '#terminalCommandInput', action: 'terminal:command-input' },
  { selector: '#terminalCommandForm button[type="submit"]', action: 'terminal:failure-submit' },
  { selector: '[data-terminal-failure-cause]', action: 'terminal:failure-cause' },
  { selector: '[data-terminal-restart-inline]', action: 'terminal:failure-restart-inline' },
  { selector: '[data-terminal-id]', action: 'terminal:select-session' },
  { selector: '#terminalSessionList [data-terminal-id][draggable="true"]', action: 'terminal:reorder-drag' },
  { selector: '[data-tmux-distro][data-tmux-pane]', action: 'tmux:select-resource' },
  ...['rename-session', 'new-window', 'split-horizontal', 'split-vertical', 'kill-pane', 'kill-window', 'kill-session'].map(name => ({ selector: `[data-tmux-manage="${name}"]`, action: `tmux:${name}` })),
  { selector: '#terminalTmuxLayout', action: 'tmux:layout' },
  { selector: '#refreshTmuxTerminalBtn', action: 'tmux:refresh' },
  { selector: '#newTmuxSessionBtn', action: 'tmux:modal-open' },
  { selector: '#tmuxResetBtn', action: 'tmux:reset' },
  { selector: '[data-tmux-reset]', action: 'tmux:reset' },
  { selector: '#graphResetBtn', action: 'graph:reset' },
  { selector: '[data-graph-reset]', action: 'graph:reset' },
  {
    selector: '[data-graph-provider-more]',
    action: 'graph:provider-more',
    required: false,
    optionalReason: 'providerFlowLane defines this control but has no renderer call site in the current product, so the fixture cannot render it.',
  },
  {
    selector: '[data-graph-provider-less]',
    action: 'graph:provider-less',
    required: false,
    optionalReason: 'providerFlowLane defines this control but has no renderer call site in the current product, so the fixture cannot render it.',
  },
  { selector: '#searchInput', action: 'filter:search' },
  { selector: '#searchClearBtn', action: 'filter:search-clear' },
  { selector: '#emptyClearFiltersBtn', action: 'filter:empty-clear' },
  { selector: '#resetFiltersBtn', action: 'filter:reset-all' },
  {
    selector: '[data-i18n="memory.wisdom_visual_action"]',
    action: 'memory:results-help-link',
    required: false,
    optionalReason: 'This in-page help link only scrolls back to the work-history list.',
  },
  {
    selector: '[data-i18n="memory.wisdom_failure_action"]',
    action: 'memory:failure-help-link',
    required: false,
    optionalReason: 'This in-page help link only scrolls back to the work-history list.',
  },
  {
    selector: '[data-i18n="memory.wisdom_boundary_action"]',
    action: 'memory:change-help-link',
    required: false,
    optionalReason: 'This in-page help link only scrolls back to the work-history list.',
  },
  { selector: '[data-provider-filter]', action: 'filter:provider' },
  { selector: '#mobileProviderFilterSelect', action: 'filter:provider-mobile' },
  { selector: '#sortSelect', action: 'filter:sort' },
  { selector: '#memoryWorkspaceFilter', action: 'filter:memory-project' },
  {
    selector: '#controlRoomSortSelect',
    action: 'control-room:sort',
    required: false,
    optionalReason: 'The project-first home hides the legacy control-room filter toolbar.',
  },
  {
    selector: '#controlRoomProjectSelect',
    action: 'control-room:project-select',
    required: false,
    optionalReason: 'The project-first home uses the persistent project rail instead of the legacy project select.',
  },
  {
    selector: '#controlRoomSearchInput',
    action: 'control-room:search',
    required: false,
    optionalReason: 'The project-first home hides the legacy control-room search field.',
  },
  {
    selector: '#controlRoomSearchBtn',
    action: 'control-room:search-toggle',
    required: false,
    optionalReason: 'The project-first home hides the legacy control-room search toggle.',
  },
  {
    selector: '#controlRoomExpandAll',
    action: 'control-room:expand-all',
    required: false,
    optionalReason: 'The project-first studio hides bulk disclosure controls and keeps direct project-header toggles.',
  },
  {
    selector: '#controlRoomCollapseAll',
    action: 'control-room:collapse-all',
    required: false,
    optionalReason: 'The project-first studio hides bulk disclosure controls and keeps direct project-header toggles.',
  },
  {
    selector: '.control-project-header[draggable="true"]',
    action: 'control-room:project-reorder-drag',
    required: false,
    optionalReason: 'The project-first home renders one selected project at a time, so cross-project drag ordering is no longer an accessible surface.',
  },
  {
    selector: '[data-project-toggle]',
    action: 'control-room:project-toggle',
    required: false,
    optionalReason: 'The selected-project home hides the redundant project wrapper header and shows its work directly.',
  },
  { selector: '[data-session-archive]', action: 'control-room:move-to-history' },
  { selector: '#loadMoreBtn', action: 'filter:load-more' },
  { selector: '[data-open-run]', action: 'run:open-empty' },
  { selector: '#closeDrawerBtn', action: 'drawer:close' },
  { selector: '#drawerBackToFlowBtn', action: 'drawer:back-to-flow' },
  { selector: '[data-copy-text]', action: 'drawer:copy' },
  { selector: '[data-prompt-toggle]', action: 'drawer:prompt-toggle' },
  { selector: '[data-user-prompt-copy]', action: 'drawer:prompt-copy' },
  ...['summary', 'chat', 'lifecycle', 'tokens'].map(tab => ({ selector: `[data-tab="${tab}"]`, action: `drawer:tab-${tab}` })),
  { selector: '[data-session-reset]', action: 'session:reset' },
  { selector: '#cancelSessionResetBtn', action: 'session:reset-cancel' },
  { selector: '#confirmSessionResetBtn', action: 'session:reset-confirm' },
  { selector: '[data-conversation-slash-command]', action: 'drawer:slash-command' },
  { selector: '[data-management-filter]', action: 'management:overview-filter' },
  {
    selector: '[data-management-inbox-filter]',
    action: 'management:inbox-filter',
    required: false,
    optionalReason: 'The streamlined review inbox hides its legacy multi-filter toolbar and presents the oldest decision first.',
  },
  {
    selector: '[data-management-inbox-filter="warning"]',
    action: 'management:inbox-warning',
    required: false,
    optionalReason: 'The streamlined review inbox hides its legacy multi-filter toolbar and presents the oldest decision first.',
  },
  {
    selector: '[data-attention-draft]',
    action: 'management:reply-template',
    required: false,
    optionalReason: 'The current attention cards use the shared agent command composer instead of the retired reply-template control.',
  },
  { selector: '[data-attention-quick]', action: 'management:quick-response' },
  { selector: '[data-management-session="fixture-waiting"] [data-attention-quick]:not(.approve)', action: 'management:quick-deny' },
  { selector: '[data-managed-run-action]', action: 'management:run-control' },
  { selector: '[data-managed-run-action="stop"]', action: 'management:run-stop' },
  {
    selector: '[data-supervision-focus]',
    action: 'management:supervision-focus',
    required: false,
    optionalReason: 'The supervision console is behind the current early return in renderOperationsOverview and is not rendered by the fixture.',
  },
  {
    selector: '[data-supervision-intervention-open]',
    action: 'management:supervision-intervention-open',
    required: false,
    optionalReason: 'The mobile supervision console is behind the current early return in renderOperationsOverview and is not rendered by the fixture.',
  },
  {
    selector: '.attention-evidence-details > summary',
    action: 'management:evidence-details',
    required: false,
    optionalReason: 'The streamlined review cards hide this legacy disclosure; the same evidence remains available in the task detail drawer.',
  },
  {
    selector: '.supervision-intervention > summary',
    action: 'management:supervision-intervention',
    required: false,
    optionalReason: 'The supervision intervention disclosure is behind the current early return in renderOperationsOverview and is not rendered by the fixture.',
  },
  { selector: '[data-reassign-session]', action: 'management:reassign' },
  { selector: '[data-result-review-complete]', action: 'management:result-review-complete' },
  { selector: '[data-scroll-latest]', action: 'drawer:latest' },
  { selector: '[data-retry-detail]', action: 'drawer:retry' },
  { selector: '[data-stop-run]', action: 'drawer:stop-double' },
  {
    selector: '[data-conversation-interrupt]',
    action: 'agent:interrupt-response',
    required: false,
    optionalReason: 'Subagent details are intentionally read-only, while the deterministic main-agent fixture uses attached PTY mode without a structured-response interrupt control.',
  },
  { selector: '#drawerTerminalFocusBtn', action: 'drawer:terminal-focus' },
  { selector: '#drawerTerminalReconnectBtn', action: 'drawer:terminal-reconnect' },
  { selector: '#runForm', action: 'run:submit' },
  { selector: '#runPrompt', action: 'run:prompt-input' },
  {
    selector: '#runCwd',
    action: 'run:cwd-input',
    required: false,
    optionalReason: 'The project-first composer keeps the selected project path in a hidden readonly field instead of exposing an editable working-directory control.',
  },
  { selector: '#runModel', action: 'run:model-input' },
  { selector: '#closeRunModalBtn', action: 'run:close-x' },
  {
    selector: '#pickRunCwdBtn',
    action: 'run:pick-cwd',
    required: false,
    optionalReason: 'The project-first composer locks execution to the selected project, so its legacy working-directory picker stays hidden and disabled.',
  },
  { selector: '#allowWrites', action: 'run:allow-writes' },
  { selector: '#cancelRunBtn', action: 'run:cancel' },
  { selector: '#clearRunDraftBtn', action: 'run:clear-draft' },
  { selector: '#runForm button[type="submit"]', action: 'run:submit' },
  { selector: '[data-run-provider]', action: 'run:provider' },
  { selector: '[data-provider-docs]', action: 'run:provider-docs' },
  { selector: '[data-provider-recheck]', action: 'run:provider-recheck' },
  { selector: '[data-run-prompt-key]', action: 'run:prompt-example' },
  ...['fix', 'review', 'tests'].map(example => ({ selector: `[data-run-prompt-key="run.example.${example}"]`, action: `run:prompt-example-${example}` })),
  {
    selector: '[data-run-workspace]',
    action: 'run:workspace-suggestion',
    required: false,
    optionalReason: 'The project-first composer locks execution to the selected project and no longer renders alternate workspace suggestions.',
  },
  { selector: '.run-advanced > summary', action: 'run:advanced-settings' },
  { selector: '#tmuxCreateForm', action: 'tmux:modal-submit' },
  { selector: '#tmuxCreateDistro', action: 'tmux:modal-submit' },
  { selector: '#tmuxCreateName', action: 'tmux:name-input' },
  { selector: '#tmuxCreateCwd', action: 'tmux:cwd-input' },
  { selector: '#tmuxCreateCommand', action: 'tmux:command-input' },
  { selector: '#pickTmuxCwdBtn', action: 'tmux:pick-cwd' },
  { selector: '#closeTmuxCreateBtn', action: 'tmux:modal-close-x' },
  { selector: '#cancelTmuxCreateBtn', action: 'tmux:modal-cancel' },
  { selector: '#tmuxCreateForm button[type="submit"]', action: 'tmux:modal-submit' },
  {
    selector: '[data-provider-card]',
    action: 'filter:provider-card',
    required: false,
    optionalReason: 'renderSessionsContent unconditionally hides #providerOverview in the current product, so provider cards are not an activatable surface; the visible provider filter chips are exercised instead.',
  },
  { selector: '[data-workspace]', action: 'workspace:select' },
  { selector: '[data-remove-workspace]', action: 'workspace:remove' },
  { selector: '[data-session-sortable][draggable="true"]', action: 'session:reorder-drag' },
  { selector: '[data-session-id]', action: 'drawer:open-card' },
  { selector: '[data-loop-select]', action: 'runtime:select-loop' },
  { selector: '[data-loop-open]', action: 'runtime:open-loop' },
  { selector: '[data-automation-session]', action: 'runtime:open-schedule' },
  { selector: '[data-graph-focus]', action: 'graph:focus' },
  { selector: '[data-open-session]', action: 'drawer:open-graph' },
  {
    selector: '[data-agent-terminal-open]',
    action: 'terminal:open-from-agent',
    required: false,
    optionalReason: 'The focused work screen is read-only; terminal access now opens from the separate conversation drawer.',
  },
  {
    selector: '[data-agent-bridge-copy]',
    action: 'agent:bridge-copy',
    required: false,
    optionalReason: 'The focused subagent work screen is intentionally read-only and no longer renders connection or command controls.',
  },
  { selector: '[data-agent-command-target]', action: 'agent:target-select' },
  { selector: '[data-agent-command-draft]', action: 'agent:command-draft' },
  { selector: '[data-agent-command-form]', action: 'agent:command-submit' },
  { selector: '[data-agent-command-form] button[type="submit"]', action: 'agent:command-submit' },
  { selector: '.conversation-send', action: 'agent:conversation-send' },
  { selector: '[data-subagent-completed-toggle]', action: 'subagent:toggle-completed' },
  { selector: '[data-execution-history-toggle]', action: 'graph:execution-history' },
  { selector: '.execution-activity-card > summary', action: 'graph:execution-details' },
  { selector: '[data-open-subagent-chat]', action: 'subagent:open-conversation' },
  { selector: '.chat-activities.subagent-coordination > summary', action: 'subagent:coordination-details' },
  { selector: '[data-open-execution-id]', action: 'control-room:open-execution' },
  { selector: '[data-resume-agent]', action: 'agent:resume-terminal' },
  { selector: '[data-control-tmux]', action: 'tmux:control-pane' },
  {
    selector: '[data-tmux-subagents-toggle]',
    action: 'tmux:subagents-toggle',
    required: false,
    optionalReason: 'The simplified remote-computer map omits nested helper controls; helper conversations remain available in the agent flow.',
  },
  { selector: '[data-tmux-type][data-tmux-id]', action: 'tmux:focus-node' },
  { selector: '#terminalCommandClearBtn', action: 'terminal:clear-draft' },
  { selector: '#advancedToolsNav > summary', action: 'nav:advanced-tools' },
  { selector: '.skip-link', action: 'nav:skip-link' },
  { selector: '#drawerResizeHandle', action: 'drawer:resize-keyboard' },
  { selector: '.chat-roadmap > summary', action: 'drawer:expand-roadmap' },
  { selector: '[data-close-expanded-reader]', action: 'drawer:close-expanded-reader' },
  {
    selector: '.memory-record-lineage > summary',
    action: 'memory:record-lineage',
    required: false,
    optionalReason: 'The work-history evidence disclosure is an optional progressive-detail surface.',
  },
  { selector: '.approval-custom-answer > summary', action: 'management:custom-answer' },
  { selector: '.attention-more-cards > summary', action: 'management:more-cards' },
  { selector: '.runtime-other-work > summary', action: 'runtime:other-work' },
  { selector: '.runtime-schedule-lane > summary', action: 'runtime:schedule-lane' },
  { selector: '.mobile-memory-filters > summary', action: 'filter:mobile-disclosure' },
  {
    selector: '#terminalAttachTrigger',
    action: 'terminal:composer-attach',
    required: false,
    optionalReason: 'File selection is not implemented, so the placeholder remains hidden rather than opening an unrelated command menu.',
  },
  { selector: '.terminal-past-sessions > summary', action: 'terminal:past-sessions' },
  {
    selector: '#appRetryBtn',
    action: 'bootstrap:retry',
    required: false,
    optionalReason: 'The success-only interaction fixture exposes no initialization-error trigger; reloading cannot assert recovery from a real bootstrap failure.',
  },
  {
    selector: '#appErrorCopyBtn',
    action: 'bootstrap:copy-error',
    required: false,
    optionalReason: 'The success-only interaction fixture never initializes the private bootstrap error message copied by this control.',
  },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mark = action => coverage.set(action, Number(coverage.get(action) || 0) + 1);
const markSelectors = selectors => {
  const matchedActions = new Set();
  for (const selector of selectors || []) {
    if (!selectorActivations.has(selector)) selectorActivations.set(selector, new Set());
    selectorActivations.get(selector).add(activeRoundIndex);
    for (const entry of ACTION_MANIFEST) if (entry.selector === selector) matchedActions.add(entry.action);
  }
  matchedActions.forEach(mark);
  return matchedActions;
};

async function recordManifest(win) {
  const result = await win.webContents.executeJavaScript(`(() => {
    const selectors = ${JSON.stringify(ACTION_MANIFEST.map(item => item.selector))};
    const isVisible = element => {
      if (!element?.isConnected || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return element.getClientRects().length > 0
        && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility === 'visible'
        && Number(style.opacity) > 0;
    };
    const discovered = [...document.querySelectorAll('button, a[href], summary, [role="button"], [role="separator"][tabindex], input, select, textarea, form, [data-provider-card], [data-workspace], [data-session-id]')]
      .filter(isVisible);
    const unknown = discovered.filter(element => !selectors.some(selector => { try { return element.matches(selector); } catch { return false; } })).map(element => element.outerHTML.slice(0, 240));
    const seen = selectors.filter(selector => { try { return Boolean(document.querySelector(selector)); } catch { return false; } });
    const visible = selectors.filter(selector => {
      try { return [...document.querySelectorAll(selector)].some(isVisible); } catch { return false; }
    });
    return { unknown, seen, visible };
  })()`);
  result.seen.forEach(selector => manifestSeen.add(selector));
  result.visible.forEach(selector => manifestVisible.add(selector));
  result.unknown.forEach(html => manifestUnknown.add(html));
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function waitFor(win, expression, message, attempts = 80, interval = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await win.webContents.executeJavaScript(expression)) return;
    } catch {}
    await sleep(interval);
  }
  throw new Error(message);
}

async function waitForDashboardDefaults(win, message, { requireSearchFocus = true } = {}) {
  let last = null;
  let consecutive = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await win.webContents.executeJavaScript(`(() => {
      const app = window.LoadToAgentApp;
      const predicates = {
        search: app.state.search === ''
          && document.querySelector('#searchInput')?.value === ''
          && document.querySelector('#searchClearBtn')?.classList.contains('hidden'),
        provider: app.state.providerFilters.size === 0
          && document.querySelector('[data-provider-filter="all"]')?.getAttribute('aria-pressed') === 'true',
        workspaceState: app.state.workspace === 'all',
        workspaceDesktop: document.querySelector('#workspaceList [data-workspace="all"]')?.getAttribute('aria-pressed') === 'true',
        workspaceControl: document.querySelector('#controlRoomProjectSelect')?.value === 'all',
        workspaceMemory: document.querySelector('#memoryWorkspaceFilter')?.value === 'all',
        sort: app.state.sort === 'recent' && document.querySelector('#sortSelect')?.value === 'recent',
        focus: ${requireSearchFocus ? `document.activeElement?.id === 'searchInput'` : 'true'},
        buttonHidden: document.querySelector('#resetFiltersBtn')?.classList.contains('hidden'),
        allViewRendered: app.state.view === 'active'
          && !document.querySelector('#sessionSection')?.classList.contains('hidden')
          && !document.querySelector('#sessionGrid')?.classList.contains('hidden')
          && Boolean(document.querySelector('[data-session-id="fixture-ended"]')),
      };
      return { predicates, state: {
        search: app.state.search,
        providerFilters: [...app.state.providerFilters],
        workspace: app.state.workspace,
        sort: app.state.sort,
        controlRoomSort: app.state.controlRoomSort,
        activeElement: document.activeElement?.id || document.activeElement?.outerHTML?.slice(0, 120) || '',
      }};
    })()`);
    if (Object.values(last.predicates).every(Boolean)) consecutive += 1;
    else consecutive = 0;
    // Four consecutive samples cover the 120 ms search debounce and ensure a
    // late render cannot immediately undo the reset before the next exercise.
    if (consecutive >= 4) return last;
    await sleep(50);
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}

async function click(win, selector, action, times = 1, eligibilityAttempts = 1, detailsToOpen = '', recordAfter = true) {
  await recordManifest(win);
  const inferredDetailsToOpen = detailsToOpen || (
    ['[data-view="runtime"]', '[data-view="terminal"]', '[data-view="tmux"]'].includes(selector)
      ? '#advancedToolsNav'
      : ''
  );
  let result;
  for (let attempt = 0; attempt < Math.max(1, Number(eligibilityAttempts) || 1); attempt += 1) {
    result = await win.webContents.executeJavaScript(`(() => {
      const manifestSelectors = ${JSON.stringify(ACTION_MANIFEST.map(item => item.selector))};
      const rejectionReason = element => {
        if (!element?.isConnected) return 'detached';
        if (element.disabled || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return 'disabled';
        if (element.closest('[inert]')) return 'inert';
        if (element.closest('[hidden], [aria-hidden="true"]')) return 'hidden';
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (!element.getClientRects().length || rect.width <= 0 || rect.height <= 0 || style.display === 'none') return 'not-rendered';
        if (style.visibility !== 'visible' || Number(style.opacity) <= 0) return 'hidden';
        for (let node = element; node instanceof Element; node = node.parentElement) {
          if (getComputedStyle(node).pointerEvents === 'none') return 'pointer-disabled';
        }
        return '';
      };
      const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const diagnostics = () => ({
        view: window.LoadToAgentApp?.state?.view || '',
        shellInert: Boolean(document.querySelector('#appShell')?.inert),
        filters: window.LoadToAgentApp ? {
          search: window.LoadToAgentApp.state.search,
          providers: [...window.LoadToAgentApp.state.providerFilters],
          workspace: window.LoadToAgentApp.state.workspace,
          sort: window.LoadToAgentApp.state.sort,
        } : null,
        candidates: candidates.slice(0, 3).map(element => ({
          id: element.id,
          className: element.className,
          display: getComputedStyle(element).display,
          rect: {
            width: Math.round(element.getBoundingClientRect().width),
            height: Math.round(element.getBoundingClientRect().height),
          },
          hiddenAncestor: element.closest('[hidden], [aria-hidden="true"]')?.id || '',
          parentDisplays: [element.parentElement, element.parentElement?.parentElement, element.parentElement?.parentElement?.parentElement]
            .filter(Boolean)
            .map(parent => ({ id: parent.id, className: parent.className, display: getComputedStyle(parent).display })),
        })),
        dialogs: ['#mobileToolsMenu', '#runModal', '#tmuxCreateModal', '#detailDrawer', '#quickPaletteModal', '#shortcutHelpModal', '#sessionResetModal']
          .filter(dialogSelector => {
            const dialog = document.querySelector(dialogSelector);
            return dialog && !dialog.classList.contains('hidden') && (dialog.classList.contains('open') || dialog.matches('.modal-backdrop') || dialog.id === 'mobileToolsMenu');
          }),
      });
      const requestedView = ${JSON.stringify(selector)}.match(/^\\[data-view="([^"]+)"\\]$/)?.[1] || '';
      if (requestedView && !candidates.some(candidate => !rejectionReason(candidate))) {
        if (typeof window.LoadToAgentApp?.selectView !== 'function') {
          return { ok: false, reason: 'missing-view-router', diagnostics: diagnostics() };
        }
        window.LoadToAgentApp.selectView(requestedView);
        return { ok: true, matched: [${JSON.stringify(selector)}] };
      }
      const preparationSelector = ${JSON.stringify(inferredDetailsToOpen)};
      if (preparationSelector) {
        const details = document.querySelector(preparationSelector);
        if (!details) return { ok: false, reason: 'missing', diagnostics: diagnostics() };
        if (!details.open) {
          const summary = details.querySelector(':scope > summary');
          const summaryReason = rejectionReason(summary);
          if (summaryReason) return { ok: false, reason: summaryReason, diagnostics: diagnostics() };
          summary.click();
          if (!details.open) return { ok: false, reason: 'unavailable', diagnostics: diagnostics() };
        }
      }
      if (!candidates.length) return { ok: false, reason: 'missing', diagnostics: diagnostics() };
      const reasons = candidates.map(rejectionReason);
      const element = candidates.find((candidate, index) => !reasons[index]);
      if (!element) return { ok: false, reason: [...new Set(reasons)].join(',') || 'unavailable', diagnostics: diagnostics() };
      for (let index = 0; index < ${Math.max(1, Number(times) || 1)}; index += 1) element.click();
      const exercisedElements = [element];
      if (element.matches('button[type="submit"], input[type="submit"]') && element.form) exercisedElements.push(element.form);
      // Custom checkboxes expose a rendered label while the native input is the
      // intentionally 1px, pointer-disabled state carrier. Clicking the label is
      // the real user path, so credit only that label's associated control.
      if (element instanceof HTMLLabelElement && element.control) exercisedElements.push(element.control);
      const matched = manifestSelectors.filter(manifestSelector => {
        try { return exercisedElements.some(exercised => exercised.matches(manifestSelector)); } catch { return false; }
      });
      return { ok: true, matched };
    })()`);
    if (result?.ok) break;
    if (!['hidden', 'not-rendered', 'detached', 'missing', 'inert'].some(reason => String(result?.reason || '').split(',').includes(reason))) break;
    if (attempt + 1 < Math.max(1, Number(eligibilityAttempts) || 1)) await sleep(50);
  }
  assert(result && result.ok, `${action}: ${selector} 요소를 클릭하지 못했습니다 (${result && result.reason || 'unknown'}; ${JSON.stringify(result?.diagnostics || {})}).`);
  const matchedActions = markSelectors(result.matched);
  if (!matchedActions.has(action)) mark(action);
  if (recordAfter) await recordManifest(win);
}

async function recordExercise(win, selector) {
  const result = await win.webContents.executeJavaScript(`(() => {
    const manifestSelectors = ${JSON.stringify(ACTION_MANIFEST.map(item => item.selector))};
    const eligible = element => {
      if (!element?.isConnected || element.disabled || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return false;
      if (element.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (!element.getClientRects().length || rect.width <= 0 || rect.height <= 0 || style.display === 'none'
        || style.visibility !== 'visible' || Number(style.opacity) <= 0) return false;
      for (let node = element; node instanceof Element; node = node.parentElement) {
        if (getComputedStyle(node).pointerEvents === 'none') return false;
      }
      return true;
    };
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(eligible);
    if (!element) return { ok: false };
    return {
      ok: true,
      matched: manifestSelectors.filter(manifestSelector => {
        try { return element.matches(manifestSelector); } catch { return false; }
      }),
    };
  })()`);
  assert(result?.ok, `explicit exercise: ${selector}에 활성화 가능한 요소가 없습니다.`);
  markSelectors(result.matched);
  await recordManifest(win);
}

async function callCount(win, name) {
  return win.webContents.executeJavaScript(`window.interactionTest.getCalls().filter(item => item.name === ${JSON.stringify(name)}).length`);
}

async function clearCalls(win) {
  await win.webContents.executeJavaScript('window.interactionTest.clearCalls()');
}

async function invokeLegacyTerminalControl(win, selector, times = 1) {
  const invoked = await win.webContents.executeJavaScript(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!control || control.disabled) return false;
    for (let index = 0; index < ${Math.max(1, Number(times) || 1)}; index += 1) control.click();
    return true;
  })()`);
  assert(invoked, `숨겨진 레거시 터미널 테스트 준비 컨트롤을 실행하지 못했습니다: ${selector}`);
}

async function setLegacyTerminalMode(win, mode) {
  const selector = mode === 'question' ? '#terminalModeQuestionBtn' : '#terminalModeComputerBtn';
  await invokeLegacyTerminalControl(win, selector);
  await waitFor(win, `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-pressed') === 'true'`,
    `레거시 터미널 ${mode} 모드 테스트 준비가 완료되지 않았습니다.`);
}

async function prepareProjectFirstStep(win, workspace = 'selected') {
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.workspace = ${JSON.stringify(workspace)} === 'selected'
      ? app.state.workspaces[0]?.path || 'all'
      : ${JSON.stringify(workspace)};
    app.state.search = '';
    app.state.providerFilters.clear();
    app.state.managementFilter = 'all';
    app.state.sort = 'recent';
    app.state.controlRoomSort = 'recent';
    app.state.graphFocusId = null;
    app.state.visibleLimit = 30;
    app.render('filter');
  })()`);
}

async function step(round, name, fn) {
  try {
    await fn();
    round.passed.push(name);
  } catch (error) {
    const detail = `${name}: ${error.stack || error.message}`;
    round.failed.push(detail);
    failures.push(`round ${round.index} · ${detail}`);
  }
}

async function installPageGuards(win) {
  await win.webContents.executeJavaScript(`(() => {
    window.__interactionErrors = [];
    window.addEventListener('error', event => window.__interactionErrors.push('error:' + (event.error?.stack || event.message || 'unknown')));
    window.addEventListener('unhandledrejection', event => window.__interactionErrors.push('rejection:' + String(event.reason && (event.reason.stack || event.reason.message) || event.reason)));
    window.confirm = () => true;
    window.prompt = message => String(message || '').includes('tmux 세션') ? 'fixture-renamed' : 'fixture-window';
  })()`);
}

async function exerciseNavigation(win, round) {
  await win.webContents.executeJavaScript(`document.querySelector('.skip-link').focus()`);
  await waitFor(win, `document.activeElement?.matches('.skip-link')`, '본문 바로가기 링크가 키보드 포커스를 받지 못했습니다.');
  await sleep(220);
  await click(win, '.skip-link', 'nav:skip-link');
  await waitFor(win, `window.location.hash === '#mainContent'`, '본문 바로가기 링크가 mainContent로 이동하지 않았습니다.');

  const primaryNavVisible = await win.webContents.executeJavaScript(`(() => {
    const nav = document.querySelector('#projectContextNav');
    if (!nav) return false;
    const rect = nav.getBoundingClientRect();
    return nav.getClientRects().length > 0 && rect.width > 0 && rect.height > 0 && getComputedStyle(nav).display !== 'none';
  })()`);
  assert(primaryNavVisible, '기본 프로젝트 내비게이션이 표시되지 않았습니다.');
  const advancedInitiallyOpen = await win.webContents.executeJavaScript(`document.querySelector('#advancedToolsNav').open`);
  await click(win, '#advancedToolsNav > summary', 'nav:advanced-tools');
  await waitFor(win, `document.querySelector('#advancedToolsNav').open !== ${JSON.stringify(advancedInitiallyOpen)}`, '고급 도구 summary가 열림 상태를 전환하지 않았습니다.');
  if (advancedInitiallyOpen) {
    await click(win, '#advancedToolsNav > summary', 'nav:advanced-tools');
    await waitFor(win, `document.querySelector('#advancedToolsNav').open`, '고급 도구 내비게이션을 다시 열지 못했습니다.');
  }

  let scrollResets = 0;
  for (const view of ['active', 'waiting', 'runtime', 'terminal', 'settings', 'all']) {
    const before = await win.webContents.executeJavaScript(`(() => { const stage = document.querySelector('.main-stage'); stage.scrollTop = stage.scrollHeight; return stage.scrollTop; })()`);
    await click(win, `[data-view="${view}"]`, `nav:${view}`);
    await waitFor(win, `window.LoadToAgentApp.state.view === ${JSON.stringify(view)} && (!document.querySelector('[data-view="${view}"]') || document.querySelector('[data-view="${view}"]').classList.contains('active'))`, `${view} 화면 전환 실패`);
    if (before > 0) {
      const after = await win.webContents.executeJavaScript(`document.querySelector('.main-stage').scrollTop`);
      assert(after === 0, `${view} 화면 전환 후 main-stage scrollTop이 0이 아닙니다: ${after}`);
      scrollResets += 1;
    }
    if (view === 'terminal') await waitFor(win, `Boolean(document.querySelector('[data-terminal-id="terminal-main"]'))`, '세션 터미널 초기화가 끝나지 않았습니다.', 120);
  }
  mark('nav:scroll-reset');
  assert(scrollResets > 0, '스크롤 가능한 화면에서 nav scroll reset을 검증하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const home = document.querySelector('[data-view="all"]');
    home.focus();
    home.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  })()`);
  await waitFor(win, `document.activeElement?.dataset.view === 'active'`, '프로젝트 탭 아래 방향키가 다음 화면 버튼으로 이동하지 않았습니다.');
  await win.webContents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))`);
  await waitFor(win, `document.activeElement?.dataset.view === 'waiting'`, '닫힌 프로젝트 탭에서 End 키가 마지막 기본 화면 버튼으로 이동하지 않았습니다.');
  await click(win, '#advancedToolsNav > summary', 'nav:advanced-tools');
  await waitFor(win, `document.querySelector('#advancedToolsNav').open`, '키보드 이동 검증 전에 추가 기능 메뉴를 열지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const summary = document.querySelector('#advancedToolsNav > summary');
    summary.focus();
    summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  })()`);
  await waitFor(win, `document.activeElement?.dataset.view === 'tmux'`, '열린 추가 기능 메뉴에서 End 키가 마지막 화면 버튼으로 이동하지 않았습니다.');
  mark('nav:keyboard-roaming');
  await win.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '3', metaKey: true, bubbles: true }))`);
  await waitFor(win, `window.LoadToAgentApp.state.view === 'waiting' && document.activeElement?.id === 'mainContent'`, '화면 단축키 Meta+3이 내 확인 필요 화면을 열지 못했습니다.');
  mark('nav:keyboard-shortcut');
  await win.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))`);
  await waitFor(win, `window.LoadToAgentApp.state.view === 'active' && document.activeElement?.id === 'searchInput'`, '/ 단축키가 기억 검색창으로 이동하지 못했습니다.');
  mark('filter:search-shortcut');
  round.observed.navigation = true;
  round.observed.navScrollResets = scrollResets;
}

async function exerciseQualityEnhancements(win, round) {
  await click(win, '[data-view="settings"]', 'nav:settings');
  await win.webContents.executeJavaScript(`document.querySelector('#shortcutHelpBtn').focus()`);
  await click(win, '#shortcutHelpBtn', 'quality:shortcuts-open');
  await waitFor(win, `!document.querySelector('#shortcutHelpModal').classList.contains('hidden') && document.querySelector('#appShell').inert && document.activeElement?.id === 'closeShortcutHelpBtn'`, '단축키 도움말이 배경을 격리하고 초점을 받지 못했습니다.');
  await click(win, '#closeShortcutHelpBtn', 'quality:shortcuts-close');
  await waitFor(win, `document.querySelector('#shortcutHelpModal').classList.contains('hidden') && !document.querySelector('#appShell').inert && document.activeElement?.id === 'shortcutHelpBtn'`, '단축키 도움말을 닫은 뒤 초점이 복원되지 않았습니다.');

  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(win, `!document.querySelector('#quickPaletteModal').classList.contains('hidden') && document.activeElement?.id === 'quickPaletteInput'`, 'Meta+K가 빠른 이동 검색을 열지 못했습니다.');
  mark('quality:quick-search');
  await recordManifest(win);
  const quickContract = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#quickPaletteInput');
    const before = document.querySelectorAll('[data-quick-command]').length;
    input.value = '일치하지않는명령';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const empty = document.querySelectorAll('[data-quick-command]').length === 0 && document.querySelector('#quickPaletteStatus').textContent.length > 0;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    const endSelected = document.querySelector('[data-quick-command]:last-child')?.getAttribute('aria-selected') === 'true';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    return {
      before, empty, endSelected,
      activeDescendant: input.getAttribute('aria-activedescendant'),
      labelled: Boolean(input.getAttribute('aria-label')),
    };
  })()`);
  assert(quickContract.before >= 10 && quickContract.empty && quickContract.endSelected && quickContract.activeDescendant && quickContract.labelled, `빠른 이동 검색·키보드·ARIA 계약 실패: ${JSON.stringify(quickContract)}`);
  await recordExercise(win, '#quickPaletteInput');
  mark('quality:quick-keyboard');
  mark('quality:quick-empty');
  await click(win, '#closeQuickPaletteBtn', 'quality:quick-close');
  await waitFor(win, `document.querySelector('#quickPaletteModal').classList.contains('hidden')`, '빠른 이동 닫기 버튼이 동작하지 않았습니다.');

  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(win, `!document.querySelector('#quickPaletteModal').classList.contains('hidden')`, 'Ctrl+K가 빠른 이동 검색을 열지 못했습니다.');
  assert(!await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-quick-command="terminal"]'))`), '고급 작업창이 일반 빠른 이동에 노출되고 있습니다.');
  await click(win, '[data-quick-command="settings"]', 'quality:quick-command');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'settings' && document.querySelector('#quickPaletteModal').classList.contains('hidden')`, '빠른 이동 명령이 화면을 전환하지 못했습니다.');

  const storageContract = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    localStorage.setItem(app.DASHBOARD_STORAGE_KEY, JSON.stringify({ version: 2, search: '  fixture   task  ', providers: ['gpt'], workspace: 'D:\\\\fixture', sort: 'tokens' }));
    app.loadQualityState();
    const restored = { search: app.state.search, providers: [...app.state.providerFilters], workspace: app.state.workspace, sort: app.state.sort };
    localStorage.setItem(app.DASHBOARD_STORAGE_KEY, '{broken');
    app.loadQualityState();
    const recovered = { search: app.state.search, providers: app.state.providerFilters.size, workspace: app.state.workspace, sort: app.state.sort };
    app.saveDashboardPreferences();
    app.render();
    return { restored, recovered, stored: JSON.parse(localStorage.getItem(app.DASHBOARD_STORAGE_KEY)) };
  })()`);
  assert(storageContract.restored.search === 'fixture task' && storageContract.restored.providers[0] === 'gpt' && storageContract.restored.sort === 'tokens', `대시보드 저장 상태 복원 실패: ${JSON.stringify(storageContract)}`);
  assert(storageContract.recovered.search === '' && storageContract.recovered.providers === 0 && storageContract.recovered.workspace === 'all' && storageContract.recovered.sort === 'recent' && storageContract.stored.version === 2, `손상된 대시보드 저장값 복구 실패: ${JSON.stringify(storageContract)}`);
  mark('quality:dashboard-storage');

  await click(win, '[data-view="active"]', 'nav:active');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#searchInput');
    input.value = 'NO_RESULT_FOR_EMPTY_CLEAR';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, `!document.querySelector('#emptyClearFiltersBtn').classList.contains('hidden') && !document.querySelector('#emptyState').classList.contains('hidden')`, '빈 결과 조건 지우기 버튼이 표시되지 않았습니다.');
  await click(win, '#emptyClearFiltersBtn', 'filter:empty-clear');
  await waitFor(win, `window.LoadToAgentApp.state.search === '' && document.activeElement?.id === 'searchInput' && document.querySelector('#emptyClearFiltersBtn').classList.contains('hidden')`, '빈 결과 조건 지우기가 상태와 초점을 복원하지 못했습니다.');

  const memoryKeyboardTarget = await win.webContents.executeJavaScript(`(() => {
    const summary = document.querySelector('.memory-record-lineage > summary');
    const card = summary?.closest('[data-session-id]');
    if (!summary || !card) return null;
    summary.closest('details').open = false;
    document.querySelector('#detailDrawer')?.classList.remove('open');
    summary.focus();
    return card.dataset.sessionId;
  })()`);
  assert(memoryKeyboardTarget, '지난 작업의 작업 흐름 펼치기 키보드 검증 대상을 찾지 못했습니다.');
  const memorySummaryKeydown = await win.webContents.executeJavaScript(`(() => {
    const summary = document.querySelector('.memory-record-lineage > summary');
    const accepted = summary.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    return {
      accepted,
      drawerOpen: document.querySelector('#detailDrawer').classList.contains('open'),
      focused: document.activeElement === summary,
    };
  })()`);
  assert(memorySummaryKeydown.accepted && !memorySummaryKeydown.drawerOpen && memorySummaryKeydown.focused,
    `지난 작업의 작업 흐름 펼치기 키 입력이 바깥 작업 카드에 전달되었습니다: ${JSON.stringify(memorySummaryKeydown)}`);
  await win.webContents.executeJavaScript(`document.querySelector('.memory-record-lineage > summary')?.click()`);
  await waitFor(win, `document.querySelector('.memory-record-lineage')?.open
    && !document.querySelector('#detailDrawer').classList.contains('open')
    && document.activeElement?.matches('.memory-record-lineage > summary')`,
  '지난 작업의 작업 흐름 펼치기가 바깥 작업 카드를 열지 않고 독립적으로 동작하지 않았습니다.');
  await recordExercise(win, '.memory-record-lineage > summary');
  mark('quality:memory-lineage-keyboard');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.memory-record-lineage > summary')?.click();
    document.querySelector(${JSON.stringify(`[data-session-id="${memoryKeyboardTarget}"]`)})?.focus();
  })()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')`,
  '지난 작업 카드 자체의 Enter 열기 동작이 유지되지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close-memory-keyboard');

  const semanticContracts = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const resultSummary = document.querySelector('#sessionResultSummary').textContent;
    const historyResultCount = app.filteredSessions().length;
    return {
      navControls: [...document.querySelectorAll('.nav-item[data-view]')].every(button => button.hasAttribute('aria-controls')),
      providerControls: document.querySelector('#probeBtn').getAttribute('aria-controls') === 'providerRail',
      workspaceControls: document.querySelector('#addWorkspaceBtn').getAttribute('aria-controls') === 'workspaceList',
      filterToolbar: document.querySelector('#providerFilter').getAttribute('role') === 'toolbar',
      filterTabStops: document.querySelectorAll('#providerFilter [tabindex="0"]').length,
      overviewTabStops: document.querySelectorAll('#providerOverview [tabindex="0"]').length,
      resultSummary,
      resultSummaryCount: Number(resultSummary.match(/\\d+/)?.[0] || -1),
      historyResultCount,
      historyCardCount: document.querySelectorAll('#sessionGrid [data-session-id]').length,
      visibleLimit: app.state.visibleLimit,
    };
  })()`);
  assert(semanticContracts.navControls && semanticContracts.providerControls && semanticContracts.workspaceControls && semanticContracts.filterToolbar
    && semanticContracts.filterTabStops === 1 && semanticContracts.overviewTabStops === 1 && semanticContracts.resultSummary
    && semanticContracts.resultSummaryCount === semanticContracts.historyCardCount
    && semanticContracts.historyCardCount === Math.min(semanticContracts.historyResultCount, semanticContracts.visibleLimit),
  `전역·필터 의미 계약 실패 또는 다른 세션 개수 불일치: ${JSON.stringify(semanticContracts)}`);
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.workspace = app.state.workspaces[0]?.path || 'all';
    app.saveDashboardPreferences();
    app.render();
    return app.state.workspace;
  })()`);
  round.observed.quality = { quickCommands: quickContract.before, persistence: true, semanticContracts: true };
}

async function exerciseTabDataRouting(win, round) {
  const expectations = {
    all: '',
    active: '',
    waiting: '',
    runtime: 'automationOverview',
    terminal: 'terminalSection',
    tmux: 'tmuxSection',
    settings: 'settingsSection',
  };
  const report = {};
  for (const [view, expectedTool] of Object.entries(expectations)) {
    await click(win, `[data-view="${view}"]`, `nav:${view}`);
    await waitFor(win, `window.LoadToAgentApp.state.view === ${JSON.stringify(view)}`, `${view} 탭 데이터 격리 준비 실패`);
    report[view] = await win.webContents.executeJavaScript(`(() => {
      const toolIds = ['automationOverview', 'terminalSection', 'tmuxSection', 'settingsSection'];
      const visibleTools = toolIds.filter(id => !document.querySelector('#' + id)?.classList.contains('hidden'));
      return {
        visibleTools,
        workspaceVisible: Boolean(document.querySelector('#controlRoomProjectToolbar')
          && !document.querySelector('#liveSection')?.classList.contains('hidden')
          && getComputedStyle(document.querySelector('#controlRoomProjectToolbar')).display !== 'none'),
        historySectionVisible: !document.querySelector('#sessionSection')?.classList.contains('hidden'),
        attentionInboxVisible: !document.querySelector('#attentionInbox')?.classList.contains('hidden'),
        activeEmptyVisible: !document.querySelector('#activeEmptyState')?.classList.contains('hidden'),
        liveTmuxCards: document.querySelectorAll('.live-tmux-card').length,
        tmuxProjectChip: Boolean([...document.querySelectorAll('#workspaceList [data-workspace]')]
          .find(node => node.dataset.workspace === '/mnt/c/Users/fixture/tmux-only-project')),
        tmuxProjectGroup: Boolean(document.querySelector('[data-control-project="관련 작업 모음"] .live-tmux-card')),
        tmuxCommandsOutsideTmux: [...document.querySelectorAll('[data-tmux-manage], [data-control-tmux]')].some(node => !node.closest('#tmuxSection') && !node.closest('#terminalSection')),
      };
    })()`);
    const actual = report[view];
    const expected = expectedTool ? [expectedTool] : [];
    assert(JSON.stringify(actual.visibleTools) === JSON.stringify(expected), `${view} 탭의 전용 데이터 섹션이 섞였습니다: ${JSON.stringify(actual)}`);
    if (['runtime', 'terminal', 'tmux', 'settings'].includes(view)) assert(!actual.workspaceVisible, `${view} 탭에 동작하지 않는 작업공간 필터가 표시됩니다.`);
    if (view === 'active') assert(actual.historySectionVisible && !actual.activeEmptyVisible, '기억 탭이 인과 기록 영역을 표시하지 못했습니다.');
    if (view === 'all') assert(!actual.historySectionVisible && !actual.attentionInboxVisible, '지금 탭에 기억 또는 판단 영역이 섞였습니다.');
    if (view === 'waiting') assert(!actual.historySectionVisible && actual.attentionInboxVisible, '내 확인 필요 탭이 전용 확인함을 표시하지 못했습니다.');
    if (view === 'all') assert(actual.liveTmuxCards === 0 && actual.tmuxProjectChip
      && !actual.tmuxProjectGroup && !actual.tmuxCommandsOutsideTmux,
    `${view} 탭이 연결되지 않은 AI tmux 프로젝트를 선택 항목으로만 안전하게 투영하지 못했습니다: ${JSON.stringify(actual)}`);
    if (view === 'active') assert(!actual.workspaceVisible && actual.historySectionVisible,
      `기억 탭에 살아 있는 tmux 흐름이나 지금 전용 프로젝트 도구가 섞였습니다: ${JSON.stringify(actual)}`);
  }
  await click(win, '[data-view="active"]', 'nav:active');
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.search = '__NO_ACTIVE_FIXTURE__';
    document.querySelector('#searchInput').value = app.state.search;
    app.renderSessions('filter');
  })()`);
  await waitFor(win, `!document.querySelector('#sessionSection').classList.contains('hidden') && document.querySelector('#liveSection').classList.contains('hidden') && !document.querySelector('#emptyState').classList.contains('hidden')`, '기억 검색 결과가 없을 때 기억 전용 빈 상태를 표시하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.search = '';
    document.querySelector('#searchInput').value = '';
    app.renderSessions('filter');
  })()`);
  await click(win, '[data-view="all"]', 'nav:all');
  round.observed.tabDataRouting = report;
}

async function exerciseGuideAndMobileTools(win, round) {
  const toggleGuide = async action => {
    const toggled = await win.webContents.executeJavaScript(`(() => {
      const app = window.LoadToAgentApp;
      if (app.state.workspace === 'all') {
        app.state.workspace = app.state.workspaces[0]?.path || 'all';
        app.saveDashboardPreferences();
        app.render();
      }
      const button = document.querySelector('#guideBtn');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert(toggled, '숨은 시작 가이드 디스패처를 실행하지 못했습니다.');
    mark(action);
  };
  await click(win, '[data-view="all"]', 'nav:all');
  if (await win.webContents.executeJavaScript(`document.querySelector('#beginnerGuide').classList.contains('hidden')`)) {
    await click(win, '[data-view="settings"]', 'nav:settings');
    await toggleGuide('guide:toggle');
    await waitFor(win, `!document.querySelector('#beginnerGuide').classList.contains('hidden')`, '시작 가이드 열기 실패');
  }
  await click(win, '#dismissGuideBtn', 'guide:dismiss');
  await waitFor(win, `document.querySelector('#beginnerGuide').classList.contains('hidden')`, '시작 가이드 접기 실패');
  await win.webContents.executeJavaScript(`(() => {
    const stage = document.querySelector('.main-stage');
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 320, bubbles: true, cancelable: true }));
    stage.scrollTop = Math.min(stage.scrollHeight - stage.clientHeight, stage.scrollTop + 320);
    window.LoadToAgentApp.renderSessions('refresh');
  })()`);
  await sleep(350);
  assert(
    await win.webContents.executeJavaScript(`(() => {
      const saved = JSON.parse(localStorage.getItem('loadtoagent:start-guide:v1') || '{}');
      return window.LoadToAgentApp.state.guideExpanded === false
        && saved.expanded === false
        && document.querySelector('#beginnerGuide').classList.contains('hidden');
    })()`),
    '접은 시작 가이드가 휠 스크롤 뒤 다시 열렸습니다.',
  );
  mark('guide:wheel-closed');
  await click(win, '[data-view="settings"]', 'nav:settings');
  await toggleGuide('guide:toggle');
  await waitFor(win, `!document.querySelector('#beginnerGuide').classList.contains('hidden')`, '시작 가이드 다시 열기 실패');

  await click(win, '[data-guide-action="create"]', 'guide:create');
  await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden') && document.activeElement?.id === 'runPrompt'`, '가이드 새 작업 단계가 실제 실행 창을 열지 못했습니다.');
  await click(win, '#cancelRunBtn', 'run:cancel-guide');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, '가이드 새 작업 창을 닫지 못했습니다.');

  await click(win, '[data-guide-action="active"]', 'guide:active');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'active' && document.querySelector('[data-guide-step="active"]').classList.contains('completed')`, '가이드 단계가 화면 이동과 완료 상태를 반영하지 않았습니다.');
  await click(win, '[data-view="settings"]', 'nav:settings');
  await toggleGuide('guide:toggle');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'all' && !document.querySelector('#beginnerGuide').classList.contains('hidden')`, '진행 중 가이드 단계 뒤 가이드로 돌아오지 못했습니다.');
  await click(win, '[data-guide-action="waiting"]', 'guide:waiting');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'waiting' && document.querySelector('[data-guide-step="waiting"]').classList.contains('completed')`, '가이드 확인할 일 단계가 화면 이동과 완료 상태를 반영하지 않았습니다.');
  await click(win, '[data-view="settings"]', 'nav:settings');
  await toggleGuide('guide:toggle');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'all' && !document.querySelector('#beginnerGuide').classList.contains('hidden')`, '확인할 일 가이드 단계 뒤 가이드로 돌아오지 못했습니다.');
  await click(win, '[data-guide-action="detail"]', 'guide:detail');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && document.querySelector('[data-guide-step="detail"]').classList.contains('completed')`, '가이드 상세 단계가 실제 작업 상세와 완료 상태를 반영하지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close-guide');
  await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, '가이드가 연 작업 상세를 닫지 못했습니다.');

  win.setSize(480, 720);
  await waitFor(win, `document.querySelector('#mobileMoreBtn').getClientRects().length > 0 && getComputedStyle(document.querySelector('#mobileMoreBtn')).display !== 'none'`, '모바일 내비게이션 레이아웃 전환 실패');
  await click(win, '#mobileMoreBtn', 'mobile:more');
  await click(win, '.mobile-project-picker > summary', 'mobile:project-picker');
  await waitFor(win, `document.querySelector('.mobile-project-picker').open`, '모바일 프로젝트 선택 summary가 열리지 않았습니다.');
  await clearCalls(win);
  await click(win, '#mobileAddWorkspaceBtn', 'workspace:add');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'addWorkspaces')
    && window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'
    && document.querySelector('#runModal').classList.contains('hidden')`, '모바일 프로젝트 추가가 선택한 작업 폴더로 이동하지 못했습니다.');
  if (!await win.webContents.executeJavaScript(`document.querySelector('#mobileToolsMenu').classList.contains('hidden')`)) {
    await click(win, '#mobileToolsCloseBtn', 'mobile:close');
  }

  await click(win, '#mobileMoreBtn', 'mobile:more');
  await waitFor(win, `!document.querySelector('#mobileToolsMenu').classList.contains('hidden')
    && document.querySelector('#mobileToolsMenu').getAttribute('role') === 'dialog'
    && document.querySelector('#mobileToolsMenu').getAttribute('aria-modal') === 'true'
    && document.querySelector('#mobileToolsMenu').getAttribute('aria-hidden') === 'false'
    && !document.querySelector('#mobileToolsMenu').inert
    && document.querySelector('#appShell').inert`, '모바일 더보기 메뉴의 모달 상태와 배경 차단 실패');
  const viewBeforeMobileShortcutGuard = await win.webContents.executeJavaScript(`window.LoadToAgentApp.state.view`);
  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', metaKey: true, bubbles: true, cancelable: true }))`);
  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(win, `window.LoadToAgentApp.state.view === ${JSON.stringify(viewBeforeMobileShortcutGuard)}
    && !document.querySelector('#mobileToolsMenu').classList.contains('hidden')
    && document.querySelector('#runModal').classList.contains('hidden')
    && document.querySelector('#appShell').inert`, '모바일 더보기에서 전역 화면·새 작업 단축키가 차단되지 않았습니다.');
  mark('mobile:shortcut-guard');
  const mobileFocusTrap = await win.webContents.executeJavaScript(`(() => {
    const menu = document.querySelector('#mobileToolsMenu');
    const buttons = [...menu.querySelectorAll('button:not([disabled])')].filter(button => button.getClientRects().length);
    const first = buttons[0];
    const last = buttons.at(-1);
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const forward = document.activeElement === first;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    return { forward, backward: document.activeElement === last };
  })()`);
  assert(mobileFocusTrap.forward && mobileFocusTrap.backward, `모바일 더보기의 Tab 포커스 순환 실패: ${JSON.stringify(mobileFocusTrap)}`);
  mark('mobile:focus-trap');
  await click(win, '#mobileToolsCloseBtn', 'mobile:close');
  await waitFor(win, `document.querySelector('#mobileToolsMenu').classList.contains('hidden')
    && document.querySelector('#mobileToolsMenu').getAttribute('aria-hidden') === 'true'
    && document.querySelector('#mobileToolsMenu').inert
    && !document.querySelector('#appShell').inert
    && document.activeElement?.id === 'mobileMoreBtn'`, '모바일 더보기의 명시적 닫기 버튼과 포커스 복원 실패');
  await click(win, '#mobileMoreBtn', 'mobile:more');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#mobileToolsMenu button')?.focus({ preventScroll: true });
    window.LoadToAgentApp.selectView('active');
  })()`);
  await waitFor(win, `document.querySelector('#mobileToolsMenu').classList.contains('hidden')
    && !document.querySelector('#appShell').inert
    && document.activeElement?.id === 'mainContent'
    && !window.LoadToAgentApp.motionState.focusScopes.some(scope => scope.surface === 'mobileToolsMenu')`,
  '외부 화면 전환으로 모바일 메뉴가 닫힐 때 숨은 메뉴의 초점 또는 포커스 스코프가 남았습니다.');
  mark('mobile:external-view-focus-cleanup');
  await click(win, '#mobileMoreBtn', 'mobile:more');
  await win.webContents.executeJavaScript(`(() => { const first = document.querySelector('#mobileToolsMenu button'); first.focus(); first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); })()`);
  await waitFor(win, `document.activeElement?.dataset.mobileView === 'settings'`, '모바일 더보기 메뉴 End 키 이동 실패');
  mark('mobile:keyboard-roaming');
  await win.webContents.executeJavaScript(`document.querySelector('#mainContent').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await waitFor(win, `document.querySelector('#mobileToolsMenu').classList.contains('hidden') && document.querySelector('#mobileMoreBtn').getAttribute('aria-expanded') === 'false' && document.activeElement?.id === 'mobileMoreBtn'`, '모바일 더보기 메뉴 바깥 클릭 닫기와 포커스 복원 실패');
  mark('mobile:outside-dismiss');
  for (const view of ['runtime', 'tmux', 'settings']) {
    await click(win, '#mobileMoreBtn', 'mobile:more');
    await click(win, `[data-mobile-view="${view}"]`, `mobile:view-${view}`);
    await waitFor(win, `window.LoadToAgentApp.state.view === ${JSON.stringify(view)} && document.querySelector('#mobileToolsMenu').classList.contains('hidden')`, `모바일 더보기에서 ${view} 이동 실패`, view === 'terminal' ? 120 : 80);
  }
  win.setSize(1440, 940);
  await waitFor(win, `window.innerWidth > 1280
    && document.querySelector('#advancedToolsNav > summary').getClientRects().length > 0
    && getComputedStyle(document.querySelector('#advancedToolsNav > summary')).display !== 'none'
    && document.querySelector('#mobileMoreBtn').getClientRects().length === 0`,
  '데스크톱 내비게이션 레이아웃 복원 실패');
  await click(win, '[data-view="all"]', 'nav:all');
  round.observed.guide = { persisted: true, mobileTools: true };
}

async function exerciseUpdates(win, round) {
  await win.webContents.executeJavaScript('window.interactionTest.restoreCurrentUpdate()');
  await click(win, '[data-view="settings"]', 'nav:settings');
  await waitFor(win, `window.LoadToAgentApp.state.update.status === 'current' && document.querySelector('#currentVersion').textContent === '1.5.1' && document.querySelector('#sidebarAppVersion').textContent === '1.5.1' && document.querySelector('#updateStateTitle').textContent === '현재 최신 버전입니다.' && document.querySelector('#checkUpdateBtn').textContent.includes('업데이트 다시 확인')`, '현재 버전과 최신 상태가 설정 화면에 명확히 표시되지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ delays: { checkForUpdate: 160 } })`);
  await click(win, '#checkUpdateBtn', 'update:check');
  await win.webContents.executeJavaScript(`document.querySelector('#checkUpdateBtn').click()`);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'checkForUpdate') && window.LoadToAgentApp.state.update.status === 'available'`, '업데이트 확인 버튼이 최신 릴리스를 확인하지 않았습니다.');
  assert(await callCount(win, 'checkForUpdate') === 1, '업데이트 확인 연속 클릭이 중복 요청을 만들었습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await click(win, '[data-view="all"]', 'nav:all');
  await waitFor(win, `window.LoadToAgentApp.state.update.status === 'available'
    && getComputedStyle(document.querySelector('#updateNotice')).display === 'none'
    && !document.querySelector('#navUpdateBadge').classList.contains('hidden')
    && (() => {
      const settings = document.querySelector('#sidebarSettingsBtn');
      const badge = document.querySelector('#navUpdateBadge');
      const style = getComputedStyle(badge);
      const rect = badge.getBoundingClientRect();
      return settings.getClientRects().length > 0
        && badge.getClientRects().length > 0
        && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0
        && settings.getAttribute('aria-label').includes('1.5.2')
        && settings.getAttribute('title').includes('1.5.2')
        && !document.querySelector('#advancedToolsNav [data-view="settings"]')
        && !document.querySelector('#advancedToolsNav > summary').getAttribute('aria-label').includes('1.5.2');
    })()`,
  'AI 목록 위 설정 버튼에 새 버전 배지와 최신 버전 접근성 상태가 표시되지 않았습니다.');
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.selectView('terminal', { focusMain: true })`);
  await waitFor(win, `window.LoadToAgentApp.state.view === 'terminal'
    && document.querySelector('#sidebarSettingsBtn').getAttribute('aria-label').includes('1.5.2')
    && document.querySelector('#sidebarSettingsBtn').getAttribute('title').includes('1.5.2')
    && !document.querySelector('#advancedToolsNav > summary').getAttribute('aria-label').includes('1.5.2')`,
  '터미널 렌더링 뒤 설정 버튼의 업데이트 상태가 유지되지 않았습니다.', 120);
  await click(win, '#backToProjectsBtn', 'nav:back-to-projects');
  win.setSize(1224, 820);
  await waitFor(win, `window.innerWidth === 1224`, '1224px 반응형 검증 폭이 적용되지 않았습니다.');
  const compactUpdateNavigation = await win.webContents.executeJavaScript(`(() => {
    const settings = document.querySelector('#sidebarSettingsBtn');
    const label = settings.querySelector(':scope > span:nth-child(2)');
    const badge = document.querySelector('#navUpdateBadge');
    const settingsStyle = getComputedStyle(settings);
    const badgeStyle = getComputedStyle(badge);
    const badgeRect = badge.getBoundingClientRect();
    return {
      settingsVisible: settings.getClientRects().length > 0
        && settingsStyle.display !== 'none' && settingsStyle.visibility === 'visible',
      label: label.textContent.trim(),
      labelClientWidth: label.clientWidth,
      labelScrollWidth: label.scrollWidth,
      badgeText: badge.textContent.trim(),
      badgeVisible: badge.getClientRects().length > 0
        && badgeRect.width > 0 && badgeRect.height > 0
        && badgeStyle.display !== 'none' && badgeStyle.visibility === 'visible',
    };
  })()`);
  assert(
    compactUpdateNavigation.settingsVisible
      && compactUpdateNavigation.label.length > 0
      && compactUpdateNavigation.labelScrollWidth <= compactUpdateNavigation.labelClientWidth
      && compactUpdateNavigation.badgeText.includes('업데이트')
      && compactUpdateNavigation.badgeVisible,
    `1224px 폭에서 설정 라벨 또는 업데이트 배지가 잘렸습니다: ${JSON.stringify(compactUpdateNavigation)}`,
  );
  win.setSize(480, 820);
  await waitFor(win, `(() => {
    const button = document.querySelector('#mobileMoreBtn');
    const indicator = document.querySelector('#mobileMoreUpdateIndicator');
    const style = getComputedStyle(indicator);
    const rect = indicator.getBoundingClientRect();
    return button.getClientRects().length > 0
      && indicator.getClientRects().length > 0
      && rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0
      && button.getAttribute('aria-label').includes('1.5.2')
      && button.getAttribute('title').includes('1.5.2');
  })()`, '모바일 추가 기능 버튼에 새 버전 표시와 최신 버전 접근성 상태가 보이지 않았습니다.');
  win.setSize(1440, 940);
  await waitFor(win, `document.querySelector('#navUpdateBadge').getClientRects().length > 0
    && getComputedStyle(document.querySelector('#navUpdateBadge')).display !== 'none'`,
  '데스크톱 업데이트 배지가 화면 크기 복원 뒤 다시 보이지 않았습니다.');
  await click(win, '[data-view="settings"]', 'nav:settings');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'settings' && !document.querySelector('#settingsSection').classList.contains('hidden') && document.querySelector('#latestVersion').textContent === '1.5.2'`, '업데이트 알림이 설정 화면을 열지 못했습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ delays: { installDownloadedUpdate: 160 } })`);
  await click(win, '#installUpdateBtn', 'update:download');
  await win.webContents.executeJavaScript(`document.querySelector('#installUpdateBtn').click()`);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'installDownloadedUpdate') && window.LoadToAgentApp.state.update.status === 'downloaded'`, '원클릭 업데이트 설치가 호출되지 않았습니다.');
  assert(await callCount(win, 'installDownloadedUpdate') === 1, '업데이트 설치 연속 클릭이 중복 요청을 만들었습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await click(win, '[data-view="all"]', 'nav:all');
  round.observed.update = { available: true, downloaded: true, automaticInstallStarted: true };
}

async function exerciseAttentionNotification(win, round) {
  await win.webContents.executeJavaScript(`window.interactionTest.triggerAttention('fixture-waiting')`);
  await waitFor(win, `window.LoadToAgentApp.state.view === 'waiting' && window.LoadToAgentApp.state.selectedId === 'fixture-waiting' && document.querySelector('#detailDrawer').classList.contains('open')`, '확인 필요 알림을 눌렀을 때 해당 세션이 열리지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, '확인 필요 알림 상세 창을 닫지 못했습니다.');
  await click(win, '[data-view="all"]', 'nav:all');
  round.observed.attentionNotification = { openedWaitingView: true, openedSession: 'fixture-waiting' };
}

async function exerciseProviderUsage(win, round) {
  await prepareProjectFirstStep(win, 'all');
  await click(win, '[data-view="all"]', 'nav:all');
  await waitFor(win, `(() => {
    const overview = document.querySelector('#sessionTokenOverview');
    const bounds = overview?.getBoundingClientRect();
    return Boolean(overview && bounds?.width > 0 && bounds?.height > 0
      && overview.querySelector('[data-token-provider]'));
  })()`, '상단 AI별 사용량 요약을 찾지 못했습니다.');
  const detail = await win.webContents.executeJavaScript(`(() => {
    const overview = document.querySelector('#sessionTokenOverview');
    return {
      cards: overview?.querySelectorAll('[data-token-provider]').length || 0,
      gauges: overview?.querySelectorAll('[role="progressbar"]').length || 0,
      used: [...(overview?.querySelectorAll('.session-token-detail') || [])].map(node => node.textContent.trim()),
      noOverflow: Boolean(overview && overview.scrollWidth <= overview.clientWidth + 2),
      duplicateDisclosure: Boolean(document.querySelector('.provider-usage-disclosure')),
      duplicateRefresh: Boolean(document.querySelector('[data-provider-usage-refresh]')),
    };
  })()`);
  assert(detail.cards >= 1 && detail.gauges >= 1
    && detail.used.some(label => label.includes('사용')) && detail.noOverflow
    && !detail.duplicateDisclosure && !detail.duplicateRefresh,
  `상단 AI별 사용량 단일 표시가 올바르지 않습니다: ${JSON.stringify(detail)}`);
  round.observed.providerUsage = { ...detail, presentation: 'topbar-only' };
}

async function exerciseManagementControls(win, round) {
  await prepareProjectFirstStep(win);
  await click(win, '[data-view="all"]', 'nav:all');
  await waitFor(win, `Boolean(document.querySelector('[data-home-attention]'))
    && Boolean(document.querySelector('[data-control-room-overview]'))
    && Boolean(document.querySelector('.control-room-project-group'))`,
  '선택한 프로젝트 홈의 판단 요약과 에이전트 실행 구조가 표시되지 않았습니다.');
  const recencyContract = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const now = Date.parse('2026-07-22T12:00:00.000Z');
    const base = { id: 'recency-check', status: 'idle', health: { level: 'unknown', signals: [] }, attention: { required: false, kind: 'none' } };
    const recent = { ...base, updatedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString() };
    const old = { ...base, updatedAt: new Date(now - 24 * 60 * 60 * 1000 - 1).toISOString() };
    const runningOld = { ...old, status: 'running' };
    const recentFailed = { ...recent, status: 'failed', health: { level: 'critical', signals: [{ code: 'run-failed' }] } };
    const oldFailed = { ...recentFailed, updatedAt: old.updatedAt };
    const recentResponse = { ...recent, status: 'waiting', attention: { required: true, kind: 'response' }, health: { level: 'healthy', signals: [] } };
    const recentOptional = { ...recent, attention: { category: 'optional', required: false, actionable: false, kind: 'optional' } };
    const freshSignal = new Date(now - 30 * 1000).toISOString();
    const staleSignal = new Date(now - 7 * 60 * 60 * 1000).toISOString();
    return {
      boundaryIncluded: app.isRecentSession(recent, now),
      expiredExcluded: !app.isRecentSession(old, now),
      activeAlwaysVisible: app.isRecentSession(runningOld, now),
      uncertainNotReview: !app.needsManagementReview(recent, now),
      recentRiskReview: app.needsManagementReview(recentFailed, now),
      oldRiskExcluded: !app.needsManagementReview(oldFailed, now),
      recentResponseReview: app.needsManagementReview(recentResponse, now),
      optionalInInbox: app.needsManagementInbox(recentOptional, now),
      optionalNotActionable: !app.needsManagementReview(recentOptional, now),
      todayCompletedVisible: app.filteredSessions().some(session => session.id === 'fixture-ended'),
      freshOperationOutranksStaleRunning: app.supervisionFreshnessScore(freshSignal, now) > app.supervisionFreshnessScore(staleSignal, now),
      missingOperationRanksBelowStale: app.supervisionFreshnessScore(null, now) < app.supervisionFreshnessScore(staleSignal, now),
    };
  })()`);
  assert(Object.values(recencyContract).every(Boolean), `24시간 세션·확인 항목 경계가 올바르지 않습니다: ${JSON.stringify(recencyContract)}`);
  const fixedOrderContract = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const savedOrder = [...app.state.sessionOrder];
    app.state.sessionOrder = ['fixed-a', 'fixed-b'];
    const a = { id: 'fixed-a', updatedAt: '2026-07-22T00:00:00.000Z' };
    const b = { id: 'fixed-b', updatedAt: '2026-07-22T01:00:00.000Z' };
    const initial = app.stableSessionSort([b, a]).map(session => session.id).join(',');
    a.updatedAt = '2026-07-23T00:00:00.000Z';
    const afterActivity = app.stableSessionSort([a, b]).map(session => session.id).join(',');
    const moved = app.moveSessionOrder('fixed-b', 'fixed-a');
    const afterMove = app.stableSessionSort([a, b]).map(session => session.id).join(',');
    app.state.sessionOrder = savedOrder;
    return { initial, afterActivity, moved, afterMove };
  })()`);
  assert(fixedOrderContract.initial === 'fixed-a,fixed-b'
    && fixedOrderContract.afterActivity === 'fixed-a,fixed-b'
    && fixedOrderContract.moved
    && fixedOrderContract.afterMove === 'fixed-b,fixed-a',
  `세션 고정 순서 계약이 올바르지 않습니다: ${JSON.stringify(fixedOrderContract)}`);
  const managementScope = await win.webContents.executeJavaScript(`(() => ({
    total: window.LoadToAgentApp.graphFilteredSessions().length,
    critical: window.LoadToAgentApp.graphFilteredSessions().filter(session => window.LoadToAgentApp.matchesManagementFilter(session, 'critical')).length,
    warning: window.LoadToAgentApp.graphFilteredSessions().filter(session => window.LoadToAgentApp.matchesManagementFilter(session, 'warning')).length,
    attention: window.LoadToAgentApp.graphFilteredSessions().filter(session => window.LoadToAgentApp.matchesManagementFilter(session, 'attention')).length,
    optional: window.LoadToAgentApp.graphFilteredSessions().filter(session => window.LoadToAgentApp.matchesManagementFilter(session, 'optional')).length,
    clear: window.LoadToAgentApp.graphFilteredSessions().filter(session => !window.LoadToAgentApp.needsManagementReview(session)).length,
    inboxExpected: window.LoadToAgentApp.graphFilteredSessions().filter(session => window.LoadToAgentApp.needsManagementInbox(session)).length,
    reviewExpected: window.LoadToAgentApp.graphFilteredSessions().filter(session => window.LoadToAgentApp.needsManagementReview(session)).length,
    rootReviewExpected: window.LoadToAgentApp.rootManagementReviews(window.LoadToAgentApp.graphFilteredSessions()).length,
    homeAttentionVisible: Boolean(document.querySelector('[data-home-attention]'))
      && document.querySelectorAll('.home-attention-item').length > 0,
    homeAttentionCount: Number(document.body.dataset.homeAttentionCount || 0),
    topbarUsageVisible: Boolean(document.querySelector('#sessionTokenOverview [data-token-provider]')),
    duplicateProviderUsage: Boolean(document.querySelector('.provider-usage-disclosure, [data-provider-usage-refresh]')),
    childCopyLeaked: document.querySelector('#operationsOverview')?.innerText.includes('서브에이전트 내부 확인 문구'),
    controlRooms: document.querySelectorAll('[data-control-session]').length,
    rootMain: Boolean(document.querySelector('[data-control-session="fixture-root"] .control-room-main')),
    rootAttention: Boolean(document.querySelector('.control-room-session.has-attention[data-attention-count]:not([data-attention-count="0"])')),
    projectAttention: Boolean(document.querySelector('.control-room-project-group.has-attention[data-attention-count]:not([data-attention-count="0"])')),
    rootHelpers: document.querySelectorAll('[data-control-session="fixture-root"] .helper-node').length,
    rootExecutions: document.querySelectorAll('[data-control-session="fixture-root"] .execution-node').length,
    rootCompleted: document.querySelectorAll('[data-control-session="fixture-root"] .completed-list .control-room-node').length,
    flowVisibleWithoutFocus: window.LoadToAgentApp.state.graphFocusId === null && Boolean(document.querySelector('[data-control-room-overview]')),
  }))()`);
  assert(managementScope.critical + managementScope.warning + managementScope.attention + managementScope.optional <= managementScope.total, `확인 항목 분류가 서로 중복 집계됩니다: ${JSON.stringify(managementScope)}`);
  assert(managementScope.homeAttentionVisible
    && managementScope.homeAttentionCount === managementScope.inboxExpected
    && managementScope.topbarUsageVisible && !managementScope.duplicateProviderUsage && !managementScope.childCopyLeaked,
  `홈의 판단 우선 정보 위계 또는 상단 단일 사용량 표시가 올바르지 않습니다: ${JSON.stringify(managementScope)}`);
  assert(managementScope.homeAttentionVisible && managementScope.reviewExpected >= 1 && managementScope.rootReviewExpected >= 1,
    `확인이 필요한 작업을 첫 화면에서 찾을 수 없습니다: ${JSON.stringify(managementScope)}`);
  assert(managementScope.controlRooms >= 1 && managementScope.rootMain && managementScope.rootHelpers >= 1
    && managementScope.rootExecutions >= 1 && managementScope.rootCompleted >= 1 && managementScope.flowVisibleWithoutFocus,
    `클릭 전 메인·서브에이전트·실행 명령·완료 흐름이 보이지 않습니다: ${JSON.stringify(managementScope)}`);

  const controlOrderBefore = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#liveSessionGrid [data-control-session]'), node => node.dataset.controlSession)`);
  assert(controlOrderBefore.length >= 2, '세션 위치 변경을 검증할 실행 중 세션이 부족합니다.');
  const controlDrag = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#liveSessionGrid [data-control-session][data-session-sortable]')];
    const source = items[1];
    const target = items[0];
    if (!source || !target || !source.draggable) return { ok: false, reason: 'draggable live sessions missing' };
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const bounds = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + 1, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + 1, dataTransfer: transfer }));
    const after = [...document.querySelectorAll('#liveSessionGrid [data-control-session]')].map(node => node.dataset.controlSession);
    const saved = JSON.parse(localStorage.getItem('loadtoagent:dashboard-preferences:v2') || '{}').sessionOrder || [];
    const rooms = document.querySelectorAll('#liveSessionGrid [data-control-session]').length;
    const handles = document.querySelectorAll('#liveSessionGrid [data-control-session] .session-drag-handle').length;
    const grid = document.querySelector('#liveSessionGrid');
    return { ok: after[0] === source.dataset.controlSession && saved.indexOf(after[0]) < saved.indexOf(after[1]), after, rooms, handles, noHorizontalOverflow: grid.scrollWidth <= grid.clientWidth + 2, arrowButtons: document.querySelectorAll('[data-session-order-move]').length };
  })()`);
  assert(controlDrag.ok && controlDrag.rooms === controlDrag.handles && controlDrag.noHorizontalOverflow && controlDrag.arrowButtons === 0, `실행 중 세션 드래그 위치 변경 실패: ${JSON.stringify(controlDrag)}`);
  mark('session:reorder-drag');
  await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#liveSessionGrid [data-control-session][data-session-sortable]')];
    const source = items[0];
    const target = items[1];
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const bounds = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: bounds.left + bounds.width / 2, clientY: bounds.bottom - 1, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: bounds.left + bounds.width / 2, clientY: bounds.bottom - 1, dataTransfer: transfer }));
  })()`);
  await waitFor(win, `Array.from(document.querySelectorAll('#liveSessionGrid [data-control-session]'), node => node.dataset.controlSession).join(',') === ${JSON.stringify(controlOrderBefore.join(','))}`, '실행 중 세션 드래그로 원래 순서를 복원하지 못했습니다.');
  await click(win, '[data-view="active"]', 'nav:active');
  const historyDrag = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#sessionGrid [data-session-id][data-session-sortable]')];
    const source = items[1];
    const target = items[0];
    if (!source || !target || !source.draggable) return { ok: false, reason: 'draggable history sessions missing' };
    const before = items.map(node => node.dataset.sessionId);
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const bounds = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: bounds.left + 1, clientY: bounds.top + 1, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: bounds.left + 1, clientY: bounds.top + 1, dataTransfer: transfer }));
    const after = [...document.querySelectorAll('#sessionGrid [data-session-id]')].map(node => node.dataset.sessionId);
    const cards = document.querySelectorAll('#sessionGrid [data-session-id]').length;
    const handles = document.querySelectorAll('#sessionGrid [data-session-id] .session-drag-handle').length;
    const grid = document.querySelector('#sessionGrid');
    return {
      ok: after.join(',') !== before.join(',') && after.indexOf(before[1]) !== 1,
      before,
      after,
      cards,
      handles,
      noHorizontalOverflow: grid.scrollWidth <= grid.clientWidth + 2,
    };
  })()`);
  assert(historyDrag.ok && historyDrag.cards === historyDrag.handles && historyDrag.noHorizontalOverflow, `최근 세션 카드 드래그 위치 변경 실패: ${JSON.stringify(historyDrag)}`);
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const visibleOrder = ${JSON.stringify(historyDrag.before)};
    const visibleIds = new Set(visibleOrder);
    app.state.sessionOrder = [...visibleOrder, ...app.state.sessionOrder.filter(id => !visibleIds.has(id))];
    app.saveDashboardPreferences();
    app.renderSessions('reorder');
  })()`);
  await waitFor(win, `Array.from(document.querySelectorAll('#sessionGrid [data-session-id]'), node => node.dataset.sessionId).join(',') === ${JSON.stringify(historyDrag.before.join(','))}`, '최근 세션 카드 드래그로 원래 순서를 복원하지 못했습니다.');
  round.observed.fixedSessionOrder = { activityDoesNotReorder: true, liveDrag: true, historyDrag: true, arrowsRemoved: true };

  await click(win, '[data-view="all"]', 'nav:all');
  await click(win, '[data-open-subagent-chat="fixture-child"]', 'control-room:open-subagent');
  await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open')
    && document.querySelector('#detailDrawer')?.dataset.mode === 'subagent'
    && document.querySelector('[data-subagent-work-messages="2"]')
    && document.querySelector('#drawerContent')?.innerText.includes('실행 구조, 대화 기록, 직접 개입과 메인 에이전트 경유 개입')
    && !document.querySelector('.subagent-assignment-card')
    && document.querySelector('#drawerComposer')?.classList.contains('hidden')
    && document.querySelectorAll('#detailDrawer [data-agent-command-route]').length === 0
    && !document.querySelector('#drawerComposer [data-agent-command-form="fixture-child"]')
    && !document.querySelector('#drawerContent')?.innerText.includes('실제로 보낸 작업 지시는')
    && !document.querySelector('#drawerContent')?.innerText.includes('도움 AI에게 일을 맡기기 직전')`, '서브에이전트 상세가 실제 응답만 보여주는 읽기 전용 화면으로 열리지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `!document.querySelector('#detailDrawer')?.classList.contains('open')`, '서브에이전트 대화를 닫지 못했습니다.');

  await click(win, '[data-open-execution-id="fixture-shell-running"]', 'control-room:open-execution');
  await waitFor(win, `window.LoadToAgentApp.state.drawerMode === 'execution'
    && window.LoadToAgentApp.state.drawerExecutionId === 'fixture-shell-running'
    && document.querySelector('#detailDrawer')?.dataset.mode === 'execution'
    && document.querySelector('[data-execution-detail="fixture-shell-running"]')?.dataset.conversationScope === 'execution-only'
    && document.querySelector('#drawerContent')?.innerText.includes('npm run dev')
    && document.querySelector('#drawerContent')?.innerText.includes('화면 미리보기가 실행 중입니다.')
    && !document.querySelector('#drawerContent')?.innerText.includes('상호작용 테스트를 진행해줘')
    && document.querySelectorAll('.drawer-tab:not(.hidden)').length === 1
    && document.querySelector('.drawer-tab:not(.hidden)')?.textContent === '실행 과정'
    && document.querySelector('#drawerComposer')?.classList.contains('hidden')`, 'PowerShell 실행 과정이 소유 세션 대화와 분리되지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `!document.querySelector('#detailDrawer')?.classList.contains('open')`, 'PowerShell 실행 상세를 닫지 못했습니다.');

  await click(win, '[data-management-filter]', 'management:overview-filter');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'waiting' && window.LoadToAgentApp.state.managementFilter === 'all'`, '운영 개요의 모두 보기가 전체 확인함을 열지 못했습니다.');
  await click(win, '.attention-more-cards > summary', 'management:more-cards');
  await waitFor(win, `document.querySelector('.attention-more-cards')?.open
    && document.querySelector('.attention-more-cards > div')?.getClientRects().length > 0`,
  '나머지 확인 카드 펼치기가 숨겨진 판단 항목을 보여주지 못했습니다.');
  await click(win, '.approval-custom-answer > summary', 'management:custom-answer');
  await waitFor(win, `document.querySelector('.approval-custom-answer')?.open
    && document.querySelector('.approval-custom-answer [data-agent-command-draft]')?.getClientRects().length > 0`,
  '승인 요청의 직접 답변 입력칸을 펼치지 못했습니다.');
  const managementInboxFiltersVisible = await win.webContents.executeJavaScript(`(() => {
    const filter = document.querySelector('[data-management-inbox-filter="critical"]');
    return Boolean(filter && filter.getClientRects().length && getComputedStyle(filter).visibility !== 'hidden');
  })()`);
  if (managementInboxFiltersVisible) {
    await click(win, '[data-management-inbox-filter="critical"]', 'management:inbox-filter');
    await waitFor(win, `window.LoadToAgentApp.state.view === 'waiting'
      && window.LoadToAgentApp.state.managementFilter === 'critical'
      && document.querySelector('[data-management-inbox-filter="critical"]')?.getAttribute('aria-pressed') === 'true'
      && document.querySelector('#globalStatus')?.textContent.includes('보기 기준')
      && document.querySelector('#globalStatus')?.textContent.includes('결과')
      && !document.querySelector('#attentionInbox').classList.contains('hidden')`, '긴급 현황 필터가 선택 상태를 보존하며 확인함을 열지 못했습니다.');
    assert(await win.webContents.executeJavaScript(`document.querySelectorAll('#attentionInbox [data-management-session]').length`) === managementScope.critical, `운영 개요의 긴급 위험 신호 수와 확인함 결과 수가 다릅니다: ${JSON.stringify(managementScope)}`);
    await click(win, '[data-management-inbox-filter="warning"]', 'management:inbox-warning');
    await waitFor(win, `window.LoadToAgentApp.state.managementFilter === 'warning'
      && document.querySelector('[data-management-inbox-filter="warning"]')?.getAttribute('aria-pressed') === 'true'`, '확인함 경고 필터가 선택 상태를 반영하지 않았습니다.');
    await click(win, '[data-management-inbox-filter="all"]', 'management:inbox-filter');
    await waitFor(win, `window.LoadToAgentApp.state.managementFilter === 'all'
      && document.querySelector('[data-management-inbox-filter="all"]')?.getAttribute('aria-pressed') === 'true'
      && !document.querySelector('#attentionInbox')?.classList.contains('hidden')
      && document.querySelector('#globalStatus')?.textContent.includes('결과')`, '확인함 전체 필터가 적용되거나 결과가 안내되지 않았습니다.');
    await click(win, '[data-management-inbox-filter="attention"]', 'management:inbox-filter');
    await waitFor(win, `window.LoadToAgentApp.state.managementFilter === 'attention'
      && Boolean(document.querySelector('[data-management-session="fixture-waiting"]'))
      && !document.querySelector('[data-management-session="fixture-failed"]')
      && !document.querySelector('[data-management-session="fixture-paused-run"]')`, '내 응답 필요 필터가 실제 응답 요청만 표시하지 못했습니다.');
    await click(win, '[data-management-inbox-filter="optional"]', 'management:inbox-filter');
    await waitFor(win, `window.LoadToAgentApp.state.managementFilter === 'optional'
      && Boolean(document.querySelector('[data-management-session="fixture-optional"][data-attention-category="optional"]'))
      && !document.querySelector('[data-management-session="fixture-waiting"]')
      && !document.querySelector('[data-management-session="fixture-failed"]')`, '원하면 수정할 수 있는 완료 작업이 답변 필요·실패 작업과 분리되어 표시되지 않았습니다.');
    await click(win, '[data-management-inbox-filter="all"]', 'management:inbox-filter');
  } else {
    round.observed.managementInboxFilters = 'hidden-by-streamlined-review-shell';
  }
  await waitFor(win, `Boolean(document.querySelector('[data-management-session="fixture-waiting"] [data-attention-quick]'))
    && Boolean(document.querySelector('[data-management-session="fixture-failed"] .attention-primary-action[data-open-session="fixture-failed"]'))
    && Boolean(document.querySelector('[data-management-session="fixture-paused-run"] .attention-primary-action[data-open-session="fixture-paused-run"]'))
    && [...document.querySelectorAll('#attentionInbox [data-management-session]')]
      .every(card => card.querySelectorAll('.attention-decision-flow > section').length === 3)
    && document.querySelector('.approval-custom-answer')?.open`,
  '간결한 확인함의 빠른 선택·상세 열기·직접 답변 경로가 준비되지 않았습니다.');
  await recordManifest(win);

  await clearCalls(win);
  await click(win, '[data-management-session="fixture-waiting"] [data-attention-quick]:not(.approve)', 'management:quick-deny');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate' && item.args[0]?.provider === 'gemini')`, '거절 빠른 응답이 해당 AI 대화를 복원해 전달되지 않았습니다.', 160);
  await click(win, '[data-view="waiting"]', 'nav:waiting');
  await waitFor(win, `Boolean(document.querySelector('[data-management-session="fixture-waiting"] [data-attention-quick].approve'))`, '거절 응답 뒤 승인 빠른 응답 fixture를 다시 열지 못했습니다.');
  await clearCalls(win);
  await click(win, '[data-management-session="fixture-waiting"] [data-attention-quick].approve', 'management:quick-response');
  await waitFor(win, `window.interactionTest.getCalls().some(item =>
    (item.name === 'terminalCreate' && item.args[0]?.provider === 'gemini')
    || (item.name === 'terminalCommand' && String(item.args[1] || '').includes('진행')))`, '승인 빠른 응답이 복원된 AI 대화로 전달되지 않았습니다.', 160);

  await click(win, '[data-view="waiting"]', 'nav:waiting');
  await click(win, '.attention-more-cards > summary', 'management:more-cards');
  await win.webContents.executeJavaScript(`document.querySelector('[data-management-session="fixture-failed"] .attention-primary-action[data-open-session="fixture-failed"]').focus({ preventScroll: true })`);
  await click(win, '[data-management-session="fixture-failed"] .attention-primary-action[data-open-session="fixture-failed"]', 'drawer:open-graph');
  await click(win, '.drawer-tab[data-tab="summary"]', 'drawer:tab-summary');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')
    && Boolean(document.querySelector('#detailDrawer [data-managed-run-action="retry"]'))
    && Boolean(document.querySelector('#detailDrawer [data-reassign-session="fixture-failed"]'))
    && Boolean(document.querySelector('#detailDrawer [data-result-review-complete="fixture-failed"]'))`,
  '실패 작업 상세에 확인 완료, 다시 실행과 재배정 제어가 표시되지 않았습니다.');
  await clearCalls(win);
  await click(win, '#detailDrawer [data-managed-run-action="retry"]', 'management:run-control');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'retryAgent' && item.args[0] === 'fixture-failed-run')`, '실패한 실행의 다시 실행 요청이 전달되지 않았습니다.');
  await click(win, '#detailDrawer [data-reassign-session="fixture-failed"]', 'management:reassign');
  await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden') && document.querySelector('#runPrompt').value.includes('GPT 코딩 도우미 작업의 완료 여부 확인') && document.querySelector('#runCwd').value === 'D:\\\\fixture'`, '재배정이 원래 목표와 작업 폴더를 새 실행 창에 보존하지 못했습니다.');
  await click(win, '#clearRunDraftBtn', 'run:clear-draft');
  await click(win, '#cancelRunBtn', 'run:cancel');
  await waitFor(win, `(() => {
    const origin = document.querySelector('[data-management-session="fixture-failed"] .attention-primary-action[data-open-session="fixture-failed"]');
    const active = document.activeElement;
    return document.querySelector('#runModal').classList.contains('hidden')
      && !document.querySelector('#appShell').inert
      && active === origin
      && active.isConnected
      && !active.closest('[hidden], [inert], [aria-hidden="true"], .hidden')
      && active.getClientRects().length > 0;
  })()`, '재배정 취소 뒤 닫힌 상세 창 내부가 아닌 바깥 트리거로 초점이 복원되지 않았습니다.');
  mark('management:reassign-focus-restore');
  await click(win, '[data-management-session="fixture-failed"] .attention-primary-action[data-open-session="fixture-failed"]', 'drawer:open-graph');
  await click(win, '.drawer-tab[data-tab="summary"]', 'drawer:tab-summary');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')
    && Boolean(document.querySelector('#detailDrawer [data-result-review-complete="fixture-failed"]'))`,
  '재배정 취소 뒤 실패 작업 상세를 다시 열지 못했습니다.');
  await click(win, '#detailDrawer [data-result-review-complete="fixture-failed"]', 'management:result-review-complete');
  await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')
    && window.LoadToAgentApp.isResultReviewComplete(window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-failed'))
    && !window.LoadToAgentApp.needsManagementReview(window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-failed'))
    && !document.querySelector('[data-management-session="fixture-failed"]')
    && Boolean(localStorage.getItem(window.LoadToAgentApp.RESULT_REVIEW_STORAGE_KEY))`,
  '확인 완료한 결과가 저장되거나 확인 목록에서 제거되지 않았습니다.');

  await click(win, '[data-view="waiting"]', 'nav:waiting');
  await click(win, '.attention-more-cards > summary', 'management:more-cards');
  await click(win, '[data-management-session="fixture-paused-run"] .attention-primary-action[data-open-session="fixture-paused-run"]', 'drawer:open-graph');
  await click(win, '.drawer-tab[data-tab="summary"]', 'drawer:tab-summary');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')
    && Boolean(document.querySelector('#detailDrawer [data-managed-run-action="resume"]'))`,
  '일시정지 작업 상세에 재개 제어가 표시되지 않았습니다.');
  await clearCalls(win);
  await click(win, '#detailDrawer [data-managed-run-action="resume"]', 'management:run-control');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'resumeAgentRun' && item.args[0] === 'fixture-paused-run')`, '일시정지한 실행의 재개 요청이 전달되지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');

  await click(win, '[data-view="all"]', 'nav:all');
  await click(win, '#liveSessionGrid [data-open-session="fixture-root"]', 'drawer:open-graph');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')`, '실행 상세 대화를 열지 못했습니다.');
  await click(win, '.drawer-tab[data-tab="summary"]', 'drawer:tab-summary');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && Boolean(document.querySelector('[data-managed-run-action="pause"]'))`, '실행 상세의 일시정지 제어가 표시되지 않았습니다.');
  await clearCalls(win);
  await click(win, '[data-managed-run-action="pause"]', 'management:run-control');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'pauseAgent' && item.args[0] === 'fixture-run')`, '실행 일시정지 요청이 전달되지 않았습니다.');
  await clearCalls(win);
  await click(win, '[data-managed-run-action="stop"]', 'management:run-stop');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'stopAgent' && item.args[0] === 'fixture-run')`, '실행 상세의 중지 요청이 전달되지 않았습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, '관리 제어 검증 뒤 상세 창이 닫히지 않았습니다.');
  round.observed.management = { inbox: true, compactReview: true, resultReviewComplete: true, retry: true, resume: true, pause: true, stop: true, quickApprove: true, quickDeny: true, reassign: true };
}

async function exerciseLanguageSettings(win, round) {
  await click(win, '[data-view="settings"]', 'nav:settings');
  for (const [locale, title, lang] of [
    ['en', 'Change the settings you want below', 'en'],
    ['zh-CN', '请在下方更改所需设置', 'zh-CN'],
    ['ko', '화면 및 업데이트 설정', 'ko'],
  ]) {
    await win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('#languageSelect');
      select.value = ${JSON.stringify(locale)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(win, `document.documentElement.lang === ${JSON.stringify(lang)} && document.querySelector('#settingsTitle').textContent === ${JSON.stringify(title)} && localStorage.getItem('loadtoagent:locale:v1') === ${JSON.stringify(locale)}`, `${locale} 언어 전환과 저장 실패`);
    if (locale !== 'ko') {
      const studioCopyAudit = await win.webContents.executeJavaScript(`(() => {
        const textSelectors = [
          '#sidebarProjects header > div > span',
          '#sidebarProjectsTitle',
          '.sidebar-credo > span',
          '.sidebar-credo strong > span',
          '#projectSidebarList .all-projects .project-sidebar-copy strong',
          '#projectSidebarList .project-sidebar-copy small',
          '#projectSidebarList .project-sidebar-attention small',
          '#projectSidebarList .project-sidebar-session small',
          '#sessionTokenOverview .session-token-heading p',
          '#sessionTokenTitle',
          '#sessionTokenScope .session-token-scope-summary',
          '#sessionTokenList .session-token-item strong small',
          '#sessionTokenList .session-token-empty',
          '#projectContextEyebrow',
          '#projectContextHeading',
          '#projectContextMeta',
          '#projectViewTabs',
          '#projectHistoryRail header > div > span',
          '#projectHistoryTitle .project-history-title-suffix',
          '#projectHistoryList p > b',
          '#projectHistoryList p > small',
        ];
        const attributeChecks = [
          ['#sidebarNewProjectBtn', 'aria-label'],
          ['#sidebarNewProjectBtn', 'title'],
          ['#projectSidebarList', 'aria-label'],
          ['#projectSidebarList .project-sidebar-live', 'aria-label'],
          ['#sessionTokenList .session-token-meter', 'aria-label'],
          ['#projectViewTabs', 'aria-label'],
          ['#projectViewTabs .nav-item', 'aria-label'],
          ['#projectViewTabs .nav-item', 'title'],
          ['#advancedToolsNav > summary', 'aria-label'],
          ['#advancedToolsNav > summary', 'title'],
          ['#openProjectHistoryBtn', 'aria-label'],
          ['#openProjectHistoryBtn', 'title'],
        ];
        const values = [];
        textSelectors.forEach(selector => {
          document.querySelectorAll(selector).forEach((node, index) => {
            values.push({ source: selector + '[' + index + ']', value: node.textContent.trim() });
          });
        });
        attributeChecks.forEach(([selector, attribute]) => {
          document.querySelectorAll(selector).forEach((node, index) => {
            values.push({ source: selector + '[' + index + ']@' + attribute, value: String(node.getAttribute(attribute) || '').trim() });
          });
        });
        return {
          values,
          korean: values.filter(item => /[가-힣]/.test(item.value)),
          legacyEnglishDecoration: values.filter(item => /\\b(?:WORKSPACES|SESSION TOKENS|HISTORY|SELECTED PROJECT|PROGRESS BY WORK ITEM)\\b/.test(item.value)),
          headings: {
            sidebar: document.querySelector('#sidebarProjectsTitle')?.textContent.trim(),
            tokens: document.querySelector('#sessionTokenTitle')?.textContent.trim(),
            history: document.querySelector('#projectHistoryRail header > div > span')?.textContent.trim(),
          },
        };
      })()`);
      assert(studioCopyAudit.korean.length === 0, `${locale} studio shell 시스템 문구에 한국어가 남았습니다: ${JSON.stringify(studioCopyAudit.korean)}`);
      const expectedStudioHeadings = locale === 'en'
        ? { sidebar: 'Projects', tokens: 'Usage by AI', history: 'History' }
        : { sidebar: '项目', tokens: '各 AI 使用量', history: '历史记录' };
      assert(
        Object.entries(expectedStudioHeadings).every(([key, value]) => studioCopyAudit.headings[key] === value),
        `${locale} studio shell 제목 번역이 일치하지 않습니다: ${JSON.stringify(studioCopyAudit.headings)}`,
      );
      if (locale === 'zh-CN') {
        assert(studioCopyAudit.legacyEnglishDecoration.length === 0, `zh-CN studio shell 장식 문구에 영문이 남았습니다: ${JSON.stringify(studioCopyAudit.legacyEnglishDecoration)}`);
      }
    }
  }
  mark('settings:language');
  await recordExercise(win, '#languageSelect');
  round.observed.languages = ['ko', 'en', 'zh-CN'];
}

async function exerciseThemeSettings(win, round) {
  await click(win, '[data-view="settings"]', 'nav:settings');
  await win.webContents.executeJavaScript(`window.LoadToAgentTheme.setTheme('dark')`);
  await waitFor(win, `document.documentElement.dataset.theme === 'dark'
    && localStorage.getItem('loadtoagent:theme:v1') === 'dark'`,
  '테마 버튼 검증을 위한 다크 모드 기준 상태를 만들지 못했습니다.');
  await click(win, '[data-theme-choice="dark"]', 'theme:dark');
  await waitFor(win, `document.documentElement.dataset.theme === 'dark'
    && localStorage.getItem('loadtoagent:theme:v1') === 'dark'
    && document.querySelector('[data-theme-choice="dark"]')?.getAttribute('aria-checked') === 'true'`,
  '설정의 다크 모드 선택이 화면과 저장 상태에 적용되지 않았습니다.');

  await click(win, '[data-theme-choice="light"]', 'theme:light');
  await waitFor(win, `document.documentElement.dataset.theme === 'light'
    && localStorage.getItem('loadtoagent:theme:v1') === 'light'
    && document.querySelector('[data-theme-choice="light"]')?.getAttribute('aria-checked') === 'true'`,
  '설정의 라이트 모드 선택이 화면과 저장 상태에 적용되지 않았습니다.');
  round.observed.theme = { settingsChoices: ['dark', 'light'], persisted: true };
}

async function exerciseProviderVisibility(win, round) {
  await prepareProjectFirstStep(win);
  await click(win, '[data-view="settings"]', 'nav:settings');
  const initial = await win.webContents.executeJavaScript(`(() => ({
    options: document.querySelectorAll('[data-provider-visibility]').length,
    enabled: document.querySelectorAll('[data-provider-visibility]:checked').length,
    providers: window.LoadToAgentApp.state.providers.length,
  }))()`);
  assert(initial.options === initial.providers && initial.enabled === initial.providers, `AI 표시 기본값이 모두 ON이 아닙니다: ${JSON.stringify(initial)}`);
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ failures: { setProviderVisibility: 1 } })`);
  await win.webContents.executeJavaScript(`document.querySelector('[data-provider-visibility="claude"]')?.focus({ preventScroll: true })`);
  assert(await win.webContents.executeJavaScript(`document.activeElement?.matches('[data-provider-visibility="claude"]')`),
    'AI 표시 설정의 시각적으로 숨긴 체크박스가 키보드 포커스를 받지 못했습니다.');
  await click(win, 'label:has([data-provider-visibility="claude"])', 'settings:provider-visibility');
  await waitFor(win, `!window.LoadToAgentApp.state.hiddenProviders.has('claude')
    && document.querySelector('[data-provider-visibility="claude"]')?.checked
    && document.activeElement?.matches('[data-provider-visibility="claude"]')`,
  'AI 표시 설정 저장 실패 후 체크 상태·필터·키보드 포커스가 복원되지 않았습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls(); window.interactionTest.clearCalls()`);
  mark('settings:provider-visibility-rollback');
  mark('settings:provider-visibility-focus-restore');
  await click(win, 'label:has([data-provider-visibility="claude"])', 'settings:provider-visibility');
  await waitFor(win, `window.LoadToAgentApp.state.hiddenProviders.has('claude')
    && !window.LoadToAgentApp.state.snapshot.sessions.some(session => session.provider === 'claude')
    && JSON.parse(localStorage.getItem('loadtoagent:provider-visibility:v1')).hidden.includes('claude')
    && document.activeElement?.matches('[data-provider-visibility="claude"]')`,
  'Claude 숨김 설정과 저장을 적용한 뒤 의미상 같은 체크박스로 키보드 포커스가 이어지지 않았습니다.');
  await click(win, '[data-view="all"]', 'nav:all');
  const hidden = await win.webContents.executeJavaScript(`(() => ({
    rail: Boolean(document.querySelector('#providerRail .provider-rail-item strong')?.textContent === 'Claude' || [...document.querySelectorAll('#providerRail .provider-rail-item strong')].some(node => node.textContent === 'Claude')),
    overview: Boolean(document.querySelector('[data-provider-card="claude"]')),
    filter: Boolean(document.querySelector('[data-provider-filter="claude"]')),
    session: window.LoadToAgentApp.state.snapshot.sessions.some(session => session.provider === 'claude'),
    tmux: (window.LoadToAgentApp.state.snapshot.tmux?.distros || []).some(d => d.sessions.some(s => s.windows.some(w => w.panes.some(p => p.agent?.provider === 'claude')))),
  }))()`);
  assert(!hidden.rail && !hidden.overview && !hidden.filter && !hidden.session && !hidden.tmux, `숨긴 Claude가 화면에 남았습니다: ${JSON.stringify(hidden)}`);
  await click(win, '#newRunBtn', 'run:open');
  assert(await win.webContents.executeJavaScript(`!document.querySelector('[data-run-provider="claude"]')`), '숨긴 Claude가 새 작업 선택지에 남았습니다.');
  await click(win, '#closeRunModalBtn', 'run:close-x');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden') && !document.querySelector('#appShell').inert && document.querySelector('#runModal').inert`, '새 작업 모달을 닫은 뒤 앱 상호작용이 복원되지 않았습니다.');
  await click(win, '[data-view="settings"]', 'nav:settings');
  await click(win, 'label:has([data-provider-visibility="claude"])', 'settings:provider-visibility');
  await waitFor(win, `!window.LoadToAgentApp.state.hiddenProviders.has('claude')
    && window.LoadToAgentApp.state.snapshot.sessions.some(session => session.provider === 'claude')
    && document.querySelector('[data-provider-visibility="claude"]')?.checked
    && document.activeElement?.matches('[data-provider-visibility="claude"]')`,
  'Claude 다시 표시와 키보드 포커스가 즉시 복원되지 않았습니다.');
  const hiddenControlFocusRejected = await win.webContents.executeJavaScript(`(() => {
    const fixture = document.createElement('div');
    fixture.id = 'hiddenFocusRestorationFixture';
    fixture.innerHTML = '<button type="button" data-hidden-focus-fixture="control" style="opacity:0">hidden</button>';
    document.body.append(fixture);
    fixture.querySelector('button').focus({ preventScroll: true });
    window.LoadToAgentApp.preserveFocusDuringRender(() => {
      fixture.innerHTML = '<button type="button" data-hidden-focus-fixture="control" style="opacity:0">hidden</button>';
    }, fixture);
    const replacement = fixture.querySelector('button');
    const rejected = document.activeElement !== replacement;
    fixture.remove();
    return rejected;
  })()`);
  assert(hiddenControlFocusRejected, '화면에 실제로 숨은 컨트롤로 키보드 포커스를 복원했습니다.');
  round.observed.providerVisibility = {
    defaultOn: initial.providers,
    hiddenLeakCount: 0,
    restored: true,
    focusPreserved: true,
    hiddenControlFocusRejected,
  };
}

async function exerciseDashboardControls(win, round) {
  await prepareProjectFirstStep(win);
  await click(win, '[data-view="all"]', 'nav:all');
  await clearCalls(win);
  await click(win, '#sidebarNewProjectBtn', 'workspace:add-sidebar');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'addWorkspaces')
    && window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'`,
  '왼쪽 프로젝트 추가 버튼이 폴더 선택 결과를 프로젝트 홈에 반영하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#operationsOverview')?.scrollIntoView({ block: 'start', inline: 'nearest' });
    return document.fonts.ready;
  })()`);
  await sleep(180);
  fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'loadtoagent-readability-overview-interaction.png'), (await win.webContents.capturePage()).toPNG());
  const controlRoom = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const waitingSession = app.state.snapshot.sessions.find(session => session.id === 'fixture-waiting');
    const waitingEntries = app.state.pendingConversationMessages.get('fixture-waiting') || [];
    const pendingWaiting = waitingEntries.some(entry =>
      !['failed', 'interrupted'].includes(entry.status)
      && !['responded', 'interrupted'].includes(entry.phase));
    const waitingDelivery = waitingSession ? app.pendingConversationDelivery(waitingSession) : null;
    const graphModel = app.connectedGraphSessions(app.graphFilteredSessions());
    const expectedRoomIds = graphModel.nodes
      .filter(session => !session.parentId || !graphModel.included.has(session.parentId))
      .map(session => session.id)
      .sort();
    return {
    rooms: document.querySelectorAll('[data-control-session]').length,
    roomIds: [...document.querySelectorAll('[data-control-session]')].map(node => node.dataset.controlSession).sort(),
    expectedRoomIds,
    uniqueRooms: new Set([...document.querySelectorAll('[data-control-session]')].map(node => node.dataset.controlSession)).size,
    pendingWaiting,
    waitingDeliveryPhase: waitingDelivery?.phase || '',
    waitingDeliveryLabel: document.querySelector('[data-control-session="fixture-waiting"] .control-main-top em')?.textContent.trim() || '',
    expectedWaitingDeliveryLabel: pendingWaiting ? window.LoadToAgentI18n.t('control.delivery_confirming') : '',
    mains: document.querySelectorAll('.control-room-main').length,
    helperNodes: document.querySelectorAll('[data-control-session="fixture-root"] .helper-node').length,
    executionNodes: document.querySelectorAll('[data-control-session="fixture-root"] .execution-node').length,
    completedNodes: document.querySelectorAll('[data-control-session="fixture-root"] .completed-list .control-room-node').length,
    runningChildInActiveColumn: Boolean(document.querySelector('[data-control-session="fixture-root"] .activity-column [data-open-subagent-chat="fixture-child"]')),
    runningChildInCompletedColumn: Boolean(document.querySelector('[data-control-session="fixture-root"] .completed-column [data-open-subagent-chat="fixture-child"]')),
    mainLeakedIntoWorkColumns: Boolean(document.querySelector('.activity-column .control-room-main, .activity-column .direct-work, .completed-column .control-room-main, .completed-column .direct-work')),
    invalidRunningUnits: [...document.querySelectorAll('.activity-column .control-room-node:not(.overflow-node)')]
      .filter(node => !node.matches('.helper-node, .execution-node')).length,
    invalidCompletedUnits: [...document.querySelectorAll('.completed-list .control-room-node')]
      .filter(node => !node.matches('.helper-node, .execution-node')).length,
    emptyRunningColumns: document.querySelectorAll('.activity-column .control-room-running-empty').length,
    executionTypeLabels: [...document.querySelectorAll('[data-control-session="fixture-root"] .execution-node .control-node-copy > small')].map(node => node.textContent.trim()),
    mainOwnerLabelsHidden: ![...document.querySelectorAll('.activity-column .control-node-copy > small, .completed-column .control-node-copy > small')]
      .some(node => /^메인\s/.test(node.textContent.trim())),
    overflowNodes: document.querySelectorAll('[data-control-session="fixture-root"] .overflow-node').length,
    legends: document.querySelectorAll('#graphBreadcrumbs .control-room-legend > span').length,
    visibleWithoutFocus: window.LoadToAgentApp.state.graphFocusId === null && Boolean(document.querySelector('[data-control-room-overview]')),
    mainSummary: document.querySelector('[data-control-session="fixture-root"] .control-room-main')?.dataset.controlSummary || '',
    helperSummaries: [...document.querySelectorAll('[data-control-session="fixture-root"] .helper-node')].map(node => node.dataset.controlSummary || ''),
    executionSummaries: [...document.querySelectorAll('[data-control-session="fixture-root"] .execution-node')].map(node => node.dataset.controlSummary || ''),
    runtimeTooltips: [...document.querySelectorAll('[data-control-session="fixture-root"] .execution-node .control-node-copy > small')].map(node => node.title),
    rawRuntimeTitlesHidden: ![...document.querySelectorAll('[data-control-session="fixture-root"] .execution-node .control-node-copy > small')]
      .some(node => /^(?:PowerShell|Command Prompt|Shell|Background)(?: ·|$)/.test(node.textContent.trim())),
    humanSummaries: [...document.querySelectorAll('.control-room-main, .helper-node, .execution-node')]
      .map(node => node.dataset.controlSummary || ''),
  };
  })()`);
  assert(controlRoom.rooms === controlRoom.expectedRoomIds.length
    && controlRoom.uniqueRooms === controlRoom.rooms
    && JSON.stringify(controlRoom.roomIds) === JSON.stringify(controlRoom.expectedRoomIds)
    && (!controlRoom.pendingWaiting || (
      controlRoom.waitingDeliveryPhase === 'confirming'
      && controlRoom.waitingDeliveryLabel === controlRoom.expectedWaitingDeliveryLabel
    ))
    && controlRoom.mains === controlRoom.rooms && controlRoom.helperNodes >= 3
    && controlRoom.executionNodes >= 3 && controlRoom.completedNodes >= 3 && controlRoom.legends === 0
    && controlRoom.runningChildInActiveColumn && !controlRoom.runningChildInCompletedColumn
    && !controlRoom.mainLeakedIntoWorkColumns && controlRoom.invalidRunningUnits === 0
    && controlRoom.invalidCompletedUnits === 0 && controlRoom.emptyRunningColumns >= 1
    && controlRoom.mainOwnerLabelsHidden && controlRoom.executionTypeLabels.some(label => label.startsWith('컴퓨터 작업'))
    && controlRoom.visibleWithoutFocus && controlRoom.mainSummary
    && controlRoom.helperSummaries.every(Boolean) && controlRoom.executionSummaries.every(Boolean)
    && controlRoom.runtimeTooltips.length === controlRoom.executionNodes && controlRoom.runtimeTooltips.every(Boolean)
    && controlRoom.humanSummaries.every(summary => summary && !/^\//.test(summary) && !/^(?:Let me|Now I(?:'ll| will))/i.test(summary))
    && controlRoom.rawRuntimeTitlesHidden,
  `홈 세션 관제 구조가 올바르지 않습니다: ${JSON.stringify(controlRoom)}`);
  const navCounts = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const sessions = app.graphFilteredSessions();
    const activeRoots = sessions.filter(session => !session.parentId && app.isControlRoomSession(session)).length;
    const reviewNeeded = Math.min(activeRoots, sessions.filter(session => app.needsManagementInbox(session)
      && !app.matchesManagementFilter(session, 'optional')).length);
    const expected = {
      now: Math.max(0, activeRoots - reviewNeeded),
      memory: sessions.filter(session => !session.parentId && ['completed', 'cancelled', 'failed', 'idle'].includes(session.status)).length,
      runtime: (app.state.snapshot?.automations || []).filter(item => !app.state.hiddenProviders.has(item.provider || 'codex')).length
        + sessions.filter(app.isRuntimeLoopSession).length,
      tmux: Number(app.state.snapshot?.tmux?.summary?.windows || 0),
    };
    return {
      now: Number.parseInt(document.querySelector('#navAllCount').textContent, 10),
      memory: Number.parseInt(document.querySelector('#navActiveCount').textContent, 10),
      runtime: Number(document.querySelector('#navRuntimeCount').dataset.total),
      tmux: Number(document.querySelector('#navTmuxCount').textContent.match(/\\d+/)?.[0] || 0),
      expected,
    };
  })()`);
  assert(navCounts.now === navCounts.expected.now
    && navCounts.memory === navCounts.expected.memory
    && navCounts.runtime === navCounts.expected.runtime
    && navCounts.tmux === navCounts.expected.tmux,
  `탭 배지의 단위가 올바르지 않습니다: ${JSON.stringify(navCounts)}`);
  const projectStudio = await win.webContents.executeJavaScript(`(() => ({
    projects: document.querySelectorAll('#projectSidebarList [data-workspace]').length,
    attentionProjects: document.querySelectorAll('#projectSidebarList .project-sidebar-group.has-attention').length,
    allProjectsOption: Boolean(document.querySelector('#projectSidebarList [data-workspace="all"]')),
    historyVisible: Boolean(document.querySelector('#projectHistoryRail')?.getBoundingClientRect().height),
    historyTitles: [...document.querySelectorAll('#projectHistoryList [data-open-session] span')].map(node => node.textContent.trim()),
    title: document.querySelector('#projectHistoryTitle')?.textContent || '',
  }))()`);
  assert(projectStudio.projects >= 2 && !projectStudio.allProjectsOption && projectStudio.historyVisible && projectStudio.attentionProjects >= 1
    && projectStudio.historyTitles.length >= 1
    && projectStudio.historyTitles.every(title => title && title !== 'NaN')
    && projectStudio.title.includes('지난 세션'),
  `프로젝트 중심 스튜디오 셸이 올바르지 않습니다: ${JSON.stringify(projectStudio)}`);
  const projectOwnership = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const root = app.state.snapshot.sessions.find(session => session.id === 'fixture-root');
    const child = app.state.snapshot.sessions.find(session => session.id === 'fixture-child');
    const original = { workspace: app.state.workspace, root: root.originCwd, child: child.originCwd };
    try {
      app.state.workspace = 'D:\\\\fixture';
      root.originCwd = 'D:\\\\unrelated-project';
      child.originCwd = 'D:\\\\fixture';
      const unrelatedChildExcluded = !app.matchesWorkspaceFilter(child);
      root.originCwd = 'D:\\\\fixture';
      child.originCwd = 'D:\\\\unrelated-project';
      const relatedChildIncluded = app.matchesWorkspaceFilter(child);
      return { unrelatedChildExcluded, relatedChildIncluded };
    } finally {
      app.state.workspace = original.workspace;
      root.originCwd = original.root;
      child.originCwd = original.child;
    }
  })()`);
  assert(projectOwnership.unrelatedChildExcluded && projectOwnership.relatedChildIncluded,
    `하위 AI 작업이 최상위 작업의 프로젝트 범위를 따르지 않습니다: ${JSON.stringify(projectOwnership)}`);
  await prepareProjectFirstStep(win, 'all');
  await click(win, '#projectSidebarList [data-workspace="D:\\\\fixture"]', 'workspace:select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'
    && document.querySelector('.control-room-project-group')?.open
    && document.querySelector('#projectHistoryTitle')?.textContent.includes('화면 개선')
    && document.querySelector('#projectHistoryRail')?.getBoundingClientRect().height > 0`,
  '왼쪽 프로젝트를 선택했을 때 현재 프로세스가 펼쳐지고 지난 세션 범위가 바뀌지 않았습니다.');
  const selectedProjectHistory = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const rail = document.querySelector('#projectHistoryRail');
    const currentWork = document.querySelector('#liveSessionGrid');
    const railBox = rail.getBoundingClientRect();
    const currentBox = currentWork.getBoundingClientRect();
    const sessionIds = [...rail.querySelectorAll('[data-open-session]')].map(node => node.dataset.openSession);
    return {
      position: getComputedStyle(rail).position,
      belowCurrentWork: railBox.top >= currentBox.bottom - 2,
      sessionIds,
      allRelated: sessionIds.every(id => {
        const session = app.state.snapshot.sessions.find(item => item.id === id);
        return Boolean(session && app.matchesWorkspaceFilter(session));
      }),
    };
  })()`);
  assert(selectedProjectHistory.position === 'static'
    && selectedProjectHistory.belowCurrentWork
    && selectedProjectHistory.sessionIds.length > 0
    && selectedProjectHistory.allRelated,
  `선택한 프로젝트의 지난 세션이 본문 하단에 올바르게 배치되지 않았습니다: ${JSON.stringify(selectedProjectHistory)}`);
  await click(win, '#projectSidebarList [data-workspace="D:\\\\fixture"]', 'workspace:select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'
    && document.querySelector('#projectHistoryTitle')?.textContent.includes('화면 개선')`,
  '선택한 왼쪽 프로젝트를 다시 눌렀을 때 프로젝트 선택이 유지되지 않았습니다.');
  await click(win, '#openProjectHistoryBtn', 'history:open-all');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'active'
    && window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'
    && !document.querySelector('#sessionSection')?.classList.contains('hidden')`,
  '프로젝트 하단 지난 세션 영역에서 해당 프로젝트의 지난 작업 화면을 열지 못했습니다.');
  const desktopBoundsBeforeMobileFilters = win.getBounds();
  const mobileFilterStateBefore = await win.webContents.executeJavaScript(`(() => ({
    view: window.LoadToAgentApp.state.view,
    workspace: window.LoadToAgentApp.state.workspace,
    search: window.LoadToAgentApp.state.search,
    sort: window.LoadToAgentApp.state.sort,
    providers: [...window.LoadToAgentApp.state.providerFilters].sort(),
    disclosureOpen: Boolean(document.querySelector('.mobile-memory-filters')?.open),
  }))()`);
  assert(mobileFilterStateBefore.disclosureOpen, '데스크톱 지난 작업 필터 도구행이 펼쳐져 있지 않습니다.');
  try {
    win.setSize(480, 720);
    await waitFor(win, `window.innerWidth <= 480
      && document.querySelector('.mobile-memory-filters > summary')?.getClientRects().length > 0
      && document.querySelector('.mobile-memory-filters')?.open === false`,
    '모바일 지난 작업 필터가 닫힌 버튼 상태로 전환되지 않았습니다.');
    await click(win, '.mobile-memory-filters > summary', 'filter:mobile-disclosure');
    await waitFor(win, `document.querySelector('.mobile-memory-filters')?.open === true`,
    '모바일 지난 작업 필터 펼치기 버튼이 필터 패널 상태를 바꾸지 못했습니다.');
    await click(win, '.mobile-memory-filters > summary', 'filter:mobile-disclosure');
    await waitFor(win, `document.querySelector('.mobile-memory-filters')?.open === false`,
      '모바일 지난 작업 필터를 다시 닫지 못했습니다.');
  } finally {
    const mobileDisclosureOpen = await win.webContents.executeJavaScript(
      `Boolean(document.querySelector('.mobile-memory-filters')?.open)`,
    );
    if (mobileDisclosureOpen) {
      await win.webContents.executeJavaScript(`document.querySelector('.mobile-memory-filters > summary')?.click()`);
      await waitFor(win, `document.querySelector('.mobile-memory-filters')?.open === false`,
        '모바일 지난 작업 필터 상태를 정리하지 못했습니다.');
    }
    win.setBounds(desktopBoundsBeforeMobileFilters);
    await waitFor(win, `window.innerWidth > 720 && document.querySelector('.mobile-memory-filters')?.open === true`,
      '모바일 지난 작업 필터 검사 뒤 데스크톱 도구행을 복원하지 못했습니다.');
  }
  const mobileFilterStateAfter = await win.webContents.executeJavaScript(`(() => ({
    view: window.LoadToAgentApp.state.view,
    workspace: window.LoadToAgentApp.state.workspace,
    search: window.LoadToAgentApp.state.search,
    sort: window.LoadToAgentApp.state.sort,
    providers: [...window.LoadToAgentApp.state.providerFilters].sort(),
    disclosureOpen: Boolean(document.querySelector('.mobile-memory-filters')?.open),
  }))()`);
  assert(JSON.stringify(mobileFilterStateAfter) === JSON.stringify(mobileFilterStateBefore),
    `모바일 지난 작업 필터 검사 뒤 화면·필터 상태가 바뀌었습니다: ${JSON.stringify({ mobileFilterStateBefore, mobileFilterStateAfter })}`);
  await win.webContents.executeJavaScript(`(() => {
    window.LoadToAgentApp.state.workspace = 'all';
    window.LoadToAgentApp.render('filter');
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'all'`, '프로젝트 지난 세션 검증 뒤 전체 컨텍스트를 복원하지 못했습니다.');
  await click(win, '[data-view="all"]', 'nav:all');
  const tmuxShortcut = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#openTmuxFromAgentWork');
    const rect = button.getBoundingClientRect();
    return { count: Number.parseInt(document.querySelector('#agentWorkTmuxCount').textContent, 10), height: rect.height, accessibleName: button.getAttribute('aria-label') };
  })()`);
  assert(tmuxShortcut.count === 1 && tmuxShortcut.accessibleName.includes('1건'), `AI 작업의 다른 컴퓨터 수량 안내가 올바르지 않습니다: ${JSON.stringify(tmuxShortcut)}`);
  if (tmuxShortcut.height >= 44) await click(win, '#openTmuxFromAgentWork', 'tmux:shortcut-from-agent-work');
  else await click(win, '[data-view="tmux"]', 'nav:tmux');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'tmux'
    && !document.querySelector('#tmuxSection').classList.contains('hidden')
    && (${tmuxShortcut.height >= 44 ? "document.activeElement?.id === 'mainContent'" : "true"})`,
  'AI 작업의 tmux 바로가기가 tmux 탭을 열지 못했습니다.');
  await click(win, '[data-view="all"]', 'nav:all');
  await click(win, '#projectSidebarList [data-workspace="D:\\\\fixture"]', 'workspace:select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'
    && document.querySelector('.control-room-project-group')?.getBoundingClientRect().height > 0`,
  'AI 작업으로 돌아온 뒤 선택한 프로젝트의 작업 목록이 복원되지 않았습니다.');
  const legacyControlRoomFiltersVisible = await win.webContents.executeJavaScript(`(() => {
    const control = document.querySelector('#controlRoomSortSelect');
    const rect = control?.getBoundingClientRect();
    return Boolean(control && rect && rect.width > 0 && rect.height > 0 && getComputedStyle(control).display !== 'none');
  })()`);
  if (legacyControlRoomFiltersVisible) {
  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#controlRoomSortSelect');
    select.value = 'tokens';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await recordExercise(win, '#controlRoomSortSelect');
  await waitFor(win, `window.LoadToAgentApp.state.controlRoomSort === 'tokens'`, '관제 정렬 선택이 적용되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#controlRoomSortSelect');
    select.value = 'recent';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.controlRoomSort === 'recent'`, '관제 최신 활동 정렬을 복원하지 못했습니다.');
  await click(win, '#controlRoomSearchBtn', 'control-room:search-toggle');
  await waitFor(win, `document.querySelector('#controlRoomSearch')?.classList.contains('is-open') && document.activeElement?.id === 'controlRoomSearchInput'`, '관제 검색 입력을 열지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#controlRoomSearchInput');
    input.value = '화면 개선 폴더의 GPT 대화창';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await recordExercise(win, '#controlRoomSearchInput');
  await waitFor(win, `window.LoadToAgentApp.state.search === '화면 개선 폴더의 GPT 대화창' && Boolean(document.querySelector('[data-control-session="fixture-origin"]'))`, '작업 검색이 진행 중인 AI 작업에 적용되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#controlRoomSearchInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.search === ''`, '관제 검색을 초기화하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#controlRoomProjectSelect');
    select.value = 'D:\\\\unregistered-origin';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await recordExercise(win, '#controlRoomProjectSelect');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\unregistered-origin' && Boolean(document.querySelector('[data-control-session="fixture-origin"]'))`, '관제 프로젝트 선택이 적용되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#controlRoomProjectSelect');
    select.value = 'all';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'all'`, '관제 프로젝트 전체 선택을 복원하지 못했습니다.');
  } else {
    round.observed.legacyControlRoomFilters = 'hidden-by-project-first-shell';
  }
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const root = app.state.snapshot.sessions.find(session => session.id === 'fixture-root');
    root.status = 'completed';
    root.statusDetail = '메인 작업 완료 · 백그라운드 작업 정리 중';
    root.completedAt = root.messages.findLast(message => message.role === 'assistant')?.timestamp || root.updatedAt;
    app.renderSessions('archive-fixture');
  })()`);
  await waitFor(win, `Boolean(document.querySelector('[data-control-session="fixture-root"] [data-session-archive="fixture-root"]'))`, '완료됐지만 백그라운드 실행이 남은 세션에 지난 기록 이동 버튼이 표시되지 않았습니다.');
  await click(win, '[data-control-session="fixture-root"] [data-session-archive="fixture-root"]', 'control-room:move-to-history');
  await sleep(240);
  const archiveResult = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const root = app.state.snapshot.sessions.find(session => session.id === 'fixture-root');
    return {
      liveRoot: Boolean(document.querySelector('[data-control-session="fixture-root"]')),
      liveChildIncluded: app.connectedGraphSessions(app.graphFilteredSessions()).included.has('fixture-child'),
      memoryReady: Boolean(root && ['completed', 'cancelled', 'failed', 'idle'].includes(root.status)),
      manuallyArchived: app.isSessionManuallyArchived(root),
      controlRoomSession: app.isControlRoomSession(root),
      hasRunningExecution: app.hasRunningExecution(root),
      liveIds: [...document.querySelectorAll('[data-control-session]')].map(node => node.dataset.controlSession),
      historyIds: [...document.querySelectorAll('#sessionGrid [data-session-id]')].map(node => node.dataset.sessionId),
    };
  })()`);
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.snapshot = window.interactionTest.getSnapshot();
    app.state.sessionArchives.clear();
    localStorage.removeItem(app.SESSION_ARCHIVE_STORAGE_KEY);
    app.renderSessions('archive-fixture-restore');
  })()`);
  assert(!archiveResult.liveRoot && archiveResult.liveChildIncluded && archiveResult.memoryReady
    && archiveResult.manuallyArchived && !archiveResult.controlRoomSession,
  `지난 기록 이동이 완료 세션을 관제 영역에서 내리고 진행 중인 도움 AI만 남기지 못했습니다: ${JSON.stringify(archiveResult)}`);
  await waitFor(win, `Boolean(document.querySelector('[data-control-session="fixture-root"]'))`, '지난 기록 이동 검증 후 관제 fixture를 복원하지 못했습니다.');
  round.observed.controlRoom = controlRoom;
  await clearCalls(win);
  await click(win, '#probeBtn', 'dashboard:probe');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'probeProviders')`, 'AI 연결 상태 새로고침이 호출되지 않았습니다.');
  const legacyWorkspaceButtonVisible = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#addWorkspaceBtn');
    return Boolean(button && button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden');
  })()`);
  if (legacyWorkspaceButtonVisible) {
    await clearCalls(win);
    await click(win, '#addWorkspaceBtn', 'workspace:add');
    await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'addWorkspaces')`, 'workspace 추가가 호출되지 않았습니다.');
    await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden')
      && document.querySelector('#runCwd').value === 'D:\\\\fixture'`,
    '기존 프로젝트를 선택했을 때 해당 폴더가 입력된 AI 작업 창이 열리지 않았습니다.');
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeRunModal()`);
    await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden') && !document.querySelector('#appShell').inert && document.querySelector('#runModal').inert`, '프로젝트 작업 시작 창을 닫지 못했습니다.');
  } else {
    round.observed.legacyWorkspacePicker = 'hidden-by-project-first-shell';
  }
  await waitFor(win, `(() => {
    const item = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
      .find(node => node.dataset.workspace === '/mnt/c/Users/fixture/tmux-only-project');
    return Boolean(item);
  })()`, '대화 기록에 연결되지 않은 tmux AI 세션을 pane 경로의 프로젝트로 가져오지 못했습니다.');
  await waitFor(win, `(() => {
    const item = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
      .find(node => node.dataset.workspace === '/mnt/c/Users/fixture/nested-active-project');
    return Boolean(item);
  })()`, '오래된 부모 아래 실행 중인 tmux 서브에이전트의 프로젝트가 왼쪽 목록에서 사라졌습니다.');
  await click(win, '#projectSidebarList [data-workspace="/mnt/c/Users/fixture/nested-active-project"]', 'workspace:select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === '/mnt/c/Users/fixture/nested-active-project'
    && Boolean(document.querySelector('[data-control-project="설정 개선"] [data-control-session="fixture-old-parent"]'))`,
  '오래된 부모 아래 실행 중인 tmux 서브에이전트가 선택한 프로젝트 홈에서 사라졌습니다.');
  const standaloneTmuxIds = await win.webContents.executeJavaScript(
    `window.LoadToAgentApp.unlinkedLiveTmuxSessions().map(session => session.id)`,
  );
  assert(
    JSON.stringify(standaloneTmuxIds) === JSON.stringify(['tmux:tmux-pane-unlinked']),
    `오래전에 idle이 된 연결 tmux를 새 실행으로 중복 집계했습니다: ${JSON.stringify(standaloneTmuxIds)}`,
  );
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('#projectSidebarList [data-workspace]')]
    .find(node => node.dataset.workspace === '/mnt/c/Users/fixture/tmux-only-project')?.click()`);
  mark('workspace:select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === '/mnt/c/Users/fixture/tmux-only-project'
    && document.querySelector('[data-control-project="관련 작업 모음"] .live-tmux-card')
    && document.querySelector('.live-tmux-card-head b')?.textContent === '화면 개선'
    && document.querySelector('.live-tmux-title')?.textContent === '다른 컴퓨터에서 화면 설명 고치기'
    && !document.querySelector('#emptyState:not(.hidden)')`,
  'tmux 전용 프로젝트를 선택했을 때 세션명·작업명·경로 카드가 홈에서 사라졌습니다.');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('#projectSidebarList [data-workspace]')]
    .find(node => node.dataset.workspace === '/mnt/c/Users/fixture/tmux-only-project')?.click()`);
  await waitFor(win, `window.LoadToAgentApp.state.workspace === '/mnt/c/Users/fixture/tmux-only-project'`,
  'tmux 전용 프로젝트를 다시 눌렀을 때 프로젝트 선택이 유지되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    window.LoadToAgentApp.state.workspace = 'all';
    window.LoadToAgentApp.render('filter');
  })()`);
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.workspaces.push({ name: 'empty-live-project', path: 'D:\\\\empty-live-project' });
    app.render('empty-live-project');
  })()`);
  await waitFor(win, `[...document.querySelectorAll('#projectSidebarList [data-workspace]')]
    .some(node => node.dataset.workspace === 'D:\\\\empty-live-project')`,
  '진행 중인 세션이 없는 저장 프로젝트가 프로젝트 사이드바에서 누락됐습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.workspaces = app.state.workspaces.filter(item => item.path !== 'D:\\\\empty-live-project');
    app.render('empty-live-project-restore');
  })()`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('#projectSidebarList [data-workspace]')].find(node => node.dataset.workspace === 'D:\\\\unregistered-origin')?.click()`);
  mark('workspace:select-observed-project');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\unregistered-origin' && window.LoadToAgentApp.filteredSessions().length === 1 && window.LoadToAgentApp.filteredSessions()[0].id === 'fixture-origin' && Boolean(document.querySelector('[data-control-session="fixture-origin"]'))`, '감지된 폴더별 세션 필터가 홈 관제 구조에 적용되지 않았습니다.');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('#projectSidebarList [data-workspace]')].find(node => node.dataset.workspace === 'D:\\\\unregistered-origin')?.click()`);
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\unregistered-origin'
    && Boolean(document.querySelector('[data-control-session="fixture-origin"]'))`,
  '선택한 프로젝트를 다시 눌렀을 때 프로젝트 선택이 유지되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    window.LoadToAgentApp.state.workspace = 'all';
    window.LoadToAgentApp.render('filter');
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'all'
    && document.body.dataset.projectSelected === 'false'`,
  '프로젝트 전체 컨텍스트 복원에 실패했습니다.');
  await click(win, '[data-view="active"]', 'nav:active');
  await waitFor(win, `document.querySelector('[data-session-id="fixture-ended"] .memory-record-intent small')?.textContent.includes('작업 파일 위치: 화면 개선')`, '지난 작업 카드에 작업 파일 위치가 명시되지 않았습니다.');
  await click(win, '[data-view="all"]', 'nav:all');
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.workspaces.push({ name: 'board-migration-loop', path: 'C:\\\\Users\\\\fixture\\\\board-migration-loop' });
    const session = app.state.snapshot.sessions.find(item => item.id === 'fixture-live-0');
    session.originCwd = '/mnt/c/Users/fixture/board-migration-loop';
    app.render('wsl-project-alias');
  })()`);
  await waitFor(win, `(() => {
    const chip = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
      .find(item => item.dataset.workspace === 'C:\\\\Users\\\\fixture\\\\board-migration-loop');
    return chip?.querySelector('.project-sidebar-copy small')?.textContent.includes('세션 1')
      && chip?.querySelector('.project-sidebar-live')?.getAttribute('aria-label')?.includes('1')
      && ![...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .some(item => item.dataset.workspace === '/mnt/c/Users/fixture/board-migration-loop');
  })()`, 'Windows 프로젝트와 같은 WSL 실행 경로를 하나의 진행 중 프로젝트로 합치지 못했습니다.');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('#projectSidebarList [data-workspace]')]
    .find(item => item.dataset.workspace === 'C:\\\\Users\\\\fixture\\\\board-migration-loop')?.click()`);
  mark('workspace:select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'C:\\\\Users\\\\fixture\\\\board-migration-loop'
    && window.LoadToAgentApp.graphFilteredSessions().some(session => session.id === 'fixture-live-0')
    && Boolean(document.querySelector('[data-control-session="fixture-live-0"]'))
    && !document.querySelector('#emptyState:not(.hidden)')`,
  '세션 0개로 보이던 Windows 프로젝트를 선택했을 때 같은 WSL 진행 세션이 홈에서 사라졌습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.workspace = 'all';
    app.state.workspaces = app.state.workspaces.filter(item => item.path !== 'C:\\\\Users\\\\fixture\\\\board-migration-loop');
    const session = app.state.snapshot.sessions.find(item => item.id === 'fixture-live-0');
    session.originCwd = 'D:\\\\fixture';
    app.render('wsl-project-alias-restore');
  })()`);
  await click(win, '[data-view="active"]', 'nav:active');
  win.setSize(480, 720);
  await sleep(120);
  await click(win, '#mobileMoreBtn', 'mobile:more');
  if (!await win.webContents.executeJavaScript(`document.querySelector('.mobile-project-picker')?.open`)) {
    await click(win, '.mobile-project-picker > summary', 'mobile:project-picker');
  }
  await click(win, '[data-workspace="__projectless__"]', 'workspace:select-projectless');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === '__projectless__'
    && document.querySelectorAll('#sessionGrid [data-session-id]').length === 1
    && Boolean(document.querySelector('[data-session-id="fixture-projectless"]'))`,
  '작업 시작 폴더 정보가 없는 지난 작업 필터가 적용되지 않았습니다.');
  const projectlessMobileMetrics = await win.webContents.executeJavaScript(`(() => ({
    intent: document.querySelector('[data-session-id="fixture-projectless"] .memory-record-intent small')?.textContent || '',
    summary: document.querySelector('#sessionResultSummary')?.textContent || '',
    menuHidden: document.querySelector('#mobileToolsMenu')?.classList.contains('hidden') || false,
    expectedProjectlessLabel: window.LoadToAgentI18n.t('ui.no_project'),
  }))()`);
  assert(projectlessMobileMetrics.intent.includes(projectlessMobileMetrics.expectedProjectlessLabel)
    && projectlessMobileMetrics.summary.includes('1'),
    `프로젝트 없음 결과의 위치·건수 안내가 올바르지 않습니다: ${JSON.stringify(projectlessMobileMetrics)}`);
  await waitFor(win, `document.querySelector('#mobileToolsMenu').classList.contains('hidden') && !document.querySelector('#appShell').inert`, '모바일 프로젝트 필터를 고른 뒤 메뉴와 배경 상태가 복원되지 않았습니다.');
  await click(win, '#mobileMoreBtn', 'mobile:more');
  if (!await win.webContents.executeJavaScript(`document.querySelector('.mobile-project-picker')?.open`)) {
    await click(win, '.mobile-project-picker > summary', 'mobile:project-picker');
  }
  await click(win, '#mobileWorkspaceList [data-workspace="all"]', 'workspace:select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'all'
    && document.querySelector('#mobileToolsMenu').classList.contains('hidden')
    && !document.querySelector('#appShell').inert`, '모바일 프로젝트 없음 필터에서 전체 프로젝트로 돌아오지 못했습니다.');
  await click(win, '#mobileMoreBtn', 'mobile:more');
  if (!await win.webContents.executeJavaScript(`document.querySelector('.mobile-project-picker')?.open`)) {
    await click(win, '.mobile-project-picker > summary', 'mobile:project-picker');
  }
  await click(win, '#mobileWorkspaceList [data-workspace="D:\\\\fixture"]', 'workspace:select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'`, 'workspace 선택이 적용되지 않았습니다.');
  await click(win, '#mobileMoreBtn', 'mobile:more');
  if (!await win.webContents.executeJavaScript(`document.querySelector('.mobile-project-picker')?.open`)) {
    await click(win, '.mobile-project-picker > summary', 'mobile:project-picker');
  }
  await click(win, '#mobileWorkspaceList [data-workspace="all"]', 'workspace:select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'all'`, '모바일 작업 폴더 선택 뒤 전체 프로젝트로 돌아오지 못했습니다.');
  await clearCalls(win);
  await click(win, '#mobileMoreBtn', 'mobile:more');
  if (!await win.webContents.executeJavaScript(`document.querySelector('.mobile-project-picker')?.open`)) {
    await click(win, '.mobile-project-picker > summary', 'mobile:project-picker');
  }
  await click(win, '#mobileWorkspaceList [data-remove-workspace="D:\\\\fixture"]', 'workspace:remove');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'removeWorkspace')`, 'workspace 제거가 호출되지 않았습니다.');
  if (!await win.webContents.executeJavaScript(`document.querySelector('#mobileToolsMenu').classList.contains('hidden')`)) {
    await click(win, '#mobileToolsCloseBtn', 'mobile:close');
  }
  await waitFor(win, `document.querySelector('#mobileToolsMenu').classList.contains('hidden') && !document.querySelector('#appShell').inert`, '모바일 저장 프로젝트 제거 뒤 메뉴 상태가 복원되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    if (!app.state.workspaces.some(item => item.path === 'D:\\\\fixture')) {
      app.state.workspaces.unshift({ name: 'fixture', path: 'D:\\\\fixture' });
    }
    app.state.dismissedProjects.clear();
    localStorage.removeItem(app.PROJECT_DISMISSALS_STORAGE_KEY);
    app.render('workspace-remove-fixture-restore');
  })()`);
  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#mobileProviderFilterSelect');
    select.value = 'gpt';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await recordExercise(win, '#mobileProviderFilterSelect');
  await waitFor(win, `window.LoadToAgentApp.state.providerFilters.size === 1
    && window.LoadToAgentApp.state.providerFilters.has('gpt')
    && document.querySelector('#mobileProviderFilterSelect')?.value === 'gpt'
    && [...document.querySelectorAll('#sessionGrid [data-session-id]')].every(card => window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === card.dataset.sessionId)?.provider === 'gpt')`,
  '모바일 AI 선택 목록이 GPT 작업만 표시하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#mobileProviderFilterSelect');
    select.value = 'all';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.providerFilters.size === 0
    && document.querySelector('#mobileProviderFilterSelect')?.value === 'all'`,
  '모바일 AI 선택 목록이 모든 AI 보기로 돌아오지 못했습니다.');
  win.setSize(1440, 940);
  await waitFor(win, `window.innerWidth > 720
    && document.querySelector('[data-provider-filter="gpt"]')?.getClientRects().length > 0
    && getComputedStyle(document.querySelector('[data-provider-filter="gpt"]')).display !== 'none'`,
  '모바일 AI 선택 검사 뒤 데스크톱 AI 선택 버튼이 다시 나타나지 않았습니다.');

  await click(win, '[data-provider-filter="gpt"]', 'filter:provider');
  await waitFor(win, `window.LoadToAgentApp.state.provider === 'gpt' && window.LoadToAgentApp.state.providerFilters.has('gpt') && document.querySelector('[data-provider-filter="gpt"]')?.getAttribute('aria-pressed') === 'true' && document.querySelectorAll('#sessionGrid [data-session-id]').length > 0 && [...document.querySelectorAll('#sessionGrid [data-session-id]')].every(card => window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === card.dataset.sessionId)?.provider === 'gpt')`, '제공사 필터 칩이 실제 GPT 결과에 적용되지 않았습니다.');
  await click(win, '[data-provider-filter="codex"]', 'filter:provider');
  await waitFor(win, `window.LoadToAgentApp.state.provider === 'multiple' && window.LoadToAgentApp.state.providerFilters.has('gpt') && window.LoadToAgentApp.state.providerFilters.has('codex') && document.querySelector('[data-provider-filter="codex"]')?.getAttribute('aria-pressed') === 'true'`, '제공사 다중 필터가 적용되지 않았습니다.');
  await waitFor(win, `(() => {
    const chip = document.querySelector('[data-provider-filter="codex"]');
    const check = chip?.querySelector('.provider-filter-check');
    return chip?.classList.contains('selected')
      && chip?.getAttribute('aria-pressed') === 'true'
      && check?.textContent.trim() === '✓';
  })()`, '제공사 필터 칩에 선택 상태와 체크 표시가 유지되지 않습니다.');
  assert(await win.webContents.executeJavaScript(`(() => { const providers = [...document.querySelectorAll('#sessionGrid [data-session-id]')].map(card => window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === card.dataset.sessionId)?.provider); return providers.length >= 2 && providers.includes('gpt') && providers.includes('codex') && providers.every(provider => ['gpt', 'codex'].includes(provider)); })()`), '다중 필터가 GPT와 Codex 실제 결과를 함께 표시하지 못했습니다.');
  await click(win, '[data-provider-filter="gpt"]', 'filter:provider');
  await waitFor(win, `window.LoadToAgentApp.state.provider === 'codex' && !window.LoadToAgentApp.state.providerFilters.has('gpt') && document.querySelectorAll('#sessionGrid [data-session-id]').length > 0 && [...document.querySelectorAll('#sessionGrid [data-session-id]')].every(card => window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === card.dataset.sessionId)?.provider === 'codex')`, '다중 필터에서 GPT를 해제한 뒤 Codex 결과만 남지 않았습니다.');
  await click(win, '[data-provider-filter="all"]', 'filter:provider');
  await waitFor(win, `window.LoadToAgentApp.state.provider === 'all'
    && window.LoadToAgentApp.state.providerFilters.size === 0
    && document.querySelector('[data-provider-filter="all"]')?.getAttribute('aria-pressed') === 'true'
    && document.querySelectorAll('#sessionGrid [data-session-id]').length > 0
    && new Set([...document.querySelectorAll('#sessionGrid [data-session-id]')]
      .map(card => window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === card.dataset.sessionId)?.provider)
      .filter(Boolean)).size > 1`,
  '제공사 필터 전체 보기를 복원하지 못했습니다.');
  for (const providerId of ['claude', 'gpt', 'gemini', 'grok', 'codex']) await click(win, `[data-provider-filter="${providerId}"]`, 'filter:provider');
  await waitFor(win, `window.LoadToAgentApp.state.providerFilters.size === 0 && document.querySelector('[data-provider-filter="all"]')?.getAttribute('aria-pressed') === 'true'`, '모든 AI를 개별 선택했을 때 전체 보기로 정규화되지 않았습니다.');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#providerFilterStatus').textContent.includes('결과')`), '필터 결과가 스크린리더 상태 영역에 안내되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => { const chip = document.querySelector('[data-provider-filter="all"]'); chip.focus(); chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); })()`);
  await waitFor(win, `document.activeElement?.dataset.providerFilter === 'claude'`, '제공사 필터 방향키 이동 실패');
  await click(win, '[data-view="all"]', 'nav:all');
  const workspaceKeyboard = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#projectSidebarList');
    const workspace = document.querySelector('#projectSidebarList [data-workspace]');
    const event = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true });
    workspace.focus();
    workspace.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      itemCount: list.querySelectorAll('[data-workspace]').length,
      activeWorkspace: document.activeElement?.dataset.workspace || '',
    };
  })()`);
  assert(workspaceKeyboard.defaultPrevented && workspaceKeyboard.itemCount > 1,
    `작업 폴더 End 키 이동 실패: ${JSON.stringify(workspaceKeyboard)}`);
  await click(win, '[data-view="active"]', 'nav:active');
  mark('filter:keyboard-roaming');

  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#searchInput'); input.value = '지난 작업 34'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await recordExercise(win, '#searchInput');
  await waitFor(win, `window.LoadToAgentApp.state.search === '지난 작업 34' && document.querySelectorAll('#sessionGrid [data-session-id]').length === 1 && !document.querySelector('#searchClearBtn').classList.contains('hidden') && document.querySelector('#globalStatus').textContent.includes('1')`, '검색 필터와 결과 알림이 결과를 좁히지 못했습니다.');
  await click(win, '#searchClearBtn', 'filter:search-clear');
  await waitFor(win, `window.LoadToAgentApp.state.search === '' && document.querySelector('#searchInput').value === '' && document.querySelector('#searchClearBtn').classList.contains('hidden') && document.activeElement?.id === 'searchInput'`, '검색 지우기 버튼이 검색과 포커스를 초기화하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#searchInput');
    input.value = 'fixture';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.search === 'fixture'
    && document.querySelector('#searchInput')?.value === 'fixture'`, '복합 필터 검색 조건이 적용되지 않았습니다.');
  await click(win, '[data-provider-filter="gpt"]', 'filter:provider', 1, 20);
  await waitFor(win, `window.LoadToAgentApp.state.providerFilters.size === 1
    && window.LoadToAgentApp.state.providerFilters.has('gpt')`, '복합 필터 제공사 조건이 적용되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#memoryWorkspaceFilter');
    select.value = 'D:\\\\fixture';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await recordExercise(win, '#memoryWorkspaceFilter');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'
    && document.querySelector('#memoryWorkspaceFilter')?.value === 'D:\\\\fixture'
    && [...document.querySelectorAll('#sessionGrid [data-session-id]')].every(card => {
      const session = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === card.dataset.sessionId);
      return Boolean(session && window.LoadToAgentApp.matchesWorkspaceFilter(session));
    })`,
    '지난 작업 프로젝트 선택기가 fixture 프로젝트 결과만 표시하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const sort = document.querySelector('#sortSelect');
    sort.value = 'tokens';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.sort === 'tokens'
    && document.querySelector('#sortSelect')?.value === 'tokens'
    && !document.querySelector('#resetFiltersBtn').classList.contains('hidden')`, '복합 필터가 모두 적용되거나 초기화 버튼이 표시되지 않았습니다.');
  await click(win, '#resetFiltersBtn', 'filter:reset-all', 1, 20);
  await waitForDashboardDefaults(win, '필터 전체 초기화가 검색·AI·작업 폴더·정렬·렌더링을 안정적으로 복원하지 못했습니다.');

  for (const value of ['tokens', 'context', 'recent']) {
    await win.webContents.executeJavaScript(`(() => { const select = document.querySelector('#sortSelect'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  }
  await recordExercise(win, '#sortSelect');
  assert(await win.webContents.executeJavaScript(`window.LoadToAgentApp.state.sort`) === 'recent', '정렬 select 최종 상태가 recent가 아닙니다.');
  await waitFor(win, `!document.querySelector('#loadMoreBtn').classList.contains('hidden')`, '더보기 fixture가 표시되지 않았습니다.');
  const beforeCards = await win.webContents.executeJavaScript(`document.querySelectorAll('#sessionGrid [data-session-id]').length`);
  await click(win, '#loadMoreBtn', 'filter:load-more');
  const afterCards = await win.webContents.executeJavaScript(`document.querySelectorAll('#sessionGrid [data-session-id]').length`);
  assert(beforeCards === 30 && afterCards > beforeCards, `더보기 카드 수가 증가하지 않았습니다: ${beforeCards} -> ${afterCards}`);

  await prepareProjectFirstStep(win);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#searchInput');
    input.value = 'NO_RESULT_FOR_OPEN_RUN';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, `!document.querySelector('#emptyState').classList.contains('hidden')
    && [...document.querySelectorAll('[data-open-run]')].some(button => button.getClientRects().length > 0)`,
  '빈 결과의 새 작업 버튼이 표시되지 않았습니다.');
  await click(win, '[data-open-run]', 'run:open-empty');
  await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden')`, 'empty-window.LoadToAgentApp.state 새 작업 버튼이 모달을 열지 못했습니다.');
  await click(win, '#closeRunModalBtn', 'run:close-x');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, 'empty-window.LoadToAgentApp.state 모달 닫기 실패');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#searchInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.search === '' && document.querySelector('#emptyState').classList.contains('hidden')`,
    '빈 결과 새 작업 테스트 뒤 검색 상태를 복원하지 못했습니다.');
  round.observed.dashboardControls = true;
}

async function exerciseRuntimeOverview(win, round) {
  await click(win, '[data-view="all"]', 'nav:all');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#automationOverview').classList.contains('hidden')`), '홈 화면에 독립 관제 탭 내용이 남아 있습니다.');
  await click(win, '[data-view="active"]', 'nav:active');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#automationOverview').classList.contains('hidden')`), '진행 중 화면에 독립 관제 탭 내용이 남아 있습니다.');
  await click(win, '[data-view="runtime"]', 'nav:runtime');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'runtime' && document.querySelector('[data-view="runtime"]').classList.contains('active')`, '스케줄·루프 독립 탭이 열리지 않았습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('.main-stage')?.scrollTo(0, 0)`);
  await waitFor(win, `(() => {
    const section = document.querySelector('#automationOverview');
    return Boolean(section && !section.classList.contains('hidden')
      && section.querySelectorAll('.runtime-schedule-card').length === 7
      && section.querySelectorAll('.runtime-schedule-card[data-automation-enabled="false"]').length === 2
      && section.querySelectorAll('[data-loop-phase]').length === 4
      && section.querySelectorAll('[data-loop-phase].active').length === 1
      && section.querySelectorAll('[data-loop-select]').length === 6
      && section.querySelector('.runtime-loop-cycle')?.getAttribute('aria-label')?.includes('결과 확인 필요')
      && section.querySelector('.runtime-loop-footer')?.textContent.includes('정해 둔 시간에 자동으로 시작')
      && section.scrollWidth <= section.clientWidth + 2);
  })()`, '스케줄·루프 관제 패널이 실제 상태를 표시하지 못했습니다.');

  const filterContracts = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const originalWorkspace = app.state.workspace;
    const originalSearch = app.state.search;
    const originalProviders = new Set(app.state.providerFilters);
    app.state.workspace = '__projectless__';
    app.state.providerFilters = new Set(['claude']);
    app.state.search = '격주 금요일 검수';
    const schedulesWithHiddenFilters = app.visibleAutomations().length;
    const loopsWithHiddenFilters = app.activeRootLoops().length;
    app.state.workspace = originalWorkspace;
    app.state.search = originalSearch;
    app.state.providerFilters = originalProviders;
    const probe = document.createElement('span');
    probe.dataset.runtimeStartedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    document.querySelector('#automationOverview').append(probe);
    app.refreshRuntimeTimes();
    const refreshedElapsed = probe.textContent.includes('5분');
    probe.remove();
    return { schedulesWithHiddenFilters, loopsWithHiddenFilters, refreshedElapsed };
  })()`);
  assert(filterContracts.schedulesWithHiddenFilters === 7 && filterContracts.loopsWithHiddenFilters === 6, `숨겨진 홈 필터가 독립 런타임 탭 결과를 제한합니다: ${JSON.stringify(filterContracts)}`);
  assert(filterContracts.refreshedElapsed, `실행 시간 경과 표시가 갱신되지 않았습니다: ${JSON.stringify(filterContracts)}`);

  const runtimeSemantics = await win.webContents.executeJavaScript(`(() => {
    const section = document.querySelector('#automationOverview');
    const tabs = [...section.querySelectorAll('.runtime-loop-tabs [role="tab"]')];
    const panels = [...section.querySelectorAll('[role="tabpanel"]')];
    const tabRelations = tabs.map(tab => {
      const controlledId = tab.getAttribute('aria-controls') || '';
      const controlledPanels = panels.filter(panel => panel.id === controlledId);
      return {
        tabId: tab.id,
        selected: tab.getAttribute('aria-selected') === 'true',
        controlledId,
        panelCount: controlledPanels.length,
        panelLabel: controlledPanels[0]?.getAttribute('aria-labelledby') || '',
        panelHidden: controlledPanels[0]?.hidden ?? null,
      };
    });
    const orphanedPanels = panels.filter(panel => {
      const tab = document.getElementById(panel.getAttribute('aria-labelledby') || '');
      return !tab || tab.getAttribute('role') !== 'tab' || tab.getAttribute('aria-controls') !== panel.id;
    }).map(panel => panel.id);
    return {
      scheduleRole: section.querySelector('.runtime-schedule-list')?.getAttribute('role'),
      scheduleListTabIndex: section.querySelector('.runtime-schedule-list')?.tabIndex,
      scheduleItems: section.querySelectorAll('.runtime-schedule-list [role="listitem"]').length,
      scheduleButtons: section.querySelectorAll('.runtime-schedule-list button[data-automation-id]').length,
      scheduleOptions: section.querySelectorAll('.runtime-schedule-list [role="option"]').length,
      scheduleTabStops: [...section.querySelectorAll('.runtime-schedule-list button[data-automation-id]')].filter(item => item.tabIndex === 0).length,
      loopRole: section.querySelector('.runtime-loop-tabs')?.getAttribute('role'),
      loopTabs: tabs.length,
      loopPanels: panels.length,
      loopTabStops: tabs.filter(tab => tab.tabIndex === 0).length,
      selectedTabs: tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').length,
      pressedTabs: tabs.filter(tab => tab.hasAttribute('aria-pressed')).length,
      visiblePanels: panels.filter(panel => !panel.hidden).length,
      orphanedPanels,
      tabRelations,
    };
  })()`);
  assert(runtimeSemantics.scheduleRole === 'list'
    && runtimeSemantics.scheduleListTabIndex === -1
    && runtimeSemantics.scheduleItems === 7
    && runtimeSemantics.scheduleOptions === 0
    && runtimeSemantics.scheduleButtons > 0
    && runtimeSemantics.scheduleTabStops === runtimeSemantics.scheduleButtons
    && runtimeSemantics.loopRole === 'tablist'
    && runtimeSemantics.loopTabs === 6
    && runtimeSemantics.loopPanels === runtimeSemantics.loopTabs
    && runtimeSemantics.loopTabStops === 1
    && runtimeSemantics.selectedTabs === 1
    && runtimeSemantics.pressedTabs === 0
    && runtimeSemantics.visiblePanels === 1
    && runtimeSemantics.orphanedPanels.length === 0
    && runtimeSemantics.tabRelations.every(relation => relation.controlledId
      && relation.panelCount === 1
      && relation.panelLabel === relation.tabId
      && relation.panelHidden === !relation.selected),
  `런타임 목록·탭 ARIA 계약 실패: ${JSON.stringify(runtimeSemantics)}`);

  const singleLoopSemantics = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const originalSnapshot = app.state.snapshot;
    const originalSelectedLoopId = app.state.selectedRuntimeLoopId;
    const loops = app.activeRootLoops();
    const selectedId = loops[0]?.id || '';
    const loopIds = new Set(loops.map(loop => loop.id));
    let semantics;
    try {
      app.state.snapshot = {
        ...originalSnapshot,
        sessions: originalSnapshot.sessions.filter(session => !loopIds.has(session.id) || session.id === selectedId),
      };
      app.state.selectedRuntimeLoopId = selectedId;
      app.renderRuntimeOverview();
      const section = document.querySelector('#automationOverview');
      const detail = section.querySelector('.runtime-loop-detail');
      semantics = {
        tabs: section.querySelectorAll('[role="tab"]').length,
        panels: section.querySelectorAll('[role="tabpanel"]').length,
        detailRole: detail?.getAttribute('role') || '',
        detailLabel: detail?.getAttribute('aria-labelledby') || '',
      };
    } finally {
      app.state.snapshot = originalSnapshot;
      app.state.selectedRuntimeLoopId = originalSelectedLoopId;
      app.renderRuntimeOverview();
    }
    return semantics;
  })()`);
  assert(singleLoopSemantics.tabs === 0
    && singleLoopSemantics.panels === 0
    && singleLoopSemantics.detailRole === ''
    && singleLoopSemantics.detailLabel === '',
  `단일 런타임 상세가 존재하지 않는 탭을 참조합니다: ${JSON.stringify(singleLoopSemantics)}`);
  mark('quality:runtime-schedule-keyboard');
  await click(win, '.runtime-other-work > summary', 'runtime:other-work');
  await waitFor(win, `document.querySelector('.runtime-other-work')?.open
    && document.querySelector('.runtime-loop-tabs')?.getClientRects().length > 0`,
  '다른 실행 중 작업 펼치기가 루프 선택 탭을 보여주지 못했습니다.');
  const selectedLoopBefore = await win.webContents.executeJavaScript(`document.querySelector('.runtime-loop-tabs [aria-selected="true"]')?.dataset.loopSelect`);
  await win.webContents.executeJavaScript(`(() => {
    const selected = document.querySelector('.runtime-loop-tabs [aria-selected="true"]');
    selected?.focus({ preventScroll: true });
    selected?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  })()`);
  await waitFor(win, `document.querySelector('.runtime-loop-tabs [aria-selected="true"]')?.dataset.loopSelect !== ${JSON.stringify(selectedLoopBefore)} && document.activeElement === document.querySelector('.runtime-loop-tabs [aria-selected="true"]') && document.querySelectorAll('.runtime-loop-tabs [tabindex="0"]').length === 1`, '런타임 루프 탭 방향키 선택 실패');
  mark('quality:runtime-loop-keyboard');

  await click(win, '.runtime-schedule-lane > summary', 'runtime:schedule-lane');
  await waitFor(win, `document.querySelector('.runtime-schedule-lane')?.open
    && document.querySelector('.runtime-schedule-list')?.getClientRects().length > 0`,
  '반복 일정 펼치기가 예약 목록을 보여주지 못했습니다.');
  const scrollContract = await win.webContents.executeJavaScript(`(() => {
    const scheduleList = document.querySelector('.runtime-schedule-list');
    const loopTabs = document.querySelector('.runtime-loop-tabs');
    scheduleList.scrollTop = Math.min(84, scheduleList.scrollHeight - scheduleList.clientHeight);
    loopTabs.scrollLeft = Math.min(190, loopTabs.scrollWidth - loopTabs.clientWidth);
    scheduleList.focus();
    return {
      beforeTop: scheduleList.scrollTop,
      beforeLeft: loopTabs.scrollLeft,
      verticalScrollable: scheduleList.scrollHeight > scheduleList.clientHeight + 1,
      horizontalScrollable: loopTabs.scrollWidth > loopTabs.clientWidth + 1,
      focusable: document.activeElement === scheduleList,
    };
  })()`);
  await win.webContents.executeJavaScript(`window.interactionTest.emitSnapshot()`);
  await waitFor(win, `document.activeElement === document.querySelector('.runtime-schedule-list')`, 'snapshot 뒤 예약 목록 포커스가 복원되지 않았습니다.');
  const scrollAfter = await win.webContents.executeJavaScript(`(() => ({
    top: document.querySelector('.runtime-schedule-list').scrollTop,
    left: document.querySelector('.runtime-loop-tabs').scrollLeft,
  }))()`);
  assert(scrollContract.focusable
    && (!scrollContract.verticalScrollable || scrollContract.beforeTop > 0)
    && (!scrollContract.horizontalScrollable || scrollContract.beforeLeft > 0),
  `스크롤 보존 fixture가 유효하지 않습니다: ${JSON.stringify(scrollContract)}`);
  assert(scrollAfter.top === scrollContract.beforeTop && scrollAfter.left === scrollContract.beforeLeft, `snapshot 뒤 런타임 스크롤 위치가 바뀌었습니다: ${JSON.stringify({ scrollContract, scrollAfter })}`);

  await click(win, '[data-loop-select="fixture-live-0"]', 'runtime:select-loop');
  await waitFor(win, `(() => {
    const tab = document.querySelector('[data-loop-select="fixture-live-0"]');
    const panels = [...document.querySelectorAll('#automationOverview [role="tabpanel"]')]
      .filter(panel => panel.id === tab?.getAttribute('aria-controls'));
    return window.LoadToAgentApp.state.selectedRuntimeLoopId === 'fixture-live-0'
      && tab?.getAttribute('aria-selected') === 'true'
      && !tab.hasAttribute('aria-pressed')
      && panels.length === 1
      && !panels[0].hidden;
  })()`, '실행 루프 선택이 상태와 탭 패널 관계에 반영되지 않았습니다.');
  assert(await win.webContents.executeJavaScript(`document.querySelector('.runtime-loop-footer')?.textContent.includes('1번째 실행') && !document.querySelector('[data-loop-select="fixture-live-5"]')`), '명시적 루프 회차 또는 일반 실행 세션 제외가 올바르지 않습니다.');

  await click(win, '#automationOverview [data-loop-open]', 'runtime:open-loop');
  await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open') && window.LoadToAgentApp.state.selectedId === 'fixture-live-0'`, '루프에서 작업 상세를 열지 못했습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('#closeDrawerBtn')?.click()`);
  await waitFor(win, `!document.querySelector('#detailDrawer')?.classList.contains('open')`, '루프 상세를 닫지 못했습니다.');

  await click(win, '[data-automation-session="fixture-root"]', 'runtime:open-schedule');
  await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open') && window.LoadToAgentApp.state.selectedId === 'fixture-root'`, '예약 항목과 연결된 작업 상세를 열지 못했습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('#closeDrawerBtn')?.click()`);
  await waitFor(win, `!document.querySelector('#detailDrawer')?.classList.contains('open')`, '예약 상세를 닫지 못했습니다.');

  round.observed.runtimeOverview = await win.webContents.executeJavaScript(`(() => ({
    schedules: document.querySelectorAll('.runtime-schedule-card').length,
    loops: document.querySelectorAll('[data-loop-select]').length,
    phases: [...document.querySelectorAll('[data-loop-phase]')].map(item => ({ phase: item.dataset.loopPhase, state: item.classList.contains('active') ? 'active' : item.classList.contains('done') ? 'done' : 'queued' })),
  }))()`);
}

async function exerciseRunModal(win, round) {
  const projectRequired = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.workspaces = [{ name: 'fixture', path: 'D:\\\\fixture' }];
    app.state.availability = Object.fromEntries(app.state.providers.map(provider => [provider.id, false]));
    app.selectView('runtime');
    const inspect = workspace => {
      app.state.workspace = workspace;
      app.render('filter');
      const opened = app.openRunModal();
      return {
        opened,
        view: app.state.view,
        modalHidden: document.querySelector('#runModal').classList.contains('hidden'),
        backgroundInteractive: !document.querySelector('#appShell').inert,
        projectFocused: document.activeElement?.matches('#projectSidebarList [data-workspace], #sidebarNewProjectBtn, #mobileAddWorkspaceBtn, #mobileMoreBtn') || false,
        activeTarget: document.activeElement?.id || document.activeElement?.dataset?.workspace || '',
        guidance: document.querySelector('#toast').textContent,
        expectedGuidance: window.LoadToAgentI18n.t('run.select_project_first'),
      };
    };
    return {
      projectless: inspect('__projectless__'),
      all: inspect('all'),
    };
  })()`);
  for (const [workspace, result] of Object.entries(projectRequired)) {
    assert(result.opened === false && result.view === 'all' && result.modalHidden && result.backgroundInteractive
      && result.projectFocused && result.guidance === result.expectedGuidance,
    `프로젝트가 선택되지 않은 ${workspace} 상태에서 새 작업을 거부하고 프로젝트 선택을 안내하지 못했습니다: ${JSON.stringify(result)}`);
  }
  await click(win, '#projectSidebarList [data-workspace="D:\\\\fixture"]', 'workspace:select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'`, 'fixture 프로젝트를 새 작업 대상으로 선택하지 못했습니다.');
  await click(win, '#newRunBtn', 'run:open');
  await waitFor(
    win,
    `!document.querySelector('#runModal').classList.contains('hidden') && document.activeElement === document.querySelector('#runPrompt')`,
    '새 작업 모달이 입력창을 열고 포커스하지 않았습니다.',
  );
  await sleep(320);
  const promptFocusStable = await win.webContents.executeJavaScript(`document.activeElement === document.querySelector('#runPrompt')`);
  assert(promptFocusStable, '이전 상세 창의 지연 포커스 복원이 새 작업 입력창 포커스를 빼앗았습니다.');
  const composer = await win.webContents.executeJavaScript(`(() => {
    const prompt = document.querySelector('#runPrompt');
    const providers = document.querySelector('#runProviderPicker');
    const cwd = document.querySelector('#runCwd');
    const picker = document.querySelector('#pickRunCwdBtn');
    const suggestions = document.querySelector('#runWorkspaceSuggestions');
    const providerOptions = [...providers.querySelectorAll('[data-run-provider]')];
    const providerColumns = getComputedStyle(providers).gridTemplateColumns
      .trim().split(' ').map(value => Number.parseFloat(value)).filter(value => Number.isFinite(value) && value > 0);
    return {
      promptFirst: Boolean(prompt && providers && (prompt.compareDocumentPosition(providers) & Node.DOCUMENT_POSITION_FOLLOWING)),
      promptCount: document.querySelector('#runPromptCount')?.textContent.trim(),
      projectName: document.querySelector('#runProjectName')?.textContent.trim(),
      projectLocked: cwd?.value === 'D:\\\\fixture' && cwd.readOnly
        && cwd.getAttribute('aria-readonly') === 'true' && cwd.tabIndex === -1,
      pickerUnavailable: picker?.disabled && picker.classList.contains('hidden') && picker.tabIndex === -1,
      suggestionsUnavailable: suggestions?.classList.contains('hidden')
        && suggestions.getAttribute('aria-hidden') === 'true'
        && !suggestions.querySelector('[data-run-workspace]'),
      providerBalance: providerOptions.length > 0 && providerColumns.length > 0
        && Math.max(...providerColumns) - Math.min(...providerColumns) <= 1,
    };
  })()`);
  assert(composer.promptFirst && composer.promptCount === '0/8,000자' && composer.projectName === 'fixture'
    && composer.projectLocked && composer.pickerUnavailable && composer.suggestionsUnavailable && composer.providerBalance,
  `새 작업 입력 흐름의 프로젝트 잠금 상태가 올바르지 않습니다: ${JSON.stringify(composer)}`);
  mark('run:project-lock');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#appShell').inert && !document.querySelector('#runModal').inert && document.querySelector('#runModal').getAttribute('aria-hidden') === 'false'`), '새 작업 모달이 배경을 보조 기술에서 격리하지 못했습니다.');
  mark('run:background-inert');
  mark('quality:run-provider-balance');
  const runAdvancedInitiallyOpen = await win.webContents.executeJavaScript(`document.querySelector('.run-advanced').open`);
  await click(win, '.run-advanced > summary', 'run:advanced-settings');
  await waitFor(win, `document.querySelector('.run-advanced').open !== ${JSON.stringify(runAdvancedInitiallyOpen)}`, '새 작업 고급 설정 summary가 열림 상태를 전환하지 않았습니다.');
  if (runAdvancedInitiallyOpen) {
    await click(win, '.run-advanced > summary', 'run:advanced-settings');
    await waitFor(win, `document.querySelector('.run-advanced').open`, '새 작업 고급 설정을 다시 열지 못했습니다.');
  }
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#runPrompt').value = '복원할 새 작업 초안';
    document.querySelector('#runCwd').value = 'C:/draft-fixture';
    document.querySelector('#runModel').value = 'draft-model';
    document.querySelector('#allowWrites').checked = true;
    for (const element of document.querySelectorAll('#runPrompt, #runCwd, #runModel')) element.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#allowWrites').dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await recordExercise(win, '#runPrompt');
  await recordExercise(win, '#runModel');
  await waitFor(win, `document.querySelector('#runCwd').value === 'D:\\\\fixture' && document.querySelector('#runCwd').readOnly`, '초안 입력이 잠긴 프로젝트 경로를 바꾸었습니다.');
  await click(win, '#closeRunModalBtn', 'run:close-x');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden') && !document.querySelector('#appShell').inert && document.querySelector('#runModal').inert`, '초안 복원 검증을 위해 모달을 닫고 배경 상호작용을 복원하지 못했습니다.');
  mark('run:background-restore');
  await click(win, '#newRunBtn', 'run:open');
  await waitFor(win, `document.querySelector('#runPrompt').value === '복원할 새 작업 초안' && document.querySelector('#runCwd').value === 'D:\\\\fixture' && document.querySelector('#runCwd').readOnly && document.querySelector('#runModel').value === 'draft-model' && document.querySelector('#allowWrites').checked`, '새 작업 초안을 복원하면서 선택한 프로젝트 잠금을 유지하지 못했습니다.');
  assert(await win.webContents.executeJavaScript(`JSON.parse(sessionStorage.getItem(window.LoadToAgentApp.RUN_DRAFT_STORAGE_KEY)).version === 2`), '새 작업 초안에 버전이 저장되지 않았습니다.');
  mark('quality:run-draft-restore');
  await click(win, '#clearRunDraftBtn', 'run:clear-draft');
  await waitFor(win, `document.querySelector('#runPrompt').value === '' && document.querySelector('#runCwd').value === 'D:\\\\fixture' && document.querySelector('#runCwd').readOnly && document.querySelector('#runModel').value === '' && !document.querySelector('#allowWrites').checked && document.activeElement?.id === 'runPrompt' && !sessionStorage.getItem(window.LoadToAgentApp.RUN_DRAFT_STORAGE_KEY)`, '초안 지우기가 초안 필드·저장값·초점을 초기화하고 선택한 프로젝트를 유지하지 못했습니다.');
  const unavailable = await win.webContents.executeJavaScript(`(() => ({
    docs: document.querySelectorAll('[data-provider-docs]').length,
    disabledProviders: document.querySelectorAll('[data-run-provider]:disabled').length,
    submitDisabled: document.querySelector('#runForm button[type="submit"]').disabled,
  }))()`);
  assert(
    unavailable.docs === 5 && unavailable.disabledProviders === 5 && unavailable.submitDisabled,
    `AI CLI 미설치 상태가 올바르지 않습니다: ${JSON.stringify(unavailable)}`,
  );
  await clearCalls(win);
  for (const provider of ['claude', 'gpt', 'gemini', 'grok', 'codex']) {
    await click(win, `[data-provider-docs="${provider}"]`, 'run:provider-docs');
  }
  await waitFor(
    win,
    `window.interactionTest.getCalls().filter(item => item.name === 'openExternal').length === 5`,
    'AI CLI 공식 문서 버튼 다섯 개가 각각 한 번 호출되어야 합니다.',
  );
  await clearCalls(win);
  await click(win, '[data-provider-recheck]', 'run:provider-recheck');
  await waitFor(
    win,
    `window.interactionTest.getCalls().filter(item => item.name === 'probeProviders').length === 1
      && document.querySelector('#runProviderHelp').classList.contains('hidden')
      && !document.querySelector('#runForm button[type="submit"]').disabled`,
    'AI CLI 재확인이 설치 상태와 실행 가능 상태를 갱신하지 못했습니다.',
  );
  for (const example of ['fix', 'review', 'tests']) {
    await click(win, `[data-run-prompt-key="run.example.${example}"]`, `run:prompt-example-${example}`);
    await waitFor(win, `document.querySelector('#runPrompt').value.length > 0 && document.querySelector('#runPromptCount').textContent !== '0 / 8,000'`, `${example} 빠른 요청 예시가 입력과 글자 수에 반영되지 않았습니다.`);
  }
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#runPrompt'); input.dataset.savedValue = input.value; input.value = 'x'.repeat(7200); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(win, `document.querySelector('#runPromptCount').classList.contains('warning') && document.querySelector('#globalStatus').textContent.includes('800')`, '새 작업 요청이 한도에 가까워져도 글자 수 경고가 표시되거나 안내되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#runPrompt'); input.value = input.dataset.savedValue; delete input.dataset.savedValue; input.dispatchEvent(new Event('input', { bubbles: true })); window.LoadToAgentApp.setRunSubmitting(true); document.querySelector('#cancelRunBtn').click(); })()`);
  assert(await win.webContents.executeJavaScript(`!document.querySelector('#runModal').classList.contains('closing') && document.querySelector('#closeRunModalBtn').disabled && document.querySelector('#cancelRunBtn').disabled`), '새 작업 제출 중 취소나 닫기로 모달 상태가 어긋날 수 있습니다.');
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.setRunSubmitting(false)`);
  mark('run:submit-close-guard');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#runCwd').value === 'D:\\\\fixture'
    && document.querySelector('#runCwd').readOnly
    && document.querySelector('#pickRunCwdBtn').classList.contains('hidden')
    && !document.querySelector('[data-run-workspace]')`), '새 작업 상태 변경 후 선택한 프로젝트 잠금이 풀렸습니다.');
  await click(win, '[data-run-provider="gpt"]', 'run:provider');
  await waitFor(win, `document.querySelector('[data-run-provider="gpt"]').getAttribute('aria-checked') === 'true' && document.querySelector('[data-run-provider="gpt"]').getAttribute('role') === 'radio' && document.querySelector('#runSubmitLabel').textContent.includes('GPT')`, 'AI 선택이 라디오 상태와 실행 버튼에 반영되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => { const option = document.querySelector('[data-run-provider="gpt"]'); option.focus(); option.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); })()`);
  await waitFor(win, `document.querySelector('[data-run-provider="gemini"]')?.getAttribute('aria-checked') === 'true' && document.activeElement?.dataset.runProvider === 'gemini'`, 'AI 선택기 오른쪽 방향키가 다음 AI를 선택하지 못했습니다.');
  mark('run:provider-keyboard');
  await click(win, '[data-run-provider="gpt"]', 'run:provider');

  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#runCwd').value = 'C:/tampered-fixture';
    document.querySelector('#runPrompt').value = '   ';
    document.querySelector('#runPrompt').dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click(win, '#runForm button[type="submit"]', 'run:submit');
  await waitFor(win, `document.querySelector('#runPrompt').getAttribute('aria-invalid') === 'true' && document.activeElement?.id === 'runPrompt' && document.querySelector('#runError').textContent.includes('할 일을 입력하세요') && document.querySelector('#runCwd').value === 'D:\\\\fixture'`, '빈 요청을 거부하고 첫 오류 입력에 초점을 두면서 프로젝트 잠금을 유지하지 못했습니다.');
  mark('quality:run-whitespace-validation');

  await win.webContents.executeJavaScript(`(() => { document.querySelector('#runPrompt').value = ''; document.querySelector('#runPrompt').dispatchEvent(new Event('input', { bubbles: true })); window.interactionTest.clearCalls(); })()`);
  await win.webContents.executeJavaScript(`document.querySelector('#runPrompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))`);
  mark('run:keyboard-submit');
  const nativeInvalid = await win.webContents.executeJavaScript(`(() => ({ calls: window.interactionTest.getCalls().filter(item => item.name === 'runAgent').length, cwd: document.querySelector('#runCwd').matches(':invalid'), cwdValue: document.querySelector('#runCwd').value, cwdReadonly: document.querySelector('#runCwd').readOnly, prompt: document.querySelector('#runPrompt').matches(':invalid'), ariaCwd: document.querySelector('#runCwd').getAttribute('aria-invalid'), ariaPrompt: document.querySelector('#runPrompt').getAttribute('aria-invalid'), visible: !document.querySelector('#runModal').classList.contains('hidden') }))()`);
  assert(nativeInvalid.calls === 0 && !nativeInvalid.cwd && nativeInvalid.cwdValue === 'D:\\fixture'
    && nativeInvalid.cwdReadonly && nativeInvalid.prompt && nativeInvalid.ariaCwd === null
    && nativeInvalid.ariaPrompt === 'true' && nativeInvalid.visible,
  `필수 요청 검증이 잠긴 프로젝트 경로와 접근성 오류 상태를 올바르게 반영하지 못했습니다: ${JSON.stringify(nativeInvalid)}`);
  mark('run:required-validation');

  await win.webContents.executeJavaScript(`(() => {
    window.interactionTest.configure({ failures: { runAgent: 1 } });
    document.querySelector('#runCwd').value = 'C:/failed-fixture';
    document.querySelector('#runModel').value = 'failure-model';
    document.querySelector('#runPrompt').value = '실패해도 보존할 요청';
  })()`);
  await click(win, '#runForm button[type="submit"]', 'run:submit');
  await waitFor(win, `!document.querySelector('#runError').classList.contains('hidden')`, 'runAgent 실패 오류가 표시되지 않았습니다.');
  assert(await win.webContents.executeJavaScript(`document.activeElement?.id === 'runError'`), '새 작업 실행 실패 후 오류 메시지로 초점이 이동하지 않았습니다.');
  const preserved = await win.webContents.executeJavaScript(`(() => ({ cwd: document.querySelector('#runCwd').value, model: document.querySelector('#runModel').value, prompt: document.querySelector('#runPrompt').value }))()`);
  assert(preserved.cwd === 'D:\\fixture' && preserved.model === 'failure-model' && preserved.prompt === '실패해도 보존할 요청', `run 실패 후 선택한 프로젝트 잠금과 입력 필드가 보존되지 않았습니다: ${JSON.stringify(preserved)}`);
  mark('run:failure-preserve');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);

  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#runModel').value = 'gpt-fixture';
    document.querySelector('#runPrompt').value = '실제 DOM submit 검증';
  })()`);
  await click(win, 'label:has(#allowWrites)', 'run:allow-writes');
  await clearCalls(win);
  await click(win, '#runForm button[type="submit"]', 'run:submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'runAgent')`, 'runAgent fixture가 호출되지 않았습니다.');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, '성공 후 새 작업 모달이 닫히지 않았습니다.');
  assert(await callCount(win, 'runAgent') === 1, '새 작업 submit 한 번에 runAgent가 정확히 한 번 호출되어야 합니다.');
  const payload = await win.webContents.executeJavaScript(`window.interactionTest.getCalls().find(item => item.name === 'runAgent').args[0]`);
  assert(payload.cwd === 'D:\\fixture' && payload.model === 'gpt-fixture' && payload.prompt === '실제 DOM submit 검증' && payload.allowWrites === true, `run field payload가 다릅니다: ${JSON.stringify(payload)}`);

  await click(win, '#newRunBtn', 'run:open');
  await click(win, '[data-run-provider="claude"]', 'run:provider');
  await waitFor(win, `document.querySelector('[data-run-provider="claude"]').getAttribute('aria-checked') === 'true'
    && document.querySelector('#runSubmitLabel').textContent.includes('Claude')`,
  'Claude 새 작업 선택이 실행 버튼에 반영되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#runModel').value = 'sonnet';
    document.querySelector('#runPrompt').value = 'Claude 실제 DOM submit 검증';
    document.querySelector('#allowWrites').checked = false;
    document.querySelector('#allowWrites').dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await clearCalls(win);
  await click(win, '#runForm button[type="submit"]', 'run:submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'runAgent')
    && document.querySelector('#runModal').classList.contains('hidden')`,
  'Claude 새 작업 submit이 실행 호출 후 모달을 닫지 못했습니다.');
  const claudePayload = await win.webContents.executeJavaScript(`window.interactionTest.getCalls().find(item => item.name === 'runAgent').args[0]`);
  assert(
    claudePayload.provider === 'claude'
      && claudePayload.cwd === 'D:\\fixture'
      && claudePayload.model === 'sonnet'
      && claudePayload.prompt === 'Claude 실제 DOM submit 검증'
      && claudePayload.allowWrites === false,
    `Claude run field payload가 다릅니다: ${JSON.stringify(claudePayload)}`,
  );
  mark('quality:claude-run-submit');

  await click(win, '#newRunBtn', 'run:open');
  await click(win, '#closeRunModalBtn', 'run:close-x');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, 'X 버튼으로 모달이 닫히지 않았습니다.');
  await click(win, '#newRunBtn', 'run:open');
  await click(win, '#cancelRunBtn', 'run:cancel');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, '취소 버튼으로 모달이 닫히지 않았습니다.');
  await click(win, '#newRunBtn', 'run:open');
  await win.webContents.executeJavaScript(`(() => {
    const form = document.querySelector('#runForm');
    const modal = document.querySelector('#runModal');
    form.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  })()`);
  assert(await win.webContents.executeJavaScript(`!document.querySelector('#runModal').classList.contains('hidden') && !document.querySelector('#runModal').classList.contains('closing')`), '모달 내부에서 시작한 드래그가 배경에서 끝날 때 창이 닫혔습니다.');
  mark('quality:run-safe-backdrop');
  await waitFor(win, `Number(getComputedStyle(document.querySelector('#runModal')).opacity) > 0`, '새 작업 모달 배경이 클릭 가능한 상태가 되지 않았습니다.');
  await click(win, '#runModal', 'run:backdrop');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, '배경 클릭으로 모달이 닫히지 않았습니다.');
  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden') && document.activeElement === document.querySelector('#runPrompt')`, '새 작업 단축키가 입력창을 열고 포커스하지 않았습니다.');
  await click(win, '#cancelRunBtn', 'run:cancel-shortcut');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, '단축키로 연 새 작업 창이 닫히지 않았습니다.');
  round.observed.runAgentCalls = 2;
  round.observed.runComposer = true;
}

async function exerciseDrawer(win, round) {
  await click(win, '[data-view="active"]', 'nav:active');
  const dashboardDirty = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    return Boolean(app.state.search || app.state.providerFilters.size || app.state.workspace !== 'all'
      || app.state.sort !== 'recent' || app.state.controlRoomSort !== 'recent'
      || document.querySelector('#searchInput')?.value
      || !document.querySelector('#resetFiltersBtn')?.classList.contains('hidden'));
  })()`);
  if (dashboardDirty) {
    await waitFor(win, `!document.querySelector('#resetFiltersBtn')?.classList.contains('hidden')`,
      '상세 테스트 준비 중 남아 있는 필터의 초기화 버튼이 표시되지 않았습니다.');
    await click(win, '#resetFiltersBtn', 'filter:reset-all', 1, 20);
  }
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.renderWorkspaces()`);
  await waitForDashboardDefaults(win, '상세 테스트 전에 전체 보기와 필터 기본 상태가 안정화되지 않았습니다.', { requireSearchFocus: false });
  await waitFor(win, `(() => {
    const card = document.querySelector('[data-session-id="fixture-ended"]');
    if (window.LoadToAgentApp.state.view !== 'active' || !card || card.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(card);
    const rect = card.getBoundingClientRect();
    return card.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0;
  })()`, '완료 세션 카드가 클릭 가능한 상태로 표시되지 않았습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('[data-session-id="fixture-ended"]').focus({ preventScroll: true })`);
  await click(win, '[data-session-id="fixture-ended"]', 'drawer:open-card', 1, 20);
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && !document.querySelector('.drawer-loading')`, '상세 drawer 로드 실패');
  const drawerDragSafe = await win.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('#detailDrawer');
    const backdrop = document.querySelector('#drawerBackdrop');
    drawer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 71, button: 0, clientX: 900, clientY: 240 }));
    backdrop.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 71, button: 0, clientX: 500, clientY: 260 }));
    backdrop.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 71, button: 0, clientX: 500, clientY: 260 }));
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 500, clientY: 260 }));
    const insideDragStayedOpen = drawer.classList.contains('open');
    backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 72, button: 0, clientX: 300, clientY: 180 }));
    backdrop.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 72, button: 0, clientX: 360, clientY: 240 }));
    backdrop.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 72, button: 0, clientX: 360, clientY: 240 }));
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 360, clientY: 240 }));
    return { insideDragStayedOpen, backdropDragStayedOpen: drawer.classList.contains('open') };
  })()`);
  assert(drawerDragSafe.insideDragStayedOpen && drawerDragSafe.backdropDragStayedOpen, `상세 drawer가 드래그를 배경 클릭으로 오인해 닫힙니다: ${JSON.stringify(drawerDragSafe)}`);
  mark('quality:drawer-drag-safe');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#appShell').inert && !document.querySelector('#detailDrawer').inert && document.querySelector('#detailDrawer').getAttribute('aria-hidden') === 'false'`), '상세 창이 배경을 보조 기술에서 격리하지 못했습니다.');
  mark('drawer:background-inert');
  await waitFor(win, `Number(getComputedStyle(document.querySelector('#drawerBackdrop')).opacity) > 0
    && getComputedStyle(document.querySelector('#drawerBackdrop')).pointerEvents !== 'none'`, '상세 창 배경이 클릭 가능한 상태가 되지 않았습니다.');
  const replacedDrawerTrigger = await win.webContents.executeJavaScript(`(() => {
    const original = document.querySelector('[data-session-id="fixture-ended"]');
    const replacement = original.cloneNode(true);
    original.replaceWith(replacement);
    return {
      originalDetached: !original.isConnected,
      replacementConnected: replacement.isConnected,
      replacementMatches: replacement.matches('[data-session-id="fixture-ended"]'),
    };
  })()`);
  assert(replacedDrawerTrigger.originalDetached && replacedDrawerTrigger.replacementConnected && replacedDrawerTrigger.replacementMatches,
    `상세 창 트리거 재렌더링 준비 실패: ${JSON.stringify(replacedDrawerTrigger)}`);
  await click(win, '#drawerBackdrop', 'drawer:backdrop');
  await waitFor(win, `(() => {
    const trigger = document.querySelector('[data-session-id="fixture-ended"]');
    return document.querySelector('#drawerBackdrop').classList.contains('hidden')
      && !document.querySelector('#appShell').inert
      && document.activeElement === trigger
      && trigger.isConnected
      && !trigger.closest('[hidden], [inert], [aria-hidden="true"], .hidden');
  })()`, '재렌더링된 상세 창 트리거로 안전하게 초점이 복원되지 않았습니다.');
  mark('drawer:focus-rerender-restore');
  await win.webContents.executeJavaScript(`(() => {
    const firstTrigger = document.querySelector('[data-session-id="fixture-ended"]');
    firstTrigger.focus({ preventScroll: true });
    window.LoadToAgentApp.openDrawer('fixture-ended');
  })()`);
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')`, '빠른 재열기 검증용 첫 상세 창을 열지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    window.LoadToAgentApp.closeDrawer();
    const nextTrigger = document.querySelector('#searchInput');
    nextTrigger.focus({ preventScroll: true });
    window.LoadToAgentApp.openDrawer('fixture-root');
  })()`);
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && window.LoadToAgentApp.state.selectedId === 'fixture-root'`, '닫힘 애니메이션 중 다른 상세 창을 다시 열지 못했습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')
    && document.activeElement === document.querySelector('#searchInput')`,
  '상세 창을 빠르게 바꿔 연 뒤 새 트리거로 초점이 복원되지 않았습니다.');
  mark('drawer:rapid-reopen-focus-restore');
  await click(win, '[data-session-id="fixture-ended"]', 'drawer:open-card');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && !document.querySelector('.drawer-loading')`, '상세 창 배경 검증 뒤 완료 세션을 다시 열지 못했습니다.');
  await clearCalls(win);
  await click(win, '[data-copy-text]', 'drawer:copy');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'writeClipboard') && document.querySelector('#globalStatus').textContent.includes('복사')`, '상세 창의 전체 식별자 복사가 동작하거나 안내되지 않았습니다.');
  for (const tab of ['summary', 'lifecycle', 'tokens', 'chat']) {
    await click(win, `[data-tab="${tab}"]`, `drawer:tab-${tab}`);
    await waitFor(win, `window.LoadToAgentApp.state.drawerTab === ${JSON.stringify(tab)} && document.querySelector('[data-tab="${tab}"]').classList.contains('active')`, `${tab} 탭 전환 실패`);
  }
  assert(await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-conversation-context="fixture-ended"] .conversation-context-track[role="progressbar"]'))`),
    '대화 탭에 현재 컨텍스트 실시간 게이지가 표시되지 않았습니다.');
  const collapsedPrompt = await win.webContents.executeJavaScript(`(() => {
    const prompt = document.querySelector('[data-message-id="ended-user"] [data-user-prompt]');
    const content = prompt?.querySelector('.chat-content');
    const copy = prompt?.querySelector('[data-user-prompt-copy]');
    const toggle = prompt?.querySelector('[data-prompt-toggle]');
    return {
      truncated: prompt?.dataset.promptTruncated,
      expanded: prompt?.dataset.promptExpanded,
      preview: content?.innerText || '',
      fullText: copy?.dataset.copyText || '',
      toggleLabel: toggle?.textContent.trim() || '',
      copyLabel: copy?.textContent.trim() || '',
    };
  })()`);
  assert(collapsedPrompt.truncated === 'true' && collapsedPrompt.expanded === 'false'
    && Array.from(collapsedPrompt.preview).length <= 201 && collapsedPrompt.preview.endsWith('…')
    && Array.from(collapsedPrompt.fullText).length > 200
    && collapsedPrompt.toggleLabel === '전체 내용 보기' && collapsedPrompt.copyLabel === '요청 복사',
  `200자 초과 프롬프트의 접기·복사 UI가 올바르지 않습니다: ${JSON.stringify(collapsedPrompt)}`);
  await click(win, '[data-message-id="ended-user"] [data-prompt-toggle]', 'drawer:prompt-toggle');
  await waitFor(win, `document.querySelector('[data-message-id="ended-user"] [data-user-prompt]')?.dataset.promptExpanded === 'true'
    && document.querySelector('[data-message-id="ended-user"] [data-prompt-toggle]')?.textContent.trim() === '내용 접기'
    && document.querySelector('[data-message-id="ended-user"] .chat-content')?.innerText.includes('실제 전체 문장이 복사되는지도 검증해줘')`,
  '긴 사용자 프롬프트 전체 보기 또는 닫기 전환이 동작하지 않았습니다.');
  win.setSize(640, 900);
  await sleep(160);
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.renderDrawer()`);
  await waitFor(win, `(() => {
    const prompt = document.querySelector('[data-message-id="ended-user"] [data-user-prompt]');
    const close = document.querySelector('[data-close-expanded-reader]');
    return prompt?.dataset.promptExpanded === 'true'
      && close?.getClientRects().length > 0
      && getComputedStyle(close).display !== 'none';
  })()`, '대화창 자동 새로고침 뒤 긴 프롬프트 펼침 상태와 모바일 상단 닫기 버튼이 유지되지 않았습니다.');
  await click(win, '[data-close-expanded-reader]', 'drawer:close-expanded-reader');
  await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')
    && !document.querySelector('#appShell').inert
    && (() => {
      const card = document.querySelector('[data-session-id="fixture-ended"]');
      return card && !card.closest('[hidden], [aria-hidden="true"], [inert]') && card.getClientRects().length > 0;
    })()`, '확장 읽기 상단 닫기 버튼이 상세 창을 닫고 원래 카드를 복원하지 못했습니다.');
  win.setSize(1440, 940);
  await sleep(160);
  await click(win, '[data-view="active"]', 'nav:active');
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-ended')`);
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')
    && document.querySelector('[data-message-id="ended-user"] [data-user-prompt]')?.dataset.promptExpanded === 'true'
    && Boolean(document.querySelector('[data-close-expanded-reader]'))`, '확장 읽기 닫기 뒤 상세를 다시 열거나 펼침 상태를 복원하지 못했습니다.');
  await clearCalls(win);
  await click(win, '[data-message-id="ended-user"] [data-user-prompt-copy]', 'drawer:prompt-copy');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'writeClipboard'
    && item.args[0] === document.querySelector('[data-message-id="ended-user"] [data-user-prompt-copy]')?.dataset.copyText)`,
  '프롬프트 복사 버튼이 축약문이 아닌 전체 원문을 복사하지 못했습니다.');
  await click(win, '[data-message-id="ended-user"] [data-prompt-toggle]', 'drawer:prompt-toggle');
  await waitFor(win, `document.querySelector('[data-message-id="ended-user"] [data-user-prompt]')?.dataset.promptExpanded === 'false'
    && document.querySelector('[data-message-id="ended-user"] [data-prompt-toggle]')?.textContent.trim() === '전체 내용 보기'`,
  '긴 사용자 프롬프트 닫기 버튼이 내용을 다시 접지 못했습니다.');
  await waitFor(win, `document.querySelector('.chat-roadmap') && !document.querySelector('.chat-roadmap').open`, '긴 로드맵이 기본 접힘 상태로 표시되지 않았습니다.');
  const roadmap = await win.webContents.executeJavaScript(`(() => {
    const details = document.querySelector('.chat-roadmap');
    return {
      previewCount: details?.querySelectorAll('.chat-roadmap-preview li').length || 0,
      fullPreserved: details?.querySelector('.chat-roadmap-full')?.textContent.includes('수평 스크롤과 카드 넘침이 없는지 자동 테스트합니다') || false,
      userMessagePreserved: [...document.querySelectorAll('.chat-row.user .chat-content')].some(item => item.innerText.includes('상세 대화에서 생략하지 말고 전체 내용을 보여주되')),
    };
  })()`);
  assert(roadmap.previewCount === 3 && roadmap.fullPreserved && roadmap.userMessagePreserved, `로드맵 요약 또는 상세 원문 보존이 올바르지 않습니다: ${JSON.stringify(roadmap)}`);
  const toolActivityHidden = await win.webContents.executeJavaScript(`(() => ({
    activitySection: Boolean(document.querySelector('.chat-activities:not(.subagent-coordination)')),
    activityText: document.querySelector('#drawerContent').innerText.includes('대화 탭에서 숨겨야 하는 도구 시스템 활동'),
    turnCount: document.querySelectorAll('[data-conversation-turn]').length,
    visibleAssistantRows: document.querySelectorAll('.chat-turn > .chat-row.assistant').length,
    separateProgressPanel: Boolean(document.querySelector('.chat-progress-updates')),
    assistantMessageIds: [...document.querySelectorAll('.chat-turn > .chat-row.assistant')].map(item => item.dataset.messageId),
    answerKinds: [...document.querySelectorAll('.chat-turn > .chat-row.assistant .chat-answer-kind')].map(item => item.textContent.trim()),
  }))()`);
  assert(!toolActivityHidden.activitySection && !toolActivityHidden.activityText && toolActivityHidden.turnCount === 1
    && toolActivityHidden.visibleAssistantRows === 2 && !toolActivityHidden.separateProgressPanel
    && toolActivityHidden.assistantMessageIds.join(',') === 'ended-progress,ended-roadmap'
    && toolActivityHidden.answerKinds.length === 1 && toolActivityHidden.answerKinds[0] === '최종 답변',
  `작업 턴 요약 또는 도구·시스템 활동 숨김이 올바르지 않습니다: ${JSON.stringify(toolActivityHidden)}`);
  const titleOnlyRequest = await win.webContents.executeJavaScript(`(() => {
    const turn = window.LoadToAgentApp.conversationTurns({
      id: 'title-only-session', title: '/scheduled-run --tick fixture', status: 'idle', startedAt: new Date().toISOString(),
      messages: [
        { id: 'progress-1', role: 'assistant', text: '작업 파일을 확인하겠습니다.', timestamp: new Date().toISOString() },
        { id: 'tool-1', role: 'tool', text: '검사 실행', timestamp: new Date().toISOString() },
        { id: 'progress-2', role: 'assistant', text: '이제 검토 에이전트를 실행하겠습니다.', timestamp: new Date().toISOString() },
        { id: 'tool-2', role: 'tool', text: '검토 실행', timestamp: new Date().toISOString() },
      ],
    })[0];
    return { request: turn.user?.text || '', representative: turn.representative?.text || '', updates: turn.progress.length, awaitingFinal: turn.awaitingFinal };
  })()`);
  assert(titleOnlyRequest.request === '/scheduled-run --tick fixture' && titleOnlyRequest.updates === 1 && titleOnlyRequest.awaitingFinal
    && titleOnlyRequest.representative.includes('검토 에이전트'), `제목 기반 요청 복원이나 마지막 진행 상황 판별이 올바르지 않습니다: ${JSON.stringify(titleOnlyRequest)}`);
  fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
  await sleep(120);
  fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'loadtoagent-collapsed-roadmap.png'), (await win.webContents.capturePage()).toPNG());
  await click(win, '.chat-roadmap > summary', 'drawer:expand-roadmap');
  await waitFor(win, `document.querySelector('.chat-roadmap').open && getComputedStyle(document.querySelector('.chat-roadmap-full')).display !== 'none'`, '긴 로드맵 전체 보기가 펼쳐지지 않았습니다.');
  mark('drawer:roadmap-summary');
  await win.webContents.executeJavaScript(`(() => {
    const chat = document.querySelector('[data-tab="chat"]');
    chat.focus();
    chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.drawerTab === 'lifecycle' && document.activeElement?.dataset.tab === 'lifecycle'`, 'drawer ArrowRight 키보드 이동 실패');
  await win.webContents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))`);
  await waitFor(win, `window.LoadToAgentApp.state.drawerTab === 'tokens' && document.activeElement?.dataset.tab === 'tokens'`, 'drawer End 키보드 이동 실패');
  await win.webContents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))`);
  await waitFor(win, `window.LoadToAgentApp.state.drawerTab === 'summary' && document.activeElement?.dataset.tab === 'summary'`, 'drawer Home 키보드 이동 실패');
  await win.webContents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))`);
  await waitFor(win, `window.LoadToAgentApp.state.drawerTab === 'chat' && document.activeElement?.dataset.tab === 'chat'`, 'drawer ArrowDown 키보드 이동 실패');
  await win.webContents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))`);
  await waitFor(win, `window.LoadToAgentApp.state.drawerTab === 'summary' && document.querySelector('.drawer-tabs').getAttribute('aria-orientation') === 'horizontal'`, 'drawer ArrowUp 이동 또는 탭 방향 정보가 올바르지 않습니다.');
  await win.webContents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(win, `window.LoadToAgentApp.state.drawerTab === 'chat' && document.activeElement?.dataset.tab === 'chat'`, 'drawer Ctrl+PageDown 탭 이동 실패');
  await win.webContents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(win, `window.LoadToAgentApp.state.drawerTab === 'summary' && document.activeElement?.dataset.tab === 'summary'`, 'drawer Ctrl+PageUp 탭 이동 실패');
  mark('drawer:tabs-keyboard');
  mark('quality:drawer-page-tabs');
  await click(win, '[data-tab="chat"]', 'drawer:tab-chat');
  await waitFor(win, `window.LoadToAgentApp.state.drawerTab === 'chat'`, '최신 대화 이동 검증을 위해 대화 탭을 복원하지 못했습니다.');
  const latest = await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-scroll-latest]'))`);
  if (latest) await click(win, '[data-scroll-latest]', 'drawer:latest');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, 'drawer 닫기 시작 실패');
  const closeScrollProbe = await win.webContents.executeJavaScript(`(() => {
    const backdrop = document.querySelector('#drawerBackdrop');
    const drawer = document.querySelector('#detailDrawer');
    const stage = document.querySelector('.main-stage');
    const target = Math.min(240, Math.max(0, stage.scrollHeight - stage.clientHeight));
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }));
    stage.scrollTop = target;
    return {
      target,
      backdropPointerEvents: getComputedStyle(backdrop).pointerEvents,
      drawerPointerEvents: getComputedStyle(drawer).pointerEvents,
    };
  })()`);
  assert(
    closeScrollProbe.backdropPointerEvents === 'none' && closeScrollProbe.drawerPointerEvents === 'none',
    `닫히는 drawer가 휠 입력을 가로챕니다: ${JSON.stringify(closeScrollProbe)}`,
  );
  await sleep(350);
  const closeScrollAfter = await win.webContents.executeJavaScript(`(() => ({
    top: document.querySelector('.main-stage').scrollTop,
    drawerOpen: document.querySelector('#detailDrawer').classList.contains('open'),
    backdropHidden: document.querySelector('#drawerBackdrop').classList.contains('hidden'),
  }))()`);
  assert(
    !closeScrollAfter.drawerOpen && closeScrollAfter.backdropHidden && Math.abs(closeScrollAfter.top - closeScrollProbe.target) <= 1,
    `drawer를 닫고 휠을 내린 뒤 창 또는 스크롤 위치가 되돌아왔습니다: ${JSON.stringify({ closeScrollProbe, closeScrollAfter })}`,
  );
  mark('drawer:close-scroll');

  await win.webContents.executeJavaScript(`window.interactionTest.clearCalls(); window.interactionTest.configure({ failures: { sessionDetail: 1 } })`);
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-history-0')`);
  await waitFor(win, `Boolean(document.querySelector('[data-retry-detail="fixture-history-0"]'))`, '상세 오류 재시도 UI가 표시되지 않았습니다.');
  await recordManifest(win);
  assert(await callCount(win, 'sessionDetail') === 1, '상세 오류 최초 호출 수가 1이 아닙니다.');
  await click(win, '[data-retry-detail="fixture-history-0"]', 'drawer:retry');
  await waitFor(win, `!document.querySelector('[data-retry-detail]') && !document.querySelector('.drawer-loading')`, '상세 다시 시도가 성공 상태로 복구되지 않았습니다.');
  assert(await callCount(win, 'sessionDetail') === 2, '상세 다시 시도가 sessionDetail을 한 번 더 호출하지 않았습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  const drawerRace = await win.webContents.executeJavaScript(`(async () => {
    const app = window.LoadToAgentApp;
    const base = app.state.snapshot.sessions.find(session => session.id === 'fixture-root');
    app.state.details.delete('fixture-root');
    window.interactionTest.queueSessionDetail('fixture-root', [
      { delay: 120, detail: { ...base, title: '최초 상세 응답' } },
      { delay: 160, detail: { ...base, title: '백그라운드 최신 응답' } },
    ]);
    const callsBefore = window.interactionTest.getCalls().filter(item => item.name === 'sessionDetail').length;
    const first = app.loadSessionDetail('fixture-root', true);
    await new Promise(resolve => setTimeout(resolve, 8));
    const second = app.loadSessionDetail('fixture-root', true);
    const callsAfter = window.interactionTest.getCalls().filter(item => item.name === 'sessionDetail').length;
    const sharedInitialRequest = callsAfter - callsBefore === 1;
    await Promise.all([first, second]);
    app.state.selectedId = 'fixture-root';
    app.state.drawerMode = 'session';
    app.state.drawerTab = 'chat';
    app.renderDrawer();
    const third = app.loadSessionDetail('fixture-root', true);
    const duringRefresh = {
      title: app.state.details.get('fixture-root')?.title || '',
      loading: app.state.detailLoadingIds.has('fixture-root'),
      fullScreenLoader: Boolean(document.querySelector('.drawer-loading')),
      terminalSurfaceVisible: !document.querySelector('#drawerTerminalSurface').classList.contains('hidden')
        && document.querySelector('#drawerContent').classList.contains('hidden'),
    };
    await third;
    return { sharedInitialRequest, duringRefresh, title: app.state.details.get('fixture-root')?.title || '', loading: app.state.detailLoadingIds.has('fixture-root') };
  })()`);
  assert(drawerRace.sharedInitialRequest && drawerRace.duringRefresh.title === '최초 상세 응답' && drawerRace.duringRefresh.loading
    && !drawerRace.duringRefresh.fullScreenLoader && drawerRace.duringRefresh.terminalSurfaceVisible
    && drawerRace.title === '백그라운드 최신 응답' && !drawerRace.loading,
  `상세 요청 병합과 백그라운드 갱신 상태가 올바르지 않습니다: ${JSON.stringify(drawerRace)}`);
  await waitFor(win, `window.LoadToAgentTerminal.embeddedState().agentSessionId === 'fixture-root'
    && window.LoadToAgentTerminal.embeddedState().terminalId === 'terminal-main'
    && Boolean(document.querySelector('#drawerTerminalViewport > .terminal-screen .xterm'))`,
  '백그라운드 상세 갱신 중에도 같은 PTY가 대화 탭에 유지되지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const form = document.querySelector('#drawerComposer [data-agent-command-form="fixture-root"]');
    const input = form.querySelector('[data-agent-command-draft]');
    input.value = '/model sonnet';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
  })()`);
  mark('session:model-command');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCommand'
    && item.args[0] === 'terminal-main' && item.args[1] === '/model sonnet')
    && !window.interactionTest.getCalls().some(item => item.name === 'terminalCreate')
    && window.LoadToAgentApp.state.view === 'active'
    && document.querySelector('#detailDrawer').classList.contains('open')
    && document.querySelector('[data-agent-command-draft="fixture-root"]')?.value === ''`,
  '연결된 Claude 세션의 모델 변경이 즉시 전달되지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const form = document.querySelector('#drawerComposer [data-agent-command-form="fixture-root"]');
    const input = form.querySelector('[data-agent-command-draft]');
    input.value = '/status';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
  })()`);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCommand'
    && item.args[0] === 'terminal-main' && item.args[1] === '/status')
    && !window.LoadToAgentApp.state.pendingConversationMessages.has('fixture-root')
    && window.LoadToAgentApp.state.view === 'active'
    && document.querySelector('#detailDrawer').classList.contains('open')`,
  'CLI 내장·등록 명령이 대화 프롬프트로 변환되지 않고 현재 세션에 전달되지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, 'drawer backdrop 닫기 실패');
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-failed')`);
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && Boolean(document.querySelector('#drawerComposer [data-agent-command-form="fixture-failed"]'))`, '종료된 Codex 세션 명령 입력창을 열지 못했습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const form = document.querySelector('#drawerComposer [data-agent-command-form="fixture-failed"]');
    const input = form.querySelector('[data-agent-command-draft]');
    input.value = '/status';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
  })()`);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate'
    && item.args[0]?.provider === 'codex'
    && item.args[0]?.bridgeId === 'fixture-failed'
    && item.args[0]?.args?.join(' ') === 'resume fixture-failed-external')
    && window.interactionTest.getCalls().some(item => item.name === 'terminalCommand' && item.args[1] === '/status')`,
  '종료된 세션의 CLI 명령이 새 프롬프트가 아니라 기존 세션 resume 후 원문으로 전달되지 않았습니다.');
  const endedCommandUi = await win.webContents.executeJavaScript(`({
    view: window.LoadToAgentApp.state.view,
    drawerOpen: document.querySelector('#detailDrawer').classList.contains('open'),
    selectedId: window.LoadToAgentApp.state.selectedId,
  })`);
  assert(endedCommandUi.view === 'active' && endedCommandUi.drawerOpen && endedCommandUi.selectedId === 'fixture-failed',
    `종료 세션 CLI 명령 뒤 대화창이 유지되지 않았습니다: ${JSON.stringify(endedCommandUi)}`);
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-projectless')`);
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && Boolean(document.querySelector('#drawerComposer [data-agent-command-form="fixture-projectless"]'))`, '종료된 Codex 세션 명령 입력창을 열지 못했습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const form = document.querySelector('#drawerComposer [data-agent-command-form="fixture-projectless"]');
    const input = form.querySelector('[data-agent-command-draft]');
    input.value = '/model gpt-5.6-terra';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
  })()`);
  mark('session:model-command');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate'
    && item.args[0]?.provider === 'codex'
    && item.args[0]?.bridgeId === 'fixture-projectless'
    && item.args[0]?.args?.join(' ') === 'resume fixture-projectless-external')
    && window.interactionTest.getCalls().some(item => item.name === 'terminalCommand'
      && item.args[1] === '/model gpt-5.6-terra')`,
  '종료된 Codex 모델 명령이 기존 세션 resume 후 원문으로 이어지지 않았습니다.');
  const endedModelUi = await win.webContents.executeJavaScript(`({
    view: window.LoadToAgentApp.state.view,
    drawerOpen: document.querySelector('#detailDrawer').classList.contains('open'),
    selectedId: window.LoadToAgentApp.state.selectedId,
  })`);
  assert(endedModelUi.view === 'active' && endedModelUi.drawerOpen && endedModelUi.selectedId === 'fixture-projectless',
    `종료 세션 모델 명령 뒤 대화창이 유지되지 않았습니다: ${JSON.stringify(endedModelUi)}`);
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open') && document.querySelector('#drawerBackdrop').classList.contains('hidden')`, '중첩 포커스 검증 전에 기존 상세 창을 닫지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#searchInput').focus({ preventScroll: true });
    window.LoadToAgentApp.openDrawer('fixture-root');
  })()`);
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && Boolean(document.querySelector('[data-session-reset="fixture-root"]'))`, '세션 초기화 버튼을 다시 열지 못했습니다.');
  await clearCalls(win);
  await click(win, '[data-session-reset="fixture-root"]', 'session:reset');
  await waitFor(win, `!document.querySelector('#sessionResetModal').classList.contains('hidden')
    && document.activeElement === document.querySelector('#cancelSessionResetBtn')
    && document.querySelector('#detailDrawer').inert`,
  '세션 초기화 확인창이 포커스 격리와 함께 열리지 않았습니다.');
  await click(win, '#cancelSessionResetBtn', 'session:reset-cancel');
  await waitFor(win, `document.querySelector('#sessionResetModal').classList.contains('hidden')
    && document.querySelector('#appShell').inert
    && !document.querySelector('#detailDrawer').inert
    && document.activeElement?.matches('[data-session-reset="fixture-root"]')`,
  '세션 초기화 취소 뒤 원래 버튼으로 포커스가 복귀하지 않았습니다.');
  assert(await win.webContents.executeJavaScript(`!window.interactionTest.getCalls().some(item => item.name === 'terminalCreate')
    && window.LoadToAgentApp.state.view === 'active'
    && document.querySelector('#detailDrawer').classList.contains('open')`),
  '세션 초기화 취소 시 기존 대화창과 세션이 유지되지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, '중첩 초기화 창 이후 상세 창 닫기 애니메이션이 끝나지 않았습니다.');
  const nestedFocusRestore = await win.webContents.executeJavaScript(`(() => {
    const active = document.activeElement;
    const expected = document.querySelector('#searchInput');
    return {
      restored: active === expected,
      active: active?.id || active?.outerHTML?.slice(0, 120) || '',
      activeConnected: Boolean(active?.isConnected),
      activeBlocked: Boolean(active?.closest?.('[hidden], [inert], [aria-hidden="true"], .hidden')),
      expectedVisible: Boolean(expected?.isConnected && expected.getClientRects().length),
      scopes: window.LoadToAgentApp.motionState.focusScopes.map(scope => scope.surface),
    };
  })()`);
  assert(nestedFocusRestore.restored && nestedFocusRestore.activeConnected && !nestedFocusRestore.activeBlocked && nestedFocusRestore.expectedVisible,
    `중첩 초기화 창을 취소하고 상세 창을 닫은 뒤 바깥 트리거로 초점이 복원되지 않았습니다: ${JSON.stringify(nestedFocusRestore)}`);
  mark('drawer:nested-modal-focus-restore');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#searchInput').focus({ preventScroll: true });
    window.LoadToAgentApp.openDrawer('fixture-root');
  })()`);
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && Boolean(document.querySelector('[data-session-reset="fixture-root"]'))`, '초기화 확인 실행을 위해 상세 창을 다시 열지 못했습니다.');
  await click(win, '[data-session-reset="fixture-root"]', 'session:reset');
  await waitFor(win, `!document.querySelector('#sessionResetModal').classList.contains('hidden')
    && document.querySelector('#sessionResetDescription').textContent.trim().length > 10`,
  '세션 초기화 확인 설명이 표시되지 않았습니다.');
  await click(win, '#confirmSessionResetBtn', 'session:reset-confirm');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate'
    && item.args[0]?.type === 'agent' && item.args[0]?.provider === 'claude' && Array.isArray(item.args[0]?.args))
    && window.LoadToAgentApp.state.view === 'terminal'
    && document.querySelector('#sessionResetModal').classList.contains('hidden')`,
  '기존 기록을 보존하는 새 세션 초기화가 실행되지 않았습니다.');
  round.observed.drawerTabs = 3;
  round.observed.drawerRetry = true;
}

async function focusRoot(win) {
  await click(win, '[data-view="all"]', 'nav:all');
  await prepareProjectFirstStep(win);
  const rootFlowSelector = '#liveSessionGrid [data-control-session="fixture-root"] > header > .control-session-flow[data-graph-focus="fixture-root"]';
  const alreadyFocused = await win.webContents.executeJavaScript(`Boolean(window.LoadToAgentApp.state.graphFocusId)`);
  if (alreadyFocused) {
    const reset = await win.webContents.executeJavaScript(`document.querySelector('[data-graph-reset]') ? '[data-graph-reset]' : (document.querySelector('#graphResetBtn:not(.hidden)') ? '#graphResetBtn' : '')`);
    assert(reset, 'focus 초기화를 위한 graph reset 컨트롤이 없습니다.');
    await click(win, reset, 'graph:reset');
    await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === null`, '기존 graph focus 초기화 실패');
  }
  await waitFor(win, `(() => {
    const button = document.querySelector(${JSON.stringify('#liveSessionGrid [data-control-session="fixture-root"] > header > .control-session-flow[data-graph-focus="fixture-root"]')});
    return Boolean(button && button.getClientRects().length && getComputedStyle(button).display !== 'none');
  })()`, '메인 작업의 진행 화면 버튼이 표시되지 않았습니다.');
  await click(win, rootFlowSelector, 'graph:focus', 1, 20);
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-root' && document.querySelector('.agent-workflow-canvas')`, 'graph focus 화면 전환 실패');
}

async function exerciseGraph(win, round) {
  const drawerOpen = await win.webContents.executeJavaScript(`document.querySelector('#detailDrawer').classList.contains('open')`);
  if (drawerOpen) {
    await click(win, '#closeDrawerBtn', 'graph:close-existing-drawer');
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, 'graph 시각 검증 전에 상세 창을 닫지 못했습니다.');
  }
  await click(win, '[data-view="all"]', 'nav:all');
  await resetGraphToOverview(win);
  await focusRoot(win);
  const goalSummary = await win.webContents.executeJavaScript(`(() => {
    const goal = document.querySelector('.agent-workflow-selected .agent-task');
    const breadcrumb = document.querySelector('#graphBreadcrumbs .current');
    return { text: goal?.textContent || '', full: goal?.title || '', note: Boolean(document.querySelector('.agent-workflow-selected .agent-goal-note')), breadcrumbText: breadcrumb?.textContent || '', breadcrumbFull: breadcrumb?.title || '' };
  })()`);
  assert(goalSummary.text === '화면 설명과 버튼을 쉽게 개선하기' && goalSummary.full === goalSummary.text
    && !goalSummary.note && goalSummary.breadcrumbText === goalSummary.text && goalSummary.breadcrumbFull === goalSummary.text,
  `짧고 쉬운 지금 목표가 손상 없이 표시되지 않았습니다: ${JSON.stringify(goalSummary)}`);
  await waitFor(win, `document.querySelector('[data-execution-activities="3"][data-running-executions="2"]')
    && document.querySelectorAll('[data-execution-kind="shell"]').length === 2
    && document.querySelectorAll('[data-execution-mode="background"][data-execution-status="running"]').length === 2
    && document.querySelector('[data-execution-kind="background"]')`, '셸·백그라운드 실행 시각화가 유형과 상태를 구분하지 못했습니다.');
  const executionVisualization = await win.webContents.executeJavaScript(`(() => ({
    labels: [...document.querySelectorAll('.execution-activity-kicker b')].map(node => node.textContent.trim()),
    commands: [...document.querySelectorAll('.execution-activity-copy code')].map(node => node.textContent.trim()),
    statuses: [...document.querySelectorAll('.execution-activity-state b')].map(node => node.textContent.trim()),
    handles: document.querySelector('.execution-activity-panel')?.innerText || '',
  }))()`);
  assert(executionVisualization.labels.includes('화면 밖에서 계속되는 명령')
    && executionVisualization.labels.includes('컴퓨터 작업 실행')
    && executionVisualization.labels.includes('화면 밖에서 계속되는 작업')
    && executionVisualization.commands.includes('npm run dev')
    && executionVisualization.statuses.filter(value => value === '실행 중').length === 2
    && executionVisualization.handles.includes('fixture-cell-1'), `실행 방식·명령·상태·핸들이 UI에 표시되지 않았습니다: ${JSON.stringify(executionVisualization)}`);
  await click(win, '[data-execution-mode="foreground"] > summary', 'graph:open-foreground-shell-details');
  await waitFor(win, `document.querySelector('[data-execution-mode="foreground"]')?.open`, '포그라운드 셸 상세 보기가 열리지 않았습니다.');
  const foregroundDetail = await win.webContents.executeJavaScript(`(() => {
    const detail = document.querySelector('[data-execution-mode="foreground"]');
    return {
      command: detail?.querySelector('.execution-detail-command code')?.textContent || '',
      output: detail?.querySelector('.execution-detail-output pre')?.textContent || '',
      metadata: detail?.querySelector('.execution-activity-detail dl')?.innerText || '',
      metadataCount: detail?.querySelectorAll('.execution-activity-detail dl > div').length || 0,
      lastMetadataFullWidth: (() => {
        const list = detail?.querySelector('.execution-activity-detail dl');
        const last = list?.lastElementChild;
        return Boolean(list && last && last.getBoundingClientRect().width >= list.getBoundingClientRect().width - 2);
      })(),
      copyButtons: detail?.querySelectorAll('[data-copy-text]').length || 0,
    };
  })()`);
  assert(foregroundDetail.command === 'npm test'
    && foregroundDetail.output.includes('128개 테스트 통과')
    && foregroundDetail.metadata.includes('컴퓨터 작업')
    && foregroundDetail.metadata.includes('D:\\fixture')
    && foregroundDetail.metadataCount === 5
    && foregroundDetail.lastMetadataFullWidth
    && foregroundDetail.copyButtons === 2, `포그라운드 셸의 명령·출력·메타데이터·복사 동작이 불완전합니다: ${JSON.stringify(foregroundDetail)}`);
  await clearCalls(win);
  await click(win, '[data-execution-mode="foreground"] .execution-detail-command [data-copy-text]', 'graph:copy-foreground-command');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'writeClipboard' && item.args[0] === 'npm test')`, '포그라운드 셸 명령 복사가 clipboard API를 호출하지 않았습니다.');
  await click(win, '[data-execution-mode="foreground"] .execution-detail-output [data-copy-text]', 'graph:copy-foreground-output');
  await waitFor(win, `window.interactionTest.getCalls().filter(item => item.name === 'writeClipboard').length === 2`, '포그라운드 셸 출력 복사가 clipboard API를 호출하지 않았습니다.');
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.renderSessions('refresh')`);
  await waitFor(win, `document.querySelector('[data-execution-mode="foreground"]')?.open`, '스냅샷 재렌더 뒤 포그라운드 셸 상세가 접혔습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const root = app.state.snapshot.sessions.find(session => session.id === 'fixture-root');
    root.executions = [...root.executions, ...Array.from({ length: 4 }, (_, index) => ({ ...root.executions[2], id: 'fixture-old-' + index, status: 'completed', updatedAt: new Date(Date.parse(root.executions[2].updatedAt) - (index + 1) * 60000).toISOString() }))];
    app.renderSessions('refresh');
  })()`);
  await waitFor(win, `document.querySelector('[data-execution-history-toggle]')?.getAttribute('aria-expanded') === 'false' && document.querySelectorAll('[data-execution-activity]').length === 6`, '이전 실행 기록 펼치기 컨트롤이 표시되지 않았습니다.');
  await click(win, '[data-execution-history-toggle]', 'graph:execution-history');
  await waitFor(win, `document.querySelector('[data-execution-history-toggle]')?.getAttribute('aria-expanded') === 'true' && document.querySelectorAll('[data-execution-activity]').length === 7`, '이전 실행 기록 전체 펼치기가 동작하지 않았습니다.');
  await click(win, '[data-execution-history-toggle]', 'graph:execution-history');
  await waitFor(win, `document.querySelectorAll('[data-execution-activity]').length === 6`, '이전 실행 기록 접기가 동작하지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const root = app.state.snapshot.sessions.find(session => session.id === 'fixture-root');
    root.executions = root.executions.slice(0, 3);
    app.state.expandedExecutionSessions.delete('fixture-root');
    app.renderSessions('refresh');
  })()`);
  round.observed.executionActivities = { total: 3, running: 2, kinds: executionVisualization.labels };
  fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
  await sleep(420);
  const visualOverlayState = await win.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('#detailDrawer');
    const backdrop = document.querySelector('#drawerBackdrop');
    const shell = document.querySelector('#appShell');
    const stage = document.querySelector('.main-stage');
    const state = { drawerStyle: drawer.style.cssText, backdropStyle: backdrop.style.cssText, shellInert: shell.inert, stageScrollTop: stage?.scrollTop || 0 };
    drawer.style.setProperty('display', 'none', 'important');
    backdrop.style.setProperty('display', 'none', 'important');
    shell.inert = false;
    document.querySelector('.execution-activity-panel')?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return state;
  })()`);
  await sleep(220);
  const executionRect = await win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('.execution-activity-panel')?.getBoundingClientRect();
    if (!rect) return null;
    const x = Math.max(0, Math.floor(rect.left - 12));
    const y = Math.max(0, Math.floor(rect.top - 12));
    return { x, y, width: Math.max(1, Math.min(window.innerWidth - x, Math.ceil(rect.width + 24))), height: Math.max(1, Math.min(window.innerHeight - y, Math.ceil(rect.height + 24))) };
  })()`);
  assert(executionRect, '셸 실행 패널의 캡처 영역을 계산하지 못했습니다.');
  const readableCapture = (await win.webContents.capturePage()).toPNG();
  const executionCapture = (await win.webContents.capturePage(executionRect)).toPNG();
  fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'loadtoagent-readable-goal.png'), readableCapture);
  fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'loadtoagent-execution-activity-interaction.png'), executionCapture);
  await win.webContents.executeJavaScript(`(() => {
    const state = ${JSON.stringify(visualOverlayState)};
    document.querySelector('#detailDrawer').style.cssText = state.drawerStyle;
    document.querySelector('#drawerBackdrop').style.cssText = state.backdropStyle;
    document.querySelector('#appShell').inert = state.shellInert;
    const stage = document.querySelector('.main-stage');
    if (stage) stage.scrollTop = state.stageScrollTop;
  })()`);
  mark('graph:goal-summary');
  const firstReset = await win.webContents.executeJavaScript(`(() => {
    const toolbar = document.querySelector('#graphResetBtn:not(.hidden)');
    if (toolbar) return '#graphResetBtn';
    return document.querySelector('[data-graph-reset]') ? '[data-graph-reset]' : '';
  })()`);
  assert(firstReset, 'graph reset 컨트롤이 없습니다.');
  await click(win, firstReset, 'graph:reset');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === null && !document.querySelector('.agent-workflow-canvas')`, 'toolbar graph reset 실패');
  await focusRoot(win);
  const secondReset = await win.webContents.executeJavaScript(`(() => {
    if (document.querySelector('[data-graph-reset]')) return '[data-graph-reset]';
    return document.querySelector('#graphResetBtn:not(.hidden)') ? '#graphResetBtn' : '';
  })()`);
  assert(secondReset, '두 번째 focus에서 graph reset 컨트롤이 없습니다.');
  await click(win, secondReset, 'graph:reset');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === null && !document.querySelector('.agent-workflow-canvas')`, 'breadcrumb graph reset 실패');

  // Contextual conversation mode intentionally starts at the wide desktop
  // breakpoint. Exercise that contract at a matching viewport instead of
  // expecting it from the default 1440px interaction-test window.
  win.setSize(1800, 940);
  await sleep(120);
  await focusRoot(win);
  await clearCalls(win);
  await click(win, '#liveSessionGrid [data-open-session="fixture-root"]', 'drawer:open-graph');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')
    && document.querySelector('#detailDrawer').dataset.presentation === 'context'
    && document.body.classList.contains('conversation-context-open')
    && !document.querySelector('#appShell').inert
    && document.querySelector('#drawerBackdrop').classList.contains('hidden')
    && document.querySelector('[data-stop-run]')`, '에이전트 흐름 옆에 실행 중 session 대화 패널이 열리지 않았습니다.');
  await click(win, '[data-session-reset="fixture-root"]', 'session:reset');
  await waitFor(win, `!document.querySelector('#sessionResetModal').classList.contains('hidden')
    && document.querySelector('#appShell').inert
    && document.querySelector('#detailDrawer').inert
    && document.activeElement === document.querySelector('#cancelSessionResetBtn')`,
  '넓은 화면 대화 패널의 세션 초기화 확인창이 배경과 포커스를 격리하지 못했습니다.');
  await click(win, '#cancelSessionResetBtn', 'session:reset-cancel');
  await waitFor(win, `document.querySelector('#sessionResetModal').classList.contains('hidden')
    && document.querySelector('#sessionResetModal').inert
    && !document.querySelector('#appShell').inert
    && document.querySelector('#detailDrawer').classList.contains('open')
    && document.querySelector('#detailDrawer').dataset.presentation === 'context'
    && !document.querySelector('#detailDrawer').inert
    && document.activeElement?.matches('[data-session-reset="fixture-root"]')`,
  '넓은 화면 대화 패널의 세션 초기화 확인창을 닫은 뒤 앱·패널·포커스가 복원되지 않았습니다.');
  mark('drawer:context-reset-background-restore');
  const drawerWidthBefore = await win.webContents.executeJavaScript(`Number(document.querySelector('#drawerResizeHandle').getAttribute('aria-valuenow'))`);
  await win.webContents.executeJavaScript(`document.querySelector('#drawerResizeHandle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))`);
  await waitFor(win, `Number(document.querySelector('#drawerResizeHandle').getAttribute('aria-valuenow')) === 560`, '대화 패널 separator의 Home 키 너비 조절이 동작하지 않았습니다.');
  await recordExercise(win, '#drawerResizeHandle');
  assert(drawerWidthBefore >= 560, `대화 패널 초기 너비가 범위를 벗어났습니다: ${drawerWidthBefore}`);
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ delays: { stopAgent: 180 } })`);
  await click(win, '[data-stop-run]', 'drawer:stop-double');
  await win.webContents.executeJavaScript(`document.querySelector('[data-stop-run]')?.click()`);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'stopAgent')`, '중지 버튼이 stopAgent를 호출하지 않았습니다.');
  await sleep(260);
  assert(await callCount(win, 'stopAgent') === 1, '중지 클릭 한 번에 stopAgent가 한 번 호출되어야 합니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await click(win, '#drawerBackToFlowBtn', 'drawer:back-to-flow');
  await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')
    && !document.body.classList.contains('conversation-context-open')
    && document.querySelector('#drawerBackdrop').classList.contains('hidden')`, '에이전트 흐름으로 돌아가며 대화 패널을 닫지 못했습니다.');
  win.setSize(1440, 940);
  await sleep(120);
  round.observed.graphResetClicks = 2;
}

async function resetGraphToOverview(win) {
  if (!await win.webContents.executeJavaScript(`Boolean(window.LoadToAgentApp.state.graphFocusId)`)) return;
  const selector = await win.webContents.executeJavaScript(`document.querySelector('[data-graph-reset]') ? '[data-graph-reset]' : '#graphResetBtn'`);
  await click(win, selector, 'graph:reset');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === null`, 'graph overview 복귀 실패');
}

async function filterToGraphFocus(win, sessionId) {
  const alreadyVisible = await win.webContents.executeJavaScript(`(() => {
    const sessionId = ${JSON.stringify(sessionId)};
    return [...document.querySelectorAll('[data-graph-focus]')].some(element => {
      if (element.dataset.graphFocus !== sessionId || element.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0;
    });
  })()`);
  if (alreadyVisible) return;
  const project = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const session = app.state.snapshot.sessions.find(item => item.id === ${JSON.stringify(sessionId)});
    const path = session ? app.controlRoomProject(session).path : '';
    const target = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
      .find(element => element.dataset.workspace === path);
    if (!path || !target || target.disabled || !target.getClientRects().length) {
      return { ok: false, path, targetFound: Boolean(target) };
    }
    target.click();
    return { ok: true, path };
  })()`);
  assert(project?.ok, `${sessionId} 작업의 프로젝트를 왼쪽 목록에서 선택하지 못했습니다: ${JSON.stringify(project)}`);
  mark('workspace:select');
  await recordExercise(win, '#projectSidebarList [data-workspace].selected');
  await waitFor(win, `(() => {
    const sessionId = ${JSON.stringify(sessionId)};
    return window.LoadToAgentApp.state.workspace === ${JSON.stringify(project?.path || '')}
      && [...document.querySelectorAll('[data-graph-focus]')].some(element => {
      if (element.dataset.graphFocus !== sessionId || element.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0;
    });
  })()`, `${sessionId} 프로젝트의 graph node가 표시되지 않았습니다.`);
}

async function clearControlRoomSearch(win) {
  const inputExists = await win.webContents.executeJavaScript(`Boolean(document.querySelector('#controlRoomSearchInput'))`);
  assert(inputExists, '관제 검색 초기화를 위한 입력창이 없습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#controlRoomSearchInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.search === ''`, '관제 검색을 초기화하지 못했습니다.');
}

async function exerciseAgentControls(win, round) {
  await click(win, '[data-view="all"]', 'nav:all');
  await resetGraphToOverview(win);

  await focusRoot(win);
  await waitFor(win, `Boolean(document.querySelector('[data-workflow-progress="fixture-root"]'))
    && !document.querySelector('#liveSessionGrid [data-agent-command-form]')`,
  '작업 진행 화면에서 별도 지시 입력창이 제거되지 않았습니다.');
  await click(win, '[data-open-session="fixture-root"]', 'drawer:open-graph');
  await waitFor(win, `document.querySelector('#drawerComposer [data-agent-command-form="fixture-root"]')?.dataset.agentCommandInputModeSelected === 'terminal'
    && window.LoadToAgentTerminal.embeddedState().connected
    && window.LoadToAgentTerminal.embeddedState().terminalId === 'terminal-main'
    && Boolean(document.querySelector('#drawerTerminalViewport > .terminal-screen .xterm'))`,
  '실행 중 메인 AI의 별도 대화창에 같은 PTY 입력창이 열리지 않았습니다.');
  await recordExercise(win, '#drawerComposer [data-agent-command-draft="fixture-root"]');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
    input.value = 'AGENT_DIRECT_COMMAND';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#drawerComposer [data-agent-command-form="fixture-root"] button[type="submit"]').click();
  })()`);
  mark('agent:command-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCommand')`, 'AI 직접 지시 form submit이 terminalCommand를 호출하지 않았습니다.');
  assert(await callCount(win, 'terminalCommand') === 1, 'AI 직접 지시가 한 번보다 많이 전송되었습니다.');

  await waitFor(win, `document.querySelector('#drawerComposer [data-agent-command-form="fixture-root"]')?.dataset.agentCommandInputModeSelected === 'terminal'
    && window.LoadToAgentTerminal.embeddedState().connected
    && window.LoadToAgentTerminal.embeddedState().terminalId === 'terminal-main'
    && Boolean(document.querySelector('#drawerTerminalViewport > .terminal-screen .xterm'))`,
  '실행 중 메인 AI의 대화 탭에 같은 PTY 입력창이 열리지 않았습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('#drawerTerminalViewport > .terminal-screen').dataset.interactionTerminalIdentity = 'fixture-root-main'`);
  await clearCalls(win);
  await click(win, '#drawerTerminalFocusBtn', 'drawer:terminal-focus');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Q' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'q' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Q' });
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalWrite'
    && item.args[0] === 'terminal-main'
    && item.args[1].includes('q'))`,
  '드로어 xterm의 직접 키 입력이 같은 PTY로 전달되지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
    input.value = '/';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, `document.querySelector('#drawerComposer [data-conversation-slash-menu]:not(.hidden)')
    && document.querySelectorAll('#drawerComposer [data-conversation-slash-command]').length >= 3`,
  '메인 AI 입력창에서 / 추천 명령이 표시되지 않았습니다.');
  await click(win, '#drawerComposer [data-conversation-slash-command="/status"]', 'drawer:slash-command');
  await waitFor(win, `document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]')?.value === '/status'
    && document.querySelector('#drawerComposer [data-conversation-slash-menu]')?.classList.contains('hidden')`,
  '추천 명령을 메인 AI 입력창에 선택하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
    input.value = 'TERMINAL_DRAWER_CONTINUE';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click(win, '#drawerComposer [data-agent-command-form="fixture-root"] .conversation-send', 'agent:conversation-send');
  mark('agent:command-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCommand'
    && item.args[0] === 'terminal-main'
    && item.args[1] === 'TERMINAL_DRAWER_CONTINUE')
    && !window.LoadToAgentApp.state.pendingConversationMessages.has('fixture-root')
    && document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar')?.dataset.tone === 'delivered'
    && document.querySelector('#detailDrawer')?.classList.contains('open')`,
  '드로어 하단 입력이 구조화 대화를 만들지 않고 같은 PTY로 전달되지 않았습니다.', 160);
  assert(await callCount(win, 'terminalCommand') === 1, '드로어 하단 PTY 지시가 한 번보다 많이 전송되었습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.emitTerminalData('terminal-main', '\\r\\nDRAWER_PTY_CONTINUES\\r\\n')`);
  await waitFor(win, `document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar')?.dataset.tone === 'running'
    && window.LoadToAgentTerminal.embeddedState().connected`,
  '같은 PTY의 후속 출력이 열린 드로어에 계속 반영되지 않았습니다.');
  await clearCalls(win);
  await click(win, '#drawerTerminalReconnectBtn', 'drawer:terminal-reconnect');
  await waitFor(win, `window.LoadToAgentTerminal.embeddedState().connected
    && window.LoadToAgentTerminal.embeddedState().terminalId === 'terminal-main'
    && Boolean(document.querySelector('#drawerTerminalViewport > .terminal-screen[data-interaction-terminal-identity="fixture-root-main"]'))
    && window.interactionTest.getCalls().some(item => item.name === 'terminalList')
    && !window.interactionTest.getCalls().some(item => ['terminalClose', 'terminalStop', 'terminalDetach'].includes(item.name))`,
  'PTY 다시 연결이 같은 xterm 호스트와 실행 중 프로세스를 유지하지 못했습니다.');
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer()`);
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')
    && !window.LoadToAgentTerminal.embeddedState().connected
    && Boolean(document.querySelector('#terminalViewport > .terminal-screen[data-terminal-screen="terminal-main"]'))`,
  'PTY를 종료하지 않고 대화창을 닫아 원래 화면으로 돌려놓지 못했습니다.');

  await resetGraphToOverview(win);
  await focusRoot(win);
  await waitFor(win, `(() => {
    const button = document.querySelector('[data-graph-focus="fixture-child"]');
    if (!button || button.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return button.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0;
  })()`, '메인 AI를 연 뒤 하위 AI 항목이 표시되지 않았습니다.', 160);
  await click(win, '[data-graph-focus="fixture-child"]', 'graph:focus', 1, 20);
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-child'
    && Boolean(document.querySelector('[data-open-session="fixture-child"]'))
    && Boolean(document.querySelector('[data-workflow-progress="fixture-child"]'))
    && !document.querySelector('.selected-column .agent-command-panel')`, '서브에이전트의 진행 흐름이 읽기 전용으로 표시되지 않았습니다.');
  await click(win, '[data-open-session="fixture-child"]', 'drawer:open-session');
  await waitFor(win, `window.LoadToAgentApp.state.selectedId === 'fixture-child'
    && document.querySelector('#detailDrawer')?.classList.contains('open')
    && document.querySelector('#detailDrawer')?.dataset.terminalChat === 'false'
    && document.querySelector('#drawerTerminalSurface')?.classList.contains('hidden')
    && !document.querySelector('#drawerContent')?.classList.contains('hidden')
    && document.querySelector('#drawerComposer')?.classList.contains('hidden')
    && document.querySelector('#drawerContent')?.innerText.includes('실행 구조, 대화 기록, 직접 개입과 메인 에이전트 경유 개입')`,
  '일반 상세 경로로 연 서브에이전트가 실제 응답 중심의 읽기 전용 화면을 유지하지 못했습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, '서브에이전트 일반 상세를 닫지 못했습니다.');
  await resetGraphToOverview(win);
  await click(
    win,
    '[data-open-subagent-chat="fixture-child"]',
    'control-room:open-subagent',
    1,
    40,
    '.control-room-project-group:has([data-control-session="fixture-root"])',
  );
  await waitFor(win, `window.LoadToAgentApp.state.drawerMode === 'subagent'
    && document.querySelectorAll('[data-agent-command-route]').length === 0
    && window.LoadToAgentTerminal.agentTargets(window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-child')).length === 0
    && document.querySelector('#drawerComposer')?.classList.contains('hidden')
    && !document.querySelector('#drawerComposer [data-agent-command-form="fixture-child"]')
    && document.querySelector('[data-subagent-work-messages="2"]')
    && document.querySelector('#drawerContent')?.innerText.includes('실행 구조, 대화 기록, 직접 개입과 메인 에이전트 경유 개입')`, '서브에이전트 응답 기록이 입력창 없이 표시되지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, '서브에이전트 상세 drawer가 닫히지 않았습니다.');

  await resetGraphToOverview(win);
  await filterToGraphFocus(win, 'fixture-live-0');
  await click(win, '[data-graph-focus="fixture-live-0"]', 'graph:focus');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-live-0'
    && Boolean(document.querySelector('[data-workflow-progress="fixture-live-0"]'))
    && Boolean(document.querySelector('[data-open-session="fixture-live-0"]'))
    && !document.querySelector('#liveSessionGrid [data-agent-command-form]')`, '외부 CLI 세션의 읽기 전용 진행 화면이 표시되지 않았습니다.');
  await click(win, '[data-open-session="fixture-live-0"]', 'drawer:open-session');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')
    && document.querySelector('#drawerComposer .agent-command-panel.control-handoff[data-agent-command-input-mode-selected="conversation"] textarea:not([disabled])')
    && document.querySelector('#drawerTerminalSurface').classList.contains('hidden')
    && !document.querySelector('#drawerContent').classList.contains('hidden')
    && !window.LoadToAgentTerminal.embeddedState().connected`,
  '외부 CLI 세션의 별도 대화 입력창이 열리지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-live-0"]');
    input.value = 'FOCUS_STABILITY_DRAFT';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(7, 7);
    window.interactionTest.emitSnapshot();
  })()`);
  await sleep(180);
  await waitFor(win, `(() => {
    const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-live-0"]');
    return document.activeElement === input
      && input.value === 'FOCUS_STABILITY_DRAFT'
      && input.selectionStart === 7
      && input.selectionEnd === 7;
  })()`, '실시간 대화 갱신 중 입력 포커스·초안·커서 위치가 유지되지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ delays: { terminalCreate: 180 } })`);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-live-0"]');
    input.value = 'HANDOFF_EXISTING_SESSION';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
  })()`);
  mark('agent:handoff-submit');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')
    && window.LoadToAgentApp.state.view === 'all'
    && !document.querySelector('#terminalSection:not(.hidden)')`,
  'PTY 연결 요청 직후 상세 대화창을 유지하지 못했습니다.');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate'
    && item.args[0].provider === 'claude'
    && item.args[0].distro === 'FixtureLinux'
    && item.args[0].cwd === '/mnt/c/Users/fixture/board-migration-loop'
    && item.args[0].transient === false
    && item.args[0].args.join(' ') === '--resume fixture-live-0-external -- HANDOFF_EXISTING_SESSION'
    && item.args[0].initialCommandInArgs === true)
    && window.LoadToAgentApp.state.view === 'all'
    && document.querySelector('#detailDrawer').classList.contains('open')
    && window.LoadToAgentTerminal.embeddedState().connected
    && window.LoadToAgentTerminal.embeddedState().terminalId.startsWith('terminal-created-')
    && Boolean(document.querySelector('#drawerTerminalViewport > .terminal-screen .xterm'))
    && document.querySelector('#drawerTerminalSurface .drawer-terminal-statusbar')?.dataset.tone === 'connected'
    && (window.LoadToAgentApp.state.pendingConversationMessages.get('fixture-live-0') || []).some(item => item.text === 'HANDOFF_EXISTING_SESSION')
    && !document.querySelector('#detailDrawer .chat-row')`,
  'WSL 외부 CLI를 지속형 관리 터미널로 이어받아 같은 드로어에 연결하지 못했습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('#drawerTerminalViewport > .terminal-screen').dataset.interactionTerminalIdentity = 'fixture-live-handoff'`);
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-live-0"]');
    input.value = 'HANDOFF_CONTINUED_SESSION';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
  })()`);
  await waitFor(win, `window.interactionTest.getCalls().filter(item => item.name === 'terminalCommand'
      && item.args[0].startsWith('terminal-created-')
      && item.args[1] === 'HANDOFF_CONTINUED_SESSION').length === 1
    && !window.interactionTest.getCalls().some(item => item.name === 'terminalCreate')
    && window.LoadToAgentTerminal.embeddedState().connected`,
  '같은 명령을 다시 입력했을 때 새 터미널을 만들지 않고 이어진 PTY로 한 번 전달하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const now = Date.now();
    const original = window.interactionTest.getSnapshot().sessions.find(session => session.id === 'fixture-live-0');
    window.interactionTest.addSession({
      ...original,
      id: 'fixture-live-0-resumed',
      externalId: 'fixture-live-0-resumed-external',
      title: 'Claude 터미널에서 이어진 후속 세션',
      startedAt: new Date(now).toISOString(),
      updatedAt: new Date(now + 1).toISOString(),
      runtimePresence: [],
      messages: [
        { id: 'fixture-live-0-resumed-user', role: 'user', text: 'HANDOFF_EXISTING_SESSION', timestamp: new Date(now).toISOString() },
        { id: 'fixture-live-0-resumed-assistant', role: 'assistant', text: 'BACKGROUND_AI_RESPONSE', timestamp: new Date(now + 1).toISOString() },
      ],
      lifecycle: [],
    });
    window.interactionTest.emitSnapshot();
  })()`);
  await waitFor(win, `window.LoadToAgentTerminal.embeddedState().connected
    && window.LoadToAgentTerminal.embeddedState().terminalId.startsWith('terminal-created-')
    && Boolean(document.querySelector('#drawerTerminalViewport > .terminal-screen[data-interaction-terminal-identity="fixture-live-handoff"]'))
    && document.querySelector('#drawerContent').classList.contains('hidden')
    && !document.querySelector('#detailDrawer .chat-row')`,
  '후속 세션 snapshot 갱신 뒤 같은 PTY 호스트가 열린 드로어에서 유지되지 않았습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, '이어받기 후 대화 상세 drawer가 닫히지 않았습니다.');

  await click(win, '[data-view="all"]', 'nav:all');
  await resetGraphToOverview(win);
  await filterToGraphFocus(win, 'fixture-origin');
  await click(win, '[data-graph-focus="fixture-origin"]', 'graph:focus');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-origin'
    && Boolean(document.querySelector('[data-workflow-progress="fixture-origin"]'))
    && Boolean(document.querySelector('[data-open-session="fixture-origin"]'))
    && !document.querySelector('#liveSessionGrid [data-agent-command-form]')`, '실행 중인 Codex 데스크톱 작업의 읽기 전용 진행 화면이 표시되지 않았습니다.');
  await click(win, '[data-open-session="fixture-origin"]', 'drawer:open-session');
  await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open')
    && document.querySelector('#drawerComposer .agent-command-panel.control-origin-resume[data-agent-command-routing="conversation"] textarea:not([disabled])')`,
  '실행 중인 Codex 데스크톱 작업의 별도 대화 입력창이 표시되지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-origin"]');
    input.value = 'RESUME_DESKTOP_IN_BACKGROUND';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
  })()`);
  mark('agent:command-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate'
    && item.args[0].provider === 'codex'
    && item.args[0].bridgeId === 'fixture-origin'
    && item.args[0].args.join(' ') === 'resume -- fixture-origin-external RESUME_DESKTOP_IN_BACKGROUND'
    && item.args[0].initialCommandInArgs === true)`, '실행 중인 Codex 데스크톱 작업을 백그라운드 터미널로 이어받지 못했습니다.');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'all'
    && document.querySelector('#detailDrawer')?.classList.contains('open')
    && window.LoadToAgentTerminal.embeddedState().connected
    && window.LoadToAgentTerminal.embeddedState().terminalId.startsWith('terminal-created-')
    && Boolean(document.querySelector('#drawerTerminalViewport > .terminal-screen .xterm'))
    && document.querySelector('#drawerComposer .agent-command-panel.control-direct[data-agent-command-input-mode-selected="terminal"] textarea:not([disabled])')`,
  '복원한 백그라운드 터미널이 같은 대화창에 연결되지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, '복원한 백그라운드 터미널 대화창이 닫히지 않았습니다.');

  await resetGraphToOverview(win);
  await clearControlRoomSearch(win);
  await focusRoot(win);
  await waitFor(win, `document.querySelectorAll('.child-session.work-working').length === 1 && document.querySelectorAll('.child-session.work-resting').length === 0 && document.querySelector('[data-subagent-completed-toggle="fixture-root"]') && !document.querySelector('[data-subagent-search], [data-subagent-provider], [data-subagent-status]')`, '진행 중 우선·완료 기본 숨김 상태가 적용되지 않았습니다.');
  await click(win, '[data-subagent-completed-toggle="fixture-root"]', 'subagent:toggle-completed');
  await waitFor(win, `document.querySelectorAll('.child-session.work-working').length === 1 && document.querySelectorAll('.child-session.work-resting').length === 1 && Boolean(document.querySelector('[data-open-subagent-chat="fixture-resting"]'))`, '완료된 서브에이전트 펼치기가 정확히 동작하지 않았습니다.');
  await click(win, '[data-open-subagent-chat="fixture-resting"]', 'subagent:open-conversation', 1, 40);
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-root'
    && window.LoadToAgentApp.state.drawerMode === 'subagent'
    && window.LoadToAgentApp.state.details.has('fixture-resting')
    && document.querySelector('[data-subagent-work-messages="3"]')
    && document.querySelector('[data-subagent-coordination-count="2"]')
    && document.querySelector('#drawerContent').innerText.includes('홈에서 실행 구조가 즉시 읽히는지')
    && document.querySelector('#drawerContent').innerText.includes('직접 개입과 메인 에이전트 경유 개입')
    && document.querySelector('#drawerContent').innerText.includes('검토 결과 이상이 없습니다.')
    && document.querySelector('.subagent-assignment-card')?.innerText.includes('담당 AI가 나눠 맡긴 작업')
    && !document.querySelector('#drawerContent').textContent.includes('gAAAA')
    && !document.querySelector('#drawerContent').innerText.includes('보호된 메시지')
    && !document.querySelector('#drawerContent').innerText.includes('내용 없이 통신 상태')
    && document.querySelector('.drawer-tab:not(.hidden)').textContent === '작업 내용'
    && document.querySelectorAll('.drawer-tab:not(.hidden)').length === 1
    && document.querySelectorAll('[data-agent-command-route]').length === 0
    && document.querySelector('#drawerComposer')?.classList.contains('hidden')
    && !document.querySelector('[data-agent-command-form="fixture-resting"]')
    && !document.querySelector('[data-agent-command-draft="fixture-resting"]')`, '서브카드 클릭이 실제 진행 및 최종 응답을 읽기 전용으로 열지 않았습니다.');
  await click(win, '.chat-activities.subagent-coordination > summary', 'subagent:coordination-details');
  await waitFor(win, `document.querySelector('.chat-activities.subagent-coordination')?.open`, '서브에이전트 조율 기록 summary가 열리지 않았습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  round.observed.agentControlModes = ['direct', 'connect', 'handoff', 'origin-resume'];
  round.observed.subagentConversationReadOnly = true;
  round.observed.subagentCompletedDefault = 'hidden-until-expanded';
}

async function exerciseTerminal(win, round) {
  if (!await win.webContents.executeJavaScript(`document.querySelector('#drawerBackdrop')?.classList.contains('hidden')`)) {
    await click(win, '#closeDrawerBtn', 'drawer:close');
    await waitFor(win, `document.querySelector('#drawerBackdrop')?.classList.contains('hidden')`, '터미널 검증 전에 열린 상세 창을 닫지 못했습니다.');
  }
  await win.webContents.executeJavaScript(`window.interactionTest.addTerminal({
    id: 'terminal-resumed-failed-agent',
    type: 'agent',
    title: 'Fixture Resumed Failed Agent',
    status: 'running',
    pid: 41006,
    cwd: 'D:\\\\fixture',
    provider: 'codex',
    bridgeId: 'fixture-failed',
    background: true,
  })`);
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.selectView('terminal', { focusMain: true })`);
  await waitFor(win, `Boolean(document.querySelector('[data-terminal-id="terminal-main"]'))`, '터미널 목록 로드 실패');
  await waitFor(win, `Boolean(document.querySelector('#terminalViewport .terminal-screen:not(.hidden) .xterm-helper-textarea'))`, '터미널 직접 입력 요소가 준비되지 않았습니다.');
  await setLegacyTerminalMode(win, 'computer');
  await waitFor(win, `document.querySelector('#terminalModeComputerBtn')?.getAttribute('aria-pressed') === 'true'
    && getComputedStyle(document.querySelector('#terminalViewport')).display !== 'none'
    && document.activeElement === document.querySelector('#terminalViewport .terminal-screen:not(.hidden) .xterm-helper-textarea')`,
  '컴퓨터 작업 모드에서 직접 입력 화면을 표시하지 못했습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ delays: { terminalList: 180 } })`);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#terminalViewport .terminal-screen:not(.hidden) .xterm-helper-textarea');
    input.focus();
    window.interactionTest.emitSnapshot();
  })()`);
  await sleep(260);
  const snapshotFocus = await win.webContents.executeJavaScript(`(() => {
    const expected = document.querySelector('#terminalViewport .terminal-screen:not(.hidden) .xterm-helper-textarea');
    const active = document.activeElement;
    return {
      matches: active === expected,
      activeTag: active?.tagName || '',
      activeId: active?.id || '',
      activeClass: active?.className || '',
      activeScreen: active?.closest?.('[data-terminal-screen]')?.dataset.terminalScreen || '',
      expectedScreen: expected?.closest?.('[data-terminal-screen]')?.dataset.terminalScreen || '',
      visibleScreens: [...document.querySelectorAll('#terminalViewport .terminal-screen:not(.hidden)')]
        .map(node => node.dataset.terminalScreen),
    };
  })()`);
  assert(snapshotFocus.matches,
    `실시간 세션 갱신 중 터미널 직접 입력 포커스가 유지되지 않았습니다: ${JSON.stringify(snapshotFocus)}`);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#terminalViewport .terminal-screen:not(.hidden) .xterm-helper-textarea');
    input.focus();
    window.interactionTest.emitSnapshot();
    document.querySelector('#backToProjectsBtn').focus();
  })()`);
  await sleep(260);
  assert(await win.webContents.executeJavaScript(`document.activeElement?.id === 'backToProjectsBtn'`),
    '실시간 세션 갱신의 지연된 포커스 복구가 사용자가 선택한 프로젝트 복귀 버튼의 포커스를 빼앗았습니다.');
  mark('quality:terminal-snapshot-focus-guard');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await click(win, '[data-terminal-id="terminal-race-a"]', 'terminal:select-session');
  await waitFor(win, `document.querySelector('.terminal-session-item.active')?.dataset.terminalId === 'terminal-race-a'
    && !document.querySelector('#terminalComputerInputBtn')?.classList.contains('hidden')
    && !document.querySelector('#terminalComputerInputBtn')?.disabled`,
  '입력 가능한 일반 컴퓨터 작업에 직접 입력 버튼이 표시되지 않았습니다.');
  await click(win, '#terminalComputerInputBtn', 'terminal:computer-input-focus');
  await waitFor(win, `document.activeElement === document.querySelector('#terminalViewport .terminal-screen:not(.hidden) .xterm-helper-textarea')`,
    '컴퓨터 작업 직접 입력 버튼이 실제 입력 위치로 이동하지 않았습니다.');
  await setLegacyTerminalMode(win, 'question');
  await waitFor(win, `document.querySelector('#terminalModeQuestionBtn')?.getAttribute('aria-pressed') === 'true'`,
    'AI 질문 모드로 돌아오지 못했습니다.');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#terminalAttachTrigger')?.classList.contains('hidden')
    && document.querySelector('#terminalAttachTrigger')?.disabled`),
  '구현되지 않은 파일 첨부 버튼이 질문 명령 메뉴 동작으로 잘못 노출되었습니다.');
  await setLegacyTerminalMode(win, 'computer');
  await waitFor(win, `document.querySelector('#terminalModeComputerBtn')?.getAttribute('aria-pressed') === 'true'
    && getComputedStyle(document.querySelector('#terminalResourcePanel')).display !== 'none'`,
  '터미널 세션 목록 키보드 검증 전에 컴퓨터 작업 목록을 표시하지 못했습니다.');
  const terminalSessionToolsInitiallyOpen = await win.webContents.executeJavaScript(
    `document.querySelector('.terminal-session-tools')?.hasAttribute('open')`,
  );
  if (terminalSessionToolsInitiallyOpen) {
    await click(win, '.terminal-session-tools > summary', 'terminal:session-controls-close');
    await waitFor(win, `!document.querySelector('.terminal-session-tools')?.hasAttribute('open')`,
      '복원된 터미널 세션 관리 메뉴를 닫지 못했습니다.');
  }
  await click(win, '.terminal-session-tools > summary', 'terminal:session-controls-open');
  await waitFor(win, `document.querySelector('.terminal-session-tools')?.hasAttribute('open')`, '터미널 세션 관리 메뉴가 열리지 않았습니다.');
  const terminalListSemantics = await win.webContents.executeJavaScript(`(() => ({
    role: document.querySelector('#terminalSessionList')?.getAttribute('role'),
    options: document.querySelectorAll('#terminalSessionList [role="option"]').length,
    handles: document.querySelectorAll('#terminalSessionList .terminal-session-drag-handle').length,
    tabStops: document.querySelectorAll('#terminalSessionList [data-terminal-id][tabindex="0"]').length,
    selected: document.querySelectorAll('#terminalSessionList [data-terminal-id][aria-selected="true"]').length,
    noHorizontalOverflow: document.querySelector('#terminalSessionList').scrollWidth <= document.querySelector('#terminalSessionList').clientWidth + 2,
  }))()`);
  assert(terminalListSemantics.role === 'listbox' && terminalListSemantics.options > 1 && terminalListSemantics.handles === terminalListSemantics.options && terminalListSemantics.tabStops === 1 && terminalListSemantics.selected <= 1 && terminalListSemantics.noHorizontalOverflow, `터미널 세션 목록 ARIA·드래그 레이아웃 계약 실패: ${JSON.stringify(terminalListSemantics)}`);
  assert(await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-terminal-id="terminal-ended"]') && document.querySelector('[data-terminal-id="terminal-failed"]'))`), '직접 닫지 않은 종료·실패 터미널이 세션 터미널 목록에서 사라졌습니다.');
  const resumedFailedAgentPresentation = await win.webContents.executeJavaScript(`(() => {
    const item = document.querySelector('[data-terminal-id="terminal-resumed-failed-agent"]');
    return { status: item?.dataset.status || '', text: item?.innerText || '' };
  })()`);
  assert(resumedFailedAgentPresentation.status === 'running'
    && !resumedFailedAgentPresentation.text.includes('열지 못함'),
  `실패 이력을 재개한 실행 중 터미널을 열기 실패로 표시했습니다: ${JSON.stringify(resumedFailedAgentPresentation)}`);
  const initialOrder = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#terminalSessionList [data-terminal-id]')].map(item => item.dataset.terminalId)`);
  if (round.index > 1) {
    const restoredRaceOrder = initialOrder.filter(id => ['terminal-race-a', 'terminal-race-b'].includes(id));
    assert(restoredRaceOrder[0] === expectedTerminalFirstAfterReload,
      `저장된 터미널 순서가 재로드 후 복원되지 않았습니다: ${JSON.stringify({ expected: expectedTerminalFirstAfterReload, restoredRaceOrder, initialOrder })}`);
  }
  const terminalEndKey = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#terminalSessionList [data-terminal-id]')]
      .filter(item => !item.closest('details:not([open])'));
    const first = items[0];
    first.focus();
    const accepted = first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    const allItems = [...document.querySelectorAll('#terminalSessionList [data-terminal-id]')];
    return {
      accepted,
      active: document.activeElement?.dataset.terminalId || document.activeElement?.id || document.activeElement?.tagName,
      expected: items.at(-1)?.dataset.terminalId,
      tabStops: allItems.filter(item => item.tabIndex === 0).map(item => item.dataset.terminalId),
      hiddenTabStops: allItems.filter(item => item.tabIndex === 0 && item.closest('details:not([open])')).map(item => item.dataset.terminalId),
    };
  })()`);
  assert(terminalEndKey.active === terminalEndKey.expected
    && terminalEndKey.tabStops.length === 1
    && terminalEndKey.tabStops[0] === terminalEndKey.expected
    && terminalEndKey.hiddenTabStops.length === 0,
  `접힌 터미널 세션을 제외한 End 키 이동 실패: ${JSON.stringify(terminalEndKey)}`);
  await click(win, '.terminal-past-sessions > summary', 'terminal:past-sessions');
  await waitFor(win, `document.querySelector('.terminal-past-sessions')?.open`,
    '완료·실패한 터미널 목록을 펼치지 못했습니다.');
  const expandedTerminalEndKey = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#terminalSessionList [data-terminal-id]')]
      .filter(item => !item.closest('details:not([open])'));
    const first = items[0];
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    return {
      active: document.activeElement?.dataset.terminalId || document.activeElement?.id || document.activeElement?.tagName,
      expected: items.at(-1)?.dataset.terminalId,
      tabStops: items.filter(item => item.tabIndex === 0).map(item => item.dataset.terminalId),
    };
  })()`);
  assert(expandedTerminalEndKey.active === expandedTerminalEndKey.expected
    && expandedTerminalEndKey.tabStops.length === 1
    && expandedTerminalEndKey.tabStops[0] === expandedTerminalEndKey.expected,
  `펼친 터미널 세션의 End 키 이동 실패: ${JSON.stringify(expandedTerminalEndKey)}`);
  await click(win, '[data-terminal-failure-cause="terminal-failed"]', 'terminal:failure-cause');
  await waitFor(win, `document.querySelector('#terminalNotice')?.dataset.tone === 'error'
    && document.querySelector('#terminalNotice')?.textContent.includes('응답하지 않았습니다')`,
  '실패 원인 버튼이 실제 오류 이유를 안내하지 못했습니다.');
  await clearCalls(win);
  await click(win, '[data-terminal-restart-inline="terminal-failed"]', 'terminal:failure-restart-inline');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalRestart' && item.args[0] === 'terminal-failed')
    && !document.querySelector('[data-terminal-restart-inline="terminal-failed"]')`,
  '실패 세션의 목록 안 다시 열기 버튼이 동작하지 않았습니다.');
  assert(await callCount(win, 'terminalRestart') === 1, '목록 안 다시 열기 버튼이 터미널을 한 번만 재시작해야 합니다.');
  mark('terminal:keyboard-roaming');
  const reordered = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#terminalSessionList [data-terminal-id]')];
    const source = items[1];
    const target = items[0];
    if (!source || !target || !source.draggable) return { ok: false, reason: 'draggable session items missing' };
    const before = items.map(item => item.dataset.terminalId);
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const bounds = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: bounds.top + 1, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientY: bounds.top + 1, dataTransfer: transfer }));
    const after = [...document.querySelectorAll('#terminalSessionList [data-terminal-id]')].map(item => item.dataset.terminalId);
    return { ok: after[0] === before[1], before, after, stored: JSON.parse(localStorage.getItem('loadtoagent:terminal-session-order:v1') || '[]') };
  })()`);
  assert(reordered.ok && reordered.stored[0] === reordered.after[0], `터미널 세션 드래그 순서 변경 실패: ${JSON.stringify(reordered)}`);
  await recordExercise(win, '#terminalSessionList [data-terminal-id][draggable="true"]');
  assert(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-session-move], [data-session-order-move]').length === 0`), '위치 변경용 화살표 버튼이 남아 있습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('[data-terminal-id="${reordered.after[0]}"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(win, `JSON.stringify(${JSON.stringify(reordered.before)}) === JSON.stringify([...document.querySelectorAll('#terminalSessionList [data-terminal-id]')].map(item => item.dataset.terminalId))`, 'Alt+아래 키로 드래그 이전 터미널 순서를 복원하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const item = document.querySelector('#terminalSessionList [data-terminal-id]');
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  })()`);
  await waitFor(win, `document.querySelectorAll('#terminalSessionList [data-terminal-id]')[1]?.dataset.terminalId === ${JSON.stringify(reordered.before[0])}`, 'Alt+아래 키로 터미널 세션 순서를 변경하지 못했습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('[data-terminal-id="${reordered.before[0]}"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(win, `JSON.stringify(${JSON.stringify(reordered.before)}) === JSON.stringify([...document.querySelectorAll('#terminalSessionList [data-terminal-id]')].map(item => item.dataset.terminalId))`, 'Alt+위 키로 터미널 세션 순서를 복원하지 못했습니다.');
  round.observed.terminalReorder = { drag: true, keyboard: true, arrowsRemoved: true, persisted: round.index > 1 };
  await clearCalls(win);
  await invokeLegacyTerminalControl(win, '#newPowerShellBtn', 2);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate')`, 'Windows 터미널 생성 실패');
  assert(await callCount(win, 'terminalCreate') === 1, 'Windows 터미널 버튼 연속 클릭이 중복 세션을 만들었습니다.');
  mark('terminal:create-single-flight');
  await clearCalls(win);
  await invokeLegacyTerminalControl(win, '#newWslBtn');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate')`, 'Linux 터미널 생성 실패');
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ failures: { terminalResize: 1 }, delays: { terminalRestart: 180 } })`);
  await click(win, '[data-terminal-id="terminal-ended"]', 'terminal:select-session', 1, 1, '.terminal-past-sessions');
  await sleep(300);
  const endedRestartPresentation = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#terminalRestartBtn');
    const active = document.querySelector('.terminal-session-item.active');
    return {
      active: active?.dataset.terminalId || '',
      mode: document.querySelector('#terminalModeComputerBtn')?.getAttribute('aria-pressed') || '',
      buttonHidden: button?.classList.contains('hidden'),
      buttonRects: button?.getClientRects().length || 0,
      buttonDisabled: button?.disabled,
      ready: active?.dataset.terminalId === 'terminal-ended'
        && document.querySelector('#terminalModeComputerBtn')?.getAttribute('aria-pressed') === 'true'
        && !button?.classList.contains('hidden')
        && button?.getClientRects().length > 0,
    };
  })()`);
  assert(endedRestartPresentation.ready,
    `종료 세션 다시 시작 버튼이 표시되지 않았습니다: ${JSON.stringify(endedRestartPresentation)}`);
  const initialFontSize = await win.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('loadtoagent:terminal-view:v1') || '{"fontSize":15}').fontSize || 15`);
  await click(win, '#terminalFontDecreaseBtn', 'terminal:font-decrease');
  await waitFor(win, `JSON.parse(localStorage.getItem('loadtoagent:terminal-view:v1') || '{}').fontSize === ${Math.max(12, initialFontSize - 1)}`, '터미널 글자 축소가 반영되지 않았습니다.');
  await click(win, '#terminalFontIncreaseBtn', 'terminal:font-increase');
  await waitFor(win, `JSON.parse(localStorage.getItem('loadtoagent:terminal-view:v1') || '{}').fontSize === ${initialFontSize}`, '터미널 글자 확대가 반영되지 않았습니다.');
  await click(win, '#terminalFocusBtn', 'terminal:focus-mode');
  await waitFor(win, `document.querySelector('#terminalSection')?.classList.contains('terminal-focus-mode') && document.querySelector('#terminalFocusBtn')?.getAttribute('aria-pressed') === 'true'`, '터미널 집중 보기가 활성화되지 않았습니다.');
  await click(win, '#terminalFocusBtn', 'terminal:focus-mode');
  await waitFor(win, `!document.querySelector('#terminalSection')?.classList.contains('terminal-focus-mode') && document.querySelector('#terminalFocusBtn')?.getAttribute('aria-pressed') === 'false'`, '터미널 집중 보기가 해제되지 않았습니다.');
  await clearCalls(win);
  await click(win, '#terminalRestartBtn', 'terminal:restart');
  await waitFor(win, `(() => {
    const button = document.querySelector('#terminalRestartBtn');
    return button.disabled && button.getAttribute('aria-busy') === 'true';
  })()`, '터미널 다시 시작 중 바쁜 상태가 표시되지 않았습니다.');
  await recordManifest(win);
  await win.webContents.executeJavaScript(`document.querySelector('#terminalRestartBtn').click()`);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalRestart')`, '종료 세션 다시 시작 실패');
  await sleep(240);
  assert(await callCount(win, 'terminalRestart') === 1, '터미널 다시 시작 연속 클릭이 중복 호출되었습니다.');
  mark('quality:terminal-restart-busy');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await win.webContents.executeJavaScript(`(() => {
    window.interactionTest.setTerminalGetDelays({ 'terminal-race-a': 220, 'terminal-race-b': 20 });
    for (const id of ['terminal-race-a', 'terminal-race-b']) {
      const entry = window.LoadToAgentTerminal.state?.terminals?.get?.(id) || window.LoadToAgentApp.state.terminals?.get?.(id);
      entry?.terminal?.dispose?.();
      entry?.host?.remove?.();
      window.LoadToAgentApp.state.terminals?.delete?.(id);
    }
  })()`);
  await click(win, '[data-terminal-id="terminal-race-a"]', 'terminal:select-session');
  await click(win, '[data-terminal-id="terminal-race-b"]', 'terminal:select-session');
  await sleep(300);
  const terminalRace = await win.webContents.executeJavaScript(`(() => ({
    selected: window.LoadToAgentApp.state.selectedId,
    activeItem: document.querySelector('.terminal-session-item.active')?.dataset.terminalId || '',
    visibleScreens: [...document.querySelectorAll('.terminal-screen:not(.hidden)')].map(node => node.dataset.terminalScreen),
  }))()`);
  assert(terminalRace.activeItem === 'terminal-race-b' && terminalRace.visibleScreens.length === 1 && terminalRace.visibleScreens[0] === 'terminal-race-b', `빠른 터미널 선택에서 오래된 화면이 덮어썼습니다: ${JSON.stringify(terminalRace)}`);
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await click(win, '[data-terminal-id="terminal-main"]', 'terminal:select-session');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`window.interactionTest.emitTerminalReconnect('terminal-main')`);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalGet' && item.args[0] === 'terminal-main')`, '호스트 복구 뒤 선택된 터미널 replay를 다시 불러오지 않았습니다.');
  await waitFor(win, `document.querySelector('[data-terminal-id="terminal-main"]')?.innerText.includes('연결이 끊겼다가 자동으로 다시 이어짐')`, '컴퓨터 작업 화면 자동 복구 상태가 목록에 표시되지 않았습니다.');
  mark('terminal:host-reconnect-rehydrate');

  await focusRoot(win);
  await click(win, '[data-open-session="fixture-root"]', 'drawer:open-graph');
  await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open')
    && document.querySelector('#drawerComposer [data-agent-command-form="fixture-root"]')?.dataset.agentCommandInputModeSelected === 'terminal'
    && window.LoadToAgentTerminal.embeddedState().connected
    && window.LoadToAgentTerminal.embeddedState().terminalId === 'terminal-main'`,
  'AI 작업의 별도 대화창에서 연결 터미널을 열지 못했습니다.', 120);
  const targetDiagnostic = await win.webContents.executeJavaScript(`(() => {
    const session = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === 'fixture-root');
    return {
      targets: window.LoadToAgentTerminal.agentTargets(session),
      terminals: [...document.querySelectorAll('[data-terminal-id]')].map(item => ({ id: item.dataset.terminalId, text: item.textContent })),
      presence: session && session.runtimePresence,
      sending: window.LoadToAgentApp.state.agentCommandSending.has('fixture-root'),
      drawerOpen: document.querySelector('#detailDrawer')?.classList.contains('open') || false,
      embeddedTerminalId: window.LoadToAgentTerminal.embeddedState().terminalId || '',
    };
  })()`);
  assert(targetDiagnostic.targets.length > 0 && targetDiagnostic.drawerOpen && targetDiagnostic.embeddedTerminalId === 'terminal-main', `fixture AI 터미널 대상이 별도 대화창에서 사라졌습니다: ${JSON.stringify(targetDiagnostic)}`);
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await click(win, '[data-view="terminal"]', 'nav:terminal');
  await click(win, '[data-terminal-id="terminal-main"]', 'terminal:select-session');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'terminal' && document.querySelector('.terminal-session-item.active')?.dataset.terminalId === 'terminal-main' && !document.querySelector('#terminalHistoryPanel').classList.contains('hidden')`, '별도 대화창에서 확인한 연결 터미널을 전체 화면으로 열지 못했습니다.', 120);

  await win.webContents.executeJavaScript(`window.interactionTest.clearCalls(); (() => {
    const input = document.querySelector('#terminalCommandInput');
    input.value = '/cont';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, `!document.querySelector('#terminalSlashMenu')?.classList.contains('hidden')
    && document.querySelectorAll('#terminalSlashMenuList [role="option"]').length === 1
    && document.querySelector('#terminalSlashMenuList')?.textContent.includes('/context')
    && document.querySelector('#terminalCommandInput')?.getAttribute('aria-expanded') === 'true'`,
  'Claude AI 터미널에서 / 명령 추천이 열리지 않았습니다.');
  await recordExercise(win, '#terminalCommandInput');
  await recordExercise(win, '[data-terminal-slash-command]');
  const slashSelection = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#terminalCommandInput');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    return {
      value: input.value,
      menuHidden: document.querySelector('#terminalSlashMenu').classList.contains('hidden'),
      expanded: input.getAttribute('aria-expanded'),
      activeDescendant: input.getAttribute('aria-activedescendant'),
    };
  })()`);
  assert(slashSelection.value === '/context' && slashSelection.menuHidden && slashSelection.expanded === 'false'
    && !slashSelection.activeDescendant, `슬래시 명령 키보드 선택 계약 실패: ${JSON.stringify(slashSelection)}`);
  assert(await callCount(win, 'terminalCommand') === 0, '추천 명령을 고르기만 했는데 터미널로 즉시 전송했습니다.');
  await click(win, '#terminalCommandClearBtn', 'terminal:clear-draft');
  await click(win, '#terminalSlashTrigger', 'terminal:slash-open');
  await waitFor(win, `document.querySelectorAll('#terminalSlashMenuList [role="option"]').length === 6`, 'Claude 빠른 명령 전체 목록이 표시되지 않았습니다.');
  const slashEscape = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#terminalCommandInput');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return { value: input.value, hidden: document.querySelector('#terminalSlashMenu').classList.contains('hidden') };
  })()`);
  assert(slashEscape.value === '/' && slashEscape.hidden, `Esc가 입력을 지우지 않고 추천창만 닫아야 합니다: ${JSON.stringify(slashEscape)}`);
  await click(win, '#terminalCommandClearBtn', 'terminal:clear-draft');
  mark('terminal:slash-command-palette');

  const collapsedLongDraft = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#terminalCommandInput');
    input.value = Array.from({ length: 18 }, (_, index) => \`긴 요청 \${index + 1}: 구현 내용과 검증 기준을 문장 단위로 명확하게 정리하고 가독성을 유지해줘.\`).join('\\n');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const form = document.querySelector('#terminalCommandForm');
    const meta = document.querySelector('#terminalLongDraftMeta');
    return {
      long: form.dataset.longDraft,
      expanded: form.dataset.longDraftExpanded,
      clientHeight: input.clientHeight,
      scrollHeight: input.scrollHeight,
      noHorizontalOverflow: input.scrollWidth <= input.clientWidth + 2 && form.scrollWidth <= form.clientWidth + 2,
      summary: document.querySelector('#terminalLongDraftSummary')?.textContent || '',
      metaVisible: !meta.classList.contains('hidden'),
    };
  })()`);
  assert(collapsedLongDraft.long === 'true' && collapsedLongDraft.expanded === 'false'
    && collapsedLongDraft.clientHeight <= 114 && collapsedLongDraft.scrollHeight > collapsedLongDraft.clientHeight
    && collapsedLongDraft.noHorizontalOverflow && collapsedLongDraft.metaVisible
    && collapsedLongDraft.summary.includes('긴 입력'), `긴 입력 자동 축약 계약 실패: ${JSON.stringify(collapsedLongDraft)}`);
  await click(win, '#terminalLongDraftToggle', 'terminal:long-draft-expand');
  const expandedLongDraft = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#terminalCommandInput');
    const form = document.querySelector('#terminalCommandForm');
    return {
      expanded: form.dataset.longDraftExpanded,
      clientHeight: input.clientHeight,
      ariaExpanded: document.querySelector('#terminalLongDraftToggle')?.getAttribute('aria-expanded'),
    };
  })()`);
  assert(expandedLongDraft.expanded === 'true' && expandedLongDraft.ariaExpanded === 'true'
    && expandedLongDraft.clientHeight > collapsedLongDraft.clientHeight,
  `긴 입력 펼치기 계약 실패: ${JSON.stringify({ collapsedLongDraft, expandedLongDraft })}`);
  await click(win, '#terminalLongDraftToggle', 'terminal:long-draft-collapse');
  await waitFor(win, `document.querySelector('#terminalCommandForm')?.dataset.longDraftExpanded === 'false'
    && document.querySelector('#terminalCommandInput')?.clientHeight <= 114`, '긴 입력 다시 접기가 동작하지 않았습니다.');
  await click(win, '#terminalCommandClearBtn', 'terminal:clear-draft');
  mark('terminal:long-draft-readability');

  await click(win, '#terminalHistoryToggle', 'terminal:history-collapse');
  await waitFor(win, `document.querySelector('#terminalHistoryToggle').getAttribute('aria-expanded') === 'false'`, '대화 기록 접기 실패');
  await click(win, '#terminalHistoryToggle', 'terminal:history-expand');
  await waitFor(win, `document.querySelector('#terminalHistoryToggle').getAttribute('aria-expanded') === 'true'`, '대화 기록 펼치기 실패');

  await setLegacyTerminalMode(win, 'computer');
  await waitFor(win, `document.querySelector('#terminalModeComputerBtn')?.getAttribute('aria-pressed') === 'true'
    && getComputedStyle(document.querySelector('#terminalResourcePanel')).display !== 'none'`,
  '터미널 신호 버튼 검증 전에 컴퓨터 작업 모드로 돌아오지 못했습니다.');
  if (!await win.webContents.executeJavaScript(`document.querySelector('.terminal-session-tools')?.open`)) {
    await click(win, '.terminal-session-tools > summary', 'terminal:session-controls');
  }
  await waitFor(win, `document.querySelector('.terminal-session-tools')?.open`,
    '터미널 신호 버튼이 들어 있는 세션 관리 메뉴를 열지 못했습니다.');
  await clearCalls(win);
  await click(win, '[data-terminal-signal="interrupt"]', 'terminal:signal-interrupt');
  await click(win, '[data-terminal-signal="clear"]', 'terminal:signal-clear');
  await waitFor(win, `window.interactionTest.getCalls().filter(item => item.name === 'terminalSignal').length === 2`, '터미널 signal 두 종류가 호출되지 않았습니다.');

  await win.webContents.executeJavaScript(`window.interactionTest.clearControls(); window.interactionTest.clearCalls()`);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#terminalCommandInput');
    input.value = '한글 조합 중';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  })()`);
  assert(await win.webContents.executeJavaScript(`document.querySelector('#terminalCommandCount').textContent.includes('7') && document.querySelector('#terminalCommandInput').maxLength === 8000`), '터미널 명령 글자 수와 최대 길이가 표시되지 않았습니다.');
  mark('terminal:ime-enter');
  await sleep(180);
  assert(await callCount(win, 'terminalCommand') === 0, 'IME 조합 중 Enter가 명령을 전송했습니다.');

  await win.webContents.executeJavaScript(`window.interactionTest.clearCalls(); window.interactionTest.configure({ delays: { terminalCommand: 180 } })`);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#terminalCommandInput');
    input.value = 'DUPLICATE_GUARD';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const press = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    press(); press();
  })()`);
  mark('terminal:duplicate-enter');
  await sleep(450);
  assert(await callCount(win, 'terminalCommand') === 1, 'Enter 연타로 같은 명령이 중복 전송되었습니다.');

  const historyNavigation = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#terminalCommandInput');
    input.value = 'UNSENT_DRAFT';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    const previous = input.value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    return { previous, restored: input.value };
  })()`);
  assert(historyNavigation.previous === 'DUPLICATE_GUARD' && historyNavigation.restored === 'UNSENT_DRAFT', `터미널 명령 기록 또는 미전송 초안 복원 실패: ${JSON.stringify(historyNavigation)}`);
  mark('quality:terminal-command-history');
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#terminalCommandInput'); input.value = 'x'.repeat(7200); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(win, `document.querySelector('#terminalCommandCount').classList.contains('warning') && document.querySelector('#globalStatus').textContent.length > 0`, '터미널 명령 길이 경고가 표시되거나 안내되지 않았습니다.');
  mark('quality:terminal-length-warning');

  await win.webContents.executeJavaScript(`window.interactionTest.clearControls(); window.interactionTest.clearCalls(); window.interactionTest.configure({ failures: { terminalCommand: 1 } })`);
  await waitFor(win, `!document.querySelector('#terminalCommandForm button[type="submit"]').disabled`, '실패 보존 검증 전에 전송 버튼이 활성화되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#terminalCommandInput');
    input.value = 'FAILURE_DRAFT_MUST_STAY';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click(win, '#terminalCommandForm button[type="submit"]', 'terminal:failure-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCommand')`, '실패 fixture 명령이 호출되지 않았습니다.');
  await sleep(120);
  const retained = await win.webContents.executeJavaScript(`document.querySelector('#terminalCommandInput').value`);
  assert(retained === 'FAILURE_DRAFT_MUST_STAY', '터미널 전송 실패 후 작성 중인 명령이 보존되지 않았습니다.');
  assert(await win.webContents.executeJavaScript(`document.activeElement?.id === 'terminalNotice'`), '터미널 전송 실패 후 오류 안내로 초점이 이동하지 않았습니다.');
  await click(win, '#terminalCommandClearBtn', 'terminal:clear-draft');
  await waitFor(win, `document.querySelector('#terminalCommandInput').value === '' && document.activeElement?.id === 'terminalCommandInput' && document.querySelector('#terminalCommandClearBtn').classList.contains('hidden')`, '터미널 명령 지우기가 값·버튼·초점을 초기화하지 못했습니다.');

  await win.webContents.executeJavaScript(`window.interactionTest.clearControls(); window.interactionTest.clearCalls()`);
  await click(win, '[data-terminal-id="terminal-managed"]', 'terminal:select-session');
  await click(win, '#terminalCloseBtn', 'terminal:close');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalDetach')`, '관리형 AI 터미널 화면 닫기가 tmux 작업을 분리하지 않았습니다.');
  assert(await callCount(win, 'terminalDetach') === 1 && await callCount(win, 'terminalClose') === 0, '관리형 화면 닫기는 terminalDetach만 한 번 호출해야 합니다.');
  await waitFor(win, `document.querySelector('[data-terminal-id="terminal-managed"]')?.innerText.includes('이 화면은 닫혔지만 작업은 계속 실행 중')`, '분리된 관리형 세션이 목록에 유지되지 않았습니다.');
  await setLegacyTerminalMode(win, 'computer');
  await waitFor(win, `getComputedStyle(document.querySelector('#terminalResourcePanel')).display !== 'none'`,
    '분리된 관리형 세션을 다시 선택할 목록이 표시되지 않았습니다.');
  await click(win, '[data-terminal-id="terminal-managed"]', 'terminal:select-session');
  await waitFor(win, `!document.querySelector('#terminalRestartBtn').classList.contains('hidden') && document.querySelector('#terminalRestartBtn').textContent.includes('다시 연결')`, '분리된 관리형 세션에 다시 연결 동작이 표시되지 않았습니다.');
  await click(win, '#terminalRestartBtn', 'terminal:restart');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalReconnect')`, '분리된 관리형 세션이 기존 tmux 작업에 재접속하지 않았습니다.');
  assert(await callCount(win, 'terminalReconnect') === 1 && await callCount(win, 'terminalRestart') === 0, '관리형 재접속은 새 프로세스 재시작 대신 terminalReconnect를 호출해야 합니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ delays: { terminalStop: 800 } })`);
  // Skip the expensive post-click manifest scan so this assertion observes the
  // in-flight state instead of racing the deliberately delayed fixture.
  await click(win, '#terminalEndSessionBtn', 'terminal:end-session', 1, 1, '', false);
  assert(await win.webContents.executeJavaScript(`document.querySelector('#terminalEndSessionBtn').disabled && document.querySelector('#terminalEndSessionBtn').getAttribute('aria-busy') === 'true'`), '관리형 AI 작업 중단 중 바쁜 상태가 표시되지 않았습니다.');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalStop')`, '관리형 AI 작업 중단이 terminalStop을 호출하지 않았습니다.');
  await waitFor(win, `document.querySelector('[data-terminal-id="terminal-managed"]')?.innerText.includes('작업 중지됨')`, '중단된 관리형 세션 기록이 목록에 보존되지 않았습니다.');
  assert(await callCount(win, 'terminalStop') === 1 && await callCount(win, 'terminalClose') === 0, '관리형 작업 중단은 기록을 삭제하지 않아야 합니다.');
  await setLegacyTerminalMode(win, 'computer');
  await waitFor(win, `getComputedStyle(document.querySelector('#terminalResourcePanel')).display !== 'none'`,
    '중단된 관리형 세션 기록을 다시 선택할 목록이 표시되지 않았습니다.');
  await click(win, '[data-terminal-id="terminal-managed"]', 'terminal:select-session');
  await waitFor(win, `document.querySelector('#terminalEndSessionBtn').textContent.includes('작업 기록 목록에서 지우기')`, '중단된 관리형 작업에 기록 삭제 동작이 표시되지 않았습니다.');
  await click(win, '#terminalEndSessionBtn', 'terminal:end-session');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalClose')`, '중단된 관리형 세션 기록을 삭제하지 못했습니다.');
  await waitFor(win, `!document.querySelector('[data-terminal-id="terminal-managed"]')`, '삭제한 관리형 세션 기록이 목록에 남아 있습니다.');
  assert(await callCount(win, 'terminalClose') === 1, '관리형 세션 기록 삭제는 terminalClose를 정확히 한 번 호출해야 합니다.');

  await win.webContents.executeJavaScript(`window.interactionTest.clearControls(); window.interactionTest.clearCalls()`);
  await setLegacyTerminalMode(win, 'computer');
  await waitFor(win, `getComputedStyle(document.querySelector('#terminalResourcePanel')).display !== 'none'`,
    'AI 연결 터미널을 선택할 목록이 표시되지 않았습니다.');
  await click(win, '[data-terminal-id="terminal-main"]', 'terminal:select-session');
  await click(win, '#terminalCloseBtn', 'terminal:close');
  await sleep(220);
  const aiCloseView = await win.webContents.executeJavaScript(`(() => ({
    activeTerminalId: document.querySelector('.terminal-session-item.active')?.dataset.terminalId || '',
    terminalStillListed: Boolean(document.querySelector('[data-terminal-id="terminal-main"]')),
    historyHidden: document.querySelector('#terminalHistoryPanel').classList.contains('hidden'),
    emptyStateVisible: !document.querySelector('#terminalEmpty')?.classList.contains('hidden'),
    closeLabel: document.querySelector('#terminalCloseBtn')?.textContent || '',
  }))()`);
  assert(!aiCloseView.activeTerminalId && aiCloseView.terminalStillListed && aiCloseView.historyHidden && aiCloseView.emptyStateVisible, `AI 연결 터미널 닫기가 AI 세션을 종료하지 않고 화면만 닫지 못했습니다: ${JSON.stringify(aiCloseView)}`);
  assert(await callCount(win, 'terminalClose') === 0, 'AI 연결 터미널 화면을 닫는 동안 AI 프로세스가 종료됐습니다.');
  await setLegacyTerminalMode(win, 'computer');
  await waitFor(win, `getComputedStyle(document.querySelector('#terminalResourcePanel')).display !== 'none'`,
    '닫은 AI 연결 터미널을 다시 선택할 목록이 표시되지 않았습니다.');
  await click(win, '[data-terminal-id="terminal-main"]', 'terminal:select-session');
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ delays: { terminalClose: 180 } })`);
  await click(win, '#terminalEndSessionBtn', 'terminal:end-session');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#terminalEndSessionBtn').disabled && document.querySelector('#terminalEndSessionBtn').getAttribute('aria-busy') === 'true'`), 'AI 터미널 명시적 종료 중 바쁜 상태가 표시되지 않았습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('#terminalEndSessionBtn').click()`);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalClose')`, '세션 종료 버튼이 terminalClose를 호출하지 않았습니다.');
  await waitFor(win, `!document.querySelector('[data-terminal-id="terminal-main"]')`, '종료된 세션이 목록에서 제거되지 않았습니다.');
  assert(await callCount(win, 'terminalClose') === 1, '세션 종료 클릭 한 번에 terminalClose가 정확히 한 번 호출되어야 합니다.');
  mark('quality:terminal-close-busy');
  expectedTerminalFirstAfterReload = await win.webContents.executeJavaScript(`(() => {
    const stored = JSON.parse(localStorage.getItem('loadtoagent:terminal-session-order:v1') || '[]');
    return stored.find(id => ['terminal-race-a', 'terminal-race-b'].includes(id)) || '';
  })()`);
  assert(expectedTerminalFirstAfterReload, '재로드 순서 검증에 사용할 터미널 기준값이 저장되지 않았습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  round.observed.terminal = {
    signals: 2,
    slashPalette: true,
    longDraftCollapsed: true,
    imeGuard: true,
    duplicateGuard: true,
    failureDraft: true,
    closed: true,
  };
}

async function openTmuxControl(win) {
  await click(win, '[data-control-tmux="tmux-pane-id"]', 'tmux:control-pane');
  await waitFor(win, `!document.querySelector('#terminalTmuxTools').classList.contains('hidden') && document.querySelector('[data-tmux-manage="rename-session"]')`, 'tmux 조작 도구가 열리지 않았습니다.', 100);
}

async function recreateTmuxFixtureAfterConfirmedClose(win) {
  await win.webContents.executeJavaScript(`(() => {
    const restored = window.interactionTest.getSnapshot();
    const withoutTmux = { ...restored, tmux: { ...restored.tmux, distros: [] } };
    // Model a backend snapshot that confirms the destructive operation before
    // recreating the shared fixture for the next independent management test.
    window.LoadToAgentTerminal.updateSnapshot(withoutTmux);
    window.LoadToAgentTerminal.updateSnapshot(restored);
  })()`);
  await waitFor(win, `Boolean(document.querySelector('[data-tmux-distro="FixtureLinux"][data-tmux-pane="%7"]'))`, 'tmux 종료 확인 뒤 다음 fixture를 복원하지 못했습니다.');
}

async function verifyOneCall(win, actionName, selector, apiName) {
  await clearCalls(win);
  await click(win, selector, actionName);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === ${JSON.stringify(apiName)})`, `${selector}가 ${apiName}을 호출하지 않았습니다.`);
  assert(await callCount(win, apiName) === 1, `${actionName} 한 번에 ${apiName}이 정확히 한 번 호출되어야 합니다.`);
}

async function exerciseTmux(win, round) {
  if (!await win.webContents.executeJavaScript(`document.querySelector('#drawerBackdrop')?.classList.contains('hidden')`)) {
    await click(win, '#closeDrawerBtn', 'drawer:close');
    await waitFor(win, `document.querySelector('#drawerBackdrop')?.classList.contains('hidden')`, 'tmux 검증 전에 열린 상세 창을 닫지 못했습니다.');
  }
  await click(win, '[data-view="tmux"]', 'nav:tmux');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'tmux' && document.querySelector('[data-control-tmux="tmux-pane-id"]')`, 'tmux 화면 로드 실패', 120);
  const tmuxProjection = await win.webContents.executeJavaScript(`(() => ({
    paneIds: window.LoadToAgentApp.visibleTmux().distros.flatMap(distro => distro.sessions.flatMap(session => session.windows.flatMap(item => item.panes.map(pane => pane.id)))),
    summary: window.LoadToAgentApp.visibleTmux().summary,
  }))()`);
  assert(!tmuxProjection.paneIds.includes('tmux-pane-dead') && tmuxProjection.summary.panes === 3 && tmuxProjection.summary.aiPanes === 3 && tmuxProjection.summary.linked === 2, `종료된 tmux AI 칸이 현재 자원이나 배지에 포함됩니다: ${JSON.stringify(tmuxProjection)}`);
  const nativeEnvironment = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const previous = app.state.platform;
    app.state.platform = { id: 'darwin', label: 'macOS', nativeTmux: true };
    app.renderTmuxMap();
    const result = {
      statLabel: document.querySelector('#tmuxStats strong')?.textContent.trim() || '',
      environment: document.querySelector('.tmux-distro-node > span')?.textContent.trim() || '',
    };
    app.state.platform = previous;
    app.renderTmuxMap();
    return result;
  })()`);
  assert(nativeEnvironment.statLabel.includes('컴퓨터 이름: 업무용 컴퓨터 2')
    && nativeEnvironment.environment === '업무용 컴퓨터 2에서 시작한 작업',
  `다른 컴퓨터 작업 환경 표시가 올바르지 않습니다: ${JSON.stringify(nativeEnvironment)}`);
  const tmuxMapSemantics = await win.webContents.executeJavaScript(`(() => ({
    nodes: document.querySelectorAll('#tmuxMap [data-tmux-type][data-tmux-id]').length,
    tabStops: document.querySelectorAll('#tmuxMap [data-tmux-type][data-tmux-id][tabindex="0"]').length,
  }))()`);
  assert(tmuxMapSemantics.nodes >= 4 && tmuxMapSemantics.tabStops === 1, `tmux 자원 지도 roving tabindex 계약 실패: ${JSON.stringify(tmuxMapSemantics)}`);
  const tmuxEndKey = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#tmuxMap [data-tmux-type][data-tmux-id]')];
    const node = items.find(item => item.tabIndex === 0);
    node.focus();
    const accepted = node.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    return { accepted, active: document.activeElement?.dataset.tmuxId || document.activeElement?.id || document.activeElement?.tagName, expected: items.at(-1)?.dataset.tmuxId, tabStops: items.filter(item => item.tabIndex === 0).map(item => item.dataset.tmuxId) };
  })()`);
  assert(tmuxEndKey.active === tmuxEndKey.expected && tmuxEndKey.tabStops.length === 1 && tmuxEndKey.tabStops[0] === tmuxEndKey.expected, `tmux 자원 지도 End 키 이동 실패: ${JSON.stringify(tmuxEndKey)}`);
  mark('quality:tmux-map-keyboard');
  await click(win, '.tmux-distro-node', 'tmux:focus-node');
  await waitFor(win, `document.querySelector('#tmuxBreadcrumbs [aria-current="location"]') && document.querySelectorAll('#tmuxBreadcrumbs [tabindex="0"]').length === 1 && document.activeElement?.classList.contains('tmux-distro-node')`, 'tmux 이동 경로 현재 위치와 단일 탭 정지가 표시되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => { const current = document.querySelector('#tmuxBreadcrumbs [aria-current="location"]'); current.focus(); current.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })); })()`);
  await waitFor(win, `document.activeElement?.hasAttribute('data-tmux-reset') && document.activeElement.tabIndex === 0`, 'tmux 이동 경로 Home 키 이동 실패');
  mark('quality:tmux-breadcrumb-keyboard');
  await click(win, '#tmuxResetBtn', 'tmux:reset');
  await waitFor(win, `window.LoadToAgentApp.state.tmuxFocus === null`, 'tmux 이동 경로 전체 목록 복귀 실패');
  round.observed.tmuxSubagents = { hiddenInSimplifiedMap: true, availableInAgentFlow: true };
  await clearCalls(win);
  await click(win, '[data-control-tmux="tmux-pane-id"]', 'tmux:control-pane');
  await waitFor(win, `!document.querySelector('#terminalTmuxTools').classList.contains('hidden')`, 'tmux resource 목록 선택 실패');
  await clearCalls(win);
  await click(win, '[data-tmux-distro="FixtureLinux"][data-tmux-pane="%7"]', 'tmux:select-resource');
  await waitFor(win, `(() => {
    const selected = document.querySelector('[data-tmux-distro="FixtureLinux"][data-tmux-pane="%7"]');
    return selected?.classList.contains('active')
      && selected.getAttribute('aria-selected') === 'true'
      && selected.getAttribute('aria-pressed') === 'true'
      && selected.tabIndex === 0
      && document.querySelectorAll('[data-tmux-distro][data-tmux-pane][aria-selected="true"]').length === 1
      && window.interactionTest.getCalls().some(item => item.name === 'tmuxCapture' && item.args[0]?.target === '%7');
  })()`, 'tmux 자원 목록에서 선택한 칸이 현재 선택 상태와 캡처 대상에 반영되지 않았습니다.', 160);
  await waitFor(win, `(() => { const screen = document.querySelector('[data-terminal-screen="__tmux_remote__"]:not(.hidden)'); return window.interactionTest.getCalls().some(item => item.name === 'tmuxCapture' && item.args[0]?.target === '%7') && Number(screen?.dataset.baseY) > 0 && Number(screen?.dataset.viewportY) === 0; })()`, 'tmux 첫 화면이 첫 줄에서 시작하지 않습니다.', 160);
  const initialScroll = await win.webContents.executeJavaScript(`(() => { const screen = document.querySelector('[data-terminal-screen="__tmux_remote__"]'); return { top: Number(screen.dataset.viewportY), maximum: Number(screen.dataset.baseY), screen: screen.dataset.terminalScreen }; })()`);
  assert(initialScroll.maximum > 0 && initialScroll.top === 0, `tmux 첫 화면이 첫 줄에서 시작하지 않습니다: ${JSON.stringify(initialScroll)}`);
  await win.webContents.executeJavaScript(`(() => {
    window.LoadToAgentTerminal.scrollTmuxToLine(${initialScroll.maximum});
    window.LoadToAgentTerminal.scrollTmuxByLines(-12);
  })()`);
  await waitFor(win, `(() => { const screen = document.querySelector('[data-terminal-screen="__tmux_remote__"]'); const top = Number(screen.dataset.viewportY); return top >= 0 && top < Number(screen.dataset.baseY); })()`, 'tmux 화면에서 Xterm 휠 스크롤 경로로 과거 출력을 볼 수 없습니다.');
  const scrollProbe = await win.webContents.executeJavaScript(`(() => { const screen = document.querySelector('[data-terminal-screen="__tmux_remote__"]'); return { before: Number(screen.dataset.viewportY), maximum: Number(screen.dataset.baseY) }; })()`);
  const captureRevisionBeforeRefresh = await win.webContents.executeJavaScript(`Number(document.querySelector('[data-terminal-screen="__tmux_remote__"]').dataset.captureRevision || 0)`);
  const captureCountBeforeRefresh = await callCount(win, 'tmuxCapture');
  await waitFor(win, `window.interactionTest.getCalls().filter(item => item.name === 'tmuxCapture').length > ${captureCountBeforeRefresh}`, 'tmux 반복 캡처가 실행되지 않았습니다.', 160);
  await waitFor(win, `Number(document.querySelector('[data-terminal-screen="__tmux_remote__"]').dataset.captureRevision || 0) > ${captureRevisionBeforeRefresh}`, 'tmux 반복 캡처 출력이 화면에 적용되지 않았습니다.', 160);
  await waitFor(win, `(() => { const screen = document.querySelector('[data-terminal-screen="__tmux_remote__"]'); return Math.abs(Number(screen.dataset.viewportY) - ${scrollProbe.before}) <= 1; })()`, 'tmux 반복 캡처 완료 후 사용자 스크롤 위치가 복원되지 않았습니다.', 160);
  const scrollAfter = await win.webContents.executeJavaScript(`(() => { const screen = document.querySelector('[data-terminal-screen="__tmux_remote__"]'); return { top: Number(screen.dataset.viewportY), maximum: Number(screen.dataset.baseY) }; })()`);
  assert(scrollAfter.top < scrollAfter.maximum && Math.abs(scrollAfter.top - scrollProbe.before) <= 1, `tmux 갱신이 사용자의 스크롤 위치를 덮어썼습니다: ${JSON.stringify({ scrollProbe, scrollAfter })}`);
  mark('tmux:wheel-scroll-preserve');
  round.observed.tmuxScroll = { startsAtTop: true, preservesWheelPosition: true };

  // The project-first shell intentionally suppresses the intermediate window
  // heading. Exercise the visible hierarchy nodes; the map keyboard contract
  // above still validates every rendered roving-tabindex node.
  for (const selector of ['.tmux-distro-node', '.tmux-pane-main']) {
    await click(win, selector, 'tmux:focus-node');
    await waitFor(win, `Boolean(window.LoadToAgentApp.state.tmuxFocus)`, `${selector} tmux focus 실패`);
    const resetSelector = await win.webContents.executeJavaScript(`document.querySelector('[data-tmux-reset]') ? '[data-tmux-reset]' : '#tmuxResetBtn'`);
    await click(win, resetSelector, 'tmux:reset');
    await waitFor(win, `window.LoadToAgentApp.state.tmuxFocus === null`, `${selector} focus reset 실패`);
  }
  await click(win, '.tmux-pane-node [data-open-session="fixture-root"]', 'drawer:open-graph');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')`, 'tmux 연결 대화 drawer 열기 실패');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, 'tmux 연결 drawer 닫기 실패');
  await verifyOneCall(win, 'tmux:refresh', '#refreshTmuxTerminalBtn', 'snapshot');

  await click(win, '#newTmuxSessionBtn', 'tmux:modal-open');
  await waitFor(win, `!document.querySelector('#tmuxCreateModal').classList.contains('hidden')`, 'tmux 생성 모달 열기 실패');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#appShell').inert && !document.querySelector('#tmuxCreateModal').inert && document.querySelector('#tmuxCreateModal').getAttribute('aria-hidden') === 'false'`), 'tmux 생성 모달이 배경을 보조 기술에서 격리하지 못했습니다.');
  const tmuxPathLayout = await win.webContents.executeJavaScript(`(() => {
    const field = document.querySelector('#tmuxCreateCwd').parentElement;
    const input = document.querySelector('#tmuxCreateCwd').getBoundingClientRect();
    const button = document.querySelector('#pickTmuxCwdBtn').getBoundingClientRect();
    return {
      display: getComputedStyle(field).display,
      rowAligned: Math.abs(input.top - button.top) <= 1 && Math.abs(input.bottom - button.bottom) <= 1,
      gap: Math.round(button.left - input.right),
      buttonWidth: Math.round(button.width),
    };
  })()`);
  assert(
    tmuxPathLayout.display === 'grid' && tmuxPathLayout.rowAligned
      && tmuxPathLayout.gap >= 8 && tmuxPathLayout.buttonWidth >= 88,
    `tmux 시작 폴더 버튼 간격이 올바르지 않습니다: ${JSON.stringify(tmuxPathLayout)}`,
  );
  mark('quality:tmux-path-spacing');
  mark('tmux:background-inert');
  await click(win, '#closeTmuxCreateBtn', 'tmux:modal-close-x');
  await waitFor(win, `document.querySelector('#tmuxCreateModal').classList.contains('hidden')`, 'tmux 생성 X 닫기 실패');
  await click(win, '#newTmuxSessionBtn', 'tmux:modal-open');
  await click(win, '#cancelTmuxCreateBtn', 'tmux:modal-cancel');
  await waitFor(win, `document.querySelector('#tmuxCreateModal').classList.contains('hidden')`, 'tmux 생성 취소 실패');
  await click(win, '#newTmuxSessionBtn', 'tmux:modal-open');
  await win.webContents.executeJavaScript(`(() => {
    const form = document.querySelector('#tmuxCreateForm');
    const modal = document.querySelector('#tmuxCreateModal');
    form.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  })()`);
  assert(await win.webContents.executeJavaScript(`!document.querySelector('#tmuxCreateModal').classList.contains('hidden')`), 'tmux 생성 창 내부에서 시작한 드래그가 배경에서 끝날 때 창이 닫혔습니다.');
  mark('quality:tmux-safe-backdrop');
  await waitFor(win, `Number(getComputedStyle(document.querySelector('#tmuxCreateModal')).opacity) > 0`, 'tmux 생성 모달 배경이 클릭 가능한 상태가 되지 않았습니다.');
  await click(win, '#tmuxCreateModal', 'tmux:modal-backdrop');
  await waitFor(win, `document.querySelector('#tmuxCreateModal').classList.contains('hidden')`, 'tmux 생성 배경 닫기 실패');

  await click(win, '#newTmuxSessionBtn', 'tmux:modal-open');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#tmuxCreateDistro').value = 'FixtureLinux';
    document.querySelector('#tmuxCreateName').value = 'fixture round ${round.index}';
    document.querySelector('#tmuxCreateCommand').value = 'claude';
  })()`);
  await recordExercise(win, '#tmuxCreateDistro');
  await recordExercise(win, '#tmuxCreateName');
  await recordExercise(win, '#tmuxCreateCwd');
  await recordExercise(win, '#tmuxCreateCommand');
  await win.webContents.executeJavaScript(`document.querySelector('#tmuxCreateName').dispatchEvent(new FocusEvent('blur', { bubbles: true }))`);
  await waitFor(win, `document.querySelector('#tmuxCreateName').value === 'fixture-round-${round.index}'`, 'tmux 작업 이름 공백이 안전한 하이픈으로 정리되지 않았습니다.');
  await clearCalls(win);
  await click(win, '#pickTmuxCwdBtn', 'tmux:pick-cwd');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'pickWorkspace') && document.querySelector('#tmuxCreateCwd').value === 'D:\\\\fixture-picked'`, 'tmux 시작 폴더 찾기가 값을 반영하지 않았습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ failures: { tmuxNewSession: 1 } })`);
  await clearCalls(win);
  await click(win, '#tmuxCreateForm button[type="submit"]', 'tmux:modal-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'tmuxNewSession')`, 'tmuxNewSession 호출 실패');
  await waitFor(win, `!document.querySelector('#tmuxCreateError').classList.contains('hidden') && document.activeElement?.id === 'tmuxCreateError'`, 'tmux 생성 실패 오류가 표시되고 초점되지 않았습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls(); window.interactionTest.clearCalls()`);
  await click(win, '#tmuxCreateForm button[type="submit"]', 'tmux:modal-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'tmuxNewSession') && document.querySelector('#tmuxCreateModal').classList.contains('hidden')`, 'tmux 생성 재시도 호출 실패');
  assert(await callCount(win, 'tmuxNewSession') === 1, 'tmux 생성 submit 한 번에 tmuxNewSession이 한 번 호출되어야 합니다.');

  await openTmuxControl(win);
  await verifyOneCall(win, 'tmux:rename-session', '[data-tmux-manage="rename-session"]', 'tmuxRenameSession');
  await verifyOneCall(win, 'tmux:new-window', '[data-tmux-manage="new-window"]', 'tmuxNewWindow');
  await verifyOneCall(win, 'tmux:split-horizontal', '[data-tmux-manage="split-horizontal"]', 'tmuxSplitPane');
  await verifyOneCall(win, 'tmux:split-vertical', '[data-tmux-manage="split-vertical"]', 'tmuxSplitPane');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#terminalTmuxLayout');
    select.value = 'even-horizontal';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await recordExercise(win, '#terminalTmuxLayout');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'tmuxSelectLayout')`, 'tmux layout 변경 호출 실패');

  await openTmuxControl(win);
  await verifyOneCall(win, 'tmux:kill-pane', '[data-tmux-manage="kill-pane"]', 'tmuxKillPane');
  await sleep(80);
  await recreateTmuxFixtureAfterConfirmedClose(win);

  await openTmuxControl(win);
  await verifyOneCall(win, 'tmux:kill-window', '[data-tmux-manage="kill-window"]', 'tmuxKillWindow');
  await waitFor(win, `document.querySelector('[data-terminal-screen="__tmux_remote__"]').classList.contains('hidden') && document.querySelector('#terminalTmuxTools').classList.contains('hidden') && !document.querySelector('#terminalEmpty').classList.contains('hidden')`, 'tmux 창 종료 후 이전 화면이 즉시 닫히지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-terminal-screen="__tmux_remote__"]').dispatchEvent(new WheelEvent('wheel', { deltaY: 480, bubbles: true }));
    window.LoadToAgentApp.renderSessions('refresh');
  })()`);
  await waitFor(win, `document.querySelector('[data-terminal-screen="__tmux_remote__"]').classList.contains('hidden') && document.querySelector('#terminalTmuxTools').classList.contains('hidden') && !document.querySelector('#terminalEmpty').classList.contains('hidden') && !document.querySelector('.terminal-tmux-pane.active') && document.querySelector('#terminalCloseBtn').disabled`, 'stale tmux 갱신이 닫은 창을 다시 선택했습니다.');
  await sleep(1_150);
  assert(
    await callCount(win, 'tmuxCapture') === 0
      && await win.webContents.executeJavaScript(`document.querySelector('[data-terminal-screen="__tmux_remote__"]').classList.contains('hidden') && document.querySelector('#terminalTmuxTools').classList.contains('hidden')`),
    '닫은 tmux 창이 휠 입력 또는 반복 캡처 뒤 다시 열렸습니다.',
  );
  mark('tmux:kill-window-wheel-closed');
  await recreateTmuxFixtureAfterConfirmedClose(win);

  await openTmuxControl(win);
  await verifyOneCall(win, 'tmux:kill-session', '[data-tmux-manage="kill-session"]', 'tmuxKillSession');
  await sleep(80);
  await recreateTmuxFixtureAfterConfirmedClose(win);
  await openTmuxControl(win);
  await clearCalls(win);
  if (!await win.webContents.executeJavaScript(`document.querySelector('.terminal-session-tools')?.open`)) {
    await click(win, '.terminal-session-tools > summary', 'terminal:session-controls');
  }
  await waitFor(win, `(() => {
    const details = document.querySelector('.terminal-session-tools');
    const button = document.querySelector('#terminalAttachBtn');
    const style = button && getComputedStyle(button);
    const rect = button?.getBoundingClientRect();
    return details?.open
      && button && !button.disabled && !button.classList.contains('hidden')
      && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0
      && rect.width > 0 && rect.height > 0
      && Boolean(document.querySelector('.terminal-tmux-pane.active'))
      && !document.querySelector('#terminalTmuxTools').classList.contains('hidden');
  })()`, '선택한 다른 컴퓨터 작업의 직접 입력 버튼이 실제로 표시되지 않았습니다.');
  await click(win, '#terminalAttachBtn', 'terminal:attach');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate') && !document.querySelector('#terminalCloseBtn').disabled`, 'tmux 직접 조작 attach 실패');
  await clearCalls(win);
  await click(win, '#terminalCloseBtn', 'terminal:close');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalClose')`, 'attach된 tmux 터미널 종료 실패');
  await click(win, '[data-view="all"]', 'nav:all');
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-failed')`);
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && Boolean(document.querySelector('[data-resume-agent="fixture-failed"]'))`, '종료된 AI 세션의 터미널 재개 버튼이 표시되지 않았습니다.');
  await click(win, '[data-resume-agent="fixture-failed"]', 'agent:resume-terminal');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'terminal'
    && !document.querySelector('#detailDrawer').classList.contains('open')
    && Boolean(document.querySelector('.terminal-session-item.active'))`, '터미널 재개 버튼이 종료된 AI 세션을 터미널 화면으로 이어주지 못했습니다.');
  round.observed.tmuxManagement = 8;
}

async function runRound(win, index) {
  activeRoundIndex = index;
  if (index > 1) {
    await win.reload();
  }
  await waitFor(win, `Boolean(window.loadtoagent && window.interactionTest && window.LoadToAgentTerminal && window.LoadToAgentApp.state.snapshot && document.querySelector('#newRunBtn'))`, 'renderer 초기화 실패', 160);
  await installPageGuards(win);
  await recordManifest(win);
  const round = { index, passed: [], failed: [], observed: {} };
  rounds.push(round);
  const runStep = (name, exercise) => {
    if (ONLY_STEPS.size && !ONLY_STEPS.has(name)) return Promise.resolve();
    return step(round, name, exercise);
  };
  await runStep('guide-mobile-tools', () => exerciseGuideAndMobileTools(win, round));
  await runStep('navigation', () => exerciseNavigation(win, round));
  await runStep('quality-enhancements', () => exerciseQualityEnhancements(win, round));
  await runStep('tab-data-routing', () => exerciseTabDataRouting(win, round));
  await runStep('theme-settings', () => exerciseThemeSettings(win, round));
  await runStep('language-settings', () => exerciseLanguageSettings(win, round));
  await runStep('provider-visibility', () => exerciseProviderVisibility(win, round));
  await runStep('updates', () => exerciseUpdates(win, round));
  await runStep('attention-notification', () => exerciseAttentionNotification(win, round));
  await runStep('provider-usage', () => exerciseProviderUsage(win, round));
  await runStep('management-controls', () => exerciseManagementControls(win, round));
  await runStep('dashboard-controls', () => exerciseDashboardControls(win, round));
  await runStep('runtime-overview', () => exerciseRuntimeOverview(win, round));
  await runStep('new-run-modal', () => exerciseRunModal(win, round));
  await runStep('drawer', () => exerciseDrawer(win, round));
  await runStep('graph', () => exerciseGraph(win, round));
  await runStep('agent-controls', () => exerciseAgentControls(win, round));
  await runStep('terminal', () => exerciseTerminal(win, round));
  await runStep('tmux', () => exerciseTmux(win, round));
  const pageErrors = await win.webContents.executeJavaScript('window.__interactionErrors || []');
  if (pageErrors.length) failures.push(`round ${index} · renderer errors: ${pageErrors.join(' | ')}`);
  round.observed.pageErrors = pageErrors;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'interaction-fixture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) failures.push(`renderer console: ${message}`);
  });
  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    for (let index = 1; index <= ROUND_COUNT; index += 1) await runRound(win, index);
    const required = [...new Set([
      ...ACTION_MANIFEST.filter(item => item.required !== false).map(item => item.action),
      'nav:scroll-reset', 'guide:wheel-closed', 'run:required-validation', 'run:failure-preserve', 'run:backdrop',
      'drawer:tabs-keyboard', 'drawer:backdrop', 'terminal:ime-enter', 'terminal:duplicate-enter', 'terminal:history-expand',
      'drawer:close-scroll', 'drawer:background-inert', 'terminal:reorder-drag', 'tmux:wheel-scroll-preserve', 'tmux:kill-window-wheel-closed',
      'nav:keyboard-roaming', 'nav:keyboard-shortcut', 'filter:search-shortcut', 'run:background-inert', 'run:background-restore', 'tmux:background-inert',
      'run:provider-keyboard', 'run:project-lock', 'terminal:create-single-flight',
      'mobile:keyboard-roaming', 'mobile:outside-dismiss', 'mobile:shortcut-guard', 'filter:keyboard-roaming', 'run:submit-close-guard', 'terminal:keyboard-roaming',
      'settings:provider-visibility-rollback',
      'quality:quick-keyboard', 'quality:quick-empty', 'quality:dashboard-storage',
      'quality:memory-lineage-keyboard',
      'quality:runtime-schedule-keyboard', 'quality:runtime-loop-keyboard', 'quality:run-draft-restore',
      'quality:run-whitespace-validation', 'quality:run-safe-backdrop', 'quality:drawer-page-tabs',
      'quality:terminal-restart-busy', 'quality:terminal-command-history', 'quality:terminal-length-warning',
      'quality:terminal-snapshot-focus-guard',
      'quality:terminal-close-busy', 'quality:tmux-map-keyboard', 'quality:tmux-breadcrumb-keyboard', 'quality:tmux-safe-backdrop',
      'quality:drawer-drag-safe',
    ])];
    for (const action of ONLY_STEPS.size ? [] : required) {
      const count = Number(coverage.get(action) || 0);
      if (count < ROUND_COUNT) failures.push(`coverage · ${action}: ${count}/${ROUND_COUNT} rounds`);
    }
    const requiredManifest = ONLY_STEPS.size ? [] : ACTION_MANIFEST.filter(entry => entry.required !== false);
    for (const entry of requiredManifest) {
      const activatedRounds = selectorActivations.get(entry.selector)?.size || 0;
      if (activatedRounds < ROUND_COUNT) failures.push(`selector activation · ${entry.selector}: ${activatedRounds}/${ROUND_COUNT} rounds`);
    }
    for (const entry of requiredManifest) if (!manifestSeen.has(entry.selector)) failures.push(`manifest unseen · ${entry.selector}`);
    if (!ONLY_STEPS.size) for (const html of manifestUnknown) failures.push(`manifest unknown · ${html}`);
    const activatedRequired = requiredManifest
      .filter(entry => (selectorActivations.get(entry.selector)?.size || 0) >= ROUND_COUNT)
      .map(entry => entry.selector);
    const requiredNotActivated = requiredManifest
      .filter(entry => (selectorActivations.get(entry.selector)?.size || 0) < ROUND_COUNT)
      .map(entry => ({
        selector: entry.selector,
        activatedRounds: selectorActivations.get(entry.selector)?.size || 0,
        requiredRounds: ROUND_COUNT,
      }));
    const optionalGaps = ACTION_MANIFEST
      .filter(entry => entry.required === false && (selectorActivations.get(entry.selector)?.size || 0) < ROUND_COUNT)
      .map(entry => ({
        selector: entry.selector,
        reason: entry.optionalReason,
        seen: manifestSeen.has(entry.selector),
        visible: manifestVisible.has(entry.selector),
        activatedRounds: selectorActivations.get(entry.selector)?.size || 0,
      }));
    const report = {
      ok: failures.length === 0,
      rounds,
      coverage: Object.fromEntries([...coverage.entries()].sort(([a], [b]) => a.localeCompare(b))),
      selectorManifest: {
        total: ACTION_MANIFEST.length,
        seen: manifestSeen.size,
        visible: manifestVisible.size,
        activatedRequired,
        requiredNotActivated,
        optionalGaps,
        unseen: ACTION_MANIFEST.filter(entry => !manifestSeen.has(entry.selector)).map(entry => entry.selector),
        unknown: [...manifestUnknown],
      },
      failures,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
}).catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});

app.on('window-all-closed', () => {});
app.on('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});
