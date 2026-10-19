// Punkttypen einer Polylinie (ArchiCAD/Vectorworks-artig): Eckpunkt, Bogenpunkt,
// Splinepunkt. Rein als Umrechnung der Segment-Bögen (`bulge`) der beiden am Punkt
// anliegenden Segmente — alle Renderer/Exporte verstehen Bulges bereits, es gibt
// also kein neues Geometrie-Feld.
//
//  • Eckpunkt:   beide Segmente gerade (bulge 0).
//  • Bogenpunkt: EIN Kreisbogen durch Vorgänger, Punkt und Nachfolger.
//  • Splinepunkt: tangential glatter Übergang — die Tangente im Punkt ist parallel
//    zur Verbindung Vorgänger→Nachfolger (wie bei einer Catmull-Rom-Kurve), beide
//    Segmente werden zu Bögen, die diese Tangente teilen.
//
// Die Bögen werden über ihren SCHEITELPUNKT bestimmt und mit `bulgeFromSagittaPoint`
// in einen Bulge übersetzt — so bleibt die Vorzeichen-Konvention an EINER Stelle.

import type { Vec2 } from "../model/types";
import { bulgeArc, bulgeFromSagittaPoint } from "./bulge";

export type PolylineVertexType = "corner" | "arc" | "spline";

interface PolylineLike {
  pts: Vec2[];
  closed: boolean;
  bulge?: number[];
}

const EPS = 1e-9;

/** Indizes des ein- und ausgehenden Segments von Punkt `i` (null = keins). */
function adjacentSegments(n: number, closed: boolean, i: number): { inSeg: number | null; outSeg: number | null } {
  const inSeg = i > 0 ? i - 1 : closed ? n - 1 : null;
  const outSeg = i < n - 1 ? i : closed ? n - 1 : null;
  return { inSeg, outSeg };
}

/** Nachbarpunkte von `i` (null an offenen Enden). */
function neighbors(g: PolylineLike, i: number): { prev: Vec2 | null; next: Vec2 | null } {
  const n = g.pts.length;
  const prev = i > 0 ? g.pts[i - 1] : g.closed ? g.pts[n - 1] : null;
  const next = i < n - 1 ? g.pts[i + 1] : g.closed ? g.pts[0] : null;
  return { prev, next };
}

const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

/** Umkreismittelpunkt von a,b,c (null bei kollinearen Punkten). */
function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < EPS) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  return {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
}

/**
 * Bulge des Kreisbogens a→b auf dem Kreis um `c`, und zwar des Bogens, der NICHT
 * durch `other` läuft (Scheitel auf der anderen Seite der Sehne als `other`).
 */
function bulgeOnCircle(a: Vec2, b: Vec2, c: Vec2, other: Vec2): number {
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  let u = sub(mid, c);
  let len = Math.hypot(u.x, u.y);
  if (len < EPS) {
    const d = sub(b, a);
    u = { x: -d.y, y: d.x };
    len = Math.hypot(u.x, u.y);
  }
  u = { x: u.x / len, y: u.y / len };
  const side = (p: Vec2) => Math.sign(cross(sub(b, a), sub(p, a)));
  const cand1 = { x: c.x + u.x * r, y: c.y + u.y * r };
  const cand2 = { x: c.x - u.x * r, y: c.y - u.y * r };
  const apex = side(cand1) !== side(other) ? cand1 : cand2;
  return bulgeFromSagittaPoint(a, b, apex);
}

/** Tangente (Fahrtrichtung a→b) des Bulge-Bogens am Anfang bzw. Ende. */
function arcTangent(a: Vec2, b: Vec2, bulge: number, atEnd: boolean): Vec2 {
  const arc = bulgeArc(a, b, bulge);
  if (!arc) {
    const d = sub(b, a);
    const l = Math.hypot(d.x, d.y) || 1;
    return { x: d.x / l, y: d.y / l };
  }
  const ang = atEnd ? arc.a0 + arc.sweep : arc.a0;
  const s = Math.sign(arc.sweep) || 1;
  return { x: -Math.sin(ang) * s, y: Math.cos(ang) * s };
}

/**
 * Bulge des Bogens a→b mit gegebener Tangente `t` am Ende (atEnd) bzw. Anfang.
 * Betrag aus dem Winkel Sehne↔Tangente, Vorzeichen NUMERISCH gewählt (die
 * Variante, deren tatsächliche Tangente zu `t` passt).
 */
function bulgeWithTangent(a: Vec2, b: Vec2, t: Vec2, atEnd: boolean): number {
  const c = sub(b, a);
  const ang = Math.abs(Math.atan2(cross(c, t), c.x * t.x + c.y * t.y));
  const mag = Math.abs(bulgeFromApexAngle(a, b, ang));
  if (mag < 1e-9) return 0;
  const dot = (v: Vec2) => v.x * t.x + v.y * t.y;
  return dot(arcTangent(a, b, mag, atEnd)) >= dot(arcTangent(a, b, -mag, atEnd)) ? mag : -mag;
}

const bulgeWithEndTangent = (a: Vec2, b: Vec2, t: Vec2) => bulgeWithTangent(a, b, t, true);
const bulgeWithStartTangent = (a: Vec2, b: Vec2, t: Vec2) => bulgeWithTangent(a, b, t, false);

/**
 * Bogen über der Sehne a→b mit halbem Öffnungswinkel |half| (Sehne↔Tangente);
 * Vorzeichen: >0 Scheitel links der Sehne, <0 rechts. Über den Scheitelpunkt in
 * einen Bulge übersetzt.
 */
function bulgeFromApexAngle(a: Vec2, b: Vec2, half: number): number {
  if (Math.abs(half) < 1e-6) return 0;
  // Begrenzen: knapp unter einem Halbkreis je Segment (sonst kippt der Bogen).
  const h2 = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, half));
  const d = sub(b, a);
  const chord = Math.hypot(d.x, d.y);
  if (chord < EPS) return 0;
  const left = { x: -d.y / chord, y: d.x / chord };
  const s = (chord / 2) * Math.tan(h2 / 2); // Pfeilhöhe
  const apex = { x: (a.x + b.x) / 2 + left.x * s, y: (a.y + b.y) / 2 + left.y * s };
  return bulgeFromSagittaPoint(a, b, apex);
}

/** Ist Punkttyp `type` am Punkt `i` möglich? (Bogen/Spline brauchen beide Nachbarn.) */
export function canSetVertexType(g: PolylineLike, i: number, type: PolylineVertexType): boolean {
  if (i < 0 || i >= g.pts.length) return false;
  if (type === "corner") return true;
  const { prev, next } = neighbors(g, i);
  return !!prev && !!next;
}

/** Aktueller Typ (Heuristik): beide Nachbarsegmente gerade → Eckpunkt, sonst null (gemischt). */
export function vertexTypeOf(g: PolylineLike, i: number): PolylineVertexType | null {
  const { inSeg, outSeg } = adjacentSegments(g.pts.length, g.closed, i);
  const b = (k: number | null) => (k === null ? 0 : g.bulge?.[k] ?? 0);
  if (Math.abs(b(inSeg)) < 1e-9 && Math.abs(b(outSeg)) < 1e-9) return "corner";
  const { prev, next } = neighbors(g, i);
  if (!prev || !next || inSeg === null || outSeg === null) return null;
  const a1 = bulgeArc(prev, g.pts[i], b(inSeg));
  const a2 = bulgeArc(g.pts[i], next, b(outSeg));
  if (a1 && a2 && Math.hypot(a1.center.x - a2.center.x, a1.center.y - a2.center.y) < 1e-6 * (1 + a1.r)) return "arc";
  return "spline";
}

/** Neue Bulge-Liste mit Punkttyp `type` an Punkt `i` (Eingabe bleibt unverändert). */
export function withVertexType(g: PolylineLike, i: number, type: PolylineVertexType): number[] {
  const n = g.pts.length;
  const segCount = g.closed ? n : n - 1;
  const bulge = Array.from({ length: segCount }, (_, k) => g.bulge?.[k] ?? 0);
  if (!canSetVertexType(g, i, type)) return bulge;
  const { inSeg, outSeg } = adjacentSegments(n, g.closed, i);
  const q = g.pts[i];
  const { prev, next } = neighbors(g, i);
  if (type === "corner") {
    if (inSeg !== null) bulge[inSeg] = 0;
    if (outSeg !== null) bulge[outSeg] = 0;
    return bulge;
  }
  const p = prev!, r = next!;
  if (type === "arc") {
    const c = circumcenter(p, q, r);
    if (!c) {
      bulge[inSeg!] = 0;
      bulge[outSeg!] = 0;
      return bulge;
    }
    bulge[inSeg!] = bulgeOnCircle(p, q, c, r);
    bulge[outSeg!] = bulgeOnCircle(q, r, c, p);
    return bulge;
  }
  // spline: Tangente parallel zu prev→next
  const t = sub(r, p);
  const tl = Math.hypot(t.x, t.y);
  if (tl < EPS) return bulge;
  const tu = { x: t.x / tl, y: t.y / tl };
  bulge[inSeg!] = bulgeWithEndTangent(p, q, tu);
  bulge[outSeg!] = bulgeWithStartTangent(q, r, tu);
  return bulge;
}
