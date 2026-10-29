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

/** Punkt entlang einer Strecke p1→p2 im Abstand d vom Start. */
export const along = (p1: Vec2, p2: Vec2, d: number): Vec2 =>
  add(p1, scale(normalize(sub(p2, p1)), d));

/** Die vier Eckpunkte einer Wand als Polygon (gegen den Uhrzeigersinn). */
export function wallCorners(
  start: Vec2,
  end: Vec2,
  thickness: number,
): [Vec2, Vec2, Vec2, Vec2] {
  const h = thickness / 2;
  const u = normalize(sub(end, start));
  const n = leftNormal(u);
  return [add(start, scale(n, h)), add(end, scale(n, h)), add(end, scale(n, -h)), add(start, scale(n, -h))];
}
