'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const isolatedBridgeHome = fs.mkdtempSync(path.join(os.tmpdir(), `loadtoagent-responsive-${process.pid}-`));
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), `loadtoagent-responsive-user-${process.pid}-`));
process.env.LOADTOAGENT_TEST_INSTANCE = '1';
process.env.LOADTOAGENT_BRIDGE_HOME = isolatedBridgeHome;

const { app, BrowserWindow } = require('electron');
app.setPath('userData', isolatedUserData);

app.once('quit', () => {
  try { fs.rmSync(isolatedBridgeHome, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(isolatedUserData, { recursive: true, force: true }); } catch {}
});

require('../main');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForWindow() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) return win;
    await wait(100);
  }
  throw new Error('반응형 검증에 사용할 LoadToAgent 창을 찾지 못했습니다.');
}

async function waitForRenderer(win) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await win.webContents.executeJavaScript(`document.readyState === 'complete' && window.LoadToAgentApp?.initialized === true`);
    if (ready) return;
    await wait(100);
  }
  throw new Error('반응형 검증 전에 화면 준비가 끝나지 않았습니다.');
}

function setWindowSize(win, width, height) {
  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  win.restore();
  win.setBounds({ width, height }, false);
}

async function openView(win, view) {
  await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector(${JSON.stringify(`[data-view="${view}"]`)});
    if (!button) return false;
    button.click();
    document.querySelector('.main-stage')?.scrollTo(0, 0);
    return true;
  })()`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const activeView = await win.webContents.executeJavaScript(`document.querySelector('.view-nav .nav-item.active')?.dataset.view || ''`);
    if (activeView === view) {
      await wait(320);
      return;
    }
    await wait(80);
  }
  throw new Error(`${view} 화면 전환이 끝나지 않았습니다.`);
}

async function layoutMetrics(win) {
  return win.webContents.executeJavaScript(`(() => {
    const stage = document.querySelector('.main-stage');
    const sidebar = document.querySelector('.sidebar');
    const navItems = [...document.querySelectorAll('.view-nav .nav-item')];
    const visibleNavItems = navItems.filter(item => {
      const rect = item.getBoundingClientRect();
      return getComputedStyle(item).display !== 'none' && rect.width > 0 && rect.height > 0;
    });
    const sidebarRect = sidebar?.getBoundingClientRect();
    const visibleSections = [...document.querySelectorAll('.main-stage > section')]
      .filter(section => !section.classList.contains('hidden'));
    const sectionOverflow = visibleSections
      .filter(section => section.scrollWidth > section.clientWidth + 2)
      .map(section => section.id || section.className);
    const sectionOverflowDetails = visibleSections
      .filter(section => section.scrollWidth > section.clientWidth + 2)
      .map(section => {
        const bounds = section.getBoundingClientRect();
        const offenders = [...section.querySelectorAll('*')]
          .filter(element => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || element.scrollWidth > element.clientWidth + 2);
          })
          .slice(0, 12)
          .map(element => ({
            tag: element.tagName,
            id: element.id,
            className: typeof element.className === 'string' ? element.className : '',
            width: Math.round(element.getBoundingClientRect().width),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          }));
        return { section: section.id || section.className, scrollWidth: section.scrollWidth, clientWidth: section.clientWidth, offenders };
      });
    const compact = window.innerWidth <= 720;
    const narrowSidebar = window.innerWidth > 720 && window.innerWidth <= 980;
    const terminalActionLabels = [...document.querySelectorAll('[data-terminal-signal="interrupt"] span, [data-terminal-signal="clear"] span')]
      .every(label => getComputedStyle(label).display !== 'none' && label.getBoundingClientRect().width > 0 && label.textContent.trim());
    const tmuxShortcut = document.querySelector('#openTmuxFromAgentWork');
    const tmuxShortcutRect = tmuxShortcut?.getBoundingClientRect();
    const liveSectionVisible = !document.querySelector('#liveSection')?.classList.contains('hidden');
    const stageRect = stage?.getBoundingClientRect();
    const topbar = document.querySelector('.topbar');
    const topbarRect = topbar?.getBoundingClientRect();
    const topbarCopyRect = topbar?.firstElementChild?.getBoundingClientRect();
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      compact,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      stageOverflow: Boolean(stage && stage.scrollWidth > stage.clientWidth + 2),
      stageScrollLeft: stage?.scrollLeft || 0,
      stageRect: stageRect ? { left: stageRect.left, right: stageRect.right, width: stageRect.width } : null,
      topbarRect: topbarRect ? { left: topbarRect.left, right: topbarRect.right, width: topbarRect.width } : null,
      topbarCopyRect: topbarCopyRect ? { left: topbarCopyRect.left, right: topbarCopyRect.right, width: topbarCopyRect.width } : null,
      sectionOverflow,
      sectionOverflowDetails,
      sidebarInsideViewport: Boolean(sidebarRect && sidebarRect.left >= -1 && sidebarRect.right <= window.innerWidth + 1 && sidebarRect.bottom <= window.innerHeight + 1),
      compactNavAtBottom: !compact || Boolean(sidebarRect && sidebarRect.top > window.innerHeight / 2 && Math.abs(sidebarRect.bottom - window.innerHeight) <= 1),
      navCount: navItems.length,
      visibleNavItems: visibleNavItems.map(item => item.dataset.view || item.id),
      navItemsInsideViewport: visibleNavItems.every(item => {
        const rect = item.getBoundingClientRect();
        return rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
      }),
      navAccessibleNames: visibleNavItems.every(item => item.getAttribute('aria-label')?.trim()),
      sidebarNoInternalOverflow: Boolean(sidebar && sidebar.scrollWidth <= sidebar.clientWidth + 2),
      sidebarOverflowItems: sidebar && sidebar.scrollWidth > sidebar.clientWidth + 2
        ? [...sidebar.querySelectorAll('*')].filter(item => item.getBoundingClientRect().right > sidebarRect.right + 1).slice(0, 8).map(item => ({ tag: item.tagName, className: item.className, text: item.textContent.trim().slice(0, 40), right: Math.round(item.getBoundingClientRect().right), sidebarRight: Math.round(sidebarRect.right) }))
        : [],
      narrowSidebarLabelsVisible: !narrowSidebar || visibleNavItems.every(item => {
        const label = item.querySelector(':scope > span:not(.nav-icon)');
        return Boolean(label && getComputedStyle(label).display !== 'none' && label.getBoundingClientRect().width > 0);
      }),
      narrowSidebarTitles: !narrowSidebar || visibleNavItems.every(item => item.getAttribute('title')?.trim()),
      projectFilterAvailable: !['all', 'active', 'waiting'].includes(window.LoadToAgentApp?.state?.view)
        || (window.innerWidth <= 720
          ? Boolean(document.querySelector('#mobileWorkspaceList'))
          : Boolean(document.querySelector('.workspace-section')?.getBoundingClientRect().width > 0 && document.querySelector('#workspaceList')?.getBoundingClientRect().height > 0)),
      compactContentClearance: !compact || Number.parseFloat(getComputedStyle(stage).paddingBottom) >= (sidebarRect?.height || 0) + 12,
      terminalActionLabels,
      tmuxShortcutVisible: !liveSectionVisible || Boolean(tmuxShortcutRect && tmuxShortcutRect.width > 0 && tmuxShortcutRect.height >= 40),
      tmuxShortcutInsideViewport: !liveSectionVisible || Boolean(tmuxShortcutRect && tmuxShortcutRect.left >= -1 && tmuxShortcutRect.right <= window.innerWidth + 1),
    };
  })()`);
}

function assertLayout(metrics, context) {
  const compactNavValid = !metrics.compact
    || JSON.stringify(metrics.visibleNavItems) === JSON.stringify(['all', 'active', 'waiting', 'runtime', 'mobileMoreBtn']);
  if (metrics.documentOverflow || metrics.stageOverflow || Math.abs(metrics.stageScrollLeft) > 1 || !metrics.stageRect || metrics.stageRect.left < -1 || metrics.stageRect.right > metrics.width + 1 || !metrics.topbarRect || metrics.topbarRect.left < -1 || metrics.topbarRect.right > metrics.width + 1 || !metrics.topbarCopyRect || metrics.topbarCopyRect.left < -1 || metrics.topbarCopyRect.right > metrics.width + 1 || metrics.sectionOverflow.length || !metrics.sidebarInsideViewport || !metrics.compactNavAtBottom || metrics.navCount < 5 || !metrics.navItemsInsideViewport || !metrics.navAccessibleNames || !metrics.sidebarNoInternalOverflow || !metrics.narrowSidebarLabelsVisible || !metrics.narrowSidebarTitles || !metrics.projectFilterAvailable || !metrics.compactContentClearance || !compactNavValid || !metrics.tmuxShortcutVisible || !metrics.tmuxShortcutInsideViewport) {
    throw new Error(`${context} 반응형 배치가 올바르지 않습니다: ${JSON.stringify(metrics)}`);
  }
}

async function overlayMetrics(win, capturePath = '') {
  await win.webContents.executeJavaScript(`(() => {
    window.LoadToAgentApp.openRunModal();
  })()`);
  await wait(360);
  if (capturePath) {
    await win.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('#runModal');
      const form = document.querySelector('#runForm');
      for (const animation of [...(modal?.getAnimations() || []), ...(form?.getAnimations() || [])]) {
        try { animation.finish(); } catch {}
      }
    })()`);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(capturePath, image.toPNG());
  }
  await win.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('#detailDrawer');
    const backdrop = document.querySelector('#drawerBackdrop');
    if (drawer) drawer.style.transition = 'none';
    drawer?.classList.add('open');
    backdrop?.classList.remove('hidden');
  })()`);
  await wait(80);
  return win.webContents.executeJavaScript(`(() => {
    const viewportContains = rect => Boolean(rect && rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1);
    const modalElement = document.querySelector('#runModal .run-modal');
    for (const animation of [...(document.querySelector('#runModal')?.getAnimations() || []), ...(modalElement?.getAnimations() || [])]) {
      try { animation.finish(); } catch {}
    }
    for (const animation of document.querySelector('#detailDrawer')?.getAnimations() || []) {
      try { animation.finish(); } catch {}
    }
    const modal = modalElement?.getBoundingClientRect();
    const form = document.querySelector('#runForm');
    const prompt = document.querySelector('#runPrompt');
    const providers = document.querySelector('#runProviderPicker');
    const actions = document.querySelector('.run-modal-actions')?.getBoundingClientRect();
    const providerCards = [...document.querySelectorAll('.run-provider-option')].map(item => item.getBoundingClientRect());
    const promptFirst = Boolean(prompt && providers && (prompt.compareDocumentPosition(providers) & Node.DOCUMENT_POSITION_FOLLOWING));
    const modalNoHorizontalOverflow = Boolean(form && form.scrollWidth <= form.clientWidth + 2);
    const modalScrollWidth = form?.scrollWidth || 0;
    const modalClientWidth = form?.clientWidth || 0;
    const providerCardsInsideModal = Boolean(modal && providerCards.length && providerCards.every(rect => rect.left >= modal.left - 1 && rect.right <= modal.right + 1));
    const actionsInsideViewport = viewportContains(actions);
    const promptCounterVisible = Boolean(document.querySelector('#runPromptCount')?.offsetParent);
    const horizontalOverflow = [...form.children].map(element => {
      const rect = element.getBoundingClientRect();
      return { className: element.className, left: rect.left, right: rect.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    }).filter(item => item.clientWidth && modal && (item.left < modal.left - 1 || item.right > modal.right + 1 || item.scrollWidth > item.clientWidth + 2));
    document.querySelector('#runModal')?.classList.add('hidden');
    document.querySelector('#runModal')?.classList.remove('closing');
    const drawer = document.querySelector('#detailDrawer');
    const backdrop = document.querySelector('#drawerBackdrop');
    const drawerRect = drawer?.getBoundingClientRect();
    drawer?.classList.remove('open');
    if (drawer) drawer.style.transition = '';
    backdrop?.classList.add('hidden');
    return {
      modalInsideViewport: viewportContains(modal),
      modalNoHorizontalOverflow,
      providerCardsInsideModal,
      actionsInsideViewport,
      promptCounterVisible,
      promptFirst,
      modalScrollWidth,
      modalClientWidth,
      horizontalOverflow,
      drawerInsideViewport: viewportContains(drawerRect),
      modalWidth: modal?.width || 0,
      drawerWidth: drawerRect?.width || 0,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      drawerRect: drawerRect ? { left: drawerRect.left, right: drawerRect.right, top: drawerRect.top, bottom: drawerRect.bottom } : null,
    };
  })()`);
}

async function setupWorkflowFixture(win) {
  return win.webContents.executeJavaScript(`(() => {
    const now = new Date().toISOString();
    const rootId = 'responsive-workflow-root';
    const childIds = ['responsive-workflow-child-a', 'responsive-workflow-child-b'];
    const base = {
      provider: 'codex', model: 'gpt-5.6', cwd: '/responsive/project', workspace: 'responsive-project',
      createdAt: now, updatedAt: now, status: 'running', statusDetail: '작업 진행 중',
      usage: { input: 12000, cachedInput: 2000, output: 4000, reasoning: 1000, total: 17000 },
      context: { window: 200000, used: 80000, percent: 40 }, messages: [], lifecycle: [], runtimePresence: [],
    };
    const root = {
      ...base, id: rootId, externalId: rootId, parentId: null, depth: 0, childIds,
      title: '모든 화면에서 작업 흐름이 자연스럽게 이어지도록 개선하기',
      agentName: 'Main', agentRole: 'primary',
      collaboration: { metrics: { cumulativeCreated: 2, simultaneousCapacity: 3, currentlyRunning: 2, completedRecords: 0, retainedCount: 2, capacitySource: 'runtime-instruction' } },
    };
    const children = childIds.map((id, index) => ({
      ...base, id, externalId: id, parentId: rootId, depth: 1, childIds: [],
      title: index ? '작은 화면의 입력 영역 확인' : '연결선과 카드 배치가 어떤 화면 크기에서도 서로 겹치지 않는지 긴 작업 이름으로 확인',
      taskName: index ? 'compact_input_check' : 'workflow_layout_check_with_a_deliberately_long_task_name_that_must_stay_inside_the_compact_help_session_card_at_every_supported_width',
      agentName: index ? 'Layout' : 'FlowAgentWithAnIntentionallyLongDisplayName', agentRole: 'worker',
      statusDetail: index ? '모바일 입력창과 버튼 배치 확인 중' : '현재 연결선과 도움 세션 카드의 긴 현재 작업 문구가 카드 밖으로 넘치지 않고 말줄임표로 표시되는지 확인하는 중',
      delegation: {
        taskName: index ? 'compact_input_check' : 'workflow_layout_check_with_a_deliberately_long_task_name_that_must_stay_inside_the_compact_help_session_card_at_every_supported_width', assignmentObserved: true,
        assignment: index ? '모바일 입력창과 버튼이 겹치지 않는지 확인' : '관계 카드와 연결선이 겹치지 않고 상태 배지와 작업 요약이 제한된 카드 폭 안에서 안정적으로 보이는지 확인하고 화면이 더 넓어지거나 좁아져도 다른 카드의 상태와 행동 버튼을 밀어내지 않는지까지 함께 확인',
      },
    }));
    const fixtureIds = new Set([rootId, ...childIds]);
    window.__responsiveWorkflowFixtures = [root, ...children];
    window.__ensureResponsiveWorkflowFixture = () => {
      const sessions = window.LoadToAgentApp.state.snapshot && window.LoadToAgentApp.state.snapshot.sessions || [];
      window.LoadToAgentApp.state.snapshot.sessions = [...sessions.filter(session => !fixtureIds.has(session.id)), ...window.__responsiveWorkflowFixtures];
      window.LoadToAgentApp.state.view = 'all';
      window.LoadToAgentApp.state.graphFocusId = rootId;
      window.LoadToAgentApp.state.expandedCompletedSubagents.delete(rootId);
      document.querySelectorAll('.view-nav .nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'all'));
      window.LoadToAgentApp.renderSessions();
    };
    if (window.LoadToAgentTerminal && !window.__responsiveOriginalAgentTargets) {
      window.__responsiveOriginalAgentTargets = window.LoadToAgentTerminal.agentTargets;
      window.LoadToAgentTerminal.agentTargets = session => session && session.id === rootId
        ? [{ id: 'responsive-terminal', label: '반응형 테스트 터미널', platform: 'macOS' }]
        : window.__responsiveOriginalAgentTargets(session);
    }
    window.__ensureResponsiveWorkflowFixture();
    window.LoadToAgentApp.drawAgentWorkflowConnections();
    const stage = document.querySelector('.main-stage');
    const canvas = document.querySelector('.agent-workflow-canvas');
    if (stage && canvas) stage.scrollTo(0, Math.max(0, canvas.offsetTop - 12));
    return rootId;
  })()`);
}

async function workflowMetrics(win) {
  return win.webContents.executeJavaScript(`(() => {
    window.__ensureResponsiveWorkflowFixture?.();
    window.LoadToAgentApp.drawAgentWorkflowConnections();
    const canvas = document.querySelector('.agent-workflow-canvas');
    const upstream = document.querySelector('.upstream-column .agent-workflow-origin, .upstream-column .agent-workflow-node');
    const selected = document.querySelector('.agent-workflow-selected');
    const command = document.querySelector('.agent-command-panel');
    const downstream = document.querySelector('.downstream-column');
    const output = document.querySelector('[data-workflow-port="focus-output"]');
    const identity = document.querySelector('.agent-workflow-selected .agent-identity');
    const tmuxShortcut = document.querySelector('#openTmuxFromAgentWork');
    const helpTitle = [...document.querySelectorAll('.downstream-stack .agent-flow-session-title')]
      .find(element => element.title.includes('deliberately_long_task_name'));
    const helpCard = helpTitle?.closest('.child-session');
    const helpAssignment = helpCard?.querySelector('.agent-flow-assignment strong');
    const helpOutcome = helpCard?.querySelector('.agent-flow-outcome-copy');
    const ellipsisReady = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.textOverflow === 'ellipsis' && style.overflowX === 'hidden' && style.whiteSpace === 'nowrap';
    };
    const textTruncated = element => Boolean(element && element.scrollWidth > element.clientWidth);
    const path = document.querySelector('.agent-workflow-edge.downstream');
    const rect = element => element && element.getBoundingClientRect();
    const canvasRect = rect(canvas);
    const upstreamRect = rect(upstream);
    const selectedRect = rect(selected);
    const commandRect = rect(command);
    const downstreamRect = rect(downstream);
    const outputRect = rect(output);
    const tmuxShortcutRect = rect(tmuxShortcut);
    let pathCrossesCommand = false;
    if (path && commandRect && canvasRect) {
      const length = path.getTotalLength();
      for (let step = 0; step <= 80; step += 1) {
        const point = path.getPointAtLength(length * step / 80);
        const x = canvasRect.left + point.x;
        const y = canvasRect.top + point.y;
        if (x >= commandRect.left && x <= commandRect.right && y >= commandRect.top && y <= commandRect.bottom) {
          pathCrossesCommand = true;
          break;
        }
      }
    }
    const stacked = window.innerWidth <= 900;
    const hybrid = window.innerWidth > 900 && window.innerWidth <= 1450;
    return {
      width: window.innerWidth,
      stacked,
      hybrid,
      canvasOverflow: Boolean(canvas && canvas.scrollWidth > canvas.clientWidth + 2),
      bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      selectedBeforeCommand: Boolean(selectedRect && commandRect && selectedRect.bottom <= commandRect.top + 1),
      commandBeforeDownstream: Boolean(commandRect && downstreamRect && commandRect.bottom <= downstreamRect.top + 1),
      outputAfterCommand: Boolean(outputRect && commandRect && outputRect.top >= commandRect.bottom - 1),
      verticalOrder: !stacked || Boolean(upstreamRect && selectedRect && downstreamRect && upstreamRect.bottom <= selectedRect.top + 1 && selectedRect.bottom <= commandRect.top + 1 && commandRect.bottom <= downstreamRect.top + 1),
      horizontalOrder: stacked || Boolean(upstreamRect && selectedRect && downstreamRect && upstreamRect.right <= selectedRect.left + 1 && (hybrid || selectedRect.right <= downstreamRect.left + 1)),
      pathCrossesCommand,
      identityClipped: Boolean(identity && (identity.scrollWidth > identity.clientWidth + 1 || identity.scrollHeight > identity.clientHeight + 1)),
      tmuxShortcutVisible: Boolean(tmuxShortcutRect && tmuxShortcutRect.width > 0 && tmuxShortcutRect.height >= 40),
      tmuxShortcutInsideViewport: Boolean(tmuxShortcutRect && tmuxShortcutRect.left >= -1 && tmuxShortcutRect.right <= window.innerWidth + 1),
      helpCardInsideColumn: Boolean(helpCard && helpCard.getBoundingClientRect().right <= downstream.getBoundingClientRect().right + 1),
      helpTitleEllipsisReady: ellipsisReady(helpTitle),
      helpAssignmentEllipsisReady: ellipsisReady(helpAssignment),
      helpOutcomeEllipsisReady: ellipsisReady(helpOutcome),
      helpTextTruncated: [helpTitle, helpAssignment, helpOutcome].some(textTruncated),
      helpTextMetrics: {
        title: helpTitle ? { client: helpTitle.clientWidth, scroll: helpTitle.scrollWidth, overflow: getComputedStyle(helpTitle).textOverflow } : null,
        assignment: helpAssignment ? { client: helpAssignment.clientWidth, scroll: helpAssignment.scrollWidth, overflow: getComputedStyle(helpAssignment).textOverflow } : null,
        outcome: helpOutcome ? { client: helpOutcome.clientWidth, scroll: helpOutcome.scrollWidth, overflow: getComputedStyle(helpOutcome).textOverflow, text: helpOutcome.textContent } : null,
      },
      formCount: document.querySelectorAll('.agent-command-panel').length,
      connectionPaths: document.querySelectorAll('.agent-workflow-edge').length,
    };
  })()`);
}

function assertWorkflow(metrics) {
  if (metrics.canvasOverflow || metrics.bodyOverflow || !metrics.selectedBeforeCommand || !metrics.verticalOrder || !metrics.horizontalOrder || metrics.pathCrossesCommand || metrics.identityClipped || !metrics.tmuxShortcutVisible || !metrics.tmuxShortcutInsideViewport || !metrics.helpCardInsideColumn || !metrics.helpTitleEllipsisReady || !metrics.helpAssignmentEllipsisReady || !metrics.helpOutcomeEllipsisReady || !metrics.helpTextTruncated || metrics.formCount !== 1 || metrics.connectionPaths !== 2 || ((metrics.stacked || metrics.hybrid) && (!metrics.commandBeforeDownstream || !metrics.outputAfterCommand))) {
    throw new Error(`선택 AI 작업 흐름 배치가 올바르지 않습니다: ${JSON.stringify(metrics)}`);
  }
}

async function managementDetailMetrics(win) {
  return win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const sessions = app.state.snapshot?.sessions || [];
    const base = sessions.find(session => !session.parentId) || sessions[0] || {
      provider: 'codex', model: 'gpt-5.6', cwd: '/responsive/project', originCwd: '/responsive/project', workspace: 'responsive-project',
      status: 'waiting', statusDetail: '사용자 확인 대기', updatedAt: new Date().toISOString(), messages: [], lifecycle: [], usage: {}, context: {}, runtimePresence: [],
    };
    const id = 'responsive-management-detail';
    const signalDetail = '보고서를 작성했지만 이메일 발송은 확인되지 않았습니다. 긴 설명도 제목 영역을 누르지 않아야 합니다.';
    const artifactPath = '/Users/example/Desktop/ToyProject/efficiencyAlarm/reports/loop/daily/2026-07-21.md';
    const fixture = {
      ...base,
      id,
      externalId: id,
      parentId: null,
      childIds: [],
      title: '반응형 관리 상세 검증',
      attention: { required: false },
      progress: { stage: 'waiting', percent: 65, completedSteps: 4, totalSteps: 6, currentStep: '사용자 확인 대기', checkpoints: [] },
      health: { level: 'critical', score: 65, signals: [{ code: 'waiting-too-long', severity: 'critical', detail: signalDetail }] },
      outcome: {
        status: 'in-progress', summary: '좁은 상세 패널에서도 실행 결과를 읽기 쉽게 표시합니다.', verified: false,
        artifacts: [
          { kind: 'file', value: artifactPath, verified: false },
          { kind: 'test', value: '/Users/example/Desktop/ToyProject/efficiencyAlarm/reports/loop/LATEST.md', verified: false },
        ],
        checks: [],
      },
      evidence: { confidence: 'high', status: 'observed', hierarchy: 'observed', completion: 'unverified', sources: ['responsive-fixture'] },
      controlCapabilities: {},
    };
    app.state.snapshot.sessions = [...sessions.filter(session => session.id !== id), fixture];
    app.state.selectedId = id;
    app.state.drawerMode = 'session';
    app.state.drawerTab = 'summary';
    document.querySelector('#drawerBackdrop')?.classList.remove('hidden');
    const drawer = document.querySelector('#detailDrawer');
    drawer?.classList.add('open');
    app.renderDrawer();
    for (const animation of drawer?.getAnimations() || []) {
      try { animation.finish(); } catch {}
    }

    const detail = document.querySelector('.management-detail');
    const healthRow = detail?.querySelector('.management-health li');
    const healthTitle = healthRow?.querySelector('b');
    const healthDetail = healthRow?.querySelector('span');
    const artifact = detail?.querySelector('.management-artifacts li b');
    const artifactStyle = artifact && getComputedStyle(artifact);
    const healthTitleRect = healthTitle?.getBoundingClientRect();
    const healthDetailRect = healthDetail?.getBoundingClientRect();
    const drawerRect = drawer?.getBoundingClientRect();
    return {
      available: Boolean(detail && healthRow && healthTitle && healthDetail && artifact),
      viewportWidth: window.innerWidth,
      drawerWidth: drawerRect?.width || 0,
      drawerInsideViewport: Boolean(drawerRect && drawerRect.left >= -1 && drawerRect.right <= window.innerWidth + 1),
      detailWidth: detail?.getBoundingClientRect().width || 0,
      noHorizontalOverflow: Boolean(detail && detail.scrollWidth <= detail.clientWidth + 2),
      healthStacked: Boolean(healthTitleRect && healthDetailRect && healthDetailRect.top >= healthTitleRect.bottom - 1),
      healthTitleLines: healthTitleRect ? Math.round(healthTitleRect.height / Number.parseFloat(getComputedStyle(healthTitle).lineHeight)) : 0,
      healthDetailLines: healthDetailRect ? Math.round(healthDetailRect.height / Number.parseFloat(getComputedStyle(healthDetail).lineHeight)) : 0,
      healthDetailTitlePreserved: healthDetail?.title === signalDetail,
      artifactFontSize: artifactStyle?.fontSize || '',
      artifactEllipsisReady: artifactStyle?.overflowX === 'hidden' && artifactStyle?.textOverflow === 'ellipsis' && artifactStyle?.whiteSpace === 'nowrap',
      artifactTruncated: Boolean(artifact && artifact.scrollWidth > artifact.clientWidth),
      artifactTitlePreserved: artifact?.title === artifactPath,
    };
  })()`);
}

function assertManagementDetail(metrics) {
  if (!metrics.available || metrics.drawerWidth > 611 || !metrics.drawerInsideViewport || metrics.detailWidth > 600 || !metrics.noHorizontalOverflow || !metrics.healthStacked || metrics.healthTitleLines !== 1 || metrics.healthDetailLines > 2 || !metrics.healthDetailTitlePreserved || metrics.artifactFontSize !== '13px' || !metrics.artifactEllipsisReady || !metrics.artifactTruncated || !metrics.artifactTitlePreserved) {
    throw new Error(`실행 상세의 건강 상태·산출물 반응형 배치가 올바르지 않습니다: ${JSON.stringify(metrics)}`);
  }
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const win = await waitForWindow();
    await waitForRenderer(win);
    const sizes = [
      [1600, 980],
      [1080, 700],
      [980, 700],
      [901, 700],
      [900, 700],
      [721, 640],
      [720, 640],
      [480, 720],
      [360, 520],
    ];
    const reports = [];
    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });

    const managementDetailReports = [];
    for (const [width, height] of [[1600, 900], [480, 720]]) {
      setWindowSize(win, width, height);
      await wait(240);
      const metrics = await managementDetailMetrics(win);
      assertManagementDetail(metrics);
      fs.writeFileSync(path.join(outputDir, `loadtoagent-responsive-management-detail-${width}.png`), (await win.webContents.capturePage()).toPNG());
      managementDetailReports.push(metrics);
    }
    await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('#detailDrawer');
      window.LoadToAgentA11y?.setDialogOpenState(drawer, false);
      drawer?.classList.remove('open');
      document.querySelector('#drawerBackdrop')?.classList.add('hidden');
      window.LoadToAgentApp.state.selectedId = null;
    })()`);
    console.log(`management detail responsive check passed ${JSON.stringify(managementDetailReports)}`);

    for (const [width, height] of sizes) {
      setWindowSize(win, width, height);
      await wait(240);
      await openView(win, 'all');
      const home = await layoutMetrics(win);
      assertLayout(home, `${width}×${height} 홈 화면`);
      if (width === 720 || width === 360) {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outputDir, `loadtoagent-responsive-${width}.png`), image.toPNG());
      }
      if (width === 360) {
        const mobileProjects = await win.webContents.executeJavaScript(`(() => {
          document.querySelector('#appShell')?.removeAttribute('inert');
          document.body.classList.remove('dialog-open');
          document.querySelector('#mobileMoreBtn')?.click();
          const picker = document.querySelector('.mobile-project-picker');
          if (picker) picker.open = true;
          const menu = document.querySelector('#mobileToolsMenu');
          const list = document.querySelector('#mobileWorkspaceList');
          const selectedItem = list?.querySelector('[aria-pressed="true"]');
          const menuRect = menu?.getBoundingClientRect();
          return {
            visible: Boolean(menu && !menu.classList.contains('hidden') && picker?.open),
            selected: selectedItem?.textContent.trim() || '',
            selectedRepresentedOnce: Boolean(selectedItem && getComputedStyle(selectedItem).display === 'none'),
            singleScrollRegion: Boolean(list && list.scrollHeight <= list.clientHeight + 1),
            noHorizontalOverflow: Boolean(menu && menu.scrollWidth <= menu.clientWidth + 2 && list && list.scrollWidth <= list.clientWidth + 2),
            insideViewport: Boolean(menuRect && menuRect.left >= -1 && menuRect.right <= window.innerWidth + 1 && menuRect.top >= -1 && menuRect.bottom <= window.innerHeight + 1),
          };
        })()`);
        if (!mobileProjects.visible || !mobileProjects.selected || !mobileProjects.selectedRepresentedOnce || !mobileProjects.singleScrollRegion || !mobileProjects.noHorizontalOverflow || !mobileProjects.insideViewport) throw new Error(`360×520 모바일 프로젝트 선택기가 올바르지 않습니다: ${JSON.stringify(mobileProjects)}`);
        await wait(120);
        fs.writeFileSync(path.join(outputDir, 'loadtoagent-responsive-projects-360.png'), (await win.webContents.capturePage()).toPNG());
        const projectSelection = await win.webContents.executeJavaScript(`(() => {
          const choice = [...document.querySelectorAll('#mobileWorkspaceList [data-workspace]')].find(item => item.getAttribute('aria-pressed') !== 'true');
          choice?.click();
          return choice?.dataset.workspace || '';
        })()`);
        await wait(120);
        const projectSelectionResult = await win.webContents.executeJavaScript(`(() => ({
          menuClosed: document.querySelector('#mobileToolsMenu')?.classList.contains('hidden'),
          expanded: document.querySelector('#mobileMoreBtn')?.getAttribute('aria-expanded'),
          focusedMain: !document.hasFocus() || document.activeElement?.id === 'mainContent' || Boolean(document.activeElement?.closest?.('[data-session-id], [data-graph-focus], [data-open-session]')),
          activeElement: { id: document.activeElement?.id || '', tag: document.activeElement?.tagName || '', hasFocus: document.hasFocus() },
          focusContext: { appInert: document.querySelector('#appShell')?.inert, mainInert: document.querySelector('#mainContent')?.inert, mainTabIndex: document.querySelector('#mainContent')?.tabIndex, mainRects: document.querySelector('#mainContent')?.getClientRects().length },
          workspace: window.LoadToAgentApp.state.workspace,
        }))()`);
        if (!projectSelection || !projectSelectionResult.menuClosed || projectSelectionResult.expanded !== 'false' || !projectSelectionResult.focusedMain || projectSelectionResult.workspace !== projectSelection) throw new Error(`360×520 모바일 프로젝트 선택 후 닫기·포커스 복귀가 올바르지 않습니다: ${JSON.stringify(projectSelectionResult)}`);
        await win.webContents.executeJavaScript(`(() => { window.LoadToAgentApp.state.workspace = 'all'; window.LoadToAgentApp.renderWorkspaces(); window.LoadToAgentApp.renderSessions('filter'); })()`);
      }

      const overlays = await overlayMetrics(win, width === 720 || width === 360 ? path.join(outputDir, `loadtoagent-responsive-new-run-${width}.png`) : '');
      if (!overlays.modalInsideViewport || !overlays.drawerInsideViewport || !overlays.modalNoHorizontalOverflow || !overlays.providerCardsInsideModal || !overlays.actionsInsideViewport || !overlays.promptCounterVisible || !overlays.promptFirst) {
        throw new Error(`${width}×${height} 오버레이 배치가 올바르지 않습니다: ${JSON.stringify(overlays)}`);
      }

      await openView(win, 'runtime');
      const runtime = await layoutMetrics(win);
      assertLayout(runtime, `${width}×${height} 스케줄·루프 화면`);

      await openView(win, 'terminal');
      await win.webContents.executeJavaScript(`document.querySelector('.terminal-session-tools')?.setAttribute('open', '')`);
      const terminal = await layoutMetrics(win);
      assertLayout(terminal, `${width}×${height} 터미널 화면`);
      if (width <= 720 && !terminal.terminalActionLabels) throw new Error(`${width}×${height} 터미널 중단·지우기 버튼의 텍스트가 보이지 않습니다: ${JSON.stringify(terminal)}`);

      await openView(win, 'tmux');
      const tmux = await layoutMetrics(win);
      assertLayout(tmux, `${width}×${height} tmux 화면`);
      reports.push({
        requested: `${width}×${height}`,
        actual: `${home.width}×${home.height}`,
        homeFrame: { stageScrollLeft: home.stageScrollLeft, stageRect: home.stageRect, topbarRect: home.topbarRect, topbarCopyRect: home.topbarCopyRect },
        overlays,
      });
    }

    const workflowReports = [];
    for (const [width, height] of [[1500, 900], [1400, 800], [1280, 800], [1080, 700], [900, 700], [720, 640], [480, 720], [360, 520]]) {
      setWindowSize(win, width, height);
      await wait(240);
      await setupWorkflowFixture(win);
      await wait(360);
      const metrics = await workflowMetrics(win);
      assertWorkflow(metrics);
      if (width === 1080 || width === 360) {
        await win.webContents.executeJavaScript(`new Promise(resolve => {
          window.__ensureResponsiveWorkflowFixture?.();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            window.LoadToAgentApp.drawAgentWorkflowConnections();
            const stage = document.querySelector('.main-stage');
            const canvas = document.querySelector('.agent-workflow-canvas');
            if (stage && canvas) stage.scrollTo(0, Math.max(0, canvas.offsetTop - 12));
            resolve(true);
          }));
        })`);
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outputDir, `loadtoagent-responsive-workflow-${width}.png`), image.toPNG());
        await win.webContents.executeJavaScript(`(() => {
          const stage = document.querySelector('.main-stage');
          const downstream = document.querySelector('.downstream-stack .child-session');
          if (!stage || !downstream) return false;
          const stageTop = stage.getBoundingClientRect().top;
          stage.scrollTo(0, Math.max(0, stage.scrollTop + downstream.getBoundingClientRect().top - stageTop - 12));
          return true;
        })()`);
        await wait(180);
        const helpImage = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outputDir, `loadtoagent-responsive-help-sessions-${width}.png`), helpImage.toPNG());
      }
      workflowReports.push(metrics);
    }

    console.log(`responsive check passed ${JSON.stringify({ views: reports, workflows: workflowReports, managementDetails: managementDetailReports })}`);
  } catch (error) {
    exitCode = 1;
    console.error(error && error.stack || error);
  } finally {
    app.exit(exitCode);
  }
});
