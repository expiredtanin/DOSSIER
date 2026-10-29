// DXF/DWG-Import: dünne Fassade über das Rust-Format-Modul (`src-tauri/fileio/src/import.rs`, acadrust;
// WASM `pkgFileIo`, geladen über `engine/fileioWasm.ts`).
//
// Rust liest DXF (ASCII und Binär, R12–2018+) und DWG (R13–2018) und liefert einen flachen Puffer +
// String-Tabelle: LINE, LWPOLYLINE/POLYLINE (inkl. Bulges), ARC/CIRCLE (mit wahrer Kurve), ELLIPSE, SPLINE,
// HATCH und SOLID/TRACE (gefüllte Flächen), TEXT/MTEXT, ATTRIB/ATTDEF, DIMENSION, LEADER/MULTILEADER,
// 3DFACE, Polyface-/Polygon-Mesh, MESH; INSERT rekursiv aufgelöst; `$INSUNITS` auf Meter umgerechnet.
// Papierbereich: `parseDxf(…, layout)` liest ein Layout statt des Modellraums.
//
// Die Umwandlung ins Projekt (Zeichnungen, Kategorien je Layer, Meshes) macht der Kern beim Bestätigen
// (`ProjectDocument.importDrawing`, [K4] S4); hier bleiben Puffer + Zusammenfassung für den Dialog.
//
// `parseDxf` ist synchron und verlangt das geladene Modul (`loadFileio()`); die App liest im Web-Worker
// (`dxfParserAsync.ts`), Tests laden es per `loadFileioForTests()`.

import { fileioLoaded } from "../engine/fileioWasm";
import { parsedImport, type ImportChunk, type ParsedImport } from "./importSource";

/** Eingabe als Bytes (Text wird UTF-8-kodiert). */
function toBytes(input: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Liest eine DXF-Datei (Text oder Bytes; Binär-DXF und DWG werden am Inhalt erkannt): Puffer für den Kern
 * und Zusammenfassung für den Dialog. Wirft bei unlesbaren Dateien (Meldung aus Rust) oder wenn das Modul
 * nicht geladen ist.
 */
export function parseDxf(input: string | ArrayBuffer | Uint8Array, layout?: string): ParsedImport {
  return parsedImport([importDrawingFlat(input, layout)]);
}

/**
 * Rust-Aufruf: flacher Puffer + String-Tabelle (für die Übergabe aus dem Worker). Mit `layout` wird
 * das Papierbereich-Layout dieses Namens gelesen (unbekannt → Fehler mit den vorhandenen Namen).
 */
export function importDrawingFlat(input: string | ArrayBuffer | Uint8Array, layout?: string): ImportChunk {
  const m = fileioLoaded();
  if (!m) throw new Error("Format-Modul nicht geladen: loadFileio() muss vor dem Import laufen.");
  const bytes = toBytes(input);
  const res = layout === undefined ? m.import_drawing(bytes) : m.import_drawing_layout(bytes, layout);
  try {
    return { geom: res.geom(), strings: res.strings() };
  } finally {
    res.free();
  }
}
