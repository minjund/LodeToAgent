'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-work-progress-'));
app.setPath('userData', userData);
app.once('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(win, expression, message, attempts = 140) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await wait(60);
  }
  throw new Error(message);
}

async function capture(win, output) {
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  win.webContents.invalidate();
  await wait(500);
  fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
}

async function progressMetrics(win) {
  return win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('[data-workflow-progress="fixture-root"]');
    const canvas = document.querySelector('.agent-workflow-canvas');
    const grid = document.querySelector('.agent-workflow-grid');
    const events = panel?.querySelector('.workflow-progress-events');
    const fontSize = selector => Number.parseFloat(getComputedStyle(panel.querySelector(selector)).fontSize);
    const panelRect = panel?.getBoundingClientRect();
    const gridRect = grid?.getBoundingClientRect();
    return {
      width: innerWidth,
      panelVisible: Boolean(panelRect && panelRect.width > 0 && panelRect.height > 0),
      panelBeforeWorkflow: Boolean(panelRect && gridRect && panelRect.bottom <= gridRect.top + 1),
      graphComposerCount: canvas?.querySelectorAll('.agent-command-panel').length || 0,
      currentStep: panel?.querySelector('.workflow-progress-now > strong')?.textContent.trim() || '',
      recordedMetrics: panel?.querySelectorAll('.workflow-progress-metrics > div').length || 0,
      eventCount: events?.children.length || 0,
      eventSummary: panel?.querySelector('.workflow-progress-activity > header > span')?.textContent.trim() || '',
      progressbarCount: panel?.querySelectorAll('[role="progressbar"]').length || 0,
      internalTimelineScroll: Boolean(events && ['auto', 'scroll'].includes(getComputedStyle(events).overflowY)),
      minimumCopySize: Math.min(
        fontSize('.workflow-progress-head p'),
        fontSize('.workflow-progress-status small'),
        fontSize('.workflow-progress-metrics dt'),
        fontSize('.workflow-progress-event-copy small'),
        fontSize('footer small')
      ),
      conversationEntryVisible: Boolean(document.querySelector('.agent-workflow-selected [data-open-session="fixture-root"]')),
      canvasOverflow: Boolean(canvas && canvas.scrollWidth > canvas.clientWidth + 2),
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    };
  })()`);
}

function assertProgress(metrics) {
  if (!metrics.panelVisible || !metrics.panelBeforeWorkflow || metrics.graphComposerCount !== 0
    || !metrics.currentStep || metrics.recordedMetrics !== 3 || metrics.eventCount < 1 || metrics.eventCount > 5
    || !metrics.eventSummary || metrics.progressbarCount !== 1 || metrics.internalTimelineScroll
    || metrics.minimumCopySize < 12 || !metrics.conversationEntryVisible
    || metrics.canvasOverflow || metrics.documentOverflow) {
    throw new Error(`작업 진행 화면 검증 실패: ${JSON.stringify(metrics)}`);
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500,
    height: 1000,
    show: true,
    backgroundColor: '#050506',
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
    await waitFor(win, 'Boolean(window.LoadToAgentApp?.initialized && window.LoadToAgentApp?.state?.snapshot)', '앱 준비 시간 초과');
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentI18n.setLocale('ko');
      const control = window.LoadToAgentApp;
      control.state.guideExpanded = false;
      control.state.workspace = 'D:\\\\fixture';
      control.state.view = 'all';
      control.state.graphFocusId = 'fixture-root';
      control.render('filter');
      control.renderSessions();
      requestAnimationFrame(() => {
        const canvas = document.querySelector('.agent-workflow-canvas');
        const stage = document.querySelector('.main-stage');
        if (canvas && stage) stage.scrollTo(0, Math.max(0, canvas.offsetTop - 96));
      });
    })()`);
    await waitFor(win, `Boolean(document.querySelector('[data-workflow-progress="fixture-root"]')
      && !document.querySelector('.agent-workflow-canvas .agent-command-panel'))`, '작업 진행 패널 준비 시간 초과');

    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });
    const desktopMetrics = await progressMetrics(win);
    assertProgress(desktopMetrics);
    const desktopOutput = path.join(outputDir, 'loadtoagent-work-progress.png');
    await capture(win, desktopOutput);

    win.setContentSize(420, 900);
    await wait(300);
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentApp.renderSessions();
      const canvas = document.querySelector('.agent-workflow-canvas');
      const stage = document.querySelector('.main-stage');
      if (canvas && stage) stage.scrollTo(0, Math.max(0, canvas.offsetTop - 96));
    })()`);
    await waitFor(win, `document.querySelector('[data-workflow-progress="fixture-root"]')?.getBoundingClientRect().width > 0`, '작은 화면 진행 패널 준비 시간 초과');
    const mobileMetrics = await progressMetrics(win);
    assertProgress(mobileMetrics);
    const mobileOutput = path.join(outputDir, 'loadtoagent-work-progress-mobile.png');
    await capture(win, mobileOutput);

    process.stdout.write(`작업 진행 화면 시각 검증 통과\n${JSON.stringify({ desktopMetrics, mobileMetrics }, null, 2)}\n${desktopOutput}\n${mobileOutput}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
