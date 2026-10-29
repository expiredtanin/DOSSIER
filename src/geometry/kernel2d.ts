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

// ── Kodierung ────────────────────────────────────────────────────────────────

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

/** `[n_pts, xy…, bulge…]`. */
function decPtsBulge(buf: Float64Array): { pts: Vec2[]; bulge: number[] } {
  const n = buf[0] ?? 0;
  return { pts: decPts(buf, 1, n), bulge: Array.from(buf.subarray(1 + 2 * n)) };
}

// ── Punkt/Strecke, Fläche ───────────────────────────────────────────────────

/** Schnittpunkte zweier Kreise (0/1/2 Punkte). */
export function circleCircleIntersect(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  return decPts(core().k2_circle_circle_intersect(c1.x, c1.y, r1, c2.x, c2.y, r2));
}

// ── Offset ───────────────────────────────────────────────────────────────────

// ── Tangente-Tangente-Radius ────────────────────────────────────────────────

// ── Fillet / Fase ────────────────────────────────────────────────────────────

// ── Split / Segment löschen ─────────────────────────────────────────────────

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

/**
 * Teilt das Ziel an allen Schnittpunkten mit `others`. Geschlossen + genau zwei Schnitte →
 * zwei geschlossene Polygone; offen → Stücke an den Schnittpunkten.
 */
export function splitAtIntersections(targetPts: Vec2[], closed: boolean, others: Vec2[][]): Vec2[][] {
  return decPtLists(core().k2_split_at_intersections(encPts(targetPts), closed, encPtLists(others)));
}

