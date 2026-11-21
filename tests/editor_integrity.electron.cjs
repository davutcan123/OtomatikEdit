'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-integrity-'));
const ffmpeg = process.env.SMART_EDITOR_FFMPEG || 'ffmpeg';
app.setPath('userData', path.join(temp, 'profile'));
app.commandLine.appendSwitch('force-color-profile', 'srgb');
const projects = new Map(), requests = [], deferred = new Map(), streams = new Map();
let win, server, video;
const evaluate = code => win.webContents.executeJavaScript(code);
const json = JSON.stringify;

async function waitFor(check, label) {
  for (let i = 0; i < 200; i++) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for ' + label);
}

async function click(selector) {
  await evaluate(`void document.querySelector(${json(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const point = await evaluate(`(() => {
    const target=document.querySelector(${json(selector)});
    const {x,y,width,height}=target.getBoundingClientRect();
    const center={x:Math.round(x+width/2),y:Math.round(y+height/2)};
    return {...center,reachable:target.contains(document.elementFromPoint(center.x,center.y))};
  })()`);
  assert.ok(point.reachable, 'Reachable control ' + selector);
  for (const type of ['mouseDown', 'mouseUp']) {
    win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, x:point.x, y:point.y });
  }
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}

async function change(id, value) {
  await evaluate(`el(${json(id)}).value=${json(value)};el(${json(id)}).dispatchEvent(new Event('change',{bubbles:true}))`);
}

async function setProjectSelection(id) {
  await evaluate(`el('project-list').value=${json(id)}`);
}

function deliver(jobId, data) {
  const stream = streams.get(jobId);
  assert.ok(stream, 'result stream is open for ' + jobId);
  stream.end('data: ' + json({ type: 'result', data }) + '\n\n');
  streams.delete(jobId);
}

async function chooseProjectLeave(choice) {
  await waitFor(() => evaluate("el('project-leave-dialog').open"), 'unsaved changes dialog');
  await click(`#project-leave-dialog [value="${choice}"]`);
  await waitFor(async () => !await evaluate("el('project-leave-dialog').open"), 'unsaved changes dialog to close');
}

async function checkProjectRaces() {
  await evaluate("el('project-name').value='A';createTimeline()");
  await click('#project-save');
  await waitFor(() => deferred.get('save-A'), 'delayed save A');
  await click('#project-new');await chooseProjectLeave('discard');
  await waitFor(() => evaluate("el('project-name').value==='Adsız proje'"), 'new workspace');
  deferred.get('save-A')();
  await waitFor(() => evaluate("[...el('project-list').options].some(option=>option.value==='A')"), 'late save A in project list');
  assert.equal(await evaluate('S.projectId'), null);

  await evaluate(`el('project-name').value='B';S.texts.push({...TEXT_STYLES.classic,id:'text',text:'Saved inactive timeline',start:0,end:1});createTimeline();
    autoResult({duration:8,valid_segments:[{start:0,end:4}]},'source.mp4','Analysis')`);
  await click('#project-new');await chooseProjectLeave('cancel');
  assert.equal(await evaluate("el('project-name').value"), 'B');
  await click('#project-new');await chooseProjectLeave('save');
  await waitFor(() => evaluate("el('project-name').value==='Adsız proje'"), 'save then clear');
  const savedB = requests.find(project => project.name === 'B');
  assert.equal(savedB.id, null, 'B must not update the late A project ID');
  assert.equal(savedB.timelines[0].state.texts[0].text, 'Saved inactive timeline');
  assert.equal(savedB.autoCutter.data.valid_segments.length, 1);
  assert.equal(projects.get('A').name, 'A');

  await setProjectSelection('A');await click('#project-load');
  await waitFor(() => deferred.get('load-A'), 'delayed open A');
  await setProjectSelection('B');await click('#project-load');
  await waitFor(() => evaluate("S.projectId==='B'"), 'B opens first');
  deferred.get('load-A')();
  await waitFor(() => evaluate("JSON.parse(localStorage.getItem(RECOVERY_KEY)).id==='B'"), 'B recovery persisted');
  assert.equal(await evaluate('S.projectId'), 'B', 'late open A does not replace B');

  await setProjectSelection('A');await evaluate("void(window.confirm=()=>true)");await click('#project-delete');
  await waitFor(() => deferred.get('delete-A'), 'delayed deletion A');
  await click('#project-new');
  await waitFor(() => evaluate("!S.projectId"), 'new workspace during deletion');
  deferred.get('delete-A')();
  await waitFor(async () => !await evaluate("el('project-delete').disabled"), 'deletion completed');
  assert.equal(await evaluate("el('project-save-state').textContent"), 'Otomatik kurtarma açık');

  await evaluate("el('project-name').value='Failed save'");
  await click('#project-new');await chooseProjectLeave('save');
  await waitFor(() => evaluate("el('project-save-state').textContent==='Kayıt hatası'"), 'save failure');
  assert.equal(await evaluate("el('project-name').value"), 'Failed save');
}

async function seedTimeline() {
  await evaluate(`restoreProject({
    name:'Edit fixture', activeTimelineId:'TL1', timelines:[
      {id:'TL1',name:'Main',state:{...emptyTimelineState(),manualId:'source.mp4',duration:12,selected:0,preview:0,clips:[
        {clipId:'first',start:0,end:4,timelineStart:0,sourceDuration:12,fileId:'source.mp4',zoomKeyframes:[{id:'Z1',time:0,scale:100,x:50,y:50,opacity:100}]},
        {clipId:'second',start:4,end:7,timelineStart:4,sourceDuration:12,fileId:'source.mp4'}
      ]}}, {id:'TL2',name:'Second',state:emptyTimelineState()}
    ]
  })`);
}

async function checkTimingLocksAndPixels() {
  await seedTimeline();
  const state = () => evaluate("S.clips.map(c=>[c.clipId,c.start,c.end,c.timelineStart,c.speed])");
  const initial = await state();
  await evaluate("S.selectedVideoClipIds=['first','second']");
  await change('clip-speed', '0.5');
  assert.deepEqual(await state(), initial);
  assert.deepEqual(await evaluate('S.selectedVideoClipIds'), ['first', 'second']);
  assert.match(await evaluate("el('manual-log-summary').textContent"), /çakışır/);
  await change('clip-end', '5');await evaluate("el('trim').click()");
  assert.deepEqual(await state(), initial);
  await evaluate("move(1)");
  assert.deepEqual((await state()).map(([id,,,start]) => [id,start]), [['second',0],['first',3]]);
  await evaluate("undoEdit();toggleVideoRipple()");
  await change('clip-speed', '0.5');
  assert.equal((await state())[1][3], 8);
  await change('clip-end', '5');await evaluate("el('trim').click()");
  assert.equal((await state())[1][3], 10);
  await evaluate("videoTrackState(1).locked=true;S.selectedZoomKeyframe=S.clips[0].zoomKeyframes[0].id;drawClips()");
  const locked = await evaluate("JSON.stringify(S.clips[0].zoomKeyframes)");
  for (const id of ['zoom-keyframe-delete', 'zoom-keyframes-clear', 'clip-settings-reset']) {
    assert.ok(await evaluate(`el(${json(id)}).disabled`));
    await evaluate(`el(${json(id)}).onclick()`);
  }
  assert.equal(await evaluate('JSON.stringify(S.clips[0].zoomKeyframes)'), locked);

  await seedTimeline();
  await waitFor(() => evaluate('mv.readyState>=2&&!mv.seeking'), 'source video');
  await evaluate('seekOutputTime(1)');
  await change('clip-background-mode', 'chroma');
  const pixels = await waitFor(() => evaluate(`(() => {
    const frame=document.querySelector('.composite-layer[data-clip-id="first"] canvas');
    if (!frame?.dataset.sourceTime) return null;
    const ctx=frame.getContext('2d');
    return [.25,.75].map(x=>[...ctx.getImageData(Math.floor(frame.width*x),frame.height>>1,1,1).data]);
  })()`), 'chroma preview pixels');
  assert.equal(pixels[0][3], 0, 'green must be transparent');
  assert.ok(pixels[1][0] > 220 && pixels[1][3] === 255, 'red must remain opaque');
  assert.equal(await evaluate("manualExportData().options.timelineComposite"), true);
  assert.equal(await evaluate("manualExportData().clips[0].backgroundMode"), 'chroma');
  await change('clip-background-mode', 'none');
  await waitFor(() => evaluate("el('video-composite').hidden&&mv.readyState>=2&&!mv.seeking"), 'unkeyed source video');
  assert.ok(await evaluate('Math.abs(mv.currentTime-1)<.08'), 'toggling off preserves playhead');
  const output = execFileSync(ffmpeg, ['-v','error','-i',path.join(temp,'source.mp4'),'-vf',
    'format=yuva420p,chromakey=0x00ff00:0.25:0.08,alphaextract','-frames:v','1','-pix_fmt','gray','-f','rawvideo','-']);
  assert.equal(output[80*320+80], pixels[0][3]);
  assert.equal(output[80*320+240], pixels[1][3]);
}

async function checkAsyncResults() {
  await seedTimeline();
  const cues = { cues: [{ start: 0, end: 1, text: 'First clip' }] };
  await evaluate('el("subtitle-generate").click()');
  await waitFor(() => streams.has('subtitle-1'), 'first subtitle stream');
  await evaluate('switchTimeline("TL2")');
  deliver('subtitle-1', cues);
  assert.equal(await evaluate('S.texts.length'), 0);
  assert.match(await evaluate("el('subtitle-status').textContent"), /önceki altyazı analizi uygulanmayacak/);
  await evaluate('switchTimeline("TL1");el("subtitle-generate").click()');
  await waitFor(() => streams.has('subtitle-2'), 'second subtitle stream');
  deliver('subtitle-2', cues);
  await waitFor(() => evaluate('S.texts[0]?.text==="First clip"'), 'subtitle application');

  await evaluate("setAutoFile(new File(['x'],'source.mp4',{type:'video/mp4'}));el('analyze').click()");
  await waitFor(() => streams.has('auto-1'), 'malformed auto-cutter stream');
  deliver('auto-1', { duration: 8, valid_segments: [{ start: 'broken', end: 2 }] });
  await waitFor(async () => !await evaluate('S.autoAnalyzing'), 'rejected analysis resets');
  assert.equal(await evaluate('S.autoData'), null);
  assert.equal(await evaluate("el('analyze').disabled"), false);
  await evaluate("el('analyze').click()");
  await waitFor(() => streams.has('auto-2'), 'empty auto-cutter stream');
  deliver('auto-2', { duration: 8, valid_segments: [] });
  await waitFor(() => evaluate("S.autoData?.valid_segments.length===0&&!S.autoAnalyzing"), 'empty analysis resolves');
  assert.ok(await evaluate("el('to-manual').disabled&&el('auto-render').disabled"));
  await evaluate("el('analyze').click()");
  await waitFor(() => streams.has('auto-3'), 'stale auto-cutter stream');
  await seedTimeline();
  deliver('auto-3', { duration: 8, valid_segments: [{ start: 0, end: 5 }] });
  await evaluate("new Promise(resolve=>setTimeout(resolve,75))");
  assert.equal(await evaluate('S.autoData'), null);
  assert.equal(await evaluate("el('analyze').disabled"), true);
}

function serve() {
  const counts = { subtitle: 0, auto: 0 };
  let delayedOpen = true;
  return http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://fixture').pathname;
    const reply = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' });res.end(json(value)); };
    if (route === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });res.end(fs.readFileSync(path.join(root, 'templates/index.html')));
    } else if (route.startsWith('/static/')) {
      const filename = path.join(root, 'static', path.basename(route));
      if (!fs.existsSync(filename)) return res.writeHead(204).end();
      res.writeHead(200, { 'Content-Type': route.endsWith('.css') ? 'text/css' : 'text/javascript' });
      res.end(fs.readFileSync(filename));
    } else if (route === '/video/source.mp4') {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start = range ? +range[1] : 0, end = range?.[2] ? Math.min(+range[2], video.length - 1) : video.length - 1;
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1, ...(range && { 'Content-Range': `bytes ${start}-${end}/${video.length}` }) });
      res.end(video.subarray(start, end + 1));
    } else if (route === '/projects' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const project = JSON.parse(Buffer.concat(chunks));requests.push(project);
      if (project.name === 'Failed save') return reply({ detail: 'Fixture disk full' }, 500);
      const id = project.id || project.name;
      const save = () => { projects.set(id, { ...project,id });reply({ id }); };
      if (project.name === 'A') deferred.set('save-A',save);else save();
    } else if (route === '/projects') {
      reply({ projects: [...projects.values()].map(({ id, name, timelines }) => ({ id, name, timeline_count: timelines.length })) });
    } else if (route.startsWith('/projects/')) {
      const id = route.split('/').at(-1);
      if (req.method === 'DELETE') deferred.set('delete-' + id, () => { projects.delete(id);reply({ deleted: true }); });
      else if (id === 'A' && delayedOpen) { delayedOpen = false;deferred.set('load-A', () => reply(projects.get(id))); }
      else reply(projects.get(id));
    } else if (route === '/upload') {
      for await (const chunk of req) { void chunk; }
      reply({ file_id: 'source.mp4' });
    } else if (route === '/start-analysis' || route === '/start-subtitles') {
      for await (const chunk of req) { void chunk; }
      const type = route === '/start-analysis' ? 'auto' : 'subtitle';
      reply({ job_id: type + '-' + ++counts[type] });
    } else if (route.startsWith('/stream-events/')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': fixture stream open\n\n');
      streams.set(route.split('/').at(-1), res);
    } else if (route.startsWith('/api/')) reply({ version: 'fixture', update_available: false });
    else res.writeHead(204).end();
  });
}

app.whenReady().then(async () => {
  const fixture = path.join(temp, 'source.mp4');
  execFileSync(ffmpeg, ['-v','error','-f','lavfi','-i','color=0x00FF00:s=320x180:r=24:d=12',
    '-vf','drawbox=x=160:y=0:w=160:h=180:color=red:t=fill','-c:v','libx264','-pix_fmt','yuv420p',fixture], { timeout: 30000 });
  video = fs.readFileSync(fixture);
  server = serve();await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  win = new BrowserWindow({ show: false, width: 1366, height: 768,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await win.loadURL('http://127.0.0.1:' + server.address().port);
  await evaluate('projectWorkspaceInitialization');
  win.showInactive();
  await checkProjectRaces();
  await checkTimingLocksAndPixels();
  await checkAsyncResults();
  console.log('Verified project races, unsaved edits, clip collision and lane locks, chroma pixels, and delayed or invalid analysis.');
}).catch(async error => {
  console.error(error);
  if(win)console.error(await evaluate(`({name:el('project-name').value, id:S.projectId, status:el('project-save-state').textContent,
    action:el('project-leave-dialog').returnValue, mainLog:el('manual-log-summary').textContent, autoLog:el('auto-log').textContent})`).catch(()=>{}));
  process.exitCode = 1;
}).finally(() => {
  win?.destroy();server?.closeAllConnections();server?.close();
  fs.rmSync(temp, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
