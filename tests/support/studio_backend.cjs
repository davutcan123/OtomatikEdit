'use strict';

const { app, } = require('electron');
const { createNativeTestWindow } = require('./native_test_window.cjs');
app.on('window-all-closed', () => {});
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const token = 'studio-backend-test';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-browser-'));
const winPython = path.join(root, '.venv-windows', 'Scripts', 'python.exe');
const localPython = path.join(root, 'venv', 'bin', 'python');
const python = process.env.SMART_EDITOR_PYTHON || (process.platform === 'win32'
  ? fs.existsSync(winPython) ? winPython : 'python'
  : fs.existsSync(localPython) ? localPython : 'python3');

function startBackend() {
  const processHandle = spawn(python, ['app.py'], {
    cwd: root,
    env: { ...process.env, SMART_EDITOR_DESKTOP: '1', SMART_EDITOR_DESKTOP_TOKEN: token,
      SMART_EDITOR_DATA_DIR: temporary, SMART_EDITOR_LEGACY_DIR: '', SMART_EDITOR_PORT: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Backend did not start: ' + diagnostics)), 15000);
    processHandle.stderr.on('data', buffer => {
      diagnostics = (diagnostics + buffer).slice(-7000);
      const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(diagnostics)?.[0];
      if (origin) {
        clearTimeout(timeout);
        resolve(origin);
      }
    });
    processHandle.once('error', error => { clearTimeout(timeout); reject(error); });
    processHandle.once('exit', code => { clearTimeout(timeout); reject(new Error('Backend exited ' + code + ': ' + diagnostics)); });
  });
  return { processHandle, ready };
}

async function withStudioBrowser(work) {
  const { processHandle, ready } = startBackend();
  const win = createNativeTestWindow({ width: 1280, height: 820, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    const origin = await ready;
    const filter = { urls: ['<all_urls>'] };
    win.webContents.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      if (!details.url.startsWith(origin + '/')) return callback({ cancel: true });
      details.requestHeaders['X-Desktop-Token'] = token;
      callback({ requestHeaders: details.requestHeaders });
    });
    await win.loadURL(origin);
    const evaluate = code => win.webContents.executeJavaScript(code);
    await work({ evaluate, win, origin, temporary, root });
  } finally {
    win.webContents.session.webRequest.onBeforeSendHeaders(null);
    win.destroy();
    const closed = new Promise(resolve => processHandle.once('close', resolve));
    processHandle.kill();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

module.exports = { withStudioBrowser };
