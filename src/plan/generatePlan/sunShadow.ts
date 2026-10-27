// Schattenstudie im Grundriss ([64]/[59]): Boden-Schatten zum Zeitpunkt `Project.sunStudy.when`
// als halbtransparente Flächen ZUUNTERST, nur im Geschoss nächst ±0.00 (der Schatten liegt auf
// z = 0). Rechnung in `analysis/sun.ts`; Löcher (Höfe) werden für das Plan-Primitiv zerlegt.

import type { Project } from "../../model/types";
import { projectLatLon, shadowPolygons, sunPosition, withoutHoles } from "../../analysis/sun";
import { NO_HATCH, type Primitive } from "./shared";

/** Füllfarbe der Schattenflächen (Erkennungsmerkmal in Tests). */
export const SUN_SHADOW_FILL = "#3a4a66";
const SUN_SHADOW_OPACITY = 0.28;

/** Geschoss, auf dem der Boden-Schatten erscheint: Basishöhe am nächsten bei 0. */
export function groundFloorId(project: Project): string | null {
  let best: { id: string; d: number } | null = null;
  for (const l of project.drawingLevels) {
    if (l.kind !== "floor") continue;
    const d = Math.abs(l.baseElevation ?? 0);
    if (!best || d < best.d) best = { id: l.id, d };
  }
  return best?.id ?? null;
}

/** Hängt die Schattenflächen an `out` an (nichts ohne aktive Studie, nachts oder auf anderen Geschossen). */
export function addSunShadow(out: Primitive[], project: Project, floorId: string): void {
  const study = project.sunStudy;
  if (!study?.show || groundFloorId(project) !== floorId) return;
  const when = new Date(study.when);
  if (Number.isNaN(when.getTime())) return;
  const { lat, lon } = projectLatLon(project);
  for (const poly of shadowPolygons(project, sunPosition(lat, lon, when))) {
    for (const pts of withoutHoles(poly)) {
      out.push({
        kind: "polygon",
        pts,
        fill: SUN_SHADOW_FILL,
        stroke: "none",
        strokeWidthMm: 0,
        hatch: NO_HATCH,
        opacity: SUN_SHADOW_OPACITY,
      });
    }
  }
}
