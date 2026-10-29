// 2D-Geometrie-Kernel — Fassade über den Rust-Kern (`src-tauri/kernel2d`, gebunden in
// `src-tauri/core/src/web/kernel2d.rs`, geladen über `engine/coreWasm.ts`). Offset / Trim /
// Fillet / Split / Segment löschen, auch mit Bogen-Segmenten (bulge); Trim/Extend/Fase/Bruch/
// Offset/Join rufen die Editier-Befehle direkt im Kern auf (`core/src/cmd_edit.rs`). Die
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

function encPts(pts: Vec2[]): Float64Array {
  const out = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    out[2 * i] = pts[i].x;
    out[2 * i + 1] = pts[i].y;
  }
  return out;
}

function decPts(buf: Float64Array, from = 0, count = (buf.length - from) / 2): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k < count; k++) out.push({ x: buf[from + 2 * k], y: buf[from + 2 * k + 1] });
  return out;
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
