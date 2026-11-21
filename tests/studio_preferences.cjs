'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '..', 'static', 'studio_preferences.js'), 'utf8');
const immediate = () => new Promise(resolve => setImmediate(resolve));

function preferences(fetch, localStorage = new Map()) {
  const window = {
    desktopApp: fetch ? { isDesktop: true } : undefined,
    fetch,
    localStorage: { getItem: key => localStorage.get(key), setItem: (key, val) => localStorage.set(key, val) },
    dispatchEvent() {},
  };
  vm.runInNewContext(script, {
    window, AbortSignal, console,
    CustomEvent: class CustomEvent {},
  });
  return { api: window.StudioPreferences, localStorage };
}

test('browser settings hydrate, notify changes and protect stored arrays from mutation', async () => {
  const { api, localStorage } = preferences();
  const notifications = [];
  api.subscribe((key, value) => notifications.push([key, Array.from(value)]));
  await api.set('favorites', ['text:title']);
  api.get('favorites', []).push('color:gold');
  assert.deepEqual(notifications, [['favorites', ['text:title']]]);
  const restarted = preferences(undefined, localStorage).api;
  await restarted.ready;
  assert.deepEqual(Array.from(restarted.get('favorites', [])), ['text:title']);
});

test('native settings keep fast edits ahead of stale hydration and write them in order', async () => {
  const writes = [];
  let hydrate, completeFirst;
  const { api } = preferences((url, options) => {
    if (options.method !== 'PUT') return new Promise(resolve => { hydrate = resolve; });
    writes.push([url.split('/').at(-1), JSON.parse(options.body)]);
    if (writes.length === 1) return new Promise(resolve => { completeFirst = resolve; });
    return Promise.resolve({ ok: true });
  });
  const first = api.set('favorites', ['text:one']);
  const second = api.set('favorites', ['text:two']);
  hydrate({ ok: true, json: async () => ({ favorites: ['text:old'], layout: { preview: 'top' } }) });
  await api.ready;
  await immediate();
  assert.deepEqual(Array.from(api.get('favorites')), ['text:two']);
  assert.equal(api.get('layout').preview, 'top');
  assert.deepEqual(writes, [['favorites', ['text:one']]]);
  completeFirst({ ok: true });
  await Promise.all([first, second]);
  assert.deepEqual(writes, [['favorites', ['text:one']], ['favorites', ['text:two']]]);
});
