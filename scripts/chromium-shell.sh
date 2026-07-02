#!/usr/bin/env bash
# chromium-shell.sh — startet die CAD-Oberfläche in einem randlosen
# Chromium-App-Fenster statt im Tauri-Webview.
#
# Hintergrund: Tauris Linux-Webview ist WebKitGTK, das SVG/2D auf der CPU
# (Cairo) rastert und bei hoher Bildwiederholrate sichtbar ruckelt. Chromium
# rendert dieselbe Seite butterweich (GPU-beschleunigt). Bis ein nativer
# wgpu-Renderer oder ein Electron/CEF-Shell fertig ist, ist dieses Script der
# schnellste Weg zu einer flüssigen Oberfläche für Vorführungen/Entwicklung.
#
# Ablauf:
#   1. Prüft, ob der Vite-Dev-Server auf dem konfigurierten Port bereits
#      lauscht; falls nicht, startet es ihn selbst und wartet per Polling.
#   2. Öffnet den Dev-Server im App-Modus (kein Tab/URL-Leiste) im ersten
#      gefundenen Chromium-basierten Browser.
#   3. Hat es den Dev-Server selbst gestartet, beendet es ihn wieder, sobald
#      das Browserfenster geschlossen wird.

set -u

PORT=5187
URL="http://localhost:${PORT}"
PROFILE_DIR="${HOME}/.cache/cad-chromium-shell"

# ── Browser-Suche (Reihenfolge wie vorgegeben) ────────────────────────────────
BROWSER_BIN=""
for candidate in chromium chromium-browser google-chrome-stable google-chrome brave vivaldi; do
  if command -v "${candidate}" >/dev/null 2>&1; then
    BROWSER_BIN="${candidate}"
    break
  fi
done

if [ -z "${BROWSER_BIN}" ]; then
  echo "chromium-shell: kein Chromium-basierter Browser gefunden." >&2
  echo "Gesucht wurden: chromium, chromium-browser, google-chrome-stable, google-chrome, brave, vivaldi." >&2
  echo "Bitte einen dieser Browser installieren, um die flüssige App-Shell zu nutzen." >&2
  exit 1
fi

# ── Dev-Server sicherstellen ───────────────────────────────────────────────────
DEV_SERVER_PID=""

server_is_up() {
  curl --silent --fail --max-time 1 --output /dev/null "${URL}"
}

if server_is_up; then
  echo "chromium-shell: Dev-Server läuft bereits auf ${URL}."
else
  echo "chromium-shell: starte Vite-Dev-Server (Port ${PORT}) …"
  npm run dev >/tmp/cad-chromium-shell-dev.log 2>&1 &
  DEV_SERVER_PID=$!

  ATTEMPTS=0
  MAX_ATTEMPTS=60
  until server_is_up; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "${ATTEMPTS}" -ge "${MAX_ATTEMPTS}" ]; then
      echo "chromium-shell: Dev-Server antwortet nach ${MAX_ATTEMPTS}s nicht, Abbruch." >&2
      kill "${DEV_SERVER_PID}" 2>/dev/null
      exit 1
    fi
    sleep 1
  done
  echo "chromium-shell: Dev-Server bereit."
fi

cleanup() {
  if [ -n "${DEV_SERVER_PID}" ]; then
    echo "chromium-shell: beende selbst gestarteten Dev-Server (PID ${DEV_SERVER_PID}) …"
    kill "${DEV_SERVER_PID}" 2>/dev/null
    wait "${DEV_SERVER_PID}" 2>/dev/null
  fi
}
trap cleanup EXIT

mkdir -p "${PROFILE_DIR}"

echo "chromium-shell: öffne ${URL} in ${BROWSER_BIN} (App-Modus) …"
"${BROWSER_BIN}" \
  --app="${URL}" \
  --user-data-dir="${PROFILE_DIR}" \
  --window-size=1600,1000 \
  >/tmp/cad-chromium-shell-browser.log 2>&1

# Läuft weiter, bis der Browserprozess (das App-Fenster) beendet wird; dann
# räumt der trap oben den selbst gestarteten Dev-Server auf.
