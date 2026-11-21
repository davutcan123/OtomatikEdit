/* Workstation-wide preferences. Project state remains in the existing project file. */
(() => {
  'use strict';
  const storageKey = 'otamatik-edit:studio-preferences:v1';
  const endpoint = '/api/desktop/studio-preferences';
  const desktop = window.desktopApp?.isDesktop === true;
  const allowed = new Set(['favorites', 'shortcuts', 'savedLooks', 'layout']);
  const subscribers = new Set();
  const pending = new Map();
  let orderedWrite = Promise.resolve(), revision = 0;
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const valid = (key, value) => allowed.has(key) && value !== null &&
    (key === 'favorites' || key === 'savedLooks' ? Array.isArray(value) : typeof value === 'object' && !Array.isArray(value));

  function browserState() {
    try {
      const state = JSON.parse(window.localStorage.getItem(storageKey));
      return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    } catch { return {}; }
  }
  const values = Object.create(null), confirmed = Object.create(null);
  for (const [key, value] of Object.entries(browserState())) {
    if (valid(key, value)) values[key] = confirmed[key] = value;
  }
  function notify(key) {
    for (const callback of subscribers) {
      try { callback(key, copy(values[key])); } catch (error) { console.error(error); }
    }
    window.dispatchEvent(new CustomEvent('studio-preferences-change', { detail: { key, value: copy(values[key]) } }));
  }
  function persistBrowser(key, value) {
    const cache = browserState();
    if (value === undefined) delete cache[key];
    else cache[key] = value;
    window.localStorage.setItem(storageKey, JSON.stringify(cache));
  }
  function useConfirmed(key) {
    if (Object.hasOwn(confirmed, key)) values[key] = confirmed[key];
    else delete values[key];
    notify(key);
  }
  function hydrateNative(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return;
    for (const key of allowed) {
      const before = confirmed[key];
      if (valid(key, state[key])) confirmed[key] = state[key];
      else delete confirmed[key];
      if (before === undefined && confirmed[key] === undefined) continue;
      try { persistBrowser(key, confirmed[key]); } catch {}
      if (!pending.has(key)) useConfirmed(key);
    }
  }
  const ready = desktop ? window.fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    .then(response => response.ok ? response.json() : null)
    .then(hydrateNative).catch(() => {}) : Promise.resolve();

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
      const change = ++revision;
      pending.set(key, change);
      values[key] = snapshot;
      const write = orderedWrite.catch(() => {}).then(async () => {
        await ready;
        if (desktop) {
          const response = await window.fetch(`${endpoint}/${key}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(snapshot), signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) throw new Error('Stüdyo tercihi kaydedilemedi.');
          try { persistBrowser(key, snapshot); } catch {}
        } else {
          persistBrowser(key, snapshot);
        }
        confirmed[key] = snapshot;
      }).catch(error => {
        if (pending.get(key) === change) useConfirmed(key);
        throw error;
      }).finally(() => {
        if (pending.get(key) === change) pending.delete(key);
        finish?.();
      });
      orderedWrite = write;
      notify(key);
      return write;
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  });
})();
