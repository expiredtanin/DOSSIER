import { describe, expect, it } from "vitest";
import type { FrameCornerJoin } from "../../model/types";
import { frameRingQuads } from "./openings";

type Q = ReturnType<typeof frameRingQuads>[number];
// Eckenfolge (from,UK),(to,UK),(from,OK),(to,OK) → als Ring 0,1,3,2.
const ring = (q: Q) => [q[0], q[1], q[3], q[2]];
const area = (q: Q) => {
  const r = ring(q);
  let a = 0;
  for (let i = 0; i < 4; i++) a += r[i][0] * r[(i + 1) % 4][1] - r[(i + 1) % 4][0] * r[i][1];
  return Math.abs(a) / 2;
};

describe("frameRingQuads", () => {
  const modes: FrameCornerJoin[] = ["vertikal", "horizontal", "gehrung"];
  for (const mode of modes) {
    it(`${mode}: Profile decken genau den Ring ab (keine Überlappung)`, () => {
      const qs = frameRingQuads(0, 1.2, 0.9, 2.1, 0.06, mode, true);
      expect(qs.length).toBe(4);
      const total = qs.reduce((a, q) => a + area(q), 0);
      const ringArea = 1.2 * 1.2 - (1.2 - 0.12) * (1.2 - 0.12);
      expect(total).toBeCloseTo(ringArea, 9);
    });
    it(`${mode}: ohne Schwelle (Tür) drei Profile`, () => {
      const qs = frameRingQuads(0, 1.0, 0, 2.1, 0.06, mode, false);
      expect(qs.length).toBe(3);
      const total = qs.reduce((a, q) => a + area(q), 0);
      expect(total).toBeCloseTo(1.0 * 2.1 - (1.0 - 0.12) * (2.1 - 0.06), 9);
    });
  }
  it("vertikal: Pfosten laufen durch, Riegel dazwischen", () => {
    const [left] = frameRingQuads(0, 1, 0, 1, 0.1, "vertikal", true);
    expect(left[0]).toEqual([0, 0]);
    expect(left[3]).toEqual([0.1, 1]);
  });
});
