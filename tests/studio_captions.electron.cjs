'use strict';

// Exercise the transcript, native and browser export, and FFmpeg with an isolated backend and real Electron inputs.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname,'..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(),'otomatik-studio-captions-'));
const token = crypto.randomBytes(24).toString('hex');
const headers = {'X-Desktop-Token':token};
const backendLines = [];
const { subtitleExport, writeSubtitleOutput } = require('../desktop/storage.cjs');
const codec = require('../static/studio/srt.js');
const nativeSrt = path.join(artifacts, 'native.srt');
let nativeAttempts = 0;
app.setPath('userData', path.join(artifacts, 'profile'));
app.on('window-all-closed',()=>{});
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
async function point(selector) {
  await evaluate(`void document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);
  await frames();
  const result = await evaluate(`(()=>{
    const node=document.querySelector(${JSON.stringify(selector)}),rect=node.getBoundingClientRect();
    const x=Math.round(rect.left+rect.width/2),y=Math.round(rect.top+rect.height/2);
    const hit=document.elementFromPoint(x,y);return {x,y,hit:hit?.outerHTML.slice(0,130),reachable:!node.disabled&&node.contains(hit)};
  })()`);
  assert.ok(result.reachable,'Reachable control '+selector+' '+JSON.stringify(result));
  return {x:result.x,y:result.y};
}
const send = (type,position) => win.webContents.sendInputEvent({type,button:'left',clickCount:1,...position});
async function click(selector) {
  const at = await point(selector);
  send('mouseDown',at);send('mouseUp',at);await frames();
}
const source = '\uFEFF1\r\n00:00:00,305 --> 00:00:01,115\r\nİstanbul’da ışık.\r\nÇığ, göl ve ölçü.\r\n\r\n2\r\n00:00:01.405 --> 00:00:02.005\r\nÜç kişi yürüdü.\r\n';
const editedText = 'İstanbul’da ışık var.\nÇığ, göl, çiçek.';
const toObject = ({start,end,text}) => ({start,end,text});
const original = codec.parse(source).map(toObject);
const edited = [{start:.315,end:1.205,text:editedText},original[1]];
const safeJson = value => JSON.stringify(value);
const rendererCues = () => evaluate('S.texts.filter(cue=>cue.kind==="subtitle").map(({text,start,end})=>({text,start,end}))');
const readStatus = () => evaluate('el("studio-caption-status").textContent');
const waitUI = (code,label) => waitFor(()=>evaluate(code),label);
const updateControl = (id,value,event='change') => evaluate(`(() => {
  const node=el(${safeJson(id)});
  node.value=${safeJson(value)};
  node.dispatchEvent(new Event(${safeJson(event)},{bubbles:true}));
})()`);
const screenshot = async name => fs.writeFileSync(path.join(artifacts,name+'.png'),(await win.webContents.capturePage()).toPNG());

async function openEditor(useNative) {
  const current = new BrowserWindow({show:false,width:1440,height:900,useContentSize:true,
    webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false,
      partition:useNative?'native-captions':'browser-captions',...(useNative&&{preload:path.join(root,'desktop/preload.cjs')})}});
  current.webContents.session.webRequest.onBeforeSendHeaders({urls:[origin+'/*']},(request,callback)=>{
    callback({requestHeaders:{...request.requestHeaders,...headers}});
  });
  await current.loadURL(origin);
  await current.webContents.executeJavaScript('Promise.all([projectWorkspaceInitialization,StudioFonts.ready])');
  await current.webContents.executeJavaScript('Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))');
  return current;
}

function installFixtureIpc() {
  let recovery = null;
  ipcMain.handle('desktop:load-recovery',()=>recovery);
  ipcMain.handle('desktop:save-recovery',(_,snapshot)=>{recovery=snapshot;return true});
  ipcMain.handle('desktop:storage-info',()=>({path:artifacts}));
  ipcMain.handle('desktop:update-state',()=>({status:'idle',mode:'disabled'}));
  ipcMain.handle('desktop:save-subtitles',async (_,name,content)=>{
    const output=subtitleExport(name,content);
    assert.match(output.filename,/İstanbul.*altyazı\.srt$/);
    if(!nativeAttempts++)return {saved:false,canceled:true};
    await writeSubtitleOutput(nativeSrt,output.content);
    return {saved:true};
  });
}

async function selectSrt(content, name='istanbul.srt') {
  await evaluate(`(() => {
    const files=new DataTransfer();
    files.items.add(new File([${safeJson(content)}],${safeJson(name)},{type:'application/x-subrip'}));
    el('studio-caption-file').files=files.files;
    el('studio-caption-file').dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
}
async function importAndWait(content) {
  await selectSrt(content);
  await waitUI('!el("studio-caption-import").disabled','SRT file reading to finish');
  return readStatus();
}

async function checkImport() {
  await click('#studio-add-demo');
  await waitUI('S.clips.length===1 && mv.readyState>=2 && !mv.seeking','real sample upload and decode');
  await click('[data-asset-tab="captions"]');
  assert.match(await importAndWait(source), /2 altyazı eklendi/);
  assert.deepEqual(await rendererCues(),original);
  const before=await evaluate('JSON.stringify(S.texts)');
  const beforeHistory=await evaluate('S.history.length');
  assert.match(await importAndWait(source), /2 eşleşen/);
  assert.match(await importAndWait(source.replace('00:00:01.405','00:61:01.405')), /Satır 7/);
  assert.match(await importAndWait('1\n00:00:00,100 --> 00:00:01,000\n'+'ü'.repeat(201)), /Satır 3.*200/);
  const tooMany=Array.from({length:501},(_,i)=>(i+1)+'\n00:00:00,100 --> 00:00:01,000\nSatır '+(i+1)).join('\n\n');
  assert.match(await importAndWait(tooMany), /500/);
  assert.equal(await evaluate(`StudioCaptions.importFile(new File([Uint8Array.of(0xc3,0x28)],'bozuk-utf8.srt'))`),false);
  assert.match(await readStatus(),/UTF-8/);
  assert.equal(await evaluate('JSON.stringify(S.texts)'),before);
  assert.equal(await evaluate('S.history.length'),beforeHistory);
  await evaluate('S.trackState.subtitle.locked=true;drawClips()');
  assert.ok(await evaluate('el("studio-caption-import").disabled && el("studio-caption-apply-edit").disabled && el("studio-caption-apply-all").disabled'));
  await selectSrt(source.replace('İstanbul','Ankara'));
  assert.equal(await evaluate('JSON.stringify(S.texts)'),before);
  await evaluate('S.trackState.subtitle.locked=false;drawClips()');
  await updateControl('studio-caption-search','uc kisi','input');
  assert.equal(await evaluate('el("studio-caption-count").textContent'),'1 / 2');
  await click('#studio-caption-cue-list button');
  await waitUI('Math.abs(currentOutputTime()-1.405)<.035 && !mv.seeking','transcript cue seek');
  await updateControl('studio-caption-search','','input');
  await click('#studio-caption-cue-list li:first-child button');
  await waitUI('Math.abs(currentOutputTime()-.305)<.035 && !mv.seeking','first transcript cue seek');
}

async function editFirstCue() {
  await updateControl('studio-caption-text',editedText,'input');
  await updateControl('studio-caption-start',.315,'input');
  await updateControl('studio-caption-end',1.205,'input');
  await click('#studio-caption-apply-edit');
}

async function checkEditingAndReplacement() {
  await editFirstCue();
  assert.deepEqual(await rendererCues(),edited);
  await evaluate('undoEdit()');
  assert.deepEqual(await rendererCues(),original);
  await editFirstCue();
  assert.deepEqual(await rendererCues(),edited);
  await updateControl('studio-caption-text','Geçici metin','input');
  await updateControl('studio-caption-start',.325,'input');
  await updateControl('studio-caption-end',1.225,'input');
  await updateControl('studio-caption-style','neon');
  await updateControl('studio-caption-font','barlow');
  const drafts=await evaluate("['text','start','end'].map(field=>el('studio-caption-'+field).value)");
  assert.deepEqual(drafts,['Geçici metin','0.325','1.225'],'Appearance changes preserve an unapplied draft');
  assert.deepEqual(await rendererCues(),edited,'Appearance changes do not commit the cue draft');
  await evaluate(`S.texts[1].transformKeyframes=[{id:'fixture-frame',time:.1,scale:107,x:50,y:87,opacity:100,easing:'linear'}];S.texts[1].sourceKey='keep-source'`);
  const sourceState=await evaluate('JSON.stringify([S.texts[1].transformKeyframes,S.texts[1].sourceKey])');
  await click('#studio-caption-apply-all');
  assert.deepEqual(await evaluate('S.texts.map(({styleName,fontFamily})=>[styleName,fontFamily])'),[['neon','barlow'],['neon','barlow']]);
  assert.deepEqual(await rendererCues(),edited);
  assert.equal(await evaluate('JSON.stringify([S.texts[1].transformKeyframes,S.texts[1].sourceKey])'),sourceState);
  await evaluate('undoEdit()');
  assert.equal(await evaluate('S.texts[1].styleName'),'classic');
  await click('#studio-caption-apply-all');
  await screenshot('transcript-edited');

  await evaluate(`S.texts.push({...S.texts[0],id:'fixture-title',kind:'text',text:'Sabit başlık',x:50,y:12});drawClips();seekOutputTime(3)`);
  await waitUI('Math.abs(currentOutputTime()-3)<.035 && !mv.seeking','exact playhead placement');
  await updateControl('studio-caption-position','playhead');
  await updateControl('studio-caption-mode','replace');
  await selectSrt(source);
  await waitUI('el("studio-caption-replace").open','replace confirmation');
  await click('#studio-caption-replace button[value="cancel"]');
  assert.match(await readStatus(), /korundu/);
  assert.deepEqual(await rendererCues(),edited);
  await selectSrt(source);
  await waitUI('el("studio-caption-replace").open','second replace confirmation');
  await click('#studio-caption-replace button[value="replace"]');
  assert.deepEqual(await rendererCues(),original.map(cue=>({...cue,start:(cue.start*1000+3000)/1000,end:(cue.end*1000+3000)/1000})));
  assert.equal(await evaluate('S.texts.find(item=>item.id==="fixture-title").text'),'Sabit başlık');
  await evaluate('undoEdit()');
  assert.deepEqual(await rendererCues(),edited);
  await updateControl('studio-caption-position','zero');
  await updateControl('studio-caption-mode','append');
}

async function startDelayedImport() {
  await evaluate(`(() => {
    const bytes=new TextEncoder().encode(${safeJson(source.replace('İstanbul','Ankara'))});
    window.fixtureImport=StudioCaptions.importFile({name:'geciken.srt',size:bytes.length,
      arrayBuffer:()=>new Promise(resolve=>{window.fixtureRelease=()=>resolve(bytes)})});
  })()`);
}

async function checkWorkspaceRaceAndSave() {
  await startDelayedImport();
  await evaluate('window.fixtureTimeline=S.activeTimelineId;createTimeline();fixtureRelease()');
  assert.equal(await evaluate('fixtureImport'),false);
  assert.deepEqual(await rendererCues(),[]);
  assert.match(await importAndWait(source.replace('İstanbul','Ankara')), /2 altyazı eklendi/);
  await evaluate('switchTimeline(fixtureTimeline)');
  assert.deepEqual(await rendererCues(),edited);
  await updateControl('project-name','İstanbul — Altyazı','input');
  assert.equal(await evaluate('saveNamedProject()'),true);
  const named=await evaluate('S.projectId');
  const disk=await fetch(origin+'/projects/'+encodeURIComponent(named),{headers});
  assert.ok(disk.ok);
  const persisted=await disk.json();
  assert.equal(persisted.timelines.length,2);
  assert.equal(persisted.timelines.find(timeline=>timeline.id===persisted.activeTimelineId).state.texts.length,3);
  await startDelayedImport();
  await evaluate('newProject()');
  assert.equal(await evaluate('S.projectId'),null);
  assert.equal(await evaluate('S.activeTimelineId'),'TL1','New project reuses the original timeline ID');
  await evaluate('fixtureRelease()');
  assert.equal(await evaluate('fixtureImport'),false);
  assert.deepEqual(await rendererCues(),[]);
  await evaluate(`el('project-list').value=${safeJson(named)};loadNamedProject()`);
  assert.equal(await evaluate('S.projectId'),named);
  await evaluate("StudioWorkspace.openSection('captions')");
  assert.deepEqual(await rendererCues(),edited);
  assert.deepEqual(await evaluate('S.texts.filter(cue=>cue.kind==="subtitle").map(({styleName,fontFamily})=>[styleName,fontFamily])'),[['neon','barlow'],['neon','barlow']]);
  return named;
}

function assertSrt(file) {
  const data=fs.readFileSync(file);
  assert.ok(data.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf])));
  assert.match(data.toString('utf8'),/00:00:00,315 --> 00:00:01,205\r\n/);
  assert.deepEqual(codec.parse(data.toString('utf8')).map(toObject),edited);
  return data;
}

async function checkNativeExports() {
  await click('#studio-caption-export');
  await waitUI('el("studio-caption-status").textContent.includes("iptal")','native save cancellation');
  assert.equal(fs.existsSync(nativeSrt),false);
  await click('#studio-caption-export');
  await waitUI('el("studio-caption-status").textContent.includes("kaydedildi")','native save completion');
  assert.equal(nativeAttempts,2);
  return assertSrt(nativeSrt);
}

async function checkBrowserExport(named,nativeData) {
  win.destroy();
  win=await openEditor(false);
  await evaluate(`el('project-list').value=${safeJson(named)};loadNamedProject()`);
  await click('[data-asset-tab="captions"]');
  assert.equal(await evaluate('typeof desktopApp'),'undefined');
  assert.deepEqual(await rendererCues(),edited);
  const browserFile=path.join(artifacts,'browser.srt');
  const downloaded=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('SRT download did not finish')),10000);
    win.webContents.session.once('will-download',(_event,item)=>{
      item.setSavePath(browserFile);
      item.once('done',(_itemEvent,state)=>{clearTimeout(timeout);state==='completed'?resolve():reject(new Error(state))});
    });
  });
  await click('#studio-caption-export');
  await downloaded;
  assert.deepEqual(assertSrt(browserFile),nativeData);
}

async function checkDraftIsolation() {
  await evaluate(`(() => {
    const state=emptyTimelineState();
    state.texts=[{...TEXT_STYLES.classic,id:'T1',kind:'subtitle',styleName:'classic',text:'Kayıtlı metin',start:1,end:2}];
    state.selectedText='T1';
    restoreProject({id:'first',name:'Birinci proje',activeTimelineId:'TL1',
      timelines:[{id:'TL1',name:'Bir',state},{id:'TL2',name:'İki',state:structuredClone(state)}]});
  })()`);
  const draft=()=>evaluate("['text','start','end'].map(field=>el('studio-caption-'+field).value)");
  assert.deepEqual(await draft(),['Kayıtlı metin','1','2']);
  const writeDraft=async text=>{
    await updateControl('studio-caption-text',text,'input');
    await updateControl('studio-caption-start',.5,'input');
    await updateControl('studio-caption-end',2.5,'input');
  };
  await writeDraft('İlk çizelgenin taslağı');
  await evaluate("switchTimeline('TL2')");
  assert.deepEqual(await draft(),['Kayıtlı metin','1','2'],'An identical cue in a different timeline starts from saved values');
  await writeDraft('İlk projenin taslağı');
  await evaluate(`(()=>{const project=projectPayload();restoreProject({...project,id:'second',name:'İkinci proje'})})()`);
  assert.deepEqual(await draft(),['Kayıtlı metin','1','2'],'Even identical timeline and cue IDs are scoped to the current project');
}

async function render(captions) {
  const job=await evaluate(`(async()=>{
    const data=manualExportData();data.resolution={width:320,height:180};
    data.options.hardware='cpu';data.options.fps=30;data.clips[0].end=2.4;
    data.texts=${captions} ? data.texts.filter(item=>item.kind==='subtitle') : [];
    const response=await fetch('/start-render',{method:'POST',body:buildRenderForm(data)});
    if(!response.ok)throw new Error(await response.text());
    return events((await response.json()).job_id,()=>{});
  })()`);
  const response=await fetch(origin+job.download_url,{headers});
  assert.ok(response.ok);
  const output=path.join(artifacts,captions?'captions.mp4':'original.mp4');
  fs.writeFileSync(output,Buffer.from(await response.arrayBuffer()));
  const bundled=path.join(root,'tools','ffmpeg','bin','ffmpeg.exe');
  const ffmpeg=process.env.SMART_EDITOR_FFMPEG||(process.platform==='win32'&&fs.existsSync(bundled)?bundled:'ffmpeg');
  return execFileSync(ffmpeg,['-v','error','-i',output,'-vf','crop=320:90:0:90','-pix_fmt','rgb24','-f','rawvideo','-'],{
    timeout:12000,maxBuffer:10*1024*1024
  });
}

async function checkRenderedTiming() {
  const baseline=await render(false), withCaptions=await render(true);
  const frameSize=320*90*3;
  assert.equal(baseline.length,withCaptions.length);
  assert.ok(baseline.length>=62*frameSize);
  const evidence=[];
  for(const [frame,visible] of [[9,false],[10,true],[36,true],[37,false],[42,false],[43,true],[60,true],[61,false]]) {
    let changed=0;
    for(let i=frame*frameSize;i<(frame+1)*frameSize;i+=3) {
      const delta=Math.abs(withCaptions[i]-baseline[i])+Math.abs(withCaptions[i+1]-baseline[i+1])+Math.abs(withCaptions[i+2]-baseline[i+2]);
      if(delta>75)changed++;
    }
    evidence.push({frame,time:frame/30,visible,changed});
  }
  console.log('CPU render cue boundaries',JSON.stringify(evidence));
  for(const {frame,visible,changed} of evidence)assert.ok(visible?changed>=20:changed<20,`Frame ${frame} visibility ${visible} with ${changed} changed pixels`);
}

app.whenReady().then(async()=>{
  await startBackend();installFixtureIpc();win=await openEditor(true);
  await checkImport();
  await checkEditingAndReplacement();
  const named=await checkWorkspaceRaceAndSave();
  const nativeData=await checkNativeExports();
  await checkRenderedTiming();
  await checkBrowserExport(named,nativeData);
  await checkDraftIsolation();
  console.log('SRT editor, restore, both save paths and timed FFmpeg render verified.',artifacts);
}).catch(error=>{
  console.error(error);
  console.error(backendLines.slice(-40).join(''));
  console.error('Artifacts:',artifacts);
  process.exitCode=1;
}).finally(async()=>{
  win?.destroy();
  if(backend?.pid&&backend.exitCode===null){
    const stopped=new Promise(resolve=>backend.once('exit',resolve));
    backend.kill();
    await Promise.race([stopped,new Promise(resolve=>setTimeout(resolve,2000))]);
    if(backend.exitCode===null)backend.kill('SIGKILL');
  }
  app.exit(process.exitCode||0);
});
