/* Workstation-wide preferences. Project state remains in the existing project file. */
(() => {
  'use strict';
  const storageKey = 'otamatik-edit:studio-preferences:v1';
  const endpoint = '/api/desktop/studio-preferences';
  const desktop = window.desktopApp?.isDesktop === true;
  const allowed = new Set(['favorites', 'shortcuts', 'savedLooks', 'layout']);
  const subscribers = new Set();
  const pending = new Set();
  let orderedWrite = Promise.resolve();
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const valid = (key, value) => allowed.has(key) && value !== null &&
    (key === 'favorites' || key === 'savedLooks' ? Array.isArray(value) : typeof value === 'object' && !Array.isArray(value));

  function browserState() {
    try { return JSON.parse(window.localStorage.getItem(storageKey)) || {}; }
    catch { return {}; }
  }
  const values = Object.create(null);
  for (const [key, value] of Object.entries(browserState())) {
    if (valid(key, value)) values[key] = value;
  }
  function notify(key) {
    const value = copy(values[key]);
    for (const callback of subscribers) {
      try { callback(key, value); } catch (error) { console.error(error); }
    }
    window.dispatchEvent(new CustomEvent('studio-preferences-change', { detail: { key, value } }));
  }
  function persistBrowser(key, value) {
    window.localStorage.setItem(storageKey, JSON.stringify({ ...browserState(), [key]: value }));
  }
  const ready = desktop ? window.fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    .then(response => response.ok ? response.json() : {})
    .then(state => {
      for (const [key, value] of Object.entries(state)) {
        if (!valid(key, value) || pending.has(key)) continue;
        values[key] = value;
        try { persistBrowser(key, value); } catch {}
        notify(key);
      }
    }).catch(() => {}) : Promise.resolve();

  window.StudioPreferences = Object.freeze({
    ready,
    get(key, fallback) { return copy(Object.hasOwn(values, key) ? values[key] : fallback); },
    set(key, value) {
      let snapshot, finish;
      try {
        snapshot = copy(value);
        if (!valid(key, snapshot)) throw new TypeError('Geçersiz stüdyo tercihi.');
        if (desktop && typeof beginDesktopOperation === 'function') finish = beginDesktopOperation('Stüdyo tercihini kaydetme');
      } catch (error) { return Promise.reject(error); }
      pending.add(key);
      values[key] = snapshot;
      notify(key);
      const write = orderedWrite.catch(() => {}).then(async () => {
        await ready;
        let fallbackError;
        try { persistBrowser(key, snapshot); } catch (error) { fallbackError = error; }
        if (!desktop) {
          if (fallbackError) throw fallbackError;
          return;
        }
        const response = await window.fetch(`${endpoint}/${key}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot), signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('Stüdyo tercihi kaydedilemedi.');
      }).finally(() => finish?.());
      orderedWrite = write;
      return write;
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  });
})();
