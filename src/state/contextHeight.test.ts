import { describe, expect, it } from "vitest";
import { contourHeightPatch, heightOffsetPatch } from "./contextHeight";
import type { ContextObject } from "../model/types";

const base = { id: "a", name: "A", categoryCode: "02" };
const set = { ...base, type: "contourSet", contours: [{ z: 500, pts: [], closed: false }, { z: 501, pts: [], closed: false }] } as ContextObject;

describe("Höhe von Gelände-Elementen", () => {
  it("Netz: nur z wird versetzt", () => {
    const o = { ...base, type: "terrainMesh", positions: [0, 0, 5, 1, 0, 6, 0, 1, 7], indices: [0, 1, 2] } as ContextObject;
    expect(heightOffsetPatch(o, -1.5)).toEqual({ positions: [0, 0, 3.5, 1, 0, 4.5, 0, 1, 5.5] });
  });
  it("Höhenlinien und Baugrube", () => {
    expect(heightOffsetPatch(set, 2)).toEqual({ contours: [{ z: 502, pts: [], closed: false }, { z: 503, pts: [], closed: false }] });
    expect(heightOffsetPatch({ ...base, type: "excavation", outline: [], bottom: -3 } as ContextObject, 0.5)).toEqual({ bottom: -2.5 });
  });
  it("keine Änderung bei 0/NaN; Höhe einer Linie", () => {
    expect(heightOffsetPatch(set, 0)).toBeNull();
    expect(heightOffsetPatch(set, NaN)).toBeNull();
    expect(contourHeightPatch(set, 1, 510)).toEqual({ contours: [{ z: 500, pts: [], closed: false }, { z: 510, pts: [], closed: false }] });
    expect(contourHeightPatch(set, 1, 501)).toBeNull();
    expect(contourHeightPatch(set, 7, 1)).toBeNull();
  });
});
