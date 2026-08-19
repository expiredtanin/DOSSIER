// Wand-Trefferprüfung im Modellraum fürs Grundriss-Kontextmenü — reine
// Geometrie-Helfer ohne Komponenten-Bezug, ausgelagert aus App.tsx.

import type { Project, Vec2 } from "../model/types";
import { getWallType, wallTypeThickness } from "../model/types";
import { wallCorners } from "../model/geometry";

/**
 * Liefert die ID der obersten Wand, deren (gehrtes) Band den Modellpunkt
 * enthält — gefiltert auf das aktive Geschoss + sichtbare Kategorien, in
 * umgekehrter Wand-Reihenfolge (zuletzt gezeichnet zuerst). Spiegelt die
 * Trefferlogik der PlanView, arbeitet aber direkt auf den Wand-Polygonen, da
 * das Grundriss-Kontextmenü nur den Modellpunkt kennt. `null` bei Leerraum.
 */
export function hitTestWall(
  project: Project,
  floorId: string,
  visibleCodes: Set<string>,
  m: Vec2,
): string | null {
  const walls = project.walls.filter(
    (w) => w.floorId === floorId && visibleCodes.has(w.categoryCode),
  );
  for (let i = walls.length - 1; i >= 0; i--) {
    const w = walls[i];
    const thickness = wallTypeThickness(getWallType(project, w));
    const corners = wallCorners(w.start, w.end, thickness);
    if (pointInPoly(m, corners)) return w.id;
  }
  return null;
}

/** Punkt-in-Polygon (Ray-Casting) im Modellraum — wie in der PlanView. */
export function pointInPoly(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
