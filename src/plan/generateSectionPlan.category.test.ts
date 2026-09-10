// Ebenen-Panel-Sichtbarkeit im Schnitt/in der Ansicht: generateSectionPlan
// filtert/dimmt jedes Cut-Band über `cp.categoryCode` (visibleCodes/
// categoryDisplay) — genau wie jedes andere Bauteil im Grundriss. Vorher
// wirkte das Ebenen-Panel im Schnitt/in der Ansicht gar nicht (Nutzer-Report).

import { describe, it, expect } from "vitest";
import { generateSectionPlan } from "./generatePlan";
import type { CategoryDisplayResolver } from "./generatePlan";
import type { SectionCutPolygon, SectionOutput } from "./toSection";

function cut(kind: "wall" | "slab" | "roof", categoryCode: string | undefined): SectionCutPolygon {
  return {
    component: { kind, index: 0 },
    color: [0.5, 0.5, 0.5],
    pts: [
      [0, 0],
      [1, 0],
      [1, 2],
      [0, 2],
    ],
    sourceId: "X1",
    categoryCode,
  };
}

const SHOW_ALL: CategoryDisplayResolver = () => ({ render: true, greyed: false, locked: false });

describe("generateSectionPlan — Kategorie-Sichtbarkeit (Ebenen-Panel)", () => {
  it("lässt ein Band mit kategorie-verstecktem categoryCode weg (visibleCodes ohne den Code)", () => {
    const output: SectionOutput = {
      cutPolygons: [cut("wall", "20")],
      visibleEdges: [],
      hiddenEdges: [],
    };
    const polys = generateSectionPlan(output, false, {
      visibleCodes: new Set(["30"]), // "20" fehlt
      categoryDisplay: SHOW_ALL,
    }).primitives.filter((p) => p.kind === "polygon");
    expect(polys.length).toBe(0);
  });

  it("lässt ein Band weg, wenn categoryDisplay(code).render=false liefert", () => {
    const output: SectionOutput = {
      cutPolygons: [cut("wall", "20")],
      visibleEdges: [],
      hiddenEdges: [],
    };
    const hideCat: CategoryDisplayResolver = () => ({ render: false, greyed: false, locked: false });
    const polys = generateSectionPlan(output, false, {
      visibleCodes: new Set(["20"]),
      categoryDisplay: hideCat,
    }).primitives.filter((p) => p.kind === "polygon");
    expect(polys.length).toBe(0);
  });

  it("dimmt (greyed) ein sichtbares Band, wenn categoryDisplay greyed=true liefert", () => {
    const output: SectionOutput = {
      cutPolygons: [cut("wall", "20")],
      visibleEdges: [],
      hiddenEdges: [],
    };
    const greyCat: CategoryDisplayResolver = () => ({ render: true, greyed: true, locked: false });
    const polys = generateSectionPlan(output, false, {
      visibleCodes: new Set(["20"]),
      categoryDisplay: greyCat,
    }).primitives.filter(
      (p): p is Extract<typeof p, { kind: "polygon" }> => p.kind === "polygon",
    );
    expect(polys[0]?.greyed).toBe(true);
  });

  it("zeichnet ein Band OHNE categoryCode immer (unauflösbares Bauteil, Fallback)", () => {
    const output: SectionOutput = {
      cutPolygons: [cut("wall", undefined)],
      visibleEdges: [],
      hiddenEdges: [],
    };
    const hideAll: CategoryDisplayResolver = () => ({ render: false, greyed: false, locked: false });
    const polys = generateSectionPlan(output, false, {
      visibleCodes: new Set([]),
      categoryDisplay: hideAll,
    }).primitives.filter((p) => p.kind === "polygon");
    expect(polys.length).toBe(1);
  });

  it("ohne opts (Export-/Print-Pfad) bleibt jedes Band sichtbar wie bisher", () => {
    const output: SectionOutput = {
      cutPolygons: [cut("wall", "20")],
      visibleEdges: [],
      hiddenEdges: [],
    };
    const polys = generateSectionPlan(output).primitives.filter((p) => p.kind === "polygon");
    expect(polys.length).toBe(1);
  });
});
