'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-theme-'));
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

async function capture(win, outputDir, name) {
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await win.webContents.executeJavaScript(`(() => {
    for (const animation of document.getAnimations()) {
      try { animation.finish(); } catch {}
    }
    void document.body.offsetHeight;
    return true;
  })()`);
  win.webContents.invalidate();
  await wait(180);
  const output = path.join(outputDir, name);
  fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
  return output;
}

const BUTTON_AUDIT_EXPRESSION = `(() => {
  const trackedActionSelector = [
    '.primary-button',
    '.ghost-button',
    '.new-run-cta',
    '.app-error-actions > button',
    '.update-actions > button',
    '.management-quick-actions > button',
    '.management-control-buttons > button',
    '.attention-card-header-actions > button',
    '.session-reset-dialog-actions > button',
    '.modal-actions > button',
    '.chat-prompt-actions > button',
    '.agent-command-actions > button',
    '.terminal-create-actions > button',
    '.tmux-section-actions > button',
  ].join(',');
  const actionGroupSelector = [
    '.top-actions',
    '.app-error-actions',
    '.update-actions',
    '.modal-actions',
    '.management-quick-actions',
    '.management-control-buttons',
    '.attention-card-header-actions',
    '.session-reset-dialog-actions',
    '.chat-prompt-actions',
    '.agent-command-actions',
    '.terminal-create-actions',
    '.tmux-section-actions',
  ].join(',');
  const pixels = value => Number.parseFloat(value) || 0;
  const parse = value => {
    const match = String(value || '').match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const values = match[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    return { r: values[0] || 0, g: values[1] || 0, b: values[2] || 0, a: values.length > 3 ? values[3] : 1 };
  };
  const linear = channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  };
  const luminance = color => .2126 * linear(color.r) + .7152 * linear(color.g) + .0722 * linear(color.b);
  const contrast = (a, b) => {
    const first = luminance(a);
    const second = luminance(b);
    return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
  };
  const effectiveBackground = element => {
    let current = element;
    while (current) {
      const color = parse(getComputedStyle(current).backgroundColor);
      if (color && color.a >= .92) return color;
      current = current.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  };
  const theme = document.documentElement.dataset.theme;
  const buttons = [...document.querySelectorAll('button')].filter(button => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  });
  const results = buttons.map((button, index) => {
    const style = getComputedStyle(button);
    const foreground = parse(style.color);
    const background = effectiveBackground(button);
    const ratio = foreground ? contrast(foreground, background) : 0;
    const backgroundLuminance = luminance(background);
    const semantic = button.matches('.primary-button,.new-run-cta,.conversation-send,.accent,[data-status-action],.stop-run,.conversation-interrupt');
    const terminal = Boolean(button.closest('.terminal-screen,.terminal-xterm,.xterm,.xterm-viewport'));
    const trackedAction = button.matches(trackedActionSelector);
    const themeMismatch = !terminal && (
      (theme === 'light' && backgroundLuminance < .16 && !semantic)
      || (theme === 'dark' && backgroundLuminance > .92 && !semantic)
    );
    const minimumContrast = button.disabled ? 2.2 : 3;
    return {
      index,
      label: (button.innerText || button.getAttribute('aria-label') || button.id || button.className || 'button').replace(/\\s+/g, ' ').trim().slice(0, 80),
      id: button.id || '',
      className: String(button.className || '').slice(0, 120),
      disabled: Boolean(button.disabled),
      foreground: style.color,
      background: 'rgb(' + background.r + ', ' + background.g + ', ' + background.b + ')',
      contrast: Number(ratio.toFixed(2)),
      themeMismatch,
      lowContrast: ratio < minimumContrast,
      trackedAction,
      height: Number(button.getBoundingClientRect().height.toFixed(2)),
      paddingLeft: pixels(style.paddingLeft),
      paddingRight: pixels(style.paddingRight),
      letterSpacing: pixels(style.letterSpacing),
    };
  });
  const textResults = [...document.querySelectorAll('body *')].flatMap(element => {
    if (element.closest(
      '[aria-hidden="true"], [inert], details:not([open]), .hidden, .sr-only, .visually-hidden, '
      + '.xterm-helper-textarea, .terminal-screen, .terminal-xterm, .xterm, script, style'
    )) return [];
    const text = [...element.childNodes]
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => String(node.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
    if (text.length < 2) return [];
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width < 2 || rect.height < 2 || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= innerHeight || rect.left >= innerWidth
      || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < .55) return [];
    const foreground = parse(style.color);
    if (!foreground || foreground.a < .75) return [];
    const background = effectiveBackground(element);
    const ratio = contrast(foreground, background);
    const fontSize = pixels(style.fontSize);
    const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
    const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    const selector = [
      element.id && '#' + element.id,
      ...[...element.classList].slice(0, 3).map(name => '.' + name),
    ].filter(Boolean).join('') || element.tagName.toLowerCase();
    return [{
      selector,
      text: text.slice(0, 100),
      foreground: style.color,
      background: 'rgb(' + background.r + ', ' + background.g + ', ' + background.b + ')',
      contrast: Number(ratio.toFixed(2)),
      required: large ? 3 : 4.5,
    }];
  });
  const trackedActions = results.filter(result => result.trackedAction);
  const actionGroups = [...document.querySelectorAll(actionGroupSelector)]
    .filter(group => {
      const rect = group.getBoundingClientRect();
      const style = getComputedStyle(group);
      const visibleButtons = [...group.children].filter(child => child.matches?.('button') && child.getBoundingClientRect().width > 0);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && visibleButtons.length > 1;
    })
    .map(group => {
      const style = getComputedStyle(group);
      return {
        className: String(group.className || group.id || group.tagName),
        columnGap: pixels(style.columnGap),
        rowGap: pixels(style.rowGap),
      };
    });
  const elementContract = selector => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      selector,
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
      position: style.position,
      left: Number(rect.left.toFixed(2)),
      top: Number(rect.top.toFixed(2)),
      width: Number(rect.width.toFixed(2)),
      height: Number(rect.height.toFixed(2)),
      color: style.color,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      fontWeight: Number(style.fontWeight) || style.fontWeight,
      lineHeight: style.lineHeight,
    };
  };
  return {
    theme,
    total: results.length,
    themeMismatches: results.filter(result => result.themeMismatch),
    lowContrast: results.filter(result => result.lowContrast),
    contracts: {
      body: elementContract('body'),
      pageTitle: elementContract('#pageTitle'),
      newRun: elementContract('#newRunBtn'),
      homeAttention: elementContract('.home-attention-strip'),
      firstAttention: elementContract('.home-attention-item:first-child'),
      homeAttentionText: elementContract('.home-attention-item b'),
      projectGroup: elementContract('.control-room-project-group'),
      projectHeader: elementContract('.control-project-header'),
      projectHeading: elementContract('.control-project-heading'),
      projectAction: elementContract('.control-project-flow-link'),
      projectActionLabel: elementContract('.control-project-flow-link > span'),
      memoryProject: elementContract('#memoryWorkspaceFilter'),
      providerFilter: elementContract('#providerFilter'),
      newRunTitle: elementContract('#newRunBtn .new-run-cta-copy b'),
      newRunShortcut: elementContract('#newRunBtn .new-run-cta-copy small'),
      newRunKey: elementContract('#newRunBtn .new-run-cta-copy kbd'),
      terminalTargetTitle: elementContract('.terminal-target-meta b'),
    },
    text: {
      total: textResults.length,
      lowContrast: textResults.filter(result => result.contrast + .02 < result.required).slice(0, 40),
      minimumContrast: textResults.length ? Math.min(...textResults.map(result => result.contrast)) : 0,
    },
    rhythm: {
      trackedActions: trackedActions.length,
      shortActions: trackedActions.filter(result => result.height < 39.5),
      unevenPadding: trackedActions.filter(result => Math.abs(result.paddingLeft - result.paddingRight) > 1),
      trackedLetterSpacing: trackedActions.filter(result => Math.abs(result.letterSpacing) > .01),
      tightActionGroups: actionGroups.filter(group => group.columnGap < 7.5 || group.rowGap < 7.5),
      actionGroups,
    },
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    backgroundColor: '#f4f5f8',
    webPreferences: {
      preload: path.join(__dirname, 'interaction-fixture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const outputDir = path.join(__dirname, '..', 'artifacts', 'theme');
  fs.mkdirSync(outputDir, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), screens: [], failures: [] };

  async function inspect(theme, label) {
    await wait(240);
    const audit = await win.webContents.executeJavaScript(BUTTON_AUDIT_EXPRESSION);
    const file = await capture(win, outputDir, `${theme}-${label}.png`);
    report.screens.push({ theme, label, file, audit });
    const contractFailures = [];
    if (label === 'all') {
      if (!audit.contracts.newRun || audit.contracts.newRun.display === 'none' || audit.contracts.newRun.width < 1) {
        contractFailures.push('처리 중 화면의 새 AI 작업 시작 버튼이 보이지 않습니다.');
      }
      if (audit.contracts.projectAction && (audit.contracts.projectAction.display === 'none' || audit.contracts.projectAction.width < 1)) {
        contractFailures.push('작업 진행 화면 보기 버튼이 보이지 않습니다.');
      }
      if (
        audit.contracts.projectHeader
        && audit.contracts.projectAction
        && Math.abs(
          audit.contracts.projectHeader.top + audit.contracts.projectHeader.height / 2
          - audit.contracts.projectAction.top - audit.contracts.projectAction.height / 2,
        ) > 1.5
      ) {
        contractFailures.push('작업 진행 화면 보기 버튼이 프로젝트 헤더 중앙에 정렬되지 않았습니다.');
      }
      if (Number(audit.contracts.pageTitle?.fontWeight || 0) > 500) {
        contractFailures.push('화면 제목 글자 굵기가 500을 초과합니다.');
      }
      if (theme === 'light' && audit.contracts.firstAttention) {
        const background = audit.contracts.firstAttention.backgroundColor;
        if (!/^rgb\(255, 248, 246\)$/.test(background)) {
          contractFailures.push('라이트 테마의 우선 확인 카드가 밝은 전용 배경을 사용하지 않습니다.');
        }
      }
    }
    if (label === 'waiting' && audit.contracts.newRun && audit.contracts.newRun.display !== 'none' && audit.contracts.newRun.width > 0) {
      contractFailures.push('확인 대기 화면에 새 AI 작업 시작 버튼이 노출됩니다.');
    }
    if (label === 'active') {
      if (!audit.contracts.memoryProject || audit.contracts.memoryProject.display === 'none' || audit.contracts.memoryProject.width < 1) {
        contractFailures.push('지난 작업 프로젝트 필터가 보이지 않습니다.');
      }
      if (!audit.contracts.providerFilter || audit.contracts.providerFilter.display === 'none' || audit.contracts.providerFilter.width < 1) {
        contractFailures.push('지난 작업 AI 필터가 보이지 않습니다.');
      }
    }
    if (label === 'wide-all') {
      if (!audit.contracts.newRunShortcut || audit.contracts.newRunShortcut.display === 'none' || audit.contracts.newRunShortcut.width < 1) {
        contractFailures.push('넓은 화면의 새 AI 작업 시작 버튼에 단축키 안내가 보이지 않습니다.');
      }
      if (theme === 'light' && audit.contracts.newRunShortcut?.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        contractFailures.push('라이트 테마의 새 작업 단축키 안내에 불필요한 배경색이 남아 있습니다.');
      }
      if (theme === 'light' && !/^rgb\(255, 255, 255\)$/.test(audit.contracts.newRunShortcut?.color || '')) {
        contractFailures.push('라이트 테마의 새 작업 단축키 안내가 선명한 흰색을 사용하지 않습니다.');
      }
    }
    if (label === 'terminal' && theme === 'light' && !/^rgb\(238, 245, 247\)$/.test(audit.contracts.terminalTargetTitle?.color || '')) {
      contractFailures.push('라이트 테마의 터미널 대상 제목이 어두운 작업판에서 선명하게 보이지 않습니다.');
    }
    if (
      audit.themeMismatches.length
      || audit.lowContrast.length
      || audit.text.lowContrast.length
      || audit.rhythm.shortActions.length
      || audit.rhythm.unevenPadding.length
      || audit.rhythm.trackedLetterSpacing.length
      || audit.rhythm.tightActionGroups.length
      || contractFailures.length
    ) {
      report.failures.push({ theme, label, contractFailures, ...audit });
    }
  }

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await waitFor(
      win,
      `Boolean(window.LoadToAgentApp?.initialized && window.LoadToAgentApp?.state?.snapshot && window.LoadToAgentTheme)`,
      '테마 검수용 앱 화면이 준비되지 않았습니다.',
    );
    await win.webContents.executeJavaScript(`(() => {
      window.LoadToAgentI18n.setLocale('ko');
      window.LoadToAgentApp.state.guideExpanded = false;
      window.LoadToAgentApp.render();
      document.querySelector('#beginnerGuide')?.classList.add('hidden');
      return true;
    })()`);

    for (const theme of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`window.LoadToAgentTheme.setTheme(${JSON.stringify(theme)})`);
      for (const view of ['all', 'active', 'waiting', 'runtime', 'terminal', 'tmux', 'settings']) {
        await win.webContents.executeJavaScript(`(() => {
          window.LoadToAgentApp.selectView(${JSON.stringify(view)});
          window.LoadToAgentApp.state.guideCompleted.clear();
          window.LoadToAgentApp.render();
          document.querySelector('.main-stage')?.scrollTo(0, 0);
          return true;
        })()`);
        await inspect(theme, view);
      }

      await win.webContents.executeJavaScript(`document.querySelector('#newRunBtn')?.click()`);
      await waitFor(win, `!document.querySelector('#runModal')?.classList.contains('hidden')`, '새 작업 모달을 열지 못했습니다.');
      await inspect(theme, 'run-modal');
      await win.webContents.executeJavaScript(`document.querySelector('#cancelRunBtn')?.click()`);

      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.selectView('all');
        const session = window.LoadToAgentApp.state.snapshot.sessions.find(item => !item.parentId)
          || window.LoadToAgentApp.state.snapshot.sessions[0];
        if (session) window.LoadToAgentApp.openDrawer(session.id);
        return Boolean(session);
      })()`);
      await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open')`, '작업 상세 패널을 열지 못했습니다.');
      await inspect(theme, 'drawer');
      await win.webContents.executeJavaScript(`window.LoadToAgentApp.closeDrawer(false)`);

      win.setBounds({ width: 1840, height: 900 }, false);
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.selectView('all');
        document.querySelector('.main-stage')?.scrollTo(0, 0);
        return true;
      })()`);
      await inspect(theme, 'wide-all');

      win.setBounds({ width: 390, height: 844 }, false);
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.selectView('all');
        document.querySelector('.main-stage')?.scrollTo(0, 0);
        return true;
      })()`);
      await inspect(theme, 'mobile-home');
      win.setBounds({ width: 1440, height: 900 }, false);
    }

    await win.webContents.executeJavaScript(`window.LoadToAgentTheme.setTheme('light')`);
    await win.webContents.reload();
    await waitFor(
      win,
      `document.documentElement.dataset.theme === 'light'
        && window.LoadToAgentApp?.initialized
        && document.querySelector('[data-theme-choice="light"]')?.getAttribute('aria-checked') === 'true'`,
      '저장한 라이트 모드가 앱 재실행 상태에서 복원되지 않았습니다.',
    );
    report.persistence = {
      restoredTheme: await win.webContents.executeJavaScript('document.documentElement.dataset.theme'),
      lightChoiceChecked: await win.webContents.executeJavaScript(`document.querySelector('[data-theme-choice="light"]')?.getAttribute('aria-checked')`),
    };

    const reportPath = path.join(outputDir, 'theme-audit.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (report.failures.length) {
      throw new Error(`테마 버튼 색상·간격 검수 실패: ${JSON.stringify(report.failures, null, 2)}`);
    }
    console.log('다크·라이트 테마 화면 및 버튼 색상 검수 통과');
    console.log(reportPath);
  } catch (error) {
    console.error(error && error.stack || error);
    app.exit(1);
    return;
  } finally {
    if (!win.isDestroyed()) win.close();
  }
  app.quit();
});
