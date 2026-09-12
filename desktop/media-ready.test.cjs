'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForMedia } = require('./media-ready.cjs');
function video(state = 1, seeking = false) {
  return Object.assign(new EventTarget(), { readyState: state, seeking, error: null });
}
test('a previously loaded video becomes ready after a restore seek without a second loadeddata', async () => {
  const media = video(1, true), pending = waitForMedia(media);
  media.readyState = 4;
  media.dispatchEvent(new Event('canplay'));
  let completed = false;
  pending.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  media.seeking = false;
  media.dispatchEvent(new Event('seeked'));
  await pending;
  assert.equal(completed, true);
});
test('already ready and newly loaded media both resolve', async () => {
  await waitForMedia(video(4));
  const media = video(), pending = waitForMedia(media);
  media.readyState = 2;
  media.dispatchEvent(new Event('loadeddata'));
  await pending;
});
test('decode errors and genuinely unready media still fail', async () => {
  const media = video(), pending = waitForMedia(media);
  media.error = { message: 'Unsupported codec' };
  media.dispatchEvent(new Event('error'));
  await assert.rejects(pending, /Unsupported codec/);
  await assert.rejects(waitForMedia(video(), 5), /Video load timeout/);
});
