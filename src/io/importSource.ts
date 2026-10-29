// Gelesene Import-Datei (DXF/DWG/PDF) als Eingabe für den Kern ([K4] S4): das Format-Modul (`pkgFileIo`,
// `src-tauri/fileio`) liest die Datei in flache Puffer, der Kern (`core/src/import_drawing.rs`) macht daraus
// die Zusammenfassung für den Dialog und beim Bestätigen die Ops (`ProjectDocument.importDrawing`). TS hält
// nur die Puffer (keine Umwandlung in Konturen/Zeichnungen mehr).

import type { ImportedMesh } from "../model/types";
import { core } from "../engine/coreWasm";
import type { ImportSource } from "../core/document";

export type { ImportSource };

/** Diagnose: gelesene Entity-Typen (Typ → Anzahl) und Gesamtzahl. */
export interface ImportDiagnostics {
  entityCounts: Record<string, number>;
  total: number;
}

/** Was der Import-Dialog von der gelesenen Datei zeigt (`import_drawing::summary_json`). */
export interface ImportSummary {
  contours: number;
  texts: number;
  meshes: number;
  /** Layer der Konturen (in Fundreihenfolge). */
  layers: string[];
  diagnostics: ImportDiagnostics;
  /** `$INSUNITS` der Datei (0 = ohne Einheit, 4 = mm …). */
  insUnits?: number;
  /** Meter je Zeicheneinheit (schon umgerechnet; PDF: Meter je Punkt beim gewählten Massstab). */
  unitScale?: number;
  /** Papierbereich-Layouts der Datei (ohne „Model"); `entities` = Zeichnungs-Entities. */
  layouts?: { name: string; entities: number }[];
  /** Name des gelesenen Layouts; fehlt beim Modellraum. */
  layout?: string;
  /** Die Datei war beschädigt/abgeschnitten und wurde nur teilweise gelesen. */
  recovered: boolean;
}

/** Gelesene Datei + Zusammenfassung (Zustand des Import-Dialogs). */
export interface ParsedImport {
  src: ImportSource;
  summary: ImportSummary;
}

/** Ein gelesenes Stück (flacher Puffer + String-Tabelle des Format-Moduls). */
export interface ImportChunk {
  geom: Float64Array;
  strings: string[];
}

/** Stücke zu einer Kern-Eingabe zusammenpacken: `[n, len_0 … len_{n−1}, daten …]`. */
export function packChunks(chunks: readonly ImportChunk[], source: ImportSource["source"] = { kind: "drawing" }): ImportSource {
  const n = chunks.length;
  const total = chunks.reduce((s, c) => s + c.geom.length, 0);
  const geom = new Float64Array(1 + n + total);
  geom[0] = n;
  let at = 1 + n;
  chunks.forEach((c, i) => {
    geom[1 + i] = c.geom.length;
    geom.set(c.geom, at);
    at += c.geom.length;
  });
  return { geom, strings: chunks.map((c) => c.strings), source };
}

function call<T>(out: string): T {
  if (out.startsWith("\u0001")) throw new Error(out.slice(1));
  return JSON.parse(out) as T;
}

/** Zusammenfassung für den Dialog (Kern). Wirft bei kaputtem Puffer. */
export function importSummary(src: ImportSource): ImportSummary {
  return call(core().import_drawing_summary(src.geom, JSON.stringify(src.strings), JSON.stringify(src.source)));
}

/** Gelesene Stücke → Dialog-Zustand. */
export function parsedImport(chunks: readonly ImportChunk[], source?: ImportSource["source"]): ParsedImport {
  const src = packChunks(chunks, source);
  return { src, summary: importSummary(src) };
}

/** Leerer Import (Fehlerfall im Dialog). */
export function emptyImport(): ParsedImport {
  const src = packChunks([]);
  return { src, summary: { contours: 0, texts: 0, meshes: 0, layers: [], diagnostics: { entityCounts: {}, total: 0 }, recovered: false } };
}

/** Nur die Meshes als Kontext-Objekte (z. B. swissBUILDINGS3D-Kacheln, je Ebene ein Mesh). */
export function importMeshes(src: ImportSource, now = Date.now()): ImportedMesh[] {
  return call(core().import_drawing_meshes(src.geom, JSON.stringify(src.strings), JSON.stringify(src.source), now));
}
