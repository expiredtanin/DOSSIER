// Zugriff auf die kompakte Linien-Unterlage (`Plan.underlay`) für Hover, Klick-
// Auswahl und Marquee. Die Linien existieren dort nicht als Primitive, deshalb
// arbeiten diese Funktionen direkt auf den `Drawing2D`-Geometrien — mit einem
// Raster über die Zeichnungs-Bounding-Boxen, damit eine Abfrage nur die
// Zeichnungen in Cursornähe prüft (nicht alle ~10^5).

import type { Drawing2D, Vec2 } from "../../model/types";
import type { ModelRect } from "./geometry";
import { polyEnclosedByRect, polyTouchesRect } from "./geometry";
import { drawingBox } from "../../geometry/drawingBounds";
import { forEachSegment } from "../../geometry/drawingIndex";
export { buildDrawingIndex, nearestInDrawings, type DrawingIndex } from "../../geometry/drawingIndex";

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
