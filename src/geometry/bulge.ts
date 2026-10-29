// Bulge — DXF-Konvention für Bogen-Segmente in Polylinien: `bulge = tan(Δ/4)`
// (Δ = Öffnungswinkel des Kreisbogens von a nach b). Dünne Fassade über den Rust-Kern
// (`src-tauri/kernel2d/src/bulge.rs`, Bindungen `src-tauri/core/src/web/bulge.rs`); die
// Formeln (Sehnen-Pfeilhöhen-Beziehung `r = (h²+s²)/(2s)`, `s = h·bulge`) stehen nur dort.
// Feld-Semantik: s. Kopfkommentar bei `Drawing2DGeom["polyline"].bulge` (model/types.ts).
//
// Einzelaufrufe geben skalare Argumente, ganze Polylinien gehen auf einmal über
// `bulgePolylinePoints` (flache `Float64Array`s, Muster `coreFlat.ts`).
//
// Bewusst in TS geblieben (zwei Einzeiler, kein Rechenkern):
//  • `hasRealBulge` — läuft pro Zeichnung/Befehl über das bulge-Array; ein WASM-Aufruf müsste das
//    Array erst in eine `Float64Array` kopieren und wäre langsamer als `some` (Messung s. Commit).
//  • `pointOnCircle` — zwei Multiplikationen je Punkt, in Schleifen aufgerufen.

import type { Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";

const EPS = 1e-9;

/** Trägt dieses `bulge`-Array mindestens ein echtes Bogen-Segment (≠0)? */
export function hasRealBulge(bulge: number[] | undefined): boolean {
  return !!bulge && bulge.some((b) => Math.abs(b) > EPS);
}

interface BulgeArc {
  center: Vec2;
  r: number;
  a0: number;
  a1: number;
  /** Bogenmass der Schwenkrichtung von a0 nach a1 (positiv = CCW), inkl. Vorzeichen. */
  sweep: number;
}

/** Kreisbogen-Parameter aus zwei Endpunkten + `bulge`, oder `null` bei (nahezu) 0 (Gerade). */
export function bulgeArc(a: Vec2, b: Vec2, bulge: number): BulgeArc | null {
  // Gerades Segment (der Normalfall, z. B. Millionen Katasterlinien): ohne WASM-Aufruf, gleiche
  // Schwelle wie `kernel2d::bulge::bulge_arc`.
  if (!(Math.abs(bulge) >= EPS)) return null;
  const r = core().bulge_arc(a.x, a.y, b.x, b.y, bulge);
  if (r.length < 6) return null;
  return { center: { x: r[0], y: r[1] }, r: r[2], a0: r[3], a1: r[4], sweep: r[5] };
}

function toPoints(f: Float64Array): Vec2[] {
  const out: Vec2[] = new Array(f.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = { x: f[2 * i], y: f[2 * i + 1] };
  return out;
}

/**
 * Tessellierte Bogenpunkte von a nach b (inkl. beider Endpunkte) — für
 * Rendering/Fläche/Hit-Test/Export, die nur Geradensegmente kennen. Gerade
 * (bulge fehlt/0) liefert `[a, b]`. Gerade Segmentzahl, damit der Apex (t=0.5)
 * ein echter Punkt in der Mitte ist (s. `bulgePointAt`).
 */
export function bulgeArcPoints(a: Vec2, b: Vec2, bulge: number | undefined): Vec2[] {
  if (bulge === undefined || bulge === 0) return [a, b];
  return toPoints(core().bulge_arc_points(a.x, a.y, b.x, b.y, bulge));
}

/**
 * Ganze Polylinie tessellieren (`bulge[i]` krümmt die Kante pts[i]→pts[i+1], geschlossen zusätzlich
 * die Schlusskante). Kantenpunkte verkettet ohne doppelte Stösse; bei `closed` wird der Startpunkt
 * am Ende nicht wiederholt.
 */
export function bulgePolylinePoints(pts: readonly Vec2[], bulge: readonly number[] | undefined, closed: boolean): Vec2[] {
  // Ohne echten Bogen liefert Rust genau die Eingabepunkte (offen wie geschlossen) — dann ohne
  // WASM-Aufruf und Kopie in Float64Arrays (Plan-Erzeugung ruft das für jede Polylinie).
  if (!hasRealBulge(bulge as number[] | undefined)) return pts.slice();
  const flat = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    flat[2 * i] = pts[i].x;
    flat[2 * i + 1] = pts[i].y;
  }
  return toPoints(core().bulge_polyline_points(flat, Float64Array.from(bulge ?? []), closed));
}

/**
 * Bulge aus einem gezogenen Punkt `p` relativ zur Sehne a-b ableiten (Griff-
 * Interaktion: Segment-Mitte senkrecht zur Sehne ziehen). Umkehrung von `s = h·bulge`.
 */
export function bulgeFromSagittaPoint(a: Vec2, b: Vec2, p: Vec2): number {
  return core().bulge_from_sagitta_point(a.x, a.y, b.x, b.y, p.x, p.y);
}

/** Punkt auf dem aktuellen Bogen bei Parameter t∈[0,1] (0=a, 1=b, 0.5=Apex) — für den Bulge-Griff. */
export function bulgePointAt(a: Vec2, b: Vec2, bulge: number, t: number): Vec2 {
  const r = core().bulge_point_at(a.x, a.y, b.x, b.y, bulge, t);
  return { x: r[0], y: r[1] };
}

/**
 * Bulge eines Kreisbogens, der von `a` über `through` nach `b` läuft — der klassische
 * Drei-Punkt-Bogen, nur von diesen drei Punkten abhängig (nicht vom vorherigen Segment).
 * Liegen die Punkte (nahezu) auf einer Geraden, gibt es keinen Kreis — dann 0.
 */
export function bulgeThroughPoint(a: Vec2, through: Vec2, b: Vec2): number {
  return core().bulge_through_point(a.x, a.y, through.x, through.y, b.x, b.y);
}

/** Punkt auf einem Kreis (center, r) beim Winkel `a` (Radiant). */
export function pointOnCircle(center: Vec2, r: number, a: number): Vec2 {
  return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
}

type ArcParams = { center: Vec2; r: number; a0: number; a1: number };

function toArcParams(r: Float64Array): ArcParams | null {
  if (r.length < 5) return null;
  return { center: { x: r[0], y: r[1] }, r: r[2], a0: r[3], a1: r[4] };
}

/**
 * Kreisbogen-Parameter durch drei Punkte `a`→`through`→`b`, direkt als `{center,r,a0,a1}`
 * für Werkzeuge, die einen eigenständigen `{shape:"arc"}` erzeugen (`commands/cmds/arc.ts`).
 * `a0`/`a1` sind IMMER so geordnet, dass der Bogen CCW von a0 nach a1 läuft. `null` bei
 * (nahezu) kollinearen Punkten.
 */
export function arcThroughPoints(a: Vec2, through: Vec2, b: Vec2): ArcParams | null {
  return toArcParams(core().arc_through_points(a.x, a.y, through.x, through.y, b.x, b.y));
}

/**
 * Kreisbogen durch zwei Endpunkte `a`→`b` mit vorgegebenem Radius `r` (Methode „Start-Ende-
 * Radius"). `near` (typischerweise der Cursor) wählt die Seite der Sehne; es entsteht immer der
 * KLEINERE der beiden möglichen Bögen (Sehnenwinkel ≤ 180°). `null`, wenn `r` kleiner als die
 * halbe Sehnenlänge ist oder die Sehne entartet.
 */
export function arcFromStartEndRadius(a: Vec2, b: Vec2, r: number, near: Vec2): ArcParams | null {
  return toArcParams(core().arc_from_start_end_radius(a.x, a.y, b.x, b.y, r, near.x, near.y));
}

/**
 * Kreisbogen durch `a`→`b`, bei `a` tangential zur Richtung `dir` (ein Punkt AUF dem
 * Tangentenstrahl). `null` bei entarteter Tangente oder wenn sie entlang der Sehne a-b zeigt.
 */
export function arcFromStartEndDirection(a: Vec2, b: Vec2, dir: Vec2): ArcParams | null {
  return toArcParams(core().arc_from_start_end_direction(a.x, a.y, b.x, b.y, dir.x, dir.y));
}
