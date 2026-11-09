// [103]/[145] Dachfenster bleiben beim Ziehen auf der Dachfläche; `clampInside` rechnet der Kern
// (`opening_slide::clamp_inside`), dieselbe Klemmung wie beim Verschieben-Befehl.
import { describe, expect, it } from "vitest";
import { clampInside } from "../core";

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
  it("zu wenige Ecken: unverändert", () => {
    expect(clampInside({ x: 9, y: 9 }, sq.slice(0, 2))).toEqual({ x: 9, y: 9 });
  });
});
