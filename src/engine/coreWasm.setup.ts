// Vitest-Setup: Rust-Kern synchron laden, damit Kern-Funktionen in jedem Test verfügbar sind.
// Fehlt das Paket, bricht jeder Test mit einem Hinweis ab (vorher `npm run build:core`).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initCoreSync } from "./coreWasm";

const file = fileURLToPath(new URL("./pkgCore/core_bg.wasm", import.meta.url));
let bytes: Buffer;
try {
  bytes = readFileSync(file);
} catch {
  throw new Error(`Rust-Kern fehlt (${file}): zuerst \`npm run build:core\`.`);
}
initCoreSync(new Uint8Array(bytes));
