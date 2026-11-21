'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, session } = require('electron');
const { createNativeTestWindow } = require('./support/native_test_window.cjs');

const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'otomatik-preview-fixture-'));
app.setPath('userData', path.join(scratch, 'profile'));
const localPython = path.join(root, process.platform === 'win32' ? '.venv-windows/Scripts/python.exe' : 'venv/bin/python');
const windowsFFmpeg = path.join(root, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
const executable = process.env.SMART_EDITOR_PYTHON || (fs.existsSync(localPython) ? localPython : 'python');
const ffmpeg = process.env.SMART_EDITOR_FFMPEG || (process.platform === 'win32' && fs.existsSync(windowsFFmpeg) ? windowsFFmpeg : 'ffmpeg');
const ffprobe = process.env.SMART_EDITOR_FFPROBE || (ffmpeg === windowsFFmpeg ? windowsFFmpeg.replace(/ffmpeg\.exe$/, 'ffprobe.exe') : 'ffprobe');
const fixtures = process.env.SMART_EDITOR_CODEC_FIXTURES;
let engine, window;
let engineLog = '';
const token = crypto.randomBytes(24).toString('hex');
const headers = { 'X-Desktop-Token': token };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const evaluate = code => window.webContents.executeJavaScript(code);
const records = [];

async function waitFor(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}
async function openPort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function mediaFile(name, codec, size = '320x192', audio = 'aac') {
  const provided = fixtures && path.join(fixtures, name);
  if (provided && fs.existsSync(provided)) return provided;
  const target = path.join(scratch, name);
  const audioArgs = audio ? ['-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1.25', '-c:a', audio] : [];
  const pixelArgs = codec === 'libx264' ? ['-pix_fmt', 'yuv420p'] : [];
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=24:d=1.25`,
    ...audioArgs, '-c:v', codec, ...pixelArgs, '-threads', '2', target], { timeout: 30000 });
  return target;
}

function project(asset, composite = false) {
  return { name: 'Playback fixture', activeTimelineId: 'fixture', mediaAssets: [asset], timelines: [{
    id: 'fixture', name: 'Preview',
    state: {
      manualId: asset.file_id, manualName: asset.name,
      clips: [{ clipId: 'preview-clip', fileId: asset.file_id, name: asset.name,
        start: 0, end: asset.duration, sourceDuration: asset.duration, timelineStart: 0, videoTrack: 1 }],
      videoTracks: composite ? [{ id: 1, name: 'Video 1' }, { id: 2, name: 'Video 2' }] : [{ id: 1, name: 'Video 1' }],
    },
  }] };
}
async function restore(asset, composite = false) {
  await evaluate(`restoreProject(${JSON.stringify(project(asset, composite))});switchTab('manual')`);
  return waitFor(() => evaluate(`(()=>{const video=${composite ? "document.querySelector('.composite-source')" : 'mv'};
    return video?.readyState>=2&&video.videoWidth?{width:video.videoWidth,src:video.getAttribute('src')}:null})()`), asset.name);
}
async function result(origin, route, form) {
  const started = await fetch(origin + route, { headers, method: 'POST', body: form });
  assert.equal(started.status, 200, await started.clone().text());
  const { job_id: id } = await started.json();
  const response = await fetch(origin + '/stream-events/' + id, { headers });
  const terminal = (await response.text()).split('\n')
    .filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).at(-1);
  assert.equal(terminal.type, 'result', terminal.message);
  return terminal;
}

app.whenReady().then(async () => {
  const port = await openPort(), origin = 'http://127.0.0.1:' + port;
  engine = spawn(executable, ['app.py'], {
    cwd: root, env: {
      ...process.env, PYTHONUNBUFFERED: '1', SMART_EDITOR_DESKTOP: '1', SMART_EDITOR_DESKTOP_TOKEN: token,
      SMART_EDITOR_DATA_DIR: path.join(scratch, 'workspace'), SMART_EDITOR_LEGACY_DIR: '',
      SMART_EDITOR_PORT: String(port), SMART_EDITOR_HOST: '127.0.0.1', SMART_EDITOR_OPEN_BROWSER: '0',
    }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  engine.on('error', error => { engineLog += error.stack; });
  for (const pipe of [engine.stdout, engine.stderr]) pipe.on('data', data => { engineLog = (engineLog + data).slice(-20000); });
  await waitFor(async () => {
    try { return (await fetch(origin + '/api/health', { headers })).ok; } catch { return false; }
  }, 'backend start');
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (new URL(details.url).origin === origin) details.requestHeaders['X-Desktop-Token'] = token;
    callback({ requestHeaders: details.requestHeaders });
  });
  window = createNativeTestWindow({ show: true, width: 1366, height: 740, webPreferences: { backgroundThrottling: false } });
  await window.loadURL(origin);
  await evaluate('projectWorkspaceInitialization');
  const variants = new Map();
  const samples = [
    ['prores.mov', 'prores_ks', 'compatible'],
    ['ffv1.mkv', 'ffv1', 'compatible'],
    ['h264.mp4', 'libx264', 'original'],
    ['hevc.mp4', 'libx265', process.platform === 'darwin' ? 'original' : null],
    ['vp9.webm', 'libvpx-vp9', 'original', 'libopus'],
  ];
  for (const [name, codec, expected, audio] of samples) {
    const original = fs.readFileSync(mediaFile(name, codec, undefined, audio));
    const form = new FormData();
    form.append('file', new Blob([original]), name);
    const upload = await fetch(origin + '/upload', { method: 'POST', headers, body: form });
    assert.equal(upload.status, 200, await upload.clone().text());
    const asset = await upload.json();
    const playback = await restore(asset);
    assert.equal(playback.width, 320, name);
    const forbidden = await fetch(origin + playback.src);
    assert.equal(forbidden.status, 403);
    const response = await fetch(origin + playback.src, { headers: { ...headers, Range: 'bytes=0-31' } });
    assert.equal(response.status, 206);
    const actual = response.headers.get('x-studio-preview');
    if (expected) assert.equal(actual, expected, name);
    const downloaded = await fetch(origin + asset.url, { headers });
    assert.equal(digest(Buffer.from(await downloaded.arrayBuffer())), digest(original));
    records.push({ name, original: digest(original), decodedWidth: playback.width, mode: actual });
    variants.set(name, asset);
  }

  const ffv1 = variants.get('ffv1.mkv'), prores = variants.get('prores.mov');
  assert.equal((await restore(prores, true)).width, 320);
  const analysis = await result(origin, '/start-analysis', new URLSearchParams({ file_id: ffv1.file_id, threshold: '-65' }));
  await evaluate(`autoResult(${JSON.stringify(analysis.data)},${JSON.stringify(ffv1.file_id)},'FFV1');switchTab('auto')`);
  await waitFor(() => evaluate("el('auto-video').videoWidth===320"), 'Auto Cutter playback');

  const original = fs.readFileSync(mediaFile('large.mp4', 'libx264', '1280x720', null));
  const uploadForm = new FormData();
  uploadForm.append('file', new Blob([original]), 'large.mp4');
  const large = await (await fetch(origin + '/upload', { method: 'POST', headers, body: uploadForm })).json();
  assert.equal((await restore(large)).width, 1280);
  await evaluate(`(()=>{const select=document.querySelector('[data-preview-controls="manual"] select');select.value='light';select.dispatchEvent(new Event('change'))})()`);
  await waitFor(() => evaluate('mv.videoWidth===960'), 'lightweight playback');
  assert.equal(await evaluate('S.clips[0].src'), large.url);
  assert.match(await evaluate("document.querySelector('[data-preview-controls=manual] [role=status]').textContent"), /hazır/);
  const render = await result(origin, '/start-render', new URLSearchParams({
    file_id: large.file_id, fmt: 'mp4', hardware: 'cpu', segments: JSON.stringify([{ start: 0, end: 1, fileId: large.file_id }]),
  }));
  const output = await fetch(origin + render.download_url, { headers });
  const checkedOutput = path.join(scratch, 'rendered.mp4');
  fs.writeFileSync(checkedOutput, Buffer.from(await output.arrayBuffer()));
  const width = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width',
    '-of', 'default=nw=1:nk=1', checkedOutput], { encoding: 'utf8', timeout: 10000 }).trim();
  assert.equal(width, '1280', 'export retains original source resolution');
  await evaluate('persistProjectRecovery()');
  const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await reloaded;
  await evaluate('projectWorkspaceInitialization');
  await waitFor(() => evaluate('mv.videoWidth===960'), 'restored lightweight playback');
  assert.equal(await evaluate('S.clips[0].src'), large.url);
  console.log(JSON.stringify({ matrix: records, lightWidth: 960, originalRenderWidth: 1280, composite: true, auto: true, restored: true }));
}).catch(error => {
  console.error(error);
  console.error(engineLog);
  process.exitCode = 1;
}).finally(() => {
  window?.destroy();
  engine?.kill();
  app.exit(process.exitCode || 0);
});
