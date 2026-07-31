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
    if (!window.LoadToAgentApp?.selectView) return false;
    window.LoadToAgentApp.selectView(${JSON.stringify(view)});
    document.querySelector('.main-stage')?.scrollTo(0, 0);
    return true;
  })()`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const activeView = await win.webContents.executeJavaScript(`window.LoadToAgentApp?.state?.view || ''`);
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
    const projectNav = document.querySelector('#projectTaskToolbar');
    const projectNavRect = projectNav?.getBoundingClientRect();
    const projectToolsSummary = document.querySelector('#advancedToolsNav > summary');
    const projectToolsRect = projectToolsSummary?.getBoundingClientRect();
    const navItems = [...document.querySelectorAll('#projectViewTabs > .nav-item')];
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
    const tmuxNav = projectToolsSummary;
    const tmuxNavRect = tmuxNav?.getBoundingClientRect();
    const tmuxRouteVisible = Boolean(
      tmuxShortcutRect && tmuxShortcutRect.width > 0 && tmuxShortcutRect.height >= 40
      || tmuxNavRect && tmuxNavRect.width > 0 && tmuxNavRect.height >= 40
    );
    const tmuxRouteInsideViewport = Boolean(
      tmuxShortcutRect && tmuxShortcutRect.left >= -1 && tmuxShortcutRect.right <= window.innerWidth + 1
      || tmuxNavRect && tmuxNavRect.left >= -1 && tmuxNavRect.right <= window.innerWidth + 1
    );
    const liveSectionVisible = !document.querySelector('#liveSection')?.classList.contains('hidden');
    const projectSelected = document.body.dataset.projectSelected === 'true';
    const projectSelectionPrompt = document.querySelector('#projectSelectionPrompt');
    const projectSelectionPromptVisible = Boolean(projectSelectionPrompt
      && getComputedStyle(projectSelectionPrompt).display !== 'none'
      && projectSelectionPrompt.getBoundingClientRect().width > 0
      && projectSelectionPrompt.getBoundingClientRect().height > 0);
    const projectGroups = [...document.querySelectorAll('.control-room-project-group')];
    const openProjectBodies = [...document.querySelectorAll('.control-room-project-group[open] .control-project-body')];
    const clippedOpenProjectBodies = openProjectBodies.filter(body => body.scrollHeight > body.clientHeight + 2).length;
    const inaccessibleProjectBodies = document.querySelectorAll('.control-project-body[inert], .control-project-body[aria-hidden="true"]').length;
    const stageRect = stage?.getBoundingClientRect();
    const topbar = document.querySelector('.topbar');
    const topbarRect = topbar?.getBoundingClientRect();
    const topbarCopy = [
      document.querySelector('#sessionTokenOverview'),
      document.querySelector('.topbar-page-copy'),
    ].find(element => {
      const rect = element?.getBoundingClientRect();
      const style = element && getComputedStyle(element);
      return Boolean(rect && style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0);
    });
    const topbarCopyRect = topbarCopy?.getBoundingClientRect();
    const stageOverflowItems = stage && stageRect
      ? [...stage.querySelectorAll('*')]
        .filter(item => {
          const rect = item.getBoundingClientRect();
          return rect.width > 0 && (
            rect.left < stageRect.left - 1
            || rect.right > stageRect.right + 1
            || item.scrollWidth > item.clientWidth + 2
          );
        })
        .slice(0, 10)
        .map(item => {
          const rect = item.getBoundingClientRect();
          return {
            tag: item.tagName,
            id: item.id,
            className: String(item.className || '').slice(0, 100),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            scrollWidth: item.scrollWidth,
            clientWidth: item.clientWidth,
          };
        })
      : [];
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      compact,
      currentView: window.LoadToAgentApp?.state?.view || '',
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      stageOverflow: Boolean(stage && stage.scrollWidth > stage.clientWidth + 2),
      stageOverflowItems,
      stageScrollLeft: stage?.scrollLeft || 0,
      stageRect: stageRect ? { left: stageRect.left, right: stageRect.right, top: stageRect.top, bottom: stageRect.bottom, width: stageRect.width } : null,
      topbarRect: topbarRect ? { left: topbarRect.left, right: topbarRect.right, width: topbarRect.width } : null,
      topbarCopyRect: topbarCopyRect ? { left: topbarCopyRect.left, right: topbarCopyRect.right, width: topbarCopyRect.width, height: topbarCopyRect.height } : null,
      projectNavRect: projectNavRect ? { left: projectNavRect.left, right: projectNavRect.right, top: projectNavRect.top, bottom: projectNavRect.bottom, width: projectNavRect.width } : null,
      projectNavigationInMain: Boolean(projectNav && stage?.contains(projectNav) && !sidebar?.contains(projectNav)
        && projectNavRect && stageRect && projectNavRect.left >= stageRect.left - 1 && projectNavRect.right <= stageRect.right + 1),
      projectSelected,
      projectSelectionPromptVisible,
      liveSectionVisible,
      projectToolsVisible: compact || Boolean(projectToolsRect && projectToolsRect.width > 0 && projectToolsRect.height > 0),
      projectToolsAccessible: compact || Boolean(projectToolsSummary?.getAttribute('aria-label')?.trim()),
      sectionOverflow,
      sectionOverflowDetails,
      sidebarInsideViewport: compact || Boolean(sidebarRect && sidebarRect.left >= -1 && sidebarRect.right <= window.innerWidth + 1 && sidebarRect.bottom <= window.innerHeight + 1),
      sidebarHiddenOnCompact: !compact || getComputedStyle(sidebar).display === 'none',
      navCount: navItems.length,
      visibleNavItems: visibleNavItems.map(item => item.dataset.view || item.id),
      visibleNavItemRects: visibleNavItems.map(item => {
        const rect = item.getBoundingClientRect();
        return {
          id: item.dataset.view || item.id,
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          top: Math.round(rect.top * 10) / 10,
          bottom: Math.round(rect.bottom * 10) / 10,
        };
      }),
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
      projectFilterAvailable: !['all', 'active'].includes(window.LoadToAgentApp?.state?.view)
        || (window.innerWidth <= 720
          ? Boolean(document.querySelector('#mobileWorkspaceList'))
          : Boolean(document.querySelector('#projectSidebarList [data-workspace]'))),
      compactContentClearance: !compact || Boolean(stageRect && stageRect.bottom <= window.innerHeight + 1),
      terminalActionLabels,
      tmuxShortcutVisible: !liveSectionVisible || tmuxRouteVisible,
      tmuxShortcutInsideViewport: !liveSectionVisible || tmuxRouteInsideViewport,
      openProjectGroups: projectGroups.filter(group => group.open).length,
      clippedOpenProjectBodies,
      inaccessibleProjectBodies,
      projectLayoutValid: !liveSectionVisible || projectGroups.length === 0
        || (projectGroups.filter(group => group.open).length <= 1 && clippedOpenProjectBodies === 0 && inaccessibleProjectBodies === 0),
    };
  })()`);
}

function assertLayout(metrics, context) {
  const hiddenLegacyNavigationValid = metrics.visibleNavItems.length === 0;
  const projectStateValid = metrics.currentView !== 'all'
    || (metrics.projectSelected
      ? metrics.projectNavigationInMain && metrics.liveSectionVisible && !metrics.projectSelectionPromptVisible
      : !metrics.projectNavigationInMain && !metrics.liveSectionVisible && metrics.projectSelectionPromptVisible);
  if (metrics.documentOverflow || metrics.stageOverflow || Math.abs(metrics.stageScrollLeft) > 1 || !metrics.stageRect || metrics.stageRect.left < -1 || metrics.stageRect.right > metrics.width + 1 || !metrics.topbarRect || metrics.topbarRect.left < -1 || metrics.topbarRect.right > metrics.width + 1 || !metrics.topbarCopyRect || metrics.topbarCopyRect.width <= 0 || metrics.topbarCopyRect.height <= 0 || metrics.topbarCopyRect.left < -1 || metrics.topbarCopyRect.right > metrics.width + 1 || !projectStateValid || !metrics.projectToolsAccessible || metrics.sectionOverflow.length || !metrics.sidebarInsideViewport || !metrics.sidebarHiddenOnCompact || metrics.navCount !== 4 || !metrics.navItemsInsideViewport || !metrics.navAccessibleNames || !metrics.sidebarNoInternalOverflow || !metrics.narrowSidebarLabelsVisible || !metrics.narrowSidebarTitles || !metrics.projectLayoutValid || !metrics.compactContentClearance || !hiddenLegacyNavigationValid || (!metrics.compact && metrics.tmuxShortcutVisible && !metrics.tmuxShortcutInsideViewport)) {
    throw new Error(`${context} 반응형 배치가 올바르지 않습니다: ${JSON.stringify(metrics)}`);
  }
}

async function settingsLayoutMetrics(win) {
  return win.webContents.executeJavaScript(`(() => {
    const visible = element => {
      const rect = element?.getBoundingClientRect();
      const style = element && getComputedStyle(element);
      return Boolean(rect && style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0);
    };
    const rectOf = element => {
      const rect = element?.getBoundingClientRect();
      return rect ? {
        left: Math.round(rect.left * 10) / 10,
        right: Math.round(rect.right * 10) / 10,
        top: Math.round(rect.top * 10) / 10,
        bottom: Math.round(rect.bottom * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      } : null;
    };
    const horizontalOverlap = (first, second) => {
      const a = first.getBoundingClientRect();
      const b = second.getBoundingClientRect();
      return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    };
    const overlappingPairs = (elements, siblingsOnly = false) => {
      const overlaps = [];
      for (let index = 0; index < elements.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < elements.length; otherIndex += 1) {
          if (siblingsOnly && elements[index].parentElement !== elements[otherIndex].parentElement) continue;
          if (horizontalOverlap(elements[index], elements[otherIndex])) {
            overlaps.push([
              elements[index].id || elements[index].className || elements[index].tagName,
              elements[otherIndex].id || elements[otherIndex].className || elements[otherIndex].tagName,
            ]);
          }
        }
      }
      return overlaps;
    };
    const gridColumnCount = element => {
      const columns = element && getComputedStyle(element).gridTemplateColumns;
      return columns && columns !== 'none' ? columns.trim().split(/\\s+/).filter(Boolean).length : 0;
    };
    const section = document.querySelector('#settingsSection');
    const sectionRect = section?.getBoundingClientRect();
    const cards = [...(section?.querySelectorAll(':scope > .language-settings-card, :scope > .theme-settings-card, :scope > .settings-help-card, :scope > .provider-visibility-card, :scope > .update-panel, :scope > .settings-meta-grid') || [])]
      .filter(visible);
    const options = [...document.querySelectorAll('#providerVisibilityList > .provider-visibility-option')].filter(visible);
    const controls = [...(section?.querySelectorAll('button, select, .provider-visibility-option') || [])].filter(visible);
    const helpActions = [
      document.querySelector('#guideBtn'),
      document.querySelector('#shortcutHelpBtn'),
      document.querySelector('#appConnectionState'),
    ].filter(visible);
    const cardOverflow = cards.filter(card => {
      const rect = card.getBoundingClientRect();
      return card.scrollWidth > card.clientWidth + 2
        || !sectionRect
        || rect.left < sectionRect.left - 1
        || rect.right > sectionRect.right + 1;
    }).map(card => ({
      id: card.id,
      className: card.className,
      rect: rectOf(card),
      scrollWidth: card.scrollWidth,
      clientWidth: card.clientWidth,
    }));
    const optionOverflow = options.filter(option => {
      const rect = option.getBoundingClientRect();
      const listRect = option.parentElement?.getBoundingClientRect();
      return option.scrollWidth > option.clientWidth + 2
        || !listRect
        || rect.left < listRect.left - 1
        || rect.right > listRect.right + 1
        || rect.left < -1
        || rect.right > window.innerWidth + 1;
    }).map(option => ({
      provider: option.querySelector('.provider-visibility-name b')?.textContent.trim() || '',
      rect: rectOf(option),
      scrollWidth: option.scrollWidth,
      clientWidth: option.clientWidth,
    }));
    const controlMetrics = controls.map(control => ({
      id: control.id,
      className: control.className,
      tag: control.tagName,
      rect: rectOf(control),
    }));
    const shortControls = controlMetrics.filter(control => control.rect.height < 43.5);
    const controlsOutsideViewport = controlMetrics.filter(control => control.rect.left < -1 || control.rect.right > window.innerWidth + 1);
    const helpActionMetrics = helpActions.map(action => {
      const label = action.matches('#guideBtn')
        ? action.querySelector(':scope > span:nth-child(2)')
        : action.querySelector('b, div');
      return {
        id: action.id,
        rect: rectOf(action),
        labelHeight: rectOf(label)?.height || 0,
      };
    });
    const helpActionWidths = helpActionMetrics.map(action => action.rect.width);
    const helpActionVisualOrder = [...helpActionMetrics]
      .sort((first, second) => first.rect.top - second.rect.top || first.rect.left - second.rect.left)
      .map(action => action.id);
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      sectionAvailable: visible(section),
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      sectionOverflow: Boolean(section && section.scrollWidth > section.clientWidth + 2),
      sectionRect: rectOf(section),
      cardCount: cards.length,
      cardOverflow,
      cardSiblingOverlaps: overlappingPairs(cards),
      optionCount: options.length,
      optionOverflow,
      optionSiblingOverlaps: overlappingPairs(options),
      controlCount: controls.length,
      shortControls,
      controlsOutsideViewport,
      controlSiblingOverlaps: overlappingPairs(controls, true),
      helpActionMetrics,
      helpActionVisualOrder,
      helpActionWidthDelta: helpActionWidths.length
        ? Math.max(...helpActionWidths) - Math.min(...helpActionWidths)
        : Number.POSITIVE_INFINITY,
      overwrappedHelpActions: helpActionMetrics.filter(action => action.rect.height > 120 || action.labelHeight > 84),
      providerCardColumns: gridColumnCount(document.querySelector('.provider-visibility-card')),
      providerListColumns: gridColumnCount(document.querySelector('#providerVisibilityList')),
      helpCardColumns: gridColumnCount(document.querySelector('.settings-help-card')),
    };
  })()`);
}

function assertSettingsLayout(metrics, context) {
  const expectedProviderCardColumns = metrics.viewportWidth <= 1375 ? 1 : 2;
  const expectedProviderListColumns = metrics.viewportWidth <= 999 ? 1 : 2;
  const expectedHelpCardColumns = metrics.viewportWidth <= 880 ? 1 : 2;
  const helpActionsInExpectedOrder = JSON.stringify(metrics.helpActionVisualOrder) === JSON.stringify(['guideBtn', 'shortcutHelpBtn', 'appConnectionState']);
  const helpActionsAligned = metrics.viewportWidth > 880
    || (metrics.helpActionMetrics.length === 3 && metrics.helpActionWidthDelta <= 1 && metrics.overwrappedHelpActions.length === 0);
  if (!metrics.sectionAvailable || metrics.documentOverflow || metrics.sectionOverflow || metrics.cardCount < 5 || metrics.cardOverflow.length || metrics.cardSiblingOverlaps.length || metrics.optionCount < 1 || metrics.optionOverflow.length || metrics.optionSiblingOverlaps.length || metrics.controlCount < 8 || metrics.shortControls.length || metrics.controlsOutsideViewport.length || metrics.controlSiblingOverlaps.length || !helpActionsInExpectedOrder || !helpActionsAligned || metrics.providerCardColumns !== expectedProviderCardColumns || metrics.providerListColumns !== expectedProviderListColumns || metrics.helpCardColumns !== expectedHelpCardColumns) {
    throw new Error(`${context} 설정 카드·버튼 반응형 배치가 올바르지 않습니다: ${JSON.stringify(metrics)}`);
  }
}

async function stickyNavigationMetrics(win) {
  return win.webContents.executeJavaScript(`(async () => {
    const stage = document.querySelector('.main-stage');
    const topbar = document.querySelector('.topbar');
    const projectNav = document.querySelector('#projectContextNav');
    if (!stage || !topbar || !projectNav) return { available: false };
    const originalScrollTop = stage.scrollTop;
    const scrollRange = Math.max(0, stage.scrollHeight - stage.clientHeight);
    stage.scrollTop = Math.min(scrollRange, Math.max(220, Math.round(stage.clientHeight * .72)));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const scrolledTop = stage.scrollTop;
    const topbarRect = topbar.getBoundingClientRect();
    const projectNavRect = projectNav.getBoundingClientRect();
    const style = getComputedStyle(projectNav);
    const projectNavVisible = style.display !== 'none' && style.visibility !== 'hidden'
      && projectNavRect.width > 0 && projectNavRect.height > 0;
    const topbarStyle = getComputedStyle(topbar);
    const visibleTopbarChildren = [...topbar.children].filter(child => {
      const rect = child.getBoundingClientRect();
      const childStyle = getComputedStyle(child);
      return childStyle.display !== 'none' && childStyle.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }).map(child => ({
      id: child.id,
      className: child.className,
      text: child.textContent.trim().slice(0, 80),
      rect: { top: child.getBoundingClientRect().top, bottom: child.getBoundingClientRect().bottom, height: child.getBoundingClientRect().height },
    }));
    stage.scrollTop = originalScrollTop;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      available: true,
      scrollRange,
      scrolledTop,
      restoredScrollTop: stage.scrollTop,
      originalScrollTop,
      position: style.position,
      projectNavVisible,
      topbarRect: { top: topbarRect.top, bottom: topbarRect.bottom, height: topbarRect.height },
      topbarStyle: {
        minHeight: topbarStyle.minHeight,
        paddingTop: topbarStyle.paddingTop,
        paddingBottom: topbarStyle.paddingBottom,
      },
      visibleTopbarChildren,
      projectNavRect: { top: projectNavRect.top, bottom: projectNavRect.bottom },
      noStickyOverlap: topbarRect.bottom <= projectNavRect.top + 1,
      projectNavInsideViewport: projectNavRect.top >= -1 && projectNavRect.bottom <= window.innerHeight + 1,
    };
  })()`);
}

function assertStickyNavigation(metrics, context) {
  const hiddenProjectNavigationIsValid = metrics.available
    && metrics.projectNavVisible === false
    && metrics.topbarRect.height > 0
    && metrics.visibleTopbarChildren.length > 0;
  const visibleProjectNavigationIsValid = metrics.available
    && metrics.projectNavVisible
    && metrics.position === 'sticky'
    && metrics.noStickyOverlap
    && metrics.projectNavInsideViewport;
  if (metrics.scrollRange < 100 || metrics.scrolledTop < 100 || (!hiddenProjectNavigationIsValid && !visibleProjectNavigationIsValid) || Math.abs(metrics.restoredScrollTop - metrics.originalScrollTop) > 1) {
    throw new Error(`${context} 고정 프로젝트 탐색 배치가 올바르지 않습니다: ${JSON.stringify(metrics)}`);
  }
}

async function setupDashboardStickyFixture(win) {
  return win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const sessions = app.state.snapshot?.sessions || [];
    if (!window.__responsiveDashboardStickyOriginal) {
      window.__responsiveDashboardStickyOriginal = {
        sessions: [...sessions],
        view: app.state.view,
        workspace: app.state.workspace,
        selectedId: app.state.selectedId,
        graphFocusId: app.state.graphFocusId,
      };
    }
    const providers = ['codex', 'claude', 'gemini', 'grok'];
    const now = Date.now();
    const fixtures = Array.from({ length: 8 }, (_, index) => {
      const running = index < 4;
      const id = 'responsive-sticky-' + index;
      return {
        id,
        externalId: id,
        parentId: null,
        childIds: [],
        depth: 0,
        provider: providers[index % providers.length],
        model: index % 2 ? 'responsive-model-long-name' : 'gpt-5.6',
        cwd: '/responsive/sticky-dashboard/project',
        originCwd: '/responsive/sticky-dashboard/project',
        workspace: 'responsive-sticky-project',
        title: id + ' 토큰 카드가 채워진 대시보드 고정 영역 검증 세션',
        status: running ? 'running' : 'completed',
        statusDetail: running ? '반응형 고정 영역을 확인하는 중' : '반응형 고정 영역 확인 완료',
        createdAt: new Date(now - (index + 1) * 120000).toISOString(),
        updatedAt: new Date(now - index * 1000).toISOString(),
        messages: [],
        lifecycle: [],
        runtimePresence: [],
        usage: {
          input: 48000 - index * 1300,
          cachedInput: 9000 - index * 300,
          output: 12000 - index * 500,
          reasoning: 6000 - index * 250,
          total: 75000 - index * 4200,
        },
        context: { window: 200000, used: 92000 - index * 3000, percent: 46 - index },
      };
    });
    window.__responsiveDashboardStickyFixtures = fixtures;
    window.__ensureResponsiveDashboardStickyFixture = () => {
      app.state.snapshot.sessions = window.__responsiveDashboardStickyFixtures;
      app.state.workspace = '/responsive/sticky-dashboard/project';
      app.state.view = 'all';
      app.state.selectedId = null;
      app.state.graphFocusId = null;
      app.render('filter');
    };
    window.__ensureResponsiveDashboardStickyFixture();
    document.querySelector('.main-stage')?.scrollTo(0, 0);
    return fixtures.length;
  })()`);
}

async function cleanupDashboardStickyFixture(win) {
  return win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const original = window.__responsiveDashboardStickyOriginal;
    if (!original) return '';
    app.state.snapshot.sessions = original.sessions;
    app.state.workspace = original.workspace;
    app.state.selectedId = original.selectedId;
    app.state.graphFocusId = original.graphFocusId;
    app.render('filter');
    document.querySelector('.main-stage')?.scrollTo(0, 0);
    delete window.__responsiveDashboardStickyOriginal;
    delete window.__responsiveDashboardStickyFixtures;
    delete window.__ensureResponsiveDashboardStickyFixture;
    return original.view || 'all';
  })()`);
}

async function dashboardStickyNavigationMetrics(win) {
  return win.webContents.executeJavaScript(`(async () => {
    window.__ensureResponsiveDashboardStickyFixture?.();
    const stage = document.querySelector('.main-stage');
    const topbar = document.querySelector('.topbar');
    const projectNav = document.querySelector('#projectTaskToolbar');
    const historyRail = document.querySelector('#projectHistoryRail');
    const tokenOverview = document.querySelector('#sessionTokenOverview');
    const tokenItems = [...document.querySelectorAll('#sessionTokenList > .session-token-item')];
    if (!stage || !topbar || !projectNav || !historyRail || !tokenOverview) return { available: false };
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const rectOf = element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const originalScrollTop = stage.scrollTop;
    stage.scrollTop = 0;
    const initialTopbarRect = rectOf(topbar);
    const initialProjectNavRect = rectOf(projectNav);
    const tokenOverviewRect = rectOf(tokenOverview);
    const tokenData = tokenItems.map(item => {
      const meter = item.querySelector('[role="progressbar"]');
      const title = item.getAttribute('title') || '';
      return {
        id: item.dataset.tokenProvider || '',
        title,
        value: Number(meter?.getAttribute('aria-valuenow') || 0),
        label: meter?.getAttribute('aria-label') || '',
        visible: visible(item),
      };
    });
    const scrollRange = Math.max(0, stage.scrollHeight - stage.clientHeight);
    stage.scrollTop = Math.min(scrollRange, Math.max(260, Math.ceil(initialTopbarRect.height + initialProjectNavRect.height + 48)));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const scrolledTop = stage.scrollTop;
    const stageRect = rectOf(stage);
    const topbarRect = rectOf(topbar);
    const projectNavRect = rectOf(projectNav);
    const historyRailRect = rectOf(historyRail);
    const stickyCandidates = [topbar, projectNav, historyRail].map(element => ({
      id: element.id || element.className,
      position: getComputedStyle(element).position,
      rect: rectOf(element),
    }));
    const stickyOwners = stickyCandidates.filter(item => item.position === 'sticky');
    const stickyCollisions = [];
    for (let index = 0; index < stickyOwners.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < stickyOwners.length; otherIndex += 1) {
        const first = stickyOwners[index];
        const second = stickyOwners[otherIndex];
        const horizontal = Math.min(first.rect.right, second.rect.right) - Math.max(first.rect.left, second.rect.left);
        const vertical = Math.min(first.rect.bottom, second.rect.bottom) - Math.max(first.rect.top, second.rect.top);
        if (horizontal > 1 && vertical > 1) stickyCollisions.push([first.id, second.id]);
      }
    }
    stage.scrollTop = originalScrollTop;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      available: true,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollRange,
      scrolledTop,
      originalScrollTop,
      restoredScrollTop: stage.scrollTop,
      initialTopbarRect,
      tokenOverviewRect,
      tokenCardCount: tokenItems.length,
      visibleTokenCardCount: tokenData.filter(item => item.visible).length,
      tokenData,
      topbarPosition: getComputedStyle(topbar).position,
      projectNavPosition: getComputedStyle(projectNav).position,
      historyRailPosition: getComputedStyle(historyRail).position,
      stickyOwners: stickyOwners.map(item => item.id),
      stickyCollisions,
      topbarRect,
      projectNavRect,
      historyRailRect,
      topbarClearedStickyLayer: topbarRect.bottom <= projectNavRect.top + 1,
      projectNavPinnedToStage: Math.abs(projectNavRect.top - stageRect.top) <= 1,
      projectNavInsideViewport: projectNavRect.top >= stageRect.top - 1 && projectNavRect.bottom <= stageRect.bottom + 1,
    };
  })()`);
}

function assertDashboardStickyNavigation(metrics, context) {
  const minimumVisibleTokens = metrics.viewportWidth <= 720 ? 1 : metrics.viewportWidth <= 1180 ? 2 : 4;
  const expectedTokenIds = ['claude', 'codex', 'gemini', 'grok'];
  const tokenDataPresent = metrics.tokenData?.length === 4
    && metrics.tokenData.every(item => item.id && item.title && item.visible
      && (item.value > 0 ? Boolean(item.label) : /수치 미확인|unavailable|未知/.test(item.title)))
    && JSON.stringify(metrics.tokenData.map(item => item.id)) === JSON.stringify(expectedTokenIds);
  const oneProjectNavStickyOwner = JSON.stringify(metrics.stickyOwners) === JSON.stringify(['projectTaskToolbar']);
  if (!metrics.available || metrics.scrollRange < 100 || metrics.scrolledTop < 100 || metrics.tokenCardCount !== 4 || metrics.visibleTokenCardCount < minimumVisibleTokens || !tokenDataPresent || metrics.tokenOverviewRect.height <= 0 || metrics.topbarPosition !== 'relative' || metrics.projectNavPosition !== 'sticky' || metrics.historyRailPosition !== 'static' || !oneProjectNavStickyOwner || metrics.stickyCollisions.length || !metrics.topbarClearedStickyLayer || metrics.projectNavRect.width <= 0 || metrics.projectNavRect.height <= 0 || Math.abs(metrics.restoredScrollTop - metrics.originalScrollTop) > 1) {
    throw new Error(`${context} 토큰 대시보드 고정 영역 배치가 올바르지 않습니다: ${JSON.stringify(metrics)}`);
  }
}

async function overlayMetrics(win, capturePath = '') {
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    if (!app.state.workspace || app.state.workspace === 'all' || app.state.workspace === '__projectless__') {
      app.state.workspace = app.state.workspaces?.[0]?.path
        || document.querySelector('#projectSidebarList [data-workspace]')?.dataset.workspace
        || (app.state.snapshot?.sessions || []).find(session => !session.parentId && (session.originCwd || session.cwd))?.originCwd
        || (app.state.snapshot?.sessions || []).find(session => !session.parentId && (session.originCwd || session.cwd))?.cwd
        || '';
      app.renderWorkspaces();
      app.renderSessions('filter');
    }
    app.openRunModal();
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
    const providerCards = [...document.querySelectorAll('.run-provider-option')].map(item => item.getBoundingClientRect());
    const promptFirst = Boolean(prompt && providers && (prompt.compareDocumentPosition(providers) & Node.DOCUMENT_POSITION_FOLLOWING));
    const modalNoHorizontalOverflow = Boolean(form && form.scrollWidth <= form.clientWidth + 2);
    const modalScrollWidth = form?.scrollWidth || 0;
    const modalClientWidth = form?.clientWidth || 0;
    const providerCardsInsideModal = Boolean(modal && providerCards.length && providerCards.every(rect => rect.left >= modal.left - 1 && rect.right <= modal.right + 1));
    if (form) form.scrollTop = form.scrollHeight;
    const actions = document.querySelector('.run-modal-actions')?.getBoundingClientRect();
    const actionsInsideViewport = viewportContains(actions) && Boolean(modal && actions.left >= modal.left - 1 && actions.right <= modal.right + 1);
    const promptCounterVisible = Boolean(document.querySelector('#runPromptCount')?.offsetParent);
    const horizontalOverflow = [...form.children].map(element => {
      const rect = element.getBoundingClientRect();
      return { className: element.className, left: rect.left, right: rect.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    }).filter(item => item.clientWidth && modal && (item.left < modal.left - 1 || item.right > modal.right + 1 || item.scrollWidth > item.clientWidth + 2));
    const runModal = document.querySelector('#runModal');
    window.LoadToAgentA11y?.setDialogOpenState(runModal, false);
    runModal?.classList.add('hidden');
    runModal?.classList.remove('closing');
    runModal?.setAttribute('aria-hidden', 'true');
    if (runModal) runModal.inert = true;
    const drawer = document.querySelector('#detailDrawer');
    const backdrop = document.querySelector('#drawerBackdrop');
    const drawerRect = drawer?.getBoundingClientRect();
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility === 'visible'
        && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    };
    const leakedControls = [...document.querySelectorAll('#appShell button, #appShell a[href], #appShell summary, #appShell input, #appShell select, #appShell textarea')]
      .filter(visible)
      .map(element => {
        const rect = element.getBoundingClientRect();
        const left = Math.max(rect.left, drawerRect?.left ?? window.innerWidth);
        const right = Math.min(rect.right, drawerRect?.right ?? 0);
        const top = Math.max(rect.top, drawerRect?.top ?? window.innerHeight);
        const bottom = Math.min(rect.bottom, drawerRect?.bottom ?? 0);
        if (right <= left || bottom <= top) return null;
        const topElement = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        if (topElement && (topElement === element || element.contains(topElement))) {
          return {
            id: element.id || '',
            className: String(element.className || ''),
            text: element.textContent.trim().slice(0, 80),
          };
        }
        return null;
      })
      .filter(Boolean);
    drawer?.classList.remove('open');
    if (drawer) drawer.style.transition = '';
    backdrop?.classList.add('hidden');
    window.LoadToAgentA11y?.setDialogOpenState(drawer, false);
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
      drawerLeakedControls: leakedControls,
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
      window.LoadToAgentApp.state.workspace = '/responsive/project';
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
    const tmuxNav = document.querySelector('#advancedToolsNav > summary');
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
    const tmuxNavRect = rect(tmuxNav);
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
      tmuxShortcutVisible: Boolean(
        tmuxShortcutRect && tmuxShortcutRect.width > 0 && tmuxShortcutRect.height >= 40
        || tmuxNavRect && tmuxNavRect.width > 0 && tmuxNavRect.height >= 40
      ),
      tmuxShortcutInsideViewport: Boolean(
        tmuxShortcutRect && tmuxShortcutRect.left >= -1 && tmuxShortcutRect.right <= window.innerWidth + 1
        || tmuxNavRect && tmuxNavRect.left >= -1 && tmuxNavRect.right <= window.innerWidth + 1
      ),
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
  if (metrics.canvasOverflow || metrics.bodyOverflow || !metrics.selectedBeforeCommand || !metrics.verticalOrder || !metrics.horizontalOrder || metrics.pathCrossesCommand || metrics.identityClipped || (metrics.tmuxShortcutVisible && !metrics.tmuxShortcutInsideViewport) || !metrics.helpCardInsideColumn || !metrics.helpTitleEllipsisReady || !metrics.helpAssignmentEllipsisReady || !metrics.helpOutcomeEllipsisReady || !metrics.helpTextTruncated || metrics.formCount !== 1 || metrics.connectionPaths !== 2 || ((metrics.stacked || metrics.hybrid) && (!metrics.commandBeforeDownstream || !metrics.outputAfterCommand))) {
    throw new Error(`선택 AI 작업 흐름 배치가 올바르지 않습니다: ${JSON.stringify(metrics)}`);
  }
}

async function managementDetailMetrics(win) {
  return win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    const sessions = app.state.snapshot?.sessions || [];
    const base = sessions.find(session => !session.parentId) || sessions[0] || {
      provider: 'codex', model: 'gpt-5.6', cwd: '/responsive/project', originCwd: '/responsive/project', workspace: 'responsive-project',
      status: 'waiting', statusDetail: '내 확인 대기', updatedAt: new Date().toISOString(), messages: [], lifecycle: [], usage: {}, context: {}, runtimePresence: [],
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
      progress: { stage: 'waiting', percent: 65, completedSteps: 4, totalSteps: 6, currentStep: '내 확인 대기', checkpoints: [] },
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
  if (!metrics.available || metrics.drawerWidth > 641 || !metrics.drawerInsideViewport || metrics.detailWidth > 630 || !metrics.noHorizontalOverflow || !metrics.healthStacked || metrics.healthTitleLines !== 1 || metrics.healthDetailLines > 2 || !metrics.healthDetailTitlePreserved || metrics.artifactFontSize !== '13px' || !metrics.artifactEllipsisReady || !metrics.artifactTruncated || !metrics.artifactTitlePreserved) {
    throw new Error(`실행 상세의 건강 상태·산출물 반응형 배치가 올바르지 않습니다: ${JSON.stringify(metrics)}`);
  }
}

app.whenReady().then(async () => {
  let exitCode = 0;
  let win = null;
  try {
    win = await waitForWindow();
    await waitForRenderer(win);
    win.setMinimumSize(320, 500);
    const sizes = [
      [1600, 980],
      [1224, 792],
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

    const settingsReports = [];
    const stickyNavigationReports = [];
    const settingsSizes = [
      [1376, 900],
      [1375, 900],
      [1181, 820],
      [1180, 820],
      [1000, 760],
      [999, 760],
      [881, 720],
      [880, 720],
      [738, 680],
      [721, 680],
      [320, 700],
    ];
    for (const [width, height] of settingsSizes) {
      setWindowSize(win, width, height);
      await wait(240);
      await openView(win, 'settings');
      const metrics = await settingsLayoutMetrics(win);
      assertSettingsLayout(metrics, `${width}×${height}`);
      if (width === 1375 || width === 738 || width === 320) {
        fs.writeFileSync(path.join(outputDir, `loadtoagent-responsive-settings-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      if (width === 1181 || width === 320) {
        const stickyMetrics = await stickyNavigationMetrics(win);
        assertStickyNavigation(stickyMetrics, `${width}×${height}`);
        stickyNavigationReports.push({ requested: `${width}×${height}`, ...stickyMetrics });
      }
      settingsReports.push({ requested: `${width}×${height}`, ...metrics });
    }

    const dashboardStickyReports = [];
    await setupDashboardStickyFixture(win);
    for (const [width, height] of [[1600, 900], [1180, 820], [1080, 700], [720, 640], [360, 520]]) {
      setWindowSize(win, width, height);
      await wait(240);
      await openView(win, 'all');
      const metrics = await dashboardStickyNavigationMetrics(win);
      assertDashboardStickyNavigation(metrics, `${width}×${height}`);
      if (width === 1080 || width === 360) {
        fs.writeFileSync(path.join(outputDir, `loadtoagent-responsive-sticky-dashboard-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      dashboardStickyReports.push({ requested: `${width}×${height}`, ...metrics });
    }
    if (!dashboardStickyReports.some(report => report.initialTopbarRect.height >= 100)) {
      throw new Error(`토큰 카드로 높이가 달라지는 대시보드 상단을 검증하지 못했습니다: ${JSON.stringify(dashboardStickyReports.map(report => ({ requested: report.requested, height: report.initialTopbarRect.height, visibleTokens: report.visibleTokenCardCount })))}`);
    }
    const restoredDashboardView = await cleanupDashboardStickyFixture(win);
    if (restoredDashboardView) await openView(win, restoredDashboardView);

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
      window.LoadToAgentApp.state.graphFocusId = null;
      window.LoadToAgentApp.renderSessions('filter');
    })()`);
    console.log(`management detail responsive check passed ${JSON.stringify(managementDetailReports)}`);

    for (const [width, height] of sizes) {
      setWindowSize(win, width, height);
      await wait(240);
      await openView(win, 'all');
      const home = await layoutMetrics(win);
      assertLayout(home, `${width}×${height} 홈 화면`);
      if (width === 1224 || width === 720 || width === 360) {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outputDir, `loadtoagent-responsive-${width}.png`), image.toPNG());
      }
      if (width === 360) {
        const mobileProjects = await win.webContents.executeJavaScript(`(() => {
          const app = window.LoadToAgentApp;
          const liveFixtureId = 'responsive-mobile-live-project';
          const liveFixture = {
            id: liveFixtureId,
            externalId: liveFixtureId,
            parentId: null,
            childIds: [],
            provider: 'codex',
            model: 'gpt-5.6',
            cwd: '/responsive/mobile-project',
            originCwd: '/responsive/mobile-project',
            workspace: 'mobile-project',
            title: '모바일 프로젝트 실행 상태 표시 검증',
            status: 'running',
            statusDetail: '작업 진행 중',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: [],
            lifecycle: [],
            usage: {},
            context: {},
            runtimePresence: [],
          };
          const sessions = app.state.snapshot?.sessions || [];
          app.state.snapshot.sessions = [...sessions.filter(session => session.id !== liveFixtureId), liveFixture];
          app.renderWorkspaces();
          document.querySelector('#appShell')?.removeAttribute('inert');
          document.body.classList.remove('dialog-open');
          document.querySelector('#mobileMoreBtn')?.click();
          const picker = document.querySelector('.mobile-project-picker');
          if (picker) picker.open = true;
          const menu = document.querySelector('#mobileToolsMenu');
          const list = document.querySelector('#mobileWorkspaceList');
          const selectedItem = list?.querySelector('[aria-pressed="true"]');
          const menuRect = menu?.getBoundingClientRect();
          const liveDot = [...(list?.querySelectorAll('.workspace-live-state i') || [])]
            .find(candidate => candidate.getClientRects().length > 0);
          const liveDotRect = liveDot?.getBoundingClientRect();
          return {
            visible: Boolean(menu && !menu.classList.contains('hidden') && picker?.open),
            selected: selectedItem?.textContent.trim() || '',
            selectedRepresentedOnce: Boolean(selectedItem && getComputedStyle(selectedItem).display === 'none'),
            singleScrollRegion: Boolean(list && list.scrollHeight <= list.clientHeight + 1),
            noHorizontalOverflow: Boolean(menu && menu.scrollWidth <= menu.clientWidth + 2 && list && list.scrollWidth <= list.clientWidth + 2),
            insideViewport: Boolean(menuRect && menuRect.left >= -1 && menuRect.right <= window.innerWidth + 1 && menuRect.top >= -1 && menuRect.bottom <= window.innerHeight + 1),
            liveDotCompact: Boolean(liveDotRect && liveDotRect.width <= 9 && liveDotRect.height <= 9 && getComputedStyle(liveDot).borderRadius.includes('50')),
            liveDotLabel: liveDot?.closest('.workspace-live-state')?.getAttribute('aria-label') || '',
          };
        })()`);
        if (!mobileProjects.visible || !mobileProjects.selected || !mobileProjects.selectedRepresentedOnce || !mobileProjects.singleScrollRegion || !mobileProjects.noHorizontalOverflow || !mobileProjects.insideViewport || !mobileProjects.liveDotCompact || !mobileProjects.liveDotLabel) throw new Error(`360×520 모바일 프로젝트 선택기가 올바르지 않습니다: ${JSON.stringify(mobileProjects)}`);
        await wait(120);
        fs.writeFileSync(path.join(outputDir, 'loadtoagent-responsive-projects-360.png'), (await win.webContents.capturePage()).toPNG());
        const projectSelection = await win.webContents.executeJavaScript(`(() => {
          const choice = [...document.querySelectorAll('#mobileWorkspaceList [data-workspace]')].find(item => item.getAttribute('aria-pressed') !== 'true');
          choice?.click();
          return choice?.dataset.workspace || '';
        })()`);
        if (!projectSelection) await win.webContents.executeJavaScript(`document.querySelector('#mobileToolsCloseBtn')?.click()`);
        await wait(120);
        const projectSelectionResult = await win.webContents.executeJavaScript(`(() => ({
          menuClosed: document.querySelector('#mobileToolsMenu')?.classList.contains('hidden'),
          expanded: document.querySelector('#mobileMoreBtn')?.getAttribute('aria-expanded'),
          focusedMain: !document.hasFocus() || document.activeElement?.id === 'mainContent' || Boolean(document.activeElement?.closest?.('[data-session-id], [data-graph-focus], [data-open-session]')),
          activeElement: { id: document.activeElement?.id || '', tag: document.activeElement?.tagName || '', hasFocus: document.hasFocus() },
          focusContext: { appInert: document.querySelector('#appShell')?.inert, mainInert: document.querySelector('#mainContent')?.inert, mainTabIndex: document.querySelector('#mainContent')?.tabIndex, mainRects: document.querySelector('#mainContent')?.getClientRects().length },
          workspace: window.LoadToAgentApp.state.workspace,
        }))()`);
        const focusCorrect = projectSelection
          ? projectSelectionResult.focusedMain
          : (!projectSelectionResult.activeElement.hasFocus || projectSelectionResult.activeElement.id === 'mobileMoreBtn');
        const workspaceCorrect = !projectSelection || projectSelectionResult.workspace === projectSelection;
        if (!projectSelectionResult.menuClosed || projectSelectionResult.expanded !== 'false' || !focusCorrect || !workspaceCorrect) throw new Error(`360×520 모바일 프로젝트 선택 후 닫기·포커스 복귀가 올바르지 않습니다: ${JSON.stringify({ projectSelection, ...projectSelectionResult })}`);
        await win.webContents.executeJavaScript(`(() => {
          const app = window.LoadToAgentApp;
          app.state.snapshot.sessions = (app.state.snapshot?.sessions || [])
            .filter(session => session.id !== 'responsive-mobile-live-project');
          app.state.workspace = 'all';
          app.renderWorkspaces();
          app.renderSessions('filter');
        })()`);
      }

      const overlays = await overlayMetrics(win, width === 720 || width === 360 ? path.join(outputDir, `loadtoagent-responsive-new-run-${width}.png`) : '');
      if (!overlays.modalInsideViewport || !overlays.drawerInsideViewport || !overlays.modalNoHorizontalOverflow || !overlays.providerCardsInsideModal || !overlays.actionsInsideViewport || !overlays.promptCounterVisible || !overlays.promptFirst || overlays.drawerLeakedControls.length) {
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

    console.log(`responsive check passed ${JSON.stringify({ views: reports, settings: settingsReports, stickyNavigation: stickyNavigationReports, dashboardStickyNavigation: dashboardStickyReports, workflows: workflowReports, managementDetails: managementDetailReports })}`);
  } catch (error) {
    exitCode = 1;
    console.error(error && error.stack || error);
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(exitCode);
  }
});
