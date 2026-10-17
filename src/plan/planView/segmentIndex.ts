// Uniformes Raster über die 'line'-Primitive eines Plans (Modell-Meter), damit
// Nächstes-Segment-Abfragen unter dem Cursor nur die Segmente der umliegenden
// Zellen prüfen statt ALLE Primitive. Ein Kataster-Import liefert 3,7 Mio.
// Segmente; die frühere lineare Suche lief bei JEDER Mausbewegung über alle.
//
// Speicher als CSR (Zell-Offsets + flacher Index-Array, Typed Arrays) statt
// eines Arrays pro Zelle: Millionen kleiner JS-Arrays wären selbst teuer.

import type { Vec2 } from "../../model/types";
import type { Primitive } from "../generatePlan";

export interface SegmentIndex {
  minX: number;
  minY: number;
  cell: number;
  cols: number;
  rows: number;
  /** cellStart[c]..cellStart[c+1] = Bereich in `items` für Zelle c. */
  cellStart: Uint32Array;
  /** Primitiv-Indizes, nach Zelle gruppiert. */
  items: Uint32Array;
  /** Segmente, deren Bounding-Box zu viele Zellen überdeckt — immer geprüft. */
  long: Uint32Array;
}

/** Ziel: im Mittel so viele Segmente je Zelle. */
const TARGET_PER_CELL = 8;
/** Obergrenze der Zellzahl (Speicher für `cellStart`). */
const MAX_CELLS = 4_000_000;
/** Ab so vielen überdeckten Zellen landet ein Segment in `long` statt im Raster. */
const MAX_CELLS_PER_SEGMENT = 1024;

/** Ob ein Primitiv in den Index gehört (2D-Zeichenlinien, s. Hover-Teilpunkte). */
const indexed = (p: Primitive): p is Extract<Primitive, { kind: "line" }> =>
  p.kind === "line" && !!p.drawingId;

export function buildSegmentIndex(prims: readonly Primitive[]): SegmentIndex | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let n = 0;
  for (const p of prims) {
    if (!indexed(p)) continue;
    n++;
    minX = Math.min(minX, p.a.x, p.b.x);
    maxX = Math.max(maxX, p.a.x, p.b.x);
    minY = Math.min(minY, p.a.y, p.b.y);
    maxY = Math.max(maxY, p.a.y, p.b.y);
  }
  if (n === 0) return null;

  const w = Math.max(maxX - minX, 1e-6);
  const h = Math.max(maxY - minY, 1e-6);
  const cellCount = Math.min(MAX_CELLS, Math.max(1, Math.ceil(n / TARGET_PER_CELL)));
  let cell = Math.sqrt((w * h) / cellCount);
  if (!(cell > 0)) cell = Math.max(w, h);
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(h / cell));

  const cx = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cell)));
  const cy = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cell)));

  // Zwei Durchläufe (zählen, dann füllen) — jedes Segment landet in jeder Zelle,
  // die seine Bounding-Box berührt.
  const counts = new Uint32Array(cols * rows + 1);
  const long: number[] = [];
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    if (!indexed(p)) continue;
    const x0 = cx(Math.min(p.a.x, p.b.x)), x1 = cx(Math.max(p.a.x, p.b.x));
    const y0 = cy(Math.min(p.a.y, p.b.y)), y1 = cy(Math.max(p.a.y, p.b.y));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_SEGMENT) {
      long.push(i);
      continue;
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) counts[y * cols + x + 1]++;
  }
  const longSet = new Set(long);
  for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
  const cellStart = counts;
  const fill = cellStart.slice(0, cols * rows);
  const items = new Uint32Array(cellStart[cols * rows]);
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    if (!indexed(p) || longSet.has(i)) continue;
    const x0 = cx(Math.min(p.a.x, p.b.x)), x1 = cx(Math.max(p.a.x, p.b.x));
    const y0 = cy(Math.min(p.a.y, p.b.y)), y1 = cy(Math.max(p.a.y, p.b.y));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) items[fill[y * cols + x]++] = i;
  }
  return { minX, minY, cell, cols, rows, cellStart, items, long: Uint32Array.from(long) };
}

export function pointSegDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Nächstes indiziertes Segment zu `m` (Modell-Meter) mit Abstand < `maxDist`
 * (Modell-Meter), oder null. Liefert den Primitiv-Index.
 */
export function nearestSegment(
  index: SegmentIndex,
  prims: readonly Primitive[],
  m: Vec2,
  maxDist: number,
): number | null {
  const { minX, minY, cell, cols, rows, cellStart, items, long } = index;
  let best: number | null = null;
  let bestDist = maxDist;
  const consider = (i: number) => {
    const p = prims[i] as Extract<Primitive, { kind: "line" }>;
    const d = pointSegDist(m, p.a, p.b);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  };
  for (const i of long) consider(i);
  const x0 = Math.floor((m.x - maxDist - minX) / cell);
  const x1 = Math.floor((m.x + maxDist - minX) / cell);
  const y0 = Math.floor((m.y - maxDist - minY) / cell);
  const y1 = Math.floor((m.y + maxDist - minY) / cell);
  if (x1 < 0 || y1 < 0 || x0 >= cols || y0 >= rows) return best;
  for (let y = Math.max(0, y0); y <= Math.min(rows - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(cols - 1, x1); x++) {
      const c = y * cols + x;
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) consider(items[k]);
    }
  }
  return best;
}
