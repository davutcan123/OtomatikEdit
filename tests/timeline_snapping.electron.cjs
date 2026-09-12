// Real, visible Electron pointer/keyboard regression. Never uses the user's media or project store.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'otomatik-timeline-interactions-'));
app.setPath('userData', path.join(artifacts, 'profile'));
const proof = { moves: [], trims: [], widths: [] }, errors = [], media = new Map();let window, server;
const json = JSON.stringify, evaluate = code => window.webContents.executeJavaScript(code);
const frames = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const screenshot = async name => fs.promises.writeFile(path.join(artifacts, name + '.png'), (await window.webContents.capturePage()).toPNG());
const selectorFor = type => type === 'video' ? '#track .clip' : type === 'text' || type === 'subtitle' ? `[data-text-id="moving"]` : type === 'sticker' ? '[data-sticker-id="moving"].sticker-clip' : `[data-layer-id="moving"].timeline-media-clip`;
async function readyVideo() { await evaluate(`new Promise((resolve,reject)=>{const start=performance.now(),check=()=>{if(mv.readyState>=2&&!mv.seeking)return resolve();if(performance.now()-start>10000)return reject(new Error('Video not ready '+mv.readyState));setTimeout(check,20)};check()})`); }
async function setup(type = 'text', magnet = true) {
  await evaluate(`restoreProject({name:'Timeline regression',mediaAssets:[{id:'video',fileId:'source.mp4',name:'Source',kind:'video',duration:30},{id:'image',fileId:'image.png',name:'Image',kind:'image'},{id:'audio',fileId:'audio.wav',name:'Audio',kind:'audio',duration:30}],activeTimelineId:'TL1',timelines:[{id:'TL1',name:'Main',state:{manualId:'source.mp4',manualName:'Source',duration:30,selected:0,preview:0,clips:[{clipId:'V1',start:0,end:30,timelineStart:0,fileId:'source.mp4',sourceDuration:30,videoTrack:1}],canvas:{width:1920,height:1080},zoom:20}}]});S.timelineMagnet=${magnet};S.texts=[{id:'target',text:'Boundary',start:10,end:12,x:50,y:50,size:60,kind:'text'}];
    (()=>{const type=${json(type)},item={id:'moving',start:2,end:5,text:'Moving text',name:'Moving '+type,x:50,y:50,scale:30,size:70,rotation:0,transformKeyframes:[],sourceStart:2,volume:1,preset:'star'};
      if(type==='image'){item.assetId='image';item.fileId='image.png';item.src='/video/image.png';S.imageLayers=[hydrateImageLayer(item)]}
      else if(type==='audio'){item.assetId='audio';item.fileId='audio.wav';item.src='/video/audio.wav';S.audioLayers=[item]}
      else if(type==='sticker')S.stickers=[item];else if(type==='text'||type==='subtitle'){item.kind=type;S.texts.push(item)}
      S.selectedText=type==='text'||type==='subtitle'?'moving':null;S.selectedSticker=type==='sticker'?'moving':null;S.selectedLayer=type==='image'||type==='audio'?{type,id:'moving'}:null;
    })();drawMagnetButton();drawClips();seekOutputTime(20);el('timeline').scrollLeft=0;`);
  await readyVideo();await frames();
}
async function pointFor(selector, edge) {
  await evaluate(`(()=>{const node=document.querySelector(${json(selector)});if(!node)throw new Error('Missing '+${json(selector)});const box=el('timeline');box.scrollTop=Math.max(0,node.parentElement.offsetTop-60);node.scrollIntoView({block:'nearest',inline:'nearest'})})()`);await frames();
  const point = await evaluate(`(()=>{let node=document.querySelector(${json(selector)});if(${json(edge || '')})node=node.querySelector('.trim-handle.'+${json(edge || '')});const r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,width:r.width,height:r.height,reachable:node.contains(document.elementFromPoint(x,y)),viewport:[innerWidth,innerHeight],hit:document.elementFromPoint(x,y)?.className}})()`);
  assert.ok(point.reachable, `Pointer target is reachable: ${selector} ${edge || ''} ${json(point)}`);return point;
}
const send = (type, point) => window.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, x: Math.round(point.x), y: Math.round(point.y) });
async function drag(selector, delta, edge) {
  const from = await pointFor(selector, edge), zoom = await evaluate('S.zoom'), to = { x: from.x + delta * zoom, y: from.y };
  send('mouseDown', from);send('mouseMove', to);await frames();
  const during = await evaluate(`({snap:S.timelineSnapTime,guide:el('timeline-snap-guide')&&!el('timeline-snap-guide').hidden,left:parseFloat(document.querySelector(${json(selector)}).style.left),width:parseFloat(document.querySelector(${json(selector)}).style.width)})`);
  send('mouseUp', to);await frames();assert.equal(await evaluate(`!!el('timeline-snap-guide')&&!el('timeline-snap-guide').hidden`), false, 'Guide clears after release');return { from, to, during };
}
async function snapshot(type) { return evaluate(`JSON.parse(JSON.stringify(${type === 'image' ? 'S.imageLayers' : type === 'audio' ? 'S.audioLayers' : type === 'sticker' ? 'S.stickers' : 'S.texts'}.find(x=>x.id==='moving')))`); }

async function checkAllLayers() {
  for (const type of ['text', 'subtitle', 'image', 'audio', 'sticker']) {
    await setup(type);const selector = selectorFor(type), moved = await drag(selector, 4.8), item = await snapshot(type);
    assert.equal(item.start, 7);assert.equal(item.end, 10);assert.equal(moved.during.snap, 10);assert.equal(moved.during.guide, true);assert.equal(moved.during.width, 60);
    proof.moves.push({ type, item, ...moved });await evaluate('undoEdit()');await readyVideo();assert.equal((await snapshot(type)).start, 2);
    await evaluate('S.timelineMagnet=false;drawMagnetButton()');await drag(selector, 4.8);assert.ok(Math.abs((await snapshot(type)).start - 6.8) < .051);
    await setup(type);const right = await drag(selector, 4.8, 'right');assert.equal((await snapshot(type)).end, 10);assert.equal(right.during.width, 160);assert.equal(right.during.snap, 10);
    await evaluate('S.timelineMagnet=false;drawMagnetButton()');const shortened = await drag(selector, -6.5, 'right');assert.ok(Math.abs((await snapshot(type)).end - 3.5) < .051);assert.ok(Math.abs(shortened.during.width - 30) <= 1);
    const old = await snapshot(type);await evaluate(`S.trackState[${json(type)}].locked=true;drawClips()`);await drag(selector, 1, 'right');assert.deepEqual(await snapshot(type), old, 'Locked trim must not change data');
    proof.trims.push({ type, extended: right.during, shortened: shortened.during, lockedUnchanged: true });
    await evaluate(`S.trackState[${json(type)}].locked=false`);
    for (const zoom of [.02, 8, 80]) { await evaluate(`S.zoom=${zoom};drawClips()`);const width = await evaluate(`document.querySelector(${json(selector)}).getBoundingClientRect().width`), expected = ((await snapshot(type)).end - (await snapshot(type)).start) * zoom;assert.ok(Math.abs(width - expected) < .03, `Exact ${type} width at ${zoom}: ${width}/${expected}`);proof.widths.push({ type, zoom, width, expected }); }
  }
  await screenshot('timed-layers');
}
async function checkScrubAndKeyboard() {
  await setup('text');await evaluate(`S.clips=[hydrateClip({clipId:'one',start:0,end:4,timelineStart:0,fileId:'source.mp4',sourceDuration:30}),hydrateClip({clipId:'two',start:8,end:12,timelineStart:8,fileId:'source.mp4',sourceDuration:30})];S.texts=[{id:'moving',text:'Between cuts',start:5.5,end:6.3,x:50,y:50,size:60}];S.zoom=40;drawClips();seekOutputTime(2);el('timeline').scrollTop=0;el('timeline').scrollLeft=0`);await readyVideo();await frames();
  const point = await evaluate(`(()=>{const r=el('timeline-ruler').getBoundingClientRect();return{x:r.left+4.2*S.zoom,y:r.top+r.height/2}})()`);send('mouseDown', point);await frames();
  assert.ok(Math.abs(await evaluate('currentOutputTime()') - 4) < .002);assert.equal(await evaluate('S.timelineSnapTime'), 4);await screenshot('magnetic-playhead');send('mouseUp', point);await frames();
  await evaluate(`el('timeline').focus({preventScroll:true})`);
  for (const [key, expected] of [['Right',5.5],['Right',6.3],['Right',8],['Left',6.3]]) { window.webContents.sendInputEvent({type:'keyDown',keyCode:key});window.webContents.sendInputEvent({type:'keyUp',keyCode:key});await frames();assert.ok(Math.abs(await evaluate('currentOutputTime()') - expected) < .002, 'Arrow jumps to exact boundary '+expected); }
  await evaluate('S.timelineMagnet=false;drawMagnetButton()');send('mouseDown', point);await frames();assert.ok(Math.abs(await evaluate('currentOutputTime()') - 4.2) < .03);send('mouseUp', point);await frames();proof.scrub={snapped:4,unsnapped:await evaluate('currentOutputTime()'),arrowBoundaries:[5.5,6.3,8,6.3]};
}
async function checkVideoTiming() {
  await setup('video');await evaluate(`S.clips=[hydrateClip({clipId:'moving-video',start:4,end:14,speed:2,timelineStart:5,fileId:'source.mp4',sourceDuration:30,videoTrack:1})];S.texts=[{id:'target',text:'Snap target',start:4,end:12,x:50,y:50,size:60}];S.selectedText=null;S.selected=0;S.preview=0;drawClips();seekOutputTime(7)`);await readyVideo();await frames();
  const left=await drag('#track .clip',-.8,'left'),afterLeft=await evaluate('JSON.parse(JSON.stringify(S.clips[0]))');assert.equal(afterLeft.timelineStart,4);assert.equal(afterLeft.start,2);assert.equal(afterLeft.end,14);assert.equal(left.during.snap,4);assert.equal(left.during.width,120);
  const right=await drag('#track .clip',1.8,'right'),afterRight=await evaluate('JSON.parse(JSON.stringify(S.clips[0]))');assert.equal(afterRight.timelineStart,4);assert.equal(afterRight.start,2);assert.equal(afterRight.end,18);assert.equal(right.during.snap,12);assert.equal(right.during.width,160);
  await evaluate('undoEdit()');await readyVideo();assert.equal(await evaluate('clipTimelineEnd(S.clips[0])'),10);
  await evaluate(`S.timelineMagnet=false;drawMagnetButton();S.clips[0].end=S.clips[0].start+3;drawClips()`);
  for(const zoom of [.02,8,80]){await evaluate(`S.zoom=${zoom};drawClips()`);const width=await evaluate(`document.querySelector('#track .clip').getBoundingClientRect().width`),expected=1.5*zoom;assert.ok(Math.abs(width-expected)<.03,`Exact video width ${zoom}: ${width}/${expected}`);proof.widths.push({type:'video',zoom,width,expected})}
  proof.videoTrim={left:left.during,right:right.during,sourceStart:afterLeft.start,sourceEnd:afterRight.end,speed:2,rightEdgeAfterLeft:10,undo:true};
}
app.whenReady().then(async()=>{
  const ffmpeg=process.env.SMART_EDITOR_FFMPEG||(process.platform==='win32'&&fs.existsSync(path.join(root,'tools/ffmpeg/bin/ffmpeg.exe'))?path.join(root,'tools/ffmpeg/bin/ffmpeg.exe'):'ffmpeg');
  for(const [name,args,type] of [['source.mp4',['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=30','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p'],'video/mp4'],['image.png',['-f','lavfi','-i','color=c=red:s=160x100','-frames:v','1'],'image/png'],['audio.wav',['-f','lavfi','-i','sine=frequency=440:duration=30'],'audio/wav']]){const file=path.join(artifacts,name);execFileSync(ffmpeg,['-v','error','-y',...args,file],{timeout:60000});const bytes=fs.readFileSync(file);media.set(name,{file,bytes,type,hash:crypto.createHash('sha256').update(bytes).digest('hex')})}
  server=http.createServer((request,response)=>{try{const route=new URL(request.url,'http://fixture').pathname,reply=value=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(value))};if(route==='/'){response.setHeader('Content-Type','text/html');response.end(fs.readFileSync(path.join(root,'templates/index.html')));return}if(route==='/favicon.ico'){response.writeHead(204).end();return}if(route.startsWith('/static/')){const file=path.resolve(root,'.'+route);if(!file.startsWith(path.join(root,'static')+path.sep)||!fs.existsSync(file)){response.writeHead(404).end();return}response.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');response.end(fs.readFileSync(file));return}if(route==='/projects'){reply({projects:[]});return}if(route==='/api/check-update'||route==='/api/version'){reply({version:'timeline-fixture',update_available:false});return}const item=media.get(route.startsWith('/waveform/')?'image.png':decodeURIComponent(route.slice('/video/'.length)));if(item&&(route.startsWith('/video/')||route.startsWith('/waveform/'))){const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range||''),start=range?+range[1]:0,end=range&&range[2]?Math.min(item.bytes.length-1,+range[2]):item.bytes.length-1;response.statusCode=range?206:200;response.setHeader('Content-Type',item.type);response.setHeader('Accept-Ranges','bytes');response.setHeader('Content-Length',end-start+1);if(range)response.setHeader('Content-Range',`bytes ${start}-${end}/${item.bytes.length}`);response.end(item.bytes.subarray(start,end+1));return}response.writeHead(404).end()}catch(error){errors.push(error.stack);response.writeHead(500).end()}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));window=new BrowserWindow({show:true,frame:false,width:1366,height:740,useContentSize:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});window.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});await window.loadURL(`http://127.0.0.1:${server.address().port}/`);await evaluate('projectWorkspaceInitialization');window.setContentSize(1366,740);window.showInactive();await frames();
  proof.viewport=await evaluate('({width:innerWidth,height:innerHeight})');assert.deepEqual(proof.viewport,{width:1366,height:740});
  await checkAllLayers();await checkVideoTiming();await checkScrubAndKeyboard();
  for(const item of media.values())assert.equal(crypto.createHash('sha256').update(fs.readFileSync(item.file)).digest('hex'),item.hash);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,...proof,errors,artifacts}));
}).catch(async error=>{console.error(error);if(window){proof.failure=await evaluate(`({viewport:[innerWidth,innerHeight],cursor:currentOutputTime(),text:S.texts,selected:S.selected,clips:S.clips,log:el('manual-log').textContent.slice(-1800)})`).catch(()=>null);await screenshot('failure').catch(()=>{})}console.error(JSON.stringify({proof,errors,artifacts}));process.exitCode=1}).finally(()=>{window?.destroy();server?.closeAllConnections();server?.close();app.exit(process.exitCode||0)});
