// Zugriff auf die kompakte Linien-Unterlage (`Plan.underlay`) für Hover, Klick-
// Auswahl und Marquee. Die Linien existieren dort nicht als Primitive, deshalb
// arbeiten diese Funktionen direkt auf den `Drawing2D`-Geometrien — mit einem
// Raster über die Zeichnungs-Bounding-Boxen, damit eine Abfrage nur die
// Zeichnungen in Cursornähe prüft (nicht alle ~10^5).

import type { Drawing2D, Vec2 } from "../../model/types";
import type { ModelRect } from "./geometry";
import { polyEnclosedByRect, polyTouchesRect } from "./geometry";
import { pointSegDist } from "./segmentIndex";
import { drawingBox } from "../generatePlan/drawingBounds";

/** Segmente einer Zeichnung, genau wie sie als 'line'-Primitive entstünden. */
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

// ── Raster-Index ────────────────────────────────────────────────────────────

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

export interface NearestHit {
  drawing: Drawing2D;
  a: Vec2;
  b: Vec2;
  dist: number;
}

/** Nächstes Segment (Modell-Meter) mit Abstand < `maxDist`, oder null. */
export function nearestInDrawings(index: DrawingIndex, m: Vec2, maxDist: number): NearestHit | null {
  const { minX, minY, cell, cols, rows, cellStart, items, long, drawings } = index;
  let best: NearestHit | null = null;
  let bestDist = maxDist;
  const seen = new Set<number>();
  const check = (i: number) => {
    if (seen.has(i)) return;
    seen.add(i);
    const d = drawings[i];
    const bx = drawingBox(d);
    if (m.x < bx.minX - bestDist || m.x > bx.maxX + bestDist || m.y < bx.minY - bestDist || m.y > bx.maxY + bestDist) return;
    forEachSegment(d, (a, b) => {
      const dist = pointSegDist(m, a, b);
      if (dist < bestDist) {
        bestDist = dist;
        best = { drawing: d, a, b, dist };
      }
    });
  };
  for (const i of long) check(i);
  const x0 = Math.floor((m.x - maxDist - minX) / cell);
  const x1 = Math.floor((m.x + maxDist - minX) / cell);
  const y0 = Math.floor((m.y - maxDist - minY) / cell);
  const y1 = Math.floor((m.y + maxDist - minY) / cell);
  if (x1 < 0 || y1 < 0 || x0 >= cols || y0 >= rows) return best;
  for (let y = Math.max(0, y0); y <= Math.min(rows - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(cols - 1, x1); x++) {
      const c = y * cols + x;
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) check(items[k]);
    }
  }
  return best;
}

// ── Marquee ─────────────────────────────────────────────────────────────────

/**
 * Punktliste einer Zeichnung EXAKT wie `marqueeHitDrawings` sie aus den
 * Primitiven sammelt (Polygon-Punkte einer geschlossenen Kontur zuerst, dann je
 * Segment a, b) — damit Ergebnis und Semantik identisch bleiben.
 */
function marqueePoints(d: Drawing2D): Vec2[] {
  const g = d.geom;
  const pts: Vec2[] = [];
  if (g.shape === "polyline" && g.closed && g.pts.length > 2) for (const p of g.pts) pts.push(p);
  forEachSegment(d, (a, b) => {
    pts.push(a, b);
  });
  return pts;
}

/** Marquee über kompakt gehaltene Zeichnungen; liefert deren IDs. */
export function marqueeHitUnderlay(
  drawings: readonly Drawing2D[],
  rect: ModelRect,
  crossing: boolean,
): string[] {
  const out: string[] = [];
  for (const d of drawings) {
    const b = drawingBox(d);
    if (!isFinite(b.minX)) continue;
    const disjoint = b.maxX < rect.minX || b.minX > rect.maxX || b.maxY < rect.minY || b.minY > rect.maxY;
    if (disjoint) continue; // weder berühren noch einschliessen möglich
    if (!crossing && !(b.minX >= rect.minX && b.maxX <= rect.maxX && b.minY >= rect.minY && b.maxY <= rect.maxY)) continue;
    const pts = marqueePoints(d);
    if (crossing ? polyTouchesRect(pts, rect) : polyEnclosedByRect(pts, rect)) out.push(d.id);
  }
  return out;
}
