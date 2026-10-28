/**
 * DXF-Export gezeichneter Kreise/Bögen. Beide Primitive (`drawingCircle`/
 * `drawingArc`) landeten früher gar nicht im DXF — der Writer konnte CIRCLE
 * und ARC längst, im Primitiv-Switch fehlten nur die Zweige. Seit Polylinien-
 * Bögen als echte Bögen in den Plan gehen (statt tesselliert), hängt daran
 * auch, ob ein Bogen in AutoCAD/Vectorworks als BOGEN ankommt oder als Kette
 * von Geraden.
 */

import { describe, expect, it } from "vitest";
import "../engine/fileioWasm.setup";
import { buildPlanDxf } from "./exportDxf";
import { readDxf, num } from "./cadReadBack.testutil";
import { sampleProject } from "../model/sampleProject";
import type { Plan } from "../plan/generatePlan";

/** Minimaler Plan mit genau einem Primitiv. */
function planWith(primitives: Plan["primitives"]): Plan {
  return { primitives, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } } as Plan;
}

/** Zählt die Entitäten eines Typs in der ENTITIES-Sektion (Rücklesen statt Textsuche). */
function countEntities(dxf: string, type: string): number {
  return readDxf(dxf).entities.filter((e) => e.type === type).length;
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
    // Start-/Endwinkel (DXF-Gruppencodes 50/51) in Grad — inhaltlich zurückgelesen statt per
    // Textmuster: acadrust formatiert Zahlen anders als der frühere TS-Writer.
    const arc = readDxf(dxf).entities.find((e) => e.type === "ARC")!;
    expect(num(arc, 50)).toBeCloseTo(0, 12);
    expect(num(arc, 51)).toBeCloseTo(90, 12);
    expect([num(arc, 10), num(arc, 20), num(arc, 40)]).toEqual([0, 0, 2]);
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
