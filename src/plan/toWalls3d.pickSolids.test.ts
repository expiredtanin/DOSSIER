// [137] Alles Sichtbare anwählbar im 3D: freie Körper (Netz aus dem Kern, [115]),
// Stützen lagerichtig (x, Höhe, y wie die Darstellung), Hervorhebung beider, Gelände einzeln ausgeblendet.

import { describe, expect, it } from "vitest";
import type { Project, TerrainMesh } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { pickGeometry, projectToModel3d, projectToModel3dParts, selectionHighlightLines } from "./toWalls3d";
import { pickNearest, type Ray } from "../viewport/raycast3d";

const base: Project = {
  ...sampleProject,
  walls: [],
  openings: [],
  ceilings: [],
  roofs: [],
  stairs: [],
  context: [],
  columns: [
    { id: "k1", type: "column", floorId: "eg", categoryCode: "25", position: { x: 20, y: 3 }, profile: { kind: "rect", width: 0.4, depth: 0.4 }, rotation: 0, height: 2.5 },
  ],
  extrudedSolids: [
    { id: "s1", type: "extrudedSolid", categoryCode: "20", levelId: "og", points: [{ x: 30, y: 2 }, { x: 32, y: 2 }, { x: 32, y: 5 }, { x: 30, y: 5 }], height: 1.5, baseOffset: 0.5 },
    { id: "v1", type: "extrudedSolid", categoryCode: "20", levelId: "eg", points: [{ x: 40, y: 0 }, { x: 41, y: 0 }, { x: 41, y: 1 }], height: 1, operation: "subtract" },
  ],
} as Project;

/** Senkrechter Strahl von oben auf Welt (x, z) — Welt-z = Modell-y bei Bauteilen. */
const down = (x: number, z: number): Ray => ({ origin: [x, 50, z], dir: [0, -1, 0] });
const pick = (p: Project, ray: Ray) => {
  const g = pickGeometry(p);
  return pickNearest(ray, g.walls, g.slabs, g.openings, g.stairs, g.roofs, g.contextMeshes, g.drawings, g.columns, g.solids);
};

describe("[137] 3D-Pick freie Körper und Stützen", () => {
  it("freier Körper: Prisma über dem Umriss, Abzugskörper nicht; Treffer von oben auf OK", () => {
    const g = pickGeometry(base);
    expect(g.solids.map((s) => s.solidId)).toEqual(["s1"]);
    const hit = pick(base, down(31, 3.5));
    expect(hit?.kind).toBe("solid");
    expect(hit?.id).toBe("s1");
    // OK = OG 2.6 + 0.5 + 1.5 = 4.6 → t = 50 − 4.6.
    expect(hit!.t).toBeCloseTo(50 - 4.6, 6);
    expect(pick(base, down(40.5, 0.3))).toBeNull();
  });

  it("[115] Kern-Netz statt Prisma-Näherung (Verjüngung 1 = Pyramide), synchron ohne truck", () => {
    const pyr = { ...base, extrudedSolids: [{ ...base.extrudedSolids![0], taper: 0.999 }] } as Project;
    const hit = pick(pyr, down(30.1, 2.1));
    expect(hit?.id).toBe("s1");
    // Am Rand der Pyramide nahe der UK (3.1) statt auf der Prisma-OK (4.6).
    expect(50 - hit!.t).toBeLessThan(3.3);
  });

  it("[115] 3D-Modell und Teile enthalten die freien Körper als Kern-Netz, Klasse aus ⇒ weg", () => {
    const m = projectToModel3d(base);
    const solidMeshes = m.meshes.filter((x) => x.color[0] === 0.85 && x.color[1] === 0.55);
    expect(solidMeshes.length).toBe(1);
    const zs = solidMeshes[0].positions.filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(3.1, 9);
    expect(Math.max(...zs)).toBeCloseTo(4.6, 9);
    const parts = projectToModel3dParts(base)!;
    expect(parts.find((p) => p.id === "solids")?.meshes?.length).toBe(1);
    const hidden = projectToModel3dParts(base, { hide: ["20"] })!;
    expect(hidden.find((p) => p.id === "solids")?.meshes ?? []).toEqual([]);
  });

  it("Stütze lagerichtig: Welt-z = +y (wie gezeichnet), nicht gespiegelt", () => {
    expect(pick(base, down(20, 3))?.kind).toBe("column");
    expect(pick(base, down(20, -3))).toBeNull();
  });

  it("Hervorhebung für gewählte Stütze und freien Körper", () => {
    const rgb: [number, number, number] = [1, 0, 0];
    expect(selectionHighlightLines(base, [], [], rgb, [], [], [], [], 0, ["k1"]).length).toBe(4 * 3 * 12);
    expect(selectionHighlightLines(base, [], [], rgb, [], [], [], [], 0, [], ["s1"]).length).toBe(4 * 3 * 12);
  });

  it("[181] Gelände in ausgeblendeter Klasse fängt im 3D keinen Klick", () => {
    const terrain: TerrainMesh = { id: "t1", type: "terrainMesh", categoryCode: "02", name: "G", positions: [0, 0, 0, 10, 0, 0, 10, 10, 0], indices: [0, 1, 2] };
    const shown = { ...base, context: [{ ...terrain }] } as Project;
    expect(pickGeometry(shown).contextMeshes.map((m) => m.contextObjectId)).toEqual(["t1"]);
    const hidden = { ...base, layers: [...base.layers, { code: "02", name: "Gelände", color: "#808080", lw: 0.13, visible: false }], context: [{ ...terrain }] } as Project;
    expect(pickGeometry(hidden).contextMeshes).toEqual([]);
  });
});
