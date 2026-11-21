'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const electron = require('electron');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'tests');
const files = fs.readdirSync(directory, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.electron.cjs'))
  .map(entry => entry.name)
  .sort();
if (!files.length) throw new Error('No native Electron tests found.');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

for (const file of files) {
  console.log(`Running ${file}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'otomatik-electron-test-'));
  try {
    const result = spawnSync(electron, [
      path.join(__dirname, 'electron_test_entry.cjs'),
      path.join(directory, file),
      profile,
    ], { cwd: root, env, stdio: 'inherit', timeout: 240_000, killSignal: 'SIGKILL' });
    if (result.error) throw new Error(`${file}: ${result.error.message}`, { cause: result.error });
    if (result.status !== 0) throw new Error(`${file}: Electron exited with ${result.signal || result.status}`);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

console.log(`Passed ${files.length} native Electron tests.`);
