// Isolated native scrolling/scrubbing fixture; never uses a user's project or profile.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'otomatik-timeline-viewport-'));
app.setPath('userData',path.join(artifacts,'profile'));
let win,server;const errors=[],proof={};
const evaluate=code=>win.webContents.executeJavaScript(code),frames=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const rect=id=>`(()=>{const r=el(${JSON.stringify(id)}).getBoundingClientRect();return{left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()`;
const send=(type,x,y)=>win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(x),y:Math.round(y)});
async function screenshot(name){fs.writeFileSync(path.join(artifacts,name+'.png'),(await win.webContents.capturePage()).toPNG())}
async function geometry(){return evaluate(`(()=>{const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom}},box=el('timeline');return{box:rect(box),ruler:rect(el('timeline-ruler')),cap:rect(el('playhead-cap')),tick:rect(el('timeline-ruler').firstElementChild),scroll:[box.scrollLeft,box.scrollTop],cursor:currentOutputTime(),lanes:[...document.querySelectorAll('.video-lane')].map(node=>({id:+node.dataset.videoTrack,...rect(node)})).sort((a,b)=>a.top-b.top),active:S.activeVideoTrack,selected:S.selected,selection:[...S.selectedVideoClipIds]}})()`)}
async function click(id){const r=await evaluate(rect(id)),x=r.left+r.width/2,y=r.top+r.height/2;assert.equal(await evaluate(`el(${JSON.stringify(id)}).contains(document.elementFromPoint(${x},${y}))`),true,id+' reachable');send('mouseDown',x,y);send('mouseUp',x,y);await frames()}
async function verify(){
  await evaluate(`restoreProject({name:'Viewport fixture',mediaAssets:[{id:'source',kind:'video',fileId:'source.mp4',name:'Source',duration:30}],activeTimelineId:'TL1',timelines:[{id:'TL1',name:'Main',state:{manualId:'source.mp4',duration:30,selected:0,preview:0,zoom:60,videoTracks:[{id:1},{id:5},{id:8},{id:12}],activeVideoTrack:1,clips:[{clipId:'A',fileId:'source.mp4',sourceDuration:30,videoTrack:1,start:0,end:30,timelineStart:0}],texts:[{id:'T',text:'Fixture',style:'classic',start:0,end:30,x:50,y:50}]}}]});S.timelineMagnet=false;seekOutputTime(8);S.selectedText='T';S.selectedVideoClipIds=['A'];drawClips();el('timeline').scrollTop=el('timeline').scrollHeight;el('timeline').scrollLeft=160`);
  await frames();const before=await geometry(),sources=await evaluate('JSON.stringify(S.clips.map(c=>({id:c.clipId,track:c.videoTrack,start:c.start,end:c.end,timelineStart:c.timelineStart})))');
  assert.ok(before.scroll[1]>0,'Fixture is vertically scrolled');await click('video-track-add');
  let g=await geometry();assert.equal(g.active,13);assert.equal(g.selected,-1);assert.deepEqual(g.selection,[]);assert.equal(g.lanes[0].id,13);
  assert.equal(await evaluate('S.selectedText'),null);assert.deepEqual(g.lanes.map(lane=>lane.id),[13,12,8,5,1]);
  assert.ok(g.lanes[0].top>=g.box.top+40&&g.lanes[0].bottom<=g.box.bottom,'New upper lane is visible below ruler');
  assert.equal(g.scroll[0],before.scroll[0]);assert.ok(Math.abs(g.cursor-before.cursor)<.001);assert.equal(await evaluate('JSON.stringify(S.clips.map(c=>({id:c.clipId,track:c.videoTrack,start:c.start,end:c.end,timelineStart:c.timelineStart})))'),sources);
  proof.addedAbove=g;await screenshot('new-channel-above');
  for(const viewport of [{width:1366,height:740},{width:1100,height:700}]){
    win.setContentSize(viewport.width,viewport.height);await frames();await evaluate('el("timeline").scrollLeft=160;seekOutputTime(8)');await frames();
    const baseline=await geometry();
    for(const scroll of [0,130,300,10000]){
      await evaluate(`el('timeline').scrollTop=${scroll}`);await frames();g=await geometry();
      assert.ok(Math.abs(g.ruler.top-g.box.top-1)<1,'Sticky ruler at scroll '+scroll+' '+JSON.stringify(g));
      assert.ok(Math.abs(g.cap.top-baseline.cap.top)<1,'Sticky cap at scroll '+scroll);
      assert.ok(Math.abs(g.cap.left-baseline.cap.left)<1,'Vertical scroll cannot move time horizontally');assert.ok(Math.abs(g.cursor-8)<.001);
      const x=g.cap.left+g.cap.width/2,y=g.cap.top+g.cap.height/2;
      assert.equal(await evaluate(`el('playhead-cap').contains(document.elementFromPoint(${x},${y}))`),true,'Cap stays clickable above lanes');
    }
    const left=await geometry();await evaluate('el("timeline").scrollLeft+=90');await frames();g=await geometry();
    assert.ok(Math.abs(g.cap.left-left.cap.left+90)<1,'Horizontal scroll carries playhead with its timeline time');
    assert.ok(Math.abs(g.tick.left-left.tick.left+90)<1,'Ruler ticks move with timeline content');assert.ok(Math.abs(g.cursor-8)<.001);
    const x=g.cap.left+g.cap.width/2,y=g.cap.top+g.cap.height/2;send('mouseDown',x,y);send('mouseMove',x+84,y);await frames();send('mouseUp',x+84,y);await frames();
    assert.ok(Math.abs((await geometry()).cursor-9.4)<.03,'Sticky cap scrubs the same horizontal time mapping');
    g=await geometry();const time=10.5,rulerX=await evaluate(`el('timeline-content').getBoundingClientRect().left+132+${time}*S.zoom`),rulerY=g.ruler.top+30;
    assert.equal(await evaluate(`el('timeline-ruler').contains(document.elementFromPoint(${rulerX},${rulerY}))`),true,'Ruler is not obscured by scrolled clip controls');
    send('mouseDown',rulerX,rulerY);send('mouseUp',rulerX,rulerY);await frames();assert.ok(Math.abs((await geometry()).cursor-time)<.03,'Sticky ruler click keeps exact time');
    proof[viewport.width]=await geometry();await screenshot('sticky-'+viewport.width);
  }
  await evaluate('undoEdit()');await frames();assert.equal(await evaluate('S.videoTracks.length'),4);assert.deepEqual(await evaluate('S.videoTracks.map(t=>t.id)'),[1,5,8,12]);
  proof.undoRestoredChannels=true;
  await evaluate(`document.querySelector('[data-video-track-id="8"][data-video-track-action="visible"]').scrollIntoView({block:'start',inline:'nearest'})`);await frames();
  const control=await evaluate(`(()=>{const node=document.querySelector('[data-video-track-id="8"][data-video-track-action="visible"]'),r=node.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,reachable:node.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)),top:r.top,viewportTop:el('timeline').getBoundingClientRect().top}})()`);
  assert.ok(control.reachable&&control.top>=control.viewportTop+40,'scrollIntoView keeps lane buttons below the sticky timebar: '+JSON.stringify(control));proof.scrollIntoViewControl=control;
}
app.whenReady().then(async()=>{
  const executable=process.env.SMART_EDITOR_FFMPEG||(process.platform==='win32'?path.join(root,'tools/ffmpeg/bin/ffmpeg.exe'):'ffmpeg'),source=path.join(artifacts,'source.mp4');
  execFileSync(executable,['-v','error','-y','-f','lavfi','-i','color=c=0x315090:s=320x180:r=30:d=30','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',source],{timeout:60000});const video=fs.readFileSync(source);
  server=http.createServer((request,response)=>{
    const route=new URL(request.url,'http://fixture').pathname,reply=data=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(data))};
    if(route==='/'){response.setHeader('Content-Type','text/html');response.end(fs.readFileSync(path.join(root,'templates/index.html')));return}
    if(route.startsWith('/static/')){const file=path.resolve(root,'.'+route);if(!file.startsWith(path.join(root,'static')+path.sep)||!fs.existsSync(file)){response.writeHead(404).end();return}response.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');response.end(fs.readFileSync(file));return}
    if(route==='/projects'){reply({projects:[]});return}if(route==='/api/version'||route==='/api/check-update'){reply({version:'fixture',update_available:false});return}
    if(route==='/video/source.mp4'){const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range||''),start=range?+range[1]:0,end=range&&range[2]?Math.min(+range[2],video.length-1):video.length-1;response.statusCode=range?206:200;response.setHeader('Content-Type','video/mp4');response.setHeader('Accept-Ranges','bytes');response.setHeader('Content-Length',end-start+1);if(range)response.setHeader('Content-Range',`bytes ${start}-${end}/${video.length}`);response.end(video.subarray(start,end+1));return}
    if(route.startsWith('/waveform/')||route==='/favicon.ico'){response.writeHead(204).end();return}response.writeHead(404).end();
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  win=new BrowserWindow({show:true,frame:false,width:1366,height:740,useContentSize:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);await evaluate('projectWorkspaceInitialization');win.showInactive();await frames();await verify();assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,proof,artifacts}));
}).catch(async error=>{console.error(error);if(win){await screenshot('failure').catch(()=>{});console.error(JSON.stringify({geometry:await geometry().catch(()=>null),errors,artifacts}))}process.exitCode=1}).finally(()=>{win?.destroy();server?.closeAllConnections();server?.close();app.exit(process.exitCode||0)});
