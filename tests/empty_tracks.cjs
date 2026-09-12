const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const html=fs.readFileSync(path.join(__dirname,'../templates/index.html'),'utf8');
const source=html.slice(html.indexOf('    function timelineOptionalCounts()'),html.indexOf('    function drawTexts(){'));
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const listeners=new Map(),box={scrollTop:17,scrollLeft:91,clientHeight:200},nodes=new Map([['timeline',box]]),S={stickers:[],texts:[],imageLayers:[],audioLayers:[],timelineCursor:8,trackState:{image:{locked:true,visible:false},audio:{muted:true}}};
  for(const type of ['sticker','text','subtitle','image','audio'])nodes.set(type+'-track',{style:{top:'44px'},offsetHeight:48});
  let draws=0;
  const context=vm.createContext({S,el:id=>nodes.get(id),drawTexts:()=>draws++,window:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name)}}});
  vm.runInContext(source,context);
  return{c:context,S,box,nodes,listeners,draws:()=>draws};
}
test('empty optional rows consume no height or gaps while every video channel stays allocated',()=>{
  const{c}=fixture();
  for(const compact of [true,false])for(const videoTracks of [1,3,7]){
    const g=c.timelineRowGeometry({compact,videoTracks});
    assert.equal(g.videoTop,44);assert.equal(g.videoHeight,compact?104:176);
    assert.equal(g.timelineHeight,44+videoTracks*(g.videoHeight+8)-8+10);
    for(const row of Object.values(g.rows)){assert.equal(row.visible,false);assert.equal(row.height,0);assert.equal(row.temporary,false)}
  }
});
test('populated hidden, muted or locked tracks remain rows and subtitle content is counted separately',()=>{
  const{c,S}=fixture();S.texts=[{kind:'text'},{},{kind:'subtitle'}];S.imageLayers=[{}];S.audioLayers=[{}];
  assert.deepEqual(plain(c.timelineOptionalCounts()),{sticker:0,text:2,subtitle:1,image:1,audio:1});
  const g=c.timelineRowGeometry({compact:true,counts:c.timelineOptionalCounts(),textLanes:2,subtitleLanes:1,imageKeyframes:true});
  assert.equal(g.rows.sticker.visible,false);assert.equal(g.rows.text.top,44);assert.equal(g.rows.text.height,92);
  assert.equal(g.rows.subtitle.top,140);assert.equal(g.rows.subtitle.height,50);assert.equal(g.rows.image.top,194);assert.equal(g.rows.image.height,86);
  assert.equal(g.videoTop,284);assert.equal(g.rows.audio.top,396);assert.equal(g.timelineHeight,454);
});
test('first-item drag reveals only the matching empty row and cancellation removes it without gaps',()=>{
  const{c}=fixture();for(const type of ['sticker','text','subtitle','image','audio']){
    const during=c.timelineRowGeometry({compact:true,dropTarget:type});
    assert.deepEqual(Object.entries(during.rows).filter(([,row])=>row.visible).map(([key])=>key),[type]);
    assert.equal(during.rows[type].temporary,true);assert.ok(during.rows[type].height>0);
    const after=c.timelineRowGeometry({compact:true,dropTarget:null});assert.equal(after.videoTop,44);assert.equal(after.timelineHeight,158);
  }
});
test('drop target is ephemeral, cancelling restores scroll and never changes project cursor or data',()=>{
  const{c,S,box,nodes,draws}=fixture(),before=plain(S);nodes.get('audio-track').style.top='650px';
  c.setTimelineDropTarget('audio');assert.equal(box.scrollTop,506);assert.equal(box.scrollLeft,91);assert.equal(c.setTimelineDropTarget.type,'audio');
  c.setTimelineDropTarget('audio');assert.equal(draws(),1);c.setTimelineDropTarget(null);
  assert.equal(box.scrollTop,17);assert.equal(box.scrollLeft,91);assert.equal(draws(),2);assert.deepEqual(plain(S),before);
});
test('successful first drop keeps the now-populated row and current scroll position',()=>{
  const{c,S,box,nodes}=fixture();nodes.get('image-track').style.top='300px';c.setTimelineDropTarget('image');S.imageLayers.push({id:'I1'});box.scrollTop=188;c.setTimelineDropTarget(null);
  assert.equal(box.scrollTop,188);assert.equal(c.timelineRowGeometry({counts:c.timelineOptionalCounts()}).rows.image.visible,true);
  S.imageLayers=[];assert.equal(c.timelineRowGeometry({counts:c.timelineOptionalCounts()}).rows.image.visible,false);
});
test('drop geometry remains open through commit and every cancellation path cleans up once',()=>{
  for(const kind of ['pointerup','pointercancel','blur','keydown']){
    const{c,listeners}=fixture(),calls=[];c.setTimelineDropTarget('text');
    c.bindTimelineDropGesture(()=>{},()=>{calls.push('drop');assert.equal(c.setTimelineDropTarget.type,'text')},(_,cancelled)=>calls.push(cancelled?'cancel':'cleanup'));
    const handler=listeners.get(kind);handler({type:kind,key:'Escape',preventDefault(){calls.push('prevent')},stopImmediatePropagation(){calls.push('stop')}});
    assert.equal(c.setTimelineDropTarget.type,null);assert.equal(listeners.size,0);assert.equal(calls.includes('drop'),kind==='pointerup');
    handler({type:kind,key:'Escape',preventDefault(){},stopImmediatePropagation(){}});
    assert.equal(calls.filter(value=>value==='cleanup'||value==='cancel').length,1);
  }
});
test('locked-empty channel recovery is explicit, guarded and undoable without unlocking populated tracks',()=>{
  const{c,S}=fixture();S.trackState.text={locked:true};S.texts=[{text:'Keep locked'}];let remembered,draws=0,saves=0;
  c.remember=()=>remembered=plain(S);c.drawClips=()=>draws++;c.scheduleAutosave=()=>saves++;
  assert.deepEqual(plain(c.lockedEmptyTimelineRows()),['image']);
  assert.equal(c.unlockEmptyTimelineRow('text'),false);assert.equal(c.unlockEmptyTimelineRow('unknown'),false);assert.equal(draws,0);
  assert.equal(c.unlockEmptyTimelineRow('image'),true);assert.equal(remembered.trackState.image.locked,true);assert.equal(S.trackState.image.locked,false);assert.equal(S.trackState.image.visible,false);assert.equal(S.trackState.text.locked,true);assert.equal(draws,1);assert.equal(saves,1);
  assert.deepEqual(plain(c.lockedEmptyTimelineRows()),[]);assert.equal(c.unlockEmptyTimelineRow('image'),false);assert.equal(draws,1);
});
