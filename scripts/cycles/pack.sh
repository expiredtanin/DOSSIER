#!/usr/bin/env bash
# [215] Cycles-Auslieferordner zu cycles-<os>-<arch>-<version>.tar.xz packen (Wurzelordner im Archiv: `cycles/`).
#   scripts/cycles/pack.sh <dist-Ordner> <linux|macos> <x86_64|arm64> [Ausgabeordner]
# Schreibt auch <archiv>.sha256 (sha256sum-Format). Name wie scripts/cycles/cycles-lib.cjs (assetName).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="${1:?dist-Ordner}"; OS="${2:?linux|macos}"; ARCH="${3:?x86_64|arm64}"
OUTDIR="$(mkdir -p "${4:-.}" && cd "${4:-.}" && pwd)"
VERSION="$(tr -d ' \n' < "$HERE/VERSION")"
[ -x "$DIST/cycles" ] || { echo "pack: $DIST/cycles fehlt"; exit 1; }
[ -s "$DIST/licenses/Cycles-LICENSE.txt" ] || { echo "pack: Lizenztexte fehlen (licenses/)"; exit 1; }
NAME="cycles-$OS-$ARCH-$VERSION.tar.xz"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp -R "$DIST" "$TMP/cycles"
XZ_OPT="-T0 -6" tar -C "$TMP" -cJf "$OUTDIR/$NAME" cycles
( cd "$OUTDIR" && { sha256sum "$NAME" 2>/dev/null || shasum -a 256 "$NAME"; } > "$NAME.sha256" )
ls -la "$OUTDIR/$NAME"; cat "$OUTDIR/$NAME.sha256"
