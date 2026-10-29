import { describe, expect, it } from "vitest";
import { circlePoints } from "./vbCircle";

describe("circlePoints", () => {
  it("Vieleck um den Mittelpunkt, auch bei LV95-viewBox-Koordinaten (≈ 2.3e8)", () => {
    const cx = 2_600_068 * 90;
    const cy = -1_200_068 * 90;
    const pts = circlePoints(cx, cy, 4).split(" ").map((p) => p.split(",").map(Number));
    expect(pts).toHaveLength(24);
    for (const [x, y] of pts) expect(Math.hypot(x - cx, y - cy)).toBeCloseTo(4, 6);
  });

  it("unsinnige Eingaben ergeben kein Vieleck", () => {
    expect(circlePoints(Number.NaN, 0, 1)).toBe("");
    expect(circlePoints(0, 0, -1)).toBe("");
  });
});
