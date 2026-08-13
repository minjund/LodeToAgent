'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'whitebox-project-selection-'));
app.setPath('userData', userData);
app.once('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const reorderOnly = process.argv.includes('--reorder-only');

async function waitFor(win, expression, message, attempts = 120) {
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

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1560,
    height: 940,
    show: true,
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
    await win.webContents.executeJavaScript(`window.WhiteboxI18n.setLocale('ko')`);
    await waitFor(
      win,
      `Boolean(window.WhiteboxApp?.initialized
        && window.WhiteboxApp.state.workspace === 'all'
        && !document.querySelector('#projectSelectionPrompt')?.classList.contains('hidden')
        && document.querySelector('#projectSelectionPrompt h2')?.textContent.trim() === '프로젝트를 선택해주세요'
        && document.querySelectorAll('#projectSidebarList [data-workspace]').length >= 2)`,
      '프로젝트 선택 초기 화면이 준비되지 않았습니다.',
    );

    if (reorderOnly) {
      const projectReorder = await win.webContents.executeJavaScript(`(() => {
        const app = window.WhiteboxApp;
        const list = document.querySelector('#projectSidebarList');
        const selector = '.project-sidebar-group[data-project-sortable]';
        const groups = [...list.querySelectorAll(selector)];
        if (groups.length < 2) return { available: false };
        const originalKeys = groups.map(group => group.dataset.projectSortable);
        const source = groups[groups.length - 1];
        const target = groups[0];
        const sourceKey = source.dataset.projectSortable;
        const data = new Map();
        const dataTransfer = {
          effectAllowed: 'none',
          dropEffect: 'none',
          setData(type, value) { data.set(type, String(value)); },
          getData(type) { return data.get(type) || ''; },
          setDragImage() {},
        };
        const dispatchDrag = (node, type, clientY = 0) => {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperties(event, {
            dataTransfer: { value: dataTransfer },
            clientY: { value: clientY },
          });
          node.dispatchEvent(event);
          return event.defaultPrevented;
        };
        dispatchDrag(source.querySelector('.project-sidebar-item'), 'dragstart');
        const targetBounds = target.getBoundingClientRect();
        const dragoverAccepted = dispatchDrag(target, 'dragover', targetBounds.top + 1);
        const dropAccepted = dispatchDrag(target, 'drop', targetBounds.top + 1);
        const reorderedKeys = [...list.querySelectorAll(selector)].map(group => group.dataset.projectSortable);
        const sourceAfterDrop = list.querySelector(
          selector + '[data-project-sortable="' + CSS.escape(sourceKey) + '"] .project-sidebar-item',
        );
        sourceAfterDrop?.click();
        const workspaceAfterDragClick = app.state.workspace;
        const storedOrder = JSON.parse(localStorage.getItem(app.DASHBOARD_STORAGE_KEY) || '{}').projectOrder || [];
        app.state.projectOrder = [];
        app.loadQualityState();
        app.renderWorkspaces();
        const restoredKeys = [...list.querySelectorAll(selector)].map(group => group.dataset.projectSortable);
        const cleaned = !list.querySelector('.project-sort-dragging, [data-project-drop-edge], [aria-grabbed="true"]');
        return {
          available: true,
          sourceKey,
          reorderedKeys,
          restoredKeys,
          storedOrder,
          dragoverAccepted,
          dropAccepted,
          workspaceAfterDragClick,
          cleaned,
        };
      })()`);
      if (!projectReorder.available
        || projectReorder.reorderedKeys[0] !== projectReorder.sourceKey
        || projectReorder.storedOrder[0] !== projectReorder.sourceKey
        || projectReorder.restoredKeys[0] !== projectReorder.sourceKey
        || !projectReorder.dragoverAccepted || !projectReorder.dropAccepted
        || projectReorder.workspaceAfterDragClick !== 'all'
        || !projectReorder.cleaned) {
        throw new Error(`프로젝트 드래그 순서·저장·클릭 억제 검증 실패: ${JSON.stringify(projectReorder)}`);
      }
      process.stdout.write(`프로젝트 드래그 순서 검증 통과\n${JSON.stringify(projectReorder, null, 2)}\n`);
      return;
    }

    const initial = await win.webContents.executeJavaScript(`(() => {
      const prompt = document.querySelector('#projectSelectionPrompt');
      const visible = element => Boolean(element
        && getComputedStyle(element).display !== 'none'
        && element.getBoundingClientRect().width > 0
        && element.getBoundingClientRect().height > 0);
      const projectOrder = [...document.querySelectorAll('#projectSidebarList [data-workspace][data-project-priority]')]
        .map(project => ({
          name: project.querySelector('.project-sidebar-copy strong')?.textContent.trim() || '',
          initial: project.querySelector('.project-sidebar-icon')?.textContent.trim() || '',
          priority: project.dataset.projectPriority || '',
        }));
      const priorityRank = { attention: 0, 'result-ready': 1, live: 2, idle: 3 };
      const collator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });
      const expectedInitial = name => {
        const characters = Array.from(String(name || '').trim());
        return (characters.find(character => /[\p{L}\p{N}]/u.test(character)) || characters[0] || '•')
          .toLocaleUpperCase('ko-KR');
      };
      const fixedProjectOrder = projectOrder.every((project, index) => {
        if (!index) return true;
        const previous = projectOrder[index - 1];
        const priorityDifference = priorityRank[project.priority] - priorityRank[previous.priority];
        return priorityDifference > 0
          || (priorityDifference === 0 && collator.compare(previous.name, project.name) <= 0);
      });
      return {
        workspace: window.WhiteboxApp.state.workspace,
        prompt: prompt?.querySelector('h2')?.textContent.trim() || '',
        designReady: Boolean(prompt?.querySelector('.project-selection-visual') && !prompt?.querySelector('.project-selection-flow')),
        ongoingAnimations: [...(prompt?.querySelectorAll('.project-selection-orbit, .project-selection-stack, .project-selection-scan') || [])]
          .filter(element => getComputedStyle(element).animationName !== 'none').length,
        processingNavigationHidden: getComputedStyle(document.querySelector('#projectContextNav')).display === 'none',
        promptVisible: visible(prompt),
        projectCount: document.querySelectorAll('#projectSidebarList [data-workspace]').length,
        projectActivityOrder: [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
          .map(project => Number(project.dataset.liveSessionCount || 0)),
        expandedProjects: document.querySelectorAll('#projectSidebarList [aria-expanded="true"]').length,
        removableProjects: document.querySelectorAll('#projectSidebarList [data-remove-workspace]').length,
        sidebarAddOpensRun: document.querySelector('#sidebarNewProjectBtn')?.hasAttribute('data-open-run'),
        settingsAboveProviders: Boolean(
          document.querySelector('#sidebarSettingsBtn')
          && document.querySelector('#sidebarSettingsBtn')?.nextElementSibling?.classList.contains('provider-section-title')
        ),
        visibleSettingsButtons: [...document.querySelectorAll('[data-view="settings"], [data-mobile-view="settings"]')]
          .filter(visible).length,
        settingsRemovedFromTools: !document.querySelector('#advancedToolsNav [data-view="settings"]'),
        projectListNoHorizontalOverflow: Boolean(
          document.querySelector('#projectSidebarList')
          && document.querySelector('#projectSidebarList').scrollWidth <= document.querySelector('#projectSidebarList').clientWidth + 1
        ),
        projectInitialsMatch: projectOrder.every(project => project.initial === expectedInitial(project.name)),
        projectOrder,
        fixedProjectOrder,
        liveVisible: visible(document.querySelector('#liveSection')),
        operationsVisible: visible(document.querySelector('#operationsOverview')),
      };
    })()`);
    const firstInactiveProject = initial.projectActivityOrder.findIndex(count => count === 0);
    const activeProjectsFirst = firstInactiveProject < 0
      || initial.projectActivityOrder.slice(firstInactiveProject).every(count => count === 0);
    if (initial.workspace !== 'all' || initial.prompt !== '프로젝트를 선택해주세요'
      || !initial.promptVisible || initial.projectCount < 2 || initial.expandedProjects !== 0
      || initial.removableProjects < 1 || initial.sidebarAddOpensRun
      || !initial.settingsAboveProviders || initial.visibleSettingsButtons !== 1
      || !initial.settingsRemovedFromTools || !initial.projectListNoHorizontalOverflow
      || !initial.projectInitialsMatch || !initial.designReady || initial.ongoingAnimations < 3 || !initial.processingNavigationHidden
      || !initial.fixedProjectOrder
      || !['result-ready', 'live', 'idle'].every(priority => initial.projectOrder.some(project => project.priority === priority))
      || !activeProjectsFirst || initial.liveVisible || initial.operationsVisible) {
      throw new Error(`프로젝트 초기 선택 화면 검증 실패: ${JSON.stringify(initial)}`);
    }

    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });
    const initialOutput = path.join(outputDir, 'whitebox-project-selection.png');
    await capture(win, initialOutput);

    const removeHoverBefore = await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('#projectSidebarList .project-sidebar-remove');
      const row = button?.closest('.project-sidebar-row');
      const list = document.querySelector('#projectSidebarList');
      const rect = element => {
        const box = element?.getBoundingClientRect();
        return box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null;
      };
      return {
        button: rect(button),
        row: rect(row),
        list: rect(list),
        scrollWidth: list?.scrollWidth || 0,
        clientWidth: list?.clientWidth || 0,
      };
    })()`);
    if (!removeHoverBefore.button) throw new Error('프로젝트 삭제 버튼을 찾지 못했습니다.');
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(removeHoverBefore.button.left + removeHoverBefore.button.width / 2),
      y: Math.round(removeHoverBefore.button.top + removeHoverBefore.button.height / 2),
    });
    await wait(240);
    const removeHoverAfter = await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('#projectSidebarList .project-sidebar-remove');
      const row = button?.closest('.project-sidebar-row');
      const list = document.querySelector('#projectSidebarList');
      const rect = element => {
        const box = element?.getBoundingClientRect();
        return box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null;
      };
      return {
        button: rect(button),
        row: rect(row),
        list: rect(list),
        scrollWidth: list?.scrollWidth || 0,
        clientWidth: list?.clientWidth || 0,
        hovered: Boolean(button?.matches(':hover')),
      };
    })()`);
    const stableRect = (before, after) => before && after
      && ['left', 'top', 'width', 'height'].every(key => Math.abs(before[key] - after[key]) < 0.6);
    if (!removeHoverAfter.hovered
      || !stableRect(removeHoverBefore.button, removeHoverAfter.button)
      || !stableRect(removeHoverBefore.row, removeHoverAfter.row)
      || removeHoverAfter.scrollWidth > removeHoverAfter.clientWidth + 1) {
      throw new Error(`프로젝트 삭제 버튼 호버·가로 넘침 검증 실패: ${JSON.stringify({ removeHoverBefore, removeHoverAfter })}`);
    }
    const removeHoverOutput = path.join(outputDir, 'whitebox-project-remove-hover.png');
    await capture(win, removeHoverOutput);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 900, y: 700 });

    await win.webContents.executeJavaScript(`document.querySelector('#sidebarSettingsBtn')?.click()`);
    await waitFor(
      win,
      `window.WhiteboxApp.state.view === 'settings'
        && !document.querySelector('#settingsSection')?.classList.contains('hidden')`,
      'AI 목록 위 설정 버튼에서 설정 화면을 열지 못했습니다.',
    );
    const settingsHelpLayout = await win.webContents.executeJavaScript(`(() => {
      const shortcut = document.querySelector('#shortcutHelpBtn');
      const rect = shortcut?.getBoundingClientRect();
      const projectList = document.querySelector('#projectSidebarList');
      const projectTab = projectList?.querySelector('[data-workspace]');
      const contextNav = document.querySelector('#projectContextNav');
      const sidebar = document.querySelector('.sidebar');
      const visible = element => Boolean(element
        && getComputedStyle(element).display !== 'none'
        && element.getBoundingClientRect().width > 0
        && element.getBoundingClientRect().height > 0);
      return {
        helpCardRemoved: !document.querySelector('.settings-help-card'),
        shortcutInBrand: Boolean(shortcut?.closest('.brand')),
        shortcutWidth: rect?.width || 0,
        shortcutHeight: rect?.height || 0,
        sidebarWidth: sidebar?.getBoundingClientRect().width || 0,
        projectListVisible: visible(projectList),
        projectTabVisible: visible(projectTab),
        projectTabWidth: projectTab?.getBoundingClientRect().width || 0,
        projectTabCount: projectList?.querySelectorAll('[data-workspace]').length || 0,
        workTabsVisible: visible(contextNav),
        workTabCount: [...(contextNav?.querySelectorAll('[data-view]') || [])].filter(visible).length,
        legacyHelpCopyVisible: [...document.querySelectorAll('h1, h2, h3, p, span, b, small')]
          .some(node => node.getClientRects().length && /도움말 및 상태|사용 안내와 앱 상태|기본 사용법 완료/.test(node.textContent || '')),
      };
    })()`);
    if (!settingsHelpLayout.helpCardRemoved
      || !settingsHelpLayout.shortcutInBrand
      || settingsHelpLayout.shortcutWidth < 44
      || settingsHelpLayout.shortcutHeight < 44
      || settingsHelpLayout.shortcutWidth > 48
      || settingsHelpLayout.shortcutHeight > 48
      || settingsHelpLayout.sidebarWidth < 220
      || !settingsHelpLayout.projectListVisible
      || !settingsHelpLayout.projectTabVisible
      || settingsHelpLayout.projectTabWidth < 160
      || settingsHelpLayout.projectTabCount < 1
      || !settingsHelpLayout.workTabsVisible
      || settingsHelpLayout.workTabCount < 3
      || settingsHelpLayout.legacyHelpCopyVisible) {
      throw new Error(`설정 도움말 제거·탐색 탭·브랜드 단축키 배치 검증 실패: ${JSON.stringify(settingsHelpLayout)}`);
    }
    const settingsOutput = path.join(outputDir, 'whitebox-settings-with-brand-shortcut.png');
    await capture(win, settingsOutput);
    await win.webContents.executeJavaScript(`document.querySelector('#shortcutHelpBtn')?.click()`);
    await waitFor(win, `!document.querySelector('#shortcutHelpModal')?.classList.contains('hidden')`, '브랜드 단축키 버튼이 키보드 도움말을 열지 못했습니다.');
    await win.webContents.executeJavaScript(`document.querySelector('#closeShortcutHelpBtn')?.click()`);
    await waitFor(win, `document.querySelector('#shortcutHelpModal')?.classList.contains('hidden')`, '키보드 도움말을 닫지 못했습니다.');
    const settingsReturnWorkspace = await win.webContents.executeJavaScript(`(() => {
      const project = document.querySelector('#projectSidebarList [data-workspace]');
      project?.click();
      return project?.dataset.workspace || '';
    })()`);
    await waitFor(
      win,
      `window.WhiteboxApp.state.view === 'all'
        && window.WhiteboxApp.state.workspace === ${JSON.stringify(settingsReturnWorkspace)}`,
      '설정 화면의 왼쪽 프로젝트 탭으로 작업 화면에 돌아오지 못했습니다.',
    );
    await win.webContents.executeJavaScript(`(() => {
      window.WhiteboxApp.state.workspace = 'all';
      window.WhiteboxApp.renderWorkspaces();
      window.WhiteboxApp.renderSessions('filter');
    })()`);
    await waitFor(win, `window.WhiteboxApp.state.view === 'all' && window.WhiteboxApp.state.workspace === 'all'`, '프로젝트 선택 화면 복원에 실패했습니다.');

    const selectedWorkspace = await win.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('#projectSidebarList [data-workspace]');
      const workspace = first?.dataset.workspace || '';
      first?.click();
      return workspace;
    })()`);
    await waitFor(
      win,
      `window.WhiteboxApp.state.workspace === ${JSON.stringify(selectedWorkspace)}
        && document.querySelector('#projectSelectionPrompt')?.classList.contains('hidden')
        && !document.querySelector('#liveSection')?.classList.contains('hidden')`,
      '프로젝트 선택 결과가 열리지 않았습니다.',
    );

    const selected = await win.webContents.executeJavaScript(`(() => {
      const projects = [...document.querySelectorAll('#projectSidebarList [data-workspace]')];
      const selectedProject = document.querySelector('#projectSidebarList [data-workspace][aria-pressed="true"]');
      const visible = element => Boolean(element
        && getComputedStyle(element).display !== 'none'
        && element.getBoundingClientRect().width > 0
        && element.getBoundingClientRect().height > 0);
      return {
        projectCount: projects.length,
        projectActivityOrder: projects.map(project => Number(project.dataset.liveSessionCount || 0)),
        allProjectsVisible: projects.every(project => project.getBoundingClientRect().height > 0),
        selectedCount: document.querySelectorAll('#projectSidebarList [data-workspace][aria-pressed="true"]').length,
        selectedWorkspace: selectedProject?.dataset.workspace || '',
        selectedName: selectedProject?.querySelector('.project-sidebar-copy strong')?.textContent.trim() || '',
        expandedCount: document.querySelectorAll('#projectSidebarList [aria-expanded="true"]').length,
        nestedSessionAreas: document.querySelectorAll('#projectSidebarList .project-sidebar-sessions').length,
        nestedSessions: document.querySelectorAll('#projectSidebarList .project-sidebar-session').length,
        taskToolbarVisible: visible(document.querySelector('#projectTaskToolbar')),
        taskButtonInProject: Boolean(document.querySelector('#projectTaskToolbar > #newRunBtn')),
        taskProjectPath: document.querySelector('#projectTaskProjectPath')?.textContent || '',
        taskButtonText: document.querySelector('#newRunBtn')?.textContent.replace(/\s+/g, ' ').trim() || '',
        taskButtonShortcutRemoved: !document.querySelector('#newRunBtn small, #newRunBtn kbd'),
        mainProjects: [...document.querySelectorAll('.control-room-project-group')].map(project => project.dataset.controlProject),
        reviewCards: [...document.querySelectorAll('[data-control-review]')].filter(visible).map(card => ({
          sessionId: card.dataset.controlReview || '',
          title: card.querySelector(':scope > strong')?.textContent.trim() || '',
          detail: card.querySelector(':scope > p')?.textContent.trim() || '',
          action: card.querySelector('[data-open-session]')?.textContent.trim() || '',
        })),
        genericAttentionInboxVisible: visible(document.querySelector('#attentionInbox')),
      };
    })()`);
    if (selected.projectCount !== initial.projectCount || !selected.allProjectsVisible
      || selected.selectedCount !== 1 || selected.selectedWorkspace !== selectedWorkspace
      || selected.expandedCount !== 0 || selected.nestedSessionAreas !== 0 || selected.nestedSessions !== 0
      || !selected.taskToolbarVisible || !selected.taskButtonInProject || selected.taskProjectPath !== selectedWorkspace
      || selected.taskButtonText !== '＋새 AI 작업 시작' || !selected.taskButtonShortcutRemoved
      || selected.mainProjects.length !== 1 || selected.reviewCards.length < 1
      || !selected.reviewCards[0].title || /^대기합니다[.!]?$/.test(selected.reviewCards[0].title)
      || !selected.reviewCards[0].action || selected.genericAttentionInboxVisible) {
      throw new Error(`전체 프로젝트 유지·선택 프로젝트 단일 행 검증 실패: ${JSON.stringify(selected)}`);
    }

    const selectedOutput = path.join(outputDir, 'whitebox-project-selected-all-visible.png');
    await capture(win, selectedOutput);

    await win.webContents.executeJavaScript(`document.querySelector('[data-control-review] [data-open-session]')?.click()`);
    await waitFor(
      win,
      `document.querySelector('#detailDrawer')?.classList.contains('open')
        && window.WhiteboxApp.state.selectedId === ${JSON.stringify(selected.reviewCards[0].sessionId)}`,
      '확인할 내용의 바로가기에서 해당 AI 대화를 열지 못했습니다.',
    );
    const directReview = await win.webContents.executeJavaScript(`(() => ({
      selectedId: window.WhiteboxApp.state.selectedId,
      drawerOpen: document.querySelector('#detailDrawer')?.classList.contains('open'),
      drawerTitle: document.querySelector('#drawerTitle')?.textContent.trim() || '',
    }))()`);
    if (!directReview.drawerOpen || directReview.selectedId !== selected.reviewCards[0].sessionId || !directReview.drawerTitle) {
      throw new Error(`확인할 내용 바로 열기 검증 실패: ${JSON.stringify(directReview)}`);
    }
    await win.webContents.executeJavaScript(`document.querySelector('#closeDrawerBtn')?.click()`);
    await waitFor(win, `!document.querySelector('#detailDrawer')?.classList.contains('open')`, '확인 대화 창이 닫히지 않았습니다.');

    await win.webContents.executeJavaScript(`document.querySelector('#newRunBtn')?.click()`);
    await waitFor(
      win,
      `!document.querySelector('#runModal')?.classList.contains('hidden')
        && document.querySelector('#runCwd')?.value === ${JSON.stringify(selectedWorkspace)}`,
      '선택한 프로젝트의 새 AI 작업 창이 열리지 않았습니다.',
    );
    const runModal = await win.webContents.executeJavaScript(`(() => {
      const cwd = document.querySelector('#runCwd');
      const picker = document.querySelector('#pickRunCwdBtn');
      const suggestions = document.querySelector('#runWorkspaceSuggestions');
      return {
        cwd: cwd?.value || '',
        readOnly: Boolean(cwd?.readOnly),
        projectName: document.querySelector('#runProjectName')?.textContent.trim() || '',
        projectSelectionRemoved: !document.querySelector('#runProjectLock, .run-project-locked-field'),
        pickerHidden: Boolean(picker?.disabled && (picker.hidden || picker.classList.contains('hidden') || getComputedStyle(picker).display === 'none')),
        suggestionsHidden: Boolean(suggestions?.classList.contains('hidden') || getComputedStyle(suggestions).display === 'none'),
      };
    })()`);
    if (runModal.cwd !== selectedWorkspace || !runModal.readOnly
      || runModal.projectName !== selected.selectedName || !runModal.projectSelectionRemoved
      || !runModal.pickerHidden || !runModal.suggestionsHidden) {
      throw new Error(`새 AI 작업의 프로젝트 고정 검증 실패: ${JSON.stringify(runModal)}`);
    }
    const modalOutput = path.join(outputDir, 'whitebox-project-locked-new-task.png');
    await capture(win, modalOutput);
    await win.webContents.executeJavaScript(`document.querySelector('#cancelRunBtn')?.click()`);
    await waitFor(win, `document.querySelector('#runModal')?.classList.contains('hidden')`, '새 AI 작업 창이 닫히지 않았습니다.');

    const approvalWorkspace = 'D:\\fixture';
    const approvalPrompt = `Edited .planning/loops/order-live-verify/
research/p3-task2-report.md → /mnt/d/approval-worktrees/cras-backend/order-live-orch/order-live-verify/.planning/loops/order-live-verify/research/p3-task2-report.md (+0 -0)

Would you like to make the following edits?

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files
     (a)
  3. No, and tell Codex what to do differently
     (esc)`;
    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.clearCalls();
      window.interactionTest.setTerminalReplay('terminal-main', ${JSON.stringify(approvalPrompt)});
      window.interactionTest.emitSnapshot();
      [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(item => item.dataset.workspace === ${JSON.stringify(approvalWorkspace)})?.click();
    })()`);
    await waitFor(
      win,
      `window.WhiteboxApp.state.workspace === ${JSON.stringify(approvalWorkspace)}
        && document.querySelectorAll('[data-terminal-prompt] [data-terminal-prompt-choice]').length === 3`,
      'Codex 파일 수정 승인 선택지가 프로젝트 화면에 나타나지 않았습니다.',
      220,
    );
    const approval = await win.webContents.executeJavaScript(`(() => ({
      question: document.querySelector('[data-terminal-prompt] > strong')?.textContent.trim() || '',
      detail: document.querySelector('[data-terminal-prompt] > p')?.textContent.trim() || '',
      choices: [...document.querySelectorAll('[data-terminal-prompt-choice]')].map(button => ({
        id: button.dataset.terminalPromptChoice,
        label: button.textContent.trim(),
      })),
    }))()`);
    if (!/파일 수정/.test(approval.question) || !/p3-task2-report\.md/.test(approval.detail)
      || approval.choices.map(choice => choice.id).join(',') !== 'proceed,always,reject') {
      throw new Error(`파일 수정 승인 내용·선택지 검증 실패: ${JSON.stringify(approval)}`);
    }
    const approvalOutput = path.join(outputDir, 'whitebox-project-file-approval.png');
    await capture(win, approvalOutput);
    await win.webContents.executeJavaScript(`document.querySelector('[data-terminal-prompt-choice="proceed"]')?.click()`);
    await wait(900);
    const approvalState = await win.webContents.executeJavaScript(`(() => ({
      calls: window.interactionTest.getCalls(),
      promptVisible: Boolean(document.querySelector('[data-terminal-prompt]')),
      buttonDisabled: Boolean(document.querySelector('[data-terminal-prompt-choice="proceed"]')?.disabled),
      buttonError: document.querySelector('[data-terminal-prompt-choice="proceed"]')?.dataset.error || '',
      pendingPrompt: window.WhiteboxTerminal.pendingPromptForSession('fixture-root'),
    }))()`);
    if (approvalState.promptVisible) {
      throw new Error(`파일 수정 승인 선택 후 확인 카드가 정리되지 않았습니다: ${JSON.stringify(approvalState)}`);
    }
    const approvalDelivery = approvalState.calls;
    if (!approvalDelivery.some(call =>
      call.name === 'terminalWrite' && call.args[0] === 'terminal-main' && call.args[1] === 'y')) {
      throw new Error(`파일 수정 진행 선택이 원래 Codex 터미널에 y 키로 전달되지 않았습니다: ${JSON.stringify(approvalDelivery)}`);
    }
    const approvalDeliveries = [{ choice: 'proceed', key: 'y' }];
    for (const [choiceId, expectedKey] of [['always', 'a'], ['reject', '\u001b']]) {
      const promptVariant = approvalPrompt.replace(
        'p3-task2-report.md',
        `p3-task2-report-${choiceId}.md`,
      );
      await win.webContents.executeJavaScript(`(() => {
        window.interactionTest.clearCalls();
        window.interactionTest.setTerminalReplay('terminal-main', ${JSON.stringify(promptVariant)});
        window.interactionTest.emitSnapshot();
        window.WhiteboxTerminal.refreshPendingPrompts();
      })()`);
      await waitFor(
        win,
        `Boolean(document.querySelector('[data-terminal-prompt-choice="${choiceId}"]'))`,
        `${choiceId} 파일 수정 승인 선택지가 나타나지 않았습니다.`,
        220,
      );
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-terminal-prompt-choice="${choiceId}"]')?.click()`,
      );
      await waitFor(
        win,
        `window.interactionTest.getCalls().some(call =>
          call.name === 'terminalWrite'
          && call.args[0] === 'terminal-main'
          && call.args[1] === ${JSON.stringify(expectedKey)})`,
        `${choiceId} 파일 수정 승인 선택이 원래 Codex 터미널에 전달되지 않았습니다.`,
        220,
      );
      await waitFor(
        win,
        `!document.querySelector('[data-terminal-prompt]')`,
        `${choiceId} 파일 수정 승인 선택 후 확인 카드가 정리되지 않았습니다.`,
        220,
      );
      approvalDeliveries.push({ choice: choiceId, key: expectedKey === '\u001b' ? 'Escape' : expectedKey });
      if (choiceId === 'reject') {
        await waitFor(
          win,
          `window.WhiteboxApp.state.view === 'terminal'`,
          '수정 거절 후 원래 Codex 입력 화면이 열리지 않았습니다.',
        );
        await win.webContents.executeJavaScript(`window.WhiteboxApp.selectView('all')`);
        await waitFor(
          win,
          `window.WhiteboxApp.state.view === 'all'
            && window.WhiteboxApp.state.workspace === ${JSON.stringify(approvalWorkspace)}`,
          '수정 거절 후 프로젝트 화면으로 돌아오지 못했습니다.',
        );
      }
    }

    await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.clearCalls();
      document.querySelector('#projectSidebarList [data-workspace][aria-pressed="true"]')?.click();
      document.querySelector('#sidebarNewProjectBtn')?.click();
    })()`);
    await waitFor(
      win,
      `window.interactionTest.getCalls().some(call => call.name === 'addWorkspaces')
        && window.WhiteboxApp.state.workspace === 'D:\\\\fixture'`,
      '왼쪽 프로젝트 추가 동작이 프로젝트를 선택하지 못했습니다.',
    );
    const addProject = await win.webContents.executeJavaScript(`(() => ({
      runModalHidden: document.querySelector('#runModal')?.classList.contains('hidden'),
      selectedWorkspace: window.WhiteboxApp.state.workspace,
    }))()`);
    if (!addProject.runModalHidden || addProject.selectedWorkspace !== 'D:\\fixture') {
      throw new Error(`프로젝트 추가와 AI 작업 시작 분리 검증 실패: ${JSON.stringify(addProject)}`);
    }

    const removedWorkspace = await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.clearCalls();
      const remove = [...document.querySelectorAll('#projectSidebarList [data-remove-workspace]')]
        .find(button => button.dataset.removeWorkspace === 'D:\\\\fixture')
        || document.querySelector('#projectSidebarList [data-remove-workspace]');
      const path = remove?.dataset.removeWorkspace || '';
      remove?.click();
      return path;
    })()`);
    await waitFor(
      win,
      `window.interactionTest.getCalls().some(call => call.name === 'removeWorkspace')
        && ![...document.querySelectorAll('#projectSidebarList [data-workspace]')]
          .some(item => item.dataset.workspace === ${JSON.stringify(removedWorkspace)})`,
      '왼쪽 프로젝트 삭제 후 항목이 목록에서 사라지지 않았습니다.',
    );
    process.stdout.write(`프로젝트 선택 화면 검증 통과\n${JSON.stringify({ initial, removeHoverBefore, removeHoverAfter, settingsHelpLayout, selected, directReview, runModal, approval, approvalDeliveries, addProject }, null, 2)}\n${initialOutput}\n${removeHoverOutput}\n${settingsOutput}\n${selectedOutput}\n${modalOutput}\n${approvalOutput}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
