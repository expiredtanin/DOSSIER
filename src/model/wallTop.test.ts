import { describe, expect, it } from "vitest";
import { WALL_TOP_MODES, wallTopFromFields, wallTopPatch, wallTopNext } from "./wallTop";

describe("Wand-Oberkante [293]", () => {
  it("Felder und Auswahl sind umkehrbar", () => {
    for (const m of WALL_TOP_MODES) {
      const p = wallTopPatch(m);
      expect(wallTopFromFields(p.roofAttach, p.ceilingAttach)).toBe(m);
    }
  });
  it("Standard (nichts gesetzt) = Geschosshöhe", () => {
    expect(wallTopFromFields(undefined, undefined)).toBe("storey");
    expect(wallTopPatch("storey")).toEqual({ roofAttach: undefined, ceilingAttach: undefined });
  });
  it("Decke allein schaltet das Dach ab, tiefere lässt es automatisch", () => {
    expect(wallTopPatch("ceiling")).toEqual({ roofAttach: false, ceilingAttach: true });
    expect(wallTopPatch("lower")).toEqual({ roofAttach: undefined, ceilingAttach: true });
    expect(wallTopPatch("roof")).toEqual({ roofAttach: true, ceilingAttach: undefined });
  });
  it("reihum", () => {
    expect(wallTopNext("storey")).toBe("ceiling");
    expect(wallTopNext("lower")).toBe("storey");
  });
});
