// Abzugskörper im 3D ([115]): jede Wandschicht und Decke, die ein Abzugskörper durchdringt, bestimmt der Kern
// und baut ihr Netz „Bauteil − Körper" selbst (Manifold, `solid_specs::void_meshes`, Abfrage `model3dParts` mit
// `voids`). Hier wird das Bauteil nur noch durch sein Netz ersetzt — synchron, ohne truck.

import type { RMesh, RModel3d, RSlab, RWall } from "./shared";

/** Vom Kern geschnittene Bauteile: (Index in `walls` bzw. `slabs`, Inhalts-Schlüssel, Netz). */
export interface VoidMeshes {
  walls: Array<[number, string, RMesh]>;
  slabs: Array<[number, string, RMesh]>;
}

/** Ersetzt in `model` die geschnittenen Wandschichten/Decken durch ihre Netze (Netze hinten an `meshes`). */
export function applyVoidMeshes(model: RModel3d, cuts: VoidMeshes): void {
  const wallCut = new Map(cuts.walls.map(([i, , m]) => [i, m]));
  const walls: RWall[] = [];
  model.walls.forEach((w, i) => {
    const m = wallCut.get(i);
    if (m) model.meshes.push(m);
    else walls.push(w);
  });
  model.walls = walls;
  const slabCut = new Map(cuts.slabs.map(([i, , m]) => [i, m]));
  const slabs: RSlab[] = [];
  model.slabs.forEach((s, i) => {
    const m = slabCut.get(i);
    if (m) model.meshes.push(m);
    else slabs.push(s);
  });
  model.slabs = slabs;
}

/** [216] Knickwinkel (Grad) der Wandkörper: Bogen-Leibungen glatt, Wand-Ecken (90°) hart. */
const WALL_BODY_CREASE_DEG = 20;

/**
 * [216] Wandstücke, deren Band einen fertigen Körper hat (Wand mit Formöffnungen, Kern `model3d/wall_body.rs`):
 * render3d bekommt statt der Stücke (`noMesh`) das Netz des Körpers als Mesh (mit Schnitt-Stil `section`: der
 * 3D-Live-Schnitt schneidet das Netz); Schnitt, Ansicht und Export rechnen im Kern mit den Stücken. Rest und Netze getrennt.
 */
export function splitWallBodies(walls: readonly RWall[]): { walls: RWall[]; meshes: RMesh[] } {
  const rest: RWall[] = [];
  const meshes: RMesh[] = [];
  for (const w of walls) {
    if (!w.noMesh) {
      rest.push(w);
      continue;
    }
    if (w.body) {
      meshes.push({
        wallId: w.wallId,
        positions: w.body.positions,
        indices: w.body.indices,
        kind: "extrusion",
        color: w.color,
        ...(w.materialIndex !== undefined ? { materialIndex: w.materialIndex } : {}),
        creaseAngle: WALL_BODY_CREASE_DEG,
        // Live-Schnitt: render3d schneidet den Körper selbst (echte Öffnungsform statt der Stücke).
        section: { ...(w.hatch ? { hatch: w.hatch } : {}), ...(w.cut ? { cut: w.cut } : {}) },
      });
    }
  }
  return { walls: rest, meshes };
}
