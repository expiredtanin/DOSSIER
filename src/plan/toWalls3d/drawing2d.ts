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

import type { Drawing2D, Project } from "../../model/types";
import { flattenCategories, getFloor } from "../../model/types";
import { core } from "../../engine/coreWasm";
import { DRAWING_LINE_FALLBACK_RGB, hexToRgb, type RRgb } from "./shared";
import { DRAWING_PICK_TOLERANCE, type PickDrawingSeg } from "../pickTypes";

/** Höhen-Offset über der Geschossebene gegen Z-Fighting (wie addDrawing2DLines in Viewport3D.tsx). */
const DRAWING_LINE_ELEVATION_EPS = 0.01;

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

/** Doppelte je Charge an den Rust-Kern (Eingabe: `drawing2d_3d.rs`) — begrenzt den Speicher. */
const CHUNK_DOUBLES = 1 << 18;
let scratch: Float64Array | null = null;
/** Art-Kennzahl der Zeichnung im Rust-Puffer; Kreis/Bogen/Text zeigt das 3D nicht. */
const SHAPE_KIND = { line: 1, polyline: 2, rect: 3 } as const;

/**
 * Packt die darstellbaren Zeichnungen (line/polyline/rect — Parität mit `drawing2DSegments`
 * im drei.js-Fallback `Viewport3D.tsx`) in Chargen und ruft `fn(puffer, zeichnungen)` je Charge
 * auf. `color` liefert die Linienfarbe (`null`: ohne, für den Pick).
 */
function forEachChunk(
  project: Project,
  color: ((d: Drawing2D) => RRgb) | null,
  fn: (buf: Float64Array, drawings: Drawing2D[]) => void,
): void {
  if (project.drawings2d.length === 0) return;
  // Der Zwischenpuffer lebt zwischen den Aufrufen weiter (Neuanlage von 2 MB kostet mehr als die
  // Rechnung bei kleinen Projekten); der Kern kopiert den Inhalt je Aufruf.
  scratch ??= new Float64Array(CHUNK_DOUBLES);
  let buf = scratch;
  let ids: Drawing2D[] = [];
  let w = 1; // [0] = Anzahl
  const flush = () => {
    if (ids.length === 0) return;
    buf[0] = ids.length;
    fn(buf.subarray(0, w), ids);
    ids = [];
    w = 1;
  };
  // Geschoss-UK je Ebene nur einmal auflösen (bei Kataster-Importen hängen Tausende Zeichnungen an einer).
  const elevations = new Map<string, number>();
  for (const d of project.drawings2d) {
    const g = d.geom;
    if (g.shape !== "line" && g.shape !== "rect" && g.shape !== "polyline") continue;
    const kind = SHAPE_KIND[g.shape];
    const nPts = g.shape === "polyline" ? g.pts.length : 2;
    const need = 7 + 2 * nPts;
    if (w + need > buf.length) {
      flush();
      if (1 + need > buf.length) buf = new Float64Array(1 + need);
    }
    let elev = elevations.get(d.levelId);
    if (elev === undefined) {
      elev = drawingElevation(project, d);
      elevations.set(d.levelId, elev);
    }
    const [r, gr, b] = color ? color(d) : [0, 0, 0];
    buf[w++] = kind;
    buf[w++] = elev;
    buf[w++] = r;
    buf[w++] = gr;
    buf[w++] = b;
    buf[w++] = g.shape === "polyline" && g.closed ? 1 : 0;
    buf[w++] = nPts;
    if (g.shape === "line") {
      buf[w++] = g.a.x; buf[w++] = g.a.y; buf[w++] = g.b.x; buf[w++] = g.b.y;
    } else if (g.shape === "rect") {
      buf[w++] = g.min.x; buf[w++] = g.min.y; buf[w++] = g.max.x; buf[w++] = g.max.y;
    } else {
      for (const p of g.pts) {
        buf[w++] = p.x;
        buf[w++] = p.y;
      }
    }
    ids.push(d);
  }
  flush();
}

/**
 * Boden-Spuren aller 2D-Zeichnungen als LineList-Vertices für render3d —
 * die "2D-Referenz im 3D" (z. B. ein Kataster-Plan oder Boden-Raster), die
 * auch der drei.js-Fallback (`addDrawing2DLines`) zeigt.
 *
 * Liefert interleaved `[px, py, pz, r, g, b, ...]` in WORLD-Metern, je zwei
 * Vertices ein Segment — direkt für `WebModelRenderer::set_drawing_lines`
 * (Binärtransfer als `Float32Array`, kein JSON). Entartete Segmente entfallen.
 *
 * WARUM LINIEN STATT MESHES (Nutzer-Report 2026-10-08, Kataster-DXF „Amtliche
 * Vermessung Luzern", 439 MB → 3,6 Mio. Segmente): als Ribbon-MESH im JSON-Modell sprengte das
 * die JS-String-Längengrenze, und `append_context_mesh` hätte ~1,55 GB Vertexdaten erzeugt.
 * Als LineList sind es 2 Vertices je Segment (~173 MB) ohne jede Textkodierung.
 *
 * WORLD-TRANSFORM: Modell `(x, y, z=Höhe)` → world `(x, Höhe, y)` — exakt die
 * `MeshKind::Extrusion`-Konvention (KEINE Nord-Negation; die gilt nur für `Terrain`/`Imported`,
 * s. `mesh.rs`). Die Segmente erzeugt der Rust-Kern (`drawing2d_3d.rs`) in Chargen; die
 * Teilergebnisse werden am Ende in EINEN Puffer kopiert.
 */
export function emitDrawingLineVerts(project: Project): Float32Array {
  if (project.drawings2d.length === 0) return new Float32Array(0);
  const maps = buildDrawingColorMaps(project);
  const parts: Float32Array[] = [];
  let total = 0;
  forEachChunk(project, (d) => drawingColor3d(maps, d), (buf) => {
    const v = core().drawing3d_line_verts(buf);
    if (v.length) {
      parts.push(v);
      total += v.length;
    }
  });
  if (parts.length === 0) return new Float32Array(0);
  if (parts.length === 1) return parts[0];
  const out = new Float32Array(total);
  let w = 0;
  for (const p of parts) {
    out.set(p, w);
    w += p.length;
  }
  return out;
}

/**
 * Pick-Kandidaten (Raycast-Boxen, s. `viewport/raycast3d.ts::PickDrawingSeg`)
 * für alle 2D-Zeichnungen — dieselben Segmente/Höhen wie `emitDrawingLineVerts`
 * (Klick trifft, was sichtbar ist), nur mit grosszügiger Toleranz statt der
 * sichtbaren 0.008m Linienbreite.
 */
export function pickDrawingSegs(project: Project): PickDrawingSeg[] {
  const out: PickDrawingSeg[] = [];
  forEachChunk(project, null, (buf, drawings) => {
    const f = core().drawing3d_pick_segs(buf, DRAWING_PICK_TOLERANCE);
    for (let i = 0; i + 5 < f.length; i += 6) {
      out.push({
        start: [f[i], f[i + 1]],
        end: [f[i + 2], f[i + 3]],
        baseElevation: f[i + 4],
        drawingId: drawings[f[i + 5]].id,
      });
    }
  });
  return out;
}
