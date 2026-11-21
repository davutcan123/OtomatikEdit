(() => {
  'use strict';

  const codec = window.StudioSrt;
  const field = id => el('studio-caption-'+id);
  const panel = el('studio-captions');
  const replacement = field('replace');
  const search = field('search');
  const styleFields = ['styleName','fontFamily','bold','size','color','outlineColor','outlineWidth','background','backgroundOpacity','shadow'];
  let pendingImport = null, pendingExport = null, lastScope = '', listSignature = '', cueSignature = '';
  const scope = () => workspaceGeneration+':'+timelineGeneration;
  const texts = () => S.texts.filter(item=>item.kind==='subtitle');
  const selected = () => {
    const item = selectedText();
    return item?.kind==='subtitle' ? item : null;
  };
  const normalizedSearch = value => value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/\p{M}/gu,'').replace(/ı/g,'i');
  const locked = () => isTrackLocked('subtitle');

  function message(text, error=false) {
    field('status').textContent = text;
    field('status').dataset.error = String(error);
  }

  function renderList(cues) {
    const terms = normalizedSearch(search.value).trim().split(/\s+/).filter(Boolean);
    const signature = JSON.stringify([S.selectedText,terms,cues.map(({id,start,end,text})=>[id,start,end,text])]);
    if (signature===listSignature) return;
    listSignature = signature;
    const matches = cues.filter(cue=>{
      const value = normalizedSearch(cue.text+' '+codec.formatTime(cue.start)+' '+codec.formatTime(cue.end));
      return terms.every(term=>value.includes(term));
    }).sort((a,b)=>a.start-b.start||a.end-b.end);
    field('count').textContent = terms.length ? matches.length+' / '+cues.length : cues.length+' altyazı';
    const empty = field('empty');
    empty.hidden = matches.length>0;
    empty.textContent = cues.length ? 'Aramaya uyan altyazı yok.' : 'Bu zaman çizelgesinde altyazı yok.';
    const list = field('cue-list'), scroll = list.scrollTop, focusId = document.activeElement?.dataset.cueId;
    const items = matches.map(cue=>{
      const row = document.createElement('li'), button = document.createElement('button'), times = document.createElement('span');
      button.type = 'button';button.dataset.cueId = cue.id;
      if(cue.id===S.selectedText)button.setAttribute('aria-current','true');
      times.className = 'studio-caption-time';times.textContent = codec.formatTime(cue.start)+' → '+codec.formatTime(cue.end);
      button.append(times,document.createTextNode(cue.text));row.append(button);
      return row;
    });
    list.replaceChildren(...items);list.scrollTop = scroll;
    if(focusId)list.querySelector('[data-cue-id="'+CSS.escape(focusId)+'"]')?.focus({preventScroll:true});
  }

  function displayCharacterCount() {
    field('text-count').textContent = [...field('text').value].length+' / '+codec.maxCharacters;
  }

  function renderEditor(item) {
    field('editor').hidden = !item;
    for (const id of ['text','start','end','style','font','apply-edit','apply-all']) field(id).disabled = !item||locked();
    const signature = JSON.stringify(item&&[scope(),item.id,item.start,item.end,item.text]);
    if (item&&signature!==cueSignature) {
      field('text').value = item.text;
      field('start').value = Number(item.start.toFixed(3));
      field('end').value = Number(item.end.toFixed(3));
      displayCharacterCount();
    }
    cueSignature = signature;
    if(!item)return;
    field('style').value = item.styleName||'classic';
    field('font').value = window.StudioFonts?.normalize(item.fontFamily)||'default';
  }

  function refresh() {
    const current = scope();
    if(current!==lastScope){
      lastScope=current;search.value='';message('');
      if(replacement.open)replacement.close('cancel');
    }
    if(panel.classList.contains('hidden'))return;
    const cues=texts();
    field('import').disabled = locked()||pendingImport?.scope===current;
    field('export').disabled = !cues.length||pendingExport?.scope===current;
    field('auto').disabled = locked()||!selectedClip();
    field('import').title = locked() ? 'Altyazı kanalı kilitli' : 'UTF-8 SRT dosyası seç';
    renderList(cues);renderEditor(selected());
  }

  function selectCue(id) {
    const cue = texts().find(item=>item.id===id);
    if(!cue)return;
    pausePreview();selectText(id,false);seekOutputTime(cue.start);
    refresh();field('editor').scrollIntoView({block:'nearest',inline:'nearest'});
  }

  function askReplacement(oldCount) {
    if(replacement.open)return Promise.resolve(false);
    field('replace-message').textContent = 'Bu zaman çizelgesindeki '+oldCount+' altyazı seçilen SRT dosyasıyla değiştirilecek.';
    replacement.returnValue='cancel';
    return new Promise(resolve=>{
      replacement.addEventListener('close',()=>resolve(replacement.returnValue==='replace'),{once:true});
      replacement.showModal();
    });
  }

  async function importFile(file) {
    if(!file||locked()||desktopUpdateFrozen||desktopClosing)return false;
    const request={scope:scope()};
    if(pendingImport?.scope===request.scope)return false;
    const offset=field('position').value==='playhead'?Math.round(currentOutputTime()*1000)/1000:0;
    const mode=field('mode').value;
    const finish=beginDesktopOperation('SRT altyazısını okuma');
    pendingImport=request;refresh();
    message('SRT dosyası okunuyor…');
    try {
      if(file.size>codec.maxFileBytes)throw new Error('SRT dosyası en fazla 1 MB olabilir.');
      let source;
      try {source=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}
      catch {throw new Error('SRT dosyası geçerli UTF-8 metni olarak okunamadı.');}
      if(request.scope!==scope())return false;
      const cues=codec.parse(source), old=texts();
      let plan=codec.planImport(cues,S.texts,{mode,offset});
      if(!plan.added.length){
        message('Yeni altyazı yok. '+plan.duplicates+' eşleşen altyazı atlandı.');return false;
      }
      if(mode==='replace'&&old.length){
        const original=JSON.stringify(old);
        if(!await askReplacement(old.length)||request.scope!==scope()){
          if(request.scope===scope())message('Altyazılar korundu.');
          return false;
        }
        if(original!==JSON.stringify(texts()))throw new Error('Altyazılar değişti. SRT dosyasını yeniden seçin.');
        plan=codec.planImport(cues,S.texts,{mode,offset});
      }
      if(locked())throw new Error('Altyazı kanalı kilitli.');
      const items=plan.added.map(cue=>({
        ...TEXT_STYLES.classic,...cue,
        id:'TSRT'+crypto.randomUUID(),kind:'subtitle',styleName:'classic',fontFamily:'default',
        x:50,y:87,rotation:0,sourceKey:'srt:'+file.name,transformKeyframes:[]
      }));
      remember();S.texts=[...plan.retained,...items];
      selectCue(items[0].id);drawClips();
      const skipped=plan.duplicates?' '+plan.duplicates+' eşleşen altyazı atlandı.':'';
      message(items.length+' altyazı eklendi.'+skipped);
      return true;
    } catch(error) {
      if(request.scope===scope())message(error.message,true);
      return false;
    } finally {
      if(pendingImport===request)pendingImport=null;
      finish();refresh();
    }
  }

  function applyCueEdit() {
    const item=selected();
    if(!item||locked())return;
    try {
      const start=field('start').value,end=field('end').value;
      const cue=codec.cueValue(start===''?NaN:Number(start),end===''?NaN:Number(end),field('text').value,0);
      const duplicate=texts().some(other=>other!==item&&Math.round(other.start*1000)===Math.round(cue.start*1000)
        &&Math.round(other.end*1000)===Math.round(cue.end*1000)&&other.text.normalize('NFC')===cue.text.normalize('NFC'));
      if(duplicate)throw new Error('Aynı metin ve zamanda bir altyazı zaten var.');
      if(cue.start===item.start&&cue.end===item.end&&cue.text===item.text)return;
      remember();Object.assign(item,cue);drawClips();
      message('Altyazı güncellendi.');
    } catch(error){message(error.message,true);}
  }

  function applyAllStyles() {
    const item=selected();
    if(!item||locked())return;
    const others=texts().filter(cue=>cue!==item&&styleFields.some(key=>cue[key]!==item[key]));
    if(!others.length){message('Altyazılar aynı stili kullanıyor.');return;}
    const appearance=Object.fromEntries(styleFields.map(key=>[key,item[key]]));
    remember();
    for(const cue of others)Object.assign(cue,appearance);
    drawClips();message('Stil '+others.length+' altyazıya uygulandı.');
  }

  async function videoSubtitleTimes() {
    const data=manualExportData();
    if(!data.texts.some(item=>item.kind==='subtitle')){
      throw new Error('Video için görünür altyazı yok. Tüm satırları almak için zaman çizelgesi zamanlarını seçin.');
    }
    const response=await fetch('/studio/subtitle-timing',{method:'POST',body:buildRenderForm(data)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||!Array.isArray(result.cues))throw new Error(result.detail||'Video altyazı zamanları hesaplanamadı.');
    return result.cues;
  }

  async function exportFile() {
    const request={scope:scope()};
    if(pendingExport?.scope===request.scope||desktopUpdateFrozen||desktopClosing)return;
    const clock=field('export-clock').value;
    const timeline=S.timelines.find(item=>item.id===S.activeTimelineId);
    const name=[el('project-name').value.trim(),timeline?.name].filter(Boolean).join(' - ');
    const safeName=(name.replace(/[<>:"/\\|?*\p{C}]/gu,' ').trim().slice(0,80)||'altyazı')+' - altyazı.srt';
    const finish=beginDesktopOperation('SRT altyazı kaydetme');
    pendingExport=request;refresh();
    try {
      const cues=clock==='video'?await videoSubtitleTimes():texts();
      if(request.scope!==scope())return;
      const content=codec.serialize(cues);
      if(desktopBridge){
        const result=await desktopBridge.saveSubtitles(safeName,content);
        if(request.scope===scope())message(result.saved?'SRT dosyası kaydedildi.':'SRT kaydı iptal edildi.');
      }else{
        const url=URL.createObjectURL(new Blob([content],{type:'application/x-subrip;charset=utf-8'}));
        const link=document.createElement('a');link.href=url;link.download=safeName;
        document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
        if(request.scope===scope())message('SRT indirmesi hazırlandı.');
      }
    }catch(error){if(request.scope===scope())message(error.message,true);}
    finally{if(pendingExport===request)pendingExport=null;finish();refresh();}
  }

  function configureStyles() {
    const existingStyle=el('subtitle-selected-style'), existingFont=el('subtitle-selected-font-family');
    field('style').replaceChildren(...[...existingStyle.options].map(option=>option.cloneNode(true)));
    field('font').replaceChildren(...[...existingFont.options].map(option=>option.cloneNode(true)));
    refresh();
  }
  field('import').onclick=()=>field('file').click();
  field('file').onchange=event=>{
    const file=event.currentTarget.files[0];event.currentTarget.value='';
    void importFile(file);
  };
  field('export').onclick=()=>void exportFile();
  field('apply-edit').onclick=applyCueEdit;
  field('apply-all').onclick=applyAllStyles;
  field('text').oninput=displayCharacterCount;
  field('style').onchange=()=>{
    el('subtitle-selected-style').value=field('style').value;applySelectedSubtitleStyle();
  };
  field('font').onchange=()=>window.StudioFonts?.applyToSelection(field('font').value);
  field('cue-list').onclick=event=>{
    const button=event.target.closest('[data-cue-id]');if(button)selectCue(button.dataset.cueId);
  };
  field('auto').onclick=()=>{
    if(!selectedClip()||locked())return;
    if(S.selectedText||S.selectedSticker||S.selectedLayer)select(S.selected,false);
    switchClipInspectorTab('video');setCollapsiblePanel('clipInspector',true);
    el('subtitle-section').open=true;el('subtitle-generate').focus();
  };
  search.oninput=()=>renderList(texts());
  window.addEventListener('studio:section',event=>{if(event.detail.id==='captions')refresh();});
  window.StudioCaptions = {refresh,importFile};
  configureStyles();
  Promise.resolve(window.StudioFonts?.ready).then(configureStyles).catch(()=>{});
})();
