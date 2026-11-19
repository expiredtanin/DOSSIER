// [279] Griffe eines Geländers im Grundriss: jeder Punkt der Achse (verschieben). Die Punkte folgen dem Modell
// (`Railing.points`); ein Ziehen ersetzt genau diesen Punkt, Höhe, Art und Teilung bleiben. [291] An Treppe oder
// Deckenkante gebundene Geländer haben keine Griffe (die Achse folgt dem Träger; lösen in der Objekt-Info).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Railing, Vec2 } from "../model/types";

/** An Treppe oder Deckenkante gebunden ([291]): die Achse leitet der Kern ab, Griffe gäbe es nur zum Schein. */
const isBound = (r: Railing): boolean => !!r.stairId || !!r.ceilingId;

/** Griff-Punkte: alle Punkte der Achse in Reihenfolge; gebundene Geländer haben keine ([291], die Achse folgt dem Träger). */
export function railingGripPoints(r: Railing): Vec2[] {
  if (isBound(r)) return [];
  return r.points.map((p) => ({ x: p.x, y: p.y }));
}

/** Änderung beim Ziehen des Griffs `index` an `pt`; unbekannter Index ändert nichts. */
export function railingGripPatch(r: Railing, index: number, pt: Vec2): Partial<Railing> {
  if (isBound(r) || !Number.isFinite(pt.x) || !Number.isFinite(pt.y) || index < 0 || index >= r.points.length) return {};
  return { points: r.points.map((p, i) => (i === index ? { x: pt.x, y: pt.y } : p)) };
}
