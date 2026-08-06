const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
let server;
let captureWindow;
let htmlUrl;

app.setPath("userData", path.join(os.tmpdir(), `loadtoagent-sketch-007-${process.pid}`));
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
      htmlUrl = `http://127.0.0.1:${server.address().port}/.planning/sketches/007-project-to-terminal-story/index.html`;
      resolve();
    });
  });
}

async function ensureWindow(width = 1540, height = 980) {
  if (captureWindow) return;
  captureWindow = new BrowserWindow({ width, height, show: false, backgroundColor: "#05060b", webPreferences: { backgroundThrottling: false } });
  await captureWindow.loadURL(htmlUrl);
}

async function selectScene(scene, width = 1540, height = 980) {
  await ensureWindow(width, height);
  captureWindow.setSize(width, height);
  const state = await captureWindow.webContents.executeJavaScript(`
    document.querySelector('[data-scene-choice="${scene}"]').click();
    document.querySelector('[data-presentation-choice="story"]').click();
    document.querySelector('[data-viewport-choice="full"]').click();
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      scene: document.body.dataset.scene,
      active: document.querySelector('[data-scene-choice].active')?.dataset.sceneChoice
    }))));
  `);
  if (state.scene !== scene || state.active !== scene) throw new Error(`Scene switch failed: ${JSON.stringify(state)}`);
  await new Promise(resolve => setTimeout(resolve, 500));
  await captureWindow.webContents.capturePage();
  await new Promise(resolve => setTimeout(resolve, 100));
}

async function capture(filename) {
  captureWindow.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 100));
  const image = await captureWindow.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, filename), image.toPNG());
}

async function verifyInteractions() {
  await captureWindow.reload();
  await new Promise(resolve => setTimeout(resolve, 300));
  const result = await captureWindow.webContents.executeJavaScript(`
    document.getElementById('lodestarProject').click();
    const projectOpened = document.body.dataset.scene === 'project';
    document.getElementById('terminalUiSession').click();
    const sessionOpened = document.body.dataset.scene === 'session';
    document.querySelector('[data-scene-choice="attention"]').click();
    const input = document.getElementById('terminalInput');
    input.value = '1번으로 진행해줘';
    document.getElementById('terminalForm').requestSubmit();
    const resumed = document.body.dataset.scene === 'session';
    const replyWritten = document.getElementById('terminalScroll').textContent.includes('1번으로 진행해줘');
    ({ projectOpened, sessionOpened, resumed, replyWritten });
  `);
  if (Object.values(result).some(value => !value)) throw new Error(`Interaction verification failed: ${JSON.stringify(result)}`);

  captureWindow.setSize(390, 844);
  await captureWindow.reload();
  await new Promise(resolve => setTimeout(resolve, 300));
  await captureWindow.webContents.executeJavaScript(`document.querySelector('[data-scene-choice="session"]').click()`);
  const mobile = await captureWindow.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector('.scene-terminal').getBoundingClientRect();
    return { innerWidth, scrollWidth: document.documentElement.scrollWidth, workspaceWidth: Math.round(workspace.width), visible: workspace.width > 250 };
  })()`);
  if (mobile.scrollWidth > mobile.innerWidth || !mobile.visible) throw new Error(`Mobile verification failed: ${JSON.stringify(mobile)}`);
  await capture("05-mobile-running-session.png");
}

app.whenReady().then(async () => {
  await startServer();
  await selectScene("home");
  await capture("01-main-project-list.png");
  await selectScene("project");
  await capture("02-project-running-sessions.png");
  await selectScene("session");
  await capture("03-running-session-terminal.png");
  await selectScene("attention");
  await capture("04-session-needs-reply.png");
  await verifyInteractions();
  captureWindow.destroy();
  server.close();
  app.quit();
}).catch(error => {
  console.error(error);
  if (server) server.close();
  app.exit(1);
});
