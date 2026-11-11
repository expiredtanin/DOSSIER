// [195] Mehrfach-Werte: gleiche Werte → ein Wert, abweichende → leer (gemischt).
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { commonValue, selectionAppearance, selectedCount } from "./mixedValues";
import { EMPTY_SELECTION, mergeSelection } from "./selection";

describe("commonValue [195]", () => {
  it("gleich → Wert, abweichend → gemischt, leer → weder noch", () => {
    expect(commonValue([0.25, 0.25])).toEqual({ value: 0.25, mixed: false });
    expect(commonValue([0.25, 0.5])).toEqual({ value: undefined, mixed: true });
    expect(commonValue([])).toEqual({ value: undefined, mixed: false });
    expect(commonValue(["#000"])).toEqual({ value: "#000", mixed: false });
  });
});

describe("selectionAppearance [195]", () => {
  const p = buildComplexSampleProject();
  const w = p.walls.slice(0, 2).map((x) => x.id);

  it("zwei Wände mit gleicher Strichstärke → ein Wert", () => {
    const sel = mergeSelection(EMPTY_SELECTION, { walls: [w[0], w[0]] });
    const a = selectionAppearance(p, sel);
    expect(a.weightMm.mixed).toBe(false);
    expect(typeof a.weightMm.value).toBe("number");
  });

  it("abweichende Strichstärke → gemischt", () => {
    const q = { ...p, walls: p.walls.map((x) => (x.id === w[1] ? { ...x, strokeWeight: 1.7 } : x)) };
    const sel = mergeSelection(EMPTY_SELECTION, { walls: w });
    const a = selectionAppearance(q, sel);
    expect(a.count).toBe(2);
    expect(a.weightMm).toEqual({ value: undefined, mixed: true });
  });

  it("Zählung ohne Gruppen und Lage-Marker", () => {
    const sel = mergeSelection(EMPTY_SELECTION, { walls: [w[0]], groups: ["g"], site: ["sunStudy"] });
    expect(selectedCount(sel)).toBe(1);
  });
});
