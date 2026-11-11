import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  clearKinds,
  emptySelection,
  fromIdLists,
  fromIds,
  hasTransformable,
  isEmpty,
  mergeSelection,
  primaryKind,
  single,
  toCommandSelection,
  toIdLists,
  toTransformSelection,
} from "./selection";
import { hasTransformSelection } from "../tools/transform";

describe("Selection", () => {
  it("leer: alle Arten leer, geteilt und eingefroren", () => {
    expect(emptySelection()).toBe(EMPTY_SELECTION);
    expect(isEmpty(EMPTY_SELECTION)).toBe(true);
    expect(primaryKind(EMPTY_SELECTION)).toBeNull();
    expect(() => (EMPTY_SELECTION.walls as string[]).push("x")).toThrow();
  });

  it("fromIds / single / primaryKind", () => {
    const s = fromIds("walls", ["w1"]);
    expect(s.walls).toEqual(["w1"]);
    expect(s.drawings).toBe(EMPTY_SELECTION.drawings);
    expect(single(s, "walls")).toBe("w1");
    expect(single(fromIds("walls", ["a", "b"]), "walls")).toBeNull();
    expect(primaryKind(s)).toBe("walls");
    // 2D-Elemente haben Vorrang (wie die Objekt-Info)
    expect(primaryKind(mergeSelection(s, { drawings: ["d"] }))).toBe("drawings");
  });

  it("isEmpty ohne Gruppen", () => {
    const g = fromIds("groups", ["g1"]);
    expect(isEmpty(g)).toBe(false);
    expect(isEmpty(g, { withGroups: false })).toBe(true);
  });

  it("mergeSelection hält Referenzen stabil", () => {
    const a = fromIds("walls", ["w1", "w2"]);
    expect(mergeSelection(a, {})).toBe(a);
    expect(mergeSelection(a, { walls: ["w1", "w2"] })).toBe(a);
    expect(mergeSelection(a, { drawings: [] })).toBe(a);
    const b = mergeSelection(a, { ceilings: ["c"] });
    expect(b).not.toBe(a);
    expect(b.walls).toBe(a.walls);
    expect(b.ceilings).toEqual(["c"]);
    const c = mergeSelection(b, { ceilings: [] });
    expect(c.ceilings).toBe(EMPTY_SELECTION.ceilings);
    // Reihenfolge zählt
    expect(mergeSelection(a, { walls: ["w2", "w1"] }).walls).toEqual(["w2", "w1"]);
  });

  it("clearKinds leert Element-Arten, Gruppen bleiben", () => {
    const s = mergeSelection(EMPTY_SELECTION, { walls: ["w"], groups: ["g"], sectionLines: ["l"] });
    const t = mergeSelection(s, clearKinds());
    expect(t.walls).toEqual([]);
    expect(t.sectionLines).toEqual([]);
    expect(t.groups).toEqual(["g"]);
    expect(mergeSelection(s, clearKinds("walls")).sectionLines).toEqual(["l"]);
  });

  it("toCommandSelection / toTransformSelection: Einzel-Körper/Stütze nur bei genau einem", () => {
    const s = mergeSelection(EMPTY_SELECTION, {
      walls: ["w"],
      drawings: ["d"],
      solids: ["x1", "x2"],
      columns: ["c"],
      roofs: ["r"],
    });
    const c = toCommandSelection(s);
    expect(c).toEqual({
      wallIds: ["w"],
      drawingId: "d",
      drawingIds: ["d"],
      extrudedSolidId: null,
      columnId: "c",
      ceilingIds: [],
      roofIds: ["r"],
      stairIds: [],
      roomIds: [],
      openingIds: [],
      treeIds: [],
      contextIds: [],
    });
    expect(toTransformSelection(s)).toEqual(c);
  });

  it("hasTransformable = hasTransformSelection des Befehlskontexts", () => {
    const cases = [
      EMPTY_SELECTION,
      fromIds("walls", ["w"]),
      fromIds("drawings", ["a", "b"]),
      fromIds("solids", ["x"]),
      fromIds("solids", ["x", "y"]),
      fromIds("columns", ["c"]),
      fromIds("openings", ["o"]),
      fromIds("contextObjects", ["k"]),
      fromIds("rooms", ["r"]),
    ];
    for (const s of cases) expect(hasTransformable(s)).toBe(hasTransformSelection(toCommandSelection(s)));
  });

  it("toIdLists / fromIdLists", () => {
    const s = mergeSelection(EMPTY_SELECTION, { walls: ["w"], solids: ["x"], groups: ["g"] });
    const l = toIdLists(s);
    expect(l.wallIds).toBe(s.walls);
    expect(l.extrudedSolidIds).toEqual(["x"]);
    expect(l.groupIds).toEqual(["g"]);
    expect(fromIdLists({ wallIds: ["a"], roofIds: [] })).toEqual({ walls: ["a"], roofs: [] });
    expect(mergeSelection(EMPTY_SELECTION, fromIdLists(l))).toEqual(s);
  });
});
