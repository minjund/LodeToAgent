'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtoagent-result-review-'));
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

function auditResultReview() {
  const surfaceSelectors = [
    '.management-result-review',
    '.management-progress',
    '.management-health',
    '.management-artifacts',
    '.management-checks',
    '.management-evidence',
    '.management-controls',
    '.management-attention-detail',
    '.management-outcome',
    '.agent-command-panel',
  ];
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const number = (value, percentageScale = 1) => {
    const input = String(value || '').trim();
    const parsed = Number.parseFloat(input);
    if (!Number.isFinite(parsed)) return null;
    return input.endsWith('%') ? parsed / 100 * percentageScale : parsed;
  };
  const parse = value => {
    const input = String(value || '').trim();
    const rgbMatch = input.match(/^rgba?\(([^)]+)\)$/i);
    const srgbMatch = input.match(/^color\(\s*srgb\s+([^)]+)\)$/i);
    const match = rgbMatch || srgbMatch;
    if (!match) return null;
    const values = match[1].replace(/,/g, ' ').split(/[\s/]+/).filter(Boolean);
    if (values.length < 3) return null;
    const srgb = Boolean(srgbMatch);
    const scale = srgb ? 1 : 255;
    const red = number(values[0], scale);
    const green = number(values[1], scale);
    const blue = number(values[2], scale);
    const alpha = values.length > 3 ? number(values[3], 1) : 1;
    if ([red, green, blue, alpha].some(channel => channel === null)) return null;
    return {
      r: clamp(srgb ? red * 255 : red, 0, 255),
      g: clamp(srgb ? green * 255 : green, 0, 255),
      b: clamp(srgb ? blue * 255 : blue, 0, 255),
      a: clamp(alpha, 0, 1),
    };
  };
  const composite = (foreground, background) => {
    const alpha = foreground.a + background.a * (1 - foreground.a);
    if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
      g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
      b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
      a: alpha,
    };
  };
  const effectiveBackground = element => {
    const layers = [];
    let current = element;
    while (current) {
      const color = parse(getComputedStyle(current).backgroundColor);
      if (color && color.a > .001) {
        layers.push(color);
        if (color.a >= .999) break;
      }
      current = current.parentElement;
    }
    let background = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      background = composite(layers[index], background);
    }
    return background;
  };
  const linear = channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  };
  const luminance = color => .2126 * linear(color.r) + .7152 * linear(color.g) + .0722 * linear(color.b);
  const contrast = (foreground, background) => {
    const first = luminance(foreground);
    const second = luminance(background);
    return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
  };
  const identity = element => [
    element.id && '#' + element.id,
    ...[...element.classList].slice(0, 3).map(name => '.' + name),
  ].filter(Boolean).join('') || element.tagName.toLowerCase();
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width >= 2 && rect.height >= 2 && style.display !== 'none'
      && style.visibility !== 'hidden' && Number(style.opacity) >= .55;
  };
  const root = document.querySelector('.management-detail');
  if (!root) {
    return {
      theme: document.documentElement.dataset.theme,
      missingRoot: true,
      missingSurfaces: surfaceSelectors,
      surfaces: [],
      surfaceMismatches: [],
      text: { total: 0, minimumContrast: 0, lowContrast: [] },
    };
  }
  const surfaces = [...root.querySelectorAll(surfaceSelectors.join(','))]
    .filter(visible)
    .map(element => {
      const style = getComputedStyle(element);
      const background = effectiveBackground(element);
      const backgroundLuminance = luminance(background);
      return {
        selector: identity(element),
        background: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        effectiveBackground: 'rgb(' + background.r.toFixed(1) + ', ' + background.g.toFixed(1) + ', ' + background.b.toFixed(1) + ')',
        luminance: Number(backgroundLuminance.toFixed(3)),
      };
    });
  const theme = document.documentElement.dataset.theme;
  const surfaceMismatches = surfaces.filter(surface => (
    (theme === 'light' && surface.luminance < .55)
    || (theme === 'dark' && surface.luminance > .45)
  ));
  const textResults = [root, ...root.querySelectorAll('*')].flatMap(element => {
    if (!visible(element) || element.closest('[aria-hidden="true"], [inert], .hidden, .sr-only, .visually-hidden, script, style')) {
      return [];
    }
    const text = [...element.childNodes]
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => String(node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
    if (text.length < 2) return [];
    const style = getComputedStyle(element);
    const foreground = parse(style.color);
    if (!foreground || foreground.a < .75) return [];
    const background = effectiveBackground(element);
    const paintedForeground = foreground.a < .999 ? composite(foreground, background) : foreground;
    const ratio = contrast(paintedForeground, background);
    const fontSize = Number.parseFloat(style.fontSize) || 0;
    const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
    const required = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
    return [{
      selector: identity(element),
      text: text.slice(0, 100),
      foreground: style.color,
      background: 'rgb(' + background.r.toFixed(1) + ', ' + background.g.toFixed(1) + ', ' + background.b.toFixed(1) + ')',
      contrast: Number(ratio.toFixed(2)),
      required,
    }];
  });
  return {
    theme,
    missingRoot: false,
    missingSurfaces: surfaceSelectors.filter(selector => !root.querySelector(selector)),
    surfaces,
    surfaceMismatches,
    text: {
      total: textResults.length,
      minimumContrast: textResults.length ? Math.min(...textResults.map(result => result.contrast)) : 0,
      lowContrast: textResults.filter(result => result.contrast + .02 < result.required),
    },
  };
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
    await waitFor(win, 'Boolean(window.LoadToAgentApp?.initialized)', '앱 초기화를 기다리다 시간이 초과되었습니다.');
    await win.webContents.executeJavaScript(`(() => {
      const control = window.LoadToAgentApp;
      window.LoadToAgentI18n.setLocale('ko');
      control.state.workspace = 'D:\\\\fixture';
      control.state.providerFilters.clear();
      control.state.search = '';
      control.selectView('all');
      control.render();
    })()`);
    await waitFor(
      win,
      `!document.querySelector('#operationsOverview')?.classList.contains('hidden')
        && Boolean(document.querySelector('.home-attention-item[data-open-session="fixture-failed"][data-result-review]'))
        && getComputedStyle(document.querySelector('.control-project-body .control-session-live')).display === 'none'
        && Boolean(window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === 'fixture-failed'))`,
      '프로젝트 홈에서 확인이 필요한 결과를 찾지 못했습니다.',
    );
    const before = await win.webContents.executeJavaScript(`(() => {
      const session = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === 'fixture-failed');
      const reviewItem = document.querySelector('.home-attention-item[data-open-session="fixture-failed"][data-result-review]');
      const reviewBounds = reviewItem?.getBoundingClientRect();
      return {
        id: session?.id || '',
        reviewNeeded: window.LoadToAgentApp.needsManagementReview(session),
        resultReviewVisible: Boolean(reviewBounds && reviewBounds.width > 0 && reviewBounds.height > 0),
        duplicateProgressRemoved: getComputedStyle(document.querySelector('.control-project-body .control-session-live')).display === 'none',
      };
    })()`);
    if (!before.id || !before.reviewNeeded || !before.resultReviewVisible || !before.duplicateProgressRemoved) {
      throw new Error(`프로젝트 결과 상태가 올바르지 않습니다: ${JSON.stringify(before)}`);
    }

    await win.webContents.executeJavaScript(`window.LoadToAgentApp.openDrawer('${before.id}', { tab: 'summary' })`);
    await waitFor(
      win,
      `document.querySelector('#detailDrawer')?.classList.contains('open')
        && window.LoadToAgentApp.state.drawerTab === 'summary'
        && Boolean(document.querySelector('[data-result-review-complete]'))`,
      '결과 카드가 확인 완료 버튼이 있는 결과 화면을 열지 못했습니다.',
    );
    const drawer = await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-result-review-complete]');
      const bounds = button?.getBoundingClientRect();
      return {
        id: button?.dataset.resultReviewComplete || '',
        label: button?.textContent.trim() || '',
        visible: Boolean(bounds && bounds.width > 0 && bounds.height > 0),
      };
    })()`);
    if (drawer.id !== before.id || drawer.label !== '확인 완료' || !drawer.visible) {
      throw new Error(`결과 확인 버튼이 올바르지 않습니다: ${JSON.stringify(drawer)}`);
    }
    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });
    const output = path.join(outputDir, 'loadtoagent-result-review.png');
    const outputs = {};
    const themeAudits = {};
    win.show();
    for (const theme of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`window.LoadToAgentTheme.setTheme(${JSON.stringify(theme)})`);
      await waitFor(
        win,
        `document.documentElement.dataset.theme === ${JSON.stringify(theme)}
          && document.querySelector('#detailDrawer')?.classList.contains('open')
          && window.LoadToAgentApp.state.drawerTab === 'summary'
          && Boolean(document.querySelector('[data-result-review-complete="${before.id}"]'))`,
        `${theme} 테마의 결과 검토 화면이 준비되지 않았습니다.`,
      );
      const audit = await win.webContents.executeJavaScript(`(${auditResultReview.toString()})()`);
      themeAudits[theme] = audit;
      if (
        audit.theme !== theme
        || audit.missingRoot
        || audit.missingSurfaces.length
        || audit.surfaceMismatches.length
        || !audit.text.total
        || audit.text.lowContrast.length
      ) {
        throw new Error(`${theme} 테마 결과 검토 대비 검증 실패: ${JSON.stringify(audit, null, 2)}`);
      }
      outputs[theme] = await capture(
        win,
        path.join(outputDir, `loadtoagent-result-review-${theme}.png`),
      );
    }
    fs.copyFileSync(outputs.light, output);

    await win.webContents.executeJavaScript(`document.querySelector('[data-result-review-complete]').click()`);
    await waitFor(
      win,
      `!document.querySelector('#detailDrawer')?.classList.contains('open')
        && window.LoadToAgentApp.isResultReviewComplete(
          window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === '${before.id}')
        )
        && !window.LoadToAgentApp.needsManagementReview(
          window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === '${before.id}')
        )
        && !document.querySelector('.home-attention-item[data-open-session="${before.id}"][data-result-review]')
        && Boolean(localStorage.getItem(window.LoadToAgentApp.RESULT_REVIEW_STORAGE_KEY))`,
      '확인 완료한 결과가 저장되거나 목록에서 제거되지 않았습니다.',
    );

    await win.webContents.executeJavaScript(`(() => {
      const control = window.LoadToAgentApp;
      const session = control.state.snapshot.sessions.find(item => item.id === '${before.id}');
      const nextAt = new Date(Date.parse(session.updatedAt || 0) + 60_000).toISOString();
      session.updatedAt = nextAt;
      session.completedAt = nextAt;
      session.outcome = { ...session.outcome, completedAt: nextAt, summary: (session.outcome?.summary || '') + ' · 새 결과' };
      control.render();
    })()`);
    await waitFor(
      win,
      `Boolean(document.querySelector('.home-attention-item[data-open-session="${before.id}"][data-result-review]'))
        && !window.LoadToAgentApp.isResultReviewComplete(
          window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === '${before.id}')
        )
        && window.LoadToAgentApp.needsManagementReview(
          window.LoadToAgentApp.state.snapshot.sessions.find(session => session.id === '${before.id}')
        )`,
      '같은 세션의 새 결과가 다시 확인 목록에 나타나지 않았습니다.',
    );

    process.stdout.write(`결과 확인 완료 UI 검증 통과\n${JSON.stringify({ before, drawer, themeAudits, newResultReturned: true }, null, 2)}\n${Object.values(outputs).join('\n')}\n${output}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
