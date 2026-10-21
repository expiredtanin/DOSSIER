// Automatische Höhenkoten im Schnitt/in der Ansicht: je Geschoss die Kote
// OK fertig Boden (`baseElevation`, ±0.00 = Bezug) plus die oberste Kante des
// Gebäudes (First/OK Dach), links neben der Zeichnung mit einer kurzen
// Bezugslinie zur Geometrie. Symbol = dieselbe SIA-400-Kote wie das 2D-Element
// `kote` (`pushKote`). Abschaltbar je Ebene (`DrawingLevel.levelMarks`).

import type { DrawingLevel, Project } from "../model/types";
import { pushKote } from "./generatePlan/drawing2d";
import type { Primitive } from "./generatePlan";

const INK = "#1f242c";
/** Abstand der Kote links von der Zeichnung (Meter). */
const MARK_OFFSET_M = 1.2;
/** Länge der Bezugslinie (Meter, endet knapp vor der Zeichnung). */
const LEADER_GAP_M = 0.15;

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
  const x = bounds.minX - MARK_OFFSET_M;
  const heights: number[] = [];
  const pushH = (z: number) => {
    if (z < bounds.minY - 1e-6 || z > bounds.maxY + 1e-6) return;
    if (heights.some((h) => Math.abs(h - z) < 0.05)) return;
    heights.push(z);
  };
  for (const l of project.drawingLevels) {
    if (l.kind === "floor" && l.baseElevation !== undefined) pushH(l.baseElevation);
  }
  pushH(bounds.maxY);
  const out: Primitive[] = [];
  for (const z of heights) {
    out.push({
      kind: "line",
      a: { x: x - 0.3, y: z },
      b: { x: bounds.minX - LEADER_GAP_M, y: z },
      cls: "section-level-leader",
      weightMm: 0.13,
      color: INK,
    });
    pushKote(out, { x, y: z }, Math.round(z * 100) / 100, "okFertig", INK, 0.18, false);
  }
  return out;
}
