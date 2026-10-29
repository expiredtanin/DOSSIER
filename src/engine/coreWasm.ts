// Lader des Rust-Kerns (`src-tauri/core` → `src/engine/pkgCore`). Der Kern wird EINMAL geladen —
// App: `initCore()` vor dem ersten Render (main.tsx), CLI: `initCore()` mit Byte-Provider
// (wasmSource.ts), Tests: `initCoreSync()` in der Vitest-Setup-Datei — und danach synchron über
// `core()` aufgerufen, passend zu den synchronen Aufrufern im TS-Kern.

import * as wasm from "./pkgCore/core.js";
import { wasmInitArg } from "./wasmSource";

export type CoreModule = typeof wasm;

let ready = false;

/** Lädt den Kern asynchron (Browser/Tauri/Electron per URL, Node über den Byte-Provider). */
export async function initCore(): Promise<void> {
  if (ready) return;
  await wasm.default(await wasmInitArg("core"));
  ready = true;
}

/** Lädt den Kern synchron aus vorliegenden Bytes (Node: Tests, Werkzeuge). */
export function initCoreSync(bytes: BufferSource): void {
  if (ready) return;
  wasm.initSync({ module: bytes });
  ready = true;
}

/** Der geladene Kern; wirft, wenn `initCore()` noch nicht gelaufen ist (Programmierfehler). */
export function core(): CoreModule {
  if (!ready) throw new Error("Rust-Kern nicht geladen: initCore() muss vor der ersten Kern-Funktion laufen.");
  return wasm;
}
