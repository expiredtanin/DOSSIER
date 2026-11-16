#!/usr/bin/env node
// [215] Tauri (macOS): ausgepacktes Cycles-Paket (build/cycles, scripts/cycles/get.sh) als Sidecar bereitstellen.
//   node scripts/cycles/tauri-prepare.mjs [Paketordner]      (Standard: build/cycles)
// `bundle.externalBin: ["binaries/cycles"]` (src-tauri/tauri.cycles.conf.json) verlangt je Ziel `binaries/cycles-<triple>`.
// Das Paket ist arm64: für die universale App (arm64 + x64) entstehen auch die Namen x86_64 und universal — Kopien des
// arm64-Programms, nur damit der Bau durchläuft; auf Intel-Macs meldet `cycles_where` (src-tauri/src/cycles.rs) „nicht verfügbar“.
// `scripts/tauri-native.mjs` hängt die Konfiguration automatisch an `tauri build`, sobald die Sidecars da sind.
import { copyFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const dir = resolve(process.argv[2] ?? join(root, "build", "cycles"));
const bin = join(dir, "cycles");
if (!existsSync(bin)) {
  console.error(`tauri-prepare: ${bin} fehlt — zuerst scripts/cycles/get.sh macos arm64`);
  process.exit(1);
}
const out = join(root, "src-tauri", "binaries");
mkdirSync(out, { recursive: true });
for (const triple of ["aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin"]) {
  const to = join(out, `cycles-${triple}`);
  copyFileSync(bin, to);
  chmodSync(to, 0o755);
  console.log(`tauri-prepare: ${to}`);
}
