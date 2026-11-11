// [137] 3D-Pick, Rest: Treppengeländer über der Treppen-Hülle, Kreise/Bögen/Texte (Bäume, Symbole) als flache
// Fläche, einzeln ausgeblendetes importiertes Netz (Objekt-Info-Schalter `hidden`, mit Undo).

import { describe, expect, it } from "vitest";
import type { ImportedMesh, Project } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { pickGeometry } from "./toWalls3d";
import { pickNearest, type Ray } from "../viewport/raycast3d";
import { getState, setState } from "../state/appStore";

const base: Project = {
  ...sampleProject,
  walls: [],
  openings: [],
  ceilings: [],
  roofs: [],
  columns: [],
  extrudedSolids: [],
  context: [],
  stairTypes: [{ ...sampleProject.stairTypes![0], id: "rail", railing: "beide" }],
  stairs: [
    { id: "st1", type: "stair", floorId: "eg", categoryCode: "35", shape: "straight", start: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, runLength: 3, width: 1, stepCount: 16, totalRise: 2.8, typeId: "rail" },
  ],
  drawings2d: [{ id: "baum", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "circle", center: { x: 20, y: 5 }, r: 2 } }],
} as unknown as Project;

const down = (x: number, z: number): Ray => ({ origin: [x, 50, z], dir: [0, -1, 0] });
const pick = (p: Project, ray: Ray) => {
  const g = pickGeometry(p);
  return pickNearest(ray, g.walls, g.slabs, g.openings, g.stairs, g.roofs, g.contextMeshes, g.drawings, g.columns, g.solids, g.openingMeshes, g.stairMeshes, g.drawingMeshes);
};

describe("[137] 3D-Pick Treppengeländer und 2D-Flächen", () => {
  it("Geländer-Dreiecke tragen die Treppen-Id und liegen über der Hülle", () => {
    const g = pickGeometry(base);
    expect(g.stairMeshes.map((m) => m.stairId)).toEqual(["st1"]);
    const top = Math.max(...g.stairMeshes[0].tris.flat().map((q) => q[1]));
    expect(top).toBeGreaterThan(g.stairs[0].zTop);
  });

  it("Kreis (Baum) ist von oben anwählbar, daneben nicht", () => {
    const hit = pick(base, down(20.5, 5.5));
    expect(hit?.kind).toBe("drawing");
    expect(hit?.id).toBe("baum");
    expect(pick(base, down(24, 5))).toBeNull();
  });

  it("[181] Netzkörper in ausgeblendete Klasse verschoben: keine Pick-Dreiecke, Undo bringt sie zurück", () => {
    const mesh = { type: "importedMesh", id: "im", name: "M", categoryCode: "10", positions: [30, 0, 0, 32, 0, 0, 30, 2, 0], indices: [0, 1, 2] } as ImportedMesh;
    const off = { code: "99", name: "Aus", color: "#000000", lw: 0.1, visible: false } as Project["layers"][number];
    setState({ project: { ...base, layers: [...base.layers, off], stairs: [], drawings2d: [], context: [mesh] }, undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false });
    getState().clearHistory();
    expect(pickGeometry(getState().project).contextMeshes.map((m) => m.contextObjectId)).toEqual(["im"]);
    getState().patchContextObject("im", { categoryCode: "99" });
    expect((getState().project.context![0] as ImportedMesh).categoryCode).toBe("99");
    expect(pickGeometry(getState().project).contextMeshes).toEqual([]);
    getState().undo();
    expect(pickGeometry(getState().project).contextMeshes).toHaveLength(1);
  });
});
