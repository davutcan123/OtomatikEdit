'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { LogWindow, MAX_BYTES, MAX_ENTRIES, MAX_MESSAGE } = require('./log-window.cjs');

function harness() {
  const handlers = new Map(), editor = {}, windows = [], copied = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' };
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.webContents.send = (...args) => { this.sent = args; };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const log = new LogWindow({ BrowserWindow: Window, ipcMain: {
    on: (name, handler) => handlers.set(name, handler), handle: (name, handler) => handlers.set(name, handler),
  }, clipboard: { writeText: text => copied.push(text) }, parent: () => editor, trustedEditor: event => event === editor });
  const viewer = () => ({ sender: log.window.webContents, senderFrame: log.window.webContents.mainFrame });
  return { log, handlers, editor, viewer, windows, copied };
}
test('only the trusted editor can append messages or open the log window', async () => {
  const h = harness();
  h.handlers.get('desktop:append-log')({}, { message: 'foreign' });
  assert.equal(h.log.snapshot().entries.length, 0);
  assert.throws(() => h.handlers.get('desktop:open-logs')({}));
  h.handlers.get('desktop:append-log')(h.editor, { message: 'Renderer ready', source: 'manual' });
  await h.handlers.get('desktop:open-logs')(h.editor);
  assert.equal(h.log.snapshot().entries[0].message, 'Renderer ready'); h.log.close();
});
test('log window is sandboxed, reused, and cannot navigate or expose editor IPC', async () => {
  const h = harness(); await h.log.open(); await h.log.open();
  assert.equal(h.windows.length, 1);
  assert.deepEqual(h.windows[0].openHandler(), { action: 'deny' });
  assert.equal(h.windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(h.windows[0].options.webPreferences.contextIsolation, true);
  assert.equal(h.windows[0].options.webPreferences.sandbox, true);
  assert.match(h.windows[0].options.webPreferences.preload, /log-preload\.cjs$/);
  let prevented = false; h.windows[0].webContents.emit('will-navigate', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  h.log.close(); assert.equal(h.windows[0].isDestroyed(), true);
  await h.log.open(); assert.equal(h.windows.length, 2); h.log.close();
});
test('read and clipboard IPC require the exact viewer main frame and local file URL', async () => {
  const h = harness(); await h.log.open();
  h.log.append({ message: '<img src=x onerror=alert(1)>' });
  const read = h.handlers.get('desktop:read-logs'), copy = h.handlers.get('desktop:copy-logs');
  assert.throws(() => read(h.editor)); assert.throws(() => read({ sender: h.log.window.webContents, senderFrame: {} }));
  const event = h.viewer(), url = event.senderFrame.url;
  event.senderFrame.url = 'https://evil.invalid/'; assert.throws(() => read(event)); event.senderFrame.url = url;
  assert.equal(read(event).entries[0].message, '<img src=x onerror=alert(1)>');
  assert.throws(() => copy(event, {})); assert.throws(() => copy(event, 'x'.repeat(MAX_BYTES * 2 + 1)));
  assert.equal(copy(event, 'local user-selected text'), true);
  assert.deepEqual(h.copied, ['local user-selected text']); h.log.close();
});
test('log history and individual IPC entries stay bounded and returned data are copies', () => {
  const h = harness();
  for (let i = 0; i < MAX_ENTRIES + 100; i++) h.log.append({ message: 'x'.repeat(2000) });
  assert.ok(h.log.entries.length <= MAX_ENTRIES); assert.ok(h.log.bytes <= MAX_BYTES);
  h.log.appendEditor({ message: 'z'.repeat(MAX_MESSAGE * 2), source: 'injected', level: 'injected' });
  const last = h.log.snapshot().entries.at(-1);
  assert.equal(last.message.length, MAX_MESSAGE); assert.equal(last.source, 'manual'); assert.equal(last.level, 'info');
  last.message = 'modified'; assert.notEqual(h.log.snapshot().entries.at(-1).message, 'modified');
  assert.equal(h.log.snapshot(h.log.nextId - 1).entries.length, 0);
});
test('backend UTF-8 chunks and final partial lines survive without ANSI controls', () => {
  const h = harness(), bytes = Buffer.from('İşlem\n');
  h.log.appendChunk(bytes.subarray(0, 1)); h.log.appendChunk(bytes.subarray(1));
  h.log.appendChunk(Buffer.from('\x1b[31mError failed\x1b[0m\rfinished'));
  h.log.flushChunks();
  const entries = h.log.snapshot().entries;
  assert.deepEqual(entries.map(entry => entry.message), ['İşlem', 'Error failed', 'finished']);
  assert.equal(entries[1].level, 'error');
});
