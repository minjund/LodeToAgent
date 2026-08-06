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
      const type = path.extname(requested) === ".css" ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
      response.writeHead(200, { "Content-Type": type });
      fs.createReadStream(requested).pipe(response);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      htmlUrl = `http://127.0.0.1:${server.address().port}/.planning/sketches/004-intent-lineage/index.html`;
      resolve();
    });
  });
}

async function setViewport(width, height) {
  if (!captureWindow) {
    captureWindow = new BrowserWindow({
      width,
      height,
      show: false,
      backgroundColor: "#070811",
      webPreferences: { backgroundThrottling: false }
    });
    await captureWindow.loadURL(htmlUrl);
  } else {
    captureWindow.setSize(width, height);
  }
  await new Promise(resolve => setTimeout(resolve, 300));
}

async function selectVariant(choice, width = 1600, height = 1000) {
  await setViewport(width, height);
  await captureWindow.webContents.executeJavaScript(`
    document.querySelector('[data-variant-choice="${choice}"]').click();
    document.querySelectorAll('button').forEach(button => button.blur());
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  `);
  await new Promise(resolve => setTimeout(resolve, 450));
  const state = await captureWindow.webContents.executeJavaScript(`({
    activeTab: document.querySelector('[data-variant-choice].active')?.dataset.variantChoice,
    activePanel: document.querySelector('[data-variant-panel].active')?.dataset.variantPanel,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  })`);
  if (state.activeTab !== choice || state.activePanel !== choice || state.scrollWidth > state.innerWidth) {
    throw new Error(`Invalid render state: ${JSON.stringify(state)}`);
  }
}

async function capture(filename) {
  const image = await captureWindow.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, filename), image.toPNG());
}

async function selectMemory(width = 1600, height = 1000) {
  await setViewport(width, height);
  const state = await captureWindow.webContents.executeJavaScript(`
    document.querySelector('[data-space-choice="memory"]').click();
    document.querySelectorAll('button').forEach(button => button.blur());
    ({
      memoryActive: document.getElementById('memoryScreen').classList.contains('active'),
      activeSpace: document.querySelector('[data-space-choice].active')?.dataset.spaceChoice,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    });
  `);
  if (!state.memoryActive || state.activeSpace !== "memory" || state.scrollWidth > state.innerWidth) {
    throw new Error(`Invalid memory state: ${JSON.stringify(state)}`);
  }
  await captureWindow.webContents.executeJavaScript(`
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  `);
  captureWindow.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 450));
}

app.whenReady().then(async () => {
  await startServer();
  await selectVariant("a");
  await capture("variant-a-intent-lineage.png");

  await selectMemory();
  await capture("memory-causal-archive.png");

  await selectVariant("a");
  await captureWindow.webContents.executeJavaScript(`document.querySelector('[data-detail="shell"]').click();`);
  await new Promise(resolve => setTimeout(resolve, 350));
  const drawerOpen = await captureWindow.webContents.executeJavaScript(`document.getElementById('detailDrawer').classList.contains('open')`);
  if (!drawerOpen) throw new Error("Detail drawer did not open");
  await capture("variant-a-causal-detail.png");

  await selectVariant("b");
  await capture("variant-b-agent-constellation.png");

  await selectVariant("c");
  await capture("variant-c-causal-ledger.png");

  await selectVariant("a", 390, 844);
  await capture("variant-a-mobile.png");

  await selectMemory(390, 844);

  captureWindow.destroy();
  server.close();
  app.quit();
}).catch(error => {
  console.error(error);
  if (server) server.close();
  app.exit(1);
});
