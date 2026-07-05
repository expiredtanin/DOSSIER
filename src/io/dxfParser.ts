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
//   • ARC                            → Kontur (offener Bogen, tesselliert).
//   • CIRCLE                         → Kontur (geschlossener Kreis, tesselliert).
//   • ELLIPSE                        → Kontur (Ellipsenbogen/-umlauf, tesselliert).
//   • SPLINE                         → Kontur (B-Spline via De Boor; Fallback fitPoints).
//   • INSERT                         → Block-Konturen, transformiert (Scale/Rot/Array, verschachtelt).
//   • HATCH                          → gefüllte Kontur(en) je Randpfad (Custom-Handler,
//                                       Polyline- + Linien-/Bogen-/Ellipsen-/Spline-Kanten; Fill via `Contour.filled`).

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
  // Kurven-Entities (ARC/CIRCLE/ELLIPSE). Winkel liefert dxf-parser in RADIANT
  // (ARC/CIRCLE Grad→rad umgerechnet; ELLIPSE-Parameterwinkel roh in Radiant).
  center?: DxfVertex;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  /** ELLIPSE: Hauptachsen-Endpunkt RELATIV zum Center. */
  majorAxisEndPoint?: DxfVertex;
  /** ELLIPSE: Verhältnis Neben-/Hauptachse (b/a). */
  axisRatio?: number;
  // SPLINE-Felder. Winkel/Parameter roh; Knoten/Grad definieren die B-Spline.
  controlPoints?: DxfVertex[];
  fitPoints?: DxfVertex[];
  knotValues?: number[];
  degreeOfSplineCurve?: number;
  closed?: boolean;
  // INSERT-Felder (Block-Referenz). `position` (Einfügepunkt) wird tolerant
  // gelesen (das Feld ist oben als MESH-Vertexliste getippt) — daher hier NICHT
  // erneut deklariert; `rotation` ist in GRAD (anders als ARC/CIRCLE).
  name?: string;
  xScale?: number;
  yScale?: number;
  rotation?: number;
  columnCount?: number;
  rowCount?: number;
  columnSpacing?: number;
  rowSpacing?: number;
  // HATCH: rohe Gruppencodes (vom Custom-Handler gesammelt, siehe HatchHandler).
  rawCodes?: RawCode[];
  [k: string]: unknown;
}
/** Ein rohes DXF-Gruppencode/Wert-Paar (HATCH-Randpfad-Auswertung). */
interface RawCode {
  code: number;
  value: number | string;
}
/** Ein Block (BLOCKS-Tabelle): Basispunkt `position` + eigene Entity-Liste. */
interface DxfBlock {
  name?: string;
  position?: DxfVertex;
  entities?: DxfEntity[];
}
interface DxfDocument {
  entities?: DxfEntity[];
  blocks?: Record<string, DxfBlock>;
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
  // dxf-parser bringt keinen HATCH-Handler mit (verwirft HATCH sonst stumm).
  // Eigenen registrieren, der die rohen Gruppencodes einsammelt; die Auswertung
  // der Randpfade läuft separat und testbar in `hatchContours`.
  (parser as unknown as {
    registerEntityHandler: (h: new () => unknown) => void;
  }).registerEntityHandler(HatchHandler);
  // parseSync wirft bei strukturell kaputtem DXF; das soll nach oben.
  const doc = parser.parseSync(text) as unknown as DxfDocument;
  const entities = doc?.entities ?? [];
  const blocks = doc?.blocks ?? {};

  const meshTriangles: number[] = []; // gesammelte Mesh-Positions (x,y,z…)
  const meshIndices: number[] = [];
  const contours: Contour[] = [];

  for (const e of entities) {
    const type = (e.type ?? "").toUpperCase();
    // Mesh-Entities in die Dreiecks-Puffer; POLYLINE nur als Mesh-Variante.
    if (type === "3DFACE") {
      addFace(meshTriangles, meshIndices, e);
      continue;
    }
    if (type === "MESH") {
      addMesh(meshTriangles, meshIndices, e);
      continue;
    }
    if (type === "POLYLINE" && isMeshPolyline(e)) {
      addPolyfaceMesh(meshTriangles, meshIndices, e);
      continue;
    }
    // Alle übrigen Kontur-Entities (inkl. SPLINE + INSERT-Block-Expansion) über
    // den gemeinsamen Sammler — dieselbe Logik nutzt die INSERT-Rekursion.
    collectContours(e, blocks, contours, 0);
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

// ── Kurven-Entities (ARC/CIRCLE/ELLIPSE) → tessellierte Konturen ──────────────

/** Winkelauflösung der Tessellierung (~5.6° pro Segment). */
const CURVE_STEP = Math.PI / 32;
/** Obergrenze der Segmentzahl (Schutz gegen entartete Eingaben). */
const CURVE_MAX_SEG = 256;

/** Segmentzahl für eine Winkelspanne (Radiant): mind. 2, gedeckelt. */
function segmentsFor(sweep: number): number {
  return Math.max(2, Math.min(CURVE_MAX_SEG, Math.ceil(Math.abs(sweep) / CURVE_STEP)));
}

/**
 * ARC → offener Bogen-Linienzug. `startAngle`/`endAngle` in Radiant (dxf-parser
 * rechnet Grad→rad). Bögen laufen CCW; eine nicht-positive Spanne wird um 2π
 * ergänzt (voller-Kreis-Fall bleibt 2π).
 */
function arcContour(e: DxfEntity): Contour | null {
  const c = e.center;
  const r = e.radius;
  if (
    !c ||
    !Number.isFinite(c.x) ||
    !Number.isFinite(c.y) ||
    typeof r !== "number" ||
    !Number.isFinite(r) ||
    r <= 0
  ) {
    return null;
  }
  const start = Number.isFinite(e.startAngle) ? (e.startAngle as number) : 0;
  const end = Number.isFinite(e.endAngle) ? (e.endAngle as number) : Math.PI * 2;
  let sweep = end - start;
  if (sweep <= 0) sweep += Math.PI * 2;
  const cx = c.x ?? 0;
  const cy = c.y ?? 0;
  const z = Number.isFinite(c.z) ? (c.z as number) : 0;
  const segs = segmentsFor(sweep);
  const pts: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = start + (sweep * i) / segs;
    pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return { z, pts, closed: false, layer: e.layer };
}

/** CIRCLE → geschlossener Kreis-Linienzug (voller Umlauf, letzter Punkt weggelassen). */
function circleContour(e: DxfEntity): Contour | null {
  const c = e.center;
  const r = e.radius;
  if (
    !c ||
    !Number.isFinite(c.x) ||
    !Number.isFinite(c.y) ||
    typeof r !== "number" ||
    !Number.isFinite(r) ||
    r <= 0
  ) {
    return null;
  }
  const cx = c.x ?? 0;
  const cy = c.y ?? 0;
  const z = Number.isFinite(c.z) ? (c.z as number) : 0;
  const segs = segmentsFor(Math.PI * 2);
  const pts: Vec2[] = [];
  // 0..2π ohne Schluss-Duplikat (closed schließt den Ring).
  for (let i = 0; i < segs; i++) {
    const t = (Math.PI * 2 * i) / segs;
    pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return { z, pts, closed: true, layer: e.layer };
}

/**
 * ELLIPSE → Linienzug. Hauptachse = `majorAxisEndPoint` (Vektor relativ zum
 * Center), Nebenachse = ⟂ dazu · `axisRatio`. `startAngle`/`endAngle` sind
 * PARAMETERwinkel in Radiant; ein voller Umlauf (Spanne ≈ 2π) wird geschlossen.
 * Punkt(t) = Center + cos t · Haupt + sin t · Neben.
 */
function ellipseContour(e: DxfEntity): Contour | null {
  const c = e.center;
  const maj = e.majorAxisEndPoint;
  const ratio = e.axisRatio;
  if (
    !c ||
    !maj ||
    !Number.isFinite(c.x) ||
    !Number.isFinite(c.y) ||
    !Number.isFinite(maj.x) ||
    !Number.isFinite(maj.y) ||
    typeof ratio !== "number" ||
    !Number.isFinite(ratio)
  ) {
    return null;
  }
  const cx = c.x ?? 0;
  const cy = c.y ?? 0;
  const ax = maj.x ?? 0; // Hauptachsen-Vektor (relativ Center)
  const ay = maj.y ?? 0;
  const bx = -ay * ratio; // Nebenachse = Linksnormale der Hauptachse · Verhältnis
  const by = ax * ratio;
  const start = Number.isFinite(e.startAngle) ? (e.startAngle as number) : 0;
  const end = Number.isFinite(e.endAngle) ? (e.endAngle as number) : Math.PI * 2;
  let sweep = end - start;
  if (sweep <= 0) sweep += Math.PI * 2;
  const full = Math.abs(sweep - Math.PI * 2) < 1e-9;
  const z = Number.isFinite(c.z) ? (c.z as number) : 0;
  const segs = segmentsFor(sweep);
  const pts: Vec2[] = [];
  // Bei vollem Umlauf Schluss-Duplikat weglassen (closed schließt den Ring).
  const last = full ? segs - 1 : segs;
  for (let i = 0; i <= last; i++) {
    const t = start + (sweep * i) / segs;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    pts.push({ x: cx + ax * ct + bx * st, y: cy + ay * ct + by * st });
  }
  return { z, pts, closed: full, layer: e.layer };
}

// ── SPLINE (B-Spline via De Boor) ────────────────────────────────────────────

/** DxfVertex-Liste → finite Vec2-Stützpunkte. */
function toVec2s(vs: DxfVertex[] | undefined): Vec2[] {
  const out: Vec2[] = [];
  for (const v of vs ?? []) {
    if (Number.isFinite(v.x) && Number.isFinite(v.y)) {
      out.push({ x: v.x ?? 0, y: v.y ?? 0 });
    }
  }
  return out;
}

/** Erster finiter Z-Wert einer DxfVertex-Liste (sonst 0). */
function firstZ(vs: DxfVertex[] | undefined): number {
  for (const v of vs ?? []) if (Number.isFinite(v.z)) return v.z as number;
  return 0;
}

/**
 * Knoten-Span-Index (The NURBS Book, A2.1): grösstes k mit U[k] ≤ t < U[k+1],
 * geklemmt auf [p, n]. `n` = letzter Kontrollpunkt-Index.
 */
function findSpan(n: number, p: number, t: number, U: number[]): number {
  if (t >= U[n + 1]) return n;
  if (t <= U[p]) return p;
  let low = p;
  let high = n + 1;
  let mid = Math.floor((low + high) / 2);
  while (t < U[mid] || t >= U[mid + 1]) {
    if (t < U[mid]) high = mid;
    else low = mid;
    mid = Math.floor((low + high) / 2);
  }
  return mid;
}

/** Punkt einer (nicht-rationalen) B-Spline bei Parameter t (De Boor, A2.4). */
function deBoor(cps: Vec2[], U: number[], p: number, t: number): Vec2 {
  const n = cps.length - 1;
  const span = findSpan(n, p, t, U);
  const d: Vec2[] = [];
  for (let j = 0; j <= p; j++) d[j] = { ...cps[span - p + j] };
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = span - p + j;
      const denom = U[i + p - r + 1] - U[i];
      const a = denom === 0 ? 0 : (t - U[i]) / denom;
      d[j] = {
        x: (1 - a) * d[j - 1].x + a * d[j].x,
        y: (1 - a) * d[j - 1].y + a * d[j].y,
      };
    }
  }
  return d[p];
}

/**
 * Nicht-rationale B-Spline über die Domäne [U[p], U[n+1]] abtasten (De Boor),
 * wenn Kontrollpunkte/Knoten/Grad konsistent sind (|U| = |P| + Grad + 1). Sonst
 * null. ~8 Abtastpunkte je Kontrollpunkt, gedeckelt.
 */
function sampleBSpline(cps: Vec2[], knots: number[], degree: number): Vec2[] | null {
  if (cps.length < 2 || degree < 1 || knots.length !== cps.length + degree + 1) {
    return null;
  }
  const samples = Math.max(16, Math.min(CURVE_MAX_SEG, cps.length * 8));
  const n = cps.length - 1;
  const t0 = knots[degree];
  const t1 = knots[n + 1];
  const pts: Vec2[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i === samples ? t1 : t0 + ((t1 - t0) * i) / samples;
    pts.push(deBoor(cps, knots, degree, t));
  }
  return pts;
}

/**
 * SPLINE → Linienzug. Primär echte B-Spline-Auswertung (Kontrollpunkte + Knoten
 * + Grad, wenn der Knotenvektor konsistent ist: |U| = |P| + Grad + 1). Sonst
 * Rückfall auf Stützpunkte (fitPoints) bzw. — grob — das Kontrollpolygon.
 * Rationale Gewichte werden ignoriert (selten; dxf-parser liefert sie nicht).
 */
function splineContour(e: DxfEntity): Contour | null {
  const cps = toVec2s(e.controlPoints);
  const fps = toVec2s(e.fitPoints);
  const knots = (e.knotValues ?? []).filter((k) => Number.isFinite(k));
  const degree = Number.isFinite(e.degreeOfSplineCurve)
    ? (e.degreeOfSplineCurve as number)
    : 3;
  const closed = e.closed === true;
  const z = cps.length > 0 ? firstZ(e.controlPoints) : firstZ(e.fitPoints);

  const sampled = sampleBSpline(cps, knots, degree);
  if (sampled) return { z, pts: sampled, closed, layer: e.layer };
  if (fps.length >= 2) return { z, pts: fps, closed, layer: e.layer };
  if (cps.length >= 2) return { z, pts: cps, closed, layer: e.layer };
  return null;
}

// ── INSERT (Block-Referenz → transformierte Konturen) ─────────────────────────

/** Tolerantes Zahlenfeld: endliche Zahl oder Default. */
function numOr(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/** Tolerante Koordinate aus einem (unbekannt getippten) Punktobjekt. */
function coord(v: unknown, key: "x" | "y"): number {
  if (v && typeof v === "object") {
    const n = (v as Record<string, unknown>)[key];
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return 0;
}

/** Schutz gegen zyklische/tief verschachtelte Blockreferenzen. */
const MAX_INSERT_DEPTH = 8;

/**
 * INSERT expandieren: Block-Entities rekursiv zu LOKALEN Konturen sammeln, dann
 * je Array-Zelle mit der 2D-Transform der Referenz nach Welt abbilden.
 * Welt(p, off) = Einfügepunkt + Rot(θ) · ( Scale(p − Basispunkt) + off ).
 * `off` = (Spalte·Spaltenabstand, Zeile·Zeilenabstand) im rotierten Blockraster.
 */
function expandInsert(
  e: DxfEntity,
  blocks: Record<string, DxfBlock>,
  out: Contour[],
  depth: number,
): void {
  if (depth >= MAX_INSERT_DEPTH) return;
  const name = typeof e.name === "string" ? e.name : null;
  if (!name) return;
  const block = blocks[name];
  if (!block || !Array.isArray(block.entities)) return;

  const sx = numOr(e.xScale, 1);
  const sy = numOr(e.yScale, 1);
  const rot = (numOr(e.rotation, 0) * Math.PI) / 180; // INSERT-Rotation in GRAD
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const ix = coord(e.position, "x"); // Einfügepunkt (tolerant gelesen)
  const iy = coord(e.position, "y");
  const bx = coord(block.position, "x"); // Block-Basispunkt
  const by = coord(block.position, "y");
  const nc = Math.max(1, Math.floor(numOr(e.columnCount, 1)));
  const nr = Math.max(1, Math.floor(numOr(e.rowCount, 1)));
  const dc = numOr(e.columnSpacing, 0);
  const dr = numOr(e.rowSpacing, 0);

  // Block-Inhalt EINMAL lokal sammeln (rekursiv), dann je Zelle transformieren.
  const local: Contour[] = [];
  for (const be of block.entities) collectContours(be, blocks, local, depth + 1);
  if (local.length === 0) return;

  for (let row = 0; row < nr; row++) {
    for (let col = 0; col < nc; col++) {
      const offx = col * dc;
      const offy = row * dr;
      for (const lc of local) {
        const pts = lc.pts.map((p) => {
          const vx = (p.x - bx) * sx + offx;
          const vy = (p.y - by) * sy + offy;
          return { x: ix + (vx * cos - vy * sin), y: iy + (vx * sin + vy * cos) };
        });
        out.push({ z: lc.z, pts, closed: lc.closed, layer: e.layer ?? lc.layer });
      }
    }
  }
}

/**
 * Gemeinsamer Kontur-Dispatch für eine Entity (Top-Level UND Block-Inhalt).
 * Mesh-Entities werden hier NICHT behandelt (nur der Top-Level-Pfad erzeugt
 * Meshes; Block-interne Meshes sind im 2D-Import selten und bleiben aussen vor).
 */
function collectContours(
  e: DxfEntity,
  blocks: Record<string, DxfBlock>,
  out: Contour[],
  depth: number,
): void {
  const type = (e.type ?? "").toUpperCase();
  switch (type) {
    case "LWPOLYLINE": {
      const c = polylineContour(e);
      if (c) out.push(c);
      break;
    }
    case "POLYLINE": {
      if (!isMeshPolyline(e)) {
        const c = polylineContour(e);
        if (c) out.push(c);
      }
      break;
    }
    case "LINE": {
      const c = lineContour(e);
      if (c) out.push(c);
      break;
    }
    case "ARC": {
      const c = arcContour(e);
      if (c) out.push(c);
      break;
    }
    case "CIRCLE": {
      const c = circleContour(e);
      if (c) out.push(c);
      break;
    }
    case "ELLIPSE": {
      const c = ellipseContour(e);
      if (c) out.push(c);
      break;
    }
    case "SPLINE": {
      const c = splineContour(e);
      if (c) out.push(c);
      break;
    }
    case "HATCH":
      for (const c of hatchContours(e)) out.push(c);
      break;
    case "INSERT":
      expandInsert(e, blocks, out, depth);
      break;
    default:
      // Unbekannte/irrelevante Entity → ignorieren (tolerant).
      break;
  }
}

// ── HATCH (Custom-Handler + Randpfad-Auswertung → gefüllte Konturen) ──────────

/**
 * Custom dxf-parser-Handler für HATCH: sammelt die rohen Gruppencodes der Entity
 * (bis zum nächsten Code 0), OHNE zu interpretieren. Muster wie die eingebauten
 * Handler (Schleife bricht bei Code 0; `lastReadGroup` bleibt darauf stehen).
 * Die eigentliche Randpfad-Logik liegt testbar in `hatchContours`.
 */
class HatchHandler {
  ForEntityName = "HATCH";
  parseEntity(
    scanner: {
      next: () => { code: number; value: number | string };
      isEOF: () => boolean;
    },
    curr: { code: number; value: number | string },
  ): DxfEntity {
    const raw: RawCode[] = [];
    const entity: DxfEntity = { type: String(curr.value), rawCodes: raw };
    curr = scanner.next();
    while (!scanner.isEOF()) {
      if (curr.code === 0) break;
      if (curr.code === 8) entity.layer = String(curr.value);
      raw.push({ code: curr.code, value: curr.value });
      curr = scanner.next();
    }
    return entity;
  }
}

/** Zahlenwert eines Gruppencodes (tolerant). */
function rc(v: number | string | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = typeof v === "string" ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Erster Wert eines Codes aus der Kanten-Code-Sammlung. */
function firstOf(m: Map<number, number[]>, code: number): number | undefined {
  const a = m.get(code);
  return a && a.length > 0 ? a[0] : undefined;
}

/** Bogenkante (Kantentyp 2): Zentrum/Radius, Winkel in GRAD, ggf. im Uhrzeigersinn. */
function pushArcEdge(pts: Vec2[], m: Map<number, number[]>): void {
  const cx = firstOf(m, 10);
  const cy = firstOf(m, 20);
  const r = firstOf(m, 40);
  if (cx === undefined || cy === undefined || r === undefined || r <= 0) return;
  const s = (firstOf(m, 50) ?? 0) * (Math.PI / 180);
  const e = (firstOf(m, 51) ?? 360) * (Math.PI / 180);
  const ccw = (firstOf(m, 73) ?? 1) !== 0;
  // Spanne in Laufrichtung auf (0, 2π] normieren.
  let sweep = ccw ? e - s : -(e - s);
  sweep = ((sweep % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (sweep === 0) sweep = Math.PI * 2;
  const dir = ccw ? 1 : -1;
  const segs = segmentsFor(sweep);
  // Startpunkt weglassen, wenn er den vorherigen Kanten-Endpunkt dupliziert.
  for (let i = 0; i <= segs; i++) {
    const t = s + dir * (sweep * i) / segs;
    pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
}

/**
 * Ellipsenkante (Kantentyp 3): Zentrum (10/20), Hauptachsen-Endpunkt relativ
 * (11/21), Achsverhältnis (40), Start/End-PARAMETERwinkel in GRAD (50/51), ggf.
 * im Uhrzeigersinn (73). Punkt(t) = Center + cos t·Haupt + sin t·Neben.
 */
function pushEllipseEdge(pts: Vec2[], m: Map<number, number[]>): void {
  const cx = firstOf(m, 10);
  const cy = firstOf(m, 20);
  const mx = firstOf(m, 11);
  const my = firstOf(m, 21);
  const ratio = firstOf(m, 40);
  if (cx === undefined || cy === undefined || mx === undefined || my === undefined || ratio === undefined) {
    return;
  }
  const bx = -my * ratio; // Nebenachse = Linksnormale der Hauptachse · Verhältnis
  const by = mx * ratio;
  const s = (firstOf(m, 50) ?? 0) * (Math.PI / 180);
  const e = (firstOf(m, 51) ?? 360) * (Math.PI / 180);
  const ccw = (firstOf(m, 73) ?? 1) !== 0;
  let sweep = ccw ? e - s : -(e - s);
  sweep = ((sweep % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (sweep === 0) sweep = Math.PI * 2;
  const dir = ccw ? 1 : -1;
  const segs = segmentsFor(sweep);
  for (let i = 0; i <= segs; i++) {
    const t = s + (dir * (sweep * i)) / segs;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    pts.push({ x: cx + mx * ct + bx * st, y: cy + my * ct + by * st });
  }
}

/**
 * Spline-Kante (Kantentyp 4): Grad (94), Knoten (40×), Kontrollpunkte (10/20×).
 * Über De Boor abgetastet (rationale Gewichte 42 ignoriert). Fallback: rohe
 * Kontrollpunkte als Polygonzug.
 */
function pushSplineEdge(pts: Vec2[], m: Map<number, number[]>): void {
  const xs = m.get(10) ?? [];
  const ys = m.get(20) ?? [];
  const cps: Vec2[] = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) cps.push({ x: xs[i], y: ys[i] });
  const knots = m.get(40) ?? [];
  const degree = firstOf(m, 94) ?? 3;
  const sampled = sampleBSpline(cps, knots, degree);
  if (sampled) {
    for (const p of sampled) pts.push(p);
  } else {
    for (const p of cps) pts.push(p);
  }
}

/** Punkte einer HATCH-Randkante an die Loop-Punkte anhängen (Typ 1/2/3/4). */
function appendEdge(pts: Vec2[], edgeType: number, m: Map<number, number[]>): void {
  if (edgeType === 1) {
    // Linie: Start (10/20) — der Endpunkt ist der Start der nächsten Kante.
    const x = firstOf(m, 10);
    const y = firstOf(m, 20);
    if (x !== undefined && y !== undefined) pts.push({ x, y });
    // Bei der LETZTEN Kante fehlt sonst der Endpunkt; der closed-Ring schließt ihn.
    return;
  }
  if (edgeType === 2) pushArcEdge(pts, m);
  else if (edgeType === 3) pushEllipseEdge(pts, m);
  else if (edgeType === 4) pushSplineEdge(pts, m);
}

/**
 * HATCH-Entity (rohe Gruppencodes) → gefüllte, geschlossene Konturen (ein Loop
 * je Randpfad). Unterstützt Polyline-Randpfade (Flag-Bit 2) sowie Kanten-Pfade
 * mit Linien-, Bogen-, Ellipsen- und Spline-Kanten (alle tesselliert). Bulges an
 * Polyline-Rändern werden ignoriert (als Sehne); Insel-Loops entstehen als eigene
 * geschlossene Ringe (keine echten Löcher).
 */
function hatchContours(e: DxfEntity): Contour[] {
  const raw = e.rawCodes;
  if (!raw || raw.length === 0) return [];
  const n = raw.length;
  const layer = e.layer;

  // Zum ersten Code 91 (Anzahl Randpfade).
  let i = 0;
  while (i < n && raw[i].code !== 91) i++;
  if (i >= n) return [];
  const numPaths = rc(raw[i].value);
  i++;

  const loops: Contour[] = [];
  for (let p = 0; p < numPaths && i < n; p++) {
    // Zum Pfadtyp-Flag (92) des nächsten Pfads.
    while (i < n && raw[i].code !== 92) i++;
    if (i >= n) break;
    const flag = rc(raw[i].value);
    i++;
    const isPolyline = (flag & 2) !== 0;
    const pts: Vec2[] = [];

    if (isPolyline) {
      // Optionale 72/73 überspringen, bis 93 (Vertex-Anzahl).
      while (i < n && raw[i].code !== 93) i++;
      if (i >= n) break;
      const numVerts = rc(raw[i].value);
      i++;
      let cx: number | null = null;
      let got = 0;
      while (i < n && got < numVerts) {
        const c = raw[i];
        if (c.code === 91 || c.code === 92) break; // Sicherheitsnetz
        if (c.code === 10) {
          cx = rc(c.value);
        } else if (c.code === 20 && cx !== null) {
          pts.push({ x: cx, y: rc(c.value) });
          cx = null;
          got++;
        }
        i++;
      }
    } else {
      // Kanten-Pfad: 93 = Anzahl Kanten.
      while (i < n && raw[i].code !== 93) i++;
      if (i >= n) break;
      const numEdges = rc(raw[i].value);
      i++;
      for (let ed = 0; ed < numEdges && i < n; ed++) {
        // Zum Kantentyp (72), aber nicht über den Pfad/Kanten-Block hinaus.
        while (
          i < n &&
          raw[i].code !== 72 &&
          raw[i].code !== 97 &&
          raw[i].code !== 92 &&
          raw[i].code !== 91
        ) {
          i++;
        }
        if (i >= n || raw[i].code !== 72) break;
        const edgeType = rc(raw[i].value);
        i++;
        // Kanten-Codes bis zur nächsten Kante/Blockgrenze sammeln.
        const m = new Map<number, number[]>();
        while (i < n) {
          const c = raw[i];
          if (c.code === 72 || c.code === 97 || c.code === 92 || c.code === 91) break;
          const arr = m.get(c.code) ?? [];
          arr.push(rc(c.value));
          m.set(c.code, arr);
          i++;
        }
        appendEdge(pts, edgeType, m);
      }
    }

    if (pts.length >= 2) {
      loops.push({ z: 0, pts, closed: true, layer, filled: true });
    }
  }
  return loops;
}
