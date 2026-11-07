import { describe, expect, it } from "vitest";
import type { Tree } from "../model/types";
import { treeGripPatch, treeGripPoints } from "./treeGrips";

const base = {
  id: "b",
  type: "tree",
  floorId: "eg",
  categoryCode: "13",
  position: { x: 2, y: 3 },
  trunkDiameter: 0.4,
  crownDiameter: 6,
  crownBase: 3,
  height: 12,
  shape: "round",
  status: "new",
  foliage: "deciduous",
} as unknown as Tree;

describe("[149] Baum-Griffe", () => {
  it("Beschriftungs-Griff nur mit gezeigter Beschriftung, Vorgabe rechts neben dem Stamm", () => {
    expect(treeGripPoints(base, 100)).toHaveLength(2);
    const t = { ...base, showLabel: true, species: "Quercus" };
    const g = treeGripPoints(t, 100)[2];
    expect(g.x).toBeCloseTo(2.3, 12);
    expect(g.y).toBe(3);
    expect(treeGripPoints({ ...t, labelOffset: { x: -1, y: 2 } }, 100)[2]).toEqual({ x: 1, y: 5 });
  });

  it("Ziehen: Stammmitte, Kronendurchmesser, Beschriftungs-Versatz ab Stammmitte (Kern-Test plan::trees)", () => {
    const t = { ...base, showLabel: true, species: "Quercus" };
    expect(treeGripPatch(t, 0, { x: 5, y: 5 })).toEqual({ position: { x: 5, y: 5 } });
    expect(treeGripPatch(t, 1, { x: 2, y: 6 })).toEqual({ crownDiameter: 6 });
    const patch = treeGripPatch(t, 2, { x: 0, y: 7 });
    expect(patch).toEqual({ labelOffset: { x: -2, y: 4 } });
  });
});
