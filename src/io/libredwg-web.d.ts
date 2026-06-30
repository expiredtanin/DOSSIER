// Ambient-Deklarationen für die WASM-Glue-/Asset-Importe von
// @mlightcad/libredwg-web. Das Paket gibt seine `wasm/`-Dateien NICHT über
// `exports` frei, daher laden wir sie über zwei virtuelle Module (Aliase in
// vite.config.ts → echte Dateien im Paket). Hier nur schmale Modul-Stubs.
// (Identifier englisch.)

declare module "virtual:libredwg-glue" {
  /** Emscripten-Glue: erzeugt die WASM-Instanz; `locateFile` löst die .wasm-URL. */
  const createModule: (opts?: {
    locateFile?: (filename: string, scriptDir: string) => string;
  }) => Promise<unknown>;
  export default createModule;
}

declare module "virtual:libredwg-wasm-url" {
  /** Von Vite aufgelöste URL der WASM-Datei (gehashtes Asset im Build). */
  const url: string;
  export default url;
}
