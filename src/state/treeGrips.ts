// [149] Griffe eines Baums im Grundriss: Stammmitte (verschieben), Kronenrand (Durchmesser) und — mit gezeigter
// Beschriftung — linker Rand der Beschriftung (`labelOffset` ab Stammmitte, Kern `plan/trees.rs::tree_label`).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Tree, Vec2 } from "../model/types";

/** Beschriftung sichtbar (wie der Kern: `showLabel` und eine nicht leere Art). */
function labelShown(tr: Tree): boolean {
  return tr.showLabel === true && (tr.species ?? "").trim() !== "";
}

/** Griff-Punkte: Stammmitte, Kronenrand, ggf. Beschriftung (Vorgabe: 1 mm Papier rechts neben dem Stamm). */
export function treeGripPoints(tr: Tree, scaleDenominator: number): Vec2[] {
  const pts: Vec2[] = [tr.position, { x: tr.position.x + tr.crownDiameter / 2, y: tr.position.y }];
  if (labelShown(tr)) {
    const o = tr.labelOffset ?? { x: tr.trunkDiameter / 2 + scaleDenominator / 1000, y: 0 };
    pts.push({ x: tr.position.x + o.x, y: tr.position.y + o.y });
  }
  return pts;
}

/** Änderung beim Ziehen des Griffs `index` an `pt`. */
export function treeGripPatch(tr: Tree, index: number, pt: Vec2): Partial<Tree> {
  if (index === 0) return { position: { x: pt.x, y: pt.y } };
  if (index === 1) return { crownDiameter: Math.max(0.2, 2 * Math.hypot(pt.x - tr.position.x, pt.y - tr.position.y)) };
  return { labelOffset: { x: pt.x - tr.position.x, y: pt.y - tr.position.y } };
}
