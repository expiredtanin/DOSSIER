import { describe, it, expect } from "vitest";
import type { LayerCategory, Project } from "../model/types";
import { categoryNames, isolateCategories, selectionCategoryCodes, setCategoriesVisible } from "./selectionLayers";

const cat = (code: string, name: string, visible = true, children?: LayerCategory[]): LayerCategory => ({
  code, name, color: "#000", lw: 0.2, visible, locked: false, children,
});
const layers = [cat("20", "Wände"), cat("05", "Import", true, [cat("100", "01421"), cat("101", "01847")])];
const project = {
  layers,
  walls: [{ id: "w1", categoryCode: "20" }],
  drawings2d: [{ id: "d1", categoryCode: "100" }, { id: "d2", categoryCode: "101" }, { id: "d3", categoryCode: "100" }],
  openings: [{ id: "t1", categoryCode: "20" }],
} as unknown as Project;

describe("Ebenen der Auswahl", () => {
  it("sammelt eindeutige Kategorie-Codes über alle Objektarten", () => {
    expect(selectionCategoryCodes(project, { drawingIds: ["d1", "d3"], wallIds: ["w1"] }).sort()).toEqual(["100", "20"]);
    expect(selectionCategoryCodes(project, { openingIds: ["t1"] })).toEqual(["20"]);
    expect(selectionCategoryCodes(project, {})).toEqual([]);
    expect(selectionCategoryCodes(project, { drawingIds: ["nix"] })).toEqual([]);
  });

  it("blendet genau die Codes aus (auch verschachtelt), nichts zu tun liefert dieselbe Liste", () => {
    const next = setCategoriesVisible(layers, new Set(["100"]), false);
    expect(next[1].children![0].visible).toBe(false);
    expect(next[1].children![1].visible).toBe(true);
    expect(next[0]).toEqual(layers[0]); // Wände unverändert (Kopie aus dem Kern)
    expect(setCategoriesVisible(layers, new Set(["100"]), true)).toBe(layers); // nichts zu tun → gleiche Referenz
  });

  it("isolieren: nur die gegebenen Codes bleiben sichtbar", () => {
    const next = isolateCategories(layers, new Set(["101"]));
    expect(next[0].visible).toBe(false);
    expect(next[1].children![0].visible).toBe(false);
    expect(next[1].children![1].visible).toBe(true);
  });

  it("liefert Anzeigenamen", () => {
    expect(categoryNames(layers, ["100", "20", "999"])).toEqual(["01421", "Wände", "999"]);
  });
});
