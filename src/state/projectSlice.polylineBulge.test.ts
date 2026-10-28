/**
 * Bulge-Griffe der Polylinie (`drawingVertices`/`moveGripOf` in
 * `projectSlice.ts`): Segment-Mitte senkrecht zur Sehne ziehen krümmt genau
 * dieses Segment (s. `geometry/bulge.ts`).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { drawingVertices } from "./projectSlice";
import type { Drawing2D } from "../model/types";

const openPoly: Drawing2D = {
  id: "d-poly",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }], closed: false },
};

beforeEach(() => {
  setState({
    project: { ...sampleProject, drawings2d: [openPoly] },
    undoDepth: 0,
    redoDepth: 0,
    canUndo: false,
    canRedo: false,
  });
});

describe("drawingVertices — Polylinie mit Bulge-Griffen", () => {
  it("liefert 3 Eckpunkt- + 2 Segment-Bulge-Griffe (offen, ohne bulge → Sehnen-Mitte)", () => {
    const v = drawingVertices(openPoly);
    expect(v.length).toBe(5);
    expect(v.slice(0, 3)).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }]);
    // Ohne bulge sitzt der Griff auf der Sehnen-Mitte.
    expect(v[3]).toEqual({ x: 1, y: 0 });
    expect(v[4]).toEqual({ x: 3, y: 0 });
  });
});

describe("moveGripOf — Bulge-Griff einer Polylinie", () => {
  it("Ziehen des Segment-0-Griffs nach oben setzt bulge[0] > 0 (Bogen nach links von a→b)", () => {
    getState().moveGripOf("d-poly", null, 3, { x: 1, y: 1 }); // Griff-Index 3 = Segment 0
    const g = getState().project.drawings2d[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape === "polyline") {
      expect(g.bulge?.[0]).toBeGreaterThan(0);
      expect(g.bulge?.[0]).toBeCloseTo(1, 6); // Sagitta 1 bei Halb-Sehne 1 → bulge 1
      expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }]); // Eckpunkte unangetastet
    }
  });

  it("Ziehen nach unten setzt negativen bulge; Eckpunkt-Griffe bleiben normale Punkt-Griffe", () => {
    getState().moveGripOf("d-poly", null, 4, { x: 3, y: -0.5 }); // Griff-Index 4 = Segment 1
    let g = getState().project.drawings2d[0].geom;
    if (g.shape === "polyline") expect(g.bulge?.[1]).toBeLessThan(0);

    getState().moveGripOf("d-poly", null, 1, { x: 2, y: 5 }); // Eckpunkt-Griff (Index 1)
    g = getState().project.drawings2d[0].geom;
    if (g.shape === "polyline") expect(g.pts[1]).toEqual({ x: 2, y: 5 });
  });
});
