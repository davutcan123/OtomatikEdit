// Disposable, visible Electron selection regression. Never reads user projects or clipboard.
const {app, BrowserWindow, Menu} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'otomatik-timeline-selection-'));
app.setPath('userData', path.join(artifacts, 'profile'));
const proof = {}, errors = [], media = new Map(), savedProjects = new Map();
// Leave room for the host menu bar/taskbar; selection assertions use measured geometry.
const viewport = {width:1366, height:740};
const j = JSON.stringify, modifier = process.platform === 'darwin' ? 'meta' : 'control';
let window, server;
const evaluate = code => window.webContents.executeJavaScript(code);
const frames = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const screenshot = async name => fs.promises.writeFile(path.join(artifacts, name + '.png'), (await window.webContents.capturePage()).toPNG());
const snapshot = () => evaluate('JSON.parse(JSON.stringify(S.clips))');
const selected = () => evaluate('[...(S.selectedVideoClipIds||[])].sort()');

async function inputKey(key, modifiers = []) {
  for (const type of ['keyDown', 'keyUp']) window.webContents.sendInputEvent({type, keyCode:key, modifiers});
  await frames();
}
const shortcut = key => inputKey(key, [modifier]);
async function timelineFocus() { await evaluate('el("timeline").focus({preventScroll:true})'); }

async function pointFor(selector) {
  await evaluate(`(()=>{const node=document.querySelector(${j(selector)});if(!node)throw new Error('Missing control '+${j(selector)});node.scrollIntoView({block:'nearest',inline:'nearest'})})()`);
  await frames();
  const point = await evaluate(`(()=>{const node=document.querySelector(${j(selector)}),r=node.getBoundingClientRect(),clip=node.matches('#track .clip'),candidates=clip?[[.61,.28],[.35,.28],[.78,.72],[.25,.72]]:[[.61,.52]];let point;for(const [rx,ry]of candidates){const x=Math.round(r.left+r.width*rx),y=Math.round(r.top+r.height*ry),hit=document.elementFromPoint(x,y),reachable=node.contains(hit)&&(!clip||!hit.closest('.trim-handle,.zoom-keyframe-marker'));point={x,y,width:r.width,height:r.height,reachable,hit:hit?.className,viewport:[innerWidth,innerHeight]};if(reachable)return point}return point})()`);
  assert.ok(point.reachable, 'Reachable native pointer target ' + selector + ' ' + j(point));
  return point;
}
function sendPointer(type, point, modifiers = []) {
  window.webContents.sendInputEvent({type, button:'left', clickCount:1, x:Math.round(point.x), y:Math.round(point.y), modifiers});
}
async function click(selector, modifiers = []) {
  const point = await pointFor(selector);
  sendPointer('mouseDown', point, modifiers);sendPointer('mouseUp', point, modifiers);
  await frames();(proof.clicks ||= []).push({selector,modifiers,point,selected:await selected()});return point;
}
async function clipSelector(id) {
  const index = await evaluate(`S.clips.findIndex(c=>c.clipId===${j(id)})`);
  assert.ok(index >= 0, 'Clip exists ' + id);
  return '#track .clip[data-index="' + index + '"]';
}
async function clickClip(id, additive = false) { return click(await clipSelector(id), additive ? [modifier] : []); }
async function dragClip(id, seconds) {
  const point = await pointFor(await clipSelector(id));
  const zoom = await evaluate('S.zoom'), target = {x:point.x + seconds * zoom, y:point.y};
  assert.ok(target.x > 0 && target.x < point.viewport[0], 'Drag endpoint remains in the actual viewport');
  sendPointer('mouseDown', point);sendPointer('mouseMove', {x:point.x + 9, y:point.y});await frames();
  sendPointer('mouseMove', target);await frames();sendPointer('mouseUp', target);await frames();
  return {from:point, to:target, selected:await selected(), clips:await snapshot()};
}
async function assertSelection(ids, label) {
  assert.deepEqual(await selected(), [...ids].sort(), label);
  const painted = await evaluate(`[...document.querySelectorAll('#track .clip.selected')].map(node=>S.clips[+node.dataset.index]?.clipId).sort()`);
  assert.deepEqual(painted, [...ids].sort(), label + ' must be visually painted on every selected clip');
}
async function setup() {
  await evaluate(`restoreProject({name:'Selection regression',mediaAssets:[{id:'source',fileId:'source.mp4',name:'Selection source',kind:'video',duration:20}],activeTimelineId:'TL1',nextTimelineId:3,timelines:[{id:'TL1',name:'Main edit',state:{...emptyTimelineState(),manualId:'source.mp4',manualName:'Selection source',duration:20,selected:0,preview:0,videoTracks:[1,2].map(id=>({id,name:'Video '+id,locked:false,visible:true,muted:false})),activeVideoTrack:1,clips:[{clipId:'A',name:'Alpha',fileId:'source.mp4',sourceDuration:20,start:0,end:2,timelineStart:0,videoTrack:1,crop:{x:.1,y:.1,width:.8,height:.8},zoomKeyframes:[{id:'A-frame-1',time:0,scale:100,x:40,y:50,opacity:100,easing:'linear'},{id:'A-frame-2',time:1,scale:150,x:60,y:50,opacity:80,easing:'linear'}]},{clipId:'B',name:'Bravo',fileId:'source.mp4',sourceDuration:20,start:3,end:5,timelineStart:3,videoTrack:1},{clipId:'C',name:'Charlie',fileId:'source.mp4',sourceDuration:20,start:6,end:8,timelineStart:1,videoTrack:2,scale:60},{clipId:'D',name:'Delta',fileId:'source.mp4',sourceDuration:20,start:8,end:10,timelineStart:6,videoTrack:2}],canvas:{width:1920,height:1080},zoom:45,timelineMagnet:false}},{id:'TL2',name:'Shorts',state:{...emptyTimelineState(),manualId:'source.mp4',manualName:'Selection source',duration:20,selected:0,preview:0,clips:[{clipId:'E',name:'Existing short',fileId:'source.mp4',sourceDuration:20,start:0,end:1,timelineStart:9,videoTrack:1}],videoTracks:[1,2].map(id=>({id,name:'Video '+id,locked:false,visible:true,muted:false})),activeVideoTrack:1,zoom:45,timelineMagnet:false}}]});pausePreview();S.timelineMagnet=false;S.timelineRipple=false;drawClips();el('timeline').scrollLeft=0;el('timeline').focus()`);
  await evaluate(`new Promise((resolve,reject)=>{const start=performance.now(),poll=()=>{const videos=window.multiTrackPreview?.enabled()?[...document.querySelectorAll('.composite-layer:not([hidden]) video')]:[mv];if(videos.length&&videos.every(v=>v.readyState>=2&&!v.seeking))return resolve();if(performance.now()-start>15000)return reject(new Error('Initial video readiness '+JSON.stringify(videos.map(v=>({ready:v.readyState,seeking:v.seeking,source:v.currentSrc})))));setTimeout(poll,20)};poll()})`);
  await frames();
}

async function checkSelectionAndScope() {
  await setup();await clickClip('A');await assertSelection(['A'], 'Plain click selects a single clip');
  const cursor = await evaluate('currentOutputTime()');
  await clickClip('C', true);await assertSelection(['A','C'], 'Modifier click adds another channel');
  assert.ok(Math.abs(await evaluate('currentOutputTime()') - cursor) < .001, 'Additive selection cannot seek the playhead');
  await clickClip('A', true);await assertSelection(['C'], 'Modifier click removes an existing member');
  await clickClip('C', true);await assertSelection([], 'Removing the last member clears selection');
  assert.equal(await evaluate('S.selected'), -1);
  await clickClip('A');await clickClip('C', true);await clickClip('B');await assertSelection(['B'], 'Plain click collapses a group');
  await evaluate('videoTrackState(2).locked=true;videoTrackState(2).visible=false;drawClips()');await timelineFocus();await shortcut('A');
  await assertSelection(['A','B','C','D'], 'Select all includes visually locked/hidden clips in the active timeline only');
  await screenshot('all-video-clips-selected');
  assert.equal(await evaluate('S.timelines.find(t=>t.id==="TL2").state.clips.length'), 1);
  await clickClip('B');await click('#project-name');
  const field = await evaluate('el("project-name").value');
  await evaluate(`window.selectionInputKey=null;window.addEventListener('keydown',event=>setTimeout(()=>window.selectionInputKey={key:event.key,target:event.target.id,prevented:event.defaultPrevented},0),{capture:true,once:true})`);
  await shortcut('A');
  await assertSelection(['B'], 'Text input select-all must not change the timeline selection');
  const releasedKey=await evaluate('window.selectionInputKey');assert.equal(releasedKey.target,'project-name');assert.equal(releasedKey.key.toLowerCase(),'a');assert.equal(releasedKey.prevented,false,'Timeline handlers must release native input shortcuts');
  // sendInputEvent dispatches DOM keys but does not invoke Cocoa menu accelerators.
  // Use the same native editing command as the production selectAll menu role.
  window.webContents.selectAll();await frames();
  assert.deepEqual(await evaluate('({start:el("project-name").selectionStart,end:el("project-name").selectionEnd})'), {start:0,end:field.length});
  await clickClip('B');await evaluate('openTimelineCropDialog()');
  assert.equal(await evaluate('el("timeline-crop-dialog").open'),true);
  const dialogBefore=await snapshot();await evaluate('el("timeline-crop-cancel").focus()');await shortcut('A');await inputKey('Delete');
  await assertSelection(['B'],'An open modal blocks timeline selection shortcuts');assert.deepEqual(await snapshot(),dialogBefore,'An open modal blocks timeline deletion');
  await click('#timeline-crop-cancel');
  await timelineFocus();await shortcut('A');await evaluate('switchTimeline("TL2")');await frames();
  assert.ok((await selected()).length <= 1);assert.ok((await selected()).every(id => id === 'E'), 'Timeline switch clears foreign selection IDs');
  await timelineFocus();await shortcut('A');await assertSelection(['E'], 'Select-all targets the newly active timeline');
  await evaluate('switchTimeline("TL1")');await frames();assert.ok((await selected()).length <= 1, 'Switching back does not restore a stale group');
  proof.selection = {inputLength:field.length, releasedKey, nativeInputSelectAll:true, activeTimelineOnly:true, modifierDoesNotSeek:true, switchResets:true, modalGuard:true};
}

async function checkDeleteAndLocks() {
  await setup();await clickClip('A');await clickClip('C', true);
  const original = await snapshot();
  await evaluate('videoTrackState(2).locked=true;drawClips()');await timelineFocus();
  const history = await evaluate('S.history.length');await inputKey('Delete');
  assert.deepEqual(await snapshot(), original, 'A locked group member rejects the entire delete');
  assert.equal(await evaluate('S.history.length'), history, 'Rejected delete creates no undo entry');
  await evaluate('videoTrackState(2).locked=false;drawClips()');await timelineFocus();await inputKey('Delete');
  assert.deepEqual((await snapshot()).map(c=>c.clipId).sort(), ['B','D']);
  assert.equal(await evaluate('S.history.length'), history + 1, 'Group deletion uses one history entry');
  await shortcut('Z');assert.deepEqual(await snapshot(), original, 'One undo restores the entire group');
  proof.deletion = {removed:['A','C'], preserved:['B','D'], lockedGroupRejected:true, singleUndo:true};
}

async function checkCopyAcrossTimelines() {
  await setup();await clickClip('A');await clickClip('C', true);
  const original = await snapshot();
  await evaluate('videoTrackState(2).locked=true;drawClips()');await timelineFocus();await shortcut('C');
  assert.equal(await evaluate('timelineClipboard.type'), 'video-group', 'Copying a visually selected locked member is read-only and allowed');
  await evaluate('switchTimeline("TL2");S.activeVideoTrack=1;seekOutputTime(4);pausePreview();videoTrackState(2).locked=true;drawClips();el("timeline").focus()');await frames();
  const before = await snapshot(), history = await evaluate('S.history.length');
  await shortcut('V');assert.deepEqual(await snapshot(), before, 'A locked mapped destination rejects all group paste members');assert.equal(await evaluate('S.history.length'), history);
  await evaluate('videoTrackState(2).locked=false;drawClips();el("timeline").focus()');await shortcut('V');
  const pasted = (await snapshot()).filter(c=>c.clipId !== 'E'), alpha = pasted.find(c=>c.name==='Alpha'), charlie = pasted.find(c=>c.name==='Charlie');
  assert.equal(pasted.length,2);assert.ok(alpha&&charlie);assert.notEqual(alpha.clipId,'A');assert.notEqual(charlie.clipId,'C');
  assert.equal(alpha.timelineStart,4);assert.equal(charlie.timelineStart,5);assert.equal(alpha.videoTrack,1);assert.equal(charlie.videoTrack,2);
  assert.deepEqual(alpha.crop, original.find(c=>c.clipId==='A').crop);assert.equal(alpha.zoomKeyframes.length,2);assert.notEqual(alpha.zoomKeyframes[0].id,'A-frame-1');
  assert.deepEqual([alpha.start,alpha.end,charlie.start,charlie.end],[0,2,6,8]);
  assert.equal(await evaluate('S.history.length'),history+1);await assertSelection(pasted.map(c=>c.clipId),'Pasted group stays selected');
  await timelineFocus();await shortcut('Z');assert.deepEqual(await snapshot(),before,'One undo removes the complete pasted group');
  await evaluate('S.activeVideoTrack=1;seekOutputTime(4);el("timeline").focus()');await shortcut('V');const repasted=await snapshot(),repastedAlpha=repasted.find(c=>c.name==='Alpha');
  assert.ok(repastedAlpha);await evaluate(`S.clips.find(c=>c.clipId===${j(repastedAlpha.clipId)}).zoomKeyframes[0].scale=222`);
  await evaluate('switchTimeline("TL1")');assert.deepEqual(await snapshot(),original,'Pasted keyframes are independent of source clips');
  proof.copy = {pasted:pasted.map(c=>({id:c.clipId,name:c.name,time:c.timelineStart,track:c.videoTrack})), sourceUnchanged:true, lockedDestinationRejected:true, freshKeyframes:true, singleUndo:true};
}

async function checkGroupMovement() {
  await setup();await clickClip('A');await clickClip('C',true);
  const original=await snapshot(), history=await evaluate('S.history.length');
  const moved=await dragClip('A',8), byId=new Map(moved.clips.map(c=>[c.clipId,c]));
  assert.ok(Math.abs(byId.get('A').timelineStart-8)<.03);assert.ok(Math.abs(byId.get('C').timelineStart-9)<.03);
  for(const id of ['A','C']){const before=original.find(c=>c.clipId===id),after=byId.get(id);assert.deepEqual([after.start,after.end,after.videoTrack],[before.start,before.end,before.videoTrack]);}
  for(const id of ['B','D'])assert.deepEqual(byId.get(id),original.find(c=>c.clipId===id),'Unselected clip stays unchanged');
  await assertSelection(['A','C'],'A native group drag preserves all selected members');assert.equal(await evaluate('S.history.length'),history+1);
  await timelineFocus();await shortcut('Z');assert.deepEqual(await snapshot(),original,'One undo restores both moved clips');
  await clickClip('A');await clickClip('C',true);await evaluate('videoTrackState(2).locked=true;drawClips()');
  const lockedHistory=await evaluate('S.history.length');await dragClip('A',8);assert.deepEqual(await snapshot(),original,'A locked group member rejects the entire move');assert.equal(await evaluate('S.history.length'),lockedHistory);
  proof.movement={delta:8,moved:moved.clips.map(c=>({id:c.clipId,time:c.timelineStart,track:c.videoTrack})),lockedGroupRejected:true,singleUndo:true};
}

async function checkCopiedTransition() {
  await setup();
  await evaluate(`S.clips.find(c=>c.clipId==='B').timelineStart=2;S.transitions=[{leftClipId:'A',rightClipId:'B',boundary:0,type:'fade',duration:.2,requestedDuration:.2}];clampClipTransitions();drawClips()`);
  await clickClip('A');await clickClip('B',true);await timelineFocus();await shortcut('C');
  await evaluate('switchTimeline("TL2");seekOutputTime(4);pausePreview();S.activeVideoTrack=1;el("timeline").focus()');await frames();await shortcut('V');
  const copied=await evaluate(`({clips:S.clips.filter(c=>c.clipId!=='E').map(c=>({id:c.clipId,name:c.name,time:c.timelineStart})),transitions:JSON.parse(JSON.stringify(S.transitions))})`);
  const alpha=copied.clips.find(c=>c.name==='Alpha'),bravo=copied.clips.find(c=>c.name==='Bravo');
  assert.equal(copied.clips.length,2);assert.equal(alpha.time,4);assert.equal(bravo.time,6);assert.equal(copied.transitions.length,1);
  assert.equal(copied.transitions[0].leftClipId,alpha.id);assert.equal(copied.transitions[0].rightClipId,bravo.id);assert.equal(copied.transitions[0].type,'fade');assert.equal(copied.transitions[0].suspended,false);
  await timelineFocus();await shortcut('Z');assert.equal(await evaluate('S.clips.length'),1);assert.equal(await evaluate('S.transitions.length'),0);
  proof.transitionCopy={...copied,freshPairIds:true,singleUndo:true};
}

async function checkCopiedLaneGaps() {
  await setup();
  await evaluate(`S.videoTracks=[1,2,3].map(id=>({id,name:'Video '+id,locked:false,visible:true,muted:false}));S.clips.filter(c=>c.videoTrack===2).forEach(c=>c.videoTrack=3);ensureVideoTracks();drawClips()`);
  await clickClip('A');await clickClip('C',true);await timelineFocus();await shortcut('C');
  await evaluate(`switchTimeline('TL2');S.videoTracks=[1,2,3].map(id=>({id,name:'Video '+id,locked:id===3,visible:true,muted:false}));S.activeVideoTrack=2;ensureVideoTracks();seekOutputTime(4);pausePreview();drawClips();el('timeline').focus()`);await frames();
  const before=await snapshot();let history=await evaluate('S.history.length');await shortcut('V');
  assert.deepEqual(await snapshot(),before);assert.equal(await evaluate('S.videoTracks.length'),3);assert.equal(await evaluate('S.history.length'),history);
  await evaluate('addVideoTrack();S.activeVideoTrack=2;drawClips();el("timeline").focus()');history=await evaluate('S.history.length');await shortcut('V');
  const pasted=(await snapshot()).filter(c=>c.clipId!=='E'),alpha=pasted.find(c=>c.name==='Alpha'),charlie=pasted.find(c=>c.name==='Charlie');
  assert.equal(pasted.length,2,'An unselected locked gap lane must not reject paste');assert.equal(alpha.videoTrack,2);assert.equal(charlie.videoTrack,4,'Original lane 1+3 spacing must paste into lane 2+4, not adjacent lanes');
  assert.equal(alpha.timelineStart,4);assert.equal(charlie.timelineStart,5);assert.equal(await evaluate('videoTrackState(3).locked'),true);
  assert.equal(await evaluate('S.videoTracks.length'),4);assert.equal(await evaluate('S.history.length'),history+1);
  await timelineFocus();await shortcut('Z');assert.deepEqual(await snapshot(),before);assert.equal(await evaluate('S.videoTracks.length'),4,'Undo preserves the explicitly created destination lane');
  proof.laneGaps={source:[1,3],destination:[2,4],lockedGapUnaffected:true,singleUndo:true};
}

async function checkRipple() {
  await setup();const original=await snapshot();
  await evaluate('videoTrackState(2).locked=true;drawClips()');await click('#timeline-ripple');
  let packed=await snapshot(),byId=new Map(packed.map(c=>[c.clipId,c]));
  assert.equal(await evaluate('S.timelineRipple'),true);assert.equal(await evaluate('el("timeline-ripple").getAttribute("aria-pressed")'),'true');assert.equal(await evaluate('S.timelineMagnet'),false);
  assert.equal(byId.get('B').timelineStart,2);assert.equal(byId.get('C').timelineStart,1);assert.equal(byId.get('D').timelineStart,6,'Locked channel is not compacted');
  for(const before of original){const after=byId.get(before.clipId);assert.deepEqual({...after,timelineStart:before.timelineStart},before,'Ripple cannot change source trim or keyframe settings');}
  await timelineFocus();await shortcut('Z');assert.equal(await evaluate('S.timelineRipple'),false);assert.deepEqual(await snapshot(),original,'One undo restores mode and original gaps');
  await evaluate('videoTrackState(2).locked=false;drawClips()');await click('#timeline-ripple');
  packed=await snapshot();byId=new Map(packed.map(c=>[c.clipId,c]));assert.deepEqual(['A','B','C','D'].map(id=>byId.get(id).timelineStart),[0,2,0,2]);
  await click('#timeline-magnet');assert.equal(await evaluate('S.timelineRipple'),true);assert.equal(await evaluate('S.timelineMagnet'),true);assert.deepEqual(await snapshot(),packed,'Magnet toggle never compacts or reorders');await click('#timeline-magnet');
  await clickClip('A');await clickClip('C',true);const history=await evaluate('S.history.length');const dragged=await dragClip('A',2.6);
  assert.equal(await evaluate('S.videoTracks.length'),2,'Ripple overlap must not create surprise video channels');
  const moved=new Map(dragged.clips.map(c=>[c.clipId,c]));assert.equal(moved.get('A').videoTrack,1);assert.equal(moved.get('C').videoTrack,2);assert.deepEqual(['B','A','D','C'].map(id=>moved.get(id).timelineStart),[0,2,0,2]);
  assert.equal(await evaluate('S.history.length'),history+1);await timelineFocus();await shortcut('Z');assert.deepEqual(await snapshot(),packed);
  await evaluate('switchTimeline("TL2")');assert.equal(await evaluate('S.timelineRipple'),false);await evaluate('switchTimeline("TL1");saveNamedProject()');
  const saved=await evaluate('projectPayload()');assert.equal(savedProjects.size,1);assert.deepEqual(saved.timelines.map(t=>[t.id,t.state.timelineRipple]),[['TL1',true],['TL2',false]]);
  await evaluate('localStorage.clear()');await window.loadURL(window.webContents.getURL());await evaluate('projectWorkspaceInitialization');await evaluate('el("project-list").value="selection";loadNamedProject()');await frames();
  assert.equal(await evaluate('S.timelineRipple'),true);assert.equal(await evaluate('el("timeline-ripple").getAttribute("aria-pressed")'),'true');assert.deepEqual(await snapshot(),packed);
  await evaluate('switchTimeline("TL2")');assert.equal(await evaluate('S.timelineRipple'),false);assert.equal(await evaluate('el("timeline-ripple").getAttribute("aria-pressed")'),'false');
  proof.ripple={lockedChannelPreserved:true,magnetIndependent:true,singleUndo:true,groupOverlapKeptLanes:true,packedTimes:[0,2,0,2],perTimelineRecovered:[['TL1',true],['TL2',false]]};
}

app.whenReady().then(async()=>{
  // The production app supplies this native edit role; keep Cmd+A text behavior on macOS.
  Menu.setApplicationMenu(Menu.buildFromTemplate([...(process.platform==='darwin'?[{role:'appMenu'}]:[]),{label:'Düzenle',submenu:[{role:'selectAll',label:'Tümünü seç'}]}]));
  const ffmpeg=process.env.SMART_EDITOR_FFMPEG||(process.platform==='win32'&&fs.existsSync(path.join(root,'tools/ffmpeg/bin/ffmpeg.exe'))?path.join(root,'tools/ffmpeg/bin/ffmpeg.exe'):'ffmpeg');
  const file=path.join(artifacts,'source.mp4');execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=s=320x180:r=30:d=20','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',file],{timeout:60000});
  const bytes=fs.readFileSync(file),hash=crypto.createHash('sha256').update(bytes).digest('hex');media.set('source.mp4',{bytes,file,hash});
  server=http.createServer(async(req,res)=>{try{const route=new URL(req.url,'http://fixture').pathname,reply=value=>{res.setHeader('Content-Type','application/json');res.end(j(value))};
    if(route==='/'){res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(root,'templates/index.html')));return}
    if(route==='/favicon.ico'){res.writeHead(204).end();return}
    if(route.startsWith('/static/')){const base=path.join(root,'static'),target=path.resolve(base,decodeURIComponent(route.slice(8)));if(!target.startsWith(base+path.sep)||!fs.existsSync(target)){res.writeHead(404).end();return}res.setHeader('Content-Type',target.endsWith('.css')?'text/css':target.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(fs.readFileSync(target));return}
    if(route==='/projects'&&req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=JSON.parse(Buffer.concat(chunks).toString());savedProjects.set('selection',{...data,id:'selection'});reply({id:'selection'});return}
    if(route==='/projects'){reply({projects:[...savedProjects.values()].map(p=>({id:p.id,name:p.name}))});return}
    if(route==='/projects/selection'){reply(savedProjects.get('selection'));return}
    if(route==='/api/version'||route==='/api/check-update'){reply({version:'selection-fixture',update_available:false});return}
    if(route.startsWith('/waveform/')){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20"/>');return}
    const item=route.startsWith('/video/')?media.get(decodeURIComponent(route.slice(7))):null;if(item){const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||''),start=range?+range[1]:0,end=range&&range[2]?Math.min(+range[2],item.bytes.length-1):item.bytes.length-1;res.writeHead(range?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${item.bytes.length}`}:{})});res.end(item.bytes.subarray(start,end+1));return}
    res.writeHead(404).end();
  }catch(error){errors.push(error.stack);res.writeHead(500).end()}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  window=new BrowserWindow({show:true,frame:false,...viewport,useContentSize:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);await evaluate('projectWorkspaceInitialization');window.setContentSize(viewport.width,viewport.height);window.showInactive();await frames();
  proof.viewport=await evaluate('({width:innerWidth,height:innerHeight})');assert.deepEqual(proof.viewport,viewport);
  await checkSelectionAndScope();await checkDeleteAndLocks();await checkCopyAcrossTimelines();await checkGroupMovement();await checkCopiedTransition();await checkCopiedLaneGaps();await checkRipple();
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),hash,'Original source media remains unchanged');
  assert.deepEqual(errors,[]);console.log(j({ok:true,proof,errors,artifacts}));
}).catch(async error=>{console.error(error);proof.failure=await evaluate(`({selection:S.selectedVideoClipIds,primary:S.selected,active:S.activeTimelineId,focus:document.activeElement?.id,clips:S.clips,history:S.history.length,viewport:[innerWidth,innerHeight],log:el('manual-log').textContent.slice(-1600)})`).catch(()=>null);await screenshot('failure').catch(()=>{});console.error(j({proof,errors,artifacts}));process.exitCode=1}).finally(()=>{window?.destroy();server?.closeAllConnections();server?.close();app.exit(process.exitCode||0)});
