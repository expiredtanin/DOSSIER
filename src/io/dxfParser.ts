// DXF-Import → Kontext-Geometrie (three-frei).
//
// Importierte Geometrie ist „dumme" KONTEXT-Geometrie (Anzeige + späteres
// Snap-Ziel), NICHT semantisch. Dieser Parser liefert nur rohe Buffer-Daten
// (positions/indices) bzw. Konturen (Vec2 + Z), die in `Project.context` landen.
//
// ── DWG-Hinweis (bewusst KEIN DWG-Parser) ──────────────────────────────────
// DWG ist ein geschlossenes Binärformat ohne robusten Pure-JS-Parser; wir bauen
// hier KEINEN DWG-Parser. Der Import-Weg führt über DXF:
//   DWG → DXF konvertieren (gratis „ODA File Converter" von der Open Design
//   Alliance), dann die DXF-Datei hier importieren.
// LibreDWG-WASM ist nicht zuverlässig genug und wird bewusst nicht verfolgt.
//
// Unterstützte DXF-Entities:
//   • 3DFACE                         → Dreiecks-Mesh (3 bzw. 4 Ecken → 1–2 Tri).
//   • POLYLINE (Polyface/PolygonMesh)→ Dreiecks-Mesh (Faces bzw. Gitter).
//   • MESH                           → Dreiecks-Mesh (Vertices + Face-Liste).
//   • LWPOLYLINE / POLYLINE (2D/3D)  → Kontur (z aus elevation/Vertex-Z).
//   • LINE                           → Kontur (zwei-Punkt-Linienzug).

import DxfParser from "dxf-parser";
import type { Contour, ContourSet, ImportedMesh, Vec2 } from "../model/types";

/**
 * Optionale Import-Diagnose: Histogramm der gelesenen Entity-Typen (Typ → Anzahl)
 * und die Gesamtzahl. Wird vor allem vom DWG-Parser gefüllt, damit beim Fall
 * „keine Geometrie gefunden" sichtbar wird, WORAN es liegt (z. B. „0 Entities" =
 * Encoding-/Versions-Problem vs. „500 ARC, 200 INSERT" = Abdeckungslücke).
 */
export interface ImportDiagnostics {
  /** Anzahl je (Modellraum-)Entity-Typ, inkl. expandierter Block-Entities. */
  entityCounts: Record<string, number>;
  /** Gesamtzahl betrachteter Entities. */
  total: number;
}

/** Ergebnis eines DXF-Imports: rohe Meshes + Konturen-Sätze. */
export interface DxfImportResult {
  meshes: ImportedMesh[];
  contours: ContourSet[];
  /** Optionale Diagnose (Entity-Typ-Histogramm); vom DWG-Parser gefüllt. */
  diagnostics?: ImportDiagnostics;
}

// Lose getippte Sicht auf die dxf-parser-Ausgabe (das Paket liefert keine engen
// Typen); wir greifen tolerant auf die Felder zu, die wir brauchen.
interface DxfVertex {
  x?: number;
  y?: number;
  z?: number;
  // Polyface-Mesh: 1-basierte, ggf. negative Vertex-Indizes (negativ = unsichtbare Kante).
  faces?: number[];
}
interface DxfEntity {
  type?: string;
  layer?: string;
  elevation?: number;
  vertices?: DxfVertex[];
  // MESH-Entity-Felder (variieren je nach Parser-Version):
  position?: DxfVertex[];
  faces?: number[][];
  isPolyfaceMesh?: boolean;
  is3dPolygonMesh?: boolean;
  [k: string]: unknown;
}
interface DxfDocument {
  entities?: DxfEntity[];
}

let importSeq = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now()}-${importSeq++}`;

/**
 * Parst DXF-Text in Kontext-Geometrie. Tolerant gegen fehlende Felder; nicht
 * unterstützte/leere Entities werden übersprungen. Ein fataler Parse-Fehler wird
 * geworfen (der Aufrufer kann ihn anzeigen) — pro-Entity-Fehler nicht.
 */
export function parseDxf(text: string): DxfImportResult {
  const parser = new DxfParser();
  // parseSync wirft bei strukturell kaputtem DXF; das soll nach oben.
  const doc = parser.parseSync(text) as unknown as DxfDocument;
  const entities = doc?.entities ?? [];

  const meshTriangles: number[] = []; // gesammelte Mesh-Positions (x,y,z…)
  const meshIndices: number[] = [];
  const contours: Contour[] = [];

  for (const e of entities) {
    const type = (e.type ?? "").toUpperCase();
    switch (type) {
      case "3DFACE":
        addFace(meshTriangles, meshIndices, e);
        break;
      case "MESH":
        addMesh(meshTriangles, meshIndices, e);
        break;
      case "POLYLINE":
        // POLYLINE ist mehrdeutig: Polyface/PolygonMesh → Mesh; sonst → Kontur.
        if (isMeshPolyline(e)) {
          addPolyfaceMesh(meshTriangles, meshIndices, e);
        } else {
          const ct = polylineContour(e);
          if (ct) contours.push(ct);
        }
        break;
      case "LWPOLYLINE": {
        const ct = polylineContour(e);
        if (ct) contours.push(ct);
        break;
      }
      case "LINE": {
        const ct = lineContour(e);
        if (ct) contours.push(ct);
        break;
      }
      default:
        // Unbekannte/irrelevante Entity → ignorieren (tolerant).
        break;
    }
  }

  const meshes: ImportedMesh[] = [];
  if (meshIndices.length > 0) {
    meshes.push({
      id: nextId("imported"),
      type: "importedMesh",
      name: "DXF-Mesh",
      positions: meshTriangles,
      indices: meshIndices,
    });
  }

  const contourSets: ContourSet[] = [];
  if (contours.length > 0) {
    contourSets.push({
      id: nextId("contours"),
      type: "contourSet",
      name: "DXF-Konturen",
      contours,
    });
  }

  return { meshes, contours: contourSets };
}

// ── Mesh-Entities ────────────────────────────────────────────────────────────

/** Fügt einen Vertex zu positions hinzu und liefert seinen Index. */
function pushVertex(
  positions: number[],
  x: number,
  y: number,
  z: number,
): number {
  const idx = positions.length / 3;
  positions.push(x, y, z);
  return idx;
}

/**
 * 3DFACE: 3 oder 4 Eckpunkte. Bei 4 Punkten zwei Dreiecke (Fan). Entartete
 * (degenerierte) Punkte (4. == 3.) ergeben nur ein Dreieck.
 */
function addFace(positions: number[], indices: number[], e: DxfEntity): void {
  const vs = (e.vertices ?? []).filter(
    (v) => Number.isFinite(v.x) && Number.isFinite(v.y),
  );
  if (vs.length < 3) return;
  const idx = vs.map((v) =>
    pushVertex(positions, v.x ?? 0, v.y ?? 0, v.z ?? 0),
  );
  // Dreieck (0,1,2).
  pushTri(indices, positions, idx[0], idx[1], idx[2]);
  // Viereck → zweites Dreieck (0,2,3), falls 4. Punkt vorhanden und ≠ 3.
  if (idx.length >= 4) pushTri(indices, positions, idx[0], idx[2], idx[3]);
}

/**
 * MESH-Entity: explizite Vertex-Liste + Face-Liste. Die Face-Liste kann Drei-
 * oder Vierecke enthalten (jeweils 0-basierte Vertex-Indizes); Vierecke werden
 * fan-trianguliert.
 */
function addMesh(positions: number[], indices: number[], e: DxfEntity): void {
  const verts = e.position ?? e.vertices ?? [];
  if (verts.length === 0) return;
  const base = positions.length / 3;
  for (const v of verts) {
    positions.push(v.x ?? 0, v.y ?? 0, v.z ?? 0);
  }
  const faces = Array.isArray(e.faces) ? e.faces : [];
  for (const face of faces) {
    if (!Array.isArray(face) || face.length < 3) continue;
    for (let i = 1; i + 1 < face.length; i++) {
      pushTri(
        indices,
        positions,
        base + face[0],
        base + face[i],
        base + face[i + 1],
      );
    }
  }
}

/** Ob eine POLYLINE eine Mesh-Variante ist (Polyface- oder Polygon-Gitter). */
function isMeshPolyline(e: DxfEntity): boolean {
  if (e.isPolyfaceMesh === true || e.is3dPolygonMesh === true) return true;
  // Heuristik: enthält irgendein Vertex eine `faces`-Liste → Polyface-Mesh.
  return (e.vertices ?? []).some(
    (v) => Array.isArray(v.faces) && v.faces.length > 0,
  );
}

/**
 * Polyface-Mesh (POLYLINE, Flag 64): erst Geometrie-Vertices, dann Face-Records
 * mit 1-basierten (ggf. negativen = unsichtbare Kante) Vertex-Indizes. Wir
 * trennen Geometrie- von Face-Vertices und fan-triangulieren jede Face.
 */
function addPolyfaceMesh(
  positions: number[],
  indices: number[],
  e: DxfEntity,
): void {
  const all = e.vertices ?? [];
  const geom = all.filter((v) => !(Array.isArray(v.faces) && v.faces.length));
  const faceRecs = all.filter((v) => Array.isArray(v.faces) && v.faces.length);
  if (geom.length < 3) return;
  const base = positions.length / 3;
  for (const v of geom) {
    positions.push(v.x ?? 0, v.y ?? 0, v.z ?? 0);
  }
  for (const fr of faceRecs) {
    // 1-basierte Indizes; Vorzeichen markiert (un)sichtbare Kanten → abs().
    const ring = (fr.faces ?? [])
      .map((i) => Math.abs(i))
      .filter((i) => i >= 1)
      .map((i) => base + (i - 1));
    if (ring.length < 3) continue;
    for (let i = 1; i + 1 < ring.length; i++) {
      pushTri(indices, positions, ring[0], ring[i], ring[i + 1]);
    }
  }
}

/**
 * Fügt ein Dreieck hinzu, sofern es nicht entartet ist (zwei gleiche Indizes
 * oder kollineare/Null-Flächen-Ecken). Hält das importierte Mesh sauber.
 */
function pushTri(
  indices: number[],
  positions: number[],
  a: number,
  b: number,
  c: number,
): void {
  if (a === b || b === c || a === c) return;
  const n = positions.length / 3;
  if (a < 0 || b < 0 || c < 0 || a >= n || b >= n || c >= n) return;
  indices.push(a, b, c);
}

// ── Kontur-Entities ──────────────────────────────────────────────────────────

/**
 * LWPOLYLINE / 2D-/3D-POLYLINE → Kontur. Z-Höhe: bei 3D-Polylinie aus den
 * Vertex-Z (erster gültiger), sonst aus `elevation`, sonst 0. Die 2D-Punkte sind
 * (x,y) jedes Vertex. Bei < 2 Punkten wird nichts erzeugt.
 */
function polylineContour(e: DxfEntity): Contour | null {
  const vs = e.vertices ?? [];
  const pts: Vec2[] = [];
  let zFromVertex: number | undefined;
  for (const v of vs) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
    pts.push({ x: v.x ?? 0, y: v.y ?? 0 });
    if (zFromVertex === undefined && Number.isFinite(v.z)) zFromVertex = v.z;
  }
  if (pts.length < 2) return null;
  const z = zFromVertex ?? (Number.isFinite(e.elevation) ? (e.elevation as number) : 0);
  // closed-Flag aus dem Parser ableiten (LWPOLYLINE: `shape`, POLYLINE: `shape`).
  const closed = e.shape === true || e.closed === true;
  return { z, pts, closed, layer: e.layer };
}

/** LINE → zweipunktige (offene) Kontur. Z aus dem Start-Vertex (sonst 0). */
function lineContour(e: DxfEntity): Contour | null {
  const vs = e.vertices ?? [];
  if (vs.length < 2) return null;
  const a = vs[0];
  const b = vs[1];
  if (
    !Number.isFinite(a.x) ||
    !Number.isFinite(a.y) ||
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y)
  ) {
    return null;
  }
  const z = Number.isFinite(a.z) ? (a.z as number) : 0;
  return {
    z,
    pts: [
      { x: a.x ?? 0, y: a.y ?? 0 },
      { x: b.x ?? 0, y: b.y ?? 0 },
    ],
    closed: false,
    layer: e.layer,
  };
}
