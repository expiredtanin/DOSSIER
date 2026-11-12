// [207] Musterhaus komplex: Ausschnitt „Situation 1:500" nutzt die Ansichtsvorlage „Situation WBW"; Situationsplan
// mit schwarzem eigenem Gebäude, grauen Nachbarn, Planzeichen und Klassen.
import { describe, expect, it } from "vitest";
import { generatePlan, planToSvgString, projectWithTemplate } from "../core";
import { buildComplexSampleProject } from "./sampleProjectComplex";

const p = buildComplexSampleProject();
const snap = p.viewSnapshots?.find((s) => s.id === "vs-situation");
const tpl = p.viewTemplates?.find((t) => t.id === "std-vt-situation-wbw");

type Plan = ReturnType<typeof generatePlan>;
type Poly = { kind: "polygon"; fill: string; wallId?: string; contextObjectId?: string; strokeWidthMm: number };

function planOf(hide: string[] = []): Plan {
  const tp = projectWithTemplate(p, "eg", tpl!);
  const show = new Set(Object.entries(snap!.layerVisibility).filter(([c, v]) => v && !hide.includes(c)).map(([c]) => c));
  return generatePlan(tp, "eg", show, undefined, "grob", false, true, true, 500);
}
const polys = (pl: Plan): Poly[] => pl.primitives.filter((q) => q.kind === "polygon") as unknown as Poly[];
const isCtx = (q: Poly) => q.contextObjectId === "nachbarn";
const isOwn = (q: Poly) => q.fill === "#000000" && !q.contextObjectId && q.strokeWidthMm < 0.12; // Umriss 0.1 mm (nach Massstab skaliert), Planzeichen 0.18 mm

describe("Situation 1:500 im Musterhaus komplex", () => {
  it("Ausschnitt ist an die Vorlage gebunden, Klassen der Vorlage sind aus", () => {
    expect(snap?.templateId).toBe("std-vt-situation-wbw");
    expect(snap?.templateLinked).toBe(true);
    expect(tpl?.modelViewOptionId).toBe("std-mv-situation-wbw");
    for (const [code, v] of Object.entries(tpl?.layerVisibility ?? {})) expect(snap?.layerVisibility[code], code).toBe(v);
  });

  it("eigenes Gebäude schwarz, Nachbarn grau, keine Bauteile", () => {
    const ps = polys(planOf());
    expect(ps.some((q) => q.wallId)).toBe(false);
    expect(ps.filter(isOwn).length).toBeGreaterThanOrEqual(1);
    expect(ps.filter((q) => isCtx(q) && q.fill === "#b8b8b8").length).toBe(5);
  });

  it("Klassen: Nachbarn (12), eigenes Gebäude (83), Planzeichen (84) schaltbar", () => {
    expect(polys(planOf(["12"])).filter(isCtx).length).toBe(0);
    expect(polys(planOf(["83"])).filter(isOwn).length).toBe(0);
    const hasN = (pl: Plan) => pl.primitives.some((q) => q.kind === "drawingText" && (q as unknown as { text: string }).text === "N");
    expect(hasN(planOf())).toBe(true);
    expect(hasN(planOf(["84"]))).toBe(false);
  });

  it("SVG enthält schwarze und graue Flächen", () => {
    const svg = planToSvgString(planOf(), { scaleDenominator: 500 });
    expect(svg).toContain('fill="#000000"');
    expect(svg).toContain('fill="#b8b8b8"');
  });
});
