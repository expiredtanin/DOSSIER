#!/usr/bin/env bash
# [215] Cycles-Paket für die App holen: zuerst vom Gitea-Release `cycles-<version>`, sonst aus dem Artefakt des letzten
# erfolgreichen cycles.yml-Laufs (GitHub, `gh` + GH_TOKEN nötig). Ergebnis: build/cycles/ (cycles, lib/, licenses/ …).
#   scripts/cycles/get.sh <linux|macos> <x86_64|arm64>
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OS="${1:?linux|macos}"; ARCH="${2:?x86_64|arm64}"
VERSION="$(tr -d ' \n' < "$HERE/VERSION")"
node "$HERE/fetch.mjs" --os "$OS" --arch "$ARCH" --out "$ROOT/build/cycles"
rc=$?
[ $rc -eq 0 ] && exit 0
[ $rc -eq 3 ] || exit $rc
echo "get: kein Paket am Gitea-Release — versuche das Artefakt von cycles.yml"
command -v gh >/dev/null || { echo "get: gh fehlt, kein Cycles-Paket"; exit 1; }
RUN="$(gh run list --workflow cycles.yml --status success --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null)"
[ -n "$RUN" ] || { echo "get: kein erfolgreicher cycles.yml-Lauf — cycles.yml starten (Actions → cycles → Run workflow)"; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
gh run download "$RUN" -n "cycles-$OS-$ARCH-$VERSION" -D "$TMP/dl" || exit 1
mkdir -p "$TMP/x"; tar -xJf "$TMP/dl/cycles-$OS-$ARCH-$VERSION.tar.xz" -C "$TMP/x" || exit 1
rm -rf "$ROOT/build/cycles"; mkdir -p "$ROOT/build"; mv "$TMP/x/cycles" "$ROOT/build/cycles"
echo "get: Artefakt von Lauf $RUN nach build/cycles"
