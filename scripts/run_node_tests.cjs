'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['desktop', 'tests'].flatMap(folder => fs.readdirSync(path.join(root, folder))
  .filter(name => folder === 'desktop' ? name.endsWith('.test.cjs') : name.endsWith('.cjs') && !name.endsWith('.electron.cjs'))
  .map(name => path.join(root, folder, name)));
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
