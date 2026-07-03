// Snapping (docs/design/drawing-tools.md §5). Läuft auf jedem Pointer-Move
// BEVOR der Punkt an das Werkzeug geht: sammelt Snap-Kandidaten, wählt den
// besten innerhalb der Bildschirm-Toleranz und liefert Marker-Info.
//
// Phase 2: endpoint · midpoint · intersection · onEdge (Lot) · grid · ortho.
// Prioritäts-Reihenfolge (Vorrang bei nahem Abstand): endpoint > intersection >
// midpoint > onEdge > grid; ortho/Winkelraster ist eine Projektion (überlagert).

import type { Project, Vec2 } from "../model/types";
import { lineIntersect } from "../model/geometry";
import { centroid as roomCentroid } from "../geometry/roomArea";
import type { SnapKind, SnapResult, SnapSettings } from "./types";

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Bildschirm-px-Bonus je Snap-Art: höher = gewinnt knappe Vergleiche. */
const PRIORITY: Record<SnapKind, number> = {
  endpoint: 7,
  intersection: 5,
  midpoint: 3,
  center: 3,
  quadrant: 3,
  onEdge: 0,
  grid: -2,
  ortho: 0,
  extension: 0,
};

export interface SnapInput {
  raw: Vec2;
  project: Project;
  levelId: string;
  visibleCodes: Set<string>;
  settings: SnapSettings;
  draftPoints: Vec2[];
  lastPoint: Vec2 | null;
  pxPerMeter: number;
  shift: boolean;
  ctrl: boolean;
}

/** Eine Strecke als Snap-Quelle (Wandachse oder 2D-Segment). */
type Seg = [Vec2, Vec2];

/** Sammelt alle sichtbaren Strecken des Geschosses (Wandachsen + 2D-Segmente). */
function collectSegments(input: SnapInput): Seg[] {
  const segs: Seg[] = [];
  for (const w of input.project.walls) {
    if (w.floorId !== input.levelId) continue;
    if (!input.visibleCodes.has(w.categoryCode)) continue;
    segs.push([w.start, w.end]);
  }
  for (const d of input.project.drawings2d) {
    if (d.levelId !== input.levelId) continue;
    if (!input.visibleCodes.has(d.categoryCode)) continue;
    const g = d.geom;
    if (g.shape === "line") segs.push([g.a, g.b]);
    else if (g.shape === "polyline") {
      for (let i = 0; i < g.pts.length - 1; i++) segs.push([g.pts[i], g.pts[i + 1]]);
      if (g.closed && g.pts.length > 2) segs.push([g.pts[g.pts.length - 1], g.pts[0]]);
    } else if (g.shape === "rect") {
      const c1 = g.min, c3 = g.max;
      const c2 = { x: g.max.x, y: g.min.y }, c4 = { x: g.min.x, y: g.max.y };
      segs.push([c1, c2], [c2, c3], [c3, c4], [c4, c1]);
    }
  }
  // Bereits gesetzte Draft-Segmente (Polylinie/Wand im Bau).
  for (let i = 0; i < input.draftPoints.length - 1; i++) {
    segs.push([input.draftPoints[i], input.draftPoints[i + 1]]);
  }
  return segs;
}

/** Lotfußpunkt von p auf die Strecke a-b, auf das Segment geklemmt. */
function perpFoot(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return a;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/**
 * Bestimmt den effektiven Snap für den rohen Cursor-Punkt (oder null).
 * Punkt-Snaps haben Vorrang vor Ortho und Raster (Prioritäts-Bonus).
 */
export function computeSnap(input: SnapInput): SnapResult | null {
  const { raw, settings, pxPerMeter, shift, ctrl } = input;
  if (ctrl || !settings.enabled) return null;
  const tolM = settings.tolerancePx / Math.max(pxPerMeter, 1e-6);

  // Bester Kandidat nach (distPx − Prioritäts-Bonus).
  let best: SnapResult | null = null;
  let bestScore = Infinity;
  const consider = (point: Vec2, kind: SnapKind, refA?: Vec2) => {
    const d = dist(point, raw);
    if (d > tolM) return;
    const distPx = d * pxPerMeter;
    const score = distPx - PRIORITY[kind];
    if (score < bestScore) {
      bestScore = score;
      best = { point, kind, distPx, refA };
    }
  };

  const segs =
    settings.midpoint || settings.intersection || settings.onEdge || settings.endpoint
      ? collectSegments(input)
      : [];

  // endpoint (Strecken-Endpunkte + Draft-Knoten + Raum-Stempel-Anker).
  if (settings.endpoint) {
    for (const [a, b] of segs) {
      consider(a, "endpoint");
      consider(b, "endpoint");
    }
    for (const p of input.draftPoints) consider(p, "endpoint");
    // Raum-Stempel-Anker (fixer Anker, sonst Flächenschwerpunkt) des Geschosses.
    for (const room of input.project.rooms ?? []) {
      if (room.floorId !== input.levelId) continue;
      if (!input.visibleCodes.has(room.categoryCode)) continue;
      if (room.boundary.length < 3) continue;
      consider(room.stampAnchor ?? roomCentroid(room.boundary), "endpoint");
    }
  }
  // midpoint.
  if (settings.midpoint) {
    for (const [a, b] of segs) consider(mid(a, b), "midpoint");
  }
  // intersection (paarweise Geraden-Schnitt der Strecken, nahe am Cursor).
  if (settings.intersection) {
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const [a, b] = segs[i];
        const [c, d] = segs[j];
        const x = lineIntersect(a, { x: b.x - a.x, y: b.y - a.y }, c, {
          x: d.x - c.x,
          y: d.y - c.y,
        });
        if (x) consider(x, "intersection");
      }
    }
  }
  // onEdge (Lotfußpunkt auf nahe Strecken; niedrige Priorität).
  if (settings.onEdge) {
    for (const [a, b] of segs) consider(perpFoot(raw, a, b), "onEdge");
  }

  if (best) return best;

  // Ortho / Winkelraster (Projektion relativ zum letzten Punkt).
  if ((settings.ortho || shift) && input.lastPoint) {
    const point = applyAngleConstraint(input.lastPoint, raw, settings.angleStep);
    return { point, kind: "ortho", refA: input.lastPoint, distPx: 0 };
  }

  // Raster.
  if (settings.grid) {
    const g = snapToGrid(raw, settings.gridSize);
    if (dist(g, raw) <= tolM) {
      return { point: g, kind: "grid", distPx: dist(g, raw) * pxPerMeter };
    }
  }

  return null;
}

/** Projiziert `to` auf die nächste erlaubte Richtung vom Punkt `from`. */
export function applyAngleConstraint(from: Vec2, to: Vec2, stepDeg: number): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ang = Math.atan2(dy, dx);
  const step = (stepDeg * Math.PI) / 180;
  const k = Math.round(ang / step) * step;
  const len = Math.hypot(dx, dy);
  return { x: from.x + Math.cos(k) * len, y: from.y + Math.sin(k) * len };
}

/** Rundet einen Punkt auf das Raster (Meter). */
function snapToGrid(p: Vec2, size: number): Vec2 {
  if (!(size > 0)) return p;
  return { x: Math.round(p.x / size) * size, y: Math.round(p.y / size) * size };
}
