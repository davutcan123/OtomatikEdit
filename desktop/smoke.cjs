'use strict';
// Explicit --smoke-test only; main creates an isolated temporary project folder.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { app, ipcMain, BrowserWindow } = require('electron');
const { waitForMedia } = require('./media-ready.cjs');

exports.run = async ({ mainWindow, origin, token, dataDir, health }) => {
  const errors = [];
  mainWindow.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message);
  });
  const headers = { 'X-Desktop-Token': token };
  const request = (route, options = {}) => fetch(origin + route, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(120000) });
  const waitForVideo = async () => {
    try {
      await mainWindow.webContents.executeJavaScript(`(${waitForMedia.toString()})(document.getElementById('manual-video'))`);
    } catch (error) {
      const state = await mainWindow.webContents.executeJavaScript(`(()=>{const v=document.getElementById('manual-video');return{readyState:v.readyState,networkState:v.networkState,seeking:v.seeking,time:v.currentTime,duration:v.duration,error:v.error?.message,src:v.currentSrc,preview:S.preview,selected:S.selected,outputTime:currentOutputTime()}})()`);
      throw new Error(error.message + ': ' + JSON.stringify(state));
    }
  };
  assert.equal(health.desktop, true);
  assert.equal((await fetch(origin + '/api/health')).status, 403);
  const css = await request('/static/editor.css');
  assert.equal(css.status, 200);
  assert.ok((await css.text()).length > 5000);
  await mainWindow.webContents.executeJavaScript('projectWorkspaceInitialization');
  const ui = await mainWindow.webContents.executeJavaScript(`({title:document.title,desktop:window.desktopApp.isDesktop,node:typeof require,ready:projectWorkspaceReady,bg:getComputedStyle(document.body).backgroundColor})`);
  assert.equal(ui.desktop, true); assert.equal(ui.node, 'undefined'); assert.equal(ui.ready, true);
  const storage = await mainWindow.webContents.executeJavaScript('window.desktopApp.getStorageInfo()');
  assert.equal(storage.path, dataDir);
  assert.ok((await fs.stat(storage.projectsPath)).isDirectory());
  const ffmpeg = app.isPackaged ? path.join(process.resourcesPath, 'backend', '_internal', 'tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : (process.env.SMART_EDITOR_FFMPEG || 'ffmpeg');
  const fixture = path.join(dataDir, 'test-input.mp4');
  await execFile(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture], { timeout: 60000 });
  const upload = new FormData();
  upload.set('file', new Blob([await fs.readFile(fixture)], { type: 'video/mp4' }), 'Masaüstü deneme.mp4');
  const uploadResponse = await request('/upload', { method: 'POST', body: upload });
  assert.equal(uploadResponse.status, 200);
  const media = await uploadResponse.json();
  assert.ok(media.duration >= 1.9);
  const payload = { name: 'Masaüstü test projesi', activeTimelineId: 'TL1', mediaAssets: [{ id: 'A1', fileId: media.file_id, name: media.name, kind: 'video', duration: media.duration }], timelines: [{ id: 'TL1', name: 'Ana video', state: { manualId: media.file_id, manualName: media.name, duration: media.duration, selected: 0, preview: 0, clips: [{ id: 'K1', fileId: media.file_id, name: media.name, start: 0, end: 2, timelineStart: 0 }], canvas: { width: 1920, height: 1080 } } }] };
  await mainWindow.webContents.executeJavaScript(`restoreProject(${JSON.stringify(payload)});persistProjectRecovery()`);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'recovery.json'), 'utf8')).name, payload.name);
  const saved = await (await request('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
  assert.ok(saved.id);
  assert.equal((await (await request('/projects/' + saved.id)).json()).name, payload.name);
  await waitForVideo();
  const played = await mainWindow.webContents.executeJavaScript(`(async()=>{const v=document.getElementById('manual-video');v.muted=true;await v.play();await new Promise(r=>setTimeout(r,350));v.pause();return{time:v.currentTime,width:v.videoWidth,height:v.videoHeight}})()`, true);
  assert.ok(played.width === 640 && played.time > 0);
  const form = new FormData();
  for (const [key, value] of Object.entries({ file_id: media.file_id, fmt: 'mp4', fps: '30', quality: 'standard', width: '640', height: '360', segments: JSON.stringify([{ start: 0, end: 1.5 }]) })) form.set(key, value);
  const renderResponse = await request('/start-render', { method: 'POST', body: form });
  assert.equal(renderResponse.status, 200);
  const job = await renderResponse.json();
  const eventText = await (await request('/stream-events/' + job.job_id)).text();
  const events = eventText.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const result = events.find(item => item.type === 'result' && item.download_url);
  assert.ok(result, JSON.stringify(events.slice(-8)));
  const output = await request(result.download_url);
  assert.equal(output.status, 200);
  assert.match(output.headers.get('content-type'), /video\/mp4/);
  const renderPath = path.join(dataDir, 'test-render.mp4');
  await fs.writeFile(renderPath, Buffer.from(await output.arrayBuffer()));
  await execFile(ffmpeg, ['-v', 'error', '-i', renderPath, '-f', 'null', '-'], { timeout: 30000 });
  const nativeSaved = path.join(dataDir, 'native-download.mp4');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native download timed out')), 15000);
    mainWindow.webContents.session.once('will-download', (_event, item) => {
      // Bypass only the human save prompt in this isolated automated test.
      item.setSavePath(nativeSaved);
      item.once('done', (_doneEvent, state) => { clearTimeout(timeout); state === 'completed' ? resolve() : reject(new Error('Native download: ' + state)); });
    });
    mainWindow.webContents.downloadURL(origin + result.download_url);
  });
  assert.equal((await fs.stat(nativeSaved)).size, (await fs.stat(renderPath)).size);
  const nativeSaveResult = await mainWindow.webContents.executeJavaScript(`window.desktopApp.saveOutput(${JSON.stringify(result.download_url)})`);
  assert.equal(nativeSaveResult.saved, true);
  assert.equal((await fs.stat(nativeSaveResult.path)).size, (await fs.stat(renderPath)).size);
  await mainWindow.webContents.executeJavaScript(`saveCompletedOutput(${JSON.stringify(result.download_url)},'manual-download','manual-log')`);
  assert.equal(await mainWindow.webContents.executeJavaScript('document.getElementById("manual-download-top").classList.contains("hidden")'), true);
  // The actual packaged log HTML/preload must open independently, without
  // editor mutation privileges or interpreting untrusted diagnostic text.
  await mainWindow.webContents.executeJavaScript(`desktopApp.appendLog({source:'manual',message:'Packaged log <img src=x onerror=alert(1)>',level:'info'});desktopApp.openLogs()`);
  const terminal = BrowserWindow.getAllWindows().find(window => window !== mainWindow && window.webContents.getURL().endsWith('/log-viewer.html'));
  assert.ok(terminal, 'Native terminal window did not open');
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await terminal.webContents.executeJavaScript(`document.getElementById('records').textContent.includes('Packaged log <img')`)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const terminalProof = await terminal.webContents.executeJavaScript(`({text:document.getElementById('records').textContent,node:typeof require,editor:typeof desktopApp,images:document.querySelectorAll('img').length})`);
  assert.match(terminalProof.text, /Packaged log <img src=x onerror=alert\(1\)>/);
  assert.equal(terminalProof.node, 'undefined'); assert.equal(terminalProof.editor, 'undefined'); assert.equal(terminalProof.images, 0);
  const terminalScreenshot = path.join(dataDir, 'terminal-window.png');
  await fs.writeFile(terminalScreenshot, (await terminal.webContents.capturePage()).toPNG());
  terminal.close();
  // Verify recovery works without relying on the temporary browser origin's storage.
  await mainWindow.webContents.executeJavaScript('localStorage.clear()');
  const loaded = new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
  mainWindow.webContents.reload();
  await loaded;
  await mainWindow.webContents.executeJavaScript('projectWorkspaceInitialization');
  assert.equal(await mainWindow.webContents.executeJavaScript('document.getElementById("project-name").value'), payload.name);
  await waitForVideo();
  const recoveredVideo = await mainWindow.webContents.executeJavaScript(`(async()=>{const v=document.getElementById('manual-video');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return{width:v.videoWidth,duration:v.duration,clips:S.clips.length,readyState:v.readyState,networkState:v.networkState,seeking:v.seeking,editorSeeking:S.seeking,paused:v.paused}})()`);
  assert.equal(recoveredVideo.width, 640); assert.equal(recoveredVideo.clips, 1);
  assert.ok(recoveredVideo.duration >= 1.9);
  assert.equal(await mainWindow.webContents.executeJavaScript('getComputedStyle(document.querySelector(".brush-stage-toolbar")).display'), 'none');
  const layouts = [];
  for (const [width, height] of [[1366, 740], [1920, 1020]]) {
    mainWindow.setContentSize(width, height);
    await mainWindow.webContents.executeJavaScript('new Promise(r=>setTimeout(r,180))');
    const layout = await mainWindow.webContents.executeJavaScript(`(()=>{const bounds=id=>{const r=document.getElementById(id).getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};return{width:innerWidth,height:innerHeight,pageHeight:document.documentElement.scrollHeight,pageWidth:document.documentElement.scrollWidth,preview:bounds('preview-shell'),stage:bounds('preview-stage'),timeline:bounds('timeline'),timelinePanel:bounds('timeline-panel')}})()`);
    assert.ok(layout.pageHeight <= height + 2, JSON.stringify(layout));
    assert.ok(layout.pageWidth <= width + 2, JSON.stringify(layout));
    assert.ok(layout.preview.height >= 219 && layout.timeline.height >= 199, JSON.stringify(layout));
    assert.ok(layout.timeline.bottom <= height && layout.preview.bottom <= layout.timelinePanel.top, JSON.stringify(layout));
    assert.ok(Math.abs(layout.stage.width / layout.stage.height - 16 / 9) < .01, JSON.stringify(layout));
    layouts.push(layout);
    await fs.writeFile(path.join(dataDir, `workspace-${width}.png`), (await mainWindow.webContents.capturePage()).toPNG());
  }
  // Reproduce a real timeline click after an input had keyboard focus, then B.
  await mainWindow.webContents.executeJavaScript('S.zoom=80;drawClips();document.getElementById("project-name").focus()');
  const clipPoint = await mainWindow.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#track .clip').getBoundingClientRect();return{x:Math.round(r.left+76),y:Math.round(r.top+r.height/2)}})()`);
  mainWindow.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...clipPoint });
  mainWindow.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...clipPoint });
  await mainWindow.webContents.executeJavaScript('new Promise(r=>setTimeout(r,100))');
  assert.equal(await mainWindow.webContents.executeJavaScript('document.activeElement.id'), 'timeline');
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B' });
  await mainWindow.webContents.executeJavaScript('new Promise(r=>setTimeout(r,100))');
  const split = await mainWindow.webContents.executeJavaScript('S.clips.map(c=>({start:c.start,end:c.end}))');
  assert.equal(split.length, 2, JSON.stringify(split));
  assert.ok(split[0].end > .6 && split[0].end < 1.3, JSON.stringify(split));
  // Imported image transforms must remain usable after the library entry is
  // removed and after recovery across a fresh browser origin.
  const imageFixture = path.join(dataDir, 'test-image.png');
  await execFile(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=magenta:s=128x64', '-frames:v', '1', imageFixture], { timeout: 30000 });
  const imageUpload = new FormData();imageUpload.set('file', new Blob([await fs.readFile(imageFixture)], { type: 'image/png' }), 'Görsel deneme.png');
  const imageResponse = await request('/upload', { method: 'POST', body: imageUpload });assert.equal(imageResponse.status, 200);
  const imageMedia = await imageResponse.json();
  const imageBefore = await mainWindow.webContents.executeJavaScript(`(()=>{
    const asset={id:'smoke-image-asset',fileId:${JSON.stringify(imageMedia.file_id)},name:'Görsel deneme.png',kind:'image',src:'/video/'+${JSON.stringify(imageMedia.file_id)}};
    S.mediaAssets.push(asset);S.imageLayers.push(hydrateImageLayer({id:'smoke-image',assetId:asset.id,fileId:asset.fileId,src:asset.src,name:asset.name,start:.1,end:1.8,x:20,y:70,scale:20,opacity:100,animation:'fadein',animationDuration:.2,effect:'vivid',effectIntensity:45,filter:'daylight',filterIntensity:15,transformKeyframes:[{id:'IF-smoke-1',time:0,scale:80,x:20,y:70,opacity:100,easing:'linear'},{id:'IF-smoke-2',time:1.2,scale:120,x:70,y:40,opacity:80,easing:'linear'}]}));
    removeProjectAsset(asset.id,false);drawClips();
    return {item:S.imageLayers[0],library:S.mediaAssets.map(item=>item.id)};
  })()`);
  assert.equal(imageBefore.library.includes('smoke-image-asset'), false);assert.equal(imageBefore.item.transformKeyframes.length, 2);
  // A transition must survive unrelated adjustments and a real disk recovery,
  // even with all origin-local browser data removed (as during an upgrade).
  const transitionBefore = await mainWindow.webContents.executeJavaScript(`(async()=>{
    applyTransition('fade',0);S.clips[0].brightness=125;clampClipTransitions();drawClips();
    await persistProjectRecovery();
    return {pair:{...S.transitions[0]},exported:exportableTransitions(),project:projectPayload()};
  })()`);
  assert.equal(transitionBefore.exported.length, 1);
  assert.equal(transitionBefore.pair.type, 'fade');
  assert.ok(transitionBefore.pair.leftClipId && transitionBefore.pair.rightClipId);
  const projectWithTransition = { ...transitionBefore.project, id: saved.id };
  assert.equal((await request('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(projectWithTransition) })).status, 200);
  const persistedProject = await (await request('/projects/' + saved.id)).json();
  assert.deepEqual(persistedProject.timelines[0].state.transitions, transitionBefore.project.timelines[0].state.transitions);
  await mainWindow.webContents.executeJavaScript('localStorage.clear()');
  const transitionLoaded = new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
  mainWindow.webContents.reload();await transitionLoaded;
  await mainWindow.webContents.executeJavaScript('projectWorkspaceInitialization');await waitForVideo();
  const transitionAfter = await mainWindow.webContents.executeJavaScript('({pair:S.transitions[0],exported:exportableTransitions(),clips:S.clips.length,brightness:S.clips[0].brightness})');
  assert.equal(transitionAfter.clips, 2);assert.equal(transitionAfter.brightness, 125);
  assert.equal(transitionAfter.pair.leftClipId, transitionBefore.pair.leftClipId);
  assert.equal(transitionAfter.pair.rightClipId, transitionBefore.pair.rightClipId);
  assert.deepEqual(transitionAfter.exported, transitionBefore.exported);
  const imageAfter = await mainWindow.webContents.executeJavaScript(`({item:S.imageLayers[0],exported:manualExportData().images[0],library:S.mediaAssets.map(item=>item.id),middle:imageTransformAtTime(S.imageLayers[0],.7)})`);
  assert.deepEqual(imageAfter.item.transformKeyframes, imageBefore.item.transformKeyframes);
  assert.equal(imageAfter.library.includes('smoke-image-asset'), false);
  assert.equal(imageAfter.exported.effect, 'vivid');assert.equal(imageAfter.exported.filter, 'daylight');assert.equal(imageAfter.exported.animation, 'fadein');
  assert.ok(Math.abs(imageAfter.middle.x - 45) < .01);assert.ok(Math.abs(imageAfter.middle.opacity - 90) < .01);
  assert.equal((await request('/video/' + imageMedia.file_id)).status, 200);
  assert.deepEqual(persistedProject.timelines[0].state.imageLayers[0].transformKeyframes, imageAfter.item.transformKeyframes);
  const imageRendered = await mainWindow.webContents.executeJavaScript(`(async()=>{
    const data=manualExportData();data.resolution={width:640,height:360};data.options.hardware='cpu';
    const response=await fetch('/start-render',{method:'POST',body:buildRenderForm(data)});if(!response.ok)throw new Error(await response.text());
    return await events((await response.json()).job_id,()=>{});
  })()`);
  assert.ok(imageRendered.download_url, JSON.stringify(imageRendered));
  const imageRenderPath = path.join(dataDir, 'test-image-render.mp4');
  await fs.writeFile(imageRenderPath, Buffer.from(await (await request(imageRendered.download_url)).arrayBuffer()));
  await execFile(ffmpeg, ['-v', 'error', '-i', imageRenderPath, '-f', 'null', '-'], { timeout: 30000 });
  const beforeSnapshots = new Set(await fs.readdir(path.join(dataDir, 'outputs')));
  await mainWindow.webContents.executeJavaScript(`seekOutputTime(.6);openSnapshotModal();document.getElementById('snapshot-quality').value='1280';updateSnapshotSize();startSnapshot()`);
  const captures = (await fs.readdir(path.join(dataDir, 'outputs'))).filter(name => name.endsWith('.png') && !beforeSnapshots.has(name));
  assert.equal(captures.length, 1, await mainWindow.webContents.executeJavaScript('document.getElementById("manual-log").textContent'));
  const capture = await fs.readFile(path.join(dataDir, 'outputs', captures[0]));
  assert.equal(capture.subarray(1, 4).toString(), 'PNG');
  assert.equal(capture.readUInt32BE(16), 1280); assert.equal(capture.readUInt32BE(20), 720);
  assert.ok((await fs.stat(path.join(dataDir, 'saved-' + captures[0]))).isFile());
  // Validate new parallel/crop/clipboard modules inside the actual packaged
  // application, using real uploads and disk recovery, not a substitute page.
  for (const assetPath of ['/static/video_tracks.js','/static/video_tracks.css','/static/timeline_tools.js','/static/timeline_tools.css']) {
    const response=await request(assetPath);assert.equal(response.status,200,assetPath);assert.ok((await response.text()).length>100,assetPath);
  }
  const multitrackAssets=[];
  for (const [name,color,frequency] of [['parallel-red','red',880],['parallel-blue','blue',1320]]) {
    const file=path.join(dataDir,name+'.mp4');
    await execFile(ffmpeg,['-v','error','-y','-f','lavfi','-i',`color=c=${color}:s=640x360:r=30:d=2`,'-f','lavfi','-i',`sine=frequency=${frequency}:duration=2`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',file],{timeout:60000});
    const body=new FormData();body.set('file',new Blob([await fs.readFile(file)],{type:'video/mp4'}),name+'.mp4');const response=await request('/upload',{method:'POST',body});assert.equal(response.status,200);multitrackAssets.push(await response.json());
  }
  const parallelBefore=await mainWindow.webContents.executeJavaScript(`(async()=>{
    const originalTimeline=S.activeTimelineId;createTimeline();const parallelTimeline=S.activeTimelineId;S.timelines.find(item=>item.id===parallelTimeline).name='Üç video kanalı';S.timelineMagnet=false;drawMagnetButton();
    const source=S.mediaAssets.find(item=>item.fileId===${JSON.stringify(media.file_id)});addProjectAssetAt(source,0);
    for(const [index,uploaded] of ${JSON.stringify(multitrackAssets)}.entries()){const asset={id:'parallel-asset-'+index,fileId:uploaded.file_id,name:uploaded.name,kind:'video',duration:uploaded.duration,src:'/video/'+uploaded.file_id};S.mediaAssets.push(asset);addVideoTrack();addProjectAssetAt(asset,(index+1)*.2)}
    const second=S.clips.find(item=>item.videoTrack===2),third=S.clips.find(item=>item.videoTrack===3);second.scale=55;second.x=30;second.y=50;third.scale=35;third.x=78;third.y=35;third.opacity=85;S.selected=S.preview=S.clips.indexOf(second);S.activeVideoTrack=2;S.selectedText=null;S.selectedSticker=null;S.selectedLayer=null;drawClips();seekOutputTime(.9);
    if(!await openTimelineCropDialog())throw new Error('Packaged crop dialog could not load its source');el('timeline-crop-preset').value='9:16';el('timeline-crop-preset').dispatchEvent(new Event('change',{bubbles:true}));const crop=applyTimelineCrop();if(!crop)throw new Error('Packaged crop could not be applied');
    const sourceClipId=second.clipId;if(!timelineCopySelection())throw new Error('Packaged timeline copy failed');createTimeline();const copyTimeline=S.activeTimelineId;S.timelines.find(item=>item.id===copyTimeline).name='Kopyalanmış kısa video';addProjectAssetAt(source,0);seekOutputTime(.35);const pasted=timelinePasteClipboard();if(!pasted)throw new Error('Cross-timeline paste failed');
    switchTimeline(parallelTimeline);seekOutputTime(.9);S.projectId=${JSON.stringify(saved.id)};await saveNamedProject();await persistProjectRecovery();
    return{originalTimeline,parallelTimeline,copyTimeline,sourceClipId,pasted:JSON.parse(JSON.stringify(pasted)),crop,project:JSON.parse(JSON.stringify(projectPayload()))};
  })()`);
  const parallelState=parallelBefore.project.timelines.find(item=>item.id===parallelBefore.parallelTimeline).state;
  assert.equal(parallelState.videoTracks.length,3);assert.equal(new Set(parallelState.clips.map(clip=>clip.fileId)).size,3);
  const croppedClip=parallelState.clips.find(clip=>clip.clipId===parallelBefore.sourceClipId);assert.ok(croppedClip.crop.width>0&&croppedClip.crop.width<1);
  assert.ok(Math.abs(croppedClip.crop.width*640/(croppedClip.crop.height*360)-9/16)<.015);
  assert.notEqual(parallelBefore.pasted.clipId,parallelBefore.sourceClipId);assert.deepEqual(parallelBefore.pasted.crop,croppedClip.crop);assert.ok(Math.abs(parallelBefore.pasted.timelineStart-.35)<.001);
  const savedParallel=await (await request('/projects/'+saved.id)).json();assert.deepEqual(savedParallel.timelines.find(item=>item.id===parallelBefore.parallelTimeline).state.clips,parallelState.clips);
  await mainWindow.webContents.executeJavaScript('localStorage.clear()');const parallelReloaded=new Promise(resolve=>mainWindow.webContents.once('did-finish-load',resolve));mainWindow.webContents.reload();await parallelReloaded;await mainWindow.webContents.executeJavaScript('projectWorkspaceInitialization');
  const parallelAfter=await mainWindow.webContents.executeJavaScript(`(async()=>{
    seekOutputTime(.9);const deadline=performance.now()+10000;while(performance.now()<deadline){const nodes=[...document.querySelectorAll('#video-composite .composite-layer')];if(nodes.length===3&&nodes.every(node=>{const v=node.querySelector('video'),c=node.querySelector('canvas');return!node.hidden&&v.readyState>=2&&!v.seeking&&c.width>0&&c.height>0}))break;await new Promise(resolve=>setTimeout(resolve,25))}
    return{activeTimeline:S.activeTimelineId,tracks:S.videoTracks.map(item=>({...item})),clips:JSON.parse(JSON.stringify(S.clips)),layers:[...document.querySelectorAll('#video-composite .composite-layer')].map(node=>{const v=node.querySelector('video'),c=node.querySelector('canvas');return{clipId:node.dataset.clipId,track:+node.parentElement.dataset.videoTrack,visible:!node.hidden,readyState:v.readyState,seeking:v.seeking,time:v.currentTime,source:v.currentSrc,width:v.videoWidth,height:v.videoHeight,canvasWidth:c.width,canvasHeight:c.height}}),project:JSON.parse(JSON.stringify(projectPayload()))};
  })()`);
  assert.equal(parallelAfter.activeTimeline,parallelBefore.parallelTimeline);assert.deepEqual(parallelAfter.clips,parallelState.clips);assert.equal(parallelAfter.layers.length,3);
  assert.ok(parallelAfter.layers.every(layer=>layer.visible&&layer.readyState>=2&&!layer.seeking&&layer.width===640&&layer.canvasWidth>0));
  assert.deepEqual(parallelAfter.layers.map(layer=>layer.track).sort((a,b)=>a-b),[1,2,3]);
  for(const layer of parallelAfter.layers){const clip=parallelAfter.clips.find(item=>item.clipId===layer.clipId);assert.ok(Math.abs(layer.time-(.9-clip.timelineStart+clip.start))<.04,JSON.stringify(layer))}
  const copyState=parallelAfter.project.timelines.find(item=>item.id===parallelBefore.copyTimeline).state;
  assert.deepEqual(copyState.clips.find(clip=>clip.clipId===parallelBefore.pasted.clipId).crop,croppedClip.crop);
  const parallelForm=await mainWindow.webContents.executeJavaScript(`(()=>{const data=manualExportData();data.resolution={width:640,height:360};data.options.hardware='cpu';return Object.fromEntries(buildRenderForm(data).entries())})()`);
  const parallelSegments=JSON.parse(parallelForm.segments);assert.deepEqual(parallelSegments.map(clip=>clip.videoTrack).sort((a,b)=>a-b),[1,2,3]);assert.deepEqual(parallelSegments.find(clip=>clip.clipId===croppedClip.clipId)?.crop,croppedClip.crop);
  const parallelRender=await mainWindow.webContents.executeJavaScript(`(async()=>{const data=manualExportData();data.resolution={width:640,height:360};data.options.hardware='cpu';const response=await fetch('/start-render',{method:'POST',body:buildRenderForm(data)});if(!response.ok)throw new Error(await response.text());return await events((await response.json()).job_id,()=>{})})()`);
  assert.ok(parallelRender.download_url,JSON.stringify(parallelRender));const parallelRenderPath=path.join(dataDir,'test-parallel-render.mp4');await fs.writeFile(parallelRenderPath,Buffer.from(await(await request(parallelRender.download_url)).arrayBuffer()));await execFile(ffmpeg,['-v','error','-i',parallelRenderPath,'-f','null','-'],{timeout:30000});
  const parallelNativeSave=await mainWindow.webContents.executeJavaScript(`window.desktopApp.saveOutput(${JSON.stringify(parallelRender.download_url)})`);assert.equal(parallelNativeSave.saved,true);assert.equal((await fs.stat(parallelNativeSave.path)).size,(await fs.stat(parallelRenderPath)).size);
  const previousPngs=new Set(await fs.readdir(path.join(dataDir,'outputs')));await mainWindow.webContents.executeJavaScript(`seekOutputTime(.9);openSnapshotModal();el('snapshot-quality').value='1280';updateSnapshotSize();startSnapshot()`);
  const parallelPngs=(await fs.readdir(path.join(dataDir,'outputs'))).filter(name=>name.endsWith('.png')&&!previousPngs.has(name));assert.equal(parallelPngs.length,1);const parallelPng=await fs.readFile(path.join(dataDir,'outputs',parallelPngs[0]));assert.equal(parallelPng.subarray(1,4).toString(),'PNG');assert.equal(parallelPng.readUInt32BE(16),1280);assert.equal(parallelPng.readUInt32BE(20),720);assert.ok((await fs.stat(path.join(dataDir,'saved-'+parallelPngs[0]))).isFile());
  const frameRgb=async(file,time)=>{const args=['-v','error',...(time===null?[]:['-ss',String(time)]),'-i',file,'-vf','scale=640:360','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'];const {stdout}=await execFile(ffmpeg,args,{encoding:'buffer',maxBuffer:4*1024*1024,timeout:30000});assert.equal(stdout.length,640*360*3);return stdout};
  const [parallelFrame,parallelSnapshot,originalFrame]=await Promise.all([frameRgb(parallelRenderPath,.9),frameRgb(path.join(dataDir,'outputs',parallelPngs[0]),null),frameRgb(fixture,.9)]);
  const pixel=(buffer,x,y)=>[...buffer.subarray((y*640+x)*3,(y*640+x)*3+3)],sampleFrame=buffer=>({base:pixel(buffer,32,324),red:pixel(buffer,192,180),blue:pixel(buffer,499,126)}),parallelPixels={render:sampleFrame(parallelFrame),snapshot:sampleFrame(parallelSnapshot),originalBase:pixel(originalFrame,32,324)};
  for(const sampled of [parallelPixels.render,parallelPixels.snapshot]){assert.ok(sampled.red[0]>180&&sampled.red[1]<70&&sampled.red[2]<70,JSON.stringify(parallelPixels));assert.ok(sampled.blue[2]>150&&sampled.blue[2]>2*Math.max(sampled.blue[0],sampled.blue[1]),JSON.stringify(parallelPixels));assert.ok(sampled.base.every((value,index)=>Math.abs(value-parallelPixels.originalBase[index])<15),JSON.stringify(parallelPixels))}
  const parallelScreenshot=path.join(dataDir,'desktop-parallel.png');await fs.writeFile(parallelScreenshot,(await mainWindow.webContents.capturePage()).toPNG());
  await mainWindow.webContents.executeJavaScript(`switchTimeline(${JSON.stringify(parallelBefore.originalTimeline)});persistProjectRecovery()`);await waitForVideo();
  const multitrackProof={timeline:parallelBefore.parallelTimeline,copyTimeline:parallelBefore.copyTimeline,tracks:parallelAfter.tracks,layers:parallelAfter.layers,crop:croppedClip.crop,copiedClipId:parallelBefore.pasted.clipId,copiedTimelineStart:parallelBefore.pasted.timelineStart,renderPath:parallelRenderPath,nativeSave:parallelNativeSave,snapshot:parallelPngs[0],pixels:parallelPixels,screenshot:parallelScreenshot};
  const screenshot = path.join(dataDir, 'desktop-smoke.png');
  await fs.writeFile(screenshot, (await mainWindow.webContents.capturePage()).toPNG());
  // Exercise the real isolated preload and update save handshake, never the installer/network.
  const updaterState = await mainWindow.webContents.executeJavaScript('window.desktopApp.getUpdateState()');
  assert.equal(updaterState.mode, 'disabled');
  const updateAvailable = { mode: 'automatic', status: 'available', currentVersion: health.version, version: '9.9.9', manualCheck: true };
  mainWindow.webContents.send('desktop:update-state', updateAvailable);
  const updatePopup = await mainWindow.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({open:el('desktop-update-dialog').open,title:el('desktop-update-heading').textContent,action:el('desktop-update-primary').textContent,consent:el('desktop-update-message').textContent}))))`);
  assert.equal(updatePopup.open, true);assert.equal(updatePopup.action, 'İndir ve güncelle');assert.match(updatePopup.consent, /yeniden açılır/);
  const updateScreenshot = path.join(dataDir, 'desktop-update-popup.png');
  await fs.writeFile(updateScreenshot, (await mainWindow.webContents.capturePage()).toPNG());
  await mainWindow.webContents.executeJavaScript("el('desktop-update-later').click()");
  const attempt = 9000001;
  const updateReady = await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout);ipcMain.removeListener('desktop:ready-for-update', received); };
    const received = (event, returnedAttempt, error, busy) => {
      if (event.sender !== mainWindow.webContents || returnedAttempt !== attempt) return;
      cleanup();resolve({ attempt: returnedAttempt, error, busy });
    };
    const timeout = setTimeout(() => { cleanup();reject(new Error('Update recovery handshake timed out')); }, 15000);
    ipcMain.on('desktop:ready-for-update', received);
    mainWindow.webContents.send('desktop:prepare-update', attempt);
  });
  assert.equal(updateReady.error, undefined);assert.equal(updateReady.busy, false);
  const frozenUpdate = await mainWindow.webContents.executeJavaScript(`({frozen:desktopUpdateFrozen,modal:el('desktop-update-dialog').open,inert:document.querySelector('main').inert,paused:mv.paused})`);
  assert.deepEqual(frozenUpdate, { frozen: true, modal: true, inert: true, paused: true });
  const updateRecovery = JSON.parse(await fs.readFile(path.join(dataDir, 'recovery.json'), 'utf8'));
  assert.equal(updateRecovery.name, payload.name);assert.equal(updateRecovery.timelines[0].state.clips.length, 2);
  assert.deepEqual(updateRecovery.timelines[0].state.imageLayers[0].transformKeyframes, imageBefore.item.transformKeyframes);
  const recoveredParallel=updateRecovery.timelines.find(item=>item.id===parallelBefore.parallelTimeline).state,recoveredCopy=updateRecovery.timelines.find(item=>item.id===parallelBefore.copyTimeline).state;
  assert.equal(recoveredParallel.videoTracks.length,3);assert.deepEqual(recoveredParallel.clips.find(clip=>clip.clipId===parallelBefore.sourceClipId).crop,croppedClip.crop);assert.deepEqual(recoveredCopy.clips.find(clip=>clip.clipId===parallelBefore.pasted.clipId).crop,croppedClip.crop);
  mainWindow.webContents.send('desktop:update-cancelled', attempt);
  const updateCancelled = await mainWindow.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>resolve({frozen:desktopUpdateFrozen,inert:document.querySelector('main').inert,modal:el('desktop-update-dialog').open})))`);
  assert.deepEqual(updateCancelled, { frozen: false, inert: false, modal: false });
  mainWindow.webContents.send('desktop:update-state', updaterState);
  assert.equal((await request('/api/apply-update', { method: 'POST' })).status, 409);
  assert.deepEqual(errors, []);
  return { ok: true, packaged: app.isPackaged, health, ui, storage, played, recoveredVideo, layouts, split, transitionRecovery: transitionAfter, imageRecovery: imageAfter, imageRenderPath, multitrackProof, snapshot: captures[0], savedProject: saved.id, screenshot, terminal: { isolated: terminalProof.editor === 'undefined' && terminalProof.node === 'undefined', screenshot: terminalScreenshot }, renderPath, nativeSaved, nativeSaveResult, updaterState, updatePopup, updateScreenshot, frozenUpdate, updateCancelled, errors };
};
