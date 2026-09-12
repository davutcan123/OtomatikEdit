const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../templates/index.html'),'utf8');
const line=marker=>{const source=html.split('\n').find(value=>value.includes(marker));assert.ok(source,marker);return source;};
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const nodes=new Map(),history=[];let draws=0,saves=0;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{style:{},scrollTop:300,scrollLeft:170,clientHeight:220});return nodes.get(id)};
  const c=vm.createContext({S:{videoTracks:[{id:1},{id:5}],activeVideoTrack:1,clips:[{clipId:'A',videoTrack:1,start:3,end:7}],selected:0,preview:0,selectedVideoClipIds:['A'],selectedText:'T',selectedSticker:'S',selectedLayer:{type:'image',id:'I'},selectedZoomKeyframe:'Z',selectedTextKeyframe:'TZ',selectedImageKeyframe:'IZ',zoom:30,timelineCursor:9,trackState:{video:{}}},
    el:node,document:{querySelector:selector=>node(selector)},ensureVideoTracks:()=>c.S.videoTracks,currentOutputTime:()=>9,pausePreview(){},
    remember:()=>history.push(plain(c.S)),drawClips(){draws++;c.layoutVideoTracks(220,104,600)},seekOutputTime:time=>{c.lastSeek=time},scheduleAutosave:()=>saves++,log(){}});
  vm.runInContext([line('function addVideoTrack('),line('function layoutVideoTracks('),line('function scrollVideoTrackIntoView(')].join('\n'),c);
  return{c,nodes,node,history,draws:()=>draws,saves:()=>saves};
}
test('explicit channel creation focuses the new upper empty lane and keeps cursor, horizontal scroll and sources',()=>{
  const{c,node,history,draws,saves}=fixture(),before=plain(c.S.clips);const created=c.addVideoTrack();
  assert.equal(created.id,6);assert.equal(c.S.activeVideoTrack,6);assert.equal(c.S.selected,-1);assert.equal(c.S.preview,0);
  assert.deepEqual(plain(c.S.selectedVideoClipIds),[]);for(const key of ['selectedText','selectedSticker','selectedLayer','selectedZoomKeyframe','selectedTextKeyframe','selectedImageKeyframe'])assert.equal(c.S[key],null,key);
  assert.deepEqual(plain(c.S.clips),before);assert.equal(c.S.timelineCursor,9);assert.equal(c.lastSeek,9);assert.equal(c.S.zoom,30);
  assert.deepEqual(plain(c.S.videoTracks.map(track=>track.id)),[1,5,6]);assert.ok(c.S.videoLaneTops[6]<c.S.videoLaneTops[5]&&c.S.videoLaneTops[5]<c.S.videoLaneTops[1]);
  assert.equal(node('timeline').scrollTop,176);assert.equal(node('timeline').scrollLeft,170);assert.equal(draws(),1);assert.equal(saves(),1);
  assert.equal(history.length,1);assert.equal(history[0].selected,0);assert.equal(history[0].videoTracks.length,2);
});
test('internal collision channel creation does not clear selection, redraw or move the viewport',()=>{
  const{c,node,history,draws}=fixture(),before=plain(c.S);c.addVideoTrack({remember:false,redraw:false});
  assert.equal(c.S.activeVideoTrack,6);assert.equal(c.S.selected,before.selected);assert.deepEqual(plain(c.S.selectedVideoClipIds),before.selectedVideoClipIds);
  assert.deepEqual(plain(c.S.selectedLayer),before.selectedLayer);assert.equal(node('timeline').scrollTop,300);assert.equal(node('timeline').scrollLeft,170);
  assert.equal(history.length,0);assert.equal(draws(),0);
});
test('layout reverses only visual slots, retaining sparse channel IDs and the serialized stacking order',()=>{
  const{c,node}=fixture(),original=c.S.videoTracks;const end=c.layoutVideoTracks(44,104,1500);
  assert.equal(c.S.videoTracks,original);assert.deepEqual(plain(c.S.videoTracks.map(track=>track.id)),[1,5]);
  assert.deepEqual(plain(c.S.videoLaneTops),{1:156,5:44});assert.equal(node('video-track-5').style.top,'0px');assert.equal(node('video-track-1').style.top,'112px');
  assert.equal(end,268);assert.equal(node('track').style.height,'216px');
});
test('ruler and cap are vertically sticky without a horizontally pinned timeline origin',()=>{
  const css=fs.readFileSync(path.join(__dirname,'../static/workspace.css'),'utf8');
  assert.match(css,/#timeline\{scroll-padding-top:44px\}/);
  assert.match(css,/#timeline-ruler\{[^}]*position:sticky;top:0;left:auto;right:auto;[^}]*margin-left:132px/);
  assert.match(css,/#playhead-cap\{[^}]*position:sticky;top:8px/);assert.ok(html.includes('id="playhead-cap"'));
  assert.match(line('function timelineTimeAtClientX('),/getBoundingClientRect\(\)\.left-TIMELINE_GUTTER/);
});
