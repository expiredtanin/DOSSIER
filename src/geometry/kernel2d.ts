// 2D-Geometrie-Kernel — Fassade über den Rust-Kern (`src-tauri/kernel2d`, gebunden in
// `src-tauri/core/src/web/kernel2d.rs`, geladen über `engine/coreWasm.ts`). Offset / Trim /
// Extend / Fillet / Fase / Split / Join / Bruch, auch mit Bogen-Segmenten (bulge). Die
// Rechenlogik liegt ausschliesslich in Rust; hier wird nur kodiert/dekodiert (flache
// Float64Arrays, Formate s. Kopf von `web/kernel2d.rs`).
//
// Konvention: Polylinien sind `Vec2[]`; `closed` heisst, die letzte Kante geht von pts[n-1]
// zu pts[0] (Schlusspunkt NICHT dupliziert). Offsets: positiv = nach LINKS bezogen auf die
// Laufrichtung, negativ = nach rechts. `bulge[i]` krümmt die Kante pts[i]→pts[i+1]; ein
// fehlender Eintrag gilt als Gerade.
//
// Bewusst in TS geblieben (je ein WASM-Aufruf wäre teurer als die Rechnung selbst):
//   • `vecEqual` — zwei Betragsvergleiche, wird von Aufrufern je Punkt verwendet;
//   • `polylineEdges` — reines Umordnen der Eingabe zu Kantenpaaren (keine Geometrie),
//     liefert die Original-Punktobjekte zurück.

import type { Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";

/** Numerische Toleranz (Meter) für Schnitt-/Gleichheitstests (wie `kernel2d::EPS`). */
export const EPS = 1e-7;

/** Punkt-Gleichheit innerhalb Toleranz. */
export function vecEqual(a: Vec2, b: Vec2, eps = EPS): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

/** Kanten einer Polylinie als [from,to]-Paare (Schlusskante bei `closed`). */
export function polylineEdges(pts: Vec2[], closed: boolean): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (let i = 0; i < pts.length - 1; i++) out.push([pts[i], pts[i + 1]]);
  if (closed && pts.length > 2) out.push([pts[pts.length - 1], pts[0]]);
  return out;
}

// ── Kodierung ────────────────────────────────────────────────────────────────

type Cutter = { pts: Vec2[]; closed: boolean; bulge?: (number | undefined)[] };

function encPts(pts: Vec2[]): Float64Array {
  const out = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    out[2 * i] = pts[i].x;
    out[2 * i + 1] = pts[i].y;
  }
  return out;
}

/** Fehlende/`null`-Einträge → 0 (Gerade), wie im Rust-Kern. */
function encBulge(bulge: (number | undefined)[] | undefined): Float64Array {
  return Float64Array.from(bulge ?? [], (b) => b ?? 0);
}

/** Ketten: `[n, (closed, n_pts, xy…, n_bulge|-1, b…)…]`. */
function encChains(list: Cutter[], keepMissingBulge = false): Float64Array {
  const out: number[] = [list.length];
  for (const c of list) {
    out.push(c.closed ? 1 : 0, c.pts.length);
    for (const p of c.pts) out.push(p.x, p.y);
    if (c.bulge === undefined) {
      out.push(keepMissingBulge ? -1 : 0);
    } else {
      out.push(c.bulge.length);
      for (const b of c.bulge) out.push(b ?? 0);
    }
  }
  return Float64Array.from(out);
}

/** Liste von Punktlisten: `[n, (n_pts, xy…)…]`. */
function encPtLists(lists: Vec2[][]): Float64Array {
  const out: number[] = [lists.length];
  for (const l of lists) {
    out.push(l.length);
    for (const p of l) out.push(p.x, p.y);
  }
  return Float64Array.from(out);
}

function decPts(buf: Float64Array, from = 0, count = (buf.length - from) / 2): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k < count; k++) out.push({ x: buf[from + 2 * k], y: buf[from + 2 * k + 1] });
  return out;
}

function decPtLists(buf: Float64Array): Vec2[][] {
  const n = buf[0] ?? 0;
  const out: Vec2[][] = [];
  let i = 1;
  for (let k = 0; k < n; k++) {
    const m = buf[i++];
    out.push(decPts(buf, i, m));
    i += 2 * m;
  }
  return out;
}

function decChains(buf: Float64Array): { pts: Vec2[]; closed: boolean; bulge: number[] }[] {
  const n = buf[0] ?? 0;
  const out: { pts: Vec2[]; closed: boolean; bulge: number[] }[] = [];
  let i = 1;
  for (let k = 0; k < n; k++) {
    const closed = buf[i++] !== 0;
    const m = buf[i++];
    const pts = decPts(buf, i, m);
    i += 2 * m;
    const nb = buf[i++];
    out.push({ pts, closed, bulge: Array.from(buf.subarray(i, i + nb)) });
    i += nb;
  }
  return out;
}

/** `[n_pts, xy…, bulge…]`. */
function decPtsBulge(buf: Float64Array): { pts: Vec2[]; bulge: number[] } {
  const n = buf[0] ?? 0;
  return { pts: decPts(buf, 1, n), bulge: Array.from(buf.subarray(1 + 2 * n)) };
}

// ── Punkt/Strecke, Fläche ───────────────────────────────────────────────────

/** Abstand von p zur Strecke a→b. */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  return core().k2_point_segment_distance(p.x, p.y, a.x, a.y, b.x, b.y);
}

/** Vorzeichenbehaftete Polygonfläche (Shoelace); >0 = CCW, <0 = CW. */
export function signedArea(pts: Vec2[]): number {
  return core().k2_signed_area(encPts(pts));
}

/** Ob ein Polygonzug gegen den Uhrzeigersinn (CCW) gewickelt ist. */
export function isCCW(pts: Vec2[]): boolean {
  return core().k2_is_ccw(encPts(pts));
}

/** Schnittpunkte zweier Kreise (0/1/2 Punkte). */
export function circleCircleIntersect(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  return decPts(core().k2_circle_circle_intersect(c1.x, c1.y, r1, c2.x, c2.y, r2));
}

// ── Offset ───────────────────────────────────────────────────────────────────

/** Offset einer einzelnen Strecke um `d` (links positiv). */
export function offsetSegment(a: Vec2, b: Vec2, d: number): [Vec2, Vec2] {
  const r = core().k2_offset_segment(a.x, a.y, b.x, b.y, d);
  return [{ x: r[0], y: r[1] }, { x: r[2], y: r[3] }];
}

/**
 * Offset einer Polylinie um `d` (links positiv) mit Gehrung; offene und geschlossene
 * Polylinien, degenerierte Kanten werden übersprungen. Selbstüberschneidungen bei starkem
 * Offset werden nicht bereinigt.
 */
export function offsetPolyline(pts: Vec2[], d: number, closed: boolean): Vec2[] {
  return decPts(core().k2_offset_polyline(encPts(pts), d, closed));
}

/**
 * Offset einer Polylinie MIT Bogen-Segmenten um `d` (links positiv): Bögen bleiben
 * konzentrisch, Nachbarkanten werden auf Gehrung geschnitten, der bulge an den Nahtstellen
 * aus den tatsächlichen Endpunkt-Winkeln neu hergeleitet.
 */
export function offsetPolylineWithBulge(
  pts: Vec2[],
  bulge: (number | undefined)[] | undefined,
  d: number,
  closed: boolean,
): { pts: Vec2[]; bulge: number[] } {
  return decPtsBulge(core().k2_offset_polyline_with_bulge(encPts(pts), encBulge(bulge), d, closed));
}

// ── Trim / Extend ───────────────────────────────────────────────────────────

/**
 * Quick-Trim einer ganzen Kurve (offen oder geschlossen): sie wird an allen Schnitten mit
 * den Cuttern zerlegt, das `pick` nächste Stück entfällt. Offen → 0..2 Reststücke,
 * geschlossen → ein offenes Reststück. Ohne Schnitt bleibt die Kurve unverändert.
 */
export function trimPolyline(
  pts: Vec2[],
  closed: boolean,
  cutters: { pts: Vec2[]; closed: boolean }[],
  pick: Vec2,
): { pts: Vec2[]; closed: boolean }[] {
  return decChains(core().k2_trim_polyline(encPts(pts), closed, encChains(cutters), pick.x, pick.y)).map(
    ({ pts, closed }) => ({ pts, closed }),
  );
}

/**
 * Wie {@link trimPolyline}, aber Ziel-Kurve UND Schneider dürfen Bogen-Segmente tragen
 * (Kreis↔Gerade und Kreis↔Kreis; Bogen-Schneider zählen nur innerhalb ihrer Spanne).
 * Liefert die verbleibenden Ketten inkl. bulge.
 */
export function trimPolylineWithBulge(
  pts: Vec2[],
  bulge: (number | undefined)[] | undefined,
  closed: boolean,
  cutters: { pts: Vec2[]; closed: boolean; bulge?: (number | undefined)[] }[],
  pick: Vec2,
): { pts: Vec2[]; closed: boolean; bulge: number[] }[] {
  return decChains(
    core().k2_trim_polyline_with_bulge(encPts(pts), encBulge(bulge), closed, encChains(cutters), pick.x, pick.y),
  );
}

/**
 * Verlängert das gewählte Ende der Strecke a1→a2 bis zur nächsten Schneider-Kante in
 * Verlängerungsrichtung; null ohne Treffer.
 */
export function extendSegment(
  a1: Vec2,
  a2: Vec2,
  end: "start" | "end",
  cutters: { pts: Vec2[]; closed: boolean }[],
): [Vec2, Vec2] | null {
  const r = core().k2_extend_segment(a1.x, a1.y, a2.x, a2.y, end === "end", encChains(cutters));
  return r.length === 4 ? [{ x: r[0], y: r[1] }, { x: r[2], y: r[3] }] : null;
}

/**
 * Wie {@link extendSegment} für ein Bogen-Segment a→b (bulge): verlängert den Kreisbogen
 * (gleicher Mittelpunkt/Radius, gleiche Schwenkrichtung) über das gewählte Ende bis zur
 * nächsten GERADEN Schneider-Kante. null bei Geraden (bulge≈0) oder ohne Treffer.
 */
export function extendBulgeSegment(
  a: Vec2,
  b: Vec2,
  bulge: number,
  end: "start" | "end",
  cutters: { pts: Vec2[]; closed: boolean }[],
): { point: Vec2; bulge: number } | null {
  const r = core().k2_extend_bulge_segment(a.x, a.y, b.x, b.y, bulge, end === "end", encChains(cutters));
  return r.length === 3 ? { point: { x: r[0], y: r[1] }, bulge: r[2] } : null;
}

// ── Tangente-Tangente-Radius ────────────────────────────────────────────────

/** Ein Tangentialobjekt für `tangentCircleCenters`: Gerade (durch a/b, unendlich gedacht) oder Kreis. */
export type TangentTarget = { kind: "line"; a: Vec2; b: Vec2 } | { kind: "circle"; center: Vec2; r: number };

function encTarget(t: TangentTarget): Float64Array {
  return t.kind === "line"
    ? Float64Array.of(0, t.a.x, t.a.y, t.b.x, t.b.y)
    : Float64Array.of(1, t.center.x, t.center.y, t.r, 0);
}

/**
 * Alle Mittelpunkt-Kandidaten eines Kreises mit Radius `r`, der `t1` UND `t2` berührt
 * (TTR). Unsortiert/undedupliziert; der Aufrufer wählt über einen Referenzpunkt.
 */
export function tangentCircleCenters(t1: TangentTarget, t2: TangentTarget, r: number): Vec2[] {
  return decPts(core().k2_tangent_circle_centers(encTarget(t1), encTarget(t2), r));
}

// ── Fillet / Fase ────────────────────────────────────────────────────────────

/** Ergebnis einer Eck-Verrundung. */
export interface Fillet {
  center: Vec2;
  radius: number;
  /** Tangentenpunkt auf dem ersten Schenkel (corner→p1). */
  tangentA: Vec2;
  /** Tangentenpunkt auf dem zweiten Schenkel (corner→p2). */
  tangentB: Vec2;
  /** Bogen-Endwinkel in Radiant (für ein Arc-Primitiv). */
  startAngle: number;
  endAngle: number;
}

/**
 * Verrundet die Ecke bei `corner` (Schenkel corner→p1, corner→p2) mit Radius `r`; null bei
 * (nahezu) kollinearen oder zu kurzen Schenkeln.
 */
export function filletCorner(corner: Vec2, p1: Vec2, p2: Vec2, r: number): Fillet | null {
  const f = core().k2_fillet_corner(corner.x, corner.y, p1.x, p1.y, p2.x, p2.y, r);
  if (f.length !== 9) return null;
  return {
    center: { x: f[0], y: f[1] },
    radius: f[2],
    tangentA: { x: f[3], y: f[4] },
    tangentB: { x: f[5], y: f[6] },
    startAngle: f[7],
    endAngle: f[8],
  };
}

/** Ergebnis einer Eck-Fasung. */
export interface Chamfer {
  /** Punkt auf dem ersten Schenkel (corner→p1), im Abstand `distance` vom Eck. */
  a: Vec2;
  /** Punkt auf dem zweiten Schenkel (corner→p2), im Abstand `distance` vom Eck. */
  b: Vec2;
}

/**
 * Gleichabstands-Fase der Ecke bei `corner`; null bei (nahezu) kollinearen Schenkeln oder
 * wenn `distance` länger als ein Schenkel ist.
 */
export function chamferCorner(corner: Vec2, p1: Vec2, p2: Vec2, distance: number): Chamfer | null {
  const c = core().k2_chamfer_corner(corner.x, corner.y, p1.x, p1.y, p2.x, p2.y, distance);
  return c.length === 4 ? { a: { x: c[0], y: c[1] }, b: { x: c[2], y: c[3] } } : null;
}

// ── Split / Join / Segment löschen / Bruch ──────────────────────────────────

/**
 * Teilt eine Polylinie an P = lerp(pts[edgeIndex], pts[edgeIndex+1], t). Offen → zwei
 * offene Stücke; geschlossen → eine offene, bei P aufgeschnittene Polylinie.
 */
export function splitPolylineAtParam(pts: Vec2[], closed: boolean, edgeIndex: number, t: number): Vec2[][] {
  return decPtLists(core().k2_split_polyline_at_param(encPts(pts), closed, edgeIndex, t));
}

/**
 * Teilt ein geschlossenes Polygon an zwei Randpunkten (Kanten i/j, Parameter ti/tj) über die
 * Sehne in zwei geschlossene Polygone; null bei i==j.
 */
export function splitClosedByChord(
  pts: Vec2[],
  i: number,
  ti: number,
  j: number,
  tj: number,
): [Vec2[], Vec2[]] | null {
  const r = decPtLists(core().k2_split_closed_by_chord(encPts(pts), i, ti, j, tj));
  return r.length === 2 ? [r[0], r[1]] : null;
}

/**
 * Entfernt das Segment `edgeIndex`. Offen: innere Kante → das punktreichere Stück bleibt,
 * Randkante → End-Vertex fällt weg. Geschlossen: an der Kante zur offenen Polylinie aufgetrennt.
 */
export function removeSegment(pts: Vec2[], closed: boolean, edgeIndex: number): { pts: Vec2[]; closed: boolean } {
  return { pts: decPts(core().k2_remove_segment(encPts(pts), closed, edgeIndex)), closed: false };
}

/** Wie {@link removeSegment}, trägt aber das bulge-Array mit (bulge bleibt an seinem Punktepaar). */
export function removeSegmentWithBulge(
  pts: Vec2[],
  bulge: number[],
  closed: boolean,
  edgeIndex: number,
): { pts: Vec2[]; closed: boolean; bulge: number[] } {
  const r = decPtsBulge(core().k2_remove_segment_with_bulge(encPts(pts), encBulge(bulge), closed, edgeIndex));
  return { pts: r.pts, closed: false, bulge: r.bulge };
}

/** Position auf einer Kurve: Kantenindex + Parameter (0..1) auf dieser Kante. */
export interface CurveHit {
  edgeIndex: number;
  t: number;
}

/** Nächste Position auf einer (offenen oder geschlossenen) Punktfolge zu `pt`; null bei < 2 Punkten. */
export function nearestOnPolyline(pts: Vec2[], closed: boolean, pt: Vec2): CurveHit | null {
  const r = core().k2_nearest_on_polyline(encPts(pts), closed, pt.x, pt.y);
  return r.length === 2 ? { edgeIndex: r[0], t: r[1] } : null;
}

/**
 * Entfernt den Abschnitt ZWISCHEN zwei Positionen auf einer OFFENEN Kurve (BREAK,
 * Klick-Reihenfolge egal); bis zu zwei Reststücke.
 */
export function breakCurve(pts: Vec2[], hit1: CurveHit, hit2: CurveHit): Vec2[][] {
  return decPtLists(core().k2_break_curve(encPts(pts), hit1.edgeIndex, hit1.t, hit2.edgeIndex, hit2.t));
}

/**
 * Teilt das Ziel an allen Schnittpunkten mit `others`. Geschlossen + genau zwei Schnitte →
 * zwei geschlossene Polygone; offen → Stücke an den Schnittpunkten.
 */
export function splitAtIntersections(targetPts: Vec2[], closed: boolean, others: Vec2[][]): Vec2[][] {
  return decPtLists(core().k2_split_at_intersections(encPts(targetPts), closed, encPtLists(others)));
}

/**
 * Verschmilzt Polylinien an koinzidenten Endpunkten zu längeren Ketten und trägt je Kette
 * das bulge-Array mit; muss eine Kette umgedreht werden, kehren sich Reihenfolge UND
 * Vorzeichen ihrer bulge-Werte um. Schliesst sich eine Kette, wird sie `closed`.
 */
export function joinChainsWithBulge(
  polylines: { pts: Vec2[]; closed: boolean; bulge?: number[] }[],
): { pts: Vec2[]; closed: boolean; bulge: number[] }[] {
  return decChains(core().k2_join_chains_with_bulge(encChains(polylines, true)));
}
