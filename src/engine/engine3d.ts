// Gemeinsamer Lade-Einstieg für das render3d-WASM-Modul (pkg3d, gebaut über
// `npm run build:engine3d`). EINMAL geladen + initialisiert und memoisiert:
// `mod.default()` (der wasm-bindgen-Init) darf nur EINMAL laufen — ein zweiter
// Init würde die Closures des ersten verwerfen („closure invoked recursively or
// after being dropped"). Sowohl der 3D-Viewport (useWasm3dRenderer) als auch die
// Schnitt-/Ansichts-Pipeline (plan/toSection) teilen sich daher DIESE Instanz.
//
// Bewusst schwach typisiert (`any`): das echte `.d.ts` entsteht erst beim
// wasm-Build; die Aufrufer legen ihre eigene Minimal-Schnittstelle darüber.

import { wasmInitArg } from "./wasmSource";

let enginePromise: Promise<any> | null = null;

/** Lädt das WASM-Modul einmalig und gibt das initialisierte Modul zurück. */
export function loadEngine3d(): Promise<any> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const mod: any = await import("./pkg3d/render3d.js");
      await mod.default(await wasmInitArg("render3d")); // lädt render3d_bg.wasm
      return mod;
    })();
  }
  return enginePromise;
}
