const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
let server;
let win;
let url;

app.setPath("userData", path.join(os.tmpdir(), `loadtoagent-sketch-008-${process.pid}`));
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
      const types = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".png":"image/png", ".woff2":"font/woff2" };
      response.writeHead(200, { "Content-Type": types[path.extname(requested)] || "application/octet-stream" });
      fs.createReadStream(requested).pipe(response);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      url = `http://127.0.0.1:${server.address().port}/.planning/sketches/008-current-shell-terminal-only/index.html`;
      resolve();
    });
  });
}

async function ensureWindow() {
  if (win) return;
  win = new BrowserWindow({ width:1560, height:940, show:false, backgroundColor:"#070b12", webPreferences:{ backgroundThrottling:false } });
  await win.loadURL(url);
  await win.webContents.executeJavaScript(`Promise.all([...document.images].map(image => image.complete ? true : new Promise(resolve => { image.onload = resolve; image.onerror = resolve; })))`);
}

async function selectScene(scene, variant = "exact") {
  await ensureWindow();
  const state = await win.webContents.executeJavaScript(`
    document.body.dataset.capture = 'true';
    document.body.dataset.annotations = 'off';
    document.body.dataset.variant = '${variant}';
    document.getElementById('canvas').dataset.viewport = 'full';
    document.querySelector('[data-scene-choice="${scene}"]').click();
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      scene: document.body.dataset.scene,
      variant: document.body.dataset.variant,
      width: document.querySelector('.scene-${scene} .terminal-drawer')?.getBoundingClientRect().width || 0,
      baselineWidth: document.querySelector('.baseline-image')?.naturalWidth || 0
    }))));
  `);
  if (state.scene !== scene || state.variant !== variant || state.baselineWidth !== 1544) throw new Error(`State selection failed: ${JSON.stringify(state)}`);
  if ((scene === "session" || scene === "attention") && Math.abs(state.width - (variant === "wide" ? 820 : 640)) > 1) throw new Error(`Drawer width mismatch: ${JSON.stringify(state)}`);
  await new Promise(resolve => setTimeout(resolve, 420));
  await win.webContents.capturePage();
  await new Promise(resolve => setTimeout(resolve, 80));
}

async function capture(filename) {
  win.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 100));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, filename), image.toPNG());
}

async function verifyInteractions() {
  await win.reload();
  await new Promise(resolve => setTimeout(resolve, 250));
  const result = await win.webContents.executeJavaScript(`
    document.querySelector('.scene-home .click-target').click();
    const project = document.body.dataset.scene === 'project';
    document.querySelector('.scene-project .click-target').click();
    const session = document.body.dataset.scene === 'session';
    document.querySelector('[data-scene-choice="attention"]').click();
    const form = document.querySelector('.scene-attention [data-terminal-form]');
    form.querySelector('textarea').value = '1번으로 진행해줘';
    form.requestSubmit();
    const resumed = document.body.dataset.scene === 'session';
    const appended = document.querySelector('.scene-attention [data-terminal-scroll]').textContent.includes('1번으로 진행해줘');
    document.querySelector('[data-variant-choice="wide"]').click();
    const wide = Math.round(document.querySelector('.scene-session .terminal-drawer').getBoundingClientRect().width) === 820;
    ({ project, session, resumed, appended, wide });
  `);
  if (Object.values(result).some(value => !value)) throw new Error(`Interaction verification failed: ${JSON.stringify(result)}`);
}

app.whenReady().then(async () => {
  await startServer();
  await selectScene("home");
  await capture("01-current-main-unchanged.png");
  await selectScene("project");
  await capture("02-current-project-unchanged.png");
  await selectScene("session");
  await capture("03-terminal-only-changed.png");
  await selectScene("attention");
  await capture("04-terminal-needs-reply.png");
  await selectScene("session", "wide");
  await capture("05-wide-terminal-variant.png");
  await verifyInteractions();
  win.destroy();
  server.close();
  app.quit();
}).catch(error => {
  console.error(error);
  if (server) server.close();
  app.exit(1);
});
