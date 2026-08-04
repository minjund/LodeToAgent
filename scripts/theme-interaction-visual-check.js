const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-theme-interaction-'));
app.setPath('userData', userData);

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(win, expression, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await wait(100);
  }
  throw new Error(message);
}

async function capture(win, outputDir, name) {
  const output = path.join(outputDir, `${name}.png`);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(output, image.toPNG());
  return output;
}

const DEEP_AUDIT_EXPRESSION = `(() => {
  const root = getComputedStyle(document.documentElement);
  const theme = document.documentElement.dataset.theme;
  const tokenNames = [
    '--theme-canvas', '--theme-sidebar', '--theme-surface', '--theme-surface-raised',
    '--theme-surface-subtle', '--theme-surface-muted', '--theme-surface-strong',
    '--theme-border-soft', '--theme-border', '--theme-border-strong',
    '--theme-text', '--theme-text-secondary', '--theme-text-muted',
    '--theme-accent', '--theme-accent-strong', '--theme-accent-soft', '--theme-accent-border',
    '--theme-accent-action', '--theme-on-accent',
    '--theme-success', '--theme-success-soft', '--theme-warning', '--theme-warning-soft',
    '--theme-danger', '--theme-danger-soft', '--theme-info', '--theme-info-soft',
    '--terminal-bg', '--terminal-surface', '--terminal-fg', '--terminal-muted',
  ];
  const tokens = Object.fromEntries(tokenNames.map(name => [name, root.getPropertyValue(name).trim()]));
  const parse = value => {
    const source = String(value || '').trim();
    const hex = source.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
      const raw = hex[1].length <= 4
        ? [...hex[1]].map(channel => channel + channel).join('')
        : hex[1];
      return {
        r: Number.parseInt(raw.slice(0, 2), 16),
        g: Number.parseInt(raw.slice(2, 4), 16),
        b: Number.parseInt(raw.slice(4, 6), 16),
        a: raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) / 255 : 1,
      };
    }
    const match = source.match(/^rgba?\\(([^)]+)\\)$/i);
    if (!match) return null;
    const channels = match[1].replace(/,/g, ' ').split(/[\\s/]+/).filter(Boolean).map(Number);
    if (channels.length < 3 || channels.slice(0, 3).some(channel => !Number.isFinite(channel))) return null;
    return { r: channels[0], g: channels[1], b: channels[2], a: Number.isFinite(channels[3]) ? channels[3] : 1 };
  };
  const linear = channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  };
  const luminance = color => .2126 * linear(color.r) + .7152 * linear(color.g) + .0722 * linear(color.b);
  const saturation = color => {
    const maximum = Math.max(color.r, color.g, color.b) / 255;
    const minimum = Math.min(color.r, color.g, color.b) / 255;
    const lightness = (maximum + minimum) / 2;
    if (maximum === minimum) return 0;
    return (maximum - minimum) / (1 - Math.abs(2 * lightness - 1));
  };
  const chroma = color => (Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b)) / 255;
  const visible = element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1 && rect.bottom > 0 && rect.right > 0
      && rect.top < innerHeight && rect.left < innerWidth
      && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > .02
      && !element.closest('[aria-hidden="true"], [inert], .hidden, details:not([open]), script, style');
  };
  const selector = element => {
    if (element.id) return '#' + CSS.escape(element.id);
    const classes = [...element.classList].filter(name => !/^(active|open|selected|hidden|expanded)$/.test(name)).slice(0, 3);
    const base = element.tagName.toLowerCase() + classes.map(name => '.' + CSS.escape(name)).join('');
    const parent = element.parentElement;
    if (!parent) return base;
    const siblings = [...parent.children].filter(item => item.tagName === element.tagName);
    return siblings.length > 1 ? base + ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')' : base;
  };
  const sameColor = (left, right) => left && right
    && Math.abs(left.r - right.r) <= 2
    && Math.abs(left.g - right.g) <= 2
    && Math.abs(left.b - right.b) <= 2;
  const semanticColors = [
    '--theme-accent-action', '--theme-success', '--theme-warning', '--theme-danger', '--theme-info',
  ].map(name => parse(tokens[name])).filter(Boolean);
  const exempt = (element, background) => Boolean(element.closest(
    '.xterm, .terminal-screen, .terminal-xterm, .provider-mark, .provider-mini-mark, '
    + '.provider-rail-mark, .modal-backdrop, .drawer-backdrop, [class*="status-"], '
    + '[class*="danger"], [class*="warning"], [class*="success"], [class*="error"]'
  )) || (semanticColors.some(color => sameColor(color, background)) && Boolean(element.closest(
    'button, [role="button"], [role="progressbar"], .update-progress-track, .provider-filter-check'
  )));
  const surfaces = [];
  const flags = [];
  const colorArea = new Map();
  for (const element of document.querySelectorAll('body *')) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const area = Math.round(Math.min(rect.width, innerWidth) * Math.min(rect.height, innerHeight));
    const background = parse(style.backgroundColor);
    const key = selector(element);
    if (background && background.a >= .08) {
      const lum = luminance(background);
      const sat = saturation(background);
      const colorChroma = chroma(background);
      colorArea.set(style.backgroundColor, (colorArea.get(style.backgroundColor) || 0) + area * background.a);
      if (area >= 240) {
        surfaces.push({ selector: key, tag: element.tagName, className: String(element.className || '').slice(0, 180), area, background: style.backgroundColor, backgroundImage: style.backgroundImage, luminance: Number(lum.toFixed(3)), saturation: Number(sat.toFixed(3)), border: style.borderColor, color: style.color });
      }
      if (!exempt(element, background) && area >= 1200 && background.a >= .72) {
        if (theme === 'light' && lum < .38) flags.push({ type: 'light-dark-island', selector: key, area, background: style.backgroundColor, luminance: Number(lum.toFixed(3)) });
        if (theme === 'dark' && lum > .72) flags.push({ type: 'dark-light-island', selector: key, area, background: style.backgroundColor, luminance: Number(lum.toFixed(3)) });
        if (area >= 12000 && colorChroma > .2 && !element.matches('[aria-selected="true"], [aria-pressed="true"], .active, .selected')) {
          flags.push({ type: 'large-chromatic-surface', selector: key, area, background: style.backgroundColor, chroma: Number(colorChroma.toFixed(3)), saturation: Number(sat.toFixed(3)) });
        }
      }
    }
  }
  return {
    theme,
    tokens,
    visibleElements: [...document.querySelectorAll('body *')].filter(visible).length,
    flags: flags.slice(0, 100),
    surfaces: surfaces.sort((a, b) => b.area - a.area).slice(0, 500),
    colorArea: [...colorArea.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([color, area]) => ({ color, area: Math.round(area) })),
  };
})()`;

async function setDesktop(win) {
  win.setBounds({ width: 1440, height: 900 }, false);
  await wait(160);
}

async function resetSurface(win) {
  await setDesktop(win);
  await win.webContents.executeJavaScript(`(() => {
    const app = window.LoadToAgentApp;
    try { app.closeDrawer(false); } catch {}
    try { app.closeRunModal(true); } catch {}
    try { app.closeQuickPalette(); } catch {}
    try { app.closeShortcutHelp(); } catch {}
    if (Array.isArray(app.state?.providers)) {
      app.state.availability = Object.fromEntries(app.state.providers.map(provider => [provider.id, true]));
    }
    try { window.interactionTest.restoreCurrentUpdate(); } catch {}
    try { window.interactionTest.clearControls(); } catch {}
    try { app.state.detailLoadingIds?.clear(); } catch {}
    document.querySelectorAll('details[open]').forEach(details => { details.open = false; });
    document.querySelectorAll('.toast').forEach(toast => toast.classList.add('hidden'));
    document.querySelector('#appErrorBanner')?.classList.add('hidden');
    document.body.classList.remove('dialog-open', 'terminal-focus-mode');
    return true;
  })()`);
  await wait(120);
}

const scenarios = [
  {
    label: 'project-selection',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        const app = window.LoadToAgentApp;
        app.state.workspace = 'all';
        app.selectView('all');
        app.render();
        document.querySelector('#beginnerGuide')?.classList.add('hidden');
        return true;
      })()`);
    },
    ready: `!document.querySelector('#projectSelectionPrompt')?.classList.contains('hidden')`,
  },
  {
    label: 'guide-expanded',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        const app = window.LoadToAgentApp;
        app.state.workspace = app.state.workspaces[0]?.path || 'all';
        app.state.guideExpanded = true;
        app.selectView('all');
        app.render();
        document.querySelector('#beginnerGuide')?.classList.remove('hidden');
        return true;
      })()`);
    },
    ready: `!document.querySelector('#beginnerGuide')?.classList.contains('hidden')`,
  },
  {
    label: 'advanced-navigation-open',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        const app = window.LoadToAgentApp;
        app.state.workspace = app.state.workspaces[0]?.path || 'all';
        app.selectView('all');
        app.render();
        document.querySelector('#beginnerGuide')?.classList.add('hidden');
        document.querySelector('#advancedToolsNav').open = true;
        return true;
      })()`);
    },
    ready: `document.querySelector('#advancedToolsNav')?.open === true`,
  },
  ...['summary', 'lifecycle', 'tokens'].map(tab => ({
    label: `drawer-${tab}`,
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.openDrawer('fixture-root', { tab: ${JSON.stringify(tab === 'summary' ? 'summary' : 'chat')} });
        document.querySelector(${JSON.stringify(`#drawerTab${tab[0].toUpperCase()}${tab.slice(1)}`)})?.click();
        return true;
      })()`);
    },
    ready: `document.querySelector('#detailDrawer')?.classList.contains('open') && window.LoadToAgentApp.state.drawerTab === ${JSON.stringify(tab)}`,
  })),
  {
    label: 'drawer-loading',
    open: async win => {
      await win.webContents.executeJavaScript(`void window.LoadToAgentApp.openDrawer('fixture-history-0', { tab: 'summary' })`);
      await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open') && Boolean(document.querySelector('#drawerContent'))`, '로딩 검사용 상세 창을 열지 못했습니다.');
      await wait(320);
      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('#drawerContent').innerHTML = '<div class="drawer-loading"><span></span><b>전체 기록을 불러오는 중입니다.</b><small>잠시만 기다려 주세요.</small></div>';
        return true;
      })()`);
    },
    ready: `Boolean(document.querySelector('.drawer-loading'))`,
  },
  {
    label: 'drawer-error',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        const app = window.LoadToAgentApp;
        app.state.details.delete('fixture-history-0');
        window.interactionTest.configure({ failures: { sessionDetail: 1 } });
        void app.openDrawer('fixture-history-0', { tab: 'summary' });
        return true;
      })()`);
    },
    ready: `Boolean(document.querySelector('.drawer-error'))`,
  },
  {
    label: 'drawer-conversation-menu',
    open: async win => {
      await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('fixture-root', { tab: 'chat' })`);
      await waitFor(win, `document.querySelector('#detailDrawer')?.classList.contains('open') && Boolean(document.querySelector('.agent-command-input'))`, '대화 입력창을 열지 못했습니다.');
      await win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('.agent-command-input');
        input.value = '/';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    },
    ready: `Boolean(document.querySelector('.conversation-slash-menu'))`,
  },
  {
    label: 'run-advanced',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.openRunModal();
        document.querySelector('.run-advanced').open = true;
        return true;
      })()`);
    },
    ready: `!document.querySelector('#runModal')?.classList.contains('hidden') && document.querySelector('.run-advanced')?.open === true`,
  },
  {
    label: 'run-provider-help',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        const app = window.LoadToAgentApp;
        app.openRunModal();
        app.state.availability = Object.fromEntries(app.state.providers.map(provider => [provider.id, false]));
        app.syncRunComposer();
        return true;
      })()`);
    },
    ready: `!document.querySelector('#runProviderHelp')?.classList.contains('hidden')`,
  },
  {
    label: 'run-permission-warning',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.openRunModal();
        const input = document.querySelector('#runPrompt');
        input.value = '코드를 수정하고 화면 색을 바꿔줘';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    },
    ready: `!document.querySelector('#runPermissionHint')?.classList.contains('hidden')`,
  },
  {
    label: 'control-room-search',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.selectView('all');
        document.querySelector('#controlRoomSearch')?.classList.add('is-open');
        const input = document.querySelector('#controlRoomSearchInput');
        input.value = '화면';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    },
    ready: `document.querySelector('#controlRoomSearch')?.classList.contains('is-open')`,
  },
  {
    label: 'terminal-session-tools',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.selectView('terminal');
        const details = document.querySelector('.terminal-session-tools');
        if (details) details.open = true;
        return true;
      })()`);
    },
    ready: `window.LoadToAgentApp.state.view === 'terminal' && document.querySelector('.terminal-session-tools')?.open === true`,
  },
  {
    label: 'terminal-conversation-menu',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        const app = window.LoadToAgentApp;
        app.selectView('terminal');
        document.querySelector('.terminal-session-item')?.click();
        return true;
      })()`);
      await waitFor(win, `Boolean(document.querySelector('#terminalCommandInput')) && !document.querySelector('#terminalCommandForm')?.classList.contains('hidden')`, '터미널 대화 입력창을 열지 못했습니다.');
      await win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('#terminalCommandInput');
        input.value = '/';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    },
    ready: `!document.querySelector('#terminalSlashMenu')?.classList.contains('hidden')`,
  },
  {
    label: 'terminal-history',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.selectView('terminal');
        return true;
      })()`);
      await waitFor(win, `window.LoadToAgentApp.state.view === 'terminal' && Boolean(document.querySelector('#terminalHistoryList'))`, '터미널 기록 영역을 열지 못했습니다.');
      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('#terminalHistoryPanel')?.classList.remove('hidden');
        document.querySelector('#terminalHistoryList').innerHTML = '<article class="terminal-history-message user"><header><b>나</b><time>방금</time></header><p>라이트와 다크 화면의 색 배합을 확인해줘.</p><div class="terminal-history-copy"><pre>theme interaction audit</pre></div></article><article class="terminal-history-message assistant"><header><b>Claude</b><time>방금</time></header><p>숨은 대화 기록 화면까지 같은 테마 토큰으로 확인하고 있습니다.</p></article>';
        return true;
      })()`);
    },
    ready: `!document.querySelector('#terminalHistoryPanel')?.classList.contains('hidden') && Boolean(document.querySelector('.terminal-history-message'))`,
  },
  {
    label: 'terminal-long-draft',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.selectView('terminal');
        document.querySelector('[data-terminal-id="terminal-main"]')?.click();
        const input = document.querySelector('#terminalCommandInput');
        input.value = '긴 작업 지시 '.repeat(650);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#terminalLongDraftToggle')?.click();
        return true;
      })()`);
    },
    ready: `!document.querySelector('#terminalLongDraftMeta')?.classList.contains('hidden')`,
  },
  {
    label: 'runtime-expanded-details',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.selectView('runtime');
        document.querySelectorAll('#automationOverview details').forEach(details => { details.open = true; });
        return true;
      })()`);
    },
    ready: `window.LoadToAgentApp.state.view === 'runtime' && [...document.querySelectorAll('#automationOverview details')].some(details => details.open)`,
  },
  {
    label: 'graph-execution-activity',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        const app = window.LoadToAgentApp;
        app.state.workspace = app.state.workspaces[0]?.path || 'all';
        app.selectView('all');
        app.render();
        document.querySelector('[data-graph-focus]')?.click();
        return true;
      })()`);
      await waitFor(win, `Boolean(document.querySelector('.execution-activity-panel'))`, '실행 활동 패널을 열지 못했습니다.');
      await win.webContents.executeJavaScript(`(() => {
        document.querySelectorAll('.execution-activity-card').forEach(card => { card.open = true; });
        document.querySelector('.execution-activity-panel')?.scrollIntoView({ block: 'center' });
        return true;
      })()`);
    },
    ready: `Boolean(document.querySelector('.execution-activity-panel'))`,
  },
  {
    label: 'tmux-control-tools',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.selectView('tmux');
        document.querySelector('[data-control-tmux="tmux-pane-id"]')?.click();
        return true;
      })()`);
    },
    ready: `window.LoadToAgentApp.state.view === 'tmux' && !document.querySelector('#terminalTmuxTools')?.classList.contains('hidden')`,
  },
  {
    label: 'settings-downloaded-update',
    open: async win => {
      await win.webContents.executeJavaScript(`(async () => {
        window.LoadToAgentApp.selectView('settings');
        await window.loadtoagent.downloadUpdate();
        return true;
      })()`);
    },
    ready: `document.querySelector('#updatePanel')?.dataset.updateStatus === 'downloaded'`,
  },
  {
    label: 'settings-update-error',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.selectView('settings');
        window.interactionTest.configure({ failures: { checkForUpdate: 1 } });
        document.querySelector('#checkUpdateBtn')?.click();
        return true;
      })()`);
    },
    ready: `document.querySelector('#updatePanel')?.dataset.updateStatus === 'error' && Boolean(document.querySelector('.update-error'))`,
  },
  {
    label: 'app-error',
    open: async win => {
      await win.webContents.executeJavaScript(`(() => {
        const app = window.LoadToAgentApp;
        app.state.workspace = app.state.workspaces[0]?.path || 'all';
        app.selectView('all');
        app.render();
        const panel = document.querySelector('#appErrorBanner');
        panel?.classList.remove('hidden');
        return true;
      })()`);
    },
    ready: `!document.querySelector('#appErrorBanner')?.classList.contains('hidden')`,
  },
  {
    label: 'mobile-tools',
    mobile: true,
    open: async win => {
      win.setBounds({ width: 390, height: 844 }, false);
      await wait(180);
      await win.webContents.executeJavaScript(`document.querySelector('#mobileMoreBtn')?.click()`);
    },
    ready: `!document.querySelector('#mobileToolsMenu')?.classList.contains('hidden')`,
  },
  {
    label: 'mobile-memory-filters',
    mobile: true,
    open: async win => {
      win.setBounds({ width: 390, height: 844 }, false);
      await wait(180);
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.selectView('active');
        const details = document.querySelector('.mobile-memory-filters');
        if (details) details.open = true;
        return true;
      })()`);
    },
    ready: `window.LoadToAgentApp.state.view === 'active' && document.querySelector('.mobile-memory-filters')?.open === true`,
  },
];

const requestedScenarioLabels = new Set(String(process.env.THEME_INTERACTION_SCENARIOS || '')
  .split(',').map(label => label.trim()).filter(Boolean));
const activeScenarios = requestedScenarioLabels.size
  ? scenarios.filter(scenario => requestedScenarioLabels.has(scenario.label))
  : scenarios;

function crossThemeFindings(report) {
  const byKey = new Map();
  for (const screen of report.screens) {
    const key = `${screen.label}:${screen.theme}`;
    byKey.set(key, new Map(screen.audit.surfaces.map(surface => [surface.selector, surface])));
  }
  const findings = [];
  for (const scenario of activeScenarios) {
    const dark = byKey.get(`${scenario.label}:dark`);
    const light = byKey.get(`${scenario.label}:light`);
    if (!dark || !light) continue;
    for (const [selector, lightSurface] of light) {
      const darkSurface = dark.get(selector);
      if (!darkSurface || lightSurface.area < 500 || darkSurface.area < 500) continue;
      if (lightSurface.background !== darkSurface.background) continue;
      if (/provider|status|danger|warning|success|error|xterm|terminal-screen/i.test(`${selector} ${lightSurface.className}`)) continue;
      const extreme = lightSurface.luminance < .48 || lightSurface.luminance > .72;
      if (!extreme) continue;
      findings.push({ label: scenario.label, selector, area: lightSurface.area, background: lightSurface.background, luminance: lightSurface.luminance });
    }
  }
  return findings;
}

app.whenReady().then(async () => {
  const outputDir = path.join(__dirname, '..', 'artifacts', 'theme-interactions');
  fs.mkdirSync(outputDir, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), screens: [], scenarioErrors: [] };
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    backgroundColor: '#050506',
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
    await waitFor(win, `Boolean(window.LoadToAgentApp?.initialized && window.LoadToAgentTheme)`, '심층 테마 검수용 앱 화면이 준비되지 않았습니다.');
    await win.webContents.executeJavaScript(`window.LoadToAgentI18n.setLocale('ko')`);

    for (const theme of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`window.LoadToAgentTheme.setTheme(${JSON.stringify(theme)})`);
      for (const scenario of activeScenarios) {
        try {
          await resetSurface(win);
          await scenario.open(win);
          await waitFor(win, scenario.ready, `${scenario.label} 상태를 열지 못했습니다.`);
          await wait(260);
          const file = await capture(win, outputDir, `${theme}-${scenario.label}`);
          const audit = await win.webContents.executeJavaScript(DEEP_AUDIT_EXPRESSION);
          report.screens.push({ theme, label: scenario.label, file, audit });
        } catch (error) {
          report.scenarioErrors.push({ theme, label: scenario.label, message: error?.message || String(error) });
        }
      }
    }

    report.crossThemeFindings = crossThemeFindings(report);
    report.failures = [
      ...report.scenarioErrors,
      ...report.screens.flatMap(screen => screen.audit.flags.map(flag => ({ theme: screen.theme, label: screen.label, ...flag }))),
      ...report.crossThemeFindings.map(finding => ({ type: 'unchanged-cross-theme-surface', ...finding })),
    ];
    const reportPath = path.join(outputDir, 'theme-interaction-audit.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`심층 테마 상호작용 검수 완료: ${report.screens.length}개 화면, ${report.failures.length}개 검토 항목`);
    console.log(reportPath);
    if (report.failures.length) process.exitCode = 1;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
}).catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
  app.quit();
});
