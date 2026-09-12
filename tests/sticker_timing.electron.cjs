// Run: node_modules/.bin/electron tests/sticker_timing.electron.cjs [--diagnose] [--baseline]
// Uses the production editor script and a disposable local video/project, never user projects.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'otomatik-sticker-timing-'));
app.setPath('userData', path.join(artifacts, 'profile'));
const template = process.argv.includes('--baseline') ? execFileSync('git', ['show', 'HEAD:templates/index.html'], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const pageErrors = [];
let window, server;
const evaluate = source => window.webContents.executeJavaScript(source);
const twoFrames = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const waitForFrame = () => evaluate(`new Promise((resolve,reject)=>{const video=el('manual-video'),events=['loadeddata','canplay','seeked','timeupdate'];let timer;const clear=()=>{clearTimeout(timer);events.forEach(name=>video.removeEventListener(name,ready));video.removeEventListener('error',failed)},ready=()=>{if(video.readyState>=2&&!video.seeking){clear();resolve()}},failed=()=>{clear();reject(new Error(video.error?.message||'Fixture decode failed'))};events.forEach(name=>video.addEventListener(name,ready));video.addEventListener('error',failed);timer=setTimeout(()=>{clear();reject(new Error('Fixture not ready: '+JSON.stringify({state:video.readyState,seeking:video.seeking,time:video.currentTime})))},10000);ready()})`);
async function seek(time) { await evaluate(`seekOutputTime(${time})`);await waitForFrame();await twoFrames();return evaluate(`({time:currentOutputTime(),visible:[...el('sticker-overlay').children].map(node=>node.dataset.stickerId)})`); }
const geometry = () => evaluate(`S.stickers.map(item=>{const node=document.querySelector('#sticker-track [data-sticker-id="'+item.id+'"]'),rect=node.getBoundingClientRect(),style=getComputedStyle(node);return{id:item.id,start:item.start,end:item.end,zoom:S.zoom,scale:item.scale,left:parseFloat(node.style.left),inlineWidth:parseFloat(node.style.width),width:rect.width,expectedWidth:(item.end-item.start)*S.zoom,visualEnd:item.start+rect.width/S.zoom,padding:style.padding,border:style.borderWidth}})`);
const trimStar = delta => evaluate(`(()=>{const node=document.querySelector('#sticker-track [data-sticker-id="S1"]'),handle=node.querySelector('.trim-handle.right'),box=handle.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2;handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:x,clientY:y}));window.dispatchEvent(new PointerEvent('pointermove',{clientX:x+(${delta}),clientY:y}));window.dispatchEvent(new PointerEvent('pointerup'))})()`);

async function clickButton(id) {
  const point = await evaluate(`(()=>{const node=el(${JSON.stringify(id)});node.scrollIntoView({block:'nearest',inline:'nearest'});const rect=node.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;return{x,y,enabled:!node.disabled,reachable:node.contains(document.elementFromPoint(x,y))}})()`);
  assert.ok(point.enabled && point.reachable, `${id} must be enabled and reachable`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: Math.round(point.x), y: Math.round(point.y), clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: Math.round(point.x), y: Math.round(point.y), clickCount: 1 });
  await twoFrames();
}

async function checkExportModal() {
  const checks = [];
  window.setContentSize(1366, 768);await twoFrames();
  await clickButton('manual-render-top');
  const defaults = await evaluate(`({open:!el('export-modal').classList.contains('hidden'),hardware:el('export-hardware').value,choices:[...el('export-hardware').options].map(option=>option.value),fps:el('export-fps').value,quality:el('export-quality').value})`);
  assert.deepEqual(defaults, { open: true, hardware: 'auto', choices: ['auto', 'cpu'], fps: '30', quality: 'standard' });
  await fs.promises.writeFile(path.join(artifacts, 'export-default-1366x768.png'), (await window.webContents.capturePage()).toPNG());
  await clickButton('export-cancel');
  // Choose resolution through the existing canvas control, then exercise the
  // same settings and FormData builder used by the real render action. Never
  // start an encoder or send a render request from this browser fixture.
  await evaluate(`el('canvas-preset-top').value='1280x720';el('canvas-preset-top').dispatchEvent(new Event('change',{bubbles:true}))`);
  for (const [width, height] of [[1366, 768], [1100, 700]]) {
    window.setContentSize(width, height);await twoFrames();
    await clickButton('manual-render-top');
    await evaluate(`for(const [id,value] of [['export-hardware','cpu'],['export-fps','60'],['export-quality','high'],['export-format','mp4']]){el(id).value=value;el(id).dispatchEvent(new Event('change',{bubbles:true}))}`);
    const layout = await evaluate(`(()=>{const card=el('export-modal').querySelector('.export-modal-card'),bounds=card.getBoundingClientRect();return{width:innerWidth,height:innerHeight,card:{left:bounds.left,top:bounds.top,right:bounds.right,bottom:bounds.bottom},clientWidth:card.clientWidth,scrollWidth:card.scrollWidth,clientHeight:card.clientHeight,scrollHeight:card.scrollHeight,controls:['export-format','export-fps','export-quality','export-hardware','export-render-start'].map(id=>{const node=el(id);node.scrollIntoView({block:'nearest',inline:'nearest'});const box=node.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2;return{id,left:box.left,right:box.right,top:box.top,bottom:box.bottom,reachable:node.contains(document.elementFromPoint(x,y)),disabled:node.disabled}})}})()`);
    assert.equal(layout.width, width);assert.equal(layout.height, height);
    assert.ok(layout.card.left >= 0 && layout.card.top >= 0 && layout.card.right <= width + 1 && layout.card.bottom <= height + 1, 'Export dialog must fit inside the viewport');
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, 'Export dialog must not require horizontal scrolling');
    for (const control of layout.controls) {
      assert.ok(control.reachable && !control.disabled && control.top >= 0 && control.bottom <= height + 1, `${width}×${height}: ${control.id} must be reachable (vertical scrolling is allowed)`);
      assert.ok(control.left >= layout.card.left && control.right <= layout.card.right + 1, `${control.id} must fit inside the dialog`);
    }
    const payload = await evaluate(`Object.fromEntries(buildRenderForm(manualExportData(el('export-format').value)).entries())`);
    assert.equal(payload.hardware, 'cpu');assert.equal(payload.fps, '60');assert.equal(payload.quality, 'high');
    assert.equal(payload.width, '1280');assert.equal(payload.height, '720');assert.equal(payload.fmt, 'mp4');
    assert.equal(payload.file_id, 'sticker-fixture.mp4');assert.equal(JSON.parse(payload.stickers).length, 2);
    assert.equal(await evaluate(`el('export-resolution').textContent`), '1280×720');
    await fs.promises.writeFile(path.join(artifacts, `export-cpu-${width}x${height}.png`), (await window.webContents.capturePage()).toPNG());
    checks.push({ layout, requested: { hardware: payload.hardware, fps: payload.fps, quality: payload.quality, width: payload.width, height: payload.height } });
    await clickButton('export-cancel');
    assert.ok(await evaluate(`el('export-modal').classList.contains('hidden')`));
  }
  return { defaults, checks };
}

app.whenReady().then(async () => {
  const videoPath = path.join(artifacts, 'fixture.mp4');
  const windowsFFmpeg = path.join(root, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
  const ffmpeg = process.env.SMART_EDITOR_FFMPEG || (process.platform === 'win32' && fs.existsSync(windowsFFmpeg) ? windowsFFmpeg : 'ffmpeg');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x223344:s=640x360:r=30:d=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath], { timeout: 60000 });
  const video = fs.readFileSync(videoPath);
  server = http.createServer((request, response) => {
    const route = request.url.split('?')[0];
    if (route === '/favicon.ico') { response.writeHead(204).end();return; }
    if (route === '/') { response.setHeader('Content-Type', 'text/html');response.end(template);return; }
    if (['/static/editor.css', '/static/workspace.css'].includes(route)) { response.setHeader('Content-Type', 'text/css');response.end(fs.readFileSync(path.join(root, route)));return; }
    if (route === '/projects' || route === '/api/check-update' || route === '/api/version') { response.setHeader('Content-Type', 'application/json');response.end(JSON.stringify(route === '/projects' ? { projects: [] } : route === '/api/version' ? { version: 'test' } : { update_available: false }));return; }
    if (route.startsWith('/waveform/')) { response.setHeader('Content-Type', 'image/png');response.end(tinyPng);return; }
    if (route === '/video/sticker-fixture.mp4') {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      const start = range ? +range[1] : 0, end = range && range[2] ? Math.min(video.length - 1, +range[2]) : video.length - 1;
      response.statusCode = range ? 206 : 200;response.setHeader('Content-Type', 'video/mp4');response.setHeader('Accept-Ranges', 'bytes');response.setHeader('Content-Length', end - start + 1);
      if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${video.length}`);
      response.end(video.subarray(start, end + 1));return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  window = new BrowserWindow({ show: false, width: 1366, height: 768, useContentSize: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.webContents.on('console-message', details => { if (details.level === 'error') pageErrors.push(details.message); });
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
  await evaluate('projectWorkspaceInitialization');
  await evaluate(`restoreProject({name:'Sticker timing fixture',activeTimelineId:'TL1',mediaAssets:[],timelines:[{id:'TL1',name:'Test',state:{manualId:'sticker-fixture.mp4',manualName:'Sticker fixture',duration:12,selected:0,preview:0,clips:[{start:0,end:12,fileId:'sticker-fixture.mp4',sourceDuration:12,timelineStart:0}],canvas:{width:1920,height:1080},zoom:14}}]})`);
  await waitForFrame();
  await evaluate(`addStickerPreset('star',1);addStickerPreset('heart',3);el('timeline').scrollTop=0`);
  await waitForFrame();await twoFrames();
  const initial = await geometry(), visibility = [];
  for (const time of [.9, 1.01, 3.1, 4.05, 5.99, 6.05]) visibility.push(await seek(time));
  assert.deepEqual(visibility.map(row => row.visible), [[], ['S1'], ['S1', 'S2'], ['S2'], ['S2'], []]);
  await seek(3.2);
  const scaled = await evaluate(`(()=>{selectSticker('S1',false);const node=document.querySelector('#sticker-overlay [data-sticker-id="S1"]'),stage=el('preview-stage').getBoundingClientRect(),x=stage.left+stage.width/2,y=stage.top+stage.height/2,handle=node.querySelector('.transform-handle.scale');handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:x+50,clientY:y+50}));window.dispatchEvent(new PointerEvent('pointermove',{clientX:x+90,clientY:y+90}));window.dispatchEvent(new PointerEvent('pointerup'));return S.stickers.map(item=>({id:item.id,start:item.start,end:item.end,scale:item.scale}))})()`);
  assert.ok(scaled[0].scale > initial[0].scale);assert.equal(scaled[0].start, 1);assert.equal(scaled[0].end, 4);
  assert.deepEqual((await seek(4.05)).visible, ['S2']);
  window.setContentSize(1100, 700);await twoFrames();
  assert.deepEqual((await seek(3.2)).visible, ['S1', 'S2']);
  const afterResize = await geometry();
  await trimStar(21);
  const afterTrim = await geometry();assert.ok(Math.abs(afterTrim[0].end - 5.5) < .001);
  assert.deepEqual((await seek(5.4)).visible, ['S1', 'S2']);assert.deepEqual((await seek(5.6)).visible, ['S2']);
  await trimStar(77);
  const extended = await geometry();assert.ok(Math.abs(extended[0].end - 11) < .001);
  assert.deepEqual((await seek(10.8)).visible, ['S1']);assert.deepEqual((await seek(11.05)).visible, []);
  await trimStar(-112);
  const shortened = await geometry();assert.ok(Math.abs(shortened[0].end - 3) < .001);
  assert.deepEqual((await seek(2.99)).visible, ['S1']);assert.deepEqual((await seek(3.05)).visible, ['S2']);
  await evaluate('S.zoom=.5;drawClips();el("timeline").scrollTop=0');await twoFrames();
  const lowZoom = await geometry();
  await evaluate('S.zoom=.02;drawClips();el("timeline").scrollTop=0');await twoFrames();
  const deepZoom = await geometry();
  await fs.promises.writeFile(path.join(artifacts, 'sticker-low-zoom.png'), (await window.webContents.capturePage()).toPNG());
  const exportModal = process.argv.includes('--baseline') ? null : await checkExportModal();
  const report = { baseline: process.argv.includes('--baseline'), initial, visibility, scaled, afterResize, afterTrim, extended, shortened, lowZoom, deepZoom, exportModal, pageErrors, artifacts };
  console.log(JSON.stringify(report));
  assert.deepEqual(pageErrors, [], 'The production editor must not raise script or resource errors');
  if (!process.argv.includes('--diagnose')) {
    for (const [phase, rows] of Object.entries({ initial, afterResize, afterTrim, extended, shortened, lowZoom, deepZoom })) {
      for (const row of rows) assert.ok(Math.abs(row.width - row.expectedWidth) <= .05, `${phase}: timeline bar misrepresents sticker duration: ${JSON.stringify(row)}`);
    }
  }
  console.log('Sticker timing: actual visibility, independent presets, preview scaling and timeline trimming passed.');
  if (exportModal) console.log('Export modal: automatic/CPU selection, requested render settings and reachable controls at both viewport sizes passed.');
}).catch(error => { console.error(error);process.exitCode = 1; }).finally(() => { window?.destroy();server?.close();app.exit(process.exitCode || 0); });
