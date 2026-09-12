'use strict';

// Platform-independent state machine. Feed selection, IPC trust and shutdown
// belong to the main process; a renderer can never supply an installer or URL.
class UpdateController {
  constructor({ mode, currentVersion, updater, checkManual, prepareInstall, cancelInstall = async () => {}, install, onState = () => {}, log = () => {}, retryDelay = 10000 }) {
    Object.assign(this, { updater, checkManual, prepareInstall, cancelInstall, install, onState, log, retryDelay });
    this.state = { mode, currentVersion, status: 'idle', version: '', percent: 0, message: '', manualCheck: false };
    this.listeners = [];
    this.disposed = false;
    this.consent = false;
    this.downloaded = false;
    if (mode !== 'automatic') return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.disableDifferentialDownload = true;
    const listen = (name, callback) => { updater.on(name, callback); this.listeners.push([name, callback]); };
    listen('update-available', info => this.set({ status: 'available', version: info.version, percent: 0, message: 'Yeni sürüm hazır. İndirme bitince projeniz kaydedilip uygulama yeniden açılacak.' }));
    listen('update-not-available', () => this.set({ status: 'current', message: 'En güncel sürümü kullanıyorsunuz.' }));
    listen('download-progress', progress => this.set({ status: 'downloading', percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)) }));
    listen('update-downloaded', info => {
      // executeDownload emits before post-download bookkeeping (which may
      // still fail). Never freeze the editor until the whole promise succeeds.
      this.pendingDownloadedInfo = info;
    });
    listen('error', error => this.fail(error));
  }
  getState() { return { ...this.state }; }
  set(values) {
    if (this.disposed) return this.getState();
    Object.assign(this.state, values);
    this.onState(this.getState());
    return this.getState();
  }
  fail(error) {
    clearTimeout(this.retryTimer);
    this.consent = false;
    this.log(`Update error: ${error?.stack || error}`);
    return this.set({ status: 'error', message: error?.userMessage || 'Güncelleme tamamlanamadı. Çalışmanız korunuyor; bağlantıyı ve boş disk alanını kontrol edip tekrar deneyin.' });
  }
  async check(manual = false) {
    if (this.disposed) return this.getState();
    if (this.checking || this.downloading || this.installing || this.downloaded) return this.set({ manualCheck: manual || this.state.manualCheck });
    if (this.state.mode === 'disabled') return this.set({ status: 'current', manualCheck: manual, message: 'Otomatik güncelleme kurulu masaüstü sürümünde kullanılabilir.' });
    this.set({ status: 'checking', manualCheck: manual, message: 'Yeni sürüm kontrol ediliyor…' });
    this.checking = (async () => {
      try {
        if (this.state.mode === 'automatic') await this.updater.checkForUpdates();
        else {
          const info = await this.checkManual();
          this.set(info ? { status: 'available', version: info.version, message: 'Mac sürümünü indirip normal şekilde kurun. Kayıtlı projeleriniz korunur.' } : { status: 'current', message: 'En güncel sürümü kullanıyorsunuz.' });
        }
      } catch (error) { this.fail(error); }
    })();
    try { await this.checking; } finally { this.checking = null; }
    return this.getState();
  }
  async download() {
    if (this.disposed || this.state.mode !== 'automatic' || this.installing || this.downloading || this.checking) return this.getState();
    if (this.downloaded) {
      this.consent = true;
      await this.tryInstall();
      return this.getState();
    }
    if (!this.state.version) { await this.check(true); if (this.state.status !== 'available') return this.getState(); }
    this.consent = true;
    this.pendingDownloadedInfo = null;
    this.set({ status: 'downloading', percent: 0, message: 'Yeni sürüm indiriliyor. Bu sırada düzenlemeye devam edebilirsiniz.' });
    this.downloading = (async () => {
      try {
        await this.updater.downloadUpdate();
        if (!this.pendingDownloadedInfo || !this.consent || this.disposed) return;
        this.downloaded = true;
        this.set({ status: 'downloaded', version: this.pendingDownloadedInfo.version, percent: 100, message: 'İndirme doğrulandı. Güvenli yeniden başlatma hazırlanıyor…' });
      } catch (error) { this.fail(error); }
    })();
    try { await this.downloading; } finally { this.downloading = null; }
    if (this.downloaded) await this.tryInstall();
    return this.getState();
  }
  async tryInstall() {
    if (this.disposed || !this.downloaded || !this.consent || this.installing) return;
    clearTimeout(this.retryTimer);
    this.installing = true;
    try {
      const result = await this.prepareInstall();
      if (this.disposed || !this.consent) { await this.cancelInstall(); return; }
      if (!result?.ready) {
        this.set({ status: 'waiting', message: result?.message || 'Devam eden işlem bitince güncelleme otomatik kurulacak.' });
        this.retryTimer = setTimeout(() => this.tryInstall(), this.retryDelay);
        this.retryTimer.unref?.();
        return;
      }
      this.set({ status: 'installing', message: 'Projeniz kaydedildi. Güncelleme kurulup uygulama yeniden açılacak…' });
      await this.install();
    } catch (error) { this.fail(error); }
    finally { this.installing = false; }
  }
  dispose() {
    this.disposed = true;
    this.consent = false;
    clearTimeout(this.retryTimer);
    for (const [name, callback] of this.listeners) this.updater.removeListener(name, callback);
  }
}

module.exports = { UpdateController };
