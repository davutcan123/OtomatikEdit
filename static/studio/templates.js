(() => {
  'use strict';

  const categories = {
    travel: 'Gezi', vertical: 'Dikey sosyal', product: 'Ürün',
    interview: 'Röportaj', education: 'Eğitim', concert: 'Konser',
  };
  const demos = {
    alpine: { id: 'alpine-tour', label: 'Alpler' },
    product: { id: 'product-showcase', label: 'Ürün' },
    session: { id: 'session-lights', label: 'Sahne' },
  };
  const templates = [
    {
      id: 'alpine-postcard', name: 'Alplerden Kartpostal', category: 'travel',
      summary: 'Geniş manzara, zarif açılış başlığı ve rota kapanışı.',
      width: 1920, height: 1080, length: 8, preview: 'alpine', position: 'center', sampleTime: .3,
      video: { fit: 'cover', filter: 'cinema' },
      texts: [
        { text: 'ALPLER / YOL GÜNLÜĞÜ', start: .04, end: .54, x: 61, y: 29, size: 30, fontFamily: 'spacemono', color: '#FFE6B1' },
        { text: 'Alplerden\nKartpostal', start: .08, end: .62, x: 61, y: 43, size: 136, fontFamily: 'instrumentserif', bold: false, animate: true },
        { text: 'Vadinin ötesine doğru', start: .68, end: 1, x: 60, y: 73, size: 54, fontFamily: 'barlowcondensed', backgroundOpacity: .66 },
      ],
    },
    {
      id: 'vertical-cut', name: 'Bir Sonraki Durak', category: 'vertical',
      summary: 'Telefon ekranına sığan kısa açılış ve çağrı metni.',
      width: 1080, height: 1920, length: 7, preview: 'alpine', position: '44% center', sampleTime: .32,
      video: { fit: 'cover', filter: 'teal' },
      texts: [
        { text: 'GEZİ DEFTERİ', start: .02, end: .59, x: 50, y: 16, size: 60, fontFamily: 'ibmplexmono', color: '#E2FF91', backgroundOpacity: .68 },
        { text: 'Bir sonraki\ndurak', start: .06, end: .64, x: 50, y: 38, size: 182, fontFamily: 'barlowcondensed', animate: true },
        { text: 'Rotayı kaydet', start: .58, end: 1, x: 50, y: 79, size: 91, fontFamily: 'barlow', color: '#17240A', background: '#E2FF91', backgroundOpacity: .97, shadow: false },
      ],
    },
    {
      id: 'product-frame', name: 'Ürün Vitrini', category: 'product',
      summary: 'Kare kadraj, ürün adı ve kısa özellik satırı.',
      width: 1080, height: 1080, length: 7, preview: 'product', position: '67% center', sampleTime: .35,
      video: { fit: 'cover', filter: 'golden' },
      texts: [
        { text: 'GÜNLÜK SERİ', start: .07, end: .7, x: 31, y: 29, size: 35, fontFamily: 'ibmplexmono', color: '#FFE0C7' },
        { text: 'Termos', start: .1, end: .75, x: 33, y: 41, size: 106, fontFamily: 'dmseriftext', bold: false, animate: true },
        { text: 'Çelik gövde · 500 ml', start: .18, end: 1, x: 35, y: 56, size: 40, fontFamily: 'barlow', backgroundOpacity: .68 },
      ],
    },
    {
      id: 'interview-nameplate', name: 'Röportaj Alt Bandı', category: 'interview',
      summary: 'Konuşmacı adı ve unvanı için düzenlenebilir alt bant.',
      width: 1920, height: 1080, length: 8, preview: 'session', position: 'center', sampleTime: .42,
      video: { fit: 'cover', filter: 'none' },
      texts: [
        { text: 'Deniz Aydın', start: .12, end: .78, x: 23, y: 76, size: 74, fontFamily: 'barlow', color: '#FFFFFF', background: '#111D56', backgroundOpacity: .92, shadow: false, animate: true },
        { text: 'MÜZİK YAPIMCISI', start: .16, end: .78, x: 23, y: 85, size: 37, fontFamily: 'ibmplexmono', color: '#BCCBFF', background: '#080D29', backgroundOpacity: .9, shadow: false },
      ],
    },
    {
      id: 'lesson-notes', name: 'Işığı Okumak', category: 'education',
      summary: 'Ders başlığı ve adım adım görünen açıklama satırları.',
      width: 1920, height: 1080, length: 8, preview: 'alpine', position: 'center', sampleTime: .22,
      video: { fit: 'cover', filter: 'none' },
      texts: [
        { text: 'FOTOĞRAF DERSİ', start: .02, end: .44, x: 30, y: 25, size: 34, fontFamily: 'spacemono', color: '#A5F3FC', background: '#082F49', backgroundOpacity: .94, shadow: false },
        { text: 'Işığı Okumak', start: .04, end: .48, x: 31, y: 37, size: 92, fontFamily: 'crimsontext', animate: true },
        { text: 'Işık kaynağının yönünü bulun', start: .49, end: .76, x: 49, y: 76, size: 53, fontFamily: 'barlow', backgroundOpacity: .78 },
        { text: 'Gölgelerin uzunluğunu karşılaştırın', start: .77, end: 1, x: 49, y: 76, size: 53, fontFamily: 'barlow', backgroundOpacity: .78 },
      ],
    },
    {
      id: 'concert-session', name: 'Gece Sahnesi', category: 'concert',
      summary: 'Sahne açılışı, sanatçı adı ve performans anonsu.',
      width: 1920, height: 1080, length: 8, preview: 'session', position: 'center', sampleTime: .25,
      video: { fit: 'cover', filter: 'cinema', animation: 'fadein', animationDuration: .45 },
      texts: [
        { text: 'CANLI PERFORMANS', start: .04, end: .62, x: 22, y: 30, size: 36, fontFamily: 'spacemono', color: '#F4AAE0' },
        { text: 'Gece\nSahnesi', start: .09, end: .66, x: 25, y: 49, size: 119, fontFamily: 'fahkwang', animate: true },
        { text: 'Deniz Aydın', start: .63, end: 1, x: 22, y: 78, size: 69, fontFamily: 'barlowcondensed', color: '#FFE1F4', backgroundOpacity: .68 },
      ],
    },
  ];

  let library;
  let preferences;
  let pending = false;

  const make = (tag, text = '') => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  const option = (value, text) => {
    const node = make('option', text);
    node.value = value;
    return node;
  };
  const fold = value => value.toLocaleLowerCase('tr-TR').normalize('NFKD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');

  function textAppearance(item) {
    return {
      text: item.text, fontFamily: item.fontFamily, bold: item.bold !== false, size: item.size,
      x: item.x, y: item.y, color: item.color || '#FFFFFF', outlineColor: '#071120',
      outlineWidth: 0, shadow: item.shadow !== false, background: item.background || '#071120',
      backgroundOpacity: item.backgroundOpacity || 0, rotation: 0,
    };
  }

  function buildTimeline(template, source) {
    const duration = Math.min(template.length, (source.end - source.start) / source.speed);
    if (!Number.isFinite(duration) || duration < .05) throw new Error('Kaynak videonun süresi çok kısa.');
    const mediaEnd = source.reverse ? source.end : source.start + duration * source.speed;
    const mediaStart = source.reverse ? source.end - duration * source.speed : source.start;
    const clip = hydrateClip({
      fileId: source.fileId, assetId: source.assetId, src: '/video/' + encodeURIComponent(source.fileId),
      name: source.name, sourceDuration: source.sourceDuration, start: mediaStart, end: mediaEnd,
      speed: source.speed, reverse: source.reverse, timelineStart: 0, videoTrack: 1, ...template.video,
    });
    const state = emptyTimelineState();
    state.manualId = clip.fileId;
    state.manualName = clip.name;
    state.duration = clip.sourceDuration;
    state.canvas = { width: template.width, height: template.height };
    state.clips = [clip];
    state.selected = state.preview = 0;
    state.texts = template.texts.map(item => {
      const start = Math.max(0, Math.min(duration - .05, item.start * duration));
      const end = Math.min(duration, Math.max(start + .05, item.end * duration));
      const text = { ...textAppearance(item), id: 'T' + state.nextTextId++, start, end, transformKeyframes: [] };
      const movementTime = Math.min(.5, (end - start) / 3);
      if (item.animate && movementTime >= .06) {
        text.transformKeyframes = [
          { id: 'TZ' + state.nextZoomKeyframeId++, time: 0, x: item.x, y: item.y + 2, scale: 95, opacity: 0, easing: 'smoother' },
          { id: 'TZ' + state.nextZoomKeyframeId++, time: movementTime, x: item.x, y: item.y, scale: 100, opacity: 100, easing: 'smoother' },
        ];
      }
      return text;
    });
    return state;
  }

  function clipSource(clip) {
    const fileId = clip.fileId || S.manualId;
    if (!fileId || !Number.isFinite(clip.start) || !Number.isFinite(clip.end)) return null;
    return {
      fileId, assetId: clip.assetId || assetForFile(fileId)?.id,
      name: clip.name || assetForFile(fileId)?.name || S.manualName || 'Video',
      start: clip.start, end: clip.end, sourceDuration: clip.sourceDuration || clip.end,
      speed: clip.speed || 1, reverse: clip.reverse === true,
    };
  }

  function assetSource(asset) {
    if (asset?.kind !== 'video' || !asset?.fileId || !Number.isFinite(asset.duration) || asset.duration < .05) return null;
    return { fileId: asset.fileId, assetId: asset.id, name: asset.name, sourceDuration: asset.duration,
      start: 0, end: asset.duration, speed: 1, reverse: false };
  }

  async function resolveSource(value, template, isCurrent) {
    if (value.startsWith('clip:')) {
      const clip = S.clips.find(item => item.clipId === value.slice(5));
      return { source: clip ? clipSource(clip) : null };
    }
    if (value.startsWith('asset:')) {
      const asset = assetById(value.slice(6));
      const ready = asset?.kind === 'video' && await resolveVideoAssetDuration(asset);
      return { source: ready ? assetSource(asset) : null };
    }
    const demo = demos[template.preview];
    if (value !== 'demo' || !demo) return { source: null };
    const existingDemo = S.mediaAssets.find(item => item.studioDemoId === demo.id && assetSource(item));
    if (existingDemo) return { source: assetSource(existingDemo) };

    const response = await fetch('/static/studio/demo/' + demo.id + '.mp4');
    if (!response.ok) throw new Error('Örnek video açılamadı.');
    const blob = await response.blob();
    if (!isCurrent()) return { source: null };
    const result = await upload(new File([blob], demo.id + '.mp4', { type: 'video/mp4' }));
    if (!isCurrent()) return { source: null };
    const asset = { fileId: result.file_id, name: demo.label + ' · örnek video', kind: result.media_kind,
      duration: Number(result.duration), studioDemoId: demo.id };
    const source = assetSource(asset);
    if (!source) throw new Error('Örnek video okunamadı.');
    return { source, addedAsset: { ...asset, src: '/video/' + encodeURIComponent(asset.fileId) } };
  }

  async function applyTemplate(id, value) {
    const template = templates.find(item => item.id === id);
    if (!template || !value || pending || timelineToolsBlocked()) return false;
    const generation = workspaceGeneration;
    const timeline = timelineGeneration;
    const isCurrent = () => workspaceGeneration === generation && timelineGeneration === timeline && !timelineToolsBlocked();
    const finish = beginDesktopOperation('Şablon hazırlanıyor');
    let success = false;
    pending = true;
    updateApplyControls();
    if (library) library.feedback.textContent = 'Timeline hazırlanıyor…';
    try {
      const { source, addedAsset } = await resolveSource(value, template, isCurrent);
      if (!isCurrent()) {
        if (library) library.feedback.textContent = 'Etkin timeline değişti. Şablonu yeniden uygulayabilirsiniz.';
        return false;
      }
      if (!source) throw new Error('Geçerli bir kaynak video seçin.');
      const previous = { id: S.activeTimelineId, history: [...S.history], cursor: currentOutputTime() };
      const state = buildTimeline(template, source);
      if (addedAsset) {
        addedAsset.id = 'M' + S.nextAssetId++;
        state.clips[0].assetId = addedAsset.id;
        S.mediaAssets.push(addedAsset);
      }
      const item = { id: 'TL' + Date.now().toString(36) + S.nextTimelineId++, name: template.name, state };
      S.timelines.push(item);
      activateTimeline(item);
      S.history.push({ studioTemplateCreation: { id: item.id, previous, addedAssetId: addedAsset?.id } });
      drawClips();
      seekOutputTime(0);
      el('timeline').focus({ preventScroll: true });
      scheduleAutosave();
      const message = template.name + ' yeni timeline’da açıldı.';
      if (library) library.feedback.textContent = message;
      log('manual-log', message, 'info');
      success = true;
      return true;
    } catch (error) {
      if (library) library.feedback.textContent = error.message;
      if (isCurrent()) log('manual-log', error.message, 'error');
      return false;
    } finally {
      pending = false;
      finish();
      if (!success) updateApplyControls();
      else refreshSources(true);
    }
  }

  function undoCreation(entry) {
    const creation = entry?.studioTemplateCreation;
    if (!creation || S.activeTimelineId !== creation.id) return false;
    const previous = S.timelines.find(item => item.id === creation.previous.id);
    const createdIndex = S.timelines.findIndex(item => item.id === creation.id);
    if (!previous || createdIndex < 0) return false;
    S.timelines.splice(createdIndex, 1);
    if (creation.addedAssetId) {
      const asset = assetById(creation.addedAssetId);
      if (asset && !projectAssetUsage(asset, projectPayload()).total) {
        S.mediaAssets = S.mediaAssets.filter(item => item.id !== asset.id);
      }
    }
    activateTimeline(previous);
    S.history = creation.previous.history;
    seekOutputTime(Math.min(creation.previous.cursor, outDuration()));
    drawClips();
    scheduleAutosave();
    refreshSources(true);
    if (library) library.feedback.textContent = 'Şablon timeline’ı geri alındı.';
    log('manual-log', 'Şablon timeline’ı geri alındı.', 'info');
    return true;
  }

  function bindPreferences() {
    const current = window.StudioPreferences;
    if (!current || preferences === current) return;
    preferences = current;
    preferences.subscribe(key => { if (key === 'favorites') renderLibrary(); });
    Promise.resolve(preferences.ready).then(() => renderLibrary()).catch(() => {});
  }

  function favorites() {
    const value = preferences?.get('favorites', []);
    return Array.isArray(value) ? value : [];
  }

  async function toggleFavorite(id, button) {
    if (!preferences) return;
    const key = 'template:' + id;
    const value = favorites();
    button.disabled = true;
    try {
      await preferences.set('favorites', value.includes(key) ? value.filter(item => item !== key) : [...value, key]);
      renderLibrary();
      (library.results.querySelector('[data-template-favorite="' + id + '"]') || library.favoriteOnly).focus();
    } catch {
      library.feedback.textContent = 'Favoriler kaydedilemedi.';
      button.disabled = false;
    }
  }

  function sample(template) {
    const viewport = make('div');
    viewport.className = 'studio-template-viewport';
    const stage = make('div');
    stage.className = 'studio-template-sample';
    stage.style.setProperty('--sample-ratio', String(template.width / template.height));
    const img = make('img');
    img.src = '/static/studio/previews/' + template.preview + '.jpg';
    img.loading = 'lazy';
    img.alt = '';
    img.style.objectPosition = template.position;
    stage.append(img);
    for (const item of template.texts.filter(item => item.start <= template.sampleTime && item.end >= template.sampleTime)) {
      const text = textAppearance(item);
      const layer = make('span', text.text);
      layer.className = 'studio-template-sample-text';
      layer.style.left = text.x + '%';
      layer.style.top = text.y + '%';
      layer.style.color = text.color;
      layer.style.fontSize = (text.size / template.width * 100) + 'cqw';
      if (text.backgroundOpacity) layer.style.background = hexRgba(text.background, text.backgroundOpacity);
      if (text.shadow) layer.style.textShadow = '0 .08em .2em #10101a';
      window.StudioFonts?.paintPreview(layer, text);
      stage.append(layer);
    }
    viewport.append(stage);
    return viewport;
  }

  function renderLibrary() {
    if (!library) return;
    const currentFavorites = favorites();
    const term = fold(library.query.value.trim());
    const visible = templates.filter(template =>
      (!library.category.value || template.category === library.category.value) &&
      (!library.favoriteOnly.checked || currentFavorites.includes('template:' + template.id)) &&
      (!term || fold(template.name + ' ' + categories[template.category] + ' ' + template.summary).includes(term))
    );
    library.favoriteOnly.disabled = !preferences;
    library.empty.textContent = visible.length ? '' : 'Aramanıza uygun şablon bulunamadı.';
    library.results.replaceChildren(...visible.map(template => {
      const card = make('article');
      card.className = 'studio-template-card';
      card.dataset.template = template.id;
      const heading = make('div');
      heading.className = 'studio-library-card-head';
      const title = make('h3', template.name);
      const liked = currentFavorites.includes('template:' + template.id);
      const favorite = make('button', liked ? '★' : '☆');
      favorite.type = 'button';
      favorite.className = 'studio-library-favorite';
      favorite.dataset.templateFavorite = template.id;
      favorite.setAttribute('aria-label', template.name + ' favori');
      favorite.setAttribute('aria-pressed', String(liked));
      favorite.disabled = !preferences;
      favorite.addEventListener('click', () => toggleFavorite(template.id, favorite));
      heading.append(title, favorite);
      const description = make('p', template.summary);
      const foot = make('div');
      foot.className = 'studio-library-card-foot';
      const resolution = make('span', template.width + ' × ' + template.height);
      const demoLabel = make('span', 'Örnek: ' + demos[template.preview].label);
      demoLabel.dataset.templateDemoLabel = '';
      const button = make('button', 'Yeni timeline’da kullan');
      button.type = 'button';
      button.dataset.applyTemplate = template.id;
      button.addEventListener('click', () => applyTemplate(template.id, library.source.value));
      const detail = make('div');
      detail.className = 'studio-template-detail';
      detail.append(resolution, demoLabel);
      foot.append(detail, button);
      card.append(sample(template), heading, description, foot);
      return card;
    }));
    updateApplyControls();
  }

  function updateApplyControls() {
    if (!library) return;
    const disabled = pending || !library.source.value;
    library.source.disabled = pending;
    const showDemo = library.source.value === 'demo';
    library.context.textContent = showDemo ? 'Her kart önizlemedeki örnek videoyu kullanır.'
      : 'Kartlar yerleşimi gösterir. Yeni timeline seçtiğiniz videoyu kullanır.';
    library.results.querySelectorAll('[data-template-demo-label]').forEach(label => { label.hidden = !showDemo; });
    library.results.querySelectorAll('[data-apply-template]').forEach(button => { button.disabled = disabled; });
  }

  function refreshSources(force = false) {
    if (!library) return;
    const clips = S.clips.map(clip => [clip.clipId, clipSource(clip)]).filter(([, source]) => source);
    const assets = S.mediaAssets.filter(item => item.kind === 'video' && item.fileId);
    const preferred = !S.selectedText && !S.selectedLayer && !S.selectedSticker ? S.clips[S.selected]?.clipId : null;
    const signature = JSON.stringify([workspaceGeneration, S.activeTimelineId, preferred,
      clips.map(([id, source]) => [id, source.name]), assets.map(item => [item.id, item.name])]);
    if (!force && signature === library.sourceSignature) return;
    const sameWorkspace = library.workspaceGeneration === workspaceGeneration;
    const sameTimeline = library.timelineId === S.activeTimelineId;
    const existing = sameWorkspace && sameTimeline ? library.sourceChoice : null;
    library.sourceChoice = existing;
    library.sourceSignature = signature;
    library.workspaceGeneration = workspaceGeneration;
    library.timelineId = S.activeTimelineId;
    library.source.replaceChildren(
      option('', 'Kaynak video seçin'),
      ...clips.map(([id, source], index) => option('clip:' + id, 'Klip ' + (index + 1) + ' · ' + source.name)),
      ...assets.map(asset => option('asset:' + asset.id, 'Projelerim · ' + asset.name)),
      option('demo', 'Şablonun örnek videosunu kullan'),
    );
    const valid = value => [...library.source.options].some(item => item.value === value);
    library.source.value = existing !== null && valid(existing) ? existing
      : preferred && valid('clip:' + preferred) ? 'clip:' + preferred : '';
    updateApplyControls();
  }

  function mountLibrary() {
    bindPreferences();
    const host = document.getElementById('studio-templates');
    if (!host || library) return;
    const shelf = make('div');
    shelf.className = 'studio-library';
    const controls = make('div');
    controls.className = 'studio-library-controls';
    const query = make('input');
    query.type = 'search';
    query.id = 'studio-template-search';
    query.placeholder = 'Şablon ara';
    query.setAttribute('aria-label', 'Şablon ara');
    const category = make('select');
    category.id = 'studio-template-category';
    category.setAttribute('aria-label', 'Şablon kategorisi');
    category.append(option('', 'Tüm kategoriler'), ...Object.entries(categories).map(([key, label]) => option(key, label)));
    const label = make('label', 'Favoriler');
    const favoriteOnly = make('input');
    favoriteOnly.type = 'checkbox';
    favoriteOnly.id = 'studio-template-favorite-only';
    label.prepend(favoriteOnly);
    controls.append(query, category, label);
    const sourceLabel = make('label', 'Kullanılacak video');
    sourceLabel.className = 'studio-template-source';
    const source = make('select');
    source.id = 'studio-template-source';
    sourceLabel.append(source);
    const context = make('p');
    context.className = 'studio-library-context';
    const feedback = make('p');
    feedback.className = 'studio-library-message';
    feedback.setAttribute('role', 'status');
    const empty = make('p');
    empty.className = 'studio-library-message';
    empty.setAttribute('role', 'status');
    const results = make('div');
    results.id = 'studio-template-results';
    results.className = 'studio-library-grid studio-template-grid';
    shelf.append(controls, sourceLabel, context, feedback, empty, results);
    host.append(shelf);
    library = { query, category, favoriteOnly, source, context, feedback, empty, results, sourceChoice: null };
    [query, category, favoriteOnly].forEach(control => control.addEventListener('input', renderLibrary));
    source.addEventListener('change', () => {
      library.sourceChoice = source.value;
      updateApplyControls();
    });
    refreshSources(true);
    renderLibrary();
    Promise.resolve(window.StudioFonts?.ready).then(renderLibrary);
  }

  window.StudioTemplates = { applyTemplate, undoCreation, refreshSources };
  window.addEventListener('studio:section', event => {
    if (event.detail?.id === 'templates') {
      mountLibrary();
      refreshSources(true);
    }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountLibrary, { once: true });
  else mountLibrary();
})();
