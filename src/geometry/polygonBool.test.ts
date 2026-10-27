import { describe, expect, it } from "vitest";
import { difference, intersection, union } from "./polygonBool";
import type { MultiPolygon, Ring } from "./polygonBool";

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const ringArea = (r: Ring) => {
  let a = 0;
  for (let i = 0; i + 1 < r.length; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return a / 2;
};
const area = (mp: MultiPolygon) => mp.reduce((s, p) => s + p.reduce((t, r) => t + ringArea(r), 0), 0);

describe("Polygon-Booleans aus dem Rust-Kern", () => {
  it("Vereinigung mit Polygon- und MultiPolygon-Eingaben, Ringe geschlossen", () => {
    const u = union([rect(0, 0, 2, 1)], [[rect(1, 0, 3, 1).reverse()]]);
    expect(u).toHaveLength(1);
    expect(area(u)).toBeCloseTo(3, 9);
    const r = u[0][0];
    expect(r[0]).toEqual(r[r.length - 1]);
  });
  it("Differenz mit Loch, Schnitt über mehrere Argumente", () => {
    const d = difference([rect(0, 0, 4, 4)], [rect(1, 1, 2, 2)], [rect(3, 3, 5, 5)]);
    expect(area(d)).toBeCloseTo(16 - 1 - 1, 9);
    expect(d[0].length).toBe(2);
    const i = intersection([rect(0, 0, 4, 4)], [rect(1, 1, 5, 5)], [rect(0, 2, 5, 5)]);
    expect(area(i)).toBeCloseTo(3 * 2, 9);
  });
  it("leer und Unsinn", () => {
    expect(union([])).toEqual([]);
    expect(intersection([rect(0, 0, 1, 1)], [rect(5, 5, 6, 6)])).toEqual([]);
    expect(union([[[Number.NaN, 0], [1, 0]]])).toEqual([]);
  });
});
