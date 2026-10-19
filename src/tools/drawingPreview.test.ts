import { describe, expect, it } from "vitest";
import type { Drawing2D, Project } from "../model/types";
import { drawingPreviewShapes, primitivesToDraftShapes } from "./drawingPreview";
import type { Primitive } from "../plan/generatePlan";

const project = { lineStyles: [], hatches: [], layers: [], drawings2d: [], blocks: [] } as unknown as Project;
const base = { id: "d", levelId: "L", categoryCode: "10" } as unknown as Drawing2D;

describe("Verschiebe-Vorschau für alle 2D-Formen", () => {
  it("Kreis → Liniensegmente rundum", () => {
    const s = drawingPreviewShapes(project, { ...base, geom: { shape: "circle", center: { x: 0, y: 0 }, r: 1 } } as Drawing2D);
    expect(s.length).toBeGreaterThan(10);
    expect(s.every((x) => x.kind === "line")).toBe(true);
  });
  it("Polylinie mit Bogen-Segment → Bogen abgetastet (nicht nur die Sehne)", () => {
    const s = drawingPreviewShapes(project, {
      ...base,
      geom: { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }], closed: false, bulge: [0.5] },
    } as Drawing2D);
    expect(s.length).toBeGreaterThan(3);
  });
  it("Text → Rahmen-Polygon", () => {
    const p = { kind: "drawingText", at: { x: 0, y: 0 }, text: "Hallo", heightM: 1, angle: 0, color: "#000" } as unknown as Primitive;
    const s = primitivesToDraftShapes([p]);
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe("poly");
  });
});
