// Geometrie-Helfer für das Gebäudemodell. Reine 2D/3D-Mathematik,
// kein externer Kernel nötig (Phase 0).

import type { Vec2 } from "./types";

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);

export const normalize = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};

/** Linke Normale (90° gegen den Uhrzeigersinn gedreht). */
export const leftNormal = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

/** Kreuzprodukt (Z-Komponente) zweier 2D-Vektoren. */
export const cross = (p: Vec2, q: Vec2): number => p.x * q.y - p.y * q.x;

/** Skalarprodukt zweier 2D-Vektoren. */
export const dot = (p: Vec2, q: Vec2): number => p.x * q.x + p.y * q.y;

/** Eine unendliche Gerade als Stützpunkt + Richtung. */
export interface Line {
  point: Vec2;
  dir: Vec2;
}

/**
 * Schnittpunkt der Geraden (a + t·da) mit (b + s·db).
 * Liefert null bei (nahezu) parallelen Richtungen.
 */
export function lineIntersect(
  a: Vec2,
  da: Vec2,
  b: Vec2,
  db: Vec2,
): Vec2 | null {
  const denom = cross(da, db);
  if (Math.abs(denom) < 1e-9) return null; // parallel → kein Schnitt
  const t = cross(sub(b, a), db) / denom;
  return add(a, scale(da, t));
}

/** Punkt entlang einer Strecke p1→p2 im Abstand d vom Start. */
export const along = (p1: Vec2, p2: Vec2, d: number): Vec2 =>
  add(p1, scale(normalize(sub(p2, p1)), d));

/**
 * Die vier Eckpunkte eines Bandes, das quer zur Normalen zwischen den
 * Offsets offA und offB liegt (gemessen entlang der linken Normalen n).
 * Reihenfolge: start+n*offA, end+n*offA, end+n*offB, start+n*offB.
 */
export function wallBand(
  start: Vec2,
  end: Vec2,
  offA: number,
  offB: number,
): [Vec2, Vec2, Vec2, Vec2] {
  const u = normalize(sub(end, start));
  const n = leftNormal(u);
  return [
    add(start, scale(n, offA)),
    add(end, scale(n, offA)),
    add(end, scale(n, offB)),
    add(start, scale(n, offB)),
  ];
}

/** Die vier Eckpunkte einer Wand als Polygon (gegen den Uhrzeigersinn). */
export function wallCorners(
  start: Vec2,
  end: Vec2,
  thickness: number,
): [Vec2, Vec2, Vec2, Vec2] {
  const h = thickness / 2;
  return wallBand(start, end, h, -h);
}

/**
 * Wie {@link wallBand}, aber die Bandenden werden bei Bedarf an Geh­rungs­linien
 * (startCut / endCut) abgeschnitten statt rechtwinklig gekappt. Jede der beiden
 * Bandkanten (bei Offset offA bzw. offB, Richtung u) wird mit der jeweiligen
 * Schnittlinie verschnitten; fehlt eine Schnittlinie, bleibt das Ende
 * rechtwinklig (Punkt auf der Achssenkrechten).
 * Reihenfolge bleibt konsistent zu wallBand: [A.start, A.end, B.end, B.start].
 */
export function clippedBand(
  start: Vec2,
  end: Vec2,
  offA: number,
  offB: number,
  startCut: Line | null,
  endCut: Line | null,
): [Vec2, Vec2, Vec2, Vec2] {
  const u = normalize(sub(end, start));
  const n = leftNormal(u);

  const edgeStart = (off: number): Vec2 => {
    const base = add(start, scale(n, off));
    if (!startCut) return base;
    return lineIntersect(base, u, startCut.point, startCut.dir) ?? base;
  };
  const edgeEnd = (off: number): Vec2 => {
    const base = add(end, scale(n, off));
    if (!endCut) return base;
    return lineIntersect(base, u, endCut.point, endCut.dir) ?? base;
  };

  return [edgeStart(offA), edgeEnd(offA), edgeEnd(offB), edgeStart(offB)];
}
