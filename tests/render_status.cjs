const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const html=fs.readFileSync(path.join(__dirname,'../templates/index.html'),'utf8');
const code=html.slice(html.indexOf('    function updateRenderProgress'),html.indexOf('    // MANUAL EDITOR'));

function fixture({failure=null,percent=38,saved=false}={}){
  const nodes=new Map(),messages=[];
  const el=id=>{if(!nodes.has(id)){const attributes={},bar={style:{}},label={},percentage={};nodes.set(id,{attributes,bar,label,percentage,dataset:{},classList:{remove(){},add(){}},setAttribute:(key,value)=>attributes[key]=value,getAttribute:key=>attributes[key],querySelector:key=>key==='.h-full'?bar:key==='p'?percentage:label})}return nodes.get(id)};
  const context=vm.createContext({el,buildRenderForm:()=>({}),fetch:async()=>{if(failure==='start')return{ok:false,json:async()=>({detail:'Disk dolu'})};return{ok:true,json:async()=>({job_id:'render'})}},events:async(id,handle)=>{handle({type:'progress',percent,message:'Video işleniyor'});if(failure==='stream')throw new Error('Bağlantı kesildi');return{download_url:'/download/movie.mp4'}},log:(...args)=>messages.push(args),saveCompletedOutput:async()=>({saved})});
  vm.runInContext(code,context);return{context,nodes,el,messages};
}

test('render progress clamps invalid values and exposes readable state',()=>{
  const {context,el}=fixture();context.updateRenderProgress('progress',145,'Hazır','complete');
  const node=el('progress');assert.equal(node.bar.style.width,'100%');assert.equal(node.percentage.textContent,'100%');assert.equal(node.attributes['aria-valuenow'],'100');assert.equal(node.label.textContent,'Hazır');
  context.updateRenderProgress('progress',NaN,'Başlıyor');assert.equal(node.attributes['aria-valuenow'],'0');assert.equal(node.dataset.state,'running');
});
test('successful render explicitly reaches 100 percent after the result event',async()=>{
  const {context,el}=fixture({saved:true});await context.render('video',[],'mp4','progress','download','manual-log');
  const node=el('progress');assert.equal(node.attributes['aria-valuenow'],'100');assert.equal(node.dataset.state,'complete');assert.equal(node.label.textContent,'Dosya kaydedildi');
});
test('a canceled native save does not falsely claim the file was saved',async()=>{
  const {context,el}=fixture();await context.render('video',[],'mp4','progress','download','manual-log');assert.equal(el('progress').label.textContent,'Çıktı hazır');
});
test('start and stream failures preserve progress and expose the terminal action',async()=>{
  for(const failure of ['start','stream']){const {context,el}=fixture({failure});await assert.rejects(context.render('video',[],'mp4','progress','download','manual-log'));assert.equal(el('progress').dataset.state,'error');assert.match(el('progress').label.textContent,/Terminali açın/);assert.equal(el('progress').attributes['aria-valuenow'],failure==='start'?'0':'38')}
});
