// Wand-Resolver: leitet aus den (optionalen) Wand-Attributen die konkreten
// geometrischen Größen ab — Versatz der Achse über die Dicke (Referenzlinie)
// und die vertikale Ausdehnung (UK..OK). Alle Defaults entsprechen exakt dem
// bisherigen Verhalten, sodass bestehende Wände unverändert rendern.
//
// Bezeichner englisch, Kommentare deutsch (CLAUDE.md).

import type { Project, VerticalAnchor, Wall } from "./types";
import { getFloor } from "./types";

/**
 * Versatz der Schichtstapelung entlang der linken Normalen `+n` (leftNormal),
 * sodass die Achse auf der gewünschten Wandfläche liegt. Die Schichten werden
 * normalerweise symmetrisch von `−T/2` (außen, +n-Seite) bis `+T/2` (innen)
 * gestapelt; dieser Versatz wird ZUSÄTZLICH auf jeden Schicht-Offset addiert.
 *
 *   • "center" →  0       (Schichten symmetrisch um die Achse — Default).
 *   • "left"   → +T/2     (Achse auf der +n-/„außen"-Fläche; Wand liegt auf −n).
 *   • "right"  → −T/2     (Achse auf der −n-/„innen"-Fläche; Wand liegt auf +n).
 *
 * Die Schicht-Offsets laufen von −T/2 (= +n außen) nach +T/2 (= −n innen).
 * Für "left" soll die −T/2-Kante (außen) auf der Achse liegen → +T/2 addieren,
 * sodass die Schichten von 0…T (alle auf der −n-Seite) liegen.
 */
export function wallReferenceOffset(
  wall: Wall,
  totalThickness: number,
): number {
  const ref = wall.referenceLine ?? "center";
  const half = totalThickness / 2;
  if (ref === "left") return +half;
  if (ref === "right") return -half;
  return 0;
}

/** Löst einen VerticalAnchor zu einem absoluten Z (Meter) auf oder `null`. */
function resolveAnchor(
  project: Project,
  anchor: VerticalAnchor | undefined,
): number | null {
  if (!anchor) return null;
  if (anchor.mode === "custom") return anchor.z;
  // "floor": baseElevation des gebundenen Geschosses (+ optionalem Offset).
  const floor = project.drawingLevels.find((z) => z.id === anchor.floorId);
  if (!floor) return null;
  return (floor.baseElevation ?? 0) + (anchor.offset ?? 0);
}

/**
 * Vertikale Ausdehnung der Wand (absolute Z-Werte in Metern).
 *   • zBottom: aus `wall.bottom`, sonst baseElevation des Wand-Geschosses
 *     (= heutiges Verhalten).
 *   • zTop:    aus `wall.top`, sonst `zBottom + wall.height` (= heute).
 * Sind beide UK/OK ungesetzt, liefert dies exakt `[baseElevation, base+height]`.
 */
export function wallVerticalExtent(
  project: Project,
  wall: Wall,
): { zBottom: number; zTop: number } {
  // Geschoss-baseElevation als Default-UK (heutiges Verhalten). Fehlt das
  // Geschoss, 0 als sicherer Rückfall.
  let floorBase = 0;
  try {
    floorBase = getFloor(project, wall.floorId).baseElevation ?? 0;
  } catch {
    floorBase = 0;
  }
  const zBottom = resolveAnchor(project, wall.bottom) ?? floorBase;
  const zTop = resolveAnchor(project, wall.top) ?? zBottom + wall.height;
  return { zBottom, zTop };
}

/**
 * Das Geschoss DIREKT ÜBER dem Wand-Geschoss (in Dokumentreihenfolge der
 * "floor"-Ebenen) oder `undefined`, wenn die Wand im obersten Geschoss liegt.
 * Dient der „Verknüpfung zum oberen Geschoss" (OK an nächstes Geschoss binden).
 */
export function nextFloorAbove(
  project: Project,
  wall: Wall,
): { id: string; name: string } | undefined {
  const floors = project.drawingLevels.filter((z) => z.kind === "floor");
  const idx = floors.findIndex((z) => z.id === wall.floorId);
  if (idx < 0) return undefined;
  const above = floors[idx + 1];
  return above ? { id: above.id, name: above.name } : undefined;
}
