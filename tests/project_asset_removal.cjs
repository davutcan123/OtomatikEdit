const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const copy = value => JSON.parse(JSON.stringify(value));
function between(first, next) {
  const start = script.indexOf(first), end = script.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, first);
  return script.slice(start, end);
}
function fixture() {
  const asset = { id: 'asset-image', fileId: 'picture.png', name: 'Picture', kind: 'image' };
  const video = { id: 'asset-video', fileId: 'video.mp4', name: 'Video', kind: 'video' };
  const clip = (clipId, fileId, timelineStart) => ({ clipId, fileId, name: fileId, sourceDuration: 20, start: 0, end: 4, timelineStart });
  const layer = (id, fileId = asset.fileId) => ({ id, assetId: asset.id, fileId, start: 1, end: 3, animation: 'fade-in', effect: 'neon', filter: 'warm', transformKeyframes: [{ time: 2, scale: 200, x: 70, y: 20, opacity: 30 }] });
  const project = { id: 'project-one', name: 'One', mediaAssets: [asset, video], activeTimelineId: 'one',
    autoCutter: { fileId: video.fileId, highlights: [] },
    timelines: [
      { id: 'one', state: { manualId: video.fileId, selected: 1, clips: [clip('c1', video.fileId, 0), clip('c2', 'other.mp4', 4), clip('c3', 'other.mp4', 8)],
        imageLayers: [layer('i1')], audioLayers: [{ id: 'a1', fileId: 'music.wav' }], selectedLayer: { type: 'image', id: 'i1' }, selectedImageKeyframe: 'IF1',
        transitions: [{ type: 'fade', duration: .5, leftClipId: 'c2', rightClipId: 'c3', boundary: 1 }], trackState: { image: { locked: false } } } },
      { id: 'two', state: { manualId: 'other.mp4', clips: [{ ...clip('c4', 'other.mp4', 0), maskImageId: asset.id, mask: 'circle' }], imageLayers: [layer('i2')], trackState: { image: { locked: false } } } },
    ] };
  const state = { ...copy(project.timelines[0].state), mediaAssets: copy(project.mediaAssets), timelines: copy(project.timelines), history: [{ prior: true }], autoAnalyzing: false };
  let persisted = 0, restored = 0;
  const c = vm.createContext({ S: state, desktopUpdateFrozen: false, desktopClosing: false,
    TRANSITION_NAMES: { fade: 'Fade' },
    ensureClipTimelinePositions() {},
    clipOutputDuration: item => (item.end - item.start) / (item.speed || 1),
    clipTimelineStart: item => item.timelineStart || 0,
    clipTimelineEnd: item => (item.timelineStart || 0) + (item.end - item.start) / (item.speed || 1),
    currentOutputTime: () => 2, outDuration: () => 12, seekOutputTime() {}, drawProjectLibrary() {}, log() {},
    scheduleAutosave: () => persisted++,
    projectPayload: () => ({ ...copy(project), mediaAssets: copy(state.mediaAssets), timelines: state.timelines.map((t, i) => i ? copy(t) : { ...copy(t), state: { ...copy(t.state), clips: copy(state.clips), imageLayers: copy(state.imageLayers) } }) }),
    restoreProject: next => { restored++;state.mediaAssets = copy(next.mediaAssets);state.timelines = copy(next.timelines);Object.assign(state, copy(next.timelines[0].state));state.history = []; },
  });
  vm.runInContext(script.split('\n').find(line=>line.includes('function nextClipOnTrack('))+between('    function newClipId()', '    function clampClipTransitions()') +
    between('    const assetById=', "    el('asset-remove-cancel').onclick="), c);
  return { c, state, asset, video, project, persisted: () => persisted, restored: () => restored };
}

test('usage counts image instances and legacy masks across all timelines', () => {
  const f = fixture();
  assert.deepEqual(copy(f.c.projectAssetUsage(f.asset, f.project)), { video: 0, image: 2, audio: 0, mask: 1, automatic: 0, locked: false, total: 3 });
  f.project.timelines[1].state.trackState.image.locked = true;
  assert.equal(f.c.projectAssetUsage(f.asset, f.project).locked, true);
});
test('library-only removal preserves layers, nested animation data and legacy mask sources without mutating input', () => {
  const f = fixture(), original = copy(f.project), result = f.c.projectWithoutAsset(f.project, f.asset);
  assert.deepEqual(f.project, original);assert.equal(result.mediaAssets.length, 1);
  assert.deepEqual(copy(result.timelines[0].state.imageLayers), original.timelines[0].state.imageLayers);
  assert.equal(result.timelines[1].state.clips[0].maskImageFileId, f.asset.fileId);
  assert.equal(result.timelines[1].state.clips[0].maskImageSrc, '/video/picture.png');
  result.timelines[0].state.imageLayers[0].transformKeyframes[0].scale = 25;
  assert.equal(f.project.timelines[0].state.imageLayers[0].transformKeyframes[0].scale, 200);
});
test('all-uses removal clears image instances and mask references, keeps audio/video/transitions and other projects untouched', () => {
  const f = fixture(), original = copy(f.project), result = f.c.projectWithoutAsset(f.project, f.asset, true);
  assert.deepEqual(f.project, original);
  for (const t of result.timelines) assert.equal(t.state.imageLayers.length, 0);
  assert.equal(result.timelines[0].state.selectedLayer, null);assert.equal(result.timelines[0].state.selectedImageKeyframe, null);
  assert.equal(result.timelines[1].state.clips[0].mask, 'none');assert.equal(result.timelines[1].state.clips[0].maskImageFileId, '');
  assert.equal(result.timelines[0].state.audioLayers.length, 1);assert.equal(result.timelines[0].state.transitions[0].leftClipId, 'c2');
  assert.equal(result.timelines[0].state.transitions[0].suspended, false);
});
test('video removal retains surviving selection and transition identity and replaces the default source', () => {
  const f = fixture(), result = f.c.projectWithoutAsset(f.project, f.video, true), s = result.timelines[0].state;
  assert.deepEqual(copy(s.clips.map(item => item.clipId)), ['c2', 'c3']);assert.equal(s.selected, 0);
  assert.equal(s.manualId, 'other.mp4');assert.equal(s.duration, 20);assert.equal(result.autoCutter, null);
  assert.equal(s.transitions[0].boundary, 0);assert.equal(s.transitions[0].leftClipId, 'c2');
});
test('library-only action retains active legacy mask source without reloading video; removal is undoable', () => {
  const f = fixture();Object.assign(f.state.clips[0], { maskImageId: f.asset.id, mask: 'circle' });
  assert.equal(f.c.removeProjectAsset(f.asset.id, false), true);
  assert.equal(f.restored(), 0);assert.equal(f.state.clips[0].maskImageFileId, f.asset.fileId);
  assert.equal(f.state.mediaAssets.length, 1);assert.equal(f.persisted(), 1);
  assert.equal(f.c.undoProjectAssetRemoval(f.state.history.pop()), true);
  assert.equal(f.state.mediaAssets.length, 2);assert.equal(f.state.history.length, 1);assert.equal(f.persisted(), 2);
});
test('removal and undo restore inactive timelines and independent deep-copied keyframes', () => {
  const f = fixture();assert.equal(f.c.removeProjectAsset(f.asset.id, true), true);
  assert.equal(f.state.timelines[1].state.imageLayers.length, 0);
  const entry = f.state.history.pop();assert.equal(f.c.undoProjectAssetRemoval(entry), true);
  assert.equal(f.state.timelines[1].state.imageLayers[0].transformKeyframes[0].scale, 200);
  f.state.timelines[1].state.imageLayers[0].transformKeyframes[0].scale = 250;
  assert.equal(entry.assetRemovalProject.timelines[1].state.imageLayers[0].transformKeyframes[0].scale, 200);
});
test('a locked inactive track prevents all-uses removal but permits library-only removal', () => {
  const f = fixture();f.state.timelines[1].state.trackState.image.locked = true;
  const before = copy(f.state);assert.equal(f.c.removeProjectAsset(f.asset.id, true), false);assert.deepEqual(f.state, before);
  assert.equal(f.c.removeProjectAsset(f.asset.id, false), true);assert.equal(f.state.timelines[1].state.imageLayers.length, 1);
});
test('stale IDs, closing, updating and active analysis cannot mutate the project; analysis preserves a pending undo', () => {
  const f = fixture(), before = copy(f.state);assert.equal(f.c.removeProjectAsset('missing'), false);
  f.c.desktopClosing = true;assert.equal(f.c.removeProjectAsset(f.asset.id), false);f.c.desktopClosing = false;
  f.c.desktopUpdateFrozen = true;assert.equal(f.c.removeProjectAsset(f.asset.id), false);f.c.desktopUpdateFrozen = false;
  assert.deepEqual(f.state, before);f.state.autoAnalyzing = true;assert.equal(f.c.removeProjectAsset(f.asset.id), false);
  f.state.autoAnalyzing = false;f.c.removeProjectAsset(f.asset.id);const entry = f.state.history.pop();f.state.autoAnalyzing = true;
  assert.equal(f.c.undoProjectAssetRemoval(entry), true);assert.equal(f.state.mediaAssets.length, 1);assert.equal(f.state.history.at(-1), entry);
  f.state.autoAnalyzing = false;f.c.undoProjectAssetRemoval(f.state.history.pop());assert.equal(f.state.mediaAssets.length, 2);
});
test('removal is metadata-only and its modal blocks editor shortcuts behind the dialog', () => {
  const implementation = between('    const assetById=', '    function drawProjectLibrary()');
  assert.doesNotMatch(implementation, /fetch\(|\.unlink|\.rm\(|method\s*:\s*['"]DELETE/);
  assert.match(implementation, /asset-remove-dialog'\)\.addEventListener\('keydown',event=>event.stopPropagation\(\)\)/);
  assert.match(html, /id="asset-remove-cancel"/);assert.match(html, /id="asset-remove-library"/);assert.match(html, /id="asset-remove-all"/);
});
