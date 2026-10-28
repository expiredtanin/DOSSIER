// Vitest-Hilfe: Format-Modul (pkgFileIo) synchron laden. Anders als der Kern nicht global in
// `vitest.config.ts` (acadrust ist gross, die meisten Tests brauchen es nicht) — Tests, die
// DXF/DWG schreiben, importieren diese Datei. Fehlt das Paket: `npm run build:fileio`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initFileioSync } from "./fileioWasm";

const file = fileURLToPath(new URL("./pkgFileIo/fileio_bg.wasm", import.meta.url));
let bytes: Buffer;
try {
  bytes = readFileSync(file);
} catch {
  throw new Error(`Format-Modul fehlt (${file}): zuerst \`npm run build:fileio\`.`);
}
await initFileioSync(new Uint8Array(bytes));
