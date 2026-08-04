'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-control-room-'));
app.setPath('userData', userData);
app.once('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(win, expression, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await wait(60);
  }
  throw new Error(message);
}

async function capture(win, outputDir, name) {
  await win.webContents.executeJavaScript(`document.fonts.ready.then(() => true)`);
  win.webContents.invalidate();
  await wait(680);
  const output = path.join(outputDir, name);
  fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
  return output;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1666,
    height: 1018,
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
    await waitFor(
      win,
      `Boolean(window.LoadToAgentApp?.initialized
        && window.LoadToAgentApp?.state?.snapshot
        && window.LoadToAgentApp?.state?.providerUsage?.providers?.claude?.shortWindow
        && !document.querySelector('#projectSelectionPrompt')?.classList.contains('hidden')
        && document.querySelectorAll('#projectSidebarList [data-workspace]').length >= 2)`,
      '프로젝트 선택 홈이 준비되지 않았습니다.',
    );
    const initialSelectionMetrics = await win.webContents.executeJavaScript(`(() => ({
      workspace: window.LoadToAgentApp.state.workspace,
      prompt: document.querySelector('#projectSelectionPrompt h2')?.textContent.trim() || '',
      projectCount: document.querySelectorAll('#projectSidebarList [data-workspace]').length,
      liveHidden: document.querySelector('#liveSection')?.classList.contains('hidden'),
      operationsHidden: document.querySelector('#operationsOverview')?.classList.contains('hidden'),
    }))()`);
    if (initialSelectionMetrics.workspace !== 'all'
      || initialSelectionMetrics.prompt !== '프로젝트를 선택해주세요'
      || initialSelectionMetrics.projectCount < 2
      || !initialSelectionMetrics.liveHidden
      || !initialSelectionMetrics.operationsHidden) {
      throw new Error(`프로젝트 선택 홈 검증 실패: ${JSON.stringify(initialSelectionMetrics)}`);
    }
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentI18n.setLocale('ko');
      const control = window.LoadToAgentApp;
      control.state.guideExpanded = false;
      control.state.search = '';
      control.state.workspace = 'all';
      control.state.provider = 'all';
      control.state.providerFilters.clear();
      control.state.controlRoomSort = 'recent';
      control.state.workspaces = [
        { name: ['Lode', 'star'].join(''), path: 'D:\\\\fixture' },
        { name: 'CMS_WEB', path: 'D:\\\\cms-web' },
        { name: 'cras_backend', path: 'D:\\\\cras-backend' },
        { name: '기타', path: 'D:\\\\misc-projects' },
      ];
      const projectAssignments = new Map([
        ['fixture-origin', ['D:\\\\cms-web', 'CMS_WEB']],
        ['fixture-ended', ['D:\\\\cms-web', 'CMS_WEB']],
        ['fixture-live-0', ['D:\\\\cras-backend', 'cras_backend']],
        ['fixture-live-1', ['D:\\\\misc-projects', '기타']],
        ['fixture-live-2', ['D:\\\\fixture', ['Lode', 'star'].join('')]],
        ['fixture-live-3', ['D:\\\\fixture', ['Lode', 'star'].join('')]],
        ['fixture-live-4', ['D:\\\\fixture', ['Lode', 'star'].join('')]],
        ['fixture-live-5', ['D:\\\\cms-web', 'CMS_WEB']],
        ['fixture-live-6', ['D:\\\\cms-web', 'CMS_WEB']],
      ]);
      control.state.snapshot.sessions.forEach(session => {
        const assignment = projectAssignments.get(session.id);
        if (!assignment) return;
        session.cwd = assignment[0];
        session.originCwd = assignment[0];
        session.workspace = assignment[1];
      });
      const visualClones = [
        ['fixture-live-0', 'fixture-visual-cras-2', 'cras_backend 추가 실행'],
        ['fixture-live-1', 'fixture-visual-other-2', '기타 프로젝트 추가 실행'],
        ['fixture-live-1', 'fixture-visual-other-3', '기타 프로젝트 후속 실행'],
      ].map(([sourceId, id, title], index) => {
        const source = control.state.snapshot.sessions.find(session => session.id === sourceId);
        if (!source) return null;
        return {
          ...source,
          id,
          externalId: id + '-external',
          title,
          childIds: [],
          executions: [],
          updatedAt: new Date(Date.now() - (index + 20) * 60_000).toISOString(),
        };
      }).filter(Boolean);
      control.state.snapshot.sessions.push(...visualClones);
      ['fixture-root', 'fixture-origin', 'fixture-live-0', 'fixture-live-5'].forEach((id, index) => {
        const session = control.state.snapshot.sessions.find(item => item.id === id);
        if (session) session.updatedAt = new Date(Date.UTC(2099, 0, 1, 0, 0, 4 - index)).toISOString();
      });
      const waitingWithBackground = control.state.snapshot.sessions.find(session => session.id === 'fixture-root');
      waitingWithBackground.status = 'waiting';
      waitingWithBackground.statusDetail = '내 답변을 기다리는 중';
      window.interactionTest.setSessionRuntimePresence('fixture-child', [{ kind: 'terminal', terminalId: 'terminal-race-a', pid: 41003, label: 'subagent fixture terminal' }]);
      const child = control.state.snapshot.sessions.find(session => session.id === 'fixture-child');
      child.runtimePresence = [{ kind: 'terminal', terminalId: 'terminal-race-a', pid: 41003, label: 'subagent fixture terminal' }];
      control.state.agentCommandRoutes.set('fixture-child', 'parent');
      const featuredOrder = ['fixture-root', 'fixture-origin', 'fixture-live-5', 'fixture-live-0'];
      control.state.sessionOrder = featuredOrder.concat(
        control.state.snapshot.sessions.map(session => session.id).filter(id => !featuredOrder.includes(id)),
      );
      control.render();
      control.selectView('all');
      control.renderOperationsOverview();
      control.renderAgentMap(control.graphFilteredSessions(), 'refresh');
      document.querySelector('#projectSelectionPrompt')?.classList.add('hidden');
      document.querySelector('#operationsOverview')?.classList.remove('hidden');
      document.querySelector('#liveSection')?.classList.remove('hidden');
      document.querySelector('#navAllCount').textContent = '48';
      document.querySelector('#navActiveCount').textContent = '9';
      document.querySelector('#navWaitingCount').textContent = '3';
      document.querySelector('#advancedToolsCount').textContent = '17';
      document.querySelector('#beginnerGuide')?.classList.add('hidden');
      const primaryProjectGroup = [...document.querySelectorAll('.control-room-project-group')]
        .find(group => group.dataset.controlProject === ['Lode', 'star'].join(''));
      if (primaryProjectGroup) {
        const projectSummary = primaryProjectGroup.querySelector('.control-project-heading small > span');
        const projectAction = primaryProjectGroup.querySelector('.control-project-heading small > em');
        if (projectSummary) projectSummary.textContent = '현재 상태: AI가 작업 중 · 확인할 결과 1건';
        if (projectAction) projectAction.textContent = '확인할 결과 1건 보기';
      }
      document.querySelector('.main-stage')?.scrollTo(0, 0);
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    await wait(180);

    const overviewMetrics = await win.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('.main-stage');
      const section = document.querySelector('#liveSection');
      const root = document.querySelector('[data-control-session="fixture-root"]');
      const projectToolbar = document.querySelector('#controlRoomProjectToolbar');
      const projectList = document.querySelector('#workspaceList');
      const addProject = document.querySelector('#addWorkspaceBtn');
      const listToolbar = document.querySelector('#controlRoomListToolbar');
      const firstProject = document.querySelector('.control-room-project-group');
      const usageDisclosure = document.querySelector('.provider-usage-disclosure');
      const usageSummary = usageDisclosure?.querySelector(':scope > summary');
      const toolbarBox = projectToolbar?.getBoundingClientRect();
      const addBox = addProject?.getBoundingClientRect();
      const listToolbarBox = listToolbar?.getBoundingClientRect();
      const firstProjectBox = firstProject?.getBoundingClientRect();
      const usageBox = usageDisclosure?.getBoundingClientRect();
      const usageSummaryBox = usageSummary?.getBoundingClientRect();
      const tokenOverview = document.querySelector('#sessionTokenOverview');
      const legacyTopbarCopy = document.querySelector('.topbar-page-copy');
      return {
        sessionTokenOverviewVisible: Boolean(tokenOverview?.getBoundingClientRect().height),
        sessionTokenTitle: document.querySelector('#sessionTokenTitle')?.textContent.trim() || '',
        sessionTokenScope: document.querySelector('#sessionTokenScope')?.textContent.trim() || '',
        sessionTokenItems: document.querySelectorAll('#sessionTokenList .session-token-item').length,
        sessionTokenProviders: [...document.querySelectorAll('#sessionTokenList .session-token-item')]
          .map(node => ({ id: node.dataset.tokenProvider || '', label: node.querySelector('.session-token-label > b')?.textContent.trim() || '' })),
        sessionTokenGauges: document.querySelectorAll('#sessionTokenList .session-token-meter[role="progressbar"]').length,
        sessionTokenGaugeValues: [...document.querySelectorAll('#sessionTokenList .session-token-meter[role="progressbar"]')]
          .map(node => ({ now: Number(node.getAttribute('aria-valuenow')), max: Number(node.getAttribute('aria-valuemax')), fill: node.querySelector('i')?.getBoundingClientRect().width || 0 })),
        sessionTokenUsageLabels: [...document.querySelectorAll('#sessionTokenList .session-token-item > strong')]
          .map(node => node.textContent.replace(/\s+/g, ' ').trim()),
        sessionTokenUnknownCount: document.querySelectorAll('#sessionTokenList .session-token-item.usage-unknown').length,
        sessionTokenButtons: document.querySelectorAll('#sessionTokenOverview button, #sessionTokenOverview summary').length,
        legacyTopbarCopyHidden: Boolean(legacyTopbarCopy && getComputedStyle(legacyTopbarCopy).display === 'none'),
        usageOverviewVisible: Boolean(document.querySelector('#operationsOverview .provider-usage-overview'))
          && !document.querySelector('#operationsOverview')?.classList.contains('hidden'),
        usageDisclosureVisible: Boolean(usageDisclosure && getComputedStyle(usageDisclosure).display !== 'none'
          && usageBox && usageBox.width > 0 && usageBox.height > 0),
        usageDisclosureClosed: Boolean(usageDisclosure && !usageDisclosure.open),
        usageSummaryVisible: Boolean(usageSummaryBox && usageSummaryBox.width > 0 && usageSummaryBox.height > 0),
        usageSummaryText: usageSummary?.innerText.trim() || '',
        usageProviderCards: document.querySelectorAll('#operationsOverview [data-provider-usage]').length,
        usageGauges: document.querySelectorAll('#operationsOverview [role="progressbar"]').length,
        sidebarNavigationRemoved: !document.querySelector('.sidebar .view-nav'),
        sidebarAllProjectsRemoved: !document.querySelector('#projectSidebarList [data-workspace="all"]'),
        projectContextVisible: Boolean(document.querySelector('#projectContextNav')?.getBoundingClientRect().height),
        projectContextName: document.querySelector('#projectContextName')?.textContent.trim() || '',
        projectContextTabs: [...document.querySelectorAll('#projectViewTabs > [data-view]')]
          .filter(node => node.getBoundingClientRect().width > 0)
          .map(node => node.dataset.view),
        projectToolsVisible: Boolean(document.querySelector('#advancedToolsNav > summary')?.getBoundingClientRect().width),
        controlRooms: document.querySelectorAll('[data-control-session]').length,
        rootVisible: Boolean(root),
        compositeSessionLabel: root?.querySelector('.control-session-live')?.textContent.trim() || '',
        mainNode: Boolean(root?.querySelector('.control-room-main')),
        helperNodes: root?.querySelectorAll('.helper-node').length || 0,
        executionNodes: root?.querySelectorAll('.execution-node').length || 0,
        completedNodes: root?.querySelectorAll('.completed-list .control-room-node').length || 0,
        mainLeakedIntoWorkColumns: Boolean(root?.querySelector('.activity-column .control-room-main, .activity-column .direct-work, .completed-column .control-room-main, .completed-column .direct-work')),
        invalidRunningUnits: [...(root?.querySelectorAll('.activity-column .control-room-node:not(.overflow-node)') || [])]
          .filter(node => !node.matches('.helper-node, .execution-node')).length,
        invalidCompletedUnits: [...(root?.querySelectorAll('.completed-list .control-room-node') || [])]
          .filter(node => !node.matches('.helper-node, .execution-node')).length,
        emptyRunningColumns: document.querySelectorAll('.activity-column .control-room-running-empty').length,
        executionTypeLabels: [...(root?.querySelectorAll('.execution-node .control-node-copy > small') || [])].map(node => node.textContent.trim()),
        mainOwnerLabelsHidden: ![...(root?.querySelectorAll('.activity-column .control-node-copy > small, .completed-column .control-node-copy > small') || [])]
          .some(node => /^메인\s/.test(node.textContent.trim())),
        runtimeTooltips: [...(root?.querySelectorAll('.execution-node .control-node-copy > small') || [])].map(node => node.title),
        mainSummary: root?.querySelector('.control-room-main')?.dataset.controlSummary || '',
        helperSummaries: [...(root?.querySelectorAll('.helper-node') || [])].map(node => node.dataset.controlSummary || ''),
        executionSummaries: [...(root?.querySelectorAll('.execution-node') || [])].map(node => node.dataset.controlSummary || ''),
        executionTargets: [...(root?.querySelectorAll('.execution-node') || [])].map(node => ({ owner: node.dataset.openExecutionOwner || '', execution: node.dataset.openExecutionId || '', opensSession: node.hasAttribute('data-open-session') })),
        humanColumnLabels: [...(root?.querySelectorAll('.control-column-label') || [])].map(node => node.textContent.trim()),
        clippedColumnLabels: [...(root?.querySelectorAll('.control-column-label') || [])]
          .filter(node => node.scrollHeight > node.clientHeight + 1).length,
        rawBackgroundLabelsHidden: ![...(root?.querySelectorAll('.execution-node .control-node-copy > b') || [])].some(node => /^(?:Background|Windows 명령창|백그라운드 작업)$/.test(node.textContent.trim())),
        noSectionOverflow: section.scrollWidth <= section.clientWidth + 2,
        noStageOverflow: stage.scrollWidth <= stage.clientWidth + 2,
        sessionRecords: document.querySelectorAll('#sessionGrid .session-record').length,
        sidebarProjectListRemoved: !document.querySelector('.sidebar .workspace-section, .sidebar #workspaceList'),
        projectToolbarVisible: Boolean(projectToolbar && getComputedStyle(projectToolbar).display !== 'none'),
        projectToolbarHeight: toolbarBox?.height || 0,
        projectChipHeight: projectList?.querySelector('[data-workspace]')?.getBoundingClientRect().height || 0,
        listToolbarHeight: listToolbarBox?.height || 0,
        listControlHeight: document.querySelector('#controlRoomSortSelect')?.getBoundingClientRect().height || 0,
        projectHeaderHeight: firstProject?.querySelector('.control-project-header')?.getBoundingClientRect().height || 0,
        stateTabsRemoved: Boolean(document.querySelector('#agentMapToolbar')?.classList.contains('hidden')),
        projectChips: [...(projectList?.querySelectorAll('[data-workspace]') || [])].map(node => node.querySelector('strong')?.textContent.trim()),
        projectChipCounts: [...(projectList?.querySelectorAll('[data-workspace]:not([data-workspace="all"])') || [])]
          .map(node => Number(node.querySelector('small')?.textContent || 0)),
        projectGroups: [...document.querySelectorAll('.control-room-project-group')].map(node => node.dataset.controlProject),
        projectGroupCounts: [...document.querySelectorAll('.control-room-project-group')]
          .map(node => Number(node.querySelector('.control-project-heading em')?.textContent || 0)),
        projectBoxes: [...document.querySelectorAll('.control-room-project-group')].map(node => {
          const box = node.getBoundingClientRect();
          return { project: node.dataset.controlProject, top: box.top, bottom: box.bottom, height: box.height };
        }),
        clippedOpenProjectBodies: [...document.querySelectorAll('.control-room-project-group[open] .control-project-body')]
          .filter(node => node.scrollHeight > node.clientHeight + 2).length,
        inaccessibleProjectBodies: document.querySelectorAll('.control-project-body[inert], .control-project-body[aria-hidden="true"]').length,
        liveSectionBox: (() => { const box = section.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height }; })(),
        flowColumns: getComputedStyle(root?.querySelector('.control-room-flow')).gridTemplateColumns,
        openProjectGroups: document.querySelectorAll('.control-room-project-group[open]').length,
        projectFlowIsButton: document.querySelector('.control-project-flow-link')?.tagName === 'BUTTON',
        projectHandleVisible: Boolean(document.querySelector('.control-project-handle')),
        addProjectAtRight: Boolean(toolbarBox && addBox && addBox.right >= toolbarBox.right - 14 && addBox.left > toolbarBox.left + toolbarBox.width * .7),
        bulkActionsAtTop: Boolean(listToolbarBox && firstProjectBox && listToolbarBox.bottom <= firstProjectBox.top + 2
          && document.querySelector('#controlRoomExpandAll') && document.querySelector('#controlRoomCollapseAll')),
        expandEnabled: !document.querySelector('#controlRoomExpandAll')?.disabled,
        collapseDisabled: Boolean(document.querySelector('#controlRoomCollapseAll')?.disabled),
        pagerRemoved: !document.querySelector('#controlRoomPageSummary, #controlRoomPagePrev, #controlRoomPageNext'),
        semanticSamples: {
          copy: window.LoadToAgentApp.controlRoomSummary('메인이랑 서브 에이전트 그리고 실행중인 세션 문구를 사람이 알아보기 좋게 요약해줘', 64).text,
          loop: window.LoadToAgentApp.controlRoomSummary('/' + ['w', 'c', 'c'].join('') + '-loop --tick v18-seo-blog', 64).text,
          phase: window.LoadToAgentApp.controlRoomSummary('Now I understand the full phase-cycle-complete contract and requirements updated guard.', 64).text,
        },
      };
    })()`);
    if (!overviewMetrics.sessionTokenOverviewVisible
      || overviewMetrics.sessionTokenTitle !== 'AI별 사용량'
      || !overviewMetrics.sessionTokenScope.includes('선택한 AI')
      || !overviewMetrics.sessionTokenScope.includes('4개 고정')
      || overviewMetrics.sessionTokenItems !== 4
      || new Set(overviewMetrics.sessionTokenProviders.map(item => item.id)).size !== overviewMetrics.sessionTokenItems
      || !['Claude', 'GPT', 'Gemini', 'Grok'].every(label => overviewMetrics.sessionTokenProviders.some(item => item.label === label))
      || overviewMetrics.sessionTokenGauges !== 2
      || ![35, 20].every(value => overviewMetrics.sessionTokenGaugeValues.some(item => item.now === value && item.max === 100 && item.fill > 0))
      || !overviewMetrics.sessionTokenUsageLabels.some(label => label.startsWith('35%') && label.includes('사용'))
      || !overviewMetrics.sessionTokenUsageLabels.some(label => label.startsWith('20%') && label.includes('사용'))
      || overviewMetrics.sessionTokenUnknownCount !== 2
      || overviewMetrics.sessionTokenButtons !== 0
      || !overviewMetrics.legacyTopbarCopyHidden
      || overviewMetrics.usageOverviewVisible || overviewMetrics.usageDisclosureVisible
      || overviewMetrics.usageSummaryVisible || overviewMetrics.usageSummaryText
      || overviewMetrics.usageProviderCards !== 0 || overviewMetrics.usageGauges !== 0
      || !overviewMetrics.sidebarNavigationRemoved || !overviewMetrics.sidebarAllProjectsRemoved
      || !overviewMetrics.projectContextVisible
      || JSON.stringify(overviewMetrics.projectContextTabs) !== JSON.stringify(['all', 'active', 'waiting'])
      || !overviewMetrics.projectToolsVisible
      || overviewMetrics.controlRooms < 1
      || !overviewMetrics.rootVisible || !overviewMetrics.mainNode || overviewMetrics.helperNodes < 1
      || !overviewMetrics.compositeSessionLabel.includes('내 답변 대기')
      || !overviewMetrics.compositeSessionLabel.includes('화면 밖에서 작업 중')
      || overviewMetrics.executionNodes < 1 || overviewMetrics.completedNodes < 1
      || overviewMetrics.mainLeakedIntoWorkColumns || overviewMetrics.invalidRunningUnits || overviewMetrics.invalidCompletedUnits
      || overviewMetrics.emptyRunningColumns < 1
      || !overviewMetrics.mainOwnerLabelsHidden || !overviewMetrics.executionTypeLabels.some(label => label === '컴퓨터 작업')
      || overviewMetrics.runtimeTooltips.length !== overviewMetrics.executionNodes || overviewMetrics.runtimeTooltips.some(value => !value)
      || !overviewMetrics.mainSummary || overviewMetrics.helperSummaries.some(summary => !summary)
      || overviewMetrics.executionSummaries.some(summary => !summary) || !overviewMetrics.rawBackgroundLabelsHidden
      || overviewMetrics.executionTargets.some(target => !target.owner || !target.execution || target.opensSession)
      || !overviewMetrics.humanColumnLabels.some(label => label.includes('같은 요청에서 함께 진행 중인 AI 작업'))
      || overviewMetrics.clippedColumnLabels !== 0
      || overviewMetrics.semanticSamples.copy !== 'AI와 진행 중인 작업의 요약 문구 개선'
      || overviewMetrics.semanticSamples.loop !== 'v18-seo-blog 자동 작업 실행'
      || overviewMetrics.semanticSamples.phase !== '요구사항과 단계 완료 조건 확인'
      || !overviewMetrics.noSectionOverflow || !overviewMetrics.noStageOverflow || overviewMetrics.sessionRecords !== 0
      || !overviewMetrics.sidebarProjectListRemoved || !overviewMetrics.stateTabsRemoved
      || overviewMetrics.projectHeaderHeight < 43.5
      || !['전체', ['Lode', 'star'].join('') + ' 폴더', 'CMS_WEB 폴더', 'cras_backend 폴더', '기타 폴더', 'nested-active-project 폴더', 'tmux-only-project 폴더']
        .every(name => overviewMetrics.projectChips.includes(name))
      || ![['Lode', 'star'].join(''), 'CMS_WEB', 'cras_backend', 'tmux-only-project']
        .every(name => overviewMetrics.projectGroups.includes(name))
      || overviewMetrics.projectGroups.length < 4
      || overviewMetrics.openProjectGroups > 1 || overviewMetrics.clippedOpenProjectBodies !== 0 || overviewMetrics.inaccessibleProjectBodies !== 0
      || !overviewMetrics.projectFlowIsButton || !overviewMetrics.projectHandleVisible
      || !overviewMetrics.expandEnabled
      || overviewMetrics.collapseDisabled !== (overviewMetrics.openProjectGroups === 0)
      || !overviewMetrics.pagerRemoved) {
      throw new Error(`세션 관제 홈 검증 실패: ${JSON.stringify(overviewMetrics)}`);
    }

    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });
    await win.webContents.executeJavaScript(`(() => {
      const control = window.LoadToAgentApp;
      const root = control.state.snapshot.sessions.find(session => session.id === 'fixture-root');
      root.status = 'running';
      root.statusDetail = '기능 사용 또는 답변 작성 중';
      control.render();
      const primaryProjectGroup = [...document.querySelectorAll('.control-room-project-group')]
        .find(group => group.dataset.controlProject === ['Lode', 'star'].join(''));
      if (primaryProjectGroup) {
        const projectSummary = primaryProjectGroup.querySelector('.control-project-heading small > span');
        const projectAction = primaryProjectGroup.querySelector('.control-project-heading small > em');
        if (projectSummary) projectSummary.textContent = '현재 상태: AI가 작업 중 · 확인할 결과 1건';
        if (projectAction) projectAction.textContent = '확인할 결과 1건 보기';
      }
      document.querySelector('#navAllCount').textContent = '48';
      document.querySelector('#navActiveCount').textContent = '9';
      document.querySelector('#navWaitingCount').textContent = '3';
      document.querySelector('#advancedToolsCount').textContent = '17';
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    const overviewOutput = await capture(win, outputDir, 'loadtoagent-control-room.png');

    await win.webContents.executeJavaScript(`(() => {
      const project = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(node => node.querySelector('strong')?.textContent.trim() === 'CMS_WEB');
      project?.click();
    })()`);
    await waitFor(
      win,
      `window.LoadToAgentApp.state.workspace === 'D:\\\\cms-web'
        && window.LoadToAgentApp.state.view === 'all'
        && document.querySelector('#projectContextName')?.textContent.trim() === 'CMS_WEB'`,
      '왼쪽 프로젝트 선택이 메인 프로젝트 컨텍스트에 반영되지 않았습니다.',
    );
    const projectContextMetrics = await win.webContents.executeJavaScript(`(() => ({
      project: document.querySelector('#projectContextName')?.textContent.trim() || '',
      eyebrow: document.querySelector('#projectContextEyebrow')?.textContent.trim() || '',
      heading: document.querySelector('#projectContextHeading')?.textContent.trim() || '',
      progress: document.querySelector('#projectContextMeta')?.textContent.trim() || '',
      tokenScope: document.querySelector('#sessionTokenScope')?.textContent.trim() || '',
      tokenItems: document.querySelectorAll('#sessionTokenList .session-token-item').length,
      tokenProviders: [...document.querySelectorAll('#sessionTokenList .session-token-item')].map(node => node.dataset.tokenProvider || ''),
      tokenGauges: document.querySelectorAll('#sessionTokenList .session-token-meter[role="progressbar"]').length,
      tokenRemainingLabels: [...document.querySelectorAll('#sessionTokenList .session-token-item > strong')]
        .map(node => node.textContent.replace(/\\s+/g, ' ').trim()),
      tokenControls: document.querySelectorAll('#sessionTokenOverview button, #sessionTokenOverview summary').length,
      providerUsageHidden: !document.querySelector('#operationsOverview .provider-usage-disclosure'),
      sidebarProjects: document.querySelectorAll('#projectSidebarList [data-workspace]').length,
      sidebarNestedSessions: document.querySelectorAll('#projectSidebarList .project-sidebar-session[data-open-session]').length,
      sidebarAllProjectsVisible: [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .every(node => node.getBoundingClientRect().height > 0),
      sidebarSelectedProjects: document.querySelectorAll('#projectSidebarList [data-workspace][aria-pressed="true"]').length,
      controlProjects: [...document.querySelectorAll('.control-room-project-group')].map(node => node.dataset.controlProject),
      projectFolderHeaderHidden: document.querySelector('.control-room-project-group > .control-project-header')?.getBoundingClientRect().height === 0,
      projectFlowLinkHidden: document.querySelector('.control-project-flow-link')?.getBoundingClientRect().height === 0,
      projectFrameFlattened: getComputedStyle(document.querySelector('.control-room-project-frame')).borderTopWidth === '0px',
      contextNavigationVisible: Boolean(document.querySelector('#projectContextNav')?.getBoundingClientRect().height),
      history: (() => {
        const rail = document.querySelector('#projectHistoryRail');
        const current = document.querySelector('#liveSessionGrid');
        const railBox = rail?.getBoundingClientRect();
        const currentBox = current?.getBoundingClientRect();
        const sessionIds = [...(rail?.querySelectorAll('[data-open-session]') || [])].map(node => node.dataset.openSession);
        return {
          visible: Boolean(railBox && railBox.width > 0 && railBox.height > 0),
          position: rail ? getComputedStyle(rail).position : '',
          belowCurrentWork: Boolean(railBox && currentBox && railBox.top >= currentBox.bottom - 2),
          containsOnlyHistoryUi: Boolean(
            rail
            && rail.children.length === 2
            && rail.firstElementChild?.tagName === 'HEADER'
            && rail.lastElementChild?.id === 'projectHistoryList'
          ),
          sessionIds,
          allRelated: sessionIds.every(id => {
            const session = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === id);
            return Boolean(session && window.LoadToAgentApp.matchesWorkspaceFilter(session));
          }),
        };
      })(),
      duplicateProgressHeadingHidden: document.querySelector('.live-section-title')?.getBoundingClientRect().height === 0,
    }))()`);
    if (projectContextMetrics.project !== 'CMS_WEB'
      || !projectContextMetrics.contextNavigationVisible
      || !projectContextMetrics.tokenScope.includes('선택한 AI')
      || projectContextMetrics.tokenScope.includes('CMS_WEB')
      || projectContextMetrics.tokenItems !== 4
      || !['claude', 'codex', 'gemini', 'grok'].every(provider => projectContextMetrics.tokenProviders.includes(provider))
      || projectContextMetrics.tokenGauges !== 2
      || !['35%', '20%'].every(value => projectContextMetrics.tokenRemainingLabels.some(label => label.startsWith(value) && label.includes('사용')))
      || projectContextMetrics.tokenControls !== 0
      || !projectContextMetrics.providerUsageHidden
      || projectContextMetrics.sidebarProjects < 4
      || projectContextMetrics.sidebarNestedSessions !== 0
      || !projectContextMetrics.sidebarAllProjectsVisible
      || projectContextMetrics.sidebarSelectedProjects !== 1
      || projectContextMetrics.controlProjects.some(project => project !== 'CMS_WEB')
      || !projectContextMetrics.projectFolderHeaderHidden
      || !projectContextMetrics.projectFlowLinkHidden
      || !projectContextMetrics.projectFrameFlattened
      || !projectContextMetrics.history.visible
      || projectContextMetrics.history.position !== 'static'
      || !projectContextMetrics.history.belowCurrentWork
      || !projectContextMetrics.history.containsOnlyHistoryUi
      || !projectContextMetrics.history.sessionIds.includes('fixture-ended')
      || !projectContextMetrics.history.allRelated
      || !projectContextMetrics.duplicateProgressHeadingHidden) {
      throw new Error(`프로젝트 진행 상황·상단 세션 토큰 검증 실패: ${JSON.stringify(projectContextMetrics)}`);
    }
    const projectContextOutput = await capture(win, outputDir, 'loadtoagent-project-context.png');
    await win.webContents.executeJavaScript(`document.querySelector('#projectHistoryRail')?.scrollIntoView({ block: 'end' })`);
    const projectHistoryOutput = await capture(win, outputDir, 'loadtoagent-project-history.png');
    await win.webContents.executeJavaScript(`document.querySelector('.main-stage')?.scrollTo(0, 0)`);
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentApp.state.workspace = 'all';
      window.LoadToAgentApp.render('filter');
    })()`);
    await waitFor(
      win,
      `window.LoadToAgentApp.state.workspace === 'all'
        && document.querySelector('#projectContextName')?.textContent.trim() === '프로젝트'`,
      '프로젝트 전체 컨텍스트로 돌아오지 못했습니다.',
    );
    const projectToolsMetrics = {
      visible: await win.webContents.executeJavaScript(
        `Boolean(document.querySelector('#advancedToolsNav > summary')?.getBoundingClientRect().width)`,
      ),
    };
    if (!projectToolsMetrics.visible) throw new Error(`프로젝트 추가 기능 요약이 표시되지 않았습니다: ${JSON.stringify(projectToolsMetrics)}`);

    const usageDetailMetrics = {
      removed: !await win.webContents.executeJavaScript(
        `Boolean(document.querySelector('#operationsOverview .provider-usage-disclosure, #operationsOverview [data-provider-usage]'))`,
      ),
    };
    if (!usageDetailMetrics.removed) {
      throw new Error(`중복 남은 사용 한도 영역이 남아 있습니다: ${JSON.stringify(usageDetailMetrics)}`);
    }

    await win.webContents.executeJavaScript(`window.LoadToAgentApp.selectView('terminal', { focusMain: true })`);
    await waitFor(
      win,
      `window.LoadToAgentApp.state.view === 'terminal'
        && !document.querySelector('#backToProjectsBtn')?.classList.contains('hidden')`,
      '고급 작업창에서 프로젝트로 돌아가기 버튼이 나타나지 않았습니다.',
    );
    const focusedToolMetrics = await win.webContents.executeJavaScript(`(() => {
      const visible = element => Boolean(element
        && getComputedStyle(element).display !== 'none'
        && element.getBoundingClientRect().width > 0
        && element.getBoundingClientRect().height > 0);
      return {
        title: document.querySelector('#pageTitle')?.textContent.trim() || '',
        backVisible: visible(document.querySelector('#backToProjectsBtn')),
        newRunHidden: !visible(document.querySelector('#newRunBtn')),
        duplicateGuideHidden: !visible(document.querySelector('#terminalSection .terminal-section-head')),
        answerDestinationHidden: !visible(document.querySelector('#terminalAnswerDestination')),
        desktopGeneralEntryRemoved: !document.querySelector('.nav-item[data-view="terminal"]'),
        mobileGeneralEntryRemoved: !document.querySelector('[data-mobile-view="terminal"]'),
        quickGeneralEntryRemoved: !document.querySelector('[data-quick-command="terminal"]'),
      };
    })()`);
    if (!focusedToolMetrics.backVisible || !focusedToolMetrics.newRunHidden
      || !focusedToolMetrics.duplicateGuideHidden || !focusedToolMetrics.answerDestinationHidden
      || !focusedToolMetrics.desktopGeneralEntryRemoved || !focusedToolMetrics.mobileGeneralEntryRemoved
      || !focusedToolMetrics.quickGeneralEntryRemoved) {
      throw new Error(`고급 작업창 단순화 검증 실패: ${JSON.stringify(focusedToolMetrics)}`);
    }
    const focusedToolOutput = await capture(win, outputDir, 'loadtoagent-focused-tool.png');
    await win.webContents.executeJavaScript(`document.querySelector('#backToProjectsBtn')?.click()`);
    await waitFor(
      win,
      `window.LoadToAgentApp.state.view === 'all'
        && document.querySelector('#backToProjectsBtn')?.classList.contains('hidden')
        && !document.querySelector('#projectSelectionPrompt')?.classList.contains('hidden')
        && document.querySelector('#newRunBtn')?.getBoundingClientRect().width === 0`,
      '프로젝트로 돌아가기 버튼이 프로젝트 화면으로 복귀시키지 못했습니다.',
    );
    await win.webContents.executeJavaScript(`(() => {
      const project = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(node => node.dataset.workspace === 'D:\\\\fixture');
      project?.click();
    })()`);
    await waitFor(
      win,
      `window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'
        && document.querySelector('#newRunBtn')?.getBoundingClientRect().width > 0`,
      '프로젝트를 선택한 뒤 새 AI 작업 버튼이 프로젝트 안에 나타나지 않았습니다.',
    );

    const projectControlMetrics = await win.webContents.executeJavaScript(`(() => {
      const control = window.LoadToAgentApp;
      const firstGroup = document.querySelector('.control-room-project-group');
      const initiallyFocused = [...document.querySelectorAll('.control-room-project-group')]
        .filter(group => group.open).length <= 1;
      document.querySelector('#controlRoomExpandAll')?.click();
      const allExpanded = [...document.querySelectorAll('.control-room-project-group')].every(group => group.open);
      control.renderSessions('refresh');
      const persistedExpanded = [...document.querySelectorAll('.control-room-project-group')].every(group => group.open);
      document.querySelector('#controlRoomCollapseAll')?.click();
      const allCollapsed = [...document.querySelectorAll('.control-room-project-group')].every(group => !group.open);
      control.renderSessions('refresh');
      const persistedCollapsed = [...document.querySelectorAll('.control-room-project-group')].every(group => !group.open);
      const firstSummary = document.querySelector('.control-room-project-group .control-project-header');
      firstSummary?.click();
      const individualExpanded = Boolean(document.querySelector('.control-room-project-group')?.open);
      firstSummary?.click();
      const individualCollapsed = !document.querySelector('.control-room-project-group')?.open;
      const cmsChip = [...document.querySelectorAll('#projectSidebarList [data-workspace]')]
        .find(node => node.querySelector('strong')?.textContent.trim().startsWith('CMS_WEB'));
      cmsChip?.click();
      const projectFiltered = control.state.workspace === 'D:\\\\cms-web'
        && document.querySelector('#projectContextName')?.textContent.trim() === 'CMS_WEB'
        && control.state.view === 'all'
        && [...document.querySelectorAll('.control-room-project-group')].every(node => node.dataset.controlProject === 'CMS_WEB');
      document.querySelector('#projectViewTabs [data-view="active"]')?.click();
      const projectHistoryOpened = control.state.view === 'active'
        && control.state.workspace === 'D:\\\\cms-web'
        && !document.querySelector('#sessionSection')?.classList.contains('hidden')
        && document.querySelector('#projectContextName')?.textContent.trim() === 'CMS_WEB';
      document.querySelector('#projectViewTabs [data-view="all"]')?.click();
      control.state.workspace = 'all';
      control.render('filter');
      const projectSelectionRestored = !document.querySelector('#projectSelectionPrompt')?.classList.contains('hidden')
        && document.querySelector('#liveSection')?.classList.contains('hidden');
      return {
        initiallyFocused,
        allExpanded,
        persistedExpanded,
        allCollapsed,
        persistedCollapsed,
        individualExpanded,
        individualCollapsed,
        projectFiltered,
        projectHistoryOpened,
        projectSelectionRestored,
        restoredAll: control.state.workspace === 'all',
      };
    })()`);
    if (!projectControlMetrics.initiallyFocused || !projectControlMetrics.allExpanded || !projectControlMetrics.persistedExpanded
      || !projectControlMetrics.allCollapsed || !projectControlMetrics.persistedCollapsed
      || !projectControlMetrics.individualExpanded || !projectControlMetrics.individualCollapsed || !projectControlMetrics.projectFiltered
      || !projectControlMetrics.projectHistoryOpened
      || !projectControlMetrics.projectSelectionRestored || !projectControlMetrics.restoredAll) {
      throw new Error(`프로젝트 그룹·전체 열기·닫기 검증 실패: ${JSON.stringify(projectControlMetrics)}`);
    }

    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentApp.state.workspace = 'D:\\\\fixture';
      window.LoadToAgentApp.render('filter');
    })()`);
    await waitFor(
      win,
      `window.LoadToAgentApp.state.workspace === 'D:\\\\fixture'
        && !document.querySelector('#liveSection')?.classList.contains('hidden')
        && Boolean(document.querySelector('[data-open-subagent-chat="fixture-child"]'))`,
      '서브에이전트 검증용 프로젝트가 열리지 않았습니다.',
    );
    win.setContentSize(1700, 979);
    await wait(180);
    await win.webContents.executeJavaScript(`document.querySelector('[data-open-subagent-chat="fixture-child"]')?.click()`);
    await waitFor(
      win,
      `document.querySelector('#detailDrawer')?.classList.contains('open')
        && document.querySelector('#detailDrawer')?.dataset.mode === 'subagent'
        && document.querySelector('#drawerComposer')?.classList.contains('hidden')
        && Boolean(document.querySelector('#drawerContent .chat-row.assistant'))`,
      '서브에이전트의 실제 응답을 보여주는 읽기 전용 상세가 열리지 않았습니다.',
    );

    const drawerMetrics = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('#detailDrawer');
      const child = window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-child');
      return {
        mode: drawer.dataset.mode,
        presentation: drawer.dataset.presentation,
        contextPanelOpen: document.body.classList.contains('conversation-context-open')
          && !document.querySelector('#appShell')?.inert
          && document.querySelector('#drawerBackdrop')?.classList.contains('hidden'),
        protectedAssignmentHidden: !drawer.querySelector('.subagent-assignment-card')
          && !drawer.innerText.includes('실제로 보낸 작업 지시는')
          && !drawer.innerText.includes('도움 AI에게 일을 맡기기 직전'),
        conversationMessages: drawer.querySelectorAll('.chat-row').length,
        routeControlsHidden: drawer.querySelectorAll('[data-agent-command-route]').length === 0,
        composerHidden: document.querySelector('#drawerComposer')?.classList.contains('hidden')
          && !drawer.querySelector('[data-agent-command-form="fixture-child"], [data-agent-command-draft="fixture-child"]'),
        focusControlRemoved: !document.querySelector('#drawerFocusModeBtn'),
        runtimePresence: child?.runtimePresence || [],
        directTargets: window.LoadToAgentTerminal?.agentTargets(child) || [],
        scope: drawer.querySelector('[data-conversation-scope]')?.dataset.conversationScope || '',
        childWorkVisible: drawer.innerText.includes('실행 구조, 대화 기록, 직접 개입'),
        parentConversationHidden: !drawer.innerText.includes('상호작용 테스트를 진행해줘') && !drawer.innerText.includes('버튼과 입력 동작을 확인하고 있습니다.'),
        noDrawerOverflow: drawer.scrollWidth <= drawer.clientWidth + 2,
      };
    })()`);
    if (drawerMetrics.mode !== 'subagent' || drawerMetrics.presentation !== 'context' || !drawerMetrics.contextPanelOpen
      || !drawerMetrics.protectedAssignmentHidden || drawerMetrics.conversationMessages < 1
      || !drawerMetrics.routeControlsHidden || !drawerMetrics.composerHidden || !drawerMetrics.focusControlRemoved
      || drawerMetrics.scope !== 'subagent-only' || !drawerMetrics.childWorkVisible || !drawerMetrics.parentConversationHidden || !drawerMetrics.noDrawerOverflow) {
      throw new Error(`서브에이전트 실제 응답 상세 검증 실패: ${JSON.stringify(drawerMetrics)}`);
    }

    await wait(180);
    const drawerOutput = await capture(win, outputDir, 'loadtoagent-control-room-subagent.png');

    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#drawerBackToFlowBtn')?.click();
      document.querySelector('[data-open-execution-id="fixture-shell-running"]')?.click();
    })()`);
    await waitFor(
      win,
      `document.querySelector('#detailDrawer')?.classList.contains('open')
        && document.querySelector('#detailDrawer')?.dataset.mode === 'execution'
        && window.LoadToAgentApp.state.drawerExecutionId === 'fixture-shell-running'
        && Boolean(document.querySelector('[data-execution-detail="fixture-shell-running"]'))`,
      'PowerShell 실행 전용 상세 화면이 열리지 않았습니다.',
    );
    const executionMetrics = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('#detailDrawer');
      const text = drawer?.innerText || '';
      return {
        mode: drawer?.dataset.mode || '',
        scope: drawer?.querySelector('[data-conversation-scope]')?.dataset.conversationScope || '',
        tabLabel: drawer?.querySelector('.drawer-tab:not(.hidden)')?.textContent.trim() || '',
        visibleTabs: drawer?.querySelectorAll('.drawer-tab:not(.hidden)').length || 0,
        commandVisible: text.includes('npm run dev'),
        outputVisible: text.includes('화면 미리보기가 실행 중입니다.'),
        purposeVisible: Boolean(drawer?.querySelector('.execution-purpose-card b')?.textContent.trim()),
        parentConversationHidden: !text.includes('상호작용 테스트를 진행해줘') && !text.includes('버튼과 입력 동작을 확인하고 있습니다.'),
        composerHidden: document.querySelector('#drawerComposer')?.classList.contains('hidden'),
        noDrawerOverflow: drawer.scrollWidth <= drawer.clientWidth + 2,
      };
    })()`);
    if (executionMetrics.mode !== 'execution' || executionMetrics.scope !== 'execution-only'
      || executionMetrics.tabLabel !== '실행 과정' || executionMetrics.visibleTabs !== 1
      || !executionMetrics.commandVisible || !executionMetrics.outputVisible || !executionMetrics.purposeVisible
      || !executionMetrics.parentConversationHidden || !executionMetrics.composerHidden || !executionMetrics.noDrawerOverflow) {
      throw new Error(`실행 단위 상세 분리 검증 실패: ${JSON.stringify(executionMetrics)}`);
    }
    const executionOutput = await capture(win, outputDir, 'loadtoagent-control-room-execution.png');

    win.setContentSize(1224, 792);
    await wait(260);
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#closeDrawerBtn')?.click();
      document.querySelector('#toast')?.classList.add('hidden');
      window.LoadToAgentApp.state.disclosureStates.clear();
      window.LoadToAgentApp.renderSessions('filter');
      const stage = document.querySelector('.main-stage');
      const live = document.querySelector('#liveSection');
      if (stage && live) stage.scrollTo(0, Math.max(0, live.offsetTop - 8));
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    const desktop1224Metrics = await win.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('.main-stage');
      const live = document.querySelector('#liveSection');
      const groups = [...document.querySelectorAll('.control-room-project-group')];
      const openBodies = [...document.querySelectorAll('.control-room-project-group[open] .control-project-body')];
      const projectList = document.querySelector('#workspaceList');
      const projectToolbar = document.querySelector('#controlRoomProjectToolbar');
      const listToolbar = document.querySelector('#controlRoomListToolbar');
      const projectChips = [...projectList.querySelectorAll('button')];
      const listControls = [...listToolbar.querySelectorAll('button, select')];
      return {
        width: innerWidth,
        groups: groups.length,
        openGroups: groups.filter(group => group.open).length,
        collapsedHeights: groups.filter(group => !group.open).map(group => group.getBoundingClientRect().height),
        projectToolbarGap: Number.parseFloat(getComputedStyle(projectToolbar).columnGap),
        projectToolbarHidden: getComputedStyle(projectToolbar).display === 'none',
        projectChipGap: Number.parseFloat(getComputedStyle(projectList).columnGap),
        projectChipHeights: projectChips.map(control => control.getBoundingClientRect().height),
        listToolbarGap: Number.parseFloat(getComputedStyle(listToolbar).columnGap),
        listToolbarHidden: getComputedStyle(listToolbar).display === 'none',
        listControlHeights: listControls.map(control => control.getBoundingClientRect().height),
        projectGroupGap: Number.parseFloat(getComputedStyle(document.querySelector('.control-room-overview')).rowGap),
        projectOverflowAffordance: projectList.scrollWidth <= projectList.clientWidth + 2
          || projectList.classList.contains('is-overflowing'),
        clippedOpenBodies: openBodies.filter(body => body.scrollHeight > body.clientHeight + 2).length,
        inaccessibleBodies: document.querySelectorAll('.control-project-body[inert], .control-project-body[aria-hidden="true"]').length,
        noLiveOverflow: live.scrollWidth <= live.clientWidth + 2,
        noStageOverflow: stage.scrollWidth <= stage.clientWidth + 2,
      };
    })()`);
    if (desktop1224Metrics.width !== 1224 || desktop1224Metrics.groups < 1 || desktop1224Metrics.openGroups > 1
      || desktop1224Metrics.collapsedHeights.some(height => height > 68)
      || (!desktop1224Metrics.projectToolbarHidden
        && (desktop1224Metrics.projectToolbarGap < 10 || desktop1224Metrics.projectChipGap < 10
          || desktop1224Metrics.projectChipHeights.some(height => height < 39.5)))
      || (!desktop1224Metrics.listToolbarHidden
        && (desktop1224Metrics.listToolbarGap < 10 || desktop1224Metrics.listControlHeights.some(height => height < 39.5)))
      || desktop1224Metrics.projectGroupGap < 12 || !desktop1224Metrics.projectOverflowAffordance
      || desktop1224Metrics.clippedOpenBodies !== 0 || desktop1224Metrics.inaccessibleBodies !== 0
      || !desktop1224Metrics.noLiveOverflow || !desktop1224Metrics.noStageOverflow) {
      throw new Error(`1224×792 세션 관제 검증 실패: ${JSON.stringify(desktop1224Metrics)}`);
    }
    const desktop1224Output = await capture(win, outputDir, 'loadtoagent-control-room-1224.png');

    const constrainedFlowMetrics = await win.webContents.executeJavaScript(`(() => {
      const group = document.querySelector('.control-room-project-group');
      if (group) group.open = true;
      const session = document.querySelector('.control-room-session');
      if (session) {
        session.style.inlineSize = '520px';
        session.style.maxInlineSize = '100%';
      }
      const mainTitle = session?.querySelector('.control-room-main > strong');
      if (mainTitle) {
        mainTitle.textContent = '/mnt/d/winCudeProject/crasbackend/.planning/loops/order-live-orchestration/research';
      }
      const flow = session?.querySelector('.control-room-flow');
      const flowBox = flow?.getBoundingClientRect();
      const columns = [...(flow?.querySelectorAll(':scope > .control-room-column') || [])];
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const refreshedFlowBox = flow?.getBoundingClientRect();
        resolve({
          sessionWidth: session?.getBoundingClientRect().width || 0,
          flowColumns: flow ? getComputedStyle(flow).gridTemplateColumns : '',
          noSessionOverflow: Boolean(session && session.scrollWidth <= session.clientWidth + 1),
          noFlowOverflow: Boolean(flow && flow.scrollWidth <= flow.clientWidth + 1),
          columnsInsideFlow: columns.every(column => {
            const box = column.getBoundingClientRect();
            return Boolean(refreshedFlowBox
              && box.left >= refreshedFlowBox.left - 1
              && box.right <= refreshedFlowBox.right + 1);
          }),
          titleWrapsInsideCard: Boolean(mainTitle
            && mainTitle.scrollWidth <= mainTitle.clientWidth + 1
            && mainTitle.getBoundingClientRect().right <= mainTitle.closest('.control-room-main').getBoundingClientRect().right + 1),
          originalFlowWidth: flowBox?.width || 0,
        });
      })));
    })()`);
    if (constrainedFlowMetrics.sessionWidth < 500 || constrainedFlowMetrics.sessionWidth > 522
      || constrainedFlowMetrics.flowColumns.trim().split(/\s+/).length !== 1
      || !constrainedFlowMetrics.noSessionOverflow || !constrainedFlowMetrics.noFlowOverflow
      || !constrainedFlowMetrics.columnsInsideFlow || !constrainedFlowMetrics.titleWrapsInsideCard) {
      throw new Error(`좁은 작업 영역·긴 경로 흐름 검증 실패: ${JSON.stringify(constrainedFlowMetrics)}`);
    }
    const constrainedFlowOutput = await capture(win, outputDir, 'loadtoagent-control-room-constrained-flow.png');

    win.setContentSize(390, 844);
    await wait(260);
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#closeDrawerBtn')?.click();
      document.querySelector('#toast')?.classList.add('hidden');
      const firstProject = document.querySelector('.control-room-project-group');
      if (firstProject) {
        firstProject.open = true;
        const key = firstProject.dataset.disclosureKey;
        if (key) window.LoadToAgentApp.state.disclosureStates.set(key, true);
      }
      document.querySelector('.main-stage')?.scrollTo(0, 0);
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    const mobileMetrics = await win.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('.main-stage');
      const overview = document.querySelector('[data-control-room-overview]');
      const projectList = document.querySelector('#workspaceList');
      const projectToolbar = document.querySelector('#controlRoomProjectToolbar');
      const listToolbar = document.querySelector('#controlRoomListToolbar');
      const firstProject = document.querySelector('.control-room-project-group');
      const firstAgent = firstProject?.querySelector('.control-room-main');
      const firstAgentRect = firstAgent?.getBoundingClientRect();
      const stageRect = stage?.getBoundingClientRect();
      const usageDisclosure = document.querySelector('.provider-usage-disclosure');
      const rect = selector => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect();
        return bounds ? {
          top: Math.round(bounds.top),
          bottom: Math.round(bounds.bottom),
          height: Math.round(bounds.height),
        } : null;
      };
      return {
        width: innerWidth,
        overviewVisible: Boolean(overview),
        flowColumns: getComputedStyle(document.querySelector('.control-room-flow')).gridTemplateColumns,
        projectToolbarHidden: getComputedStyle(projectToolbar).display === 'none',
        listToolbarHidden: getComputedStyle(listToolbar).display === 'none',
        mobileProjectPickerAvailable: Boolean(document.querySelector('#mobileWorkspaceList')),
        firstProjectOpen: Boolean(firstProject?.open),
        firstAgentAboveFold: Boolean(firstAgentRect && stageRect
          && firstAgentRect.width > 0 && firstAgentRect.height > 0
          && firstAgentRect.top < stageRect.bottom && firstAgentRect.bottom > stageRect.top),
        firstAgentFullyVisible: Boolean(firstAgentRect && stageRect
          && firstAgentRect.top >= stageRect.top && firstAgentRect.bottom <= stageRect.bottom + 2),
        firstAgentRect: firstAgentRect ? {
          top: Math.round(firstAgentRect.top),
          bottom: Math.round(firstAgentRect.bottom),
          height: Math.round(firstAgentRect.height),
        } : null,
        verticalLayout: {
          topbar: rect('.topbar'),
          headline: rect('.topbar h1'),
          topActions: rect('.top-actions'),
          newRun: rect('#newRunBtn'),
          attention: rect('.home-attention-mount'),
          usage: rect('.provider-usage-disclosure'),
          liveSection: rect('.live-section'),
          liveHeader: rect('.live-section-head'),
          overview: rect('[data-control-room-overview]'),
          firstProject: rect('.control-room-project-group'),
          projectHeader: rect('.control-room-project-group > summary'),
          agentTop: rect('.control-room-main .control-main-top'),
          agentTitle: rect('.control-room-main > strong'),
          agentNow: rect('.control-room-main .control-main-now'),
        },
        stageBottom: Math.round(stageRect?.bottom || 0),
        stageScrollTop: Math.round(stage?.scrollTop || 0),
        noOverviewOverflow: overview.scrollWidth <= overview.clientWidth + 2,
        noStageOverflow: stage.scrollWidth <= stage.clientWidth + 2,
        usageDisclosureClosed: Boolean(usageDisclosure && !usageDisclosure.open),
        usageDisclosureVisible: Boolean(usageDisclosure
          && getComputedStyle(usageDisclosure).display !== 'none'
          && usageDisclosure.getBoundingClientRect().height > 0),
        usageOverviewVisible: Boolean(document.querySelector('#operationsOverview .provider-usage-overview')),
        usageProviderCards: document.querySelectorAll('#operationsOverview [data-provider-usage]').length,
        usageGauges: document.querySelectorAll('#operationsOverview [role="progressbar"]').length,
      };
    })()`);
    if (!mobileMetrics.overviewVisible || !mobileMetrics.projectToolbarHidden || !mobileMetrics.listToolbarHidden
      || !mobileMetrics.mobileProjectPickerAvailable || !mobileMetrics.firstProjectOpen
      || !mobileMetrics.firstAgentAboveFold || mobileMetrics.stageScrollTop > 1
      || !mobileMetrics.noOverviewOverflow || !mobileMetrics.noStageOverflow
      || mobileMetrics.usageDisclosureVisible || mobileMetrics.usageOverviewVisible
      || mobileMetrics.usageProviderCards !== 0 || mobileMetrics.usageGauges !== 0) {
      throw new Error(`모바일 세션 관제 검증 실패: ${JSON.stringify(mobileMetrics)}`);
    }
    const mobileOutput = await capture(win, outputDir, 'loadtoagent-control-room-mobile.png');

    process.stdout.write(`세션 관제 시각·상호작용 검증 통과\n${JSON.stringify({ initialSelectionMetrics, overviewMetrics, projectContextMetrics, projectToolsMetrics, usageDetailMetrics, focusedToolMetrics, drawerMetrics, executionMetrics, desktop1224Metrics, constrainedFlowMetrics, mobileMetrics }, null, 2)}\n${overviewOutput}\n${projectContextOutput}\n${projectHistoryOutput}\n${focusedToolOutput}\n${drawerOutput}\n${executionOutput}\n${desktop1224Output}\n${constrainedFlowOutput}\n${mobileOutput}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
