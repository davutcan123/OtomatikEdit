'use strict';
const byId = id => document.getElementById(id);
const names = { manual: 'Editör', auto: 'Oto. kesim', backend: 'Motor', app: 'Uygulama' };
let entries = [], cursor = 0, loading = false, pending = false, visible = [];
function draw() {
  const query = byId('search').value.toLocaleLowerCase('tr'), source = byId('source').value, level = byId('level').value;
  visible = entries.filter(entry => (source === 'all' || entry.source === source) && (level === 'all' || entry.level === level) && entry.message.toLocaleLowerCase('tr').includes(query));
  const box = byId('records'), oldScroll = box.scrollTop, fragment = document.createDocumentFragment();
  for (const entry of visible) {
    const row = document.createElement('div'), time = document.createElement('time'), sourceLabel = document.createElement('span'), message = document.createElement('span');
    row.className = 'row ' + entry.level; time.dateTime = entry.time;
    time.textContent = new Date(entry.time).toLocaleTimeString('tr-TR'); time.title = entry.time;
    sourceLabel.className = 'source'; sourceLabel.textContent = names[entry.source] || 'Uygulama';
    message.className = 'message'; message.textContent = entry.message;
    row.append(time, sourceLabel, message); fragment.appendChild(row);
  }
  if (!visible.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Bu filtreye uygun kayıt yok.'; fragment.appendChild(empty); }
  box.replaceChildren(fragment);
  byId('count').textContent = `${visible.length} / ${entries.length} kayıt · Bu oturumun son kayıtları`;
  box.scrollTop = byId('follow').checked ? box.scrollHeight : oldScroll;
}
async function refresh() {
  if (loading) { pending = true; return; }
  loading = true;
  try {
    do {
      pending = false;
      const batch = await window.terminalView.read(cursor);
      entries = entries.filter(entry => entry.id >= batch.firstId).concat(batch.entries).slice(-batch.limit);
      cursor = batch.lastId; draw();
    } while (pending);
  } catch { byId('status').textContent = 'Günlük bağlantısı kurulamadı.'; }
  finally { loading = false; }
}
byId('search').addEventListener('input', draw);
byId('source').addEventListener('change', draw);
byId('level').addEventListener('change', draw);
byId('follow').addEventListener('change', draw);
byId('copy').addEventListener('click', async () => {
  try { await window.terminalView.copy(visible.map(entry => `[${entry.time}] [${names[entry.source] || 'Uygulama'}] ${entry.message}`).join('\n')); byId('status').textContent = 'Görünen kayıtlar kopyalandı.'; }
  catch { byId('status').textContent = 'Kayıtlar kopyalanamadı.'; }
});
window.terminalView.onChange(refresh);
refresh();
