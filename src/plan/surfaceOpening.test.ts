import { describe, expect, it } from "vitest";
import { surfaceOpeningGripPatch, surfaceOpeningGrips } from "./surfaceOpening";
import type { SurfaceOpeningInfo } from "./surfaceOpening";

// Dachfläche mit 45° Gefälle nach Süden (Höhe läuft nach +y): projizierte Höhenachse = cos 45°.
const s = Math.SQRT1_2;
const info: SurfaceOpeningInfo = {
  hostKind: "roof",
  hostId: "r",
  hostName: "DG",
  floorId: "dg",
  center: [2, 1, 3],
  ew: [1, 0, 0],
  eh: [0, s, s],
  corners: [],
  zBottom: 2.5,
  zTop: 3.5,
  slopeDeg: 45,
};

describe("Dachfenster-Griffe ([103])", () => {
  it("liegen in der Mitte und an den Kanten (Höhe projiziert)", () => {
    const g = surfaceOpeningGrips(info, 0.78, 1.18);
    expect(g[0]).toEqual({ x: 2, y: 1 });
    expect(g[1].x).toBeCloseTo(2.39);
    expect(g[2].y).toBeCloseTo(1 + 0.59 * s);
  });

  it("rechnet einen Zug in Lage, Breite und Höhe in der Dachebene um", () => {
    expect(surfaceOpeningGripPatch(info, 0, { x: 3, y: 4 })).toEqual({ hostPoint: { x: 3, y: 4 } });
    expect(surfaceOpeningGripPatch(info, 1, { x: 2.5, y: 7 })).toEqual({ width: 1 });
    // 0.5 m im Grundriss entlang des Gefälles = 0.5/cos45° in der Fläche, beidseitig.
    expect(surfaceOpeningGripPatch(info, 2, { x: 2, y: 1.5 })!.height).toBeCloseTo(2 * 0.5 / s, 3);
    expect(surfaceOpeningGripPatch(info, 1, { x: 2.01, y: 1 })).toBeNull();
  });
});
