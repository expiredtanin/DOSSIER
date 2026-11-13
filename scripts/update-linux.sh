#!/usr/bin/env bash
# update-linux.sh — bringt einen Dossier-Checkout auf den neusten Stand von `master`, baut, was nötig ist,
# und räumt danach auf (Wunsch Maintainer 13.11.: „eine .sh, die es auf den aktuellen Stand bringt und
# anschliessend alles bereinigt“).
#
#   ./scripts/update-linux.sh               holen, bauen, aufräumen
#   ./scripts/update-linux.sh --start       … und danach Dossier starten (npm run electron)
#   ./scripts/update-linux.sh --appimage    … und zusätzlich ein AppImage bauen (release/)
#   ./scripts/update-linux.sh --keep-build  Rust-Zwischendateien behalten (nächster Build schneller, ~3–8 GB)
#   ./scripts/update-linux.sh --tester      Test-Rechner: AppImage bauen, danach ALLES zum Bauen Nötige löschen
#                                           (node_modules, dist, npm-/Cargo-Caches); `dossier` startet dann das AppImage.
#                                           Bleibt: Quellcode (git), release/Dossier-*.AppImage, die Rust-Toolchain.
#   ./scripts/update-linux.sh --branch X    anderen Zweig statt master
#
# Was bleibt: node_modules (Start der App), src/engine/pkg* (gebaute WASM-Pakete, ~40 MB), die Rust-Toolchain.
# Was gelöscht wird: src-tauri/**/target (Zwischendateien), der Download-Cache von Cargo, dist-test/, test-results/.
# Lokale Änderungen im Checkout werden NICHT überschrieben: dann bricht das Skript mit einem Hinweis ab.

set -euo pipefail

BRANCH="master"
START=0
APPIMAGE=0
KEEP_BUILD=0
TESTER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --start) START=1 ;;
    --appimage) APPIMAGE=1 ;;
    --keep-build) KEEP_BUILD=1 ;;
    --tester) TESTER=1; APPIMAGE=1 ;;
    --branch) shift; BRANCH="${1:?--branch braucht einen Namen}" ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1 (siehe --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m[dossier] %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m[dossier] %s\033[0m\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")/.."

say "Werkzeuge prüfen"
missing=()
for tool in git node npm cargo rustup wasm-pack cc; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
  die "Es fehlt: ${missing[*]}. Void: sudo xbps-install -S base-devel nodejs git rustup; dann rustup-init -y, rustup target add wasm32-unknown-unknown, cargo install wasm-pack."
fi
rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown || {
  say "WebAssembly-Ziel fehlt → rustup target add wasm32-unknown-unknown"
  rustup target add wasm32-unknown-unknown
}

say "Neuster Stand von $BRANCH holen"
# Was npm/Build selbst verändern (z. B. package-lock.json nach npm install), ist keine eigene Arbeit: zurücksetzen.
for f in package-lock.json src/model/types.generated.ts; do
  git diff --quiet -- "$f" 2>/dev/null || { echo "setze $f zurück (vom Build verändert)"; git checkout -q -- "$f"; }
done
if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short
  die "Im Checkout gibt es lokale Änderungen (oben). Sichern: git stash   — oder verwerfen: git checkout -- <datei> (alles: git reset --hard). Dann erneut starten."
fi
git fetch --prune origin "$BRANCH"
git checkout -q "$BRANCH"
before=$(git rev-parse HEAD)
git merge --ff-only -q "origin/$BRANCH"
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then
  echo "Schon aktuell ($(git log -1 --format='%h %s'))."
else
  git log --oneline "$before..$after" | head -20
fi

say "Node-Pakete"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ] || ! git diff --quiet "$before" "$after" -- package.json package-lock.json; then
  # npm ci: installiert genau nach package-lock.json und verändert sie nicht (npm install schrieb sie je nach npm-Version um)
  npm ci --no-audit --no-fund
else
  echo "unverändert."
fi

say "WASM-Pakete bauen (nur veraltete)"
CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-$(nproc 2>/dev/null || echo 2)}" node scripts/wasm-fresh.mjs

if [ "$APPIMAGE" = 1 ]; then
  say "AppImage bauen"
  npm run build
  npm run electron:pack
  ls -1 release/*.AppImage 2>/dev/null | tail -1
fi

say "Aufräumen"
if [ "$KEEP_BUILD" = 0 ]; then
  freed=$(du -sch src-tauri/target src-tauri/*/target 2>/dev/null | tail -1 | cut -f1 || true)
  rm -rf src-tauri/target src-tauri/*/target
  echo "Rust-Zwischendateien gelöscht (${freed:-0})."
fi
rm -rf "${CARGO_HOME:-$HOME/.cargo}/registry/cache" "${CARGO_HOME:-$HOME/.cargo}/git/checkouts" dist-test test-results
echo "Cargo-Download-Cache, dist-test/ und test-results/ gelöscht."
if [ "$TESTER" = 1 ]; then
  # Nur zum Bauen nötig — das AppImage enthält alles, was die App braucht.
  rm -rf node_modules dist release/*-unpacked release/builder-*.yml release/latest*.yml
  npm cache clean --force >/dev/null 2>&1 || true
  rm -rf "${CARGO_HOME:-$HOME/.cargo}/registry/src" "${CARGO_HOME:-$HOME/.cargo}/registry/index"
  rm -rf "$HOME/.cache/puppeteer" "$HOME/.cache/ms-playwright" "$HOME/.cache/electron-builder"
  echo "Test-Rechner: node_modules, dist, npm-/Cargo-/Browser-Caches gelöscht (beim nächsten Update wieder geladen)."
  du -sh release/*.AppImage 2>/dev/null | sed 's/^/  bleibt: /'
else
  du -sh node_modules src/engine 2>/dev/null | sed 's/^/  bleibt: /'
fi

say "Fertig: $(git log -1 --format='%h %s')"
if [ "$TESTER" = 1 ]; then
  app=$(ls -1t release/Dossier-*.AppImage 2>/dev/null | head -1)
  [ "$START" = 1 ] && exec "$app"
  echo "Starten mit: $app   (oder: dossier)"
elif [ "$START" = 1 ]; then
  exec npm run electron
else
  echo "Starten mit: npm run electron"
fi
