// Auswahl im Schnitt-View: generateSectionPlan hängt jedem Cut-Polygon die
// Quell-Element-Id (cp.sourceId) je nach component.kind als wallId/ceilingId/
// roofId ans Plan-Polygon — damit ein Klick im Schnitt das Bauteil im Modell
// wählt (die bestehende PlanView-Pick-Logik greift dann ohne Sonderfall).

import { describe, it, expect } from "vitest";
import { generateSectionPlan } from "./generatePlan";
import type { SectionCutPolygon, SectionOutput } from "./toSection";

function cut(kind: "wall" | "slab" | "roof", sourceId: string): SectionCutPolygon {
  return {
    component: { kind, index: 0 },
    color: [0.5, 0.5, 0.5],
    pts: [
      [0, 0],
      [1, 0],
      [1, 2],
      [0, 2],
    ],
    sourceId,
  };
}

const output: SectionOutput = {
  cutPolygons: [cut("wall", "W1"), cut("slab", "C1"), cut("roof", "R1")],
  visibleEdges: [],
  hiddenEdges: [],
};

describe("generateSectionPlan — Auswahl-Ids am Cut-Polygon", () => {
  it("schreibt sourceId je component.kind als wallId/ceilingId/roofId", () => {
    const polys = generateSectionPlan(output).primitives.filter(
      (p): p is Extract<typeof p, { kind: "polygon" }> => p.kind === "polygon",
    );
    const wall = polys.find((p) => p.wallId === "W1");
    const ceiling = polys.find((p) => p.ceilingId === "C1");
    const roof = polys.find((p) => p.roofId === "R1");
    expect(wall).toBeTruthy();
    expect(ceiling).toBeTruthy();
    expect(roof).toBeTruthy();
    // Kanäle schließen sich je Polygon aus (eine Wand trägt keine ceilingId).
    expect(wall?.ceilingId).toBeUndefined();
    expect(wall?.roofId).toBeUndefined();
    expect(ceiling?.wallId).toBeUndefined();
  });

  it("lässt die Ids weg, wenn cp.sourceId fehlt (unauflösbares Bauteil)", () => {
    const noId: SectionOutput = {
      cutPolygons: [{ ...cut("wall", "W1"), sourceId: undefined }],
      visibleEdges: [],
      hiddenEdges: [],
    };
    const poly = generateSectionPlan(noId).primitives.find(
      (p): p is Extract<typeof p, { kind: "polygon" }> => p.kind === "polygon",
    );
    expect(poly?.wallId).toBeUndefined();
  });
});
