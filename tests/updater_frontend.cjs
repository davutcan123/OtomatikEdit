const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const tracker = script.slice(script.indexOf('    function beginDesktopOperation'), script.indexOf('    // Keep the workflow active'));
const updater = script.slice(script.indexOf('    let desktopUpdateState='), script.indexOf('    if(desktopBridge)initializeDesktopUpdater()'));
const autoRecovery = script.slice(script.indexOf('    function normalizeAutoCutterData'), script.indexOf("    el('auto-clear-selection').onclick")) + script.slice(script.indexOf('    function autoResult'), script.indexOf('    function drawAuto'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };

function harness() {
  const nodes = new Map(), acknowledgements = [], listeners = {}, hooks = {}, calls = [];
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set(id === 'export-modal' ? ['hidden'] : []);
    const value = { id, tagName: 'DIV', inert: false, open: false, style: {}, hidden: false, textContent: '',
      classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) },
      setAttribute(key, val) { this[key] = val; }, querySelector: () => node(id + '-child'),
      showModal() { this.open = true; }, close() { this.open = false; },
      addEventListener(type, callback) { this[type] = callback; }, contains(target) { return target === this || target?.id?.startsWith('desktop-update-'); },
    };
    nodes.set(id, value);return value;
  }
  const media = { paused: false, pause() { this.paused = true; } };
  const bridge = {
    onUpdateState(callback) { hooks.state = callback; }, onPrepareUpdate(callback) { hooks.prepare = callback; }, onUpdateCancelled(callback) { hooks.cancel = callback; },
    readyForUpdate(...args) { acknowledgements.push(args); },
    getUpdateState: async () => ({ mode: 'automatic', status: 'idle', currentVersion: '1.0.0' }),
    downloadUpdate: async () => { calls.push('download'); return { mode: 'automatic', status: 'downloading', currentVersion: '1.0.0', version: '1.1.0', percent: 0 }; },
    checkForUpdates: async () => { calls.push('check'); return { mode: 'automatic', status: 'current', currentVersion: '1.1.0', manualCheck: true }; },
    openRelease: async () => calls.push('manual-release'),
  };
  const context = vm.createContext({
    desktopBridge: bridge, desktopOperations: new Map(), desktopInertState: new Map(), desktopUpdateFrozen: false, desktopUpdateAttempt: null, desktopClosing: false, desktopPointerActive: false,
    S: {}, recoveryWrite: Promise.resolve(), projectWorkspaceInitialization: Promise.resolve(), persistProjectRecovery: async () => calls.push('saved'), scheduleAutosave: () => calls.push('autosave'),
    el: node, clearTimeout, stopProjectAudio() {}, drawAuto() {}, log() {},
    document: { body: { children: [node('workbench'), node('desktop-update-dialog')] }, activeElement: { blur() {} }, querySelector: () => null, querySelectorAll: () => [media] },
    window: { addEventListener(type, callback) { (listeners[type] ||= []).push(callback); } },
  });
  vm.runInContext(tracker + updater, context);
  return { context, node, calls, hooks, acknowledgements, media, listeners };
}

test('automatic update requires consent, shows progress and Later remains dismissed until a manual check', async () => {
  const { context: c, node, calls } = harness();
  await c.initializeDesktopUpdater();
  const available = { mode: 'automatic', status: 'available', currentVersion: '1.0.0', version: '1.1.0' };
  c.drawDesktopUpdate(available);
  assert.equal(node('desktop-update-dialog').open, true);
  assert.match(node('desktop-update-message').textContent, /yeniden açılır/);
  assert.deepEqual(calls, []);
  await node('desktop-update-primary').onclick();
  assert.deepEqual(calls, ['download']);
  c.drawDesktopUpdate({ ...available, status: 'downloading', percent: 52.4 });
  assert.equal(node('desktop-update-meter-child').style.width, '52.4%');
  assert.equal(node('desktop-update-percent').textContent, '52%');
  node('desktop-update-later').onclick();
  c.drawDesktopUpdate({ ...available, status: 'downloading', percent: 63 });
  assert.equal(node('desktop-update-dialog').open, false);
  c.drawDesktopUpdate({ ...available, status: 'checking', manualCheck: true });
  assert.equal(node('desktop-update-dialog').open, true);
});

test('macOS updates use the controlled release opener instead of automatic install', async () => {
  const { context: c, calls, node } = harness();
  await c.initializeDesktopUpdater();
  c.drawDesktopUpdate({ mode: 'manual', status: 'available', currentVersion: '1.0.0', version: '1.1.0' });
  assert.equal(node('desktop-update-primary').textContent, 'İndirme sayfasını aç');
  await node('desktop-update-primary').onclick();
  assert.deepEqual(calls, ['manual-release']);
});

test('an entire async workflow remains busy through result application, not just its request', async () => {
  const { context: c, acknowledgements } = harness(), response = deferred(), applied = deferred();
  const work = c.trackedDesktopWorkflow('Altyazı oluşturma', async () => { await response.promise; await applied.promise; });
  const pending = work();response.resolve();await tick();
  await c.prepareDesktopUpdate(1);
  assert.equal(acknowledgements[0][2], true);
  assert.match(acknowledgements[0][1], /Altyazı oluşturma/);
  assert.equal(c.desktopUpdateFrozen, false);
  applied.resolve();await pending;
  await c.prepareDesktopUpdate(2);
  assert.deepEqual(acknowledgements[1], [2]);
});

test('prepare freezes editing immediately and waits for initialization, pending writes and the final saved snapshot', async () => {
  const { context: c, acknowledgements, node, media } = harness();
  const startup = deferred(), prior = deferred(), save = deferred();let saves = 0;
  c.projectWorkspaceInitialization = startup.promise;c.recoveryWrite = prior.promise;
  c.persistProjectRecovery = async () => { saves++;await save.promise; };
  const preparing = c.prepareDesktopUpdate(3);
  assert.equal(c.desktopUpdateFrozen, true);assert.equal(node('workbench').inert, true);assert.equal(media.paused, true);
  assert.throws(() => c.beginDesktopOperation('Render'), /yeni işlem başlatılamaz/);
  startup.resolve();await tick();assert.equal(saves, 0);
  prior.resolve();await tick();assert.equal(saves, 1);assert.deepEqual(acknowledgements, []);
  save.resolve();await preparing;assert.deepEqual(acknowledgements, [[3]]);
  assert.equal(node('desktop-update-later').hidden, true);
});

test('failed final recovery never confirms installation and restores editor controls', async () => {
  const { context: c, acknowledgements, node } = harness();
  c.persistProjectRecovery = async () => { throw new Error('disk full'); };
  await c.prepareDesktopUpdate(4);
  assert.equal(acknowledgements.length, 1);assert.equal(acknowledgements[0][0], 4);assert.equal(acknowledgements[0][2], false);
  assert.match(acknowledgements[0][1], /disk full/);
  assert.equal(c.desktopUpdateFrozen, false);assert.equal(node('workbench').inert, false);
});

test('cancel restores previous inert state and stale update attempts cannot complete or cancel a newer attempt', async () => {
  const { context: c, acknowledgements, node } = harness(), save = deferred();
  node('workbench').inert = true;c.persistProjectRecovery = () => save.promise;
  const first = c.prepareDesktopUpdate(5);await tick();
  c.cancelDesktopUpdate(5);assert.equal(c.desktopUpdateFrozen, false);assert.equal(node('workbench').inert, true);
  c.persistProjectRecovery = async () => {};
  const second = c.prepareDesktopUpdate(6);
  c.cancelDesktopUpdate(5);assert.equal(c.desktopUpdateFrozen, true);
  save.resolve();await Promise.all([first, second]);assert.deepEqual(acknowledgements, [[6]]);
});

test('close, active pointer gestures and open edit dialogs postpone the update', async () => {
  const { context: c, acknowledgements, node } = harness();
  c.desktopClosing = true;await c.prepareDesktopUpdate(7);c.desktopClosing = false;
  c.desktopPointerActive = true;await c.prepareDesktopUpdate(8);c.desktopPointerActive = false;
  node('export-modal').classList.remove('hidden');await c.prepareDesktopUpdate(9);
  assert.deepEqual(acknowledgements.map(item => item[2]), [true, true, true]);assert.equal(c.desktopUpdateFrozen, false);
});

test('frozen input is blocked outside update dialog, and cancellation cannot dismiss preparation', async () => {
  const { context: c, node, listeners } = harness();await c.initializeDesktopUpdater();
  c.desktopUpdateFrozen = true;let prevented = 0, stopped = 0;
  listeners.keydown[0]({ target: node('workbench'), preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } });
  assert.equal(prevented, 1);assert.equal(stopped, 1);
  node('desktop-update-dialog').cancel({ preventDefault() { prevented++; } });assert.equal(prevented, 2);
});

test('all asynchronous editor workflows are registered, including imports, native saves and analysis', () => {
  for (const name of ['importProjectFiles', 'generateSubtitles', 'render', 'startSnapshot', 'saveCompletedOutput', 'saveNamedProject', 'loadNamedProject', 'deleteNamedProject']) assert.match(script, new RegExp(name + '=trackedDesktopWorkflow'));
  assert.match(script, /el\('analyze'\)\.onclick=trackedDesktopWorkflow/);
  assert.match(script, /beginDesktopOperation\('Video hazırlanıyor'\)/);
});

test('completed auto-cutter results survive recovery without serializing File objects or port-dependent URLs', () => {
  const { context: c, node } = harness();vm.runInContext(autoRecovery, c);
  Object.assign(c.S, { autoId: 'uploaded video.mp4', autoSourceName: 'Konuşma.mp4', autoFile: { name: 'Konuşma.mp4', privateFileHandle: 'not serializable' }, autoData: {
    duration: 10, valid_segments: [{ start: 0, end: 3 }, { start: 4, end: 10 }], silences: [{ start: 3, end: 4 }], keyword_segments: [], merged_exclusions: [{ start: 3, end: 4 }], unusedTranscript: 'not needed',
  } });
  node('threshold').value = '-25';node('duration').value = '.6';node('keywords').value = 'şey';node('auto-format').value = 'mp4';node('jump').checked = true;
  const saved = JSON.parse(JSON.stringify(c.captureAutoCutterState()));
  assert.equal(saved.fileId, 'uploaded video.mp4');assert.equal(saved.data.valid_segments.length, 2);
  assert.equal(saved.autoFile, undefined);assert.equal(saved.data.unusedTranscript, undefined);
  c.restoreAutoCutterState(saved);
  assert.equal(c.S.autoFile, null);assert.equal(c.S.autoPendingSelection, false);assert.equal(c.S.autoSourceName, 'Konuşma.mp4');
  assert.equal(c.S.autoData.valid_segments[1].start, 4);assert.equal(node('auto-video').src, '/video/uploaded%20video.mp4');
  assert.equal(node('analyze').disabled, true);assert.equal(node('auto-actions').classList.contains('hidden'), false);
  assert.match(script, /autoCutter:captureAutoCutterState\(\)/);assert.match(script, /restoreAutoCutterState\(payload.autoCutter\)/);
});

test('an unprocessed auto-file selection postpones install and clearing it preserves the earlier analysis', async () => {
  const { context: c, acknowledgements, node } = harness();vm.runInContext(autoRecovery, c);
  const previous = { duration: 5, valid_segments: [{ start: 0, end: 5 }] };
  Object.assign(c.S, { autoId: 'previous.mp4', autoSourceName: 'Önceki video', autoData: previous });
  c.setAutoFile({ name: 'Yeni video.mp4', size: 100 });
  await c.prepareDesktopUpdate(10);
  assert.equal(acknowledgements[0][2], true);assert.match(acknowledgements[0][1], /Seçimi temizle/);
  c.clearAutoFileSelection();assert.equal(c.S.autoData, previous);assert.equal(c.S.autoId, 'previous.mp4');
  assert.equal(c.S.autoPendingSelection, false);assert.equal(node('auto-clear-selection').classList.contains('hidden'), true);
  await c.prepareDesktopUpdate(11);assert.deepEqual(acknowledgements[1], [11]);
});

test('auto-cutter rejects corrupt persisted ranges and prevents changing the source during analysis', () => {
  const { context: c } = harness();vm.runInContext(autoRecovery, c);
  assert.equal(c.normalizeAutoCutterData({ duration: 4, valid_segments: 'broken' }), null);
  const data = c.normalizeAutoCutterData({ duration: 4, valid_segments: [{ start: -1, end: 9 }, { start: 3, end: 2 }, { start: 'broken', end: 4 }] });
  assert.equal(data.valid_segments.length, 1);assert.equal(data.valid_segments[0].start, 0);assert.equal(data.valid_segments[0].end, 4);
  c.S.autoFile = { name: 'Analiz edilen' };c.S.autoAnalyzing = true;
  c.setAutoFile({ name: 'Başka dosya', size: 50 });assert.equal(c.S.autoFile.name, 'Analiz edilen');
});
