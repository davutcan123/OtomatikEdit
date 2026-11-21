#!/bin/bash
# Validate a committed release checkout before dispatching the desktop workflow.
set -euo pipefail
cd "$(dirname "$0")"

version="${1:-}"
if [[ $# != 1 || ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'Kullanım: ./release.sh <sürüm>\n' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Sürüm kontrolü için temiz bir çalışma ağacı gerekiyor.\n' >&2
  exit 1
fi

node - "$version" <<'NODE'
const assert = require('node:assert/strict');
const version = process.argv[2];
const lock = require('./package-lock.json');
for (const [file, actual] of [
  ['version.json', require('./version.json').version],
  ['package.json', require('./package.json').version],
  ['package-lock.json', lock.version],
  ['package-lock.json packages[""]', lock.packages[''].version],
]) {
  assert.equal(actual, version, `${file}: sürüm numarası uyuşmuyor`);
}
NODE
printf 'v%s sürümü %s revizyonunda doğrulandı.\n' "$version" "$(git rev-parse HEAD)"
printf 'GitHub Actions → Build desktop installers → Run workflow üzerinden bu revizyonu seçip prepare_release seçeneğini açın.\n'
printf 'Kontroller tamamlandığında oluşturulan sürüm taslağını GitHub üzerinden inceleyebilirsiniz.\n'
