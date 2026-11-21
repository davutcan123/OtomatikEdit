'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'otomatik-render-stop-native-'));
app.setPath('userData', path.join(fixture, 'profile'));
const dataDir = path.join(fixture, 'data');
const outputDir = path.join(dataDir, 'outputs');
const source = 'real-source.mp4';
const headers = {'X-Desktop-Token':randomBytes(24).toString('hex')};
let backend, origin, win, diagnostics = '';
const saves = [];
const evaluate = code => win.webContents.executeJavaScript(code);
const frames = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');

async function until(check, label, timeout = 15000) {
  for (let deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('Timed out waiting for ' + label);
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject);probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function seedSource() {
  const packaged = path.join(root, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
  const ffmpeg = process.env.SMART_EDITOR_FFMPEG || (process.platform === 'win32' && fs.existsSync(packaged) ? packaged : 'ffmpeg');
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive:true });
  execFileSync(ffmpeg, ['-v','error','-y','-f','lavfi','-i','color=blue:s=320x180:r=24:d=4',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v','libx264','-threads:v','2','-pix_fmt','yuv420p','-c:a','aac','-shortest',path.join(dataDir,'uploads',source)],
    {timeout:25_000,windowsHide:true});
}

async function startBackend() {
  const port = await freePort();
  origin = 'http://127.0.0.1:' + port;
  const candidates = process.platform === 'win32'
    ? [path.join(root,'.venv-windows','Scripts','python.exe'),path.join(root,'venv','Scripts','python.exe'),'python']
    : [path.join(root,'venv','bin','python'),'python3'];
  const python = process.env.SMART_EDITOR_PYTHON || candidates.find(item => fs.existsSync(item)) || candidates.at(-1);
  // Make only the first encode of each format deliberately slow. The editor,
  // SSE server, stop endpoint and all subprocesses are the actual application.
  const bootstrap = [
    'import os, pathlib, uvicorn',
    'import app as backend',
    'spawn_media = backend.create_media_process',
    'slow_first = {"output.mp4", "output.png", "output.webm"}',
    'async def slow_encoder(*args, **kwargs):',
    '    basename = pathlib.Path(args[-1]).name',
    '    slow = basename in slow_first',
    '    if slow:',
    '        slow_first.remove(basename)',
    '        i = args.index("-i")',
    '        args = (*args[:i], "-readrate", "0.08", *args[i:])',
    '    process = await spawn_media(*args, **kwargs)',
    '    if slow: print("STOP_TEST_STARTED", basename, process.pid, flush=True)',
    '    return process',
    'backend.create_media_process = slow_encoder',
    'uvicorn.run(backend.app, host="127.0.0.1", port=int(os.environ["SMART_EDITOR_PORT"]))',
  ].join('\n');
  backend = spawn(python,['-c',bootstrap],{
    cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,SMART_EDITOR_DESKTOP:'1',SMART_EDITOR_DESKTOP_TOKEN:headers['X-Desktop-Token'],
      SMART_EDITOR_DATA_DIR:dataDir,SMART_EDITOR_LEGACY_DIR:'',SMART_EDITOR_PORT:String(port),SMART_EDITOR_LOW_MEMORY_RENDER:'1'},
  });
  let launchError;
  backend.on('error',error=>{launchError=error});
  for(const pipe of [backend.stdout,backend.stderr])pipe.on('data',chunk=>{diagnostics+=chunk});
  await until(async()=>{
    if(launchError) throw launchError;
    if(backend.exitCode!==null) throw new Error('Backend exited early');
    return (await fetch(origin+'/api/health',{headers}).catch(()=>null))?.ok;
  },'isolated desktop backend');
}

async function closeBackend() {
  if (!backend?.pid || backend.exitCode !== null) return;
  const finished = new Promise(resolve => backend.once('exit', resolve));
  backend.kill();
  await Promise.race([finished, new Promise(resolve => setTimeout(resolve, 2000))]);
  if (backend.exitCode === null && backend.signalCode === null) backend.kill('SIGKILL');
  await finished;
}

async function click(selector) {
  const encoded = JSON.stringify(selector);
  await evaluate(`void document.querySelector(${encoded}).scrollIntoView({block:'nearest',inline:'nearest'})`);
  await frames();
  const point = await evaluate(`(()=>{const node=document.querySelector(${encoded}),r=node.getBoundingClientRect();
    const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
    return {x,y,reachable:!node.disabled&&node.contains(document.elementFromPoint(x,y))}})()`);
  assert.ok(point.reachable, 'Reachable output control ' + selector);
  for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:point.x,y:point.y});
  await frames();
}

const waitEncoder = name => until(() => diagnostics.includes('STOP_TEST_STARTED output.' + name + ' '), 'running FFmpeg ' + name);

async function exportVideo() {
  await click('#manual-render-top');
  await evaluate("el('export-hardware').value='cpu';el('export-quality').value='draft'");
  await click('#export-render-start');
}

app.whenReady().then(async()=>{
  let recovery = null;
  ipcMain.handle('desktop:save-recovery',(_event,value)=>{recovery=value});
  ipcMain.handle('desktop:load-recovery',()=>recovery);
  ipcMain.handle('desktop:storage-info',()=>({path:dataDir}));
  ipcMain.handle('desktop:update-state',()=>({mode:'disabled',status:'idle'}));
  ipcMain.handle('desktop:save-output',(_event,link)=>{saves.push(link);return {saved:false,canceled:true}});
  seedSource();
  await startBackend();
  win = new BrowserWindow({show:false,width:1440,height:900,webPreferences:{
    preload:path.join(root,'desktop','preload.cjs'),sandbox:true,contextIsolation:true,backgroundThrottling:false,
  }});
  win.webContents.session.webRequest.onBeforeSendHeaders((details,callback)=>{
    callback({requestHeaders:new URL(details.url).origin===origin?{...details.requestHeaders,...headers}:details.requestHeaders});
  });
  await win.loadURL(origin);
  await evaluate('projectWorkspaceInitialization');
  win.showInactive();
  await evaluate(`restoreProject({name:'İptal denemesi',activeTimelineId:'one',timelines:[
    {id:'one',name:'İlk kesim',state:{...emptyTimelineState(),manualId:'${source}',manualName:'Mavi',canvas:{width:1280,height:720},
      selected:0,preview:0,clips:[{clipId:'a',start:0,end:3,sourceDuration:4,fileId:'${source}',timelineStart:0}]}},
    {id:'two',name:'İkinci kesim',state:emptyTimelineState()},
  ]});seekOutputTime(.9)`);
  await exportVideo();
  await waitEncoder('mp4');
  await click('#snapshot-open');
  await evaluate("el('snapshot-quality').value='1280'");
  await click('#snapshot-save');
  await waitEncoder('png');
  await click('#snapshot-stop');
  await until(() => evaluate("el('snapshot-status').textContent==='Dışa aktarma durduruldu.'"), 'cancelled PNG');
  assert.equal(await evaluate("el('manual-stop').hidden"),false,'The video job is still running');

  await click('[data-timeline-id="two"]');
  assert.equal(await evaluate("el('manual-stop').hidden"),true,'Stop is not shown in an unrelated timeline');
  await click('#recent-outputs-open');
  assert.match(await evaluate("el('active-output-list').textContent"),/İptal denemesi.*İlk kesim/);
  await click('#active-output-list [data-output-stop="manual"]');
  await until(() => evaluate("el('active-output-section').hidden"), 'stopped background timeline export');
  assert.match(await evaluate("el('active-output-announcement').textContent"),/durduruldu.*İlk kesim/);
  await click('#recent-outputs-dialog form button');
  await click('[data-timeline-id="one"]');
  assert.equal(await evaluate("el('manual-progress-top').dataset.state"),'cancelled');
  assert.equal(await evaluate('outputJobs.recent().length'),0);
  assert.deepEqual(fs.readdirSync(outputDir).filter(name=>name.startsWith('out_')||name.startsWith('.render-')),[]);
  assert.deepEqual(saves,[]);

  await exportVideo();
  await until(() => saves[0], 'successful retry');
  const output = await fetch(origin + saves[0], {headers});
  assert.ok(output.ok);
  assert.equal(Buffer.from(await output.arrayBuffer()).subarray(4,8).toString(),'ftyp');

  await evaluate(`autoResult({duration:4,valid_segments:[{start:0,end:3}]},'${source}','Otomatik örnek');switchTab('auto');
    el('auto-format').value='webm'`);
  await click('#auto-render');
  await waitEncoder('webm');
  await click('#auto-stop');
  await until(() => evaluate("el('auto-progress').dataset.state==='cancelled'"), 'cancelled automatic trim output');
  assert.equal(await evaluate('outputJobs.recent().length'),1,'Prior successful render remains accessible');
  assert.equal(fs.readdirSync(outputDir).filter(name=>name.startsWith('out_')).length,1);
  assert.equal(fs.readdirSync(outputDir).filter(name=>name.startsWith('.render-')).length,0);
  console.log('Native video, snapshot and automatic cutoff stopped real FFmpeg; only the successful video retry was delivered.');
}).catch(error=>{
  console.error(error);
  console.error(diagnostics.split('\n').slice(-25).join('\n'));
  process.exitCode=1;
}).finally(async()=>{
  win?.destroy();
  await closeBackend();
  app.exit(process.exitCode||0);
});
