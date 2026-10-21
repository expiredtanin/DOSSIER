import { describe, expect, it } from "vitest";
import type { Vec3 } from "../../geometry/roof";
import { mitredRoofOffsets } from "./roofs";

// Walmdach 12×7 m: zwei Trapeze + zwei Walm-Dreiecke, First (3,3)-(8,3).
const planes: Vec3[][] = [
  [[-0.5, -0.5, 5.2], [11.5, -0.5, 5.2], [8, 3, 7.061], [3, 3, 7.061]],
  [[-0.5, 6.5, 5.2], [11.5, 6.5, 5.2], [8, 3, 7.061], [3, 3, 7.061]],
  [[-0.5, -0.5, 5.2], [-0.5, 6.5, 5.2], [3, 3, 7.061]],
  [[11.5, -0.5, 5.2], [11.5, 6.5, 5.2], [8, 3, 7.061]],
];

const near = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;

describe("mitredRoofOffsets", () => {
  const m = mitredRoofOffsets(planes);
  it("erkennt First und Grate als geteilte Kanten, Traufen als frei", () => {
    expect(m.shared[0]).toEqual([false, true, true, true]); // Traufe, Grat, First, Grat
    expect(m.shared[2]).toEqual([false, true, true]);
  });
  it("Unterseiten treffen sich am First-Apex in EINEM Punkt (Gehrung statt Durchdringung)", () => {
    const d = 0.27;
    const apexA = m.at(0, d)[3]; // (3,3) der Trapezfläche
    const apexB = m.at(1, d)[3];
    const apexC = m.at(2, d)[2]; // Walm-Spitze
    expect(near(apexA, apexB)).toBe(true);
    expect(near(apexA, apexC)).toBe(true);
    expect(apexA[2]).toBeLessThan(7.061);
  });
  it("Versatz 0 = Originalfläche, freie Traufecke bleibt senkrecht versetzt", () => {
    expect(m.at(0, 0)).toEqual(planes[0]);
    const eaves = m.at(0, 0.2)[0];
    // Traufecke (−0.5,−0.5) teilt den Grat mit dem Walm → gehrt, aber Höhe unter der Traufe.
    expect(eaves[2]).toBeLessThan(5.2);
  });
});
