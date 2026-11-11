// Übersetzt einen `ExtrudedSolid` des Projekts in eine B-Rep-Spezifikation (`SolidSpec`,
// truck/trucksolid) für die Kollisionsprüfung; die Beschreibung rechnet der Rust-Kern (dieselbe, aus der er die
// Körper-Netze für Grundriss, Schnitt, Ansicht und 3D baut, `solid_mesh.rs`, und die STEP-Spezifikationen).

import type { ExtrudedSolid } from "../model/types";
import type { SolidSpec } from "../engine/truckSolid";
import { core } from "../engine/coreWasm";
import { fromMarkedJson, toMarkedJson } from "../core/ops";

/**
 * B-Rep-Spezifikation des Körpers, UK auf `baseZ` (Rust-Kern, `cmd_solid.rs::extruded_solid_spec`:
 * Grundkörper verschoben, Zylinder/Kegel bei Kreis-Profil, Extrusion mit Eckenradius/Fase, Loft bei
 * Verjüngung, Pyramide als Netz). `null` ohne Körper (Höhe ≤ 0, zu wenig Punkte).
 */
export function extrudedSolidSpec(solid: ExtrudedSolid, floorZ: number): SolidSpec | null {
  const out = core().extruded_solid_spec_json(toMarkedJson(solid), floorZ);
  return out ? fromMarkedJson<SolidSpec>(out) : null;
}
