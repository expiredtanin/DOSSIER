// Bounding-Box je Drawing2D-OBJEKT (gecacht). Projekt-Updates teilen unveränderte
// Zeichnungen (Structural Sharing) — ihre Box muss nicht bei jedem Plan-Aufbau
// neu über alle Punkte berechnet werden (bei einem Kataster-Import 3,7 Mio.).

import type { Drawing2D, Vec2 } from "../model/types";

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const boxCache = new WeakMap<Drawing2D, Box>();

/** Punkte einer Linie/Polylinie; andere Formen: leer. */
export function linePointsOf(d: Drawing2D): readonly Vec2[] {
  const g = d.geom;
  if (g.shape === "line") return [g.a, g.b];
  if (g.shape === "polyline") return g.pts;
  return [];
}

/** Box über die Punkte einer Linie/Polylinie (Infinity-Box, wenn keine Punkte). */
export function drawingBox(d: Drawing2D): Box {
  let b = boxCache.get(d);
  if (b) return b;
  b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of linePointsOf(d)) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.y > b.maxY) b.maxY = p.y;
  }
  boxCache.set(d, b);
  return b;
}
