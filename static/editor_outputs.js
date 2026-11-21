function createEditorOutputJobs({el, document, currentScope, canStart, save, desktop}) {
  const channels = {
    manual: {buttons: ['manual-render', 'manual-render-top', 'export-render-start'], links: ['manual-download', 'manual-download-top'], progress: 'manual-progress-top', label: 'Video'},
    snapshot: {buttons: ['snapshot-open', 'snapshot-save'], links: ['snapshot-download'], label: 'Ekran görüntüsü'},
    auto: {buttons: ['auto-render'], links: ['auto-download'], progress: 'auto-progress', label: 'Otomatik kesim'}
  };
  const active = new Map(), latest = new Map();
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

  function draw(kind) {
    const channel = channels[kind], output = latest.get(scopeKey(currentScope(kind)));
    const disabled = !available(kind), busy = active.has(kind);
    for (const id of channel.buttons) {
      const button = el(id);
      button.disabled = disabled;
      if (busy) button.setAttribute('aria-description', 'Bu türde bir çıktı hazırlanıyor.');
      else button.removeAttribute('aria-description');
    }
    const file = output?.url && !output.saved ? output : null;
    for (const id of channel.links) setLink(el(id), file, desktop ? 'Kaydetme konumu seç' : 'Çıktıyı indir');
    if (kind === 'snapshot') {
      el('snapshot-status').textContent = output
        ? output.message + (output.phase === 'running' && output.percent ? ' '+output.percent+'%' : '')
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
    progress.setAttribute('aria-valuetext', output.message+' · '+output.percent+'%');
    progress.querySelector('.h-full').style.width = output.percent+'%';
    progress.querySelector('p').textContent = output.percent+'%';
    const label = progress.querySelector('.render-progress-label');
    label.textContent = label.title = output.message;
  }

  function begin(kind, format, message) {
    if (!available(kind)) return null;
    const job = {...currentScope(kind), format, phase: 'running', percent: 0, message};
    const key = scopeKey(job);
    active.set(kind, job);
    latest.delete(key);
    latest.set(key, job);
    for (const [oldKey, oldJob] of latest) {
      if (latest.size <= recentLimit) break;
      if (active.get(oldJob.kind) !== oldJob) latest.delete(oldKey);
    }
    draw(kind);
    return job;
  }

  function update(job, percent, message, phase = 'running') {
    job.percent = Math.round(Math.max(0, Math.min(100, Number(percent) || 0)));
    job.message = message;
    job.phase = phase;
    if (visible(job)) draw(job.kind);
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
  }

  return {
    available, visible, begin, update, complete, finish, markSaved, restoreRecent,
    recent: () => recent,
    draw: kind => kind ? draw(kind) : Object.keys(channels).forEach(draw)
  };
}
