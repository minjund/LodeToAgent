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
      htmlUrl = `http://127.0.0.1:${server.address().port}/.planning/sketches/005-project-first-workspace/index.html`;
      resolve();
    });
  });
}

async function createWindow(width, height) {
  if (captureWindow) {
    captureWindow.setSize(width, height);
    await captureWindow.webContents.executeJavaScript(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    );
    await new Promise(resolve => setTimeout(resolve, 350));
    return;
  }
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
  await captureWindow.webContents.executeJavaScript(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
  );
  await new Promise(resolve => setTimeout(resolve, 350));
}

async function selectLayout(layout) {
  await captureWindow.webContents.executeJavaScript(`
    showLayout("${layout}");
    document.querySelectorAll('button').forEach(button => button.blur());
  `);
  await settle();
}

async function settle() {
  await captureWindow.webContents.executeJavaScript(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
  );
  captureWindow.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 450));
}

async function capture(filename) {
  await settle();
  const image = await captureWindow.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, filename), image.toPNG());
}

async function verify() {
  const result = await captureWindow.webContents.executeJavaScript(`
    (() => {
      const cms = [...document.querySelectorAll('.project-item')].find(item => item.dataset.project === 'CMS Web');
      cms.click();
      const switched = document.querySelector('[data-project-name]').textContent === 'CMS Web';

      document.querySelector('[data-open-session]').click();
      const modalOpened = document.getElementById('sessionModal').classList.contains('open');
      document.getElementById('cancelSession').click();

      document.querySelector('[data-open-drawer]').click();
      const drawerOpened = document.getElementById('drawerBackdrop').classList.contains('open');
      document.getElementById('closeDrawer').click();

      return {
        switched,
        modalOpened,
        drawerOpened,
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth
      };
    })()
  `);
  if (!result.switched || !result.modalOpened || !result.drawerOpened || result.scrollWidth > result.width + 1) {
    throw new Error(`Interaction verification failed: ${JSON.stringify(result)}`);
  }
}

app.whenReady().then(async () => {
  await startServer();
  await createWindow(1600, 1000);
  await selectLayout("a");
  await capture("project-first-overview.png");

  await captureWindow.webContents.executeJavaScript(`
    selectProject([...document.querySelectorAll('.project-item')].find(item => item.dataset.project === 'CMS Web'));
    openSessionModal();
  `);
  await capture("project-add-session.png");
  await captureWindow.webContents.executeJavaScript(`closeSessionModal()`);
  await settle();

  await selectLayout("b");
  await capture("project-timeline.png");
  await selectLayout("c");
  await capture("project-session-board.png");

  await createWindow(390, 844);
  await selectLayout("a");
  await capture("project-first-mobile.png");
  await verify();

  captureWindow.destroy();
  server.close();
  app.quit();
}).catch(error => {
  console.error(error);
  if (server) server.close();
  app.exit(1);
});
