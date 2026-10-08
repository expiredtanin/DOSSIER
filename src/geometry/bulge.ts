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
import { lineIntersect } from "../model/geometry";

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

/**
 * Bulge eines Kreisbogens, der von `a` über `through` nach `b` läuft — der
 * klassische Drei-Punkt-Bogen. Anders als die Tangenten-Variante hängt er NUR
 * von diesen drei Punkten ab, nicht vom vorherigen Segment: Radius und
 * Wölbung sind damit pro Segment frei wählbar (Nutzer-Anforderung).
 *
 * Liegen die drei Punkte (nahezu) auf einer Geraden, gibt es keinen Kreis —
 * dann 0 (gerade).
 */
export function bulgeThroughPoint(a: Vec2, through: Vec2, b: Vec2): number {
  // Umkreismittelpunkt über die Schnittpunkt-Formel der Mittelsenkrechten.
  const d = 2 * (a.x * (through.y - b.y) + through.x * (b.y - a.y) + b.x * (a.y - through.y));
  if (Math.abs(d) < EPS) return 0;
  const a2 = a.x * a.x + a.y * a.y;
  const t2 = through.x * through.x + through.y * through.y;
  const b2 = b.x * b.x + b.y * b.y;
  const center = {
    x: (a2 * (through.y - b.y) + t2 * (b.y - a.y) + b2 * (a.y - through.y)) / d,
    y: (a2 * (b.x - through.x) + t2 * (a.x - b.x) + b2 * (through.x - a.x)) / d,
  };
  const r = Math.hypot(a.x - center.x, a.y - center.y);
  if (r < EPS) return 0;
  const ang = (p: Vec2) => Math.atan2(p.y - center.y, p.x - center.x);
  const TAU = Math.PI * 2;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  // Schwenkrichtung ist die, bei der `through` unterwegs passiert wird.
  const aFrom = ang(a);
  const ccwToThrough = norm(ang(through) - aFrom);
  const ccwToB = norm(ang(b) - aFrom);
  const sweepSign: 1 | -1 = ccwToThrough <= ccwToB ? 1 : -1;
  return bulgeBetweenAngles(center, r, aFrom, ang(b), sweepSign);
}

/** Punkt auf einem Kreis (center, r) beim Winkel `a` (Radiant). */
export function pointOnCircle(center: Vec2, r: number, a: number): Vec2 {
  return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
}

/**
 * Kreisbogen-Parameter (Mittelpunkt/Radius/Start-/Endwinkel) durch drei Punkte
 * `a`→`through`→`b` — der klassische Drei-Punkt-Bogen, hier direkt als
 * `{center,r,a0,a1}` statt als `bulge` (für Werkzeuge, die einen eigenständigen
 * `{shape:"arc"}` erzeugen, z. B. `commands/cmds/arc.ts`, statt ein
 * Polylinien-Segment). `a0`/`a1` sind IMMER so geordnet, dass der Bogen CCW von
 * a0 nach a1 läuft (Konvention von `{shape:"arc"}`, s. dort) — anders als
 * `bulgeThroughPoint`, dessen Vorzeichen die Sehnen-Richtung a→b behält.
 * `null` bei (nahezu) kollinearen Punkten (kein Kreis).
 */
export function arcThroughPoints(
  a: Vec2,
  through: Vec2,
  b: Vec2,
): { center: Vec2; r: number; a0: number; a1: number } | null {
  const bulge = bulgeThroughPoint(a, through, b);
  if (Math.abs(bulge) < EPS) return null;
  const arc = bulgeArc(a, b, bulge);
  if (!arc) return null;
  return arc.sweep < 0
    ? { center: arc.center, r: arc.r, a0: arc.a1, a1: arc.a0 }
    : { center: arc.center, r: arc.r, a0: arc.a0, a1: arc.a1 };
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

/**
 * Kreisbogen-Parameter durch zwei Endpunkte `a`→`b` mit vorgegebenem Radius
 * `r` — die zweite fehlende Bogen-Konstruktionsmethode aus der Recherche
 * „Grösster Hebel" (`commands/cmds/arc.ts`, Methode „Start-Ende-Radius").
 * `near` (typischerweise der Cursor) entscheidet, auf welche Seite der Sehne
 * sich der Bogen wölbt — analog zu einem gezogenen Bulge-Griff. Liefert
 * immer den KLEINEREN der beiden möglichen Bögen (Sehnenwinkel ≤ 180°): der
 * Radius allein legt zwei Kreise fest (Zentrum auf einer der beiden Seiten
 * der Sehne), aber erst zusammen mit „welcher Bogen dieses Kreises" ergäbe
 * sich sonst eine dritte, unnötige Mehrdeutigkeit — der kleinere Bogen ist
 * die für eine Zieh-Geste erwartbare, stetige Wahl (grosser Radius ⇒ flacher
 * Bogen, kleiner Radius (nahe der halben Sehnenlänge) ⇒ Halbkreis).
 * `null`, wenn `r` kleiner als die halbe Sehnenlänge ist (kein Kreis möglich)
 * oder die Sehne entartet (a≈b).
 */
export function arcFromStartEndRadius(
  a: Vec2,
  b: Vec2,
  r: number,
  near: Vec2,
): { center: Vec2; r: number; a0: number; a1: number } | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < EPS) return null;
  const h = chord / 2;
  if (r < h - EPS) return null;
  const rr = Math.max(r, h);
  const s = rr - Math.sqrt(Math.max(0, rr * rr - h * h)); // Sagitta des kleineren Bogens
  const ux = dx / chord, uy = dy / chord;
  const nx = -uy, ny = ux; // Links-Normale von a→b, wie `bulgeArc`
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const sideSign = (near.x - mx) * nx + (near.y - my) * ny >= 0 ? 1 : -1;
  const bulge = (sideSign * s) / h;
  const arc = bulgeArc(a, b, bulge);
  if (!arc) return null;
  return arc.sweep < 0
    ? { center: arc.center, r: arc.r, a0: arc.a1, a1: arc.a0 }
    : { center: arc.center, r: arc.r, a0: arc.a0, a1: arc.a1 };
}

/**
 * Kreisbogen-Parameter durch zwei Endpunkte `a`→`b`, tangential zu einer bei
 * `a` vorgegebenen Richtung (`dir`, ein Punkt AUF dem Tangentenstrahl, nicht
 * zwingend auf dem Bogen selbst) — dritte fehlende Bogen-Konstruktions-
 * methode. Der Kreismittelpunkt steht per Definition senkrecht zur Tangente
 * bei `a` UND auf der Mittelsenkrechten von a-b — beide Geraden geschnitten
 * (`lineIntersect`) ergeben ihn eindeutig, ohne Fallunterscheidung. Die
 * Schwenkrichtung (CCW/CW von a0 nach a1) wird so gewählt, dass die
 * Bogen-Tangente bei a tatsächlich in Richtung `dir` zeigt (nicht rückwärts).
 * `null` bei entarteter Tangente (`dir`≈`a`) oder wenn die Tangente exakt
 * entlang der Sehne a-b zeigt (Mittelsenkrechte und Tangenten-Normale
 * parallel — kein eindeutiger Kreis, Grenzfall „Gerade").
 */
export function arcFromStartEndDirection(
  a: Vec2,
  b: Vec2,
  dir: Vec2,
): { center: Vec2; r: number; a0: number; a1: number } | null {
  const tx = dir.x - a.x, ty = dir.y - a.y;
  const tLen = Math.hypot(tx, ty);
  if (tLen < EPS) return null;
  const ux = tx / tLen, uy = ty / tLen;
  const tangentNormal = { x: -uy, y: ux }; // senkrecht zur Tangente bei a
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const chordNormal = { x: -(b.y - a.y), y: b.x - a.x }; // senkrecht zur Sehne a-b
  const center = lineIntersect(a, tangentNormal, mid, chordNormal);
  if (!center) return null;
  const r = Math.hypot(a.x - center.x, a.y - center.y);
  if (r < EPS) return null;
  const a0raw = Math.atan2(a.y - center.y, a.x - center.x);
  const a1raw = Math.atan2(b.y - center.y, b.x - center.x);
  // CCW-Tangentenrichtung bei a0raw ist die Ableitung von (cos,sin) nach
  // wachsendem Winkel: (−sin,cos). Zeigt sie NICHT in Richtung (ux,uy), muss
  // der Bogen stattdessen CW laufen (a0/a1 vertauscht, wie `arcThroughPoints`
  // bei negativem `sweep`).
  const tangentCCW = { x: -Math.sin(a0raw), y: Math.cos(a0raw) };
  const matchesCCW = tangentCCW.x * ux + tangentCCW.y * uy >= 0;
  return matchesCCW
    ? { center, r, a0: a0raw, a1: a1raw }
    : { center, r, a0: a1raw, a1: a0raw };
}
