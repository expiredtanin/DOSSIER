// Freie-2D-Geometrie-Domäne der 3D-Ableitung: zeigt jede 2D-Zeichnung
// (line/polyline/rect) als Boden-Spur knapp über ihrer Geschossebene — die
// "2D-Referenz im 3D", die der drei.js-Fallback (`addDrawing2DLines` in
// Viewport3D.tsx) zeigt.
//
// Die Spuren gehen als LineList-Vertices (`emitDrawingLineVerts`) über einen
// eigenen BINÄREN Kanal an render3d (`set_drawing_lines`), NICHT als Meshes
// über `RModel3d.meshes`/`set_model`. Grund: ein Kataster-DXF kann Millionen
// Segmente liefern — als Ribbon-Meshes im JSON-Modell sprengt das sowohl die
// JS-String-Längengrenze als auch den Vertexspeicher (s. Funktionsdoc unten).

import type { Drawing2D, Project, Vec2 } from "../../model/types";
import { flattenCategories, getFloor } from "../../model/types";
import { DRAWING_LINE_FALLBACK_RGB, hexToRgb, type RRgb } from "./shared";
import { DRAWING_PICK_TOLERANCE, type PickDrawingSeg } from "../pickTypes";

/** Höhen-Offset über der Geschossebene gegen Z-Fighting (wie addDrawing2DLines in Viewport3D.tsx). */
const DRAWING_LINE_ELEVATION_EPS = 0.01;

/**
 * Strecken eines 2D-Zeichenelements für die Boden-Spur im 3D — exakt dieselbe
 * Teilmenge wie `drawing2DSegments` im drei.js-Fallback (`Viewport3D.tsx`):
 * line/polyline/rect. Kreis/Bogen/Text bleiben aussen vor (keine neue
 * Fähigkeit gegenüber dem Fallback, nur Parität).
 */
export function drawingSegments3d(d: Drawing2D): [Vec2, Vec2][] {
  const g = d.geom;
  const out: [Vec2, Vec2][] = [];
  if (g.shape === "line") out.push([g.a, g.b]);
  else if (g.shape === "polyline") {
    for (let i = 0; i < g.pts.length - 1; i++) out.push([g.pts[i], g.pts[i + 1]]);
    if (g.closed && g.pts.length > 2) out.push([g.pts[g.pts.length - 1], g.pts[0]]);
  } else if (g.shape === "rect") {
    const c1 = g.min, c3 = g.max;
    const c2 = { x: g.max.x, y: g.min.y }, c4 = { x: g.min.x, y: g.max.y };
    out.push([c1, c2], [c2, c3], [c3, c4], [c4, c1]);
  }
  return out;
}

/**
 * Farb-Nachschlagetabellen für {@link drawingColor3d} — EINMAL je Emitter-Lauf
 * gebaut statt je Element. Vorher rief `drawingColor3d` pro Zeichnung
 * `flattenCategories(project.layers).find(...)` auf und baute damit den
 * GESAMTEN Kategorie-Baum je Element neu als Array auf (O(n·L) plus
 * entsprechender GC-Druck). Bei einem Kataster-Import mit >100'000 Elementen
 * war das zweistellige Millionen Allokationen pro Renderdurchlauf. Muster wie
 * `generatePlan.ts::categoryColorMap`.
 */
interface DrawingColorMaps {
  byCategory: Map<string, string>;
  byLineStyle: Map<string, string>;
}

function buildDrawingColorMaps(project: Project): DrawingColorMaps {
  const byCategory = new Map<string, string>();
  for (const c of flattenCategories(project.layers)) {
    if (c.color) byCategory.set(c.code, c.color);
  }
  const byLineStyle = new Map<string, string>();
  for (const l of project.lineStyles) {
    if (l.color) byLineStyle.set(l.id, l.color);
  }
  return { byCategory, byLineStyle };
}

/** Modellfarbe einer 2D-Zeichnung (color → LineStyle → Kategorie), analog `drawing2DColor`. */
function drawingColor3d(maps: DrawingColorMaps, d: Drawing2D): RRgb {
  if (d.color) return hexToRgb(d.color, DRAWING_LINE_FALLBACK_RGB);
  const ls = d.lineStyleId ? maps.byLineStyle.get(d.lineStyleId) : undefined;
  if (ls) return hexToRgb(ls, DRAWING_LINE_FALLBACK_RGB);
  const cat = maps.byCategory.get(d.categoryCode);
  return cat ? hexToRgb(cat, DRAWING_LINE_FALLBACK_RGB) : DRAWING_LINE_FALLBACK_RGB;
}

/**
 * Segmentzahl einer 2D-Zeichnung OHNE die Segmente zu materialisieren —
 * damit {@link emitDrawingLineVerts} den Zielpuffer exakt vorab dimensionieren
 * kann. Muss mit {@link drawingSegments3d} synchron bleiben (gleiche Formen,
 * gleiche Zählung); der Test deckt das ab.
 */
function countSegments3d(d: Drawing2D): number {
  const g = d.geom;
  if (g.shape === "line") return 1;
  if (g.shape === "polyline") {
    const open = Math.max(0, g.pts.length - 1);
    return g.closed && g.pts.length > 2 ? open + 1 : open;
  }
  if (g.shape === "rect") return 4;
  return 0;
}

/** Boden-Spur-Höhe (world-Y) einer 2D-Zeichnung: Geschoss-UK + Epsilon gegen
 * Z-Fighting, oder 0 als Fallback (Geschoss nicht mehr auflösbar). Gemeinsam
 * für `emitDrawingLineVerts` (Sichtbarkeit) UND `pickDrawingSegs` (Klickbarkeit) —
 * beide MÜSSEN dieselbe Höhe verwenden, sonst klickt man daneben. */
function drawingElevation(project: Project, d: Drawing2D): number {
  let baseZ = 0;
  try {
    baseZ = getFloor(project, d.levelId).baseElevation ?? 0;
  } catch {
    // Geschoss nicht (mehr) auflösbar: bei UK 0 zeichnen (Fallback).
  }
  return baseZ + DRAWING_LINE_ELEVATION_EPS;
}

/** Floats je LineList-Vertex: `[px, py, pz, r, g, b]` — Format der render3d-
 *  Linien-Pipeline (Gitter/Kanten/Highlight teilen es, s. `GRID_FLOATS_PER_VERTEX`). */
const LINE_FLOATS_PER_VERTEX = 6;

/**
 * Boden-Spuren aller 2D-Zeichnungen als LineList-Vertices für render3d —
 * die "2D-Referenz im 3D" (z. B. ein Kataster-Plan oder Boden-Raster), die
 * auch der drei.js-Fallback (`addDrawing2DLines`) zeigt.
 *
 * Liefert interleaved `[px, py, pz, r, g, b, ...]` in WORLD-Metern, je zwei
 * Vertices ein Segment — direkt für `WebModelRenderer::set_drawing_lines`
 * (Binärtransfer als `Float32Array`, kein JSON).
 *
 * WARUM LINIEN STATT MESHES (Nutzer-Report 2026-10-08, Kataster-DXF „Amtliche
 * Vermessung Luzern", 439 MB → 3,6 Mio. Segmente): vorher wurde je Zeichnung
 * ein Ribbon-MESH erzeugt und über `RModel3d.meshes` als EIN JSON-String an
 * `set_model` gereicht. Das scheiterte an zwei harten Wänden — (1)
 * `JSON.stringify` sprengte die JS-String-Längengrenze komplett
 * (`RangeError: Invalid string length`; auch mit zu EINEM Mesh gebündelten
 * Daten, gemessen), und (2) `append_context_mesh` de-indiziert fürs
 * Flat-Shading und emittiert jedes Dreieck doppelt → ~1,55 GB Vertexdaten für
 * dieselbe Geometrie. Als LineList sind es 2 Vertices je Segment (~173 MB)
 * ohne jede Textkodierung.
 *
 * WORLD-TRANSFORM: hier selbst angewandt, weil die Vertices NICHT mehr durch
 * `append_context_mesh` laufen. Modell `(x, y, z=Höhe)` → world `(x, Höhe, y)`
 * — exakt die `MeshKind::Extrusion`-Konvention (KEINE Nord-Negation; die gilt
 * nur für `Terrain`/`Imported`, s. `mesh.rs` und die Mirror-Bug-Herleitung in
 * PENDENZEN.md 2026-09-27).
 */
export function emitDrawingLineVerts(project: Project): Float32Array {
  let segTotal = 0;
  for (const d of project.drawings2d) segTotal += countSegments3d(d);
  if (segTotal === 0) return new Float32Array(0);

  // Exakt vorab dimensionieren statt wachsendem `number[]`: bei Millionen
  // Segmenten spart das die doppelte Spitzenlast (JS-Array mit Float64-
  // Einträgen + anschliessende Kopie in den Float32Array).
  const out = new Float32Array(segTotal * 2 * LINE_FLOATS_PER_VERTEX);
  const maps = buildDrawingColorMaps(project);
  let w = 0;

  for (const d of project.drawings2d) {
    const segs = drawingSegments3d(d);
    if (segs.length === 0) continue;
    const elev = drawingElevation(project, d);
    const [r, g, b] = drawingColor3d(maps, d);
    for (const [p0, p1] of segs) {
      // Entartete Segmente überspringen (wie bisher); der Puffer wird am Ende
      // auf die tatsächlich geschriebene Länge zugeschnitten.
      if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 1e-9) continue;
      out[w++] = p0.x; out[w++] = elev; out[w++] = p0.y;
      out[w++] = r; out[w++] = g; out[w++] = b;
      out[w++] = p1.x; out[w++] = elev; out[w++] = p1.y;
      out[w++] = r; out[w++] = g; out[w++] = b;
    }
  }
  return w === out.length ? out : out.subarray(0, w);
}

/**
 * Pick-Kandidaten (Raycast-Boxen, s. `viewport/raycast3d.ts::PickDrawingSeg`)
 * für alle 2D-Zeichnungen — dieselben Segmente/Höhen wie `emitDrawingLineVerts`
 * (Klick trifft, was sichtbar ist), nur mit grosszügiger Toleranz statt der
 * sichtbaren 0.008m Linienbreite. Bislang gab es GAR KEINE Pick-Unterstützung
 * für freie 2D-Geometrie im WASM-Viewport (Nutzer-Report: „2D-Elemente können
 * nicht angewählt werden" — Wände/Decken/Öffnungen/Treppen/Dächer waren schon
 * pickbar, 2D-Zeichnungen nie).
 */
export function pickDrawingSegs(project: Project): PickDrawingSeg[] {
  const out: PickDrawingSeg[] = [];
  for (const d of project.drawings2d) {
    const segs = drawingSegments3d(d);
    if (segs.length === 0) continue;
    const elev = drawingElevation(project, d);
    const baseElevation = elev - DRAWING_PICK_TOLERANCE / 2;
    for (const [a, b] of segs) {
      out.push({ start: [a.x, a.y], end: [b.x, b.y], baseElevation, drawingId: d.id });
    }
  }
  return out;
}
