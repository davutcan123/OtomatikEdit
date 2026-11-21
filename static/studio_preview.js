/* Playback-only source selection. Clips and projects keep their original IDs. */
(() => {
  'use strict';
  if (document.body.dataset.studioPreview !== 'available') return;

  const preferences = window.StudioPreferences;
  const slots = new WeakMap(), listeners = new WeakSet(), forced = new Set();
  let restoreAutoTime = null;
  const panels = Object.fromEntries(['manual', 'auto'].map(name => {
    const node = document.querySelector(`[data-preview-controls="${name}"]`);
    return [name, {
      node, select: node.querySelector('select'), status: node.querySelector('[role=status]'),
      retry: node.querySelector('button'), media: new Set(),
    }];
  }));
  const fromSettings = () => preferences.get('layout', {}).previewQuality === 'light' ? 'light' : 'normal';
  let mode = fromSettings();

  function assetPath(raw) {
    if (!raw) return '';
    try {
      const url = new URL(raw, window.location.href);
      return url.origin === window.location.origin && /^\/video\/[^/]+$/.test(url.pathname) ? url.pathname : '';
    } catch { return ''; }
  }
  function playbackURL(path) {
    return path.replace(/^\/video\//, '/preview/') + '?mode=' + mode + (forced.has(path) ? '&force=true' : '');
  }
  function matches(video, slot) {
    if (video.getAttribute('src') !== slot.url) return false;
    if (!video.currentSrc) return true;
    const current = new URL(video.currentSrc);
    return current.pathname + current.search === slot.url;
  }
  function paint(name) {
    if (!name) return;
    const panel = panels[name], entries = [...panel.media].map(video => slots.get(video)).filter(Boolean);
    const failed = entries.some(slot => slot.phase === 'failed');
    const pending = entries.some(slot => slot.phase === 'loading');
    panel.retry.hidden = !failed;
    const message = failed ? 'Video önizlemesi yüklenemedi.'
      : pending ? 'Önizleme hazırlanıyor…'
        : entries.length ? 'Önizleme hazır' : '';
    if (panel.status.textContent !== message) panel.status.textContent = message;
  }
  function release(video) {
    const slot = slots.get(video);
    if (!slot) return;
    slots.delete(video);
    if (slot.surface === 'auto' && restoreAutoTime) {
      video.removeEventListener('loadedmetadata', restoreAutoTime.seek);
      restoreAutoTime = null;
    }
    if (slot.surface) {
      panels[slot.surface].media.delete(video);
      paint(slot.surface);
    }
  }
  function failed(event, video, slot) {
    if (!slot.url.endsWith('&force=true')) {
      event.stopImmediatePropagation();
      forced.add(slot.path);
      slot.url = playbackURL(slot.path);
      slot.phase = 'loading';
      slots.set(video, slot);
      video.src = slot.url;
      video.load();
    } else {
      slot.phase = 'failed';
    }
    paint(slot.surface);
  }

  function url(original) {
    const path = assetPath(original);
    return path ? playbackURL(path) : original;
  }

  function source(video, original, surface) {
    const path = assetPath(original);
    if (!path) { release(video); return original; }
    const url = playbackURL(path);
    const before = slots.get(video);
    if (before?.url === url && before.surface === surface) return url;
    if (before?.surface !== surface || (surface === 'auto' && before?.path !== path)) release(video);
    const loaded = video.getAttribute('src') === url && video.videoWidth > 0;
    const slot = { path, url, surface, phase: loaded ? 'ready' : 'loading' };
    slots.set(video, slot);
    if (surface) panels[surface].media.add(video);
    paint(surface);
    if (!listeners.has(video)) {
      const ready = event => {
        const current = slots.get(video);
        if (!current || !matches(video, current)) return;
        if (!video.videoWidth) {
          failed(event, video, current);
          return;
        }
        current.phase = 'ready';
        paint(current.surface);
      };
      video.addEventListener('loadedmetadata', ready, true);
      video.addEventListener('loadeddata', ready, true);
      video.addEventListener('error', event => {
        const current = slots.get(video);
        if (current && matches(video, current)) failed(event, video, current);
      }, true);
      listeners.add(video);
    }
    return url;
  }

  function refreshManual() {
    if (!S.clips.length) return;
    const at = currentOutputTime();
    pausePreview();
    if (window.multiTrackPreview?.enabled()) {
      window.multiTrackPreview.seek(at);
    } else {
      const clip = S.clips[S.preview];
      if (clip) setPreviewSource(S.preview, clip.start + (at - clipTimelineStart(clip)) * (+clip.speed || 1));
    }
  }
  function refreshAuto() {
    if (!S.autoId || !S.autoData) return;
    const video = document.getElementById('auto-video'), at = restoreAutoTime?.at ?? video.currentTime;
    video.pause();
    if (restoreAutoTime) video.removeEventListener('loadedmetadata', restoreAutoTime.seek);
    const seek = () => {
      if (!video.videoWidth) return;
      video.removeEventListener('loadedmetadata', seek);
      restoreAutoTime = null;
      video.currentTime = Math.min(at, Math.max(0, video.duration - .001));
    };
    restoreAutoTime = { seek, at };
    video.addEventListener('loadedmetadata', seek);
    video.src = source(video, '/video/' + encodeURIComponent(S.autoId), 'auto');
  }
  function setMode(next) {
    if (mode === next) return;
    mode = next;
    for (const panel of Object.values(panels)) panel.select.value = mode;
    if (typeof projectWorkspaceReady !== 'undefined' && projectWorkspaceReady) {
      refreshManual();
      refreshAuto();
    }
  }

  const ready = preferences.ready.then(() => setMode(fromSettings()));
  preferences.subscribe(key => { if (key === 'layout') setMode(fromSettings()); });
  for (const [name, panel] of Object.entries(panels)) {
    panel.node.hidden = false;
    panel.select.value = mode;
    panel.select.onchange = async () => {
      try { await preferences.set('layout', { ...preferences.get('layout', {}), previewQuality: panel.select.value }); }
      catch { panel.status.textContent = 'Önizleme tercihi kaydedilemedi.'; }
    };
    panel.retry.onclick = () => {
      for (const video of panel.media) {
        const slot = slots.get(video);
        if (slot?.phase !== 'failed') continue;
        slot.phase = 'loading';
        video.load();
      }
      paint(name);
    };
  }

  window.StudioMediaPreview = Object.freeze({ url, source, release, ready });
})();
