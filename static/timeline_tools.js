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
  S.selectedTextKeyframe = S.selectedImageKeyframe = S.selectedZoomKeyframe = null;
  if (type === 'video') {
    const duration = clipOutputDuration(item);
    const occupied = S.clips.some(clip => (Number(clip.videoTrack) || 1) === targetTrack.id &&
      clipTimelineStart(clip) < time + duration - .000001 && clipTimelineEnd(clip) > time + .000001);
    if (occupied) {
      targetTrack = addVideoTrack({remember:false, redraw:false});
      log('manual-log', 'Bu aralık dolu olduğu için kopya ' + targetTrack.name + ' kanalına eklendi.', 'info');
    }
    item.timelineStart = time;
    item.videoTrack = targetTrack.id;
    S.activeVideoTrack = targetTrack.id;
    S.clips.push(hydrateClip(item));
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
