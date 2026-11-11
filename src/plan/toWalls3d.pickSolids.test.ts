// [137] Alles Sichtbare anwählbar im 3D: freie Körper (Prisma aus dem Kern, truck-Netz sobald geladen),
// Stützen lagerichtig (x, Höhe, y wie die Darstellung), Hervorhebung beider, Gelände einzeln ausgeblendet.

import { describe, expect, it, afterEach } from "vitest";
import type { Project, TerrainMesh } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { pickGeometry, selectionHighlightLines } from "./toWalls3d";
import { __setTruckMeshForTest } from "./toWalls3d/extrusions";
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
    { id: "s1", type: "extrudedSolid", levelId: "og", points: [{ x: 30, y: 2 }, { x: 32, y: 2 }, { x: 32, y: 5 }, { x: 30, y: 5 }], height: 1.5, baseOffset: 0.5 },
    { id: "v1", type: "extrudedSolid", levelId: "eg", points: [{ x: 40, y: 0 }, { x: 41, y: 0 }, { x: 41, y: 1 }], height: 1, operation: "subtract" },
  ],
} as Project;

/** Senkrechter Strahl von oben auf Welt (x, z) — Welt-z = Modell-y bei Bauteilen. */
const down = (x: number, z: number): Ray => ({ origin: [x, 50, z], dir: [0, -1, 0] });
const pick = (p: Project, ray: Ray) => {
  const g = pickGeometry(p);
  return pickNearest(ray, g.walls, g.slabs, g.openings, g.stairs, g.roofs, g.contextMeshes, g.drawings, g.columns, g.solids);
};

afterEach(() => __setTruckMeshForTest("s1", null));

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

  it("geladenes truck-Netz ersetzt die Prisma-Näherung (z. B. Pyramide statt Quader)", () => {
    // Pyramide über demselben Umriss, Spitze bei (31, 3.5) auf 4.6 m (Modell x, y, z).
    __setTruckMeshForTest("s1", {
      positions: [30, 2, 3.1, 32, 2, 3.1, 32, 5, 3.1, 30, 5, 3.1, 31, 3.5, 4.6],
      indices: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4, 0, 2, 1, 0, 3, 2],
      kind: "extrusion",
      color: [1, 1, 1],
    } as never);
    const hit = pick(base, down(30.1, 2.1));
    expect(hit?.id).toBe("s1");
    // Am Rand der Pyramide nahe der UK statt auf der Prisma-OK.
    expect(50 - hit!.t).toBeLessThan(3.3);
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
