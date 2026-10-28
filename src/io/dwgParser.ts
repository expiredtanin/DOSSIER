// DWG-Import → Kontext-Geometrie: dünne Fassade über das Rust-Format-Modul (acadrust, DWG R13–2018,
// `src-tauri/fileio/src/import.rs`). Gleicher Weg wie DXF (`dxfParserAsync.ts`, Web-Worker), gleiches
// `DxfImportResult`: Konturen, Texte, Meshes je Ebene (z. B. „Roof"/„Wall"/„Floor" bei
// swissBUILDINGS3D v3 „separated", Polyface-Meshes in per INSERT platzierten Blöcken), Ebenenfarben,
// Entity-Histogramm.

import type { DxfImportResult } from "./dxfParser";
import { parseDxfAsync } from "./dxfParserAsync";

/** Liest eine DWG-Datei. Wirft bei unlesbaren Dateien (der Aufrufer zeigt den ODA-Hinweis). */
export function parseDwg(data: ArrayBuffer): Promise<DxfImportResult> {
  return parseDxfAsync(data);
}
