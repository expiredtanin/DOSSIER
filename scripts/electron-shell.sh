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
  npm run dev >/tmp/cad-electron-shell-dev.log 2>&1 &
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
npx electron "$(dirname "$0")/electron-main.cjs"
