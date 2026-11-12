import { describe, it, expect } from "vitest";
import { growRect, meshGripIndices, meshTolerance, nearestMeshVertex } from "./meshPick";

// 10 x 10 Raster, Punkt i = (i % 10, floor(i / 10)), z = 0
const grid = Array.from({ length: 100 }, (_, i) => [i % 10, Math.floor(i / 10), 0]).flat();

describe("meshGripIndices", () => {
  it("kleine Netze: alle Punkte, ohne Ausschnitt", () => {
    expect(meshGripIndices(grid, null, 100)).toHaveLength(100);
  });
  it("grosses Netz ohne Ausschnitt: keine Griffe", () => {
    expect(meshGripIndices(grid, null, 50)).toEqual([]);
  });
  it("grosses Netz: nur Punkte im Ausschnitt", () => {
    const r = meshGripIndices(grid, { x0: -0.5, y0: -0.5, x1: 1.5, y1: 1.5 }, 4);
    expect(r).toEqual([0, 1, 10, 11]);
  });
  it("Obergrenze: die der Mitte nächsten bleiben; aktiver Punkt immer dabei", () => {
    const r = meshGripIndices(grid, { x0: -1, y0: -1, x1: 10, y1: 10 }, 4, 99);
    expect(r).toHaveLength(5);
    expect(r).toContain(99);
    expect(r).toContain(55);
  });
});

describe("nearestMeshVertex / Toleranz", () => {
  it("findet den nächsten Punkt innerhalb der Toleranz", () => {
    expect(nearestMeshVertex(grid, { x: 3.1, y: 2.05 }, 0.3)).toBe(23);
    expect(nearestMeshVertex(grid, { x: 3.5, y: 2.5 }, 0.3)).toBeNull();
  });
  it("Toleranz und Ausschnitt", () => {
    expect(meshTolerance(grid)).toBeCloseTo(Math.hypot(9, 9) * 0.02, 9);
    expect(growRect({ x0: 0, y0: 0, x1: 10, y1: 20 }, 0.5)).toEqual({ x0: -5, y0: -10, x1: 15, y1: 30 });
  });
});
