'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing main-process test boundary: ${start}`);
  return source.slice(first, last);
}
// Execute the production close/save handlers, never Electron imports, app
// startup, real dialogs, project paths, timers, or backend subprocesses.
const handlers = [
  section('function desktopWorkActive()', 'async function saveRecovery('),
  section("ipcMain.handle('desktop:save-output'", 'async function freePort('),
  section('async function requestClose(event)', 'async function importLegacy('),
].join('\n');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const ipc = new Map(), timers = [], notifications = [], messageBoxes = [];
  const health = deferred(), saveDialog = deferred();
  let closes = 0, prevented = 0, copies = 0;
  const event = {};
  const context = {
    closePending: false, closeAttempt: 0, closePreparing: 0, closeInterruptRender: false,
    allowClose: false, exiting: false, backendFailed: false, activeDesktopTasks: 0, activeDownloads: 0,
    updateHandoff: null,
    activeNativeSaves: 0, nativeSaveQueue: Promise.resolve(), recoveryQueue: Promise.resolve(),
    lastSaveDirectory: '', origin: 'http://127.0.0.1:4567', dataDir: '/test-library', smoke: false,
    path, note() {},
    trusted: sender => sender === event,
    requireTrusted(sender) { assert.equal(sender, event); },
    isLocalURL: (url, origin) => url === origin,
    app: { getPath: name => `/test-${name}` },
    outputFile: () => ({ source: '/test-library/outputs/render.mp4', extension: 'mp4' }),
    requireOutput: async () => {},
    copyOutput: async () => { copies++; },
    backendRequest: route => route === '/api/health' ? health.promise : Promise.resolve({ close_ready: true }),
    dialog: {
      showSaveDialog: () => saveDialog.promise,
      showMessageBox: async (_window, options) => { messageBoxes.push(options); return { response: 0 }; },
    },
    ipcMain: { handle: (name, callback) => ipc.set(name, callback), on: (name, callback) => ipc.set(name, callback) },
    mainWindow: {
      webContents: {
        getURL: () => context.origin,
        send: (...args) => notifications.push(args),
      },
      close() { closes++; },
      isDestroyed: () => false,
    },
    setTimeout(callback) { timers.push(callback); return { unref() {} }; },
  };
  vm.createContext(context);
  vm.runInContext(handlers, context, { filename: 'main-close-handlers.cjs' });
  return {
    context, health, saveDialog, timers, notifications, messageBoxes,
    get closes() { return closes; }, get prevented() { return prevented; }, get copies() { return copies; },
    requestClose: () => context.requestClose({ preventDefault() { prevented++; } }),
    save: () => ipc.get('desktop:save-output')(event, '/download/generated/mp4'),
    ready: (attempt, error) => ipc.get('desktop:ready-to-close')(event, attempt, error),
  };
}

test('native save starting during health await cancels the stale close attempt', async () => {
  const h = harness();
  const close = h.requestClose();
  const attempt = h.context.closeAttempt;
  assert.equal(h.context.closePending, true);

  const save = h.save();
  assert.equal(h.context.activeNativeSaves, 1);
  assert.equal(h.context.closePending, false);
  assert.ok(h.context.closeAttempt > attempt);
  assert.deepEqual(h.notifications, [['desktop:close-cancelled', attempt]]);

  h.health.resolve({ active_jobs: 0 });
  await close;
  h.ready(attempt);
  await settle();
  assert.equal(h.closes, 0);
  assert.equal(h.context.allowClose, false);
  assert.equal(h.timers.length, 0);
  assert.equal(h.notifications.some(([name]) => name === 'desktop:before-close'), false);

  h.saveDialog.resolve({ canceled: false, filePath: '/chosen/video.mp4' });
  const saved = await save;
  assert.equal(saved.saved, true);
  assert.equal(h.copies, 1);
  assert.equal(h.context.activeNativeSaves, 0);
});

test('native save starting during recovery await resumes editing and allows a later safe close', async () => {
  const h = harness();
  h.health.resolve({ active_jobs: 0 });
  await h.requestClose();
  const attempt = h.context.closeAttempt;
  assert.deepEqual(h.notifications, [['desktop:before-close', attempt, false]]);
  const recovery = deferred();
  h.context.recoveryQueue = recovery.promise;
  h.ready(attempt);

  const save = h.save();
  assert.deepEqual(h.notifications.at(-1), ['desktop:close-cancelled', attempt]);
  recovery.resolve();
  await settle();
  assert.equal(h.closes, 0);
  assert.equal(h.context.allowClose, false);
  assert.equal(h.context.closePending, false);

  // A stale renderer response and the old emergency timer cannot close it.
  h.ready(attempt);
  await h.timers[0]();
  assert.equal(h.closes, 0);
  assert.equal(h.messageBoxes.length, 0);
  h.saveDialog.resolve({ canceled: true });
  await save;
  assert.equal(h.context.activeNativeSaves, 0);

  await h.requestClose();
  const nextAttempt = h.context.closeAttempt;
  assert.ok(nextAttempt > attempt);
  assert.deepEqual(h.notifications.at(-1), ['desktop:before-close', nextAttempt, false]);
  h.ready(nextAttempt);
  await settle();
  assert.equal(h.context.allowClose, true);
  assert.equal(h.closes, 1);
});

test('recovery timeout cancels close and permits a native save while the warning is open', async () => {
  const h = harness();
  h.health.resolve({ active_jobs: 0 });
  await h.requestClose();
  const attempt = h.context.closeAttempt;
  const confirmation = deferred();
  h.context.dialog.showMessageBox = () => confirmation.promise;
  const warning = h.timers[0]();
  const save = h.save();
  confirmation.resolve({ response: 1 });
  await warning;
  assert.equal(h.closes, 0);
  assert.equal(h.context.allowClose, false);
  assert.deepEqual(h.notifications.at(-1), ['desktop:close-cancelled', attempt]);
  h.saveDialog.resolve({ canceled: true });
  await save;
});

test('an already active native save blocks close before querying health', async () => {
  const h = harness();
  const save = h.save();
  await h.requestClose();
  assert.equal(h.prevented, 1);
  assert.equal(h.messageBoxes.length, 1);
  assert.equal(h.messageBoxes[0].type, 'info');
  assert.equal(h.context.closePending, false);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.closes, 0);
  h.saveDialog.resolve({ canceled: true });
  await save;
});

test('committed close or shutdown rejects new native saves without opening a dialog', () => {
  for (const flag of ['allowClose', 'exiting']) {
    const h = harness();
    h.context[flag] = true;
    assert.throws(() => h.save(), /Uygulama kapanıyor/);
    assert.equal(h.context.activeNativeSaves, 0);
    assert.equal(h.context.closeAttempt, 0);
    assert.equal(h.notifications.length, 0);
  }
});


test('active uploads, analysis, imports and downloads prevent close', async () => {
  for (const blocked of [{ active_requests: 1 }, { active_jobs: 1, active_non_render_jobs: 1 }]) {
    const h = harness();
    h.health.resolve(blocked);
    await h.requestClose();
    assert.equal(h.messageBoxes.length, 1);
    assert.equal(h.notifications.some(([name]) => name === 'desktop:before-close'), false);
  }
  for (const active of ['activeDesktopTasks', 'activeDownloads']) {
    const h = harness();
    h.context[active] = 1;
    await h.requestClose();
    assert.equal(h.messageBoxes.length, 1);
    assert.equal(h.notifications.length, 0);
  }
});

test('confirmed render interruption still requires recovery and an atomic backend gate', async () => {
  const h = harness();
  const prepare = deferred();
  const requested = [];
  h.context.backendRequest = route => {
    requested.push(route);
    if (route === '/api/health') return Promise.resolve({ active_jobs: 1, active_non_render_jobs: 0 });
    if (route.includes('prepare-close')) return prepare.promise;
    return Promise.resolve({ closing: false });
  };
  h.context.dialog.showMessageBox = async () => ({ response: 1 });
  await h.requestClose();
  assert.deepEqual(h.notifications.at(-1), ['desktop:before-close', 1, true]);
  const openGate = h.ready(1);
  await settle();
  assert.match(requested.at(-1), /prepare-close\?attempt=1&interrupt_render=true/);
  assert.equal(h.closes, 0);
  prepare.resolve({ close_ready: true });
  await openGate;
  assert.equal(h.closes, 1);
});

test('close is cancelled when the backend becomes busy after the renderer snapshot', async () => {
  const h = harness();
  const requested = [];
  h.context.backendRequest = async route => {
    requested.push(route);
    if (route.includes('prepare-close')) throw new Error('HTTP 409');
    return {};
  };
  await h.requestClose();
  await h.ready(1);
  assert.equal(h.closes, 0);
  assert.equal(h.context.closePending, false);
  assert.match(requested.at(-1), /cancel-close\?attempt=1/);
  assert.deepEqual(h.notifications.at(-1), ['desktop:close-cancelled', 1]);
});
