// Startet `tauri dev|build` und schaltet auf macOS das Cargo-Feature `native2d`
// dazu (native 2D-Engine in der eingebetteten Metal-Fläche, s.
// src-tauri/src/native_embed.rs). Auf anderen Plattformen läuft der Standard-Build
// unverändert mit WebGL. Opt-out: DOSSIER_NO_NATIVE2D=1.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Veraltete WASM-Pakete zuerst neu bauen (sonst passen Oberfläche und Kern nach einem Pull nicht zusammen).
if (!process.env.DOSSIER_NO_WASM_CHECK) {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./wasm-fresh.mjs", import.meta.url))], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const args = process.argv.slice(2);
const native = process.platform === "darwin" && !process.env.DOSSIER_NO_NATIVE2D;
if (native && !args.includes("--features")) args.push("--features", "native2d");
// [261] Buildnummer JJMMTT.N: Vite bäckt sie über `define` ein (Env DOSSIER_BUILD), macOS bekommt sie als CFBundleVersion
// (`bundle.macOS.bundleVersion`; „Version“ im Finder bleibt die semver aus tauri.conf.json).
const build = createRequire(import.meta.url)("./build-number.cjs").computeBuildNumber();
process.env.DOSSIER_BUILD = build;
if (args[0] === "build" && !args.some((a) => a.includes("bundleVersion"))) args.push("--config", JSON.stringify({ bundle: { macOS: { bundleVersion: build } } }));
// [215] Cycles mitliefern, sobald die Sidecars bereitstehen (scripts/cycles/tauri-prepare.mjs): Konfiguration als weitere `--config`
// (Tauri führt mehrere zusammen). Ohne Cycles bleibt der Bau wie bisher (tauri-build verlangt sonst die Sidecar-Dateien).
if (args[0] === "build" && existsSync(new URL("../src-tauri/binaries/cycles-aarch64-apple-darwin", import.meta.url)) && !args.some((a) => a.includes("tauri.cycles.conf.json")))
  args.push("--config", fileURLToPath(new URL("../src-tauri/tauri.cycles.conf.json", import.meta.url)));
console.log(`[tauri-native] Build ${build}`);
console.log(`[tauri-native] tauri ${args.join(" ")}`);
const child = spawn("npx", ["tauri", ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
