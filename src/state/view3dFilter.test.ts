import { greyedFloorIds } from "../panels/displayMode";
import { describe, expect, it } from "vitest";
import { fromIdLists, EMPTY_SELECTION, mergeSelection } from "./selection";
import {
  NO_VIEW3D_FILTER,
  getView3dFilter,
  hideSelection3d,
  isSelectionMode,
  resetView3dFilter,
  selectionIds3d,
  setView3dFilter,
  showSelection3d,
  classDisplay3d,
  toFilter3d,
} from "./view3dFilter";

describe("3D-Element-Filter [185]", () => {
  it("selectionIds3d: nur Arten, die im 3D vorkommen, ohne Doppel", () => {
    const sel = mergeSelection(EMPTY_SELECTION, {
      ...fromIdLists({ wallIds: ["w1", "w2"], openingIds: ["o1"] }),
      rooms: ["r1"],
      sectionLines: ["s1"],
      groups: ["g1"],
      drawings: ["w1"],
    });
    expect(selectionIds3d(sel)).toEqual(["w1", "w2", "o1"]);
  });

  it("Cmd+3 mit Auswahl: nur diese, Ausgeblendetes vergessen, Kamera bleibt; ohne Auswahl: alles", () => {
    const a = showSelection3d(["w1", "w1", "o1"]);
    expect(a).toMatchObject({ only: ["w1", "o1"], hidden: [] });
    expect(isSelectionMode(a)).toBe(true);
    const b = showSelection3d([]);
    expect(b).toMatchObject({ only: null, hidden: [] });
    expect(isSelectionMode(b)).toBe(false);
  });

  it("Cmd+4: blendet zusätzlich aus, im Auswahl-Modus auch; ohne ids unverändert", () => {
    const a = hideSelection3d(NO_VIEW3D_FILTER, ["w1"]);
    expect(a).toMatchObject({ only: null, hidden: ["w1"], });
    expect(hideSelection3d(a, ["w1"])).toBe(a);
    expect(hideSelection3d(a, [])).toBe(a);
    const b = hideSelection3d(showSelection3d(["w2", "w3"]), ["w3"]);
    expect(b).toMatchObject({ only: ["w2", "w3"], hidden: ["w3"] });
  });

  it("toFilter3d: Klassen plus Element-Auswahl für den Kern", () => {
    expect(toFilter3d(NO_VIEW3D_FILTER, ["31"])).toEqual({ hide: ["31"], only: null, hideIds: [], hideFloors: [] });
    expect(toFilter3d(showSelection3d(["w1"]), [])).toEqual({ hide: [], only: ["w1"], hideIds: [], hideFloors: [] });
  });

  it("[180] classDisplay3d: Darstellungsmodus je Klasse als Code-Listen (aus, grau, gesperrt)", () => {
    const modes: Record<string, { render: boolean; greyed: boolean; locked: boolean }> = {
      "20": { render: true, greyed: false, locked: false },
      "25": { render: true, greyed: true, locked: false },
      "31": { render: true, greyed: true, locked: true },
      "40": { render: false, greyed: false, locked: false },
      "41": { render: true, greyed: false, locked: true },
    };
    expect(classDisplay3d(Object.keys(modes), (c) => modes[c]!)).toEqual({ hide: ["40"], grey: ["25", "31"], lock: ["31", "41"] });
  });

  it("[180] toFilter3d: graue und gesperrte Klassen gehen mit", () => {
    expect(toFilter3d(NO_VIEW3D_FILTER, ["40"], [], { grey: ["25"], lock: ["31"] })).toEqual({
      hide: ["40"], only: null, hideIds: [], hideFloors: [], grey: ["25"], lock: ["31"],
    });
  });

  it("[180] toFilter3d: graue Geschosse gehen mit; greyedFloorIds wählt Geschosse im Modus grau", () => {
    expect(toFilter3d(NO_VIEW3D_FILTER, [], [], { greyFloors: ["og"] })).toEqual({ hide: [], only: null, hideIds: [], hideFloors: [], greyFloors: ["og"] });
    const levels = [{ id: "eg", kind: "floor" }, { id: "og", kind: "floor" }, { id: "dg", kind: "floor" }, { id: "s", kind: "section" }];
    const modes: Record<string, { render: boolean; greyed: boolean }> = {
      eg: { render: true, greyed: false }, og: { render: true, greyed: true }, dg: { render: false, greyed: true }, s: { render: true, greyed: true },
    };
    // Nur gezeichnete, graue Geschosse (Auge aus geht vor grau); Schnitt-/Ansichts-Ebenen zählen nicht.
    expect(greyedFloorIds(levels, (id) => modes[id]!)).toEqual(["og"]);
  });

  it("Store: setzen und beim Projektwechsel zurücksetzen", () => {
    setView3dFilter(showSelection3d(["w1"]));
    expect(isSelectionMode(getView3dFilter())).toBe(true);
    resetView3dFilter();
    expect(getView3dFilter()).toBe(NO_VIEW3D_FILTER);
  });
});
