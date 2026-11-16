#!/usr/bin/env bash
# [215] ENTWURF — Cycles-Standalone für macOS arm64 (Apple Silicon, Metal-GPU + CPU). NICHT AUSGEFÜHRT:
# im Linux-Container gibt es weder Xcode noch Metal. Der Maintainer prüft das auf dem Mac; Abweichungen in
# doc/CYCLES.md nachtragen.
#
#   scripts/cycles/build-macos.sh [Arbeitsordner]      (Standard: $HOME/cycles-build)
#
# Voraussetzungen: Xcode (nicht nur Command Line Tools: Metal-Header/SDK >= 12), `brew install cmake ninja git git-lfs`.
# Weg A (hier): die offiziellen vorgebauten Bibliotheken von Blender (Submodul lib/macos_arm64, per git-lfs,
# nur dieser eine Ordner; OpenImageIO, OpenColorIO, Embree, OIDN, TBB, OpenEXR … in einer fixen, geprüften Kombination).
# Das ist der Weg, den auch das Blender-Projekt für seine Mac-Builds nutzt. Weg B (Homebrew-Pakete) wäre
# schneller eingerichtet, zieht aber ffmpeg/GDAL … (wie unter Linux) und wechselt mit jeder brew-Version.
#
# Metal: Cycles übersetzt die GPU-Kernel zur Laufzeit aus den Quellen im Ordner `source/` neben dem Programm
# (install/source/kernel/…) und legt sie im Benutzer-Cache ab — der erste Render braucht ein paar Minuten, danach
# lädt es sofort. Der Ordner `source/` muss deshalb in die App (Sidecar-Ressource) und die Kernel-Cache-Ablage
# muss beschreibbar sein (Cycles: path_cache_get → ~/Library/Caches bzw. --cache-Ordner der App).
set -euo pipefail

CYCLES_TAG="${CYCLES_TAG:-v5.3.0}"
WORK="$(mkdir -p "${1:-$HOME/cycles-build}" && cd "${1:-$HOME/cycles-build}" && pwd)"
OUT="$WORK/dist"

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "nur macOS arm64"; exit 1; }
xcrun --sdk macosx --show-sdk-path >/dev/null || { echo "Xcode fehlt"; exit 1; }
git lfs install --skip-repo

mkdir -p "$WORK/src"
[ -d "$WORK/src/cycles" ] || git clone --depth 1 --branch "$CYCLES_TAG" https://projects.blender.org/blender/cycles.git "$WORK/src/cycles"
cd "$WORK/src/cycles"
make update            # holt lib/macos_arm64 (git-lfs, mehrere GB, einmalig)

# Standard-Konfiguration des Projekts, aber ohne unnötiges: kein OSL/USD/Hydra/Alembic/OpenVDB/OpenSubdiv.
# WITH_CYCLES_DEVICE_METAL ist auf dem Mac Standard (AN). OIDN läuft mit den Blender-Bibliotheken auf CPU/GPU.
cmake -G Ninja -S . -B "$WORK/build-cycles" -DCMAKE_BUILD_TYPE=Release \
  -DWITH_CYCLES_OSL=OFF -DWITH_CYCLES_USD=OFF -DWITH_CYCLES_HYDRA_RENDER_DELEGATE=OFF -DWITH_CYCLES_ALEMBIC=OFF \
  -DWITH_CYCLES_OPENVDB=OFF -DWITH_CYCLES_NANOVDB=OFF -DWITH_CYCLES_OPENSUBDIV=OFF -DWITH_CYCLES_STANDALONE_GUI=OFF \
  -DWITH_CYCLES_DEVICE_METAL=ON -DWITH_CYCLES_EMBREE=ON -DWITH_CYCLES_OPENIMAGEDENOISE=ON \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DCMAKE_INSTALL_PREFIX="$OUT"
cmake --build "$WORK/build-cycles" --target install -j"$(sysctl -n hw.ncpu)"

# Ergebnis prüfen: Programm, mitinstallierte Bibliotheken (install/lib), Kernel-Quellen (install/source)
ls -la "$OUT" "$OUT/lib" 2>/dev/null | head -40
du -sh "$OUT" "$OUT/source" 2>/dev/null || true
otool -L "$OUT/cycles" | head -30
"$OUT/cycles" --version
"$OUT/cycles" --list-devices      # erwartet: CPU + Apple-GPU (Metal)

# Danach (für die App, nicht Teil dieses Skripts): strip, `codesign --options runtime --timestamp` aller Mach-O-Dateien
# mit der Developer-ID der App, Eintrag in tauri.conf.json (bundle.externalBin: cycles-aarch64-apple-darwin + resources: source/**).
