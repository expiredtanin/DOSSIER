// Ambient-Deklarationen für die WASM-Glue-/Asset-Importe von opencascade.js
// (Welle-C-Spike: Hidden-Line-Removal). Analog zu `src/io/libredwg-web.d.ts`:
// das Paket liefert seine `dist/`-Dateien nicht über sinnvolle `exports`, daher
// laden wir Emscripten-Glue + `.wasm`-URL über zwei virtuelle Module (Aliase in
// vite.config.ts → echte Dateien im Paket). Hier nur schmale Modul-Stubs.
// (Identifier englisch, Kommentare deutsch — CONVENTIONS.md.)

declare module "virtual:occt-glue" {
  /**
   * Emscripten-Modul-Fabrik von opencascade.js. Nimmt Modul-Overrides
   * (u. a. `locateFile`, um die `.wasm`-URL aufzulösen) und liefert das
   * initialisierte Modul (das gesamte OCCT-Binding als `unknown`).
   */
  const createModule: (opts?: {
    locateFile?: (filename: string, scriptDir: string) => string;
    wasmBinary?: ArrayBuffer | Uint8Array;
  }) => Promise<unknown>;
  export default createModule;
}

declare module "virtual:occt-wasm-url" {
  /** Von Vite aufgelöste URL der `.wasm`-Datei (gehashtes Asset im Build). */
  const url: string;
  export default url;
}
