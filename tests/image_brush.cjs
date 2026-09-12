const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const html=fs.readFileSync(path.join(__dirname,'../templates/index.html'),'utf8');
const between=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
function fixture(painting=false){
  const calls=[],item={id:'image',backgroundMode:'brush',brushApplied:true,brushMode:'keep',brushStrokes:[{size:30,points:[{x:.5,y:.5}]}]},rect={left:0,top:0,width:640,height:360};
  const ctx={save(){},restore(){},setTransform(){},clearRect(){calls.push('clear')},translate(){},fillRect(){calls.push('fill')},globalCompositeOperation:'source-over'};
  const nodes=new Map(),node=()=>({width:640,height:360,textContent:'',hidden:false,className:'',getContext:()=>ctx,getBoundingClientRect:()=>rect,setAttribute(){},classList:{toggle(){}}});
  for(const name of ['preview-stage','brush-canvas','brush-stage-toolbar','brush-stage-toggle','brush-stage-mode','brush-stage-paint','brush-stage-erase','image-brush-paint','image-brush-erase'])nodes.set(name,node());
  const c=vm.createContext({S:{brushPainting:painting},el:id=>nodes.get(id),window:{devicePixelRatio:1},activeBrushTarget:()=>({kind:'image',item}),brushTargetRect:()=>rect,isTrackLocked:()=>false,isVideoTrackLocked:()=>false,drawBrushStroke:(context,stroke)=>calls.push(stroke.operation||'paint'),WeakMap});
  const helper=between('    function brushTool(', '    function activeBrushTarget(');if(helper)vm.runInContext(helper,c);
  vm.runInContext(between('    function drawBrushCanvas(){','    function brushPoint('),c);return{c,item,calls,nodes,ctx};
}
test('applying an image mask never leaves colored guide pixels outside explicit brush-edit mode',()=>{
  const{c,item,calls}=fixture(false),saved=JSON.stringify(item);c.drawBrushCanvas();assert.deepEqual(calls,['clear']);assert.equal(JSON.stringify(item),saved,'Hiding guides must not delete or disable the applied mask');
});
test('explicit re-edit mode draws guides again without changing saved mask settings',()=>{
  const{c,item,calls}=fixture(true),saved=JSON.stringify(item);c.drawBrushCanvas();assert.ok(calls.includes('paint'));assert.equal(JSON.stringify(item),saved);
});
test('ordered eraser strokes subtract the selection and later paint restores it in both mask modes',()=>{
  for(const invert of [false,true]){
    const{c}=fixture(),values=[0,0,0,0],operations=[],ctx={globalCompositeOperation:'source-over',save(){},restore(){},fillRect(){values.fill(1)}};
    c.drawBrushStroke=(context,stroke)=>{operations.push(context.globalCompositeOperation);for(const point of stroke.points)values[point.x]=context.globalCompositeOperation==='destination-out'?0:1};
    c.paintBrushSelection(ctx,{brushStrokes:[{points:[{x:0},{x:1},{x:2}]},{operation:'erase',points:[{x:1},{x:2}]},{operation:'paint',points:[{x:2}]}]},4,1,'white',invert);
    assert.deepEqual(values,invert?[0,1,0,1]:[1,0,1,0]);assert.deepEqual(operations,invert?['destination-out','source-over','destination-out']:['source-over','destination-out','source-over']);
  }
});
test('eraser clears translucent guide coverage completely rather than leaving a half-opacity brush mark',()=>{
  const{c}=fixture(),calls=[],ctx={globalCompositeOperation:'source-over',save(){},restore(){}};c.drawBrushStroke=(context,stroke,width,height,color)=>calls.push({operation:context.globalCompositeOperation,color});
  c.paintBrushSelection(ctx,{brushStrokes:[{points:[{x:.5,y:.5}]},{operation:'erase',points:[{x:.5,y:.5}]}]},640,360,'rgba(52,211,153,.52)');
  assert.deepEqual(calls,[{operation:'source-over',color:'rgba(52,211,153,.52)'},{operation:'destination-out',color:'white'}]);
});
test('brush capacity refuses extra strokes or points before adding a silently truncated edit',()=>{
  const{c}=fixture();assert.equal(c.brushStrokeCapacity({brushStrokes:[]}),true);assert.equal(c.brushStrokeCapacity({brushStrokes:Array.from({length:39},()=>({points:[{}]}))}),true);assert.equal(c.brushStrokeCapacity({brushStrokes:Array.from({length:40},()=>({points:[{}]}))}),false);assert.equal(c.brushStrokeCapacity({brushStrokes:[{points:Array(180).fill({})}]}),false);
});
test('eraser choice is per-image ephemeral state, respects track locks, and does not mutate persisted layers',()=>{
  const{c,item}=fixture(),other={id:'other'},before=JSON.stringify(item);let target={kind:'image',item};c.activeBrushTarget=()=>target;c.pausePreview=()=>{};c.drawBrushCanvas=()=>{};
  c.setBrushTool('erase');assert.equal(c.brushTool(item),'erase');assert.equal(c.brushTool(other),'paint');assert.equal(JSON.stringify(item),before);target={kind:'image',item:other};c.isTrackLocked=()=>true;c.setBrushTool('erase');assert.equal(c.brushTool(other),'paint');
});
test('reapply after undo replaces the previous image-load callback so an old item cannot clear the new mask',()=>{
  const image={complete:true,naturalWidth:400,style:{},dataset:{}},c=vm.createContext({hydrateImageLayer(){},buildBrushMaskUrl:()=>'/mask-current.png',console});
  vm.runInContext(between('    function applyImageBackgroundPreview(', '    function brushTargetRect('),c);
  image.complete=false;c.applyImageBackgroundPreview({backgroundMode:'brush',brushApplied:false},image);
  image.complete=true;c.applyImageBackgroundPreview({backgroundMode:'brush',brushApplied:true},image);assert.ok(image.style.maskImage.includes('/mask-current.png'));image.onload();assert.ok(image.style.maskImage.includes('/mask-current.png'),'Queued source load must use current applied state, not the old undone item');
});
test('the shared video brush toolbar can switch from eraser back to paint and preserves lock protection',()=>{
  const{c,item}=fixture();c.activeBrushTarget=()=>({kind:'video',item});c.pausePreview=()=>{};c.drawBrushCanvas=()=>{};c.setBrushTool('erase');assert.equal(c.brushTool(item),'erase');c.setBrushTool('paint');assert.equal(c.brushTool(item),'paint');c.isVideoTrackLocked=()=>true;c.setBrushTool('erase');assert.equal(c.brushTool(item),'paint');assert.match(html,/id="brush-stage-paint"/);assert.match(html,/el\('brush-stage-paint'\)\.onclick=\(\)=>setBrushTool\('paint'\)/);
});
