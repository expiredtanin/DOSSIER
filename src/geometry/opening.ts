// Geometrie-Helfer für Öffnungen (Fenster/Türen) — reine Funktionen, die eine
// `Opening` relativ zu ihrer Wirts-Wand in konkrete Welt-Geometrie auflösen:
//   • die Öffnungs-Lücke entlang der Wandachse (from/to in Metern),
//   • die vertikale Lage (UK/OK der Öffnung, absolut in Metern).
//
// Da JEDE Größe aus der aktuellen Wandachse (`wall.start`/`wall.end`) abgeleitet
// wird, folgt eine Öffnung ihrer Wand automatisch, sobald die Wand bewegt wird —
// es gibt keine eingebackenen Weltkoordinaten.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Opening, Project, Vec2, Wall } from "../model/types";
import { along, leftNormal, normalize, sub } from "../model/geometry";
import { wallVerticalExtent } from "../model/wall";

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

/**
 * Vertikale Lage einer Öffnung (absolute Z-Werte in Metern) relativ zur Wand-UK.
 * Türen sitzen am Boden (sillHeight 0); Fenster ab Brüstung. Die OK wird auf die
 * Wand-OK geklemmt, damit die Öffnung nie über den Wandkopf hinausragt.
 */
export function openingVerticalExtent(
  project: Project,
  wall: Wall,
  o: Opening,
): { zBottom: number; zTop: number } {
  const { zBottom, zTop } = wallVerticalExtent(project, wall);
  const sill = Math.max(0, o.sillHeight);
  const oBottom = zBottom + sill;
  const oTop = Math.min(zTop, oBottom + o.height);
  return { zBottom: oBottom, zTop: oTop };
}

/** Einheits-Laufrichtung (u) und linke Normale (n) der Wandachse. */
export function wallAxisFrame(wall: Wall): { u: Vec2; n: Vec2 } {
  const u = normalize(sub(wall.end, wall.start));
  return { u, n: leftNormal(u) };
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

/** Mittelpunkt einer Öffnung im Grundriss (Achse) — für HUD/Auswahl-Anker. */
export function openingCenter(wall: Wall, o: Opening): Vec2 | null {
  const iv = openingInterval(wall, o);
  if (!iv) return null;
  return along(wall.start, wall.end, (iv.from + iv.to) / 2);
}
