// Lader der Dateiformate (`src-tauri/fileio` → `src/engine/pkgFileIo`). Anders als der Kern
// (`coreWasm.ts`) wird dieses Modul erst beim ersten Import/Export geladen: Dateiformate (acadrust)
// sind gross und werden beim Zeichnen nie gebraucht. Browser/Tauri laden per URL, Node (CLI) über den
// Byte-Provider (`wasmSource.ts`, Name "fileio"), Tests über `initFileioSync`.

import { wasmInitArg } from "./wasmSource";

type FileioModule = typeof import("./pkgFileIo/fileio.js");

let mod: FileioModule | null = null;
let loading: Promise<FileioModule> | null = null;

/** Lädt das Format-Modul (einmal) und liefert es. */
export function loadFileio(): Promise<FileioModule> {
  if (mod) return Promise.resolve(mod);
  loading ??= (async () => {
    const m = await import("./pkgFileIo/fileio.js");
    await m.default(await wasmInitArg("fileio"));
    mod = m;
    return m;
  })();
  return loading;
}

/** Synchroner Zugriff, nachdem `loadFileio()`/`initFileioSync()` gelaufen ist (Muster `core()`). */
export function fileio(): FileioModule {
  if (!mod) throw new Error("Format-Modul (pkgFileIo) nicht geladen: zuerst `await loadFileio()`.");
  return mod;
}

/** Synchron laden aus vorliegenden Bytes (Node: Tests, Werkzeuge). */
export async function initFileioSync(bytes: BufferSource): Promise<FileioModule> {
  if (mod) return mod;
  const m = await import("./pkgFileIo/fileio.js");
  m.initSync({ module: bytes });
  mod = m;
  return m;
}
