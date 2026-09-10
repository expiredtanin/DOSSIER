// Bulge — DXF-Konvention für Bogen-Segmente in Polylinien: `bulge = tan(Δ/4)`
// (Δ = Öffnungswinkel des Kreisbogens von a nach b). Reine Geometrie, keine
// Abhängigkeit vom Modell — s. Kopfkommentar bei `Drawing2DGeom["polyline"].
// bulge` (model/types.ts) für die Feld-Semantik.
//
// Herleitung (Sehnen-Pfeilhöhen-Beziehung, exakt, ohne Kreisbogen-Trigonometrie
// im Radius): für eine Sehne der halben Länge h mit Pfeilhöhe (Sagitta) s gilt
// die Kreissegment-Identität r = (h²+s²) / (2s). Die Bulge-Definition liefert
// zusätzlich exakt s = h·bulge (Standard-Identität (1−cosX)/sinX = tan(X/2)
// mit X = Δ/2). Damit lässt sich der komplette Bogen (Zentrum/Radius) ohne
// eine einzige inverse Winkelfunktion aus bulge ableiten.

import type { Vec2 } from "../model/types";

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
  if (Math.abs(bulge) < EPS) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < EPS) return null;
  const ux = dx / chord, uy = dy / chord;
  const nx = -uy, ny = ux; // Links-Normale von a→b
  const h = chord / 2;
  const s = h * bulge; // Sagitta (Pfeilhöhe), Vorzeichen wie bulge
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const rSigned = (h * h + s * s) / (2 * s);
  const cx = mx + nx * (s - rSigned);
  const cy = my + ny * (s - rSigned);
  const r = Math.abs(rSigned);
  const apexX = mx + nx * s, apexY = my + ny * s;
  const a0 = Math.atan2(a.y - cy, a.x - cx);
  const a1 = Math.atan2(b.y - cy, b.x - cx);
  const aApex = Math.atan2(apexY - cy, apexX - cx);
  const TAU = Math.PI * 2;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  // Die Sehnenmitte (Apex) liegt per Konstruktion auf dem Bogen — die Schwenk-
  // richtung (CCW oder CW von a0 nach a1) ist genau die, die den Apex-Winkel
  // unterwegs passiert. Robust gegen Vorzeichenfehler in der Herleitung oben:
  // wird direkt gegen den bekannten Apex-Punkt geprüft statt abstrakt hergeleitet.
  const ccwSweep = norm(a1 - a0);
  const ccwPassesApex = norm(aApex - a0) <= ccwSweep + 1e-7;
  const sweep = ccwPassesApex ? ccwSweep : -(TAU - ccwSweep);
  return { center: { x: cx, y: cy }, r, a0, a1, sweep };
}

/**
 * Tessellierte Bogenpunkte von a nach b (inkl. beider Endpunkte) — für
 * Rendering/Fläche/Hit-Test/Export, die nur Geradensegmente kennen (analog
 * `circlePts`/`ellipsePts`). `null`-Bulge (Gerade) liefert `[a, b]`.
 */
export function bulgeArcPoints(a: Vec2, b: Vec2, bulge: number | undefined): Vec2[] {
  const arc = bulge !== undefined ? bulgeArc(a, b, bulge) : null;
  if (!arc) return [a, b];
  const { center, r, a0, sweep } = arc;
  // Auflösung: ~1 Segment je 12° reicht für Plan-Massstäbe (analog `circlePts`
  // N=48 bei vollem Kreis ⇒ 7.5°/Segment; hier etwas gröber, dafür adaptiv zur
  // tatsächlichen Bogenlänge statt immer 48 Punkte für jedes kleine Bögchen).
  // Gerade Segmentzahl erzwingen, damit der exakte Apex-Punkt (t=0.5) immer
  // als echter Tessellations-Punkt in der Mitte des Arrays landet (wichtig
  // für den Bulge-Griff, s. `bulgePointAt`).
  let N = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 15)));
  if (N % 2 !== 0) N += 1;
  const pts: Vec2[] = [];
  for (let i = 0; i <= N; i++) {
    const t = a0 + sweep * (i / N);
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return pts;
}

/**
 * Bulge aus einem gezogenen Punkt `p` relativ zur Sehne a-b ableiten (Griff-
 * Interaktion: Segment-Mitte senkrecht zur Sehne ziehen). Exakt die Umkehrung
 * der `s = h·bulge`-Identität oben — kein Winkel involviert.
 */
export function bulgeFromSagittaPoint(a: Vec2, b: Vec2, p: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < EPS) return 0;
  const ux = dx / chord, uy = dy / chord;
  const nx = -uy, ny = ux;
  const h = chord / 2;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const s = (p.x - mx) * nx + (p.y - my) * ny;
  return s / h;
}

/** Punkt auf dem aktuellen Bogen bei Parameter t∈[0,1] (0=a, 1=b, 0.5=Apex) — für den Bulge-Griff. */
export function bulgePointAt(a: Vec2, b: Vec2, bulge: number, t: number): Vec2 {
  const pts = bulgeArcPoints(a, b, bulge);
  if (pts.length <= 2) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const idx = Math.round(t * (pts.length - 1));
  return pts[Math.max(0, Math.min(pts.length - 1, idx))];
}

/** Punkt auf einem Kreis (center, r) beim Winkel `a` (Radiant). */
export function pointOnCircle(center: Vec2, r: number, a: number): Vec2 {
  return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
}

/**
 * Bulge-Wert für den Teilbogen desselben Kreises (center, r) von Winkel `aFrom`
 * zu `aTo`, in der durch `sweepSign` vorgegebenen Schwenkrichtung (+1 = CCW,
 * −1 = CW — dieselbe Richtung wie der Eltern-Bogen, aus dem dieser Teilbogen
 * stammt, z. B. beim Zuschneiden/Offsetten eines Bogen-Segments). Statt die
 * Vorzeichen-Herleitung erneut zu machen (fehleranfällig), wird ein echter
 * Punkt AUF dem Teilbogen (bei der Winkel-Mitte) konstruiert und darüber
 * `bulgeFromSagittaPoint` (bereits getestet, s. `bulgeArc`) wiederverwendet.
 */
export function bulgeBetweenAngles(
  center: Vec2,
  r: number,
  aFrom: number,
  aTo: number,
  sweepSign: 1 | -1,
): number {
  const TAU = Math.PI * 2;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  const delta = sweepSign > 0 ? norm(aTo - aFrom) : -norm(aFrom - aTo);
  const mid = aFrom + delta / 2;
  const P = pointOnCircle(center, r, aFrom);
  const Q = pointOnCircle(center, r, aTo);
  const M = pointOnCircle(center, r, mid);
  return bulgeFromSagittaPoint(P, Q, M);
}
