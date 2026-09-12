/* A shared output clock for parallel video channels, gaps and cropped sources.
   The original single-track transport remains in use for legacy timelines. */
(() => {
  const primary = el('manual-video'), stage = el('preview-stage');
  const host = document.createElement('div');
  host.id = 'video-composite'; host.className = 'video-composite';
  stage.insertBefore(host, el('media-overlay'));
  const controls = document.createElement('div');
  controls.className = 'composite-controls'; controls.hidden = true;
  controls.innerHTML = '<button type="button" aria-label="Oynat / duraklat">▶</button><input class="composite-seek" type="range" min="0" max="1" step="0.001" value="0" aria-label="Videoda saniye seç"><span>00:00.00</span><label>Ses <input class="composite-volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="Önizleme ses düzeyi"></label>';
  el('preview-shell').after(controls);
  const playButton = controls.querySelector('button'), seekBar = controls.querySelector('.composite-seek');
  const add = document.createElement('button'); add.type = 'button'; add.id = 'video-track-add';
  add.className = 'timeline-fit'; add.textContent = '＋ Video kanalı'; add.onclick = () => addVideoTrack();
  el('timeline-fit').before(add);
  let entered = false, playing = false, cursor = 0, anchor = 0, started = 0, raf = 0, generation = 0, painting = false, masterVolume = 1, audioContext = null;
  const entries = new Map();
  const groups = new Map();
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function cropOf(clip) {
    const c = clip.crop || {}, x = clamp(Number(c.x) || 0, 0, .999), y = clamp(Number(c.y) || 0, 0, .999);
    return {x, y, width: clamp(Number(c.width) || 1, .001, 1 - x), height: clamp(Number(c.height) || 1, .001, 1 - y)};
  }
  function enabled() {
    if ((S.videoTracks?.length || 1) > 1 || S.clips.some(c => (c.videoTrack || 1) > 1)) return true;
    let end = 0;
    for (const clip of [...S.clips].sort((a, b) => clipTimelineStart(a) - clipTimelineStart(b))) {
      const c = cropOf(clip);
      if (clip.reverse || c.x || c.y || c.width < .99999 || c.height < .99999 || clipTimelineStart(clip) > end + .001) return true;
      end = Math.max(end, clipTimelineEnd(clip));
    }
    return outDuration() > end + .001;
  }
  function enter() {
    if (entered) return;
    entered = true;
    const clip = S.clips[S.preview];
    cursor = Number.isFinite(S.timelineCursor) ? S.timelineCursor : clip ? clipTimelineStart(clip) + clamp((primary.currentTime - clip.start) / (+clip.speed || 1), 0, clipOutputDuration(clip)) : 0;
    cursor = clamp(cursor, 0, outDuration()); anchor = cursor;
    primary.pause(); cancelAnimationFrame(S.previewFrame); S.previewFrame = 0;
    el('transition-video').pause(); el('transition-video').style.visibility = 'hidden'; el('transition-flash').style.opacity = '0';
    primary.style.visibility = 'hidden'; primary.controls = false;
    el('mask-image-overlay').classList.add('hidden'); el('manual-placeholder').classList.toggle('hidden', !!outDuration());
    controls.hidden = false; host.hidden = false;
  }
  function time() { enter(); return clamp(playing ? anchor + (performance.now() - started) / 1000 : cursor, 0, outDuration()); }
  function dispose(entry) {
    entry.video.pause(); entry.video.onloadeddata = entry.video.onseeked = entry.video.onerror = null;
    entry.video.removeAttribute('src'); entry.video.load(); entry.wrap.remove(); entry.graph?.source.disconnect(); entry.graph?.gain.disconnect();
  }
  function reset() {
    generation++; playing = false; cancelAnimationFrame(raf); raf = 0;
    for (const entry of entries.values()) dispose(entry); entries.clear();
    for (const group of groups.values()) group.remove(); groups.clear();
    entered = false; cursor = anchor = 0; controls.hidden = true; host.hidden = true;
    primary.style.visibility = S.trackState.video.visible ? 'visible' : 'hidden'; primary.controls = true;
    el('transition-video').style.visibility = S.trackState.video.visible ? 'visible' : 'hidden';
  }
  function audioGraph(entry) {
    if (entry.graph) return entry.graph;
    const Class = window.AudioContext || window.webkitAudioContext; if (!Class) return null;
    try {
      audioContext ||= new Class(); const source = audioContext.createMediaElementSource(entry.video), highpass = audioContext.createBiquadFilter(), presence = audioContext.createBiquadFilter(), lowpass = audioContext.createBiquadFilter(), compressor = audioContext.createDynamicsCompressor(), gain = audioContext.createGain();
      highpass.type = 'highpass'; lowpass.type = 'lowpass'; presence.type = 'peaking'; presence.frequency.value = 3000;
      source.connect(highpass).connect(presence).connect(lowpass).connect(compressor).connect(gain).connect(audioContext.destination);
      return entry.graph = {source, highpass, presence, lowpass, compressor, gain};
    } catch (error) { console.warn('Kanal ses zinciri kurulamadı', error); return null; }
  }
  function updateAudio(entry, clip, sourceTime, weight) {
    const track = videoTrackState(clip.videoTrack), volume = (track.muted || clip.muted || clip.reverse ? 0 : clipAudioPreviewVolume(clip, sourceTime) * weight * masterVolume);
    const graph = audioGraph(entry); entry.video.muted = volume === 0;
    if (!graph) { entry.video.volume = Math.min(1, volume); return; }
    entry.video.volume = 1; const now = audioContext.currentTime, set = (param, value) => param.setTargetAtTime(value, now, .02);
    const enhance = !!clip.enhanceVoice, denoise = !!clip.noiseReduction, normalize = !!clip.normalizeAudio;
    set(graph.highpass.frequency, denoise ? 115 : enhance ? 80 : 10); set(graph.lowpass.frequency, denoise ? 8800 : enhance ? 12000 : 22000);
    set(graph.presence.gain, enhance ? 3.5 : 0); set(graph.compressor.threshold, normalize ? -20 : enhance ? -24 : denoise ? -34 : 0);
    set(graph.compressor.knee, normalize || enhance ? 12 : 0); set(graph.compressor.ratio, normalize ? 4 : enhance ? 3 : denoise ? 10 : 1);
    set(graph.gain.gain, volume * (normalize ? 1.18 : 1) * (enhance ? 1.06 : 1));
    if (playing && audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  }
  function entryFor(clip) {
    let entry = entries.get(clip.clipId); const src = clip.src || '/video/' + encodeURIComponent(clip.fileId || S.manualId);
    if (entry && entry.src !== src) { dispose(entry); entries.delete(clip.clipId); entry = null; }
    if (entry) return entry;
    const wrap = document.createElement('div'), video = document.createElement('video'), canvas = document.createElement('canvas'), mask = document.createElement('img');
    wrap.className = 'composite-layer'; wrap.dataset.clipId = clip.clipId; canvas.className = 'composite-frame'; video.className = 'composite-source'; mask.className = 'composite-mask'; mask.hidden = true;
    video.playsInline = true; video.preload = 'auto'; video.src = src; video.muted = true; wrap.append(video, canvas, mask); host.append(wrap);
    entry = {wrap, video, canvas, mask, src, clip, desired: clip.start, graph: null, lastPainted: -1}; entries.set(clip.clipId, entry);
    video.onloadeddata = video.onseeked = () => { if (entries.get(clip.clipId) === entry) { paint(); if (playing && entry.playable) video.play().catch(() => {}); } };
    video.onerror = () => { if (!entry.failed) { entry.failed = true; log('manual-log', (clip.name || 'Video') + ' önizlemesi yüklenemedi. Dosyanın erişilebilir olduğunu kontrol edin.', 'error'); } };
    video.load(); return entry;
  }
  function transitionAt(clip, t) {
    const transition = S.transitions.find(item => !item.suspended && item.leftClipId === clip.clipId);
    if (!transition) return null;
    const next = S.clips.find(item => item.clipId === transition.rightClipId), cut = clipTimelineEnd(clip), duration = transition.duration;
    if (!next || (next.videoTrack || 1) !== (clip.videoTrack || 1) || t < cut - duration || t >= cut) return null;
    return {next, type: transition.type, duration, cut, progress: clamp((t - cut + duration) / duration, 0, 1)};
  }
  function transitionStyle(entry, role, transition) {
    entry.wrap.style.clipPath = 'none'; entry.wrap.style.transform = 'none'; entry.wrap.style.filter = 'none'; entry.wrap.style.opacity = '1';entry.wrap.style.mixBlendMode='normal';
    if (!transition) return;
    const p = transition.progress, type = transition.type, incoming = role === 'incoming';
    if (type === 'fadeblack' || type === 'fadewhite') { entry.wrap.style.opacity = String(incoming ? Math.max(0, p * 2 - 1) : Math.max(0, 1 - p * 2)); return; }
    if (['wipeleft','smoothleft','wiperight','smoothright','wipeup','smoothup','wipedown','smoothdown'].includes(type)) {
      if (incoming) entry.wrap.style.clipPath = /left$/.test(type) ? 'inset(0 '+((1-p)*100)+'% 0 0)' : /right$/.test(type) ? 'inset(0 0 0 '+((1-p)*100)+'%)' : /up$/.test(type) ? 'inset(0 0 '+((1-p)*100)+'% 0)' : 'inset('+((1-p)*100)+'% 0 0 0)';
      return;
    }
    if (type.startsWith('slide')) { const distance = incoming ? (1-p)*100 : -p*100, direction = /right|down/.test(type) ? -1 : 1; entry.wrap.style.transform = (/up|down/.test(type) ? 'translateY(' : 'translateX(')+(distance*direction)+'%)'; return; }
    if (['circleopen','circlecrop','circleclose','radial'].includes(type)) { if(incoming) entry.wrap.style.clipPath='circle('+(p*72)+'% at 50% 50%)'; return; }
    if (['rectcrop','vertopen','vertclose','horzopen','horzclose'].includes(type)) { if(incoming) entry.wrap.style.clipPath=/vert/.test(type)?'inset(0 '+((1-p)*50)+'%)':/horz/.test(type)?'inset('+((1-p)*50)+'% 0)':'inset('+((1-p)*50)+'%)'; return; }
    if (type === 'diagtl' || type === 'diagbr') { if(incoming) entry.wrap.style.clipPath='polygon(0 0,'+(p*200)+'% 0,0 '+(p*200)+'%)'; return; }
    entry.wrap.style.opacity = String(incoming ? p : 1-p);
    entry.wrap.style.mixBlendMode = 'plus-lighter';
    if (type === 'zoomin') entry.wrap.style.transform = 'scale('+(incoming ? 1.08-p*.08 : 1)+')';
    if (type === 'pixelize') entry.wrap.style.filter = 'blur('+((incoming?1-p:p)*6)+'px)';
  }
  function drawFrame(entry, clip, t, sourceTime) {
    const {video, canvas} = entry; if (video.readyState < 2 || !video.videoWidth) return;
    const dpr = Math.min(2, devicePixelRatio || 1), width = Math.max(2, Math.round(stage.clientWidth*dpr)), height = Math.max(2, Math.round(stage.clientHeight*dpr));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height}
    const ctx = canvas.getContext('2d', {willReadFrequently:clip.backgroundMode==='chroma'}), crop=cropOf(clip), sw=video.videoWidth*crop.width, sh=video.videoHeight*crop.height;
    const ratio=clip.fit==='contain'?Math.min(width/sw,height/sh):Math.max(width/sw,height/sh), dw=clip.fit==='stretch'?width:sw*ratio, dh=clip.fit==='stretch'?height:sh*ratio;
    ctx.clearRect(0,0,width,height);ctx.drawImage(video,video.videoWidth*crop.x,video.videoHeight*crop.y,sw,sh,(width-dw)/2,(height-dh)/2,dw,dh);
    if(clip.backgroundMode==='chroma'){
      const pixels=ctx.getImageData(0,0,width,height),hex=(clip.keyColor||'#00ff00').slice(1),r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16),threshold=Math.max(.01,clip.keySimilarity/100),blend=Math.max(.001,clip.keyBlend/100);
      for(let i=0;i<pixels.data.length;i+=4){const distance=Math.hypot(pixels.data[i]-r,pixels.data[i+1]-g,pixels.data[i+2]-b)/441.673;pixels.data[i+3]*=clamp((distance-threshold)/blend,0,1)}ctx.putImageData(pixels,0,0);
    }
    const zoom=zoomStateAtOutputTime(clip,t),animation=clipAnimationStyle(clip,clip.start+Math.max(0,t-clipTimelineStart(clip))*(+clip.speed||1));
    setVideoEffect(canvas,{...clip,scale:zoom.scale,opacity:100,zoomFocusX:zoom.x,zoomFocusY:zoom.y},animation.filter,animation.transform);canvas.style.opacity=String(zoom.opacity/100);
    const brush=buildBrushMaskUrl(clip);canvas.style.maskImage=canvas.style.webkitMaskImage=brush?'url("'+brush+'")':'none';canvas.style.maskSize=canvas.style.webkitMaskSize='100% 100%';
    const asset=clip.maskImageId?assetById(clip.maskImageId):null,maskSrc=asset?.src||clip.maskImageSrc;
    entry.mask.hidden=!(maskSrc&&clip.mask!=='none');if(!entry.mask.hidden){if(entry.mask.getAttribute('src')!==maskSrc)entry.mask.src=maskSrc;entry.mask.style.clipPath=maskClipPath(clip)}
    entry.lastPainted=sourceTime;entry.canvas.dataset.outputTime=t.toFixed(4);entry.canvas.dataset.sourceTime=video.currentTime.toFixed(4);
  }
  function paint(force=false) {
    if(!enabled()){if(entered)reset();return}if(painting)return;enter();painting=true;
    try{
      const t=time(),active=new Map(),wanted=new Set();
      for(const clip of S.clips){if(t>=clipTimelineStart(clip)&&t<clipTimelineEnd(clip)){
        const transition=transitionAt(clip,t);active.set(clip.clipId,{clip,role:'outgoing',transition});if(transition)active.set(transition.next.clipId,{clip:transition.next,role:'incoming',transition});
      }}
      for(const clip of S.clips){if(clipTimelineStart(clip)<=t+2&&clipTimelineEnd(clip)>=t-.2||active.has(clip.clipId))wanted.add(clip.clipId)}
      for(const[id,entry]of entries)if(!wanted.has(id)){dispose(entry);entries.delete(id)}
      for(const clip of S.clips){if(!wanted.has(clip.clipId))continue;const entry=entryFor(clip),state=active.get(clip.clipId),track=videoTrackState(clip.videoTrack);let group=groups.get(track.id);if(!group){group=document.createElement('div');group.className='composite-track';group.dataset.videoTrack=track.id;group.style.zIndex=String(track.id);groups.set(track.id,group);host.append(group)}if(entry.wrap.parentNode!==group)group.append(entry.wrap);entry.clip=clip;entry.active=!!state;entry.wrap.hidden=!state||!track.visible;entry.wrap.style.zIndex=String(state?.role==='incoming'?1:0);
        const relative=t-clipTimelineStart(clip),speed=+clip.speed||1,sourceDuration=clip.sourceDuration||clip.end,rawSourceTime=clip.reverse?clip.end-relative*speed:clip.start+relative*speed,missingHandle=state?.role==='incoming'&&(rawSourceTime<0||rawSourceTime>=sourceDuration),sourceTime=clamp(rawSourceTime,0,Math.max(0,sourceDuration-.001));entry.desired=sourceTime;entry.playable=!!state&&!clip.reverse&&!missingHandle;
        if(entry.video.readyState>=1&&(force||Math.abs(entry.video.currentTime-sourceTime)>(playing&&!clip.reverse ? .18 : .025))&&!entry.video.seeking)entry.video.currentTime=sourceTime;
        entry.video.playbackRate=speed;entry.video.preservesPitch=!clip.changePitch;
        if(state){const weight=missingHandle?0:state.transition?(state.role==='incoming'?state.transition.progress:1-state.transition.progress):1;updateAudio(entry,clip,sourceTime,weight);transitionStyle(entry,state.role,state.transition);drawFrame(entry,clip,t,sourceTime);if(!entry.playable)entry.video.pause();else if(playing&&entry.video.paused&&entry.video.readyState>=2)entry.video.play().catch(()=>{})}
        else{entry.video.pause();entry.video.muted=true}
      }
      const value=ft(t)+' / '+ft(outDuration());el('timecode').textContent=el('timecode-top').textContent=value;seekBar.max=String(outDuration()||1);seekBar.value=String(t);controls.querySelector('span').textContent=ft(t);playButton.textContent=playing?'❚❚':'▶';
      el('manual-placeholder').classList.toggle('hidden',!!outDuration());drawPlayhead();drawTextOverlay();drawMediaOverlay();drawStickerOverlay();syncProjectAudio();
    }finally{painting=false}
  }
  function tick(){if(!playing)return;cursor=time();if(cursor>=outDuration()-.001){pause();return}paint();raf=requestAnimationFrame(tick)}
  function seek(value){enter();cursor=clamp(Number(value)||0,0,outDuration());anchor=cursor;started=performance.now();S.timelineCursor=cursor;S.previewGap=!S.clips.some(clip=>cursor>=clipTimelineStart(clip)&&cursor<clipTimelineEnd(clip));const index=S.clips.findIndex(clip=>(clip.videoTrack||1)===(S.activeVideoTrack||1)&&cursor>=clipTimelineStart(clip)&&cursor<clipTimelineEnd(clip));if(index>=0)S.preview=index;paint(true);return cursor}
  async function play(){enter();if(playing)return;if(cursor>=outDuration()-.001)cursor=0;const token=++generation;paint(true);const until=performance.now()+8000;while([...entries.values()].some(entry=>entry.active&&!entry.failed&&(entry.video.readyState<2||entry.video.seeking))&&performance.now()<until){await new Promise(resolve=>setTimeout(resolve,20));if(token!==generation)return}if(token!==generation)return;playing=true;anchor=cursor;started=performance.now();audioContext?.resume().catch(()=>{});paint();cancelAnimationFrame(raf);raf=requestAnimationFrame(tick)}
  function pause(){if(!entered)return;cursor=time();anchor=cursor;playing=false;generation++;cancelAnimationFrame(raf);raf=0;for(const entry of entries.values())entry.video.pause();stopProjectAudio();playButton.textContent='▶';S.timelineCursor=cursor}
  playButton.onclick=()=>playing?pause():play();seekBar.oninput=()=>{pause();seek(+seekBar.value)};controls.querySelector('.composite-volume').oninput=event=>{masterVolume=+event.target.value;paint()};
  window.multiTrackPreview={enabled,time,isPlaying:()=>playing,play,pause,seek,paint,reset,cropOf};
  window.addEventListener('resize',()=>{if(enabled())paint(true)});
  if(enabled())paint();
})();
