const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../static/timeline_tools.js'),'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const nodes = new Map();let id = 0, remembers = 0, saves = 0, dialog = false;
  const node = name => {
    if (!nodes.has(name)) nodes.set(name, {style:{},value:'',addEventListener() {},
      classList:{contains:state => name === 'manual' ? state === 'active' : state === 'hidden',add(){}},
      close(){this.closed=true;}, getBoundingClientRect:() => ({width:800,height:450})});
    return nodes.get(name);
  };
  const context = vm.createContext({
    S:{timelines:[{id:'TL1'}],activeTimelineId:'TL1',clips:[],texts:[],stickers:[],imageLayers:[],audioLayers:[],selected:-1,
      selectedLayer:null,selectedText:null,selectedSticker:null,trackState:{},videoTracks:[{id:1,name:'Video 1',locked:false}],activeVideoTrack:1,manualId:'sourceA',manualName:'Original.mov'},
    el:node, document:{querySelector:()=>dialog,addEventListener(){},activeElement:null},
    window:{addEventListener(){},removeEventListener(){}}, ResizeObserver:class {observe(){}},
    crypto:{randomUUID:()=>'uuid'+(++id)}, newClipId:()=>'C'+(++id),
    currentOutputTime:()=>context.time, time:8, pausePreview(){},
    remember:()=>remembers++, scheduleAutosave:()=>saves++,
    ensureVideoTracks(){},videoTrackState:track=>context.S.videoTracks.find(item=>item.id===track),
    addVideoTrack(options){assert.deepEqual(plain(options),{remember:false,redraw:false});const track={id:context.S.videoTracks.length+1,name:'Video '+(context.S.videoTracks.length+1),locked:false};context.S.videoTracks.push(track);return track;},
    isTrackLocked:type=>!!context.S.trackState[type]?.locked,
    hydrateClip:item=>item,hydrateImageLayer:item=>item,hydrateText:item=>item,
    clipOutputDuration:item=>(item.end-item.start)/(item.speed||1),clipTimelineStart:item=>item.timelineStart||0,
    clipTimelineEnd:item=>(item.timelineStart||0)+(item.end-item.start)/(item.speed||1),
    clampClipTransitions(){},resetLiveTransition(){},drawClips(){},showTextProperties(){},applyVideoEffectPreview(){},
    setPreviewSource(index,time){context.preview={index,time};},seekOutputTime:time=>{context.seeked=time;},log(){},ft:time=>time.toFixed(2),
    desktopUpdateFrozen:false,desktopClosing:false,JSON,Math,Number,Date,setTimeout,clearTimeout,
  });
  vm.runInContext(source,context);
  return {context,nodes,node,remembers:()=>remembers,saves:()=>saves,setDialog:value=>{dialog=value;}};
}

test('video clipboard preserves independent nested settings/source offsets and fresh clip/keyframe identities',()=>{
  const {context:c,remembers,saves}=fixture();
  const original={clipId:'original',start:2,end:12,speed:2,timelineStart:0,videoTrack:1,opacity:70,crop:{x:.2,y:.1,width:.5,height:.8},zoomKeyframes:[{id:'Z1',time:2,scale:150}],brushStrokes:[{points:[{x:.2,y:.4}]}]};
  c.S.clips=[original];c.S.selected=0;
  assert.equal(c.timelineCopySelection(),true);
  original.opacity=10;
  const pasted=c.timelinePasteClipboard();
  assert.equal(pasted.timelineStart,8);assert.equal(pasted.start,2);assert.equal(pasted.end,12);assert.equal(pasted.speed,2);
  assert.equal(pasted.fileId,'sourceA');assert.equal(pasted.src,'/video/sourceA');assert.equal(pasted.opacity,70);
  assert.notEqual(pasted.clipId,original.clipId);assert.notEqual(pasted.zoomKeyframes[0].id,'Z1');
  pasted.crop.x=.4;pasted.zoomKeyframes[0].scale=250;pasted.brushStrokes[0].points[0].x=.8;
  assert.equal(original.crop.x,.2);assert.equal(original.zoomKeyframes[0].scale,150);assert.equal(original.brushStrokes[0].points[0].x,.2);
  assert.equal(remembers(),1);assert.equal(saves(),1);
});

test('copy spans project timelines at exact cursor and adds a free video channel instead of moving existing clips',()=>{
  const {context:c,remembers}=fixture();
  c.S.clips=[{clipId:'A',start:1,end:6,timelineStart:0,videoTrack:1,fileId:'sourceA'}];c.S.selected=0;c.timelineCopySelection();
  const existing={clipId:'B',start:0,end:20,timelineStart:0,videoTrack:1,fileId:'sourceB'};
  c.S.activeTimelineId='TL2';c.S.manualId='sourceB';c.S.clips=[existing];c.time=3.25;
  const item=c.timelinePasteClipboard();
  assert.equal(item.timelineStart,3.25);assert.equal(item.fileId,'sourceA');assert.equal(item.videoTrack,2);
  assert.equal(existing.timelineStart,0);assert.equal(existing.end,20);assert.equal(remembers(),1);assert.equal(c.S.activeVideoTrack,2);
});

test('all timed layer kinds paste with original duration/styles/relative keyframes and fresh independent identities',()=>{
  for(const type of ['image','audio','text','subtitle','sticker']) {
    const {context:c}=fixture(),array=type==='image'?'imageLayers':type==='audio'?'audioLayers':type==='sticker'?'stickers':'texts';
    const item={id:'same',kind:type,start:2,end:7,sourceStart:4,sourceDuration:20,fileId:'asset',style:'neon',preset:'heart',text:'Konuşma',color:'#ff0000',fontSize:50,
      transformKeyframes:[{id:'frame',time:1,scale:180,x:30,opacity:60}],brushStrokes:[{points:[{x:.1,y:.2}]}]};
    c.S[array]=[item];
    if(type==='image'||type==='audio')c.S.selectedLayer={type,id:item.id};else if(type==='sticker')c.S.selectedSticker=item.id;else c.S.selectedText=item.id;
    assert.equal(c.timelineCopySelection(),true);
    c.S.activeTimelineId='TL2';c.S[array]=[];
    const pasted=c.timelinePasteClipboard();
    assert.equal(pasted.start,8);assert.equal(pasted.end,13);assert.equal(pasted.sourceStart,4);assert.equal(pasted.transformKeyframes[0].time,1);
    assert.equal(pasted.fileId,'asset');assert.equal(pasted.style,'neon');assert.equal(pasted.kind,type);assert.equal(pasted.preset,'heart');
    assert.notEqual(pasted.id,item.id);assert.notEqual(pasted.transformKeyframes[0].id,'frame');
    pasted.transformKeyframes[0].scale=200;assert.equal(item.transformKeyframes[0].scale,180);
    assert.notEqual(c.timelinePasteClipboard().id,pasted.id);
  }
});

test('locked paste and changed project are nonmutating, including no hidden new video channel',()=>{
  const {context:c,remembers}=fixture();c.S.clips=[{clipId:'A',start:0,end:20,timelineStart:0}];c.S.selected=0;c.timelineCopySelection();
  c.S.videoTracks[0].locked=true;assert.equal(c.timelinePasteClipboard(),false);assert.equal(remembers(),0);assert.equal(c.S.videoTracks.length,1);
  c.S.videoTracks[0].locked=false;c.S.timelines=[{id:'differentProject'}];assert.equal(c.timelinePasteClipboard(),false);assert.equal(c.S.clips.length,1);
  c.S.imageLayers=[{id:'I',start:0,end:3}];c.S.selectedLayer={type:'image',id:'I'};c.timelineCopySelection();c.S.trackState.image={locked:true};
  assert.equal(c.timelinePasteClipboard(),false);assert.equal(remembers(),0);
});

test('native text clipboard, open dialogs, IME and update freeze are not intercepted',()=>{
  const {context:c,setDialog}=fixture();c.S.clips=[{clipId:'A',start:0,end:3}];c.S.selected=0;
  let consumed=0;const event={ctrlKey:true,key:'c',preventDefault:()=>consumed++,stopImmediatePropagation(){}};
  for(const focus of [{tagName:'INPUT'},{tagName:'TEXTAREA'},{tagName:'SELECT'},{isContentEditable:true}]){c.document.activeElement=focus;c.timelineClipboardKeydown(event);}
  c.document.activeElement=null;setDialog(true);c.timelineClipboardKeydown(event);setDialog(false);
  c.desktopUpdateFrozen=true;c.timelineClipboardKeydown(event);c.desktopUpdateFrozen=false;
  c.timelineClipboardKeydown({...event,isComposing:true});assert.equal(consumed,0);
  c.timelineClipboardKeydown(event);assert.equal(consumed,1);
  c.timelineClipboardKeydown({...event,key:'v'});assert.equal(consumed,2);assert.equal(c.S.clips.length,2);
});

test('crop normalization remains within source bounds and pixel aspect presets work for portrait sources',()=>{
  const {context:c}=fixture();
  assert.deepEqual(plain(c.normalizedTimelineCrop()),{x:0,y:0,width:1,height:1});
  assert.deepEqual(plain(c.normalizedTimelineCrop({x:.9,y:-1,width:.4,height:3})),{x:.6,y:0,width:.4,height:1});
  const square=c.cropPresetRectangle(1,1080,1920,{x:0,y:0,width:1,height:1});
  assert.equal(square.width,1);assert.equal(square.height,.5625);assert.equal(square.y,.21875);
  const shorts=c.cropPresetRectangle(9/16,1920,1080,{x:0,y:0,width:1,height:1});
  assert.equal(shorts.width,.31640625);assert.equal(shorts.height,1);
});

test('crop source frame follows reverse playback, speed, nonzero source trims and timeline position',()=>{
  const {context:c}=fixture();
  const clip={start:2,end:10,speed:2,timelineStart:5,reverse:true};
  assert.equal(c.timelineCropSourceTime(clip,6),8);
  assert.equal(c.timelineCropSourceTime(clip,4),10);
  assert.equal(c.timelineCropSourceTime(clip,12),2);
  clip.reverse=false;assert.equal(c.timelineCropSourceTime(clip,6),4);
});

test('crop draft/cancel is nonmutating; apply snapshots exactly once and preserves unrelated settings',()=>{
  const {context:c,remembers,saves,node}=fixture();
  c.S.clips=[{clipId:'A',start:0,end:4,effect:'noir',zoomKeyframes:[{id:'Z'}]}];
  vm.runInContext("timelineCropSession={clipId:'A',timelineId:S.activeTimelineId,projectTimelines:S.timelines,ready:true,draft:{x:.2,y:.1,width:.6,height:.7}}",c);
  assert.equal(c.S.clips[0].crop,undefined);c.closeTimelineCrop();assert.equal(remembers(),0);assert.equal(c.S.clips[0].crop,undefined);
  vm.runInContext("timelineCropSession={clipId:'A',timelineId:S.activeTimelineId,projectTimelines:S.timelines,ready:true,draft:{x:.2,y:.1,width:.6,height:.7}}",c);
  assert.deepEqual(plain(c.applyTimelineCrop()),{x:.2,y:.1,width:.6,height:.7});
  assert.equal(remembers(),1);assert.equal(saves(),1);assert.equal(c.S.clips[0].effect,'noir');assert.equal(c.S.clips[0].zoomKeyframes[0].id,'Z');assert.equal(node('timeline-crop-dialog').closed,true);
  c.S.videoTracks[0].locked=true;assert.equal(c.applyTimelineCrop(),false);assert.equal(remembers(),1);
});
