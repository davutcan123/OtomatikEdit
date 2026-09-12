const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const persistenceCode = script.slice(script.indexOf('    async function persistProjectRecovery'), script.indexOf('    function scheduleAutosave'));
const startupCode = script.slice(script.indexOf('    async function initializeProjectWorkspace'), script.indexOf('    /* ═', script.indexOf('    async function initializeProjectWorkspace')));
const project = name => ({ name, timelines: [{ id: 'TL1', state: {} }] });

function workspace({ desktop = null, browserSnapshot = null, browserError = null } = {}) {
  const nodes = new Map();
  const context = vm.createContext({
    desktopBridge: desktop?{ onCloseCancelled() {}, ...desktop }:null, RECOVERY_KEY: 'test', recoveryWrite: Promise.resolve(), projectWorkspaceReady: true, desktopClosing: false, desktopCloseAttempt: null,
    S: {}, snapshot: project('Current'), restored: null,
    Promise, JSON, clearTimeout,
    localStorage: {
      getItem: () => browserSnapshot,
      setItem: (_, value) => { if (browserError) throw browserError; browserSnapshot = value; },
    },
    el: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
    log() {}, refreshProjectList: async () => {}, scheduleAutosave() {},
    emptyTimelineState: () => ({}), updateCanvas() {}, applyTimelineState() {}, drawTimelineTabs() {},
  });
  vm.runInContext('function projectPayload(){return snapshot} function restoreProject(value){restored=value}', context);
  vm.runInContext(persistenceCode, context);
  return { context, nodes, getBrowserSnapshot: () => browserSnapshot };
}

test('editor script parses and styles do not depend on a CDN', () => {
  new vm.Script(script);
  assert.match(html, /href="\/static\/editor\.css"/);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
});

test('saved media, including inactive timelines and masks, is independent of the server port', () => {
  const context = vm.createContext({
    S: { mediaAssets: [{ id: 'mask', fileId: 'maske resim.png' }] },
    state: {
      manualId: 'source.mov',
      clips: [{ src: 'http://localhost:4242/video/source.mov', maskImageId: 'mask', maskImageSrc: 'http://localhost:4242/video/mask.png' }],
      imageLayers: [{ fileId: 'image.png', src: 'http://127.0.0.1:1234/video/image.png' }],
      audioLayers: [{ fileId: 'audio.mp3', src: 'http://127.0.0.1:1234/video/audio.mp3' }],
    },
  });
  vm.runInContext(script.slice(script.indexOf('    function portableMediaItem'), script.indexOf('    function restoreAssetSources')), context);
  const saved = vm.runInContext('portableTimelineState(state)', context);
  assert.equal(saved.clips[0].src, '/video/source.mov');
  assert.equal(saved.clips[0].maskImageSrc, '/video/maske%20resim.png');
  assert.equal(saved.imageLayers[0].src, '/video/image.png');
  assert.equal(saved.audioLayers[0].src, '/video/audio.mp3');
  assert.equal(context.state.clips[0].src, 'http://localhost:4242/video/source.mov');
});

test('desktop recovery succeeds even when browser quota is full', async () => {
  let saved;
  const { context } = workspace({ desktop: { saveRecovery: async value => { saved = value; } }, browserError: new Error('quota') });
  await context.persistProjectRecovery();
  assert.equal(JSON.parse(saved).name, 'Current');
});

test('recovery writes retain snapshot order and recover after a failed write', async () => {
  const saved = [];
  let finishFirst;
  const { context } = workspace({ desktop: { saveRecovery: value => {
    saved.push(JSON.parse(value).name);
    return saved.length === 1 ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve();
  } } });
  const first = context.persistProjectRecovery();
  context.snapshot = project('Second');
  const second = context.persistProjectRecovery();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved, ['Current']);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(saved, ['Current', 'Second']);
  context.desktopBridge.saveRecovery = async () => { throw new Error('disk full'); };
  await assert.rejects(context.persistProjectRecovery(), /disk full/);
  context.desktopBridge.saveRecovery = async value => { saved.push(JSON.parse(value).name); };
  await context.persistProjectRecovery();
  assert.equal(saved.at(-1), 'Second');
});

test('an uninitialized workspace cannot overwrite existing recovery', async () => {
  const existing = JSON.stringify(project('Previous'));
  let called = false;
  const { context, getBrowserSnapshot } = workspace({ browserSnapshot: existing, desktop: { saveRecovery: async () => { called = true; } } });
  context.projectWorkspaceReady = false;
  await context.persistProjectRecovery();
  assert.equal(called, false);
  assert.equal(getBrowserSnapshot(), existing);
});

test('desktop reopening uses native recovery ahead of stale port-local storage', async () => {
  const { context } = workspace({ browserSnapshot: JSON.stringify(project('Stale port')), desktop: {
    loadRecovery: async () => JSON.stringify(project('Latest desktop')), onBeforeClose() {},
  } });
  vm.runInContext(startupCode, context);
  await vm.runInContext('projectWorkspaceInitialization', context);
  assert.equal(context.restored.name, 'Latest desktop');
  assert.equal(context.projectWorkspaceReady, true);
});

test('invalid desktop recovery falls back to the existing browser copy', async () => {
  const { context } = workspace({ browserSnapshot: JSON.stringify(project('Browser backup')), desktop: {
    loadRecovery: async () => '{broken', onBeforeClose() {},
  } });
  vm.runInContext(startupCode, context);
  await vm.runInContext('projectWorkspaceInitialization', context);
  assert.equal(context.restored.name, 'Browser backup');
});

test('web mode still restores browser projects', async () => {
  const { context } = workspace({ browserSnapshot: JSON.stringify(project('Web project')) });
  vm.runInContext(startupCode, context);
  await vm.runInContext('projectWorkspaceInitialization', context);
  assert.equal(context.restored.name, 'Web project');
  await context.persistProjectRecovery();
});

test('desktop close waits for recovery on disk and never confirms a failed save', async () => {
  let beforeClose, finishSave, closed = false;
  const { context } = workspace({ desktop: {
    loadRecovery: async () => JSON.stringify(project('Saved')),
    onBeforeClose: callback => { beforeClose = callback; },
    saveRecovery: () => new Promise(resolve => { finishSave = resolve; }),
    readyToClose: attemptId => { assert.equal(attemptId, 1); closed = true; },
  } });
  vm.runInContext(startupCode, context);
  await vm.runInContext('projectWorkspaceInitialization', context);
  const closing = beforeClose(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  finishSave();
  await closing;
  assert.equal(closed, true);
  closed = false;
  context.desktopClosing = false;
  context.desktopBridge.saveRecovery = async () => { throw new Error('disk full'); };
  await beforeClose(2);
  assert.equal(closed, false);
  assert.equal(context.desktopClosing, false);
});

test('canceling a slow close resumes editing and ignores late completion from that attempt', async () => {
  let beforeClose, cancelled, finishSave, autosaves = 0;
  const closed = [];
  const { context } = workspace({ desktop: {
    loadRecovery: async () => JSON.stringify(project('Saved')),
    onBeforeClose: callback => { beforeClose = callback; },
    onCloseCancelled: callback => { cancelled = callback; },
    saveRecovery: () => new Promise(resolve => { finishSave = resolve; }),
    readyToClose: attemptId => { closed.push(attemptId); },
  } });
  context.scheduleAutosave = () => { autosaves++; };
  vm.runInContext(startupCode, context);
  await vm.runInContext('projectWorkspaceInitialization', context);
  const oldAttempt = beforeClose(1);
  await new Promise(resolve => setImmediate(resolve));
  cancelled(1);
  assert.equal(context.desktopClosing, false);
  assert.equal(autosaves, 1);
  context.desktopBridge.saveRecovery = async () => {};
  const newAttempt = beforeClose(2);
  cancelled(1);
  assert.equal(context.desktopClosing, true);
  finishSave();
  await Promise.all([oldAttempt, newAttempt]);
  assert.deepEqual(closed, [2]);
});

test('desktop update opens the installer release without invoking the source updater', async () => {
  const requests = [], nodes = new Map();
  let releaseOpened = false;
  const context = vm.createContext({
    desktopBridge: { openRelease: async () => { releaseOpened = true; } },
    document: { getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, { classList: { add() {}, remove() {} }, style: {} });
      return nodes.get(id);
    } },
    fetch: async url => { requests.push(url); return { json: async () => ({ mode: 'desktop', update_available: true, current: '1.0.0', latest: '1.1.0' }) }; },
  });
  await vm.runInContext(script.slice(script.indexOf('    (async function checkForUpdates')), context);
  assert.equal(nodes.get('update-apply-btn').textContent, 'Yeni sürümü indir');
  await nodes.get('update-apply-btn').onclick();
  assert.equal(releaseOpened, true);
  assert.deepEqual(requests, ['/api/check-update']);
});
