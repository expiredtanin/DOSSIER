#!/usr/bin/env bash
# [215] Cycles-Standalone für macOS arm64 (Apple Silicon, Metal-GPU + CPU) bauen — Ergebnis in $WORK/dist, danach
# scripts/cycles/pack.sh <dist> macos arm64. STAND: für den CI-Lauf (macos-14, .github/workflows/cycles.yml) geschrieben,
# im Linux-Container NICHT ausgeführt (kein Xcode/Metal). Der erste echte Lauf zeigt die Abweichungen; in doc/CYCLES.md nachtragen.
#
#   scripts/cycles/build-macos.sh [Arbeitsordner]      (Standard: $HOME/cycles-build)
#
# Voraussetzungen: Xcode (nicht nur Command Line Tools), `brew install cmake ninja git git-lfs`.
# Weg A (hier): Blenders vorgebaute Bibliotheken (`make update` holt lib/macos_arm64 per git-lfs: OpenImageIO, Embree, OIDN,
# TBB, OpenEXR … in einer fixen, geprüften Kombination). Weg B (Homebrew) zieht ffmpeg/GDAL … und wechselt mit jeder Version.
#
# Layout des Pakets (Wurzel `cycles/` im Archiv):
#   cycles            Programm; RPATH @executable_path/lib (Paket, lokal) UND @executable_path/../Resources/cycles/lib (in der App)
#   lib/*.dylib       nur Nicht-System-Bibliotheken; Kennung @rpath/<name>, eigener RPATH @loader_path
#   source/           Metal-Kernel-Quellen: Cycles übersetzt die GPU-Kernel zur Laufzeit daraus (erster GPU-Render einige Minuten,
#                     Ergebnis im Benutzer-Cache). Der Pfad lässt sich per Umgebungsvariable CYCLES_KERNEL_PATH setzen — die App
#                     setzt sie beim Start (src-tauri/src/cycles.rs, scripts/electron-cycles.cjs), `source/` muss also nicht neben dem Programm liegen.
#   licenses/, VERSION
# Alles bekommt eine Ad-hoc-Signatur (arm64 verlangt eine); die Developer-ID-Signatur setzt der App-Bau (release.yml).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CYCLES_TAG="${CYCLES_TAG:-v$(tr -d ' \n' < "$HERE/VERSION")}"
WORK="$(mkdir -p "${1:-$HOME/cycles-build}" && cd "${1:-$HOME/cycles-build}" && pwd)"
SRC="$WORK/src/cycles"
INSTALL="$WORK/install"
OUT="$WORK/dist"

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "nur macOS arm64"; exit 1; }
xcrun --sdk macosx --show-sdk-path >/dev/null || { echo "Xcode fehlt"; exit 1; }
for t in cmake ninja git git-lfs python3 install_name_tool otool codesign; do command -v "$t" >/dev/null || { echo "fehlt: $t (brew install cmake ninja git git-lfs)"; exit 1; }; done
git lfs install --skip-repo

mkdir -p "$WORK/src"
[ -d "$SRC" ] || git clone --depth 1 --branch "$CYCLES_TAG" https://projects.blender.org/blender/cycles.git "$SRC"
cd "$SRC"
make update            # holt lib/macos_arm64 (git-lfs, mehrere GB, einmalig)

# Kein OSL/USD/Hydra/Alembic/OpenVDB/OpenSubdiv/GUI. WITH_CYCLES_DEVICE_METAL ist auf dem Mac Standard (hier ausdrücklich AN).
cmake -G Ninja -S . -B "$WORK/build-cycles" -DCMAKE_BUILD_TYPE=Release \
  -DWITH_CYCLES_OSL=OFF -DWITH_CYCLES_USD=OFF -DWITH_CYCLES_HYDRA_RENDER_DELEGATE=OFF -DWITH_CYCLES_ALEMBIC=OFF \
  -DWITH_CYCLES_OPENVDB=OFF -DWITH_CYCLES_NANOVDB=OFF -DWITH_CYCLES_OPENSUBDIV=OFF -DWITH_CYCLES_STANDALONE_GUI=OFF \
  -DWITH_CYCLES_DEVICE_METAL=ON -DWITH_CYCLES_EMBREE=ON -DWITH_CYCLES_OPENIMAGEDENOISE=ON \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DCMAKE_INSTALL_PREFIX="$INSTALL"
cmake --build "$WORK/build-cycles" --target install -j"$(sysctl -n hw.ncpu)"

BIN="$(find "$INSTALL" -maxdepth 2 -type f -name cycles -perm -u+x | head -1)"
[ -n "$BIN" ] || { echo "installiertes cycles nicht gefunden in $INSTALL"; find "$INSTALL" -maxdepth 2 | head -30; exit 1; }
SRCDIR="$(find "$INSTALL" -maxdepth 2 -type d -name source | head -1)"
[ -n "$SRCDIR" ] || { echo "Metal-Kernel-Quellen (install/source) fehlen"; exit 1; }

# --- Auslieferordner ---
rm -rf "$OUT"; mkdir -p "$OUT/lib" "$OUT/licenses"
cp "$BIN" "$OUT/cycles"
cp -R "$SRCDIR" "$OUT/source"

# Index aller Bibliotheken des Vorbaus: Name → Pfad (für @rpath-Abhängigkeiten, die otool nur als @rpath/<name> nennt)
INDEX="$WORK/dylib-index.txt"
{ find "$SRC/lib/macos_arm64" "$INSTALL" -name '*.dylib' 2>/dev/null; } | while read -r p; do echo "$(basename "$p") $p"; done | sort -u -k1,1 > "$INDEX"

is_system() { case "$1" in /usr/lib/*|/System/*) return 0 ;; *) return 1 ;; esac; }
deps_of() { otool -L "$1" | tail -n +2 | awk '{print $1}'; }

# Abhängigkeiten rekursiv einsammeln
queue=("$OUT/cycles"); seen=" "
while [ ${#queue[@]} -gt 0 ]; do
  f="${queue[0]}"; queue=("${queue[@]:1}")
  for d in $(deps_of "$f"); do
    is_system "$d" && continue
    name="$(basename "$d")"
    case "$seen" in *" $name "*) continue ;; esac
    seen="$seen$name "
    path="$(awk -v n="$name" '$1==n {print $2; exit}' "$INDEX")"
    [ -n "$path" ] || { echo "Bibliothek nicht gefunden: $d (von $f)"; exit 1; }
    cp -L "$path" "$OUT/lib/$name"; chmod u+w "$OUT/lib/$name"
    queue+=("$OUT/lib/$name")
  done
done
# OIDN lädt seine Gerätebibliotheken (Metal, CPU) zur Laufzeit neben sich
for f in $(awk '$1 ~ /^libOpenImageDenoise_device/ {print $2}' "$INDEX"); do cp -L "$f" "$OUT/lib/$(basename "$f")"; chmod u+w "$OUT/lib/$(basename "$f")"; done

# Kennungen, Abhängigkeiten und RPATHs auf @rpath/@loader_path umschreiben
for l in "$OUT"/lib/*.dylib; do
  install_name_tool -id "@rpath/$(basename "$l")" "$l"
  for d in $(deps_of "$l"); do is_system "$d" || [ "$(basename "$d")" = "$(basename "$l")" ] || install_name_tool -change "$d" "@rpath/$(basename "$d")" "$l"; done
  install_name_tool -add_rpath @loader_path "$l" 2>/dev/null || true
done
for d in $(deps_of "$OUT/cycles"); do is_system "$d" || install_name_tool -change "$d" "@rpath/$(basename "$d")" "$OUT/cycles"; done
# alte RPATHs des Bauordners entfernen, unsere setzen
for rp in $(otool -l "$OUT/cycles" | awk '/LC_RPATH/ {getline; getline; print $2}'); do install_name_tool -delete_rpath "$rp" "$OUT/cycles" 2>/dev/null || true; done
install_name_tool -add_rpath @executable_path/lib "$OUT/cycles"
install_name_tool -add_rpath @executable_path/../Resources/cycles/lib "$OUT/cycles"
strip -x "$OUT/cycles" 2>/dev/null || true
for f in "$OUT/cycles" "$OUT"/lib/*.dylib; do codesign --force --sign - "$f"; done

# --- Lizenzen: Cycles + dessen Teile; je Vorbau-Bibliothek, was der Ordner an Lizenzdateien mitbringt ---
LIC="$OUT/licenses"
cp "$SRC/LICENSE" "$LIC/Cycles-LICENSE.txt"
cp "$SRC/src/doc/license/"*-license.txt "$LIC/"
cp "$SRC/src/doc/license/Apache2-license.txt" "$LIC/Apache-2.0.txt"
cp "$HERE/THIRD-PARTY.txt" "$LIC/README.txt"
: > "$LIC/macos-libs.txt"
for l in "$OUT"/lib/*.dylib; do
  name="$(basename "$l")"; p="$(awk -v n="$name" '$1==n {print $2; exit}' "$INDEX")"
  # Wurzel der Bibliothek im Vorbau: lib/macos_arm64/<paket>/…
  pkg="$(echo "$p" | sed -n 's|.*/lib/macos_arm64/\([^/]*\)/.*|\1|p')"
  echo "$name  ${pkg:-?}" >> "$LIC/macos-libs.txt"
  if [ -n "$pkg" ] && [ -d "$SRC/lib/macos_arm64/$pkg" ]; then
    find "$SRC/lib/macos_arm64/$pkg" -maxdepth 3 \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' -o -iname 'COPYRIGHT*' \) -type f 2>/dev/null \
      | while read -r lf; do mkdir -p "$LIC/$pkg"; cp "$lf" "$LIC/$pkg/$(basename "$lf")"; done
  fi
done
printf '%s\n' "${CYCLES_TAG#v}" > "$OUT/VERSION"

# --- Ergebnis prüfen ---
du -sh "$OUT" "$OUT/lib" "$OUT/source"
otool -L "$OUT/cycles" | head -30
"$OUT/cycles" --version
"$OUT/cycles" --list-devices || true      # erwartet: CPU (+ Apple-GPU/Metal, wenn der Rechner eine hat; gehostete CI-Runner haben keine)
echo "== fertig: $OUT — Weiter: scripts/cycles/pack.sh $OUT macos arm64"
