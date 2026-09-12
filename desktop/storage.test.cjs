const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { outputFile, requireOutput, copyOutput, referencedMedia, prepareLibrary } = require('./storage.cjs');
const job = 'cd05af0b-7972-421e-a379-739a24ab04f2';
test('native save accepts only exact generated output routes', () => {
  assert.equal(outputFile(`/download/${job}/png`, '/data').extension, 'png');
  for (const route of [`http://localhost/download/${job}/mp4`, `/download/../../private/mp4`, `/download/${job}/mp4?x=1`, `/download/${job}/exe`, `/video/file.mp4`, null]) assert.throws(() => outputFile(route, '/data'));
});
test('project library migrates saved and unsaved work without overwriting or deleting originals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-storage-test-'));
  const old = path.join(root, 'old'), current = path.join(root, 'new');
  try {
    await fs.mkdir(path.join(old, 'projects'), { recursive: true });
    await fs.mkdir(path.join(old, 'uploads'));
    const project = JSON.stringify({ name: 'Eski', timelines: [{ state: { clips: [{ fileId: 'video.mp4' }] } }] });
    await fs.writeFile(path.join(old, 'projects', 'one.json'), project);
    await fs.writeFile(path.join(old, 'recovery.json'), JSON.stringify({ name: 'Kaydedilmemiş', timelines: [], mediaAssets: [{ src: '/video/foto%20%C3%A7.png' }] }));
    await fs.writeFile(path.join(old, 'uploads', 'video.mp4'), 'old video');
    await fs.writeFile(path.join(old, 'uploads', 'foto ç.png'), 'image');
    await fs.mkdir(path.join(current, 'projects'), { recursive: true });
    await fs.writeFile(path.join(current, 'projects', 'one.json'), 'newer');
    await prepareLibrary(current, old);
    assert.equal(await fs.readFile(path.join(current, 'projects', 'one.json'), 'utf8'), 'newer');
    assert.equal(await fs.readFile(path.join(current, 'uploads', 'video.mp4'), 'utf8'), 'old video');
    assert.equal(await fs.readFile(path.join(current, 'uploads', 'foto ç.png'), 'utf8'), 'image');
    assert.equal(JSON.parse(await fs.readFile(path.join(current, 'recovery.json'))).name, 'Kaydedilmemiş');
    assert.equal(await fs.readFile(path.join(old, 'projects', 'one.json'), 'utf8'), project);
    await prepareLibrary(current, old);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('saved output replaces only the chosen destination and leaves source intact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-output-test-'));
  try {
    await prepareLibrary(root);
    const { source } = outputFile(`/download/${job}/mp4`, root);
    await fs.writeFile(source, 'rendered video');
    await requireOutput(source, root);
    const destination = path.join(root, 'chosen.mp4');
    await fs.writeFile(destination, 'older export');
    await copyOutput(source, destination);
    assert.equal(await fs.readFile(destination, 'utf8'), 'rendered video');
    assert.equal(await fs.readFile(source, 'utf8'), 'rendered video');
    await copyOutput(source, source);
    assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.tmp')).length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('legacy media discovery rejects traversal and preserves Turkish filenames', () => {
  assert.deepEqual([...referencedMedia(['/video/foto%20%C3%A7.png', '../private', 'a\\b', '..'])], ['foto ç.png']);
});
