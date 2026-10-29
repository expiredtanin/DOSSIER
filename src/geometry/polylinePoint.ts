// Trefferbestimmung für das Stützpunkt-Kontextmenü einer Polylinie: meint ein
// Klick einen vorhandenen ECKPUNKT (→ löschen) oder ein SEGMENT (→ Punkt
// einfügen)? Rein geometrisch, ohne Zoom-/Pixelbezug — der Toleranzradius
// kommt vom Aufrufer (s. `toleranceFor`), damit dieselbe Logik auch in Tests
// ohne Ansicht nutzbar bleibt.
//
// Bogen-Segmente (`bulge`) werden bewusst über ihre SEHNE gemessen: für die
// Frage „welches Segment ist gemeint" reicht das, und der eingefügte Punkt
// landet ohnehin exakt auf dem Bogen (s. `insert_point` im Kern, `grips.rs`).

import type { Vec2 } from "../model/types";

export type PolylineTarget =
  | { kind: "vertex"; index: number; dist: number }
  | { kind: "segment"; segIndex: number; at: Vec2; dist: number };

interface PolylineGeom {
  pts: Vec2[];
  closed: boolean;
}

/** Lotfusspunkt von `p` auf die Strecke a→b (auf die Strecke geklemmt). */
function projectOnSegment(a: Vec2, b: Vec2, p: Vec2): { at: Vec2; dist: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const at = { x: a.x + dx * t, y: a.y + dy * t };
  return { at, dist: Math.hypot(p.x - at.x, p.y - at.y) };
}

/**
 * Toleranz in Modell-Metern, abgeleitet aus der Ausdehnung der Polylinie
 * selbst (2 % der Bounding-Box-Diagonale, mindestens 5 cm) — dadurch
 * zoom-unabhängig und bei kleinen wie grossen Elementen brauchbar, ohne dass
 * das Kontextmenü den Massstab der Ansicht kennen muss.
 */
export function toleranceFor(g: PolylineGeom): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of g.pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return 0.05;
  return Math.max(0.05, Math.hypot(maxX - minX, maxY - minY) * 0.02);
}

/**
 * Nächstes Ziel zum Klickpunkt `p`, oder `null`, wenn nichts innerhalb
 * `maxDist` liegt. Ein Eckpunkt gewinnt gegen ein Segment, sobald er
 * innerhalb der Toleranz liegt — sonst liesse sich ein Punkt, der ja immer
 * auch auf zwei Segmenten liegt, nie zuverlässig treffen.
 */
export function nearestPolylineTarget(
  g: PolylineGeom,
  p: Vec2,
  maxDist: number,
): PolylineTarget | null {
  let best: PolylineTarget | null = null;
  g.pts.forEach((v, index) => {
    const dist = Math.hypot(p.x - v.x, p.y - v.y);
    if (dist <= maxDist && (!best || dist < best.dist)) best = { kind: "vertex", index, dist };
  });
  if (best) return best;

  const n = g.pts.length;
  const segCount = g.closed && n > 2 ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = g.pts[i];
    const b = g.pts[(i + 1) % n];
    const { at, dist } = projectOnSegment(a, b, p);
    if (dist <= maxDist && (!best || dist < best.dist)) {
      best = { kind: "segment", segIndex: i, at, dist };
    }
  }
  return best;
}
