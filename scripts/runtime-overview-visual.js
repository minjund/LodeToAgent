'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-runtime-overview-'));
app.setPath('userData', userData);
app.once('quit', () => fs.rmSync(userData, { recursive: true, force: true }));

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForRenderer(win) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await win.webContents.executeJavaScript(`Boolean(window.LoadToAgentApp?.state?.snapshot && document.querySelector('#automationOverview'))`)) return;
    await wait(75);
  }
  throw new Error('스케줄·루프 관제 화면이 준비되지 않았습니다.');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
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
    await waitForRenderer(win);
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentI18n.setLocale('ko');
      window.LoadToAgentApp.state.guideExpanded = false;
      window.LoadToAgentApp.selectView('all');
      window.__runtimeHomeDetached = document.querySelector('#automationOverview').classList.contains('hidden');
      window.LoadToAgentApp.selectView('runtime');
      const modal = document.querySelector('#runModal');
      modal.classList.add('hidden');
      modal.classList.remove('closing');
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const section = document.querySelector('#automationOverview');
        const stage = document.querySelector('.main-stage');
        for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} }
        stage.scrollTo(0, 0);
        void section.offsetHeight;
        resolve();
      })));
    })()`);
    await wait(120);
    const metrics = await win.webContents.executeJavaScript(`(() => {
      const section = document.querySelector('#automationOverview');
      const stage = document.querySelector('.main-stage');
      return {
        visible: !section.classList.contains('hidden'),
        activeNav: document.querySelector('.view-nav .nav-item.active')?.dataset.view || '',
        homeDetached: Boolean(window.__runtimeHomeDetached),
        schedules: section.querySelectorAll('.runtime-schedule-card').length,
        enabledSchedules: section.querySelectorAll('.runtime-schedule-card[data-automation-enabled="true"]').length,
        pausedSchedules: section.querySelectorAll('.runtime-schedule-card[data-automation-enabled="false"]').length,
        phases: section.querySelectorAll('[data-loop-phase]').length,
        activePhases: section.querySelectorAll('[data-loop-phase].active').length,
        loopTabs: section.querySelectorAll('[data-loop-select]').length,
        inferredLabel: section.querySelector('.runtime-loop-cycle')?.getAttribute('aria-label') || '',
        scheduledIteration: section.querySelector('.runtime-loop-footer')?.textContent.includes('예약 실행') || false,
        duplicateTitle: section.querySelector('h2')?.textContent.trim() === document.querySelector('#pageTitle')?.textContent.trim(),
        modalHidden: document.querySelector('#runModal').classList.contains('hidden'),
        noSectionOverflow: section.scrollWidth <= section.clientWidth + 2,
        noStageOverflow: stage.scrollWidth <= stage.clientWidth + 2,
      };
    })()`);
    if (!metrics.visible || metrics.activeNav !== 'runtime' || !metrics.homeDetached || metrics.schedules !== 7 || metrics.enabledSchedules !== 6 || metrics.pausedSchedules !== 1 || metrics.phases !== 4 || metrics.activePhases !== 1
      || metrics.loopTabs !== 6 || !metrics.inferredLabel.includes('입력') || !metrics.scheduledIteration || metrics.duplicateTitle
      || !metrics.modalHidden || !metrics.noSectionOverflow || !metrics.noStageOverflow) {
      throw new Error(`스케줄·루프 시각 검증 실패: ${JSON.stringify(metrics)}`);
    }
    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });
    const output = path.join(outputDir, 'loadtoagent-runtime-overview.png');
    fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
    process.stdout.write(`스케줄·루프 시각 검증 통과: ${JSON.stringify(metrics)}\n${output}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
