'use strict';

class UpdateBusy extends Error {}

// Do not start NSIS until both processes agree that work is idle and the
// renderer's newest recovery snapshot has reached durable storage.
class UpdateHandoff {
  constructor({ busy, prepareBackend, cancelBackend, send, flushRecovery, stopBackend, launchInstaller, recoverBackend, timeout = 30000 }) {
    Object.assign(this, { busy, prepareBackend, cancelBackend, send, flushRecovery, stopBackend, launchInstaller, recoverBackend, timeout });
    this.active = false;
    this.committed = false;
    this.attempt = 0;
  }
  acknowledge(attempt, error, busy = false) {
    if (!this.active || attempt !== this.attempt || !this.pending) return;
    if (error) this.pending.reject(busy ? new UpdateBusy(String(error)) : new Error(String(error)));
    else this.pending.resolve();
  }
  interrupt(message = 'Dosya işlemi bitince güncellenecek.') {
    if (!this.active || this.committed) return;
    this.invalidated = true;
    this.pending?.reject(new UpdateBusy(message));
  }
  assertIdle() {
    const reason = this.busy();
    if (this.invalidated || reason) throw new UpdateBusy(reason || 'İşlem tamamlandığında güncelleme yeniden denenecek.');
  }
  async cancel() {
    const attempt = this.attempt;
    try { await this.cancelBackend(); }
    finally {
      clearTimeout(this.timer);
      this.pending = null;
      this.active = false;
      this.committed = false;
      this.send('desktop:update-cancelled', attempt);
    }
  }
  async prepare() {
    const reason = this.busy();
    if (this.active || reason) return { ready: false, message: reason || 'Güncelleme zaten hazırlanıyor.' };
    this.active = true;
    this.invalidated = false;
    const attempt = ++this.attempt;
    let ready = false;
    try {
      const gate = await this.prepareBackend();
      if (!gate.update_ready) throw new UpdateBusy('Render, analiz veya dosya işlemi bitince otomatik güncellenecek.');
      this.assertIdle();
      await new Promise((resolve, reject) => {
        this.pending = { resolve, reject };
        this.timer = setTimeout(() => reject(new Error('Proje kurtarma kaydı doğrulanamadı.')), this.timeout);
        this.timer.unref?.();
        this.send('desktop:prepare-update', attempt);
      });
      clearTimeout(this.timer);
      this.pending = null;
      await this.flushRecovery();
      this.assertIdle();
      ready = true;
      return { ready: true };
    } catch (error) {
      if (error instanceof UpdateBusy) return { ready: false, message: error.message };
      throw error;
    } finally {
      if (!ready) await this.cancel();
    }
  }
  async install() {
    if (!this.active) throw new Error('Güncelleme hazırlığı tamamlanmadı.');
    let stopAttempted = false;
    try {
      this.assertIdle();
      this.committed = true;
      stopAttempted = true;
      await this.stopBackend();
      await this.launchInstaller();
    } catch (error) {
      try { if (stopAttempted) await this.recoverBackend(); }
      finally { await this.cancel(); }
      throw error;
    }
  }
}

module.exports = { UpdateHandoff };
