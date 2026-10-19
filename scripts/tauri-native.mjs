// Startet `tauri dev|build` und schaltet auf macOS das Cargo-Feature `native2d`
// dazu (native 2D-Engine in der eingebetteten Metal-Fläche, s.
// src-tauri/src/native_embed.rs). Auf anderen Plattformen läuft der Standard-Build
// unverändert mit WebGL. Opt-out: DOSSIER_NO_NATIVE2D=1.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const native = process.platform === "darwin" && !process.env.DOSSIER_NO_NATIVE2D;
if (native && !args.includes("--features")) args.push("--features", "native2d");
console.log(`[tauri-native] tauri ${args.join(" ")}`);
const child = spawn("npx", ["tauri", ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
