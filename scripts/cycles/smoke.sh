#!/usr/bin/env bash
# [215] Rauchtest für ein gebautes Cycles-Paket (CI, nach dem Bau): kleine Szene (spike-scene.py) mit 4 Samples rendern,
# PNG-Kopf und die Fortschrittszeilen prüfen. Läuft auf der CPU (gehostete CI-Runner haben keine GPU).
#   scripts/cycles/smoke.sh <dist-Ordner>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="${1:?dist-Ordner}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
python3 "$HERE/spike-scene.py" "$T/haus.xml" >/dev/null
( cd "$T" && "$DIST/cycles" --background --device CPU --samples 4 --width 160 --height 90 --output out.png haus.xml ) 2>&1 | tr '\r' '\n' | tee "$T/log.txt" | tail -8
grep -q "Sample 4/4" "$T/log.txt" || { echo "smoke: keine Fortschrittszeile 'Sample 4/4'"; exit 1; }
[ "$(head -c 8 "$T/out.png" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] || { echo "smoke: out.png ist kein PNG"; exit 1; }
echo "smoke: ok ($(wc -c < "$T/out.png") Bytes PNG)"
