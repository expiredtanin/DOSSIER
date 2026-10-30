import { describe, expect, it } from "vitest";
import type { Project } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { excavationQuantities } from "./excavation";
import { generateTerrainFromContours } from "../model/terrain";

/** Flaches Gelände 100 × 100 m auf ±0 und eine Baugrube 10 × 10 m, 3 m tief, 45°. */
function project(): Project {
  return {
    ...sampleProject,
    walls: [],
    context: [
      {
        id: "t",
        type: "terrainMesh",
        name: "Gelände",
        positions: [-50, -50, 0, 50, -50, 0, 50, 50, 0, -50, 50, 0],
        indices: [0, 1, 2, 0, 2, 3],
      },
      {
        id: "bg",
        type: "excavation",
        name: "Baugrube",
        outline: [
          { x: -5, y: -5 },
          { x: 5, y: -5 },
          { x: 5, y: 5 },
          { x: -5, y: 5 },
        ],
        bottom: -3,
        slope: 45,
      },
    ],
  };
}

describe("[68] Baugrube", () => {
  it("Abtrag wie analytisch (Kegelecken)", () => {
    const [q] = excavationQuantities(project());
    const exact = 300 + (40 * 9) / 2 + (Math.PI * 27) / 3;
    expect(q.id).toBe("bg");
    expect(Math.abs(q.cut - exact) / exact).toBeLessThan(0.01);
    expect(q.fill).toBeCloseTo(0, 6);
    expect(q.bottomArea).toBeCloseTo(100, 6);
  });

  it("ohne Baugrube leer", () => {
    expect(excavationQuantities({ ...sampleProject, context: [] })).toEqual([]);
  });
});

describe("[T6] Gelände aus Höhenlinien", () => {
  it("glättet ohne Überschwingen und setzt die Äquidistanz", () => {
    const ring = (r: number) =>
      Array.from({ length: 32 }, (_, i) => ({ x: r * Math.cos((i / 32) * 2 * Math.PI), y: r * Math.sin((i / 32) * 2 * Math.PI) }));
    const contours = [0, 1, 2, 3].map((k) => ({ z: k, pts: ring(40 - 10 * k), closed: true }));
    const raw = generateTerrainFromContours(contours, { smooth: 0 });
    const smooth = generateTerrainFromContours(contours);
    expect(smooth.contourInterval).toBe(1);
    expect(smooth.indices.length).toBeGreaterThan(raw.indices.length);
    const zs = smooth.positions.filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-1e-9);
    expect(Math.max(...zs)).toBeLessThan(3.5);
    expect(Math.max(...zs)).toBeGreaterThan(3);
  });
});
