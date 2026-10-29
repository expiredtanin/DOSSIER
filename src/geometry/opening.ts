// Geometrie-Helfer für Öffnungen (Fenster/Türen) — reine Funktionen, die eine
// `Opening` relativ zu ihrer Wirts-Wand in konkrete Welt-Geometrie auflösen:
//   • die Öffnungs-Lücke entlang der Wandachse (from/to in Metern), die Pfosten.
//   (Die vertikale Lage rechnet der Kern: `model3d.rs`/`plan/section.rs`, UK/OK der Wand: `model/helpers.rs::heights`.)
//
// Da JEDE Größe aus der aktuellen Wandachse (`wall.start`/`wall.end`) abgeleitet
// wird, folgt eine Öffnung ihrer Wand automatisch, sobald die Wand bewegt wird —
// es gibt keine eingebackenen Weltkoordinaten.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Opening, Vec2, Wall } from "../model/types";
import { along } from "../model/geometry";

/** Achslänge einer Wand (Meter). */
export function wallAxisLength(wall: Wall): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
}

/**
 * Öffnungs-Intervall entlang der Wandachse (from..to in Metern), auf die
 * Achslänge geklemmt. Liefert null, wenn das Intervall entartet (Breite ≤ 0 oder
 * vollständig außerhalb der Achse).
 */
export function openingInterval(
  wall: Wall,
  o: Opening,
): { from: number; to: number } | null {
  const axis = wallAxisLength(wall);
  const from = Math.max(0, Math.min(o.position, axis));
  const to = Math.max(from, Math.min(o.position + o.width, axis));
  if (to - from < 1e-4) return null;
  return { from, to };
}

/** Die beiden Pfosten-Punkte (auf der Achse) einer Öffnung im Grundriss. */
export function openingJambs(
  wall: Wall,
  o: Opening,
): { jambStart: Vec2; jambEnd: Vec2 } | null {
  const iv = openingInterval(wall, o);
  if (!iv) return null;
  return {
    jambStart: along(wall.start, wall.end, iv.from),
    jambEnd: along(wall.start, wall.end, iv.to),
  };
}

