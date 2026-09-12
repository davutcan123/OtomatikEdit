'use strict';
// Standalone Electron reference; no application server, project, or user files.
// Run: node_modules/.bin/electron tests/color_preview.electron.cjs [evidence-directory]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

// Keep reference samples in sRGB, independent of the host monitor's ICC gamut.
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const colors = [[64, 64, 64], [128, 128, 128], [180, 180, 180], [0, 0, 0], [128, 64, 32], [32, 96, 160]];
const cases = [
  { name: 'brightness150', filter: 'brightness(1.5) contrast(1) saturate(1)' },
  { name: 'brightness200', filter: 'brightness(2) contrast(1) saturate(1)' },
  { name: 'clamp-before-contrast', filter: 'brightness(1.5) contrast(.8) saturate(1)' },
  ...[0, 1, 1.5].map(s => ({ name: 'saturation' + s, filter: `brightness(1.2) contrast(.9) saturate(${s})` })),
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 384, height: cases.length * 64, show: false,
    useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:black"></body>'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const colors = ${JSON.stringify(colors)}, cases = ${JSON.stringify(cases)}, rows = [];
      for (const item of cases) {
        const source = document.createElement('canvas'); source.width=384; source.height=64;
        const ctx = source.getContext('2d', {colorSpace:'srgb'});
        colors.forEach((rgb,i) => {ctx.fillStyle='rgb('+rgb.join(',')+')';ctx.fillRect(i*64,0,64,64)});
        source.style.cssText='display:block;width:384px;height:64px;filter:'+item.filter;
        document.body.appendChild(source);
        const filtered=document.createElement('canvas');filtered.width=384;filtered.height=64;
        const out=filtered.getContext('2d',{colorSpace:'srgb'});out.filter=item.filter;out.drawImage(source,0,0);
        rows.push({name:item.name,filter:item.filter,pixels:colors.map((_,i)=>Array.from(out.getImageData(i*64+32,32,1,1).data).slice(0,3))});
      }
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {chromium:navigator.userAgent,colors,rows};
    })()`);
    const screenshot = await win.webContents.capturePage();
    assert.deepEqual(result.rows[0].pixels[1], [192, 192, 192], 'CSS brightness must multiply RGB');
    assert.deepEqual(result.rows[0].pixels[3], [0, 0, 0], 'CSS brightness must not lift black');
    assert.deepEqual(result.rows[1].pixels[0], [128, 128, 128], '200% brightness doubles a dark gray');
    assert.ok(result.rows[2].pixels[2].every(value => Math.abs(value - 229.5) <= 1),
      'Clamp brightness before applying contrast (allow platform rounding)');
    assert.ok(result.rows[3].pixels.every(rgb => rgb[0] === rgb[1] && rgb[1] === rgb[2]), 'Zero saturation must be neutral');
    if (process.argv[2]) {
      const directory = path.resolve(process.argv[2]);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'chromium-css-preview.png'), screenshot.toPNG());
      await fs.writeFile(path.join(directory, 'chromium-color-reference.json'), JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify(result));
  } finally {
    win.destroy();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
