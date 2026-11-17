// [276] Wirksame Darstellung einer Schnitt-/Ansichtslinie: Ebene > Modelldarstellung des gezeigten Plans > Basis.
import { describe, expect, it } from "vitest";
import type { DrawingLevel, Project } from "../../model/types";
import { effectiveSectionLook, marksOfPlan } from "./SectionLookFields";

const lvl = (o: Partial<DrawingLevel>): DrawingLevel => ({ id: "s", name: "Schnitt A", kind: "section", visible: true, locked: false, ...o }) as DrawingLevel;

describe("effectiveSectionLook", () => {
  it("Basis: Schnitt = durchgehend + Pfeil, Ansicht = keine Linie + Dreieck", () => {
    expect(effectiveSectionLook(lvl({}), undefined)).toEqual({ lineMode: "full", endLengthMm: 12, marker: "arrow", markerAt: "both", markerLabel: true });
    const e = effectiveSectionLook(lvl({ kind: "elevation" }), undefined);
    expect([e.lineMode, e.marker]).toEqual(["none", "triangle"]);
  });
  it("Ebene geht vor der Modelldarstellung", () => {
    const e = effectiveSectionLook(lvl({ marker: "arrow" }), { lineMode: "ends", marker: "lAngle", markerLabel: false });
    expect([e.lineMode, e.marker, e.markerLabel]).toEqual(["ends", "arrow", false]);
  });
  it("Modelldarstellung des gezeigten Plans", () => {
    const p = {
      drawingLevels: [{ id: "eg", modelViewOptionId: "m" }],
      modelViewOptions: [{ id: "m", name: "M", sectionMarks: { marker: "triangle" }, elevationMarks: { lineMode: "full" } }],
    } as unknown as Project;
    expect(marksOfPlan(p, "eg", false)).toEqual({ marker: "triangle" });
    expect(marksOfPlan(p, "eg", true)).toEqual({ lineMode: "full" });
    expect(marksOfPlan(p, "x", false)).toBeUndefined();
  });
});
