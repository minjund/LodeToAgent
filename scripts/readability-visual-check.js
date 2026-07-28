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

async function capturePageWithRetry(win, label) {
  let lastError = null;
  const stableContentSize = win.getContentSize();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      win.webContents.invalidate();
      await wait(180 + attempt * 80);
      return await win.webContents.capturePage();
    } catch (error) {
      lastError = error;
      win.hide();
      await wait(100);
      win.show();
      if (stableContentSize[0] > 0 && stableContentSize[1] > 0) {
        win.setContentSize(stableContentSize[0], stableContentSize[1]);
      }
      win.focus();
      await forceRepaint(win);
    }
  }
  throw new Error(`${label} 캡처 실패: ${lastError?.stack || lastError?.message || lastError}`);
}

async function capture(win, outputDir, name, repaint = false) {
  if (repaint) await forceRepaint(win);
  const [contentWidth, contentHeight] = win.getContentSize();
  let settled = false;
  let settleError = null;
  for (let attempt = 0; attempt < 2 && !settled; attempt += 1) {
    try {
      await win.webContents.executeJavaScript(`document.fonts.ready.then(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } return true; })`);
      settled = true;
    } catch (error) {
      settleError = error;
      await wait(120);
    }
  }
  if (!settled) throw settleError;
  let image = null;
  let png = null;
  let encodeError = null;
  for (let attempt = 0; attempt < 3 && !png; attempt += 1) {
    image = await capturePageWithRetry(win, name);
    try {
      png = image.toPNG();
    } catch (error) {
      encodeError = error;
      await forceRepaint(win);
    }
  }
  if (!png) throw new Error(`${name} PNG 인코딩 실패: ${encodeError?.stack || encodeError?.message || encodeError}`);
  const deviceScaleFactor = await win.webContents.executeJavaScript('window.devicePixelRatio || 1');
  const captured = image.getSize();
  const expectedWidth = Math.round(contentWidth * deviceScaleFactor);
  const expectedHeight = Math.round(contentHeight * deviceScaleFactor);
  if (Math.abs(captured.width - expectedWidth) > 2 || Math.abs(captured.height - expectedHeight) > 2) {
    throw new Error(`캡처 크기가 현재 창과 다릅니다: ${name} ${captured.width}×${captured.height} / ${expectedWidth}×${expectedHeight} (DPR ${deviceScaleFactor})`);
  }
  fs.writeFileSync(path.join(outputDir, name), png);
}

async function auditVisibleText(win, view) {
  return win.webContents.executeJavaScript(`(() => {
    const withinViewport = rect => rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    const visibleAtCenter = element => {
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const top = document.elementsFromPoint(x, y).find(candidate => getComputedStyle(candidate).pointerEvents !== 'none');
      return Boolean(top && (top === element || element.contains(top) || top.contains(element)));
    };
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
      if (rect.width < 2 || rect.height < 2 || !withinViewport(rect) || !visibleAtCenter(element)
        || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < .55) return [];
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
        if (rect.width < 2 || rect.height < 2 || !withinViewport(rect) || !visibleAtCenter(element)
          || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < .2) return [];
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
      '.drawer-meta',
      '.chat-prompt-actions',
      '.agent-command-actions',
      '.mobile-bottom-nav',
    ];
    const crowdedGroups = spacingGroups.flatMap(selector => [...document.querySelectorAll(selector)].flatMap(group => {
      const rect = group.getBoundingClientRect();
      const style = getComputedStyle(group);
      if (rect.width < 2 || rect.height < 2 || !withinViewport(rect) || !visibleAtCenter(group)
        || group.closest('[inert], [aria-hidden="true"], .hidden')
        || style.display === 'none' || style.visibility === 'hidden') return [];
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
    const reviewOutputDir = path.join(__dirname, '..', '.planning', 'ui-reviews', '1.4.0-current');
    fs.mkdirSync(reviewOutputDir, { recursive: true });

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
      && Boolean(document.querySelector('.provider-usage-overview'))
      && Boolean(document.querySelector('[data-control-room-overview]'))`);
    // Chromium can return a stale first frame for a newly shown BrowserWindow.
    // Prime the compositor once so the checked artifact always reflects the DOM.
    await capturePageWithRetry(win, 'compositor-prime');
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
        && section.querySelector('.provider-usage-overview')
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
    const mobileProjectStatusMetrics = await win.webContents.executeJavaScript(`(() => {
      const dot = [...document.querySelectorAll('#mobileWorkspaceList .workspace-live-state i')]
        .find(candidate => candidate.getClientRects().length > 0);
      const label = dot?.closest('.workspace-live-state')?.querySelector('b');
      const rect = dot?.getBoundingClientRect();
      return {
        found: Boolean(dot),
        width: rect?.width || 0,
        height: rect?.height || 0,
        round: dot ? getComputedStyle(dot).borderRadius : '',
        labelHidden: label ? getComputedStyle(label).display === 'none' : true,
        accessibleLabel: dot?.closest('.workspace-live-state')?.getAttribute('aria-label') || '',
      };
    })()`);
    if (!mobileProjectStatusMetrics.found
      || mobileProjectStatusMetrics.width > 9 || mobileProjectStatusMetrics.height > 9
      || !mobileProjectStatusMetrics.round.includes('50')
      || !mobileProjectStatusMetrics.labelHidden || !mobileProjectStatusMetrics.accessibleLabel) {
      throw new Error(`모바일 프로젝트 상태 표시가 아이콘 CSS와 충돌합니다: ${JSON.stringify(mobileProjectStatusMetrics)}`);
    }
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

    await win.webContents.executeJavaScript(`(async () => {
      const app = window.LoadToAgentApp;
      app.state.view = 'terminal';
      app.syncViewChrome();
      app.render('view');
      await window.LoadToAgentTerminal.activate(app.state.snapshot, app.state.workspaces, 'general');
      document.querySelector('[data-terminal-id="terminal-managed"]')?.click();
      document.querySelector('.main-stage')?.scrollTo(0, 0);
      return true;
    })()`);
    await waitFor(win, `document.querySelector('.terminal-session-item.active')?.dataset.terminalId === 'terminal-managed'
      && !document.querySelector('#terminalCommandInput')?.disabled`);
    const emptyTerminalSubmitMetrics = await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#terminalCommandInput');
      const submit = document.querySelector('#terminalCommandForm button[type="submit"]');
      input.value = '   ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const whitespaceDisabled = submit.disabled;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { whitespaceDisabled, emptyDisabled: submit.disabled };
    })()`);
    if (!emptyTerminalSubmitMetrics.whitespaceDisabled || !emptyTerminalSubmitMetrics.emptyDisabled) {
      throw new Error(`빈 터미널 입력의 전송 버튼이 활성화되어 있습니다: ${JSON.stringify(emptyTerminalSubmitMetrics)}`);
    }
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#terminalCommandInput');
      input.value = '/';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus({ preventScroll: true });
      return true;
    })()`);
    await waitFor(win, `!document.querySelector('#terminalSlashMenu')?.classList.contains('hidden')
      && document.querySelectorAll('#terminalSlashMenuList [role="option"]').length === 6`);
    const slashComposerMetrics = await win.webContents.executeJavaScript(`(() => {
      const form = document.querySelector('#terminalCommandForm');
      const menu = document.querySelector('#terminalSlashMenu');
      const input = document.querySelector('#terminalCommandInput');
      const options = [...document.querySelectorAll('#terminalSlashMenuList [role="option"]')];
      const submitLabel = form.querySelector('.terminal-command-submit > span');
      return {
        aiTarget: form.dataset.aiTarget,
        menuVisible: !menu.classList.contains('hidden'),
        optionCount: options.length,
        allOptionsReadable: options.every(option => option.getBoundingClientRect().height >= 48),
        noOverflow: form.scrollWidth <= form.clientWidth + 2 && menu.scrollWidth <= menu.clientWidth + 2,
        ariaExpanded: input.getAttribute('aria-expanded'),
        activeDescendant: input.getAttribute('aria-activedescendant') || '',
        sendLabelNoWrap: Boolean(submitLabel && getComputedStyle(submitLabel).whiteSpace === 'nowrap'
          && submitLabel.getBoundingClientRect().height < 24),
      };
    })()`);
    if (slashComposerMetrics.aiTarget !== 'true' || !slashComposerMetrics.menuVisible
      || slashComposerMetrics.optionCount !== 6 || !slashComposerMetrics.allOptionsReadable
      || !slashComposerMetrics.noOverflow || slashComposerMetrics.ariaExpanded !== 'true'
      || !slashComposerMetrics.activeDescendant || !slashComposerMetrics.sendLabelNoWrap) {
      throw new Error(`슬래시 composer 가독성 계약 미달: ${JSON.stringify(slashComposerMetrics)}`);
    }
    viewReports.push(await auditVisibleText(win, 'terminal-slash-composer'));
    await capture(win, outputDir, 'loadtoagent-terminal-composer-slash.png', true);

    const longDraftSetup = await win.webContents.executeJavaScript(`(() => {
      try {
        const input = document.querySelector('#terminalCommandInput');
        if (!input) return { ok: false, error: 'terminalCommandInput missing' };
        input.value = Array.from({ length: 22 }, (_, index) => \`요청 \${index + 1}. 긴 구현 지시도 문장과 줄바꿈을 유지하면서 화면을 과도하게 밀어내지 않게 정리해줘.\`).join('\\n');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus({ preventScroll: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.stack || error) };
      }
    })()`);
    if (!longDraftSetup.ok) throw new Error(`긴 입력 준비 실패: ${JSON.stringify(longDraftSetup)}`);
    await waitFor(win, `document.querySelector('#terminalCommandForm')?.dataset.longDraft === 'true'
      && document.querySelector('#terminalCommandForm')?.dataset.longDraftExpanded === 'false'
      && document.querySelector('#terminalCommandInput')?.scrollHeight > document.querySelector('#terminalCommandInput')?.clientHeight`);
    const longComposerMetrics = await win.webContents.executeJavaScript(`(() => {
      try {
        const form = document.querySelector('#terminalCommandForm');
        const input = document.querySelector('#terminalCommandInput');
        const footer = document.querySelector('.terminal-command-footer');
        const toggle = document.querySelector('#terminalLongDraftToggle');
        return {
          ok: true,
          height: input.clientHeight,
          scrollHeight: input.scrollHeight,
          formNoOverflow: form.scrollWidth <= form.clientWidth + 2,
          inputNoHorizontalOverflow: input.scrollWidth <= input.clientWidth + 2,
          footerNoOverflow: footer.scrollWidth <= footer.clientWidth + 2,
          toggleHeight: toggle.getBoundingClientRect().height,
          summary: document.querySelector('#terminalLongDraftSummary')?.textContent || '',
        };
      } catch (error) {
        return { ok: false, error: String(error?.stack || error) };
      }
    })()`);
    if (!longComposerMetrics.ok || longComposerMetrics.height > 114 || longComposerMetrics.scrollHeight <= longComposerMetrics.height
      || !longComposerMetrics.formNoOverflow || !longComposerMetrics.inputNoHorizontalOverflow
      || !longComposerMetrics.footerNoOverflow || longComposerMetrics.toggleHeight < 40
      || !longComposerMetrics.summary.includes('긴 입력')) {
      throw new Error(`긴 입력 composer 가독성 계약 미달: ${JSON.stringify(longComposerMetrics)}`);
    }
    viewReports.push(await auditVisibleText(win, 'terminal-long-composer'));
    await capture(win, outputDir, 'loadtoagent-terminal-composer-long.png', true);

    win.setContentSize(420, 760);
    await wait(280);
    await win.webContents.executeJavaScript(`(() => {
      if (!document.querySelector('#mobileToolsMenu')?.classList.contains('hidden')) {
        document.querySelector('#mobileToolsCloseBtn')?.click();
      }
      document.querySelector('#terminalCommandInput')?.focus({ preventScroll: true });
      return true;
    })()`);
    await wait(180);
    const compactComposerMetrics = await win.webContents.executeJavaScript(`(() => {
      const form = document.querySelector('#terminalCommandForm');
      const input = document.querySelector('#terminalCommandInput');
      const footer = document.querySelector('.terminal-command-footer');
      const submitLabel = form.querySelector('.terminal-command-submit > span');
      const bounds = form.getBoundingClientRect();
      const ancestors = [];
      for (let node = form.parentElement; node && ancestors.length < 8; node = node.parentElement) {
        const style = getComputedStyle(node);
        ancestors.push({
          name: node.id || node.className || node.tagName,
          transform: style.transform,
          filter: style.filter,
          contain: style.contain,
        });
      }
      return {
        formVisible: bounds.bottom <= innerHeight + 2,
        formTop: Math.round(bounds.top),
        formBottom: Math.round(bounds.bottom),
        viewport: [innerWidth, innerHeight],
        position: getComputedStyle(form).position,
        currentView: document.body.dataset.currentView || '',
        ancestors,
        formNoOverflow: form.scrollWidth <= form.clientWidth + 2,
        inputNoOverflow: input.scrollWidth <= input.clientWidth + 2,
        footerNoOverflow: footer.scrollWidth <= footer.clientWidth + 2,
        textareaHeight: input.clientHeight,
        sendLabelNoWrap: Boolean(submitLabel && getComputedStyle(submitLabel).whiteSpace === 'nowrap'
          && submitLabel.getBoundingClientRect().height < 24),
      };
    })()`);
    if (!compactComposerMetrics.formVisible || !compactComposerMetrics.formNoOverflow
      || !compactComposerMetrics.inputNoOverflow || !compactComposerMetrics.footerNoOverflow
      || compactComposerMetrics.textareaHeight > 114 || !compactComposerMetrics.sendLabelNoWrap) {
      throw new Error(`작은 화면 composer 가독성 계약 미달: ${JSON.stringify(compactComposerMetrics)}`);
    }
    await capture(win, outputDir, 'loadtoagent-terminal-composer-compact.png', true);
    win.setContentSize(1440, 900);
    await wait(250);
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#terminalCommandInput');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    await win.webContents.executeJavaScript(`(() => { document.querySelector('#newRunBtn')?.click(); return true; })()`);
    await waitFor(win, `!document.querySelector('#runModal')?.classList.contains('hidden') && !document.querySelector('#runModal')?.inert`);
    await wait(400);
    await win.webContents.executeJavaScript(`(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } return true; })()`);
    viewReports.push(await auditVisibleText(win, 'run-modal'));
    await win.webContents.executeJavaScript(`(() => { document.querySelector('#cancelRunBtn')?.click(); return true; })()`);
    await waitFor(win, `document.querySelector('#runModal')?.classList.contains('hidden') && document.querySelector('#runModal')?.inert`);

    await win.webContents.executeJavaScript(`(() => {
      const app = window.LoadToAgentApp;
      app.state.view = 'active';
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

    win.setContentSize(1440, 900);
    await wait(250);
    const auditPrompt = `${'긴 사용자 요청은 문단, URL, 코드 기호가 섞여도 원문 그대로 읽혀야 합니다. '.repeat(11)}

\`\`\`text
잘리지 않아야 하는 코드 펜스와 https://example.test/really/long/path?with=query&and=values
\`\`\`

200자를 넘긴 뒤에도 전체 내용 보기와 요청 복사가 안정적으로 동작해야 합니다.`;
    const longDraftLength = 7900;
    await win.webContents.executeJavaScript(`(() => {
      const app = window.LoadToAgentApp;
      if (!document.querySelector('#mobileToolsMenu')?.classList.contains('hidden')) {
        document.querySelector('#mobileToolsCloseBtn')?.click();
      }
      window.interactionTest.appendSessionMessages('fixture-root', [
        { id: 'audit-long-user', role: 'user', text: ${JSON.stringify(auditPrompt)}, timestamp: new Date().toISOString() },
        { id: 'audit-long-assistant', role: 'assistant', text: '긴 요청을 원문 그대로 확인했습니다. 줄바꿈과 코드 기호를 보존해 처리하겠습니다.', timestamp: new Date(Date.now() + 1).toISOString() },
      ]);
      window.interactionTest.emitSnapshot();
      app.state.view = 'all';
      app.state.drawerTab = 'chat';
      app.state.expandedConversationPrompts.clear();
      app.syncViewChrome();
      app.render('view');
      app.openDrawer('fixture-root');
      return true;
    })()`);
    await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open')
      && Boolean(document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]'))
      && Boolean(document.querySelector('#drawerComposer:not(.hidden) [data-agent-command-form="fixture-root"]'))
      && !document.querySelector('[data-session-model-form]')`);
    await wait(400);
    await win.webContents.executeJavaScript(`(() => {
      for (const animation of document.getAnimations()) {
        try { animation.finish(); } catch {}
      }
      return true;
    })()`);
    await win.webContents.executeJavaScript(`(() => {
      const prompt = document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]');
      prompt?.scrollIntoView({ block: 'start', behavior: 'auto' });
      return true;
    })()`);
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      input.value = '가'.repeat(${longDraftLength});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await wait(180);
    const conversationMetrics = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('#detailDrawer');
      const prompt = document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]');
      const content = prompt?.querySelector('.chat-content');
      const actions = [...(prompt?.querySelectorAll('.chat-prompt-actions button') || [])];
      const composer = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      const composerPanel = composer?.closest('.agent-command-panel');
      const counter = document.querySelector('#drawerComposer [data-agent-command-count]');
      const reset = document.querySelector('[data-session-reset="fixture-root"]');
      const promptActions = prompt?.querySelector('.chat-prompt-actions');
      const composerActions = composerPanel?.querySelector('.agent-command-actions');
      const promptRect = prompt?.getBoundingClientRect();
      const probeX = Math.max(0, Math.min(innerWidth - 1, (promptRect?.left || 0) + 20));
      const probeY = Math.max(0, Math.min(innerHeight - 1, (promptRect?.top || 0) + 3));
      const topAtPrompt = document.elementsFromPoint(probeX, probeY)[0];
      const rect = element => element?.getBoundingClientRect();
      const drawerRect = rect(drawer);
      const gap = element => {
        const style = getComputedStyle(element);
        return Math.min(Number.parseFloat(style.rowGap) || 0, Number.parseFloat(style.columnGap) || 0);
      };
      return {
        drawerInsideViewport: Boolean(drawerRect && drawerRect.left >= -1 && drawerRect.right <= innerWidth + 1),
        drawerBounds: drawerRect ? [Math.round(drawerRect.left), Math.round(drawerRect.right)] : [],
        viewport: [innerWidth, innerHeight],
        promptNoOverflow: Boolean(prompt && prompt.scrollWidth <= prompt.clientWidth + 2 && content.scrollWidth <= content.clientWidth + 2),
        promptFontSize: Number.parseFloat(getComputedStyle(content).fontSize),
        promptLineHeight: Number.parseFloat(getComputedStyle(content).lineHeight),
        actionHeights: actions.map(button => rect(button).height),
        composerNoOverflow: Boolean(composer && composer.scrollWidth <= composer.clientWidth + 2),
        composerMinHeight: rect(composer)?.height || 0,
        composerScrollable: Boolean(composer && composer.scrollHeight > composer.clientHeight + 2),
        composerPanelNoOverflow: Boolean(composerPanel && composerPanel.scrollWidth <= composerPanel.clientWidth + 2),
        promptActionGap: gap(promptActions),
        composerActionGap: gap(composerActions),
        counterRemoved: !counter,
        modelFormRemoved: !document.querySelector('[data-session-model-form]'),
        resetVisible: Boolean(reset && rect(reset).width > 0 && rect(reset).height > 0),
        resetHeight: rect(reset)?.height || 0,
        commandHelpRemoved: !composerPanel?.querySelector('.agent-command-actions > small'),
        slashMenuReady: Boolean(composerPanel?.querySelector('[data-conversation-slash-menu]')),
        promptNotCovered: Boolean(topAtPrompt && (prompt?.contains(topAtPrompt) || topAtPrompt.contains(prompt))),
        tabLabels: [...document.querySelectorAll('.drawer-tab:not(.hidden)')].map(tab => tab.textContent.trim()),
      };
    })()`);
    if (!conversationMetrics.drawerInsideViewport || !conversationMetrics.promptNoOverflow
      || conversationMetrics.promptFontSize < 15 || conversationMetrics.promptLineHeight < 25
      || conversationMetrics.actionHeights.some(height => height < 43.5)
      || !conversationMetrics.composerNoOverflow || conversationMetrics.composerMinHeight < 50
      || !conversationMetrics.composerScrollable || !conversationMetrics.composerPanelNoOverflow
      || conversationMetrics.promptActionGap < 9.5 || conversationMetrics.composerActionGap < 9.5
      || !conversationMetrics.counterRemoved
      || !conversationMetrics.modelFormRemoved || !conversationMetrics.resetVisible
      || conversationMetrics.resetHeight < 43.5 || !conversationMetrics.commandHelpRemoved || !conversationMetrics.slashMenuReady
      || !conversationMetrics.promptNotCovered
      || conversationMetrics.tabLabels.join('|') !== '요약|대화|과정|사용량') {
      throw new Error(`대화창 긴 요청·입력 가독성 기준 미달: ${JSON.stringify(conversationMetrics)}`);
    }
    win.show();
    win.focus();
    await wait(120);
    await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-session-reset="fixture-root"]');
      button?.focus({ preventScroll: true });
      button?.click();
      return Boolean(button);
    })()`);
    await waitFor(win, `!document.querySelector('#sessionResetModal')?.classList.contains('hidden')
      && document.activeElement === document.querySelector('#cancelSessionResetBtn')`);
    const resetDialogMetrics = await win.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('#sessionResetModal');
      const buttons = [...modal.querySelectorAll('button')];
      return {
        drawerInert: document.querySelector('#detailDrawer').inert,
        describedBy: modal.getAttribute('aria-describedby') === 'sessionResetDescription',
        focusInside: modal.contains(document.activeElement),
        buttonHeights: buttons.map(button => button.getBoundingClientRect().height),
      };
    })()`);
    if (!resetDialogMetrics.drawerInert || !resetDialogMetrics.describedBy || !resetDialogMetrics.focusInside
      || resetDialogMetrics.buttonHeights.some(height => height < 43.5)) {
      throw new Error(`세션 초기화 확인창 접근성 기준 미달: ${JSON.stringify(resetDialogMetrics)}`);
    }
    viewReports.push(await auditVisibleText(win, 'reset-dialog'));
    await capture(win, reviewOutputDir, 'conversation-reset-confirm.png', true);
    await win.webContents.executeJavaScript(`document.querySelector('#cancelSessionResetBtn')?.click()`);
    await waitFor(win, `document.querySelector('#sessionResetModal')?.classList.contains('hidden')`);
    viewReports.push(await auditVisibleText(win, 'conversation-desktop'));
    await capture(win, reviewOutputDir, 'conversation-desktop-collapsed.png', true);
    await win.webContents.executeJavaScript(`document.querySelector('[data-message-id="audit-long-user"] [data-prompt-toggle]')?.click()`);
    await waitFor(win, `document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]')?.dataset.promptExpanded === 'true'`);
    const desktopExpandedMetrics = await win.webContents.executeJavaScript(`(() => {
      const close = document.querySelector('[data-message-id="audit-long-user"] [data-close-expanded-reader]');
      return {
        readerCloseHidden: Boolean(close && getComputedStyle(close).display === 'none'
          && close.getClientRects().length === 0),
        headerCloseVisible: Boolean(document.querySelector('#closeDrawerBtn')?.getClientRects().length),
      };
    })()`);
    if (!desktopExpandedMetrics.readerCloseHidden || !desktopExpandedMetrics.headerCloseVisible) {
      throw new Error(`데스크톱 펼친 요청 닫기 동작이 중복됩니다: ${JSON.stringify(desktopExpandedMetrics)}`);
    }
    await capture(win, reviewOutputDir, 'conversation-desktop-expanded.png', true);
    await win.webContents.executeJavaScript(`document.querySelector('[data-message-id="audit-long-user"] [data-prompt-toggle]')?.click()`);

    win.setContentSize(390, 760);
    await wait(260);
    await win.webContents.executeJavaScript(`(() => {
      if (!document.querySelector('#mobileToolsMenu')?.classList.contains('hidden')) {
        document.querySelector('#mobileToolsCloseBtn')?.click();
      }
      window.LoadToAgentApp.renderDrawer();
      document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]')?.scrollIntoView({ block: 'end', behavior: 'auto' });
      return true;
    })()`);
    await wait(120);
    await win.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('#drawerContent');
      const prompt = document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]');
      if (content && prompt) {
        content.scrollTop += prompt.getBoundingClientRect().bottom - content.getBoundingClientRect().bottom + 4;
      }
      return true;
    })()`);
    await wait(80);
    await capture(win, reviewOutputDir, 'conversation-mobile-ko-collapsed.png', true);
    await win.webContents.executeJavaScript(`document.querySelector('[data-message-id="audit-long-user"] [data-prompt-toggle]')?.click()`);
    await waitFor(win, `document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]')?.dataset.promptExpanded === 'true'`);
    await capture(win, reviewOutputDir, 'conversation-mobile-ko-expanded.png', true);
    await win.webContents.executeJavaScript(`document.querySelector('[data-message-id="audit-long-user"] [data-prompt-toggle]')?.click()`);
    await waitFor(win, `document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]')?.dataset.promptExpanded === 'false'`);
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentI18n.setLocale('en');
      window.LoadToAgentApp.renderDrawer();
      document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]')?.scrollIntoView({ block: 'end', behavior: 'auto' });
      return true;
    })()`);
    await wait(120);
    await win.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('#drawerContent');
      const prompt = document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]');
      if (content && prompt) {
        content.scrollTop += prompt.getBoundingClientRect().bottom - content.getBoundingClientRect().bottom + 4;
      }
      return true;
    })()`);
    await wait(80);
    const mobileConversationMetrics = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('#detailDrawer');
      const content = document.querySelector('#drawerContent');
      const prompt = document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]');
      const composer = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      const help = document.querySelector('#drawerComposer .agent-command-actions > small');
      const slashMenu = document.querySelector('#drawerComposer [data-conversation-slash-menu]');
      const actions = [...(prompt?.querySelectorAll('.chat-prompt-actions button') || [])];
      const stop = document.querySelector('#drawerMeta .stop-run');
      const reset = document.querySelector('#drawerMeta .session-reset-button');
      const promptRect = prompt.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const probeX = Math.max(0, Math.min(innerWidth - 1, promptRect.left + Math.min(20, promptRect.width / 2)));
      const probeY = Math.max(0, Math.min(innerHeight - 1, promptRect.top + 3));
      const topAtPrompt = document.elementsFromPoint(probeX, probeY)[0];
      return {
        drawerInsideViewport: drawer.getBoundingClientRect().left >= -1 && drawer.getBoundingClientRect().right <= innerWidth + 1,
        drawerNoOverflow: drawer.scrollWidth <= drawer.clientWidth + 2,
        promptNoOverflow: prompt.scrollWidth <= prompt.clientWidth + 2,
        composerNoOverflow: composer.scrollWidth <= composer.clientWidth + 2,
        transcriptVisibleHeight: contentRect.height,
        promptNotCovered: Boolean(topAtPrompt && (prompt.contains(topAtPrompt) || topAtPrompt.contains(prompt))),
        chromeRemoved: !help && !document.querySelector('#drawerComposer [data-agent-command-count], #drawerComposer .conversation-terminal-toggle'),
        slashMenuReady: Boolean(slashMenu),
        tabLabels: [...document.querySelectorAll('.drawer-tab:not(.hidden)')].map(tab => tab.textContent.trim()),
        actionHeights: actions.map(button => button.getBoundingClientRect().height),
        headerActionsDistinct: Boolean(stop && reset
          && getComputedStyle(stop).backgroundColor !== getComputedStyle(reset).backgroundColor
          && getComputedStyle(stop).borderColor !== getComputedStyle(reset).borderColor),
      };
    })()`);
    if (!mobileConversationMetrics.drawerInsideViewport || !mobileConversationMetrics.drawerNoOverflow
      || !mobileConversationMetrics.promptNoOverflow || !mobileConversationMetrics.composerNoOverflow
      || mobileConversationMetrics.transcriptVisibleHeight < 240 || !mobileConversationMetrics.promptNotCovered
      || !mobileConversationMetrics.chromeRemoved || !mobileConversationMetrics.slashMenuReady
      || !mobileConversationMetrics.headerActionsDistinct
      || mobileConversationMetrics.tabLabels.join('|') !== 'Summary|Chat|Steps|Usage'
      || mobileConversationMetrics.actionHeights.some(height => height < 43.5)) {
      throw new Error(`모바일 대화창 가독성 기준 미달: ${JSON.stringify(mobileConversationMetrics)}`);
    }
    viewReports.push(await auditVisibleText(win, 'conversation-mobile'));
    await capture(win, reviewOutputDir, 'conversation-mobile-en-collapsed.png', true);
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const emptyConversationSubmitMetrics = await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      const submit = input?.closest('form')?.querySelector('button[type="submit"]');
      input.value = '   ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const whitespaceDisabled = submit?.disabled;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { whitespaceDisabled, emptyDisabled: submit?.disabled };
    })()`);
    if (!emptyConversationSubmitMetrics.whitespaceDisabled || !emptyConversationSubmitMetrics.emptyDisabled) {
      throw new Error(`빈 대화 입력의 전송 버튼이 활성화되어 있습니다: ${JSON.stringify(emptyConversationSubmitMetrics)}`);
    }
    await capture(win, reviewOutputDir, 'conversation-mobile-en-empty-composer.png', true);
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      input.value = ${JSON.stringify('가'.repeat(7900))};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const nearLimitComposerMetrics = await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#drawerComposer [data-agent-command-draft="fixture-root"]');
      const form = input?.closest('form');
      const submit = form?.querySelector('button[type="submit"]');
      const count = form?.querySelector('[data-conversation-draft-count]');
      return {
        submitEnabled: Boolean(submit && !submit.disabled),
        countVisible: Boolean(count && !count.classList.contains('hidden')),
        countWarning: Boolean(count && count.classList.contains('limit-near')),
        countText: count?.textContent.trim() || '',
      };
    })()`);
    if (!nearLimitComposerMetrics.submitEnabled || !nearLimitComposerMetrics.countVisible
      || !nearLimitComposerMetrics.countWarning || !nearLimitComposerMetrics.countText.includes('7,900')) {
      throw new Error(`대화 입력 한도 피드백이 명확하지 않습니다: ${JSON.stringify(nearLimitComposerMetrics)}`);
    }
    await win.webContents.executeJavaScript(`document.querySelector('[data-message-id="audit-long-user"] [data-prompt-toggle]')?.click()`);
    await waitFor(win, `document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]')?.dataset.promptExpanded === 'true'`);
    const expandedMobileMetrics = await win.webContents.executeJavaScript(`(() => {
      const prompt = document.querySelector('[data-message-id="audit-long-user"] [data-user-prompt]');
      const body = prompt?.querySelector('.user-prompt-text');
      const topActions = prompt?.querySelector('.chat-prompt-actions.is-top');
      const controls = topActions?.querySelector('[data-prompt-toggle]')?.getAttribute('aria-controls') || '';
      const actionButtons = [...(topActions?.querySelectorAll('button') || [])];
      const actionTops = actionButtons.map(button => button.getBoundingClientRect().top);
      return {
        promptNoOverflow: prompt.scrollWidth <= prompt.clientWidth + 2 && body.scrollWidth <= body.clientWidth + 2,
        promptWidth: [prompt.clientWidth, prompt.scrollWidth],
        bodyWidth: [body.clientWidth, body.scrollWidth],
        topActionsVisible: Boolean(topActions && topActions.getBoundingClientRect().height > 0),
        topActionsNoOverflow: Boolean(topActions && topActions.scrollWidth <= topActions.clientWidth + 2),
        closeVisible: Boolean(topActions?.querySelector('[data-close-expanded-reader]')?.getBoundingClientRect().height > 0),
        controlsBody: Boolean(controls && document.getElementById(controls) === body),
        visibleBodyLines: Math.floor(Math.max(0, Math.min(innerHeight, body.getBoundingClientRect().bottom)
          - Math.max(0, body.getBoundingClientRect().top)) / parseFloat(getComputedStyle(body).lineHeight)),
        actionHeights: actionButtons.map(button => button.getBoundingClientRect().height),
        singleActionRow: actionTops.length === 3 && Math.max(...actionTops) - Math.min(...actionTops) < 2,
      };
    })()`);
    if (!expandedMobileMetrics.promptNoOverflow || !expandedMobileMetrics.topActionsVisible
      || !expandedMobileMetrics.topActionsNoOverflow || !expandedMobileMetrics.closeVisible
      || !expandedMobileMetrics.controlsBody || !expandedMobileMetrics.singleActionRow
      || expandedMobileMetrics.visibleBodyLines < 6
      || expandedMobileMetrics.actionHeights.some(height => height < 43.5)) {
      throw new Error(`영문 모바일 펼친 요청 가독성 기준 미달: ${JSON.stringify(expandedMobileMetrics)}`);
    }
    await capture(win, reviewOutputDir, 'conversation-mobile-en-expanded.png', true);

    const familyEmoji = '👨‍👩‍👧‍👦';
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentI18n.setLocale('ko');
      window.interactionTest.appendSessionMessages('fixture-ended', [
        { id: 'audit-boundary-200', role: 'user', text: ${JSON.stringify('가'.repeat(200))}, timestamp: new Date(Date.now() + 10).toISOString() },
        { id: 'audit-boundary-201', role: 'user', text: ${JSON.stringify('가'.repeat(201))}, timestamp: new Date(Date.now() + 11).toISOString() },
        { id: 'audit-grapheme-201', role: 'user', text: ${JSON.stringify(familyEmoji.repeat(201))}, timestamp: new Date(Date.now() + 12).toISOString() },
      ]);
      window.interactionTest.emitSnapshot();
      window.LoadToAgentApp.state.expandedConversationPrompts.clear();
      window.LoadToAgentApp.openDrawer('fixture-ended');
      return true;
    })()`);
    await waitFor(win, `Boolean(document.querySelector('[data-message-id="audit-grapheme-201"] [data-user-prompt]'))`);
    const truncationBoundary = await win.webContents.executeJavaScript(`(() => ({
      exact200: document.querySelector('[data-message-id="audit-boundary-200"] [data-user-prompt]')?.dataset.promptTruncated,
      over200: document.querySelector('[data-message-id="audit-boundary-201"] [data-user-prompt]')?.dataset.promptTruncated,
      graphemeOver200: document.querySelector('[data-message-id="audit-grapheme-201"] [data-user-prompt]')?.dataset.promptTruncated,
      graphemePreview: document.querySelector('[data-message-id="audit-grapheme-201"] .user-prompt-text')?.textContent || '',
    }))()`);
    if (truncationBoundary.exact200 !== 'false' || truncationBoundary.over200 !== 'true'
      || truncationBoundary.graphemeOver200 !== 'true'
      || truncationBoundary.graphemePreview !== familyEmoji.repeat(200) + '…') {
      throw new Error(`200자·이모지 경계 축약 오류: ${JSON.stringify(truncationBoundary)}`);
    }

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
