/**
 * DXF-Export gezeichneter Kreise/Bögen. Beide Primitive (`drawingCircle`/
 * `drawingArc`) landeten früher gar nicht im DXF — der Writer konnte CIRCLE
 * und ARC längst, im Primitiv-Switch fehlten nur die Zweige. Seit Polylinien-
 * Bögen als echte Bögen in den Plan gehen (statt tesselliert), hängt daran
 * auch, ob ein Bogen in AutoCAD/Vectorworks als BOGEN ankommt oder als Kette
 * von Geraden.
 */

import { describe, expect, it } from "vitest";
import { buildPlanDxf } from "./exportDxf";
import { sampleProject } from "../model/sampleProject";
import type { Plan } from "../plan/generatePlan";

/** Minimaler Plan mit genau einem Primitiv. */
function planWith(primitives: Plan["primitives"]): Plan {
  return { primitives, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } } as Plan;
}

/** Zählt, wie oft ein DXF-Entity-Typ als eigene Gruppe (0/TYP) vorkommt. */
function countEntities(dxf: string, type: string): number {
  return dxf.split(/\r?\n/).filter((l, i, all) => l.trim() === "0" && all[i + 1]?.trim() === type)
    .length;
}

const code = sampleProject.layers[0].code;

describe("buildPlanDxf — gezeichnete Kreise/Bögen", () => {
  it("drawingCircle → CIRCLE-Entity", () => {
    const dxf = buildPlanDxf(
      planWith([
        {
          kind: "drawingCircle",
          center: { x: 1, y: 2 },
          r: 3,
          fill: "none",
          stroke: "#000000",
          weightMm: 0.18,
          categoryCode: code,
        } as Plan["primitives"][number],
      ]),
      sampleProject,
    );
    expect(countEntities(dxf, "CIRCLE")).toBe(1);
  });

  it("drawingArc → ARC-Entity (Winkel in Grad, CCW wie im Plan)", () => {
    const dxf = buildPlanDxf(
      planWith([
        {
          kind: "drawingArc",
          center: { x: 0, y: 0 },
          r: 2,
          a0: 0,
          a1: Math.PI / 2,
          stroke: "#000000",
          weightMm: 0.18,
          categoryCode: code,
        } as Plan["primitives"][number],
      ]),
      sampleProject,
    );
    expect(countEntities(dxf, "ARC")).toBe(1);
    // Start-/Endwinkel (DXF-Gruppencodes 50/51) in Grad.
    expect(dxf).toMatch(/\n\s*50\r?\n\s*0(\.0+)?\r?\n/);
    expect(dxf).toMatch(/\n\s*51\r?\n\s*90(\.0+)?\r?\n/);
  });

  it("ein Bogen bleibt EIN Entity — keine Kette von LINEs", () => {
    const dxf = buildPlanDxf(
      planWith([
        {
          kind: "drawingArc",
          center: { x: 0, y: 0 },
          r: 2,
          a0: 0,
          a1: Math.PI,
          stroke: "#000000",
          weightMm: 0.18,
          categoryCode: code,
        } as Plan["primitives"][number],
      ]),
      sampleProject,
    );
    expect(countEntities(dxf, "ARC")).toBe(1);
    expect(countEntities(dxf, "LINE")).toBe(0);
  });
});
