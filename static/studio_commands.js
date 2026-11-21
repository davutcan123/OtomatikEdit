/* Studio actions share the existing editor's playhead, save and edit operations. */
(() => {
  'use strict';
  const commands = [
    { id: 'palette', label: 'Komut ve kısayol paneli', chord: 'Mod+KeyK', run: open },
    { id: 'save', label: 'Projeyi kaydet', chord: 'Mod+KeyS', run: () => saveNamedProject() },
    { id: 'split', label: 'Oynatma başında böl', chord: 'Mod+KeyB', alias: 'KeyB', timeline: true, run: () => splitSelected() },
    { id: 'play', label: 'Oynat / duraklat', fixed: 'Space', timeline: true, run: () => isPreviewPlaying() ? pausePreview() : playPreview() },
    { id: 'undo', label: 'Son düzenlemeyi geri al', fixed: 'Mod+KeyZ', timeline: true, run: () => undoEdit() },
    { id: 'frameBack', label: 'Bir kare geri', chord: 'Comma', repeat: true, timeline: true, media: true, run: () => stepFrame(-1) },
    { id: 'frameForward', label: 'Bir kare ileri', chord: 'Period', repeat: true, timeline: true, media: true, run: () => stepFrame(1) },
    { id: 'markerAdd', label: 'İşaretçi ekle', chord: 'KeyM', timeline: true, media: true, run: addMarker },
    { id: 'markerPrevious', label: 'Önceki işaretçiye git', chord: 'Shift+KeyN', timeline: true, markers: true, run: () => jumpMarker(-1) },
    { id: 'markerNext', label: 'Sonraki işaretçiye git', chord: 'Shift+KeyM', timeline: true, markers: true, run: () => jumpMarker(1) },
    { id: 'rangeIn', label: 'Çıktı giriş noktasını koy', chord: 'KeyI', timeline: true, media: true, run: () => setRangePoint('in') },
    { id: 'rangeOut', label: 'Çıktı çıkış noktasını koy', chord: 'KeyO', timeline: true, media: true, run: () => setRangePoint('out') },
    { id: 'rangeClear', label: 'Çıktı aralığını temizle', chord: 'Alt+KeyX', timeline: true, range: true, run: clearRange },
    { id: 'export', label: 'Dışa aktarma ayarlarını aç', timeline: true, media: true, run: () => setExportModal(true) },
  ];
  const reserved = new Set([
    'KeyB', 'Shift+KeyB', 'Space', 'Shift+Space', 'Delete', 'Backspace', 'ArrowLeft', 'ArrowRight', 'Shift+ArrowLeft', 'Shift+ArrowRight',
    'Mod+KeyZ', 'Mod+Shift+KeyZ', 'Mod+KeyC', 'Mod+KeyV', 'Mod+KeyX', 'Mod+KeyA',
    'Mod+KeyW', 'Mod+KeyQ', 'Mod+KeyR', 'Mod+KeyL', 'Mod+KeyT', 'Mod+KeyN',
    'Mod+Shift+KeyI', 'Alt+ArrowLeft', 'Alt+ArrowRight',
  ]);
  const mac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
  const state = () => S.studioTimeline || { markers: [], range: null };
  const formatTime = time => {
    const millis = Math.round(time * 1000);
    const minutes = String(Math.floor(millis / 60000)).padStart(2, '0');
    const seconds = String(Math.floor(millis / 1000) % 60).padStart(2, '0');
    return minutes + ':' + seconds + '.' + String(millis % 1000).padStart(3, '0');
  };
  const frameRate = () => Number(el('export-fps')?.value) || 30;
  const snapTime = time => Math.min(outDuration(), Math.max(0, Math.round(time * frameRate()) / frameRate()));
  const text = value => String(value || '').toLocaleLowerCase('tr-TR').normalize('NFKD')
    .replace(/\p{Mark}/gu, '').replace(/ı/g, 'i');

  function normalizeTimeline(raw) {
    const markers = [], seen = new Set();
    for (const item of Array.isArray(raw?.markers) ? raw.markers.slice(0, 250) : []) {
      if (!item || typeof item.id !== 'string' || item.id.length > 80 || seen.has(item.id) ||
          !Number.isFinite(item.time) || item.time < 0 || typeof item.name !== 'string' || !item.name.trim()) continue;
      seen.add(item.id);
      markers.push({ id: item.id, time: item.time, name: item.name.trim().slice(0, 60) });
    }
    markers.sort((left, right) => left.time - right.time);
    const point = name => Number.isFinite(raw?.range?.[name]) && raw.range[name] >= 0 ? raw.range[name] : null;
    const first = point('in'), last = point('out');
    const range = first === null && last === null ? null : { in: first, out: last };
    return markers.length || range ? { markers, range } : null;
  }

  function editTimeline(patch) {
    remember();
    S.studioTimeline = normalizeTimeline({ ...state(), ...patch });
    paintRuler();
    if (el('undo')) el('undo').disabled = !S.history.length;
    scheduleAutosave();
  }

  function addMarker() {
    const markers = state().markers;
    if (markers.length >= 250) {
      log('manual-log', 'Bir timeline’da en fazla 250 işaretçi saklanabilir.', 'info');
      return;
    }
    const time = snapTime(currentOutputTime());
    const existing = markers.find(item => Math.abs(item.time - time) < .5 / frameRate());
    if (existing) { openMarker(existing.id); return; }
    const names = new Set(markers.map(item => item.name));
    let number = 1;
    while (names.has('İşaretçi ' + number)) number++;
    const id = globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
    const name = 'İşaretçi ' + number;
    editTimeline({ markers: [...markers, { id, time, name }] });
    log('manual-log', name + ' eklendi · ' + formatTime(time), 'info');
  }

  function seek(time) {
    pausePreview();
    seekOutputTime(Math.min(outDuration(), Math.max(0, time)));
  }
  function stepFrame(direction) {
    const fps = frameRate();
    seek((Math.round(currentOutputTime() * fps) + direction) / fps);
  }
  function jumpMarker(direction) {
    const markers = state().markers.filter(item => item.time <= outDuration() + .001);
    if (!markers.length) return;
    const cursor = currentOutputTime(), tolerance = .5 / frameRate();
    const ordered = direction > 0 ? markers : [...markers].reverse();
    const marker = ordered.find(item => direction * (item.time - cursor) > tolerance) || ordered[0];
    seek(marker.time);
  }
  function setRangePoint(side) {
    const other = side === 'in' ? 'out' : 'in';
    const time = snapTime(currentOutputTime());
    const next = { in: null, out: null, ...state().range, [side]: time };
    if (next[other] !== null && (side === 'in' ? next[other] <= time : next[other] >= time)) next[other] = null;
    editTimeline({ range: next });
    log('manual-log', (side === 'in' ? 'Çıktı girişi' : 'Çıktı çıkışı') + ' · ' + formatTime(time), 'info');
  }
  function clearRange() {
    if (state().range) editTimeline({ range: null });
  }
  function exportRangeDetails() {
    const range = state().range;
    if (!range || !Number.isFinite(range.in) || !Number.isFinite(range.out) || range.in < 0) return null;
    const data = manualExportData();
    const clipEnds = data.clips.map(clip => clipTimelineEnd(clip));
    const bound = Math.max(0, ...clipEnds,
      ...[...data.texts, ...data.stickers, ...data.images, ...data.audioLayers].map(item => +item.end || 0));
    if (range.out > bound + .00001) return null;

    // Independent tracks preserve the ruler clock. The legacy single-channel
    // export consumes incoming frames in the preceding transition.
    const transitions = data.options.timelineComposite ? [] : data.transitions;
    const project = time => time - transitions.reduce((sum, transition) =>
      sum + Math.min(transition.duration, Math.max(0, time - clipEnds[transition.boundary])), 0);
    const duration = project(range.out) - project(range.in);
    if (duration + .00001 < 1 / frameRate()) return null;
    return { range: { ...range }, duration, shortened: duration < range.out - range.in - .00001 };
  }
  function refreshExportScope({ selectRange = true } = {}) {
    const scope = el('studio-export-scope');
    if (!scope) return;
    const details = exportRangeDetails();
    scope.options[1].disabled = !details;
    if (!details) scope.value = 'full';
    else if (selectRange) scope.value = 'range';
    const info = el('studio-export-range-info'), points = state().range;
    if (!details) {
      info.textContent = Number.isFinite(points?.in) && Number.isFinite(points?.out)
        ? 'İşaretli aralık dışa aktarılabilir en az bir kareyi kapsamalı.'
        : 'Aralık seçmek için giriş (' + bindingLabel(bindings.get('rangeIn')) + ') ve çıkış (' +
          bindingLabel(bindings.get('rangeOut')) + ') noktalarını koyun.';
      return;
    }
    const { range, duration, shortened } = details;
    const seconds = duration.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
    info.textContent = formatTime(range.in) + ' – ' + formatTime(range.out) + ' · Çıktı ' + seconds + ' sn' +
      (shortened ? ' (geçişlerle kısalır)' : '');
  }
  function selectedExportRange() {
    if (el('studio-export-scope')?.value !== 'range') return null;
    const details = exportRangeDetails();
    if (!details) throw new Error('İşaretli aralık mevcut timeline veya kare hızında geçersiz.');
    return details.range;
  }

  function button(label, attributes = {}) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }
  function paintRuler(ruler = el('timeline-ruler'), total = outDuration()) {
    if (!ruler) return;
    ruler.querySelector('.studio-ruler-marks')?.remove();
    const layer = document.createElement('div');
    layer.className = 'studio-ruler-marks';
    const range = state().range;
    const left = range?.in, right = range?.out;
    if (Number.isFinite(left) && Number.isFinite(right) && right > left && left < total) {
      const highlight = document.createElement('span');
      highlight.className = 'studio-ruler-range';
      highlight.style.left = (left * S.zoom) + 'px';
      highlight.style.width = ((Math.min(right, total) - left) * S.zoom) + 'px';
      layer.append(highlight);
    }
    for (const [side, time, label] of [['in', left, 'Giriş'], ['out', right, 'Çıkış']]) {
      if (!Number.isFinite(time) || time > total + .001) continue;
      const endpoint = document.createElement('span');
      endpoint.className = 'studio-range-point studio-range-' + side;
      endpoint.style.left = (time * S.zoom) + 'px';
      endpoint.textContent = side === 'in' ? 'I' : 'O';
      endpoint.setAttribute('aria-label', label + ' ' + formatTime(time));
      layer.append(endpoint);
    }
    for (const item of state().markers) {
      if (item.time > total + .001) continue;
      const title = item.name + ' · ' + formatTime(item.time);
      const marker = button('', {
        'class': 'studio-ruler-marker', 'data-studio-marker': item.id,
        'aria-label': title, 'title': title + ' · Düzenlemek için sağ tıklayın',
      });
      marker.style.left = (item.time * S.zoom) + 'px';
      marker.onpointerdown = event => event.stopPropagation();
      marker.onclick = () => seek(item.time);
      marker.ondblclick = () => openMarker(item.id);
      marker.onkeydown = event => {
        if (event.shiftKey && event.key === 'Enter') { event.preventDefault(); openMarker(item.id); }
      };
      marker.oncontextmenu = event => { event.preventDefault(); openMarker(item.id); };
      layer.append(marker);
    }
    ruler.append(layer);
  }

  function normalizedChord(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split('+'), code = parts.pop(), flags = new Set(parts);
    if (flags.size !== parts.length || parts.some(flag => !['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'].includes(flag)) ||
        !/^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Space|Comma|Period|Slash|Semicolon|Bracket(Left|Right))$/.test(code)) return null;
    if (flags.has('Mod') && flags.has(mac ? 'Meta' : 'Ctrl')) return null;
    return [...['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'].filter(flag => flags.has(flag)), code].join('+');
  }
  function eventChord(event) {
    const flags = [];
    if (mac ? event.metaKey : event.ctrlKey) flags.push('Mod');
    if (mac && event.ctrlKey) flags.push('Ctrl');
    if (!mac && event.metaKey) flags.push('Meta');
    if (event.altKey) flags.push('Alt');
    if (event.shiftKey) flags.push('Shift');
    const key = event.key || '';
    const code = event.code || (/^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : key);
    return normalizedChord([...flags, code].join('+'));
  }
  function bindingLabel(chord) {
    const keys = {
      Mod: mac ? '⌘' : 'Ctrl', Ctrl: mac ? '⌃' : 'Ctrl', Meta: 'Win',
      Alt: mac ? '⌥' : 'Alt', Shift: mac ? '⇧' : 'Shift', Space: 'Boşluk',
      Comma: ',', Period: '.', Slash: '/', Semicolon: ';', BracketLeft: '[', BracketRight: ']',
      ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    };
    return chord.split('+').map(key => keys[key] || key.replace(/^(Key|Digit)/, '')).join(mac ? '' : '+');
  }
  function configuredBindings(overrides) {
    const customised = commands.filter(command => command.chord);
    const assigned = new Map(customised.map(command => {
      const chord = normalizedChord(overrides?.[command.id]);
      return [command.id, chord && !reserved.has(chord) ? chord : command.chord];
    }));
    // Conflicting preferences from older versions fall back to defaults.
    for (;;) {
      const counts = new Map();
      for (const chord of assigned.values()) counts.set(chord, (counts.get(chord) || 0) + 1);
      const conflicts = customised.filter(command => assigned.get(command.id) !== command.chord &&
        counts.get(assigned.get(command.id)) > 1);
      if (!conflicts.length) return assigned;
      for (const command of conflicts) assigned.set(command.id, command.chord);
    }
  }

  function active(command) {
    if (command.timeline && !el('manual')?.classList.contains('active')) return false;
    if (command.media && !outDuration()) return false;
    if (command.markers && !state().markers.some(item => item.time <= outDuration() + .001)) return false;
    return !command.range || !!state().range;
  }
  function editorBusy() {
    return desktopClosing || desktopUpdateFrozen ||
      !!document.querySelector('dialog[open]') || !el('export-modal').classList.contains('hidden');
  }
  function typingTarget(node) {
    return !!node?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  }

  const palette = document.createElement('dialog');
  palette.id = 'studio-command-panel';
  palette.className = 'studio-command-dialog';
  palette.setAttribute('aria-labelledby', 'studio-command-heading');
  palette.innerHTML = `
    <header><h2 id="studio-command-heading">Komutlar ve kısayollar</h2>
      <button type="button" data-studio-close aria-label="Kapat">×</button></header>
    <input type="search" aria-label="Komut ara" placeholder="Komut, kısayol veya işaretçi ara">
    <p role="status"></p><div class="studio-command-list"></div>
    <footer><button type="button" data-studio-reset>Kısayolları sıfırla</button></footer>`;
  const markerDialog = document.createElement('dialog');
  markerDialog.id = 'studio-marker-panel';
  markerDialog.className = 'studio-command-dialog';
  markerDialog.setAttribute('aria-labelledby', 'studio-marker-heading');
  markerDialog.innerHTML = `
    <header><h2 id="studio-marker-heading">İşaretçiyi düzenle</h2>
      <button type="button" data-studio-close aria-label="Kapat">×</button></header>
    <form>
      <label>İşaretçi adı <input type="text" maxlength="60" required></label>
      <p data-studio-marker-time></p>
      <footer><button type="button" data-studio-marker-seek>Git</button>
      <button type="button" data-studio-marker-remove>Sil</button>
      <button type="submit">Kaydet</button></footer>
    </form>`;
  document.body.append(palette, markerDialog);
  for (const dialog of [palette, markerDialog]) dialog.querySelector('[data-studio-close]').onclick = () => dialog.close();
  const query = palette.querySelector('input'), list = palette.querySelector('.studio-command-list');
  const feedback = palette.querySelector('[role=status]');
  const preferences = window.StudioPreferences;
  let bindings = configuredBindings(preferences.get('shortcuts', {}));
  let recording = null, editedMarker = null;

  function currentMarker() { return state().markers.find(item => item.id === editedMarker); }
  function openMarker(id) {
    editedMarker = id;
    const item = currentMarker();
    if (!item || markerDialog.open || editorBusy()) return;
    markerDialog.querySelector('[data-studio-marker-time]').textContent = formatTime(item.time);
    const input = markerDialog.querySelector('input');
    input.value = item.name;
    markerDialog.showModal();
    input.select();
  }
  markerDialog.querySelector('form').onsubmit = event => {
    event.preventDefault();
    const item = currentMarker(), name = markerDialog.querySelector('input').value.trim();
    if (!item || !name) return;
    if (name !== item.name) editTimeline({ markers: state().markers.map(marker => marker === item ? { ...item, name } : marker) });
    markerDialog.close();
  };
  markerDialog.querySelector('[data-studio-marker-seek]').onclick = () => {
    const item = currentMarker();
    markerDialog.close();
    if (item) seek(item.time);
  };
  markerDialog.querySelector('[data-studio-marker-remove]').onclick = () => {
    const item = currentMarker();
    if (item) editTimeline({ markers: state().markers.filter(marker => marker !== item) });
    markerDialog.close();
  };

  function redrawPalette() {
    list.replaceChildren();
    const term = text(query.value.trim());
    for (const command of commands) {
      const keys = [bindings.get(command.id) || command.fixed, command.alias].filter(Boolean).map(bindingLabel);
      if (!text(command.label + ' ' + keys.join(' ')).includes(term)) continue;
      const row = document.createElement('div');
      row.className = 'studio-command-row';
      const run = button(command.label, { 'data-studio-run': command.id });
      run.disabled = !active(command);
      run.onclick = () => {
        if (command.id === 'palette') { query.focus(); return; }
        palette.close();
        command.run();
      };
      row.append(run);
      if (keys.length) {
        const keysNode = document.createElement('kbd');
        keysNode.textContent = keys.join(' / ');
        row.append(keysNode);
      }
      if (command.chord) {
        const edit = button('Değiştir', {
          'data-studio-binding': command.id, 'aria-label': command.label + ' kısayolunu değiştir',
        });
        edit.onclick = () => {
          recording = command.id;
          feedback.textContent = 'Yeni kısayola basın. Esc ile vazgeçebilirsiniz.';
        };
        row.append(edit);
      }
      list.append(row);
    }
    if (el('manual')?.classList.contains('active')) {
      for (const item of state().markers) {
        const label = item.name + ' · ' + formatTime(item.time);
        if (!text('işaretçi ' + label).includes(term)) continue;
        const row = document.createElement('div');
        row.className = 'studio-command-row';
        const jump = button(label), edit = button('Düzenle', { 'aria-label': item.name + ' adını düzenle' });
        jump.onclick = () => { palette.close(); seek(item.time); };
        edit.onclick = () => { palette.close(); openMarker(item.id); };
        row.append(jump, edit);
        list.append(row);
      }
    }
    if (!list.children.length) list.textContent = 'Eşleşen komut bulunamadı.';
  }
  function open() {
    if (palette.open) { query.focus(); return; }
    if (editorBusy()) return;
    recording = null;
    feedback.textContent = '';
    query.value = '';
    redrawPalette();
    palette.showModal();
    query.focus();
  }
  query.oninput = () => { recording = null; feedback.textContent = ''; redrawPalette(); };
  query.onkeydown = event => {
    if (event.isComposing || recording) return;
    if (!['ArrowDown', 'Enter'].includes(event.key)) return;
    const result = list.querySelector('button[data-studio-run]:not(:disabled), .studio-command-row button:not(:disabled)');
    if (!result) return;
    event.preventDefault();
    if (event.key === 'Enter') result.click(); else result.focus();
  };
  palette.addEventListener('close', () => { recording = null; });
  palette.querySelector('[data-studio-reset]').onclick = async () => {
    recording = null;
    try { await preferences.set('shortcuts', {}); feedback.textContent = 'Varsayılan kısayollar geri yüklendi.'; }
    catch (error) { feedback.textContent = error.message; }
  };

  async function record(event) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      recording = null;feedback.textContent = '';
      return;
    }
    const chord = eventChord(event);
    if (!chord) return;
    event.preventDefault();event.stopImmediatePropagation();
    if (reserved.has(chord) || [...bindings].some(([id, assigned]) => id !== recording && assigned === chord)) {
      feedback.textContent = bindingLabel(chord) + ' başka bir komuta ayrılmış.';
      return;
    }
    const action = recording;
    recording = null;
    const overrides = preferences.get('shortcuts', {});
    if (chord === commands.find(command => command.id === action).chord) delete overrides[action];
    else overrides[action] = chord;
    try { await preferences.set('shortcuts', overrides); feedback.textContent = bindingLabel(chord) + ' kaydedildi.'; }
    catch (error) { feedback.textContent = error.message; }
  }
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return;
    if (palette.open && recording) { void record(event); return; }
    if (palette.open && event.key === 'Escape') {
      event.preventDefault();event.stopImmediatePropagation();palette.close();
      return;
    }
    if (editorBusy() || typingTarget(event.target) || typingTarget(document.activeElement)) return;
    const chord = eventChord(event);
    if (!chord) return;
    const command = commands.find(entry => bindings.get(entry.id) === chord);
    if (!command || !active(command)) return;
    event.preventDefault();event.stopImmediatePropagation();
    if (!event.repeat || command.repeat) command.run();
  }, true);
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-studio-command="palette"]');
    if (trigger) { event.preventDefault(); open(); }
  });
  preferences.subscribe(key => {
    if (key !== 'shortcuts') return;
    bindings = configuredBindings(preferences.get(key, {}));
    if (palette.open) redrawPalette();
  });
  el('export-fps')?.addEventListener('change', () => refreshExportScope({ selectRange: false }));

  window.StudioCommands = Object.freeze({ open, normalizeTimeline, paintRuler, refreshExportScope, selectedExportRange });
  S.studioTimeline = normalizeTimeline(S.studioTimeline);
  paintRuler();
})();
