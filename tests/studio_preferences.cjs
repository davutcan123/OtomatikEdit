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

test('a failed desktop write restores the confirmed value and never caches the rejected value', async () => {
  const fallback = new Map([['otamatik-edit:studio-preferences:v1', JSON.stringify({favorites:['text:old']})]]);
  const { api } = preferences(async (_url, options) => options.method === 'PUT'
    ? { ok: false, status: 500 } : { ok: true, json: async () => ({favorites:['text:confirmed']}) }, fallback);
  await api.ready;
  const notifications = [];
  api.subscribe((key, value) => notifications.push([key, Array.from(value)]));
  const write = api.set('favorites', ['text:unsaved']);
  assert.deepEqual(Array.from(api.get('favorites')), ['text:unsaved']);
  await assert.rejects(write, /kaydedilemedi/);
  assert.deepEqual(Array.from(api.get('favorites')), ['text:confirmed']);
  assert.deepEqual(notifications, [['favorites',['text:unsaved']],['favorites',['text:confirmed']]]);
  const reopened = preferences(undefined, fallback).api;
  assert.deepEqual(Array.from(reopened.get('favorites')), ['text:confirmed']);
});

test('a delayed failure does not overwrite a newer edit and the following success compacts the fallback', async () => {
  let finishFirst;
  const writes = [];
  const { api, localStorage } = preferences(async (_url, options) => {
    if (options.method !== 'PUT') return { ok: true, json: async () => ({ savedLooks: [{id:'old'}] }) };
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) return new Promise(resolve => { finishFirst = resolve; });
    return { ok: true };
  });
  await api.ready;
  const first = assert.rejects(api.set('savedLooks',[{id:'rejected'}]), /kaydedilemedi/);
  const second = api.set('savedLooks',[]);
  await immediate();
  finishFirst({ok:false,status:413});
  await first;
  assert.equal(api.get('savedLooks').length,0);
  await second;
  assert.equal(preferences(undefined,localStorage).api.get('savedLooks').length,0);
  assert.deepEqual(writes, [[{id:'rejected'}],[]]);
});

test('failed browser storage writes restore the last confirmed value', async () => {
  class QuotaStorage extends Map {
    set(key, value) {
      if (this.block) throw new Error('quota');
      return super.set(key,value);
    }
  }
  const storage = new QuotaStorage();
  const { api } = preferences(undefined,storage);
  await api.set('layout',{panel:'baseline'});
  storage.block = true;
  await assert.rejects(api.set('layout',{panel:'optimistic'}), /quota/);
  assert.equal(api.get('layout').panel,'baseline');
  assert.equal(preferences(undefined,storage).api.get('layout').panel,'baseline');
});
