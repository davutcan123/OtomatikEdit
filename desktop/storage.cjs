'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateRecovery } = require('./security.cjs');

function outputFile(relativeURL, dataDir) {
  if (typeof relativeURL !== 'string') throw new Error('Geçersiz çıktı bağlantısı.');
  const match = /^\/download\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(mp4|mkv|mov|webm|mp3|gif|png)$/.exec(relativeURL);
  if (!match) throw new Error('Geçersiz çıktı bağlantısı.');
  return { source: path.join(dataDir, 'outputs', `out_${match[1]}.${match[2]}`), extension: match[2] };
}
async function requireOutput(source, dataDir) {
  const info = await fsp.lstat(source);
  const parent = await fsp.realpath(path.join(dataDir, 'outputs'));
  if (!info.isFile() || path.dirname(await fsp.realpath(source)) !== parent) throw new Error('Çıktı dosyası bulunamadı.');
}
async function copyOutput(source, destination) {
  if (path.resolve(source) === path.resolve(destination)) return;
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}-${crypto.randomUUID()}.tmp`);
  try {
    await fsp.copyFile(source, temp, fs.constants.COPYFILE_EXCL);
    const handle = await fsp.open(temp, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    // The native save dialog has already confirmed replacing this exact file.
    await fsp.rename(temp, destination);
  } finally { await fsp.unlink(temp).catch(() => {}); }
}
async function copyNew(source, destination) {
  if (fs.existsSync(destination)) return false;
  const temp = path.join(path.dirname(destination), `.migration-${crypto.randomUUID()}.tmp`);
  try {
    await fsp.copyFile(source, temp, fs.constants.COPYFILE_EXCL);
    try { await fsp.link(temp, destination); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally { await fsp.unlink(temp).catch(() => {}); }
}
function referencedMedia(value, result = new Set()) {
  if (Array.isArray(value)) value.forEach(item => referencedMedia(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => referencedMedia(item, result));
  else if (typeof value === 'string') {
    let candidate = value;
    if (candidate.startsWith('/video/')) { try { candidate = decodeURIComponent(candidate.slice(7)); } catch { return result; } }
    if (candidate && candidate !== '.' && candidate !== '..' && !/[\\/\0]/.test(candidate)) result.add(candidate);
  }
  return result;
}
async function prepareLibrary(dataDir, previousDir) {
  await Promise.all(['projects', 'uploads', 'outputs'].map(folder => fsp.mkdir(path.join(dataDir, folder), { recursive: true })));
  if (!previousDir || path.resolve(previousDir) === path.resolve(dataDir)) return;
  const marker = path.join(dataDir, '.desktop-library-migrated.json');
  if (fs.existsSync(marker)) return;
  const saved = await fsp.readdir(path.join(previousDir, 'projects')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const files = saved.filter(name => name.endsWith('.json')).map(name => path.join('projects', name));
  files.push('recovery.json', 'recovery.previous.json');
  for (const relative of files) {
    const source = path.join(previousDir, relative);
    if (!fs.existsSync(source) || !(await fsp.lstat(source)).isFile()) continue;
    let snapshot;
    try { snapshot = JSON.parse(validateRecovery(await fsp.readFile(source, 'utf8'))); }
    catch { continue; } // Keep corrupt legacy files untouched for manual recovery.
    if (!Array.isArray(snapshot.timelines)) continue;
    for (const id of referencedMedia(snapshot)) {
      const media = path.join(previousDir, 'uploads', id);
      if (fs.existsSync(media) && (await fsp.lstat(media)).isFile()) await copyNew(media, path.join(dataDir, 'uploads', id));
    }
    await copyNew(source, path.join(dataDir, relative));
  }
  await fsp.writeFile(marker, JSON.stringify({ from: previousDir, date: new Date().toISOString() }), { flag: 'wx' });
}
module.exports = { outputFile, requireOutput, copyOutput, referencedMedia, prepareLibrary };
