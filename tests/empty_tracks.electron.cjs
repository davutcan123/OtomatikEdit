// Native pointer regression in a disposable local editor, never the user's running app.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'otomatik-empty-tracks-'));
app.setPath('userData',path.join(artifacts,'profile'));
const json=JSON.stringify,proof={drops:[],cancellations:[]},errors=[],media=new Map();let window,server,subtitleRequests=0,subtitleEmpty=false;
const evaluate=code=>window.webContents.executeJavaScript(code),frames=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const screenshot=async name=>fs.promises.writeFile(path.join(artifacts,name+'.png'),(await window.webContents.capturePage()).toPNG());
const send=(type,point)=>window.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(point.x),y:Math.round(point.y)});
const geometry=()=>evaluate(`(()=>{const rows={};for(const type of ['sticker','text','subtitle','image','audio']){const node=el(type+'-track'),label=el(type+'-label');rows[type]={visible:getComputedStyle(node).display!=='none',labelVisible:getComputedStyle(label).display!=='none',height:node.getBoundingClientRect().height,top:parseFloat(node.style.top),temporary:node.classList.contains('timeline-row-drop-target')}}return{rows,videoTop:S.timelineVideoTop,videoTracks:S.videoTracks.length,videoRows:[...el('track').querySelectorAll('.video-lane')].map(node=>({id:node.dataset.videoTrack,height:node.getBoundingClientRect().height})),height:parseFloat(el('timeline-content').style.height),target:setTimelineDropTarget.type||null,cursor:currentOutputTime(),scroll:[el('timeline').scrollTop,el('timeline').scrollLeft]}})()`);
async function readyVideo(){await evaluate(`new Promise((resolve,reject)=>{const started=performance.now(),check=()=>{const videos=window.multiTrackPreview?.enabled()?[...document.querySelectorAll('.composite-layer:not([hidden]) video')]:[mv];if(videos.length&&videos.every(video=>video.readyState>=2&&!video.seeking))return resolve();if(performance.now()-started>10000)return reject(new Error('Fixture video not ready: '+JSON.stringify(videos.map(video=>({src:video.currentSrc,state:video.readyState,seeking:video.seeking})))));setTimeout(check,20)};check()})`)}
async function setup(){
  await evaluate(`setTimelineDropTarget(null);restoreProject({name:'Empty row fixture',mediaAssets:[{id:'video',kind:'video',fileId:'source.mp4',name:'Video',duration:12},{id:'image',kind:'image',fileId:'image.png',name:'Image'},{id:'audio',kind:'audio',fileId:'audio.wav',name:'Audio',duration:12}],activeTimelineId:'TL1',timelines:[{id:'TL1',name:'Main',state:{manualId:'source.mp4',manualName:'Video',duration:12,selected:0,preview:0,canvas:{width:1920,height:1080},zoom:30,clips:[{clipId:'V1',videoTrack:1,fileId:'source.mp4',sourceDuration:12,start:0,end:12,timelineStart:0}]}}]});seekOutputTime(2);el('timeline').scrollTop=0;el('timeline').scrollLeft=0;`);
  await readyVideo();await evaluate('seekOutputTime(2)');await readyVideo();await frames();
}
function assertVisible(g,types){for(const[type,row]of Object.entries(g.rows)){assert.equal(row.visible,types.includes(type),'Track visibility '+type+' '+json(g));assert.equal(row.labelVisible,row.visible,'Track label follows '+type);if(!row.visible)assert.equal(row.height,0)}}
async function begin(type){
  await evaluate(`window.__emptyDragEvents=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','blur'])window.addEventListener(type,event=>{window.__emptyDragEvents.push({type:event.type,target:event.target.id||event.target.className,button:event.button,x:event.clientX,y:event.clientY});window.__emptyDragEvents=window.__emptyDragEvents.slice(-12)},{capture:true,once:true})`);
  const selector=type==='sticker'?'.sticker-card[data-sticker="heart"]':type==='text'?'.text-preset[data-text-style="classic"]':`.project-card[data-asset-id="${type}"]`;
  if(type==='sticker'||type==='text')await evaluate(`switchAssetTab(${json(type)})`);
  await evaluate(`document.querySelector(${json(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);await frames();
  const from=await evaluate(`(()=>{const node=document.querySelector(${json(selector)}),r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,reachable:node.contains(document.elementFromPoint(x,y))}})()`);
  assert.ok(from.reachable,'Source is pointer reachable '+selector+' '+json(from));send('mouseDown',from);send('mouseMove',{x:from.x+12,y:from.y+12});await frames();
  const g=await geometry();proof.lastDrag={type,from,events:await evaluate('window.__emptyDragEvents'),focused:window.isFocused()};assertVisible(g,[type]);assert.equal(g.target,type);assert.equal(g.rows[type].temporary,true);assert.equal(await evaluate(`el('drag-ghost').classList.contains('hidden')`),false);
  return from;
}
async function dropPoint(type,time){return evaluate(`(()=>{const r=el(${json(type+'-track')}).getBoundingClientRect(),box=el('timeline').getBoundingClientRect();return{x:r.left+${time}*S.zoom,y:Math.max(r.top+8,Math.min(r.bottom-8,(Math.max(box.top,r.top)+Math.min(box.bottom,r.bottom))/2)),viewport:[innerWidth,innerHeight]}})()`)}
async function click(selector){await evaluate(`document.querySelector(${json(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);await frames();const point=await evaluate(`(()=>{const node=document.querySelector(${json(selector)}),r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,reachable:!node.disabled&&node.contains(document.elementFromPoint(x,y))}})()`);assert.ok(point.reachable,'Control reachable '+selector+' '+json(point));send('mouseDown',point);send('mouseUp',point);await frames()}
async function firstDrop(type){
  await setup();await begin(type);await screenshot('first-'+type+'-target');const to=await dropPoint(type,1);
  assert.ok(to.x>0&&to.y>0&&to.x<to.viewport[0]&&to.y<to.viewport[1],'Visible drop target '+json(to));
  send('mouseMove',to);await frames();send('mouseUp',to);await frames();
  const g=await geometry();assertVisible(g,[type]);assert.equal(g.target,null);assert.equal(g.rows[type].temporary,false);
  const data=await evaluate(`JSON.parse(JSON.stringify(${type==='sticker'?'S.stickers':type==='text'?'S.texts':type==='image'?'S.imageLayers':'S.audioLayers'}))`);
  assert.equal(data.length,1,'First drop creates exactly one '+type);assert.ok(Math.abs(data[0].start-1)<.04,'Drop position uses revealed geometry '+json(data[0]));
  await evaluate(`S.trackState[${json(type)}].locked=true;S.trackState[${json(type)}].visible=false;S.trackState[${json(type)}].muted=true;drawClips()`);assertVisible(await geometry(),[type]);
  await evaluate(`S.trackState[${json(type)}].locked=false;${type==='sticker'?'deleteSelectedSticker()':type==='text'?'deleteSelectedText()':'deleteSelectedLayer()'}`);await frames();
  assertVisible(await geometry(),[]);assert.equal((await geometry()).videoTop,44);await evaluate('undoEdit()');await frames();assertVisible(await geometry(),[type]);await evaluate(`${type==='sticker'?'deleteSelectedSticker()':type==='text'?'deleteSelectedText()':'deleteSelectedLayer()'}`);await frames();assertVisible(await geometry(),[]);proof.drops.push({type,start:data[0].start,dropGeometry:g,hiddenAfterLastDelete:true,undoRestoresRow:true});
}
async function cancelCases(){
  for(const [type,action]of [['sticker','outside'],['text','Escape'],['image','pointercancel'],['audio','blur']]){
    await setup();const before=await evaluate('JSON.stringify(captureTimelineState())'),beforeGeometry=await geometry(),from=await begin(type);
    if(action==='outside'){send('mouseMove',{x:20,y:80});send('mouseUp',{x:20,y:80})}
    else if(action==='Escape'){window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await frames();send('mouseUp',from)}
    else{await evaluate(`window.dispatchEvent(new Event(${json(action)}))`);send('mouseUp',from)}
    await frames();const after=await geometry();assertVisible(after,[]);assert.equal(after.target,null);assert.equal(after.videoTop,44);assert.equal(after.cursor,beforeGeometry.cursor);assert.deepEqual(after.scroll,beforeGeometry.scroll);
    assert.equal(await evaluate('JSON.stringify(captureTimelineState())'),before,'Cancelled drag must not edit the project');assert.equal(await evaluate(`el('drag-ghost').classList.contains('hidden')`),true);proof.cancellations.push({type,action,unchanged:true});
  }
  // Escape before releasing on the original text card must not fall through to click-to-add.
  await setup();const from=await begin('text');window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await frames();send('mouseMove',from);send('mouseUp',from);await frames();assert.equal(await evaluate('S.texts.length'),0);
  // A temporary top lane must restore the user's actual scrolled multi-video view.
  window.setContentSize(1100,700);await frames();await setup();await evaluate(`addVideoTrack();addVideoTrack();S.zoom=80;drawClips();el('timeline').scrollTop=150;el('timeline').scrollLeft=100`);await frames();
  const before=await geometry();assert.ok(before.scroll[0]>0&&before.scroll[1]>0,'Nonzero scroll fixture');await begin('text');window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});send('mouseUp',{x:20,y:80});await frames();assert.deepEqual((await geometry()).scroll,before.scroll);assert.equal((await geometry()).cursor,before.cursor);proof.cancellations.push({type:'text',action:'Escape',restoredNonzeroScroll:before.scroll});window.setContentSize(1366,768);await frames();
}
async function lockedEmptyRecovery(){
  await setup();assert.equal(await evaluate(`el('empty-track-locks').hidden`),true);await evaluate(`S.trackState.image.locked=true;S.trackState.audio.locked=true;drawClips()`);await frames();assertVisible(await geometry(),[]);assert.equal(await evaluate(`el('empty-track-locks').hidden`),false);
  await click('#empty-track-locks');assert.equal(await evaluate(`el('empty-track-lock-dialog').open`),true);assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-unlock-empty-track]')].map(node=>node.dataset.unlockEmptyTrack)`),['image','audio']);await screenshot('unlock-hidden-empty-channel');
  await click('[data-unlock-empty-track="image"]');assert.equal(await evaluate('S.trackState.image.locked'),false);assert.equal(await evaluate('S.trackState.audio.locked'),true);assertVisible(await geometry(),[]);
  await evaluate('undoEdit()');await frames();assert.equal(await evaluate('S.trackState.image.locked'),true);await click('#empty-track-locks');await click('[data-unlock-empty-track="image"]');await begin('image');const to=await dropPoint('image',1);send('mouseMove',to);send('mouseUp',to);await frames();assert.equal(await evaluate('S.imageLayers.length'),1);assertVisible(await geometry(),['image']);
  await click('#empty-track-locks');await click('[data-unlock-empty-track="audio"]');assert.equal(await evaluate(`el('empty-track-locks').hidden`),true);assert.equal(await evaluate(`el('empty-track-lock-dialog').open`),false);proof.lockedEmpty={keptRowsHidden:true,explicitUnlock:true,undoRestoresLock:true,firstDropAfterUnlock:true,otherChannelRemainedLocked:true};
}
async function subtitlesAndRecovery(){
  await setup();subtitleEmpty=true;await evaluate('generateSubtitles()');await frames();assertVisible(await geometry(),[]);
  subtitleEmpty=false;await evaluate('generateSubtitles()');await frames();assertVisible(await geometry(),['subtitle']);assert.equal(await evaluate(`S.texts.filter(item=>item.kind==='subtitle').length`),2);assert.equal(subtitleRequests,2);
  await evaluate(`addProjectAssetAt(S.mediaAssets.find(item=>item.id==='image'),1);addTextPreset('classic',2);addStickerPreset('heart',3);addProjectAssetAt(S.mediaAssets.find(item=>item.id==='audio'),4);addVideoTrack();addVideoTrack();drawClips()`);await frames();
  const populated=await geometry();assertVisible(populated,['sticker','text','subtitle','image','audio']);assert.equal(populated.videoTracks,3);assert.equal(populated.videoRows.length,3);assert.ok(populated.videoRows.every(row=>row.height===104));
  await evaluate(`S.trackState.image.visible=false;S.trackState.image.locked=true;S.trackState.audio.muted=true;setTimelineDropTarget('subtitle')`);
  const saved=await evaluate('projectPayload()');assert.ok(!JSON.stringify(saved).includes('timelineDropTarget'),'Temporary UI target is never serialized');
  await evaluate('setTimelineDropTarget(null)');await window.loadURL(window.webContents.getURL());await evaluate('projectWorkspaceInitialization');await evaluate(`restoreProject(${json(saved)})`);await readyVideo();await frames();
  assertVisible(await geometry(),['sticker','text','subtitle','image','audio']);assert.equal((await geometry()).target,null);assert.equal(await evaluate('S.trackState.image.locked&&S.trackState.audio.muted&&!S.trackState.image.visible'),true);
  proof.recovery={allPopulatedRows:true,independentSubtitles:2,videoTracks:3,temporaryTargetPersisted:false};await screenshot('populated-restored');
  await evaluate(`S.stickers=[];S.texts=[];S.imageLayers=[];S.audioLayers=[];drawClips();el('timeline').scrollTop=0`);await frames();
  const empty=await geometry();assertVisible(empty,[]);assert.equal(empty.videoRows.length,3);assert.equal(empty.videoTop,44);assert.equal(empty.height,382);proof.emptyThreeVideos=empty;await screenshot('three-video-rows-no-empty-layers');
}
app.whenReady().then(async()=>{
  const ffmpeg=process.env.SMART_EDITOR_FFMPEG||(process.platform==='win32'&&fs.existsSync(path.join(root,'tools/ffmpeg/bin/ffmpeg.exe'))?path.join(root,'tools/ffmpeg/bin/ffmpeg.exe'):'ffmpeg');
  for(const[name,args,type]of [['source.mp4',['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=12','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p'],'video/mp4'],['image.png',['-f','lavfi','-i','color=c=red:s=160x100','-frames:v','1'],'image/png'],['audio.wav',['-f','lavfi','-i','sine=frequency=440:duration=12'],'audio/wav']]){const file=path.join(artifacts,name);execFileSync(ffmpeg,['-v','error','-y',...args,file],{timeout:60000});const bytes=fs.readFileSync(file);media.set(name,{file,bytes,type,hash:crypto.createHash('sha256').update(bytes).digest('hex')})}
  server=http.createServer((request,response)=>{try{
    const route=new URL(request.url,'http://fixture').pathname,reply=value=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(value))};
    if(route==='/'){response.setHeader('Content-Type','text/html');response.end(fs.readFileSync(path.join(root,'templates/index.html')));return}
    if(route==='/favicon.ico'){response.writeHead(204).end();return}
    if(route.startsWith('/static/')){const file=path.resolve(root,'.'+route);if(!file.startsWith(path.join(root,'static')+path.sep)||!fs.existsSync(file)){response.writeHead(404).end();return}response.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');response.end(fs.readFileSync(file));return}
    if(route==='/projects'){reply({projects:[]});return}
    if(route==='/api/check-update'||route==='/api/version'){reply({version:'empty-tracks-fixture',update_available:false});return}
    if(route==='/start-subtitles'){request.resume();subtitleRequests++;reply({job_id:'subtitles'});return}
    if(route==='/stream-events/subtitles'){response.setHeader('Content-Type','text/event-stream');response.end('data: '+json({type:'result',data:{source_language:'en',cues:subtitleEmpty?[]:[{start:1,end:2,text:'First sentence.'},{start:3,end:4,text:'Second sentence.'}]}})+'\n\n');return}
    const item=media.get(route.startsWith('/waveform/')?'image.png':decodeURIComponent(route.slice('/video/'.length)));
    if(item&&(route.startsWith('/video/')||route.startsWith('/waveform/'))){const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range||''),start=range?+range[1]:0,end=range&&range[2]?Math.min(item.bytes.length-1,+range[2]):item.bytes.length-1;response.statusCode=range?206:200;response.setHeader('Content-Type',item.type);response.setHeader('Accept-Ranges','bytes');response.setHeader('Content-Length',end-start+1);if(range)response.setHeader('Content-Range',`bytes ${start}-${end}/${item.bytes.length}`);response.end(item.bytes.subarray(start,end+1));return}
    response.writeHead(404).end();
  }catch(error){errors.push(error.stack);response.writeHead(500).end()}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));window=new BrowserWindow({show:true,frame:false,width:1366,height:768,useContentSize:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});window.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});await window.loadURL(`http://127.0.0.1:${server.address().port}/`);await evaluate('projectWorkspaceInitialization');window.setContentSize(1366,768);window.showInactive();await frames();
  await setup();proof.initial=await geometry();assertVisible(proof.initial,[]);assert.equal(proof.initial.videoTop,44);assert.equal(proof.initial.height,158);await screenshot('empty-optional-rows');
  for(const type of ['sticker','text','image','audio'])await firstDrop(type);await cancelCases();await lockedEmptyRecovery();await subtitlesAndRecovery();
  for(const item of media.values())assert.equal(crypto.createHash('sha256').update(fs.readFileSync(item.file)).digest('hex'),item.hash);assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,proof,errors,artifacts}));
}).catch(async error=>{console.error(error);if(window){proof.failure=await geometry().catch(()=>null);proof.log=await evaluate(`el('manual-log').textContent.slice(-1600)`).catch(()=>null);await screenshot('failure').catch(()=>{})}console.error(JSON.stringify({proof,errors,artifacts}));process.exitCode=1}).finally(()=>{window?.destroy();server?.closeAllConnections();server?.close();app.exit(process.exitCode||0)});
