/**
 * Schraffur- und Linienmuster-Geometrie des Grundrisses — Fassade über den Rust-Kern ([K3b],
 * `src-tauri/core/src/hatch.rs`). Wandelt ein Polygon mit aufgelöster {@link HatchRender} in eine
 * Schar echter Linienzüge (Modell-Meter), die die GPU-Kompilierung, `toRenderScene`, der Druck-
 * SVG- und der DXF-Export zeichnen; dazu Strichmuster, Zickzack und Motiv-Kachelung.
 *
 * KOORDINATEN & MASSSTAB (deckungsgleich zum SVG-`<pattern>`): die Muster entstehen direkt in
 * Modell-Metern (1 px Bildschirm-Raum = 1/90 m), Kachel 8·scale px (diagonal/kreuz) bzw.
 * 14×10·scale px (Dämmung), Raster-Anker = Modellursprung bzw. `hatch.origin`. Strichstärken
 * bleiben Papier-mm.
 */

import type { Vec2 } from '../../model/types';
import type { HatchRender } from '../generatePlan';
import { encodeHatch } from '../planBuf';
import { core } from '../../engine/coreWasm';

/** Bildschirm-Einheiten (viewBox-px) je Meter — identisch zu PlanView.toScreen. */
const PX_PER_M = 90;

/** Ein Linien-Segment in Modell-Metern. */
export interface HatchSegment {
  a: Vec2;
  b: Vec2;
}

/**
 * Ein zusammenhängender Linienzug in Modell-Metern (≥2 Punkte). Gerade Musterlinien sind
 * 2-Punkt-Läufe; die Dämmungs-Welle ist ein langer, an den Polygonkanten geclippter Lauf.
 */
export type HatchRun = Vec2[];

/**
 * Faktor mm-Papier → Modell-Meter des Musterraums, identisch zum SVG-`dashArray` (dort
 * `dash·(1/0.13)` px).
 */
export const DASH_MM_TO_M = (1 / 0.13) * (1 / PX_PER_M);

function flat(pts: readonly Vec2[]): Float64Array {
  const out = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    out[2 * i] = pts[i].x;
    out[2 * i + 1] = pts[i].y;
  }
  return out;
}

function toPts(f: Float64Array): Vec2[] {
  const out: Vec2[] = new Array(f.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = { x: f[2 * i], y: f[2 * i + 1] };
  return out;
}

function toSegs(f: Float64Array): HatchSegment[] {
  const out: HatchSegment[] = [];
  for (let i = 0; i + 3 < f.length; i += 4) out.push({ a: { x: f[i], y: f[i + 1] }, b: { x: f[i + 2], y: f[i + 3] } });
  return out;
}

/** `[n, x, y, …, n, …]` → Läufe. */
function toRuns(f: Float64Array): HatchRun[] {
  const out: HatchRun[] = [];
  let i = 0;
  while (i < f.length) {
    const n = f[i++];
    const run: Vec2[] = new Array(n);
    for (let k = 0; k < n; k++, i += 2) run[k] = { x: f[i], y: f[i + 1] };
    out.push(run);
  }
  return out;
}

function runsFlat(runs: readonly HatchRun[]): Float64Array {
  let n = 0;
  for (const r of runs) n += 1 + 2 * r.length;
  const out = new Float64Array(n);
  let i = 0;
  for (const r of runs) {
    out[i++] = r.length;
    for (const p of r) {
      out[i++] = p.x;
      out[i++] = p.y;
    }
  }
  return out;
}

/**
 * Schneidet eine UNENDLICHE Linie (Aufpunkt `p0`, Einheits-Richtung `dir`) mit einem einfachen
 * (auch konkaven) Polygon und liefert die innenliegenden Segmente (even-odd, halb-offene
 * Kantenkonvention an Ecken).
 */
export function clipLineToPolygon(p0: Vec2, dir: Vec2, poly: Vec2[]): HatchSegment[] {
  if (poly.length < 3) return [];
  return toSegs(core().clip_line_to_polygon_flat(p0.x, p0.y, dir.x, dir.y, flat(poly)));
}

/** Schneidet ein ENDLICHES Segment [a,b] gegen ein (konkaves) Polygon. */
export function clipSegmentToPolygon(a: Vec2, b: Vec2, poly: Vec2[]): HatchSegment[] {
  return toSegs(core().clip_segment_to_polygon_flat(a.x, a.y, b.x, b.y, flat(poly)));
}

/**
 * Schneidet eine zusammenhängende Polylinie gegen ein (konkaves) Polygon; die Innenteile bleiben
 * zusammenhängende Läufe (nur ein echtes Austreten beginnt einen neuen Lauf).
 */
export function clipPolylineToPolygon(pts: Vec2[], poly: Vec2[]): HatchRun[] {
  if (pts.length < 2 || poly.length < 3) return [];
  return toRuns(core().clip_polyline_to_polygon_flat(flat(pts), flat(poly)));
}

/**
 * Schar paralleler, aufs Polygon geclippter Linien: Richtung `angleRad` (Modell, CCW), Abstand
 * `spacingM`, Phasen-Versatz `offsetM`, Raster-Anker `anchor` (Default Modellursprung — wie das
 * SVG-`userSpaceOnUse`-Muster; ein Objekt verschiebt ihn über `Drawing2D.hatchOrigin`).
 */
export function hatchLineFamily(
  poly: Vec2[],
  angleRad: number,
  spacingM: number,
  offsetM = 0,
  anchor: Vec2 = { x: 0, y: 0 },
): HatchSegment[] {
  return toSegs(core().hatch_line_family_flat(flat(poly), angleRad, spacingM, offsetM, anchor.x, anchor.y));
}

/**
 * Zerlegt zusammenhängende Läufe entlang eines Strichmusters (`dash` in mm-Papier, [an, aus, …];
 * ungerade Längen werden verdoppelt). Die Phase läuft über Stützpunkte hinweg durch. Leeres/
 * ungültiges Muster → Läufe unverändert.
 */
export function applyDashRuns(runs: HatchRun[], dash: number[] | null): HatchRun[] {
  if (!dash || dash.length === 0) return runs;
  return toRuns(core().dash_runs_flat(runsFlat(runs), Float64Array.from(dash)));
}

/**
 * Schraffur eines Polygons als zusammenhängende Läufe (Modell-Meter): diagonal (eine Schar),
 * crosshatch (zwei Scharen), insulation (Welle), custom (Motiv je Musterlinie), Random-Untermodus
 * (gestreute Striche); solid/none sowie Bild/Verlauf liefern keine Linien-Geometrie des Musters.
 */
export function buildHatchRuns(poly: Vec2[], hatch: HatchRender): HatchRun[] {
  if (poly.length < 3 || hatch.pattern === 'none' || hatch.pattern === 'solid') return [];
  return toRuns(core().hatch_runs_flat(flat(poly), encodeHatch(hatch)));
}

/**
 * Streut kurze Striche deterministisch und MODELLRAUM-STABIL über ein Polygon (eine Zelle des
 * absoluten Gitters je Strich, Lage/Winkel/Länge aus `hash(ix, iy, seed)`), aufs Polygon geclippt.
 */
export function scatterStrokes(
  poly: Vec2[],
  cell: number,
  baseAngleRad: number,
  seed: number,
  strokeLen: number,
  lenMin?: number,
  lenMax?: number,
): HatchRun[] {
  return toRuns(
    core().scatter_strokes_flat(flat(poly), cell, baseAngleRad, seed, strokeLen, lenMin ?? NaN, lenMax ?? NaN),
  );
}

/**
 * Random-Vektor-Schraffur eines Polygons (Kies/Splitt): Dichte und Strichlänge an die Kachel
 * (8·scale px) gekoppelt, Seed nur aus Muster-Parametern + `hatch.seed`.
 */
export function buildRandomHatchRuns(poly: Vec2[], hatch: HatchRender, scale?: number): HatchRun[] {
  return toRuns(core().random_hatch_runs_flat(flat(poly), encodeHatch(hatch), scale ?? NaN));
}

/**
 * Zickzack (Dreieckswelle [0,+A,0,−A] je Viertel-Wellenlänge) entlang [a,b]; Einheiten wie
 * a/b. Start auf der Achse, Ende exakt auf `b`.
 */
export function zigzagPoints(a: Vec2, b: Vec2, amplitude: number, wavelength: number): Vec2[] {
  const f = core().zigzag_points_flat(a.x, a.y, b.x, b.y, amplitude, wavelength);
  return f.length ? toPts(f) : [a, b];
}

/**
 * Kachelt ein frei gezeichnetes Motiv (`points` in der Einheitszelle: x entlang, y quer;
 * Wiederhollänge `length`, beides ·`scale`) entlang [a,b], am Ende exakt geclippt. Entartet →
 * `[a, b]`.
 */
export function motifPoints(
  a: Vec2,
  b: Vec2,
  motif: { points: Vec2[]; length: number },
  scale = 1,
): Vec2[] {
  const f = core().motif_points_flat(a.x, a.y, b.x, b.y, flat(motif.points), motif.length, scale);
  return f.length ? toPts(f) : [a, b];
}
