import { describe, expect, it } from "vitest";
import type { Railing } from "../model/types";
import { railingGripPatch, railingGripPoints } from "./railingGrips";

const base = {
  id: "g",
  type: "railing",
  floorId: "eg",
  categoryCode: "41",
  points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }],
  height: 1,
  kind: "bars",
} as unknown as Railing;

describe("[279] Geländer-Griffe", () => {
  it("ein Griff je Achsenpunkt", () => {
    expect(railingGripPoints(base)).toEqual([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }]);
  });

  it("Ziehen ersetzt genau diesen Punkt; Unsinn ändert nichts", () => {
    expect(railingGripPatch(base, 1, { x: 4, y: 1 })).toEqual({ points: [{ x: 0, y: 0 }, { x: 4, y: 1 }, { x: 3, y: 2 }] });
    expect(railingGripPatch(base, 5, { x: 4, y: 1 })).toEqual({});
    expect(railingGripPatch(base, -1, { x: 4, y: 1 })).toEqual({});
    expect(railingGripPatch(base, 0, { x: NaN, y: 1 })).toEqual({});
  });

  it("[291] gebunden an Treppe oder Deckenkante: keine Griffe", () => {
    expect(railingGripPoints({ ...base, stairId: "t1" })).toEqual([]);
    expect(railingGripPoints({ ...base, ceilingId: "d1", edgeIndex: 0 })).toEqual([]);
    expect(railingGripPatch({ ...base, stairId: "t1" }, 1, { x: 4, y: 1 })).toEqual({});
  });
});
