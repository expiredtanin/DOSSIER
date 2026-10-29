// Kern-Abschnitte im Plan ([K3d], Plan-Puffer v2): `Plan.bufRuns` zeigt auf die Primitive aus den
// Puffern des Kerns — der ganze Plan kommt aus dem Kern (auch Abzugskörper, Mono und
// Strichstärken-Massstab), beim Überlagern mehrerer Geschosse und mit der kompakten Unterlage.

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
  it("Beispiel-EG: Abschnitte (auch die 2D-Zeichnungen kommen aus dem Kern, als Stücke), alle Kern-Primitive abgedeckt", () => {
    const plan = generatePlan(sampleProject, "eg", codes(sampleProject));
    expect(plan.bufRuns?.length).toBeGreaterThanOrEqual(1);
    const covered = checkRuns(plan);
    const bufs = new Set(plan.bufRuns!.map((r) => r.buf));
    expect(covered).toBe([...bufs].reduce((n, b) => n + b.count, 0));
    expect(covered).toBe(plan.primitives.length);
  });

  it("Abzugskörper zerlegen Polygone (im Kern): alles bleibt Abschnitt", () => {
    const solid: ExtrudedSolid = {
      id: "void1",
      type: "extrudedSolid",
      levelId: "eg",
      operation: "subtract",
      height: 3,
      // Durch die Wand W1 zwischen Tür und Innenwand.
      points: [
        { x: 1.95, y: -0.5 },
        { x: 2.15, y: -0.5 },
        { x: 2.15, y: 0.5 },
        { x: 1.95, y: 0.5 },
      ],
    } as ExtrudedSolid;
    const p: Project = { ...sampleProject, extrudedSolids: [solid] };
    const plan = generatePlan(p, "eg", codes(p));
    expect(checkRuns(plan)).toBe(plan.primitives.length);
    // Die Wand-Poché unter dem Körper ist ausgespart.
    const walls = (q: Project) => JSON.stringify(generatePlan(q, "eg", codes(q)).primitives.filter((x) => x.kind === "polygon" && x.wallId));
    expect(walls(p)).not.toBe(walls(sampleProject));
  });

  it("Überlagerung mehrerer Geschosse und kompakte Unterlage verschieben die Abschnitte mit", () => {
    const plan = generateVisibleLevelsPlan(sampleProject, "og", codes(sampleProject), undefined, "mittel", false, false, undefined, 100, true);
    expect((plan.bufRuns ?? []).length).toBeGreaterThanOrEqual(2);
    checkRuns(plan);
    checkRuns(materializeUnderlay(plan));
  });

  it("Mono und Strichstärken-Massstab rechnet der Kern: alles bleibt Abschnitt", () => {
    const mono = generatePlan(sampleProject, "eg", codes(sampleProject), undefined, "mittel", false, true);
    expect(checkRuns(mono)).toBe(mono.primitives.length);
    const scaled: Project = { ...sampleProject, scaleLineWeights: true };
    const s50 = generatePlan(scaled, "eg", codes(scaled), undefined, "mittel", false, false, true, 50);
    expect(checkRuns(s50)).toBe(s50.primitives.length);
  });
});
