const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const tools = fs.readFileSync(path.join(__dirname, '../static/timeline_tools.js'), 'utf8');
const tracks = fs.readFileSync(path.join(__dirname, '../static/video_tracks.js'), 'utf8');
const line = marker => {const result = script.split('\n').find(value => value.includes(marker)); assert.ok(result, marker); return result;};
const between = (first, next) => {const start = script.indexOf(first), end = script.indexOf(next, start + first.length); assert.ok(start >= 0 && end > start, first); return script.slice(start, end);};
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const nodes = new Map(), windowEvents = new Map(), documentEvents = new Map();
  let serial = 0, saves = 0, clipNodes = [];
  const makeNode = id => ({id, style: {}, dataset: {}, value: '', attributes: {}, listeners: new Map(), hidden: false,
    classList: {contains(name) {return id === 'manual' ? name === 'active' : name === 'hidden';}, add() {}, remove() {}, toggle() {}},
    addEventListener(name, callback) {this.listeners.set(name, callback);}, removeAttribute() {}, load() {},
    setAttribute(name, value) {this.attributes[name] = value;},
    before(node) {nodes.set(node.id, node);}, after(node) {nodes.set(node.id, node);},
    focus() {c.document.activeElement = this;}, contains(node) {return node === this || clipNodes.includes(node);},
    querySelectorAll(selector) {return selector === '#track .clip' ? clipNodes : [];},
    scrollLeft: 0, scrollTop: 0, scrollWidth: 2000, clientWidth: 1000,
    getBoundingClientRect: () => ({left: 0, right: 1000, top: 0, bottom: 500, width: 1000, height: 500})});
  const node = id => {if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id);};
  const c = vm.createContext({
    S: {clips: [], texts: [], stickers: [], imageLayers: [], audioLayers: [], transitions: [], mediaAssets: [], history: [],
      selected: -1, preview: -1, selectedVideoClipIds: [], selectedText: null, selectedSticker: null, selectedLayer: null,
      selectedZoomKeyframe: null, nextZoomKeyframeId: 1, trackState: {video: {locked: false, visible: true, muted: false}},
      videoTracks: [{id: 1, name: 'Video 1'}], activeVideoTrack: 1, timelines: [], activeTimelineId: 'TL1',
      timelineRipple: false, timelineMagnet: false, zoom: 20, canvas: {width: 1920, height: 1080},
      manualId: 'original.mov', manualName: 'Original.mov', duration: 40},
    el: node, document: {activeElement: null, querySelector: () => null, createElement: () => makeNode('new'),
      addEventListener(name, callback) {documentEvents.set(name, callback);}},
    window: {addEventListener(name, callback) {windowEvents.set(name, callback);}, removeEventListener(name) {windowEvents.delete(name);}},
    crypto: {randomUUID: () => 'unique-' + (++serial)}, ResizeObserver: class {observe() {}},
    normalizeZoomEasing: value => value || 'linear', TRANSITION_NAMES: {fade: 'Fade'},
    hydrateImageLayer: item => item, resetLiveTransition() {}, stopProjectAudio() {}, pausePreview() {},
    currentOutputTime: () => c.cursor, seekOutputTime(time) {c.cursor = time;},
    setPreviewSource(index) {c.S.preview = index;}, setupThumbnailSource() {},
    drawClips() {c.normalizeVideoRipple(); c.paintTimelineVideoSelection();}, drawClipInspector() {},
    showTextProperties() {}, drawProjectLibrary() {}, restoreAssetSources() {}, updateCanvas() {}, updateZoomLabel() {},
    drawMagnetButton() {}, undoProjectAssetRemoval: () => false, scheduleAutosave() {saves++;},
    autoScrollTimelinePointer() {}, clearTimelineSnapGuide() {}, drawTimelineSnapGuide() {},
    videoTrackAtClientY: () => c.targetTrack, timelineTimeAtClientX: x => x / c.S.zoom,
    select(index) {c.S.selected = index;}, log() {}, ft: String,
    isTrackLocked: type => !!c.S.trackState[type]?.locked,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
    desktopClosing: false, desktopUpdateFrozen: false,
  });
  c.S.timelines = [{id: 'TL1'}]; c.cursor = 8; c.targetTrack = 1;
  vm.runInContext([
    line('const defaultTrackState='), between('    const clipSettings=', '    const imageLayerSettings='),
    line('const copyLayers='), line('const copyTrackState='),
    between('    const clipOutputDuration=', '    function isPreviewPlaying'),
    line('function ensureClipTimelinePositions('), line('const clipTimelineStart='), line('const clipTimelineEnd='), line('const outDuration='),
    between('    function newClipId()', '    const clipInputId='),
    line('function emptyTimelineState('), line('function captureTimelineState('), line('function applyTimelineState('),
    line('function remember(){'), line('function undoEdit(){'),
    tracks.slice(tracks.indexOf('/* Automatic video ripple')), tools,
  ].join('\n'), c);
  const syncNodes = () => {clipNodes = c.S.clips.map((item, index) => {const clip = makeNode('clip-' + item.clipId); clip.dataset.index = index; clip.closest = selector => selector === '#track .clip' ? clip : null; return clip;}); return clipNodes;};
  const pointer = (x, y = 50) => ({button: 0, clientX: x, clientY: y, preventDefault() {}, stopImmediatePropagation() {}});
  return {c, nodes, windowEvents, documentEvents, syncNodes, pointer, saves: () => saves};
}

function clip(id, time = 0, track = 1, duration = 2, extra = {}) {
  return {clipId: id, videoTrack: track, timelineStart: time, start: 4, end: 4 + duration,
    crop: {x: .1, y: .2, width: .7, height: .6}, zoomKeyframes: [{id: 'old-' + id, time: 1, scale: 150}],
    brushStrokes: [{points: [{x: .2, y: .3}]}], ...extra};
}

function setTracks(c, ids) {c.S.videoTracks = ids.map(id => ({id, name: 'Video ' + id, locked: false}));}

test('Ctrl/Cmd selection toggles independent IDs and switching to a timed layer suppresses stale video groups', () => {
  const {c, nodes, syncNodes} = fixture(); c.S.clips = [clip('A'), clip('B', 2)]; c.S.selected = 0;
  const buttons = syncNodes(), down = nodes.get('timeline').listeners.get('pointerdown');
  down({button: 0, ctrlKey: true, target: buttons[1], preventDefault() {}, stopImmediatePropagation() {}});
  assert.deepEqual(plain(c.S.selectedVideoClipIds), ['A', 'B']); assert.equal(c.S.selected, 1);
  assert.equal(buttons[0].attributes['aria-pressed'], 'true'); assert.equal(buttons[1].attributes['aria-pressed'], 'true');
  down({button: 0, metaKey: true, target: buttons[0], preventDefault() {}, stopImmediatePropagation() {}});
  assert.deepEqual(plain(c.S.selectedVideoClipIds), ['B']);
  c.S.selectedLayer = {type: 'image', id: 'image'}; assert.deepEqual(plain(c.selectedTimelineVideos()), []);
});

test('single selection follows the inspector while a multi-selection retains stable IDs after seek and reordering', () => {
  const {c} = fixture(), a = clip('A'), b = clip('B', 2), other = clip('X', 4);
  c.S.clips = [a, b, other]; c.S.selectedVideoClipIds = ['A']; c.S.selected = 1;
  assert.deepEqual(plain(c.selectedTimelineVideos().map(item => item.clipId)), ['B']);
  c.setTimelineVideoSelection([a, b], a); c.S.clips = [other, b, a]; c.S.selected = 0;
  assert.deepEqual(plain(c.selectedTimelineVideos().map(item => item.clipId)), ['B', 'A']);
  c.paintTimelineVideoSelection(); assert.deepEqual(plain(c.S.selectedVideoClipIds), ['A', 'B']);
  c.S.selectedVideoClipIds = ['removed']; c.S.selected = -1;
  assert.deepEqual(plain(c.selectedTimelineVideos()), []);
});

test('group copies preserve sources, offsets and internal transitions with fully independent fresh identities', () => {
  const {c} = fixture(), a = clip('A', 3, 1, 2, {fileId: 'a.mov', speed: 2, end: 8}), b = clip('B', 5, 1, 3), outsider = clip('X', 8);
  c.S.clips = [a, b, outsider]; c.S.transitions = [
    {leftClipId: 'A', rightClipId: 'B', type: 'fade', duration: .6},
    {leftClipId: 'B', rightClipId: 'X', type: 'fade', duration: .6}];
  c.setTimelineVideoSelection([a, b], a); assert.equal(c.timelineCopySelection(), true);
  a.crop.x = .5; a.zoomKeyframes[0].scale = 280; b.brushStrokes[0].points[0].x = .9;
  c.S.clips = []; c.S.transitions = []; c.S.manualId = 'another.mov'; c.cursor = 10;
  const pasted = c.timelinePasteClipboard(); assert.equal(pasted.length, 2);
  assert.deepEqual(plain(pasted.map(item => item.timelineStart)), [10, 12]);
  assert.equal(pasted[0].fileId, 'a.mov'); assert.equal(pasted[1].fileId, 'original.mov');
  assert.equal(pasted[1].src, '/video/original.mov'); assert.equal(pasted[0].start, 4); assert.equal(pasted[0].end, 8); assert.equal(pasted[0].speed, 2);
  assert.equal(pasted[0].crop.x, .1); assert.equal(pasted[0].zoomKeyframes[0].scale, 150); assert.equal(pasted[1].brushStrokes[0].points[0].x, .2);
  assert.ok(pasted.every(item => !['A', 'B'].includes(item.clipId))); assert.notEqual(pasted[0].zoomKeyframes[0].id, 'old-A');
  assert.equal(c.S.transitions.length, 1); assert.equal(c.S.transitions[0].leftClipId, pasted[0].clipId); assert.equal(c.S.transitions[0].rightClipId, pasted[1].clipId);
  assert.equal(c.S.transitions[0].suspended, false);
  pasted[0].crop.x = .8; c.cursor = 20; const again = c.timelinePasteClipboard();
  assert.equal(again[0].crop.x, .1); assert.notEqual(again[0].clipId, pasted[0].clipId); assert.notEqual(again[0].zoomKeyframes[0].id, pasted[0].zoomKeyframes[0].id);
});

test('group paste preserves relative time and empty lane slots using source ordinal layout, not sparse IDs', () => {
  const {c} = fixture(); setTracks(c, [1, 5, 7, 9]);
  const a = clip('A', 3, 1), b = clip('B', 7, 7); c.S.clips = [a, b]; c.setTimelineVideoSelection([a, b], a); c.timelineCopySelection();
  c.S.clips = []; setTracks(c, [1, 10, 20, 30, 40]); c.S.activeVideoTrack = 10; c.cursor = 8;
  const pasted = c.timelinePasteClipboard();
  assert.deepEqual(plain(pasted.map(item => item.videoTrack)), [10, 30]);
  assert.deepEqual(plain(pasted.map(item => item.timelineStart)), [8, 12]);
  assert.equal(c.S.videoTracks.length, 5); assert.ok(!c.S.clips.some(item => item.videoTrack === 20));
});

test('collision rejects paste until the user provides enough empty channels', () => {
  const {c} = fixture(); setTracks(c, [1, 2, 3]); const a = clip('A', 0), b = clip('B', 4, 3);
  c.S.clips = [a, b]; c.setTimelineVideoSelection([a, b], a); c.timelineCopySelection();
  const existing = clip('occupied', 0, 1, 30); c.S.clips = [existing]; c.cursor = 8;
  assert.equal(c.timelinePasteClipboard(),false);assert.equal(c.S.history.length,0);assert.equal(c.S.videoTracks.length,3);
  setTracks(c,[1,2,3,4,5,6]);c.S.activeVideoTrack=4;
  const pasted = c.timelinePasteClipboard();
  assert.deepEqual(plain(pasted.map(item => item.videoTrack)), [4, 6]); assert.equal(c.S.videoTracks.length, 6);
  assert.ok(!c.S.clips.some(item => item.videoTrack === 5)); assert.equal(existing.timelineStart, 0); assert.equal(existing.end, 34);
  assert.equal(c.S.history.length, 1);
});

test('locked destination rejects the entire paste without history, partial clips or lane creation', () => {
  const {c} = fixture(); setTracks(c, [1, 2, 3]); const a = clip('A'), b = clip('B', 4, 3);
  c.S.clips = [a, b]; c.setTimelineVideoSelection([a, b], a); c.timelineCopySelection();
  c.S.clips = []; c.S.videoTracks[2].locked = true; const before = plain(c.S);
  assert.equal(c.timelinePasteClipboard(), false); assert.deepEqual(plain(c.S), before);
});

test('locked group deletion is atomic, successful deletion removes only owned transitions and undo restores all IDs', () => {
  const {c} = fixture(); setTracks(c, [1, 2]); const a = clip('A'), b = clip('B', 2, 2), survivor = clip('X', 8);
  c.S.clips = [a, b, survivor]; c.S.transitions = [{leftClipId: 'A', rightClipId: 'X', type: 'fade'}];
  c.setTimelineVideoSelection([a, b], a); c.S.videoTracks[1].locked = true; c.ensureVideoTracks(); const before = plain(c.S);
  assert.equal(c.deleteTimelineVideoSelection(), false); assert.deepEqual(plain(c.S), before);
  c.S.videoTracks[1].locked = false; assert.equal(c.deleteTimelineVideoSelection(), true);
  assert.deepEqual(plain(c.S.clips.map(item => item.clipId)), ['X']); assert.equal(c.S.transitions.length, 0); assert.equal(c.S.selected, -1);
  c.undoEdit(); assert.deepEqual(plain(c.S.selectedVideoClipIds), ['A', 'B']); assert.deepEqual(plain(c.S.clips.map(item => item.clipId)), ['A', 'B', 'X']);
});

test('group drag preserves temporal and ordinal lane gaps and remembers exactly once', () => {
  const {c, syncNodes, pointer, windowEvents} = fixture(); setTracks(c, [1, 5, 7, 9]);
  const a = clip('A', 2, 1), b = clip('B', 6, 7); c.S.clips = [a, b]; c.setTimelineVideoSelection([a, b], a); const buttons = syncNodes();
  c.targetTrack = 5; c.beginTimelineVideoGroupDrag(pointer(100), a, buttons[0]);
  windowEvents.get('pointermove')(pointer(160)); windowEvents.get('pointerup')(pointer(160));
  assert.equal(a.timelineStart, 5); assert.equal(b.timelineStart, 9); assert.equal(a.videoTrack, 5); assert.equal(b.videoTrack, 9);
  assert.equal(c.S.history.length, 1); assert.deepEqual(plain(c.S.selectedVideoClipIds), ['A', 'B']);
});

test('a plain click collapses a locked group but dragging any locked member remains atomic and inert', () => {
  for (const drag of [false, true]) {
    const {c, syncNodes, pointer, windowEvents} = fixture(); setTracks(c, [1, 2]);
    const a = clip('A', 2, 1), b = clip('B', 6, 2); c.S.clips = [a, b];
    c.S.videoTracks[1].locked = true; c.setTimelineVideoSelection([a, b], a); const buttons = syncNodes();
    c.beginTimelineVideoGroupDrag(pointer(140), b, buttons[1]);
    if (drag) windowEvents.get('pointermove')(pointer(200));
    windowEvents.get('pointerup')(pointer(drag ? 200 : 140));
    assert.deepEqual([a.timelineStart, b.timelineStart, a.videoTrack, b.videoTrack], [2, 6, 1, 2]);
    assert.equal(c.S.history.length, 0); assert.equal(c.S.videoTracks.length, 2);
    assert.deepEqual(plain(c.S.selectedVideoClipIds), drag ? ['A', 'B'] : ['B']);
    assert.equal(c.S.selected, drag ? 0 : 1); assert.equal(c.cursor, drag ? 8 : 7);
    for (const name of ['pointermove', 'pointerup', 'pointercancel', 'keydown']) assert.equal(windowEvents.has(name), false);
  }
});

test('colliding group drag restores the layout without creating channels or history', () => {
  const {c, syncNodes, pointer, windowEvents} = fixture(); setTracks(c, [1, 5, 7]);
  const a = clip('A', 2, 1), b = clip('B', 6, 7), blocker = clip('BLOCK', 12, 1, 20);
  c.S.clips = [a, b, blocker]; c.setTimelineVideoSelection([a, b], a); const buttons = syncNodes();
  c.beginTimelineVideoGroupDrag(pointer(100), a, buttons[0]); windowEvents.get('pointermove')(pointer(300)); windowEvents.get('pointerup')(pointer(300));
  assert.deepEqual([a.timelineStart, b.timelineStart, a.videoTrack, b.videoTrack], [2, 6, 1, 7]);
  assert.equal(c.S.videoTracks.length, 3);
  assert.equal(blocker.timelineStart, 12); assert.equal(blocker.videoTrack, 1); assert.equal(c.S.history.length, 0);
});

test('cancelled or locked-target group drag restores all clip positions and leaves no undo entry', () => {
  for (const cancel of [true, false]) {
    const {c, syncNodes, pointer, windowEvents} = fixture(); setTracks(c, [1, 2, 3, 4]);
    const a = clip('A', 2, 1), b = clip('B', 6, 3); c.S.clips = [a, b]; c.setTimelineVideoSelection([a, b], a); const buttons = syncNodes();
    c.targetTrack = 2; if (!cancel) c.S.videoTracks[3].locked = true;
    c.beginTimelineVideoGroupDrag(pointer(100), a, buttons[0]); windowEvents.get('pointermove')(pointer(160));
    windowEvents.get(cancel ? 'pointercancel' : 'pointerup')(pointer(160));
    assert.deepEqual([a.timelineStart, b.timelineStart, a.videoTrack, b.videoTrack], [2, 6, 1, 3]); assert.equal(c.S.history.length, 0);
  }
});

test('Escape, pointer cancellation and locked drops preserve the complete fifty-entry history', () => {
  for (const cancel of ['escape', 'pointercancel', 'locked']) {
    const {c, syncNodes, pointer, windowEvents} = fixture(); setTracks(c, [1, 2, 3, 4]);
    const a = clip('A', 2, 1), b = clip('B', 6, 3); c.S.clips = [a, b]; c.setTimelineVideoSelection([a, b], a);
    const history = Array.from({length: 50}, (_, index) => ({sentinel: index, clips: [{clipId: 'history-' + index}]}));
    c.S.history = [...history]; const before = plain(c.S.history), buttons = syncNodes(); c.targetTrack = 2;
    if (cancel === 'locked') c.S.videoTracks[3].locked = true;
    c.beginTimelineVideoGroupDrag(pointer(100), a, buttons[0]); windowEvents.get('pointermove')(pointer(160));
    assert.equal(c.S.history.length, 50); assert.notDeepEqual(plain(c.S.history), before);
    if (cancel === 'escape') windowEvents.get('keydown')({key: 'Escape', preventDefault() {}, stopImmediatePropagation() {}});
    else windowEvents.get(cancel === 'locked' ? 'pointerup' : 'pointercancel')(pointer(160));
    assert.deepEqual(plain(c.S.history), before); assert.equal(c.S.history[0], history[0]);
    assert.deepEqual([a.timelineStart, b.timelineStart, a.videoTrack, b.videoTrack], [2, 6, 1, 3]);
    assert.deepEqual(plain(c.S.selectedVideoClipIds), ['A', 'B']);
    for (const name of ['pointermove', 'pointerup', 'pointercancel', 'keydown']) assert.equal(windowEvents.has(name), false, name + ' cleaned up');
  }
});

test('project capture persists ripple but not transient group selection; apply clears groups and undo retains them', () => {
  const {c} = fixture(); c.S.clips = [clip('A', 0), clip('B', 2)]; c.S.timelineRipple = true;
  c.setTimelineVideoSelection(c.S.clips, c.S.clips[0]);
  const saved = c.captureTimelineState(); assert.equal(saved.timelineRipple, true); assert.equal(Object.hasOwn(saved, 'selectedVideoClipIds'), false);
  c.remember(); c.S.timelineRipple = false; c.S.selectedVideoClipIds = []; c.undoEdit();
  assert.equal(c.S.timelineRipple, true); assert.deepEqual(plain(c.S.selectedVideoClipIds), ['A', 'B']);
  c.applyTimelineState({...saved, selectedVideoClipIds: ['stale']});
  assert.equal(c.S.timelineRipple, true); assert.deepEqual(plain(c.S.selectedVideoClipIds), []);
  c.applyTimelineState({...saved, timelineRipple: undefined}); assert.equal(c.S.timelineRipple, false);
});

test('select-all only handles timeline focus and never intercepts text editors or other parts of the page', () => {
  const {c, nodes, documentEvents} = fixture(); c.S.clips = [clip('A'), clip('B', 3)];
  let consumed = 0;
  const event = {ctrlKey: true, key: 'a', preventDefault() {consumed++;}, stopImmediatePropagation() {}};
  for (const focused of [{tagName: 'INPUT'}, {tagName: 'TEXTAREA'}, {isContentEditable: true}, {tagName: 'DIV'}]) {
    c.document.activeElement = focused; documentEvents.get('keydown')(event);
  }
  assert.equal(consumed, 0); assert.deepEqual(plain(c.S.selectedVideoClipIds), []);
  c.document.activeElement = nodes.get('timeline'); documentEvents.get('keydown')(event);
  assert.equal(consumed, 1); assert.deepEqual(plain(c.S.selectedVideoClipIds), ['A', 'B']);
});
