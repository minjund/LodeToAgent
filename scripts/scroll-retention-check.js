'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-scroll-retention-'));
app.setPath('userData', userData);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(win, expression, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await wait(50);
  }
  throw new Error(message);
}

async function auditWheelControls(win, label) {
  const result = await win.webContents.executeJavaScript(`(() => {
    window.__wheelAuditedControls ||= new Set();
    const identity = element => {
      if (element.id) return '#' + element.id;
      const attributes = [...element.attributes]
        .filter(attribute => attribute.name.startsWith('data-') && !/^data-(?:i18n|motion|quality)/.test(attribute.name))
        .map(attribute => '[' + attribute.name + '=' + JSON.stringify(attribute.value) + ']')
        .sort()
        .join('');
      const text = String(element.getAttribute('aria-label') || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      return element.tagName.toLowerCase() + attributes + ':' + text;
    };
    const state = () => JSON.stringify({
      view: window.WhiteboxApp.state.view,
      selectedId: window.WhiteboxApp.state.selectedId,
      drawerTab: window.WhiteboxApp.state.drawerTab,
      overlays: ['#runModal', '#tmuxCreateModal', '#quickPaletteModal', '#shortcutHelpModal', '#drawerBackdrop', '#mobileToolsMenu', '#beginnerGuide']
        .map(selector => { const element = document.querySelector(selector); return [selector, Boolean(element?.classList.contains('hidden')), Boolean(element?.classList.contains('open'))]; }),
      details: [...document.querySelectorAll('details')].map((element, index) => [element.dataset.disclosureKey || element.className || index, element.open]),
      expanded: [...document.querySelectorAll('[aria-expanded]')].map(element => [identity(element), element.getAttribute('aria-expanded')]),
      checked: [...document.querySelectorAll('input[type="checkbox"]')].map(element => [identity(element), element.checked]),
      selected: [...document.querySelectorAll('select')].map(element => [identity(element), element.value]),
    });
    const controls = [...document.querySelectorAll('button, summary, select, input[type="checkbox"], [role="button"], [data-session-id], [data-provider-card], [data-workspace]')]
      .filter(element => !element.disabled && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const failures = [];
    let checked = 0;
    for (const control of controls) {
      const key = identity(control);
      if (window.__wheelAuditedControls.has(key)) continue;
      const before = state();
      control.dispatchEvent(new WheelEvent('wheel', { deltaY: 180, bubbles: true, cancelable: true }));
      const after = state();
      if (after !== before) failures.push({ key, before, after });
      window.__wheelAuditedControls.add(key);
      checked += 1;
    }
    return { label: ${JSON.stringify(label)}, checked, total: window.__wheelAuditedControls.size, failures };
  })()`);
  if (result.failures.length) throw new Error(`휠이 UI 열림·선택 상태를 변경했습니다: ${JSON.stringify(result)}`);
  return result;
}

async function checkMainViews(win) {
  const results = [];
  for (const view of ['all', 'active', 'waiting', 'runtime', 'terminal', 'tmux', 'settings']) {
    await win.webContents.executeJavaScript(`window.WhiteboxApp.selectView(${JSON.stringify(view)})`);
    await wait(250);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const stage = document.querySelector('.main-stage');
      let spacer = document.querySelector('#scrollRetentionSpacer');
      if (!spacer) {
        spacer = document.createElement('div');
        spacer.id = 'scrollRetentionSpacer';
        spacer.style.cssText = 'height:2400px;pointer-events:none;';
        stage.appendChild(spacer);
      }
      const target = Math.min(420, stage.scrollHeight - stage.clientHeight - 20);
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 420, bubbles: true, cancelable: true }));
      stage.scrollTop = target;
      const focusTarget = document.querySelector('.main-stage section:not(.hidden) button:not([disabled]), .main-stage section:not(.hidden) input:not([disabled])');
      focusTarget?.focus({ preventScroll: true });
      window.interactionTest.emitSnapshot();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise(resolve => setTimeout(resolve, 120));
      return { view: ${JSON.stringify(view)}, target, top: stage.scrollTop, maximum: stage.scrollHeight - stage.clientHeight };
    })()`);
    if (result.target < 1 || Math.abs(result.top - result.target) > 2 || result.top >= result.maximum - 2) {
      throw new Error(`메인 화면 스크롤 유지 실패: ${JSON.stringify(result)}`);
    }
    await auditWheelControls(win, `main:${view}`);
    results.push(result);
  }
  return results;
}

async function checkDisclosureStates(win) {
  await win.webContents.executeJavaScript(`(() => {
    const app = window.WhiteboxApp;
    app.state.workspace = app.state.workspaces[0]?.path || 'all';
    app.selectView('all');
  })()`);
  await waitFor(win, `Boolean(document.querySelector('details.control-room-project-group[data-disclosure-key^="control-project:"]'))`, '홈 프로젝트 실행 그룹이 없습니다.');
  const runtime = [];
  for (const expected of [false, true]) {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const details = document.querySelector('details.control-room-project-group[data-disclosure-key^="control-project:"]');
      details.open = ${expected};
      details.querySelector('summary').dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }));
      window.interactionTest.emitSnapshot();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return document.querySelector('details.control-room-project-group[data-disclosure-key^="control-project:"]')?.open;
    })()`);
    if (result !== expected) throw new Error(`홈 프로젝트 실행 그룹의 ${expected ? '열림' : '닫힘'} 상태가 자동 갱신으로 뒤집혔습니다.`);
    runtime.push(result);
  }

  await win.webContents.executeJavaScript(`window.WhiteboxApp.openRunModal()`);
  await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden')`, '고급 설정 상태 검사용 새 작업 창이 열리지 않았습니다.');
  const advanced = [];
  for (const expected of [true, false]) {
    await win.webContents.executeJavaScript(`(() => {
      const details = document.querySelector('.run-advanced');
      details.open = ${expected};
      details.dispatchEvent(new Event('toggle'));
      details.querySelector('summary').dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }));
      window.WhiteboxApp.closeRunModal(true);
    })()`);
    await wait(300);
    await win.webContents.executeJavaScript(`window.WhiteboxApp.openRunModal()`);
    await wait(30);
    const actual = await win.webContents.executeJavaScript(`document.querySelector('.run-advanced').open`);
    if (actual !== expected) throw new Error(`새 작업 고급 설정의 ${expected ? '열림' : '닫힘'} 상태가 다시 열 때 뒤집혔습니다.`);
    advanced.push(actual);
  }
  await auditWheelControls(win, 'run-modal');
  await win.webContents.executeJavaScript(`window.WhiteboxApp.closeRunModal(true)`);
  await wait(300);
  return { runtime, advanced };
}

async function checkDrawer(win) {
  await win.webContents.executeJavaScript(`window.WhiteboxApp.selectView('all'); window.WhiteboxApp.openDrawer('fixture-ended')`);
  await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open') && !document.querySelector('.drawer-loading')`, '상세 대화가 열리지 않았습니다.');
  await win.webContents.executeJavaScript(`window.WhiteboxApp.state.drawerTab = 'chat'; window.WhiteboxApp.renderDrawer()`);
  await waitFor(win, `Boolean(document.querySelector('.chat-roadmap'))`, '상세 대화 탭의 펼침 영역이 준비되지 않았습니다.');
  const before = await win.webContents.executeJavaScript(`(() => {
    const content = document.querySelector('#drawerContent');
    content.style.height = '180px';
    content.style.maxHeight = '180px';
    content.style.flex = '0 0 180px';
    const maximum = content.scrollHeight - content.clientHeight;
    content.scrollTop = Math.max(1, maximum - 40);
    return { top: content.scrollTop, maximum };
  })()`);
  if (before.maximum <= 50) throw new Error(`상세 대화 스크롤 검사용 콘텐츠가 부족합니다: ${JSON.stringify(before)}`);
  const disclosures = await win.webContents.executeJavaScript(`(async () => {
    const app = window.WhiteboxApp;
    const detail = app.state.details.get('fixture-ended');
    detail.messages = [...detail.messages, { id: 'wheel-tool', role: 'tool', title: '검사 도구', text: '휠 상태 검사', timestamp: new Date().toISOString() }];
    app.renderDrawer();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const results = {};
    for (const [name, selector] of Object.entries({ roadmap: '.chat-roadmap' })) {
      for (const expected of [true, false]) {
        let details = document.querySelector(selector);
        details.open = expected;
        details.querySelector('summary').dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }));
        window.interactionTest.emitSnapshot();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        details = document.querySelector(selector);
        results[name + ':' + expected] = details?.open;
      }
    }
    results.toolActivityVisible = Boolean(document.querySelector('.chat-activities:not(.subagent-coordination)'))
      || document.querySelector('#drawerContent').innerText.includes('휠 상태 검사');
    results.settledTop = document.querySelector('#drawerContent').scrollTop;
    return results;
  })()`);
  if (!disclosures['roadmap:true'] || disclosures['roadmap:false'] || disclosures.toolActivityVisible) {
    throw new Error(`최근 대화의 펼침 상태가 갱신 뒤 유지되지 않았습니다: ${JSON.stringify(disclosures)}`);
  }
  await auditWheelControls(win, 'recent-drawer');
  await win.webContents.executeJavaScript(`window.interactionTest.emitSnapshot()`);
  await wait(180);
  const after = await win.webContents.executeJavaScript(`(() => { const content = document.querySelector('#drawerContent'); return { top: content.scrollTop, maximum: content.scrollHeight - content.clientHeight }; })()`);
  if (Math.abs(after.top - disclosures.settledTop) > 2) throw new Error(`상세 대화가 사용자 휠 위치를 버렸습니다: ${JSON.stringify({ before, settledTop: disclosures.settledTop, after })}`);
  return { before, after, disclosures };
}

async function checkSubagentDisclosure(win) {
  await win.webContents.executeJavaScript(`window.WhiteboxApp.openSubagentConversation('fixture-resting')`);
  await waitFor(win, `Boolean(document.querySelector('.subagent-coordination')) && !document.querySelector('.drawer-loading')`, '서브에이전트 통신 상세가 열리지 않았습니다.');
  const states = [];
  for (const expected of [true, false]) {
    const actual = await win.webContents.executeJavaScript(`(async () => {
      let details = document.querySelector('.subagent-coordination');
      details.open = ${expected};
      details.querySelector('summary').dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }));
      window.interactionTest.emitSnapshot();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      details = document.querySelector('.subagent-coordination');
      return details?.open;
    })()`);
    if (actual !== expected) throw new Error(`서브에이전트 통신의 ${expected ? '열림' : '닫힘'} 상태가 자동 갱신으로 뒤집혔습니다.`);
    states.push(actual);
  }
  await auditWheelControls(win, 'subagent-drawer');
  await win.webContents.executeJavaScript(`window.WhiteboxApp.closeDrawer(false)`);
  await wait(300);
  return states;
}

async function checkEveryMemoryRecord(win) {
  const ids = await win.webContents.executeJavaScript(`(() => {
    const app = window.WhiteboxApp;
    app.state.graphFocusId = null;
    app.state.search = '';
    app.state.providerFilters.clear();
    app.state.workspace = 'all';
    app.state.sort = 'recent';
    app.state.visibleLimit = 999;
    app.state.guideExpanded = false;
    app.selectView('active');
    app.state.visibleLimit = 999;
    app.renderSessions('audit');
    return [...document.querySelectorAll('#sessionGrid [data-session-id]')].map(element => element.dataset.sessionId);
  })()`);
  if (ids.length < 30) throw new Error(`기억 기록 전수 검사용 카드 수가 부족합니다: ${ids.length}`);
  for (const id of ids) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-session-id=${JSON.stringify(id)}]').click()`);
    await waitFor(win, `window.WhiteboxApp.state.selectedId === ${JSON.stringify(id)} && document.querySelector('#detailDrawer').classList.contains('open') && !document.querySelector('.drawer-loading')`, `기억 기록 ${id} 상세를 열지 못했습니다.`);
    const stayedOpen = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('#detailDrawer');
      drawer.dispatchEvent(new WheelEvent('wheel', { deltaY: 220, bubbles: true, cancelable: true }));
      return drawer.classList.contains('open');
    })()`);
    if (!stayedOpen) throw new Error(`기억 기록 ${id}에서 휠 후 상세가 닫혔습니다.`);
    await auditWheelControls(win, `memory:${id}`);
    await win.webContents.executeJavaScript(`document.querySelector('#closeDrawerBtn').click()`);
    await waitFor(win, `!document.querySelector('#detailDrawer').classList.contains('open')`, `기억 기록 ${id} 상세 닫기 버튼이 동작하지 않았습니다.`);
  }
  await wait(300);
  return { count: ids.length, ids };
}

async function checkMobileControls(win) {
  win.setSize(480, 720);
  await waitFor(
    win,
    `document.querySelector('#mobileMoreBtn').getClientRects().length > 0 && getComputedStyle(document.querySelector('#mobileMoreBtn')).display !== 'none'`,
    '모바일 내비게이션 레이아웃으로 전환되지 않았습니다.',
  );
  await win.webContents.executeJavaScript(`document.querySelector('#mobileMoreBtn').click()`);
  await waitFor(win, `!document.querySelector('#mobileToolsMenu').classList.contains('hidden')`, '모바일 더보기 메뉴가 열리지 않았습니다.');
  const opened = await win.webContents.executeJavaScript(`(() => {
    const menu = document.querySelector('#mobileToolsMenu');
    menu.dispatchEvent(new WheelEvent('wheel', { deltaY: 180, bubbles: true, cancelable: true }));
    const first = menu.querySelector('button');
    first.focus({ preventScroll: true });
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    return {
      open: !menu.classList.contains('hidden'),
      focused: document.activeElement?.dataset.mobileView || '',
    };
  })()`);
  if (!opened.open || opened.focused !== 'settings') throw new Error(`모바일 더보기 메뉴의 휠·키보드 상태가 불안정합니다: ${JSON.stringify(opened)}`);
  const wheel = await auditWheelControls(win, 'mobile-menu');
  await win.webContents.executeJavaScript(`document.querySelector('#mainContent').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await waitFor(win, `document.querySelector('#mobileToolsMenu').classList.contains('hidden')`, '모바일 더보기 메뉴를 닫지 못했습니다.');
  win.setSize(1440, 940);
  await waitFor(win, `window.innerWidth > 1280
    && document.querySelector('#advancedToolsNav > summary').getClientRects().length > 0
    && getComputedStyle(document.querySelector('#advancedToolsNav > summary')).display !== 'none'
    && document.querySelector('#mobileMoreBtn').getClientRects().length === 0`,
  '데스크톱 내비게이션 레이아웃으로 복원되지 않았습니다.');
  return { ...opened, wheel };
}

async function checkTerminalOutput(win) {
  await win.webContents.executeJavaScript(`window.WhiteboxApp.selectView('terminal')`);
  await waitFor(win, `Boolean(document.querySelector('[data-terminal-id="terminal-main"]'))`, '일반 터미널 세션이 준비되지 않았습니다.');
  await win.webContents.executeJavaScript(`(() => {
    const app = window.WhiteboxApp;
    return window.WhiteboxTerminal.openForAgent(app.state.snapshot.sessions.find(item => item.id === 'fixture-root'), 'terminal-main');
  })()`);
  await waitFor(win, `Boolean(document.querySelector('[data-terminal-screen="terminal-main"]:not(.hidden)'))`, '일반 터미널 화면이 준비되지 않았습니다.');
  await win.webContents.executeJavaScript(`window.interactionTest.emitTerminalData('terminal-main', Array.from({ length: 180 }, (_, index) => 'history-' + index + '\\r\\n').join(''))`);
  await waitFor(win, `Number(document.querySelector('[data-terminal-screen="terminal-main"]').dataset.baseY) > 40`, '터미널 스크롤 기록이 만들어지지 않았습니다.');
  const before = await win.webContents.executeJavaScript(`(() => {
    const screen = document.querySelector('[data-terminal-screen="terminal-main"]');
    window.WhiteboxTerminal.scrollTerminalToLine('terminal-main', Math.max(0, Number(screen.dataset.baseY) - 12));
    return new Promise(resolve => setTimeout(() => resolve({ top: Number(screen.dataset.viewportY), maximum: Number(screen.dataset.baseY) }), 80));
  })()`);
  if (!(before.top >= 0 && before.top < before.maximum)) throw new Error(`터미널 과거 출력 위치를 만들지 못했습니다: ${JSON.stringify(before)}`);
  await win.webContents.executeJavaScript(`window.interactionTest.emitTerminalData('terminal-main', 'new-output-after-user-action\\r\\n')`);
  await wait(120);
  const after = await win.webContents.executeJavaScript(`(() => { const screen = document.querySelector('[data-terminal-screen="terminal-main"]'); return { top: Number(screen.dataset.viewportY), maximum: Number(screen.dataset.baseY) }; })()`);
  if (Math.abs(after.top - before.top) > 1) throw new Error(`터미널 출력이 사용자 휠 위치를 맨 아래로 이동했습니다: ${JSON.stringify({ before, after })}`);
  return { before, after };
}

async function checkTerminalSubagentProgress(win) {
  await waitFor(win, `document.querySelectorAll('[data-terminal-subagent-progress] [data-terminal-subagent-id]').length === 3`, '터미널에 서브에이전트 진행 카드가 표시되지 않았습니다.');
  const initial = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    list.style.height = '190px';
    list.style.maxHeight = '190px';
    const cards = [...list.querySelectorAll('[data-terminal-subagent-id]')];
    const maximum = list.scrollHeight - list.clientHeight;
    list.scrollTop = Math.max(1, Math.floor(maximum / 2));
    return {
      count: cards.length,
      ids: cards.map(card => card.dataset.terminalSubagentId),
      states: Object.fromEntries(cards.map(card => [card.dataset.terminalSubagentId, card.dataset.terminalSubagentState])),
      nestedDepth: list.querySelector('[data-terminal-subagent-id="fixture-grandchild"]')?.dataset.terminalSubagentDepth,
      text: list.querySelector('[data-terminal-subagent-progress]')?.textContent || '',
      top: list.scrollTop,
      maximum,
    };
  })()`);
  if (
    initial.count !== 3
    || !['fixture-child', 'fixture-grandchild', 'fixture-resting'].every(id => initial.ids.includes(id))
    || initial.states['fixture-child'] !== 'working'
    || initial.states['fixture-grandchild'] !== 'resting'
    || initial.states['fixture-resting'] !== 'resting'
    || initial.nestedDepth !== '2'
    || !initial.text.includes('완료된 테스트를 다시 검토해줘')
    || !initial.text.includes('중첩 흐름 정상')
    || initial.text.includes('gAAAAABfixtureProtectedPayload')
    || !(initial.maximum <= 0
      ? initial.top === 0
      : initial.top > 0 && initial.top < initial.maximum)
  ) {
    throw new Error(`터미널 서브에이전트 계층·상태·진행 기록이 올바르지 않습니다: ${JSON.stringify(initial)}`);
  }

  await win.webContents.executeJavaScript(`(() => {
    const next = JSON.parse(JSON.stringify(window.WhiteboxApp.state.snapshot));
    const child = next.sessions.find(item => item.id === 'fixture-child');
    child.statusDetail = '터미널에서 확인할 새 진행 단계';
    child.lifecycle.push({
      id: 'terminal-subagent-live-step',
      type: 'progress',
      status: 'running',
      label: '실시간 검증 단계',
      detail: '자식 세션만 갱신됨',
      timestamp: new Date(Date.now() + 3000).toISOString(),
    });
    child.updatedAt = new Date(Date.now() + 3000).toISOString();
    window.__terminalSubagentSnapshot = next;
    window.WhiteboxTerminal.updateSnapshot(next, window.WhiteboxApp.state.workspaces);
  })()`);
  await waitFor(win, `document.querySelector('[data-terminal-subagent-id="fixture-child"]').textContent.includes('자식 세션만 갱신됨')`, '자식 세션만 갱신했을 때 터미널 진행 기록이 반영되지 않았습니다.');
  const live = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    return { top: list.scrollTop, text: list.querySelector('[data-terminal-subagent-id="fixture-child"]').textContent };
  })()`);
  if (Math.abs(live.top - initial.top) > 2 || !live.text.includes('터미널에서 확인할 새 진행 단계')) {
    throw new Error(`서브에이전트 실시간 진행 갱신이 기록 위치를 바꾸거나 현재 단계를 누락했습니다: ${JSON.stringify({ initial, live })}`);
  }

  const selected = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    const card = list.querySelector('[data-terminal-subagent-id="fixture-child"]');
    const copy = card.querySelector('.terminal-subagent-current span');
    const textNode = copy.firstChild;
    list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, pointerType: 'mouse', buttons: 1 }));
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(12, textNode.length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2, pointerType: 'mouse' }));
    window.__terminalSubagentCard = card;
    const next = JSON.parse(JSON.stringify(window.__terminalSubagentSnapshot));
    const child = next.sessions.find(item => item.id === 'fixture-child');
    child.statusDetail = '선택이 끝난 뒤 반영할 단계';
    child.updatedAt = new Date(Date.now() + 4000).toISOString();
    window.__terminalSubagentPendingSnapshot = next;
    window.WhiteboxTerminal.updateSnapshot(next, window.WhiteboxApp.state.workspaces);
    return { top: list.scrollTop, selection: selection.toString(), text: card.textContent };
  })()`);
  await wait(120);
  const deferred = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    const card = list.querySelector('[data-terminal-subagent-id="fixture-child"]');
    return {
      top: list.scrollTop,
      selection: window.getSelection().toString(),
      sameNode: card === window.__terminalSubagentCard,
      text: card.textContent,
    };
  })()`);
  if (
    Math.abs(deferred.top - selected.top) > 2
    || deferred.selection !== selected.selection
    || !deferred.sameNode
    || deferred.text.includes('선택이 끝난 뒤 반영할 단계')
  ) {
    throw new Error(`서브에이전트 진행 텍스트를 드래그하는 동안 DOM이나 휠 위치가 이동했습니다: ${JSON.stringify({ selected, deferred })}`);
  }
  await win.webContents.executeJavaScript(`(() => {
    window.getSelection().removeAllRanges();
    document.querySelector('[data-terminal-subagent-id="fixture-child"]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  })()`);
  await waitFor(win, `document.querySelector('[data-terminal-subagent-id="fixture-child"]').textContent.includes('선택이 끝난 뒤 반영할 단계')`, '서브에이전트 진행 텍스트 선택 종료 후 보류된 갱신이 반영되지 않았습니다.');
  const flushed = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    return { top: list.scrollTop, text: list.querySelector('[data-terminal-subagent-id="fixture-child"]').textContent };
  })()`);
  if (Math.abs(flushed.top - selected.top) > 2) {
    throw new Error(`서브에이전트 보류 갱신 반영 후 휠 위치가 이동했습니다: ${JSON.stringify({ selected, flushed })}`);
  }
  return { initial, live, selected, deferred, flushed };
}

async function checkTerminalHistory(win) {
  await win.webContents.executeJavaScript(`(() => {
    window.interactionTest.configure({ delays: { sessionDetail: 1000 } });
    const app = window.WhiteboxApp;
    const next = JSON.parse(JSON.stringify(app.state.snapshot));
    const session = next.sessions.find(item => item.id === 'fixture-root');
    session.messages = Array.from({ length: 24 }, (_, index) => ({
      id: 'scroll-history-' + index,
      role: index % 2 ? 'assistant' : 'user',
      text: 'scroll history message ' + index + ' '.repeat(80),
      timestamp: new Date(Date.now() + index).toISOString(),
    }));
    session.updatedAt = new Date(Date.now() + 1000).toISOString();
    window.__terminalHistorySnapshot = next;
    window.WhiteboxTerminal.updateSnapshot(next, app.state.workspaces);
  })()`);
  await waitFor(win, `document.querySelectorAll('#terminalHistoryList .terminal-history-message').length >= 20`, '터미널 대화 기록이 준비되지 않았습니다.');
  const before = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    list.style.height = '160px';
    list.style.maxHeight = '160px';
    const maximum = list.scrollHeight - list.clientHeight;
    list.scrollTop = Math.max(1, maximum - 40);
    return { top: list.scrollTop, maximum };
  })()`);
  const pointerBefore = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    const copy = list.querySelector('.terminal-history-copy');
    const textNode = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT).nextNode();
    list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1 }));
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(12, textNode.length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
    copy.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    window.__terminalHistoryFirstMessage = list.querySelector('.terminal-history-message');
    const next = JSON.parse(JSON.stringify(window.__terminalHistorySnapshot));
    next.sessions.find(item => item.id === 'fixture-root').messages.push({
      id: 'scroll-history-pending',
      role: 'assistant',
      text: 'new history while text is selected',
      timestamp: new Date(Date.now() + 25).toISOString(),
    });
    next.sessions.find(item => item.id === 'fixture-root').updatedAt = new Date(Date.now() + 1500).toISOString();
    window.__terminalHistoryPendingSnapshot = next;
    window.WhiteboxTerminal.updateSnapshot(next, window.WhiteboxApp.state.workspaces);
    return {
      top: list.scrollTop,
      selection: selection.toString(),
      count: list.querySelectorAll('.terminal-history-message').length,
      nestedScrollable: [...list.querySelectorAll('.terminal-history-copy')].filter(element => element.scrollHeight > element.clientHeight + 1).length,
    };
  })()`);
  await wait(140);
  const pointerAfter = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    return {
      top: list.scrollTop,
      selection: window.getSelection().toString(),
      count: list.querySelectorAll('.terminal-history-message').length,
      sameNode: list.querySelector('.terminal-history-message') === window.__terminalHistoryFirstMessage,
      nestedScrollable: [...list.querySelectorAll('.terminal-history-copy')].filter(element => element.scrollHeight > element.clientHeight + 1).length,
    };
  })()`);
  if (Math.abs(pointerAfter.top - pointerBefore.top) > 2 || pointerAfter.selection !== pointerBefore.selection || pointerAfter.count !== pointerBefore.count || !pointerAfter.sameNode || pointerAfter.nestedScrollable) {
    throw new Error(`터미널 대화 기록의 드래그·클릭 상태가 갱신 중 이동했습니다: ${JSON.stringify({ pointerBefore, pointerAfter })}`);
  }
  await win.webContents.executeJavaScript(`(() => {
    window.getSelection().removeAllRanges();
    document.querySelector('#terminalHistoryList .terminal-history-copy').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    window.__terminalHistorySnapshot = window.__terminalHistoryPendingSnapshot;
  })()`);
  await waitFor(win, `document.querySelectorAll('#terminalHistoryList .terminal-history-message').length === ${pointerBefore.count + 1}`, '드래그 선택을 끝낸 뒤 보류된 새 대화가 반영되지 않았습니다.');
  const pointerFlushed = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    return {
      top: list.scrollTop,
      count: list.querySelectorAll('.terminal-history-message').length,
      latest: list.lastElementChild?.textContent || '',
    };
  })()`);
  if (Math.abs(pointerFlushed.top - pointerBefore.top) > 2 || pointerFlushed.count !== pointerBefore.count + 1 || !pointerFlushed.latest.includes('new history while text is selected')) {
    throw new Error(`드래그 종료 후 보류된 대화 반영이 스크롤 위치를 바꿨습니다: ${JSON.stringify({ pointerBefore, pointerFlushed })}`);
  }

  const wheelBefore = await win.webContents.executeJavaScript(`(() => {
    window.getSelection().removeAllRanges();
    const list = document.querySelector('#terminalHistoryList');
    list.scrollTop = Math.floor((list.scrollHeight - list.clientHeight) / 2);
    return {
      top: list.scrollTop,
      stageTop: document.querySelector('.main-stage').scrollTop,
      overscroll: getComputedStyle(list).overscrollBehaviorY,
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      display: getComputedStyle(list).display,
      overflowY: getComputedStyle(list).overflowY,
      panelClass: document.querySelector('#terminalHistoryPanel')?.className || '',
      panelDisplay: getComputedStyle(document.querySelector('#terminalHistoryPanel')).display,
    };
  })()`);
  await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    list.scrollTop += 120;
    list.querySelector('.terminal-history-copy').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const next = JSON.parse(JSON.stringify(window.__terminalHistorySnapshot));
    next.sessions.find(item => item.id === 'fixture-root').updatedAt = new Date(Date.now() + 1600).toISOString();
    window.WhiteboxTerminal.updateSnapshot(next, window.WhiteboxApp.state.workspaces);
  })()`);
  await wait(120);
  const wheelAfter = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    return {
      top: list.scrollTop,
      stageTop: document.querySelector('.main-stage').scrollTop,
      nestedTop: [...list.querySelectorAll('.terminal-history-copy')].reduce((sum, element) => sum + element.scrollTop, 0),
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
    };
  })()`);
  if (wheelAfter.top <= wheelBefore.top || wheelAfter.stageTop !== wheelBefore.stageTop || wheelAfter.nestedTop !== 0 || wheelBefore.overscroll !== 'contain') {
    throw new Error(`터미널 대화 기록의 실제 휠이 단일 기록 영역에 머물지 않았습니다: ${JSON.stringify({ wheelBefore, wheelAfter })}`);
  }

  const refreshBefore = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    return { top: list.scrollTop, maximum: list.scrollHeight - list.clientHeight };
  })()`);
  await win.webContents.executeJavaScript(`(() => {
    const app = window.WhiteboxApp;
    const next = JSON.parse(JSON.stringify(app.state.snapshot));
    const session = next.sessions.find(item => item.id === 'fixture-root');
    session.messages = Array.from({ length: 25 }, (_, index) => ({
      id: 'scroll-history-next-' + index,
      role: index % 2 ? 'assistant' : 'user',
      text: 'next scroll history message ' + index + ' ' + 'long readable history content '.repeat(14),
      timestamp: new Date(Date.now() + index).toISOString(),
    }));
    session.updatedAt = new Date(Date.now() + 2000).toISOString();
    window.WhiteboxTerminal.updateSnapshot(next, app.state.workspaces);
  })()`);
  await wait(120);
  const after = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#terminalHistoryList');
    const first = list.querySelector('.terminal-history-copy p');
    return {
      top: list.scrollTop,
      maximum: list.scrollHeight - list.clientHeight,
      count: list.querySelectorAll('.terminal-history-message').length,
      firstTextLength: first?.textContent.length || 0,
      firstHeight: first?.getBoundingClientRect().height || 0,
      firstWidth: first?.getBoundingClientRect().width || 0,
      whiteSpace: first ? getComputedStyle(first).whiteSpace : '',
      overflowWrap: first ? getComputedStyle(first).overflowWrap : '',
    };
  })()`);
  await win.webContents.executeJavaScript(`window.interactionTest.clearControls()`);
  if (before.maximum <= 50 || Math.abs(after.top - refreshBefore.top) > 2) {
    throw new Error(`터미널 대화 갱신이 사용자 휠 위치를 버렸습니다: ${JSON.stringify({ refreshBefore, after })}`);
  }
  return { before, refreshBefore, after, pointerBefore, pointerAfter, pointerFlushed, wheelBefore, wheelAfter };
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
  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await waitFor(win, `Boolean(window.WhiteboxApp?.state?.snapshot && window.WhiteboxTerminal)`, '렌더러가 준비되지 않았습니다.');
    const report = {
      mainViews: await checkMainViews(win),
      disclosures: await checkDisclosureStates(win),
      drawer: await checkDrawer(win),
      subagentDisclosure: await checkSubagentDisclosure(win),
      memoryRecords: await checkEveryMemoryRecord(win),
      mobileControls: await checkMobileControls(win),
      terminal: await checkTerminalOutput(win),
      terminalSubagents: await checkTerminalSubagentProgress(win),
      terminalHistory: await checkTerminalHistory(win),
      wheelControls: await auditWheelControls(win, 'final'),
    };
    process.stdout.write(`스크롤 위치 유지 검사 통과: ${JSON.stringify(report)}\n`);
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
