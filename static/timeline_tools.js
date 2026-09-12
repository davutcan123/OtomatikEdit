/* Timeline-only clipboard and non-destructive source-space cropping.
   This classic script deliberately shares the editor's lexical state. */
let timelineClipboard = null;
let timelineCropSession = null;

function timelineToolsBlocked({allowCrop = false} = {}) {
  if (typeof desktopUpdateFrozen !== 'undefined' && desktopUpdateFrozen) return true;
  if (typeof desktopClosing !== 'undefined' && desktopClosing) return true;
  if (!el('manual')?.classList.contains('active')) return true;
  if (document.querySelector(allowCrop ? 'dialog[open]:not(#timeline-crop-dialog)' : 'dialog[open]')) return true;
  return !!el('export-modal') && !el('export-modal').classList.contains('hidden');
}

function timelineFreshId(prefix) {
  return prefix + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
}

function cloneTimelineItem(item, type) {
  const result = JSON.parse(JSON.stringify(item));
  if (type === 'video') result.clipId = newClipId();
  else result.id = timelineFreshId({image:'I', audio:'A', text:'T', subtitle:'T', sticker:'S'}[type] || 'L');
  for (const key of ['zoomKeyframes', 'transformKeyframes']) {
    if (Array.isArray(result[key])) result[key].forEach(frame => { frame.id = timelineFreshId('KF'); });
  }
  return result;
}

function timelineSelectionForCopy() {
  if (S.selectedLayer) {
    const type = S.selectedLayer.type;
    const item = (type === 'image' ? S.imageLayers : S.audioLayers).find(item => item.id === S.selectedLayer.id);
    if (item) return {type, item};
  }
  const text = S.texts.find(item => item.id === S.selectedText);
  if (text) return {type:text.kind === 'subtitle' ? 'subtitle' : 'text', item:text};
  const sticker = S.stickers.find(item => item.id === S.selectedSticker);
  if (sticker) return {type:'sticker', item:sticker};
  const video = S.clips[S.selected];
  return video ? {type:'video', item:video} : null;
}

function timelineCopySelection() {
  if (timelineToolsBlocked()) return false;
  if (selectedTimelineVideos().length > 1) return copyTimelineVideoGroup();
  const selection = timelineSelectionForCopy();
  if (!selection) return false;
  const item = JSON.parse(JSON.stringify(selection.item));
  // Capture source identity now: the next timeline may use another main video.
  if (selection.type === 'video') {
    item.fileId = item.fileId || S.manualId;
    item.src = item.src || '/video/' + encodeURIComponent(item.fileId);
    item.name = item.name || S.manualName;
  }
  timelineClipboard = {type:selection.type, item, projectTimelines:S.timelines};
  log('manual-log', (item.name || item.text || 'Seçili öğe') + ' kopyalandı. Oynatma kafasını yerleştirip Ctrl/Cmd+V ile yapıştırın.', 'info');
  return true;
}

function timelinePasteClipboard() {
  if (timelineToolsBlocked() || !timelineClipboard) return false;
  if (timelineClipboard.projectTimelines !== S.timelines) {
    timelineClipboard = null;
    log('manual-log', 'Başka bir proje açıldı. Bu projeden bir öğe kopyalayın.', 'info');
    return false;
  }
  if (timelineClipboard.type === 'video-group') return pasteTimelineVideoGroup();
  const {type} = timelineClipboard;
  const item = cloneTimelineItem(timelineClipboard.item, type);
  const time = Math.max(0, Number(currentOutputTime()) || 0);
  let targetTrack = null;
  if (type === 'video') {
    ensureVideoTracks();
    targetTrack = videoTrackState(S.activeVideoTrack);
    if (!targetTrack || targetTrack.locked) {
      log('manual-log', 'Hedef video kanalı kilitli. Önce kilidi açın.', 'error');
      return false;
    }
  } else if (isTrackLocked(type)) {
    log('manual-log', 'Hedef kanal kilitli. Önce kilidi açın.', 'error');
    return false;
  }
  remember();
  pausePreview();
  S.selectedText = S.selectedSticker = S.selectedLayer = null;
  S.selectedVideoClipIds = [];
  S.selectedTextKeyframe = S.selectedImageKeyframe = S.selectedZoomKeyframe = null;
  if (type === 'video') {
    const duration = clipOutputDuration(item);
    const occupied = S.clips.some(clip => (Number(clip.videoTrack) || 1) === targetTrack.id &&
      clipTimelineStart(clip) < time + duration - .000001 && clipTimelineEnd(clip) > time + .000001);
    if (occupied && !S.timelineRipple) {
      targetTrack = addVideoTrack({remember:false, redraw:false});
      log('manual-log', 'Bu aralık dolu olduğu için kopya ' + targetTrack.name + ' kanalına eklendi.', 'info');
    }
    item.timelineStart = time;
    item.videoTrack = targetTrack.id;
    S.activeVideoTrack = targetTrack.id;
    S.clips.push(hydrateClip(item));
    if (S.timelineRipple && typeof commitRippleMove === 'function') commitRippleMove(item, item.videoTrack, time);
    S.clips.sort((a,b) => clipTimelineStart(a) - clipTimelineStart(b) || (a.videoTrack || 1) - (b.videoTrack || 1));
    S.selected = S.preview = S.clips.indexOf(item);
    S.manualId = S.manualId || item.fileId;
    S.manualName = S.manualName || item.name || '';
    S.duration = Math.max(S.duration || 0, item.end || 0);
    clampClipTransitions();
    el('manual-placeholder')?.classList.add('hidden');
  } else {
    const duration = Math.max(.01, Number(item.end) - Number(item.start));
    item.start = time;
    item.end = time + duration;
    if (type === 'image') { S.imageLayers.push(hydrateImageLayer(item)); S.selectedLayer = {type:'image',id:item.id}; }
    else if (type === 'audio') { S.audioLayers.push(item); S.selectedLayer = {type:'audio',id:item.id}; }
    else if (type === 'sticker') { S.stickers.push(item); S.selectedSticker = item.id; }
    else { S.texts.push(hydrateText(item)); S.selectedText = item.id; }
  }
  S.timelineCursor = time;
  resetLiveTransition();
  drawClips();
  if (type === 'video') setPreviewSource(S.preview, undefined, false);
  else seekOutputTime(time);
  showTextProperties();
  scheduleAutosave();
  log('manual-log', 'Bağımsız kopya ' + ft(time) + ' noktasına yapıştırıldı.', 'info');
  return item;
}

function timelineClipboardKeydown(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.isComposing) return;
  const key = event.key.toLowerCase();
  if (key !== 'c' && key !== 'v') return;
  const focused = document.activeElement;
  if (focused?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(focused?.tagName || '') || timelineToolsBlocked()) return;
  if (key === 'c' ? !timelineSelectionForCopy() : !timelineClipboard) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (key === 'c') timelineCopySelection(); else timelinePasteClipboard();
}

// Selection is local to the active timeline; IDs survive reordering and undo.
function selectedTimelineVideos() {
  if (S.selectedText || S.selectedSticker || S.selectedLayer) return [];
  const ids = new Set(S.selectedVideoClipIds || []);
  const items = S.clips.filter(item => ids.has(item.clipId));
  return items.length > 1 ? items : S.clips[S.selected] ? [S.clips[S.selected]] : [];
}

function setTimelineVideoSelection(items, primary = items.at(-1)) {
  S.selectedVideoClipIds = [...new Set(items.map(item => item.clipId))];
  S.selected = primary ? S.clips.indexOf(primary) : -1;
  if (primary) S.activeVideoTrack = primary.videoTrack || 1;
  S.selectedText = S.selectedSticker = S.selectedLayer = null;
  S.selectedZoomKeyframe = null;
  paintTimelineVideoSelection();
  drawClipInspector();
}

function paintTimelineVideoSelection() {
  const timeline = el('timeline');
  if (typeof timeline?.querySelectorAll !== 'function') return;
  const items = selectedTimelineVideos(), ids = new Set(items.map(item => item.clipId));
  S.selectedVideoClipIds = (S.selectedVideoClipIds || []).filter(id => ids.has(id));
  timeline.querySelectorAll('#track .clip').forEach(node => {
    const item = S.clips[+node.dataset.index], selected = !!item && ids.has(item.clipId);
    node.classList.toggle('selected', selected);
    node.classList.toggle('multi-selected', selected && items.length > 1);
    node.setAttribute('aria-pressed', String(selected));
  });
  const badge = el('timeline-selection-count');
  if (badge) { badge.hidden = items.length < 2; badge.textContent = items.length + ' klip seçili'; }
}

function deleteTimelineVideoSelection() {
  const items = selectedTimelineVideos();
  if (!items.length) return false;
  if (items.some(isVideoTrackLocked)) { log('manual-log','Seçimde kilitli bir video kanalı var; hiçbir klip silinmedi.','error'); return false; }
  const cursor = currentOutputTime(), ids = new Set(items.map(item => item.clipId));
  remember(); pausePreview();
  S.clips = S.clips.filter(item => !ids.has(item.clipId));
  S.transitions = S.transitions.filter(item => !ids.has(item.leftClipId) && !ids.has(item.rightClipId));
  S.selectedVideoClipIds = []; S.selected = S.preview = -1;
  resetLiveTransition(); clampClipTransitions(); drawClips(); seekOutputTime(Math.min(cursor, outDuration()));
  // Seeking a remaining native clip must not turn a deleted group into a new selection.
  S.selected = -1; paintTimelineVideoSelection(); drawClipInspector();
  log('manual-log',items.length+' klip silindi. Ctrl/Cmd+Z ile geri alabilirsiniz.','info');
  return true;
}

function copyTimelineVideoGroup() {
  const items = selectedTimelineVideos();
  if (items.length < 2) return false;
  const ids = new Set(items.map(item => item.clipId));
  timelineClipboard = {type:'video-group',projectTimelines:S.timelines,tracks:ensureVideoTracks().map(track=>track.id),
    items:JSON.parse(JSON.stringify(items.map(item => ({...item,fileId:item.fileId||S.manualId,
      src:item.src||'/video/'+encodeURIComponent(item.fileId||S.manualId),name:item.name||S.manualName})))),
    transitions:JSON.parse(JSON.stringify(S.transitions.filter(item => ids.has(item.leftClipId)&&ids.has(item.rightClipId))))};
  log('manual-log',items.length+' video klibi birlikte kopyalandı.','info');
  return true;
}

function pasteTimelineVideoGroup() {
  const originals = timelineClipboard.items, tracks = ensureVideoTracks();
  const sourceLayout = timelineClipboard.tracks || [...new Set(originals.map(item=>item.videoTrack||1))].sort((a,b)=>a-b);
  const sourceTracks = sourceLayout.filter(id=>originals.some(item=>(item.videoTrack||1)===id));
  const firstSourceIndex = Math.min(...sourceTracks.map(id=>sourceLayout.indexOf(id)));
  const offsets = sourceTracks.map(id=>sourceLayout.indexOf(id)-firstSourceIndex);
  const activeIndex = Math.max(0,tracks.findIndex(track=>track.id===S.activeVideoTrack));
  let destinations = offsets.map(offset=>tracks[activeIndex+offset]||null);
  if (destinations.some(track=>track?.locked)) { log('manual-log','Hedef video kanallarından biri kilitli; yapıştırma yapılmadı.','error'); return false; }
  const time = Math.max(0,Number(currentOutputTime())||0), origin = Math.min(...originals.map(clipTimelineStart));
  const pending = originals.map(item=>({original:item,item:cloneTimelineItem(item,'video'),start:time+clipTimelineStart(item)-origin}));
  const collides = !S.timelineRipple && pending.some(({original,item,start})=>{
    const lane=destinations[sourceTracks.indexOf(original.videoTrack||1)];
    return lane&&S.clips.some(other=>(other.videoTrack||1)===lane.id&&start<clipTimelineEnd(other)-.00001&&start+clipOutputDuration(item)>clipTimelineStart(other)+.00001);
  });
  remember(); pausePreview();
  const destinationBase = collides ? tracks.length : activeIndex;
  for (const offset of offsets) while (S.videoTracks.length <= destinationBase+offset) addVideoTrack({remember:false,redraw:false});
  destinations=offsets.map(offset=>S.videoTracks[destinationBase+offset]);
  const ids=new Map();
  for(const {original,item,start} of pending){item.timelineStart=start;item.videoTrack=destinations[sourceTracks.indexOf(original.videoTrack||1)].id;ids.set(original.clipId,item.clipId);S.clips.push(hydrateClip(item));}
  S.transitions.push(...timelineClipboard.transitions.map(item=>({...item,leftClipId:ids.get(item.leftClipId),rightClipId:ids.get(item.rightClipId)})));
  S.clips.sort((a,b)=>clipTimelineStart(a)-clipTimelineStart(b)||(a.videoTrack||1)-(b.videoTrack||1));
  S.manualId ||= pending[0].item.fileId; S.manualName ||= pending[0].item.name||'';
  S.duration=Math.max(S.duration||0,...pending.map(({item})=>item.sourceDuration||item.end));
  const pasted=pending.map(entry=>entry.item);
  setTimelineVideoSelection(pasted,pasted[0]); S.preview=S.selected;
  S.timelineCursor=time; resetLiveTransition();clampClipTransitions();drawClips();
  seekOutputTime(clipTimelineStart(pasted[0]));setTimelineVideoSelection(pasted,pasted[0]);scheduleAutosave();
  log('manual-log',pasted.length+' bağımsız klip zaman aralıkları ve kanal düzeni korunarak yapıştırıldı.','info');
  return pasted;
}

function beginTimelineVideoGroupDrag(event, anchor, button) {
  const items=selectedTimelineVideos(),locked=items.some(isVideoTrackLocked);
  event.preventDefault();event.stopImmediatePropagation();pausePreview();
  const timeline=el('timeline'),startX=event.clientX,startY=event.clientY,startScroll=timeline.scrollLeft;
  const previousHistory=[...S.history];
  const originals=items.map(item=>({item,start:clipTimelineStart(item),track:item.videoTrack||1,node:[...timeline.querySelectorAll('#track .clip')].find(node=>S.clips[+node.dataset.index]===item)}));
  const minimum=Math.min(...originals.map(entry=>entry.start)),maximum=Math.max(...items.map(clipTimelineEnd));
  let x=startX,y=startY,moved=false,remembered=false,frame=0,active=true,delta=0;
  const update=()=>{
    if(!moved||locked)return;if(!remembered){remember();remembered=true;}
    autoScrollTimelinePointer(timeline,x);const raw=Math.max(-minimum,(x-startX+timeline.scrollLeft-startScroll)/S.zoom);
    delta=raw;
    if(S.timelineMagnet){const own=new Set(items),edges=[0,currentOutputTime(),...S.clips.filter(item=>!own.has(item)).flatMap(item=>[clipTimelineStart(item),clipTimelineEnd(item)]),...(S.texts||[]).flatMap(item=>[item.start,item.end]),...(S.stickers||[]).flatMap(item=>[item.start,item.end]),...(S.imageLayers||[]).flatMap(item=>[item.start,item.end]),...(S.audioLayers||[]).flatMap(item=>[item.start,item.end])];let best=10/Math.max(.02,S.zoom),target=null;
      for(const edge of edges)for(const boundary of [minimum,maximum]){const candidate=edge-boundary,distance=Math.abs(candidate-raw);if(candidate>=-minimum&&distance<=best){best=distance;delta=candidate;target=edge;}}
      if(target===null)clearTimelineSnapGuide();else drawTimelineSnapGuide(target);
    }
    for(const entry of originals){entry.item.timelineStart=entry.start+delta;if(entry.node){entry.node.style.left=(entry.item.timelineStart*S.zoom)+'px';entry.node.classList.add('dragging');}}
  };
  const tick=()=>{if(!active)return;update();frame=requestAnimationFrame(tick);};
  const move=e=>{x=e.clientX;y=e.clientY;if(Math.hypot(x-startX,y-startY)>5)moved=true;e.preventDefault();update();};
  const finish=e=>{
    active=false;cancelAnimationFrame(frame);window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',cancel);window.removeEventListener('keydown',escape,true);clearTimelineSnapGuide();
    S.suppressClick=true;setTimeout(()=>{S.suppressClick=false;},0);
    for(const entry of originals)entry.node?.classList.remove('dragging');
    if(locked&&moved){log('manual-log','Seçimde kilitli bir video kanalı var; grup taşınmadı.','error');return;}
    if(!remembered){setTimelineVideoSelection([anchor],anchor);select(S.clips.indexOf(anchor),false);seekOutputTime(Math.max(clipTimelineStart(anchor),Math.min(clipTimelineEnd(anchor)-.001,timelineTimeAtClientX(e.clientX))));return;}
    const tracks=ensureVideoTracks(),sourceIndices=originals.map(entry=>tracks.findIndex(track=>track.id===entry.track)),anchorIndex=tracks.findIndex(track=>track.id===(anchor.videoTrack||1)),target=videoTrackAtClientY(y),targetIndex=tracks.findIndex(track=>track.id===target);
    const shift=Math.max(-Math.min(...sourceIndices),targetIndex>=0?targetIndex-anchorIndex:0),mapping=new Map();
    for(const entry of originals){const index=tracks.findIndex(track=>track.id===entry.track)+shift;mapping.set(entry.track,tracks[index]||null);}
    if([...mapping.values()].some(track=>track?.locked)){for(const entry of originals){entry.item.timelineStart=entry.start;entry.item.videoTrack=entry.track;}S.history=previousHistory;drawClips();log('manual-log','Hedef kanal kilitli; grup yerinde kaldı.','error');return;}
    const own=new Set(items),collides=!S.timelineRipple&&originals.some(entry=>{const track=mapping.get(entry.track);return track&&S.clips.some(other=>!own.has(other)&&(other.videoTrack||1)===track.id&&clipTimelineStart(entry.item)<clipTimelineEnd(other)-.00001&&clipTimelineEnd(entry.item)>clipTimelineStart(other)+.00001);});
    const minimumLane=Math.min(...sourceIndices),newBase=tracks.length;
    for(const [key,track]of mapping){const sourceIndex=tracks.findIndex(value=>value.id===key),index=collides?newBase+sourceIndex-minimumLane:sourceIndex+shift;
      if(collides||!track){while(S.videoTracks.length<=index)addVideoTrack({remember:false,redraw:false});mapping.set(key,S.videoTracks[index]);}}
    for(const entry of originals)entry.item.videoTrack=mapping.get(entry.track).id;
    S.clips.sort((a,b)=>clipTimelineStart(a)-clipTimelineStart(b));clampClipTransitions();setTimelineVideoSelection(items,anchor);drawClips();seekOutputTime(clipTimelineStart(anchor));setTimelineVideoSelection(items,anchor);scheduleAutosave();
  };
  const cancel=()=>{active=false;cancelAnimationFrame(frame);window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',cancel);window.removeEventListener('keydown',escape,true);for(const entry of originals){entry.item.timelineStart=entry.start;entry.item.videoTrack=entry.track;entry.node?.classList.remove('dragging');}if(remembered)S.history=previousHistory;clearTimelineSnapGuide();drawClips();};
  const escape=event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();cancel();}};
  frame=requestAnimationFrame(tick);window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',cancel);window.addEventListener('keydown',escape,true);
}

function installTimelineVideoSelection() {
  const timeline=el('timeline');
  if(typeof timeline?.querySelectorAll!=='function')return;
  const badge=document.createElement('span');badge.id='timeline-selection-count';badge.className='timeline-selection-count';badge.hidden=true;badge.title='Klip ayarları odaklanan klibe uygulanır. Seçimi birlikte taşıyabilir, silebilir veya kopyalayabilirsiniz.';el('timeline-magnet').before(badge);
  timeline.addEventListener('pointerdown',event=>{
    if(event.button!==0||timelineToolsBlocked())return;
    const node=event.target.closest('#track .clip');
    if(!node){if(!event.target.closest('.track-control'))S.selectedVideoClipIds=[];return;}
    if(event.target.closest('.trim-handle,.zoom-keyframe-marker'))return;
    const item=S.clips[+node.dataset.index];if(!item)return;
    timeline.focus({preventScroll:true});
    if(event.ctrlKey||event.metaKey){event.preventDefault();event.stopImmediatePropagation();const items=selectedTimelineVideos(),selected=items.includes(item);setTimelineVideoSelection(selected?items.filter(value=>value!==item):[...items,item],selected?items.filter(value=>value!==item).at(-1):item);return;}
    const items=selectedTimelineVideos();
    if(items.length>1&&items.includes(item)){event.stopImmediatePropagation();beginTimelineVideoGroupDrag(event,item,node);return;}
    S.selectedVideoClipIds=[item.clipId];
  },true);
  timeline.addEventListener('click',event=>{if((event.ctrlKey||event.metaKey)&&event.target.closest('#track .clip')){event.preventDefault();event.stopImmediatePropagation();}},true);
  document.addEventListener('keydown',event=>{
    const focused=document.activeElement;
    if(timelineToolsBlocked()||focused?.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(focused?.tagName||'')||event.isComposing)return;
    if(!timeline.contains(focused))return;
    const key=event.key.toLowerCase();
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&key==='a'){event.preventDefault();event.stopImmediatePropagation();setTimelineVideoSelection([...S.clips],S.clips[S.selected]||S.clips[0]);return;}
    if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&(key==='delete'||key==='backspace')&&selectedTimelineVideos().length>1){event.preventDefault();event.stopImmediatePropagation();deleteTimelineVideoSelection();}
  },true);
  paintTimelineVideoSelection();
}

function normalizedTimelineCrop(value) {
  const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const width = Math.max(.01, Math.min(1, number(value?.width, 1)));
  const height = Math.max(.01, Math.min(1, number(value?.height, 1)));
  return {x:Math.max(0, Math.min(1 - width, number(value?.x, 0))),
    y:Math.max(0, Math.min(1 - height, number(value?.y, 0))), width, height};
}

function cropPresetRectangle(aspect, sourceWidth, sourceHeight, current) {
  const original = normalizedTimelineCrop(current);
  if (!(aspect > 0)) return original;
  const ratio = aspect * sourceHeight / sourceWidth;
  let width = original.width, height = width / ratio;
  if (height > original.height) { height = original.height; width = height * ratio; }
  return normalizedTimelineCrop({x:original.x+(original.width-width)/2, y:original.y+(original.height-height)/2, width, height});
}

function paintTimelineCrop(preserveInput = null) {
  const session = timelineCropSession;
  if (!session) return;
  const crop = session.draft, rect = el('timeline-crop-selection');
  Object.assign(rect.style, {left:crop.x*100+'%', top:crop.y*100+'%', width:crop.width*100+'%', height:crop.height*100+'%'});
  for (const field of ['x','y','width','height']) if (field !== preserveInput) el('timeline-crop-'+field).value = (crop[field]*100).toFixed(2);
  el('timeline-crop-size').textContent = session.sourceWidth ? Math.round(crop.width*session.sourceWidth)+' × '+Math.round(crop.height*session.sourceHeight)+' px' : '';
}

function fitTimelineCropStage() {
  const session = timelineCropSession;
  if (!session?.sourceWidth) return;
  const host = el('timeline-crop-preview'), stage = el('timeline-crop-stage');
  const ratio = session.sourceWidth / session.sourceHeight;
  const width = Math.min(host.clientWidth, host.clientHeight * ratio);
  stage.style.width = width+'px';
  stage.style.height = width/ratio+'px';
}

function loadTimelineCropFrame(session, src, time) {
  return new Promise((resolve,reject) => {
    const video = document.createElement('video');
    session.video = video;
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    let settled = false, positioned = false;
    const cleanup = () => {
      clearTimeout(timeout);
      for (const name of ['loadedmetadata','loadeddata','canplay','seeked','error']) video.removeEventListener(name, update);
    };
    const finish = error => { if (settled) return; settled = true; cleanup(); session.cancelLoad = null; error ? reject(error) : resolve(video); };
    const update = () => {
      if (session !== timelineCropSession) return finish(new Error('Kırpma penceresi kapatıldı.'));
      if (video.error) return finish(new Error('Kaynak video karesi okunamadı.'));
      if (video.readyState < 1) return;
      if (!positioned) {
        positioned = true;
        const target = Math.max(0, Math.min(Number.isFinite(video.duration) ? Math.max(0,video.duration-.001) : time, time));
        if (Math.abs(video.currentTime-target) > .0001) { video.currentTime = target; return; }
      }
      if (video.readyState >= 2 && !video.seeking && video.videoWidth && video.videoHeight) finish();
    };
    const timeout = setTimeout(() => finish(new Error('Video karesi zamanında okunamadı. Pencereyi kapatıp yeniden deneyin.')), 15000);
    session.cancelLoad = () => finish(new Error('Kırpma iptal edildi.'));
    for (const name of ['loadedmetadata','loadeddata','canplay','seeked','error']) video.addEventListener(name, update);
    video.src = src;
    video.load();
  });
}

function timelineCropSourceTime(clip, outputTime) {
  const elapsed = Math.max(0, Math.min(clipOutputDuration(clip), outputTime - clipTimelineStart(clip)));
  const offset = elapsed * Math.max(.01, Number(clip.speed) || 1);
  return clip.reverse ? clip.end - offset : clip.start + offset;
}

async function openTimelineCropDialog() {
  if (timelineToolsBlocked()) return false;
  if (S.selectedLayer || S.selectedText || S.selectedSticker || !S.clips[S.selected]) {
    log('manual-log', 'Kırpmak için timeline üzerinde bir video klibi seçin.', 'info');
    return false;
  }
  const clip = hydrateClip(S.clips[S.selected]);
  if (videoTrackState(clip.videoTrack || 1)?.locked) { log('manual-log', 'Video kanalı kilitli.', 'error'); return false; }
  const cursor = currentOutputTime();
  pausePreview();
  const session = {clipId:clip.clipId, timelineId:S.activeTimelineId, projectTimelines:S.timelines,
    draft:normalizedTimelineCrop(clip.crop), sourceWidth:0, sourceHeight:0, ready:false};
  timelineCropSession = session;
  const dialog = el('timeline-crop-dialog');
  el('timeline-crop-apply').disabled = true;
  el('timeline-crop-controls').disabled = true;
  el('timeline-crop-preset').value = 'free';
  el('timeline-crop-title').textContent = 'Videoyu kırp · '+(clip.name || S.manualName || 'Seçili klip');
  el('timeline-crop-status').textContent = 'Oynatma kafasındaki kaynak kare hazırlanıyor…';
  el('timeline-crop-stage').style.visibility = 'hidden';
  dialog.showModal();
  paintTimelineCrop();
  try {
    const time = timelineCropSourceTime(clip, cursor);
    const source = clip.src || '/video/' + encodeURIComponent(clip.fileId || S.manualId);
    const video = await loadTimelineCropFrame(session, source, time);
    if (timelineCropSession !== session) return false;
    session.sourceWidth = video.videoWidth; session.sourceHeight = video.videoHeight;
    const canvas = el('timeline-crop-canvas'), ratio = Math.min(1,1920/video.videoWidth,1080/video.videoHeight);
    canvas.width = Math.max(1,Math.round(video.videoWidth*ratio)); canvas.height = Math.max(1,Math.round(video.videoHeight*ratio));
    canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
    session.ready = true;
    el('timeline-crop-stage').style.visibility = '';
    el('timeline-crop-apply').disabled = false;
    el('timeline-crop-controls').disabled = false;
    el('timeline-crop-status').textContent = 'Çerçeveyi taşıyın veya kenarlardan sürükleyin. Dışarıda kalan bölüm gizlenir; kaynak dosya değişmez.';
    fitTimelineCropStage(); paintTimelineCrop();
    return true;
  } catch(error) {
    if (timelineCropSession === session) el('timeline-crop-status').textContent = error.message;
    return false;
  }
}

function closeTimelineCrop() {
  const session = timelineCropSession;
  timelineCropSession = null;
  session?.cancelLoad?.();
  session?.endGesture?.();
  if (session?.video) { session.video.pause(); session.video.removeAttribute('src'); session.video.load(); }
}

function applyTimelineCrop() {
  const session = timelineCropSession;
  if (!session?.ready || timelineToolsBlocked({allowCrop:true})) return false;
  const clip = session.projectTimelines === S.timelines && session.timelineId === S.activeTimelineId && S.clips.find(item => item.clipId === session.clipId);
  if (!clip || videoTrackState(clip.videoTrack || 1)?.locked) {
    el('timeline-crop-status').textContent = 'Klip değişti veya kanalı kilitlendi. İşlem uygulanmadı.';
    return false;
  }
  const crop = normalizedTimelineCrop(session.draft);
  if (JSON.stringify(crop) !== JSON.stringify(normalizedTimelineCrop(clip.crop))) {
    remember();
    clip.crop = crop;
    resetLiveTransition();
    drawClips();
    applyVideoEffectPreview();
    scheduleAutosave();
    log('manual-log', 'Kırpma uygulandı. Kaynak video korunuyor; geri alabilir veya kırpmayı sıfırlayabilirsiniz.', 'info');
  }
  el('timeline-crop-dialog').close();
  return crop;
}

function beginTimelineCropGesture(event) {
  const session = timelineCropSession;
  if (event.button !== 0 || !session?.ready) return;
  event.preventDefault();
  const handle = event.target.closest('[data-crop-handle]')?.dataset.cropHandle || 'move';
  const stage = el('timeline-crop-stage').getBoundingClientRect();
  if (!stage.width || !stage.height) return;
  const original = {...session.draft}, startX = event.clientX, startY = event.clientY;
  const minimumX = Math.max(.01,2/session.sourceWidth), minimumY = Math.max(.01,2/session.sourceHeight);
  const move = e => {
    const dx = (e.clientX-startX)/stage.width, dy = (e.clientY-startY)/stage.height;
    let left = original.x, right = left+original.width, top = original.y, bottom = top+original.height;
    if (handle === 'move') {
      left = Math.max(0,Math.min(1-original.width,original.x+dx));
      top = Math.max(0,Math.min(1-original.height,original.y+dy));
      right = left+original.width; bottom = top+original.height;
    } else {
      if (handle.includes('w')) left = Math.max(0,Math.min(right-minimumX,original.x+dx));
      if (handle.includes('e')) right = Math.max(left+minimumX,Math.min(1,original.x+original.width+dx));
      if (handle.includes('n')) top = Math.max(0,Math.min(bottom-minimumY,original.y+dy));
      if (handle.includes('s')) bottom = Math.max(top+minimumY,Math.min(1,original.y+original.height+dy));
      el('timeline-crop-preset').value = 'free';
    }
    session.draft = normalizedTimelineCrop({x:left,y:top,width:right-left,height:bottom-top});
    paintTimelineCrop();
  };
  const end = () => {
    window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',end); window.removeEventListener('pointercancel',end);
    session.endGesture = null;
  };
  session.endGesture = end;
  window.addEventListener('pointermove',move); window.addEventListener('pointerup',end); window.addEventListener('pointercancel',end);
}

document.addEventListener('keydown',timelineClipboardKeydown,true);
el('timeline-crop').onclick = openTimelineCropDialog;
el('timeline-crop-cancel').onclick = () => el('timeline-crop-dialog').close();
el('timeline-crop-close').onclick = () => el('timeline-crop-dialog').close();
el('timeline-crop-dialog').addEventListener('close',closeTimelineCrop);
el('timeline-crop-dialog').addEventListener('keydown',event => event.stopPropagation());
el('timeline-crop-apply').onclick = applyTimelineCrop;
el('timeline-crop-selection').onpointerdown = beginTimelineCropGesture;
el('timeline-crop-reset').onclick = () => {
  if (!timelineCropSession?.ready) return;
  timelineCropSession.draft = {x:0,y:0,width:1,height:1};
  el('timeline-crop-preset').value = 'free'; paintTimelineCrop();
};
el('timeline-crop-preset').onchange = event => {
  const session = timelineCropSession;
  if (!session?.ready || event.target.value === 'free') return;
  const [w,h] = event.target.value.split(':').map(Number);
  session.draft = cropPresetRectangle(w/h,session.sourceWidth,session.sourceHeight,session.draft);
  paintTimelineCrop();
};
for (const field of ['x','y','width','height']) {
  el('timeline-crop-'+field).oninput = event => {
    const session = timelineCropSession;
    if (!session?.ready || !Number.isFinite(event.target.valueAsNumber)) return;
    session.draft = normalizedTimelineCrop({...session.draft,[field]:event.target.valueAsNumber/100});
    el('timeline-crop-preset').value = 'free'; paintTimelineCrop(field);
  };
  el('timeline-crop-'+field).onchange = () => paintTimelineCrop();
}
new ResizeObserver(fitTimelineCropStage).observe(el('timeline-crop-preview'));
installTimelineVideoSelection();
