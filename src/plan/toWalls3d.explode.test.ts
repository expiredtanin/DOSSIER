/**
 * [65] Explosionsaxonometrie: Fassade `projectToModel3d({ explode })`, `pickGeometry(…, explode)` und
 * `selectionHighlightLines(…, explode)` — Geschosse um Index × Abstand gehoben, 0 = unverändert.
 */
import { describe, it, expect } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { projectToModel3d, pickGeometry, selectionHighlightLines } from "./toWalls3d";

const floors = sampleProject.drawingLevels
  .filter((l) => l.kind === "floor")
  .sort((a, b) => (a.baseElevation ?? 0) - (b.baseElevation ?? 0));
const index = new Map(floors.map((f, i) => [f.id, i]));
const wallIndex = (id: string) => index.get(sampleProject.walls.find((w) => w.id === id)!.floorId) ?? 0;

describe("Explosionsaxonometrie", () => {
  it("Abstand 0 ändert nichts", () => {
    expect(JSON.stringify(projectToModel3d(sampleProject, { explode: 0 }))).toBe(JSON.stringify(projectToModel3d(sampleProject)));
    expect(JSON.stringify(pickGeometry(sampleProject, 0))).toBe(JSON.stringify(pickGeometry(sampleProject)));
  });

  it("Wände heben sich um Geschoss-Index × Abstand, Modell und Pick stimmen überein", () => {
    expect(floors.length).toBeGreaterThan(1);
    const base = projectToModel3d(sampleProject);
    const ex = projectToModel3d(sampleProject, { explode: 3 });
    const pick = pickGeometry(sampleProject, 3);
    expect(ex.walls.length).toBe(base.walls.length);
    let lifted = 0;
    ex.walls.forEach((w, i) => {
      const dz = wallIndex(w.wallId) * 3;
      expect(w.baseElevation - base.walls[i].baseElevation).toBeCloseTo(dz, 9);
      if (dz > 0) lifted++;
    });
    expect(lifted).toBeGreaterThan(0);
    pick.walls.forEach((w, i) => expect(w.baseElevation).toBeCloseTo(ex.walls[i].baseElevation, 9));
  });

  it("Hervorhebung folgt dem Versatz", () => {
    const w = sampleProject.walls.find((x) => wallIndex(x.id) > 0)!;
    const a = selectionHighlightLines(sampleProject, [w.id], [], [1, 0, 0]);
    const b = selectionHighlightLines(sampleProject, [w.id], [], [1, 0, 0], [], [], [], [], 2);
    expect(b.length).toBe(a.length);
    expect(b[1] - a[1]).toBeCloseTo(2 * wallIndex(w.id), 4);
  });
});
