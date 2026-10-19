// Raster-Index über die Bounding-Boxen von Linien-/Polylinien-Zeichnungen
// (Drawing2D). Abfragen prüfen nur die Zeichnungen in Cursornähe statt alle —
// bei einem Kataster-Import ~10^5 Zeichnungen / 3,7 Mio. Strecken. Genutzt für
// Hover/Pick/Marquee (plan/planView/underlayAccess.ts) und den Objektfang
// (tools/snapping.ts).

import type { Drawing2D, Vec2 } from "../model/types";
import { drawingBox } from "./drawingBounds";

/** Abstand Punkt–Strecke (Modell-Einheiten). */
export function pointSegDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Segmente einer Linie/Polylinie, genau wie sie als 'line'-Primitive entstünden. */
export function forEachSegment(d: Drawing2D, fn: (a: Vec2, b: Vec2) => void): void {
  const g = d.geom;
  if (g.shape === "line") {
    fn(g.a, g.b);
    return;
  }
  if (g.shape !== "polyline") return;
  const pts = g.pts;
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) fn(pts[i], pts[i + 1]);
  if (g.closed && n > 2) fn(pts[n - 1], pts[0]);
}

export interface DrawingIndex {
  minX: number;
  minY: number;
  cell: number;
  cols: number;
  rows: number;
  cellStart: Uint32Array;
  items: Uint32Array;
  /** Zeichnungen mit riesiger Bounding-Box: immer geprüft. */
  long: Uint32Array;
  drawings: readonly Drawing2D[];
}

const TARGET_PER_CELL = 4;
const MAX_CELLS = 2_000_000;
const MAX_CELLS_PER_DRAWING = 256;

/** Ob eine Zeichnung vom Index erfasst wird (Linie/Polylinie mit Punkten). */
export const isIndexable = (d: Drawing2D): boolean =>
  d.geom.shape === "line" || d.geom.shape === "polyline";

export function buildDrawingIndex(drawings: readonly Drawing2D[]): DrawingIndex | null {
  if (drawings.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of drawings) {
    const b = drawingBox(d);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (!isFinite(minX)) return null;
  const w = Math.max(maxX - minX, 1e-6);
  const h = Math.max(maxY - minY, 1e-6);
  const cellCount = Math.min(MAX_CELLS, Math.max(1, Math.ceil(drawings.length / TARGET_PER_CELL)));
  let cell = Math.sqrt((w * h) / cellCount);
  if (!(cell > 0)) cell = Math.max(w, h);
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(h / cell));
  const cx = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cell)));
  const cy = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cell)));

  const counts = new Uint32Array(cols * rows + 1);
  const long: number[] = [];
  const longSet = new Set<number>();
  for (let i = 0; i < drawings.length; i++) {
    const b = drawingBox(drawings[i]);
    if (!isFinite(b.minX)) continue;
    const x0 = cx(b.minX), x1 = cx(b.maxX), y0 = cy(b.minY), y1 = cy(b.maxY);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_DRAWING) {
      long.push(i);
      longSet.add(i);
      continue;
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) counts[y * cols + x + 1]++;
  }
  for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
  const cellStart = counts;
  const fill = cellStart.slice(0, cols * rows);
  const items = new Uint32Array(cellStart[cols * rows]);
  for (let i = 0; i < drawings.length; i++) {
    if (longSet.has(i)) continue;
    const b = drawingBox(drawings[i]);
    if (!isFinite(b.minX)) continue;
    const x0 = cx(b.minX), x1 = cx(b.maxX), y0 = cy(b.minY), y1 = cy(b.maxY);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) items[fill[y * cols + x]++] = i;
  }
  return { minX, minY, cell, cols, rows, cellStart, items, long: Uint32Array.from(long), drawings };
}

/**
 * Indizes der Zeichnungen, deren Bounding-Box (um `r` erweitert) den Punkt `m`
 * enthält — Kandidaten, jede höchstens einmal.
 */
export function drawingsNear(index: DrawingIndex, m: Vec2, r: number): number[] {
  const { minX, minY, cell, cols, rows, cellStart, items, long, drawings } = index;
  const out: number[] = [];
  const seen = new Set<number>();
  const take = (i: number) => {
    if (seen.has(i)) return;
    seen.add(i);
    const b = drawingBox(drawings[i]);
    if (m.x < b.minX - r || m.x > b.maxX + r || m.y < b.minY - r || m.y > b.maxY + r) return;
    out.push(i);
  };
  for (const i of long) take(i);
  const x0 = Math.floor((m.x - r - minX) / cell);
  const x1 = Math.floor((m.x + r - minX) / cell);
  const y0 = Math.floor((m.y - r - minY) / cell);
  const y1 = Math.floor((m.y + r - minY) / cell);
  if (x1 < 0 || y1 < 0 || x0 >= cols || y0 >= rows) return out;
  for (let y = Math.max(0, y0); y <= Math.min(rows - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(cols - 1, x1); x++) {
      const c = y * cols + x;
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) take(items[k]);
    }
  }
  return out;
}

export interface NearestHit {
  drawing: Drawing2D;
  a: Vec2;
  b: Vec2;
  dist: number;
}

/** Nächstes Segment (Modell-Meter) mit Abstand < `maxDist`, oder null. */
export function nearestInDrawings(index: DrawingIndex, m: Vec2, maxDist: number): NearestHit | null {
  let best: NearestHit | null = null;
  let bestDist = maxDist;
  for (const i of drawingsNear(index, m, maxDist)) {
    const d = index.drawings[i];
    forEachSegment(d, (a, b) => {
      const dist = pointSegDist(m, a, b);
      if (dist < bestDist) {
        bestDist = dist;
        best = { drawing: d, a, b, dist };
      }
    });
  }
  return best;
}

/** ALLE Zeichnungen mit einem Segment näher als `maxDist` an `m`, nächste zuerst (je Zeichnung ihr nächstes Segment). */
export function drawingsWithinDistance(index: DrawingIndex, m: Vec2, maxDist: number): NearestHit[] {
  const out: NearestHit[] = [];
  for (const i of drawingsNear(index, m, maxDist)) {
    const d = index.drawings[i];
    let best: NearestHit | null = null;
    forEachSegment(d, (a, b) => {
      const dist = pointSegDist(m, a, b);
      if (dist < maxDist && (!best || dist < best.dist)) best = { drawing: d, a, b, dist };
    });
    if (best) out.push(best);
  }
  return out.sort((x, y) => x.dist - y.dist);
}
