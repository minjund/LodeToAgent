'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const temporaryUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestar-metaphysical-sketch-'));
app.setPath('userData', temporaryUserData);
app.once('quit', () => {
  try { fs.rmSync(temporaryUserData, { recursive: true, force: true }); } catch {}
});

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function capture(win, variant, output, width, height) {
  win.setContentSize(width, height);
  await win.loadFile(path.join(__dirname, 'index.html'));
  await win.webContents.executeJavaScript(`document.querySelector('[data-variant-target="${variant}"]').click()`);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await wait(500);
  const metrics = await win.webContents.executeJavaScript(`({
    variant: '${variant}',
    width: innerWidth,
    bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
    viewportOverflow: document.querySelector('#sketchViewport').scrollWidth - document.querySelector('#sketchViewport').clientWidth,
    visibleVariant: document.querySelector('.variant.active')?.dataset.variant,
  })`);
  if (metrics.bodyOverflow > 2 || metrics.viewportOverflow > 2 || metrics.visibleVariant !== variant) {
    throw new Error(`Layout verification failed: ${JSON.stringify(metrics)}`);
  }
  fs.writeFileSync(path.join(__dirname, output), (await win.webContents.capturePage()).toPNG());
  return metrics;
}

async function verifyInteractions(win) {
  await win.loadFile(path.join(__dirname, 'index.html'));
  return win.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-variant-target="cosmic"]').click();
    const cosmicNode = document.querySelector('.planet-b');
    cosmicNode.click();
    const cosmicSelected = cosmicNode.classList.contains('selected')
      && document.querySelector('#cosmicDetailTitle').textContent === '구현 에이전트';
    const search = document.querySelector('.cosmic-search');
    search.value = '문서';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const searchFiltered = [...document.querySelectorAll('.celestial')]
      .filter(node => !node.hidden).length === 1;

    document.querySelector('[data-variant-target="ritual"]').click();
    const rite = document.querySelectorAll('.rite-item')[1];
    rite.click();
    const riteSelected = rite.classList.contains('active');
    const omen = document.querySelectorAll('.omen-card')[1];
    omen.click();
    const omenOpened = omen.classList.contains('open');

    document.querySelector('[data-variant-target="ontology"]').click();
    const entry = document.querySelector('.ontology-entry');
    entry.click();
    const drawerOpened = document.querySelector('#ontologyDrawer').classList.contains('open');
    document.querySelector('#ontologyDrawer .close').click();
    const drawerClosed = !document.querySelector('#ontologyDrawer').classList.contains('open');

    return { cosmicSelected, searchFiltered, riteSelected, omenOpened, drawerOpened, drawerClosed };
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    backgroundColor: '#070811',
    webPreferences: { backgroundThrottling: false },
  });

  try {
    const metrics = [];
    metrics.push(await capture(win, 'cosmic', 'variant-a-cosmic.png', 1600, 1000));
    metrics.push(await capture(win, 'ritual', 'variant-b-ritual.png', 1600, 1000));
    metrics.push(await capture(win, 'ontology', 'variant-c-ontology.png', 1600, 1000));
    metrics.push(await capture(win, 'cosmic', 'variant-a-cosmic-mobile.png', 390, 844));
    metrics.push(await capture(win, 'ritual', 'variant-b-ritual-mobile.png', 390, 844));
    metrics.push(await capture(win, 'ontology', 'variant-c-ontology-mobile.png', 390, 844));
    const interactions = await verifyInteractions(win);
    if (Object.values(interactions).some(value => !value)) {
      throw new Error(`Interaction verification failed: ${JSON.stringify(interactions)}`);
    }
    process.stdout.write(`Metaphysical sketch captures complete.\n${JSON.stringify({ metrics, interactions }, null, 2)}\n`);
  } finally {
    win.destroy();
    app.quit();
  }
});
