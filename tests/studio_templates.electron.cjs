'use strict';

const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withStudioBrowser } = require('./support/studio_backend.cjs');

app.whenReady().then(() => withStudioBrowser(async ({ evaluate, temporary, root }) => {
  const section = () => evaluate(`{
    // The shelf is independently loadable during development before the shell.
    if (window.StudioWorkspace) window.StudioWorkspace.openSection('templates');
    else {
      if (!el('studio-templates')) {
        const host = document.createElement('section');
        host.id='studio-templates';
        document.body.append(host);
      }
      window.dispatchEvent(new CustomEvent('studio:section',{detail:{id:'templates'}}));
    }
  }`);
  const choose = value => evaluate(`{
    const source = el('studio-template-source');
    source.value = ${JSON.stringify(value)};
    source.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  const apply = id => evaluate(`window.StudioTemplates.applyTemplate(${JSON.stringify(id)},el('studio-template-source').value)`);
  await section();

  const cards = await evaluate(`(async () => {
    const nodes = [...document.querySelectorAll('[data-template]')];
    const images = nodes.map(node=>node.querySelector('img'));
    for (const image of images) image.loading='eager';
    await Promise.all(images.map(image=>image.decode()));
    return nodes.map(node=>({id:node.dataset.template, sample:node.querySelector('.studio-template-sample-text').textContent,
      width:node.querySelector('img').naturalWidth}));
  })()`);
  assert.equal(cards.length, 6);
  assert.ok(cards.every(card => card.sample && card.width > 0));
  assert.equal(new Set(cards.map(card => card.sample)).size, 6);
  assert.equal(await evaluate("document.querySelector('[data-apply-template]').disabled"), true);
  assert.equal(fs.readdirSync(path.join(temporary, 'uploads')).length, 0);

  await evaluate(`{
    videoTrackState(1).locked=true;
    S.trackState.text.locked=true;
    remember();
    drawClips();
  }`);
  const before = await evaluate('projectPayload().timelines[0].state');
  await choose('demo');
  assert.equal(await apply('vertical-cut'), true);
  const demoTimeline = await evaluate(`(() => {
    const data = projectPayload();
    return {active:data.activeTimelineId, original:data.timelines[0].state, clips:S.clips, canvas:S.canvas, layers:S.texts,
      asset:data.mediaAssets[0], unlocked:!videoTrackState(1).locked&&!isTrackLocked('text')};
  })()`);
  assert.notEqual(demoTimeline.active, 'TL1');
  assert.deepEqual(demoTimeline.original, before, 'Applying into a new timeline keeps every locked original field');
  assert.deepEqual(demoTimeline.canvas, {width:1080,height:1920});
  assert.equal(demoTimeline.asset.studioDemoId, 'alpine-tour');
  assert.equal(demoTimeline.asset.fileId, demoTimeline.clips[0].fileId);
  assert.equal(demoTimeline.layers.length, 3);
  assert.ok(demoTimeline.layers[1].transformKeyframes.length);
  assert.equal(demoTimeline.unlocked, true);
  assert.equal(fs.readdirSync(path.join(temporary, 'uploads')).length, 1);

  await evaluate('undoEdit()');
  assert.equal(await evaluate('S.activeTimelineId'), 'TL1');
  assert.equal(await evaluate('S.timelines.length'), 1);
  assert.equal(await evaluate('S.mediaAssets.length'), 0);
  assert.equal(await evaluate('S.history.length'), 1);
  assert.deepEqual(await evaluate('projectPayload().timelines[0].state'), before);

  await evaluate('redoEdit()');
  assert.equal(await evaluate('S.activeTimelineId'),demoTimeline.active);
  assert.equal(await evaluate('S.mediaAssets[0].fileId'),demoTimeline.asset.fileId);
  assert.equal(await evaluate('S.timelines[0].state.videoTracks[0].locked'),true);
  assert.equal(fs.readdirSync(path.join(temporary, 'uploads')).length,1,'Redo reuses the original upload');
  assert.deepEqual(await evaluate('projectPayload().timelines[0].state'),before);
  await evaluate('undoEdit()');

  for (const [template, filename] of [['product-frame','product-showcase'], ['concert-session','session-lights']]) {
    await choose('demo');
    assert.equal(await apply(template), true);
    const media = await evaluate('S.mediaAssets[0]');
    assert.equal(media.studioDemoId, filename);
    assert.deepEqual(fs.readFileSync(path.join(temporary, 'uploads', media.fileId)),
      fs.readFileSync(path.join(root, 'static/studio/demo', filename + '.mp4')));
    await evaluate('undoEdit()');
    assert.equal(await evaluate('S.mediaAssets.length'), 0);
  }

  const payload = fs.readFileSync(path.join(root, 'static/studio/demo/alpine-tour.mp4')).toString('base64');
  const userAsset = await evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(payload)}), character => character.charCodeAt(0));
    const media = await upload(new File([bytes], 'Benim Klibim.mp4', {type:'video/mp4'}));
    const asset = {id:'M'+S.nextAssetId++,kind:'video',fileId:media.file_id,src:media.url,name:media.name,duration:media.duration};
    S.mediaAssets.push(asset);
    S.clips.push(hydrateClip({clipId:'source-clip',fileId:asset.fileId,src:asset.src,name:asset.name,
      assetId:asset.id,sourceDuration:asset.duration,start:1,end:6,speed:2,reverse:true,timelineStart:0,videoTrack:1}));
    S.manualId=asset.fileId;
    S.manualName=asset.name;
    S.duration=asset.duration;
    S.selected=S.preview=0;
    drawClips();
    return asset.fileId;
  })()`);
  await section();
  assert.equal(await evaluate("el('studio-template-source').value"), 'clip:source-clip');
  const userBefore = await evaluate('projectPayload().timelines[0].state');
  const created = [];
  for (const {id} of cards) {
    await evaluate("switchTimeline('TL1')");
    await section();
    assert.equal(await apply(id), true, 'apply ' + id);
    const result = await evaluate(`(() => {
      const payload=projectPayload();
      return { id:S.activeTimelineId, original:payload.timelines[0].state, clip:S.clips[0], texts:S.texts };
    })()`);
    assert.deepEqual(result.original, userBefore);
    assert.equal(result.clip.fileId, userAsset);
    assert.equal(result.clip.reverse, true);
    assert.equal(result.clip.speed, 2);
    assert.deepEqual([result.clip.start, result.clip.end, result.clip.timelineStart], [1, 6, 0]);
    assert.ok(result.texts.every(layer => layer.end <= 2.5 && layer.end > layer.start && layer.fontFamily));
    created.push(result.id);
  }
  assert.equal(new Set(created).size, 6);
  assert.equal(fs.readdirSync(path.join(temporary, 'uploads')).length, 4, 'User clips are reused without copying files');

  const output = await evaluate(`(async () => {
    const form = buildRenderForm({fileId:S.manualId, clips:S.clips, texts:S.texts, resolution:{width:480,height:270}, options:{quality:'draft',hardware:'cpu'}});
    form.append('timeline_time','.55');
    form.append('canvas_width',S.canvas.width);
    form.append('canvas_height',S.canvas.height);
    const response = await fetch('/start-snapshot', {method:'POST',body:form});
    if (!response.ok) return {error:await response.text()};
    const {job_id}=await response.json();
    const result=await events(job_id,()=>{});
    const image=await fetch(result.download_url);
    return {type:image.headers.get('content-type'), bytes:(await image.arrayBuffer()).byteLength};
  })()`);
  assert.match(output.type || output.error, /^image\/png/);
  assert.ok(output.bytes > 500);

  const reload = await evaluate(`(async () => {
    const active=S.activeTimelineId;
    const subtitle=S.texts[0];
    subtitle.text='Düzenlenmiş başlık';
    el('project-name').value='Şablon projesi';
    if (!await saveNamedProject()) return {error:'save'};
    const stored=await fetch('/projects/'+S.projectId).then(response=>response.json());
    restoreProject(stored);
    return {active, restored:S.activeTimelineId, text:S.texts[0].text, font:S.texts[0].fontFamily, count:S.timelines.length};
  })()`);
  assert.equal(reload.restored, reload.active);
  assert.equal(reload.text, 'Düzenlenmiş başlık');
  assert.equal(reload.font, 'spacemono');
  assert.equal(reload.count, 7);
  console.log('All six templates apply real editable timelines with explicit sources, locked-origin protection, undo, and project reload.');
})).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
