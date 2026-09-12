'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateController } = require('./updater.cjs');
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(overrides = {}) {
  const updater = new EventEmitter(), states = [], calls = [];
  updater.checkForUpdates = async () => { calls.push('check'); updater.emit('update-available', { version: '1.1.3' }); };
  updater.downloadUpdate = async () => { calls.push('download'); updater.emit('download-progress', { percent: 55 }); updater.emit('update-downloaded', { version: '1.1.3' }); };
  const controller = new UpdateController({ mode: 'automatic', currentVersion: '1.1.2', updater, onState: state => states.push(state), prepareInstall: async () => { calls.push('saved'); return { ready: true }; }, install: async () => calls.push('install'), ...overrides });
  return { updater, controller, states, calls };
}
test('check only notifies; explicit download verifies then saves before installation', async () => {
  const h = harness();
  await h.controller.check();
  assert.deepEqual(h.calls, ['check']);
  assert.equal(h.controller.getState().status, 'available');
  assert.equal(h.updater.autoDownload, false);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  assert.equal(h.updater.allowDowngrade, false);
  assert.equal(h.updater.allowPrerelease, false);
  await h.controller.download(); await settle();
  assert.deepEqual(h.calls, ['check', 'download', 'saved', 'install']);
  assert.ok(h.states.some(state => state.percent === 55));
  assert.equal(h.controller.getState().status, 'installing');
  h.controller.dispose();
});
test('render busy postpones installation without re-downloading, retries when idle', async () => {
  let busy = true, installed = 0;
  const h = harness({ prepareInstall: async () => ({ ready: !busy, message: 'Render sürüyor' }), install: async () => installed++ });
  await h.controller.check(); await h.controller.download(); await settle();
  assert.equal(h.controller.getState().status, 'waiting');
  assert.equal(installed, 0);
  busy = false; await h.controller.tryInstall();
  assert.equal(installed, 1);
  assert.equal(h.calls.filter(call => call === 'download').length, 1);
  h.controller.dispose();
});
test('repeated manual checks reopen a dismissed waiting dialog without restarting download', async () => {
  const h = harness({ prepareInstall: async () => ({ ready: false }) });
  await h.controller.check(true); await h.controller.download();
  await h.controller.check(true);
  assert.deepEqual(h.states.slice(-2).map(state => state.manualCheck), [false, true]);
  assert.equal(h.calls.filter(call => call === 'download').length, 1);
  h.controller.dispose();
});
test('recovery failure keeps app open and requires retry consent', async () => {
  let failed = true, installed = 0;
  const h = harness({ prepareInstall: async () => { if (failed) throw new Error('Disk full'); return { ready: true }; }, install: async () => installed++ });
  await h.controller.check(); await h.controller.download(); await settle();
  assert.equal(h.controller.getState().status, 'error');
  assert.equal(installed, 0);
  failed = false;
  await h.controller.tryInstall(); assert.equal(installed, 0);
  await h.controller.download(); assert.equal(installed, 1);
  h.controller.dispose();
});
test('checksum/network errors never install, retry performs a new download', async () => {
  const h = harness();
  await h.controller.check();
  const goodDownload = h.updater.downloadUpdate;
  h.updater.downloadUpdate = async () => { throw new Error('sha512 mismatch'); };
  await h.controller.download(); await settle();
  assert.equal(h.controller.getState().status, 'error');
  assert.equal(h.calls.includes('install'), false);
  h.updater.downloadUpdate = goodDownload;
  await h.controller.download(); await settle();
  assert.equal(h.calls.filter(call => call === 'install').length, 1);
  h.controller.dispose();
});
test('double-clicks cannot start competing downloads or installations', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ prepareInstall: async () => { await pending; return { ready: true }; } });
  await h.controller.check();
  const first = h.controller.download();
  await settle();
  await h.controller.download();
  assert.equal(h.calls.filter(call => call === 'download').length, 1);
  release(); await first; await settle();
  assert.equal(h.calls.filter(call => call === 'install').length, 1);
  h.controller.dispose();
});
test('Mac manual and unpackaged modes never call the native installer', async () => {
  for (const mode of ['manual', 'disabled']) {
    const h = harness({ mode, checkManual: async () => ({ version: '1.1.3' }) });
    await h.controller.check(true); await h.controller.download();
    assert.deepEqual(h.calls, []);
    assert.equal(h.controller.getState().status, mode === 'manual' ? 'available' : 'current');
    h.controller.dispose();
  }
});
test('disposal cancels delayed busy retry and ignores late events', async () => {
  const h = harness({ prepareInstall: async () => ({ ready: false }) });
  await h.controller.check(); await h.controller.download(); await settle();
  h.controller.dispose();
  assert.equal(h.updater.listenerCount('update-downloaded'), 0);
  await h.controller.tryInstall();
  assert.equal(h.calls.includes('install'), false);
});
test('late download bookkeeping failure never prepares or freezes the editor', async () => {
  const h = harness();
  await h.controller.check();
  h.updater.downloadUpdate = async () => { h.updater.emit('update-downloaded', { version: '1.1.3' }); await settle(); throw new Error('blockmap copy failed'); };
  await h.controller.download();
  assert.equal(h.controller.getState().status, 'error');
  assert.equal(h.calls.includes('saved'), false);
  assert.equal(h.controller.downloaded, false);
  h.controller.dispose();
});
test('updater error during preparation cancels the acquired gate instead of freezing forever', async () => {
  let release, cancelled = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ prepareInstall: async () => { await pending; return { ready: true }; }, cancelInstall: async () => cancelled++ });
  await h.controller.check();
  const download = h.controller.download(); await settle();
  h.updater.emit('error', new Error('late update failure'));
  release(); await download;
  assert.equal(cancelled, 1);
  assert.equal(h.calls.includes('install'), false);
  assert.equal(h.controller.getState().status, 'error');
  h.controller.dispose();
});
test('disposal while preparation is pending releases an acquired gate', async () => {
  let release, cancelled = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ prepareInstall: () => pending, cancelInstall: async () => cancelled++ });
  await h.controller.check();
  const downloading = h.controller.download(); await settle();
  h.controller.dispose(); release({ ready: true }); await downloading;
  assert.equal(cancelled, 1);
  assert.equal(h.calls.includes('install'), false);
});

// Execute the actual main-process launch/quit handlers and the installed
// electron-updater BaseUpdater implementation. Only OS installation and Electron
// itself are mocked: no installer, backend, real timers or app exit is started.
function nativeQuitHarness(synchronousFailure = false) {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const callbacks = [], calls = [], nativeUpdater = new EventEmitter(), app = new EventEmitter();
  const exports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('electron-updater/out/BaseUpdater'), 'utf8'), {
    exports, setImmediate: callback => callbacks.push(callback),
    require: name => name === './AppUpdater' ? { AppUpdater: class extends EventEmitter {} }
      : name === 'electron' ? { autoUpdater: nativeUpdater } : require(name),
  });
  const updater = new exports.BaseUpdater();
  updater._logger = { info() {}, warn() {} };
  updater.install = (silent, forceRun) => {
    calls.push(['installer', silent, forceRun]);
    if (synchronousFailure) { updater.emit('error', new Error('Installer refused')); return false; }
    return true;
  };
  updater.app = { quit: () => {
    calls.push('quit');
    app.emit('before-quit', { preventDefault: () => calls.push('prevented') });
  } };
  const context = {
    app, updater, nativeUpdater, exiting: false, allowClose: false,
    mainWindow: { isDestroyed: () => false, close: () => calls.push('normal-close') },
    updates: { dispose: () => calls.push('dispose') }, updateTimer: null,
    stopBackend: async () => calls.push('unexpected-second-stop'),
    log: { end: () => calls.push('log-end') }, note() {},
    setTimeout: () => 1, clearTimeout() {}, clearInterval() {},
  };
  vm.createContext(context);
  const quitStart = source.indexOf("app.on('before-quit', event => {");
  const quitEnd = source.indexOf("app.on('will-quit'", quitStart);
  assert.ok(quitStart >= 0 && quitEnd > quitStart);
  vm.runInContext(source.slice(quitStart, quitEnd), context);
  const launchStart = source.indexOf('launchInstaller: () => ') + 'launchInstaller: '.length;
  const launchEnd = source.indexOf(',\n      recoverBackend:', launchStart);
  assert.ok(launchStart > 0 && launchEnd > launchStart);
  const launch = vm.runInContext('(' + source.slice(launchStart, launchEnd) + ')', context);
  return { launch, context, callbacks, calls, updater, nativeUpdater };
}
test('successful NSIS update quit bypasses ordinary close and keeps force-relaunch enabled', async () => {
  const h = nativeQuitHarness();
  const launched = h.launch();
  assert.deepEqual(h.calls, [['installer', true, true]]);
  assert.equal(h.context.exiting, true);
  assert.equal(h.context.allowClose, true);
  assert.equal(h.callbacks.length, 1);
  h.callbacks[0](); await launched;
  assert.deepEqual(h.calls, [['installer', true, true], 'quit']);
  assert.equal(h.nativeUpdater.listenerCount('before-quit-for-update'), 0);
  assert.equal(h.updater.listenerCount('error'), 0);
});
test('synchronous installer rejection clears shutdown flags and never queues app quit', async () => {
  const h = nativeQuitHarness(true);
  await assert.rejects(h.launch(), /Installer refused/);
  assert.equal(h.context.exiting, false);
  assert.equal(h.context.allowClose, false);
  assert.equal(h.callbacks.length, 0);
  assert.deepEqual(h.calls, [['installer', true, true]]);
  assert.equal(h.nativeUpdater.listenerCount('before-quit-for-update'), 0);
  assert.equal(h.updater.listenerCount('error'), 0);
});
test('installed NSIS updater passes update/silent/force-relaunch flags to its installer', async () => {
  const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
  const calls = [];
  const accepted = NsisUpdater.prototype.doInstall.call({
    installerPath: '/verified/installer.exe', downloadedUpdateHelper: null,
    _logger: { info() {} }, spawnLog: async (executable, args) => calls.push([executable, args]),
  }, { isSilent: true, isForceRunAfter: true, isAdminRightsRequired: false });
  assert.equal(accepted, true);
  assert.deepEqual(calls, [['/verified/installer.exe', ['--updated', '/S', '--force-run']]]);
});
