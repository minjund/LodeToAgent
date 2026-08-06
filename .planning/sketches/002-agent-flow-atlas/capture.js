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
      htmlUrl = `http://127.0.0.1:${server.address().port}/.planning/sketches/002-agent-flow-atlas/index.html`;
      resolve();
    });
  });
}

async function capture(variant, filename, width = 1600, height = 1000) {
  if (!captureWindow) {
    captureWindow = new BrowserWindow({ width, height, show: false, backgroundColor: "#070811" });
    await captureWindow.loadURL(htmlUrl);
  }
  captureWindow.setSize(width, height);
  const state = await captureWindow.webContents.executeJavaScript(`
    document.querySelector('[data-variant="${variant}"]').click();
    document.querySelectorAll('.variant-tab').forEach(tab => tab.blur());
    window.scrollTo(0, 0);
    ({
      activeTab: document.querySelector('.variant-tab.active')?.dataset.variant,
      activeVariant: document.querySelector('.variant.active')?.id
    });
  `);
  if (state.activeTab !== variant || state.activeVariant !== `variant-${variant}`) {
    throw new Error(`Variant switch failed: ${JSON.stringify(state)}`);
  }
  await new Promise(resolve => setTimeout(resolve, 350));
  const image = await captureWindow.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, filename), image.toPNG());
}

async function verifyInteractions() {
  captureWindow.setSize(1280, 900);
  const result = await captureWindow.webContents.executeJavaScript(`
    document.querySelector('[data-variant="a"]').click();
    document.querySelector('[data-node="visualtest"]').click();
    const drawerOpened = document.getElementById('detailDrawer').classList.contains('open');
    const shellDetailLoaded = document.getElementById('drawerTitle').textContent.includes('test:visual');
    const search = document.querySelector('#variant-a .global-search');
    search.value = 'PowerShell';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const filteredCount = document.querySelectorAll('#variant-a [data-search].hidden').length;
    document.querySelector('#variant-a [data-simulate]').click();
    const simulationChanged = document.body.dataset.simulation !== 'live';
    document.getElementById('themeSwitcher').value = 'quiet-light';
    document.getElementById('themeSwitcher').dispatchEvent(new Event('change', { bubbles: true }));
    const themeChanged = document.getElementById('theme-link').href.includes('quiet-light.css');
    ({ drawerOpened, shellDetailLoaded, filteredCount, simulationChanged, themeChanged });
  `);
  if (!result.drawerOpened || !result.shellDetailLoaded || result.filteredCount < 1 || !result.simulationChanged || !result.themeChanged) {
    throw new Error(`Interaction verification failed: ${JSON.stringify(result)}`);
  }
}

app.whenReady().then(async () => {
  await startServer();
  await capture("a", "variant-a-causal-spine.png");
  await capture("b", "variant-b-flow-ledger.png");
  await capture("c", "variant-c-temporal-lanes.png");
  await capture("a", "variant-a-mobile.png", 390, 844);
  await verifyInteractions();
  captureWindow.destroy();
  server.close();
  app.quit();
}).catch(error => {
  console.error(error);
  if (server) server.close();
  app.exit(1);
});
