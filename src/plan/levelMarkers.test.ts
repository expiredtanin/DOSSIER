import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Primitive } from "./generatePlan";
import { computeSection, generateSectionPlan } from "../core";
import { levelMarkerPrimitives, levelMarksEnabled } from "./levelMarkers";

const texts = (prims: Primitive[]) =>
  prims.filter((p): p is Extract<Primitive, { kind: "drawingText" }> => p.kind === "drawingText").map((p) => p.text);

// Lage und Nachbarn-Filter (Gebautes, Gelände, Achsraster, Bäume) prüft der Kern: `drawings.rs::level_marker_bounds`.
describe("levelMarkerPrimitives", () => {
  it("Kote je Geschoss (OK fertig Boden) + oberste Kante, links der Zeichnung (Abfrage levelMarkersOf)", async () => {
    const lv = sampleProject.drawingLevels.find((l) => l.kind === "section")!;
    const out = (await computeSection(sampleProject, lv))!;
    const raw = generateSectionPlan(out, false, { openings: true, scaleDenominator: 100 });
    const marks = levelMarkerPrimitives(sampleProject, raw, 100);
    expect(texts(marks).length).toBeGreaterThanOrEqual(2);
    expect(texts(marks)[0]).toBe("±0.00");
    const minX = Math.min(...raw.primitives.flatMap((p) => (p.kind === "polygon" ? p.pts.map((v) => v.x) : [])));
    for (const p of marks) if (p.kind === "line") expect(Math.min(p.a.x, p.b.x)).toBeLessThan(minX + 1e-6);
  });

  it("Plan ohne Quell-Abfrage: keine Koten", () => {
    expect(levelMarkerPrimitives(sampleProject, {})).toEqual([]);
  });

  it("standardmässig an, abschaltbar", () => {
    const lv = sampleProject.drawingLevels.find((l) => l.kind === "section")!;
    expect(levelMarksEnabled(lv)).toBe(true);
    expect(levelMarksEnabled({ ...lv, levelMarks: false })).toBe(false);
  });

  it("[173] Modelldarstellung der Ebene schaltet sie aus; die Ebene geht vor", () => {
    const lv = { ...sampleProject.drawingLevels.find((l) => l.kind === "section")!, modelViewOptionId: "mv" };
    const p = { modelViewOptions: [{ id: "mv", name: "Wettbewerb", dimensions: { levelMarks: false } }] };
    expect(levelMarksEnabled(lv)).toBe(true);
    expect(levelMarksEnabled(lv, p)).toBe(false);
    expect(levelMarksEnabled({ ...lv, levelMarks: true }, p)).toBe(true);
  });
});
