// Geometrie-Helfer für Ellipse/Bezier/Spline — reine Sample-/Tessellierungs-
// Funktionen, gemeinsam genutzt von den Zeichen-Werkzeugen (Vorschau), dem
// Grundriss-Generator (finales Rendering als Linien-/Polygon-Primitive) und
// dem Snapping (Kandidaten-Strecken).

import type { Vec2 } from "../model/types";

/** Punkte einer (ggf. gedrehten) Ellipse, N gleichverteilte Parameterschritte. */
export function ellipsePts(
  center: Vec2,
  rx: number,
  ry: number,
  rotation: number,
  n = 64,
): Vec2[] {
  const pts: Vec2[] = [];
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const lx = rx * Math.cos(t);
    const ly = ry * Math.sin(t);
    pts.push({ x: center.x + lx * cosR - ly * sinR, y: center.y + lx * sinR + ly * cosR });
  }
  return pts;
}

/** Punkt auf einer kubischen Bezier-Kurve (De-Casteljau-Formel) bei Parameter `t` ∈ [0,1]. */
function cubicPoint(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * Tessellierte Punkte einer kubischen Bezier-Kette. `pts` folgt dem Muster
 * Anker·Griff·Griff·Anker·… (`pts.length` ≡ 1 mod 3). Mit weniger als 4
 * Punkten (noch im Bau) werden die Rohpunkte unverändert zurückgegeben
 * (Gummiband-Vorschau).
 */
export function sampleBezierChain(pts: Vec2[], segsPerCurve = 24): Vec2[] {
  if (pts.length < 4) return [...pts];
  const out: Vec2[] = [pts[0]];
  for (let i = 0; i + 3 < pts.length; i += 3) {
    const p0 = pts[i], p1 = pts[i + 1], p2 = pts[i + 2], p3 = pts[i + 3];
    for (let s = 1; s <= segsPerCurve; s++) out.push(cubicPoint(p0, p1, p2, p3, s / segsPerCurve));
  }
  return out;
}

/** Kontrollpunkt-Zugriff für Catmull-Rom mit Rand-Klemmung bzw. Ring-Umlauf. */
function crPoint(pts: Vec2[], i: number, closed: boolean): Vec2 {
  const n = pts.length;
  if (closed) return pts[((i % n) + n) % n];
  if (i < 0) return pts[0];
  if (i >= n) return pts[n - 1];
  return pts[i];
}

/**
 * Tessellierte Punkte einer glatten Kurve DURCH `pts` (uniformer Catmull-
 * Rom-Spline). Mit weniger als 3 Punkten (noch im Bau bzw. entartet) werden
 * die Rohpunkte unverändert zurückgegeben (Gummiband-Vorschau bzw. Gerade).
 * `closed` schliesst den Ring OHNE expliziten Doppelpunkt am Ende — Aufrufer
 * schliessen wie bei `polyline` selbst mit einem letzten Segment zurück zu
 * `pts[0]`.
 */
export function sampleCatmullRom(pts: Vec2[], closed: boolean, segsPerSpan = 16): Vec2[] {
  if (pts.length < 3) return [...pts];
  const out: Vec2[] = [];
  const spans = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = crPoint(pts, i - 1, closed);
    const p1 = crPoint(pts, i, closed);
    const p2 = crPoint(pts, i + 1, closed);
    const p3 = crPoint(pts, i + 2, closed);
    for (let s = 0; s < segsPerSpan; s++) {
      const t = s / segsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ x, y });
    }
  }
  if (!closed) out.push(pts[pts.length - 1]);
  return out;
}
