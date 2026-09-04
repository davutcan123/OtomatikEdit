#!/bin/bash
# ═══════════════════════════════════════════════════════
#  Otamatik Edit — GitHub Release Yayınlama Betiği
#  Kullanım:  ./release.sh 1.2.0 "Açıklama (opsiyonel)"
# ═══════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

# ── Argümanlar ──────────────────────────────────────────
VERSION="${1:-}"
NOTES="${2:-Sürüm $VERSION yayınlandı.}"

if [ -z "$VERSION" ]; then
  echo "❌  Kullanım: ./release.sh <sürüm> [\"açıklama\"]"
  echo "    Örnek:   ./release.sh 1.2.0 \"Yeni filtreler eklendi\""
  exit 1
fi

# ── Ön kontroller ──────────────────────────────────────
if ! command -v gh &>/dev/null; then
  echo "❌  GitHub CLI (gh) bulunamadı. Kur: brew install gh"
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "⚠️  GitHub'a giriş yapılmamış. Şimdi giriş yapılıyor..."
  gh auth login
fi

# ── Repo kontrolü ──────────────────────────────────────
if [ ! -d ".git" ]; then
  echo "📦  Git deposu başlatılıyor..."
  git init
  git add -A
  git commit -m "İlk commit — v${VERSION}"
fi

REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
if [ -z "$REMOTE_URL" ]; then
  echo ""
  echo "⚠️  Henüz GitHub remote'u yok."
  echo "    Önce GitHub'da bir repo oluşturun, sonra şu komutu çalıştırın:"
  echo ""
  echo "    git remote add origin https://github.com/KULLANICI/REPO.git"
  echo ""
  echo "    Veya gh ile hızlıca oluşturun:"
  echo "    gh repo create OtomatikEdit --private --source=. --remote=origin --push"
  echo ""
  exit 1
fi

# ── version.json güncelle ──────────────────────────────
echo "{
  \"version\": \"${VERSION}\",
  \"release_date\": \"$(date +%Y-%m-%d)\"
}" > version.json

# ── ZIP oluştur (kullanıcı verilerini hariç tut) ──────
ZIP_NAME="OtomatikEdit-v${VERSION}.zip"
TEMP_ZIP="/tmp/${ZIP_NAME}"
rm -f "$TEMP_ZIP"

echo "📦  Release ZIP hazırlanıyor..."
zip -r "$TEMP_ZIP" . \
  -x "venv/*" \
  -x ".venv-windows/*" \
  -x "uploads/*" \
  -x "outputs/*" \
  -x "projects/*" \
  -x "tools/*" \
  -x "__pycache__/*" \
  -x ".backup/*" \
  -x ".git/*" \
  -x ".DS_Store" \
  -x "*.pyc"

# ── Git commit + tag ──────────────────────────────────
echo "🏷️  Git tag: v${VERSION}"
git add -A
git commit -m "v${VERSION}: ${NOTES}" --allow-empty
git tag -f "v${VERSION}"
git push origin main --tags 2>/dev/null || git push origin master --tags 2>/dev/null || git push --tags

# ── GitHub Release yayınla ────────────────────────────
echo "🚀  GitHub Release yayınlanıyor..."
gh release create "v${VERSION}" "$TEMP_ZIP" \
  --title "v${VERSION}" \
  --notes "$NOTES" \
  --latest

rm -f "$TEMP_ZIP"

echo ""
echo "✅  v${VERSION} başarıyla yayınlandı!"
echo "    Kardeşinizin uygulaması açıldığında güncelleme bildirimi görecek."
