'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');
app.disableHardwareAcceleration();

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
    window.LoadToAgentApp.state.guideCompleted.clear();
    window.LoadToAgentApp.render();
    document.querySelectorAll('.sidebar, .sidebar *').forEach(item => {
      item.style.setProperty('visibility', 'visible', 'important');
      item.style.setProperty('opacity', '1', 'important');
    });
    document.querySelectorAll('.view-nav > .nav-item[data-view]').forEach(item => {
      item.style.setProperty('display', 'grid', 'important');
      item.style.setProperty('transform', 'none', 'important');
    });
    const originalSidebar = document.querySelector('.sidebar');
    if (originalSidebar && !originalSidebar.dataset.captureClone) {
      const sidebarClone = originalSidebar.cloneNode(true);
      sidebarClone.dataset.captureClone = 'true';
      originalSidebar.replaceWith(sidebarClone);
    }
    const stage = document.querySelector('.main-stage');
    const sidebar = document.querySelector('.sidebar');
    stage?.scrollTo(0, 0);
    sidebar?.scrollTo(0, 0);
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    stage?.scrollTo(0, 0);
    sidebar?.scrollTo(0, 0);
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
  await wait(360);
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.main-stage')?.scrollTo(0, 0);
    document.querySelector('.sidebar')?.scrollTo(0, 0);
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
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
  // A new surface per screenshot prevents Chromium from reusing partially
  // painted sidebar layers from a previously captured view.
  const [width, height] = win.getSize();
  const captureWin = new BrowserWindow({
    width,
    height,
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
    await captureWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    captureWin.showInactive();
    await waitFor(
      captureWin,
      'Boolean(window.LoadToAgentApp?.initialized && window.LoadToAgentApp?.state?.snapshot)',
      `${name} 캡처용 앱 상태를 준비하지 못했습니다.`,
    );
    await captureWin.webContents.executeJavaScript(`(() => {
      window.LoadToAgentI18n.setLocale('ko');
      const app = window.LoadToAgentApp;
      app.state.guideExpanded = false;
      app.state.search = '';
      app.state.workspace = ${JSON.stringify(view)} === 'all'
        ? app.state.workspaces[0]?.path || 'all'
        : 'all';
      app.state.providerFilters.clear();
      app.render();
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    captureWin.webContents.debugger.attach('1.3');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await stabilizeView(captureWin, view, requiredSelector);
      const screenshot = await captureWin.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const image = nativeImage.createFromBuffer(Buffer.from(screenshot.data, 'base64'));
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
  } finally {
    if (captureWin.webContents.debugger.isAttached()) captureWin.webContents.debugger.detach();
    captureWin.destroy();
  }
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
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentI18n.setLocale('ko');
      const app = window.LoadToAgentApp;
      app.state.guideExpanded = false;
      app.state.search = '';
      app.state.workspace = app.state.workspaces[0]?.path || 'all';
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
      || !nowMetrics.nav[0]?.replace(/\s+/g, '').startsWith('◆처리중')
      || !nowMetrics.nav[1]?.replace(/\s+/g, '').startsWith('○지난작업')
      || !nowMetrics.nav[2]?.replace(/\s+/g, '').startsWith('!확인대기')
      || nowMetrics.title.trim() !== '처리 중인 작업'
      || !nowMetrics.liveVisible
      || !nowMetrics.memoryHidden
      || nowMetrics.memoryCardsOnNow !== 0
      || !nowMetrics.causalColumns.some(label => label.includes('담당 AI'))
      || !nowMetrics.causalColumns.some(label => label.includes('함께 진행 중인 AI 작업'))
      || !nowMetrics.causalColumns.some(label => label.includes('함께 시작한 작업'))
      || nowMetrics.causalCheckpoints.length !== 0
      || nowMetrics.horizontalOverflow
    ) throw new Error(`지금 화면 쉬운 표현 계약 실패: ${JSON.stringify(nowMetrics)}`);
    const nowOutput = await capture(win, 'loadtoagent-philosophical-now.png', 'all', '#liveSection');

    await win.webContents.executeJavaScript(`(() => {
      const app = window.LoadToAgentApp;
      app.state.workspace = 'all';
      app.render();
    })()`);
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
        reviewActions: document.querySelectorAll('#sessionGrid .memory-review-action').length,
        proofCards: document.querySelectorAll('#sessionGrid .memory-record-proof').length,
        wisdom: document.querySelectorAll('.memory-wisdom > article').length,
        recordMetric: Number(document.querySelector('#memoryRecordCount')?.textContent.replace(/[^0-9]/g, '') || 0),
        evidenceMetric: Number((document.querySelector('#memoryEvidenceCount')?.textContent.match(/\\d+/g) || ['0']).at(-1)),
        decisionMetric: Number((document.querySelector('#memoryDecisionCount')?.textContent.match(/\\d+/g) || ['0']).at(-1)),
        decisionMetricText: (document.querySelector('#memoryDecisionLabel')?.textContent || '') + ' ' + (document.querySelector('#memoryDecisionCount')?.textContent || ''),
        optionalDecisionState: document.querySelector('#sessionGrid [data-session-id="fixture-optional"] .memory-record-chain > span:last-of-type')?.textContent.trim() || '',
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
        stageOverflowDetail: (() => {
          const stageRect = stage.getBoundingClientRect();
          return [...stage.querySelectorAll('*')]
            .map(element => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName,
                id: element.id,
                className: typeof element.className === 'string' ? element.className : '',
                right: Math.round(rect.right),
                stageRight: Math.round(stageRect.right),
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
              };
            })
            .filter(item => item.right > item.stageRight + 1 || item.scrollWidth > item.clientWidth + 1)
            .sort((a, b) => Math.max(b.right - b.stageRight, b.scrollWidth - b.clientWidth) - Math.max(a.right - a.stageRight, a.scrollWidth - a.clientWidth))
            .slice(0, 6);
        })(),
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    })()`);
    if (
      memoryMetrics.view !== 'active'
      || !memoryMetrics.liveHidden
      || !memoryMetrics.archiveVisible
      || memoryMetrics.cards < 3
      || memoryMetrics.lineages + memoryMetrics.reviewActions !== memoryMetrics.cards
      || memoryMetrics.proofCards !== memoryMetrics.cards
      || memoryMetrics.wisdom !== 3
      || memoryMetrics.recordMetric < memoryMetrics.cards
      || memoryMetrics.evidenceMetric < 1
      || memoryMetrics.decisionMetric < 0
      || !memoryMetrics.decisionMetricText.includes('확인 완료')
      || !memoryMetrics.optionalDecisionState.includes('확인할 결과 없음')
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

    const auditOutputs = [];
    for (const [view, selector] of [['waiting','#attentionInbox'],['runtime','#automationOverview'],['terminal','#terminalSection'],['tmux','#tmuxSection'],['settings','#settingsSection']]) {
      auditOutputs.push(await capture(win, `round43-${view}.png`, view, selector));
    }

    win.setSize(390, 844);
    await wait(300);
    await stabilizeView(win, 'active', '#sessionSection');
    const mobileMetrics = await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('#sessionGrid .memory-record');
      const cardRect = card?.getBoundingClientRect();
      const mobileNav = document.querySelector('#projectViewTabs');
      const mobileNavRect = mobileNav?.getBoundingClientRect();
      const activeNavButton = mobileNav?.querySelector('[data-view].active');
      const activeNavRect = activeNavButton?.getBoundingClientRect();
      const moreButton = document.querySelector('#mobileMoreBtn');
      const moreRect = moreButton?.getBoundingClientRect();
      const usableBottom = window.innerHeight;
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
        mobileNavVisible: Boolean(mobileNavRect && activeNavRect && moreRect
          && getComputedStyle(mobileNav).display !== 'none'
          && mobileNavRect.width > 0 && mobileNavRect.height >= 44
          && activeNavRect.width >= 44 && activeNavRect.height >= 44
          && moreRect.width >= 44 && moreRect.height >= 44
          && mobileNavRect.top >= 0 && mobileNavRect.bottom <= window.innerHeight),
      };
    })()`);
    const mobileOutput = await capture(win, 'loadtoagent-philosophical-memory-mobile.png', 'active', '#sessionSection');
    if (mobileMetrics.view !== 'active' || mobileMetrics.activeNav !== 'active' || mobileMetrics.sectionOpacity < .99 || mobileMetrics.pageOverflow || mobileMetrics.stageOverflow || !mobileMetrics.firstCardVisible || !mobileMetrics.mobileNavVisible) {
      throw new Error(`기억 모바일 계약 실패: ${JSON.stringify(mobileMetrics)}`);
    }

    console.log('쉬운 표현 UI 및 기능 연결 검증 통과');
    console.log(JSON.stringify({ nowMetrics, memoryMetrics, memoryDrawer, toolViews, mobileMetrics }, null, 2));
    console.log(nowOutput);
    console.log(memoryOutput);
    console.log(mobileOutput);
    auditOutputs.forEach(output => console.log(output));
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
}).catch(error => {
  console.error(error);
  app.exit(1);
});
