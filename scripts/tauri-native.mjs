// Startet `tauri dev|build` und schaltet auf macOS das Cargo-Feature `native2d`
// dazu (native 2D-Engine in der eingebetteten Metal-Fläche, s.
// src-tauri/src/native_embed.rs). Auf anderen Plattformen läuft der Standard-Build
// unverändert mit WebGL. Opt-out: DOSSIER_NO_NATIVE2D=1.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Veraltete WASM-Pakete zuerst neu bauen (sonst passen Oberfläche und Kern nach einem Pull nicht zusammen).
if (!process.env.DOSSIER_NO_WASM_CHECK) {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./wasm-fresh.mjs", import.meta.url))], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const args = process.argv.slice(2);
const native = process.platform === "darwin" && !process.env.DOSSIER_NO_NATIVE2D;
if (native && !args.includes("--features")) args.push("--features", "native2d");
console.log(`[tauri-native] tauri ${args.join(" ")}`);
const child = spawn("npx", ["tauri", ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
