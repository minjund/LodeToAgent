'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-project-studio-interaction-'));
app.setPath('userData', userData);
app.once('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(win, expression, message, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await win.webContents.executeJavaScript(expression)) return;
    } catch {}
    await wait(60);
  }
  throw new Error(message);
}

async function installGuards(win) {
  await win.webContents.executeJavaScript(`(() => {
    window.__projectStudioErrors = [];
    window.addEventListener('error', event => {
      window.__projectStudioErrors.push('error:' + (event.error?.stack || event.message || 'unknown'));
    });
    window.addEventListener('unhandledrejection', event => {
      window.__projectStudioErrors.push('rejection:' + String(event.reason?.stack || event.reason?.message || event.reason || 'unknown'));
    });
    window.confirm = () => true;
    window.prompt = () => 'fixture';
  })()`);
}

async function reloadApp(win) {
  await win.reload();
  await waitFor(win, `Boolean(window.LoadToAgentApp?.initialized && document.querySelector('#projectSidebarList [data-workspace]'))`, '화면 재초기화 실패');
  await installGuards(win);
}

async function prepareProject(win, workspace = 'D:\\fixture') {
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    for (const selector of ['#cancelSessionResetBtn', '#cancelRunBtn', '#closeDrawerBtn', '#closeShortcutHelpBtn', '#closeQuickPaletteBtn', '#cancelTmuxCreateBtn', '#mobileToolsCloseBtn']) {
      const button = document.querySelector(selector);
      if (button && button.getClientRects().length) button.click();
    }
    app.state.workspace = ${JSON.stringify(workspace)};
    app.selectView('all');
    app.renderWorkspaces();
    app.renderSessions('filter');
    document.querySelector('.main-stage')?.scrollTo(0, 0);
    window.__projectStudioErrors = [];
  })()`);
  await wait(300);
  await waitFor(
    win,
    `window.LoadToAgentApp.state.workspace === ${JSON.stringify(workspace)}
      && document.body.dataset.projectSelected === 'true'
      && !document.querySelector('#liveSection')?.classList.contains('hidden')
      && document.querySelector('#newRunBtn')?.getBoundingClientRect().width > 0`,
    `프로젝트 화면을 준비하지 못했습니다: ${workspace}`,
  );
  await wait(120);
}

async function inspectLayout(win, label) {
  const metrics = await win.webContents.executeJavaScript(`(() => {
    for (const animation of document.getAnimations()) {
      try { animation.finish(); } catch {}
    }
    const isRendered = element => {
      if (!element?.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return element.getClientRects().length > 0
        && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility === 'visible'
        && Number(style.opacity) > 0;
    };
    const inViewport = element => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    };
    const controls = [...document.querySelectorAll('button, summary, a[href], [role="button"]')]
      .filter(isRendered)
      .filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true');
    const nameOf = element => String(
      element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.textContent
      || ''
    ).replace(/\\s+/g, ' ').trim();
    const unnamed = controls.filter(element => !nameOf(element)).map(element => element.outerHTML.slice(0, 180));
    const outsideViewport = controls.filter(inViewport).filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > window.innerWidth + 1;
    }).map(element => {
      const rect = element.getBoundingClientRect();
      return { name: nameOf(element).slice(0, 80), left: Math.round(rect.left), right: Math.round(rect.right) };
    });
    const openSurfaces = [
      ['run', document.querySelector('#runModal'), document.querySelector('#runModal .run-modal')],
      ['drawer', document.querySelector('#detailDrawer'), document.querySelector('#detailDrawer')],
      ['session-reset', document.querySelector('#sessionResetModal'), document.querySelector('#sessionResetModal .session-reset-dialog')],
      ['shortcuts', document.querySelector('#shortcutHelpModal'), document.querySelector('#shortcutHelpModal .quality-modal')],
      ['quick-palette', document.querySelector('#quickPaletteModal'), document.querySelector('#quickPaletteModal .quality-modal')],
      ['tmux-create', document.querySelector('#tmuxCreateModal'), document.querySelector('#tmuxCreateModal .modal')],
    ].filter(([name, host, surface]) => {
      const explicitlyOpen = name === 'drawer'
        ? host?.classList.contains('open')
        : host && !host.classList.contains('hidden') && host.getAttribute('aria-hidden') !== 'true';
      return explicitlyOpen && isRendered(host) && isRendered(surface);
    });
    const surfacesOutsideViewport = openSurfaces.map(([name, , surface]) => {
      const rect = surface.getBoundingClientRect();
      return rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1
        ? null
        : { name, left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
    }).filter(Boolean);
    const leakedControls = openSurfaces.flatMap(([name, , surface]) => {
      const surfaceRect = surface.getBoundingClientRect();
      return [...document.querySelectorAll('#appShell button, #appShell summary, #appShell a[href], #appShell [role="button"]')]
        .filter(isRendered)
        .map(element => {
          const rect = element.getBoundingClientRect();
          const left = Math.max(rect.left, surfaceRect.left);
          const right = Math.min(rect.right, surfaceRect.right);
          const top = Math.max(rect.top, surfaceRect.top);
          const bottom = Math.min(rect.bottom, surfaceRect.bottom);
          if (right <= left || bottom <= top) return null;
          const topElement = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
          return topElement && (topElement === element || element.contains(topElement))
            ? { surface: name, name: nameOf(element).slice(0, 80) }
            : null;
        })
        .filter(Boolean);
    });
    const visibleSections = [...document.querySelectorAll('.main-stage > section')].filter(isRendered);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      controlCount: controls.length,
      controlNames: controls.map(element => nameOf(element).slice(0, 100)),
      unnamed,
      outsideViewport,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      stageOverflow: document.querySelector('.main-stage')?.scrollWidth > document.querySelector('.main-stage')?.clientWidth + 2,
      sectionOverflow: visibleSections.filter(section => section.scrollWidth > section.clientWidth + 2).map(section => {
        const bounds = section.getBoundingClientRect();
        const offenders = [...section.querySelectorAll('*')].filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || element.scrollWidth > element.clientWidth + 2);
        }).slice(0, 8).map(element => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            id: element.id,
            className: String(element.className || '').slice(0, 100),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          };
        });
        return { section: section.id || section.className, scrollWidth: section.scrollWidth, clientWidth: section.clientWidth, offenders };
      }),
      surfacesOutsideViewport,
      leakedControls,
      errors: window.__projectStudioErrors || [],
    };
  })()`);
  const problems = [];
  if (metrics.documentOverflow) problems.push('문서 가로 넘침');
  if (metrics.stageOverflow) problems.push('본문 가로 넘침');
  if (metrics.sectionOverflow.length) problems.push(`섹션 가로 넘침: ${JSON.stringify(metrics.sectionOverflow)}`);
  if (metrics.unnamed.length) problems.push(`이름 없는 버튼: ${JSON.stringify(metrics.unnamed)}`);
  if (metrics.outsideViewport.length) problems.push(`화면 밖 버튼: ${JSON.stringify(metrics.outsideViewport)}`);
  if (metrics.surfacesOutsideViewport.length) problems.push(`화면 밖 대화상자: ${JSON.stringify(metrics.surfacesOutsideViewport)}`);
  if (metrics.leakedControls.length) problems.push(`대화상자를 뚫고 나온 버튼: ${JSON.stringify(metrics.leakedControls)}`);
  if (metrics.errors.length) problems.push(`렌더러 오류: ${metrics.errors.join(' | ')}`);
  if (problems.length) throw new Error(`${label} · ${problems.join(' / ')}`);
  return metrics;
}

async function clickIndexedControl(win, scope, index) {
  return win.webContents.executeJavaScript(`(() => {
    const isRendered = element => {
      if (!element?.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0
        && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    };
    const elements = [...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button, summary, a[href], [role="button"]')]
      .filter(isRendered);
    const element = elements[${index}];
    if (!element) return { ok: false, count: elements.length };
    const name = String(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\\s+/g, ' ').trim();
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    element.click();
    return { ok: true, name, tag: element.tagName, html: element.outerHTML.slice(0, 220) };
  })()`);
}

async function visibleControlCount(win, scope) {
  return win.webContents.executeJavaScript(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)});
    if (!root) return 0;
    const visible = element => {
      if (element.closest('[hidden], [aria-hidden="true"]')) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0
        && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    };
    return [...root.querySelectorAll('button, summary, a[href], [role="button"]')].filter(visible).length;
  })()`);
}

async function closeTransientSurfaces(win) {
  await win.webContents.executeJavaScript(`(() => {
    for (const selector of ['#cancelSessionResetBtn', '#cancelRunBtn', '#closeDrawerBtn', '#closeShortcutHelpBtn', '#closeQuickPaletteBtn', '#cancelTmuxCreateBtn', '#mobileToolsCloseBtn']) {
      const button = document.querySelector(selector);
      if (button && button.getClientRects().length) button.click();
    }
  })()`);
  await wait(300);
}

async function capture(win, output) {
  await win.webContents.executeJavaScript(`document.fonts.ready.then(() => {
    for (const animation of document.getAnimations()) {
      try { animation.finish(); } catch {}
    }
    return true;
  })`);
  win.webContents.invalidate();
  await wait(220);
  fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
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
  const report = {
    clicked: [],
    layouts: {},
    projectCount: 0,
    mainControls: 0,
    runModalControls: 0,
    drawerControls: 0,
    screenshots: [],
  };

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await waitFor(win, `Boolean(window.LoadToAgentApp?.initialized && document.querySelector('#projectSidebarList [data-workspace]'))`, '프로젝트 화면 초기화 실패');
    await installGuards(win);
    if (process.env.LOADTOAGENT_PROJECT_CAPTURE_ONLY === '1') {
      await prepareProject(win);
      await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-ended')`);
      await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')`, '상세 패널 단독 캡처 준비 실패');
      win.show();
      await wait(420);
      const output = path.join(__dirname, '..', 'artifacts', 'loadtoagent-project-detail-drawer-verified-visible.png');
      fs.mkdirSync(path.dirname(output), { recursive: true });
      await capture(win, output);
      const drawer = await win.webContents.executeJavaScript(`(() => {
        const element = document.querySelector('#detailDrawer');
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const close = document.querySelector('#closeDrawerBtn');
        const closeRect = close?.getBoundingClientRect();
        const point = document.elementFromPoint(Math.min(window.innerWidth - 20, rect.left + 100), 300);
        return {
          open: element.classList.contains('open'),
          left: rect.left,
          right: rect.right,
          width: rect.width,
          viewport: window.innerWidth,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          transform: style.transform,
          zIndex: style.zIndex,
          background: style.backgroundColor,
          close: closeRect ? { left: closeRect.left, top: closeRect.top, width: closeRect.width, opacity: getComputedStyle(close).opacity } : null,
          point: point ? { tag: point.tagName, id: point.id, className: point.className } : null,
        };
      })()`);
      process.stdout.write(`${JSON.stringify({ ok: true, drawer, output }, null, 2)}\n`);
      return;
    }

    report.layouts.initial = await inspectLayout(win, '프로젝트 선택 초기 화면');
    const projectPaths = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#projectSidebarList [data-workspace]')].map(item => item.dataset.workspace)`);
    report.projectCount = projectPaths.length;
    for (const workspace of projectPaths) {
      await win.webContents.executeJavaScript(`(() => {
        const item = [...document.querySelectorAll('#projectSidebarList [data-workspace]')].find(node => node.dataset.workspace === ${JSON.stringify(workspace)});
        item?.click();
      })()`);
      await waitFor(win, `window.LoadToAgentApp.state.workspace === ${JSON.stringify(workspace)}`, `프로젝트 클릭 실패: ${workspace}`);
      const projectState = await win.webContents.executeJavaScript(`(() => ({
        selected: document.querySelectorAll('#projectSidebarList [data-workspace][aria-pressed="true"]').length,
        projects: document.querySelectorAll('#projectSidebarList [data-workspace]').length,
        nestedSessions: document.querySelectorAll('#projectSidebarList .project-sidebar-session, #projectSidebarList .project-sidebar-sessions').length,
        mainProjects: [...document.querySelectorAll('.control-room-project-group')].map(item => item.dataset.controlProject),
      }))()`);
      if (projectState.selected !== 1 || projectState.projects !== projectPaths.length || projectState.nestedSessions !== 0 || projectState.mainProjects.length > 1) {
        throw new Error(`프로젝트 선택 격리 실패: ${workspace} · ${JSON.stringify(projectState)}`);
      }
      report.clicked.push(`프로젝트: ${workspace}`);
      await inspectLayout(win, `프로젝트 선택: ${workspace}`);
    }

    await prepareProject(win);
    await win.webContents.executeJavaScript(`document.querySelector('#probeBtn')?.click()`);
    await waitFor(win, `window.interactionTest.getCalls().some(call => call.name === 'probeProviders')`, 'AI 상태 새로고침 버튼 실패');
    report.clicked.push('AI 연결 상태 다시 확인');

    await prepareProject(win);
    const mainControls = await visibleControlCount(win, '.main-stage');
    report.mainControls = mainControls;
    for (let index = 0; index < mainControls; index += 1) {
      await prepareProject(win);
      const clicked = await clickIndexedControl(win, '.main-stage', index);
      if (!clicked.ok) throw new Error(`현재 프로젝트 ${index + 1}번째 버튼을 찾지 못했습니다.`);
      report.clicked.push(`현재 프로젝트: ${clicked.name}`);
      await wait(180);
      await inspectLayout(win, `현재 프로젝트 버튼: ${clicked.name}`);
      await closeTransientSurfaces(win);
    }

    await prepareProject(win);
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.openRunModal()`);
    await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden')`, '새 AI 작업 창 열기 실패');
    report.layouts.runModal = await inspectLayout(win, '새 AI 작업 창');
    const runModalControls = await visibleControlCount(win, '#runModal .run-modal');
    report.runModalControls = runModalControls;
    for (let index = 0; index < runModalControls; index += 1) {
      await prepareProject(win);
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.openRunModal();
        const prompt = document.querySelector('#runPrompt');
        if (prompt) {
          prompt.value = '';
          prompt.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()`);
      await waitFor(win, `!document.querySelector('#runModal').classList.contains('hidden')`, '새 AI 작업 창 재열기 실패');
      const clicked = await clickIndexedControl(win, '#runModal .run-modal', index);
      if (!clicked.ok) throw new Error(`새 AI 작업 창 ${index + 1}번째 버튼을 찾지 못했습니다.`);
      report.clicked.push(`새 AI 작업: ${clicked.name}`);
      await wait(160);
      await inspectLayout(win, `새 AI 작업 버튼: ${clicked.name}`);
      await closeTransientSurfaces(win);
    }

    await prepareProject(win);
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-ended')`);
    await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')`, '상세 패널 열기 실패');
    report.layouts.drawer = await inspectLayout(win, '상세 패널');
    const drawerOutput = path.join(__dirname, '..', 'artifacts', 'loadtoagent-project-detail-drawer-fixed.png');
    fs.mkdirSync(path.dirname(drawerOutput), { recursive: true });
    await capture(win, drawerOutput);
    report.screenshots.push(drawerOutput);
    report.layouts.drawerAfterCapture = await inspectLayout(win, '상세 패널 캡처 후');

    for (const tab of ['summary', 'chat', 'lifecycle', 'tokens']) {
      await prepareProject(win);
      await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-ended')`);
      await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')`, `상세 ${tab} 탭 준비 실패`);
      await win.webContents.executeJavaScript(`document.querySelector('[data-tab="${tab}"]')?.click()`);
      await waitFor(win, `document.querySelector('[data-tab="${tab}"]')?.getAttribute('aria-selected') === 'true'`, `상세 ${tab} 탭 클릭 실패`);
      report.clicked.push(`상세 탭: ${tab}`);
      await inspectLayout(win, `상세 탭: ${tab}`);
      const contentControls = await visibleControlCount(win, '#drawerContent');
      report.drawerControls += contentControls;
      for (let index = 0; index < contentControls; index += 1) {
        await reloadApp(win);
        await prepareProject(win);
        await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-ended')`);
        await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')`, `상세 ${tab} 내용 준비 실패`);
        await win.webContents.executeJavaScript(`document.querySelector('[data-tab="${tab}"]')?.click()`);
        await waitFor(win, `document.querySelector('[data-tab="${tab}"]')?.getAttribute('aria-selected') === 'true'`, `상세 ${tab} 내용 탭 클릭 실패`);
        const clicked = await clickIndexedControl(win, '#drawerContent', index);
        if (!clicked.ok) throw new Error(`상세 ${tab} 탭 ${index + 1}번째 버튼을 찾지 못했습니다.`);
        report.clicked.push(`상세 ${tab}: ${clicked.name}`);
        await wait(160);
        await inspectLayout(win, `상세 ${tab} 버튼: ${clicked.name}`);
        await closeTransientSurfaces(win);
      }
    }

    await prepareProject(win);
    await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-ended')`);
    await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')`, '상세 버튼 순회 준비 실패');
    const drawerControls = await visibleControlCount(win, '#detailDrawer');
    report.drawerControls += drawerControls;
    for (let index = 0; index < drawerControls; index += 1) {
      await reloadApp(win);
      await prepareProject(win);
      await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-ended')`);
      await waitFor(win, `document.querySelector('#detailDrawer').classList.contains('open')`, '상세 버튼 순회 재열기 실패');
      const clicked = await clickIndexedControl(win, '#detailDrawer', index);
      if (!clicked.ok) throw new Error(`상세 패널 ${index + 1}번째 버튼을 찾지 못했습니다.`);
      report.clicked.push(`상세 패널: ${clicked.name}`);
      await wait(160);
      await inspectLayout(win, `상세 패널 버튼: ${clicked.name}`);
      await closeTransientSurfaces(win);
    }

    await win.reload();
    await waitFor(win, `Boolean(window.LoadToAgentApp?.initialized && document.querySelector('#projectSidebarList [data-remove-workspace]'))`, '삭제 버튼 검증용 화면 재초기화 실패');
    await installGuards(win);
    const removed = await win.webContents.executeJavaScript(`(() => {
      window.interactionTest.clearCalls();
      const button = document.querySelector('#projectSidebarList [data-remove-workspace]');
      const workspace = button?.dataset.removeWorkspace || '';
      button?.click();
      return workspace;
    })()`);
    await waitFor(win, `window.interactionTest.getCalls().some(call => call.name === 'removeWorkspace')`, '프로젝트 삭제 버튼 실패');
    report.clicked.push(`프로젝트 삭제: ${removed}`);
    report.layouts.afterRemove = await inspectLayout(win, '프로젝트 삭제 후');

    process.stdout.write(`${JSON.stringify({ ok: true, report }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
