// [193] Maus-Ziehen von Gelände-/Umgebungs-Elementen im Plan: Bezugspunkt für den Fang.
// Das Verschieben selbst (Ops) und die Vorschau stammen aus dem Kern (`cmd_transform.rs`).

import type { Project, Vec2 } from "../model/types";

/** Ein Punkt des Elements (erste Ecke / erster Punkt / Rahmen-Ecke), der beim Ziehen am Fang teilnimmt. */
export function contextAnchor(project: Project, id: string): Vec2 | null {
  const o = (project.context ?? []).find((c) => c.id === id);
  if (!o) return null;
  switch (o.type) {
    case "excavation":
      return o.outline[0] ?? null;
    case "contourSet":
      return o.contours.find((c) => c.pts.length > 0)?.pts[0] ?? null;
    case "terrainMesh":
    case "importedMesh":
      return o.positions.length >= 2 ? { x: o.positions[0], y: o.positions[1] } : null;
    case "image":
      return o.min;
    default:
      return null;
  }
}
