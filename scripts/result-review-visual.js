'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-result-review-'));
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

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    backgroundColor: '#08111b',
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
    await waitFor(win, 'Boolean(window.LoadToAgentApp?.initialized)', '앱 초기화를 기다리다 시간이 초과되었습니다.');
    await win.webContents.executeJavaScript(`(() => {
      const control = window.LoadToAgentApp;
      window.LoadToAgentI18n.setLocale('ko');
      control.state.workspace = 'D:\\\\fixture';
      control.state.providerFilters.clear();
      control.state.search = '';
      control.selectView('all');
      control.render();
    })()`);
    await waitFor(
      win,
      `document.querySelector('#operationsOverview')?.classList.contains('hidden')
        && !document.querySelector('.home-attention-item')
        && getComputedStyle(document.querySelector('.control-project-body .control-session-live')).display === 'none'
        && Boolean(window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-failed'))`,
      '프로젝트 화면의 중복 결과 안내가 제거되지 않았습니다.',
    );
    const before = await win.webContents.executeJavaScript(`(() => {
      const session = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === 'fixture-failed');
      return {
        id: session?.id || '',
        reviewNeeded: window.LoadToAgentApp.needsManagementReview(session),
        duplicateNoticeRemoved: !document.querySelector('.home-attention-item'),
        duplicateProgressRemoved: getComputedStyle(document.querySelector('.control-project-body .control-session-live')).display === 'none',
      };
    })()`);
    if (!before.id || !before.reviewNeeded || !before.duplicateNoticeRemoved || !before.duplicateProgressRemoved) {
      throw new Error(`프로젝트 결과 상태가 올바르지 않습니다: ${JSON.stringify(before)}`);
    }

    await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('${before.id}', { tab: 'summary' })`);
    await waitFor(
      win,
      `document.querySelector('#detailDrawer')?.classList.contains('open')
        && window.LoadToAgentApp.state.drawerTab === 'summary'
        && Boolean(document.querySelector('[data-result-review-complete]'))`,
      '결과 카드가 확인 완료 버튼이 있는 결과 화면을 열지 못했습니다.',
    );
    const drawer = await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-result-review-complete]');
      const bounds = button?.getBoundingClientRect();
      return {
        id: button?.dataset.resultReviewComplete || '',
        label: button?.textContent.trim() || '',
        visible: Boolean(bounds && bounds.width > 0 && bounds.height > 0),
      };
    })()`);
    if (drawer.id !== before.id || drawer.label !== '확인 완료' || !drawer.visible) {
      throw new Error(`결과 확인 버튼이 올바르지 않습니다: ${JSON.stringify(drawer)}`);
    }
    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });
    const output = path.join(outputDir, 'loadtoagent-result-review.png');
    win.show();
    win.webContents.invalidate();
    await wait(520);
    fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());

    await win.webContents.executeJavaScript(`document.querySelector('[data-result-review-complete]').click()`);
    await waitFor(
      win,
      `!document.querySelector('#detailDrawer')?.classList.contains('open')
        && window.LoadToAgentApp.isResultReviewComplete(
          window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === '${before.id}')
        )
        && !window.LoadToAgentApp.needsManagementReview(
          window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === '${before.id}')
        )
        && Boolean(localStorage.getItem(window.LoadToAgentApp.RESULT_REVIEW_STORAGE_KEY))`,
      '확인 완료한 결과가 저장되거나 목록에서 제거되지 않았습니다.',
    );

    await win.webContents.executeJavaScript(`(() => {
      const control = window.LoadToAgentApp;
      const session = control.state.snapshot.sessions.find(item => item.id === '${before.id}');
      const nextAt = new Date(Date.parse(session.updatedAt || 0) + 60_000).toISOString();
      session.updatedAt = nextAt;
      session.completedAt = nextAt;
      session.outcome = { ...session.outcome, completedAt: nextAt, summary: (session.outcome?.summary || '') + ' · 새 결과' };
      control.render();
    })()`);
    await waitFor(
      win,
      `!document.querySelector('.home-attention-item')
        && !window.LoadToAgentApp.isResultReviewComplete(
          window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === '${before.id}')
        )
        && window.LoadToAgentApp.needsManagementReview(
          window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === '${before.id}')
        )`,
      '같은 세션의 새 결과가 다시 확인 목록에 나타나지 않았습니다.',
    );

    process.stdout.write(`결과 확인 완료 UI 검증 통과\n${JSON.stringify({ before, drawer, newResultReturned: true }, null, 2)}\n${output}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
