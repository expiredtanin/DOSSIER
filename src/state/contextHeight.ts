// [193] Höhe von Gelände-/Umgebungs-Elementen ändern: Höhenversatz (alle z um dz) und die Höhe einer einzelnen
// Höhenlinie. Liefert Feld-Patches für `patchContextObject`; `null` = Art ohne Höhe (Luftbild) oder keine Änderung.

import type { ContextObject, Contour } from "../model/types";

/** Alle Höhen des Elements um `dz` Meter versetzen: Netz-z, Höhenlinien-z, Baugruben-Sohle. */
export function heightOffsetPatch(obj: ContextObject, dz: number): Record<string, unknown> | null {
  if (!Number.isFinite(dz) || dz === 0) return null;
  switch (obj.type) {
    case "terrainMesh":
    case "importedMesh": {
      const pos = obj.positions.slice();
      for (let i = 2; i < pos.length; i += 3) pos[i] += dz;
      return { positions: pos };
    }
    case "contourSet":
      return { contours: obj.contours.map((c): Contour => ({ ...c, z: c.z + dz })) };
    case "excavation":
      return { bottom: obj.bottom + dz };
    default:
      return null;
  }
}

/** Höhe der Höhenlinie `index` eines Höhenlinien-Satzes setzen. */
export function contourHeightPatch(obj: ContextObject, index: number, z: number): Record<string, unknown> | null {
  if (obj.type !== "contourSet" || !Number.isFinite(z) || !obj.contours[index] || obj.contours[index].z === z) return null;
  return { contours: obj.contours.map((c, i): Contour => (i === index ? { ...c, z } : c)) };
}
