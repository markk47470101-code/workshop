'use strict';

// Рендерит assets/icon.svg средствами Electron и собирает assets/icon.png (512 px)
// и assets/icon.ico (16–256 px). Запуск: npm run icons

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const MASTER = 512;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function renderMaster(svg) {
  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    webPreferences: { backgroundThrottling: false },
  });

  const html =
    '<!doctype html><meta charset="utf-8"><style>' +
    'html,body{margin:0;background:transparent;overflow:hidden}' +
    'svg{display:block;width:100vw;height:100vh}</style>' + svg;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));

  let img = await win.webContents.capturePage();
  win.destroy();
  if (img.isEmpty()) throw new Error('Не удалось снять изображение окна.');
  const { width, height } = img.getSize();
  if (width !== MASTER || height !== MASTER) {
    img = img.resize({ width: MASTER, height: MASTER, quality: 'best' });
  }
  return img;
}

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + 16 * entries.length;
  const dir = entries.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
}

app.whenReady()
  .then(async () => {
    const svg = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
    const master = await renderMaster(svg);

    fs.writeFileSync(path.join(ASSETS, 'icon.png'), master.toPNG());
    const entries = ICO_SIZES.map((size) => ({
      size,
      data: master.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    }));
    fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(entries));
    console.log('Готово: icon.png (' + MASTER + ') и icon.ico (' + ICO_SIZES.join(', ') + ')');
    app.quit();
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
