const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const htmlPath = path.join(__dirname, "index.html");
const windows = [];

async function captureTab({ key, file, width = 1600, height = 1000 }) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    backgroundColor: "#071019"
  });
  windows.push(win);

  await win.loadFile(htmlPath);
  await win.webContents.executeJavaScript(`document.querySelector('[data-switch="${key}"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await win.webContents.capturePage();
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, file), image.toPNG());
}

app.whenReady().then(async () => {
  await captureTab({ key: "a", file: "tab-review.png" });
  await captureTab({ key: "b", file: "tab-live-flow.png" });
  await captureTab({ key: "c", file: "tab-all-tasks.png" });
  await captureTab({ key: "a", file: "tab-review-mobile.png", width: 390, height: 844 });
  windows.forEach((win) => win.destroy());
  app.quit();
});
