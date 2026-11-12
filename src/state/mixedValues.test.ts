// [195] Mehrfach-Werte: gleiche Werte → ein Wert, abweichende → leer (gemischt).
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { commonValue, selectionAppearance, selectionWallValues, selectedCount, selectionCeilingValues, selectionOpeningValues, selectionRoofValues, selectionWallHeights } from "./mixedValues";
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


describe("Mehrfachwerte Decke, Dach, Öffnung, Höhen [195b]", () => {
  const p = buildComplexSampleProject();

  it("Decken: gleiche Werte → ein Wert, abweichende Oberkante → gemischt", () => {
    const [a, b] = p.ceilings!.slice(0, 2).map((c) => c.id);
    const same = selectionCeilingValues(p, mergeSelection(EMPTY_SELECTION, { ceilings: [a, a] }));
    expect(same.thickness.mixed).toBe(false);
    expect(same.top.mixed).toBe(false);
    const q = {
      ...p,
      ceilings: p.ceilings!.map((c) => (c.id === b ? { ...c, top: { mode: "custom" as const, z: 17.5 } } : c)),
    };
    const mixed = selectionCeilingValues(q, mergeSelection(EMPTY_SELECTION, { ceilings: [a, b] }));
    expect(mixed.top).toEqual({ value: undefined, mixed: true });
  });

  it("Dächer: abweichende Neigung/Typ → gemischt", () => {
    const [a, b] = p.roofs!.slice(0, 2).map((r) => r.id);
    const q = { ...p, roofs: p.roofs!.map((r) => (r.id === a ? { ...r, pitchDeg: 20, roofTypeId: undefined } : r.id === b ? { ...r, pitchDeg: 35, roofTypeId: "x" } : r)) };
    const v = selectionRoofValues(q, mergeSelection(EMPTY_SELECTION, { roofs: [a, b] }));
    expect(v.pitchDeg.mixed).toBe(true);
    expect(v.roofTypeId.mixed).toBe(true);
    const one = selectionRoofValues(q, mergeSelection(EMPTY_SELECTION, { roofs: [a] }));
    expect(one.pitchDeg).toEqual({ value: 20, mixed: false });
  });

  it("Öffnungen: abweichende Breite → gemischt, gleiche Höhe → Wert", () => {
    const [a, b] = p.openings!.slice(0, 2).map((o) => o.id);
    const q = { ...p, openings: p.openings!.map((o) => (o.id === a ? { ...o, width: 1, height: 2, sillHeight: 0.9 } : o.id === b ? { ...o, width: 1.5, height: 2, sillHeight: 0.9 } : o)) };
    const v = selectionOpeningValues(q, mergeSelection(EMPTY_SELECTION, { openings: [a, b] }));
    expect(v.width.mixed).toBe(true);
    expect(v.height).toEqual({ value: 2, mixed: false });
    expect(v.sillHeight).toEqual({ value: 0.9, mixed: false });
  });

  it("Wand-Höhen: abweichende Unterkante → gemischt", () => {
    const [a, b] = p.walls.slice(0, 2).map((w) => w.id);
    const q = { ...p, walls: p.walls.map((w) => (w.id === b ? { ...w, bottom: { mode: "custom" as const, z: 0.37 } } : w)) };
    const v = selectionWallHeights(q, mergeSelection(EMPTY_SELECTION, { walls: [a, b] }));
    expect(v.bottom.mixed).toBe(true);
  });
});
