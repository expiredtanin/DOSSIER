// [135] CLI-SVG mit Schraffur: ohne `hatch` unverändert (nur Grundfüllung), mit `hatch` Linien an den Flächen.
import { describe, expect, it } from "vitest";
import { generatePlan, planToSvgString } from "../core";
import { sampleProject as project } from "../model/sampleProject";

describe("planToSvgString hatch", () => {
  const floor = project.drawingLevels.find((l) => l.kind === "floor")!;
  const codes = new Set(project.layers.map((l) => l.code));
  const plan = generatePlan(project, floor.id, codes);
  it("Standard und hatch:false sind byte-gleich", () => {
    const a = planToSvgString(plan, { scaleDenominator: 100 });
    expect(planToSvgString(plan, { scaleDenominator: 100, hatch: false })).toBe(a);
  });
  it("hatch:true ergänzt nur Linien, der Rest bleibt", () => {
    const a = planToSvgString(plan, { scaleDenominator: 100 });
    const b = planToSvgString(plan, { scaleDenominator: 100, hatch: true });
    const lines = (s: string) => (s.match(/<(line|polyline) /g) ?? []).length;
    expect(lines(b)).toBeGreaterThan(lines(a) + 20);
    const rest = b.split("\n").filter((l) => !a.includes(l));
    expect(rest.length).toBeGreaterThan(20);
    expect(rest.every((l) => l.startsWith("<line ") || l.startsWith("<polyline "))).toBe(true);
  });
});
