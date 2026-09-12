'use strict';
// Explicit --smoke-test only; main creates an isolated temporary project folder.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { app, ipcMain } = require('electron');
const { waitForMedia } = require('./media-ready.cjs');

exports.run = async ({ mainWindow, origin, token, dataDir, health }) => {
  const errors = [];
  mainWindow.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message);
  });
  const headers = { 'X-Desktop-Token': token };
  const request = (route, options = {}) => fetch(origin + route, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(120000) });
  const waitForVideo = async () => {
    try {
      await mainWindow.webContents.executeJavaScript(`(${waitForMedia.toString()})(document.getElementById('manual-video'))`);
    } catch (error) {
      const state = await mainWindow.webContents.executeJavaScript(`(()=>{const v=document.getElementById('manual-video');return{readyState:v.readyState,networkState:v.networkState,seeking:v.seeking,time:v.currentTime,duration:v.duration,error:v.error?.message,src:v.currentSrc,preview:S.preview,selected:S.selected,outputTime:currentOutputTime()}})()`);
      throw new Error(error.message + ': ' + JSON.stringify(state));
    }
  };
  assert.equal(health.desktop, true);
  assert.equal((await fetch(origin + '/api/health')).status, 403);
  const css = await request('/static/editor.css');
  assert.equal(css.status, 200);
  assert.ok((await css.text()).length > 5000);
  await mainWindow.webContents.executeJavaScript('projectWorkspaceInitialization');
  const ui = await mainWindow.webContents.executeJavaScript(`({title:document.title,desktop:window.desktopApp.isDesktop,node:typeof require,ready:projectWorkspaceReady,bg:getComputedStyle(document.body).backgroundColor})`);
  assert.equal(ui.desktop, true); assert.equal(ui.node, 'undefined'); assert.equal(ui.ready, true);
  const storage = await mainWindow.webContents.executeJavaScript('window.desktopApp.getStorageInfo()');
  assert.equal(storage.path, dataDir);
  assert.ok((await fs.stat(storage.projectsPath)).isDirectory());
  const ffmpeg = app.isPackaged ? path.join(process.resourcesPath, 'backend', '_internal', 'tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : (process.env.SMART_EDITOR_FFMPEG || 'ffmpeg');
  const fixture = path.join(dataDir, 'test-input.mp4');
  await execFile(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture], { timeout: 60000 });
  const upload = new FormData();
  upload.set('file', new Blob([await fs.readFile(fixture)], { type: 'video/mp4' }), 'Masaüstü deneme.mp4');
  const uploadResponse = await request('/upload', { method: 'POST', body: upload });
  assert.equal(uploadResponse.status, 200);
  const media = await uploadResponse.json();
  assert.ok(media.duration >= 1.9);
  const payload = { name: 'Masaüstü test projesi', activeTimelineId: 'TL1', mediaAssets: [{ id: 'A1', fileId: media.file_id, name: media.name, kind: 'video', duration: media.duration }], timelines: [{ id: 'TL1', name: 'Ana video', state: { manualId: media.file_id, manualName: media.name, duration: media.duration, selected: 0, preview: 0, clips: [{ id: 'K1', fileId: media.file_id, name: media.name, start: 0, end: 2, timelineStart: 0 }], canvas: { width: 1920, height: 1080 } } }] };
  await mainWindow.webContents.executeJavaScript(`restoreProject(${JSON.stringify(payload)});persistProjectRecovery()`);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'recovery.json'), 'utf8')).name, payload.name);
  const saved = await (await request('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
  assert.ok(saved.id);
  assert.equal((await (await request('/projects/' + saved.id)).json()).name, payload.name);
  await waitForVideo();
  const played = await mainWindow.webContents.executeJavaScript(`(async()=>{const v=document.getElementById('manual-video');v.muted=true;await v.play();await new Promise(r=>setTimeout(r,350));v.pause();return{time:v.currentTime,width:v.videoWidth,height:v.videoHeight}})()`, true);
  assert.ok(played.width === 640 && played.time > 0);
  const form = new FormData();
  for (const [key, value] of Object.entries({ file_id: media.file_id, fmt: 'mp4', fps: '30', quality: 'standard', width: '640', height: '360', segments: JSON.stringify([{ start: 0, end: 1.5 }]) })) form.set(key, value);
  const renderResponse = await request('/start-render', { method: 'POST', body: form });
  assert.equal(renderResponse.status, 200);
  const job = await renderResponse.json();
  const eventText = await (await request('/stream-events/' + job.job_id)).text();
  const events = eventText.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const result = events.find(item => item.type === 'result' && item.download_url);
  assert.ok(result, JSON.stringify(events.slice(-8)));
  const output = await request(result.download_url);
  assert.equal(output.status, 200);
  assert.match(output.headers.get('content-type'), /video\/mp4/);
  const renderPath = path.join(dataDir, 'test-render.mp4');
  await fs.writeFile(renderPath, Buffer.from(await output.arrayBuffer()));
  await execFile(ffmpeg, ['-v', 'error', '-i', renderPath, '-f', 'null', '-'], { timeout: 30000 });
  const nativeSaved = path.join(dataDir, 'native-download.mp4');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native download timed out')), 15000);
    mainWindow.webContents.session.once('will-download', (_event, item) => {
      // Bypass only the human save prompt in this isolated automated test.
      item.setSavePath(nativeSaved);
      item.once('done', (_doneEvent, state) => { clearTimeout(timeout); state === 'completed' ? resolve() : reject(new Error('Native download: ' + state)); });
    });
    mainWindow.webContents.downloadURL(origin + result.download_url);
  });
  assert.equal((await fs.stat(nativeSaved)).size, (await fs.stat(renderPath)).size);
  const nativeSaveResult = await mainWindow.webContents.executeJavaScript(`window.desktopApp.saveOutput(${JSON.stringify(result.download_url)})`);
  assert.equal(nativeSaveResult.saved, true);
  assert.equal((await fs.stat(nativeSaveResult.path)).size, (await fs.stat(renderPath)).size);
  await mainWindow.webContents.executeJavaScript(`saveCompletedOutput(${JSON.stringify(result.download_url)},'manual-download','manual-log')`);
  assert.equal(await mainWindow.webContents.executeJavaScript('document.getElementById("manual-download-top").classList.contains("hidden")'), true);
  // Verify recovery works without relying on the temporary browser origin's storage.
  await mainWindow.webContents.executeJavaScript('localStorage.clear()');
  const loaded = new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
  mainWindow.webContents.reload();
  await loaded;
  await mainWindow.webContents.executeJavaScript('projectWorkspaceInitialization');
  assert.equal(await mainWindow.webContents.executeJavaScript('document.getElementById("project-name").value'), payload.name);
  await waitForVideo();
  const recoveredVideo = await mainWindow.webContents.executeJavaScript(`(async()=>{const v=document.getElementById('manual-video');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return{width:v.videoWidth,duration:v.duration,clips:S.clips.length,readyState:v.readyState,networkState:v.networkState,seeking:v.seeking,editorSeeking:S.seeking,paused:v.paused}})()`);
  assert.equal(recoveredVideo.width, 640); assert.equal(recoveredVideo.clips, 1);
  assert.ok(recoveredVideo.duration >= 1.9);
  assert.equal(await mainWindow.webContents.executeJavaScript('getComputedStyle(document.querySelector(".brush-stage-toolbar")).display'), 'none');
  const layouts = [];
  for (const [width, height] of [[1366, 740], [1920, 1020]]) {
    mainWindow.setContentSize(width, height);
    await mainWindow.webContents.executeJavaScript('new Promise(r=>setTimeout(r,180))');
    const layout = await mainWindow.webContents.executeJavaScript(`(()=>{const bounds=id=>{const r=document.getElementById(id).getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};return{width:innerWidth,height:innerHeight,pageHeight:document.documentElement.scrollHeight,pageWidth:document.documentElement.scrollWidth,preview:bounds('preview-shell'),stage:bounds('preview-stage'),timeline:bounds('timeline'),timelinePanel:bounds('timeline-panel')}})()`);
    assert.ok(layout.pageHeight <= height + 2, JSON.stringify(layout));
    assert.ok(layout.pageWidth <= width + 2, JSON.stringify(layout));
    assert.ok(layout.preview.height >= 219 && layout.timeline.height >= 199, JSON.stringify(layout));
    assert.ok(layout.timeline.bottom <= height && layout.preview.bottom <= layout.timelinePanel.top, JSON.stringify(layout));
    assert.ok(Math.abs(layout.stage.width / layout.stage.height - 16 / 9) < .01, JSON.stringify(layout));
    layouts.push(layout);
    await fs.writeFile(path.join(dataDir, `workspace-${width}.png`), (await mainWindow.webContents.capturePage()).toPNG());
  }
  // Reproduce a real timeline click after an input had keyboard focus, then B.
  await mainWindow.webContents.executeJavaScript('S.zoom=80;drawClips();document.getElementById("project-name").focus()');
  const clipPoint = await mainWindow.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#track .clip').getBoundingClientRect();return{x:Math.round(r.left+76),y:Math.round(r.top+r.height/2)}})()`);
  mainWindow.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...clipPoint });
  mainWindow.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...clipPoint });
  await mainWindow.webContents.executeJavaScript('new Promise(r=>setTimeout(r,100))');
  assert.equal(await mainWindow.webContents.executeJavaScript('document.activeElement.id'), 'timeline');
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B' });
  await mainWindow.webContents.executeJavaScript('new Promise(r=>setTimeout(r,100))');
  const split = await mainWindow.webContents.executeJavaScript('S.clips.map(c=>({start:c.start,end:c.end}))');
  assert.equal(split.length, 2, JSON.stringify(split));
  assert.ok(split[0].end > .6 && split[0].end < 1.3, JSON.stringify(split));
  const beforeSnapshots = new Set(await fs.readdir(path.join(dataDir, 'outputs')));
  await mainWindow.webContents.executeJavaScript(`seekOutputTime(.6);openSnapshotModal();document.getElementById('snapshot-quality').value='1280';updateSnapshotSize();startSnapshot()`);
  const captures = (await fs.readdir(path.join(dataDir, 'outputs'))).filter(name => name.endsWith('.png') && !beforeSnapshots.has(name));
  assert.equal(captures.length, 1, await mainWindow.webContents.executeJavaScript('document.getElementById("manual-log").textContent'));
  const capture = await fs.readFile(path.join(dataDir, 'outputs', captures[0]));
  assert.equal(capture.subarray(1, 4).toString(), 'PNG');
  assert.equal(capture.readUInt32BE(16), 1280); assert.equal(capture.readUInt32BE(20), 720);
  assert.ok((await fs.stat(path.join(dataDir, 'saved-' + captures[0]))).isFile());
  const screenshot = path.join(dataDir, 'desktop-smoke.png');
  await fs.writeFile(screenshot, (await mainWindow.webContents.capturePage()).toPNG());
  // Exercise the real isolated preload and update save handshake, never the installer/network.
  const updaterState = await mainWindow.webContents.executeJavaScript('window.desktopApp.getUpdateState()');
  assert.equal(updaterState.mode, 'disabled');
  const updateAvailable = { mode: 'automatic', status: 'available', currentVersion: health.version, version: '9.9.9', manualCheck: true };
  mainWindow.webContents.send('desktop:update-state', updateAvailable);
  const updatePopup = await mainWindow.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({open:el('desktop-update-dialog').open,title:el('desktop-update-heading').textContent,action:el('desktop-update-primary').textContent,consent:el('desktop-update-message').textContent}))))`);
  assert.equal(updatePopup.open, true);assert.equal(updatePopup.action, 'İndir ve güncelle');assert.match(updatePopup.consent, /yeniden açılır/);
  const updateScreenshot = path.join(dataDir, 'desktop-update-popup.png');
  await fs.writeFile(updateScreenshot, (await mainWindow.webContents.capturePage()).toPNG());
  await mainWindow.webContents.executeJavaScript("el('desktop-update-later').click()");
  const attempt = 9000001;
  const updateReady = await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout);ipcMain.removeListener('desktop:ready-for-update', received); };
    const received = (event, returnedAttempt, error, busy) => {
      if (event.sender !== mainWindow.webContents || returnedAttempt !== attempt) return;
      cleanup();resolve({ attempt: returnedAttempt, error, busy });
    };
    const timeout = setTimeout(() => { cleanup();reject(new Error('Update recovery handshake timed out')); }, 15000);
    ipcMain.on('desktop:ready-for-update', received);
    mainWindow.webContents.send('desktop:prepare-update', attempt);
  });
  assert.equal(updateReady.error, undefined);assert.equal(updateReady.busy, false);
  const frozenUpdate = await mainWindow.webContents.executeJavaScript(`({frozen:desktopUpdateFrozen,modal:el('desktop-update-dialog').open,inert:document.querySelector('main').inert,paused:mv.paused})`);
  assert.deepEqual(frozenUpdate, { frozen: true, modal: true, inert: true, paused: true });
  const updateRecovery = JSON.parse(await fs.readFile(path.join(dataDir, 'recovery.json'), 'utf8'));
  assert.equal(updateRecovery.name, payload.name);assert.equal(updateRecovery.timelines[0].state.clips.length, 2);
  mainWindow.webContents.send('desktop:update-cancelled', attempt);
  const updateCancelled = await mainWindow.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>resolve({frozen:desktopUpdateFrozen,inert:document.querySelector('main').inert,modal:el('desktop-update-dialog').open})))`);
  assert.deepEqual(updateCancelled, { frozen: false, inert: false, modal: false });
  mainWindow.webContents.send('desktop:update-state', updaterState);
  assert.equal((await request('/api/apply-update', { method: 'POST' })).status, 409);
  assert.deepEqual(errors, []);
  return { ok: true, packaged: app.isPackaged, health, ui, storage, played, recoveredVideo, layouts, split, snapshot: captures[0], savedProject: saved.id, screenshot, renderPath, nativeSaved, nativeSaveResult, updaterState, updatePopup, updateScreenshot, frozenUpdate, updateCancelled, errors };
};
