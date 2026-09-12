const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const line = marker => script.split('\n').find(value => value.includes(marker));
const between = (first, next) => script.slice(script.indexOf(first), script.indexOf(next, script.indexOf(first) + first.length));
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const nodes = new Map();let saves = 0;
  const c = vm.createContext({ S: { nextZoomKeyframeId: 1, imageLayers: [], selectedLayer: null, selectedImageKeyframe: null },
    currentOutputTime: () => 3, isTrackLocked: () => false, remember() {}, drawClips() {}, drawMediaOverlay() {}, drawImageInspector() {}, drawTimelineMediaLayers() {},
    scheduleAutosave: () => saves++, seekOutputTime: value => { c.seeked = value; }, mv: { pause() {} }, log() {},
    layerSelected: (type, id) => c.S.selectedLayer?.type === type && c.S.selectedLayer.id === id,
    el: id => { if (!nodes.has(id)) nodes.set(id, { value: '' });return nodes.get(id); },
    CLIP_ANIMATIONS: { none: 'Yok', fadein: 'Fade In' }, VIDEO_EFFECTS: { none: { name: 'Yok' }, noir: { name: 'Noir' } }, CLIP_FILTERS: { none: { name: 'Yok' }, warm: { name: 'Warm' } },
  });
  vm.runInContext([between('    const ZOOM_EASINGS=', '    const clipSettings='),
    line('const imageLayerSettings='), line('const hydrateImageLayer='), line('const selectedImageLayer='), line('const copyLayers='),
    between('    function normalizedImageKeyframes', '    function imageToolLabels'), line('function applyImageTool('), line('function mixedImageStyle('), line('function paintImagePreview('), line('function bindImageUndoInput('),
  ].join('\n'), c);
  const a = { id: 'A', name: 'First', start: 1, end: 6, x: 50, y: 50, scale: 40, transformKeyframes: [
    { id: 'IZ1', time: 0, scale: 100, x: 35, y: 40, opacity: 100, easing: 'linear' },
    { id: 'IZ2', time: 4, scale: 200, x: 65, y: 60, opacity: 30, easing: 'linear' },
  ] }, b = { id: 'B', name: 'Second', start: 3, end: 8, scale: 20, opacity: 60, x: 75, y: 30 };
  c.S.imageLayers = [a, b];c.S.selectedLayer = { type: 'image', id: 'A' };c.S.nextZoomKeyframeId = 3;
  return { c, a, b, nodes, saves: () => saves };
}

test('image transforms use layer-relative timing, canvas-width base size and independent opacity', () => {
  const { c, a, b } = fixture(), middle = c.imageTransformAtTime(a, 3);
  assert.equal(middle.scale, 150);assert.equal(a.scale * middle.scale / 100, 60);
  assert.equal(middle.x, 50);assert.equal(middle.y, 50);assert.equal(middle.opacity, 65);
  assert.equal(c.imageTransformAtTime(b, 3).opacity, 60);
  assert.equal(c.imageTransformAtTime(a, 0).scale, 100);assert.equal(c.imageTransformAtTime(a, 9).scale, 200);
});

test('all nine easing choices interpolate smoothly and keep endpoints exact', () => {
  const { c, a } = fixture();
  for (const easing of ['smoother', 'smooth', 'cinematic', 'easeInOut', 'easeIn', 'easeOut', 'gentle', 'responsive', 'linear']) {
    a.transformKeyframes[1].easing = easing;
    const values = Array.from({ length: 81 }, (_, i) => c.imageTransformAtTime(a, 1 + i / 20).scale);
    assert.equal(values[0], 100);assert.equal(values.at(-1), 200);
    assert.ok(values.every((value, i) => !i || value >= values[i - 1]));
    assert.ok(Math.max(...values.slice(1).map((value, i) => value - values[i])) < 6);
  }
});

test('selected image frame edits do not alter its base settings or other images; time input is output seconds', () => {
  const { c, a, b, saves } = fixture(), other = plain(b);c.S.selectedImageKeyframe = 'IZ2';
  c.updateSelectedImageKeyframe('scale', 250);c.updateSelectedImageKeyframe('opacity', 0);c.updateSelectedImageKeyframe('time', 4);
  assert.equal(a.transformKeyframes[1].scale, 250);assert.equal(a.transformKeyframes[1].opacity, 0);assert.equal(a.transformKeyframes[1].time, 3);
  assert.equal(c.seeked, 4);assert.equal(a.scale, 40);assert.deepEqual(b, other);assert.ok(saves() >= 3);
  c.isTrackLocked = () => true;c.updateSelectedImageKeyframe('scale', 80);assert.equal(a.transformKeyframes[1].scale, 250);
});

test('left and right image trims preserve boundary appearance and remaining absolute keyframe times', () => {
  for (const edge of ['left', 'right']) {
    const { c, a } = fixture(), original = plain(a);if (edge === 'left') a.start = 2;else a.end = 4;
    c.rebaseImageKeyframes(a, original, edge);
    for (const time of [2, 2.5, 3, 4]) assert.deepEqual(plain(c.imageTransformAtTime(a, time)), plain(c.imageTransformAtTime(original, time)));
    assert.equal(a.transformKeyframes[0].time, 0);
    if (edge === 'left') assert.equal(a.transformKeyframes[1].time + a.start, 5);
    else assert.equal(a.transformKeyframes.at(-1).time + a.start, 4);
  }
});

test('image keyframes and brush strokes are deep-copied for history and project JSON', () => {
  const { c, a } = fixture();a.brushStrokes = [{ size: 12, points: [{ x: .2, y: .3 }] }];
  const copied = vm.runInContext('copyLayers(S.imageLayers)', c), restored = JSON.parse(JSON.stringify(copied));
  copied[0].transformKeyframes[0].scale = 299;copied[0].brushStrokes[0].points[0].x = .9;
  assert.equal(a.transformKeyframes[0].scale, 100);assert.equal(a.brushStrokes[0].points[0].x, .2);
  assert.equal(restored[0].transformKeyframes[0].scale, 100);
});

test('animation, effect and filter target only the chosen image and respect its lock', () => {
  const { c, a, b } = fixture();c.applyImageTool('animation', 'fadein', 'A');c.applyImageTool('effect', 'noir', 'A');c.applyImageTool('filter', 'warm', 'B');
  assert.equal(a.animation, 'fadein');assert.equal(a.effect, 'noir');assert.equal(a.filter, 'none');assert.equal(b.filter, 'warm');assert.equal(b.animation, 'none');
  c.isTrackLocked = () => true;c.applyImageTool('effect', 'none', 'A');assert.equal(a.effect, 'noir');
});

test('preview intensity leaves CSS colors intact and identity effects really are neutral', () => {
  const { c } = fixture();
  assert.equal(c.mixedImageStyle('contrast(1.4) saturate(2)', 50), 'contrast(1.2) saturate(1.5)');
  assert.equal(c.mixedImageStyle('drop-shadow(0 0 18px #000)', 100), 'drop-shadow(0 0 18px #000)');
  assert.equal(c.mixedImageStyle('brightness(1.2)', 0), '');
});

test('each image control gesture has an undo snapshot even while the input stays focused', () => {
  const { c } = fixture(), input = {};let snapshots = 0;c.remember = () => snapshots++;
  c.S.selectedImageKeyframe = 'IZ2';c.bindImageUndoInput(input, true);
  input.onpointerdown();input.onpointerdown();input.onkeydown({ key: 'ArrowRight', repeat: false });
  assert.equal(snapshots, 3);
  input.onkeydown({ key: 'ArrowRight', repeat: true });input.onkeydown({ key: 'Tab', repeat: false });
  c.isTrackLocked = () => true;input.onpointerdown();assert.equal(snapshots, 3);
});

test('mirroring the image does not reverse animation slide direction or rotation', () => {
  const { c, a } = fixture(), image = { style: {} }, wrap = { style: {}, querySelector: () => image };
  c.effectStyles = () => ({ filter: 'none', transform: 'scaleX(-1)' });
  c.clipAnimationStyle = () => ({ filter: '', transform: 'translateX(-30%) rotate(15deg)' });
  c.paintImagePreview(wrap, a, 3);
  // CSS transforms apply from right to left: mirror source pixels first,
  // then animate in the normal local coordinates, as the renderer does.
  assert.equal(image.style.transform, 'translateX(-30%) rotate(15deg) scaleX(-1)');
});
