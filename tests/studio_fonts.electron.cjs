'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const token = 'studio-fonts-test';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fonts-'));
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

app.whenReady().then(async () => {
  const { processHandle, ready } = startBackend();
  const win = new BrowserWindow({ width: 1280, height: 820, show: false,
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
    const loaded = await evaluate(`(async () => {
      await window.StudioFonts.ready;
      const faces = await document.fonts.load('700 32px "studio-font-barlow"', 'İğşÖüç');
      return {families:el('text-font-family').options.length, face:faces[0]?.family,status:faces[0]?.status};
    })()`);
    assert.equal(loaded.families, 10);
    assert.match(loaded.face, /studio-font-barlow/);
    assert.equal(loaded.status, 'loaded');

    await evaluate(`{
      const base = emptyTimelineState();
      base.texts = [
        {...TEXT_STYLES.classic,id:'T1',text:'İğşÖüç',start:0,end:2,x:50,y:50},
        {...TEXT_STYLES.classic,id:'T2',text:'Çevrimdışı',kind:'subtitle',start:0,end:2,x:50,y:87},
      ];
      base.nextTextId = 3;
      restoreProject({name:'Font fixture',activeTimelineId:'TL1',timelines:[{id:'TL1',name:'Metin',state:base}]});
      S.timelineCursor = .5;
      selectText('T1',false);
    }`);
    const change = (id, value) => evaluate(`{
      const input = el(${JSON.stringify(id)});
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('change', {bubbles:true}));
    }`);
    await change('text-font-family', 'spacemono');
    await change('text-font-weight', '400');
    const textState = await evaluate(`(() => {
      const node = document.querySelector('[data-text-id="T1"] .preview-text-content');
      return [selectedText().fontFamily,selectedText().bold,getComputedStyle(node).fontFamily,getComputedStyle(node).fontWeight];
    })()`);
    assert.deepEqual(textState.slice(0, 2), ['spacemono', false]);
    assert.match(textState[2], /studio-font-spacemono/);
    assert.equal(textState[3], '400');

    await evaluate("selectText('T2',false)");
    await change('subtitle-selected-font-family', 'instrumentserif');
    assert.equal(await evaluate("el('subtitle-selected-font-weight').disabled"), true);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-text-id=T2] .preview-text-content')).fontWeight"), '400');
    await change('subtitle-selected-style', 'pop');
    assert.equal(await evaluate('selectedText().fontFamily'), 'instrumentserif');
    await evaluate("S.trackState.subtitle.locked=true;drawClips()");
    await change('subtitle-selected-font-family', 'barlow');
    assert.equal(await evaluate('selectedText().fontFamily'), 'instrumentserif');
    await evaluate("S.trackState.subtitle.locked=false;selectText('T1',false)");
    const duplicate = await evaluate(`(() => {
      timelineCopySelection();
      S.timelineCursor = 1;
      timelinePasteClipboard();
      const payload=JSON.parse(JSON.stringify(projectPayload()));
      restoreProject(payload);
      return S.texts.filter(item=>item.kind!=='subtitle').map(item=>[item.fontFamily,item.bold]);
    })()`);
    assert.deepEqual(duplicate, [['spacemono', false], ['spacemono', false]]);

    const hasStudio = await evaluate("!!window.StudioWorkspace && !!el('studio-fonts')");
    if (hasStudio) {
      await evaluate("window.StudioWorkspace.openSection('fonts')");
      await evaluate('window.StudioPreferences.ready');
      assert.equal(await evaluate("document.querySelectorAll('[data-font]').length"), 9);
      await evaluate(`{
        const query = el('studio-font-search');
        query.value = 'IBM';
        query.dispatchEvent(new Event('input'));
      }`);
      assert.equal(await evaluate("document.querySelectorAll('[data-font]').length"), 1);
      assert.equal(await evaluate("document.querySelector('[data-font]').dataset.font"), 'ibmplexmono');
      await evaluate(`{
        const field = el('studio-font-sample-input');
        field.value = 'Şaşırtıcı ölçüler';
        field.dispatchEvent(new Event('input'));
        document.querySelector('[data-font-favorite="ibmplexmono"]').click();
      }`);
      assert.equal(await evaluate("document.querySelector('.studio-font-sample').textContent"), 'Şaşırtıcı ölçüler');
      for (let attempt = 0; attempt < 30 && !await evaluate("window.StudioPreferences.get('favorites',[]).includes('font:ibmplexmono')"); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.ok(await evaluate("window.StudioPreferences.get('favorites',[]).includes('font:ibmplexmono')"));
    }
    console.log('Bundled fonts load in offline Chromium and persist for text/subtitle editing.');
  } finally {
    win.webContents.session.webRequest.onBeforeSendHeaders(null);
    win.destroy();
    const closed = new Promise(resolve => processHandle.once('close', resolve));
    processHandle.kill();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
