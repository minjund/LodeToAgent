'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { AttentionPopupManager } = require('../src/attentionPopupManager');

const root = path.resolve(__dirname, '..');
const temporaryUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-popup-e2e-'));
app.setPath('userData', temporaryUserData);
app.commandLine.appendSwitch('disable-gpu');

function waitFor(check, timeoutMs = 8_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      let value;
      try { value = await check(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - startedAt >= timeoutMs) { reject(new Error('Attention popup integration timed out.')); return; }
      setTimeout(poll, 30);
    };
    poll();
  });
}

async function run() {
  await app.whenReady();
  const decisions = [];
  let finishOldRevision = null;
  const manager = new AttentionPopupManager({
    BrowserWindow,
    screen,
    preloadPath: path.join(root, 'attention-popup-preload.js'),
    htmlPath: path.join(root, 'renderer', 'attention-popup.html'),
    enabled: true,
    onDecide: (request, decision) => {
      decisions.push({ request, decision });
      if (request.id === 'revision-race' && request.body === 'old revision') {
        return new Promise(resolve => { finishOldRevision = resolve; });
      }
      return { ok: true };
    },
    onDismiss: () => ({ ok: true }),
    onOpenMain: () => ({ ok: true }),
  });
  ipcMain.handle('attention-popup:ready', (event, payload) => manager.handleReady(event, payload));
  ipcMain.handle('attention-popup:resize', (event, payload) => manager.handleResize(event, payload));
  ipcMain.handle('attention-popup:decide', (event, payload) => manager.handleDecide(event, payload));
  ipcMain.handle('attention-popup:dismiss', event => manager.handleDismiss(event));
  ipcMain.handle('attention-popup:open-main', event => manager.handleOpenMain(event));

  manager.reconcile('e2e', [
    {
      id: 'permission', type: 'permission', provider: 'Codex', project: 'LoadToAgent',
      title: '명령 실행 권한', body: 'npm test 명령을 실행하도록 허용할까요?', detail: 'npm test',
    },
    {
      id: 'question', type: 'question', provider: 'Claude', project: 'LoadToAgent',
      title: '실행 환경 선택', body: '작업을 계속하려면 답변이 필요합니다.',
      questions: [{
        id: 'environment', header: '실행 환경', question: '어디서 실행할까요?', allowOther: true,
        options: [{ id: 'windows', value: 'Windows', label: 'Windows' }, { id: 'wsl', value: 'WSL', label: 'WSL' }],
      }],
    },
  ]);
  await waitFor(() => [...manager.windows.values()].every(entry => entry.ready && entry.presented));
  const workArea = screen.getPrimaryDisplay().workArea;
  for (const entry of manager.windows.values()) {
    const bounds = entry.window.getBounds();
    assert.ok(bounds.x >= workArea.x && bounds.y >= workArea.y);
    assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
    assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
  }

  const questionEntry = manager.windows.get('e2e\u0000question');
  await waitFor(() => questionEntry.height > 300);
  const artifactDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const image = await questionEntry.window.webContents.capturePage();
  const screenshot = path.join(artifactDirectory, 'attention-popup-question.png');
  fs.writeFileSync(screenshot, image.toPNG());

  const permissionEntry = manager.windows.get('e2e\u0000permission');
  await permissionEntry.window.webContents.executeJavaScript("document.querySelector('.popup-button.allow').click()", true);
  await waitFor(() => decisions.some(item => item.request.id === 'permission'));
  await questionEntry.window.webContents.executeJavaScript("document.querySelector('input[value=\"Windows\"]').click(); document.querySelector('.popup-form').requestSubmit()", true);
  await waitFor(() => decisions.some(item => item.request.id === 'question'));
  assert.deepStrictEqual(decisions.find(item => item.request.id === 'permission').decision, { action: 'allow' });
  assert.deepStrictEqual(decisions.find(item => item.request.id === 'question').decision, {
    action: 'answer', answers: [{ questionId: 'environment', values: ['Windows'], otherText: '', text: '' }],
  });

  manager.reconcile('e2e', [{
    id: 'revision-race', type: 'permission', title: '갱신 전 권한', body: 'old revision',
  }]);
  const raceEntry = manager.windows.get('e2e\u0000revision-race');
  await waitFor(() => raceEntry?.ready && raceEntry.presented);
  await raceEntry.window.webContents.executeJavaScript("document.querySelector('.popup-button.allow').click()", true);
  await waitFor(() => typeof finishOldRevision === 'function');
  manager.reconcile('e2e', [{
    id: 'revision-race', type: 'permission', title: '갱신 후 권한', body: 'new revision',
  }]);
  await waitFor(() => raceEntry.window.webContents.executeJavaScript(
    "document.querySelector('.popup-body')?.textContent === 'new revision' && !document.querySelector('.popup-button.deny')?.disabled",
    true,
  ));
  finishOldRevision({ ok: true });
  await waitFor(() => !raceEntry.busy);
  assert.strictEqual(manager.windows.get('e2e\u0000revision-race'), raceEntry);
  assert.equal(raceEntry.window.isDestroyed(), false);
  await raceEntry.window.webContents.executeJavaScript("document.querySelector('.popup-button.deny').click()", true);
  await waitFor(() => decisions.filter(item => item.request.id === 'revision-race').length === 2);
  assert.deepStrictEqual(
    decisions.filter(item => item.request.id === 'revision-race').map(item => [item.request.body, item.decision.action]),
    [['old revision', 'allow'], ['new revision', 'deny']],
  );
  await waitFor(() => !manager.windows.has('e2e\u0000revision-race'));

  manager.reconcile('e2e', [{ id: 'toggle', type: 'input', title: '입력 필요', body: 'LoadToAgent에서 답해 주세요.' }]);
  assert.equal(manager.status().windowCount, 1);
  manager.setEnabled(false);
  assert.equal(manager.status().windowCount, 0);
  manager.setEnabled(true);
  assert.equal(manager.status().windowCount, 1);
  manager.dispose();
  return screenshot;
}

run().then(screenshot => {
  process.stdout.write(`Attention popup integration passed: ${screenshot}\n`);
  app.quit();
}, error => {
  process.stderr.write(`${error.stack}\n`);
  app.exit(1);
}).finally(() => {
  try { fs.rmSync(temporaryUserData, { recursive: true, force: true }); } catch {}
});
