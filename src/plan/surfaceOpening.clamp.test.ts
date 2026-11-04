// [103] Dachfenster bleiben beim Ziehen auf der Dachfläche (`clampInside`).
import { describe, expect, it } from "vitest";
import { clampInside } from "./surfaceOpening";

const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];

describe("clampInside", () => {
  it("innen: unverändert", () => {
    expect(clampInside({ x: 1, y: 1 }, sq)).toEqual({ x: 1, y: 1 });
  });
  it("aussen: auf den Rand, leicht nach innen", () => {
    const q = clampInside({ x: 6, y: 1.5 }, sq);
    expect(q.x).toBeLessThan(4);
    expect(q.x).toBeGreaterThan(3.9);
    expect(q.y).toBeCloseTo(1.5, 1);
  });
});
