// IFC-Export (IFC4 oder IFC2x3, STEP Physical File / ISO-10303-21) des semantischen Modells.
//
// Seit [K4]/[B5] (29.10.) rechnet alles in Rust: der Kern sammelt aus dem Projekt-Dokument den flachen
// Puffer (`src-tauri/core/src/ifc_data.rs`, Abfrage `ifcExportData`: Wand-Bänder, Öffnungen samt
// Füllungs-Parametern, Treppen-Teile, Dach-Netze, Räume, Zonen, Geschoss-Kennwerte, Basismengen,
// Klassifikation, Georeferenz), das Format-Modul schreibt daraus die Datei
// (`src-tauri/fileio/src/ifc_export.rs`: Entitäten, GUIDs, Typen mit Materialschichten, Psets,
// Beziehungen). Zwei WASM-Module, die Bytes reichen von einem zum anderen; TS gibt nur Optionen und
// den Zeitstempel weiter. Verlangt das geladene Format-Modul (`await loadFileio()`, wie
// `buildPlanDxf`). Der Download passiert im App-Layer.
//
// Abbildung und Grenzen: Kopf von `ifc_data.rs` und `ifc_export.rs`, `TODO.md` [B5].

import type { Project } from "../model/types";
import { fileio } from "../engine/fileioWasm";
import { documentFor } from "../core/document";

/** IFC-Schema der Ausgabe: IFC4 (Standard) oder IFC2x3 (Coordination View 2.0, TC1). */
export type IfcSchema = "IFC4" | "IFC2X3";

/** Optionen des IFC-Exports: Schema und Klassifikation. */
export interface IfcExportOptions {
  /** Schema der Datei; ohne Angabe IFC4. */
  schema?: IfcSchema;
  /**
   * eBKP-H-Hauptgruppen je Bauteilart (Standardzuordnung, Vorschlag für die Kostenplanung: Wand,
   * Decke, Stütze, Treppe = C; Dach = F; Fenster = E; Tür und Raum ohne).
   */
  ebkph?: boolean;
  /** `categoryCode` (Ebene) des Modells als System „Dossier-Ebenen". */
  layerCodes?: boolean;
}

/** Deterministische 22-stellige IFC-GUID aus einem Namen (Rust, `ifc_export.rs::ifc_guid`). */
export function ifcGuid(name: string): string {
  return fileio().ifc_guid(name);
}

/** STEP-String-Literal mit Apostrophen, Nicht-ASCII als `\X2\`/`\X4\` (Rust, `ifc_export.rs::ifc_string`). */
export function ifcString(s: string): string {
  return fileio().ifc_string(s);
}

/** Kennung der Byte-Hülle des Kerns ("DXEF", `export_flat.rs`) und des Fehlerpuffers ("PLBe", `plan_buf.rs`). */
const FLAT_MAGIC = 1146635590;
const ERR_MAGIC = 0x504c4265;

/**
 * Byte-Hülle einer Export-Abfrage des Kerns (`export_flat.rs`) → `[Zahlenpuffer, Zeichenketten durch \0
 * getrennt]` für die `fileio`-Schreiber. Ein Fehlerpuffer des Kerns wirft mit dessen Meldung.
 */
export function decodeExportFlat(bytes: Uint8Array): [Float64Array, string] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (i: number): number => (bytes.byteLength >= (i + 1) * 8 ? dv.getFloat64(i * 8, true) : Number.NaN);
  if (at(0) === ERR_MAGIC) {
    const n = Math.min(at(1), (bytes.byteLength - 16) / 2);
    let msg = "";
    for (let i = 0; i < n; i++) msg += String.fromCharCode(dv.getUint16(16 + i * 2, true));
    throw new Error(msg);
  }
  const n = at(1);
  const len = at(2);
  if (at(0) !== FLAT_MAGIC || !(24 + n * 8 + len <= bytes.byteLength)) throw new Error("Export-Puffer des Kerns unlesbar");
  const nums = bytes.byteOffset % 8 === 0 ? new Float64Array(bytes.buffer, bytes.byteOffset + 24, n) : new Float64Array(bytes.slice(24, 24 + n * 8).buffer);
  return [nums, new TextDecoder().decode(bytes.subarray(24 + n * 8, 24 + n * 8 + len))];
}

/**
 * Baut aus einem Projekt einen vollständigen IFC-SPF-String (IFC4, oder IFC2x3 mit `options.schema`). Kein
 * Datei-IO. Leeres Projekt ⇒ valider Minimal-IFC (Project/Site/Building). Georeferenziert (`geoAnchor`):
 * Geometrie in LV95. Verlangt das geladene Format-Modul (`await loadFileio()`).
 */
export function exportIfcSpf(project: Project, options: IfcExportOptions = {}): string {
  const now = Date.now();
  const iso = new Date(now).toISOString().replace(/\.\d+Z$/, "");
  const args = [Math.floor(now / 1000), options.schema === "IFC2X3" ? 1 : 0, options.ebkph ? 1 : 0, options.layerCodes ? 1 : 0];
  const [buf, strings] = decodeExportFlat(documentFor(project).queryBin("ifcExportData", args, iso));
  const m = fileio();
  const text = m.export_ifc_flat(buf, strings);
  if (text.length === 0) {
    const why = m.export_ifc_check_flat(buf, strings);
    throw new Error(`IFC-Export fehlgeschlagen${why ? `: ${why}` : ""}`);
  }
  return text;
}
