import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Primitive } from "./generatePlan";
import { levelMarkerPrimitives, levelMarksEnabled } from "./levelMarkers";

const texts = (prims: Primitive[]) =>
  prims.filter((p): p is Extract<Primitive, { kind: "drawingText" }> => p.kind === "drawingText").map((p) => p.text);

describe("levelMarkerPrimitives", () => {
  it("Kote je Geschoss (OK fertig Boden) + oberste Kante, links der Zeichnung", () => {
    const prims = levelMarkerPrimitives(sampleProject, { minX: 0, minY: -0.3, maxX: 5, maxY: 6.2 });
    expect(texts(prims)).toEqual(["±0.00", "+2.60", "+6.20"]);
    for (const p of prims) {
      if (p.kind === "line") expect(Math.max(p.a.x, p.b.x)).toBeLessThan(0);
    }
  });

  it("Geschosse ausserhalb der Zeichnung entfallen", () => {
    const prims = levelMarkerPrimitives(sampleProject, { minX: 0, minY: 2, maxX: 5, maxY: 6 });
    expect(texts(prims)).toEqual(["+2.60", "+6.00"]);
  });

  it("standardmässig an, abschaltbar", () => {
    const lv = sampleProject.drawingLevels.find((l) => l.kind === "section")!;
    expect(levelMarksEnabled(lv)).toBe(true);
    expect(levelMarksEnabled({ ...lv, levelMarks: false })).toBe(false);
  });
});
