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
