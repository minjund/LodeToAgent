'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { AttentionPopupManager } = require('../src/attentionPopupManager');

const root = path.resolve(__dirname, '..');
const temporaryUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-popup-e2e-'));
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
  const openedInMain = [];
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
    onOpenMain: request => {
      openedInMain.push(request.id);
      return { ok: true };
    },
  });
  ipcMain.handle('attention-popup:ready', (event, payload) => manager.handleReady(event, payload));
  ipcMain.handle('attention-popup:resize', (event, payload) => manager.handleResize(event, payload));
  ipcMain.handle('attention-popup:decide', (event, payload) => manager.handleDecide(event, payload));
  ipcMain.handle('attention-popup:dismiss', event => manager.handleDismiss(event));
  ipcMain.handle('attention-popup:open-main', event => manager.handleOpenMain(event));

  manager.reconcile('e2e', [
    {
      id: 'permission', type: 'permission', provider: 'Codex', project: 'Whitebox',
      title: '권한 요청', body: '', detail: 'npm test -- --runInBand', toolLabel: 'Bash',
      meta: 'Whitebox · #Tzi', openMain: true, openMainLabel: '터미널로 이동', dismissible: false,
      permissionSuggestions: [{ id: 'always-npm-test', label: '항상 허용 `npm test`', description: '이 명령 패턴에 다시 묻지 않습니다.' }],
    },
    {
      id: 'question', type: 'question', provider: 'Claude', project: 'Whitebox',
      title: '실행 환경 선택', body: '작업을 계속하려면 답변이 필요합니다.', canDeny: true,
      denyLabel: '거부', openMain: true, openMainLabel: '터미널로 이동',
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
  const questionImage = await questionEntry.window.webContents.capturePage();
  const questionScreenshot = path.join(artifactDirectory, 'attention-popup-question.png');
  fs.writeFileSync(questionScreenshot, questionImage.toPNG());

  const permissionEntry = manager.windows.get('e2e\u0000permission');
  await waitFor(() => permissionEntry.height > 180);
  const permissionUi = await permissionEntry.window.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#popupCard');
    const group = document.querySelector('.permission-actions');
    const suggestion = document.querySelector('.popup-button.suggestion');
    const suggestionDescriptionId = suggestion?.getAttribute('aria-describedby') || '';
    return {
      role: card?.getAttribute('role'),
      describedBy: card?.getAttribute('aria-describedby'),
      title: document.querySelector('.popup-title')?.textContent,
      tool: document.querySelector('.popup-tool-pill')?.textContent,
      meta: document.querySelector('.popup-meta')?.textContent,
      command: document.querySelector('.popup-command')?.textContent,
      groupRole: group?.getAttribute('role'),
      groupLabel: group?.getAttribute('aria-label'),
      buttons: [...group.querySelectorAll('.popup-button')].map(button => button.getAttribute('aria-label') || button.textContent.trim()),
      suggestionDescriptionId,
      suggestionDescription: suggestionDescriptionId ? document.getElementById(suggestionDescriptionId)?.textContent : '',
      errorRole: document.querySelector('.popup-error')?.getAttribute('role'),
    };
  })()`, true);
  assert.deepStrictEqual(permissionUi, {
    role: 'dialog',
    describedBy: 'popupCommand',
    title: '권한 요청',
    tool: 'Bash',
    meta: 'Whitebox · #Tzi',
    command: 'npm test -- --runInBand',
    groupRole: 'group',
    groupLabel: '권한 선택',
    buttons: ['허용', '거부', '항상 허용 `npm test`', '터미널로 이동'],
    suggestionDescriptionId: 'permissionSuggestionDescription0',
    suggestionDescription: '이 명령 패턴에 다시 묻지 않습니다.',
    errorRole: 'alert',
  });
  const permissionImage = await permissionEntry.window.webContents.capturePage();
  const permissionScreenshot = path.join(artifactDirectory, 'attention-popup-permission.png');
  fs.writeFileSync(permissionScreenshot, permissionImage.toPNG());

  const questionUi = await questionEntry.window.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#popupCard');
    const group = document.querySelector('.question-actions');
    return {
      describedBy: card?.getAttribute('aria-describedby'),
      groupRole: group?.getAttribute('role'),
      groupLabel: group?.getAttribute('aria-label'),
      buttons: [...group.querySelectorAll('.popup-button')].map(button => button.textContent.trim()),
    };
  })()`, true);
  assert.deepStrictEqual(questionUi, {
    describedBy: 'popupBody',
    groupRole: 'group',
    groupLabel: '질문 응답',
    buttons: ['답변 보내기', '거부', '터미널로 이동'],
  });

  await permissionEntry.window.webContents.executeJavaScript("document.querySelector('.popup-button.allow').click()", true);
  await waitFor(() => decisions.some(item => item.request.id === 'permission'));
  await questionEntry.window.webContents.executeJavaScript("document.querySelector('input[value=\"Windows\"]').click(); document.querySelector('.popup-form').requestSubmit()", true);
  await waitFor(() => decisions.some(item => item.request.id === 'question'));
  assert.deepStrictEqual(decisions.find(item => item.request.id === 'permission').decision, { action: 'allow' });
  assert.deepStrictEqual(decisions.find(item => item.request.id === 'question').decision, {
    action: 'answer', answers: [{ questionId: 'environment', values: ['Windows'], otherText: '', text: '' }],
  });

  manager.reconcile('e2e', [{
    id: 'permission-suggestion', type: 'permission', title: '권한 요청', detail: 'npm test', toolLabel: 'Bash',
    permissionSuggestions: [{ id: 'always-npm-test', label: '항상 허용 `npm test`' }],
  }]);
  const suggestionEntry = manager.windows.get('e2e\u0000permission-suggestion');
  await waitFor(() => suggestionEntry?.ready && suggestionEntry.presented);
  await suggestionEntry.window.webContents.executeJavaScript("document.querySelector('.popup-button.suggestion').click()", true);
  await waitFor(() => decisions.some(item => item.request.id === 'permission-suggestion'));
  assert.deepStrictEqual(decisions.find(item => item.request.id === 'permission-suggestion').decision, {
    action: 'suggestion', suggestionId: 'always-npm-test',
  });

  manager.reconcile('e2e', [{
    id: 'permission-open', type: 'permission', title: '권한 요청', detail: 'npm test', toolLabel: 'Bash',
    openMain: true, openMainLabel: '터미널로 이동',
  }]);
  const openEntry = manager.windows.get('e2e\u0000permission-open');
  await waitFor(() => openEntry?.ready && openEntry.presented);
  await openEntry.window.webContents.executeJavaScript("document.querySelector('.popup-button.open-main').click()", true);
  await waitFor(() => openedInMain.includes('permission-open'));
  await waitFor(() => !manager.windows.has('e2e\u0000permission-open'));

  manager.reconcile('e2e', [{
    id: 'question-deny', type: 'question', title: '질문', body: '계속 진행할까요?', canDeny: true,
    questions: [{ id: 'continue', question: '계속 진행할까요?', options: [{ id: 'yes', value: '예', label: '예' }] }],
  }]);
  const denyQuestionEntry = manager.windows.get('e2e\u0000question-deny');
  await waitFor(() => denyQuestionEntry?.ready && denyQuestionEntry.presented);
  await denyQuestionEntry.window.webContents.executeJavaScript("document.querySelector('.popup-button.question-deny').click()", true);
  await waitFor(() => decisions.some(item => item.request.id === 'question-deny'));
  assert.deepStrictEqual(decisions.find(item => item.request.id === 'question-deny').decision, { action: 'deny' });

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
    "document.querySelector('.popup-command')?.textContent === 'new revision' && !document.querySelector('.popup-button.deny')?.disabled",
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

  manager.reconcile('e2e', [{ id: 'toggle', type: 'input', title: '입력 필요', body: 'Whitebox에서 답해 주세요.' }]);
  assert.equal(manager.status().windowCount, 1);
  manager.setEnabled(false);
  assert.equal(manager.status().windowCount, 0);
  manager.setEnabled(true);
  assert.equal(manager.status().windowCount, 1);
  manager.dispose();
  return { permissionScreenshot, questionScreenshot };
}

run().then(({ permissionScreenshot, questionScreenshot }) => {
  process.stdout.write(`Attention popup integration passed: ${permissionScreenshot}; ${questionScreenshot}\n`);
  app.quit();
}, error => {
  process.stderr.write(`${error.stack}\n`);
  app.exit(1);
}).finally(() => {
  try { fs.rmSync(temporaryUserData, { recursive: true, force: true }); } catch {}
});
