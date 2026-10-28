// DXF/DWG-Import → Kontext-Geometrie: dünne Fassade über das Rust-Format-Modul
// (`src-tauri/fileio/src/import.rs`, acadrust; WASM `pkgFileIo`, geladen über `engine/fileioWasm.ts`).
//
// Importierte Geometrie ist „dumme" KONTEXT-Geometrie (Anzeige + späteres Snap-Ziel), NICHT
// semantisch. Rust liest DXF (ASCII und Binär, R12–2018+) und DWG (R13–2018) und liefert einen
// flachen Puffer + String-Tabelle; hier wird daraus `DxfImportResult` (Konturen, Texte, Meshes,
// Ebenenfarben, Diagnose, $INSUNITS). Abgebildet werden LINE, LWPOLYLINE/POLYLINE (inkl. Bulges),
// ARC/CIRCLE (mit wahrer Kurve), ELLIPSE, SPLINE, HATCH und SOLID/TRACE (gefüllte Flächen), TEXT/MTEXT,
// ATTRIB/ATTDEF, DIMENSION (über den Anonymblock), LEADER/MULTILEADER (Linien + Text), 3DFACE,
// Polyface-/Polygon-Mesh, MESH; INSERT wird rekursiv aufgelöst (Basispunkt, Skalierung, Drehung,
// Raster; Ebene „0" erbt die Ebene der Referenz). `$INSUNITS` rechnet Rust auf Meter um.
//
// `parseDxf` ist synchron und verlangt das geladene Modul (`loadFileio()`); die App ruft es im
// Web-Worker (`dxfParserAsync.ts`), Tests laden es per `loadFileioForTests()`.

import type { Contour, ContourSet, ImportedMesh, ImportedText } from "../model/types";
import { GENERIC_IMPORT_CATEGORY } from "../model/contextCategories";
import { fileioLoaded } from "../engine/fileioWasm";

/**
 * Optionale Import-Diagnose: Histogramm der gelesenen Entity-Typen (Typ → Anzahl)
 * und die Gesamtzahl. Macht beim Fall „keine Geometrie gefunden" sichtbar, WORAN es
 * liegt (z. B. „0 Entities" = Encoding-/Versions-Problem vs. „500 ARC, 200 INSERT").
 */
export interface ImportDiagnostics {
  /** Anzahl je (Modellraum-)Entity-Typ, inkl. expandierter Block-Entities. */
  entityCounts: Record<string, number>;
  /** Gesamtzahl betrachteter Entities. */
  total: number;
}

/** Ergebnis eines DXF-/DWG-Imports: rohe Meshes + Konturen-Sätze + Texte. */
export interface DxfImportResult {
  meshes: ImportedMesh[];
  contours: ContourSet[];
  /** Importierte TEXT/MTEXT-Elemente. */
  texts?: ImportedText[];
  /** Optionale Diagnose (Entity-Typ-Histogramm). */
  diagnostics?: ImportDiagnostics;
  /** Farbe je DXF-Layer (Hex) aus der LAYER-Tabelle — für neu angelegte Kategorien. */
  layerColors?: Record<string, string>;
  /** `$INSUNITS` der Datei (0 = ohne Einheit, 4 = mm, 5 = cm, 6 = m …), roh wie gelesen. */
  insUnits?: number;
  /**
   * Meter je Zeicheneinheit nach `$INSUNITS` (mm 0.001, cm 0.01, m 1, Zoll 0.0254 …). Rust hat
   * Koordinaten, Radien und Texthöhen damit schon in Meter umgerechnet; hier nur zur Anzeige
   * („Datei in mm, umgerechnet“). 0/unbekannt = 1, die Koordinaten bleiben dann 1:1.
   */
  unitScale?: number;
}

let importSeq = 0;
const nextId = (prefix: string, idPrefix: string) => `${idPrefix}${prefix}-${Date.now()}-${importSeq++}`;

/** Eingabe als Bytes (Text wird UTF-8-kodiert). */
function toBytes(input: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Liest eine DXF-Datei (Text oder Bytes; Binär-DXF und DWG werden am Inhalt erkannt) in Kontext-
 * Geometrie. Wirft bei unlesbaren Dateien (Meldung aus Rust) oder wenn das Modul nicht geladen ist.
 * `idPrefix` macht ids eindeutig, wenn mehrere Realms (Worker) parallel parsen.
 */
export function parseDxf(input: string | ArrayBuffer | Uint8Array, idPrefix = ""): DxfImportResult {
  const { geom, strings } = importDrawingFlat(input);
  return decodeImport(geom, strings, idPrefix);
}

/** Rust-Aufruf: flacher Puffer + String-Tabelle (für die Übergabe aus dem Worker). */
export function importDrawingFlat(input: string | ArrayBuffer | Uint8Array): { geom: Float64Array; strings: string[] } {
  const m = fileioLoaded();
  if (!m) throw new Error("Format-Modul nicht geladen: loadFileio() muss vor dem Import laufen.");
  const res = m.import_drawing(toBytes(input));
  try {
    return { geom: res.geom(), strings: res.strings() };
  } finally {
    res.free();
  }
}

/** Dekodiert den Puffer aus `import.rs::encode` (Aufbau dort beschrieben). */
export function decodeImport(geom: Float64Array, strings: readonly string[], idPrefix = ""): DxfImportResult {
  let i = 0;
  const num = () => geom[i++];
  const str = () => strings[geom[i++]] ?? "";
  if (num() !== 2) throw new Error("Unbekanntes Importformat (Version).");
  const fmt = num() === 1 ? "DWG" : "DXF";
  const insUnits = num();
  const unitScale = num();
  const total = num();

  const layerColors: Record<string, string> = {};
  for (let n = num(), k = 0; k < n; k++) {
    const name = str();
    layerColors[name] = `#${(num() & 0xffffff).toString(16).padStart(6, "0")}`;
  }
  const entityCounts: Record<string, number> = {};
  for (let n = num(), k = 0; k < n; k++) {
    const name = str();
    entityCounts[name] = num();
  }

  const contours: Contour[] = [];
  for (let n = num(), k = 0; k < n; k++) {
    const layer = str();
    const flags = num();
    const z = num();
    const c: Contour = { z, pts: [], closed: (flags & 1) !== 0, layer };
    if (flags & 2) c.filled = true;
    if (flags & 4) {
      const kind = num() === 1 ? "circle" : "arc";
      c.curve = { kind, cx: num(), cy: num(), r: num(), a0: num(), a1: num() };
    }
    const np = num();
    const pts = new Array(np);
    for (let p = 0; p < np; p++) pts[p] = { x: geom[i + 2 * p], y: geom[i + 2 * p + 1] };
    i += 2 * np;
    c.pts = pts;
    contours.push(c);
  }

  const texts: ImportedText[] = [];
  for (let n = num(), k = 0; k < n; k++) {
    const layer = str();
    const text = str();
    const x = num();
    const y = num();
    const height = num();
    const angle = num();
    texts.push({ at: { x, y }, text, height, angle, layer });
  }

  const meshes: ImportedMesh[] = [];
  const nMeshes = num();
  for (let k = 0; k < nMeshes; k++) {
    const layer = str();
    const nPos = num();
    const nIdx = num();
    const positions = Array.from(geom.subarray(i, i + nPos * 3));
    i += nPos * 3;
    const indices = Array.from(geom.subarray(i, i + nIdx));
    i += nIdx;
    meshes.push({
      id: nextId("imported", idPrefix),
      type: "importedMesh",
      name: nMeshes > 1 ? `${fmt}-Mesh (${layer})` : `${fmt}-Mesh`,
      categoryCode: GENERIC_IMPORT_CATEGORY.code,
      layer: layer === "0" ? undefined : layer,
      positions,
      indices,
    });
  }

  const contourSets: ContourSet[] = [];
  if (contours.length > 0) {
    contourSets.push({
      id: nextId("contours", idPrefix),
      type: "contourSet",
      name: `${fmt}-Konturen`,
      categoryCode: GENERIC_IMPORT_CATEGORY.code,
      contours,
    });
  }
  return { meshes, contours: contourSets, texts, layerColors, diagnostics: { entityCounts, total }, insUnits, unitScale };
}
