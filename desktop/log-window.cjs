'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { StringDecoder } = require('node:string_decoder');

const MAX_ENTRIES = 1500, MAX_BYTES = 1024 * 1024, MAX_MESSAGE = 12000;
const clean = value => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

class LogWindow {
  constructor({ BrowserWindow, ipcMain, clipboard, parent, trustedEditor }) {
    this.BrowserWindow = BrowserWindow; this.clipboard = clipboard; this.parent = parent;
    this.entries = []; this.bytes = 0; this.nextId = 1; this.window = null; this.timer = null;
    this.streams = new Map(); this.file = path.join(__dirname, 'log-viewer.html');
    ipcMain.on('desktop:append-log', (event, entry) => { if (trustedEditor(event)) this.appendEditor(entry); });
    ipcMain.handle('desktop:open-logs', event => {
      if (!trustedEditor(event)) throw new Error('Yetkisiz günlük isteği.');
      return this.open();
    });
    ipcMain.handle('desktop:read-logs', (event, afterId) => {
      this.requireViewer(event);
      return this.snapshot(afterId);
    });
    ipcMain.handle('desktop:copy-logs', (event, text) => {
      this.requireViewer(event);
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 2 * MAX_BYTES) throw new Error('Kopyalanacak günlük çok büyük.');
      this.clipboard.writeText(text);
      return true;
    });
  }
  appendEditor(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.message !== 'string') return;
    this.append({ source: entry.source === 'auto' ? 'auto' : 'manual', level: entry.level, message: entry.message });
  }
  append({ source = 'app', level = 'info', message }) {
    if (typeof message !== 'string' || !message.trim()) return;
    const text = clean(message).slice(0, MAX_MESSAGE);
    const entry = { id: this.nextId++, time: new Date().toISOString(), source,
      level: ['error', 'warn', 'success'].includes(level) ? level : 'info', message: text };
    entry.bytes = Buffer.byteLength(text, 'utf8');
    this.entries.push(entry); this.bytes += entry.bytes;
    while (this.entries.length > MAX_ENTRIES || this.bytes > MAX_BYTES) this.bytes -= this.entries.shift().bytes;
    if (this.window && !this.window.isDestroyed() && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.window && !this.window.isDestroyed()) this.window.webContents.send('desktop:logs-changed');
      }, 120);
      this.timer.unref?.();
    }
  }
  appendChunk(chunk, source = 'backend') {
    let stream = this.streams.get(source);
    if (!stream) { stream = { decoder: new StringDecoder('utf8'), tail: '' }; this.streams.set(source, stream); }
    stream.tail += stream.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const lines = stream.tail.split(/\r\n|[\r\n]/); stream.tail = lines.pop();
    for (const line of lines) this.append({ source: 'backend', level: /\b(error|failed|exception)\b/i.test(line) ? 'error' : 'info', message: line });
    while (stream.tail.length >= MAX_MESSAGE) {
      this.append({ source: 'backend', message: stream.tail.slice(0, MAX_MESSAGE) });
      stream.tail = stream.tail.slice(MAX_MESSAGE);
    }
  }
  flushChunks() {
    for (const stream of this.streams.values()) {
      const tail = stream.tail + stream.decoder.end();
      if (tail) this.append({ source: 'backend', message: tail });
    }
    this.streams.clear();
  }
  snapshot(afterId = 0) {
    const after = Number.isSafeInteger(afterId) && afterId >= 0 ? afterId : 0;
    return { firstId: this.entries[0]?.id || this.nextId, lastId: this.nextId - 1, limit: MAX_ENTRIES,
      entries: this.entries.filter(entry => entry.id > after).map(({ bytes, ...entry }) => ({ ...entry })) };
  }
  requireViewer(event) {
    const contents = this.window && !this.window.isDestroyed() ? this.window.webContents : null;
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame ||
        event.senderFrame.url !== pathToFileURL(this.file).href) throw new Error('Yetkisiz günlük penceresi.');
  }
  async open() {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show(); this.window.focus(); return { opened: true };
    }
    const window = new this.BrowserWindow({ width: 1040, height: 700, minWidth: 640, minHeight: 420,
      title: 'Terminal · Otomatik Edit', backgroundColor: '#080d18', show: false, parent: this.parent(),
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'log-preload.cjs'), nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false } });
    this.window = window;
    window.setMenu?.(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.on('closed', () => { if (this.window === window) this.window = null; clearTimeout(this.timer); this.timer = null; });
    try {
      await window.loadFile(this.file);
      if (!window.isDestroyed()) { window.show(); window.focus(); }
    } catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
    return { opened: true };
  }
  close() {
    clearTimeout(this.timer); this.timer = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
module.exports = { LogWindow, MAX_ENTRIES, MAX_BYTES, MAX_MESSAGE };
