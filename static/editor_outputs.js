function createEditorOutputJobs({el, document, currentScope, canStart, save, stop, desktop}) {
  const channels = {
    manual: {buttons: ['manual-render', 'manual-render-top', 'export-render-start'], links: ['manual-download', 'manual-download-top'], progress: 'manual-progress-top', stop: 'manual-stop', label: 'Video'},
    snapshot: {buttons: ['snapshot-open', 'snapshot-save'], links: ['snapshot-download'], stop: 'snapshot-stop', label: 'Ekran görüntüsü'},
    auto: {buttons: ['auto-render'], links: ['auto-download'], progress: 'auto-progress', stop: 'auto-stop', label: 'Otomatik kesim'}
  };
  const active = new Map(), latest = new Map(), activeRows = new Map();
  const recentLimit = 20;
  let recent = [];

  const scopeKey = ({kind, generation, timelineId}) => JSON.stringify([kind, generation, timelineId]);
  const available = kind => !active.has(kind) && canStart(kind);
  const visible = job => scopeKey(job) === scopeKey(currentScope(job.kind));
  const validOutputUrl = url => typeof url === 'string' && /^\/download\/[a-zA-Z0-9-]{1,80}\/(?:png|mp4|mov|mkv|webm|gif|mp3)$/.test(url);

  function setLink(link, output, label) {
    link.classList.toggle('hidden', !output);
    if (!output) {
      link.removeAttribute('href');
      link.onclick = null;
      return;
    }
    link.href = output.url;
    link.textContent = label;
    link.onclick = desktop ? event => {
      event.preventDefault();
      void save(output);
    } : null;
  }

  const isRunning = job => !!job && active.get(job.kind) === job && job.phase === 'running';
  const canStop = job => isRunning(job) && job.cancelCredentials !== null && typeof stop === 'function';
  function displayMessage(job) {
    if (!isRunning(job)) return job.message;
    return job.stopping ? 'Durduruluyor…' : job.stopError || job.message;
  }

  function paintStopButton(button, job) {
    button.hidden = !canStop(job);
    button.disabled = !canStop(job) || !!job.stopping;
    button.textContent = job?.stopping && isRunning(job) ? 'Durduruluyor…' : 'Durdur';
    button.onclick = canStop(job) ? () => requestStop(job) : null;
  }

  function paintActiveRow(job) {
    const entry = activeRows.get(job);
    if (!entry) return;
    const detail = [job.projectName, job.timelineName, displayMessage(job)].filter(Boolean).join(' · ');
    if (entry.detail.textContent !== detail) entry.detail.textContent = detail;
    paintStopButton(entry.button, job);
  }

  function drawActive() {
    const section = el('active-output-section'), list = el('active-output-list');
    if (!section || !list) return;
    for (const [job, entry] of activeRows) {
      if (isRunning(job)) continue;
      entry.row.remove();
      activeRows.delete(job);
    }
    for (const job of active.values()) {
      if (!isRunning(job)) continue;
      if (!activeRows.has(job)) {
        const row = document.createElement('li'), label = document.createElement('b');
        const detail = document.createElement('small'), button = document.createElement('button');
        label.textContent = channels[job.kind].label + ' · ' + job.format.toUpperCase();
        detail.setAttribute('role', 'status');
        button.type = 'button';
        button.className = 'project-action';
        button.dataset.outputStop = job.kind;
        row.append(label, detail, button);
        list.append(row);
        activeRows.set(job, {row, detail, button});
      }
      paintActiveRow(job);
    }
    section.hidden = activeRows.size === 0;
    el('recent-outputs-open').textContent = activeRows.size ? 'Çıktılar · ' + activeRows.size + ' sürüyor' : 'Son çıktılar';
  }

  async function sendStopRequest(job) {
    try {
      await stop(job.cancelCredentials);
    } catch (error) {
      if (!isRunning(job)) return;
      job.stopping = false;
      job.stopError = error.message || 'Durdurma isteği gönderilemedi. Tekrar deneyin.';
      if (visible(job)) draw(job.kind);
      paintActiveRow(job);
    }
  }

  function requestStop(job) {
    if (!canStop(job) || job.stopping) return;
    job.stopping = true;
    job.stopError = null;
    if (visible(job)) draw(job.kind);
    paintActiveRow(job);
    if (job.cancelCredentials) void sendStopRequest(job);
  }

  function attach(job, id, token) {
    job.cancelCredentials = typeof id === 'string' && typeof token === 'string' && token
      ? {id, token} : null;
    if (job.stopping && job.cancelCredentials) void sendStopRequest(job);
    else if (!job.cancelCredentials) job.stopping = false;
    if (visible(job)) draw(job.kind);
    paintActiveRow(job);
  }

  function draw(kind) {
    const channel = channels[kind], output = latest.get(scopeKey(currentScope(kind)));
    const disabled = !available(kind), busy = active.has(kind);
    for (const id of channel.buttons) {
      const button = el(id);
      button.disabled = disabled;
      if (busy) button.setAttribute('aria-description', 'Bu türde bir çıktı hazırlanıyor.');
      else button.removeAttribute('aria-description');
    }
    paintStopButton(el(channel.stop), output);
    const file = output?.url && !output.saved ? output : null;
    for (const id of channel.links) setLink(el(id), file, desktop ? 'Kaydetme konumu seç' : 'Çıktıyı indir');
    if (kind === 'snapshot') {
      el('snapshot-status').textContent = output
        ? displayMessage(output) + (output.phase === 'running' && output.percent ? ' '+output.percent+'%' : '')
        : '';
      return;
    }
    const progress = el(channel.progress);
    progress.classList.toggle('hidden', !output);
    if (!output) {
      delete progress.dataset.state;
      progress.setAttribute('aria-valuenow', '0');
      progress.removeAttribute('aria-valuetext');
      return;
    }
    progress.dataset.state = output.phase;
    progress.setAttribute('aria-valuenow', String(output.percent));
    progress.setAttribute('aria-valuetext', displayMessage(output)+' · '+output.percent+'%');
    progress.querySelector('.h-full').style.width = output.percent+'%';
    progress.querySelector('p').textContent = output.percent+'%';
    const label = progress.querySelector('.render-progress-label');
    label.textContent = label.title = displayMessage(output);
  }

  function begin(kind, format, message) {
    if (!available(kind)) return null;
    const job = {...currentScope(kind), format, phase: 'running', percent: 0, message};
    const key = scopeKey(job);
    active.set(kind, job);
    el('active-output-announcement').textContent = '';
    latest.delete(key);
    latest.set(key, job);
    for (const [oldKey, oldJob] of latest) {
      if (latest.size <= recentLimit) break;
      if (active.get(oldJob.kind) !== oldJob) latest.delete(oldKey);
    }
    draw(kind);
    drawActive();
    return job;
  }

  function update(job, percent, message, phase = 'running') {
    job.percent = Math.round(Math.max(0, Math.min(100, Number(percent) || 0)));
    job.message = message;
    job.phase = phase;
    if (visible(job)) draw(job.kind);
    if (phase === 'running') {
      paintActiveRow(job);
    } else {
      if (phase === 'cancelled') el('active-output-announcement').textContent =
        [message, job.projectName, job.timelineName].filter(Boolean).join(' · ');
      drawActive();
    }
  }

  function drawRecent() {
    const list = el('recent-output-list');
    list.replaceChildren();
    el('recent-output-empty').hidden = recent.length > 0;
    for (const output of recent) {
      const row = document.createElement('li'), label = document.createElement('div'), detail = document.createElement('small'), link = document.createElement('a');
      label.textContent = channels[output.kind].label+' · '+output.format.toUpperCase();
      detail.textContent = [output.projectName, output.timelineName, new Date(output.completedAt).toLocaleString('tr-TR')].filter(Boolean).join(' · ');
      link.className = 'project-action';
      link.download = '';
      setLink(link, output, desktop ? 'Kaydet' : 'İndir');
      row.append(label, detail, link);
      list.append(row);
    }
  }

  function restoreRecent(items) {
    recent = Array.isArray(items) ? items.filter(item => item && Object.hasOwn(channels, item.kind) && validOutputUrl(item.url)
      && typeof item.format === 'string' && typeof item.projectName === 'string' && Number.isFinite(item.completedAt)).slice(0,recentLimit) : [];
    drawRecent();
  }

  function complete(job, url, message) {
    if (!validOutputUrl(url)) throw new Error('Sunucu geçerli bir çıktı bağlantısı döndürmedi.');
    job.url = url;
    const {kind, format, projectName, timelineName} = job;
    recent = [{kind, format, projectName, timelineName, url, completedAt: Date.now()}, ...recent.filter(item => item.url !== url)].slice(0, recentLimit);
    drawRecent();
    update(job, 100, message, 'complete');
  }

  function markSaved(output) {
    const job = [...latest.values()].find(item => item.url === output.url);
    if (!job) return;
    job.saved = true;
    update(job, 100, 'Dosya kaydedildi', 'complete');
  }

  function finish(job) {
    if (active.get(job.kind) === job) active.delete(job.kind);
    draw(job.kind);
    drawActive();
  }

  return {
    available, visible, begin, attach, update, complete, finish, markSaved, restoreRecent,
    recent: () => recent,
    draw: kind => kind ? draw(kind) : Object.keys(channels).forEach(draw)
  };
}
