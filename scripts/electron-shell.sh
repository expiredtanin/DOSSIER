#!/usr/bin/env bash
# electron-shell.sh — startet die CAD-Oberfläche im Electron-Prototyp-Fenster.
#
# Wie chromium-shell.sh: stellt sicher, dass der Vite-Dev-Server läuft, startet
# ihn sonst selbst und beendet ihn wieder, sobald das Electron-Fenster schliesst.

set -u

PORT=5187
URL="http://localhost:${PORT}"

server_is_up() {
  curl --silent --fail --max-time 1 --output /dev/null "${URL}"
}

DEV_SERVER_PID=""

if server_is_up; then
  echo "electron-shell: Dev-Server läuft bereits auf ${URL}."
else
  echo "electron-shell: starte Vite-Dev-Server (Port ${PORT}) …"
  # vite direkt starten: bei "npm run dev" wäre $! nur npm, und vite bliebe beim Beenden übrig.
  node_modules/.bin/vite >/tmp/cad-electron-shell-dev.log 2>&1 &
  DEV_SERVER_PID=$!

  ATTEMPTS=0
  MAX_ATTEMPTS=60
  until server_is_up; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "${ATTEMPTS}" -ge "${MAX_ATTEMPTS}" ]; then
      echo "electron-shell: Dev-Server antwortet nach ${MAX_ATTEMPTS}s nicht, Abbruch." >&2
      kill "${DEV_SERVER_PID}" 2>/dev/null
      exit 1
    fi
    sleep 1
  done
  echo "electron-shell: Dev-Server bereit."
fi

cleanup() {
  if [ -n "${DEV_SERVER_PID}" ]; then
    echo "electron-shell: beende selbst gestarteten Dev-Server (PID ${DEV_SERVER_PID}) …"
    kill "${DEV_SERVER_PID}" 2>/dev/null
    wait "${DEV_SERVER_PID}" 2>/dev/null
  fi
}
trap cleanup EXIT

echo "electron-shell: öffne Electron-Fenster …"
# Unter Wayland: Chromiums Vulkan (WebGPU) läuft nur über XWayland (`--ozone-platform=x11`); DOSSIER_OZONE übersteuert.
OZONE="${DOSSIER_OZONE:-}"
if [ -z "$OZONE" ] && { [ -n "${WAYLAND_DISPLAY:-}" ] || [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; }; then OZONE=x11; fi
npx electron ${OZONE:+--ozone-platform=$OZONE} "$(dirname "$0")/electron-main.cjs"
