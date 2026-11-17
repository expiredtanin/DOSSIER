// [266] „3D-Dokument erstellen“: Ops für Ausschnitt und Blatt (ohne Oberfläche).
import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { doc3dOps } from "./doc3dAction";

describe("doc3dOps", () => {
  it("„3D-Dokument erstellen“: Ausschnitt und Blatt A3 mit passendem Massstab", () => {
    const vis = Object.fromEntries((sampleProject.layers ?? []).map((l) => [l.code, true]));
    const res = doc3dOps(sampleProject, { camera: { kind: "orthogonal", position: [20, -20, 20], direction: [-1, 1, -1], up: [0, 0, 1], fovDeg: 50 } }, { stamp: "t", name: "3D-Dokument 1", view3d: "iso", activeLevelId: sampleProject.drawingLevels[0].id, layerVisibility: vis })!;
    expect(res).not.toBeNull();
    const kinds = res.ops.map((o) => JSON.stringify(o).match(/viewSnapshots|layouts|drawingLevels/)?.[0]);
    expect(kinds).toEqual(expect.arrayContaining(["viewSnapshots", "layouts", "drawingLevels"]));
    expect([20, 50, 100, 200]).toContain(res.scale);
  });
});
