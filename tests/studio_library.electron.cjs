'use strict';

// Exercise the bundled media, renderer and FFmpeg with an isolated backend and real Electron inputs.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname,'..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(),'otomatik-studio-library-'));
const token = crypto.randomBytes(24).toString('hex');
const headers = {'X-Desktop-Token':token};
const backendLines = [];
let backend, win, origin;
const evaluate = code => win.webContents.executeJavaScript(code);
const frames = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');

async function waitFor(check,label,limit=12000) {
  const deadline = Date.now()+limit;
  while(Date.now()<deadline){
    const value = await check();
    if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,35));
  }
  throw new Error('Timed out waiting for '+label);
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve)});
  const {port} = socket.address();
  await new Promise(resolve=>socket.close(resolve));
  return port;
}
async function startBackend() {
  const port = await freePort();
  const pythonCandidates = process.platform==='win32'
    ? [path.join(root,'.venv-windows','Scripts','python.exe'),path.join(root,'venv','Scripts','python.exe'),'python']
    : [path.join(root,'venv','bin','python'),'python3'];
  const python = process.env.SMART_EDITOR_PYTHON || pythonCandidates.find(candidate=>fs.existsSync(candidate)) || pythonCandidates.at(-1);
  origin = 'http://127.0.0.1:'+port;
  backend = spawn(python,[path.join(root,'app.py')],{cwd:root,windowsHide:true,
    env:{...process.env,PYTHONUNBUFFERED:'1',SMART_EDITOR_DESKTOP:'1',SMART_EDITOR_DESKTOP_TOKEN:token,
      SMART_EDITOR_DATA_DIR:path.join(artifacts,'data'),SMART_EDITOR_LEGACY_DIR:'',SMART_EDITOR_PORT:String(port),SMART_EDITOR_OPEN_BROWSER:'0'},
    stdio:['ignore','pipe','pipe']});
  let spawnError;
  backend.on('error',error=>{spawnError=error});
  for(const stream of [backend.stdout,backend.stderr])stream.on('data',data=>backendLines.push(String(data)));
  await waitFor(async()=>{
    if(spawnError)throw spawnError;
    if(backend.exitCode!==null)throw new Error('Backend stopped before startup');
    return (await fetch(origin+'/api/health',{headers}).catch(()=>null))?.ok;
  },'studio backend');
}
async function stopBackend() {
  if(!backend||backend.exitCode!==null||!backend.pid)return;
  const stopped=new Promise(resolve=>backend.once('exit',resolve));
  backend.kill();
  await Promise.race([stopped,new Promise(resolve=>setTimeout(resolve,2000))]);
  if(backend.exitCode===null){
    backend.kill('SIGKILL');
    await stopped;
  }
}
async function point(selector) {
  await evaluate(`void document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);
  await frames();
  const result = await evaluate(`(()=>{
    const node=document.querySelector(${JSON.stringify(selector)}),rect=node.getBoundingClientRect();
    const x=Math.round(rect.left+rect.width/2),y=Math.round(rect.top+rect.height/2);
    return {x,y,reachable:!node.disabled&&node.contains(document.elementFromPoint(x,y))};
  })()`);
  assert.ok(result.reachable,'Reachable control '+selector);
  return {x:result.x,y:result.y};
}
const send = (type,position) => win.webContents.sendInputEvent({type,button:'left',clickCount:1,...position});
async function click(selector) {
  const at = await point(selector);
  send('mouseDown',at);send('mouseUp',at);await frames();
}
async function search(value) {
  await evaluate(`el('studio-asset-search').value=${JSON.stringify(value)};el('studio-asset-search').dispatchEvent(new Event('input',{bubbles:true}))`);
}
async function screenshot(name) {
  fs.writeFileSync(path.join(artifacts,name+'.png'),(await win.webContents.capturePage()).toPNG());
}

async function renderColorSample(name) {
  const job = await evaluate(`(async()=>{
    const data=manualExportData();data.resolution={width:320,height:180};
    data.options.hardware='cpu';data.options.fps=24;data.clips[0].end=1;
    const response=await fetch('/start-render',{method:'POST',body:buildRenderForm(data)});
    if(!response.ok)throw new Error(await response.text());
    return events((await response.json()).job_id,()=>{});
  })()`);
  const download = await fetch(origin+job.download_url,{headers});
  assert.ok(download.ok);
  const filename = path.join(artifacts,name+'.mp4');
  fs.writeFileSync(filename,Buffer.from(await download.arrayBuffer()));
  const packagedFFmpeg = path.join(root,'tools','ffmpeg','bin','ffmpeg.exe');
  const ffmpeg = process.env.SMART_EDITOR_FFMPEG || (process.platform==='win32'&&fs.existsSync(packagedFFmpeg)?packagedFFmpeg:'ffmpeg');
  const rgb = execFileSync(ffmpeg,['-v','error','-i',filename,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-'],{timeout:12000});
  let sum=0;
  for(let i=0;i<rgb.length;i+=3)sum+=Math.max(rgb[i],rgb[i+1],rgb[i+2])-Math.min(rgb[i],rgb[i+1],rgb[i+2]);
  return sum/(rgb.length/3);
}

async function checkPlayerAndLooks() {
  assert.equal(await evaluate('mv.controls'),false);
  assert.ok(await evaluate('el("studio-play-toggle").disabled'));
  await click('#studio-add-demo');
  await waitFor(()=>evaluate('S.clips.length===1 && mv.readyState>=2 && !mv.seeking'),'example upload and video decode');
  const sample = await evaluate('({zoom:S.zoom,duration:S.clips[0].end,file:S.clips[0].fileId})');
  assert.ok(sample.zoom>=50 && sample.duration>7 && sample.file.endsWith('_alpine-tour.mp4'));
  await click('#studio-play-toggle');
  await waitFor(()=>evaluate('!mv.paused && mv.currentTime>.05'),'visible play control');
  await click('#studio-play-toggle');
  assert.ok(await evaluate('mv.paused && el("studio-play-toggle").getAttribute("aria-label")==="Oynat"'));

  await click('[data-asset-tab="filter"]');
  assert.equal(await evaluate('document.querySelectorAll("[data-studio-look]").length'),10);
  await search('film gumus');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#studio-look-groups [data-studio-item]:not([hidden])")].map(node=>node.dataset.studioItem)'),['look:silver-print']);
  await click('[data-studio-favorite="look:silver-print"]');
  await search('');await click('#studio-favorites');
  assert.equal(await evaluate('document.querySelectorAll("#studio-look-groups [data-studio-item]:not([hidden])").length'),1);
  const before = await renderColorSample('alpine-original');
  await click('[data-studio-look="silver-print"]');
  assert.equal(await evaluate('S.clips[0].saturation'),0);
  assert.equal(await evaluate('el("manual-video").style.filter.includes("saturate(0)")'),true);
  assert.equal(await evaluate('document.querySelector("[data-studio-look=silver-print]").getAttribute("aria-pressed")'),'true');
  const after = await renderColorSample('alpine-silver-print');
  assert.ok(before>15&&after<3,`Rendered chroma before ${before}, after ${after}`);
  await screenshot('looks-applied-1440x900');
  await evaluate('undoEdit()');
  assert.equal(await evaluate('S.clips[0].saturation'),100);
  await evaluate('videoTrackState(1).locked=true;drawClips()');
  await click('[data-studio-look="silver-print"]');
  assert.equal(await evaluate('S.clips[0].saturation'),100);
  await evaluate('videoTrackState(1).locked=false;drawClips()');
  await click('#studio-favorites');
  await search('krem');
  const from = await point('[data-studio-look="cream-studio"]'), target = await point('#video-track-1 .clip');
  send('mouseDown',from);send('mouseMove',{x:from.x+14,y:from.y+10});await frames();
  send('mouseMove',target);await frames();send('mouseUp',target);await frames();
  assert.equal(await evaluate('S.clips[0].brightness'),111,'Drag applies the look to the actual video clip');
  return {before,after,initialZoom:sample.zoom};
}

async function checkPersonalLooks() {
  await search('');
  await evaluate(`remember();Object.assign(S.clips[0],{brightness:117,saturation:0,temperature:24,relight:6});drawClips()`);
  const snapshotDepth=await evaluate('S.history.length');
  await click('#studio-look-save');
  await evaluate(`document.querySelector('#studio-look-editor input').value='Özel Film';
    document.querySelector('#studio-look-editor form').requestSubmit()`);
  await waitFor(()=>evaluate("!el('studio-look-editor').open&&StudioPreferences.get('savedLooks',[]).length===1"),'saved personal look');
  const item=await evaluate("StudioPreferences.get('savedLooks')[0]");
  assert.equal(item.name,'Özel Film');assert.equal(item.color.brightness,117);
  assert.equal(item.color.saturation,0);assert.equal(item.color.relight,6);
  assert.equal(await evaluate('S.history.length'),snapshotDepth,'Saving a preset leaves edit history alone');
  const preview=await evaluate(`document.querySelector('[data-studio-look="${item.id}"] img').style.filter`);
  assert.match(preview,/saturate\(0\)/);
  await search('ozel film');
  assert.equal(await evaluate('document.querySelectorAll("#studio-look-groups [data-studio-item]:not([hidden])").length'),1);
  await click(`[data-studio-favorite="look:${item.id}"]`);
  await click(`[data-studio-look-edit="${item.id}"]`);
  await evaluate(`document.querySelector('#studio-look-editor input').value='Kişisel Mono';
    document.querySelector('#studio-look-editor form').requestSubmit()`);
  await waitFor(()=>evaluate("!el('studio-look-editor').open&&StudioPreferences.get('savedLooks')[0].name==='Kişisel Mono'"),'renamed personal look');
  await search('kisisel mono');
  await evaluate(`Object.assign(S.clips[0],{brightness:100,saturation:100,temperature:0,relight:0});drawClips()`);
  await click(`[data-studio-look="${item.id}"]`);
  assert.equal(await evaluate('S.clips[0].temperature'),24);
  assert.equal(await evaluate('S.clips[0].saturation'),0);
  assert.ok(await renderColorSample('personal-monochrome')<3,'Personal look is applied in the rendered file');
  await evaluate('undoEdit()');
  assert.equal(await evaluate('S.clips[0].saturation'),100);
  assert.equal(await evaluate('S.clips[0].temperature'),0);
  await evaluate('redoEdit()');
  assert.equal(await evaluate('S.clips[0].saturation'),0);
  return item.id;
}

async function checkCatalogSelection() {
  const target={type:'audio',id:await evaluate('S.audioLayers[0].id')};
  await evaluate(`S.selected=S.preview=0;S.selectedLayer=${JSON.stringify(target)};drawClips()`);
  const original=await evaluate('({clip:JSON.stringify(S.clips[0]),history:S.history.length})');
  for(const [section,selector] of [
    ['video','[data-video-effect=cyberpunk]'],['filter','[data-filter=golden]'],
    ['animation','[data-animation=fadein]'],['transition','[data-transition=fade]']
  ]){
    await click(`[data-asset-tab="${section}"]`);
    await click(selector);
    assert.deepEqual(await evaluate('({clip:JSON.stringify(S.clips[0]),history:S.history.length})'),original);
    assert.match(await evaluate('el("manual-log-summary").textContent'),/seçin/);
  }
  await click('[data-asset-tab="filter"]');
  assert.equal(await evaluate('el("studio-look-save").disabled'),true);
  await search('altin');
  const from=await point('[data-filter=golden]'),to=await point('#video-track-1 .clip');
  send('mouseDown',from);send('mouseMove',{x:from.x+14,y:from.y+10});await frames();
  send('mouseMove',to);await frames();send('mouseUp',to);await frames();
  assert.equal(await evaluate('S.clips[0].filter'),'golden','An explicit drop on a video still applies the filter');
  await evaluate('undoEdit()');
}

async function checkLookAfterBackendReopen(id){
  const storedOrigin=origin;
  await evaluate('persistProjectRecovery()');
  await stopBackend();
  await startBackend();
  assert.notEqual(origin,storedOrigin,'Preference recovery uses another loopback port');
  let releaseRead;
  const interception=win.webContents.session.webRequest;
  const endpoint=origin+'/api/desktop/studio-preferences';
  interception.onBeforeRequest({urls:[endpoint]},(details,callback)=>{
    if(details.method==='GET'&&!releaseRead)releaseRead=callback;
    else callback({});
  });
  try {
    await win.loadURL(origin);
    await waitFor(()=>releaseRead,'cold native preferences GET');
    assert.deepEqual(await evaluate("StudioPreferences.get('favorites',[])"),[]);
    await click('[data-asset-tab="filter"]');
    await click('[data-studio-favorite="look:cream-studio"]');
    const prior=(await (await fetch(endpoint,{headers})).json()).favorites;
    assert.ok(prior.includes('look:silver-print')&&prior.includes('look:'+id)&&!prior.includes('look:cream-studio'));
    releaseRead({});
    await evaluate('Promise.all([projectWorkspaceInitialization,StudioPreferences.ready])');
    await waitFor(async()=>{
      const saved=(await (await fetch(endpoint,{headers})).json()).favorites;
      return prior.every(key=>saved.includes(key))&&saved.includes('look:cream-studio');
    },'all favorites preserved when a cold first click precedes disk hydration');
  } finally {
    interception.onBeforeRequest(null);
  }
  await click('[data-asset-tab="filter"]');
  await search('kisisel mono');
  assert.equal(await evaluate(`document.querySelector('[data-studio-look="${id}"] strong').textContent`),'Kişisel Mono');
  assert.equal(await evaluate(`document.querySelector('[data-studio-favorite="look:${id}"]').getAttribute('aria-pressed')`),'true');
  await click(`[data-studio-look-edit="${id}"]`);
  await click('[data-look-delete]');
  assert.equal(await evaluate('el("studio-look-editor").open'),true);
  await click('[data-look-delete]');
  await waitFor(()=>evaluate("!el('studio-look-editor').open&&StudioPreferences.get('savedLooks',[]).length===0"),'deleted personal look');
  await waitFor(()=>evaluate(`!StudioPreferences.get('favorites',[]).includes('look:${id}')`),'removed deleted favorite');
  await waitFor(async()=>{
    const stored=await (await fetch(origin+'/api/desktop/studio-preferences',{headers})).json();
    return !stored.savedLooks.length&&!stored.favorites.includes('look:'+id);
  },'committed preset and favorite deletion');
  await search('');
  assert.equal(await evaluate('document.querySelectorAll("[data-studio-look]").length'),10);
  const legacy={id:'legacy-look',name:'Eski renk',color:{temperature:30}};
  const seeded=await fetch(origin+'/api/desktop/studio-preferences/savedLooks',{
    headers:{...headers,'Content-Type':'application/json'},method:'PUT',body:JSON.stringify([legacy]),
  });
  assert.equal(seeded.status,200);
  await win.loadURL(origin);
  await evaluate('Promise.all([projectWorkspaceInitialization,StudioPreferences.ready])');
  await click('[data-asset-tab="filter"]');await search('eski renk');
  await evaluate('S.selected=S.preview=0;S.selectedLayer=S.selectedText=S.selectedSticker=null;drawClips()');
  await click('[data-studio-look="legacy-look"]');
  assert.deepEqual(await evaluate('({brightness:S.clips[0].brightness,saturation:S.clips[0].saturation,temperature:S.clips[0].temperature})'),
    {brightness:100,saturation:100,temperature:30});
}

async function checkAudioAndRecovery() {
  await click('[data-asset-tab="sounds"]');
  assert.equal(await evaluate('el("studio-sound-cards").querySelectorAll(".studio-sound-card").length'),9);
  await search('hizli gecis');
  await click('[data-studio-item="sound:whoosh"] button[aria-pressed]');
  assert.equal(await evaluate(`document.querySelector('[data-studio-item="sound:whoosh"] button').getAttribute('aria-pressed')`),'true');
  await evaluate('seekOutputTime(1.3)');
  const effectAdd = '[data-studio-item="sound:whoosh"] button[title="Oynatma noktasına ekle"]';
  await click(effectAdd);
  await waitFor(()=>evaluate('S.audioLayers.length===1'),'sound effect upload and placement');
  const layer = await evaluate('S.audioLayers[0]');
  assert.ok(Math.abs(layer.start-1.3)<.04 && layer.end-layer.start>.5 && layer.fileId.endsWith('_whoosh.wav'));
  await evaluate('seekOutputTime(2.2)');
  await click(effectAdd);
  await waitFor(()=>evaluate('S.audioLayers.length===2'),'reused effect placement');
  assert.equal(await evaluate('S.audioLayers[1].fileId'),layer.fileId);
  assert.equal(await evaluate('S.mediaAssets.filter(asset=>asset.studioSource==="whoosh").length'),1);
  await search('lo-fi');
  await click('[data-studio-item="music:coast"] button[title="Oynatma noktasına ekle"]');
  await waitFor(()=>evaluate('S.audioLayers.length===3'),'music upload and placement');
  assert.ok(await evaluate('Math.abs(S.audioLayers[2].end-S.audioLayers[2].start-10)<.1'));
  assert.ok(await evaluate('outDuration()>S.clips[0].end'), 'Music retains its full length after the video');
  assert.equal(await evaluate('el("studio-layer-title").textContent'),'Ses klibi');
  await evaluate(`el('studio-layer-volume').value='52';el('studio-layer-volume').dispatchEvent(new Event('input',{bubbles:true}))`);
  assert.equal(await evaluate('S.audioLayers[2].volume'),.52);
  await click('#remove');
  assert.equal(await evaluate('S.clips.length'),1,'Timeline delete leaves the unrelated video clip alone');
  assert.equal(await evaluate('S.audioLayers.length'),2);
  await evaluate('undoEdit()');
  assert.equal(await evaluate('S.audioLayers.length'),3);
  await search('');await screenshot('sound-library-1440x900');
  await checkCatalogSelection();
  await evaluate(`window.oldSoundFixture=S.audioElements.A1;window.oldTimelineFixture=S.activeTimelineId;createTimeline();
    addProjectAssetAt(S.mediaAssets.find(asset=>asset.studioSource==='coast'),0,{extendAudio:true})`);
  assert.deepEqual(await evaluate(`({
    id:S.audioLayers[0].id, oldRetired:oldSoundFixture.paused&&!oldSoundFixture.isConnected&&!oldSoundFixture.getAttribute('src'),
    replaced:S.audioElements.A1!==oldSoundFixture, sourceMatches:S.audioElements.A1.getAttribute('src')===S.audioLayers[0].src
  })`),{id:'A1',oldRetired:true,replaced:true,sourceMatches:true});
  await click('#studio-play-toggle');
  await waitFor(()=>evaluate('S.audioElements.A1?.currentTime>.05&&!S.audioElements.A1.paused&&oldSoundFixture.paused'),'only current timeline audio plays');
  await click('#studio-play-toggle');
  await evaluate('switchTimeline(oldTimelineFixture)');
  assert.equal(await evaluate('S.audioElements.A1.getAttribute("src")===S.audioLayers[0].src'),true);
  for(const id of ['fonts','templates','captions']){
    assert.ok(await evaluate(`StudioWorkspace.openSection('${id}') && el('studio-library-filters').classList.contains('hidden')`));
  }
  await evaluate('S.zoom=37;drawClips();persistProjectRecovery()');
  await win.loadURL(origin);
  await evaluate('projectWorkspaceInitialization');
  assert.equal(await evaluate('S.zoom'),37);
  assert.equal(await evaluate('S.audioLayers.length'),3);
  await click('[data-asset-tab="filter"]');
  assert.equal(await evaluate(`document.querySelector('[data-studio-favorite="look:silver-print"]').getAttribute('aria-pressed')`),'true');
  return {effectDuration:layer.end-layer.start,audioCount:3,isolatedRepeatedLayerId:true,recoveredZoom:37};
}

async function checkMediaFavoritePersistence() {
  await evaluate(`(async()=>{
    const asset=S.mediaAssets.find(item=>item.studioSource==='alpine-tour');
    const legacy='media:'+asset.fileId;
    if(window.StudioPreferences){
      await StudioPreferences.ready;
      await StudioPreferences.set('favorites',[...StudioPreferences.get('favorites',[]),legacy]);
    }else{
      const key='otamatik-edit:studio:favorites',saved=JSON.parse(localStorage.getItem(key)||'[]');
      localStorage.setItem(key,JSON.stringify([...saved,legacy]));
    }
  })()`);
  await evaluate('persistProjectRecovery()');
  await win.loadURL(origin);await evaluate('projectWorkspaceInitialization');
  const shortId=await evaluate(`'media:'+S.mediaAssets.find(item=>item.studioSource==='alpine-tour').fileId.split('_')[0]`);
  const selected=key=>evaluate(`document.querySelector('[data-studio-favorite="'+${JSON.stringify(key)}+'"]')?.getAttribute('aria-pressed')==='true'`);
  await waitFor(()=>selected(shortId),'legacy media favorite mapped to compact ID');
  await evaluate(`(async()=>{
    const response=await fetch('/static/studio/demo/alpine-tour.mp4');
    await importProjectFiles([new File([await response.blob()],'long-'+('a'.repeat(145))+'.mp4',{type:'video/mp4'})]);
  })()`);
  const asset=await evaluate('S.mediaAssets.find(item=>item.name.startsWith("long-"))');
  assert.ok(('media:'+asset.fileId).length>150,'Reproduce the previous backend ID limit');
  const compact='media:'+asset.fileId.split('_')[0];
  assert.equal(compact.length,42);
  await click(`[data-studio-favorite="${compact}"]`);
  const hasDiskPreferences=await evaluate('!!window.StudioPreferences');
  if(hasDiskPreferences){
    const file=path.join(artifacts,'data','studio-preferences.json');
    await waitFor(()=>{
      if(!fs.existsSync(file))return false;
      const ids=JSON.parse(fs.readFileSync(file,'utf8')).favorites||[];
      return ids.includes(compact)&&ids.includes(shortId)&&!ids.includes('media:'+asset.fileId);
    },'long-name favorite persisted on disk');
    await evaluate("localStorage.removeItem('otamatik-edit:studio-preferences:v1')");
  }
  await evaluate('persistProjectRecovery()');
  await win.loadURL(origin);await evaluate('projectWorkspaceInitialization');
  await waitFor(()=>selected(compact),'long filename favorite reopened');
  return {fullLength:('media:'+asset.fileId).length,storedLength:compact.length,disk:hasDiskPreferences};
}

async function checkDelayedExampleLane() {
  await evaluate(`(() => {
    restoreProject({name:'Gecikmeli örnek',timelines:[{id:'TL1',name:'Çizelge',state:emptyTimelineState()}]});
    StudioWorkspace.openSection('media');
    const original=upload;
    upload=async(...args)=>{
      const uploaded=await original(...args);
      return new Promise(resolve=>{window.releaseLibraryUpload=()=>{upload=original;resolve(uploaded)}});
    };
  })()`);
  await click('#studio-add-demo');
  await waitFor(()=>evaluate('!!window.releaseLibraryUpload'),'received upload held before renderer placement');
  await click('#video-track-add');
  assert.equal(await evaluate('S.activeVideoTrack'),2);
  await evaluate('releaseLibraryUpload()');
  await waitFor(()=>evaluate('S.mediaAssets.length===1&&!el("studio-add-demo").disabled'),'stored unplaced project media');
  assert.equal(await evaluate('S.clips.length'),0,'Delayed example must not insert into the newly selected video lane');
  assert.match(await evaluate('el("manual-log-summary").textContent'),/Seçili video kanalı değişti/);
}

app.whenReady().then(async()=>{
  let recovery = null;
  ipcMain.handle('desktop:save-recovery',(_event,value)=>{recovery=value});
  ipcMain.handle('desktop:load-recovery',()=>recovery);
  ipcMain.handle('desktop:storage-info',()=>({path:path.join(artifacts,'data')}));
  ipcMain.handle('desktop:update-state',()=>({mode:'disabled',status:'idle'}));
  await startBackend();
  win = new BrowserWindow({show:false,width:1440,height:900,useContentSize:true,
    webPreferences:{preload:path.join(root,'desktop','preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false,partition:'studio-library-'+token}});
  win.webContents.session.webRequest.onBeforeSendHeaders((details,callback)=>{
    const requestHeaders=new URL(details.url).origin===origin?{...details.requestHeaders,...headers}:details.requestHeaders;
    callback({requestHeaders});
  });
  await win.loadURL(origin);await evaluate('projectWorkspaceInitialization');win.showInactive();
  const looks=await checkPlayerAndLooks(), personal=await checkPersonalLooks(), audio=await checkAudioAndRecovery();
  const favorites=await checkMediaFavoritePersistence();
  await checkLookAfterBackendReopen(personal);
  await checkDelayedExampleLane();
  console.log(JSON.stringify({ok:true,looks,audio,favorites,delayedExampleLanePreserved:true,artifacts}));
}).catch(error=>{
  console.error(error);
  console.error(backendLines.join('').split('\n').slice(-12).join('\n'));
  console.error('Artifacts: '+artifacts);
  process.exitCode=1;
}).finally(async()=>{
  win?.destroy();
  await stopBackend();
  app.exit(process.exitCode||0);
});
