/** [284] Geschoss löschen nimmt 2D-Elemente, Körper, Bäume und Kameras des Geschosses mit. */
import { describe, it, expect, beforeEach } from "vitest";
import { getState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D, Tree, Camera, ExtrudedSolid } from "../model/types";

const floors = sampleProject.drawingLevels.filter((l) => l.kind === "floor");
const [A, B] = [floors[0].id, floors[1].id];

const drawing = (id: string, levelId: string): Drawing2D => ({
  id, type: "drawing2d", levelId, categoryCode: "00", geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 2, y: 0 } },
});

beforeEach(() => {
  getState().loadProject(structuredClone({
    ...sampleProject,
    drawings2d: [drawing("d-a", A), drawing("d-b", B)],
    extrudedSolids: [{ id: "s-a", levelId: A }, { id: "s-b", levelId: B }] as unknown as ExtrudedSolid[],
    trees: [{ id: "t-a", floorId: A }, { id: "t-b", floorId: B }] as unknown as Tree[],
    cameras: [{ id: "c-a", floorId: A }, { id: "c-b", floorId: B }] as unknown as Camera[],
  }));
});

describe("deleteLevel", () => {
  it("entfernt 2D, Körper, Bäume, Kameras des Geschosses, lässt die anderen stehen", () => {
    getState().deleteLevel(A);
    const p = getState().project;
    expect(p.drawings2d.map((x) => x.id)).toEqual(["d-b"]);
    expect((p.extrudedSolids ?? []).map((x) => x.id)).toEqual(["s-b"]);
    expect((p.trees ?? []).map((x) => x.id)).toEqual(["t-b"]);
    expect((p.cameras ?? []).map((x) => x.id)).toEqual(["c-b"]);
  });
});
