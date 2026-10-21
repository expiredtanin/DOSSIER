import { describe, expect, it } from "vitest";
import type { SectionCutPolygon } from "./toSection";
import { mergeMonolithCuts, unionRectOutlines } from "./toSection";

const band = (index: number, u0: number, u1: number, v0: number, v1: number): SectionCutPolygon => ({
  component: { kind: "slab", index },
  color: [1, 1, 1],
  pts: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
});

describe("unionRectOutlines", () => {
  it("drei überlappende Tritte → ein Sägezahn-Umriss", () => {
    const rings = unionRectOutlines([
      { uMin: 0, uMax: 0.3, vMin: 0, vMax: 0.2 },
      { uMin: 0.3, uMax: 0.6, vMin: 0.05, vMax: 0.4 },
      { uMin: 0.6, uMax: 0.9, vMin: 0.25, vMax: 0.6 },
    ]);
    expect(rings.length).toBe(1);
    // Fläche = Summe minus nichts (keine Überlappung in der Fläche, nur Kanten).
    const area = rings[0].reduce((a, p, i, r) => {
      const q = r[(i + 1) % r.length];
      return a + (p[0] * q[1] - q[0] * p[1]) / 2;
    }, 0);
    expect(area).toBeCloseTo(0.3 * 0.2 + 0.3 * 0.35 + 0.3 * 0.35, 9);
  });
  it("getrennte Flächen → getrennte Ringe", () => {
    expect(unionRectOutlines([
      { uMin: 0, uMax: 1, vMin: 0, vMax: 1 },
      { uMin: 2, uMax: 3, vMin: 0, vMax: 1 },
    ]).length).toBe(2);
  });
});

describe("mergeMonolithCuts", () => {
  it("vereint nur Bänder derselben Gruppe", () => {
    const cuts = [band(0, 0, 1, 2.4, 2.6), band(5, 0, 0.3, 0, 0.2), band(6, 0.3, 0.6, 0.05, 0.4)];
    const out = mergeMonolithCuts(cuts, (i) => (i >= 5 ? "ST1" : undefined));
    expect(out.length).toBe(2);
    expect(out[0]).toBe(cuts[0]);
    expect(out[1].pts.length).toBe(8); // zwei versetzte Rechtecke → 8 Ecken
  });
});
