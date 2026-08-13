'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

process.env.WHITEBOX_TEST_UPDATE_BOOTSTRAP_RACE = '1';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-completion-status-'));
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

async function capture(win, output) {
  await win.webContents.executeJavaScript(
    'document.fonts.ready.then(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } return true; })',
  );
  win.webContents.invalidate();
  await wait(220);
  fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
  return output;
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
    await waitFor(win, 'Boolean(window.WhiteboxApp?.initialized)', '앱 초기화를 기다리다 시간이 초과되었습니다.');
    await waitFor(
      win,
      `window.WhiteboxApp.state.update.status === 'current'
        && !document.querySelector('#checkUpdateBtn').disabled
        && document.querySelector('#updatePanel').dataset.updateStatus === 'current'`,
      'bootstrap 도중 끝난 업데이트 확인 상태를 놓쳐 확인 화면이 멈췄습니다.',
    );
    await win.webContents.executeJavaScript(`(() => {
      const completedAt = new Date().toISOString();
      window.interactionTest.addSession({
        id: 'fixture-project-result-ready', externalId: 'fixture-project-result-ready-external',
        provider: 'codex', model: 'gpt-fixture', title: '자동 시작 작업 결과 확인',
        cwd: 'D:\\\\fixture-other', originCwd: 'D:\\\\fixture-other', workspace: '자동 시작 작업 결과',
        status: 'completed', statusDetail: '작업 완료', completionObserved: true,
        completedAt, updatedAt: completedAt, parentId: null, childIds: [], executions: [],
        messages: [{ id: 'project-result', role: 'assistant', text: '요청한 자동 시작 작업을 모두 마쳤습니다.', timestamp: completedAt }],
        outcome: { status: 'completed', verified: true, completedAt, summary: '자동 시작 작업을 모두 마쳤습니다.' },
      });
      window.interactionTest.emitSnapshot();
      window.WhiteboxApp.render();
    })()`);
    await waitFor(
      win,
      `Boolean([...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(item => item.dataset.workspace === 'D:\\\\fixture-other')
        ?.querySelector('.project-sidebar-result-ready'))`,
      '완료 결과가 있는 프로젝트 배지를 찾지 못했습니다.',
    );
    await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      window.WhiteboxI18n.setLocale('ko');
      control.state.workspace = control.state.snapshot.sessions.find(item => item.id === 'fixture-root').cwd;
      control.state.providerFilters.clear();
      control.state.search = '';
      control.selectView('active');
      control.render();
    })()`);
    await waitFor(
      win,
      `Boolean(document.querySelector('.memory-record[data-session-id="fixture-ended"].task-completed .memory-review-status.completed'))`,
      '완료된 작업 카드에서 작업 완료 상태를 찾지 못했습니다.',
    );

    const completion = await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.memory-record[data-session-id="fixture-ended"]');
      const badge = card?.querySelector('.memory-review-status.completed');
      const badgeBounds = badge?.getBoundingClientRect();
      const style = badge ? getComputedStyle(badge) : null;
      return {
        cardVisible: Boolean(card?.getBoundingClientRect().height),
        badgeVisible: Boolean(badgeBounds && badgeBounds.width > 0 && badgeBounds.height > 0),
        text: badge?.textContent.trim() || '',
        color: style?.color || '',
        background: style?.backgroundColor || '',
        legacyAttentionVisible: [...document.querySelectorAll('.memory-review-status')]
          .some(item => /확인 필요/.test(item.textContent || '')),
      };
    })()`);
    if (!completion.cardVisible || !completion.badgeVisible
      || completion.text !== '현재 상태: 작업 완료'
      || completion.legacyAttentionVisible) {
      throw new Error(`완료 상태 배지가 올바르지 않습니다: ${JSON.stringify(completion)}`);
    }

    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputs = {};
    const themeStates = {};
    win.show();
    for (const theme of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`window.WhiteboxTheme.setTheme(${JSON.stringify(theme)})`);
      await waitFor(
        win,
        `document.documentElement.dataset.theme === ${JSON.stringify(theme)}
          && Boolean(document.querySelector('.memory-record[data-session-id="fixture-ended"] .memory-review-status.completed'))`,
        `${theme} 테마의 작업 완료 상태가 준비되지 않았습니다.`,
      );
      themeStates[theme] = await win.webContents.executeJavaScript(`(() => {
        const badge = document.querySelector('.memory-record[data-session-id="fixture-ended"] .memory-review-status.completed');
        const card = badge?.closest('.memory-record');
        const projectButton = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
          .find(item => item.dataset.workspace === 'D:\\\\fixture-other');
        const projectBadge = projectButton?.querySelector('.project-sidebar-result-ready');
        const probe = document.createElement('i');
        probe.style.color = 'var(--theme-success)';
        document.body.appendChild(probe);
        const successColor = getComputedStyle(probe).color;
        probe.remove();
        return {
          badgeColor: getComputedStyle(badge).color,
          badgeBackground: getComputedStyle(badge).backgroundColor,
          cardBorder: getComputedStyle(card).borderColor,
          successColor,
          projectBadgeVisible: Boolean(projectBadge?.getBoundingClientRect().width && projectBadge?.getBoundingClientRect().height),
          projectBadgeText: projectBadge?.textContent.replace(/\s+/g, ' ').trim() || '',
          projectBadgeColor: projectBadge ? getComputedStyle(projectBadge.querySelector('b')).color : '',
        };
      })()`);
      if (themeStates[theme].badgeColor !== themeStates[theme].successColor) {
        throw new Error(`${theme} 테마의 작업 완료 배지가 성공 색상을 사용하지 않습니다: ${JSON.stringify(themeStates[theme])}`);
      }
      if (!themeStates[theme].projectBadgeVisible || !/^1\s*완료 결과$/.test(themeStates[theme].projectBadgeText)) {
        throw new Error(`${theme} 테마의 프로젝트 완료 결과 배지가 올바르지 않습니다: ${JSON.stringify(themeStates[theme])}`);
      }
      outputs[theme] = await capture(win, path.join(outputDir, `whitebox-result-review-${theme}.png`));
    }
    fs.copyFileSync(outputs.light, path.join(outputDir, 'whitebox-result-review.png'));

    await win.webContents.executeJavaScript(`(() => {
      const projectButton = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(item => item.dataset.workspace === 'D:\\\\fixture-other');
      projectButton?.click();
    })()`);
    await waitFor(
      win,
      `!([...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(item => item.dataset.workspace === 'D:\\\\fixture-other')
        ?.querySelector('.project-sidebar-result-ready'))`,
      '프로젝트를 확인한 뒤 완료 결과 배지가 사라지지 않았습니다.',
    );
    const projectResultSeen = await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      const projectButton = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(item => item.dataset.workspace === 'D:\\\\fixture-other');
      const session = control.state.snapshot.sessions.find(item => item.id === 'fixture-project-result-ready');
      return {
        count: Number(projectButton?.dataset.resultReadyCount || 0),
        badgeExists: Boolean(projectButton?.querySelector('.project-sidebar-result-ready')),
        pendingResultCount: control.resultReviewTargets(session).length,
        actualReviewComplete: control.isResultReviewComplete(session),
      };
    })()`);
    if (projectResultSeen.count !== 0 || projectResultSeen.badgeExists
      || projectResultSeen.pendingResultCount !== 1 || projectResultSeen.actualReviewComplete) {
      throw new Error(`프로젝트 완료 결과 열람 상태가 올바르지 않습니다: ${JSON.stringify(projectResultSeen)}`);
    }

    await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      const session = control.state.snapshot.sessions.find(item => item.id === 'fixture-ended');
      session.outcome = { status: 'completed', verified: true, completedAt: session.updatedAt, summary: '재시작 전 확인할 완료 결과' };
      control.state.workspace = 'D:\\fixture';
      control.state.providerFilters.clear();
      control.state.search = '';
      control.selectView('active');
      control.render();
    })()`);
    await waitFor(
      win,
      `Boolean(document.querySelector('[data-session-id="fixture-ended"][data-result-review="true"]'))`,
      '재시작 확인용 완료 결과 카드를 찾지 못했습니다.',
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-session-id="fixture-ended"][data-result-review="true"]')?.click()`,
    );
    await waitFor(
      win,
      `window.WhiteboxApp.isResultReviewComplete(
        window.WhiteboxApp.state.snapshot.sessions.find(item => item.id === 'fixture-ended'))`,
      '완료 결과를 연 뒤 확인 상태가 저장되지 않았습니다.',
    );
    const storedReview = await win.webContents.executeJavaScript(
      `Boolean(localStorage.getItem('whitebox:result-reviews:v1'))`,
    );
    if (!storedReview) throw new Error('완료 결과 확인 상태가 Local Storage에 기록되지 않았습니다.');
    const reviewedSession = await win.webContents.executeJavaScript(`(() => {
      const session = window.WhiteboxApp.state.snapshot.sessions.find(item => item.id === 'fixture-ended');
      return { session, stamp: window.WhiteboxApp.resultReviewStamp(session) };
    })()`);

    await win.reload();
    await waitFor(win, 'Boolean(window.WhiteboxApp?.initialized)', '재시작 후 앱 초기화를 기다리다 시간이 초과되었습니다.');
    await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      const index = control.state.snapshot.sessions.findIndex(item => item.id === 'fixture-ended');
      control.state.snapshot.sessions[index] = ${JSON.stringify(reviewedSession.session)};
      control.state.workspace = 'D:\\fixture';
      control.state.providerFilters.clear();
      control.state.search = '';
      control.selectView('active');
      control.render();
    })()`);
    const persistedReview = await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      const session = control.state.snapshot.sessions.find(item => item.id === 'fixture-ended');
      return {
        complete: control.isResultReviewComplete(session),
        pending: control.resultReviewTargets(session).length,
        stamp: control.resultReviewStamp(session),
        storedStamp: ${JSON.stringify(reviewedSession.stamp)},
        promptVisible: Boolean(document.querySelector('[data-session-id="fixture-ended"][data-result-review="true"]')),
      };
    })()`);
    if (!persistedReview.complete || persistedReview.pending !== 0 || persistedReview.promptVisible) {
      throw new Error(`재시작 후 완료 결과 확인 상태가 유지되지 않았습니다: ${JSON.stringify(persistedReview)}`);
    }

    await win.webContents.executeJavaScript(`(() => {
      const completedAt = new Date(Date.now() + 5000).toISOString();
      window.interactionTest.updateSession('fixture-ended', {
        completedAt,
        updatedAt: completedAt,
        outcome: { status: 'completed', verified: true, completedAt, summary: '재시작 뒤 새로 도착한 결과' },
      });
      window.interactionTest.emitSnapshot();
    })()`);
    await waitFor(
      win,
      `window.WhiteboxApp.resultReviewTargets(
        window.WhiteboxApp.state.snapshot.sessions.find(item => item.id === 'fixture-ended')).length === 1
        && Boolean(document.querySelector('[data-session-id="fixture-ended"][data-result-review="true"]'))`,
      '실제로 새 결과가 왔을 때 확인 항목이 다시 나타나지 않았습니다.',
    );

    await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      control.state.workspace = control.state.snapshot.sessions.find(item => item.id === 'fixture-root').cwd;
      control.state.providerFilters.clear();
      control.state.search = '';
      control.selectView('all');
      control.render();
    })()`);
    await waitFor(
      win,
      `Boolean(document.querySelector('.home-attention-item[data-open-session="fixture-ended"][data-result-review="true"]'))
        && Boolean(document.querySelector('.home-attention-item[data-open-session="fixture-waiting"]'))`,
      '홈 확인 목록에서 순수 완료 결과와 기존 답변 요청을 함께 찾지 못했습니다.',
    );
    const managementHomeResult = await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      const result = control.state.snapshot.sessions.find(item => item.id === 'fixture-ended');
      const item = document.querySelector('.home-attention-item[data-open-session="fixture-ended"]');
      return {
        needed: control.needsManagementInbox(result),
        pending: control.resultReviewTargets(result).length,
        itemPresent: Boolean(item),
        resultReviewEntry: item?.hasAttribute('data-result-review') || false,
      };
    })()`);
    if (!managementHomeResult.needed || managementHomeResult.pending !== 1
      || !managementHomeResult.itemPresent || !managementHomeResult.resultReviewEntry) {
      throw new Error(`홈 완료 결과 진입 경로가 올바르지 않습니다: ${JSON.stringify(managementHomeResult)}`);
    }

    await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      control.state.search = '';
      control.selectView('waiting');
      control.render();
    })()`);
    await waitFor(
      win,
      `Boolean(document.querySelector('.attention-card[data-management-session="fixture-ended"] .attention-primary-action[data-result-review="true"]'))
        && Boolean(document.querySelector('.attention-card[data-management-session="fixture-waiting"]'))`,
      '확인 대기 화면에서 완료 결과 카드와 기존 답변 요청 카드를 함께 찾지 못했습니다.',
    );
    win.show();
    win.focus();
    const focusedManagementResult = await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.attention-card[data-management-session="fixture-ended"] .attention-primary-action[data-result-review="true"]');
      button?.focus();
      return document.activeElement === button;
    })()`);
    if (!focusedManagementResult) throw new Error('완료 결과 확인 버튼에 키보드 포커스를 둘 수 없습니다.');
    await win.webContents.executeJavaScript(
      `document.querySelector('.attention-card[data-management-session="fixture-ended"] .attention-primary-action[data-result-review="true"]')?.click()`,
    );
    await waitFor(
      win,
      `window.WhiteboxApp.isResultReviewComplete(
        window.WhiteboxApp.state.snapshot.sessions.find(item => item.id === 'fixture-ended'))
        && !document.querySelector('.attention-card[data-management-session="fixture-ended"]')
        && Boolean(document.querySelector('.attention-card[data-management-session="fixture-waiting"]'))`,
      '완료 결과를 연 뒤 확인 저장 또는 목록 제거가 이루어지지 않았습니다.',
    );
    const managementReviewedSession = await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      const session = control.state.snapshot.sessions.find(item => item.id === 'fixture-ended');
      return {
        session,
        stamp: control.resultReviewStamp(session),
        complete: control.isResultReviewComplete(session),
        pending: control.resultReviewTargets(session).length,
        inboxVisible: Boolean(document.querySelector('.attention-card[data-management-session="fixture-ended"]')),
      };
    })()`);
    if (!managementReviewedSession.complete || managementReviewedSession.pending !== 0
      || managementReviewedSession.inboxVisible) {
      throw new Error(`확인 대기 완료 결과 제거 상태가 올바르지 않습니다: ${JSON.stringify(managementReviewedSession)}`);
    }

    await win.reload();
    await waitFor(win, 'Boolean(window.WhiteboxApp?.initialized)', '관리 화면 결과 확인 후 재시작을 기다리다 시간이 초과되었습니다.');
    await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      const index = control.state.snapshot.sessions.findIndex(item => item.id === 'fixture-ended');
      control.state.snapshot.sessions[index] = ${JSON.stringify(managementReviewedSession.session)};
      control.state.workspace = control.state.snapshot.sessions.find(item => item.id === 'fixture-root').cwd;
      control.state.providerFilters.clear();
      control.state.search = '';
      control.selectView('waiting');
      control.render();
    })()`);
    await waitFor(
      win,
      `window.WhiteboxApp.isResultReviewComplete(
        window.WhiteboxApp.state.snapshot.sessions.find(item => item.id === 'fixture-ended'))
        && !window.WhiteboxApp.needsManagementInbox(
          window.WhiteboxApp.state.snapshot.sessions.find(item => item.id === 'fixture-ended'))
        && !document.querySelector('.attention-card[data-management-session="fixture-ended"]')
        && Boolean(document.querySelector('.attention-card[data-management-session="fixture-waiting"]'))`,
      '재시작 후 확인한 완료 결과가 확인 대기 목록에 다시 나타났습니다.',
    );
    const managementPersistedReview = await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      const session = control.state.snapshot.sessions.find(item => item.id === 'fixture-ended');
      return {
        complete: control.isResultReviewComplete(session),
        pending: control.resultReviewTargets(session).length,
        needed: control.needsManagementInbox(session),
        stamp: control.resultReviewStamp(session),
        storedStamp: ${JSON.stringify(managementReviewedSession.stamp)},
        inboxVisible: Boolean(document.querySelector('.attention-card[data-management-session="fixture-ended"]')),
      };
    })()`);
    if (!managementPersistedReview.complete || managementPersistedReview.pending !== 0
      || managementPersistedReview.needed || managementPersistedReview.inboxVisible
      || managementPersistedReview.stamp !== managementPersistedReview.storedStamp) {
      throw new Error(`재시작 후 관리 화면 완료 결과 확인 상태가 유지되지 않았습니다: ${JSON.stringify(managementPersistedReview)}`);
    }

    await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      control.state.workspace = control.state.snapshot.sessions.find(item => item.id === 'fixture-root').cwd;
      control.selectView('all');
      control.render();
    })()`);
    await wait(300);
    const homeDebug = await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      const session = control.state.snapshot.sessions.find(item => item.id === 'fixture-waiting');
      return {
        view: control.state.view,
        workspace: control.state.workspace,
        source: session?.attention?.source || '',
        needed: control.needsManagementInbox(session),
        graphIds: control.graphFilteredSessions().map(item => item.id),
        attentionCount: document.body.dataset.homeAttentionCount,
        itemIds: [...document.querySelectorAll('.home-attention-item[data-open-session]')].map(item => item.dataset.openSession),
      };
    })()`);
    await waitFor(
      win,
      `Boolean(document.querySelector('.home-attention-item[data-open-session="fixture-waiting"]'))`,
      `구조화된 선택 요청이 확인 필요로 표시되지 않았습니다: ${JSON.stringify(homeDebug)}`,
    );
    if (homeDebug.itemIds.includes('fixture-ended')) {
      throw new Error(`재시작 후 홈에 확인한 완료 결과가 다시 나타났습니다: ${JSON.stringify(homeDebug)}`);
    }
    await waitFor(
      win,
      `Boolean([...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(item => item.dataset.workspace === 'D:\\\\fixture')
        ?.querySelector('.project-sidebar-attention'))`,
      '확인 필요가 있는 프로젝트 배지를 찾지 못했습니다.',
    );
    await win.webContents.executeJavaScript(`(() => {
      const projectButton = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(item => item.dataset.workspace === 'D:\\\\fixture');
      projectButton?.click();
    })()`);
    await waitFor(
      win,
      `!([...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(item => item.dataset.workspace === 'D:\\\\fixture')
        ?.querySelector('.project-sidebar-attention'))`,
      '프로젝트를 확인한 뒤 확인 필요 배지가 사라지지 않았습니다.',
    );
    const attention = await win.webContents.executeJavaScript(`(() => {
      const control = window.WhiteboxApp;
      const byId = id => control.state.snapshot.sessions.find(session => session.id === id);
      const projectButton = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(item => item.dataset.workspace === 'D:\\\\fixture');
      return {
        structuredQuestion: control.needsManagementInbox(byId('fixture-waiting')),
        failedRun: control.needsManagementInbox(byId('fixture-failed')),
        optionalOffer: control.needsManagementInbox(byId('fixture-optional')),
        projectAttentionCount: Number(projectButton?.dataset.attentionSessionCount || 0),
        projectAttentionBadge: Boolean(projectButton?.querySelector('.project-sidebar-attention')),
        visibleIds: [...document.querySelectorAll('.home-attention-item[data-open-session]')]
          .map(item => item.dataset.openSession),
      };
    })()`);
    if (!attention.structuredQuestion || attention.failedRun || attention.optionalOffer
      || attention.projectAttentionCount !== 0 || attention.projectAttentionBadge
      || attention.visibleIds.includes('fixture-failed') || attention.visibleIds.includes('fixture-optional')) {
      throw new Error(`확인 필요 표시 조건이 올바르지 않습니다: ${JSON.stringify(attention)}`);
    }

    process.stdout.write(`확인 필요·작업 완료 UI 검증 통과\n${JSON.stringify({ completion, attention, themeStates, projectResultSeen, persistedReview, managementHomeResult, managementPersistedReview }, null, 2)}\n${Object.values(outputs).join('\n')}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
