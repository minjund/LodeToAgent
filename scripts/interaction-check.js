'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-interaction-'));
app.setPath('userData', userData);

const failures = [];
const coverage = new Map();
const rounds = [];
const ROUND_COUNT = Math.max(1, Math.min(3, Number(process.env.LOADTOAGENT_INTERACTION_ROUNDS || 3)));
const manifestSeen = new Set();
const manifestUnknown = new Set();
let expectedTerminalFirstAfterReload = '';

const ACTION_MANIFEST = [
  ...['all', 'active', 'waiting', 'runtime', 'terminal', 'tmux', 'settings'].map(view => ({ selector: `[data-view="${view}"]`, action: `nav:${view}` })),
  { selector: '#openTmuxFromAgentWork', action: 'tmux:shortcut-from-agent-work' },
  { selector: '#guideBtn', action: 'guide:toggle' },
  { selector: '#shortcutHelpBtn', action: 'quality:shortcuts-open' },
  { selector: '#closeShortcutHelpBtn', action: 'quality:shortcuts-close' },
  { selector: '#quickPaletteInput', action: 'quality:quick-search' },
  { selector: '#closeQuickPaletteBtn', action: 'quality:quick-close' },
  { selector: '[data-quick-command]', action: 'quality:quick-command' },
  { selector: '#dismissGuideBtn', action: 'guide:dismiss' },
  { selector: '[data-guide-action]', action: 'guide:step' },
  { selector: '#mobileMoreBtn', action: 'mobile:more' },
  { selector: '#mobileToolsCloseBtn', action: 'mobile:close' },
  { selector: '[data-mobile-view]', action: 'mobile:view' },
  { selector: '#updateNoticeBtn', action: 'update:notice-open' },
  { selector: '#checkUpdateBtn', action: 'update:check' },
  { selector: '#installUpdateBtn', action: 'update:download' },
  { selector: '#openReleaseBtn', action: 'update:release-open' },
  { selector: '#languageSelect', action: 'settings:language' },
  { selector: '[data-provider-visibility]', action: 'settings:provider-visibility' },
  { selector: '#probeBtn', action: 'dashboard:probe' },
  { selector: '#addWorkspaceBtn', action: 'workspace:add' },
  { selector: '#mobileAddWorkspaceBtn', action: 'workspace:add' },
  { selector: '#newRunBtn', action: 'run:open' },
  { selector: '#newPowerShellBtn', action: 'terminal:create-windows' },
  { selector: '#newWslBtn', action: 'terminal:create-linux' },
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
  { selector: '#terminalFocusBtn', action: 'terminal:focus-mode' },
  { selector: '#terminalCommandForm', action: 'terminal:failure-submit' },
  { selector: '#terminalCommandForm button[type="submit"]', action: 'terminal:failure-submit' },
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
  { selector: '#searchInput', action: 'filter:search' },
  { selector: '#searchClearBtn', action: 'filter:search-clear' },
  { selector: '#emptyClearFiltersBtn', action: 'filter:empty-clear' },
  { selector: '#resetFiltersBtn', action: 'filter:reset-all' },
  { selector: '[data-provider-filter]', action: 'filter:provider' },
  { selector: '#sortSelect', action: 'filter:sort' },
  { selector: '#controlRoomSortSelect', action: 'control-room:sort' },
  { selector: '#controlRoomProjectSelect', action: 'control-room:project-select' },
  { selector: '#controlRoomSearchInput', action: 'control-room:search' },
  { selector: '#controlRoomSearchBtn', action: 'control-room:search-toggle' },
  { selector: '#controlRoomExpandAll', action: 'control-room:expand-all' },
  { selector: '#controlRoomCollapseAll', action: 'control-room:collapse-all' },
  { selector: '.control-project-header[draggable="true"]', action: 'control-room:project-reorder-drag' },
  { selector: '[data-project-toggle]', action: 'control-room:project-toggle' },
  { selector: '[data-session-archive]', action: 'control-room:move-to-history' },
  { selector: '#loadMoreBtn', action: 'filter:load-more' },
  { selector: '[data-open-run]', action: 'run:open-empty' },
  { selector: '#closeDrawerBtn', action: 'drawer:close' },
  { selector: '[data-copy-text]', action: 'drawer:copy' },
  ...['summary', 'chat', 'lifecycle', 'tokens'].map(tab => ({ selector: `[data-tab="${tab}"]`, action: `drawer:tab-${tab}` })),
  { selector: '[data-management-filter]', action: 'management:filter' },
  { selector: '[data-agent-command-route]', action: 'control-room:command-route' },
  { selector: '[data-management-inbox-filter]', action: 'management:inbox-filter' },
  { selector: '[data-attention-draft]', action: 'management:reply-template' },
  { selector: '[data-attention-quick]', action: 'management:quick-response' },
  { selector: '[data-managed-run-action]', action: 'management:run-control' },
  { selector: '[data-reassign-session]', action: 'management:reassign' },
  { selector: '[data-scroll-latest]', action: 'drawer:latest' },
  { selector: '.chat-progress-updates > summary', action: 'drawer:expand-progress' },
  { selector: '[data-retry-detail]', action: 'drawer:retry' },
  { selector: '[data-stop-run]', action: 'drawer:stop-double' },
  { selector: '#runForm', action: 'run:submit' },
  { selector: '#closeRunModalBtn', action: 'run:close-x' },
  { selector: '#pickRunCwdBtn', action: 'run:pick-cwd' },
  { selector: '#allowWrites', action: 'run:allow-writes' },
  { selector: '#cancelRunBtn', action: 'run:cancel' },
  { selector: '#clearRunDraftBtn', action: 'run:clear-draft' },
  { selector: '#runForm button[type="submit"]', action: 'run:submit' },
  { selector: '[data-run-provider]', action: 'run:provider' },
  { selector: '[data-provider-docs]', action: 'run:provider-docs' },
  { selector: '[data-provider-recheck]', action: 'run:provider-recheck' },
  { selector: '[data-run-prompt-key]', action: 'run:prompt-example' },
  { selector: '[data-run-workspace]', action: 'run:workspace-suggestion' },
  { selector: '#tmuxCreateForm', action: 'tmux:modal-submit' },
  { selector: '#tmuxCreateDistro', action: 'tmux:modal-submit' },
  { selector: '#pickTmuxCwdBtn', action: 'tmux:pick-cwd' },
  { selector: '#closeTmuxCreateBtn', action: 'tmux:modal-close-x' },
  { selector: '#cancelTmuxCreateBtn', action: 'tmux:modal-cancel' },
  { selector: '#tmuxCreateForm button[type="submit"]', action: 'tmux:modal-submit' },
  { selector: '[data-provider-card]', action: 'filter:provider-card' },
  { selector: '[data-workspace]', action: 'workspace:select' },
  { selector: '[data-remove-workspace]', action: 'workspace:remove' },
  { selector: '[data-session-sortable][draggable="true"]', action: 'session:reorder-drag' },
  { selector: '[data-session-id]', action: 'drawer:open-card' },
  { selector: '[data-loop-select]', action: 'runtime:select-loop' },
  { selector: '[data-loop-open]', action: 'runtime:open-loop' },
  { selector: '[data-automation-session]', action: 'runtime:open-schedule' },
  { selector: '[data-graph-focus]', action: 'graph:focus' },
  { selector: '[data-open-session]', action: 'drawer:open-graph' },
  { selector: '[data-agent-terminal-open]', action: 'terminal:open-from-agent' },
  { selector: '[data-agent-bridge-copy]', action: 'agent:bridge-copy' },
  { selector: '[data-agent-command-target]', action: 'agent:target-select' },
  { selector: '[data-agent-command-form]', action: 'agent:command-submit' },
  { selector: '[data-agent-command-form] button[type="submit"]', action: 'agent:command-submit' },
  { selector: '[data-subagent-completed-toggle]', action: 'subagent:toggle-completed' },
  { selector: '[data-execution-history-toggle]', action: 'graph:execution-history' },
  { selector: '[data-open-subagent-chat]', action: 'subagent:open-conversation' },
  { selector: '[data-open-execution-id]', action: 'control-room:open-execution' },
  { selector: '[data-resume-agent]', action: 'agent:resume-terminal', required: false },
  { selector: '[data-control-tmux]', action: 'tmux:control-pane' },
  { selector: '[data-tmux-subagents-toggle]', action: 'tmux:subagents-toggle' },
  { selector: '[data-tmux-type][data-tmux-id]', action: 'tmux:focus-node' },
  { selector: '#terminalCommandClearBtn', action: 'terminal:clear-draft' },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mark = action => coverage.set(action, Number(coverage.get(action) || 0) + 1);

async function recordManifest(win) {
  const result = await win.webContents.executeJavaScript(`(() => {
    const selectors = ${JSON.stringify(ACTION_MANIFEST.map(item => item.selector))};
    const discovered = [...document.querySelectorAll('button, form, input[type="search"], input[type="checkbox"], select, [data-provider-card], [data-workspace], [data-session-id], .terminal-session-tools > summary')]
      .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    const unknown = discovered.filter(element => !selectors.some(selector => { try { return element.matches(selector); } catch { return false; } })).map(element => element.outerHTML.slice(0, 240));
    const seen = selectors.filter(selector => { try { return Boolean(document.querySelector(selector)); } catch { return false; } });
    return { unknown, seen };
  })()`);
  result.seen.forEach(selector => manifestSeen.add(selector));
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

async function click(win, selector, action) {
  await recordManifest(win);
  const result = await win.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, reason: 'missing' };
    if (element.disabled) return { ok: false, reason: 'disabled' };
    element.click();
    return { ok: true };
  })()`);
  assert(result && result.ok, `${action}: ${selector} 요소를 클릭하지 못했습니다 (${result && result.reason || 'unknown'}).`);
  mark(action);
  await recordManifest(win);
}

async function callCount(win, name) {
  return win.webContents.executeJavaScript(`window.interactionTest.getCalls().filter(item => item.name === ${JSON.stringify(name)}).length`);
}

async function clearCalls(win) {
  await win.webContents.executeJavaScript('window.interactionTest.clearCalls()');
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
  let scrollResets = 0;
  for (const view of ['active', 'waiting', 'runtime', 'terminal', 'settings', 'all']) {
    const before = await win.webContents.executeJavaScript(`(() => { const stage = document.querySelector('.main-stage'); stage.scrollTop = stage.scrollHeight; return stage.scrollTop; })()`);
    await click(win, `[data-view="${view}"]`, `nav:${view}`);
    await waitFor(win, `window.LoadToAgentApp.state.view === ${JSON.stringify(view)} && document.querySelector('[data-view="${view}"]').classList.contains('active')`, `${view} 화면 전환 실패`);
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
  await waitFor(win, `document.activeElement?.dataset.view === 'active'`, '사이드바 아래 방향키가 다음 화면 버튼으로 이동하지 않았습니다.');
  await win.webContents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))`);
  await waitFor(win, `document.activeElement?.dataset.view === 'settings'`, '사이드바 End 키가 마지막 화면 버튼으로 이동하지 않았습니다.');
  mark('nav:keyboard-roaming');
  await win.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '3', metaKey: true, bubbles: true }))`);
  await waitFor(win, `window.LoadToAgentApp.state.view === 'waiting' && document.activeElement?.id === 'mainContent'`, '화면 단축키 Meta+3이 내 확인 필요 화면을 열지 못했습니다.');
  mark('nav:keyboard-shortcut');
  await win.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))`);
  await waitFor(win, `window.LoadToAgentApp.state.view === 'all' && document.activeElement?.id === 'searchInput'`, '/ 단축키가 홈 검색창으로 이동하지 못했습니다.');
  mark('filter:search-shortcut');
  round.observed.navigation = true;
  round.observed.navScrollResets = scrollResets;
}

async function exerciseQualityEnhancements(win, round) {
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
  mark('quality:quick-keyboard');
  mark('quality:quick-empty');
  await click(win, '#closeQuickPaletteBtn', 'quality:quick-close');
  await waitFor(win, `document.querySelector('#quickPaletteModal').classList.contains('hidden')`, '빠른 이동 닫기 버튼이 동작하지 않았습니다.');

  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(win, `!document.querySelector('#quickPaletteModal').classList.contains('hidden')`, 'Ctrl+K가 빠른 이동 검색을 열지 못했습니다.');
  await click(win, '[data-quick-command="terminal"]', 'quality:quick-command');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'terminal' && document.querySelector('#quickPaletteModal').classList.contains('hidden')`, '빠른 이동 명령이 화면을 전환하지 못했습니다.');

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

  await click(win, '[data-view="all"]', 'nav:all');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#searchInput');
    input.value = 'NO_RESULT_FOR_EMPTY_CLEAR';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, `!document.querySelector('#emptyClearFiltersBtn').classList.contains('hidden') && !document.querySelector('#emptyState').classList.contains('hidden')`, '빈 결과 조건 지우기 버튼이 표시되지 않았습니다.');
  await click(win, '#emptyClearFiltersBtn', 'filter:empty-clear');
  await waitFor(win, `window.LoadToAgentApp.state.search === '' && document.activeElement?.id === 'searchInput' && document.querySelector('#emptyClearFiltersBtn').classList.contains('hidden')`, '빈 결과 조건 지우기가 상태와 초점을 복원하지 못했습니다.');

  const semanticContracts = await win.webContents.executeJavaScript(`(() => ({
    navControls: [...document.querySelectorAll('.nav-item[data-view]')].every(button => button.hasAttribute('aria-controls')),
    providerControls: document.querySelector('#probeBtn').getAttribute('aria-controls') === 'providerRail',
    workspaceControls: document.querySelector('#addWorkspaceBtn').getAttribute('aria-controls') === 'workspaceList',
    filterToolbar: document.querySelector('#providerFilter').getAttribute('role') === 'toolbar',
    filterTabStops: document.querySelectorAll('#providerFilter [tabindex="0"]').length,
    overviewTabStops: document.querySelectorAll('#providerOverview [tabindex="0"]').length,
    resultSummary: document.querySelector('#sessionResultSummary').textContent,
  }))()`);
  assert(semanticContracts.navControls && semanticContracts.providerControls && semanticContracts.workspaceControls && semanticContracts.filterToolbar && semanticContracts.filterTabStops === 1 && semanticContracts.overviewTabStops === 1 && semanticContracts.resultSummary, `전역·필터 의미 계약 실패: ${JSON.stringify(semanticContracts)}`);
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
        tmuxCommandsOutsideTmux: [...document.querySelectorAll('[data-tmux-manage], [data-control-tmux]')].some(node => !node.closest('#tmuxSection') && !node.closest('#terminalSection')),
      };
    })()`);
    const actual = report[view];
    const expected = expectedTool ? [expectedTool] : [];
    assert(JSON.stringify(actual.visibleTools) === JSON.stringify(expected), `${view} 탭의 전용 데이터 섹션이 섞였습니다: ${JSON.stringify(actual)}`);
    if (['runtime', 'terminal', 'tmux', 'settings'].includes(view)) assert(!actual.workspaceVisible, `${view} 탭에 동작하지 않는 작업공간 필터가 표시됩니다.`);
    if (view === 'active') assert(!actual.historySectionVisible && !actual.activeEmptyVisible, '진행 중 탭 하단에 지난 기록 영역이 남았습니다.');
    if (view === 'all') assert(actual.historySectionVisible && !actual.attentionInboxVisible, '홈에서 지난 기록 영역이 숨겨졌거나 확인함이 섞였습니다.');
    if (view === 'waiting') assert(!actual.historySectionVisible && actual.attentionInboxVisible, '내 확인 필요 탭이 전용 확인함을 표시하지 못했습니다.');
    if (view === 'all' || view === 'active') assert(actual.liveTmuxCards === 0 && !actual.tmuxCommandsOutsideTmux, `${view} 탭에 tmux 자원이나 명령이 노출됩니다: ${JSON.stringify(actual)}`);
  }
  await click(win, '[data-view="active"]', 'nav:active');
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.search = '__NO_ACTIVE_FIXTURE__';
    document.querySelector('#searchInput').value = app.state.search;
    app.renderSessions('filter');
  })()`);
  await waitFor(win, `document.querySelector('#sessionSection').classList.contains('hidden') && !document.querySelector('#liveSection').classList.contains('hidden') && !document.querySelector('#activeEmptyState').classList.contains('hidden')`, '진행 중 작업이 없을 때 지난 기록 대신 전용 빈 상태를 표시하지 못했습니다.');
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
  await click(win, '[data-view="all"]', 'nav:all');
  if (await win.webContents.executeJavaScript(`document.querySelector('#beginnerGuide').classList.contains('hidden')`)) {
    await click(win, '#guideBtn', 'guide:open-before-dismiss');
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
  await click(win, '#guideBtn', 'guide:toggle');
  await waitFor(win, `!document.querySelector('#beginnerGuide').classList.contains('hidden')`, '시작 가이드 다시 열기 실패');
  await click(win, '[data-guide-action="active"]', 'guide:step');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'active' && document.querySelector('[data-guide-step="active"]').classList.contains('completed')`, '가이드 단계가 화면 이동과 완료 상태를 반영하지 않았습니다.');
  win.setSize(480, 720);
  await waitFor(win, `document.querySelector('#mobileMoreBtn').getClientRects().length > 0 && getComputedStyle(document.querySelector('#mobileMoreBtn')).display !== 'none'`, '모바일 내비게이션 레이아웃 전환 실패');
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
  await win.webContents.executeJavaScript(`(() => { const first = document.querySelector('#mobileToolsMenu button'); first.focus(); first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); })()`);
  await waitFor(win, `document.activeElement?.dataset.mobileView === 'settings'`, '모바일 더보기 메뉴 End 키 이동 실패');
  mark('mobile:keyboard-roaming');
  await win.webContents.executeJavaScript(`document.querySelector('#mainContent').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await waitFor(win, `document.querySelector('#mobileToolsMenu').classList.contains('hidden') && document.querySelector('#mobileMoreBtn').getAttribute('aria-expanded') === 'false' && document.activeElement?.id === 'mobileMoreBtn'`, '모바일 더보기 메뉴 바깥 클릭 닫기와 포커스 복원 실패');
  mark('mobile:outside-dismiss');
  await click(win, '#mobileMoreBtn', 'mobile:more');
  await click(win, '[data-mobile-view="settings"]', 'mobile:view');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'settings' && document.querySelector('#mobileToolsMenu').classList.contains('hidden')`, '모바일 더보기에서 설정 이동 실패');
  win.setSize(1440, 940);
  await waitFor(win, `document.querySelector('.view-nav [data-view="settings"]').getClientRects().length > 0`, '데스크톱 내비게이션 레이아웃 복원 실패');
  await click(win, '[data-view="all"]', 'nav:all');
  round.observed.guide = { persisted: true, mobileTools: true };
}

async function exerciseUpdates(win, round) {
  await win.webContents.executeJavaScript('window.interactionTest.restoreCurrentUpdate()');
  await click(win, '[data-view="settings"]', 'nav:settings');
  await waitFor(win, `window.LoadToAgentApp.state.update.status === 'current' && document.querySelector('#currentVersion').textContent === 'v1.0.0' && document.querySelector('#sidebarAppVersion').textContent === 'v1.0.0' && document.querySelector('#updateStateTitle').textContent === '현재 최신 버전입니다.' && document.querySelector('#checkUpdateBtn').textContent === '업데이트 확인'`, '현재 버전과 최신 상태가 설정 화면에 명확히 표시되지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => { window.interactionTest.configure({ delays: { checkForUpdate: 160 } }); const button = document.querySelector('#checkUpdateBtn'); button.click(); button.click(); })()`);
  mark('update:check');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'checkForUpdate') && window.LoadToAgentApp.state.update.status === 'available'`, '업데이트 확인 버튼이 최신 릴리스를 확인하지 않았습니다.');
  assert(await callCount(win, 'checkForUpdate') === 1, '업데이트 확인 연속 클릭이 중복 요청을 만들었습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await click(win, '[data-view="all"]', 'nav:all');
  await waitFor(win, `window.LoadToAgentApp.state.update.status === 'available' && !document.querySelector('#updateNotice').classList.contains('hidden') && !document.querySelector('#navUpdateBadge').classList.contains('hidden')`, '새 버전 알림이 표시되지 않았습니다.');
  await click(win, '#updateNoticeBtn', 'update:notice-open');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'settings' && !document.querySelector('#settingsSection').classList.contains('hidden') && document.querySelector('#latestVersion').textContent === 'v1.1.0'`, '업데이트 알림이 설정 화면을 열지 못했습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => { window.interactionTest.configure({ delays: { installDownloadedUpdate: 160 } }); const button = document.querySelector('#installUpdateBtn'); button.click(); button.click(); })()`);
  mark('update:download');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'installDownloadedUpdate') && window.LoadToAgentApp.state.update.status === 'downloaded'`, '원클릭 업데이트 설치가 호출되지 않았습니다.');
  assert(await callCount(win, 'installDownloadedUpdate') === 1, '업데이트 설치 연속 클릭이 중복 요청을 만들었습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => { window.interactionTest.configure({ delays: { openUpdateRelease: 160 } }); const button = document.querySelector('#openReleaseBtn'); button.click(); button.click(); })()`);
  mark('update:release-open');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'openUpdateRelease')`, 'GitHub 릴리스 페이지 열기가 호출되지 않았습니다.');
  await sleep(220);
  assert(await callCount(win, 'openUpdateRelease') === 1, 'GitHub 릴리스 열기 연속 클릭이 중복 요청을 만들었습니다.');
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

async function exerciseManagementControls(win, round) {
  await click(win, '[data-view="all"]', 'nav:all');
  await waitFor(win, `Boolean(document.querySelector('[data-home-attention]')) && Boolean(document.querySelector('[data-control-room-overview]'))`, '홈의 확인 필요 항목과 실행 구조가 표시되지 않았습니다.');
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
    clear: window.LoadToAgentApp.graphFilteredSessions().filter(session => !window.LoadToAgentApp.needsManagementReview(session)).length,
    reviewTotal: Number(document.querySelector('[data-home-attention]')?.dataset.homeAttention || 0),
    reviewExpected: window.LoadToAgentApp.graphFilteredSessions().filter(session => window.LoadToAgentApp.needsManagementReview(session)).length,
    attentionItems: document.querySelectorAll('.home-attention-item').length,
    controlRooms: document.querySelectorAll('[data-control-session]').length,
    rootMain: Boolean(document.querySelector('[data-control-session="fixture-root"] .control-room-main')),
    rootHelpers: document.querySelectorAll('[data-control-session="fixture-root"] .helper-node').length,
    rootExecutions: document.querySelectorAll('[data-control-session="fixture-root"] .execution-node').length,
    rootCompleted: document.querySelectorAll('[data-control-session="fixture-root"] .completed-list .control-room-node').length,
    flowVisibleWithoutFocus: window.LoadToAgentApp.state.graphFocusId === null && Boolean(document.querySelector('[data-control-room-overview]')),
  }))()`);
  assert(managementScope.critical + managementScope.warning + managementScope.attention + managementScope.clear >= managementScope.total, `최근 24시간 상태 기준 집계가 표시 범위를 빠뜨렸습니다: ${JSON.stringify(managementScope)}`);
  assert(managementScope.reviewTotal === managementScope.reviewExpected && managementScope.attentionItems === Math.min(3, managementScope.reviewExpected), `홈 확인 필요 항목이 실제 검토 대상과 일치하지 않습니다: ${JSON.stringify(managementScope)}`);
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
  const historyDrag = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#sessionGrid [data-session-id][data-session-sortable]')];
    const source = items[1];
    const target = items[0];
    if (!source || !target || !source.draggable) return { ok: false, reason: 'draggable history sessions missing' };
    const before = items.map(node => node.dataset.sessionId);
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const bounds = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: bounds.left + 1, clientY: bounds.top + bounds.height / 2, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: bounds.left + 1, clientY: bounds.top + bounds.height / 2, dataTransfer: transfer }));
    const after = [...document.querySelectorAll('#sessionGrid [data-session-id]')].map(node => node.dataset.sessionId);
    const cards = document.querySelectorAll('#sessionGrid [data-session-id]').length;
    const handles = document.querySelectorAll('#sessionGrid [data-session-id] .session-drag-handle').length;
    const grid = document.querySelector('#sessionGrid');
    return { ok: after[0] === before[1], before, after, cards, handles, noHorizontalOverflow: grid.scrollWidth <= grid.clientWidth + 2 };
  })()`);
  assert(historyDrag.ok && historyDrag.cards === historyDrag.handles && historyDrag.noHorizontalOverflow, `최근 세션 카드 드래그 위치 변경 실패: ${JSON.stringify(historyDrag)}`);
  await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#sessionGrid [data-session-id][data-session-sortable]')];
    const source = items[0];
    const target = items[1];
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const bounds = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: bounds.right - 1, clientY: bounds.bottom - 1, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: bounds.right - 1, clientY: bounds.bottom - 1, dataTransfer: transfer }));
  })()`);
  await waitFor(win, `Array.from(document.querySelectorAll('#sessionGrid [data-session-id]'), node => node.dataset.sessionId).join(',') === ${JSON.stringify(historyDrag.before.join(','))}`, '최근 세션 카드 드래그로 원래 순서를 복원하지 못했습니다.');
  round.observed.fixedSessionOrder = { activityDoesNotReorder: true, liveDrag: true, historyDrag: true, arrowsRemoved: true };

  await click(win, '[data-open-subagent-chat="fixture-child"]', 'control-room:open-subagent');
  await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open')
    && document.querySelector('#detailDrawer')?.dataset.mode === 'subagent'
    && document.querySelector('.subagent-assignment-card')?.innerText.includes('메인 에이전트가 시킨 일')
    && document.querySelectorAll('#detailDrawer [data-agent-command-route]').length === 2
    && document.querySelector('#detailDrawer [data-agent-command-route="direct"]')?.disabled
    && document.querySelector('#detailDrawer [data-agent-command-route="parent"]')?.getAttribute('aria-pressed') === 'true'
    && !document.querySelector('#drawerComposer [data-agent-command-form="fixture-child"] button[type="submit"]')?.disabled
    && document.querySelector('#drawerComposer')?.innerText.includes('터미널 화면으로 이동하지 않습니다')`, '부모 관리 서브에이전트의 대화창 내 전달 경로가 준비되지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-child"]');
    input.value = '대화창에서 그대로 전달할 지시';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
  })()`);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCommand'
    && item.args[0] === 'terminal-main' && item.args[1].includes('대화창에서 그대로 전달할 지시'))
    && window.LoadToAgentApp.state.view === 'all'
    && window.LoadToAgentApp.state.drawerMode === 'subagent'
    && document.querySelector('#detailDrawer')?.classList.contains('open')
    && !window.interactionTest.getCalls().some(item => item.name === 'terminalCreate' && item.args[0]?.bridgeId === 'fixture-child')`, '서브에이전트 지시가 세션 이동 없이 메인을 통해 전달되지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `!document.querySelector('#detailDrawer')?.classList.contains('open')`, '서브에이전트 대화를 닫지 못했습니다.');

  await click(win, '[data-open-execution-id="fixture-shell-running"]', 'control-room:open-execution');
  await waitFor(win, `window.LoadToAgentApp.state.drawerMode === 'execution'
    && window.LoadToAgentApp.state.drawerExecutionId === 'fixture-shell-running'
    && document.querySelector('#detailDrawer')?.dataset.mode === 'execution'
    && document.querySelector('[data-execution-detail="fixture-shell-running"]')?.dataset.conversationScope === 'execution-only'
    && document.querySelector('#drawerContent')?.innerText.includes('npm run dev')
    && document.querySelector('#drawerContent')?.innerText.includes('개발 서버가 http://localhost:4173 에서 실행 중입니다.')
    && !document.querySelector('#drawerContent')?.innerText.includes('상호작용 테스트를 진행해줘')
    && document.querySelectorAll('.drawer-tab:not(.hidden)').length === 1
    && document.querySelector('.drawer-tab:not(.hidden)')?.textContent === '실행 과정'
    && document.querySelector('#drawerComposer')?.classList.contains('hidden')`, 'PowerShell 실행 과정이 소유 세션 대화와 분리되지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `!document.querySelector('#detailDrawer')?.classList.contains('open')`, 'PowerShell 실행 상세를 닫지 못했습니다.');

  await click(win, '.home-attention-title[data-management-filter="all"]', 'management:filter');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'waiting' && window.LoadToAgentApp.state.managementFilter === 'all'`, '운영 개요의 모두 보기가 전체 확인함을 열지 못했습니다.');
  await click(win, '[data-management-inbox-filter="critical"]', 'management:inbox-filter');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'waiting'
    && window.LoadToAgentApp.state.managementFilter === 'critical'
    && document.querySelector('[data-management-inbox-filter="critical"]')?.getAttribute('aria-pressed') === 'true'
    && document.querySelector('#globalStatus')?.textContent.includes('위험 신호 · 긴급')
    && document.querySelector('#globalStatus')?.textContent.includes('결과')
    && !document.querySelector('#attentionInbox').classList.contains('hidden')`, '긴급 현황 필터가 선택 상태를 보존하며 확인함을 열지 못했습니다.');
  assert(await win.webContents.executeJavaScript(`document.querySelectorAll('#attentionInbox [data-management-session]').length`) === managementScope.critical, `운영 개요의 긴급 위험 신호 수와 확인함 결과 수가 다릅니다: ${JSON.stringify(managementScope)}`);
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
  await click(win, '[data-management-inbox-filter="all"]', 'management:inbox-filter');
  await waitFor(win, `Boolean(document.querySelector('[data-management-session="fixture-waiting"] [data-attention-quick]'))
    && Boolean(document.querySelector('[data-management-session="fixture-failed"] [data-managed-run-action="retry"]'))
    && Boolean(document.querySelector('[data-management-session="fixture-paused-run"] [data-managed-run-action="resume"]'))
    && [...document.querySelectorAll('#attentionInbox [data-management-session]')].every(card => card.querySelectorAll('.attention-decision-flow > section').length === 3)
    && document.querySelector('[data-management-session="fixture-waiting"] .attention-decision-flow')?.innerText.includes('에이전트가 한 말')
    && document.querySelector('[data-management-session="fixture-waiting"] .attention-decision-flow')?.innerText.includes('내가 확인하고 결정할 것')
    && document.querySelector('[data-management-session="fixture-waiting"] .attention-decision-flow')?.innerText.includes('내가 답하거나 시킬 말')
    && Boolean(document.querySelector('[data-management-session="fixture-failed"] [data-attention-draft]'))`, '확인함의 답변→내 판단→다음 지시 흐름과 빠른 제어가 준비되지 않았습니다.');
  await recordManifest(win);

  const replyTemplate = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-management-session="fixture-failed"] [data-attention-draft]');
    button?.click();
    const input = document.querySelector('[data-management-session="fixture-failed"] [data-agent-command-draft]');
    return { value: input?.value || '', focused: document.activeElement === input };
  })()`);
  assert(replyTemplate.value.includes('실패 원인을 확인해 수정하고') && replyTemplate.focused, `추천 답변·지시 틀이 해당 에이전트 입력칸에 준비되지 않았습니다: ${JSON.stringify(replyTemplate)}`);
  mark('management:reply-template');
  await recordManifest(win);

  await clearCalls(win);
  await click(win, '[data-management-session="fixture-failed"] [data-managed-run-action="retry"]', 'management:run-control');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'retryAgent' && item.args[0] === 'fixture-failed-run')`, '실패한 실행의 다시 실행 요청이 전달되지 않았습니다.');
  await click(win, '[data-management-session="fixture-paused-run"] [data-managed-run-action="resume"]', 'management:run-control');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'resumeAgentRun' && item.args[0] === 'fixture-paused-run')`, '일시정지한 실행의 재개 요청이 전달되지 않았습니다.');

  await clearCalls(win);
  await click(win, '[data-management-session="fixture-waiting"] [data-attention-quick]', 'management:quick-response');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate' && item.args[0]?.provider === 'gemini')`, '승인 빠른 응답이 해당 AI 대화를 복원해 전달되지 않았습니다.', 160);

  await click(win, '[data-view="waiting"]', 'nav:waiting');
  await waitFor(win, `Boolean(document.querySelector('[data-management-session="fixture-failed"] [data-reassign-session]'))`, '재배정 제어가 확인함에 표시되지 않았습니다.');
  await click(win, '[data-management-session="fixture-failed"] [data-reassign-session]', 'management:reassign');
  await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden') && document.querySelector('#runPrompt').value.includes('실패 후 다시 실행 검증') && document.querySelector('#runCwd').value === 'D:\\\\fixture'`, '재배정이 원래 목표와 작업 폴더를 새 실행 창에 보존하지 못했습니다.');
  await click(win, '#clearRunDraftBtn', 'run:clear-draft');
  await click(win, '#cancelRunBtn', 'run:cancel');

  await click(win, '[data-view="all"]', 'nav:all');
  await click(win, '[data-open-session="fixture-root"]', 'drawer:open-graph');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')`, '실행 상세 대화를 열지 못했습니다.');
  await click(win, '.drawer-tab[data-tab="summary"]', 'drawer:tab-summary');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && Boolean(document.querySelector('[data-managed-run-action="pause"]'))`, '실행 상세의 일시정지 제어가 표시되지 않았습니다.');
  await clearCalls(win);
  await click(win, '[data-managed-run-action="pause"]', 'management:run-control');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'pauseAgent' && item.args[0] === 'fixture-run')`, '실행 일시정지 요청이 전달되지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, '관리 제어 검증 뒤 상세 창이 닫히지 않았습니다.');
  round.observed.management = { inbox: true, retry: true, resume: true, pause: true, quickResponse: true, reassign: true };
}

async function exerciseLanguageSettings(win, round) {
  await click(win, '[data-view="settings"]', 'nav:settings');
  for (const [locale, title, lang] of [
    ['en', 'Application Settings', 'en'],
    ['zh-CN', '应用设置', 'zh-CN'],
    ['ko', '프로그램 설정', 'ko'],
  ]) {
    await win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('#languageSelect');
      select.value = ${JSON.stringify(locale)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(win, `document.documentElement.lang === ${JSON.stringify(lang)} && document.querySelector('#settingsTitle').textContent === ${JSON.stringify(title)} && localStorage.getItem('loadtoagent:locale:v1') === ${JSON.stringify(locale)}`, `${locale} 언어 전환과 저장 실패`);
  }
  mark('settings:language');
  round.observed.languages = ['ko', 'en', 'zh-CN'];
}

async function exerciseProviderVisibility(win, round) {
  await click(win, '[data-view="settings"]', 'nav:settings');
  const initial = await win.webContents.executeJavaScript(`(() => ({
    options: document.querySelectorAll('[data-provider-visibility]').length,
    enabled: document.querySelectorAll('[data-provider-visibility]:checked').length,
    providers: window.LoadToAgentApp.state.providers.length,
  }))()`);
  assert(initial.options === initial.providers && initial.enabled === initial.providers, `AI 표시 기본값이 모두 ON이 아닙니다: ${JSON.stringify(initial)}`);
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ failures: { setProviderVisibility: 1 } })`);
  await click(win, '[data-provider-visibility="claude"]', 'settings:provider-visibility');
  await waitFor(win, `!window.LoadToAgentApp.state.hiddenProviders.has('claude') && document.querySelector('[data-provider-visibility="claude"]')?.checked`, 'AI 표시 설정 저장 실패 후 체크 상태와 필터가 복원되지 않았습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls(); window.interactionTest.clearCalls()`);
  mark('settings:provider-visibility-rollback');
  await click(win, '[data-provider-visibility="claude"]', 'settings:provider-visibility');
  await waitFor(win, `window.LoadToAgentApp.state.hiddenProviders.has('claude')
    && !window.LoadToAgentApp.state.snapshot.sessions.some(session => session.provider === 'claude')
    && JSON.parse(localStorage.getItem('loadtoagent:provider-visibility:v1')).hidden.includes('claude')`, 'Claude 숨김 설정과 저장이 적용되지 않았습니다.');
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
  await click(win, '[data-view="settings"]', 'nav:settings');
  await click(win, '[data-provider-visibility="claude"]', 'settings:provider-visibility');
  await waitFor(win, `!window.LoadToAgentApp.state.hiddenProviders.has('claude')
    && window.LoadToAgentApp.state.snapshot.sessions.some(session => session.provider === 'claude')
    && document.querySelector('[data-provider-visibility="claude"]')?.checked`, 'Claude 다시 표시가 즉시 복원되지 않았습니다.');
  round.observed.providerVisibility = { defaultOn: initial.providers, hiddenLeakCount: 0, restored: true };
}

async function exerciseDashboardControls(win, round) {
  await click(win, '[data-view="all"]', 'nav:all');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#operationsOverview')?.scrollIntoView({ block: 'start', inline: 'nearest' });
    return document.fonts.ready;
  })()`);
  await sleep(180);
  fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'loadtoagent-readability-overview-interaction.png'), (await win.webContents.capturePage()).toPNG());
  const controlRoom = await win.webContents.executeJavaScript(`(() => ({
    rooms: document.querySelectorAll('[data-control-session]').length,
    mains: document.querySelectorAll('.control-room-main').length,
    helperNodes: document.querySelectorAll('[data-control-session="fixture-root"] .helper-node').length,
    executionNodes: document.querySelectorAll('[data-control-session="fixture-root"] .execution-node').length,
    completedNodes: document.querySelectorAll('[data-control-session="fixture-root"] .completed-list .control-room-node').length,
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
    rawRuntimeTitlesHidden: !document.querySelector('[data-control-session="fixture-root"]')?.innerText.includes('Windows 명령창'),
    humanSummaries: [...document.querySelectorAll('.control-room-main, .helper-node, .execution-node')]
      .map(node => node.dataset.controlSummary || ''),
  }))()`);
  assert(controlRoom.rooms === 9 && controlRoom.mains === controlRoom.rooms && controlRoom.helperNodes >= 3
    && controlRoom.executionNodes >= 3 && controlRoom.completedNodes >= 3 && controlRoom.legends === 0
    && !controlRoom.mainLeakedIntoWorkColumns && controlRoom.invalidRunningUnits === 0
    && controlRoom.invalidCompletedUnits === 0 && controlRoom.emptyRunningColumns >= 1
    && controlRoom.mainOwnerLabelsHidden && controlRoom.executionTypeLabels.some(label => label.startsWith('PowerShell ·'))
    && controlRoom.visibleWithoutFocus && controlRoom.mainSummary
    && controlRoom.helperSummaries.every(Boolean) && controlRoom.executionSummaries.every(Boolean)
    && controlRoom.runtimeTooltips.length === controlRoom.executionNodes && controlRoom.runtimeTooltips.every(Boolean)
    && controlRoom.humanSummaries.every(summary => summary && !/^\//.test(summary) && !/^(?:Let me|Now I(?:'ll| will))/i.test(summary))
    && controlRoom.rawRuntimeTitlesHidden,
  `홈 세션 관제 구조가 올바르지 않습니다: ${JSON.stringify(controlRoom)}`);
  const navCounts = await win.webContents.executeJavaScript(`(() => ({ active: Number(document.querySelector('#navActiveCount').textContent), runtime: Number(document.querySelector('#navRuntimeCount').textContent), tmux: Number(document.querySelector('#navTmuxCount').textContent) }))()`);
  assert(navCounts.active === 9 && navCounts.runtime === 13 && navCounts.tmux === 1, `탭 배지의 단위가 올바르지 않습니다: ${JSON.stringify(navCounts)}`);
  const tmuxShortcut = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#openTmuxFromAgentWork');
    const rect = button.getBoundingClientRect();
    return { count: Number(document.querySelector('#agentWorkTmuxCount').textContent), height: rect.height, accessibleName: button.getAttribute('aria-label') };
  })()`);
  assert(tmuxShortcut.count === 1 && tmuxShortcut.height >= 44 && tmuxShortcut.accessibleName.includes('세션 1개'), `AI 작업의 tmux 바로가기 표시가 올바르지 않습니다: ${JSON.stringify(tmuxShortcut)}`);
  await click(win, '#openTmuxFromAgentWork', 'tmux:shortcut-from-agent-work');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'tmux' && !document.querySelector('#tmuxSection').classList.contains('hidden') && document.activeElement?.id === 'mainContent'`, 'AI 작업의 tmux 바로가기가 포커스를 옮기며 tmux 탭을 열지 못했습니다.');
  await click(win, '[data-view="all"]', 'nav:all');
  await waitFor(win, `[...document.querySelectorAll('.control-room-project-group')].every(group => !group.open)
    && !document.querySelector('#controlRoomExpandAll').disabled
    && document.querySelector('#controlRoomCollapseAll').disabled`, '프로젝트 그룹이 기본으로 모두 닫히지 않았습니다.');
  await click(win, '.control-project-header', 'control-room:project-toggle');
  await waitFor(win, `document.querySelector('.control-room-project-group')?.open`, '프로젝트 그룹을 펼치지 못했습니다.');
  await click(win, '.control-project-header', 'control-room:project-toggle');
  await waitFor(win, `!document.querySelector('.control-room-project-group')?.open`, '프로젝트 그룹을 다시 접지 못했습니다.');
  await click(win, '#controlRoomExpandAll', 'control-room:expand-all');
  await waitFor(win, `[...document.querySelectorAll('.control-room-project-group')].every(group => group.open)
    && document.querySelector('#controlRoomExpandAll').disabled
    && !document.querySelector('#controlRoomCollapseAll').disabled`, '모두 열기가 모든 프로젝트 그룹을 펼치지 못했습니다.');
  await click(win, '#controlRoomCollapseAll', 'control-room:collapse-all');
  await waitFor(win, `[...document.querySelectorAll('.control-room-project-group')].every(group => !group.open)
    && !document.querySelector('#controlRoomExpandAll').disabled
    && document.querySelector('#controlRoomCollapseAll').disabled`, '모두 닫기가 모든 프로젝트 그룹을 접지 못했습니다.');
  const projectOrderBefore = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#liveSessionGrid [data-project-sortable]'), node => node.dataset.projectSortable)`);
  assert(projectOrderBefore.length >= 2, '프로젝트 위치 변경을 검증할 그룹이 부족합니다.');
  const collapsedProjectDrag = await win.webContents.executeJavaScript(`(() => {
    const groups = [...document.querySelectorAll('#liveSessionGrid [data-project-sortable]')];
    const sourceGroup = groups[1];
    const targetGroup = groups[0];
    const source = sourceGroup?.querySelector(':scope > .control-project-header');
    if (!source || !targetGroup || !source.draggable) return { ok: false, reason: 'draggable project headers missing' };
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const bounds = targetGroup.getBoundingClientRect();
    targetGroup.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: bounds.top + 1, dataTransfer: transfer }));
    targetGroup.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientY: bounds.top + 1, dataTransfer: transfer }));
    const after = [...document.querySelectorAll('#liveSessionGrid [data-project-sortable]')].map(node => node.dataset.projectSortable);
    const saved = JSON.parse(localStorage.getItem('loadtoagent:dashboard-preferences:v2') || '{}').projectOrder || [];
    return {
      ok: after[0] === sourceGroup.dataset.projectSortable && saved.indexOf(after[0]) < saved.indexOf(after[1]),
      after,
      allCollapsed: [...document.querySelectorAll('#liveSessionGrid [data-project-sortable]')].every(group => !group.open),
      handlesVisible: [...document.querySelectorAll('#liveSessionGrid [data-project-sortable] .control-project-handle')]
        .every(handle => getComputedStyle(handle).display !== 'none'),
    };
  })()`);
  assert(collapsedProjectDrag.ok && collapsedProjectDrag.allCollapsed && collapsedProjectDrag.handlesVisible,
    `닫힌 프로젝트 그룹의 드래그 위치 변경 실패: ${JSON.stringify(collapsedProjectDrag)}`);
  mark('control-room:project-reorder-drag');
  await win.webContents.executeJavaScript(`(() => {
    const groups = [...document.querySelectorAll('#liveSessionGrid [data-project-sortable]')];
    const sourceGroup = groups[0];
    const targetGroup = groups[1];
    const source = sourceGroup.querySelector(':scope > .control-project-header');
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const bounds = targetGroup.getBoundingClientRect();
    targetGroup.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: bounds.bottom - 1, dataTransfer: transfer }));
    targetGroup.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientY: bounds.bottom - 1, dataTransfer: transfer }));
  })()`);
  await waitFor(win, `Array.from(document.querySelectorAll('#liveSessionGrid [data-project-sortable]'), node => node.dataset.projectSortable).join(',') === ${JSON.stringify(projectOrderBefore.join(','))}
    && [...document.querySelectorAll('#liveSessionGrid [data-project-sortable]')].every(group => !group.open)`,
  '프로젝트 드래그로 원래 순서를 복원하지 못했거나 닫힌 상태가 바뀌었습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#controlRoomSortSelect');
    select.value = 'tokens';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  mark('control-room:sort');
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
    input.value = 'Codex 원래 작업';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  mark('control-room:search');
  await waitFor(win, `window.LoadToAgentApp.state.search === 'Codex 원래 작업' && Boolean(document.querySelector('[data-control-session="fixture-origin"]'))`, '관제 검색이 실행 세션에 적용되지 않았습니다.');
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
  mark('control-room:project-select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\unregistered-origin' && Boolean(document.querySelector('[data-control-session="fixture-origin"]'))`, '관제 프로젝트 선택이 적용되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('#controlRoomProjectSelect');
    select.value = 'all';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'all'`, '관제 프로젝트 전체 선택을 복원하지 못했습니다.');
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
      historyRoot: Boolean(document.querySelector('#sessionGrid [data-session-id="fixture-root"]')),
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
  assert(!archiveResult.liveRoot && archiveResult.liveChildIncluded && archiveResult.historyRoot
    && archiveResult.manuallyArchived && !archiveResult.controlRoomSession,
  `지난 기록 이동이 완료 세션을 관제 영역에서 내리고 진행 중인 도움 AI만 남기지 못했습니다: ${JSON.stringify(archiveResult)}`);
  await waitFor(win, `Boolean(document.querySelector('[data-control-session="fixture-root"]'))`, '지난 기록 이동 검증 후 관제 fixture를 복원하지 못했습니다.');
  round.observed.controlRoom = controlRoom;
  await clearCalls(win);
  await click(win, '#probeBtn', 'dashboard:probe');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'probeProviders')`, 'AI 연결 상태 새로고침이 호출되지 않았습니다.');
  await clearCalls(win);
  await click(win, '#addWorkspaceBtn', 'workspace:add');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'addWorkspaces')`, 'workspace 추가가 호출되지 않았습니다.');
  await waitFor(win, `Boolean(document.querySelector('[data-workspace="__projectless__"]')) && document.querySelector('[data-workspace="__projectless__"] small')?.textContent === '1'`, '프로젝트 없는 세션 필터와 개수가 표시되지 않았습니다.');
  await waitFor(win, `(() => { const item = [...document.querySelectorAll('#workspaceList [data-workspace]')].find(node => node.dataset.workspace === 'D:\\\\unregistered-origin'); return item?.querySelector('small')?.textContent === '1'; })()`, '등록하지 않은 관측 프로젝트가 세션 개수와 함께 자동 표시되지 않았습니다.');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('#workspaceList [data-workspace]')].find(node => node.dataset.workspace === 'D:\\\\unregistered-origin')?.click()`);
  mark('workspace:select-observed-project');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\unregistered-origin' && window.LoadToAgentApp.filteredSessions().length === 1 && window.LoadToAgentApp.filteredSessions()[0].id === 'fixture-origin' && Boolean(document.querySelector('[data-control-session="fixture-origin"]'))`, '감지된 폴더별 세션 필터가 홈 관제 구조에 적용되지 않았습니다.');
  await click(win, '[data-workspace="all"]', 'workspace:select');
  await waitFor(win, `document.querySelector('#sessionGrid .origin-project small')?.textContent === '작업 시작 폴더'`, '세션 카드에 작업 시작 폴더가 명시되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.workspaces.push({ name: 'board-migration-loop', path: 'C:\\\\Users\\\\fixture\\\\board-migration-loop' });
    const session = app.state.snapshot.sessions.find(item => item.id === 'fixture-live-0');
    session.originCwd = '/mnt/c/Users/fixture/board-migration-loop';
    app.render('wsl-project-alias');
  })()`);
  await waitFor(win, `(() => {
    const chip = [...document.querySelectorAll('#workspaceList [data-workspace]')]
      .find(item => item.dataset.workspace === 'C:\\\\Users\\\\fixture\\\\board-migration-loop');
    return chip?.querySelector('small')?.textContent === '1'
      && chip?.dataset.liveSessionCount === '1'
      && chip?.querySelector('.workspace-live-state')?.innerText.includes('진행 중')
      && ![...document.querySelectorAll('#workspaceList [data-workspace]')]
        .some(item => item.dataset.workspace === '/mnt/c/Users/fixture/board-migration-loop');
  })()`, 'Windows 프로젝트와 같은 WSL 실행 경로를 하나의 진행 중 프로젝트로 합치지 못했습니다.');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('#workspaceList [data-workspace]')]
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
  await click(win, '[data-workspace="__projectless__"]', 'workspace:select-projectless');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === '__projectless__' && document.querySelectorAll('#sessionGrid [data-session-id]').length === 1 && document.querySelector('[data-session-id="fixture-projectless"] .card-subtitle')?.textContent.includes('작업 시작 폴더 정보 없음') && document.querySelector('#globalStatus')?.textContent.includes('작업 시작 폴더 정보 없음') && document.querySelector('#globalStatus')?.textContent.includes('결과 1개')`, '작업 시작 폴더 정보가 없는 세션 필터 또는 결과 안내가 적용되지 않았습니다.');
  await click(win, '[data-workspace="all"]', 'workspace:select');
  await click(win, '[data-workspace="D:\\\\fixture"]', 'workspace:select');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'`, 'workspace 선택이 적용되지 않았습니다.');
  await click(win, '[data-workspace="all"]', 'workspace:select');
  await clearCalls(win);
  await click(win, '[data-remove-workspace="D:\\\\fixture"]', 'workspace:remove');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'removeWorkspace')`, 'workspace 제거가 호출되지 않았습니다.');

  const allProviderCardCount = await win.webContents.executeJavaScript(`document.querySelectorAll('#sessionGrid [data-session-id]').length`);
  await click(win, '[data-provider-card="gpt"]', 'filter:provider-card');
  await waitFor(win, `window.LoadToAgentApp.state.provider === 'gpt' && window.LoadToAgentApp.state.providerFilters.has('gpt') && document.querySelector('[data-provider-filter="gpt"]')?.getAttribute('aria-pressed') === 'true' && document.querySelectorAll('#sessionGrid [data-session-id]').length > 0 && [...document.querySelectorAll('#sessionGrid [data-session-id]')].every(card => window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === card.dataset.sessionId)?.provider === 'gpt')`, '제공사 카드 단일 필터가 실제 GPT 결과에 적용되지 않았습니다.');
  await waitFor(win, `document.querySelector('[data-provider-card="gpt"] .poc-filter-state.visible')?.textContent.includes('필터 적용') && document.querySelector('[data-provider-card="gpt"]')?.classList.contains('filter-clicked')`, '제공사 카드가 필터 선택 상태를 직관적으로 표시하지 않습니다.');
  await click(win, '[data-provider-filter="codex"]', 'filter:provider');
  await waitFor(win, `window.LoadToAgentApp.state.provider === 'multiple' && window.LoadToAgentApp.state.providerFilters.has('gpt') && window.LoadToAgentApp.state.providerFilters.has('codex') && document.querySelector('[data-provider-card="codex"]')?.getAttribute('aria-pressed') === 'true'`, '제공사 다중 필터가 적용되지 않았습니다.');
  await waitFor(win, `(() => { const chip = document.querySelector('[data-provider-filter="codex"]'); const check = chip?.querySelector('.provider-filter-check'); return chip?.classList.contains('filter-clicked') && check && Number.parseFloat(getComputedStyle(check).opacity) > .95 && check.getBoundingClientRect().width >= 15; })()`, '제공사 필터 칩에 체크 표시와 클릭 피드백이 보이지 않습니다.');
  assert(await win.webContents.executeJavaScript(`(() => { const providers = [...document.querySelectorAll('#sessionGrid [data-session-id]')].map(card => window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === card.dataset.sessionId)?.provider); return providers.length >= 2 && providers.includes('gpt') && providers.includes('codex') && providers.every(provider => ['gpt', 'codex'].includes(provider)); })()`), '다중 필터가 GPT와 Codex 실제 결과를 함께 표시하지 못했습니다.');
  await click(win, '[data-provider-filter="gpt"]', 'filter:provider');
  await waitFor(win, `window.LoadToAgentApp.state.provider === 'codex' && !window.LoadToAgentApp.state.providerFilters.has('gpt') && document.querySelectorAll('#sessionGrid [data-session-id]').length > 0 && [...document.querySelectorAll('#sessionGrid [data-session-id]')].every(card => window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === card.dataset.sessionId)?.provider === 'codex')`, '다중 필터에서 GPT를 해제한 뒤 Codex 결과만 남지 않았습니다.');
  await click(win, '[data-provider-filter="all"]', 'filter:provider');
  await waitFor(win, `window.LoadToAgentApp.state.provider === 'all' && window.LoadToAgentApp.state.providerFilters.size === 0 && document.querySelector('[data-provider-filter="all"]')?.getAttribute('aria-pressed') === 'true' && document.querySelectorAll('#sessionGrid [data-session-id]').length === ${allProviderCardCount}`, '제공사 필터 전체 보기를 복원하지 못했습니다.');
  for (const providerId of ['claude', 'gpt', 'gemini', 'grok', 'codex']) await click(win, `[data-provider-filter="${providerId}"]`, 'filter:provider');
  await waitFor(win, `window.LoadToAgentApp.state.providerFilters.size === 0 && document.querySelector('[data-provider-filter="all"]')?.getAttribute('aria-pressed') === 'true'`, '모든 AI를 개별 선택했을 때 전체 보기로 정규화되지 않았습니다.');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#providerFilterStatus').textContent.includes('결과')`), '필터 결과가 스크린리더 상태 영역에 안내되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => { const chip = document.querySelector('[data-provider-filter="all"]'); chip.focus(); chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); })()`);
  await waitFor(win, `document.activeElement?.dataset.providerFilter === 'claude'`, '제공사 필터 방향키 이동 실패');
  await win.webContents.executeJavaScript(`(() => { const workspace = document.querySelector('[data-workspace="all"]'); workspace.focus(); workspace.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); })()`);
  await waitFor(win, `Boolean(document.activeElement?.dataset.workspace)`, '작업 폴더 End 키 이동 실패');
  mark('filter:keyboard-roaming');

  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#searchInput'); input.value = '지난 작업 34'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  mark('filter:search');
  await waitFor(win, `window.LoadToAgentApp.state.search === '지난 작업 34' && document.querySelectorAll('#sessionGrid [data-session-id]').length === 1 && !document.querySelector('#searchClearBtn').classList.contains('hidden') && document.querySelector('#globalStatus').textContent.includes('1')`, '검색 필터와 결과 알림이 결과를 좁히지 못했습니다.');
  await click(win, '#searchClearBtn', 'filter:search-clear');
  await waitFor(win, `window.LoadToAgentApp.state.search === '' && document.querySelector('#searchInput').value === '' && document.querySelector('#searchClearBtn').classList.contains('hidden') && document.activeElement?.id === 'searchInput'`, '검색 지우기 버튼이 검색과 포커스를 초기화하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#searchInput');
    input.value = 'fixture';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-provider-filter="gpt"]').click();
    document.querySelector('[data-workspace="__projectless__"]')?.click();
    const sort = document.querySelector('#sortSelect');
    sort.value = 'tokens';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(win, `!document.querySelector('#resetFiltersBtn').classList.contains('hidden')`, '복합 필터 사용 중 초기화 버튼이 표시되지 않았습니다.');
  await click(win, '#resetFiltersBtn', 'filter:reset-all');
  await waitFor(win, `window.LoadToAgentApp.state.search === '' && window.LoadToAgentApp.state.providerFilters.size === 0 && window.LoadToAgentApp.state.workspace === 'all' && window.LoadToAgentApp.state.sort === 'recent' && document.activeElement?.id === 'searchInput' && document.querySelector('#resetFiltersBtn').classList.contains('hidden')`, '필터 전체 초기화가 검색·AI·작업 폴더·정렬을 복원하지 못했습니다.');

  for (const value of ['tokens', 'context', 'recent']) {
    await win.webContents.executeJavaScript(`(() => { const select = document.querySelector('#sortSelect'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  }
  mark('filter:sort');
  assert(await win.webContents.executeJavaScript(`window.LoadToAgentApp.state.sort`) === 'recent', '정렬 select 최종 상태가 recent가 아닙니다.');
  await waitFor(win, `!document.querySelector('#loadMoreBtn').classList.contains('hidden')`, '더보기 fixture가 표시되지 않았습니다.');
  const beforeCards = await win.webContents.executeJavaScript(`document.querySelectorAll('#sessionGrid [data-session-id]').length`);
  await click(win, '#loadMoreBtn', 'filter:load-more');
  const afterCards = await win.webContents.executeJavaScript(`document.querySelectorAll('#sessionGrid [data-session-id]').length`);
  assert(beforeCards === 30 && afterCards > beforeCards, `더보기 카드 수가 증가하지 않았습니다: ${beforeCards} -> ${afterCards}`);

  await click(win, '[data-open-run]', 'run:open-empty');
  await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden')`, 'empty-window.LoadToAgentApp.state 새 작업 버튼이 모달을 열지 못했습니다.');
  await click(win, '#closeRunModalBtn', 'run:close-x');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, 'empty-window.LoadToAgentApp.state 모달 닫기 실패');
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
      && section.querySelectorAll('.runtime-schedule-card[data-automation-enabled="false"]').length === 1
      && section.querySelectorAll('[data-loop-phase]').length === 4
      && section.querySelectorAll('[data-loop-phase].active').length === 1
      && section.querySelectorAll('[data-loop-select]').length === 6
      && section.querySelector('.runtime-loop-cycle')?.getAttribute('aria-label')?.includes('입력')
      && section.querySelector('.runtime-now-strip')?.textContent.includes('지금 하는 일')
      && section.querySelector('.runtime-active-phase')?.textContent.includes('현재 추정 단계')
      && section.querySelectorAll('.runtime-loop-phase-index em').length === 4
      && section.querySelector('.runtime-loop-footer')?.textContent.includes('예약에서 시작됨')
      && section.querySelector('.runtime-schedule-list')?.textContent.includes('2주마다')
      && section.querySelector('.runtime-schedule-list')?.textContent.includes('금')
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

  const runtimeSemantics = await win.webContents.executeJavaScript(`(() => ({
    scheduleRole: document.querySelector('.runtime-schedule-list')?.getAttribute('role'),
    scheduleListTabIndex: document.querySelector('.runtime-schedule-list')?.tabIndex,
    scheduleItems: document.querySelectorAll('.runtime-schedule-list [role="listitem"]').length,
    scheduleButtons: document.querySelectorAll('.runtime-schedule-list button[data-automation-id]').length,
    scheduleOptions: document.querySelectorAll('.runtime-schedule-list [role="option"]').length,
    scheduleTabStops: [...document.querySelectorAll('.runtime-schedule-list button[data-automation-id]')].filter(item => item.tabIndex === 0).length,
    loopRole: document.querySelector('.runtime-loop-tabs')?.getAttribute('role'),
    loopTabs: document.querySelectorAll('.runtime-loop-tabs [role="tab"]').length,
    loopTabStops: document.querySelectorAll('.runtime-loop-tabs [tabindex="0"]').length,
    selectedTabs: document.querySelectorAll('.runtime-loop-tabs [aria-selected="true"]').length,
    panelLabelled: Boolean(document.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')),
  }))()`);
  assert(runtimeSemantics.scheduleRole === 'list' && runtimeSemantics.scheduleListTabIndex === -1 && runtimeSemantics.scheduleItems === 7 && runtimeSemantics.scheduleOptions === 0 && runtimeSemantics.scheduleButtons > 0 && runtimeSemantics.scheduleTabStops === runtimeSemantics.scheduleButtons && runtimeSemantics.loopRole === 'tablist' && runtimeSemantics.loopTabs === 6 && runtimeSemantics.loopTabStops === 1 && runtimeSemantics.selectedTabs === 1 && runtimeSemantics.panelLabelled, `런타임 목록·탭 ARIA 계약 실패: ${JSON.stringify(runtimeSemantics)}`);
  mark('quality:runtime-schedule-keyboard');
  const selectedLoopBefore = await win.webContents.executeJavaScript(`document.querySelector('.runtime-loop-tabs [aria-selected="true"]')?.dataset.loopSelect`);
  await win.webContents.executeJavaScript(`document.querySelector('.runtime-loop-tabs [aria-selected="true"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))`);
  await waitFor(win, `document.querySelector('.runtime-loop-tabs [aria-selected="true"]')?.dataset.loopSelect !== ${JSON.stringify(selectedLoopBefore)} && document.activeElement === document.querySelector('.runtime-loop-tabs [aria-selected="true"]') && document.querySelectorAll('.runtime-loop-tabs [tabindex="0"]').length === 1`, '런타임 루프 탭 방향키 선택 실패');
  mark('quality:runtime-loop-keyboard');

  const scrollContract = await win.webContents.executeJavaScript(`(() => {
    const scheduleList = document.querySelector('.runtime-schedule-list');
    const loopTabs = document.querySelector('.runtime-loop-tabs');
    scheduleList.scrollTop = Math.min(84, scheduleList.scrollHeight - scheduleList.clientHeight);
    loopTabs.scrollLeft = Math.min(190, loopTabs.scrollWidth - loopTabs.clientWidth);
    scheduleList.focus();
    return {
      beforeTop: scheduleList.scrollTop,
      beforeLeft: loopTabs.scrollLeft,
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
  assert(scrollContract.focusable && scrollContract.beforeTop > 0 && (!scrollContract.horizontalScrollable || scrollContract.beforeLeft > 0), `스크롤 보존 fixture가 유효하지 않습니다: ${JSON.stringify(scrollContract)}`);
  assert(scrollAfter.top === scrollContract.beforeTop && scrollAfter.left === scrollContract.beforeLeft, `snapshot 뒤 런타임 스크롤 위치가 바뀌었습니다: ${JSON.stringify({ scrollContract, scrollAfter })}`);

  await click(win, '[data-loop-select="fixture-live-0"]', 'runtime:select-loop');
  await waitFor(win, `window.LoadToAgentApp.state.selectedRuntimeLoopId === 'fixture-live-0' && document.querySelector('[data-loop-select="fixture-live-0"]')?.getAttribute('aria-pressed') === 'true'`, '실행 루프 선택이 상태와 화면에 반영되지 않았습니다.');
  assert(await win.webContents.executeJavaScript(`document.querySelector('.runtime-loop-footer')?.textContent.includes('1회차') && !document.querySelector('[data-loop-select="fixture-live-5"]')`), '명시적 루프 회차 또는 일반 실행 세션 제외가 올바르지 않습니다.');

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
  await win.webContents.executeJavaScript(`(() => { window.LoadToAgentApp.state.workspace = '__projectless__'; document.querySelector('#runCwd').value = ''; window.LoadToAgentApp.openRunModal(); })()`);
  await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden')`, '프로젝트 없는 새 작업 모달을 열지 못했습니다.');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#appShell').inert && !document.querySelector('#runModal').inert && document.querySelector('#runModal').getAttribute('aria-hidden') === 'false'`), '새 작업 모달이 배경을 보조 기술에서 격리하지 못했습니다.');
  mark('run:background-inert');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#runCwd').value === ''`), '프로젝트 없음 필터 sentinel이 실행 폴더로 복사되었습니다.');
  await click(win, '#closeRunModalBtn', 'run:close-x');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden') && !document.querySelector('#appShell').inert && document.querySelector('#runModal').inert`, '새 작업 모달을 닫은 뒤 배경 상호작용이 복원되지 않았습니다.');
  mark('run:background-restore');
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.state.workspace = 'all'`);
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    app.state.workspaces = [{ name: 'fixture', path: 'D:\\\\fixture' }];
    app.state.availability = Object.fromEntries(app.state.providers.map(provider => [provider.id, false]));
  })()`);
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
    const suggestion = document.querySelector('[data-run-workspace]');
    return {
      promptFirst: Boolean(prompt && providers && (prompt.compareDocumentPosition(providers) & Node.DOCUMENT_POSITION_FOLLOWING)),
      promptCount: document.querySelector('#runPromptCount')?.textContent.trim(),
      workspaceSelected: suggestion?.classList.contains('selected') || false,
    };
  })()`);
  assert(composer.promptFirst && composer.promptCount === '0 / 8,000' && composer.workspaceSelected, `새 작업 입력 흐름의 기본 상태가 올바르지 않습니다: ${JSON.stringify(composer)}`);
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#runPrompt').value = '복원할 새 작업 초안';
    document.querySelector('#runCwd').value = 'D:\\draft-fixture';
    document.querySelector('#runModel').value = 'draft-model';
    document.querySelector('#allowWrites').checked = true;
    for (const element of document.querySelectorAll('#runPrompt, #runCwd, #runModel')) element.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#allowWrites').dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await click(win, '#closeRunModalBtn', 'run:close-x');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, '초안 복원 검증을 위해 모달을 닫지 못했습니다.');
  await click(win, '#newRunBtn', 'run:open');
  await waitFor(win, `document.querySelector('#runPrompt').value === '복원할 새 작업 초안' && document.querySelector('#runCwd').value === 'D:\\draft-fixture' && document.querySelector('#runModel').value === 'draft-model' && document.querySelector('#allowWrites').checked`, '새 작업 초안 필드가 다시 열 때 복원되지 않았습니다.');
  assert(await win.webContents.executeJavaScript(`JSON.parse(sessionStorage.getItem(window.LoadToAgentApp.RUN_DRAFT_STORAGE_KEY)).version === 2`), '새 작업 초안에 버전이 저장되지 않았습니다.');
  mark('quality:run-draft-restore');
  await click(win, '#clearRunDraftBtn', 'run:clear-draft');
  await waitFor(win, `document.querySelector('#runPrompt').value === '' && document.querySelector('#runCwd').value === '' && document.querySelector('#runModel').value === '' && !document.querySelector('#allowWrites').checked && document.activeElement?.id === 'runPrompt' && !sessionStorage.getItem(window.LoadToAgentApp.RUN_DRAFT_STORAGE_KEY)`, '초안 지우기가 모든 필드·저장값·초점을 초기화하지 못했습니다.');
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
  await click(win, '[data-run-prompt-key]', 'run:prompt-example');
  await waitFor(win, `document.querySelector('#runPrompt').value.length > 0 && document.querySelector('#runPromptCount').textContent !== '0 / 8,000'`, '빠른 요청 예시가 입력과 글자 수에 반영되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#runPrompt'); input.dataset.savedValue = input.value; input.value = 'x'.repeat(7200); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(win, `document.querySelector('#runPromptCount').classList.contains('warning') && document.querySelector('#globalStatus').textContent.includes('800')`, '새 작업 요청이 한도에 가까워져도 글자 수 경고가 표시되거나 안내되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#runPrompt'); input.value = input.dataset.savedValue; delete input.dataset.savedValue; input.dispatchEvent(new Event('input', { bubbles: true })); window.LoadToAgentApp.setRunSubmitting(true); document.querySelector('#cancelRunBtn').click(); })()`);
  assert(await win.webContents.executeJavaScript(`!document.querySelector('#runModal').classList.contains('closing') && document.querySelector('#closeRunModalBtn').disabled && document.querySelector('#cancelRunBtn').disabled`), '새 작업 제출 중 취소나 닫기로 모달 상태가 어긋날 수 있습니다.');
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.setRunSubmitting(false)`);
  mark('run:submit-close-guard');
  await click(win, '[data-run-workspace]', 'run:workspace-suggestion');
  await waitFor(win, `document.querySelector('[data-run-workspace]').classList.contains('selected') && document.querySelector('[data-run-workspace]').getAttribute('aria-pressed') === 'true' && document.querySelector('#runCwd').value === 'D:\\\\fixture'`, '최근 작업 폴더 선택이 입력과 선택 상태에 반영되지 않았습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('[data-run-workspace]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))`);
  await waitFor(win, `document.activeElement?.hasAttribute('data-run-workspace')`, '최근 작업 폴더 키보드 이동이 포커스를 유지하지 못했습니다.');
  mark('run:workspace-keyboard');
  await click(win, '[data-run-provider="gpt"]', 'run:provider');
  await waitFor(win, `document.querySelector('[data-run-provider="gpt"]').getAttribute('aria-checked') === 'true' && document.querySelector('[data-run-provider="gpt"]').getAttribute('role') === 'radio' && document.querySelector('#runSubmitLabel').textContent.includes('GPT')`, 'AI 선택이 라디오 상태와 실행 버튼에 반영되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => { const option = document.querySelector('[data-run-provider="gpt"]'); option.focus(); option.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); })()`);
  await waitFor(win, `document.querySelector('[data-run-provider="gemini"]')?.getAttribute('aria-checked') === 'true' && document.activeElement?.dataset.runProvider === 'gemini'`, 'AI 선택기 오른쪽 방향키가 다음 AI를 선택하지 못했습니다.');
  mark('run:provider-keyboard');
  await click(win, '[data-run-provider="gpt"]', 'run:provider');

  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#runCwd').value = 'D:\\fixture';
    document.querySelector('#runPrompt').value = '   ';
    document.querySelector('#runPrompt').dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click(win, '#runForm button[type="submit"]', 'run:submit');
  await waitFor(win, `document.querySelector('#runPrompt').getAttribute('aria-invalid') === 'true' && document.activeElement?.id === 'runPrompt' && document.querySelector('#runError').textContent.includes('공백')`, '공백 요청을 거부하고 첫 오류 입력에 초점을 두지 못했습니다.');
  mark('quality:run-whitespace-validation');

  await win.webContents.executeJavaScript(`(() => { document.querySelector('#runCwd').value = ''; document.querySelector('#runPrompt').value = ''; document.querySelector('#runPrompt').dispatchEvent(new Event('input', { bubbles: true })); window.interactionTest.clearCalls(); })()`);
  await win.webContents.executeJavaScript(`document.querySelector('#runPrompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))`);
  mark('run:keyboard-submit');
  const nativeInvalid = await win.webContents.executeJavaScript(`(() => ({ calls: window.interactionTest.getCalls().filter(item => item.name === 'runAgent').length, cwd: document.querySelector('#runCwd').matches(':invalid'), prompt: document.querySelector('#runPrompt').matches(':invalid'), ariaCwd: document.querySelector('#runCwd').getAttribute('aria-invalid'), ariaPrompt: document.querySelector('#runPrompt').getAttribute('aria-invalid'), visible: !document.querySelector('#runModal').classList.contains('hidden') }))()`);
  assert(nativeInvalid.calls === 0 && nativeInvalid.cwd && nativeInvalid.prompt && nativeInvalid.ariaCwd === 'true' && nativeInvalid.ariaPrompt === 'true' && nativeInvalid.visible, `필수 필드 검증이 submit과 접근성 오류 상태를 반영하지 못했습니다: ${JSON.stringify(nativeInvalid)}`);
  mark('run:required-validation');

  await win.webContents.executeJavaScript(`(() => {
    window.interactionTest.configure({ failures: { runAgent: 1 } });
    document.querySelector('#runCwd').value = 'D:\\\\failed-fixture';
    document.querySelector('#runModel').value = 'failure-model';
    document.querySelector('#runPrompt').value = '실패해도 보존할 요청';
  })()`);
  await click(win, '#runForm button[type="submit"]', 'run:submit');
  await waitFor(win, `!document.querySelector('#runError').classList.contains('hidden')`, 'runAgent 실패 오류가 표시되지 않았습니다.');
  assert(await win.webContents.executeJavaScript(`document.activeElement?.id === 'runError'`), '새 작업 실행 실패 후 오류 메시지로 초점이 이동하지 않았습니다.');
  const preserved = await win.webContents.executeJavaScript(`(() => ({ cwd: document.querySelector('#runCwd').value, model: document.querySelector('#runModel').value, prompt: document.querySelector('#runPrompt').value }))()`);
  assert(preserved.cwd === 'D:\\failed-fixture' && preserved.model === 'failure-model' && preserved.prompt === '실패해도 보존할 요청', `run 실패 후 필드가 보존되지 않았습니다: ${JSON.stringify(preserved)}`);
  mark('run:failure-preserve');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);

  await clearCalls(win);
  await click(win, '#pickRunCwdBtn', 'run:pick-cwd');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'pickWorkspace') && document.querySelector('#runCwd').value === 'D:\\\\fixture-picked'`, '작업 폴더 찾기 버튼이 값을 반영하지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#runCwd').value = 'D:\\\\fixture';
    document.querySelector('#runModel').value = 'gpt-fixture';
    document.querySelector('#runPrompt').value = '실제 DOM submit 검증';
    document.querySelector('#allowWrites').click();
  })()`);
  mark('run:allow-writes');
  await clearCalls(win);
  await click(win, '#runForm button[type="submit"]', 'run:submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'runAgent')`, 'runAgent fixture가 호출되지 않았습니다.');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, '성공 후 새 작업 모달이 닫히지 않았습니다.');
  assert(await callCount(win, 'runAgent') === 1, '새 작업 submit 한 번에 runAgent가 정확히 한 번 호출되어야 합니다.');
  const payload = await win.webContents.executeJavaScript(`window.interactionTest.getCalls().find(item => item.name === 'runAgent').args[0]`);
  assert(payload.cwd === 'D:\\fixture' && payload.model === 'gpt-fixture' && payload.prompt === '실제 DOM submit 검증' && payload.allowWrites === true, `run field payload가 다릅니다: ${JSON.stringify(payload)}`);

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
  await click(win, '#runModal', 'run:backdrop');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, '배경 클릭으로 모달이 닫히지 않았습니다.');
  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden') && document.activeElement === document.querySelector('#runPrompt')`, '새 작업 단축키가 입력창을 열고 포커스하지 않았습니다.');
  await click(win, '#cancelRunBtn', 'run:cancel-shortcut');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, '단축키로 연 새 작업 창이 닫히지 않았습니다.');
  round.observed.runAgentCalls = 1;
  round.observed.runComposer = true;
}

async function exerciseDrawer(win, round) {
  await click(win, '[data-view="all"]', 'nav:all');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'all' && document.querySelector('[data-session-id="fixture-ended"]')`, '완료 세션 카드가 없습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('[data-session-id="fixture-ended"]').focus({ preventScroll: true })`);
  await click(win, '[data-session-id="fixture-ended"]', 'drawer:open-card');
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
  await clearCalls(win);
  await click(win, '[data-copy-text]', 'drawer:copy');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'writeClipboard') && document.querySelector('#globalStatus').textContent.includes('복사')`, '상세 창의 전체 식별자 복사가 동작하거나 안내되지 않았습니다.');
  for (const tab of ['summary', 'lifecycle', 'tokens', 'chat']) {
    await click(win, `[data-tab="${tab}"]`, `drawer:tab-${tab}`);
    await waitFor(win, `window.LoadToAgentApp.state.drawerTab === ${JSON.stringify(tab)} && document.querySelector('[data-tab="${tab}"]').classList.contains('active')`, `${tab} 탭 전환 실패`);
  }
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
    progressCount: Number(document.querySelector('.chat-progress-updates')?.dataset.progressCount || 0),
    progressOpen: Boolean(document.querySelector('.chat-progress-updates')?.open),
    finalAnswer: document.querySelector('.chat-answer-kind')?.textContent || '',
  }))()`);
  assert(!toolActivityHidden.activitySection && !toolActivityHidden.activityText && toolActivityHidden.turnCount === 1
    && toolActivityHidden.visibleAssistantRows === 1 && toolActivityHidden.progressCount === 1
    && !toolActivityHidden.progressOpen && toolActivityHidden.finalAnswer === '최종 답변',
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
  await click(win, '.chat-progress-updates > summary', 'drawer:expand-progress');
  await waitFor(win, `document.querySelector('.chat-progress-updates')?.open
    && document.querySelector('.chat-progress-list')?.innerText.includes('먼저 상세 대화 구조와 반응형 화면을 확인하겠습니다.')`, '진행 업데이트 원문을 펼치지 못했습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.emitSnapshot()`);
  await waitFor(win, `document.querySelector('.chat-progress-updates')?.open`, '자동 갱신 뒤 진행 업데이트 펼침 상태가 유지되지 않았습니다.');
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
  await click(win, '[data-session-id="fixture-history-0"]', 'drawer:open-card');
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
      cachedConversationVisible: document.querySelector('#drawerContent').innerText.includes('상호작용 테스트를 진행해줘'),
    };
    await third;
    return { sharedInitialRequest, duringRefresh, title: app.state.details.get('fixture-root')?.title || '', loading: app.state.detailLoadingIds.has('fixture-root') };
  })()`);
  assert(drawerRace.sharedInitialRequest && drawerRace.duringRefresh.title === '최초 상세 응답' && drawerRace.duringRefresh.loading
    && !drawerRace.duringRefresh.fullScreenLoader && drawerRace.duringRefresh.cachedConversationVisible
    && drawerRace.title === '백그라운드 최신 응답' && !drawerRace.loading,
  `상세 요청 병합과 백그라운드 갱신 상태가 올바르지 않습니다: ${JSON.stringify(drawerRace)}`);
  await click(win, '#drawerBackdrop', 'drawer:backdrop');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, 'drawer backdrop 닫기 실패');
  round.observed.drawerTabs = 3;
  round.observed.drawerRetry = true;
}

async function focusRoot(win) {
  await click(win, '[data-view="all"]', 'nav:all');
  const alreadyFocused = await win.webContents.executeJavaScript(`Boolean(window.LoadToAgentApp.state.graphFocusId)`);
  if (alreadyFocused) {
    const reset = await win.webContents.executeJavaScript(`document.querySelector('[data-graph-reset]') ? '[data-graph-reset]' : (document.querySelector('#graphResetBtn:not(.hidden)') ? '#graphResetBtn' : '')`);
    assert(reset, 'focus 초기화를 위한 graph reset 컨트롤이 없습니다.');
    await click(win, reset, 'graph:reset');
    await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === null`, '기존 graph focus 초기화 실패');
  }
  await waitFor(win, `document.querySelector('[data-graph-focus="fixture-root"]')`, '메인 graph node가 없습니다.');
  await click(win, '[data-graph-focus="fixture-root"]', 'graph:focus');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-root' && document.querySelector('.agent-workflow-canvas')`, 'graph focus 화면 전환 실패');
}

async function exerciseGraph(win, round) {
  const drawerOpen = await win.webContents.executeJavaScript(`document.querySelector('#detailDrawer').classList.contains('open')`);
  if (drawerOpen) {
    await click(win, '#closeDrawerBtn', 'graph:close-existing-drawer');
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, 'graph 시각 검증 전에 상세 창을 닫지 못했습니다.');
  }
  await focusRoot(win);
  const goalSummary = await win.webContents.executeJavaScript(`(() => {
    const goal = document.querySelector('.agent-workflow-selected .agent-task');
    const breadcrumb = document.querySelector('#graphBreadcrumbs .current');
    return { text: goal?.textContent || '', full: goal?.title || '', note: Boolean(document.querySelector('.agent-workflow-selected .agent-goal-note')), breadcrumbText: breadcrumb?.textContent || '', breadcrumbFull: breadcrumb?.title || '' };
  })()`);
  assert(goalSummary.note && goalSummary.text.endsWith('…') && goalSummary.full.length > goalSummary.text.length && goalSummary.breadcrumbText.endsWith('…') && goalSummary.breadcrumbFull.length > goalSummary.breadcrumbText.length, `긴 지금 목표가 읽기 좋은 요약으로 표시되지 않았습니다: ${JSON.stringify(goalSummary)}`);
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
  assert(executionVisualization.labels.includes('백그라운드 명령 실행')
    && executionVisualization.labels.includes('일반 명령 실행')
    && executionVisualization.labels.includes('백그라운드 작업')
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
    && foregroundDetail.metadata.includes('PowerShell')
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

  await focusRoot(win);
  await clearCalls(win);
  await click(win, '[data-open-session="fixture-root"]', 'drawer:open-graph');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && document.querySelector('[data-stop-run]')`, '실행 중 session drawer가 열리지 않았습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ delays: { stopAgent: 180 } })`);
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-stop-run]').click();
    document.querySelector('[data-stop-run]')?.click();
  })()`);
  mark('drawer:stop-double');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'stopAgent')`, '중지 버튼이 stopAgent를 호출하지 않았습니다.');
  await sleep(260);
  assert(await callCount(win, 'stopAgent') === 1, '중지 클릭 한 번에 stopAgent가 한 번 호출되어야 합니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, '실행 상세 drawer가 닫히지 않았습니다.');
  round.observed.graphResetClicks = 2;
}

async function resetGraphToOverview(win) {
  if (!await win.webContents.executeJavaScript(`Boolean(window.LoadToAgentApp.state.graphFocusId)`)) return;
  const selector = await win.webContents.executeJavaScript(`document.querySelector('[data-graph-reset]') ? '[data-graph-reset]' : '#graphResetBtn'`);
  await click(win, selector, 'graph:reset');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === null`, 'graph overview 복귀 실패');
}

async function exerciseAgentControls(win, round) {
  await click(win, '[data-view="all"]', 'nav:all');
  await resetGraphToOverview(win);

  await focusRoot(win);
  await win.webContents.executeJavaScript(`(() => {
    const picker = document.querySelector('[data-agent-command-target="fixture-root"]');
    picker.value = 'terminal-main';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  mark('agent:target-select');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-agent-command-draft="fixture-root"]');
    input.value = 'AGENT_DIRECT_COMMAND';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-agent-command-form="fixture-root"] button[type="submit"]').click();
  })()`);
  mark('agent:command-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCommand')`, 'AI 직접 지시 form submit이 terminalCommand를 호출하지 않았습니다.');
  assert(await callCount(win, 'terminalCommand') === 1, 'AI 직접 지시가 한 번보다 많이 전송되었습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const picker = document.querySelector('[data-agent-command-target="fixture-root"]');
    picker.value = 'tmux:FixtureLinux:%7';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  mark('agent:target-select');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-agent-command-draft="fixture-root"]');
    input.value = 'TMUX_DIRECT_COMMAND';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
  })()`);
  mark('agent:command-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'tmuxSendText'
    && item.args[0].distro === 'FixtureLinux'
    && item.args[0].target === '%7'
    && item.args[0].text === 'TMUX_DIRECT_COMMAND')
    && !window.interactionTest.getCalls().some(item => item.name === 'terminalCreate')`,
  '연결된 tmux 세션의 지시가 기존 pane 대신 새 세션 터미널을 만들었습니다.');
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.state.agentCommandTargets.set('fixture-root', 'terminal-main')`);

  await resetGraphToOverview(win);
  await focusRoot(win);
  await click(win, '[data-graph-focus="fixture-child"]', 'graph:focus');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-child'
    && Boolean(document.querySelector('[data-open-session="fixture-child"]'))
    && Boolean(document.querySelector('[data-agent-bridge-copy]'))`, '서브에이전트 상세 흐름이 표시되지 않았습니다.');
  await clearCalls(win);
  await click(win, '[data-agent-bridge-copy]', 'agent:bridge-copy');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'bridgeCommand')`, '연결용 시작 명령 복사가 호출되지 않았습니다.');
  await resetGraphToOverview(win);
  await click(win, '[data-open-subagent-chat="fixture-child"]', 'control-room:open-subagent');
  await waitFor(win, `window.LoadToAgentApp.state.drawerMode === 'subagent'
    && document.querySelectorAll('[data-agent-command-route]').length === 2
    && Boolean(document.querySelector('[data-agent-command-route="direct"]'))
    && document.querySelector('[data-agent-command-route="direct"]')?.disabled
    && document.querySelector('[data-agent-command-route="parent"]')?.getAttribute('aria-pressed') === 'true'
    && !document.querySelector('[data-agent-command-form="fixture-child"] button[type="submit"]')?.disabled
    && window.LoadToAgentTerminal.agentTargets(window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-child')).length === 0
    && Boolean(document.querySelector('[data-agent-command-form="fixture-child"]'))`, '부모 관리 서브에이전트의 인라인 메인 경유 경로가 표시되지 않았습니다.');
  await click(win, '#detailDrawer [data-agent-command-route="parent"]', 'control-room:command-route');
  await waitFor(win, `document.querySelector('#detailDrawer [data-agent-command-route="parent"]')?.getAttribute('aria-pressed') === 'true'`, '메인 에이전트 경유 전달 경로 선택을 유지하지 못했습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, '서브에이전트 상세 drawer가 닫히지 않았습니다.');

  await resetGraphToOverview(win);
  await click(win, '[data-graph-focus="fixture-live-0"]', 'graph:focus');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-live-0' && document.querySelector('.agent-command-panel.control-handoff textarea:not([disabled])')`, '외부 CLI 세션 이어받기 UI가 표시되지 않았습니다.');
  await click(win, '[data-open-session="fixture-live-0"]', 'drawer:open-session');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')
    && document.querySelector('#drawerComposer .agent-command-panel.control-handoff[data-agent-command-routing="conversation"] textarea:not([disabled])')`,
  '외부 CLI 세션의 대화 입력창이 열리지 않았습니다.');
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
    && document.querySelector('#drawerContent .chat-row.user.is-optimistic.is-sending')?.innerText.includes('HANDOFF_EXISTING_SESSION')
    && Boolean(document.querySelector('#drawerContent .chat-turn-waiting'))
    && !document.querySelector('#terminalSection:not(.hidden)')`,
  '대화 전송 직후 내 메시지와 AI 응답 대기 상태를 표시하면서 상세 창을 유지하지 못했습니다.');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate'
    && item.args[0].provider === 'claude'
    && item.args[0].distro === 'FixtureLinux'
    && item.args[0].cwd === '/mnt/c/Users/fixture/board-migration-loop'
    && item.args[0].transient === true
    && item.args[0].args.join(' ') === '--resume fixture-live-0-external --print HANDOFF_EXISTING_SESSION')
    && window.LoadToAgentApp.state.view === 'all'
    && document.querySelector('#detailDrawer').classList.contains('open')
    && document.querySelector('#drawerContent .chat-row.user.is-optimistic.is-awaiting')`,
  'WSL 외부 CLI를 백그라운드에서 이어받고 대화 상세 화면을 유지하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const now = Date.now();
    window.interactionTest.appendSessionMessages('fixture-live-0', [
      { id: 'fixture-live-0-user-reply-test', role: 'user', text: 'HANDOFF_EXISTING_SESSION', timestamp: new Date(now).toISOString() },
      { id: 'fixture-live-0-assistant-reply-test', role: 'assistant', text: 'BACKGROUND_AI_RESPONSE', timestamp: new Date(now + 1).toISOString() },
    ]);
    window.interactionTest.emitSnapshot();
  })()`);
  await waitFor(win, `document.querySelector('#drawerContent [data-message-id="fixture-live-0-user-reply-test"]')
    && document.querySelector('#drawerContent [data-message-id="fixture-live-0-assistant-reply-test"]')?.innerText.includes('BACKGROUND_AI_RESPONSE')
    && !document.querySelector('#drawerContent .chat-row.is-optimistic')
    && !document.querySelector('#drawerContent .chat-turn-waiting')
    && !window.LoadToAgentApp.state.pendingConversationMessages.has('fixture-live-0')`,
  '백그라운드 AI 응답이 도착한 뒤 임시 메시지를 실제 대화로 교체하지 못했습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, '이어받기 후 대화 상세 drawer가 닫히지 않았습니다.');

  await click(win, '[data-view="all"]', 'nav:all');
  await resetGraphToOverview(win);
  await click(win, '[data-graph-focus="fixture-origin"]', 'graph:focus');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-origin'
    && document.querySelector('.agent-command-panel.control-origin-resume textarea:not([disabled])')
    && !document.querySelector('[data-agent-open-origin]')
    && !document.querySelector('.agent-command-panel')?.innerText.includes('보기만 가능')
    && !document.querySelector('.agent-command-panel')?.innerText.includes('원래 앱')`, '실행 중인 Codex 데스크톱 작업의 즉시 개입 UI가 표시되지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-agent-command-draft="fixture-origin"]');
    input.value = 'RESUME_DESKTOP_IN_BACKGROUND';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
  })()`);
  mark('agent:command-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate' && item.args[0].provider === 'codex' && item.args[0].bridgeId === 'fixture-origin' && item.args[0].args.join(' ') === 'resume fixture-origin-external RESUME_DESKTOP_IN_BACKGROUND')`, '실행 중인 Codex 데스크톱 작업을 백그라운드 터미널로 이어받지 못했습니다.');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'terminal'
    && !document.querySelector('#terminalHistoryPanel')?.classList.contains('hidden')
    && document.querySelector('#terminalHistoryTitle')?.textContent.includes('Codex 원래 작업 열기 검증')
    && !document.querySelector('#terminalCommandInput')?.disabled`, '복원한 백그라운드 터미널에 같은 세션의 대화 내역과 입력창이 함께 표시되지 않았습니다.');
  await click(win, '[data-view="all"]', 'nav:all');
  await win.webContents.executeJavaScript(`(() => { window.LoadToAgentApp.state.graphFocusId = 'fixture-origin'; window.LoadToAgentApp.renderSessions(); })()`);
  await waitFor(win, `document.querySelector('.agent-command-panel.control-direct [data-agent-terminal-open]')`, '백그라운드로 이어받은 데스크톱 작업이 직접 입력 가능한 터미널로 연결되지 않았습니다.');

  await resetGraphToOverview(win);
  await focusRoot(win);
  await waitFor(win, `document.querySelectorAll('.child-session.work-working').length === 1 && document.querySelectorAll('.child-session.work-resting').length === 0 && document.querySelector('[data-subagent-completed-toggle="fixture-root"]') && !document.querySelector('[data-subagent-search], [data-subagent-provider], [data-subagent-status]')`, '진행 중 우선·완료 기본 숨김 상태가 적용되지 않았습니다.');
  await click(win, '[data-subagent-completed-toggle="fixture-root"]', 'subagent:toggle-completed');
  await waitFor(win, `document.querySelectorAll('.child-session.work-working').length === 1 && document.querySelectorAll('.child-session.work-resting').length === 1 && Boolean(document.querySelector('[data-open-subagent-chat="fixture-resting"]'))`, '완료된 서브에이전트 펼치기가 정확히 동작하지 않았습니다.');
  await click(win, '[data-open-subagent-chat="fixture-resting"]', 'subagent:open-conversation');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-root'
    && window.LoadToAgentApp.state.drawerMode === 'subagent'
    && window.LoadToAgentApp.state.details.has('fixture-resting')
    && document.querySelector('[data-subagent-work-messages="2"]')
    && document.querySelector('[data-subagent-coordination-count="2"]')
    && document.querySelector('#drawerContent').innerText.includes('홈에서 실행 구조가 즉시 읽히는지')
    && document.querySelector('#drawerContent').innerText.includes('직접 개입과 메인 에이전트 경유 개입')
    && document.querySelector('.subagent-assignment-card')?.innerText.includes('메인 에이전트가 시킨 일')
    && !document.querySelector('#drawerContent').textContent.includes('gAAAA')
    && !document.querySelector('#drawerContent').innerText.includes('보호된 메시지')
    && !document.querySelector('#drawerContent').innerText.includes('내용 없이 통신 상태')
    && document.querySelector('.drawer-tab:not(.hidden)').textContent === '작업 내용'
    && document.querySelectorAll('.drawer-tab:not(.hidden)').length === 1
    && document.querySelector('[data-agent-command-route="direct"]')?.disabled
    && document.querySelector('[data-agent-command-route="parent"]')?.getAttribute('aria-pressed') === 'true'
    && !document.querySelector('[data-agent-command-form="fixture-resting"] button[type="submit"]')?.disabled`, '서브카드 클릭이 실제 서브에이전트 작업 기록과 인라인 전달창을 열지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ delays: { terminalCommand: 180 } })`);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-agent-command-draft="fixture-resting"]');
    input.value = 'RESTING_HELPER_INLINE_COMMAND';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
  })()`);
  mark('agent:command-submit');
  await waitFor(win, `document.querySelector('#drawerContent .chat-row.user.is-optimistic.is-sending')?.innerText.includes('RESTING_HELPER_INLINE_COMMAND')
    && Boolean(document.querySelector('#drawerContent .chat-turn-waiting'))
    && document.querySelector('#detailDrawer').classList.contains('open')
    && window.LoadToAgentApp.state.view === 'all'`,
  '메인 에이전트 경유 메시지가 대화에 즉시 올라가거나 AI 응답 대기 상태가 표시되지 않았습니다.');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCommand'
    && item.args[0] === 'terminal-main'
    && item.args[1].includes('RESTING_HELPER_INLINE_COMMAND'))
    && window.LoadToAgentApp.state.view === 'all'
    && window.LoadToAgentApp.state.drawerMode === 'subagent'
    && document.querySelector('#detailDrawer').classList.contains('open')
    && !window.interactionTest.getCalls().some(item => item.name === 'terminalCreate' && item.args[0]?.bridgeId === 'fixture-resting')`, '쉬는 서브에이전트 지시가 화면 이동 없이 메인 에이전트를 통해 전달되지 않았습니다.');
  await waitFor(win, `document.querySelector('#drawerContent .chat-row.user.is-optimistic.is-awaiting')
    && Boolean(document.querySelector('#drawerContent .chat-turn-waiting'))`,
  '전송 완료 뒤 실제 AI 답변이 올 때까지 대기 상태를 유지하지 못했습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  round.observed.agentControlModes = ['direct', 'connect', 'handoff', 'origin-resume', 'parent-relay'];
  round.observed.subagentConversationOnly = true;
  round.observed.subagentCompletedDefault = 'hidden-until-expanded';
}

async function exerciseTerminal(win, round) {
  if (!await win.webContents.executeJavaScript(`document.querySelector('#drawerBackdrop')?.classList.contains('hidden')`)) {
    await click(win, '#closeDrawerBtn', 'drawer:close');
    await waitFor(win, `document.querySelector('#drawerBackdrop')?.classList.contains('hidden')`, '터미널 검증 전에 열린 상세 창을 닫지 못했습니다.');
  }
  await click(win, '[data-view="terminal"]', 'nav:terminal');
  await waitFor(win, `Boolean(document.querySelector('[data-terminal-id="terminal-main"]'))`, '터미널 목록 로드 실패');
  await click(win, '.terminal-session-tools > summary', 'terminal:session-controls');
  await waitFor(win, `document.querySelector('.terminal-session-tools')?.hasAttribute('open')`, '터미널 세션 관리 메뉴가 열리지 않았습니다.');
  const initialFontSize = await win.webContents.executeJavaScript(`Number.parseInt(document.querySelector('#terminalFontSizeLabel')?.textContent || '0', 10)`);
  await click(win, '#terminalFontDecreaseBtn', 'terminal:font-decrease');
  await waitFor(win, `Number.parseInt(document.querySelector('#terminalFontSizeLabel')?.textContent || '0', 10) === ${Math.max(12, initialFontSize - 1)}`, '터미널 글자 축소가 반영되지 않았습니다.');
  await click(win, '#terminalFontIncreaseBtn', 'terminal:font-increase');
  await waitFor(win, `Number.parseInt(document.querySelector('#terminalFontSizeLabel')?.textContent || '0', 10) === ${initialFontSize}`, '터미널 글자 확대가 반영되지 않았습니다.');
  await click(win, '#terminalFocusBtn', 'terminal:focus-mode');
  await waitFor(win, `document.querySelector('#terminalSection')?.classList.contains('terminal-focus-mode') && document.querySelector('#terminalFocusBtn')?.getAttribute('aria-pressed') === 'true'`, '터미널 집중 보기가 활성화되지 않았습니다.');
  await click(win, '#terminalFocusBtn', 'terminal:focus-mode');
  await waitFor(win, `!document.querySelector('#terminalSection')?.classList.contains('terminal-focus-mode') && document.querySelector('#terminalFocusBtn')?.getAttribute('aria-pressed') === 'false'`, '터미널 집중 보기가 해제되지 않았습니다.');
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
  const initialOrder = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#terminalSessionList [data-terminal-id]')].map(item => item.dataset.terminalId)`);
  if (round.index > 1) assert(initialOrder[0] === expectedTerminalFirstAfterReload, `저장된 터미널 순서가 재로드 후 복원되지 않았습니다: ${JSON.stringify(initialOrder)}`);
  const terminalEndKey = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#terminalSessionList [data-terminal-id]')];
    const first = items[0];
    first.focus();
    const accepted = first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    return { accepted, active: document.activeElement?.dataset.terminalId || document.activeElement?.id || document.activeElement?.tagName, expected: items.at(-1)?.dataset.terminalId, tabStops: items.filter(item => item.tabIndex === 0).map(item => item.dataset.terminalId) };
  })()`);
  assert(terminalEndKey.active === terminalEndKey.expected && terminalEndKey.tabStops.length === 1 && terminalEndKey.tabStops[0] === terminalEndKey.expected, `터미널 세션 End 키 이동 실패: ${JSON.stringify(terminalEndKey)}`);
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
  mark('terminal:reorder-drag');
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
  expectedTerminalFirstAfterReload = reordered.before.find(id => id !== 'terminal-main') || '';
  round.observed.terminalReorder = { drag: true, keyboard: true, arrowsRemoved: true, persisted: round.index > 1 };
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => { const button = document.querySelector('#newPowerShellBtn'); button.click(); button.click(); })()`);
  mark('terminal:create-windows');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate')`, 'Windows 터미널 생성 실패');
  assert(await callCount(win, 'terminalCreate') === 1, 'Windows 터미널 버튼 연속 클릭이 중복 세션을 만들었습니다.');
  mark('terminal:create-single-flight');
  await clearCalls(win);
  await click(win, '#newWslBtn', 'terminal:create-linux');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate')`, 'Linux 터미널 생성 실패');
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ failures: { terminalResize: 1 }, delays: { terminalRestart: 180 } })`);
  await click(win, '[data-terminal-id="terminal-ended"]', 'terminal:select-session');
  await waitFor(win, `!document.querySelector('#terminalRestartBtn').classList.contains('hidden')`, '종료 세션 다시 시작 버튼이 표시되지 않았습니다.');
  await clearCalls(win);
  const restartBusy = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#terminalRestartBtn');
    button.click();
    return button.disabled && button.getAttribute('aria-busy') === 'true';
  })()`);
  mark('terminal:restart');
  assert(restartBusy, '터미널 다시 시작 중 바쁜 상태가 표시되지 않았습니다.');
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
  await waitFor(win, `document.querySelector('[data-terminal-id="terminal-main"]')?.innerText.includes('호스트 중단 뒤 새 프로세스로 복구됨')`, '호스트 복구 상태가 터미널 목록에 표시되지 않았습니다.');
  mark('terminal:host-reconnect-rehydrate');

  await focusRoot(win);
  const targetDiagnostic = await win.webContents.executeJavaScript(`(() => {
    const session = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === 'fixture-root');
    return {
      targets: window.LoadToAgentTerminal.agentTargets(session),
      terminals: [...document.querySelectorAll('[data-terminal-id]')].map(item => ({ id: item.dataset.terminalId, text: item.textContent })),
      presence: session && session.runtimePresence,
      sending: window.LoadToAgentApp.state.agentCommandSending.has('fixture-root'),
      buttonDisabled: document.querySelector('[data-agent-terminal-open="fixture-root"]')?.disabled,
    };
  })()`);
  assert(targetDiagnostic.targets.length > 0, `fixture AI 터미널 대상이 사라졌습니다: ${JSON.stringify(targetDiagnostic)}`);
  if (targetDiagnostic.buttonDisabled) {
    const picked = await win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('[data-agent-command-target="fixture-root"]');
      if (!select) return false;
      select.value = 'terminal-main';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert(picked, `여러 터미널 중 선택할 picker가 없습니다: ${JSON.stringify(targetDiagnostic)}`);
    mark('agent:target-select');
    await waitFor(win, `!document.querySelector('[data-agent-terminal-open="fixture-root"]').disabled`, '터미널 대상 선택 후 열기 버튼이 활성화되지 않았습니다.');
  }
  await click(win, '[data-agent-terminal-open="fixture-root"]', 'terminal:open-from-agent');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'terminal' && document.querySelector('.terminal-session-item.active')?.dataset.terminalId === 'terminal-main' && !document.querySelector('#terminalHistoryPanel').classList.contains('hidden')`, 'AI 카드에서 연결 터미널을 열지 못했습니다.', 120);

  await click(win, '#terminalHistoryToggle', 'terminal:history-collapse');
  await waitFor(win, `document.querySelector('#terminalHistoryToggle').getAttribute('aria-expanded') === 'false'`, '대화 기록 접기 실패');
  await click(win, '#terminalHistoryToggle', 'terminal:history-expand');
  await waitFor(win, `document.querySelector('#terminalHistoryToggle').getAttribute('aria-expanded') === 'true'`, '대화 기록 펼치기 실패');

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
    document.querySelector('#terminalCommandForm button[type="submit"]').click();
  })()`);
  mark('terminal:failure-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCommand')`, '실패 fixture 명령이 호출되지 않았습니다.');
  await sleep(120);
  const retained = await win.webContents.executeJavaScript(`document.querySelector('#terminalCommandInput').value`);
  assert(retained === 'FAILURE_DRAFT_MUST_STAY', '터미널 전송 실패 후 작성 중인 명령이 보존되지 않았습니다.');
  assert(await win.webContents.executeJavaScript(`document.activeElement?.id === 'terminalNotice'`), '터미널 전송 실패 후 오류 안내로 초점이 이동하지 않았습니다.');
  await click(win, '#terminalCommandClearBtn', 'terminal:clear-draft');
  await waitFor(win, `document.querySelector('#terminalCommandInput').value === '' && document.activeElement?.id === 'terminalCommandInput' && document.querySelector('#terminalCommandClearBtn').classList.contains('hidden')`, '터미널 명령 지우기가 값·버튼·초점을 초기화하지 못했습니다.');

  await win.webContents.executeJavaScript(`window.interactionTest.clearControls(); window.interactionTest.clearCalls()`);
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
  await click(win, '[data-terminal-id="terminal-main"]', 'terminal:select-session');
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ delays: { terminalClose: 180 } })`);
  await click(win, '#terminalEndSessionBtn', 'terminal:end-session');
  assert(await win.webContents.executeJavaScript(`document.querySelector('#terminalEndSessionBtn').disabled && document.querySelector('#terminalEndSessionBtn').getAttribute('aria-busy') === 'true'`), 'AI 터미널 명시적 종료 중 바쁜 상태가 표시되지 않았습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('#terminalEndSessionBtn').click()`);
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalClose')`, '세션 종료 버튼이 terminalClose를 호출하지 않았습니다.');
  await waitFor(win, `!document.querySelector('[data-terminal-id="terminal-main"]')`, '종료된 세션이 목록에서 제거되지 않았습니다.');
  assert(await callCount(win, 'terminalClose') === 1, '세션 종료 클릭 한 번에 terminalClose가 정확히 한 번 호출되어야 합니다.');
  mark('quality:terminal-close-busy');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  round.observed.terminal = { signals: 2, imeGuard: true, duplicateGuard: true, failureDraft: true, closed: true };
}

async function openTmuxControl(win) {
  await click(win, '[data-control-tmux="tmux-pane-id"]', 'tmux:control-pane');
  await waitFor(win, `!document.querySelector('#terminalTmuxTools').classList.contains('hidden') && document.querySelector('[data-tmux-manage="rename-session"]')`, 'tmux 조작 도구가 열리지 않았습니다.', 100);
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
  assert(!tmuxProjection.paneIds.includes('tmux-pane-dead') && tmuxProjection.summary.panes === 2 && tmuxProjection.summary.aiPanes === 2 && tmuxProjection.summary.linked === 1, `종료된 tmux AI 칸이 현재 자원이나 배지에 포함됩니다: ${JSON.stringify(tmuxProjection)}`);
  const nativeEnvironment = await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const previous = app.state.platform;
    app.state.platform = { id: 'darwin', label: 'macOS', nativeTmux: true };
    app.renderTmuxMap();
    const result = {
      statLabel: document.querySelector('#tmuxStats > div:first-child span')?.textContent.trim() || '',
      environment: document.querySelector('.tmux-distro-node > span')?.textContent.trim() || '',
    };
    app.state.platform = previous;
    app.renderTmuxMap();
    return result;
  })()`);
  assert(nativeEnvironment.statLabel === '실행 환경' && nativeEnvironment.environment === 'macOS', `macOS 네이티브 tmux 환경 표시가 올바르지 않습니다: ${JSON.stringify(nativeEnvironment)}`);
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
  await click(win, '#tmuxBreadcrumbs [data-tmux-reset]', 'tmux:reset');
  await waitFor(win, `window.LoadToAgentApp.state.tmuxFocus === null`, 'tmux 이동 경로 전체 목록 복귀 실패');
  const collapsedSubagents = await win.webContents.executeJavaScript(`(() => ({
    count: document.querySelectorAll('[data-tmux-subagent-id]').length,
    hidden: document.querySelector('[data-tmux-subagents="tmux-pane-id"] .tmux-subagent-list')?.classList.contains('hidden'),
    expanded: document.querySelector('[data-tmux-subagents-toggle="tmux-pane-id"]')?.getAttribute('aria-expanded'),
  }))()`);
  assert(
    collapsedSubagents.count === 3 && collapsedSubagents.hidden && collapsedSubagents.expanded === 'false',
    `tmux 도움 AI 목록의 기본 접힘 상태가 올바르지 않습니다: ${JSON.stringify(collapsedSubagents)}`,
  );
  await click(win, '[data-tmux-subagents-toggle="tmux-pane-id"]', 'tmux:subagents-toggle');
  await waitFor(win, `document.querySelector('[data-tmux-subagents-toggle="tmux-pane-id"]')?.getAttribute('aria-expanded') === 'true' && !document.querySelector('[data-tmux-subagents="tmux-pane-id"] .tmux-subagent-list').classList.contains('hidden')`, 'tmux 도움 AI 목록 펼치기 실패');
  await win.webContents.executeJavaScript(`window.LoadToAgentApp.renderTmuxMap()`);
  await waitFor(win, `document.querySelector('[data-tmux-subagents-toggle="tmux-pane-id"]')?.getAttribute('aria-expanded') === 'true' && document.querySelectorAll('[data-tmux-subagent-id]').length === 3`, 'tmux 갱신 뒤 도움 AI 펼침 상태가 유지되지 않았습니다.');
  await click(win, '[data-tmux-subagent-id="fixture-child"] [data-open-subagent-chat]', 'subagent:open-conversation');
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && window.LoadToAgentApp.state.drawerMode === 'subagent' && window.LoadToAgentApp.state.selectedId === 'fixture-child'`, 'tmux 도움 AI 대화 열기 실패');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `document.querySelector('#drawerBackdrop').classList.contains('hidden')`, 'tmux 도움 AI 대화 닫기 실패');
  round.observed.tmuxSubagents = { count: 3, expansionPersists: true, conversationOpens: true };
  await clearCalls(win);
  await click(win, '[data-tmux-distro="FixtureLinux"][data-tmux-pane="%7"]', 'tmux:select-resource');
  await waitFor(win, `!document.querySelector('#terminalTmuxTools').classList.contains('hidden')`, 'tmux resource 목록 선택 실패');
  await waitFor(win, `(() => { const screen = document.querySelector('[data-terminal-screen="__tmux_remote__"]:not(.hidden)'); return window.interactionTest.getCalls().some(item => item.name === 'tmuxCapture') && Number(screen?.dataset.baseY) > 0 && Number(screen?.dataset.viewportY) === 0; })()`, 'tmux 첫 화면이 첫 줄에서 시작하지 않습니다.', 160);
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

  for (const selector of ['.tmux-distro-node', '.tmux-session-node', '.tmux-window-node', '.tmux-pane-main']) {
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
  await click(win, '#tmuxCreateModal', 'tmux:modal-backdrop');
  await waitFor(win, `document.querySelector('#tmuxCreateModal').classList.contains('hidden')`, 'tmux 생성 배경 닫기 실패');

  await click(win, '#newTmuxSessionBtn', 'tmux:modal-open');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#tmuxCreateDistro').value = 'FixtureLinux';
    document.querySelector('#tmuxCreateName').value = 'fixture round ${round.index}';
    document.querySelector('#tmuxCreateCommand').value = 'claude';
  })()`);
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
  mark('tmux:layout');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'tmuxSelectLayout')`, 'tmux layout 변경 호출 실패');

  await openTmuxControl(win);
  await verifyOneCall(win, 'tmux:kill-pane', '[data-tmux-manage="kill-pane"]', 'tmuxKillPane');
  await sleep(80);

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

  await openTmuxControl(win);
  await verifyOneCall(win, 'tmux:kill-session', '[data-tmux-manage="kill-session"]', 'tmuxKillSession');
  await sleep(80);
  await openTmuxControl(win);
  await clearCalls(win);
  await click(win, '#terminalAttachBtn', 'terminal:attach');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate') && !document.querySelector('#terminalCloseBtn').disabled`, 'tmux 직접 조작 attach 실패');
  await clearCalls(win);
  await click(win, '#terminalCloseBtn', 'terminal:close');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalClose')`, 'attach된 tmux 터미널 종료 실패');
  round.observed.tmuxManagement = 8;
}

async function runRound(win, index) {
  if (index > 1) {
    await win.reload();
  }
  await waitFor(win, `Boolean(window.loadtoagent && window.interactionTest && window.LoadToAgentTerminal && window.LoadToAgentApp.state.snapshot && document.querySelector('#newRunBtn'))`, 'renderer 초기화 실패', 160);
  await installPageGuards(win);
  await recordManifest(win);
  const round = { index, passed: [], failed: [], observed: {} };
  rounds.push(round);
  await step(round, 'guide-mobile-tools', () => exerciseGuideAndMobileTools(win, round));
  await step(round, 'navigation', () => exerciseNavigation(win, round));
  await step(round, 'quality-enhancements', () => exerciseQualityEnhancements(win, round));
  await step(round, 'tab-data-routing', () => exerciseTabDataRouting(win, round));
  await step(round, 'language-settings', () => exerciseLanguageSettings(win, round));
  await step(round, 'provider-visibility', () => exerciseProviderVisibility(win, round));
  await step(round, 'updates', () => exerciseUpdates(win, round));
  await step(round, 'attention-notification', () => exerciseAttentionNotification(win, round));
  await step(round, 'management-controls', () => exerciseManagementControls(win, round));
  await step(round, 'dashboard-controls', () => exerciseDashboardControls(win, round));
  await step(round, 'runtime-overview', () => exerciseRuntimeOverview(win, round));
  await step(round, 'new-run-modal', () => exerciseRunModal(win, round));
  await step(round, 'drawer', () => exerciseDrawer(win, round));
  await step(round, 'graph', () => exerciseGraph(win, round));
  await step(round, 'agent-controls', () => exerciseAgentControls(win, round));
  await step(round, 'terminal', () => exerciseTerminal(win, round));
  await step(round, 'tmux', () => exerciseTmux(win, round));
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
      'run:provider-keyboard', 'run:workspace-keyboard', 'terminal:create-single-flight',
      'mobile:keyboard-roaming', 'mobile:outside-dismiss', 'mobile:shortcut-guard', 'filter:keyboard-roaming', 'run:submit-close-guard', 'terminal:keyboard-roaming',
      'settings:provider-visibility-rollback',
      'quality:quick-keyboard', 'quality:quick-empty', 'quality:dashboard-storage',
      'quality:runtime-schedule-keyboard', 'quality:runtime-loop-keyboard', 'quality:run-draft-restore',
      'quality:run-whitespace-validation', 'quality:run-safe-backdrop', 'quality:drawer-page-tabs',
      'quality:terminal-restart-busy', 'quality:terminal-command-history', 'quality:terminal-length-warning',
      'quality:terminal-close-busy', 'quality:tmux-map-keyboard', 'quality:tmux-breadcrumb-keyboard', 'quality:tmux-safe-backdrop',
      'quality:drawer-drag-safe',
    ])];
    for (const action of required) {
      const count = Number(coverage.get(action) || 0);
      if (count < ROUND_COUNT) failures.push(`coverage · ${action}: ${count}/${ROUND_COUNT} rounds`);
    }
    for (const entry of ACTION_MANIFEST) if (!manifestSeen.has(entry.selector)) failures.push(`manifest unseen · ${entry.selector}`);
    for (const html of manifestUnknown) failures.push(`manifest unknown · ${html}`);
    const report = {
      ok: failures.length === 0,
      rounds,
      coverage: Object.fromEntries([...coverage.entries()].sort(([a], [b]) => a.localeCompare(b))),
      selectorManifest: {
        total: ACTION_MANIFEST.length,
        seen: manifestSeen.size,
        uncovered: ACTION_MANIFEST.filter(entry => !manifestSeen.has(entry.selector)).map(entry => entry.selector),
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
