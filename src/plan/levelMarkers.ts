// Automatische Höhenkoten im Schnitt/in der Ansicht: je Geschoss die Kote
// OK fertig Boden (`baseElevation`, ±0.00 = Bezug) plus die oberste Kante des
// Gebäudes (First/OK Dach), links neben der Zeichnung mit einer kurzen
// Bezugslinie zur Geometrie. Symbol = dieselbe SIA-400-Kote wie das 2D-Element
// `kote`; gerechnet im Kern (`plan/drawings.rs::level_markers`, Abfrage `levelMarkers`).
// Abschaltbar je Ebene (`DrawingLevel.levelMarks`).

import type { DrawingLevel, Project } from "../model/types";
import type { Primitive } from "./generatePlan";
import { documentFor } from "../core/document";
import { decodePlanBuf } from "./planBuf";

/** Ob eine Ebene automatische Koten trägt (Default an). */
export function levelMarksEnabled(level: DrawingLevel): boolean {
  return level.levelMarks !== false;
}

/**
 * Kote-Primitive für eine Zeichnung mit den Grenzen `bounds` (u, Höhe). Höhen
 * ausserhalb der Zeichnung (Geschosse, die der Schnitt nicht zeigt) entfallen.
 */
export function levelMarkerPrimitives(
  project: Project,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  primitives?: readonly Primitive[],
): Primitive[] {
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxY > bounds.minY)) return [];
  const minX = primitives ? Math.max(bounds.minX, builtMinX(project, primitives)) : bounds.minX;
  return decodePlanBuf(documentFor(project).queryBin("levelMarkers", [minX < bounds.maxX ? minX : bounds.minX, bounds.minY, bounds.maxX, bounds.maxY])).prims;
}

// [171] Gelände (Schnittfläche, Profil- und Grundlinie) zählt nicht zur Lage der Koten: sie stehen neben dem
// Gebauten (Haus, Carport, Körper), nicht links vom ganzen Geländeschnitt (Musterhaus komplex: ~15 m weiter).
const TERRAIN_CLS = new Set(["section-terrain", "elevation-terrain", "section-ground", "elevation-ground"]);

function builtMinX(project: Project, primitives: readonly Primitive[]): number {
  const site = new Set((project.context ?? []).filter((c) => c.type === "terrainMesh" || c.type === "excavation" || c.type === "contourSet").map((c) => c.id));
  let minX = Infinity;
  for (const q of primitives) {
    if (q.kind === "line") {
      if (!TERRAIN_CLS.has(q.cls)) minX = Math.min(minX, q.a.x, q.b.x);
    } else if (q.kind === "polygon") {
      if (!(q.contextObjectId && site.has(q.contextObjectId))) for (const v of q.pts) minX = Math.min(minX, v.x);
    }
  }
  return minX;
}
