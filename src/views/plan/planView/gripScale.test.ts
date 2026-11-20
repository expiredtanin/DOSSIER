// [314] Griffgrösse: zoomabhängig und bei eng liegenden Griffen kleiner.
import { describe, expect, it } from "vitest";
import { gripCrowdK, gripZoomK, minPairDistance } from "./constants";

describe("[314] Griffgrösse", () => {
  it("herausgezoomt deutlich kleiner, hineingezoomt kaum grösser, begrenzt", () => {
    expect(gripZoomK(1, 1)).toBe(1);
    expect(gripZoomK(0.1, 1)).toBeLessThan(0.5);
    expect(gripZoomK(0.0001, 1)).toBe(0.4);
    expect(gripZoomK(10, 1)).toBeLessThanOrEqual(1.25);
    expect(gripZoomK(Number.NaN, 1)).toBe(1);
  });
  it("eng liegende Griffe werden kleiner, weit liegende nicht", () => {
    expect(gripCrowdK(100, 4)).toBe(1);
    expect(gripCrowdK(10, 4)).toBeCloseTo(0.5);
    expect(gripCrowdK(1, 4)).toBe(0.4);
    expect(gripCrowdK(Infinity, 4)).toBe(1);
  });
  it("kleinster Abstand, doppelte Punkte zählen nicht, zu viele Punkte = Infinity", () => {
    expect(minPairDistance([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 0, y: 1 }])).toBe(1);
    expect(minPairDistance([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 }])).toBe(2);
    expect(minPairDistance([{ x: 0, y: 0 }])).toBe(Infinity);
    expect(minPairDistance(Array.from({ length: 5 }, (_, i) => ({ x: i, y: 0 })), 3)).toBe(Infinity);
  });
});
