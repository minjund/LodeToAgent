'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-philosophy-'));
app.setPath('userData', userData);
app.once('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(win, expression, message, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await wait(60);
  }
  throw new Error(message);
}

async function stabilizeView(win, view, requiredSelector) {
  await win.webContents.executeJavaScript(`(async () => {
    let style = document.querySelector('#philosophyCaptureStability');
    if (!style) {
      style = document.createElement('style');
      style.id = 'philosophyCaptureStability';
      style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
      document.head.appendChild(style);
    }
    window.LoadToAgentApp.selectView(${JSON.stringify(view)});
    const stage = document.querySelector('.main-stage');
    stage?.scrollTo(0, 0);
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  })()`);
  await waitFor(
    win,
    `(() => {
      const element = document.querySelector(${JSON.stringify(requiredSelector)});
      if (document.body.dataset.currentView !== ${JSON.stringify(view)} || !element || element.classList.contains('hidden')) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) >= .99;
    })()`,
    `${view} 화면이 캡처 가능한 상태로 안정화되지 않았습니다.`,
  );
  win.webContents.invalidate();
  await wait(180);
}

function rasterHasContent(image, startY = 180) {
  if (!image || image.isEmpty()) return false;
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let visibleSamples = 0;
  for (let y = Math.min(startY, height - 1); y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const offset = ((y * width) + x) * 4;
      const a = bitmap[offset + 3];
      const c0 = bitmap[offset];
      const c1 = bitmap[offset + 1];
      const c2 = bitmap[offset + 2];
      const maximum = Math.max(c0, c1, c2);
      const minimum = Math.min(c0, c1, c2);
      if (a > 200 && (maximum > 82 || (maximum > 42 && maximum - minimum > 16))) visibleSamples += 1;
      if (visibleSamples > 120) return true;
    }
  }
  return false;
}

async function capture(win, name, view, requiredSelector) {
  const outputDir = path.join(__dirname, '..', 'artifacts');
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, name);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await stabilizeView(win, view, requiredSelector);
    const image = await win.webContents.capturePage();
    if (!rasterHasContent(image, view === 'active' ? 120 : 180)) {
      await wait(240);
      continue;
    }
    const temporary = `${output}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, image.toPNG());
    fs.copyFileSync(temporary, output);
    fs.rmSync(temporary, { force: true });
    return output;
  }
  throw new Error(`${name} 래스터 캡처가 네 번 연속 비어 있었습니다.`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1666,
    height: 1018,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#070811',
    webPreferences: {
      preload: path.join(__dirname, 'interaction-fixture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await waitFor(
      win,
      'Boolean(window.LoadToAgentApp?.initialized && window.LoadToAgentApp?.state?.snapshot)',
      '앱 픽스처가 준비되지 않았습니다.',
    );
    win.setSkipTaskbar(true);
    win.setPosition(-32000, -32000);
    win.showInactive();
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentI18n.setLocale('ko');
      const app = window.LoadToAgentApp;
      app.state.guideExpanded = false;
      app.state.search = '';
      app.state.workspace = 'all';
      app.state.providerFilters.clear();
      app.render();
      app.selectView('all');
      document.querySelector('.main-stage')?.scrollTo(0, 0);
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);

    const nowMetrics = await win.webContents.executeJavaScript(`(() => ({
      view: document.body.dataset.currentView,
      nav: [...document.querySelectorAll('.view-nav .nav-item[data-view]')].slice(0, 3).map(item => item.textContent.replace(/\\s+/g, ' ').trim()),
      title: document.querySelector('#pageTitle')?.textContent || '',
      liveVisible: !document.querySelector('#liveSection')?.classList.contains('hidden'),
      memoryHidden: document.querySelector('#sessionSection')?.classList.contains('hidden'),
      memoryCardsOnNow: document.querySelectorAll('#sessionGrid .memory-record').length,
      causalColumns: [...document.querySelectorAll('.control-column-label')].slice(0, 3).map(item => item.textContent.replace(/\\s+/g, ' ').trim()),
      causalCheckpoints: [...document.querySelectorAll('.control-causal-spine > li')].slice(0, 5).map(item => item.textContent.replace(/\\s+/g, ' ').trim()),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    }))()`);
    if (
      nowMetrics.view !== 'all'
      || !nowMetrics.nav[0]?.replace(/\s+/g, '').startsWith('◆지금')
      || !nowMetrics.nav[1]?.replace(/\s+/g, '').startsWith('○기억')
      || !nowMetrics.nav[2]?.replace(/\s+/g, '').startsWith('!판단')
      || !nowMetrics.title.includes('왜 움직이는가')
      || !nowMetrics.liveVisible
      || !nowMetrics.memoryHidden
      || nowMetrics.memoryCardsOnNow !== 0
      || !nowMetrics.causalColumns.some(label => label.includes('의도를 맡은 주체'))
      || !nowMetrics.causalColumns.some(label => label.includes('위임과 실제 행위'))
      || !nowMetrics.causalColumns.some(label => label.includes('증거와 판단'))
      || nowMetrics.causalCheckpoints.length !== 5
      || !['의도', '위임', '행위', '증거', '판단'].every(label => nowMetrics.causalCheckpoints.some(step => step.includes(label)))
      || nowMetrics.horizontalOverflow
    ) throw new Error(`지금 화면 철학 계약 실패: ${JSON.stringify(nowMetrics)}`);
    const nowOutput = await capture(win, 'loadtoagent-philosophical-now.png', 'all', '#liveSection');

    await stabilizeView(win, 'active', '#sessionSection');
    await waitFor(win, `document.querySelectorAll('#sessionGrid .memory-record').length > 0`, '기억 카드가 렌더링되지 않았습니다.');
    const memoryMetrics = await win.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('.main-stage');
      return {
        view: document.body.dataset.currentView,
        liveHidden: document.querySelector('#liveSection')?.classList.contains('hidden'),
        archiveVisible: !document.querySelector('#sessionSection')?.classList.contains('hidden'),
        cards: document.querySelectorAll('#sessionGrid .memory-record').length,
        lineages: document.querySelectorAll('#sessionGrid .memory-record-lineage').length,
        proofCards: document.querySelectorAll('#sessionGrid .memory-record-proof').length,
        wisdom: document.querySelectorAll('.memory-wisdom > article').length,
        recordMetric: Number(document.querySelector('#memoryRecordCount')?.textContent.replace(/[^0-9]/g, '') || 0),
        evidenceMetric: Number(document.querySelector('#memoryEvidenceCount')?.textContent.replace(/[^0-9]/g, '') || 0),
        decisionMetric: Number(document.querySelector('#memoryDecisionCount')?.textContent.replace(/[^0-9]/g, '') || 0),
        optionalDecisionState: document.querySelector('#sessionGrid [data-session-id="fixture-optional"] .memory-record-chain > span:last-of-type b')?.textContent.trim() || '',
        sectionOpacity: Number(getComputedStyle(document.querySelector('#sessionSection')).opacity || 0),
        firstCardViewport: (() => {
          const card = document.querySelector('#sessionGrid .memory-record');
          if (!card) return null;
          const rect = card.getBoundingClientRect();
          const style = getComputedStyle(card);
          return {
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            viewportHeight: window.innerHeight,
            display: style.display,
            visibility: style.visibility,
            opacity: Number(style.opacity || 1),
            visible: rect.bottom > 0 && rect.top < window.innerHeight && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) >= .9,
          };
        })(),
        stageOverflow: stage.scrollWidth > stage.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    })()`);
    if (
      memoryMetrics.view !== 'active'
      || !memoryMetrics.liveHidden
      || !memoryMetrics.archiveVisible
      || memoryMetrics.cards < 3
      || memoryMetrics.lineages !== memoryMetrics.cards
      || memoryMetrics.proofCards !== memoryMetrics.cards
      || memoryMetrics.wisdom !== 3
      || memoryMetrics.recordMetric < memoryMetrics.cards
      || memoryMetrics.evidenceMetric < 1
      || memoryMetrics.decisionMetric !== 0
      || !memoryMetrics.optionalDecisionState.includes('판단 대기')
      || memoryMetrics.sectionOpacity < .99
      || !memoryMetrics.firstCardViewport?.visible
      || memoryMetrics.stageOverflow
      || memoryMetrics.pageOverflow
    ) throw new Error(`기억 화면 계약 실패: ${JSON.stringify(memoryMetrics)}`);
    const memoryOutput = await capture(win, 'loadtoagent-philosophical-memory.png', 'active', '#sessionSection');

    await win.webContents.executeJavaScript(`document.querySelector('#sessionGrid [data-session-id="fixture-ended"]')?.click()`);
    await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open') && !document.querySelector('.drawer-loading')`, '기억 상세가 열리지 않았습니다.');
    const memoryDrawer = await win.webContents.executeJavaScript(`(() => ({
      open: document.querySelector('#detailDrawer')?.classList.contains('open'),
      detailText: document.querySelector('#drawerContent')?.textContent.trim().length || 0,
      conversation: document.querySelectorAll('#detailDrawer .conversation-message, #detailDrawer .chat-message, #detailDrawer .chat-event').length,
      tabs: document.querySelectorAll('#detailDrawer .drawer-tabs [data-tab]').length,
      overflow: document.querySelector('#detailDrawer')?.scrollWidth > document.querySelector('#detailDrawer')?.clientWidth + 1,
    }))()`);
    if (!memoryDrawer.open || memoryDrawer.detailText < 50 || memoryDrawer.tabs < 1 || memoryDrawer.overflow) throw new Error(`기억 상세 계약 실패: ${JSON.stringify(memoryDrawer)}`);
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer?.(false)`);

    const toolViews = await win.webContents.executeJavaScript(`(async () => {
      const checks = {};
      for (const [view, selector] of [['waiting','#attentionInbox'],['runtime','#automationOverview'],['terminal','#terminalSection'],['tmux','#tmuxSection'],['settings','#settingsSection']]) {
        window.LoadToAgentApp.selectView(view);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        checks[view] = document.body.dataset.currentView === view && !document.querySelector(selector)?.classList.contains('hidden');
        if (view === 'waiting') checks.waitingHasNoInternalKeys = !document.querySelector(selector)?.textContent.includes('management.category.');
      }
      return checks;
    })()`);
    if (Object.values(toolViews).some(value => !value)) throw new Error(`기존 기능 화면 전환 실패: ${JSON.stringify(toolViews)}`);

    win.setSize(390, 844);
    await wait(300);
    await stabilizeView(win, 'active', '#sessionSection');
    const mobileMetrics = await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('#sessionGrid .memory-record');
      const cardRect = card?.getBoundingClientRect();
      const bottomNav = document.querySelector('.sidebar');
      const bottomNavRect = bottomNav?.getBoundingClientRect();
      const usableBottom = bottomNavRect?.top > 0 ? bottomNavRect.top : window.innerHeight;
      const visibleCardHeight = cardRect ? Math.max(0, Math.min(cardRect.bottom, usableBottom) - Math.max(cardRect.top, 0)) : 0;
      return {
        width: window.innerWidth,
        view: document.body.dataset.currentView,
        activeNav: document.querySelector('.view-nav [data-view].active')?.dataset.view || '',
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
        stageOverflow: document.querySelector('.main-stage').scrollWidth > document.querySelector('.main-stage').clientWidth + 1,
        sectionOpacity: Number(getComputedStyle(document.querySelector('#sessionSection')).opacity || 0),
        firstCardVisible: Boolean(cardRect && visibleCardHeight >= 44 && getComputedStyle(card).display !== 'none' && getComputedStyle(card).visibility !== 'hidden' && Number(getComputedStyle(card).opacity || 1) >= .9),
        firstCardRect: cardRect ? {
          top: cardRect.top,
          bottom: cardRect.bottom,
          visibleHeight: visibleCardHeight,
          usableBottom,
          display: getComputedStyle(card).display,
          visibility: getComputedStyle(card).visibility,
          opacity: Number(getComputedStyle(card).opacity || 1),
        } : null,
        bottomNavVisible: getComputedStyle(bottomNav).display !== 'none',
      };
    })()`);
    if (mobileMetrics.view !== 'active' || mobileMetrics.activeNav !== 'active' || mobileMetrics.sectionOpacity < .99 || mobileMetrics.pageOverflow || mobileMetrics.stageOverflow || !mobileMetrics.firstCardVisible || !mobileMetrics.bottomNavVisible) {
      throw new Error(`기억 모바일 계약 실패: ${JSON.stringify(mobileMetrics)}`);
    }
    const mobileOutput = await capture(win, 'loadtoagent-philosophical-memory-mobile.png', 'active', '#sessionSection');

    console.log('철학적 UI 및 기능 연결 검증 통과');
    console.log(JSON.stringify({ nowMetrics, memoryMetrics, memoryDrawer, toolViews, mobileMetrics }, null, 2));
    console.log(nowOutput);
    console.log(memoryOutput);
    console.log(mobileOutput);
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
}).catch(error => {
  console.error(error);
  app.exit(1);
});
