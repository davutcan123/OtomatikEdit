const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const between = (first, next) => script.slice(script.indexOf(first), script.indexOf(next, script.indexOf(first) + first.length));

test('snapshot resolution keeps landscape, portrait and ultrawide aspect up to 4K', () => {
  const c = vm.createContext({});
  vm.runInContext(between('    function snapshotDimensions', '    function updateSnapshotSize'), c);
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080], [2560, 1080]]) {
    const result = c.snapshotDimensions(3840, { width, height });
    assert.equal(Math.max(result.width, result.height), 3840);
    assert.ok(Math.abs(result.width / result.height - width / height) < .003);
  }
});

test('render and snapshot use a single form containing visible layers and clip transforms', () => {
  const c = vm.createContext({ FormData, S: {
    manualId: 'video', canvas: { width: 1920, height: 1080 },
    texts: [{ text: 'Visible' }, { text: 'Hidden subtitle', kind: 'subtitle' }],
    stickers: [{ preset: 'star' }], audioLayers: [{ fileId: 'music' }], transitions: [{ boundary: 0 }],
    trackState: { subtitle: { visible: false }, text: { visible: true }, sticker: { visible: true }, image: { visible: true }, audio: { muted: false }, video: { visible: true, muted: true } },
  }, el: id => ({ value: id === 'export-fps' ? '30' : 'standard' }),
  exportableClips: () => [{ start: 0, end: 4, scale: 130, zoomKeyframes: [{ time: 1 }] }],
  exportableImageLayers: () => [{ fileId: 'image', rotation: 20 }], buildMaskImageLayers: () => [{ fileId: 'mask' }] });
  vm.runInContext(between('    function buildRenderForm', '    async function saveCompletedOutput') + between('    function manualExportData', '    async function startManualRender'), c);
  const form = c.buildRenderForm(c.manualExportData());
  assert.equal(JSON.parse(form.get('texts')).length, 1);
  assert.equal(JSON.parse(form.get('images')).length, 2);
  assert.equal(JSON.parse(form.get('segments'))[0].scale, 130);
  assert.equal(JSON.parse(form.get('stickers'))[0].preset, 'star');
  assert.equal(form.get('mute_video_audio'), 'true');
});

function splitContext() {
  const c = vm.createContext({ S: { selected: 0, preview: 1, clips: [
    { start: 0, end: 4, timelineStart: 0, speed: 1 },
    { start: 30, end: 50, timelineStart: 8, speed: 2, effect: 'neon', opacity: 75, zoomKeyframes: [{ time: 1 }, { time: 8 }] },
  ], transitions: [], nextZoomKeyframeId: 1, audioLayers: [], nextLayerId: 1 },
  mv: { paused: false }, currentOutputTime: () => 13, isTrackLocked: () => false,
  clipTimelineStart: clip => clip.timelineStart, clipTimelineEnd: clip => clip.timelineStart + (clip.end - clip.start) / clip.speed,
  normalizedZoomKeyframes: clip => clip.zoomKeyframes || [], zoomStateAtRelativeTime: () => ({ scale: 120, x: 50, y: 50, opacity: 75 }),
  remember() {}, resetLiveTransition() {}, drawClips() {}, setPreviewSource() {}, log() {}, ft: String,
  });
  vm.runInContext(between('    function splitVideoTarget', '    function splitSelected'), c);
  return c;
}

test('B splits the video under the output cursor with speed, effects and keyframes retained', () => {
  const c = splitContext();
  c.splitClip();
  assert.equal(c.S.clips.length, 3);
  assert.equal(c.S.clips[1].end, 40);
  assert.equal(c.S.clips[2].start, 40);
  assert.equal(c.S.clips[2].timelineStart, 13);
  assert.equal(c.S.clips[2].effect, 'neon');
  assert.equal(c.S.clips[2].zoomKeyframes[0].time, 0);
  assert.equal(c.S.clips[2].zoomKeyframes[1].time, 3);
});

test('B preserves locks and cuts selected audio using output time with a valid source offset', () => {
  const c = splitContext();
  c.isTrackLocked = () => true;
  c.splitClip();
  assert.equal(c.S.clips.length, 2);
  c.S.audioLayers = [{ id: 'one', start: 8, end: 18, sourceStart: 3, volume: 1.5 }];
  c.S.selectedLayer = { type: 'audio', id: 'one' };
  c.splitAudioLayer();
  assert.equal(c.S.audioLayers.length, 1);
  c.isTrackLocked = () => false;
  c.splitAudioLayer();
  assert.equal(c.S.audioLayers[1].sourceStart, 8);
  assert.equal(c.S.audioLayers[1].volume, 1.5);
});

test('keyboard splitting does not intercept text edits, and timeline pointer releases old input focus', () => {
  let keydown, pointerdown, splits = 0;
  const timeline = { focus() { c.document.activeElement = { tagName: 'DIV' }; }, addEventListener(_, callback) { pointerdown = callback; } };
  const c = vm.createContext({ document: { activeElement: { tagName: 'INPUT' }, addEventListener(_, callback) { keydown = callback; } },
    el: id => id === 'timeline' ? timeline : { open: false, classList: { contains: () => true } }, splitSelected: () => splits++,
  });
  vm.runInContext(between("    el('timeline').tabIndex=0", '    function fitTimeline') + between("    document.addEventListener('keydown',e=>{const focused", '    // PROJECT MEDIA LIBRARY'), c);
  const key = { key: 'b', preventDefault() {} };
  keydown(key);
  assert.equal(splits, 0);
  pointerdown({ target: { closest: () => null } });
  keydown(key);
  assert.equal(splits, 1);
});

test('render completion asks native save once and cancellation leaves an explicit retry', async () => {
  const nodes = new Map(), calls = [];
  const c = vm.createContext({ desktopBridge: { saveOutput: async url => { calls.push(url); return { canceled: true, saved: false }; } }, log() {},
    el: id => { if (!nodes.has(id)) nodes.set(id, { classList: { add() {}, remove() {} }, click() { throw new Error('Unexpected automatic browser fallback'); } }); return nodes.get(id); },
  });
  vm.runInContext(between('    async function saveCompletedOutput', '    async function render('), c);
  await c.saveCompletedOutput('/download/result.mp4', 'manual-download', 'manual-log');
  assert.equal(calls.length, 1);
  assert.equal(nodes.get('manual-download-top').textContent, 'Kaydetme konumu seç');
  nodes.get('manual-download-top').onclick({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
});

test('deleting an open saved project detaches its id and updates recovery without deleting media', async () => {
  const requests = [];
  let recoveredId = 'old';
  const c = vm.createContext({ S: { projectId: 'project-1', mediaAssets: [{ fileId: 'shared' }] },
    el: id => id === 'project-list' ? { value: 'project-1', selectedOptions: [{ textContent: 'My project' }] } : {}, confirm: () => true,
    fetch: async (url, options) => { requests.push([url, options.method]); return { ok: true }; },
    persistProjectRecovery: async () => { recoveredId = c.S.projectId; }, refreshProjectList: async () => {}, log() {},
  });
  vm.runInContext(between('    async function deleteNamedProject', '    function newProject'), c);
  await c.deleteNamedProject();
  assert.deepEqual(requests, [['/projects/project-1', 'DELETE']]);
  assert.equal(recoveredId, null);
  assert.equal(c.S.mediaAssets.length, 1);
});
