import { describe, expect, it } from "vitest";
import { moveSheetIds } from "./sheetOrder";

describe("moveSheetIds", () => {
  const ids = ["a", "b", "c"];
  it("dritte vor die erste", () => expect(moveSheetIds(ids, "c", 0)).toEqual(["c", "a", "b"]));
  it("erste ans Ende", () => expect(moveSheetIds(ids, "a", 3)).toEqual(["b", "c", "a"]));
  it("erste hinter die zweite (Stelle zählt in der alten Liste)", () => expect(moveSheetIds(ids, "a", 2)).toEqual(["b", "a", "c"]));
  it("Stelle direkt vor/nach sich selbst: unverändert (gleiche Liste)", () => {
    expect(moveSheetIds(ids, "b", 1)).toBe(ids);
    expect(moveSheetIds(ids, "b", 2)).toBe(ids);
  });
  it("unbekannte id und Stelle ausserhalb", () => {
    expect(moveSheetIds(ids, "x", 0)).toBe(ids);
    expect(moveSheetIds(ids, "c", -5)).toEqual(["c", "a", "b"]);
    expect(moveSheetIds(ids, "a", 99)).toEqual(["b", "c", "a"]);
  });
});
