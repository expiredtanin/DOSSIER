// [279] Griffe eines Geländers im Grundriss: jeder Punkt der Achse (verschieben). Die Punkte folgen dem Modell
// (`Railing.points`); ein Ziehen ersetzt genau diesen Punkt, Höhe, Art und Teilung bleiben.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Railing, Vec2 } from "../model/types";

/** Griff-Punkte: alle Punkte der Achse in Reihenfolge. */
export function railingGripPoints(r: Railing): Vec2[] {
  return r.points.map((p) => ({ x: p.x, y: p.y }));
}

/** Änderung beim Ziehen des Griffs `index` an `pt`; unbekannter Index ändert nichts. */
export function railingGripPatch(r: Railing, index: number, pt: Vec2): Partial<Railing> {
  if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y) || index < 0 || index >= r.points.length) return {};
  return { points: r.points.map((p, i) => (i === index ? { x: pt.x, y: pt.y } : p)) };
}
