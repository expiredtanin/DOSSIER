// Beweis, dass die Grenze trägt: der Kern läuft ohne DOM/React, nur über die Fassade `src/core`
// (Vitest-Umgebung = node). Ein späteres `dossier-cli` ([4]) nutzt genau diese Einstiege.
import { describe, expect, it } from "vitest";
import { generatePlan, planToRenderScene, projectToModel3d } from "./index";
import { sampleProject } from "../model/sampleProject";

describe("Kern headless (nur über src/core)", () => {
  it("Grundriss, Render-Szene und 3D-Modell des Beispielprojekts ohne DOM", () => {
    expect(typeof document).toBe("undefined");
    const floor = sampleProject.drawingLevels.find((l) => l.kind === "floor")!;
    const codes = new Set(sampleProject.layers.map((l) => l.code));
    const plan = generatePlan(sampleProject, floor.id, codes);
    expect(plan.primitives.length).toBeGreaterThan(50);
    const scene = planToRenderScene(plan);
    expect(scene).toBeTruthy();
    const model = projectToModel3d(sampleProject);
    expect(model.walls.length).toBeGreaterThan(5);
  });
});
