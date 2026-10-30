import { describe, expect, it } from "vitest";
import type { Project, Roof } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { affectedKeys, dormerKey, dormerStatus, newlyAffected } from "./dormerStatus";

/** Satteldach 10 × 8 m, 45°, First bei y = 4, mit einer Sattelgaube bei y = 1. */
function withDormer(frontHeight: number): Project {
  const roof = {
    id: "R1",
    type: "roof",
    floorId: "F",
    categoryCode: "35",
    outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }],
    shape: "sattel",
    pitchDeg: 45,
    overhang: 0.5,
    ridgeAxis: "x",
    baseElevation: 3,
    thickness: 0.3,
    dormers: [{ id: "D1", kind: "sattel", position: { x: 3, y: 1 }, width: 2.4, frontHeight }],
  } as unknown as Roof;
  return { ...sampleProject, roofs: [roof] };
}

describe("dormerStatus [G5]", () => {
  it("meldet nichts ohne Gauben", () => {
    expect(dormerStatus({ ...sampleProject, roofs: [] })).toEqual([]);
  });

  it("meldet die am First gekappte Gaube mit tatsächlicher Höhe", () => {
    const ok = dormerStatus(withDormer(1.6));
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ roofId: "R1", dormerId: "D1", clamped: false, invalid: false });
    const hi = dormerStatus(withDormer(6));
    expect(hi[0].clamped).toBe(true);
    expect(hi[0].effectiveHeight).toBeLessThan(6);
    expect(hi[0].effectiveHeight).toBeGreaterThan(0.3);
  });

  it("newlyAffected nur beim Übergang auf gekappt", () => {
    const before = affectedKeys(dormerStatus(withDormer(1.6)));
    const now = dormerStatus(withDormer(6));
    expect(newlyAffected(before, now).map(dormerKey)).toEqual(["R1/D1"]);
    expect(newlyAffected(affectedKeys(now), now)).toEqual([]);
  });
});
