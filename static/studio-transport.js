(() => {
  const playButton = el('studio-play-toggle');
  const seek = el('studio-player-seek');
  const volume = el('studio-player-volume');
  const stage = el('preview-shell');
  const video = el('manual-video');
  let masterVolume = 1;

  function update(time = currentOutputTime(), duration = outDuration()) {
    const playing = duration > 0 && isPreviewPlaying();
    playButton.disabled = el('studio-player-home').disabled = seek.disabled = !duration;
    playButton.textContent = playing ? 'Ⅱ' : '▶';
    playButton.setAttribute('aria-label', playing ? 'Duraklat' : 'Oynat');
    playButton.title = playing ? 'Duraklat (Boşluk)' : 'Oynat (Boşluk)';
    seek.max = String(duration || 1);
    seek.value = String(time);
    seek.setAttribute('aria-valuetext', ft(time)+' / '+ft(duration));
  }
  playButton.onclick = () => {
    if (isPreviewPlaying()) pausePreview();
    else playPreview().catch(error => log('manual-log',error.message,'error'));
    update();
  };
  el('studio-player-home').onclick = () => {
    pausePreview();
    seekOutputTime(0);
    update();
  };
  seek.oninput = () => {
    pausePreview();
    seekOutputTime(Number(seek.value));
    update();
  };
  volume.oninput = () => {
    masterVolume = Number(volume.value);
    applyVideoEffectPreview();
    syncProjectAudio();
  };
  el('studio-player-fullscreen').onclick = () => {
    const action = document.fullscreenElement ? document.exitFullscreen() : el('preview-panel').requestFullscreen();
    action.catch(error => log('manual-log',error.message,'error'));
  };
  el('studio-player-import').onclick = el('studio-import-files').onclick = () => el('manual-file').click();
  for (const name of ['play','pause','ended','loadeddata','seeked']) video.addEventListener(name, () => update());
  document.addEventListener('fullscreenchange', () => requestAnimationFrame(fitPreviewStage));

  function containsFiles(event) {
    return [...(event.dataTransfer?.types || [])].includes('Files');
  }
  stage.addEventListener('dragover', event => {
    if (!containsFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    stage.classList.add('studio-file-drop');
  });
  stage.addEventListener('dragleave', event => {
    if (!stage.contains(event.relatedTarget)) stage.classList.remove('studio-file-drop');
  });
  stage.addEventListener('drop', event => {
    if (!containsFiles(event)) return;
    event.preventDefault();
    stage.classList.remove('studio-file-drop');
    const files = [...event.dataTransfer.files];
    if (files.length) void importProjectFiles(files);
  });

  window.StudioTransport = {update, volume: () => masterVolume};
  video.controls = false;
  update();
})();
