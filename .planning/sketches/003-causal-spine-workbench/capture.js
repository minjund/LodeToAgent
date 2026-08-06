const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");

const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
let server;
let captureWindow;
let htmlUrl;

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
      const types = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".woff2": "font/woff2"
      };
      response.writeHead(200, { "Content-Type": types[path.extname(requested)] || "application/octet-stream" });
      fs.createReadStream(requested).pipe(response);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      htmlUrl = `http://127.0.0.1:${server.address().port}/.planning/sketches/003-causal-spine-workbench/index.html`;
      resolve();
    });
  });
}

async function ensureWindow(width, height) {
  if (!captureWindow) {
    captureWindow = new BrowserWindow({
      width,
      height,
      show: false,
      backgroundColor: "#070811",
      webPreferences: { backgroundThrottling: false }
    });
    captureWindow.webContents.on("console-message", (_event, level, message) => {
      if (level >= 2) console.error(`renderer: ${message}`);
    });
    await captureWindow.loadURL(htmlUrl);
  }
  captureWindow.setSize(width, height);
}

async function selectState(layout, view, extraScript = "", width = 1600, height = 1000) {
  await ensureWindow(width, height);
  await captureWindow.webContents.executeJavaScript(`closeDock();`);
  await new Promise(resolve => setTimeout(resolve, 280));
  const state = await captureWindow.webContents.executeJavaScript(`
    document.querySelector('[data-layout-choice="${layout}"]').click();
    document.querySelector('[data-view="${view}"]')?.click();
    document.querySelectorAll('.variant-tab, .nav-btn').forEach(button => button.blur());
    ${extraScript}
    ({
      layout: document.body.dataset.layout,
      view: document.querySelector('[data-view-panel].active')?.dataset.viewPanel,
      activeTab: document.querySelector('[data-layout-choice].active')?.dataset.layoutChoice,
      dockOpen: document.getElementById('contextDock').classList.contains('open')
    });
  `);
  const expectsDock = extraScript.includes("data-node");
  if (state.layout !== layout || state.view !== view || state.activeTab !== layout || state.dockOpen !== expectsDock) {
    throw new Error(`State switch failed: ${JSON.stringify(state)}`);
  }
  await captureWindow.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await new Promise(resolve => setTimeout(resolve, 650));
}

async function capture(filename) {
  const image = await captureWindow.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, filename), image.toPNG());
}

async function verifyInteractions() {
  await selectState("a", "flow", "", 1280, 900);
  const result = await captureWindow.webContents.executeJavaScript(`
    document.querySelector('[data-node="visualtest"]').click();
    document.querySelector('[data-dock-tab="evidence"]').click();
    const dockOpened = document.getElementById('contextDock').classList.contains('open');
    const evidenceVisible = document.getElementById('dockContent').textContent.includes('npm run test:visual');

    document.querySelector('[data-view="terminal"]').click();
    const terminalInput = document.getElementById('terminalCommand');
    terminalInput.value = 'npm test';
    document.getElementById('terminalCommandForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const terminalSent = document.getElementById('terminalOutput').textContent.includes('PS> npm test');

    document.querySelector('[data-view="tmux"]').click();
    const beforePanes = document.querySelectorAll('[data-pane]').length;
    document.querySelector('[data-tmux-action="split-h"]').click();
    const paneAdded = document.querySelectorAll('[data-pane]').length === beforePanes + 1;

    document.querySelector('[data-view="review"]').click();
    const beforeReview = document.getElementById('reviewCount').textContent;
    document.querySelector('[data-review-action="approve"]').click();
    const reviewResolved = Number(document.getElementById('reviewCount').textContent) === Number(beforeReview) - 1;

    document.querySelector('[data-open-run]').click();
    document.getElementById('runPrompt').value = '새 작업 검증';
    document.getElementById('runForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const runClosed = document.getElementById('runModal').classList.contains('hidden');

    ({ dockOpened, evidenceVisible, terminalSent, paneAdded, reviewResolved, runClosed });
  `);
  if (Object.values(result).some(value => !value)) {
    throw new Error(`Interaction verification failed: ${JSON.stringify(result)}`);
  }

  await selectState("a", "flow", "", 390, 844);
  const mobile = await captureWindow.webContents.executeJavaScript(`({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mobileMoreVisible: getComputedStyle(document.querySelector('[data-mobile-more]')).display !== 'none',
    offenders: [...document.querySelectorAll('body *')].map(element => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName, id: element.id, className: String(element.className || '').slice(0, 80), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    }).filter(item => item.right > window.innerWidth + 2 || item.left < -2).sort((a, b) => b.right - a.right).slice(0, 12)
  })`);
  if (mobile.scrollWidth > mobile.innerWidth || !mobile.mobileMoreVisible) {
    throw new Error(`Mobile verification failed: ${JSON.stringify(mobile)}`);
  }
}

app.whenReady().then(async () => {
  await startServer();
  await selectState("a", "flow");
  await capture("variant-a-full-flow.png");
  await capture("multi-session-overview.png");

  await selectState("a", "flow", `document.querySelector('[data-node="visualtest"]').click();`);
  await capture("variant-a-execution-dock.png");

  await selectState("a", "terminal");
  await capture("variant-a-terminal-workbench.png");

  await selectState("b", "review");
  await capture("variant-b-bottom-deck.png");

  await selectState("c", "settings");
  await capture("variant-c-split-operations.png");

  await selectState("a", "flow", "", 390, 844);
  await capture("variant-a-mobile.png");

  await verifyInteractions();
  captureWindow.destroy();
  server.close();
  app.quit();
}).catch(error => {
  console.error(error);
  if (server) server.close();
  app.exit(1);
});
