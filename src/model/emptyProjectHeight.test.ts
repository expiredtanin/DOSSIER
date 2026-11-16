// [266] Neues Projekt: Geschosshöhe praxisgerecht (lichte Höhe ≥ 2.40 m), Beispielprojekte unverändert.
import { describe, expect, it } from "vitest";
import { emptyProject, sampleProject } from "./sampleProject";

describe("Geschosshöhe neuer Projekte [266]", () => {
  it("lichte Höhe ≥ 2.40 m über der Decke des Typs, Geschosse gestapelt", () => {
    const floors = emptyProject.drawingLevels.filter((l) => l.kind === "floor");
    const slab = (emptyProject.ceilingTypes ?? [])[0].layers.reduce((a, l) => a + l.thickness, 0);
    for (const f of floors) expect((f.floorHeight ?? 0) - slab).toBeGreaterThanOrEqual(2.4);
    expect(floors[0].floorHeight).toBe(2.9);
    expect(floors[1].baseElevation).toBe(2.9);
  });
  it("Beispielprojekt bleibt bei 2.60 m", () => {
    expect(sampleProject.drawingLevels.find((l) => l.id === "eg")!.floorHeight).toBe(2.6);
  });
});
