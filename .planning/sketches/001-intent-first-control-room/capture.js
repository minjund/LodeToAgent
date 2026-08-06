const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");

const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
const windows = [];
let server;
let htmlUrl;
let captureWindow;

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
      const extension = path.extname(requested);
      const types = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".woff2": "font/woff2"
      };
      response.writeHead(200, { "Content-Type": types[extension] || "application/octet-stream" });
      fs.createReadStream(requested).pipe(response);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      htmlUrl = `http://127.0.0.1:${port}/.planning/sketches/001-intent-first-control-room/index.html`;
      resolve();
    });
  });
}

function verifyUrl() {
  return new Promise((resolve, reject) => {
    http.get(htmlUrl, (response) => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode === 200) resolve();
        else reject(new Error(`Capture server returned ${response.statusCode}`));
      });
    }).once("error", reject);
  });
}

async function capture(variant, filename, width = 1600, height = 960) {
  if (!captureWindow) {
    captureWindow = new BrowserWindow({
      width,
      height,
      show: false,
      backgroundColor: "#071019"
    });
    windows.push(captureWindow);
    try {
      await captureWindow.loadURL(htmlUrl);
    } catch (error) {
      if (error.code !== "ERR_FAILED") throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
      const title = await captureWindow.webContents.executeJavaScript("document.title");
      if (!title.includes("Intent-first")) throw error;
    }
  }
  captureWindow.setSize(width, height);
  await captureWindow.webContents.executeJavaScript(
    `document.querySelector('[data-variant="${variant}"]').click()`
  );
  await new Promise((resolve) => setTimeout(resolve, 650));
  const image = await captureWindow.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, filename), image.toPNG());
}

app.whenReady().then(async () => {
  await startServer();
  await verifyUrl();
  await capture("a", "variant-a-judgment-first.png");
  await capture("b", "variant-b-living-delegation.png");
  await capture("c", "variant-c-one-temporal-line.png");
  await capture("a", "variant-a-mobile.png", 390, 844);
  captureWindow.destroy();
  server.close();
  app.quit();
}).catch((error) => {
  console.error(error);
  if (server) server.close();
  app.exit(1);
});
