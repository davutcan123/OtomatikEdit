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
  const nodes = new Map(), handlers = new Map(), history = [];
  const makeNode = () => ({ style: {}, hidden: true, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    children: [], appendChild(child) { this.children.push(child); this.firstElementChild = this.children[0]; if (child.id) nodes.set(child.id, child); },
    setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    scrollLeft: 0, scrollTop: 0, scrollWidth: 1400, clientWidth: 1000,
    getBoundingClientRect() { return { left: 0, right: 1000 }; } });
  const c = vm.createContext({ S: { clips: [], texts: [], stickers: [], imageLayers: [], audioLayers: [], mediaAssets: [], zoom: 20, timelineMagnet: true, nextZoomKeyframeId: 5, duration: 30 },
    TIMELINE_GUTTER: 132, currentOutputTime: () => c.cursor, outDuration: () => 30,
    clipTimelineStart: item => +item.timelineStart || 0,
    clipOutputDuration: item => (item.end - item.start) / (+item.speed || 1),
    clipTimelineEnd: item => (+item.timelineStart || 0) + (item.end - item.start) / (+item.speed || 1),
    pausePreview() { c.pauses++; }, seekOutputTime(value) { c.cursor = value; },
    el: id => { if (!nodes.has(id) && id !== 'timeline-snap-guide') nodes.set(id, makeNode());return nodes.get(id); },
    document: { createElement: makeNode }, ft: value => value.toFixed(2), log() {},
    isTrackLocked: type => c.locked === type, isVideoTrackLocked: item => c.locked === 'video' || item.videoTrack === c.lockedVideoTrack,
    remember() { history.push(plain(c.S)); }, drawClips() {}, drawTextOverlay() {}, showTextProperties() {}, clampClipTransitions() {},
    rebaseImageKeyframes() {}, zoomStateAtRelativeTime: () => ({ scale: 100, x: 50, y: 50, opacity: 100 }),
    hydrateText(item) { item.transformKeyframes ||= []; }, layerSelected: (type,id) => c.S.selectedLayer?.type === type && c.S.selectedLayer.id === id,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1,
    window: { addEventListener(type, fn) { handlers.set(type, fn); }, removeEventListener(type) { handlers.delete(type); } },
  });
  c.cursor = 25;c.pauses = 0;
  vm.runInContext([
    between('    const ZOOM_EASINGS=', '    const clipSettings='),
    between('    function appendTrimHandles', '    function fitClipPosition'),
    between('    function beginTimedTrim', '    function setPreviewSource'),
    between('    function beginTimelineLayerDrag', '    function deleteSelectedLayer'),
    line('function normalizedTextKeyframes('), line('function textTransformAtTime('),
  ].join('\n'), c);
  const pointer = x => ({ button: 0, clientX: x, preventDefault() {}, stopPropagation() {} });
  return { c, nodes, history, makeNode, pointer, move(x) { handlers.get('pointermove')?.(pointer(x)); }, up() { handlers.get('pointerup')?.(); }, handlers };
}

test('all layer boundaries and video tracks participate, self edges are excluded and cuts are deduplicated', () => {
  const { c } = fixture(), a = { timelineStart: 2, start: 10, end: 14, speed: 2, videoTrack: 1 };
  c.S.clips = [a, { timelineStart: 7, start: 0, end: 3, videoTrack: 2 }];
  c.S.texts = [{ start: 4, end: 6 }, { kind: 'subtitle', start: 10, end: 12 }];
  c.S.imageLayers = [{ start: 1, end: 3 }];c.S.audioLayers = [{ start: 5, end: 9 }];c.S.stickers = [{ start: 8, end: 11 }];
  assert.deepEqual(plain(c.timelineBoundaries()), [0,1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.ok(!c.timelineBoundaries({ excludeItem: a }).includes(2));
  assert.ok(c.timelineBoundaries({ includePlayhead: true }).includes(25));
});

test('snap threshold is exactly ten screen pixels at detailed and long-video zoom', () => {
  const { c } = fixture();c.S.texts = [{ start: 5000, end: 20000 }];
  for (const zoom of [.02, .2, 8, 80]) {
    c.S.zoom = zoom;
    assert.equal(c.snapTimelineTime(5000 + 9.9 / zoom, { includePlayhead: false, showGuide: false }), 5000);
    const raw = 5000 - 10.1 / zoom;
    assert.equal(c.snapTimelineTime(raw, { includePlayhead: false, showGuide: false }), raw);
  }
});

test('moving either edge snaps to any track, invalid placements are ignored, off is fully free', () => {
  const { c, nodes } = fixture(), moving = { start: 2, end: 5 };c.S.imageLayers = [moving];c.S.texts = [{ start: 10, end: 13 }];
  assert.equal(c.snapTimelinePosition(6.8, 3, moving), 7);assert.equal(c.S.timelineSnapTime, 10);
  assert.equal(nodes.get('timeline-snap-guide').style.left, '332px');
  assert.equal(c.snapTimelinePosition(9.7, 3, moving), 10);assert.equal(c.S.timelineSnapTime, 10);
  assert.equal(c.snapTimelineTime(9.8, { min: 0, max: 9.9 }), 9.8);
  c.S.timelineMagnet = false;
  assert.equal(c.snapTimelinePosition(6.8, 3, moving), 6.8);assert.equal(c.snapTimelineTime(9.8), 9.8);
  assert.equal(nodes.get('timeline-snap-guide').hidden, true);assert.equal(c.S.timelineSnapTime, null);
});

test('boundary jumps use cut starts and gap ends across all tracks, never a one-second approximation', () => {
  const { c } = fixture();c.S.clips = [{ timelineStart: 0, start: 0, end: 3 }, { timelineStart: 7, start: 0, end: 3, videoTrack: 2 }];c.S.stickers = [{ start: 4.2, end: 5.7 }];c.cursor = 3;
  assert.equal(c.jumpTimelineBoundary(1), 4.2);assert.equal(c.jumpTimelineBoundary(1), 5.7);
  assert.equal(c.jumpTimelineBoundary(1), 7);assert.equal(c.jumpTimelineBoundary(-1), 5.7);
  assert.equal(c.pauses, 4);c.cursor = 0;assert.equal(c.jumpTimelineBoundary(-1), 0);
});

test('video trim respects source speed, same-track neighbors and unrelated stacked clips', () => {
  const { c } = fixture(), item = { timelineStart: 5, start: 4, end: 14, speed: 2, sourceDuration: 30, videoTrack: 2 };
  c.S.clips = [item, { timelineStart: 1, start: 0, end: 3, videoTrack: 2 }, { timelineStart: 12, start: 0, end: 3, videoTrack: 2 }, { timelineStart: 9, start: 0, end: 20, videoTrack: 1 }];
  assert.deepEqual(plain(c.timelineTrimBounds('video', item, item)), { start: 5, end: 10, minimum: 4, maximum: 12 });
});

test('video left trim holds its right output edge, changes source and timeline together, one gesture one undo', () => {
  const { c, pointer, move, up, history, makeNode } = fixture(), item = { timelineStart: 5, start: 4, end: 14, speed: 2, sourceDuration: 30, videoTrack: 2 };
  c.S.timelineMagnet = false;c.S.clips = [item];const node = makeNode();
  c.beginTimedTrim(pointer(400), 'video', 0, 'left', node);move(420);
  assert.equal(item.timelineStart, 6);assert.equal(item.start, 6);assert.equal(item.end, 14);
  assert.equal(c.clipTimelineEnd(item), 10);assert.equal(node.style.left, '120px');assert.equal(node.style.width, '80px');
  move(430);up();assert.equal(history.length, 1);assert.equal(history[0].clips[0].start, 4);
});

test('both audio handles extend within real source limits, preserve source offset and snap exactly', () => {
  const { c, pointer, move, up, makeNode } = fixture(), item = { id: 'A', assetId: 'source', start: 5, end: 8, sourceStart: 2 };
  c.S.audioLayers = [item];c.S.mediaAssets = [{ id: 'source', duration: 10 }];c.S.texts = [{ start: 4, end: 10 }];
  assert.deepEqual(plain(c.timelineTrimBounds('audio', item, item)), { start: 5, end: 8, minimum: 3, maximum: 13 });
  c.beginTimedTrim(pointer(400), 'audio', 'A', 'left', makeNode());move(384);up();
  assert.equal(item.start, 4);assert.equal(item.sourceStart, 1);assert.equal(item.end, 8);
  c.beginTimedTrim(pointer(400), 'audio', 'A', 'right', makeNode());move(436);up();assert.equal(item.end, 10);
  c.S.timelineMagnet = false;c.beginTimedTrim(pointer(400), 'audio', 'A', 'right', makeNode());move(900);up();assert.equal(item.end, 13);
});

test('every timed layer moves with left/right snapping, exact width, and per-track lock guards', () => {
  for (const type of ['image', 'audio', 'text', 'subtitle', 'sticker']) {
    const { c, pointer, move, up, history, makeNode } = fixture(), item = { id: 'moving', kind: type, start: 2, end: 5, name: type };
    c.S[type === 'image' ? 'imageLayers' : type === 'audio' ? 'audioLayers' : type === 'sticker' ? 'stickers' : 'texts'] = [item];
    c.S.clips = [{ timelineStart: 10, start: 0, end: 5 }];const node = makeNode();
    c.beginTimedLayerDrag(pointer(400), type, item.id, node);move(496);assert.equal(item.start, 7);assert.equal(item.end, 10);assert.equal(node.style.width, '60px');up();assert.equal(history.length, 1);
    c.locked = type;c.beginTimedTrim(pointer(400), type, item.id, 'right', node);move(450);up();assert.equal(item.end, 10);assert.equal(history.length, 1);
  }
});

test('text and subtitle trims preserve keyframe boundary state and absolute remaining frame times', () => {
  for (const kind of ['text', 'subtitle']) for (const edge of ['left', 'right']) {
    const { c } = fixture(), original = { kind, start: 2, end: 8, x: 50, y: 50, transformKeyframes: [{ id: 'first', time: 0, scale: 100, x: 30, y: 40, opacity: 100, easing: 'linear' }, { id: 'last', time: 6, scale: 200, x: 70, y: 60, opacity: 20, easing: 'linear' }] }, item = plain(original);
    if (edge === 'left') item.start = 3.5;else item.end = 6;
    c.rebaseTextKeyframes(item, original, edge);
    for (const time of [3.5, 4, 5, 6]) { const actual = c.textTransformAtTime(item, time), expected = c.textTransformAtTime(original, time);for (const key of ['scale', 'x', 'y', 'opacity']) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, key); }
    if (edge === 'left') assert.equal(item.transformKeyframes.at(-1).time + item.start, 8);
  }
});

test('timed geometry has no minimum-duration visual lie at any zoom, and handles describe both directions', () => {
  const { c, makeNode } = fixture(), item = { start: 2, end: 3.5 };
  for (const type of ['image', 'audio', 'text', 'subtitle', 'sticker']) for (const zoom of [.02, 8, 80]) {
    c.S.zoom = zoom;const node = makeNode();c.paintTimedClipTiming(node, type, item);assert.equal(+node.style.width.slice(0, -2), 1.5 * zoom);
  }
  assert.ok(!between('    function drawTexts', '    function beginTextClipDrag').includes('Math.max(76'));
  assert.ok(!between('    function drawTimelineMediaLayers', '    function beginTimelineLayerDrag').includes('Math.max(76'));
  const node = makeNode();c.appendTrimHandles(node, 'text', 'T');assert.equal(node.children.length, 2);assert.ok(node.children.every(handle => handle.title.includes('uzat / kısalt')));
});
