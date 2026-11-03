// Baut den Rust-Kern nach `src/engine/pkgCore` (`npm run build:core [-- --no-opt …]`; weitere
// Argumente gehen an wasm-pack) und ergänzt danach die wasm-bindgen-Hülle (`core.js`) um
// `__dossier_reinit()` ([118], Wiederanlauf nach Kern-Panic): eine frische `WebAssembly.Instance` aus
// dem schon übersetzten Modul, synchron. Die erzeugte Hülle lässt `initSync` nur einmal zu (`wasm`
// ist modul-lokal); nach einem Trap (wasm32 kennt kein catch_unwind) ist die alte Instanz aber
// unbrauchbar (geborgte RefCells, verwaister Zustand), s. `src/engine/coreWasm.ts`.
//
// `node scripts/build-core.mjs --patch-only` ergänzt nur (z. B. nach einem direkten wasm-pack-Aufruf);
// mehrfaches Ergänzen ist harmlos.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = `${root}src/engine/pkgCore/`;
const args = process.argv.slice(2);

if (!args.includes("--patch-only")) {
  const base = ["build", "src-tauri/core", "--release", "--target", "web", "--out-dir", "../../src/engine/pkgCore", "--out-name", "core", "--no-default-features", "--features", "web"];
  const r = spawnSync("wasm-pack", [...base, ...args], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const MARK = "__dossier_reinit";
const js = `${pkg}core.js`;
const dts = `${pkg}core.d.ts`;

let src = readFileSync(js, "utf8");
if (!src.includes(MARK)) {
  // Die Hülle muss die Variablen so führen, wie die Ergänzung sie anspricht (wasm-bindgen 0.2.1xx).
  for (const need of ["let wasmModule, wasmInstance, wasm;", "function initSync(module)"]) {
    if (!src.includes(need)) {
      console.error(`build-core: \`${need}\` fehlt in ${js} — wasm-bindgen-Hülle geändert, Ergänzung anpassen.`);
      process.exit(1);
    }
  }
  src += `
/** Dossier [118]: neue Instanz aus dem schon übersetzten Modul (nach einem Trap); ergänzt von scripts/build-core.mjs. */
export function ${MARK}() {
    const module = wasmModule;
    if (module === undefined) throw new Error("Rust-Kern nie geladen");
    wasm = undefined;
    return initSync({ module });
}
`;
  writeFileSync(js, src);
}

let types = readFileSync(dts, "utf8");
if (!types.includes(MARK)) {
  types += `\n/** Dossier [118]: neue Instanz aus dem schon übersetzten Modul (nach einem Trap). */\nexport function ${MARK}(): InitOutput;\n`;
  writeFileSync(dts, types);
}
