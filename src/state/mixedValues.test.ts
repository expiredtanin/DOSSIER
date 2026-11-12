// [195] Mehrfach-Werte: gleiche Werte → ein Wert, abweichende → leer (gemischt).
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { commonValue, selectionAppearance, selectionWallValues, selectedCount } from "./mixedValues";
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

describe("Mehrfachwerte Füllung/Typ/Masse [195b]", () => {
  const p = buildComplexSampleProject();
  const [a, b] = p.walls;
  const other = p.wallTypes.find((t) => t.id !== a.wallTypeId)!;
  const same = { ...p, walls: p.walls.map((w) => (w.id === b.id ? { ...w, wallTypeId: a.wallTypeId } : w)) };
  const sel = mergeSelection(EMPTY_SELECTION, { walls: [a.id, b.id] });

  it("gleicher Wandtyp → ein Wert; anderer Typ → Typ gemischt", () => {
    const v = selectionWallValues(same, sel);
    expect(v.wallTypeId).toEqual({ value: a.wallTypeId, mixed: false });
    expect(v.thickness.mixed).toBe(false);
    const changed = { ...p, walls: p.walls.map((w) => (w.id === b.id ? { ...w, wallTypeId: other.id } : w)) };
    expect(selectionWallValues(changed, sel).wallTypeId.mixed).toBe(true);
  });

  it("Schraffur: gleich → Wert, abweichend → gemischt", () => {
    expect(selectionAppearance(same, sel).hatch.mixed).toBe(false);
    const [h1, h2] = p.hatches.filter((x) => x.pattern !== "none");
    const changed = { ...same, walls: same.walls.map((w) => (w.id === a.id ? { ...w, hatchId: h1.id } : w.id === b.id ? { ...w, hatchId: h2.id } : w)) };
    expect(selectionAppearance(changed, sel).hatch.mixed).toBe(true);
  });
});
