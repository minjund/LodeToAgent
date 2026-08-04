'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-subagent-response-'));
app.setPath('userData', userData);
app.once('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(win, expression, message, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await wait(50);
  }
  throw new Error(message);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1700,
    height: 980,
    show: false,
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
    await waitFor(win, 'Boolean(window.LoadToAgentApp?.initialized && window.LoadToAgentApp?.state?.snapshot)', '앱 픽스처가 준비되지 않았습니다.');
    await win.webContents.executeJavaScript(`(() => {
      const control = window.LoadToAgentApp;
      window.LoadToAgentI18n.setLocale('ko');
      control.state.view = 'all';
      control.state.workspace = 'D:\\\\fixture';
      control.state.provider = 'all';
      control.state.providerFilters.clear();
      control.render('filter');
      control.openSubagentConversation('fixture-child', { context: true });
    })()`);
    await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open')
      && document.querySelector('#detailDrawer')?.dataset.mode === 'subagent'
      && document.querySelector('[data-subagent-work-messages="2"]')
      && document.querySelector('#drawerContent .chat-row.assistant')?.innerText.includes('실행 구조, 대화 기록, 직접 개입과 메인 에이전트 경유 개입')
      && document.querySelector('#drawerComposer')?.classList.contains('hidden')
      && !document.querySelector('.subagent-assignment-card')`, '진행 응답 중심의 서브에이전트 상세가 준비되지 않았습니다.');

    await win.webContents.executeJavaScript(`window.LoadToAgentApp.openSubagentConversation('fixture-resting', { context: true })`);
    await waitFor(win, `document.querySelector('[data-subagent-work-messages="3"]')
      && document.querySelector('#drawerContent .chat-row.assistant:last-of-type')?.innerText.includes('검토 결과 이상이 없습니다.')
      && document.querySelector('#drawerComposer')?.classList.contains('hidden')`, '최종 응답이 서브에이전트 상세에 표시되지 않았습니다.');

    const metrics = await win.webContents.executeJavaScript(`(() => {
      const text = document.querySelector('#drawerContent')?.innerText || '';
      return {
        mode: document.querySelector('#detailDrawer')?.dataset.mode || '',
        workMessages: Number(document.querySelector('[data-subagent-work-messages]')?.dataset.subagentWorkMessages || 0),
        assistantMessages: document.querySelectorAll('#drawerContent .chat-row.assistant').length,
        finalResponseVisible: text.includes('검토 결과 이상이 없습니다.'),
        composerHidden: document.querySelector('#drawerComposer')?.classList.contains('hidden')
          && !document.querySelector('#drawerComposer [data-agent-command-form], #drawerComposer [data-agent-command-draft]'),
        protectedCopyHidden: !text.includes('실제로 보낸 작업 지시는')
          && !text.includes('도움 AI에게 일을 맡기기 직전')
          && !text.includes('gAAAAABfixtureProtectedPayload=='),
      };
    })()`);
    if (metrics.mode !== 'subagent' || metrics.workMessages !== 3 || metrics.assistantMessages < 2
      || !metrics.finalResponseVisible || !metrics.composerHidden || !metrics.protectedCopyHidden) {
      throw new Error(`서브에이전트 응답 상세 검증 실패: ${JSON.stringify(metrics)}`);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, metrics }, null, 2)}\n`);
  } finally {
    win.destroy();
    app.quit();
  }
}).catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.quit();
  process.exitCode = 1;
});
