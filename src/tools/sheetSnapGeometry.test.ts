import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../model/types";
import type { Primitive } from "../plan/generatePlan";
import { computeSnap } from "./snapping";
import { setSheetSnapSegments, snapSegmentsFromPrimitives } from "./sheetSnapGeometry";
import { DEFAULT_SNAP } from "./types";

const HATCH = { pattern: "none", scale: 1, angle: 0, color: "#000", lineWeight: 0.1, dash: null } as const;

const rect = (x0: number, y0: number, x1: number, y1: number): Primitive => ({
  kind: "polygon",
  pts: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
  fill: "#fff",
  stroke: "#000",
  strokeWidthMm: 0.35,
  hatch: { ...HATCH },
});

const emptyProject = (): Project =>
  ({
    id: "p",
    name: "P",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [{ id: "s", name: "S", kind: "section", visible: true, locked: false }],
    layers: [],
    walls: [],
    drawings2d: [],
    context: [],
  }) as unknown as Project;

describe("snapSegmentsFromPrimitives", () => {
  it("Polygon-Kanten + Linien, geteilte Fugen nur einmal", () => {
    // Zwei Bänder teilen die Kante x = 1.
    const segs = snapSegmentsFromPrimitives([rect(0, 0, 1, 2), rect(1, 0, 2, 2)]);
    expect(segs.length).toBe(7);
  });
});

describe("computeSnap — abgeleitete Blatt-Geometrie (Schnitt/Ansicht)", () => {
  afterEach(() => setSheetSnapSegments("s", null));

  const snapAt = (x: number, y: number, levelId = "s") =>
    computeSnap({
      raw: { x, y },
      project: emptyProject(),
      levelId,
      visibleCodes: new Set(),
      settings: { ...DEFAULT_SNAP, grid: false },
      draftPoints: [],
      lastPoint: null,
      pxPerMeter: 100,
      shift: false,
      ctrl: false,
    });

  it("fängt an Ecken der Schnitt-Poché", () => {
    setSheetSnapSegments("s", snapSegmentsFromPrimitives([rect(0, 0, 0.3, 2.6)]));
    const r = snapAt(0.32, 2.58);
    expect(r?.kind).toBe("endpoint");
    expect(r?.point.x).toBeCloseTo(0.3, 9);
    expect(r?.point.y).toBeCloseTo(2.6, 9);
  });

  it("gilt nur für die eigene Ebene", () => {
    setSheetSnapSegments("s", snapSegmentsFromPrimitives([rect(0, 0, 0.3, 2.6)]));
    expect(snapAt(0.32, 2.58, "andere")?.kind).not.toBe("endpoint");
  });
});
