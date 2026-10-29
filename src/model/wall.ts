// Wand-Resolver: Versatz der Achse über die Dicke (Referenzlinie). Die vertikale Ausdehnung (UK/OK)
// rechnet der Kern (`model/helpers.rs::heights`; TS: Abfrage `verticalExtents`, `geometry/grips.ts`).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Wall } from "./types";

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
  const half = totalThickness / 2;
  // Freier Fugen-Versatz (Schichttrennlinie als Referenz) übersteuert die
  // benannte Referenzlinie. Auf die Wanddicke geklemmt, damit die Achse nie
  // ausserhalb der Wand landet.
  if (wall.referenceOffset != null) {
    return Math.max(-half, Math.min(half, wall.referenceOffset));
  }
  const ref = wall.referenceLine ?? "center";
  if (ref === "left") return +half;
  if (ref === "right") return -half;
  return 0;
}
