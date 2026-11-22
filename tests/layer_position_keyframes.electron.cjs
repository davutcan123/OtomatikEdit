'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { withStudioBrowser } = require('./support/studio_backend.cjs');

const layers = [
  { type: 'sticker', collection: 'stickers', field: 'sticker-id', overlay: 'sticker-overlay', marker: '[data-sticker-kf]',
    item: { id: 'S1', preset: 'heart', name: 'Kalp', start: 1, end: 4, x: 16, y: 18, scale: 12, rotation: 0 } },
  { type: 'text', collection: 'texts', field: 'text-id', overlay: 'text-overlay', marker: '[data-text-keyframe-id]',
    item: { id: 'T1', text: 'Metin', start: 5, end: 8, x: 16, y: 18, size: 72, rotation: 0 } },
  { type: 'image', collection: 'imageLayers', field: 'layer-id', overlay: 'media-overlay', marker: '[data-image-kf]',
    item: { id: 'I1', assetId: 'image', name: 'Görsel', start: 9, end: 13, x: 16, y: 18, scale: 12, rotation: 0 } },
];

const coordinate = (value, expected, tolerance, label) => {
  assert.ok(Math.abs(value - expected) <= tolerance, `${label}: ${value} expected ${expected} ± ${tolerance}`);
};

app.whenReady().then(() => withStudioBrowser(async ({ evaluate, win, temporary, root }) => {
  const j = JSON.stringify;
  const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const bundled = path.join(root, 'tools/ffmpeg/bin/ffmpeg.exe');
  const ffmpeg = process.env.SMART_EDITOR_FFMPEG || (process.platform === 'win32' && fs.existsSync(bundled) ? bundled : 'ffmpeg');

  async function uploadFixture(name, args, mime) {
    const file = path.join(temporary, name);
    execFileSync(ffmpeg, ['-v', 'error', '-y', ...args, file], { timeout: 30_000 });
    const bytes = j(fs.readFileSync(file).toString('base64'));
    return evaluate(`upload(new File([Uint8Array.from(atob(${bytes}), c => c.charCodeAt(0))], ${j(name)}, {type: ${j(mime)}}))`);
  }

  const video = await uploadFixture('keyframe-source.mp4', ['-f', 'lavfi', '-i', 'color=navy:s=160x90:r=24:d=13',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], 'video/mp4');
  const image = await uploadFixture('keyframe-layer.png', ['-f', 'lavfi', '-i', 'color=red:s=120x72', '-frames:v', '1'], 'image/png');
  const mediaAssets = [
    { id: 'video', fileId: video.file_id, name: 'Source', kind: 'video', duration: video.duration },
    { id: 'image', fileId: image.file_id, name: 'Görsel', kind: 'image', duration: 0 },
  ];
  const state = {
    manualId: video.file_id, manualName: 'Source', duration: 13, selected: 0, preview: 0,
    canvas: { width: 1920, height: 1080 }, zoom: 48, timelineMagnet: false,
    clips: [{ clipId: 'video-1', fileId: video.file_id, assetId: 'video', start: 0, end: 13, sourceDuration: 13, timelineStart: 0 }],
    ...Object.fromEntries(layers.map(layer => [layer.collection, [{ ...layer.item, ...(layer.type === 'image' ? { fileId: image.file_id } : {}) }]])),
  };
  const project = { name: 'Layer position keyframes', mediaAssets, activeTimelineId: 'main', timelines: [{ id: 'main', name: 'Main', state }] };

  win.setContentSize(1366, 740);
  win.showInactive();
  await evaluate('projectWorkspaceInitialization');
  await evaluate(`restoreProject(${j(project)});switchTab('manual');el('timeline').scrollLeft=0;el('timeline').scrollTop=0`);
  await frames();

  function send(type, { x, y }) {
    win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, x, y });
  }

  async function pointFor(selector, offset = [.5, .5]) {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${j(selector)});
      if (!node) return null;
      node.scrollIntoView({block:'nearest', inline:'nearest'});
      const r = node.getBoundingClientRect();
      const x = Math.round(r.left + r.width * ${offset[0]}), y = Math.round(r.top + r.height * ${offset[1]});
      const hit = document.elementFromPoint(x, y);
      return {x, y, reachable: !node.disabled && node.contains(hit), hit: hit?.className};
    })()`);
    assert.ok(point?.reachable, `${selector} must be reachable: ${j(point)}`);
    return point;
  }

  async function click(point) {
    send('mouseDown', point);
    send('mouseUp', point);
    await frames();
  }

  async function drag(from, to) {
    send('mouseDown', from);
    send('mouseMove', { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) });
    await frames();
    send('mouseMove', to);
    await frames();
    send('mouseUp', to);
    await frames();
  }

  const waitForSeek = time => evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 10000;
    const poll = () => {
      const current = currentOutputTime();
      if (Math.abs(current - ${time}) < .035 && mv.readyState >= 2 && !mv.seeking) return resolve(current);
      if (performance.now() >= deadline) return reject(new Error('Seek ${time}: ' + JSON.stringify({current, media: mv.currentTime, ready: mv.readyState, seeking: mv.seeking})));
      setTimeout(poll, 20);
    };
    poll();
  })`);

  async function scrub(time, fromPlayhead = false) {
    await evaluate("el('timeline').scrollTop = 0; el('timeline').scrollLeft = 0");
    await frames();
    const point = await evaluate(`(() => {
      const ruler = el('timeline-ruler'), r = ruler.getBoundingClientRect();
      const x = Math.round(el('timeline-content').getBoundingClientRect().left + TIMELINE_GUTTER + ${time} * S.zoom);
      const y = Math.round(r.top + 10);
      return {x, y, reachable: ruler.contains(document.elementFromPoint(x, y))};
    })()`);
    assert.ok(point.reachable, `Ruler position at ${time} must be reachable: ${j(point)}`);
    if (fromPlayhead) await drag(await pointFor('#playhead-cap'), point);
    else await click(point);
    const reached = await waitForSeek(time);
    await frames();
    return reached;
  }

  const itemState = layer => evaluate(`S.${layer.collection}.find(item => item.id === ${j(layer.item.id)})`);
  const overlaySelector = layer => `#${layer.overlay} [data-${layer.field}="${layer.item.id}"]`;
  const clipSelector = layer => `#${layer.type}-track [data-${layer.field}="${layer.item.id}"]`;
  const previewPosition = layer => evaluate(`(() => {
    const node = document.querySelector(${j(overlaySelector(layer))});
    if (!node) throw new Error('Missing preview for ${layer.type}');
    return [parseFloat(node.style.left), parseFloat(node.style.top)];
  })()`);
  const selected = layer => evaluate(`document.querySelector(${j(clipSelector(layer))}).classList.contains('selected')`);
  const history = () => evaluate('S.history.length');

  for (const layer of layers) {
    const { type, item } = layer;
    const atStart = item.start + .25;
    const atEnd = item.end === state.duration ? item.end : item.end - .25;
    const halfway = (atStart + atEnd) / 2;
    const markerSelector = `#${type}-track ${layer.marker}`;
    const markers = () => evaluate(`document.querySelectorAll(${j(markerSelector)}).length`);

    await click(await pointFor(clipSelector(layer), [.3, .5]));
    const startTime = await scrub(atStart);
    assert.equal(await selected(layer), true, `${type}: ruler scrub keeps the timeline selection`);
    assert.deepEqual(await previewPosition(layer), [item.x, item.y], `${type}: an older project keeps its static position`);
    assert.equal(await markers(), 0, `${type}: old layers have no markers until a keyframe is added`);

    await click(await pointFor('#timeline-position-keyframe-add'));
    const first = (await itemState(layer)).transformKeyframes[0];
    coordinate(first.time, startTime - item.start, .035, `${type} initial keyframe time`);
    assert.deepEqual([first.x, first.y], [item.x, item.y]);
    assert.equal(await markers(), 1, `${type}: the initial keyframe has a timeline marker`);

    const endTime = await scrub(atEnd, true);
    assert.equal(await selected(layer), true, `${type}: playhead drag keeps the timeline selection`);
    const target = await evaluate(`(() => {
      const rect = el('preview-stage').getBoundingClientRect();
      return {x: Math.round(rect.left + rect.width * .84), y: Math.round(rect.top + rect.height * .82)};
    })()`);
    const from = await pointFor(overlaySelector(layer));
    const historyBeforeDrag = await history();
    await drag(from, target);

    const edited = await itemState(layer);
    assert.equal(await history(), historyBeforeDrag + 1, `${type}: one undo entry for the drag`);
    assert.equal(edited.transformKeyframes.length, 2, `${type}: moving at the new time creates a keyframe`);
    const [initial, final] = edited.transformKeyframes;
    assert.deepEqual(initial, first, `${type}: retains the first keyframe`);
    assert.deepEqual([edited.x, edited.y], [item.x, item.y], `${type}: the base position remains the same`);
    coordinate(final.time, endTime - item.start, .035, `${type} last keyframe time`);
    if (item.end === state.duration) assert.equal(final.time, item.end - item.start, `${type}: the terminal keyframe reaches the clip end`);
    coordinate(final.x, 84, 1, `${type} destination X`);
    coordinate(final.y, 82, 1, `${type} destination Y`);
    coordinate(await evaluate('currentOutputTime()'), endTime, .035, `${type} drag keeps the playhead in place`);
    assert.equal(await markers(), 2, `${type}: both keyframes have timeline markers`);
    const ending = await previewPosition(layer);
    coordinate(ending[0], final.x, 1, `${type} preview destination X`);
    coordinate(ending[1], final.y, 1, `${type} preview destination Y`);

    await scrub(halfway);
    const midpoint = await previewPosition(layer);
    coordinate(midpoint[0], (first.x + final.x) / 2, 2.5, `${type} midpoint X`);
    coordinate(midpoint[1], (first.y + final.y) / 2, 2.5, `${type} midpoint Y`);

    const finalMarker = `${markerSelector.slice(0, -1)}="${final.id}"]`;
    await click(await pointFor(finalMarker));
    await waitForSeek(atEnd);
    await click(await pointFor('#undo'));
    assert.deepEqual((await itemState(layer)).transformKeyframes, [first], `${type}: undo restores both time and position`);
    assert.equal(await markers(), 1, `${type}: undo removes the second marker`);
    await click(await pointFor('#redo'));
    assert.deepEqual((await itemState(layer)).transformKeyframes, [initial, final], `${type}: redo restores motion`);
    assert.equal(await markers(), 2);

    await waitForSeek(atEnd);
    const lock = `[data-track="${type}"][data-track-action="lock"]`;
    await click(await pointFor(lock));
    const historyWhileLocked = await history();
    const lockState = await evaluate(`({locked:isTrackLocked(${j(type)}), addDisabled:el('timeline-position-keyframe-add').disabled,
      deleteDisabled:el('timeline-position-keyframe-delete').disabled, positionPanelHidden:el('timeline-position-keyframes').hidden})`);
    assert.deepEqual(lockState, { locked: true, addDisabled: true, deleteDisabled: true, positionPanelHidden: false }, `${type}: controls reflect the locked track`);
    await drag(await pointFor(overlaySelector(layer)), from);
    assert.deepEqual((await itemState(layer)).transformKeyframes, [initial, final], `${type}: a locked layer rejects preview drags`);
    assert.equal(await history(), historyWhileLocked);
    await click(await pointFor(lock));

    await click(await pointFor('#timeline-position-keyframe-delete'));
    assert.deepEqual((await itemState(layer)).transformKeyframes, [first], `${type}: deleting the current keyframe retains the earlier keyframe`);
    await click(await pointFor('#undo'));
    assert.deepEqual((await itemState(layer)).transformKeyframes, [initial, final], `${type}: undo restores the deleted keyframe`);
  }

  const originalFrames = Object.fromEntries(await Promise.all(layers.map(async layer => [layer.collection, (await itemState(layer)).transformKeyframes])));
  assert.equal(await evaluate('saveNamedProject()'), true);
  const savedId = await evaluate('S.projectId');
  await evaluate(`restoreProject(${j(project)});el('project-list').value = ${j(savedId)};loadNamedProject()`);
  assert.equal(await evaluate('S.projectId'), savedId, 'The named project was reopened from disk');
  await frames();
  const exported = await evaluate(`(() => {
    const form = buildRenderForm(manualExportData());
    return Object.fromEntries(['stickers', 'texts', 'images'].map(key => [key, JSON.parse(form.get(key))]));
  })()`);
  for (const layer of layers) {
    const original = originalFrames[layer.collection];
    assert.deepEqual((await itemState(layer)).transformKeyframes, original, `${layer.type}: named project reload restores both keyframes`);
    const exportCollection = layer.type === 'image' ? 'images' : layer.collection;
    assert.deepEqual(exported[exportCollection][0].transformKeyframes, original, `${layer.type}: both keyframes reach the export form`);
  }
  console.log('Native layer motion passed for stickers, text and images, including scrubbing, interpolation, marker seeking, undo, redo and persistence.');
})).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
