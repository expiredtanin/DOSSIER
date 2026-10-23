// Übersetzt einen `ExtrudedSolid` des Projekts in eine B-Rep-Spezifikation (`SolidSpec`,
// truck/trucksolid). Gemeinsame Quelle für den 3D-Viewer (Eckenradius, Grundkörper) und den
// STEP-Export — reiner Kern, kein WASM.

import type { ExtrudedSolid } from "../model/types";
import type { SolidSpec } from "../engine/truckSolid";

/**
 * Ob der Körper über den B-Rep-Pfad (`buildSolidMesh`) gebaut werden muss: Grundkörper
 * (`brep`) und Profile mit Eckenradius. Alles andere nutzt weiter die Prisma-Extrusion
 * (`extrudePolygon`/`extrudeCircle`) — bitgleich zum bisherigen Verhalten.
 */
export function needsBrepPath(solid: ExtrudedSolid): boolean {
  if (solid.brep) return true;
  return (solid.cornerRadius ?? 0) > 1e-9 && !solid.circle && (solid.taper ?? 0) < 1e-6;
}

/**
 * B-Rep-Spezifikation des Körpers, UK auf `baseZ`. `null`, wenn truck dafür (noch) keine
 * Beschreibung hat (Pyramide: Spitze als B-Rep entartet).
 */
export function extrudedSolidSpec(solid: ExtrudedSolid, baseZ: number): SolidSpec | null {
  if (solid.brep) {
    const p0 = solid.points[0];
    const dx = p0 ? p0.x - solid.brep.origin.x : 0;
    const dy = p0 ? p0.y - solid.brep.origin.y : 0;
    return { kind: "translate", v: [dx, dy, baseZ], solid: solid.brep.spec as unknown as SolidSpec };
  }
  if (solid.points.length < 3 || solid.height <= 0) return null;
  const taper = Math.min(1, Math.max(0, solid.taper ?? 0));
  if (solid.circle && taper < 1e-6) {
    return {
      kind: "cylinder",
      cx: solid.circle.center.x,
      cy: solid.circle.center.y,
      z0: baseZ,
      r: solid.circle.r,
      height: solid.height,
    };
  }
  if (solid.circle && taper >= 1 - 1e-6) {
    return {
      kind: "cone",
      cx: solid.circle.center.x,
      cy: solid.circle.center.y,
      z0: baseZ,
      r: solid.circle.r,
      height: solid.height,
    };
  }
  const flat = solid.points.flatMap((p) => [p.x, p.y]);
  if (taper < 1e-6) {
    return {
      kind: "extrude",
      points: flat,
      height: solid.height,
      z0: baseZ,
      ...((solid.cornerRadius ?? 0) > 0 ? { cornerRadius: solid.cornerRadius } : {}),
    };
  }
  if (taper < 1 - 1e-6) {
    const cx = solid.points.reduce((s, p) => s + p.x, 0) / solid.points.length;
    const cy = solid.points.reduce((s, p) => s + p.y, 0) / solid.points.length;
    const top = solid.points.flatMap((p) => [cx + (p.x - cx) * (1 - taper), cy + (p.y - cy) * (1 - taper)]);
    return {
      kind: "loft",
      sections: [
        { z: baseZ, points: flat },
        { z: baseZ + solid.height, points: top },
      ],
    };
  }
  return null;
}
