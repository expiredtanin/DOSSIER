import { describe, expect, it } from "vitest";
import { polylineEdgeGrips } from "./edgeGrips";

const sq = [
  { x: 0, y: 0 },
  { x: 30, y: 0 },
  { x: 30, y: 30 },
  { x: 0, y: 30 },
];

describe("polylineEdgeGrips", () => {
  it("geschlossen, gerade: 4 Kanten auf den Seitenmitten, Normalen nach aussen", () => {
    const e = polylineEdgeGrips({ shape: "polyline", pts: sq, closed: true }, { drawingId: "d" });
    expect(e.map((g) => g.mid)).toEqual([
      { x: 15, y: 0 },
      { x: 30, y: 15 },
      { x: 15, y: 30 },
      { x: 0, y: 15 },
    ]);
    expect(e.map((g) => [g.aIndex, g.bIndex])).toEqual([[0, 1], [1, 2], [2, 3], [3, 0]]);
    expect(e[0].normal.y).toBeCloseTo(-1);
    expect(e[1].normal.x).toBeCloseTo(1);
  });

  it("geschlossen mit Bögen: nur gerade Seiten, keine Kanten über die Bogen-Mitten (nichts im Innern)", () => {
    const e = polylineEdgeGrips(
      { shape: "polyline", pts: sq, closed: true, bulge: [0.12, 0, -0.15, 0] },
      { drawingId: "d" },
    );
    expect(e.map((g) => g.mid)).toEqual([
      { x: 30, y: 15 },
      { x: 0, y: 15 },
    ]);
    // Lauter Bögen (Strassenparzelle): keine Kanten-Griffe.
    expect(polylineEdgeGrips({ shape: "polyline", pts: sq, closed: true, bulge: [0.1, 0.1, 0.1, 0.1] }, {})).toEqual([]);
  });

  it("offen: je gerades Segment ein freier Griff, ohne Schlusskante", () => {
    const e = polylineEdgeGrips({ shape: "polyline", pts: sq, closed: false, bulge: [0, 0.3, 0] }, {});
    expect(e.map((g) => [g.aIndex, g.bIndex, g.free])).toEqual([[0, 1, true], [2, 3, true]]);
  });
});
