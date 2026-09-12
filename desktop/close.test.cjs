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
  section('function cancelPendingClose()', 'async function saveRecovery('),
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
    closePending: false, closeAttempt: 0, allowClose: false, exiting: false,
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
    backendRequest: () => health.promise,
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
    ready: attempt => ipc.get('desktop:ready-to-close')(event, attempt),
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
  assert.deepEqual(h.notifications, [['desktop:before-close', attempt]]);
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
  assert.deepEqual(h.notifications.at(-1), ['desktop:before-close', nextAttempt]);
  h.ready(nextAttempt);
  await settle();
  assert.equal(h.context.allowClose, true);
  assert.equal(h.closes, 1);
});

test('native save cancels forced close even while its confirmation dialog is awaiting a choice', async () => {
  const h = harness();
  h.health.resolve({ active_jobs: 0 });
  await h.requestClose();
  const attempt = h.context.closeAttempt;
  const confirmation = deferred();
  h.context.dialog.showMessageBox = () => confirmation.promise;
  const forcedClose = h.timers[0]();
  const save = h.save();
  confirmation.resolve({ response: 1 });
  await forcedClose;
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
