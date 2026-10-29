// Übersetzt einen `ExtrudedSolid` des Projekts in eine B-Rep-Spezifikation (`SolidSpec`,
// truck/trucksolid). Gemeinsame Quelle für den 3D-Viewer (Eckenradius, Grundkörper) und den
// STEP-Export; die Beschreibung rechnet der Rust-Kern.

import type { ExtrudedSolid } from "../model/types";
import type { SolidSpec } from "../engine/truckSolid";
import { core } from "../engine/coreWasm";
import { fromMarkedJson, toMarkedJson } from "../core/ops";

/**
 * Ob der Körper über den B-Rep-Pfad (`buildSolidMesh`) gebaut werden muss: Grundkörper
 * (`brep`) und Profile mit Eckenradius. Alles andere nutzt weiter die Prisma-Extrusion
 * (`extrudePolygon`/`extrudeCircle`) — bitgleich zum bisherigen Verhalten.
 */
export function needsBrepPath(solid: ExtrudedSolid): boolean {
  if (solid.brep) return true;
  const rounded = (solid.cornerRadius ?? 0) > 1e-9 || (solid.chamfer ?? 0) > 1e-9;
  return rounded && !solid.circle && (solid.taper ?? 0) < 1e-6;
}

/**
 * B-Rep-Spezifikation des Körpers, UK auf `baseZ` (Rust-Kern, `cmd_solid.rs::extruded_solid_spec`:
 * Grundkörper verschoben, Zylinder/Kegel bei Kreis-Profil, Extrusion mit Eckenradius/Fase, Loft bei
 * Verjüngung). `null`, wenn truck dafür (noch) keine Beschreibung hat (Pyramide: Spitze als B-Rep entartet).
 */
export function extrudedSolidSpec(solid: ExtrudedSolid, floorZ: number): SolidSpec | null {
  const out = core().extruded_solid_spec_json(toMarkedJson(solid), floorZ);
  return out ? fromMarkedJson<SolidSpec>(out) : null;
}
