'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-readability-'));
app.setPath('userData', userData);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function forceRepaint(win) {
  const [width, height] = win.getContentSize();
  win.setContentSize(width + 1, height);
  await wait(90);
  win.setContentSize(width, height);
  await wait(220);
}

async function waitFor(win, expression, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await wait(100);
  }
  throw new Error(`화면 준비를 기다리는 중 시간 초과: ${expression}`);
}

async function capture(win, outputDir, name, repaint = false) {
  if (repaint) await forceRepaint(win);
  await win.webContents.executeJavaScript(`document.fonts.ready.then(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } return true; })`);
  win.webContents.invalidate();
  await wait(300);
  const image = await win.webContents.capturePage();
  const [contentWidth, contentHeight] = win.getContentSize();
  const deviceScaleFactor = await win.webContents.executeJavaScript('window.devicePixelRatio || 1');
  const captured = image.getSize();
  const expectedWidth = Math.round(contentWidth * deviceScaleFactor);
  const expectedHeight = Math.round(contentHeight * deviceScaleFactor);
  if (Math.abs(captured.width - expectedWidth) > 2 || Math.abs(captured.height - expectedHeight) > 2) {
    throw new Error(`캡처 크기가 현재 창과 다릅니다: ${name} ${captured.width}×${captured.height} / ${expectedWidth}×${expectedHeight} (DPR ${deviceScaleFactor})`);
  }
  fs.writeFileSync(path.join(outputDir, name), image.toPNG());
}

async function auditVisibleText(win, view) {
  return win.webContents.executeJavaScript(`(() => {
    const parseColor = value => {
      const match = String(value || '').match(/rgba?\\(([^)]+)\\)/);
      if (!match) return null;
      const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const channel = value => {
      const normalized = value / 255;
      return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
    };
    const luminance = color => .2126 * channel(color.r) + .7152 * channel(color.g) + .0722 * channel(color.b);
    const contrast = (foreground, background) => {
      const high = Math.max(luminance(foreground), luminance(background));
      const low = Math.min(luminance(foreground), luminance(background));
      return (high + .05) / (low + .05);
    };
    const solidBackground = element => {
      let current = element;
      while (current) {
        const color = parseColor(getComputedStyle(current).backgroundColor);
        if (color && color.a >= .92) return color;
        current = current.parentElement;
      }
      return parseColor(getComputedStyle(document.documentElement).backgroundColor) || { r: 6, g: 10, b: 16, a: 1 };
    };
    const candidates = [...document.querySelectorAll('body *')].flatMap(element => {
      if (element.closest('[aria-hidden="true"], details:not([open]), .sr-only, .visually-hidden, .xterm-helper-textarea, script, style')) return [];
      const text = [...element.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent.replace(/\\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ');
      if (text.length < 2) return [];
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width < 2 || rect.height < 2 || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < .55) return [];
      const fontSize = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      const foreground = parseColor(style.color);
      if (!foreground || foreground.a < .75) return [];
      const background = solidBackground(element);
      const ratio = contrast(foreground, background);
      const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
      const selector = [element.id && '#' + element.id, ...[...element.classList].slice(0, 2).map(name => '.' + name)].filter(Boolean).join('') || element.tagName.toLowerCase();
      const parent = element.parentElement;
      const parentSelector = parent ? [parent.id && '#' + parent.id, ...[...parent.classList].slice(0, 3).map(name => '.' + name)].filter(Boolean).join('') || parent.tagName.toLowerCase() : '';
      return [{ selector, parent: parentSelector, text: text.slice(0, 80), fontSize, color: style.color, background: style.backgroundColor, opacity: style.opacity, ratio: Number(ratio.toFixed(2)), required: large ? 3 : 4.5 }];
    });
    const hitTargets = [...document.querySelectorAll('button, select, textarea, summary, a[href], [role="button"], [tabindex]:not([tabindex="-1"]), input:not([type="checkbox"]):not([type="radio"])')]
      .flatMap(element => {
        if (element.closest('[inert], [aria-hidden="true"], details:not([open]), .hidden, .sr-only, .visually-hidden, .xterm-helper-textarea')) return [];
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width < 2 || rect.height < 2 || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < .2) return [];
        const selector = [element.id && '#' + element.id, ...[...element.classList].slice(0, 2).map(name => '.' + name)].filter(Boolean).join('') || element.tagName.toLowerCase();
        return [{ element, selector, text: String(element.innerText || element.value || element.getAttribute('aria-label') || '').trim().slice(0, 60), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }];
      });
    const overlaps = [];
    for (let left = 0; left < hitTargets.length; left += 1) {
      for (let right = left + 1; right < hitTargets.length; right += 1) {
        const a = hitTargets[left];
        const b = hitTargets[right];
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (width > .75 && height > .75) overlaps.push({ first: a.selector, second: b.selector, width: Number(width.toFixed(1)), height: Number(height.toFixed(1)) });
        if (overlaps.length >= 20) break;
      }
      if (overlaps.length >= 20) break;
    }
    const spacingGroups = [
      '.top-actions',
      '.view-nav',
      '.workspace-list',
      '.session-tools',
      '.provider-filter',
      '.app-error-actions',
      '.management-filter-group',
      '.management-quick-actions',
      '.management-control-buttons',
      '.terminal-create-actions',
      '.terminal-workspace-actions',
      '.terminal-key-actions',
      '.terminal-tmux-tools',
      '.tmux-section-actions',
      '.tmux-pane-actions',
      '.run-modal-actions',
      '.modal-actions',
      '.detail-meta-actions',
      '.mobile-bottom-nav',
    ];
    const crowdedGroups = spacingGroups.flatMap(selector => [...document.querySelectorAll(selector)].flatMap(group => {
      const rect = group.getBoundingClientRect();
      const style = getComputedStyle(group);
      if (rect.width < 2 || rect.height < 2 || style.display === 'none' || style.visibility === 'hidden') return [];
      const interactiveChildren = [...group.children].filter(child => {
        if (!child.matches('button, select, input, textarea, summary, a[href], label, [role="button"], details, div')) return false;
        const childRect = child.getBoundingClientRect();
        const childStyle = getComputedStyle(child);
        return childRect.width >= 2 && childRect.height >= 2 && childStyle.display !== 'none' && childStyle.visibility !== 'hidden';
      });
      if (interactiveChildren.length < 2) return [];
      const rowGap = Number.parseFloat(style.rowGap) || 0;
      const columnGap = Number.parseFloat(style.columnGap) || 0;
      const minimumGap = Math.min(rowGap, columnGap);
      return minimumGap + .01 < 10 ? [{
        selector,
        rowGap,
        columnGap,
        children: interactiveChildren.length,
      }] : [];
    }));
    return {
      view: ${JSON.stringify(view)},
      textNodes: candidates.length,
      tooSmall: candidates.filter(item => item.fontSize < 11.9).slice(0, 30),
      lowContrast: candidates.filter(item => item.ratio + .02 < item.required).slice(0, 30),
      minimumFontSize: candidates.length ? Math.min(...candidates.map(item => item.fontSize)) : 0,
      minimumContrast: candidates.length ? Math.min(...candidates.map(item => item.ratio)) : 0,
      tooSmallTargets: hitTargets.filter(item => item.width < 43.5 || item.height < 43.5).slice(0, 30).map(({ element, ...item }) => item),
      overlaps,
      crowdedGroups,
    };
  })()`);
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const win = new BrowserWindow({
      x: 24,
      y: 24,
      width: 1440,
      height: 980,
      show: true,
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'interaction-fixture-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await waitFor(win, `Boolean(window.LoadToAgentApp?.state?.snapshot?.sessions?.length && document.querySelector('#operationsOverview')?.innerText)`);
    win.setContentSize(1440, 980);
    await wait(260);
    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });

    await win.webContents.executeJavaScript(`(async () => {
      const bootstrap = await window.loadtoagent.bootstrap();
      const app = window.LoadToAgentApp;
      app.state.providers = bootstrap.providers;
      app.state.availability = bootstrap.availability;
      app.state.workspaces = bootstrap.workspaces;
      app.state.rawSnapshot = bootstrap.snapshot;
      app.state.snapshot = bootstrap.snapshot;
      app.state.hiddenProviders.clear();
      window.LoadToAgentI18n.setLocale('ko');
      app.state.view = 'all';
      app.state.workspace = 'all';
      app.state.graphFocusId = null;
      app.syncViewChrome();
      app.render('view');
      document.querySelector('#beginnerGuide')?.classList.add('hidden');
      const stage = document.querySelector('.main-stage');
      const target = document.querySelector('#operationsOverview');
      if (stage && target) stage.scrollTop = Math.max(0, target.offsetTop - 18);
      return true;
    })()`);
    await waitFor(win, `!document.querySelector('#operationsOverview')?.classList.contains('hidden')
      && Boolean(document.querySelector('[data-home-attention]'))
      && Boolean(document.querySelector('[data-control-room-overview]'))`);
    // Chromium can return a stale first frame for a newly shown BrowserWindow.
    // Prime the compositor once so the checked artifact always reflects the DOM.
    await win.webContents.capturePage();
    await wait(300);
    await capture(win, outputDir, 'loadtoagent-readability-overview.png', true);

    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentApp.state.graphFocusId = null;
      window.LoadToAgentApp.renderSessions('view');
      document.querySelector('[data-graph-focus="fixture-root"]')?.click();
      return true;
    })()`);
    await waitFor(win, `Boolean(document.querySelector('.execution-activity-panel') && document.querySelector('[data-execution-mode="foreground"]'))`);
    await forceRepaint(win);
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentApp.closeDrawer(false);
      document.querySelector('#mainContent')?.focus({ preventScroll: true });
      const foreground = document.querySelector('[data-execution-mode="foreground"]');
      if (foreground) foreground.open = true;
      const stage = document.querySelector('.main-stage');
      const panel = document.querySelector('.execution-activity-panel');
      if (stage && panel) stage.scrollTop = Math.max(0, panel.offsetTop - 90);
      return true;
    })()`);
    await waitFor(win, `!document.querySelector('#detailDrawer')?.classList.contains('open')
      && document.querySelector('#detailDrawer')?.getAttribute('aria-hidden') === 'true'
      && document.querySelector('#detailDrawer')?.inert
      && document.querySelector('#drawerBackdrop')?.classList.contains('hidden')
      && !document.querySelector('#appShell')?.inert
      && !document.body.classList.contains('dialog-open')`);
    // Recreate the native compositor surface after removing the backdrop-filter
    // layer; capturePage can otherwise retain the closed drawer's dimmed frame.
    win.hide();
    await wait(100);
    win.show();
    win.focus();
    await wait(260);
    await waitFor(win, `(() => { const detail = document.querySelector('[data-execution-mode="foreground"]'); if (!detail) return false; detail.open = true; return detail.querySelector('.execution-detail-output pre')?.textContent.includes('128개 테스트 통과'); })()`);
    await win.webContents.executeJavaScript(`(() => {
      const detail = document.querySelector('[data-execution-mode="foreground"]');
      const stage = document.querySelector('.main-stage');
      if (detail && stage) {
        detail.open = true;
        const detailRect = detail.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        stage.scrollTop += detailRect.top - stageRect.top - 72;
      }
      return true;
    })()`);
    await waitFor(win, `(() => { const detail = document.querySelector('[data-execution-mode="foreground"]'); const rect = detail?.getBoundingClientRect(); return Boolean(detail?.open && rect && rect.top >= 0 && rect.top < innerHeight * .5); })()`);
    await capture(win, outputDir, 'loadtoagent-execution-activity.png', true);

    win.setContentSize(360, 620);
    await wait(250);
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentApp.state.view = 'all';
      window.LoadToAgentApp.state.graphFocusId = null;
      window.LoadToAgentApp.syncViewChrome();
      window.LoadToAgentApp.renderSessions('view');
      document.querySelector('#beginnerGuide')?.classList.add('hidden');
      const stage = document.querySelector('.main-stage');
      const target = document.querySelector('#operationsOverview');
      if (stage && target) stage.scrollTop = Math.max(0, target.offsetTop - 10);
      return true;
    })()`);
    await waitFor(win, `(() => {
      const section = document.querySelector('#operationsOverview');
      const live = document.querySelector('#liveSection');
      const stage = document.querySelector('.main-stage');
      return Boolean(section && !section.classList.contains('hidden')
        && section.scrollWidth <= section.clientWidth + 2
        && stage.scrollWidth <= stage.clientWidth + 2
        && section.querySelector('[data-home-attention]')
        && live.querySelector('[data-control-room-overview]')
        && live.querySelector('.control-room-main')
        && live.querySelector('.helper-node')
        && live.querySelector('.execution-node'));
    })()`);
    await capture(win, outputDir, 'loadtoagent-control-room-360.png', true);

    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#mobileMoreBtn')?.click();
      const picker = document.querySelector('.mobile-project-picker');
      if (picker) picker.open = true;
      return true;
    })()`);
    await waitFor(win, `!document.querySelector('#mobileToolsMenu')?.classList.contains('hidden') && document.querySelector('.mobile-project-picker')?.open && document.querySelector('#mobileWorkspaceList [aria-pressed="true"]')`);
    await capture(win, outputDir, 'loadtoagent-responsive-projects-360.png');

    win.setContentSize(1440, 900);
    await wait(250);
    const viewReports = [];
    for (const view of ['all', 'active', 'waiting', 'runtime', 'terminal', 'tmux', 'settings']) {
      await win.webContents.executeJavaScript(`(() => {
        const app = window.LoadToAgentApp;
        app.state.view = ${JSON.stringify(view)};
        app.state.graphFocusId = null;
        app.syncViewChrome();
        app.render('view');
        const guide = document.querySelector('#beginnerGuide');
        if (guide) guide.classList.toggle('hidden', ${JSON.stringify(view)} !== 'all');
        document.querySelector('.main-stage')?.scrollTo(0, 0);
        return true;
      })()`);
      await wait(240);
      const report = await auditVisibleText(win, view);
      viewReports.push(report);
      await capture(win, outputDir, `loadtoagent-readability-${view}.png`);
    }
    await win.webContents.executeJavaScript(`(() => { document.querySelector('#newRunBtn')?.click(); return true; })()`);
    await waitFor(win, `!document.querySelector('#runModal')?.classList.contains('hidden') && !document.querySelector('#runModal')?.inert`);
    await wait(400);
    await win.webContents.executeJavaScript(`(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } return true; })()`);
    viewReports.push(await auditVisibleText(win, 'run-modal'));
    await win.webContents.executeJavaScript(`(() => { document.querySelector('#cancelRunBtn')?.click(); return true; })()`);
    await waitFor(win, `document.querySelector('#runModal')?.classList.contains('hidden') && document.querySelector('#runModal')?.inert`);

    await win.webContents.executeJavaScript(`(() => {
      const app = window.LoadToAgentApp;
      app.state.view = 'all';
      app.syncViewChrome();
      app.render('view');
      document.querySelector('#sessionGrid [data-session-id]')?.click();
      return true;
    })()`);
    await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open') && !document.querySelector('#detailDrawer')?.inert && document.querySelector('#drawerContent')?.innerText.length > 20`);
    await wait(400);
    await win.webContents.executeJavaScript(`(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } return true; })()`);
    viewReports.push(await auditVisibleText(win, 'detail-drawer'));
    await win.webContents.executeJavaScript(`(() => { document.querySelector('#closeDrawerBtn')?.click(); return true; })()`);

    await win.webContents.executeJavaScript(`(async () => {
      const app = window.LoadToAgentApp;
      app.state.view = 'terminal';
      app.syncViewChrome();
      app.render('view');
      await window.LoadToAgentTerminal.activate(app.state.snapshot, app.state.workspaces, 'general');
      document.querySelector('#newTmuxSessionBtn')?.click();
      return true;
    })()`);
    await waitFor(win, `!document.querySelector('#tmuxCreateModal')?.classList.contains('hidden') && !document.querySelector('#tmuxCreateModal')?.inert`);
    await wait(400);
    await win.webContents.executeJavaScript(`(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } return true; })()`);
    viewReports.push(await auditVisibleText(win, 'tmux-create-modal'));
    await win.webContents.executeJavaScript(`(() => { document.querySelector('#cancelTmuxCreateBtn')?.click(); return true; })()`);

    const failures = viewReports.filter(report => report.tooSmall.length || report.lowContrast.length || report.tooSmallTargets.length || report.overlaps.length || report.crowdedGroups.length);
    if (failures.length) throw new Error(`전 화면 텍스트 가독성 기준 미달: ${JSON.stringify(failures)}`);

    process.stdout.write(`readability visual check passed ${JSON.stringify(viewReports)}\n`);
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  } finally {
    app.exit(exitCode);
  }
}).catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});

app.on('quit', () => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});
