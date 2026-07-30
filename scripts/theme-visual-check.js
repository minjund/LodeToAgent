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
    const themeMismatch = !terminal && (
      (theme === 'light' && backgroundLuminance < .16)
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
    };
  });
  return {
    theme,
    total: results.length,
    themeMismatches: results.filter(result => result.themeMismatch),
    lowContrast: results.filter(result => result.lowContrast),
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
    if (audit.themeMismatches.length || audit.lowContrast.length) {
      report.failures.push({ theme, label, ...audit });
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
        && document.querySelector('[data-theme-choice="light"]')?.getAttribute('aria-checked') === 'true'
        && document.querySelector('#themeToggleBtn')?.getAttribute('aria-pressed') === 'true'`,
      '저장한 라이트 모드가 앱 재실행 상태에서 복원되지 않았습니다.',
    );
    report.persistence = {
      restoredTheme: await win.webContents.executeJavaScript('document.documentElement.dataset.theme'),
      lightChoiceChecked: await win.webContents.executeJavaScript(`document.querySelector('[data-theme-choice="light"]')?.getAttribute('aria-checked')`),
      topTogglePressed: await win.webContents.executeJavaScript(`document.querySelector('#themeToggleBtn')?.getAttribute('aria-pressed')`),
    };

    const reportPath = path.join(outputDir, 'theme-audit.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (report.failures.length) {
      throw new Error(`테마 버튼 색상 검수 실패: ${JSON.stringify(report.failures, null, 2)}`);
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
