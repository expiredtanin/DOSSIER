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
): Primitive[] {
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxY > bounds.minY)) return [];
  return decodePlanBuf(documentFor(project).queryBin("levelMarkers", [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY])).prims;
}
