// Isolated real-DOM fixture: no user's backend, projects, clipboard or media.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const repository=path.resolve(__dirname,'..');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'otomatik-timeline-tools-'));
app.setPath('userData',path.join(artifacts,'profile'));
const errors=[],proof={},savedProjects=new Map();
let window,server,videoBytes;
const j=JSON.stringify;
const evaluate=code=>window.webContents.executeJavaScript(code);
const twoFrames=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const screenshot=async name=>fs.promises.writeFile(path.join(artifacts,name+'.png'),(await window.webContents.capturePage()).toPNG());
async function click(selector){
  await evaluate(`document.querySelector(${j(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);await twoFrames();
  const point=await evaluate(`(()=>{const node=document.querySelector(${j(selector)}),r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,reachable:!node.disabled&&node.contains(document.elementFromPoint(x,y))}})()`);
  assert.ok(point.reachable,'Reachable control '+selector+' '+j(point));
  for(const type of ['mouseDown','mouseUp'])window.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(point.x),y:Math.round(point.y)});
  await twoFrames();
}
async function shortcut(key){
  const modifiers=[process.platform==='darwin'?'meta':'control'];
  window.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers});
  await twoFrames();
}
async function mediaReady(){
  await evaluate(`new Promise((resolve,reject)=>{const video=mv;const names=['loadeddata','canplay','seeked','timeupdate'];let timer;const clean=()=>{clearTimeout(timer);names.forEach(name=>video.removeEventListener(name,ready))},ready=()=>{if(video.readyState>=2&&!video.seeking){clean();resolve()}};names.forEach(name=>video.addEventListener(name,ready));timer=setTimeout(()=>{clean();reject(new Error('Media timeout '+JSON.stringify({ready:video.readyState,seeking:video.seeking,src:video.currentSrc,error:video.error?.message})))},15000);ready()})`);
}
async function seek(time){await evaluate(`seekOutputTime(${time});pausePreview()`);await twoFrames()}
async function input(id,value){await evaluate(`(()=>{const input=el(${j(id)});input.value=${j(String(value))};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`);await twoFrames()}
async function waitCrop(){
  await evaluate(`new Promise((resolve,reject)=>{const start=performance.now();const poll=()=>{if(timelineCropSession?.ready)return resolve();if(!el('timeline-crop-dialog').open||performance.now()-start>16000)return reject(new Error(el('timeline-crop-status').textContent));requestAnimationFrame(poll)};poll()})`);
}

async function checkClipboard(){
  await evaluate(`select(0,false);el('timeline').focus();S.timelineCursor=1.25`);await shortcut('C');
  await click('#timeline-add');
  assert.equal(await evaluate('S.clips.length'),0);
  await evaluate(`S.timelineCursor=2.5;el('timeline').focus()`);await shortcut('V');
  const first=await evaluate('JSON.parse(JSON.stringify(S.clips[0]))');
  assert.equal(first.timelineStart,2.5);assert.equal(first.fileId,'source.mp4');assert.equal(first.scale,115);assert.equal(first.volume,1.4);assert.equal(first.zoomKeyframes.length,2);
  assert.notEqual(first.clipId,'original');assert.notEqual(first.zoomKeyframes[0].id,'frame-one');
  assert.deepEqual(first.crop,{x:0,y:0,width:1,height:1});
  assert.equal(await evaluate('S.videoTracks.length'),1);
  await seek(3.25);await evaluate('el("timeline").focus()');await shortcut('V');
  assert.equal(await evaluate('S.clips.length'),1);assert.equal(await evaluate('S.videoTracks.length'),1);
  await click('#video-track-add');await evaluate('el("timeline").focus()');await shortcut('V');
  const stacked=await evaluate('S.clips.map(item=>({id:item.clipId,track:item.videoTrack,start:item.timelineStart}))');
  assert.equal(stacked.length,2);assert.equal(stacked[1].track,2);assert.equal(stacked[1].start,3.25);assert.equal(stacked[0].start,2.5);
  await shortcut('Z');assert.equal(await evaluate('S.videoTracks.length'),2);assert.equal(await evaluate('S.clips.length'),1);
  await shortcut('Z');assert.equal(await evaluate('S.videoTracks.length'),1);
  await evaluate('S.videoTracks[0].locked=true;drawClips();el("timeline").focus()');await shortcut('V');assert.equal(await evaluate('S.clips.length'),1);
  await evaluate('S.videoTracks[0].locked=false;drawClips()');
  // A real focused text field keeps its native editing behavior; timeline length is unchanged.
  await click('#project-name');await shortcut('C');await shortcut('V');assert.equal(await evaluate('S.clips.length'),1);
  await evaluate(`el('project-name').value='Timeline tools fixture';switchTimeline('TL1')`);await twoFrames();
  const cases=[['image','imageLayers','image-one'],['audio','audioLayers','audio-one'],['text','texts','text-one'],['subtitle','texts','subtitle-one'],['sticker','stickers','sticker-one']];
  const copies=[];
  for(const [type,array,id]of cases){
    await evaluate(`switchTimeline('TL1');S.selectedLayer=null;S.selectedText=null;S.selectedSticker=null;${type==='image'||type==='audio'?`S.selectedLayer={type:${j(type)},id:${j(id)}}`:type==='sticker'?`S.selectedSticker=${j(id)}`:`S.selectedText=${j(id)}`};el('timeline').focus()`);await shortcut('C');
    await evaluate(`switchTimeline(S.timelines[1].id);seekOutputTime(5.5);el('timeline').focus()`);await shortcut('V');
    const pasted=await evaluate(`JSON.parse(JSON.stringify(S.${array}.at(-1)))`);
    assert.notEqual(pasted.id,id);assert.equal(pasted.start,5.5);assert.equal(pasted.end,8.5);
    if(type==='image'||type==='text'||type==='subtitle'){assert.equal(pasted.transformKeyframes.length,2);assert.notEqual(pasted.transformKeyframes[0].id,'layer-frame-one');}
    if(type==='audio')assert.equal(pasted.sourceStart,1.1);
    if(type==='sticker')assert.equal(pasted.preset,'heart');
    copies.push({type,id:pasted.id,start:pasted.start,end:pasted.end});
  }
  await evaluate(`switchTimeline('TL1');el('timeline').focus()`);await twoFrames();
  assert.equal(await evaluate('S.clips[0].scale'),115);assert.equal(await evaluate('S.imageLayers[0].transformKeyframes[0].scale'),100);
  proof.clipboard={first,stacked,copies};
}

async function checkCrop(){
  await evaluate(`select(0,false);seekOutputTime(2);pausePreview()`);await mediaReady();await twoFrames();
  await evaluate('S.clips[0].reverse=true;drawClips();seekOutputTime(2)');
  await click('#timeline-crop');await waitCrop();
  const reverseSourceTime=await evaluate('timelineCropSession.video.currentTime');
  assert.ok(Math.abs(reverseSourceTime-6)<.02,'Reverse crop must load the frame actually mapped from the source end');
  await click('#timeline-crop-cancel');
  await evaluate('timelineCopySelection();seekOutputTime(8);timelinePasteClipboard()');await twoFrames();
  assert.equal(await evaluate('S.clips.at(-1).reverse'),true);
  assert.equal(await evaluate('currentOutputTime()'),8,'Reverse paste preview stays at the requested output cursor');
  await evaluate('undoEdit();S.clips[0].reverse=false;drawClips();seekOutputTime(2)');await twoFrames();
  const before=await evaluate('JSON.parse(JSON.stringify(S.clips[0]))');
  await click('#timeline-crop');await waitCrop();
  const sourceProof=await evaluate(`(()=>{const canvas=el('timeline-crop-canvas'),ctx=canvas.getContext('2d');return{width:canvas.width,height:canvas.height,sourceTime:timelineCropSession.video.currentTime,center:[...ctx.getImageData(canvas.width/2,canvas.height/2,1,1).data],corner:[...ctx.getImageData(4,4,1,1).data]}})()`);
  assert.equal(sourceProof.width,640);assert.equal(sourceProof.height,360);assert.ok(Math.abs(sourceProof.sourceTime-2)<.02);
  assert.notDeepEqual(sourceProof.center,sourceProof.corner,'Crop dialog must show the real nonuniform source frame');
  await input('timeline-crop-width',70);await input('timeline-crop-height',70);await input('timeline-crop-x',10);await input('timeline-crop-y',10);
  const from=await evaluate(`(()=>{const n=document.querySelector('[data-crop-handle="se"]'),r=n.getBoundingClientRect(),stage=el('timeline-crop-stage').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,dx:stage.width*.08,dy:stage.height*.06,reachable:n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}})()`);
  assert.ok(from.reachable);
  for(const [type,x,y]of [['mouseDown',from.x,from.y],['mouseMove',from.x+from.dx,from.y+from.dy],['mouseUp',from.x+from.dx,from.y+from.dy]])window.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(x),y:Math.round(y)});
  await twoFrames();
  const resized=await evaluate('({...timelineCropSession.draft})');assert.ok(resized.width>.77&&resized.width<.79);assert.ok(resized.height>.75&&resized.height<.77);
  assert.deepEqual(await evaluate('JSON.parse(JSON.stringify(S.clips[0]))'),before,'Draft resize cannot mutate project');
  for(const [width,height]of [[1366,768],[900,580]]){
    window.setContentSize(width,height);await twoFrames();
    await evaluate(`el('timeline-crop-apply').scrollIntoView({block:'nearest'})`);await twoFrames();
    assert.ok(await evaluate(`(()=>{const n=el('timeline-crop-apply'),r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`));
    await screenshot('crop-'+width+'x'+height);
  }
  await click('#timeline-crop-cancel');assert.deepEqual(await evaluate('JSON.parse(JSON.stringify(S.clips[0]))'),before);
  window.setContentSize(1366,768);await twoFrames();await click('#timeline-crop');await waitCrop();
  await evaluate(`el('timeline-crop-preset').value='9:16';el('timeline-crop-preset').dispatchEvent(new Event('change'))`);
  const draft=await evaluate('({...timelineCropSession.draft})');assert.ok(Math.abs(draft.width/draft.height*640/360-9/16)<.0001);
  // Dialog blocks timeline editing shortcuts and clipboard mutations.
  const count=await evaluate('S.clips.length');await shortcut('V');window.webContents.sendInputEvent({type:'keyDown',keyCode:'B'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'B'});await twoFrames();assert.equal(await evaluate('S.clips.length'),count);
  await click('#timeline-crop-apply');assert.deepEqual(await evaluate('({...S.clips[0].crop})'),draft);
  await evaluate('undoEdit()');await twoFrames();assert.deepEqual(await evaluate('({...S.clips[0].crop})'),before.crop);
  await click('#timeline-crop');await waitCrop();await input('timeline-crop-width',50);await input('timeline-crop-x',25);await click('#timeline-crop-apply');
  const saved=await evaluate('projectPayload()');await evaluate('saveNamedProject()');assert.equal(savedProjects.size,1);
  await evaluate('localStorage.clear()');await window.loadURL(`http://127.0.0.1:${server.address().port}/`);await evaluate('projectWorkspaceInitialization');
  await evaluate(`el('project-list').value='fixture';loadNamedProject()`);await twoFrames();
  const restored=await evaluate('projectPayload()');
  assert.deepEqual(restored.timelines.map(t=>t.state.clips.map(c=>({id:c.clipId,crop:c.crop}))),saved.timelines.map(t=>t.state.clips.map(c=>({id:c.clipId,crop:c.crop}))));
  proof.crop={sourceProof,reverseSourceTime,resized,draft,restored:restored.timelines.map(t=>({id:t.id,clips:t.state.clips.map(c=>({id:c.clipId,crop:c.crop}))}))};
}

app.whenReady().then(async()=>{
  const ffmpeg=process.env.SMART_EDITOR_FFMPEG||(process.platform==='win32'&&fs.existsSync(path.join(repository,'tools/ffmpeg/bin/ffmpeg.exe'))?path.join(repository,'tools/ffmpeg/bin/ffmpeg.exe'):'ffmpeg');
  const file=path.join(artifacts,'source.mp4');
  execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=s=640x360:r=30:d=10','-c:v','libx264','-pix_fmt','yuv420p',file],{timeout:60000});
  videoBytes=fs.readFileSync(file);const originalHash=crypto.createHash('sha256').update(videoBytes).digest('hex');
  server=http.createServer(async(req,res)=>{
    try{
      const route=new URL(req.url,'http://fixture').pathname,reply=value=>{res.setHeader('Content-Type','application/json');res.end(j(value))};
      if(route==='/'){res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(repository,'templates/index.html')));return}
      if(route==='/favicon.ico'){res.writeHead(204).end();return}
      if(route.startsWith('/static/')){const root=path.join(repository,'static'),target=path.resolve(root,decodeURIComponent(route.slice(8)));if(!target.startsWith(root+path.sep)||!fs.existsSync(target)){res.writeHead(404).end();return}res.setHeader('Content-Type',target.endsWith('.css')?'text/css':target.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(fs.readFileSync(target));return}
      if(route==='/projects'&&req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);const project=JSON.parse(Buffer.concat(chunks).toString());savedProjects.set('fixture',{...project,id:'fixture'});reply({id:'fixture'});return}
      if(route==='/projects'){reply({projects:[...savedProjects.values()].map(p=>({id:p.id,name:p.name}))});return}
      if(route==='/projects/fixture'){reply(savedProjects.get('fixture'));return}
      if(route==='/api/version'||route==='/api/check-update'){reply({version:'fixture',update_available:false});return}
      if(route.startsWith('/waveform/')){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20"/>');return}
      if(route==='/video/source.mp4'){
        const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||''),start=range?+range[1]:0,end=range&&range[2]?Math.min(+range[2],videoBytes.length-1):videoBytes.length-1;
        res.writeHead(range?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${videoBytes.length}`}:{})});res.end(videoBytes.subarray(start,end+1));return;
      }
      if(route==='/video/image.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="red"/></svg>');return}
      res.writeHead(404).end();
    }catch(error){errors.push(error.stack);res.writeHead(500).end()}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  window=new BrowserWindow({show:false,width:1366,height:768,useContentSize:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);await evaluate('projectWorkspaceInitialization');
  window.setContentSize(1366,768);window.showInactive();await twoFrames();
  await evaluate(`(()=>{const textDefaults=()=>({...TEXT_STYLES.classic,x:50,y:50,rotation:0});const frames=[{id:'layer-frame-one',time:0,scale:100,x:30,y:40,opacity:100,easing:'linear'},{id:'layer-frame-two',time:2,scale:150,x:70,y:60,opacity:60,easing:'linear'}];restoreProject({name:'Timeline tools fixture',mediaAssets:[{id:'video',fileId:'source.mp4',name:'Source video',kind:'video',duration:10},{id:'image',fileId:'image.svg',name:'Image',kind:'image'}],activeTimelineId:'TL1',nextTimelineId:2,timelines:[{id:'TL1',name:'Original',state:{...emptyTimelineState(),manualId:'source.mp4',manualName:'Source video',duration:10,selected:0,preview:0,clips:[{clipId:'original',start:0,end:8,fileId:'source.mp4',sourceDuration:10,timelineStart:0,videoTrack:1,scale:115,volume:1.4,crop:{x:0,y:0,width:1,height:1},zoomKeyframes:[{id:'frame-one',time:0,scale:100,x:50,y:50,opacity:100},{id:'frame-two',time:4,scale:140,x:60,y:40,opacity:80}],backgroundMode:'brush',brushApplied:true,brushMode:'keep',brushStrokes:[{size:80,points:[{x:.5,y:.5}]}]}],imageLayers:[{id:'image-one',fileId:'image.svg',src:'/video/image.svg',start:1,end:4,x:50,y:50,scale:30,transformKeyframes:frames}],audioLayers:[{id:'audio-one',fileId:'source.mp4',src:'/video/source.mp4',start:1,end:4,sourceStart:1.1,sourceDuration:10,volume:0}],texts:[{...textDefaults(),id:'text-one',text:'Text',start:1,end:4,transformKeyframes:frames},{...textDefaults(),id:'subtitle-one',kind:'subtitle',text:'Subtitle',start:1,end:4,transformKeyframes:frames}],stickers:[{id:'sticker-one',preset:'heart',name:'Heart',start:1,end:4,x:50,y:50,scale:18}],canvas:{width:1920,height:1080},zoom:40}}]})})()`);
  await mediaReady();await twoFrames();
  await checkClipboard();await checkCrop();
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),originalHash,'Source file must remain unchanged');
  assert.deepEqual(errors,[]);console.log(j({ok:true,proof,artifacts}));
}).catch(async error=>{console.error(error);await screenshot('failure').catch(()=>{});console.error(j({proof,errors,artifacts}));process.exitCode=1}).finally(()=>{window?.destroy();server?.closeAllConnections();server?.close();app.exit(process.exitCode||0)});
