// Real workspace layout, assets and controls are isolated from local user data.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'otomatik-studio-layout-'));
app.setPath('userData', path.join(artifacts, 'profile'));
const template = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
const imageTypes = {'.css':'text/css','.js':'application/javascript','.jpg':'image/jpeg','.mp4':'video/mp4','.wav':'audio/wav'};
let window, server;
const evalPage = code => window.webContents.executeJavaScript(code);
const frames = () => evalPage('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
async function screenshot(name) {
  fs.writeFileSync(path.join(artifacts,name+'.png'),(await window.webContents.capturePage()).toPNG());
}
async function inspect() {
  return evalPage(`(() => {
    const bounds = id => {
      const node = document.getElementById(id), r = node.getBoundingClientRect();
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight};
    };
    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
      core:bounds('manual-core'),preview:bounds('preview-panel'),stage:bounds('preview-stage'),shell:bounds('preview-shell'),
      assets:bounds('asset-editor'),assetContent:bounds('asset-editor-content'),inspector:bounds('right-editor-column'),timeline:bounds('timeline'),
      timelinePanel:bounds('timeline-panel'),dock:bounds('manual-status-dock'),render:bounds('manual-render-top'),snapshot:bounds('snapshot-open')};
  })()`);
}
function serve(req, res) {
  const route = new URL(req.url,'http://fixture').pathname;
  if (route === '/') {res.writeHead(200,{'Content-Type':'text/html'});res.end(template);return;}
  if (route.startsWith('/static/') || route === '/video/studio-fixture.mp4') {
    const dir = path.join(root,'static'), file = route.startsWith('/static/') ? path.join(root,route) : path.join(dir,'studio/demo/alpine-tour.mp4');
    if (!file.startsWith(dir+path.sep)||!fs.existsSync(file)) return res.writeHead(404).end();
    const data = fs.readFileSync(file), range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? +range[1] : 0, end = range?.[2] ? Math.min(+range[2],data.length-1) : data.length-1;
    res.writeHead(range?206:200,{'Content-Type':imageTypes[path.extname(file)]||'application/octet-stream','Accept-Ranges':'bytes',
      'Content-Length':end-start+1,...(range&&{'Content-Range':`bytes ${start}-${end}/${data.length}`})});
    res.end(data.subarray(start,end+1));return;
  }
  if (route === '/projects' || route.startsWith('/api/')) {
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({projects:[],version:'1.1.10',update_available:false}));return;
  }
  if (route.startsWith('/waveform/')) {
    res.writeHead(200,{'Content-Type':'image/svg+xml'});
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="44"><path d="M0 22H400" stroke="#90eac2"/></svg>');return;
  }
  res.writeHead(204).end();
}

app.whenReady().then(async () => {
  server=http.createServer(serve);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  window=new BrowserWindow({show:false,width:1440,height:900,useContentSize:true,
    webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
  await evalPage('projectWorkspaceInitialization');await evalPage('Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))');await frames();
  await screenshot('studio-empty-1440x900');
  await evalPage(`(() => {
    const asset={id:'M1',fileId:'studio-fixture.mp4',name:'Alp vadisi',kind:'video',duration:8,src:'/video/studio-fixture.mp4'};
    restoreProject({name:'Alp vadisi · İlk kurgu',mediaAssets:[asset],timelines:[{id:'TL1',name:'Dağ rotası',state:emptyTimelineState()}]});
    addProjectAssetAt(S.mediaAssets[0],0);seekOutputTime(1.6);
  })()`);
  await evalPage(`new Promise((resolve,reject)=>{
    const deadline=performance.now()+8000;
    const poll=()=>mv.readyState>=2&&!mv.seeking?resolve():performance.now()>deadline?reject(new Error('Sample video not ready')):requestAnimationFrame(poll);
    poll();
  })`);
  await frames();await screenshot('studio-edit-1440x900');
  assert.ok(await evalPage(`!mv.controls&&el('studio-play-toggle').getAttribute('aria-label')==='Oynat'&&S.zoom>=50`));
  await evalPage(`(() => {
    StudioWorkspace.openSection('text');
    const presets=el('text-presets');
    for(let i=0;i<40;i++)presets.append(presets.firstElementChild.cloneNode(true));
  })()`);
  for(const [width,height] of [[1440,900],[1920,1080],[1366,768],[1366,740],[1100,700]]) {
    window.setContentSize(width,height);await frames();
    const view=await inspect();
    assert.equal(view.width,width);
    assert.ok(view.scrollWidth<=width+1&&view.scrollHeight<=height+1,`Workspace overflows at ${width}×${height}: ${JSON.stringify(view)}`);
    assert.ok(view.assets.right<view.preview.left&&view.preview.right<view.inspector.left,'Three distinct top work areas');
    assert.ok(Math.abs(view.assets.top-view.preview.top)<2&&Math.abs(view.preview.top-view.inspector.top)<2,'Top panels should align');
    assert.ok(view.stage.width>150&&Math.abs(view.stage.width/view.stage.height-16/9)<.015,'Player frame remains 16:9');
    assert.ok(view.shell.height>=210&&view.timeline.height>=190,'Preview and timeline have usable height');
    assert.ok(view.preview.bottom<=view.timelinePanel.top&&view.timeline.bottom<=view.dock.top,'Timeline stays in a separate lower row');
    assert.ok(Math.abs(view.timelinePanel.left-view.core.left)<2&&Math.abs(view.timelinePanel.right-view.core.right)<2,'Timeline spans the entire workbench');
    assert.ok(view.assetContent.scrollHeight>view.assetContent.clientHeight,'Catalog scrolls independently');
    assert.ok(view.render.bottom<view.preview.top&&view.snapshot.left>view.assets.right,'Export is global and capture is local to the player');
    await screenshot(`studio-${width}x${height}`);
    console.log(JSON.stringify(view));
  }
  for(const [width,height] of [[900,650],[590,660]]) {
    window.setContentSize(width,height);await frames();
    const view=await inspect();
    assert.ok(view.scrollHeight>height&&view.scrollWidth<=width+1,'Narrow workspace remains vertically scrollable');
    assert.ok(view.inspector.width>0&&view.timeline.width>0,'Inspector and timeline remain available');
    await evalPage('el("timeline-fit").scrollIntoView({block:"center"});el("timeline-fit").focus()');await frames();
    assert.ok(await evalPage(`(() => {
      const button=el('timeline-fit'),r=button.getBoundingClientRect();
      return button===document.activeElement&&button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));
    })()`),'Timeline tools remain keyboard reachable');
    await screenshot(`studio-${width}x${height}`);
  }
  console.log(`Studio workspace verified. Screenshots: ${artifacts}`);
}).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{
  window?.destroy();server?.closeAllConnections();server?.close();app.exit(process.exitCode||0);
});
