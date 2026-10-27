/**
 * `generatePlan` — Rendering des Massstabsbalkens (`shape:"scalebar"`):
 * abwechselnd gefüllte/leere Segmente + Ticks/Beschriftung an jeder
 * Segmentgrenze (s. `drawing2d.ts`).
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Drawing2D, Project } from "../model/types";

function scalebarDrawing(id: string, segmentLength: number, segments: number): Drawing2D {
  return {
    id,
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: { shape: "scalebar", at: { x: 0, y: 0 }, segmentLength, segments },
  };
}

function project(drawings: Drawing2D[]): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: drawings,
    context: [],
  } as unknown as Project;
}

const visible = new Set(["20"]);

describe("generatePlan — Drawing2D scalebar", () => {
  it("erzeugt genau `segments` gefüllte Polygone (abwechselnd) + `segments+1` Ticks/Labels", () => {
    const p = project([scalebarDrawing("d1", 1, 4)]);
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const polys = plan.primitives.filter((pr) => pr.kind === "polygon" && pr.drawingId === "d1");
    const texts = plan.primitives.filter((pr) => pr.kind === "drawingText" && pr.drawingId === "d1");
    expect(polys.length).toBe(4);
    expect(texts.length).toBe(5); // 0,1,2,3,4 → 5 Beschriftungen (0..segments)
  });

  it("alterniert Füllung: gerade Segmente gefüllt (fill=color), ungerade leer (fill='none')", () => {
    const p = project([scalebarDrawing("d1", 1, 3)]);
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const polys = plan.primitives.filter(
      (pr) => pr.kind === "polygon" && pr.drawingId === "d1",
    ) as Extract<(typeof plan.primitives)[number], { kind: "polygon" }>[];
    // Reihenfolge = Erzeugungsreihenfolge (i=0..segments-1).
    expect(polys[0].fill).not.toBe("none");
    expect(polys[1].fill).toBe("none");
    expect(polys[2].fill).not.toBe("none");
  });

  it("Segmentlänge ist eine ECHTE Modell-Distanz — keine Papier-mm-Umrechnung", () => {
    const p = project([scalebarDrawing("d1", 2, 2)]);
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const polys = plan.primitives.filter(
      (pr) => pr.kind === "polygon" && pr.drawingId === "d1",
    ) as Extract<(typeof plan.primitives)[number], { kind: "polygon" }>[];
    // Erstes Segment: x von 0 bis 2 (Modell-Meter), unabhängig vom Massstab.
    const xs = polys[0].pts.map((pt) => pt.x);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(2, 6);
  });

  it("letzte Beschriftung trägt die 'm'-Einheit, die übrigen nicht", () => {
    const p = project([scalebarDrawing("d1", 1, 3)]);
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const texts = plan.primitives.filter(
      (pr) => pr.kind === "drawingText" && pr.drawingId === "d1",
    ) as Extract<(typeof plan.primitives)[number], { kind: "drawingText" }>[];
    const bodies = texts.map((t) => t.text);
    expect(bodies).toContain("0");
    expect(bodies).toContain("1");
    expect(bodies).toContain("2");
    expect(bodies).toContain("3m"); // letzte Grenze (3 × 1m) trägt die Einheit
  });
});
