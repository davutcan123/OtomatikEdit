'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function between(first, next) {
  const start = script.indexOf(first), end = script.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, `Missing source boundary: ${first}`);
  return script.slice(start, end);
}
function context() {
  function element() {
    return { style: {}, dataset: {}, children: [], classList: { add() {} },
      set innerHTML(value) { this.markup = value; this.children = []; },
      appendChild(node) { this.children.push(node); }, querySelector() { return null; } };
  }
  const nodes = new Map(), listeners = new Map();
  const c = vm.createContext({ S: { zoom: 14, stickers: [{ id: 'S1', preset: 'star', name: 'Yıldız', start: 5, end: 8, x: 50, y: 50, scale: 18 }], selectedSticker: 'S1', trackState: { sticker: { visible: true } } },
    document: { createElement: element }, el: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    outDuration: () => 30, currentOutputTime: () => c.time, STICKER_PRESETS: { star: { symbol: '★' } },
    ft: value => Number(value).toFixed(2), escapeHtml: String, appendTrimHandles() {}, isTrackLocked: () => false,
    appendTransformHandles() {}, stickerMarkup: item => item.preset, remember() {}, drawClips() {}, showTextProperties() {}, log() {},
    window: { addEventListener: (name, cb) => listeners.set(name, cb), removeEventListener: name => listeners.delete(name) }, setTimeout() {},
  });
  // Include the shared sticker geometry helper when present, as well as the
  // production drawing/trim functions, rather than duplicating their logic.
  const start = script.includes('    function paintStickerClipTiming') ? '    function paintStickerClipTiming' : '    function drawStickerTimeline';
  vm.runInContext(between(start, '    function beginStickerClipDrag') + between('    function drawStickerOverlay', '    function beginStickerPresetDrag') + between('    function beginTimedTrim', '    function setPreviewSource'), c);
  return { c, nodes, listeners };
}

test('sticker timeline width matches its true duration at every zoom, without a false minimum span', () => {
  const { c, nodes } = context();
  for (const zoom of [.02, .5, 8, 14, 80]) {
    c.S.zoom = zoom;
    c.drawStickerTimeline();
    const clip = nodes.get('sticker-track').children[0];
    assert.equal(parseFloat(clip.style.left), 5 * zoom);
    assert.equal(parseFloat(clip.style.width), 3 * zoom);
  }
});

test('extending and shortening a sticker updates both the timeline edge and preview lifetime', () => {
  const { c, nodes, listeners } = context();
  c.drawStickerTimeline();
  const clip = nodes.get('sticker-track').children[0];
  const pointer = x => ({ button: 0, clientX: x, preventDefault() {}, stopPropagation() {} });
  c.beginTimedTrim(pointer(112), 'sticker', 'S1', 'right', clip);
  listeners.get('pointermove')(pointer(210)); // Add 7 seconds: [5, 8] -> [5, 15].
  listeners.get('pointerup')();
  assert.equal(c.S.stickers[0].end, 15);
  assert.equal(parseFloat(clip.style.width), 140);
  for (const time of [5, 7.5, 10, 14.99]) {
    c.time = time; c.drawStickerOverlay();
    assert.equal(nodes.get('sticker-overlay').children.length, 1, `Missing sticker at ${time}`);
  }
  for (const time of [4.99, 15.01]) {
    c.time = time; c.drawStickerOverlay();
    assert.equal(nodes.get('sticker-overlay').children.length, 0);
  }
  c.beginTimedTrim(pointer(210), 'sticker', 'S1', 'right', clip);
  listeners.get('pointermove')(pointer(98)); // [5, 15] -> [5, 7].
  listeners.get('pointerup')();
  assert.equal(c.S.stickers[0].end, 7);
  assert.equal(parseFloat(clip.style.width), 28);
  c.time = 7.1; c.drawStickerOverlay();
  assert.equal(nodes.get('sticker-overlay').children.length, 0);
});

test('overlapping stickers keep independent start/end times and track visibility', () => {
  const { c, nodes } = context();
  c.S.stickers.push({ ...c.S.stickers[0], id: 'S2', preset: 'heart', start: 7, end: 17 });
  for (const [time, ids] of [[4, []], [6, ['S1']], [7.5, ['S1', 'S2']], [12, ['S2']], [17.1, []]]) {
    c.time = time; c.drawStickerOverlay();
    assert.deepEqual(nodes.get('sticker-overlay').children.map(node => node.dataset.stickerId), ids);
  }
  c.time = 12; c.S.trackState.sticker.visible = false; c.drawStickerOverlay();
  assert.equal(nodes.get('sticker-overlay').children.length, 0);
});
