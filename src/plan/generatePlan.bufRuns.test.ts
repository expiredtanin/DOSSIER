// Kern-Abschnitte im Plan ([K3d], Plan-Puffer v2): `Plan.bufRuns` zeigt auf unveränderte Primitive
// aus dem Puffer des Kerns — auch nach Abzugskörpern, beim Überlagern mehrerer Geschosse und mit
// der kompakten Unterlage; Mono und Strichstärken-Massstab lassen sie weg.

import { describe, expect, it } from "vitest";
import { generatePlan, generateVisibleLevelsPlan, materializeUnderlay } from "./generatePlan";
import type { Plan } from "./generatePlan";
import { sampleProject } from "../model/sampleProject";
import { flattenCategories } from "../model/types";
import type { ExtrudedSolid, Project } from "../model/types";

const codes = (p: Project) => new Set(flattenCategories(p.layers).map((c) => c.code));

/** Jede Stelle eines Abschnitts trägt genau das Objekt aus dem Puffer. */
function checkRuns(plan: Plan): number {
  let n = 0;
  for (const r of plan.bufRuns ?? []) {
    expect(r.to).toBeGreaterThan(r.from);
    for (let k = 0; k < r.to - r.from; k++) expect(plan.primitives[r.at + k]).toBe(r.buf.prims[r.from + k]);
    n += r.to - r.from;
  }
  return n;
}

describe("Plan.bufRuns", () => {
  it("Beispiel-EG: ein Abschnitt (auch die 2D-Zeichnungen kommen aus dem Kern), alle Kern-Primitive abgedeckt", () => {
    const plan = generatePlan(sampleProject, "eg", codes(sampleProject));
    expect(plan.bufRuns?.length).toBe(1);
    const covered = checkRuns(plan);
    expect(covered).toBe(plan.bufRuns![0].buf.prims.length);
  });

  it("Abzugskörper zerlegen Polygone: Abschnitte werden neu ausgerichtet", () => {
    const solid: ExtrudedSolid = {
      id: "void1",
      type: "extrudedSolid",
      levelId: "eg",
      operation: "subtract",
      height: 3,
      points: [
        { x: 1, y: -0.5 },
        { x: 1.4, y: -0.5 },
        { x: 1.4, y: 0.5 },
        { x: 1, y: 0.5 },
      ],
    } as ExtrudedSolid;
    const p: Project = { ...sampleProject, extrudedSolids: [solid] };
    const plan = generatePlan(p, "eg", codes(p));
    const total = plan.bufRuns![0].buf.prims.length;
    const covered = checkRuns(plan);
    expect(covered).toBeGreaterThan(total / 2);
    expect(covered).toBeLessThan(total);
  });

  it("Überlagerung mehrerer Geschosse und kompakte Unterlage verschieben die Abschnitte mit", () => {
    const plan = generateVisibleLevelsPlan(sampleProject, "og", codes(sampleProject), undefined, "mittel", false, false, undefined, 100, true);
    expect((plan.bufRuns ?? []).length).toBeGreaterThanOrEqual(2);
    checkRuns(plan);
    checkRuns(materializeUnderlay(plan));
  });

  it("Mono und Strichstärken-Massstab: keine Abschnitte", () => {
    expect(generatePlan(sampleProject, "eg", codes(sampleProject), undefined, "mittel", false, true).bufRuns).toBeUndefined();
    const scaled: Project = { ...sampleProject, scaleLineWeights: true };
    expect(generatePlan(scaled, "eg", codes(scaled), undefined, "mittel", false, false, true, 50).bufRuns).toBeUndefined();
    expect(generatePlan(scaled, "eg", codes(scaled), undefined, "mittel", false, false, true, 100).bufRuns?.length).toBe(1);
  });
});
