// Nur für Tests/Werkzeuge in Node: Format-Modul (pkgFileIo) synchron aus der Datei laden. Nicht im
// globalen Vitest-Setup, weil nur wenige Tests DXF/DWG lesen (das Modul ist gross) — dort per
// `beforeAll(loadFileioForTests)`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initFileioSync } from "./fileioWasm";

export async function loadFileioForTests(): Promise<void> {
  const file = fileURLToPath(new URL("./pkgFileIo/fileio_bg.wasm", import.meta.url));
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new Error(`Format-Modul fehlt (${file}): zuerst \`npm run build:fileio\`.`);
  }
  await initFileioSync(new Uint8Array(bytes));
}
