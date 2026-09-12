// Real visible multichannel playback; all projects/media are disposable fixtures.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'otomatik-video-tracks-'));
app.setPath('userData',path.join(artifacts,'profile'));
const media=new Map(),projects=new Map(),errors=[],proof={};
let window,server;
const j=JSON.stringify,evaluate=code=>window.webContents.executeJavaScript(code);
const frames=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const screenshot=async name=>fs.promises.writeFile(path.join(artifacts,name+'.png'),(await window.webContents.capturePage()).toPNG());
async function waitReady(){
  return evaluate(`new Promise((resolve,reject)=>{const started=performance.now();const poll=()=>{const entries=[...document.querySelectorAll('.composite-layer:not([hidden])')];if(entries.every(entry=>{const video=entry.querySelector('video'),canvas=entry.querySelector('canvas');return video.readyState>=2&&!video.seeking&&Math.abs(Number(canvas.dataset.outputTime)-currentOutputTime())<.03}))return resolve();if(performance.now()-started>15000)return reject(new Error('Composite timeout '+JSON.stringify(entries.map(entry=>({id:entry.dataset.clipId,time:entry.querySelector('video').currentTime,ready:entry.querySelector('video').readyState,seeking:entry.querySelector('video').seeking})))));requestAnimationFrame(poll)};poll()})`);
}
async function seek(time){await evaluate(`pausePreview();seekOutputTime(${time})`);await waitReady();await frames()}
async function click(selector){
  await evaluate(`document.querySelector(${j(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);await frames();
  const p=await evaluate(`(()=>{const node=document.querySelector(${j(selector)}),r=node.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,reachable:!node.disabled&&node.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}})()`);
  assert.ok(p.reachable,'Reachable control '+selector+' '+j(p));
  for(const type of ['mouseDown','mouseUp'])window.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(p.x),y:Math.round(p.y)});
  await frames();
}
async function outputPixels(){
  const rect=await evaluate(`(()=>{const r=el('preview-stage').getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()`);
  const image=await window.webContents.capturePage(rect),{width,height}=image.getSize(),bytes=image.toBitmap();
  const pixel=(x,y)=>{const i=(Math.floor(y*height)*width+Math.floor(x*width))*4;return[bytes[i+2],bytes[i+1],bytes[i],bytes[i+3]]};
  return{center:pixel(.5,.5),middle:pixel(.75,.5),corner:pixel(.06,.08)};
}
const isColor=(pixel,name)=>name==='black'?pixel.slice(0,3).every(n=>n<12):name==='red'?pixel[0]>180&&pixel[1]<60&&pixel[2]<60:name==='blue'?pixel[2]>180&&pixel[0]<60&&pixel[1]<60:pixel[1]>90&&pixel[0]<60&&pixel[2]<60;
async function states(){return evaluate(`[...document.querySelectorAll('.composite-layer')].map(entry=>{const v=entry.querySelector('video'),canvas=entry.querySelector('canvas'),r=canvas.getBoundingClientRect(),stage=el('preview-stage').getBoundingClientRect();return{id:entry.dataset.clipId,hidden:entry.hidden,track:+entry.parentElement.dataset.videoTrack,z:+entry.parentElement.style.zIndex,time:v.currentTime,speed:v.playbackRate,muted:v.muted,paused:v.paused,source:canvas.dataset.sourceTime,width:r.width/stage.width,height:r.height/stage.height}})`)}

async function checkLayers(){
  await seek(2);const s=await states(),pixels=await outputPixels();
  proof.overlap={states:s,pixels};
  for(const[id,time,speed]of [['red-a',2,1],['blue',3,2],['green',2.25,.5]]){const item=s.find(value=>value.id===id);assert.ok(item&&!item.hidden,id+' active');assert.ok(Math.abs(item.time-time)<.05,j(item));assert.equal(item.speed,speed)}
  assert.ok(isColor(pixels.center,'green'),'Highest video channel should cover the center '+j(pixels));
  assert.ok(isColor(pixels.middle,'blue'),'Middle channel should cover the middle '+j(pixels));
  assert.ok(isColor(pixels.corner,'red'),'Base video remains visible outside smaller channels '+j(pixels));
  const crop=await evaluate(`(()=>{const canvas=document.querySelector('[data-clip-id="blue"] canvas'),ctx=canvas.getContext('2d');return{left:[...ctx.getImageData(canvas.width*.1,canvas.height*.5,1,1).data],right:[...ctx.getImageData(canvas.width*.9,canvas.height*.5,1,1).data]}})()`);
  assert.ok(isColor(crop.left,'blue')&&isColor(crop.right,'blue'),'Right-half source crop must discard the cyan left half '+j(crop));proof.crop=crop;
  await evaluate('S.thumbQueue');
  proof.thumbnails=await evaluate(`Promise.all(S.clips.map(async(clip,index)=>{const node=document.querySelector('#track [data-index="'+index+'"]'),background=node.style.backgroundImage,match=background.match(/url\\(["']?(data:image[^"')]+)["']?\\)/);if(!match)return{id:clip.clipId,background};const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=match[1]});const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.drawImage(image,image.width*.7,image.height*.5,1,1,0,0,1,1);return{id:clip.clipId,fileId:clip.fileId,pixel:[...ctx.getImageData(0,0,1,1).data]}}))`);
  for(const item of proof.thumbnails)assert.ok(item.pixel&&isColor(item.pixel,item.fileId.split('.')[0]),'Settled thumbnail must belong to its own source '+j(item));
  await screenshot('three-video-channels');
  await click('[data-video-track-id="3"][data-video-track-action="visible"]');await waitReady();await frames();
  proof.visibilityPixels=await outputPixels();
  assert.equal(await evaluate('videoTrackState(3).visible'),false);assert.ok(isColor(proof.visibilityPixels.center,'blue'),j(proof.visibilityPixels));
  await click('[data-video-track-id="2"][data-video-track-action="mute"]');assert.equal(await evaluate('videoTrackState(2).muted'),true);
  const muted=(await states()).find(item=>item.id==='blue');assert.equal(muted.muted,true);assert.equal((await states()).find(item=>item.id==='red-a').muted,false);
  await click('[data-video-track-id="3"][data-video-track-action="visible"]');await click('[data-video-track-id="2"][data-video-track-action="mute"]');
  await click('[data-video-track-id="3"][data-video-track-action="lock"]');
  const before=await evaluate('JSON.stringify(S.clips)');
  await evaluate(`S.selected=S.clips.findIndex(c=>c.clipId==='green');S.activeVideoTrack=3;splitClip();openTimelineCropDialog()`);
  assert.equal(await evaluate('JSON.stringify(S.clips)'),before);assert.equal(await evaluate(`el('timeline-crop-dialog').open`),false);
  await click('[data-video-track-id="3"][data-video-track-action="lock"]');
}

async function checkGapAndPlayback(){
  await seek(1.6);
  const parallel=await evaluate(`new Promise(async(resolve,reject)=>{const samples=[];let timer;try{await playPreview();timer=setTimeout(()=>{pausePreview();reject(new Error('Parallel playback timeout'))},10000);const tick=()=>{const time=currentOutputTime();samples.push({time,clips:[...document.querySelectorAll('.composite-layer:not([hidden])')].map(entry=>({id:entry.dataset.clipId,time:entry.querySelector('video').currentTime,rate:entry.querySelector('video').playbackRate}))});if(time>=2.35){clearTimeout(timer);pausePreview();return resolve(samples)}requestAnimationFrame(tick)};requestAnimationFrame(tick)}catch(error){clearTimeout(timer);reject(error)}})`);
  assert.ok(parallel.length>=6,'Multiple clips must advance on the shared output clock');
  for(const sample of parallel){
    for(const[id,expected,rate]of [['red-a',sample.time,1],['blue',1+(sample.time-1)*2,2],['green',2+(sample.time-1.5)*.5,.5]]){
      const item=sample.clips.find(clip=>clip.id===id);assert.ok(item,'All three clips remain active');assert.equal(item.rate,rate);assert.ok(Math.abs(item.time-expected)<.3,'Each video must advance at its own source speed '+j({sample,item,expected}));
    }
  }
  proof.parallelPlayback={frames:parallel.length,first:parallel[0],last:parallel.at(-1)};
  await seek(4.8);const black=await outputPixels();assert.ok(Object.values(black).every(p=>isColor(p,'black')),'A global gap must be black, not the previous source frame '+j(black));
  assert.ok((await states()).every(item=>item.hidden),'No stale video layer may remain visible in a gap');
  await seek(6.2);assert.ok(isColor((await outputPixels()).center,'red'));const after=(await states()).find(item=>item.id==='red-b');assert.ok(Math.abs(after.time-4.2)<.05);
  await seek(3.75);
  const samples=await evaluate(`new Promise(async(resolve,reject)=>{const samples=[];let timer;try{await playPreview();timer=setTimeout(()=>{pausePreview();reject(new Error('Playback failed to cross gap '+JSON.stringify(samples)))},12000);const tick=()=>{const time=currentOutputTime();samples.push({time,visible:[...document.querySelectorAll('.composite-layer:not([hidden])')].map(e=>e.dataset.clipId)});if(time>=6.25){clearTimeout(timer);pausePreview();return resolve(samples)}requestAnimationFrame(tick)};requestAnimationFrame(tick)}catch(error){clearTimeout(timer);reject(error)}})`);
  const gap=samples.filter(s=>s.time>4.1&&s.time<5.9);assert.ok(gap.length>=3,'Clock must advance normally through the gap');assert.ok(gap.every(s=>s.visible.length===0));
  assert.ok(samples.some(s=>s.time>6.05&&s.visible.includes('red-b')),'Playback must resume the later source');
  assert.ok(samples.every((s,index)=>!index||s.time>=samples[index-1].time),'Output clock must be monotonic');
  assert.ok(Math.max(...samples.slice(1).map((s,index)=>s.time-samples[index].time))<.4,'No hard seek/jump across the gap');
  proof.playback={frames:samples.length,gapFrames:gap.length,first:samples[0],last:samples.at(-1),maxStep:Math.max(...samples.slice(1).map((s,index)=>s.time-samples[index].time)),black,after};
}

async function checkChannelsAndPersistence(){
  await click('#video-track-add');assert.equal(await evaluate('S.videoTracks.length'),4);
  await evaluate(`el('timeline').scrollTop=S.videoLaneTops[4]-15;el('timeline').scrollLeft=0;S.timelineMagnet=false;drawMagnetButton()`);await frames();
  const points=await evaluate(`(()=>{const clip=S.clips.find(c=>c.clipId==='green'),node=document.querySelector('#video-track-3 [data-index="'+S.clips.indexOf(clip)+'"]'),r=node.getBoundingClientRect(),lane=el('video-track-4').getBoundingClientRect();return{from:{x:r.left+r.width*.6,y:r.top+r.height*.45},to:{x:r.left+r.width*.6,y:lane.top+lane.height*.45},sourceVisible:node.contains(document.elementFromPoint(r.left+r.width*.6,r.top+r.height*.45)),view:{width:innerWidth,height:innerHeight}}})()`);
  assert.ok(points.sourceVisible,'Cross-channel drag source must be visible '+j(points));assert.ok(points.to.y>0&&points.to.y<points.view.height);
  for(const[type,p]of [['mouseDown',points.from],['mouseMove',{x:points.from.x,y:points.from.y-12}],['mouseMove',points.to]]){window.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(p.x),y:Math.round(p.y)});await frames()}
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(points.to.x),y:Math.round(points.to.y)});await frames();
  const moved=await evaluate('JSON.parse(JSON.stringify(S.clips.find(c=>c.clipId==="green")))');assert.equal(moved.videoTrack,4);assert.ok(Math.abs(moved.timelineStart-1.5)<.02,'Vertical drag must preserve clip time');
  await evaluate('undoEdit()');await frames();assert.equal(await evaluate('S.clips.find(c=>c.clipId==="green").videoTrack'),3);
  for(let i=0;i<3;i++)await click('#video-track-add');assert.equal(await evaluate('S.videoTracks.length'),7,'Video channel creation has no three-channel cap');
  await evaluate(`videoTrackState(2).muted=true;videoTrackState(3).visible=false;videoTrackState(4).locked=true;drawClips();saveNamedProject()`);
  const saved=await evaluate('projectPayload()');assert.equal(projects.size,1);
  await evaluate('localStorage.clear()');await window.loadURL(`http://127.0.0.1:${server.address().port}/`);await evaluate('projectWorkspaceInitialization');
  await evaluate(`el('project-list').value='tracks';loadNamedProject()`);await frames();
  const recovered=await evaluate('projectPayload()');
  assert.deepEqual(recovered.timelines[0].state.videoTracks,saved.timelines[0].state.videoTracks);
  assert.deepEqual(recovered.timelines[0].state.clips.map(c=>({id:c.clipId,track:c.videoTrack,start:c.timelineStart,crop:c.crop,speed:c.speed})),saved.timelines[0].state.clips.map(c=>({id:c.clipId,track:c.videoTrack,start:c.timelineStart,crop:c.crop,speed:c.speed})));
  proof.persistence={points,moved,tracks:recovered.timelines[0].state.videoTracks};
}

async function checkTransitionPreroll(){
  await evaluate(`restoreProject({name:'Transition source handles fixture',mediaAssets:['red','blue','green'].map((name,index)=>({id:'asset'+index,fileId:name+'.mp4',name:name+'.mp4',kind:'video',duration:12})),activeTimelineId:'TL1',timelines:[{id:'TL1',name:'Upper channel crossfade',state:{...emptyTimelineState(),manualId:'green.mp4',manualName:'Green base',duration:12,selected:1,preview:1,videoTracks:[1,2].map(id=>({id,name:'Video '+id,locked:false,visible:true,muted:false})),activeVideoTrack:2,clips:[{clipId:'green-base',fileId:'green.mp4',start:0,end:4,timelineStart:0,videoTrack:1,sourceDuration:12},{clipId:'red-out',fileId:'red.mp4',start:0,end:2,timelineStart:0,videoTrack:2,sourceDuration:12},{clipId:'blue-in',fileId:'blue.mp4',start:0,end:2,timelineStart:2,videoTrack:2,sourceDuration:12,crop:{x:.5,y:0,width:.5,height:1}}],transitions:[{leftClipId:'red-out',rightClipId:'blue-in',type:'fade',duration:.5,requestedDuration:.5,boundary:1}],zoom:60}}]})`);
  await seek(1.75);await frames();
  const midpoint=await outputPixels();
  await evaluate('videoTrackState(1).visible=false;drawClips()');await waitReady();await frames();
  const withoutBase=await outputPixels();
  proof.transitionBlend={midpoint,withoutBase};
  for(let channel=0;channel<3;channel++)assert.ok(Math.abs(midpoint.center[channel]-withoutBase.center[channel])<3,'The lower green channel must not leak into the upper-track crossfade '+j(proof.transitionBlend));
  // Native capture measured128,11,145 in this fixture rather than exact arithmetic
  // RGB127,0,127. Require an approximately equal red/blue blend AND independently
  // prove no lower-channel contribution by comparing with the base hidden.
  assert.ok(Math.abs(midpoint.center[0]-127)<22&&midpoint.center[1]<18&&Math.abs(midpoint.center[2]-127)<22,'Same-channel crossfade must mix approximately equal red/blue '+j(midpoint));
  await evaluate('videoTrackState(1).visible=true;drawClips()');await frames();
  await screenshot('upper-track-crossfade-midpoint');
  await seek(1.55);
  const samples=await evaluate(`new Promise(async(resolve,reject)=>{const samples=[];let timer;try{await playPreview();timer=setTimeout(()=>{pausePreview();reject(new Error('Incoming transition playback timeout '+JSON.stringify(samples)))},10000);const tick=()=>{const time=currentOutputTime(),entry=document.querySelector('[data-clip-id="blue-in"]'),video=entry?.querySelector('video');samples.push({time,sourceTime:video?.currentTime,paused:video?.paused,muted:video?.muted,readyState:video?.readyState,visible:entry&&!entry.hidden});if(time>=2.4){clearTimeout(timer);pausePreview();return resolve(samples)}requestAnimationFrame(tick)};requestAnimationFrame(tick)}catch(error){clearTimeout(timer);reject(error)}})`);
  const preroll=samples.filter(sample=>sample.time<1.98),playing=samples.filter(sample=>sample.time>2.15);
  assert.ok(preroll.length>=6,'The real pre-roll interval must be sampled, not skipped');
  for(const sample of preroll){assert.ok(sample.visible&&sample.readyState>=2,'Incoming first frame is visible');assert.equal(sample.paused,true,'Missing incoming source handles must not play/reseek the first0.18s '+j(sample));assert.ok(sample.sourceTime<.025,'Incoming source remains on its first frame before cut '+j(sample));assert.equal(sample.muted,true,'Unavailable source handles cannot leak incoming audio')}
  assert.ok(playing.length>=3&&playing.some(sample=>!sample.paused&&!sample.muted&&sample.sourceTime>.1),'Incoming video and audio must start normally after the cut '+j(playing));
  proof.transitionPreroll={midpoint,frames:samples.length,prerollFrames:preroll.length,first:preroll[0],lastPreroll:preroll.at(-1),afterCut:playing.at(-1)};
}

app.whenReady().then(async()=>{
  const ffmpeg=process.env.SMART_EDITOR_FFMPEG||(process.platform==='win32'&&fs.existsSync(path.join(root,'tools/ffmpeg/bin/ffmpeg.exe'))?path.join(root,'tools/ffmpeg/bin/ffmpeg.exe'):'ffmpeg');
  for(const[name,color,frequency]of [['red','red',440],['blue','blue',660],['green','green',880]]){
    const file=path.join(artifacts,name+'.mp4'),filter=`color=c=${color}:s=320x180:r=30:d=12`+(name==='blue'?',drawbox=x=0:y=0:w=160:h=180:color=cyan:t=fill':'');
    execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i',filter,'-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=44100:duration=12`,'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',file],{timeout:60000});
    const bytes=fs.readFileSync(file);media.set(name+'.mp4',{bytes,file,hash:crypto.createHash('sha256').update(bytes).digest('hex')});
  }
  server=http.createServer(async(req,res)=>{
    try{const route=new URL(req.url,'http://fixture').pathname,reply=value=>{res.setHeader('Content-Type','application/json');res.end(j(value))};
      if(route==='/'){res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(root,'templates/index.html')));return}
      if(route==='/favicon.ico'){res.writeHead(204).end();return}
      if(route.startsWith('/static/')){const base=path.join(root,'static'),file=path.resolve(base,decodeURIComponent(route.slice(8)));if(!file.startsWith(base+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(fs.readFileSync(file));return}
      if(route==='/projects'&&req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=JSON.parse(Buffer.concat(chunks).toString());projects.set('tracks',{...data,id:'tracks'});reply({id:'tracks'});return}
      if(route==='/projects'){reply({projects:[...projects.values()].map(p=>({id:p.id,name:p.name}))});return}
      if(route==='/projects/tracks'){reply(projects.get('tracks'));return}
      if(route==='/api/version'||route==='/api/check-update'){reply({version:'tracks-fixture',update_available:false});return}
      if(route.startsWith('/waveform/')){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20"/>');return}
      const item=route.startsWith('/video/')?media.get(decodeURIComponent(route.slice(7))):null;
      if(item){const bytes=item.bytes,range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||''),start=range?+range[1]:0,end=range&&range[2]?Math.min(+range[2],bytes.length-1):bytes.length-1;res.writeHead(range?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}:{})});res.end(bytes.subarray(start,end+1));return}
      res.writeHead(404).end();
    }catch(error){errors.push(error.stack);res.writeHead(500).end()}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  window=new BrowserWindow({show:false,width:1366,height:768,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);await evaluate('projectWorkspaceInitialization');window.setContentSize(1366,768);window.showInactive();await frames();
  await evaluate(`restoreProject({name:'Video channels fixture',mediaAssets:['red','blue','green'].map((name,index)=>({id:'asset'+index,fileId:name+'.mp4',name:name+'.mp4',kind:'video',duration:12})),activeTimelineId:'TL1',timelines:[{id:'TL1',name:'Three channels',state:{...emptyTimelineState(),manualId:'red.mp4',manualName:'Red source',duration:12,selected:0,preview:0,videoTracks:[1,2,3].map(id=>({id,name:'Video '+id,locked:false,visible:true,muted:false})),activeVideoTrack:1,clips:[{clipId:'red-a',fileId:'red.mp4',start:0,end:4,timelineStart:0,videoTrack:1,sourceDuration:12},{clipId:'blue',fileId:'blue.mp4',start:1,end:5,speed:2,timelineStart:1,videoTrack:2,sourceDuration:12,scale:65,crop:{x:.5,y:0,width:.5,height:1}},{clipId:'green',fileId:'green.mp4',start:2,end:3,speed:.5,timelineStart:1.5,videoTrack:3,sourceDuration:12,scale:35},{clipId:'red-b',fileId:'red.mp4',start:4,end:6,timelineStart:6,videoTrack:1,sourceDuration:12}],zoom:45}}]})`);
  await checkLayers();await checkGapAndPlayback();await checkChannelsAndPersistence();await checkTransitionPreroll();
  for(const item of media.values())assert.equal(crypto.createHash('sha256').update(fs.readFileSync(item.file)).digest('hex'),item.hash,'Imported source bytes unchanged');
  assert.deepEqual(errors,[]);console.log(j({ok:true,proof,artifacts}));
}).catch(async error=>{console.error(error);proof.failureState=await states().catch(()=>null);await screenshot('failure').catch(()=>{});console.error(j({proof,errors,artifacts}));process.exitCode=1}).finally(()=>{window?.destroy();server?.closeAllConnections();server?.close();app.exit(process.exitCode||0)});
