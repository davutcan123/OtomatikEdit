const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/video_tracks.js'), 'utf8');
const ripple = source.slice(source.indexOf('/* Automatic video ripple'));
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const nodes = new Map(), history = [];
  const makeNode = () => ({attributes: {}, classList: {toggle(name, value) {this[name] = value;}},
    setAttribute(name, value) {this.attributes[name] = value;}, after(node) {this.next = node; nodes.set(node.id, node);}});
  nodes.set('timeline-magnet', makeNode());
  const c = vm.createContext({
    S: {clips: [], videoTracks: [{id: 1}, {id: 2}, {id: 3, locked: true}], selected: -1, preview: -1,
      timelineRipple: false, timelineMagnet: true, texts: [{id: 'text', start: 15, end: 18}],
      imageLayers: [{id: 'image', start: 11, end: 14}], audioLayers: [{id: 'audio', start: 8, end: 12}],
      stickers: [{id: 'sticker', start: 9, end: 11}], transitions: []},
    el: id => nodes.get(id), document: {createElement: makeNode},
    clipOutputDuration: clip => (clip.end - clip.start) / (clip.speed || 1),
    clipTimelineStart: clip => clip.timelineStart || 0,
    clipTimelineEnd: clip => (clip.timelineStart || 0) + (clip.end - clip.start) / (clip.speed || 1),
    isVideoTrackLocked: item => !!c.S.videoTracks.find(track => track.id === (typeof item === 'object' ? item.videoTrack || 1 : item))?.locked,
    clampClipTransitions() {
      c.clamps++;
      for (const transition of c.S.transitions) {
        const left = c.S.clips.find(clip => clip.clipId === transition.leftClipId);
        const right = c.S.clips.find(clip => clip.clipId === transition.rightClipId);
        const peers = c.S.clips.filter(clip => clip.videoTrack === left?.videoTrack)
          .sort((a, b) => c.clipTimelineStart(a) - c.clipTimelineStart(b));
        transition.suspended = !left || !right || peers[peers.indexOf(left) + 1] !== right
          || Math.abs(c.clipTimelineEnd(left) - c.clipTimelineStart(right)) > .03;
      }
    },
    currentOutputTime: () => c.cursor, outDuration: () => Math.max(0, ...c.S.clips.map(c.clipTimelineEnd), 18),
    pausePreview() {c.pauses++;}, remember() {history.push(plain(c.S));},
    drawClips() {c.draws++; c.normalizeVideoRipple();},
    seekOutputTime(value) {c.cursor = value;}, scheduleAutosave() {c.saves++;}, log() {},
    desktopUpdateFrozen: false, desktopClosing: false,
  });
  c.cursor = c.pauses = c.draws = c.saves = c.clamps = 0;
  vm.runInContext(ripple, c);
  return {c, nodes, history};
}

function clip(clipId, timelineStart, duration, videoTrack = 1, extra = {}) {
  return {clipId, timelineStart, start: 4, end: 4 + duration, videoTrack, ...extra};
}

test('ripple defaults off, creates an accessible separate button next to the unchanged magnet', () => {
  const {c, nodes, history} = fixture();
  c.S.clips = [clip('A', 10, 3)];
  assert.equal(c.normalizeVideoRipple(), false); assert.equal(c.S.clips[0].timelineStart, 10);
  const button = nodes.get('timeline-ripple');
  assert.equal(nodes.get('timeline-magnet').next, button);
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.ok(button.textContent.includes('Boşlukları kapat: kapalı'));
  assert.ok(button.title.includes('Mıknatıs hizalamasından bağımsız'));
  assert.equal(c.S.timelineMagnet, true); assert.equal(history.length, 0);
});

test('enable compacts each unlocked channel from zero and preserves sources, layers and selected identities', () => {
  const {c, nodes, history} = fixture();
  const a = clip('A', 4, 4, 1, {speed: 2, crop: {x: .2}, effect: 'neon', zoomKeyframes: [{time: 1, scale: 150}]}),
    b = clip('B', 10, 3), d = clip('D', 8, 2, 2), locked = clip('LOCKED', 9, 5, 3);
  c.S.clips = [b, locked, a, d]; c.S.selected = c.S.preview = 0; c.cursor = 11;
  const nested = a.zoomKeyframes, immutable = plain({...c.S, clips: undefined});
  nodes.get('timeline-ripple').onclick();
  assert.equal(a.timelineStart, 0); assert.equal(b.timelineStart, 2); assert.equal(d.timelineStart, 0); assert.equal(locked.timelineStart, 9);
  assert.equal(a.zoomKeyframes, nested); assert.equal(a.start, 4); assert.equal(a.end, 8); assert.equal(a.speed, 2);
  assert.equal(c.S.clips[c.S.selected], b); assert.equal(c.S.clips[c.S.preview], b); assert.equal(c.cursor, 3);
  for (const field of ['texts', 'imageLayers', 'audioLayers', 'stickers']) assert.deepEqual(plain(c.S[field]), immutable[field]);
  assert.equal(history.length, 1); assert.equal(history[0].timelineRipple, false); assert.equal(history[0].clips[0].timelineStart, 10);
  assert.equal(c.pauses, 1); assert.equal(c.saves, 1); assert.equal(c.S.timelineMagnet, true);
  assert.equal(nodes.get('timeline-ripple').attributes['aria-pressed'], 'true');
});

test('disable keeps compacted positions and permits new free gaps without changing magnet state', () => {
  const {c, history} = fixture(); c.S.clips = [clip('A', 4, 2), clip('B', 9, 3)];
  c.toggleVideoRipple(); c.toggleVideoRipple();
  assert.equal(c.S.timelineRipple, false); assert.deepEqual(c.S.clips.map(item => item.timelineStart), [0, 2]);
  c.S.clips[1].timelineStart = 23.125; assert.equal(c.normalizeVideoRipple(), false);
  assert.equal(c.S.clips[1].timelineStart, 23.125); assert.equal(c.S.timelineMagnet, true); assert.equal(history.length, 2);
});

test('delete, trim, split and append normalization is idempotent and creates no extra undo entries', () => {
  const {c, history} = fixture(); c.S.timelineRipple = true;
  const a = clip('A', 0, 2), b = clip('B', 2, 3), last = clip('C', 5, 4);
  c.S.clips = [a, b, last]; c.S.selected = c.S.preview = 2;
  c.S.clips.splice(1, 1); c.normalizeVideoRipple(); assert.equal(last.timelineStart, 2);
  a.end -= 1; c.normalizeVideoRipple(); assert.equal(last.timelineStart, 1);
  last.end -= 2; const split = clip('SPLIT', 3, 2), appended = clip('NEW', 100, 2); c.S.clips.push(split, appended);
  c.normalizeVideoRipple(); assert.deepEqual(c.S.clips.map(item => item.timelineStart), [0, 1, 3, 5]);
  assert.equal(c.normalizeVideoRipple(), false); assert.equal(history.length, 0);
});

test('drag reorders at a nearest compact boundary with no overlapping clips or surprise lane', () => {
  const {c, history} = fixture(); c.S.timelineRipple = true;
  const a = clip('A', 0, 2), b = clip('B', 2, 3), last = clip('C', 5, 4);
  c.S.clips = [a, b, last]; c.S.selected = c.S.preview = 0;
  assert.equal(c.commitRippleMove(a, 1, 100), 7);
  assert.deepEqual(c.S.clips.map(item => item.clipId), ['B', 'C', 'A']);
  assert.deepEqual(c.S.clips.map(item => item.timelineStart), [0, 3, 7]);
  assert.equal(c.S.clips[c.S.selected], a); assert.equal(c.S.clips[c.S.preview], a);
  assert.equal(c.commitRippleMove(a, 1, 0), 0);
  assert.deepEqual(c.S.clips.map(item => item.clipId), ['A', 'B', 'C']);
  assert.equal(c.S.videoTracks.length, 3); assert.equal(history.length, 0);
});

test('cross-channel moves close the source gap and insert in target order; locked or invalid moves are inert', () => {
  const {c} = fixture(); c.S.timelineRipple = true;
  const a = clip('A', 0, 2), b = clip('B', 2, 3), last = clip('C', 5, 4), d = clip('D', 0, 1, 2), e = clip('E', 1, 2, 2), locked = clip('L', 9, 3, 3);
  c.S.clips = [a, b, last, d, e, locked];
  assert.equal(c.commitRippleMove(b, 2, 1.1), 1); assert.equal(b.videoTrack, 2); assert.equal(last.timelineStart, 2); assert.equal(e.timelineStart, 4);
  for (const [item, track, time] of [[a, 3, 0], [locked, 1, 0], [a, 20, 0], [a, 1, NaN]]) {
    const before = plain(c.S); assert.equal(c.commitRippleMove(item, track, time), false); assert.deepEqual(plain(c.S), before);
  }
  assert.equal(locked.timelineStart, 9);
});

test('identity-paired transitions reactivate when gaps close and suspend on changed adjacency without loss', () => {
  const {c} = fixture(); c.S.timelineRipple = true;
  const a = clip('A', 3, 2), b = clip('B', 9, 3), last = clip('C', 14, 4);
  c.S.clips = [a, b, last]; c.S.transitions = [{leftClipId: 'A', rightClipId: 'B', type: 'fade', requestedDuration: .8, suspended: true}];
  c.normalizeVideoRipple(); assert.equal(c.S.transitions[0].suspended, false);
  c.commitRippleMove(last, 1, 2); assert.equal(c.S.transitions[0].suspended, true);
  c.commitRippleMove(last, 1, 100); assert.equal(c.S.transitions[0].suspended, false);
  assert.equal(c.S.transitions.length, 1); assert.equal(c.S.transitions[0].requestedDuration, .8);
});

test('undo restores mode before normalization so enabling does not destroy restored gaps', () => {
  const {c, history} = fixture(); c.S.clips = [clip('A', 4, 2), clip('B', 10, 3)];
  c.toggleVideoRipple(); c.S = plain(history[0]);
  assert.equal(c.normalizeVideoRipple(), false); assert.deepEqual(c.S.clips.map(item => item.timelineStart), [4, 10]);
  assert.equal(history.length, 1);
  c.desktopUpdateFrozen = true; const before = plain(c.S);
  assert.equal(c.toggleVideoRipple(), false); assert.deepEqual(plain(c.S), before); assert.equal(history.length, 1);
});
