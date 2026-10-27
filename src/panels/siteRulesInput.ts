// Übernahme von Parzellengrenze und Baulinien aus gezeichneter 2D-Geometrie (Lage-Panel, [63]).

import type { Drawing2D, Vec2 } from "../model/types";

/** Geschlossene Polylinie oder Rechteck → Parzellenring; sonst `null`. */
export function parcelFromDrawing(d: Drawing2D | undefined): Vec2[] | null {
  const g = d?.geom;
  if (!g) return null;
  if (g.shape === "rect") {
    return [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }];
  }
  if (g.shape === "polyline" && g.closed && g.pts.length >= 3) {
    // Doppelter Schlusspunkt (manche Importe) weglassen.
    const pts = g.pts.slice();
    const f = pts[0], l = pts[pts.length - 1];
    if (pts.length > 3 && Math.hypot(f.x - l.x, f.y - l.y) < 1e-9) pts.pop();
    return pts.map((p) => ({ x: p.x, y: p.y }));
  }
  return null;
}

/** Linie, Hilfslinie, Strahl oder zweipunktige Polylinie → Baulinie; sonst `null`. */
export function lineFromDrawing(d: Drawing2D | undefined): { a: Vec2; b: Vec2 } | null {
  const g = d?.geom;
  if (!g) return null;
  if (g.shape === "line" || g.shape === "xline" || g.shape === "ray") return { a: { ...g.a }, b: { ...g.b } };
  if (g.shape === "polyline" && !g.closed && g.pts.length === 2) return { a: { ...g.pts[0] }, b: { ...g.pts[1] } };
  return null;
}
