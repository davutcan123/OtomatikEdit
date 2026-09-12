const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const html = process.env.TRANSITION_BASELINE ? execFileSync('git', ['show', 'HEAD:templates/index.html'], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function between(first, next) {
  const start = script.indexOf(first), end = script.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, `Production function markers: ${first} / ${next}`);
  return script.slice(start, end);
}
const line = marker => script.split('\n').find(value => value.includes(marker));
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const nodes = new Map(), listeners = new Map(), frames = new Map();let scheduled = 0, nextFrame = 1, context;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', style: {}, children: [], offsetHeight: 104, scrollLeft: 0, scrollWidth: 2000, clientWidth: 1000,
      classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, pause() {}, load() {},
      getBoundingClientRect: () => ({ left: 0, right: 1000 }), appendChild(child) { this.children.push(child); },
      set innerHTML(_) { this.children = []; }, get innerHTML() { return ''; } });
    return nodes.get(id);
  }
  const state = { clips: [], transitions: [], selected: 0, preview: 0, duration: 30, manualId: 'fixture.mp4', manualName: 'Fixture', history: [],
    texts: [], stickers: [], imageLayers: [], audioLayers: [], mediaAssets: [], selectedText: null, selectedSticker: null, selectedLayer: null,
    nextZoomKeyframeId: 1, nextTextId: 1, nextStickerId: 1, nextLayerId: 1, zoom: 14, timelineMagnet: false,
    canvas: { width: 1920, height: 1080 }, timelines: [{ id: 'TL1', name: 'Test', state: {} }], activeTimelineId: 'TL1', nextTimelineId: 2,
  };
  context = vm.createContext({ S: state, el: node, mv: { paused: true, pause() {} },
    document: { querySelector: () => null, querySelectorAll: () => state.clips.map(clip => ({ offsetLeft: (clip.timelineStart || 0) * 14, offsetWidth: 138 })), createElement: () => ({ style: {}, dataset: {} }) },
    window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
    requestAnimationFrame: callback => { const id = nextFrame++;frames.set(id, callback);return id; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: () => 1, normalizeZoomEasing: value => value || 'smoother',
    isTrackLocked: () => false, resetLiveTransition() {}, stopProjectAudio() {}, restoreAutoCutterState() {}, captureAutoCutterState: () => null,
    setupThumbnailSource() {}, setPreviewSource() {}, updateCanvas() {}, updateZoomLabel() {}, drawMagnetButton() {},
    showTextProperties() {}, drawProjectLibrary() {}, drawTimelineTabs() {}, applyVideoEffectPreview() {}, drawClipInspector() {}, invalidateBrush() {},
    scheduleAutosave: () => scheduled++, log() {}, ft: String, currentOutputTime: () => context.outputTime || 0,
    seekOutputTime() {}, drawClips: () => context.drawTransitions(),
    normalizedZoomKeyframes: clip => clip.zoomKeyframes || [], zoomStateAtRelativeTime: () => ({ scale: 100, x: 50, y: 50, opacity: 100 }),
  });
  vm.runInContext([
    line('const defaultTrackState='), line('const TRANSITION_NAMES='),
    between('    const clipSettings=', '    const hydrateText='),
    between('    const hydrateText=', '    const imageLayerSettings='),
    line('const copyLayers='), line('const copyTrackState='),
    between('    const clipOutputDuration=', '    const ft='),
    script.includes('    function newClipId') ? between('    function newClipId', '    const clipInputId=') : line('function clampClipTransitions'),
    line('function remember(){'), line('const selectedClip='), line('function updateClipSetting('),
    between('    function drawTransitions(){', '    function beginTransitionDrag'),
    between('    function splitVideoTarget', '    function splitSelected'), line('function removeClip(){'), line('function move(n){'),
    line('function snapClipPosition('), line('function fitClipPosition('),
    between('    function beginClipDrag(', '    function setPreviewSource('),
    between('    function addProjectAssetAt(', '    function layerSelected('),
    line('function emptyTimelineState('), line('function captureTimelineState('), line('function syncActiveTimeline('),
    line('function portableMediaItem('), line('function portableTimelineState('), line('function restoreAssetSources('),
    line('function applyTimelineState('), line('function projectPayload('), line('function restoreProject('),
  ].join('\n'), context);
  state.trackState = vm.runInContext('defaultTrackState()', context);
  state.clips = [{ start: 0, end: 10, timelineStart: 0, fileId: 'fixture.mp4', sourceDuration: 30 },
    { start: 10, end: 20, timelineStart: 10, fileId: 'fixture.mp4', sourceDuration: 30 },
    { start: 20, end: 30, timelineStart: 20, fileId: 'fixture.mp4', sourceDuration: 30 }];
  context.drawTransitions();
  return { c: context, state, node, listeners, scheduled: () => scheduled, tick: () => { const [id, callback] = frames.entries().next().value;frames.delete(id);callback(); } };
}

test('adding and removing a transition explicitly schedules post-mutation recovery', () => {
  const f = fixture(), before = f.scheduled();
  f.c.applyTransition('fade', 0);
  assert.equal(f.state.transitions.length, 1);assert.ok(f.scheduled() > before);
  const afterAdd = f.scheduled();
  f.node('transition-layer').children[0].onclick();
  assert.equal(f.state.transitions.length, 0);assert.ok(f.scheduled() > afterAdd);
});

test('moving an unrelated clip preserves the transition and rebinds its boundary index', () => {
  const { c, state } = fixture();c.applyTransition('fade', 0);
  const ids = [state.clips[0].clipId, state.clips[1].clipId];
  state.selected = 2;c.move(-1);
  assert.equal(state.transitions.length, 1);
  assert.deepEqual([state.transitions[0].leftClipId, state.transitions[0].rightClipId], ids);
  assert.equal(state.transitions[0].suspended, true);
  // Moving back reattaches the same effect; no manual re-application required.
  c.move(1);assert.equal(state.transitions[0].suspended, false);assert.equal(state.transitions[0].boundary, 0);
});

test('free drag does not erase unrelated or temporarily separated transitions', () => {
  const f = fixture();f.c.applyTransition('fade', 0);
  const event = { button: 0, clientX: 350, preventDefault() {} }, button = { style: {}, classList: { add() {}, remove() {} } };
  f.c.beginClipDrag(event, 2, button);
  f.listeners.get('pointermove')({ clientX: 490, preventDefault() {} });f.tick();f.listeners.get('pointerup')();
  assert.equal(f.state.transitions.length, 1);assert.equal(f.state.transitions[0].suspended, false);
  assert.equal(f.state.clips[2].timelineStart, 30);
});

test('speed and trim suspend rather than delete a pair; restoring duration restores the requested effect', () => {
  const f = fixture();f.c.applyTransition('fade', 0);const original = f.state.transitions[0].duration;
  f.c.updateClipSetting('speed', 2, false);
  assert.equal(f.state.transitions.length, 1);assert.equal(f.state.transitions[0].suspended, true);
  assert.deepEqual(plain(f.c.exportableTransitions()), []);
  f.c.updateClipSetting('speed', 1, false);
  assert.equal(f.state.transitions[0].suspended, false);assert.equal(f.state.transitions[0].duration, original);
  f.c.beginTimedTrim({ button: 0, clientX: 0, preventDefault() {}, stopPropagation() {} }, 'video', 0, 'right', { style: {} });
  f.listeners.get('pointermove')({ clientX: -28, preventDefault() {} });f.listeners.get('pointerup')();
  assert.equal(f.state.transitions.length, 1);assert.equal(f.state.transitions[0].suspended, true);
  f.state.clips[0].end = 10;f.c.clampClipTransitions();assert.equal(f.state.transitions[0].suspended, false);
});

test('color, opacity, sound and animation settings do not remove transition ownership', () => {
  const f = fixture();f.c.applyTransition('dissolve', 0);const pair = plain(f.state.transitions[0]);
  for (const [key, value] of [['brightness', 135], ['opacity', 60], ['volume', 170], ['animation', 'fadein']]) {
    f.state.selected = 2;f.c.updateClipSetting(key, value, true);
    assert.deepEqual(plain(f.state.transitions[0]), pair);
  }
});

test('splitting either side retains the effect on the original cut, not on the new cut', () => {
  for (const splitAt of [0, 1]) {
    const { c, state } = fixture();c.applyTransition('fade', 0);
    state.selected = splitAt;c.outputTime = splitAt === 0 ? 5 : 15;c.splitClip();
    assert.equal(new Set(state.clips.map(clip => clip.clipId)).size, 4);
    assert.equal(state.transitions.length, 1);const boundary = splitAt === 0 ? 1 : 0;
    assert.equal(state.transitions[0].boundary, boundary);
    assert.equal(state.transitions[0].leftClipId, state.clips[boundary].clipId);
    assert.equal(state.transitions[0].rightClipId, state.clips[boundary + 1].clipId);
    assert.equal(state.transitions[0].suspended, false);
  }
});

test('inserting video and deleting unrelated clips keep surviving cut ownership', () => {
  const { c, state } = fixture();c.applyTransition('fade', 1);const pair = plain(state.transitions[0]);
  c.addProjectAssetAt({ fileId: 'another.mp4', src: '/video/another.mp4', name: 'Another', kind: 'video', duration: 3 }, 35);
  assert.equal(state.transitions.length, 1);assert.equal(state.transitions[0].leftClipId, pair.leftClipId);
  state.selected = 0;c.removeClip();assert.equal(state.transitions[0].boundary, 0);
  state.selected = 0;c.removeClip();assert.equal(state.transitions.length, 0);
});

test('legacy boundary-only projects gain durable IDs and preserve active and suspended pairs through JSON restoration', () => {
  const { c, state } = fixture();
  state.transitions = [{ boundary: 0, type: 'fade', duration: .8 }, { boundary: 1, type: 'dissolve', duration: .6 }];
  c.clampClipTransitions();state.selected = 0;c.updateClipSetting('speed', 2, false);
  const serialized = JSON.stringify(c.projectPayload()), saved = JSON.parse(serialized);
  assert.ok(saved.timelines[0].state.clips.every(clip => typeof clip.clipId === 'string'));
  const second = fixture();second.c.restoreProject(JSON.parse(serialized));
  assert.deepEqual(plain(second.state.transitions), plain(state.transitions));
  assert.equal(second.state.transitions[0].suspended, true);
  assert.equal(second.state.transitions[1].suspended, false);
  assert.deepEqual(plain(second.c.exportableTransitions()), [{ boundary: 1, type: 'dissolve', duration: .6 }]);
  second.state.selected = 0;second.c.updateClipSetting('speed', 1, false);
  assert.equal(second.c.exportableTransitions().length, 2);
  assert.deepEqual(plain(second.state.clips.map(clip => clip.clipId)), saved.timelines[0].state.clips.map(clip => clip.clipId));
});

test('legacy missing/null positions migrate sequentially and copied clip IDs stay independent', () => {
  const { c, state } = fixture();delete state.clips[0].timelineStart;state.clips[1].timelineStart = null;delete state.clips[2].timelineStart;
  state.transitions = [{ boundary: 0, type: 'fade', duration: 1 }];c.clampClipTransitions();
  assert.deepEqual(state.clips.map(clip => clip.timelineStart), [0, 10, 20]);assert.equal(state.transitions[0].suspended, false);
  state.clips[2].clipId = state.clips[0].clipId;c.ensureClipIdentities();
  assert.equal(new Set(state.clips.map(clip => clip.clipId)).size, 3);
});

test('locked video track rejects transition and clip edits', () => {
  const { c, state } = fixture();c.isTrackLocked = () => true;c.applyTransition('fade', 0);c.move(1);
  assert.equal(state.transitions.length, 0);assert.equal(state.clips[0].start, 0);
});
