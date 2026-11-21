const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname,'../templates/index.html'),'utf8');
const manager = fs.readFileSync(path.join(__dirname,'../static/editor_outputs.js'),'utf8');
const transport = html.slice(html.indexOf('    async function render('),html.indexOf('    // MANUAL EDITOR'));

function fixture({failure=null,percent=38,saved=false}={}) {
  const nodes = new Map(), messages = [];
  function makeNode() {
    const attributes = {}, bar = {style:{}}, label = {}, percentage = {};
    const classes = new Set();
    return {
      attributes,bar,label,percentage,dataset:{},children:[],
      classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key), contains:key=>classes.has(key)},
      setAttribute:(key,value)=>attributes[key]=value, removeAttribute(key){delete this[key]},
      querySelector:key=>key==='.h-full'?bar:key==='p'?percentage:label,
      replaceChildren(){this.children=[]},append(...children){this.children.push(...children)}
    };
  }
  const el = id => {
    if(!nodes.has(id))nodes.set(id,makeNode());
    return nodes.get(id);
  };
  const context = vm.createContext({
    el, generation:1, timelineId:'T1', projectName:'Project A',
    document:{createElement:makeNode},persistProjectRecovery:async()=>{},
    fetch:async()=>failure==='start'?{ok:false,json:async()=>({detail:'Disk dolu'})}:{ok:true,json:async()=>({job_id:'render'})},
    events:async(id,handle)=>{
      handle({type:'progress',percent,message:'Video işleniyor'});
      if(failure==='stream')throw new Error('Bağlantı kesildi');
      return {download_url:'/download/movie/mp4'};
    },
    log:(...args)=>messages.push(args),saveCompletedOutput:async()=>({saved})
  });
  vm.runInContext(manager+transport+`
    outputJobs=createEditorOutputJobs({
      el,document,currentScope:kind=>({kind,generation,timelineId,projectName,timelineName:'Timeline A'}),
      canStart:()=>true,save:saveCompletedOutput,desktop:true
    });
  `,context);
  return {context,el,messages,begin:()=>context.outputJobs.begin('manual','mp4','Hazırlanıyor')};
}

test('render progress clamps invalid values and exposes readable state',()=>{
  const {context,el,begin}=fixture(),job=begin();
  context.outputJobs.update(job,145,'Hazır','complete');
  const node=el('manual-progress-top');
  assert.equal(node.bar.style.width,'100%');assert.equal(node.percentage.textContent,'100%');
  assert.equal(node.attributes['aria-valuenow'],'100');assert.equal(node.label.textContent,'Hazır');
  context.outputJobs.update(job,NaN,'Başlıyor');
  assert.equal(node.attributes['aria-valuenow'],'0');assert.equal(node.dataset.state,'running');
});

test('successful render explicitly reaches 100 percent after the result event',async()=>{
  const {context,el,begin}=fixture({saved:true});
  await context.render(begin(),'/start-render',()=>({}));
  const node=el('manual-progress-top');
  assert.equal(node.attributes['aria-valuenow'],'100');
  assert.equal(node.dataset.state,'complete');assert.equal(node.label.textContent,'Dosya kaydedildi');
});

test('a canceled native save keeps the output available for explicit retry',async()=>{
  const {context,el,begin}=fixture();
  await context.render(begin(),'/start-render',()=>({}));
  assert.equal(el('manual-progress-top').label.textContent,'Çıktı hazır');
  assert.equal(el('manual-download-top').href,'/download/movie/mp4');
  assert.equal(context.outputJobs.recent()[0].url,'/download/movie/mp4');
});

test('start and stream failures preserve progress and expose the terminal action',async()=>{
  for(const failure of ['start','stream']){
    const {context,el,begin}=fixture({failure});
    await context.render(begin(),'/start-render',()=>({}));
    const node=el('manual-progress-top');
    assert.equal(node.dataset.state,'error');assert.match(node.label.textContent,/Terminali açın/);
    assert.equal(node.attributes['aria-valuenow'],failure==='start'?'0':'38');
    assert.equal(el('manual-render-top').disabled,false);
  }
});

test('redraw cannot start a duplicate job and late completions stay in recent outputs',()=>{
  const {context,el,begin}=fixture(),job=begin();
  context.outputJobs.draw();
  assert.equal(el('manual-render-top').disabled,true);
  assert.equal(begin(),null);
  context.generation++;
  context.outputJobs.draw();
  assert.ok(el('manual-progress-top').classList.contains('hidden'));
  context.outputJobs.complete(job,'/download/old/mp4','Çıktı hazır');
  context.outputJobs.finish(job);
  assert.ok(el('manual-progress-top').classList.contains('hidden'));
  assert.equal(el('manual-download-top').href,undefined);
  assert.equal(el('manual-render-top').disabled,false);
  assert.equal(context.outputJobs.recent()[0].projectName,'Project A');
  assert.equal(context.outputJobs.recent()[0].timelineName,'Timeline A');
});
