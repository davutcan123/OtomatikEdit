const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const html=fs.readFileSync(path.join(__dirname,'../templates/index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const line=marker=>{const result=script.split('\n').find(value=>value.includes(marker));assert.ok(result,'Function marker '+marker);return result};
const between=(first,next)=>{const start=script.indexOf(first),end=script.indexOf(next,start+first.length);assert.ok(start>=0&&end>start,'Source markers '+first+'/'+next);return script.slice(start,end)};
const plain=value=>JSON.parse(JSON.stringify(value));

function fixture(){
  const nodes=new Map();let counter=0,saves=0;
  const c=vm.createContext({S:{clips:[],texts:[],stickers:[],imageLayers:[],audioLayers:[],transitions:[],mediaAssets:[],history:[],selected:-1,preview:-1,
    selectedLayer:null,selectedText:null,selectedSticker:null,nextZoomKeyframeId:1,trackState:{video:{locked:false,visible:true,muted:false}},
    videoTracks:[{id:1,name:'Video 1',locked:false,visible:true,muted:false}],activeVideoTrack:1,canvas:{width:1920,height:1080},zoom:14},
    document:{querySelector:()=>null},window:{},
    el:id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',removeAttribute(){},load(){},classList:{add(){},remove(){}}});return nodes.get(id)},
    crypto:{randomUUID:()=>String(++counter)},normalizeZoomEasing:value=>value||'linear',
    clampClipTransitions(){},copyTransitions:items=>plain(items),hydrateImageLayer:item=>item,
    resetLiveTransition(){},stopProjectAudio(){},pausePreview(){},isPreviewPlaying:()=>false,
    setupThumbnailSource(){},setPreviewSource:(index,time,playing)=>{c.lastPreview={index,time,playing}},
    updateCanvas(){},updateZoomLabel(){},drawMagnetButton(){},drawClips(){},showTextProperties(){},drawProjectLibrary(){},
    restoreAssetSources(){},undoProjectAssetRemoval:()=>false,scheduleAutosave:()=>saves++,seekOutputTime:time=>{c.seeked=time},log(){},ft:String,
    currentOutputTime:()=>c.outputTime,outputTime:0,
    normalizedZoomKeyframes:clip=>clip.zoomKeyframes||[],zoomStateAtRelativeTime:()=>({scale:125,x:50,y:50,opacity:85,easing:'linear'})});
  vm.runInContext([
    line('const defaultTrackState='),
    between('    const clipSettings=','    const imageLayerSettings='),
    line('const copyLayers='),line('const copyTrackState='),
    between('    const clipOutputDuration=','    function isPreviewPlaying'),
    line('function ensureClipTimelinePositions('),line('const clipTimelineStart='),line('const clipTimelineEnd='),line('const outDuration='),
    between('    function newClipId()','    function resolveClipTransitions('),
    line('function emptyTimelineState('),line('function captureTimelineState('),line('function applyTimelineState('),line('function remember(){'),line('function undoEdit(){'),
    between('    function timelineTrimBounds(', '    function paintTimedClipTiming('),
    between('    function splitVideoTarget','    function splitAudioLayer'),
  ].join('\n'),c);
  return{c,saves:()=>saves};
}

test('clicking a video channel label clears stale selection and targets its clip for the cut shortcut',()=>{
  const{c}=fixture(),labels=new Map();
  for(const id of [1,2]){const title={append(node){this.close=node}};labels.set(id,{querySelector:()=>title,querySelectorAll:()=>[],classList:{toggle(){}}})}
  c.document.createElement=()=>({setAttribute(){}});
  c.el=()=>labels.get(1);c.document.querySelector=()=>labels.get(2);
  c.S.clips=[{clipId:'a',videoTrack:1,start:0,end:4,timelineStart:0},{clipId:'b',videoTrack:2,start:0,end:4,timelineStart:0}];
  c.S.selected=0;c.S.selectedText='stale-text';c.outputTime=2;
  vm.runInContext(line('function drawVideoTrackLabels(){'),c);c.drawVideoTrackLabels();
  labels.get(2).querySelector().onclick();
  assert.equal(c.S.activeVideoTrack,2);assert.equal(c.S.selected,1);assert.equal(c.S.selectedText,null);assert.equal(c.splitVideoTarget(2).clip.clipId,'b');
  c.outputTime=8;labels.get(1).querySelector().onclick();assert.equal(c.S.selected,-1);assert.equal(c.S.activeVideoTrack,1);
});

test('channel deletion protects the base/locked lanes, confirms content and supports undo without removing media',()=>{
  const{c}=fixture();c.hideContextMenu=()=>{};c.confirm=()=>false;
  c.S.videoTracks.push({id:2,name:'Video 2',locked:false,visible:true,muted:false},{id:4,name:'Video 4',locked:false,visible:true,muted:false});
  c.S.clips=[{clipId:'a',videoTrack:1,start:0,end:4,timelineStart:0},{clipId:'b',videoTrack:2,start:0,end:4,timelineStart:0}];
  c.S.transitions=[{leftClipId:'b',rightClipId:'b',type:'fade'}];c.S.mediaAssets=[{id:'source'}];
  c.S.selectedVideoClipIds=['b'];c.S.selected=1;c.S.activeVideoTrack=2;
  c.ensureVideoTracks();
  const before=plain(c.S);assert.equal(c.removeVideoTrack(1),false);assert.equal(c.removeVideoTrack(2),false);assert.deepEqual(plain(c.S),before);
  c.S.videoTracks[1].locked=true;c.confirm=()=>{throw Error('Locked deletion must not prompt')};assert.equal(c.removeVideoTrack(2),false);c.S.videoTracks[1].locked=false;
  c.confirm=()=>true;assert.equal(c.removeVideoTrack(2),true);
  assert.deepEqual(plain(c.S.videoTracks.map(t=>t.id)),[1,4]);assert.deepEqual(plain(c.S.clips.map(t=>t.clipId)),['a']);assert.equal(c.S.transitions.length,0);
  assert.equal(c.S.mediaAssets.length,1);assert.equal(c.S.history.length,1);assert.equal(c.S.selected,-1);
  c.undoEdit();assert.deepEqual(plain(c.S.videoTracks.map(t=>t.id)),[1,2,4]);assert.equal(c.S.clips.length,2);assert.equal(c.S.transitions.length,1);
  c.confirm=()=>{throw Error('Empty lane needs no confirmation')};assert.equal(c.removeVideoTrack(4),true);assert.deepEqual(plain(c.S.videoTracks.map(t=>t.id)),[1,2]);
});

test('legacy migration maintains a separate sequential cursor per video track and honors explicit gaps',()=>{
  const{c}=fixture();
  c.S.clips=[{clipId:'a',start:0,end:4},{clipId:'b',videoTrack:2,start:10,end:14,speed:2},{clipId:'c',start:4,end:7,timelineStart:null},
    {clipId:'d',videoTrack:2,start:14,end:18,speed:2,timelineStart:''},{clipId:'e',videoTrack:2,start:0,end:1,timelineStart:9},{clipId:'f',videoTrack:2,start:1,end:3}];
  c.ensureClipTimelinePositions();
  assert.deepEqual(c.S.clips.map(clip=>clip.timelineStart),[0,0,4,2,9,10]);
  assert.deepEqual(c.S.clips.map(clip=>clip.videoTrack),[1,2,1,2,2,2]);
  const before=plain(c.S.clips);c.ensureClipTimelinePositions();assert.deepEqual(plain(c.S.clips),before);
});

test('missing track metadata migrates legacy flags and referenced sparse IDs without renumbering',()=>{
  const{c}=fixture();c.S.videoTracks=[];c.S.trackState.video={locked:true,visible:false,muted:true};
  c.S.clips=[{start:0,end:4},{videoTrack:7,start:1,end:3}];c.S.activeVideoTrack=99;
  c.ensureVideoTracks();
  assert.deepEqual(plain(c.S.videoTracks),[{id:1,name:'Video 1',locked:true,visible:false,muted:true},{id:7,name:'Video 7',locked:false,visible:true,muted:false}]);
  assert.equal(c.S.activeVideoTrack,1);assert.equal(c.isVideoTrackLocked(c.S.clips[0]),true);assert.equal(c.isVideoTrackLocked(7),false);
  const newTrack=c.addVideoTrack({remember:false,redraw:false});assert.equal(newTrack.id,8);
});

test('named timeline capture and apply preserve sparse lane IDs, active lane, flags and independent data',()=>{
  const{c}=fixture();
  const raw={manualId:'movie',selected:0,preview:0,activeVideoTrack:5,videoTracks:[{id:1,name:'Main',locked:false,visible:true,muted:false},{id:5,name:'Overlay',locked:true,visible:false,muted:true}],
    clips:[{clipId:'main',videoTrack:1,start:0,end:4,timelineStart:0},{clipId:'overlay',videoTrack:5,start:2,end:6,timelineStart:1,crop:{x:.2,y:.1,width:.5,height:.7}}]};
  c.applyTimelineState(raw);
  const captured=c.captureTimelineState(),roundtrip=plain(captured);
  captured.videoTracks[1].name='Changed copy';captured.clips[1].crop.x=.3;
  assert.equal(c.S.videoTracks[1].name,'Overlay');assert.equal(c.S.clips[1].crop.x,.2);assert.equal(raw.clips[1].crop.x,.2);
  c.applyTimelineState(roundtrip);
  assert.equal(c.S.activeVideoTrack,5);assert.deepEqual(plain(c.S.videoTracks.map(t=>t.id)),[1,5]);assert.equal(c.S.videoTracks[1].muted,true);assert.equal(c.S.videoTracks[1].locked,true);
  assert.deepEqual(plain(c.S.clips.map(clip=>clip.videoTrack)),[1,5]);
});

test('undo restores channel creation, assignment, flags and deep-copied crop/keyframe/brush settings',()=>{
  const{c}=fixture();c.S.clips=[{clipId:'c',videoTrack:1,start:0,end:4,timelineStart:0,crop:{x:.1,y:0,width:.9,height:1},zoomKeyframes:[{id:'k',time:0,scale:100}],brushStrokes:[{points:[{x:.1,y:.2}]}]}];
  c.S.selected=0;c.remember();c.addVideoTrack({remember:false,redraw:false});
  c.S.clips[0].videoTrack=2;c.S.clips[0].crop.x=.3;c.S.clips[0].zoomKeyframes[0].scale=200;c.S.clips[0].brushStrokes[0].points[0].x=.7;c.S.videoTracks[0].muted=true;
  c.undoEdit();
  assert.equal(c.S.videoTracks.length,1);assert.equal(c.S.activeVideoTrack,1);assert.equal(c.S.videoTracks[0].muted,false);assert.equal(c.S.clips[0].videoTrack,1);
  assert.equal(c.S.clips[0].crop.x,.1);assert.equal(c.S.clips[0].zoomKeyframes[0].scale,100);assert.equal(c.S.clips[0].brushStrokes[0].points[0].x,.1);
});

test('next clip on a channel ignores interleaved array items and returns the original global index',()=>{
  const{c}=fixture();c.S.clips=[{clipId:'a',videoTrack:1,timelineStart:0},{clipId:'b',videoTrack:2,timelineStart:0},{clipId:'c',videoTrack:2,timelineStart:2},
    {clipId:'d',videoTrack:1,timelineStart:8},{clipId:'e',videoTrack:1,timelineStart:4}];
  assert.equal(c.nextClipOnTrack(0).item.clipId,'e');assert.equal(c.nextClipOnTrack(0).index,4);
  assert.equal(c.nextClipOnTrack(1).item.clipId,'c');assert.equal(c.nextClipOnTrack(4).item.clipId,'d');assert.equal(c.nextClipOnTrack(3),null);
});

test('timeline duration uses maximum end of every video channel and every timed layer, including no-video projects',()=>{
  const{c}=fixture();c.S.clips=[{start:0,end:4,timelineStart:0,videoTrack:1},{start:1,end:5,speed:2,timelineStart:10,videoTrack:3}];
  assert.equal(vm.runInContext('outDuration()',c),12);
  for(const[array,end]of [['texts',15],['stickers',20],['imageLayers',25],['audioLayers',30]]){c.S[array].push({end});assert.equal(vm.runInContext('outDuration()',c),end)}
  c.S.clips=[];assert.equal(vm.runInContext('outDuration()',c),30);
});

test('last visual layers may extend beyond current project duration but audio remains source-bounded',()=>{
  const{c}=fixture();c.S.clips=[{start:0,end:5,timelineStart:0}];
  for(const type of ['text','subtitle','image','sticker']){
    const item={start:2,end:5};assert.equal(c.timelineTrimBounds(type,item,item).maximum,Infinity);
  }
  const audio={start:2,end:5,sourceStart:1,sourceDuration:8};
  assert.equal(c.timelineTrimBounds('audio',audio,audio).maximum,9);
});

test('reverse trim extension consumes the opposite source handles without crossing lane neighbors',()=>{
  const{c}=fixture(),clip={start:2,end:10,sourceDuration:14,reverse:true,speed:2,timelineStart:5,videoTrack:2};
  c.S.clips=[clip,{start:0,end:2,timelineStart:0,videoTrack:2},{start:0,end:2,timelineStart:9.5,videoTrack:2},{start:0,end:20,timelineStart:0,videoTrack:1}];
  const bounds=c.timelineTrimBounds('video',clip,clip);
  assert.equal(bounds.minimum,3);assert.equal(bounds.maximum,9.5);
});

test('cut targets selected containing clip first, otherwise active lane, never an unrelated occupied lane',()=>{
  const{c}=fixture();c.S.clips=[{clipId:'a',start:0,end:5,timelineStart:0,videoTrack:1},{clipId:'b',start:10,end:20,speed:2,timelineStart:0,videoTrack:2},
    {clipId:'later',start:0,end:3,timelineStart:8,videoTrack:3}];
  c.S.selected=0;c.S.activeVideoTrack=2;assert.equal(c.splitVideoTarget(2).clip.clipId,'a');
  c.S.selected=2;assert.equal(c.splitVideoTarget(2).clip.clipId,'b');assert.equal(c.splitVideoTarget(2).sourceTime,14);
  c.S.activeVideoTrack=3;assert.equal(c.splitVideoTarget(2),null);
  delete c.S.activeVideoTrack;assert.equal(c.splitVideoTarget(2).clip.clipId,'a','Legacy fixtures without lane state keep old global targeting');
});

test('cut checks the actual target lane lock, not a stale selection outside the cursor',()=>{
  const{c}=fixture();c.S.clips=[{clipId:'stale',start:0,end:2,timelineStart:8,videoTrack:1},{clipId:'target',start:0,end:6,timelineStart:0,videoTrack:2}];
  c.S.videoTracks=[{id:1,name:'Locked unrelated',locked:true,visible:true,muted:false},{id:2,name:'Target',locked:false,visible:true,muted:false}];
  c.S.selected=0;c.S.activeVideoTrack=2;c.outputTime=2;c.splitClip();
  assert.equal(c.S.clips.length,3);assert.equal(c.S.clips[0].clipId,'stale');assert.equal(c.S.clips[1].end,2);
  c.undoEdit();c.S.videoTracks[0].locked=false;c.S.videoTracks[1].locked=true;c.S.selected=0;c.outputTime=2;c.splitClip();assert.equal(c.S.clips.length,2);
});

test('reverse cut retains source-half order, speed, output continuity, keyframes and outgoing transition ownership',()=>{
  const{c}=fixture();
  c.S.clips=[{clipId:'reverse',videoTrack:2,start:2,end:10,speed:2,reverse:true,timelineStart:5,effect:'neon',crop:{x:.1,y:0,width:.8,height:1},
    zoomKeyframes:[{id:'z0',time:0,scale:100},{id:'z1',time:1,scale:120},{id:'z3',time:3,scale:150}]}];
  c.S.transitions=[{leftClipId:'reverse',rightClipId:'next',type:'fade'}];c.S.selected=0;c.S.activeVideoTrack=2;c.outputTime=6.5;
  assert.equal(c.splitVideoTarget(6.5).sourceTime,7);c.splitClip();const[left,right]=c.S.clips;
  assert.deepEqual([left.start,left.end,left.timelineStart,right.start,right.end,right.timelineStart],[7,10,5,2,7,6.5]);
  assert.equal(vm.runInContext('clipTimelineEnd(S.clips[1])',c),9);assert.equal(left.videoTrack,2);assert.equal(right.videoTrack,2);assert.equal(left.reverse,true);assert.equal(right.reverse,true);
  assert.equal(right.effect,'neon');assert.deepEqual(plain(right.crop),{x:.1,y:0,width:.8,height:1});assert.notEqual(left.clipId,right.clipId);
  assert.deepEqual(left.zoomKeyframes.map(k=>k.time),[0,1,1.5]);assert.deepEqual(right.zoomKeyframes.map(k=>k.time),[0,1.5]);
  assert.equal(c.S.transitions[0].leftClipId,right.clipId);assert.equal(c.lastPreview.time,7);
});
