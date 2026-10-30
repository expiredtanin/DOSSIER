// [115] Layout-Viewport zeigt Schnitt und Ansicht wie einen Grundriss (vorher nur Geschoss/Zeichnung).
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { collectVisibleCodes } from "../model/types";
import { generatePlan } from "./generatePlan";
import { viewportLevelPlan } from "./viewportPlan";

const p = buildComplexSampleProject();
const codes = collectVisibleCodes(p.layers);

describe("viewportLevelPlan", () => {
  it("Schnitt: Schnittfläche + Koten, Grenzen über die Höhe", async () => {
    const plan = await viewportLevelPlan(p, "schnitt-a", codes, "mittel", 100);
    expect(plan.primitives.length).toBeGreaterThan(200);
    // Höhe (y) statt Grundriss-Tiefe: das Haus reicht über mehrere Geschosse.
    expect(plan.bounds.maxY - plan.bounds.minY).toBeGreaterThan(8);
  });

  it("Ansicht: Fassade", async () => {
    const plan = await viewportLevelPlan(p, "ansicht-sued", codes, "mittel", 100);
    expect(plan.primitives.length).toBeGreaterThan(100);
  });

  it("Geschoss: wie bisher generatePlan", async () => {
    const plan = await viewportLevelPlan(p, "eg", codes, "mittel", 100);
    expect(plan.primitives.length).toBe(generatePlan(p, "eg", codes, undefined, "mittel", false, false, true, 100).primitives.length);
  });

  it("unbekannte Ebene: leer, kein Fehler", async () => {
    const plan = await viewportLevelPlan(p, "gibt-es-nicht", codes, "mittel", 100);
    expect(plan.primitives.length).toBe(0);
  });
});
