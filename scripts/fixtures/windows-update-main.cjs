'use strict';
// CI-only entry point copied into a tiny fixture app. It is not included by
// the production package's files list and never reads real editor projects.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { NsisUpdater } = require('electron-updater');
const { UpdateController } = require('./updater.cjs');
const config = require('./fixture-config.json');

const root = path.resolve(config.root);
assert.equal(process.platform, 'win32');
assert.equal(path.dirname(path.dirname(process.execPath)).toLowerCase(), root.toLowerCase());
assert.equal(fs.readFileSync(path.join(root, '.update-fixture'), 'utf8'), config.nonce);
const projectDir = path.join(root, 'project-data');
const recoveryFile = path.join(projectDir, 'recovery.json');
const resultFile = path.join(root, 'result.json');
const eventsFile = path.join(root, 'events.jsonl');
app.setPath('userData', path.join(root, 'user-data'));
app.disableHardwareAcceleration();

function record(type, details = {}) {
  fs.appendFileSync(eventsFile, JSON.stringify({ type, version: app.getVersion(), ...details }) + '\n');
}
function fail(error) {
  record('failure', { message: error.stack || String(error) });
  fs.writeFileSync(resultFile + '.tmp', JSON.stringify({ ok: false, message: error.message || String(error) }));
  fs.renameSync(resultFile + '.tmp', resultFile);
  app.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
fs.writeFileSync(path.join(root, 'running.json'), JSON.stringify({ pid: process.pid, version: app.getVersion() }));

app.whenReady().then(async () => {
  record('started', { argv: process.argv });
  const snapshot = JSON.parse(await fsp.readFile(recoveryFile, 'utf8'));
  assert.equal(snapshot.id, config.nonce);
  const media = await fsp.readFile(path.join(projectDir, 'uploads', 'fixture-media.bin'));
  assert.equal(crypto.createHash('sha256').update(media).digest('hex'), config.mediaHash);

  if (app.getVersion() === config.nextVersion) {
    // The driver never launches N+1: only NSIS --force-run may reach here.
    assert.ok(process.argv.includes('--updated'), 'The replacement must be launched by the updater');
    assert.equal(snapshot.name, 'Saved immediately before updating');
    assert.equal(snapshot.savedBy, config.previousVersion);
    assert.ok((await fsp.stat(path.join(root, 'prepared.json'))).isFile());
    const events = (await fsp.readFile(eventsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.type === 'download-verified'));
    assert.ok(events.some(event => event.type === 'installer-started'));
    const proof = { ok: true, previousVersion: config.previousVersion, version: app.getVersion(),
      autoRelaunched: true, recoveryPreserved: true, mediaPreserved: true, installPath: process.execPath };
    await fsp.writeFile(resultFile + '.tmp', JSON.stringify(proof));
    await fsp.rename(resultFile + '.tmp', resultFile);
    app.quit();
    return;
  }

  assert.equal(app.getVersion(), config.previousVersion);
  const updater = new NsisUpdater({ provider: 'generic', url: config.feedURL });
  // Keep the updater cache in the fixture workspace too; the normal Electron
  // adapter and real HTTP/checksum/NSIS implementation are otherwise untouched.
  Object.defineProperty(updater.app, 'baseCachePath', { value: path.join(root, 'updater-cache') });
  updater.logger = { info: message => record('updater-log', { message }),
    warn: message => record('updater-warning', { message }), error: message => record('updater-error', { message }) };
  updater.on('update-downloaded', event => record('download-verified', { version: event.version }));

  const controller = new UpdateController({
    mode: 'automatic', currentVersion: app.getVersion(), updater,
    onState: state => {
      record('state', state);
      if (state.status === 'error') setImmediate(() => fail(new Error(state.message)));
    },
    log: message => record('controller-log', { message }),
    prepareInstall: async () => {
      snapshot.name = 'Saved immediately before updating';
      snapshot.savedBy = app.getVersion();
      const temporary = path.join(projectDir, 'recovery.tmp');
      const handle = await fsp.open(temporary, 'w');
      try { await handle.writeFile(JSON.stringify(snapshot)); await handle.sync(); }
      finally { await handle.close(); }
      await fsp.rename(temporary, recoveryFile);
      await fsp.writeFile(path.join(root, 'prepared.json'), JSON.stringify({ saved: true, backendStopped: true }));
      record('prepared');
      return { ready: true };
    },
    install: async () => {
      assert.equal(JSON.parse(await fsp.readFile(recoveryFile, 'utf8')).savedBy, config.previousVersion);
      assert.ok((await fsp.stat(path.join(root, 'prepared.json'))).isFile());
      record('installer-started');
      updater.quitAndInstall(true, true);
    },
  });
  await controller.check(true);
  assert.equal(controller.getState().status, 'available', 'The fixture must discover the newer installer');
  await controller.download();
  record('download-call-complete', controller.getState());
}).catch(fail);
