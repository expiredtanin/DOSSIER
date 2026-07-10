// Decken-Terminierung im 2D-Schnitt (applyWallTermination) — der Spiegel von
// terminateOrSubtractSpans (3D): Wände mit sliceTermination "below" enden an
// der Decken-Unterkante, "above" beginnen an der Oberkante; "both"/undefined
// bleibt bei der reinen Prioritäts-Subtraktion (unverändert hier).

import { describe, it, expect } from "vitest";
import { applyWallTermination } from "./toSection";
import type { SectionCutPolygon } from "./toSection";
import type { Wall } from "../model/types";

const rect = (
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
): Array<[number, number]> => [
  [uMin, vMax],
  [uMax, vMax],
  [uMax, vMin],
  [uMin, vMin],
];

const wallBand = (joinPriority: number | undefined, pts = rect(0, 0.3, 0, 2.6)): SectionCutPolygon => ({
  component: { kind: "wall", index: 0 },
  color: [0.8, 0.8, 0.8],
  pts,
  joinPriority,
});

const slabBand = (joinPriority: number, vMin: number, vMax: number, uMin = -2, uMax = 2): SectionCutPolygon => ({
  component: { kind: "slab", index: 0 },
  color: [0.9, 0.9, 0.9],
  pts: rect(uMin, uMax, vMin, vMax),
  joinPriority,
});

const wall = (sliceTermination?: Wall["sliceTermination"]): Wall =>
  ({
    id: "W1",
    start: { x: 0, y: 0 },
    end: { x: 5, y: 0 },
    height: 2.6,
    wallTypeId: "wt",
    floorId: "eg",
    categoryCode: "21",
    sliceTermination,
  }) as Wall;

const bbox = (cp: SectionCutPolygon) => {
  const vs = cp.pts.map((p) => p[1]);
  return { vMin: Math.min(...vs), vMax: Math.max(...vs) };
};

describe("applyWallTermination — 2D-Schnitt = 3D-Terminierung", () => {
  it("'below': Wand-Band endet an der Unterkante der dominanten Decke", () => {
    const bands = [wallBand(50), slabBand(100, 2.2, 2.5)];
    const out = applyWallTermination(bands, [wall("below")]);
    const wb = out.find((b) => b.component.kind === "wall")!;
    expect(bbox(wb).vMax).toBeCloseTo(2.2, 9);
    expect(bbox(wb).vMin).toBeCloseTo(0, 9);
  });

  it("'above': Wand-Band beginnt an der Oberkante der dominanten Decke", () => {
    const bands = [wallBand(50), slabBand(100, 2.2, 2.5)];
    const out = applyWallTermination(bands, [wall("above")]);
    const wb = out.find((b) => b.component.kind === "wall")!;
    expect(bbox(wb).vMin).toBeCloseTo(2.5, 9);
    expect(bbox(wb).vMax).toBeCloseTo(2.6, 9);
  });

  it("'both'/undefined: Band bleibt unverändert (Prioritäts-Subtraktion regelt)", () => {
    const bands = [wallBand(50), slabBand(100, 2.2, 2.5)];
    for (const term of ["both", undefined] as const) {
      const out = applyWallTermination(bands, [wall(term)]);
      const wb = out.find((b) => b.component.kind === "wall")!;
      expect(wb.pts).toEqual(rect(0, 0.3, 0, 2.6));
    }
  });

  it("nur STRIKT dominante Decken terminieren (schwächere/gleiche nicht)", () => {
    for (const prio of [50, 10]) {
      const bands = [wallBand(50), slabBand(prio, 2.2, 2.5)];
      const out = applyWallTermination(bands, [wall("below")]);
      const wb = out.find((b) => b.component.kind === "wall")!;
      expect(bbox(wb).vMax).toBeCloseTo(2.6, 9);
    }
  });

  it("ohne u-Überlapp keine Terminierung; Band unter der Decken-UK verschwindet nicht", () => {
    // Decke liegt in u komplett rechts neben der Wand.
    const far = [wallBand(50), slabBand(100, 2.2, 2.5, 5, 8)];
    const outFar = applyWallTermination(far, [wall("below")]);
    expect(bbox(outFar.find((b) => b.component.kind === "wall")!).vMax).toBeCloseTo(2.6, 9);

    // Decke UNTER dem Wandfuss ⇒ 'below'-Clip entfernt das ganze Band.
    const under = [wallBand(50), slabBand(100, -0.5, -0.2)];
    const outUnder = applyWallTermination(under, [wall("below")]);
    expect(outUnder.some((b) => b.component.kind === "wall")).toBe(false);
  });

  it("Bänder ohne joinPriority (unauflösbares Bauteil) bleiben unangetastet", () => {
    const bands = [wallBand(undefined), slabBand(100, 2.2, 2.5)];
    const out = applyWallTermination(bands, [wall("below")]);
    expect(out.find((b) => b.component.kind === "wall")!.pts).toEqual(rect(0, 0.3, 0, 2.6));
  });
});
