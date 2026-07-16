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
const manifestSeen = new Set();
const manifestUnknown = new Set();
let expectedTerminalFirstAfterReload = '';

const ACTION_MANIFEST = [
  ...['all', 'active', 'waiting', 'terminal', 'tmux', 'settings'].map(view => ({ selector: `[data-view="${view}"]`, action: `nav:${view}` })),
  { selector: '#guideBtn', action: 'guide:toggle' },
  { selector: '#dismissGuideBtn', action: 'guide:dismiss' },
  { selector: '[data-guide-action]', action: 'guide:step' },
  { selector: '#mobileMoreBtn', action: 'mobile:more' },
  { selector: '[data-mobile-view]', action: 'mobile:view' },
  { selector: '#updateNoticeBtn', action: 'update:notice-open' },
  { selector: '#checkUpdateBtn', action: 'update:check' },
  { selector: '#installUpdateBtn', action: 'update:download' },
  { selector: '#openReleaseBtn', action: 'update:release-open' },
  { selector: '#languageSelect', action: 'settings:language' },
  { selector: '#probeBtn', action: 'dashboard:probe' },
  { selector: '#addWorkspaceBtn', action: 'workspace:add' },
  { selector: '#newRunBtn', action: 'run:open' },
  { selector: '#newPowerShellBtn', action: 'terminal:create-windows' },
  { selector: '#newWslBtn', action: 'terminal:create-linux' },
  { selector: '[data-terminal-signal="interrupt"]', action: 'terminal:signal-interrupt' },
  { selector: '[data-terminal-signal="clear"]', action: 'terminal:signal-clear' },
  { selector: '#terminalRestartBtn', action: 'terminal:restart' },
  { selector: '#terminalAttachBtn', action: 'terminal:attach' },
  { selector: '#terminalCloseBtn', action: 'terminal:close' },
  { selector: '#terminalHistoryToggle', action: 'terminal:history-collapse' },
  { selector: '#terminalCommandForm', action: 'terminal:failure-submit' },
  { selector: '#terminalCommandForm button[type="submit"]', action: 'terminal:failure-submit' },
  { selector: '[data-terminal-id]', action: 'terminal:select-session' },
  { selector: '[data-session-move]', action: 'terminal:reorder-button' },
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
  { selector: '[data-provider-filter]', action: 'filter:provider' },
  { selector: '#sortSelect', action: 'filter:sort' },
  { selector: '#loadMoreBtn', action: 'filter:load-more' },
  { selector: '[data-open-run]', action: 'run:open-empty' },
  { selector: '#closeDrawerBtn', action: 'drawer:close' },
  ...['chat', 'lifecycle', 'tokens'].map(tab => ({ selector: `[data-tab="${tab}"]`, action: `drawer:tab-${tab}` })),
  { selector: '[data-scroll-latest]', action: 'drawer:latest' },
  { selector: '[data-retry-detail]', action: 'drawer:retry' },
  { selector: '[data-stop-run]', action: 'drawer:stop-double' },
  { selector: '#runForm', action: 'run:submit' },
  { selector: '#closeRunModalBtn', action: 'run:close-x' },
  { selector: '#pickRunCwdBtn', action: 'run:pick-cwd' },
  { selector: '#allowWrites', action: 'run:allow-writes' },
  { selector: '#cancelRunBtn', action: 'run:cancel' },
  { selector: '#runForm button[type="submit"]', action: 'run:submit' },
  { selector: '[data-run-provider]', action: 'run:provider' },
  { selector: '[data-provider-docs]', action: 'run:provider-docs' },
  { selector: '[data-provider-recheck]', action: 'run:provider-recheck' },
  { selector: '[data-run-prompt-example]', action: 'run:prompt-example' },
  { selector: '[data-run-workspace]', action: 'run:workspace-suggestion' },
  { selector: '#tmuxCreateForm', action: 'tmux:modal-submit' },
  { selector: '#tmuxCreateDistro', action: 'tmux:modal-submit' },
  { selector: '#closeTmuxCreateBtn', action: 'tmux:modal-close-x' },
  { selector: '#cancelTmuxCreateBtn', action: 'tmux:modal-cancel' },
  { selector: '#tmuxCreateForm button[type="submit"]', action: 'tmux:modal-submit' },
  { selector: '[data-provider-card]', action: 'filter:provider-card' },
  { selector: '[data-workspace]', action: 'workspace:select' },
  { selector: '[data-remove-workspace]', action: 'workspace:remove' },
  { selector: '[data-session-id]', action: 'drawer:open-card' },
  { selector: '[data-graph-focus]', action: 'graph:focus' },
  { selector: '[data-graph-provider-more]', action: 'graph:more' },
  { selector: '[data-graph-provider-less]', action: 'graph:less' },
  { selector: '[data-open-session]', action: 'drawer:open-graph' },
  { selector: '[data-agent-terminal-open]', action: 'terminal:open-from-agent' },
  { selector: '[data-agent-bridge-copy]', action: 'agent:bridge-copy' },
  { selector: '[data-agent-open-origin]', action: 'agent:open-origin' },
  { selector: '[data-agent-command-target]', action: 'agent:target-select' },
  { selector: '[data-agent-command-form]', action: 'agent:command-submit' },
  { selector: '[data-agent-command-form] button[type="submit"]', action: 'agent:command-submit' },
  { selector: '[data-subagent-completed-toggle]', action: 'subagent:toggle-completed' },
  { selector: '[data-open-subagent-chat]', action: 'subagent:open-conversation' },
  { selector: '[data-resume-agent]', action: 'subagent:resume-terminal' },
  { selector: '[data-control-tmux]', action: 'tmux:control-pane' },
  { selector: '[data-tmux-subagents-toggle]', action: 'tmux:subagents-toggle' },
  { selector: '[data-tmux-type][data-tmux-id]', action: 'tmux:focus-node' },
  { selector: '.live-tmux-overview-open', action: 'tmux:open-live-overview' },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mark = action => coverage.set(action, Number(coverage.get(action) || 0) + 1);

async function recordManifest(win) {
  const result = await win.webContents.executeJavaScript(`(() => {
    const selectors = ${JSON.stringify(ACTION_MANIFEST.map(item => item.selector))};
    const discovered = [...document.querySelectorAll('button, form, input[type="search"], input[type="checkbox"], select, [data-provider-card], [data-workspace], [data-session-id]')];
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
    window.addEventListener('error', event => window.__interactionErrors.push('error:' + (event.message || 'unknown')));
    window.addEventListener('unhandledrejection', event => window.__interactionErrors.push('rejection:' + String(event.reason && (event.reason.stack || event.reason.message) || event.reason)));
    window.confirm = () => true;
    window.prompt = message => String(message || '').includes('작업 묶음') ? 'fixture-renamed' : 'fixture-window';
  })()`);
}

async function exerciseNavigation(win, round) {
  let scrollResets = 0;
  for (const view of ['active', 'waiting', 'terminal', 'settings', 'all']) {
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
  round.observed.navigation = true;
  round.observed.navScrollResets = scrollResets;
}

async function exerciseGuideAndMobileTools(win, round) {
  await click(win, '[data-view="all"]', 'nav:all');
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
  await click(win, '#mobileMoreBtn', 'mobile:more');
  await waitFor(win, `!document.querySelector('#mobileToolsMenu').classList.contains('hidden')`, '모바일 더보기 메뉴 열기 실패');
  await click(win, '[data-mobile-view="settings"]', 'mobile:view');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'settings' && document.querySelector('#mobileToolsMenu').classList.contains('hidden')`, '모바일 더보기에서 설정 이동 실패');
  await click(win, '[data-view="all"]', 'nav:all');
  round.observed.guide = { persisted: true, mobileTools: true };
}

async function exerciseUpdates(win, round) {
  await win.webContents.executeJavaScript('window.interactionTest.restoreCurrentUpdate()');
  await click(win, '[data-view="settings"]', 'nav:settings');
  await waitFor(win, `window.LoadToAgentApp.state.update.status === 'current' && document.querySelector('#currentVersion').textContent === 'v1.0.0' && document.querySelector('#sidebarAppVersion').textContent === 'v1.0.0' && document.querySelector('#updateStateTitle').textContent === '현재 최신 버전입니다.' && document.querySelector('#checkUpdateBtn').textContent === '업데이트 확인'`, '현재 버전과 최신 상태가 설정 화면에 명확히 표시되지 않았습니다.');
  await clearCalls(win);
  await click(win, '#checkUpdateBtn', 'update:check');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'checkForUpdate') && window.LoadToAgentApp.state.update.status === 'available'`, '업데이트 확인 버튼이 최신 릴리스를 확인하지 않았습니다.');
  await click(win, '[data-view="all"]', 'nav:all');
  await waitFor(win, `window.LoadToAgentApp.state.update.status === 'available' && !document.querySelector('#updateNotice').classList.contains('hidden') && !document.querySelector('#navUpdateBadge').classList.contains('hidden')`, '새 버전 알림이 표시되지 않았습니다.');
  await click(win, '#updateNoticeBtn', 'update:notice-open');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'settings' && !document.querySelector('#settingsSection').classList.contains('hidden') && document.querySelector('#latestVersion').textContent === 'v1.1.0'`, '업데이트 알림이 설정 화면을 열지 못했습니다.');
  await clearCalls(win);
  await click(win, '#installUpdateBtn', 'update:download');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'downloadUpdate') && window.LoadToAgentApp.state.update.status === 'downloaded' && document.querySelector('#installUpdateBtn').textContent.includes('설치 파일 열기')`, '업데이트 파일 다운로드 완료 상태가 반영되지 않았습니다.');
  await clearCalls(win);
  await click(win, '#installUpdateBtn', 'update:open-installer');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'openDownloadedUpdate')`, '설치 파일 열기가 호출되지 않았습니다.');
  await clearCalls(win);
  await click(win, '#openReleaseBtn', 'update:release-open');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'openUpdateRelease')`, 'GitHub 릴리스 페이지 열기가 호출되지 않았습니다.');
  await click(win, '[data-view="all"]', 'nav:all');
  round.observed.update = { available: true, downloaded: true, installerOpened: true };
}

async function exerciseAttentionNotification(win, round) {
  await win.webContents.executeJavaScript(`window.interactionTest.triggerAttention('fixture-waiting')`);
  await waitFor(win, `window.LoadToAgentApp.state.view === 'waiting' && window.LoadToAgentApp.state.selectedId === 'fixture-waiting' && document.querySelector('#detailDrawer').classList.contains('open')`, '확인 필요 알림을 눌렀을 때 해당 세션이 열리지 않았습니다.');
  await click(win, '#closeDrawerBtn', 'drawer:close');
  await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, '확인 필요 알림 상세 창을 닫지 못했습니다.');
  await click(win, '[data-view="all"]', 'nav:all');
  round.observed.attentionNotification = { openedWaitingView: true, openedSession: 'fixture-waiting' };
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

async function exerciseDashboardControls(win, round) {
  await click(win, '[data-view="all"]', 'nav:all');
  const runtimeSplit = await win.webContents.executeJavaScript(`(() => ({
    segments: document.querySelectorAll('.runtime-segment').length,
    tmuxCards: document.querySelectorAll('.live-tmux-card').length,
    standardVisible: Boolean(document.querySelector('.standard-runtime')),
    tmuxVisible: Boolean(document.querySelector('.tmux-runtime')),
    detailFlowOpen: Boolean(document.querySelector('.runtime-disclosure')?.open),
    activeCount: Number(document.querySelector('.runtime-disclosure summary b')?.textContent.match(/\\d+/)?.[0] || 0),
    summaryCounts: [...document.querySelectorAll('#graphBreadcrumbs .map-hint b')].map((node) => Number(node.textContent)),
    summaryText: document.querySelector('.runtime-disclosure summary small')?.textContent || '',
  }))()`);
  assert(
    runtimeSplit.segments === 2
      && runtimeSplit.tmuxCards > 0
      && runtimeSplit.standardVisible
      && runtimeSplit.tmuxVisible
      && runtimeSplit.detailFlowOpen
      && runtimeSplit.summaryCounts.length === 4
      && runtimeSplit.tmuxCards === 2
      && runtimeSplit.summaryCounts.join(',') === '9,2,1,3'
      && runtimeSplit.activeCount === 11
      && runtimeSplit.activeCount === runtimeSplit.summaryCounts[0] + runtimeSplit.summaryCounts[1]
      && runtimeSplit.summaryCounts[2] <= runtimeSplit.activeCount
      && runtimeSplit.summaryCounts[3] >= runtimeSplit.summaryCounts[2]
      && runtimeSplit.summaryText.includes(`일반 실행 AI ${runtimeSplit.summaryCounts[0]}개와 TMUX AI ${runtimeSplit.summaryCounts[1]}개를 합산했습니다.`)
      && runtimeSplit.summaryText.includes(`작업 중 도움 AI ${runtimeSplit.summaryCounts[2]}개는 이 수에 포함됩니다.`),
    `진행 중 실행 방식 분리 UI가 올바르지 않습니다: ${JSON.stringify(runtimeSplit)}`,
  );
  await click(win, '.live-tmux-overview-open', 'tmux:open-live-overview');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'tmux' && !document.querySelector('#tmuxSection').classList.contains('hidden')`, '진행 중 화면에서 TMUX 전체 화면으로 이동하지 못했습니다.');
  await click(win, '[data-view="all"]', 'nav:all');
  round.observed.runtimeSplit = runtimeSplit;
  await clearCalls(win);
  await click(win, '#probeBtn', 'dashboard:probe');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'probeProviders')`, 'AI 연결 상태 새로고침이 호출되지 않았습니다.');
  await clearCalls(win);
  await click(win, '#addWorkspaceBtn', 'workspace:add');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'addWorkspaces')`, 'workspace 추가가 호출되지 않았습니다.');
  await waitFor(win, `Boolean(document.querySelector('[data-workspace="__projectless__"]')) && document.querySelector('[data-workspace="__projectless__"] small')?.textContent === '1'`, '프로젝트 없는 세션 필터와 개수가 표시되지 않았습니다.');
  await click(win, '[data-workspace="__projectless__"]', 'workspace:select-projectless');
  await waitFor(win, `window.LoadToAgentApp.state.workspace === '__projectless__' && document.querySelectorAll('#sessionGrid [data-session-id]').length === 1 && document.querySelector('[data-session-id="fixture-projectless"] .card-subtitle')?.textContent.includes('프로젝트 없음')`, '프로젝트 없는 세션만 필터되지 않았습니다.');
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

  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#searchInput'); input.value = '지난 작업 34'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  mark('filter:search');
  await waitFor(win, `window.LoadToAgentApp.state.search === '지난 작업 34' && document.querySelectorAll('#sessionGrid [data-session-id]').length === 1`, '검색 필터가 결과를 좁히지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#searchInput'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(win, `window.LoadToAgentApp.state.search === ''`, '검색 초기화 실패');

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

  const more = await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-graph-provider-more="claude"]'))`);
  assert(more, 'graph 더보기 fixture가 없습니다.');
  await click(win, '[data-graph-provider-more="claude"]', 'graph:more');
  await click(win, '[data-graph-provider-less="claude"]', 'graph:less');

  await click(win, '[data-open-run]', 'run:open-empty');
  await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden')`, 'empty-window.LoadToAgentApp.state 새 작업 버튼이 모달을 열지 못했습니다.');
  await click(win, '#closeRunModalBtn', 'run:close-x');
  await waitFor(win, `document.querySelector('#runModal').classList.contains('hidden')`, 'empty-window.LoadToAgentApp.state 모달 닫기 실패');
  round.observed.dashboardControls = true;
}

async function exerciseRunModal(win, round) {
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
  await click(win, '[data-run-prompt-example]', 'run:prompt-example');
  await waitFor(win, `document.querySelector('#runPrompt').value.length > 0 && document.querySelector('#runPromptCount').textContent !== '0 / 8,000'`, '빠른 요청 예시가 입력과 글자 수에 반영되지 않았습니다.');
  await click(win, '[data-run-workspace]', 'run:workspace-suggestion');
  await waitFor(win, `document.querySelector('[data-run-workspace]').classList.contains('selected') && document.querySelector('#runCwd').value === 'D:\\\\fixture'`, '최근 작업 폴더 선택이 입력에 반영되지 않았습니다.');
  await click(win, '[data-run-provider="gpt"]', 'run:provider');
  await waitFor(win, `document.querySelector('[data-run-provider="gpt"]').getAttribute('aria-pressed') === 'true' && document.querySelector('#runSubmitLabel').textContent.includes('GPT')`, 'AI 선택이 실행 버튼에 반영되지 않았습니다.');

  await win.webContents.executeJavaScript(`(() => { document.querySelector('#runCwd').value = ''; document.querySelector('#runPrompt').value = ''; document.querySelector('#runPrompt').dispatchEvent(new Event('input', { bubbles: true })); window.interactionTest.clearCalls(); })()`);
  await win.webContents.executeJavaScript(`document.querySelector('#runPrompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))`);
  mark('run:keyboard-submit');
  const nativeInvalid = await win.webContents.executeJavaScript(`(() => ({ calls: window.interactionTest.getCalls().filter(item => item.name === 'runAgent').length, cwd: document.querySelector('#runCwd').matches(':invalid'), prompt: document.querySelector('#runPrompt').matches(':invalid'), visible: !document.querySelector('#runModal').classList.contains('hidden') }))()`);
  assert(nativeInvalid.calls === 0 && nativeInvalid.cwd && nativeInvalid.prompt && nativeInvalid.visible, `필수 필드 검증이 submit을 막지 못했습니다: ${JSON.stringify(nativeInvalid)}`);
  mark('run:required-validation');

  await win.webContents.executeJavaScript(`(() => {
    window.interactionTest.configure({ failures: { runAgent: 1 } });
    document.querySelector('#runCwd').value = 'D:\\\\failed-fixture';
    document.querySelector('#runModel').value = 'failure-model';
    document.querySelector('#runPrompt').value = '실패해도 보존할 요청';
  })()`);
  await click(win, '#runForm button[type="submit"]', 'run:submit');
  await waitFor(win, `!document.querySelector('#runError').classList.contains('hidden')`, 'runAgent 실패 오류가 표시되지 않았습니다.');
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
  for (const tab of ['lifecycle', 'tokens', 'chat']) {
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
  await waitFor(win, `window.LoadToAgentApp.state.drawerTab === 'chat' && document.activeElement?.dataset.tab === 'chat'`, 'drawer Home 키보드 이동 실패');
  mark('drawer:tabs-keyboard');
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
  await focusRoot(win);
  const goalSummary = await win.webContents.executeJavaScript(`(() => {
    const goal = document.querySelector('.agent-workflow-selected .agent-task');
    const breadcrumb = document.querySelector('#graphBreadcrumbs .current');
    return { text: goal?.textContent || '', full: goal?.title || '', note: Boolean(document.querySelector('.agent-workflow-selected .agent-goal-note')), breadcrumbText: breadcrumb?.textContent || '', breadcrumbFull: breadcrumb?.title || '' };
  })()`);
  assert(goalSummary.note && goalSummary.text.endsWith('…') && goalSummary.full.length > goalSummary.text.length && goalSummary.breadcrumbText.endsWith('…') && goalSummary.breadcrumbFull.length > goalSummary.breadcrumbText.length, `긴 지금 목표가 읽기 좋은 요약으로 표시되지 않았습니다: ${JSON.stringify(goalSummary)}`);
  fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
  await sleep(120);
  fs.writeFileSync(path.join(__dirname, '..', 'artifacts', 'loadtoagent-readable-goal.png'), (await win.webContents.capturePage()).toPNG());
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
  await click(win, '[data-graph-provider-more="claude"]', 'graph:more');
  await click(win, '[data-graph-provider-less="claude"]', 'graph:less');

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

  await resetGraphToOverview(win);
  await focusRoot(win);
  await click(win, '[data-graph-focus="fixture-child"]', 'graph:focus');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-child' && document.querySelector('[data-agent-bridge-copy]')`, '연결 명령 UI가 표시되지 않았습니다.');
  await clearCalls(win);
  await click(win, '[data-agent-bridge-copy]', 'agent:bridge-copy');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'writeClipboard')`, '연결 명령 복사가 clipboard API를 호출하지 않았습니다.');

  await resetGraphToOverview(win);
  await click(win, '[data-graph-focus="fixture-live-0"]', 'graph:focus');
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-live-0' && document.querySelector('.agent-command-panel.control-handoff textarea:not([disabled])')`, '외부 CLI 세션 이어받기 UI가 표시되지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-agent-command-draft="fixture-live-0"]');
    input.value = 'HANDOFF_EXISTING_SESSION';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
  })()`);
  mark('agent:handoff-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate' && item.args[0].provider === 'claude' && item.args[0].args.join(' ') === '--resume fixture-live-0-external HANDOFF_EXISTING_SESSION')`, '실행 중인 외부 CLI를 같은 세션 ID와 지시로 이어받지 못했습니다.');

  await click(win, '[data-view="all"]', 'nav:all');
  await resetGraphToOverview(win);
  await click(win, '[data-graph-focus="fixture-origin"]', 'graph:focus');
  await win.webContents.executeJavaScript(`(() => { const session = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === 'fixture-origin'); session.status = 'idle'; session.statusDetail = '다음 요청 대기'; window.LoadToAgentApp.renderSessions(); })()`);
  await waitFor(win, `window.LoadToAgentApp.state.graphFocusId === 'fixture-origin' && document.querySelector('.agent-command-panel.control-origin-resume textarea:not([disabled])') && document.querySelector('[data-agent-open-origin]')`, '쉬는 Codex 데스크톱 작업의 백그라운드 연결 UI가 표시되지 않았습니다.');
  await clearCalls(win);
  await click(win, '[data-agent-open-origin]', 'agent:open-origin');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'openSessionOrigin')`, '원래 Codex 작업 열기가 호출되지 않았습니다.');
  await clearCalls(win);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-agent-command-draft="fixture-origin"]');
    input.value = 'RESUME_DESKTOP_IN_BACKGROUND';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
  })()`);
  mark('agent:command-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate' && item.args[0].provider === 'codex' && item.args[0].bridgeId === 'fixture-origin' && item.args[0].args.join(' ') === 'resume fixture-origin-external RESUME_DESKTOP_IN_BACKGROUND')`, '쉬는 Codex 데스크톱 작업을 백그라운드 터미널로 이어받지 못했습니다.');
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
    && document.querySelector('#drawerContent').innerText.includes('상호작용 테스트를 진행해줘')
    && document.querySelector('#drawerContent').innerText.includes('버튼과 입력 동작을 확인하고 있습니다.')
    && !document.querySelector('#drawerContent').textContent.includes('gAAAA')
    && !document.querySelector('#drawerContent').innerText.includes('보호된 메시지')
    && !document.querySelector('#drawerContent').innerText.includes('내용 없이 통신 상태')
    && document.querySelector('.drawer-tab:not(.hidden)').textContent === '작업 내용'
    && document.querySelectorAll('.drawer-tab:not(.hidden)').length === 1
    && document.querySelector('[data-resume-agent="fixture-resting"]')`, '서브카드 클릭이 실제 서브에이전트 작업 기록을 열지 않았습니다.');
  await clearCalls(win);
  await click(win, '[data-resume-agent="fixture-resting"]', 'subagent:resume-terminal');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate' && item.args[0].type === 'agent' && item.args[0].provider === 'codex' && item.args[0].args.join(' ') === 'resume fixture-resting-external')`, '쉬는 Codex 서브에이전트가 정확한 세션 ID로 재개되지 않았습니다.');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'terminal' && !document.querySelector('#terminalCommandInput').disabled`, '재개한 서브에이전트 터미널이 입력 가능한 상태로 열리지 않았습니다.');
  round.observed.agentControlModes = ['direct', 'connect', 'handoff', 'origin', 'origin-resume', 'resume'];
  round.observed.subagentConversationOnly = true;
  round.observed.subagentCompletedDefault = 'hidden-until-expanded';
}

async function exerciseTerminal(win, round) {
  await click(win, '[data-view="terminal"]', 'nav:terminal');
  await waitFor(win, `Boolean(document.querySelector('[data-terminal-id="terminal-main"]'))`, '터미널 목록 로드 실패');
  const initialOrder = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#terminalSessionList [data-terminal-id]')].map(item => item.dataset.terminalId)`);
  if (round.index > 1) assert(initialOrder[0] === expectedTerminalFirstAfterReload, `저장된 터미널 순서가 재로드 후 복원되지 않았습니다: ${JSON.stringify(initialOrder)}`);
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
  mark('terminal:reorder');
  await click(win, `[data-session-move-id="${reordered.after[0]}"][data-session-move="1"]`, 'terminal:reorder-button');
  await waitFor(win, `JSON.stringify(${JSON.stringify(reordered.before)}) === JSON.stringify([...document.querySelectorAll('#terminalSessionList [data-terminal-id]')].map(item => item.dataset.terminalId))`, '터미널 위아래 버튼으로 세션 순서를 변경하지 못했습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const item = document.querySelector('#terminalSessionList [data-terminal-id]');
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  })()`);
  await waitFor(win, `document.querySelectorAll('#terminalSessionList [data-terminal-id]')[1]?.dataset.terminalId === ${JSON.stringify(reordered.before[0])}`, 'Alt+아래 키로 터미널 세션 순서를 변경하지 못했습니다.');
  await win.webContents.executeJavaScript(`document.querySelector('[data-terminal-id="${reordered.before[0]}"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(win, `JSON.stringify(${JSON.stringify(reordered.before)}) === JSON.stringify([...document.querySelectorAll('#terminalSessionList [data-terminal-id]')].map(item => item.dataset.terminalId))`, 'Alt+위 키로 터미널 세션 순서를 복원하지 못했습니다.');
  expectedTerminalFirstAfterReload = reordered.before.find(id => id !== 'terminal-main') || '';
  round.observed.terminalReorder = { drag: true, buttons: true, keyboard: true, persisted: round.index > 1 };
  await clearCalls(win);
  await click(win, '#newPowerShellBtn', 'terminal:create-windows');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate')`, 'Windows 터미널 생성 실패');
  await clearCalls(win);
  await click(win, '#newWslBtn', 'terminal:create-linux');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalCreate')`, 'Linux 터미널 생성 실패');
  await win.webContents.executeJavaScript(`window.interactionTest.configure({ failures: { terminalResize: 1 } })`);
  await click(win, '[data-terminal-id="terminal-ended"]', 'terminal:select-session');
  await waitFor(win, `!document.querySelector('#terminalRestartBtn').classList.contains('hidden')`, '종료 세션 다시 시작 버튼이 표시되지 않았습니다.');
  await clearCalls(win);
  await click(win, '#terminalRestartBtn', 'terminal:restart');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalRestart')`, '종료 세션 다시 시작 실패');
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  await click(win, '[data-terminal-id="terminal-main"]', 'terminal:select-session');

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

  await win.webContents.executeJavaScript(`window.interactionTest.clearControls(); window.interactionTest.clearCalls()`);
  await click(win, '#terminalCloseBtn', 'terminal:close');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'terminalClose')`, '세션 종료 버튼이 terminalClose를 호출하지 않았습니다.');
  await waitFor(win, `!document.querySelector('[data-terminal-id="terminal-main"]')`, '종료된 세션이 목록에서 제거되지 않았습니다.');
  assert(await callCount(win, 'terminalClose') === 1, '세션 종료 클릭 한 번에 terminalClose가 정확히 한 번 호출되어야 합니다.');
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
  await click(win, '[data-view="tmux"]', 'nav:tmux');
  await waitFor(win, `window.LoadToAgentApp.state.view === 'tmux' && document.querySelector('[data-control-tmux="tmux-pane-id"]')`, 'tmux 화면 로드 실패', 120);
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
  await win.webContents.executeJavaScript(`window.LoadToAgentTerminal.scrollTmuxToLine(${Math.max(1, Math.floor(initialScroll.maximum / 3))})`);
  await waitFor(win, `(() => { const screen = document.querySelector('[data-terminal-screen="__tmux_remote__"]'); const top = Number(screen.dataset.viewportY); return top > 0 && top < Number(screen.dataset.baseY); })()`, 'tmux 화면을 사용자가 중간 위치로 스크롤하지 못했습니다.');
  const scrollProbe = await win.webContents.executeJavaScript(`(() => { const screen = document.querySelector('[data-terminal-screen="__tmux_remote__"]'); return { before: Number(screen.dataset.viewportY), maximum: Number(screen.dataset.baseY) }; })()`);
  const captureRevisionBeforeRefresh = await win.webContents.executeJavaScript(`Number(document.querySelector('[data-terminal-screen="__tmux_remote__"]').dataset.captureRevision || 0)`);
  const captureCountBeforeRefresh = await callCount(win, 'tmuxCapture');
  await waitFor(win, `window.interactionTest.getCalls().filter(item => item.name === 'tmuxCapture').length > ${captureCountBeforeRefresh}`, 'tmux 반복 캡처가 실행되지 않았습니다.', 160);
  await waitFor(win, `Number(document.querySelector('[data-terminal-screen="__tmux_remote__"]').dataset.captureRevision || 0) > ${captureRevisionBeforeRefresh}`, 'tmux 반복 캡처 출력이 화면에 적용되지 않았습니다.', 160);
  await waitFor(win, `(() => { const screen = document.querySelector('[data-terminal-screen="__tmux_remote__"]'); return Math.abs(Number(screen.dataset.viewportY) - ${scrollProbe.before}) <= 1; })()`, 'tmux 반복 캡처 완료 후 사용자 스크롤 위치가 복원되지 않았습니다.', 160);
  const scrollAfter = await win.webContents.executeJavaScript(`(() => { const screen = document.querySelector('[data-terminal-screen="__tmux_remote__"]'); return { top: Number(screen.dataset.viewportY), maximum: Number(screen.dataset.baseY) }; })()`);
  assert(scrollAfter.top < scrollAfter.maximum && Math.abs(scrollAfter.top - scrollProbe.before) <= 1, `tmux 갱신이 사용자의 스크롤 위치를 덮어썼습니다: ${JSON.stringify({ scrollProbe, scrollAfter })}`);
  mark('tmux:scroll-preserve');
  round.observed.tmuxScroll = { startsAtTop: true, preservesUserPosition: true };

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
  await click(win, '#closeTmuxCreateBtn', 'tmux:modal-close-x');
  await waitFor(win, `document.querySelector('#tmuxCreateModal').classList.contains('hidden')`, 'tmux 생성 X 닫기 실패');
  await click(win, '#newTmuxSessionBtn', 'tmux:modal-open');
  await click(win, '#cancelTmuxCreateBtn', 'tmux:modal-cancel');
  await waitFor(win, `document.querySelector('#tmuxCreateModal').classList.contains('hidden')`, 'tmux 생성 취소 실패');
  await click(win, '#newTmuxSessionBtn', 'tmux:modal-open');
  await click(win, '#tmuxCreateModal', 'tmux:modal-backdrop');
  await waitFor(win, `document.querySelector('#tmuxCreateModal').classList.contains('hidden')`, 'tmux 생성 배경 닫기 실패');

  await click(win, '#newTmuxSessionBtn', 'tmux:modal-open');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#tmuxCreateDistro').value = 'FixtureLinux';
    document.querySelector('#tmuxCreateName').value = 'fixture-round-${round.index}';
    document.querySelector('#tmuxCreateCwd').value = '/tmp/fixture';
    document.querySelector('#tmuxCreateCommand').value = 'claude';
  })()`);
  await clearCalls(win);
  await click(win, '#tmuxCreateForm button[type="submit"]', 'tmux:modal-submit');
  await waitFor(win, `window.interactionTest.getCalls().some(item => item.name === 'tmuxNewSession')`, 'tmuxNewSession 호출 실패');
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
  await step(round, 'language-settings', () => exerciseLanguageSettings(win, round));
  await step(round, 'updates', () => exerciseUpdates(win, round));
  await step(round, 'attention-notification', () => exerciseAttentionNotification(win, round));
  await step(round, 'dashboard-controls', () => exerciseDashboardControls(win, round));
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
    for (let index = 1; index <= 3; index += 1) await runRound(win, index);
    const required = [...new Set([
      ...ACTION_MANIFEST.map(item => item.action),
      'nav:scroll-reset', 'guide:wheel-closed', 'run:required-validation', 'run:failure-preserve', 'run:backdrop',
      'drawer:tabs-keyboard', 'drawer:backdrop', 'terminal:ime-enter', 'terminal:duplicate-enter', 'terminal:history-expand',
      'drawer:close-scroll', 'terminal:reorder', 'tmux:scroll-preserve', 'tmux:kill-window-wheel-closed',
    ])];
    for (const action of required) {
      const count = Number(coverage.get(action) || 0);
      if (count < 3) failures.push(`coverage · ${action}: ${count}/3 rounds`);
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
