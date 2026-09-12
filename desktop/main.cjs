'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, clipboard, autoUpdater: nativeUpdater } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { isLocalURL, validateRecovery } = require('./security.cjs');
const { outputFile, requireOutput, copyOutput, prepareLibrary } = require('./storage.cjs');
const { UpdateController } = require('./updater.cjs');
const { UpdateHandoff } = require('./update-handoff.cjs');
const { LogWindow } = require('./log-window.cjs');

const RELEASE_URL = 'https://github.com/davutcan123/OtomatikEdit/releases/latest';
const root = path.resolve(__dirname, '..');
const smoke = process.argv.includes('--smoke-test');
if (smoke) app.disableHardwareAcceleration();
// Test runs never touch a user's projects or recovery snapshot.
if (smoke) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'otomatik-edit-desktop-test-')));
app.setName('Otomatik Edit');
const stateDir = app.getPath('userData');
const dataDir = smoke ? stateDir : path.join(app.getPath('documents'), 'Otomatik Edit');
const logDir = path.join(stateDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'desktop.log');
if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) {
  fs.renameSync(logPath, logPath + '.previous');
}
const log = fs.createWriteStream(logPath, { flags: 'a' });
let logWindow;
const note = value => { log.write(`[${new Date().toISOString()}] ${value}\n`); logWindow?.append({ source: 'app', message: String(value) }); };
const token = crypto.randomBytes(32).toString('hex');
let backend, mainWindow, origin = '', exiting = false, allowClose = false, closePending = false;
let backendFailed = false, recoveryQueue = Promise.resolve();
let closeAttempt = 0;
let nativeSaveQueue = Promise.resolve(), activeNativeSaves = 0, lastSaveDirectory = '';
let updates, updateHandoff, updateTimer, backendStopping = false;
let activeDesktopTasks = 0, activeDownloads = 0;

function trusted(event) {
  return mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame && isLocalURL(event.senderFrame.url, origin);
}
function requireTrusted(event) { if (!trusted(event)) throw new Error('Yetkisiz uygulama isteği.'); }
logWindow = new LogWindow({ BrowserWindow, ipcMain, clipboard, parent: () => mainWindow, trustedEditor: trusted });
function cancelPendingClose() {
  if (!closePending) return;
  const attempt = closeAttempt;
  closePending = false;
  closeAttempt++;
  mainWindow.webContents.send('desktop:close-cancelled', attempt);
}
async function saveRecovery(snapshot) {
  validateRecovery(snapshot);
  const target = path.join(dataDir, 'recovery.json');
  const temporary = path.join(dataDir, `recovery-${crypto.randomUUID()}.tmp`);
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(snapshot, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try {
    if (fs.existsSync(target)) await fsp.copyFile(target, path.join(dataDir, 'recovery.previous.json'));
    await fsp.rename(temporary, target);
  } finally { await fsp.unlink(temporary).catch(() => {}); }
}
ipcMain.handle('desktop:save-recovery', (event, snapshot) => {
  requireTrusted(event);
  // Serialize writes so an older delayed write cannot replace newer project data.
  const write = recoveryQueue.catch(() => {}).then(() => saveRecovery(snapshot));
  recoveryQueue = write;
  return write;
});
ipcMain.handle('desktop:load-recovery', async event => {
  requireTrusted(event);
  for (const name of ['recovery.json', 'recovery.previous.json']) {
    try { return validateRecovery(await fsp.readFile(path.join(dataDir, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') note(`Recovery ${name}: ${error.message}`); }
  }
  return null;
});
ipcMain.handle('desktop:open-release', event => { requireTrusted(event); return shell.openExternal(RELEASE_URL); });
ipcMain.handle('desktop:update-state', event => { requireTrusted(event); return updates.getState(); });
ipcMain.handle('desktop:check-updates', event => { requireTrusted(event); return updates.check(true); });
ipcMain.handle('desktop:download-update', event => { requireTrusted(event); return updates.download(); });
ipcMain.on('desktop:ready-for-update', (event, attempt, error, busy) => {
  if (!trusted(event) || !Number.isSafeInteger(attempt)) return;
  updateHandoff?.acknowledge(attempt, typeof error === 'string' ? error.slice(0, 500) : '', busy === true);
});
ipcMain.handle('desktop:storage-info', event => { requireTrusted(event); return { path: dataDir, projectsPath: path.join(dataDir, 'projects') }; });
ipcMain.handle('desktop:open-projects-folder', async event => {
  requireTrusted(event);
  const error = await shell.openPath(dataDir);
  if (error) throw new Error(error);
});
ipcMain.handle('desktop:save-output', (event, relativeURL) => {
  requireTrusted(event);
  const output = outputFile(relativeURL, dataDir);
  if (allowClose || exiting || updateHandoff?.committed) throw new Error('Uygulama kapanıyor; çıktı proje klasöründe korunuyor.');
  // A render may finish while the close flow awaits health/recovery. A new
  // native save cancels that older close attempt before showing its dialog.
  cancelPendingClose();
  updateHandoff?.interrupt();
  activeNativeSaves++;
  const save = nativeSaveQueue.catch(() => {}).then(async () => {
    await requireOutput(output.source, dataDir);
    const picture = output.extension === 'png';
    const options = {
      title: picture ? 'Düzenlenmiş kareyi kaydet' : 'Render çıktısını kaydet',
      defaultPath: path.join(lastSaveDirectory || app.getPath(picture ? 'pictures' : 'videos'), `${picture ? 'kare' : 'video'}.${output.extension}`),
      filters: [{ name: picture ? 'PNG görüntü' : output.extension.toUpperCase() + ' dosyası', extensions: [output.extension] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    // Automated tests use only their isolated temporary project directory.
    const choice = smoke ? { canceled: false, filePath: path.join(dataDir, 'saved-' + path.basename(output.source)) } : await dialog.showSaveDialog(mainWindow, options);
    if (choice.canceled || !choice.filePath) return { canceled: true, saved: false };
    await copyOutput(output.source, choice.filePath);
    lastSaveDirectory = path.dirname(choice.filePath);
    return { canceled: false, saved: true, path: choice.filePath };
  });
  nativeSaveQueue = save;
  return save.finally(() => { activeNativeSaves--; });
});
ipcMain.on('desktop:ready-to-close', (event, attempt) => {
  if (!trusted(event) || !closePending || attempt !== closeAttempt) return;
  recoveryQueue.then(() => {
    if (!closePending || attempt !== closeAttempt) return;
    if (activeNativeSaves > 0) { cancelPendingClose(); return; }
    allowClose = true; mainWindow?.close();
  }).catch(error => note(error.message));
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function backendRequest(route, options = {}) {
  const response = await fetch(origin + route, {
    ...options,
    headers: { ...options.headers, 'X-Desktop-Token': token },
    signal: AbortSignal.timeout(options.timeout || 4000),
  });
  if (!response.ok) throw new Error(`Yerel motor: HTTP ${response.status}`);
  return response.json();
}
async function startBackend() {
  backendFailed = false;
  backendStopping = false;
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  let executable, args;
  if (app.isPackaged) {
    executable = path.join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'OtomatikEditBackend.exe' : 'OtomatikEditBackend');
    args = [];
  } else {
    const candidates = process.platform === 'win32'
      ? [path.join(root, '.venv-windows', 'Scripts', 'python.exe'), 'python']
      : [path.join(root, 'venv', 'bin', 'python'), 'python3'];
    executable = process.env.SMART_EDITOR_PYTHON || candidates.find(p => fs.existsSync(p)) || candidates.at(-1);
    args = [path.join(root, 'app.py')];
  }
  const env = {
    ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1',
    SMART_EDITOR_DESKTOP: '1', SMART_EDITOR_DESKTOP_TOKEN: token,
    SMART_EDITOR_DATA_DIR: dataDir, SMART_EDITOR_HOST: '127.0.0.1', SMART_EDITOR_PORT: String(port), SMART_EDITOR_OPEN_BROWSER: '0',
  };
  if (!app.isPackaged && !smoke) env.SMART_EDITOR_LEGACY_DIR = root;
  if (smoke) delete env.SMART_EDITOR_LEGACY_DIR;
  note(`Starting editor ${app.getVersion()} (${process.platform}/${process.arch}), data=${dataDir}`);
  backend = spawn(executable, args, {
    cwd: app.isPackaged ? dataDir : root, env, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', data => { log.write(data); logWindow.appendChunk(data, 'stdout'); });
  backend.stderr.on('data', data => { log.write(data); logWindow.appendChunk(data, 'stderr'); });
  const child = backend;
  backend.on('error', error => { if (backend === child) backendFailed = true; note(error.stack); });
  backend.on('exit', (code, signal) => {
    if (backend !== child) return;
    backendFailed = true;
    logWindow.flushChunks();
    note(`Backend exit: ${code} ${signal || ''}`);
    if (!exiting && !backendStopping && mainWindow && isLocalURL(mainWindow.webContents.getURL(), origin)) {
      dialog.showMessageBox(mainWindow, { type: 'error', title: 'Düzenleme motoru kapandı', message: 'Çalışmanızın son kurtarma kaydı korunuyor.', detail: `Uygulamayı yeniden açın. Tanılama kaydı: ${logPath}` });
    }
  });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && !backendFailed) {
    try {
      const health = await backendRequest('/api/health', { timeout: 1000 });
      if (health.desktop === true) return health;
    } catch { /* The process may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Düzenleme motoru başlatılamadı. Ayrıntılar: ${logPath}`);
}
async function stopBackend() {
  if (!backend?.pid) return;
  backendStopping = true;
  const pid = backend.pid;
  if (process.platform === 'win32') {
    if (backend.exitCode !== null || backend.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      const timer = setTimeout(() => reject(new Error('Düzenleme motorunun kapanması doğrulanamadı.')), 8000);
      taskkill.once('error', error => { clearTimeout(timer); reject(error); });
      taskkill.once('exit', code => {
        clearTimeout(timer);
        if (code === 0 || backend.exitCode !== null || backend.signalCode !== null) resolve();
        else reject(new Error('Düzenleme motoru güvenli biçimde kapatılamadı.'));
      });
    });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 700));
    // Also stop any remaining synchronous FFmpeg/AI grandchildren in the group.
    try { process.kill(-pid, 'SIGKILL'); } catch { /* Already stopped. */ }
  }
}
async function requestClose(event) {
  if (allowClose || exiting) return;
  if (updateHandoff?.active) { event.preventDefault(); return; }
  if (!isLocalURL(mainWindow.webContents.getURL(), origin)) { allowClose = true; return; }
  event.preventDefault();
  if (closePending) return;
  if (activeNativeSaves > 0) {
    await dialog.showMessageBox(mainWindow, { type: 'info', message: 'Dosyanız kaydediliyor.', detail: 'Kayıt işlemi tamamlandıktan sonra uygulamayı kapatabilirsiniz.' });
    return;
  }
  closePending = true;
  const attempt = ++closeAttempt;
  let health;
  try { health = await backendRequest('/api/health'); } catch { /* Save recovery even after backend failure. */ }
  if (!closePending || attempt !== closeAttempt) return;
  if (health?.active_jobs > 0) {
    const { response } = await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['Düzenlemeye dön', 'İşlemi durdur ve kapat'], defaultId: 0, cancelId: 0, message: 'Render veya analiz hâlâ devam ediyor.', detail: 'Kapatırsanız işlem durur; projeniz kurtarma kaydında korunur.' });
    if (!closePending || attempt !== closeAttempt) return;
    if (response === 0) { closePending = false; return; }
  }
  mainWindow.webContents.send('desktop:before-close', attempt);
  setTimeout(async () => {
    if (allowClose || exiting || !closePending || attempt !== closeAttempt || mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['Bekle / düzenlemeye dön', 'Yine de kapat'], defaultId: 0, cancelId: 0, message: 'Son proje kaydı henüz doğrulanamadı.', detail: 'Yine de kapatırsanız son değişiklikler kaybolabilir.' });
    if (allowClose || exiting || !closePending || mainWindow.isDestroyed() || attempt !== closeAttempt) return;
    if (activeNativeSaves > 0) { cancelPendingClose(); return; }
    if (response === 1) { allowClose = true; mainWindow.close(); }
    else { closePending = false; mainWindow.webContents.send('desktop:close-cancelled', attempt); }
  }, 10000).unref();
}
async function importLegacy() {
  if (updateHandoff?.active) return;
  activeDesktopTasks++;
  try {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Eski Otomatik Edit klasörünü seçin (uploads ve projects içeren klasör)', properties: ['openDirectory'] });
  if (result.canceled) return;
  try {
    const imported = await backendRequest('/api/desktop/import-projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory: result.filePaths[0] }), timeout: 600000 });
    await dialog.showMessageBox(mainWindow, { type: 'info', message: 'Eski proje dosyaları içe aktarıldı.', detail: `Mevcut kayıtların üzerine yazılmadı. Proje aç menüsünden erişmek için uygulamayı yeniden açabilirsiniz.\n${JSON.stringify(imported)}` });
  } catch (error) { await dialog.showMessageBox(mainWindow, { type: 'error', message: 'İçe aktarma tamamlanamadı.', detail: error.message }); }
  } finally { activeDesktopTasks--; }
}

function initializeUpdates() {
  const mode = smoke || !app.isPackaged ? 'disabled' : process.platform === 'win32' ? 'automatic' : 'manual';
  const send = (name, value) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(name, value); };
  let updater;
  if (mode === 'automatic') {
    updater = require('electron-updater').autoUpdater;
    updater.setFeedURL({ provider: 'github', owner: 'davutcan123', repo: 'OtomatikEdit', private: false, releaseType: 'release' });
    updater.logger = { info: note, warn: note, error: note, debug: note };
    updateHandoff = new UpdateHandoff({
      busy: () => (allowClose || exiting || closePending || !mainWindow || mainWindow.isDestroyed()) ? 'Uygulama kapanıyor; güncelleme bir sonraki açılışta tekrar sunulacak.' : (activeNativeSaves || activeDesktopTasks || activeDownloads) ? 'Dosya kaydı veya içe aktarma bitince otomatik güncellenecek.' : '',
      prepareBackend: async () => {
        const response = await fetch(origin + '/api/desktop/prepare-update', { method: 'POST', headers: { 'X-Desktop-Token': token }, signal: AbortSignal.timeout(5000) });
        const body = await response.json();
        if (response.status === 409 && body.code === 'desktop_update_busy') return { update_ready: false };
        if (!response.ok || body.update_ready !== true) throw new Error('Güncelleme için motorun boşta olduğu doğrulanamadı.');
        return body;
      },
      cancelBackend: async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const result = await backendRequest('/api/desktop/cancel-update', { method: 'POST' });
            if (result.preparing === false) return;
          } catch (error) { note(`Cancel update gate: ${error.message}`); }
        }
        const error = new Error('Güncelleme kilidinin kaldırıldığı doğrulanamadı.');
        error.userMessage = 'Güncelleme durduruldu. Düzenleme motoruyla bağlantı doğrulanamadı; devam etmeden önce uygulamayı kapatıp yeniden açın. Son kurtarma kaydınız korunuyor.';
        throw error;
      },
      send,
      flushRecovery: () => recoveryQueue,
      stopBackend,
      launchInstaller: () => new Promise((resolve, reject) => {
        // NSIS launches before app.quit(): save and stop must already be done.
        const cleanup = () => { clearTimeout(timer); updater.removeListener('error', failed); nativeUpdater.removeListener('before-quit-for-update', launched); };
        const failed = error => { cleanup(); exiting = false; allowClose = false; reject(error); };
        const launched = () => { cleanup(); resolve(); };
        const timer = setTimeout(() => failed(new Error('Kurulum başlatılamadı.')), 5000);
        updater.once('error', failed);
        nativeUpdater.once('before-quit-for-update', launched);
        allowClose = true;
        exiting = true;
        try { updater.quitAndInstall(true, true); } catch (error) { failed(error); }
      }),
      recoverBackend: async () => {
        allowClose = false; exiting = false;
        // taskkill may have succeeded even if its exit/timeout was ambiguous.
        // Reuse a still-healthy engine; never start a second one against dataDir.
        try {
          const health = await backendRequest('/api/health');
          if (health.desktop) { backendStopping = false; return; }
        } catch { /* Check/stop our own child before replacing it. */ }
        await stopBackend();
        await startBackend();
        await mainWindow.loadURL(origin);
      },
    });
  }
  updates = new UpdateController({
    mode, currentVersion: app.getVersion(), updater, log: note,
    onState: state => send('desktop:update-state', state),
    prepareInstall: () => updateHandoff.prepare(),
    cancelInstall: () => updateHandoff?.active ? updateHandoff.cancel() : Promise.resolve(),
    install: () => updateHandoff.install(),
    checkManual: async () => {
      const response = await fetch('https://api.github.com/repos/davutcan123/OtomatikEdit/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Release check HTTP ${response.status}`);
      const release = await response.json();
      const version = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name || '')?.[1];
      if (!version || release.draft || release.prerelease) return null;
      const current = app.getVersion().split('.').map(Number), next = version.split('.').map(Number);
      const newer = next[0] > current[0] || (next[0] === current[0] && (next[1] > current[1] || (next[1] === current[1] && next[2] > current[2])));
      return newer && release.assets?.some(asset => asset.name === `OtomatikEdit-${version}-mac-${process.arch}.dmg`) ? { version } : null;
    },
  });
}
function installMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'Dosya', submenu: [
      { label: 'Eski projeleri içe aktar…', click: importLegacy },
      { label: 'Proje kayıt klasörünü aç', click: () => shell.openPath(dataDir) },
      { type: 'separator' }, { label: 'Kapat', accelerator: 'Alt+F4', click: () => mainWindow.close() },
    ] },
    { label: 'Düzenle', submenu: [{ role: 'cut', label: 'Kes' }, { role: 'copy', label: 'Kopyala' }, { role: 'paste', label: 'Yapıştır' }, { role: 'selectAll', label: 'Tümünü seç' }] },
    { label: 'Görünüm', submenu: [{ role: 'resetZoom', label: 'Normal boyut' }, { role: 'zoomIn', label: 'Arayüzü büyüt' }, { role: 'zoomOut', label: 'Arayüzü küçült' }, { role: 'togglefullscreen', label: 'Tam ekran' }] },
    { label: 'Yardım', submenu: [
      { label: 'Güncellemeleri kontrol et', click: () => updates?.check(true) },
      { label: 'Terminal ayrıntıları', click: () => logWindow.open().catch(error => note(error.message)) },
      { label: 'Tanılama kayıtlarını aç', click: () => shell.openPath(logDir) },
      { label: 'Hakkında', click: () => dialog.showMessageBox(mainWindow, { message: `Otomatik Edit ${app.getVersion()}`, detail: 'Video editörü · Yerel masaüstü sürümü\nKonuşma/çeviri modelleri ilk kullanımda internetten indirilir.' }) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
async function launch() {
  mainWindow = new BrowserWindow({
    width: 1500, height: 960, minWidth: 900, minHeight: 620,
    title: 'Otomatik Edit', backgroundColor: '#080d18', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, backgroundThrottling: false },
  });
  mainWindow.on('close', requestClose);
  mainWindow.on('closed', () => logWindow.close());
  initializeUpdates();
  mainWindow.webContents.on('console-message', details => {
    if (details.level === 'error' || details.level === 'warning') { note(`Renderer ${details.level}: ${details.message}`); if (smoke) console.error(details.message); }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!isLocalURL(url, origin)) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents === mainWindow.webContents && isLocalURL(contents.getURL(), origin) && permission === 'fullscreen'));
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => contents === mainWindow.webContents && isLocalURL(requestingOrigin, origin) && permission === 'fullscreen');
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (isLocalURL(details.url, origin)) details.requestHeaders['X-Desktop-Token'] = token;
    else for (const key of Object.keys(details.requestHeaders)) { if (key.toLowerCase() === 'x-desktop-token') delete details.requestHeaders[key]; }
    callback({ requestHeaders: details.requestHeaders });
  });
  session.defaultSession.on('will-download', (event, item) => {
    if (!isLocalURL(item.getURL(), origin)) { event.preventDefault(); return; }
    if (updateHandoff?.committed) { event.preventDefault(); return; }
    updateHandoff?.interrupt();
    activeDownloads++;
    item.setSaveDialogOptions({ title: 'Dışa aktarılan dosyayı kaydet', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
    item.once('done', (_event, state) => { activeDownloads--; if (state === 'interrupted') dialog.showMessageBox(mainWindow, { type: 'error', message: 'Dosya kaydedilemedi. Yeniden dışa aktarın veya farklı bir klasör seçin.' }); });
  });
  installMenu();
  await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html lang="tr"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body style="background:#080d18;color:#e2e8f0;font:20px system-ui;display:grid;place-content:center;height:90vh"><h2>Otomatik Edit</h2><p>Düzenleme motoru hazırlanıyor…</p></body></html>`));
  mainWindow.show();
  await prepareLibrary(dataDir, smoke ? null : stateDir);
  const health = await startBackend();
  await mainWindow.loadURL(origin);
  if (!smoke) {
    setTimeout(() => updates.check(), 10000).unref();
    updateTimer = setInterval(() => updates.check(), 4 * 60 * 60 * 1000);
    updateTimer.unref();
  }
  if (smoke) {
    try {
      const result = await require('./smoke.cjs').run({ mainWindow, origin, token, dataDir, health });
      console.log(JSON.stringify(result));
      note(JSON.stringify(result));
      mainWindow.close();
    } catch (error) {
      console.error(error); note(error.stack); process.exitCode = 1; allowClose = true; app.quit();
    }
  }
}
if (!app.requestSingleInstanceLock()) { exiting = true; app.quit(); }
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.on('activate', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (exiting) return;
    event.preventDefault();
    if (!allowClose && mainWindow && !mainWindow.isDestroyed()) { mainWindow.close(); return; }
    exiting = true;
    updates?.dispose();
    clearInterval(updateTimer);
    stopBackend().catch(error => note(error.message)).finally(() => { log.end(); app.exit(process.exitCode || 0); });
  });
  app.on('will-quit', () => { updates?.dispose(); clearInterval(updateTimer); log.end(); });
  app.whenReady().then(launch).catch(async error => {
    note(error.stack);
    if (!smoke) await dialog.showMessageBox({ type: 'error', title: 'Otomatik Edit açılamadı', message: error.message, detail: `Yardım için bu kayıt dosyasını paylaşabilirsiniz:\n${logPath}` });
    else console.error(error);
    process.exitCode = 1; allowClose = true; app.quit();
  });
}
