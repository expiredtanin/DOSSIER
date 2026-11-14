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

  it("[199] oberste Kote an der Oberkante des Gebauten, nicht an Achsblasen, Bäumen oder Texten darüber", () => {
    const line = (ax: number, ay: number, bx: number, by: number, cls: string): Primitive =>
      ({ kind: "line", a: { x: ax, y: ay }, b: { x: bx, y: by }, cls, weightMm: 0.25 }) as unknown as Primitive;
    const prims: Primitive[] = [
      { kind: "polygon", pts: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 6.2 }, { x: 0, y: 6.2 }], fill: "#000", stroke: "#000", strokeWidthMm: 0.5 } as unknown as Primitive,
      // Achsraster (Stummel + Blase + Text) und Baumkrone über dem First
      line(2, 6.5, 2, 7.2, "draw2d"),
      { kind: "drawingCircle", center: { x: 2, y: 7.6 }, r: 0.25, fill: "none", stroke: "#000", weightMm: 0.25 } as unknown as Primitive,
      line(6, 0, 6, 9, "tree-crown"),
    ];
    const marks = levelMarkerPrimitives(sampleProject, { minX: 0, minY: -0.3, maxX: 6, maxY: 9 }, prims);
    expect(texts(marks)).toEqual(["±0.00", "+2.60", "+6.20"]);
  });

  it("[256] Nachbargebäude (Kontext-Netz auf Klasse 12 Gebäude) zählen nicht zum Gebauten, ein Netz auf eigener Klasse schon", () => {
    const mesh = (id: string, categoryCode: string) => ({ type: "importedMesh", id, name: id, categoryCode, positions: [], indices: [] });
    const project = { ...sampleProject, context: [...(sampleProject.context ?? []), mesh("nachbarn", "12"), mesh("ifc", "60")] } as typeof sampleProject;
    const poly = (x0: number, x1: number, top: number, contextObjectId?: string): Primitive =>
      ({ kind: "polygon", pts: [{ x: x0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: top }, { x: x0, y: top }], fill: "#000", stroke: "#000", strokeWidthMm: 0.5, contextObjectId }) as unknown as Primitive;
    const line = (ax: number, ay: number, bx: number, by: number): Primitive =>
      ({ kind: "line", a: { x: ax, y: ay }, b: { x: bx, y: by }, cls: "section-cut-outline", weightMm: 0.5 }) as unknown as Primitive;
    const house = poly(0, 5, 6.2);
    const marks = levelMarkerPrimitives(project, { minX: -20, minY: -0.3, maxX: 5, maxY: 9 }, [house, poly(-20, -8, 9, "nachbarn"), line(-20, 9, -8, 9)]);
    expect(texts(marks)).toEqual(["±0.00", "+2.60", "+6.20"]);
    for (const p of marks) if (p.kind === "line") expect(Math.min(p.a.x, p.b.x)).toBeGreaterThan(-3);
    const own = levelMarkerPrimitives(project, { minX: -20, minY: -0.3, maxX: 5, maxY: 9 }, [house, poly(-3, -1, 9, "ifc")]);
    expect(texts(own)).toEqual(["±0.00", "+2.60", "+9.00"]);
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
