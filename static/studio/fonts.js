(() => {
  'use strict';

  const catalogURL = '/static/studio/fonts/catalog.json';
  const categories = { sans: 'Tırnaksız', serif: 'Tırnaklı', mono: 'Eş aralıklı', display: 'Başlık' };
  const example = 'İstanbul’da eşsiz bir gün.';
  const defaultFont = 'default';
  const families = new Map();
  let library;
  let catalogError = false;
  let preferences;
  let previousSelection = '';

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
  const normalize = id => families.has(id) ? id : defaultFont;
  const fileWeight = (face, bold) => bold && face.files['700'] ? '700' : '400';
  const cssFamily = face => '"studio-font-' + face.id + '"';
  const searchKey = value => value.toLocaleLowerCase('tr-TR').normalize('NFKD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');

  function selection() {
    const item = selectedText();
    const kind = item?.kind === 'subtitle' ? 'subtitle' : 'text';
    return { item, kind, locked: !!item && isTrackLocked(kind) };
  }

  function paintPreview(node, item) {
    const face = families.get(item.fontFamily);
    node.style.fontWeight = face ? fileWeight(face, item.bold !== false) : item.bold === false ? '400' : '800';
    if (face) node.style.fontFamily = cssFamily(face);
  }

  function applyToSelection(id, weight) {
    const { item, locked } = selection();
    if (!item || locked || (id !== defaultFont && !families.has(id))) return false;
    const font = normalize(id);
    const bold = weight === undefined ? item.bold !== false : weight === '700';
    if (normalize(item.fontFamily) === font && (item.bold !== false) === bold) return false;
    remember();
    item.fontFamily = font;
    item.bold = bold;
    drawClips();
    showTextProperties();
    scheduleAutosave();
    return true;
  }

  function useFont(id) {
    const { item } = selection();
    if (item) return applyToSelection(id);
    if (timelineToolsBlocked() || !families.has(id) || !outDuration() || isTrackLocked('text')) return false;
    const added = addTextPreset('classic', currentOutputTime(), id);
    if (added) {
      drawClips();
      scheduleAutosave();
    }
    return !!added;
  }

  function setupInspector() {
    for (const [familyId, weightId] of [
      ['text-font-family', 'text-font-weight'],
      ['subtitle-selected-font-family', 'subtitle-selected-font-weight'],
      ['subtitle-font-family', 'subtitle-font-weight'],
    ]) {
      const family = document.getElementById(familyId);
      const weight = document.getElementById(weightId);
      if (!family || !weight) continue;
      family.replaceChildren(option(defaultFont, 'Varsayılan'), ...[...families.values()].map(face => option(face.id, face.name)));
      if (familyId === 'subtitle-font-family') {
        family.addEventListener('change', () => {
          weight.querySelector('[value="700"]').disabled = !!families.get(family.value) && !families.get(family.value).files['700'];
          if (weight.value === '700' && weight.querySelector('[value="700"]').disabled) weight.value = 'style';
        });
      } else {
        family.addEventListener('change', () => applyToSelection(family.value));
        weight.addEventListener('change', () => applyToSelection(family.value, weight.value));
      }
    }
    document.querySelectorAll('[data-open-studio-fonts]').forEach(button => {
      if (!window.StudioWorkspace) {
        button.hidden = true;
        return;
      }
      button.addEventListener('click', () => window.StudioWorkspace.openSection('fonts'));
    });
  }

  function refreshSelection(force = false) {
    const { item, kind, locked } = selection();
    const id = normalize(item?.fontFamily);
    const face = families.get(id);
    const canAdd = !item && outDuration() > 0 && !isTrackLocked('text');
    const state = JSON.stringify([item?.id, kind, id, item?.bold, locked, canAdd]);
    if (!force && previousSelection === state) return;
    previousSelection = state;
    for (const [prefix, matching] of [['text', kind === 'text'], ['subtitle-selected', kind === 'subtitle']]) {
      const family = document.getElementById(prefix + '-font-family');
      const weight = document.getElementById(prefix + '-font-weight');
      if (!family || !weight) continue;
      family.value = id;
      family.disabled = !item || locked || !matching;
      weight.disabled = family.disabled || (!!face && !face.files['700']);
      weight.value = face ? fileWeight(face, item?.bold !== false) : item?.bold === false ? '400' : '700';
    }
    if (library) {
      library.context.textContent = !item ? (
        canAdd ? 'Seçtiğiniz yazı tipiyle oynatma noktasına metin ekleyin.' : 'Metin eklemek için düzenlenebilir bir timeline açın.'
      ) : locked ? 'Seçili katmanın kanalı kilitli.'
          : (kind === 'subtitle' ? 'Seçili altyazı' : 'Seçili metin') + ' · ' + (face?.name || 'Varsayılan');
      library.results.querySelectorAll('[data-apply-font]').forEach(button => {
        button.textContent = item ? 'Uygula' : 'Bu yazı tipiyle metin ekle';
        button.disabled = item ? locked || button.dataset.applyFont === id : !canAdd;
        if (item) button.setAttribute('aria-pressed', String(button.dataset.applyFont === id));
        else button.removeAttribute('aria-pressed');
      });
    }
  }

  function bindPreferences() {
    const current = window.StudioPreferences;
    if (!current || preferences === current) return;
    preferences = current;
    preferences.subscribe((key) => {
      if (key === 'favorites') renderLibrary();
    });
    Promise.resolve(preferences.ready).then(() => renderLibrary()).catch(() => {});
  }

  function favorites() {
    const stored = preferences?.get('favorites', []);
    return Array.isArray(stored) ? stored : [];
  }

  async function toggleFavorite(id, button) {
    if (!preferences) return;
    const key = 'font:' + id;
    button.disabled = true;
    try {
      await preferences.update('favorites', [], current => current.includes(key) ? current.filter(value => value !== key) : [...current, key]);
      renderLibrary();
      const refreshed = library.results.querySelector('[data-font-favorite="' + id + '"]');
      (refreshed || library.favoriteOnly).focus();
    } catch {
      library.feedback.textContent = 'Favoriler kaydedilemedi.';
      button.disabled = false;
    }
  }

  function renderLibrary() {
    if (!library) return;
    const { category, query, sample, favoriteOnly, results, feedback } = library;
    const activeFavorites = favorites();
    const term = searchKey(query.value.trim());
    const filtered = [...families.values()].filter(face =>
      (!category.value || face.category === category.value) &&
      (!favoriteOnly.checked || activeFavorites.includes('font:' + face.id)) &&
      (!term || searchKey(face.name + ' ' + face.id + ' ' + categories[face.category]).includes(term))
    );
    feedback.textContent = catalogError ? 'Yazı tipi kitaplığı yüklenemedi.'
      : !families.size ? 'Yazı tipleri yükleniyor…'
        : filtered.length ? '' : 'Aramanıza uygun yazı tipi bulunamadı.';
    favoriteOnly.disabled = !preferences;
    results.replaceChildren(...filtered.map(face => {
      const card = make('article');
      card.className = 'studio-font-card';
      card.dataset.font = face.id;
      const header = make('div');
      header.className = 'studio-library-card-head';
      const name = make('h3', face.name);
      const favorite = make('button', activeFavorites.includes('font:' + face.id) ? '★' : '☆');
      favorite.type = 'button';
      favorite.className = 'studio-library-favorite';
      favorite.dataset.fontFavorite = face.id;
      favorite.setAttribute('aria-label', face.name + ' favori');
      favorite.setAttribute('aria-pressed', String(activeFavorites.includes('font:' + face.id)));
      favorite.disabled = !preferences;
      favorite.addEventListener('click', () => toggleFavorite(face.id, favorite));
      header.append(name, favorite);
      const text = make('p', sample.value || example);
      text.className = 'studio-font-sample';
      text.style.fontFamily = cssFamily(face);
      const foot = make('div');
      foot.className = 'studio-library-card-foot';
      const meta = make('span', categories[face.category] + (face.files['700'] ? ' · Normal, kalın' : ' · Normal'));
      const apply = make('button', 'Uygula');
      apply.type = 'button';
      apply.dataset.applyFont = face.id;
      apply.addEventListener('click', () => useFont(face.id));
      foot.append(meta, apply);
      card.append(header, text, foot);
      return card;
    }));
    refreshSelection(true);
  }

  function mountLibrary() {
    bindPreferences();
    const host = document.getElementById('studio-fonts');
    if (!host || library) return;
    const shelf = make('div');
    shelf.className = 'studio-library';
    const controls = make('div');
    controls.className = 'studio-library-controls';
    const query = document.createElement('input');
    query.type = 'search';
    query.id = 'studio-font-search';
    query.placeholder = 'Yazı tipi ara';
    query.setAttribute('aria-label', 'Yazı tipi ara');
    const category = make('select');
    category.id = 'studio-font-category';
    category.setAttribute('aria-label', 'Yazı tipi kategorisi');
    category.append(option('', 'Tüm kategoriler'), ...Object.entries(categories).map(([key, label]) => option(key, label)));
    const favoriteLabel = make('label', 'Favoriler');
    const favoriteOnly = make('input');
    favoriteOnly.type = 'checkbox';
    favoriteOnly.id = 'studio-font-favorite-only';
    favoriteLabel.prepend(favoriteOnly);
    const sample = make('input');
    sample.type = 'text';
    sample.id = 'studio-font-sample-input';
    sample.maxLength = 80;
    sample.placeholder = example;
    sample.setAttribute('aria-label', 'Yazı örneği');
    const context = make('p');
    context.className = 'studio-library-context';
    context.setAttribute('role', 'status');
    const feedback = make('p');
    feedback.className = 'studio-library-message';
    feedback.setAttribute('role', 'status');
    const results = make('div');
    results.id = 'studio-font-results';
    results.className = 'studio-library-grid';
    controls.append(query, category, favoriteLabel, sample);
    shelf.append(controls, context, feedback, results);
    host.append(shelf);
    library = { query, category, sample, favoriteOnly, context, results, feedback };
    for (const control of [query, category, favoriteOnly]) control.addEventListener('input', renderLibrary);
    sample.addEventListener('input', () => results.querySelectorAll('.studio-font-sample').forEach(node => {
      node.textContent = sample.value || example;
    }));
    renderLibrary();
  }

  async function loadFonts() {
    try {
      const response = await fetch(catalogURL);
      if (!response.ok) throw new Error('Font catalog unavailable');
      for (const item of await response.json()) {
        if (/^[a-z0-9]+$/.test(item.id) && Object.hasOwn(categories, item.category)) families.set(item.id, item);
      }
    } catch {
      catalogError = true;
    }
    setupInspector();
    drawTextOverlay();
    renderLibrary();
    refreshSelection(true);
  }

  window.StudioFonts = { normalize, paintPreview, refreshSelection, applyToSelection };
  window.addEventListener('studio:section', event => {
    if (event.detail?.id === 'fonts') mountLibrary();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountLibrary, { once: true });
  else mountLibrary();
  window.StudioFonts.ready = loadFonts();
})();
