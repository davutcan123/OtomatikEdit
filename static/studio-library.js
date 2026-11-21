(() => {
  const mediaRoot = '/static/studio/';
  const images = Object.fromEntries(['alpine','session','product'].map(scene => [scene,mediaRoot+'previews/'+scene+'.jpg']));
  const lookDefaults = {brightness:100,contrast:100,saturation:100,temperature:0,exposure:0,tint:0,fade:0,hue:0,lightness:0,curvePreset:'none',shadows:0,highlights:0,lut:'none'};
  const looks = [
    {id:'alpine-light', name:'Alp Işığı', group:'Doğal ışık', scene:'alpine', color:{brightness:106,contrast:109,saturation:112,shadows:12,highlights:-7}},
    {id:'cloud-veil', name:'Bulut Tülü', group:'Doğal ışık', scene:'alpine', color:{brightness:106,contrast:87,saturation:76,fade:17,lightness:12}},
    {id:'forest-clear', name:'Orman Berraklığı', group:'Doğal ışık', scene:'alpine', color:{brightness:97,contrast:116,saturation:117,hue:6,shadows:17,highlights:-8}},
    {id:'warm-paper', name:'Sıcak Kâğıt', group:'Doğal ışık', scene:'product', color:{brightness:109,contrast:93,saturation:82,temperature:20,fade:8}},
    {id:'amber-hour', name:'Kehribar Saati', group:'Film tonları', scene:'alpine', color:{brightness:100,contrast:112,saturation:119,temperature:27,exposure:-5,highlights:-9}},
    {id:'night-watch', name:'Gece Nöbeti', group:'Film tonları', scene:'session', color:{brightness:84,contrast:116,saturation:79,exposure:-9,hue:12,shadows:-9}},
    {id:'silver-print', name:'Gümüş Baskı', group:'Film tonları', scene:'session', color:{brightness:103,contrast:112,saturation:0,shadows:12,highlights:7}},
    {id:'memory-fade', name:'Soluk Hatıra', group:'Film tonları', scene:'session', color:{brightness:108,contrast:86,saturation:68,temperature:18,fade:28,lightness:7}},
    {id:'cream-studio', name:'Krem Stüdyo', group:'Stüdyo', scene:'product', color:{brightness:111,contrast:101,saturation:83,exposure:7,temperature:9,highlights:10}},
    {id:'cobalt-glass', name:'Kobalt Cam', group:'Stüdyo', scene:'product', color:{brightness:97,contrast:122,saturation:128,tint:12,hue:14,highlights:-12}},
  ];
  const sounds = [
    {id:'click',name:'Kuru Tık',group:'Ses efektleri · Arayüz'},
    {id:'soft-tap',name:'Yumuşak Dokunuş',group:'Ses efektleri · Arayüz'},
    {id:'confirm',name:'Onay Sesi',group:'Ses efektleri · Arayüz'},
    {id:'whoosh',name:'Hızlı Geçiş',group:'Ses efektleri · Geçiş ve vurgu'},
    {id:'rise',name:'Yükseliş',group:'Ses efektleri · Geçiş ve vurgu'},
    {id:'chord',name:'Kısa Akor',group:'Ses efektleri · Geçiş ve vurgu'},
  ].map(sound => ({...sound, kind:'audio', file:sound.id+'.wav', type:'audio/wav',folder:'sounds/'}));
  const music = [
    {id:'twilight',name:'Alacakaranlık',description:'Sinematik · 12,6 sn'},
    {id:'coast',name:'Kıyı yürüyüşü',description:'Lo-fi · 10 sn'},
    {id:'daybreak',name:'Gün doğumu',description:'Akustik · 10,9 sn'}
  ].map(track=>({...track,group:'Müzik',kind:'audio',file:track.id+'.mp3',type:'audio/mpeg',folder:'music/'}));
  const demo = {id:'alpine-tour',name:'Alp vadisi',kind:'video',file:'alpine-tour.mp4',type:'video/mp4'};
  const sections = {
    media:'project-library', sounds:'studio-sounds', text:'text-editor', video:'video-effects-editor',
    filter:'filter-editor', transition:'transition-editor', animation:'animation-editor', sticker:'sticker-editor'
  };
  const filterInput = el('studio-asset-search'), favoritesButton = el('studio-favorites');
  const preferenceKey = 'favorites';
  let section = 'media', favoritesOnly = false, favorites = new Set(), previewButton = null, previewAudio = null;
  const pending = new Set();
  const simplify = value => value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/ı/g,'i').trim();

  function favoriteIds(data) {
    return new Set(Array.isArray(data) ? data.filter(item => typeof item === 'string') : []);
  }
  function syncFavorites(data) {
    favorites = favoriteIds(data);renderFavorites();
  }
  function connectPreferences() {
    const prefs = window.StudioPreferences;
    if (prefs) {
      prefs.subscribe((key,value) => { if (key === preferenceKey) syncFavorites(value); });
      Promise.resolve(prefs.ready).then(() => syncFavorites(prefs.get(preferenceKey,[]))).catch(() => {});
      return;
    }
    try { syncFavorites(JSON.parse(localStorage.getItem('otamatik-edit:studio:favorites') || '[]')); } catch {}
  }
  async function toggleFavorite(key) {
    const before = favorites, next = new Set(before);
    if (next.has(key)) next.delete(key); else next.add(key);
    favorites = next;renderFavorites();
    try {
      const prefs = window.StudioPreferences;
      if (prefs) await prefs.set(preferenceKey,[...next]);
      else localStorage.setItem('otamatik-edit:studio:favorites',JSON.stringify([...next]));
    } catch (error) {
      if (favorites === next) { favorites = before;renderFavorites(); }
      log('manual-log','Favori kaydedilemedi: '+error.message,'error');
    }
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    if (tag === 'button') node.type = 'button';
    return node;
  }
  function addCardMetadata(wrapper, key, name, tags = '') {
    wrapper.dataset.studioItem = key;
    wrapper.dataset.studioSearch = simplify(name+' '+tags);
    if (wrapper.querySelector('.studio-favorite')) return;
    const star = element('button','studio-favorite','☆');
    star.dataset.studioFavorite = key;
    star.dataset.studioItemName = name;
    star.onclick = () => void toggleFavorite(key);
    wrapper.append(star);
  }
  function wrapButton(button, key, name, tags) {
    const wrapper = element('div','studio-card-wrap');
    button.before(wrapper);wrapper.append(button);
    addCardMetadata(wrapper,key,name,tags);
    return wrapper;
  }
  function renderFavorites() {
    for (const star of document.querySelectorAll('[data-studio-favorite]')) {
      const active = favorites.has(star.dataset.studioFavorite);
      star.textContent = active ? '★' : '☆';
      const action = active ? 'Favorilerden çıkar' : 'Favorilere ekle';
      star.setAttribute('aria-label',action+' · '+star.dataset.studioItemName);
      star.setAttribute('aria-pressed',String(active));
      star.title = action;
    }
    filterCards();
  }
  function filterCards() {
    const host = sections[section] && el(sections[section]), terms = simplify(filterInput.value).split(/\s+/).filter(Boolean);
    const activeFilter = terms.length > 0 || favoritesOnly;
    let visible = 0;
    if (host) {
      for (const card of host.querySelectorAll('[data-studio-item]')) {
        const show = !card.classList.contains('studio-demo-loaded')&&terms.every(term=>card.dataset.studioSearch.includes(term))
          && (!favoritesOnly || favorites.has(card.dataset.studioItem));
        card.hidden = !show;
        if (show) visible++;
      }
      for (const group of host.querySelectorAll('[data-studio-group]')) {
        group.hidden = !group.querySelector('[data-studio-item]:not([hidden])');
      }
      if (section === 'filter') el('studio-filter-stock-title').hidden = !el('filter-presets').querySelector('[data-studio-item]:not([hidden])');
      const emptyMedia = el('project-empty-dynamic') || el('project-empty');
      if (section === 'media' && emptyMedia) emptyMedia.hidden = activeFilter;
    }
    el('studio-search-empty').classList.toggle('hidden', !host || !activeFilter || visible > 0);
  }
  function tagMedia() {
    const byId = new Map(S.mediaAssets.map(item => [item.id,item]));
    for (const button of el('project-assets').querySelectorAll('[data-asset-id]')) {
      const asset = byId.get(button.dataset.assetId);
      if (!asset) continue;
      const kind = {video:'video',image:'görsel resim',audio:'ses müzik'}[asset.kind] || '';
      addCardMetadata(button.parentElement,'media:'+asset.fileId,asset.name,kind);
    }
    el('studio-demo-card').classList.toggle('studio-demo-loaded',S.mediaAssets.some(item=>item.studioSource===demo.id));
    renderFavorites();
  }
  function decorateLegacyCards() {
    const catalogs = [
      {section:'video', selector:'[data-video-effect]', attribute:'videoEffect', preview:'.video-effect-demo', scene:'session'},
      {section:'filter', selector:'[data-filter]', attribute:'filter', preview:'.filter-demo', scene:'product'},
      {section:'transition', selector:'[data-transition]', attribute:'transition', preview:'.transition-preview', scene:'alpine'},
      {section:'animation', selector:'[data-animation]', attribute:'animation', preview:'.animation-demo', scene:'session'},
      {section:'text', selector:'[data-text-style]', attribute:'textStyle'},
      {section:'sticker', selector:'[data-sticker]', attribute:'sticker'}
    ];
    for (const catalog of catalogs) {
      for (const button of el(sections[catalog.section]).querySelectorAll(catalog.selector)) {
        const name = button.querySelector('small')?.textContent || button.textContent;
        const preview = catalog.preview && button.querySelector(catalog.preview);
        if (preview) {
          preview.style.backgroundImage = `url("${images[catalog.scene]}")`;
          if (catalog.section === 'transition') preview.dataset.studioTransitionDemo = '';
        }
        wrapButton(button,catalog.section+':'+button.dataset[catalog.attribute],name);
        const key=button.dataset[catalog.attribute];
        if (catalog.section==='video') button.onclick=()=>{
          if(!S.suppressVideoEffectClick)selectedImageLayer()?applyImageTool('effect',key,selectedImageLayer().id):applyVideoEffect(key);
        };
        if (catalog.section==='filter') button.onclick=()=>{
          if(!S.suppressFilterClick)selectedImageLayer()?applyImageTool('filter',key,selectedImageLayer().id):applyClipFilter(key);
        };
        if (catalog.section==='animation') button.onclick=()=>{
          if(!S.suppressAnimationClick)selectedImageLayer()?applyImageTool('animation',key,selectedImageLayer().id):applyClipAnimation(key);
        };
        if (catalog.section==='transition') button.onclick=()=>{
          if(S.suppressTransitionClick)return;
          const selected=selectedClip();
          const after=nextClipOnTrack(S.selected);
          const boundary=after&&Math.abs(clipTimelineEnd(selected)-clipTimelineStart(after.item))<.03
            ? S.selected
            : S.clips.findIndex((clip,index)=>nextClipOnTrack(index)?.item===selected);
          if(boundary>=0)applyTransition(key,boundary);
          else log('manual-log','Geçişi uygulamak için bitişik iki klibin kesimini seçin.','info');
        };
      }
    }
  }
  function makeGroup(container, name) {
    const group = element('section','studio-asset-group'), title = element('h4','studio-group-title',name), grid = element('div','studio-card-grid');
    group.dataset.studioGroup = name;
    group.append(title,grid);container.append(group);
    return grid;
  }

  function applyLook(look, clip) {
    if (!clip) return log('manual-log','Görünüm uygulamak için zaman çizelgesinden bir video klibi seçin.','info');
    if (isVideoTrackLocked(clip)) return log('manual-log','Video kanalı kilitli.','error');
    const color = {...lookDefaults,...look.color};
    if (Object.keys(color).every(key => color[key] === clip[key])) return;
    remember();Object.assign(clip,color);
    const index=S.clips.indexOf(clip);
    if(index!==S.selected){pausePreview();select(index,true)}
    else drawClips();
    log('manual-log',look.name+' görünümü uygulandı.','info');
  }
  function attachLook(button,look) {
    button.onclick = () => {
      if (!button.dataset.suppressClick)applyLook(look,S.selectedLayer||S.selectedText||S.selectedSticker?null:selectedClip());
    };
    button.onpointerdown = event => {
      if (event.button !== 0) return;
      const start = {x:event.clientX,y:event.clientY};
      let dragging = false;
      const move = pointer => {
        if (!dragging && Math.hypot(pointer.clientX-start.x,pointer.clientY-start.y)>8) {
          dragging = true;
          showDragGhost(pointer,button.querySelector('img').outerHTML,look.name);
        }
        if (!dragging) return;
        pointer.preventDefault();moveDragGhost(pointer);
        for (const node of el('timeline').querySelectorAll('.clip')) {
          const bounds = node.getBoundingClientRect();
          node.classList.toggle('drop-target',pointer.clientX>=bounds.left&&pointer.clientX<=bounds.right&&pointer.clientY>=bounds.top&&pointer.clientY<=bounds.bottom);
        }
      };
      const finish = pointer => {
        window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);
        if (!dragging) return;
        const target = document.elementFromPoint(pointer.clientX,pointer.clientY)?.closest('#timeline .clip');
        hideDragGhost();
        for (const node of el('timeline').querySelectorAll('.drop-target')) node.classList.remove('drop-target');
        button.dataset.suppressClick = '1';setTimeout(() => delete button.dataset.suppressClick,0);
        if (pointer.type==='pointercancel') return;
        if (target) applyLook(look,S.clips[Number(target.dataset.index)]);
        else log('manual-log','Görünümü zaman çizelgesindeki video klibinin üzerine bırakın.','info');
      };
      window.addEventListener('pointermove',move,{passive:false});
      window.addEventListener('pointerup',finish);
      window.addEventListener('pointercancel',finish);
    };
  }
  function refreshLookSelection() {
    const clip=S.selectedLayer||S.selectedText||S.selectedSticker?null:selectedClip();
    for(const button of el('studio-look-groups').querySelectorAll('[data-studio-look]')){
      const look=looks.find(item=>item.id===button.dataset.studioLook);
      const active=!!clip&&Object.entries({...lookDefaults,...look.color}).every(([key,value])=>clip[key]===value);
      button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
    }
  }
  function renderLooks() {
    const root = el('studio-look-groups'), groups = new Map();
    for (const look of looks) {
      if (!groups.has(look.group)) groups.set(look.group,makeGroup(root,look.group));
      const wrapper = element('div','studio-card-wrap'), button = element('button','studio-look-card');
      const image = element('img','studio-look-preview');
      image.src = images[look.scene];image.alt = '';image.draggable = false;
      setVideoEffect(image,{...clipSettings(),...look.color});
      button.append(image,element('strong','',look.name));button.dataset.studioLook = look.id;
      wrapper.append(button);groups.get(look.group).append(wrapper);
      addCardMetadata(wrapper,'look:'+look.id,look.name,look.group+' renk filtre görünüm');
      attachLook(button,look);
    }
  }

  function stopSound() {
    if (previewAudio) {
      previewAudio.pause();previewAudio = null;
    }
    if (previewButton) {
      previewButton.textContent = '▶';previewButton.setAttribute('aria-pressed','false');previewButton = null;
    }
  }
  function playSound(sound, button) {
    if (button === previewButton) return stopSound();
    stopSound();
    const audio = new Audio(mediaRoot+sound.folder+sound.file);
    previewAudio = audio;previewButton = button;
    button.textContent = 'Ⅱ';button.setAttribute('aria-pressed','true');
    audio.addEventListener('ended',() => { if (previewAudio === audio) stopSound(); },{once:true});
    audio.play().catch(error => {
      if(previewAudio===audio){stopSound();log('manual-log','Ses önizlemesi açılamadı: '+error.message,'error')}
    });
  }
  async function addBundled(item, button) {
    const generation = workspaceGeneration, timeline = timelineGeneration, key = generation+':'+item.id;
    const targetVideoTrack = item.kind === 'video' ? S.activeVideoTrack : null;
    const locked = () => targetVideoTrack===null ? isTrackLocked('audio') : isVideoTrackLocked(targetVideoTrack);
    if (pending.has(key)) return;
    if (locked()) return log('manual-log','Kanal kilitli; eklemek için önce kilidi açın.','error');
    const position = currentOutputTime();
    if (item.kind === 'audio') stopSound();
    pausePreview();
    const release = beginDesktopOperation(item.kind === 'audio' ? 'Ses efekti ekleme' : 'Örnek video ekleme');
    pending.add(key);button.disabled = true;
    try {
      let asset = S.mediaAssets.find(value => value.studioSource === item.id && value.kind === item.kind);
      if (!asset) {
        const folder = item.kind === 'audio' ? item.folder : 'demo/';
        const response = await fetch(mediaRoot+folder+item.file);
        if (!response.ok) throw new Error('Uygulamadaki medya okunamadı.');
        const blob = await response.blob();
        if (generation !== workspaceGeneration) return;
        const uploaded = await upload(new File([blob],item.file,{type:item.type}));
        if (generation !== workspaceGeneration) return;
        if (typeof uploaded.file_id !== 'string' || !Number.isFinite(+uploaded.duration) || +uploaded.duration <= 0) throw new Error('Medya süresi alınamadı.');
        asset = {id:'M'+S.nextAssetId++, fileId:uploaded.file_id, name:item.name, kind:item.kind, duration:+uploaded.duration, src:'/video/'+encodeURIComponent(uploaded.file_id), studioSource:item.id};
        S.mediaAssets.push(asset);drawProjectLibrary();scheduleAutosave();
      }
      if (timeline !== timelineGeneration) {
        log('manual-log',item.name+' proje medyasına eklendi. Zaman çizelgesi değiştiği için orijinal konuma yerleştirilmedi.','info');
        return;
      }
      if (targetVideoTrack!==null&&targetVideoTrack!==S.activeVideoTrack) {
        log('manual-log',item.name+' proje medyasına eklendi. Seçili video kanalı değişti.','info');
        return;
      }
      addProjectAssetAt(asset,position,{extendAudio:item.kind==='audio'});
    } catch (error) {
      if (generation === workspaceGeneration) log('manual-log',error.message,'error');
    } finally {
      pending.delete(key);button.disabled = false;release();
    }
  }
  function renderSounds() {
    const root = el('studio-sound-cards'), groups = new Map();
    for (const sound of [...music,...sounds]) {
      if (!groups.has(sound.group)) groups.set(sound.group,makeGroup(root,sound.group));
      const row = element('div','studio-sound-card'), name = element('strong','',sound.name);
      const controls = element('div','studio-sound-actions');
      const play = element('button','project-action','▶'), add = element('button','project-action','＋');
      play.setAttribute('aria-label',sound.name+' sesini önizle');play.setAttribute('aria-pressed','false');play.title = 'Sesi önizle';
      add.setAttribute('aria-label',sound.name+' sesini oynatma noktasına ekle');add.title = 'Oynatma noktasına ekle';
      play.onclick = () => playSound(sound,play);add.onclick = () => void addBundled(sound,add);
      controls.append(play,add);row.append(element('span','studio-sound-mark','♪'),name,controls);
      if(sound.description)name.append(element('small','studio-sound-duration',sound.description));
      addCardMetadata(row,(sound.folder==='music/'?'music:':'sound:')+sound.id,sound.name,sound.group+' ses '+(sound.description||''));
      groups.get(sound.group).append(row);
    }
  }

  window.StudioLibrary={refreshLookSelection};
  decorateLegacyCards();renderLooks();renderSounds();tagMedia();refreshLookSelection();
  addCardMetadata(el('studio-demo-card'),'demo:'+demo.id,demo.name,'örnek video alp alpine');
  el('studio-add-demo').onclick = event => void addBundled(demo,event.currentTarget);
  filterInput.addEventListener('input',filterCards);
  favoritesButton.onclick = () => {
    favoritesOnly = !favoritesOnly;
    favoritesButton.setAttribute('aria-pressed',String(favoritesOnly));filterCards();
  };
  window.addEventListener('studio:media-change',tagMedia);
  window.addEventListener('studio:section',event => {
    if (event.detail.id !== 'sounds') stopSound();
    section = event.detail.id;filterInput.value = '';filterCards();
  });
  el('studio-play-toggle').addEventListener('click',stopSound);
  window.addEventListener('pagehide',stopSound);
  window.addEventListener('DOMContentLoaded',connectPreferences,{once:true});
  renderFavorites();
})();
