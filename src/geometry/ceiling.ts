// Geometrie-Helfer für Decken (Slabs) — reine Funktionen über `Vec2`, kein
// externer Kernel. Eine Decke ist ein GESCHLOSSENER Umriss (Polygon) plus eine
// Dicke; diese Helfer normalisieren den Umriss, berechnen Fläche/Umriss-Prüfung
// und liefern eine extrude-fertige Form. Baut auf kernel2d/model/geometry auf.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Vec2 } from "../model/types";
import { signedArea, isCCW, vecEqual } from "./kernel2d";

/** Kleinste sinnvolle Deckenfläche (m²) — darunter gilt der Umriss als entartet. */
export const MIN_CEILING_AREA = 1e-4;

/**
 * Normalisiert einen Deckenumriss:
 *   • entfernt aufeinanderfolgende (nahezu) gleiche Punkte,
 *   • entfernt einen schließenden Duplikat-Endpunkt (pts[last] == pts[0]),
 *   • erzwingt CCW-Wicklung (positive Fläche) — konsistent für Plan-Füllung und
 *     3D-Extrusion.
 * Liefert `null`, wenn nach der Bereinigung < 3 Punkte übrig bleiben (kein
 * gültiges Polygon).
 */
export function normalizeOutline(pts: Vec2[]): Vec2[] | null {
  const clean: Vec2[] = [];
  for (const p of pts) {
    if (clean.length === 0 || !vecEqual(clean[clean.length - 1], p)) clean.push(p);
  }
  // Schließenden Duplikat-Endpunkt verwerfen.
  if (clean.length > 1 && vecEqual(clean[0], clean[clean.length - 1])) clean.pop();
  if (clean.length < 3) return null;
  // CCW erzwingen.
  return isCCW(clean) ? clean : clean.slice().reverse();
}

/** Fläche eines Deckenumrisses in m² (immer positiv). */
export function ceilingArea(pts: Vec2[]): number {
  return Math.abs(signedArea(pts));
}

/**
 * Punkt-in-Polygon-Test (Ray-Casting) für einen geschlossenen Umriss — dient dem
 * Body-Select einer Decke im Grundriss/3D. Randpunkte gelten als innen genug.
 */
export function pointInOutline(p: Vec2, outline: Vec2[]): boolean {
  let inside = false;
  const n = outline.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = outline[i];
    const b = outline[j];
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}
