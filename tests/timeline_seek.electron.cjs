'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { withStudioBrowser } = require('./support/studio_backend.cjs');

async function waitFor(read, label) {
  const deadline = Date.now() + 8000;
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail('Timed out: ' + label);
}

app.whenReady().then(() => withStudioBrowser(async ({ evaluate, win, temporary, root }) => {
  const bundled = path.join(root, 'tools/ffmpeg/bin/ffmpeg.exe');
  const ffmpeg = process.env.SMART_EDITOR_FFMPEG || (process.platform === 'win32' && fs.existsSync(bundled) ? bundled : 'ffmpeg');
  const media = [];
  for (const color of ['red', 'blue']) {
    const file = path.join(temporary, color + '.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=' + color + ':s=96x54:r=24:d=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { timeout: 30000 });
    const data = JSON.stringify(fs.readFileSync(file).toString('base64'));
    const name = JSON.stringify(path.basename(file));
    const item = await evaluate(`upload(new File([Uint8Array.from(atob(${data}), c=>c.charCodeAt(0))], ${name}, {type:'video/mp4'}))`);
    media.push({ id: color, kind: 'video', name: color + '.mp4', fileId: item.file_id, duration: item.duration });
  }

  const clips = Array.from({ length: 192 }, (_, i) => {
    const asset = media[i % 2], start = i % 3;
    return { clipId: 'clip-' + i, fileId: asset.fileId, name: asset.name, start, end: start + 1.5,
      sourceDuration: asset.duration, timelineStart: i * 1.5, videoTrack: 1, assetId: asset.id,
      zoomKeyframes: i === 5 ? [{ id: 'zoom-5', time: .4, scale: 125 }] : [] };
  });
  const texts = Array.from({ length: 24 }, (_, i) => ({ id: 'text-' + i, text: 'Scene ' + i, start: i * 12, end: i * 12 + 1 }));
  const state = { clips, texts, selected: 0, preview: 0, manualId: media[0].fileId,
    transitions: [{ leftClipId: 'clip-2', rightClipId: 'clip-3', type: 'fade', duration: .25 }],
    studioTimeline: { markers: [{ id: 'review', time: 7.9, name: 'Review blue' }], range: { in: 2, out: 12 } } };
  const stacked = { ...state, transitions: [], clips: [clips[0], { ...clips[1], videoTrack: 2, timelineStart: 0 }],
    videoTracks: [{ id: 1, name: 'Video 1' }, { id: 2, name: 'Video 2', locked: true }] };
  const project = { name: 'Timeline fixture', mediaAssets: media, activeTimelineId: 'main',
    timelines: [{ id: 'main', name: 'Main', state }, { id: 'stacked', name: 'Stacked', state: stacked }] };
  await evaluate('projectWorkspaceInitialization');
  await evaluate(`restoreProject(${JSON.stringify(project)});switchTab('manual')`);

  async function frame(source, time, selector = 'mv') {
    const expected = JSON.stringify(source.fileId);
    let lastSample = null;
    const pixel = await waitFor(async () => {
      const sample = await evaluate(`(()=>{
        const video=${selector};
        if(!video||video.readyState<2||video.seeking||
          !new URL(video.currentSrc).pathname.endsWith('/'+encodeURIComponent(${expected}))||Math.abs(video.currentTime-${time})>=.035)return null;
        const context=document.createElement('canvas').getContext('2d');
        context.drawImage(video,0,0,1,1);
        return Array.from(context.getImageData(0,0,1,1).data);
      })()`);
      if (!sample) return null;
      lastSample = sample;
      const rgb = sample.slice(0, 3);
      // The decoder can report current data before a canvas draw has usable pixels.
      // These solid red and blue fixtures have no black or transparent frames.
      return sample[3] && rgb.some(value => value !== 0) ? rgb : null;
    }, source.name + ' at ' + time).catch(async error => {
      const playback = await evaluate(`(()=>{const video=${selector};return {
        source:video?.currentSrc,time:video?.currentTime,ready:video?.readyState,seeking:video?.seeking,
        timeline:currentOutputTime(),selected:S.selected,preview:S.preview
      }})()`);
      throw new Error(error.message + ' ' + JSON.stringify({ ...playback, lastSample }), { cause: error });
    });
    const channel = source.id === 'red' ? 0 : 2;
    assert.ok(pixel[channel] > 220 && pixel.every((value, i) => i === channel || value < 20), String(pixel));
  }
  const compositeSource = clipId => `document.querySelector('[data-clip-id="${clipId}"] .composite-source')`;

  await frame(media[0], 0);
  await evaluate(`selectText('text-0',false);
    window.fixtureSelectors=['#track [data-clip-id="clip-5"]','.text-clip','.transition-slot.applied',
    '.studio-ruler-marker','.studio-ruler-range','[data-zoom-keyframe-id="zoom-5"].zoom-keyframe-marker'];
    window.fixtureNodes=fixtureSelectors.map(selector=>document.querySelector(selector));
    window.fixtureLaneNodes=Array.from(document.querySelectorAll('#track .clip,.text-clip'))`);
  const identity = () => evaluate(`(()=>{
    const current=document.querySelectorAll('#track .clip,.text-clip');
    return current.length===216&&fixtureLaneNodes.every((node,i)=>node===current[i])&&
      fixtureNodes.every((node,i)=>node&&node===document.querySelector(fixtureSelectors[i]));
  })()`);

  await evaluate("document.querySelector('.studio-ruler-marker').click()");
  await frame(media[1], 2.4);
  assert.equal(await identity(), true, 'Seek retains the mounted clips, text, transition and ruler controls');
  assert.deepEqual(await evaluate(`[S.selected,S.preview,S.selectedText,el('clip-start').value,el('clip-end').value,
    fixtureNodes[0].getAttribute('aria-pressed'),el('split').disabled]`), [5, 5, 'text-0', '2.00', '3.50', 'false', true]);

  await evaluate('fixtureNodes[5].click()');
  assert.equal(await evaluate('fixtureNodes[5].classList.contains("selected")'), true);
  await evaluate(`window.fixtureSourceOption=el('studio-template-source').options[3];select(5,false)`);
  assert.equal(await identity(), true, 'Clicking a keyframe or selecting video keeps existing edit handles');
  assert.deepEqual(await evaluate(`[S.selectedText,el('text-track').querySelector('.selected')?.dataset.textId??null,
    S.selectedZoomKeyframe,fixtureNodes[5].classList.contains('selected'),el('split').disabled,
    fixtureNodes[0].getAttribute('aria-pressed'),el('studio-template-source').value,
    el('studio-template-source').options[3]===fixtureSourceOption]`), [null, null, null, false, false, 'true', 'clip:clip-5', true]);

  await evaluate("el('clip-end').value='3.25';el('trim').click()");
  assert.equal(await evaluate('S.clips[5].end'), 3.25);
  assert.equal(await identity(), false, 'A real trim refreshes layout and bindings');
  await evaluate('seekOutputTime(8.25)');
  await frame(media[1], 2.75, compositeSource('clip-5'));
  assert.equal(await evaluate('Math.abs(currentOutputTime()-8.25)<.04'), true);
  await evaluate("el('timeline').focus({preventScroll:true})");
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B' });
  await waitFor(() => evaluate('S.clips.length===193'), 'keyboard split');
  assert.deepEqual(await evaluate(`S.clips.slice(5,7).map(c=>[c.start,c.end,c.fileId])`),
    [[2, 2.75, media[1].fileId], [2.75, 3.25, media[1].fileId]]);
  await evaluate("el('undo').click();el('undo').click()");
  assert.equal(await evaluate('S.clips.length===192&&S.clips[5].end===3.5&&S.transitions.length===1'), true);

  await evaluate("switchTimeline('stacked');pausePreview();seekOutputTime(.5)");
  await frame(media[1], 1.5, compositeSource('clip-1'));
  await evaluate(`window.fixtureLabel=document.querySelector('[data-extra-video-label="2"]');
    window.fixtureUpper=document.querySelector('#track [data-clip-id="clip-1"]');fixtureLabel.querySelector('b').click()`);
  assert.deepEqual(await evaluate(`[S.activeVideoTrack,S.selected,fixtureLabel.classList.contains('active-video-track'),
    fixtureUpper.getAttribute('aria-pressed'),el('trim').disabled,el('split').disabled]`), [2, 1, true, 'true', true, true]);
  await evaluate('seekOutputTime(.8);splitSelected()');
  assert.equal(await evaluate(`S.clips.length===2&&S.selected===1&&
    fixtureUpper===document.querySelector('#track [data-clip-id="clip-1"]')&&
    fixtureLabel===document.querySelector('[data-extra-video-label="2"]')`), true);
  assert.equal(await evaluate('projectPayload().timelines[0].state.clips.length'), 192);

  const delayedMedia=[];
  for(const [name,color] of [['delayed','red'],['abandoned','blue']]){
    const bytes=fs.readFileSync(path.join(temporary,color+'.mp4')).toString('base64');
    const uploaded=await evaluate(`upload(new File([Uint8Array.from(atob(${JSON.stringify(bytes)}),c=>c.charCodeAt(0))],${JSON.stringify(name+'.mp4')},{type:'video/mp4'}))`);
    delayedMedia.push({id:name==='delayed'?'red':name,name:name+'.mp4',kind:'video',fileId:uploaded.file_id,duration:uploaded.duration});
  }
  const [delayed,abandoned]=delayedMedia;
  const holds=new Map(delayedMedia.map(asset=>['/preview/'+encodeURIComponent(asset.fileId),[]]));
  const network=win.webContents.session.webRequest;
  network.onBeforeRequest((details,callback)=>{
    const pending=holds.get(new URL(details.url).pathname);
    if(pending)pending.push(callback);
    else callback({cancel:false});
  });
  const release=asset=>{
    const pathname='/preview/'+encodeURIComponent(asset.fileId), waits=holds.get(pathname);
    holds.delete(pathname);
    for(const callback of waits||[])callback({cancel:false});
  };
  const layout={
    name:'Delayed preview',mediaAssets:delayedMedia.concat(media[1]),activeTimelineId:'delayed',
    timelines:[
      {id:'delayed',name:'Delayed',state:{selected:0,preview:0,clips:[
        {...clips[0],fileId:delayed.fileId,assetId:delayed.id,clipId:'delayed',start:.8,end:4.8,speed:2,timelineStart:0},
        {...clips[1],fileId:abandoned.fileId,assetId:abandoned.id,clipId:'abandoned',start:1,end:3,timelineStart:2},
      ]}},
      {id:'alternate',name:'Alternate',state:{selected:0,preview:0,clips:[{...clips[1],timelineStart:0}]}},
    ],
  };
  try{
    await evaluate(`restoreProject(${JSON.stringify(layout)})`);
    await waitFor(()=>holds.get('/preview/'+encodeURIComponent(delayed.fileId)).length,'delayed proxy request');
    const key=(keyCode)=>{
      win.webContents.sendInputEvent({type:'keyDown',keyCode});
      win.webContents.sendInputEvent({type:'keyUp',keyCode});
    };
    await evaluate("seekOutputTime(.5);el('timeline').focus()");
    key('I');
    await waitFor(()=>evaluate('S.studioTimeline?.range.in===.5'),'I while metadata is blocked');
    await evaluate('seekOutputTime(1.5)');
    key('O');key('M');
    await waitFor(()=>evaluate('S.studioTimeline.range.out===1.5 && S.studioTimeline.markers[0]?.time===1.5'),'O and marker while metadata is blocked');
    assert.deepEqual(await evaluate('[mv.readyState,mv.currentTime,currentOutputTime()]'),[0,0,1.5]);
    await evaluate('openSnapshotModal()');
    assert.equal(await evaluate('S.snapshotTime'),1.5);
    await evaluate("el('snapshot-modal').close()");
    assert.equal(await evaluate('saveNamedProject()'),true);
    const saved=await evaluate(`fetch('/projects/'+S.projectId).then(response=>response.json())`);
    assert.deepEqual(saved.timelines[0].state.studioTimeline.range,{in:.5,out:1.5});
    assert.equal(saved.timelines[0].state.studioTimeline.markers[0].time,1.5);

    await evaluate('setPreviewSource(0,3.8,true)');
    release(delayed);
    await waitFor(()=>evaluate('!mv.paused&&mv.readyState>=2&&!mv.seeking&&currentOutputTime()>1.53'),'playAfter uses the newest requested source time');
    assert.equal(await evaluate('S.timelineCursor'),null,'Ready playback hands the clock back to media');
    await evaluate('pausePreview();seekOutputTime(.5)');
    await frame(delayed,1.8);
    await evaluate('playPreview()');
    await waitFor(()=>evaluate('!mv.paused&&currentOutputTime()>.56'),'manual playback follows the media clock');
    await evaluate('pausePreview();seekOutputTime(2.6);setPreviewSource(1,1.6,true)');
    await waitFor(()=>holds.get('/preview/'+encodeURIComponent(abandoned.fileId)).length,'second clip proxy request');
    assert.ok(await evaluate('Math.abs(currentOutputTime()-2.6)<.001'));
    await evaluate("switchTimeline('alternate');seekOutputTime(.7)");
    release(abandoned);
    await frame(media[1],1.7);
    assert.deepEqual(await evaluate('[S.activeTimelineId,mv.paused]'),['alternate',true],'Abandoned clip cannot start playback in another timeline');
    assert.ok(await evaluate('Math.abs(currentOutputTime()-.7)<.01'));
  }finally{
    release(delayed);release(abandoned);
    network.onBeforeRequest(null);
  }

  console.log('Timeline seek preserved edit controls and kept requested I/O, marker and snapshot times until delayed media was ready');
})).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
