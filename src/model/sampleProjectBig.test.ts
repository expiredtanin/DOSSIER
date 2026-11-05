// Grossgebäude ([20]): parametrisch, deterministisch, gültig; Ableitungen rechnen.
import { describe, expect, it } from "vitest";
import { buildBigSampleProject } from "./sampleProjectBig";
import { validateProject } from "../core/ops";
import { generatePlan } from "../plan/generatePlan";
import { projectToModel3d } from "../plan/toWalls3d";
import { collectVisibleCodes } from "./types";

describe("Grossgebäude", () => {
  it("Standard: ≈ 4000 Wände + Öffnungen, deterministisch", () => {
    const p = buildBigSampleProject();
    const n = p.walls.length + (p.openings?.length ?? 0);
    expect(n).toBeGreaterThan(3500);
    expect(n).toBeLessThan(4500);
    expect(p.rooms?.length).toBe(8 * 15 * 9);
    expect(JSON.stringify(buildBigSampleProject())).toBe(JSON.stringify(p));
    expect(validateProject(p)).toEqual([]);
  });

  it("klein parametrisiert: Plan und 3D rechnen", () => {
    const p = buildBigSampleProject({ floors: 2, apartments: 2 });
    expect(p.walls.length).toBe(2 * (2 * 15 + 4));
    const plan = generatePlan(p, "g0", collectVisibleCodes(p.layers));
    expect(plan).toBeTruthy();
    expect(projectToModel3d(p)).toBeTruthy();
  });
});
