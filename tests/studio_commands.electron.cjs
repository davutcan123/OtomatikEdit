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
async function checkInspectorHistory() {
  await cursor(.5);
  await evaluate("addTextPreset('classic',.5)");
  const original=await evaluate('selectedText().text');
  await cursor(1);
  await key('M');
  await key('Z',[mod]);
  assert.equal(await evaluate('S.redoHistory.length'),1);
  const depth=await evaluate('S.history.length');
  await evaluate("el('text-content').focus();el('text-content').select()");
  assert.equal(await evaluate("document.activeElement.id"),'text-content');
  assert.equal(await evaluate('S.redoHistory.length'),1,'Focusing an inspector field keeps redo intact');
  await window.webContents.insertText('Yeni');
  await window.webContents.insertText(' başlık');
  assert.equal(await evaluate('selectedText().text'),'Yeni başlık');
  assert.equal(await evaluate('S.history.length'),depth+1,'Multiple characters in one focus session make one edit');
  assert.equal(await evaluate("el('redo').disabled"),true);
  await key('Z',[mod]);
  assert.equal(await evaluate('S.history.length'),depth+1,'The timeline undo shortcut leaves the focused textarea alone');
  if(await evaluate('selectedText().text')==='Yeni başlık'){
    window.webContents.undo();await frames();
  }
  assert.notEqual(await evaluate('selectedText().text'),'Yeni başlık');
  window.webContents.redo();await frames();
  assert.equal(await evaluate('selectedText().text'),'Yeni başlık');
  await cursor(1.2);
  await key('Z',[mod,'shift']);
  assert.equal(await evaluate('S.studioTimeline'),null,'Old marker redo cannot overwrite the new text');
  await key('Z',[mod]);
  assert.equal(await evaluate('selectedText().text'),original);
  await key('Z',[mod,'shift']);
  assert.equal(await evaluate("el('text-content').value"),'Yeni başlık');

  await cursor(1.4);await key('M');await key('Z',[mod]);
  const sliderStart=await evaluate("el('text-x').focus();selectedText().x");
  const sliderDepth=await evaluate('S.history.length');
  assert.equal(await evaluate('document.activeElement.id'),'text-x');
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Right',isAutoRepeat:true});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
  await frames();
  const sliderEnd=await evaluate('selectedText().x');
  assert.ok(sliderEnd>sliderStart);
  assert.deepEqual(await evaluate('[S.history.length,S.redoHistory.length]'),[sliderDepth+1,0]);
  await cursor(1.4);await key('Z',[mod]);
  assert.equal(await evaluate('selectedText().x'),sliderStart);
  await key('Z',[mod,'shift']);
  assert.equal(await evaluate('selectedText().x'),sliderEnd);
  const first=await evaluate('projectPayload()');
  assert.equal(first.name,'Studio fixture');
  assert.equal(first.timelines[0].state.studioTimeline.range.out,3);

  await evaluate(`restoreProject({id:'12345678-1234-1234-1234-123456789abc',name:'Altyazı projesi',
    activeTimelineId:'captions',timelines:[{id:'captions',name:'Diyalog',state:{
      ...emptyTimelineState(),manualId:'source.mp4',clips:[{clipId:'c',start:0,end:6,sourceDuration:6,fileId:'source.mp4',timelineStart:0}],
      videoTracks:[{id:1,name:'Video 1',locked:false,visible:true,muted:false},{id:2,name:'Kilitli',locked:true,visible:true,muted:false}]
    }}]});StudioWorkspace.openSection('captions')`);
  await evaluate(`StudioCaptions.importFile(new File([${JSON.stringify('1\n00:00:00,200 --> 00:00:01,500\nİlk satır\n')}],
    'captions.srt',{type:'application/x-subrip'}))`);
  assert.equal(await evaluate('selectedText().text'),'İlk satır');
  await cursor(1);await key('M');await key('Z',[mod]);
  const captionDepth=await evaluate('S.history.length');
  await evaluate("el('subtitle-content').focus();el('subtitle-content').select()");
  assert.equal(await evaluate('document.activeElement.id'),'subtitle-content');
  await window.webContents.insertText('Düzenlenen altyazı');
  assert.equal(await evaluate("el('studio-caption-text').value"),'Düzenlenen altyazı');
  assert.deepEqual(await evaluate('[S.history.length,S.redoHistory.length]'),[captionDepth+1,0]);

  await cursor(2);await key('M');await key('Z',[mod]);
  await evaluate(`el('studio-caption-text').value='SRT güncellemesi';
    el('studio-caption-end').value='1.8';el('studio-caption-apply-edit').click()`);
  assert.deepEqual(await evaluate("[selectedText().text,selectedText().end,el('redo').disabled]"),['SRT güncellemesi',1.8,true]);
  await evaluate(`el('text-end').value='2.2';el('text-end').dispatchEvent(new Event('change'));
    el('text-font-weight').value=selectedText().bold?'400':'700';el('text-font-weight').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate('selectedText().end'),2.2);
  const bold=await evaluate('selectedText().bold');
  await evaluate('undoEdit()');assert.notEqual(await evaluate('selectedText().bold'),bold);
  await evaluate('redoEdit()');assert.equal(await evaluate('selectedText().bold'),bold);
  assert.ok(await evaluate('videoTrackState(2).locked'));
  await evaluate("toggleTrackAction('subtitle','lock')");
  assert.ok(await evaluate("isTrackLocked('subtitle')"));
  const lockDepth=await evaluate('S.history.length');
  await evaluate(`el('subtitle-content').value='Kilitli değişiklik';
    el('subtitle-content').dispatchEvent(new Event('input'));persistProjectRecovery()`);
  assert.deepEqual(await evaluate('[selectedText().text,S.history.length]'),['SRT güncellemesi',lockDepth]);

  const loaded=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));
  window.webContents.reload();await loaded;await evaluate('projectWorkspaceInitialization');
  assert.deepEqual(await evaluate("[el('project-name').value,selectedText().text,selectedText().end,selectedText().bold,isTrackLocked('subtitle'),videoTrackState(2).locked]"),
    ['Altyazı projesi','SRT güncellemesi',2.2,bold,true,true]);
  await evaluate('restoreProject('+JSON.stringify(first)+')');
  assert.deepEqual(await evaluate("[el('project-name').value,selectedText().text,selectedText().x,S.history.length,S.redoHistory.length]"),
    ['Studio fixture','Yeni başlık',sliderEnd,0,0]);
}

async function checkExpandedPalette() {
  async function searchCommand(term, action) {
    await evaluate(`(()=>{el('preview-shortcuts').click();const field=el('studio-command-panel').querySelector('input');
      field.value=${JSON.stringify(term)};field.dispatchEvent(new Event('input'))})()`);
    assert.equal(await evaluate("el('studio-command-panel').open"),true);
    return evaluate(`(()=>{const item=document.querySelector('[data-studio-run="${action}"]');
      return item?{disabled:item.disabled,label:item.textContent}:null})()`);
  }
  async function runCommand(term,action) {
    const command=await searchCommand(term,action);
    assert.ok(command&&!command.disabled,action+' is enabled');
    await evaluate(`document.querySelector('[data-studio-run="${action}"]').click()`);
    assert.equal(await evaluate("el('studio-command-panel').open"),false);
  }
  await evaluate("S.zoom=3;drawClips()");
  assert.ok(await searchCommand('sigdir','fitTimeline'));
  await key('Enter');
  assert.ok(await evaluate('S.zoom>3'));
  await searchCommand('sigdir','fitTimeline');
  assert.equal(await evaluate(`document.querySelector('[data-studio-binding="fitTimeline"]').textContent`),'Ata');
  await evaluate(`document.querySelector('[data-studio-binding="fitTimeline"]').click()`);
  await key('F',['shift']);
  await waitFor(() => evaluate("StudioPreferences.get('shortcuts',{}).fitTimeline==='Shift+KeyF'"));
  await key('Escape');
  await cursor(1);
  await evaluate('S.zoom=3;drawClips()');
  await key('F',['shift']);
  assert.ok(await evaluate('S.zoom>3'),'An initially unbound command can be assigned and executed');
  const magnet=await evaluate('S.timelineMagnet');
  await runCommand('miknatis','toggleMagnet');
  assert.equal(await evaluate('S.timelineMagnet'),!magnet);
  const ripple=await evaluate('S.timelineRipple');
  await runCommand('bosluk','toggleRipple');
  assert.equal(await evaluate('S.timelineRipple'),!ripple);
  await evaluate('undoEdit()');
  assert.equal(await evaluate('S.timelineRipple'),ripple);

  for(const [name,id,panel] of [
    ['altyazi','captions','studio-captions'],['sablon','templates','studio-templates'],
    ['yazi tipi','fonts','studio-fonts'],['muzik','sounds','studio-sounds'],['medya','media','project-library'],
  ]){
    await runCommand(name,'library-'+id);
    assert.equal(await evaluate(`el('${panel}').classList.contains('hidden')`),false);
  }

  const copied=await evaluate('selectedText().text');
  await runCommand('kopyala','copy');
  assert.equal(await evaluate('timelineClipboard.item.text'),copied);
  await cursor(4);
  await runCommand('yapistir','paste');
  assert.equal(await evaluate('selectedText().start'),4);
  const id=await evaluate('selectedText().id');
  await evaluate("timelineClipboard.item.text='Panodaki özgün içerik'");
  await evaluate('seekOutputTime(2.5)');
  await waitFor(() => evaluate('Math.abs(currentOutputTime()-2.5)<.001'));
  await runCommand('cogalt','duplicate');
  assert.deepEqual(await evaluate('[selectedText().text,selectedText().start,selectedText().id!=='+JSON.stringify(id)+',timelineClipboard.item.text]'),
    [copied,2.5,true,'Panodaki özgün içerik']);
  await evaluate("toggleTrackAction('text','lock')");
  assert.equal((await searchCommand('ogeyi sil','delete')).disabled,true);
  await key('Escape');
  assert.equal(await evaluate('S.texts.length'),3);
  await evaluate("toggleTrackAction('text','lock')");
  await runCommand('ogeyi sil','delete');
  assert.equal(await evaluate('S.texts.length'),2);
  await cursor(1);
  await key('V',[mod]);
  assert.equal(await evaluate('S.texts.length'),3,'Existing native paste still fires once');
  assert.equal(await evaluate('selectedText().text'),'Panodaki özgün içerik');

  await cursor(1);
  await key('K',[mod]);
  await evaluate("el('studio-command-panel').querySelector('input').focus()");
  await key('V',[mod]);
  assert.equal(await evaluate('S.texts.length'),3,'Palette search keeps native clipboard focus');
  await key('Escape');
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
  await key(process.platform === 'win32' ? 'Y' : 'Z', process.platform === 'win32' ? [mod] : [mod, 'shift']);
  assert.equal(await evaluate('S.studioTimeline.markers.length'), 0);
  await key('Z', [mod]);
  assert.equal(await evaluate('S.studioTimeline.markers[0].name'), 'Giriş sahnesi');
  await key('Z', [mod]);
  assert.equal(await evaluate('S.studioTimeline.markers[0].name'), 'İşaretçi 1');
  await key('Z', [mod, 'shift']);
  assert.equal(await evaluate('S.studioTimeline.markers[0].name'), 'Giriş sahnesi');
  assert.equal(await evaluate("el('redo').disabled"), false);
  await key('K', [mod]);
  await evaluate(`document.querySelector('[data-studio-run="redo"]').click()`);
  assert.equal(await evaluate('S.studioTimeline.markers.length'), 0, 'Palette redo repeats the deletion');
  await cursor(2);
  await key('Z', [mod]);
  await evaluate("el('project-name').focus()");
  await key('Z', [mod, 'shift']);
  assert.equal(await evaluate('S.studioTimeline.markers.length'), 1, 'Text input receives native redo');
  await cursor(2);
  await key('X', ['alt']);
  assert.equal(await evaluate('S.studioTimeline.range'), null);
  assert.equal(await evaluate('S.redoHistory.length'), 0, 'New edit clears later history');
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
  await evaluate('setExportModal(false);persistProjectRecovery()');
  const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await loaded;
  await evaluate('projectWorkspaceInitialization');
  assert.deepEqual(await evaluate('S.studioTimeline.range'), { in: 1.5, out: 3 });
  assert.deepEqual(await evaluate('[S.history.length,S.redoHistory.length]'), [0, 0]);
  await evaluate('switchTimeline("two")');
  assert.deepEqual(await evaluate('[S.studioTimeline,S.history.length,S.redoHistory.length]'), [null, 0, 0]);
  await checkInspectorHistory();
  await checkExpandedPalette();
  console.log('Native shortcuts, command palette, preference edits, per-timeline range and inspector undo/redo verified.');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  window?.destroy();
  server?.closeAllConnections();
  server?.close();
  app.exit(process.exitCode || 0);
});
