const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
let server;
let captureWindow;
let htmlUrl;

app.setPath("userData", path.join(os.tmpdir(), `loadtoagent-sketch-006-${process.pid}`));
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const requested = path.resolve(workspaceRoot, `.${pathname}`);
      if (!requested.startsWith(workspaceRoot) || !fs.existsSync(requested)) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2" };
      response.writeHead(200, { "Content-Type": types[path.extname(requested)] || "application/octet-stream" });
      fs.createReadStream(requested).pipe(response);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      htmlUrl = `http://127.0.0.1:${server.address().port}/.planning/sketches/006-terminal-first-agent-session/index.html`;
      resolve();
    });
  });
}

async function selectVariant(variant, width = 1480, height = 940) {
  if (!captureWindow) {
    captureWindow = new BrowserWindow({ width, height, show: false, backgroundColor: "#05060b", webPreferences: { backgroundThrottling: false } });
    await captureWindow.loadURL(htmlUrl);
  }
  captureWindow.setSize(width, height);
  const state = await captureWindow.webContents.executeJavaScript(`
    document.querySelector('[data-variant-choice="${variant}"]').click();
    document.querySelector('[data-viewport-choice="full"]').click();
    document.body.classList.remove('split-terminal', 'insights-collapsed');
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      variant: document.body.dataset.variant,
      active: document.querySelector('[data-variant-choice].active')?.dataset.variantChoice
    }))));
  `);
  if (state.variant !== variant || state.active !== variant) throw new Error(`Variant switch failed: ${JSON.stringify(state)}`);
  await new Promise(resolve => setTimeout(resolve, 650));
  await captureWindow.webContents.capturePage();
  await new Promise(resolve => setTimeout(resolve, 120));
}

async function capture(filename) {
  captureWindow.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 120));
  const image = await captureWindow.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, filename), image.toPNG());
}

async function verify() {
  const result = await captureWindow.webContents.executeJavaScript(`
    document.querySelector('[data-variant-choice="b"]').click();
    const variantB = document.body.dataset.variant === 'b';
    document.querySelector('[data-session="message-delay"]').click();
    const sessionChanged = document.getElementById('liveState').textContent === '입력 필요';
    const input = document.getElementById('terminalInput');
    input.value = '이 입력은 같은 PTY로 보내줘';
    document.getElementById('terminalForm').requestSubmit();
    const promptAppended = document.getElementById('terminalScroll').textContent.includes('이 입력은 같은 PTY로 보내줘');
    document.getElementById('splitButton').click();
    const split = document.body.classList.contains('split-terminal');
    document.querySelector('[data-variant-choice="c"]').click();
    document.querySelector('[data-insight-tab="activity"]').click();
    const projection = document.getElementById('insightContent').textContent.includes('터미널에서 감지된 실행 이벤트');
    ({ variantB, sessionChanged, promptAppended, split, projection });
  `);
  if (Object.values(result).some(value => !value)) throw new Error(`Interaction verification failed: ${JSON.stringify(result)}`);

  captureWindow.setSize(390, 844);
  await captureWindow.reload();
  await new Promise(resolve => setTimeout(resolve, 300));
  const mobile = await captureWindow.webContents.executeJavaScript(`(() => {
    const terminal = document.querySelector('.terminal-pane').getBoundingClientRect();
    const workspace = document.querySelector('.terminal-workspace').getBoundingClientRect();
    const frame = document.querySelector('.preview-frame').getBoundingClientRect();
    const shell = document.querySelector('.app-shell');
    const shellRect = shell.getBoundingClientRect();
    const shellStyle = getComputedStyle(shell);
    return {
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      variant: document.body.dataset.variant,
      terminalWidth: Math.round(terminal.width),
      workspaceWidth: Math.round(workspace.width),
      frameWidth: Math.round(frame.width),
      shellWidth: Math.round(shellRect.width),
      gridColumns: shellStyle.gridTemplateColumns,
      globalRail: shellStyle.getPropertyValue('--global-rail'),
      sessionRail: shellStyle.getPropertyValue('--session-rail'),
      insightWidth: shellStyle.getPropertyValue('--insight-width'),
      terminalDisplay: getComputedStyle(document.querySelector('.terminal-pane')).display,
      terminalVisible: workspace.width > 200
    };
  })()`);
  if (mobile.scrollWidth > mobile.innerWidth || !mobile.terminalVisible) throw new Error(`Mobile verification failed: ${JSON.stringify(mobile)}`);
}

app.whenReady().then(async () => {
  await startServer();
  await selectVariant("a");
  await capture("variant-a-pure-terminal.png");
  await selectVariant("b");
  await capture("variant-b-session-rail.png");
  await selectVariant("c");
  await capture("variant-c-conversation-projection.png");
  await verify();
  await capture("terminal-first-mobile.png");
  captureWindow.destroy();
  server.close();
  app.quit();
}).catch(error => {
  console.error(error);
  if (server) server.close();
  app.exit(1);
});
