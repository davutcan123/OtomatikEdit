const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname,'../templates/index.html'),'utf8');
const manager = fs.readFileSync(path.join(__dirname,'../static/editor_outputs.js'),'utf8');
const transport = html.slice(html.indexOf('    async function render('),html.indexOf('    // MANUAL EDITOR'));

function fixture({failure=null,percent=38,saved=false,stop,cancelled=false}={}) {
  const nodes = new Map(), messages = [];
  function makeNode() {
    const attributes = {}, bar = {style:{}}, label = {}, percentage = {};
    const classes = new Set();
    return {
      attributes,bar,label,percentage,dataset:{},children:[],
      classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key), contains:key=>classes.has(key)},
      setAttribute:(key,value)=>attributes[key]=value, removeAttribute(key){delete this[key]},
      querySelector:key=>key==='.h-full'?bar:key==='p'?percentage:label,
      replaceChildren(){this.children=[]},append(...children){this.children.push(...children);for(const child of children)child.parent=this},
      remove(){this.parent.children=this.parent.children.filter(child=>child!==this)}
    };
  }
  const el = id => {
    if(!nodes.has(id))nodes.set(id,makeNode());
    return nodes.get(id);
  };
  const context = vm.createContext({
    el, stop, generation:1, timelineId:'T1', projectName:'Project A', analysisRevision:1, sourceName:'Alp vadisi.mp4',
    document:{createElement:makeNode},persistProjectRecovery:async()=>{},
    fetch:async()=>failure==='start'?{ok:false,json:async()=>({detail:'Disk dolu'})}:{ok:true,json:async()=>({job_id:'render'})},
    events:async(id,handle)=>{
      handle({type:'progress',percent,message:'Video işleniyor'});
      if(failure==='stream')throw new Error('Bağlantı kesildi');
      return cancelled ? {type:'cancelled',message:'Dışa aktarma durduruldu.'} : {download_url:'/download/movie/mp4'};
    },
    log:(...args)=>messages.push(args),saveCompletedOutput:async()=>({saved})
  });
  vm.runInContext(manager+transport+`
    outputJobs=createEditorOutputJobs({
      el,document,currentScope:kind=>({kind,generation,projectName,
        timelineId:kind==='auto'?null:timelineId,timelineName:kind==='auto'?'':'Timeline A',
        analysisRevision:kind==='auto'?analysisRevision:null,sourceName:kind==='auto'?sourceName:''
      }),
      canStart:()=>true,save:saveCompletedOutput,stop,desktop:true
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


test('auto exports keep their analysis revision and source name across redraw and recovery',()=>{
  const {context,el}=fixture();
  const manager=context.outputJobs;
  const start=()=>manager.begin('auto','mp4','Hazırlanıyor');
  const a=start();
  context.analysisRevision++;
  manager.draw('auto');
  assert.equal(manager.visible(a),false,'Even a new analysis of the same source has its own revision');
  assert.equal(start(),null,'Only one automatic render may run at a time');
  manager.update(a,75,'Eski analiz işleniyor');
  assert.equal(el('auto-progress').classList.contains('hidden'),true);
  assert.equal(el('auto-stop').hidden,true);
  assert.match(el('active-output-list').children[0].children[1].textContent,/Alp vadisi\.mp4 · Eski analiz işleniyor/);
  context.sourceName='Yeni klip.mp4';
  manager.complete(a,'/download/old-auto/mp4','Çıktı hazır');
  manager.finish(a);
  assert.equal(el('auto-download').href,undefined);
  assert.equal(el('auto-render').disabled,false);
  assert.match(el('recent-output-list').children[0].children[1].textContent,/Alp vadisi\.mp4/);
  assert.equal(manager.recent()[0].sourceName,'Alp vadisi.mp4');
  manager.restoreRecent(JSON.parse(JSON.stringify(manager.recent())));
  assert.match(el('recent-output-list').children[0].children[1].textContent,/Alp vadisi\.mp4/);
  assert.equal(start().sourceName,'Yeni klip.mp4');
});

test('a stop clicked before launch acknowledgement is sent with the originating job capability', async ()=>{
  const calls=[];
  const {context,el,begin}=fixture({stop:async credentials=>calls.push(credentials)});
  const job=begin();
  assert.equal(el('manual-stop').hidden,false);
  el('manual-stop').onclick();
  assert.equal(el('manual-stop').disabled,true);
  assert.equal(calls.length,0);
  context.timelineId='T2';
  context.outputJobs.draw();
  assert.equal(el('manual-stop').hidden,true);
  assert.equal(el('active-output-list').children[0].children[1].textContent,'Project A · Timeline A · Durduruluyor…');
  context.outputJobs.attach(job,'own-job','specific-secret');
  assert.equal(calls.length,1);
  assert.equal(calls[0].id,'own-job');assert.equal(calls[0].token,'specific-secret');
  context.outputJobs.update(job,10,'Dışa aktarma durduruldu.','cancelled');
  context.outputJobs.finish(job);
  assert.equal(el('active-output-section').hidden,true);
  assert.equal(context.outputJobs.recent().length,0);
});

test('failure to send stop allows retry, and a completed output wins a late stop', async ()=>{
  let attempts=0;
  const {context,el,begin}=fixture({stop:async()=>{if(++attempts===1)throw new Error('Bağlantı yok')}});
  const job=begin();
  context.outputJobs.attach(job,'own-job','specific-secret');
  el('manual-stop').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(el('manual-stop').disabled,false);
  assert.equal(el('manual-progress-top').label.textContent,'Bağlantı yok');
  el('manual-stop').onclick();
  context.outputJobs.complete(job,'/download/movie/mp4','Çıktı hazır');
  context.outputJobs.finish(job);
  assert.equal(attempts,2);
  assert.equal(el('manual-stop').hidden,true);
  assert.equal(el('manual-download-top').href,'/download/movie/mp4');
  assert.equal(context.outputJobs.recent().length,1);
});

test('cancelled SSE leaves a distinct stopped state and no download or recent output',async()=>{
  const {context,el,begin,messages}=fixture({cancelled:true});
  await context.render(begin(),'/start-render',()=>({}));
  assert.equal(el('manual-progress-top').dataset.state,'cancelled');
  assert.equal(el('manual-progress-top').label.textContent,'Dışa aktarma durduruldu.');
  assert.equal(messages.at(-1)[2],'info');
  assert.equal(el('manual-render-top').disabled,false);
  assert.equal(el('manual-download-top').href,undefined);
  assert.equal(context.outputJobs.recent().length,0);
});
