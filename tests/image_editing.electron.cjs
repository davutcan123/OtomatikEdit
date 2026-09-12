// Run with Electron, not node:test. Every media file/project lives in a fresh temporary directory.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const repository=path.resolve(__dirname,'..');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'otomatik-image-editing-'));
app.setPath('userData',path.join(artifacts,'profile'));
const source=fs.readFileSync(path.join(repository,'templates/index.html'),'utf8');
const media=new Map(),savedProjects=new Map(),requests=[],errors=[],proof={};
let window,server;
const evaluate=code=>window.webContents.executeJavaScript(code);
const twoFrames=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const json=value=>JSON.stringify(value);
const digest=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const imageSelector=id=>`#image-track [data-layer-id="${id}"]`;
const overlaySelector=id=>`#media-overlay [data-layer-id="${id}"]`;
const waitForVideo=()=>evaluate(`new Promise((resolve,reject)=>{const video=el('manual-video');let timer;const names=['loadeddata','canplay','seeked','timeupdate'],clear=()=>{clearTimeout(timer);names.forEach(name=>video.removeEventListener(name,ready));video.removeEventListener('error',failed)},ready=()=>{if(video.readyState>=2&&!video.seeking){clear();resolve()}},failed=()=>{clear();reject(new Error(video.error?.message||'Fixture decode failed'))};names.forEach(name=>video.addEventListener(name,ready));video.addEventListener('error',failed);timer=setTimeout(()=>{clear();reject(new Error('Video timeout '+video.readyState))},10000);ready()})`);
async function seek(time){await evaluate(`seekOutputTime(${time})`);await waitForVideo();await twoFrames()}
async function screenshot(name){await fs.promises.writeFile(path.join(artifacts,name+'.png'),(await window.webContents.capturePage()).toPNG())}
async function click(selector){
  await evaluate(`(()=>{const node=document.querySelector(${json(selector)});if(!node)throw new Error('Missing control '+${json(selector)});node.scrollIntoView({block:'nearest',inline:'nearest'})})()`);await twoFrames();
  const point=await evaluate(`(()=>{const node=document.querySelector(${json(selector)}),r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,ready:!node.disabled&&node.contains(hit),disabled:node.disabled,width:r.width,height:r.height,viewport:{width:innerWidth,height:innerHeight},hit:hit?{id:hit.id,className:hit.className}:null}})()`);
  if(!point.ready)proof.unreachableControl={selector,...point};
  assert.ok(point.ready,`Control must be reachable: ${selector} ${JSON.stringify(point)}`);
  for(const type of ['mouseDown','mouseUp'])window.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(point.x),y:Math.round(point.y)});
  await twoFrames();
}
async function dragToTrack(selector,time,targetId=null){
  await evaluate(`el('timeline').scrollTop=Math.max(0,el('image-track').offsetTop-60);el('timeline').scrollLeft=0;document.querySelector(${json(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);await twoFrames();
  const points=await evaluate(`(()=>{const source=document.querySelector(${json(selector)}),a=source.getBoundingClientRect(),target=${targetId?`document.querySelector(${json(imageSelector(targetId))})`:`el('image-track')`},b=target.getBoundingClientRect(),track=el('image-track').getBoundingClientRect();return{from:{x:a.left+a.width/2,y:a.top+a.height/2},to:{x:track.left+${time}*S.zoom,y:b.top+b.height/2},viewport:{width:innerWidth,height:innerHeight},ready:source.contains(document.elementFromPoint(a.left+a.width/2,a.top+a.height/2))}})()`);
  assert.ok(points.ready,`Drag source must be visible: ${selector}`);
  const send=(type,p)=>window.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(p.x),y:Math.round(p.y)});
  send('mouseDown',points.from);send('mouseMove',{x:points.from.x+12,y:points.from.y+12});await twoFrames();
  // The first image lane is intentionally absent until the drag starts.
  points.to=await evaluate(`(()=>{const target=${targetId?`document.querySelector(${json(imageSelector(targetId))})`:`el('image-track')`},b=target.getBoundingClientRect(),track=el('image-track').getBoundingClientRect();return{x:track.left+${time}*S.zoom,y:b.top+b.height/2}})()`);
  assert.ok(points.to.x>=0&&points.to.x<points.viewport.width&&points.to.y>=0&&points.to.y<points.viewport.height,`Drag target must be inside the actual viewport: ${JSON.stringify(points)}`);
  assert.ok(await evaluate(`!el('drag-ghost').classList.contains('hidden')`),'Dragging must show a static drag preview');
  send('mouseMove',points.to);await twoFrames();send('mouseUp',points.to);await twoFrames();await waitForVideo();
  (proof.drags??=[]).push({selector,time,targetId,points,result:await evaluate(`({images:S.imageLayers.map(x=>({id:x.id,start:x.start,end:x.end})),log:el('manual-log').textContent.slice(-900)})`)});
}
async function changeInput(id,value){await evaluate(`(()=>{const input=el(${json(id)});input.focus();input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));input.value=${json(String(value))};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));window.dispatchEvent(new PointerEvent('pointerup'))})()`);await twoFrames()}
async function imageSnapshot(){return evaluate(`S.imageLayers.map(item=>JSON.parse(JSON.stringify(item)))`)}
async function previewSnapshot(){return evaluate(`S.imageLayers.map(item=>{const node=document.querySelector('#media-overlay [data-layer-id="'+item.id+'"]');return{id:item.id,visible:!!node,left:node?.style.left,top:node?.style.top,width:node?.style.width,opacity:node?.querySelector('img')?.style.opacity,filter:node?.querySelector('img')?.style.filter,src:node?.querySelector('img')?.getAttribute('src')}})`)}

async function sampleImagePlayback(first,{delayPlayMs=0,legacyWallBudget=false}={}){
  await seek(2.1);
  return evaluate(`new Promise(async resolve=>{
    const video=el('manual-video'),selector=${json(overlaySelector(first))},node=document.querySelector(selector),item=S.imageLayers.find(value=>value.id===${json(first)}),samples=[],originalPlay=video.play,requestedAt=performance.now();
    let timer,raf,finished=false,playResolvedAt=null,startMediaTime=null;
    const block=event=>event.stopImmediatePropagation(),state=()=>({currentTime:video.currentTime,outputTime:currentOutputTime(),paused:video.paused,seeking:video.seeking,readyState:video.readyState,visibility:document.visibilityState,previewFrame:S.previewFrame}),done=reason=>{
      if(finished)return;finished=true;cancelAnimationFrame(raf);clearTimeout(timer);const finalState=state();video.pause();video.play=originalPlay;video.removeEventListener('timeupdate',block,true);
      resolve({reason,samples,state:finalState,playStartupMs:playResolvedAt===null?null:playResolvedAt-requestedAt,elapsedAfterPlayMs:playResolvedAt===null?null:performance.now()-playResolvedAt,startMediaTime});
    };
    video.addEventListener('timeupdate',block,true);
    if(${delayPlayMs}>0)video.play=async function(){await new Promise(ready=>setTimeout(ready,${delayPlayMs}));return originalPlay.call(this)};
    timer=setTimeout(()=>done('play-start-timeout'),10000);
    try{
      await video.play();if(finished){video.pause();return}playResolvedAt=performance.now();startMediaTime=currentOutputTime();clearTimeout(timer);timer=setTimeout(()=>done('sampling-timeout'),10000);
      const tick=()=>{
        const current=document.querySelector(selector),time=currentOutputTime(),expectedWidth=item.scale*imageTransformAtTime(item,time).scale/100;
        samples.push({time,mediaTime:video.currentTime,width:current?.style.width,expectedWidth,sameNode:current===node,elapsed:performance.now()-playResolvedAt});
        const distinct=new Set(samples.map(value=>value.width));
        if(${legacyWallBudget}&&performance.now()-requestedAt>850)return done('legacy-wall-budget');
        if(!${legacyWallBudget}&&distinct.size>=6&&time-startMediaTime>=.5)return done('observed-motion');
        raf=requestAnimationFrame(tick);
      };raf=requestAnimationFrame(tick);
    }catch(error){done('play-error: '+error.message)}
  })`);
}

async function checkImageKeyframes(first,second){
  await evaluate(`selectImageLayer(${json(first)},false)`);await seek(1);
  for(const [time,values] of [[1,{scale:100,x:35,y:40,opacity:100}],[5,{scale:200,x:65,y:60,opacity:30}]]){
    await seek(time);
    await evaluate(`for(const [key,value] of Object.entries(${json(values)}))el('image-kf-'+key).value=value;el('image-kf-easing').value='linear'`);
    await click('#image-kf-add');
  }
  const layers=await imageSnapshot(),a=layers.find(x=>x.id===first),b=layers.find(x=>x.id===second);
  assert.deepEqual(a.transformKeyframes.map(x=>x.time),[0,4]);assert.equal(b.transformKeyframes.length,0,'Second image must not inherit first image keyframes');
  const diamonds=await evaluate(`[...document.querySelectorAll('#image-track [data-image-kf]')].map(node=>({id:node.dataset.imageId,keyframe:node.dataset.imageKf,left:parseFloat(node.style.left)}))`);
  assert.deepEqual(diamonds.filter(x=>x.id===first).map(x=>x.left).sort((a,b)=>a-b),[40,200]);
  await seek(3);const midpoint=await previewSnapshot(),visibleA=midpoint.find(x=>x.id===first),visibleB=midpoint.find(x=>x.id===second);
  assert.ok(visibleA.visible&&visibleB.visible);assert.equal(parseFloat(visibleA.left),50);assert.equal(parseFloat(visibleA.top),50);assert.ok(Math.abs(parseFloat(visibleA.width)-a.scale*1.5)<.01);assert.ok(Math.abs(+visibleA.opacity-.65)<.01);assert.notEqual(visibleA.src,visibleB.src);
  await evaluate(`selectImageKeyframe(${json(first)},${json(a.transformKeyframes[1].id)})`);await twoFrames();
  proof.beforeKeyframeEdit=await evaluate(`({selection:S.selectedImageKeyframe,focus:document.activeElement.id,history:S.history.map(h=>h.imageLayers?.map(x=>x.transformKeyframes?.length))})`);
  await changeInput('image-kf-scale',180);
  proof.afterKeyframeEdit=await evaluate(`({selection:S.selectedImageKeyframe,focus:document.activeElement.id,history:S.history.map(h=>h.imageLayers?.map(x=>x.transformKeyframes?.length))})`);
  assert.equal((await imageSnapshot()).find(x=>x.id===first).transformKeyframes[1].scale,180);
  assert.equal((await imageSnapshot()).find(x=>x.id===first).scale,a.scale,'Editing a keyframe must not overwrite base image scale');
  await evaluate('undoEdit()');await waitForVideo();await twoFrames();
  proof.afterUndo=await imageSnapshot();
  assert.equal((await imageSnapshot()).find(x=>x.id===first).transformKeyframes[1].scale,200,'Undo must restore the edited keyframe');
  await changeInput('image-kf-opacity',50);await changeInput('image-kf-opacity',40);
  await evaluate('undoEdit()');await waitForVideo();await twoFrames();
  assert.equal((await imageSnapshot()).find(x=>x.id===first).transformKeyframes[1].opacity,50,'A second gesture on an already focused slider must have its own undo entry');
  await evaluate('undoEdit()');await waitForVideo();await twoFrames();
  assert.equal((await imageSnapshot()).find(x=>x.id===first).transformKeyframes[1].opacity,30);
  await changeInput('image-kf-time',4);
  assert.equal((await imageSnapshot()).find(x=>x.id===first).transformKeyframes[1].time,3,'Keyframe time field must convert output seconds to image-relative time');
  assert.equal(await evaluate(`parseFloat(document.querySelector('[data-image-kf="${a.transformKeyframes[1].id}"]').style.left)`),160);
  await evaluate('undoEdit()');await waitForVideo();await twoFrames();
  await evaluate(`selectImageKeyframe(${json(first)},${json(a.transformKeyframes[0].id)})`);await waitForVideo();await twoFrames();
  const handle=await evaluate(`(()=>{const node=document.querySelector(${json(overlaySelector(first)+' .transform-handle.scale')}),r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,reachable:node.contains(document.elementFromPoint(x,y))}})()`);
  assert.ok(handle.reachable,'Image scaling handle must be reachable in the player');
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(handle.x),y:Math.round(handle.y)});
  window.webContents.sendInputEvent({type:'mouseMove',button:'left',x:Math.round(handle.x+20),y:Math.round(handle.y+10)});await twoFrames();
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(handle.x+20),y:Math.round(handle.y+10)});await twoFrames();
  const transformed=await imageSnapshot(),edited=transformed.find(x=>x.id===first);
  assert.ok(edited.transformKeyframes[0].scale>100,'Player scaling must update the selected image keyframe');assert.equal(edited.scale,a.scale);assert.equal(edited.transformKeyframes[1].scale,200);assert.deepEqual(transformed.find(x=>x.id===second),b);
  await evaluate('undoEdit()');await waitForVideo();await twoFrames();
  const beforeLocked=await imageSnapshot();await evaluate('S.trackState.image.locked=true;drawClips()');
  assert.equal(await evaluate(`['image-kf-scale','image-kf-add','image-kf-clear'].every(id=>el(id).disabled)`),true);
  await evaluate(`updateSelectedImageKeyframe('scale',250);addImageKeyframe();deleteSelectedImageKeyframe();el('image-kf-clear').click()`);
  assert.deepEqual(await imageSnapshot(),beforeLocked,'Locked image keyframes must reject every editing entry point');
  await evaluate('S.trackState.image.locked=false;drawClips()');
  proof.keyframes={layers,diamonds,midpoint};
  proof.keyframeManipulation={handle,scale:edited.transformKeyframes[0].scale,baseScale:edited.scale,lockedUnchanged:true};
}

async function checkToolDrops(first,second){
  const before=await evaluate('JSON.parse(JSON.stringify(S.clips))');
  for(const [tab,selector,field,value,target,time] of [
    ['animation','.animation-card[data-animation="fadein"]','animation','fadein',first,2],
    ['video','.video-effect-card[data-video-effect="cyberpunk"]','effect','cyberpunk',first,2],
    ['filter','.filter-card[data-filter="golden"]','filter','golden',second,7],
  ]){
    await evaluate(`switchAssetTab(${json(tab)})`);await dragToTrack(selector,time,target);
    const layers=await imageSnapshot();assert.equal(layers.find(x=>x.id===target)[field],value,`${field} card must affect the image under the pointer`);
    assert.equal(layers.find(x=>x.id!==target)[field],'none',`${field} must not leak to the other image`);
    assert.deepEqual(await evaluate('JSON.parse(JSON.stringify(S.clips))'),before,'Dropping on the image lane must never modify the underlying video');
  }
  const unlocked=await imageSnapshot();await evaluate('S.trackState.image.locked=true;drawClips();switchAssetTab("video")');
  await dragToTrack('.video-effect-card[data-video-effect="none"]',2,first);assert.deepEqual(await imageSnapshot(),unlocked,'Locked image lane must reject effects');
  await evaluate('S.trackState.image.locked=false;drawClips()');proof.tools=unlocked;
}

async function checkTrimAndPlayback(first){
  await evaluate(`selectImageLayer(${json(first)},false);applyImageTool('animation','none',${json(first)});applyImageTool('effect','none',${json(first)})`);await seek(3);
  const before=(await previewSnapshot()).find(x=>x.id===first);
  await evaluate(`(()=>{const node=document.querySelector(${json(imageSelector(first))}),handle=node.querySelector('.trim-handle.left'),r=handle.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:x,clientY:y}));window.dispatchEvent(new PointerEvent('pointermove',{clientX:x+40,clientY:y}));window.dispatchEvent(new PointerEvent('pointerup'))})()`);await twoFrames();await seek(3);
  const item=(await imageSnapshot()).find(x=>x.id===first),after=(await previewSnapshot()).find(x=>x.id===first);
  assert.equal(item.start,2);assert.equal(item.end,6);assert.ok(item.transformKeyframes.some(x=>x.time===0));
  for(const key of ['left','top','width','opacity'])assert.ok(Math.abs(parseFloat(before[key])-parseFloat(after[key]))<.03,`Left trim must preserve absolute-time ${key}`);
  // Windows' native compositor gave this never-shown fixture exactly one RAF
  // per second despite backgroundThrottling:false. Exercise visible playback,
  // as a user does, without focusing the disposable window or changing runtime.
  window.showInactive();await twoFrames();
  proof.playbackWindow={visible:window.isVisible(),minimized:window.isMinimized(),viewport:await evaluate('({width:innerWidth,height:innerHeight,visibility:document.visibilityState})')};
  assert.ok(proof.playbackWindow.visible&&!proof.playbackWindow.minimized,'Playback cadence must be tested in a real visible window');
  proof.trim={item,before,after};proof.playback=[];
  // A slow play() startup used to consume the whole 850ms observation budget.
  // Reproduce that exact old failure, then exercise the real sampler with and
  // without the same injected startup delay. Production playback is not changed.
  const legacy=await sampleImagePlayback(first,{delayPlayMs:1100,legacyWallBudget:true});
  proof.legacyPlaybackBudget={...legacy,distinctWidths:new Set(legacy.samples.map(sample=>sample.width)).size};
  assert.ok(legacy.playStartupMs>=1000&&legacy.samples.length===1,'Delayed playback must reproduce the previous one-sample timing flaw');
  for(const delayPlayMs of [0,1100]){
    const result=await sampleImagePlayback(first,{delayPlayMs}),samples=result.samples;
    proof.playback.push({...result,delayPlayMs,frames:samples.length,distinctWidths:new Set(samples.map(sample=>sample.width)).size});
    const diagnostic=JSON.stringify(proof.playback.at(-1));
    assert.equal(result.reason,'observed-motion','Real playback must start and advance: '+diagnostic);
    assert.ok(samples.every(sample=>sample.sameNode),'The same image DOM node should be retained across frames: '+diagnostic);
    assert.ok(new Set(samples.map(sample=>sample.width)).size>=6,'Image keyframes must update on animation frames even when timeupdate is suppressed: '+diagnostic);
    assert.ok(samples.at(-1).time-result.startMediaTime>=.5,'The real media clock must advance at least half a second: '+diagnostic);
    samples.forEach((sample,index)=>{
      const previous=samples[Math.max(0,index-1)].expectedWidth,low=Math.min(previous,sample.expectedWidth)-.6,high=Math.max(previous,sample.expectedWidth)+.6;
      assert.ok(parseFloat(sample.width)>=low&&parseFloat(sample.width)<=high,'Preview width must match its interpolated keyframe (at most one animation-frame lag): '+JSON.stringify({sample,previous}));
    });
  }
}

async function checkPersistence(){
  await evaluate(`const image=S.imageLayers[0];selectImageLayer(image.id,false);applyImageTool('animation','fadein',image.id);applyImageTool('effect','cyberpunk',image.id)`);
  await changeInput('image-effect-intensity',60);await changeInput('image-animation-duration',1.7);
  await evaluate(`selectImageLayer(S.imageLayers[1].id,false)`);await changeInput('image-filter-intensity',70);
  await evaluate('saveNamedProject()');assert.equal(savedProjects.size,1);
  const original=await imageSnapshot(),form=await evaluate('Object.fromEntries(buildRenderForm(manualExportData()).entries())');
  const exported=JSON.parse(form.images);assert.equal(exported.length,2);
  for(const item of original){const output=exported.find(x=>x.id===item.id||x.fileId===item.fileId);assert.ok(output);assert.deepEqual(output.transformKeyframes,item.transformKeyframes);for(const field of ['animation','effect','filter','animationDuration','effectIntensity','filterIntensity'])assert.equal(output[field],item[field])}
  await evaluate('localStorage.clear()');const reloaded=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));window.reload();await reloaded;await evaluate('projectWorkspaceInitialization');
  await evaluate(`el('project-list').value='image-fixture-project';loadNamedProject()`);await waitForVideo();await twoFrames();
  const recovered=await imageSnapshot();assert.deepEqual(recovered,original,'Named-project reload must preserve every image parameter');
  proof.persistence={formImages:exported,recovered};
}

async function checkLibraryRemoval(){
  const storedBefore=JSON.stringify([...savedProjects.entries()]);
  await evaluate(`syncActiveTimeline();const blue=S.imageLayers.find(x=>x.fileId==='blue.png');S.timelines.push({id:'TL2',name:'Other timeline',state:{...emptyTimelineState(),manualId:'source.mp4',duration:12,clips:copy(S.clips),imageLayers:copyLayers([blue])}});S.trackState.image.locked=false;drawClips()`);
  const before=await evaluate('projectPayload()'),unused=before.mediaAssets.find(x=>x.fileId==='unused.png'),used=before.mediaAssets.find(x=>x.fileId==='blue.png');
  await evaluate('S.autoAnalyzing=true');await click(`[data-asset-remove="${used.id}"]`);
  assert.equal(await evaluate(`el('asset-remove-library').disabled&&el('asset-remove-all').disabled`),true,'Analysis in progress must disable both removal choices');
  assert.equal(await evaluate(`removeProjectAsset(${json(used.id)},true)`),false);await click('#asset-remove-cancel');await evaluate('S.autoAnalyzing=false');
  assert.deepEqual(await evaluate('projectPayload()'),before);
  await click(`[data-asset-remove="${unused.id}"]`);assert.ok(await evaluate(`el('asset-remove-dialog').open`));
  await evaluate(`el('asset-remove-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'b',bubbles:true}));el('asset-remove-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}))`);
  assert.equal(await evaluate('S.clips.length'),before.timelines[0].state.clips.length);assert.equal(await evaluate('mv.paused'),true);
  await click('#asset-remove-cancel');assert.deepEqual(await evaluate('projectPayload()'),before,'Cancel must not remove an asset or timeline item');
  await click(`[data-asset-remove="${unused.id}"]`);await click('#asset-remove-library');
  const unusedRemoved=await evaluate('projectPayload()');assert.ok(!unusedRemoved.mediaAssets.some(x=>x.id===unused.id));assert.deepEqual(unusedRemoved.timelines,before.timelines);
  await evaluate('undoEdit()');await waitForVideo();await twoFrames();assert.deepEqual(await evaluate('projectPayload()'),before,'Undo must restore library removal including inactive timelines');
  await click(`[data-asset-remove="${used.id}"]`);await click('#asset-remove-library');
  const libraryOnly=await evaluate('projectPayload()');assert.ok(!libraryOnly.mediaAssets.some(x=>x.id===used.id));assert.deepEqual(libraryOnly.timelines,before.timelines,'Library-only removal must leave used images playable');
  await seek(3);assert.ok((await previewSnapshot()).find(x=>x.id===before.timelines[0].state.imageLayers.find(y=>y.fileId==='blue.png').id).visible);
  await evaluate('undoEdit()');await waitForVideo();await twoFrames();
  await evaluate('S.trackState.image.locked=true;drawClips()');await click(`[data-asset-remove="${used.id}"]`);
  assert.equal(await evaluate(`el('asset-remove-all').disabled`),true,'A locked used track must block removing timeline uses');await click('#asset-remove-cancel');
  await evaluate('S.trackState.image.locked=false;drawClips()');await click(`[data-asset-remove="${used.id}"]`);await click('#asset-remove-all');
  const allRemoved=await evaluate('projectPayload()');assert.ok(!allRemoved.mediaAssets.some(x=>x.id===used.id));
  for(const timeline of allRemoved.timelines){assert.ok(!timeline.state.imageLayers.some(x=>x.fileId==='blue.png'));assert.deepEqual(timeline.state.clips,before.timelines.find(x=>x.id===timeline.id).state.clips)}
  assert.ok(allRemoved.timelines[0].state.imageLayers.some(x=>x.fileId==='red.png'),'Other images must remain');
  await evaluate('undoEdit()');await waitForVideo();await twoFrames();const restored=await evaluate('projectPayload()');assert.deepEqual(restored,before,'Undo must restore all image uses and both timeline states');
  assert.equal(JSON.stringify([...savedProjects.entries()]),storedBefore,'Removing from the working project must not rewrite an existing saved project');
  proof.removal={unusedRemoved:unusedRemoved.mediaAssets.map(x=>x.fileId),libraryOnlyRetainedUses:libraryOnly.timelines.map(x=>x.state.imageLayers.length),allRemoved:allRemoved.timelines.map(x=>x.state.imageLayers.map(y=>y.fileId)),restoredTimelines:restored.timelines.length};
}

async function checkShortViewportControls(first){
  for(const [width,height] of [[1024,600],[1366,600],[900,620],[900,580],[1366,580]]){
    window.setContentSize(width,height);await twoFrames();
    await evaluate(`selectImageLayer(${json(first)},false);S.selectedImageKeyframe=null;drawClips()`);await seek(3);
    const before=await imageSnapshot();await click('#image-kf-add');
    assert.equal((await imageSnapshot()).find(item=>item.id===first).transformKeyframes.length,before.find(item=>item.id===first).transformKeyframes.length+1,'Short viewport must allow adding a real keyframe');
    (proof.shortViewports??=[]).push(await evaluate(`({width:innerWidth,height:innerHeight,pageScroll:document.documentElement.scrollTop,frameCount:selectedImageLayer().transformKeyframes.length})`));
    await screenshot(`image-short-${width}x${height}`);await evaluate('undoEdit()');await waitForVideo();await twoFrames();
    assert.deepEqual(await imageSnapshot(),before,'Short viewport gesture undo must restore original keyframes');
  }
}

app.whenReady().then(async()=>{
  const ffmpeg=process.env.SMART_EDITOR_FFMPEG||(process.platform==='win32'&&fs.existsSync(path.join(repository,'tools/ffmpeg/bin/ffmpeg.exe'))?path.join(repository,'tools/ffmpeg/bin/ffmpeg.exe'):'ffmpeg');
  const make=(name,args,type)=>{const file=path.join(artifacts,name);execFileSync(ffmpeg,['-v','error','-y',...args,file],{timeout:60000});const bytes=fs.readFileSync(file);media.set(name,{bytes,type,file,hash:digest(bytes)})};
  make('source.mp4',['-f','lavfi','-i','color=c=0x223344:s=640x360:r=30:d=12','-c:v','libx264','-pix_fmt','yuv420p'],'video/mp4');
  for(const [name,color,size] of [['red.png','red','160x100'],['blue.png','blue','100x160'],['unused.png','green','96x96']])make(name,['-f','lavfi','-i',`color=c=${color}:s=${size}`,'-frames:v','1'],'image/png');
  server=http.createServer(async(request,response)=>{
    try{const route=request.url.split('?')[0];requests.push({method:request.method,path:route});const reply=value=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(value))};
      if(route==='/favicon.ico'){response.writeHead(204).end();return}
      if(route==='/'){response.setHeader('Content-Type','text/html');response.end(source);return}
      if(route.startsWith('/static/')){const file=path.resolve(repository,'.'+route);if(!file.startsWith(path.join(repository,'static')+path.sep)||!fs.existsSync(file)){response.writeHead(404).end();return}response.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');response.end(fs.readFileSync(file));return}
      if(route==='/upload'){const chunks=[];for await(const chunk of request)chunks.push(chunk);const form=await new Request('http://fixture/upload',{method:'POST',headers:{'content-type':request.headers['content-type']},body:Buffer.concat(chunks)}).formData(),file=form.get('file'),known=media.get(file.name);assert.ok(known);assert.equal(digest(Buffer.from(await file.arrayBuffer())),known.hash);reply({file_id:file.name,name:file.name,media_kind:'image',duration:0,url:'/video/'+file.name});return}
      if(route==='/projects'&&request.method==='POST'){const chunks=[];for await(const chunk of request)chunks.push(chunk);const value=JSON.parse(Buffer.concat(chunks).toString()),id=value.id||'image-fixture-project';savedProjects.set(id,{...value,id});reply({id});return}
      if(route==='/projects'){reply({projects:[...savedProjects.values()].map(x=>({id:x.id,name:x.name}))});return}
      if(route.startsWith('/projects/')){reply(savedProjects.get(route.split('/').at(-1)));return}
      if(route==='/api/check-update'||route==='/api/version'){reply(route==='/api/version'?{version:'image-fixture'}:{update_available:false});return}
      const item=route.startsWith('/waveform/')?media.get('unused.png'):media.get(decodeURIComponent(route.slice('/video/'.length)));
      if(item&&(route.startsWith('/video/')||route.startsWith('/waveform/'))){const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range||''),start=range?+range[1]:0,end=range&&range[2]?Math.min(item.bytes.length-1,+range[2]):item.bytes.length-1;response.statusCode=range?206:200;response.setHeader('Content-Type',item.type);response.setHeader('Accept-Ranges','bytes');response.setHeader('Content-Length',end-start+1);if(range)response.setHeader('Content-Range',`bytes ${start}-${end}/${item.bytes.length}`);response.end(item.bytes.subarray(start,end+1));return}
      response.writeHead(404).end();
    }catch(error){errors.push(error.stack);response.writeHead(500).end()}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  window=new BrowserWindow({show:false,width:1366,height:740,useContentSize:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);await evaluate('projectWorkspaceInitialization');
  proof.initialViewport=await evaluate(`({width:innerWidth,height:innerHeight})`);
  // Windows may clamp constructor dimensions to the runner's display. Explicitly
  // set the content size after creation, as the other real Electron fixtures do.
  window.setContentSize(1366,740);await twoFrames();
  proof.settledViewport=await evaluate(`({width:innerWidth,height:innerHeight})`);
  assert.deepEqual(proof.settledViewport,{width:1366,height:740},'Image interactions require the requested desktop viewport');
  await evaluate(`restoreProject({name:'Image editing fixture',mediaAssets:[{id:'MV',fileId:'source.mp4',name:'Source video',kind:'video',duration:12}],nextAssetId:1,activeTimelineId:'TL1',timelines:[{id:'TL1',name:'Image timeline',state:{manualId:'source.mp4',manualName:'Source video',duration:12,selected:0,preview:0,clips:[{start:0,end:12,fileId:'source.mp4',sourceDuration:12,timelineStart:0}],canvas:{width:1920,height:1080},zoom:40}}]})`);await waitForVideo();
  await evaluate(`(async()=>{const files=[];for(const name of ['red.png','blue.png','unused.png'])files.push(new File([await(await fetch('/video/'+name)).blob()],name,{type:'image/png'}));await importProjectFiles(files)})()`);await twoFrames();
  const assets=await evaluate('S.mediaAssets.map(x=>({id:x.id,fileId:x.fileId}))'),red=assets.find(x=>x.fileId==='red.png'),blue=assets.find(x=>x.fileId==='blue.png');
  await dragToTrack(`[data-asset-id="${red.id}"]`,1);await dragToTrack(`[data-asset-id="${blue.id}"]`,3);
  const layers=await imageSnapshot();assert.equal(layers.length,2);assert.notEqual(layers[0].id,layers[1].id);assert.notEqual(layers[0].src,layers[1].src);
  for(const [index,start] of [[0,1],[1,3]])assert.ok(Math.abs(layers[index].start-start)<=1/40,'Image drag must use the output time under the pointer');
  // Native pointers use integer pixels; normalize the fixture's subpixel drop rounding
  // before testing exact second-based keyframe arithmetic.
  await evaluate(`S.imageLayers.forEach((item,index)=>{item.start=index?3:1;item.end=item.start+5});drawClips()`);
  const first=layers.find(x=>x.fileId==='red.png').id,second=layers.find(x=>x.fileId==='blue.png').id;proof.imported={assets,layers};
  await checkImageKeyframes(first,second);await checkToolDrops(first,second);await checkTrimAndPlayback(first);await checkPersistence();
  for(const [width,height] of [[1366,768],[1100,700]]){
    window.setContentSize(width,height);await twoFrames();await seek(3);await evaluate(`selectImageLayer(${json(first)},false)`);await screenshot(`image-editor-${width}x${height}`);
    await evaluate(`el('image-kf-scale').scrollIntoView({block:'center',inline:'nearest'})`);await twoFrames();
    const geometry=await evaluate(`(()=>{const rect=id=>{const r=el(id).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}},input=el('image-kf-scale'),r=input.getBoundingClientRect();return{preview:rect('preview-stage'),timeline:rect('timeline'),keyframe:rect('image-kf-scale'),keyframeReachable:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===input,scroll:document.documentElement.scrollTop}})()`);
    assert.ok(geometry.preview.y>=0&&geometry.preview.bottom<=height&&geometry.preview.height>=219,'Preview must remain visible while image controls are scrolled');
    assert.ok(geometry.timeline.height>=199&&geometry.timeline.bottom<=height,'Timeline must remain visible while editing images');assert.ok(geometry.keyframeReachable,'Image keyframe slider must be reachable by internal scrolling');
    (proof.geometry??=[]).push({width,height,...geometry});await screenshot(`image-keyframes-${width}x${height}`);
  }
  await checkLibraryRemoval();
  await checkShortViewportControls(first);
  for(const item of media.values())assert.equal(digest(fs.readFileSync(item.file)),item.hash,'Editing must never modify imported originals');
  proof.originalFilesUnchanged=Object.fromEntries([...media].map(([name,item])=>[name,item.hash]));
  assert.deepEqual(requests.filter(x=>x.method==='DELETE'),[],'No fixture source file may be deleted');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,...proof,errors,artifacts}));
}).catch(async error=>{console.error(error);if(window){proof.failureGeometry=await evaluate(`(()=>{const bounds=id=>{const node=el(id);if(!node)return null;const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scrollTop:node.scrollTop,scrollHeight:node.scrollHeight}};return{viewport:{width:innerWidth,height:innerHeight},pageScroll:document.documentElement.scrollTop,panels:Object.fromEntries(['image-inspector','image-inspector-content','image-kf-add','preview-stage','timeline','image-track'].map(id=>[id,bounds(id)]))}})()`).catch(()=>null);await screenshot('failure').catch(()=>{})}console.error(JSON.stringify({proof,errors}));console.error('Image fixture retained at '+artifacts);process.exitCode=1}).finally(()=>{window?.destroy();server?.closeAllConnections();server?.close();app.exit(process.exitCode||0)});
