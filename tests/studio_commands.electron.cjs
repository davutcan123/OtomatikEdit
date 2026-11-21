'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'otomatik-studio-command-'));
app.setPath('userData', path.join(fixture, 'profile'));
const mod = process.platform === 'darwin' ? 'meta' : 'control';
let server, window;
const submissions = [];
const evaluate = code => window.webContents.executeJavaScript(code);
const frames = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
async function key(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await frames();
}
async function cursor(time) {
  await evaluate(`el('timeline').focus({preventScroll:true});S.timelineCursor=${time};`);
}
async function waitFor(ready) {
  const deadline = Date.now() + 5000;
  do {
    if (await ready()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail('Fixture action did not finish.');
}
async function route(request, response, media) {
  const pathname = new URL(request.url, 'http://fixture').pathname;
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fs.readFileSync(path.join(root, 'templates/index.html')));
  } else if (pathname.startsWith('/static/')) {
    const staticRoot = path.join(root, 'static'), file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file)) return response.writeHead(404).end();
    response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'application/javascript');
    response.end(fs.readFileSync(file));
  } else if (pathname === '/projects' && request.method === 'POST') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const project = JSON.parse(Buffer.concat(chunks));
    submissions.push(project);
    json({ id: '08cd3228-0096-42d2-9469-e751b4962b15', name: project.name });
  } else if (pathname === '/projects') json({ projects: [] });
  else if (pathname === '/api/version' || pathname === '/api/check-update') json({ version: 'studio-fixture', update_available: false });
  else if (pathname === '/video/source.mp4') {
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = match ? +match[1] : 0, end = match?.[2] ? Math.min(+match[2], media.length - 1) : media.length - 1;
    response.setHeader('Content-Type', 'video/mp4');
    response.setHeader('Accept-Ranges', 'bytes');
    if (match) response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${media.length}` });
    response.end(media.subarray(start, end + 1));
  } else response.writeHead(204).end();
}

app.whenReady().then(async () => {
  const packagedFFmpeg = path.join(root, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
  const ffmpeg = process.env.SMART_EDITOR_FFMPEG || (fs.existsSync(packagedFFmpeg) && process.platform === 'win32' ? packagedFFmpeg : 'ffmpeg');
  const source = path.join(fixture, 'source.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    'color=blue:s=320x180:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { timeout: 30000 });
  const media = fs.readFileSync(source);
  server = http.createServer((req, res) => route(req, res, media).catch(error => {
    console.error(error);res.writeHead(500).end();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  window = new BrowserWindow({ show: true, width: 1366, height: 740, webPreferences: { backgroundThrottling: false } });
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
  await evaluate(`(async()=>{await projectWorkspaceInitialization;
    restoreProject({name:'Studio fixture',activeTimelineId:'one',timelines:[
      {id:'one',name:'Main',state:{manualId:'source.mp4',manualName:'Source',clips:[{clipId:'a',start:0,end:6,sourceDuration:6,fileId:'source.mp4',timelineStart:0}] }},
      {id:'two',name:'Second',state:{manualId:'source.mp4',manualName:'Source',clips:[{clipId:'b',start:0,end:6,sourceDuration:6,fileId:'source.mp4',timelineStart:0}] }},
    ]});})()`);
  await waitFor(() => evaluate('mv.readyState>=2&&!mv.seeking'));

  await cursor(1);
  await key('M');
  assert.equal(await evaluate("document.querySelectorAll('.studio-ruler-marker').length"), 1);
  await key('I');
  await cursor(4);
  await key('O');
  assert.deepEqual(await evaluate('S.studioTimeline.range'), { in: 1, out: 4 });
  await evaluate('setExportModal(true)');
  assert.deepEqual(await evaluate('StudioCommands.selectedExportRange()'), { in: 1, out: 4 });
  await evaluate("el('studio-export-scope').value='full'");
  assert.equal(await evaluate('StudioCommands.selectedExportRange()'), null);
  await evaluate("el('studio-export-scope').value='range'");
  assert.deepEqual(await evaluate(`(()=>{const data=manualExportData();data.options.exportRange=StudioCommands.selectedExportRange();const form=buildRenderForm(data);return [form.get('range_in'),form.get('range_out')]})()`), ['1', '4']);
  await evaluate('setExportModal(false);switchTimeline("two")');
  assert.equal(await evaluate('S.studioTimeline'), null);
  await evaluate('switchTimeline("one")');
  assert.deepEqual(await evaluate('S.studioTimeline.range'), { in: 1, out: 4 });

  await cursor(2);
  await key('K', [mod]);
  assert.equal(await evaluate("el('studio-command-panel').open"), true);
  await evaluate(`(()=>{const input=el('studio-command-panel').querySelector('input');input.value='proje';input.dispatchEvent(new Event('input'));})()`);
  assert.equal(await evaluate("el('studio-command-panel').querySelectorAll('[data-studio-run]').length"), 1);
  await evaluate(`document.querySelector('[data-studio-binding="save"]').click()`);
  await key('B');
  assert.match(await evaluate("el('studio-command-panel').querySelector('[role=status]').textContent"), /ayrılmış/);
  await key('S', ['shift']);
  assert.equal(await evaluate("StudioPreferences.get('shortcuts').save"), 'Shift+KeyS');
  await key('Escape');
  assert.equal(await evaluate("el('studio-command-panel').open"), false);
  await evaluate("el('project-name').focus()");
  await key('S', ['shift']);
  assert.equal(submissions.length, 0);
  await cursor(2);
  const shortcutsFocus = await evaluate("({focused:document.activeElement.id,dialogs:[...document.querySelectorAll('dialog[open]')].map(el=>el.id),projectWorkspaceReady})");
  assert.deepEqual(shortcutsFocus, {focused:'timeline',dialogs:[],projectWorkspaceReady:true});
  await key('S', ['shift']);
  await waitFor(() => submissions.length === 1);
  assert.deepEqual(submissions[0].timelines[0].state.studioTimeline.range, { in: 1, out: 4 });
  await waitFor(() => evaluate('projectSave===null'));

  await cursor(3);
  await key('B', [mod]);
  assert.equal(await evaluate('S.clips.length'), 2);
  await cursor(1.5);
  await key('B');
  assert.equal(await evaluate('S.clips.length'), 3);
  await cursor(3);
  await key('M', ['shift']);
  await waitFor(() => evaluate('Math.abs(currentOutputTime()-1)<.04'));
  await key('.');
  await waitFor(() => evaluate('Math.abs(currentOutputTime()-31/30)<.02'));

  await evaluate(`document.querySelector('.studio-ruler-marker').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
  assert.equal(await evaluate("el('studio-marker-panel').open"), true);
  await evaluate(`(()=>{const marker=el('studio-marker-panel');marker.querySelector('input').value='Giriş sahnesi';marker.querySelector('form').requestSubmit()})()`);
  assert.equal(await evaluate('S.studioTimeline.markers[0].name'), 'Giriş sahnesi');
  await evaluate(`document.querySelector('.studio-ruler-marker').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));document.querySelector('[data-studio-marker-remove]').click();`);
  assert.equal(await evaluate('S.studioTimeline.markers.length'), 0);
  await evaluate('undoEdit()');
  assert.equal(await evaluate('S.studioTimeline.markers[0].name'), 'Giriş sahnesi');
  await cursor(2);
  await key('X', ['alt']);
  assert.equal(await evaluate('S.studioTimeline.range'), null);
  await key('K', [mod]);
  await evaluate(`document.querySelector('[data-studio-reset]').click()`);
  assert.deepEqual(await evaluate("StudioPreferences.get('shortcuts')"), {});
  await key('Escape');
  await cursor(2);
  await key('S', [mod]);
  await waitFor(() => submissions.length === 2);
  await waitFor(() => evaluate('projectSave===null'));

  await evaluate(`S.clips=[hydrateClip({clipId:'red',start:0,end:2,sourceDuration:6,fileId:'source.mp4',timelineStart:0}),hydrateClip({clipId:'blue',start:2,end:4,sourceDuration:6,fileId:'source.mp4',timelineStart:2})];S.transitions=[{boundary:0,type:'fade',duration:.5}];S.studioTimeline=StudioCommands.normalizeTimeline({range:{in:1.5,out:3}});drawClips();setExportModal(true)`);
  assert.equal(await evaluate("el('studio-export-range-info').textContent"),
    '00:01.500 – 00:03.000 · Çıktı 1,00 sn (geçişlerle kısalır)');
  console.log('Native studio keys, preference conflict and reset, marker undo and per-timeline output ranges verified.');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  window?.destroy();
  server?.closeAllConnections();
  server?.close();
  app.exit(process.exitCode || 0);
});
