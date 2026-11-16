#!/usr/bin/env bash
# [215] Cycles-Standalone für Linux x86_64 (nur CPU) bauen — schlanke Konfiguration, Ergebnis in $OUT/.
# Geprüft auf Ubuntu 24.04 (Container, 4 vCPU): ca. 20 Minuten, siehe doc/CYCLES.md.
#
#   scripts/cycles/build-linux.sh [Arbeitsordner]      (Standard: $HOME/cycles-build)
#
# Schritte: (1) System-Pakete (apt) · (2) Cycles-Quellen (Tag $CYCLES_TAG, projects.blender.org)
# · (3) OIDN-Bibliotheken aus dem Blender-Vorbau (nur 3 Dateien + Header, kein 25-GB-Repo)
# · (4) libtiff ohne GPL-Anhängsel + OpenImageIO schlank selbst bauen (Ubuntu-Quellen; ohne ffmpeg/GDAL/OpenCV/OCIO)
# · (5) Cycles bauen (ohne OSL/USD/Hydra/Alembic/OpenVDB/OpenSubdiv/GPU/OCIO) · (6) strippen + Bibliotheken einsammeln.
# Keine Binärdateien im Repo; alles liegt im Arbeitsordner (ausserhalb des Repos).
#
# Hosts: projects.blender.org (Quellen + OIDN), archive.ubuntu.com (OIIO-Quelle + apt). github.com ist im
# Cloud-Container gesperrt und wird NICHT gebraucht.
set -euo pipefail

CYCLES_TAG="${CYCLES_TAG:-v5.3.0}"
OIIO_VERSION="${OIIO_VERSION:-2.4.17.0+dfsg}"
JOBS="${JOBS:-3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mkdir -p "${1:-$HOME/cycles-build}" && cd "${1:-$HOME/cycles-build}" && pwd)"
OUT="$WORK/dist"
echo "== Arbeitsordner: $WORK"

# (1) Pakete. libtbb/libembree4/OpenEXR liefern die Laufzeit-Bibliotheken, die wir mitgeben.
if [ "${SKIP_APT:-0}" != 1 ]; then
  SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq --no-install-recommends \
    build-essential cmake ninja-build git python3 curl ca-certificates xz-utils patchelf \
    libembree-dev libtbb-dev libopenexr-dev libpugixml-dev libpng-dev libjpeg-dev libtiff-dev \
    zlib1g-dev libzstd-dev libfmt-dev libboost-dev libboost-filesystem-dev libboost-thread-dev \
    libboost-system-dev libboost-iostreams-dev libboost-regex-dev
fi

# (2) Quellen
mkdir -p "$WORK/src"
if [ ! -d "$WORK/src/cycles" ]; then
  git clone --depth 1 --branch "$CYCLES_TAG" https://projects.blender.org/blender/cycles.git "$WORK/src/cycles"
fi
# Nur ohne bereits angewandten Patch (idempotent)
if ! grep -q "WITH_OCIO" "$WORK/src/cycles/CMakeLists.txt"; then
  (cd "$WORK/src/cycles" && git apply "$HERE/patches/no-ocio.patch")
fi

# (3) OIDN (Apache-2.0) aus dem Blender-Vorbau: LFS-Dateien einzeln über die Media-URL.
OIDN="$WORK/oidn"
if [ ! -f "$OIDN/lib/libOpenImageDenoise_core.so.2.5.0" ]; then
  B=https://projects.blender.org/blender/lib-linux_x64/media/branch/main/openimagedenoise
  R=https://projects.blender.org/blender/lib-linux_x64/raw/branch/main/openimagedenoise
  mkdir -p "$OIDN/lib/cmake/OpenImageDenoise" "$OIDN/include/OpenImageDenoise"
  for f in libOpenImageDenoise.so.2.5.0 libOpenImageDenoise_core.so.2.5.0 libOpenImageDenoise_device_cpu.so.2.5.0; do
    curl -fsS -o "$OIDN/lib/$f" "$B/lib/$f"
  done
  for f in config.h oidn.h oidn.hpp; do curl -fsS -o "$OIDN/include/OpenImageDenoise/$f" "$B/include/OpenImageDenoise/$f"; done
  for f in OpenImageDenoiseConfig.cmake OpenImageDenoiseConfigVersion.cmake OpenImageDenoiseTargets.cmake OpenImageDenoiseTargets-release.cmake; do
    curl -fsS -o "$OIDN/lib/cmake/OpenImageDenoise/$f" "$R/lib/cmake/OpenImageDenoise/$f"
  done
  (cd "$OIDN/lib" && ln -sf libOpenImageDenoise.so.2.5.0 libOpenImageDenoise.so.2 && ln -sf libOpenImageDenoise.so.2 libOpenImageDenoise.so \
    && ln -sf libOpenImageDenoise_core.so.2.5.0 libOpenImageDenoise_core.so.2 \
    && ln -sf libOpenImageDenoise_device_cpu.so.2.5.0 libOpenImageDenoise_device_cpu.so.2)
fi

# (4a) libtiff ohne jbig/lzma/webp/lerc/zstd: Ubuntus libtiff hängt an libjbig (jbigkit, GPL-2) — das gehört nicht in die App.
TIFF="$WORK/tiff-prefix"
if [ ! -f "$TIFF/lib/libtiff.so" ]; then
  mkdir -p "$WORK/dl" "$WORK/src/tiff"
  TT="tiff_4.5.1+git230720.orig.tar.xz"
  [ -f "$WORK/dl/$TT" ] || curl -fsS -o "$WORK/dl/$TT" "http://archive.ubuntu.com/ubuntu/pool/main/t/tiff/$TT"
  tar xf "$WORK/dl/$TT" -C "$WORK/src/tiff" --strip-components=1
  cmake -G Ninja -S "$WORK/src/tiff" -B "$WORK/build-tiff" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$TIFF" \
    -DBUILD_SHARED_LIBS=ON -Djbig=OFF -Dlzma=OFF -Dwebp=OFF -Dlerc=OFF -Dzstd=OFF -Dtiff-tools=OFF -Dtiff-tests=OFF \
    -Dtiff-contrib=OFF -Dtiff-docs=OFF -Dcxx=OFF -Djpeg12=OFF
  ninja -C "$WORK/build-tiff" -j"$JOBS" install
fi

# (4b) OpenImageIO schlank (Ubuntus Paket zieht ffmpeg, GDAL, OpenCV … = 400 MB, nicht auslieferbar)
OIIO="$WORK/oiio-prefix"
if [ ! -f "$OIIO/lib/libOpenImageIO.so" ]; then
  mkdir -p "$WORK/dl" "$WORK/src/oiio"
  T="openimageio_${OIIO_VERSION}.orig.tar.xz"
  [ -f "$WORK/dl/$T" ] || curl -fsS -o "$WORK/dl/$T" "http://archive.ubuntu.com/ubuntu/pool/universe/o/openimageio/$T"
  tar xf "$WORK/dl/$T" -C "$WORK/src/oiio" --strip-components=1
  cmake -G Ninja -S "$WORK/src/oiio" -B "$WORK/build-oiio" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$OIIO" -DCMAKE_PREFIX_PATH="$TIFF" \
    -DBUILD_SHARED_LIBS=ON -DUSE_PYTHON=OFF -DOIIO_BUILD_TOOLS=OFF -DOIIO_BUILD_TESTS=OFF -DUSE_QT=OFF \
    -DUSE_OPENCV=OFF -DUSE_FFMPEG=OFF -DUSE_GIF=OFF -DUSE_WEBP=OFF -DUSE_LIBRAW=OFF -DUSE_FREETYPE=OFF \
    -DUSE_OPENJPEG=OFF -DUSE_PTEX=OFF -DUSE_BZIP2=OFF -DUSE_DCMTK=OFF -DUSE_OPENVDB=OFF -DUSE_NUKE=OFF \
    -DUSE_LIBHEIF=OFF -DUSE_JXL=OFF -DUSE_OPENCOLORIO=OFF -DUSE_TBB=OFF -DINSTALL_DOCS=OFF -DSTOP_ON_WARNING=OFF
  ninja -C "$WORK/build-oiio" -j"$JOBS" install
fi

# (5) Cycles
cmake -G Ninja -S "$WORK/src/cycles" -B "$WORK/build-cycles" -DCMAKE_BUILD_TYPE=Release \
  -DWITH_LIBS_PRECOMPILED=OFF -DWITH_OCIO=OFF \
  -DWITH_CYCLES_OSL=OFF -DWITH_CYCLES_USD=OFF -DWITH_CYCLES_HYDRA_RENDER_DELEGATE=OFF -DWITH_CYCLES_ALEMBIC=OFF \
  -DWITH_CYCLES_OPENVDB=OFF -DWITH_CYCLES_NANOVDB=OFF -DWITH_CYCLES_OPENSUBDIV=OFF -DWITH_CYCLES_STANDALONE_GUI=OFF \
  -DWITH_CYCLES_DEVICE_CUDA=OFF -DWITH_CYCLES_DEVICE_OPTIX=OFF -DWITH_CYCLES_DEVICE_HIP=OFF \
  -DWITH_CYCLES_EMBREE=ON -DWITH_CYCLES_OPENIMAGEDENOISE=ON \
  -DOPENIMAGEDENOISE_ROOT_DIR="$OIDN" -DOpenImageIO_DIR="$OIIO/lib/cmake/OpenImageIO" -DCMAKE_PREFIX_PATH="$TIFF"
ninja -C "$WORK/build-cycles" -j"$JOBS"

# (6) Ergebnis: strippen, Bibliotheken neben das Programm, RPATH $ORIGIN. Systembibliotheken (libc, libstdc++ …)
# bleiben draussen; alles andere aus dem Abhängigkeitsbaum kommt mit (Liste unten für NOTICE/Lizenzen).
rm -rf "$OUT"; mkdir -p "$OUT/lib"
cp "$WORK/build-cycles/bin/cycles" "$OUT/cycles"
export LD_LIBRARY_PATH="$OIDN/lib:$OIIO/lib:$TIFF/lib"
ldd "$OUT/cycles" | awk '/=>/ {print $3}' | grep -Ev '/(libc|libm|libdl|libpthread|librt|libstdc\+\+|libgcc_s|libresolv|ld-linux[^/]*)\.so' | sort -u > "$WORK/libs.txt"
while read -r l; do cp -L "$l" "$OUT/lib/$(basename "$l")"; done < "$WORK/libs.txt"
# OIDN lädt die Geräte-Bibliothek zur Laufzeit neben sich
cp -L "$OIDN/lib/libOpenImageDenoise_device_cpu.so.2.5.0" "$OUT/lib/"
strip --strip-unneeded "$OUT/cycles" "$OUT/lib/"*.so* 2>/dev/null || true
patchelf --set-rpath '$ORIGIN/lib' "$OUT/cycles"
for f in "$OUT"/lib/*.so*; do patchelf --set-rpath '$ORIGIN' "$f" 2>/dev/null || true; done
cp "$WORK/src/cycles/LICENSE" "$OUT/LICENSE-cycles.txt"
echo "== fertig: $OUT"; du -sh "$OUT" "$OUT/lib"; ls -la "$OUT/cycles"; "$OUT/cycles" --version
